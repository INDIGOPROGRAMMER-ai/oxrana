import { PII_PAYLOAD_KEYS } from '@oxrana/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventListener } from '../../src/realtime/listener';
import { KEYS, roleActor, seedDemo, startTestApp, type TestApp } from '../support/harness';
import {
  action,
  categoryKey,
  dnsTruck,
  fillVisits,
  gateKey,
  kpp1,
  kpp2,
  quotaKey,
  resetTenant,
  tenantKey,
} from './gate-helpers';

/**
 * Сценарий 3 на уровне API (ADR-004): outbox → LISTEN/NOTIFY → SSE. Настоящий HTTP-сервер и
 * слушатель базы; события доходят до подписчиков объекта, фильтруются по правам, без ПДн, с
 * дочитыванием по Last-Event-ID.
 */
interface SseEvent {
  id: number;
  type: string;
  data: { type: string; payload: Record<string, unknown> };
  raw: string;
}

interface Subscription {
  readonly events: SseEvent[];
  next(predicate: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
}

let t: TestApp;
let listener: EventListener;
let base = '';
const dns = tenantKey('dns');

async function subscribe(path: string, headers: Record<string, string>): Promise<Subscription> {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('нет потока');
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  const waiters: { predicate: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const fields = Object.fromEntries(
            chunk
              .split('\n')
              .filter((line) => !line.startsWith(':') && line.includes(': '))
              .map((line) => [
                line.slice(0, line.indexOf(': ')),
                line.slice(line.indexOf(': ') + 2),
              ]),
          );
          if (!fields.data || !fields.id) continue;
          const event: SseEvent = {
            id: Number(fields.id),
            type: fields.event ?? '',
            data: JSON.parse(fields.data),
            raw: fields.data,
          };
          events.push(event);
          for (const w of [...waiters]) {
            if (w.predicate(event)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(event);
            }
          }
        }
      }
    } catch {
      // поток закрыт
    }
  })();
  return {
    events,
    next(predicate, timeoutMs = 3_000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`событие не пришло за ${timeoutMs} мс`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close: () => controller.abort(),
  };
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  listener = new EventListener({
    connectionString: process.env.DATABASE_URL ?? '',
    db: t.db,
    hub: t.hub,
    ruleSets: t.app.deps.ruleSets,
  });
  await listener.start();
  base = await t.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await listener.stop();
  await t.close();
});
beforeEach(async () => {
  await resetTenant(dns);
});

/** Подписка уже получает события: ждём heartbeat-подтверждения через первое событие теста. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('сценарий 3: фура выехала — жёлтая карточка на КПП-2 становится зелёной без F5', () => {
  it('сценарий 3: пост получает quota.changed и сигнал очереди без F5, повторная проверка — зелёная', async () => {
    await fillVisits(dns, categoryKey('semi'), 24);
    const leaving = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId: leaving });
    const waitingPass = await dnsTruck(t);
    const wait = await action(t, kpp2, { type: 'check_in', passId: waitingPass });
    expect(wait.json().code).toBe('wait');

    const post2 = await subscribe('/gate/events', await t.headersFor(kpp2));
    const post1 = await subscribe('/gate/events', await t.headersFor(kpp1));
    const dnsUser = await subscribe(
      `/sites/${KEYS.siteId}/events`,
      await t.headersFor(roleActor('tenant_viewer', { tenantIds: [dns] })),
    );
    const x5User = await subscribe(
      `/sites/${KEYS.siteId}/events`,
      await t.headersFor(roleActor('tenant_viewer', { tenantIds: [tenantKey('x5')] })),
    );
    await settle();
    try {
      await action(t, kpp1, { type: 'check_out', passId: leaving });

      const quota = await post2.next((e) => e.type === 'quota.changed');
      expect(quota.data.payload).toEqual({
        quotaId: quotaKey('dns/trucks'),
        tenantId: dns,
        occupied: 24,
        capacity: 25,
      });
      const freed = await post2.next((e) => e.type === 'queue.slot_freed');
      expect(freed.data.payload).toMatchObject({ passId: waitingPass, gateId: gateKey('kpp2') });

      const recheck = await t.as(kpp2, {
        method: 'POST',
        url: '/gate/check',
        payload: { direction: 'in', passId: waitingPass },
      });
      expect(recheck.json().verdict).toMatchObject({
        code: 'allow',
        color: 'green',
        headline: 'Грузовые 24/25',
      });

      // Арендатор видит свои события, чужой — нет; сигнал очереди — только посту первой машины.
      await dnsUser.next((e) => e.type === 'visit.closed');
      await post1.next((e) => e.type === 'visit.closed');
      await settle();
      expect(x5User.events.filter((e) => e.data.payload.tenantId === dns)).toEqual([]);
      expect(post1.events.filter((e) => e.type === 'queue.slot_freed')).toEqual([]);
      expect(dnsUser.events.filter((e) => e.type === 'queue.slot_freed')).toEqual([]);

      // В payload нет ПДн: ни полей с ПДн, ни номера машины где-либо в событии.
      const plate = (await t.as(kpp2, { url: `/passes/${leaving}` })).json().plateNorm as string;
      for (const event of post2.events) {
        expect(Object.keys(event.data.payload).filter((k) => PII_PAYLOAD_KEYS.has(k))).toEqual([]);
        expect(event.raw).not.toContain(plate);
      }
    } finally {
      for (const s of [post1, post2, dnsUser, x5User]) s.close();
    }
  });

  it('переподключение с Last-Event-ID — пропущенные события дочитываются из таблицы', async () => {
    const first = await subscribe('/gate/events', await t.headersFor(kpp2));
    await settle();
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    const opened = await first.next((e) => e.type === 'visit.opened');
    first.close();
    // пока поста нет — выезд
    await action(t, kpp1, { type: 'check_out', passId });
    const again = await subscribe('/gate/events', {
      ...(await t.headersFor(kpp2)),
      'last-event-id': String(opened.id),
    });
    try {
      const closed = await again.next((e) => e.type === 'visit.closed');
      expect(closed.id).toBeGreaterThan(opened.id);
      expect(again.events.every((e) => e.id > opened.id)).toBe(true);
    } finally {
      again.close();
    }
  });

  it('без права на события объекта — 403; без входа — 401', async () => {
    const accountant = await fetch(`${base}/sites/${KEYS.siteId}/events`, {
      headers: await t.headersFor(roleActor('accountant')),
    });
    expect(accountant.status).toBe(403);
    const anonymous = await fetch(`${base}/gate/events`);
    expect(anonymous.status).toBe(401);
  });
});

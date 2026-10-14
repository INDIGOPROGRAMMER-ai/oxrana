import { PII_PAYLOAD_KEYS } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actorFromGrants } from '../../src/actor';
import { visibleTo } from '../../src/realtime/routes';
import {
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
} from '../support/harness';
import { at, categoryKey, tenantKey } from './gate-helpers';

/**
 * Уведомления кабинета (этап 7b, ADR-023): одобрено · одобрено с изменениями · отклонено →
 * колокольчик у того, кто заказал пропуск. Строятся на событиях outbox; в самих событиях текста
 * и ПДн нет; чужие уведомления не видны никому.
 */
let t: TestApp;
const dns = tenantKey('dns');
const car = categoryKey('car');
const admin = roleActor('site_admin');
const approver = roleActor('approver');
const logist = roleActor('tenant_manager', { tenantIds: [dns] });
const requester = roleActor('tenant_requester', { tenantIds: [dns] });

let counter = 900;
const nextPlate = () => `Т${++counter}НК174`;

const multi = (extra: Record<string, unknown> = {}) => ({
  tenantId: dns,
  passType: 'multi',
  participant: 'vehicle',
  plate: nextPlate(),
  categoryId: car,
  validFrom: at('13:00'),
  validTo: '2026-03-15T15:00:00.000Z',
  comment: 'Инвентаризация склада',
  ...extra,
});
const create = async (actor: typeof logist, payload: Record<string, unknown>) => {
  const res = await t.as(actor, { method: 'POST', url: '/passes', payload });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const bell = async (actor: typeof logist, query = '') =>
  (await t.as(actor, { url: `/notifications${query}` })).json();

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  for (const person of [logist, requester]) await t.headersFor(person);
});
beforeEach(() => t.clock.set(NOON));
afterAll(() => t.close());

describe('колокольчик', () => {
  it('одобрение: уведомление у заказавшего, счётчик, «прочитано»; у других его нет', async () => {
    const pass = await create(logist, multi());
    expect(pass.status).toBe('pending_approval');
    expect((await bell(logist)).unreadCount).toBe(0);

    const approve = await t.as(approver, {
      method: 'POST',
      url: `/passes/${pass.id}/approve`,
      payload: { note: 'Хорошо' },
    });
    expect(approve.statusCode, approve.body).toBe(200);

    const mine = await bell(logist);
    expect(mine.unreadCount).toBe(1);
    expect(mine.items[0]).toMatchObject({
      kind: 'pass_approved',
      title: 'Пропуск одобрен',
      passId: pass.id,
      tenantId: dns,
      readAt: null,
      changes: null,
    });
    expect(mine.items[0].text).toContain(pass.plateNorm);
    expect(mine.items[0].text).toContain('Хорошо');
    // коллега заказчик и согласующий чужих уведомлений не видят
    expect((await bell(requester)).items).toEqual([]);
    expect((await bell(approver)).items).toEqual([]);

    const read = await t.as(logist, {
      method: 'POST',
      url: '/notifications/read',
      payload: { ids: [mine.items[0].id] },
    });
    expect(read.json()).toEqual({ unreadCount: 0 });
    expect((await bell(logist, '?unread=true')).items).toEqual([]);
    expect((await bell(logist)).items[0].readAt).not.toBeNull();
  });

  it('одобрено с изменениями: что изменено — «было → стало» с названиями', async () => {
    const pass = await create(logist, multi());
    await t.as(approver, {
      method: 'POST',
      url: `/passes/${pass.id}/approve`,
      payload: { note: 'Хватит до 13-го', changes: { validTo: '2026-03-13T15:00:00.000Z' } },
    });
    const [item] = (await bell(logist)).items;
    expect(item).toMatchObject({
      kind: 'pass_approved_changed',
      title: 'Пропуск одобрен с изменениями',
    });
    expect(item.changes.validTo).toMatchObject({
      from: '2026-03-15T15:00:00.000Z',
      to: '2026-03-13T15:00:00.000Z',
    });
    expect(item.text).toContain('Действует до');
    expect(item.text).toContain('Хватит до 13-го');
  });

  it('отклонено: причина в уведомлении; «отметить все» обнуляет счётчик', async () => {
    const pass = await create(logist, multi());
    await t.as(approver, {
      method: 'POST',
      url: `/passes/${pass.id}/reject`,
      payload: { note: 'Нет места на стоянке' },
    });
    const bellNow = await bell(logist);
    expect(bellNow.items[0]).toMatchObject({ kind: 'pass_rejected', title: 'Пропуск отклонён' });
    expect(bellNow.items[0].text).toContain('Нет места на стоянке');
    expect(bellNow.unreadCount).toBeGreaterThan(0);
    const all = await t.as(logist, {
      method: 'POST',
      url: '/notifications/read',
      payload: { all: true },
    });
    expect(all.json()).toEqual({ unreadCount: 0 });
    const empty = await t.as(logist, { method: 'POST', url: '/notifications/read', payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('свои действия не уведомляют: администратор одобряет пропуск, который создал сам', async () => {
    const before = (await bell(admin)).items.length;
    const pass = await create(admin, multi());
    if (pass.status === 'pending_approval') {
      await t.as(admin, { method: 'POST', url: `/passes/${pass.id}/approve`, payload: {} });
    }
    expect((await bell(admin)).items).toHaveLength(before);
  });

  it('заявка на изменение рассмотрена — уведомление тому, кто её подал', async () => {
    const pass = await create(admin, multi({ validFrom: NOON }));
    t.clock.advance(3_600_000);
    const req = await t.as(logist, {
      method: 'PATCH',
      url: `/passes/${pass.id}`,
      payload: { plate: nextPlate(), reason: 'Заменили машину' },
    });
    const requestId = req.json().changeRequest.id;
    await t.as(approver, {
      method: 'POST',
      url: `/change-requests/${requestId}/reject`,
      payload: { note: 'Нужен новый договор' },
    });
    const [item] = (await bell(logist)).items;
    expect(item).toMatchObject({ kind: 'change_request_rejected' });
    expect(item.text).toContain('Нужен новый договор');
  });

  it('событие outbox без текста и ПДн, адресное: видит только получатель', async () => {
    const pass = await create(logist, multi());
    await t.as(approver, { method: 'POST', url: `/passes/${pass.id}/approve`, payload: {} });
    const events = await ownerDb()
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.type, 'notification.created'));
    expect(events.length).toBeGreaterThan(0);
    const payload = events.at(-1)?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['kind', 'notificationId', 'userId']);
    for (const key of Object.keys(payload)) expect(PII_PAYLOAD_KEYS.has(key)).toBe(false);

    const grants = (permissions: string[]) => [
      { permissions: new Set(permissions), siteId: KEYS.siteId, tenantId: dns },
    ];
    const recipient = actorFromGrants({
      id: logist.id,
      kind: 'user',
      organizationId: KEYS.organizationId,
      grants: grants(['pass.view']),
    });
    const colleague = actorFromGrants({
      id: requester.id,
      kind: 'user',
      organizationId: KEYS.organizationId,
      grants: grants(['pass.view']),
    });
    const staff = actorFromGrants({
      id: approver.id,
      kind: 'user',
      organizationId: KEYS.organizationId,
      grants: [
        { permissions: new Set(['pass.view_all_tenants']), siteId: KEYS.siteId, tenantId: null },
      ],
    });
    const event = { type: 'notification.created', payload: { ...payload, tenantId: dns } };
    expect(
      visibleTo(recipient, { type: event.type, payload: { ...payload, userId: logist.id } }),
    ).toBe(true);
    expect(
      visibleTo(colleague, { type: event.type, payload: { ...payload, userId: logist.id } }),
    ).toBe(false);
    expect(visibleTo(staff, { type: event.type, payload: { ...payload, userId: logist.id } })).toBe(
      false,
    );
  });
});

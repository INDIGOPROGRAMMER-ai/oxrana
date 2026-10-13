import { randomUUID } from 'node:crypto';
import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  customActor,
  gateActor,
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
} from '../support/harness';
import {
  action,
  admin,
  at,
  categoryKey,
  dnsTruck,
  dockKey,
  fillVisits,
  gateKey,
  kpp1,
  kpp2,
  office,
  quotaKey,
  resetTenant,
  tenantKey,
  uniquePlate,
} from './gate-helpers';

/**
 * Пост охраны на демо-объекте (сценарии 15, 16, 17, 21, 29, 40, идемпотентность действий поста,
 * внутренний пост). Часы стоят на вторнике 10.03.2026 12:00 по объекту; между тестами открытые
 * визиты и очередь ДНС сбрасываются.
 */
let t: TestApp;
const dns = tenantKey('dns');
const semi = categoryKey('semi');
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

async function occupancy(quota: string): Promise<number> {
  const res = await t.as(admin, { url: `/sites/${KEYS.siteId}/occupancy` });
  return res.json().quotas.find((q: { quotaId: string }) => q.quotaId === quota).occupied;
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  t.clock.set(NOON);
  await resetTenant(dns);
});

describe('въезд и выезд', () => {
  it('сценарий 1: при 24/25 фура впускается, после въезда счётчик 25/25', async () => {
    await fillVisits(dns, semi, 24);
    const passId = await dnsTruck(t);
    const check = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    expect(check.json().verdict).toMatchObject({ code: 'allow', headline: 'Грузовые 24/25' });
    const res = await action(t, kpp2, { type: 'check_in', passId });
    expect(res.json()).toMatchObject({ outcome: 'applied', code: 'allow' });
    expect(res.json().message).toBe('Въезд отмечен 12:00 (Челябинск, UTC+5)');
    expect(await occupancy(quotaKey('dns/trucks'))).toBe(25);
  });

  it('сценарий 2: при 25/25 «Впустить» не открывает визит — «ждите», машина встаёт в очередь', async () => {
    await fillVisits(dns, semi, 25);
    const passId = await dnsTruck(t);
    const res = await action(t, kpp2, { type: 'check_in', passId });
    expect(res.json()).toMatchObject({ outcome: 'rejected', code: 'wait', visitId: null });
    expect(res.json().verdict.headline).toMatch(/25\/25/);
    const queue = await t.as(kpp2, { url: '/gate/queue' });
    expect(queue.json().items).toEqual([
      expect.objectContaining({ passId, gateId: gateKey('kpp2'), position: 1 }),
    ]);
  });

  it('повтор действия с тем же id не создаёт второй визит; тот же id с другими данными — ошибка', async () => {
    const passId = await dnsTruck(t);
    const id = randomUUID();
    const first = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions',
      payload: { id, type: 'check_in', passId },
    });
    const again = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions',
      payload: { id, type: 'check_in', passId },
    });
    expect(first.json()).toMatchObject({ outcome: 'applied', replayed: false });
    expect(again.json()).toMatchObject({
      outcome: 'applied',
      replayed: true,
      visitId: first.json().visitId,
    });
    const visits = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.passId, passId));
    expect(visits).toHaveLength(1);
    const other = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions',
      payload: { id, type: 'check_in', passId: await dnsTruck(t) },
    });
    expect(other.statusCode).toBe(409);
    expect(error(other).code).toBe('idempotency_conflict');
  });

  it('повторный «Впустить» той же машине, уже на территории, второй визит не открывает', async () => {
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    const second = await action(t, kpp2, { type: 'check_in', passId });
    expect(second.json()).toMatchObject({ outcome: 'merged', code: 'already_open' });
  });

  it('разовый после выезда — «использован», повторный въезд — отказ (сценарий 25)', async () => {
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    const out = await action(t, kpp1, { type: 'check_out', passId });
    expect(out.json()).toMatchObject({ outcome: 'applied' });
    expect((await t.as(admin, { url: `/passes/${passId}` })).json().status).toBe('used');
    const again = await action(t, kpp2, { type: 'check_in', passId });
    expect(again.json()).toMatchObject({ outcome: 'rejected', code: 'deny' });
  });

  it('сценарий 16: выезд без отметки въезда — «выпустить с отметкой» с причиной; лимит не уходит в минус', async () => {
    const passId = await dnsTruck(t);
    const before = await occupancy(quotaKey('dns/trucks'));
    const check = await t.as(kpp1, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'out', passId },
    });
    expect(check.json().verdict.primaryAction).toBe('check_out_flagged');
    const noReason = await action(t, kpp1, { type: 'check_out', passId });
    expect(error(noReason)).toMatchObject({ code: 'reason_required', field: 'reason' });
    const res = await action(t, kpp1, {
      type: 'check_out',
      passId,
      reason: 'Въехал при смене охраны, отметки нет',
    });
    expect(res.json()).toMatchObject({ outcome: 'applied', code: 'no_checkin' });
    const [visit] = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.passId, passId));
    expect(visit).toMatchObject({ timeIn: null, flags: ['no_checkin'] });
    expect(visit?.timeOut).not.toBeNull();
    expect(await occupancy(quotaKey('dns/trucks'))).toBe(before);
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityId, visit?.id ?? ''),
          eq(schema.auditLog.action, 'check_out_flagged'),
        ),
      );
    expect(audit?.reason).toBe('Въехал при смене охраны, отметки нет');
  });

  it('двойной выезд с двух КПП: второй сливается, визит закрыт один раз', async () => {
    const passId = await dnsTruck(t);
    const inRes = await action(t, kpp2, { type: 'check_in', passId });
    const visitId = inRes.json().visitId;
    const a = await action(t, kpp1, { type: 'check_out', visitId });
    const b = await action(t, kpp2, { type: 'check_out', visitId });
    expect(a.json().outcome).toBe('applied');
    expect(b.json()).toMatchObject({ outcome: 'merged', code: 'already_closed' });
  });
});

describe('сценарий 17: «Отменить» в течение 2 минут', () => {
  it('сценарий 17: отмена въезда в течение 2 минут возвращает занятость; в журнале КПП оба события', async () => {
    const passId = await dnsTruck(t);
    const before = await occupancy(quotaKey('dns/trucks'));
    const checkIn = await action(t, kpp2, { type: 'check_in', passId });
    expect(await occupancy(quotaKey('dns/trucks'))).toBe(before + 1);
    t.clock.advance(90_000);
    const undo = await action(t, kpp2, {
      type: 'undo',
      actionId: checkIn.json().actionId,
      reason: 'Не та машина',
    });
    expect(undo.json()).toMatchObject({ outcome: 'applied', code: 'undone' });
    expect(await occupancy(quotaKey('dns/trucks'))).toBe(before);
    const decisions = await ownerDb()
      .select({ action: schema.gateDecisions.action })
      .from(schema.gateDecisions)
      .where(eq(schema.gateDecisions.visitId, checkIn.json().visitId))
      .orderBy(asc(schema.gateDecisions.id));
    expect(decisions.map((d) => d.action)).toEqual(['check_in', 'undo']);
    const [visit] = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.id, checkIn.json().visitId));
    expect(visit?.flags).toContain('undone');
    const twice = await action(t, kpp2, { type: 'undo', actionId: checkIn.json().actionId });
    expect(error(twice).code).toBe('nothing_to_undo');
  });

  it('сценарий 17: после 2 минут отмена не проходит — исправляет администратор', async () => {
    const passId = await dnsTruck(t);
    const checkIn = await action(t, kpp2, { type: 'check_in', passId });
    t.clock.advance(121_000);
    const undo = await action(t, kpp2, { type: 'undo', actionId: checkIn.json().actionId });
    expect(undo.statusCode).toBe(409);
    expect(error(undo).code).toBe('undo_window_passed');
  });

  it('отмена выезда снова открывает визит и возвращает разовый в «действует»', async () => {
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    const out = await action(t, kpp1, { type: 'check_out', passId });
    const undo = await action(t, kpp1, { type: 'undo', actionId: out.json().actionId });
    expect(undo.json().outcome).toBe('applied');
    expect((await t.as(admin, { url: `/passes/${passId}` })).json().status).toBe('approved');
    const [visit] = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.passId, passId));
    expect(visit?.timeOut).toBeNull();
  });

  it('отменить чужое действие (другого поста) нельзя', async () => {
    const passId = await dnsTruck(t);
    const checkIn = await action(t, kpp2, { type: 'check_in', passId });
    const undo = await action(t, kpp1, { type: 'undo', actionId: checkIn.json().actionId });
    expect(error(undo).code).toBe('nothing_to_undo');
  });
});

describe('сценарий 15: машина без пропуска → запрос → «Оформить» → зелёный', () => {
  it('номер из чёрного списка без пропуска: пост видит красное, а запрос арендатору не уходит (этап 7a)', async () => {
    const plate = uniquePlate();
    const listed = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/blacklist`,
      payload: { level: 'site', plate, reason: 'Угроза охране' },
    });
    expect(listed.statusCode, listed.body).toBe(201);
    const check = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', plateQuery: plate },
    });
    expect(check.json().verdict).toMatchObject({ code: 'deny', color: 'red' });
    expect(check.json().verdict.headline).toBe('В чёрном списке: Угроза охране');
    const request = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/requests',
      payload: { participant: 'vehicle', plate, categoryId: semi, tenantId: dns },
    });
    expect(request.statusCode).toBe(403);
    expect(error(request).field).toBe('plate');
    expect(error(request).message).toContain('Угроза охране');
    await t.as(admin, { method: 'DELETE', url: `/blacklist/${listed.json().id}` });
  });

  it('сценарий 15: машина без пропуска — пост спрашивает арендатора, тот оформляет — на посту зелёная карточка', async () => {
    const plate = uniquePlate();
    const before = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', plateQuery: plate },
    });
    expect(before.json().verdict).toMatchObject({ code: 'no_pass' });

    const created = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/requests',
      payload: { participant: 'vehicle', plate, categoryId: semi, tenantId: dns },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'open', expiresAt: '2026-03-10T07:10:00.000Z' });

    const logist = roleActor('tenant_manager', { tenantIds: [dns] });
    const inbox = await t.as(logist, { url: `/sites/${KEYS.siteId}/gate-requests?status=open` });
    expect(inbox.json().items.map((r: { id: string }) => r.id)).toContain(created.json().id);
    const foreign = await t.as(roleActor('tenant_manager', { tenantIds: [tenantKey('x5')] }), {
      url: `/sites/${KEYS.siteId}/gate-requests?status=open`,
    });
    expect(foreign.json().items).toEqual([]);

    const selfApprove = await t.as(kpp2, {
      method: 'POST',
      url: `/gate-requests/${created.json().id}/approve`,
      payload: { dockId: dockKey('12') },
    });
    expect(selfApprove.statusCode).toBe(403);

    const approved = await t.as(logist, {
      method: 'POST',
      url: `/gate-requests/${created.json().id}/approve`,
      payload: { dockId: dockKey('12') },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().request.status).toBe('approved');
    expect(approved.json().pass).toMatchObject({ status: 'approved', passType: 'single' });

    const after = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', plateQuery: plate },
    });
    expect(after.json().verdict).toMatchObject({ code: 'allow', color: 'green' });
    const [event] = await ownerDb()
      .select()
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.aggregateId, created.json().id),
          eq(schema.domainEvents.type, 'gate_request.answered'),
        ),
      );
    expect(event?.payload).toMatchObject({ status: 'approved', passId: approved.json().pass.id });
  });

  it('ответ после срока — «запрос закрыт»', async () => {
    const created = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/requests',
      payload: { participant: 'vehicle', plate: uniquePlate(), tenantId: dns },
    });
    t.clock.advance(11 * 60_000);
    const res = await t.as(roleActor('tenant_manager', { tenantIds: [dns] }), {
      method: 'POST',
      url: `/gate-requests/${created.json().id}/approve`,
      payload: { categoryId: semi, dockId: dockKey('12') },
    });
    expect(error(res).code).toBe('gate_request_closed');
  });
});

describe('сценарий 21: переименование арендатора не меняет прошлые визиты', () => {
  it('сценарий 21: после переименования «ООО Ромашка» → «ООО Лютик» визит хранит название на момент въезда', async () => {
    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/tenants`,
      payload: { legalName: 'ООО Ромашка', shortName: 'ООО Ромашка' },
    });
    const romashka = created.json().id;
    const pass = await t.as(admin, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: romashka,
        passType: 'single',
        participant: 'vehicle',
        plate: uniquePlate(),
        categoryId: categoryKey('car'),
        validFrom: at('12:00'),
        validTo: at('18:00'),
      },
    });
    await action(t, kpp1, { type: 'check_in', passId: pass.json().id });
    await t.as(admin, {
      method: 'PATCH',
      url: `/tenants/${romashka}`,
      payload: { shortName: 'ООО Лютик' },
    });
    const visits = await t.as(admin, { url: `/sites/${KEYS.siteId}/visits?tenantId=${romashka}` });
    expect(visits.json().items[0].snapshot).toMatchObject({
      tenant: 'ООО Ромашка',
      gate: 'КПП-1',
      category: 'легковой',
    });
    const check = await t.as(kpp1, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'out', passId: pass.json().id },
    });
    expect(check.json().verdict.code).toBe('allow');
    const decisions = await t.as(admin, {
      url: `/sites/${KEYS.siteId}/gate-decisions?passId=${pass.json().id}`,
    });
    expect(decisions.json().items.at(-1).snapshot.tenant).toBe('ООО Ромашка');
  });
});

describe('сценарий 40: очередь у ворот — сигнал только по первой', () => {
  it('сценарий 40: три фуры ждут при 25/25, одна выезжает — сигнал только первой и только её посту', async () => {
    await fillVisits(dns, semi, 24);
    const leaving = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId: leaving });
    const waiting: string[] = [];
    for (const actor of [kpp2, kpp1, kpp2]) {
      const passId = await dnsTruck(t, {
        categoryId: actor === kpp1 ? categoryKey('light_truck') : semi,
      });
      t.clock.advance(1_000);
      const res = await action(t, actor, { type: 'check_in', passId });
      expect(res.json().code).toBe('wait');
      waiting.push(passId);
    }
    const queue = (await t.as(admin, { url: `/sites/${KEYS.siteId}/queue` })).json().items;
    expect(queue.map((q: { passId: string }) => q.passId)).toEqual(waiting);
    expect(queue.map((q: { position: number }) => q.position)).toEqual([1, 2, 3]);

    const before = (
      await ownerDb().select({ id: schema.domainEvents.id }).from(schema.domainEvents)
    ).length;
    await action(t, kpp1, { type: 'check_out', passId: leaving });
    const events = (
      await ownerDb().select().from(schema.domainEvents).orderBy(asc(schema.domainEvents.id))
    ).slice(before);
    const freed = events.filter((e) => e.type === 'queue.slot_freed');
    expect(freed).toHaveLength(1);
    expect(freed[0]?.payload).toMatchObject({ passId: waiting[0], gateId: gateKey('kpp2') });

    // Первая въехала — следующее освобождение достанется второй.
    const entered = await action(t, kpp2, { type: 'check_in', passId: waiting[0] });
    expect(entered.json().outcome).toBe('applied');
    const after = (await t.as(admin, { url: `/sites/${KEYS.siteId}/queue` })).json().items;
    expect(after.map((q: { passId: string; position: number }) => [q.passId, q.position])).toEqual([
      [waiting[1], 1],
      [waiting[2], 2],
    ]);
  });
});

describe('сценарий 29 (сервер): синхронизация офлайн-очереди поста', () => {
  it('сценарий 29: 30 минут без связи, 5 въездов — после связи 5 визитов, занятость пересчитана, сверх лимита — с флагом', async () => {
    await fillVisits(dns, semi, 21);
    const passes: string[] = [];
    for (let i = 0; i < 5; i++) passes.push(await dnsTruck(t));
    t.clock.set(at('12:30'));
    const actions = passes.map((passId, i) => ({
      seq: i + 1,
      action: { id: randomUUID(), type: 'check_in', passId, clientAt: at(`12:0${i}`) },
      localVerdict: { code: 'allow', headline: 'Грузовые по кэшу' },
    }));
    const res = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions/sync',
      payload: { actions: [...actions].reverse() },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.map((r: { outcome: string }) => r.outcome)).toEqual(Array(5).fill('applied'));
    expect(await occupancy(quotaKey('dns/trucks'))).toBe(26);
    const visits = await ownerDb()
      .select()
      .from(schema.visits)
      .where(and(eq(schema.visits.tenantId, dns), eq(schema.visits.methodIn, 'sync')));
    expect(visits).toHaveLength(5);
    const over = visits.filter((v) => v.flags.includes('offline_over_quota'));
    expect(over).toHaveLength(1);
    expect(over[0]?.timeIn?.toISOString()).toBe(at('12:04'));
    // Повтор синхронизации (связь оборвалась на ответе) ничего не дублирует.
    const again = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions/sync',
      payload: { actions },
    });
    expect(again.json().results.every((r: { replayed: boolean }) => r.replayed)).toBe(true);
    // Офлайн-решения в журнале КПП: и что показал пост, и что решил сервер.
    const offline = await ownerDb()
      .select()
      .from(schema.gateDecisions)
      .where(
        and(
          eq(schema.gateDecisions.offline, true),
          eq(schema.gateDecisions.passId, passes[0] ?? ''),
        ),
      );
    expect(offline.map((d) => d.action).sort()).toEqual(['check_in', 'none']);
  });

  it('выезд офлайн без отметки въезда и повтор выезда другим КПП', async () => {
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    const res = await t.as(kpp1, {
      method: 'POST',
      url: '/gate/actions/sync',
      payload: {
        actions: [
          {
            seq: 1,
            action: { id: randomUUID(), type: 'check_out', passId, clientAt: at('12:00') },
          },
          {
            seq: 2,
            action: { id: randomUUID(), type: 'check_out', passId, clientAt: at('12:00') },
          },
          {
            seq: 3,
            action: {
              id: randomUUID(),
              type: 'check_out',
              passId: await dnsTruck(t),
              clientAt: at('12:00'),
            },
          },
        ],
      },
    });
    expect(
      res.json().results.map((r: { outcome: string; code: string }) => [r.outcome, r.code]),
    ).toEqual([
      ['applied', 'allow'],
      ['rejected', 'reason_required'],
      ['rejected', 'reason_required'],
    ]);
  });
});

describe('внутренний пост и права', () => {
  it('проход внутреннего поста не открывает визит; въезд на внутреннем посту — ошибка', async () => {
    const kontinent = tenantKey('kontinent');
    const pass = await t.as(admin, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: kontinent,
        passType: 'single',
        participant: 'pedestrian',
        personName: 'Иванов Пётр',
        destinationZoneId: KEYS.zones.office,
        validFrom: at('12:00'),
        validTo: at('18:00'),
      },
    });
    const passId = pass.json().id;
    await action(t, kpp1, { type: 'check_in', passId });
    for (let i = 0; i < 3; i++) {
      const res = await action(t, office, { type: 'passage', passId });
      expect(res.json()).toMatchObject({ outcome: 'applied', code: 'allow' });
    }
    const passages = await ownerDb()
      .select()
      .from(schema.gatePassages)
      .where(eq(schema.gatePassages.passId, passId));
    expect(passages).toHaveLength(3);
    const visits = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.passId, passId));
    expect(visits).toHaveLength(1);
    const wrong = await action(t, office, { type: 'check_in', passId });
    expect(error(wrong).code).toBe('wrong_gate_kind');
  });

  it('администратор объекта не нажимает «Впустить» (A7); действие поста — только с учётки КПП', async () => {
    const passId = await dnsTruck(t);
    const res = await action(t, admin, { type: 'check_in', passId });
    expect(res.statusCode).toBe(403);
    expect(error(res).permission).toBe(
      'visit.check_in | visit.check_out | gate.refuse | gate.redirect | gate.undo | gate.passage',
    );
    const custom = await action(t, customActor(['visit.check_in']), {
      type: 'check_in',
      passId,
    });
    expect(error(custom).code).toBe('gate_device_required');
    const outOnly = await action(t, gateActor('kpp2', 'gate_post', ['visit.check_out']), {
      type: 'check_in',
      passId,
    });
    expect(error(outOnly)).toMatchObject({ code: 'forbidden', permission: 'visit.check_in' });
  });

  it('отказ и «направить» пишутся в журнал КПП', async () => {
    const passId = await dnsTruck(t, { categoryId: categoryKey('light_truck') });
    const check = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    expect(check.json().verdict.code).toBe('wrong_gate');
    const redirect = await action(t, kpp2, { type: 'redirect', direction: 'in', passId });
    expect(redirect.json()).toMatchObject({ outcome: 'applied', message: 'Направлен на КПП-1' });
    const refuse = await action(t, kpp2, {
      type: 'refuse',
      direction: 'in',
      passId,
      reason: 'Водитель отказался ехать на КПП-1',
    });
    expect(refuse.json().outcome).toBe('applied');
    const decisions = (
      await t.as(admin, { url: `/sites/${KEYS.siteId}/gate-decisions?passId=${passId}` })
    ).json().items;
    expect(decisions.map((d: { action: string }) => d.action)).toEqual([
      'refuse',
      'redirect',
      'none',
    ]);
    expect(decisions[2].trace.length).toBeGreaterThan(5);
  });
});

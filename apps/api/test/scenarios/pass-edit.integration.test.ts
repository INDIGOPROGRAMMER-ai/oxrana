import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KEYS, NOON, ownerDb, roleActor, seedDemo, startTestApp, type TestApp } from '../support/harness';
import { at, categoryKey, dockKey, gateKey, tenantKey } from './gate-helpers';

/**
 * Правка пропуска по этапам (этап 7b, ADR-023, сценарии 19, 20, 41): до въезда правится почти всё,
 * после въезда (визит открыт) — комментарий и «действует до», после выезда или использования —
 * только просмотр. Часы — вторник 10.03.2026 12:00 по объекту.
 */
let t: TestApp;
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const dns = tenantKey('dns');
const car = categoryKey('car');
const semi = categoryKey('semi');
const admin = roleActor('site_admin');
const logist = roleActor('tenant_manager', { tenantIds: [dns] });
const requester = roleActor('tenant_requester', { tenantIds: [dns] });
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let counter = 700;
const nextPlate = () => `Е${++counter}КХ174`;

const single = (extra: Record<string, unknown> = {}) => ({
  tenantId: dns,
  passType: 'single',
  participant: 'vehicle',
  plate: nextPlate(),
  categoryId: car,
  ...extra,
});
const multi = (extra: Record<string, unknown> = {}) => ({
  tenantId: dns,
  passType: 'multi',
  participant: 'vehicle',
  plate: nextPlate(),
  categoryId: car,
  validFrom: at('13:00'),
  validTo: '2026-03-14T15:00:00.000Z',
  comment: 'Служебная машина',
  ...extra,
});
const create = async (actor: typeof logist, payload: Record<string, unknown>): Promise<string> => {
  const res = await t.as(actor, { method: 'POST', url: '/passes', payload });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id;
};
const patch = (actor: typeof logist, passId: string, payload: Record<string, unknown>) =>
  t.as(actor, { method: 'PATCH', url: `/passes/${passId}`, payload });
const view = async (passId: string) => (await t.as(admin, { url: `/passes/${passId}` })).json();

/** Машина въехала: открытый визит по пропуску (данные под владельцем, минуя пост). */
async function enter(passId: string, plate: string | null, closed = false): Promise<string> {
  const [row] = await ownerDb()
    .insert(schema.visits)
    .values({
      organizationId: KEYS.organizationId,
      siteId: KEYS.siteId,
      tenantId: dns,
      passId,
      participant: 'vehicle',
      categoryId: car,
      plateNorm: plate,
      snapshot: { note: 'тестовый въезд' },
      gateInId: gateKey('kpp2'),
      timeIn: new Date(NOON),
      timeOut: closed ? new Date(Date.parse(NOON) + 600_000) : null,
      methodIn: 'button',
    })
    .returning({ id: schema.visits.id });
  return row?.id ?? '';
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  await t.headersFor(logist);
});
beforeEach(() => t.clock.set(NOON));
afterAll(() => t.close());

describe('до въезда', () => {
  it('разовый пропуск правится сам: номер, тип, время, место назначения, комментарий; в журнале «было → стало»', async () => {
    const passId = await create(logist, single());
    const zone = Object.values(KEYS.zones)[0] ?? '';
    const newPlate = nextPlate();
    const res = await patch(logist, passId, {
      plate: newPlate,
      categoryId: car,
      validTo: iso(Date.parse(NOON) + 5 * HOUR),
      destinationZoneId: zone,
      comment: 'Поменяли машину',
      reason: 'Водитель сообщил новый номер',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changeRequest).toBeNull();
    expect(res.json().applied.sort()).toEqual(['comment', 'destinationZoneId', 'plate', 'validTo']);
    expect(res.json().pass).toMatchObject({ phase: 'before', comment: 'Поменяли машину' });
    const history = (await t.as(logist, { url: `/passes/${passId}/history` })).json().items;
    const update = history.find((e: { action: string }) => e.action === 'update');
    expect(update).toMatchObject({
      reason: 'Водитель сообщил новый номер',
      diff: { comment: { from: null, to: 'Поменяли машину' } },
    });
  });

  it('правка проверяется заново: фура без дока и чужой док отклоняются с понятной причиной', async () => {
    const passId = await create(logist, single());
    const noDock = await patch(logist, passId, { categoryId: semi, reason: 'Приедет фура' });
    expect(error(noDock)).toMatchObject({ code: 'dock_required', field: 'dockId' });
    const ok = await patch(logist, passId, {
      categoryId: semi,
      dockId: dockKey('12'),
      windowFrom: iso(Date.parse(NOON)),
      windowTo: iso(Date.parse(NOON) + HOUR),
      reason: 'Приедет фура',
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('согласованный многоразовый: номер и срок — заявкой на изменение, комментарий — сразу', async () => {
    const passId = await create(admin, multi());
    t.clock.advance(2 * HOUR);
    const res = await patch(logist, passId, {
      plate: nextPlate(),
      comment: 'Уточнение для охраны',
      reason: 'Заменили машину',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().applied).toEqual(['comment']);
    expect(res.json().changeRequest).toMatchObject({ status: 'pending' });
  });

  it('заказчик без права правки получает 403', async () => {
    const passId = await create(logist, single());
    const res = await patch(requester, passId, { comment: 'x', reason: 'тест правки' });
    expect(res.statusCode).toBe(403);
  });
});

describe('после въезда (визит открыт)', () => {
  it('правятся только комментарий и «действует до»: остальное — pass_phase_locked', async () => {
    const plate = nextPlate();
    const passId = await create(logist, single({ plate }));
    await enter(passId, plate.toUpperCase());
    expect((await view(passId)).phase).toBe('inside');

    const locked = await patch(logist, passId, { plate: nextPlate(), reason: 'Опечатка в номере' });
    expect(error(locked).code).toBe('pass_phase_locked');
    expect(error(locked).message).toContain('Номер');
    const category = await patch(logist, passId, { categoryId: semi, reason: 'Другой тип' });
    expect(error(category).code).toBe('pass_phase_locked');
    const mixed = await patch(logist, passId, {
      comment: 'Разгрузка затянулась',
      destinationZoneId: Object.values(KEYS.zones)[0] ?? '',
      reason: 'Уточнение',
    });
    expect(error(mixed).code).toBe('pass_phase_locked');

    const noReason = await patch(logist, passId, { comment: 'Разгрузка затянулась' });
    expect(error(noReason).code).toBe('reason_required');
    const ok = await patch(logist, passId, {
      comment: 'Разгрузка затянулась',
      validTo: iso(Date.parse(NOON) + 10 * HOUR),
      reason: 'Продлеваем: разгрузка затянулась',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().applied.sort()).toEqual(['comment', 'validTo']);
    expect(ok.json().pass.phase).toBe('inside');
  });

  it('«действует до» не выходит за максимум разового пропуска', async () => {
    const plate = nextPlate();
    const passId = await create(logist, single({ plate }));
    await enter(passId, plate.toUpperCase());
    const res = await patch(logist, passId, {
      validTo: iso(Date.parse(NOON) + 30 * HOUR),
      reason: 'Слишком долго',
    });
    expect(error(res)).toMatchObject({ code: 'invalid_period', field: 'validTo' });
  });

  it('согласованный многоразовый: продление после въезда — заявкой, сокращение — сразу', async () => {
    const plate = nextPlate();
    const passId = await create(admin, multi({ plate, validFrom: NOON }));
    await enter(passId, plate.toUpperCase());
    const longer = await patch(logist, passId, {
      validTo: '2026-03-16T15:00:00.000Z',
      reason: 'Нужно ещё два дня',
    });
    expect(longer.statusCode, longer.body).toBe(200);
    expect(longer.json().applied).toEqual([]);
    expect(longer.json().changeRequest).toMatchObject({ status: 'pending' });
    const shorter = await patch(logist, passId, {
      validTo: '2026-03-12T15:00:00.000Z',
      reason: 'Достаточно до среды',
    });
    expect(shorter.json().applied).toEqual(['validTo']);
    expect(shorter.json().changeRequest).toBeNull();
  });
});

describe('после выезда или использования', () => {
  it('использованный разовый — только просмотр: правка и отмена отклоняются', async () => {
    const plate = nextPlate();
    const passId = await create(logist, single({ plate }));
    await enter(passId, plate.toUpperCase(), true);
    await ownerDb().update(schema.passes).set({ status: 'used' }).where(eq(schema.passes.id, passId));
    expect((await view(passId)).phase).toBe('locked');
    const res = await patch(logist, passId, { comment: 'поздно', reason: 'Уже выехал' });
    expect(error(res).code).toBe('pass_not_editable');
    const list = await t.as(logist, { url: `/sites/${KEYS.siteId}/passes?tenantId=${dns}&status=used` });
    expect(list.json().items.find((p: { id: string }) => p.id === passId).phase).toBe('locked');
  });

  it('многоразовый после выезда остаётся рабочим: правится как «до въезда» (следующий въезд)', async () => {
    const plate = nextPlate();
    const passId = await create(admin, multi({ plate, validFrom: iso(Date.parse(NOON) + HOUR) }));
    await enter(passId, plate.toUpperCase(), true);
    expect((await view(passId)).phase).toBe('before');
    const res = await patch(logist, passId, { comment: 'Следующий рейс' });
    expect(res.statusCode, res.body).toBe(200);
  });
});

import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS, ownerDb, roleActor, seedDemo, startTestApp, type TestApp } from './support/harness';

let t: TestApp;
const admin = roleActor('site_admin');
const key = (map: Record<string, string>, name: string) => map[name] ?? '';
const tenant = (name: string) => key(KEYS.tenants, name);
const category = (name: string) => key(KEYS.categories, name);
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

describe('арендаторы', () => {
  it('пользователь арендатора видит в списке только свои компании, чужая карточка — 403', async () => {
    const manager = roleActor('tenant_manager', { tenantIds: [tenant('dns')] });
    const list = await t.as(manager, { url: `/sites/${KEYS.siteId}/tenants` });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((x: { id: string }) => x.id)).toEqual([tenant('dns')]);
    const foreign = await t.as(manager, { url: `/tenants/${tenant('x5')}` });
    expect(foreign.statusCode).toBe(403);
    const all = await t.as(admin, { url: `/sites/${KEYS.siteId}/tenants` });
    expect(all.json().items).toHaveLength(12);
  });

  it('переименование: в журнале «было → стало», событие tenant.changed', async () => {
    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/tenants`,
      payload: { legalName: 'ООО «Ромашка»', shortName: 'Ромашка' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const renamed = await t.as(admin, {
      method: 'PATCH',
      url: `/tenants/${id}`,
      payload: { shortName: 'Лютик' },
    });
    expect(renamed.json()).toMatchObject({ shortName: 'Лютик', legalName: 'ООО «Ромашка»' });
    const db = ownerDb();
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'update')));
    expect(audit?.diff).toEqual({ shortName: { from: 'Ромашка', to: 'Лютик' } });
    const [event] = await db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.aggregateId, id))
      .orderBy(desc(schema.domainEvents.id));
    expect(event).toMatchObject({
      type: 'tenant.changed',
      payload: { tenantId: id, fields: ['shortName'] },
    });
  });

  it('правило для пешеходов с сопровождением требует телефон', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant('coffee')}/pedestrian-rules`,
      payload: { escort: 'always' },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res).field).toBe('escortPhone');
  });

  it('док не бывает у двух арендаторов сразу: понятная ошибка', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant('coffee')}/dock-assignments`,
      payload: { dockId: key(KEYS.docks, '12'), validFrom: '2026-03-01' },
    });
    expect(res.statusCode).toBe(409);
    expect(error(res)).toMatchObject({ code: 'conflict', field: 'dockId' });
  });
});

describe('лимиты (ADR-012)', () => {
  it('название по умолчанию — из названий типов; число мест обязательно', async () => {
    const noCapacity = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/quotas`,
      payload: {
        tenantId: tenant('coffee'),
        categoryIds: [category('light_truck'), category('semi')],
      },
    });
    expect(noCapacity.statusCode).toBe(400);
    expect(error(noCapacity).field).toBe('capacity');

    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/quotas`,
      payload: {
        tenantId: tenant('coffee'),
        categoryIds: [category('light_truck'), category('semi')],
        capacity: 3,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Малотоннажный + фура',
      capacity: 3,
      counting: 'on_site',
      enforcement: 'hard',
      validFrom: '2026-03-10T07:00:00.000Z',
    });
    expect(created.json().categoryIds.sort()).toEqual(
      [category('light_truck'), category('semi')].sort(),
    );
  });

  it('PATCH меняет только переданное: в журнале одно поле', async () => {
    const quotaId = key(KEYS.quotas, 'canteen/cars');
    const res = await t.as(admin, {
      method: 'PATCH',
      url: `/quotas/${quotaId}`,
      payload: { capacity: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      capacity: 4,
      name: 'Легковые',
      categoryIds: [category('car')],
    });
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, quotaId), eq(schema.auditLog.action, 'update')));
    expect(audit?.diff).toEqual({ capacity: { from: 2, to: 4 } });
  });

  it('лимит «по докам»: вместимость считается по докам арендатора, число не вводится', async () => {
    const withNumber = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/quotas`,
      payload: {
        tenantId: tenant('dns'),
        name: 'Грузовые у доков',
        categoryIds: [category('semi')],
        capacityFromDocks: true,
        capacity: 10,
      },
    });
    expect(withNumber.statusCode).toBe(400);
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/quotas`,
      payload: {
        tenantId: tenant('dns'),
        name: 'Грузовые у доков',
        categoryIds: [category('semi')],
        capacityFromDocks: true,
      },
    });
    expect(res.json()).toMatchObject({ capacity: 25, capacityFromDocks: true });
  });

  it('подсчёт по пропускам и по суткам пока не поддержан — ошибка, а не молчаливая подмена', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/quotas`,
      payload: {
        tenantId: tenant('coffee'),
        categoryIds: [category('car')],
        capacity: 1,
        counting: 'per_day',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res).field).toBe('counting');
  });

  it('смена набора типов — в журнале «было → стало» по типам', async () => {
    const quotaId = key(KEYS.quotas, 'mastervent/special');
    const res = await t.as(admin, {
      method: 'PATCH',
      url: `/quotas/${quotaId}`,
      payload: { categoryIds: [category('special'), category('truck_5t')] },
    });
    expect(res.json().categoryIds.sort()).toEqual(
      [category('special'), category('truck_5t')].sort(),
    );
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, quotaId), eq(schema.auditLog.action, 'update')));
    expect(audit?.diff).toEqual({
      categoryIds: {
        from: [category('special')],
        to: [category('special'), category('truck_5t')].sort(),
      },
    });
  });
});

describe('исключения и политики', () => {
  it('номера в исключении нормализуются как в пропусках', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/exceptions`,
      payload: {
        tenantId: tenant('dns'),
        name: 'Второй автобус',
        match: { plates: ['а002аа 174 '] },
        waives: ['inspection', 'quota', 'quota'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      match: { plates: ['A002AA174'] },
      waives: ['inspection', 'quota'],
    });
  });

  it('«весь арендатор» без арендатора не принимается', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/exceptions`,
      payload: { name: 'Круглосуточно', match: { tenant: true }, waives: ['working_hours'] },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res).field).toBe('tenantId');
  });

  it('политика согласования на то же сочетание — понятная ошибка', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/approval-policies`,
      payload: { creatorKind: 'tenant', passType: 'single', mode: 'deny' },
    });
    expect(res.statusCode).toBe(409);
    expect(error(res).code).toBe('conflict');
  });

  it('правило маршрута: у пешехода нет типа транспорта', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/routing-rules`,
      payload: {
        participant: 'pedestrian',
        categoryId: category('car'),
        gateId: key(KEYS.gates, 'kpp1'),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res).field).toBe('categoryId');
  });

  it('изменение правил рассылает rules.changed с объектом', async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/routing-rules`,
      payload: {
        participant: 'vehicle',
        categoryId: category('car'),
        gateId: key(KEYS.gates, 'kpp2'),
        tenantId: tenant('x5'),
      },
    });
    expect(res.statusCode).toBe(201);
    const [event] = await ownerDb()
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.aggregateId, res.json().id));
    expect(event).toMatchObject({
      type: 'rules.changed',
      siteId: KEYS.siteId,
      payload: { entity: 'routing_rule', entityId: res.json().id },
    });
  });
});

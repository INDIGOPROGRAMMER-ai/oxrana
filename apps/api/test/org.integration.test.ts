import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gateActor,
  KEYS,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
} from './support/harness';

let t: TestApp;
const owner = roleActor('org_owner');
const siteAdmin = roleActor('site_admin');
const tenantManager = roleActor('tenant_manager', { tenantIds: [KEYS.tenants.dns ?? ''] });

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

describe('организация и пояс по умолчанию (ADR-009)', () => {
  it('организация отдаёт пояс по умолчанию с подписью', async () => {
    const res = await t.as(owner, { url: '/org' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      defaultTimezone: 'Asia/Yekaterinburg',
      defaultTimezoneLabel: 'Екатеринбург, UTC+5',
    });
  });

  it('неизвестный пояс не сохраняется: ошибка с полем', async () => {
    const res = await t.as(owner, {
      method: 'PATCH',
      url: '/org',
      payload: { defaultTimezone: 'Mars/Olympus' },
    });
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({ code: 'timezone_invalid', field: 'defaultTimezone' });
  });

  it('пояс организации меняет только роль на всю организацию', async () => {
    const res = await t.as(siteAdmin, {
      method: 'PATCH',
      url: '/org',
      payload: { defaultTimezone: 'Europe/Moscow' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('подсказка по адресу: город другого пояса — предупреждение, сама не подставляется', async () => {
    const res = await t.as(owner, {
      url: `/timezones?address=${encodeURIComponent('г. Новосибирск, ул. Станционная, 1')}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.organizationDefault).toMatchObject({ id: 'Asia/Yekaterinburg' });
    expect(body.suggestion).toMatchObject({
      timezone: 'Asia/Novosibirsk',
      city: 'Новосибирск',
      label: 'Новосибирск, UTC+7',
      differsFromDefault: true,
    });
  });

  it('новый объект без пояса получает пояс организации; у каждого объекта своя подпись', async () => {
    const created = await t.as(owner, {
      method: 'POST',
      url: '/sites',
      payload: { name: 'Склад на востоке', address: 'г. Пермь, ул. Промышленная, 5' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      timezone: 'Asia/Yekaterinburg',
      timezoneLabel: 'Пермь, UTC+5',
    });
    const explicit = await t.as(owner, {
      method: 'POST',
      url: '/sites',
      payload: { name: 'Склад в Сибири', address: 'г. Омск', timezone: 'Asia/Omsk' },
    });
    expect(explicit.json()).toMatchObject({ timezoneLabel: 'Омск, UTC+6' });

    const list = await t.as(owner, { url: '/sites' });
    const labels = Object.fromEntries(
      (list.json().items as { name: string; timezoneLabel: string }[]).map((s) => [
        s.name,
        s.timezoneLabel,
      ]),
    );
    expect(labels).toMatchObject({
      'Склад на востоке': 'Пермь, UTC+5',
      'Склад в Сибири': 'Омск, UTC+6',
    });
    const site = list.json().items.find((s: { id: string }) => s.id === KEYS.siteId);
    expect(site.timezoneLabel).toBe('Челябинск, UTC+5');
  });

  it('роль одного объекта видит в списке только свой объект', async () => {
    const res = await t.as(siteAdmin, { url: '/sites' });
    expect(res.json().items.map((s: { id: string }) => s.id)).toEqual([KEYS.siteId]);
  });
});

describe('смена пояса объекта (ADR-009, дополнение)', () => {
  async function newSite(): Promise<string> {
    const res = await t.as(owner, {
      method: 'POST',
      url: '/sites',
      payload: { name: `Объект смены пояса ${Math.random()}`, timezone: 'Asia/Yekaterinburg' },
    });
    return res.json().id;
  }

  it('обычная правка пояс не меняет и называет нужное действие', async () => {
    const siteId = await newSite();
    const res = await t.as(owner, {
      method: 'PATCH',
      url: `/sites/${siteId}`,
      payload: { timezone: 'Europe/Moscow' },
    });
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({ code: 'timezone_change_separate', field: 'timezone' });
  });

  it('без подтверждения — 409 с последствиями; с подтверждением — смена, причина в аудите', async () => {
    const siteId = await newSite();
    const unconfirmed = await t.as(owner, {
      method: 'POST',
      url: `/sites/${siteId}/timezone`,
      payload: { timezone: 'Europe/Moscow', reason: 'Объект переехал' },
    });
    expect(unconfirmed.statusCode).toBe(409);
    const body = error(unconfirmed);
    expect(body.code).toBe('confirmation_required');
    expect(body.message).toMatch(/не пересчитываются/);
    expect(body.details).toMatchObject({ from: 'Asia/Yekaterinburg', to: 'Europe/Moscow' });

    const confirmed = await t.as(owner, {
      method: 'POST',
      url: `/sites/${siteId}/timezone`,
      payload: { timezone: 'Europe/Moscow', reason: 'Объект переехал', confirm: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      timezone: 'Europe/Moscow',
      timezoneLabel: 'Москва, UTC+3',
    });

    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.entityId, siteId), eq(schema.auditLog.action, 'timezone_change')),
      )
      .orderBy(desc(schema.auditLog.id));
    expect(audit).toMatchObject({
      reason: 'Объект переехал',
      actorType: 'user',
      diff: { timezone: { from: 'Asia/Yekaterinburg', to: 'Europe/Moscow' } },
    });
  });

  it('без права site.manage пояс не меняется', async () => {
    const res = await t.as(tenantManager, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/timezone`,
      payload: { timezone: 'Europe/Moscow', reason: 'попытка', confirm: true },
    });
    expect(res.statusCode).toBe(403);
    expect(error(res).permission).toBe('site.manage');
  });
});

describe('мои настройки: «показывать ещё и моё время»', () => {
  it('по умолчанию выключено; включить можно только с выбранным поясом', async () => {
    const before = await t.as(tenantManager, { url: '/me/settings' });
    expect(before.json()).toEqual({
      showOwnTime: false,
      ownTimezone: null,
      ownTimezoneLabel: null,
    });
    const bad = await t.as(tenantManager, {
      method: 'PATCH',
      url: '/me/settings',
      payload: { showOwnTime: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(error(bad).field).toBe('ownTimezone');
    const ok = await t.as(tenantManager, {
      method: 'PATCH',
      url: '/me/settings',
      payload: { showOwnTime: true, ownTimezone: 'America/Chicago' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ showOwnTime: true, ownTimezone: 'America/Chicago' });
    expect(ok.json().ownTimezoneLabel).toMatch(/^Chicago, UTC−[56]$/);
  });

  it('у учётки поста личных настроек нет', async () => {
    const res = await t.as(gateActor('kpp1'), { url: '/me/settings' });
    expect(res.statusCode).toBe(403);
  });
});

describe('справочники объекта: CRUD, PATCH только изменённых полей, мягкое удаление', () => {
  it('зона: создать, переименовать (в аудите «было → стало»), удалить', async () => {
    const created = await t.as(siteAdmin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/zones`,
      payload: { name: 'Новая стоянка', kind: 'parking' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const patched = await t.as(siteAdmin, {
      method: 'PATCH',
      url: `/zones/${id}`,
      payload: { name: 'Стоянка у КПП' },
    });
    expect(patched.json()).toMatchObject({ name: 'Стоянка у КПП', kind: 'parking' });
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'update')));
    expect(audit?.diff).toEqual({ name: { from: 'Новая стоянка', to: 'Стоянка у КПП' } });
    const deleted = await t.as(siteAdmin, { method: 'DELETE', url: `/zones/${id}` });
    expect(deleted.json()).toEqual({ deleted: true, usages: [] });
    expect((await t.as(siteAdmin, { url: `/zones/${id}` })).statusCode).toBe(404);
  });

  it('удаление используемой зоны: сначала «где используется», с подтверждением — мягко', async () => {
    const zoneId = KEYS.zones.office ?? '';
    const refused = await t.as(siteAdmin, { method: 'DELETE', url: `/zones/${zoneId}` });
    expect(refused.statusCode).toBe(409);
    const body = error(refused);
    expect(body.code).toBe('in_use');
    const usages = body.details?.usages as { table: string; label: string; count: number }[];
    expect(usages.map((u) => u.table)).toEqual(expect.arrayContaining(['gates', 'routing_rules']));
    expect(body.message).toMatch(/КПП — 1/);
  });

  it('номер дока на объекте уникален: понятная ошибка, а не 500', async () => {
    const res = await t.as(siteAdmin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/docks`,
      payload: { number: '12' },
    });
    expect(res.statusCode).toBe(409);
    expect(error(res)).toMatchObject({ code: 'conflict', field: 'number' });
  });

  it('ссылка на зону другого объекта не принимается — ошибка с полем', async () => {
    const res = await t.as(siteAdmin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/gates`,
      payload: {
        name: 'Пост склада',
        kind: 'internal',
        zoneId: '00000000-0000-4000-8000-000000000999',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res).field).toBe('zoneId');
  });

  it('типы транспорта объекта: действующие; выключенный тип скрыт из форм', async () => {
    const list = await t.as(tenantManager, { url: `/sites/${KEYS.siteId}/vehicle-categories` });
    expect(list.json().items.map((c: { presetCode: string }) => c.presetCode)).toEqual([
      'car',
      'light_truck',
      'semi',
      'truck_5t',
      'special',
    ]);
    const bus = await t.as(owner, {
      method: 'POST',
      url: '/vehicle-categories',
      payload: { siteId: null, presetCode: 'bus', sort: 60, enabled: false },
    });
    expect(bus.statusCode).toBe(201);
    expect(bus.json()).toMatchObject({ name: 'автобус', enabled: false });
    const again = await t.as(tenantManager, { url: `/sites/${KEYS.siteId}/vehicle-categories` });
    expect(again.json().items).toHaveLength(5);
    const all = await t.as(owner, { url: `/sites/${KEYS.siteId}/vehicle-categories?all=true` });
    expect(all.json().items).toHaveLength(6);
  });
});

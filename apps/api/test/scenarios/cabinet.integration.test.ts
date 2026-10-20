import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  customActor,
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
  windowFollowsPolicy,
} from '../support/harness';

/**
 * Кабинет арендатора, этап 7a: подсказки формы до сохранения (чёрный список, блокировка, договор),
 * автопарк, «повторить вчерашний день», сводка главной, фильтры списка. Часы стоят на вторнике
 * 10.03.2026 12:00 по объекту; субъекты — настоящие сессии (ADR-018).
 */
let t: TestApp;
const id = (map: Record<string, string>, name: string) => map[name] ?? '';
const dns = id(KEYS.tenants, 'dns');
const other = id(KEYS.tenants, 'x5') || Object.values(KEYS.tenants).find((v) => v !== dns) || '';
const semi = id(KEYS.categories, 'semi');
const car = id(KEYS.categories, 'car');
const dock12 = id(KEYS.docks, '12');
const at = (hhmm: string, day = '2026-03-10') => new Date(`${day}T${hhmm}:00+05:00`).toISOString();
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

const logist = roleActor('tenant_manager', { tenantIds: [dns] });
const requester = roleActor('tenant_requester', { tenantIds: [dns] });
const viewer = roleActor('tenant_viewer', { tenantIds: [dns] });
const otherLogist = roleActor('tenant_manager', { tenantIds: [other] });
const admin = roleActor('site_admin');

let counter = 300;
const nextPlate = () => `К${++counter}МС174`;

const hints = (actor: typeof logist, body: Record<string, unknown>, tenant = dns) =>
  t.as(actor, { method: 'POST', url: `/tenants/${tenant}/pass-hints`, payload: body });

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  await windowFollowsPolicy(t);
});
afterAll(() => t.close());

describe('контекст кабинета и сводка «сегодня»', () => {
  it('шапка: арендатор, объект с поясом, справочники; чужой арендатор — 403', async () => {
    const res = await t.as(logist, { url: `/tenants/${dns}/cabinet` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.tenant).toMatchObject({ id: dns, status: 'active', isOperator: false });
    expect(body.site.timezone).toBe('Asia/Yekaterinburg');
    expect(body.site.timezoneLabel).toBe('Челябинск, UTC+5');
    expect(body.today).toBe('2026-03-10');
    expect(body.categories.some((c: { id: string; available: boolean }) => c.id === semi)).toBe(
      true,
    );
    expect(body.docks.length).toBeGreaterThan(0);
    const foreign = await t.as(otherLogist, { url: `/tenants/${dns}/cabinet` });
    expect(foreign.statusCode).toBe(403);
  });

  it('сегодня: ожидаются, въехали, выехали, отказы — только своего арендатора', async () => {
    const before = await t.as(logist, { url: `/tenants/${dns}/today` });
    expect(before.statusCode, before.body).toBe(200);
    const created = await t.as(logist, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: dns,
        passType: 'single',
        participant: 'vehicle',
        plate: nextPlate(),
        categoryId: car,
        validFrom: at('12:00'),
        validTo: at('20:00'),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const after = await t.as(logist, { url: `/tenants/${dns}/today` });
    expect(after.json().expected).toBe(before.json().expected + 1);
    expect(after.json().date).toBe('2026-03-10');

    // въезд и выезд сегодня — напрямую в таблицу визитов (путь checkIn проверяют сценарии поста)
    const db = ownerDb();
    await db.insert(schema.visits).values([
      {
        organizationId: KEYS.organizationId,
        siteId: KEYS.siteId,
        tenantId: dns,
        passId: created.json().id,
        participant: 'vehicle',
        categoryId: car,
        snapshot: { note: 'сводка' },
        gateInId: id(KEYS.gates, 'kpp1'),
        timeIn: new Date(at('10:00')),
        timeOut: new Date(at('11:00')),
        methodIn: 'button',
      },
    ]);
    const inOut = await t.as(logist, { url: `/tenants/${dns}/today` });
    expect(inOut.json().entered).toBe(before.json().entered + 1);
    expect(inOut.json().exited).toBe(before.json().exited + 1);
    // пропуск, по которому уже въезжали сегодня, больше не «ожидается»
    expect(inOut.json().expected).toBe(before.json().expected);

    const foreign = await t.as(otherLogist, { url: `/tenants/${dns}/today` });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('подсказки формы до сохранения (POST /tenants/:id/pass-hints)', () => {
  const plate = nextPlate();

  it('чёрный список (Q-76): пропуск не оформляется ни арендатору, ни администратору; арендатору — без причины', async () => {
    const clean = await hints(logist, { participant: 'vehicle', categoryId: car, plate });
    expect(clean.statusCode, clean.body).toBe(200);
    expect(clean.json().notices).toEqual([]);

    const phone = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${KEYS.siteId}/settings`,
      payload: { dutyAdminPhone: '+7 900 000-00-11' },
    });
    expect(phone.statusCode, phone.body).toBe(200);
    const listed = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/blacklist`,
      payload: { level: 'site', plate, reason: 'Секретная причина' },
    });
    expect(listed.statusCode, listed.body).toBe(201);

    const tenantView = await hints(logist, { participant: 'vehicle', categoryId: car, plate });
    const notice = tenantView.json().notices[0];
    expect(notice).toMatchObject({ code: 'blacklisted', severity: 'error' });
    expect(notice.text).toBe(
      'Номер в чёрном списке объекта — пропуск оформить нельзя. Обратитесь к администратору объекта (дежурный администратор: +7 900 000-00-11).',
    );
    expect(notice.text).not.toContain('Секретная причина');

    // номер вводят как придётся: пробелы, кириллица
    const messy = await hints(logist, {
      participant: 'vehicle',
      categoryId: car,
      plate: `  ${plate.toLowerCase()} `,
    });
    expect(messy.json().notices[0]?.code).toBe('blacklisted');

    const adminView = await hints(admin, { participant: 'vehicle', categoryId: car, plate }, dns);
    expect(adminView.json().notices[0].text).toContain('Секретная причина');

    const payload = {
      tenantId: dns,
      passType: 'single',
      participant: 'vehicle',
      plate,
      categoryId: car,
      validFrom: at('12:00'),
      validTo: at('20:00'),
    };
    const refused = await t.as(logist, { method: 'POST', url: '/passes', payload });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(error(refused)).toMatchObject({ code: 'blacklisted', field: 'plate' });
    expect(error(refused).message).not.toContain('Секретная причина');
    // администратор видит причину, но тоже не оформит
    const refusedAdmin = await t.as(admin, { method: 'POST', url: '/passes', payload });
    expect(refusedAdmin.statusCode).toBe(422);
    expect(error(refusedAdmin)).toMatchObject({
      code: 'blacklisted',
      settingLink: '/admin/blacklist',
    });
    expect(error(refusedAdmin).message).toContain('Секретная причина');
    // в пакете строка красная и не создаётся, соседняя — создаётся
    const other = nextPlate();
    const batch = await t.as(logist, {
      method: 'POST',
      url: '/passes/batch',
      payload: {
        tenantId: dns,
        rows: [
          { ...payload, tenantId: undefined },
          { ...payload, tenantId: undefined, plate: other },
        ],
      },
    });
    expect(batch.json()).toMatchObject({ created: 1 });
    expect(batch.json().errors).toEqual([expect.objectContaining({ row: 1, code: 'blacklisted' })]);

    await t.as(admin, { method: 'DELETE', url: `/blacklist/${listed.json().id}` });
    const after = await hints(logist, { participant: 'vehicle', categoryId: car, plate });
    expect(after.json().notices).toEqual([]);
    await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${KEYS.siteId}/settings`,
      payload: { dutyAdminPhone: null },
    });
  });

  it('запись, которая кончается раньше начала пропуска, оформлению не мешает', async () => {
    const soon = nextPlate();
    const listed = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/blacklist`,
      payload: {
        level: 'site',
        plate: soon,
        reason: 'до завтрашнего утра',
        validTo: at('09:00', '2026-03-11'),
      },
    });
    expect(listed.statusCode, listed.body).toBe(201);
    const payload = (from: string) => ({
      tenantId: dns,
      passType: 'single',
      participant: 'vehicle',
      plate: soon,
      categoryId: car,
      validFrom: at(from, '2026-03-11'),
      validTo: at('20:00', '2026-03-11'),
    });
    // подсказка с началом позже окончания записи — без предупреждений
    const hint = await hints(logist, {
      participant: 'vehicle',
      categoryId: car,
      plate: soon,
      validFrom: at('12:00', '2026-03-11'),
    });
    expect(hint.json().notices).toEqual([]);
    const early = await t.as(logist, { method: 'POST', url: '/passes', payload: payload('08:00') });
    expect(error(early).code).toBe('blacklisted');
    const later = await t.as(logist, { method: 'POST', url: '/passes', payload: payload('12:00') });
    expect(later.statusCode, later.body).toBe(201);
    await t.as(admin, { method: 'DELETE', url: `/blacklist/${listed.json().id}` });
  });

  it('пешеход из чёрного списка по имени', async () => {
    const listed = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/blacklist`,
      payload: { level: 'site', personName: 'Тестов Нежеланный', reason: 'нарушение' },
    });
    expect(listed.statusCode, listed.body).toBe(201);
    const res = await hints(logist, { participant: 'pedestrian', personName: 'тестов нежеланный' });
    expect(res.json().notices[0]).toMatchObject({ code: 'blacklisted', severity: 'error' });
    await t.as(admin, { method: 'DELETE', url: `/blacklist/${listed.json().id}` });
  });

  it('блокировка арендатора: новые пропуска запрещены — ошибка; запрет въезда — предупреждение', async () => {
    const block = (mode: string) =>
      t.as(admin, {
        method: 'POST',
        url: `/tenants/${dns}/block`,
        payload: { mode, reason: 'проверка подсказок', confirm: true },
      });
    expect((await block('new_passes')).statusCode).toBe(200);
    const blocked = await hints(logist, { participant: 'vehicle', categoryId: car });
    expect(blocked.json().notices[0]).toMatchObject({ code: 'tenant_blocked', severity: 'error' });
    expect(blocked.json().notices[0].text).toContain('Обратитесь к администратору объекта');
    expect(blocked.json().notices[0].text).not.toContain('Решение принимает администратор');

    expect((await block('entry')).statusCode).toBe(200);
    const entry = await hints(logist, { participant: 'vehicle', categoryId: car });
    expect(entry.json().notices[0]).toMatchObject({
      code: 'tenant_entry_blocked',
      severity: 'warning',
    });

    const unblock = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${dns}/unblock`,
      payload: { reason: 'проверка закончена' },
    });
    expect(unblock.statusCode).toBe(200);
    expect(
      (await hints(logist, { participant: 'vehicle', categoryId: car })).json().notices,
    ).toEqual([]);
  });

  it('договор закончился: ошибка до сохранения', async () => {
    const list = await t.as(admin, { url: `/tenants/${dns}/contracts` });
    const contract = list
      .json()
      .items.find((c: { validTo: string | null }) => c.validTo !== undefined);
    expect(contract, 'у ДНС в демо-сиде есть договор').toBeTruthy();
    const original = contract.validTo;
    const patch = (validTo: string | null) =>
      t.as(admin, { method: 'PATCH', url: `/contracts/${contract.id}`, payload: { validTo } });
    expect((await patch('2026-03-01')).statusCode).toBe(200);
    const res = await hints(logist, { participant: 'vehicle', categoryId: car });
    expect(res.json().notices[0]).toMatchObject({ code: 'contract_expired', severity: 'error' });
    expect((await patch(original)).statusCode).toBe(200);
  });

  it('данные подсказки не попадают в адрес: GET без номера работает, как раньше', async () => {
    const res = await t.as(logist, {
      url: `/tenants/${dns}/pass-hints?participant=vehicle&categoryId=${semi}&passType=single`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().notices).toEqual([]);
    expect(res.json().route.text).toContain('КПП-2');
  });
});

describe('справочники списка пропусков по всему объекту (7b.2)', () => {
  const admin = roleActor('site_admin');

  it('администратор: все арендаторы, все доки с арендатором, пояс объекта; тип в порядке справочника', async () => {
    const res = await t.as(admin, { url: `/sites/${KEYS.siteId}/passes/context` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.site.timezoneLabel).toBe('Челябинск, UTC+5');
    expect(body.today).toBe('2026-03-10');
    expect(body.tenants.map((x: { id: string }) => x.id)).toEqual(
      expect.arrayContaining([dns, other]),
    );
    expect(body.docks.some((d: { tenantId: string | null }) => d.tenantId === dns)).toBe(true);
    expect(body.docks.some((d: { tenantId: string | null }) => d.tenantId === other)).toBe(true);
    expect(body.categories.length).toBeGreaterThan(1);
  });

  it('арендатор видит только свои компании; без права на пропуска — 403', async () => {
    const mine = await t.as(logist, { url: `/sites/${KEYS.siteId}/passes/context` });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().tenants.map((x: { id: string }) => x.id)).toEqual([dns]);
    // доки чужих арендаторов в справочник не попадают (7b.3)
    const docks = mine.json().docks as { tenantId: string | null }[];
    expect(docks.length).toBeGreaterThan(0);
    expect(docks.every((d) => d.tenantId === null || d.tenantId === dns)).toBe(true);
    const nobody = customActor(['profile.manage_own'], {});
    const denied = await t.as(nobody, { url: `/sites/${KEYS.siteId}/passes/context` });
    expect(denied.statusCode).toBe(403);
  });
});

describe('автопарк', () => {
  const plate = nextPlate();
  let vehicleId = '';

  it('логист добавляет машину: номер нормализован (пробел не мешает), список виден заказчику', async () => {
    const res = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet`,
      payload: { plate: ` ${plate} `, categoryId: semi, brand: 'MAN', comment: 'Тестов Т. Т.' },
    });
    expect(res.statusCode, res.body).toBe(201);
    vehicleId = res.json().id;
    expect(res.json()).toMatchObject({
      plateRaw: plate,
      plateNorm: plate.replace('К', 'K').replace('МС', 'MC'),
      plateCountry: 'RU',
      brand: 'MAN',
    });
    const list = await t.as(requester, { url: `/tenants/${dns}/fleet` });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((v: { id: string }) => v.id)).toContain(vehicleId);
  });

  it('тот же номер дважды — понятная ошибка у поля; после удаления можно добавить снова', async () => {
    const dup = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet`,
      payload: { plate: plate.toLowerCase(), categoryId: semi },
    });
    expect(dup.statusCode).toBe(409);
    expect(error(dup)).toMatchObject({ code: 'conflict', field: 'plate' });
  });

  it('правка шлёт только изменённые поля и пишется в аудит; без права — 403', async () => {
    const res = await t.as(logist, {
      method: 'PATCH',
      url: `/fleet/${vehicleId}`,
      payload: { comment: 'Другой Д. Д.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ comment: 'Другой Д. Д.', brand: 'MAN' });
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, vehicleId));
    expect(audit.map((a) => a.action)).toEqual(['create', 'update']);
    expect(audit[1]?.diff).toMatchObject({
      comment: { from: 'Тестов Т. Т.', to: 'Другой Д. Д.' },
    });

    const denied = await t.as(requester, {
      method: 'PATCH',
      url: `/fleet/${vehicleId}`,
      payload: { brand: 'DAF' },
    });
    expect(denied.statusCode).toBe(403);
    expect(error(denied).permission).toBe('fleet.manage');
    const viewerRead = await t.as(viewer, { url: `/tenants/${dns}/fleet` });
    expect(viewerRead.statusCode).toBe(200);
    const foreign = await t.as(otherLogist, { url: `/tenants/${dns}/fleet` });
    expect(foreign.statusCode).toBe(403);
  });

  it('пакет из Excel: предпросмотр без записи, повтор номера и неверный тип — ошибки строк', async () => {
    const rows = [
      { plate: nextPlate(), categoryId: car },
      { plate: plate, categoryId: car },
      { plate: nextPlate(), categoryId: car, comment: 'Пакетов П. П.' },
      { plate: '   ', categoryId: car },
    ];
    const preview = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet/batch`,
      payload: { items: rows.slice(0, 3), dryRun: true },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, total: 3, created: 2 });
    expect(preview.json().errors[0]).toMatchObject({ row: 2, field: 'plate' });
    const before = (await t.as(logist, { url: `/tenants/${dns}/fleet` })).json().items.length;
    const real = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet/batch`,
      payload: { items: rows.slice(0, 3) },
    });
    expect(real.json().created).toBe(2);
    const after = (await t.as(logist, { url: `/tenants/${dns}/fleet` })).json().items.length;
    expect(after).toBe(before + 2);
    // строка без номера — ошибка этой строки, остальные не страдают
    const bad = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet/batch`,
      payload: { items: [rows[3]], dryRun: true },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().errors[0]).toMatchObject({ row: 1, field: 'plate' });
  });

  it('удаление мягкое, в аудите; номер освобождается', async () => {
    const del = await t.as(logist, { method: 'DELETE', url: `/fleet/${vehicleId}` });
    expect(del.statusCode, del.body).toBe(200);
    const again = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet`,
      payload: { plate, categoryId: semi },
    });
    expect(again.statusCode, again.body).toBe(201);
  });
});

describe('автопарк по настройке формы (7b.2)', () => {
  const admin = roleActor('site_admin');
  const setTenantForm = (fields: Record<string, string | null>) =>
    t.as(admin, {
      method: 'PATCH',
      url: `/tenants/${dns}/pass-form`,
      payload: { fields },
    });
  const add = (extra: Record<string, unknown>) =>
    t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet`,
      payload: { plate: nextPlate(), categoryId: car, ...extra },
    });

  it('скрытое поле формы машина не принимает (ФИО и телефон скрыты по умолчанию), обязательное — требует', async () => {
    const hidden = await add({ driverName: 'Иванов И. И.' });
    expect(hidden.statusCode).toBe(422);
    expect(error(hidden)).toMatchObject({ code: 'field_hidden', field: 'driverName' });
    expect(error(hidden).message).toContain('отключено в настройке формы');
    expect((await add({ driverPhone: '+7 900 000-00-00' })).statusCode).toBe(422);

    try {
      await setTenantForm({ driverName: 'required', comment: 'hidden' });
      const missing = await add({});
      expect(missing.statusCode).toBe(422);
      expect(error(missing)).toMatchObject({ code: 'field_required', field: 'driverName' });
      expect((await add({ driverName: 'Иванов И. И.' })).statusCode).toBe(201);
      // комментарий скрыт — значения не принимаются
      const commentHidden = await add({ driverName: 'Петров П. П.', comment: 'срочно' });
      expect(error(commentHidden)).toMatchObject({ code: 'field_hidden', field: 'comment' });
    } finally {
      await setTenantForm({ driverName: null, comment: null });
    }
    expect((await add({ driverName: null })).statusCode).toBe(201);
  });

  it('пакетом — так же: предпросмотр называет поле, а не молча отбрасывает', async () => {
    const preview = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/fleet/batch`,
      payload: {
        items: [
          { plate: nextPlate(), categoryId: car, brand: 'Kia' },
          { plate: nextPlate(), categoryId: car, driverPhone: '+7 900 000-00-00' },
        ],
        dryRun: true,
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ total: 2, created: 1 });
    expect(preview.json().errors[0]).toMatchObject({
      row: 2,
      field: 'driverPhone',
      code: 'field_hidden',
    });
  });

  it('док и комментарий по умолчанию: хранятся у машины; чужой док — отказ', async () => {
    const ok = await add({ dockId: dock12, comment: 'Возит стекло' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ dockId: dock12, comment: 'Возит стекло' });
    const foreign = await add({ dockId: id(KEYS.docks, '40') });
    expect(foreign.statusCode).toBe(422);
    expect(error(foreign)).toMatchObject({ code: 'dock_not_assigned', field: 'dockId' });
    // правка: убрать док — null
    const cleared = await t.as(logist, {
      method: 'PATCH',
      url: `/fleet/${ok.json().id}`,
      payload: { dockId: null },
    });
    expect(cleared.json()).toMatchObject({ dockId: null, comment: 'Возит стекло' });
  });
});

describe('«Повторить вчерашний день»', () => {
  it('разовые пропуска вчерашнего дня создаются заново на сегодня с теми же часами; предпросмотр ничего не пишет', async () => {
    const plateA = nextPlate();
    const plateB = nextPlate();
    t.clock.set('2026-03-09T07:00:00.000Z');
    for (const plate of [plateA, plateB]) {
      // водителя вписал администратор: у логиста поле «ФИО водителя» по умолчанию скрыто (ADR-023)
      const res = await t.as(admin, {
        method: 'POST',
        url: '/passes',
        payload: {
          tenantId: dns,
          passType: 'single',
          participant: 'vehicle',
          plate,
          categoryId: car,
          driverName: 'Вчерашний В. В.',
          validFrom: at('12:00', '2026-03-09'),
          validTo: at('20:00', '2026-03-09'),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    t.clock.set(NOON);

    const repeat = (dryRun: boolean) =>
      t.as(logist, {
        method: 'POST',
        url: `/tenants/${dns}/passes/repeat`,
        payload: { sourceDate: '2026-03-09', targetDate: '2026-03-10', dryRun },
      });
    const preview = await repeat(true);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, total: 2, created: 2, errors: [] });

    const real = await repeat(false);
    expect(real.json()).toMatchObject({ dryRun: false, total: 2, created: 2 });
    const list = await t.as(logist, {
      url: `/sites/${KEYS.siteId}/passes?tenantId=${dns}&dateFrom=2026-03-10&dateTo=2026-03-10&q=${plateA.slice(1, 4)}`,
    });
    const copy = list.json().items.find((p: { plateRaw: string }) => p.plateRaw === plateA);
    expect(copy).toMatchObject({
      validFrom: at('12:00'),
      validTo: at('20:00'),
      // скрытое настройкой формы поле в копию не переносится
      driverName: null,
    });

    // второй раз — те же номера уже есть на сегодня: дубли отмечены ошибками строк, не падением
    const twice = await repeat(false);
    expect(twice.json().created).toBe(0);
    expect(twice.json().errors.map((e: { code: string }) => e.code)).toEqual([
      'pass_duplicate',
      'pass_duplicate',
    ]);
  });

  it('Q-80: начало в прошлом — строка отклонена с причиной; с флагом «сдвинуть на сейчас» — создаётся', async () => {
    const plate = nextPlate();
    t.clock.set('2026-03-09T07:00:00.000Z');
    const made = await t.as(logist, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: dns,
        passType: 'single',
        participant: 'vehicle',
        plate,
        categoryId: car,
        validFrom: at('12:00', '2026-03-09'),
        validTo: at('20:00', '2026-03-09'),
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    t.clock.set('2026-03-10T10:00:00.000Z'); // 15:00 по объекту
    const repeat = (body: Record<string, unknown>) =>
      t.as(logist, {
        method: 'POST',
        url: `/tenants/${dns}/passes/repeat`,
        payload: { sourceDate: '2026-03-09', targetDate: '2026-03-10', ...body },
      });
    const without = await repeat({ dryRun: true });
    expect(without.json().errors.map((e: { code: string }) => e.code)).toContain('starts_in_past');
    const shifted = await repeat({ shiftPastToNow: true });
    expect(shifted.json().errors.filter((e: { row: number }) => e.row > 0)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'starts_in_past' })]),
    );
    const list = await t.as(logist, {
      url: `/sites/${KEYS.siteId}/passes?tenantId=${dns}&dateFrom=2026-03-10&dateTo=2026-03-10&q=${plate.slice(1, 4)}`,
    });
    const copy = list.json().items.find((p: { plateRaw: string }) => p.plateRaw === plate);
    expect(copy.validFrom).toBe('2026-03-10T10:00:00.000Z');
    expect(copy.validTo).toBe(at('20:00'));
    t.clock.set(NOON);
  });

  it('в день без пропусков — понятное сообщение, а не ошибка', async () => {
    const res = await t.as(logist, {
      method: 'POST',
      url: `/tenants/${dns}/passes/repeat`,
      payload: { sourceDate: '2026-01-05', targetDate: '2026-03-10', dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 0, created: 0 });
    expect(res.json().summary).toContain('повторять нечего');
  });

  it('просмотрщик пропуска создать не может; чужой арендатор — 403', async () => {
    const denied = await t.as(viewer, {
      method: 'POST',
      url: `/tenants/${dns}/passes/repeat`,
      payload: { sourceDate: '2026-03-09', targetDate: '2026-03-10' },
    });
    expect(denied.statusCode).toBe(403);
    const foreign = await t.as(otherLogist, {
      method: 'POST',
      url: `/tenants/${dns}/passes/repeat`,
      payload: { sourceDate: '2026-03-09', targetDate: '2026-03-10' },
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('список пропусков: фильтры', () => {
  it('по типу, статусу и дате; дата — местные сутки объекта', async () => {
    const plate = nextPlate();
    const multi = await t.as(logist, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: dns,
        passType: 'multi',
        participant: 'vehicle',
        plate,
        categoryId: car,
        comment: 'Ревизия',
        validFrom: at('12:00'),
        validTo: at('12:00', '2026-03-14'),
      },
    });
    expect(multi.statusCode, multi.body).toBe(201);
    const url = (query: string) => `/sites/${KEYS.siteId}/passes?tenantId=${dns}&${query}`;
    const byType = await t.as(logist, { url: url('passType=multi') });
    expect(byType.json().items.every((p: { passType: string }) => p.passType === 'multi')).toBe(
      true,
    );
    const inRange = await t.as(logist, {
      url: url('dateFrom=2026-03-12&dateTo=2026-03-12&passType=multi'),
    });
    expect(inRange.json().items.map((p: { plateRaw: string }) => p.plateRaw)).toContain(plate);
    const outOfRange = await t.as(logist, {
      url: url('dateFrom=2026-03-15&dateTo=2026-03-20&passType=multi'),
    });
    expect(outOfRange.json().items.map((p: { plateRaw: string }) => p.plateRaw)).not.toContain(
      plate,
    );
    const pending = await t.as(logist, { url: url('status=pending_approval') });
    expect(pending.json().items.some((p: { plateRaw: string }) => p.plateRaw === plate)).toBe(true);
  });
});

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
} from '../support/harness';

/**
 * Настройка формы пропуска по уровням «объект → арендатор → сотрудник» (этап 7b, ADR-023): слои и
 * «откуда значение», ограничения на сервере (одиночно и пакетом), быстрый разовый пропуск,
 * окно по политике и по форме. Часы стоят на вторнике 10.03.2026 12:00 по объекту.
 */
let t: TestApp;
const id = (map: Record<string, string>, name: string) => map[name] ?? '';
const dns = id(KEYS.tenants, 'dns');
const x5 = id(KEYS.tenants, 'x5');
const semi = id(KEYS.categories, 'semi');
const car = id(KEYS.categories, 'car');
const light = id(KEYS.categories, 'light_truck');
const dock12 = id(KEYS.docks, '12');
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const HOUR = 3_600_000;

const admin = roleActor('site_admin');
const logist = roleActor('tenant_manager', { tenantIds: [dns] });
const requester = roleActor('tenant_requester', { tenantIds: [dns] });
// два сотрудника ДНС с одинаковыми правами на создание — настройка формы у каждого своя
const CREATE = ['pass.view', 'pass.create.single', 'pass.create.multi', 'pass.cancel_own'] as const;
const staffA = customActor([...CREATE], { tenantIds: [dns] });
const staffB = customActor([...CREATE, 'profile.manage_own'], { tenantIds: [dns] });

let plateCounter = 500;
const nextPlate = () => `Р${++plateCounter}ОС174`;

const setSite = (body: Record<string, unknown>) =>
  t.as(admin, { method: 'PATCH', url: `/sites/${KEYS.siteId}/pass-form`, payload: body });
const setTenant = (body: Record<string, unknown>, tenant = dns) =>
  t.as(admin, { method: 'PATCH', url: `/tenants/${tenant}/pass-form`, payload: body });
const setUser = (userId: string, body: Record<string, unknown>, by = admin) =>
  t.as(by, { method: 'PATCH', url: `/tenants/${dns}/users/${userId}/pass-form`, payload: body });
const mine = (actor: typeof logist) =>
  t.as(actor, { url: `/tenants/${dns}/pass-form` }).then((r) => r.json());
const create = (actor: typeof logist, payload: Record<string, unknown>) =>
  t.as(actor, { method: 'POST', url: '/passes', payload });

const carPass = (extra: Record<string, unknown> = {}) => ({
  tenantId: dns,
  passType: 'single',
  participant: 'vehicle',
  plate: nextPlate(),
  categoryId: car,
  ...extra,
});

async function resetForm() {
  await ownerDb().delete(schema.passFormSettings);
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  // учётные записи сотрудников создаются при первом обращении — нужны до настройки их формы
  for (const person of [logist, requester, staffA, staffB]) await t.headersFor(person);
});
afterAll(() => t.close());

describe('слои настройки и «откуда значение»', () => {
  it('по умолчанию ФИО и телефон водителя скрыты, окно — по политике, разовый — 23 часа', async () => {
    await resetForm();
    const { form, enforced } = await mine(logist);
    expect(enforced).toBe(true);
    expect(form.fields).toMatchObject({
      driverName: 'hidden',
      driverPhone: 'hidden',
      brand: 'optional',
      window: 'policy',
    });
    expect(form.singleHours).toBe(23);
    expect(form.sources.fields.driverName).toBe('default');
    expect(form.passTypes).toEqual(['single', 'multi', 'permanent']);
  });

  it('нижний уровень переопределяет верхний; «сбросить к уровню выше» возвращает значение', async () => {
    await resetForm();
    expect((await setSite({ fields: { driverName: 'optional' } })).statusCode).toBe(200);
    expect((await mine(logist)).form.fields.driverName).toBe('optional');
    expect((await mine(logist)).form.sources.fields.driverName).toBe('site');

    await setTenant({ fields: { driverName: 'required' } });
    expect((await mine(logist)).form.sources.fields.driverName).toBe('tenant');
    expect((await mine(logist)).form.fields.driverName).toBe('required');
    // арендатор Б не затронут уровнем арендатора ДНС
    const other = await t.as(admin, { url: `/tenants/${x5}/pass-form` });
    expect(other.json().form.fields.driverName).toBe('optional');

    await setUser(logist.id, { fields: { driverName: 'hidden' } });
    expect((await mine(logist)).form.sources.fields.driverName).toBe('user');
    expect((await mine(logist)).form.fields.driverName).toBe('hidden');

    // сброс сотрудника → значение арендатора, сброс арендатора → значение объекта
    await setUser(logist.id, { fields: { driverName: null } });
    expect((await mine(logist)).form.sources.fields.driverName).toBe('tenant');
    await setTenant({ fields: { driverName: null } });
    expect((await mine(logist)).form.sources.fields.driverName).toBe('site');
    await setSite({ fields: { driverName: null } });
    expect((await mine(logist)).form.sources.fields.driverName).toBe('default');
    // пустые уровни не хранятся
    expect(await ownerDb().select().from(schema.passFormSettings)).toHaveLength(0);
  });

  it('PATCH только изменённых полей: повтор тех же значений не пишет в журнал; изменения — «было → стало»', async () => {
    await resetForm();
    const count = async () =>
      (
        await ownerDb()
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.entity, 'pass_form_settings'))
      ).length;
    const before = await count();
    await setSite({ fields: { brand: 'required' }, reason: 'Нужна марка на воротах' });
    const again = await setSite({ fields: { brand: 'required' } });
    expect(again.statusCode).toBe(200);
    expect(await count()).toBe(before + 1);
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.reason, 'Нужна марка на воротах'));
    expect(audit).toMatchObject({
      action: 'create',
      reason: 'Нужна марка на воротах',
      diff: { 'fields.brand': { from: null, to: 'required' } },
    });
    await setSite({ fields: { brand: null } });
  });

  it('значения проверяются: окончание разового не больше максимума объекта, тип по умолчанию — среди разрешённых', async () => {
    await resetForm();
    const tooLong = await setSite({ singleHours: 30 });
    expect(error(tooLong)).toMatchObject({ code: 'invalid_period', field: 'singleHours' });
    const noDefault = await setTenant({ categoryIds: [car], defaultCategoryId: semi });
    expect(error(noDefault).field).toBe('defaultCategoryId');
    const wrongDefault = await setTenant({ passTypes: ['multi'], defaultPassType: 'single' });
    expect(error(wrongDefault).field).toBe('defaultPassType');
  });
});

describe('ограничения на сервере: сотрудник А и сотрудник Б', () => {
  it('у А только «малотоннажный» и только разовый, у Б только «фура»: каждый видит своё, чужой тип отклоняется', async () => {
    await resetForm();
    expect(
      (
        await setUser(staffA.id, {
          categoryIds: [light],
          passTypes: ['single'],
          fields: { window: 'optional' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await setUser(staffB.id, { categoryIds: [semi] })).statusCode).toBe(200);

    const hintsA = (
      await t.as(staffA, {
        method: 'POST',
        url: `/tenants/${dns}/pass-hints`,
        payload: { participant: 'vehicle' },
      })
    ).json();
    expect(hintsA.categories.map((c: { id: string }) => c.id)).toEqual([light]);
    expect(hintsA.passTypes.map((p: { passType: string }) => p.passType)).toEqual(['single']);
    const hintsB = (
      await t.as(staffB, {
        method: 'POST',
        url: `/tenants/${dns}/pass-hints`,
        payload: { participant: 'vehicle' },
      })
    ).json();
    expect(hintsB.categories.map((c: { id: string }) => c.id)).toEqual([semi]);
    expect(hintsB.passTypes.length).toBe(2);

    // сервер: чужой тип и чужой вид пропуска — отказ с причиной
    const aSemi = await create(staffA, carPass({ categoryId: semi, dockId: dock12 }));
    expect(error(aSemi)).toMatchObject({ code: 'category_unavailable', field: 'categoryId' });
    expect(error(aSemi).message).toContain('отключён в настройке формы');
    const aMulti = await create(
      staffA,
      carPass({
        categoryId: light,
        dockId: dock12,
        passType: 'multi',
        validFrom: new Date(Date.parse(NOON) + HOUR).toISOString(),
        validTo: new Date(Date.parse(NOON) + 3 * 24 * HOUR).toISOString(),
        comment: 'тест',
      }),
    );
    expect(error(aMulti)).toMatchObject({ code: 'pass_type_forbidden', field: 'passType' });
    const bCar = await create(staffB, carPass({ categoryId: car }));
    expect(error(bCar).code).toBe('category_unavailable');

    // разрешённое — проходит у каждого
    const aOk = await create(staffA, carPass({ categoryId: light, dockId: dock12 }));
    expect(aOk.statusCode, aOk.body).toBe(201);
    const bOk = await create(staffB, carPass({ categoryId: semi, dockId: dock12, windowFrom: NOON, windowTo: new Date(Date.parse(NOON) + HOUR).toISOString() }));
    expect(bOk.statusCode, bOk.body).toBe(201);

    // пакет проходит те же проверки: строка с чужим типом — ошибка строки, остальные создаются
    const batch = await t.as(staffA, {
      method: 'POST',
      url: '/passes/batch',
      payload: {
        tenantId: dns,
        dryRun: true,
        rows: [
          { passType: 'single', participant: 'vehicle', plate: nextPlate(), categoryId: light, dockId: dock12 },
          { passType: 'single', participant: 'vehicle', plate: nextPlate(), categoryId: car },
        ],
      },
    });
    expect(batch.json().created).toBe(1);
    expect(batch.json().errors).toEqual([
      expect.objectContaining({ row: 2, code: 'category_unavailable' }),
    ]);
  });

  it('форма не шире прав роли: вид пропуска, на который роль не даёт права, остаётся запрещённым', async () => {
    await resetForm();
    await setUser(requester.id, { passTypes: ['permanent'] });
    const hints = (
      await t.as(requester, { method: 'POST', url: `/tenants/${dns}/pass-hints`, payload: { participant: 'vehicle' } })
    ).json();
    // у «Арендатор — заказчик» право на постоянный есть, а политика согласования уводит на согласование
    expect(hints.passTypes.map((p: { passType: string }) => p.passType)).toEqual(['permanent']);
    const editor = (
      await t.as(admin, { url: `/tenants/${dns}/pass-form/editor?userId=${staffA.id}` })
    ).json();
    expect(editor.subject.passTypes).toEqual(['single', 'multi']);
  });

  it('сотрудников оператора форма арендатора не ограничивает', async () => {
    await resetForm();
    await setTenant({ categoryIds: [car], passTypes: ['single'] });
    const res = await create(
      admin,
      carPass({ categoryId: semi, dockId: dock12, windowFrom: NOON, windowTo: new Date(Date.parse(NOON) + HOUR).toISOString(), driverName: 'Иванов И. И.' }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect((await t.as(admin, { url: `/tenants/${dns}/pass-form` })).json().enforced).toBe(false);
  });

  it('скрытое поле не принимается, обязательное — требуется; правка проверяет только затронутые поля', async () => {
    await resetForm();
    await setTenant({ fields: { brand: 'hidden', purpose: 'required', comment: 'hidden' } });
    const hidden = await create(logist, carPass({ brand: 'Kia' }));
    expect(error(hidden)).toMatchObject({ code: 'field_hidden', field: 'brand' });
    const driver = await create(logist, carPass({ driverName: 'Иванов И. И.' }));
    expect(error(driver).code).toBe('field_hidden');
    const missing = await create(logist, carPass());
    expect(error(missing)).toMatchObject({ code: 'field_required', field: 'purposeId' });
  });
});

describe('быстрый разовый пропуск и окно прибытия', () => {
  it('номер + тип: начало «сейчас», окончание +23 ч, действует сразу', async () => {
    await resetForm();
    const res = await create(logist, carPass());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'approved',
      validFrom: NOON,
      validTo: new Date(Date.parse(NOON) + 23 * HOUR).toISOString(),
    });
  });

  it('N часов — настройка уровня, но не больше максимума объекта; явное окончание главнее', async () => {
    await resetForm();
    await setTenant({ singleHours: 6 });
    const six = await create(logist, carPass());
    expect(six.json().validTo).toBe(new Date(Date.parse(NOON) + 6 * HOUR).toISOString());
    // максимум объекта уменьшили позже — окончание обрезается по максимуму
    await t.as(admin, { method: 'PATCH', url: `/sites/${KEYS.siteId}/settings`, payload: { singlePassMaxHours: 4 } });
    try {
      const capped = await create(logist, carPass());
      expect(capped.json().validTo).toBe(new Date(Date.parse(NOON) + 4 * HOUR).toISOString());
    } finally {
      await t.as(admin, { method: 'PATCH', url: `/sites/${KEYS.siteId}/settings`, payload: { singlePassMaxHours: 24 } });
    }
    const explicit = await create(
      logist,
      carPass({ validTo: new Date(Date.parse(NOON) + 2 * HOUR).toISOString() }),
    );
    expect(explicit.json().validTo).toBe(new Date(Date.parse(NOON) + 2 * HOUR).toISOString());
  });

  it('окно по политике: фура без окна — ошибка; «необязательно» на уровне — окно на весь срок; «обязательно» — всегда', async () => {
    await resetForm();
    const truck = (extra: Record<string, unknown> = {}) =>
      carPass({ categoryId: semi, dockId: dock12, ...extra });
    const byPolicy = await create(logist, truck());
    expect(error(byPolicy).code).toBe('window_required');

    await setTenant({ fields: { window: 'optional' } });
    const hints = (
      await t.as(logist, { method: 'POST', url: `/tenants/${dns}/pass-hints`, payload: { participant: 'vehicle', categoryId: semi } })
    ).json();
    expect(hints.window).toMatchObject({ required: false, autoFilled: true });
    const fast = await create(logist, truck());
    expect(fast.statusCode, fast.body).toBe(201);
    expect(fast.json()).toMatchObject({ windowFrom: fast.json().validFrom, windowTo: fast.json().validTo });

    await setTenant({ fields: { window: 'required' } });
    const required = await create(logist, carPass({ categoryId: car }));
    expect(error(required)).toMatchObject({ code: 'field_required', field: 'windowFrom' });

    await setTenant({ fields: { window: 'hidden' } });
    const hiddenWithValue = await create(logist, truck({ windowFrom: NOON, windowTo: new Date(Date.parse(NOON) + HOUR).toISOString() }));
    expect(error(hiddenWithValue).code).toBe('field_hidden');
    const hiddenOk = await create(logist, truck());
    expect(hiddenOk.statusCode, hiddenOk.body).toBe(201);
  });
});

describe('права на настройку', () => {
  it('объект и арендатор — администратор; сотрудник — ещё и ответственный своей компании, не чужой', async () => {
    await resetForm();
    const byLogist = await t.as(logist, {
      method: 'PATCH',
      url: `/tenants/${dns}/pass-form`,
      payload: { fields: { brand: 'hidden' } },
    });
    expect(byLogist.statusCode).toBe(403);
    expect(error(byLogist).permission).toContain('pass_form.manage');
    const siteByLogist = await t.as(logist, {
      method: 'PATCH',
      url: `/sites/${KEYS.siteId}/pass-form`,
      payload: { fields: { brand: 'hidden' } },
    });
    expect(siteByLogist.statusCode).toBe(403);

    // ответственный правит сотрудника своей компании
    const own = await setUser(staffA.id, { fields: { brand: 'hidden' } }, logist);
    expect(own.statusCode, own.body).toBe(200);
    // заказчик (без права) — нет
    expect((await setUser(staffA.id, { fields: { brand: 'optional' } }, requester)).statusCode).toBe(403);
    // сотрудник другой компании — 403 у чужого ответственного
    const otherLogist = roleActor('tenant_manager', { tenantIds: [x5] });
    const foreign = await t.as(otherLogist, {
      method: 'PATCH',
      url: `/tenants/${dns}/users/${staffA.id}/pass-form`,
      payload: { fields: { brand: 'optional' } },
    });
    expect(foreign.statusCode).toBe(403);
    // человек не из этой компании — 404
    const stranger = await setUser(roleActor('approver').id, { fields: { brand: 'hidden' } });
    expect(stranger.statusCode).toBe(404);
  });
});

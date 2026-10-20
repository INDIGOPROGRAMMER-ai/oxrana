import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { PLATE_COUNTRIES } from '@oxrana/plates';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
 * Пропуска на демо-объекте: сценарии 19, 20, 22, 23, 36, 38, 41 (API-часть), пакет «создано N из M»
 * (B3), дубли (10_ §4), подсказки формы. Часы стоят на вторнике 10.03.2026 12:00 по объекту.
 */
let t: TestApp;
const id = (map: Record<string, string>, name: string) => map[name] ?? '';
const dns = id(KEYS.tenants, 'dns');
const semi = id(KEYS.categories, 'semi');
const lightTruck = id(KEYS.categories, 'light_truck');
const car = id(KEYS.categories, 'car');
const dock = (n: string) => id(KEYS.docks, n);
const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00+05:00`).toISOString();
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

const dnsLogist = roleActor('tenant_manager', { tenantIds: [dns] });
const dnsRequester = roleActor('tenant_requester', { tenantIds: [dns] });
const admin = roleActor('site_admin');
const approver = roleActor('approver');

let plateCounter = 100;
/** Уникальный номер для теста: пропуска одного арендатора на один номер — дубли. */
const nextPlate = () => `Н${++plateCounter}МС174`;

function truck(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: dns,
    passType: 'single',
    participant: 'vehicle',
    plate: nextPlate(),
    categoryId: semi,
    dockId: dock('12'),
    validFrom: at('12:00'),
    validTo: at('20:00'),
    windowFrom: at('12:00'),
    windowTo: at('14:00'),
    ...overrides,
  };
}

const create = (actor: typeof dnsLogist, payload: Record<string, unknown>) =>
  t.as(actor, { method: 'POST', url: '/passes', payload });

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  await windowFollowsPolicy(t);
});
afterAll(() => t.close());

describe('создание пропуска', () => {
  it('сценарий 36: номер «А123ВС174 » с пробелом в конце нормализован, пропуск создан', async () => {
    const res = await create(dnsLogist, truck({ plate: 'А123ВС174 ' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      plateRaw: 'А123ВС174',
      plateNorm: 'A123BC174',
      plateCountry: 'RU',
      status: 'approved',
    });
    expect(res.json().driverPageUrl).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
  });

  it('сценарий 38: грузовой пропуск ДНС без дока — «Укажите док. Ваши доки: 1–18, 66–72»', async () => {
    const res = await create(dnsLogist, truck({ dockId: undefined }));
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({
      code: 'dock_required',
      field: 'dockId',
      message: 'Укажите док. Ваши доки: 1–18, 66–72',
    });
    const foreign = await create(dnsLogist, truck({ dockId: dock('40') }));
    expect(error(foreign)).toMatchObject({ code: 'dock_not_assigned', field: 'dockId' });
  });

  it('сценарий 23: многоразовый от арендатора без комментария — «Укажите, для чего и зачем нужен пропуск»', async () => {
    const multi = truck({
      passType: 'multi',
      validTo: '2026-03-15T15:00:00.000Z',
      windowFrom: undefined,
      windowTo: undefined,
      categoryId: car,
      dockId: undefined,
    });
    const res = await create(dnsLogist, multi);
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({
      code: 'comment_required',
      field: 'comment',
      message: 'Укажите, для чего и зачем нужен пропуск.',
    });
    const ok = await create(dnsLogist, { ...multi, comment: 'Ревизия склада, 5 дней' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().status).toBe('pending_approval');
  });

  it('сценарий 22: «на сейчас» из другого пояса — без ошибки «начало в прошлом»; начало час назад — ошибка с временем объекта', async () => {
    // Администратор в Техасе: форма шлёт мгновение с его смещением; сервер сравнивает со своими часами.
    const now = await create(admin, truck({ validFrom: '2026-03-10T02:00:00-05:00' }));
    expect(now.statusCode).toBe(201);
    expect(now.json().validFrom).toBe(NOON);
    const past = await create(admin, truck({ validFrom: at('11:00'), windowFrom: at('11:00') }));
    expect(past.statusCode).toBe(422);
    expect(error(past)).toMatchObject({ code: 'starts_in_past', field: 'validFrom' });
    expect(error(past).message).toContain('10.03.2026 11:00, Челябинск, UTC+5');
  });

  it('окно обязательно для грузовых, кроме исключения X5 24/7; разовый — не дольше 24 ч', async () => {
    const noWindow = await create(dnsLogist, truck({ windowFrom: undefined, windowTo: undefined }));
    expect(error(noWindow)).toMatchObject({ code: 'window_required', field: 'windowFrom' });
    const x5 = await create(admin, {
      ...truck({ windowFrom: undefined, windowTo: undefined, dockId: id(KEYS.docks, 'З1') }),
      tenantId: id(KEYS.tenants, 'x5'),
    });
    expect(x5.statusCode).toBe(201);
    const long = await create(dnsLogist, truck({ validTo: '2026-03-12T07:00:00.000Z' }));
    expect(error(long)).toMatchObject({ code: 'invalid_period', field: 'validTo' });
  });

  it('тип с лимитом 0 не оформляется: «не предусмотрен договором»', async () => {
    const res = await create(admin, {
      ...truck({ dockId: undefined }),
      tenantId: id(KEYS.tenants, 'kontinent'),
    });
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({ code: 'category_unavailable', field: 'categoryId' });
    expect(error(res).message).toMatch(/лимит 0/);
  });

  it('дубль у того же арендатора — ошибка со ссылкой на пропуск; у другого — предупреждение', async () => {
    const plate = nextPlate();
    const first = await create(dnsLogist, truck({ plate }));
    expect(first.statusCode).toBe(201);
    const dup = await create(dnsLogist, truck({ plate }));
    expect(dup.statusCode).toBe(409);
    expect(error(dup)).toMatchObject({
      code: 'pass_duplicate',
      details: { passId: first.json().id },
    });
    const other = await create(admin, {
      ...truck({ plate, dockId: id(KEYS.docks, '20') }),
      tenantId: id(KEYS.tenants, 'relief'),
    });
    expect(other.statusCode).toBe(201);
    expect(other.json().warnings).toEqual([
      expect.objectContaining({ code: 'same_plate_other_tenant' }),
    ]);
  });

  it('политика «запрещено» — ошибка со ссылкой на настройку; чужой арендатор — 403', async () => {
    const policy = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/approval-policies`,
      payload: { tenantId: dns, creatorKind: 'tenant', passType: 'permanent', mode: 'deny' },
    });
    expect(policy.statusCode).toBe(201);
    const res = await create(
      dnsLogist,
      truck({
        passType: 'permanent',
        validTo: null,
        categoryId: car,
        dockId: undefined,
        windowFrom: undefined,
        windowTo: undefined,
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(error(res)).toMatchObject({
      code: 'pass_type_forbidden',
      settingLink: '/admin/rules/approval-policies',
    });
    expect(error(res).message).toBe(
      'Политика «Арендатор → Постоянный» = Запрещено. Изменить: Настройки → Политики согласования.',
    );
    const foreign = await create(dnsLogist, { ...truck(), tenantId: id(KEYS.tenants, 'x5') });
    expect(foreign.statusCode).toBe(403);
  });

  it('страны номера в contracts совпадают с @oxrana/plates', async () => {
    const { PlateCountryHintSchema } = await import('@oxrana/contracts');
    expect([...PlateCountryHintSchema.options]).toEqual([...PLATE_COUNTRIES]);
  });
});

describe('правка пропуска', () => {
  async function startedTruck(): Promise<string> {
    const res = await create(dnsLogist, truck());
    t.clock.advance(60 * 60_000); // пропуск начался час назад
    return res.json().id;
  }

  it('сценарий 19: правка комментария у начавшегося пропуска на фуру — меняется только комментарий', async () => {
    const passId = await startedTruck();
    try {
      const noReason = await t.as(dnsLogist, {
        method: 'PATCH',
        url: `/passes/${passId}`,
        payload: { comment: 'Водитель позвонит за 10 минут' },
      });
      expect(error(noReason)).toMatchObject({ code: 'reason_required', field: 'reason' });
      const res = await t.as(dnsLogist, {
        method: 'PATCH',
        url: `/passes/${passId}`,
        payload: { comment: 'Водитель позвонит за 10 минут', reason: 'Уточнение для охраны' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ applied: ['comment'], changeRequest: null });
      expect(res.json().pass).toMatchObject({
        categoryId: semi,
        comment: 'Водитель позвонит за 10 минут',
      });
      const [audit] = await ownerDb()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityId, passId), eq(schema.auditLog.action, 'update')));
      expect(Object.keys(audit?.diff as object)).toEqual(['comment']);
    } finally {
      t.clock.set(NOON);
    }
  });

  it('сценарий 20: исправление опечатки в номере машины на воротах — с причиной, в журнале «было → стало»', async () => {
    const passId = await startedTruck();
    try {
      const before = (await t.as(admin, { url: `/passes/${passId}` })).json();
      const res = await t.as(admin, {
        method: 'PATCH',
        url: `/passes/${passId}`,
        payload: { plate: 'Н999МС174', reason: 'Опечатка в номере, водитель на воротах' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().pass.plateNorm).toBe('H999MC174');
      const history = await t.as(dnsLogist, { url: `/passes/${passId}/history` });
      const update = history.json().items.find((e: { kind: string }) => e.kind === 'updated');
      expect(update).toMatchObject({
        reason: 'Опечатка в номере, водитель на воротах',
        actor: { kind: 'user', name: 'Тестовый site_admin' },
        changes: [{ field: 'plateRaw', label: 'Номер', from: before.plateRaw, to: 'Н999МС174' }],
      });
      // технические поля («нормализованный номер») в ленте не показываются
      expect(update.changes.map((c: { field: string }) => c.field)).not.toContain('plateNorm');
    } finally {
      t.clock.set(NOON);
    }
  });

  it('сценарий 41: арендатор правит номер в одобренном многоразовом — уходит заявка; пропуск тот же, история сохранена', async () => {
    const created = await create(admin, {
      ...truck({
        passType: 'multi',
        validTo: '2026-03-14T15:00:00.000Z',
        categoryId: car,
        dockId: undefined,
        windowFrom: undefined,
        windowTo: undefined,
      }),
      comment: 'Служебная машина',
    });
    expect(created.json().status).toBe('approved');
    const passId = created.json().id;
    t.clock.advance(2 * 60 * 60_000);
    try {
      const res = await t.as(dnsRequester, {
        method: 'PATCH',
        url: `/passes/${passId}`,
        payload: { plate: 'В777ОР174', reason: 'Машину заменили' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ applied: [], changeRequest: { status: 'pending' } });
      expect(res.json().pass.plateNorm).toBe(created.json().plateNorm);

      const queue = await t.as(approver, {
        url: `/sites/${KEYS.siteId}/change-requests?status=pending`,
      });
      const request = queue.json().items.find((r: { passId: string }) => r.passId === passId);
      expect(request.changes.plateNorm).toEqual({
        from: created.json().plateNorm,
        to: 'B777OP174',
      });

      const approved = await t.as(approver, {
        method: 'POST',
        url: `/change-requests/${request.id}/approve`,
        payload: { note: 'Согласовано' },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().pass).toMatchObject({
        id: passId,
        plateNorm: 'B777OP174',
        status: 'approved',
      });

      const history = (await t.as(dnsRequester, { url: `/passes/${passId}/history` })).json().items;
      expect(history.map((e: { kind: string }) => e.kind).reverse()).toEqual([
        'created',
        'change_requested',
        'updated',
        'change_approved',
      ]);
      const again = await t.as(approver, {
        method: 'POST',
        url: `/change-requests/${request.id}/approve`,
        payload: {},
      });
      expect(error(again).code).toBe('change_request_closed');
    } finally {
      t.clock.set(NOON);
    }
  });

  it('тот же номер в другой записи — не изменение: заявки нет, пропуск не меняется', async () => {
    const created = await create(admin, {
      ...truck({
        passType: 'multi',
        plate: 'А555ВС174',
        validTo: '2026-03-14T15:00:00.000Z',
        categoryId: car,
        dockId: undefined,
        windowFrom: undefined,
        windowTo: undefined,
      }),
      comment: 'Служебная машина',
    });
    t.clock.advance(60 * 60_000);
    try {
      const res = await t.as(dnsRequester, {
        method: 'PATCH',
        url: `/passes/${created.json().id}`,
        payload: { plate: 'a555bc 174', reason: 'Переписали номер' },
      });
      expect(res.json()).toMatchObject({ applied: [], changeRequest: null });
      expect(res.json().pass.plateRaw).toBe('А555ВС174');
    } finally {
      t.clock.set(NOON);
    }
  });

  it('у не начавшегося пропуска арендатор правит сам; заказчик без права правки — 403', async () => {
    const passId = (
      await create(
        dnsLogist,
        truck({
          validFrom: at('15:00'),
          validTo: at('20:00'),
          windowFrom: at('15:00'),
          windowTo: at('16:00'),
        }),
      )
    ).json().id;
    const own = await t.as(dnsLogist, {
      method: 'PATCH',
      url: `/passes/${passId}`,
      payload: { dockId: dock('13') },
    });
    expect(own.json()).toMatchObject({ applied: ['dockId'], changeRequest: null });
    const requester = await t.as(dnsRequester, {
      method: 'PATCH',
      url: `/passes/${passId}`,
      payload: { comment: 'другое' },
    });
    expect(requester.statusCode).toBe(403);
    expect(error(requester).permission).toBe('pass.edit');
  });

  it('отмена: статус «отменён», правка после отмены невозможна', async () => {
    const passId = (await create(dnsLogist, truck())).json().id;
    const res = await t.as(dnsLogist, {
      method: 'POST',
      url: `/passes/${passId}/cancel`,
      payload: { reason: 'Поставка перенесена' },
    });
    expect(res.json()).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'Поставка перенесена',
    });
    const patch = await t.as(dnsLogist, {
      method: 'PATCH',
      url: `/passes/${passId}`,
      payload: { comment: 'x' },
    });
    expect(error(patch).code).toBe('pass_not_editable');
  });
});

describe('пакетное создание (B3)', () => {
  function rows() {
    const ok = [
      ...Array.from({ length: 12 }, (_, i) => ({ category: semi, dock: String(i + 1) })),
      ...Array.from({ length: 6 }, (_, i) => ({ category: lightTruck, dock: String(66 + i) })),
    ].map(({ category, dock: d }) => {
      const { tenantId: _t, ...row } = truck({ categoryId: category, dockId: dock(d) });
      return row;
    });
    const { tenantId: _a, ...noDock } = truck({ dockId: undefined });
    const { tenantId: _b, ...noPlate } = truck({ plate: '  ' });
    return [...ok.slice(0, 5), noDock, ...ok.slice(5), noPlate];
  }

  it('API-часть сценария 18 (B3): 20 строк, 2 с ошибками — предпросмотр «будет создано 18 из 20», затем «создано 18 из 20»', async () => {
    const batch = rows();
    const preview = await t.as(dnsLogist, {
      method: 'POST',
      url: '/passes/batch',
      payload: { tenantId: dns, rows: batch, dryRun: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      batchId: null,
      total: 20,
      created: 18,
      summary: 'Будет создано 18 из 20',
    });
    expect(preview.json().errors).toEqual([
      expect.objectContaining({ row: 6, field: 'dockId', code: 'dock_required' }),
      expect.objectContaining({ row: 20, field: 'plate', code: 'plate_required' }),
    ]);
    const before = await ownerDb().select({ id: schema.passes.id }).from(schema.passes);

    const saved = await t.as(dnsLogist, {
      method: 'POST',
      url: '/passes/batch',
      payload: { tenantId: dns, rows: batch },
    });
    expect(saved.json()).toMatchObject({
      dryRun: false,
      total: 20,
      created: 18,
      summary: 'Создано 18 из 20',
    });
    const after = await ownerDb().select({ id: schema.passes.id }).from(schema.passes);
    expect(after.length - before.length).toBe(18);
    const [stored] = await ownerDb()
      .select()
      .from(schema.passBatches)
      .where(eq(schema.passBatches.id, saved.json().batchId));
    expect(stored).toMatchObject({ total: 20, created: 18 });
  });

  it('один номер дважды в пакете — второй дубль, первый создан', async () => {
    const plate = nextPlate();
    const row = () => {
      const { tenantId: _t, ...r } = truck({ plate });
      return r;
    };
    const res = await t.as(dnsLogist, {
      method: 'POST',
      url: '/passes/batch',
      payload: { tenantId: dns, rows: [row(), row()] },
    });
    expect(res.json()).toMatchObject({ created: 1, summary: 'Создано 1 из 2' });
    expect(res.json().errors).toEqual([
      expect.objectContaining({ row: 2, code: 'pass_duplicate' }),
    ]);
  });
});

describe('подсказки формы и видимость', () => {
  it('фура ДНС: «Фура → КПП-2», лимит грузовых, согласование, доки, окно', async () => {
    const res = await t.as(dnsLogist, {
      url: `/tenants/${dns}/pass-hints?participant=vehicle&categoryId=${semi}&passType=single`,
    });
    expect(res.statusCode).toBe(200);
    const hints = res.json();
    expect(hints.route.text).toBe('Фура → КПП-2');
    expect(hints.quotas).toEqual([expect.objectContaining({ name: 'Грузовые', capacity: 25 })]);
    expect(hints.approval.mode).toBe('allow');
    expect(hints.dock).toMatchObject({ required: true, text: 'Ваши доки: 1–18, 66–72' });
    expect(hints.window).toMatchObject({
      required: true,
      earlyToleranceMin: 0,
      lateToleranceMin: 60,
    });
    expect(hints.passTypes.map((p: { passType: string }) => p.passType)).toEqual([
      'single',
      'multi',
    ]);
  });

  it('Континент: фуры и грузовые свыше 5 т в списке типов не показываются (лимит 0)', async () => {
    const kontinent = id(KEYS.tenants, 'kontinent');
    const res = await t.as(roleActor('tenant_manager', { tenantIds: [kontinent] }), {
      url: `/tenants/${kontinent}/pass-hints?participant=vehicle`,
    });
    const names = res.json().categories.map((c: { name: string }) => c.name);
    expect(names).toEqual(['легковой', 'малотоннажный']);
  });

  it('арендатор видит только свои пропуска; чужой пропуск — 403', async () => {
    const x5Pass = await create(admin, {
      ...truck({ windowFrom: undefined, windowTo: undefined, dockId: id(KEYS.docks, 'З2') }),
      tenantId: id(KEYS.tenants, 'x5'),
    });
    const list = await t.as(dnsLogist, { url: `/sites/${KEYS.siteId}/passes?limit=500` });
    expect(list.json().items.every((p: { tenantId: string }) => p.tenantId === dns)).toBe(true);
    const foreign = await t.as(dnsLogist, { url: `/passes/${x5Pass.json().id}` });
    expect(foreign.statusCode).toBe(403);
    const search = await t.as(admin, { url: `/sites/${KEYS.siteId}/passes?q=123` });
    expect(search.json().items.map((p: { plateNorm: string }) => p.plateNorm)).toContain(
      'A123BC174',
    );
  });
});

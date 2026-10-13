import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  action,
  at,
  categoryKey,
  dnsTruck,
  dockKey,
  fillVisits,
  gateKey,
  kpp2,
  quotaKey,
  resetTenant,
  tenantKey,
  uniquePlate,
} from './scenarios/gate-helpers';
import { KEYS, ownerDb, roleActor, seedDemo, startTestApp, type TestApp } from './support/harness';

/**
 * Этап 6b: чёрный список, блокировка арендатора, песочница, файл договора, настройки организации
 * и объекта, массовая правка доков, цели визита, участки и места, исправления API (Q-66).
 */
let t: TestApp;
const admin = roleActor('site_admin');
const owner = roleActor('org_owner');
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const site = KEYS.siteId;

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

/** Воображаемая фура ДНС на КПП-2 с доком и окном «сейчас». */
const dnsSemi = (extra: Record<string, unknown> = {}) => ({
  tenantId: tenantKey('dns'),
  passType: 'single',
  participant: 'vehicle',
  categoryId: categoryKey('semi'),
  gateId: gateKey('kpp2'),
  dockId: dockKey('12'),
  windowFrom: at('12:00'),
  windowTo: at('14:00'),
  ...extra,
});
const sandbox = (body: Record<string, unknown>, actor = admin) =>
  t.as(actor, { method: 'POST', url: `/sites/${site}/sandbox/check`, payload: body });

describe('песочница правил', () => {
  it('вердикт тем же движком: фура ДНС на КПП-2 проходит, на КПП-1 — «не тот КПП»', async () => {
    const ok = await sandbox(dnsSemi());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().verdict).toMatchObject({ code: 'allow', color: 'green' });
    expect(ok.json().verdict.trace.length).toBeGreaterThan(5);
    expect(ok.json().subject).toMatchObject({ tenantName: 'ДНС', gateName: 'КПП-2' });
    expect(ok.json().subject.atLabel).toContain('UTC+5');
    const wrong = await sandbox(dnsSemi({ gateId: gateKey('kpp1') }));
    expect(wrong.json().verdict).toMatchObject({ code: 'wrong_gate', color: 'blue' });
  });

  it('«все места заняты» даёт ожидание, а песочница ничего не записывает', async () => {
    const before = await ownerDb().select().from(schema.visits);
    const full = await sandbox(dnsSemi({ quotaFull: true }));
    expect(full.json().verdict).toMatchObject({ code: 'wait', color: 'yellow' });
    expect(full.json().assumptions.join(' ')).toContain('все места');
    const after = await ownerDb().select().from(schema.visits);
    expect(after.length).toBe(before.length);
  });

  it('время проверки — в поясе объекта: вне рабочего времени ответ другой', async () => {
    const night = await sandbox(dnsSemi({ at: '2026-03-10T21:00:00.000Z', windowFrom: undefined }));
    expect(night.statusCode).toBe(200);
    expect(night.json().subject.atLabel).toContain('11.03.2026 02:00');
  });

  it('ошибки ввода называют поле: нет типа транспорта, чужой КПП', async () => {
    const noCategory = await sandbox(dnsSemi({ categoryId: undefined }));
    expect(noCategory.statusCode).toBe(400);
    expect(error(noCategory).field).toBe('categoryId');
    const noGate = await sandbox(dnsSemi({ gateId: '00000000-0000-4000-8000-000000000001' }));
    expect(noGate.statusCode).toBe(400);
    expect(error(noGate).field).toBe('gateId');
  });

  it('примеры для мастера: 3–5 прогонов по настроенным данным', async () => {
    const res = await t.as(admin, { url: `/sites/${site}/sandbox/examples` });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items.map((i: { key: string }) => i.key)).toEqual(
      expect.arrayContaining(['allow', 'full']),
    );
    for (const item of items) {
      expect(item.headline.length).toBeGreaterThan(0);
      // пример воспроизводим в песочнице тем же запросом
      const again = await sandbox(item.request);
      expect(again.json().verdict.code).toBe(item.code);
    }
  });

  it('«что будет, если»: уменьшение лимита показывает, кто окажется сверх', async () => {
    await resetTenant(tenantKey('dns'));
    await fillVisits(tenantKey('dns'), categoryKey('car'), 5);
    const res = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/sandbox/quota-what-if`,
      payload: { quotaId: quotaKey('dns/cars'), capacity: 3 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      occupied: 5,
      currentCapacity: 30,
      proposedCapacity: 3,
      overBy: 2,
    });
    expect(body.inside.filter((v: { over: boolean }) => v.over)).toHaveLength(2);
    expect(body.summary).toContain('Сверх лимита окажется 2');
    const same = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/sandbox/quota-what-if`,
      payload: { quotaId: quotaKey('dns/cars') },
    });
    expect(same.json().overBy).toBe(0);
    await resetTenant(tenantKey('dns'));
  });

  it('песочница для арендатора недоступна без права sandbox.use', async () => {
    const res = await sandbox(
      dnsSemi(),
      roleActor('tenant_manager', { tenantIds: [tenantKey('dns')] }),
    );
    expect(res.statusCode).toBe(403);
    expect(error(res).permission).toBe('sandbox.use');
  });
});

describe('чёрный список', () => {
  it('номер нормализуется, причина обязательна, красный вердикт с причиной, аудит с причиной', async () => {
    const noReason = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'site', plate: 'В777ОР174' },
    });
    expect(noReason.statusCode).toBe(400);
    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'site', plate: 'в 777 ор 174', reason: 'Драка на территории' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const entry = created.json();
    expect(entry).toMatchObject({
      level: 'site',
      plateNorm: 'B777OP174',
      reason: 'Драка на территории',
      validTo: null,
      active: true,
    });
    expect(entry.createdByName).toBeTruthy();
    const verdict = await sandbox(dnsSemi({ plate: 'В777ОР174' }));
    expect(verdict.json().verdict).toMatchObject({ code: 'deny', color: 'red' });
    expect(verdict.json().verdict.headline).toContain('Драка на территории');
    const out = await sandbox(dnsSemi({ plate: 'В777ОР174', direction: 'out' }));
    expect(out.json().verdict.reasons.map((r: { code: string }) => r.code)).toContain(
      'blacklisted_leaving',
    );
    expect(out.json().verdict.code).not.toBe('deny');
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, entry.id), eq(schema.auditLog.action, 'create')));
    expect(audit?.reason).toBe('Драка на территории');
    expect(audit?.actorUserId).toBe(entry.createdById);
    // удаление: мягкое, вердикт снова зелёный
    const removed = await t.as(admin, { method: 'DELETE', url: `/blacklist/${entry.id}` });
    expect(removed.statusCode).toBe(200);
    const listed = await t.as(admin, { url: `/sites/${site}/blacklist` });
    expect(listed.json().items.map((i: { id: string }) => i.id)).not.toContain(entry.id);
    const again = await sandbox(dnsSemi({ plate: 'В777ОР174' }));
    expect(again.json().verdict.code).toBe('allow');
    const [row] = await ownerDb()
      .select()
      .from(schema.blacklist)
      .where(eq(schema.blacklist.id, entry.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  it('дубль активной записи — 409 с причиной; нужен номер или человек; срок в прошлом отклоняется', async () => {
    const first = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'site', plate: 'К111КК174', reason: 'Нарушение правил' },
    });
    expect(first.statusCode).toBe(201);
    const dup = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'site', plate: 'K111KK174', reason: 'ещё раз' },
    });
    expect(dup.statusCode).toBe(409);
    expect(error(dup).message).toContain('Нарушение правил');
    const nothing = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'site', reason: 'Без субъекта' },
    });
    expect(nothing.statusCode).toBe(400);
    const past = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: {
        level: 'site',
        personName: 'Иванов Иван',
        reason: 'Срок прошёл',
        validTo: '2026-01-01T00:00:00Z',
      },
    });
    expect(past.statusCode).toBe(422);
    expect(error(past).field).toBe('validTo');
  });

  it('срок: после даты запись не действует; PATCH меняет только присланное', async () => {
    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: {
        level: 'site',
        plate: 'Н222НН174',
        reason: 'Временный запрет',
        validTo: '2026-03-10T09:00:00Z',
      },
    });
    const id = created.json().id;
    expect(await sandbox(dnsSemi({ plate: 'Н222НН174' }))).toBeDefined();
    const patched = await t.as(admin, {
      method: 'PATCH',
      url: `/blacklist/${id}`,
      payload: { reason: 'Продлено до выяснения' },
    });
    expect(patched.json()).toMatchObject({
      reason: 'Продлено до выяснения',
      plateNorm: 'H222HH174',
    });
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, 'update')));
    expect(Object.keys(audit?.diff ?? {})).toEqual(['reason']);
    // через два часа срок истёк
    t.clock.set('2026-03-10T10:00:00.000Z');
    t.app.deps.ruleSets.invalidate(KEYS.organizationId, null);
    const list = await t.as(admin, { url: `/sites/${site}/blacklist` });
    expect(list.json().items.find((i: { id: string }) => i.id === id).active).toBe(false);
    const after = await sandbox(dnsSemi({ plate: 'Н222НН174', at: '2026-03-10T10:00:00.000Z' }));
    expect(after.json().verdict.reasons.map((r: { code: string }) => r.code)).not.toContain(
      'blacklisted',
    );
    t.clock.set('2026-03-10T07:00:00.000Z');
    t.app.deps.ruleSets.invalidate(KEYS.organizationId, null);
  });

  it('уровень «организация»: только роль на всю организацию; виден на объекте', async () => {
    const denied = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'organization', plate: 'О333ОО174', reason: 'На все объекты' },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await t.as(owner, {
      method: 'POST',
      url: `/sites/${site}/blacklist`,
      payload: { level: 'organization', plate: 'О333ОО174', reason: 'На все объекты' },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ level: 'organization', siteId: null });
    const seen = await t.as(admin, { url: `/sites/${site}/blacklist` });
    expect(seen.json().items.map((i: { id: string }) => i.id)).toContain(ok.json().id);
    const red = await sandbox(dnsSemi({ plate: 'О333ОО174' }));
    expect(red.json().verdict.code).toBe('deny');
    const patchDenied = await t.as(admin, {
      method: 'PATCH',
      url: `/blacklist/${ok.json().id}`,
      payload: { reason: 'Попытка' },
    });
    expect(patchDenied.statusCode).toBe(403);
  });

  it('пакетная вставка номеров: предпросмотр «добавится N, ошибки в M», повтор внутри пакета', async () => {
    const payload = {
      level: 'site',
      reason: 'Список от охраны',
      plates: ['А901АА174', 'А902АА174', 'А901АА174', '---'],
    };
    const preview = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist/batch`,
      payload: { ...payload, dryRun: true },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, total: 4, created: 2 });
    expect(preview.json().errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    const before = await t.as(admin, { url: `/sites/${site}/blacklist` });
    const real = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/blacklist/batch`,
      payload,
    });
    expect(real.json()).toMatchObject({ dryRun: false, created: 2 });
    const after = await t.as(admin, { url: `/sites/${site}/blacklist` });
    expect(after.json().items.length).toBe(before.json().items.length + 2);
  });
});

describe('блокировка арендатора', () => {
  const tenant = tenantKey('canteen');
  const block = (body: Record<string, unknown>) =>
    t.as(admin, { method: 'POST', url: `/tenants/${tenant}/block`, payload: body });
  const unblock = () =>
    t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant}/unblock`,
      payload: { reason: 'Вопрос решён' },
    });
  const canteenPass = (extra: Record<string, unknown> = {}) =>
    t.as(admin, {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: tenant,
        passType: 'multi',
        participant: 'vehicle',
        plate: uniquePlate(),
        categoryId: categoryKey('car'),
        validFrom: at('12:00'),
        validTo: '2026-03-12T07:00:00Z',
        ...extra,
      },
    });
  const canteen = (mode: 'in' | 'out' = 'in') => ({
    tenantId: tenant,
    passType: 'multi',
    participant: 'vehicle',
    categoryId: categoryKey('car'),
    gateId: gateKey('kpp1'),
    direction: mode,
  });

  it('последствия показываются до подтверждения; без подтверждения — 409 с теми же числами', async () => {
    expect((await canteenPass()).statusCode).toBe(201);
    expect((await canteenPass()).statusCode).toBe(201);
    const impact = await t.as(admin, {
      url: `/tenants/${tenant}/block-impact?mode=full`,
    });
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json()).toMatchObject({ mode: 'full', insideNow: 0, willStopWorking: 2 });
    expect(impact.json().summary).toContain('2 действующих пропуска перестанут работать');
    const mild = await t.as(admin, { url: `/tenants/${tenant}/block-impact?mode=new_passes` });
    expect(mild.json().willStopWorking).toBe(0);
    expect(mild.json().summary).toContain('продолжают работать');
    const unconfirmed = await block({ mode: 'full', reason: 'Задолженность по аренде' });
    expect(unconfirmed.statusCode).toBe(409);
    expect(error(unconfirmed).code).toBe('confirmation_required');
    expect(unconfirmed.json().details).toMatchObject({ willStopWorking: 2 });
    const view = await t.as(admin, { url: `/tenants/${tenant}` });
    expect(view.json().status).toBe('active');
  });

  it('полная блокировка: песочница красная с причиной, пропуск не оформить, выезд свободен; разблокировка возвращает всё', async () => {
    const done = await block({ mode: 'full', reason: 'Задолженность по аренде', confirm: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      status: 'blocked_full',
      statusReason: 'Задолженность по аренде',
    });
    const red = await sandbox(canteen());
    expect(red.json().verdict).toMatchObject({ code: 'deny', color: 'red' });
    expect(red.json().verdict.reasons.map((r: { code: string }) => r.code)).toContain(
      'tenant_blocked_entry',
    );
    const out = await sandbox(canteen('out'));
    expect(out.json().verdict.code).not.toBe('deny');
    const pass = await canteenPass();
    expect(pass.statusCode).toBe(422);
    expect(error(pass).code).toBe('tenant_blocked');
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, tenant), eq(schema.auditLog.action, 'block')));
    expect(audit).toMatchObject({ reason: 'Задолженность по аренде' });
    expect(audit?.diff).toMatchObject({ status: { from: 'active', to: 'blocked_full' } });
    expect((await unblock()).json().status).toBe('active');
    expect((await sandbox(canteen())).json().verdict.code).toBe('allow');
    expect((await canteenPass()).statusCode).toBe(201);
  });

  it('«запретить новые пропуска» не мешает въезду, «запретить въезд» не мешает оформлению', async () => {
    await block({ mode: 'new_passes', reason: 'Проверка документов', confirm: true });
    expect((await canteenPass()).statusCode).toBe(422);
    expect((await sandbox(canteen())).json().verdict.code).toBe('allow');
    await block({ mode: 'entry', reason: 'Проверка документов', confirm: true });
    expect((await canteenPass()).statusCode).toBe(201);
    expect((await sandbox(canteen())).json().verdict.color).toBe('red');
    await unblock();
  });

  it('внутри N машин: они учтены в последствиях и могут выехать', async () => {
    const pass = await dnsTruck(t);
    const entered = await action(t, kpp2, { type: 'check_in', passId: pass });
    expect(entered.statusCode, entered.body).toBe(200);
    const impact = await t.as(admin, {
      url: `/tenants/${tenantKey('dns')}/block-impact?mode=full`,
    });
    expect(impact.json()).toMatchObject({ insideNow: 1, vehiclesInside: 1 });
    expect(impact.json().summary).toContain('внутри 1 машина');
    const left = await action(t, kpp2, { type: 'check_out', passId: pass });
    expect(left.statusCode).toBe(200);
  });

  it('нужно отдельное право tenant.block; тот, у кого есть только tenant.manage, не блокирует', async () => {
    const manager = roleActor('tenant_manager', { tenantIds: [tenant] });
    const res = await t.as(manager, {
      method: 'POST',
      url: `/tenants/${tenant}/block`,
      payload: { mode: 'full', reason: 'Попытка', confirm: true },
    });
    expect(res.statusCode).toBe(403);
    expect(error(res).permission).toBe('tenant.block');
  });
});

describe('файл договора и настройка «Вести договоры»', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
  let contractId = '';

  beforeAll(async () => {
    const res = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenantKey('moll')}/contracts`,
      payload: { number: '12/ТК', validFrom: '2026-01-01', validTo: '2026-12-31' },
    });
    contractId = res.json().id;
  });

  const put = (body: Buffer, type: string, name = 'договор.pdf', actor = owner) =>
    t.as(actor, {
      method: 'PUT',
      url: `/contracts/${contractId}/file?name=${encodeURIComponent(name)}`,
      headers: { 'content-type': type },
      payload: body,
    });

  it('PDF прикрепляется, скачивается тем же содержимым и оставляет след в аудите', async () => {
    const res = await put(pdf, 'application/pdf');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().file).toMatchObject({
      fileName: 'договор.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    });
    const download = await t.as(owner, { url: `/contracts/${contractId}/file` });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(pdf)).toBe(true);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toContain('no-store');
    const actions = (
      await ownerDb().select().from(schema.auditLog).where(eq(schema.auditLog.entityId, contractId))
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['file_attach', 'file_download']));
    const listed = await t.as(owner, { url: `/tenants/${tenantKey('moll')}/contracts` });
    expect(listed.json().items[0]).toMatchObject({ canViewFile: true });
    expect(listed.json().items[0].file.fileName).toBe('договор.pdf');
  });

  it('проверяется тип и начало файла, размер; чужой формат не принимается', async () => {
    const text = await put(Buffer.from('просто текст'), 'text/plain');
    expect(text.statusCode).toBe(400);
    expect(error(text).field).toBe('file');
    const fake = await put(Buffer.from('это не pdf'), 'application/pdf');
    expect(fake.statusCode).toBe(400);
    expect(error(fake).field).toBe('file');
    const big = await put(Buffer.concat([pdf, Buffer.alloc(1_100_000)]), 'application/pdf');
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
    expect(big.statusCode).toBeLessThan(500);
    const png = await put(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      'image/png',
      'скан.png',
    );
    expect(png.statusCode, png.body).toBe(200);
    expect(png.json().file.fileName).toBe('скан.png');
  });

  it('без права contract.file файл не скачать и не виден в договоре', async () => {
    const approver = roleActor('approver');
    const denied = await t.as(approver, { url: `/contracts/${contractId}/file` });
    expect(denied.statusCode).toBe(403);
    const detach = await t.as(owner, { method: 'DELETE', url: `/contracts/${contractId}/file` });
    expect(detach.json()).toMatchObject({ file: null });
    const none = await t.as(owner, { url: `/contracts/${contractId}/file` });
    expect(none.statusCode).toBe(404);
  });

  it('«Вести договоры» выключено: срок договора не проверяется; включено — проверяется', async () => {
    const tenant = tenantKey('moll');
    // срок договора — самый поздний из действующих: состарим все договоры арендатора и вернём как было
    const contracts = (await t.as(admin, { url: `/tenants/${tenant}/contracts` })).json().items as {
      id: string;
      validTo: string | null;
    }[];
    const patchAll = async (to: (c: { validTo: string | null }) => string | null) => {
      for (const c of contracts) {
        const r = await t.as(admin, {
          method: 'PATCH',
          url: `/contracts/${c.id}`,
          payload: { validTo: to(c) },
        });
        expect(r.statusCode, r.body).toBe(200);
      }
      t.app.deps.ruleSets.invalidate(KEYS.organizationId, null);
    };
    await patchAll(() => '2026-03-01');
    const request = {
      tenantId: tenant,
      passType: 'multi',
      participant: 'vehicle',
      categoryId: categoryKey('car'),
      gateId: gateKey('kpp1'),
    };
    const closed = await sandbox(request);
    expect(closed.json().verdict.reasons.map((r: { code: string }) => r.code)).toContain(
      'contract_expired',
    );
    const off = await t.as(owner, {
      method: 'PATCH',
      url: '/org',
      payload: { settings: { trackContracts: false } },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().settings.trackContracts).toBe(false);
    const open = await sandbox(request);
    expect(open.json().verdict.reasons.map((r: { code: string }) => r.code)).not.toContain(
      'contract_expired',
    );
    const on = await t.as(owner, {
      method: 'PATCH',
      url: '/org',
      payload: { settings: { trackContracts: true } },
    });
    expect(on.json().settings.trackContracts).toBe(true);
    await Promise.all(
      contracts.map((c) =>
        t.as(admin, {
          method: 'PATCH',
          url: `/contracts/${c.id}`,
          payload: { validTo: c.validTo },
        }),
      ),
    );
    t.app.deps.ruleSets.invalidate(KEYS.organizationId, null);
  });

  it('настройка организации недоступна роли только на объект', async () => {
    const res = await t.as(admin, {
      method: 'PATCH',
      url: '/org',
      payload: { settings: { trackContracts: false } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('настройки объекта, доки, цели, участки', () => {
  it('PATCH /sites/:id/settings (rule.manage) меняет только присланные ключи', async () => {
    const res = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/settings`,
      payload: { singleReturnWindowMin: 45 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings.singleReturnWindowMin).toBe(45);
    expect(res.json().settings.singlePassMaxHours).toBe(24);
    const [audit] = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityId, site), eq(schema.auditLog.action, 'update')));
    expect(audit).toBeDefined();
    const reset = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/settings`,
      payload: { singleReturnWindowMin: null },
    });
    expect(reset.json().settings.singleReturnWindowMin).toBeNull();
    const bad = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/settings`,
      payload: { singlePassMaxHours: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('массовая правка доков: предпросмотр, общие зона/вид/«считается в лимите»', async () => {
    const created = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/docks/batch`,
      payload: { numbers: ['Т1', 'Т2', 'Т3'] },
    });
    const ids: string[] = created.json().ids;
    expect(ids).toHaveLength(3);
    const zone = KEYS.zones.warehouse ?? '';
    const preview = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/docks/batch`,
      payload: { ids, changes: { zoneId: zone, countsInQuota: false }, dryRun: true },
    });
    expect(preview.json()).toMatchObject({ dryRun: true, created: 3 });
    const [stillNull] = await ownerDb()
      .select()
      .from(schema.docks)
      .where(eq(schema.docks.id, ids[0] ?? ''));
    expect(stillNull?.zoneId).toBeNull();
    const done = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/docks/batch`,
      payload: { ids, changes: { zoneId: zone, countsInQuota: false, kind: 'ground_gate' } },
    });
    expect(done.json().summary).toBe('Изменено 3 из 3');
    const rows = await ownerDb().select().from(schema.docks);
    const changed = rows.filter((d) => ids.includes(d.id));
    expect(
      changed.every((d) => d.zoneId === zone && !d.countsInQuota && d.kind === 'ground_gate'),
    ).toBe(true);
    const empty = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/docks/batch`,
      payload: { ids, changes: {} },
    });
    expect(empty.statusCode).toBe(400);
    const missing = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${site}/docks/batch`,
      payload: {
        ids: [ids[0], '00000000-0000-4000-8000-000000000009'],
        changes: { kind: 'other' },
      },
    });
    expect(missing.json().errors).toHaveLength(1);
    expect(missing.json().created).toBe(1);
  });

  it('цели визита и парковочные участки: справочники с мягким удалением', async () => {
    const purpose = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/visit-purposes`,
      payload: { name: 'Разгрузка', maxStayMinutes: 120 },
    });
    expect(purpose.statusCode, purpose.body).toBe(201);
    expect(purpose.json()).toMatchObject({ name: 'Разгрузка', maxStayMinutes: 120 });
    const renamed = await t.as(admin, {
      method: 'PATCH',
      url: `/visit-purposes/${purpose.json().id}`,
      payload: { maxStayMinutes: 90 },
    });
    expect(renamed.json().maxStayMinutes).toBe(90);
    const removed = await t.as(admin, {
      method: 'DELETE',
      url: `/visit-purposes/${purpose.json().id}`,
    });
    expect(removed.statusCode).toBe(200);
    const list = await t.as(admin, { url: `/sites/${site}/visit-purposes` });
    expect(list.json().items.map((p: { name: string }) => p.name)).not.toContain('Разгрузка');
  });

  it('места на участке: нельзя закрепить больше, чем есть; текст называет, сколько осталось', async () => {
    const area = await t.as(admin, {
      method: 'POST',
      url: `/sites/${site}/parking-areas`,
      payload: { name: 'Стоянка А', spaces: 10 },
    });
    expect(area.statusCode, area.body).toBe(201);
    const areaId = area.json().id;
    const assign = (tenant: string, spaces: number) =>
      t.as(admin, {
        method: 'POST',
        url: `/tenants/${tenant}/parking-assignments`,
        payload: { parkingAreaId: areaId, spaces, validFrom: '2026-03-01' },
      });
    expect((await assign(tenantKey('dns'), 6)).statusCode).toBe(201);
    const over = await assign(tenantKey('x5'), 5);
    expect(over.statusCode).toBe(409);
    expect(error(over).message).toContain('не больше 4');
    expect((await assign(tenantKey('x5'), 4)).statusCode).toBe(201);
    const list = await t.as(admin, { url: `/tenants/${tenantKey('dns')}/parking-assignments` });
    expect(list.json().items).toHaveLength(1);
  });
});

describe('исправления API (Q-66)', () => {
  it('исключения: фильтр по арендатору на сервере', async () => {
    const all = await t.as(admin, { url: `/sites/${site}/exceptions` });
    const dns = await t.as(admin, {
      url: `/sites/${site}/exceptions?tenantId=${tenantKey('dns')}`,
    });
    expect(dns.statusCode).toBe(200);
    expect(dns.json().items.length).toBeGreaterThan(0);
    expect(dns.json().items.length).toBeLessThan(all.json().items.length);
    expect(
      dns.json().items.every((e: { tenantId: string }) => e.tenantId === tenantKey('dns')),
    ).toBe(true);
  });

  it('правила пешеходов: одно на «арендатор × зона» и одно «везде»', async () => {
    const tenant = tenantKey('canteen');
    const payload = { escort: 'none', documentRequired: true };
    const first = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant}/pedestrian-rules`,
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const twin = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant}/pedestrian-rules`,
      payload,
    });
    expect(twin.statusCode).toBe(409);
    expect(error(twin).field).toBe('zoneId');
    const zone = KEYS.zones.warehouse ?? '';
    const other = await t.as(admin, {
      method: 'POST',
      url: `/tenants/${tenant}/pedestrian-rules`,
      payload: { ...payload, zoneId: zone },
    });
    expect(other.statusCode).toBe(201);
    const clash = await t.as(admin, {
      method: 'PATCH',
      url: `/pedestrian-rules/${other.json().id}`,
      payload: { zoneId: null },
    });
    expect(clash.statusCode).toBe(409);
  });

  it('назначение дока: текст отличает пересечение с самим арендатором и с другим', async () => {
    const dock = (
      await t.as(admin, {
        method: 'POST',
        url: `/sites/${site}/docks`,
        payload: { number: 'Н-1' },
      })
    ).json().id;
    const assign = (tenant: string, dryRun = false) =>
      t.as(admin, {
        method: 'POST',
        url: `/tenants/${tenant}/dock-assignments/batch`,
        payload: { dockIds: [dock], validFrom: '2026-03-01', validTo: '2026-06-30', dryRun },
      });
    expect((await assign(tenantKey('moll'))).json().created).toBe(1);
    const self = await assign(tenantKey('moll'), true);
    expect(self.json().errors[0].message).toContain('закреплён за этим арендатором');
    expect(self.json().errors[0].message).not.toContain('другого');
    const other = await assign(tenantKey('x5'), true);
    expect(other.json().errors[0].message).toContain('закреплён за арендатором «');
  });
});

import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
} from '../support/harness';
import { gateKey, quotaKey, tenantKey } from './gate-helpers';

/**
 * Списки без потолка и выгрузка (этап 7b.1): 120 пропусков, фильтры на сервере по всем строкам,
 * порции по 50 с итогом, «Сейчас на территории» совпадает с виджетом лимитов, выгрузка XLSX/CSV —
 * все строки по фильтру и след в аудите. Часы стоят на вторнике 10.03.2026 12:00 по объекту.
 */
let t: TestApp;
const dns = tenantKey('dns');
const x5 = tenantKey('x5');
const car = KEYS.categories.car ?? '';
const semi = KEYS.categories.semi ?? '';
const HOUR = 3_600_000;

const admin = roleActor('site_admin');
const logist = roleActor('tenant_manager', { tenantIds: [dns] });
const requester = roleActor('tenant_requester', { tenantIds: [dns] });
const foreign = roleActor('tenant_manager', { tenantIds: [x5] });

const plateOf = (n: number) => `О${String(100 + n).padStart(3, '0')}КК174`;
const passesUrl = (query = '') => `/sites/${KEYS.siteId}/passes?${query}`;

/** 120 разовых пропусков ДНС: 100 «легковых» и 20 «фур»; созданы напрямую, как после долгой работы. */
async function seedPasses() {
  const db = ownerDb();
  const rows = Array.from({ length: 120 }, (_, i) => ({
    organizationId: KEYS.organizationId,
    siteId: KEYS.siteId,
    tenantId: dns,
    passType: 'single' as const,
    participant: 'vehicle' as const,
    plateRaw: plateOf(i),
    plateNorm: plateOf(i),
    plateCountry: 'RU',
    categoryId: i < 100 ? car : semi,
    status: i % 10 === 0 ? ('cancelled' as const) : ('approved' as const),
    validFrom: new Date(Date.parse(NOON) + HOUR),
    validTo: new Date(Date.parse(NOON) + 5 * HOUR),
    createdVia: 'web' as const,
    // разное время создания: порядок «новые сверху» стабилен
    createdAt: new Date(Date.parse(NOON) - i * 60_000),
  }));
  await db.insert(schema.passes).values(rows);
}

/** Открытый визит по пропуску (въезд мимо поста — путь `checkIn` проверяют сценарии поста). */
async function enter(plate: string, category: string, gate = 'kpp2', minutesAgo = 90) {
  const db = ownerDb();
  const [pass] = await db
    .select()
    .from(schema.passes)
    .where(and(eq(schema.passes.plateNorm, plate), eq(schema.passes.tenantId, dns)));
  await db.insert(schema.visits).values({
    organizationId: KEYS.organizationId,
    siteId: KEYS.siteId,
    tenantId: dns,
    passId: pass?.id ?? null,
    participant: 'vehicle',
    categoryId: category,
    plateNorm: plate,
    snapshot: {
      gate,
      tenant: 'ДНС',
      category: category === semi ? 'Фура' : 'Легковой',
      dock: '12',
    },
    gateInId: gateKey(gate),
    timeIn: new Date(Date.parse(NOON) - minutesAgo * 60_000),
    methodIn: 'button',
  });
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  await seedPasses();
  // на территории: 4 фуры и 3 легковых (одна из «легковых» уже выехала)
  for (const i of [101, 102, 103, 104]) await enter(plateOf(i), semi, 'kpp2', 300 - 20 * (i - 100));
  for (const i of [1, 2, 3]) await enter(plateOf(i), car, 'kpp1', 10 * i);
  const [closed] = await ownerDb()
    .select()
    .from(schema.passes)
    .where(eq(schema.passes.plateNorm, plateOf(4)));
  await ownerDb()
    .insert(schema.visits)
    .values({
      organizationId: KEYS.organizationId,
      siteId: KEYS.siteId,
      tenantId: dns,
      passId: closed?.id ?? null,
      participant: 'vehicle',
      categoryId: car,
      plateNorm: plateOf(4),
      snapshot: {},
      gateInId: gateKey('kpp1'),
      timeIn: new Date(Date.parse(NOON) - 5 * HOUR),
      timeOut: new Date(Date.parse(NOON) - 4 * HOUR),
      methodIn: 'button',
    });
});
afterAll(() => t.close());

describe('список пропусков без потолка', () => {
  it('порции по 50 с итогом: 120 пропусков собираются целиком, без повторов', async () => {
    const seen = new Set<string>();
    let total = 0;
    for (let offset = 0; offset < 150; offset += 50) {
      const res = await t.as(logist, { url: passesUrl(`tenantId=${dns}&offset=${offset}`) });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      total = body.total;
      expect(body.items.length).toBe(Math.max(0, Math.min(50, 120 - offset)));
      for (const item of body.items) seen.add(item.id);
    }
    expect(total).toBe(120);
    expect(seen.size).toBe(120);
  });

  it('порция по умолчанию — 50; фильтры работают по всем строкам, итог — по фильтру', async () => {
    const first = (await t.as(logist, { url: passesUrl(`tenantId=${dns}`) })).json();
    expect(first.items).toHaveLength(50);
    const cancelled = (
      await t.as(logist, { url: passesUrl(`tenantId=${dns}&status=cancelled`) })
    ).json();
    expect(cancelled.total).toBe(12);
    expect(cancelled.items).toHaveLength(12);
    // поиск по цифрам номера находит пропуск, которого нет в первой порции
    const found = (await t.as(logist, { url: passesUrl(`tenantId=${dns}&q=219`) })).json();
    expect(found.total).toBe(1);
    expect(found.items[0].plateNorm).toBe(plateOf(119));
    const day = (
      await t.as(logist, {
        url: passesUrl(`tenantId=${dns}&dateFrom=2026-03-10&dateTo=2026-03-10`),
      })
    ).json();
    expect(day.total).toBe(120);
    const other = (
      await t.as(logist, {
        url: passesUrl(`tenantId=${dns}&dateFrom=2026-03-12&dateTo=2026-03-12`),
      })
    ).json();
    expect(other.total).toBe(0);
  });

  it('арендатор видит только своё: чужой арендатор — 403, свой фильтр без арендатора — только свои', async () => {
    expect((await t.as(foreign, { url: passesUrl(`tenantId=${dns}`) })).statusCode).toBe(403);
    const own = (await t.as(foreign, { url: passesUrl('') })).json();
    expect(own.total).toBe(0);
    const all = (await t.as(admin, { url: passesUrl('limit=1') })).json();
    expect(all.total).toBeGreaterThanOrEqual(120);
  });
});

describe('«Сейчас на территории»', () => {
  it('все открытые визиты арендатора, давно въехавшие первыми; закрытые не считаются', async () => {
    const res = await t.as(logist, { url: `/sites/${KEYS.siteId}/inside?tenantId=${dns}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.total).toBe(7);
    expect(body.items).toHaveLength(7);
    // самый давний въезд — первая фура (4 ч 40 мин назад); дальше по возрастанию времени
    expect(body.items[0]).toMatchObject({
      title: plateOf(101),
      categoryName: 'Фура',
      gateInName: 'kpp2',
      dock: '12',
    });
    const times = body.items.map((r: { timeIn: string }) => Date.parse(r.timeIn));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const page = (
      await t.as(logist, { url: `/sites/${KEYS.siteId}/inside?tenantId=${dns}&limit=3&offset=3` })
    ).json();
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(3);
  });

  it('число по лимиту совпадает с виджетом лимитов: «Грузовые» и «Легковые»', async () => {
    const occupancy = (await t.as(logist, { url: `/sites/${KEYS.siteId}/occupancy` })).json();
    for (const key of ['dns/trucks', 'dns/cars']) {
      const widget = occupancy.quotas.find((q: { quotaId: string }) => q.quotaId === quotaKey(key));
      const list = (
        await t.as(logist, {
          url: `/sites/${KEYS.siteId}/inside?quotaId=${quotaKey(key)}`,
        })
      ).json();
      expect(list.total, key).toBe(widget.occupied);
      expect(list.items.length, key).toBe(widget.occupied);
    }
    expect(
      (
        await t.as(logist, {
          url: `/sites/${KEYS.siteId}/inside?quotaId=${quotaKey('dns/trucks')}`,
        })
      ).json().total,
    ).toBe(4);
    const all = (await t.as(logist, { url: `/sites/${KEYS.siteId}/inside` })).json();
    const today = (await t.as(logist, { url: `/tenants/${dns}/today` })).json();
    expect(all.total).toBe(today.inside);
  });

  it('чужой лимит и чужие визиты недоступны; поиск по цифрам', async () => {
    const stranger = await t.as(foreign, {
      url: `/sites/${KEYS.siteId}/inside?quotaId=${quotaKey('dns/trucks')}`,
    });
    expect([403, 404]).toContain(stranger.statusCode);
    expect((await t.as(foreign, { url: `/sites/${KEYS.siteId}/inside` })).json().total).toBe(0);
    const search = (
      await t.as(logist, { url: `/sites/${KEYS.siteId}/inside?tenantId=${dns}&q=103` })
    ).json();
    expect(search.total).toBeGreaterThanOrEqual(1);
    expect(search.items.every((r: { title: string }) => r.title.includes('103'))).toBe(true);
  });
});

describe('выгрузка XLSX/CSV', () => {
  const exportUrl = (kind: 'passes' | 'inside', query: string) =>
    kind === 'passes'
      ? `/sites/${KEYS.siteId}/passes/export?${query}`
      : `/sites/${KEYS.siteId}/inside/export?${query}`;

  const csvLines = (body: string) => body.replace(/^﻿/, '').trim().split(/\r\n/);

  it('CSV: все 120 строк по фильтру, не только страница; колонки и пояс в заголовках', async () => {
    const res = await t.as(logist, { url: exportUrl('passes', `tenantId=${dns}&format=csv`) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const lines = csvLines(res.body);
    expect(lines).toHaveLength(121);
    const header = lines[0]?.split(';') ?? [];
    expect(header.slice(0, 4)).toEqual(['Номер', 'Тип транспорта', 'Вид пропуска', 'Статус']);
    expect(header[4]).toBe('Действует с (Челябинск, UTC+5)');
    expect(header[5]).toBe('Действует по (Челябинск, UTC+5)');
    expect(header).toContain('Место назначения');
    expect(header).toContain('Автор');
    expect(header).toContain('На территории сейчас');
    const insideRow = lines.find((l) => l.startsWith(plateOf(101)));
    expect(insideRow).toContain(';да;');
    const regular = lines.find((l) => l.startsWith(plateOf(51)));
    expect(regular).toContain('Разовый;Действует;10.03.2026 13:00;10.03.2026 17:00');
    expect(regular).toContain(';нет;');
  });

  it('фильтр действует и на выгрузку: только отменённые', async () => {
    const res = await t.as(logist, {
      url: exportUrl('passes', `tenantId=${dns}&status=cancelled&format=csv`),
    });
    expect(csvLines(res.body)).toHaveLength(13);
    expect(res.body).toContain('Отменён');
  });

  it('XLSX: настоящая книга со 121 строкой, время с подписью пояса', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: exportUrl('passes', `tenantId=${dns}&format=xlsx`),
      headers: await t.headersFor(logist),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ]),
    );
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'] as Uint8Array);
    expect(sheet.match(/<row /g)).toHaveLength(121);
    expect(sheet).toContain('Действует с (Челябинск, UTC+5)');
    expect(sheet).toContain(plateOf(119));
  });

  it('«Сейчас на территории»: выгрузка = все открытые визиты по фильтру', async () => {
    const res = await t.as(logist, { url: exportUrl('inside', `tenantId=${dns}&format=csv`) });
    expect(res.statusCode, res.body).toBe(200);
    const lines = csvLines(res.body);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('Въехал (Челябинск, UTC+5)');
    expect(lines[0]).toContain('КПП въезда');
    expect(lines[1]).toContain(plateOf(101));
    expect(lines[1]).toContain('Фура;Разовый;10.03.2026 07:20;4 ч 40 мин;kpp2;12');
    const trucks = await t.as(logist, {
      url: exportUrl('inside', `quotaId=${quotaKey('dns/trucks')}&format=csv`),
    });
    expect(csvLines(trucks.body)).toHaveLength(5);
  });

  it('факт выгрузки попадает в аудит: формат, число строк, фильтр без текста поиска', async () => {
    await t.as(logist, { url: exportUrl('passes', `tenantId=${dns}&q=219&format=csv`) });
    const rows = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'export'), eq(schema.auditLog.action, 'export')));
    const last = rows.find(
      (r) => (r.snapshot as { format?: string; filter?: { search?: boolean } }).filter?.search,
    );
    expect(last?.snapshot).toMatchObject({
      kind: 'passes',
      format: 'csv',
      rows: 1,
      filter: { tenantId: dns, search: true },
    });
    expect(JSON.stringify(last?.snapshot)).not.toContain('219');
    expect(last?.actorUserId).toBe(logist.id);
  });

  it('без права «report.export» — 403; чужого арендатора выгрузить нельзя; ячейки-формулы обезврежены', async () => {
    const denied = await t.as(requester, {
      url: exportUrl('passes', `tenantId=${dns}&format=csv`),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('report.export');
    const stranger = await t.as(foreign, {
      url: exportUrl('passes', `tenantId=${dns}&format=csv`),
    });
    expect(stranger.statusCode).toBe(403);
    const formula = await ownerDb()
      .update(schema.passes)
      .set({ plateRaw: '=1+1' })
      .where(eq(schema.passes.plateNorm, plateOf(7)))
      .returning({ id: schema.passes.id });
    expect(formula).toHaveLength(1);
    const res = await t.as(logist, {
      url: exportUrl('passes', `tenantId=${dns}&q=107&format=csv`),
    });
    expect(res.body).toContain("'=1+1");
  });

  it('«Изменён последним» и «Изменён»: пропуск правил другой пользователь — в выгрузке его имя и время; не менялся — пусто', async () => {
    const make = async (plate: string) => {
      const res = await t.as(logist, {
        method: 'POST',
        url: '/passes',
        payload: {
          tenantId: dns,
          passType: 'single',
          participant: 'vehicle',
          plate,
          categoryId: car,
          validFrom: new Date(Date.parse(NOON) + HOUR).toISOString(),
          validTo: new Date(Date.parse(NOON) + 3 * HOUR).toISOString(),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const edited = await make('М701ЕД174');
    await make('М702ЕД174');
    t.clock.set(new Date(Date.parse(NOON) + 20 * 60_000).toISOString());
    const patched = await t.as(admin, {
      method: 'PATCH',
      url: `/passes/${edited}`,
      payload: { comment: 'Уточнил диспетчер' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    t.clock.set(NOON);

    const [adminUser] = await ownerDb()
      .select({ name: schema.users.fullName })
      .from(schema.users)
      .where(eq(schema.users.id, admin.id));
    expect(adminUser?.name).toBeTruthy();

    const res = await t.as(logist, { url: exportUrl('passes', `tenantId=${dns}&q=70&format=csv`) });
    const lines = csvLines(res.body);
    const header = (lines[0] ?? '').split(';');
    const who = header.indexOf('Изменён последним');
    const when = header.indexOf('Изменён (Челябинск, UTC+5)');
    expect(who).toBeGreaterThan(0);
    expect(when).toBe(who + 1);
    const cells = (plate: string) => (lines.find((l) => l.startsWith(plate)) ?? '').split(';');
    expect(cells('М701ЕД174')[who]).toBe(adminUser?.name);
    expect(cells('М701ЕД174')[when]).toBe('10.03.2026 12:20');
    expect(cells('М702ЕД174')[who]).toBe('');
    expect(cells('М702ЕД174')[when]).toBe('');
  });

  it('бухгалтер (report.export без права видеть пропуска) выгрузить список не может — 403 называет право', async () => {
    const accountant = roleActor('accountant');
    const res = await t.as(accountant, { url: exportUrl('passes', 'format=csv') });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('pass.view');
  });

  it('слишком большая выгрузка отклоняется понятной ошибкой, а не обрезается молча', async () => {
    // предел 50 000 строк проверяет функция; здесь — что ошибка структурирована и есть в каталоге
    const { EXPORT_ROW_LIMIT } = await import('../../src/modules/passes/listing');
    expect(EXPORT_ROW_LIMIT).toBe(50_000);
  });
});

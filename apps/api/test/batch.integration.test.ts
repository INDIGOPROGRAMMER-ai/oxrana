import { BatchResultSchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS, ownerDb, roleActor, seedDemo, startTestApp, type TestApp } from './support/harness';

let t: TestApp;
const owner = roleActor('org_owner');

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

const docksUrl = `/sites/${KEYS.siteId}/docks/batch`;
const tenantsUrl = `/sites/${KEYS.siteId}/tenants/batch`;

describe('пакетный ввод справочников (этап 6a)', () => {
  it('доки: предпросмотр ничего не сохраняет, сохранение добавляет и ловит существующие и повторы', async () => {
    const numbers = ['901', '902', '903', '902'];
    const preview = await t.as(owner, {
      method: 'POST',
      url: docksUrl,
      payload: { numbers, dryRun: true },
    });
    expect(preview.statusCode).toBe(200);
    const p = BatchResultSchema.parse(preview.json());
    expect(p).toMatchObject({
      dryRun: true,
      total: 4,
      created: 3,
      summary: 'Будет добавлено 3 из 4',
    });
    expect(p.errors).toEqual([
      expect.objectContaining({ row: 4, field: 'number', code: 'conflict' }),
    ]);
    const none = await ownerDb()
      .select()
      .from(schema.docks)
      .where(and(eq(schema.docks.siteId, KEYS.siteId), eq(schema.docks.number, '901')));
    expect(none).toHaveLength(0);

    const saved = await t.as(owner, { method: 'POST', url: docksUrl, payload: { numbers } });
    const s = BatchResultSchema.parse(saved.json());
    expect(s).toMatchObject({ dryRun: false, created: 3, summary: 'Добавлено 3 из 4' });
    expect(s.ids.filter(Boolean)).toHaveLength(3);

    // существующий номер — ошибка строки, остальные добавляются
    const again = await t.as(owner, {
      method: 'POST',
      url: docksUrl,
      payload: { numbers: ['901', '904'] },
    });
    const a = BatchResultSchema.parse(again.json());
    expect(a.created).toBe(1);
    expect(a.errors[0]).toMatchObject({ row: 1, field: 'number', code: 'conflict' });
  });

  it('арендаторы: вставка с ошибками строк, повтор названия и уже существующий', async () => {
    const items = [
      { shortName: 'Тест-Альфа', legalName: 'ООО «Тест-Альфа»', inn: '7700000001' },
      { shortName: 'Тест-Бета', legalName: 'ООО «Тест-Бета»' },
      { shortName: 'тест-альфа', legalName: 'ООО «Повтор»' },
    ];
    const res = await t.as(owner, { method: 'POST', url: tenantsUrl, payload: { items } });
    const r = BatchResultSchema.parse(res.json());
    expect(r).toMatchObject({ created: 2, total: 3 });
    expect(r.errors).toEqual([expect.objectContaining({ row: 3, field: 'shortName' })]);
    const second = await t.as(owner, {
      method: 'POST',
      url: tenantsUrl,
      payload: { items: [items[1]], dryRun: true },
    });
    expect(BatchResultSchema.parse(second.json()).errors).toHaveLength(1);
  });

  it('назначения доков: пакет закрепляет свободные и называет занятые', async () => {
    const dns = KEYS.tenants.dns ?? '';
    const docks = await ownerDb()
      .select()
      .from(schema.docks)
      .where(and(eq(schema.docks.siteId, KEYS.siteId), eq(schema.docks.number, '902')));
    const free = docks[0]?.id ?? '';
    const taken = await ownerDb()
      .select()
      .from(schema.tenantDockAssignments)
      .where(eq(schema.tenantDockAssignments.tenantId, dns))
      .limit(1);
    const takenDock = taken[0]?.dockId ?? '';
    const other = KEYS.tenants.x5 ?? '';
    const res = await t.as(owner, {
      method: 'POST',
      url: `/tenants/${other}/dock-assignments/batch`,
      payload: { dockIds: [free, takenDock], validFrom: '2026-01-01' },
    });
    expect(res.statusCode).toBe(200);
    const r = BatchResultSchema.parse(res.json());
    expect(r.created).toBe(1);
    expect(r.errors[0]).toMatchObject({ row: 2, field: 'dockId', code: 'conflict' });
  });

  it('пакет пишет аудит по каждой созданной записи', async () => {
    const rows = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'dock'), eq(schema.auditLog.action, 'create')));
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

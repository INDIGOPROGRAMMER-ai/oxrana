import { roleTemplate } from '@oxrana/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySeed, DEMO_SEED, seedId } from '../seed';
import { createDb, createPool, schema, withOrganization } from '../src';

/**
 * Демо-сид (ADR-003 п. 7, ADR-014): поднимает объект с нуля, повторный запуск ничего не дублирует
 * и не трогает изменённые данные. Названия объекта в тесте не встречаются (ADR-012 п. 7) — данные
 * берутся из самого описания сида.
 */
const ownerPool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const appPool = createPool({ connectionString: process.env.DATABASE_URL ?? '', max: 1 });
const db = createDb(ownerPool);
const app = createDb(appPool);
afterAll(async () => {
  await ownerPool.end();
  await appPool.end();
});

const id = (...parts: string[]) => seedId(DEMO_SEED.organization.key, ...parts);
const organizationId = id('organization');

/** Число строк и хэш содержимого каждой таблицы сида — «состояние» для сравнения до/после. */
async function tableStates(tables: string[]): Promise<Record<string, string>> {
  const states: Record<string, string> = {};
  for (const table of tables) {
    const { rows } = await ownerPool.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
         from ${table} t`,
    );
    states[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return states;
}

let firstReport: Awaited<ReturnType<typeof applySeed>>;
beforeAll(async () => {
  firstReport = await applySeed(db, DEMO_SEED);
});

describe('сид демо-объекта', () => {
  it('поднимает объект с нуля: всё описанное вставлено', async () => {
    for (const [table, { described, inserted }] of Object.entries(firstReport)) {
      expect(inserted, table).toBe(described);
      const { rows } = await ownerPool.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, table).toBe(described);
    }
    expect(firstReport.gates?.described).toBe(3);
    expect(firstReport.gate_accounts?.described).toBe(3);
    expect(firstReport.tenants?.described).toBe(12);
    expect(firstReport.vehicle_categories?.described).toBe(5);
    expect(firstReport.docks?.described).toBe(72 + 7);
    expect(firstReport.roles?.described).toBe(9);
  });

  it('сид идемпотентен: повторный запуск ничего не добавляет и не меняет', async () => {
    const tables = Object.keys(firstReport);
    const before = await tableStates(tables);
    const again = await applySeed(db, DEMO_SEED);
    for (const [table, { inserted }] of Object.entries(again)) expect(inserted, table).toBe(0);
    expect(await tableStates(tables)).toEqual(before);
  });

  it('повторный запуск не ломает данные, изменённые после сида, и дописывает недостающее', async () => {
    const tenantId = id('tenant', DEMO_SEED.tenants[0]?.key ?? '');
    const quotaId = id('quota', DEMO_SEED.tenants[0]?.key ?? '', 'cars');
    await db
      .update(schema.tenants)
      .set({ shortName: 'Переименован' })
      .where(eq(schema.tenants.id, tenantId));
    await db.update(schema.quotas).set({ capacity: 99 }).where(eq(schema.quotas.id, quotaId));
    const [pass] = await db
      .insert(schema.passes)
      .values({
        organizationId,
        siteId: id('site', DEMO_SEED.site.key),
        tenantId,
        passType: 'single',
        participant: 'vehicle',
        plateRaw: 'А123ВС174',
        plateNorm: 'A123BC174',
        plateCountry: 'RU',
        categoryId: id('category', 'car'),
        validFrom: new Date('2026-10-10T08:00:00+05:00'),
        validTo: new Date('2026-10-11T08:00:00+05:00'),
        status: 'approved',
        createdVia: 'web',
      })
      .returning();
    // строку без ссылок удалили совсем — сид её вернёт
    await db
      .delete(schema.approvalPolicies)
      .where(eq(schema.approvalPolicies.id, id('approval', 'admin', 'permanent')));

    const report = await applySeed(db, DEMO_SEED);

    expect(report.approval_policies?.inserted).toBe(1);
    const others = Object.entries(report).filter(([t]) => t !== 'approval_policies');
    for (const [table, { inserted }] of others) expect(inserted, table).toBe(0);
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(tenant?.shortName).toBe('Переименован');
    const [quota] = await db.select().from(schema.quotas).where(eq(schema.quotas.id, quotaId));
    expect(quota?.capacity).toBe(99);
    const passes = await db
      .select()
      .from(schema.passes)
      .where(eq(schema.passes.id, pass?.id ?? ''));
    expect(passes).toHaveLength(1);
  });

  it('у каждого арендатора, кроме оператора, лимит покрывает каждый включённый тип (Q-7)', async () => {
    const { rows } = await ownerPool.query<{ tenant: string; operator: boolean; types: number }>(`
      select t.id as tenant, t.is_operator as operator, count(distinct qc.category_id)::int as types
        from tenants t
        left join quotas q on q.tenant_id = t.id and q.deleted_at is null
        left join quota_categories qc on qc.quota_id = q.id
       group by t.id, t.is_operator`);
    for (const row of rows) {
      expect(row.types, row.tenant).toBe(row.operator ? 0 : DEMO_SEED.categories.length);
    }
    expect(rows.filter((r) => r.operator)).toHaveLength(1);
  });

  it('лимит «по докам» равен числу доков арендатора в лимите', async () => {
    const { rows } = await ownerPool.query<{ capacity: number; docks: number }>(`
      select q.capacity, (select count(*)::int from tenant_dock_assignments a
                            join docks d on d.id = a.dock_id
                           where a.tenant_id = q.tenant_id and d.counts_in_quota) as docks
        from quotas q where q.capacity_from_docks`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.capacity).toBe(row.docks);
  });

  it('каждый док в лимите назначен ровно одному арендатору', async () => {
    const { rows } = await ownerPool.query<{ n: number }>(`
      select (select count(*)::int from tenant_dock_assignments a where a.dock_id = d.id) as n
        from docks d where d.counts_in_quota`);
    expect(rows).toHaveLength(72 + 7);
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  it('мягкий лимит — с тарифом сверх лимита, жёсткий — без', async () => {
    const soft = await db
      .select({ tariff: schema.quotas.overageTariffRub })
      .from(schema.quotas)
      .where(eq(schema.quotas.enforcement, 'soft'));
    expect(soft.map((q) => q.tariff).sort()).toEqual(['233.00', '67.00']);
    const hardWithTariff = await db
      .select()
      .from(schema.quotas)
      .where(
        and(
          eq(schema.quotas.enforcement, 'hard'),
          sql`${schema.quotas.overageTariffRub} is not null`,
        ),
      );
    expect(hardWithTariff).toEqual([]);
  });

  it('типы транспорта — из пресетов, включены, в порядке сида', async () => {
    const rows = await db
      .select({
        code: schema.vehicleCategories.presetCode,
        enabled: schema.vehicleCategories.enabled,
      })
      .from(schema.vehicleCategories)
      .orderBy(schema.vehicleCategories.sort);
    expect(rows.map((r) => r.code)).toEqual(DEMO_SEED.categories);
    expect(rows.every((r) => r.enabled)).toBe(true);
  });

  it('учётка на каждый КПП с ролью «Пост КПП»: впускает, но не правит пропуска', async () => {
    const accounts = await db
      .select({ permissions: schema.roles.permissions, template: schema.roles.isTemplate })
      .from(schema.gateAccounts)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.gateAccounts.roleId));
    expect(accounts).toHaveLength(DEMO_SEED.gates.length);
    for (const a of accounts) {
      expect(a.template).toBe(true);
      expect(a.permissions).toEqual([...roleTemplate('gate_post').permissions]);
      expect(a.permissions).not.toContain('pass.edit');
    }
  });

  it('данные сида видны приложению только в контексте своей организации (RLS)', async () => {
    expect(await app.select().from(schema.tenants)).toEqual([]);
    const tenants = await withOrganization(app, organizationId, (tx) =>
      tx.select({ id: schema.tenants.id }).from(schema.tenants),
    );
    expect(tenants).toHaveLength(DEMO_SEED.tenants.length);
  });
});

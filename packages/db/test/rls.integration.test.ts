import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, schema, withOrganization } from '../src';
import { createOrgFixture, type OrgFixture, pgErrorOf } from './fixtures';

/**
 * RLS по организации — вторая линия защиты (ADR-003, DATA_MODEL §4). Данные пишет владелец,
 * читает и пишет роль приложения `oxrana_app` — так же, как будет работать API.
 */
const ownerPool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const appPool = createPool({ connectionString: process.env.DATABASE_URL ?? '', max: 2 });
const owner = createDb(ownerPool);
const app = createDb(appPool);

let a: OrgFixture;
let b: OrgFixture;

beforeAll(async () => {
  a = await createOrgFixture(owner, 'a');
  b = await createOrgFixture(owner, 'b');
  for (const f of [a, b]) {
    const [quota] = await owner
      .insert(schema.quotas)
      .values({
        organizationId: f.organizationId,
        siteId: f.siteId,
        tenantId: f.tenantId,
        name: 'Легковые',
        capacity: 5,
      })
      .returning();
    await owner
      .insert(schema.quotaCategories)
      .values({ quotaId: quota?.id ?? '', categoryId: f.categoryId });
  }
});

afterAll(async () => {
  await ownerPool.end();
  await appPool.end();
});

describe('чужая организация не видна (RLS)', () => {
  it('приложение работает под ролью без обхода RLS', async () => {
    const { rows } = await appPool.query('select current_user as u');
    expect(rows[0].u).toBe('oxrana_app');
  });

  it('без контекста организации бизнес-таблицы пусты', async () => {
    expect(await app.select().from(schema.tenants)).toEqual([]);
    expect(await app.select().from(schema.organizations)).toEqual([]);
    expect(await app.select().from(schema.quotaCategories)).toEqual([]);
  });

  it('в контексте организации видны только её строки', async () => {
    await withOrganization(app, a.organizationId, async (tx) => {
      const tenants = await tx.select({ id: schema.tenants.id }).from(schema.tenants);
      expect(tenants).toEqual([{ id: a.tenantId }]);
      const orgs = await tx.select({ id: schema.organizations.id }).from(schema.organizations);
      expect(orgs).toEqual([{ id: a.organizationId }]);
      const sites = await tx.select({ id: schema.sites.id }).from(schema.sites);
      expect(sites).toEqual([{ id: a.siteId }]);
    });
  });

  it('чужую строку не найти даже по id', async () => {
    await withOrganization(app, a.organizationId, async (tx) => {
      const found = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, b.tenantId));
      expect(found).toEqual([]);
    });
  });

  it('таблица-связка без organization_id видна через родителя', async () => {
    await withOrganization(app, b.organizationId, async (tx) => {
      const links = await tx.select().from(schema.quotaCategories);
      expect(links.map((l) => l.categoryId)).toEqual([b.categoryId]);
    });
  });

  it('записать строку в чужую организацию нельзя', async () => {
    const error = await pgErrorOf(
      withOrganization(app, a.organizationId, (tx) =>
        tx.insert(schema.zones).values({
          organizationId: b.organizationId,
          siteId: b.siteId,
          name: 'Чужая зона',
          kind: 'yard',
        }),
      ),
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/row-level security/);
  });

  it('изменить или удалить чужую строку нельзя — она просто не находится', async () => {
    await withOrganization(app, a.organizationId, async (tx) => {
      const updated = await tx
        .update(schema.tenants)
        .set({ shortName: 'взлом' })
        .where(eq(schema.tenants.id, b.tenantId))
        .returning();
      expect(updated).toEqual([]);
    });
    const [tenantB] = await owner
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, b.tenantId));
    expect(tenantB?.shortName).toBe('А-b');
  });

  it('контекст живёт только в своей транзакции', async () => {
    await withOrganization(app, a.organizationId, async () => {});
    const client = await appPool.connect();
    try {
      // то же соединение после транзакции: настройка пуста, а не «залипла»
      await client.query('begin');
      await client.query(`select set_config('app.organization_id', $1, true)`, [a.organizationId]);
      await client.query('commit');
      const { rows } = await client.query('select count(*)::int as n from tenants');
      expect(rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('все таблицы с organization_id и таблицы-связки под RLS с политикой', async () => {
    const { rows } = await ownerPool.query<{ table: string; rls: boolean; policies: number }>(`
      select c.relname as table, c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`);
    const withoutRls = rows.filter((r) => !r.rls || r.policies === 0).map((r) => r.table);
    // Платформенные таблицы без organization_id: пользователь состоит в нескольких организациях.
    expect(withoutRls).toEqual([
      'login_codes',
      'notification_preferences',
      'push_subscriptions',
      'sessions',
      'telegram_links',
      'users',
    ]);
    const { rows: orgTables } = await ownerPool.query<{ table: string }>(`
      select table_name as table from information_schema.columns
       where table_schema = 'public' and column_name = 'organization_id'`);
    for (const { table } of orgTables) expect(withoutRls, table).not.toContain(table);
  });

  it('приложение может задать только свою организацию — RLS не принимает пустое значение', async () => {
    await withOrganization(app, a.organizationId, async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id', '', true)`);
      expect(await tx.select().from(schema.tenants)).toEqual([]);
    });
  });
});

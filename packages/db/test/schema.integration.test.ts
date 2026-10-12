import { eq, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, schema, withOrganization } from '../src';
import { createOrgFixture, type OrgFixture, pgErrorOf } from './fixtures';

const ownerPool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const appPool = createPool({ connectionString: process.env.DATABASE_URL ?? '', max: 2 });
const owner = createDb(ownerPool);
const app = createDb(appPool);

let f: OrgFixture;
beforeAll(async () => {
  f = await createOrgFixture(owner, 'schema');
});
afterAll(async () => {
  await ownerPool.end();
  await appPool.end();
});

async function publicTables(): Promise<string[]> {
  const { rows } = await ownerPool.query<{ name: string }>(`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by 1`);
  return rows.map((r) => r.name);
}

describe('схема в БД = схема Drizzle (DATA_MODEL §2)', () => {
  it('те же таблицы: ни одной лишней и ни одной забытой миграции', async () => {
    const inCode = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableName(t))
      .sort();
    expect(await publicTables()).toEqual(inCode);
    expect(inCode).toHaveLength(55);
  });

  it('у каждой таблицы с updated_at есть триггер, и он ставит время', async () => {
    const { rows } = await ownerPool.query<{ table: string; has_trigger: boolean }>(`
      select c.relname as table,
             exists (select 1 from pg_trigger t where t.tgrelid = c.oid
                       and t.tgname = c.relname || '_set_updated_at') as has_trigger
        from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'updated_at'`);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => !r.has_trigger)).toEqual([]);

    const before = await owner
      .select({ updatedAt: schema.tenants.updatedAt })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, f.tenantId));
    await owner
      .update(schema.tenants)
      .set({ color: '#336699' })
      .where(eq(schema.tenants.id, f.tenantId));
    const after = await owner
      .select({ updatedAt: schema.tenants.updatedAt })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, f.tenantId));
    expect(after[0]?.updatedAt.getTime()).toBeGreaterThan(before[0]?.updatedAt.getTime() ?? 0);
  });
});

describe('журналы не редактируются (ADR-003 п. 4)', () => {
  it.each(['audit_log', 'domain_events', 'gate_decisions', 'hardware_events', 'gate_actions'])(
    '%s: роль приложения пишет, но не меняет и не удаляет',
    async (table) => {
      const { rows } = await ownerPool.query(
        `select has_table_privilege('oxrana_app', $1, 'INSERT') as ins,
              has_table_privilege('oxrana_app', $1, 'UPDATE') as upd,
              has_table_privilege('oxrana_app', $1, 'DELETE') as del`,
        [table],
      );
      expect(rows[0]).toEqual({ ins: true, upd: false, del: false });
    },
  );

  it.each(['visits', 'barrier_commands'])('%s: обновляется, но не удаляется', async (table) => {
    const { rows } = await ownerPool.query(
      `select has_table_privilege('oxrana_app', $1, 'UPDATE') as upd,
              has_table_privilege('oxrana_app', $1, 'DELETE') as del`,
      [table],
    );
    expect(rows[0]).toEqual({ upd: true, del: false });
  });

  it('попытка изменить аудит — отказ прав', async () => {
    const error = await pgErrorOf(
      withOrganization(app, f.organizationId, (tx) =>
        tx.execute(sql`update audit_log set reason = 'правка'`),
      ),
    );
    expect(error.code).toBe('42501');
  });
});

describe('outbox: domain_events → NOTIFY site_events (ADR-004)', () => {
  it('после COMMIT слушатель получает id события, организацию и объект', async () => {
    const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    try {
      await listener.query('listen site_events');
      const received: string[] = [];
      listener.on('notification', (n) => received.push(n.payload ?? ''));

      // откат — уведомления нет
      await pgErrorOf(
        withOrganization(app, f.organizationId, async (tx) => {
          await tx.insert(schema.domainEvents).values(event(f));
          throw new Error('откат');
        }),
      );
      const [inserted] = await withOrganization(app, f.organizationId, (tx) =>
        tx.insert(schema.domainEvents).values(event(f)).returning({ id: schema.domainEvents.id }),
      );

      await waitFor(() => received.length > 0);
      expect(received.map((p) => JSON.parse(p))).toEqual([
        { id: inserted?.id, organizationId: f.organizationId, siteId: f.siteId },
      ]);
    } finally {
      await listener.end();
    }
  });
});

function event(fx: OrgFixture): typeof schema.domainEvents.$inferInsert {
  return {
    organizationId: fx.organizationId,
    siteId: fx.siteId,
    type: 'test.event',
    aggregate: 'tenant',
    aggregateId: fx.tenantId,
    payload: {},
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались уведомления');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

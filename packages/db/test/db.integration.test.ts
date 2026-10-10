import { afterAll, describe, expect, it } from 'vitest';
import { createPool, pingDb } from '../src';

const app = createPool({ connectionString: process.env.DATABASE_URL ?? '', max: 2 });
const owner = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('БД после миграций', () => {
  it('пул подключается под ролью приложения', async () => {
    await expect(pingDb(app)).resolves.toBeUndefined();
    const { rows } = await app.query('select current_user as u');
    expect(rows[0].u).toBe('oxrana_app');
  });

  it('миграции применены', async () => {
    const { rows } = await owner.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('нужные расширения установлены', async () => {
    const { rows } = await owner.query<{ extname: string }>('select extname from pg_extension');
    const names = rows.map((r) => r.extname);
    expect(names).toEqual(expect.arrayContaining(['pg_trgm', 'pgcrypto', 'btree_gist', 'citext']));
  });

  it('роль приложения без суперправ и без BYPASSRLS (ADR-003)', async () => {
    const { rows } = await owner.query(
      "select rolsuper, rolbypassrls from pg_roles where rolname = 'oxrana_app'",
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('роль приложения не может создавать объекты в схеме public', async () => {
    await expect(app.query('create table _oxrana_probe (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });
});

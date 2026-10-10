import pg from 'pg';
import { loadEnv } from 'vite';
import { runMigrations } from '../src';
import { maintenance, quoteIdent, TEMPLATE_DB, WORKER_DB_PREFIX, withDatabase } from './test-db';

/**
 * Перед интеграционными тестами (ADR-003 п. 6): пересоздаёт шаблон `oxrana_test_template` и
 * применяет к нему миграции; базы воркеров копируются из шаблона в `worker-setup.ts`. Шаблон
 * пересоздаётся каждый прогон — правка миграции в работе не оставит устаревшую схему. После
 * прогона базы воркеров удаляются, шаблон остаётся (для разбора упавшего теста).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const env = { ...loadEnv('test', process.cwd(), ''), ...process.env };
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      'Не задана DATABASE_ADMIN_URL: интеграционным тестам нужна БД. Выполните `pnpm db:up` (создаст .env из .env.example).',
    );
  }
  try {
    await maintenance(adminUrl, [
      `drop database if exists ${quoteIdent(TEMPLATE_DB)} with (force)`,
      `create database ${quoteIdent(TEMPLATE_DB)}`,
    ]);
    await runMigrations(withDatabase(adminUrl, TEMPLATE_DB));
  } catch (error) {
    throw new Error(
      `Не удалось подготовить шаблон тестовой БД (${error instanceof Error ? error.message : error}). ` +
        'Выполните `pnpm db:up`.',
    );
  }

  return async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        'select datname from pg_database where datname like $1',
        [`${WORKER_DB_PREFIX}%`],
      );
      for (const { datname } of rows) {
        await client.query(`drop database if exists ${quoteIdent(datname)} with (force)`);
      }
    } finally {
      await client.end();
    }
  };
}

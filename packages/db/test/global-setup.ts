import { loadEnv } from 'vite';
import { runMigrations } from '../src';

/**
 * Перед интеграционными тестами применяет миграции (идемпотентно, ADR-010 п. 3): цепочка
 * `pnpm db:up && pnpm test` работает без отдельного `db:migrate`. Если БД не поднята — говорит, что делать.
 */
export default async function setup(): Promise<void> {
  const env = { ...loadEnv('test', process.cwd(), ''), ...process.env };
  const url = env.DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error(
      'Не задана DATABASE_ADMIN_URL: интеграционным тестам нужна БД. Выполните `pnpm db:up` (создаст .env из .env.example).',
    );
  }
  try {
    await runMigrations(url);
  } catch (error) {
    throw new Error(
      `БД недоступна или миграции не применились (${error instanceof Error ? error.message : error}). ` +
        'Выполните `pnpm db:up`.',
    );
  }
}

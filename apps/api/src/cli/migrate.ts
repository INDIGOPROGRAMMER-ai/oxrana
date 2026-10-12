import { runMigrations } from '@oxrana/db';

/**
 * `node dist/migrate.js` — миграции в образе API (ADR-011 §6, ADR-019): под владельцем схемы
 * (`DATABASE_ADMIN_URL`), безопасно повторять. Папка миграций лежит рядом с `dist` (`/app/migrations`);
 * `MIGRATIONS_DIR` переопределяет её для проверки сборки вне образа.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error('Не задана DATABASE_ADMIN_URL (строка подключения владельца схемы).');
  process.exit(1);
}

try {
  await runMigrations(adminUrl, process.env.MIGRATIONS_DIR);
  console.log('Миграции применены.');
} catch (error) {
  console.error('Миграции не применены:', error instanceof Error ? error.message : error);
  process.exit(1);
}

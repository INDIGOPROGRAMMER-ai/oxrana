import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './pool';

/** Папка SQL-миграций (ADR-003). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Применяет миграции под владельцем схемы (`DATABASE_ADMIN_URL`, роль `oxrana_owner`).
 * Повторный запуск безопасен: применённые миграции пропускаются.
 */
export async function runMigrations(adminUrl: string): Promise<void> {
  const pool = createPool({
    connectionString: adminUrl,
    max: 1,
    applicationName: 'oxrana-migrate',
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

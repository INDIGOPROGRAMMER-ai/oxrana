import { createDb, createPool } from '../src';
import { applySeed, DEMO_SEED } from './index';

/**
 * `pnpm db:seed`: демо-объект под владельцем схемы (`DATABASE_ADMIN_URL`). Идемпотентно. Только для
 * разработки и тестов: реальный сервер стартует чистым (ADR-016).
 */
if (process.env.NODE_ENV === 'production') {
  console.error(
    'Демо-данные не ставятся на рабочий сервер (NODE_ENV=production): платформа стартует чистой, ' +
      'объект настраивается через интерфейс (ADR-016).',
  );
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error(
    'Не задана DATABASE_ADMIN_URL. Выполните `pnpm db:up` (создаст .env из .env.example) или задайте переменную.',
  );
  process.exit(1);
}

const pool = createPool({ connectionString: adminUrl, max: 1, applicationName: 'oxrana-seed' });
try {
  const report = await applySeed(createDb(pool), DEMO_SEED);
  const rows = Object.values(report);
  const described = rows.reduce((sum, r) => sum + r.described, 0);
  const inserted = rows.reduce((sum, r) => sum + r.inserted, 0);
  console.log(
    `Сид применён (${DEMO_SEED.site.name}): добавлено строк ${inserted}, уже было ${described - inserted}.`,
  );
} catch (error) {
  console.error('Сид не применён:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

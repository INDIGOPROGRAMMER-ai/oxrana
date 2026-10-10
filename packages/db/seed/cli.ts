import { createDb, createPool } from '../src';
import { applySeed, DEMO_SEED } from './index';

/** `pnpm db:seed`: демо-объект под владельцем схемы (`DATABASE_ADMIN_URL`). Идемпотентно. */
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
  console.log('Заглушки до ответа заказчика (ПРОВЕРИТЬ):');
  for (const item of DEMO_SEED.checkList) console.log(`  • ${item}`);
} catch (error) {
  console.error('Сид не применён:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

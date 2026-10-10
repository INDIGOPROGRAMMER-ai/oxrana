import { runMigrations } from './migrate';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error(
    'Не задана DATABASE_ADMIN_URL. Выполните `pnpm db:up` (создаст .env из .env.example) или задайте переменную.',
  );
  process.exit(1);
}

try {
  await runMigrations(adminUrl);
  console.log('Миграции применены.');
} catch (error) {
  console.error('Миграции не применены:', error instanceof Error ? error.message : error);
  process.exit(1);
}

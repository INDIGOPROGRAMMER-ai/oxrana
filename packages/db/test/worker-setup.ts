import { cloneTemplate, WORKER_DB_PREFIX, withDatabase } from './test-db';

/**
 * setupFile интеграционных тестов: перед каждым тестовым файлом воркер получает свежую копию
 * шаблона (`oxrana_test_w<VITEST_POOL_ID>`, ~0,2 с) и переводит на неё `DATABASE_URL` и
 * `DATABASE_ADMIN_URL`. Файлы не видят данных друг друга; внутри файла тесты сами следят за
 * изоляцией (уникальные данные или очистка).
 */
// Исходные адреса запоминаются один раз: процесс воркера переживает несколько тестовых файлов.
process.env.OXRANA_TEST_BASE_ADMIN_URL ??= process.env.DATABASE_ADMIN_URL;
process.env.OXRANA_TEST_BASE_URL ??= process.env.DATABASE_URL;
const baseAdminUrl = process.env.OXRANA_TEST_BASE_ADMIN_URL;
const baseAppUrl = process.env.OXRANA_TEST_BASE_URL;
if (!baseAdminUrl || !baseAppUrl) {
  throw new Error('Не заданы DATABASE_URL и DATABASE_ADMIN_URL. Выполните `pnpm db:up`.');
}

const database = `${WORKER_DB_PREFIX}${process.env.VITEST_POOL_ID ?? '0'}`;
await cloneTemplate(baseAdminUrl, database);

process.env.DATABASE_ADMIN_URL = withDatabase(baseAdminUrl, database);
process.env.DATABASE_URL = withDatabase(baseAppUrl, database);

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createDb, createPool } from '../src';
import { buildRuleSetFixture, fixturePath } from './fixture';
import { applySeed, DEMO_SEED } from './index';

/**
 * `pnpm fixture:engine`: применяет сид (идемпотентно) и замораживает срез правил демо-объекта в
 * JSON для тестов движка. Запускать после любого изменения сида или загрузчика RuleSet.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error('Не задана DATABASE_ADMIN_URL. Выполните `pnpm db:up` или задайте переменную.');
  process.exit(1);
}

const pool = createPool({ connectionString: adminUrl, max: 1, applicationName: 'oxrana-fixture' });
try {
  const db = createDb(pool);
  await applySeed(db, DEMO_SEED);
  const fixture = await buildRuleSetFixture(db, DEMO_SEED);
  const target = resolve(import.meta.dirname, '../../..', fixturePath(DEMO_SEED));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
  // Тот же вид, что даёт `pnpm format`: иначе следующий `pnpm lint` потребует переформатировать файл.
  execFileSync('pnpm', ['exec', 'biome', 'format', '--write', target], { stdio: 'ignore' });
  console.log(
    `Фикстура записана: ${fixturePath(DEMO_SEED)} (арендаторов ${fixture.rules.tenants.length}, лимитов ${fixture.rules.quotas.length}).`,
  );
} catch (error) {
  console.error('Фикстура не записана:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

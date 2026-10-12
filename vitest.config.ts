import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Переменные из .env (его создаёт `pnpm db:up`); в CI .env копируется из .env.example.
const env = loadEnv('test', process.cwd(), '');

export default defineConfig({
  test: {
    // Покрытие чистых пакетов (этап 3): `pnpm test:coverage`, порог — 95 % строк.
    coverage: {
      provider: 'v8',
      include: ['packages/engine/src/**', 'packages/plates/src/**'],
      reporter: ['text', 'text-summary'],
      thresholds: { lines: 95, functions: 95, statements: 95 },
    },
    projects: [
      {
        // Без БД: работает и без `pnpm db:up` (ADR-010 п. 3).
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
          env,
        },
      },
      {
        // Компонентные тесты (этап 6a): React в jsdom, без БД и сети.
        test: {
          name: 'components',
          include: ['{apps,packages}/*/test/**/*.test.tsx'],
          exclude: ['**/node_modules/**'],
          environment: 'jsdom',
          setupFiles: ['./packages/ui/test/setup.ts'],
          env,
        },
      },
      {
        // С реальным PostgreSQL (ADR-003 п. 6): нужен `pnpm db:up`. Глобальный setup пересоздаёт
        // шаблон oxrana_test_template с миграциями, worker-setup даёт каждому файлу свежую копию.
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          env,
          globalSetup: ['./packages/db/test/global-setup.ts'],
          setupFiles: ['./packages/db/test/worker-setup.ts'],
        },
      },
    ],
  },
});

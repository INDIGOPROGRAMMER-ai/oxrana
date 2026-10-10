import { defineConfig } from 'drizzle-kit';

// Схема появится на этапе 2 (docs/DATA_MODEL.md). Миграции — SQL-файлы, дописываются руками (ADR-003).
export default defineConfig({
  dialect: 'postgresql',
  out: './migrations',
  schema: './src/schema/index.ts',
});

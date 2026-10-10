import { defineConfig } from 'tsup';

// Рабочие пакеты монорепо лежат исходниками TypeScript — вшиваем их в сборку, остальное остаётся внешним.
// Внешним считается только то, что объявлено в dependencies самого api: поэтому `pg` (его использует вшитый
// @oxrana/db) перечислен и там — иначе CJS-код драйвера попал бы в ESM-бандл и сервер не запустился бы.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@oxrana\//],
});

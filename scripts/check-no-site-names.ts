import { readFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './walk';

/**
 * ADR-012 п. 7: название объекта, КПП и арендаторов живёт только в сиде и документах, в коде
 * приложения его нет. Список слов расширяется по мере появления данных.
 */
export const FORBIDDEN_NAMES = [
  'Радонеж',
  'ДНС',
  'КПП-1',
  'КПП-2',
  'КПП офис',
  'ДЛ-Транс',
  'Рельеф-Центр',
];

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.sql',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.sh',
]);

/**
 * Сюда названия можно: сид объекта, тесты движка и сценарные тесты API на демо-объекте (сценарии
 * приёмки названы его арендаторами и КПП, ADR-015, ADR-017) и сам этот список (по пути
 * относительно корня).
 */
const ALLOWED_PREFIXES = [
  'packages/db/seed/',
  'packages/engine/test/',
  'apps/api/test/scenarios/',
  'scripts/check-no-site-names.ts',
  'docs/',
  'pnpm-lock.yaml',
];

export interface NameViolation {
  file: string;
  name: string;
  line: number;
}

export function findSiteNames(root: string): NameViolation[] {
  const violations: NameViolation[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (!SCANNED_EXTENSIONS.has(extname(file))) continue;
    if (ALLOWED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        for (const name of FORBIDDEN_NAMES) {
          if (text.includes(name)) violations.push({ file: rel, name, line: index + 1 });
        }
      });
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findSiteNames(process.cwd());
  for (const v of found) {
    console.error(
      `${v.file}:${v.line}: в коде приложения не должно быть названия «${v.name}» (ADR-012 п. 7)`,
    );
  }
  process.exit(found.length > 0 ? 1 : 0);
}

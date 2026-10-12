import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './walk';

/**
 * ADR-006: все пути создания визита идут через checkIn() — прямых `insert` в `visits` в коде нет.
 * Единственное место вставки — `packages/db/src/queries/visits.ts` (`insertVisit`), его вызывает
 * только транзакция поста. Проверяются исходники `apps/*\/src` и `packages/*\/src`; тесты и сид
 * готовят данные как им удобно.
 */
export const VISIT_WRITER = 'packages/db/src/queries/visits.ts';
const INSERT_RE = /\.insert\(\s*(?:schema\.)?visits\s*\)/;

export interface VisitWriteViolation {
  file: string;
  line: number;
}

export function findVisitWrites(root: string): VisitWriteViolation[] {
  const violations: VisitWriteViolation[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/');
    if (!/^(apps|packages)\/[^/]+\/src\/.*\.tsx?$/.test(rel) || rel === VISIT_WRITER) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        if (INSERT_RE.test(text)) violations.push({ file: rel, line: index + 1 });
      });
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findVisitWrites(resolve(import.meta.dirname, '..'));
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line}: вставка в visits — только через insertVisit (${VISIT_WRITER})`,
    );
  }
  process.exit(violations.length > 0 ? 1 : 0);
}

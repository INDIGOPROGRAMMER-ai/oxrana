import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDependencyViolations } from './check-deps';
import { findPurityViolations } from './check-engine-purity';
import { FORBIDDEN_NAMES, findSiteNames } from './check-no-site-names';
import { findVisitWrites } from './check-visit-writes';

const REPO_ROOT = join(import.meta.dirname, '..');

const temps: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'oxrana-arch-'));
  temps.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('в коде нет названий объекта (ADR-012 п. 7)', () => {
  it('репозиторий чист', () => {
    expect(findSiteNames(REPO_ROOT)).toEqual([]);
  });

  it('находит название в коде приложения', () => {
    const name = FORBIDDEN_NAMES[0] ?? '';
    const root = fixture({ 'apps/api/src/x.ts': `export const site = '${name}';\n` });
    expect(findSiteNames(root)).toEqual([{ file: 'apps/api/src/x.ts', name, line: 1 }]);
  });

  it('в сиде и в документах названия разрешены', () => {
    const name = FORBIDDEN_NAMES[0] ?? '';
    const root = fixture({
      'packages/db/seed/site.ts': `export const site = '${name}';\n`,
      'docs/ARCHITECTURE.md': name,
    });
    expect(findSiteNames(root)).toEqual([]);
  });
});

describe('граф зависимостей (ADR-002)', () => {
  it('репозиторий чист', () => {
    expect(findDependencyViolations(REPO_ROOT)).toEqual([]);
  });

  it('движок не вправе зависеть от contracts и от внешних пакетов', () => {
    const root = fixture({
      'packages/engine/package.json': JSON.stringify({
        name: '@oxrana/engine',
        dependencies: { '@oxrana/contracts': 'workspace:*', zod: 'catalog:' },
      }),
    });
    const messages = findDependencyViolations(root).map((v) => v.message);
    expect(messages.some((m) => m.includes('не вправе зависеть от @oxrana/contracts'))).toBe(true);
    expect(messages.some((m) => m.includes('чистый пакет'))).toBe(true);
  });

  it('внешняя версия не из catalog: — нарушение', () => {
    const root = fixture({
      'packages/db/package.json': JSON.stringify({
        name: '@oxrana/db',
        dependencies: { pg: '^8.0.0' },
      }),
    });
    expect(findDependencyViolations(root).map((v) => v.message)).toEqual([
      expect.stringContaining('версия внешней зависимости берётся из catalog:'),
    ]);
  });

  it('чистый пакет не импортирует node:*, а относительный импорт не выходит за пакет', () => {
    const root = fixture({
      'packages/plates/package.json': JSON.stringify({ name: '@oxrana/plates' }),
      'packages/plates/src/a.ts':
        "import { readFileSync } from 'node:fs';\nimport x from '../../engine/src/index';\n",
    });
    const messages = findDependencyViolations(root).map((v) => v.message);
    expect(messages.some((m) => m.includes('node:fs'))).toBe(true);
    expect(messages.some((m) => m.includes('выходит за пределы пакета'))).toBe(true);
  });

  it('приложение не может зависеть от другого приложения', () => {
    const root = fixture({
      'apps/web/package.json': JSON.stringify({
        name: '@oxrana/web',
        dependencies: { '@oxrana/api': 'workspace:*' },
      }),
    });
    expect(findDependencyViolations(root).map((v) => v.message)).toEqual([
      expect.stringContaining('не вправе зависеть от @oxrana/api'),
    ]);
  });
});

describe('движок и номера — чистые функции (CLAUDE.md п. 1, ADR-009)', () => {
  it('репозиторий чист', () => {
    expect(findPurityViolations(REPO_ROOT)).toEqual([]);
  });

  it('находит системные часы, пояс среды, сеть и Node API', () => {
    const root = fixture({
      'packages/engine/src/bad.ts': [
        'const a = Date.now();',
        'const b = new Date();',
        'const c = new Date(0).getHours();',
        "const d = new Date(0).toLocaleString('ru-RU');",
        'const e = Math.random();',
        "import { readFileSync } from 'node:fs';",
        "const f = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit' });",
        'const g = fetch("/x");',
        'const ok = Date.now; // сам идентификатор без вызова не считается',
      ].join('\n'),
      'packages/plates/src/good.ts':
        "export const f = (i: number, timeZone: string) => new Intl.DateTimeFormat('ru-RU', { timeZone }).format(new Date(i));\n",
    });
    const found = findPurityViolations(root);
    expect(found.map((v) => v.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(found.every((v) => v.file === 'packages/engine/src/bad.ts')).toBe(true);
  });

  it('комментарии и тесты не проверяются', () => {
    const root = fixture({
      'packages/engine/src/doc.ts':
        '/**\n * Не используем Date.now().\n */\nexport const x = 1; // Date.now()\n',
      'packages/engine/src/x.test.ts': 'const t = Date.now();\n',
      'packages/plates/src/.keep': '',
    });
    expect(findPurityViolations(root)).toEqual([]);
  });
});

describe('версия движка', () => {
  it('ENGINE_VERSION совпадает с версией пакета — она пишется в gate_decisions.engine_version', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/engine/package.json'), 'utf8'),
    ) as { version: string };
    const source = readFileSync(join(REPO_ROOT, 'packages/engine/src/evaluate.ts'), 'utf8');
    const version = /export const ENGINE_VERSION = '([^']+)'/.exec(source)?.[1];
    expect(version).toBe(pkg.version);
  });
});

describe('визиты создаются только через checkIn (ADR-006)', () => {
  it('репозиторий чист: insert в visits — только в packages/db/src/queries/visits.ts', () => {
    expect(findVisitWrites(REPO_ROOT)).toEqual([]);
  });

  it('находит прямую вставку визита в коде приложения, тесты не проверяет', () => {
    const root = fixture({
      'apps/api/src/x.ts': 'await tx.insert(schema.visits).values(v);\n',
      'apps/api/test/y.test.ts': 'await db.insert(schema.visits).values(v);\n',
      'packages/db/src/queries/visits.ts': 'await tx.insert(schema.visits).values(v);\n',
    });
    expect(findVisitWrites(root)).toEqual([{ file: 'apps/api/src/x.ts', line: 1 }]);
  });
});

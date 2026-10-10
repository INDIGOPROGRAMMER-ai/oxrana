import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDependencyViolations } from './check-deps';
import { FORBIDDEN_NAMES, findSiteNames } from './check-no-site-names';

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

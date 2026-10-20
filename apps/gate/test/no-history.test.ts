import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Файлы исходников поста (рекурсивно). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('пост охраны не знает об истории пропуска (7b.3, ADR-007)', () => {
  it('в apps/gate нет вызовов ленты, карточки пропуска и заявок на изменение', () => {
    const forbidden = [/\/passes\/[^'"`]*\/(history|card|change-requests)/, /pass\.history\.view/];
    for (const file of sources(join(__dirname, '../src'))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) expect(text, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });
});

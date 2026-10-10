import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './walk';

/**
 * CLAUDE.md п. 1, RULES_ENGINE: движок и пакет номеров — чистые функции без системных часов,
 * случайности, сети, файлов и пояса среды. Время приходит параметром, локальные вычисления —
 * только через `Intl.DateTimeFormat` с явным `timeZone` (ADR-009 п. 2, 4).
 */
export const PURE_PACKAGE_DIRS = ['packages/engine/src', 'packages/plates/src'];

interface ForbiddenPattern {
  readonly pattern: RegExp;
  readonly message: string;
}

export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { pattern: /\bDate\.now\s*\(/, message: 'системные часы: время передаётся параметром `now`' },
  {
    pattern: /\bnew\s+Date\s*\(\s*\)/,
    message: '`new Date()` без аргумента читает системные часы',
  },
  { pattern: /\bMath\.random\s*\(/, message: 'случайность ломает детерминизм вердикта' },
  { pattern: /\bperformance\.now\s*\(/, message: 'системные часы' },
  {
    pattern: /\b(?:setTimeout|setInterval|queueMicrotask)\s*\(/,
    message: 'таймеры и асинхронность',
  },
  { pattern: /\bfetch\s*\(/, message: 'сеть' },
  { pattern: /\bprocess\.(?:env|hrtime|cwd|argv)\b/, message: 'окружение процесса' },
  {
    pattern: /\bglobalThis\b|\bwindow\b|\bdocument\b|\bnavigator\b/,
    message: 'глобальные объекты среды',
  },
  { pattern: /\bimport\s*\(/, message: 'динамический импорт' },
  { pattern: /\brequire\s*\(/, message: 'CommonJS require' },
  { pattern: /\bfrom\s+['"]node:/, message: 'Node API: движок исполняется и в браузере' },
  {
    pattern: /\.toLocale(?:Date|Time)?String\s*\(/,
    message: 'форматирование в поясе среды: используйте Intl.DateTimeFormat с timeZone',
  },
  { pattern: /\.getTimezoneOffset\s*\(/, message: 'пояс среды' },
  {
    pattern: /\.(?:getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)\s*\(/,
    message: 'геттеры Date в поясе среды: используйте Intl.DateTimeFormat с timeZone',
  },
  {
    pattern: /\.(?:setFullYear|setMonth|setDate|setHours|setMinutes|setSeconds)\s*\(/,
    message: 'сеттеры Date в поясе среды',
  },
  {
    pattern: /\bIntl\.DateTimeFormat\s*\((?![^)]*timeZone)[^)]*\)/,
    message: 'Intl.DateTimeFormat без явного timeZone берёт пояс среды',
  },
  {
    pattern: /\bconsole\.\w+\s*\(/,
    message: 'вывод в консоль: движок возвращает trace, а не пишет логи',
  },
];

export interface PurityViolation {
  file: string;
  line: number;
  message: string;
}

export function findPurityViolations(root: string): PurityViolation[] {
  const violations: PurityViolation[] = [];
  for (const dir of PURE_PACKAGE_DIRS) {
    for (const file of walk(resolve(root, dir))) {
      if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      const rel = relative(root, file).split(sep).join('/');
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const code = text.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
          if (/^\s*\*/.test(code)) return; // строка внутри блочного комментария
          for (const { pattern, message } of FORBIDDEN_PATTERNS) {
            if (pattern.test(code)) violations.push({ file: rel, line: index + 1, message });
          }
        });
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findPurityViolations(process.cwd());
  for (const v of found) console.error(`${v.file}:${v.line}: ${v.message}`);
  process.exit(found.length > 0 ? 1 : 0);
}

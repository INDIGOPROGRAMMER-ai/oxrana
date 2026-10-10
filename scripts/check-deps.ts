import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from './walk';

/**
 * ADR-002, ADR-015: зависимости между пакетами идут только «вниз»; чистые пакеты (engine, plates)
 * без внешних зависимостей, engine → plates (нечёткие номера), db → engine (сборка RuleSet);
 * внешние версии берутся из pnpm catalog.
 */
const WORKSPACE_RULES: Record<string, { internal: string[]; external?: string[]; pure?: boolean }> =
  {
    '@oxrana/engine': { internal: ['@oxrana/plates'], external: [], pure: true },
    '@oxrana/plates': { internal: [], external: [], pure: true },
    '@oxrana/contracts': { internal: [], external: ['zod'], pure: true },
    '@oxrana/db': { internal: ['@oxrana/contracts', '@oxrana/engine'] },
    '@oxrana/hardware': { internal: ['@oxrana/contracts'], pure: true },
    '@oxrana/ui': { internal: ['@oxrana/contracts'] },
  };

const APP_MAY_USE = new Set(Object.keys(WORKSPACE_RULES));

export interface DepViolation {
  where: string;
  message: string;
}

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function workspaceDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const group of ['apps', 'packages']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, 'package.json'))) {
        dirs.push(join(base, entry.name));
      }
    }
  }
  return dirs;
}

const IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

export function findDependencyViolations(root: string): DepViolation[] {
  const violations: DepViolation[] = [];
  const add = (where: string, message: string) => violations.push({ where, message });

  for (const dir of workspaceDirs(root)) {
    const rel = relative(root, dir).split(sep).join('/');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
    const isApp = rel.startsWith('apps/');
    const rule = WORKSPACE_RULES[pkg.name];

    if (!isApp && !rule) {
      add(
        rel,
        `пакет ${pkg.name} не описан в WORKSPACE_RULES (scripts/check-deps.ts): добавьте правило слоёв`,
      );
      continue;
    }

    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const internalDeclared = Object.keys(declared).filter((name) => name.startsWith('@oxrana/'));

    for (const [name, version] of Object.entries(declared)) {
      if (name.startsWith('@oxrana/')) {
        if (version !== 'workspace:*')
          add(`${rel}/package.json`, `${name}: рабочие пакеты подключаются как workspace:*`);
      } else if (version !== 'catalog:') {
        add(
          `${rel}/package.json`,
          `${name}: версия внешней зависимости берётся из catalog: (pnpm-workspace.yaml), а не «${version}»`,
        );
      }
    }

    for (const name of internalDeclared) {
      if (isApp ? !APP_MAY_USE.has(name) : !rule?.internal.includes(name)) {
        add(
          `${rel}/package.json`,
          `${pkg.name} не вправе зависеть от ${name} (ADR-002: зависимости только вниз)`,
        );
      }
    }

    if (rule?.pure) {
      const allowed = new Set(rule.external ?? []);
      for (const name of Object.keys(declared).filter((n) => !n.startsWith('@oxrana/'))) {
        if (!allowed.has(name))
          add(`${rel}/package.json`, `${pkg.name} — чистый пакет, ему нельзя зависеть от ${name}`);
      }
    }

    // Фактические импорты в исходниках.
    for (const file of walk(dir)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const fileRel = relative(root, file).split(sep).join('/');
      const isTest = fileRel.includes('/test/');
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? '';
        if (spec.startsWith('@oxrana/')) {
          const name = spec.split('/').slice(0, 2).join('/');
          if (name !== pkg.name && !internalDeclared.includes(name)) {
            add(fileRel, `импорт ${name} не объявлен в package.json пакета ${pkg.name}`);
          }
        } else if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (relative(dir, target).startsWith('..')) {
            add(
              fileRel,
              `относительный импорт «${spec}» выходит за пределы пакета: используйте @oxrana/*`,
            );
          }
        } else if (rule?.pure && !isTest && spec.startsWith('node:')) {
          add(fileRel, `${pkg.name} исполняется и в браузере: импорт «${spec}» запрещён`);
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findDependencyViolations(process.cwd());
  for (const v of found) console.error(`${v.where}: ${v.message}`);
  process.exit(found.length > 0 ? 1 : 0);
}

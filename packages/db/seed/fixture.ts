import type { Db } from '../src';
import { loadRuleSet, type SiteRuleSet } from '../src/queries/ruleset';
import { seedId } from './ids';
import type { SeedData } from './types';

/**
 * Фикстура движка: срез правил демо-объекта из БД после сида плюс карта «ключ сида → id», чтобы
 * тесты движка обращались к арендаторам, КПП и лимитам по ключам (`dns`, `kpp2`, `dns/trucks`),
 * а не по названиям. Замораживается в JSON скриптом `pnpm fixture:engine`; интеграционный тест
 * `packages/db/test/ruleset.integration.test.ts` следит, чтобы фикстура не отстала от сида.
 */
export interface RuleSetFixture extends SiteRuleSet {
  readonly $comment: string;
  readonly seed: string;
  readonly keys: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly tenants: Record<string, string>;
    readonly gates: Record<string, string>;
    readonly zones: Record<string, string>;
    readonly categories: Record<string, string>;
    /** «арендатор/лимит»: `dns/trucks`. */
    readonly quotas: Record<string, string>;
    readonly exceptions: Record<string, string>;
    readonly timeWindowPolicies: Record<string, string>;
    /** Номер дока → id. */
    readonly docks: Record<string, string>;
  };
}

/** Момент, на который берётся срез: начало действия сида (назначения доков и договоры). */
export function fixtureAsOf(data: SeedData): Date {
  return new Date(data.validFrom.instant);
}

export function fixtureKeys(data: SeedData): RuleSetFixture['keys'] {
  const id = (...parts: string[]) => seedId(data.organization.key, ...parts);
  const map = <T>(items: readonly T[], key: (item: T) => string, ...prefix: string[]) =>
    Object.fromEntries(items.map((item) => [key(item), id(...prefix, key(item))]));
  return {
    organizationId: id('organization'),
    siteId: id('site', data.site.key),
    tenants: map(data.tenants, (t) => t.key, 'tenant'),
    gates: map(data.gates, (g) => g.key, 'gate'),
    zones: map(data.zones, (z) => z.key, 'zone'),
    categories: map(data.categories, (c) => c, 'category'),
    quotas: Object.fromEntries(
      data.tenants.flatMap((t) =>
        t.quotas.map((q) => [`${t.key}/${q.key}`, id('quota', t.key, q.key)]),
      ),
    ),
    exceptions: map(data.exceptions, (e) => e.key, 'exception'),
    timeWindowPolicies: map(data.timeWindowPolicies, (p) => p.key, 'time-window'),
    docks: map(data.docks, (d) => d.number, 'dock'),
  };
}

/** Срез правил демо-объекта из базы, куда уже применён сид. */
export async function buildRuleSetFixture(db: Db, data: SeedData): Promise<RuleSetFixture> {
  const keys = fixtureKeys(data);
  const loaded = await loadRuleSet(db, {
    organizationId: keys.organizationId,
    siteId: keys.siteId,
    asOf: fixtureAsOf(data),
  });
  return {
    $comment:
      'Сгенерировано скриптом pnpm fixture:engine из сида packages/db/seed — руками не править.',
    seed: data.site.key,
    site: loaded.site,
    rules: loaded.rules,
    keys,
  };
}

/** Путь фикстуры относительно корня репозитория. */
export function fixturePath(data: SeedData): string {
  return `packages/engine/test/fixtures/${data.site.key}.ruleset.json`;
}

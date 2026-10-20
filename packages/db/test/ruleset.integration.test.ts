import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySeed, DEMO_SEED } from '../seed';
import { buildRuleSetFixture, fixturePath, type RuleSetFixture } from '../seed/fixture';
import { createDb, createPool, schema } from '../src';
import { loadRuleSet } from '../src/queries/ruleset';

/**
 * Фикстура движка (`packages/engine/test/fixtures/*.ruleset.json`) = срез правил из базы после
 * сида. Отстала — тест падает с подсказкой перезапустить `pnpm fixture:engine`.
 */
const pool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const db = createDb(pool);
afterAll(async () => {
  await pool.end();
});

let fromDb: RuleSetFixture;
beforeAll(async () => {
  await applySeed(db, DEMO_SEED);
  fromDb = await buildRuleSetFixture(db, DEMO_SEED);
});

describe('фикстура RuleSet демо-объекта', () => {
  it('не отстала от сида (иначе: pnpm fixture:engine)', () => {
    const path = resolve(import.meta.dirname, '../../..', fixturePath(DEMO_SEED));
    const frozen = JSON.parse(readFileSync(path, 'utf8')) as RuleSetFixture;
    expect(
      frozen,
      `фикстура ${fixturePath(DEMO_SEED)} отстала от сида — выполните pnpm fixture:engine`,
    ).toEqual(JSON.parse(JSON.stringify(fromDb)));
  });

  it('все ключи сида есть в срезе', () => {
    const ids = (items: readonly { id: string }[]) => new Set(items.map((i) => i.id));
    for (const id of Object.values(fromDb.keys.tenants))
      expect(ids(fromDb.rules.tenants)).toContain(id);
    for (const id of Object.values(fromDb.keys.gates))
      expect(ids(fromDb.rules.gates)).toContain(id);
    for (const id of Object.values(fromDb.keys.quotas))
      expect(ids(fromDb.rules.quotas)).toContain(id);
    for (const id of Object.values(fromDb.keys.exceptions)) {
      expect(ids(fromDb.rules.exceptions)).toContain(id);
    }
    for (const id of Object.values(fromDb.keys.categories)) {
      expect(ids(fromDb.rules.categories)).toContain(id);
    }
  });

  it('доки закреплены за арендаторами, лимит «по докам» совпадает с числом доков', () => {
    const dns = fromDb.keys.tenants.dns ?? '';
    const docks = fromDb.rules.docks.filter((d) => d.tenantId === dns && d.countsInQuota);
    const trucks = fromDb.rules.quotas.find((q) => q.id === fromDb.keys.quotas['dns/trucks']);
    expect(trucks?.capacityFromDocks).toBe(true);
    expect(docks).toHaveLength(trucks?.capacity ?? -1);
  });

  it('чужая организация срез не получает', async () => {
    await expect(
      loadRuleSet(db, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        siteId: fromDb.keys.siteId,
        asOf: new Date(),
      }),
    ).rejects.toThrow(/не найден/);
  });
});

describe('порядок типов транспорта', () => {
  it('в срезе — порядок справочника (sort), а не порядок идентификаторов', async () => {
    const organizationId = fromDb.keys.organizationId;
    const siteId = fromDb.keys.siteId;
    const before = await db
      .select({ id: schema.vehicleCategories.id, sort: schema.vehicleCategories.sort })
      .from(schema.vehicleCategories)
      .where(eq(schema.vehicleCategories.organizationId, organizationId));
    const ids = (
      await loadRuleSet(db, { organizationId, siteId, asOf: new Date() })
    ).rules.categories.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(1);
    const reversed = [...ids].reverse();
    try {
      // справочник перестроен: порядок типов обратный
      for (const [index, id] of reversed.entries()) {
        await db
          .update(schema.vehicleCategories)
          .set({ sort: (index + 1) * 10 })
          .where(eq(schema.vehicleCategories.id, id));
      }
      const { rules } = await loadRuleSet(db, { organizationId, siteId, asOf: new Date() });
      expect(rules.categories.map((c) => c.id)).toEqual(reversed);
    } finally {
      for (const row of before) {
        await db
          .update(schema.vehicleCategories)
          .set({ sort: row.sort })
          .where(eq(schema.vehicleCategories.id, row.id));
      }
    }
  });
});

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySeed, DEMO_SEED, seedId } from '../seed';
import { createDb, createPool, findUsages, schema, softDelete } from '../src';

/** Мягкое удаление справочников с подсчётом ссылок (CLAUDE.md п. 10) — на уровне запросов. */
const pool = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const db = createDb(pool);
afterAll(() => pool.end());

const id = (...parts: string[]) => seedId(DEMO_SEED.organization.key, ...parts);
/** КПП для грузовых: второй в списке сида, у него есть правила маршрута. */
const truckGate = DEMO_SEED.gates[1]?.key ?? '';
const rulesToTruckGate = DEMO_SEED.routing.filter((r) => r.gateKey === truckGate);

beforeAll(async () => {
  await applySeed(db, DEMO_SEED);
});

describe('сценарий 32: удаление КПП, у которого есть правила маршрута', () => {
  it('показывает, где КПП используется: правила маршрута и учётка поста', async () => {
    expect(rulesToTruckGate.length).toBeGreaterThan(0);
    expect(await findUsages(db, schema.gates, id('gate', truckGate))).toEqual([
      { table: 'routing_rules', column: 'gate_id', count: rulesToTruckGate.length },
      { table: 'gate_accounts', column: 'gate_id', count: 1 },
    ]);
  });

  it('мягко удалённое правило больше не считается', async () => {
    const rule = rulesToTruckGate[0];
    const ruleId = id(
      'routing',
      rule?.tenantKey ?? '*',
      rule?.participant ?? '',
      rule?.category ?? '*',
      rule?.destinationZoneKey ?? '*',
      truckGate,
    );
    expect(await softDelete(db, schema.routingRules, ruleId)).toBe(true);
    const usages = await findUsages(db, schema.gates, id('gate', truckGate));
    expect(usages.find((u) => u.table === 'routing_rules')?.count).toBe(
      rulesToTruckGate.length - 1,
    );
  });

  it('удаление мягкое: строка остаётся с deleted_at, ссылки и история целы', async () => {
    const gateId = id('gate', truckGate);
    expect(await softDelete(db, schema.gates, gateId)).toBe(true);
    const [gate] = await db.select().from(schema.gates).where(eq(schema.gates.id, gateId));
    expect(gate?.deletedAt).toBeInstanceOf(Date);
    expect(await softDelete(db, schema.gates, gateId)).toBe(false);
    const rules = await db
      .select()
      .from(schema.routingRules)
      .where(eq(schema.routingRules.gateId, gateId));
    expect(rules).toHaveLength(rulesToTruckGate.length);
  });

  it('таблицу без deleted_at мягко удалить нельзя', async () => {
    await expect(softDelete(db, schema.visits, id('nothing'))).rejects.toThrow(/deleted_at/);
  });
});

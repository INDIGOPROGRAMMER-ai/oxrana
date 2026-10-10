import { randomUUID } from 'node:crypto';
import { schema } from '@oxrana/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEYS, ownerDb, seedDemo, startTestApp, type TestApp } from '../support/harness';
import { categoryKey, dnsTruck, fillVisits, kpp1, kpp2, tenantKey } from './gate-helpers';

/**
 * Сценарий 37 (ADR-006): гонка за последнее место. Пул приложения — 2 соединения, 20 параллельных
 * «Впустить» по разным машинам ДНС при «Грузовые» 24/25. Между чтением занятости и записью визита
 * транзакция спит (точка внедрения `afterOccupancyRead`), чтобы окно гонки было заведомо шире
 * времени запроса: без блокировки арендатора прошли бы несколько машин.
 */
let t: TestApp;
const dns = tenantKey('dns');

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp({
    poolSize: 2,
    hooks: {
      afterOccupancyRead: async (tx) => {
        await tx.execute(sql`select pg_sleep(0.02)`);
      },
    },
  });
});
afterAll(() => t.close());

describe('сценарий 37: гонка за последнее место', () => {
  it('2 соединения, 20 параллельных въездов на последнее место — проходит ровно один', async () => {
    await fillVisits(dns, categoryKey('semi'), 24);
    const passes: string[] = [];
    for (let i = 0; i < 20; i++) {
      // половина — малотоннажные на КПП-1, половина — фуры на КПП-2: оба типа в лимите «Грузовые»
      passes.push(
        await dnsTruck(
          t,
          i % 2 === 0 ? {} : { categoryId: categoryKey('light_truck'), dockId: KEYS.docks['13'] },
        ),
      );
    }
    const responses = await Promise.all(
      passes.map((passId, i) =>
        t.as(i % 2 === 0 ? kpp2 : kpp1, {
          method: 'POST',
          url: '/gate/actions',
          payload: { id: randomUUID(), type: 'check_in', passId },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
    const outcomes = responses.map((r) => r.json() as { outcome: string; code: string });
    expect(outcomes.filter((o) => o.outcome === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'rejected' && o.code === 'wait')).toHaveLength(19);

    const open = await ownerDb()
      .select({ id: schema.visits.id })
      .from(schema.visits)
      .where(and(eq(schema.visits.tenantId, dns), isNull(schema.visits.timeOut)));
    expect(open).toHaveLength(25);
    const losers = responses.map((r) => r.json()).filter((o) => o.outcome === 'rejected');
    expect(losers.every((o) => /25\/25/.test(o.verdict.headline))).toBe(true);
  });
});

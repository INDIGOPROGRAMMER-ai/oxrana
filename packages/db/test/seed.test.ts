import { describe, expect, it } from 'vitest';
import { applySeed, DEMO_SEED, type SeedData, seedId } from '../seed';
import type { Db } from '../src';

describe('id строк сида (UUIDv5)', () => {
  it('детерминирован и отличает ключи', () => {
    expect(seedId('org', 'tenant', 'a')).toBe(seedId('org', 'tenant', 'a'));
    expect(seedId('org', 'tenant', 'a')).not.toBe(seedId('org', 'tenant', 'b'));
  });

  it('формат UUID версии 5', () => {
    expect(seedId('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('проверка данных сида до записи', () => {
  // До БД дело не доходит: ошибки данных ловятся валидацией.
  const noDb = {} as Db;
  const clone = (): SeedData => structuredClone(DEMO_SEED);

  it('док не может быть назначен двум арендаторам', async () => {
    const data = clone();
    const dock = data.tenants.find((t) => t.docks.length > 0)?.docks[0] ?? '';
    data.tenants.at(-1)?.docks.push(dock);
    await expect(applySeed(noDb, data)).rejects.toThrow(/назначен и/);
  });

  it('лимит «по докам» обязан совпадать с числом доков', async () => {
    const data = clone();
    const quota = data.tenants.flatMap((t) => t.quotas).find((q) => q.capacityFromDocks);
    if (quota) quota.capacity += 1;
    await expect(applySeed(noDb, data)).rejects.toThrow(/доков в лимите/);
  });

  it('ссылка на невключённый тип или несуществующий КПП — ошибка', async () => {
    const data = clone();
    data.routing.push({ participant: 'vehicle', category: 'bus', gateKey: 'nope' });
    await expect(applySeed(noDb, data)).rejects.toThrow(/нет/);
  });

  it('неверное рабочее время — ошибка схемы', async () => {
    const data = clone();
    if (data.site.workingHours) data.site.workingHours.mon = [['20:00', '08:00']];
    await expect(applySeed(noDb, data)).rejects.toThrow();
  });
});

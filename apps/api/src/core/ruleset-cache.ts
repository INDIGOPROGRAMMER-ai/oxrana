import { type Db, type DbTx, loadRuleSet, type SiteRuleSet } from '@oxrana/db';
import type { Clock } from '../clock';

/**
 * Срез правил объекта для движка (RULES_ENGINE §1) с кэшем на 5 с. Изменение правил сбрасывает
 * кэш сразу в этом процессе (`Ctx.tx` после коммита) и в остальных — по событию `rules.changed`
 * из LISTEN (ADR-004). Загрузка идёт тем же соединением, что и вызывающая транзакция: второе
 * соединение из пула при маленьком пуле означало бы взаимную блокировку.
 */
export class RuleSetCache {
  private readonly entries = new Map<string, { at: number; value: Promise<SiteRuleSet> }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs = 5_000,
  ) {}

  get(db: Db | DbTx, organizationId: string, siteId: string): Promise<SiteRuleSet> {
    const key = `${organizationId}:${siteId}`;
    const now = this.clock.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.at < this.ttlMs) return cached.value;
    const value = loadRuleSet(db, { organizationId, siteId, asOf: new Date(now) });
    this.entries.set(key, { at: now, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** Сбросить срез объекта (или всех объектов организации, если `siteId` не известен). */
  invalidate(organizationId: string, siteId: string | null): void {
    if (siteId !== null) {
      this.entries.delete(`${organizationId}:${siteId}`);
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${organizationId}:`)) this.entries.delete(key);
    }
  }
}

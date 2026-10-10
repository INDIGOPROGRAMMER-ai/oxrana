import { and, asc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { DbTx } from '../client';
import * as schema from '../schema';

/**
 * Визиты (CLAUDE.md п. 3, ADR-006). **Это единственный модуль, который вставляет строки в
 * `visits`** — проверяет архитектурный тест; создаёт визит только `checkIn()` сервиса поста
 * (и синхронизация офлайна через него же), всегда под блокировкой арендатора.
 */

export type VisitRow = typeof schema.visits.$inferSelect;
export type NewVisit = typeof schema.visits.$inferInsert;

/**
 * Очередь на въезд по арендатору (ADR-006): одна advisory-блокировка до конца транзакции. Ключ —
 * арендатор, а не лимит: тип может входить в несколько лимитов, порядок захвата не нужен.
 */
export async function lockTenantForEntry(tx: DbTx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tenant:${tenantId}`}))`);
}

/** Открытые визиты (въехал и не выехал). Читать после `lockTenantForEntry` — тогда свежие. */
export function openVisits(
  tx: DbTx,
  filter: { organizationId: string; siteId: string; tenantId?: string },
): Promise<VisitRow[]> {
  const conditions: SQL[] = [
    eq(schema.visits.organizationId, filter.organizationId),
    eq(schema.visits.siteId, filter.siteId),
    isNull(schema.visits.timeOut),
  ];
  if (filter.tenantId) conditions.push(eq(schema.visits.tenantId, filter.tenantId));
  return tx
    .select()
    .from(schema.visits)
    .where(and(...conditions))
    .orderBy(asc(schema.visits.timeIn), asc(schema.visits.id));
}

/** Вставка визита — только из транзакции въезда под `lockTenantForEntry`. */
export async function insertVisit(tx: DbTx, values: NewVisit): Promise<VisitRow> {
  const [row] = await tx.insert(schema.visits).values(values).returning();
  if (!row) throw new Error('visits: insert не вернул строку');
  return row;
}

/**
 * Закрыть открытый визит. Возвращает `null`, если его уже закрыли (выезд с другого КПП в ту же
 * секунду): условие `time_out is null` делает выезд идемпотентным без блокировки.
 */
export async function closeVisit(
  tx: DbTx,
  organizationId: string,
  visitId: string,
  values: Partial<NewVisit> & { timeOut: Date },
): Promise<VisitRow | null> {
  const [row] = await tx
    .update(schema.visits)
    .set(values)
    .where(
      and(
        eq(schema.visits.organizationId, organizationId),
        eq(schema.visits.id, visitId),
        isNull(schema.visits.timeOut),
      ),
    )
    .returning();
  return row ?? null;
}

/** Правка визита отменой действия (флаг undone, повторное открытие). */
export async function updateVisit(
  tx: DbTx,
  organizationId: string,
  visitId: string,
  values: Partial<NewVisit>,
): Promise<VisitRow | null> {
  const [row] = await tx
    .update(schema.visits)
    .set(values)
    .where(and(eq(schema.visits.organizationId, organizationId), eq(schema.visits.id, visitId)))
    .returning();
  return row ?? null;
}

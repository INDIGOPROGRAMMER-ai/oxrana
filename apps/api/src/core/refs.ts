import { and, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AppError } from '../errors';
import type { Scope } from './context';

/** Код ошибки PostgreSQL под обёрткой Drizzle (DrizzleQueryError → cause). */
export function pgErrorCode(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const e = current as Error & { code?: unknown; constraint?: unknown };
    if (typeof e.code === 'string') {
      return {
        code: e.code,
        ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
      };
    }
    current = e.cause;
  }
  return {};
}

export const UNIQUE_VIOLATION = '23505';
export const EXCLUSION_VIOLATION = '23P01';
export const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Ссылка из тела запроса указывает на запись того же объекта и организации, не удалённую.
 * Иначе — ошибка с полем формы (CLAUDE.md п. 8), а не 500 от внешнего ключа.
 */
export async function assertRef(
  s: Scope,
  table: PgTable,
  id: string | null | undefined,
  options: { siteId?: string; tenantId?: string; field: string; title: string },
): Promise<void> {
  if (id === null || id === undefined) return;
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const conditions: (SQL | undefined)[] = [
    eq(cols.organizationId as PgColumn, s.organizationId),
    eq(cols.id as PgColumn, id),
    cols.deletedAt ? isNull(cols.deletedAt) : undefined,
  ];
  if (options.siteId && cols.siteId) conditions.push(eq(cols.siteId, options.siteId));
  if (options.tenantId && cols.tenantId) conditions.push(eq(cols.tenantId, options.tenantId));
  const rows = await s.db
    .select({ id: cols.id as PgColumn })
    .from(table)
    .where(and(...conditions));
  if (rows.length === 0) {
    throw new AppError('validation_failed', {
      field: options.field,
      message: `${options.title}: запись не найдена на этом объекте. Выберите из списка.`,
    });
  }
}

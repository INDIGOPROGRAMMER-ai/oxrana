import { and, count, eq, getTableName, is, isNull, type SQL, sql } from 'drizzle-orm';
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db, DbTx } from '../client';
import * as schema from '../schema';

/**
 * Мягкое удаление справочников с показом, где элемент используется (CLAUDE.md п. 10, сценарий 32):
 * «КПП используется в 4 правилах маршрута — удалить?». Ссылки берутся из внешних ключей схемы,
 * поэтому новая таблица со ссылкой попадает в подсчёт без правки этого файла.
 */

export interface Usage {
  /** Таблица, которая ссылается на элемент. */
  table: string;
  /** Колонка со ссылкой. */
  column: string;
  /** Сколько строк ссылается; мягко удалённые строки не считаются. */
  count: number;
}

interface Reference {
  table: PgTable;
  column: PgColumn;
  deletedAt: PgColumn | undefined;
}

const TABLES: PgTable[] = Object.values(schema).filter((value) => is(value, PgTable));

/** Все одноколоночные внешние ключи, указывающие на `target`. */
function referencesTo(target: PgTable): Reference[] {
  const refs: Reference[] = [];
  for (const table of TABLES) {
    const config = getTableConfig(table);
    const deletedAt = config.columns.find((c) => c.name === 'deleted_at');
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const column = ref.columns[0];
      if (ref.foreignTable === target && ref.columns.length === 1 && column) {
        refs.push({ table, column, deletedAt });
      }
    }
  }
  return refs;
}

/** Где используется строка `id` таблицы `target`: только ненулевые счётчики, по убыванию. */
export async function findUsages(db: Db | DbTx, target: PgTable, id: string): Promise<Usage[]> {
  const usages: Usage[] = [];
  for (const ref of referencesTo(target)) {
    const conditions: SQL[] = [eq(ref.column, id)];
    if (ref.deletedAt) conditions.push(isNull(ref.deletedAt));
    const [row] = await db
      .select({ n: count() })
      .from(ref.table)
      .where(and(...conditions));
    const n = row?.n ?? 0;
    if (n > 0) usages.push({ table: getTableName(ref.table), column: ref.column.name, count: n });
  }
  return usages.sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
}

/**
 * Мягко удаляет строку справочника: ставит `deleted_at`, ссылки и история остаются. Возвращает
 * `false`, если строки нет или она уже удалена. Подтверждение по `findUsages` — дело вызывающего.
 */
export async function softDelete(db: Db | DbTx, target: PgTable, id: string): Promise<boolean> {
  const config = getTableConfig(target);
  if (!config.columns.some((c) => c.name === 'deleted_at')) {
    throw new Error(`Таблица ${config.name} не поддерживает мягкое удаление (нет deleted_at).`);
  }
  const result = await db.execute(
    sql`update ${target} set deleted_at = now() where id = ${id} and deleted_at is null`,
  );
  return (result.rowCount ?? 0) > 0;
}

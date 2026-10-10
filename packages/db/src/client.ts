import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DbPool } from './pool';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Транзакция Drizzle — тот же API, что у `Db`. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Drizzle поверх пула. Имена колонок в схеме заданы явно, настройка `casing` не нужна. */
export function createDb(pool: DbPool): Db {
  return drizzle({ client: pool, schema });
}

/**
 * Транзакция в контексте организации: `set local app.organization_id` — его читают политики RLS
 * (DATA_MODEL §4). Под ролью приложения без этого вызова бизнес-таблицы пусты. Явный фильтр по
 * `organization_id` в запросах всё равно обязателен: RLS — вторая линия.
 */
export function withOrganization<T>(
  db: Db,
  organizationId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

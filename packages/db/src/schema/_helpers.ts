import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  type PgPolicy,
  pgPolicy,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Общие куски схемы (DATA_MODEL, соглашения). Имена колонок пишутся явно в snake_case — без
 * настройки `casing`, чтобы SQL миграций и запросы читались одинаково.
 */

/** Ключ справочников и бизнес-таблиц. */
export const id = () => uuid('id').primaryKey().defaultRandom();

/** Ключ журналов (`bigint identity`): порядок записи, курсор для SSE и выгрузок. */
export const journalId = () =>
  bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

/** Время всегда `timestamptz` (UTC в хранении, CLAUDE.md п. 4). */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** `created_at`/`updated_at` редактируемых таблиц; `updated_at` ставит триггер `set_updated_at`. */
export const timestamps = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const createdAt = () => tstz('created_at').notNull().defaultNow();

/** Мягкое удаление справочников (CLAUDE.md п. 10). */
export const deletedAt = () => tstz('deleted_at');

/** Нулевой uuid для уникальности «null как значение» в выражениях `coalesce`. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function sqlList(values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z0-9_.]+$/.test(v)) throw new Error(`Недопустимое значение перечисления: ${v}`);
  }
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}

/**
 * `check (col in (...))` для перечисления из `packages/contracts`. Имя — `<таблица>_<колонка>_check`:
 * по нему тест сверяет БД с zod-схемой.
 */
export function enumCheck(table: string, column: AnyPgColumn, values: readonly string[]) {
  return check(`${table}_${column.name}_check`, sql`${column} in (${sqlList(values)})`);
}

/** `check (col <@ array[...])` для массива значений перечисления (флаги, снимаемые проверки). */
export function enumArrayCheck(table: string, column: AnyPgColumn, values: readonly string[]) {
  return check(
    `${table}_${column.name}_check`,
    sql`${column} <@ array[${sqlList(values)}]::text[]`,
  );
}

/**
 * Текущая организация запроса: приложение в начале транзакции делает
 * `set local app.organization_id = '<uuid>'` (DATA_MODEL §4). `nullif` нужен потому, что после
 * `set local` в прошлой транзакции настройка не пропадает, а становится пустой строкой.
 */
export const CURRENT_ORGANIZATION = sql.raw(
  "nullif(current_setting('app.organization_id', true), '')::uuid",
);

/**
 * RLS по организации — вторая линия защиты (ADR-003, DATA_MODEL §4). Владелец таблиц
 * (`oxrana_owner`: миграции, сид) политикам не подчиняется; приложение (`oxrana_app`) — подчиняется.
 */
export function organizationIsolation(column = 'organization_id'): PgPolicy {
  const own = sql`${sql.identifier(column)} = ${CURRENT_ORGANIZATION}`;
  return pgPolicy('organization_isolation', {
    as: 'permissive',
    for: 'all',
    using: own,
    withCheck: own,
  });
}

/**
 * RLS для таблиц-связок без `organization_id`: строка видна, если видна родительская запись
 * (подзапрос к родителю сам проходит через его политику).
 */
export function isolationThroughParent(parent: string, parentKey: AnyPgColumn): PgPolicy {
  const visible = sql`exists (select 1 from ${sql.identifier(parent)} p where p.id = ${parentKey})`;
  return pgPolicy('organization_isolation', {
    as: 'permissive',
    for: 'all',
    using: visible,
    withCheck: visible,
  });
}

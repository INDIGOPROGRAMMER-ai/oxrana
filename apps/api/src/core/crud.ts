import type { DomainEventType } from '@oxrana/contracts';
import { findUsages, schema, softDelete } from '@oxrana/db';
import { and, asc, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors';
import type { RoutePermission } from '../permission-guard';
import { type Ctx, ctxOf, type Scope } from './context';
import { changedFields, diffOf } from './diff';
import { type LabelKind, labelDiff } from './labels';
import { loadSite, loadTenant, notFound } from './loaders';
import { EXCLUSION_VIOLATION, pgErrorCode, UNIQUE_VIOLATION } from './refs';
import { usageView } from './usages';

/**
 * Типовые справочники объекта (зоны, КПП, доки, договоры, лимиты, маршруты…): список, карточка,
 * создание, PATCH только изменённых полей (CLAUDE.md п. 5), мягкое удаление с показом, где
 * используется (п. 10), аудит «было → стало» (п. 6) и событие в outbox (ADR-004) — одним кодом.
 * Ключи тела запроса совпадают с именами полей Drizzle (camelCase), поэтому тело ложится в
 * таблицу без ручного перекладывания; особые поля обрабатывает `prepare`.
 */

type Row = Record<string, unknown> & { id: string };

/** Родитель коллекции: в пути списка и создания, задаёт область проверки. */
export type ParentKind = 'site' | 'tenant' | 'contract';

export interface ScopeInfo {
  readonly siteId: string;
  readonly tenantId: string | null;
}

export interface ResourceSpec {
  /** Сущность в журнале аудита и событиях: 'zone', 'quota'. */
  readonly entity: string;
  /** «Зона» — в текстах ошибок. */
  readonly title: string;
  readonly table: PgTable;
  /** Сегмент пути: `/zones/:id`, `/sites/:siteId/zones`. */
  readonly collection: string;
  readonly parent: ParentKind;
  /** Колонка (поле Drizzle) со ссылкой на родителя: 'siteId', 'tenantId', 'contractId'. */
  readonly parentField: string;
  readonly read: RoutePermission | 'authenticated';
  readonly write: RoutePermission;
  readonly createSchema: z.ZodObject;
  readonly patchSchema: z.ZodObject;
  readonly viewSchema: z.ZodType;
  readonly toView: (row: Row, extra: unknown) => unknown;
  /** Поля-ссылки: в журнал пишутся названия (CLAUDE.md п. 6). */
  readonly labels?: Readonly<Record<string, LabelKind>>;
  /** Какое событие рассылать при изменении (по умолчанию — `rules.changed`). */
  readonly event?: Extract<DomainEventType, 'rules.changed' | 'site.changed' | 'tenant.changed'>;
  /**
   * Проверка и вычисление значений колонок перед записью. `input` — тело (для PATCH — только
   * присланные поля), `existing` — текущая строка при правке. Возвращает колонки для записи.
   */
  readonly prepare?: (
    s: Scope,
    input: Record<string, unknown>,
    existing: Row | null,
    scope: ScopeInfo,
  ) => Promise<Record<string, unknown>>;
  /** Связанные записи (набор типов лимита): записать и вернуть изменение для журнала. */
  readonly afterWrite?: (
    s: Scope,
    row: Row,
    input: Record<string, unknown>,
    existing: Row | null,
  ) => Promise<Record<string, { from: unknown; to: unknown }>>;
  /** Дополнительные данные для представления (набор типов лимита). */
  readonly loadExtras?: (s: Scope, rows: readonly Row[]) => Promise<Map<string, unknown>>;
  /** Дополнительный фильтр списка по query (`?tenantId=`) и области актора. */
  readonly listQuery?: z.ZodObject;
  readonly listFilter?: (ctx: Ctx, query: Record<string, unknown>) => (SQL | undefined)[];
  /** Где взять объект и арендатора записи (для проверки области и события). */
  readonly scopeOf: (s: Scope, row: Row) => Promise<ScopeInfo>;
  /** Удаление: мягкое (есть `deleted_at`) или жёсткое при отсутствии ссылок. По умолчанию — есть. */
  readonly deletable?: boolean;
  /** Сортировка списка. */
  readonly orderBy?: (column: (name: string) => PgColumn) => SQL[];
  /** Понятная ошибка при нарушении уникальности или exclusion (имя ограничения → ошибка). */
  readonly onConflict?: (constraint: string | undefined) => AppError;
}

/** Нарушение уникальности — понятная ошибка вместо 500. */
function translateWriteError(spec: ResourceSpec, error: unknown): unknown {
  const { code, constraint } = pgErrorCode(error);
  if (code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION) {
    return (
      spec.onConflict?.(constraint) ??
      new AppError('conflict', {
        message: `${spec.title}: такая запись уже есть. Проверьте значения и повторите.`,
      })
    );
  }
  return error;
}

const IdParams = z.strictObject({ id: z.uuid() });
const DeleteQuery = z.strictObject({ confirm: z.enum(['true', 'false']).optional() });
export const UsageSchema = z.object({
  table: z.string(),
  column: z.string(),
  label: z.string(),
  count: z.int(),
});
const DeleteResult = z.object({ deleted: z.literal(true), usages: z.array(UsageSchema) });
const UsagesResult = z.object({ usages: z.array(UsageSchema) });

function columns(table: PgTable): Record<string, PgColumn> {
  return getTableColumns(table) as Record<string, PgColumn>;
}

function col(table: PgTable, name: string): PgColumn {
  const c = columns(table)[name];
  if (!c) throw new Error(`В таблице нет колонки ${name}`);
  return c;
}

/** Родитель из пути: проверка существования и области. */
export async function resolveParent(
  s: Scope,
  parent: ParentKind,
  parentId: string,
): Promise<ScopeInfo> {
  if (parent === 'site') {
    const site = await loadSite(s, parentId);
    return { siteId: site.id, tenantId: null };
  }
  if (parent === 'tenant') {
    const tenant = await loadTenant(s, parentId);
    return { siteId: tenant.siteId, tenantId: tenant.id };
  }
  const [contract] = await s.db
    .select()
    .from(schema.contracts)
    .where(
      and(
        eq(schema.contracts.organizationId, s.organizationId),
        eq(schema.contracts.id, parentId),
        isNull(schema.contracts.deletedAt),
      ),
    );
  if (!contract) throw notFound('Договор');
  const tenant = await loadTenant(s, contract.tenantId);
  return { siteId: tenant.siteId, tenantId: tenant.id };
}

async function findRow(s: Scope, spec: ResourceSpec, id: string): Promise<Row> {
  const cols = columns(spec.table);
  const conditions: (SQL | undefined)[] = [
    eq(col(spec.table, 'organizationId'), s.organizationId),
    eq(col(spec.table, 'id'), id),
  ];
  if (cols.deletedAt) conditions.push(isNull(cols.deletedAt));
  const [row] = (await s.db
    .select()
    .from(spec.table)
    .where(and(...conditions))) as Row[];
  if (!row) throw notFound(spec.title);
  return row;
}

async function views(s: Scope, spec: ResourceSpec, rows: readonly Row[]): Promise<unknown[]> {
  const extras = spec.loadExtras ? await spec.loadExtras(s, rows) : new Map<string, unknown>();
  return rows.map((row) => spec.toView(row, extras.get(row.id)));
}

/** Тело без `undefined`: присланные поля PATCH. */
function provided(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

export function registerResource(app: FastifyInstance, spec: ResourceSpec): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const parentParam = `${spec.parent}Id`;
  const parentSegment = { site: 'sites', tenant: 'tenants', contract: 'contracts' }[spec.parent];
  const listPath = `/${parentSegment}/:${parentParam}/${spec.collection}`;
  const itemPath = `/${spec.collection}/:id`;
  const readConfig =
    spec.read === 'authenticated'
      ? { authenticated: true as const }
      : { permission: spec.read as RoutePermission };
  const tags = [spec.entity];
  const ParentParams = z.strictObject({ [parentParam]: z.uuid() });
  const event = spec.event ?? 'rules.changed';

  const emitChange = async (s: Scope, row: Row, scope: ScopeInfo, fields: string[]) => {
    if (event === 'tenant.changed') {
      await s.emit('tenant.changed', {
        siteId: scope.siteId,
        aggregate: 'tenant',
        aggregateId: scope.tenantId ?? row.id,
        payload: { tenantId: scope.tenantId ?? row.id, fields: fields.length ? fields : ['id'] },
      });
    } else if (event === 'site.changed') {
      await s.emit('site.changed', {
        siteId: scope.siteId,
        aggregate: 'site',
        aggregateId: scope.siteId,
        payload: { siteId: scope.siteId, fields: fields.length ? fields : ['id'] },
      });
    } else {
      await s.emit('rules.changed', {
        siteId: scope.siteId,
        aggregate: spec.entity,
        aggregateId: row.id,
        payload: { entity: spec.entity, entityId: row.id },
      });
    }
  };

  typed.get(
    listPath,
    {
      config: readConfig,
      schema: {
        tags,
        summary: `${spec.title}: список`,
        params: ParentParams,
        ...(spec.listQuery ? { querystring: spec.listQuery } : {}),
        response: { 200: z.object({ items: z.array(spec.viewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const parentId = (request.params as Record<string, string>)[parentParam] ?? '';
      const query = (request.query ?? {}) as Record<string, unknown>;
      return ctx.tx(async (s) => {
        await resolveParent(s, spec.parent, parentId);
        const cols = columns(spec.table);
        const conditions: (SQL | undefined)[] = [
          eq(col(spec.table, 'organizationId'), s.organizationId),
          eq(col(spec.table, spec.parentField), parentId),
          cols.deletedAt ? isNull(cols.deletedAt) : undefined,
          ...(spec.listFilter ? spec.listFilter(ctx, query) : []),
        ];
        const rows = (await s.db
          .select()
          .from(spec.table)
          .where(and(...conditions))
          .orderBy(
            ...(spec.orderBy
              ? spec.orderBy((name) => col(spec.table, name))
              : [asc(col(spec.table, 'id'))]),
          )) as Row[];
        return { items: await views(s, spec, rows) };
      });
    },
  );

  typed.get(
    itemPath,
    {
      config: readConfig,
      schema: {
        tags,
        summary: `${spec.title}: карточка`,
        params: IdParams,
        response: { 200: spec.viewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const row = await findRow(s, spec, request.params.id);
        await spec.scopeOf(s, row);
        const [view] = await views(s, spec, [row]);
        return view;
      });
    },
  );

  typed.post(
    listPath,
    {
      config: { permission: spec.write },
      schema: {
        tags,
        summary: `${spec.title}: создать`,
        params: ParentParams,
        body: spec.createSchema,
        response: { 201: spec.viewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const parentId = (request.params as Record<string, string>)[parentParam] ?? '';
      const input = provided(request.body as Record<string, unknown>);
      const view = await ctx.tx(async (s) => {
        const scope = await resolveParent(s, spec.parent, parentId);
        const prepared = spec.prepare ? await spec.prepare(s, input, null, scope) : input;
        const values = {
          ...prepared,
          organizationId: s.organizationId,
          [spec.parentField]: parentId,
        };
        const [row] = (await s.db
          .insert(spec.table)
          .values(values as PgInsertValue<PgTable>)
          .returning()
          .catch((error: unknown) => {
            throw translateWriteError(spec, error);
          })) as Row[];
        if (!row) throw new Error(`${spec.entity}: insert не вернул строку`);
        const related = spec.afterWrite ? await spec.afterWrite(s, row, input, null) : {};
        const written = Object.keys(prepared);
        const diff = await labelDiff(
          s,
          { ...diffOf(null, row, written), ...related },
          spec.labels ?? {},
        );
        await s.audit({
          siteId: scope.siteId,
          entity: spec.entity,
          entityId: row.id,
          action: 'create',
          diff,
        });
        await emitChange(s, row, scope, written);
        const [created] = await views(s, spec, [row]);
        return created;
      });
      return reply.status(201).send(view);
    },
  );

  typed.patch(
    itemPath,
    {
      config: { permission: spec.write },
      schema: {
        tags,
        summary: `${spec.title}: изменить (только переданные поля)`,
        params: IdParams,
        body: spec.patchSchema,
        response: { 200: spec.viewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const input = provided(request.body as Record<string, unknown>);
      return ctx.tx(async (s) => {
        const existing = await findRow(s, spec, request.params.id);
        const scope = await spec.scopeOf(s, existing);
        const prepared = spec.prepare ? await spec.prepare(s, input, existing, scope) : input;
        const fields = changedFields(existing, prepared);
        let row = existing;
        if (fields.length > 0) {
          const set = Object.fromEntries(fields.map((f) => [f, prepared[f]]));
          [row = existing] = (await s.db
            .update(spec.table)
            .set(set as PgUpdateSetSource<PgTable>)
            .where(
              and(
                eq(col(spec.table, 'organizationId'), s.organizationId),
                eq(col(spec.table, 'id'), existing.id),
              ),
            )
            .returning()
            .catch((error: unknown) => {
              throw translateWriteError(spec, error);
            })) as Row[];
        }
        const related = spec.afterWrite ? await spec.afterWrite(s, row, input, existing) : {};
        const changed = [...fields, ...Object.keys(related)];
        if (changed.length > 0) {
          const diff = await labelDiff(
            s,
            { ...diffOf(existing, row, fields), ...related },
            spec.labels ?? {},
          );
          await s.audit({
            siteId: scope.siteId,
            entity: spec.entity,
            entityId: row.id,
            action: 'update',
            diff,
          });
          await emitChange(s, row, scope, changed);
        }
        const [view] = await views(s, spec, [row]);
        return view;
      });
    },
  );

  if (spec.deletable === false) return;

  typed.get(
    `${itemPath}/usages`,
    {
      config: { permission: spec.write },
      schema: {
        tags,
        summary: `${spec.title}: где используется`,
        params: IdParams,
        response: { 200: UsagesResult },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const row = await findRow(s, spec, request.params.id);
        await spec.scopeOf(s, row);
        return { usages: (await findUsages(s.db, spec.table, row.id)).map(usageView) };
      });
    },
  );

  typed.delete(
    itemPath,
    {
      config: { permission: spec.write },
      schema: {
        tags,
        summary: `${spec.title}: удалить (мягко, с показом ссылок)`,
        params: IdParams,
        querystring: DeleteQuery,
        response: { 200: DeleteResult },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const confirmed = request.query.confirm === 'true';
      return ctx.tx(async (s) => {
        const row = await findRow(s, spec, request.params.id);
        const scope = await spec.scopeOf(s, row);
        const usages = (await findUsages(s.db, spec.table, row.id)).map(usageView);
        const soft = 'deletedAt' in columns(spec.table);
        if (usages.length > 0 && !soft) {
          throw new AppError('in_use', {
            message: `${spec.title} используется (${usages.map((u) => `${u.label} — ${u.count}`).join(', ')}) и не может быть удалён(а). Сначала уберите ссылки.`,
            details: { usages },
          });
        }
        if (usages.length > 0 && !confirmed) {
          throw new AppError('in_use', {
            message: `${spec.title} используется: ${usages.map((u) => `${u.label} — ${u.count}`).join(', ')}. История и ссылки сохранятся; чтобы удалить, подтвердите (confirm=true).`,
            details: { usages },
          });
        }
        if (soft) {
          await softDelete(s.db, spec.table, row.id);
        } else {
          await s.db
            .delete(spec.table)
            .where(
              and(
                eq(col(spec.table, 'organizationId'), s.organizationId),
                eq(col(spec.table, 'id'), row.id),
              ),
            );
        }
        await s.audit({
          siteId: scope.siteId,
          entity: spec.entity,
          entityId: row.id,
          action: 'delete',
          snapshot: { usages },
        });
        await emitChange(s, row, scope, ['deletedAt']);
        return { deleted: true as const, usages };
      });
    },
  );
}

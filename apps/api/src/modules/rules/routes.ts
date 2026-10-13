import {
  APPROVAL_CREATOR_KINDS,
  ApprovalPolicyCreateSchema,
  ApprovalPolicyGapSchema,
  ApprovalPolicyPatchSchema,
  ApprovalPolicyViewSchema,
  ExceptionCreateSchema,
  ExceptionListQuerySchema,
  type ExceptionMatch,
  ExceptionPatchSchema,
  ExceptionViewSchema,
  PASS_TYPES,
  QuotaCreateSchema,
  QuotaListQuerySchema,
  QuotaPatchSchema,
  QuotaViewSchema,
  RoutingRuleCreateSchema,
  RoutingRulePatchSchema,
  RoutingRuleViewSchema,
  SiteParamsSchema,
  TimeWindowPolicyCreateSchema,
  TimeWindowPolicyPatchSchema,
  TimeWindowPolicyViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { localDate } from '@oxrana/engine';
import { normalizePlate } from '@oxrana/plates';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf, type Scope } from '../../core/context';
import { registerResource } from '../../core/crud';
import { sameValue } from '../../core/diff';
import { loadSite } from '../../core/loaders';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { siteScope } from '../org/catalogs';
import { CREATOR_LABEL, PASS_TYPE_LABEL } from '../passes/validate';

type Row = Record<string, unknown> & { id: string };
const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? null
      : String(value);

/** Типы транспорта, видимые на объекте: организации или этого объекта, не удалённые. */
async function assertCategories(s: Scope, ids: readonly string[], siteId: string, field: string) {
  if (ids.length === 0) return [];
  const rows = await s.db
    .select({ id: schema.vehicleCategories.id, name: schema.vehicleCategories.name })
    .from(schema.vehicleCategories)
    .where(
      and(
        eq(schema.vehicleCategories.organizationId, s.organizationId),
        inArray(schema.vehicleCategories.id, [...ids]),
        isNull(schema.vehicleCategories.deletedAt),
        or(isNull(schema.vehicleCategories.siteId), eq(schema.vehicleCategories.siteId, siteId)),
      ),
    );
  if (rows.length !== new Set(ids).size) {
    throw new AppError('validation_failed', {
      field,
      message: 'Среди типов транспорта есть недоступный на объекте. Выберите типы из списка.',
    });
  }
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id) ?? '');
}

/** Даты действия: ISO → Date; окончание позже начала. */
function period(
  input: Record<string, unknown>,
  existing: Row | null,
  now: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.validFrom !== undefined) out.validFrom = new Date(String(input.validFrom));
  else if (!existing) out.validFrom = new Date(now);
  if (input.validTo !== undefined)
    out.validTo = input.validTo === null ? null : new Date(String(input.validTo));
  const from = (out.validFrom ?? existing?.validFrom) as Date;
  const to = (out.validTo !== undefined ? out.validTo : existing?.validTo) as Date | null;
  if (to && from && to.getTime() <= from.getTime()) {
    throw new AppError('invalid_period', {
      field: 'validTo',
      message: 'Окончание действия должно быть позже начала.',
    });
  }
  return out;
}

/** Запись набора типов (лимит, политика окна): заменить и вернуть изменение для журнала. */
async function syncCategories(
  s: Scope,
  kind: 'quota' | 'policy',
  ownerId: string,
  next: readonly string[] | undefined,
  isCreate: boolean,
): Promise<Record<string, { from: unknown; to: unknown }>> {
  if (next === undefined) return {};
  const table = kind === 'quota' ? schema.quotaCategories : schema.timeWindowPolicyCategories;
  const ownerColumn =
    kind === 'quota' ? schema.quotaCategories.quotaId : schema.timeWindowPolicyCategories.policyId;
  const current = (
    await s.db.select({ categoryId: table.categoryId }).from(table).where(eq(ownerColumn, ownerId))
  )
    .map((r) => r.categoryId)
    .sort();
  const target = [...new Set(next)].sort();
  if (!isCreate && sameValue(current, target)) return {};
  await s.db.delete(table).where(eq(ownerColumn, ownerId));
  if (target.length > 0) {
    await s.db
      .insert(table)
      .values(
        target.map((categoryId) =>
          kind === 'quota' ? { quotaId: ownerId, categoryId } : { policyId: ownerId, categoryId },
        ),
      );
  }
  return { categoryIds: { from: isCreate ? null : current, to: target } };
}

async function categoriesOf(
  s: Scope,
  kind: 'quota' | 'policy',
  rows: readonly Row[],
): Promise<Map<string, string[]>> {
  const ids = rows.map((r) => r.id);
  const result = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const table = kind === 'quota' ? schema.quotaCategories : schema.timeWindowPolicyCategories;
  const ownerColumn =
    kind === 'quota' ? schema.quotaCategories.quotaId : schema.timeWindowPolicyCategories.policyId;
  const links = await s.db
    .select({ owner: ownerColumn, categoryId: table.categoryId })
    .from(table)
    .where(inArray(ownerColumn, ids))
    .orderBy(asc(table.categoryId));
  for (const link of links) result.get(link.owner)?.push(link.categoryId);
  return result;
}

/** Сколько доков арендатора сейчас дают место в лимите «по докам». */
async function countingDocks(s: Scope, tenantId: string, siteId: string): Promise<number> {
  const site = await loadSite(s, siteId);
  const today = localDate(s.ctx.now(), site.timezone);
  const [row] = await s.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tenantDockAssignments)
    .innerJoin(schema.docks, eq(schema.docks.id, schema.tenantDockAssignments.dockId))
    .where(
      and(
        eq(schema.tenantDockAssignments.organizationId, s.organizationId),
        eq(schema.tenantDockAssignments.tenantId, tenantId),
        eq(schema.docks.countsInQuota, true),
        isNull(schema.docks.deletedAt),
        sql`${schema.tenantDockAssignments.validFrom} <= ${today}::date`,
        or(
          isNull(schema.tenantDockAssignments.validTo),
          sql`${schema.tenantDockAssignments.validTo} >= ${today}::date`,
        ),
      ),
    );
  return row?.n ?? 0;
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);

export function registerRulesModule(app: FastifyInstance): void {
  registerResource(app, {
    entity: 'quota',
    title: 'Лимит',
    table: schema.quotas,
    collection: 'quotas',
    parent: 'site',
    parentField: 'siteId',
    read: 'quota.manage',
    write: 'quota.manage',
    createSchema: QuotaCreateSchema,
    patchSchema: QuotaPatchSchema,
    viewSchema: QuotaViewSchema,
    listQuery: QuotaListQuerySchema,
    listFilter: (_ctx, query) => [
      typeof query.tenantId === 'string' ? eq(schema.quotas.tenantId, query.tenantId) : undefined,
    ],
    labels: { tenantId: 'tenant', basisClauseId: 'clause' },
    toView: (r, extra) => ({
      id: r.id,
      siteId: r.siteId,
      tenantId: r.tenantId,
      participant: r.participant,
      name: r.name,
      categoryIds: (extra as string[] | undefined) ?? [],
      capacity: r.capacity,
      capacityFromDocks: r.capacityFromDocks,
      counting: r.counting,
      enforcement: r.enforcement,
      overageTariffRub: r.overageTariffRub === null ? null : Number(r.overageTariffRub),
      overageCap: r.overageCap,
      schedule: r.schedule ?? null,
      basisClauseId: r.basisClauseId,
      validFrom: iso(r.validFrom),
      validTo: iso(r.validTo),
    }),
    loadExtras: (s, rows) => categoriesOf(s, 'quota', rows),
    prepare: async (s, input, existing, scope) => {
      const { categoryIds, validFrom: _f, validTo: _t, overageTariffRub, ...rest } = input;
      const out: Record<string, unknown> = { ...rest, ...period(input, existing, s.ctx.now()) };
      const tenantId = String(input.tenantId ?? existing?.tenantId);
      if (!existing) {
        await assertRef(s, schema.tenants, tenantId, {
          siteId: scope.siteId,
          field: 'tenantId',
          title: 'Арендатор',
        });
      }
      await assertClauseRef(s, input.basisClauseId, tenantId);
      const participant = (input.participant ?? existing?.participant ?? 'vehicle') as string;
      const ids = categoryIds as string[] | undefined;
      const names = ids ? await assertCategories(s, ids, scope.siteId, 'categoryIds') : [];
      if (participant === 'pedestrian' && ids && ids.length > 0) {
        throw new AppError('validation_failed', {
          field: 'categoryIds',
          message: 'Пешеходный лимит не содержит типов транспорта.',
        });
      }
      if (participant === 'vehicle' && !existing && (!ids || ids.length === 0)) {
        throw new AppError('validation_failed', {
          field: 'categoryIds',
          message:
            'Отметьте типы транспорта, которые считает лимит («Грузовые» = малотоннажный + фура + …).',
        });
      }
      if (participant === 'vehicle' && ids && ids.length === 0) {
        throw new AppError('validation_failed', {
          field: 'categoryIds',
          message: 'У лимита должен остаться хотя бы один тип транспорта.',
        });
      }
      if (!existing && input.name === undefined) {
        out.name = participant === 'pedestrian' ? 'Пешеходы' : capitalize(names.join(' + '));
      }
      if (input.counting !== undefined && input.counting !== 'on_site') {
        throw new AppError('validation_failed', {
          field: 'counting',
          message:
            'Сейчас лимит считается по присутствию (кто въехал и не выехал). Подсчёт по пропускам и по заездам в сутки появится позже (Q-15).',
        });
      }
      if (overageTariffRub !== undefined) {
        out.overageTariffRub =
          overageTariffRub === null ? null : Number(overageTariffRub).toFixed(2);
      }
      const fromDocks = (input.capacityFromDocks ??
        existing?.capacityFromDocks ??
        false) as boolean;
      if (fromDocks) {
        if (input.capacity !== undefined) {
          throw new AppError('validation_failed', {
            field: 'capacity',
            message:
              'Лимит «по докам» считается по числу доков арендатора — число мест не указывается.',
          });
        }
        out.capacity = await countingDocks(s, tenantId, scope.siteId);
      } else if (!existing && input.capacity === undefined) {
        throw new AppError('validation_failed', {
          field: 'capacity',
          message: 'Укажите число мест (0 — «не предусмотрено договором»).',
        });
      }
      return out;
    },
    afterWrite: (s, row, input, existing) =>
      syncCategories(s, 'quota', row.id, input.categoryIds as string[] | undefined, !existing),
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('tenantId')), asc(c('name'))],
  });

  registerResource(app, {
    entity: 'routing_rule',
    title: 'Правило маршрута',
    table: schema.routingRules,
    collection: 'routing-rules',
    parent: 'site',
    parentField: 'siteId',
    read: 'rule.manage',
    write: 'rule.manage',
    createSchema: RoutingRuleCreateSchema,
    patchSchema: RoutingRulePatchSchema,
    viewSchema: RoutingRuleViewSchema,
    labels: {
      tenantId: 'tenant',
      categoryId: 'category',
      destinationZoneId: 'zone',
      gateId: 'gate',
    },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      tenantId: r.tenantId,
      participant: r.participant,
      categoryId: r.categoryId,
      destinationZoneId: r.destinationZoneId,
      gateId: r.gateId,
      direction: r.direction,
      priority: r.priority,
    }),
    prepare: async (s, input, existing, scope) => {
      const site = { siteId: scope.siteId };
      await assertRef(s, schema.tenants, input.tenantId as string | undefined, {
        ...site,
        field: 'tenantId',
        title: 'Арендатор',
      });
      await assertRef(s, schema.zones, input.destinationZoneId as string | undefined, {
        ...site,
        field: 'destinationZoneId',
        title: 'Место назначения',
      });
      await assertRef(s, schema.gates, input.gateId as string | undefined, {
        ...site,
        field: 'gateId',
        title: 'КПП',
      });
      if (typeof input.categoryId === 'string') {
        await assertCategories(s, [input.categoryId], scope.siteId, 'categoryId');
      }
      const participant = input.participant ?? existing?.participant;
      const categoryId = input.categoryId !== undefined ? input.categoryId : existing?.categoryId;
      if (participant === 'pedestrian' && categoryId) {
        throw new AppError('validation_failed', {
          field: 'categoryId',
          message: 'У маршрута пешеходов нет типа транспорта.',
        });
      }
      return input;
    },
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('priority')), asc(c('id'))],
  });

  registerResource(app, {
    entity: 'time_window_policy',
    title: 'Политика окна прибытия',
    table: schema.timeWindowPolicies,
    collection: 'time-window-policies',
    parent: 'site',
    parentField: 'siteId',
    read: 'rule.manage',
    write: 'rule.manage',
    createSchema: TimeWindowPolicyCreateSchema,
    patchSchema: TimeWindowPolicyPatchSchema,
    viewSchema: TimeWindowPolicyViewSchema,
    labels: { tenantId: 'tenant' },
    toView: (r, extra) => ({
      id: r.id,
      siteId: r.siteId,
      tenantId: r.tenantId,
      categoryIds: (extra as string[] | undefined) ?? [],
      windowRequired: r.windowRequired,
      earlyToleranceMin: r.earlyToleranceMin,
      lateToleranceMin: r.lateToleranceMin,
      onViolation: r.onViolation,
    }),
    loadExtras: (s, rows) => categoriesOf(s, 'policy', rows),
    prepare: async (s, input, _existing, scope) => {
      const { categoryIds, ...rest } = input;
      await assertRef(s, schema.tenants, input.tenantId as string | undefined, {
        siteId: scope.siteId,
        field: 'tenantId',
        title: 'Арендатор',
      });
      if (categoryIds)
        await assertCategories(s, categoryIds as string[], scope.siteId, 'categoryIds');
      return rest;
    },
    afterWrite: (s, row, input, existing) =>
      syncCategories(s, 'policy', row.id, input.categoryIds as string[] | undefined, !existing),
    scopeOf: siteScope,
  });

  registerResource(app, {
    entity: 'exception',
    title: 'Исключение',
    table: schema.exceptions,
    collection: 'exceptions',
    parent: 'site',
    parentField: 'siteId',
    read: 'rule.manage',
    write: 'rule.manage',
    createSchema: ExceptionCreateSchema,
    patchSchema: ExceptionPatchSchema,
    viewSchema: ExceptionViewSchema,
    // Вкладка арендатора просит только его исключения: фильтр на сервере, а не на экране (Q-66).
    listQuery: ExceptionListQuerySchema,
    listFilter: (_ctx, query) => [
      typeof query.tenantId === 'string'
        ? eq(schema.exceptions.tenantId, query.tenantId)
        : undefined,
    ],
    labels: { tenantId: 'tenant', basisClauseId: 'clause' },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      tenantId: r.tenantId,
      name: r.name,
      match: r.match,
      waives: r.waives,
      guardText: r.guardText,
      basis: r.basis,
      basisClauseId: r.basisClauseId,
      validFrom: iso(r.validFrom),
      validTo: iso(r.validTo),
    }),
    prepare: async (s, input, existing, scope) => {
      const { validFrom: _f, validTo: _t, ...rest } = input;
      const out: Record<string, unknown> = { ...rest, ...period(input, existing, s.ctx.now()) };
      await assertRef(s, schema.tenants, input.tenantId as string | undefined, {
        siteId: scope.siteId,
        field: 'tenantId',
        title: 'Арендатор',
      });
      const tenantId = (input.tenantId !== undefined ? input.tenantId : existing?.tenantId) as
        | string
        | null;
      await assertClauseRef(s, input.basisClauseId, tenantId);
      if (input.match !== undefined) {
        out.match = await normalizeMatch(s, input.match as ExceptionMatch, tenantId, scope.siteId);
      } else if (input.tenantId !== undefined && existing && isTenantMatch(existing.match)) {
        if (!tenantId) throw tenantRequired();
      }
      if (input.waives !== undefined) out.waives = [...new Set(input.waives as string[])];
      if (!existing && s.ctx.actor.kind === 'user') out.createdBy = s.ctx.actor.id;
      return out;
    },
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('name'))],
  });

  registerResource(app, {
    entity: 'approval_policy',
    title: 'Политика согласования',
    table: schema.approvalPolicies,
    collection: 'approval-policies',
    parent: 'site',
    parentField: 'siteId',
    read: 'rule.manage',
    write: 'rule.manage',
    createSchema: ApprovalPolicyCreateSchema,
    patchSchema: ApprovalPolicyPatchSchema,
    viewSchema: ApprovalPolicyViewSchema,
    labels: { tenantId: 'tenant' },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      tenantId: r.tenantId,
      creatorKind: r.creatorKind,
      passType: r.passType,
      mode: r.mode,
      commentRequired: r.commentRequired,
      escalationHours: r.escalationHours,
      onTimeout: r.onTimeout,
    }),
    prepare: async (s, input, _existing, scope) => {
      await assertRef(s, schema.tenants, input.tenantId as string | undefined, {
        siteId: scope.siteId,
        field: 'tenantId',
        title: 'Арендатор',
      });
      return input;
    },
    onConflict: () =>
      new AppError('conflict', {
        message:
          'Политика для этого сочетания «кто создаёт × тип пропуска» уже есть — измените её вместо новой.',
      }),
    scopeOf: siteScope,
  });

  app.withTypeProvider<ZodTypeProvider>().get(
    '/sites/:siteId/approval-policies/missing',
    {
      config: { permission: 'rule.manage' },
      schema: {
        tags: ['rules'],
        summary: 'Незаданные политики согласования объекта: такие пропуска уходят на согласование',
        params: SiteParamsSchema,
        response: { 200: z.object({ items: z.array(ApprovalPolicyGapSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select({
            creatorKind: schema.approvalPolicies.creatorKind,
            passType: schema.approvalPolicies.passType,
          })
          .from(schema.approvalPolicies)
          .where(
            and(
              eq(schema.approvalPolicies.organizationId, s.organizationId),
              eq(schema.approvalPolicies.siteId, site.id),
              isNull(schema.approvalPolicies.tenantId),
            ),
          );
        const have = new Set(rows.map((r) => `${r.creatorKind}:${r.passType}`));
        const items = [];
        for (const creatorKind of APPROVAL_CREATOR_KINDS) {
          for (const passType of PASS_TYPES) {
            if (have.has(`${creatorKind}:${passType}`)) continue;
            items.push({
              creatorKind,
              passType,
              message: `Политика «${CREATOR_LABEL[creatorKind]} → ${PASS_TYPE_LABEL[passType]}» не задана: такие пропуска уходят на согласование.`,
            });
          }
        }
        return { items };
      });
    },
  );
}

function isTenantMatch(match: unknown): boolean {
  return typeof match === 'object' && match !== null && 'tenant' in match;
}

function tenantRequired(): AppError {
  return new AppError('validation_failed', {
    field: 'tenantId',
    message: 'Исключение «весь арендатор» требует указать арендатора.',
  });
}

/** Пункт-основание — из договора арендатора правила (или любого договора объекта для правил объекта). */
async function assertClauseRef(
  s: Scope,
  clauseId: unknown,
  tenantId: string | null,
): Promise<void> {
  if (typeof clauseId !== 'string') return;
  const conditions = [
    eq(schema.contractClauses.organizationId, s.organizationId),
    eq(schema.contractClauses.id, clauseId),
  ];
  if (tenantId) conditions.push(eq(schema.contracts.tenantId, tenantId));
  const rows = await s.db
    .select({ id: schema.contractClauses.id })
    .from(schema.contractClauses)
    .innerJoin(schema.contracts, eq(schema.contracts.id, schema.contractClauses.contractId))
    .where(and(...conditions));
  if (rows.length === 0) {
    throw new AppError('validation_failed', {
      field: 'basisClauseId',
      message: 'Основание: пункт не из договора этого арендатора.',
    });
  }
}

/** Номера в исключении — нормализованные (как в пропусках); ссылки — на записи этого объекта. */
async function normalizeMatch(
  s: Scope,
  match: ExceptionMatch,
  tenantId: string | null,
  siteId: string,
): Promise<ExceptionMatch> {
  if ('plates' in match) {
    const plates = match.plates.map((p) => normalizePlate(p).norm);
    if (plates.some((p) => p.length === 0)) {
      throw new AppError('plate_required', { field: 'match.plates' });
    }
    return { plates: [...new Set(plates)] };
  }
  if ('categoryIds' in match) {
    await assertCategories(s, match.categoryIds, siteId, 'match.categoryIds');
    return match;
  }
  if ('tenant' in match) {
    if (!tenantId) throw tenantRequired();
    return match;
  }
  for (const passId of match.passIds) {
    await assertRef(s, schema.passes, passId, { siteId, field: 'match.passIds', title: 'Пропуск' });
  }
  return match;
}

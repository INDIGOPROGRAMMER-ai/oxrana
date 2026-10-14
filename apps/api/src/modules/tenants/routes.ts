import {
  BatchResultSchema,
  ClauseCreateSchema,
  ClausePatchSchema,
  ClauseViewSchema,
  ContractCreateSchema,
  ContractPatchSchema,
  ContractViewSchema,
  DockAssignmentBatchSchema,
  DockAssignmentCreateSchema,
  DockAssignmentPatchSchema,
  DockAssignmentViewSchema,
  ParkingAssignmentCreateSchema,
  ParkingAssignmentPatchSchema,
  ParkingAssignmentViewSchema,
  PedestrianRuleCreateSchema,
  PedestrianRulePatchSchema,
  PedestrianRuleViewSchema,
  SiteParamsSchema,
  type StoredFileView,
  TenantBatchSchema,
  TenantCreateSchema,
  TenantParamsSchema,
  TenantPatchSchema,
  TenantViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { runBatch } from '../../core/batch';
import { assertSiteAccess, assertTenantAccess, ctxOf, type Scope } from '../../core/context';
import { registerResource } from '../../core/crud';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { registerBlockingRoutes } from './blocking';
import { fileViews, registerContractFileRoutes } from './contract-files';
import { registerFleetRoutes } from './fleet';
import { contractScope, tenantRowScope } from './scope';
import { contractView, tenantView } from './views';

/** Пункт договора-основание принадлежит договору этого арендатора. */
async function assertClauseOfTenant(
  s: Scope,
  clauseId: unknown,
  tenantId: string,
  field = 'basisClauseId',
): Promise<void> {
  if (typeof clauseId !== 'string') return;
  const [row] = await s.db
    .select({ id: schema.contractClauses.id })
    .from(schema.contractClauses)
    .innerJoin(schema.contracts, eq(schema.contracts.id, schema.contractClauses.contractId))
    .where(
      and(
        eq(schema.contractClauses.organizationId, s.organizationId),
        eq(schema.contractClauses.id, clauseId),
        eq(schema.contracts.tenantId, tenantId),
      ),
    );
  if (!row) {
    throw new AppError('validation_failed', {
      field,
      message: 'Основание: пункт не из договора этого арендатора. Выберите пункт из его договора.',
    });
  }
}

const pedestrianTwin = (everywhere: boolean) =>
  new AppError('conflict', {
    field: 'zoneId',
    message: everywhere
      ? 'У этого арендатора уже есть правило «везде». Измените его — два правила на одно место охране не нужны.'
      : 'Для этой зоны у арендатора уже есть правило. Измените его — два правила на одно место охране не нужны.',
  });

const ruDate = (iso: string) => iso.split('-').reverse().join('.');
const ruPeriod = (from: string, to: string | null) =>
  `с ${ruDate(from)} ${to ? `по ${ruDate(to)}` : 'бессрочно'}`;

/**
 * Док не бывает у двух арендаторов сразу, а у одного — двумя пересекающимися назначениями. Проверка
 * заранее даёт понятный текст (в том числе в предпросмотре пакета): базе остаётся последняя линия
 * (exclusion-ограничение), но её ошибка не называет, кто занял док.
 */
async function assertDockFree(
  s: Scope,
  dockId: string,
  tenantId: string,
  from: string,
  to: string | null,
  selfId: string | null,
): Promise<void> {
  const [clash] = await s.db
    .select({
      tenantId: schema.tenantDockAssignments.tenantId,
      tenantName: schema.tenants.shortName,
      dockNumber: schema.docks.number,
      validFrom: schema.tenantDockAssignments.validFrom,
      validTo: schema.tenantDockAssignments.validTo,
    })
    .from(schema.tenantDockAssignments)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.tenantDockAssignments.tenantId))
    .innerJoin(schema.docks, eq(schema.docks.id, schema.tenantDockAssignments.dockId))
    .where(
      and(
        eq(schema.tenantDockAssignments.organizationId, s.organizationId),
        eq(schema.tenantDockAssignments.dockId, dockId),
        selfId ? ne(schema.tenantDockAssignments.id, selfId) : undefined,
        sql`daterange(${schema.tenantDockAssignments.validFrom}, ${schema.tenantDockAssignments.validTo}, '[]') && daterange(${from}::date, ${to}::date, '[]')`,
      ),
    )
    .limit(1);
  if (!clash) return;
  const who =
    clash.tenantId === tenantId
      ? `уже закреплён за этим арендатором на пересекающийся период (${ruPeriod(clash.validFrom, clash.validTo)}). Измените то назначение или выберите другие даты.`
      : `на эти даты закреплён за арендатором «${clash.tenantName}» (${ruPeriod(clash.validFrom, clash.validTo)}). Док не бывает у двух арендаторов сразу: завершите то назначение или выберите другой док.`;
  throw new AppError('conflict', { field: 'dockId', message: `Док ${clash.dockNumber} ${who}` });
}

export function registerTenantsModule(app: FastifyInstance): void {
  const tenants = registerResource(app, {
    entity: 'tenant',
    title: 'Арендатор',
    table: schema.tenants,
    collection: 'tenants',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'tenant.manage',
    createSchema: TenantCreateSchema,
    patchSchema: TenantPatchSchema,
    viewSchema: TenantViewSchema,
    event: 'tenant.changed',
    labels: { defaultCategoryId: 'category' },
    toView: (r) => tenantView(r as never),
    prepare: async (s, input) => {
      await assertRef(s, schema.vehicleCategories, input.defaultCategoryId as string | undefined, {
        field: 'defaultCategoryId',
        title: 'Тип транспорта по умолчанию',
      });
      return input;
    },
    // Пользователь арендатора видит в списке только свои компании (ADR-007).
    listFilter: (ctx) => [
      ctx.actor.tenantIds === null
        ? undefined
        : inArray(schema.tenants.id, [...ctx.actor.tenantIds]),
    ],
    scopeOf: async (s, row) => {
      assertSiteAccess(s.ctx, String(row.siteId));
      assertTenantAccess(s.ctx, row.id);
      return { siteId: String(row.siteId), tenantId: row.id };
    },
    orderBy: (c) => [asc(c('shortName'))],
  });

  registerResource(app, {
    entity: 'contract',
    title: 'Договор',
    table: schema.contracts,
    collection: 'contracts',
    parent: 'tenant',
    parentField: 'tenantId',
    read: 'tenant.manage',
    write: 'tenant.manage',
    createSchema: ContractCreateSchema,
    patchSchema: ContractPatchSchema,
    viewSchema: ContractViewSchema,
    event: 'tenant.changed',
    toView: (r, extra) => {
      const e = extra as { file: StoredFileView | null; canViewFile: boolean } | undefined;
      return contractView(r as never, e?.file ?? null, e?.canViewFile ?? false);
    },
    // Файл показывается только с правом `contract.file`; без него договор виден, файл — нет.
    loadExtras: async (s, rows) => {
      const canViewFile = s.ctx.holds('contract.file');
      const files = canViewFile
        ? await fileViews(
            s,
            rows.map((r) => (r.fileRef as string | null) ?? null),
          )
        : new Map<string, StoredFileView>();
      return new Map(
        rows.map((r) => [
          r.id,
          { canViewFile, file: files.get((r.fileRef as string | null) ?? '') ?? null },
        ]),
      );
    },
    scopeOf: tenantRowScope,
    orderBy: (c) => [asc(c('validFrom')), asc(c('id'))],
  });

  registerResource(app, {
    entity: 'contract_clause',
    title: 'Пункт договора',
    table: schema.contractClauses,
    collection: 'clauses',
    parent: 'contract',
    parentField: 'contractId',
    read: 'tenant.manage',
    write: 'tenant.manage',
    createSchema: ClauseCreateSchema,
    patchSchema: ClausePatchSchema,
    viewSchema: ClauseViewSchema,
    toView: (r) => ({ id: r.id, contractId: r.contractId, ref: r.ref, summary: r.summary }),
    scopeOf: (s, row) => contractScope(s, String(row.contractId)),
    orderBy: (c) => [asc(c('ref'))],
  });

  const assignments = registerResource(app, {
    entity: 'tenant_dock_assignment',
    title: 'Назначение дока',
    table: schema.tenantDockAssignments,
    collection: 'dock-assignments',
    parent: 'tenant',
    parentField: 'tenantId',
    read: 'tenant.manage',
    write: 'tenant.manage',
    createSchema: DockAssignmentCreateSchema,
    patchSchema: DockAssignmentPatchSchema,
    viewSchema: DockAssignmentViewSchema,
    labels: { dockId: 'dock', basisClauseId: 'clause' },
    toView: (r) => ({
      id: r.id,
      tenantId: r.tenantId,
      dockId: r.dockId,
      validFrom: r.validFrom,
      validTo: r.validTo,
      basisClauseId: r.basisClauseId,
    }),
    prepare: async (s, input, existing, scope) => {
      await assertRef(s, schema.docks, input.dockId as string | undefined, {
        siteId: scope.siteId,
        field: 'dockId',
        title: 'Док',
      });
      await assertClauseOfTenant(s, input.basisClauseId, scope.tenantId ?? '');
      const from = (input.validFrom ?? existing?.validFrom) as string;
      const to = (input.validTo !== undefined ? input.validTo : existing?.validTo) as string | null;
      if (to !== null && to !== undefined && to < from) {
        throw new AppError('invalid_period', {
          field: 'validTo',
          message: 'Окончание назначения раньше начала. Проверьте даты.',
        });
      }
      await assertDockFree(
        s,
        String(input.dockId ?? existing?.dockId),
        scope.tenantId ?? '',
        from,
        to ?? null,
        existing?.id ?? null,
      );
      return input;
    },
    onConflict: () =>
      new AppError('conflict', {
        field: 'dockId',
        message:
          'Этот док на эти даты уже закреплён (док не бывает у двух арендаторов сразу). Завершите прежнее назначение или выберите другой док.',
      }),
    scopeOf: tenantRowScope,
    orderBy: (c) => [asc(c('validFrom'))],
  });

  registerResource(app, {
    entity: 'pedestrian_rule',
    title: 'Правило для пешеходов',
    table: schema.pedestrianRules,
    collection: 'pedestrian-rules',
    parent: 'tenant',
    parentField: 'tenantId',
    read: 'tenant.manage',
    write: 'tenant.manage',
    createSchema: PedestrianRuleCreateSchema,
    patchSchema: PedestrianRulePatchSchema,
    viewSchema: PedestrianRuleViewSchema,
    labels: { zoneId: 'zone' },
    toView: (r) => ({
      id: r.id,
      tenantId: r.tenantId,
      zoneId: r.zoneId,
      documentRequired: r.documentRequired,
      escort: r.escort,
      escortPhone: r.escortPhone,
      guardText: r.guardText,
    }),
    prepare: async (s, input, existing, scope) => {
      await assertRef(s, schema.zones, input.zoneId as string | undefined, {
        siteId: scope.siteId,
        field: 'zoneId',
        title: 'Зона',
      });
      const escort = input.escort ?? existing?.escort;
      const phone = input.escortPhone !== undefined ? input.escortPhone : existing?.escortPhone;
      if (escort !== 'none' && !phone) {
        throw new AppError('validation_failed', {
          field: 'escortPhone',
          message:
            'Укажите телефон, куда звонить за сопровождающим, — охрана увидит его в карточке.',
        });
      }
      // Одно правило на «арендатор × зона» и одно «везде» (Q-66): иначе движок взял бы первое найденное.
      const zoneId = ((input.zoneId !== undefined ? input.zoneId : existing?.zoneId) ?? null) as
        | string
        | null;
      const [twin] = await s.db
        .select({ id: schema.pedestrianRules.id })
        .from(schema.pedestrianRules)
        .where(
          and(
            eq(schema.pedestrianRules.organizationId, s.organizationId),
            eq(schema.pedestrianRules.tenantId, scope.tenantId ?? ''),
            isNull(schema.pedestrianRules.deletedAt),
            zoneId === null
              ? isNull(schema.pedestrianRules.zoneId)
              : eq(schema.pedestrianRules.zoneId, zoneId),
            existing ? ne(schema.pedestrianRules.id, existing.id) : undefined,
          ),
        );
      if (twin) throw pedestrianTwin(zoneId === null);
      return existing ? input : { ...input, siteId: scope.siteId };
    },
    onConflict: () => pedestrianTwin(false),
    scopeOf: tenantRowScope,
  });

  registerResource(app, {
    entity: 'tenant_parking_assignment',
    title: 'Закрепление мест',
    table: schema.tenantParkingAssignments,
    collection: 'parking-assignments',
    parent: 'tenant',
    parentField: 'tenantId',
    read: 'tenant.manage',
    write: 'tenant.manage',
    createSchema: ParkingAssignmentCreateSchema,
    patchSchema: ParkingAssignmentPatchSchema,
    viewSchema: ParkingAssignmentViewSchema,
    labels: { basisClauseId: 'clause' },
    toView: (r) => ({
      id: r.id,
      tenantId: r.tenantId,
      parkingAreaId: r.parkingAreaId,
      spaces: r.spaces,
      validFrom: r.validFrom,
      validTo: r.validTo,
      basisClauseId: r.basisClauseId,
    }),
    prepare: async (s, input, existing, scope) => {
      await assertRef(s, schema.parkingAreas, input.parkingAreaId as string | undefined, {
        siteId: scope.siteId,
        field: 'parkingAreaId',
        title: 'Парковочный участок',
      });
      await assertClauseOfTenant(s, input.basisClauseId, scope.tenantId ?? '');
      const from = (input.validFrom ?? existing?.validFrom) as string;
      const to = (input.validTo !== undefined ? input.validTo : existing?.validTo) as string | null;
      if (to !== null && to !== undefined && to < from) {
        throw new AppError('invalid_period', {
          field: 'validTo',
          message: 'Окончание закрепления раньше начала. Проверьте даты.',
        });
      }
      // Мест закреплено не больше, чем на участке: считаем пересекающиеся по датам закрепления всех
      // арендаторов (с запасом — без учёта того, что они могут не совпадать по времени в течение периода).
      const areaId = String(input.parkingAreaId ?? existing?.parkingAreaId);
      const spaces = Number(input.spaces ?? existing?.spaces);
      const [area] = await s.db
        .select({ name: schema.parkingAreas.name, spaces: schema.parkingAreas.spaces })
        .from(schema.parkingAreas)
        .where(eq(schema.parkingAreas.id, areaId));
      if (area?.spaces != null) {
        const [taken] = await s.db
          .select({
            n: sql<number>`coalesce(sum(${schema.tenantParkingAssignments.spaces}), 0)::int`,
          })
          .from(schema.tenantParkingAssignments)
          .where(
            and(
              eq(schema.tenantParkingAssignments.organizationId, s.organizationId),
              eq(schema.tenantParkingAssignments.parkingAreaId, areaId),
              existing ? ne(schema.tenantParkingAssignments.id, existing.id) : undefined,
              sql`daterange(${schema.tenantParkingAssignments.validFrom}, ${schema.tenantParkingAssignments.validTo}, '[]') && daterange(${from}::date, ${to ?? null}::date, '[]')`,
            ),
          );
        const already = taken?.n ?? 0;
        if (already + spaces > area.spaces) {
          throw new AppError('conflict', {
            field: 'spaces',
            message: `На участке «${area.name}» всего ${area.spaces} мест, на эти даты уже закреплено ${already}. Можно закрепить не больше ${Math.max(0, area.spaces - already)}.`,
          });
        }
      }
      return input;
    },
    scopeOf: tenantRowScope,
    orderBy: (c) => [asc(c('validFrom'))],
  });

  // Пакетное добавление арендаторов (вставка из Excel): строки независимы, повторы названий — ошибка строки.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/sites/:siteId/tenants/batch',
    {
      config: { permission: 'tenant.manage' },
      schema: {
        tags: ['tenant'],
        summary: 'Арендаторы: добавить пакетом (dryRun — предпросмотр)',
        params: SiteParamsSchema,
        body: TenantBatchSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { items, dryRun } = request.body;
      return ctx.tx(async (s) => {
        const existing = await s.db
          .select({ shortName: schema.tenants.shortName })
          .from(schema.tenants)
          .where(
            and(
              eq(schema.tenants.organizationId, s.organizationId),
              eq(schema.tenants.siteId, request.params.siteId),
              isNull(schema.tenants.deletedAt),
            ),
          );
        const names = new Set(existing.map((t) => t.shortName.toLowerCase()));
        return runBatch(s, items, {
          dryRun: dryRun ?? false,
          precheck: (item) => {
            const key = item.shortName.toLowerCase();
            if (names.has(key)) {
              return new AppError('conflict', {
                field: 'shortName',
                message: `Арендатор «${item.shortName}» уже есть на объекте (или повторяется в списке). Измените название или уберите строку.`,
              });
            }
            names.add(key);
            return null;
          },
          create: (scope, item) =>
            tenants.create(scope, request.params.siteId, item as Record<string, unknown>),
        });
      });
    },
  );

  // Несколько доков арендатору сразу («доки 1–10»): общий срок и основание.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/tenants/:tenantId/dock-assignments/batch',
    {
      config: { permission: 'tenant.manage' },
      schema: {
        tags: ['tenant_dock_assignment'],
        summary: 'Назначения доков: закрепить пакетом (dryRun — предпросмотр)',
        params: TenantParamsSchema,
        body: DockAssignmentBatchSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { dockIds, dryRun, ...common } = request.body;
      const seen = new Set<string>();
      return ctx.tx((s) =>
        runBatch(s, dockIds, {
          dryRun: dryRun ?? false,
          precheck: (dockId) => {
            if (seen.has(dockId)) {
              return new AppError('conflict', {
                field: 'dockId',
                message: 'Док повторяется в списке. Оставьте один.',
              });
            }
            seen.add(dockId);
            return null;
          },
          create: (scope, dockId) =>
            assignments.create(scope, request.params.tenantId, { ...common, dockId }),
        }),
      );
    },
  );

  registerBlockingRoutes(app);
  registerContractFileRoutes(app);
  registerFleetRoutes(app);
}

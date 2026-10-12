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
  PedestrianRuleCreateSchema,
  PedestrianRulePatchSchema,
  PedestrianRuleViewSchema,
  SiteParamsSchema,
  TenantBatchSchema,
  TenantCreateSchema,
  TenantParamsSchema,
  TenantPatchSchema,
  TenantViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { runBatch } from '../../core/batch';
import { assertSiteAccess, assertTenantAccess, ctxOf, type Scope } from '../../core/context';
import { registerResource, type ScopeInfo } from '../../core/crud';
import { loadTenant, notFound } from '../../core/loaders';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';

type Row = Record<string, unknown> & { id: string };

/** Запись арендатора: область — его объект и он сам (пользователь арендатора видит только своих). */
async function tenantRowScope(s: Scope, row: Row): Promise<ScopeInfo> {
  const tenant = await loadTenant(s, String(row.tenantId), { includeDeleted: true });
  return { siteId: tenant.siteId, tenantId: tenant.id };
}

async function contractScope(s: Scope, contractId: string): Promise<ScopeInfo> {
  const [contract] = await s.db
    .select({ tenantId: schema.contracts.tenantId })
    .from(schema.contracts)
    .where(
      and(
        eq(schema.contracts.organizationId, s.organizationId),
        eq(schema.contracts.id, contractId),
      ),
    );
  if (!contract) throw notFound('Договор');
  const tenant = await loadTenant(s, contract.tenantId, { includeDeleted: true });
  return { siteId: tenant.siteId, tenantId: tenant.id };
}

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
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      legalName: r.legalName,
      shortName: r.shortName,
      inn: r.inn,
      isOperator: r.isOperator,
      status: r.status,
      trucksDockRequired: r.trucksDockRequired,
      defaultCategoryId: r.defaultCategoryId,
      responsiblePhone: r.responsiblePhone,
      emergencyPhone: r.emergencyPhone,
      color: r.color,
    }),
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
    toView: (r) => ({
      id: r.id,
      tenantId: r.tenantId,
      number: r.number,
      signedOn: r.signedOn,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      notes: r.notes,
    }),
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
      return input;
    },
    onConflict: () =>
      new AppError('conflict', {
        field: 'dockId',
        message:
          'Этот док на эти даты уже закреплён за другим арендатором (док не бывает у двух сразу). Завершите прежнее назначение или выберите другой док.',
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
      return existing ? input : { ...input, siteId: scope.siteId };
    },
    scopeOf: tenantRowScope,
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
}

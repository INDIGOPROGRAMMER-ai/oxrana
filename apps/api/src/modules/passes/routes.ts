import {
  CancelPassSchema,
  ChangeRequestListQuerySchema,
  ChangeRequestViewSchema,
  DecisionSchema,
  IdParamsSchema,
  PassBatchResultSchema,
  PassBatchSchema,
  PassCreatedSchema,
  PassCreateSchema,
  PassHintsQuerySchema,
  PassHintsSchema,
  PassHistoryEntrySchema,
  PassListQuerySchema,
  PassPatchResultSchema,
  PassPatchSchema,
  PassViewSchema,
  RejectSchema,
  SiteParamsSchema,
  TenantParamsSchema,
  VisitListQuerySchema,
  VisitViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { normalizePlateText, plateDigits } from '@oxrana/plates';
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isTenantUser } from '../../actor';
import { assertTenantAccess, type Ctx, can, ctxOf, type Scope } from '../../core/context';
import { loadSite, loadTenant } from '../../core/loaders';
import { createBatch } from './batch';
import { passHints } from './hints';
import {
  assertCanView,
  cancelPass,
  createPass,
  decideChangeRequest,
  loadPass,
  patchPass,
} from './service';
import { passView, visitView } from './views';

const VIEW = ['pass.view', 'pass.view_all_tenants'] as const;
const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;
const EDIT = ['pass.edit', 'pass.change_request.create'] as const;
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** Арендаторы, чьи пропуска видит актор на объекте; `null` — все. */
function visibleTenants(ctx: Ctx, requested: string | undefined): string[] | null {
  const all = can(ctx, 'pass.view_all_tenants') && !isTenantUser(ctx.actor);
  if (requested) {
    if (!all) assertTenantAccess(ctx, requested);
    return [requested];
  }
  return all ? null : [...(ctx.actor.tenantIds ?? [])];
}

function changeRequestView(row: typeof schema.passChangeRequests.$inferSelect) {
  return {
    id: row.id,
    passId: row.passId,
    changes: row.changes as Record<string, { from: unknown; to: unknown }>,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

async function actorNames(
  s: Scope,
  rows: { actorUserId: string | null; actorGateAccountId: string | null }[],
) {
  const userIds = [
    ...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => v !== null)),
  ];
  const accountIds = [
    ...new Set(rows.map((r) => r.actorGateAccountId).filter((v): v is string => v !== null)),
  ];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    for (const u of await s.db
      .select({ id: schema.users.id, name: schema.users.fullName })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds))) {
      names.set(u.id, u.name);
    }
  }
  if (accountIds.length > 0) {
    for (const a of await s.db
      .select({ id: schema.gateAccounts.id, name: schema.gates.name })
      .from(schema.gateAccounts)
      .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
      .where(
        and(
          eq(schema.gateAccounts.organizationId, s.organizationId),
          inArray(schema.gateAccounts.id, accountIds),
        ),
      )) {
      names.set(a.id, `Пост ${a.name}`);
    }
  }
  return names;
}

export function registerPassesModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['passes'];

  typed.get(
    '/sites/:siteId/passes',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Пропуска объекта (свои арендаторы или все — по праву)',
        params: SiteParamsSchema,
        querystring: PassListQuerySchema,
        response: { 200: z.object({ items: z.array(PassViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const tenants = visibleTenants(ctx, q.tenantId);
        if (tenants !== null && tenants.length === 0) return { items: [] };
        const conditions: (SQL | undefined)[] = [
          eq(schema.passes.organizationId, s.organizationId),
          eq(schema.passes.siteId, site.id),
          tenants === null ? undefined : inArray(schema.passes.tenantId, tenants),
          q.status ? eq(schema.passes.status, q.status) : undefined,
          q.participant ? eq(schema.passes.participant, q.participant) : undefined,
        ];
        if (q.q) {
          const digits = plateDigits(q.q);
          const plate = /^\d+$/.test(q.q.replace(/\s/g, '')) ? digits : normalizePlateText(q.q);
          conditions.push(
            or(
              plate ? ilike(schema.passes.plateNorm, `%${plate}%`) : undefined,
              ilike(schema.passes.personName, `%${q.q}%`),
            ),
          );
        }
        const rows = await s.db
          .select()
          .from(schema.passes)
          .where(and(...conditions))
          .orderBy(desc(schema.passes.createdAt), asc(schema.passes.id))
          .limit(q.limit)
          .offset(q.offset);
        return { items: rows.map((r) => passView(r, ctx.now())) };
      });
    },
  );

  typed.get(
    '/passes/:id',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Пропуск',
        params: IdParamsSchema,
        response: { 200: PassViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { pass } = await loadPass(s, request.params.id);
        assertCanView(s, pass.tenantId);
        return passView(pass, ctx.now());
      });
    },
  );

  typed.post(
    '/passes',
    {
      config: { permission: CREATE },
      schema: {
        tags,
        summary: 'Создать пропуск (политика согласования, дубли, страница водителя)',
        body: PassCreateSchema,
        response: { 201: PassCreatedSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const { tenantId, ...draft } = request.body;
      const created = await ctx.tx(async (s) => {
        const tenant = await loadTenant(s, tenantId);
        const pass = await createPass(s, tenant, draft, {
          via: ctx.actor.kind === 'gate_account' ? 'gate' : 'web',
        });
        return {
          ...passView(pass.row, ctx.now()),
          driverPageUrl: `/p/${pass.driverToken}`,
          warnings: pass.warnings,
        };
      });
      return reply.status(201).send(created);
    },
  );

  typed.post(
    '/passes/batch',
    {
      config: { permission: CREATE },
      schema: {
        tags,
        summary:
          'Пакетное создание: «создано N из M» с причинами по строкам; dryRun — предпросмотр',
        body: PassBatchSchema,
        response: { 200: PassBatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { tenantId, rows, dryRun } = request.body;
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, tenantId);
        return createBatch(s, tenant, rows, dryRun ?? false);
      });
    },
  );

  typed.patch(
    '/passes/:id',
    {
      config: { permission: EDIT },
      schema: {
        tags,
        summary: 'Изменить пропуск: только переданные поля; у начавшегося — с причиной',
        params: IdParamsSchema,
        body: PassPatchSchema,
        response: { 200: PassPatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const result = await patchPass(s, request.params.id, request.body);
        return {
          pass: passView(result.row, ctx.now()),
          applied: result.applied,
          changeRequest: result.changeRequest ? changeRequestView(result.changeRequest) : null,
        };
      });
    },
  );

  typed.post(
    '/passes/:id/cancel',
    {
      config: { permission: 'pass.cancel' },
      schema: {
        tags,
        summary: 'Отменить пропуск (с причиной)',
        params: IdParamsSchema,
        body: CancelPassSchema,
        response: { 200: PassViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        passView(await cancelPass(s, request.params.id, request.body.reason), ctx.now()),
      );
    },
  );

  typed.get(
    '/passes/:id/history',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'История пропуска: «было → стало», кто и почему',
        params: IdParamsSchema,
        response: { 200: z.object({ items: z.array(PassHistoryEntrySchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { pass } = await loadPass(s, request.params.id);
        assertCanView(s, pass.tenantId);
        const rows = await s.db
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.organizationId, s.organizationId),
              eq(schema.auditLog.entity, 'pass'),
              eq(schema.auditLog.entityId, pass.id),
            ),
          )
          .orderBy(asc(schema.auditLog.id));
        const names = await actorNames(s, rows);
        return {
          items: rows.map((r) => ({
            at: r.at.toISOString(),
            action: r.action,
            actorType: r.actorType,
            actorName: names.get(r.actorUserId ?? r.actorGateAccountId ?? '') ?? null,
            diff: (r.diff as Record<string, unknown> | null) ?? null,
            reason: r.reason,
          })),
        };
      });
    },
  );

  typed.get(
    '/passes/:id/change-requests',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Заявки на изменение пропуска',
        params: IdParamsSchema,
        response: { 200: z.object({ items: z.array(ChangeRequestViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { pass } = await loadPass(s, request.params.id);
        assertCanView(s, pass.tenantId);
        const rows = await s.db
          .select()
          .from(schema.passChangeRequests)
          .where(
            and(
              eq(schema.passChangeRequests.organizationId, s.organizationId),
              eq(schema.passChangeRequests.passId, pass.id),
            ),
          )
          .orderBy(asc(schema.passChangeRequests.createdAt));
        return { items: rows.map(changeRequestView) };
      });
    },
  );

  typed.get(
    '/sites/:siteId/change-requests',
    {
      config: { permission: 'pass.change_request.decide' },
      schema: {
        tags,
        summary: 'Заявки на изменение по объекту (очередь согласующего)',
        params: SiteParamsSchema,
        querystring: ChangeRequestListQuerySchema,
        response: { 200: z.object({ items: z.array(ChangeRequestViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select({ request: schema.passChangeRequests })
          .from(schema.passChangeRequests)
          .innerJoin(schema.passes, eq(schema.passes.id, schema.passChangeRequests.passId))
          .where(
            and(
              eq(schema.passChangeRequests.organizationId, s.organizationId),
              eq(schema.passes.siteId, site.id),
              request.query.status
                ? eq(schema.passChangeRequests.status, request.query.status)
                : undefined,
            ),
          )
          .orderBy(asc(schema.passChangeRequests.createdAt));
        return { items: rows.map((r) => changeRequestView(r.request)) };
      });
    },
  );

  for (const decision of ['approve', 'reject'] as const) {
    typed.post(
      `/change-requests/:id/${decision}`,
      {
        config: { permission: 'pass.change_request.decide' },
        schema: {
          tags,
          summary:
            decision === 'approve'
              ? 'Одобрить заявку: изменения применяются к тому же пропуску'
              : 'Отклонить заявку (с причиной)',
          params: IdParamsSchema,
          body: decision === 'approve' ? DecisionSchema : RejectSchema,
          response: {
            200: z.object({ changeRequest: ChangeRequestViewSchema, pass: PassViewSchema }),
          },
        },
      },
      async (request) => {
        const ctx = ctxOf(request);
        return ctx.tx(async (s) => {
          const result = await decideChangeRequest(
            s,
            request.params.id,
            decision === 'approve' ? 'approved' : 'rejected',
            request.body.note ?? null,
          );
          return {
            changeRequest: changeRequestView(result.request),
            pass: passView(result.pass, ctx.now()),
          };
        });
      },
    );
  }

  typed.get(
    '/tenants/:tenantId/pass-hints',
    {
      config: { permission: CREATE },
      schema: {
        tags,
        summary: 'Подсказки формы пропуска до сохранения: маршрут, лимиты, согласование, доки',
        params: TenantParamsSchema,
        querystring: PassHintsQuerySchema,
        response: { 200: PassHintsSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        return passHints(s, tenant, request.query);
      });
    },
  );

  typed.get(
    '/sites/:siteId/visits',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Визиты: кто на территории и история (названия — на момент въезда)',
        params: SiteParamsSchema,
        querystring: VisitListQuerySchema,
        response: { 200: z.object({ items: z.array(VisitViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const tenants = visibleTenants(ctx, q.tenantId);
        if (tenants !== null && tenants.length === 0) return { items: [] };
        const rows = await s.db
          .select()
          .from(schema.visits)
          .where(
            and(
              eq(schema.visits.organizationId, s.organizationId),
              eq(schema.visits.siteId, site.id),
              tenants === null ? undefined : inArray(schema.visits.tenantId, tenants),
              q.open === 'true' ? isNull(schema.visits.timeOut) : undefined,
            ),
          )
          .orderBy(desc(schema.visits.timeIn), asc(schema.visits.id))
          .limit(q.limit)
          .offset(q.offset);
        return { items: rows.map(visitView) };
      });
    },
  );
}

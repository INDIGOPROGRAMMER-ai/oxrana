import {
  ApprovalListQuerySchema,
  ApprovalViewSchema,
  CancelPassSchema,
  ChangeRequestListQuerySchema,
  ChangeRequestViewSchema,
  DecisionSchema,
  IdParamsSchema,
  InsideExportQuerySchema,
  InsideListSchema,
  InsideQuerySchema,
  PassApproveSchema,
  PassBatchResultSchema,
  PassBatchSchema,
  PassCardSchema,
  PassCreatedSchema,
  PassCreateSchema,
  PassExportQuerySchema,
  PassHintsQuerySchema,
  PassHintsRequestSchema,
  PassHintsSchema,
  PassHistoryListSchema,
  PassHistoryQuerySchema,
  PassListQuerySchema,
  PassListSchema,
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
import { localDate } from '@oxrana/engine';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf, requirePermission } from '../../core/context';
import { loadSite, loadTenant } from '../../core/loaders';
import { approvePass, creatorNames, rejectPass } from './approvals';
import { createBatch } from './batch';
import { registerCabinetRoutes } from './cabinet';
import { passNames, passPeople, passPresence } from './card';
import { passHints } from './hints';
import { passHistory } from './history';
import {
  exportInside,
  exportPasses,
  insidePage,
  passConditions,
  passPage,
  visibleTenants,
} from './listing';
import {
  assertCanView,
  cancelPass,
  createPass,
  decideChangeRequest,
  loadPass,
  openVisitPassIds,
  patchPass,
} from './service';
import { passView, visitView } from './views';

const VIEW = ['pass.view', 'pass.view_all_tenants'] as const;
const HISTORY = 'pass.history.view';
const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;
const EDIT = ['pass.edit', 'pass.change_request.create'] as const;
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

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

export function registerPassesModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['passes'];

  typed.get(
    '/sites/:siteId/passes',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary:
          'Пропуска объекта порциями (свои арендаторы или все — по праву); total — итог по фильтру',
        params: SiteParamsSchema,
        querystring: PassListQuerySchema,
        response: { 200: PassListSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const tenants = visibleTenants(ctx, q.tenantId);
        if (tenants !== null && tenants.length === 0) return { items: [], total: 0 };
        return passPage(s, passConditions(s, site, tenants, q), q, ctx.now());
      });
    },
  );

  typed.get(
    '/sites/:siteId/passes/export',
    {
      // Выгрузка — отдельное право; видимость строк — как у списка (свои арендаторы или все).
      config: { permission: 'report.export' },
      schema: {
        tags,
        summary: 'Выгрузить пропуска XLSX/CSV: все строки по текущему фильтру, факт — в аудит',
        params: SiteParamsSchema,
        querystring: PassExportQuerySchema,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const { format, ...q } = request.query;
      const file = await ctx.tx(async (s) => {
        requirePermission(s.ctx, ...VIEW);
        const site = await loadSite(s, request.params.siteId);
        const tenants = visibleTenants(ctx, q.tenantId);
        const note = {
          tenantId: q.tenantId ?? null,
          status: q.status ?? null,
          passType: q.passType ?? null,
          dateFrom: q.dateFrom ?? null,
          dateTo: q.dateTo ?? null,
          search: Boolean(q.q),
        };
        const conditions =
          tenants !== null && tenants.length === 0
            ? [sql`false`]
            : passConditions(s, site, tenants, q);
        return {
          ...(await exportPasses(s, site, conditions, format, note)),
          date: localDate(ctx.now(), site.timezone),
        };
      });
      return reply
        .header('content-type', file.contentType)
        .header('content-length', file.body.length)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(`propuska-${file.date}.${file.extension}`)}`,
        )
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.body);
    },
  );

  typed.get(
    '/sites/:siteId/inside',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary:
          'Сейчас на территории: все открытые визиты без потолка, порциями; quotaId — как в виджете лимитов',
        params: SiteParamsSchema,
        querystring: InsideQuerySchema,
        response: { 200: InsideListSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { limit, offset, ...filter } = request.query;
      return ctx.tx(async (s) =>
        insidePage(s, ctx, await loadSite(s, request.params.siteId), filter, { limit, offset }),
      );
    },
  );

  typed.get(
    '/sites/:siteId/inside/export',
    {
      config: { permission: 'report.export' },
      schema: {
        tags,
        summary: 'Выгрузить «Сейчас на территории» XLSX/CSV: все строки по фильтру, факт — в аудит',
        params: SiteParamsSchema,
        querystring: InsideExportQuerySchema,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const { format, ...filter } = request.query;
      const file = await ctx.tx(async (s) => {
        requirePermission(s.ctx, ...VIEW);
        const site = await loadSite(s, request.params.siteId);
        return {
          ...(await exportInside(s, ctx, site, filter, format, {
            tenantId: filter.tenantId ?? null,
            quotaId: filter.quotaId ?? null,
            search: Boolean(filter.q),
          })),
          date: localDate(ctx.now(), site.timezone),
        };
      });
      return reply
        .header('content-type', file.contentType)
        .header('content-length', file.body.length)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(`na-territorii-${file.date}.${file.extension}`)}`,
        )
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.body);
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
        const open = await openVisitPassIds(s, [pass.id]);
        return passView(pass, ctx.now(), open.has(pass.id));
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
        const open = await openVisitPassIds(s, [result.row.id]);
        return {
          pass: passView(result.row, ctx.now(), open.has(result.row.id)),
          applied: result.applied,
          changeRequest: result.changeRequest ? changeRequestView(result.changeRequest) : null,
        };
      });
    },
  );

  typed.post(
    '/passes/:id/cancel',
    {
      config: { permission: ['pass.cancel', 'pass.cancel_own'] },
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
    '/sites/:siteId/approvals',
    {
      config: { permission: 'pass.approve' },
      schema: {
        tags,
        summary: 'Пропуска на согласовании: все поля будущего пропуска, кто заказал',
        params: SiteParamsSchema,
        querystring: ApprovalListQuerySchema,
        response: { 200: z.object({ items: z.array(ApprovalViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        if (q.tenantId) await loadTenant(s, q.tenantId);
        const rows = await s.db
          .select({ pass: schema.passes, tenantName: schema.tenants.shortName })
          .from(schema.passes)
          .innerJoin(schema.tenants, eq(schema.tenants.id, schema.passes.tenantId))
          .where(
            and(
              eq(schema.passes.organizationId, s.organizationId),
              eq(schema.passes.siteId, site.id),
              eq(schema.passes.status, 'pending_approval'),
              q.tenantId ? eq(schema.passes.tenantId, q.tenantId) : undefined,
            ),
          )
          .orderBy(asc(schema.passes.createdAt), asc(schema.passes.id))
          .limit(q.limit)
          .offset(q.offset);
        const names = await creatorNames(
          s,
          rows.map((r) => r.pass),
        );
        return {
          items: rows.map((r) => ({
            pass: passView(r.pass, ctx.now()),
            tenantName: r.tenantName,
            createdByName: r.pass.createdBy ? (names.get(r.pass.createdBy) ?? null) : null,
          })),
        };
      });
    },
  );

  typed.post(
    '/passes/:id/approve',
    {
      config: { permission: 'pass.approve' },
      schema: {
        tags,
        summary: 'Одобрить пропуск; «с изменениями» — изменённые поля видны арендатору',
        params: IdParamsSchema,
        body: PassApproveSchema,
        response: { 200: PassViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        passView(
          await approvePass(s, request.params.id, request.body.note ?? null, request.body.changes),
          ctx.now(),
        ),
      );
    },
  );

  typed.post(
    '/passes/:id/reject',
    {
      config: { permission: 'pass.approve' },
      schema: {
        tags,
        summary: 'Отклонить пропуск на согласовании (с причиной — её видит арендатор)',
        params: IdParamsSchema,
        body: RejectSchema,
        response: { 200: PassViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        passView(await rejectPass(s, request.params.id, request.body.note), ctx.now()),
      );
    },
  );

  typed.get(
    '/passes/:id/history',
    {
      config: { permission: HISTORY },
      schema: {
        tags,
        summary:
          'Лента пропуска: изменения, согласование и отметки КПП одним списком (новые сверху); нужно право «История пропуска»',
        params: IdParamsSchema,
        querystring: PassHistoryQuerySchema,
        response: { 200: PassHistoryListSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { pass } = await loadPass(s, request.params.id);
        assertCanView(s, pass.tenantId);
        return passHistory(s, pass, request.query);
      });
    },
  );

  typed.get(
    '/passes/:id/card',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary:
          'Данные карточки пропуска: арендатор, кто оформил и согласовал, находится ли на территории (без истории)',
        params: IdParamsSchema,
        response: { 200: PassCardSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { pass, tenant } = await loadPass(s, request.params.id);
        assertCanView(s, pass.tenantId);
        const open = await openVisitPassIds(s, [pass.id]);
        return {
          pass: passView(pass, ctx.now(), open.has(pass.id)),
          tenantName: tenant.shortName,
          ...(await passPeople(s, pass)),
          presence: await passPresence(s, pass.id),
          names: await passNames(s, pass),
        };
      });
    },
  );

  typed.get(
    '/passes/:id/change-requests',
    {
      config: { permission: HISTORY },
      schema: {
        tags,
        summary: 'Заявки на изменение пропуска (нужно право «История пропуска»)',
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

  typed.post(
    '/tenants/:tenantId/pass-hints',
    {
      config: { permission: CREATE },
      schema: {
        tags,
        summary:
          'Подсказки формы с номером или именем (чёрный список): данные в теле, не в адресе запроса',
        params: TenantParamsSchema,
        body: PassHintsRequestSchema,
        response: { 200: PassHintsSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        return passHints(s, tenant, request.body);
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
  registerCabinetRoutes(app);
}

import {
  GateActionInputSchema,
  GateActionResultSchema,
  GateCheckResultSchema,
  GateCheckSchema,
  GateRequestApproveSchema,
  GateRequestCreateSchema,
  GateRequestListQuerySchema,
  GateRequestViewSchema,
  GateSnapshotSchema,
  GateSyncResultSchema,
  GateSyncSchema,
  IdParamsSchema,
  PassCreatedSchema,
  QueueViewSchema,
  RejectSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { openVisits, schema } from '@oxrana/db';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf } from '../../core/context';
import { loadSite } from '../../core/loaders';
import { AppError } from '../../errors';
import { siteTimeLabel } from '../org/sites';
import { enginePass, engineVisit, passView, visitView } from '../passes/views';
import { ACTION_PERMISSION, runAction, verdictView } from './actions';
import {
  approvedOverrides,
  gateContext,
  insertDecision,
  resolveSubject,
  runEngine,
  tenantState,
} from './core';
import { queueEntries } from './queue';
import {
  approveGateRequest,
  createGateRequest,
  gateRequestView,
  rejectGateRequest,
} from './requests';

/** Проверка и снимок — тем, кто пропускает на этом посту. */
const POST_VIEW = ['visit.check_in', 'visit.check_out', 'gate.passage'] as const;
const ANY_ACTION = Object.values(ACTION_PERMISSION);

export function registerGateModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['gate'];

  typed.post(
    '/gate/check',
    {
      config: { permission: POST_VIEW },
      schema: {
        tags,
        summary: 'Вердикт на посту: по пропуску, номеру или фамилии (в журнал КПП)',
        body: GateCheckSchema,
        response: { 200: GateCheckResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const body = request.body;
      return ctx.tx(async (s) => {
        const g = await gateContext(s);
        const now = ctx.now();
        const resolved = await resolveSubject(s, g, body, body.direction, now);
        const tenantId = resolved.pass?.tenantId;
        const live = tenantId
          ? (await tenantState(s, g, tenantId, now)).state
          : { occupancy: [], queue: [], asOf: now };
        const overrides = await approvedOverrides(
          s,
          g.gate.id,
          resolved.pass?.id ?? null,
          body.direction,
          now,
        );
        const verdict = runEngine(g, resolved.subject, body.direction, now, live, overrides);
        const decisionId = await insertDecision(s, g, {
          direction: body.direction,
          verdict,
          action: 'none',
          pass: resolved.pass,
          plateQuery: body.plateQuery ?? null,
          now,
          clientAt: body.clientAt ? new Date(body.clientAt).getTime() : null,
        });
        return {
          decisionId,
          verdict: verdictView(verdict),
          pass: resolved.pass ? passView(resolved.pass, now) : null,
          openVisit: resolved.openVisit ? visitView(resolved.openVisit) : null,
          gate: { id: g.gate.id, name: g.gate.name, kind: g.gate.kind },
          site: { timezone: g.site.timezone, timezoneLabel: siteTimeLabel(g.site, now) },
        };
      });
    },
  );

  typed.post(
    '/gate/actions',
    {
      config: { permission: ANY_ACTION },
      schema: {
        tags,
        summary:
          'Действие поста с идемпотентным id: въезд, выезд, отказ, направить, отменить, проход',
        body: GateActionInputSchema,
        response: { 200: GateActionResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx((s) => runAction(s, request.body, { offline: false }));
    },
  );

  typed.post(
    '/gate/actions/sync',
    {
      config: { permission: ANY_ACTION },
      schema: {
        tags,
        summary: 'Офлайн-очередь поста: по порядку seq, «факт важнее лимита» (ADR-005)',
        body: GateSyncSchema,
        response: { 200: GateSyncResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const items = [...request.body.actions].sort((a, b) => a.seq - b.seq);
      const results = [];
      // Каждое действие — своя транзакция: блокировки арендатора не держатся на всю очередь, а
      // ошибка одного действия (нет права, нет причины) не отменяет остальные.
      for (const item of items) {
        try {
          results.push(
            await ctx.tx((s) =>
              runAction(s, item.action, { offline: true, localVerdict: item.localVerdict }),
            ),
          );
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          results.push({
            actionId: item.action.id,
            type: item.action.type,
            outcome: 'rejected' as const,
            code: error.code,
            message: error.message,
            verdict: null,
            decisionId: null,
            visitId: null,
            passId: null,
            replayed: false,
          });
        }
      }
      return { results };
    },
  );

  typed.get(
    '/gate/snapshot',
    {
      config: { permission: POST_VIEW },
      schema: {
        tags,
        summary: 'Снимок для поста офлайн: правила, пропуска, открытые визиты, очередь (ADR-005)',
        response: { 200: GateSnapshotSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const g = await gateContext(s);
        const now = ctx.now();
        const passes = await s.db
          .select()
          .from(schema.passes)
          .where(
            and(
              eq(schema.passes.organizationId, s.organizationId),
              eq(schema.passes.siteId, g.site.id),
              or(
                eq(schema.passes.status, 'pending_approval'),
                and(
                  eq(schema.passes.status, 'approved'),
                  or(
                    isNull(schema.passes.validTo),
                    gt(schema.passes.validTo, new Date(now - 86_400_000)),
                  ),
                ),
              ),
            ),
          );
        const visits = await openVisits(s.db, {
          organizationId: s.organizationId,
          siteId: g.site.id,
        });
        const queue = await queueEntries(s, g.site.id, null);
        const byQuota = new Map<string, string[]>();
        for (const e of queue)
          byQuota.set(e.quotaId, [...(byQuota.get(e.quotaId) ?? []), e.passId]);
        const [last] = await s.db
          .select({ id: sql<number>`coalesce(max(${schema.domainEvents.id}), 0)::bigint` })
          .from(schema.domainEvents)
          .where(
            and(
              eq(schema.domainEvents.organizationId, s.organizationId),
              eq(schema.domainEvents.siteId, g.site.id),
            ),
          );
        return {
          asOf: new Date(now).toISOString(),
          lastEventId: Number(last?.id ?? 0),
          site: { ...g.siteView, timezoneLabel: siteTimeLabel(g.site, now) },
          gate: { ...g.gateView },
          rules: { ...g.rules },
          passes: passes.map((p) => ({
            ...enginePass(p),
            plateRaw: p.plateRaw,
            brand: p.brand,
            driverName: p.driverName,
            driverPhone: p.driverPhone,
            comment: p.comment,
          })),
          openVisits: visits.map((v) => ({ ...engineVisit(v) })),
          queue: [...byQuota].map(([quotaId, passIds]) => ({ quotaId, passIds })),
        };
      });
    },
  );

  typed.get(
    '/gate/queue',
    {
      config: { permission: 'queue.view' },
      schema: {
        tags,
        summary: 'Очередь у ворот объекта этого поста',
        response: { 200: QueueViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const g = await gateContext(s);
        return { items: await queueEntries(s, g.site.id, null) };
      });
    },
  );

  typed.post(
    '/gate/requests',
    {
      config: { permission: 'gate.request' },
      schema: {
        tags,
        summary: '«Машина без пропуска»: запрос арендатору с поста',
        body: GateRequestCreateSchema,
        response: { 201: GateRequestViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const row = await ctx.tx(async (s) =>
        createGateRequest(s, await gateContext(s), request.body),
      );
      return reply.status(201).send(gateRequestView(row));
    },
  );

  typed.get(
    '/gate/requests',
    {
      config: { permission: 'gate.request' },
      schema: {
        tags,
        summary: 'Запросы этого поста за сутки',
        response: { 200: z.object({ items: z.array(GateRequestViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const g = await gateContext(s);
        const rows = await s.db
          .select()
          .from(schema.gateRequests)
          .where(
            and(
              eq(schema.gateRequests.organizationId, s.organizationId),
              eq(schema.gateRequests.gateId, g.gate.id),
              gt(schema.gateRequests.createdAt, new Date(ctx.now() - 86_400_000)),
            ),
          )
          .orderBy(desc(schema.gateRequests.createdAt));
        return { items: rows.map(gateRequestView) };
      });
    },
  );

  typed.get(
    '/sites/:siteId/gate-requests',
    {
      config: { permission: 'gate.request' },
      schema: {
        tags,
        summary: 'Запросы с постов объекта (арендатор — только свои)',
        params: SiteParamsSchema,
        querystring: GateRequestListQuerySchema,
        response: { 200: z.object({ items: z.array(GateRequestViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const tenantIds = ctx.actor.tenantIds;
        const rows = await s.db
          .select()
          .from(schema.gateRequests)
          .where(
            and(
              eq(schema.gateRequests.organizationId, s.organizationId),
              eq(schema.gateRequests.siteId, site.id),
              request.query.status
                ? eq(schema.gateRequests.status, request.query.status)
                : undefined,
              tenantIds === null
                ? undefined
                : tenantIds.length === 0
                  ? sql`false`
                  : inArray(schema.gateRequests.tenantId, [...tenantIds]),
            ),
          )
          .orderBy(desc(schema.gateRequests.createdAt))
          .limit(200);
        return { items: rows.map(gateRequestView) };
      });
    },
  );

  typed.post(
    '/gate-requests/:id/approve',
    {
      config: { permission: 'gate.request' },
      schema: {
        tags,
        summary: '«Оформить»: разовый пропуск на машину у ворот (сценарий 15)',
        params: IdParamsSchema,
        body: GateRequestApproveSchema,
        response: {
          200: z.object({ request: GateRequestViewSchema, pass: PassCreatedSchema }),
        },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { request: row, pass } = await approveGateRequest(s, request.params.id, request.body);
        return {
          request: gateRequestView(row),
          pass: {
            ...passView(pass.row, ctx.now()),
            driverPageUrl: `/p/${pass.driverToken}`,
            warnings: pass.warnings,
          },
        };
      });
    },
  );

  typed.post(
    '/gate-requests/:id/reject',
    {
      config: { permission: 'gate.request' },
      schema: {
        tags,
        summary: '«Отклонить» запрос с поста (с причиной)',
        params: IdParamsSchema,
        body: RejectSchema,
        response: { 200: GateRequestViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        gateRequestView(await rejectGateRequest(s, request.params.id, request.body.note)),
      );
    },
  );
}

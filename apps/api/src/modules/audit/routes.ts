import {
  AuditEntrySchema,
  AuditQuerySchema,
  GateDecisionQuerySchema,
  GateDecisionViewSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertSiteAccess, ctxOf } from '../../core/context';
import { loadSite } from '../../core/loaders';

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** Журнал аудита и журнал КПП с «Почему?» (trace) — чтение для администратора (CLAUDE.md п. 6, B2). */
export function registerAuditModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['audit'];

  typed.get(
    '/audit',
    {
      config: { permission: 'audit.view' },
      schema: {
        tags,
        summary: 'Журнал аудита: было → стало, кто, с какого устройства, причина',
        querystring: AuditQuerySchema,
        response: { 200: z.object({ items: z.array(AuditEntrySchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      if (q.siteId) assertSiteAccess(ctx, q.siteId);
      return ctx.tx(async (s) => {
        const rows = await s.db
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.organizationId, s.organizationId),
              q.siteId ? eq(schema.auditLog.siteId, q.siteId) : undefined,
              !q.siteId && ctx.actor.siteIds !== null
                ? inArray(schema.auditLog.siteId, [...ctx.actor.siteIds])
                : undefined,
              q.entity ? eq(schema.auditLog.entity, q.entity) : undefined,
              q.entityId ? eq(schema.auditLog.entityId, q.entityId) : undefined,
            ),
          )
          .orderBy(desc(schema.auditLog.id))
          .limit(q.limit)
          .offset(q.offset);
        return {
          items: rows.map((r) => ({
            id: r.id,
            at: r.at.toISOString(),
            siteId: r.siteId,
            actorType: r.actorType,
            actorUserId: r.actorUserId,
            actorGateAccountId: r.actorGateAccountId,
            deviceId: r.deviceId,
            entity: r.entity,
            entityId: r.entityId,
            action: r.action,
            diff: (r.diff as Record<string, unknown> | null) ?? null,
            reason: r.reason,
            snapshot: (r.snapshot as Record<string, unknown> | null) ?? null,
          })),
        };
      });
    },
  );

  typed.get(
    '/sites/:siteId/gate-decisions',
    {
      config: { permission: 'audit.view' },
      schema: {
        tags,
        summary: 'Журнал КПП: каждый вердикт с причинами и trace («Почему?»)',
        params: SiteParamsSchema,
        querystring: GateDecisionQuerySchema,
        response: { 200: z.object({ items: z.array(GateDecisionViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select()
          .from(schema.gateDecisions)
          .where(
            and(
              eq(schema.gateDecisions.organizationId, s.organizationId),
              eq(schema.gateDecisions.siteId, site.id),
              q.gateId ? eq(schema.gateDecisions.gateId, q.gateId) : undefined,
              q.passId ? eq(schema.gateDecisions.passId, q.passId) : undefined,
            ),
          )
          .orderBy(desc(schema.gateDecisions.id))
          .limit(q.limit)
          .offset(q.offset);
        return {
          items: rows.map((r) => ({
            id: r.id,
            gateId: r.gateId,
            at: r.at.toISOString(),
            clientAt: iso(r.clientAt),
            direction: r.direction,
            passId: r.passId,
            verdict: r.verdict,
            action: r.action,
            visitId: r.visitId,
            reasons: r.reasons as Record<string, unknown>[],
            trace: r.trace as Record<string, unknown>[],
            offline: r.offline,
            engineVersion: r.engineVersion,
            snapshot: r.snapshot as Record<string, unknown>,
          })),
        };
      });
    },
  );
}

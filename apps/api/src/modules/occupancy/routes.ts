import {
  OccupancySummarySchema,
  OccupancyViewSchema,
  QueueViewSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { openVisits, schema } from '@oxrana/db';
import { capacityOf, countOccupancy } from '@oxrana/engine';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { isTenantUser } from '../../actor';
import { type Ctx, ctxOf, type Scope } from '../../core/context';
import { loadSite, type SiteRow } from '../../core/loaders';
import { queueEntries } from '../gate/queue';
import { siteTimeLabel } from '../org/sites';
import { engineVisit } from '../passes/views';

/** Чьи лимиты видит актор: пользователь арендатора — только свои (ADR-007). */
function tenantFilter(ctx: Ctx): readonly string[] | null {
  return isTenantUser(ctx.actor) ? (ctx.actor.tenantIds ?? []) : null;
}

/**
 * Табло (`occupancy`): занятость лимитов по открытым визитам — тем же `countOccupancy`, что на
 * посту и в транзакции въезда. У объекта — своё время и подпись пояса (ADR-009).
 */
async function occupancyOf(s: Scope, site: SiteRow, tenants: readonly string[] | null) {
  const now = s.ctx.now();
  const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  const visits = (
    await openVisits(s.db, { organizationId: s.organizationId, siteId: site.id })
  ).map(engineVisit);
  const waiting = await queueEntries(s, site.id, tenants);
  const quotas = rules.quotas.filter(
    (q) =>
      (tenants === null || tenants.includes(q.tenantId)) &&
      q.validFrom <= now &&
      (q.validTo === null || q.validTo > now),
  );
  return {
    site: {
      id: site.id,
      name: site.name,
      timezone: site.timezone,
      timezoneLabel: siteTimeLabel(site, now),
    },
    asOf: new Date(now).toISOString(),
    quotas: quotas.map((q) => ({
      quotaId: q.id,
      tenantId: q.tenantId,
      tenantName: rules.tenants.find((t) => t.id === q.tenantId)?.name ?? '',
      name: q.name,
      occupied: countOccupancy(visits, q),
      capacity: capacityOf(q, rules.docks),
      enforcement: q.enforcement,
      waiting: waiting.filter((w) => w.quotaId === q.id).length,
    })),
  };
}

export function registerOccupancyModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['occupancy'];

  typed.get(
    '/sites/:siteId/occupancy',
    {
      config: { permission: 'occupancy.view' },
      schema: {
        tags,
        summary: 'Табло объекта: занятость лимитов и очередь',
        params: SiteParamsSchema,
        response: { 200: OccupancyViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        occupancyOf(s, await loadSite(s, request.params.siteId), tenantFilter(ctx)),
      );
    },
  );

  typed.get(
    '/occupancy',
    {
      config: { permission: 'occupancy.view' },
      schema: {
        tags,
        summary: 'Сводка по объектам: у каждого объекта своё время и подпись пояса',
        response: { 200: OccupancySummarySchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const sites = await s.db
          .select()
          .from(schema.sites)
          .where(
            and(
              eq(schema.sites.organizationId, s.organizationId),
              isNull(schema.sites.deletedAt),
              ctx.actor.siteIds === null
                ? undefined
                : inArray(schema.sites.id, [...ctx.actor.siteIds]),
            ),
          )
          .orderBy(asc(schema.sites.name));
        const items = [];
        for (const site of sites) items.push(await occupancyOf(s, site, tenantFilter(ctx)));
        return { items };
      });
    },
  );

  typed.get(
    '/sites/:siteId/queue',
    {
      config: { permission: 'queue.view' },
      schema: {
        tags,
        summary: 'Очередь у ворот объекта',
        params: SiteParamsSchema,
        response: { 200: QueueViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        return { items: await queueEntries(s, site.id, tenantFilter(ctx)) };
      });
    },
  );
}

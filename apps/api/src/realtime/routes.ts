import type { ServerResponse } from 'node:http';
import { SiteParamsSchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Actor, isTenantUser } from '../actor';
import { type Ctx, ctxOf } from '../core/context';
import { loadSite } from '../core/loaders';
import { gateContext } from '../modules/gate/core';
import type { HubEvent } from './hub';

/** Сколько событий отдаём при переподключении; больше — `resync`: клиент перечитывает состояние. */
const REPLAY_LIMIT = 1000;
const HEARTBEAT_MS = 25_000;

/** События объекта, которые видит любой подписчик объекта (без арендатора в payload). */
const SITE_WIDE = new Set(['rules.changed', 'site.changed', 'site.timezone_changed']);

/**
 * Кому видно событие (ADR-004 п. 4): пост и сотрудники оператора — все события своего объекта;
 * пользователь арендатора — только события своих арендаторов и общие события объекта; сигнал
 * «место освободилось» — только посту, где стоит первый в очереди (сценарий 40).
 */
export function visibleTo(actor: Actor, event: Pick<HubEvent, 'type' | 'payload'>): boolean {
  if (event.type === 'queue.slot_freed') {
    if (actor.kind === 'gate_account') return event.payload.gateId === actor.gateId;
    return !isTenantUser(actor);
  }
  if (!isTenantUser(actor)) return true;
  const tenantId = event.payload.tenantId;
  if (typeof tenantId === 'string') return (actor.tenantIds ?? []).includes(tenantId);
  return tenantId === undefined && SITE_WIDE.has(event.type);
}

function format(event: HubEvent): string {
  const data = {
    id: event.id,
    type: event.type,
    at: event.at,
    siteId: event.siteId,
    aggregate: event.aggregate,
    aggregateId: event.aggregateId,
    payload: event.payload,
  };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const streams = new Set<ServerResponse>();

/**
 * Поток SSE объекта (ADR-004 п. 4–5): `id:` = id события, `retry: 3000`, heartbeat каждые 25 с;
 * при переподключении `Last-Event-ID` — дочитывание из таблицы, при большом разрыве — `resync`.
 * Подписка на хаб ставится до чтения таблицы, чтобы не потерять событие между ними.
 */
async function stream(
  ctx: Ctx,
  request: FastifyRequest,
  reply: FastifyReply,
  siteId: string,
): Promise<void> {
  const header = request.headers['last-event-id'];
  const query = (request.query ?? {}) as { lastEventId?: string };
  const lastEventId = Number(header ?? query.lastEventId ?? 0) || 0;
  const { actor } = ctx;

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': request.id,
  });
  raw.write('retry: 3000\n\n');
  streams.add(raw);

  let lastSent = lastEventId;
  let replaying = true;
  const buffered: HubEvent[] = [];
  const send = (event: HubEvent) => {
    if (event.id <= lastSent) return;
    lastSent = event.id;
    if (visibleTo(actor, event)) raw.write(format(event));
  };
  const unsubscribe = ctx.deps.hub.subscribe(actor.organizationId, siteId, (event) => {
    if (replaying) buffered.push(event);
    else send(event);
  });
  const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    streams.delete(raw);
  };
  request.raw.on('close', close);

  try {
    if (lastEventId > 0) {
      const rows = await ctx.tx((s) =>
        s.db
          .select()
          .from(schema.domainEvents)
          .where(
            and(
              eq(schema.domainEvents.organizationId, s.organizationId),
              eq(schema.domainEvents.siteId, siteId),
              gt(schema.domainEvents.id, lastEventId),
            ),
          )
          .orderBy(asc(schema.domainEvents.id))
          .limit(REPLAY_LIMIT + 1),
      );
      if (rows.length > REPLAY_LIMIT) {
        raw.write(`event: resync\ndata: {"reason":"too_many_events"}\n\n`);
        lastSent = rows[rows.length - 1]?.id ?? lastSent;
      } else {
        for (const row of rows) {
          send({
            id: row.id,
            organizationId: row.organizationId,
            siteId: row.siteId,
            type: row.type,
            at: row.at.toISOString(),
            aggregate: row.aggregate,
            aggregateId: row.aggregateId,
            payload: row.payload as Record<string, unknown>,
          });
        }
      }
    }
  } finally {
    replaying = false;
    for (const event of buffered.splice(0)) send(event);
  }
}

const StreamQuery = z.strictObject({ lastEventId: z.string().regex(/^\d+$/).optional() });

export function registerRealtimeRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['realtime'];

  // Открытые потоки закрываются до остановки сервера, иначе close() ждал бы их вечно.
  app.addHook('preClose', async () => {
    for (const raw of streams) raw.end();
    streams.clear();
  });

  typed.get(
    '/sites/:siteId/events',
    {
      config: {
        permission: ['occupancy.view', 'pass.view', 'pass.view_all_tenants', 'queue.view'],
      },
      schema: {
        tags,
        summary: 'События объекта (SSE): табло, пропуска, визиты — без F5',
        params: SiteParamsSchema,
        querystring: StreamQuery,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const site = await ctx.tx((s) => loadSite(s, request.params.siteId));
      await stream(ctx, request, reply, site.id);
    },
  );

  typed.get(
    '/gate/events',
    {
      config: { permission: ['visit.check_in', 'visit.check_out', 'gate.passage'] },
      schema: {
        tags,
        summary: 'События объекта этого поста (SSE)',
        querystring: StreamQuery,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const g = await ctx.tx((s) => gateContext(s));
      await stream(ctx, request, reply, g.site.id);
    },
  );
}

import {
  IN_APP_CHANNEL,
  NotificationListQuerySchema,
  NotificationListSchema,
  NotificationReadSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ctxOf, type Scope } from '../../core/context';
import { AppError } from '../../errors';
import { registerNotificationDispatcher } from './dispatch';

/** Уведомления кабинета (ADR-023): своё, любому вошедшему пользователю; чужие строки не видны. */
type Row = typeof schema.notifications.$inferSelect;

function view(row: Row) {
  const p = row.payload as {
    title?: string;
    text?: string;
    passId?: string | null;
    tenantId?: string | null;
    changes?: Record<string, { from: unknown; to: unknown }> | null;
  };
  return {
    id: row.id,
    kind: row.kind,
    title: p.title ?? '',
    text: p.text ?? '',
    passId: p.passId ?? null,
    tenantId: p.tenantId ?? null,
    changes: p.changes ?? null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

function mine(s: Scope) {
  if (s.ctx.actor.kind !== 'user') {
    throw new AppError('forbidden', { message: 'Уведомления есть только у пользователей.' });
  }
  return and(
    eq(schema.notifications.organizationId, s.organizationId),
    eq(schema.notifications.userId, s.ctx.actor.id),
    eq(schema.notifications.channel, IN_APP_CHANNEL),
  );
}

export function registerNotificationRoutes(app: FastifyInstance): void {
  registerNotificationDispatcher();
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['notifications'];

  async function unreadCount(s: Scope): Promise<number> {
    const [row] = await s.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notifications)
      .where(and(mine(s), isNull(schema.notifications.readAt)));
    return row?.n ?? 0;
  }

  typed.get(
    '/notifications',
    {
      config: { self: true },
      schema: {
        tags,
        summary: 'Мои уведомления (колокольчик): новые сверху и число непрочитанных',
        querystring: NotificationListQuerySchema,
        response: { 200: NotificationListSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const q = request.query;
      return ctx.tx(async (s) => {
        const rows = await s.db
          .select()
          .from(schema.notifications)
          .where(
            and(mine(s), q.unread === 'true' ? isNull(schema.notifications.readAt) : undefined),
          )
          .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
          .limit(q.limit);
        return { items: rows.map(view), unreadCount: await unreadCount(s) };
      });
    },
  );

  typed.post(
    '/notifications/read',
    {
      config: { self: true },
      schema: {
        tags,
        summary: 'Отметить уведомления прочитанными: перечисленные или все',
        body: NotificationReadSchema,
        response: { 200: z.object({ unreadCount: z.int() }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { ids, all } = request.body;
      if (!all && (!ids || ids.length === 0)) {
        throw new AppError('validation_failed', {
          field: 'ids',
          message: 'Укажите, какие уведомления отметить, или «все».',
        });
      }
      return ctx.tx(async (s) => {
        await s.db
          .update(schema.notifications)
          .set({ readAt: new Date(ctx.now()) })
          .where(
            and(
              mine(s),
              isNull(schema.notifications.readAt),
              all ? undefined : inArray(schema.notifications.id, ids ?? []),
            ),
          );
        return { unreadCount: await unreadCount(s) };
      });
    },
  );
}

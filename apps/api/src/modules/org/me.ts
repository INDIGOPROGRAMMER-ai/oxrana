import { MeSettingsPatchSchema, MeSettingsViewSchema, timezoneLabel } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { type Ctx, ctxOf, type Scope } from '../../core/context';
import { changedFields, diffOf } from '../../core/diff';
import { notFound } from '../../core/loaders';
import { AppError } from '../../errors';
import { assertTimezone } from './sites';

/**
 * Личные настройки пользователя (ADR-009, дополнение): «показывать ещё и моё время». Основное
 * время на экранах — всегда время объекта с подписью пояса; своё — только второй строкой.
 * `users` — платформенная таблица без RLS: доступ ограничен самим пользователем здесь.
 */
type UserRow = typeof schema.users.$inferSelect;

function requireUser(ctx: Ctx): string {
  if (ctx.actor.kind !== 'user') {
    throw new AppError('forbidden', {
      message: 'Личные настройки есть только у пользователей; у учётки поста их нет.',
    });
  }
  return ctx.actor.id;
}

async function loadMe(s: Scope, userId: string): Promise<UserRow> {
  const [user] = await s.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw notFound('Пользователь');
  return user;
}

function view(user: UserRow, at: number) {
  return {
    showOwnTime: user.showOwnTime,
    ownTimezone: user.ownTimezone,
    ownTimezoneLabel: user.ownTimezone ? timezoneLabel(user.ownTimezone, at) : null,
  };
}

export function registerMeRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['me'];

  typed.get(
    '/me/settings',
    {
      config: { authenticated: true },
      schema: { tags, summary: 'Мои настройки', response: { 200: MeSettingsViewSchema } },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const userId = requireUser(ctx);
      return ctx.tx(async (s) => view(await loadMe(s, userId), ctx.now()));
    },
  );

  typed.patch(
    '/me/settings',
    {
      config: { permission: 'profile.manage_own' },
      schema: {
        tags,
        summary: 'Изменить мои настройки («показывать ещё и моё время»)',
        body: MeSettingsPatchSchema,
        response: { 200: MeSettingsViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const userId = requireUser(ctx);
      const input = request.body;
      if (input.ownTimezone) assertTimezone(input.ownTimezone, 'ownTimezone');
      return ctx.tx(async (s) => {
        const user = await loadMe(s, userId);
        const patch = Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ) as Partial<UserRow>;
        const showOwnTime = patch.showOwnTime ?? user.showOwnTime;
        const ownTimezone = patch.ownTimezone !== undefined ? patch.ownTimezone : user.ownTimezone;
        if (showOwnTime && !ownTimezone) {
          throw new AppError('validation_failed', {
            field: 'ownTimezone',
            message: 'Чтобы показывать своё время, выберите свой часовой пояс.',
          });
        }
        const fields = changedFields(user, patch);
        if (fields.length === 0) return view(user, ctx.now());
        const [updated = user] = await s.db
          .update(schema.users)
          .set(Object.fromEntries(fields.map((f) => [f, patch[f]])))
          .where(eq(schema.users.id, user.id))
          .returning();
        await s.audit({
          siteId: null,
          entity: 'user',
          entityId: user.id,
          action: 'update_settings',
          diff: diffOf(user, updated, fields),
        });
        return view(updated, ctx.now());
      });
    },
  );
}

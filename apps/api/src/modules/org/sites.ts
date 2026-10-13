import {
  DEFAULT_APPROVAL_POLICIES,
  isValidTimezone,
  OrganizationPatchSchema,
  OrganizationSettingsSchema,
  type OrganizationView,
  OrganizationViewSchema,
  SiteCreateSchema,
  SiteListViewSchema,
  SiteParamsSchema,
  SitePatchSchema,
  SiteSettingsChangeSchema,
  SiteSettingsSchema,
  SiteTimezoneChangeSchema,
  type SiteView,
  SiteViewSchema,
  siteCity,
  suggestTimezone,
  TIMEZONES,
  TimezonesQuerySchema,
  TimezonesViewSchema,
  timezoneLabel,
  timezoneName,
  WorkingHoursSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import { type Ctx, ctxOf, type Scope } from '../../core/context';
import { changedFields, diffOf } from '../../core/diff';
import { loadSite, notFound, type SiteRow } from '../../core/loaders';
import { AppError } from '../../errors';

/** Подпись времени объекта (ADR-009): город из адреса, если он в том же поясе. */
export function siteTimeLabel(site: Pick<SiteRow, 'timezone' | 'address'>, at: number): string {
  return timezoneLabel(site.timezone, at, siteCity(site.address, site.timezone));
}

export function siteView(site: SiteRow, at: number): SiteView {
  return {
    id: site.id,
    name: site.name,
    address: site.address,
    timezone: site.timezone,
    timezoneLabel: siteTimeLabel(site, at),
    workingHours: site.workingHours ?? null,
    settings: SiteSettingsSchema.parse(site.settings),
  };
}

type SettingsPatch = z.infer<typeof SiteSettingsChangeSchema>;

/** Хранятся только заданные ключи (DATA_MODEL §7 п. 9): присланные — поверх сохранённых. */
function mergeSiteSettings(stored: unknown, settings: SettingsPatch): Record<string, unknown> {
  const current = (stored ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current, ...settings };
  if (settings.retentionDays) {
    merged.retentionDays = {
      ...((current.retentionDays as Record<string, unknown> | undefined) ?? {}),
      ...settings.retentionDays,
    };
  }
  SiteSettingsSchema.parse(merged);
  return merged;
}

export function assertTimezone(tz: string, field = 'timezone'): void {
  if (!isValidTimezone(tz)) {
    throw new AppError('timezone_invalid', {
      field,
      message: `Неизвестный часовой пояс «${tz}». Выберите пояс из списка (например, Asia/Yekaterinburg).`,
    });
  }
}

/** Изменение пояса, которое нельзя сделать обычной правкой (ADR-009, дополнение). */
const TIMEZONE_CONSEQUENCES =
  'Смена пояса объекта: прошлые записи хранятся в UTC и не меняются, но на всех экранах будут показаны ' +
  'в новом поясе; «местные сутки» прошлого (начисления за сверхлимит, отчёты за прошедшие дни) не ' +
  'пересчитываются; рабочее время, расписания лимитов и окна прибытия — местные часы и начнут действовать ' +
  'в новом поясе. Чтобы сменить пояс, укажите причину и подтвердите (confirm: true).';

function requireOrganizationScope(ctx: Ctx, what: string): void {
  if (ctx.actor.siteIds !== null) {
    throw new AppError('forbidden', {
      message: `${what} — только для роли на всю организацию; ваша роль назначена на отдельные объекты.`,
      settingLink: '/admin/users',
    });
  }
}

async function loadOrganization(s: Scope) {
  const [org] = await s.db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, s.organizationId));
  if (!org) throw notFound('Организация');
  return org;
}

function organizationView(
  org: typeof schema.organizations.$inferSelect,
  at: number,
): OrganizationView {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    defaultTimezone: org.defaultTimezone,
    defaultTimezoneLabel: org.defaultTimezone ? timezoneLabel(org.defaultTimezone, at) : null,
    settings: OrganizationSettingsSchema.parse(org.settings ?? {}),
  };
}

export function registerSiteRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['org'];

  typed.get(
    '/org',
    {
      config: { authenticated: true },
      schema: { tags, summary: 'Организация', response: { 200: OrganizationViewSchema } },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => organizationView(await loadOrganization(s), ctx.now()));
    },
  );

  typed.patch(
    '/org',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Изменить организацию (название, пояс по умолчанию)',
        body: OrganizationPatchSchema,
        response: { 200: OrganizationViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      requireOrganizationScope(ctx, 'Настройки организации');
      const { settings, ...input } = request.body;
      if (input.defaultTimezone) assertTimezone(input.defaultTimezone, 'defaultTimezone');
      return ctx.tx(async (s) => {
        const org = await loadOrganization(s);
        const patch = Object.fromEntries(
          Object.entries(input).filter(([, v]) => v !== undefined),
        ) as Partial<typeof org>;
        if (settings !== undefined) {
          // Хранятся только заданные ключи: присланные — поверх сохранённых (как у настроек объекта).
          const merged = {
            ...((org.settings ?? {}) as Record<string, unknown>),
            ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)),
          };
          OrganizationSettingsSchema.parse(merged);
          patch.settings = merged;
        }
        const fields = changedFields(org, patch);
        if (fields.length === 0) return organizationView(org, ctx.now());
        const [updated = org] = await s.db
          .update(schema.organizations)
          .set(Object.fromEntries(fields.map((f) => [f, patch[f]])))
          .where(eq(schema.organizations.id, org.id))
          .returning();
        await s.audit({
          siteId: null,
          entity: 'organization',
          entityId: org.id,
          action: 'update',
          diff: diffOf(org, updated, fields),
        });
        if (fields.includes('settings')) {
          // «Вести договоры» меняет срез правил всех объектов организации.
          await s.emit('rules.changed', {
            siteId: null,
            aggregate: 'organization',
            aggregateId: org.id,
            payload: { entity: 'organization', entityId: org.id },
          });
        }
        return organizationView(updated, ctx.now());
      });
    },
  );

  typed.get(
    '/timezones',
    {
      config: { authenticated: true },
      schema: {
        tags,
        summary: 'Часовые пояса: список, пояс организации и подсказка по адресу',
        querystring: TimezonesQuerySchema,
        response: { 200: TimezonesViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const now = ctx.now();
      const org = await ctx.tx((s) => loadOrganization(s));
      const option = (tz: string) => ({
        id: tz,
        name: timezoneName(tz),
        label: timezoneLabel(tz, now),
      });
      const suggestion = suggestTimezone(request.query.address);
      return {
        zones: TIMEZONES.map((t) => option(t.id)),
        organizationDefault: org.defaultTimezone ? option(org.defaultTimezone) : null,
        suggestion: suggestion
          ? {
              timezone: suggestion.timezone,
              city: suggestion.city,
              matchedBy: suggestion.matchedBy,
              label: timezoneLabel(suggestion.timezone, now, suggestion.city),
              differsFromDefault: suggestion.timezone !== org.defaultTimezone,
            }
          : null,
      };
    },
  );

  typed.get(
    '/sites',
    {
      config: { authenticated: true },
      schema: {
        tags,
        summary: 'Объекты организации (у каждого — свой пояс и подпись)',
        response: { 200: SiteListViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const rows = await s.db
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
        return { items: rows.map((site) => siteView(site, ctx.now())) };
      });
    },
  );

  typed.get(
    '/sites/:siteId',
    {
      config: { authenticated: true },
      schema: {
        tags,
        summary: 'Объект',
        params: SiteParamsSchema,
        response: { 200: SiteViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => siteView(await loadSite(s, request.params.siteId), ctx.now()));
    },
  );

  typed.post(
    '/sites',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Создать объект (пояс по умолчанию — пояс организации)',
        body: SiteCreateSchema,
        response: { 201: SiteViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      requireOrganizationScope(ctx, 'Создание объекта');
      const input = request.body;
      const view = await ctx.tx(async (s) => {
        const org = await loadOrganization(s);
        const timezone = input.timezone ?? org.defaultTimezone;
        if (!timezone) throw new AppError('timezone_required', { field: 'timezone' });
        assertTimezone(timezone);
        const [site] = await s.db
          .insert(schema.sites)
          .values({
            organizationId: s.organizationId,
            name: input.name,
            address: input.address ?? null,
            timezone,
            workingHours: input.workingHours ?? null,
            settings: input.settings ?? {},
          })
          .returning();
        if (!site) throw new Error('site insert');
        // Политики согласования по умолчанию — все 9 сочетаний (Q-55).
        await s.db.insert(schema.approvalPolicies).values(
          DEFAULT_APPROVAL_POLICIES.map((p) => ({
            organizationId: s.organizationId,
            siteId: site.id,
            creatorKind: p.creatorKind,
            passType: p.passType,
            mode: p.mode,
            commentRequired: p.commentRequired ?? false,
          })),
        );
        await s.audit({
          siteId: site.id,
          entity: 'site',
          entityId: site.id,
          action: 'create',
          diff: diffOf(null, site, ['name', 'address', 'timezone', 'workingHours', 'settings']),
          snapshot: { timezoneSource: input.timezone ? 'explicit' : 'organization_default' },
        });
        await s.emit('site.changed', {
          siteId: site.id,
          aggregate: 'site',
          aggregateId: site.id,
          payload: { siteId: site.id, fields: ['created'] },
        });
        return siteView(site, ctx.now());
      });
      return reply.status(201).send(view);
    },
  );

  typed.patch(
    '/sites/:siteId',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Изменить объект (только переданные поля; пояс — отдельным действием)',
        params: SiteParamsSchema,
        body: SitePatchSchema,
        response: { 200: SiteViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { timezone, settings, ...rest } = request.body;
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        if (timezone !== undefined && timezone !== site.timezone) {
          throw new AppError('timezone_change_separate', {
            field: 'timezone',
            settingLink: `/admin/sites/${site.id}/timezone`,
          });
        }
        const patch: Partial<SiteRow> = Object.fromEntries(
          Object.entries(rest).filter(([, v]) => v !== undefined),
        );
        if (rest.workingHours) WorkingHoursSchema.parse(rest.workingHours);
        if (settings !== undefined) patch.settings = mergeSiteSettings(site.settings, settings);
        const fields = changedFields(site, patch);
        if (fields.length === 0) return siteView(site, ctx.now());
        const [updated = site] = await s.db
          .update(schema.sites)
          .set(Object.fromEntries(fields.map((f) => [f, patch[f]])))
          .where(
            and(eq(schema.sites.organizationId, s.organizationId), eq(schema.sites.id, site.id)),
          )
          .returning();
        await s.audit({
          siteId: site.id,
          entity: 'site',
          entityId: site.id,
          action: 'update',
          diff: diffOf(site, updated, fields),
        });
        await s.emit('site.changed', {
          siteId: site.id,
          aggregate: 'site',
          aggregateId: site.id,
          payload: { siteId: site.id, fields },
        });
        return siteView(updated, ctx.now());
      });
    },
  );

  // Сроки и рабочее время — правила, не устройство объекта: право `rule.manage` (Q-64).
  typed.patch(
    '/sites/:siteId/settings',
    {
      config: { permission: 'rule.manage' },
      schema: {
        tags,
        summary:
          'Изменить настройки объекта: сроки пропусков, рабочее время, допуски (только переданные ключи)',
        params: SiteParamsSchema,
        body: SiteSettingsChangeSchema,
        response: { 200: SiteViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const merged = mergeSiteSettings(site.settings, request.body);
        const patch: Partial<SiteRow> = { settings: merged };
        const fields = changedFields(site, patch);
        if (fields.length === 0) return siteView(site, ctx.now());
        const [updated = site] = await s.db
          .update(schema.sites)
          .set({ settings: merged })
          .where(
            and(eq(schema.sites.organizationId, s.organizationId), eq(schema.sites.id, site.id)),
          )
          .returning();
        await s.audit({
          siteId: site.id,
          entity: 'site',
          entityId: site.id,
          action: 'update',
          diff: diffOf(site, updated, fields),
        });
        await s.emit('site.changed', {
          siteId: site.id,
          aggregate: 'site',
          aggregateId: site.id,
          payload: { siteId: site.id, fields: ['settings'] },
        });
        return siteView(updated, ctx.now());
      });
    },
  );

  typed.post(
    '/sites/:siteId/timezone',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Сменить пояс объекта (с причиной и подтверждением последствий)',
        params: SiteParamsSchema,
        body: SiteTimezoneChangeSchema,
        response: { 200: SiteViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { timezone, reason, confirm } = request.body;
      assertTimezone(timezone);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        if (site.timezone === timezone) return siteView(site, ctx.now());
        if (confirm !== true) {
          throw new AppError('confirmation_required', {
            field: 'confirm',
            message: TIMEZONE_CONSEQUENCES,
            details: {
              from: site.timezone,
              fromLabel: siteTimeLabel(site, ctx.now()),
              to: timezone,
              toLabel: timezoneLabel(timezone, ctx.now()),
            },
          });
        }
        const [updated = site] = await s.db
          .update(schema.sites)
          .set({ timezone })
          .where(
            and(eq(schema.sites.organizationId, s.organizationId), eq(schema.sites.id, site.id)),
          )
          .returning();
        await s.audit({
          siteId: site.id,
          entity: 'site',
          entityId: site.id,
          action: 'timezone_change',
          diff: {
            timezone: {
              from: site.timezone,
              to: timezone,
              fromLabel: siteTimeLabel(site, ctx.now()),
              toLabel: siteTimeLabel(updated, ctx.now()),
            },
          },
          reason,
        });
        await s.emit('site.timezone_changed', {
          siteId: site.id,
          aggregate: 'site',
          aggregateId: site.id,
          payload: { siteId: site.id, from: site.timezone, to: timezone },
        });
        await s.emit('rules.changed', {
          siteId: site.id,
          aggregate: 'site',
          aggregateId: site.id,
          payload: { entity: 'site', entityId: site.id },
        });
        return siteView(updated, ctx.now());
      });
    },
  );
}

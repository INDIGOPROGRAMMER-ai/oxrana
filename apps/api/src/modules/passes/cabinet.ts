import {
  CabinetContextSchema,
  PassBatchResultSchema,
  type PassFormFieldKey,
  PassRepeatSchema,
  SiteSettingsSchema,
  TenantParamsSchema,
  TenantTodaySchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { addLocalDays, localDate, localInstant, localParts } from '@oxrana/engine';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ctxOf } from '../../core/context';
import { loadSite, loadTenant } from '../../core/loaders';
import { siteTimeLabel } from '../org/sites';
import { loadActorForm } from '../pass-form/service';
import { createBatch } from './batch';
import { availableCategories } from './hints';
import { tenantDocks } from './validate';

/**
 * Кабинет арендатора (этап 7a): всё для шапки и форм одним запросом, сводка «сегодня» для главной,
 * «повторить вчерашний день». Права — как у просмотра и создания пропусков своего арендатора.
 */
const VIEW = ['pass.view', 'pass.view_all_tenants'] as const;
const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;

const minuteOf = (instant: number, tz: string): number => localParts(instant, tz).minuteOfDay;

export function registerCabinetRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['cabinet'];

  typed.get(
    '/tenants/:tenantId/cabinet',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Кабинет: арендатор, объект с поясом, справочники для форм',
        params: TenantParamsSchema,
        response: { 200: CabinetContextSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
        const now = ctx.now();
        const tz = site.timezone;
        const siteSettings = SiteSettingsSchema.parse(site.settings);
        const available = new Set(availableCategories(rules, tenant.id, now, tz).map((c) => c.id));
        const purposes = await s.db
          .select({ id: schema.visitPurposes.id, name: schema.visitPurposes.name })
          .from(schema.visitPurposes)
          .where(
            and(
              eq(schema.visitPurposes.organizationId, s.organizationId),
              eq(schema.visitPurposes.siteId, site.id),
              isNull(schema.visitPurposes.deletedAt),
            ),
          )
          .orderBy(asc(schema.visitPurposes.sort), asc(schema.visitPurposes.name));
        const view = rules.tenants.find((t) => t.id === tenant.id);
        return {
          tenant: {
            id: tenant.id,
            name: tenant.shortName,
            status: tenant.status,
            isOperator: tenant.isOperator,
            trucksDockRequired: tenant.trucksDockRequired,
            defaultCategoryId: tenant.defaultCategoryId,
            contractValidTo: view?.contractValidTo ?? null,
          },
          site: {
            id: site.id,
            name: site.name,
            timezone: tz,
            timezoneLabel: siteTimeLabel(site, now),
            pastStartToleranceMin: siteSettings.pastStartToleranceMin,
            singlePassMaxHours: siteSettings.singlePassMaxHours,
            multiPassMaxDays: siteSettings.multiPassMaxDays,
          },
          categories: rules.categories.map((c) => ({
            id: c.id,
            name: c.name,
            dockEligible: c.dockEligible,
            available: available.has(c.id),
          })),
          zones: rules.zones
            .map((z) => ({ id: z.id, name: z.name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
          purposes,
          docks: tenantDocks(rules, tenant.id).map((d) => ({ id: d.id, number: d.number })),
          today: localDate(now, tz),
          now: new Date(now).toISOString(),
        };
      });
    },
  );

  typed.get(
    '/tenants/:tenantId/today',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Сегодня по местным суткам объекта: ожидаются, въехали, выехали, отказы',
        params: TenantParamsSchema,
        response: { 200: TenantTodaySchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const tz = site.timezone;
        const date = localDate(ctx.now(), tz);
        const start = new Date(localInstant(date, 0, tz));
        const end = new Date(localInstant(addLocalDays(date, 1), 0, tz));
        const org = eq(schema.visits.organizationId, s.organizationId);
        const mine = eq(schema.visits.tenantId, tenant.id);

        const visitsToday = await s.db
          .select({
            passId: schema.visits.passId,
            timeIn: schema.visits.timeIn,
            timeOut: schema.visits.timeOut,
          })
          .from(schema.visits)
          .where(
            and(
              org,
              mine,
              or(
                and(gte(schema.visits.timeIn, start), lt(schema.visits.timeIn, end)),
                and(gte(schema.visits.timeOut, start), lt(schema.visits.timeOut, end)),
              ),
            ),
          );
        const inRange = (d: Date | null) => d !== null && d >= start && d < end;
        const entered = visitsToday.filter((v) => inRange(v.timeIn)).length;
        const exited = visitsToday.filter((v) => inRange(v.timeOut)).length;
        const enteredPassIds = new Set(
          visitsToday.flatMap((v) => (v.passId && inRange(v.timeIn) ? [v.passId] : [])),
        );

        const validToday = await s.db
          .select({ id: schema.passes.id })
          .from(schema.passes)
          .where(
            and(
              eq(schema.passes.organizationId, s.organizationId),
              eq(schema.passes.tenantId, tenant.id),
              eq(schema.passes.status, 'approved'),
              inArray(schema.passes.passType, ['single', 'multi']),
              lt(schema.passes.validFrom, end),
              or(isNull(schema.passes.validTo), gt(schema.passes.validTo, start)),
            ),
          );
        const expected = validToday.filter((p) => !enteredPassIds.has(p.id)).length;

        const pending = await s.db
          .select({ id: schema.passes.id })
          .from(schema.passes)
          .where(
            and(
              eq(schema.passes.organizationId, s.organizationId),
              eq(schema.passes.tenantId, tenant.id),
              eq(schema.passes.status, 'pending_approval'),
            ),
          );

        const refusals = await s.db
          .select({ id: schema.gateDecisions.id })
          .from(schema.gateDecisions)
          .innerJoin(schema.passes, eq(schema.passes.id, schema.gateDecisions.passId))
          .where(
            and(
              eq(schema.gateDecisions.organizationId, s.organizationId),
              eq(schema.gateDecisions.siteId, site.id),
              eq(schema.gateDecisions.action, 'refuse'),
              eq(schema.passes.tenantId, tenant.id),
              gte(schema.gateDecisions.at, start),
              lt(schema.gateDecisions.at, end),
            ),
          );

        const inside = await s.db
          .select({ id: schema.visits.id })
          .from(schema.visits)
          .where(and(org, mine, isNull(schema.visits.timeOut), eq(schema.visits.siteId, site.id)));

        return {
          date,
          expected,
          entered,
          exited,
          refused: refusals.length,
          pendingApproval: pending.length,
          inside: inside.length,
        };
      });
    },
  );

  typed.post(
    '/tenants/:tenantId/passes/repeat',
    {
      config: { permission: CREATE },
      schema: {
        tags,
        summary:
          '«Повторить день»: разовые пропуска выбранного дня создаются заново на другую дату (dryRun — предпросмотр)',
        params: TenantParamsSchema,
        body: PassRepeatSchema,
        response: { 200: PassBatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { sourceDate, targetDate, dryRun, shiftPastToNow } = request.body;
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const tz = site.timezone;
        const start = new Date(localInstant(sourceDate, 0, tz));
        const end = new Date(localInstant(addLocalDays(sourceDate, 1), 0, tz));
        const rows = await s.db
          .select()
          .from(schema.passes)
          .where(
            and(
              eq(schema.passes.organizationId, s.organizationId),
              eq(schema.passes.tenantId, tenant.id),
              eq(schema.passes.passType, 'single'),
              inArray(schema.passes.status, ['approved', 'pending_approval', 'used', 'expired']),
              gte(schema.passes.validFrom, start),
              lt(schema.passes.validFrom, end),
            ),
          )
          .orderBy(asc(schema.passes.createdAt), asc(schema.passes.id));
        if (rows.length === 0) {
          return {
            batchId: null,
            dryRun: dryRun ?? false,
            total: 0,
            created: 0,
            summary: 'В этот день разовых пропусков не было — повторять нечего',
            errors: [],
            passes: [],
          };
        }
        const shiftDays =
          (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${sourceDate}T00:00:00Z`)) /
          86_400_000;
        const nowMs = ctx.now();
        const shift = (d: Date | null, clampToNow = false): string | null => {
          if (d === null) return null;
          const day = addLocalDays(localDate(d.getTime(), tz), shiftDays);
          const moved = localInstant(day, minuteOf(d.getTime(), tz), tz);
          // «Сдвинуть начало прошедших на сейчас» — только по явному флагу (без молчаливых подмен)
          return new Date(
            clampToNow && shiftPastToNow && moved < nowMs ? nowMs : moved,
          ).toISOString();
        };
        // Поля, скрытые настройкой формы, в копию не переносятся (ADR-023): копия следует нынешней форме.
        const { form, enforced } = await loadActorForm(s, tenant);
        const keep = (key: PassFormFieldKey) => !enforced || form.fields[key] !== 'hidden';
        const drafts = rows.map((p) => ({
          passType: 'single' as const,
          participant: p.participant,
          ...(p.plateRaw ? { plate: p.plateRaw } : {}),
          categoryId: p.categoryId,
          brand: keep('brand') ? p.brand : null,
          personName: p.personName,
          personDocument: p.personDocument,
          driverName: keep('driverName') ? p.driverName : null,
          driverPhone: keep('driverPhone') ? p.driverPhone : null,
          purposeId: keep('purpose') ? p.purposeId : null,
          destinationZoneId: keep('destination') ? p.destinationZoneId : null,
          dockId: p.dockId,
          validFrom: shift(p.validFrom, true) ?? undefined,
          validTo: shift(p.validTo),
          windowFrom: keep('window') ? shift(p.windowFrom, true) : null,
          windowTo: keep('window') ? shift(p.windowTo) : null,
          comment: keep('comment') ? p.comment : null,
        }));
        return createBatch(s, tenant, drafts, dryRun ?? false);
      });
    },
  );
}

import {
  IdParamsSchema,
  SiteParamsSchema,
  VehicleCategoryCreateSchema,
  VehicleCategoryListQuerySchema,
  VehicleCategoryPatchSchema,
  VehicleCategoryViewSchema,
  vehicleCategoryPreset,
} from '@oxrana/contracts';
import { findUsages, schema, softDelete } from '@oxrana/db';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertSiteAccess, type Ctx, can, ctxOf, type Scope } from '../../core/context';
import { UsageSchema } from '../../core/crud';
import { changedFields, diffOf } from '../../core/diff';
import { loadSite, notFound } from '../../core/loaders';
import { pgErrorCode, UNIQUE_VIOLATION } from '../../core/refs';
import { usageView } from '../../core/usages';
import { AppError } from '../../errors';

/**
 * Типы транспорта (ADR-012): справочник организации с переопределением на объекте. Список для
 * объекта — «действующий»: запись объекта с тем же рекомендованным кодом заменяет запись
 * организации (так же собирает их `loadRuleSet`).
 */
type CategoryRow = typeof schema.vehicleCategories.$inferSelect;

function view(row: CategoryRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    presetCode: row.presetCode,
    name: row.name,
    enabled: row.enabled,
    dockEligible: row.dockEligible,
    sort: row.sort,
  };
}

/** Тип организации правит только роль на всю организацию; тип объекта — роль этого объекта. */
function assertCategoryScope(ctx: Ctx, siteId: string | null): void {
  if (siteId === null && ctx.actor.siteIds !== null) {
    throw new AppError('forbidden', {
      message:
        'Типы транспорта организации меняет роль на всю организацию. Для своего объекта создайте переопределение.',
      settingLink: '/admin/users',
    });
  }
  if (siteId !== null) assertSiteAccess(ctx, siteId);
}

async function findCategory(s: Scope, id: string): Promise<CategoryRow> {
  const [row] = await s.db
    .select()
    .from(schema.vehicleCategories)
    .where(
      and(
        eq(schema.vehicleCategories.organizationId, s.organizationId),
        eq(schema.vehicleCategories.id, id),
        isNull(schema.vehicleCategories.deletedAt),
      ),
    );
  if (!row) throw notFound('Тип транспорта');
  return row;
}

function conflict(error: unknown): unknown {
  if (pgErrorCode(error).code === UNIQUE_VIOLATION) {
    return new AppError('conflict', {
      field: 'presetCode',
      message: 'Этот рекомендованный тип уже включён. Измените существующую запись.',
    });
  }
  return error;
}

export function registerCategoryRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['vehicle_category'];

  typed.get(
    '/sites/:siteId/vehicle-categories',
    {
      config: { authenticated: true },
      schema: {
        tags,
        summary: 'Типы транспорта объекта (действующие; all=true — и выключенные)',
        params: SiteParamsSchema,
        querystring: VehicleCategoryListQuerySchema,
        response: { 200: z.object({ items: z.array(VehicleCategoryViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const showAll = request.query.all === 'true' && can(ctx, 'site.manage');
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select()
          .from(schema.vehicleCategories)
          .where(
            and(
              eq(schema.vehicleCategories.organizationId, s.organizationId),
              or(
                isNull(schema.vehicleCategories.siteId),
                eq(schema.vehicleCategories.siteId, site.id),
              ),
              isNull(schema.vehicleCategories.deletedAt),
            ),
          )
          .orderBy(asc(schema.vehicleCategories.sort), asc(schema.vehicleCategories.id));
        const overridden = new Set(
          rows.filter((r) => r.siteId !== null && r.presetCode !== null).map((r) => r.presetCode),
        );
        return {
          items: rows
            .filter(
              (r) => r.siteId !== null || r.presetCode === null || !overridden.has(r.presetCode),
            )
            .filter((r) => showAll || r.enabled)
            .map(view),
        };
      });
    },
  );

  typed.post(
    '/vehicle-categories',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Включить рекомендованный или создать свой тип транспорта',
        body: VehicleCategoryCreateSchema,
        response: { 201: VehicleCategoryViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const input = request.body;
      assertCategoryScope(ctx, input.siteId);
      const preset = input.presetCode ? vehicleCategoryPreset(input.presetCode) : null;
      const name = input.name ?? preset?.name;
      if (!name) {
        throw new AppError('validation_failed', {
          field: 'name',
          message: 'Укажите название типа транспорта (у своего типа нет названия по умолчанию).',
        });
      }
      const created = await ctx.tx(async (s) => {
        if (input.siteId) await loadSite(s, input.siteId);
        const [row] = await s.db
          .insert(schema.vehicleCategories)
          .values({
            organizationId: s.organizationId,
            siteId: input.siteId,
            presetCode: input.presetCode ?? null,
            name,
            enabled: input.enabled ?? true,
            dockEligible: input.dockEligible ?? preset?.dockEligible ?? false,
            sort: input.sort,
          })
          .returning()
          .catch((error: unknown) => {
            throw conflict(error);
          });
        if (!row) throw new Error('category insert');
        await s.audit({
          siteId: row.siteId,
          entity: 'vehicle_category',
          entityId: row.id,
          action: 'create',
          diff: diffOf(null, row, [
            'siteId',
            'presetCode',
            'name',
            'enabled',
            'dockEligible',
            'sort',
          ]),
        });
        await s.emit('rules.changed', {
          siteId: row.siteId,
          aggregate: 'vehicle_category',
          aggregateId: row.id,
          payload: { entity: 'vehicle_category', entityId: row.id },
        });
        return view(row);
      });
      return reply.status(201).send(created);
    },
  );

  typed.patch(
    '/vehicle-categories/:id',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Переименовать, выключить, сменить порядок (только переданные поля)',
        params: IdParamsSchema,
        body: VehicleCategoryPatchSchema,
        response: { 200: VehicleCategoryViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const row = await findCategory(s, request.params.id);
        assertCategoryScope(ctx, row.siteId);
        const patch = Object.fromEntries(
          Object.entries(request.body).filter(([, v]) => v !== undefined),
        ) as Partial<CategoryRow>;
        const fields = changedFields(row, patch);
        if (fields.length === 0) return view(row);
        const [updated = row] = await s.db
          .update(schema.vehicleCategories)
          .set(Object.fromEntries(fields.map((f) => [f, patch[f]])))
          .where(
            and(
              eq(schema.vehicleCategories.organizationId, s.organizationId),
              eq(schema.vehicleCategories.id, row.id),
            ),
          )
          .returning();
        await s.audit({
          siteId: row.siteId,
          entity: 'vehicle_category',
          entityId: row.id,
          action: 'update',
          diff: diffOf(row, updated, fields),
        });
        await s.emit('rules.changed', {
          siteId: row.siteId,
          aggregate: 'vehicle_category',
          aggregateId: row.id,
          payload: { entity: 'vehicle_category', entityId: row.id },
        });
        return view(updated);
      });
    },
  );

  typed.get(
    '/vehicle-categories/:id/usages',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Тип транспорта: где используется',
        params: IdParamsSchema,
        response: { 200: z.object({ usages: z.array(UsageSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const row = await findCategory(s, request.params.id);
        assertCategoryScope(ctx, row.siteId);
        return {
          usages: (await findUsages(s.db, schema.vehicleCategories, row.id)).map(usageView),
        };
      });
    },
  );

  typed.delete(
    '/vehicle-categories/:id',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags,
        summary: 'Удалить тип транспорта (мягко; история сохраняется)',
        params: IdParamsSchema,
        querystring: z.strictObject({ confirm: z.enum(['true', 'false']).optional() }),
        response: { 200: z.object({ deleted: z.literal(true), usages: z.array(UsageSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const row = await findCategory(s, request.params.id);
        assertCategoryScope(ctx, row.siteId);
        const usages = (await findUsages(s.db, schema.vehicleCategories, row.id)).map(usageView);
        if (usages.length > 0 && request.query.confirm !== 'true') {
          throw new AppError('in_use', {
            message: `Тип «${row.name}» используется: ${usages.map((u) => `${u.label} — ${u.count}`).join(', ')}. Его можно выключить, чтобы он пропал из форм; удалить — с подтверждением (confirm=true).`,
            details: { usages },
          });
        }
        await softDelete(s.db, schema.vehicleCategories, row.id);
        await s.audit({
          siteId: row.siteId,
          entity: 'vehicle_category',
          entityId: row.id,
          action: 'delete',
          snapshot: { name: row.name, usages },
        });
        await s.emit('rules.changed', {
          siteId: row.siteId,
          aggregate: 'vehicle_category',
          aggregateId: row.id,
          payload: { entity: 'vehicle_category', entityId: row.id },
        });
        return { deleted: true as const, usages };
      });
    },
  );
}

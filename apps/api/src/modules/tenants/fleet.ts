import {
  BatchResultSchema,
  FleetBatchSchema,
  FleetVehicleCreateSchema,
  FleetVehiclePatchSchema,
  FleetVehicleViewSchema,
  TenantParamsSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { normalizePlate, type PlateCountry } from '@oxrana/plates';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { runBatch } from '../../core/batch';
import { ctxOf } from '../../core/context';
import { registerResource } from '../../core/crud';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { tenantRowScope } from './scope';

/**
 * Автопарк арендатора (`08_` «Автопарк и шаблоны», этап 7a): постоянные машины — номер, тип, марка,
 * водитель. Пропуск из автопарка кабинет оформляет через общую форму и `checkIn`-путь пропусков,
 * поэтому здесь только справочник. Читают все, кто видит пропуска арендатора; правит `fleet.manage`.
 */
export function registerFleetRoutes(app: FastifyInstance): void {
  const fleet = registerResource(app, {
    entity: 'fleet_vehicle',
    title: 'Машина автопарка',
    table: schema.fleetVehicles,
    collection: 'fleet',
    parent: 'tenant',
    parentField: 'tenantId',
    read: ['pass.view', 'pass.view_all_tenants'],
    write: 'fleet.manage',
    createSchema: FleetVehicleCreateSchema,
    patchSchema: FleetVehiclePatchSchema,
    viewSchema: FleetVehicleViewSchema,
    event: 'tenant.changed',
    labels: { categoryId: 'category' },
    toView: (r) => ({
      id: r.id,
      tenantId: r.tenantId,
      plateRaw: String(r.plateRaw),
      plateNorm: String(r.plateNorm),
      plateCountry: String(r.plateCountry),
      categoryId: String(r.categoryId),
      brand: (r.brand as string | null) ?? null,
      driverName: (r.driverName as string | null) ?? null,
      driverPhone: (r.driverPhone as string | null) ?? null,
    }),
    prepare: async (s, input) => {
      const {
        plate,
        plateCountry: hint,
        ...rest
      } = input as Record<string, unknown> & {
        plate?: string;
        plateCountry?: PlateCountry;
      };
      const out: Record<string, unknown> = { ...rest };
      if (plate !== undefined) {
        const normalized = normalizePlate(plate.trim(), hint);
        if (!normalized.norm) {
          throw new AppError('plate_required', {
            field: 'plate',
            message: 'В номере нет букв и цифр. Введите номер, например А123ВС174.',
          });
        }
        out.plateRaw = plate.trim();
        out.plateNorm = normalized.norm;
        out.plateCountry = normalized.country ?? 'unknown';
      }
      await assertRef(s, schema.vehicleCategories, rest.categoryId as string | undefined, {
        field: 'categoryId',
        title: 'Тип транспорта',
      });
      return out;
    },
    onConflict: () =>
      new AppError('conflict', {
        field: 'plate',
        message: 'Машина с таким номером уже есть в автопарке. Откройте её в списке и измените.',
      }),
    scopeOf: tenantRowScope,
    orderBy: (c) => [asc(c('plateNorm'))],
  });

  // Вставка из Excel: строки независимы, повтор номера внутри пакета — ошибка строки.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/tenants/:tenantId/fleet/batch',
    {
      config: { permission: 'fleet.manage' },
      schema: {
        tags: ['fleet_vehicle'],
        summary: 'Автопарк: добавить пакетом (dryRun — предпросмотр)',
        params: TenantParamsSchema,
        body: FleetBatchSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { items, dryRun } = request.body;
      const seen = new Set<string>();
      return ctx.tx((s) =>
        runBatch(s, items, {
          dryRun: dryRun ?? false,
          precheck: (item) => {
            const key = normalizePlate(item.plate).norm;
            if (key && seen.has(key)) {
              return new AppError('conflict', {
                field: 'plate',
                message: `Номер ${key} повторяется в списке. Оставьте одну строку.`,
              });
            }
            if (key) seen.add(key);
            return null;
          },
          create: (scope, item) =>
            fleet.create(scope, request.params.tenantId, item as Record<string, unknown>),
        }),
      );
    },
  );
}

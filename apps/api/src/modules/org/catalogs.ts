import {
  BatchResultSchema,
  DockBatchSchema,
  DockCreateSchema,
  DockPatchSchema,
  DockViewSchema,
  GateCreateSchema,
  GatePatchSchema,
  GateViewSchema,
  HardwareDeviceViewSchema,
  ParkingAreaCreateSchema,
  ParkingAreaPatchSchema,
  ParkingAreaViewSchema,
  SiteParamsSchema,
  VisitPurposeCreateSchema,
  VisitPurposePatchSchema,
  VisitPurposeViewSchema,
  ZoneCreateSchema,
  ZonePatchSchema,
  ZoneViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { runBatch } from '../../core/batch';
import { z } from 'zod';
import { assertSiteAccess, ctxOf, type Scope } from '../../core/context';
import { loadSite } from '../../core/loaders';
import { registerResource, type ScopeInfo } from '../../core/crud';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { createGateAccount } from '../auth/devices';

/** Массовая правка доков: выбранные номера получают общие зону, вид или признак «считается в лимите». */
const DockBulkSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1, 'Выберите хотя бы один док').max(1000),
  changes: z
    .strictObject({
      zoneId: DockPatchSchema.shape.zoneId,
      kind: DockPatchSchema.shape.kind,
      countsInQuota: DockPatchSchema.shape.countsInQuota,
    })
    .refine((c) => Object.values(c).some((v) => v !== undefined), {
      message: 'Укажите, что изменить: зону, вид дока или «считается в лимите».',
    }),
  dryRun: z.boolean().optional(),
});

type Row = Record<string, unknown> & { id: string };

/** Запись объекта: область — её объект. */
export async function siteScope(s: Scope, row: Row): Promise<ScopeInfo> {
  const siteId = String(row.siteId);
  assertSiteAccess(s.ctx, siteId);
  return { siteId, tenantId: null };
}

export function registerCatalogRoutes(app: FastifyInstance): void {
  registerResource(app, {
    entity: 'zone',
    title: 'Зона',
    table: schema.zones,
    collection: 'zones',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'site.manage',
    createSchema: ZoneCreateSchema,
    patchSchema: ZonePatchSchema,
    viewSchema: ZoneViewSchema,
    toView: (r) => ({ id: r.id, siteId: r.siteId, name: r.name, kind: r.kind }),
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('name'))],
  });

  registerResource(app, {
    entity: 'gate',
    title: 'КПП',
    table: schema.gates,
    collection: 'gates',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'site.manage',
    createSchema: GateCreateSchema,
    patchSchema: GatePatchSchema,
    viewSchema: GateViewSchema,
    labels: { zoneId: 'zone' },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      name: r.name,
      kind: r.kind,
      admits: r.admits,
      zoneId: r.zoneId,
      direction: r.direction,
      workingHours: r.workingHours ?? null,
      autoPassOnAllow: r.autoPassOnAllow,
      sort: r.sort,
    }),
    prepare: async (s, input, _existing, scope) => {
      await assertRef(s, schema.zones, input.zoneId as string | null | undefined, {
        siteId: scope.siteId,
        field: 'zoneId',
        title: 'Зона',
      });
      return input;
    },
    // Учётка КПП создаётся вместе с КПП (A11, ADR-018).
    afterWrite: async (s, row, _input, existing) =>
      existing ? {} : createGateAccount(s, { id: row.id, siteId: String(row.siteId) }),
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('sort')), asc(c('name'))],
  });

  const docks = registerResource(app, {
    entity: 'dock',
    title: 'Док',
    table: schema.docks,
    collection: 'docks',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'site.manage',
    createSchema: DockCreateSchema,
    patchSchema: DockPatchSchema,
    viewSchema: DockViewSchema,
    labels: { zoneId: 'zone' },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      zoneId: r.zoneId,
      number: r.number,
      kind: r.kind,
      countsInQuota: r.countsInQuota,
      size: r.size,
    }),
    prepare: async (s, input, _existing, scope) => {
      await assertRef(s, schema.zones, input.zoneId as string | null | undefined, {
        siteId: scope.siteId,
        field: 'zoneId',
        title: 'Зона',
      });
      return input;
    },
    onConflict: () =>
      new AppError('conflict', {
        field: 'number',
        message: 'Док с таким номером на объекте уже есть. Укажите другой номер.',
      }),
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('number'))],
  });

  // Пакетное добавление доков: «1–72» клиент раскрывает в список, сервер проверяет каждый номер.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/sites/:siteId/docks/batch',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags: ['dock'],
        summary: 'Доки: добавить пакетом (dryRun — предпросмотр «добавится N, ошибки в M»)',
        params: SiteParamsSchema,
        body: DockBatchSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { numbers, dryRun, ...common } = request.body;
      const seen = new Set<string>();
      return ctx.tx((s) =>
        runBatch(s, numbers, {
          dryRun: dryRun ?? false,
          precheck: (number) => {
            if (seen.has(number)) {
              return new AppError('conflict', {
                field: 'number',
                message: `Док «${number}» повторяется в списке. Оставьте один.`,
              });
            }
            seen.add(number);
            return null;
          },
          create: (scope, number) =>
            docks.create(scope, request.params.siteId, { ...common, number }),
        }),
      );
    },
  );

  // Массовая правка: выбрать несколько доков и задать зону / вид / «считаются в лимите».
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/sites/:siteId/docks/batch',
    {
      config: { permission: 'site.manage' },
      schema: {
        tags: ['dock'],
        summary: 'Доки: изменить несколько сразу (dryRun — предпросмотр)',
        params: SiteParamsSchema,
        body: DockBulkSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { ids, changes, dryRun } = request.body;
      const seen = new Set<string>();
      return ctx.tx(async (s) => {
        await loadSite(s, request.params.siteId);
        const result = await runBatch(s, ids, {
          dryRun: dryRun ?? false,
          precheck: (id) => {
            if (seen.has(id)) {
              return new AppError('conflict', {
                field: 'ids',
                message: 'Док выбран дважды. Оставьте один.',
              });
            }
            seen.add(id);
            return null;
          },
          create: (scope, id) => docks.update(scope, id, changes),
        });
        return {
          ...result,
          summary: `${dryRun ? 'Будет изменено' : 'Изменено'} ${result.created} из ${result.total}`,
        };
      });
    },
  );

  registerResource(app, {
    entity: 'visit_purpose',
    title: 'Цель визита',
    table: schema.visitPurposes,
    collection: 'visit-purposes',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'site.manage',
    createSchema: VisitPurposeCreateSchema,
    patchSchema: VisitPurposePatchSchema,
    viewSchema: VisitPurposeViewSchema,
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      name: r.name,
      maxStayMinutes: r.maxStayMinutes,
      sort: r.sort,
    }),
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('sort')), asc(c('name'))],
  });

  registerResource(app, {
    entity: 'parking_area',
    title: 'Парковочный участок',
    table: schema.parkingAreas,
    collection: 'parking-areas',
    parent: 'site',
    parentField: 'siteId',
    read: 'authenticated',
    write: 'site.manage',
    createSchema: ParkingAreaCreateSchema,
    patchSchema: ParkingAreaPatchSchema,
    viewSchema: ParkingAreaViewSchema,
    labels: { zoneId: 'zone' },
    toView: (r) => ({
      id: r.id,
      siteId: r.siteId,
      zoneId: r.zoneId,
      name: r.name,
      spaces: r.spaces,
    }),
    prepare: async (s, input, _existing, scope) => {
      await assertRef(s, schema.zones, input.zoneId as string | null | undefined, {
        siteId: scope.siteId,
        field: 'zoneId',
        title: 'Зона',
      });
      return input;
    },
    scopeOf: siteScope,
    orderBy: (c) => [asc(c('name'))],
  });

  // Реестр оборудования (ADR-008): в MVP пустой; устройства подключаются через агент КПП (этап 14).
  app.withTypeProvider<ZodTypeProvider>().get(
    '/sites/:siteId/hardware-devices',
    {
      config: { permission: 'hardware.manage' },
      schema: {
        tags: ['hardware'],
        summary: 'Реестр оборудования КПП (камеры, шлагбаумы, сканеры)',
        params: SiteParamsSchema,
        response: { 200: z.object({ items: z.array(HardwareDeviceViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select({ device: schema.hardwareDevices, gateName: schema.gates.name })
          .from(schema.hardwareDevices)
          .innerJoin(schema.gates, eq(schema.gates.id, schema.hardwareDevices.gateId))
          .where(
            and(
              eq(schema.hardwareDevices.organizationId, s.organizationId),
              eq(schema.hardwareDevices.siteId, site.id),
              isNull(schema.hardwareDevices.deletedAt),
            ),
          )
          .orderBy(asc(schema.gates.name), asc(schema.hardwareDevices.name));
        return {
          items: rows.map(({ device, gateName }) => ({
            id: device.id,
            gateId: device.gateId,
            gateName,
            kind: device.kind,
            name: device.name,
            adapter: device.adapter,
            status: device.status,
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          })),
        };
      });
    },
  );
}

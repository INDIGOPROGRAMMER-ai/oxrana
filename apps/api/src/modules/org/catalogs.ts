import {
  DockCreateSchema,
  DockPatchSchema,
  DockViewSchema,
  GateCreateSchema,
  GatePatchSchema,
  GateViewSchema,
  ZoneCreateSchema,
  ZonePatchSchema,
  ZoneViewSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { assertSiteAccess, type Scope } from '../../core/context';
import { registerResource, type ScopeInfo } from '../../core/crud';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { createGateAccount } from '../auth/devices';

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

  registerResource(app, {
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
}

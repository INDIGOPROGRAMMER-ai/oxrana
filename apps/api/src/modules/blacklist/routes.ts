import {
  type BlacklistLevel,
  BlacklistBatchSchema,
  BlacklistCreateSchema,
  BlacklistPatchSchema,
  type BlacklistView,
  BatchResultSchema,
  BlacklistViewSchema,
  IdParamsSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { schema, softDelete } from '@oxrana/db';
import { normalizePlate } from '@oxrana/plates';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { runBatch } from '../../core/batch';
import { assertSiteAccess, ctxOf, type Scope } from '../../core/context';
import { changedFields, diffOf } from '../../core/diff';
import { loadSite, notFound } from '../../core/loaders';
import { AppError } from '../../errors';

type Row = typeof schema.blacklist.$inferSelect;

/** Записи уровня «организация» правит только роль на всю организацию: они действуют на всех объектах. */
function requireOrganizationScope(s: Scope): void {
  if (s.ctx.actor.siteIds !== null) {
    throw new AppError('forbidden', {
      message:
        'Запись для всей организации может добавить и изменить только роль на всю организацию. Добавьте запись для этого объекта или обратитесь к владельцу.',
      settingLink: '/admin/users',
    });
  }
}

function levelOf(row: Pick<Row, 'siteId'>): BlacklistLevel {
  return row.siteId === null ? 'organization' : 'site';
}

async function namesOf(s: Scope, rows: readonly Row[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))];
  if (ids.length === 0) return new Map();
  const users = await s.db
    .select({ id: schema.users.id, fullName: schema.users.fullName })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(users.map((u) => [u.id, u.fullName]));
}

function view(row: Row, names: Map<string, string>, now: number): BlacklistView {
  return {
    id: row.id,
    level: levelOf(row),
    siteId: row.siteId,
    plateNorm: row.plateNorm,
    personName: row.personName,
    reason: row.reason,
    validTo: row.validTo?.toISOString() ?? null,
    active: row.validTo === null || row.validTo.getTime() > now,
    createdById: row.createdBy,
    createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function viewOf(s: Scope, row: Row): Promise<BlacklistView> {
  return view(row, await namesOf(s, [row]), s.ctx.now());
}

/** Номер как ввели → нормализованный; пустой — ошибка у поля. */
function plateOf(raw: string, field = 'plate'): string {
  const { norm } = normalizePlate(raw);
  if (!norm) {
    throw new AppError('plate_required', {
      field,
      message: 'В номере нет букв и цифр. Введите номер, например А123ВС174.',
    });
  }
  return norm;
}

function validToOf(value: string | null | undefined, now: number): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const at = new Date(value);
  if (at.getTime() <= now) {
    throw new AppError('invalid_period', {
      field: 'validTo',
      message: 'Срок уже прошёл: запись ни на что не повлияет. Укажите будущую дату или оставьте «бессрочно».',
    });
  }
  return at;
}

async function assertNotListed(
  s: Scope,
  siteId: string | null,
  plateNorm: string | null,
  personName: string | null,
  selfId: string | null,
): Promise<void> {
  const same = and(
    eq(schema.blacklist.organizationId, s.organizationId),
    isNull(schema.blacklist.deletedAt),
    siteId === null ? isNull(schema.blacklist.siteId) : eq(schema.blacklist.siteId, siteId),
  );
  const rows = await s.db.select().from(schema.blacklist).where(same);
  const now = s.ctx.now();
  const dup = rows.find(
    (r) =>
      r.id !== selfId &&
      (r.validTo === null || r.validTo.getTime() > now) &&
      ((plateNorm !== null && r.plateNorm === plateNorm) ||
        (personName !== null &&
          r.personName !== null &&
          r.personName.trim().toLowerCase() === personName.trim().toLowerCase())),
  );
  if (dup) {
    throw new AppError('conflict', {
      field: plateNorm !== null && dup.plateNorm === plateNorm ? 'plate' : 'personName',
      message: `${plateNorm !== null && dup.plateNorm === plateNorm ? `Номер ${plateNorm}` : `«${dup.personName}»`} уже в чёрном списке (${dup.reason}). Измените ту запись или удалите её.`,
    });
  }
}

async function emitChange(s: Scope, row: Row): Promise<void> {
  await s.emit('rules.changed', {
    siteId: row.siteId,
    aggregate: 'blacklist',
    aggregateId: row.id,
    payload: { entity: 'blacklist', entityId: row.id },
  });
}

async function createEntry(
  s: Scope,
  siteId: string,
  input: {
    level: BlacklistLevel;
    plate?: string | undefined;
    personName?: string | undefined;
    reason: string;
    validTo?: string | null | undefined;
  },
): Promise<Row> {
  await loadSite(s, siteId);
  if (input.level === 'organization') requireOrganizationScope(s);
  const entrySite = input.level === 'organization' ? null : siteId;
  const plateNorm = input.plate === undefined ? null : plateOf(input.plate);
  const personName = input.personName ?? null;
  const validTo = validToOf(input.validTo, s.ctx.now()) ?? null;
  await assertNotListed(s, entrySite, plateNorm, personName, null);
  const [row] = await s.db
    .insert(schema.blacklist)
    .values({
      organizationId: s.organizationId,
      siteId: entrySite,
      plateNorm,
      personName,
      reason: input.reason,
      validTo,
      createdBy: s.ctx.actor.kind === 'user' ? s.ctx.actor.id : null,
    })
    .returning();
  if (!row) throw new Error('blacklist insert');
  await s.audit({
    siteId: entrySite,
    entity: 'blacklist',
    entityId: row.id,
    action: 'create',
    diff: diffOf(null, row, ['plateNorm', 'personName', 'reason', 'validTo', 'siteId']),
    reason: input.reason,
    snapshot: { level: input.level },
  });
  await emitChange(s, row);
  return row;
}

async function loadEntry(s: Scope, id: string): Promise<Row> {
  const [row] = await s.db
    .select()
    .from(schema.blacklist)
    .where(
      and(
        eq(schema.blacklist.organizationId, s.organizationId),
        eq(schema.blacklist.id, id),
        isNull(schema.blacklist.deletedAt),
      ),
    );
  if (!row) throw notFound('Запись чёрного списка');
  if (row.siteId === null) requireOrganizationScope(s);
  else assertSiteAccess(s.ctx, row.siteId);
  return row;
}

const ListQuery = z.strictObject({ expired: z.enum(['true', 'false']).optional() });

/** Чёрный список (ADR-017, этап 6b). Проверка — в движке; здесь справочник с аудитом и событиями. */
export function registerBlacklistModule(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['blacklist'];

  typed.get(
    '/sites/:siteId/blacklist',
    {
      config: { permission: 'blacklist.manage' },
      schema: {
        tags,
        summary: 'Чёрный список объекта: записи объекта и всей организации',
        params: SiteParamsSchema,
        querystring: ListQuery,
        response: { 200: z.object({ items: z.array(BlacklistViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const rows = await s.db
          .select()
          .from(schema.blacklist)
          .where(
            and(
              eq(schema.blacklist.organizationId, s.organizationId),
              isNull(schema.blacklist.deletedAt),
              or(isNull(schema.blacklist.siteId), eq(schema.blacklist.siteId, site.id)),
            ),
          )
          .orderBy(asc(schema.blacklist.createdAt), asc(schema.blacklist.id));
        const names = await namesOf(s, rows);
        const now = ctx.now();
        const items = rows.map((r) => view(r, names, now));
        return {
          items: request.query.expired === 'false' ? items.filter((i) => i.active) : items,
        };
      });
    },
  );

  typed.post(
    '/sites/:siteId/blacklist',
    {
      config: { permission: 'blacklist.manage' },
      schema: {
        tags,
        summary: 'Добавить в чёрный список (номер и/или человек, причина обязательна)',
        params: SiteParamsSchema,
        body: BlacklistCreateSchema,
        response: { 201: BlacklistViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const created = await ctx.tx(async (s) =>
        viewOf(s, await createEntry(s, request.params.siteId, request.body)),
      );
      return reply.status(201).send(created);
    },
  );

  typed.post(
    '/sites/:siteId/blacklist/batch',
    {
      config: { permission: 'blacklist.manage' },
      schema: {
        tags,
        summary: 'Чёрный список: добавить номера пакетом (dryRun — предпросмотр)',
        params: SiteParamsSchema,
        body: BlacklistBatchSchema,
        response: { 200: BatchResultSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { plates, dryRun, ...common } = request.body;
      const seen = new Set<string>();
      return ctx.tx((s) =>
        runBatch(s, plates, {
          dryRun: dryRun ?? false,
          precheck: (plate) => {
            const norm = normalizePlate(plate).norm;
            if (norm && seen.has(norm)) {
              return new AppError('conflict', {
                field: 'plate',
                message: `Номер ${norm} повторяется в списке. Оставьте один.`,
              });
            }
            if (norm) seen.add(norm);
            return null;
          },
          create: (scope, plate) => createEntry(scope, request.params.siteId, { ...common, plate }),
        }),
      );
    },
  );

  typed.patch(
    '/blacklist/:id',
    {
      config: { permission: 'blacklist.manage' },
      schema: {
        tags,
        summary: 'Изменить запись чёрного списка (только переданные поля)',
        params: IdParamsSchema,
        body: BlacklistPatchSchema,
        response: { 200: BlacklistViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { plate, personName, reason, validTo } = request.body;
      return ctx.tx(async (s) => {
        const existing = await loadEntry(s, request.params.id);
        const patch: Partial<Row> = {};
        if (plate !== undefined) patch.plateNorm = plate === null ? null : plateOf(plate);
        if (personName !== undefined) patch.personName = personName;
        if (reason !== undefined) patch.reason = reason;
        if (validTo !== undefined) patch.validTo = validToOf(validTo, ctx.now()) ?? null;
        const next = { ...existing, ...patch };
        if (next.plateNorm === null && next.personName === null) {
          throw new AppError('validation_failed', {
            field: 'plate',
            message: 'Нельзя убрать и номер, и человека: запись ни к кому не относится. Удалите запись.',
          });
        }
        const fields = changedFields(existing, patch);
        if (fields.length === 0) return viewOf(s, existing);
        if (fields.includes('plateNorm') || fields.includes('personName')) {
          await assertNotListed(s, existing.siteId, next.plateNorm, next.personName, existing.id);
        }
        const [row = existing] = await s.db
          .update(schema.blacklist)
          .set(Object.fromEntries(fields.map((f) => [f, patch[f]])))
          .where(
            and(
              eq(schema.blacklist.organizationId, s.organizationId),
              eq(schema.blacklist.id, existing.id),
            ),
          )
          .returning();
        await s.audit({
          siteId: existing.siteId,
          entity: 'blacklist',
          entityId: existing.id,
          action: 'update',
          diff: diffOf(existing, row, fields),
          snapshot: { level: levelOf(existing) },
        });
        await emitChange(s, row);
        return viewOf(s, row);
      });
    },
  );

  typed.delete(
    '/blacklist/:id',
    {
      config: { permission: 'blacklist.manage' },
      schema: {
        tags,
        summary: 'Убрать из чёрного списка (мягкое удаление, остаётся в журнале)',
        params: IdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const existing = await loadEntry(s, request.params.id);
        await softDelete(s.db, schema.blacklist, existing.id);
        await s.audit({
          siteId: existing.siteId,
          entity: 'blacklist',
          entityId: existing.id,
          action: 'delete',
          snapshot: {
            level: levelOf(existing),
            plate: existing.plateNorm,
            person: existing.personName,
            reason: existing.reason,
          },
        });
        await emitChange(s, existing);
        return { deleted: true as const };
      });
    },
  );
}

import { randomUUID } from 'node:crypto';
import {
  type InsideRow,
  PASS_STATUS_LABELS,
  type PassListQuerySchema,
  type PassView,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { addLocalDays, formatDateTime, localInstant } from '@oxrana/engine';
import { normalizePlateText, plateDigits } from '@oxrana/plates';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import { isTenantUser } from '../../actor';
import { assertTenantAccess, type Ctx, can, type Scope } from '../../core/context';
import type { SiteRow } from '../../core/loaders';
import { notFound } from '../../core/loaders';
import { AppError } from '../../errors';
import { type ExportFormat, renderTable, type TableFile } from '../../export/table-file';
import { siteTimeLabel } from '../org/sites';
import { openVisitPassIds } from './service';
import { PASS_TYPE_LABEL } from './validate';
import { passView } from './views';

/**
 * Списки без потолка и выгрузка (этап 7b.1): фильтры и поиск — на сервере по всем строкам, список
 * порциями с общим итогом, выгрузка — все строки по тому же фильтру. Один и тот же набор условий
 * служит списку, итогу и файлу, поэтому «Найдено N» и число строк в файле совпадают.
 */

/** Предел строк одной выгрузки: больше — сузить фильтр (файл собирается в памяти). */
export const EXPORT_ROW_LIMIT = 50_000;

/** Арендаторы, чьи строки видит актор на объекте; `null` — все. */
export function visibleTenants(ctx: Ctx, requested: string | undefined): string[] | null {
  const all = can(ctx, 'pass.view_all_tenants') && !isTenantUser(ctx.actor);
  if (requested) {
    if (!all) assertTenantAccess(ctx, requested);
    return [requested];
  }
  return all ? null : [...(ctx.actor.tenantIds ?? [])];
}

/** Поиск «цифры номера или часть фамилии» → условия для колонок номера и имени. */
function textSearch(
  q: string,
  plateColumn: typeof schema.passes.plateNorm | typeof schema.visits.plateNorm,
  nameColumn: typeof schema.passes.personName,
): SQL | undefined {
  const digits = plateDigits(q);
  const plate = /^\d+$/.test(q.replace(/\s/g, '')) ? digits : normalizePlateText(q);
  return or(plate ? ilike(plateColumn, `%${plate}%`) : undefined, ilike(nameColumn, `%${q}%`));
}

export type PassListQuery = Pick<
  z.infer<typeof PassListQuerySchema>,
  'tenantId' | 'status' | 'participant' | 'passType' | 'dateFrom' | 'dateTo' | 'q'
>;

/** Условия списка пропусков. `tenants === null` — без ограничения по арендаторам. */
export function passConditions(
  s: Scope,
  site: SiteRow,
  tenants: string[] | null,
  q: PassListQuery,
): SQL[] {
  const conditions: (SQL | undefined)[] = [
    eq(schema.passes.organizationId, s.organizationId),
    eq(schema.passes.siteId, site.id),
    tenants === null ? undefined : inArray(schema.passes.tenantId, tenants),
    q.status ? eq(schema.passes.status, q.status) : undefined,
    q.participant ? eq(schema.passes.participant, q.participant) : undefined,
    q.passType ? eq(schema.passes.passType, q.passType) : undefined,
    // Даты — местные сутки объекта: пропуск действует хотя бы часть этого промежутка.
    q.dateTo
      ? lt(
          schema.passes.validFrom,
          new Date(localInstant(addLocalDays(q.dateTo, 1), 0, site.timezone)),
        )
      : undefined,
    q.dateFrom
      ? or(
          isNull(schema.passes.validTo),
          gt(schema.passes.validTo, new Date(localInstant(q.dateFrom, 0, site.timezone))),
        )
      : undefined,
    q.q ? textSearch(q.q, schema.passes.plateNorm, schema.passes.personName) : undefined,
  ];
  return conditions.filter((c): c is SQL => c !== undefined);
}

const PASS_ORDER = [desc(schema.passes.createdAt), asc(schema.passes.id)] as const;

/** Страница пропусков и общий итог по фильтру. */
export async function passPage(
  s: Scope,
  conditions: SQL[],
  page: { limit: number; offset: number },
  now: number,
): Promise<{ items: PassView[]; total: number }> {
  const where = and(...conditions);
  const [rows, [totalRow]] = await Promise.all([
    s.db
      .select()
      .from(schema.passes)
      .where(where)
      .orderBy(...PASS_ORDER)
      .limit(page.limit)
      .offset(page.offset),
    s.db.select({ total: count() }).from(schema.passes).where(where),
  ]);
  const open = await openVisitPassIds(
    s,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((r) => passView(r, now, open.has(r.id))),
    total: totalRow?.total ?? 0,
  };
}

// ---------- сейчас на территории ----------

export interface InsideFilter {
  readonly tenantId?: string | undefined;
  readonly quotaId?: string | undefined;
  readonly q?: string | undefined;
}

/** Условия открытых визитов; лимит — те же визиты, что считает `countOccupancy` (число = виджет). */
async function insideConditions(
  s: Scope,
  ctx: Ctx,
  site: SiteRow,
  filter: InsideFilter,
): Promise<SQL[] | null> {
  const tenants = visibleTenants(ctx, filter.tenantId);
  if (tenants !== null && tenants.length === 0) return null;
  const conditions: (SQL | undefined)[] = [
    eq(schema.visits.organizationId, s.organizationId),
    eq(schema.visits.siteId, site.id),
    isNull(schema.visits.timeOut),
    tenants === null ? undefined : inArray(schema.visits.tenantId, tenants),
    filter.q ? textSearch(filter.q, schema.visits.plateNorm, schema.passes.personName) : undefined,
  ];
  if (filter.quotaId) {
    const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
    const quota = rules.quotas.find((q) => q.id === filter.quotaId);
    if (!quota || (tenants !== null && !tenants.includes(quota.tenantId))) {
      throw notFound('Лимит');
    }
    conditions.push(
      eq(schema.visits.tenantId, quota.tenantId),
      // визит по исключению «вне лимита» места не занимает (как в движке)
      isNull(schema.visits.exceptionId),
      quota.participant === 'pedestrian'
        ? eq(schema.visits.participant, 'pedestrian')
        : quota.categoryIds.length > 0
          ? inArray(schema.visits.categoryId, [...quota.categoryIds])
          : sql`false`,
    );
  }
  return conditions.filter((c): c is SQL => c !== undefined);
}

async function insideRows(
  s: Scope,
  site: SiteRow,
  conditions: SQL[],
  page: { limit: number; offset: number } | null,
): Promise<InsideRow[]> {
  const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  const query = s.db
    .select({
      visit: schema.visits,
      plateRaw: schema.passes.plateRaw,
      personName: schema.passes.personName,
      passType: schema.passes.passType,
      zoneId: schema.passes.destinationZoneId,
      gateName: schema.gates.name,
      tenantName: schema.tenants.shortName,
    })
    .from(schema.visits)
    .leftJoin(schema.passes, eq(schema.passes.id, schema.visits.passId))
    .leftJoin(schema.gates, eq(schema.gates.id, schema.visits.gateInId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.visits.tenantId))
    .where(and(...conditions))
    // давно въехавшие — первыми: их чаще всего нужно найти
    .orderBy(asc(schema.visits.timeIn), asc(schema.visits.id));
  const rows = await (page ? query.limit(page.limit).offset(page.offset) : query);
  return rows.map((r) => {
    const snapshot = r.visit.snapshot as Record<string, unknown>;
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value !== '' ? value : null;
    return {
      visitId: r.visit.id,
      passId: r.visit.passId,
      tenantId: r.visit.tenantId,
      tenantName: r.tenantName,
      participant: r.visit.participant,
      title:
        r.visit.participant === 'pedestrian'
          ? (r.personName ?? 'Пешеход')
          : (r.plateRaw ?? r.visit.plateNorm ?? text(snapshot.plate) ?? 'Без номера'),
      categoryName:
        text(snapshot.category) ??
        (r.visit.categoryId
          ? (rules.categories.find((c) => c.id === r.visit.categoryId)?.name ?? null)
          : null),
      passType: r.passType,
      timeIn: r.visit.timeIn ? r.visit.timeIn.toISOString() : null,
      // названия на момент въезда (CLAUDE.md п. 6)
      gateInName: text(snapshot.gate) ?? r.gateName,
      dock: text(snapshot.dock),
      zone: r.zoneId ? (rules.zones.find((z) => z.id === r.zoneId)?.name ?? null) : null,
    };
  });
}

export async function insidePage(
  s: Scope,
  ctx: Ctx,
  site: SiteRow,
  filter: InsideFilter,
  page: { limit: number; offset: number },
): Promise<{ items: InsideRow[]; total: number }> {
  const conditions = await insideConditions(s, ctx, site, filter);
  if (conditions === null) return { items: [], total: 0 };
  const [items, [totalRow]] = await Promise.all([
    insideRows(s, site, conditions, page),
    s.db
      .select({ total: count() })
      .from(schema.visits)
      .leftJoin(schema.passes, eq(schema.passes.id, schema.visits.passId))
      .where(and(...conditions)),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

// ---------- выгрузка ----------

/** «2 ч 15 мин» / «40 мин» / «3 сут 4 ч»: сколько машина на территории. */
export function stayText(fromMs: number, toMs: number): string {
  const minutes = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} сут ${hours} ч`;
  if (hours > 0) return `${hours} ч ${mins} мин`;
  return `${mins} мин`;
}

function tooMany(total: number): AppError {
  return new AppError('export_too_large', {
    message: `В выгрузке ${total} строк — это больше предела ${EXPORT_ROW_LIMIT}. Сузьте фильтр (статус, день, арендатор) и выгрузите по частям.`,
  });
}

/** Автор пропуска: сотрудник или пост («Пост» и название КПП). */
async function authorLabels(
  s: Scope,
  rows: { createdBy: string | null; gateAccountId: string | null }[],
) {
  const userIds = [...new Set(rows.map((r) => r.createdBy).filter((v): v is string => v !== null))];
  const accountIds = [
    ...new Set(rows.map((r) => r.gateAccountId).filter((v): v is string => v !== null)),
  ];
  const users = new Map<string, string>();
  const accounts = new Map<string, string>();
  if (userIds.length > 0) {
    for (const u of await s.db
      .select({ id: schema.users.id, name: schema.users.fullName })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds))) {
      users.set(u.id, u.name);
    }
  }
  if (accountIds.length > 0) {
    for (const a of await s.db
      .select({ id: schema.gateAccounts.id, name: schema.gates.name })
      .from(schema.gateAccounts)
      .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
      .where(
        and(
          eq(schema.gateAccounts.organizationId, s.organizationId),
          inArray(schema.gateAccounts.id, accountIds),
        ),
      )) {
      accounts.set(a.id, `Пост ${a.name}`);
    }
  }
  return (row: { createdBy: string | null; gateAccountId: string | null }): string =>
    (row.createdBy ? users.get(row.createdBy) : undefined) ??
    (row.gateAccountId ? accounts.get(row.gateAccountId) : undefined) ??
    '—';
}

/** Выгрузка пропусков: все строки по фильтру. Факт выгрузки — в аудит (число строк, формат). */
export async function exportPasses(
  s: Scope,
  site: SiteRow,
  conditions: SQL[],
  format: ExportFormat,
  filterNote: Record<string, unknown>,
): Promise<TableFile & { rows: number }> {
  const where = and(...conditions);
  const [totalRow] = await s.db.select({ total: count() }).from(schema.passes).where(where);
  const total = totalRow?.total ?? 0;
  if (total > EXPORT_ROW_LIMIT) throw tooMany(total);
  const rows = await s.db
    .select()
    .from(schema.passes)
    .where(where)
    .orderBy(...PASS_ORDER);
  const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  const open = await openVisitPassIds(
    s,
    rows.map((r) => r.id),
  );
  const author = await authorLabels(
    s,
    rows.map((r) => ({ createdBy: r.createdBy, gateAccountId: r.createdByGateAccountId })),
  );
  const tenantNames = new Map(rules.tenants.map((t) => [t.id, t.name]));
  const tz = site.timezone;
  const zoneLabel = siteTimeLabel(site, s.ctx.now());
  const at = (d: Date | null) => (d ? formatDateTime(d.getTime(), tz) : '');
  const header = [
    'Номер',
    'Тип транспорта',
    'Вид пропуска',
    'Статус',
    `Действует с (${zoneLabel})`,
    `Действует по (${zoneLabel})`,
    'Место назначения',
    'Автор',
    `Создан (${zoneLabel})`,
    'На территории сейчас',
    'Арендатор',
  ];
  const table = rows.map((r) => [
    r.participant === 'pedestrian' ? (r.personName ?? '') : (r.plateRaw ?? r.plateNorm ?? ''),
    r.categoryId ? (rules.categories.find((c) => c.id === r.categoryId)?.name ?? '') : '',
    PASS_TYPE_LABEL[r.passType],
    PASS_STATUS_LABELS[r.status],
    at(r.validFrom),
    r.validTo ? at(r.validTo) : r.passType === 'permanent' ? 'без окончания' : '',
    [
      r.destinationZoneId ? rules.zones.find((z) => z.id === r.destinationZoneId)?.name : null,
      r.dockId ? `док ${rules.docks.find((d) => d.id === r.dockId)?.number ?? ''}`.trim() : null,
    ]
      .filter(Boolean)
      .join(', '),
    author({ createdBy: r.createdBy, gateAccountId: r.createdByGateAccountId }),
    at(r.createdAt),
    open.has(r.id) ? 'да' : 'нет',
    tenantNames.get(r.tenantId) ?? '',
  ]);
  await auditExport(s, site, 'passes', format, table.length, filterNote);
  return { ...renderTable(format, 'Пропуска', header, table), rows: table.length };
}

/** Выгрузка «Сейчас на территории»: все открытые визиты по фильтру. */
export async function exportInside(
  s: Scope,
  ctx: Ctx,
  site: SiteRow,
  filter: InsideFilter,
  format: ExportFormat,
  filterNote: Record<string, unknown>,
): Promise<TableFile & { rows: number }> {
  const conditions = await insideConditions(s, ctx, site, filter);
  const total =
    conditions === null
      ? 0
      : ((
          await s.db
            .select({ total: count() })
            .from(schema.visits)
            .leftJoin(schema.passes, eq(schema.passes.id, schema.visits.passId))
            .where(and(...conditions))
        )[0]?.total ?? 0);
  if (total > EXPORT_ROW_LIMIT) throw tooMany(total);
  const rows = conditions === null ? [] : await insideRows(s, site, conditions, null);
  const now = s.ctx.now();
  const tz = site.timezone;
  const zoneLabel = siteTimeLabel(site, now);
  const header = [
    'Номер или ФИО',
    'Тип транспорта',
    'Вид пропуска',
    `Въехал (${zoneLabel})`,
    'На территории',
    'КПП въезда',
    'Док',
    'Место назначения',
    'Арендатор',
  ];
  const table = rows.map((r) => [
    r.title,
    r.categoryName ?? '',
    r.passType ? PASS_TYPE_LABEL[r.passType] : '',
    r.timeIn ? formatDateTime(Date.parse(r.timeIn), tz) : '',
    r.timeIn ? stayText(Date.parse(r.timeIn), now) : '',
    r.gateInName ?? '',
    r.dock ?? '',
    r.zone ?? '',
    r.tenantName,
  ]);
  await auditExport(s, site, 'inside', format, table.length, filterNote);
  return { ...renderTable(format, 'На территории', header, table), rows: table.length };
}

async function auditExport(
  s: Scope,
  site: SiteRow,
  kind: 'passes' | 'inside',
  format: ExportFormat,
  rows: number,
  filter: Record<string, unknown>,
): Promise<void> {
  await s.audit({
    siteId: site.id,
    entity: 'export',
    entityId: randomUUID(),
    action: 'export',
    // фильтр — без текста поиска: там могут быть цифры номера или фамилия (ПДн)
    snapshot: { kind, format, rows, filter },
  });
}

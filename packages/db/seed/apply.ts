import {
  ExceptionMatchSchema,
  ROLE_TEMPLATES,
  roleTemplate,
  SiteSettingsSchema,
  vehicleCategoryPreset,
  WorkingHoursSchema,
} from '@oxrana/contracts';
import { eq, getTableName } from 'drizzle-orm';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import { type Db, type DbTx, schema } from '../src';
import { seedId } from './ids';
import type { SeedData } from './types';

/** Сколько строк сид описывает и сколько из них вставил этот запуск — по таблицам. */
export type SeedReport = Record<string, { described: number; inserted: number }>;

/**
 * Применяет сид в одной транзакции под владельцем (RLS не мешает, ADR-003 п. 7). Идемпотентно:
 * id строк — UUIDv5 от естественных ключей, вставка — `on conflict do nothing`. Повторный запуск
 * ничего не дублирует и не меняет строки, которые уже есть (в том числе отредактированные
 * администратором), а недостающие — дописывает (ADR-014).
 */
export async function applySeed(db: Db, data: SeedData): Promise<SeedReport> {
  validate(data);
  return db.transaction(async (tx) => {
    const report: SeedReport = {};
    const put = async <T extends PgTable>(table: T, rows: PgInsertValue<T>[]): Promise<void> => {
      const name = getTableName(table);
      const entry = report[name] ?? { described: 0, inserted: 0 };
      report[name] = entry;
      entry.described += rows.length;
      if (rows.length === 0) return;
      // Без цели конфликта: пропускается и совпадение id, и любая другая уникальность или
      // exclusion — существующие данные сид не трогает.
      const inserted = await tx.insert(table).values(rows).onConflictDoNothing().returning();
      entry.inserted += inserted.length;
    };

    const org = data.organization.key;
    const id = (...parts: string[]) => seedId(org, ...parts);
    const organizationId = id('organization');
    await assertOrganizationIsOurs(tx, data, organizationId);

    const siteId = id('site', data.site.key);
    const zoneId = (key: string) => id('zone', key);
    const gateId = (key: string) => id('gate', key);
    const categoryId = (code: string) => id('category', code);
    const dockId = (number: string) => id('dock', number);
    const tenantId = (key: string) => id('tenant', key);
    const optional = <T>(value: T | undefined, f: (v: T) => string) =>
      value === undefined ? null : f(value);
    const validFromDate = data.validFrom.date;
    const validFromInstant = new Date(data.validFrom.instant);

    await put(schema.organizations, [
      {
        id: organizationId,
        name: data.organization.name,
        slug: data.organization.slug,
        defaultTimezone: data.organization.defaultTimezone,
      },
    ]);
    const base = { organizationId };
    const onSite = { organizationId, siteId };

    await put(schema.sites, [
      {
        id: siteId,
        ...base,
        name: data.site.name,
        address: data.site.address,
        timezone: data.site.timezone,
        workingHours: data.site.workingHours,
        settings: data.site.settings,
      },
    ]);
    await put(
      schema.zones,
      data.zones.map((z) => ({ id: zoneId(z.key), ...onSite, name: z.name, kind: z.kind })),
    );
    await put(
      schema.gates,
      data.gates.map((g) => ({
        id: gateId(g.key),
        ...onSite,
        name: g.name,
        kind: g.kind,
        admits: g.admits,
        zoneId: optional(g.zoneKey, zoneId),
        sort: g.sort,
      })),
    );
    // Типы — на уровне организации (site_id = null), порядок сида = порядок в списках.
    await put(
      schema.vehicleCategories,
      data.categories.map((code, index) => {
        const preset = vehicleCategoryPreset(code);
        return {
          id: categoryId(code),
          ...base,
          presetCode: code,
          name: preset.name,
          dockEligible: preset.dockEligible,
          sort: (index + 1) * 10,
        };
      }),
    );
    await put(
      schema.docks,
      data.docks.map((d) => ({
        id: dockId(d.number),
        ...onSite,
        zoneId: optional(d.zoneKey, zoneId),
        number: d.number,
        kind: d.kind,
        countsInQuota: d.countsInQuota,
      })),
    );

    await put(
      schema.tenants,
      data.tenants.map((t) => ({
        id: tenantId(t.key),
        ...onSite,
        legalName: t.legalName,
        shortName: t.shortName,
        isOperator: t.isOperator ?? false,
        trucksDockRequired: t.trucksDockRequired ?? false,
        defaultCategoryId: optional(t.defaultCategory, categoryId),
        responsiblePhone: t.responsiblePhone ?? null,
        emergencyPhone: t.emergencyPhone ?? null,
      })),
    );

    const withContract = data.tenants.filter((t) => t.contractNotes !== undefined);
    await put(
      schema.contracts,
      withContract.map((t) => ({
        id: id('contract', t.key),
        ...base,
        tenantId: tenantId(t.key),
        status: 'active' as const,
        notes: t.contractNotes ?? null,
      })),
    );
    await put(
      schema.contractClauses,
      withContract.flatMap((t) =>
        t.quotas.map((q) => ({
          id: id('clause', t.key, q.key),
          ...base,
          contractId: id('contract', t.key),
          ref: q.clause.ref,
          summary: q.clause.summary,
        })),
      ),
    );
    await put(
      schema.tenantDockAssignments,
      data.tenants.flatMap((t) =>
        t.docks.map((number) => ({
          id: id('dock-assignment', t.key, number),
          ...base,
          tenantId: tenantId(t.key),
          dockId: dockId(number),
          validFrom: validFromDate,
        })),
      ),
    );

    await put(
      schema.quotas,
      data.tenants.flatMap((t) =>
        t.quotas.map((q) => ({
          id: id('quota', t.key, q.key),
          ...onSite,
          tenantId: tenantId(t.key),
          participant: 'vehicle' as const,
          name: q.name,
          capacity: q.capacity,
          capacityFromDocks: q.capacityFromDocks ?? false,
          enforcement: q.enforcement ?? 'hard',
          overageTariffRub: q.overageTariffRub ?? null,
          basisClauseId: t.contractNotes === undefined ? null : id('clause', t.key, q.key),
          validFrom: validFromInstant,
        })),
      ),
    );
    await put(
      schema.quotaCategories,
      data.tenants.flatMap((t) =>
        t.quotas.flatMap((q) =>
          q.categories.map((code) => ({
            quotaId: id('quota', t.key, q.key),
            categoryId: categoryId(code),
          })),
        ),
      ),
    );

    await put(
      schema.routingRules,
      data.routing.map((r) => ({
        id: id(
          'routing',
          r.tenantKey ?? '*',
          r.participant,
          r.category ?? '*',
          r.destinationZoneKey ?? '*',
          r.gateKey,
        ),
        ...onSite,
        tenantId: optional(r.tenantKey, tenantId),
        participant: r.participant,
        categoryId: optional(r.category, categoryId),
        destinationZoneId: optional(r.destinationZoneKey, zoneId),
        gateId: gateId(r.gateKey),
        direction: 'in' as const,
      })),
    );

    await put(
      schema.timeWindowPolicies,
      data.timeWindowPolicies.map((p) => ({
        id: id('time-window', p.key),
        ...onSite,
        tenantId: optional(p.tenantKey, tenantId),
        windowRequired: p.windowRequired,
        earlyToleranceMin: p.earlyToleranceMin,
        lateToleranceMin: p.lateToleranceMin,
        onViolation: p.onViolation,
      })),
    );
    await put(
      schema.timeWindowPolicyCategories,
      data.timeWindowPolicies.flatMap((p) =>
        p.categories.map((code) => ({
          policyId: id('time-window', p.key),
          categoryId: categoryId(code),
        })),
      ),
    );

    await put(
      schema.exceptions,
      data.exceptions.map((e) => ({
        id: id('exception', e.key),
        ...onSite,
        tenantId: optional(e.tenantKey, tenantId),
        name: e.name,
        match: e.match,
        waives: e.waives,
        guardText: e.guardText,
        basis: e.basis,
        validFrom: validFromInstant,
      })),
    );

    await put(
      schema.approvalPolicies,
      data.approvalPolicies.map((p) => ({
        id: id('approval', p.creatorKind, p.passType),
        ...onSite,
        creatorKind: p.creatorKind,
        passType: p.passType,
        mode: p.mode,
        commentRequired: p.commentRequired ?? false,
        escalationHours: p.escalationHours ?? null,
        onTimeout: p.onTimeout ?? null,
      })),
    );

    await put(
      schema.pedestrianRules,
      data.tenants.flatMap((t) =>
        t.pedestrianRules.map((r) => ({
          id: id('pedestrian-rule', t.key, r.zoneKey ?? '*'),
          ...onSite,
          tenantId: tenantId(t.key),
          zoneId: optional(r.zoneKey, zoneId),
          documentRequired: r.documentRequired,
          escort: r.escort,
          escortPhone: r.escortPhone ?? null,
          guardText: r.guardText,
        })),
      ),
    );

    // Шаблоны ролей организации (ADR-007): редактируемые копии с is_template.
    await put(
      schema.roles,
      ROLE_TEMPLATES.map((r) => ({
        id: id('role', r.code),
        ...base,
        name: r.name,
        permissions: [...r.permissions],
        isTemplate: true,
        templateCode: r.code,
      })),
    );
    // Одна учётка на КПП (A11); устройства привязываются кодом из админки (этап 5).
    await put(
      schema.gateAccounts,
      data.gates.map((g) => ({
        id: id('gate-account', g.key),
        ...onSite,
        gateId: gateId(g.key),
        roleId: id('role', data.gateAccountRoleTemplate),
      })),
    );

    return report;
  });
}

/** Ошибки данных сида видны сразу, до записи в БД. */
function validate(data: SeedData): void {
  if (data.site.workingHours) WorkingHoursSchema.parse(data.site.workingHours);
  SiteSettingsSchema.parse(data.site.settings);
  for (const e of data.exceptions) ExceptionMatchSchema.parse(e.match);
  roleTemplate(data.gateAccountRoleTemplate);

  const zones = new Set(data.zones.map((z) => z.key));
  const gates = new Set(data.gates.map((g) => g.key));
  const tenants = new Set(data.tenants.map((t) => t.key));
  const categories = new Set<string>(data.categories);
  const docks = new Map(data.docks.map((d) => [d.number, d]));
  const fail = (message: string): never => {
    throw new Error(`Сид (${data.site.name}): ${message}`);
  };
  const need = (set: Set<string>, key: string | undefined, what: string) => {
    if (key !== undefined && !set.has(key)) fail(`нет ${what} «${key}»`);
  };

  for (const g of data.gates) need(zones, g.zoneKey, 'зоны');
  for (const d of data.docks) need(zones, d.zoneKey, 'зоны');
  const assigned = new Map<string, string>();
  for (const t of data.tenants) {
    need(categories, t.defaultCategory, 'включённого типа');
    for (const r of t.pedestrianRules) need(zones, r.zoneKey, 'зоны');
    for (const q of t.quotas) for (const c of q.categories) need(categories, c, 'включённого типа');
    for (const number of t.docks) {
      if (!docks.has(number)) fail(`у арендатора ${t.key} несуществующий док «${number}»`);
      const other = assigned.get(number);
      if (other) fail(`док «${number}» назначен и ${other}, и ${t.key}`);
      assigned.set(number, t.key);
    }
    // capacity_from_docks: число в сиде должно совпасть с числом доков в лимите
    const countingDocks = t.docks.filter((n) => docks.get(n)?.countsInQuota).length;
    for (const q of t.quotas) {
      if (q.capacityFromDocks && q.capacity !== countingDocks) {
        fail(`лимит ${t.key}/${q.key}: ${q.capacity}, а доков в лимите ${countingDocks}`);
      }
    }
  }
  for (const r of data.routing) {
    need(tenants, r.tenantKey, 'арендатора');
    need(categories, r.category, 'включённого типа');
    need(zones, r.destinationZoneKey, 'зоны');
    need(gates, r.gateKey, 'КПП');
  }
  for (const p of data.timeWindowPolicies) {
    need(tenants, p.tenantKey, 'арендатора');
    for (const c of p.categories) need(categories, c, 'включённого типа');
  }
  for (const e of data.exceptions) need(tenants, e.tenantKey, 'арендатора');
}

/** Организация с тем же slug, но созданная не сидом, — не наша: молча дописывать в неё нельзя. */
async function assertOrganizationIsOurs(
  tx: DbTx,
  data: SeedData,
  organizationId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, data.organization.slug));
  if (existing && existing.id !== organizationId) {
    throw new Error(
      `Организация «${data.organization.slug}» уже есть, но создана не сидом (id ${existing.id}). ` +
        'Сид её не трогает: удалите её или пересоздайте базу (`pnpm db:reset`).',
    );
  }
}

import { OrganizationSettingsSchema, SiteSettingsSchema } from '@oxrana/contracts';
import type {
  BlacklistEntryView,
  CategoryView,
  DockView,
  ExceptionView,
  GateView,
  PedestrianRuleView,
  QuotaView,
  RoutingRuleView,
  RuleSet,
  SiteView,
  TenantView,
  TimeWindowPolicyView,
  ZoneView,
} from '@oxrana/engine';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db, DbTx } from '../client';
import * as schema from '../schema';

/**
 * Срез правил объекта для движка (RULES_ENGINE §1): один набор запросов, явный фильтр по
 * организации (RLS — вторая линия), только действующие записи. Порядок строк — по id, чтобы
 * результат не зависел от локали базы и замораживался в JSON без шума.
 */

export interface SiteRuleSet {
  readonly site: SiteView;
  readonly rules: RuleSet;
}

export interface LoadRuleSetOptions {
  readonly organizationId: string;
  readonly siteId: string;
  /** Момент, на который берутся назначения доков и договоры (местная дата объекта). */
  readonly asOf: Date;
}

const toInstant = (d: Date): number => d.getTime();
const toInstantOrNull = (d: Date | null): number | null => (d === null ? null : d.getTime());

/** Местная дата `YYYY-MM-DD` объекта для сравнения с `date`-колонками. */
function localDate(asOf: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(asOf);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function loadRuleSet(
  db: Db | DbTx,
  options: LoadRuleSetOptions,
): Promise<SiteRuleSet> {
  const { organizationId, siteId } = options;
  const org = eq(schema.sites.organizationId, organizationId);

  const [siteRow] = await db
    .select()
    .from(schema.sites)
    .where(and(org, eq(schema.sites.id, siteId), isNull(schema.sites.deletedAt)));
  if (!siteRow) throw new Error(`Объект ${siteId} не найден в организации ${organizationId}`);
  const settings = SiteSettingsSchema.parse(siteRow.settings);
  const site: SiteView = {
    id: siteRow.id,
    name: siteRow.name,
    timezone: siteRow.timezone,
    workingHours: siteRow.workingHours ?? null,
    settings: {
      outsideWorkingHours: settings.outsideWorkingHours,
      singleReturnWindowMin: settings.singleReturnWindowMin,
      overrideValidMin: settings.overrideValidMin,
    },
  };
  const today = localDate(options.asOf, siteRow.timezone);

  const gates: GateView[] = (
    await db
      .select()
      .from(schema.gates)
      .where(
        and(
          eq(schema.gates.organizationId, organizationId),
          eq(schema.gates.siteId, siteId),
          isNull(schema.gates.deletedAt),
        ),
      )
      .orderBy(asc(schema.gates.id))
  ).map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    admits: g.admits,
    zoneId: g.zoneId,
    direction: g.direction,
    workingHours: g.workingHours ?? null,
  }));

  const zones: ZoneView[] = (
    await db
      .select({ id: schema.zones.id, name: schema.zones.name })
      .from(schema.zones)
      .where(
        and(
          eq(schema.zones.organizationId, organizationId),
          eq(schema.zones.siteId, siteId),
          isNull(schema.zones.deletedAt),
        ),
      )
      .orderBy(asc(schema.zones.id))
  ).map((z) => ({ id: z.id, name: z.name }));

  // Типы: переопределение объекта заменяет запись организации с тем же preset_code.
  const categoryRows = await db
    .select()
    .from(schema.vehicleCategories)
    .where(
      and(
        eq(schema.vehicleCategories.organizationId, organizationId),
        or(isNull(schema.vehicleCategories.siteId), eq(schema.vehicleCategories.siteId, siteId)),
        eq(schema.vehicleCategories.enabled, true),
        isNull(schema.vehicleCategories.deletedAt),
      ),
    )
    .orderBy(asc(schema.vehicleCategories.id));
  const overridden = new Set(
    categoryRows.filter((c) => c.siteId !== null && c.presetCode !== null).map((c) => c.presetCode),
  );
  const categories: CategoryView[] = categoryRows
    .filter((c) => c.siteId !== null || c.presetCode === null || !overridden.has(c.presetCode))
    .map((c) => ({
      id: c.id,
      presetCode: c.presetCode,
      name: c.name,
      dockEligible: c.dockEligible,
    }));

  const dockRows = await db
    .select()
    .from(schema.docks)
    .where(
      and(
        eq(schema.docks.organizationId, organizationId),
        eq(schema.docks.siteId, siteId),
        isNull(schema.docks.deletedAt),
      ),
    )
    .orderBy(asc(schema.docks.id));
  const dockIds = dockRows.map((d) => d.id);
  const assignments =
    dockIds.length === 0
      ? []
      : await db
          .select({
            dockId: schema.tenantDockAssignments.dockId,
            tenantId: schema.tenantDockAssignments.tenantId,
          })
          .from(schema.tenantDockAssignments)
          .where(
            and(
              eq(schema.tenantDockAssignments.organizationId, organizationId),
              inArray(schema.tenantDockAssignments.dockId, dockIds),
              sql`${schema.tenantDockAssignments.validFrom} <= ${today}::date`,
              or(
                isNull(schema.tenantDockAssignments.validTo),
                sql`${schema.tenantDockAssignments.validTo} >= ${today}::date`,
              ),
            ),
          );
  const dockTenant = new Map(assignments.map((a) => [a.dockId, a.tenantId] as const));
  const docks: DockView[] = dockRows.map((d) => ({
    id: d.id,
    number: d.number,
    zoneId: d.zoneId,
    tenantId: dockTenant.get(d.id) ?? null,
    countsInQuota: d.countsInQuota,
  }));

  const tenantRows = await db
    .select()
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.organizationId, organizationId),
        eq(schema.tenants.siteId, siteId),
        isNull(schema.tenants.deletedAt),
      ),
    )
    .orderBy(asc(schema.tenants.id));
  const tenantIds = tenantRows.map((t) => t.id);
  // «Вести договоры» выключено: срок договора не проверяется, как у арендатора без договора.
  const [orgRow] = await db
    .select({ settings: schema.organizations.settings })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId));
  const trackContracts = OrganizationSettingsSchema.parse(orgRow?.settings ?? {}).trackContracts;
  const contractRows =
    tenantIds.length === 0 || !trackContracts
      ? []
      : await db
          .select({
            tenantId: schema.contracts.tenantId,
            validTo: schema.contracts.validTo,
          })
          .from(schema.contracts)
          .where(
            and(
              eq(schema.contracts.organizationId, organizationId),
              inArray(schema.contracts.tenantId, tenantIds),
              eq(schema.contracts.status, 'active'),
              isNull(schema.contracts.deletedAt),
            ),
          );
  // Срок договора: самый поздний из действующих; договор без срока = без срока.
  const contractValidTo = new Map<string, string | null>();
  for (const c of contractRows) {
    const current = contractValidTo.get(c.tenantId);
    if (current === null) continue;
    if (c.validTo === null || current === undefined || c.validTo > current) {
      contractValidTo.set(c.tenantId, c.validTo);
    }
  }
  const tenants: TenantView[] = tenantRows.map((t) => ({
    id: t.id,
    name: t.shortName,
    status: t.status,
    isOperator: t.isOperator,
    trucksDockRequired: t.trucksDockRequired,
    contractValidTo: contractValidTo.get(t.id) ?? null,
  }));

  const quotaRows = await db
    .select({
      quota: schema.quotas,
      basis: schema.contractClauses.ref,
    })
    .from(schema.quotas)
    .leftJoin(schema.contractClauses, eq(schema.contractClauses.id, schema.quotas.basisClauseId))
    .where(
      and(
        eq(schema.quotas.organizationId, organizationId),
        eq(schema.quotas.siteId, siteId),
        isNull(schema.quotas.deletedAt),
      ),
    )
    .orderBy(asc(schema.quotas.id));
  const quotaIds = quotaRows.map((r) => r.quota.id);
  const quotaCategoryRows =
    quotaIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.quotaCategories)
          .where(inArray(schema.quotaCategories.quotaId, quotaIds))
          .orderBy(asc(schema.quotaCategories.quotaId), asc(schema.quotaCategories.categoryId));
  const quotas: QuotaView[] = quotaRows.map(({ quota: q, basis }) => ({
    id: q.id,
    tenantId: q.tenantId,
    participant: q.participant,
    categoryIds: quotaCategoryRows.filter((qc) => qc.quotaId === q.id).map((qc) => qc.categoryId),
    name: q.name,
    capacity: q.capacity,
    capacityFromDocks: q.capacityFromDocks,
    counting: q.counting,
    enforcement: q.enforcement,
    overageTariffRub: q.overageTariffRub === null ? null : Number(q.overageTariffRub),
    overageCap: q.overageCap,
    schedule: q.schedule ?? null,
    validFrom: toInstant(q.validFrom),
    validTo: toInstantOrNull(q.validTo),
    basis,
  }));

  const routing: RoutingRuleView[] = (
    await db
      .select()
      .from(schema.routingRules)
      .where(
        and(
          eq(schema.routingRules.organizationId, organizationId),
          eq(schema.routingRules.siteId, siteId),
          isNull(schema.routingRules.deletedAt),
        ),
      )
      .orderBy(asc(schema.routingRules.id))
  ).map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    participant: r.participant,
    categoryId: r.categoryId,
    destinationZoneId: r.destinationZoneId,
    gateId: r.gateId,
    direction: r.direction,
    priority: r.priority,
  }));

  const policyRows = await db
    .select()
    .from(schema.timeWindowPolicies)
    .where(
      and(
        eq(schema.timeWindowPolicies.organizationId, organizationId),
        eq(schema.timeWindowPolicies.siteId, siteId),
        isNull(schema.timeWindowPolicies.deletedAt),
      ),
    )
    .orderBy(asc(schema.timeWindowPolicies.id));
  const policyIds = policyRows.map((p) => p.id);
  const policyCategoryRows =
    policyIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.timeWindowPolicyCategories)
          .where(inArray(schema.timeWindowPolicyCategories.policyId, policyIds))
          .orderBy(
            asc(schema.timeWindowPolicyCategories.policyId),
            asc(schema.timeWindowPolicyCategories.categoryId),
          );
  const timeWindows: TimeWindowPolicyView[] = policyRows.map((p) => ({
    id: p.id,
    tenantId: p.tenantId,
    categoryIds: policyCategoryRows.filter((pc) => pc.policyId === p.id).map((pc) => pc.categoryId),
    windowRequired: p.windowRequired,
    earlyToleranceMin: p.earlyToleranceMin,
    lateToleranceMin: p.lateToleranceMin,
    onViolation: p.onViolation,
  }));

  const exceptions: ExceptionView[] = (
    await db
      .select()
      .from(schema.exceptions)
      .where(
        and(
          eq(schema.exceptions.organizationId, organizationId),
          eq(schema.exceptions.siteId, siteId),
          isNull(schema.exceptions.deletedAt),
        ),
      )
      .orderBy(asc(schema.exceptions.id))
  ).map((e) => ({
    id: e.id,
    tenantId: e.tenantId,
    name: e.name,
    match: e.match,
    waives: e.waives,
    validFrom: toInstant(e.validFrom),
    validTo: toInstantOrNull(e.validTo),
    guardText: e.guardText,
    basis: e.basis,
  }));

  const pedestrianRules: PedestrianRuleView[] = (
    await db
      .select()
      .from(schema.pedestrianRules)
      .where(
        and(
          eq(schema.pedestrianRules.organizationId, organizationId),
          eq(schema.pedestrianRules.siteId, siteId),
          isNull(schema.pedestrianRules.deletedAt),
        ),
      )
      .orderBy(asc(schema.pedestrianRules.id))
  ).map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    zoneId: r.zoneId,
    documentRequired: r.documentRequired,
    escort: r.escort,
    escortPhone: r.escortPhone,
    guardText: r.guardText,
  }));

  const blacklist: BlacklistEntryView[] = (
    await db
      .select()
      .from(schema.blacklist)
      .where(
        and(
          eq(schema.blacklist.organizationId, organizationId),
          or(isNull(schema.blacklist.siteId), eq(schema.blacklist.siteId, siteId)),
          isNull(schema.blacklist.deletedAt),
        ),
      )
      .orderBy(asc(schema.blacklist.id))
  ).map((b) => ({
    id: b.id,
    plateNorm: b.plateNorm,
    personName: b.personName,
    reason: b.reason,
    validTo: toInstantOrNull(b.validTo),
  }));

  return {
    site,
    rules: {
      gates,
      zones,
      categories,
      docks,
      tenants,
      quotas,
      routing,
      timeWindows,
      exceptions,
      pedestrianRules,
      blacklist,
    },
  };
}

import type { SandboxCheck } from '@oxrana/contracts';
import { openVisits, schema } from '@oxrana/db';
import {
  capacityOf,
  countOccupancy,
  evaluate,
  formatDateTime,
  type LiveState,
  type PassView,
  type RuleSet,
  type SiteView,
  type Verdict,
  type VisitView,
} from '@oxrana/engine';
import { normalizePlate } from '@oxrana/plates';
import { and, eq, inArray } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import type { SiteRow } from '../../core/loaders';
import { AppError } from '../../errors';
import { siteTimeLabel } from '../org/sites';
import { engineVisit } from '../passes/views';
import { PASS_TYPE_LABEL } from '../passes/validate';

/**
 * Песочница правил (этап 6b): воображаемый пропуск проверяется тем же `evaluate`, что на посту и
 * в транзакции въезда. Пропуск считается согласованным и действующим; всё остальное — настоящие
 * правила объекта и настоящая занятость (открытые визиты). Ничего не записывается.
 */

const HOUR = 3_600_000;
/** Срок воображаемого пропуска вперёд от момента проверки. */
const VALID_AHEAD: Record<string, number | null> = { single: 12 * HOUR, multi: 48 * HOUR, permanent: null };

export interface SandboxData {
  readonly site: SiteRow;
  readonly siteView: SiteView;
  readonly rules: RuleSet;
  readonly openVisits: readonly VisitView[];
}

export async function loadSandboxData(s: Scope, site: SiteRow): Promise<SandboxData> {
  const { site: siteView, rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  const open = await openVisits(s.db, { organizationId: s.organizationId, siteId: site.id });
  return { site, siteView, rules, openVisits: open.map(engineVisit) };
}

export interface SandboxOutcome {
  readonly verdict: Verdict;
  readonly subject: {
    tenantName: string;
    gateName: string;
    categoryName: string | null;
    plateNorm: string | null;
    atLabel: string;
    directionLabel: string;
    passTypeLabel: string;
  };
  readonly assumptions: string[];
}

const invalid = (field: string, message: string) =>
  new AppError('validation_failed', { field, message });

export function runSandbox(data: SandboxData, request: SandboxCheck, nowMs: number): SandboxOutcome {
  const { rules, siteView, site } = data;
  const tenant = rules.tenants.find((t) => t.id === request.tenantId);
  if (!tenant) throw invalid('tenantId', 'Арендатор не найден на этом объекте. Выберите из списка.');
  const gate = rules.gates.find((g) => g.id === request.gateId);
  if (!gate) throw invalid('gateId', 'КПП не найден на этом объекте. Выберите из списка.');
  const participant = request.participant;
  const category =
    participant === 'vehicle' && request.categoryId
      ? rules.categories.find((c) => c.id === request.categoryId)
      : undefined;
  if (participant === 'vehicle') {
    if (!request.categoryId) {
      throw invalid('categoryId', 'Выберите тип транспорта — по нему считаются лимиты и маршрут.');
    }
    if (!category) {
      throw invalid('categoryId', 'Этот тип транспорта недоступен на объекте. Выберите из списка.');
    }
  }
  if (request.dockId && !rules.docks.some((d) => d.id === request.dockId)) {
    throw invalid('dockId', 'Док не найден на этом объекте. Выберите из списка.');
  }
  const at = request.at ? Date.parse(request.at) : nowMs;
  const plate = request.plate ? normalizePlate(request.plate) : null;
  const plateNorm = plate && plate.norm ? plate.norm : null;
  const ahead = VALID_AHEAD[request.passType] ?? null;
  const pass: PassView = {
    id: 'sandbox-pass',
    tenantId: tenant.id,
    passType: request.passType,
    participant,
    status: 'approved',
    plateNorm: participant === 'vehicle' ? plateNorm : null,
    categoryId: participant === 'vehicle' ? (request.categoryId ?? null) : null,
    personName: participant === 'pedestrian' ? (request.personName ?? null) : null,
    destinationZoneId: request.destinationZoneId ?? null,
    dockId: request.dockId ?? null,
    validFrom: at - HOUR,
    validTo: ahead === null ? null : at + ahead,
    windowFrom: request.windowFrom ? Date.parse(request.windowFrom) : null,
    windowTo: request.windowTo ? Date.parse(request.windowTo) : null,
  };
  const live = data.openVisits.filter((v) => v.tenantId === tenant.id);
  const occupancy = rules.quotas
    .filter((q) => q.tenantId === tenant.id)
    .map((q) => ({
      quotaId: q.id,
      occupied: request.quotaFull ? capacityOf(q, rules.docks) : countOccupancy(live, q),
    }));
  const state: LiveState = { occupancy, queue: [], asOf: at };
  const syntheticVisit: VisitView | null =
    request.direction === 'out'
      ? {
          id: 'sandbox-visit',
          passId: pass.id,
          tenantId: tenant.id,
          participant,
          categoryId: pass.categoryId,
          plateNorm: pass.plateNorm,
          gateInId: null,
          timeIn: at - HOUR,
          timeOut: null,
          exceptionWaivesQuota: false,
        }
      : null;
  const verdict = evaluate({
    now: at,
    site: siteView,
    gate,
    direction: request.direction,
    subject: { kind: 'pass', pass, openVisit: syntheticVisit, pastVisits: [] },
    rules,
    state,
    overrides: [],
  });
  const assumptions = [
    `Пропуск воображаемый: ${PASS_TYPE_LABEL[request.passType].toLowerCase()}, согласован, действует${
      pass.validTo === null ? ' без срока' : ` до ${formatDateTime(pass.validTo, site.timezone)}`
    }.`,
    request.quotaFull
      ? 'Считается, что все места лимитов арендатора заняты.'
      : 'Занятость лимитов — по машинам, которые сейчас на территории.',
  ];
  if (participant === 'vehicle' && !plateNorm) {
    assumptions.push('Номер не указан — чёрный список не проверяется.');
  }
  if (participant === 'pedestrian' && !request.personName) {
    assumptions.push('Имя не указано — чёрный список по человеку не проверяется.');
  }
  return {
    verdict,
    subject: {
      tenantName: tenant.name,
      gateName: gate.name,
      categoryName: category?.name ?? null,
      plateNorm,
      atLabel: `${formatDateTime(at, site.timezone)} (${siteTimeLabel(site, at)})`,
      directionLabel: request.direction === 'in' ? 'Въезд' : 'Выезд',
      passTypeLabel: PASS_TYPE_LABEL[request.passType],
    },
    assumptions,
  };
}

/** Имена людей по пропускам открытых визитов — для «что будет, если» по пешеходным лимитам. */
export async function personNames(
  s: Scope,
  passIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (passIds.length === 0) return new Map();
  const rows = await s.db
    .select({ id: schema.passes.id, personName: schema.passes.personName })
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.organizationId, s.organizationId),
        inArray(schema.passes.id, [...passIds]),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.personName]));
}

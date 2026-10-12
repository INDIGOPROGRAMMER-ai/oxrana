import { type ApprovalMode, PASS_TYPES, type Participant, type PassType } from '@oxrana/contracts';
import { openVisits } from '@oxrana/db';
import {
  applicableQuotas,
  capacityOf,
  collectWaivers,
  countOccupancy,
  type QuotaView,
  type RuleSet,
  routeGates,
} from '@oxrana/engine';
import { isTenantUser } from '../../actor';
import { can, type Scope } from '../../core/context';
import type { TenantRow } from '../../core/loaders';
import {
  approvalPolicy,
  creatorKindOf,
  loadPassContext,
  tenantDocks,
  windowPolicyFor,
} from './validate';
import { dockRanges, engineVisit } from './views';

/**
 * Подсказки формы пропуска до сохранения (CLAUDE.md, правила интерфейса; ARCHITECTURE §3.2):
 * «Фура → КПП для грузовых», «Грузовые 25/25 — машина будет ждать», «Уйдёт на согласование», «Ваши доки:
 * 1–18, 66–72». Считаются тем же движком, что вердикт на посту (`routeGates`, `applicableQuotas`,
 * `countOccupancy`).
 */
const APPROVAL_TEXT: Record<ApprovalMode, string> = {
  allow: 'Без согласования — пропуск начнёт действовать сразу',
  on_request: 'Уйдёт на согласование',
  deny: 'Запрещено политикой согласования',
};

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);

function quotaText(q: QuotaView, occupied: number, capacity: number): string {
  const head = `${q.name} ${occupied}/${capacity}`;
  if (capacity === 0) return `${q.name}: не предусмотрено договором (лимит 0)`;
  if (occupied < capacity) return head;
  if (q.enforcement === 'hard') return `${head} — машина будет ждать`;
  if (q.enforcement === 'soft') {
    return q.overageTariffRub !== null
      ? `${head} — въезд сверх лимита, ${q.overageTariffRub} ₽ за сутки`
      : `${head} — въезд сверх лимита`;
  }
  return `${head} — лимит заполнен (предупреждение)`;
}

/** Типы, которые есть смысл показывать арендатору: лимит 0 по всем лимитам — «не предусмотрено». */
function availableCategories(rules: RuleSet, tenantId: string, now: number, tz: string) {
  return rules.categories.filter((c) => {
    const quotas = applicableQuotas(rules.quotas, tenantId, { categoryId: c.id }, now, tz);
    return quotas.length === 0 || quotas.some((q) => capacityOf(q, rules.docks) > 0);
  });
}

export async function passHints(
  s: Scope,
  tenant: TenantRow,
  query: {
    participant: Participant;
    categoryId?: string | undefined;
    passType?: PassType | undefined;
    destinationZoneId?: string | undefined;
  },
) {
  const ctx = await loadPassContext(s, tenant);
  const { rules, now, site } = ctx;
  const tz = site.timezone;
  const category = query.categoryId
    ? (rules.categories.find((c) => c.id === query.categoryId) ?? null)
    : null;

  const gateIds = routeGates(rules, {
    tenantId: tenant.id,
    participant: query.participant,
    categoryId: category?.id ?? null,
    destinationZoneId: query.destinationZoneId ?? null,
  });
  const gates = gateIds.map((id) => ({
    id,
    name: rules.gates.find((g) => g.id === id)?.name ?? '',
  }));
  const who =
    query.participant === 'pedestrian' ? 'Пешеходы' : capitalize(category?.name ?? 'Машины');
  const route = {
    gates,
    text:
      gates.length > 0
        ? `${who} → ${gates.map((g) => g.name).join(' или ')}`
        : `${who}: КПП не настроен`,
  };

  const target =
    query.participant === 'pedestrian'
      ? ('pedestrian' as const)
      : category
        ? { categoryId: category.id }
        : null;
  const visits = (
    await openVisits(s.db, {
      organizationId: s.organizationId,
      siteId: site.id,
      tenantId: tenant.id,
    })
  ).map(engineVisit);
  const quotas = target
    ? applicableQuotas(rules.quotas, tenant.id, target, now, tz).map((q) => {
        const occupied = countOccupancy(visits, q);
        const capacity = capacityOf(q, rules.docks);
        return {
          quotaId: q.id,
          name: q.name,
          occupied,
          capacity,
          enforcement: q.enforcement,
          text: quotaText(q, occupied, capacity),
        };
      })
    : [];

  const creator = creatorKindOf(s);
  const policy = query.passType
    ? await approvalPolicy(s, site.id, tenant.id, creator, query.passType)
    : null;
  const passTypes: { passType: PassType; mode: ApprovalMode }[] = [];
  for (const passType of PASS_TYPES) {
    if (!can(s.ctx, `pass.create.${passType}`)) continue;
    const p = await approvalPolicy(s, site.id, tenant.id, creator, passType);
    const mode = p?.mode ?? 'allow';
    if (mode !== 'deny') passTypes.push({ passType, mode });
  }

  const docks = tenantDocks(rules, tenant.id);
  const dockRequired =
    query.participant === 'vehicle' &&
    tenant.trucksDockRequired &&
    (category?.dockEligible ?? false);
  const whose = isTenantUser(s.ctx.actor) ? 'Ваши доки' : 'Доки арендатора';
  const windowPolicy =
    query.participant === 'vehicle'
      ? windowPolicyFor(rules, tenant.id, category?.id ?? null)
      : null;
  const waived = collectWaivers(
    {
      id: '00000000-0000-0000-0000-000000000000',
      tenantId: tenant.id,
      passType: query.passType ?? 'single',
      participant: query.participant,
      status: 'approved',
      plateNorm: null,
      categoryId: category?.id ?? null,
      personName: null,
      destinationZoneId: query.destinationZoneId ?? null,
      dockId: null,
      validFrom: now,
      validTo: null,
      windowFrom: null,
      windowTo: null,
    },
    rules.exceptions,
    now,
  ).waived;

  const pedestrianRule =
    query.participant === 'pedestrian'
      ? (rules.pedestrianRules.find(
          (r) =>
            r.tenantId === tenant.id &&
            (r.zoneId === null || r.zoneId === (query.destinationZoneId ?? null)),
        )?.guardText ?? null)
      : null;

  return {
    route,
    quotas,
    approval: query.passType
      ? {
          mode: policy?.mode ?? ('allow' as const),
          text: policy ? APPROVAL_TEXT[policy.mode] : `${APPROVAL_TEXT.allow} (политика не задана)`,
        }
      : null,
    commentRequired: policy?.commentRequired ?? false,
    dock: {
      required: dockRequired,
      docks: docks.map((d) => ({ id: d.id, number: d.number })),
      text: docks.length > 0 ? `${whose}: ${dockRanges(docks.map((d) => d.number))}` : null,
    },
    window: {
      required: (windowPolicy?.windowRequired ?? false) && !waived.has('time_window'),
      earlyToleranceMin: windowPolicy?.earlyToleranceMin ?? 0,
      lateToleranceMin: windowPolicy?.lateToleranceMin ?? null,
    },
    pedestrianRule,
    categories:
      query.participant === 'vehicle'
        ? availableCategories(rules, tenant.id, now, tz).map((c) => ({ id: c.id, name: c.name }))
        : [],
    passTypes,
  };
}

import {
  type ApprovalMode,
  PASS_TYPES,
  type Participant,
  type PassNotice,
  type PassType,
} from '@oxrana/contracts';
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
import { normalizePlate } from '@oxrana/plates';
import { isTenantUser } from '../../actor';
import { can, type Scope } from '../../core/context';
import type { TenantRow } from '../../core/loaders';
import { loadActorForm } from '../pass-form/service';
import {
  approvalPolicy,
  blacklistProblem,
  creatorKindOf,
  loadPassContext,
  type PassContext,
  tenantDocks,
  tenantPassProblem,
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
export function availableCategories(rules: RuleSet, tenantId: string, now: number, tz: string) {
  return rules.categories.filter((c) => {
    const quotas = applicableQuotas(rules.quotas, tenantId, { categoryId: c.id }, now, tz);
    return quotas.length === 0 || quotas.some((q) => capacityOf(q, rules.docks) > 0);
  });
}

/**
 * Что мешает или предупреждает до сохранения: блокировка арендатора, конец договора, чёрный список.
 * Пользователю арендатора причину записи чёрного списка не показываем — её видит администратор.
 */
function formNotices(
  ctx: PassContext,
  query: {
    participant: Participant;
    plate?: string | undefined;
    personName?: string | undefined;
    validFrom?: string | undefined;
  },
): PassNotice[] {
  const notices: PassNotice[] = [];
  const problem = tenantPassProblem(ctx);
  if (problem) {
    notices.push({
      code: problem.code,
      severity: 'error',
      text: ctx.tenantUser
        ? `${problem.message.replace(' Решение принимает администратор объекта.', '')} Обратитесь к администратору объекта.`
        : problem.message,
    });
  } else if (ctx.tenant.status === 'blocked_entry') {
    notices.push({
      code: 'tenant_entry_blocked',
      severity: 'warning',
      text: ctx.tenantUser
        ? 'Въезд вашей компании временно запрещён администратором объекта. Пропуск оформится, но машины не пропустят, пока блокировку не снимут.'
        : 'Для арендатора включён запрет въезда. Пропуск оформится и будет ждать снятия блокировки.',
    });
  }
  const plate =
    query.participant === 'vehicle' && query.plate?.trim()
      ? normalizePlate(query.plate.trim())
      : null;
  const listed = blacklistProblem(
    ctx,
    {
      plateNorm: plate?.norm,
      personName: query.participant === 'pedestrian' ? query.personName : null,
    },
    query.validFrom ? Date.parse(query.validFrom) : null,
  );
  if (listed) notices.push({ code: 'blacklisted', severity: 'error', text: listed.message });
  return notices;
}

export async function passHints(
  s: Scope,
  tenant: TenantRow,
  query: {
    participant: Participant;
    categoryId?: string | undefined;
    passType?: PassType | undefined;
    destinationZoneId?: string | undefined;
    /** Номер или имя — только для проверки по чёрному списку; нигде не сохраняются. */
    plate?: string | undefined;
    personName?: string | undefined;
    validFrom?: string | undefined;
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
  const { form, enforced } = await loadActorForm(s, tenant);
  const passTypes: { passType: PassType; mode: ApprovalMode }[] = [];
  for (const passType of PASS_TYPES) {
    if (!can(s.ctx, `pass.create.${passType}`)) continue;
    // Виды пропусков, отключённые в настройке формы, не показываются вовсе (ADR-023).
    if (enforced && !form.passTypes.includes(passType)) continue;
    const p = await approvalPolicy(s, site.id, tenant.id, creator, passType);
    const mode = p?.mode ?? 'on_request';
    if (mode !== 'deny') passTypes.push({ passType, mode });
  }

  const docks = tenantDocks(rules, tenant.id);
  // Док обязателен только разовому пропуску (7b.1): на много поездок док каждый раз свой.
  const dockRequired =
    query.participant === 'vehicle' &&
    (query.passType ?? 'single') === 'single' &&
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

  const notices = formNotices(ctx, query);

  // Окно прибытия: форма (уровни настройки) главнее политики окон, если форма применяется (ADR-023).
  const policyRequires = (windowPolicy?.windowRequired ?? false) && !waived.has('time_window');
  const windowMode = form.fields.window;
  function windowHint() {
    const base = {
      earlyToleranceMin: windowPolicy?.earlyToleranceMin ?? 0,
      lateToleranceMin: windowPolicy?.lateToleranceMin ?? null,
    };
    if (!enforced || windowMode === 'policy') {
      return { required: policyRequires, autoFilled: false, ...base };
    }
    // Окно постоянного пропуска, которое требует политика, форма скрыть не может: на весь срок
    // его не поставить (срока нет).
    const forced = query.passType === 'permanent' && policyRequires;
    return {
      required: windowMode === 'required' || forced,
      autoFilled: windowMode !== 'required' && policyRequires && !forced,
      ...base,
    };
  }

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
          mode: policy?.mode ?? ('on_request' as const),
          text: policy
            ? APPROVAL_TEXT[policy.mode]
            : `${APPROVAL_TEXT.on_request}: политика согласования для такого пропуска не задана`,
        }
      : null,
    commentRequired:
      (policy?.commentRequired ?? false) || (enforced && form.fields.comment === 'required'),
    dock: {
      required: dockRequired,
      docks: docks.map((d) => ({ id: d.id, number: d.number })),
      text: docks.length > 0 ? `${whose}: ${dockRanges(docks.map((d) => d.number))}` : null,
    },
    window: windowHint(),
    pedestrianRule,
    categories:
      query.participant === 'vehicle'
        ? availableCategories(rules, tenant.id, now, tz)
            .filter(
              (c) => !enforced || form.categoryIds === null || form.categoryIds.includes(c.id),
            )
            .map((c) => ({ id: c.id, name: c.name }))
        : [],
    passTypes,
    notices,
  };
}

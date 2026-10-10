/**
 * `evaluate` (RULES_ENGINE §3, §9): цепочка проверок, trace и вердикт. Все проверки выполняются
 * до конца (кроме «пропуск не найден»), чтобы администратор видел всю цепочку.
 */
import { resolveCandidates, resolvePedestrian } from './candidates';
import { applicableQuotas, capacityOf } from './quotas';
import {
  describeTodayHours,
  formatDateTime,
  formatLocalDate,
  formatTime,
  isWithinHours,
  localDate,
} from './time';
import type {
  ApprovedOverride,
  CandidateView,
  CategoryView,
  CheckKind,
  EvaluationInput,
  GateKind,
  GateView,
  Instant,
  PassageDirection,
  PassView,
  PrimaryAction,
  QuotaState,
  Reason,
  RoutingRuleView,
  SecondaryAction,
  Severity,
  SkipReason,
  TenantView,
  TraceEntry,
  Verdict,
  VerdictCode,
  VerdictColor,
  VisitFlag,
  VisitView,
  Waiver,
} from './types';
import { collectWaivers, type Waivers } from './waivers';

/** Семвер движка: пишется в `gate_decisions.engine_version`. */
export const ENGINE_VERSION = '0.3.0';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  allow: 0,
  overage: 1,
  wait: 2,
  wrong_gate: 3,
  deny: 4,
};

const COLOR: Readonly<Record<VerdictCode, VerdictColor>> = {
  allow: 'green',
  allow_overage: 'orange',
  wait: 'yellow',
  wrong_gate: 'blue',
  deny: 'red',
  no_pass: 'yellow',
};

const MINUTE = 60_000;

interface Outcome {
  readonly trace: TraceEntry;
  readonly severity?: Severity;
  readonly reason?: Reason;
  readonly infoLines?: readonly string[];
  readonly secondary?: readonly SecondaryAction[];
  readonly suggestedGateIds?: readonly string[];
  readonly quotaStates?: readonly QuotaState[];
  readonly flags?: readonly VisitFlag[];
  readonly overage?: { readonly quotaId: string; readonly tariffRub: number };
}

interface Ctx {
  readonly input: EvaluationInput;
  readonly pass: PassView;
  readonly tenant: TenantView | undefined;
  readonly category: CategoryView | undefined;
  readonly openVisit: VisitView | null;
  readonly pastVisits: readonly VisitView[];
  readonly waivers: Waivers;
  readonly tz: string;
}

type Check = (ctx: Ctx) => Outcome;

// ---------- вспомогательные ----------

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function pass(check: CheckKind, details?: Record<string, unknown>): Outcome {
  return { trace: { check, result: 'pass', ...(details ? { details } : {}) } };
}

function skipped(check: CheckKind, reason: SkipReason): Outcome {
  return { trace: { check, result: 'skipped', skippedBy: { reason } } };
}

function skippedByException(ctx: Ctx, check: CheckKind, waiver: Waiver): Outcome {
  const exception = ctx.waivers.byWaiver.get(waiver);
  return {
    trace: {
      check,
      result: 'skipped',
      skippedBy: { exceptionId: exception?.id ?? '' },
      details: { exception: exception?.name ?? '' },
    },
  };
}

function fail(
  check: CheckKind,
  severity: Exclude<Severity, 'allow'>,
  reason: Reason,
  extra: Partial<Omit<Outcome, 'trace' | 'severity' | 'reason'>> & {
    details?: Record<string, unknown>;
  } = {},
): Outcome {
  const { details, ...rest } = extra;
  return {
    trace: {
      check,
      result: 'fail',
      severity,
      ...(details ? { details } : {}),
      ...(reason.settingLink ? { settingLink: reason.settingLink } : {}),
      ...(reason.basis ? { basis: reason.basis } : {}),
    },
    severity,
    reason,
    ...rest,
  };
}

function warn(
  check: CheckKind,
  reason: Reason,
  extra: Partial<Omit<Outcome, 'trace' | 'severity' | 'reason'>> & {
    details?: Record<string, unknown>;
  } = {},
): Outcome {
  const { details, ...rest } = extra;
  return {
    trace: {
      check,
      result: 'warn',
      severity: 'info',
      ...(details ? { details } : {}),
      ...(reason.settingLink ? { settingLink: reason.settingLink } : {}),
    },
    reason,
    ...rest,
  };
}

function gateNames(ctx: Ctx, ids: readonly string[]): string {
  const names = ids.map((id) => ctx.input.rules.gates.find((g) => g.id === id)?.name ?? id);
  return names.join(' или ');
}

function participantAdmitted(gate: GateView, participant: PassView['participant']): boolean {
  if (gate.admits === 'vehicles_and_pedestrians') return true;
  return participant === 'vehicle' ? gate.admits === 'vehicles' : gate.admits === 'pedestrians';
}

/** Маршруты, применимые к пропуску на КПП данного вида и направления; правила арендатора приоритетнее. */
function matchingRoutes(ctx: Ctx, direction: PassageDirection, kind: GateKind): RoutingRuleView[] {
  const { pass: p, input } = ctx;
  const gateKind = new Map(input.rules.gates.map((g) => [g.id, g.kind] as const));
  const applies = (r: RoutingRuleView): boolean =>
    r.participant === p.participant &&
    (r.direction === 'both' || r.direction === direction) &&
    gateKind.get(r.gateId) === kind &&
    (p.participant === 'pedestrian' || r.categoryId === null || r.categoryId === p.categoryId) &&
    (r.destinationZoneId === null || r.destinationZoneId === p.destinationZoneId);
  const tenantRules = input.rules.routing.filter((r) => r.tenantId === p.tenantId && applies(r));
  const chosen =
    tenantRules.length > 0
      ? tenantRules
      : input.rules.routing.filter((r) => r.tenantId === null && applies(r));
  return [...chosen].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function participantLabel(ctx: Ctx): string {
  if (ctx.pass.participant === 'pedestrian') return 'Пешеходы';
  return capitalize(ctx.category?.name ?? 'машины');
}

// ---------- проверки въезда ----------

const passStatus: Check = (ctx) => {
  const { pass: p, tz } = ctx;
  const link = 'Пропуска → карточка пропуска';
  switch (p.status) {
    case 'approved':
      if (p.participant === 'vehicle' && !ctx.category) {
        return fail('pass_status', 'deny', {
          code: 'category_missing',
          message: 'В пропуске не указан тип транспорта — исправьте пропуск',
          settingLink: link,
        });
      }
      return pass('pass_status', { status: p.status });
    case 'pending_approval':
      return fail('pass_status', 'deny', {
        code: 'pass_pending_approval',
        message: 'Пропуск на согласовании — въезд после одобрения',
        settingLink: 'Согласование → заявки',
      });
    case 'used':
      return fail(
        'pass_status',
        'deny',
        {
          code: 'single_pass_used',
          message: 'Разовый пропуск использован — нужен новый пропуск',
          settingLink: link,
        },
        { secondary: ['request_pass'] },
      );
    case 'draft':
      return fail('pass_status', 'deny', {
        code: 'pass_draft',
        message: 'Пропуск не оформлен (черновик)',
        settingLink: link,
      });
    case 'rejected':
      return fail('pass_status', 'deny', {
        code: 'pass_rejected',
        message: 'Пропуск отклонён согласующим',
        settingLink: link,
      });
    case 'cancelled':
      return fail('pass_status', 'deny', {
        code: 'pass_cancelled',
        message: 'Пропуск отменён',
        settingLink: link,
      });
    case 'expired':
      return fail('pass_status', 'deny', {
        code: 'pass_expired',
        message:
          p.validTo === null
            ? 'Пропуск закончился'
            : `Пропуск закончился ${formatDateTime(p.validTo, tz)}`,
        params: { validTo: p.validTo },
        settingLink: link,
      });
  }
};

function blacklistHit(ctx: Ctx) {
  const { pass: p, input } = ctx;
  const name = (p.personName ?? '').trim().toLocaleUpperCase('ru-RU');
  return input.rules.blacklist.find(
    (b) =>
      (b.validTo === null || b.validTo > input.now) &&
      ((b.plateNorm !== null && p.plateNorm !== null && b.plateNorm === p.plateNorm) ||
        (b.personName !== null &&
          name.length > 0 &&
          b.personName.trim().toLocaleUpperCase('ru-RU') === name)),
  );
}

const blacklist: Check = (ctx) => {
  const hit = blacklistHit(ctx);
  if (!hit) return pass('blacklist');
  return fail(
    'blacklist',
    'deny',
    {
      code: 'blacklisted',
      message: `В чёрном списке: ${hit.reason}`,
      settingLink: 'Настройки → Чёрный список',
    },
    { details: { entryId: hit.id } },
  );
};

/** На выезде чёрный список — только предупреждение: выпускать всегда (Q-10). */
const blacklistWarnOnly: Check = (ctx) => {
  const hit = blacklistHit(ctx);
  if (!hit) return pass('blacklist');
  return warn(
    'blacklist',
    {
      code: 'blacklisted_leaving',
      message: `В чёрном списке: ${hit.reason} — выпустить, сообщить администратору`,
      settingLink: 'Настройки → Чёрный список',
    },
    { details: { entryId: hit.id } },
  );
};

const tenantStatus: Check = (ctx) => {
  const { tenant } = ctx;
  if (!tenant) {
    return fail('tenant_status', 'deny', {
      code: 'tenant_missing',
      message: 'Арендатор пропуска не найден в правилах объекта',
      settingLink: 'Арендаторы',
    });
  }
  const link = `Арендаторы → ${tenant.name} → Статус`;
  switch (tenant.status) {
    case 'active':
    case 'blocked_new_passes':
      return pass('tenant_status', { status: tenant.status });
    case 'blocked_entry':
      return fail('tenant_status', 'deny', {
        code: 'tenant_blocked_entry',
        message: `Въезд арендатору ${tenant.name} запрещён администратором`,
        settingLink: link,
      });
    case 'archived':
      return fail('tenant_status', 'deny', {
        code: 'tenant_archived',
        message: `Арендатор ${tenant.name} в архиве`,
        settingLink: link,
      });
  }
};

const contract: Check = (ctx) => {
  const { tenant, input, tz } = ctx;
  if (!tenant || tenant.contractValidTo === null) {
    return pass('contract', { validTo: null });
  }
  const today = localDate(input.now, tz);
  if (tenant.contractValidTo >= today) return pass('contract', { validTo: tenant.contractValidTo });
  return fail(
    'contract',
    'deny',
    {
      code: 'contract_expired',
      message: `Договор арендатора ${tenant.name} закончился ${formatLocalDate(tenant.contractValidTo)}`,
      params: { validTo: tenant.contractValidTo },
      settingLink: `Арендаторы → ${tenant.name} → Договор`,
    },
    { details: { validTo: tenant.contractValidTo, today } },
  );
};

const passValidity: Check = (ctx) => {
  const { pass: p, input, tz } = ctx;
  if (p.validFrom !== null && input.now < p.validFrom) {
    return fail(
      'pass_validity',
      'wait',
      {
        code: 'pass_not_started',
        message: `Пропуск действует с ${formatDateTime(p.validFrom, tz)}`,
        params: { validFrom: p.validFrom },
        settingLink: 'Пропуска → карточка пропуска',
      },
      { details: { validFrom: p.validFrom } },
    );
  }
  if (p.validTo !== null && input.now > p.validTo) {
    return fail(
      'pass_validity',
      'deny',
      {
        code: 'pass_ended',
        message: `Пропуск закончился ${formatDateTime(p.validTo, tz)}`,
        params: { validTo: p.validTo },
        settingLink: 'Пропуска → карточка пропуска',
      },
      { details: { validTo: p.validTo } },
    );
  }
  return pass('pass_validity', { validFrom: p.validFrom, validTo: p.validTo });
};

const singleUsed: Check = (ctx) => {
  const { pass: p, pastVisits, input } = ctx;
  if (p.passType !== 'single') return skipped('single_used', 'not_applicable');
  const closed = pastVisits.filter((v) => v.timeOut !== null);
  if (closed.length === 0) return pass('single_used', { visits: 0 });
  const lastOut = Math.max(...closed.map((v) => v.timeOut ?? 0));
  const returnWindow = input.site.settings.singleReturnWindowMin;
  if (returnWindow !== null && input.now - lastOut <= returnWindow * MINUTE) {
    return pass('single_used', { visits: closed.length, returnWithinMin: returnWindow });
  }
  return fail(
    'single_used',
    'deny',
    {
      code: 'single_pass_used',
      message: 'Разовый пропуск использован — нужен новый пропуск',
      params: { lastOut },
      settingLink: 'Пропуска → карточка пропуска',
    },
    { secondary: ['request_pass'], details: { visits: closed.length, lastOut } },
  );
};

const alreadyInside: Check = (ctx) => {
  const { openVisit, tz, input } = ctx;
  if (!openVisit) return pass('open_visit', { open: false });
  // Внутренний пост: человек и должен быть на территории — открытый визит не предупреждение.
  if (input.gate.kind === 'internal') {
    return pass('open_visit', { open: true, visitId: openVisit.id });
  }
  const gate = input.rules.gates.find((g) => g.id === openVisit.gateInId)?.name;
  const when = openVisit.timeIn === null ? '' : ` ${formatDateTime(openVisit.timeIn, tz)}`;
  return warn(
    'open_visit',
    {
      code: 'already_inside',
      message: `Уже на территории: въезд${when}${gate ? ` через ${gate}` : ''} не закрыт выездом`,
      params: { visitId: openVisit.id },
    },
    { details: { visitId: openVisit.id } },
  );
};

const gateAdmits: Check = (ctx) => {
  const { input, pass: p } = ctx;
  if (ctx.waivers.waived.has('routing')) return skippedByException(ctx, 'gate_admits', 'routing');
  if (participantAdmitted(input.gate, p.participant)) {
    return pass('gate_admits', { admits: input.gate.admits });
  }
  const suggested = input.rules.gates
    .filter((g) => g.id !== input.gate.id && g.kind === input.gate.kind)
    .filter((g) => participantAdmitted(g, p.participant))
    .map((g) => g.id);
  return fail(
    'gate_admits',
    'wrong_gate',
    {
      code: 'gate_does_not_admit',
      message:
        suggested.length > 0
          ? `${participantLabel(ctx)} — через ${gateNames(ctx, suggested)}`
          : `${participantLabel(ctx)} через этот КПП не проходят`,
      settingLink: `Настройки → КПП → ${input.gate.name} → Кого пропускает`,
    },
    { suggestedGateIds: suggested, details: { admits: input.gate.admits } },
  );
};

const routingIn: Check = (ctx) => {
  const { input, pass: p } = ctx;
  if (ctx.waivers.waived.has('routing')) return skippedByException(ctx, 'routing', 'routing');
  const rules = matchingRoutes(ctx, 'in', input.gate.kind);
  const ruleIds = rules.map((r) => r.id);
  if (input.gate.kind === 'internal') {
    if (p.destinationZoneId === null) return pass('routing', { reason: 'no_destination' });
    const allowed =
      rules.length > 0
        ? rules.map((r) => r.gateId)
        : input.rules.gates.filter((g) => g.zoneId === p.destinationZoneId).map((g) => g.id);
    if (allowed.includes(input.gate.id))
      return pass('routing', { ruleIds, zone: p.destinationZoneId });
    const zone = input.rules.zones.find((z) => z.id === p.destinationZoneId)?.name ?? 'другая зона';
    return fail(
      'routing',
      'wrong_gate',
      {
        code: 'wrong_internal_gate',
        message:
          allowed.length > 0
            ? `Место назначения — ${zone}: проход через ${gateNames(ctx, allowed)}`
            : `Место назначения — ${zone}: этот пост туда не ведёт`,
        settingLink: 'Настройки → Маршруты',
      },
      { suggestedGateIds: allowed, details: { ruleIds, zone: p.destinationZoneId } },
    );
  }
  if (rules.length === 0) return pass('routing', { reason: 'no_rules' });
  const allowed = [...new Set(rules.map((r) => r.gateId))];
  if (allowed.includes(input.gate.id)) return pass('routing', { ruleIds });
  return fail(
    'routing',
    'wrong_gate',
    {
      code: 'wrong_gate',
      message: `${participantLabel(ctx)} — через ${gateNames(ctx, allowed)}`,
      settingLink: 'Настройки → Маршруты',
    },
    { suggestedGateIds: allowed, details: { ruleIds } },
  );
};

/** Выезд — через любой КПП, если правил на выезд нет (Q-9); не тот въездной КПП — только подсказка. */
const routingOut: Check = (ctx) => {
  const { input } = ctx;
  const outRules = matchingRoutes(ctx, 'out', 'perimeter');
  if (outRules.length > 0) {
    const allowed = [...new Set(outRules.map((r) => r.gateId))];
    if (allowed.includes(input.gate.id))
      return pass('routing', { ruleIds: outRules.map((r) => r.id) });
    return fail(
      'routing',
      'wrong_gate',
      {
        code: 'wrong_gate_out',
        message: `Выезд для этого типа — через ${gateNames(ctx, allowed)}`,
        settingLink: 'Настройки → Маршруты',
      },
      { suggestedGateIds: allowed, details: { ruleIds: outRules.map((r) => r.id) } },
    );
  }
  const inRules = matchingRoutes(ctx, 'in', 'perimeter');
  const inGates = [...new Set(inRules.map((r) => r.gateId))];
  if (inGates.length === 0 || inGates.includes(input.gate.id)) {
    return pass('routing', { reason: 'any_gate_out' });
  }
  return warn(
    'routing',
    {
      code: 'other_gate_on_entry',
      message: `Въезд для этого типа — через ${gateNames(ctx, inGates)}; выезд разрешён`,
    },
    { details: { inGateIds: inGates } },
  );
};

const workingHours: Check = (ctx) => {
  const { input, tz } = ctx;
  if (ctx.waivers.waived.has('working_hours')) {
    return skippedByException(ctx, 'working_hours', 'working_hours');
  }
  const hours = input.gate.workingHours ?? input.site.workingHours;
  if (hours === null) return pass('working_hours', { hours: 'always' });
  if (isWithinHours(input.now, hours, tz)) return pass('working_hours');
  const today = describeTodayHours(input.now, hours, tz);
  const mode = input.site.settings.outsideWorkingHours;
  const link = 'Настройки → Объект → Рабочее время';
  if (mode === 'deny') {
    return fail(
      'working_hours',
      'deny',
      {
        code: 'outside_working_hours',
        message: `Вне рабочего времени объекта (${today})`,
        settingLink: link,
      },
      { details: { today, mode } },
    );
  }
  if (mode === 'warn') {
    return warn(
      'working_hours',
      {
        code: 'outside_working_hours',
        message: `Вне рабочего времени объекта (${today}) — впустить можно`,
        settingLink: link,
      },
      { details: { today, mode } },
    );
  }
  return pass('working_hours', { outside: true, mode });
};

const timeWindow: Check = (ctx) => {
  const { input, pass: p, tz } = ctx;
  if (p.participant !== 'vehicle') return skipped('time_window', 'not_applicable');
  if (ctx.waivers.waived.has('time_window')) {
    return skippedByException(ctx, 'time_window', 'time_window');
  }
  const specificity = (policy: (typeof input.rules.timeWindows)[number]): number =>
    (policy.tenantId === null ? 0 : 2) + (policy.categoryIds.length === 0 ? 0 : 1);
  const policy = input.rules.timeWindows
    .filter(
      (w) =>
        (w.tenantId === null || w.tenantId === p.tenantId) &&
        (w.categoryIds.length === 0 ||
          (p.categoryId !== null && w.categoryIds.includes(p.categoryId))),
    )
    .sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id))[0];
  if (!policy) return skipped('time_window', 'not_applicable');
  const link = 'Настройки → Окна прибытия';
  const details: Record<string, unknown> = {
    policyId: policy.id,
    windowFrom: p.windowFrom,
    windowTo: p.windowTo,
    earlyToleranceMin: policy.earlyToleranceMin,
    lateToleranceMin: policy.lateToleranceMin,
  };
  if (p.windowFrom === null) {
    if (!policy.windowRequired) return pass('time_window', { ...details, reason: 'no_window' });
    return fail(
      'time_window',
      'deny',
      {
        code: 'window_missing',
        message: 'В пропуске нет окна прибытия — укажите его в пропуске',
        settingLink: link,
      },
      { details },
    );
  }
  const earliest = p.windowFrom - policy.earlyToleranceMin * MINUTE;
  if (input.now < earliest) {
    const minutes = Math.ceil((earliest - input.now) / MINUTE);
    return fail(
      'time_window',
      'wait',
      {
        code: 'window_too_early',
        message: `Рано: въезд с ${formatTime(earliest, tz)}, ещё ${minutes} мин`,
        params: { earliest, minutes },
        settingLink: link,
      },
      { details: { ...details, earliest, minutes } },
    );
  }
  const windowTo = p.windowTo ?? p.validTo;
  const latest =
    windowTo === null
      ? Number.POSITIVE_INFINITY
      : policy.lateToleranceMin === null
        ? (p.validTo ?? Number.POSITIVE_INFINITY)
        : windowTo + policy.lateToleranceMin * MINUTE;
  if (input.now > latest) {
    const explanation =
      policy.lateToleranceMin === null
        ? 'до конца пропуска'
        : `${formatTime(windowTo ?? latest, tz)} + ${policy.lateToleranceMin} мин`;
    const reason: Reason = {
      code: 'window_too_late',
      message: `Опоздание: окно закрыто в ${formatTime(latest, tz)} (${explanation})`,
      params: { latest },
      settingLink: link,
    };
    if (policy.onViolation === 'hard') {
      return fail('time_window', 'deny', reason, {
        secondary: ['request_window'],
        details: { ...details, latest },
      });
    }
    return warn('time_window', reason, { details: { ...details, latest } });
  }
  return pass('time_window', { ...details, earliest, latest });
};

const dockRequired: Check = (ctx) => {
  const { input, pass: p, tenant, category } = ctx;
  const lines: string[] = [];
  if (p.dockId !== null) {
    const dock = input.rules.docks.find((d) => d.id === p.dockId);
    lines.push(`Док №${dock?.number ?? '?'}`);
  }
  if (p.participant !== 'vehicle' || !tenant?.trucksDockRequired || !category?.dockEligible) {
    return { ...skipped('dock_required', 'not_applicable'), infoLines: lines };
  }
  if (p.dockId !== null)
    return { ...pass('dock_required', { dockId: p.dockId }), infoLines: lines };
  return warn(
    'dock_required',
    {
      code: 'dock_missing',
      message: `Док не указан — ${tenant.name}: грузовые только к докам`,
      settingLink: `Арендаторы → ${tenant.name} → Грузовые только к докам`,
    },
    { infoLines: ['Док не указан'] },
  );
};

const quota: Check = (ctx) => {
  const { input, pass: p, tenant, category, tz } = ctx;
  if (!tenant) return skipped('quota', 'not_applicable');
  const target = p.participant === 'pedestrian' ? 'pedestrian' : { categoryId: category?.id ?? '' };
  const quotas = applicableQuotas(input.rules.quotas, tenant.id, target, input.now, tz);
  const waived = ctx.waivers.waived.has('quota');
  const states: QuotaState[] = quotas.map((q) => {
    const occupied = input.state.occupancy.find((o) => o.quotaId === q.id)?.occupied ?? 0;
    return {
      quotaId: q.id,
      name: q.name,
      tenantName: tenant.name,
      occupied,
      capacity: capacityOf(q, input.rules.docks),
      enforcement: q.enforcement,
      wouldBe: waived ? occupied : occupied + 1,
    };
  });
  if (waived) return { ...skippedByException(ctx, 'quota', 'quota'), quotaStates: states };
  if (quotas.length === 0) return pass('quota', { reason: 'no_quota' });

  let worst: Outcome | null = null;
  const rank = (o: Outcome): number =>
    o.severity ? SEVERITY_RANK[o.severity] : o.reason ? 0.5 : 0;
  const details = states.map((s) => ({
    quotaId: s.quotaId,
    occupied: s.occupied,
    capacity: s.capacity,
    wouldBe: s.wouldBe,
    enforcement: s.enforcement,
  }));
  for (const [index, q] of quotas.entries()) {
    const s = states[index] as QuotaState;
    const link = `Настройки → Лимиты → ${tenant.name} → ${q.name}`;
    const basis = q.basis ?? undefined;
    const label = `${tenant.name} ${lowerFirst(q.name)} ${s.occupied}/${s.capacity}`;
    let outcome: Outcome;
    if (s.capacity === 0) {
      outcome = fail(
        'quota',
        'deny',
        {
          code: 'quota_zero',
          message: `${tenant.name}: ${lowerFirst(q.name)} — не предусмотрено договором (лимит 0)`,
          params: { quotaId: q.id },
          settingLink: link,
          ...(basis ? { basis } : {}),
        },
        { details: { quotas: details } },
      );
    } else if (s.wouldBe <= s.capacity) {
      outcome = pass('quota', { quotas: details });
    } else if (q.enforcement === 'hard') {
      outcome = fail(
        'quota',
        'wait',
        {
          code: 'quota_full',
          message: `${label} — ждите`,
          params: { quotaId: q.id, occupied: s.occupied, capacity: s.capacity },
          settingLink: link,
          ...(basis ? { basis } : {}),
        },
        { details: { quotas: details } },
      );
    } else if (q.enforcement === 'soft') {
      const overCap = q.overageCap !== null && s.wouldBe > s.capacity + q.overageCap;
      const tariff = q.overageTariffRub ?? 0;
      outcome = overCap
        ? fail(
            'quota',
            'wait',
            {
              code: 'quota_overage_cap',
              message: `${label} — потолок сверхлимита (${q.overageCap}) исчерпан, ждите`,
              params: { quotaId: q.id, occupied: s.occupied, capacity: s.capacity },
              settingLink: link,
              ...(basis ? { basis } : {}),
            },
            { details: { quotas: details } },
          )
        : fail(
            'quota',
            'overage',
            {
              code: 'quota_overage',
              message: `Сверх лимита: ${label}, ${tariff} ₽/сутки`,
              params: {
                quotaId: q.id,
                occupied: s.occupied,
                capacity: s.capacity,
                tariffRub: tariff,
              },
              settingLink: link,
              ...(basis ? { basis } : {}),
            },
            { overage: { quotaId: q.id, tariffRub: tariff }, details: { quotas: details } },
          );
    } else {
      outcome = warn(
        'quota',
        {
          code: 'quota_exceeded_info',
          message: `${label} — лимит информирующий, впустить можно`,
          params: { quotaId: q.id, occupied: s.occupied, capacity: s.capacity },
          settingLink: link,
        },
        { details: { quotas: details } },
      );
    }
    if (worst === null || rank(outcome) > rank(worst)) worst = outcome;
  }
  return { ...(worst as Outcome), quotaStates: states };
};

const pedestrianRule: Check = (ctx) => {
  const { input, pass: p } = ctx;
  if (p.participant !== 'pedestrian') return skipped('pedestrian_rule', 'not_applicable');
  const zone = p.destinationZoneId ?? input.gate.zoneId;
  const rules = input.rules.pedestrianRules.filter((r) => r.tenantId === p.tenantId);
  const rule =
    rules.find((r) => r.zoneId !== null && r.zoneId === zone) ??
    rules.find((r) => r.zoneId === null);
  if (!rule) return pass('pedestrian_rule', { reason: 'no_rule' });
  const parts: string[] = [];
  if (rule.guardText) {
    parts.push(rule.guardText);
  } else {
    if (rule.documentRequired) parts.push('Проверьте документ');
    if (rule.escort === 'always') parts.push('Сопровождение: всегда');
    if (rule.escort === 'if_no_document') parts.push('Без документа — сопровождение');
  }
  if (rule.escortPhone) parts.push(`позвоните ${rule.escortPhone}`);
  return {
    ...pass('pedestrian_rule', {
      ruleId: rule.id,
      documentRequired: rule.documentRequired,
      escort: rule.escort,
    }),
    infoLines: [parts.join(' · ')],
  };
};

function findOverride(
  overrides: readonly ApprovedOverride[],
  p: PassView,
  gateId: string,
  direction: PassageDirection,
  now: Instant,
): ApprovedOverride | undefined {
  return overrides.find(
    (o) =>
      o.gateId === gateId &&
      o.direction === direction &&
      (o.validUntil === null || o.validUntil >= now) &&
      ((o.passId !== null && o.passId === p.id) ||
        (o.plateNorm !== null && p.plateNorm !== null && o.plateNorm === p.plateNorm)),
  );
}

// ---------- сборка ----------

function colorOf(code: VerdictCode): VerdictColor {
  return COLOR[code];
}

function primaryFor(code: VerdictCode, direction: PassageDirection, kind: GateKind): PrimaryAction {
  switch (code) {
    case 'allow':
    case 'allow_overage':
      if (kind === 'internal') return 'passage';
      return direction === 'in' ? 'check_in' : 'check_out';
    case 'wait':
      return 'wait';
    case 'wrong_gate':
      return 'redirect';
    case 'deny':
      return 'refuse';
    case 'no_pass':
      return direction === 'in' ? 'request_pass' : 'check_out_flagged';
  }
}

interface ComposeOptions {
  readonly input: EvaluationInput;
  readonly pass: PassView | null;
  readonly outcomes: readonly Outcome[];
  readonly waivers: Waivers | null;
  readonly override?: ApprovedOverride | undefined;
  readonly forcedCode?: VerdictCode;
  readonly headline?: string;
  readonly candidates?: readonly CandidateView[];
  readonly extraInfo?: readonly string[];
}

function compose(options: ComposeOptions): Verdict {
  const { input, outcomes, waivers } = options;
  const trace: TraceEntry[] = outcomes.map((o) => o.trace);
  let worst: Severity = 'allow';
  for (const o of outcomes) {
    if (o.severity && SEVERITY_RANK[o.severity] > SEVERITY_RANK[worst]) worst = o.severity;
  }
  const fails = outcomes
    .filter((o) => o.severity && o.reason)
    .sort((a, b) => SEVERITY_RANK[b.severity ?? 'allow'] - SEVERITY_RANK[a.severity ?? 'allow']);
  const warns = outcomes.filter((o) => !o.severity && o.reason);
  const reasons: Reason[] = [...fails, ...warns].flatMap((o) => (o.reason ? [o.reason] : []));

  let code: VerdictCode =
    options.forcedCode ??
    (worst === 'deny'
      ? 'deny'
      : worst === 'wrong_gate'
        ? 'wrong_gate'
        : worst === 'wait'
          ? 'wait'
          : worst === 'overage'
            ? 'allow_overage'
            : 'allow');

  let appliedOverrideId: string | undefined;
  if (options.override && !options.forcedCode) {
    if (code !== 'allow') {
      appliedOverrideId = options.override.id;
      trace.push({
        check: 'override',
        result: 'pass',
        details: { overrideId: options.override.id, validUntil: options.override.validUntil },
      });
      reasons.unshift({
        code: 'override_approved',
        message: 'Исключение одобрено администратором',
        params: { overrideId: options.override.id },
      });
      code = 'allow';
    } else {
      trace.push({
        check: 'override',
        result: 'skipped',
        skippedBy: { reason: 'not_applicable' },
        details: { overrideId: options.override.id },
      });
    }
  }

  const quotaStates = outcomes.flatMap((o) => o.quotaStates ?? []);
  const infoLines = [
    ...(options.extraInfo ?? []),
    ...outcomes.flatMap((o) => o.infoLines ?? []),
    ...(waivers?.applied ?? []).map((e) => `Исключение: ${e.guardText ?? e.name}`),
  ];
  const flags = [...new Set(outcomes.flatMap((o) => o.flags ?? []))];
  const secondary = new Set<SecondaryAction>(outcomes.flatMap((o) => o.secondary ?? []));
  if (
    input.direction === 'in' &&
    (code === 'wait' || code === 'wrong_gate' || code === 'deny') &&
    !options.forcedCode
  ) {
    secondary.add('override_request');
  }
  const overage = outcomes.find((o) => o.overage)?.overage;

  // Зелёная карточка: короткий заголовок без глагола — действие называет кнопка «Впустить»;
  // предупреждения идут второй строкой (RULES_ENGINE §2).
  const headline =
    options.headline ??
    (appliedOverrideId || fails.length > 0 ? reasons[0]?.message : undefined) ??
    allowHeadline(input, quotaStates);
  return {
    code,
    color: colorOf(code),
    headline,
    reasons,
    trace,
    primaryAction: primaryFor(code, input.direction, input.gate.kind),
    secondaryActions: [...secondary],
    suggestedGateIds: [...new Set(outcomes.flatMap((o) => o.suggestedGateIds ?? []))],
    quotaStates,
    infoLines,
    flags,
    ...(overage && code === 'allow_overage' ? { overage } : {}),
    appliedExceptionIds: (waivers?.applied ?? []).map((e) => e.id),
    ...(appliedOverrideId ? { appliedOverrideId } : {}),
    candidates: options.candidates ?? [],
    passId: options.pass?.id ?? null,
    engineVersion: ENGINE_VERSION,
  };
}

function allowHeadline(input: EvaluationInput, quotaStates: readonly QuotaState[]): string {
  if (input.gate.kind === 'internal') return 'Проход разрешён';
  if (input.direction === 'out') return 'Выезд разрешён';
  const tightest = [...quotaStates].sort(
    (a, b) => a.capacity - a.occupied - (b.capacity - b.occupied),
  )[0];
  if (tightest) return `${tightest.name} ${tightest.occupied}/${tightest.capacity}`;
  return 'Пропуск действует';
}

function candidateView(input: EvaluationInput, p: PassView): CandidateView {
  return {
    passId: p.id,
    tenantId: p.tenantId,
    tenantName: input.rules.tenants.find((t) => t.id === p.tenantId)?.name ?? '',
    plateNorm: p.plateNorm,
    personName: p.personName,
  };
}

function noPass(
  input: EvaluationInput,
  headline: string,
  candidates: readonly PassView[],
  extra: {
    readonly secondary?: readonly SecondaryAction[];
    readonly infoLines?: readonly string[];
  } = {},
): Verdict {
  const views = candidates.map((p) => candidateView(input, p));
  const trace: TraceEntry = {
    check: 'pass_found',
    result: 'fail',
    severity: 'info',
    details: { candidates: views.length },
  };
  return compose({
    input,
    pass: null,
    outcomes: [
      {
        trace,
        ...(extra.secondary ? { secondary: extra.secondary } : {}),
        ...(extra.infoLines ? { infoLines: extra.infoLines } : {}),
      },
    ],
    waivers: null,
    forcedCode: 'no_pass',
    headline,
    candidates: views,
  });
}

function describeCandidates(input: EvaluationInput, passes: readonly PassView[]): string {
  return passes
    .slice(0, 5)
    .map((p) => {
      const tenant = input.rules.tenants.find((t) => t.id === p.tenantId)?.name ?? '';
      return `${p.plateNorm ?? p.personName ?? p.id} (${tenant})`;
    })
    .join(', ');
}

/** Пропуск, по которому идут проверки, или готовый вердикт «пропуска нет». */
function resolveSubject(
  input: EvaluationInput,
): { pass: PassView; openVisit: VisitView | null; pastVisits: readonly VisitView[] } | Verdict {
  const { subject } = input;
  if (subject.kind === 'pass') {
    return {
      pass: subject.pass,
      openVisit: subject.openVisit ?? null,
      pastVisits: subject.pastVisits ?? [],
    };
  }
  if (subject.kind === 'plate') {
    const openVisit = subject.openVisits.find(
      (v) => v.timeOut === null && v.plateNorm === subject.plateNorm,
    );
    const passFromVisit =
      openVisit?.passId == null
        ? undefined
        : subject.candidates.find((p) => p.id === openVisit.passId);
    if (openVisit && passFromVisit) {
      return { pass: passFromVisit, openVisit, pastVisits: [] };
    }
    const resolved = resolveCandidates(subject, input.now);
    if (resolved.kind === 'one') {
      const own = openVisit && openVisit.passId === resolved.pass.id ? openVisit : null;
      return { pass: resolved.pass, openVisit: own, pastVisits: [] };
    }
    if (resolved.kind === 'choose') {
      return noPass(
        input,
        `Номер ${subject.plateNorm} у нескольких арендаторов — к кому едет?`,
        resolved.passes,
        { secondary: ['choose_tenant'] },
      );
    }
    if (input.direction === 'out') {
      return noPass(
        input,
        `Пропуск не найден: ${subject.plateNorm} — выпустите с отметкой, укажите причину`,
        resolved.similar,
        {
          secondary: ['check_out_flagged'],
          infoLines:
            resolved.similar.length > 0
              ? [`Похожие: ${describeCandidates(input, resolved.similar)}`]
              : [],
        },
      );
    }
    return noPass(input, `Пропуска нет: ${subject.plateNorm}`, resolved.similar, {
      infoLines:
        resolved.similar.length > 0
          ? [`Похожие: ${describeCandidates(input, resolved.similar)}`]
          : [],
    });
  }
  const resolved = resolvePedestrian(subject, input.now);
  if (resolved.kind === 'one') {
    const openVisit =
      (subject.openVisits ?? []).find((v) => v.timeOut === null && v.passId === resolved.pass.id) ??
      null;
    return { pass: resolved.pass, openVisit, pastVisits: [] };
  }
  if (resolved.kind === 'choose') {
    return noPass(
      input,
      `Найдено несколько: «${subject.nameQuery}» — выберите пешехода`,
      resolved.passes,
      {
        secondary: ['choose_tenant'],
        infoLines: [`Найдены: ${describeCandidates(input, resolved.passes)}`],
      },
    );
  }
  return noPass(input, `Пешеход не найден: «${subject.nameQuery}»`, []);
}

/** Выезд через КПП периметра: открытый визит → выпускать; нет визита → выезд с отметкой. */
function evaluateOut(ctx: Ctx): Verdict {
  const { input, pass: p, openVisit, tz } = ctx;
  const outcomes: Outcome[] = [pass('pass_found', { passId: p.id })];
  const flags: VisitFlag[] = [];
  const info: string[] = [];
  if (p.validTo !== null && p.validTo < input.now) {
    flags.push('after_expiry');
    info.push(`Пропуск закончился ${formatDateTime(p.validTo, tz)} — пребывание после окончания`);
  }
  let forced: VerdictCode | undefined;
  let headline: string | undefined;
  if (openVisit) {
    outcomes.push({
      ...pass('open_visit', { visitId: openVisit.id, timeIn: openVisit.timeIn }),
      flags,
      infoLines: info,
    });
  } else {
    forced = 'no_pass';
    headline = 'Въезд не отмечен — выпустите с отметкой, укажите причину';
    outcomes.push({
      trace: { check: 'open_visit', result: 'fail', severity: 'info', details: { open: false } },
      flags: [...flags, 'no_checkin'],
      infoLines: info,
      secondary: ['check_out_flagged'],
    });
  }
  const notOnExit: CheckKind[] = [
    'pass_status',
    'tenant_status',
    'contract',
    'pass_validity',
    'single_used',
    'working_hours',
    'time_window',
    'dock_required',
    'quota',
    'pedestrian_rule',
  ];
  outcomes.push(blacklistWarnOnly(ctx));
  outcomes.push(
    participantAdmitted(input.gate, p.participant)
      ? pass('gate_admits', { admits: input.gate.admits })
      : warn('gate_admits', {
          code: 'gate_does_not_admit_out',
          message: `${participantLabel(ctx)} через этот КПП обычно не проходят — выпустить можно`,
        }),
  );
  outcomes.push(routingOut(ctx));
  for (const check of notOnExit) outcomes.push(skipped(check, 'direction_out'));
  const override = findOverride(input.overrides, p, input.gate.id, 'out', input.now);
  return compose({
    input,
    pass: p,
    outcomes,
    waivers: ctx.waivers,
    override,
    ...(forced ? { forcedCode: forced } : {}),
    ...(headline ? { headline } : {}),
  });
}

/** Въезд через КПП периметра и проход через внутренний пост. */
function evaluateIn(ctx: Ctx): Verdict {
  const { input, pass: p } = ctx;
  const internal = input.gate.kind === 'internal';
  const skipInternal =
    (check: CheckKind): Check =>
    () =>
      skipped(check, 'internal_gate');
  const checks: Check[] = [
    () => pass('pass_found', { passId: p.id }),
    passStatus,
    blacklist,
    tenantStatus,
    contract,
    passValidity,
    singleUsed,
    alreadyInside,
    gateAdmits,
    routingIn,
    internal ? skipInternal('working_hours') : workingHours,
    internal ? skipInternal('time_window') : timeWindow,
    internal ? skipInternal('dock_required') : dockRequired,
    internal ? skipInternal('quota') : quota,
    pedestrianRule,
  ];
  const outcomes = checks.map((check) => check(ctx));
  const override = findOverride(input.overrides, p, input.gate.id, input.direction, input.now);
  return compose({ input, pass: p, outcomes, waivers: ctx.waivers, override });
}

/** Вердикт по пропуску (или номеру) на КПП в момент `input.now`. Детерминирован. */
export function evaluate(input: EvaluationInput): Verdict {
  const resolved = resolveSubject(input);
  if ('code' in resolved) return resolved;
  const { pass: p, openVisit, pastVisits } = resolved;
  const ctx: Ctx = {
    input,
    pass: p,
    tenant: input.rules.tenants.find((t) => t.id === p.tenantId),
    category:
      p.categoryId === null ? undefined : input.rules.categories.find((c) => c.id === p.categoryId),
    openVisit,
    pastVisits,
    waivers: collectWaivers(p, input.rules.exceptions, input.now),
    tz: input.site.timezone,
  };
  if (input.direction === 'out' && input.gate.kind === 'perimeter') return evaluateOut(ctx);
  return evaluateIn(ctx);
}

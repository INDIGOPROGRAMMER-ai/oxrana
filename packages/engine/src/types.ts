/**
 * Типы движка (docs/RULES_ENGINE.md §1–2). Движок не зависит от `@oxrana/contracts`, поэтому
 * перечисления продублированы строковыми литералами; совпадение со списками contracts проверяет
 * тест `packages/db/test/ruleset.test.ts`.
 */

/** Момент времени: миллисекунды с эпохи (UTC). Движок сам время не читает — оно приходит параметром. */
export type Instant = number;

export type Participant = 'vehicle' | 'pedestrian';
export type PassageDirection = 'in' | 'out';
export type RuleDirection = 'in' | 'out' | 'both';
export type GateKind = 'perimeter' | 'internal';
export type GateAdmits = 'vehicles_and_pedestrians' | 'vehicles' | 'pedestrians';
export type TenantStatus =
  | 'active'
  | 'blocked_new_passes'
  | 'blocked_entry'
  | 'blocked_full'
  | 'archived';
export type PassType = 'single' | 'multi' | 'permanent';
export type PassStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'used';
export type QuotaCounting = 'on_site' | 'active_passes' | 'per_day';
export type QuotaEnforcement = 'hard' | 'soft' | 'warn';
export type WindowViolationMode = 'hard' | 'warn';
export type PedestrianEscort = 'none' | 'if_no_document' | 'always';
export type OutsideWorkingHoursMode = 'deny' | 'warn' | 'allow';
/** Какие проверки снимает исключение (GLOSSARY «Снимаемые проверки»). */
export type Waiver = 'inspection' | 'quota' | 'time_window' | 'working_hours' | 'routing';
export type VisitFlag =
  | 'no_checkin'
  | 'after_expiry'
  | 'over_stay'
  | 'offline_over_quota'
  | 'undone';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** Интервалы «ЧЧ:ММ» по дням недели в поясе объекта; пустой список — выходной. */
export type WorkingHours = Record<Weekday, [string, string][]>;

/** Настройки объекта, которые нужны движку (подмножество `SiteSettings`). */
export interface SiteSettingsView {
  readonly outsideWorkingHours: OutsideWorkingHoursMode;
  /** «Возврат в течение X минут» для разового (Q-22); `null` — выключено. */
  readonly singleReturnWindowMin: number | null;
  readonly overrideValidMin: number;
}

export interface SiteView {
  readonly id: string;
  readonly name: string;
  /** IANA, например `Asia/Yekaterinburg`. Все локальные вычисления — в нём. */
  readonly timezone: string;
  /** `null` — круглосуточно. */
  readonly workingHours: WorkingHours | null;
  readonly settings: SiteSettingsView;
}

export interface GateView {
  readonly id: string;
  readonly name: string;
  readonly kind: GateKind;
  readonly admits: GateAdmits;
  /** Для внутреннего поста: в какую зону ведёт. */
  readonly zoneId: string | null;
  readonly direction: RuleDirection;
  /** Своё рабочее время КПП; `null` — как у объекта. */
  readonly workingHours: WorkingHours | null;
}

export interface ZoneView {
  readonly id: string;
  readonly name: string;
}

export interface CategoryView {
  readonly id: string;
  readonly presetCode: string | null;
  readonly name: string;
  readonly dockEligible: boolean;
}

export interface DockView {
  readonly id: string;
  readonly number: string;
  readonly zoneId: string | null;
  /** Арендатор, за которым док закреплён сейчас; `null` — свободен. */
  readonly tenantId: string | null;
  readonly countsInQuota: boolean;
}

export interface TenantView {
  readonly id: string;
  /** Короткое название — в текстах причин. */
  readonly name: string;
  readonly status: TenantStatus;
  readonly isOperator: boolean;
  readonly trucksDockRequired: boolean;
  /** Окончание действующего договора, местная дата `YYYY-MM-DD`; `null` — без срока или договора нет. */
  readonly contractValidTo: string | null;
}

export interface QuotaView {
  readonly id: string;
  readonly tenantId: string;
  readonly participant: Participant;
  /** Набор типов лимита (ADR-012); для пешеходного лимита пуст. */
  readonly categoryIds: readonly string[];
  readonly name: string;
  /** `0` — не предусмотрено договором. */
  readonly capacity: number;
  /** `capacity` = число доков арендатора с `countsInQuota`. */
  readonly capacityFromDocks: boolean;
  readonly counting: QuotaCounting;
  readonly enforcement: QuotaEnforcement;
  /** Тариф мягкого лимита, ₽ за сутки. */
  readonly overageTariffRub: number | null;
  /** Потолок сверхлимита для мягкого лимита; выше — `wait`. */
  readonly overageCap: number | null;
  /** Действует только в эти часы; `null` — всегда. */
  readonly schedule: WorkingHours | null;
  readonly validFrom: Instant;
  readonly validTo: Instant | null;
  /** Пункт договора — основание (`basis` в причинах и trace). */
  readonly basis: string | null;
}

export interface RoutingRuleView {
  readonly id: string;
  /** `null` — правило объекта; правило арендатора приоритетнее. */
  readonly tenantId: string | null;
  readonly participant: Participant;
  /** `null` — любой тип (и для пешеходов). */
  readonly categoryId: string | null;
  /** Для внутренних постов: «в офисное здание → внутренний пост». */
  readonly destinationZoneId: string | null;
  readonly gateId: string;
  readonly direction: RuleDirection;
  readonly priority: number;
}

export interface TimeWindowPolicyView {
  readonly id: string;
  readonly tenantId: string | null;
  /** Пусто — ко всем типам. */
  readonly categoryIds: readonly string[];
  readonly windowRequired: boolean;
  readonly earlyToleranceMin: number;
  /** `null` — до конца пропуска. */
  readonly lateToleranceMin: number | null;
  readonly onViolation: WindowViolationMode;
}

export type ExceptionMatch =
  | { readonly plates: readonly string[] }
  | { readonly categoryIds: readonly string[] }
  | { readonly tenant: true }
  | { readonly passIds: readonly string[] };

export interface ExceptionView {
  readonly id: string;
  readonly tenantId: string | null;
  readonly name: string;
  readonly match: ExceptionMatch;
  readonly waives: readonly Waiver[];
  readonly validFrom: Instant;
  readonly validTo: Instant | null;
  readonly guardText: string | null;
  readonly basis: string | null;
}

export interface PedestrianRuleView {
  readonly id: string;
  readonly tenantId: string;
  /** `null` — везде у арендатора. */
  readonly zoneId: string | null;
  readonly documentRequired: boolean;
  readonly escort: PedestrianEscort;
  readonly escortPhone: string | null;
  readonly guardText: string | null;
}

export interface BlacklistEntryView {
  readonly id: string;
  readonly plateNorm: string | null;
  readonly personName: string | null;
  readonly reason: string;
  readonly validTo: Instant | null;
}

/** Срез правил объекта: все записи действующие и уже отфильтрованные по объекту. */
export interface RuleSet {
  readonly gates: readonly GateView[];
  readonly zones: readonly ZoneView[];
  readonly categories: readonly CategoryView[];
  readonly docks: readonly DockView[];
  readonly tenants: readonly TenantView[];
  readonly quotas: readonly QuotaView[];
  readonly routing: readonly RoutingRuleView[];
  readonly timeWindows: readonly TimeWindowPolicyView[];
  readonly exceptions: readonly ExceptionView[];
  readonly pedestrianRules: readonly PedestrianRuleView[];
  readonly blacklist: readonly BlacklistEntryView[];
}

export interface PassView {
  readonly id: string;
  readonly tenantId: string;
  readonly passType: PassType;
  readonly participant: Participant;
  readonly status: PassStatus;
  readonly plateNorm: string | null;
  readonly categoryId: string | null;
  readonly personName: string | null;
  readonly destinationZoneId: string | null;
  readonly dockId: string | null;
  readonly validFrom: Instant | null;
  /** `null` — только у постоянного. */
  readonly validTo: Instant | null;
  readonly windowFrom: Instant | null;
  readonly windowTo: Instant | null;
}

export interface VisitView {
  readonly id: string;
  readonly passId: string | null;
  readonly tenantId: string;
  readonly participant: Participant;
  readonly categoryId: string | null;
  readonly plateNorm: string | null;
  readonly gateInId: string | null;
  readonly timeIn: Instant | null;
  readonly timeOut: Instant | null;
  /** Въехал по исключению, снимающему лимит, — место не занимает. */
  readonly exceptionWaivesQuota: boolean;
}

export type Subject =
  | {
      readonly kind: 'pass';
      readonly pass: PassView;
      /** Открытый визит по этому пропуску, если машина (или пешеход) уже на территории. */
      readonly openVisit?: VisitView | null;
      /** Закрытые визиты по пропуску — для проверки «разовый использован». */
      readonly pastVisits?: readonly VisitView[];
    }
  | {
      /** Пропуск не выбран: номер с камеры или из поиска. */
      readonly kind: 'plate';
      readonly plateNorm: string;
      readonly candidates: readonly PassView[];
      readonly openVisits: readonly VisitView[];
    }
  | {
      readonly kind: 'pedestrian_lookup';
      readonly nameQuery: string;
      readonly candidates: readonly PassView[];
      readonly openVisits?: readonly VisitView[];
    };

export interface LiveState {
  /** Открытые визиты, попавшие в лимит (без визитов по исключению «вне лимита»). */
  readonly occupancy: readonly { readonly quotaId: string; readonly occupied: number }[];
  /** FIFO-очередь у ворот по лимиту. */
  readonly queue: readonly { readonly quotaId: string; readonly passIds: readonly string[] }[];
  /** Когда снято; офлайн-пост показывает возраст. */
  readonly asOf: Instant;
}

export interface ApprovedOverride {
  readonly id: string;
  readonly passId: string | null;
  readonly plateNorm: string | null;
  readonly gateId: string;
  readonly direction: PassageDirection;
  /** Одобрение действует до; `null` — без срока. */
  readonly validUntil: Instant | null;
}

export interface EvaluationInput {
  readonly now: Instant;
  readonly site: SiteView;
  readonly gate: GateView;
  readonly direction: PassageDirection;
  readonly subject: Subject;
  readonly rules: RuleSet;
  readonly state: LiveState;
  readonly overrides: readonly ApprovedOverride[];
}

// ---------- Выход ----------

export type VerdictCode = 'allow' | 'allow_overage' | 'wait' | 'wrong_gate' | 'deny' | 'no_pass';
export type VerdictColor = 'green' | 'orange' | 'yellow' | 'blue' | 'red';

export type PrimaryAction =
  | 'check_in'
  | 'check_out'
  | 'check_out_flagged'
  | 'passage'
  | 'wait'
  | 'redirect'
  | 'refuse'
  | 'request_pass'
  | 'none';

export type SecondaryAction =
  | 'override_request'
  | 'request_window'
  | 'check_out_flagged'
  | 'choose_tenant'
  | 'request_pass';

export type CheckKind =
  | 'pass_found'
  | 'pass_status'
  | 'blacklist'
  | 'tenant_status'
  | 'contract'
  | 'pass_validity'
  | 'single_used'
  | 'open_visit'
  | 'gate_admits'
  | 'routing'
  | 'working_hours'
  | 'time_window'
  | 'dock_required'
  | 'quota'
  | 'pedestrian_rule'
  | 'override';

export type CheckResultKind = 'pass' | 'fail' | 'warn' | 'skipped';
export type Severity = 'allow' | 'overage' | 'wait' | 'wrong_gate' | 'deny';
export type SkipReason = 'not_applicable' | 'direction_out' | 'internal_gate';

export interface Reason {
  readonly code: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly settingLink?: string;
  readonly basis?: string;
}

export interface TraceEntry {
  readonly check: CheckKind;
  readonly result: CheckResultKind;
  readonly severity?: 'deny' | 'wrong_gate' | 'wait' | 'overage' | 'info';
  readonly skippedBy?: { readonly exceptionId: string } | { readonly reason: SkipReason };
  readonly details?: Readonly<Record<string, unknown>>;
  readonly settingLink?: string;
  readonly basis?: string;
}

export interface QuotaState {
  readonly quotaId: string;
  readonly name: string;
  readonly tenantName: string;
  readonly occupied: number;
  readonly capacity: number;
  readonly enforcement: QuotaEnforcement;
  /** Сколько станет, если впустить. */
  readonly wouldBe: number;
}

export interface CandidateView {
  readonly passId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly plateNorm: string | null;
  readonly personName: string | null;
}

export interface Verdict {
  readonly code: VerdictCode;
  readonly color: VerdictColor;
  /** Одна фраза для охраны: «Арендатор грузовые 25/25 — ждите». */
  readonly headline: string;
  /** Все причины; первая = headline. */
  readonly reasons: readonly Reason[];
  /** Каждая проверка в порядке выполнения. */
  readonly trace: readonly TraceEntry[];
  readonly primaryAction: PrimaryAction;
  readonly secondaryActions: readonly SecondaryAction[];
  /** Куда направить при `wrong_gate`. */
  readonly suggestedGateIds: readonly string[];
  readonly quotaStates: readonly QuotaState[];
  /** «Док №12», «Проверьте документ · …», «Исключение: служебный автобус». */
  readonly infoLines: readonly string[];
  /** Что записать в `visit.flags` при въезде или выезде. */
  readonly flags: readonly VisitFlag[];
  readonly overage?: { readonly quotaId: string; readonly tariffRub: number };
  readonly appliedExceptionIds: readonly string[];
  readonly appliedOverrideId?: string;
  /** Кандидаты при «к кому едет?» и при похожих номерах. */
  readonly candidates: readonly CandidateView[];
  /** Пропуск, по которому принят вердикт (после разрешения номера). */
  readonly passId: string | null;
  readonly engineVersion: string;
}

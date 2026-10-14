import { z } from 'zod';

/**
 * Перечисления, которые хранятся в БД как `text` + `check` (DATA_MODEL, соглашения). Список — здесь,
 * миграция строится из него; тест `packages/db/test/enums.integration.test.ts` сверяет `check` в БД
 * с этими zod-схемами. Добавить значение = поправить список + сгенерировать миграцию.
 */

// 2.1 Объект и инфраструктура
export const ZONE_KINDS = ['building', 'yard', 'parking', 'dock_area', 'office', 'other'] as const;
export const ZoneKindSchema = z.enum(ZONE_KINDS);
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** Вид КПП: периметр открывает и закрывает визит, внутренний пост только отмечает проход (A4). */
export const GATE_KINDS = ['perimeter', 'internal'] as const;
export const GateKindSchema = z.enum(GATE_KINDS);
export type GateKind = (typeof GATE_KINDS)[number];

/** «Кого пропускает» КПП (ADR-012). */
export const GATE_ADMITS = ['vehicles_and_pedestrians', 'vehicles', 'pedestrians'] as const;
export const GateAdmitsSchema = z.enum(GATE_ADMITS);
export type GateAdmits = (typeof GATE_ADMITS)[number];

/** Направление, которое обслуживает КПП, правило маршрута или устройство. */
export const DIRECTIONS = ['in', 'out', 'both'] as const;
export const DirectionSchema = z.enum(DIRECTIONS);
export type Direction = (typeof DIRECTIONS)[number];

/** Направление одного проезда или прохода. */
export const PASSAGE_DIRECTIONS = ['in', 'out'] as const;
export const PassageDirectionSchema = z.enum(PASSAGE_DIRECTIONS);
export type PassageDirection = (typeof PASSAGE_DIRECTIONS)[number];

export const DOCK_KINDS = ['leveller', 'ground_gate', 'other'] as const;
export const DockKindSchema = z.enum(DOCK_KINDS);
export type DockKind = (typeof DOCK_KINDS)[number];

// 2.3 Арендаторы и договоры
/**
 * Статус арендатора. Блокировка (Q-73): `blocked_new_passes` — нельзя оформлять новые пропуска;
 * `blocked_entry` — нельзя въезжать (пропуска оформлять можно); `blocked_full` — и то и другое.
 * Выезд разрешён при любом статусе.
 */
export const TENANT_STATUSES = [
  'active',
  'blocked_new_passes',
  'blocked_entry',
  'blocked_full',
  'archived',
] as const;
export const TenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Для чего хранится файл (`stored_files.kind`). */
export const STORED_FILE_KINDS = ['contract'] as const;
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number];

export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated'] as const;
export const ContractStatusSchema = z.enum(CONTRACT_STATUSES);
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Сопровождение пешехода (A3): нет · если нет документа · всегда. */
export const PEDESTRIAN_ESCORTS = ['none', 'if_no_document', 'always'] as const;
export const PedestrianEscortSchema = z.enum(PEDESTRIAN_ESCORTS);
export type PedestrianEscort = (typeof PEDESTRIAN_ESCORTS)[number];

// 2.4 Правила
export const PARTICIPANTS = ['vehicle', 'pedestrian'] as const;
export const ParticipantSchema = z.enum(PARTICIPANTS);
export type Participant = (typeof PARTICIPANTS)[number];

export const QUOTA_COUNTINGS = ['on_site', 'active_passes', 'per_day'] as const;
export const QuotaCountingSchema = z.enum(QUOTA_COUNTINGS);
export type QuotaCounting = (typeof QUOTA_COUNTINGS)[number];

/** Режим лимита: жёсткий · мягкий (сверхлимит с тарифом) · информирующий. */
export const QUOTA_ENFORCEMENTS = ['hard', 'soft', 'warn'] as const;
export const QuotaEnforcementSchema = z.enum(QUOTA_ENFORCEMENTS);
export type QuotaEnforcement = (typeof QUOTA_ENFORCEMENTS)[number];

/** Что делать при нарушении окна прибытия. */
export const WINDOW_VIOLATION_MODES = ['hard', 'warn'] as const;
export const WindowViolationModeSchema = z.enum(WINDOW_VIOLATION_MODES);
export type WindowViolationMode = (typeof WINDOW_VIOLATION_MODES)[number];

/** Какие проверки снимает исключение (RULES_ENGINE §5). */
export const EXCEPTION_WAIVES = [
  'inspection',
  'quota',
  'time_window',
  'working_hours',
  'routing',
] as const;
export const ExceptionWaiveSchema = z.enum(EXCEPTION_WAIVES);
export type ExceptionWaive = (typeof EXCEPTION_WAIVES)[number];

export const APPROVAL_CREATOR_KINDS = ['tenant', 'gate', 'admin'] as const;
export const ApprovalCreatorKindSchema = z.enum(APPROVAL_CREATOR_KINDS);
export type ApprovalCreatorKind = (typeof APPROVAL_CREATOR_KINDS)[number];

export const APPROVAL_MODES = ['allow', 'on_request', 'deny'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_TIMEOUT_ACTIONS = ['reject', 'escalate'] as const;
export const ApprovalTimeoutActionSchema = z.enum(APPROVAL_TIMEOUT_ACTIONS);
export type ApprovalTimeoutAction = (typeof APPROVAL_TIMEOUT_ACTIONS)[number];

// 2.5 Пропуска
/** Разовый · многоразовый · постоянный (GLOSSARY: «временный» не используется). */
export const PASS_TYPES = ['single', 'multi', 'permanent'] as const;
export const PassTypeSchema = z.enum(PASS_TYPES);
export type PassType = (typeof PASS_TYPES)[number];

export const PASS_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'used',
] as const;
export const PassStatusSchema = z.enum(PASS_STATUSES);
export type PassStatus = (typeof PASS_STATUSES)[number];

/**
 * Этап жизни пропуска для правки (ADR-023): до въезда — правится почти всё; после въезда (визит
 * открыт) — только комментарий и «действует до»; после выезда или использования — только просмотр.
 */
export const PASS_PHASES = ['before', 'inside', 'locked'] as const;
export const PassPhaseSchema = z.enum(PASS_PHASES);
export type PassPhase = (typeof PASS_PHASES)[number];

/** Откуда создан пропуск (`passes.created_via`). */
export const PASS_SOURCES = ['web', 'pwa', 'bot', 'api', 'gate', 'import'] as const;
export const PassSourceSchema = z.enum(PASS_SOURCES);
export type PassSource = (typeof PASS_SOURCES)[number];

export const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const ChangeRequestStatusSchema = z.enum(CHANGE_REQUEST_STATUSES);
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

// 2.6 Визиты и журнал КПП
export const VISIT_METHODS = ['button', 'qr', 'lpr', 'auto', 'sync'] as const;
export const VisitMethodSchema = z.enum(VISIT_METHODS);
export type VisitMethod = (typeof VISIT_METHODS)[number];

export const VISIT_FLAGS = [
  'no_checkin',
  'after_expiry',
  'over_stay',
  'offline_over_quota',
  'undone',
  /** Офлайн-въезд по пропуску, который за это время отменили (ADR-005). */
  'pass_cancelled_meanwhile',
] as const;
export const VisitFlagSchema = z.enum(VISIT_FLAGS);
export type VisitFlag = (typeof VISIT_FLAGS)[number];

export const VERDICT_CODES = [
  'allow',
  'allow_overage',
  'wait',
  'wrong_gate',
  'deny',
  'no_pass',
] as const;
export const VerdictCodeSchema = z.enum(VERDICT_CODES);
export type VerdictCode = (typeof VERDICT_CODES)[number];

export const GATE_ACTIONS = [
  'check_in',
  'check_out',
  'refuse',
  'redirect',
  'request',
  'override_request',
  'none',
  'undo',
  /** Проход через внутренний пост (A4): визит не меняется. */
  'passage',
] as const;
export const GateActionSchema = z.enum(GATE_ACTIONS);
export type GateAction = (typeof GATE_ACTIONS)[number];

/** Действия поста с идемпотентным id (ADR-005): онлайн и из офлайн-очереди — один путь. */
export const GATE_ACTION_TYPES = [
  'check_in',
  'check_out',
  'refuse',
  'redirect',
  'undo',
  'passage',
] as const;
export const GateActionTypeSchema = z.enum(GATE_ACTION_TYPES);
export type GateActionType = (typeof GATE_ACTION_TYPES)[number];

/**
 * Итог действия поста (`gate_actions.outcome`): применено · слито с уже сделанным (визит уже
 * открыт или закрыт с другого КПП) · не выполнено (вердикт не разрешил, окно отмены прошло).
 */
export const GATE_ACTION_OUTCOMES = ['applied', 'merged', 'rejected'] as const;
export const GateActionOutcomeSchema = z.enum(GATE_ACTION_OUTCOMES);
export type GateActionOutcome = (typeof GATE_ACTION_OUTCOMES)[number];

export const QUEUE_LEAVE_REASONS = ['entered', 'cancelled', 'timeout', 'redirected'] as const;
export const QueueLeaveReasonSchema = z.enum(QUEUE_LEAVE_REASONS);
export type QueueLeaveReason = (typeof QUEUE_LEAVE_REASONS)[number];

export const GATE_REQUEST_STATUSES = [
  'open',
  'approved',
  'rejected',
  'timeout',
  'cancelled',
] as const;
export const GateRequestStatusSchema = z.enum(GATE_REQUEST_STATUSES);
export type GateRequestStatus = (typeof GATE_REQUEST_STATUSES)[number];

export const OVERRIDE_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'used'] as const;
export const OverrideStatusSchema = z.enum(OVERRIDE_STATUSES);
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];

/** Кто одобрил запрос исключения: администратор или PIN старшего смены на посту (A11). */
export const OVERRIDE_VIA = ['admin', 'senior_pin'] as const;
export const OverrideViaSchema = z.enum(OVERRIDE_VIA);
export type OverrideVia = (typeof OVERRIDE_VIA)[number];

// 2.7 Деньги и нарушения
export const VIOLATION_STATUSES = ['draft', 'signed', 'disputed', 'cancelled'] as const;
export const ViolationStatusSchema = z.enum(VIOLATION_STATUSES);
export type ViolationStatus = (typeof VIOLATION_STATUSES)[number];

// 2.8 Люди, роли, учётки КПП
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = (typeof USER_STATUSES)[number];

/** Назначение одноразовой ссылки установки пароля: владелец при чистом старте · восстановление и сброс. */
export const PASSWORD_RESET_PURPOSES = ['setup', 'reset'] as const;
export const PasswordResetPurposeSchema = z.enum(PASSWORD_RESET_PURPOSES);
export type PasswordResetPurpose = (typeof PASSWORD_RESET_PURPOSES)[number];

export const GATE_ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export const GateAccountStatusSchema = z.enum(GATE_ACCOUNT_STATUSES);
export type GateAccountStatus = (typeof GATE_ACCOUNT_STATUSES)[number];

/** Устройство учётки КПП: экран поста или агент КПП (раздел D). */
export const GATE_DEVICE_KINDS = ['post', 'agent'] as const;
export const GateDeviceKindSchema = z.enum(GATE_DEVICE_KINDS);
export type GateDeviceKind = (typeof GATE_DEVICE_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['email', 'push', 'telegram'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Виды уведомлений кабинета (ADR-023). Каналы доставки — `notifications.channel`. */
export const NOTIFICATION_KINDS = [
  'pass_approved',
  'pass_approved_changed',
  'pass_rejected',
  'change_request_approved',
  'change_request_rejected',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** Канал «колокольчик в кабинете». */
export const IN_APP_CHANNEL = 'in_app';

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

// 2.9 Оборудование
export const HARDWARE_DEVICE_KINDS = [
  'lpr_camera',
  'barrier',
  'qr_scanner',
  'acs_controller',
  'post_pc',
] as const;
export const HardwareDeviceKindSchema = z.enum(HARDWARE_DEVICE_KINDS);
export type HardwareDeviceKind = (typeof HARDWARE_DEVICE_KINDS)[number];

export const HARDWARE_DEVICE_STATUSES = ['online', 'offline', 'unknown'] as const;
export const HardwareDeviceStatusSchema = z.enum(HARDWARE_DEVICE_STATUSES);
export type HardwareDeviceStatus = (typeof HARDWARE_DEVICE_STATUSES)[number];

export const HARDWARE_EVENT_TYPES = [
  'plate_recognized',
  'qr_scanned',
  'barrier_state',
  'heartbeat',
  'acs_pass',
] as const;
export const HardwareEventTypeSchema = z.enum(HARDWARE_EVENT_TYPES);
export type HardwareEventType = (typeof HARDWARE_EVENT_TYPES)[number];

export const BARRIER_COMMAND_TYPES = ['open', 'close', 'test'] as const;
export const BarrierCommandTypeSchema = z.enum(BARRIER_COMMAND_TYPES);
export type BarrierCommandType = (typeof BARRIER_COMMAND_TYPES)[number];

export const BARRIER_COMMAND_CAUSES = [
  'check_in',
  'check_out',
  'override',
  'manual_test',
  'auto_pass',
] as const;
export const BarrierCommandCauseSchema = z.enum(BARRIER_COMMAND_CAUSES);
export type BarrierCommandCause = (typeof BARRIER_COMMAND_CAUSES)[number];

export const BARRIER_COMMAND_STATUSES = ['queued', 'sent', 'done', 'failed', 'timeout'] as const;
export const BarrierCommandStatusSchema = z.enum(BARRIER_COMMAND_STATUSES);
export type BarrierCommandStatus = (typeof BARRIER_COMMAND_STATUSES)[number];

// 2.10 Аудит
export const AUDIT_ACTOR_TYPES = ['user', 'gate_account', 'system', 'agent'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

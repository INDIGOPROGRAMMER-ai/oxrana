import { z } from 'zod';

/**
 * Перечисления, которые хранятся в БД как `text` + `check` (DATA_MODEL, соглашения). Список — здесь,
 * миграция строится из него; тест `packages/db/test/enums.integration.test.ts` сверяет `check` в БД
 * с этими zod-схемами. Добавить значение = поправить список + сгенерировать миграцию.
 */

// 2.1 Объект и инфраструктура
export const ZONE_KINDS = ['building', 'yard', 'parking', 'dock_area', 'office', 'other'] as const;
export const ZoneKindSchema = z.enum(ZONE_KINDS);

/** Вид КПП: периметр открывает и закрывает визит, внутренний пост только отмечает проход (A4). */
export const GATE_KINDS = ['perimeter', 'internal'] as const;
export const GateKindSchema = z.enum(GATE_KINDS);

/** «Кого пропускает» КПП (ADR-012). */
export const GATE_ADMITS = ['vehicles_and_pedestrians', 'vehicles', 'pedestrians'] as const;
export const GateAdmitsSchema = z.enum(GATE_ADMITS);

/** Направление, которое обслуживает КПП, правило маршрута или устройство. */
export const DIRECTIONS = ['in', 'out', 'both'] as const;
export const DirectionSchema = z.enum(DIRECTIONS);

/** Направление одного проезда или прохода. */
export const PASSAGE_DIRECTIONS = ['in', 'out'] as const;
export const PassageDirectionSchema = z.enum(PASSAGE_DIRECTIONS);

export const DOCK_KINDS = ['leveller', 'ground_gate', 'other'] as const;
export const DockKindSchema = z.enum(DOCK_KINDS);

// 2.3 Арендаторы и договоры
export const TENANT_STATUSES = [
  'active',
  'blocked_new_passes',
  'blocked_entry',
  'archived',
] as const;
export const TenantStatusSchema = z.enum(TENANT_STATUSES);

export const CONTRACT_STATUSES = ['draft', 'active', 'expired', 'terminated'] as const;
export const ContractStatusSchema = z.enum(CONTRACT_STATUSES);

/** Сопровождение пешехода (A3): нет · если нет документа · всегда. */
export const PEDESTRIAN_ESCORTS = ['none', 'if_no_document', 'always'] as const;
export const PedestrianEscortSchema = z.enum(PEDESTRIAN_ESCORTS);

// 2.4 Правила
export const PARTICIPANTS = ['vehicle', 'pedestrian'] as const;
export const ParticipantSchema = z.enum(PARTICIPANTS);

export const QUOTA_COUNTINGS = ['on_site', 'active_passes', 'per_day'] as const;
export const QuotaCountingSchema = z.enum(QUOTA_COUNTINGS);

/** Режим лимита: жёсткий · мягкий (сверхлимит с тарифом) · информирующий. */
export const QUOTA_ENFORCEMENTS = ['hard', 'soft', 'warn'] as const;
export const QuotaEnforcementSchema = z.enum(QUOTA_ENFORCEMENTS);

/** Что делать при нарушении окна прибытия. */
export const WINDOW_VIOLATION_MODES = ['hard', 'warn'] as const;
export const WindowViolationModeSchema = z.enum(WINDOW_VIOLATION_MODES);

/** Какие проверки снимает исключение (RULES_ENGINE §5). */
export const EXCEPTION_WAIVES = [
  'inspection',
  'quota',
  'time_window',
  'working_hours',
  'routing',
] as const;
export const ExceptionWaiveSchema = z.enum(EXCEPTION_WAIVES);

export const APPROVAL_CREATOR_KINDS = ['tenant', 'gate', 'admin'] as const;
export const ApprovalCreatorKindSchema = z.enum(APPROVAL_CREATOR_KINDS);

export const APPROVAL_MODES = ['allow', 'on_request', 'deny'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);

export const APPROVAL_TIMEOUT_ACTIONS = ['reject', 'escalate'] as const;
export const ApprovalTimeoutActionSchema = z.enum(APPROVAL_TIMEOUT_ACTIONS);

// 2.5 Пропуска
/** Разовый · многоразовый · постоянный (GLOSSARY: «временный» не используется). */
export const PASS_TYPES = ['single', 'multi', 'permanent'] as const;
export const PassTypeSchema = z.enum(PASS_TYPES);

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

/** Откуда создан пропуск (`passes.created_via`). */
export const PASS_SOURCES = ['web', 'pwa', 'bot', 'api', 'gate', 'import'] as const;
export const PassSourceSchema = z.enum(PASS_SOURCES);

export const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const ChangeRequestStatusSchema = z.enum(CHANGE_REQUEST_STATUSES);

// 2.6 Визиты и журнал КПП
export const VISIT_METHODS = ['button', 'qr', 'lpr', 'auto', 'sync'] as const;
export const VisitMethodSchema = z.enum(VISIT_METHODS);

export const VISIT_FLAGS = [
  'no_checkin',
  'after_expiry',
  'over_stay',
  'offline_over_quota',
  'undone',
] as const;
export const VisitFlagSchema = z.enum(VISIT_FLAGS);

export const VERDICT_CODES = [
  'allow',
  'allow_overage',
  'wait',
  'wrong_gate',
  'deny',
  'no_pass',
] as const;
export const VerdictCodeSchema = z.enum(VERDICT_CODES);

export const GATE_ACTIONS = [
  'check_in',
  'check_out',
  'refuse',
  'redirect',
  'request',
  'override_request',
  'none',
  'undo',
] as const;
export const GateActionSchema = z.enum(GATE_ACTIONS);

export const QUEUE_LEAVE_REASONS = ['entered', 'cancelled', 'timeout', 'redirected'] as const;
export const QueueLeaveReasonSchema = z.enum(QUEUE_LEAVE_REASONS);

export const GATE_REQUEST_STATUSES = [
  'open',
  'approved',
  'rejected',
  'timeout',
  'cancelled',
] as const;
export const GateRequestStatusSchema = z.enum(GATE_REQUEST_STATUSES);

export const OVERRIDE_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'used'] as const;
export const OverrideStatusSchema = z.enum(OVERRIDE_STATUSES);

/** Кто одобрил запрос исключения: администратор или PIN старшего смены на посту (A11). */
export const OVERRIDE_VIA = ['admin', 'senior_pin'] as const;
export const OverrideViaSchema = z.enum(OVERRIDE_VIA);

// 2.7 Деньги и нарушения
export const VIOLATION_STATUSES = ['draft', 'signed', 'disputed', 'cancelled'] as const;
export const ViolationStatusSchema = z.enum(VIOLATION_STATUSES);

// 2.8 Люди, роли, учётки КПП
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);

export const GATE_ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export const GateAccountStatusSchema = z.enum(GATE_ACCOUNT_STATUSES);

/** Устройство учётки КПП: экран поста или агент КПП (раздел D). */
export const GATE_DEVICE_KINDS = ['post', 'agent'] as const;
export const GateDeviceKindSchema = z.enum(GATE_DEVICE_KINDS);

export const NOTIFICATION_CHANNELS = ['email', 'push', 'telegram'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

// 2.9 Оборудование
export const HARDWARE_DEVICE_KINDS = [
  'lpr_camera',
  'barrier',
  'qr_scanner',
  'acs_controller',
  'post_pc',
] as const;
export const HardwareDeviceKindSchema = z.enum(HARDWARE_DEVICE_KINDS);

export const HARDWARE_DEVICE_STATUSES = ['online', 'offline', 'unknown'] as const;
export const HardwareDeviceStatusSchema = z.enum(HARDWARE_DEVICE_STATUSES);

export const HARDWARE_EVENT_TYPES = [
  'plate_recognized',
  'qr_scanned',
  'barrier_state',
  'heartbeat',
  'acs_pass',
] as const;
export const HardwareEventTypeSchema = z.enum(HARDWARE_EVENT_TYPES);

export const BARRIER_COMMAND_TYPES = ['open', 'close', 'test'] as const;
export const BarrierCommandTypeSchema = z.enum(BARRIER_COMMAND_TYPES);

export const BARRIER_COMMAND_CAUSES = [
  'check_in',
  'check_out',
  'override',
  'manual_test',
  'auto_pass',
] as const;
export const BarrierCommandCauseSchema = z.enum(BARRIER_COMMAND_CAUSES);

export const BARRIER_COMMAND_STATUSES = ['queued', 'sent', 'done', 'failed', 'timeout'] as const;
export const BarrierCommandStatusSchema = z.enum(BARRIER_COMMAND_STATUSES);

// 2.10 Аудит
export const AUDIT_ACTOR_TYPES = ['user', 'gate_account', 'system', 'agent'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

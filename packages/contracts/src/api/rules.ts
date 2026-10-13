import { z } from 'zod';
import {
  type ApprovalCreatorKind,
  ApprovalCreatorKindSchema,
  type ApprovalMode,
  ApprovalModeSchema,
  ApprovalTimeoutActionSchema,
  DirectionSchema,
  ExceptionWaiveSchema,
  ParticipantSchema,
  type PassType,
  PassTypeSchema,
  QuotaCountingSchema,
  QuotaEnforcementSchema,
  WindowViolationModeSchema,
} from '../enums';
import { ExceptionMatchSchema, WorkingHoursSchema } from '../settings';
import { IdSchema, InstantInputSchema, InstantSchema, TextSchema } from './common';

// Модуль rules (ARCHITECTURE §2): лимиты, маршруты, окна, исключения, политики согласования.
// Квота ≠ маршрут ≠ место назначения (CLAUDE.md п. 2) — три независимых справочника.

export const QuotaViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema,
  participant: ParticipantSchema,
  name: z.string(),
  /** Набор типов лимита (ADR-012). */
  categoryIds: z.array(IdSchema),
  capacity: z.int(),
  capacityFromDocks: z.boolean(),
  counting: QuotaCountingSchema,
  enforcement: QuotaEnforcementSchema,
  overageTariffRub: z.number().nullable(),
  overageCap: z.int().nullable(),
  schedule: WorkingHoursSchema.nullable(),
  basisClauseId: IdSchema.nullable(),
  validFrom: InstantSchema,
  validTo: InstantSchema.nullable(),
});
export const QuotaListQuerySchema = z.strictObject({ tenantId: IdSchema.optional() });
export const QuotaCreateSchema = z.strictObject({
  tenantId: IdSchema,
  participant: ParticipantSchema.optional(),
  /** Не указано — собирается из названий типов: «Малотоннажный + фура» (ADR-012). */
  name: TextSchema(100).optional(),
  categoryIds: z.array(IdSchema).optional(),
  /** Не указывается при `capacityFromDocks` — считается по докам арендатора. */
  capacity: z
    .int('Число мест — целое число.')
    .min(0, 'Число мест не может быть отрицательным.')
    .optional(),
  capacityFromDocks: z.boolean().optional(),
  counting: QuotaCountingSchema.optional(),
  enforcement: QuotaEnforcementSchema.optional(),
  overageTariffRub: z
    .number('Тариф — число.')
    .min(0, 'Тариф не может быть отрицательным.')
    .nullable()
    .optional(),
  overageCap: z
    .int('Потолок — целое число.')
    .min(0, 'Потолок не может быть отрицательным.')
    .nullable()
    .optional(),
  schedule: WorkingHoursSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
  validFrom: InstantInputSchema.optional(),
  validTo: InstantInputSchema.nullable().optional(),
});
export const QuotaPatchSchema = QuotaCreateSchema.omit({
  tenantId: true,
  participant: true,
}).partial();

export const RoutingRuleViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema.nullable(),
  participant: ParticipantSchema,
  categoryId: IdSchema.nullable(),
  destinationZoneId: IdSchema.nullable(),
  gateId: IdSchema,
  direction: DirectionSchema,
  priority: z.int(),
});
export const RoutingRuleCreateSchema = z.strictObject({
  tenantId: IdSchema.nullable().optional(),
  participant: ParticipantSchema,
  categoryId: IdSchema.nullable().optional(),
  destinationZoneId: IdSchema.nullable().optional(),
  gateId: IdSchema,
  direction: DirectionSchema.optional(),
  priority: z.int().optional(),
});
export const RoutingRulePatchSchema = RoutingRuleCreateSchema.partial();

export const TimeWindowPolicyViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema.nullable(),
  categoryIds: z.array(IdSchema),
  windowRequired: z.boolean(),
  earlyToleranceMin: z.int(),
  lateToleranceMin: z.int().nullable(),
  onViolation: WindowViolationModeSchema,
});
export const TimeWindowPolicyCreateSchema = z.strictObject({
  tenantId: IdSchema.nullable().optional(),
  /** Пусто — ко всем типам. */
  categoryIds: z.array(IdSchema).optional(),
  windowRequired: z.boolean().optional(),
  earlyToleranceMin: z
    .int('Допуск «раньше» — целое число минут.')
    .min(0, 'Допуск «раньше» не может быть отрицательным.')
    .optional(),
  lateToleranceMin: z
    .int('Допуск «опоздание» — целое число минут.')
    .min(0, 'Допуск «опоздание» не может быть отрицательным.')
    .nullable()
    .optional(),
  onViolation: WindowViolationModeSchema.optional(),
});
export const TimeWindowPolicyPatchSchema = TimeWindowPolicyCreateSchema.partial();

export const ExceptionViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema.nullable(),
  name: z.string(),
  match: ExceptionMatchSchema,
  waives: z.array(ExceptionWaiveSchema),
  guardText: z.string().nullable(),
  basis: z.string().nullable(),
  basisClauseId: IdSchema.nullable(),
  validFrom: InstantSchema,
  validTo: InstantSchema.nullable(),
});
export const ExceptionListQuerySchema = z.strictObject({ tenantId: IdSchema.optional() });
export const ExceptionCreateSchema = z.strictObject({
  tenantId: IdSchema.nullable().optional(),
  name: TextSchema(200),
  match: ExceptionMatchSchema,
  waives: z.array(ExceptionWaiveSchema).min(1, 'Отметьте, какие проверки снимает исключение'),
  guardText: z.string().trim().max(300).nullable().optional(),
  basis: z.string().trim().max(500).nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
  validFrom: InstantInputSchema.optional(),
  validTo: InstantInputSchema.nullable().optional(),
});
export const ExceptionPatchSchema = ExceptionCreateSchema.partial();

export const ApprovalPolicyViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema.nullable(),
  creatorKind: ApprovalCreatorKindSchema,
  passType: PassTypeSchema,
  mode: ApprovalModeSchema,
  commentRequired: z.boolean(),
  escalationHours: z.int().nullable(),
  onTimeout: ApprovalTimeoutActionSchema.nullable(),
});
export const ApprovalPolicyCreateSchema = z.strictObject({
  tenantId: IdSchema.nullable().optional(),
  creatorKind: ApprovalCreatorKindSchema,
  passType: PassTypeSchema,
  mode: ApprovalModeSchema,
  commentRequired: z.boolean().optional(),
  escalationHours: z
    .int('Эскалация — целое число часов.')
    .min(1, 'Эскалация — не меньше 1 часа.')
    .nullable()
    .optional(),
  onTimeout: ApprovalTimeoutActionSchema.nullable().optional(),
});
export const ApprovalPolicyPatchSchema = ApprovalPolicyCreateSchema.omit({
  tenantId: true,
  creatorKind: true,
  passType: true,
}).partial();

/**
 * Политики согласования нового объекта (Q-55): все 9 сочетаний «кто создаёт × тип пропуска»
 * заполняются при создании объекта. Разовый от арендатора — без согласования, многоразовый и
 * постоянный от арендатора — на согласование и с обязательным комментарием (`08_`); администратор — без согласования; охрана
 * оформляет только разовый по запросу «без пропуска», и он идёт на согласование.
 */
export const DEFAULT_APPROVAL_POLICIES: readonly {
  readonly creatorKind: ApprovalCreatorKind;
  readonly passType: PassType;
  readonly mode: ApprovalMode;
  /** «Комментарий обязателен» (`08_`: для многоразовых и постоянных от арендатора — «для чего и зачем»). */
  readonly commentRequired?: boolean;
}[] = [
  { creatorKind: 'tenant', passType: 'single', mode: 'allow' },
  { creatorKind: 'tenant', passType: 'multi', mode: 'on_request', commentRequired: true },
  { creatorKind: 'tenant', passType: 'permanent', mode: 'on_request', commentRequired: true },
  { creatorKind: 'admin', passType: 'single', mode: 'allow' },
  { creatorKind: 'admin', passType: 'multi', mode: 'allow' },
  { creatorKind: 'admin', passType: 'permanent', mode: 'allow' },
  { creatorKind: 'gate', passType: 'single', mode: 'on_request' },
  { creatorKind: 'gate', passType: 'multi', mode: 'deny' },
  { creatorKind: 'gate', passType: 'permanent', mode: 'deny' },
];

/** Незаданное сочетание политики: такие пропуска уходят на согласование (Q-55). */
export const ApprovalPolicyGapSchema = z.object({
  creatorKind: ApprovalCreatorKindSchema,
  passType: PassTypeSchema,
  message: z.string(),
});

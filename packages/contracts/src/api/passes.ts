import { z } from 'zod';
import {
  ApprovalModeSchema,
  ChangeRequestStatusSchema,
  ParticipantSchema,
  PassSourceSchema,
  PassStatusSchema,
  PassTypeSchema,
  QuotaEnforcementSchema,
  VisitFlagSchema,
} from '../enums';
import { IdSchema, InstantInputSchema, InstantSchema, ReasonSchema } from './common';

// Модуль passes (ARCHITECTURE §2, §3.2): пропуска, пакет, заявки на изменение, подсказки формы.

/** Страна номера — подсказка распознавания (`@oxrana/plates`). */
export const PlateCountryHintSchema = z.enum(['RU', 'BY', 'KZ', 'UZ', 'TJ', 'KG', 'AM']);

/** Поля пропуска, общие для создания и правки. Номер — как ввели: сервер нормализует сам (A10). */
const passFields = {
  plate: z.string().max(30).optional(),
  plateCountry: PlateCountryHintSchema.optional(),
  categoryId: IdSchema.nullable().optional(),
  brand: z.string().trim().max(100).nullable().optional(),
  personName: z.string().trim().max(200).nullable().optional(),
  /** Только признак или вид документа, не номер (152-ФЗ). */
  personDocument: z.string().trim().max(100).nullable().optional(),
  driverName: z.string().trim().max(200).nullable().optional(),
  driverPhone: z.string().trim().max(30).nullable().optional(),
  purposeId: IdSchema.nullable().optional(),
  destinationZoneId: IdSchema.nullable().optional(),
  dockId: IdSchema.nullable().optional(),
  validFrom: InstantInputSchema.optional(),
  validTo: InstantInputSchema.nullable().optional(),
  windowFrom: InstantInputSchema.nullable().optional(),
  windowTo: InstantInputSchema.nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
};

/** Строка пакета: пропуск без арендатора (он общий для пакета). */
export const PassDraftSchema = z.strictObject({
  passType: PassTypeSchema,
  participant: ParticipantSchema,
  ...passFields,
});
export type PassDraft = z.infer<typeof PassDraftSchema>;

export const PassCreateSchema = z.strictObject({
  tenantId: IdSchema,
  passType: PassTypeSchema,
  participant: ParticipantSchema,
  ...passFields,
});
export type PassCreate = z.infer<typeof PassCreateSchema>;

/**
 * Правка: только переданные поля (CLAUDE.md п. 5). Тип пропуска, участник и арендатор не меняются.
 * У начавшегося пропуска нужна причина (`reason`) — она попадает в журнал.
 */
export const PassPatchSchema = z.strictObject({ ...passFields, reason: ReasonSchema.optional() });
export type PassPatch = z.infer<typeof PassPatchSchema>;

export const PassWarningSchema = z.object({ code: z.string(), message: z.string() });

export const PassViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema,
  passType: PassTypeSchema,
  participant: ParticipantSchema,
  status: PassStatusSchema,
  plateRaw: z.string().nullable(),
  plateNorm: z.string().nullable(),
  plateCountry: z.string().nullable(),
  categoryId: IdSchema.nullable(),
  brand: z.string().nullable(),
  personName: z.string().nullable(),
  personDocument: z.string().nullable(),
  driverName: z.string().nullable(),
  driverPhone: z.string().nullable(),
  purposeId: IdSchema.nullable(),
  destinationZoneId: IdSchema.nullable(),
  dockId: IdSchema.nullable(),
  validFrom: InstantSchema.nullable(),
  validTo: InstantSchema.nullable(),
  windowFrom: InstantSchema.nullable(),
  windowTo: InstantSchema.nullable(),
  comment: z.string().nullable(),
  createdBy: IdSchema.nullable(),
  createdVia: PassSourceSchema,
  batchId: IdSchema.nullable(),
  approvedAt: InstantSchema.nullable(),
  approvedBy: IdSchema.nullable(),
  /** Комментарий согласующего и «одобрено с изменениями»: что изменил согласующий (видно арендатору). */
  approvalNote: z.string().nullable(),
  approvalChanges: z
    .record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }))
    .nullable(),
  approvalEscalatedAt: InstantSchema.nullable(),
  cancelledReason: z.string().nullable(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
  /** Пропуск уже начался — правка с причиной, у арендатора номер/тип/срок — заявкой (A8). */
  started: z.boolean(),
});
export type PassView = z.infer<typeof PassViewSchema>;

export const PassCreatedSchema = PassViewSchema.extend({
  /** Ссылка на страницу водителя; токен показывается только здесь (в БД — хэш). */
  driverPageUrl: z.string(),
  /** Предупреждения, которые не мешают сохранить: «у другого арендатора тоже есть пропуск на номер». */
  warnings: z.array(PassWarningSchema),
});

export const PassListQuerySchema = z.strictObject({
  tenantId: IdSchema.optional(),
  status: PassStatusSchema.optional(),
  participant: ParticipantSchema.optional(),
  passType: PassTypeSchema.optional(),
  /** Пропуск действует хотя бы часть этих местных суток объекта: с даты… */
  dateFrom: z.iso.date().optional(),
  /** …по дату включительно. */
  dateTo: z.iso.date().optional(),
  /** Цифры или часть номера, часть фамилии. */
  q: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ChangeRequestViewSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  /** {"plateNorm": {"from": …, "to": …}} — только запрошенные поля. */
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
  reason: z.string().nullable(),
  status: ChangeRequestStatusSchema,
  requestedBy: IdSchema,
  decidedBy: IdSchema.nullable(),
  decidedAt: InstantSchema.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: InstantSchema,
});

export const PassPatchResultSchema = z.object({
  pass: PassViewSchema,
  /** Что изменено сразу. */
  applied: z.array(z.string()),
  /** Номер, тип или срок начавшегося согласованного пропуска — заявкой на изменение (A8, сценарий 41). */
  changeRequest: ChangeRequestViewSchema.nullable(),
});

export const CancelPassSchema = z.strictObject({ reason: ReasonSchema });
export const DecisionSchema = z.strictObject({ note: z.string().trim().max(1000).optional() });
export const RejectSchema = z.strictObject({ note: ReasonSchema });

export const ChangeRequestListQuerySchema = z.strictObject({
  status: ChangeRequestStatusSchema.optional(),
});

export const PassBatchSchema = z.strictObject({
  tenantId: IdSchema,
  rows: z.array(PassDraftSchema).min(1).max(500),
  /** Предпросмотр: проверить все строки (и дубли) без сохранения. */
  dryRun: z.boolean().optional(),
});

export const BatchErrorSchema = z.object({
  /** Номер строки с 1, как в Excel. */
  row: z.int(),
  field: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export const PassBatchResultSchema = z.object({
  batchId: IdSchema.nullable(),
  dryRun: z.boolean(),
  total: z.int(),
  created: z.int(),
  /** «Создано 18 из 20» (B3). */
  summary: z.string(),
  errors: z.array(BatchErrorSchema),
  passes: z.array(
    z.object({
      row: z.int(),
      passId: IdSchema.nullable(),
      status: PassStatusSchema,
      warnings: z.array(PassWarningSchema),
    }),
  ),
});

export const PassHintsQuerySchema = z.strictObject({
  participant: ParticipantSchema,
  categoryId: IdSchema.optional(),
  passType: PassTypeSchema.optional(),
  destinationZoneId: IdSchema.optional(),
});

/**
 * Тот же запрос подсказок с номером или именем (проверка по чёрному списку). Номер и имя —
 * персональные данные, поэтому уходят в теле POST, а не в адрес запроса, который попадает в логи.
 */
export const PassHintsRequestSchema = PassHintsQuerySchema.extend({
  plate: z.string().max(30).optional(),
  personName: z.string().max(200).optional(),
});

/** Предупреждение формы до сохранения: `error` не даст сохранить, `warning` — предупреждает. */
export const PassNoticeSchema = z.object({
  code: z.enum(['tenant_blocked', 'tenant_entry_blocked', 'contract_expired', 'blacklisted']),
  severity: z.enum(['error', 'warning']),
  text: z.string(),
});
export type PassNotice = z.infer<typeof PassNoticeSchema>;

/** Подсказки формы до сохранения (CLAUDE.md, правила интерфейса; ARCHITECTURE §3.2). */
export const PassHintsSchema = z.object({
  route: z.object({
    gates: z.array(z.object({ id: IdSchema, name: z.string() })),
    text: z.string(),
  }),
  quotas: z.array(
    z.object({
      quotaId: IdSchema,
      name: z.string(),
      occupied: z.int(),
      capacity: z.int(),
      enforcement: QuotaEnforcementSchema,
      text: z.string(),
    }),
  ),
  approval: z.object({ mode: ApprovalModeSchema, text: z.string() }).nullable(),
  commentRequired: z.boolean(),
  dock: z.object({
    required: z.boolean(),
    docks: z.array(z.object({ id: IdSchema, number: z.string() })),
    text: z.string().nullable(),
  }),
  window: z.object({
    required: z.boolean(),
    earlyToleranceMin: z.int(),
    lateToleranceMin: z.int().nullable(),
  }),
  pedestrianRule: z.string().nullable(),
  /** Типы транспорта, доступные арендатору (лимит 0 — не предусмотрено договором — не показывается). */
  categories: z.array(z.object({ id: IdSchema, name: z.string() })),
  /** Типы пропусков, которые этот пользователь может оформить, и что будет с согласованием. */
  passTypes: z.array(z.object({ passType: PassTypeSchema, mode: ApprovalModeSchema })),
  /** Блокировка арендатора, договор, чёрный список: то, что мешает или предупреждает до сохранения. */
  notices: z.array(PassNoticeSchema),
});

export const PassHistoryEntrySchema = z.object({
  at: InstantSchema,
  action: z.string(),
  actorType: z.string(),
  /** «Иванов И. И.» или «КПП: пост въезда» — кто именно (A9). */
  actorName: z.string().nullable(),
  diff: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
});

export const VisitViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  tenantId: IdSchema,
  passId: IdSchema.nullable(),
  participant: ParticipantSchema,
  categoryId: IdSchema.nullable(),
  plateNorm: z.string().nullable(),
  /** Названия на момент въезда (CLAUDE.md п. 6, сценарий 21). */
  snapshot: z.record(z.string(), z.unknown()),
  gateInId: IdSchema.nullable(),
  timeIn: InstantSchema.nullable(),
  gateOutId: IdSchema.nullable(),
  timeOut: InstantSchema.nullable(),
  overage: z.boolean(),
  flags: z.array(VisitFlagSchema),
});
export const VisitListQuerySchema = z.strictObject({
  tenantId: IdSchema.optional(),
  open: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * «Одобрить с изменениями» (`10_` §6, сценарий 24): согласующий меняет срок, окно, тип, док или
 * комментарий; изменённые поля сохраняются в `approvalChanges` и видны арендатору.
 */
export const PassApproveSchema = z.strictObject({
  note: z.string().trim().max(1000).optional(),
  changes: z
    .strictObject({
      categoryId: IdSchema.nullable().optional(),
      dockId: IdSchema.nullable().optional(),
      destinationZoneId: IdSchema.nullable().optional(),
      validFrom: InstantInputSchema.optional(),
      validTo: InstantInputSchema.nullable().optional(),
      windowFrom: InstantInputSchema.nullable().optional(),
      windowTo: InstantInputSchema.nullable().optional(),
      comment: z.string().trim().max(2000).nullable().optional(),
    })
    .optional(),
});

export const ApprovalListQuerySchema = z.strictObject({
  tenantId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Карточка согласования: все поля будущего пропуска, кто и когда создал (`10_` §6). */
export const ApprovalViewSchema = z.object({
  pass: PassViewSchema,
  tenantName: z.string(),
  createdByName: z.string().nullable(),
});

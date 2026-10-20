import { z } from 'zod';
import {
  ApprovalModeSchema,
  ChangeRequestStatusSchema,
  ParticipantSchema,
  PassPhaseSchema,
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
  /** Что можно править: до въезда — почти всё; после въезда — комментарий и срок; иначе только просмотр. */
  phase: PassPhaseSchema,
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
  /** Порция списка (7b.1): по 50, дальше «Показать ещё»; итог — `total` в ответе. */
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Форматы выгрузки списков (7b.1). */
export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Выгрузка списка пропусков: те же фильтры, что у списка, но все строки, без порций. */
export const PassExportQuerySchema = PassListQuerySchema.omit({ limit: true, offset: true }).extend(
  { format: ExportFormatSchema.default('xlsx') },
);

/** Страница списка пропусков и общий итог по фильтру: «Найдено N» (7b.1). */
export const PassListSchema = z.object({ items: z.array(PassViewSchema), total: z.int() });
export type PassList = z.infer<typeof PassListSchema>;

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
  /** Начало пропуска, если оно позже «сейчас»: запись чёрного списка, которая кончается раньше, не мешает. */
  validFrom: InstantInputSchema.optional(),
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
    /** Политика окон требует окно, а форма — нет: не указанное окно = весь срок пропуска. */
    autoFilled: z.boolean(),
  }),
  pedestrianRule: z.string().nullable(),
  /** Типы транспорта, доступные арендатору (лимит 0 — не предусмотрено договором — не показывается). */
  categories: z.array(z.object({ id: IdSchema, name: z.string() })),
  /** Типы пропусков, которые этот пользователь может оформить, и что будет с согласованием. */
  passTypes: z.array(z.object({ passType: PassTypeSchema, mode: ApprovalModeSchema })),
  /** Блокировка арендатора, договор, чёрный список: то, что мешает или предупреждает до сохранения. */
  notices: z.array(PassNoticeSchema),
});

/** Группы ленты пропуска: «Изменения» (кто что менял и согласовал) и «КПП» (отметки и решения охраны). */
export const PASS_HISTORY_GROUPS = ['changes', 'gate'] as const;
export const PassHistoryGroupSchema = z.enum(PASS_HISTORY_GROUPS);
export type PassHistoryGroup = (typeof PASS_HISTORY_GROUPS)[number];

export const PASS_HISTORY_KINDS = [
  'created',
  'updated',
  'approved',
  'rejected',
  'cancelled',
  'escalated',
  'change_requested',
  'change_approved',
  'change_rejected',
  'check_in',
  'check_out',
  'undo',
  'denied',
  'wrong_gate',
  'wait',
  'redirected',
  'refused',
  'queued',
  'left_queue',
  'passage',
  'override_requested',
  'override_decided',
  'other',
] as const;
export const PassHistoryKindSchema = z.enum(PASS_HISTORY_KINDS);
export type PassHistoryKind = (typeof PASS_HISTORY_KINDS)[number];

/** Одно изменённое поле: человеческое название и значения; время (`time`) — ISO, показывает веб в поясе объекта. */
export const PassHistoryChangeSchema = z.object({
  field: z.string(),
  label: z.string(),
  type: z.enum(['text', 'time']),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

/** Кто: сотрудник (ФИО, роль), учётка поста (название КПП — только администратору) или система. */
export const PassHistoryActorSchema = z.object({
  kind: z.enum(['user', 'gate', 'system']),
  name: z.string(),
  role: z.string().nullable(),
});

/**
 * Строка единой ленты пропуска (7b.3, ADR-023): собирается на сервере из журнала аудита и журналов КПП.
 * Название КПП — снимок на момент события. Поле `staff` получает только администратор объекта.
 */
export const PassHistoryEntrySchema = z.object({
  id: z.string(),
  at: InstantSchema,
  group: PassHistoryGroupSchema,
  kind: PassHistoryKindSchema,
  title: z.string(),
  /** КПП, на котором это произошло. */
  place: z.string().nullable(),
  actor: PassHistoryActorSchema.nullable(),
  reason: z.string().nullable(),
  changes: z.array(PassHistoryChangeSchema),
  notes: z.array(z.string()),
  /** Офлайн-отметка: время на устройстве поста (в `at` — время, записанное в визит). */
  offline: z.boolean(),
  deviceAt: InstantSchema.nullable(),
  /** Служебное: устройство, причины вердикта (trace), данные исключения. Арендатору не отдаётся. */
  staff: z
    .object({
      device: z.string().nullable(),
      details: z.array(z.string()),
    })
    .nullable(),
});
export type PassHistoryEntry = z.infer<typeof PassHistoryEntrySchema>;

export const PassHistoryQuerySchema = z.strictObject({
  group: z.enum(['all', 'changes', 'gate']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const PassHistoryListSchema = z.object({
  /** Новые сверху. */
  items: z.array(PassHistoryEntrySchema),
  /** Строк по фильтру группы (для «Показать ещё»). */
  total: z.int(),
});

/** Находится ли сейчас на территории: «На территории с 14:05 (<КПП>)» / «Последний выезд …». */
export const PassPresenceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('inside'), since: InstantSchema, gate: z.string().nullable() }),
  z.object({ state: z.literal('left'), at: InstantSchema, gate: z.string().nullable() }),
  z.object({ state: z.literal('none') }),
]);

/** Данные карточки пропуска (7b.3): пропуск, арендатор, кто оформил и согласовал, где сейчас. */
export const PassCardSchema = z.object({
  pass: PassViewSchema,
  tenantName: z.string(),
  /** Сотрудник или «Пост <название КПП>» (пропуск оформлен с поста). */
  createdByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  presence: PassPresenceSchema,
  /** Названия справочников по ссылкам пропуска (карточка открывается без контекста компании). */
  names: z.object({
    category: z.string().nullable(),
    dock: z.string().nullable(),
    zone: z.string().nullable(),
    purpose: z.string().nullable(),
  }),
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

/** «Сейчас на территории» (7b.1): открытый визит с тем, что нужно охране и арендатору. */
export const InsideRowSchema = z.object({
  visitId: IdSchema,
  passId: IdSchema.nullable(),
  tenantId: IdSchema,
  tenantName: z.string(),
  participant: ParticipantSchema,
  /** Номер машины как записан в пропуске (или нормализованный) либо фамилия пешехода. */
  title: z.string(),
  categoryName: z.string().nullable(),
  passType: PassTypeSchema.nullable(),
  timeIn: InstantSchema.nullable(),
  gateInName: z.string().nullable(),
  dock: z.string().nullable(),
  zone: z.string().nullable(),
});
export type InsideRow = z.infer<typeof InsideRowSchema>;

export const InsideListSchema = z.object({ items: z.array(InsideRowSchema), total: z.int() });

export const InsideQuerySchema = z.strictObject({
  tenantId: IdSchema.optional(),
  /** Только визиты, занимающие место в этом лимите — число совпадает с виджетом лимитов. */
  quotaId: IdSchema.optional(),
  /** Цифры номера или часть фамилии. */
  q: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const InsideExportQuerySchema = InsideQuerySchema.omit({ limit: true, offset: true }).extend(
  { format: ExportFormatSchema.default('xlsx') },
);

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

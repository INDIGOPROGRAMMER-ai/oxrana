import { z } from 'zod';
import {
  GateActionOutcomeSchema,
  GateActionTypeSchema,
  GateKindSchema,
  GateRequestStatusSchema,
  OverrideStatusSchema,
  ParticipantSchema,
  PassageDirectionSchema,
  QuotaEnforcementSchema,
  VerdictCodeSchema,
  VisitFlagSchema,
} from '../enums';
import {
  IdSchema,
  InstantInputSchema,
  InstantSchema,
  ReasonSchema,
  SiteTimeSchema,
} from './common';
import { PassViewSchema, VisitViewSchema } from './passes';

// Модуль gate (ARCHITECTURE §2, §3.1): вердикт, действия поста, синхронизация офлайна, очередь,
// запросы «без пропуска», снимок для поста. КПП берётся из учётки поста, клиент его не выбирает.

/** Вердикт движка (RULES_ENGINE §2) — как его получает пост. */
export const VerdictSchema = z.object({
  code: VerdictCodeSchema,
  color: z.enum(['green', 'orange', 'yellow', 'blue', 'red']),
  headline: z.string(),
  reasons: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      settingLink: z.string().optional(),
      basis: z.string().optional(),
    }),
  ),
  trace: z.array(z.record(z.string(), z.unknown())),
  primaryAction: z.string(),
  secondaryActions: z.array(z.string()),
  suggestedGateIds: z.array(z.string()),
  quotaStates: z.array(
    z.object({
      quotaId: z.string(),
      name: z.string(),
      tenantName: z.string(),
      occupied: z.int(),
      capacity: z.int(),
      enforcement: QuotaEnforcementSchema,
      wouldBe: z.int(),
    }),
  ),
  infoLines: z.array(z.string()),
  flags: z.array(VisitFlagSchema),
  overage: z.object({ quotaId: z.string(), tariffRub: z.number() }).optional(),
  appliedExceptionIds: z.array(z.string()),
  appliedOverrideId: z.string().optional(),
  candidates: z.array(
    z.object({
      passId: z.string(),
      tenantId: z.string(),
      tenantName: z.string(),
      plateNorm: z.string().nullable(),
      personName: z.string().nullable(),
    }),
  ),
  passId: z.string().nullable(),
  engineVersion: z.string(),
});
export type VerdictView = z.infer<typeof VerdictSchema>;

/** Проверка на посту: по пропуску (QR, выбор из списка), по номеру или по фамилии. */
export const GateCheckSchema = z
  .strictObject({
    direction: PassageDirectionSchema,
    passId: IdSchema.optional(),
    plateQuery: z.string().trim().min(1).max(30).optional(),
    personQuery: z.string().trim().min(2).max(100).optional(),
    clientAt: InstantInputSchema.optional(),
  })
  .refine(
    (v) => [v.passId, v.plateQuery, v.personQuery].filter((x) => x !== undefined).length === 1,
    'Укажите ровно одно: пропуск, номер или фамилию.',
  );

export const GateCheckResultSchema = z.object({
  decisionId: z.int(),
  verdict: VerdictSchema,
  pass: PassViewSchema.nullable(),
  openVisit: VisitViewSchema.nullable(),
  gate: z.object({ id: IdSchema, name: z.string(), kind: GateKindSchema }),
  site: SiteTimeSchema,
});

const actionBase = {
  /** id действия на устройстве — ключ идемпотентности (ADR-005): повтор не выполняется второй раз. */
  id: IdSchema,
  /** Время устройства (офлайн-очередь: когда действие совершено на самом деле). */
  clientAt: InstantInputSchema.optional(),
};

export const GateActionInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...actionBase,
    type: z.literal('check_in'),
    passId: IdSchema,
    method: z.enum(['button', 'qr', 'lpr']).optional(),
  }),
  z.strictObject({
    ...actionBase,
    type: z.literal('check_out'),
    passId: IdSchema.optional(),
    visitId: IdSchema.optional(),
    plateQuery: z.string().trim().min(1).max(30).optional(),
    /** Обязательна, если въезд не отмечен: «выпустить с отметкой» (сценарий 16). */
    reason: ReasonSchema.optional(),
    method: z.enum(['button', 'qr', 'lpr']).optional(),
  }),
  z.strictObject({
    ...actionBase,
    type: z.literal('refuse'),
    direction: PassageDirectionSchema,
    passId: IdSchema.optional(),
    plateQuery: z.string().trim().min(1).max(30).optional(),
    reason: ReasonSchema,
  }),
  z.strictObject({
    ...actionBase,
    type: z.literal('redirect'),
    direction: PassageDirectionSchema,
    passId: IdSchema.optional(),
    plateQuery: z.string().trim().min(1).max(30).optional(),
    targetGateId: IdSchema.optional(),
  }),
  z.strictObject({
    ...actionBase,
    type: z.literal('undo'),
    /** Какое действие отменить: id въезда или выезда этого поста. */
    actionId: IdSchema,
    reason: ReasonSchema.optional(),
  }),
  z.strictObject({
    ...actionBase,
    type: z.literal('passage'),
    passId: IdSchema,
    direction: PassageDirectionSchema.optional(),
  }),
]);
export type GateActionInput = z.infer<typeof GateActionInputSchema>;

export const GateActionResultSchema = z.object({
  actionId: IdSchema,
  type: GateActionTypeSchema,
  outcome: GateActionOutcomeSchema,
  /** Уточнение итога: 'already_open', 'already_closed', код вердикта ('wait', 'deny', …). */
  code: z.string().nullable(),
  /** Одна фраза для экрана: «Въезд отмечен 14:32 (Челябинск, UTC+5)». */
  message: z.string(),
  verdict: VerdictSchema.nullable(),
  decisionId: z.int().nullable(),
  visitId: IdSchema.nullable(),
  passId: IdSchema.nullable(),
  /** Повтор того же id: ответ сохранённый, действие второй раз не выполнялось. */
  replayed: z.boolean(),
});
export type GateActionResult = z.infer<typeof GateActionResultSchema>;

/** Офлайн-очередь поста (ADR-005): действия по порядку `seq`, с вердиктом, который показал кэш. */
export const GateSyncSchema = z.strictObject({
  actions: z
    .array(
      z.strictObject({
        seq: z.int().min(0),
        action: GateActionInputSchema,
        localVerdict: z.strictObject({ code: VerdictCodeSchema, headline: z.string() }).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export const GateSyncResultSchema = z.object({ results: z.array(GateActionResultSchema) });

export const GateRequestCreateSchema = z.strictObject({
  participant: ParticipantSchema,
  plate: z.string().trim().max(30).optional(),
  categoryId: IdSchema.optional(),
  personName: z.string().trim().max(200).optional(),
  /** К кому едет (если водитель назвал). */
  tenantId: IdSchema.optional(),
});

export const GateRequestViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  gateId: IdSchema,
  tenantId: IdSchema.nullable(),
  participant: ParticipantSchema,
  plateRaw: z.string().nullable(),
  plateNorm: z.string().nullable(),
  categoryId: IdSchema.nullable(),
  personName: z.string().nullable(),
  status: GateRequestStatusSchema,
  answeredAt: InstantSchema.nullable(),
  answerNote: z.string().nullable(),
  passId: IdSchema.nullable(),
  expiresAt: InstantSchema,
  createdAt: InstantSchema,
});
export const GateRequestListQuerySchema = z.strictObject({
  status: GateRequestStatusSchema.optional(),
});

/** Ответ арендатора «Оформить» (сценарий 15): разовый пропуск на машину у ворот. */
export const GateRequestApproveSchema = z.strictObject({
  tenantId: IdSchema.optional(),
  categoryId: IdSchema.optional(),
  dockId: IdSchema.optional(),
  validTo: InstantInputSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
});

export const QueueEntrySchema = z.object({
  passId: IdSchema,
  tenantId: IdSchema,
  tenantName: z.string(),
  gateId: IdSchema,
  quotaId: IdSchema,
  quotaName: z.string(),
  position: z.int(),
  queuedAt: InstantSchema,
  notifiedAt: InstantSchema.nullable(),
});
export const QueueViewSchema = z.object({ items: z.array(QueueEntrySchema) });

export const OccupancyViewSchema = z.object({
  site: z.object({ id: IdSchema, name: z.string(), ...SiteTimeSchema.shape }),
  asOf: InstantSchema,
  quotas: z.array(
    z.object({
      quotaId: IdSchema,
      tenantId: IdSchema,
      tenantName: z.string(),
      name: z.string(),
      occupied: z.int(),
      capacity: z.int(),
      enforcement: QuotaEnforcementSchema,
      waiting: z.int(),
    }),
  ),
});
export const OccupancySummarySchema = z.object({ items: z.array(OccupancyViewSchema) });

/** Снимок для поста (ADR-005): правила, пропуска, открытые визиты, очередь — на устройство. */
export const GateSnapshotSchema = z.object({
  asOf: InstantSchema,
  /** С какого события подписываться на SSE после загрузки снимка. */
  lastEventId: z.int(),
  site: z.record(z.string(), z.unknown()),
  gate: z.record(z.string(), z.unknown()),
  rules: z.record(z.string(), z.unknown()),
  passes: z.array(z.record(z.string(), z.unknown())),
  openVisits: z.array(z.record(z.string(), z.unknown())),
  queue: z.array(z.object({ quotaId: IdSchema, passIds: z.array(IdSchema) })),
});

export const GateDecisionViewSchema = z.object({
  id: z.int(),
  gateId: IdSchema,
  at: InstantSchema,
  clientAt: InstantSchema.nullable(),
  direction: PassageDirectionSchema,
  passId: IdSchema.nullable(),
  verdict: VerdictCodeSchema,
  action: z.string().nullable(),
  visitId: IdSchema.nullable(),
  reasons: z.array(z.record(z.string(), z.unknown())),
  /** «Почему?» — полная цепочка проверок (B2). */
  trace: z.array(z.record(z.string(), z.unknown())),
  offline: z.boolean(),
  engineVersion: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
});

export const AuditEntrySchema = z.object({
  id: z.int(),
  at: InstantSchema,
  siteId: IdSchema.nullable(),
  actorType: z.string(),
  actorUserId: IdSchema.nullable(),
  actorGateAccountId: IdSchema.nullable(),
  deviceId: IdSchema.nullable(),
  entity: z.string(),
  entityId: IdSchema,
  action: z.string(),
  diff: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  snapshot: z.record(z.string(), z.unknown()).nullable(),
});
export const AuditQuerySchema = z.strictObject({
  siteId: IdSchema.optional(),
  entity: z.string().max(50).optional(),
  entityId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const GateDecisionQuerySchema = z.strictObject({
  gateId: IdSchema.optional(),
  passId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Запрос исключения с поста (A11, сценарий 42): пост ссылается на решение из журнала КПП —
 * вердикт и причины сервер берёт оттуда, а не из тела запроса.
 */
export const OverrideRequestCreateSchema = z.strictObject({
  decisionId: z.int().positive(),
  reason: ReasonSchema,
});

export const OverrideRequestViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  gateId: IdSchema,
  gateName: z.string(),
  passId: IdSchema.nullable(),
  tenantId: IdSchema.nullable(),
  plateNorm: z.string().nullable(),
  direction: PassageDirectionSchema,
  verdictCode: VerdictCodeSchema,
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  reason: z.string(),
  status: OverrideStatusSchema,
  decidedBy: IdSchema.nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: InstantSchema.nullable(),
  decisionNote: z.string().nullable(),
  validUntil: InstantSchema.nullable(),
  createdAt: InstantSchema,
});

export const OverrideRequestListQuerySchema = z.strictObject({
  status: OverrideStatusSchema.optional(),
});

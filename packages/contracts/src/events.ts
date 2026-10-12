import { z } from 'zod';
import {
  ChangeRequestStatusSchema,
  GateActionSchema,
  GateRequestStatusSchema,
  ParticipantSchema,
  PassStatusSchema,
  PassTypeSchema,
  QueueLeaveReasonSchema,
  VerdictCodeSchema,
  VisitFlagSchema,
} from './enums';

/**
 * Доменные события — transactional outbox `domain_events` (ADR-004). Пишутся в той же транзакции,
 * что и изменение; из них — SSE, уведомления, очередь у ворот. **В `payload` только идентификаторы
 * и короткие метки, без ПДн** (CLAUDE.md, 152-ФЗ): ни номера машины, ни ФИО, ни телефонов —
 * клиент получает событие и перечитывает нужные данные по id со своими правами. Схемы строгие:
 * лишнее поле — ошибка при записи события.
 *
 * `tenantId` в payload — для фильтра SSE: пользователь арендатора получает только события своих
 * арендаторов и события объекта без арендатора (`rules.changed`, `site.*`).
 */
const id = z.uuid();
const fields = z.array(z.string().min(1)).min(1);

export const DOMAIN_EVENT_PAYLOADS = {
  'site.changed': z.strictObject({ siteId: id, fields }),
  'site.timezone_changed': z.strictObject({ siteId: id, from: z.string(), to: z.string() }),
  'tenant.changed': z.strictObject({ tenantId: id, fields }),
  /** Изменились правила объекта: RuleSet перечитывается (кэш API, снимок поста). */
  'rules.changed': z.strictObject({ entity: z.string().min(1), entityId: id }),

  'pass.created': z.strictObject({
    passId: id,
    tenantId: id,
    status: PassStatusSchema,
    passType: PassTypeSchema,
    participant: ParticipantSchema,
  }),
  'pass.updated': z.strictObject({ passId: id, tenantId: id, fields }),
  'pass.status_changed': z.strictObject({
    passId: id,
    tenantId: id,
    from: PassStatusSchema,
    to: PassStatusSchema,
  }),
  'pass.change_requested': z.strictObject({
    changeRequestId: id,
    passId: id,
    tenantId: id,
    fields,
  }),
  'pass.change_decided': z.strictObject({
    changeRequestId: id,
    passId: id,
    tenantId: id,
    status: ChangeRequestStatusSchema,
  }),

  'visit.opened': z.strictObject({
    visitId: id,
    passId: id.nullable(),
    tenantId: id,
    gateId: id,
    participant: ParticipantSchema,
    categoryId: id.nullable(),
    overage: z.boolean(),
    flags: z.array(VisitFlagSchema),
  }),
  'visit.closed': z.strictObject({
    visitId: id,
    passId: id.nullable(),
    tenantId: id,
    gateId: id.nullable(),
    flags: z.array(VisitFlagSchema),
  }),
  'visit.undone': z.strictObject({
    visitId: id,
    passId: id.nullable(),
    tenantId: id,
    gateId: id,
    undone: z.enum(['check_in', 'check_out']),
  }),
  /** Занятость лимита после въезда, выезда или отмены (табло, карточки на посту). */
  'quota.changed': z.strictObject({
    quotaId: id,
    tenantId: id,
    occupied: z.int().min(0),
    capacity: z.int().min(0),
  }),

  'queue.joined': z.strictObject({ passId: id, tenantId: id, gateId: id, quotaId: id }),
  'queue.left': z.strictObject({
    passId: id,
    tenantId: id,
    gateId: id,
    reason: QueueLeaveReasonSchema,
  }),
  /** Место освободилось — только посту, где стоит первый в очереди (B5, сценарий 40). */
  'queue.slot_freed': z.strictObject({ passId: id, tenantId: id, gateId: id, quotaId: id }),

  /** Решение поста без визита: ждать, отказ, направлен на другой КПП, проход внутреннего поста. */
  'gate.decision': z.strictObject({
    decisionId: z.int().positive(),
    gateId: id,
    passId: id.nullable(),
    tenantId: id.nullable(),
    verdict: VerdictCodeSchema,
    action: GateActionSchema,
  }),

  'gate_request.created': z.strictObject({
    gateRequestId: id,
    gateId: id,
    tenantId: id.nullable(),
    participant: ParticipantSchema,
  }),
  'gate_request.answered': z.strictObject({
    gateRequestId: id,
    gateId: id,
    tenantId: id.nullable(),
    status: GateRequestStatusSchema,
    passId: id.nullable(),
  }),
} as const;

export type DomainEventType = keyof typeof DOMAIN_EVENT_PAYLOADS;
export type DomainEventPayload<T extends DomainEventType> = z.infer<
  (typeof DOMAIN_EVENT_PAYLOADS)[T]
>;

export const DOMAIN_EVENT_TYPES = Object.keys(DOMAIN_EVENT_PAYLOADS) as DomainEventType[];

/** Поля, которых не бывает в payload ни при каких условиях (проверяется тестом и при записи). */
export const PII_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'plate',
  'plateRaw',
  'plateNorm',
  'plateQuery',
  'personName',
  'driverName',
  'driverPhone',
  'phone',
  'email',
  'fullName',
  'escortPhone',
]);

/** Событие, как его видит клиент SSE и потребители outbox. */
export const DomainEventSchema = z.object({
  id: z.int().positive(),
  type: z.string(),
  at: z.string(),
  siteId: z.uuid().nullable(),
  aggregate: z.string(),
  aggregateId: z.uuid(),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

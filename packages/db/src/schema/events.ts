import { AUDIT_ACTOR_TYPES, NOTIFICATION_STATUSES } from '@oxrana/contracts';
import { bigint, index, inet, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, enumCheck, id, journalId, organizationIsolation, tstz } from './_helpers';
import { organizationId } from './organization';
import { users } from './people';

// DATA_MODEL §2.10 — аудит, события, уведомления.

/**
 * Аудит каждого изменения (CLAUDE.md п. 6): только insert, роль приложения без UPDATE/DELETE
 * (миграция 0002). Пишется в той же транзакции, что и изменение.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: journalId(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    at: tstz('at').notNull().defaultNow(),
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorUserId: uuid('actor_user_id'),
    actorGateAccountId: uuid('actor_gate_account_id'),
    deviceId: uuid('device_id'),
    requestId: text('request_id'),
    ip: inet('ip'),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** 'create', 'update', 'delete', 'approve', 'reject', 'override', 'login', … */
    action: text('action').notNull(),
    /** {"category_id":{"from":..,"to":..,"fromLabel":"фура","toLabel":"легковой"}}. */
    diff: jsonb('diff'),
    reason: text('reason'),
    snapshot: jsonb('snapshot'),
  },
  (t) => [
    index('audit_log_organization_id_at_idx').on(t.organizationId, t.at.desc()),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    enumCheck('audit_log', t.actorType, AUDIT_ACTOR_TYPES),
    organizationIsolation(),
  ],
);

/**
 * Transactional outbox (ADR-004): единственный источник для SSE, уведомлений и очереди у ворот.
 * Триггер `domain_events_notify` (миграция 0002) делает `pg_notify('site_events', …)`.
 * В `payload` — только id и короткие метки, без ПДн.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: journalId(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    at: tstz('at').notNull().defaultNow(),
    /** 'visit.opened', 'pass.created', 'quota.changed', … (contracts/events.ts). */
    type: text('type').notNull(),
    aggregate: text('aggregate').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (t) => [index('domain_events_site_id_id_idx').on(t.siteId, t.id), organizationIsolation()],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    organizationId: organizationId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull(),
    sentAt: tstz('sent_at'),
    error: text('error'),
    eventId: bigint('event_id', { mode: 'number' }).references(() => domainEvents.id),
    /** Когда пользователь прочитал (колокольчик кабинета, ADR-023); `null` — не прочитано. */
    readAt: tstz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    unique('notifications_event_key').on(t.eventId, t.userId, t.kind, t.channel),
    enumCheck('notifications', t.status, NOTIFICATION_STATUSES),
    organizationIsolation(),
  ],
);

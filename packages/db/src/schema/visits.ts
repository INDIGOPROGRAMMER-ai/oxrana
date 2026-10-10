import {
  GATE_ACTIONS,
  GATE_REQUEST_STATUSES,
  OVERRIDE_STATUSES,
  OVERRIDE_VIA,
  PARTICIPANTS,
  PASSAGE_DIRECTIONS,
  QUEUE_LEAVE_REASONS,
  VERDICT_CODES,
  VISIT_FLAGS,
  VISIT_METHODS,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  enumArrayCheck,
  enumCheck,
  id,
  journalId,
  organizationIsolation,
  timestamps,
  tstz,
} from './_helpers';
import { vehicleCategories } from './catalogs';
import { hardwareEvents } from './hardware';
import { gates, organizationId, siteId } from './organization';
import { passes } from './passes';
import { gateAccounts, gateDevices, users } from './people';
import { exceptions, quotas } from './rules';
import { tenants } from './tenants';

// DATA_MODEL §2.6 — визиты и журнал КПП. Журналы не удаляются (права роли — миграция 0002).

/**
 * Визит = въехал и (ещё не) выехал. Лимиты считаются по открытым визитам (CLAUDE.md п. 3);
 * создаётся только через `checkIn()` (ADR-006).
 */
export const visits = pgTable(
  'visits',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** null — выезд без пропуска. */
    passId: uuid('pass_id').references(() => passes.id),
    participant: text('participant', { enum: PARTICIPANTS }).notNull(),
    categoryId: uuid('category_id').references(() => vehicleCategories.id),
    plateNorm: text('plate_norm'),
    /** Названия на момент события: {"tenant":…,"category":…,"plate":…,"gateIn":…,"dock":…}. */
    snapshot: jsonb('snapshot').notNull(),
    gateInId: uuid('gate_in_id').references(() => gates.id),
    timeIn: tstz('time_in'),
    gateAccountInId: uuid('gate_account_in_id').references(() => gateAccounts.id),
    deviceInId: uuid('device_in_id').references(() => gateDevices.id),
    gateOutId: uuid('gate_out_id').references(() => gates.id),
    timeOut: tstz('time_out'),
    gateAccountOutId: uuid('gate_account_out_id').references(() => gateAccounts.id),
    deviceOutId: uuid('device_out_id').references(() => gateDevices.id),
    methodIn: text('method_in', { enum: VISIT_METHODS }),
    methodOut: text('method_out', { enum: VISIT_METHODS }),
    hardwareEventInId: bigint('hardware_event_in_id', { mode: 'number' }).references(
      (): AnyPgColumn => hardwareEvents.id,
    ),
    hardwareEventOutId: bigint('hardware_event_out_id', { mode: 'number' }).references(
      (): AnyPgColumn => hardwareEvents.id,
    ),
    decisionInId: bigint('decision_in_id', { mode: 'number' }).references(
      (): AnyPgColumn => gateDecisions.id,
    ),
    decisionOutId: bigint('decision_out_id', { mode: 'number' }).references(
      (): AnyPgColumn => gateDecisions.id,
    ),
    overage: boolean('overage').notNull().default(false),
    overageQuotaId: uuid('overage_quota_id').references(() => quotas.id),
    exceptionId: uuid('exception_id').references(() => exceptions.id),
    overrideId: uuid('override_id').references((): AnyPgColumn => overrideRequests.id),
    flags: text('flags', { enum: VISIT_FLAGS }).array().notNull().default(sql`'{}'::text[]`),
    /** Время устройства при офлайн-отметке (ADR-005). */
    clientTimeIn: tstz('client_time_in'),
    clientTimeOut: tstz('client_time_out'),
  },
  (t) => [
    index('visits_open_by_category_idx')
      .on(t.siteId, t.tenantId, t.categoryId)
      .where(sql`${t.timeOut} is null`),
    index('visits_open_by_plate_idx').on(t.siteId, t.plateNorm).where(sql`${t.timeOut} is null`),
    index('visits_pass_id_idx').on(t.passId),
    enumCheck('visits', t.participant, PARTICIPANTS),
    enumCheck('visits', t.methodIn, VISIT_METHODS),
    enumCheck('visits', t.methodOut, VISIT_METHODS),
    enumArrayCheck('visits', t.flags, VISIT_FLAGS),
    organizationIsolation(),
  ],
);

/** Каждый вердикт, включая отказы и «не тот КПП» (B2: объяснимость). */
export const gateDecisions = pgTable(
  'gate_decisions',
  {
    id: journalId(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    at: tstz('at').notNull().defaultNow(),
    clientAt: tstz('client_at'),
    direction: text('direction', { enum: PASSAGE_DIRECTIONS }).notNull(),
    passId: uuid('pass_id').references(() => passes.id),
    plateQuery: text('plate_query'),
    hardwareEventId: bigint('hardware_event_id', { mode: 'number' }).references(
      (): AnyPgColumn => hardwareEvents.id,
    ),
    verdict: text('verdict', { enum: VERDICT_CODES }).notNull(),
    reasons: jsonb('reasons').notNull(),
    trace: jsonb('trace').notNull(),
    engineVersion: text('engine_version').notNull(),
    action: text('action', { enum: GATE_ACTIONS }),
    visitId: uuid('visit_id').references((): AnyPgColumn => visits.id),
    overrideId: uuid('override_id').references((): AnyPgColumn => overrideRequests.id),
    gateAccountId: uuid('gate_account_id').references(() => gateAccounts.id),
    deviceId: uuid('device_id').references(() => gateDevices.id),
    /** Админ в песочнице/при переопределении. */
    userId: uuid('user_id').references(() => users.id),
    offline: boolean('offline').notNull().default(false),
    snapshot: jsonb('snapshot').notNull(),
  },
  (t) => [
    index('gate_decisions_site_id_at_idx').on(t.siteId, t.at.desc()),
    index('gate_decisions_pass_id_idx').on(t.passId),
    enumCheck('gate_decisions', t.direction, PASSAGE_DIRECTIONS),
    enumCheck('gate_decisions', t.verdict, VERDICT_CODES),
    enumCheck('gate_decisions', t.action, GATE_ACTIONS),
    organizationIsolation(),
  ],
);

/** A4: отметки внутренних постов; визит не открывают. */
export const gatePassages = pgTable(
  'gate_passages',
  {
    id: journalId(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    at: tstz('at').notNull(),
    passId: uuid('pass_id').references(() => passes.id),
    direction: text('direction', { enum: PASSAGE_DIRECTIONS }),
    decisionId: bigint('decision_id', { mode: 'number' }).references(() => gateDecisions.id),
    gateAccountId: uuid('gate_account_id').references(() => gateAccounts.id),
    deviceId: uuid('device_id').references(() => gateDevices.id),
    snapshot: jsonb('snapshot').notNull(),
  },
  (t) => [enumCheck('gate_passages', t.direction, PASSAGE_DIRECTIONS), organizationIsolation()],
);

/** B5: очередь у ворот, FIFO по лимиту. */
export const gateQueue = pgTable(
  'gate_queue',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    passId: uuid('pass_id')
      .notNull()
      .references(() => passes.id),
    quotaId: uuid('quota_id')
      .notNull()
      .references(() => quotas.id),
    queuedAt: tstz('queued_at').notNull(),
    notifiedAt: tstz('notified_at'),
    leftAt: tstz('left_at'),
    leftReason: text('left_reason', { enum: QUEUE_LEAVE_REASONS }),
  },
  (t) => [
    uniqueIndex('gate_queue_waiting_pass_key').on(t.passId).where(sql`${t.leftAt} is null`),
    enumCheck('gate_queue', t.leftReason, QUEUE_LEAVE_REASONS),
    organizationIsolation(),
  ],
);

/** Машина или пешеход без пропуска: запрос арендатору с поста. */
export const gateRequests = pgTable(
  'gate_requests',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    participant: text('participant', { enum: PARTICIPANTS }).notNull(),
    plateRaw: text('plate_raw'),
    plateNorm: text('plate_norm'),
    categoryId: uuid('category_id').references(() => vehicleCategories.id),
    personName: text('person_name'),
    status: text('status', { enum: GATE_REQUEST_STATUSES }).notNull(),
    createdByGateAccountId: uuid('created_by_gate_account_id').references(() => gateAccounts.id),
    deviceId: uuid('device_id').references(() => gateDevices.id),
    answeredBy: uuid('answered_by').references(() => users.id),
    answeredAt: tstz('answered_at'),
    answerNote: text('answer_note'),
    /** Созданный по запросу пропуск. */
    passId: uuid('pass_id').references(() => passes.id),
    expiresAt: tstz('expires_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('gate_requests', t.participant, PARTICIPANTS),
    enumCheck('gate_requests', t.status, GATE_REQUEST_STATUSES),
    organizationIsolation(),
  ],
);

/** A11: запрос исключения с поста администратору. */
export const overrideRequests = pgTable(
  'override_requests',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    passId: uuid('pass_id').references(() => passes.id),
    plateNorm: text('plate_norm'),
    direction: text('direction', { enum: PASSAGE_DIRECTIONS }).notNull(),
    /** Что было на карточке. */
    verdictCode: text('verdict_code', { enum: VERDICT_CODES }).notNull(),
    reasons: jsonb('reasons').notNull(),
    /** Причина от поста. */
    reason: text('reason').notNull(),
    status: text('status', { enum: OVERRIDE_STATUSES }).notNull(),
    requestedByGateAccountId: uuid('requested_by_gate_account_id').notNull(),
    deviceId: uuid('device_id').references(() => gateDevices.id),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: tstz('decided_at'),
    decisionNote: text('decision_note'),
    via: text('via', { enum: OVERRIDE_VIA }),
    /** Одобрение действует N минут. */
    validUntil: tstz('valid_until'),
    ...timestamps(),
  },
  (t) => [
    // Имя задано явно: автоматическое длиннее 63 символов.
    foreignKey({
      name: 'override_requests_requested_by_gate_account_id_fk',
      columns: [t.requestedByGateAccountId],
      foreignColumns: [gateAccounts.id],
    }),
    enumCheck('override_requests', t.direction, PASSAGE_DIRECTIONS),
    enumCheck('override_requests', t.verdictCode, VERDICT_CODES),
    enumCheck('override_requests', t.status, OVERRIDE_STATUSES),
    enumCheck('override_requests', t.via, OVERRIDE_VIA),
    organizationIsolation(),
  ],
);

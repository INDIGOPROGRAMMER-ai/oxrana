import {
  BARRIER_COMMAND_CAUSES,
  BARRIER_COMMAND_STATUSES,
  BARRIER_COMMAND_TYPES,
  DIRECTIONS,
  HARDWARE_DEVICE_KINDS,
  HARDWARE_DEVICE_STATUSES,
  HARDWARE_EVENT_TYPES,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  index,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  deletedAt,
  enumCheck,
  id,
  journalId,
  organizationIsolation,
  timestamps,
  tstz,
} from './_helpers';
import { gates, organizationId, siteId } from './organization';
import { passes } from './passes';
import { gateAccounts, gateDevices, users } from './people';
import { gateDecisions, visits } from './visits';

// DATA_MODEL §2.9 — оборудование (16_, раздел D). В MVP — контракты и таблицы, без драйверов.

export const hardwareDevices = pgTable(
  'hardware_devices',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    kind: text('kind', { enum: HARDWARE_DEVICE_KINDS }).notNull(),
    name: text('name').notNull(),
    /** 'sim-camera', 'sim-barrier', … — марки знает только адаптер. */
    adapter: text('adapter').notNull(),
    direction: text('direction', { enum: DIRECTIONS }),
    /** Параметры адаптера без секретов: секреты — у агента. */
    config: jsonb('config').notNull().default({}),
    /** Через какой агент КПП подключено. */
    agentDeviceId: uuid('agent_device_id').references(() => gateDevices.id),
    status: text('status', { enum: HARDWARE_DEVICE_STATUSES }).notNull().default('unknown'),
    lastSeenAt: tstz('last_seen_at'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('hardware_devices', t.kind, HARDWARE_DEVICE_KINDS),
    enumCheck('hardware_devices', t.direction, DIRECTIONS),
    enumCheck('hardware_devices', t.status, HARDWARE_DEVICE_STATUSES),
    organizationIsolation(),
  ],
);

/** Входящие события оборудования; `(device_id, agent_seq)` — идемпотентность приёма. */
export const hardwareEvents = pgTable(
  'hardware_events',
  {
    id: journalId(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    deviceId: uuid('device_id').references(() => hardwareDevices.id),
    type: text('type', { enum: HARDWARE_EVENT_TYPES }).notNull(),
    direction: text('direction'),
    at: tstz('at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    plateRaw: text('plate_raw'),
    plateNorm: text('plate_norm'),
    confidence: real('confidence'),
    payload: jsonb('payload').notNull().default({}),
    photoRef: text('photo_ref'),
    photoExpiresAt: tstz('photo_expires_at'),
    agentSeq: bigint('agent_seq', { mode: 'number' }),
    matchedPassId: uuid('matched_pass_id').references(() => passes.id),
    decisionId: bigint('decision_id', { mode: 'number' }).references(
      (): AnyPgColumn => gateDecisions.id,
    ),
  },
  (t) => [
    index('hardware_events_site_id_at_idx').on(t.siteId, t.at.desc()),
    unique('hardware_events_device_id_agent_seq_key').on(t.deviceId, t.agentSeq),
    enumCheck('hardware_events', t.type, HARDWARE_EVENT_TYPES),
    organizationIsolation(),
  ],
);

/** Исходящие команды шлагбаумам — только из транзакции въезда (RULES_ENGINE §8). */
export const barrierCommands = pgTable(
  'barrier_commands',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => hardwareDevices.id),
    type: text('type', { enum: BARRIER_COMMAND_TYPES }).notNull(),
    direction: text('direction'),
    issuedAt: tstz('issued_at').notNull().defaultNow(),
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id),
    issuedByGateAccountId: uuid('issued_by_gate_account_id').references(() => gateAccounts.id),
    deviceIssuedFrom: uuid('device_issued_from').references(() => gateDevices.id),
    cause: text('cause', { enum: BARRIER_COMMAND_CAUSES }).notNull(),
    visitId: uuid('visit_id').references(() => visits.id),
    decisionId: bigint('decision_id', { mode: 'number' }).references(() => gateDecisions.id),
    status: text('status', { enum: BARRIER_COMMAND_STATUSES }).notNull().default('queued'),
    sentAt: tstz('sent_at'),
    finishedAt: tstz('finished_at'),
    result: jsonb('result'),
  },
  (t) => [
    index('barrier_commands_pending_idx')
      .on(t.deviceId, t.status)
      .where(sql`${t.status} in ('queued', 'sent')`),
    enumCheck('barrier_commands', t.type, BARRIER_COMMAND_TYPES),
    enumCheck('barrier_commands', t.cause, BARRIER_COMMAND_CAUSES),
    enumCheck('barrier_commands', t.status, BARRIER_COMMAND_STATUSES),
    organizationIsolation(),
  ],
);

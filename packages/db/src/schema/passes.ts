import {
  CHANGE_REQUEST_STATUSES,
  PASS_FORM_LEVELS,
  PARTICIPANTS,
  PASS_SOURCES,
  PASS_STATUSES,
  PASS_TYPES,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, enumCheck, id, organizationIsolation, timestamps, tstz } from './_helpers';
import { vehicleCategories, visitPurposes } from './catalogs';
import { docks, organizationId, siteId, zones } from './organization';
import { gateAccounts, users } from './people';
import { tenants } from './tenants';

// DATA_MODEL §2.5 — пропуска.

/**
 * Пропуск принадлежит арендатору; автор пишется сервером (ADR-007). Дубли у одного арендатора
 * отсекает exclusion-ограничение в миграции 0002 (10_ §4).
 */
export const passes = pgTable(
  'passes',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    passType: text('pass_type', { enum: PASS_TYPES }).notNull(),
    participant: text('participant', { enum: PARTICIPANTS }).notNull(),
    plateRaw: text('plate_raw'),
    plateNorm: text('plate_norm'),
    plateCountry: text('plate_country'),
    categoryId: uuid('category_id').references(() => vehicleCategories.id),
    brand: text('brand'),
    personName: text('person_name'),
    /** Только признак/тип документа, не номер. */
    personDocument: text('person_document'),
    driverName: text('driver_name'),
    driverPhone: text('driver_phone'),
    purposeId: uuid('purpose_id').references(() => visitPurposes.id),
    /** A4/A5: место назначения и док — ссылки, а не текст. */
    destinationZoneId: uuid('destination_zone_id').references(() => zones.id),
    dockId: uuid('dock_id').references(() => docks.id),
    validFrom: tstz('valid_from'),
    /** null только у постоянного. */
    validTo: tstz('valid_to'),
    /** Окно прибытия. */
    windowFrom: tstz('window_from'),
    windowTo: tstz('window_to'),
    status: text('status', { enum: PASS_STATUSES }).notNull(),
    comment: text('comment'),
    createdBy: uuid('created_by').references(() => users.id),
    createdVia: text('created_via', { enum: PASS_SOURCES }).notNull(),
    /** Если создан с поста. */
    createdByGateAccountId: uuid('created_by_gate_account_id').references(
      (): AnyPgColumn => gateAccounts.id,
    ),
    batchId: uuid('batch_id').references((): AnyPgColumn => passBatches.id),
    approvedBy: uuid('approved_by'),
    approvedAt: tstz('approved_at'),
    approvalNote: text('approval_note'),
    approvalChanges: jsonb('approval_changes'),
    /** Согласование эскалировано по сроку политики (on_timeout = escalate). */
    approvalEscalatedAt: tstz('approval_escalated_at'),
    cancelledReason: text('cancelled_reason'),
    closedAt: tstz('closed_at'),
    /** id в PASS24 при импорте. */
    sourceRef: text('source_ref'),
    ...timestamps(),
  },
  (t) => [
    index('passes_plate_norm_trgm_idx').using('gin', t.plateNorm.op('gin_trgm_ops')),
    index('passes_person_name_trgm_idx').using('gin', t.personName.op('gin_trgm_ops')),
    index('passes_site_id_status_idx').on(t.siteId, t.status),
    index('passes_tenant_id_status_idx').on(t.tenantId, t.status),
    enumCheck('passes', t.passType, PASS_TYPES),
    enumCheck('passes', t.participant, PARTICIPANTS),
    enumCheck('passes', t.status, PASS_STATUSES),
    enumCheck('passes', t.createdVia, PASS_SOURCES),
    organizationIsolation(),
  ],
);

/** Пакетное создание: «создано N из M» (B3). */
export const passBatches = pgTable(
  'pass_batches',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdBy: uuid('created_by').notNull(),
    total: integer('total').notNull(),
    created: integer('created').notNull(),
    /** [{row, field, code, message}]. */
    errors: jsonb('errors').notNull(),
    createdAt: createdAt(),
  },
  () => [organizationIsolation()],
);

/** A8: заявка на изменение начавшегося согласованного пропуска. */
export const passChangeRequests = pgTable(
  'pass_change_requests',
  {
    id: id(),
    organizationId: organizationId(),
    passId: uuid('pass_id')
      .notNull()
      .references(() => passes.id),
    /** {"plate_raw":{"from":..,"to":..}}. */
    changes: jsonb('changes').notNull(),
    reason: text('reason'),
    status: text('status', { enum: CHANGE_REQUEST_STATUSES }).notNull(),
    requestedBy: uuid('requested_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: tstz('decided_at'),
    decisionNote: text('decision_note'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('pass_change_requests', t.status, CHANGE_REQUEST_STATUSES),
    organizationIsolation(),
  ],
);

/** Страница водителя `/p/{token}`; в БД только хэш токена. */
export const passTokens = pgTable(
  'pass_tokens',
  {
    id: id(),
    organizationId: organizationId(),
    passId: uuid('pass_id')
      .notNull()
      .references(() => passes.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    /** 152-ФЗ: водитель подтвердил согласие. */
    consentAt: tstz('consent_at'),
    lastOpenedAt: tstz('last_opened_at'),
    createdAt: createdAt(),
  },
  () => [organizationIsolation()],
);

/**
 * Настройка формы пропуска по уровням «объект → арендатор → сотрудник» (этап 7b, ADR-023).
 * `settings` — только заданные на уровне ключи (zod `PassFormSettings`); пустой уровень не хранится.
 */
export const passFormSettings = pgTable(
  'pass_form_settings',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    level: text('level', { enum: PASS_FORM_LEVELS }).notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    settings: jsonb('settings').notNull(),
    updatedBy: uuid('updated_by'),
    ...timestamps(),
  },
  (t) => [
    unique('pass_form_settings_key').on(t.siteId, t.level, t.tenantId, t.userId).nullsNotDistinct(),
    enumCheck('pass_form_settings', t.level, PASS_FORM_LEVELS),
    check(
      'pass_form_settings_level_scope_check',
      sql`(${t.level} = 'site' and ${t.tenantId} is null and ${t.userId} is null)
        or (${t.level} = 'tenant' and ${t.tenantId} is not null and ${t.userId} is null)
        or (${t.level} = 'user' and ${t.tenantId} is not null and ${t.userId} is not null)`,
    ),
    organizationIsolation(),
  ],
);

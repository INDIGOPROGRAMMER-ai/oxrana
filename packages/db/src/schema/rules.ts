import {
  APPROVAL_CREATOR_KINDS,
  APPROVAL_MODES,
  APPROVAL_TIMEOUT_ACTIONS,
  DIRECTIONS,
  EXCEPTION_WAIVES,
  type ExceptionMatch,
  PARTICIPANTS,
  PASS_TYPES,
  QUOTA_COUNTINGS,
  QUOTA_ENFORCEMENTS,
  WINDOW_VIOLATION_MODES,
  type WorkingHours,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  deletedAt,
  enumArrayCheck,
  enumCheck,
  id,
  isolationThroughParent,
  organizationIsolation,
  timestamps,
  tstz,
} from './_helpers';
import { vehicleCategories } from './catalogs';
import { gates, organizationId, siteId, zones } from './organization';
import { users } from './people';
import { contractClauses, tenants } from './tenants';

// DATA_MODEL §2.4 — правила. Квота ≠ маршрут ≠ место назначения (CLAUDE.md п. 2).

/**
 * Лимит арендатора на набор типов транспорта (ADR-012). Нет лимита на тип — без ограничения
 * (оператор); `capacity = 0` — запрет договором (Q-7).
 */
export const quotas = pgTable(
  'quotas',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    participant: text('participant', { enum: PARTICIPANTS }).notNull().default('vehicle'),
    /** Подпись на табло: по умолчанию из названий типов, редактируется («Грузовые»). */
    name: text('name').notNull(),
    capacity: integer('capacity').notNull(),
    /** capacity = число назначенных арендатору доков с counts_in_quota. */
    capacityFromDocks: boolean('capacity_from_docks').notNull().default(false),
    counting: text('counting', { enum: QUOTA_COUNTINGS }).notNull().default('on_site'),
    enforcement: text('enforcement', { enum: QUOTA_ENFORCEMENTS }).notNull().default('hard'),
    overageTariffRub: numeric('overage_tariff_rub', { precision: 10, scale: 2 }),
    overageCap: integer('overage_cap'),
    /** Действует только в эти часы; null — всегда. */
    schedule: jsonb('schedule').$type<WorkingHours>(),
    basisClauseId: uuid('basis_clause_id').references(() => contractClauses.id),
    validFrom: tstz('valid_from').notNull().defaultNow(),
    validTo: tstz('valid_to'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    check('quotas_capacity_check', sql`${t.capacity} >= 0`),
    enumCheck('quotas', t.participant, PARTICIPANTS),
    enumCheck('quotas', t.counting, QUOTA_COUNTINGS),
    enumCheck('quotas', t.enforcement, QUOTA_ENFORCEMENTS),
    organizationIsolation(),
  ],
);

/** Набор типов лимита; тип может входить в несколько лимитов — действуют все. */
export const quotaCategories = pgTable(
  'quota_categories',
  {
    quotaId: uuid('quota_id')
      .notNull()
      .references(() => quotas.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => vehicleCategories.id),
  },
  (t) => [
    primaryKey({ columns: [t.quotaId, t.categoryId] }),
    isolationThroughParent('quotas', t.quotaId),
  ],
);

/** Маршрут: матрица «тип × КПП»; правило арендатора приоритетнее правила объекта. */
export const routingRules = pgTable(
  'routing_rules',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    /** null — правило объекта. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    participant: text('participant', { enum: PARTICIPANTS }).notNull(),
    /** null — для пешехода или «любой тип». */
    categoryId: uuid('category_id').references(() => vehicleCategories.id),
    /** Для внутренних постов: «в офисное здание → пост в здании». */
    destinationZoneId: uuid('destination_zone_id').references(() => zones.id),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => gates.id),
    direction: text('direction', { enum: DIRECTIONS }).notNull().default('in'),
    priority: integer('priority').notNull().default(100),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('routing_rules', t.participant, PARTICIPANTS),
    enumCheck('routing_rules', t.direction, DIRECTIONS),
    organizationIsolation(),
  ],
);

export const timeWindowPolicies = pgTable(
  'time_window_policies',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    /** null — все арендаторы. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    windowRequired: boolean('window_required').notNull().default(false),
    earlyToleranceMin: integer('early_tolerance_min').notNull().default(0),
    /** null — до конца пропуска. */
    lateToleranceMin: integer('late_tolerance_min'),
    onViolation: text('on_violation', { enum: WINDOW_VIOLATION_MODES }).notNull().default('hard'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('time_window_policies', t.onViolation, WINDOW_VIOLATION_MODES),
    organizationIsolation(),
  ],
);

/** К каким типам применяется политика окна; нет строк — ко всем. */
export const timeWindowPolicyCategories = pgTable(
  'time_window_policy_categories',
  {
    policyId: uuid('policy_id').notNull(),
    categoryId: uuid('category_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.policyId, t.categoryId] }),
    // Имена FK заданы явно: автоматические длиннее 63 символов и были бы обрезаны Postgres.
    foreignKey({
      name: 'time_window_policy_categories_policy_id_fk',
      columns: [t.policyId],
      foreignColumns: [timeWindowPolicies.id],
    }),
    foreignKey({
      name: 'time_window_policy_categories_category_id_fk',
      columns: [t.categoryId],
      foreignColumns: [vehicleCategories.id],
    }),
    isolationThroughParent('time_window_policies', t.policyId),
  ],
);

/** Исключения: автобус, круглосуточно, руководство (RULES_ENGINE §5). */
export const exceptions = pgTable(
  'exceptions',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    match: jsonb('match').$type<ExceptionMatch>().notNull(),
    waives: text('waives', { enum: EXCEPTION_WAIVES }).array().notNull(),
    /** Строка для карточки поста: «Служебный автобус — без досмотра». */
    guardText: text('guard_text'),
    basis: text('basis'),
    basisClauseId: uuid('basis_clause_id').references(() => contractClauses.id),
    validFrom: tstz('valid_from').notNull().defaultNow(),
    validTo: tstz('valid_to'),
    createdBy: uuid('created_by').references(() => users.id),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [enumArrayCheck('exceptions', t.waives, EXCEPTION_WAIVES), organizationIsolation()],
);

export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    /** null — по умолчанию для объекта. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    creatorKind: text('creator_kind', { enum: APPROVAL_CREATOR_KINDS }).notNull(),
    passType: text('pass_type', { enum: PASS_TYPES }).notNull(),
    mode: text('mode', { enum: APPROVAL_MODES }).notNull(),
    commentRequired: boolean('comment_required').notNull().default(false),
    escalationHours: integer('escalation_hours'),
    onTimeout: text('on_timeout', { enum: APPROVAL_TIMEOUT_ACTIONS }),
    ...timestamps(),
  },
  (t) => [
    unique('approval_policies_scope_key')
      .on(t.siteId, t.tenantId, t.creatorKind, t.passType)
      .nullsNotDistinct(),
    enumCheck('approval_policies', t.creatorKind, APPROVAL_CREATOR_KINDS),
    enumCheck('approval_policies', t.passType, PASS_TYPES),
    enumCheck('approval_policies', t.mode, APPROVAL_MODES),
    enumCheck('approval_policies', t.onTimeout, APPROVAL_TIMEOUT_ACTIONS),
    organizationIsolation(),
  ],
);

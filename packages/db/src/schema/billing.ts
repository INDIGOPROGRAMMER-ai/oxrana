import { VIOLATION_STATUSES } from '@oxrana/contracts';
import { date, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, enumCheck, id, organizationIsolation, timestamps } from './_helpers';
import { organizationId, siteId } from './organization';
import { quotas } from './rules';
import { tenants } from './tenants';
import { visits } from './visits';

// DATA_MODEL §2.7 — деньги и нарушения.

/**
 * Начисления по мягким лимитам: строка на визит × местные сутки объекта. Пишет фоновая задача
 * (этап 11), пересчёт идемпотентен благодаря `unique (visit_id, day)`.
 */
export const overageCharges = pgTable(
  'overage_charges',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    quotaId: uuid('quota_id')
      .notNull()
      .references(() => quotas.id),
    visitId: uuid('visit_id')
      .notNull()
      .references(() => visits.id),
    /** Местные сутки объекта. */
    day: date('day').notNull(),
    tariffRub: numeric('tariff_rub', { precision: 10, scale: 2 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('overage_charges_visit_id_day_key').on(t.visitId, t.day), organizationIsolation()],
);

/** v2: таблица создаётся сразу, экранов в MVP нет (Q-29). */
export const violations = pgTable(
  'violations',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    visitId: uuid('visit_id').references(() => visits.id),
    kind: text('kind').notNull(),
    ruleRef: text('rule_ref'),
    fineRub: numeric('fine_rub', { precision: 10, scale: 2 }),
    photos: text('photos').array(),
    status: text('status', { enum: VIOLATION_STATUSES }).notNull().default('draft'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [enumCheck('violations', t.status, VIOLATION_STATUSES), organizationIsolation()],
);

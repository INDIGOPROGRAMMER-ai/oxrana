import { CONTRACT_STATUSES, PEDESTRIAN_ESCORTS, TENANT_STATUSES } from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  date,
  foreignKey,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  deletedAt,
  enumCheck,
  id,
  NIL_UUID,
  organizationIsolation,
  timestamps,
  tstz,
} from './_helpers';
import { vehicleCategories } from './catalogs';
import { docks, organizationId, parkingAreas, siteId, zones } from './organization';

// DATA_MODEL §2.3 — арендаторы и договоры.

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    legalName: text('legal_name').notNull(),
    shortName: text('short_name').notNull(),
    inn: text('inn'),
    /** A6: оператор объекта — арендатор без лимитов. */
    isOperator: boolean('is_operator').notNull().default(false),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('active'),
    /** Почему арендатор заблокирован и когда статус менялся (подробности — в аудите). */
    statusReason: text('status_reason'),
    statusChangedAt: tstz('status_changed_at'),
    /** A5: грузовые только к докам. */
    trucksDockRequired: boolean('trucks_dock_required').notNull().default(false),
    /** Предзаполняется в форме, но не подставляется молча (ADR-012 п. 6). */
    defaultCategoryId: uuid('default_category_id').references(
      (): AnyPgColumn => vehicleCategories.id,
    ),
    responsiblePhone: text('responsible_phone'),
    emergencyPhone: text('emergency_phone'),
    color: text('color'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [enumCheck('tenants', t.status, TENANT_STATUSES), organizationIsolation()],
);

export const contracts = pgTable(
  'contracts',
  {
    id: id(),
    organizationId: organizationId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    number: text('number'),
    signedOn: date('signed_on'),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    status: text('status', { enum: CONTRACT_STATUSES }).notNull().default('active'),
    /** Ключ в хранилище файлов, не URL. */
    fileRef: text('file_ref'),
    notes: text('notes'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [enumCheck('contracts', t.status, CONTRACT_STATUSES), organizationIsolation()],
);

export const contractClauses = pgTable(
  'contract_clauses',
  {
    id: id(),
    organizationId: organizationId(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => contracts.id),
    /** «п. 2.1». */
    ref: text('ref').notNull(),
    /** «30 легковых мест». */
    summary: text('summary').notNull(),
    ...timestamps(),
  },
  () => [organizationIsolation()],
);

/** Док не бывает у двух арендаторов сразу — exclusion-ограничение в миграции 0002. */
export const tenantDockAssignments = pgTable(
  'tenant_dock_assignments',
  {
    id: id(),
    organizationId: organizationId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    dockId: uuid('dock_id')
      .notNull()
      .references(() => docks.id),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    basisClauseId: uuid('basis_clause_id').references(() => contractClauses.id),
    ...timestamps(),
  },
  () => [organizationIsolation()],
);

export const tenantParkingAssignments = pgTable(
  'tenant_parking_assignments',
  {
    id: id(),
    organizationId: organizationId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    parkingAreaId: uuid('parking_area_id')
      .notNull()
      .references(() => parkingAreas.id),
    spaces: integer('spaces').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    basisClauseId: uuid('basis_clause_id'),
    ...timestamps(),
  },
  (t) => [
    // Имя задано явно: автоматическое длиннее 63 символов.
    foreignKey({
      name: 'tenant_parking_assignments_basis_clause_id_fk',
      columns: [t.basisClauseId],
      foreignColumns: [contractClauses.id],
    }),
    organizationIsolation(),
  ],
);

/** A3: правила допуска пешеходов по арендатору (× зона). */
export const pedestrianRules = pgTable(
  'pedestrian_rules',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** null — везде у арендатора. */
    zoneId: uuid('zone_id').references(() => zones.id),
    documentRequired: boolean('document_required').notNull().default(true),
    escort: text('escort', { enum: PEDESTRIAN_ESCORTS }).notNull(),
    escortPhone: text('escort_phone'),
    /** Одна строка для карточки поста. */
    guardText: text('guard_text'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('pedestrian_rules', t.escort, PEDESTRIAN_ESCORTS),
    // одно правило на «арендатор × зона» и одно «везде» (zone_id is null): движок берёт первое найденное
    uniqueIndex('pedestrian_rules_tenant_zone_key')
      .on(t.tenantId, sql`coalesce(${t.zoneId}, '${sql.raw(NIL_UUID)}'::uuid)`)
      .where(sql`${t.deletedAt} is null`),
    organizationIsolation(),
  ],
);

export const fleetVehicles = pgTable(
  'fleet_vehicles',
  {
    id: id(),
    organizationId: organizationId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    plateRaw: text('plate_raw').notNull(),
    plateNorm: text('plate_norm').notNull(),
    plateCountry: text('plate_country').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => vehicleCategories.id),
    brand: text('brand'),
    driverName: text('driver_name'),
    driverPhone: text('driver_phone'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('fleet_vehicles_tenant_id_plate_norm_key')
      .on(t.tenantId, t.plateNorm)
      .where(sql`${t.deletedAt} is null`),
    organizationIsolation(),
  ],
);

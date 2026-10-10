import { VEHICLE_CATEGORY_PRESET_CODES } from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
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
import { organizationId, siteId, sites } from './organization';
import { users } from './people';

// DATA_MODEL §2.2 — справочники.

/** Типы транспорта (ADR-012): у организации, с переопределением на объекте. */
export const vehicleCategories = pgTable(
  'vehicle_categories',
  {
    id: id(),
    organizationId: organizationId(),
    /** null — уровень организации; иначе переопределение на объекте. */
    siteId: uuid('site_id').references(() => sites.id),
    /** Ключ из VEHICLE_CATEGORY_PRESETS; null — свой тип. */
    presetCode: text('preset_code', { enum: VEHICLE_CATEGORY_PRESET_CODES }),
    /** Переименовывается свободно; порог тоннажа — данные, не код (A1). */
    name: text('name').notNull(),
    /** Выключенный тип не виден в формах, остаётся в истории. */
    enabled: boolean('enabled').notNull().default(true),
    /** «Обычно едет к доку»: к нему применяется tenants.trucks_dock_required. */
    dockEligible: boolean('dock_eligible').notNull().default(false),
    /** Порядок в списках (перетаскивание); дефолта нет. */
    sort: integer('sort').notNull(),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('vehicle_categories_preset_key')
      .on(t.organizationId, sql`coalesce(${t.siteId}, '${sql.raw(NIL_UUID)}'::uuid)`, t.presetCode)
      .where(sql`${t.presetCode} is not null`),
    enumCheck('vehicle_categories', t.presetCode, VEHICLE_CATEGORY_PRESET_CODES),
    organizationIsolation(),
  ],
);

export const visitPurposes = pgTable(
  'visit_purposes',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    name: text('name').notNull(),
    /** Норматив времени на территории. */
    maxStayMinutes: integer('max_stay_minutes'),
    sort: integer('sort'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  () => [organizationIsolation()],
);

export const blacklist = pgTable(
  'blacklist',
  {
    id: id(),
    organizationId: organizationId(),
    /** null — вся организация. */
    siteId: uuid('site_id').references(() => sites.id),
    plateNorm: text('plate_norm'),
    personName: text('person_name'),
    reason: text('reason').notNull(),
    validTo: tstz('valid_to'),
    createdBy: uuid('created_by').references(() => users.id),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    check(
      'blacklist_subject_check',
      sql`${t.plateNorm} is not null or ${t.personName} is not null`,
    ),
    index('blacklist_organization_id_plate_norm_idx').on(t.organizationId, t.plateNorm),
    organizationIsolation(),
  ],
);

import {
  DIRECTIONS,
  DOCK_KINDS,
  GATE_ADMITS,
  GATE_KINDS,
  type SiteSettingsInput,
  type WorkingHours,
  ZONE_KINDS,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  point,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CURRENT_ORGANIZATION,
  deletedAt,
  enumCheck,
  id,
  organizationIsolation,
  timestamps,
} from './_helpers';

// DATA_MODEL §2.1 — организация, объект, инфраструктура.

export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    /** Для URL и логов без ПДн. */
    slug: text('slug').notNull().unique(),
    /** OrganizationSettings (zod) — ключи появятся вместе с экранами организации. */
    settings: jsonb('settings').notNull().default({}),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  () => [
    pgPolicy('organization_isolation', {
      as: 'permissive',
      for: 'all',
      using: sql`id = ${CURRENT_ORGANIZATION}`,
      withCheck: sql`id = ${CURRENT_ORGANIZATION}`,
    }),
  ],
);

/** `organization_id` бизнес-таблицы: денормализован для фильтра и RLS. */
export const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id);

export const sites = pgTable(
  'sites',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    address: text('address'),
    geo: point('geo', { mode: 'xy' }),
    /** IANA-пояс объекта: 'Asia/Yekaterinburg'; проверяется по Intl.supportedValuesOf('timeZone'). */
    timezone: text('timezone').notNull(),
    /** null — круглосуточно. */
    workingHours: jsonb('working_hours').$type<WorkingHours>(),
    settings: jsonb('settings').$type<SiteSettingsInput>().notNull().default({}),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  () => [organizationIsolation()],
);

/** `site_id` таблицы объекта. */
export const siteId = () =>
  uuid('site_id')
    .notNull()
    .references(() => sites.id);

export const zones = pgTable(
  'zones',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ZONE_KINDS }).notNull(),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [enumCheck('zones', t.kind, ZONE_KINDS), organizationIsolation()],
);

export const gates = pgTable(
  'gates',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    name: text('name').notNull(),
    /** A4: внутренний пост не открывает визит. */
    kind: text('kind', { enum: GATE_KINDS }).notNull(),
    /** «Кого пропускает» (ADR-012). */
    admits: text('admits', { enum: GATE_ADMITS }).notNull().default('vehicles_and_pedestrians'),
    /** Для внутреннего поста: в какую зону ведёт. */
    zoneId: uuid('zone_id').references(() => zones.id),
    direction: text('direction', { enum: DIRECTIONS }).notNull().default('both'),
    workingHours: jsonb('working_hours').$type<WorkingHours>(),
    /** D: автопроезд для зелёных по камере. */
    autoPassOnAllow: boolean('auto_pass_on_allow').notNull().default(false),
    /** GateSettings: звук, тема, таймаут запроса — этап 6. */
    settings: jsonb('settings').notNull().default({}),
    sort: integer('sort').notNull().default(100),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    enumCheck('gates', t.kind, GATE_KINDS),
    enumCheck('gates', t.admits, GATE_ADMITS),
    enumCheck('gates', t.direction, DIRECTIONS),
    organizationIsolation(),
  ],
);

export const docks = pgTable(
  'docks',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    zoneId: uuid('zone_id').references(() => zones.id),
    /** «19», «З1». */
    number: text('number').notNull(),
    kind: text('kind', { enum: DOCK_KINDS }).notNull().default('leveller'),
    /** Наземные ворота, не входящие в лимит арендатора, — false. */
    countsInQuota: boolean('counts_in_quota').notNull().default(true),
    size: text('size'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    unique('docks_site_id_number_key').on(t.siteId, t.number),
    enumCheck('docks', t.kind, DOCK_KINDS),
    organizationIsolation(),
  ],
);

export const parkingAreas = pgTable(
  'parking_areas',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    zoneId: uuid('zone_id').references(() => zones.id),
    name: text('name').notNull(),
    spaces: integer('spaces'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  () => [organizationIsolation()],
);

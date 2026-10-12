import { z } from 'zod';
import {
  DirectionSchema,
  DockKindSchema,
  GateAdmitsSchema,
  GateKindSchema,
  ZoneKindSchema,
} from '../enums';
import { SiteSettingsPatchSchema, SiteSettingsSchema, WorkingHoursSchema } from '../settings';
import { VehicleCategoryPresetCodeSchema } from '../vehicle-categories';
import { IdSchema, ReasonSchema, SiteTimeSchema, TextSchema } from './common';

// Модуль org (ARCHITECTURE §2): организация, объекты, пояса, зоны, КПП, доки, типы транспорта.

export const OrganizationViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: z.string(),
  /** Пояс, которым предзаполняется новый объект (ADR-009); `null` — не задан. */
  defaultTimezone: z.string().nullable(),
  defaultTimezoneLabel: z.string().nullable(),
});
export type OrganizationView = z.infer<typeof OrganizationViewSchema>;

export const OrganizationPatchSchema = z.strictObject({
  name: TextSchema().optional(),
  defaultTimezone: z.string().min(1).nullable().optional(),
});

export const TimezonesQuerySchema = z.strictObject({
  /** Адрес объекта — для подсказки пояса. */
  address: z.string().max(500).optional(),
});

export const TimezoneOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** «Екатеринбург, UTC+5» на текущий момент. */
  label: z.string(),
});

export const TimezonesViewSchema = z.object({
  zones: z.array(TimezoneOptionSchema),
  /** Пояс организации по умолчанию — им предзаполняется форма нового объекта. */
  organizationDefault: TimezoneOptionSchema.nullable(),
  /** Подсказка по адресу (только подсказка, сама не подставляется). */
  suggestion: z
    .object({
      timezone: z.string(),
      city: z.string(),
      matchedBy: z.enum(['city', 'region']),
      label: z.string(),
      /** Отличается от пояса по умолчанию — форма показывает предупреждение. */
      differsFromDefault: z.boolean(),
    })
    .nullable(),
});

export const SiteViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  address: z.string().nullable(),
  ...SiteTimeSchema.shape,
  workingHours: WorkingHoursSchema.nullable(),
  settings: SiteSettingsSchema,
});
export type SiteView = z.infer<typeof SiteViewSchema>;

export const SiteListViewSchema = z.object({ items: z.array(SiteViewSchema) });

export const SiteCreateSchema = z.strictObject({
  name: TextSchema(),
  address: z.string().trim().max(500).nullable().optional(),
  /** Не указан — берётся пояс организации по умолчанию (ADR-009). */
  timezone: z.string().min(1).optional(),
  workingHours: WorkingHoursSchema.nullable().optional(),
  settings: SiteSettingsPatchSchema.optional(),
});

/**
 * Правка объекта. `settings` — только меняемые ключи (остальные остаются). Пояс здесь не меняется:
 * `timezone` принимается лишь затем, чтобы ответить понятной ошибкой со ссылкой на действие смены.
 */
export const SitePatchSchema = z.strictObject({
  name: TextSchema().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  workingHours: WorkingHoursSchema.nullable().optional(),
  settings: SiteSettingsPatchSchema.optional(),
  timezone: z.string().optional(),
});

/** Смена пояса объекта (ADR-009, дополнение): с причиной и подтверждением последствий. */
export const SiteTimezoneChangeSchema = z.strictObject({
  timezone: z.string().min(1),
  reason: ReasonSchema,
  confirm: z.boolean().optional(),
});

export const ZoneViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  name: z.string(),
  kind: ZoneKindSchema,
});
export const ZoneCreateSchema = z.strictObject({ name: TextSchema(), kind: ZoneKindSchema });
export const ZonePatchSchema = ZoneCreateSchema.partial();

export const GateViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  name: z.string(),
  kind: GateKindSchema,
  admits: GateAdmitsSchema,
  zoneId: IdSchema.nullable(),
  direction: DirectionSchema,
  workingHours: WorkingHoursSchema.nullable(),
  autoPassOnAllow: z.boolean(),
  sort: z.int(),
});
export const GateCreateSchema = z.strictObject({
  name: TextSchema(),
  kind: GateKindSchema,
  admits: GateAdmitsSchema.optional(),
  zoneId: IdSchema.nullable().optional(),
  direction: DirectionSchema.optional(),
  workingHours: WorkingHoursSchema.nullable().optional(),
  autoPassOnAllow: z.boolean().optional(),
  sort: z.int().optional(),
});
export const GatePatchSchema = GateCreateSchema.partial();

export const DockViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  zoneId: IdSchema.nullable(),
  number: z.string(),
  kind: DockKindSchema,
  countsInQuota: z.boolean(),
  size: z.string().nullable(),
});
export const DockCreateSchema = z.strictObject({
  number: TextSchema(20),
  zoneId: IdSchema.nullable().optional(),
  kind: DockKindSchema.optional(),
  countsInQuota: z.boolean().optional(),
  size: z.string().trim().max(50).nullable().optional(),
});
export const DockPatchSchema = DockCreateSchema.partial();
/** Пакетное добавление доков: номера (клиент раскрывает «1–72»), общие для всех зона и вид. */
export const DockBatchSchema = z.strictObject({
  numbers: z.array(TextSchema(20)).min(1, 'Укажите хотя бы один номер дока').max(1000),
  zoneId: IdSchema.nullable().optional(),
  kind: DockKindSchema.optional(),
  countsInQuota: z.boolean().optional(),
  size: z.string().trim().max(50).nullable().optional(),
  /** Предпросмотр: проверить все строки без сохранения. */
  dryRun: z.boolean().optional(),
});

export const VehicleCategoryViewSchema = z.object({
  id: IdSchema,
  /** `null` — тип организации; иначе переопределение на объекте (ADR-012). */
  siteId: IdSchema.nullable(),
  presetCode: VehicleCategoryPresetCodeSchema.nullable(),
  name: z.string(),
  enabled: z.boolean(),
  dockEligible: z.boolean(),
  sort: z.int(),
});
export const VehicleCategoryListQuerySchema = z.strictObject({
  /** Показать и выключенные типы (для настройки справочника). */
  all: z.enum(['true', 'false']).optional(),
});
export const VehicleCategoryCreateSchema = z.strictObject({
  /** `null` — тип организации (нужна область «вся организация»), иначе — переопределение на объекте. */
  siteId: IdSchema.nullable(),
  presetCode: VehicleCategoryPresetCodeSchema.nullable().optional(),
  /** Не указано у рекомендованного типа — название из пресета. */
  name: TextSchema(100).optional(),
  enabled: z.boolean().optional(),
  dockEligible: z.boolean().optional(),
  sort: z.int(),
});
export const VehicleCategoryPatchSchema = z.strictObject({
  name: TextSchema(100).optional(),
  enabled: z.boolean().optional(),
  dockEligible: z.boolean().optional(),
  sort: z.int().optional(),
});

/** Личные настройки пользователя (ADR-009, дополнение): «показывать ещё и моё время». */
export const MeSettingsViewSchema = z.object({
  showOwnTime: z.boolean(),
  ownTimezone: z.string().nullable(),
  ownTimezoneLabel: z.string().nullable(),
});
export const MeSettingsPatchSchema = z.strictObject({
  showOwnTime: z.boolean().optional(),
  ownTimezone: z.string().min(1).nullable().optional(),
});

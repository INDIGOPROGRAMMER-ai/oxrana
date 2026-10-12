import { z } from 'zod';

/**
 * zod-схемы `jsonb`-полей (DATA_MODEL, соглашения): валидируются на записи. Значения по умолчанию
 * задаются здесь, а не в БД: `SiteSettingsSchema.parse({})` даёт полные настройки объекта.
 */

/** Время суток «ЧЧ:ММ» местного пояса объекта; `24:00` — конец суток. */
export const LocalTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Время в формате ЧЧ:ММ, например 08:00');

/** Интервал [с, до) в пределах одних местных суток. */
export const TimeIntervalSchema = z
  .tuple([LocalTimeSchema, LocalTimeSchema])
  .refine(([from, to]) => from < to, 'Начало интервала должно быть раньше конца');

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Рабочее время (`sites.working_hours`, `gates.working_hours`): интервалы по дням недели в поясе
 * объекта. Пустой список — выходной; `null` в колонке — круглосуточно. Все дни указываются явно.
 */
export const WorkingHoursSchema = z.strictObject({
  mon: z.array(TimeIntervalSchema),
  tue: z.array(TimeIntervalSchema),
  wed: z.array(TimeIntervalSchema),
  thu: z.array(TimeIntervalSchema),
  fri: z.array(TimeIntervalSchema),
  sat: z.array(TimeIntervalSchema),
  sun: z.array(TimeIntervalSchema),
});
export type WorkingHours = z.infer<typeof WorkingHoursSchema>;

/** Въезд вне рабочего времени объекта. */
export const OUTSIDE_WORKING_HOURS_MODES = ['deny', 'warn', 'allow'] as const;

/** `sites.settings` (DATA_MODEL §3). */
export const SiteSettingsSchema = z.strictObject({
  singlePassMaxHours: z.int().min(1).default(24),
  multiPassMinDays: z.int().min(1).default(2),
  multiPassMaxDays: z.int().min(1).default(31),
  /** «Возврат в течение X минут» для разового пропуска (Q-22); `null` — выключено. */
  singleReturnWindowMin: z.int().min(1).nullable().default(null),
  outsideWorkingHours: z.enum(OUTSIDE_WORKING_HOURS_MODES).default('warn'),
  gateRequestTimeoutMin: z.int().min(1).default(10),
  overrideValidMin: z.int().min(1).default(15),
  undoWindowSec: z.int().min(0).default(120),
  shiftMarkEnabled: z.boolean().default(false),
  seniorPinHash: z.string().min(1).nullable().default(null),
  /** Телефон дежурного администратора внизу экрана поста; `null` — строка не показывается. */
  dutyAdminPhone: z.string().min(1).nullable().default(null),
  retentionDays: z
    .strictObject({
      visits: z.int().min(1).default(1095),
      photos: z.int().min(1).default(30),
      audit: z.int().min(1).default(1095),
    })
    .prefault({}),
  plateFuzzyThreshold: z.number().min(0).max(1).default(0.85),
  permanentPassReviewMonths: z.int().min(1).default(6),
});
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;
/** Как настройки хранятся в `sites.settings`: только заданные ключи, остальное — по умолчанию. */
export type SiteSettingsInput = z.input<typeof SiteSettingsSchema>;

/**
 * Изменение настроек объекта (PATCH): те же ключи, **без значений по умолчанию** — в
 * `sites.settings` попадают только присланные ключи (DATA_MODEL §7 п. 9). Совпадение ключей с
 * `SiteSettingsSchema` проверяет тест contracts.
 */
export const SiteSettingsPatchSchema = z.strictObject({
  singlePassMaxHours: z.int().min(1).optional(),
  multiPassMinDays: z.int().min(1).optional(),
  multiPassMaxDays: z.int().min(1).optional(),
  singleReturnWindowMin: z.int().min(1).nullable().optional(),
  outsideWorkingHours: z.enum(OUTSIDE_WORKING_HOURS_MODES).optional(),
  gateRequestTimeoutMin: z.int().min(1).optional(),
  overrideValidMin: z.int().min(1).optional(),
  undoWindowSec: z.int().min(0).optional(),
  shiftMarkEnabled: z.boolean().optional(),
  seniorPinHash: z.string().min(1).nullable().optional(),
  dutyAdminPhone: z.string().min(1).nullable().optional(),
  retentionDays: z
    .strictObject({
      visits: z.int().min(1).optional(),
      photos: z.int().min(1).optional(),
      audit: z.int().min(1).optional(),
    })
    .optional(),
  plateFuzzyThreshold: z.number().min(0).max(1).optional(),
  permanentPassReviewMonths: z.int().min(1).optional(),
});
export type SiteSettingsPatch = z.infer<typeof SiteSettingsPatchSchema>;

/**
 * С чем совпадает исключение (`exceptions.match`, RULES_ENGINE §5). Ровно один вариант:
 * номера (нормализованные), типы транспорта, весь арендатор исключения, конкретные пропуска.
 */
export const ExceptionMatchSchema = z.union([
  z.strictObject({ plates: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ categoryIds: z.array(z.uuid()).min(1) }),
  z.strictObject({ tenant: z.literal(true) }),
  z.strictObject({ passIds: z.array(z.uuid()).min(1) }),
]);
export type ExceptionMatch = z.infer<typeof ExceptionMatchSchema>;

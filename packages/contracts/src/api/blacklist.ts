import { z } from 'zod';
import { IdSchema, InstantInputSchema, ReasonSchema, TextSchema } from './common';

// Чёрный список (ADR-017, этап 6b): номер машины и/или человек, причина обязательна, срок, уровень.
// Проверка — в движке (`blacklist`): въезд — отказ, выезд — предупреждение (Q-10).

/** Уровень записи: только этот объект или вся организация (все объекты). */
export const BLACKLIST_LEVELS = ['site', 'organization'] as const;
export const BlacklistLevelSchema = z.enum(BLACKLIST_LEVELS);
export type BlacklistLevel = (typeof BLACKLIST_LEVELS)[number];

export const BlacklistViewSchema = z.object({
  id: IdSchema,
  level: BlacklistLevelSchema,
  /** `null` — запись организации. */
  siteId: IdSchema.nullable(),
  /** Нормализованный номер (латиница и цифры, верхний регистр); `null` — запись о человеке. */
  plateNorm: z.string().nullable(),
  personName: z.string().nullable(),
  reason: z.string(),
  /** Срок в UTC; `null` — бессрочно. */
  validTo: z.string().nullable(),
  /** Действует сейчас: срок не истёк. */
  active: z.boolean(),
  createdById: IdSchema.nullable(),
  /** Кто добавил: ФИО на момент ответа. */
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type BlacklistView = z.infer<typeof BlacklistViewSchema>;

const NO_SUBJECT = 'Укажите номер машины и/или фамилию — иначе запись ни к кому не относится.';

export const BlacklistCreateSchema = z
  .strictObject({
    level: BlacklistLevelSchema,
    /** Номер как ввели; сервер нормализует (кириллица → латиница, без пробелов). */
    plate: TextSchema(30).optional(),
    personName: TextSchema(200).optional(),
    reason: ReasonSchema,
    /** Не указан — бессрочно. */
    validTo: InstantInputSchema.nullable().optional(),
  })
  .refine((v) => v.plate !== undefined || v.personName !== undefined, {
    message: NO_SUBJECT,
    path: ['plate'],
  });

export const BlacklistPatchSchema = z.strictObject({
  plate: TextSchema(30).nullable().optional(),
  personName: TextSchema(200).nullable().optional(),
  reason: ReasonSchema.optional(),
  validTo: InstantInputSchema.nullable().optional(),
});

/** Пакетная вставка номеров (из Excel): общие причина, уровень и срок. */
export const BlacklistBatchSchema = z.strictObject({
  level: BlacklistLevelSchema,
  plates: z.array(TextSchema(30)).min(1, 'Добавьте хотя бы один номер').max(1000),
  reason: ReasonSchema,
  validTo: InstantInputSchema.nullable().optional(),
  dryRun: z.boolean().optional(),
});

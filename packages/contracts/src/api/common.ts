import { z } from 'zod';

/**
 * Общие куски схем API. На границе API время — ISO 8601: на входе с любым смещением, на выходе в
 * UTC с `Z` (ADR-009 п. 3). Поля-ссылки — uuid. Схемы запросов строгие: лишнее поле — ошибка, а не
 * молчаливое игнорирование (CLAUDE.md п. 8).
 */
export const InstantInputSchema = z.iso.datetime({
  offset: true,
  error: 'Время в формате ISO 8601 с поясом, например 2026-03-10T14:00:00Z',
});
/** Момент в ответе: ISO 8601 в UTC. */
export const InstantSchema = z.string();
export const IdSchema = z.uuid();
export const IdParamsSchema = z.strictObject({ id: z.uuid() });
export const SiteParamsSchema = z.strictObject({ siteId: z.uuid() });
export const TenantParamsSchema = z.strictObject({ tenantId: z.uuid() });

/** Причина изменения: попадает в журнал аудита. */
export const ReasonSchema = z
  .string()
  .trim()
  .min(3, 'Причина — хотя бы 3 символа')
  .max(500, 'Причина — не длиннее 500 символов');

/** Текстовое поле: обрезается по краям, пустая строка не допускается. */
export const TextSchema = (max = 200) => z.string().trim().min(1, 'Заполните поле').max(max);

/** Постраничный вывод списков. */
export const PageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Подпись времени объекта (ADR-009): пояс и готовая подпись «Челябинск, UTC+5». */
export const SiteTimeSchema = z.object({
  timezone: z.string(),
  timezoneLabel: z.string(),
});

/**
 * Итог пакетного ввода (доки, арендаторы, назначения): как у пакета пропусков — строки независимы,
 * ошибка строки не мешает остальным; `dryRun` проходит тот же путь и откатывается (предпросмотр).
 */
export const BatchRowErrorSchema = z.object({
  /** Номер строки пакета, с 1. */
  row: z.int(),
  field: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export const BatchResultSchema = z.object({
  dryRun: z.boolean(),
  total: z.int(),
  created: z.int(),
  /** «Добавится 70 из 72» / «Добавлено 70 из 72». */
  summary: z.string(),
  errors: z.array(BatchRowErrorSchema),
  /** Идентификаторы созданных записей по порядку строк; `null` — строка с ошибкой или предпросмотр. */
  ids: z.array(z.uuid().nullable()),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;

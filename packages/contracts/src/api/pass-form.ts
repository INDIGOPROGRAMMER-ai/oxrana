import { z } from 'zod';
import { PassTypeSchema } from '../enums';
import { PassFormSettingsSchema, ResolvedPassFormSchema } from '../pass-form';
import { IdSchema } from './common';

// Настройка формы пропуска по уровням (этап 7b, ADR-023).

/** Форма для текущего пользователя: итог разрешения уровней и признак «сервер это применяет». */
export const PassFormMineSchema = z.object({
  form: ResolvedPassFormSchema,
  /** `true` у пользователей арендатора; сотрудников оператора форма не ограничивает. */
  enforced: z.boolean(),
  /** Максимум разового пропуска объекта, часов: окончание по умолчанию не выходит за него. */
  singlePassMaxHours: z.int(),
});
export type PassFormMine = z.infer<typeof PassFormMineSchema>;

/**
 * Всё для редактора и его живого предпросмотра: слои как сохранены, сотрудник, чьё представление
 * показывается, и его права — «не шире прав роли».
 */
export const PassFormEditorSchema = z.object({
  tenant: z.object({ id: IdSchema, name: z.string() }),
  singlePassMaxHours: z.int(),
  layers: z.object({
    site: PassFormSettingsSchema,
    tenant: PassFormSettingsSchema,
    /** `null` — сотрудник не выбран. */
    user: PassFormSettingsSchema.nullable(),
  }),
  subject: z.object({
    userId: IdSchema.nullable(),
    name: z.string().nullable(),
    /** Виды пропусков, которые роль сотрудника разрешает оформлять; без сотрудника — все. */
    passTypes: z.array(PassTypeSchema),
  }),
  users: z.array(z.object({ id: IdSchema, name: z.string() })),
  /** Какие уровни может править тот, кто открыл редактор. */
  canEdit: z.object({ site: z.boolean(), tenant: z.boolean(), user: z.boolean() }),
});
export type PassFormEditor = z.infer<typeof PassFormEditorSchema>;

export const PassFormEditorQuerySchema = z.strictObject({ userId: IdSchema.optional() });
export const TenantUserParamsSchema = z.strictObject({ tenantId: IdSchema, userId: IdSchema });

/** Ответ на сохранение уровня: уровень как он теперь хранится. */
export const PassFormSavedSchema = z.object({ settings: PassFormSettingsSchema });

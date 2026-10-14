import { z } from 'zod';
import { IdSchema, InstantSchema } from './common';

// Уведомления в кабинете (этап 7b, ADR-023): колокольчик со счётчиком непрочитанных.

export const NotificationViewSchema = z.object({
  id: IdSchema,
  kind: z.string(),
  title: z.string(),
  text: z.string(),
  /** Пропуск, о котором уведомление; ссылка ведёт к его карточке. */
  passId: IdSchema.nullable(),
  tenantId: IdSchema.nullable(),
  /** Что изменил согласующий: «было → стало» по полям (только для «одобрено с изменениями»). */
  changes: z
    .record(
      z.string(),
      z.object({
        from: z.unknown(),
        to: z.unknown(),
        fromLabel: z.string().nullable().optional(),
        toLabel: z.string().nullable().optional(),
      }),
    )
    .nullable(),
  createdAt: InstantSchema,
  readAt: InstantSchema.nullable(),
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

export const NotificationListQuerySchema = z.strictObject({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const NotificationListSchema = z.object({
  items: z.array(NotificationViewSchema),
  unreadCount: z.int(),
});

/** Отметить прочитанными: перечисленные или все. */
export const NotificationReadSchema = z.strictObject({
  ids: z.array(IdSchema).max(200).optional(),
  all: z.boolean().optional(),
});

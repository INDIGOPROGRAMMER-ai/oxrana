import { z } from 'zod';
import {
  ParticipantSchema,
  PassageDirectionSchema,
  PassTypeSchema,
  QuotaEnforcementSchema,
} from '../enums';
import { IdSchema, InstantInputSchema, TextSchema } from './common';
import { VerdictSchema } from './gate';

// Песочница правил (этап 6b): вердикт движка для воображаемого пропуска на настроенных правилах
// объекта. Ничего не записывает; живая занятость берётся из открытых визитов.

export const SandboxCheckSchema = z.strictObject({
  tenantId: IdSchema,
  passType: PassTypeSchema.default('multi'),
  participant: ParticipantSchema.default('vehicle'),
  /** Тип транспорта; для пешехода не указывается. */
  categoryId: IdSchema.nullable().optional(),
  gateId: IdSchema,
  direction: PassageDirectionSchema.default('in'),
  /** Момент проверки; не указан — сейчас. Показывается и считается в поясе объекта. */
  at: InstantInputSchema.optional(),
  /** Номер машины как ввели (нормализуется); без номера чёрный список не проверяется. */
  plate: TextSchema(30).optional(),
  personName: TextSchema(200).optional(),
  dockId: IdSchema.nullable().optional(),
  destinationZoneId: IdSchema.nullable().optional(),
  /** Окно прибытия пропуска (если для арендатора окно обязательно). */
  windowFrom: InstantInputSchema.optional(),
  windowTo: InstantInputSchema.optional(),
  /** «Что если все места заняты»: занятость лимитов арендатора = вместимости. */
  quotaFull: z.boolean().optional(),
});
export type SandboxCheck = z.infer<typeof SandboxCheckSchema>;

export const SandboxResultSchema = z.object({
  verdict: VerdictSchema,
  /** Как понят запрос — названия и момент в поясе объекта. */
  subject: z.object({
    tenantName: z.string(),
    gateName: z.string(),
    categoryName: z.string().nullable(),
    plateNorm: z.string().nullable(),
    atLabel: z.string(),
    directionLabel: z.string(),
    passTypeLabel: z.string(),
  }),
  /** Что в песочнице допущено условно (пропуск воображаемый: срок «сейчас ± сутки»). */
  assumptions: z.array(z.string()),
});

export const SandboxExampleSchema = z.object({
  /** Стабильный ключ примера: `allow`, `full`, `wrong_gate`, `blacklist`, `blocked`, `pedestrian`. */
  key: z.string(),
  title: z.string(),
  request: SandboxCheckSchema,
  code: z.string(),
  color: z.enum(['green', 'orange', 'yellow', 'blue', 'red']),
  headline: z.string(),
});
export const SandboxExamplesSchema = z.object({
  items: z.array(SandboxExampleSchema),
  /** Почему примеров мало (нет арендаторов, КПП, лимитов…). */
  note: z.string().nullable(),
});

/** «Что будет, если»: изменить лимит и увидеть, кто окажется сверх. */
export const QuotaWhatIfSchema = z.strictObject({
  quotaId: IdSchema,
  capacity: z.int().min(0).max(100000).optional(),
  enforcement: QuotaEnforcementSchema.optional(),
});
export const QuotaWhatIfResultSchema = z.object({
  quotaId: IdSchema,
  quotaName: z.string(),
  tenantName: z.string(),
  occupied: z.int(),
  currentCapacity: z.int(),
  proposedCapacity: z.int(),
  currentEnforcement: QuotaEnforcementSchema,
  proposedEnforcement: QuotaEnforcementSchema,
  /** Сколько машин (людей) окажется сверх нового лимита. */
  overBy: z.int(),
  /** Внутри сейчас, по времени въезда; `over` — окажутся сверх (последние въехавшие). */
  inside: z.array(
    z.object({
      visitId: IdSchema,
      plate: z.string().nullable(),
      personName: z.string().nullable(),
      categoryName: z.string().nullable(),
      timeIn: z.string().nullable(),
      over: z.boolean(),
    }),
  ),
  summary: z.string(),
});

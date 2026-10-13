import { z } from 'zod';
import { TenantStatusSchema } from '../enums';
import { IdSchema, InstantSchema } from './common';
import { PlateCountryHintSchema } from './passes';
import { LocalDateSchema } from './tenants';

// Кабинет арендатора (этап 7a): контекст шапки и форм, автопарк, сводка «сегодня», повтор дня.

/**
 * Всё, что кабинету нужно знать об арендаторе и объекте: шапка («компания · объект, пояс»), списки
 * для форм, названия для таблиц. Один запрос вместо пяти; доступен тому, кто видит пропуска арендатора.
 */
export const CabinetContextSchema = z.object({
  tenant: z.object({
    id: IdSchema,
    name: z.string(),
    status: TenantStatusSchema,
    isOperator: z.boolean(),
    trucksDockRequired: z.boolean(),
    defaultCategoryId: IdSchema.nullable(),
    /** Окончание действующего договора, местная дата; `null` — без срока или договор не ведётся. */
    contractValidTo: LocalDateSchema.nullable(),
  }),
  site: z.object({
    id: IdSchema,
    name: z.string(),
    timezone: z.string(),
    /** «Челябинск, UTC+5» — подпись пояса, в котором показывается всё время. */
    timezoneLabel: z.string(),
  }),
  /** Все включённые типы транспорта объекта (для названий в списках) и признак «доступен арендатору». */
  categories: z.array(
    z.object({ id: IdSchema, name: z.string(), dockEligible: z.boolean(), available: z.boolean() }),
  ),
  zones: z.array(z.object({ id: IdSchema, name: z.string() })),
  purposes: z.array(z.object({ id: IdSchema, name: z.string() })),
  docks: z.array(z.object({ id: IdSchema, number: z.string() })),
  /** Сегодняшняя местная дата объекта. */
  today: LocalDateSchema,
  now: InstantSchema,
});
export type CabinetContext = z.infer<typeof CabinetContextSchema>;

/** Сводка главной: «сегодня» по местным суткам объекта. */
export const TenantTodaySchema = z.object({
  date: LocalDateSchema,
  /** Согласованные пропуска на сегодня, по которым машина или человек ещё не въезжали. */
  expected: z.int(),
  entered: z.int(),
  exited: z.int(),
  /** Отказы на КПП сегодня (по арендатору). */
  refused: z.int(),
  /** Ждут согласования сейчас. */
  pendingApproval: z.int(),
  /** Сколько машин сейчас на территории. */
  inside: z.int(),
});

// --- автопарк ---

const brand = z.string().trim().max(100);
const driverName = z.string().trim().max(200);
const driverPhone = z.string().trim().max(30);

export const FleetVehicleViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  plateRaw: z.string(),
  plateNorm: z.string(),
  plateCountry: z.string(),
  categoryId: IdSchema,
  brand: z.string().nullable(),
  driverName: z.string().nullable(),
  driverPhone: z.string().nullable(),
});

/** Номер — как ввели: сервер нормализует сам (A10). */
export const FleetVehicleCreateSchema = z.strictObject({
  plate: z.string().trim().min(1, 'Укажите номер машины').max(30),
  plateCountry: PlateCountryHintSchema.optional(),
  categoryId: IdSchema,
  brand: brand.nullable().optional(),
  driverName: driverName.nullable().optional(),
  driverPhone: driverPhone.nullable().optional(),
});
export const FleetVehiclePatchSchema = FleetVehicleCreateSchema.partial();
/** Строка пакета: пустой номер — ошибка этой строки (с полем), а не всей пачки. */
export const FleetBatchItemSchema = FleetVehicleCreateSchema.extend({
  plate: z.string().trim().max(30),
});
export const FleetBatchSchema = z.strictObject({
  items: z.array(FleetBatchItemSchema).min(1, 'Добавьте хотя бы одну машину').max(500),
  dryRun: z.boolean().optional(),
});

// --- повтор дня ---

/**
 * «Повторить вчерашний день»: разовые пропуска арендатора, начинавшиеся в `sourceDate` (местная дата
 * объекта), создаются заново на `targetDate` с теми же часами. Предпросмотр и создание — тот же пакет.
 */
export const PassRepeatSchema = z.strictObject({
  sourceDate: LocalDateSchema,
  targetDate: LocalDateSchema,
  dryRun: z.boolean().optional(),
});

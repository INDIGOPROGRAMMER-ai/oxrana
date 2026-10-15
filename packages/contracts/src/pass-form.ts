import { z } from 'zod';
import { PASS_TYPES, type PassStatus, type PassType, PassTypeSchema } from './enums';

/**
 * Настройка формы пропуска по уровням «объект → арендатор → сотрудник» (этап 7b, ADR-023).
 * Нижний уровень переопределяет верхний ключ за ключом; «сбросить к уровню выше» — удалить ключ.
 * Всё здесь — чистые функции и схемы: одно и то же разрешение настроек считает сервер (проверка при
 * создании и правке) и веб (форма и живой предпросмотр в редакторе).
 */

/** Поле формы: скрыто (в форме нет, сервер не принимает значение) · необязательно · обязательно. */
export const FIELD_MODES = ['hidden', 'optional', 'required'] as const;
export const FieldModeSchema = z.enum(FIELD_MODES);
export type FieldMode = (typeof FIELD_MODES)[number];

/**
 * Окно прибытия, кроме трёх режимов поля, может следовать политике окон прибытия (Настройки →
 * Окна): обязательно, если политика так говорит. Это и есть значение по умолчанию.
 */
export const WINDOW_MODES = ['policy', 'hidden', 'optional', 'required'] as const;
export const WindowModeSchema = z.enum(WINDOW_MODES);
export type WindowMode = (typeof WINDOW_MODES)[number];

/** Настраиваемые поля формы и их подписи (порядок — порядок в редакторе). */
export const PASS_FORM_FIELD_LABELS = {
  brand: 'Марка',
  driverName: 'ФИО водителя',
  driverPhone: 'Телефон водителя',
  window: 'Окно прибытия',
  destination: 'Место назначения',
  purpose: 'Цель визита',
  comment: 'Комментарий',
} as const;
export type PassFormFieldKey = keyof typeof PASS_FORM_FIELD_LABELS;
/** Режим каждого поля: окно, кроме трёх режимов поля, может следовать политике окон. */
export type PassFormFieldModes = {
  [K in PassFormFieldKey]: K extends 'window' ? WindowMode : FieldMode;
};
export const passFormFieldKeys = Object.keys(PASS_FORM_FIELD_LABELS) as PassFormFieldKey[];

/** Подписи значений для редактора и подписей «откуда значение». */
export const FIELD_MODE_LABELS: Record<WindowMode, string> = {
  policy: 'По политике окон прибытия',
  hidden: 'Скрыто',
  optional: 'Необязательно',
  required: 'Обязательно',
};

/** Уровень настройки. */
export const PASS_FORM_LEVELS = ['site', 'tenant', 'user'] as const;
export const PassFormLevelSchema = z.enum(PASS_FORM_LEVELS);
export type PassFormLevel = (typeof PASS_FORM_LEVELS)[number];

/** Откуда взято значение: код программы («по умолчанию») или один из уровней. */
export const PASS_FORM_SOURCES = ['default', 'site', 'tenant', 'user'] as const;
export const PassFormSourceSchema = z.enum(PASS_FORM_SOURCES);
export type PassFormSource = (typeof PASS_FORM_SOURCES)[number];

export const PASS_FORM_SOURCE_LABELS: Record<PassFormSource, string> = {
  default: 'по умолчанию',
  site: 'с уровня объекта',
  tenant: 'с уровня арендатора',
  user: 'настроено для сотрудника',
};

/** Сколько часов действует разовый пропуск, если окончание не указано (по умолчанию). */
export const DEFAULT_SINGLE_HOURS = 23;

/** Время начала в форме подставляется само: «сейчас» по поясу объекта (по умолчанию включено). */
export const DEFAULT_START_NOW = true;

/**
 * Кнопка «Повторить вчера» (7b.2): по умолчанию **не показывать** — разовые машины приезжают
 * непредсказуемо, а кто ездит несколько дней, тому оформляют многоразовый пропуск. Включается на
 * уровнях «объект» и «арендатор»; на уровне сотрудника не задаётся.
 */
export const DEFAULT_REPEAT_YESTERDAY = false;

const fieldsShape = {
  brand: FieldModeSchema,
  driverName: FieldModeSchema,
  driverPhone: FieldModeSchema,
  window: WindowModeSchema,
  destination: FieldModeSchema,
  purpose: FieldModeSchema,
  comment: FieldModeSchema,
} as const;

/**
 * Значения по умолчанию (уровень «по умолчанию» — в коде). ФИО и телефон водителя скрыты. Окно
 * прибытия скрыто (7b.1): оно нужно там, где есть расписание доков, и включается в настройке формы;
 * если политика окон его требует, сервер ставит окно на весь срок пропуска.
 */
export const PASS_FORM_DEFAULTS = {
  fields: {
    brand: 'optional',
    driverName: 'hidden',
    driverPhone: 'hidden',
    window: 'hidden',
    destination: 'optional',
    purpose: 'optional',
    comment: 'optional',
  } satisfies PassFormFieldModes,
  passTypes: [...PASS_TYPES] as PassType[],
  defaultPassType: 'single' as PassType,
  singleHours: DEFAULT_SINGLE_HOURS,
  startNow: DEFAULT_START_NOW,
  repeatYesterday: DEFAULT_REPEAT_YESTERDAY,
} as const;

/**
 * Настройки одного уровня — только то, что на этом уровне задано. Типы транспорта: подмножество
 * доступных арендатору (лимит 0 всё равно скрывает тип); виды пропусков — не шире прав роли.
 */
export const PassFormSettingsSchema = z.strictObject({
  categoryIds: z.array(z.uuid()).min(1, 'Оставьте хотя бы один тип транспорта').optional(),
  defaultCategoryId: z.uuid().optional(),
  passTypes: z.array(PassTypeSchema).min(1, 'Оставьте хотя бы один вид пропуска').optional(),
  defaultPassType: PassTypeSchema.optional(),
  fields: z
    .strictObject(
      Object.fromEntries(Object.entries(fieldsShape).map(([k, v]) => [k, v.optional()])) as {
        [K in PassFormFieldKey]: z.ZodOptional<(typeof fieldsShape)[K]>;
      },
    )
    .optional(),
  /** Окончание разового пропуска, если не указано: начало + столько часов (не больше максимума объекта). */
  singleHours: z.int().min(1).max(168).optional(),
  /** Время начала в форме — «сейчас» по поясу объекта, подставлено само (иначе поле пустое). */
  startNow: z.boolean().optional(),
  /** Показывать кнопку «Повторить вчера» (уровни «объект» и «арендатор»). */
  repeatYesterday: z.boolean().optional(),
});
export type PassFormSettings = z.infer<typeof PassFormSettingsSchema>;

/** Изменение уровня: `null` — сбросить ключ к уровню выше (PATCH только изменённых полей). */
export const PassFormSettingsPatchSchema = z.strictObject({
  categoryIds: z
    .array(z.uuid())
    .min(1, 'Оставьте хотя бы один тип транспорта')
    .nullable()
    .optional(),
  defaultCategoryId: z.uuid().nullable().optional(),
  passTypes: z
    .array(PassTypeSchema)
    .min(1, 'Оставьте хотя бы один вид пропуска')
    .nullable()
    .optional(),
  defaultPassType: PassTypeSchema.nullable().optional(),
  fields: z
    .strictObject(
      Object.fromEntries(
        Object.entries(fieldsShape).map(([k, v]) => [k, v.nullable().optional()]),
      ) as { [K in PassFormFieldKey]: z.ZodOptional<z.ZodNullable<(typeof fieldsShape)[K]>> },
    )
    .optional(),
  singleHours: z.int().min(1).max(168).nullable().optional(),
  startNow: z.boolean().nullable().optional(),
  repeatYesterday: z.boolean().nullable().optional(),
  /** Причина изменения — в журнал. */
  reason: z.string().trim().min(3).max(500).optional(),
});
export type PassFormSettingsPatch = z.infer<typeof PassFormSettingsPatchSchema>;

/** Применить изменение к настройкам уровня: `null` удаляет ключ, остальное заменяет. */
export function applyPassFormPatch(
  stored: PassFormSettings,
  patch: Omit<PassFormSettingsPatch, 'reason'>,
): PassFormSettings {
  const next: Record<string, unknown> = { ...stored };
  for (const key of [
    'categoryIds',
    'defaultCategoryId',
    'passTypes',
    'defaultPassType',
    'singleHours',
    'startNow',
    'repeatYesterday',
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (patch.fields !== undefined) {
    const fields: Record<string, unknown> = { ...(stored.fields ?? {}) };
    for (const [key, value] of Object.entries(patch.fields)) {
      if (value === undefined) continue;
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
    if (Object.keys(fields).length === 0) delete next.fields;
    else next.fields = fields;
  }
  return PassFormSettingsSchema.parse(next);
}

export interface PassFormLayers {
  readonly site?: PassFormSettings | null | undefined;
  readonly tenant?: PassFormSettings | null | undefined;
  readonly user?: PassFormSettings | null | undefined;
}

/** Итог разрешения: значение каждой настройки и уровень, с которого оно взято. */
export interface ResolvedPassForm {
  readonly passTypes: PassType[];
  readonly defaultPassType: PassType;
  /** `null` — без ограничения: все типы, доступные арендатору. */
  readonly categoryIds: string[] | null;
  /** `null` — не задан на уровнях (форма берёт тип по умолчанию арендатора или единственный). */
  readonly defaultCategoryId: string | null;
  readonly fields: PassFormFieldModes;
  readonly singleHours: number;
  /** Время начала подставляется само («сейчас» по поясу объекта). */
  readonly startNow: boolean;
  /** Показывать кнопку «Повторить вчера». */
  readonly repeatYesterday: boolean;
  readonly sources: {
    readonly passTypes: PassFormSource;
    readonly defaultPassType: PassFormSource;
    readonly categoryIds: PassFormSource;
    readonly defaultCategoryId: PassFormSource;
    readonly singleHours: PassFormSource;
    readonly startNow: PassFormSource;
    readonly repeatYesterday: PassFormSource;
    readonly fields: Record<PassFormFieldKey, PassFormSource>;
  };
  /** Что пришлось поправить, чтобы настройки не противоречили друг другу (показывает редактор). */
  readonly notes: string[];
}

export const ResolvedPassFormSchema = z.object({
  passTypes: z.array(PassTypeSchema),
  defaultPassType: PassTypeSchema,
  categoryIds: z.array(z.uuid()).nullable(),
  defaultCategoryId: z.uuid().nullable(),
  fields: z.object(fieldsShape),
  singleHours: z.int(),
  startNow: z.boolean(),
  repeatYesterday: z.boolean(),
  sources: z.object({
    passTypes: PassFormSourceSchema,
    defaultPassType: PassFormSourceSchema,
    categoryIds: PassFormSourceSchema,
    defaultCategoryId: PassFormSourceSchema,
    singleHours: PassFormSourceSchema,
    startNow: PassFormSourceSchema,
    repeatYesterday: PassFormSourceSchema,
    fields: z.object(
      Object.fromEntries(passFormFieldKeys.map((k) => [k, PassFormSourceSchema])) as {
        [K in PassFormFieldKey]: typeof PassFormSourceSchema;
      },
    ),
  }),
  notes: z.array(z.string()),
});

const ORDER: readonly PassFormLevel[] = ['site', 'tenant', 'user'];

/**
 * Разрешение настроек: «по умолчанию» → объект → арендатор → сотрудник; нижний уровень
 * переопределяет верхний по каждому ключу отдельно (а поля формы — по каждому полю).
 */
export function resolvePassForm(layers: PassFormLayers): ResolvedPassForm {
  const notes: string[] = [];
  let passTypes: PassType[] = [...PASS_FORM_DEFAULTS.passTypes];
  let defaultPassType: PassType = PASS_FORM_DEFAULTS.defaultPassType;
  let categoryIds: string[] | null = null;
  let defaultCategoryId: string | null = null;
  let singleHours: number = PASS_FORM_DEFAULTS.singleHours;
  let startNow: boolean = PASS_FORM_DEFAULTS.startNow;
  let repeatYesterday: boolean = PASS_FORM_DEFAULTS.repeatYesterday;
  const fields: Record<PassFormFieldKey, WindowMode> = { ...PASS_FORM_DEFAULTS.fields };
  const sources = {
    passTypes: 'default' as PassFormSource,
    defaultPassType: 'default' as PassFormSource,
    categoryIds: 'default' as PassFormSource,
    defaultCategoryId: 'default' as PassFormSource,
    singleHours: 'default' as PassFormSource,
    startNow: 'default' as PassFormSource,
    repeatYesterday: 'default' as PassFormSource,
    fields: Object.fromEntries(passFormFieldKeys.map((k) => [k, 'default'])) as Record<
      PassFormFieldKey,
      PassFormSource
    >,
  };
  for (const level of ORDER) {
    const layer = layers[level];
    if (!layer) continue;
    if (layer.passTypes) {
      passTypes = [...layer.passTypes];
      sources.passTypes = level;
    }
    if (layer.defaultPassType) {
      defaultPassType = layer.defaultPassType;
      sources.defaultPassType = level;
    }
    if (layer.categoryIds) {
      categoryIds = [...layer.categoryIds];
      sources.categoryIds = level;
    }
    if (layer.defaultCategoryId) {
      defaultCategoryId = layer.defaultCategoryId;
      sources.defaultCategoryId = level;
    }
    if (layer.singleHours) {
      singleHours = layer.singleHours;
      sources.singleHours = level;
    }
    if (layer.startNow !== undefined) {
      startNow = layer.startNow;
      sources.startNow = level;
    }
    // кнопку «Повторить вчера» задают объект и арендатор; значение уровня сотрудника не действует
    if (layer.repeatYesterday !== undefined && level !== 'user') {
      repeatYesterday = layer.repeatYesterday;
      sources.repeatYesterday = level;
    }
    for (const key of passFormFieldKeys) {
      const mode = layer.fields?.[key];
      if (mode) {
        fields[key] = mode;
        sources.fields[key] = level;
      }
    }
  }
  // Виды пропусков — в порядке single · multi · permanent, а не в порядке записи.
  passTypes = PASS_TYPES.filter((t) => passTypes.includes(t));
  if (!passTypes.includes(defaultPassType)) {
    const fallback = passTypes[0] ?? 'single';
    notes.push('Вид пропуска по умолчанию недоступен в этой форме — выбран первый из доступных.');
    defaultPassType = fallback;
  }
  if (categoryIds && defaultCategoryId && !categoryIds.includes(defaultCategoryId)) {
    notes.push('Тип транспорта по умолчанию не входит в список доступных и не используется.');
    defaultCategoryId = null;
  }
  return {
    passTypes,
    defaultPassType,
    categoryIds,
    defaultCategoryId,
    fields: fields as PassFormFieldModes,
    singleHours,
    startNow,
    repeatYesterday,
    sources,
    notes,
  };
}

/** Настройки, при которых форма ничего не ограничивает (сотрудники оператора). */
export function unrestrictedPassForm(): ResolvedPassForm {
  return resolvePassForm({});
}

/** Нужно ли поле при данном режиме и политике окон; `policyRequires` — для окна. */
export function fieldIsRequired(mode: WindowMode, policyRequires = false): boolean {
  return mode === 'required' || (mode === 'policy' && policyRequires);
}

export function fieldIsHidden(mode: WindowMode): boolean {
  return mode === 'hidden';
}

/**
 * Окончание разового пропуска по умолчанию: начало + N часов, но не больше максимума объекта.
 * Возвращает миллисекунды окончания.
 */
export function defaultSingleEnd(startMs: number, singleHours: number, maxHours: number): number {
  return startMs + Math.min(singleHours, maxHours) * 3_600_000;
}

/** Подписи статусов пропуска (кабинет, выгрузка): один источник. Термины — `docs/GLOSSARY.md`. */
export const PASS_STATUS_LABELS: Record<PassStatus, string> = {
  draft: 'Черновик',
  pending_approval: 'На согласовании',
  approved: 'Действует',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
  expired: 'Закончился',
  used: 'Использован',
};

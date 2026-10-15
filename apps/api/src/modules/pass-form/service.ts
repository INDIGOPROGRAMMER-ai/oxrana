import {
  defaultSingleEnd,
  PASS_FORM_FIELD_LABELS,
  type PassFormFieldKey,
  type PassFormLevel,
  type PassFormSettings,
  PassFormSettingsSchema,
  type ResolvedPassForm,
  resolvePassForm,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq, isNull, or } from 'drizzle-orm';
import { isTenantUser } from '../../actor';
import type { Scope } from '../../core/context';
import type { TenantRow } from '../../core/loaders';
import { AppError } from '../../errors';
import type { PassContext, PassField, PassValues } from '../passes/validate';
import { PASS_TYPE_LABEL, windowRequiredByPolicy } from '../passes/validate';

/**
 * Настройка формы пропуска по уровням (этап 7b, ADR-023): загрузка уровней, разрешение для
 * актора и проверка пропуска по форме. Сервер применяет те же ограничения, что рисует форма:
 * недоступный тип транспорта, вид пропуска или скрытое поле — ошибка с названием причины.
 */

export interface FormLayers {
  readonly site: PassFormSettings;
  readonly tenant: PassFormSettings;
  readonly user: PassFormSettings | null;
}

function parseSettings(raw: unknown): PassFormSettings {
  const parsed = PassFormSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** Уровни, как они сохранены; `userId` — сотрудник, чей уровень нужен (или `null`). */
export async function loadFormLayers(
  s: Scope,
  siteId: string,
  tenantId: string,
  userId: string | null,
): Promise<FormLayers> {
  const rows = await s.db
    .select()
    .from(schema.passFormSettings)
    .where(
      and(
        eq(schema.passFormSettings.organizationId, s.organizationId),
        eq(schema.passFormSettings.siteId, siteId),
        or(
          eq(schema.passFormSettings.level, 'site'),
          and(
            eq(schema.passFormSettings.tenantId, tenantId),
            userId === null
              ? isNull(schema.passFormSettings.userId)
              : or(
                  isNull(schema.passFormSettings.userId),
                  eq(schema.passFormSettings.userId, userId),
                ),
          ),
        ),
      ),
    );
  const pick = (level: PassFormLevel) => rows.find((r) => r.level === level);
  const user = userId === null ? null : pick('user');
  return {
    site: parseSettings(pick('site')?.settings),
    tenant: parseSettings(pick('tenant')?.settings),
    user: user ? parseSettings(user.settings) : null,
  };
}

export interface ActorForm {
  readonly form: ResolvedPassForm;
  /** Сервер ограничивает создание и правку по форме (пользователь арендатора). */
  readonly enforced: boolean;
}

/**
 * Форма актора: пользователь арендатора — три уровня и проверка на сервере; сотрудник оператора —
 * уровни объекта и арендатора для показа, без ограничения (его ограничивают только права роли).
 */
export async function loadActorForm(s: Scope, tenant: TenantRow): Promise<ActorForm> {
  const actor = s.ctx.actor;
  const tenantUser = isTenantUser(actor);
  const layers = await loadFormLayers(
    s,
    tenant.siteId,
    tenant.id,
    tenantUser && actor.kind === 'user' ? actor.id : null,
  );
  return { form: resolvePassForm(layers), enforced: tenantUser };
}

/**
 * Форма с поправками, которые форма скрыть не может: окно у постоянного пропуска, когда политика
 * окон его требует (у постоянного нет срока, на весь срок окно не поставить), и комментарий, который
 * требует политика согласования (`commentRequired`).
 */
export function adjustedForm(
  ctx: PassContext,
  form: ResolvedPassForm,
  values: PassValues,
  commentRequired = false,
): ResolvedPassForm {
  const fields = { ...form.fields };
  if (commentRequired && fields.comment === 'hidden') fields.comment = 'optional';
  // Скрытое окно открывается (необязательным): обязательным его делает политика окон — ошибкой
  // «window_required» с её текстом, а не «обязательно по настройке формы».
  if (
    values.passType === 'permanent' &&
    fields.window === 'hidden' &&
    windowRequiredByPolicy(ctx, values)
  ) {
    fields.window = 'optional';
  }
  return { ...form, fields };
}

const hiddenError = (key: PassFormFieldKey, field: string) =>
  new AppError('field_hidden', {
    field,
    message: `Поле «${PASS_FORM_FIELD_LABELS[key]}» для вас отключено в настройке формы пропуска. Уберите значение; включить поле может администратор объекта или ответственный вашей компании.`,
  });

const requiredError = (key: PassFormFieldKey, field: string) =>
  new AppError('field_required', {
    field,
    message: `Поле «${PASS_FORM_FIELD_LABELS[key]}» обязательно по настройке формы пропуска.`,
  });

/** Поле формы → колонки пропуска и имя поля в API (для ошибки у нужного поля). */
const FIELD_COLUMNS: Record<PassFormFieldKey, readonly (keyof PassValues)[]> = {
  brand: ['brand'],
  driverName: ['driverName'],
  driverPhone: ['driverPhone'],
  window: ['windowFrom', 'windowTo'],
  destination: ['destinationZoneId'],
  purpose: ['purposeId'],
  comment: ['comment'],
};
/** Поля, которые есть только у машины. */
const VEHICLE_ONLY = new Set<PassFormFieldKey>(['brand', 'driverName', 'driverPhone', 'window']);

/**
 * Проверка пропуска по форме. `touched` — какие колонки задаёт запрос: при правке проверяются
 * только они (поле, ставшее обязательным позже, не мешает поправить комментарий). Вид пропуска
 * проверяется при создании, тип транспорта — когда его задают. Окно «по политике» здесь не
 * проверяется: его требует и заполняет `validatePass` / `fillWindow`.
 */
export function assertFormAllows(
  ctx: PassContext,
  form: ResolvedPassForm,
  values: PassValues,
  touched: ReadonlySet<PassField> | 'all',
): void {
  const isTouched = (field: PassField) => touched === 'all' || touched.has(field);

  if (touched === 'all' && !form.passTypes.includes(values.passType)) {
    const allowed = form.passTypes.map((t) => PASS_TYPE_LABEL[t].toLowerCase()).join(', ');
    throw new AppError('pass_type_forbidden', {
      field: 'passType',
      message: `Вид пропуска «${PASS_TYPE_LABEL[values.passType].toLowerCase()}» для вас отключён в настройке формы. Доступно: ${allowed}. Изменить может администратор объекта или ответственный вашей компании.`,
    });
  }

  if (values.participant === 'vehicle' && values.categoryId && isTouched('categoryId')) {
    if (form.categoryIds && !form.categoryIds.includes(values.categoryId)) {
      const name = ctx.rules.categories.find((c) => c.id === values.categoryId)?.name ?? 'этот тип';
      const allowed = form.categoryIds
        .map((id) => ctx.rules.categories.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n))
        .join(', ');
      throw new AppError('category_unavailable', {
        field: 'categoryId',
        message: `Тип «${name}» для вас отключён в настройке формы${allowed ? `. Доступно: ${allowed}` : ''}. Изменить может администратор объекта или ответственный вашей компании.`,
      });
    }
  }

  for (const key of Object.keys(FIELD_COLUMNS) as PassFormFieldKey[]) {
    if (VEHICLE_ONLY.has(key) && values.participant !== 'vehicle') continue;
    const columns = FIELD_COLUMNS[key];
    if (!columns.some((c) => isTouched(c))) continue;
    const mode = form.fields[key];
    const field = columns[0] as string;
    const filled = columns.some((c) => values[c] !== null && values[c] !== undefined);
    if (mode === 'hidden' && filled) throw hiddenError(key, field);
    if (mode === 'required' && !filled) throw requiredError(key, field);
  }
}

/**
 * Автопарк по форме (7b.2): колонки и поля машины автопарка берутся из той же настройки формы, что и
 * пропуск. Скрытое поле значение не принимает; обязательное — нужно при добавлении машины, а при
 * правке — только если его задают. Сервер проверяет так же, как форму.
 */
export function assertFleetFormAllows(
  form: ResolvedPassForm,
  input: Readonly<Record<string, unknown>>,
  creating: boolean,
): void {
  const keys: readonly (readonly [PassFormFieldKey, string])[] = [
    ['brand', 'brand'],
    ['driverName', 'driverName'],
    ['driverPhone', 'driverPhone'],
    ['comment', 'comment'],
  ];
  for (const [key, field] of keys) {
    const given = field in input;
    const value = input[field];
    const filled =
      typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;
    const mode = form.fields[key];
    if (mode === 'hidden' && filled) throw hiddenError(key, field);
    if (mode === 'required' && (creating || given) && !filled) throw requiredError(key, field);
  }
}

/**
 * Заполнение значений по умолчанию (ADR-023). Разовый пропуск: начало — «сейчас» (по часам
 * сервера), окончание — начало + N часов, но не больше максимума объекта. Окно прибытия: если
 * политика окон требует его, а форма — нет, окно = весь срок пропуска (разовый и многоразовый).
 */
export function fillDefaults(
  ctx: PassContext,
  form: ResolvedPassForm,
  values: PassValues,
): PassValues {
  const next = { ...values };
  if (next.passType === 'single') {
    next.validFrom ??= new Date(ctx.now);
    next.validTo ??= new Date(
      defaultSingleEnd(next.validFrom.getTime(), form.singleHours, ctx.settings.singlePassMaxHours),
    );
  }
  const mode = form.fields.window;
  if (
    next.participant === 'vehicle' &&
    (mode === 'optional' || mode === 'hidden') &&
    next.windowFrom === null &&
    next.windowTo === null &&
    next.validFrom &&
    next.validTo &&
    next.passType !== 'permanent' &&
    windowRequiredByPolicy(ctx, next)
  ) {
    next.windowFrom = next.validFrom;
    next.windowTo = next.validTo;
  }
  return next;
}

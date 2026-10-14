import {
  type CabinetContext,
  type FieldMode,
  type PassFormFieldKey,
  type PassType,
  passFormFieldKeys,
  type ResolvedPassForm,
} from '@oxrana/contracts';
import type { EffectiveFields } from './pass-form';

/**
 * Что показывает форма пропуска (ADR-023): итог настройки по уровням «объект → арендатор →
 * сотрудник» и справочников компании. Одна функция на форму сотрудника и на живой предпросмотр
 * в редакторе — предпросмотр показывает ровно то, что увидит выбранный сотрудник.
 */
export interface FormViewInput {
  readonly form: ResolvedPassForm;
  readonly ctx: Pick<CabinetContext, 'tenant' | 'categories' | 'zones' | 'purposes' | 'docks'>;
  /** Сервер ограничивает форму (пользователь арендатора); иначе типы и виды не сужаются. */
  readonly enforced: boolean;
  /** Виды пропусков, разрешённые правами роли и политикой согласования (из подсказок сервера). */
  readonly allowedPassTypes?: readonly PassType[] | undefined;
  /** Окно требует политика окон прибытия (подсказка сервера): режим «по политике» становится «обязательно». */
  readonly windowRequiredByPolicy?: boolean | undefined;
  /** Комментарий требует политика согласования. */
  readonly commentRequiredByPolicy?: boolean | undefined;
  /** Док обязателен арендатору (грузовые стоят у доков). */
  readonly dockRequired?: boolean | undefined;
}

export interface FormView {
  /** Типы транспорта: доступные арендатору и разрешённые формой. */
  readonly categories: readonly { id: string; name: string }[];
  readonly defaultCategoryId: string;
  /** Виды пропусков в форме; `undefined` — права ещё не пришли. */
  readonly passTypes: readonly PassType[] | undefined;
  readonly defaultPassType: PassType | undefined;
  readonly fields: EffectiveFields;
  readonly zones: readonly { id: string; name: string }[];
  /** Одно доступное место назначения подставлено, пункта «Не указано» тогда нет. */
  readonly defaultZoneId: string;
  readonly zoneUnspecified: boolean;
  readonly docks: readonly { id: string; number: string }[];
  readonly dockRequired: boolean;
  /** Док обязателен, а у арендатора он один — подставлен. */
  readonly defaultDockId: string;
  /** Окно требует политика, а форма — нет: окно будет на весь срок пропуска. */
  readonly singleHours: number;
}

export function buildFormView(input: FormViewInput): FormView {
  const { form, ctx, enforced } = input;
  const available = ctx.categories.filter((c) => c.available);
  const categories = (
    enforced && form.categoryIds
      ? available.filter((c) => form.categoryIds?.includes(c.id))
      : available
  ).map((c) => ({ id: c.id, name: c.name }));

  const pick = (...ids: (string | null | undefined)[]) =>
    ids.find((id): id is string => Boolean(id) && categories.some((c) => c.id === id)) ?? '';
  const defaultCategoryId =
    pick(form.defaultCategoryId, ctx.tenant.defaultCategoryId) ||
    (categories.length === 1 ? (categories[0]?.id ?? '') : '');

  let passTypes: readonly PassType[] | undefined;
  if (input.allowedPassTypes) {
    passTypes = enforced
      ? input.allowedPassTypes.filter((t) => form.passTypes.includes(t))
      : input.allowedPassTypes;
  }
  const defaultPassType = passTypes
    ? passTypes.includes(form.defaultPassType)
      ? form.defaultPassType
      : passTypes[0]
    : undefined;

  const fields = {} as EffectiveFields;
  for (const key of passFormFieldKeys) fields[key] = effectiveMode(key, input);

  const zones = ctx.zones;
  const defaultZoneId =
    fields.destination !== 'hidden' && zones.length === 1 ? (zones[0]?.id ?? '') : '';
  const dockRequired = Boolean(input.dockRequired);
  return {
    categories,
    defaultCategoryId,
    passTypes,
    defaultPassType,
    fields,
    zones,
    defaultZoneId,
    zoneUnspecified: zones.length !== 1,
    docks: ctx.docks,
    dockRequired,
    defaultDockId: dockRequired && ctx.docks.length === 1 ? (ctx.docks[0]?.id ?? '') : '',
    singleHours: form.singleHours,
  };
}

function effectiveMode(key: PassFormFieldKey, input: FormViewInput): FieldMode {
  const mode = input.form.fields[key];
  if (key === 'window') {
    if (mode === 'policy') return input.windowRequiredByPolicy ? 'required' : 'optional';
    return mode;
  }
  // Комментарий, который требует политика согласования, форма скрыть не может.
  if (key === 'comment' && input.commentRequiredByPolicy) return 'required';
  return mode as FieldMode;
}

/** Сколько вторичных полей заполнено или обязательно — число на кнопке «Ещё». */
export function secondaryCount(view: FormView, participant: 'vehicle' | 'pedestrian'): number {
  const keys: PassFormFieldKey[] =
    participant === 'vehicle'
      ? ['brand', 'driverName', 'driverPhone', 'window', 'destination', 'purpose', 'comment']
      : ['destination', 'purpose', 'comment'];
  return keys.filter((k) => view.fields[k] !== 'hidden').length;
}

import { TenantCreateSchema, TenantPatchSchema, type TenantStatus } from '@oxrana/contracts';
import { Badge, Field, type FormController, Input, Select, Switch } from '@oxrana/ui';
import { z } from 'zod';
import { type CategoryView, type TenantView, useApi } from '../../lib/data';

/** Данные одного арендатора (страница арендатора и карточки на ней). */
export function useTenant(tenantId: string | null) {
  return useApi<TenantView>(tenantId ? `/tenants/${tenantId}` : null);
}

export const TENANT_STATUS_LABEL: Record<TenantStatus, string> = {
  active: 'активен',
  blocked_new_passes: 'новые пропуска запрещены',
  blocked_entry: 'въезд запрещён',
  blocked_full: 'заблокирован полностью',
  archived: 'в архиве',
};

const TENANT_STATUS_TONE: Record<TenantStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  blocked_new_passes: 'warning',
  blocked_entry: 'danger',
  blocked_full: 'danger',
  archived: 'neutral',
};

export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  return <Badge tone={TENANT_STATUS_TONE[status]}>{TENANT_STATUS_LABEL[status]}</Badge>;
}

/** Значения формы арендатора: текстовые поля всегда строки, пустая строка = «не задано». */
export interface TenantFormValues {
  legalName: string;
  shortName: string;
  inn: string;
  responsiblePhone: string;
  emergencyPhone: string;
  trucksDockRequired: boolean;
  defaultCategoryId: string;
  isOperator: boolean;
}

const NULLABLE_KEYS = ['inn', 'responsiblePhone', 'emergencyPhone', 'defaultCategoryId'] as const;

/** Пустая строка → `null` у необязательных полей (так сервер понимает «очистить»). */
export function blankToNull(input: object): Record<string, unknown> {
  const out = { ...input } as Record<string, unknown>;
  for (const key of NULLABLE_KEYS) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.trim() === '' ? null : value.trim();
  }
  return out;
}

// Схемы и русские сообщения — из contracts (Q-67): экран не переписывает правила сервера.
export const TenantCreateFormSchema = TenantCreateSchema;
/** Проверка изменённых полей перед PATCH: пустые строки приводятся к `null` до проверки. */
export const TenantPatchFormSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null ? blankToNull(v) : v),
  TenantPatchSchema,
);

/** Поля арендатора — общие для окна создания и карточки «Общее». */
export function TenantFields({
  f,
  categories,
  currentCategoryId,
}: {
  f: FormController<TenantFormValues>;
  categories: readonly CategoryView[];
  /** Тип по умолчанию, сохранённый у арендатора: показывается, даже если тип потом выключили. */
  currentCategoryId?: string | null | undefined;
}) {
  const { register } = f.form;
  const options = categories.filter((c) => c.enabled || c.id === currentCategoryId);
  return (
    <>
      <Field label="Краткое название" required error={f.fieldError('shortName')}>
        <Input {...register('shortName')} maxLength={100} placeholder="Как в списках и на посту" />
      </Field>
      <Field label="Полное название" required error={f.fieldError('legalName')}>
        <Input
          {...register('legalName')}
          maxLength={300}
          placeholder="Как в договоре, с формой собственности"
        />
      </Field>
      <Field
        label="ИНН"
        hint="10 цифр у организации, 12 у предпринимателя. Не обязательно."
        error={f.fieldError('inn')}
      >
        <Input {...register('inn')} inputMode="numeric" maxLength={12} autoComplete="off" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Телефон ответственного"
          hint="Охрана звонит сюда, если нужно решение арендатора."
          error={f.fieldError('responsiblePhone')}
        >
          <Input {...register('responsiblePhone')} type="tel" maxLength={30} />
        </Field>
        <Field
          label="Телефон на случай ЧП"
          hint="Круглосуточный номер для экстренных случаев."
          error={f.fieldError('emergencyPhone')}
        >
          <Input {...register('emergencyPhone')} type="tel" maxLength={30} />
        </Field>
      </div>
      <Field
        label="Тип транспорта по умолчанию"
        hint="Подставляется в новый пропуск арендатора, пока человек не выбрал другой."
        error={f.fieldError('defaultCategoryId')}
      >
        <Select {...register('defaultCategoryId')}>
          <option value="">— нет —</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.enabled ? '' : ' (выключен)'}
            </option>
          ))}
        </Select>
      </Field>
      <Switch
        {...register('trucksDockRequired')}
        label="Грузовые только к докам"
        hint="При оформлении грузового пропуска док обязателен: без него пропуск не сохранится."
      />
      <Switch
        {...register('isOperator')}
        label="Оператор объекта"
        hint="Это сама управляющая компания. Лимиты ей не задают (нет лимита — нет ограничения), сам флаг их не снимает. Машины ездят по общей матрице «тип × КПП»; если руководству нужен любой КПП — заведите исключение на вкладке «Исключения»."
      />
    </>
  );
}

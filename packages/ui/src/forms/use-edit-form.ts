import { useCallback, useMemo, useState } from 'react';
import {
  type DefaultValues,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';
import type { ZodType } from 'zod';
import { type ErrorView, errorView } from '../api';
import type { FieldErrorLike } from '../components/field';

/** Ошибка у поля: из проверки формы или с сервера. */
export type FieldErrors<T extends FieldValues> = (name: FieldPath<T>) => FieldErrorLike | null;

export interface FormController<T extends FieldValues> {
  readonly form: UseFormReturn<T>;
  /** Данные загружены: пока нет — форма заблокирована и пуста (CLAUDE.md п. 5). */
  readonly loaded: boolean;
  readonly submitting: boolean;
  /** Есть что отправлять (в правке — изменённые поля, в создании — всегда). */
  readonly hasChanges: boolean;
  /** Показывать «Сохранено» — только после успешного ответа сервера. */
  readonly saved: boolean;
  /** Общая ошибка (не привязанная к полю) и ошибка поля, которого нет в форме. */
  readonly error: ErrorView | null;
  readonly fieldError: FieldErrors<T>;
  readonly submit: () => Promise<void>;
  readonly reset: () => void;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Применить серверную ошибку: поле формы получает её у себя, остальное — общая. */
function useServerError<T extends FieldValues>(form: UseFormReturn<T>) {
  const [error, setError] = useState<ErrorView | null>(null);
  const apply = useCallback(
    (raw: unknown) => {
      const view = errorView(raw);
      setError(view);
      return view;
    },
    [form],
  );
  return { error, apply, clear: () => setError(null) };
}

/**
 * Форма правки (CLAUDE.md п. 5): без значений по умолчанию, заблокирована, пока запись не
 * загружена; отправляет **только изменённые поля** (PATCH). Если менять нечего — запрос не уходит.
 * «Сохранено» появляется только после успешного ответа сервера; ошибка называет причину и
 * показывается у поля (со ссылкой на настройку, если сервер её дал).
 *
 * `values` — загруженная запись в форме API; смена `values` (после сохранения или обновления с
 * сервера) сбрасывает форму на новые значения.
 */
export function useEditForm<T extends FieldValues>(options: {
  values: T | undefined;
  /** Схема PATCH из `@oxrana/contracts`: проверяет присланные поля до запроса. */
  schema?: ZodType;
  onPatch: (patch: Partial<T>) => Promise<unknown>;
}): FormController<T> & { readonly patch: Partial<T> } {
  const { values, schema, onPatch } = options;
  const form = useForm<T>({ values: values as T, resetOptions: { keepDirtyValues: false } });
  const [submitting, setSubmitting] = useState(false);
  // что именно было сохранено: «Сохранено» держится, пока форма не изменена снова
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const server = useServerError(form);
  const current = form.watch();

  const patch = useMemo(() => {
    if (!values) return {} as Partial<T>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(values)) {
      if (
        !sameValue(
          (current as Record<string, unknown>)[key],
          (values as Record<string, unknown>)[key],
        )
      ) {
        out[key] = (current as Record<string, unknown>)[key];
      }
    }
    return out as Partial<T>;
  }, [current, values]);
  const hasChanges = Object.keys(patch).length > 0;

  const submit = useCallback(async () => {
    if (!values || submitting) return;
    server.clear();
    setSavedKey(null);
    form.clearErrors();
    const body = patch;
    if (Object.keys(body).length === 0) return;
    if (schema) {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const name = String(issue.path[0] ?? '');
          if (name) form.setError(name as FieldPath<T>, { message: issue.message });
        }
        return;
      }
    }
    setSubmitting(true);
    try {
      await onPatch(body);
      setSavedKey(JSON.stringify(body));
    } catch (raw) {
      const view = server.apply(raw);
      if (view.field && view.field in (values as object)) {
        form.setError(view.field as FieldPath<T>, { message: view.message });
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, onPatch, patch, schema, server, submitting, values]);

  const fieldError: FieldErrors<T> = (name) => {
    const own = form.formState.errors[name];
    if (own && typeof own.message === 'string') {
      const link = server.error?.field === name ? server.error.settingLink : null;
      return { message: own.message, settingLink: link };
    }
    return null;
  };

  const generalError =
    server.error && !(server.error.field && values && server.error.field in (values as object))
      ? server.error
      : null;

  return {
    form,
    loaded: values !== undefined,
    submitting,
    hasChanges,
    saved: savedKey !== null && (!hasChanges || JSON.stringify(patch) === savedKey),
    error: generalError,
    fieldError,
    submit,
    reset: () => {
      form.reset(values as DefaultValues<T>);
      server.clear();
      setSavedKey(null);
    },
    patch,
  };
}

/**
 * Форма создания: пустая (никаких молчаливых значений по умолчанию — начальные значения
 * передаёт вызывающий явно), проверка схемой `Create` из `@oxrana/contracts`, отправка всего тела.
 */
export function useCreateForm<T extends FieldValues>(options: {
  schema: ZodType;
  initial: DefaultValues<T>;
  onCreate: (body: unknown) => Promise<unknown>;
  /** Привести значения формы к телу запроса (пустая строка → `null`, числа). */
  toBody?: (values: T) => unknown;
}): FormController<T> {
  const { schema, initial, onCreate, toBody } = options;
  const form = useForm<T>({
    defaultValues: initial,
    // схема описывает тело запроса, а не значения формы — проверяем в `submit` после `toBody`
  });
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const server = useServerError(form);

  const submit = useCallback(async () => {
    if (submitting) return;
    server.clear();
    setSaved(false);
    form.clearErrors();
    const values = form.getValues();
    const body = toBody ? toBody(values) : values;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? '');
        if (name) form.setError(name as FieldPath<T>, { message: issue.message });
      }
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(parsed.data);
      form.reset(initial);
      setSaved(true);
    } catch (raw) {
      const view = server.apply(raw);
      if (view.field && view.field in form.getValues()) {
        form.setError(view.field as FieldPath<T>, { message: view.message });
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, initial, onCreate, schema, server, submitting, toBody]);

  const fieldError: FieldErrors<T> = (name) => {
    const own = form.formState.errors[name];
    if (own && typeof own.message === 'string') {
      return {
        message: own.message,
        settingLink: server.error?.field === name ? server.error.settingLink : null,
      };
    }
    return null;
  };

  const generalError =
    server.error && !(server.error.field && server.error.field in form.getValues())
      ? server.error
      : null;

  return {
    form,
    loaded: true,
    submitting,
    hasChanges: true,
    saved,
    error: generalError,
    fieldError,
    submit,
    reset: () => {
      form.reset(initial);
      server.clear();
      setSaved(false);
    },
  };
}

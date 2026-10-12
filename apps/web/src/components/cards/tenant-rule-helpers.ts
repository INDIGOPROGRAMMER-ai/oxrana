import { ApiError, api, formatInZone } from '@oxrana/ui';
import { useQueries } from '@tanstack/react-query';
import { type ClauseView, useContracts, useMe } from '../../lib/data';

/** Пункт договора арендатора в виде, удобном для выбора основания лимита или назначения. */
export interface ClauseOption {
  readonly id: string;
  /** «п. 3.1» — коротко, для фразы-лимита. */
  readonly ref: string;
  /** «п. 3.1 — Грузовые машины: 25 мест» — для списка выбора. */
  readonly label: string;
}

export interface TenantClauses {
  readonly loading: boolean;
  readonly hasContracts: boolean;
  readonly options: readonly ClauseOption[];
  /** Короткая подпись пункта по id; `null`, если пункта нет в договорах арендатора. */
  readonly refOf: (id: string | null) => string | null;
}

const shorten = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Пункты всех договоров арендатора одним списком (основание лимита и назначения дока).
 * Ключи запросов — `['data', путь]`, как у `useApi`: обновляются вместе с остальными данными.
 */
export function useTenantClauses(tenantId: string | null): TenantClauses {
  const contracts = useContracts(tenantId);
  const list = contracts.items ?? [];
  const results = useQueries({
    queries: list.map((c) => ({
      queryKey: ['data', `/contracts/${c.id}/clauses`],
      queryFn: () => api<{ items: ClauseView[] }>(`/contracts/${c.id}/clauses`),
    })),
  });
  const options: ClauseOption[] = [];
  list.forEach((contract, index) => {
    const suffix = list.length > 1 && contract.number ? ` (договор ${contract.number})` : '';
    for (const clause of results[index]?.data?.items ?? []) {
      options.push({
        id: clause.id,
        ref: `п. ${clause.ref}`,
        label: `п. ${clause.ref}${suffix} — ${shorten(clause.summary)}`,
      });
    }
  });
  return {
    loading: contracts.isLoading || results.some((r) => r.isLoading),
    hasContracts: list.length > 0,
    options,
    refOf: (id) => (id === null ? null : (options.find((o) => o.id === id)?.ref ?? null)),
  };
}

/** Права текущего пользователя: пока профиль грузится, `loaded = false` (запросы не блокируем). */
export function usePermissions() {
  const { me, can } = useMe();
  return { loaded: me !== undefined, can };
}

/**
 * Сегодняшняя дата **в поясе объекта** (`ГГГГ-ММ-ДД`): пояс браузера не используется (ADR-009).
 */
export function siteToday(timezone: string): string {
  const [day = '', month = '', year = ''] = formatInZone(new Date().toISOString(), timezone)
    .slice(0, 10)
    .split('.');
  return `${year}-${month}-${day}`;
}

/** Ошибка поля с понятным текстом: форма покажет её у поля, как ошибку сервера. */
export function fieldProblem(field: string | null, message: string): ApiError {
  return new ApiError(422, { code: 'validation_failed', message, field, settingLink: null });
}

/**
 * Целое число из текста поля. Пусто: `null`, если пустое допустимо, иначе — ошибка у поля.
 * Проверка границ даёт русский текст вместо стандартного сообщения схемы.
 */
export function intFromText(
  field: string,
  text: string,
  options: { label: string; min: number; max?: number; emptyAsNull: true },
): number | null;
export function intFromText(
  field: string,
  text: string,
  options: { label: string; min: number; max?: number; emptyAsNull?: false },
): number;
export function intFromText(
  field: string,
  text: string,
  options: { label: string; min: number; max?: number; emptyAsNull?: boolean },
): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    if (options.emptyAsNull) return null;
    throw fieldProblem(field, `Заполните поле «${options.label}».`);
  }
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isInteger(value)) {
    throw fieldProblem(field, `«${options.label}» — целое число, например ${options.min}.`);
  }
  if (value < options.min || (options.max !== undefined && value > options.max)) {
    const range =
      options.max === undefined
        ? `не меньше ${options.min}`
        : `от ${options.min} до ${options.max}`;
    throw fieldProblem(field, `«${options.label}»: допустимо ${range}.`);
  }
  return value;
}

/** Первая ошибка схемы — ошибкой у поля (для проверки тела PATCH после преобразования значений). */
export function assertValid(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: readonly Issue[] } } },
  body: unknown,
): void {
  const parsed = schema.safeParse(body);
  if (parsed.success) return;
  const issue = parsed.error?.issues[0];
  throw fieldProblem(
    issue ? String(issue.path[0] ?? '') || null : null,
    issue?.message ?? 'Проверьте значения полей.',
  );
}

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

import type { ReactNode } from 'react';
import { ApiError } from './api';

/** Простые элементы экранов этапа 5; полноценный дизайн — `packages/ui` на этапе админки. */
export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: поле ввода приходит в children
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** Текст ошибки: причина и где исправить — как пришло от API. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.message
      : 'Что-то пошло не так. Обновите страницу и повторите.';
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}

export function fieldOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.body.field ?? null) : null;
}

/** Время в поясе объекта с подписью пояса (CLAUDE.md п. 4) — не в поясе браузера. */
export function siteTime(iso: string, timezone: string, label: string): string {
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
  return `${time} (${label})`;
}

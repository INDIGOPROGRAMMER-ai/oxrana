import { createContext, type ReactNode, useContext, useId } from 'react';
import { useLinkComponent } from '../config';
import { cn } from '../lib/cn';

export interface FieldErrorLike {
  readonly message: string;
  readonly settingLink?: string | null;
}

interface FieldState {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly disabled: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

/** Свойства поля ввода, которые ему даёт окружающий `Field`: связь с подписью, ошибкой, блокировка. */
export function useFieldState(): FieldState | null {
  return useContext(FieldContext);
}

/**
 * Поле формы: подпись, подсказка, ошибка у поля со ссылкой на настройку (CLAUDE.md п. 8) и
 * «недоступно, потому что…» — недоступное поле не прячется, а показывается неактивным с причиной.
 */
export function Field({
  label,
  hint,
  error,
  disabledReason,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: FieldErrorLike | null;
  /** Поле неактивно; текст объясняет, почему и что сделать. */
  disabledReason?: string | undefined;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const Link = useLinkComponent();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const reasonId = `${id}-reason`;
  const describedBy =
    [hint ? hintId : null, disabledReason ? reasonId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <FieldContext.Provider
      value={{ id, describedBy, invalid: Boolean(error), disabled: Boolean(disabledReason) }}
    >
      <div className={cn('flex flex-col gap-1.5', className)}>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-destructive">
              *
            </span>
          ) : null}
        </label>
        {children}
        {hint ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {disabledReason ? (
          <p id={reasonId} className="text-xs text-warning">
            {disabledReason}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {error.message}
            {error.settingLink ? (
              <>
                {' '}
                <Link href={error.settingLink} className="font-medium underline">
                  Перейти к настройке
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

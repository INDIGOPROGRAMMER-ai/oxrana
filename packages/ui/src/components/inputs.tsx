import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/cn';
import { useFieldState } from './field';

const control =
  'w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldState();
  return (
    <input
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      disabled={field?.disabled}
      className={cn(control, 'h-9 py-1', className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldState();
  return (
    <textarea
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      disabled={field?.disabled}
      className={cn(control, 'min-h-20 py-2', className)}
      {...props}
    />
  );
}

/** Выпадающий список браузера: надёжно на телефоне и с клавиатуры, без собственной вёрстки. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldState();
  return (
    <select
      id={field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      disabled={field?.disabled}
      className={cn(control, 'h-9 py-1', className)}
      {...props}
    >
      {children}
    </select>
  );
}

/** Флажок с подписью справа; вне `Field` подпись — свой `label`. */
export function Checkbox({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label
      className={cn(
        'flex items-start gap-2 text-sm',
        props.disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        {...props}
      />
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Переключатель «включено / выключено» (флажок с видом переключателя). */
export function Switch({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 text-sm',
        props.disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...props} />
      <span
        aria-hidden
        className="relative mt-0.5 inline-block h-5 w-9 shrink-0 rounded-full bg-input transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-card after:shadow after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
      />
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

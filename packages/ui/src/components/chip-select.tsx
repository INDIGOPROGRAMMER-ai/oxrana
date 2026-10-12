import { cn } from '../lib/cn';

export interface ChipOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

/** Выбор нескольких значений «чипами» (типы транспорта в лимите, КПП в маршруте): флажки с подписью. */
export function ChipSelect({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly ChipOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <fieldset aria-label={label} className="flex min-w-0 flex-wrap gap-2 border-0 p-0">
      {options.map((o) => {
        const checked = value.includes(o.value);
        return (
          <label
            key={o.value}
            title={o.title}
            className={cn(
              'inline-flex cursor-pointer select-none items-center rounded-full border px-3 py-1 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
              checked
                ? 'border-primary bg-accent text-accent-foreground'
                : 'bg-card hover:bg-muted',
              (disabled || o.disabled) && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={checked}
              disabled={disabled || o.disabled}
              onChange={() =>
                onChange(checked ? value.filter((v) => v !== o.value) : [...value, o.value])
              }
            />
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
}

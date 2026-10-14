import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';
import { Select } from './inputs';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly title?: string;
}

export interface SegmentedChoiceProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly 'aria-label': string;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * Выбор одного из нескольких значений кнопками-переключателями рядом (вид пропуска): выбранное
 * видно сразу, один щелчок вместо «открыть список → выбрать». Если кнопки не помещаются в ширину
 * (телефон 360 px, длинные подписи), вместо них — обычный список с теми же значениями.
 */
export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  disabled,
  className,
}: SegmentedChoiceProps<T>) {
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const labels = options.map((o) => o.label).join('|');

  // Кнопки всегда в разметке (при нехватке места — невидимые): по ним видно, когда снова хватает места.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => {
      if (!box.current || !row.current) return;
      setFits(row.current.scrollWidth <= box.current.clientWidth + 1);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [labels]);

  const move = (index: number, delta: number) => {
    const next = options[(index + delta + options.length) % options.length];
    if (next && !disabled) onChange(next.value);
  };

  return (
    <div ref={box} className={cn('relative min-w-0 max-w-full', className)}>
      <div className={cn(!fits && 'invisible absolute inset-x-0 top-0 h-0 overflow-hidden')}>
        <div
          ref={row}
          role="radiogroup"
          aria-label={ariaLabel}
          aria-hidden={fits ? undefined : true}
          className="inline-flex flex-nowrap gap-2"
        >
          {options.map((o, index) => {
            const selected = o.value === value;
            return (
              <Button
                key={o.value}
                role="radio"
                aria-checked={selected}
                tabIndex={fits && selected ? 0 : -1}
                disabled={disabled}
                title={o.title}
                variant={selected ? 'default' : 'outline'}
                className="shrink-0 px-3"
                onClick={() => onChange(o.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    move(index, 1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    move(index, -1);
                  }
                }}
              >
                {o.label}
              </Button>
            );
          })}
        </div>
      </div>
      {fits ? null : (
        <Select
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

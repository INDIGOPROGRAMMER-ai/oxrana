import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { type Control, type FieldPath, type FieldValues, useController } from 'react-hook-form';
import { cn } from '../lib/cn';
import { Button } from './button';
import { useFieldState } from './field';
import { Input } from './inputs';

/**
 * Свой выбор даты и времени (этап 6b): формат всегда ДД.ММ.ГГГГ и ЧЧ:ММ, независимо от языка
 * браузера. Нативный `<input type="date">` показывает дату по локали браузера (у заказчика в Chrome
 * с US-локалью — `mm/dd/yyyy` рядом с подписями `13.10.2026`) и этим сбивает с толку. Наружу значение
 * отдаётся в машинном виде: дата `ГГГГ-ММ-ДД`, время `ЧЧ:ММ`, дата со временем `ГГГГ-ММ-ДДTЧЧ:ММ`.
 * Неполный или несуществующий ввод наружу — пустая строка (форма скажет «заполните»), а под полем
 * сразу видна подсказка о формате.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Маска ввода: цифры → `ДД.ММ.ГГГГ`; вставка `2026-10-13` или `13/10/2026` тоже понимается. */
export function maskDate(text: string): string {
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(text);
  if (iso) return `${pad(Number(iso[3]))}.${pad(Number(iso[2]))}.${iso[1]}`;
  const digits = text.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('.');
}

/** `ДД.ММ.ГГГГ` → `ГГГГ-ММ-ДД`; `null` — не дата (неполная, несуществующая, год до 1900). */
export function parseRuDate(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** `ГГГГ-ММ-ДД` → `ДД.ММ.ГГГГ`; пустое и непонятное — пустая строка. */
export function isoToRuDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/**
 * Часть времени из цифр: «9» → «09», «930» → «09:30», «1200» → «12:00». Цифра, с которой час или
 * минуты не могут начаться (3–9 для часа, 6–9 для минут), получает ведущий нуль. `used` — сколько
 * цифр ушло на эту часть (остальные принадлежат следующему времени в интервале).
 */
function takeTime(digits: string): { text: string; used: number; complete: boolean } {
  let text = '';
  let used = 0;
  const h1 = digits[0];
  if (h1 === undefined) return { text, used, complete: false };
  if (h1 > '2') {
    text = `0${h1}`;
    used = 1;
  } else {
    text = digits.slice(0, 2);
    used = text.length;
  }
  if (text.length < 2) return { text, used, complete: false };
  const m1 = digits[used];
  if (m1 === undefined) return { text, used, complete: false };
  if (m1 > '5') {
    text += `:0${m1}`;
    used += 1;
    return { text, used, complete: true };
  }
  const m2 = digits[used + 1];
  text += `:${m1}${m2 ?? ''}`;
  used += m2 === undefined ? 1 : 2;
  return { text, used, complete: m2 !== undefined };
}

/** Маска времени: только цифры, двоеточие подставляется само («1200» → «12:00»). */
export function maskTime(text: string): string {
  return takeTime(text.replace(/\D/g, '').slice(0, 4)).text;
}

/** `ЧЧ:ММ` → `ЧЧ:ММ` (проверено); `null` — не время суток. */
export function parseTime(text: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  return Number(m[1]) < 24 && Number(m[2]) < 60 ? text : null;
}

/** Тире между временами интервала: длинное «–», как его пишут в расписаниях. */
export const RANGE_DASH = '–';

/** Маска интервала: «12001400» → «12:00–14:00»; тире подставляется само. */
export function maskTimeRange(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  const first = takeTime(digits);
  if (!first.complete) return first.text;
  const second = takeTime(digits.slice(first.used));
  return second.text === '' ? first.text : `${first.text}${RANGE_DASH}${second.text}`;
}

/** «12:00–14:00» (или с «-», «—») → границы; `null` — не интервал целиком. */
export function parseTimeRange(text: string): { from: string; to: string } | null {
  const m = /^(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})$/.exec(text.trim());
  if (!m) return null;
  const from = parseTime(m[1] ?? '');
  const to = parseTime(m[2] ?? '');
  return from && to ? { from, to } : null;
}

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Сетка месяца: недели с понедельника; пустые клетки — `null`. */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const first = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function Calendar({
  value,
  todayIso,
  onPick,
}: {
  value: string;
  todayIso: string | undefined;
  onPick: (iso: string) => void;
}) {
  const seed = /^(\d{4})-(\d{2})/.exec(value || todayIso || '2026-01');
  const [year, setYear] = useState(Number(seed?.[1] ?? 2026));
  const [month, setMonth] = useState(Number(seed?.[2] ?? 1) - 1);
  const shift = (delta: number) => {
    const next = month + delta;
    setYear(year + Math.floor(next / 12));
    setMonth(((next % 12) + 12) % 12);
  };
  return (
    <div
      role="dialog"
      aria-label="Календарь"
      className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border bg-card p-2 shadow-lg"
    >
      <div className="mb-1 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Предыдущий месяц"
          onClick={() => shift(-1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="text-sm font-medium">
          {MONTHS[month]} {year}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Следующий месяц"
          onClick={() => shift(1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <table className="w-full text-center text-sm">
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} className="py-1 text-xs font-normal text-muted-foreground">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(year, month).map((week) => (
            <tr key={week.map((d) => d ?? 'x').join('-') + month}>
              {week.map((day, i) => {
                if (day === null) return <td key={`e${i}`} />;
                const iso = `${year}-${pad(month + 1)}-${pad(day)}`;
                return (
                  <td key={day}>
                    <button
                      type="button"
                      aria-label={`${day} ${MONTHS[month]} ${year}`}
                      aria-pressed={iso === value}
                      onClick={() => onPick(iso)}
                      className={cn(
                        'size-8 rounded-md hover:bg-accent',
                        iso === todayIso && 'font-bold text-primary',
                        iso === value && 'bg-primary text-primary-foreground hover:bg-primary',
                      )}
                    >
                      {day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {todayIso ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          onClick={() => onPick(todayIso)}
        >
          Сегодня ({isoToRuDate(todayIso)})
        </Button>
      ) : null}
    </div>
  );
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (() => void) | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  name?: string | undefined;
  className?: string | undefined;
  'aria-label'?: string | undefined;
}

export interface DateInputProps extends TextInputProps {
  /** Сегодняшняя дата объекта `ГГГГ-ММ-ДД` — для отметки в календаре и кнопки «Сегодня». */
  todayIso?: string | undefined;
}

/** Дата `ГГГГ-ММ-ДД` ↔ ввод `ДД.ММ.ГГГГ` с календарём. */
export function DateInput({
  value,
  onChange,
  onBlur,
  disabled,
  id,
  name,
  className,
  todayIso,
  'aria-label': ariaLabel,
}: DateInputProps) {
  const field = useFieldState();
  const [text, setText] = useState(isoToRuDate(value));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hintId = useId();
  // Значение изменили снаружи (загрузка записи, сброс формы): ввод показывает его же.
  useEffect(() => {
    if ((parseRuDate(text) ?? '') !== value) setText(isoToRuDate(value));
  }, [value]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !box.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const broken = text !== '' && parseRuDate(text) === null;
  const set = (next: string) => {
    setText(next);
    onChange(parseRuDate(next) ?? '');
  };
  return (
    <div ref={box} className={cn('relative', className)}>
      <div className="flex gap-1">
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="ДД.ММ.ГГГГ"
          maxLength={10}
          value={text}
          id={id ?? field?.id}
          name={name}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={broken || field?.invalid || undefined}
          aria-describedby={broken ? hintId : field?.describedBy}
          className="w-32"
          onChange={(event) => set(maskDate(event.target.value))}
          onBlur={onBlur}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Выбрать дату в календаре"
          aria-expanded={open}
          disabled={disabled ?? field?.disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <CalendarDays aria-hidden />
        </Button>
      </div>
      {broken ? (
        <p id={hintId} className="mt-1 text-xs text-destructive">
          Дата в формате ДД.ММ.ГГГГ, например 13.10.2026
        </p>
      ) : null}
      {open ? (
        <Calendar
          value={value}
          todayIso={todayIso}
          onPick={(iso) => {
            set(isoToRuDate(iso));
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Время суток `ЧЧ:ММ` (24 часа). */
export function TimeInput({
  value,
  onChange,
  onBlur,
  disabled,
  id,
  name,
  className,
  'aria-label': ariaLabel,
}: TextInputProps) {
  const field = useFieldState();
  const [text, setText] = useState(value);
  const hintId = useId();
  useEffect(() => {
    if ((parseTime(text) ?? '') !== value) setText(value);
  }, [value]);
  const broken = text !== '' && parseTime(text) === null;
  return (
    <div className={className}>
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="ЧЧ:ММ"
        maxLength={5}
        value={text}
        id={id ?? field?.id}
        name={name}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={broken || field?.invalid || undefined}
        aria-describedby={broken ? hintId : field?.describedBy}
        className="w-20"
        onChange={(event) => {
          const next = maskTime(event.target.value);
          setText(next);
          onChange(parseTime(next) ?? '');
        }}
        onBlur={onBlur}
      />
      {broken ? (
        <p id={hintId} className="mt-1 text-xs text-destructive">
          Время в формате ЧЧ:ММ, например 14:30
        </p>
      ) : null}
    </div>
  );
}

export interface TimeRangeInputProps {
  /** Начало и конец интервала `ЧЧ:ММ`; пустая строка — не задано. */
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onBlur?: (() => void) | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
  'aria-label'?: string | undefined;
}

const rangeText = (from: string, to: string): string =>
  from && to ? `${from}${RANGE_DASH}${to}` : from ? `${from}${RANGE_DASH}` : '';

/**
 * Интервал времени одним полем: «12001400» → «12:00–14:00» (окно прибытия). Двоеточия и тире
 * подставляются сами; пока интервал неполный, наружу уходит только то, что уже введено целиком.
 */
export function TimeRangeInput({
  from,
  to,
  onChange,
  onBlur,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: TimeRangeInputProps) {
  const field = useFieldState();
  const [text, setText] = useState(rangeText(from, to));
  const hintId = useId();
  useEffect(() => {
    const parsed = parseTimeRange(text);
    const now = {
      from: parsed?.from ?? parseTime(text.split(RANGE_DASH)[0] ?? '') ?? '',
      to: parsed?.to ?? '',
    };
    if (now.from !== from || now.to !== to) setText(rangeText(from, to));
  }, [from, to]);
  const complete = parseTimeRange(text) !== null;
  const parts = text.split(RANGE_DASH);
  // ошибка видна, когда часть записана целиком, но это не время суток («25:00»)
  const broken =
    (parts[0]?.length === 5 && parseTime(parts[0]) === null) ||
    (parts[1]?.length === 5 && parseTime(parts[1]) === null);
  return (
    <div className={className}>
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="ЧЧ:ММ–ЧЧ:ММ"
        maxLength={11}
        value={text}
        id={id ?? field?.id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={broken || field?.invalid || undefined}
        aria-describedby={broken ? hintId : field?.describedBy}
        className="w-36"
        onChange={(event) => {
          const next = maskTimeRange(event.target.value);
          setText(next);
          const parsed = parseTimeRange(next);
          if (parsed) onChange(parsed.from, parsed.to);
          else {
            const [a = '', b = ''] = next.split(RANGE_DASH);
            onChange(parseTime(a) ?? '', parseTime(b) ?? '');
          }
        }}
        onBlur={onBlur}
      />
      {broken ? (
        <p id={hintId} className="mt-1 text-xs text-destructive">
          Время в формате ЧЧ:ММ–ЧЧ:ММ, например 12:00–14:00
        </p>
      ) : text !== '' && !complete ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Введите окно целиком: 12001400 → 12:00–14:00
        </p>
      ) : null}
    </div>
  );
}

export interface DateTimeInputProps extends Omit<DateInputProps, 'aria-label'> {
  /** Время, которое подставляется (и видно), когда дату выбрали, а время ещё пусто. */
  defaultTime?: string | undefined;
}

/** Дата и время одним значением `ГГГГ-ММ-ДДTЧЧ:ММ`; время — в поясе, который выбрал вызывающий. */
export function DateTimeInput({
  value,
  onChange,
  onBlur,
  disabled,
  id,
  name,
  className,
  todayIso,
  defaultTime,
}: DateTimeInputProps) {
  // Пока одна из частей не заполнена, наружу уходит пустая строка, но введённое не теряется.
  const [draftDate, setDraftDate] = useState(value.split('T')[0] ?? '');
  const [draftTime, setDraftTime] = useState(value.split('T')[1] ?? '');
  const emitted = useRef(value);
  useEffect(() => {
    if (value === emitted.current) return;
    // значение изменили снаружи (загрузка записи, сброс формы)
    emitted.current = value;
    setDraftDate(value.split('T')[0] ?? '');
    setDraftTime(value.split('T')[1] ?? '');
  }, [value]);
  const emit = (d: string, t: string) => {
    const next = d && t ? `${d}T${t}` : '';
    emitted.current = next;
    onChange(next);
  };
  return (
    <div className={cn('flex flex-wrap items-start gap-2', className)}>
      <DateInput
        value={draftDate}
        todayIso={todayIso}
        id={id}
        name={name}
        disabled={disabled}
        aria-label="Дата"
        onBlur={onBlur}
        onChange={(d) => {
          setDraftDate(d);
          const t = draftTime || (d ? (defaultTime ?? '') : '');
          if (t !== draftTime) setDraftTime(t);
          emit(d, t);
        }}
      />
      <TimeInput
        value={draftTime}
        disabled={disabled}
        aria-label="Время"
        onBlur={onBlur}
        onChange={(t) => {
          setDraftTime(t);
          emit(draftDate, t);
        }}
      />
    </div>
  );
}

type Bound<T extends FieldValues> = { control: Control<T>; name: FieldPath<T> };

/** Дата в форме react-hook-form: значение `ГГГГ-ММ-ДД` (пустая строка — не задана). */
export function FormDateInput<T extends FieldValues>({
  control,
  name,
  ...rest
}: Bound<T> & Pick<DateInputProps, 'todayIso' | 'disabled' | 'className'>) {
  const { field } = useController({ control, name });
  return (
    <DateInput
      {...rest}
      value={(field.value as string | undefined) ?? ''}
      onChange={field.onChange}
      onBlur={field.onBlur}
      name={field.name}
    />
  );
}

/** Время суток в форме react-hook-form. */
export function FormTimeInput<T extends FieldValues>({
  control,
  name,
  ...rest
}: Bound<T> & Pick<TextInputProps, 'disabled' | 'className' | 'aria-label'>) {
  const { field } = useController({ control, name });
  return (
    <TimeInput
      {...rest}
      value={(field.value as string | undefined) ?? ''}
      onChange={field.onChange}
      onBlur={field.onBlur}
      name={field.name}
    />
  );
}

/** Дата со временем в форме react-hook-form: `ГГГГ-ММ-ДДTЧЧ:ММ`. */
export function FormDateTimeInput<T extends FieldValues>({
  control,
  name,
  ...rest
}: Bound<T> & Pick<DateTimeInputProps, 'todayIso' | 'disabled' | 'className' | 'defaultTime'>) {
  const { field } = useController({ control, name });
  return (
    <DateTimeInput
      {...rest}
      value={(field.value as string | undefined) ?? ''}
      onChange={field.onChange}
      onBlur={field.onBlur}
      name={field.name}
    />
  );
}

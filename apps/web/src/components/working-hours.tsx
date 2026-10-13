import type { WorkingHours } from '@oxrana/contracts';
import { WEEKDAYS, type Weekday } from '@oxrana/contracts';
import { Button, Checkbox, TimeInput } from '@oxrana/ui';

const DAY_LABEL: Record<Weekday, string> = {
  mon: 'Пн',
  tue: 'Вт',
  wed: 'Ср',
  thu: 'Чт',
  fri: 'Пт',
  sat: 'Сб',
  sun: 'Вс',
};

const ALL_DAYS: WorkingHours = {
  mon: [['08:00', '20:00']],
  tue: [['08:00', '20:00']],
  wed: [['08:00', '20:00']],
  thu: [['08:00', '20:00']],
  fri: [['08:00', '20:00']],
  sat: [['08:00', '20:00']],
  sun: [['08:00', '20:00']],
};

/** Сводка расписания одной строкой: «ежедневно 08:00–20:00», «круглосуточно». */
export function describeHours(value: WorkingHours | null): string {
  if (value === null) return 'круглосуточно';
  const parts = WEEKDAYS.map((d) => value[d].map(([a, b]) => `${a}–${b}`).join(', '));
  if (parts.every((p) => p === parts[0])) {
    return parts[0] === '' ? 'не работает' : `ежедневно ${parts[0]}`;
  }
  return WEEKDAYS.map((d, i) => `${DAY_LABEL[d]} ${parts[i] === '' ? 'выходной' : parts[i]}`).join(
    ' · ',
  );
}

/**
 * Рабочее время в поясе объекта: «круглосуточно» или расписание по дням (один интервал в день).
 * Расписание с несколькими интервалами в день редактор не ломает: показывает его текстом и
 * предлагает заменить.
 */
export function WorkingHoursInput({
  value,
  onChange,
  disabled,
  tzLabel,
}: {
  value: WorkingHours | null;
  onChange: (next: WorkingHours | null) => void;
  disabled?: boolean | undefined;
  tzLabel?: string | undefined;
}) {
  const multi = value !== null && WEEKDAYS.some((d) => value[d].length > 1);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value === null}
            disabled={disabled}
            onChange={() => onChange(null)}
          />
          Круглосуточно
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value !== null}
            disabled={disabled}
            onChange={() => onChange(value ?? ALL_DAYS)}
          />
          По расписанию{tzLabel ? ` (время объекта, ${tzLabel})` : ''}
        </label>
      </div>
      {value !== null && multi ? (
        <p className="text-sm text-muted-foreground">
          Расписание сложнее одного интервала в день: {describeHours(value)}. Чтобы править его
          здесь, замените расписание.
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            disabled={disabled}
            onClick={() => onChange(ALL_DAYS)}
          >
            Заменить на простое
          </Button>
        </p>
      ) : null}
      {value !== null && !multi ? (
        <div className="space-y-1.5">
          {WEEKDAYS.map((day) => {
            const interval = value[day][0];
            return (
              <div key={day} className="flex flex-wrap items-center gap-2">
                <Checkbox
                  className="w-24"
                  label={DAY_LABEL[day]}
                  checked={interval !== undefined}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ ...value, [day]: e.target.checked ? [['08:00', '20:00']] : [] })
                  }
                />
                {interval ? (
                  <>
                    <TimeInput
                      aria-label={`${DAY_LABEL[day]}: с`}
                      value={interval[0]}
                      disabled={disabled}
                      onChange={(next) => onChange({ ...value, [day]: [[next, interval[1]]] })}
                    />
                    <span>—</span>
                    <TimeInput
                      aria-label={`${DAY_LABEL[day]}: до`}
                      value={interval[1] === '24:00' ? '23:59' : interval[1]}
                      disabled={disabled}
                      onChange={(next) => onChange({ ...value, [day]: [[interval[0], next]] })}
                    />
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">выходной</span>
                )}
              </div>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              const first = WEEKDAYS.map((d) => value[d][0]).find(Boolean) ?? ['08:00', '20:00'];
              onChange({
                mon: [first],
                tue: [first],
                wed: [first],
                thu: [first],
                fri: [first],
                sat: [],
                sun: [],
              } as WorkingHours);
            }}
          >
            Пн–Пт как первый рабочий день, выходные — выходные
          </Button>
        </div>
      ) : null}
    </div>
  );
}

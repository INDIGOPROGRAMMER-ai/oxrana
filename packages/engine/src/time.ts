/**
 * Локальное время объекта через `Intl` (ADR-009 п. 4). Никаких библиотек дат и никакого пояса
 * среды: каждый вызов получает IANA-пояс объекта явно.
 */
import type { Instant, Weekday, WorkingHours } from './types';

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: Weekday;
  /** Минуты от начала местных суток. */
  readonly minuteOfDay: number;
}

const WEEKDAY_BY_SHORT: Readonly<Record<string, Weekday>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Компоненты местного времени объекта. Неверный пояс — ошибка настройки, бросает `RangeError`. */
export function localParts(instant: Instant, timeZone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    values[part.type] = part.value;
  }
  const hour = Number(values.hour) % 24;
  const minute = Number(values.minute);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour,
    minute,
    weekday: WEEKDAY_BY_SHORT[values.weekday ?? ''] ?? 'mon',
    minuteOfDay: hour * 60 + minute,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Местная дата `YYYY-MM-DD`. */
export function localDate(instant: Instant, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** «14:00» в поясе объекта. */
export function formatTime(instant: Instant, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** «10.03.2026» в поясе объекта. */
export function formatDate(instant: Instant, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.day)}.${pad(p.month)}.${p.year}`;
}

/** «10.03.2026 14:00» в поясе объекта. */
export function formatDateTime(instant: Instant, timeZone: string): string {
  return `${formatDate(instant, timeZone)} ${formatTime(instant, timeZone)}`;
}

/** Дата `YYYY-MM-DD` (местная) — короткая подпись «10.03.2026». */
export function formatLocalDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d ?? ''}.${m ?? ''}.${y ?? ''}`;
}

/** Порядковый номер дня для местной даты `YYYY-MM-DD` (разность дат в сутках). */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Местная дата `YYYY-MM-DD`, сдвинутая на `days` суток (в календаре, без часовых поясов). */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/**
 * Момент по местному времени пояса: «2026-03-10» + 840 минут от начала суток (14:00) в
 * Asia/Yekaterinburg. Для «перенести пропуск на другой день» и границ местных суток.
 */
export function localInstant(date: string, minuteOfDay: number, timeZone: string): Instant {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, minuteOfDay);
  const offsetAt = (instant: Instant): number => {
    const p = localParts(instant, timeZone);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60_000) * 60_000
    );
  };
  let result = wall - offsetAt(wall);
  const again = offsetAt(result);
  if (again !== offsetAt(wall)) result = wall - again;
  return result;
}

/** «ЧЧ:ММ» → минуты от начала суток; `24:00` → 1440. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Попадает ли момент в интервалы рабочего времени (по дням недели в поясе объекта). */
export function isWithinHours(instant: Instant, hours: WorkingHours, timeZone: string): boolean {
  const p = localParts(instant, timeZone);
  return hours[p.weekday].some(
    ([from, to]) => minutesOf(from) <= p.minuteOfDay && p.minuteOfDay < minutesOf(to),
  );
}

/** «08:00–20:00, 22:00–24:00» или «выходной» — интервалы сегодняшнего дня для текста причины. */
export function describeTodayHours(
  instant: Instant,
  hours: WorkingHours,
  timeZone: string,
): string {
  const intervals = hours[localParts(instant, timeZone).weekday];
  if (intervals.length === 0) return 'сегодня выходной';
  return intervals.map(([from, to]) => `${from}–${to}`).join(', ');
}

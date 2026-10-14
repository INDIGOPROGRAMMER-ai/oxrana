import { formatInZone } from '@oxrana/ui';

/**
 * Время суток формы пропуска (`ЧЧ:ММ`): текущее время объекта и «начало + N часов». Всё считается
 * в поясе объекта по часам сервера (ADR-009): часы и пояс браузера не участвуют.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Время суток `ЧЧ:ММ` момента в поясе объекта. */
export function timeOf(ms: number, timezone: string): string {
  return formatInZone(new Date(ms).toISOString(), timezone).slice(11, 16);
}

export function minutesOfTime(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Окончание разового пропуска по умолчанию: начало + N часов (но не больше максимума объекта).
 * `nextDay` — окончание приходится на следующие сутки: форма показывает «завтра».
 */
export function endAfter(
  start: string,
  hours: number,
  maxHours: number,
): { time: string; nextDay: boolean } {
  const total = minutesOfTime(start) + Math.min(hours, maxHours) * 60;
  const inDay = total % 1440;
  return { time: `${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}`, nextDay: total >= 1440 };
}

/** Окончание не позже начала — оно относится к следующим суткам (ночная смена, длинная разгрузка). */
export function endsNextDay(start: string, end: string): boolean {
  return start !== '' && end !== '' && end <= start;
}

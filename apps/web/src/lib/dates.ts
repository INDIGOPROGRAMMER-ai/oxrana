import { formatInZone, localToInstant } from '@oxrana/ui';

/** Календарная дата `ГГГГ-ММ-ДД`, сдвинутая на `days` суток (без часовых поясов и перехода времени). */
export function addDays(date: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `ГГГГ-ММ-ДДTЧЧ:ММ` по времени пояса — значение поля «дата и время» для момента из API. */
export function instantToLocal(iso: string | null, timezone: string): string {
  if (!iso) return '';
  const [date = '', time = ''] = formatInZone(iso, timezone).split(' ');
  const [d = '', m = '', y = ''] = date.split('.');
  return `${y}-${m}-${d}T${time}`;
}

/** Обратно: `ГГГГ-ММ-ДДTЧЧ:ММ` в поясе → момент ISO. Пусто — `null`. */
export function localToIso(local: string, timezone: string): string | null {
  const [date, time] = local.split('T');
  return date && time ? localToInstant(date, time, timezone) : null;
}

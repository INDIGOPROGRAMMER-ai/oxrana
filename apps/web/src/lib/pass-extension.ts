import type { CabinetContext, PassView } from '@oxrana/contracts';
import { addDays, localToIso } from './dates';

/**
 * До какого момента «действует до» можно продлить сразу после въезда (Q-85): столько, сколько можно
 * было оформить без согласования. Разовый — максимум разового пропуска объекта от начала (например,
 * 24 ч); многоразовый — максимум дней. Дальше продление уходит согласующему заявкой, сокращение —
 * всегда сразу. `null` — предела нет (постоянный пропуск без окончания).
 */
export function extensionLimitMs(
  pass: Pick<PassView, 'passType' | 'validFrom'>,
  site: CabinetContext['site'],
): number | null {
  if (!pass.validFrom) return null;
  const from = Date.parse(pass.validFrom);
  if (pass.passType === 'single') return from + site.singlePassMaxHours * 3_600_000;
  if (pass.passType === 'multi') {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: site.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(from));
    const end = localToIso(`${addDays(day, site.multiPassMaxDays)}T00:00`, site.timezone);
    return end ? Date.parse(end) - 1 : null;
  }
  return null;
}

/** Что произойдёт с новым «действует до» после въезда: сразу или заявкой. */
export function extensionOutcome(
  pass: Pick<PassView, 'passType' | 'validFrom' | 'validTo'>,
  site: CabinetContext['site'],
  nextValidTo: string | null,
): 'shorten' | 'within' | 'beyond' | 'same' {
  if (!nextValidTo || !pass.validTo) return 'same';
  const next = Date.parse(nextValidTo);
  const current = Date.parse(pass.validTo);
  if (next === current) return 'same';
  if (next < current) return 'shorten';
  const limit = extensionLimitMs(pass, site);
  return limit === null || next <= limit ? 'within' : 'beyond';
}

/**
 * Подсчёт лимитов (RULES_ENGINE §4): какие лимиты применимы, сколько мест занято, вместимость
 * «по докам» и число местных суток сверхлимита.
 */
import { dayNumber, isWithinHours, localDate } from './time';
import type { DockView, Instant, QuotaView, VisitView } from './types';

/** Тип транспорта или «пешеход» — к чему применяется лимит. */
export type QuotaTarget = { readonly categoryId: string } | 'pedestrian';

/**
 * Лимиты арендатора, действующие на момент `now` и покрывающие тип (или пешеходов). Тип может
 * входить в несколько лимитов — возвращаются все, вердикт по самому строгому (ADR-012). Пустой
 * список — без ограничения (оператор объекта, Q-7).
 */
export function applicableQuotas(
  quotas: readonly QuotaView[],
  tenantId: string,
  target: QuotaTarget,
  now: Instant,
  timeZone: string,
): QuotaView[] {
  return quotas.filter((q) => {
    if (q.tenantId !== tenantId) return false;
    if (q.validFrom > now || (q.validTo !== null && q.validTo <= now)) return false;
    if (q.schedule && !isWithinHours(now, q.schedule, timeZone)) return false;
    if (target === 'pedestrian') return q.participant === 'pedestrian';
    return q.participant === 'vehicle' && q.categoryIds.includes(target.categoryId);
  });
}

/**
 * Занятость лимита по открытым визитам — для поста офлайн и песочницы. Визит по исключению
 * «вне лимита» места не занимает.
 */
export function countOccupancy(openVisits: readonly VisitView[], quota: QuotaView): number {
  let count = 0;
  for (const v of openVisits) {
    if (v.tenantId !== quota.tenantId || v.timeOut !== null || v.exceptionWaivesQuota) continue;
    if (quota.participant === 'pedestrian') {
      if (v.participant === 'pedestrian') count++;
    } else if (v.categoryId !== null && quota.categoryIds.includes(v.categoryId)) {
      count++;
    }
  }
  return count;
}

/** Вместимость: число мест или число доков арендатора, которые считаются в лимите. */
export function capacityOf(quota: QuotaView, docks: readonly DockView[]): number {
  if (!quota.capacityFromDocks) return quota.capacity;
  return docks.filter((d) => d.tenantId === quota.tenantId && d.countsInQuota).length;
}

/**
 * Число местных календарных суток, затронутых интервалом пребывания: 22:00 → 09:00 следующего
 * дня = 2 (неполные сутки считаются полными, сценарий 9). Выезд раньше въезда — 1.
 */
export function overageDays(timeIn: Instant, timeOut: Instant, timeZone: string): number {
  const first = dayNumber(localDate(timeIn, timeZone));
  const last = dayNumber(localDate(Math.max(timeIn, timeOut), timeZone));
  return last - first + 1;
}

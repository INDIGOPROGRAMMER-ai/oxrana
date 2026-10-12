/**
 * Движок вердикта (docs/RULES_ENGINE.md): чистые функции без БД, сети и системных часов. Время и
 * все данные приходят параметрами; один и тот же код работает в API, на посту офлайн, в песочнице
 * и в тестах. Публичный API: `evaluate`, `countOccupancy`, `applicableQuotas`, `overageDays`,
 * `collectWaivers`, `resolveCandidates`, `routeGates`, `ENGINE_VERSION` и типы.
 */
export { type CandidateResolution, resolveCandidates, resolvePedestrian } from './candidates';
export { ENGINE_VERSION, evaluate } from './evaluate';
export {
  applicableQuotas,
  capacityOf,
  countOccupancy,
  overageDays,
  type QuotaTarget,
} from './quotas';
export {
  matchingRoutes,
  participantAdmitted,
  type RouteSubject,
  routeGates,
} from './routing';
export {
  formatDate,
  formatDateTime,
  formatTime,
  isWithinHours,
  type LocalParts,
  localDate,
  localParts,
} from './time';
export type * from './types';
export { collectWaivers, type Waivers } from './waivers';

import type { Instant } from './types';

/** Момент в виде строки ISO 8601 в UTC — для trace и журналов. */
export function instantToIso(instant: Instant): string {
  if (!Number.isFinite(instant)) {
    throw new RangeError(`Момент времени должен быть конечным числом, получено: ${instant}`);
  }
  return new Date(instant).toISOString();
}

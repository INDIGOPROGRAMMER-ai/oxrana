/**
 * Движок вердикта (контракт — docs/RULES_ENGINE.md): чистые функции без БД, сети и системных
 * часов. Этап 1 — только заготовка; `evaluate` появится на этапе 3.
 */

/** Момент времени: миллисекунды с эпохи (UTC). Движок сам время не читает — оно приходит параметром. */
export type Instant = number;

/** Момент в виде строки ISO 8601 в UTC — для trace и журналов. */
export function instantToIso(instant: Instant): string {
  if (!Number.isFinite(instant)) {
    throw new RangeError(`Момент времени должен быть конечным числом, получено: ${instant}`);
  }
  return new Date(instant).toISOString();
}

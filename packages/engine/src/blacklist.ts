/**
 * Проверка по чёрному списку (RULES_ENGINE §3, проверка 3): чистая функция без БД и часов. Нужна
 * отдельно от `evaluate`, потому что номер из списка запрещён и тогда, когда пропуска нет (решение
 * этапа 7a), и форме пропуска кабинета, пока пропуска ещё нет.
 */
import type { BlacklistEntryView, Instant } from './types';

/** Кого проверяем: номер (машина) и/или имя (пешеход); пустое — не проверяется. */
export interface BlacklistSubject {
  readonly plateNorm?: string | null | undefined;
  readonly personName?: string | null | undefined;
}

const nameKey = (value: string): string => value.trim().toLocaleUpperCase('ru-RU');

/** Действующая запись списка, под которую подходит номер или имя, либо `null`. */
export function findBlacklisted(
  entries: readonly BlacklistEntryView[],
  who: BlacklistSubject,
  now: Instant,
): BlacklistEntryView | null {
  const plate = who.plateNorm ? who.plateNorm : null;
  const name = who.personName ? nameKey(who.personName) : '';
  if (plate === null && name === '') return null;
  return (
    entries.find(
      (b) =>
        (b.validTo === null || b.validTo > now) &&
        ((b.plateNorm !== null && plate !== null && b.plateNorm === plate) ||
          (b.personName !== null && name !== '' && nameKey(b.personName) === name)),
    ) ?? null
  );
}

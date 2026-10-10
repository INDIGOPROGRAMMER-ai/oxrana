/**
 * Разрешение кандидатов по номеру и по фамилии (RULES_ENGINE §6): камера, поиск на посту.
 */
import { findSimilarPlates } from '@oxrana/plates';
import type { Instant, PassView, VisitView } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CandidateResolution =
  /** Ровно один подходящий пропуск. */
  | { readonly kind: 'one'; readonly pass: PassView }
  /** Один номер у нескольких арендаторов — пост спрашивает «к кому едет?». */
  | { readonly kind: 'choose'; readonly passes: readonly PassView[] }
  /** Точного совпадения нет; `similar` — похожие номера (отличие ≤ 1 символа) для ручного выбора. */
  | { readonly kind: 'none'; readonly similar: readonly PassView[] };

/** Действует сейчас с запасом ±24 ч: машина может приехать накануне или задержаться. */
function validAround(pass: PassView, now: Instant): boolean {
  const from = pass.validFrom === null ? -Infinity : pass.validFrom - DAY_MS;
  const to = pass.validTo === null ? Infinity : pass.validTo + DAY_MS;
  return from <= now && now <= to;
}

/** Ближе к окну прибытия — раньше; без окна — в конец; при равенстве — по id (детерминизм). */
function byWindowProximity(now: Instant): (a: PassView, b: PassView) => number {
  const distance = (p: PassView): number =>
    p.windowFrom === null ? Number.POSITIVE_INFINITY : Math.abs(p.windowFrom - now);
  return (a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id);
}

/** Самый актуальный из неподходящих по статусу или сроку: начавшийся позже всех. */
function byRecency(a: PassView, b: PassView): number {
  return (b.validFrom ?? 0) - (a.validFrom ?? 0) || a.id.localeCompare(b.id);
}

/**
 * Пропуск по номеру. Точные совпадения одобренных и действующих (±24 ч) предпочтительнее;
 * если есть точное совпадение, но пропуск не одобрен или не действует, он возвращается как
 * единственный кандидат — охранник увидит настоящую причину («разовый использован»,
 * «на согласовании»), а не «пропуска нет». Автопроезд по похожим номерам запрещён.
 */
export function resolveCandidates(
  subject: {
    readonly plateNorm: string;
    readonly candidates: readonly PassView[];
    readonly openVisits?: readonly VisitView[];
  },
  now: Instant,
): CandidateResolution {
  const exact = subject.candidates.filter(
    (p) => p.participant === 'vehicle' && p.plateNorm === subject.plateNorm,
  );
  const current = exact.filter((p) => p.status === 'approved' && validAround(p, now));
  if (current.length === 1) return { kind: 'one', pass: current[0] as PassView };
  if (current.length > 1) {
    const tenants = new Set(current.map((p) => p.tenantId));
    if (tenants.size > 1) {
      return { kind: 'choose', passes: [...current].sort(byWindowProximity(now)) };
    }
    return { kind: 'one', pass: [...current].sort(byWindowProximity(now))[0] as PassView };
  }
  if (exact.length > 0) {
    return { kind: 'one', pass: [...exact].sort(byRecency)[0] as PassView };
  }
  const similar = findSimilarPlates(
    subject.plateNorm,
    subject.candidates.filter((p) => p.status === 'approved' && validAround(p, now)),
    (p) => p.plateNorm,
  ).map((s) => s.item);
  return { kind: 'none', similar };
}

/**
 * Пешеход по фамилии: подстрока без учёта регистра среди одобренных действующих пропусков.
 * Один найден — он; несколько — выбор на посту; ничего — «пропуска нет».
 */
export function resolvePedestrian(
  subject: { readonly nameQuery: string; readonly candidates: readonly PassView[] },
  now: Instant,
): CandidateResolution {
  const query = subject.nameQuery.trim().toLocaleUpperCase('ru-RU');
  if (query.length === 0) return { kind: 'none', similar: [] };
  const found = subject.candidates.filter(
    (p) =>
      p.participant === 'pedestrian' &&
      p.status === 'approved' &&
      validAround(p, now) &&
      (p.personName ?? '').toLocaleUpperCase('ru-RU').includes(query),
  );
  if (found.length === 1) return { kind: 'one', pass: found[0] as PassView };
  if (found.length > 1) return { kind: 'choose', passes: [...found].sort(byRecency) };
  return { kind: 'none', similar: [] };
}

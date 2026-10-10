/**
 * Нечёткое совпадение номеров (RULES_ENGINE §6, GLOSSARY `fuzzy_match`): кандидаты с отличием
 * не больше чем на один символ. Пары, которые камера и человек путают, считаются одним символом.
 */

/** Символы, неразличимые на номере: подставляется представитель группы. */
const CONFUSABLE_GROUPS: readonly (readonly string[])[] = [
  ['O', '0', 'D', 'Q'],
  ['B', '8'],
  ['I', '1'],
  ['S', '5'],
  ['Z', '2'],
];

const CANONICAL: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_GROUPS.flatMap((group) => group.map((char) => [char, group[0] ?? char] as const)),
);

/** Номер, в котором путаемые символы сведены к одному представителю (`O` и `0` → `O`). */
export function canonicalPlate(norm: string): string {
  let out = '';
  for (const char of norm) out += CANONICAL.get(char) ?? char;
  return out;
}

/**
 * Расстояние Левенштейна между каноническими формами: замена, вставка или пропуск символа = 1,
 * путаница `O/0`, `B/8` = 0. `plateDistance('A123BC174', 'A123BC174') === 0`.
 */
export function plateDistance(a: string, b: string): number {
  const x = canonicalPlate(a);
  const y = canonicalPlate(b);
  if (x === y) return 0;
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= y.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[y.length] ?? 0;
}

export interface SimilarPlate<T> {
  readonly item: T;
  readonly distance: number;
}

/**
 * Похожие номера среди кандидатов: расстояние ≤ `maxDistance`, ближе — раньше, при равном
 * расстоянии порядок исходного списка сохраняется. Точные совпадения (расстояние 0 при разном
 * написании) тоже попадают в результат — решение о них принимает вызывающий.
 */
export function findSimilarPlates<T>(
  query: string,
  candidates: readonly T[],
  plateOf: (item: T) => string | null | undefined,
  maxDistance = 1,
): SimilarPlate<T>[] {
  const found: SimilarPlate<T>[] = [];
  for (const item of candidates) {
    const plate = plateOf(item);
    if (!plate) continue;
    const distance = plateDistance(query, plate);
    if (distance <= maxDistance) found.push({ item, distance });
  }
  return found.sort((p, q) => p.distance - q.distance);
}

/**
 * «Было → стало» для аудита (CLAUDE.md п. 6) и PATCH только изменённых полей (п. 5). Ключи — имена
 * полей API (camelCase, как в Drizzle); значения нормализуются: даты — ISO в UTC, массивы и
 * объекты сравниваются по содержимому.
 */
export interface AuditChange {
  readonly from: unknown;
  readonly to: unknown;
  /** Подписи значений-ссылок на момент события: «фура» → «легковой». */
  readonly fromLabel?: string | null;
  readonly toLabel?: string | null;
}

export type AuditDiff = Record<string, AuditChange>;

/** Значение для сравнения и журнала: Date → ISO, undefined → null. */
export function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  return value;
}

function stable(value: unknown): string {
  return JSON.stringify(normalizeValue(value), (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * Какие из переданных полей реально меняют запись. `patch` — только присланные поля (undefined
 * значит «не прислано» и не трогается; null — очистить).
 */
export function changedFields<T extends Record<string, unknown>>(
  current: T,
  patch: Partial<T>,
): (keyof T & string)[] {
  return (Object.keys(patch) as (keyof T & string)[]).filter(
    (key) => patch[key] !== undefined && !sameValue(current[key], patch[key]),
  );
}

/** Diff по списку полей: было из `before`, стало из `after`. */
export function diffOf(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  fields: readonly string[],
): AuditDiff {
  const diff: AuditDiff = {};
  for (const field of fields) {
    const from = before ? normalizeValue(before[field]) : null;
    const to = normalizeValue(after[field]);
    if (before && sameValue(from, to)) continue;
    diff[field] = { from, to };
  }
  return diff;
}

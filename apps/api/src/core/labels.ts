import { schema } from '@oxrana/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Scope } from './context';
import type { AuditDiff } from './diff';

/** Чьи названия подставлять в журнал вместо id (CLAUDE.md п. 6: снимки названий). */
export type LabelKind = 'category' | 'dock' | 'tenant' | 'gate' | 'zone' | 'clause' | 'contract';

/** Названия по id на момент запроса: «фура», «Док 12», короткое название арендатора. */
export async function labelsOf(
  s: Scope,
  kind: LabelKind,
  values: readonly unknown[],
): Promise<Map<string, string>> {
  const ids = [...new Set(values.filter((v): v is string => typeof v === 'string'))];
  if (ids.length === 0) return new Map();
  const org = s.organizationId;
  const rows = await (async (): Promise<{ id: string; label: string }[]> => {
    switch (kind) {
      case 'category':
        return s.db
          .select({ id: schema.vehicleCategories.id, label: schema.vehicleCategories.name })
          .from(schema.vehicleCategories)
          .where(
            and(
              eq(schema.vehicleCategories.organizationId, org),
              inArray(schema.vehicleCategories.id, ids),
            ),
          );
      case 'dock':
        return (
          await s.db
            .select({ id: schema.docks.id, label: schema.docks.number })
            .from(schema.docks)
            .where(and(eq(schema.docks.organizationId, org), inArray(schema.docks.id, ids)))
        ).map((r) => ({ id: r.id, label: `Док ${r.label}` }));
      case 'tenant':
        return s.db
          .select({ id: schema.tenants.id, label: schema.tenants.shortName })
          .from(schema.tenants)
          .where(and(eq(schema.tenants.organizationId, org), inArray(schema.tenants.id, ids)));
      case 'gate':
        return s.db
          .select({ id: schema.gates.id, label: schema.gates.name })
          .from(schema.gates)
          .where(and(eq(schema.gates.organizationId, org), inArray(schema.gates.id, ids)));
      case 'zone':
        return s.db
          .select({ id: schema.zones.id, label: schema.zones.name })
          .from(schema.zones)
          .where(and(eq(schema.zones.organizationId, org), inArray(schema.zones.id, ids)));
      case 'clause':
        return s.db
          .select({ id: schema.contractClauses.id, label: schema.contractClauses.ref })
          .from(schema.contractClauses)
          .where(
            and(
              eq(schema.contractClauses.organizationId, org),
              inArray(schema.contractClauses.id, ids),
            ),
          );
      case 'contract':
        return (
          await s.db
            .select({ id: schema.contracts.id, label: schema.contracts.number })
            .from(schema.contracts)
            .where(and(eq(schema.contracts.organizationId, org), inArray(schema.contracts.id, ids)))
        ).map((r) => ({
          id: r.id,
          label: r.label ? `Договор № ${r.label}` : 'Договор без номера',
        }));
    }
  })();
  return new Map(rows.map((r) => [r.id, r.label]));
}

/** Дополняет diff подписями значений-ссылок: «category_id: фура → легковой». */
export async function labelDiff(
  s: Scope,
  diff: AuditDiff,
  kinds: Readonly<Record<string, LabelKind>>,
): Promise<AuditDiff> {
  const result: AuditDiff = { ...diff };
  for (const [field, kind] of Object.entries(kinds)) {
    const change = diff[field];
    if (!change) continue;
    const labels = await labelsOf(s, kind, [change.from, change.to]);
    result[field] = {
      ...change,
      fromLabel: typeof change.from === 'string' ? (labels.get(change.from) ?? null) : null,
      toLabel: typeof change.to === 'string' ? (labels.get(change.to) ?? null) : null,
    };
  }
  return result;
}

import { schema } from '@oxrana/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Scope } from '../../core/context';

/** Очередь у ворот объекта (B5): по лимиту, в порядке постановки; позиция — внутри лимита. */
export async function queueEntries(s: Scope, siteId: string, tenantIds: readonly string[] | null) {
  const rows = await s.db
    .select({
      entry: schema.gateQueue,
      tenantName: schema.tenants.shortName,
      quotaName: schema.quotas.name,
    })
    .from(schema.gateQueue)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.gateQueue.tenantId))
    .innerJoin(schema.quotas, eq(schema.quotas.id, schema.gateQueue.quotaId))
    .where(
      and(
        eq(schema.gateQueue.organizationId, s.organizationId),
        eq(schema.gateQueue.siteId, siteId),
        isNull(schema.gateQueue.leftAt),
        tenantIds === null ? undefined : inArray(schema.gateQueue.tenantId, [...tenantIds]),
      ),
    )
    .orderBy(asc(schema.gateQueue.queuedAt), asc(schema.gateQueue.id));
  const positions = new Map<string, number>();
  return rows.map(({ entry, tenantName, quotaName }) => {
    const position = (positions.get(entry.quotaId) ?? 0) + 1;
    positions.set(entry.quotaId, position);
    return {
      passId: entry.passId,
      tenantId: entry.tenantId,
      tenantName,
      gateId: entry.gateId,
      quotaId: entry.quotaId,
      quotaName,
      position,
      queuedAt: entry.queuedAt.toISOString(),
      notifiedAt: entry.notifiedAt?.toISOString() ?? null,
    };
  });
}

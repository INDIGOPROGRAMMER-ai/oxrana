import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import type { ScopeInfo } from '../../core/crud';
import { loadTenant, notFound } from '../../core/loaders';

type Row = Record<string, unknown> & { id: string };

/** Запись арендатора: область — его объект и он сам (пользователь арендатора видит только своих). */
export async function tenantRowScope(s: Scope, row: Row): Promise<ScopeInfo> {
  const tenant = await loadTenant(s, String(row.tenantId), { includeDeleted: true });
  return { siteId: tenant.siteId, tenantId: tenant.id };
}

export async function contractScope(s: Scope, contractId: string): Promise<ScopeInfo> {
  const [contract] = await s.db
    .select({ tenantId: schema.contracts.tenantId })
    .from(schema.contracts)
    .where(
      and(
        eq(schema.contracts.organizationId, s.organizationId),
        eq(schema.contracts.id, contractId),
      ),
    );
  if (!contract) throw notFound('Договор');
  const tenant = await loadTenant(s, contract.tenantId, { includeDeleted: true });
  return { siteId: tenant.siteId, tenantId: tenant.id };
}

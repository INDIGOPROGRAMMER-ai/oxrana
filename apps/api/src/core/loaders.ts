import { schema } from '@oxrana/db';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '../errors';
import { assertSiteAccess, assertTenantAccess, type Scope } from './context';

/**
 * Загрузка записей с явным фильтром по организации (CLAUDE.md п. 9; RLS — вторая линия) и
 * проверкой области актора. Чужая организация — 404 (запись не видна вообще), свой объект вне
 * области актора или чужой арендатор у пользователя арендатора — 403 (ADR-007).
 */
export function notFound(what: string): AppError {
  return new AppError('not_found', { message: `${what} не найден(а). Обновите страницу.` });
}

export type SiteRow = typeof schema.sites.$inferSelect;
export type TenantRow = typeof schema.tenants.$inferSelect;
export type GateRow = typeof schema.gates.$inferSelect;

export async function loadSite(s: Scope, siteId: string): Promise<SiteRow> {
  const [site] = await s.db
    .select()
    .from(schema.sites)
    .where(
      and(
        eq(schema.sites.organizationId, s.organizationId),
        eq(schema.sites.id, siteId),
        isNull(schema.sites.deletedAt),
      ),
    );
  if (!site) throw notFound('Объект');
  assertSiteAccess(s.ctx, site.id);
  return site;
}

export async function loadTenant(
  s: Scope,
  tenantId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<TenantRow> {
  const [tenant] = await s.db
    .select()
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.organizationId, s.organizationId),
        eq(schema.tenants.id, tenantId),
        options.includeDeleted ? undefined : isNull(schema.tenants.deletedAt),
      ),
    );
  if (!tenant) throw notFound('Арендатор');
  assertSiteAccess(s.ctx, tenant.siteId);
  assertTenantAccess(s.ctx, tenant.id);
  return tenant;
}

export async function loadGate(s: Scope, gateId: string): Promise<GateRow> {
  const [gate] = await s.db
    .select()
    .from(schema.gates)
    .where(
      and(
        eq(schema.gates.organizationId, s.organizationId),
        eq(schema.gates.id, gateId),
        isNull(schema.gates.deletedAt),
      ),
    );
  if (!gate) throw notFound('КПП');
  assertSiteAccess(s.ctx, gate.siteId);
  return gate;
}

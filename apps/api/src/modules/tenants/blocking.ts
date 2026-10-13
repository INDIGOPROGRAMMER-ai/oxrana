import {
  TENANT_BLOCK_MODE_LABEL,
  TenantBlockImpactQuerySchema,
  TenantBlockImpactSchema,
  type TenantBlockMode,
  TenantBlockSchema,
  TenantParamsSchema,
  type TenantStatus,
  TenantUnblockSchema,
  TenantViewSchema,
} from '@oxrana/contracts';
import { openVisits, schema } from '@oxrana/db';
import { and, count, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ctxOf, type Scope } from '../../core/context';
import { diffOf } from '../../core/diff';
import { loadTenant, type TenantRow } from '../../core/loaders';
import { AppError } from '../../errors';
import { tenantView } from './views';

/** Режим блокировки → статус арендатора (Q-73). */
const STATUS_OF_MODE: Record<TenantBlockMode, TenantStatus> = {
  new_passes: 'blocked_new_passes',
  entry: 'blocked_entry',
  full: 'blocked_full',
};

/** Блокируют ли въезд (и значит, действующие пропуска перестают работать). */
const STOPS_ENTRY = new Set<TenantBlockMode>(['entry', 'full']);

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/**
 * Последствия блокировки перед подтверждением: сколько людей и машин сейчас внутри (они смогут
 * выехать — выезд разрешён всегда) и сколько действующих пропусков перестанут работать.
 */
export async function blockImpact(s: Scope, tenant: TenantRow, mode: TenantBlockMode) {
  const inside = await openVisits(s.db, {
    organizationId: s.organizationId,
    siteId: tenant.siteId,
    tenantId: tenant.id,
  });
  const vehiclesInside = inside.filter((v) => v.participant === 'vehicle').length;
  const pedestriansInside = inside.length - vehiclesInside;
  let willStopWorking = 0;
  if (STOPS_ENTRY.has(mode)) {
    const now = new Date(s.ctx.now());
    const [row] = await s.db
      .select({ n: count() })
      .from(schema.passes)
      .where(
        and(
          eq(schema.passes.organizationId, s.organizationId),
          eq(schema.passes.tenantId, tenant.id),
          eq(schema.passes.status, 'approved'),
          or(isNull(schema.passes.validTo), gt(schema.passes.validTo, now)),
        ),
      );
    willStopWorking = row?.n ?? 0;
  }
  const insideText =
    inside.length === 0
      ? 'Сейчас на территории никого нет'
      : `Сейчас внутри ${vehiclesInside} ${plural(vehiclesInside, 'машина', 'машины', 'машин')}` +
        (pedestriansInside > 0
          ? ` и ${pedestriansInside} ${plural(pedestriansInside, 'пешеход', 'пешехода', 'пешеходов')}`
          : '') +
        ', они смогут выехать';
  const passesText = STOPS_ENTRY.has(mode)
    ? `${willStopWorking} ${plural(willStopWorking, 'действующий пропуск перестанет', 'действующих пропуска перестанут', 'действующих пропусков перестанут')} работать`
    : 'действующие пропуска продолжают работать';
  return {
    mode,
    insideNow: inside.length,
    vehiclesInside,
    pedestriansInside,
    willStopWorking,
    summary: `${insideText}; ${passesText}.`,
  };
}

async function changeStatus(
  s: Scope,
  tenant: TenantRow,
  status: TenantStatus,
  reason: string,
  action: 'block' | 'unblock',
) {
  const now = new Date(s.ctx.now());
  const [updated = tenant] = await s.db
    .update(schema.tenants)
    .set({ status, statusReason: reason, statusChangedAt: now })
    .where(
      and(eq(schema.tenants.organizationId, s.organizationId), eq(schema.tenants.id, tenant.id)),
    )
    .returning();
  await s.audit({
    siteId: tenant.siteId,
    entity: 'tenant',
    entityId: tenant.id,
    action,
    diff: diffOf(tenant, updated, ['status', 'statusReason']),
    reason,
    snapshot: { tenant: tenant.shortName },
  });
  await s.emit('tenant.changed', {
    siteId: tenant.siteId,
    aggregate: 'tenant',
    aggregateId: tenant.id,
    payload: { tenantId: tenant.id, fields: ['status'] },
  });
  return updated;
}

/** Блокировка арендатора с последствиями (этап 6b): режимы, причина, подтверждение. Выезд — всегда. */
export function registerBlockingRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['tenant'];

  typed.get(
    '/tenants/:tenantId/block-impact',
    {
      config: { permission: 'tenant.block' },
      schema: {
        tags,
        summary:
          'Последствия блокировки арендатора: сколько внутри и сколько пропусков перестанут работать',
        params: TenantParamsSchema,
        querystring: TenantBlockImpactQuerySchema,
        response: { 200: TenantBlockImpactSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) =>
        blockImpact(s, await loadTenant(s, request.params.tenantId), request.query.mode),
      );
    },
  );

  typed.post(
    '/tenants/:tenantId/block',
    {
      config: { permission: 'tenant.block' },
      schema: {
        tags,
        summary: 'Заблокировать арендатора (режим, причина, подтверждение последствий)',
        params: TenantParamsSchema,
        body: TenantBlockSchema,
        response: { 200: TenantViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const { mode, reason, confirm } = request.body;
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        if (tenant.status === 'archived') {
          throw new AppError('conflict', {
            message: 'Арендатор в архиве: блокировать нечего. Восстановите его из архива.',
          });
        }
        const status = STATUS_OF_MODE[mode];
        if (tenant.status === status) return tenantView(tenant);
        if (confirm !== true) {
          const impact = await blockImpact(s, tenant, mode);
          throw new AppError('confirmation_required', {
            field: 'confirm',
            message: `${TENANT_BLOCK_MODE_LABEL[mode]}: ${impact.summary} Подтвердите, чтобы заблокировать.`,
            details: { ...impact },
          });
        }
        return tenantView(await changeStatus(s, tenant, status, reason, 'block'));
      });
    },
  );

  typed.post(
    '/tenants/:tenantId/unblock',
    {
      config: { permission: 'tenant.block' },
      schema: {
        tags,
        summary: 'Снять блокировку арендатора (с причиной)',
        params: TenantParamsSchema,
        body: TenantUnblockSchema,
        response: { 200: TenantViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        if (tenant.status === 'active') return tenantView(tenant);
        if (tenant.status === 'archived') {
          throw new AppError('conflict', {
            message: 'Арендатор в архиве, а не заблокирован: снять нечего.',
          });
        }
        return tenantView(await changeStatus(s, tenant, 'active', request.body.reason, 'unblock'));
      });
    },
  );
}

import { SiteSettingsSchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, desc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import { loadSite, notFound } from '../../core/loaders';
import { AppError } from '../../errors';
import { requireGateId } from './core';

/**
 * Запрос исключения с поста (A11, ADR-007, сценарий 42): пост при 🟡/🔴 просит впустить с
 * причиной → человек с правом `gate.override` одобряет одним нажатием → на `overrideValidMin`
 * минут вердикт по этому пропуску на этом КПП зелёный; «Впустить» использует одобрение, визит и
 * журнал КПП получают `override_id` (кто одобрил, причина — в запросе).
 */
export type OverrideRow = typeof schema.overrideRequests.$inferSelect;

export function overrideView(
  row: OverrideRow,
  names: { gateName: string; decidedByName: string | null; tenantId: string | null },
) {
  return {
    id: row.id,
    siteId: row.siteId,
    gateId: row.gateId,
    gateName: names.gateName,
    passId: row.passId,
    tenantId: names.tenantId,
    plateNorm: row.plateNorm,
    direction: row.direction,
    verdictCode: row.verdictCode,
    reasons: (row.reasons as { code: string; message: string }[]).map((r) => ({
      code: r.code,
      message: r.message,
    })),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedByName: names.decidedByName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    validUntil: row.validUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Запрос по решению из журнала КПП: вердикт и причины — из журнала, а не от клиента. */
export async function createOverrideRequest(
  s: Scope,
  input: { decisionId: number; reason: string },
): Promise<OverrideRow> {
  const gateId = requireGateId(s);
  const [decision] = await s.db
    .select()
    .from(schema.gateDecisions)
    .where(
      and(
        eq(schema.gateDecisions.organizationId, s.organizationId),
        eq(schema.gateDecisions.id, input.decisionId),
        eq(schema.gateDecisions.gateId, gateId),
      ),
    );
  if (!decision) throw notFound('Решение поста');
  if (decision.verdict === 'allow' || decision.verdict === 'allow_overage') {
    throw new AppError('conflict', {
      message: 'Вердикт уже разрешает въезд — исключение не нужно.',
    });
  }
  if (!decision.passId) {
    throw new AppError('conflict', {
      message:
        'Пропуска нет — исключение не к чему применить. Нажмите «Машина без пропуска»: запрос уйдёт арендатору.',
    });
  }
  const [pass] = await s.db
    .select({ tenantId: schema.passes.tenantId, plateNorm: schema.passes.plateNorm })
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.organizationId, s.organizationId),
        eq(schema.passes.id, decision.passId),
      ),
    );
  const { actor } = s.ctx;
  const [row] = await s.db
    .insert(schema.overrideRequests)
    .values({
      organizationId: s.organizationId,
      siteId: decision.siteId,
      gateId,
      passId: decision.passId,
      plateNorm: pass?.plateNorm ?? null,
      direction: decision.direction,
      verdictCode: decision.verdict,
      reasons: decision.reasons,
      reason: input.reason,
      status: 'pending',
      requestedByGateAccountId: actor.id,
      deviceId: actor.deviceId,
      // по часам сервиса (ADR-009): от него считается, устарел ли запрос
      createdAt: new Date(s.ctx.now()),
    })
    .returning();
  if (!row) throw new Error('override insert');
  await s.audit({
    siteId: row.siteId,
    entity: 'override_request',
    entityId: row.id,
    action: 'create',
    reason: input.reason,
    snapshot: { decisionId: decision.id, verdict: decision.verdict },
  });
  await s.emit('override.requested', {
    siteId: row.siteId,
    aggregate: 'override_request',
    aggregateId: row.id,
    payload: {
      overrideRequestId: row.id,
      gateId,
      passId: row.passId,
      tenantId: pass?.tenantId ?? null,
    },
  });
  return row;
}

async function loadOverride(s: Scope, id: string): Promise<OverrideRow> {
  const [row] = await s.db
    .select()
    .from(schema.overrideRequests)
    .where(
      and(
        eq(schema.overrideRequests.organizationId, s.organizationId),
        eq(schema.overrideRequests.id, id),
      ),
    );
  if (!row) throw notFound('Запрос исключения');
  return row;
}

/**
 * Решение по запросу: принимает человек (не пост — пост свой запрос не одобряет). Запрос старше
 * срока ответа на запросы с поста устарел: машина, скорее всего, уже уехала.
 */
export async function decideOverride(
  s: Scope,
  id: string,
  decision: 'approved' | 'rejected',
  note: string | null,
): Promise<OverrideRow> {
  if (s.ctx.actor.kind !== 'user') {
    throw new AppError('forbidden', {
      message: 'Исключение одобряет администратор, а не пост.',
    });
  }
  const request = await loadOverride(s, id);
  const site = await loadSite(s, request.siteId);
  const settings = SiteSettingsSchema.parse(site.settings);
  const now = s.ctx.now();
  if (request.status !== 'pending') throw new AppError('override_request_closed');
  if (request.createdAt.getTime() + settings.gateRequestTimeoutMin * 60_000 < now) {
    throw new AppError('override_request_closed', {
      message: `Запрос устарел: прошло больше ${settings.gateRequestTimeoutMin} мин. Если машина ещё у ворот, пост отправит новый.`,
    });
  }
  const [row = request] = await s.db
    .update(schema.overrideRequests)
    .set({
      status: decision,
      decidedBy: s.ctx.actor.id,
      decidedAt: new Date(now),
      decisionNote: note,
      via: 'admin',
      validUntil:
        decision === 'approved' ? new Date(now + settings.overrideValidMin * 60_000) : null,
    })
    .where(eq(schema.overrideRequests.id, request.id))
    .returning();
  const [pass] = request.passId
    ? await s.db
        .select({ tenantId: schema.passes.tenantId })
        .from(schema.passes)
        .where(eq(schema.passes.id, request.passId))
    : [];
  await s.audit({
    siteId: request.siteId,
    entity: 'override_request',
    entityId: request.id,
    action: decision === 'approved' ? 'approve' : 'reject',
    reason: note,
    snapshot: { gateId: request.gateId, reasonFromGate: request.reason },
  });
  await s.emit('override.decided', {
    siteId: request.siteId,
    aggregate: 'override_request',
    aggregateId: request.id,
    payload: {
      overrideRequestId: request.id,
      gateId: request.gateId,
      passId: request.passId,
      tenantId: pass?.tenantId ?? null,
      status: decision,
    },
  });
  return row;
}

/** Список запросов с названием КПП, арендатором пропуска и тем, кто решил. */
export async function listOverrides(s: Scope, where: (SQL | undefined)[], since: Date | null) {
  const rows = await s.db
    .select({
      request: schema.overrideRequests,
      gateName: schema.gates.name,
      tenantId: schema.passes.tenantId,
    })
    .from(schema.overrideRequests)
    .innerJoin(schema.gates, eq(schema.gates.id, schema.overrideRequests.gateId))
    .leftJoin(schema.passes, eq(schema.passes.id, schema.overrideRequests.passId))
    .where(
      and(
        eq(schema.overrideRequests.organizationId, s.organizationId),
        since ? gt(schema.overrideRequests.createdAt, since) : undefined,
        ...where,
      ),
    )
    .orderBy(desc(schema.overrideRequests.createdAt))
    .limit(200);
  const deciders = [
    ...new Set(rows.map((r) => r.request.decidedBy).filter((v): v is string => v !== null)),
  ];
  const names = new Map<string, string>();
  if (deciders.length > 0) {
    for (const u of await s.db
      .select({ id: schema.users.id, name: schema.users.fullName })
      .from(schema.users)
      .where(inArray(schema.users.id, deciders))) {
      names.set(u.id, u.name);
    }
  }
  return rows.map((r) =>
    overrideView(r.request, {
      gateName: r.gateName,
      tenantId: r.tenantId,
      decidedByName: r.request.decidedBy ? (names.get(r.request.decidedBy) ?? null) : null,
    }),
  );
}

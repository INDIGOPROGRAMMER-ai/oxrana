import { SiteSettingsSchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { normalizePlate } from '@oxrana/plates';
import { and, eq } from 'drizzle-orm';
import { isTenantUser } from '../../actor';
import { assertTenantAccess, type Scope } from '../../core/context';
import { loadSite, loadTenant, notFound } from '../../core/loaders';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { createPass } from '../passes/service';
import type { GateCtx } from './core';

export type GateRequestRow = typeof schema.gateRequests.$inferSelect;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function gateRequestView(row: GateRequestRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    gateId: row.gateId,
    tenantId: row.tenantId,
    participant: row.participant,
    plateRaw: row.plateRaw,
    plateNorm: row.plateNorm,
    categoryId: row.categoryId,
    personName: row.personName,
    status: row.status,
    answeredAt: iso(row.answeredAt),
    answerNote: row.answerNote,
    passId: row.passId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** «Машина без пропуска»: запрос с поста арендатору (ARCHITECTURE §3.3, сценарий 15). */
export async function createGateRequest(
  s: Scope,
  g: GateCtx,
  input: {
    participant: 'vehicle' | 'pedestrian';
    plate?: string | undefined;
    categoryId?: string | undefined;
    personName?: string | undefined;
    tenantId?: string | undefined;
  },
): Promise<GateRequestRow> {
  if (input.participant === 'vehicle' && !input.plate?.trim()) {
    throw new AppError('plate_required', { field: 'plate' });
  }
  if (input.participant === 'pedestrian' && !input.personName?.trim()) {
    throw new AppError('person_required', { field: 'personName' });
  }
  await assertRef(s, schema.tenants, input.tenantId, {
    siteId: g.site.id,
    field: 'tenantId',
    title: 'Арендатор',
  });
  const now = s.ctx.now();
  const settings = SiteSettingsSchema.parse(g.site.settings);
  const plate = input.plate?.trim() ? normalizePlate(input.plate.trim()) : null;
  const { actor } = s.ctx;
  const [row] = await s.db
    .insert(schema.gateRequests)
    .values({
      organizationId: s.organizationId,
      siteId: g.site.id,
      gateId: g.gate.id,
      tenantId: input.tenantId ?? null,
      participant: input.participant,
      plateRaw: plate?.raw ?? null,
      plateNorm: plate?.norm ?? null,
      categoryId: input.categoryId ?? null,
      personName: input.personName?.trim() ?? null,
      status: 'open',
      createdByGateAccountId: actor.kind === 'gate_account' ? actor.id : null,
      deviceId: actor.deviceId,
      expiresAt: new Date(now + settings.gateRequestTimeoutMin * 60_000),
    })
    .returning();
  if (!row) throw new Error('gate request insert');
  await s.emit('gate_request.created', {
    siteId: g.site.id,
    aggregate: 'gate_request',
    aggregateId: row.id,
    payload: {
      gateRequestId: row.id,
      gateId: g.gate.id,
      tenantId: row.tenantId,
      participant: row.participant,
    },
  });
  return row;
}

async function loadRequest(s: Scope, id: string): Promise<GateRequestRow> {
  const [row] = await s.db
    .select()
    .from(schema.gateRequests)
    .where(
      and(eq(schema.gateRequests.organizationId, s.organizationId), eq(schema.gateRequests.id, id)),
    );
  if (!row) throw notFound('Запрос с поста');
  return row;
}

function assertOpen(s: Scope, row: GateRequestRow): void {
  if (row.status !== 'open') throw new AppError('gate_request_closed');
  if (row.expiresAt.getTime() < s.ctx.now()) {
    throw new AppError('gate_request_closed', {
      message:
        'Срок ответа на запрос истёк — охрана уже не ждёт ответа. Если машина ещё у ворот, оформите пропуск.',
    });
  }
}

/** Отвечает человек: учётка поста свой же запрос не одобряет. */
function requireUser(s: Scope): void {
  if (s.ctx.actor.kind !== 'user') {
    throw new AppError('forbidden', {
      message: 'На запрос с поста отвечает арендатор или администратор, а не пост.',
    });
  }
}

/**
 * «Оформить» (сценарий 15): разовый пропуск на машину у ворот — от момента ответа на срок разового;
 * окно прибытия — с момента ответа (машина уже стоит у ворот). Пропуск проходит обычные проверки
 * и политику согласования арендатора.
 */
export async function approveGateRequest(
  s: Scope,
  id: string,
  body: {
    tenantId?: string | undefined;
    categoryId?: string | undefined;
    dockId?: string | undefined;
    validTo?: string | undefined;
    comment?: string | undefined;
  },
) {
  requireUser(s);
  const request = await loadRequest(s, id);
  const tenantIds = s.ctx.actor.tenantIds;
  const tenantId =
    request.tenantId ??
    body.tenantId ??
    (isTenantUser(s.ctx.actor) && tenantIds?.length === 1 ? tenantIds[0] : undefined);
  if (!tenantId) {
    throw new AppError('validation_failed', {
      field: 'tenantId',
      message: 'Выберите арендатора, к которому едет машина.',
    });
  }
  if (request.tenantId && body.tenantId && body.tenantId !== request.tenantId) {
    throw new AppError('validation_failed', {
      field: 'tenantId',
      message: 'Запрос адресован другому арендатору.',
    });
  }
  assertTenantAccess(s.ctx, tenantId);
  assertOpen(s, request);
  const tenant = await loadTenant(s, tenantId);
  const now = s.ctx.now();
  const site = await loadSite(s, request.siteId);
  const settings = SiteSettingsSchema.parse(site.settings);
  const validTo =
    body.validTo ?? new Date(now + settings.singlePassMaxHours * 3_600_000).toISOString();
  const nowIso = new Date(now).toISOString();
  const created = await createPass(
    s,
    tenant,
    {
      passType: 'single',
      participant: request.participant,
      ...(request.plateRaw ? { plate: request.plateRaw } : {}),
      categoryId: body.categoryId ?? request.categoryId ?? null,
      personName: request.personName,
      dockId: body.dockId ?? null,
      validFrom: nowIso,
      validTo,
      ...(request.participant === 'vehicle' ? { windowFrom: nowIso, windowTo: validTo } : {}),
      comment: body.comment ?? 'По запросу с поста',
    },
    { via: 'gate', gateAccountId: request.createdByGateAccountId },
  );
  const [row = request] = await s.db
    .update(schema.gateRequests)
    .set({
      status: 'approved',
      tenantId,
      answeredBy: s.ctx.actor.id,
      answeredAt: new Date(now),
      passId: created.row.id,
    })
    .where(eq(schema.gateRequests.id, request.id))
    .returning();
  await s.audit({
    siteId: request.siteId,
    entity: 'gate_request',
    entityId: request.id,
    action: 'approve',
    snapshot: { passId: created.row.id },
  });
  await s.emit('gate_request.answered', {
    siteId: request.siteId,
    aggregate: 'gate_request',
    aggregateId: request.id,
    payload: {
      gateRequestId: request.id,
      gateId: request.gateId,
      tenantId,
      status: 'approved',
      passId: created.row.id,
    },
  });
  return { request: row, pass: created };
}

export async function rejectGateRequest(s: Scope, id: string, note: string) {
  requireUser(s);
  const request = await loadRequest(s, id);
  if (request.tenantId) assertTenantAccess(s.ctx, request.tenantId);
  else if (isTenantUser(s.ctx.actor)) {
    throw new AppError('forbidden', {
      message: 'Запрос без арендатора разбирает администратор объекта.',
    });
  }
  assertOpen(s, request);
  const [row = request] = await s.db
    .update(schema.gateRequests)
    .set({
      status: 'rejected',
      answeredBy: s.ctx.actor.id,
      answeredAt: new Date(s.ctx.now()),
      answerNote: note,
    })
    .where(eq(schema.gateRequests.id, request.id))
    .returning();
  await s.audit({
    siteId: request.siteId,
    entity: 'gate_request',
    entityId: request.id,
    action: 'reject',
    reason: note,
  });
  await s.emit('gate_request.answered', {
    siteId: request.siteId,
    aggregate: 'gate_request',
    aggregateId: request.id,
    payload: {
      gateRequestId: request.id,
      gateId: request.gateId,
      tenantId: request.tenantId,
      status: 'rejected',
      passId: null,
    },
  });
  return row;
}

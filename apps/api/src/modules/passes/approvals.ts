import type { ApprovalCreatorKind } from '@oxrana/contracts';
import { allOrganizationIds, schema } from '@oxrana/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Actor } from '../../actor';
import { type AppDeps, Ctx, type Scope } from '../../core/context';
import { type AuditDiff, changedFields, diffOf } from '../../core/diff';
import { labelDiff } from '../../core/labels';
import { EXCLUSION_VIOLATION, pgErrorCode } from '../../core/refs';
import { AppError } from '../../errors';
import { loadPass } from './service';
import {
  loadPassContext,
  type PassField,
  type PassValues,
  validatePass,
  valuesOf,
} from './validate';
import type { PassRow } from './views';

/**
 * Согласование пропусков (`10_` §6, сценарий 24): одобрить, отклонить, «одобрить с изменениями» —
 * изменённые поля видны арендатору (`approval_changes`). Эскалация — по сроку политики.
 */
export interface ApprovalChanges {
  categoryId?: string | null | undefined;
  dockId?: string | null | undefined;
  destinationZoneId?: string | null | undefined;
  validFrom?: string | undefined;
  validTo?: string | null | undefined;
  windowFrom?: string | null | undefined;
  windowTo?: string | null | undefined;
  comment?: string | null | undefined;
}

const LABELS = { categoryId: 'category', dockId: 'dock', destinationZoneId: 'zone' } as const;
const DATE_FIELDS = new Set(['validFrom', 'validTo', 'windowFrom', 'windowTo']);

function requested(changes: ApprovalChanges | undefined): Partial<PassValues> {
  const out: Partial<PassValues> = {};
  if (!changes) return out;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] =
      DATE_FIELDS.has(key) && typeof value === 'string' ? new Date(value) : value;
  }
  return out;
}

async function loadPending(s: Scope, passId: string) {
  const loaded = await loadPass(s, passId);
  if (loaded.pass.status !== 'pending_approval') throw new AppError('not_pending');
  return loaded;
}

/** Одобрить (возможно, с изменениями): пропуск проходит те же проверки, дубль — понятная ошибка. */
export async function approvePass(
  s: Scope,
  passId: string,
  note: string | null,
  changes: ApprovalChanges | undefined,
): Promise<PassRow> {
  const { pass, tenant } = await loadPending(s, passId);
  const ctx = await loadPassContext(s, tenant);
  const current = valuesOf(pass);
  const next = requested(changes);
  const fields = changedFields(
    current as unknown as Record<string, unknown>,
    next as Record<string, unknown>,
  ) as PassField[];
  const merged: PassValues = { ...current, ...next };
  // Начало, которое согласующий не трогал, могло уйти в прошлое, пока пропуск ждал: это не ошибка.
  await validatePass(s, ctx, merged, new Set(fields));

  const approvalChanges: AuditDiff | null =
    fields.length > 0 ? diffOf(pass, { ...pass, ...next }, fields) : null;
  const now = new Date(s.ctx.now());
  const set = {
    ...Object.fromEntries(fields.map((f) => [f, next[f]])),
    status: 'approved' as const,
    approvedBy: s.ctx.actor.id,
    approvedAt: now,
    approvalNote: note,
    approvalChanges,
  };
  let row: PassRow;
  try {
    [row = pass] = await s.nested((sp) =>
      sp.db
        .update(schema.passes)
        .set(set)
        .where(
          and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, pass.id)),
        )
        .returning(),
    );
  } catch (error) {
    if (pgErrorCode(error).code === EXCLUSION_VIOLATION) {
      throw new AppError('pass_duplicate', {
        field: 'plate',
        message:
          'У арендатора уже есть действующий пропуск на этот номер на пересекающийся срок — одобрение создало бы дубль. Измените срок или отклоните.',
      });
    }
    throw error;
  }
  await s.audit({
    siteId: pass.siteId,
    entity: 'pass',
    entityId: pass.id,
    action: fields.length > 0 ? 'approve_with_changes' : 'approve',
    diff: {
      status: { from: pass.status, to: 'approved' },
      ...(approvalChanges ? await labelDiff(s, approvalChanges, LABELS) : {}),
    },
    reason: note,
  });
  await s.emit('pass.status_changed', {
    siteId: pass.siteId,
    aggregate: 'pass',
    aggregateId: pass.id,
    payload: { passId: pass.id, tenantId: pass.tenantId, from: pass.status, to: 'approved' },
  });
  if (fields.length > 0) {
    await s.emit('pass.updated', {
      siteId: pass.siteId,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: { passId: pass.id, tenantId: pass.tenantId, fields },
    });
  }
  return row;
}

/** Отклонить с причиной: причина видна арендатору, ссылка водителя отзывается. */
export async function rejectPass(s: Scope, passId: string, note: string): Promise<PassRow> {
  const { pass } = await loadPending(s, passId);
  return reject(s, pass, note);
}

async function reject(s: Scope, pass: PassRow, note: string): Promise<PassRow> {
  const now = new Date(s.ctx.now());
  const [row = pass] = await s.db
    .update(schema.passes)
    .set({ status: 'rejected', approvalNote: note, closedAt: now })
    .where(and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, pass.id)))
    .returning();
  await s.db
    .update(schema.passTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.passTokens.passId, pass.id), isNull(schema.passTokens.revokedAt)));
  await s.audit({
    siteId: pass.siteId,
    entity: 'pass',
    entityId: pass.id,
    action: 'reject',
    diff: { status: { from: pass.status, to: 'rejected' } },
    reason: note,
  });
  await s.emit('pass.status_changed', {
    siteId: pass.siteId,
    aggregate: 'pass',
    aggregateId: pass.id,
    payload: { passId: pass.id, tenantId: pass.tenantId, from: pass.status, to: 'rejected' },
  });
  return row;
}

/** Кто создал ожидающий пропуск — для политики: пост, если с поста, иначе арендатор. */
function creatorOf(pass: PassRow): ApprovalCreatorKind {
  return pass.createdVia === 'gate' ? 'gate' : 'tenant';
}

function systemActor(organizationId: string): Actor {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    kind: 'system',
    organizationId,
    permissions: new Set(),
    grants: [{ permissions: new Set(), siteId: null, tenantId: null }],
    siteIds: null,
    tenantIds: null,
    gateId: null,
    deviceId: null,
  };
}

/**
 * Сроки согласования (`approval_policies.escalation_hours`, `on_timeout`): не рассмотренный за срок
 * пропуск отклоняется или эскалируется (один раз: событие `pass.approval_escalated`, доставка —
 * этап уведомлений). Обходит организации по одной, каждая — своей транзакцией с RLS.
 */
export async function processApprovalTimeouts(
  deps: AppDeps,
): Promise<{ escalated: number; rejected: number }> {
  const result = { escalated: 0, rejected: 0 };
  const now = deps.clock.now();
  for (const organizationId of await allOrganizationIds(deps.db)) {
    const ctx = new Ctx(systemActor(organizationId), deps, 'approval-timeouts', null);
    await ctx.tx(async (s) => {
      const pending = await s.db
        .select()
        .from(schema.passes)
        .where(
          and(
            eq(schema.passes.organizationId, organizationId),
            eq(schema.passes.status, 'pending_approval'),
          ),
        )
        .orderBy(asc(schema.passes.createdAt));
      for (const pass of pending) {
        const policy = await approvalRules(s, pass);
        if (!policy?.escalationHours || !policy.onTimeout) continue;
        const due = pass.createdAt.getTime() + policy.escalationHours * 3_600_000;
        if (due > now) continue;
        if (policy.onTimeout === 'reject') {
          await reject(
            s,
            pass,
            `Не согласован за ${policy.escalationHours} ч — отклонён автоматически (политика согласования).`,
          );
          result.rejected++;
        } else if (!pass.approvalEscalatedAt) {
          await s.db
            .update(schema.passes)
            .set({ approvalEscalatedAt: new Date(now) })
            .where(eq(schema.passes.id, pass.id));
          await s.audit({
            siteId: pass.siteId,
            entity: 'pass',
            entityId: pass.id,
            action: 'approval_escalated',
            reason: `Не согласован за ${policy.escalationHours} ч`,
          });
          await s.emit('pass.approval_escalated', {
            siteId: pass.siteId,
            aggregate: 'pass',
            aggregateId: pass.id,
            payload: { passId: pass.id, tenantId: pass.tenantId },
          });
          result.escalated++;
        }
      }
    });
  }
  return result;
}

async function approvalRules(s: Scope, pass: PassRow) {
  const rows = await s.db
    .select()
    .from(schema.approvalPolicies)
    .where(
      and(
        eq(schema.approvalPolicies.organizationId, s.organizationId),
        eq(schema.approvalPolicies.siteId, pass.siteId),
        eq(schema.approvalPolicies.creatorKind, creatorOf(pass)),
        eq(schema.approvalPolicies.passType, pass.passType),
      ),
    );
  return rows.find((r) => r.tenantId === pass.tenantId) ?? rows.find((r) => r.tenantId === null);
}

/** Создатели пропусков для карточки согласования: «кто заказал» (A9). */
export async function creatorNames(s: Scope, passes: PassRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(passes.map((p) => p.createdBy).filter((v): v is string => v !== null))];
  if (ids.length === 0) return new Map();
  const rows = await s.db
    .select({ id: schema.users.id, name: schema.users.fullName })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

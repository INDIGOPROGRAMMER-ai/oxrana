import { createHash, randomBytes } from 'node:crypto';
import type { PassDraft, PassPatch, PassSource } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { formatDateTime } from '@oxrana/engine';
import { and, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { coversTenant, isTenantUser } from '../../actor';
import { assertTenantAccess, can, requirePermission, type Scope } from '../../core/context';
import { type AuditDiff, changedFields, diffOf } from '../../core/diff';
import { labelDiff } from '../../core/labels';
import { loadTenant, notFound, type TenantRow } from '../../core/loaders';
import { EXCLUSION_VIOLATION, pgErrorCode } from '../../core/refs';
import { AppError } from '../../errors';
import {
  approvalPolicy,
  assertTenantAcceptsPasses,
  CREATOR_LABEL,
  creatorKindOf,
  loadPassContext,
  PASS_TYPE_LABEL,
  type PassField,
  type PassValues,
  validatePass,
  valuesFromDraft,
  valuesFromPatch,
  valuesOf,
} from './validate';
import type { PassRow } from './views';

/** Подписи значений-ссылок пропуска в журнале. */
const PASS_LABELS = { categoryId: 'category', dockId: 'dock', destinationZoneId: 'zone' } as const;

/** Поля, которые у начавшегося согласованного пропуска арендатор меняет только заявкой (A8). */
const CHANGE_REQUEST_FIELDS: readonly PassField[] = [
  'plateRaw',
  'plateNorm',
  'plateCountry',
  'categoryId',
  'validFrom',
  'validTo',
];

export interface PassWarning {
  readonly code: string;
  readonly message: string;
}

export interface CreatedPass {
  readonly row: PassRow;
  readonly driverToken: string;
  readonly warnings: PassWarning[];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Права на создание: тип пропуска и арендатор (свой — или право «за любого арендатора»). */
function assertCanCreate(s: Scope, tenant: TenantRow, passType: PassDraft['passType']): void {
  requirePermission(s.ctx, `pass.create.${passType}`);
  const { actor } = s.ctx;
  if (isTenantUser(actor)) {
    assertTenantAccess(s.ctx, tenant.id);
    return;
  }
  if (!coversTenant(actor, tenant.id) || !can(s.ctx, 'pass.create_for_any_tenant')) {
    requirePermission(s.ctx, 'pass.create_for_any_tenant');
  }
}

/** Пропуск, с которым пересёкся новый (exclusion `passes_no_duplicate`): кому показать, что мешает. */
async function duplicateError(s: Scope, values: PassValues, tenantId: string, tz: string) {
  const from = values.validFrom ?? new Date(0);
  const to = values.validTo;
  const [other] = await s.db
    .select()
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.organizationId, s.organizationId),
        eq(schema.passes.tenantId, tenantId),
        eq(schema.passes.status, 'approved'),
        eq(schema.passes.plateNorm, values.plateNorm ?? ''),
        or(isNull(schema.passes.validTo), gt(schema.passes.validTo, from)),
        to === null ? undefined : lt(schema.passes.validFrom, to),
      ),
    )
    .limit(1);
  const period = other?.validFrom
    ? ` с ${formatDateTime(other.validFrom.getTime(), tz)}${other.validTo ? ` по ${formatDateTime(other.validTo.getTime(), tz)}` : ' без окончания'}`
    : '';
  return new AppError('pass_duplicate', {
    field: 'plate',
    message: `У арендатора уже есть действующий пропуск на ${values.plateNorm}${period}. Измените его или выберите другой срок.`,
    ...(other ? { details: { passId: other.id } } : {}),
  });
}

/**
 * Запись пропуска под SAVEPOINT: нарушение exclusion `passes_no_duplicate` не прерывает всю
 * транзакцию, и можно найти мешающий пропуск для понятной ошибки.
 */
async function writeGuarded<T>(
  s: Scope,
  write: (sp: Scope) => Promise<T>,
  onDuplicate: () => Promise<AppError>,
): Promise<T> {
  try {
    return await s.nested(write);
  } catch (error) {
    if (pgErrorCode(error).code === EXCLUSION_VIOLATION) throw await onDuplicate();
    throw error;
  }
}

/** Тот же номер у другого арендатора — не дубль, но пост спросит «к кому едет?» (10_ §4). */
async function otherTenantWarnings(
  s: Scope,
  values: PassValues,
  tenantId: string,
): Promise<PassWarning[]> {
  if (!values.plateNorm || !values.validFrom) return [];
  const rows = await s.db
    .select({ id: schema.passes.id })
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.organizationId, s.organizationId),
        ne(schema.passes.tenantId, tenantId),
        eq(schema.passes.status, 'approved'),
        eq(schema.passes.plateNorm, values.plateNorm),
        or(isNull(schema.passes.validTo), gt(schema.passes.validTo, values.validFrom)),
        values.validTo === null ? undefined : lt(schema.passes.validFrom, values.validTo),
      ),
    )
    .limit(1);
  return rows.length > 0
    ? [
        {
          code: 'same_plate_other_tenant',
          message:
            'На этот номер есть пропуск у другого арендатора — на посту охранник спросит, к кому едет машина.',
        },
      ]
    : [];
}

export interface CreateOptions {
  readonly via: PassSource;
  readonly batchId?: string;
  /** Пропуск по запросу с поста: создаёт пользователь арендатора, ответивший на запрос. */
  readonly gateAccountId?: string | null;
}

/** Создание пропуска (ARCHITECTURE §3.2): проверки, политика согласования, дубли, токен водителя. */
export async function createPass(
  s: Scope,
  tenant: TenantRow,
  draft: PassDraft,
  options: CreateOptions,
): Promise<CreatedPass> {
  assertCanCreate(s, tenant, draft.passType);
  const ctx = await loadPassContext(s, tenant);
  assertTenantAcceptsPasses(ctx);
  const values = valuesFromDraft(draft);
  await validatePass(s, ctx, values, 'all');

  const creator = creatorKindOf(s);
  const policy = await approvalPolicy(s, tenant.siteId, tenant.id, creator, values.passType);
  if (policy?.mode === 'deny') {
    throw new AppError('pass_type_forbidden', {
      message: `Политика «${CREATOR_LABEL[creator]} → ${PASS_TYPE_LABEL[values.passType]}» = Запрещено. Изменить: Настройки → Политики согласования.`,
      settingLink: '/admin/rules/approval-policies',
    });
  }
  if (policy?.commentRequired && !values.comment)
    throw new AppError('comment_required', { field: 'comment' });
  // Нет политики на сочетание — на согласование, а не молча (Q-55).
  const status = policy === null || policy.mode === 'on_request' ? 'pending_approval' : 'approved';
  const now = new Date(ctx.now);
  const { actor } = s.ctx;

  const [row] = await writeGuarded(
    s,
    (sp) =>
      sp.db
        .insert(schema.passes)
        .values({
          ...values,
          organizationId: s.organizationId,
          siteId: tenant.siteId,
          tenantId: tenant.id,
          status,
          createdBy: actor.kind === 'user' ? actor.id : null,
          createdVia: options.via,
          createdByGateAccountId:
            options.gateAccountId ?? (actor.kind === 'gate_account' ? actor.id : null),
          batchId: options.batchId ?? null,
          approvedAt: status === 'approved' ? now : null,
          // Время подачи — по часам сервиса (ADR-009): от него считается срок согласования.
          createdAt: now,
        })
        .returning(),
    () => duplicateError(s, values, tenant.id, ctx.site.timezone),
  );
  if (!row) throw new Error('pass insert');

  // Страница водителя: токен показывается один раз, в БД — хэш (ADR-007).
  const driverToken = randomBytes(32).toString('base64url');
  const end = row.validTo ?? new Date(ctx.now + 366 * 86_400_000);
  await s.db.insert(schema.passTokens).values({
    organizationId: s.organizationId,
    passId: row.id,
    tokenHash: hashToken(driverToken),
    expiresAt: new Date(end.getTime() + 86_400_000),
  });

  const written = (Object.keys(values) as PassField[]).filter((k) => values[k] !== null);
  await s.audit({
    siteId: row.siteId,
    entity: 'pass',
    entityId: row.id,
    action: 'create',
    diff: await labelDiff(s, diffOf(null, row, [...written, 'status']), PASS_LABELS),
    snapshot: { tenant: tenant.shortName, via: options.via },
  });
  await s.emit('pass.created', {
    siteId: row.siteId,
    aggregate: 'pass',
    aggregateId: row.id,
    payload: {
      passId: row.id,
      tenantId: row.tenantId,
      status: row.status,
      passType: row.passType,
      participant: row.participant,
    },
  });
  const warnings = await otherTenantWarnings(s, values, tenant.id);
  if (policy === null) {
    warnings.push({
      code: 'approval_policy_missing',
      message: `Политика «${CREATOR_LABEL[creator]} → ${PASS_TYPE_LABEL[values.passType]}» не задана — пропуск ушёл на согласование.`,
    });
  }
  return { row, driverToken, warnings };
}

export async function loadPass(
  s: Scope,
  passId: string,
): Promise<{ pass: PassRow; tenant: TenantRow }> {
  const [pass] = await s.db
    .select()
    .from(schema.passes)
    .where(and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, passId)));
  if (!pass) throw notFound('Пропуск');
  const tenant = await loadTenant(s, pass.tenantId, { includeDeleted: true });
  return { pass, tenant };
}

/** Просмотр пропуска: свои арендаторы — с `pass.view`, все арендаторы объекта — с `pass.view_all_tenants`. */
export function assertCanView(s: Scope, tenantId: string): void {
  if (can(s.ctx, 'pass.view_all_tenants') && !isTenantUser(s.ctx.actor)) return;
  requirePermission(s.ctx, 'pass.view', 'pass.view_all_tenants');
  assertTenantAccess(s.ctx, tenantId);
  if (s.ctx.actor.tenantIds === null) requirePermission(s.ctx, 'pass.view_all_tenants');
}

export interface PatchResult {
  readonly row: PassRow;
  readonly applied: string[];
  readonly changeRequest: typeof schema.passChangeRequests.$inferSelect | null;
}

const API_FIELD: Partial<Record<PassField, string>> = {
  plateRaw: 'plate',
  plateNorm: 'plate',
  plateCountry: 'plate',
};

/**
 * Правка пропуска (10_ §5): меняются только присланные и реально изменённые поля (сценарий 19).
 * У начавшегося пропуска нужна причина (сценарий 20). Пользователь арендатора номер, тип и срок
 * согласованного пропуска, который уже начался (или согласовывался), меняет заявкой — пропуск не
 * перевыпускается (A8, сценарий 41).
 */
export async function patchPass(s: Scope, passId: string, patch: PassPatch): Promise<PatchResult> {
  const { pass, tenant } = await loadPass(s, passId);
  assertCanView(s, tenant.id);
  if (pass.status === 'used' || pass.status === 'cancelled') {
    throw new AppError('pass_not_editable', {
      message:
        pass.status === 'used'
          ? 'Разовый пропуск использован — его не правят. Оформите новый.'
          : 'Пропуск отменён — его не правят. Оформите новый.',
    });
  }
  const ctx = await loadPassContext(s, tenant);
  const requested = valuesFromPatch(patch);
  const current = valuesOf(pass);
  // Тот же номер в другой записи («а123вс 174» вместо «А123ВС174») — не изменение номера.
  if (requested.plateNorm !== undefined && requested.plateNorm === current.plateNorm) {
    delete requested.plateRaw;
    delete requested.plateNorm;
    delete requested.plateCountry;
  }
  const fields = changedFields(
    current as unknown as Record<string, unknown>,
    requested,
  ) as PassField[];
  if (fields.length === 0) return { row: pass, applied: [], changeRequest: null };

  const started = pass.validFrom !== null && pass.validFrom.getTime() <= ctx.now;
  if (started && !patch.reason) {
    throw new AppError('reason_required', {
      field: 'reason',
      message: 'Пропуск уже действует — укажите причину изменения, она попадёт в журнал.',
    });
  }

  let viaRequest: PassField[] = [];
  if (isTenantUser(s.ctx.actor) && pass.status === 'approved') {
    const policy = await approvalPolicy(s, tenant.siteId, tenant.id, 'tenant', pass.passType);
    if (started || policy === null || policy.mode === 'on_request') {
      viaRequest = fields.filter((f) => CHANGE_REQUEST_FIELDS.includes(f));
    }
  }
  const direct = fields.filter((f) => !viaRequest.includes(f));
  if (direct.length > 0) requirePermission(s.ctx, 'pass.edit');
  if (viaRequest.length > 0) requirePermission(s.ctx, 'pass.change_request.create');

  // Проверяется пропуск таким, каким он станет (и с прямой правкой, и с запрошенной).
  const merged: PassValues = { ...current, ...requested };
  await validatePass(s, ctx, merged, new Set(fields));

  let row = pass;
  if (direct.length > 0) {
    const set = Object.fromEntries(direct.map((f) => [f, requested[f]])) as Partial<PassValues>;
    [row = pass] = await writeGuarded(
      s,
      (sp) =>
        sp.db
          .update(schema.passes)
          .set(set)
          .where(
            and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, pass.id)),
          )
          .returning(),
      () => duplicateError(s, { ...current, ...set }, tenant.id, ctx.site.timezone),
    );
    await s.audit({
      siteId: pass.siteId,
      entity: 'pass',
      entityId: pass.id,
      action: 'update',
      diff: await labelDiff(s, diffOf(pass, row, direct), PASS_LABELS),
      reason: patch.reason ?? null,
    });
    await s.emit('pass.updated', {
      siteId: pass.siteId,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: { passId: pass.id, tenantId: pass.tenantId, fields: apiFields(direct) },
    });
  }

  let changeRequest: PatchResult['changeRequest'] = null;
  if (viaRequest.length > 0) {
    const changes = diffOf(pass, { ...pass, ...requested }, viaRequest);
    [changeRequest = null] = await s.db
      .insert(schema.passChangeRequests)
      .values({
        organizationId: s.organizationId,
        passId: pass.id,
        changes,
        reason: patch.reason ?? null,
        status: 'pending',
        requestedBy: s.ctx.actor.id,
      })
      .returning();
    if (!changeRequest) throw new Error('change request insert');
    await s.audit({
      siteId: pass.siteId,
      entity: 'pass',
      entityId: pass.id,
      action: 'change_request',
      diff: await labelDiff(s, changes, PASS_LABELS),
      reason: patch.reason ?? null,
      snapshot: { changeRequestId: changeRequest.id },
    });
    await s.emit('pass.change_requested', {
      siteId: pass.siteId,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: {
        changeRequestId: changeRequest.id,
        passId: pass.id,
        tenantId: pass.tenantId,
        fields: apiFields(viaRequest),
      },
    });
  }
  return { row, applied: apiFields(direct), changeRequest };
}

function apiFields(fields: readonly PassField[]): string[] {
  return [...new Set(fields.map((f) => API_FIELD[f] ?? f))];
}

/** Решение по заявке на изменение: одобрение меняет тот же пропуск, история сохраняется (A8). */
export async function decideChangeRequest(
  s: Scope,
  requestId: string,
  decision: 'approved' | 'rejected',
  note: string | null,
): Promise<{ request: typeof schema.passChangeRequests.$inferSelect; pass: PassRow }> {
  const [request] = await s.db
    .select()
    .from(schema.passChangeRequests)
    .where(
      and(
        eq(schema.passChangeRequests.organizationId, s.organizationId),
        eq(schema.passChangeRequests.id, requestId),
      ),
    );
  if (!request) throw notFound('Заявка на изменение');
  const { pass, tenant } = await loadPass(s, request.passId);
  if (request.status !== 'pending') throw new AppError('change_request_closed');
  const now = new Date(s.ctx.now());
  let row = pass;
  if (decision === 'approved') {
    if (pass.status === 'used' || pass.status === 'cancelled') {
      throw new AppError('pass_not_editable', {
        message: 'Пропуск уже использован или отменён — заявку можно только отклонить.',
      });
    }
    const changes = request.changes as AuditDiff;
    const set: Record<string, unknown> = {};
    for (const [field, change] of Object.entries(changes)) {
      const to = change.to;
      set[field] =
        (field === 'validFrom' || field === 'validTo') && typeof to === 'string'
          ? new Date(to)
          : to;
    }
    const ctx = await loadPassContext(s, tenant);
    const merged = { ...valuesOf(pass), ...set } as PassValues;
    // Начало, утверждённое согласующим, в прошлом может быть: проверка «не в прошлом» — при заявке.
    const changed = new Set(Object.keys(set) as PassField[]);
    changed.delete('validFrom');
    await validatePass(s, ctx, merged, changed);
    [row = pass] = await writeGuarded(
      s,
      (sp) =>
        sp.db
          .update(schema.passes)
          .set(set)
          .where(
            and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, pass.id)),
          )
          .returning(),
      () => duplicateError(s, merged, tenant.id, ctx.site.timezone),
    );
    await s.audit({
      siteId: pass.siteId,
      entity: 'pass',
      entityId: pass.id,
      action: 'update',
      diff: await labelDiff(s, diffOf(pass, row, Object.keys(set)), PASS_LABELS),
      reason: `Заявка на изменение одобрена${request.reason ? `: ${request.reason}` : ''}`,
      snapshot: { changeRequestId: request.id },
    });
    await s.emit('pass.updated', {
      siteId: pass.siteId,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: {
        passId: pass.id,
        tenantId: pass.tenantId,
        fields: apiFields(Object.keys(set) as PassField[]),
      },
    });
  }
  const [updated = request] = await s.db
    .update(schema.passChangeRequests)
    .set({ status: decision, decidedBy: s.ctx.actor.id, decidedAt: now, decisionNote: note })
    .where(eq(schema.passChangeRequests.id, request.id))
    .returning();
  await s.audit({
    siteId: pass.siteId,
    entity: 'pass_change_request',
    entityId: request.id,
    action: decision === 'approved' ? 'approve' : 'reject',
    reason: note,
  });
  await s.emit('pass.change_decided', {
    siteId: pass.siteId,
    aggregate: 'pass',
    aggregateId: pass.id,
    payload: {
      changeRequestId: request.id,
      passId: pass.id,
      tenantId: pass.tenantId,
      status: decision,
    },
  });
  return { request: updated, pass: row };
}

/** Отмена пропуска: токен водителя отзывается, из очереди у ворот — выход. */
export async function cancelPass(s: Scope, passId: string, reason: string): Promise<PassRow> {
  const { pass, tenant } = await loadPass(s, passId);
  assertCanView(s, tenant.id);
  // «Отменить свои» (Q-56): без pass.cancel — только пропуска, созданные этим пользователем.
  if (!can(s.ctx, 'pass.cancel')) {
    requirePermission(s.ctx, 'pass.cancel_own');
    if (pass.createdBy !== s.ctx.actor.id) {
      throw new AppError('forbidden', {
        permission: 'pass.cancel',
        message:
          'Вы отменяете только свои пропуска. Этот оформил другой сотрудник — попросите его или ответственного за компанию.',
      });
    }
  }
  if (!['draft', 'pending_approval', 'approved'].includes(pass.status)) {
    throw new AppError('pass_not_editable', {
      message: 'Отменить можно только действующий или ожидающий согласования пропуск.',
    });
  }
  const now = new Date(s.ctx.now());
  const [row = pass] = await s.db
    .update(schema.passes)
    .set({ status: 'cancelled', cancelledReason: reason, closedAt: now })
    .where(and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, pass.id)))
    .returning();
  await s.db
    .update(schema.passTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.passTokens.passId, pass.id), isNull(schema.passTokens.revokedAt)));
  const left = await s.db
    .update(schema.gateQueue)
    .set({ leftAt: now, leftReason: 'cancelled' })
    .where(and(eq(schema.gateQueue.passId, pass.id), isNull(schema.gateQueue.leftAt)))
    .returning();
  for (const q of left) {
    await s.emit('queue.left', {
      siteId: pass.siteId,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: { passId: pass.id, tenantId: pass.tenantId, gateId: q.gateId, reason: 'cancelled' },
    });
  }
  await s.audit({
    siteId: pass.siteId,
    entity: 'pass',
    entityId: pass.id,
    action: 'cancel',
    diff: { status: { from: pass.status, to: 'cancelled' } },
    reason,
  });
  await s.emit('pass.status_changed', {
    siteId: pass.siteId,
    aggregate: 'pass',
    aggregateId: pass.id,
    payload: { passId: pass.id, tenantId: pass.tenantId, from: pass.status, to: 'cancelled' },
  });
  return row;
}

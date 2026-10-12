import { createHash } from 'node:crypto';
import {
  type GateActionInput,
  type GateActionResult,
  type GateActionType,
  SiteSettingsSchema,
  type VerdictView,
  type VisitFlag,
} from '@oxrana/contracts';
import { closeVisit, insertVisit, lockTenantForEntry, schema, updateVisit } from '@oxrana/db';
import { capacityOf, formatTime, type QuotaView, type Verdict } from '@oxrana/engine';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission, type Scope } from '../../core/context';
import { normalizeValue } from '../../core/diff';
import { AppError } from '../../errors';
import { siteTimeLabel } from '../org/sites';
import type { PassRow, VisitRow } from '../passes/views';
import {
  approvedOverrides,
  type GateCtx,
  gateContext,
  insertDecision,
  loadSitePass,
  passSubject,
  resolveSubject,
  runEngine,
  snapshotOf,
  tenantState,
} from './core';

/** Право на каждый вид действия поста (ADR-007): «впустить» и «выпустить» — разные права. */
export const ACTION_PERMISSION: Record<GateActionType, string> = {
  check_in: 'visit.check_in',
  check_out: 'visit.check_out',
  refuse: 'gate.refuse',
  redirect: 'gate.redirect',
  undo: 'gate.undo',
  passage: 'gate.passage',
};

/** Как выполняется действие: онлайн или из офлайн-очереди (ADR-005: «факт важнее лимита»). */
export interface ActionMode {
  readonly offline: boolean;
  readonly localVerdict?: { readonly code: string; readonly headline: string } | undefined;
}

type Result = Omit<GateActionResult, 'replayed'>;

/** Вердикт движка в ответе API (те же поля; readonly-массивы движка — обычные массивы JSON). */
export function verdictView(verdict: Verdict): VerdictView {
  return verdict as unknown as VerdictView;
}

type Extra = Omit<Partial<Result>, 'verdict'> & { verdict?: Verdict | null };

function result(
  action: GateActionInput,
  outcome: Result['outcome'],
  message: string,
  extra: Extra = {},
): Result {
  const { verdict, ...rest } = extra;
  return {
    actionId: action.id,
    type: action.type,
    outcome,
    code: null,
    message,
    verdict: verdict ? verdictView(verdict) : null,
    decisionId: null,
    visitId: null,
    passId: null,
    ...rest,
  };
}

const clientMs = (action: GateActionInput): number | null =>
  action.clientAt ? new Date(action.clientAt).getTime() : null;

function timeText(g: GateCtx, at: number): string {
  return `${formatTime(at, g.site.timezone)} (${siteTimeLabel(g.site, at)})`;
}

/** Лимиты арендатора, которые считают этот визит. */
function affectedQuotas(
  g: GateCtx,
  visit: Pick<VisitRow, 'tenantId' | 'participant' | 'categoryId'>,
): QuotaView[] {
  return g.rules.quotas.filter(
    (q) =>
      q.tenantId === visit.tenantId &&
      (q.participant === 'pedestrian'
        ? visit.participant === 'pedestrian'
        : visit.categoryId !== null && q.categoryIds.includes(visit.categoryId)),
  );
}

/** Табло и чужие карточки обновляются по `quota.changed` без F5 (сценарий 3). */
async function emitQuotaChanges(s: Scope, g: GateCtx, visit: VisitRow, now: number): Promise<void> {
  const quotas = affectedQuotas(g, visit);
  if (quotas.length === 0) return;
  const { state } = await tenantState(s, g, visit.tenantId, now);
  for (const q of quotas) {
    const occupied = state.occupancy.find((o) => o.quotaId === q.id)?.occupied ?? 0;
    await s.emit('quota.changed', {
      siteId: g.site.id,
      aggregate: 'quota',
      aggregateId: q.id,
      payload: {
        quotaId: q.id,
        tenantId: q.tenantId,
        occupied,
        capacity: capacityOf(q, g.rules.docks),
      },
    });
  }
}

/**
 * Освободилось место — сигнал только посту, где стоит первый в очереди (B5, сценарий 40): по
 * числу свободных мест первым ещё не оповещённым в порядке очереди.
 */
async function notifyQueue(s: Scope, g: GateCtx, visit: VisitRow, now: number): Promise<void> {
  const quotas = affectedQuotas(g, visit).filter((q) => q.enforcement === 'hard');
  if (quotas.length === 0) return;
  const { state } = await tenantState(s, g, visit.tenantId, now);
  for (const q of quotas) {
    const occupied = state.occupancy.find((o) => o.quotaId === q.id)?.occupied ?? 0;
    const free = capacityOf(q, g.rules.docks) - occupied;
    if (free <= 0) continue;
    const waiting = await s.db
      .select()
      .from(schema.gateQueue)
      .where(
        and(
          eq(schema.gateQueue.organizationId, s.organizationId),
          eq(schema.gateQueue.quotaId, q.id),
          isNull(schema.gateQueue.leftAt),
        ),
      )
      .orderBy(asc(schema.gateQueue.queuedAt), asc(schema.gateQueue.id))
      .limit(free);
    for (const entry of waiting) {
      if (entry.notifiedAt !== null) continue;
      await s.db
        .update(schema.gateQueue)
        .set({ notifiedAt: new Date(now) })
        .where(eq(schema.gateQueue.id, entry.id));
      await s.emit('queue.slot_freed', {
        siteId: g.site.id,
        aggregate: 'pass',
        aggregateId: entry.passId,
        payload: {
          passId: entry.passId,
          tenantId: entry.tenantId,
          gateId: entry.gateId,
          quotaId: q.id,
        },
      });
    }
  }
}

/** Выход из очереди у ворот (въехал, отказ, направлен на другой КПП). */
async function leaveQueue(
  s: Scope,
  g: GateCtx,
  pass: PassRow,
  reason: 'entered' | 'cancelled' | 'redirected',
  now: number,
): Promise<void> {
  const left = await s.db
    .update(schema.gateQueue)
    .set({ leftAt: new Date(now), leftReason: reason })
    .where(
      and(
        eq(schema.gateQueue.organizationId, s.organizationId),
        eq(schema.gateQueue.passId, pass.id),
        isNull(schema.gateQueue.leftAt),
      ),
    )
    .returning();
  for (const entry of left) {
    await s.emit('queue.left', {
      siteId: g.site.id,
      aggregate: 'pass',
      aggregateId: pass.id,
      payload: { passId: pass.id, tenantId: pass.tenantId, gateId: entry.gateId, reason },
    });
  }
}

/** Команда шлагбауму — только из транзакции успешного въезда или выезда (RULES_ENGINE §8). */
async function openBarrier(
  s: Scope,
  g: GateCtx,
  direction: 'in' | 'out',
  cause: 'check_in' | 'check_out' | 'override',
  visitId: string,
  decisionId: number,
): Promise<void> {
  const devices = await s.db
    .select({ id: schema.hardwareDevices.id, direction: schema.hardwareDevices.direction })
    .from(schema.hardwareDevices)
    .where(
      and(
        eq(schema.hardwareDevices.organizationId, s.organizationId),
        eq(schema.hardwareDevices.gateId, g.gate.id),
        eq(schema.hardwareDevices.kind, 'barrier'),
        isNull(schema.hardwareDevices.deletedAt),
      ),
    );
  const { actor } = s.ctx;
  for (const device of devices.filter(
    (d) => d.direction === null || d.direction === 'both' || d.direction === direction,
  )) {
    await s.db.insert(schema.barrierCommands).values({
      organizationId: s.organizationId,
      siteId: g.site.id,
      gateId: g.gate.id,
      deviceId: device.id,
      type: 'open',
      direction,
      issuedAt: new Date(s.ctx.now()),
      issuedByGateAccountId: actor.kind === 'gate_account' ? actor.id : null,
      issuedByUserId: actor.kind === 'user' ? actor.id : null,
      cause,
      visitId,
      decisionId,
    });
  }
}

/** Самый тесный жёсткий лимит, из-за которого «ждать» — по нему встают в очередь. */
function waitingQuota(verdict: Verdict): string | null {
  const over = verdict.quotaStates
    .filter((q) => q.enforcement === 'hard' && q.wouldBe > q.capacity)
    .sort((a, b) => a.capacity - a.occupied - (b.capacity - b.occupied));
  return over[0]?.quotaId ?? null;
}

const quotaWait = (verdict: Verdict) =>
  verdict.trace.some((t) => t.check === 'quota' && t.result === 'fail' && t.severity === 'wait');

/** Исключение, снявшее лимит: такой визит место не занимает (RULES_ENGINE §5). */
function quotaException(g: GateCtx, verdict: Verdict): string | null {
  return (
    verdict.appliedExceptionIds.find((id) =>
      g.rules.exceptions.find((e) => e.id === id)?.waives.includes('quota'),
    ) ?? null
  );
}

/**
 * Въезд (ADR-006): одна транзакция — блокировка арендатора, свежая занятость, повторный вердикт
 * движка и запись визита. Две машины на последнее место не проходят: вторая получает `wait`.
 * Из офлайн-очереди визит открывается всегда — машина уже внутри (ADR-005), с флагами.
 */
async function checkIn(
  s: Scope,
  g: GateCtx,
  action: Extract<GateActionInput, { type: 'check_in' }>,
  mode: ActionMode,
): Promise<Result> {
  if (g.gate.kind === 'internal') {
    throw new AppError('wrong_gate_kind', {
      message: 'На внутреннем посту отмечается проход, а не въезд на территорию.',
    });
  }
  const pass = await loadSitePass(s, g.site.id, action.passId);
  await lockTenantForEntry(s.db, pass.tenantId);
  const clientAt = clientMs(action);
  const now = mode.offline && clientAt !== null ? clientAt : s.ctx.now();
  const { state } = await tenantState(s, g, pass.tenantId, now);
  await s.ctx.deps.hooks.afterOccupancyRead?.(s.db);
  const resolved = await passSubject(s, pass);
  const overrides = await approvedOverrides(s, g.gate.id, pass.id, 'in', now);
  const verdict = runEngine(g, resolved.subject, 'in', now, state, overrides);

  if (resolved.openVisit) {
    const decisionId = await insertDecision(s, g, {
      direction: 'in',
      verdict,
      action: 'none',
      pass,
      visitId: resolved.openVisit.id,
      now: s.ctx.now(),
      clientAt,
      offline: mode.offline,
    });
    return result(
      action,
      'merged',
      'Уже на территории: въезд отмечен раньше, визит не открывается повторно.',
      {
        code: 'already_open',
        verdict,
        decisionId,
        visitId: resolved.openVisit.id,
        passId: pass.id,
      },
    );
  }

  const allowed = verdict.code === 'allow' || verdict.code === 'allow_overage';
  if (!allowed && !mode.offline) {
    const decisionId = await insertDecision(s, g, {
      direction: 'in',
      verdict,
      action: 'none',
      pass,
      now,
      clientAt,
    });
    if (verdict.code === 'wait' && quotaWait(verdict)) {
      const quotaId = waitingQuota(verdict);
      if (quotaId) {
        const joined = await s.db
          .insert(schema.gateQueue)
          .values({
            organizationId: s.organizationId,
            siteId: g.site.id,
            tenantId: pass.tenantId,
            gateId: g.gate.id,
            passId: pass.id,
            quotaId,
            queuedAt: new Date(now),
          })
          .onConflictDoNothing()
          .returning();
        if (joined.length > 0) {
          await s.emit('queue.joined', {
            siteId: g.site.id,
            aggregate: 'pass',
            aggregateId: pass.id,
            payload: { passId: pass.id, tenantId: pass.tenantId, gateId: g.gate.id, quotaId },
          });
        }
      }
    }
    await s.emit('gate.decision', {
      siteId: g.site.id,
      aggregate: 'gate',
      aggregateId: g.gate.id,
      payload: {
        decisionId,
        gateId: g.gate.id,
        passId: pass.id,
        tenantId: pass.tenantId,
        verdict: verdict.code,
        action: 'none',
      },
    });
    return result(action, 'rejected', verdict.headline, {
      code: verdict.code,
      verdict,
      decisionId,
      passId: pass.id,
    });
  }

  const flags = new Set<VisitFlag>(verdict.flags);
  if (mode.offline && !allowed) {
    if (quotaWait(verdict)) flags.add('offline_over_quota');
    if (pass.status === 'cancelled') flags.add('pass_cancelled_meanwhile');
  }
  const { actor } = s.ctx;
  const visit = await insertVisit(s.db, {
    organizationId: s.organizationId,
    siteId: g.site.id,
    tenantId: pass.tenantId,
    passId: pass.id,
    participant: pass.participant,
    categoryId: pass.categoryId,
    plateNorm: pass.plateNorm,
    snapshot: snapshotOf(g, pass),
    gateInId: g.gate.id,
    timeIn: new Date(now),
    gateAccountInId: actor.kind === 'gate_account' ? actor.id : null,
    deviceInId: actor.deviceId,
    methodIn: mode.offline ? 'sync' : (action.method ?? 'button'),
    overage: verdict.code === 'allow_overage',
    overageQuotaId: verdict.code === 'allow_overage' ? (verdict.overage?.quotaId ?? null) : null,
    exceptionId: quotaException(g, verdict),
    overrideId: verdict.appliedOverrideId ?? null,
    flags: [...flags],
    clientTimeIn: clientAt === null ? null : new Date(clientAt),
  });
  const decisionId = await insertDecision(s, g, {
    direction: 'in',
    verdict,
    action: 'check_in',
    pass,
    visitId: visit.id,
    now: s.ctx.now(),
    clientAt,
    offline: mode.offline,
  });
  await updateVisit(s.db, s.organizationId, visit.id, { decisionInId: decisionId });
  if (verdict.appliedOverrideId) {
    await s.db
      .update(schema.overrideRequests)
      .set({ status: 'used' })
      .where(eq(schema.overrideRequests.id, verdict.appliedOverrideId));
  }
  await leaveQueue(s, g, pass, 'entered', now);
  await s.audit({
    siteId: g.site.id,
    entity: 'visit',
    entityId: visit.id,
    action: 'check_in',
    snapshot: {
      ...snapshotOf(g, pass),
      verdict: verdict.code,
      offline: mode.offline,
      flags: [...flags],
    },
  });
  await s.emit('visit.opened', {
    siteId: g.site.id,
    aggregate: 'visit',
    aggregateId: visit.id,
    payload: {
      visitId: visit.id,
      passId: pass.id,
      tenantId: pass.tenantId,
      gateId: g.gate.id,
      participant: pass.participant,
      categoryId: pass.categoryId,
      overage: visit.overage,
      flags: visit.flags,
    },
  });
  await emitQuotaChanges(s, g, visit, now);
  await openBarrier(
    s,
    g,
    'in',
    verdict.appliedOverrideId ? 'override' : 'check_in',
    visit.id,
    decisionId,
  );
  const overage =
    verdict.code === 'allow_overage' && verdict.overage
      ? ` — сверх лимита, ${verdict.overage.tariffRub} ₽ за сутки`
      : '';
  return result(action, 'applied', `Въезд отмечен ${timeText(g, now)}${overage}`, {
    code: mode.offline && !allowed ? 'offline_accepted' : verdict.code,
    verdict,
    decisionId,
    visitId: visit.id,
    passId: pass.id,
  });
}

/**
 * Выезд: закрыть открытый визит (идемпотентно — повторный выезд с другого КПП «сливается»). Нет
 * открытого визита — «выпустить с отметкой» с причиной: визит создаётся сразу закрытым, лимит в
 * минус не уходит (сценарий 16).
 */
async function checkOut(
  s: Scope,
  g: GateCtx,
  action: Extract<GateActionInput, { type: 'check_out' }>,
  mode: ActionMode,
): Promise<Result> {
  if (g.gate.kind === 'internal') {
    throw new AppError('wrong_gate_kind', {
      message: 'На внутреннем посту отмечается проход, а не выезд с территории.',
    });
  }
  const clientAt = clientMs(action);
  const now = mode.offline && clientAt !== null ? clientAt : s.ctx.now();
  let target: { passId?: string; plateQuery?: string } = {};
  if (action.visitId) {
    const [visit] = await s.db
      .select()
      .from(schema.visits)
      .where(
        and(
          eq(schema.visits.organizationId, s.organizationId),
          eq(schema.visits.siteId, g.site.id),
          eq(schema.visits.id, action.visitId),
        ),
      );
    if (!visit) throw new AppError('not_found', { message: 'Визит не найден. Обновите экран.' });
    if (visit.timeOut !== null) {
      return result(action, 'merged', 'Выезд уже отмечен раньше.', {
        code: 'already_closed',
        visitId: visit.id,
        passId: visit.passId,
      });
    }
    target = visit.passId ? { passId: visit.passId } : { plateQuery: visit.plateNorm ?? '' };
  } else if (action.passId) {
    target = { passId: action.passId };
  } else if (action.plateQuery) {
    target = { plateQuery: action.plateQuery };
  } else {
    throw new AppError('validation_failed', {
      field: 'passId',
      message: 'Укажите пропуск, визит или номер машины.',
    });
  }
  const resolved = await resolveSubject(s, g, target, 'out', now);
  const pass = resolved.pass;
  const tenantId = pass?.tenantId ?? resolved.openVisit?.tenantId ?? null;
  const live = tenantId
    ? (await tenantState(s, g, tenantId, now)).state
    : { occupancy: [], queue: [], asOf: now };
  const verdict = runEngine(g, resolved.subject, 'out', now, live, []);
  const openVisit =
    resolved.openVisit && resolved.openVisit.timeOut === null ? resolved.openVisit : null;
  const { actor } = s.ctx;

  if (openVisit) {
    const flags = [...new Set([...openVisit.flags, ...verdict.flags])];
    const closed = await closeVisit(s.db, s.organizationId, openVisit.id, {
      timeOut: new Date(now),
      gateOutId: g.gate.id,
      gateAccountOutId: actor.kind === 'gate_account' ? actor.id : null,
      deviceOutId: actor.deviceId,
      methodOut: mode.offline ? 'sync' : (action.method ?? 'button'),
      flags,
      clientTimeOut: clientAt === null ? null : new Date(clientAt),
    });
    if (!closed) {
      return result(action, 'merged', 'Выезд уже отмечен с другого КПП.', {
        code: 'already_closed',
        verdict,
        visitId: openVisit.id,
        passId: openVisit.passId,
      });
    }
    const decisionId = await insertDecision(s, g, {
      direction: 'out',
      verdict,
      action: 'check_out',
      pass,
      visitId: closed.id,
      now: s.ctx.now(),
      clientAt,
      offline: mode.offline,
    });
    await updateVisit(s.db, s.organizationId, closed.id, { decisionOutId: decisionId });
    if (pass && pass.passType === 'single' && pass.status === 'approved') {
      await s.db
        .update(schema.passes)
        .set({ status: 'used', closedAt: new Date(now) })
        .where(eq(schema.passes.id, pass.id));
      await s.emit('pass.status_changed', {
        siteId: g.site.id,
        aggregate: 'pass',
        aggregateId: pass.id,
        payload: { passId: pass.id, tenantId: pass.tenantId, from: 'approved', to: 'used' },
      });
    }
    await s.audit({
      siteId: g.site.id,
      entity: 'visit',
      entityId: closed.id,
      action: 'check_out',
      snapshot: { ...snapshotOf(g, pass), flags, offline: mode.offline },
    });
    await s.emit('visit.closed', {
      siteId: g.site.id,
      aggregate: 'visit',
      aggregateId: closed.id,
      payload: {
        visitId: closed.id,
        passId: closed.passId,
        tenantId: closed.tenantId,
        gateId: g.gate.id,
        flags: closed.flags,
      },
    });
    await emitQuotaChanges(s, g, closed, now);
    await notifyQueue(s, g, closed, now);
    await openBarrier(s, g, 'out', 'check_out', closed.id, decisionId);
    return result(action, 'applied', `Выезд отмечен ${timeText(g, now)}`, {
      code: verdict.code,
      verdict,
      decisionId,
      visitId: closed.id,
      passId: closed.passId,
    });
  }

  // Въезд не отмечен: «выпустить с отметкой» — причина обязательна (сценарий 16, ADR-005).
  if (!action.reason) {
    throw new AppError('reason_required', {
      field: 'reason',
      message: 'Въезд не отмечен — укажите причину выезда с отметкой, она попадёт в журнал.',
    });
  }
  let visitId: string | null = null;
  if (pass) {
    await lockTenantForEntry(s.db, pass.tenantId);
    const visit = await insertVisit(s.db, {
      organizationId: s.organizationId,
      siteId: g.site.id,
      tenantId: pass.tenantId,
      passId: pass.id,
      participant: pass.participant,
      categoryId: pass.categoryId,
      plateNorm: pass.plateNorm,
      snapshot: snapshotOf(g, pass),
      gateOutId: g.gate.id,
      timeOut: new Date(now),
      gateAccountOutId: actor.kind === 'gate_account' ? actor.id : null,
      deviceOutId: actor.deviceId,
      methodOut: mode.offline ? 'sync' : (action.method ?? 'button'),
      flags: [...new Set<VisitFlag>([...verdict.flags, 'no_checkin'])],
      clientTimeOut: clientAt === null ? null : new Date(clientAt),
    });
    visitId = visit.id;
  }
  const decisionId = await insertDecision(s, g, {
    direction: 'out',
    verdict,
    action: 'check_out',
    pass,
    plateQuery: action.plateQuery ?? null,
    visitId,
    now: s.ctx.now(),
    clientAt,
    offline: mode.offline,
  });
  if (visitId) await updateVisit(s.db, s.organizationId, visitId, { decisionOutId: decisionId });
  await s.audit({
    siteId: g.site.id,
    entity: visitId ? 'visit' : 'gate_decision',
    entityId: visitId ?? g.gate.id,
    action: 'check_out_flagged',
    reason: action.reason,
    snapshot: { ...snapshotOf(g, pass), decisionId },
  });
  if (visitId && pass) {
    await s.emit('visit.closed', {
      siteId: g.site.id,
      aggregate: 'visit',
      aggregateId: visitId,
      payload: {
        visitId,
        passId: pass.id,
        tenantId: pass.tenantId,
        gateId: g.gate.id,
        flags: ['no_checkin'],
      },
    });
  }
  return result(action, 'applied', `Выезд с отметкой ${timeText(g, now)}: въезд не был отмечен`, {
    code: 'no_checkin',
    verdict,
    decisionId,
    visitId,
    passId: pass?.id ?? null,
  });
}

/** Отмена последнего действия в окне `undoWindowSec` (сценарий 17): в журнале — оба события. */
async function undo(
  s: Scope,
  g: GateCtx,
  action: Extract<GateActionInput, { type: 'undo' }>,
  mode: ActionMode,
): Promise<Result & { undoOf: string }> {
  const [target] = await s.db
    .select()
    .from(schema.gateActions)
    .where(
      and(
        eq(schema.gateActions.organizationId, s.organizationId),
        eq(schema.gateActions.id, action.actionId),
      ),
    );
  if (!target || target.gateId !== g.gate.id) {
    throw new AppError('nothing_to_undo', {
      message: 'Действие для отмены не найдено на этом посту.',
    });
  }
  if (
    target.outcome !== 'applied' ||
    !target.visitId ||
    !['check_in', 'check_out'].includes(target.type)
  ) {
    throw new AppError('nothing_to_undo');
  }
  const [already] = await s.db
    .select({ id: schema.gateActions.id })
    .from(schema.gateActions)
    .where(eq(schema.gateActions.undoOf, target.id));
  if (already) throw new AppError('nothing_to_undo', { message: 'Это действие уже отменено.' });
  const now = s.ctx.now();
  const windowSec = SiteSettingsSchema.parse(g.site.settings).undoWindowSec;
  if (!mode.offline && now - target.receivedAt.getTime() > windowSec * 1000) {
    throw new AppError('undo_window_passed', {
      message: `Отменить можно в течение ${Math.round(windowSec / 60)} мин после действия. Исправить запись может администратор с причиной.`,
    });
  }
  const [visit] = await s.db
    .select()
    .from(schema.visits)
    .where(
      and(eq(schema.visits.organizationId, s.organizationId), eq(schema.visits.id, target.visitId)),
    );
  if (!visit) throw new AppError('nothing_to_undo');
  await lockTenantForEntry(s.db, visit.tenantId);
  const pass = visit.passId ? await loadSitePass(s, g.site.id, visit.passId) : null;
  const flags = [...new Set<VisitFlag>([...visit.flags, 'undone'])];
  let updated: VisitRow | null;
  if (target.type === 'check_in') {
    if (visit.timeOut !== null) {
      throw new AppError('nothing_to_undo', {
        message: 'Машина уже выехала — отменять въезд поздно.',
      });
    }
    updated = await updateVisit(s.db, s.organizationId, visit.id, {
      timeOut: new Date(now),
      flags,
    });
  } else {
    updated = await updateVisit(s.db, s.organizationId, visit.id, {
      timeOut: null,
      gateOutId: null,
      gateAccountOutId: null,
      deviceOutId: null,
      methodOut: null,
      decisionOutId: null,
      clientTimeOut: null,
      flags,
    });
    if (pass && pass.passType === 'single' && pass.status === 'used') {
      await s.db
        .update(schema.passes)
        .set({ status: 'approved', closedAt: null })
        .where(eq(schema.passes.id, pass.id));
      await s.emit('pass.status_changed', {
        siteId: g.site.id,
        aggregate: 'pass',
        aggregateId: pass.id,
        payload: { passId: pass.id, tenantId: pass.tenantId, from: 'used', to: 'approved' },
      });
    }
  }
  if (!updated) throw new AppError('nothing_to_undo');
  const live = (await tenantState(s, g, visit.tenantId, now)).state;
  const direction = target.type === 'check_in' ? 'in' : 'out';
  const verdict = pass
    ? runEngine(g, (await passSubject(s, pass)).subject, direction, now, live, [])
    : null;
  const decisionId = verdict
    ? await insertDecision(s, g, {
        direction,
        verdict,
        action: 'undo',
        pass,
        visitId: visit.id,
        now,
        clientAt: clientMs(action),
        offline: mode.offline,
      })
    : null;
  await s.audit({
    siteId: g.site.id,
    entity: 'visit',
    entityId: visit.id,
    action: 'undo',
    diff: {
      timeOut: { from: normalizeValue(visit.timeOut), to: normalizeValue(updated.timeOut) },
      flags: { from: visit.flags, to: updated.flags },
    },
    reason: action.reason ?? null,
    snapshot: { undoneAction: target.id, undoneType: target.type },
  });
  await s.emit('visit.undone', {
    siteId: g.site.id,
    aggregate: 'visit',
    aggregateId: visit.id,
    payload: {
      visitId: visit.id,
      passId: visit.passId,
      tenantId: visit.tenantId,
      gateId: g.gate.id,
      undone: target.type === 'check_in' ? 'check_in' : 'check_out',
    },
  });
  await emitQuotaChanges(s, g, updated, now);
  if (target.type === 'check_in') await notifyQueue(s, g, updated, now);
  return {
    ...result(
      action,
      'applied',
      target.type === 'check_in'
        ? 'Въезд отменён — место освобождено'
        : 'Выезд отменён — визит снова открыт',
      { code: 'undone', verdict, decisionId, visitId: visit.id, passId: visit.passId },
    ),
    undoOf: target.id,
  };
}

/** Отказ и «направить на другой КПП» — решения без визита, в журнал КПП с причиной. */
async function refuseOrRedirect(
  s: Scope,
  g: GateCtx,
  action: Extract<GateActionInput, { type: 'refuse' | 'redirect' }>,
  mode: ActionMode,
): Promise<Result> {
  const clientAt = clientMs(action);
  const now = mode.offline && clientAt !== null ? clientAt : s.ctx.now();
  if (!action.passId && !action.plateQuery) {
    throw new AppError('validation_failed', {
      field: 'passId',
      message: 'Укажите пропуск или номер машины.',
    });
  }
  const resolved = await resolveSubject(
    s,
    g,
    action.passId ? { passId: action.passId } : { plateQuery: action.plateQuery },
    action.direction,
    now,
  );
  const tenantId = resolved.pass?.tenantId;
  const live = tenantId
    ? (await tenantState(s, g, tenantId, now)).state
    : { occupancy: [], queue: [], asOf: now };
  const verdict = runEngine(g, resolved.subject, action.direction, now, live, []);
  const decisionId = await insertDecision(s, g, {
    direction: action.direction,
    verdict,
    action: action.type,
    pass: resolved.pass,
    plateQuery: action.plateQuery ?? null,
    now: s.ctx.now(),
    clientAt,
    offline: mode.offline,
  });
  if (resolved.pass) {
    await leaveQueue(
      s,
      g,
      resolved.pass,
      action.type === 'refuse' ? 'cancelled' : 'redirected',
      now,
    );
  }
  if (action.type === 'refuse') {
    await s.audit({
      siteId: g.site.id,
      entity: 'gate_decision',
      entityId: resolved.pass?.id ?? g.gate.id,
      action: 'refuse',
      reason: action.reason,
      snapshot: { ...snapshotOf(g, resolved.pass), decisionId },
    });
  }
  await s.emit('gate.decision', {
    siteId: g.site.id,
    aggregate: 'gate',
    aggregateId: g.gate.id,
    payload: {
      decisionId,
      gateId: g.gate.id,
      passId: resolved.pass?.id ?? null,
      tenantId: resolved.pass?.tenantId ?? null,
      verdict: verdict.code,
      action: action.type,
    },
  });
  const targetGate =
    action.type === 'redirect'
      ? (g.rules.gates.find((x) => x.id === (action.targetGateId ?? verdict.suggestedGateIds[0]))
          ?.name ?? null)
      : null;
  return result(
    action,
    'applied',
    action.type === 'refuse'
      ? 'Отказ записан в журнал'
      : `Направлен${targetGate ? ` на ${targetGate}` : ' на другой КПП'}`,
    { code: verdict.code, verdict, decisionId, passId: resolved.pass?.id ?? null },
  );
}

/** Проход внутреннего поста (A4): визит не меняется, разовый не «тратится». */
async function passage(
  s: Scope,
  g: GateCtx,
  action: Extract<GateActionInput, { type: 'passage' }>,
  mode: ActionMode,
): Promise<Result> {
  if (g.gate.kind !== 'internal') {
    throw new AppError('wrong_gate_kind', {
      message: 'Проход отмечается на внутреннем посту; на КПП периметра — въезд и выезд.',
    });
  }
  const clientAt = clientMs(action);
  const now = mode.offline && clientAt !== null ? clientAt : s.ctx.now();
  const direction = action.direction ?? 'in';
  const pass = await loadSitePass(s, g.site.id, action.passId);
  const resolved = await passSubject(s, pass);
  const live = (await tenantState(s, g, pass.tenantId, now)).state;
  const verdict = runEngine(g, resolved.subject, direction, now, live, []);
  const allowed = verdict.code === 'allow' || mode.offline;
  const decisionId = await insertDecision(s, g, {
    direction,
    verdict,
    action: allowed ? 'passage' : 'none',
    pass,
    now: s.ctx.now(),
    clientAt,
    offline: mode.offline,
  });
  if (allowed) {
    const { actor } = s.ctx;
    await s.db.insert(schema.gatePassages).values({
      organizationId: s.organizationId,
      siteId: g.site.id,
      gateId: g.gate.id,
      at: new Date(now),
      passId: pass.id,
      direction,
      decisionId,
      gateAccountId: actor.kind === 'gate_account' ? actor.id : null,
      deviceId: actor.deviceId,
      snapshot: snapshotOf(g, pass),
    });
  }
  await s.emit('gate.decision', {
    siteId: g.site.id,
    aggregate: 'gate',
    aggregateId: g.gate.id,
    payload: {
      decisionId,
      gateId: g.gate.id,
      passId: pass.id,
      tenantId: pass.tenantId,
      verdict: verdict.code,
      action: allowed ? 'passage' : 'none',
    },
  });
  return result(
    action,
    allowed ? 'applied' : 'rejected',
    allowed ? `Проход отмечен ${timeText(g, now)}` : verdict.headline,
    {
      code: verdict.code,
      verdict,
      decisionId,
      passId: pass.id,
    },
  );
}

/** Отпечаток тела действия: тот же id с другими данными — ошибка, а не тихая подмена. */
function requestHash(action: GateActionInput): string {
  const sorted = Object.fromEntries(Object.entries(action).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Идемпотентное действие поста (ADR-005): блокировка по id действия, повтор возвращает
 * сохранённый ответ; новое действие выполняется и записывается в `gate_actions` в той же
 * транзакции. Ошибка (нет права, нет причины) ничего не записывает — повтор выполнится заново.
 */
export async function runAction(
  s: Scope,
  action: GateActionInput,
  mode: ActionMode,
): Promise<GateActionResult> {
  requirePermission(s.ctx, ACTION_PERMISSION[action.type]);
  const g = await gateContext(s);
  await s.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`gate-action:${action.id}`}))`);
  const hash = requestHash(action);
  const [existing] = await s.db
    .select()
    .from(schema.gateActions)
    .where(
      and(
        eq(schema.gateActions.organizationId, s.organizationId),
        eq(schema.gateActions.id, action.id),
      ),
    );
  if (existing) {
    if (existing.requestHash !== hash) {
      throw new AppError('idempotency_conflict', {
        message: 'Действие с этим id уже выполнено с другими данными. Повторите с новым id.',
      });
    }
    return { ...(existing.response as Omit<GateActionResult, 'replayed'>), replayed: true };
  }

  let outcome: Result & { undoOf?: string };
  switch (action.type) {
    case 'check_in':
      outcome = await checkIn(s, g, action, mode);
      break;
    case 'check_out':
      outcome = await checkOut(s, g, action, mode);
      break;
    case 'undo':
      outcome = await undo(s, g, action, mode);
      break;
    case 'passage':
      outcome = await passage(s, g, action, mode);
      break;
    default:
      outcome = await refuseOrRedirect(s, g, action, mode);
  }
  const { undoOf, ...response } = outcome;
  const { actor } = s.ctx;
  await s.db.insert(schema.gateActions).values({
    id: action.id,
    organizationId: s.organizationId,
    siteId: g.site.id,
    gateId: g.gate.id,
    type: action.type,
    gateAccountId: actor.kind === 'gate_account' ? actor.id : null,
    deviceId: actor.deviceId,
    userId: actor.kind === 'user' ? actor.id : null,
    clientAt: action.clientAt ? new Date(action.clientAt) : null,
    receivedAt: new Date(s.ctx.now()),
    offline: mode.offline,
    requestHash: hash,
    outcome: response.outcome,
    passId: response.passId,
    visitId: response.visitId,
    decisionId: response.decisionId,
    undoOf: undoOf ?? null,
    response,
  });
  // Офлайн: что показал пост, — второй записью журнала рядом с серверным вердиктом (ADR-005).
  if (mode.offline && mode.localVerdict && response.verdict) {
    await insertDecision(s, g, {
      direction:
        'direction' in action && action.direction
          ? action.direction
          : action.type === 'check_out'
            ? 'out'
            : 'in',
      verdict: {
        ...(response.verdict as unknown as Verdict),
        code: mode.localVerdict.code as Verdict['code'],
        headline: mode.localVerdict.headline,
      },
      action: 'none',
      pass: response.passId ? await loadSitePass(s, g.site.id, response.passId) : null,
      visitId: response.visitId,
      now: s.ctx.now(),
      clientAt: clientMs(action),
      offline: true,
    });
  }
  return { ...response, replayed: false };
}

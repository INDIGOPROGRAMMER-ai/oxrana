import { type DbTx, openVisits, schema } from '@oxrana/db';
import {
  type ApprovedOverride,
  countOccupancy,
  ENGINE_VERSION,
  type EvaluationInput,
  evaluate,
  type GateView,
  type LiveState,
  type PassageDirection,
  type RuleSet,
  resolveCandidates,
  resolvePedestrian,
  type SiteView,
  type Subject,
  type Verdict,
} from '@oxrana/engine';
import { normalizePlateText } from '@oxrana/plates';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import { type GateRow, loadGate, loadSite, notFound, type SiteRow } from '../../core/loaders';
import { AppError } from '../../errors';
import { enginePass, engineVisit, type PassRow, type VisitRow } from '../passes/views';

/** КПП учётки поста и всё, что нужно движку для этого КПП (RULES_ENGINE §1). */
export interface GateCtx {
  readonly gate: GateRow;
  readonly site: SiteRow;
  readonly siteView: SiteView;
  readonly gateView: GateView;
  readonly rules: RuleSet;
}

/** Действия поста выполняет учётка КПП: КПП берётся из её токена, клиент его не выбирает (ADR-007). */
export function requireGateId(s: Scope): string {
  const gateId = s.ctx.actor.gateId;
  if (!gateId) throw new AppError('gate_device_required');
  return gateId;
}

export async function gateContext(s: Scope): Promise<GateCtx> {
  const gate = await loadGate(s, requireGateId(s));
  const site = await loadSite(s, gate.siteId);
  const { site: siteView, rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  const gateView = rules.gates.find((g) => g.id === gate.id);
  if (!gateView) throw notFound('КПП');
  return { gate, site, siteView, gateView, rules };
}

export async function loadSitePass(s: Scope, siteId: string, passId: string): Promise<PassRow> {
  const [pass] = await s.db
    .select()
    .from(schema.passes)
    .where(
      and(
        eq(schema.passes.organizationId, s.organizationId),
        eq(schema.passes.siteId, siteId),
        eq(schema.passes.id, passId),
      ),
    );
  if (!pass) throw notFound('Пропуск');
  return pass;
}

/** Визиты пропуска: открытый (если машина внутри) и закрытые — для «разовый использован». */
export async function passVisits(
  db: DbTx,
  organizationId: string,
  passId: string,
): Promise<{ open: VisitRow | null; past: VisitRow[] }> {
  const rows = await db
    .select()
    .from(schema.visits)
    .where(and(eq(schema.visits.organizationId, organizationId), eq(schema.visits.passId, passId)))
    .orderBy(desc(schema.visits.timeIn));
  return {
    open: rows.find((v) => v.timeOut === null) ?? null,
    past: rows.filter((v) => v.timeOut !== null),
  };
}

/**
 * Живое состояние арендатора (LiveState): занятость лимитов по открытым визитам тем же
 * `countOccupancy`, что и на посту офлайн, и очередь у ворот. Внутри въезда — после блокировки.
 */
export async function tenantState(
  s: Scope,
  g: GateCtx,
  tenantId: string,
  now: number,
): Promise<{ state: LiveState; open: VisitRow[] }> {
  const open = await openVisits(s.db, {
    organizationId: s.organizationId,
    siteId: g.site.id,
    tenantId,
  });
  const views = open.map(engineVisit);
  const occupancy = g.rules.quotas
    .filter((q) => q.tenantId === tenantId)
    .map((q) => ({ quotaId: q.id, occupied: countOccupancy(views, q) }));
  const waiting = await s.db
    .select({ quotaId: schema.gateQueue.quotaId, passId: schema.gateQueue.passId })
    .from(schema.gateQueue)
    .where(
      and(
        eq(schema.gateQueue.organizationId, s.organizationId),
        eq(schema.gateQueue.tenantId, tenantId),
        isNull(schema.gateQueue.leftAt),
      ),
    )
    .orderBy(asc(schema.gateQueue.queuedAt), asc(schema.gateQueue.id));
  const queue = new Map<string, string[]>();
  for (const w of waiting) queue.set(w.quotaId, [...(queue.get(w.quotaId) ?? []), w.passId]);
  return {
    state: {
      occupancy,
      queue: [...queue].map(([quotaId, passIds]) => ({ quotaId, passIds })),
      asOf: now,
    },
    open,
  };
}

/** Одобренные и не истёкшие запросы исключения для пропуска на этом КПП (ADR-007, этап 5 — одобрение). */
export async function approvedOverrides(
  s: Scope,
  gateId: string,
  passId: string | null,
  direction: PassageDirection,
  now: number,
): Promise<ApprovedOverride[]> {
  if (!passId) return [];
  const rows = await s.db
    .select()
    .from(schema.overrideRequests)
    .where(
      and(
        eq(schema.overrideRequests.organizationId, s.organizationId),
        eq(schema.overrideRequests.gateId, gateId),
        eq(schema.overrideRequests.passId, passId),
        eq(schema.overrideRequests.direction, direction),
        eq(schema.overrideRequests.status, 'approved'),
        or(
          isNull(schema.overrideRequests.validUntil),
          gt(schema.overrideRequests.validUntil, new Date(now)),
        ),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    passId: r.passId,
    plateNorm: r.plateNorm,
    gateId: r.gateId,
    direction: r.direction,
    validUntil: r.validUntil?.getTime() ?? null,
  }));
}

export interface Resolved {
  readonly subject: Subject;
  readonly pass: PassRow | null;
  readonly openVisit: VisitRow | null;
}

/** Субъект «пропуск»: с открытым и закрытыми визитами (для «уже на территории», «разовый использован»). */
export async function passSubject(s: Scope, pass: PassRow): Promise<Resolved> {
  const visits = await passVisits(s.db, s.organizationId, pass.id);
  return {
    subject: {
      kind: 'pass',
      pass: enginePass(pass),
      openVisit: visits.open ? engineVisit(visits.open) : null,
      pastVisits: visits.past.map(engineVisit),
    },
    pass,
    openVisit: visits.open,
  };
}

/**
 * Что проверяем (RULES_ENGINE §6): пропуск по id, номер или фамилия. Номер и фамилия разрешаются
 * тем же `resolveCandidates` / `resolvePedestrian`, что на посту офлайн; найденный пропуск
 * проверяется как пропуск — с его визитами.
 */
export async function resolveSubject(
  s: Scope,
  g: GateCtx,
  input: {
    passId?: string | undefined;
    plateQuery?: string | undefined;
    personQuery?: string | undefined;
  },
  direction: PassageDirection,
  now: number,
): Promise<Resolved> {
  if (input.passId) return passSubject(s, await loadSitePass(s, g.site.id, input.passId));
  const org = eq(schema.passes.organizationId, s.organizationId);
  const site = eq(schema.passes.siteId, g.site.id);
  if (input.plateQuery !== undefined) {
    const plateNorm = normalizePlateText(input.plateQuery);
    if (!plateNorm) throw new AppError('plate_required', { field: 'plateQuery' });
    const openByPlate = await s.db
      .select()
      .from(schema.visits)
      .where(
        and(
          eq(schema.visits.organizationId, s.organizationId),
          eq(schema.visits.siteId, g.site.id),
          eq(schema.visits.plateNorm, plateNorm),
          isNull(schema.visits.timeOut),
        ),
      );
    if (direction === 'out') {
      const visit = openByPlate.find((v) => v.passId !== null);
      if (visit?.passId) return passSubject(s, await loadSitePass(s, g.site.id, visit.passId));
    }
    const exact = await s.db
      .select()
      .from(schema.passes)
      .where(and(org, site, eq(schema.passes.plateNorm, plateNorm)))
      .orderBy(desc(schema.passes.validFrom))
      .limit(20);
    const similar = await s.db
      .select()
      .from(schema.passes)
      .where(
        and(
          org,
          site,
          eq(schema.passes.status, 'approved'),
          sql`${schema.passes.plateNorm} % ${plateNorm}`,
          or(isNull(schema.passes.validTo), gt(schema.passes.validTo, new Date(now - 86_400_000))),
        ),
      )
      .limit(20);
    const rows = [...new Map([...exact, ...similar].map((p) => [p.id, p])).values()];
    const candidates = rows.map(enginePass);
    const resolved = resolveCandidates({ plateNorm, candidates }, now);
    if (resolved.kind === 'one') {
      const row = rows.find((p) => p.id === resolved.pass.id);
      if (row) return passSubject(s, row);
    }
    return {
      subject: { kind: 'plate', plateNorm, candidates, openVisits: openByPlate.map(engineVisit) },
      pass: null,
      openVisit: openByPlate[0] ?? null,
    };
  }
  const nameQuery = input.personQuery ?? '';
  const rows = await s.db
    .select()
    .from(schema.passes)
    .where(
      and(
        org,
        site,
        eq(schema.passes.participant, 'pedestrian'),
        inArray(schema.passes.status, ['approved']),
        ilike(schema.passes.personName, `%${nameQuery.replaceAll('%', '')}%`),
      ),
    )
    .limit(20);
  const candidates = rows.map(enginePass);
  const resolved = resolvePedestrian({ nameQuery, candidates }, now);
  if (resolved.kind === 'one') {
    const row = rows.find((p) => p.id === resolved.pass.id);
    if (row) return passSubject(s, row);
  }
  return {
    subject: { kind: 'pedestrian_lookup', nameQuery, candidates },
    pass: null,
    openVisit: null,
  };
}

export function runEngine(
  g: GateCtx,
  subject: Subject,
  direction: PassageDirection,
  now: number,
  state: LiveState,
  overrides: readonly ApprovedOverride[],
): Verdict {
  const input: EvaluationInput = {
    now,
    site: g.siteView,
    gate: g.gateView,
    direction,
    subject,
    rules: g.rules,
    state,
    overrides,
  };
  return evaluate(input);
}

/** Названия на момент события (CLAUDE.md п. 6): арендатор, тип, КПП, док. */
export function snapshotOf(g: GateCtx, pass: PassRow | null): Record<string, unknown> {
  const rules = g.rules;
  return {
    gate: g.gate.name,
    tenant: pass ? (rules.tenants.find((t) => t.id === pass.tenantId)?.name ?? null) : null,
    category: pass?.categoryId
      ? (rules.categories.find((c) => c.id === pass.categoryId)?.name ?? null)
      : null,
    dock: pass?.dockId ? (rules.docks.find((d) => d.id === pass.dockId)?.number ?? null) : null,
    plate: pass?.plateNorm ?? null,
    passType: pass?.passType ?? null,
  };
}

export interface DecisionInput {
  readonly direction: PassageDirection;
  readonly verdict: Verdict;
  readonly action: (typeof schema.gateDecisions.$inferInsert)['action'];
  readonly pass: PassRow | null;
  readonly plateQuery?: string | null;
  readonly visitId?: string | null;
  readonly now: number;
  readonly clientAt?: number | null;
  readonly offline?: boolean;
}

/** Каждый вердикт — в журнал КПП с trace и версией движка (B2). */
export async function insertDecision(s: Scope, g: GateCtx, d: DecisionInput): Promise<number> {
  const { actor } = s.ctx;
  const [row] = await s.db
    .insert(schema.gateDecisions)
    .values({
      organizationId: s.organizationId,
      siteId: g.site.id,
      gateId: g.gate.id,
      at: new Date(d.now),
      clientAt: d.clientAt ? new Date(d.clientAt) : null,
      direction: d.direction,
      passId: d.pass?.id ?? d.verdict.passId,
      plateQuery: d.plateQuery ?? null,
      verdict: d.verdict.code,
      reasons: d.verdict.reasons,
      trace: d.verdict.trace,
      engineVersion: d.verdict.engineVersion || ENGINE_VERSION,
      action: d.action,
      visitId: d.visitId ?? null,
      overrideId: d.verdict.appliedOverrideId ?? null,
      gateAccountId: actor.kind === 'gate_account' ? actor.id : null,
      deviceId: actor.deviceId,
      userId: actor.kind === 'user' ? actor.id : null,
      offline: d.offline ?? false,
      snapshot: { ...snapshotOf(g, d.pass), headline: d.verdict.headline },
    })
    .returning({ id: schema.gateDecisions.id });
  if (!row) throw new Error('gate decision insert');
  return row.id;
}

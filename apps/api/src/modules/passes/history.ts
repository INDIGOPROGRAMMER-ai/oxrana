import {
  PASS_STATUS_LABELS,
  type PassHistoryEntry,
  type PassHistoryGroup,
  type PassHistoryKind,
  type PassStatus,
  type PassType,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { isTenantUser } from '../../actor';
import type { Scope } from '../../core/context';
import { PASS_TYPE_LABEL } from './validate';
import type { PassRow } from './views';

/**
 * Единая лента пропуска (7b.3, ADR-023): собирается на сервере из журнала аудита и журналов КПП
 * (визиты, решения, действия поста, очередь, исключения). Лента одного пропуска — сотни строк у
 * постоянного, поэтому читается целиком по индексам `pass_id` и режется порциями в памяти.
 *
 * Что видит арендатор: изменения и согласование, въезд и выезд с КПП и временем, отказ с причиной,
 * очередь. Только сотрудник оператора: учётка КПП и устройство, исключения, причины вердикта.
 */

/** Названия полей пропуска в ленте; поля вне списка (технические) не показываются. */
const FIELD_LABEL: Record<string, { label: string; type?: 'time' }> = {
  passType: { label: 'Вид пропуска' },
  plateRaw: { label: 'Номер' },
  plateCountry: { label: 'Страна номера' },
  categoryId: { label: 'Тип транспорта' },
  brand: { label: 'Марка' },
  personName: { label: 'ФИО' },
  personDocument: { label: 'Документ' },
  driverName: { label: 'Водитель' },
  driverPhone: { label: 'Телефон водителя' },
  purposeId: { label: 'Цель визита' },
  destinationZoneId: { label: 'Место назначения' },
  dockId: { label: 'Док' },
  validFrom: { label: 'Действует с', type: 'time' },
  validTo: { label: 'Действует до', type: 'time' },
  windowFrom: { label: 'Окно прибытия, с', type: 'time' },
  windowTo: { label: 'Окно прибытия, по', type: 'time' },
  comment: { label: 'Комментарий' },
};

const SOURCE_NOTE: Record<string, string> = {
  web: 'через кабинет',
  pwa: 'через приложение',
  bot: 'через бота',
  api: 'через API',
  gate: 'с поста охраны',
  import: 'импортом',
};

const METHOD_NOTE: Record<string, string> = {
  button: 'отмечено кнопкой',
  qr: 'по QR-коду',
  lpr: 'по камере номеров',
  auto: 'автоматически',
  sync: 'из офлайн-очереди поста',
};

const FLAG_NOTE: Record<string, string> = {
  no_checkin: 'выезд без отметки о въезде',
  after_expiry: 'после окончания срока пропуска',
  over_stay: 'дольше норматива',
  offline_over_quota: 'офлайн-въезд сверх лимита',
  undone: 'отметка отменялась',
  pass_cancelled_meanwhile: 'пропуск отменён, пока машина была на территории',
};

const QUEUE_LEFT_NOTE: Record<string, string> = {
  entered: 'въехал',
  cancelled: 'пропуск отменён или охрана отказала',
  timeout: 'время ожидания истекло',
  redirected: 'направлен на другой КПП',
};

const camel = (key: string) => key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

interface RawChange {
  from?: unknown;
  to?: unknown;
  fromLabel?: string | null;
  toLabel?: string | null;
}

interface Directory {
  readonly users: Map<string, { name: string; role: string | null }>;
  /** id учётки КПП → название КПП. */
  readonly accounts: Map<string, string>;
  readonly gates: Map<string, string>;
  readonly devices: Map<string, string>;
  /** Названия значений-ссылок из старых записей без снимка: тип, док, зона, цель. */
  readonly refs: Map<string, string>;
}

function ids(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string'))];
}

async function loadDirectory(
  s: Scope,
  want: {
    users: string[];
    accounts: string[];
    gates: string[];
    devices: string[];
    refs: string[];
  },
): Promise<Directory> {
  const org = s.organizationId;
  const dir: Directory = {
    users: new Map(),
    accounts: new Map(),
    gates: new Map(),
    devices: new Map(),
    refs: new Map(),
  };
  if (want.users.length > 0) {
    for (const u of await s.db
      .select({ id: schema.users.id, name: schema.users.fullName })
      .from(schema.users)
      .where(inArray(schema.users.id, want.users))) {
      dir.users.set(u.id, { name: u.name, role: null });
    }
    const roles = await s.db
      .select({ userId: schema.roleAssignments.userId, name: schema.roles.name })
      .from(schema.roleAssignments)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
      .where(
        and(
          eq(schema.roleAssignments.organizationId, org),
          inArray(schema.roleAssignments.userId, want.users),
          isNull(schema.roles.deletedAt),
        ),
      );
    const byUser = new Map<string, Set<string>>();
    for (const r of roles) byUser.set(r.userId, (byUser.get(r.userId) ?? new Set()).add(r.name));
    for (const [userId, names] of byUser) {
      const user = dir.users.get(userId);
      if (user) user.role = [...names].join(', ');
    }
  }
  if (want.accounts.length > 0) {
    for (const a of await s.db
      .select({ id: schema.gateAccounts.id, name: schema.gates.name })
      .from(schema.gateAccounts)
      .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
      .where(
        and(
          eq(schema.gateAccounts.organizationId, org),
          inArray(schema.gateAccounts.id, want.accounts),
        ),
      )) {
      dir.accounts.set(a.id, a.name);
    }
  }
  if (want.gates.length > 0) {
    for (const g of await s.db
      .select({ id: schema.gates.id, name: schema.gates.name })
      .from(schema.gates)
      .where(and(eq(schema.gates.organizationId, org), inArray(schema.gates.id, want.gates)))) {
      dir.gates.set(g.id, g.name);
    }
  }
  if (want.devices.length > 0) {
    for (const d of await s.db
      .select({ id: schema.gateDevices.id, name: schema.gateDevices.name })
      .from(schema.gateDevices)
      .where(
        and(
          eq(schema.gateDevices.organizationId, org),
          inArray(schema.gateDevices.id, want.devices),
        ),
      )) {
      dir.devices.set(d.id, d.name);
    }
  }
  if (want.refs.length > 0) {
    const r = want.refs;
    const lookups = await Promise.all([
      s.db
        .select({ id: schema.vehicleCategories.id, label: schema.vehicleCategories.name })
        .from(schema.vehicleCategories)
        .where(
          and(
            eq(schema.vehicleCategories.organizationId, org),
            inArray(schema.vehicleCategories.id, r),
          ),
        ),
      s.db
        .select({ id: schema.zones.id, label: schema.zones.name })
        .from(schema.zones)
        .where(and(eq(schema.zones.organizationId, org), inArray(schema.zones.id, r))),
      s.db
        .select({ id: schema.visitPurposes.id, label: schema.visitPurposes.name })
        .from(schema.visitPurposes)
        .where(
          and(eq(schema.visitPurposes.organizationId, org), inArray(schema.visitPurposes.id, r)),
        ),
      s.db
        .select({ id: schema.docks.id, number: schema.docks.number })
        .from(schema.docks)
        .where(and(eq(schema.docks.organizationId, org), inArray(schema.docks.id, r))),
    ]);
    for (const list of lookups.slice(0, 3)) {
      for (const row of list as { id: string; label: string }[]) dir.refs.set(row.id, row.label);
    }
    for (const d of lookups[3] as { id: string; number: string }[]) {
      dir.refs.set(d.id, `Док ${d.number}`);
    }
  }
  return dir;
}

function valueText(
  field: string,
  value: unknown,
  label: string | null | undefined,
  dir: Directory,
) {
  if (value === null || value === undefined || value === '') return null;
  if (label) return label;
  if (typeof value === 'string' && dir.refs.has(value)) return dir.refs.get(value) ?? null;
  if (field === 'passType') return PASS_TYPE_LABEL[value as PassType] ?? String(value);
  if (field === 'status') return PASS_STATUS_LABELS[value as PassStatus] ?? String(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** «Было → стало» человеческими названиями; технические поля отбрасываются. */
function changesOf(diff: unknown, dir: Directory): PassHistoryEntry['changes'] {
  if (diff === null || typeof diff !== 'object') return [];
  const out: PassHistoryEntry['changes'] = [];
  for (const [rawKey, raw] of Object.entries(diff as Record<string, RawChange>)) {
    const field = camel(rawKey);
    const meta = FIELD_LABEL[field];
    if (!meta || raw === null || typeof raw !== 'object') continue;
    const time = meta.type === 'time';
    out.push({
      field,
      label: meta.label,
      type: time ? 'time' : 'text',
      from: time
        ? raw.from
          ? String(raw.from)
          : null
        : valueText(field, raw.from, raw.fromLabel, dir),
      to: time ? (raw.to ? String(raw.to) : null) : valueText(field, raw.to, raw.toLabel, dir),
    });
  }
  return out;
}

function refIds(diff: unknown): string[] {
  if (diff === null || typeof diff !== 'object') return [];
  const found: string[] = [];
  for (const [key, raw] of Object.entries(diff as Record<string, RawChange>)) {
    if (!FIELD_LABEL[camel(key)] || FIELD_LABEL[camel(key)]?.type === 'time') continue;
    if (raw && typeof raw === 'object') {
      for (const v of [raw.from, raw.to]) if (typeof v === 'string') found.push(v);
    }
  }
  return found;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Draft extends Omit<PassHistoryEntry, 'at'> {
  at: Date;
}

const blank = (): Omit<Draft, 'id' | 'at' | 'group' | 'kind' | 'title'> => ({
  place: null,
  actor: null,
  reason: null,
  changes: [],
  notes: [],
  offline: false,
  deviceAt: null,
  staff: null,
});

export interface HistoryPage {
  readonly items: PassHistoryEntry[];
  readonly total: number;
}

/** Лента пропуска по группе, новые сверху; `staff` — сотрудник оператора (видит служебное). */
export async function passHistory(
  s: Scope,
  pass: PassRow,
  query: { group: PassHistoryGroup | 'all'; limit: number; offset: number },
): Promise<HistoryPage> {
  const org = s.organizationId;
  const staff = !isTenantUser(s.ctx.actor);
  const wantChanges = query.group !== 'gate';
  const wantGate = query.group !== 'changes';

  /** `order` разводит записи одного мгновения: номер строки журнала (новее — больше). */
  const drafts: (Draft & { order: number })[] = [];
  let order = 0;
  const push = (d: Draft) => drafts.push({ ...d, order });

  // --- сырьё -------------------------------------------------------------------------------
  const audit = wantChanges ? await auditRows(s, pass) : [];
  const visits = wantGate
    ? await s.db
        .select()
        .from(schema.visits)
        .where(and(eq(schema.visits.organizationId, org), eq(schema.visits.passId, pass.id)))
        .orderBy(asc(schema.visits.timeIn))
    : [];
  const undos = wantGate
    ? await undoRows(
        s,
        visits.map((v) => v.id),
      )
    : [];
  const decisions = wantGate
    ? await s.db
        .select()
        .from(schema.gateDecisions)
        .where(
          and(
            eq(schema.gateDecisions.organizationId, org),
            eq(schema.gateDecisions.passId, pass.id),
            inArray(schema.gateDecisions.action, ['refuse', 'redirect']),
          ),
        )
    : [];
  const decisionIds = decisions.map((d) => d.id);
  const rejected = wantGate ? await rejectedAttempts(s, pass.id) : [];
  const refuseAudit = wantGate ? await refuseReasons(s, pass.id) : [];
  const queue = wantGate
    ? await s.db
        .select()
        .from(schema.gateQueue)
        .where(and(eq(schema.gateQueue.organizationId, org), eq(schema.gateQueue.passId, pass.id)))
    : [];
  const passages = wantGate
    ? await s.db
        .select()
        .from(schema.gatePassages)
        .where(
          and(eq(schema.gatePassages.organizationId, org), eq(schema.gatePassages.passId, pass.id)),
        )
    : [];
  const overrides =
    wantGate && staff
      ? await s.db
          .select()
          .from(schema.overrideRequests)
          .where(
            and(
              eq(schema.overrideRequests.organizationId, org),
              eq(schema.overrideRequests.passId, pass.id),
            ),
          )
      : [];
  const redirectMessages = new Map<number, string>();
  for (const a of await redirectActions(s, decisionIds)) {
    const message = (a.response as { message?: unknown } | null)?.message;
    if (a.decisionId !== null && typeof message === 'string')
      redirectMessages.set(a.decisionId, message);
  }

  const dir = await loadDirectory(s, {
    users: ids([
      ...audit.map((r) => r.actorUserId),
      ...undos.map((r) => r.actorUserId),
      ...decisions.map((d) => d.userId),
      ...overrides.map((o) => o.decidedBy),
    ]),
    accounts: ids([
      ...audit.map((r) => r.actorGateAccountId),
      ...undos.map((r) => r.actorGateAccountId),
      ...visits.flatMap((v) => [v.gateAccountInId, v.gateAccountOutId]),
      ...decisions.map((d) => d.gateAccountId),
      ...rejected.map((r) => r.decision.gateAccountId),
      ...passages.map((p) => p.gateAccountId),
      ...overrides.map((o) => o.requestedByGateAccountId),
    ]),
    gates: ids([
      ...visits.flatMap((v) => [v.gateInId, v.gateOutId]),
      ...decisions.map((d) => d.gateId),
      ...rejected.map((r) => r.decision.gateId),
      ...queue.map((q) => q.gateId),
      ...passages.map((p) => p.gateId),
      ...overrides.map((o) => o.gateId),
    ]),
    devices: ids([
      ...visits.flatMap((v) => [v.deviceInId, v.deviceOutId]),
      ...decisions.map((d) => d.deviceId),
      ...rejected.map((r) => r.decision.deviceId),
      ...overrides.map((o) => o.deviceId),
      ...audit.map((r) => r.deviceId),
    ]),
    refs: ids(audit.flatMap((r) => refIds(r.diff)).filter((v) => UUID.test(v))),
  });

  // --- кто ---------------------------------------------------------------------------------
  const userActor = (userId: string | null): Draft['actor'] => {
    const u = userId ? dir.users.get(userId) : undefined;
    return u ? { kind: 'user', name: u.name, role: u.role } : null;
  };
  /** Учётка поста: название КПП и устройство — только сотруднику оператора. */
  const gateActor = (accountId: string | null): Draft['actor'] => {
    if (!staff) return null;
    const name = accountId ? dir.accounts.get(accountId) : undefined;
    return name ? { kind: 'gate', name, role: null } : null;
  };
  const staffInfo = (deviceId: string | null, details: string[] = []): Draft['staff'] =>
    staff ? { device: deviceId ? (dir.devices.get(deviceId) ?? null) : null, details } : null;

  // --- изменения ---------------------------------------------------------------------------
  for (const r of audit) {
    order = Number(r.id);
    const when = r.at;
    const changes = changesOf(r.diff, dir);
    const actor =
      r.actorType === 'user'
        ? userActor(r.actorUserId)
        : r.actorType === 'gate_account'
          ? (gateActor(r.actorGateAccountId) ??
            (staff ? null : { kind: 'gate' as const, name: 'Охрана', role: null }))
          : { kind: 'system' as const, name: 'Система', role: null };
    const base = { ...blank(), actor, reason: r.reason, staff: staffInfo(r.deviceId) };
    const id = `a:${r.id}`;
    const snap = (r.snapshot ?? {}) as Record<string, unknown>;
    const diff = (r.diff ?? {}) as Record<string, RawChange>;
    const kinds: Record<string, [PassHistoryKind, string]> = {
      update: ['updated', 'Изменён'],
      approve: ['approved', 'Согласован'],
      approve_with_changes: ['approved', 'Согласован с изменениями'],
      reject: ['rejected', 'Отклонён'],
      cancel: ['cancelled', 'Отменён'],
      approval_escalated: ['escalated', 'Передан дальше: не рассмотрен вовремя'],
      change_request: ['change_requested', 'Заявка на изменение'],
    };
    if (r.entity === 'pass_change_request') {
      const approved = r.action === 'approve';
      push({
        ...base,
        id,
        at: when,
        group: 'changes',
        kind: approved ? 'change_approved' : r.action === 'reject' ? 'change_rejected' : 'other',
        title: approved
          ? 'Заявка на изменение одобрена'
          : r.action === 'reject'
            ? 'Заявка на изменение отклонена'
            : 'Заявка на изменение',
      });
      continue;
    }
    if (r.action === 'create') {
      const notes = [] as string[];
      const via = typeof snap.via === 'string' ? SOURCE_NOTE[snap.via] : undefined;
      if (via) notes.push(`Оформлен ${via}`);
      if (pass.batchId) notes.push('Оформлен в пакете');
      const status = diff.status?.to;
      if (status === 'pending_approval') notes.push('Отправлен на согласование');
      else if (status === 'approved') notes.push('Согласование не требовалось');
      push({ ...base, id, at: when, group: 'changes', kind: 'created', title: 'Оформлен', notes });
      continue;
    }
    const known = kinds[r.action];
    push({
      ...base,
      id,
      at: when,
      group: 'changes',
      kind: known?.[0] ?? 'other',
      title: known?.[1] ?? `Событие: ${r.action}`,
      changes,
    });
  }

  order = 0;
  // --- КПП: въезды и выезды -----------------------------------------------------------------
  if (wantGate) {
    for (const v of visits) {
      const flags = (v.flags ?? []).map((f) => FLAG_NOTE[f]).filter((n): n is string => Boolean(n));
      const snapGate =
        typeof (v.snapshot as Record<string, unknown> | null)?.gate === 'string'
          ? ((v.snapshot as Record<string, unknown>).gate as string)
          : null;
      if (v.timeIn) {
        const offline = v.clientTimeIn !== null;
        const notes = [v.methodIn ? METHOD_NOTE[v.methodIn] : undefined].filter((n): n is string =>
          Boolean(n),
        );
        push({
          ...blank(),
          id: `v:${v.id}:in`,
          at: v.timeIn,
          group: 'gate',
          kind: 'check_in',
          title: 'Въезд',
          place: snapGate ?? (v.gateInId ? (dir.gates.get(v.gateInId) ?? null) : null),
          actor: gateActor(v.gateAccountInId),
          notes: staff
            ? [...notes, ...flags.filter((f) => f !== FLAG_NOTE.undone)]
            : notes.slice(0, 1),
          offline,
          deviceAt: iso(v.clientTimeIn),
          staff: staffInfo(
            v.deviceInId,
            v.overrideId
              ? ['Впуск по исключению']
              : v.overage
                ? ['Сверх лимита (платный въезд)']
                : [],
          ),
        });
      }
      if (v.timeOut && v.gateOutId) {
        push({
          ...blank(),
          id: `v:${v.id}:out`,
          at: v.timeOut,
          group: 'gate',
          kind: 'check_out',
          title: 'Выезд',
          place: dir.gates.get(v.gateOutId) ?? null,
          actor: gateActor(v.gateAccountOutId),
          notes: [v.methodOut ? METHOD_NOTE[v.methodOut] : undefined].filter((n): n is string =>
            Boolean(n),
          ),
          offline: v.clientTimeOut !== null,
          deviceAt: iso(v.clientTimeOut),
          staff: staffInfo(v.deviceOutId),
        });
      }
    }
    for (const u of undos) {
      const snap = (u.snapshot ?? {}) as Record<string, unknown>;
      push({
        ...blank(),
        id: `a:${u.id}`,
        at: u.at,
        group: 'gate',
        kind: 'undo',
        title: 'Отметка отменена',
        notes: [snap.undoneType === 'check_out' ? 'Отменён выезд' : 'Отменён въезд'],
        reason: u.reason,
        actor:
          u.actorType === 'gate_account'
            ? gateActor(u.actorGateAccountId)
            : userActor(u.actorUserId),
        staff: staffInfo(u.deviceId),
      });
    }
    // отказ по вердикту: попытка въезда или выезда, которую система не пропустила
    for (const { action: a, decision: d } of rejected) {
      if (!['deny', 'wrong_gate', 'wait'].includes(d.verdict)) continue;
      if (
        d.verdict === 'wait' &&
        queue.some((q) => Math.abs(q.queuedAt.getTime() - a.receivedAt.getTime()) < 5000)
      ) {
        continue; // ожидание в очереди показывает строка очереди
      }
      const headline = (d.snapshot as { headline?: unknown } | null)?.headline;
      const out = d.direction === 'out';
      const kind =
        d.verdict === 'wrong_gate' ? 'wrong_gate' : d.verdict === 'wait' ? 'wait' : 'denied';
      push({
        ...blank(),
        id: `x:${a.id}`,
        at: d.at,
        group: 'gate',
        kind,
        title:
          kind === 'wrong_gate'
            ? 'Не тот КПП'
            : kind === 'wait'
              ? 'Ожидание'
              : out
                ? 'Отказ в выезде'
                : 'Отказ во въезде',
        place: dir.gates.get(d.gateId) ?? null,
        actor: gateActor(d.gateAccountId),
        notes: typeof headline === 'string' ? [headline] : [],
        offline: d.offline,
        deviceAt: iso(d.clientAt),
        staff: staffInfo(d.deviceId, verdictDetails(d)),
      });
    }
    // решения охраны: отказ и «направить на другой КПП»
    for (const d of decisions) {
      const headline = (d.snapshot as { headline?: unknown } | null)?.headline;
      const refused = d.action === 'refuse';
      const reason = refused
        ? (refuseAudit.find(
            (r) => (r.snapshot as { decisionId?: unknown } | null)?.decisionId === d.id,
          )?.reason ?? null)
        : null;
      const target = redirectMessages.get(d.id);
      push({
        ...blank(),
        id: `d:${d.id}`,
        at: d.at,
        group: 'gate',
        kind: refused ? 'refused' : 'redirected',
        title: refused ? 'Охрана отказала' : 'Направлен на другой КПП',
        place: dir.gates.get(d.gateId) ?? null,
        reason,
        actor: gateActor(d.gateAccountId),
        notes: [
          ...(!refused && target ? [target] : []),
          ...(typeof headline === 'string' ? [`Вердикт системы: ${headline}`] : []),
        ],
        offline: d.offline,
        deviceAt: iso(d.clientAt),
        staff: staffInfo(d.deviceId, verdictDetails(d)),
      });
    }
    for (const q of queue) {
      const gate = dir.gates.get(q.gateId) ?? null;
      push({
        ...blank(),
        id: `q:${q.id}:in`,
        at: q.queuedAt,
        group: 'gate',
        kind: 'queued',
        title: 'Ожидание в очереди',
        place: gate,
        notes: ['Ждёт освобождения места в лимите'],
      });
      if (q.leftAt) {
        push({
          ...blank(),
          id: `q:${q.id}:out`,
          at: q.leftAt,
          group: 'gate',
          kind: 'left_queue',
          title: 'Вышел из очереди',
          place: gate,
          notes: q.leftReason ? [QUEUE_LEFT_NOTE[q.leftReason] ?? q.leftReason] : [],
        });
      }
    }
    for (const p of passages) {
      push({
        ...blank(),
        id: `p:${p.id}`,
        at: p.at,
        group: 'gate',
        kind: 'passage',
        title:
          p.direction === 'out' ? 'Проход наружу · внутренний пост' : 'Проход · внутренний пост',
        place: dir.gates.get(p.gateId) ?? null,
        actor: gateActor(p.gateAccountId),
        staff: staffInfo(p.deviceId),
      });
    }
    for (const o of overrides) {
      push({
        ...blank(),
        id: `o:${o.id}:req`,
        at: o.createdAt,
        group: 'gate',
        kind: 'override_requested',
        title: 'Запрос исключения',
        place: dir.gates.get(o.gateId) ?? null,
        reason: o.reason,
        actor: gateActor(o.requestedByGateAccountId),
        staff: staffInfo(o.deviceId, [`Вердикт на момент запроса: ${o.verdictCode}`]),
      });
      if (o.decidedAt) {
        const status =
          o.status === 'rejected'
            ? 'Исключение отклонено'
            : o.status === 'expired'
              ? 'Исключение истекло'
              : 'Исключение разрешено';
        push({
          ...blank(),
          id: `o:${o.id}:dec`,
          at: o.decidedAt,
          group: 'gate',
          kind: 'override_decided',
          title: status,
          place: dir.gates.get(o.gateId) ?? null,
          reason: o.decisionNote,
          actor: userActor(o.decidedBy),
          staff: {
            device: null,
            details: o.via === 'senior_pin' ? ['Разрешил старший смены'] : [],
          },
        });
      }
    }
  }

  const filtered = drafts.filter((d) => (query.group === 'all' ? true : d.group === query.group));
  filtered.sort(
    (a, b) =>
      b.at.getTime() - a.at.getTime() ||
      b.order - a.order ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const page = filtered
    .slice(query.offset, query.offset + query.limit)
    .map(({ order: _order, at, ...rest }) => ({
      ...rest,
      at: at.toISOString(),
    }));
  return { items: page, total: filtered.length };
}

function verdictDetails(d: typeof schema.gateDecisions.$inferSelect): string[] {
  const reasons = Array.isArray(d.reasons)
    ? (d.reasons as { message?: unknown }[])
        .map((r) => (typeof r.message === 'string' ? r.message : null))
        .filter((m): m is string => m !== null)
    : [];
  const trace = Array.isArray(d.trace)
    ? (d.trace as { check?: unknown; result?: unknown }[])
        .map((t) => (typeof t.check === 'string' ? `${t.check}: ${String(t.result)}` : null))
        .filter((m): m is string => m !== null)
    : [];
  return [
    ...reasons,
    ...(trace.length > 0 ? [`Проверки: ${trace.join('; ')}`] : []),
    `Версия движка: ${d.engineVersion}`,
  ];
}

async function auditRows(s: Scope, pass: PassRow) {
  const requests = await s.db
    .select({ id: schema.passChangeRequests.id })
    .from(schema.passChangeRequests)
    .where(
      and(
        eq(schema.passChangeRequests.organizationId, s.organizationId),
        eq(schema.passChangeRequests.passId, pass.id),
      ),
    );
  const entityOf = or(
    and(eq(schema.auditLog.entity, 'pass'), eq(schema.auditLog.entityId, pass.id)),
    requests.length > 0
      ? and(
          eq(schema.auditLog.entity, 'pass_change_request'),
          inArray(
            schema.auditLog.entityId,
            requests.map((r) => r.id),
          ),
        )
      : undefined,
  );
  return s.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.organizationId, s.organizationId), entityOf))
    .orderBy(asc(schema.auditLog.id));
}

async function undoRows(s: Scope, visitIds: readonly string[]) {
  if (visitIds.length === 0) return [];
  return s.db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organizationId, s.organizationId),
        eq(schema.auditLog.entity, 'visit'),
        eq(schema.auditLog.action, 'undo'),
        inArray(schema.auditLog.entityId, [...visitIds]),
      ),
    );
}

async function refuseReasons(s: Scope, passId: string) {
  return s.db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organizationId, s.organizationId),
        eq(schema.auditLog.entity, 'gate_decision'),
        eq(schema.auditLog.entityId, passId),
        eq(schema.auditLog.action, 'refuse'),
      ),
    )
    .orderBy(desc(schema.auditLog.id));
}

/** Отклонённые системой попытки въезда и выезда по пропуску вместе с их вердиктом. */
async function rejectedAttempts(s: Scope, passId: string) {
  return s.db
    .select({ action: schema.gateActions, decision: schema.gateDecisions })
    .from(schema.gateActions)
    .innerJoin(schema.gateDecisions, eq(schema.gateDecisions.id, schema.gateActions.decisionId))
    .where(
      and(
        eq(schema.gateActions.organizationId, s.organizationId),
        eq(schema.gateActions.outcome, 'rejected'),
        inArray(schema.gateActions.type, ['check_in', 'check_out']),
        eq(schema.gateDecisions.passId, passId),
      ),
    );
}

async function redirectActions(s: Scope, decisionIds: readonly number[]) {
  if (decisionIds.length === 0) return [];
  return s.db
    .select({ decisionId: schema.gateActions.decisionId, response: schema.gateActions.response })
    .from(schema.gateActions)
    .where(
      and(
        eq(schema.gateActions.organizationId, s.organizationId),
        eq(schema.gateActions.type, 'redirect'),
        inArray(schema.gateActions.decisionId, [...decisionIds]),
      ),
    );
}

import type { PassView as PassApiView } from '@oxrana/contracts';
import type { schema } from '@oxrana/db';
import type { PassView as EnginePass, VisitView as EngineVisit } from '@oxrana/engine';

export type PassRow = typeof schema.passes.$inferSelect;
export type VisitRow = typeof schema.visits.$inferSelect;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

export function passView(row: PassRow, now: number): PassApiView {
  return {
    id: row.id,
    siteId: row.siteId,
    tenantId: row.tenantId,
    passType: row.passType,
    participant: row.participant,
    status: row.status,
    plateRaw: row.plateRaw,
    plateNorm: row.plateNorm,
    plateCountry: row.plateCountry,
    categoryId: row.categoryId,
    brand: row.brand,
    personName: row.personName,
    personDocument: row.personDocument,
    driverName: row.driverName,
    driverPhone: row.driverPhone,
    purposeId: row.purposeId,
    destinationZoneId: row.destinationZoneId,
    dockId: row.dockId,
    validFrom: iso(row.validFrom),
    validTo: iso(row.validTo),
    windowFrom: iso(row.windowFrom),
    windowTo: iso(row.windowTo),
    comment: row.comment,
    createdBy: row.createdBy,
    createdVia: row.createdVia,
    batchId: row.batchId,
    approvedAt: iso(row.approvedAt),
    approvedBy: row.approvedBy,
    approvalNote: row.approvalNote,
    approvalChanges:
      (row.approvalChanges as Record<string, { from: unknown; to: unknown }> | null) ?? null,
    approvalEscalatedAt: iso(row.approvalEscalatedAt),
    cancelledReason: row.cancelledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    started: row.validFrom !== null && row.validFrom.getTime() <= now,
  };
}

/** Пропуск для движка (RULES_ENGINE §1). */
export function enginePass(row: PassRow): EnginePass {
  return {
    id: row.id,
    tenantId: row.tenantId,
    passType: row.passType,
    participant: row.participant,
    status: row.status,
    plateNorm: row.plateNorm,
    categoryId: row.categoryId,
    personName: row.personName,
    destinationZoneId: row.destinationZoneId,
    dockId: row.dockId,
    validFrom: ms(row.validFrom),
    validTo: ms(row.validTo),
    windowFrom: ms(row.windowFrom),
    windowTo: ms(row.windowTo),
  };
}

/** Визит для движка: место в лимите не занимает только визит по исключению, снявшему лимит. */
export function engineVisit(row: VisitRow): EngineVisit {
  return {
    id: row.id,
    passId: row.passId,
    tenantId: row.tenantId,
    participant: row.participant,
    categoryId: row.categoryId,
    plateNorm: row.plateNorm,
    gateInId: row.gateInId,
    timeIn: ms(row.timeIn),
    timeOut: ms(row.timeOut),
    exceptionWaivesQuota: row.exceptionId !== null,
  };
}

export function visitView(row: VisitRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    tenantId: row.tenantId,
    passId: row.passId,
    participant: row.participant,
    categoryId: row.categoryId,
    plateNorm: row.plateNorm,
    snapshot: row.snapshot as Record<string, unknown>,
    gateInId: row.gateInId,
    timeIn: iso(row.timeIn),
    gateOutId: row.gateOutId,
    timeOut: iso(row.timeOut),
    overage: row.overage,
    flags: row.flags,
  };
}

/** Номера доков как диапазоны: «1–18, 66–72, З1–З7» (сценарий 38). */
export function dockRanges(numbers: readonly string[]): string {
  const numeric = numbers
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
  const other = numbers.filter((n) => !/^\d+$/.test(n)).sort((a, b) => a.localeCompare(b, 'ru'));
  const parts: string[] = [];
  for (let i = 0; i < numeric.length; ) {
    let j = i;
    while (j + 1 < numeric.length && numeric[j + 1] === (numeric[j] ?? 0) + 1) j++;
    parts.push(i === j ? String(numeric[i]) : `${numeric[i]}–${numeric[j]}`);
    i = j + 1;
  }
  return [...parts, ...other].join(', ');
}

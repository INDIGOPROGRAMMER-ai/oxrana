import type { CabinetContext, PassStatus, PassType, PassView } from '@oxrana/contracts';
import { formatInZone } from '@oxrana/ui';

/** Подписи кабинета (термины — `docs/GLOSSARY.md`: «многоразовый», а не «временный»). */
export const PASS_TYPE_LABEL: Record<PassType, string> = {
  single: 'Разовый',
  multi: 'Многоразовый',
  permanent: 'Постоянный',
};

export const PASS_STATUS_LABEL: Record<PassStatus, string> = {
  draft: 'Черновик',
  pending_approval: 'На согласовании',
  approved: 'Действует',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
  expired: 'Закончился',
  used: 'Использован',
};

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/** Названия полей, которые меняет согласующий (`approvalChanges`), — по-русски. */
const CHANGE_FIELD: Record<string, string> = {
  categoryId: 'тип транспорта',
  dockId: 'док',
  destinationZoneId: 'место назначения',
  validFrom: 'начало',
  validTo: 'окончание',
  windowFrom: 'окно с',
  windowTo: 'окно по',
  comment: 'комментарий',
};

const INSTANT_FIELDS = new Set(['validFrom', 'validTo', 'windowFrom', 'windowTo']);

/** Значение изменённого поля — как человек его читает: название типа, номер дока, время объекта. */
function changeValue(field: string, value: unknown, ctx: CabinetContext): string {
  if (value === null || value === undefined || value === '') return 'не задано';
  if (field === 'categoryId') return ctx.categories.find((c) => c.id === value)?.name ?? '—';
  if (field === 'dockId') {
    const dock = ctx.docks.find((d) => d.id === value);
    return dock ? `№ ${dock.number}` : '—';
  }
  if (field === 'destinationZoneId') return ctx.zones.find((z) => z.id === value)?.name ?? '—';
  if (INSTANT_FIELDS.has(field)) return formatInZone(String(value), ctx.site.timezone);
  return String(value);
}

/** «окончание: 10.03.2026 20:00 → 10.03.2026 18:00; док: № 12 → № 14». */
export function describeChanges(
  changes: PassView['approvalChanges'],
  ctx: CabinetContext,
): string[] {
  return Object.entries(changes ?? {}).map(
    ([field, change]) =>
      `${CHANGE_FIELD[field] ?? field}: ${changeValue(field, change.from, ctx)} → ${changeValue(field, change.to, ctx)}`,
  );
}

export interface StatusView {
  readonly tone: StatusTone;
  readonly label: string;
  /** Поясняющие строки под статусом: причина отказа, что изменил согласующий. */
  readonly details: string[];
}

/** Статус пропуска для арендатора: согласование видно в статусе (08_ «Согласование»). */
export function statusView(pass: PassView, ctx: CabinetContext, nowMs: number): StatusView {
  switch (pass.status) {
    case 'pending_approval':
      return { tone: 'warning', label: 'На согласовании', details: [] };
    case 'rejected':
      return {
        tone: 'danger',
        label: 'Отклонено',
        details: pass.approvalNote ? [`Причина: ${pass.approvalNote}`] : [],
      };
    case 'cancelled':
      return {
        tone: 'neutral',
        label: 'Отменён',
        details: pass.cancelledReason ? [`Причина: ${pass.cancelledReason}`] : [],
      };
    case 'approved': {
      const changed = describeChanges(pass.approvalChanges, ctx);
      const note = pass.approvalNote ? [`Комментарий согласующего: ${pass.approvalNote}`] : [];
      const waiting = pass.validFrom !== null && Date.parse(pass.validFrom) > nowMs;
      if (changed.length > 0) {
        return {
          tone: 'info',
          label: 'Одобрено с изменениями',
          details: [...changed.map((c) => `изменено: ${c}`), ...note],
        };
      }
      return {
        tone: 'success',
        label: waiting ? 'Одобрен, ещё не начался' : 'Действует',
        details: note,
      };
    }
    case 'used':
      return { tone: 'neutral', label: 'Использован', details: [] };
    case 'expired':
      return { tone: 'neutral', label: 'Закончился', details: [] };
    case 'draft':
      return { tone: 'neutral', label: 'Черновик', details: [] };
  }
}

/** Что показать вместо номера: пешеход — имя. */
export function passTitle(pass: PassView): string {
  return pass.participant === 'pedestrian'
    ? (pass.personName ?? 'Пешеход')
    : (pass.plateNorm ?? pass.plateRaw ?? 'Без номера');
}

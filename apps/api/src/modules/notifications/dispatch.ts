import { IN_APP_CHANNEL, type NotificationKind } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import type { AuditDiff } from '../../core/diff';
import { labelDiff } from '../../core/labels';
import { type EmittedEvent, onEmit } from '../../core/event-hooks';

/**
 * Диспетчер уведомлений (ADR-023). События outbox → «намерения» уведомить пользователя (`planners`)
 * → доставка по каналам (`CHANNELS`). Сейчас канал один — колокольчик кабинета (`in_app`, строка
 * `notifications` со статусом `sent`). Этап 10 добавляет каналы (почта, Telegram, push) записью в
 * `CHANNELS`: планировщики, тексты и адресаты остаются прежними.
 */
export interface Intent {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly text: string;
  readonly passId: string | null;
  readonly tenantId: string | null;
  readonly changes: AuditDiff | null;
}

export interface NotificationChannel {
  readonly name: string;
  deliver(s: Scope, event: EmittedEvent, intent: Intent): Promise<void>;
}

const PASS_LABELS = { categoryId: 'category', dockId: 'dock', destinationZoneId: 'zone' } as const;

/** Что видит человек вместо `categoryId`: названия полей в уведомлении. */
const CHANGE_TITLE: Record<string, string> = {
  categoryId: 'Тип транспорта',
  dockId: 'Док',
  destinationZoneId: 'Место назначения',
  validFrom: 'Начало действия',
  validTo: 'Действует до',
  windowFrom: 'Окно прибытия, с',
  windowTo: 'Окно прибытия, по',
  comment: 'Комментарий',
  plateNorm: 'Номер',
  plateRaw: 'Номер',
};

const subjectOf = (pass: typeof schema.passes.$inferSelect): string =>
  pass.participant === 'vehicle' ? (pass.plateNorm ?? 'машина') : (pass.personName ?? 'человек');

async function loadPass(s: Scope, passId: string) {
  const [pass] = await s.db
    .select()
    .from(schema.passes)
    .where(and(eq(schema.passes.organizationId, s.organizationId), eq(schema.passes.id, passId)));
  return pass ?? null;
}

/** Адресат — тот, кто заказал пропуск; свои собственные действия не уведомляют. */
function recipient(s: Scope, pass: typeof schema.passes.$inferSelect): string | null {
  if (!pass.createdBy) return null;
  return pass.createdBy === s.ctx.actor.id ? null : pass.createdBy;
}

function changeLine(field: string, change: AuditDiff[string]): string {
  const show = (v: unknown, label: string | null | undefined) =>
    label ?? (v === null || v === undefined || v === '' ? 'не задано' : String(v));
  return `${CHANGE_TITLE[field] ?? field}: ${show(change.from, change.fromLabel)} → ${show(change.to, change.toLabel)}`;
}

type Planner = (s: Scope, event: EmittedEvent) => Promise<Intent[]>;

const planners: Partial<Record<string, Planner>> = {
  /** Согласование: одобрено · одобрено с изменениями · отклонено (в том числе по сроку политики). */
  'pass.status_changed': async (s, event) => {
    const { passId, from, to } = event.payload as { passId: string; from: string; to: string };
    if (from !== 'pending_approval' || (to !== 'approved' && to !== 'rejected')) return [];
    const pass = await loadPass(s, passId);
    const userId = pass ? recipient(s, pass) : null;
    if (!pass || !userId) return [];
    const subject = subjectOf(pass);
    if (to === 'rejected') {
      return [
        {
          userId,
          kind: 'pass_rejected',
          title: 'Пропуск отклонён',
          text: `Пропуск на ${subject} отклонён.${pass.approvalNote ? ` Причина: ${pass.approvalNote}` : ''}`,
          passId: pass.id,
          tenantId: pass.tenantId,
          changes: null,
        },
      ];
    }
    const raw = (pass.approvalChanges as AuditDiff | null) ?? null;
    const changes = raw && Object.keys(raw).length > 0 ? await labelDiff(s, raw, PASS_LABELS) : null;
    if (changes) {
      const lines = Object.entries(changes).map(([f, c]) => changeLine(f, c));
      return [
        {
          userId,
          kind: 'pass_approved_changed',
          title: 'Пропуск одобрен с изменениями',
          text: `Пропуск на ${subject} одобрен, но согласующий изменил: ${lines.join('; ')}.${pass.approvalNote ? ` Комментарий: ${pass.approvalNote}` : ''}`,
          passId: pass.id,
          tenantId: pass.tenantId,
          changes,
        },
      ];
    }
    return [
      {
        userId,
        kind: 'pass_approved',
        title: 'Пропуск одобрен',
        text: `Пропуск на ${subject} одобрен и действует.${pass.approvalNote ? ` Комментарий: ${pass.approvalNote}` : ''}`,
        passId: pass.id,
        tenantId: pass.tenantId,
        changes: null,
      },
    ];
  },

  /** Заявка на изменение начавшегося пропуска рассмотрена. */
  'pass.change_decided': async (s, event) => {
    const { changeRequestId, passId, status } = event.payload as {
      changeRequestId: string;
      passId: string;
      status: string;
    };
    const [request] = await s.db
      .select()
      .from(schema.passChangeRequests)
      .where(eq(schema.passChangeRequests.id, changeRequestId));
    const pass = await loadPass(s, passId);
    if (!request || !pass || request.requestedBy === s.ctx.actor.id) return [];
    const subject = subjectOf(pass);
    const approved = status === 'approved';
    return [
      {
        userId: request.requestedBy,
        kind: approved ? 'change_request_approved' : 'change_request_rejected',
        title: approved ? 'Изменение пропуска одобрено' : 'Изменение пропуска отклонено',
        text: approved
          ? `Заявка на изменение пропуска на ${subject} одобрена — изменения действуют.`
          : `Заявка на изменение пропуска на ${subject} отклонена.${request.decisionNote ? ` Причина: ${request.decisionNote}` : ''}`,
        passId: pass.id,
        tenantId: pass.tenantId,
        changes: null,
      },
    ];
  },
};

/** Колокольчик кабинета: строка уведомления со статусом «отправлено» и адресное событие для SSE. */
const inApp: NotificationChannel = {
  name: IN_APP_CHANNEL,
  async deliver(s, event, intent) {
    const [row] = await s.db
      .insert(schema.notifications)
      .values({
        organizationId: s.organizationId,
        userId: intent.userId,
        kind: intent.kind,
        channel: IN_APP_CHANNEL,
        // Снимок текста на момент события (CLAUDE.md п. 6); в `domain_events` текста нет.
        payload: {
          title: intent.title,
          text: intent.text,
          passId: intent.passId,
          tenantId: intent.tenantId,
          changes: intent.changes,
        },
        status: 'sent',
        sentAt: new Date(s.ctx.now()),
        eventId: event.id,
        createdAt: new Date(s.ctx.now()),
      })
      .onConflictDoNothing()
      .returning({ id: schema.notifications.id });
    if (!row) return;
    await s.emit('notification.created', {
      siteId: event.siteId,
      aggregate: 'notification',
      aggregateId: row.id,
      payload: { notificationId: row.id, userId: intent.userId, kind: intent.kind },
    });
  },
};

/** Каналы доставки; этап 10 добавляет сюда почту, Telegram и push. */
export const CHANNELS: NotificationChannel[] = [inApp];

export async function dispatchNotifications(s: Scope, event: EmittedEvent): Promise<void> {
  const plan = planners[event.type];
  if (!plan) return;
  for (const intent of await plan(s, event)) {
    for (const channel of CHANNELS) await channel.deliver(s, event, intent);
  }
}

export function registerNotificationDispatcher(): void {
  onEmit(dispatchNotifications);
}

import type { NotificationListSchema, NotificationView } from '@oxrana/contracts';
import { Button, cn, SiteTime } from '@oxrana/ui';
import { useNavigate } from '@tanstack/react-router';
import { Bell, CheckCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useApi, useRefresh } from '../../lib/data';

type NotificationList = z.infer<typeof NotificationListSchema>;

/** Строки «было → стало» для «одобрено с изменениями» (названия — на момент события). */
function changeLines(item: NotificationView): string[] {
  return Object.entries(item.changes ?? {}).map(([field, c]) => {
    const show = (v: unknown, label: string | null | undefined) =>
      label ?? (v === null || v === undefined || v === '' ? 'не задано' : String(v));
    return `${field}: ${show(c.from, c.fromLabel)} → ${show(c.to, c.toLabel)}`;
  });
}

const KIND_TONE: Record<string, string> = {
  pass_approved: 'bg-success',
  pass_approved_changed: 'bg-primary',
  pass_rejected: 'bg-destructive',
  change_request_approved: 'bg-success',
  change_request_rejected: 'bg-destructive',
};

/**
 * Колокольчик кабинета (ADR-023): счётчик непрочитанных и список «пропуск одобрен / одобрен с
 * изменениями (что изменено) / отклонён (причина)». Данные обновляются сами по SSE — вместе со
 * всеми данными экранов; обновлять страницу не нужно. Нажатие по уведомлению отмечает его
 * прочитанным и открывает пропуск.
 */
export function NotificationBell() {
  const list = useApi<NotificationList>('/notifications?limit=20');
  const refresh = useRefresh();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const items = list.data?.items ?? [];
  const unread = list.data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function read(body: { ids?: string[]; all?: boolean }) {
    await api('/notifications/read', { method: 'POST', body });
    await refresh();
  }

  async function openItem(item: NotificationView) {
    setOpen(false);
    if (!item.readAt) await read({ ids: [item.id] });
    if (item.passId) await navigate({ to: '/cabinet/passes', search: { pass: item.passId } });
  }

  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? `Уведомления: непрочитанных ${unread}` : 'Уведомления'}
        aria-expanded={open}
        data-testid="bell"
        onClick={() => setOpen(!open)}
        className="relative"
      >
        <Bell aria-hidden />
        {unread > 0 ? (
          <span
            data-testid="bell-count"
            className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Уведомления"
          data-testid="bell-panel"
          className="fixed inset-x-2 top-14 z-50 max-h-[70vh] overflow-y-auto rounded-md border bg-card p-2 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <h2 className="text-sm font-semibold">Уведомления</h2>
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0}
              onClick={() => void read({ all: true })}
            >
              <CheckCheck aria-hidden /> Прочитать все
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Пока ничего нет. Здесь появится решение по пропускам, которые ушли на согласование.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid="bell-item"
                    data-kind={item.kind}
                    data-unread={item.readAt ? 'false' : 'true'}
                    onClick={() => void openItem(item)}
                    className={cn(
                      'flex w-full gap-2 rounded-md p-2 text-left hover:bg-accent',
                      !item.readAt && 'bg-accent/50',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        item.readAt ? 'bg-muted' : (KIND_TONE[item.kind] ?? 'bg-primary'),
                      )}
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm font-medium">{item.title}</span>
                      <span className="block text-sm text-muted-foreground">{item.text}</span>
                      {changeLines(item).length > 0 ? (
                        <span className="sr-only">{changeLines(item).join('; ')}</span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        <SiteTime value={item.createdAt} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

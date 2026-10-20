import type { PassCardSchema, PassHistoryEntry, PassHistoryGroup } from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  formatInZone,
  SegmentedChoice,
  Skeleton,
  useSiteTime,
} from '@oxrana/ui';
import { Lock, WifiOff } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { useApi, useApiPages, useMe } from '../../lib/data';
import { usePassCardLink } from '../../lib/pass-link';
import { PASS_TYPE_LABEL, passTitle } from '../../lib/pass-text';
import { LoadError } from '../common';
import { CabinetProvider, useCabinet } from './cabinet-context';
import { PassFields } from './pass-fields';
import { PassStatus } from './status-badge';

type Card = z.infer<typeof PassCardSchema>;
type FilterValue = 'all' | PassHistoryGroup;

const NO_HISTORY = 'История недоступна: нет права «История пропуска»';

/** Время объекта «ДД.ММ.ГГГГ ЧЧ:ММ»; пояс подписан один раз над лентой. */
function useAt() {
  const { site } = useSiteTime();
  return (iso: string) => (site ? formatInZone(iso, site.timezone) : iso);
}

/**
 * Карточка пропуска (7b.3): данные, где сейчас, кто оформил и согласовал и вся история. Открытая
 * карточка — в адресе (`?pass=<id>`): ссылку можно отправить, «Назад» закрывает. На телефоне — на
 * весь экран. Ставится один раз на странице со списком пропусков; строки открывают её через
 * `usePassCardLink().open(id)`.
 */
export function PassCardHost() {
  const { passId, close } = usePassCardLink();
  return (
    <Dialog open={passId !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        data-testid="pass-card"
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl max-sm:left-0 max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0"
      >
        {passId ? <CardLoader passId={passId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CardLoader({ passId }: { passId: string }) {
  const card = useApi<Card>(`/passes/${passId}/card`);
  if (card.error) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Пропуск</DialogTitle>
          <DialogDescription>Карточка пропуска.</DialogDescription>
        </DialogHeader>
        <LoadError error={card.error} retry={() => void card.refetch()} />
      </>
    );
  }
  if (!card.data) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Пропуск</DialogTitle>
          <DialogDescription>Загрузка…</DialogDescription>
        </DialogHeader>
        <Skeleton className="h-24 w-full" />
      </>
    );
  }
  const { pass, tenantName } = card.data;
  return (
    // контекст компании-владельца пропуска: справочники и пояс объекта — её, а не «выбранной» компании
    <CabinetProvider key={pass.tenantId} forcedTenant={{ id: pass.tenantId, name: tenantName }}>
      <CardBody card={card.data} />
    </CabinetProvider>
  );
}

function presenceText(card: Card, at: (iso: string) => string): string {
  const p = card.presence;
  if (p.state === 'inside') return `На территории с ${at(p.since)}${p.gate ? ` (${p.gate})` : ''}`;
  if (p.state === 'left') return `Последний выезд ${at(p.at)}${p.gate ? ` (${p.gate})` : ''}`;
  return 'Ещё не въезжал';
}

function CardBody({ card }: { card: Card }) {
  const { ctx } = useCabinet();
  const { can } = useMe();
  const { site } = useSiteTime();
  const at = useAt();
  const { pass } = card;
  const created = [card.createdByName, at(pass.createdAt)].filter(Boolean).join(' · ');
  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">{passTitle(pass)}</DialogTitle>
        <DialogDescription>
          {PASS_TYPE_LABEL[pass.passType]} · {card.tenantName}
          {site ? ` · время объекта: ${site.label}` : ''}
        </DialogDescription>
      </DialogHeader>
      <PassStatus pass={pass} />
      <p className="text-sm font-medium" data-testid="pass-presence">
        {presenceText(card, at)}
      </p>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Арендатор</dt>
        <dd>{card.tenantName}</dd>
        <dt className="text-muted-foreground">Оформлен</dt>
        <dd data-testid="pass-created">{created}</dd>
        {pass.approvedAt ? (
          <>
            <dt className="text-muted-foreground">Согласован</dt>
            <dd>{[card.approvedByName, at(pass.approvedAt)].filter(Boolean).join(' · ')}</dd>
          </>
        ) : null}
      </dl>
      <PassFields pass={pass} ctx={ctx} names={card.names} />
      {can('pass.history.view') ? (
        <HistoryFeed passId={pass.id} />
      ) : (
        <section aria-label="История" className="space-y-1">
          <h3 className="text-sm font-medium">История</h3>
          <Button variant="outline" size="sm" disabled title={NO_HISTORY} data-testid="no-history">
            <Lock aria-hidden /> {NO_HISTORY}
          </Button>
        </section>
      )}
    </>
  );
}

function HistoryFeed({ passId }: { passId: string }) {
  const [filter, setFilter] = useState<FilterValue>('all');
  const list = useApiPages<PassHistoryEntry>(
    `/passes/${passId}/history${filter === 'all' ? '' : `?group=${filter}`}`,
    (e) => e.id,
  );
  const at = useAt();
  const { site } = useSiteTime();
  return (
    <section aria-label="История" className="space-y-2" data-testid="history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">История</h3>
        <SegmentedChoice<FilterValue>
          aria-label="Что показать в истории"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Всё' },
            { value: 'changes', label: 'Изменения' },
            { value: 'gate', label: 'КПП' },
          ]}
        />
      </div>
      {site ? <p className="text-xs text-muted-foreground">Время объекта: {site.label}.</p> : null}
      {list.error ? (
        <Alert tone="warning" title={NO_HISTORY}>
          Право «История пропуска» выдаёт администратор объекта в разделе «Роли».
        </Alert>
      ) : list.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : list.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">По этому фильтру записей нет.</p>
      ) : (
        <ol className="space-y-2" aria-label="События пропуска">
          {list.items.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} at={at} />
          ))}
        </ol>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          data-testid="history-more"
        >
          Показать ещё ({list.rest})
        </Button>
      ) : null}
    </section>
  );
}

function HistoryRow({ entry, at }: { entry: PassHistoryEntry; at: (iso: string) => string }) {
  const who = entry.actor ? [entry.actor.name, entry.actor.role].filter(Boolean).join(', ') : null;
  return (
    <li
      className="rounded-md border p-2 text-sm"
      data-testid="history-entry"
      data-kind={entry.kind}
      data-group={entry.group}
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs text-muted-foreground">{at(entry.at)}</span>
        <span className="font-medium" data-testid="history-title">
          {entry.title}
          {entry.place ? ` · ${entry.place}` : ''}
        </span>
        {entry.offline ? (
          <Badge tone="warning">
            <WifiOff aria-hidden className="mr-1 size-3" />
            офлайн{entry.deviceAt ? `, на устройстве ${at(entry.deviceAt)}` : ''}
          </Badge>
        ) : null}
      </p>
      {who ? (
        <p className="text-xs text-muted-foreground" data-testid="history-actor">
          {who}
        </p>
      ) : null}
      {entry.changes.map((c) => (
        <p key={c.field} data-testid="history-change">
          {c.label}:{' '}
          <span className="text-muted-foreground">
            {c.from ? (c.type === 'time' ? at(c.from) : c.from) : '—'}
          </span>{' '}
          → {c.to ? (c.type === 'time' ? at(c.to) : c.to) : '—'}
        </p>
      ))}
      {entry.reason ? <p>Причина: {entry.reason}</p> : null}
      {entry.notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
      {entry.staff && (entry.staff.device || entry.staff.details.length > 0) ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Служебное (только администратору)</summary>
          {entry.staff.device ? <p>Устройство: {entry.staff.device}</p> : null}
          {entry.staff.details.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </details>
      ) : null}
    </li>
  );
}

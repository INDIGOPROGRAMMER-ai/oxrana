import type { PassStatus as PassStatusCode, PassType, PassView } from '@oxrana/contracts';
import {
  Button,
  Card,
  CardContent,
  DateInput,
  EmptyState,
  Field,
  formatInZone,
  Input,
  Select,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { Ban, Inbox, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi, useMe } from '../../lib/data';
import { PASS_STATUS_LABEL, PASS_TYPE_LABEL, passTitle } from '../../lib/pass-text';
import { useDebounced } from '../../lib/use-debounced';
import { LoadError } from '../common';
import { useCabinet } from './cabinet-context';
import { CancelPassDialog } from './cancel-dialog';
import { PassDetails } from './pass-details';
import { PassEditDialog } from './pass-edit';
import { PassStatus } from './status-badge';

const STATUSES: PassStatusCode[] = [
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'used',
  'expired',
];
const CANCELLABLE = new Set<PassStatusCode>(['pending_approval', 'approved']);

/**
 * Список пропусков (08_ «История»): фильтры по статусу, дню, типу и цифрам номера; статусы
 * согласования; отмена своих. Обновляется по событиям объекта, без F5.
 */
export function PassList({
  initialStatus,
  openId,
}: {
  initialStatus?: PassStatusCode | undefined;
  /** Пропуск, карточку которого надо открыть сразу (ссылка из уведомления). */
  openId?: string | undefined;
}) {
  const { me, can } = useMe();
  const { tenant, ctx } = useCabinet();
  const [status, setStatus] = useState<PassStatusCode | ''>(initialStatus ?? '');
  const [passType, setPassType] = useState<PassType | ''>('');
  const [date, setDate] = useState('');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [opened, setOpened] = useState<PassView | null>(null);
  const linked = useApi<PassView>(openId ? `/passes/${openId}` : null);
  useEffect(() => {
    if (linked.data) setOpened(linked.data);
  }, [linked.data]);
  const [cancelling, setCancelling] = useState<PassView | null>(null);
  const [editing, setEditing] = useState<PassView | null>(null);

  const params = new URLSearchParams({ limit: '200' });
  if (tenant) params.set('tenantId', tenant.id);
  if (status) params.set('status', status);
  if (passType) params.set('passType', passType);
  if (date) {
    params.set('dateFrom', date);
    params.set('dateTo', date);
  }
  if (q) params.set('q', q);
  const list = useApi<{ items: PassView[] }>(
    ctx ? `/sites/${ctx.site.id}/passes?${params.toString()}` : null,
  );
  const items = list.data?.items ?? [];
  const filtered = Boolean(status || passType || date || q);

  const cancelReason = (pass: PassView): string | null => {
    if (can('pass.cancel')) return null;
    if (can('pass.cancel_own') && pass.createdBy === me?.id) return null;
    return can('pass.cancel_own')
      ? 'Вы можете отменять только пропуска, которые оформили сами.'
      : 'У вашей роли нет права отменять пропуска.';
  };
  /** Почему правка недоступна (кнопка неактивна с причиной) или `null`. */
  const editReason = (pass: PassView): string | null => {
    if (pass.phase === 'locked') {
      return pass.status === 'used'
        ? 'Пропуск использован — его можно только посмотреть.'
        : 'Пропуск закрыт — его можно только посмотреть.';
    }
    if (!can('pass.edit') && !can('pass.change_request.create')) {
      return 'У вашей роли нет права править пропуска.';
    }
    return null;
  };
  const tz = ctx?.site.timezone ?? 'UTC';
  const categoryName = (id: string | null) => ctx?.categories.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Статус">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as PassStatusCode | '')}
            >
              <option value="">Любой</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PASS_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Тип пропуска">
            <Select value={passType} onChange={(e) => setPassType(e.target.value as PassType | '')}>
              <option value="">Любой</option>
              {(Object.keys(PASS_TYPE_LABEL) as PassType[]).map((t) => (
                <option key={t} value={t}>
                  {PASS_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Действует в день"
            hint={ctx ? `Время объекта: ${ctx.site.timezoneLabel}` : undefined}
          >
            <div className="flex items-start gap-1">
              <DateInput value={date} todayIso={ctx?.today} onChange={setDate} />
              {date ? (
                <Button variant="ghost" size="sm" onClick={() => setDate('')}>
                  Сбросить
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Поиск" hint="Цифры номера или фамилия.">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              inputMode="search"
              autoComplete="off"
              placeholder="например, 174"
            />
          </Field>
        </CardContent>
      </Card>

      {list.error ? <LoadError error={list.error} retry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 && !list.error ? (
        <EmptyState
          icon={Inbox}
          title={filtered ? 'По этим условиям пропусков нет' : 'Пропусков пока нет'}
          hint={
            filtered
              ? 'Сбросьте фильтры или поменяйте поиск.'
              : 'Оформите первый пропуск — он появится здесь, вместе со статусом согласования.'
          }
          action={
            filtered ? (
              <Button
                variant="outline"
                onClick={() => {
                  setStatus('');
                  setPassType('');
                  setDate('');
                  setQuery('');
                }}
              >
                Сбросить фильтры
              </Button>
            ) : (
              <Button asChild>
                <Link to="/cabinet/passes/new">Оформить пропуск</Link>
              </Button>
            )
          }
        />
      ) : (
        <ul className="space-y-2" aria-label="Пропуска" data-testid="pass-list">
          {items.map((pass) => {
            const blocked = cancelReason(pass);
            return (
              <li key={pass.id}>
                <Card data-testid="pass-row" data-status={pass.status}>
                  <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr_auto] sm:items-start">
                    <div className="min-w-0 space-y-1">
                      <button
                        type="button"
                        onClick={() => setOpened(pass)}
                        className="text-left font-mono text-base font-semibold underline-offset-2 hover:underline"
                      >
                        {passTitle(pass)}
                      </button>
                      <p className="text-sm text-muted-foreground">
                        {PASS_TYPE_LABEL[pass.passType]}
                        {categoryName(pass.categoryId) ? ` · ${categoryName(pass.categoryId)}` : ''}
                        {pass.participant === 'pedestrian' ? ' · пешеход' : ''}
                        {pass.dockId
                          ? ` · док ${ctx?.docks.find((d) => d.id === pass.dockId)?.number ?? ''}`
                          : ''}
                      </p>
                      <p className="text-sm">
                        {pass.validFrom ? formatInZone(pass.validFrom, tz) : '—'}
                        {' — '}
                        {pass.validTo ? formatInZone(pass.validTo, tz) : 'без окончания'}
                        {pass.windowFrom && pass.windowTo
                          ? ` · окно ${formatInZone(pass.windowFrom, tz).slice(11)}–${formatInZone(pass.windowTo, tz).slice(11)}`
                          : ''}
                      </p>
                      {pass.driverName ? (
                        <p className="text-xs text-muted-foreground">{pass.driverName}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-start gap-2 sm:items-end">
                      <PassStatus pass={pass} />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={editReason(pass) !== null}
                        title={editReason(pass) ?? 'Изменить пропуск'}
                        aria-label={`Изменить пропуск ${passTitle(pass)}`}
                        onClick={() => setEditing(pass)}
                      >
                        <Pencil aria-hidden /> Изменить
                      </Button>
                      {CANCELLABLE.has(pass.status) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={blocked !== null}
                          title={blocked ?? 'Отменить пропуск'}
                          aria-label={`Отменить пропуск ${passTitle(pass)}`}
                          onClick={() => setCancelling(pass)}
                        >
                          <Ban aria-hidden /> Отменить
                        </Button>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <PassDetails pass={opened} onClose={() => setOpened(null)} />
      <CancelPassDialog pass={cancelling} onClose={() => setCancelling(null)} />
      <PassEditDialog pass={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

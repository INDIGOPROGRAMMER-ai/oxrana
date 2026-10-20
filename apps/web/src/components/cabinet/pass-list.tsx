import type { PassStatus as PassStatusCode, PassType, PassView } from '@oxrana/contracts';
import {
  Button,
  Card,
  CardContent,
  DateInput,
  EmptyState,
  Field,
  formatInZone,
  formatLocalDate,
  Input,
  Select,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { Ban, Inbox, Pencil, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi, useApiPages, useMe } from '../../lib/data';
import { PASS_STATUS_LABEL, PASS_TYPE_LABEL, passTitle } from '../../lib/pass-text';
import { useDebounced } from '../../lib/use-debounced';
import { useWideScreen } from '../../lib/use-media';
import { LoadError } from '../common';
import { ExportButton } from '../export-button';
import { CabinetProvider, useCabinet } from './cabinet-context';
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
  const { tenant, ctx, allTenants } = useCabinet();
  // страница «Пропуска» админки: все арендаторы объекта, фильтр и название арендатора в строке (7b.2)
  const admin = allTenants !== null;
  const [tenantFilter, setTenantFilter] = useState('');
  const tenantName = (id: string) => allTenants?.find((t) => t.id === id)?.name ?? '—';
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

  const params = new URLSearchParams();
  if (admin ? tenantFilter : tenant?.id)
    params.set('tenantId', admin ? tenantFilter : (tenant?.id ?? ''));
  if (status) params.set('status', status);
  if (passType) params.set('passType', passType);
  if (date) {
    params.set('dateFrom', date);
    params.set('dateTo', date);
  }
  if (q) params.set('q', q);
  // Фильтры и поиск — на сервере по всем пропускам; список порциями по 50 с «Показать ещё».
  const list = useApiPages<PassView>(
    ctx ? `/sites/${ctx.site.id}/passes?${params.toString()}` : null,
    (p) => p.id,
  );
  const items = list.items;
  const filtered = Boolean(status || passType || date || q || tenantFilter);

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

  const wide = useWideScreen();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const resetAll = () => {
    setTenantFilter('');
    setStatus('');
    setPassType('');
    setDate('');
    setQuery('');
  };
  const chips = [
    ...(tenantFilter
      ? [
          {
            key: 'tenant',
            label: `Арендатор: ${tenantName(tenantFilter)}`,
            clear: () => setTenantFilter(''),
          },
        ]
      : []),
    ...(status
      ? [{ key: 'status', label: PASS_STATUS_LABEL[status], clear: () => setStatus('') }]
      : []),
    ...(passType
      ? [{ key: 'type', label: PASS_TYPE_LABEL[passType], clear: () => setPassType('') }]
      : []),
    ...(date
      ? [{ key: 'date', label: `в день ${formatLocalDate(date)}`, clear: () => setDate('') }]
      : []),
  ];
  const activeCount = chips.length;

  const tenantField = admin ? (
    <Field label="Арендатор">
      <Select
        aria-label="Арендатор"
        value={tenantFilter}
        onChange={(e) => setTenantFilter(e.target.value)}
      >
        <option value="">Все арендаторы</option>
        {(allTenants ?? []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  ) : null;
  const statusField = (
    <Field label="Статус">
      <Select value={status} onChange={(e) => setStatus(e.target.value as PassStatusCode | '')}>
        <option value="">Любой</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {PASS_STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
    </Field>
  );
  const typeField = (
    <Field label="Вид пропуска">
      <Select value={passType} onChange={(e) => setPassType(e.target.value as PassType | '')}>
        <option value="">Любой</option>
        {(Object.keys(PASS_TYPE_LABEL) as PassType[]).map((t) => (
          <option key={t} value={t}>
            {PASS_TYPE_LABEL[t]}
          </option>
        ))}
      </Select>
    </Field>
  );
  const dateField = (
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
  );
  const exportButton = (variant: 'menu' | 'panel') =>
    ctx ? (
      <ExportButton
        variant={variant}
        path={`/sites/${ctx.site.id}/passes/export`}
        params={params}
        fileLabel="пропуска"
        disabledReason={
          list.total === 0 ? 'По этому фильтру пропусков нет — выгружать нечего.' : undefined
        }
      />
    ) : null;
  const searchField = (
    <Field label="Поиск" hint={wide ? 'Цифры номера или фамилия.' : undefined}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        inputMode="search"
        autoComplete="off"
        placeholder="цифры номера"
      />
    </Field>
  );

  return (
    <div className="space-y-4">
      {wide ? (
        <Card>
          <CardContent className="space-y-3 pt-5">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-60 flex-1">{searchField}</div>
              {/* «Выгрузить в Excel» — рядом с поиском: все строки по фильтру */}
              <div className="pt-[1.375rem]">{exportButton('menu')}</div>
            </div>
            <div
              className={`grid gap-3 sm:grid-cols-2 ${admin ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}
            >
              {tenantField}
              {statusField}
              {typeField}
              {dateField}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="filters-mobile">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Поиск"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                inputMode="search"
                autoComplete="off"
                placeholder="Поиск: цифры номера"
              />
            </div>
            <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
              <Button
                variant="outline"
                onClick={() => setFiltersOpen(true)}
                data-testid="filters-button"
                aria-haspopup="dialog"
              >
                <SlidersHorizontal aria-hidden /> Фильтры
                {activeCount > 0 ? ` · ${activeCount}` : ''}
              </Button>
              <SheetContent>
                <SheetTitle className="text-lg font-semibold">Фильтры</SheetTitle>
                <SheetDescription className="sr-only">
                  Статус, тип пропуска и день, в который он действует.
                </SheetDescription>
                {tenantField}
                {statusField}
                {typeField}
                {dateField}
                <div className="space-y-1 border-t pt-3">
                  <p className="text-sm font-medium">Выгрузка</p>
                  <p className="text-xs text-muted-foreground">
                    Все пропуска по этим условиям, а не только показанные на экране.
                  </p>
                  {exportButton('panel')}
                </div>
                <div className="mt-auto flex gap-2">
                  <Button className="flex-1" onClick={() => setFiltersOpen(false)}>
                    Показать
                  </Button>
                  <Button variant="outline" onClick={resetAll} disabled={!filtered}>
                    Сбросить
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {ctx && !list.isLoading ? (
              <p className="mr-1 text-xs text-muted-foreground" data-testid="found-total">
                Найдено {list.total}
              </p>
            ) : null}
            <ul className="contents" aria-label="Включённые фильтры">
              {chips.map((chip) => (
                <li key={chip.key}>
                  <button
                    type="button"
                    onClick={chip.clear}
                    aria-label={`Убрать фильтр: ${chip.label}`}
                    className="inline-flex items-center gap-1 rounded-full border bg-accent px-2.5 py-1 text-xs"
                  >
                    {chip.label} <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {wide && ctx && !list.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="found-total">
          Найдено {list.total}
        </p>
      ) : null}
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
              <Button variant="outline" onClick={resetAll}>
                Сбросить фильтры
              </Button>
            ) : admin ? undefined : (
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
                      {admin ? (
                        <p className="text-sm font-medium" data-testid="pass-tenant">
                          <span className="text-muted-foreground">Арендатор: </span>
                          {tenantName(pass.tenantId)}
                        </p>
                      ) : null}
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
      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="lg"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
            data-testid="show-more"
          >
            Показать ещё ({list.rest})
          </Button>
        </div>
      ) : null}
      <PassDetails pass={opened} onClose={() => setOpened(null)} />
      <CancelPassDialog pass={cancelling} onClose={() => setCancelling(null)} />
      {admin && editing ? (
        // правка чужого пропуска: форма и справочники — этого арендатора, а не «всего объекта»
        <CabinetProvider
          key={editing.tenantId}
          forcedTenant={{ id: editing.tenantId, name: tenantName(editing.tenantId) }}
        >
          <PassEditDialog pass={editing} onClose={() => setEditing(null)} />
        </CabinetProvider>
      ) : (
        <PassEditDialog pass={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

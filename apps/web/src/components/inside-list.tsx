import type { InsideRowSchema, OccupancyViewSchema } from '@oxrana/contracts';
import { Button, Card, CardContent, EmptyState, Field, formatInZone, Input } from '@oxrana/ui';
import { MapPin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { useApi, useApiPages, useMe } from '../lib/data';
import { usePassCardLink } from '../lib/pass-link';
import { PASS_TYPE_LABEL } from '../lib/pass-text';
import { stayText } from '../lib/stay';
import { useDebounced } from '../lib/use-debounced';
import { PassCardHost } from './cabinet/pass-card';
import { LoadError } from './common';
import { ExportButton } from './export-button';

type Row = z.infer<typeof InsideRowSchema>;
type Occupancy = z.infer<typeof OccupancyViewSchema>;

/**
 * «Сейчас на территории» (7b.1): все открытые визиты арендатора без ограничения, порциями по 50;
 * число совпадает с виджетом лимитов (`quotaId` — те же визиты, что считает движок). Время на
 * территории идёт по часам сервера и обновляется само. Выгрузка — все строки по фильтру.
 */
export function InsideList({
  siteId,
  tenantId,
  timezone,
  serverNow,
  quotaId,
  onClearQuota,
  showTenant = false,
}: {
  siteId: string;
  /** Арендатор; без него — все арендаторы, которых актор видит. */
  tenantId?: string | undefined;
  timezone: string;
  serverNow: () => number;
  quotaId?: string | undefined;
  onClearQuota?: (() => void) | undefined;
  /** Страница объекта в админке: в строке — название арендатора. */
  showTenant?: boolean;
}) {
  const { can } = useMe();
  const card = usePassCardLink();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const params = new URLSearchParams();
  if (tenantId) params.set('tenantId', tenantId);
  if (quotaId) params.set('quotaId', quotaId);
  if (q) params.set('q', q);
  const list = useApiPages<Row>(`/sites/${siteId}/inside?${params.toString()}`, (r) => r.visitId);
  const occupancy = useApi<Occupancy>(
    quotaId && can('occupancy.view') ? `/sites/${siteId}/occupancy` : null,
  );
  const quotaName = occupancy.data?.quotas.find((x) => x.quotaId === quotaId)?.name;

  // «На территории 2 ч 15 мин» идёт само, без обновления страницы
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const now = serverNow();

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-start gap-3">
            <Field label="Поиск" hint="Цифры номера или фамилия." className="min-w-60 flex-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                inputMode="search"
                autoComplete="off"
                placeholder="цифры номера"
              />
            </Field>
            {/* «Выгрузить в Excel» — рядом с поиском: все строки по фильтру */}
            <div className="pt-[1.375rem]">
              <ExportButton
                path={`/sites/${siteId}/inside/export`}
                params={params}
                fileLabel="на территории"
                disabledReason={
                  list.total === 0 ? 'На территории никого нет — выгружать нечего.' : undefined
                }
              />
            </div>
          </div>
          {quotaId ? (
            <button
              type="button"
              onClick={onClearQuota}
              aria-label="Показать всех, не только этот лимит"
              data-testid="quota-chip"
              className="inline-flex items-center gap-1 rounded-full border bg-accent px-3 py-1.5 text-sm"
            >
              Лимит: {quotaName ?? 'выбранный'} <X aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </CardContent>
      </Card>

      {!list.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="inside-total">
          На территории: <span className="font-semibold text-foreground">{list.total}</span>
        </p>
      ) : null}

      {list.error ? <LoadError error={list.error} retry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : list.items.length === 0 && !list.error ? (
        <EmptyState
          icon={MapPin}
          title={
            q || quotaId
              ? 'По этим условиям на территории никого нет'
              : 'Сейчас на территории никого нет'
          }
          hint="Список обновляется сам, когда машина въезжает или выезжает."
        />
      ) : (
        <ul className="space-y-2" aria-label="На территории" data-testid="inside-list">
          {list.items.map((row) => {
            const timeIn = row.timeIn ? Date.parse(row.timeIn) : null;
            const place = [
              row.dock ? `док ${row.dock}` : null,
              row.zone ? `место: ${row.zone}` : null,
            ].filter(Boolean);
            return (
              <li key={row.visitId}>
                <Card
                  data-testid="inside-row"
                  className="relative transition-colors hover:bg-accent/40 has-[.open-card:focus-visible]:ring-2 has-[.open-card:focus-visible]:ring-ring"
                >
                  <CardContent className="grid gap-1 pt-4 sm:grid-cols-[1fr_auto] sm:items-start">
                    <div className="min-w-0 space-y-1">
                      {row.passId ? (
                        <button
                          type="button"
                          onClick={() => card.open(row.passId ?? '')}
                          aria-haspopup="dialog"
                          title="Открыть карточку пропуска"
                          className="open-card text-left font-mono text-base font-semibold underline-offset-2 outline-none after:absolute after:inset-0 after:content-[''] hover:underline"
                        >
                          {row.title}
                        </button>
                      ) : (
                        <p
                          className="font-mono text-base font-semibold"
                          title="Выезд без пропуска: карточки нет"
                        >
                          {row.title}
                        </p>
                      )}
                      {showTenant ? (
                        <p className="text-sm font-medium" data-testid="inside-tenant">
                          <span className="text-muted-foreground">Арендатор: </span>
                          {row.tenantName}
                        </p>
                      ) : null}
                      <p className="text-sm text-muted-foreground">
                        {[
                          row.categoryName,
                          row.passType ? PASS_TYPE_LABEL[row.passType] : null,
                          row.participant === 'pedestrian' ? 'пешеход' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      <p className="text-sm">
                        {row.gateInName ? `Въезд: ${row.gateInName}` : 'Въезд'}
                        {place.length > 0 ? ` · ${place.join(' · ')}` : ''}
                      </p>
                    </div>
                    {timeIn !== null ? (
                      <div className="text-sm sm:text-right">
                        <p className="font-medium" data-testid="inside-stay">
                          {stayText(timeIn, now)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          с {formatInZone(row.timeIn ?? '', timezone)}
                        </p>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <PassCardHost />
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
    </div>
  );
}

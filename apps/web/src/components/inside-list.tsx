import type { InsideRowSchema, OccupancyViewSchema } from '@oxrana/contracts';
import { Button, Card, CardContent, EmptyState, Field, formatInZone, Input } from '@oxrana/ui';
import { MapPin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { useApi, useApiPages, useMe } from '../lib/data';
import { PASS_TYPE_LABEL } from '../lib/pass-text';
import { stayText } from '../lib/stay';
import { useDebounced } from '../lib/use-debounced';
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
}: {
  siteId: string;
  /** Арендатор; без него — все арендаторы, которых актор видит. */
  tenantId?: string | undefined;
  timezone: string;
  serverNow: () => number;
  quotaId?: string | undefined;
  onClearQuota?: (() => void) | undefined;
}) {
  const { can } = useMe();
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
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-2">
          <Field label="Поиск" hint="Цифры номера или фамилия.">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              inputMode="search"
              autoComplete="off"
              placeholder="цифры номера"
            />
          </Field>
          {quotaId ? (
            <div className="flex items-end">
              <button
                type="button"
                onClick={onClearQuota}
                aria-label="Показать всех, не только этот лимит"
                data-testid="quota-chip"
                className="inline-flex items-center gap-1 rounded-full border bg-accent px-3 py-1.5 text-sm"
              >
                Лимит: {quotaName ?? 'выбранный'} <X aria-hidden className="size-3.5" />
              </button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!list.isLoading ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="pt-2 text-sm text-muted-foreground" data-testid="inside-total">
            На территории: <span className="font-semibold text-foreground">{list.total}</span>
          </p>
          <ExportButton
            path={`/sites/${siteId}/inside/export`}
            params={params}
            fileLabel="на территории"
            disabledReason={
              list.total === 0 ? 'На территории никого нет — выгружать нечего.' : undefined
            }
          />
        </div>
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
                <Card data-testid="inside-row">
                  <CardContent className="grid gap-1 pt-4 sm:grid-cols-[1fr_auto] sm:items-start">
                    <div className="min-w-0 space-y-1">
                      <p className="font-mono text-base font-semibold">{row.title}</p>
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

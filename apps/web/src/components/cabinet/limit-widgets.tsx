import type { OccupancyViewSchema, TenantTodaySchema } from '@oxrana/contracts';
import { Badge, Card, CardContent, cn, Skeleton } from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import { useApi, useMe } from '../../lib/data';
import { useCabinet } from './cabinet-context';

type Occupancy = z.infer<typeof OccupancyViewSchema>;
type Today = z.infer<typeof TenantTodaySchema>;

/** «Грузовые 24/25 · 2 ждут»: заполнено — жёлтым, место есть — спокойным цветом. */
export function LimitWidgets() {
  const { can } = useMe();
  const { tenant, ctx } = useCabinet();
  const allowed = can('occupancy.view');
  const occupancy = useApi<Occupancy>(allowed && ctx ? `/sites/${ctx.site.id}/occupancy` : null);
  if (!allowed) return null;
  if (occupancy.isLoading || !ctx) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label="Загрузка лимитов">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  const quotas = (occupancy.data?.quotas ?? []).filter((q) => q.tenantId === tenant?.id);
  if (quotas.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="no-limits">
        Лимитов на территории для вашей компании нет — число машин не ограничено.
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="Лимиты на территории">
      {quotas.map((q) => {
        const full = q.capacity > 0 && q.occupied >= q.capacity;
        const none = q.capacity === 0;
        return (
          <li key={q.quotaId}>
            <Link
              to="/cabinet/inside"
              search={{ quota: q.quotaId }}
              aria-label={`${q.name}: ${q.occupied} из ${q.capacity}. Показать, кто на территории`}
              className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Card
                data-testid="limit-widget"
                data-full={full}
                className="transition-colors hover:bg-accent/40"
              >
                <CardContent className="space-y-2 pt-4">
                  <p className="text-sm text-muted-foreground">{q.name}</p>
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className={cn('text-3xl font-semibold tabular-nums', full && 'text-warning')}
                    >
                      {q.occupied} / {q.capacity}
                    </span>
                    {q.waiting > 0 ? (
                      <Badge tone="warning">
                        {q.waiting} {waitingWord(q.waiting)}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {none
                      ? 'не предусмотрено договором'
                      : full
                        ? q.enforcement === 'hard'
                          ? 'место занято — следующая машина будет ждать у ворот'
                          : 'лимит заполнен'
                        : `свободно: ${q.capacity - q.occupied}`}
                  </p>
                </CardContent>
              </Card>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const waitingWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'ждёт' : 'ждут');

/** «Сегодня: ожидаются 18 · въехали 31 · выехали 27 · отказов 1» — плитками, обновляются сами. */
export function TodaySummary() {
  const { tenant } = useCabinet();
  const today = useApi<Today>(tenant ? `/tenants/${tenant.id}/today` : null);
  const t = today.data;
  const tiles: { id: string; label: string; value: number | undefined }[] = [
    { id: 'expected', label: 'ожидаются', value: t?.expected },
    { id: 'entered', label: 'въехали', value: t?.entered },
    { id: 'exited', label: 'выехали', value: t?.exited },
    { id: 'refused', label: 'отказов', value: t?.refused },
  ];
  return (
    <section aria-labelledby="today-title" className="space-y-2">
      <h2 id="today-title" className="text-sm font-medium text-muted-foreground">
        Сегодня
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.id}>
            <Card>
              <CardContent className="pt-4">
                <p className="text-3xl font-semibold tabular-nums" data-testid={`today-${tile.id}`}>
                  {tile.value ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">{tile.label}</p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {t ? (
        <p className="text-xs text-muted-foreground">
          <Link
            to="/cabinet/inside"
            className="underline-offset-2 hover:underline"
            data-testid="inside-link"
          >
            Сейчас на территории: {t.inside}
          </Link>
          {t.pendingApproval > 0 ? ` · на согласовании: ${t.pendingApproval}` : ''}
        </p>
      ) : null}
    </section>
  );
}

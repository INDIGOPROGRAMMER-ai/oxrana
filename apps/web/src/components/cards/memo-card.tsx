import { Alert, Button, Section } from '@oxrana/ui';
import { Printer } from 'lucide-react';
import {
  type SiteView,
  useBlacklist,
  useCategories,
  useExceptions,
  useGates,
  useMe,
  useQuotas,
  useRoutingRules,
  useTenants,
} from '../../lib/data';
import { ADMITS_LABEL, ENFORCEMENT_LABEL, WAIVE_LABEL } from '../../lib/labels';
import { LoadError, RequireSite } from '../common';
import { describeHours } from '../working-hours';

/**
 * Памятка КПП (этап 6b): правила этого объекта простым языком, на одну-две страницы для печати.
 * Собирается из настроенных данных, поэтому всегда совпадает с тем, что решит система.
 */
export function MemoCard() {
  return <RequireSite>{(site) => <Body site={site} />}</RequireSite>;
}

function Body({ site }: { site: SiteView }) {
  const { can } = useMe();
  const gates = useGates(site.id);
  const categories = useCategories(site.id, false);
  const routes = useRoutingRules(can('rule.manage') ? site.id : null);
  const tenants = useTenants(site.id);
  const quotas = useQuotas(can('quota.manage') ? site.id : null);
  const exceptions = useExceptions(can('rule.manage') ? site.id : null);
  const blacklist = useBlacklist(can('blacklist.manage') ? site.id : null);
  const failed = gates.error ?? categories.error ?? tenants.error;
  if (failed) return <LoadError error={failed} />;
  const gateList = [...(gates.items ?? [])].sort((a, b) => a.sort - b.sort);
  const gateName = (id: string) => gates.items?.find((g) => g.id === id)?.name ?? '?';
  const tenantName = (id: string) => tenants.items?.find((t) => t.id === id)?.shortName ?? '?';
  const siteRoutes = (routes.items ?? []).filter(
    (r) => r.tenantId === null && r.direction !== 'out',
  );
  const routeText = (categoryId: string) => {
    const names = [
      ...new Set(
        siteRoutes
          .filter((r) => r.participant === 'vehicle' && r.categoryId === categoryId)
          .map((r) => gateName(r.gateId)),
      ),
    ];
    return names.length > 0 ? names.join(', ') : 'любой КПП для машин';
  };
  const byTenant = new Map<string, string[]>();
  for (const q of quotas.items ?? []) {
    const line = `${q.name}: ${q.capacityFromDocks ? 'по числу доков' : q.capacity}${q.capacity === 0 && !q.capacityFromDocks ? ' (не предусмотрено — не пускать)' : ''} — ${ENFORCEMENT_LABEL[q.enforcement]}`;
    byTenant.set(q.tenantId, [...(byTenant.get(q.tenantId) ?? []), line]);
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Правила объекта простым языком. Нажмите «Печать» — на бумаге останется только памятка.
          Данные берутся из настроек, поэтому после их изменения памятку стоит напечатать заново.
        </p>
        <Button onClick={() => window.print()}>
          <Printer aria-hidden /> Печать
        </Button>
      </div>
      <article className="space-y-5 print:space-y-3" data-testid="memo">
        <header>
          <h2 className="text-xl font-semibold">Памятка КПП — {site.name}</h2>
          <p className="text-sm text-muted-foreground">
            Время на объекте — {site.timezoneLabel}. Рабочее время комплекса:{' '}
            {describeHours(site.workingHours)}.
            {site.settings.dutyAdminPhone
              ? ` Дежурный администратор: ${site.settings.dutyAdminPhone}.`
              : ''}
          </p>
        </header>

        <Section title="Что означают цвета на экране">
          <ul className="space-y-1 text-sm">
            <li>
              🟢 <strong>Зелёный</strong> — всё в порядке, нажмите «Впустить».
            </li>
            <li>
              🟡 <strong>Жёлтый</strong> — нужно подождать: места арендатора заняты или
              предупреждение.
            </li>
            <li>
              🔵 <strong>Синий</strong> — не тот КПП: направьте машину на другой.
            </li>
            <li>
              🟠 <strong>Оранжевый</strong> — впустить можно, но это сверх лимита арендатора.
            </li>
            <li>
              🔴 <strong>Красный</strong> — не пускать. Причина написана на экране. Если спорно —
              звоните администратору.
            </li>
          </ul>
        </Section>

        <Section title="КПП и кого они пропускают">
          {gateList.length === 0 ? (
            <p className="text-sm text-muted-foreground">КПП не добавлены.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {gateList.map((g) => (
                <li key={g.id}>
                  <strong>{g.name}</strong> — {ADMITS_LABEL[g.admits]}
                  {g.kind === 'internal' ? '; пост внутри здания, отмечает только проход' : ''}
                  {g.workingHours ? `; работает ${describeHours(g.workingHours)}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Куда направлять машины">
          {(categories.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Типы транспорта не включены.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {(categories.items ?? [])
                .filter((c) => c.enabled)
                .map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong> →{' '}
                    {can('rule.manage') ? routeText(c.id) : 'см. администратора'}
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Выезд — через любой КПП. У отдельных арендаторов могут быть свои маршруты — их покажет
            экран.
          </p>
        </Section>

        {can('quota.manage') ? (
          <Section title="Лимиты арендаторов (сколько машин одновременно)">
            {byTenant.size === 0 ? (
              <p className="text-sm text-muted-foreground">
                Лимиты не заданы: нет лимита — нет ограничения.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {[...byTenant].map(([tenantId, lines]) => (
                  <li key={tenantId}>
                    <strong>{tenantName(tenantId)}</strong>: {lines.join('; ')}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              «Жёсткий» — сверх лимита не пускать, машина ждёт. «Мягкий» — пускать, это пойдёт в
              начисления. «Информирующий» — только предупредить.
            </p>
          </Section>
        ) : null}

        {can('rule.manage') && (exceptions.items ?? []).length > 0 ? (
          <Section title="Исключения">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {(exceptions.items ?? []).map((e) => (
                <li key={e.id}>
                  {e.guardText ?? e.name} — не проверяется:{' '}
                  {e.waives.map((w) => WAIVE_LABEL[w]).join(', ')}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Чёрный список и блокировки">
          <p className="text-sm">
            Машину из чёрного списка{' '}
            {can('blacklist.manage')
              ? `(сейчас записей: ${(blacklist.items ?? []).filter((b) => b.active).length}) `
              : ''}
            не пускаем: на экране красная карточка «В чёрном списке» с причиной. На выезде такую
            машину выпускаем, но сообщаем администратору. Если арендатор заблокирован
            администратором, его машины на въезде получают красный цвет с причиной; выезд свободен
            всегда.
          </p>
        </Section>

        <Alert tone="info" className="print:hidden">
          Нужна памятка для арендаторов — она появится вместе с кабинетом арендатора (этап 7).
        </Alert>
      </article>
    </div>
  );
}

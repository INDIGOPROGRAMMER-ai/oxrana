import { Alert, Badge, Button, cn, Section, useLinkComponent } from '@oxrana/ui';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { type TenantView, useDockAssignments, useQuotas, useTenants } from '../../lib/data';
import { count } from '../../lib/setup';
import { Empty, LoadError, RequireSite } from '../common';
import { QuotasCard } from './quotas-card';
import { isActiveOn, TenantDocksCard } from './tenant-docks-card';
import { siteToday, usePermissions } from './tenant-rule-helpers';

/**
 * Шаг 7 мастера «Назначения и лимиты»: выберите арендатора — справа его доки и лимиты. Первый
 * арендатор выбран по умолчанию (подсвечен); выбор помнится, пока открыт шаг.
 */
export function LimitsStep() {
  return (
    <RequireSite>{(site) => <LimitsBody siteId={site.id} timezone={site.timezone} />}</RequireSite>
  );
}

function LimitsBody({ siteId, timezone }: { siteId: string; timezone: string }) {
  const Link = useLinkComponent();
  const perms = usePermissions();
  const tenants = useTenants(siteId);
  const quotas = useQuotas(!perms.loaded || perms.can('quota.manage') ? siteId : null);
  const [chosen, setChosen] = useState<string | null>(null);

  if (tenants.error)
    return <LoadError error={tenants.error} retry={() => void tenants.refetch()} />;
  if (tenants.isLoading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Загрузка…
      </p>
    );
  }
  const items = tenants.items ?? [];
  if (items.length === 0) {
    return (
      <Empty
        title="Арендаторов пока нет"
        hint="Лимиты и доки назначаются арендатору. Сначала добавьте арендаторов на шаге «Арендаторы» — по одному или вставкой из Excel."
        action={
          <Button asChild>
            <Link href="/admin/setup/tenants">
              <Users aria-hidden /> Перейти к шагу «Арендаторы»
            </Link>
          </Button>
        }
      />
    );
  }

  const selected = items.find((t) => t.id === chosen) ?? items[0];
  const quotasOf = (tenantId: string) =>
    (quotas.items ?? []).filter((q) => q.tenantId === tenantId && q.participant === 'vehicle')
      .length;

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Section
        title="Арендаторы"
        description="Выберите арендатора, чтобы назначить ему доки и лимиты."
        className="mb-0 self-start"
      >
        <ul className="space-y-1.5">
          {items.map((t) => (
            <li key={t.id}>
              <TenantRow
                tenant={t}
                timezone={timezone}
                isSelected={t.id === selected?.id}
                limits={quotas.error || quotas.isLoading ? null : quotasOf(t.id)}
                onSelect={() => setChosen(t.id)}
              />
            </li>
          ))}
        </ul>
      </Section>
      {selected ? (
        <div className="min-w-0">
          <h2 className="mb-3 text-lg font-semibold">{selected.shortName}</h2>
          {selected.isOperator ? (
            <Alert tone="info" className="mb-4">
              Это оператор объекта: у него нет лимитов, он проезжает через все КПП.
            </Alert>
          ) : null}
          <TenantDocksCard tenantId={selected.id} />
          <QuotasCard tenantId={selected.id} />
        </div>
      ) : null}
    </div>
  );
}

function TenantRow({
  tenant,
  timezone,
  isSelected,
  limits,
  onSelect,
}: {
  tenant: TenantView;
  timezone: string;
  isSelected: boolean;
  /** Число лимитов; `null` — не удалось узнать (нет права или ошибка загрузки). */
  limits: number | null;
  onSelect: () => void;
}) {
  const perms = usePermissions();
  const assignments = useDockAssignments(
    !perms.loaded || perms.can('tenant.manage') ? tenant.id : null,
  );
  const today = siteToday(timezone);
  const docks = assignments.items?.filter((a) => isActiveOn(a, today)).length;
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
        isSelected ? 'border-primary bg-accent text-accent-foreground' : 'bg-card',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{tenant.shortName}</span>
        {isSelected ? <Badge tone="info">выбран</Badge> : null}
      </span>
      <span className="flex flex-wrap gap-1.5">
        {tenant.isOperator ? (
          <Badge tone="neutral">оператор — без лимитов</Badge>
        ) : limits === null ? null : limits > 0 ? (
          <Badge tone="success">есть лимиты: {limits}</Badge>
        ) : (
          <Badge tone="warning">нет лимитов</Badge>
        )}
        {docks === undefined ? null : <Badge tone="outline">доки: {docks}</Badge>}
      </span>
      {docks !== undefined && docks > 0 ? (
        <span className="sr-only">
          {count(docks, 'док закреплён', 'дока закреплено', 'доков закреплено')}
        </span>
      ) : null}
    </button>
  );
}

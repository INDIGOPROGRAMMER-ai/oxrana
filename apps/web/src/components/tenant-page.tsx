import { Badge, PageHeader } from '@oxrana/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { useMe, useTrackContracts } from '../lib/data';
import { useSite } from '../lib/site-context';
import { ExceptionsCard } from './cards/exceptions-card';
import { PedestrianRulesCard } from './cards/pedestrian-rules-card';
import { QuotasCard } from './cards/quotas-card';
import { RoutingCard } from './cards/routing-card';
import { TenantContractCard } from './cards/tenant-contract-card';
import { TenantDocksCard } from './cards/tenant-docks-card';
import { TenantGeneralCard } from './cards/tenant-general-card';
import { TenantParkingCard } from './cards/tenant-parking-card';
import { TenantStatusBadge, useTenant } from './cards/tenant-shared';
import { LoadError } from './common';
import { InsideList } from './inside-list';

export const TENANT_TABS = [
  'general',
  'contract',
  'docks',
  'parking',
  'quotas',
  'routes',
  'exceptions',
  'pedestrians',
  'inside',
] as const;
export type TenantTab = (typeof TENANT_TABS)[number];

const TAB_LABEL: Record<TenantTab, string> = {
  general: 'Общее',
  contract: 'Договор',
  docks: 'Доки',
  parking: 'Парковка',
  quotas: 'Лимиты',
  routes: 'Маршруты',
  exceptions: 'Исключения',
  pedestrians: 'Пешеходы',
  inside: 'На территории',
};

/** Вкладка из параметра поиска `tab`; всё незнакомое — «Общее». */
export function parseTenantTab(value: unknown): TenantTab | undefined {
  return TENANT_TABS.find((t) => t === value);
}

/**
 * Страница арендатора: заголовок с названием и вкладки. Вкладка — в адресе (`?tab=…`), поэтому
 * ссылку на неё можно отправить; «Лимиты» открываются и по адресу `/admin/tenants/<id>/quotas`
 * (на него ведут ссылки из ошибок API).
 */
export function TenantPage({ tenantId, tab }: { tenantId: string; tab: TenantTab }) {
  const navigate = useNavigate();
  const tenant = useTenant(tenantId);
  const track = useTrackContracts();
  const { can } = useMe();
  const seesInside = can('pass.view') || can('pass.view_all_tenants');
  const tabs = TENANT_TABS.filter(
    (t) => (track || t !== 'contract') && (seesInside || t !== 'inside'),
  );
  const { site, select } = useSite();
  const tenantSiteId = tenant.data?.siteId;
  // карточка арендатора открывает его объект: время и справочники — того же объекта
  useEffect(() => {
    if (tenantSiteId && site?.id !== tenantSiteId) select(tenantSiteId);
  }, [tenantSiteId, site?.id, select]);

  function openTab(next: TenantTab) {
    if (next === 'quotas') {
      void navigate({ to: '/admin/tenants/$tenantId/quotas', params: { tenantId } });
      return;
    }
    void navigate({
      to: '/admin/tenants/$tenantId',
      params: { tenantId },
      search: next === 'general' ? {} : { tab: next },
    });
  }

  const data = tenant.data;
  return (
    <>
      <PageHeader
        title={data?.shortName ?? 'Арендатор'}
        description={
          data ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {data.legalName}
              <TenantStatusBadge status={data.status} />
              {data.isOperator ? <Badge tone="info">оператор</Badge> : null}
            </span>
          ) : (
            'Загрузка…'
          )
        }
        actions={
          <Link
            to="/admin/tenants"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ArrowLeft aria-hidden className="size-4" /> Все арендаторы
          </Link>
        }
      />
      {tenant.error ? (
        <LoadError error={tenant.error} retry={() => void tenant.refetch()} />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Разделы карточки арендатора"
            className="mb-5 flex gap-1 overflow-x-auto border-b"
          >
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tenant-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="tenant-tabpanel"
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  tab === t
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => openTab(t)}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="tenant-tabpanel" aria-labelledby={`tenant-tab-${tab}`}>
            {tab === 'general' ? <TenantGeneralCard tenantId={tenantId} /> : null}
            {tab === 'contract' ? <TenantContractCard tenantId={tenantId} /> : null}
            {tab === 'docks' ? <TenantDocksCard tenantId={tenantId} /> : null}
            {tab === 'parking' ? <TenantParkingCard tenantId={tenantId} /> : null}
            {tab === 'quotas' ? <QuotasCard tenantId={tenantId} /> : null}
            {tab === 'routes' ? <RoutingCard tenantId={tenantId} /> : null}
            {tab === 'exceptions' ? <ExceptionsCard tenantId={tenantId} /> : null}
            {tab === 'pedestrians' ? <PedestrianRulesCard tenantId={tenantId} /> : null}
            {tab === 'inside' && site && data ? (
              <InsideList
                siteId={data.siteId}
                tenantId={tenantId}
                timezone={site.timezone}
                // в админке — только разность «сейчас» и въезда: часы браузера годятся для длительности
                serverNow={() => Date.now()}
              />
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

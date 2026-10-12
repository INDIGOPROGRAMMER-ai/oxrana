import { createFileRoute } from '@tanstack/react-router';
import { parseTenantTab, TenantPage, type TenantTab } from '../components/tenant-page';

export const Route = createFileRoute('/admin/tenants/$tenantId/')({
  // вкладка — в адресе: `?tab=contract`; пусто или незнакомое значение — «Общее»
  validateSearch: (search: Record<string, unknown>): { tab?: TenantTab } => {
    const tab = parseTenantTab(search.tab);
    return tab ? { tab } : {};
  },
  component: TenantIndexPage,
});

function TenantIndexPage() {
  const { tenantId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <TenantPage tenantId={tenantId} tab={tab ?? 'general'} />;
}

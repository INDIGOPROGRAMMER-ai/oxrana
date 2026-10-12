import { createFileRoute } from '@tanstack/react-router';
import { TenantPage } from '../components/tenant-page';

/** Адрес из `settingLink` ошибок API: открывает вкладку «Лимиты» арендатора. */
export const Route = createFileRoute('/admin/tenants/$tenantId/quotas')({
  component: () => <TenantPage tenantId={Route.useParams().tenantId} tab="quotas" />,
});

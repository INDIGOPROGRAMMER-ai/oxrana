import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { TenantsCard } from '../components/cards/tenants-card';

export const Route = createFileRoute('/admin/tenants/')({
  component: () => (
    <>
      <PageHeader
        title="Арендаторы"
        description="Компании, которым принадлежат пропуска и лимиты. Откройте арендатора, чтобы настроить договор, доки, лимиты, исключения и правила для пешеходов."
      />
      <TenantsCard />
    </>
  ),
});

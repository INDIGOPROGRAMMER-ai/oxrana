import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { RolesCard } from '../components/cards/roles-card';

export const Route = createFileRoute('/admin/roles')({
  component: () => (
    <>
      <PageHeader
        title="Роли"
        description="Какие права даёт каждая роль и где её обычно назначают."
      />
      <RolesCard />
    </>
  ),
});

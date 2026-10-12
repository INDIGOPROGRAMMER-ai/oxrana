import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { PoliciesCard } from '../components/cards/policies-card';

export const Route = createFileRoute('/admin/policies')({
  component: () => (
    <>
      <PageHeader
        title="Политики"
        description="Сроки пропусков, рабочее время, окна прибытия и согласование пропусков."
      />
      <PoliciesCard />
    </>
  ),
});

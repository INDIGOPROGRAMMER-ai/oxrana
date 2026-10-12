import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { RoutingCard } from '../components/cards/routing-card';

export const Route = createFileRoute('/admin/routing')({
  component: () => (
    <>
      <PageHeader
        title="Маршруты"
        description="Через какие КПП может въезжать каждый тип транспорта и куда идут пешеходы."
      />
      <RoutingCard />
    </>
  ),
});

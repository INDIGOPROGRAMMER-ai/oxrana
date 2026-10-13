import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { HardwareCard } from '../components/cards/hardware-card';

export const Route = createFileRoute('/admin/hardware')({
  component: () => (
    <>
      <PageHeader
        title="Оборудование"
        description="Камеры номеров, шлагбаумы, сканеры и СКУД — через агент КПП."
      />
      <HardwareCard />
    </>
  ),
});

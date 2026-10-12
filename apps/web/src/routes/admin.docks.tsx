import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { DocksCard } from '../components/cards/docks-card';

export const Route = createFileRoute('/admin/docks')({
  component: () => (
    <>
      <PageHeader
        title="Доки и зоны"
        description="Зоны объекта и номера доков — диапазоном или вставкой списка."
      />
      <DocksCard />
    </>
  ),
});

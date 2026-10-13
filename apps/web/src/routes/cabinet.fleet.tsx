import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { FleetView } from '../components/cabinet/fleet-view';

export const Route = createFileRoute('/cabinet/fleet')({
  component: () => (
    <div>
      <PageHeader
        title="Автопарк"
        description="Постоянные машины вашей компании. Из автопарка пропуск оформляется в один клик."
      />
      <FleetView />
    </div>
  ),
});

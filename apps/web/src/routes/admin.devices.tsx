import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { DevicesCard } from '../components/cards/devices-card';

export const Route = createFileRoute('/admin/devices')({
  component: () => (
    <>
      <PageHeader
        title="Устройства КПП"
        description="Привязка компьютеров и планшетов к постам охраны и отзыв потерянных устройств."
      />
      <DevicesCard />
    </>
  ),
});

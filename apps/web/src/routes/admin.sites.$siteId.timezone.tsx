import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { TimezoneChangeCard } from '../components/cards/timezone-card';

export const Route = createFileRoute('/admin/sites/$siteId/timezone')({
  component: () => (
    <>
      <PageHeader
        title="Смена часового пояса"
        description="Отдельное действие: с причиной и подтверждением последствий."
      />
      <TimezoneChangeCard />
    </>
  ),
});

import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { SiteCard } from '../components/cards/site-card';
import { useSite } from '../lib/site-context';

export const Route = createFileRoute('/admin/sites/$siteId/')({
  component: SitePage,
});

function SitePage() {
  const { siteId } = Route.useParams();
  const { select } = useSite();
  // адрес вида /admin/sites/<id> (ссылка из ошибки API) открывает именно этот объект
  useEffect(() => select(siteId), [siteId, select]);
  return (
    <>
      <PageHeader title="Объект" description="Название, адрес, рабочее время и часовой пояс." />
      <SiteCard />
    </>
  );
}

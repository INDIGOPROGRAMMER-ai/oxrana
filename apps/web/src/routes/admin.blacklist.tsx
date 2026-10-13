import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { BlacklistCard } from '../components/cards/blacklist-card';

export const Route = createFileRoute('/admin/blacklist')({
  component: () => (
    <>
      <PageHeader
        title="Чёрный список"
        description="Номера машин и люди, которых нельзя пускать: причина, срок, уровень."
      />
      <BlacklistCard />
    </>
  ),
});

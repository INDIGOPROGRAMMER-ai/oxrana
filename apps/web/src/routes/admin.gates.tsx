import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { GatesCard } from '../components/cards/gates-card';

export const Route = createFileRoute('/admin/gates')({
  component: () => (
    <>
      <PageHeader title="КПП" description="Посты пропуска: кого пропускает, вид и часы работы." />
      <GatesCard />
    </>
  ),
});

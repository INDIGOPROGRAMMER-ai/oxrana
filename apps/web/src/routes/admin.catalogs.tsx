import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { CatalogsCard } from '../components/cards/catalogs-card';

export const Route = createFileRoute('/admin/catalogs')({
  component: () => (
    <>
      <PageHeader
        title="Цели визита и парковки"
        description="Зачем приезжают и сколько мест на парковочных участках. Места закрепляются за арендатором в его карточке."
      />
      <CatalogsCard />
    </>
  ),
});

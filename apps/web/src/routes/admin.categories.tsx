import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { CategoriesCard } from '../components/cards/categories-card';

export const Route = createFileRoute('/admin/categories')({
  component: () => (
    <>
      <PageHeader
        title="Типы транспорта"
        description="Что за транспорт ездит на объект: готовый набор, свои типы, порядок в формах."
      />
      <CategoriesCard />
    </>
  ),
});

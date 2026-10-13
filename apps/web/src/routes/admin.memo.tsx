import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { MemoCard } from '../components/cards/memo-card';

export const Route = createFileRoute('/admin/memo')({
  component: () => (
    <>
      <div className="print:hidden">
        <PageHeader
          title="Памятка КПП"
          description="Правила объекта простым языком — для печати и вывешивания на посту."
        />
      </div>
      <MemoCard />
    </>
  ),
});

import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { PoliciesCard } from '../components/cards/policies-card';

/** Адрес приходит в `settingLink` ошибок API; страница — та же, что «Политики». */
export const Route = createFileRoute('/admin/rules/approval-policies')({
  component: () => (
    <>
      <PageHeader
        title="Политики"
        description="Сроки пропусков, рабочее время, окна прибытия и согласование пропусков."
      />
      <PoliciesCard />
    </>
  ),
});

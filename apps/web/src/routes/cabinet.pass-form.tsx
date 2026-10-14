import { Alert, PageHeader, Skeleton } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useCabinet } from '../components/cabinet/cabinet-context';
import { PassFormEditorView } from '../components/pass-form/editor';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/cabinet/pass-form')({
  component: CabinetPassForm,
});

/** Форма пропуска сотрудников своей компании: ответственный настраивает её сам (этап 7b, ADR-023). */
function CabinetPassForm() {
  const { tenant } = useCabinet();
  const { can } = useMe();
  const [userId, setUserId] = useState<string | null>(null);
  if (!tenant) return <Skeleton className="h-40 w-full" />;
  const allowed = can('pass_form.manage_users') || can('pass_form.manage');
  return (
    <div>
      <PageHeader
        title="Форма пропуска сотрудников"
        description={`Что видят и могут выбрать ваши сотрудники при оформлении пропуска в «${tenant.name}». Общие значения задаёт администратор объекта; вы настраиваете форму для каждого сотрудника отдельно — в пределах его роли.`}
      />
      {!allowed ? (
        <Alert tone="warning" title="Настройка недоступна">
          У вашей роли нет права настраивать форму сотрудников. Обратитесь к администратору объекта.
        </Alert>
      ) : (
        <PassFormEditorView
          key={tenant.id}
          tenantId={tenant.id}
          userId={userId}
          onUserChange={setUserId}
          startLevel="user"
        />
      )}
    </div>
  );
}

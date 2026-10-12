import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { UsersCard } from '../components/cards/users-card';

export const Route = createFileRoute('/admin/users')({
  component: () => (
    <>
      <PageHeader
        title="Пользователи"
        description="Приглашения, роли и области людей, отключение и сброс пароля."
      />
      <UsersCard />
    </>
  ),
});

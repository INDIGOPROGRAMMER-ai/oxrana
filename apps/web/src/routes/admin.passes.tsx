import { PERMISSION_LABELS } from '@oxrana/contracts';
import { Alert, PageHeader } from '@oxrana/ui';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AdminPasses, type PassesView } from '../components/cabinet/admin-passes';
import { RequireSite } from '../components/common';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/admin/passes')({
  validateSearch: (search: Record<string, unknown>): { view?: PassesView } =>
    search.view === 'inside' ? { view: 'inside' } : {},
  component: PassesPage,
});

function PassesPage() {
  const { view } = Route.useSearch();
  const navigate = useNavigate();
  const { can } = useMe();
  return (
    <>
      <PageHeader
        title="Пропуска"
        description="Пропуска всех арендаторов объекта: поиск, фильтры, выгрузка. Правка и отмена — по вашим правам."
      />
      {can('pass.view_all_tenants') ? (
        <RequireSite>
          {(site) => (
            <AdminPasses
              key={site.id}
              siteId={site.id}
              view={view ?? 'all'}
              onView={(next) =>
                void navigate({
                  to: '/admin/passes',
                  search: next === 'inside' ? { view: next } : {},
                })
              }
            />
          )}
        </RequireSite>
      ) : (
        <Alert tone="warning" title="Нет права смотреть пропуска всех арендаторов">
          Для этой страницы нужно право «{PERMISSION_LABELS['pass.view_all_tenants']}». Его выдаёт
          администратор объекта в разделе «Роли».
        </Alert>
      )}
    </>
  );
}

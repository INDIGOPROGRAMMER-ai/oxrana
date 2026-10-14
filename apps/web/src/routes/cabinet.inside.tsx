import { PageHeader } from '@oxrana/ui';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCabinet } from '../components/cabinet/cabinet-context';
import { InsideList } from '../components/inside-list';

export const Route = createFileRoute('/cabinet/inside')({
  // лимит, на виджет которого нажали: список показывает ровно те визиты, что считает виджет
  validateSearch: (search: Record<string, unknown>): { quota?: string } =>
    typeof search.quota === 'string' ? { quota: search.quota } : {},
  component: InsidePage,
});

function InsidePage() {
  const { quota } = Route.useSearch();
  const navigate = useNavigate();
  const { ctx, tenant, serverNow } = useCabinet();
  return (
    <div>
      <PageHeader
        title="Сейчас на территории"
        description={
          ctx
            ? `Все машины и люди компании на объекте. Время объекта: ${ctx.site.timezoneLabel}.`
            : undefined
        }
      />
      {ctx && tenant ? (
        <InsideList
          siteId={ctx.site.id}
          tenantId={tenant.id}
          timezone={ctx.site.timezone}
          serverNow={serverNow}
          quotaId={quota}
          onClearQuota={() => void navigate({ to: '/cabinet/inside', search: {} })}
        />
      ) : null}
    </div>
  );
}

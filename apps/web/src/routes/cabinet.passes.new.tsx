import { PageHeader, Skeleton } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useCabinet } from '../components/cabinet/cabinet-context';
import { type FleetVehicle, PassForm } from '../components/cabinet/pass-form';
import { useApi } from '../lib/data';

export const Route = createFileRoute('/cabinet/passes/new')({
  validateSearch: (search: Record<string, unknown>): { fleet?: string } =>
    typeof search.fleet === 'string' ? { fleet: search.fleet } : {},
  component: NewPass,
});

function NewPass() {
  const { fleet } = Route.useSearch();
  const { ctx, tenant, passForm } = useCabinet();
  const list = useApi<{ items: FleetVehicle[] }>(
    fleet && tenant ? `/tenants/${tenant.id}/fleet` : null,
  );
  const vehicle = fleet ? list.data?.items.find((v) => v.id === fleet) : undefined;
  // форма открывается, когда загружено всё, что подставляется в неё (CLAUDE.md п. 5)
  const ready = ctx !== undefined && passForm !== undefined && (!fleet || list.data !== undefined);
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Новый пропуск"
        description={
          vehicle ? `Из автопарка: ${vehicle.plateRaw}. Остальное — как обычно.` : undefined
        }
      />
      {ready ? (
        <PassForm key={vehicle?.id ?? 'new'} fleetVehicle={vehicle} />
      ) : (
        <div role="status" aria-label="Загрузка" className="space-y-3">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
    </div>
  );
}

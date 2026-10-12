import type { Me } from '@oxrana/contracts';
import {
  useApi,
  useApprovalGaps,
  useCategories,
  useDocks,
  useGates,
  useQuotas,
  useRoutingRules,
  useTenants,
} from './data';
import { useSite } from './site-context';
import { computeSetupProgress, type SetupProgress } from './steps';

export * from './steps';

interface AccountsView {
  items: { devices: { revokedAt: string | null }[] }[];
}
interface UsersView {
  items: unknown[];
}

/** Состояние шагов мастера по данным выбранного объекта; пока данные грузятся, `loading`. */
export function useSetupProgress(me: Me | null | undefined): {
  loading: boolean;
  progress: SetupProgress;
} {
  const { site } = useSite();
  const siteId = site?.id ?? null;
  const can = (p: string) => me?.permissions.includes(p) ?? false;
  const gates = useGates(siteId);
  const categories = useCategories(siteId, true);
  const routing = useRoutingRules(can('rule.manage') ? siteId : null);
  const docks = useDocks(siteId);
  const tenants = useTenants(siteId);
  const quotas = useQuotas(can('quota.manage') ? siteId : null);
  const gaps = useApprovalGaps(can('rule.manage') ? siteId : null);
  const accounts = useApi<AccountsView>(
    siteId && can('device.manage') ? `/sites/${siteId}/gate-accounts` : null,
  );
  const users = useApi<UsersView>(
    can('user.manage') || can('tenant_user.manage') ? '/users' : null,
  );
  const loading = [gates, categories, docks, tenants].some((q) => q.isLoading);
  const progress = computeSetupProgress({
    site,
    gates: gates.items,
    categories: categories.items,
    routing: routing.items,
    docks: docks.items,
    tenants: tenants.items,
    quotas: quotas.items,
    gaps: gaps.items,
    accounts: accounts.data?.items,
    users: users.data?.items,
    can,
  });
  return { loading, progress };
}

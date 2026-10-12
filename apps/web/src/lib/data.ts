import type {
  ApprovalPolicyGapSchema,
  ApprovalPolicyViewSchema,
  ClauseViewSchema,
  ContractViewSchema,
  DockAssignmentViewSchema,
  DockViewSchema,
  ExceptionViewSchema,
  GateViewSchema,
  Me,
  PedestrianRuleViewSchema,
  QuotaViewSchema,
  RoutingRuleViewSchema,
  SiteViewSchema,
  TenantViewSchema,
  TimeWindowPolicyViewSchema,
  VehicleCategoryViewSchema,
  ZoneViewSchema,
} from '@oxrana/contracts';
import { api } from '@oxrana/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { z } from 'zod';
import { loadMe } from './api';

export type SiteView = z.infer<typeof SiteViewSchema>;
export type GateView = z.infer<typeof GateViewSchema>;
export type ZoneView = z.infer<typeof ZoneViewSchema>;
export type DockView = z.infer<typeof DockViewSchema>;
export type CategoryView = z.infer<typeof VehicleCategoryViewSchema>;
export type TenantView = z.infer<typeof TenantViewSchema>;
export type ContractView = z.infer<typeof ContractViewSchema>;
export type ClauseView = z.infer<typeof ClauseViewSchema>;
export type DockAssignmentView = z.infer<typeof DockAssignmentViewSchema>;
export type PedestrianRuleView = z.infer<typeof PedestrianRuleViewSchema>;
export type QuotaView = z.infer<typeof QuotaViewSchema>;
export type RoutingRuleView = z.infer<typeof RoutingRuleViewSchema>;
export type TimeWindowPolicyView = z.infer<typeof TimeWindowPolicyViewSchema>;
export type ExceptionView = z.infer<typeof ExceptionViewSchema>;
export type ApprovalPolicyView = z.infer<typeof ApprovalPolicyViewSchema>;
export type ApprovalGap = z.infer<typeof ApprovalPolicyGapSchema>;

/**
 * Данные экранов: один ключ `['data', путь]` на запрос. Любое изменение через `useMutate`
 * обновляет все загруженные списки — они маленькие, а экраны остаются согласованными (мастер,
 * меню и карточки показывают одни и те же данные без ручной инвалидации по каждому справочнику).
 */
export function useApi<T>(path: string | null) {
  return useQuery({
    queryKey: ['data', path],
    queryFn: () => api<T>(path ?? ''),
    enabled: path !== null,
  });
}

/** Изменение на сервере + обновление всех данных экранов. «Сохранено» показывают после этого. */
export function useMutate() {
  const client = useQueryClient();
  return useCallback(
    async <T>(path: string, method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', body?: unknown) => {
      const result = await api<T>(path, { method, ...(body === undefined ? {} : { body }) });
      await client.invalidateQueries({ queryKey: ['data'] });
      return result;
    },
    [client],
  );
}

/** Обновить все данные экранов — после цепочки запросов, выполненных напрямую через `api`. */
export function useRefresh() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: ['data'] }), [client]);
}

export function useMe() {
  const query = useQuery({ queryKey: ['me'], queryFn: loadMe });
  const me: Me | null | undefined = query.data;
  const can = useCallback(
    (permission: string) => me?.permissions.includes(permission) ?? false,
    [me],
  );
  return { ...query, me, can };
}

const list = <T>(path: string | null) => {
  const q = useApi<{ items: T[] }>(path);
  return { ...q, items: q.data?.items };
};

export const useSites = () => list<SiteView>('/sites');
export const useGates = (siteId: string | null) =>
  list<GateView>(siteId ? `/sites/${siteId}/gates` : null);
export const useZones = (siteId: string | null) =>
  list<ZoneView>(siteId ? `/sites/${siteId}/zones` : null);
export const useDocks = (siteId: string | null) =>
  list<DockView>(siteId ? `/sites/${siteId}/docks` : null);
export const useCategories = (siteId: string | null, all = true) =>
  list<CategoryView>(siteId ? `/sites/${siteId}/vehicle-categories?all=${all}` : null);
export const useTenants = (siteId: string | null) =>
  list<TenantView>(siteId ? `/sites/${siteId}/tenants` : null);
export const useRoutingRules = (siteId: string | null) =>
  list<RoutingRuleView>(siteId ? `/sites/${siteId}/routing-rules` : null);
export const useQuotas = (siteId: string | null) =>
  list<QuotaView>(siteId ? `/sites/${siteId}/quotas` : null);
export const useExceptions = (siteId: string | null) =>
  list<ExceptionView>(siteId ? `/sites/${siteId}/exceptions` : null);
export const useTimeWindows = (siteId: string | null) =>
  list<TimeWindowPolicyView>(siteId ? `/sites/${siteId}/time-window-policies` : null);
export const useApprovalPolicies = (siteId: string | null) =>
  list<ApprovalPolicyView>(siteId ? `/sites/${siteId}/approval-policies` : null);
export const useContracts = (tenantId: string | null) =>
  list<ContractView>(tenantId ? `/tenants/${tenantId}/contracts` : null);
export const useClauses = (contractId: string | null) =>
  list<ClauseView>(contractId ? `/contracts/${contractId}/clauses` : null);
export const useDockAssignments = (tenantId: string | null) =>
  list<DockAssignmentView>(tenantId ? `/tenants/${tenantId}/dock-assignments` : null);
export const usePedestrianRules = (tenantId: string | null) =>
  list<PedestrianRuleView>(tenantId ? `/tenants/${tenantId}/pedestrian-rules` : null);

/** Незаданные сочетания политик согласования (Q-55). */
export function useApprovalGaps(siteId: string | null) {
  const q = useApi<{ items: ApprovalGap[] }>(
    siteId ? `/sites/${siteId}/approval-policies/missing` : null,
  );
  return { ...q, items: q.data?.items };
}

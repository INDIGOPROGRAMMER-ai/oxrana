import type { CabinetContext } from '@oxrana/contracts';
import { SiteTimeProvider } from '@oxrana/ui';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useApi, useMe } from '../../lib/data';
import { type LiveState, useSiteEvents } from '../../lib/events';

const STORAGE_KEY = 'oxrana.cabinet.tenant';

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface CabinetTenant {
  readonly id: string;
  readonly name: string;
}

interface CabinetValue {
  /** Компании, за которые человек работает (по назначениям ролей на арендатора). */
  readonly tenants: readonly CabinetTenant[];
  readonly tenant: CabinetTenant | null;
  readonly select: (tenantId: string) => void;
  /** Арендатор, объект с поясом и справочники форм; `undefined` — ещё грузится. */
  readonly ctx: CabinetContext | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly live: LiveState;
  /** Сейчас по часам сервера: сверка с часами браузера по ответу `cabinet`. */
  readonly serverNow: () => number;
}

const Cabinet = createContext<CabinetValue | null>(null);

export function useCabinet(): CabinetValue {
  const value = useContext(Cabinet);
  if (!value) throw new Error('useCabinet вне CabinetProvider');
  return value;
}

/** Компании человека из назначений ролей: уникальные арендаторы. */
export function tenantsOf(
  assignments: readonly { tenantId: string | null; tenantName: string | null }[],
): CabinetTenant[] {
  const seen = new Map<string, CabinetTenant>();
  for (const a of assignments) {
    if (a.tenantId && !seen.has(a.tenantId)) {
      seen.set(a.tenantId, { id: a.tenantId, name: a.tenantName ?? 'Компания' });
    }
  }
  return [...seen.values()];
}

/**
 * Кабинет работает за одну выбранную компанию; выбор помнится в браузере. Время во всех экранах — в
 * поясе объекта этой компании с подписью пояса (ADR-009); события объекта обновляют данные без F5.
 */
export function CabinetProvider({ children }: { children: ReactNode }) {
  const { me } = useMe();
  const tenants = useMemo(() => tenantsOf(me?.user?.assignments ?? []), [me]);
  const [chosen, setChosen] = useState<string | null>(readStored);
  const tenant = tenants.find((t) => t.id === chosen) ?? tenants[0] ?? null;
  const select = useCallback((tenantId: string) => {
    setChosen(tenantId);
    try {
      window.localStorage.setItem(STORAGE_KEY, tenantId);
    } catch {
      // хранилище недоступно — выбор действует до перезагрузки
    }
  }, []);
  const query = useApi<CabinetContext>(tenant ? `/tenants/${tenant.id}/cabinet` : null);
  const ctx = query.data;
  const live = useSiteEvents(ctx?.site.id ?? null);
  const settings = useApi<{
    showOwnTime: boolean;
    ownTimezone: string | null;
    ownTimezoneLabel: string | null;
  }>('/me/settings');
  const own =
    settings.data?.showOwnTime && settings.data.ownTimezone
      ? {
          timezone: settings.data.ownTimezone,
          label: settings.data.ownTimezoneLabel ?? settings.data.ownTimezone,
        }
      : null;
  const offset = ctx ? Date.parse(ctx.now) - query.dataUpdatedAt : 0;
  const serverNow = useCallback(() => Date.now() + offset, [offset]);
  const value = useMemo<CabinetValue>(
    () => ({
      tenants,
      tenant,
      select,
      ctx,
      loading: query.isLoading,
      error: query.error,
      live,
      serverNow,
    }),
    [tenants, tenant, select, ctx, query.isLoading, query.error, live, serverNow],
  );
  return (
    <Cabinet.Provider value={value}>
      <SiteTimeProvider
        site={ctx ? { timezone: ctx.site.timezone, label: ctx.site.timezoneLabel } : null}
        own={own}
      >
        {children}
      </SiteTimeProvider>
    </Cabinet.Provider>
  );
}

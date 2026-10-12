import { SiteTimeProvider } from '@oxrana/ui';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { type SiteView, useApi, useSites } from './data';

const STORAGE_KEY = 'oxrana.site';

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface SiteContextValue {
  readonly sites: readonly SiteView[];
  readonly loading: boolean;
  /** Выбранный объект; `null` — объектов ещё нет (чистая база) или список грузится. */
  readonly site: SiteView | null;
  readonly select: (siteId: string) => void;
}

const SiteContext = createContext<SiteContextValue>({
  sites: [],
  loading: true,
  site: null,
  select: () => undefined,
});

/**
 * Выбранный объект админки. Выбор помнится в браузере (если хранилище недоступно — берётся первый
 * объект). Время во всех карточках показывается в поясе выбранного объекта (ADR-009).
 */
export function SiteProvider({ children }: { children: ReactNode }) {
  const { items, isLoading } = useSites();
  const [chosen, setChosen] = useState<string | null>(readStored);
  const sites = items ?? [];
  const site = sites.find((s) => s.id === chosen) ?? sites[0] ?? null;
  const select = useCallback((siteId: string) => {
    setChosen(siteId);
    try {
      window.localStorage.setItem(STORAGE_KEY, siteId);
    } catch {
      // хранилище недоступно — выбор действует до перезагрузки
    }
  }, []);
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
  const value = useMemo(
    () => ({ sites, loading: isLoading, site, select }),
    [sites, isLoading, site, select],
  );
  return (
    <SiteContext.Provider value={value}>
      <SiteTimeProvider
        site={site ? { timezone: site.timezone, label: site.timezoneLabel } : null}
        own={own}
      >
        {children}
      </SiteTimeProvider>
    </SiteContext.Provider>
  );
}

export function useSite(): SiteContextValue {
  return useContext(SiteContext);
}

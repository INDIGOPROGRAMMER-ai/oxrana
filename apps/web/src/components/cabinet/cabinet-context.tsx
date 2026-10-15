import type { CabinetContext, PassFormMine, SitePassContext } from '@oxrana/contracts';
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
  /** Форма пропуска этого пользователя: итог уровней «объект → арендатор → сотрудник» (ADR-023). */
  readonly passForm: PassFormMine | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly live: LiveState;
  /** Сейчас по часам сервера: сверка с часами браузера по ответу `cabinet`. */
  readonly serverNow: () => number;
  /**
   * Страница «Пропуска» админки (7b.2): арендаторы объекта, чьи пропуска видит человек. `null` — обычный
   * кабинет одной компании; тогда `tenant` — эта компания, а у страницы объекта `tenant` пуст.
   */
  readonly allTenants: readonly CabinetTenant[] | null;
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
export function CabinetProvider({
  children,
  forcedTenant,
}: {
  children: ReactNode;
  /** Админка открывает карточку пропуска чужого арендатора: контекст — этого арендатора, а не выбранной компании. */
  forcedTenant?: CabinetTenant | undefined;
}) {
  const { me } = useMe();
  const assigned = useMemo(() => tenantsOf(me?.user?.assignments ?? []), [me]);
  const tenants = useMemo(
    () => (forcedTenant ? [forcedTenant] : assigned),
    [assigned, forcedTenant],
  );
  const [chosen, setChosen] = useState<string | null>(readStored);
  const tenant = forcedTenant ?? tenants.find((t) => t.id === chosen) ?? tenants[0] ?? null;
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
  const formQuery = useApi<PassFormMine>(tenant ? `/tenants/${tenant.id}/pass-form` : null);
  // вложенный контекст админки (карточка пропуска) не открывает ещё один поток событий
  const live = useSiteEvents(forcedTenant ? null : (ctx?.site.id ?? null));
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
      passForm: formQuery.data,
      loading: query.isLoading,
      error: query.error,
      live,
      serverNow,
      allTenants: null,
    }),
    [tenants, tenant, select, ctx, formQuery.data, query.isLoading, query.error, live, serverNow],
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

/** Синтетический контекст «весь объект»: справочники всех арендаторов вместо одной компании. */
function siteContext(c: SitePassContext): CabinetContext {
  return {
    tenant: {
      id: '',
      name: 'Все арендаторы',
      status: 'active',
      isOperator: false,
      trucksDockRequired: false,
      defaultCategoryId: null,
      contractValidTo: null,
    },
    site: c.site,
    categories: c.categories.map((x) => ({ ...x, available: true })),
    zones: c.zones,
    purposes: c.purposes,
    docks: c.docks.map((d) => ({ id: d.id, number: d.number })),
    today: c.today,
    now: c.now,
  };
}

/**
 * Контекст страницы «Пропуска» в админке (7b.2): список пропусков по всем арендаторам объекта
 * переиспользует компоненты кабинета (`PassList`, карточка, статусы), поэтому подаёт им тот же
 * контекст — только с названиями и пояском всего объекта и без «своей» компании. Арендатор правки
 * подставляется отдельно (`CabinetProvider forcedTenant`).
 */
export function SiteCabinetProvider({ siteId, children }: { siteId: string; children: ReactNode }) {
  const query = useApi<SitePassContext>(`/sites/${siteId}/passes/context`);
  const data = query.data;
  const ctx = useMemo(() => (data ? siteContext(data) : undefined), [data]);
  const offset = data ? Date.parse(data.now) - query.dataUpdatedAt : 0;
  const serverNow = useCallback(() => Date.now() + offset, [offset]);
  const allTenants = useMemo(() => data?.tenants ?? [], [data]);
  const value = useMemo<CabinetValue>(
    () => ({
      tenants: [],
      tenant: null,
      select: () => undefined,
      ctx,
      passForm: undefined,
      loading: query.isLoading,
      error: query.error,
      live: 'live',
      serverNow,
      allTenants,
    }),
    [ctx, query.isLoading, query.error, serverNow, allTenants],
  );
  return <Cabinet.Provider value={value}>{children}</Cabinet.Provider>;
}

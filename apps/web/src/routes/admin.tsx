import { AppShell, Button, type NavGroup, Select, Skeleton, ThemeToggle } from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Ban,
  Building2,
  CheckCheck,
  Cpu,
  DoorOpen,
  FileText,
  FlaskConical,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  type LucideIcon,
  ParkingSquare,
  Printer,
  Route as RouteIcon,
  SlidersHorizontal,
  Smartphone,
  Truck,
  Users,
  Wand2,
  Warehouse,
} from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { useApi, useCategories, useGates, useMe } from '../lib/data';
import { useSiteEvents } from '../lib/events';
import { STEPS, useSetupProgress } from '../lib/setup';
import { SiteProvider, useSite } from '../lib/site-context';

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
});

/** Оболочка админки: вход обязателен; меню строится по правам пользователя. */
function AdminLayout() {
  const navigate = useNavigate();
  const { me, isLoading } = useMe();
  useEffect(() => {
    if (me === null) void navigate({ to: '/login' });
  }, [me, navigate]);
  if (isLoading || !me) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-8" role="status" aria-label="Загрузка">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return (
    <SiteProvider>
      <Shell />
    </SiteProvider>
  );
}

function Shell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { me, can } = useMe();
  const { site, sites, select, loading } = useSite();
  const siteId = site?.id ?? null;
  const gates = useGates(siteId);
  const categories = useCategories(siteId, true);
  const { progress } = useSetupProgress(me);
  // События объекта обновляют очередь согласования без F5; подписка — только тем, кому она разрешена
  useSiteEvents(site && (can('pass.view_all_tenants') || can('occupancy.view')) ? site.id : null);
  const pending = useApi<{ items: unknown[] }>(
    site && can('pass.approve') ? `/sites/${site.id}/approvals` : null,
  );
  const pendingCount = pending.data?.items.length ?? 0;

  const noSite = site === null ? 'Сначала создайте объект (мастер настройки, шаг 1)' : undefined;
  const noRoutesBase =
    (gates.items?.length ?? 0) === 0 || (categories.items ?? []).every((c) => !c.enabled)
      ? 'Сначала добавьте КПП и включите типы транспорта'
      : undefined;
  const doneCount = STEPS.filter((s) => progress[s.slug]?.state === 'done').length;

  const item = (
    permission: string | readonly string[],
    value: {
      href: string;
      label: string;
      icon: LucideIcon;
      badge?: string;
      disabledReason?: string | undefined;
    },
  ) => {
    const needed = typeof permission === 'string' ? [permission] : permission;
    if (!needed.some((p) => can(p))) return [];
    const { disabledReason, ...rest } = value;
    return [{ ...rest, ...(disabledReason ? { disabledReason } : {}) }];
  };

  const nav: NavGroup[] = [
    {
      items: [
        { href: '/admin', label: 'Обзор', icon: LayoutDashboard },
        ...item('site.manage', {
          href: '/admin/setup',
          label: 'Мастер настройки',
          icon: Wand2,
          badge: `${doneCount}/${STEPS.length}`,
        }),
      ],
    },
    {
      title: 'Объект',
      items: [
        ...item('site.manage', {
          href: site ? `/admin/sites/${site.id}` : '/admin/setup/site',
          label: 'Объект',
          icon: Building2,
        }),
        ...item('site.manage', {
          href: '/admin/gates',
          label: 'КПП',
          icon: DoorOpen,
          disabledReason: noSite,
        }),
        ...item('site.manage', {
          href: '/admin/categories',
          label: 'Типы транспорта',
          icon: Truck,
          disabledReason: noSite,
        }),
        ...item('rule.manage', {
          href: '/admin/routing',
          label: 'Маршруты',
          icon: RouteIcon,
          disabledReason: noSite ?? noRoutesBase,
        }),
        ...item('site.manage', {
          href: '/admin/docks',
          label: 'Доки и зоны',
          icon: Warehouse,
          disabledReason: noSite,
        }),
      ],
    },
    ...(can('pass.approve')
      ? [
          {
            title: 'Пропуска',
            items: [
              {
                href: '/admin/approvals',
                label: 'Согласование',
                icon: CheckCheck,
                ...(pendingCount > 0 ? { badge: String(pendingCount) } : {}),
                ...(noSite ? { disabledReason: noSite } : {}),
              },
            ],
          },
        ]
      : []),
    {
      title: 'Арендаторы и правила',
      items: [
        ...item('tenant.manage', {
          href: '/admin/tenants',
          label: 'Арендаторы',
          icon: Layers,
          disabledReason: noSite,
        }),
        ...item('pass_form.manage', {
          href: '/admin/pass-form',
          label: 'Настройка формы',
          icon: SlidersHorizontal,
          disabledReason: noSite,
        }),
        ...item('rule.manage', {
          href: '/admin/policies',
          label: 'Политики',
          icon: FileText,
          disabledReason: noSite,
        }),
        ...item('blacklist.manage', {
          href: '/admin/blacklist',
          label: 'Чёрный список',
          icon: Ban,
          disabledReason: noSite,
        }),
        ...item('site.manage', {
          href: '/admin/catalogs',
          label: 'Цели и парковки',
          icon: ParkingSquare,
          disabledReason: noSite,
        }),
      ],
    },
    {
      title: 'Проверка',
      items: [
        ...item('sandbox.use', {
          href: '/admin/sandbox',
          label: 'Песочница правил',
          icon: FlaskConical,
          disabledReason: noSite,
        }),
        ...item(['rule.manage', 'site.manage'], {
          href: '/admin/memo',
          label: 'Памятка КПП',
          icon: Printer,
          disabledReason: noSite,
        }),
      ],
    },
    {
      title: 'Люди и оборудование',
      items: [
        ...item(['user.manage', 'tenant_user.manage'], {
          href: '/admin/users',
          label: 'Пользователи',
          icon: Users,
        }),
        ...item(['role.manage', 'user.manage', 'tenant_user.manage'], {
          href: '/admin/roles',
          label: 'Роли',
          icon: ListChecks,
        }),
        ...item('device.manage', {
          href: '/admin/devices',
          label: 'Устройства КПП',
          icon: Smartphone,
          disabledReason: noSite,
        }),
        ...item('hardware.manage', {
          href: '/admin/hardware',
          label: 'Оборудование',
          icon: Cpu,
          disabledReason: noSite,
        }),
      ],
    },
  ].filter((g) => g.items.length > 0);

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    // данные прежнего пользователя не должны остаться в кэше
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    <AppShell
      brand={<span>Пропускной режим</span>}
      nav={nav}
      currentPath={path}
      topbar={
        <>
          {sites.length > 0 ? (
            <div className="flex min-w-0 items-center gap-2">
              <label htmlFor="site-switch" className="sr-only">
                Объект
              </label>
              <Select
                id="site-switch"
                className="h-8 w-auto max-w-56"
                value={site?.id ?? ''}
                onChange={(e) => select(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              {site ? (
                <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                  время объекта: {site.timezoneLabel}
                </span>
              ) : null}
            </div>
          ) : loading ? null : (
            <span className="text-sm text-muted-foreground">Объект ещё не создан</span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 hidden max-w-48 truncate text-sm text-muted-foreground md:inline">
              {me?.user?.fullName}
            </span>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut aria-hidden /> Выйти
            </Button>
          </div>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

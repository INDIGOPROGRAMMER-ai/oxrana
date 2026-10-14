import { Alert, Button, cn, Select, Skeleton, ThemeToggle, useLinkComponent } from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Car,
  House,
  ListChecks,
  LogOut,
  type LucideIcon,
  Plus,
  Radio,
  SlidersHorizontal,
  Table2,
  Truck,
} from 'lucide-react';
import { useEffect } from 'react';
import { CabinetProvider, tenantsOf, useCabinet } from '../components/cabinet/cabinet-context';
import { NotificationBell } from '../components/cabinet/notification-bell';
import { api } from '../lib/api';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/cabinet')({
  component: CabinetLayout,
});

const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;

/** Кабинет арендатора (этап 7a): отдельно от админки, для людей компаний-арендаторов. */
function CabinetLayout() {
  const navigate = useNavigate();
  const { me, isLoading } = useMe();
  useEffect(() => {
    if (me === null) void navigate({ to: '/login' });
  }, [me, navigate]);
  if (isLoading || !me) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6" role="status" aria-label="Загрузка">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (tenantsOf(me.user?.assignments ?? []).length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <h1 className="text-xl font-semibold">Кабинет арендатора</h1>
        <Alert tone="warning" title="Для вас нет компании в кабинете">
          Кабинет открывается людям, которых пригласили от имени компании-арендатора. Если вы
          сотрудник объекта, настройки и согласование — в админке.
        </Alert>
        <Button asChild>
          <Link to="/">На главную</Link>
        </Button>
      </div>
    );
  }
  return (
    <CabinetProvider>
      <Shell />
    </CabinetProvider>
  );
}

interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

function Shell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { me, can } = useMe();
  const { tenants, tenant, select, ctx, live } = useCabinet();
  const A = useLinkComponent();

  const canCreate = CREATE.some((p) => can(p));
  const nav: NavEntry[] = [
    { href: '/cabinet', label: 'Главная', icon: House },
    ...(can('pass.view') ? [{ href: '/cabinet/passes', label: 'Пропуска', icon: ListChecks }] : []),
    ...(canCreate ? [{ href: '/cabinet/passes/new', label: 'Новый пропуск', icon: Plus }] : []),
    ...(canCreate ? [{ href: '/cabinet/passes/batch', label: 'Несколько', icon: Table2 }] : []),
    ...(can('pass.view') ? [{ href: '/cabinet/fleet', label: 'Автопарк', icon: Truck }] : []),
    ...(can('pass_form.manage_users') || can('pass_form.manage')
      ? [{ href: '/cabinet/pass-form', label: 'Настройка формы', icon: SlidersHorizontal }]
      : []),
  ];
  // Активен самый длинный подходящий пункт: «/cabinet/passes/new» не подсвечивает «Пропуска».
  const active = [...nav]
    .sort((a, b) => b.href.length - a.href.length)
    .find((n) => path === n.href || (n.href !== '/cabinet' && path.startsWith(`${n.href}/`)))?.href;
  const mobile = nav.filter(
    (n) => n.href !== '/cabinet/passes/batch' && n.href !== '/cabinet/pass-form',
  );

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    <div className="min-h-screen bg-background">
      <header
        data-testid="cabinet-header"
        className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur print:hidden"
      >
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
          <Car aria-hidden className="size-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 leading-tight">
            {tenants.length > 1 ? (
              <>
                <label htmlFor="company-switch" className="sr-only">
                  Компания
                </label>
                <Select
                  id="company-switch"
                  className="h-8 max-w-60 font-semibold"
                  value={tenant?.id ?? ''}
                  onChange={(e) => select(e.target.value)}
                >
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <p className="truncate font-semibold" data-testid="company">
                {tenant?.name}
              </p>
            )}
            <p className="truncate text-xs text-muted-foreground" data-testid="site-line">
              {ctx ? `${ctx.site.name} · время объекта: ${ctx.site.timezoneLabel}` : 'Загрузка…'}
            </p>
          </div>
          <span
            role="status"
            title={
              live === 'live'
                ? 'Данные обновляются сами'
                : 'Связи с объектом нет — обновите страницу, если данные не меняются'
            }
            className={cn(
              'hidden items-center gap-1 text-xs sm:inline-flex',
              live === 'live' ? 'text-success' : 'text-muted-foreground',
            )}
          >
            <Radio aria-hidden className="size-3.5" />
            {live === 'live' ? 'обновляется сразу' : 'нет связи'}
          </span>
          <span className="hidden max-w-40 truncate text-sm text-muted-foreground md:inline">
            {me?.user?.fullName}
          </span>
          <NotificationBell />
          <ThemeToggle />
          <Button variant="ghost" size="sm" aria-label="Выйти" onClick={() => void logout()}>
            <LogOut aria-hidden />
            <span className="hidden sm:inline">Выйти</span>
          </Button>
        </div>
        <nav aria-label="Разделы кабинета" className="mx-auto hidden max-w-5xl gap-1 px-4 sm:flex">
          {nav.map((n) => (
            <A
              key={n.href}
              href={n.href}
              className={cn(
                'flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground',
                active === n.href && 'border-primary font-medium text-foreground',
              )}
            >
              <n.icon aria-hidden className="size-4" />
              {n.label}
            </A>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 sm:pb-8">
        <Outlet />
      </main>
      <nav
        aria-label="Разделы кабинета"
        className="fixed inset-x-0 bottom-0 z-30 grid border-t bg-background sm:hidden print:hidden"
        style={{ gridTemplateColumns: `repeat(${mobile.length}, minmax(0, 1fr))` }}
      >
        {mobile.map((n) => (
          <A
            key={n.href}
            href={n.href}
            className={cn(
              'flex min-h-16 flex-col items-center justify-center gap-0.5 px-1 text-xs text-muted-foreground',
              active === n.href && 'font-medium text-primary',
            )}
          >
            <n.icon aria-hidden className="size-5" />
            {n.label}
          </A>
        ))}
      </nav>
    </div>
  );
}

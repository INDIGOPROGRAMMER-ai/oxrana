import { Menu, X } from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useState } from 'react';
import { useLinkComponent } from '../config';
import { cn } from '../lib/cn';
import { Button } from './button';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon?: ComponentType<{ className?: string }>;
  /** Короткая метка справа: «3/11», «!». */
  readonly badge?: ReactNode;
  /** Пункт доступен по правам, но сейчас неактивен: показывается серым с причиной. */
  readonly disabledReason?: string;
}
export interface NavGroup {
  readonly title?: string;
  readonly items: readonly NavItem[];
}

/**
 * Оболочка приложения: слева меню (на телефоне — выезжающее), сверху полоса с переключателем
 * объекта и пользователем. Меню собирает приложение по правам пользователя.
 */
export function AppShell({
  brand,
  nav,
  currentPath,
  topbar,
  children,
}: {
  brand: ReactNode;
  nav: readonly NavGroup[];
  currentPath: string;
  topbar: ReactNode;
  children: ReactNode;
}) {
  const Link = useLinkComponent();
  const [open, setOpen] = useState(false);
  // переход по ссылке закрывает выезжающее меню
  useEffect(() => setOpen(false), [currentPath]);
  const isActive = (href: string) =>
    currentPath === href || (href !== '/admin' && currentPath.startsWith(`${href}/`));
  const menu = (
    <nav aria-label="Разделы" className="flex flex-col gap-4 p-3">
      {nav.map((group, index) => (
        <div key={group.title ?? index} className="space-y-0.5">
          {group.title ? (
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </p>
          ) : null}
          {group.items.map((item) => {
            const Icon = item.icon;
            const body = (
              <>
                {Icon ? <Icon className="size-4 shrink-0" /> : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badge ? (
                  <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                    {item.badge}
                  </span>
                ) : null}
              </>
            );
            if (item.disabledReason) {
              return (
                <span
                  key={item.href}
                  aria-disabled="true"
                  title={item.disabledReason}
                  className="flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground opacity-60"
                >
                  {body}
                </span>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
                  isActive(item.href) && 'bg-accent font-medium text-accent-foreground',
                )}
              >
                {body}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r bg-sidebar lg:block">
        <div className="flex h-14 items-center px-4 font-semibold">{brand}</div>
        {menu}
      </aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Закрыть меню"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-sidebar shadow-xl">
            <div className="flex h-14 items-center justify-between px-4 font-semibold">
              {brand}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Закрыть меню"
                onClick={() => setOpen(false)}
              >
                <X aria-hidden />
              </Button>
            </div>
            {menu}
          </aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Открыть меню"
            onClick={() => setOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">{topbar}</div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

import { Button, ErrorAlert, type ErrorView, errorView, Skeleton } from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { LogOut, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { LoadError } from '../components/common';
import { api } from '../lib/api';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/')({
  component: Home,
});

/** Права, с которыми у пользователя есть что настраивать в админке. */
const ADMIN_PERMISSIONS = [
  'site.manage',
  'tenant.manage',
  'rule.manage',
  'quota.manage',
  'user.manage',
  'device.manage',
] as const;

/** Главная: кто вошёл, куда можно пойти; не вошёл — на вход. */
function Home() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { me, isLoading, error: loadError, refetch, can } = useMe();
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);

  // Люди компаний-арендаторов работают в кабинете; сотрудники объекта и владелец видят эту страницу.
  const assigned = me?.user?.assignments ?? [];
  const tenantOnly = assigned.length > 0 && assigned.every((a) => a.tenantId !== null);
  useEffect(() => {
    if (me === null) void navigate({ to: '/login' });
    else if (me && tenantOnly && can('pass.view')) void navigate({ to: '/cabinet' });
  }, [me, navigate, tenantOnly, can]);

  async function logout(all: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST' });
      await navigate({ to: '/login' });
      client.clear();
    } catch (e) {
      setError(errorView(e));
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <AuthLayout title="Главная">
        <LoadError error={loadError} retry={() => void refetch()} />
      </AuthLayout>
    );
  }
  if (isLoading || !me) {
    return (
      <AuthLayout title="Главная">
        <div role="status" aria-label="Загрузка" className="space-y-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      </AuthLayout>
    );
  }

  const name = me.user?.fullName ?? me.gate?.name ?? '';
  const assignments = me.user?.assignments ?? [];
  const canAdmin = ADMIN_PERMISSIONS.some((p) => can(p));
  // Пользователь арендатора видит свою компанию, а не организацию-оператора платформы.
  const tenantNames = [
    ...new Set(assignments.flatMap((a) => (a.tenantName ? [a.tenantName] : []))),
  ];
  const company = tenantNames.length > 0 ? tenantNames.join(', ') : me.organization.name;
  return (
    <AuthLayout title="Главная" wide>
      <p>
        Вы вошли как <strong>{name}</strong> · {company}
      </p>
      <div className="space-y-2">
        <p className="text-sm font-medium">Ваши роли</p>
        {assignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ролей пока нет — обратитесь к администратору, чтобы вам выдали доступ.
          </p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {assignments.map((a) => (
              <li key={a.id}>
                {a.roleName} — {a.tenantName ?? a.siteName ?? 'вся организация'}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canAdmin ? (
          <Button asChild>
            <Link to="/admin">
              <Settings aria-hidden /> Открыть админку
            </Link>
          </Button>
        ) : (
          <Button disabled>
            <Settings aria-hidden /> Открыть админку
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => void logout(false)}>
          <LogOut aria-hidden /> Выйти
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void logout(true)}>
          Выйти на всех устройствах
        </Button>
      </div>
      {canAdmin ? null : (
        <p className="text-xs text-muted-foreground">
          Админка недоступна: у вашей роли нет прав настройки объекта, арендаторов, правил, лимитов,
          пользователей или устройств.
        </p>
      )}
      {assignments.some((a) => a.tenantId) ? (
        <Button asChild variant="outline">
          <Link to="/cabinet">Открыть кабинет арендатора</Link>
        </Button>
      ) : null}
      <ErrorAlert error={error} />
    </AuthLayout>
  );
}

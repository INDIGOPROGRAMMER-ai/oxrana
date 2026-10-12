import type { Me } from '@oxrana/contracts';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, loadMe } from '../lib/api';
import { ErrorText, Page } from '../lib/ui';

export const Route = createFileRoute('/')({
  component: Home,
});

/** Главная: кто вошёл, куда можно пойти; не вошёл — на вход. */
function Home() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    loadMe()
      .then((m) => {
        if (m === null) void navigate({ to: '/login' });
        else setMe(m);
      })
      .catch(setError);
  }, [navigate]);

  async function logout(all: boolean) {
    try {
      await api(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST' });
      await navigate({ to: '/login' });
    } catch (e) {
      setError(e);
    }
  }

  if (!me) {
    return (
      <Page title="Платформа пропускного режима">
        {error ? <ErrorText error={error} /> : <p>Загрузка…</p>}
      </Page>
    );
  }
  const can = (p: string) => me.permissions.includes(p);
  return (
    <Page title="Платформа пропускного режима">
      <p>
        Вы вошли как <strong>{me.user?.fullName}</strong> · {me.organization.name}
      </p>
      <ul>
        {(me.user?.assignments ?? []).map((a) => (
          <li key={a.id}>
            {a.roleName}
            {a.tenantName
              ? ` — ${a.tenantName}`
              : a.siteName
                ? ` — ${a.siteName}`
                : ' — вся организация'}
          </li>
        ))}
      </ul>
      <nav>
        {can('user.manage') || can('tenant_user.manage') ? (
          <Link to="/admin/users">Пользователи и приглашения</Link>
        ) : null}
        {can('device.manage') ? <Link to="/admin/devices">Устройства КПП</Link> : null}
      </nav>
      <p>Кабинет арендатора и админка появятся на следующих этапах.</p>
      <ErrorText error={error} />
      <p>
        <button type="button" onClick={() => void logout(false)}>
          Выйти
        </button>{' '}
        <button type="button" onClick={() => void logout(true)}>
          Выйти на всех устройствах
        </button>
      </p>
    </Page>
  );
}

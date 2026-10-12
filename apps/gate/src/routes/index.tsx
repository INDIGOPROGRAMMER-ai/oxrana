import type { Me } from '@oxrana/contracts';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { forgetToken, loadToken } from '../lib/device';

export const Route = createFileRoute('/')({
  component: Home,
});

/**
 * Пост открывается в своей учётке КПП без пароля (сценарий 44): токен из IndexedDB. Отозван —
 * токен стирается, экран привязки. Нет связи — пост остаётся в учётке (офлайн — этап 9).
 */
function Home() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await loadToken();
      if (!token) {
        await navigate({ to: '/enroll' });
        return;
      }
      try {
        setMe(await api<Me>('/auth/me', { token }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await forgetToken();
          await navigate({ to: '/enroll', search: { revoked: '1' } });
        } else {
          setOffline(true);
        }
      }
    })();
  }, [navigate]);

  return (
    <main className="page">
      <h1>Пост охраны</h1>
      {me?.gate ? (
        <>
          <p className="status" data-testid="gate-name">
            {me.gate.name}
          </p>
          <p>
            {me.gate.siteName} · устройство «{me.gate.deviceName}»
          </p>
          <p>Устройство привязано. Экран поста со светофором появится на этапе 8.</p>
        </>
      ) : offline ? (
        <p className="error">Нет связи с сервером. Устройство остаётся привязанным.</p>
      ) : (
        <p>Загрузка…</p>
      )}
    </main>
  );
}

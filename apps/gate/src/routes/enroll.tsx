import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { saveToken } from '../lib/device';

export const Route = createFileRoute('/enroll')({
  component: Enroll,
  validateSearch: (search: Record<string, unknown>): { revoked?: string } =>
    typeof search.revoked === 'string' ? { revoked: search.revoked } : {},
});

/**
 * Привязка устройства поста: код из админки (или QR — код приходит в адресе после `#`). Один раз;
 * дальше пост сам не разлогинивается.
 */
function Enroll() {
  const navigate = useNavigate();
  const { revoked } = Route.useSearch();
  const [code, setCode] = useState(() =>
    decodeURIComponent(window.location.hash.replace(/^#/, '')),
  );
  const [name, setName] = useState('ПК поста');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>('/devices/enroll', {
        method: 'POST',
        body: { code, name },
      });
      await saveToken(res.token);
      window.history.replaceState(null, '', window.location.pathname);
      await navigate({ to: '/' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось привязать устройство.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>Привязка устройства поста</h1>
      {revoked ? (
        <p className="error">Устройство отвязано администратором. Попросите новый код.</p>
      ) : null}
      <p>
        Код выдаёт администратор: Устройства КПП → «Привязать устройство». Код действует 10 минут.
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          <span>Код привязки</span>
          <input
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label>
          <span>Название устройства</span>
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          Привязать
        </button>
      </form>
    </main>
  );
}

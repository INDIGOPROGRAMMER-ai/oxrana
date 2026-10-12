import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { api, tokenFromHash } from '../lib/api';
import { ErrorText, Field, Page } from '../lib/ui';

export const Route = createFileRoute('/password')({
  component: SetPassword,
});

interface LinkInfo {
  purpose: 'setup' | 'reset';
  fullName: string;
  expiresAt: string;
}

/** Установка пароля по одноразовой ссылке: владелец после чистого старта, восстановление, сброс. */
function SetPassword() {
  const navigate = useNavigate();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<LinkInfo>('/auth/password/inspect', { method: 'POST', body: { token } })
      .then(setInfo)
      .catch(setError);
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMismatch(password !== repeat);
    if (password !== repeat) return;
    setError(null);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, password } });
      await navigate({ to: '/' });
    } catch (e) {
      setError(e);
    }
  }

  if (!token) {
    return (
      <Page title="Установка пароля">
        <p className="error">Ссылка неполная. Откройте её из сообщения целиком.</p>
      </Page>
    );
  }
  return (
    <Page title={info?.purpose === 'setup' ? 'Добро пожаловать' : 'Новый пароль'}>
      {info ? (
        <form onSubmit={(e) => void submit(e)}>
          <p>{info.fullName}, задайте пароль для входа. Не короче 10 символов, не только цифры.</p>
          <Field label="Новый пароль">
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Field label="Повторите пароль">
            <input
              name="repeat"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
          </Field>
          {mismatch ? <p className="error">Пароли не совпадают.</p> : null}
          <ErrorText error={error} />
          <button type="submit">Сохранить пароль и войти</button>
        </form>
      ) : error ? (
        <>
          <ErrorText error={error} />
          <Link to="/forgot">Запросить новую ссылку</Link>
        </>
      ) : (
        <p>Проверяем ссылку…</p>
      )}
    </Page>
  );
}

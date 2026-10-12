import { Alert, Button, ErrorAlert, type ErrorView, errorView, Field, Input } from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthLayout, fieldErrorOf, generalErrorOf } from '../components/auth-layout';
import { api, tokenFromHash } from '../lib/api';

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
  const client = useQueryClient();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<ErrorView | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<LinkInfo>('/auth/password/inspect', { method: 'POST', body: { token } })
      .then(setInfo)
      .catch((e) => setError(errorView(e)));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMismatch(password !== repeat);
    if (password !== repeat) return;
    setBusy(true);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token, password } });
      client.clear();
      await navigate({ to: '/' });
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout
        title="Установка пароля"
        footer={
          <Link to="/forgot" className="text-sm text-primary underline-offset-4 hover:underline">
            Запросить новую ссылку
          </Link>
        }
      >
        <Alert tone="danger">Ссылка неполная. Откройте её из сообщения целиком.</Alert>
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout
        title="Установка пароля"
        footer={
          error ? (
            <Link to="/forgot" className="text-sm text-primary underline-offset-4 hover:underline">
              Запросить новую ссылку
            </Link>
          ) : undefined
        }
      >
        {error ? (
          <ErrorAlert error={error} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Проверяем ссылку…
          </p>
        )}
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={info.purpose === 'setup' ? 'Добро пожаловать' : 'Новый пароль'}
      description={`${info.fullName}, задайте пароль для входа. Не короче 10 символов, не только цифры.`}
    >
      <form noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
        <Field label="Новый пароль" error={fieldErrorOf(error, 'password')}>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field
          label="Повторите пароль"
          error={mismatch ? { message: 'Пароли не совпадают.' } : null}
        >
          <Input
            name="repeat"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <ErrorAlert error={generalErrorOf(error, 'password')} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Сохранить пароль и войти
        </Button>
      </form>
    </AuthLayout>
  );
}

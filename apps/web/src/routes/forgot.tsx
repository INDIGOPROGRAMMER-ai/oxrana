import { Alert, Button, ErrorAlert, type ErrorView, errorView, Field, Input } from '@oxrana/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthLayout, fieldErrorOf, generalErrorOf } from '../components/auth-layout';
import { api } from '../lib/api';

export const Route = createFileRoute('/forgot')({
  component: Forgot,
});

/** Восстановление пароля: ссылка уходит на e-mail или SMS; ответ одинаков для любого логина. */
function Forgot() {
  const [login, setLogin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setEmpty(false);
    if (!login.trim()) {
      setEmpty(true);
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ message: string }>('/auth/password/forgot', {
        method: 'POST',
        body: { login },
      });
      setMessage(res.message);
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Восстановление пароля"
      description="Укажите e-mail или телефон из учётной записи — мы пришлём ссылку для нового пароля."
      footer={
        <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
          Вернуться ко входу
        </Link>
      }
    >
      {message ? (
        <Alert tone="success">{message}</Alert>
      ) : (
        <form noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
          <Field
            label="E-mail или телефон"
            error={empty ? { message: 'Укажите e-mail или телефон' } : fieldErrorOf(error, 'login')}
          >
            <Input
              name="login"
              autoComplete="username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
            />
          </Field>
          <ErrorAlert error={generalErrorOf(error, 'login')} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Отправить ссылку
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

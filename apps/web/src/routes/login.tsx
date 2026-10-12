import { Alert, Button, ErrorAlert, type ErrorView, errorView, Field, Input } from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthLayout, fieldErrorOf, generalErrorOf } from '../components/auth-layout';
import { api } from '../lib/api';

export const Route = createFileRoute('/login')({
  component: Login,
});

const FIELDS = ['login', 'password', 'code'];

/** Вход по паролю или по коду из e-mail/SMS. Ошибка не подсказывает, есть ли такой логин. */
function Login() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [empty, setEmpty] = useState<'login' | 'password' | 'code' | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  }

  /** Вошли: данные прежнего пользователя в кэше не нужны, «кто я» запрашивается заново. */
  async function enter() {
    client.clear();
    await navigate({ to: '/' });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setEmpty(null);
    if (!login.trim()) {
      setEmpty('login');
      return;
    }
    if (mode === 'password' && !password) {
      setEmpty('password');
      return;
    }
    if (mode === 'code' && codeSent !== null && !code.trim()) {
      setEmpty('code');
      return;
    }
    void run(async () => {
      if (mode === 'password') {
        await api('/auth/login', { method: 'POST', body: { login, password } });
        await enter();
      } else if (codeSent === null) {
        const res = await api<{ message: string }>('/auth/code/request', {
          method: 'POST',
          body: { login },
        });
        setCodeSent(res.message);
      } else {
        await api('/auth/code/verify', { method: 'POST', body: { login, code } });
        await enter();
      }
    });
  }

  function switchMode(next: 'password' | 'code') {
    setMode(next);
    setCodeSent(null);
    setError(null);
    setEmpty(null);
  }

  return (
    <AuthLayout
      title="Вход"
      description="Войдите по e-mail или телефону. Нет учётной записи — попросите приглашение у администратора."
      footer={
        <>
          {mode === 'password' ? (
            <Button variant="link" className="h-auto p-0" onClick={() => switchMode('code')}>
              Войти по коду из e-mail или SMS
            </Button>
          ) : (
            <Button variant="link" className="h-auto p-0" onClick={() => switchMode('password')}>
              Войти по паролю
            </Button>
          )}
          <Link to="/forgot" className="text-sm text-primary underline-offset-4 hover:underline">
            Забыли пароль?
          </Link>
        </>
      }
    >
      <form noValidate className="space-y-4" onSubmit={submit}>
        <Field
          label="E-mail или телефон"
          error={
            empty === 'login'
              ? { message: 'Укажите e-mail или телефон' }
              : fieldErrorOf(error, 'login')
          }
        >
          <Input
            name="login"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </Field>
        {mode === 'password' ? (
          <Field
            label="Пароль"
            error={
              empty === 'password' ? { message: 'Введите пароль' } : fieldErrorOf(error, 'password')
            }
          >
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        ) : codeSent ? (
          <>
            <Alert tone="info">{codeSent}</Alert>
            <Field
              label="Код из сообщения"
              hint="6 цифр, действует 10 минут"
              error={
                empty === 'code'
                  ? { message: 'Введите код из сообщения' }
                  : fieldErrorOf(error, 'code')
              }
            >
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Мы отправим одноразовый код на e-mail или телефон из учётной записи.
          </p>
        )}
        <ErrorAlert error={generalErrorOf(error, ...FIELDS)} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {mode === 'password' ? 'Войти' : codeSent ? 'Войти по коду' : 'Получить код'}
        </Button>
      </form>
    </AuthLayout>
  );
}

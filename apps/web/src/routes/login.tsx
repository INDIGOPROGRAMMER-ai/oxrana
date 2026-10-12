import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, Field, Page } from '../lib/ui';

export const Route = createFileRoute('/login')({
  component: Login,
});

/** Вход по паролю или по коду из e-mail/SMS. Ошибка не подсказывает, есть ли такой логин. */
function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (mode === 'password') {
        await api('/auth/login', { method: 'POST', body: { login, password } });
        await navigate({ to: '/' });
      } else if (codeSent === null) {
        const res = await api<{ message: string }>('/auth/code/request', {
          method: 'POST',
          body: { login },
        });
        setCodeSent(res.message);
      } else {
        await api('/auth/code/verify', { method: 'POST', body: { login, code } });
        await navigate({ to: '/' });
      }
    });
  }

  return (
    <Page title="Вход">
      <form onSubmit={submit}>
        <Field label="E-mail или телефон">
          <input
            name="login"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
          />
        </Field>
        {mode === 'password' ? (
          <Field label="Пароль">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
        ) : codeSent ? (
          <>
            <p className="notice">{codeSent}</p>
            <Field label="Код из сообщения" hint="6 цифр, действует 10 минут">
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </Field>
          </>
        ) : null}
        <ErrorText error={error} />
        <button type="submit" disabled={busy}>
          {mode === 'password' ? 'Войти' : codeSent ? 'Войти по коду' : 'Получить код'}
        </button>
      </form>
      <p>
        {mode === 'password' ? (
          <button type="button" onClick={() => setMode('code')}>
            Войти по коду из e-mail или SMS
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setMode('password');
              setCodeSent(null);
            }}
          >
            Войти по паролю
          </button>
        )}
      </p>
      <p>
        <Link to="/forgot">Забыли пароль?</Link>
      </p>
    </Page>
  );
}

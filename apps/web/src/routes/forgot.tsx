import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, Field, Page } from '../lib/ui';

export const Route = createFileRoute('/forgot')({
  component: Forgot,
});

/** Восстановление пароля: ссылка уходит на e-mail или SMS; ответ одинаков для любого логина. */
function Forgot() {
  const [login, setLogin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const res = await api<{ message: string }>('/auth/password/forgot', {
        method: 'POST',
        body: { login },
      });
      setMessage(res.message);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Page title="Восстановление пароля">
      {message ? (
        <p className="notice">{message}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <Field label="E-mail или телефон">
            <input value={login} onChange={(e) => setLogin(e.target.value)} required />
          </Field>
          <ErrorText error={error} />
          <button type="submit">Отправить ссылку</button>
        </form>
      )}
      <p>
        <Link to="/login">Вернуться ко входу</Link>
      </p>
    </Page>
  );
}

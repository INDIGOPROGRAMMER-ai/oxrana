import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { api, tokenFromHash } from '../lib/api';
import { ErrorText, Field, Page } from '../lib/ui';

export const Route = createFileRoute('/invite')({
  component: Invite,
});

interface InvitationInfo {
  organizationName: string;
  roleName: string;
  siteName: string | null;
  tenantName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  expiresAt: string;
  existingAccount: boolean;
}

/** Приглашение: пароль, согласие на обработку ПДн — и человек сразу работает (ADR-007, D2). */
function Invite() {
  const navigate = useNavigate();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!token) return;
    api<InvitationInfo>('/auth/invitations/inspect', { method: 'POST', body: { token } })
      .then((i) => {
        setInfo(i);
        setFullName(i.fullName ?? '');
      })
      .catch(setError);
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api('/auth/invitations/accept', {
        method: 'POST',
        body: {
          token,
          password,
          consent,
          ...(info?.existingAccount || !fullName ? {} : { fullName }),
        },
      });
      await navigate({ to: '/' });
    } catch (e) {
      setError(e);
    }
  }

  if (!token) {
    return (
      <Page title="Приглашение">
        <p className="error">Ссылка неполная. Откройте её из сообщения целиком.</p>
      </Page>
    );
  }
  if (!info) {
    return (
      <Page title="Приглашение">{error ? <ErrorText error={error} /> : <p>Проверяем…</p>}</Page>
    );
  }
  const where = info.tenantName ?? info.siteName ?? info.organizationName;
  return (
    <Page title="Приглашение">
      <p>
        {info.organizationName} приглашает вас: <strong>{info.roleName}</strong> — {where}.
      </p>
      <p>Логин для входа: {info.email ?? info.phone}.</p>
      <form onSubmit={(e) => void submit(e)}>
        {info.existingAccount ? (
          <p>У вас уже есть учётная запись — введите свой пароль, чтобы принять приглашение.</p>
        ) : (
          <Field label="Фамилия и имя">
            <input
              name="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </Field>
        )}
        <Field
          label={info.existingAccount ? 'Ваш пароль' : 'Придумайте пароль'}
          {...(info.existingAccount ? {} : { hint: 'Не короче 10 символов, не только цифры' })}
        >
          <input
            name="password"
            type="password"
            autoComplete={info.existingAccount ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <label className="field">
          <span>
            <input
              name="consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />{' '}
            Согласен(на) на обработку персональных данных
          </span>
        </label>
        <ErrorText error={error} />
        <button type="submit" disabled={!consent}>
          Принять приглашение
        </button>
        {!consent ? <small> — сначала отметьте согласие</small> : null}
      </form>
    </Page>
  );
}

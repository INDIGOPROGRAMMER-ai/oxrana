import {
  Alert,
  Button,
  Checkbox,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Input,
} from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthLayout, fieldErrorOf, generalErrorOf } from '../components/auth-layout';
import { api, tokenFromHash } from '../lib/api';

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

const FIELDS = ['fullName', 'password', 'consent'];

/** Приглашение: пароль, согласие на обработку ПДн — и человек сразу работает (ADR-007, D2). */
function Invite() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [empty, setEmpty] = useState<'fullName' | 'password' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<InvitationInfo>('/auth/invitations/inspect', { method: 'POST', body: { token } })
      .then((i) => {
        setInfo(i);
        setFullName(i.fullName ?? '');
      })
      .catch((e) => setError(errorView(e)));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setEmpty(null);
    if (!info?.existingAccount && !fullName.trim()) {
      setEmpty('fullName');
      return;
    }
    if (!password) {
      setEmpty('password');
      return;
    }
    setBusy(true);
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
      <AuthLayout title="Приглашение">
        <Alert tone="danger">Ссылка неполная. Откройте её из сообщения целиком.</Alert>
      </AuthLayout>
    );
  }
  if (!info) {
    return (
      <AuthLayout
        title="Приглашение"
        footer={
          error ? (
            <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
              Перейти ко входу
            </Link>
          ) : undefined
        }
      >
        {error ? (
          <ErrorAlert error={error} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Проверяем…
          </p>
        )}
      </AuthLayout>
    );
  }
  const where = info.tenantName ?? info.siteName ?? info.organizationName;
  return (
    <AuthLayout
      title="Приглашение"
      description={
        <>
          {info.organizationName} приглашает вас: <strong>{info.roleName}</strong> — {where}.
        </>
      }
    >
      <p className="text-sm">Логин для входа: {info.email ?? info.phone}.</p>
      <form noValidate className="space-y-4" onSubmit={(e) => void submit(e)}>
        {info.existingAccount ? (
          <p className="text-sm text-muted-foreground">
            У вас уже есть учётная запись — введите свой пароль, чтобы принять приглашение.
          </p>
        ) : (
          <Field
            label="Фамилия и имя"
            error={
              empty === 'fullName'
                ? { message: 'Укажите фамилию и имя' }
                : fieldErrorOf(error, 'fullName')
            }
          >
            <Input
              name="fullName"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
        )}
        <Field
          label={info.existingAccount ? 'Ваш пароль' : 'Придумайте пароль'}
          {...(info.existingAccount ? {} : { hint: 'Не короче 10 символов, не только цифры' })}
          error={
            empty === 'password' ? { message: 'Введите пароль' } : fieldErrorOf(error, 'password')
          }
        >
          <Input
            name="password"
            type="password"
            autoComplete={info.existingAccount ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="space-y-1">
          <Checkbox
            name="consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            label="Согласен(на) на обработку персональных данных"
          />
          {!consent ? (
            <p className="text-xs text-muted-foreground">
              Кнопка станет доступна, когда вы отметите согласие.
            </p>
          ) : null}
          {fieldErrorOf(error, 'consent') ? (
            <p role="alert" className="text-xs text-destructive">
              {error?.message}
            </p>
          ) : null}
        </div>
        <ErrorAlert error={generalErrorOf(error, ...FIELDS)} />
        <Button type="submit" className="w-full" disabled={!consent || busy}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Принять приглашение
        </Button>
      </form>
    </AuthLayout>
  );
}

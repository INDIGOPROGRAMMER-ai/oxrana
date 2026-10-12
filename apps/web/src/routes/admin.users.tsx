import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorText, Field, fieldOf, Page } from '../lib/ui';

export const Route = createFileRoute('/admin/users')({
  component: Users,
});

interface Role {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}
interface Tenant {
  id: string;
  shortName: string;
}
interface UserRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  assignments: {
    id: string;
    roleName: string;
    siteName: string | null;
    tenantName: string | null;
  }[];
}
interface Invitation {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  roleName: string;
  status: string;
}

const STATUS: Record<string, string> = {
  pending: 'ждёт ответа',
  accepted: 'принято',
  expired: 'истекло',
  revoked: 'отозвано',
};

/**
 * Пользователи и приглашения (простой экран этапа 5): пригласить человека с ролью и областью.
 * Ссылка приглашения показывается один раз — пока нет доставки по e-mail и SMS, её передают сами.
 */
function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [form, setForm] = useState({
    email: '',
    phone: '',
    fullName: '',
    roleId: '',
    siteId: '',
    tenantId: '',
  });
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    const [u, i, r, s] = await Promise.all([
      api<{ items: UserRow[] }>('/users'),
      api<{ items: Invitation[] }>('/invitations'),
      api<{ items: Role[] }>('/roles'),
      api<{ items: Site[] }>('/sites'),
    ]);
    setUsers(u.items);
    setInvitations(i.items);
    setRoles(r.items);
    setSites(s.items);
  }, []);

  useEffect(() => {
    reload().catch(setError);
  }, [reload]);

  useEffect(() => {
    if (!form.siteId) {
      setTenants([]);
      return;
    }
    api<{ items: Tenant[] }>(`/sites/${form.siteId}/tenants`)
      .then((r) => setTenants(r.items))
      .catch(setError);
  }, [form.siteId]);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLink(null);
    try {
      const res = await api<{ link: string }>('/invitations', {
        method: 'POST',
        body: {
          ...(form.email ? { email: form.email } : {}),
          ...(form.phone ? { phone: form.phone } : {}),
          ...(form.fullName ? { fullName: form.fullName } : {}),
          roleId: form.roleId,
          ...(form.siteId ? { siteId: form.siteId } : {}),
          ...(form.tenantId ? { tenantId: form.tenantId } : {}),
        },
      });
      setLink(res.link);
      await reload();
    } catch (e) {
      setError(e);
    }
  }

  const invalid = fieldOf(error);
  return (
    <Page title="Пользователи и приглашения">
      <p>
        <Link to="/">← На главную</Link>
      </p>
      <h2>Пригласить</h2>
      <form onSubmit={(e) => void invite(e)}>
        <Field label="E-mail" hint="или телефон — хотя бы одно">
          <input
            name="email"
            type="email"
            value={form.email}
            aria-invalid={invalid === 'email'}
            onChange={(e) => set('email')(e.target.value)}
          />
        </Field>
        <Field label="Телефон">
          <input name="phone" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
        </Field>
        <Field label="Фамилия и имя">
          <input
            name="fullName"
            value={form.fullName}
            onChange={(e) => set('fullName')(e.target.value)}
          />
        </Field>
        <Field label="Роль">
          <select
            name="roleId"
            value={form.roleId}
            onChange={(e) => set('roleId')(e.target.value)}
            required
          >
            <option value="">— выберите —</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Объект" hint="пусто — вся организация">
          <select name="siteId" value={form.siteId} onChange={(e) => set('siteId')(e.target.value)}>
            <option value="">Вся организация</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Арендатор" hint="для ролей арендатора">
          <select
            name="tenantId"
            value={form.tenantId}
            onChange={(e) => set('tenantId')(e.target.value)}
            disabled={tenants.length === 0}
            title={tenants.length === 0 ? 'Сначала выберите объект' : undefined}
          >
            <option value="">—</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.shortName}
              </option>
            ))}
          </select>
        </Field>
        <ErrorText error={error} />
        <button type="submit">Пригласить</button>
      </form>
      {link ? (
        <div role="status">
          <p className="notice">
            Приглашение создано. Передайте человеку ссылку (действует 7 дней, один раз). Она
            показывается только сейчас.
          </p>
          <p>
            <input aria-label="Ссылка приглашения" readOnly value={link} size={60} />{' '}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link)}>
              Копировать
            </button>
          </p>
        </div>
      ) : null}

      <h2>Пользователи</h2>
      <table>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.fullName}</td>
              <td>{u.email ?? u.phone}</td>
              <td>
                {u.assignments
                  .map(
                    (a) =>
                      `${a.roleName}${a.tenantName ? ` — ${a.tenantName}` : a.siteName ? ` — ${a.siteName}` : ''}`,
                  )
                  .join('; ')}
              </td>
              <td>{u.status === 'active' ? 'работает' : 'отключён'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Приглашения</h2>
      <table>
        <tbody>
          {invitations.map((i) => (
            <tr key={i.id}>
              <td>{i.fullName ?? '—'}</td>
              <td>{i.email ?? i.phone}</td>
              <td>{i.roleName}</td>
              <td>{STATUS[i.status] ?? i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

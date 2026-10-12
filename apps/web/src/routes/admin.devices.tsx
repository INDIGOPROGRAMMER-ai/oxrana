import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { renderSVG } from 'uqr';
import { api } from '../lib/api';
import { ErrorText, Field, Page, siteTime } from '../lib/ui';

export const Route = createFileRoute('/admin/devices')({
  component: Devices,
});

interface Site {
  id: string;
  name: string;
  timezone: string;
  timezoneLabel: string;
}
interface Device {
  id: string;
  name: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}
interface Account {
  id: string;
  gateName: string;
  status: string;
  devices: Device[];
}
interface Enrollment {
  code: string;
  enrollUrl: string;
  expiresAt: string;
}

/**
 * Устройства КПП (простой экран этапа 5): учётка КПП = КПП; «Привязать устройство» даёт код и QR
 * на 10 минут; «Отозвать» действует сразу. Полноценный экран — на этапе админки.
 */
function Devices() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [enrollment, setEnrollment] = useState<{ account: string; data: Enrollment } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ items: Site[] }>('/sites')
      .then((r) => {
        setSites(r.items);
        setSiteId((current) => current || r.items[0]?.id || '');
      })
      .catch(setError);
  }, []);

  const reload = useCallback(async () => {
    if (!siteId) return;
    const res = await api<{ items: Account[] }>(`/sites/${siteId}/gate-accounts`);
    setAccounts(res.items);
  }, [siteId]);

  useEffect(() => {
    reload().catch(setError);
  }, [reload]);

  async function enroll(account: Account) {
    setError(null);
    try {
      const data = await api<Enrollment>(`/gate-accounts/${account.id}/enrollments`, {
        method: 'POST',
        body: {},
      });
      setEnrollment({ account: account.gateName, data });
    } catch (e) {
      setError(e);
    }
  }

  async function revoke(device: Device) {
    const reason = window.prompt(`Почему отзываем «${device.name}»? Причина попадёт в журнал.`);
    if (!reason) return;
    setError(null);
    try {
      await api(`/gate-devices/${device.id}/revoke`, { method: 'POST', body: { reason } });
      await reload();
    } catch (e) {
      setError(e);
    }
  }

  const site = sites.find((s) => s.id === siteId);
  const time = (iso: string) => (site ? siteTime(iso, site.timezone, site.timezoneLabel) : iso);
  return (
    <Page title="Устройства КПП">
      <p>
        <Link to="/">← На главную</Link>
      </p>
      {sites.length === 0 ? (
        <p>Объектов пока нет — устройства привязываются к КПП объекта.</p>
      ) : (
        <Field label="Объект">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <ErrorText error={error} />
      {enrollment ? (
        <section aria-label="Код привязки">
          <h2>Привязка устройства: {enrollment.account}</h2>
          <p>
            На устройстве поста откройте приложение поста и введите код или отсканируйте QR. Код
            одноразовый, действует до {time(enrollment.data.expiresAt)}.
          </p>
          <p className="code" data-testid="enrollment-code">
            {enrollment.data.code}
          </p>
          <div
            className="qr"
            // SVG строит uqr из адреса привязки локально; внешних данных в нём нет.
            dangerouslySetInnerHTML={{ __html: renderSVG(enrollment.data.enrollUrl) }}
          />
          <p>
            <a href={enrollment.data.enrollUrl} data-testid="enrollment-link">
              {enrollment.data.enrollUrl}
            </a>
          </p>
          <button type="button" onClick={() => setEnrollment(null)}>
            Готово
          </button>
        </section>
      ) : null}
      {accounts.map((a) => (
        <section key={a.id}>
          <h2>{a.gateName}</h2>
          <button
            type="button"
            onClick={() => void enroll(a)}
            disabled={a.status !== 'active'}
            title={a.status !== 'active' ? 'Учётка КПП отключена' : undefined}
          >
            Привязать устройство
          </button>
          <table>
            <tbody>
              {a.devices.length === 0 ? (
                <tr>
                  <td>Устройств пока нет</td>
                </tr>
              ) : null}
              {a.devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>привязано {time(d.enrolledAt)}</td>
                  <td>{d.lastSeenAt ? `на связи ${time(d.lastSeenAt)}` : ''}</td>
                  <td>
                    {d.revokedAt ? (
                      `отозвано: ${d.revokeReason ?? ''}`
                    ) : (
                      <button type="button" onClick={() => void revoke(d)}>
                        Отозвать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Page>
  );
}

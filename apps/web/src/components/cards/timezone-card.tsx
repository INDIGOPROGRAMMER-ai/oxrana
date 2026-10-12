import { ReasonSchema } from '@oxrana/contracts';
import {
  Alert,
  Button,
  ErrorAlert,
  errorView,
  Field,
  Input,
  Section,
  Select,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi, useMutate } from '../../lib/data';
import { useSite } from '../../lib/site-context';

interface Zones {
  zones: { id: string; label: string }[];
}

/**
 * Смена пояса объекта (ADR-009, дополнение): отдельное действие с причиной и подтверждением
 * последствий. Первый запрос без `confirm` возвращает текст последствий — его показываем и просим
 * подтвердить; в аудит попадает «было → стало» и причина.
 */
export function TimezoneChangeCard() {
  const { site } = useSite();
  const zones = useApi<Zones>('/timezones');
  const mutate = useMutate();
  const toast = useToast();
  const [timezone, setTimezone] = useState('');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [consequences, setConsequences] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<ReturnType<typeof errorView> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!site) return null;

  async function submit(confirm: boolean) {
    setError(null);
    const parsed = ReasonSchema.safeParse(reason);
    if (!parsed.success) {
      setReasonError(parsed.error.issues[0]?.message ?? 'Укажите причину');
      return;
    }
    setReasonError(null);
    setBusy(true);
    try {
      await mutate(`/sites/${site?.id}/timezone`, 'POST', {
        timezone,
        reason: parsed.data,
        ...(confirm ? { confirm: true } : {}),
      });
      toast('Часовой пояс изменён');
      setDone(true);
      setConsequences(null);
    } catch (e) {
      const view = errorView(e);
      if (view.code === 'confirmation_required') setConsequences(view.message);
      else setError(view);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Alert tone="success" title="Часовой пояс изменён">
        Теперь время объекта показывается в новом поясе.{' '}
        <Link
          to="/admin/sites/$siteId"
          params={{ siteId: site.id }}
          className="font-medium underline"
        >
          К карточке объекта
        </Link>
      </Alert>
    );
  }
  return (
    <Section
      title="Смена часового пояса"
      description={`Сейчас: ${site.timezoneLabel}. Прошлые записи хранятся в UTC и не меняются, но на экранах будут показаны в новом поясе.`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <Field label="Новый пояс" required>
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <option value="">— выберите —</option>
            {(zones.data?.zones ?? [])
              .filter((z) => z.id !== site.timezone)
              .map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
          </Select>
        </Field>
        <Field
          label="Причина"
          required
          hint="Попадёт в журнал изменений."
          error={reasonError ? { message: reasonError } : null}
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {consequences ? (
          <Alert tone="warning" title="Последствия смены пояса">
            <p>{consequences}</p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              Понимаю последствия
            </label>
          </Alert>
        ) : null}
        <ErrorAlert error={error} />
        <div className="flex gap-2">
          {consequences ? (
            <Button disabled={!understood || busy} onClick={() => void submit(true)}>
              Сменить пояс
            </Button>
          ) : (
            <Button type="submit" disabled={!timezone || busy}>
              Далее: показать последствия
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link to="/admin/sites/$siteId" params={{ siteId: site.id }}>
              Отмена
            </Link>
          </Button>
        </div>
      </form>
    </Section>
  );
}

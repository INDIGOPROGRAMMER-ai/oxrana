import {
  TENANT_BLOCK_MODE_HELP,
  TENANT_BLOCK_MODE_LABEL,
  TENANT_BLOCK_MODES,
  type TenantBlockImpactSchema,
  type TenantBlockMode,
} from '@oxrana/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  SiteTime,
  Textarea,
  useToast,
} from '@oxrana/ui';
import { Ban, Loader2, LockOpen } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { type TenantView, useApi, useMe, useMutate } from '../../lib/data';
import { TenantStatusBadge } from './tenant-shared';

type Impact = z.infer<typeof TenantBlockImpactSchema>;

/**
 * Блокировка арендатора с последствиями (этап 6b): три режима, причина обязательна, а перед
 * подтверждением видно, сколько людей и машин сейчас внутри и сколько пропусков перестанут
 * работать. Выезд разрешён всегда — заблокированные могут уехать.
 */
export function TenantBlockSection({ tenant }: { tenant: TenantView }) {
  const { can } = useMe();
  const allowed = can('tenant.block');
  const [dialog, setDialog] = useState<'block' | 'unblock' | null>(null);
  const blocked = tenant.status !== 'active' && tenant.status !== 'archived';
  const archived = tenant.status === 'archived';
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Статус</h3>
        <TenantStatusBadge status={tenant.status} />
        {blocked && tenant.statusChangedAt ? (
          <span className="text-xs text-muted-foreground">
            с <SiteTime value={tenant.statusChangedAt} />
          </span>
        ) : null}
      </div>
      {blocked && tenant.statusReason ? (
        <p className="text-sm">
          Причина: <span className="font-medium">{tenant.statusReason}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Блокировка не отменяет пропуска: после снятия всё работает как раньше. Выезд разрешён
        всегда.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {blocked ? (
          <Button variant="outline" disabled={!allowed} onClick={() => setDialog('unblock')}>
            <LockOpen aria-hidden /> Снять блокировку…
          </Button>
        ) : null}
        <Button
          variant={blocked ? 'ghost' : 'destructive'}
          disabled={!allowed || archived}
          onClick={() => setDialog('block')}
        >
          <Ban aria-hidden /> {blocked ? 'Изменить режим…' : 'Заблокировать…'}
        </Button>
        {!allowed ? (
          <span className="text-xs text-warning">
            Блокировать может пользователь с правом «Блокировка и разблокировка арендатора».
          </span>
        ) : archived ? (
          <span className="text-xs text-warning">Арендатор в архиве: блокировать нечего.</span>
        ) : null}
      </div>
      <BlockDialog
        tenant={tenant}
        open={dialog === 'block'}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      <UnblockDialog
        tenant={tenant}
        open={dialog === 'unblock'}
        onOpenChange={(o) => !o && setDialog(null)}
      />
    </div>
  );
}

function BlockDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const [mode, setMode] = useState<TenantBlockMode>('entry');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const impact = useApi<Impact>(open ? `/tenants/${tenant.id}/block-impact?mode=${mode}` : null);
  const reasonOk = reason.trim().length >= 3;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/tenants/${tenant.id}/block`, 'POST', {
        mode,
        reason: reason.trim(),
        confirm: true,
      });
      toast(`${tenant.shortName}: ${TENANT_BLOCK_MODE_LABEL[mode].toLowerCase()}`);
      setReason('');
      onOpenChange(false);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Заблокировать: {tenant.shortName}</DialogTitle>
          <DialogDescription>
            Выберите режим и укажите причину — она попадёт в журнал. Выезд остаётся свободным.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Режим</legend>
          {TENANT_BLOCK_MODES.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="block-mode"
                className="mt-1"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>
                <span className="font-medium">{TENANT_BLOCK_MODE_LABEL[m]}</span>
                <span className="block text-xs text-muted-foreground">
                  {TENANT_BLOCK_MODE_HELP[m]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field
          label="Причина"
          required
          hint="Например: задолженность по аренде, нарушения на территории."
        >
          <Textarea
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Alert
          tone={impact.data && impact.data.willStopWorking > 0 ? 'warning' : 'info'}
          title="Что произойдёт"
        >
          {impact.isLoading || !impact.data ? (
            <span role="status">Считаем последствия…</span>
          ) : (
            impact.data.summary
          )}
        </Alert>
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !reasonOk || !impact.data}
            onClick={() => void confirm()}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Подтвердить блокировку
          </Button>
        </DialogFooter>
        {reasonOk ? null : (
          <p className="text-xs text-muted-foreground">Укажите причину (не короче 3 символов).</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UnblockDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const reasonOk = reason.trim().length >= 3;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/tenants/${tenant.id}/unblock`, 'POST', { reason: reason.trim() });
      toast(`${tenant.shortName}: блокировка снята`);
      setReason('');
      onOpenChange(false);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Снять блокировку: {tenant.shortName}</DialogTitle>
          <DialogDescription>
            Пропуска, которые перестали работать из-за блокировки, заработают снова.
          </DialogDescription>
        </DialogHeader>
        <Field label="Причина" required hint="Что изменилось: долг погашен, вопрос решён.">
          <Textarea
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={busy || !reasonOk} onClick={() => void confirm()}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Снять блокировку
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

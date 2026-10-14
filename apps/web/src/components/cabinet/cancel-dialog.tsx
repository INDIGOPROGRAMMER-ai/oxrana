import type { PassView } from '@oxrana/contracts';
import {
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
  Textarea,
  useToast,
} from '@oxrana/ui';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useMutate } from '../../lib/data';
import { passTitle } from '../../lib/pass-text';

/** Отмена своего пропуска с причиной (она попадёт в журнал и будет видна в карточке). */
export function CancelPassDialog({
  pass,
  onClose,
}: {
  pass: PassView | null;
  onClose: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  async function cancel() {
    if (!pass) return;
    if (reason.trim().length < 3) {
      setError({
        message: 'Причина — хотя бы 3 символа.',
        field: 'reason',
        settingLink: null,
        code: null,
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await mutate(`/passes/${pass.id}/cancel`, 'POST', { reason: reason.trim() });
      toast(`Пропуск ${passTitle(pass)} отменён`);
      setReason('');
      onClose();
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={pass !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Отменить пропуск {pass ? passTitle(pass) : ''}?</DialogTitle>
          <DialogDescription>
            Отменённый пропуск восстановить нельзя — при необходимости оформите новый.
          </DialogDescription>
        </DialogHeader>
        <Field label="Причина отмены" required>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </Field>
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Не отменять
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void cancel()}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Отменить пропуск
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

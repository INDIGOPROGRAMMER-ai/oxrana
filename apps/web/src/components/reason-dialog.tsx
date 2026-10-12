import { ReasonSchema } from '@oxrana/contracts';
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
} from '@oxrana/ui';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

/**
 * Диалог действия «с причиной» (отключить, отозвать): причина обязательна — не короче 3 символов —
 * и попадает в журнал аудита. Окно закрывается только после успешного ответа сервера; ошибка
 * остаётся в окне: у поля, если она про причину, иначе баннером со ссылкой на настройку.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [fieldMessage, setFieldMessage] = useState<string | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);

  function change(next: boolean) {
    if (busy) return;
    if (!next) {
      setReason('');
      setFieldMessage(null);
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit() {
    if (busy) return;
    setError(null);
    const parsed = ReasonSchema.safeParse(reason);
    if (!parsed.success) {
      setFieldMessage(parsed.error.issues[0]?.message ?? 'Укажите причину');
      return;
    }
    setFieldMessage(null);
    setBusy(true);
    try {
      await onConfirm(parsed.data);
      setBusy(false);
      setReason('');
      onOpenChange(false);
    } catch (raw) {
      setBusy(false);
      const view = errorView(raw);
      if (view.field === 'reason') setFieldMessage(view.message);
      else setError(view);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Причина"
            hint="Хотя бы 3 символа. Причина попадёт в журнал: кто, когда и почему."
            error={fieldMessage ? { message: fieldMessage } : null}
          >
            <Textarea
              name="reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <ErrorAlert error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => change(false)}>
              Отмена
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

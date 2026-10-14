import type { PassBatchResultSchema } from '@oxrana/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ErrorAlert,
  type ErrorView,
  errorView,
  formatLocalDate,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { History, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useMutate } from '../../lib/data';
import { addDays } from '../../lib/dates';
import { useCabinet } from './cabinet-context';

type Result = z.infer<typeof PassBatchResultSchema>;

/**
 * «Повторить вчерашний день» (08_): разовые пропуска вчерашнего дня создаются заново на сегодня, с
 * теми же часами. Сначала проверка без сохранения — человек видит, что пройдёт, и подтверждает.
 */
export function RepeatDay() {
  const { tenant, ctx } = useCabinet();
  const mutate = useMutate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  // Q-80: сдвиг начала прошедших на «сейчас» — только по нажатию, без молчаливых подмен
  const [shiftPast, setShiftPast] = useState(false);
  const source = ctx ? addDays(ctx.today, -1) : '';
  const body = {
    sourceDate: source,
    targetDate: ctx?.today ?? '',
    ...(shiftPast ? { shiftPastToNow: true } : {}),
  };
  const preview = useQuery({
    queryKey: ['hints', tenant?.id, 'repeat', source, open, shiftPast],
    queryFn: () =>
      api<Result>(`/tenants/${tenant?.id}/passes/repeat`, {
        method: 'POST',
        body: { ...body, dryRun: true },
      }),
    enabled: open && Boolean(tenant && ctx),
    gcTime: 0,
  });
  const result = preview.data;

  async function create() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      const made = await mutate<Result>(`/tenants/${tenant.id}/passes/repeat`, 'POST', body);
      setDone(made);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setDone(null);
          setError(null);
          setShiftPast(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <History aria-hidden /> Повторить вчерашний день
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Повторить вчерашний день</DialogTitle>
          <DialogDescription>
            Разовые пропуска за {source ? formatLocalDate(source) : 'вчера'} будут оформлены заново
            на сегодня с теми же часами.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <Alert
            tone={done.errors.length > 0 ? 'warning' : 'success'}
            title={done.summary}
            data-testid="repeat-done"
          >
            {done.errors.length > 0 ? (
              <ul className="list-disc pl-4">
                {done.errors.map((e) => (
                  <li key={`${e.row}-${e.message}`}>
                    строка {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : preview.isLoading ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Проверяем…
          </p>
        ) : preview.error ? (
          <ErrorAlert error={errorView(preview.error)} />
        ) : result ? (
          <div className="space-y-2" data-testid="repeat-preview">
            <p className="text-sm font-medium">{result.summary}</p>
            {result.errors.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {result.errors.map((e) => (
                  <li
                    key={`${e.row}-${e.message}`}
                    data-code={e.code}
                    className={e.code === 'starts_in_past' ? 'text-warning' : 'text-destructive'}
                  >
                    строка {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {!shiftPast && result.errors.some((e) => e.code === 'starts_in_past') ? (
              <Button variant="outline" size="sm" onClick={() => setShiftPast(true)}>
                Сдвинуть начало прошедших на «сейчас»
              </Button>
            ) : null}
            {shiftPast ? (
              <p className="text-xs text-muted-foreground">
                Пропуска, чьё начало уже прошло, начнутся «сейчас».{' '}
                <button type="button" className="underline" onClick={() => setShiftPast(false)}>
                  Не сдвигать
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {done ? 'Закрыть' : 'Не повторять'}
          </Button>
          {done ? null : (
            <Button
              disabled={busy || !result || result.created === 0}
              onClick={() => void create()}
            >
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
              Создать пропуска: {result?.created ?? 0}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

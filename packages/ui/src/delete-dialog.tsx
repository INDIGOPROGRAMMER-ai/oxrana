import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type ErrorView, errorView } from './api';
import { ErrorAlert } from './components/alert';
import { Button } from './components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/dialog';

export interface Usage {
  readonly table: string;
  readonly label: string;
  readonly count: number;
}

/**
 * Мягкое удаление справочника с показом, где он используется (CLAUDE.md п. 10): «используется в
 * правилах маршрута — 4, назначениях доков — 2». Список загружается при открытии; пока он не
 * загружен, удалить нельзя. Если ссылки есть, нужно явное подтверждение — история сохраняется.
 */
export function DeleteDialog({
  open,
  onOpenChange,
  title,
  name,
  loadUsages,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** «Удалить КПП?» */
  title: string;
  /** Название записи: «КПП «Въезд 1»». */
  name: string;
  loadUsages: () => Promise<readonly Usage[]>;
  /** Удалить; `confirm` — подтверждено, что ссылки есть и история сохранится. */
  onDelete: (confirm: boolean) => Promise<void>;
}) {
  const [usages, setUsages] = useState<readonly Usage[] | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsages(null);
    setError(null);
    let cancelled = false;
    loadUsages()
      .then((u) => !cancelled && setUsages(u))
      .catch((e: unknown) => !cancelled && setError(errorView(e)));
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function remove() {
    if (!usages) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(usages.length > 0);
      onOpenChange(false);
    } catch (e) {
      setError(errorView(e));
    } finally {
      setBusy(false);
    }
  }

  const inUse = usages !== null && usages.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        {usages === null && !error ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Проверяем, где используется…
          </p>
        ) : null}
        {usages !== null && !inUse ? (
          <p className="text-sm">Нигде не используется. Запись будет удалена.</p>
        ) : null}
        {inUse ? (
          <div className="space-y-2 text-sm" data-testid="usages">
            <p className="font-medium">Используется:</p>
            <ul className="list-disc pl-5">
              {usages.map((u) => (
                <li key={u.table}>
                  {u.label} — {u.count}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Удаление мягкое: история и прежние записи сохранятся, но в новых настройках запись
              больше не предлагается.
            </p>
          </div>
        ) : null}
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={usages === null || busy}
            onClick={() => void remove()}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {inUse ? 'Всё равно удалить' : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

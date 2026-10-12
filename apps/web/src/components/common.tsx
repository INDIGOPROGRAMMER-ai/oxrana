import { Alert, Button, DeleteDialog, EmptyState, type Usage, useToast } from '@oxrana/ui';
import { Loader2, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api } from '../lib/api';
import { type SiteView, useMutate } from '../lib/data';
import { useSite } from '../lib/site-context';

/** Карточке нужен объект: пока его нет — понятное предупреждение, куда идти. */
export function RequireSite({ children }: { children: (site: SiteView) => ReactNode }) {
  const { site, loading } = useSite();
  if (loading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Загрузка…
      </p>
    );
  }
  if (!site) {
    return (
      <Alert tone="warning" title="Объект ещё не создан">
        Начните с мастера настройки: первый шаг — название, адрес и часовой пояс объекта.
      </Alert>
    );
  }
  return <>{children(site)}</>;
}

/**
 * Кнопка «Удалить» справочника: диалог показывает, где запись используется (CLAUDE.md п. 10);
 * `collection` — сегмент пути API (`gates`, `zones`, `docks`…).
 */
export function DeleteAction({
  collection,
  id,
  name,
  title,
  disabledReason,
}: {
  collection: string;
  id: string;
  /** Как назвать запись в диалоге: «КПП «Въезд 1»». */
  name: string;
  title: string;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const mutate = useMutate();
  const toast = useToast();
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Удалить: ${name}`}
        title={disabledReason ?? 'Удалить'}
        disabled={Boolean(disabledReason)}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden className="text-destructive" />
      </Button>
      <DeleteDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        name={name}
        loadUsages={async () => {
          const res = await api<{ usages: Usage[] }>(`/${collection}/${id}/usages`);
          return res.usages;
        }}
        onDelete={async (confirm) => {
          await mutate(`/${collection}/${id}?confirm=${confirm}`, 'DELETE');
          toast('Удалено');
        }}
      />
    </>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return <EmptyState title={title} hint={hint} action={action} />;
}

/** «Что увидит охранник»: образец строки с поста (светофор — этап 8; здесь только текст). */
export function GuardPreview({
  title = 'Что увидит охранник',
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/40 p-3 text-sm">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

/** Карточка загрузилась с ошибкой — причина и повтор. */
export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Не удалось загрузить данные.';
  return (
    <Alert
      tone="danger"
      title="Не удалось загрузить данные"
      action={
        retry ? (
          <Button size="sm" variant="outline" onClick={retry}>
            Повторить
          </Button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

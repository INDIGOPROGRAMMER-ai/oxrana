import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FieldValues } from 'react-hook-form';
import { ErrorAlert } from '../components/alert';
import { Button } from '../components/button';
import { Skeleton } from '../components/skeleton';
import { cn } from '../lib/cn';
import type { FormController } from './use-edit-form';

/**
 * Каркас формы: `<fieldset disabled>` до загрузки (поля заблокированы, вместо значений — полоски),
 * общая ошибка со ссылкой на настройку, кнопка «Сохранить» неактивна, пока нечего отправлять, и
 * подсказка почему. «Сохранено» показывается только после ответа сервера.
 */
export function EditForm<T extends FieldValues>({
  form,
  children,
  submitLabel = 'Сохранить',
  mode = 'edit',
  extraActions,
  className,
}: {
  form: FormController<T>;
  children: ReactNode;
  submitLabel?: string;
  /** `edit` — PATCH изменённых полей; `create` — отправка всей формы. */
  mode?: 'edit' | 'create';
  extraActions?: ReactNode;
  className?: string;
}) {
  const disabled = !form.loaded || form.submitting;
  const nothingToSend = mode === 'edit' && !form.hasChanges;
  return (
    <form
      noValidate
      aria-busy={!form.loaded}
      className={cn('space-y-4', className)}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      <fieldset disabled={disabled} className="min-w-0 space-y-4 border-0 p-0">
        {form.loaded ? (
          children
        ) : (
          <div className="space-y-3" role="status" aria-label="Загрузка">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
      </fieldset>
      <ErrorAlert error={form.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={disabled || nothingToSend}>
          {form.submitting ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {submitLabel}
        </Button>
        {extraActions}
        {form.loaded && nothingToSend && !form.saved ? (
          <span className="text-xs text-muted-foreground">Изменений нет</span>
        ) : null}
        {form.saved ? (
          <span role="status" className="text-sm text-success">
            Сохранено
          </span>
        ) : null}
      </div>
    </form>
  );
}

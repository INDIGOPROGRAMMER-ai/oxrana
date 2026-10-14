import type { PassHintsSchema } from '@oxrana/contracts';
import { Alert, Skeleton } from '@oxrana/ui';
import { Loader2 } from 'lucide-react';
import type { z } from 'zod';

export type PassHints = z.infer<typeof PassHintsSchema>;

/**
 * Подсказки до сохранения (CLAUDE.md, правила интерфейса): КПП, лимит, согласование, док, окно,
 * блокировка, договор, чёрный список. Их считает сервер тем же движком, что и вердикт на посту.
 */
export function PassHintsPanel({
  hints,
  loading,
}: {
  hints: PassHints | undefined;
  loading: boolean;
}) {
  if (!hints) {
    return (
      <div role="status" aria-label="Загрузка подсказок" className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  const lines: { key: string; text: string; tone: 'info' | 'warning' }[] = [];
  lines.push({ key: 'route', text: hints.route.text, tone: 'info' });
  for (const q of hints.quotas) {
    lines.push({
      key: q.quotaId,
      text: q.text,
      tone:
        q.capacity === 0 || (q.occupied >= q.capacity && q.enforcement !== 'warn')
          ? 'warning'
          : 'info',
    });
  }
  if (hints.approval) {
    lines.push({
      key: 'approval',
      text: hints.approval.text,
      tone: hints.approval.mode === 'allow' ? 'info' : 'warning',
    });
  }
  if (hints.dock.text && hints.dock.required) {
    lines.push({ key: 'dock', text: `Укажите док. ${hints.dock.text}`, tone: 'info' });
  }
  if (hints.window.required) {
    const late =
      hints.window.lateToleranceMin === null
        ? ''
        : `, опоздавших пускаем ещё ${hints.window.lateToleranceMin} мин`;
    lines.push({
      key: 'window',
      text: `Окно прибытия обязательно: раньше окна на ${hints.window.earlyToleranceMin} мин пускаем${late}`,
      tone: 'info',
    });
  }
  if (hints.pedestrianRule) {
    lines.push({ key: 'pedestrian', text: hints.pedestrianRule, tone: 'info' });
  }
  return (
    <section aria-label="Что будет с пропуском" className="space-y-2" data-testid="hints">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        Что будет
        {loading ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </h2>
      {hints.notices.map((n) => (
        <Alert
          key={n.code}
          tone={n.severity === 'error' ? 'danger' : 'warning'}
          data-testid={`notice-${n.code}`}
        >
          {n.text}
        </Alert>
      ))}
      <ul className="space-y-1 text-sm">
        {lines.map((line) => (
          <li
            key={line.key}
            data-tone={line.tone}
            className={line.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'}
          >
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

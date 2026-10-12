import { cn } from '@oxrana/ui';
import { CheckCircle2, Circle, CircleDot, CircleHelp, Lock } from 'lucide-react';
import type { StepState } from '../lib/setup';

const META: Record<StepState, { label: string; icon: typeof Circle; className: string }> = {
  done: { label: 'готово', icon: CheckCircle2, className: 'text-success' },
  partial: { label: 'частично', icon: CircleDot, className: 'text-warning' },
  empty: { label: 'не начато', icon: Circle, className: 'text-muted-foreground' },
  blocked: { label: 'ждёт предыдущих шагов', icon: Lock, className: 'text-muted-foreground' },
  unknown: { label: 'нет данных', icon: CircleHelp, className: 'text-muted-foreground' },
};

export function stepStateLabel(state: StepState): string {
  return META[state].label;
}

/** Значок состояния шага; текст состояния — для программ чтения экрана. */
export function StepIcon({ state, className }: { state: StepState; className?: string }) {
  const meta = META[state];
  const Icon = meta.icon;
  return (
    <>
      <Icon aria-hidden className={cn('size-4 shrink-0', meta.className, className)} />
      <span className="sr-only">{meta.label}</span>
    </>
  );
}

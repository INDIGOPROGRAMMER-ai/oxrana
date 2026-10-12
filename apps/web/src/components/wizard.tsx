import { Alert, Badge, Button, cn, PageHeader } from '@oxrana/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useMe } from '../lib/data';
import { canOpenStep, STEPS, stepBySlug, useSetupProgress } from '../lib/setup';
import { useSite } from '../lib/site-context';
import { STEP_CARDS } from './cards/registry';
import { Empty } from './common';
import { StepIcon, stepStateLabel } from './step-status';

/** Шаг, с которого стоит продолжить: первый обязательный не выполненный и доступный. */
export function nextUnfinished(
  progress: ReturnType<typeof useSetupProgress>['progress'],
  can: (p: string) => boolean,
): string {
  const step = STEPS.find(
    (s) =>
      s.slug !== 'check' && s.required && progress[s.slug]?.state !== 'done' && canOpenStep(s, can),
  );
  return step?.slug ?? 'check';
}

/**
 * Рамка мастера: шаги слева, карточка шага справа. Шаги — те же карточки, что и в меню админки;
 * прогресс считается по данным, поэтому можно уйти и вернуться, а любой шаг — пропустить.
 */
export function WizardFrame({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const { me, can } = useMe();
  const { site } = useSite();
  const { progress } = useSetupProgress(me);
  const step = stepBySlug(slug);
  if (!step) {
    return <Empty title="Такого шага нет" hint="Вернитесь к списку шагов мастера." />;
  }
  const Card = STEP_CARDS[step.slug];
  const index = STEPS.indexOf(step);
  const prev = STEPS[index - 1];
  const next = STEPS[index + 1];
  const status = progress[step.slug];
  const doneCount = STEPS.filter((s) => progress[s.slug]?.state === 'done').length;
  const allowed = canOpenStep(step, can);
  const needsSite = step.slug !== 'site' && !site;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside aria-label="Шаги мастера" className="lg:sticky lg:top-20 lg:self-start">
        <p className="mb-2 text-sm text-muted-foreground">
          Готово {doneCount} из {STEPS.length}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={doneCount}
          className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
          />
        </div>
        <ol className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {STEPS.map((s) => {
            const st = progress[s.slug];
            return (
              <li key={s.slug} className="shrink-0">
                <Link
                  to="/admin/setup/$step"
                  params={{ step: s.slug }}
                  aria-current={s.slug === step.slug ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
                    s.slug === step.slug && 'bg-accent font-medium',
                  )}
                >
                  <StepIcon state={st?.state ?? 'unknown'} />
                  <span className="whitespace-nowrap">
                    {s.n}. {s.title}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </aside>

      <section className="min-w-0" aria-labelledby="wizard-title">
        <PageHeader
          title={`Шаг ${step.n} из ${STEPS.length}. ${step.title}`}
          description={step.short}
          actions={
            status ? (
              <Badge
                tone={
                  status.state === 'done'
                    ? 'success'
                    : status.state === 'partial'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {stepStateLabel(status.state)}
              </Badge>
            ) : undefined
          }
        />
        {status &&
        status.state !== 'done' &&
        status.state !== 'unknown' &&
        status.missing.length > 0 ? (
          <Alert tone="info" className="mb-5" title="Чего не хватает">
            <ul className="list-disc pl-4">
              {status.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {!allowed ? (
          <Alert tone="warning" title="Нет доступа к этому шагу">
            Для него нужно право, которого у вашей роли нет. Шаг можно пропустить — его выполнит
            администратор с нужными правами.
          </Alert>
        ) : needsSite ? (
          <Empty
            title="Сначала создайте объект"
            hint="Все остальные шаги относятся к объекту."
            action={
              <Button asChild>
                <Link to="/admin/setup/$step" params={{ step: 'site' }}>
                  К шагу 1. Объект
                </Link>
              </Button>
            }
          />
        ) : Card ? (
          <Card />
        ) : null}

        <nav
          aria-label="Переходы между шагами"
          className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t pt-4"
        >
          {prev ? (
            <Button asChild variant="outline">
              <Link to="/admin/setup/$step" params={{ step: prev.slug }}>
                <ArrowLeft aria-hidden /> Назад
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Прогресс считается по данным — можно уйти и вернуться.
            </span>
            {next ? (
              <Button
                variant={status?.state === 'done' ? 'default' : 'outline'}
                onClick={() =>
                  void navigate({ to: '/admin/setup/$step', params: { step: next.slug } })
                }
              >
                {status?.state === 'done' ? 'Далее' : 'Пропустить шаг'} <ArrowRight aria-hidden />
              </Button>
            ) : (
              <Button asChild>
                <Link to="/admin">Завершить</Link>
              </Button>
            )}
          </div>
        </nav>
      </section>
    </div>
  );
}

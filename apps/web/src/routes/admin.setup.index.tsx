import { Badge, Button, Card, CardContent, PageHeader } from '@oxrana/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { StepIcon } from '../components/step-status';
import { nextUnfinished } from '../components/wizard';
import { useMe } from '../lib/data';
import { canOpenStep, STEPS, useSetupProgress } from '../lib/setup';

export const Route = createFileRoute('/admin/setup/')({
  component: SetupIndex,
});

/** Старт мастера: все шаги списком с состоянием и кнопка «Продолжить». */
function SetupIndex() {
  const { me, can } = useMe();
  const { progress, loading } = useSetupProgress(me);
  const next = nextUnfinished(progress, can);
  const doneCount = STEPS.filter((s) => progress[s.slug]?.state === 'done').length;
  return (
    <>
      <PageHeader
        title="Мастер настройки объекта"
        description="Одиннадцать шагов от названия объекта до проверки. Можно прерваться и вернуться: готовность считается по данным. Любой шаг можно пропустить."
        actions={
          <Button asChild disabled={loading}>
            <Link to="/admin/setup/$step" params={{ step: next }}>
              {doneCount === 0 ? 'Начать' : 'Продолжить'}
            </Link>
          </Button>
        }
      />
      <ol className="grid gap-3 sm:grid-cols-2">
        {STEPS.map((step) => {
          const status = progress[step.slug];
          const allowed = canOpenStep(step, can);
          return (
            <li key={step.slug}>
              <Card className={allowed ? '' : 'opacity-60'}>
                <CardContent className="flex items-start gap-3 p-4 pt-4">
                  <StepIcon state={status?.state ?? 'unknown'} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <Link
                      to="/admin/setup/$step"
                      params={{ step: step.slug }}
                      className="font-medium hover:underline"
                    >
                      {step.n}. {step.title}
                    </Link>
                    {!step.required ? (
                      <Badge tone="outline" className="ml-2">
                        по желанию
                      </Badge>
                    ) : null}
                    <p className="text-sm text-muted-foreground">{status?.summary ?? step.short}</p>
                    {!allowed ? (
                      <p className="text-xs text-warning">Нет права на этот шаг</p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>
    </>
  );
}

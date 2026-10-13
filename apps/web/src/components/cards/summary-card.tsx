import type { SandboxExamplesSchema } from '@oxrana/contracts';
import { Alert, Badge, Button, Section, Table, TBody, TD, TH, THead, TR } from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import type { z } from 'zod';
import { useApi, useMe } from '../../lib/data';
import { canOpenStep, STEPS, useSetupProgress } from '../../lib/setup';
import { useSite } from '../../lib/site-context';
import { StepIcon, stepStateLabel } from '../step-status';
import { VERDICT_STYLE } from './sandbox-card';

type Examples = z.infer<typeof SandboxExamplesSchema>;

/**
 * Прогон вердиктов по настроенным данным (шаг «Проверка»): 3–5 примеров тем же движком, что на посту,
 * — «фура арендатора не на своём КПП → синий, все места заняты → жёлтый». Каждый открывается в песочнице.
 */
function ExamplesSection({ siteId }: { siteId: string }) {
  const examples = useApi<Examples>(`/sites/${siteId}/sandbox/examples`);
  return (
    <Section
      title="Проверка вердиктов"
      description="Что получит охранник в типичных случаях на ваших данных. Если цвет не тот, который вы ждали, откройте пример в песочнице и посмотрите, какая проверка сработала."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/sandbox">Открыть песочницу</Link>
        </Button>
      }
    >
      {examples.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Считаем примеры…
        </p>
      ) : examples.error ? (
        <Alert tone="danger">Не удалось посчитать примеры: {examples.error.message}</Alert>
      ) : (
        <>
          <ul className="space-y-2" data-testid="examples">
            {(examples.data?.items ?? []).map((e) => {
              const style = VERDICT_STYLE[e.color];
              return (
                <li
                  key={e.key}
                  data-color={e.color}
                  className={`flex flex-wrap items-center gap-3 rounded-md border-l-4 p-2.5 ${style?.box ?? ''}`}
                >
                  <span aria-hidden className="text-lg">
                    {style?.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{e.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {style?.label}: {e.headline}
                    </p>
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/admin/sandbox" search={{ req: JSON.stringify(e.request) }}>
                      Открыть в песочнице
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
          {examples.data?.note ? (
            <p className="mt-3 text-sm text-muted-foreground">{examples.data.note}</p>
          ) : null}
        </>
      )}
    </Section>
  );
}

/**
 * Шаг 11 «Проверка»: сводка — что настроено, чего не хватает, со ссылками на шаги, и прогон
 * вердиктов по настроенным данным (3–5 примеров из песочницы правил).
 */
export function SummaryCard() {
  const { me, can } = useMe();
  const { site } = useSite();
  const { progress } = useSetupProgress(me);
  const rows = STEPS.filter((s) => s.slug !== 'check');
  const requiredMissing = rows.filter((s) => s.required && progress[s.slug]?.state !== 'done');
  return (
    <>
      {site ? (
        requiredMissing.length === 0 ? (
          <Alert tone="success" title="Обязательные шаги выполнены">
            Объект «{site.name}» настроен. Остальное (доки, люди, устройства) можно дополнить в
            любой момент.
          </Alert>
        ) : (
          <Alert tone="warning" title={`Не хватает обязательных шагов: ${requiredMissing.length}`}>
            Охранник сможет получить однозначный вердикт, когда они будут выполнены:{' '}
            {requiredMissing.map((s) => s.title).join(', ')}.
          </Alert>
        )
      ) : (
        <Alert tone="warning" title="Объект ещё не создан">
          Начните с шага 1.
        </Alert>
      )}
      <Section
        title="Что настроено"
        description="Готовность считается по данным объекта, отдельно она не хранится: исправили данные — сводка обновилась."
      >
        <Table>
          <THead>
            <TR>
              <TH className="w-8" />
              <TH>Шаг</TH>
              <TH>Что есть</TH>
              <TH>Чего не хватает</TH>
              <TH className="w-28" />
            </TR>
          </THead>
          <TBody>
            {rows.map((step) => {
              const status = progress[step.slug];
              const allowed = canOpenStep(step, can);
              return (
                <TR key={step.slug}>
                  <TD>{status ? <StepIcon state={status.state} /> : null}</TD>
                  <TD className="font-medium">
                    {step.n}. {step.title}
                    {!step.required ? (
                      <Badge tone="outline" className="ml-2">
                        по желанию
                      </Badge>
                    ) : null}
                  </TD>
                  <TD>
                    {status?.summary ?? '…'}
                    {status ? (
                      <span className="sr-only"> ({stepStateLabel(status.state)})</span>
                    ) : null}
                  </TD>
                  <TD className="text-muted-foreground">
                    {status && status.missing.length > 0 ? (
                      <ul className="list-disc pl-4">
                        {status.missing.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD>
                    {allowed ? (
                      <Button asChild variant="outline" size="sm">
                        <Link to="/admin/setup/$step" params={{ step: step.slug }}>
                          Открыть
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground" title="Нет права на этот шаг">
                        нет доступа
                      </span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Section>
      {site && can('sandbox.use') ? <ExamplesSection siteId={site.id} /> : null}
      {site && !can('sandbox.use') ? (
        <Alert tone="info" title="Песочница недоступна">
          Прогон вердиктов доступен пользователю с правом «Песочница правил».
        </Alert>
      ) : null}
    </>
  );
}

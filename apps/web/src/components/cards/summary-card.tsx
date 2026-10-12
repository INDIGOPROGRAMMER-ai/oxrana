import { Alert, Badge, Button, Section, Table, TBody, TD, TH, THead, TR } from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { useMe } from '../../lib/data';
import { canOpenStep, STEPS, useSetupProgress } from '../../lib/setup';
import { useSite } from '../../lib/site-context';
import { StepIcon, stepStateLabel } from '../step-status';

/**
 * Шаг 11 «Проверка»: сводка — что настроено, чего не хватает, со ссылками на шаги. Прогон
 * вердиктов («фура на КПП-1 → синий») появится на этапе 6b вместе с песочницей правил.
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
      <Alert tone="info" title="Проверка вердиктов — следующий этап">
        Тестовый прогон («фура на КПП-1 → синий, 26-я фура → жёлтый») и «что будет, если…» появятся
        в песочнице правил (этап 6b).
      </Alert>
    </>
  );
}

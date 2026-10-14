import { Alert, Field, PageHeader, Select, Skeleton } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PassFormEditorView } from '../components/pass-form/editor';
import { useTenants } from '../lib/data';
import { useSite } from '../lib/site-context';

export const Route = createFileRoute('/admin/pass-form')({
  component: PassFormPage,
});

/** Настройка формы пропуска для арендатора и его сотрудников (этап 7b, ADR-023). */
function PassFormPage() {
  const { site } = useSite();
  const { items, isLoading } = useTenants(site?.id ?? null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const tenants = items ?? [];
  const tenantId = chosen ?? tenants[0]?.id ?? null;
  return (
    <>
      <PageHeader
        title="Форма пропуска"
        description="Что видит и может выбрать логист арендатора: типы транспорта и виды пропусков, поля формы, время разового пропуска. Настройка идёт по уровням «объект → арендатор → сотрудник»: нижний уровень переопределяет верхний, а «сбросить» возвращает значение уровня выше."
      />
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : tenantId === null ? (
        <Alert tone="warning" title="Пока нет арендаторов">
          Форма настраивается для арендатора — сначала добавьте арендаторов (Арендаторы).
        </Alert>
      ) : (
        <div className="space-y-5">
          <Field label="Арендатор" className="max-w-sm">
            <Select
              value={tenantId}
              onChange={(e) => {
                setChosen(e.target.value);
                setUserId(null);
              }}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortName}
                </option>
              ))}
            </Select>
          </Field>
          <PassFormEditorView
            key={tenantId}
            tenantId={tenantId}
            userId={userId}
            onUserChange={setUserId}
          />
        </div>
      )}
    </>
  );
}

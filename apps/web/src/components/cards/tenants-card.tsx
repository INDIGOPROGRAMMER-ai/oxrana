import { type BatchResult, parseTenantRows, type TenantDraft } from '@oxrana/contracts';
import {
  Badge,
  BatchInput,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useCreateForm,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { Building2, ExternalLink, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { type TenantView, useCategories, useMutate, useTenants } from '../../lib/data';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { TenantContractCard } from './tenant-contract-card';
import {
  blankToNull,
  TenantCreateFormSchema,
  TenantFields,
  type TenantFormValues,
  TenantStatusBadge,
} from './tenant-shared';

const EMPTY_TENANT: TenantFormValues = {
  legalName: '',
  shortName: '',
  inn: '',
  responsiblePhone: '',
  emergencyPhone: '',
  trucksDockRequired: false,
  defaultCategoryId: '',
  isOperator: false,
};

function CreateTenantForm({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const categories = useCategories(siteId, true);
  const f = useCreateForm<TenantFormValues>({
    schema: TenantCreateFormSchema,
    initial: EMPTY_TENANT,
    toBody: (v) => blankToNull(v),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/tenants`, 'POST', body);
      toast('Арендатор добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить арендатора">
      <TenantFields f={f} categories={categories.items ?? []} />
    </EditForm>
  );
}

/** Вставка списка арендаторов из Excel: предпросмотр проверяет сервер (`dryRun`), сохранение — он же. */
function TenantBatch({ siteId }: { siteId: string }) {
  const toast = useToast();
  const mutate = useMutate();
  const send = (values: TenantDraft[], dryRun: boolean) =>
    dryRun
      ? api<BatchResult>(`/sites/${siteId}/tenants/batch`, {
          method: 'POST',
          body: { items: values, dryRun: true },
        })
      : mutate<BatchResult>(`/sites/${siteId}/tenants/batch`, 'POST', { items: values });
  return (
    <BatchInput<TenantDraft>
      label="Вставить из Excel"
      placeholder={'Склад Плюс\tООО «Склад Плюс»\t7700000000\t+7 900 000-00-00'}
      help="Краткое название · Полное название · ИНН · Телефон ответственного. Нужна только первая колонка."
      parse={parseTenantRows}
      columns={[
        { header: 'Краткое название', render: (v) => v.shortName },
        { header: 'Полное название', render: (v) => v.legalName },
        { header: 'ИНН', render: (v) => v.inn ?? '—' },
        { header: 'Телефон', render: (v) => v.responsiblePhone ?? '—' },
      ]}
      check={(values) => send(values, true)}
      commit={async (values) => {
        const result = await send(values, false);
        toast(result.summary);
        return result;
      }}
      commitLabel={(n) => (n === 0 ? 'Добавить арендаторов' : `Добавить арендаторов: ${n}`)}
    />
  );
}

/**
 * Карточка «Арендаторы» (шаг 6 и страница `/admin/tenants`): список, добавление по одному или
 * вставкой из Excel, удаление с показом использований. `onPickContract` добавляет кнопку «Договор»
 * (мастер показывает договор выбранного арендатора под списком).
 */
export function TenantsCard({
  onPickContract,
  pickedId,
}: {
  onPickContract?: ((tenant: TenantView) => void) | undefined;
  pickedId?: string | null | undefined;
}) {
  return (
    <RequireSite>
      {(site) => (
        <TenantsBody siteId={site.id} onPickContract={onPickContract} pickedId={pickedId} />
      )}
    </RequireSite>
  );
}

function TenantsBody({
  siteId,
  onPickContract,
  pickedId,
}: {
  siteId: string;
  onPickContract: ((tenant: TenantView) => void) | undefined;
  pickedId: string | null | undefined;
}) {
  const tenants = useTenants(siteId);
  const [creating, setCreating] = useState(false);
  const [pasting, setPasting] = useState(false);
  if (tenants.error)
    return <LoadError error={tenants.error} retry={() => void tenants.refetch()} />;
  const items = tenants.items ?? [];
  return (
    <>
      <Section
        title="Арендаторы"
        description="Компании, которым принадлежат пропуска и лимиты. Оператор объекта — тоже арендатор. Лимиты, доки, исключения и правила для пешеходов настраиваются в карточке арендатора."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setPasting((p) => !p)}>
              {pasting ? 'Скрыть вставку из Excel' : 'Вставить из Excel'}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> Добавить арендатора
            </Button>
          </>
        }
      >
        {tenants.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Арендаторов ещё нет"
            hint="Добавьте первого арендатора или вставьте весь список из Excel — достаточно одной колонки с названиями. ИНН, телефоны и договор можно дописать потом."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setCreating(true)}>
                  <Building2 aria-hidden /> Добавить арендатора
                </Button>
                <Button variant="outline" onClick={() => setPasting(true)}>
                  Вставить из Excel
                </Button>
              </div>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Краткое название</TH>
                <TH>Полное название</TH>
                <TH>ИНН</TH>
                <TH>Статус</TH>
                <TH className="w-48" />
              </TR>
            </THead>
            <TBody>
              {items.map((t) => (
                <TR
                  key={t.id}
                  aria-selected={pickedId === t.id || undefined}
                  className={pickedId === t.id ? 'bg-accent/50' : undefined}
                  onClick={onPickContract ? () => onPickContract(t) : undefined}
                >
                  <TD className="font-medium">
                    <Link
                      to="/admin/tenants/$tenantId"
                      params={{ tenantId: t.id }}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t.shortName}
                    </Link>
                    {t.isOperator ? (
                      <Badge tone="info" className="ml-2">
                        оператор
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="text-muted-foreground">{t.legalName}</TD>
                  <TD className="tabular-nums text-muted-foreground">{t.inn ?? '—'}</TD>
                  <TD>
                    <TenantStatusBadge status={t.status} />
                  </TD>
                  <TD>
                    <div
                      className="flex items-center justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {onPickContract ? (
                        <Button
                          variant={pickedId === t.id ? 'secondary' : 'outline'}
                          size="sm"
                          aria-pressed={pickedId === t.id}
                          onClick={() => onPickContract(t)}
                        >
                          <FileText aria-hidden /> Договор
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="icon" asChild>
                        <Link
                          to="/admin/tenants/$tenantId"
                          params={{ tenantId: t.id }}
                          aria-label={`Открыть карточку: ${t.shortName}`}
                          title="Открыть карточку арендатора"
                        >
                          <ExternalLink aria-hidden />
                        </Link>
                      </Button>
                      <DeleteAction
                        collection="tenants"
                        id={t.id}
                        name={`арендатора «${t.shortName}»`}
                        title="Удалить арендатора?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      {pasting ? (
        <Section
          title="Вставка списка арендаторов"
          description="Скопируйте столбцы из Excel и вставьте сюда. Перед сохранением видно, сколько добавится и в каких строках ошибки."
        >
          <TenantBatch siteId={siteId} />
        </Section>
      ) : null}

      {items.length > 0 ? (
        <GuardPreview title="Как арендатор видна охране">
          <p>
            На посту арендатор показывается кратким названием: «{items[0]?.shortName}». Полное
            название нужно для договоров и документов.
          </p>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новый арендатор</DialogTitle>
            <DialogDescription>
              Название и контакты. Лимиты, доки и договор настраиваются в карточке арендатора.
            </DialogDescription>
          </DialogHeader>
          <CreateTenantForm siteId={siteId} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

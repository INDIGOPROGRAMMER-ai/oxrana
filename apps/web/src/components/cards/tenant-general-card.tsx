import { EditForm, Section, useEditForm, useToast } from '@oxrana/ui';
import { type TenantView, useCategories, useMutate } from '../../lib/data';
import { LoadError } from '../common';
import { TenantBlockSection } from './tenant-block-card';
import {
  blankToNull,
  TenantFields,
  type TenantFormValues,
  TenantPatchFormSchema,
  useTenant,
} from './tenant-shared';

function toValues(t: TenantView): TenantFormValues {
  return {
    legalName: t.legalName,
    shortName: t.shortName,
    inn: t.inn ?? '',
    responsiblePhone: t.responsiblePhone ?? '',
    emergencyPhone: t.emergencyPhone ?? '',
    trucksDockRequired: t.trucksDockRequired,
    defaultCategoryId: t.defaultCategoryId ?? '',
    isOperator: t.isOperator,
  };
}

function GeneralForm({ tenant }: { tenant: TenantView | undefined }) {
  const mutate = useMutate();
  const toast = useToast();
  const categories = useCategories(tenant?.siteId ?? null, true);
  const f = useEditForm<TenantFormValues>({
    values: tenant ? toValues(tenant) : undefined,
    schema: TenantPatchFormSchema,
    onPatch: async (patch) => {
      if (!tenant) return;
      await mutate(`/tenants/${tenant.id}`, 'PATCH', blankToNull(patch));
      toast('Арендатор сохранён');
    },
  });
  return (
    <EditForm form={f}>
      <TenantFields
        f={f}
        categories={categories.items ?? []}
        currentCategoryId={tenant?.defaultCategoryId}
      />
    </EditForm>
  );
}

/**
 * Вкладка «Общее»: названия, ИНН, телефоны, настройки доков и типа по умолчанию. Форма заблокирована
 * до загрузки, отправляет только изменённые поля. Статус виден, но не меняется (блокировка — этап 6b).
 */
export function TenantGeneralCard({ tenantId }: { tenantId: string }) {
  const tenant = useTenant(tenantId);
  if (tenant.error) return <LoadError error={tenant.error} retry={() => void tenant.refetch()} />;
  return (
    <>
      <Section
        title="Общие сведения"
        description="Названия и контакты арендатора. Сохраняются только изменённые поля."
      >
        <GeneralForm tenant={tenant.data} />
      </Section>
      {tenant.data ? (
        <Section
          title="Блокировка"
          description="Запретить новые пропуска, въезд или всё сразу — с причиной и подсчётом последствий."
        >
          <TenantBlockSection tenant={tenant.data} />
        </Section>
      ) : null}
    </>
  );
}

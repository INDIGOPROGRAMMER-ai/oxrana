import {
  SiteCreateSchema,
  SitePatchSchema,
  type TimezoneOptionSchema,
  type WorkingHours,
} from '@oxrana/contracts';
import {
  Alert,
  Button,
  EditForm,
  Field,
  Input,
  Section,
  Select,
  SiteTime,
  Switch,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { type SiteView, useApi, useMutate, useOrganization } from '../../lib/data';
import { useSite } from '../../lib/site-context';
import { GuardPreview } from '../common';
import { describeHours, WorkingHoursInput } from '../working-hours';

type TzOption = z.infer<typeof TimezoneOptionSchema>;
interface TimezonesView {
  zones: TzOption[];
  organizationDefault: TzOption | null;
  suggestion: {
    timezone: string;
    city: string;
    label: string;
    differsFromDefault: boolean;
  } | null;
}

/** Адрес → подсказка пояса: запрос уходит после паузы в наборе. */
function useTimezones(address: string) {
  const [debounced, setDebounced] = useState(address);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(address), 400);
    return () => clearTimeout(t);
  }, [address]);
  return useApi<TimezonesView>(`/timezones?address=${encodeURIComponent(debounced.trim())}`);
}

interface CreateValues {
  name: string;
  address: string;
  timezone: string;
  workingHours: WorkingHours | null;
}

function CreateSite({ defaults }: { defaults: TimezonesView }) {
  const mutate = useMutate();
  const toast = useToast();
  const initial: CreateValues = {
    name: '',
    address: '',
    timezone: defaults.organizationDefault?.id ?? '',
    workingHours: null,
  };
  const f = useCreateForm<CreateValues>({
    schema: SiteCreateSchema,
    initial,
    toBody: (v) => ({
      name: v.name,
      ...(v.address.trim() ? { address: v.address } : {}),
      ...(v.timezone ? { timezone: v.timezone } : {}),
      workingHours: v.workingHours,
    }),
    onCreate: async (body) => {
      await mutate('/sites', 'POST', body);
      toast('Объект создан');
    },
  });
  const address = f.form.watch('address');
  const timezone = f.form.watch('timezone');
  const tz = useTimezones(address);
  const suggestion = tz.data?.suggestion ?? null;
  const zones = defaults.zones;
  return (
    <Section
      title="Новый объект"
      description="Название, адрес и часовой пояс. Пояс определяет время во всех экранах и в правилах объекта."
    >
      <EditForm form={f} mode="create" submitLabel="Создать объект">
        <Field label="Название объекта" error={f.fieldError('name')} required>
          <Input {...f.form.register('name')} placeholder="Например, «Склад на Заводской»" />
        </Field>
        <Field
          label="Адрес"
          error={f.fieldError('address')}
          hint="По адресу мы подскажем часовой пояс."
        >
          <Input {...f.form.register('address')} autoComplete="off" />
        </Field>
        <Field
          label="Часовой пояс объекта"
          required
          error={f.fieldError('timezone')}
          hint={
            defaults.organizationDefault
              ? `Предзаполнен поясом организации: ${defaults.organizationDefault.label}.`
              : 'У организации пояс по умолчанию не задан — выберите пояс объекта.'
          }
        >
          <Select {...f.form.register('timezone')}>
            <option value="">— выберите —</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        {suggestion && suggestion.timezone !== timezone ? (
          <Alert
            tone="info"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  f.form.setValue('timezone', suggestion.timezone, { shouldDirty: true })
                }
              >
                Применить
              </Button>
            }
          >
            По адресу «{suggestion.city}» объект в поясе {suggestion.label} — проверьте.
          </Alert>
        ) : null}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Рабочее время комплекса</p>
          <WorkingHoursInput
            value={f.form.watch('workingHours')}
            onChange={(v) => f.form.setValue('workingHours', v, { shouldDirty: true })}
            tzLabel={zones.find((z) => z.id === timezone)?.label}
          />
        </div>
      </EditForm>
    </Section>
  );
}

interface EditValues {
  name: string;
  address: string;
  workingHours: WorkingHours | null;
}

/**
 * Настройки организации (действуют на все объекты). «Вести договоры» — договоры бывают
 * коммерческой тайной: выключено — разделы и поля договоров скрыты везде, срок договора не проверяется.
 */
function OrganizationSettings() {
  const mutate = useMutate();
  const toast = useToast();
  const { org } = useOrganization();
  const f = useEditForm<{ trackContracts: boolean }>({
    values: org ? { trackContracts: org.settings.trackContracts } : undefined,
    onPatch: async (patch) => {
      await mutate('/org', 'PATCH', { settings: patch });
      toast(patch.trackContracts ? 'Договоры включены' : 'Договоры выключены и скрыты');
    },
  });
  return (
    <Section
      title="Настройки организации"
      description="Действуют на все объекты организации. Менять может только роль на всю организацию."
    >
      <EditForm form={f}>
        <Switch
          {...f.form.register('trackContracts')}
          label="Вести договоры"
          hint="Включено по умолчанию. Выключите, если договоры арендаторов — коммерческая тайна: разделы и поля договоров исчезнут, срок договора не будет проверяться (пропуска не закончатся из-за договора), а лимиты и доки работают без ссылки на пункт."
        />
      </EditForm>
    </Section>
  );
}

function EditSite({ site }: { site: SiteView }) {
  const mutate = useMutate();
  const toast = useToast();
  const values: EditValues = {
    name: site.name,
    address: site.address ?? '',
    workingHours: site.workingHours,
  };
  const f = useEditForm<EditValues>({
    values,
    schema: SitePatchSchema,
    onPatch: async (patch) => {
      const body = {
        ...patch,
        ...(patch.address !== undefined ? { address: patch.address.trim() || null } : {}),
      };
      await mutate(`/sites/${site.id}`, 'PATCH', body);
      toast('Объект сохранён');
    },
  });
  const address = f.form.watch('address') ?? '';
  const tz = useTimezones(address);
  const suggestion = tz.data?.suggestion ?? null;
  return (
    <>
      <Section title="Объект" description={`Идентификатор пояса: ${site.timezone}`}>
        <EditForm form={f}>
          <Field label="Название объекта" error={f.fieldError('name')} required>
            <Input {...f.form.register('name')} />
          </Field>
          <Field label="Адрес" error={f.fieldError('address')}>
            <Input {...f.form.register('address')} autoComplete="off" />
          </Field>
          {suggestion && suggestion.timezone !== site.timezone ? (
            <Alert tone="warning" title="Пояс не совпадает с адресом">
              По адресу «{suggestion.city}» ожидается пояс {suggestion.label}, а у объекта{' '}
              {site.timezoneLabel}.{' '}
              <Link
                to="/admin/sites/$siteId/timezone"
                params={{ siteId: site.id }}
                className="font-medium underline"
              >
                Сменить пояс
              </Link>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Рабочее время комплекса</p>
            <WorkingHoursInput
              value={f.form.watch('workingHours')}
              onChange={(v) => f.form.setValue('workingHours', v, { shouldDirty: true })}
              tzLabel={site.timezoneLabel}
            />
          </div>
        </EditForm>
      </Section>
      <Section
        title="Часовой пояс"
        description="Время на всех экранах показывается в поясе объекта с подписью. Пояс меняется отдельным действием — с причиной и подтверждением."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/sites/$siteId/timezone" params={{ siteId: site.id }}>
              Сменить пояс…
            </Link>
          </Button>
        }
      >
        <p className="text-sm">
          Сейчас: <strong>{site.timezoneLabel}</strong> ({site.timezone}). Для проверки — на объекте
          сейчас <SiteTime value={new Date().toISOString()} />.
        </p>
      </Section>
      <OrganizationSettings />
      <GuardPreview>
        <p>
          Часы работы комплекса: <strong>{describeHours(site.workingHours)}</strong> (
          {site.timezoneLabel}). Въезд вне этих часов охранник увидит предупреждением или отказом —
          как задано в политиках.
        </p>
      </GuardPreview>
    </>
  );
}

/** Карточка «Объект»: создание на чистой базе и правка. Пояс меняется отдельной страницей. */
export function SiteCard() {
  const { site, loading } = useSite();
  const defaults = useApi<TimezonesView>('/timezones');
  if (loading || (!site && !defaults.data)) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }
  if (!site && defaults.data) return <CreateSite defaults={defaults.data} />;
  return site ? <EditSite site={site} /> : null;
}

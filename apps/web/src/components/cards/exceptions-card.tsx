import { EXCEPTION_WAIVES, type ExceptionWaive, ExceptionWaiveSchema } from '@oxrana/contracts';
import {
  ApiError,
  Badge,
  Button,
  ChipSelect,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  type FormController,
  formatInZone,
  Input,
  localToInstant,
  Section,
  Select,
  SiteTime,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import {
  type CategoryView,
  type ExceptionView,
  type SiteView,
  type TenantView,
  useCategories,
  useExceptions,
  useMutate,
  useSites,
  useTenants,
} from '../../lib/data';
import { WAIVE_LABEL } from '../../lib/labels';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { useTenant } from './tenant-shared';

type Target = 'plates' | 'categories' | 'tenant' | 'passes';

interface ExceptionValues {
  name: string;
  /** Пусто — исключение объекта; задано — исключение одного арендатора. */
  tenantId: string;
  target: Target;
  /** Номера списком: по одному в строке или через запятую. */
  plates: string;
  categoryIds: string[];
  waives: ExceptionWaive[];
  guardText: string;
  basis: string;
  /** `ГГГГ-ММ-ДДTЧЧ:ММ` по времени объекта или пустая строка — без срока. */
  validTo: string;
}

// Проверка полей формы с русскими сообщениями; условия «кому» проверяются при сборке тела.
const FormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Введите название исключения')
      .max(200, 'Название — не длиннее 200 символов'),
    waives: z.array(ExceptionWaiveSchema).min(1, 'Отметьте, какие проверки снимает исключение'),
    guardText: z.string().trim().max(300, 'Текст для охраны — не длиннее 300 символов'),
    basis: z.string().trim().max(500, 'Основание — не длиннее 500 символов'),
    validTo: z
      .string()
      .refine(
        (v) => v === '' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v),
        'Укажите дату и время окончания полностью или очистите поле',
      ),
  })
  .loose();
const EditFormSchema = FormSchema.partial();

const fieldFail = (field: string, message: string) =>
  new ApiError(400, { code: 'validation_failed', message, field });

/** Номера из текста: по одному в строке, через запятую или точку с запятой. */
export function splitPlates(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** `ГГГГ-ММ-ДДTЧЧ:ММ` (время объекта) → момент в UTC; пусто → `null`. */
function instantOf(local: string, timezone: string): string | null {
  if (local === '') return null;
  const [date = '', time = '00:00'] = local.split('T');
  return localToInstant(date, time, timezone);
}

/** Момент → `ГГГГ-ММ-ДДTЧЧ:ММ` по времени объекта (для поля формы). */
function localOf(iso: string | null, timezone: string): string {
  if (!iso) return '';
  const [d = '', t = ''] = formatInZone(iso, timezone).split(' ');
  const [dd = '', mm = '', yyyy = ''] = d.split('.');
  return `${yyyy}-${mm}-${dd}T${t}`;
}

function targetOf(match: ExceptionView['match']): Target {
  if ('plates' in match) return 'plates';
  if ('categoryIds' in match) return 'categories';
  if ('tenant' in match) return 'tenant';
  return 'passes';
}

/** «Кому»: ровно один вариант; не заполненный как надо — понятная ошибка у своего поля. */
function buildMatch(v: ExceptionValues, tenantId: string) {
  if (v.target === 'plates') {
    const plates = splitPlates(v.plates);
    if (plates.length === 0) throw fieldFail('plates', 'Укажите хотя бы один номер машины.');
    return { plates };
  }
  if (v.target === 'categories') {
    if (v.categoryIds.length === 0)
      throw fieldFail('categoryIds', 'Отметьте хотя бы один тип транспорта.');
    return { categoryIds: v.categoryIds };
  }
  if (v.target === 'tenant') {
    if (tenantId === '')
      throw fieldFail(
        'tenantId',
        'Чтобы исключение действовало на весь арендатора, выберите арендатора.',
      );
    return { tenant: true as const };
  }
  return null;
}

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

function describeMatch(match: ExceptionView['match'], categories: readonly CategoryView[]): string {
  if ('plates' in match) return `Номера: ${match.plates.join(', ')}`;
  if ('categoryIds' in match) {
    const names = match.categoryIds.map(
      (id) => categories.find((c) => c.id === id)?.name ?? 'тип удалён',
    );
    return `Типы транспорта: ${names.join(', ')}`;
  }
  if ('tenant' in match) return 'Весь арендатор';
  return `Конкретные пропуска: ${match.passIds.length}`;
}

function ExceptionFields({
  f,
  site,
  tenants,
  categories,
  fixedTenant,
  editingPasses,
}: {
  f: FormController<ExceptionValues>;
  site: SiteView;
  tenants: readonly TenantView[];
  categories: readonly CategoryView[];
  /** Страница арендатора: исключение принадлежит ему, выбор арендатора не показывается. */
  fixedTenant: TenantView | null;
  editingPasses: boolean;
}) {
  const { register, watch, setValue } = f.form;
  const target = watch('target');
  const tenantId = watch('tenantId');
  const waives = watch('waives');
  const categoryIds = watch('categoryIds');
  const noTenant = tenantId === '';
  return (
    <>
      <Field label="Название" required error={f.fieldError('name')}>
        <Input
          {...register('name')}
          maxLength={200}
          placeholder="Например, «Автобус сотрудников»"
        />
      </Field>
      {fixedTenant ? (
        <p className="text-sm">
          Арендатор: <span className="font-medium">{fixedTenant.shortName}</span>
        </p>
      ) : (
        <Field
          label="Арендатор"
          hint="Не выбран — исключение действует на весь объект."
          error={f.fieldError('tenantId')}
        >
          <Select {...register('tenantId')}>
            <option value="">— весь объект —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.shortName}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <fieldset className="space-y-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">
          Кому <span className="text-destructive">*</span>
        </legend>
        {editingPasses ? (
          <p className="text-sm text-warning">
            Исключение привязано к конкретным пропускам, в этой форме их состав не меняется.
            Название, проверки, срок и тексты — меняются.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="plates" {...register('target')} />
              Машинам с этими номерами
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" value="categories" {...register('target')} />
              Всем машинам выбранных типов транспорта
            </label>
            <label
              className={`flex items-center gap-2 text-sm ${noTenant ? 'opacity-60' : ''}`}
              title={noTenant ? 'Сначала выберите арендатора выше' : undefined}
            >
              <input type="radio" value="tenant" disabled={noTenant} {...register('target')} />
              Всему арендатору
              {noTenant ? (
                <span className="text-xs text-warning">— недоступно: выберите арендатора</span>
              ) : null}
            </label>
          </>
        )}
        {target === 'plates' ? (
          <Field
            label="Номера машин"
            hint={
              <>
                По одному в строке или через запятую. Номер запишется заглавными латинскими буквами
                без пробелов и тире: «а 123 вс 174» станет «A123BC174». Итог виден в списке после
                сохранения.
              </>
            }
            error={f.fieldError('plates')}
          >
            <Textarea {...register('plates')} rows={4} className="font-mono" spellCheck={false} />
          </Field>
        ) : null}
        {target === 'categories' ? (
          <div className="space-y-1">
            <ChipSelect
              label="Типы транспорта"
              options={categories.map((c) => ({
                value: c.id,
                label: c.enabled ? c.name : `${c.name} (выключен)`,
              }))}
              value={categoryIds}
              onChange={(next) => setValue('categoryIds', next, { shouldDirty: true })}
            />
            {f.fieldError('categoryIds') ? (
              <p role="alert" className="text-xs text-destructive">
                {f.fieldError('categoryIds')?.message}
              </p>
            ) : null}
          </div>
        ) : null}
        {target === 'tenant' ? (
          <p className="text-xs text-muted-foreground">
            Исключение действует на все пропуска выбранного арендатора.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="space-y-1.5 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">
          Что снимает <span className="text-destructive">*</span>
        </legend>
        <ChipSelect
          label="Снимаемые проверки"
          options={EXCEPTION_WAIVES.map((w) => ({ value: w, label: WAIVE_LABEL[w] }))}
          value={waives}
          onChange={(next) => setValue('waives', next as ExceptionWaive[], { shouldDirty: true })}
        />
        <p className="text-xs text-muted-foreground">
          Отмеченные проверки для этих машин не выполняются. Остальные работают как обычно.
        </p>
        {f.fieldError('waives') ? (
          <p role="alert" className="text-xs text-destructive">
            {f.fieldError('waives')?.message}
          </p>
        ) : null}
      </fieldset>

      <Field
        label="Текст для охраны"
        hint="Одна короткая фраза в карточке на посту. Не заполнено — покажется название."
        error={f.fieldError('guardText')}
      >
        <Input {...register('guardText')} maxLength={300} />
      </Field>
      <Field
        label="Основание"
        hint="Почему сделано исключение: пункт договора, распоряжение, дата решения."
        error={f.fieldError('basis')}
      >
        <Textarea {...register('basis')} rows={2} maxLength={500} />
      </Field>
      <Field
        label="Действует до"
        hint={`Время объекта (${site.timezoneLabel}). Пусто — исключение действует без срока.`}
        error={f.fieldError('validTo')}
      >
        <Input type="datetime-local" {...register('validTo')} />
      </Field>
    </>
  );
}

interface FormEnv {
  site: SiteView;
  tenants: readonly TenantView[];
  categories: readonly CategoryView[];
  fixedTenant: TenantView | null;
}

const EMPTY: ExceptionValues = {
  name: '',
  tenantId: '',
  target: 'plates',
  plates: '',
  categoryIds: [],
  waives: [],
  guardText: '',
  basis: '',
  validTo: '',
};

function platesNote(created: ExceptionView): string {
  return 'plates' in created.match
    ? `Номера записаны как: ${created.match.plates.join(', ')}.`
    : '';
}

function CreateExceptionForm({ env, onDone }: { env: FormEnv; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const { site, fixedTenant } = env;
  const f = useCreateForm<ExceptionValues>({
    schema: FormSchema,
    initial: { ...EMPTY, tenantId: fixedTenant?.id ?? '' },
    toBody: (v) => v,
    onCreate: async (raw) => {
      const v = raw as ExceptionValues;
      const tenantId = fixedTenant?.id ?? v.tenantId;
      const match = buildMatch(v, tenantId);
      if (!match) return;
      const created = await mutate<ExceptionView>(`/sites/${site.id}/exceptions`, 'POST', {
        name: v.name.trim(),
        tenantId: tenantId === '' ? null : tenantId,
        match,
        waives: v.waives,
        guardText: orNull(v.guardText),
        basis: orNull(v.basis),
        validTo: instantOf(v.validTo, site.timezone),
      });
      toast(`Исключение добавлено. ${platesNote(created)}`.trim());
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить исключение">
      <ExceptionFields
        f={f}
        site={site}
        tenants={env.tenants}
        categories={env.categories}
        fixedTenant={fixedTenant}
        editingPasses={false}
      />
    </EditForm>
  );
}

function EditExceptionForm({
  exception,
  env,
  onDone,
}: {
  exception: ExceptionView;
  env: FormEnv;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const { site, fixedTenant } = env;
  const target = targetOf(exception.match);
  const f = useEditForm<ExceptionValues>({
    values: {
      name: exception.name,
      tenantId: exception.tenantId ?? '',
      target,
      plates: 'plates' in exception.match ? exception.match.plates.join('\n') : '',
      categoryIds: 'categoryIds' in exception.match ? exception.match.categoryIds : [],
      waives: exception.waives,
      guardText: exception.guardText ?? '',
      basis: exception.basis ?? '',
      validTo: localOf(exception.validTo, site.timezone),
    },
    schema: EditFormSchema,
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name.trim();
      if (patch.tenantId !== undefined)
        body.tenantId = patch.tenantId === '' ? null : patch.tenantId;
      if (patch.waives !== undefined) body.waives = patch.waives;
      if (patch.guardText !== undefined) body.guardText = orNull(patch.guardText);
      if (patch.basis !== undefined) body.basis = orNull(patch.basis);
      if (patch.validTo !== undefined) body.validTo = instantOf(patch.validTo, site.timezone);
      const matchChanged =
        target !== 'passes' &&
        (patch.target !== undefined ||
          patch.plates !== undefined ||
          patch.categoryIds !== undefined ||
          patch.tenantId !== undefined);
      if (matchChanged) {
        const now = f.form.getValues();
        const match = buildMatch(now, fixedTenant?.id ?? now.tenantId);
        if (match) body.match = match;
      }
      const saved = await mutate<ExceptionView>(`/exceptions/${exception.id}`, 'PATCH', body);
      toast(`Исключение сохранено. ${platesNote(saved)}`.trim());
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <ExceptionFields
        f={f}
        site={site}
        tenants={env.tenants}
        categories={env.categories}
        fixedTenant={fixedTenant}
        editingPasses={target === 'passes'}
      />
    </EditForm>
  );
}

/** «до 10.10.2026 18:00 (Челябинск, UTC+5)» / «без срока»; истёкшее помечено. */
function Validity({ exception }: { exception: ExceptionView }) {
  if (!exception.validTo) return <span className="text-muted-foreground">без срока</span>;
  const expired = Date.parse(exception.validTo) < Date.now();
  return (
    <span className="inline-flex flex-col gap-1">
      <span>
        до <SiteTime value={exception.validTo} />
      </span>
      {expired ? <Badge tone="warning">срок истёк</Badge> : null}
    </span>
  );
}

/**
 * Исключения объекта: правило, снимающее выбранные проверки для номеров, типов транспорта или
 * всего арендатора. С `tenantId` — только исключения этого арендатора (вкладка в его карточке).
 */
export function ExceptionsCard({ tenantId }: { tenantId?: string | undefined }) {
  if (tenantId) return <TenantExceptions tenantId={tenantId} />;
  return <RequireSite>{(site) => <ExceptionsBody site={site} tenant={null} />}</RequireSite>;
}

function TenantExceptions({ tenantId }: { tenantId: string }) {
  const tenant = useTenant(tenantId);
  const sites = useSites();
  if (tenant.error) return <LoadError error={tenant.error} retry={() => void tenant.refetch()} />;
  const site = sites.items?.find((s) => s.id === tenant.data?.siteId);
  if (!tenant.data || !site) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Загрузка…
      </p>
    );
  }
  return <ExceptionsBody site={site} tenant={tenant.data} />;
}

function ExceptionsBody({ site, tenant }: { site: SiteView; tenant: TenantView | null }) {
  const exceptions = useExceptions(site.id);
  const tenants = useTenants(site.id);
  const categories = useCategories(site.id, true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ExceptionView | null>(null);
  if (exceptions.error)
    return <LoadError error={exceptions.error} retry={() => void exceptions.refetch()} />;
  const all = exceptions.items ?? [];
  const items = tenant ? all.filter((e) => e.tenantId === tenant.id) : all;
  const tenantList = tenants.items ?? [];
  const categoryList = categories.items ?? [];
  const env: FormEnv = { site, tenants: tenantList, categories: categoryList, fixedTenant: tenant };
  const tenantName = (id: string | null) =>
    id === null ? 'весь объект' : (tenantList.find((t) => t.id === id)?.shortName ?? '—');
  const loading = exceptions.isLoading || tenants.isLoading || categories.isLoading;
  return (
    <>
      <Section
        title={tenant ? `Исключения: ${tenant.shortName}` : 'Исключения'}
        description="Исключение снимает выбранные проверки для номеров, типов транспорта или всего арендатора: например, автобус без лимита или арендатор, которому можно круглосуточно."
        actions={
          <Button size="sm" onClick={() => setCreating(true)} disabled={loading}>
            <Plus aria-hidden /> Добавить исключение
          </Button>
        }
      >
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Исключений нет"
            hint="Все проверки работают для всех одинаково. Добавьте исключение, если машине или арендатору нужно сделать поблажку, и укажите основание — оно попадёт в журнал."
            action={
              <Button onClick={() => setCreating(true)}>
                <ShieldCheck aria-hidden /> Добавить исключение
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Название</TH>
                {tenant ? null : <TH>Арендатор</TH>}
                <TH>Что совпадает</TH>
                <TH>Что снимает</TH>
                <TH>Основание</TH>
                <TH>Срок</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((e) => (
                <TR key={e.id}>
                  <TD className="font-medium">{e.name}</TD>
                  {tenant ? null : <TD>{tenantName(e.tenantId)}</TD>}
                  <TD className="max-w-64 break-words">{describeMatch(e.match, categoryList)}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {e.waives.map((w) => (
                        <Badge key={w} tone="info">
                          {WAIVE_LABEL[w]}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD className="max-w-56 text-muted-foreground">{e.basis ?? '—'}</TD>
                  <TD>
                    <Validity exception={e} />
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить: ${e.name}`}
                        onClick={() => setEditing(e)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="exceptions"
                        id={e.id}
                        name={`исключение «${e.name}»`}
                        title="Удалить исключение?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      {items.length > 0 ? (
        <GuardPreview>
          <ul className="list-disc space-y-0.5 pl-5">
            {items.map((e) => (
              <li key={e.id}>
                Исключение: {e.guardText ?? e.name} — снимает:{' '}
                {e.waives.map((w) => WAIVE_LABEL[w]).join(', ')}.
              </li>
            ))}
          </ul>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новое исключение</DialogTitle>
            <DialogDescription>
              Кому, какие проверки снять и до какого срока. Основание сохранится в журнале.
            </DialogDescription>
          </DialogHeader>
          <CreateExceptionForm env={env} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Исключение «{editing?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditExceptionForm exception={editing} env={env} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

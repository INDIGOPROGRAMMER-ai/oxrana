import {
  QuotaCreateSchema,
  type QuotaEnforcement,
  QuotaPatchSchema,
  type VehicleCategoryPresetCode,
  vehicleCategoryPreset,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ChipSelect,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  type FormController,
  Input,
  Section,
  Select,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import {
  type CategoryView,
  type QuotaView,
  useCategories,
  useDockAssignments,
  useDocks,
  useMutate,
  useQuotas,
  useTrackContracts,
} from '../../lib/data';
import { ENFORCEMENT_LABEL, ENFORCEMENT_SHORT } from '../../lib/labels';
import { count } from '../../lib/setup';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { isActiveOn } from './tenant-docks-card';
import {
  assertValid,
  fieldProblem,
  intFromText,
  siteToday,
  type TenantClauses,
  usePermissions,
  useTenantClauses,
} from './tenant-rule-helpers';

// Тексты ошибок схем лимита — по-русски (стандартные сообщения zod английские).
const CAPACITY = z
  .int('Число мест — целое число.')
  .min(0, 'Число мест не может быть отрицательным.');
const TARIFF = z.number('Тариф — число.').min(0, 'Тариф не может быть отрицательным.');
const OVERAGE_CAP = z.int('Потолок — целое число.').min(0, 'Потолок не может быть отрицательным.');

const QuotaFormCreateSchema = QuotaCreateSchema.extend({
  capacity: CAPACITY.optional(),
  overageTariffRub: TARIFF.nullable().optional(),
  overageCap: OVERAGE_CAP.nullable().optional(),
});
const QuotaFormPatchSchema = QuotaPatchSchema.extend({
  capacity: CAPACITY.optional(),
  overageTariffRub: TARIFF.nullable().optional(),
  overageCap: OVERAGE_CAP.nullable().optional(),
});

interface QuotaValues {
  name: string;
  categoryIds: string[];
  capacity: string;
  capacityFromDocks: boolean;
  enforcement: QuotaEnforcement;
  overageTariffRub: string;
  overageCap: string;
  basisClauseId: string;
}

const NEW_QUOTA: QuotaValues = {
  name: '',
  categoryIds: [],
  capacity: '',
  capacityFromDocks: false,
  enforcement: 'hard',
  overageTariffRub: '',
  overageCap: '',
  basisClauseId: '',
};

/** Типовые наборы «как у договора» (ADR-012 п. 4). */
const PRESETS: readonly { label: string; codes: readonly VehicleCategoryPresetCode[] }[] = [
  { label: 'Легковые', codes: ['car'] },
  { label: 'Грузовые', codes: ['light_truck', 'semi', 'truck_5t'] },
  { label: 'Спецтехника', codes: ['special'] },
];

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);
const rub = (value: number) => new Intl.NumberFormat('ru-RU').format(value);

/** Окружение формы: всё, что нужно подсказкам до сохранения. */
interface QuotaEnv {
  readonly categories: readonly CategoryView[];
  /** Другие лимиты этого арендатора (без редактируемого). */
  readonly otherQuotas: readonly QuotaView[];
  /** Сколько доков сейчас закреплено за арендатором и считается в лимите; `null` — неизвестно. */
  readonly dockCount: number | null;
  readonly clauses: TenantClauses;
  readonly mode: 'create' | 'edit';
}

function presetResolution(preset: (typeof PRESETS)[number], categories: readonly CategoryView[]) {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const code of preset.codes) {
    const category = categories.find((c) => c.enabled && c.presetCode === code);
    if (category) ids.push(category.id);
    else missing.push(vehicleCategoryPreset(code).name);
  }
  return { ids, missing };
}

function BasisField({
  clauses,
  value,
  onChange,
  error,
}: {
  clauses: TenantClauses;
  value: string;
  onChange: (v: string) => void;
  error: { message: string; settingLink?: string | null } | null;
}) {
  // Договоры не ведутся — поля основания нет вовсе (настройка организации «Вести договоры»).
  const track = useTrackContracts();
  if (!track) return null;
  const nothingToPick = clauses.options.length === 0;
  return (
    <Field
      label="Основание (необязательно)"
      hint={
        nothingToPick
          ? 'Не нужно: пунктов договора нет. Захотите ссылаться на пункт — добавьте его на вкладке «Договор».'
          : 'Пункт договора, на который опирается лимит. Видно в журнале и в подсказках.'
      }
      error={error}
    >
      <Select value={value} disabled={nothingToPick} onChange={(e) => onChange(e.target.value)}>
        <option value="">{nothingToPick ? '— не нужно —' : '— без основания —'}</option>
        {clauses.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function QuotaFields({ f, env }: { f: FormController<QuotaValues>; env: QuotaEnv }) {
  const { register, watch, setValue } = f.form;
  const categoryIds = watch('categoryIds');
  const enforcement = watch('enforcement');
  const fromDocks = watch('capacityFromDocks');
  const name = watch('name');
  const capacity = watch('capacity');
  const basis = watch('basisClauseId');
  const set = <K extends keyof QuotaValues>(key: K, value: QuotaValues[K]) =>
    setValue(key, value as never, { shouldDirty: true });

  const categories = [...env.categories].sort((a, b) => a.sort - b.sort);
  const options = categories
    .filter((c) => c.enabled || categoryIds.includes(c.id))
    .map((c) => ({
      value: c.id,
      label: c.enabled ? c.name : `${c.name} (выключен)`,
      ...(c.enabled ? {} : { title: 'Тип выключен в справочнике «Типы транспорта»' }),
    }));
  const selected = categoryIds.flatMap((id) => {
    const c = categories.find((x) => x.id === id);
    return c ? [c] : [];
  });
  const autoName = capitalize(selected.map((c) => c.name).join(' + '));

  // (а) пересечения с другими лимитами арендатора
  const overlaps = env.otherQuotas
    .map((q) => ({
      quota: q,
      shared: q.categoryIds.filter((id) => categoryIds.includes(id)),
    }))
    .filter((x) => x.shared.length > 0);

  // (б) «лимит = числу доков»: предложение, а не молчаливая подстановка
  const dockEligible = selected.length > 0 && selected.every((c) => c.dockEligible);
  const dockCount = env.dockCount;

  const phrase = `${name.trim() || autoName || '…'} — ${
    fromDocks ? 'по докам' : capacity.trim() === '' ? '…' : capacity.trim()
  } · ${ENFORCEMENT_SHORT[enforcement]} · ${env.clauses.refOf(basis || null) ?? 'без основания'}`;

  return (
    <>
      <p className="rounded-md bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
        <span className="text-muted-foreground">Лимит: </span>
        <strong>{phrase}</strong>
      </p>

      <Field
        label="Типы транспорта"
        required={env.mode === 'create'}
        hint="Лимит считает машины всех отмеченных типов вместе."
        error={f.fieldError('categoryIds')}
      >
        <ChipSelect
          label="Типы транспорта"
          options={options}
          value={categoryIds}
          onChange={(next) => set('categoryIds', next)}
        />
      </Field>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Как у договора:</span>
          {PRESETS.map((preset) => {
            const { ids, missing } = presetResolution(preset, categories);
            const reason =
              missing.length > 0
                ? `В объекте не включён тип: ${missing.join(', ')}. Включите его в «Типы транспорта».`
                : undefined;
            return (
              <Button
                key={preset.label}
                size="sm"
                variant="outline"
                disabled={reason !== undefined}
                title={reason ?? `Отметить: ${preset.label.toLowerCase()}`}
                onClick={() => {
                  set('categoryIds', ids);
                  if (env.mode === 'create' && name.trim() === '') set('name', preset.label);
                }}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
        {PRESETS.flatMap((preset) => {
          const { missing } = presetResolution(preset, categories);
          return missing.length > 0
            ? [
                <p key={preset.label} className="text-xs text-warning">
                  «{preset.label}» недоступно: в объекте не включён тип {missing.join(', ')}.
                </p>,
              ]
            : [];
        })}
      </div>

      {overlaps.map(({ quota, shared }) => {
        const names = shared
          .map((id) => categories.find((c) => c.id === id)?.name)
          .filter((n): n is string => n !== undefined);
        return (
          <Alert key={quota.id} tone="info">
            {names.length === 1 ? 'Этот тип' : 'Эти типы'} ({names.join(', ')}) уже{' '}
            {names.length === 1 ? 'входит' : 'входят'} в лимит «{quota.name}» — будут действовать
            оба.
          </Alert>
        );
      })}

      {dockEligible && !fromDocks && dockCount !== null && dockCount > 0 ? (
        <Alert
          tone="info"
          action={
            <Button size="sm" variant="outline" onClick={() => set('capacityFromDocks', true)}>
              Считать по докам
            </Button>
          }
        >
          У арендатора {count(dockCount, 'док', 'дока', 'доков')}. Поставить лимит = числу доков?
        </Alert>
      ) : null}
      {dockEligible && !fromDocks && dockCount === 0 ? (
        <p className="text-xs text-muted-foreground">
          Грузовые обычно едут к доку, но за арендатором пока нет доков. Закрепите доки — тогда
          можно будет поставить лимит = числу доков.
        </p>
      ) : null}

      <Field
        label="Название"
        hint={
          env.mode === 'create'
            ? autoName
              ? `Необязательно. Если пусто, название соберётся из типов: «${autoName}».`
              : 'Необязательно. Если пусто, название соберётся из названий типов.'
            : 'Подпись на табло и в кабинете.'
        }
        error={f.fieldError('name')}
      >
        <Input {...register('name')} placeholder={autoName || 'Например, «Грузовые»'} />
      </Field>

      <div className="space-y-2">
        <Field
          label="Число мест"
          required
          hint="0 — «не предусмотрено договором»: машины этих типов не въедут. Если лимита нет совсем — ограничения нет."
          disabledReason={
            fromDocks ? 'Считается по докам арендатора — число вводить не нужно.' : undefined
          }
          error={f.fieldError('capacity')}
        >
          {fromDocks ? (
            <Input readOnly value={dockCount ?? ''} aria-label="Число мест по докам" />
          ) : (
            <Input type="number" min={0} step={1} inputMode="numeric" {...register('capacity')} />
          )}
        </Field>
        <Checkbox
          label="Лимит = числу доков арендатора"
          hint={
            dockCount === null
              ? 'Число считает сервер по действующим назначениям доков.'
              : `Сейчас доков: ${dockCount}. Число пересчитывается при изменении назначений.`
          }
          checked={fromDocks}
          onChange={(e) => set('capacityFromDocks', e.target.checked)}
        />
        {fromDocks && dockCount === 0 ? (
          <Alert tone="warning">
            У арендатора нет доков, поэтому лимит будет 0 — машины этих типов не въедут. Закрепите
            доки арендатору.
          </Alert>
        ) : null}
      </div>

      <Field label="Режим" required error={f.fieldError('enforcement')}>
        <Select {...register('enforcement')}>
          {(Object.keys(ENFORCEMENT_LABEL) as QuotaEnforcement[]).map((value) => (
            <option key={value} value={value}>
              {ENFORCEMENT_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Тариф за сверхлимит, ₽ за сутки"
          hint={enforcement === 'soft' ? 'Пусто — сверхлимит записывается без суммы.' : undefined}
          disabledReason={
            enforcement === 'soft'
              ? undefined
              : 'Тариф есть только у мягкого лимита — выберите режим «мягкий».'
          }
          error={f.fieldError('overageTariffRub')}
        >
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            {...register('overageTariffRub')}
          />
        </Field>
        <Field
          label="Потолок сверхлимита, машин"
          hint={
            enforcement === 'soft' ? 'Пусто — без потолка. Сверх потолка машина ждёт.' : undefined
          }
          disabledReason={
            enforcement === 'soft'
              ? undefined
              : 'Потолок есть только у мягкого лимита — выберите режим «мягкий».'
          }
          error={f.fieldError('overageCap')}
        >
          <Input type="number" min={0} step={1} inputMode="numeric" {...register('overageCap')} />
        </Field>
      </div>

      <BasisField
        clauses={env.clauses}
        value={basis}
        onChange={(v) => set('basisClauseId', v)}
        error={f.fieldError('basisClauseId')}
      />
    </>
  );
}

function CreateQuotaForm({
  siteId,
  tenantId,
  env,
  onDone,
}: {
  siteId: string;
  tenantId: string;
  env: QuotaEnv;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<QuotaValues>({
    schema: QuotaFormCreateSchema,
    initial: NEW_QUOTA,
    toBody: (v) => ({
      tenantId,
      categoryIds: v.categoryIds,
      enforcement: v.enforcement,
      ...(v.name.trim() ? { name: v.name.trim() } : {}),
      ...(v.capacityFromDocks
        ? { capacityFromDocks: true }
        : v.capacity.trim() !== ''
          ? { capacity: Number(v.capacity) }
          : {}),
      ...(v.enforcement === 'soft'
        ? {
            overageTariffRub: v.overageTariffRub.trim() === '' ? null : Number(v.overageTariffRub),
            overageCap: v.overageCap.trim() === '' ? null : Number(v.overageCap),
          }
        : {}),
      ...(v.basisClauseId ? { basisClauseId: v.basisClauseId } : {}),
    }),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/quotas`, 'POST', body);
      toast('Лимит добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить лимит">
      <QuotaFields f={f} env={env} />
    </EditForm>
  );
}

function EditQuotaForm({
  quota,
  env,
  onDone,
}: {
  quota: QuotaView;
  env: QuotaEnv;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<QuotaValues>({
    values: {
      name: quota.name,
      categoryIds: [...quota.categoryIds],
      capacity: String(quota.capacity),
      capacityFromDocks: quota.capacityFromDocks,
      enforcement: quota.enforcement,
      overageTariffRub: quota.overageTariffRub === null ? '' : String(quota.overageTariffRub),
      overageCap: quota.overageCap === null ? '' : String(quota.overageCap),
      basisClauseId: quota.basisClauseId ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.categoryIds !== undefined) body.categoryIds = patch.categoryIds;
      if (patch.enforcement !== undefined) body.enforcement = patch.enforcement;
      if (patch.capacityFromDocks !== undefined) body.capacityFromDocks = patch.capacityFromDocks;
      const fromDocks = patch.capacityFromDocks ?? quota.capacityFromDocks;
      if (patch.capacity !== undefined && !fromDocks) {
        body.capacity = intFromText('capacity', patch.capacity, { label: 'Число мест', min: 0 });
      }
      if ((patch.enforcement ?? quota.enforcement) === 'soft') {
        if (patch.overageTariffRub !== undefined) {
          const text = patch.overageTariffRub.trim().replace(',', '.');
          const value = text === '' ? null : Number(text);
          if (value !== null && Number.isNaN(value)) {
            throw fieldProblem('overageTariffRub', 'Тариф — число, например 67.');
          }
          body.overageTariffRub = value;
        }
        if (patch.overageCap !== undefined) {
          body.overageCap = intFromText('overageCap', patch.overageCap, {
            label: 'Потолок сверхлимита',
            min: 0,
            emptyAsNull: true,
          });
        }
      }
      if (patch.basisClauseId !== undefined) body.basisClauseId = patch.basisClauseId || null;
      if (Object.keys(body).length === 0) {
        throw fieldProblem(
          null,
          'Изменённые поля сейчас не используются: тариф и потолок задаются только у мягкого лимита, число — если лимит не «по докам».',
        );
      }
      assertValid(QuotaFormPatchSchema, body);
      await mutate(`/quotas/${quota.id}`, 'PATCH', body);
      toast('Лимит сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <QuotaFields f={f} env={env} />
    </EditForm>
  );
}

/** Одна фраза лимита: «Грузовые — 25 · жёсткий · п. 3.1». */
function quotaPhrase(q: QuotaView, clauses: TenantClauses): string {
  const size = q.capacityFromDocks ? `${q.capacity} (по докам)` : String(q.capacity);
  return `${q.name} — ${size} · ${ENFORCEMENT_SHORT[q.enforcement]} · ${
    clauses.refOf(q.basisClauseId) ?? 'без основания'
  }`;
}

/** Что увидит охранник, когда лимит заполнен. */
function guardLine(q: QuotaView): string {
  if (q.capacity === 0) {
    return `${q.name}: не предусмотрено договором (лимит 0) — машина не въедет`;
  }
  const head = `${q.name} ${q.capacity}/${q.capacity}`;
  if (q.enforcement === 'hard') return `${head} — машина будет ждать`;
  if (q.enforcement === 'soft') {
    const tariff =
      q.overageTariffRub === null ? 'тариф не задан' : `${rub(q.overageTariffRub)} ₽ за сутки`;
    const ceiling =
      q.overageCap === null ? '' : `; сверх лимита не больше ${q.overageCap}, дальше ждать`;
    return `${head} — пропустит, сверхлимит запишется (${tariff})${ceiling}`;
  }
  return `${head} — предупреждение, пропустит`;
}

/**
 * Лимиты арендатора — главная форма: «Лимит: [типы] — [число] · режим · основание» (ADR-012 п. 4).
 * Нет лимита ≠ лимит 0 (Q-7). Пешеходные лимиты здесь не настраиваются (Q-43).
 */
export function QuotasCard({ tenantId }: { tenantId: string }) {
  return (
    <RequireSite>
      {(site) => <QuotasBody siteId={site.id} timezone={site.timezone} tenantId={tenantId} />}
    </RequireSite>
  );
}

function QuotasBody({
  siteId,
  timezone,
  tenantId,
}: {
  siteId: string;
  timezone: string;
  tenantId: string;
}) {
  const perms = usePermissions();
  const canQuota = !perms.loaded || perms.can('quota.manage');
  const canTenant = !perms.loaded || perms.can('tenant.manage');
  const quotas = useQuotas(canQuota ? siteId : null);
  const categories = useCategories(siteId, true);
  const docks = useDocks(siteId);
  const assignments = useDockAssignments(canTenant ? tenantId : null);
  const track = useTrackContracts();
  const clauses = useTenantClauses(canTenant && track ? tenantId : null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QuotaView | null>(null);

  if (!canQuota) {
    return (
      <Section title="Лимиты">
        <Alert tone="warning">
          Настраивать лимиты может пользователь с правом «управление лимитами». Обратитесь к
          администратору.
        </Alert>
      </Section>
    );
  }
  if (quotas.error) return <LoadError error={quotas.error} retry={() => void quotas.refetch()} />;

  const today = siteToday(timezone);
  const items = (quotas.items ?? []).filter(
    (q) => q.tenantId === tenantId && q.participant === 'vehicle',
  );
  const countingDocks = new Set(
    (docks.items ?? []).filter((d) => d.countsInQuota).map((d) => d.id),
  );
  const dockCount =
    canTenant && assignments.items && docks.items
      ? assignments.items.filter((a) => countingDocks.has(a.dockId) && isActiveOn(a, today)).length
      : null;
  const envFor = (mode: 'create' | 'edit', selfId?: string): QuotaEnv => ({
    categories: categories.items ?? [],
    otherQuotas: items.filter((q) => q.id !== selfId),
    dockCount,
    clauses,
    mode,
  });
  const loading = quotas.isLoading || categories.isLoading;
  const noTypes = !categories.isLoading && (categories.items ?? []).every((c) => !c.enabled);
  const typeName = (id: string) => categories.items?.find((c) => c.id === id)?.name ?? '?';

  return (
    <>
      <Section
        title="Лимиты"
        description="Сколько машин выбранных типов может быть на территории одновременно. Считаются открытые визиты — въехал и не выехал."
        actions={
          <Button
            size="sm"
            disabled={noTypes}
            title={noTypes ? 'Сначала включите типы транспорта.' : undefined}
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden /> Добавить лимит
          </Button>
        }
      >
        {noTypes ? (
          <Alert tone="warning" className="mb-3">
            На объекте не включён ни один тип транспорта — лимит ставится на типы. Включите их в
            «Типы транспорта».
          </Alert>
        ) : null}
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="У арендатора нет лимитов"
            hint="Нет лимита — без ограничения; 0 — запрет договором. Добавьте лимит, если договор ограничивает число машин."
            action={
              <Button disabled={noTypes} onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Добавить лимит
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="font-medium">{quotaPhrase(q, clauses)}</p>
                  <p className="text-xs text-muted-foreground">
                    Считает: {q.categoryIds.map(typeName).join(', ') || 'типы не отмечены'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {q.capacity === 0 ? <Badge tone="danger">запрет договором</Badge> : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Изменить лимит: ${q.name}`}
                    onClick={() => setEditing(q)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <DeleteAction
                    collection="quotas"
                    id={q.id}
                    name={`лимит «${q.name}»`}
                    title="Удалить лимит?"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {items.length > 0 ? (
        <GuardPreview>
          <ul className="list-disc space-y-0.5 pl-5">
            {items.map((q) => (
              <li key={q.id}>{guardLine(q)}</li>
            ))}
          </ul>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Новый лимит</DialogTitle>
            <DialogDescription>
              Типы транспорта, число мест, режим и (по желанию) основание — пункт договора.
            </DialogDescription>
          </DialogHeader>
          <CreateQuotaForm
            siteId={siteId}
            tenantId={tenantId}
            env={envFor('create')}
            onDone={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Лимит «{editing?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditQuotaForm
              quota={editing}
              env={envFor('edit', editing.id)}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

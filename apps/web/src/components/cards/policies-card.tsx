import {
  APPROVAL_CREATOR_KINDS,
  APPROVAL_MODES,
  type ApprovalCreatorKind,
  type ApprovalMode,
  ApprovalPolicyCreateSchema,
  ApprovalPolicyPatchSchema,
  type ApprovalTimeoutAction,
  PASS_TYPES,
  type PassType,
  type SiteSettings,
  SiteSettingsPatchSchema,
  TimeWindowPolicyCreateSchema,
  TimeWindowPolicyPatchSchema,
  type WindowViolationMode,
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
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import {
  type ApprovalPolicyView,
  type CategoryView,
  type SiteView,
  type TimeWindowPolicyView,
  useApprovalGaps,
  useApprovalPolicies,
  useCategories,
  useMutate,
  useTenants,
  useTimeWindows,
} from '../../lib/data';
import { APPROVAL_MODE_LABEL, CREATOR_LABEL, PASS_TYPE_LABEL } from '../../lib/labels';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { assertValid, fieldProblem, intFromText, usePermissions } from './tenant-rule-helpers';

/**
 * Политики объекта (шаг 8): сроки и рабочее время, окна прибытия, согласование пропусков.
 * Исключения и правила для пешеходов — отдельные карточки.
 */
export function PoliciesCard() {
  return (
    <RequireSite>
      {(site) => (
        <>
          <SettingsSection site={site} />
          <WindowsSection site={site} />
          <ApprovalSection site={site} />
        </>
      )}
    </RequireSite>
  );
}

// ── Сроки и рабочее время ────────────────────────────────────────────────────────────────────

type OutsideMode = SiteSettings['outsideWorkingHours'];

const OUTSIDE_LABEL: Record<OutsideMode, string> = {
  deny: 'не пускать — отказ',
  warn: 'пускать, охранник увидит предупреждение',
  allow: 'пускать без предупреждения',
};

interface SettingsValues {
  singlePassMaxHours: string;
  multiPassMinDays: string;
  multiPassMaxDays: string;
  singleReturnWindowMin: string;
  outsideWorkingHours: OutsideMode;
  gateRequestTimeoutMin: string;
  pastStartToleranceMin: string;
  permanentPassReviewMonths: string;
  dutyAdminPhone: string;
}

type IntKey =
  | 'singlePassMaxHours'
  | 'multiPassMinDays'
  | 'multiPassMaxDays'
  | 'singleReturnWindowMin'
  | 'gateRequestTimeoutMin'
  | 'pastStartToleranceMin'
  | 'permanentPassReviewMonths';

const INT_SETTINGS: Record<
  IntKey,
  { label: string; min: number; max?: number; nullable?: boolean }
> = {
  singlePassMaxHours: { label: 'Разовый пропуск: действует не дольше, часов', min: 1 },
  multiPassMinDays: { label: 'Многоразовый пропуск: срок от, дней', min: 1 },
  multiPassMaxDays: { label: 'Многоразовый пропуск: срок до, дней', min: 1 },
  singleReturnWindowMin: { label: 'Возврат по разовому пропуску, минут', min: 1, nullable: true },
  gateRequestTimeoutMin: { label: 'Запрос «машина без пропуска» ждёт ответа, минут', min: 1 },
  pastStartToleranceMin: {
    label: 'Допуск на начало пропуска в прошлом, минут',
    min: 0,
    max: 1440,
  },
  permanentPassReviewMonths: { label: 'Ревизия постоянных пропусков, месяцев', min: 1 },
};

function settingsValues(site: SiteView): SettingsValues {
  const s = site.settings;
  return {
    singlePassMaxHours: String(s.singlePassMaxHours),
    multiPassMinDays: String(s.multiPassMinDays),
    multiPassMaxDays: String(s.multiPassMaxDays),
    singleReturnWindowMin: s.singleReturnWindowMin === null ? '' : String(s.singleReturnWindowMin),
    outsideWorkingHours: s.outsideWorkingHours,
    gateRequestTimeoutMin: String(s.gateRequestTimeoutMin),
    pastStartToleranceMin: String(s.pastStartToleranceMin),
    permanentPassReviewMonths: String(s.permanentPassReviewMonths),
    dutyAdminPhone: s.dutyAdminPhone ?? '',
  };
}

function SettingsSection({ site }: { site: SiteView }) {
  const mutate = useMutate();
  const toast = useToast();
  const perms = usePermissions();
  const canEdit = !perms.loaded || perms.can('site.manage');
  const f = useEditForm<SettingsValues>({
    values: settingsValues(site),
    onPatch: async (patch) => {
      const settings: Record<string, unknown> = {};
      for (const key of Object.keys(INT_SETTINGS) as IntKey[]) {
        const text = patch[key];
        if (text === undefined) continue;
        const rule = INT_SETTINGS[key];
        settings[key] = rule.nullable
          ? intFromText(key, text, { ...rule, emptyAsNull: true })
          : intFromText(key, text, rule);
      }
      if (patch.outsideWorkingHours !== undefined) {
        settings.outsideWorkingHours = patch.outsideWorkingHours;
      }
      if (patch.dutyAdminPhone !== undefined) {
        settings.dutyAdminPhone = patch.dutyAdminPhone.trim() || null;
      }
      const min =
        (settings.multiPassMinDays as number | undefined) ?? site.settings.multiPassMinDays;
      const max =
        (settings.multiPassMaxDays as number | undefined) ?? site.settings.multiPassMaxDays;
      if (min > max) {
        throw fieldProblem(
          'multiPassMaxDays',
          `Срок многоразового пропуска: «до» (${max}) не может быть меньше «от» (${min}).`,
        );
      }
      assertValid(SiteSettingsPatchSchema, settings);
      await mutate(`/sites/${site.id}`, 'PATCH', { settings });
      toast('Сроки и рабочее время сохранены');
    },
  });
  const { register } = f.form;
  return (
    <Section
      title="Сроки и рабочее время"
      description="Как долго действуют пропуска и что делать при въезде вне рабочего времени объекта. Рабочее время объекта задаётся в карточке «Объект»."
    >
      {canEdit ? null : (
        <Alert tone="warning" className="mb-4">
          Менять сроки может пользователь с правом «настройки объекта». Сейчас значения только для
          просмотра.
        </Alert>
      )}
      <fieldset disabled={!canEdit} className="min-w-0 border-0 p-0">
        <EditForm form={f}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={INT_SETTINGS.singlePassMaxHours.label}
              hint="Дольше этого разовый пропуск оформить нельзя."
              error={f.fieldError('singlePassMaxHours')}
            >
              <Input type="number" min={1} step={1} {...register('singlePassMaxHours')} />
            </Field>
            <Field
              label={INT_SETTINGS.singleReturnWindowMin.label}
              hint="Сколько минут после выезда можно вернуться по тому же разовому пропуску. Пусто — выключено: после выезда разовый пропуск использован."
              error={f.fieldError('singleReturnWindowMin')}
            >
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="выключено"
                {...register('singleReturnWindowMin')}
              />
            </Field>
            <Field
              label={INT_SETTINGS.multiPassMinDays.label}
              hint="Минимальный срок многоразового пропуска."
              error={f.fieldError('multiPassMinDays')}
            >
              <Input type="number" min={1} step={1} {...register('multiPassMinDays')} />
            </Field>
            <Field
              label={INT_SETTINGS.multiPassMaxDays.label}
              hint="Максимальный срок многоразового пропуска."
              error={f.fieldError('multiPassMaxDays')}
            >
              <Input type="number" min={1} step={1} {...register('multiPassMaxDays')} />
            </Field>
            <Field
              label="Въезд вне рабочего времени объекта"
              error={f.fieldError('outsideWorkingHours')}
              className="sm:col-span-2"
            >
              <Select {...register('outsideWorkingHours')}>
                {(Object.keys(OUTSIDE_LABEL) as OutsideMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {OUTSIDE_LABEL[mode]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={INT_SETTINGS.gateRequestTimeoutMin.label}
              hint="Если никто не ответил — запрос закрывается."
              error={f.fieldError('gateRequestTimeoutMin')}
            >
              <Input type="number" min={1} step={1} {...register('gateRequestTimeoutMin')} />
            </Field>
            <Field
              label={INT_SETTINGS.pastStartToleranceMin.label}
              hint="От 0 до 1440. Начало пропуска раньше «сейчас» больше чем на это время не принимается."
              error={f.fieldError('pastStartToleranceMin')}
            >
              <Input
                type="number"
                min={0}
                max={1440}
                step={1}
                {...register('pastStartToleranceMin')}
              />
            </Field>
            <Field
              label={INT_SETTINGS.permanentPassReviewMonths.label}
              hint="Через сколько месяцев напоминать о проверке постоянных пропусков."
              error={f.fieldError('permanentPassReviewMonths')}
            >
              <Input type="number" min={1} step={1} {...register('permanentPassReviewMonths')} />
            </Field>
            <Field
              label="Телефон дежурного администратора"
              hint="Показывается внизу экрана поста. Пусто — строка не показывается."
              error={f.fieldError('dutyAdminPhone')}
            >
              <Input type="tel" autoComplete="off" {...register('dutyAdminPhone')} />
            </Field>
          </div>
        </EditForm>
      </fieldset>
    </Section>
  );
}

// ── Окна прибытия ────────────────────────────────────────────────────────────────────────────

const VIOLATION_LABEL: Record<WindowViolationMode, string> = {
  hard: 'отказать (жёстко)',
  warn: 'предупредить и пропустить',
};

const MINUTES = (label: string) =>
  z.int(`${label} — целое число минут.`).min(0, `${label} не может быть отрицательным.`);

const WindowFormCreateSchema = TimeWindowPolicyCreateSchema.extend({
  earlyToleranceMin: MINUTES('Допуск «раньше»'),
  lateToleranceMin: MINUTES('Допуск «опоздание»').nullable().optional(),
});

interface WindowValues {
  categoryIds: string[];
  windowRequired: boolean;
  earlyToleranceMin: string;
  lateToleranceMin: string;
  onViolation: WindowViolationMode;
}

const NEW_WINDOW: WindowValues = {
  categoryIds: [],
  windowRequired: true,
  earlyToleranceMin: '0',
  lateToleranceMin: '',
  onViolation: 'hard',
};

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('ru-RU') + text.slice(1);

/** «Фура: окно обязательно, раньше не пускать, опоздание до 60 мин». */
function windowPhrase(v: {
  typeNames: string[];
  windowRequired: boolean;
  early: number | null;
  late: number | null;
  onViolation: WindowViolationMode;
}): string {
  const types = v.typeNames.length === 0 ? 'Все типы' : capitalize(v.typeNames.join(', '));
  const early =
    v.early === null
      ? 'допуск «раньше» не указан'
      : v.early === 0
        ? 'раньше не пускать'
        : `раньше окна можно за ${v.early} мин`;
  const late = v.late === null ? 'опоздание без ограничения' : `опоздание до ${v.late} мин`;
  const violation = v.onViolation === 'warn' ? ', при опоздании — только предупреждение' : '';
  return `${types}: окно ${v.windowRequired ? 'обязательно' : 'не обязательно'}, ${early}, ${late}${violation}`;
}

function numberOrNull(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

function WindowFields({
  f,
  categories,
}: {
  f: FormController<WindowValues>;
  categories: readonly CategoryView[];
}) {
  const { register, watch, setValue } = f.form;
  const categoryIds = watch('categoryIds');
  const windowRequired = watch('windowRequired');
  const onViolation = watch('onViolation');
  const sorted = [...categories].sort((a, b) => a.sort - b.sort);
  const options = sorted
    .filter((c) => c.enabled || categoryIds.includes(c.id))
    .map((c) => ({ value: c.id, label: c.enabled ? c.name : `${c.name} (выключен)` }));
  const names = categoryIds.flatMap((id) => {
    const c = categories.find((x) => x.id === id);
    return c ? [c.name] : [];
  });
  return (
    <>
      <Field
        label="Типы транспорта"
        hint="Ничего не отмечено — политика действует для всех типов."
        error={f.fieldError('categoryIds')}
      >
        <ChipSelect
          label="Типы транспорта"
          options={options}
          value={categoryIds}
          onChange={(next) => setValue('categoryIds', next, { shouldDirty: true })}
        />
      </Field>
      <Checkbox
        label="Окно прибытия обязательно"
        hint="Без окна пропуск этого типа не выпустят: охранник увидит отказ."
        checked={windowRequired}
        onChange={(e) => setValue('windowRequired', e.target.checked, { shouldDirty: true })}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Допуск «раньше», минут"
          required
          hint="0 — раньше окна не пускать: машина ждёт."
          error={f.fieldError('earlyToleranceMin')}
        >
          <Input type="number" min={0} step={1} {...register('earlyToleranceMin')} />
        </Field>
        <Field
          label="Допуск «опоздание», минут"
          hint="Пусто — без ограничения (до конца пропуска)."
          error={f.fieldError('lateToleranceMin')}
        >
          <Input type="number" min={0} step={1} {...register('lateToleranceMin')} />
        </Field>
      </div>
      <Field
        label="При опоздании сверх допуска"
        hint="Рано приехавшая машина всегда ждёт."
        error={f.fieldError('onViolation')}
      >
        <Select {...register('onViolation')}>
          {(Object.keys(VIOLATION_LABEL) as WindowViolationMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {VIOLATION_LABEL[mode]}
            </option>
          ))}
        </Select>
      </Field>
      <p className="rounded-md bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
        <span className="text-muted-foreground">Охранник получит: </span>
        {windowPhrase({
          typeNames: names,
          windowRequired,
          early: numberOrNull(watch('earlyToleranceMin')),
          late: numberOrNull(watch('lateToleranceMin')),
          onViolation,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        Пример: «Фура: окно обязательно, раньше не пускать, опоздание до 60 мин».
      </p>
    </>
  );
}

function CreateWindowForm({
  siteId,
  categories,
  onDone,
}: {
  siteId: string;
  categories: readonly CategoryView[];
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<WindowValues>({
    schema: WindowFormCreateSchema,
    initial: NEW_WINDOW,
    toBody: (v) => ({
      categoryIds: v.categoryIds,
      windowRequired: v.windowRequired,
      earlyToleranceMin:
        v.earlyToleranceMin.trim() === '' ? Number.NaN : Number(v.earlyToleranceMin),
      lateToleranceMin: v.lateToleranceMin.trim() === '' ? null : Number(v.lateToleranceMin),
      onViolation: v.onViolation,
    }),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/time-window-policies`, 'POST', body);
      toast('Политика окна добавлена');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить политику">
      <WindowFields f={f} categories={categories} />
    </EditForm>
  );
}

function EditWindowForm({
  policy,
  categories,
  onDone,
}: {
  policy: TimeWindowPolicyView;
  categories: readonly CategoryView[];
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<WindowValues>({
    values: {
      categoryIds: [...policy.categoryIds],
      windowRequired: policy.windowRequired,
      earlyToleranceMin: String(policy.earlyToleranceMin),
      lateToleranceMin: policy.lateToleranceMin === null ? '' : String(policy.lateToleranceMin),
      onViolation: policy.onViolation,
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.categoryIds !== undefined) body.categoryIds = patch.categoryIds;
      if (patch.windowRequired !== undefined) body.windowRequired = patch.windowRequired;
      if (patch.onViolation !== undefined) body.onViolation = patch.onViolation;
      if (patch.earlyToleranceMin !== undefined) {
        body.earlyToleranceMin = intFromText('earlyToleranceMin', patch.earlyToleranceMin, {
          label: 'Допуск «раньше»',
          min: 0,
        });
      }
      if (patch.lateToleranceMin !== undefined) {
        body.lateToleranceMin = intFromText('lateToleranceMin', patch.lateToleranceMin, {
          label: 'Допуск «опоздание»',
          min: 0,
          emptyAsNull: true,
        });
      }
      assertValid(TimeWindowPolicyPatchSchema, body);
      await mutate(`/time-window-policies/${policy.id}`, 'PATCH', body);
      toast('Политика окна сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <WindowFields f={f} categories={categories} />
    </EditForm>
  );
}

function WindowsSection({ site }: { site: SiteView }) {
  const perms = usePermissions();
  const canRules = !perms.loaded || perms.can('rule.manage');
  const policies = useTimeWindows(canRules ? site.id : null);
  const categories = useCategories(site.id, true);
  const tenants = useTenants(site.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TimeWindowPolicyView | null>(null);
  if (!canRules) {
    return (
      <Section title="Окна прибытия">
        <Alert tone="warning">
          Настраивать политики может пользователь с правом «правила объекта».
        </Alert>
      </Section>
    );
  }
  if (policies.error) {
    return <LoadError error={policies.error} retry={() => void policies.refetch()} />;
  }
  const cats = categories.items ?? [];
  const items = policies.items ?? [];
  const phraseOf = (p: TimeWindowPolicyView) =>
    windowPhrase({
      typeNames: p.categoryIds.flatMap((id) => {
        const c = cats.find((x) => x.id === id);
        return c ? [c.name] : [];
      }),
      windowRequired: p.windowRequired,
      early: p.earlyToleranceMin,
      late: p.lateToleranceMin,
      onViolation: p.onViolation,
    });
  const tenantName = (id: string | null) =>
    id === null ? null : (tenants.items?.find((t) => t.id === id)?.shortName ?? 'арендатор');
  return (
    <>
      <Section
        title="Окна прибытия"
        description="Для каких типов транспорта нужно окно прибытия, насколько раньше можно приехать и что делать при опоздании."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить политику
          </Button>
        }
      >
        {policies.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Политик окна нет"
            hint="Без политики окно прибытия не проверяется. Добавьте политику, например: «Фура: окно обязательно, раньше не пускать, опоздание до 60 мин»."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Добавить политику
              </Button>
            }
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{phraseOf(p)}</p>
                  {p.tenantId ? (
                    <p className="text-xs text-muted-foreground">
                      Только для арендатора: {tenantName(p.tenantId)}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Изменить политику окна"
                    onClick={() => setEditing(p)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <DeleteAction
                    collection="time-window-policies"
                    id={p.id}
                    name="политику окна прибытия"
                    title="Удалить политику окна?"
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
            {items.map((p) => (
              <li key={p.id}>
                {p.earlyToleranceMin === 0
                  ? 'Приехал раньше окна — «ждите».'
                  : `Приехал раньше окна больше чем на ${p.earlyToleranceMin} мин — «ждите».`}{' '}
                {p.lateToleranceMin === null
                  ? 'Опоздание не ограничено.'
                  : p.onViolation === 'hard'
                    ? `Опоздал больше чем на ${p.lateToleranceMin} мин — отказ.`
                    : `Опоздал больше чем на ${p.lateToleranceMin} мин — предупреждение, пропустит.`}{' '}
                <span className="text-muted-foreground">
                  ({p.categoryIds.length === 0 ? 'все типы' : 'выбранные типы'})
                </span>
              </li>
            ))}
          </ul>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новая политика окна</DialogTitle>
            <DialogDescription>Типы, обязательность окна и допуски в минутах.</DialogDescription>
          </DialogHeader>
          <CreateWindowForm siteId={site.id} categories={cats} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Политика окна прибытия</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditWindowForm policy={editing} categories={cats} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Согласование пропусков ──────────────────────────────────────────────────────────────────

const TIMEOUT_LABEL: Record<ApprovalTimeoutAction, string> = {
  reject: 'отклонить пропуск',
  escalate: 'эскалировать администратору',
};

interface ApprovalValues {
  mode: ApprovalMode | '';
  commentRequired: boolean;
  escalationHours: string;
  onTimeout: ApprovalTimeoutAction | '';
}

const ApprovalFormCreateSchema = ApprovalPolicyCreateSchema.extend({
  mode: z.enum(APPROVAL_MODES, { error: 'Выберите, как согласуются такие пропуска.' }),
  escalationHours: z
    .int('Эскалация — целое число часов.')
    .min(1, 'Эскалация — не меньше 1 часа.')
    .nullable()
    .optional(),
}).refine((v) => v.escalationHours == null || Boolean(v.onTimeout), {
  path: ['onTimeout'],
  message: 'Выберите, что делать, если согласующий не ответил.',
});

function ApprovalFields({
  f,
  creatorLabel,
  passLabel,
}: {
  f: FormController<ApprovalValues>;
  creatorLabel: string;
  passLabel: string;
}) {
  const { register, watch } = f.form;
  const mode = watch('mode');
  const reason =
    mode === 'on_request'
      ? undefined
      : 'Эскалация есть только у режима «на согласование» — выберите его.';
  return (
    <>
      <p className="text-sm">
        Кто создаёт: <strong>{creatorLabel}</strong> · тип пропуска: <strong>{passLabel}</strong>
      </p>
      <Field label="Режим" required error={f.fieldError('mode')}>
        <Select {...register('mode')}>
          <option value="" disabled>
            — выберите —
          </option>
          {APPROVAL_MODES.map((m) => (
            <option key={m} value={m}>
              {APPROVAL_MODE_LABEL[m]}
            </option>
          ))}
        </Select>
      </Field>
      <Checkbox
        label="Комментарий обязателен"
        hint="Автор пропуска должен написать, зачем он нужен."
        {...register('commentRequired')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Эскалация через, часов"
          hint="Пусто — не эскалировать."
          disabledReason={reason}
          error={f.fieldError('escalationHours')}
        >
          <Input type="number" min={1} step={1} {...register('escalationHours')} />
        </Field>
        <Field label="Если не ответили" disabledReason={reason} error={f.fieldError('onTimeout')}>
          <Select {...register('onTimeout')}>
            <option value="">— не выбрано —</option>
            {(Object.keys(TIMEOUT_LABEL) as ApprovalTimeoutAction[]).map((a) => (
              <option key={a} value={a}>
                {TIMEOUT_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
  );
}

function CreateApprovalForm({
  siteId,
  creatorKind,
  passType,
  onDone,
}: {
  siteId: string;
  creatorKind: ApprovalCreatorKind;
  passType: PassType;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<ApprovalValues>({
    schema: ApprovalFormCreateSchema,
    initial: { mode: '', commentRequired: false, escalationHours: '', onTimeout: '' },
    toBody: (v) => ({
      creatorKind,
      passType,
      mode: v.mode,
      commentRequired: v.commentRequired,
      ...(v.mode === 'on_request' && v.escalationHours.trim() !== ''
        ? { escalationHours: Number(v.escalationHours) }
        : {}),
      ...(v.mode === 'on_request' && v.onTimeout !== '' ? { onTimeout: v.onTimeout } : {}),
    }),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/approval-policies`, 'POST', body);
      toast('Политика согласования задана');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Задать политику">
      <ApprovalFields
        f={f}
        creatorLabel={CREATOR_LABEL[creatorKind]}
        passLabel={PASS_TYPE_LABEL[passType]}
      />
    </EditForm>
  );
}

function EditApprovalForm({ policy, onDone }: { policy: ApprovalPolicyView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<ApprovalValues>({
    values: {
      mode: policy.mode,
      commentRequired: policy.commentRequired,
      escalationHours: policy.escalationHours === null ? '' : String(policy.escalationHours),
      onTimeout: policy.onTimeout ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.mode !== undefined && patch.mode !== '') body.mode = patch.mode;
      if (patch.commentRequired !== undefined) body.commentRequired = patch.commentRequired;
      const finalMode = patch.mode || policy.mode;
      if (finalMode === 'on_request') {
        if (patch.escalationHours !== undefined) {
          body.escalationHours = intFromText('escalationHours', patch.escalationHours, {
            label: 'Эскалация через, часов',
            min: 1,
            emptyAsNull: true,
          });
        }
        if (patch.onTimeout !== undefined) body.onTimeout = patch.onTimeout || null;
        const hours =
          'escalationHours' in body
            ? (body.escalationHours as number | null)
            : policy.escalationHours;
        const timeout = 'onTimeout' in body ? body.onTimeout : policy.onTimeout;
        if (hours !== null && !timeout) {
          throw fieldProblem('onTimeout', 'Выберите, что делать, если согласующий не ответил.');
        }
      }
      if (Object.keys(body).length === 0) {
        throw fieldProblem(
          null,
          'Изменённые поля сейчас не используются: эскалация действует только в режиме «на согласование».',
        );
      }
      assertValid(ApprovalPolicyPatchSchema, body);
      await mutate(`/approval-policies/${policy.id}`, 'PATCH', body);
      toast('Политика согласования сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <ApprovalFields
        f={f}
        creatorLabel={CREATOR_LABEL[policy.creatorKind]}
        passLabel={PASS_TYPE_LABEL[policy.passType]}
      />
    </EditForm>
  );
}

type ApprovalTarget =
  | { kind: 'edit'; policy: ApprovalPolicyView }
  | { kind: 'create'; creatorKind: ApprovalCreatorKind; passType: PassType };

function escalationText(p: ApprovalPolicyView): string {
  if (p.mode !== 'on_request') return '—';
  if (p.escalationHours === null) return 'не эскалируется';
  const action = p.onTimeout ? TIMEOUT_LABEL[p.onTimeout] : 'действие не выбрано';
  return `через ${p.escalationHours} ч: ${action}`;
}

function ApprovalSection({ site }: { site: SiteView }) {
  const perms = usePermissions();
  const canRules = !perms.loaded || perms.can('rule.manage');
  const policies = useApprovalPolicies(canRules ? site.id : null);
  const gaps = useApprovalGaps(canRules ? site.id : null);
  const [target, setTarget] = useState<ApprovalTarget | null>(null);
  if (!canRules) {
    return (
      <Section title="Согласование пропусков">
        <Alert tone="warning">
          Настраивать политики может пользователь с правом «правила объекта».
        </Alert>
      </Section>
    );
  }
  if (policies.error) {
    return <LoadError error={policies.error} retry={() => void policies.refetch()} />;
  }
  // политики объекта — без привязки к арендатору; по одной на сочетание
  const siteWide = (policies.items ?? []).filter((p) => p.tenantId === null);
  const find = (c: ApprovalCreatorKind, t: PassType) =>
    siteWide.find((p) => p.creatorKind === c && p.passType === t);
  const gapMessages = gaps.items ?? [];

  return (
    <>
      <Section
        title="Согласование пропусков"
        description="Кто какие пропуска может создавать без согласования, кому нужно согласие директора, а что запрещено."
      >
        {gapMessages.length > 0 ? (
          <Alert
            tone="warning"
            title="Политика не задана — такие пропуска уходят на согласование"
            className="mb-4"
          >
            <ul className="list-disc pl-5">
              {gapMessages.map((g) => (
                <li key={`${g.creatorKind}:${g.passType}`}>{g.message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {policies.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Кто создаёт</TH>
                <TH>Тип пропуска</TH>
                <TH>Режим</TH>
                <TH>Комментарий</TH>
                <TH>Эскалация</TH>
                <TH className="w-28" />
              </TR>
            </THead>
            <TBody>
              {APPROVAL_CREATOR_KINDS.flatMap((creatorKind) =>
                PASS_TYPES.map((passType) => {
                  const policy = find(creatorKind, passType);
                  return (
                    <TR key={`${creatorKind}:${passType}`}>
                      <TD className="font-medium">{capitalize(CREATOR_LABEL[creatorKind])}</TD>
                      <TD>{capitalize(PASS_TYPE_LABEL[passType])}</TD>
                      {policy ? (
                        <>
                          <TD>
                            <Badge
                              tone={
                                policy.mode === 'allow'
                                  ? 'success'
                                  : policy.mode === 'on_request'
                                    ? 'warning'
                                    : 'danger'
                              }
                            >
                              {APPROVAL_MODE_LABEL[policy.mode]}
                            </Badge>
                          </TD>
                          <TD>{policy.commentRequired ? 'обязателен' : 'не нужен'}</TD>
                          <TD className="text-muted-foreground">{escalationText(policy)}</TD>
                          <TD>
                            <div className="flex justify-end">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Изменить: ${CREATOR_LABEL[creatorKind]}, ${PASS_TYPE_LABEL[passType]}`}
                                onClick={() => setTarget({ kind: 'edit', policy })}
                              >
                                <Pencil aria-hidden />
                              </Button>
                            </div>
                          </TD>
                        </>
                      ) : (
                        <>
                          <TD colSpan={3}>
                            <Badge tone="warning">не задана</Badge>{' '}
                            <span className="text-xs text-muted-foreground">
                              такие пропуска уходят на согласование
                            </span>
                          </TD>
                          <TD>
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setTarget({ kind: 'create', creatorKind, passType })}
                              >
                                Задать
                              </Button>
                            </div>
                          </TD>
                        </>
                      )}
                    </TR>
                  );
                }),
              )}
            </TBody>
          </Table>
        )}
      </Section>
      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Политика согласования</DialogTitle>
            <DialogDescription>
              {target?.kind === 'create'
                ? 'Выберите режим явно — по умолчанию ничего не подставляется.'
                : 'Сохраняются только изменённые поля. Кто создаёт и тип пропуска не меняются.'}
            </DialogDescription>
          </DialogHeader>
          {target?.kind === 'edit' ? (
            <EditApprovalForm policy={target.policy} onDone={() => setTarget(null)} />
          ) : null}
          {target?.kind === 'create' ? (
            <CreateApprovalForm
              siteId={site.id}
              creatorKind={target.creatorKind}
              passType={target.passType}
              onDone={() => setTarget(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

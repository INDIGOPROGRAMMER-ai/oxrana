import {
  type CabinetContext,
  FIELD_MODE_LABELS,
  PASS_FORM_FIELD_LABELS,
  PASS_FORM_SOURCE_LABELS,
  type PassFormEditor,
  type PassFormFieldKey,
  type PassFormLevel,
  type PassFormSettings,
  type PassFormSettingsPatch,
  type PassType,
  passFormFieldKeys,
  resolvePassForm,
  type WindowMode,
} from '@oxrana/contracts';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChipSelect,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Input,
  Select,
  Skeleton,
  Switch,
  useToast,
} from '@oxrana/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useApi, useRefresh } from '../../lib/data';
import type { PassFormValues } from '../../lib/pass-form';
import { buildFormView } from '../../lib/pass-form-view';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';
import { endAfter, timeOf } from '../../lib/pass-time';
import { PassFormFields } from '../cabinet/pass-form-fields';

const LEVEL_TITLE: Record<PassFormLevel, string> = {
  site: 'Объект',
  tenant: 'Арендатор',
  user: 'Сотрудник',
};

const LEVEL_HINT: Record<PassFormLevel, string> = {
  site: 'Объект: значения для всех арендаторов и сотрудников.',
  tenant: 'Арендатор: значения для всех сотрудников компании, переопределяют объект.',
  user: 'Сотрудник: значения для одного человека, переопределяют арендатора и объект.',
};

const PERMISSION_NEEDED: Record<PassFormLevel, string> = {
  site: 'Нужно право «Форма пропуска: настройка для объекта и арендаторов».',
  tenant: 'Нужно право «Форма пропуска: настройка для объекта и арендаторов».',
  user: 'Нужно право настраивать форму сотрудников.',
};

const ALL_TYPES: PassType[] = ['single', 'multi', 'permanent'];
const MODES: WindowMode[] = ['hidden', 'optional', 'required'];
const WINDOW_MODES: WindowMode[] = ['policy', 'hidden', 'optional', 'required'];

type Draft = Record<PassFormLevel, PassFormSettings>;

/** Несохранённые правки: сотрудника — вместе с тем, чья это правка (при смене сотрудника не переносится). */
interface Edits {
  site?: PassFormSettings;
  tenant?: PassFormSettings;
  user?: { userId: string; settings: PassFormSettings };
}

const without = <T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = obj;
  return rest;
};

/** Изменение уровня для PATCH: только то, что отличается от сохранённого; убранный ключ — `null` (сброс). */
export function patchOf(saved: PassFormSettings, draft: PassFormSettings): PassFormSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of [
    'categoryIds',
    'defaultCategoryId',
    'passTypes',
    'defaultPassType',
    'singleHours',
    'startNow',
    'repeatYesterday',
  ] as const) {
    const a = JSON.stringify(saved[key] ?? null);
    const b = JSON.stringify(draft[key] ?? null);
    if (a !== b) patch[key] = draft[key] ?? null;
  }
  const fields: Record<string, unknown> = {};
  for (const key of passFormFieldKeys) {
    const a = saved.fields?.[key] ?? null;
    const b = draft.fields?.[key] ?? null;
    if (a !== b) fields[key] = b;
  }
  if (Object.keys(fields).length > 0) patch.fields = fields;
  return patch as PassFormSettingsPatch;
}

/**
 * Редактор формы пропуска (этап 7b, ADR-023): уровни «объект → арендатор → сотрудник», у каждой
 * настройки подпись «откуда значение», «сбросить к уровню выше» и ЖИВОЙ ПРЕДПРОСМОТР формы ровно
 * так, как её увидит выбранный сотрудник. Правится один уровень за раз; сохраняются только
 * изменённые ключи.
 */
export function PassFormEditorView({
  tenantId,
  userId,
  onUserChange,
  startLevel = 'tenant',
}: {
  tenantId: string;
  userId: string | null;
  onUserChange: (userId: string | null) => void;
  startLevel?: PassFormLevel;
}) {
  const editor = useApi<PassFormEditor>(
    `/tenants/${tenantId}/pass-form/editor${userId ? `?userId=${userId}` : ''}`,
  );
  const cabinet = useApi<CabinetContext>(`/tenants/${tenantId}/cabinet`);
  const refresh = useRefresh();
  const toast = useToast();
  const client = useQueryClient();
  const editorPath = `/tenants/${tenantId}/pass-form/editor${userId ? `?userId=${userId}` : ''}`;
  const [level, setLevel] = useState<PassFormLevel>(startLevel);
  // Несохранённые правки по уровням. Черновик = правка уровня или то, что сохранено на сервере, —
  // поэтому перезагрузка данных (после сохранения, по событию объекта) правку не затирает.
  const [edits, setEdits] = useState<Edits>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);

  const saved = editor.data;
  const draft = useMemo<Draft | null>(
    () =>
      saved
        ? {
            site: edits.site ?? saved.layers.site,
            tenant: edits.tenant ?? saved.layers.tenant,
            user:
              edits.user && edits.user.userId === userId
                ? edits.user.settings
                : (saved.layers.user ?? {}),
          }
        : null,
    [saved, edits, userId],
  );

  // нельзя выбрать «Сотрудник», пока сотрудник не выбран
  const activeLevel: PassFormLevel = level === 'user' && !userId ? 'tenant' : level;

  const resolved = useMemo(() => (draft ? resolvePassForm(draft) : null), [draft]);
  const view = useMemo(
    () =>
      resolved && cabinet.data && saved
        ? buildFormView({
            form: resolved,
            ctx: cabinet.data,
            enforced: true,
            allowedPassTypes: saved.subject.passTypes,
            windowRequiredByPolicy: false,
            dockRequired: Boolean(cabinet.data.tenant.trucksDockRequired),
          })
        : null,
    [resolved, cabinet.data, saved],
  );

  if (
    editor.isLoading ||
    cabinet.isLoading ||
    !saved ||
    !draft ||
    !cabinet.data ||
    !resolved ||
    !view
  ) {
    return (
      <div role="status" aria-label="Загрузка" className="space-y-3">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const ctx = cabinet.data;
  const canEdit = saved.canEdit[activeLevel];
  // пока сохраняется и перезагружается — поля заблокированы, нажатие не потеряется
  const editable = canEdit && !busy;
  const layer = draft[activeLevel];
  const savedLayer: PassFormSettings =
    activeLevel === 'user' ? (saved.layers.user ?? {}) : saved.layers[activeLevel];

  // что наследует выбранный уровень от уровней выше
  const above: Draft = {
    site: activeLevel === 'site' ? {} : draft.site,
    tenant: activeLevel === 'user' ? draft.tenant : {},
    user: {},
  };
  const inherited = resolvePassForm(
    activeLevel === 'site'
      ? {}
      : activeLevel === 'tenant'
        ? { site: above.site }
        : { site: draft.site, tenant: above.tenant },
  );

  const savedOf = (l: PassFormLevel): PassFormSettings =>
    l === 'user' ? (saved.layers.user ?? {}) : saved.layers[l];
  const update = (next: PassFormSettings) => {
    // правка, равная сохранённому, правкой не считается: сохранённое потом обновится само
    const same = Object.keys(patchOf(savedOf(activeLevel), next)).length === 0;
    setEdits((e) => {
      if (activeLevel === 'user') {
        const { user: _drop, ...rest } = e;
        return same || !userId ? rest : { ...rest, user: { userId, settings: next } };
      }
      const { [activeLevel]: _drop, ...rest } = e;
      return same ? rest : { ...rest, [activeLevel]: next };
    });
  };
  const otherDirty = (['site', 'tenant', 'user'] as const).filter(
    (l) => l !== activeLevel && Object.keys(patchOf(savedOf(l), draft[l])).length > 0,
  );
  const dirty = Object.keys(patchOf(savedLayer, layer)).length > 0;

  const categories = ctx.categories.filter((c) => c.available);
  const effectiveSource = (key: PassFormFieldKey): string => {
    const src = resolved.sources.fields[key];
    if (src === activeLevel) return PASS_FORM_SOURCE_LABELS[src];
    return `${PASS_FORM_SOURCE_LABELS[src]}${src !== 'default' && levelRank(src) > levelRank(activeLevel) ? ' — перекрывает этот уровень' : ''}`;
  };

  async function save() {
    if (!saved || !draft) return;
    const patch = patchOf(savedLayer, layer);
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setError(null);
    const url =
      activeLevel === 'site'
        ? `/sites/${ctx.site.id}/pass-form`
        : activeLevel === 'tenant'
          ? `/tenants/${tenantId}/pass-form`
          : `/tenants/${tenantId}/users/${userId}/pass-form`;
    try {
      const result = await api<{ settings: PassFormSettings }>(url, {
        method: 'PATCH',
        body: { ...patch, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      });
      // состояние уровня — из ответа сохранения, не из последующей перезагрузки
      client.setQueryData<PassFormEditor>(['data', editorPath], (old) =>
        old ? { ...old, layers: { ...old.layers, [activeLevel]: result.settings } } : old,
      );
      setEdits((e) => {
        const { [activeLevel]: _saved, ...rest } = e;
        return rest;
      });
      await refresh();
      setReason('');
      toast('Настройка формы сохранена — сотрудники увидят её сразу');
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  const previewValues: PassFormValues = {
    participant: 'vehicle',
    plate: '',
    categoryId: view.defaultCategoryId,
    brand: '',
    driverName: '',
    driverPhone: '',
    personName: '',
    personDocument: '',
    passType: view.defaultPassType ?? 'single',
    date: ctx.today,
    startTime: resolved.startNow ? timeOf(Date.parse(ctx.now), ctx.site.timezone) : '',
    endTime: resolved.startNow
      ? endAfter(
          timeOf(Date.parse(ctx.now), ctx.site.timezone),
          resolved.singleHours,
          saved.singlePassMaxHours,
        ).time
      : '',
    startAuto: true,
    endAuto: true,
    windowFromTime: '',
    windowToTime: '',
    from: ctx.today,
    to: '',
    windowFrom: '',
    windowTo: '',
    dockId: view.defaultDockId,
    destinationZoneId: view.defaultZoneId,
    purposeId: '',
    comment: '',
  };
  const subjectName = saved.subject.name ?? 'сотрудник без отдельной настройки';
  const typesOfRole = saved.subject.passTypes;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Сотрудник" hint="Предпросмотр справа — как форму увидит этот человек.">
            <Select
              value={userId ?? ''}
              disabled={busy}
              onChange={(e) => {
                onUserChange(e.target.value || null);
                if (!e.target.value && level === 'user') setLevel('tenant');
              }}
            >
              <option value="">Без сотрудника (общая форма компании)</option>
              {saved.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset
            aria-label="Какой уровень правите"
            className="m-0 min-w-0 border-0 p-0 sm:col-span-2"
          >
            <legend className="mb-1.5 text-sm font-medium">Какой уровень правите</legend>
            <div className="grid grid-cols-3 gap-1">
              {(['site', 'tenant', 'user'] as const).map((l) => {
                const reasonOff =
                  l === 'user' && !userId
                    ? 'Сначала выберите сотрудника.'
                    : saved.canEdit[l]
                      ? null
                      : PERMISSION_NEEDED[l];
                return (
                  <Button
                    key={l}
                    size="sm"
                    variant={activeLevel === l ? 'default' : 'outline'}
                    aria-pressed={activeLevel === l}
                    disabled={(l === 'user' && !userId) || busy}
                    title={reasonOff ?? undefined}
                    onClick={() => setLevel(l)}
                  >
                    {LEVEL_TITLE[l]}
                  </Button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{LEVEL_HINT[activeLevel]}</p>
          </fieldset>
        </div>

        {!canEdit ? (
          <Alert tone="warning" data-testid="level-readonly">
            {PERMISSION_NEEDED[activeLevel]} Ниже значения этого уровня — только для просмотра.
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Типы транспорта и виды пропусков</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Setting
              title="Какие типы транспорта можно выбрать"
              source={
                layer.categoryIds
                  ? 'задано на этом уровне'
                  : PASS_FORM_SOURCE_LABELS[resolved.sources.categoryIds]
              }
              overridden={Boolean(layer.categoryIds)}
              disabled={!editable}
              onReset={() => update(without(layer, 'categoryIds'))}
            >
              <ChipSelect
                label="Типы транспорта"
                disabled={!editable}
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
                value={layer.categoryIds ?? inherited.categoryIds ?? categories.map((c) => c.id)}
                onChange={(next) => {
                  if (next.length === 0) return;
                  update({ ...layer, categoryIds: next });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Тип с лимитом 0 у арендатора всё равно скрыт. Хотя бы один тип должен остаться.
              </p>
            </Setting>
            <Setting
              title="Тип транспорта по умолчанию"
              source={
                layer.defaultCategoryId
                  ? 'задано на этом уровне'
                  : resolved.defaultCategoryId
                    ? PASS_FORM_SOURCE_LABELS[resolved.sources.defaultCategoryId]
                    : 'не задан: берётся тип арендатора или единственный'
              }
              overridden={Boolean(layer.defaultCategoryId)}
              disabled={!editable}
              onReset={() => update(without(layer, 'defaultCategoryId'))}
            >
              <Select
                aria-label="Тип транспорта по умолчанию"
                disabled={!editable}
                value={layer.defaultCategoryId ?? ''}
                onChange={(e) =>
                  update(
                    e.target.value
                      ? { ...layer, defaultCategoryId: e.target.value }
                      : without(layer, 'defaultCategoryId'),
                  )
                }
              >
                <option value="">Не задан</option>
                {categories
                  .filter((c) =>
                    (layer.categoryIds ?? inherited.categoryIds ?? [c.id]).includes(c.id),
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Setting>
            <Setting
              title="Какие виды пропусков можно оформлять"
              source={
                layer.passTypes
                  ? 'задано на этом уровне'
                  : PASS_FORM_SOURCE_LABELS[resolved.sources.passTypes]
              }
              overridden={Boolean(layer.passTypes)}
              disabled={!editable}
              onReset={() => update(without(layer, 'passTypes'))}
            >
              <ChipSelect
                label="Виды пропусков"
                disabled={!editable}
                options={ALL_TYPES.map((t) => ({
                  value: t,
                  label: PASS_TYPE_LABEL[t],
                  disabled: userId !== null && !typesOfRole.includes(t),
                  ...(userId !== null && !typesOfRole.includes(t)
                    ? { title: 'Роль сотрудника не даёт права оформлять такие пропуска.' }
                    : {}),
                }))}
                value={layer.passTypes ?? inherited.passTypes}
                onChange={(next) => {
                  if (next.length === 0) return;
                  update({ ...layer, passTypes: next as PassType[] });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Отключённый вид в форме не показывается вовсе. Форма не шире прав роли: что роль не
                разрешает, не появится, даже если отметить здесь.
              </p>
            </Setting>
            <Setting
              title="Вид пропуска по умолчанию"
              source={
                layer.defaultPassType
                  ? 'задано на этом уровне'
                  : PASS_FORM_SOURCE_LABELS[resolved.sources.defaultPassType]
              }
              overridden={Boolean(layer.defaultPassType)}
              disabled={!editable}
              onReset={() => update(without(layer, 'defaultPassType'))}
            >
              <Select
                aria-label="Вид пропуска по умолчанию"
                disabled={!editable}
                value={layer.defaultPassType ?? inherited.defaultPassType}
                onChange={(e) => update({ ...layer, defaultPassType: e.target.value as PassType })}
              >
                {(layer.passTypes ?? inherited.passTypes).map((t) => (
                  <option key={t} value={t}>
                    {PASS_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Setting>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Поля формы</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {passFormFieldKeys.map((key) => {
              const own = layer.fields?.[key];
              const modes = key === 'window' ? WINDOW_MODES : MODES;
              return (
                <Setting
                  key={key}
                  title={PASS_FORM_FIELD_LABELS[key]}
                  source={own ? 'задано на этом уровне' : effectiveSource(key)}
                  overridden={own !== undefined}
                  disabled={!editable}
                  onReset={() => {
                    const fields = without(layer.fields ?? {}, key);
                    update(
                      Object.keys(fields).length > 0
                        ? { ...layer, fields }
                        : without(layer, 'fields'),
                    );
                  }}
                >
                  <Select
                    aria-label={`Поле «${PASS_FORM_FIELD_LABELS[key]}»`}
                    disabled={!editable}
                    value={own ?? inherited.fields[key]}
                    onChange={(e) =>
                      update({
                        ...layer,
                        fields: { ...(layer.fields ?? {}), [key]: e.target.value },
                      } as PassFormSettings)
                    }
                  >
                    {modes.map((m) => (
                      <option key={m} value={m}>
                        {FIELD_MODE_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                  {key === 'window' ? (
                    <p className="text-xs text-muted-foreground">
                      По умолчанию окно скрыто: включайте его там, где есть расписание доков. Если
                      политика окон прибытия требует окно, а в форме оно «Необязательно» или
                      «Скрыто», пропуск действует весь срок. У постоянного пропуска окно, которое
                      требует политика, остаётся обязательным.
                    </p>
                  ) : null}
                  {key === 'comment' ? (
                    <p className="text-xs text-muted-foreground">
                      Если политика согласования требует комментарий, поле останется обязательным.
                    </p>
                  ) : null}
                </Setting>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Время разового пропуска</CardTitle>
          </CardHeader>
          <CardContent>
            <Setting
              title="Если окончание не указано — начало плюс, часов"
              source={
                layer.singleHours
                  ? 'задано на этом уровне'
                  : PASS_FORM_SOURCE_LABELS[resolved.sources.singleHours]
              }
              overridden={layer.singleHours !== undefined}
              disabled={!editable}
              onReset={() => update(without(layer, 'singleHours'))}
            >
              <Input
                type="number"
                min={1}
                max={saved.singlePassMaxHours}
                aria-label="Часов до окончания разового пропуска"
                disabled={!editable}
                className="w-28"
                value={layer.singleHours ?? inherited.singleHours}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1) update({ ...layer, singleHours: n });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Не больше максимума разового пропуска на объекте — {saved.singlePassMaxHours} ч.
                Окончание подставляется в поле само, как только появилось время начала.
              </p>
            </Setting>
            <div className="pt-3">
              <Setting
                title="Время начала — «сейчас» по времени объекта"
                source={
                  layer.startNow !== undefined
                    ? 'задано на этом уровне'
                    : PASS_FORM_SOURCE_LABELS[resolved.sources.startNow]
                }
                overridden={layer.startNow !== undefined}
                disabled={!editable}
                onReset={() => update(without(layer, 'startNow'))}
              >
                <Switch
                  aria-label="Подставлять время начала автоматически"
                  disabled={!editable}
                  checked={layer.startNow ?? inherited.startNow}
                  onChange={(e) => update({ ...layer, startNow: e.target.checked })}
                  label="Подставлять автоматически"
                  hint="Включено: в поле «с» сразу видно текущее время объекта. Выключено: поле пустое, пропуск начинается «сейчас», если время не указать."
                />
              </Setting>
            </div>
            <div className="pt-3">
              <Setting
                title="Кнопка «Повторить вчера»"
                source={
                  activeLevel === 'user'
                    ? 'для сотрудника не задаётся'
                    : layer.repeatYesterday !== undefined
                      ? 'задано на этом уровне'
                      : PASS_FORM_SOURCE_LABELS[resolved.sources.repeatYesterday]
                }
                overridden={layer.repeatYesterday !== undefined}
                disabled={!editable || activeLevel === 'user'}
                onReset={() => update(without(layer, 'repeatYesterday'))}
              >
                <Switch
                  aria-label="Показывать кнопку «Повторить вчера»"
                  disabled={!editable || activeLevel === 'user'}
                  checked={layer.repeatYesterday ?? inherited.repeatYesterday}
                  onChange={(e) => update({ ...layer, repeatYesterday: e.target.checked })}
                  label="Показывать кнопку"
                  hint={
                    activeLevel === 'user'
                      ? 'Показ кнопки задаётся на уровне «Объект» или «Арендатор», для отдельного сотрудника — нет.'
                      : 'По умолчанию не показывается: разовые машины приезжают непредсказуемо, а кто ездит несколько дней, тому лучше оформить многоразовый пропуск.'
                  }
                />
              </Setting>
            </div>
          </CardContent>
        </Card>

        {resolved.notes.length > 0 ? (
          <Alert tone="warning">{resolved.notes.join(' ')}</Alert>
        ) : null}
        <ErrorAlert error={error} />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Причина изменения (в журнал)" className="min-w-0 flex-1 basis-60">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              disabled={!editable}
              placeholder="необязательно"
            />
          </Field>
          <Button disabled={!canEdit || !dirty || busy} onClick={() => void save()}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Сохранить уровень «{LEVEL_TITLE[activeLevel]}»
          </Button>
        </div>
        {otherDirty.length > 0 ? (
          <p className="text-xs text-warning" data-testid="other-dirty">
            Есть несохранённые правки на других уровнях:{' '}
            {otherDirty.map((l) => `«${LEVEL_TITLE[l]}»`).join(', ')}. Они не потеряются — сохраните
            каждый уровень отдельно.
          </p>
        ) : null}
      </div>

      <aside className="space-y-2 lg:sticky lg:top-4 lg:self-start" data-testid="form-preview">
        <h2 className="text-sm font-semibold">Так увидит форму: {subjectName}</h2>
        <p className="text-xs text-muted-foreground">
          Предпросмотр меняется сразу, ещё до сохранения. Виды пропусков:{' '}
          {(view.passTypes ?? []).map((t) => PASS_TYPE_LABEL[t].toLowerCase()).join(', ') || 'нет'}.
        </p>
        <fieldset
          disabled
          aria-label="Предпросмотр формы"
          className="m-0 min-w-0 space-y-3 rounded-md border bg-muted/30 p-3 opacity-95"
        >
          <PassFormFields
            ctx={ctx}
            view={view}
            values={previewValues}
            set={() => undefined}
            errors={{}}
            hints={undefined}
            more
            setMore={() => undefined}
            nowMs={Date.parse(ctx.now)}
          />
        </fieldset>
      </aside>
    </div>
  );
}

const levelRank = (source: string): number =>
  ({ default: 0, site: 1, tenant: 2, user: 3 })[source] ?? 0;

/** Одна настройка: название, подпись «откуда значение», «сбросить к уровню выше». */
function Setting({
  title,
  source,
  overridden,
  disabled,
  onReset,
  children,
}: {
  title: string;
  source: string;
  overridden: boolean;
  disabled: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 border-b pb-3 last:border-0 last:pb-0" data-testid="setting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span data-testid="setting-source">{source}</span>
          {overridden ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`Сбросить к уровню выше: ${title}`}
              onClick={onReset}
            >
              <RotateCcw aria-hidden /> Сбросить к уровню выше
            </Button>
          ) : null}
        </span>
      </div>
      {children}
    </div>
  );
}

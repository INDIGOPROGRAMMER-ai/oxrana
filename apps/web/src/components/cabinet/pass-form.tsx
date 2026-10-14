import type { FleetVehicleViewSchema, PassCreatedSchema, PassType } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Alert,
  Button,
  Card,
  CardContent,
  DateInput,
  DateTimeInput,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  type FieldErrorLike,
  Input,
  localToInstant,
  Select,
  Textarea,
  TimeInput,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useRefresh } from '../../lib/data';
import {
  buildPassBody,
  formField,
  type PassFormErrors,
  type PassFormValues,
} from '../../lib/pass-form';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';
import { useDebounced } from '../../lib/use-debounced';
import { useCabinet } from './cabinet-context';
import { type PassHints, PassHintsPanel } from './pass-hints-panel';

type Created = z.infer<typeof PassCreatedSchema>;
export type FleetVehicle = z.infer<typeof FleetVehicleViewSchema>;

const COUNTRY: Record<string, string> = {
  RU: 'Россия',
  BY: 'Беларусь',
  KZ: 'Казахстан',
  UZ: 'Узбекистан',
  TJ: 'Таджикистан',
  KG: 'Киргизия',
  AM: 'Армения',
};

/** Номер при вводе: как он будет записан и откуда (A10: пробелы, тире, кириллица — не ошибка). */
function PlatePreview({ text }: { text: string }) {
  if (text.trim() === '') return null;
  const plate = normalizePlate(text);
  if (!plate.norm) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="plate-preview">
      Запишется как <span className="font-mono font-medium text-foreground">{plate.norm}</span>
      {plate.recognized
        ? plate.country
          ? ` · ${COUNTRY[plate.country] ?? plate.country}`
          : ''
        : ' · формат не распознан, номер сохранится как есть'}
    </p>
  );
}

/** Начало пропуска, если это не сегодня (иначе «сейчас» — сервер знает сам). */
function laterStart(values: PassFormValues, today: string, timezone: string): string {
  const date = values.passType === 'single' ? values.date : values.from;
  return date && today && date > today ? localToInstant(date, '00:00', timezone) : '';
}

const PASS_TYPE_MODE: Record<string, string> = {
  allow: 'без согласования',
  on_request: 'уйдёт на согласование',
};

/**
 * Форма пропуска: одна на все случаи (08_ «Создание пропуска») — машина или пешеход, разовый,
 * многоразовый или постоянный. Подсказки приходят от сервера, пока человек заполняет форму; недоступное
 * ему (типы транспорта и пропусков) в списках не показывается.
 */
export function PassForm({ fleetVehicle }: { fleetVehicle?: FleetVehicle | undefined }) {
  const { tenant, ctx, serverNow } = useCabinet();
  const refresh = useRefresh();
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [errors, setErrors] = useState<PassFormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const available = (ctx?.categories ?? []).filter((c) => c.available);
  const defaultCategory =
    fleetVehicle?.categoryId ??
    (ctx?.tenant.defaultCategoryId && available.some((c) => c.id === ctx.tenant.defaultCategoryId)
      ? ctx.tenant.defaultCategoryId
      : '');
  const initial: PassFormValues = {
    participant: 'vehicle',
    plate: fleetVehicle?.plateRaw ?? '',
    categoryId: defaultCategory,
    brand: fleetVehicle?.brand ?? '',
    driverName: fleetVehicle?.driverName ?? '',
    driverPhone: fleetVehicle?.driverPhone ?? '',
    personName: '',
    personDocument: '',
    passType: 'single',
    date: ctx?.today ?? '',
    windowFromTime: '',
    windowToTime: '',
    from: ctx?.today ?? '',
    to: '',
    windowFrom: '',
    windowTo: '',
    dockId: '',
    destinationZoneId: '',
    purposeId: '',
    comment: '',
  };
  const [values, setValues] = useState<PassFormValues>(initial);
  const set = <K extends keyof PassFormValues>(key: K, value: PassFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // подсказки: тем же движком, что на посту; запрос — после паузы в наборе
  const wanted = {
    participant: values.participant,
    categoryId: values.participant === 'vehicle' ? values.categoryId : '',
    passType: values.passType,
    destinationZoneId: values.destinationZoneId,
    plate: values.participant === 'vehicle' ? values.plate.trim() : '',
    personName: values.participant === 'pedestrian' ? values.personName.trim() : '',
    // начало пропуска в будущем: запись чёрного списка, что кончится раньше, не помешает (Q-76)
    validFrom: laterStart(values, ctx?.today ?? '', ctx?.site.timezone ?? ''),
  };
  const hintKey = useDebounced(wanted);
  const hintsQuery = useQuery({
    queryKey: ['hints', tenant?.id, hintKey],
    queryFn: () =>
      api<PassHints>(`/tenants/${tenant?.id}/pass-hints`, {
        method: 'POST',
        body: {
          participant: hintKey.participant,
          passType: hintKey.passType,
          ...(hintKey.categoryId ? { categoryId: hintKey.categoryId } : {}),
          ...(hintKey.destinationZoneId ? { destinationZoneId: hintKey.destinationZoneId } : {}),
          ...(hintKey.plate ? { plate: hintKey.plate } : {}),
          ...(hintKey.personName ? { personName: hintKey.personName } : {}),
          ...(hintKey.validFrom ? { validFrom: hintKey.validFrom } : {}),
        },
      }),
    enabled: Boolean(tenant),
    placeholderData: (previous) => previous,
  });
  const hints = hintsQuery.data;
  // Подсказки ещё считаются для прежнего ввода: правила (комментарий, док, окно) могут быть другими,
  // поэтому до ответа сохранить нельзя — кнопка неактивна и говорит об этом.
  const settling =
    JSON.stringify(wanted) !== JSON.stringify(hintKey) || hintsQuery.isPlaceholderData;

  if (!ctx || !tenant) return null;

  if (created) {
    const waiting = created.status === 'pending_approval';
    return (
      <div className="space-y-4" data-testid="pass-created">
        <Alert
          tone={waiting ? 'warning' : 'success'}
          title={waiting ? 'Пропуск отправлен на согласование' : 'Пропуск оформлен'}
        >
          {waiting
            ? 'Согласующий увидит его сразу. Решение появится в списке пропусков — обновлять страницу не нужно.'
            : 'Он уже действует: охрана видит его на КПП.'}
        </Alert>
        {created.warnings.map((w) => (
          <Alert key={w.code} tone="warning" data-testid={`warning-${w.code}`}>
            {w.message}
          </Alert>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            onClick={() => {
              setCreated(null);
              setValues(initial);
            }}
          >
            Оформить ещё
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/cabinet/passes">К списку пропусков</Link>
          </Button>
        </div>
      </div>
    );
  }

  const vehicle = values.participant === 'vehicle';
  const category = ctx.categories.find((c) => c.id === values.categoryId);
  const blockers = (hints?.notices ?? []).filter((n) => n.severity === 'error');
  const dockRequired = vehicle && Boolean(hints?.dock.required);
  const windowRequired = vehicle && Boolean(hints?.window.required);
  const commentRequired = Boolean(hints?.commentRequired);
  const passTypes = hints?.passTypes ?? [];
  const noTypes = hints !== undefined && passTypes.length === 0;
  const typeSelectable = passTypes.some((t) => t.passType === values.passType);
  const approvalWait = hints?.approval?.mode === 'on_request';

  const err = (name: keyof PassFormValues): FieldErrorLike | null => {
    const message = errors[name];
    return message ? { message } : null;
  };

  async function submit() {
    if (!ctx || !tenant) return;
    setError(null);
    const built = buildPassBody(values, {
      tenantId: tenant.id,
      timezone: ctx.site.timezone,
      today: ctx.today,
      nowMs: serverNow(),
      commentRequired,
      windowRequired,
      dockRequired,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await api<Created>('/passes', { method: 'POST', body: built.body });
      await refresh();
      setCreated(result);
    } catch (raw) {
      const view = errorView(raw);
      const target = formField(view.field, values.passType);
      if (target) {
        setErrors({ [target]: view.message });
        setError(view.settingLink ? view : null);
      } else {
        setError(view);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset
        aria-label="Кто едет"
        className="m-0 grid min-w-0 grid-cols-2 gap-2 border-0 p-0 sm:max-w-sm"
      >
        {(['vehicle', 'pedestrian'] as const).map((p) => (
          <Button
            key={p}
            size="lg"
            variant={values.participant === p ? 'default' : 'outline'}
            aria-pressed={values.participant === p}
            onClick={() => {
              set('participant', p);
              setErrors({});
            }}
          >
            {p === 'vehicle' ? 'Машина' : 'Пешеход'}
          </Button>
        ))}
      </fieldset>

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          {vehicle ? (
            <>
              <Field label="Номер машины" required error={err('plate')} className="sm:col-span-2">
                <Input
                  value={values.plate}
                  onChange={(e) => set('plate', e.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  maxLength={30}
                  className="font-mono text-base uppercase"
                />
                <PlatePreview text={values.plate} />
              </Field>
              <Field
                label="Тип транспорта"
                required
                error={err('categoryId')}
                hint={
                  values.categoryId &&
                  values.categoryId === ctx.tenant.defaultCategoryId &&
                  !fleetVehicle
                    ? 'Подставлен тип по умолчанию для вашей компании — можно выбрать другой.'
                    : 'Показаны только типы, которые предусмотрены для вашей компании.'
                }
              >
                <Select
                  value={values.categoryId}
                  onChange={(e) => set('categoryId', e.target.value)}
                >
                  <option value="">Выберите тип</option>
                  {available.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Марка" error={err('brand')}>
                <Input
                  value={values.brand}
                  onChange={(e) => set('brand', e.target.value)}
                  maxLength={100}
                />
              </Field>
              <Field label="Водитель" error={err('driverName')}>
                <Input
                  value={values.driverName}
                  onChange={(e) => set('driverName', e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="Телефон водителя" error={err('driverPhone')}>
                <Input
                  type="tel"
                  value={values.driverPhone}
                  onChange={(e) => set('driverPhone', e.target.value)}
                  maxLength={30}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Фамилия и имя" required error={err('personName')}>
                <Input
                  value={values.personName}
                  onChange={(e) => set('personName', e.target.value)}
                  autoComplete="off"
                  maxLength={200}
                />
              </Field>
              <Field
                label="Документ"
                hint="Только вид документа («паспорт»), без номера."
                error={err('personDocument')}
              >
                <Input
                  value={values.personDocument}
                  onChange={(e) => set('personDocument', e.target.value)}
                  maxLength={100}
                />
              </Field>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field
            label="Тип пропуска"
            required
            hint={noTypes ? undefined : 'Показаны только те типы, которые вам разрешено оформлять.'}
            {...(noTypes
              ? {
                  disabledReason:
                    'Оформлять пропуска вам не разрешено. Обратитесь к ответственному вашей компании.',
                }
              : {})}
          >
            <Select
              value={typeSelectable ? values.passType : ''}
              onChange={(e) => set('passType', e.target.value as PassType)}
              disabled={noTypes}
            >
              {typeSelectable ? null : <option value="">Загрузка…</option>}
              {passTypes.map((t) => (
                <option key={t.passType} value={t.passType}>
                  {PASS_TYPE_LABEL[t.passType]} — {PASS_TYPE_MODE[t.mode] ?? t.mode}
                </option>
              ))}
            </Select>
          </Field>

          {values.passType === 'single' ? (
            <>
              <Field label="Дата приезда" required error={err('date')}>
                <DateInput
                  value={values.date}
                  todayIso={ctx.today}
                  onChange={(v) => set('date', v)}
                />
              </Field>
              <Field
                label="Окно прибытия, с"
                required={windowRequired}
                error={err('windowFromTime')}
                hint={`Время объекта: ${ctx.site.timezoneLabel}`}
              >
                <TimeInput
                  value={values.windowFromTime}
                  onChange={(v) => set('windowFromTime', v)}
                />
              </Field>
              <Field
                label="Окно прибытия, по"
                required={windowRequired}
                error={err('windowToTime')}
              >
                <TimeInput value={values.windowToTime} onChange={(v) => set('windowToTime', v)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Действует с" required error={err('from')}>
                <DateInput
                  value={values.from}
                  todayIso={ctx.today}
                  onChange={(v) => set('from', v)}
                />
              </Field>
              {values.passType === 'multi' ? (
                <Field
                  label="Действует по"
                  required
                  error={err('to')}
                  hint="Последний день включительно."
                >
                  <DateInput
                    value={values.to}
                    todayIso={ctx.today}
                    onChange={(v) => set('to', v)}
                  />
                </Field>
              ) : (
                <p className="self-end text-sm text-muted-foreground">
                  Постоянный пропуск действует без окончания, пока его не отменят.
                </p>
              )}
              {windowRequired ? (
                <>
                  <Field label="Окно прибытия, с" required error={err('windowFrom')}>
                    <DateTimeInput
                      value={values.windowFrom}
                      todayIso={ctx.today}
                      onChange={(v) => set('windowFrom', v)}
                    />
                  </Field>
                  <Field label="Окно прибытия, по" required error={err('windowTo')}>
                    <DateTimeInput
                      value={values.windowTo}
                      todayIso={ctx.today}
                      onChange={(v) => set('windowTo', v)}
                    />
                  </Field>
                </>
              ) : null}
            </>
          )}

          {vehicle && ctx.docks.length > 0 ? (
            <Field
              label="Док"
              required={dockRequired}
              error={err('dockId')}
              hint={hints?.dock.text ?? undefined}
            >
              <Select value={values.dockId} onChange={(e) => set('dockId', e.target.value)}>
                <option value="">{dockRequired ? 'Выберите док' : 'Без дока'}</option>
                {ctx.docks.map((d) => (
                  <option key={d.id} value={d.id}>
                    Док {d.number}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {ctx.zones.length > 0 && !(vehicle && dockRequired) ? (
            <Field label="Место назначения" error={err('destinationZoneId')}>
              <Select
                value={values.destinationZoneId}
                onChange={(e) => set('destinationZoneId', e.target.value)}
              >
                <option value="">Не указано</option>
                {ctx.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {ctx.purposes.length > 0 ? (
            <Field label="Цель визита" error={err('purposeId')}>
              <Select value={values.purposeId} onChange={(e) => set('purposeId', e.target.value)}>
                <option value="">Не указана</option>
                {ctx.purposes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field
            label="Комментарий"
            required={commentRequired}
            error={err('comment')}
            hint={commentRequired ? 'Для чего и зачем нужен пропуск.' : undefined}
            className="sm:col-span-2"
          >
            <Textarea
              value={values.comment}
              onChange={(e) => set('comment', e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
        </CardContent>
      </Card>

      <PassHintsPanel hints={hints} loading={hintsQuery.isFetching} />

      <ErrorAlert error={error} />
      <div className="space-y-2">
        <Button
          type="submit"
          size="lg"
          className="w-full sm:w-auto"
          disabled={submitting || noTypes || blockers.length > 0 || !hints || settling}
        >
          {submitting ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <CheckCircle2 aria-hidden />
          )}
          {approvalWait ? 'Отправить на согласование' : 'Оформить пропуск'}
        </Button>
        {blockers.length > 0 ? (
          <p className="text-xs text-destructive">Оформить нельзя: {blockers[0]?.text}</p>
        ) : settling && hints ? (
          <p className="text-xs text-muted-foreground">Проверяем правила для введённого…</p>
        ) : null}
        {category && !category.available ? (
          <p className="text-xs text-warning">Этот тип для вашей компании не предусмотрен.</p>
        ) : null}
      </div>
    </form>
  );
}

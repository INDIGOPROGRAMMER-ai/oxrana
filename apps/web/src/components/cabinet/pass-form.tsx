import type { FleetVehicleViewSchema, PassCreatedSchema } from '@oxrana/contracts';
import {
  Alert,
  Button,
  ErrorAlert,
  type ErrorView,
  errorView,
  localToInstant,
  SiteTime,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useRefresh } from '../../lib/data';
import {
  buildPassBody,
  formField,
  type PassFormErrors,
  type PassFormFix,
  type PassFormValues,
} from '../../lib/pass-form';
import { buildFormView } from '../../lib/pass-form-view';
import { endAfter, timeOf } from '../../lib/pass-time';
import { useDebounced } from '../../lib/use-debounced';
import { useCabinet } from './cabinet-context';
import { PassFormFields } from './pass-form-fields';
import { type PassHints, PassHintsPanel } from './pass-hints-panel';

type Created = z.infer<typeof PassCreatedSchema>;
export type FleetVehicle = z.infer<typeof FleetVehicleViewSchema>;

/** Начало пропуска, если это не сегодня (иначе «сейчас» — сервер знает сам). */
function laterStart(values: PassFormValues, today: string, timezone: string): string {
  const date = values.passType === 'single' ? values.date : values.from;
  return date && today && date > today ? localToInstant(date, '00:00', timezone) : '';
}

/**
 * Форма пропуска: одна на все случаи (08_ «Создание пропуска») — машина или пешеход, разовый,
 * многоразовый или постоянный. Что в ней видно, решает настройка формы по уровням «объект →
 * арендатор → сотрудник» (ADR-023); подсказки приходят от сервера, пока человек заполняет форму.
 * Одно доступное место назначения и единственный нужный док подставлены сами. Кнопка «Создать»
 * всегда видна внизу экрана.
 */
export function PassForm({ fleetVehicle }: { fleetVehicle?: FleetVehicle | undefined }) {
  const { tenant, ctx, passForm, serverNow } = useCabinet();
  const refresh = useRefresh();
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [errors, setErrors] = useState<PassFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [more, setMore] = useState(false);

  const startNow = passForm?.form.startNow ?? true;
  const singleHours = passForm?.form.singleHours ?? 23;
  const singleMax = ctx?.site.singlePassMaxHours ?? 24;
  const initial: PassFormValues = {
    participant: 'vehicle',
    plate: fleetVehicle?.plateRaw ?? '',
    categoryId: fleetVehicle?.categoryId ?? '',
    brand: fleetVehicle?.brand ?? '',
    driverName: fleetVehicle?.driverName ?? '',
    driverPhone: fleetVehicle?.driverPhone ?? '',
    personName: '',
    personDocument: '',
    passType: 'single',
    date: ctx?.today ?? '',
    startTime: startNow && ctx ? timeOf(serverNow(), ctx.site.timezone) : '',
    endTime:
      startNow && ctx
        ? endAfter(timeOf(serverNow(), ctx.site.timezone), singleHours, singleMax).time
        : '',
    startAuto: true,
    endAuto: true,
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
  const [fixes, setFixes] = useState<PassFormFix[]>([]);
  const set = <K extends keyof PassFormValues>(key: K, value: PassFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setFixes([]);
  };
  const applyFix = (fix: PassFormFix) => {
    setValues((v) => ({ ...v, ...fix.apply }));
    setErrors({});
    setFixes([]);
  };

  // Время начала «сейчас» подставляется само и идёт вместе с часами сервера, пока его не правили;
  // окончание — начало + N часов, пока не правили его. Будущая дата без времени — весь день (Q-87).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!ctx) return;
    setValues((v) => {
      const startTime = v.startAuto
        ? startNow && v.date === ctx.today
          ? timeOf(serverNow(), ctx.site.timezone)
          : ''
        : v.startTime;
      const endTime = v.endAuto
        ? startTime
          ? endAfter(startTime, singleHours, singleMax).time
          : ''
        : v.endTime;
      return startTime === v.startTime && endTime === v.endTime ? v : { ...v, startTime, endTime };
    });
  }, [
    tick,
    ctx,
    startNow,
    singleHours,
    singleMax,
    values.date,
    values.startAuto,
    values.endAuto,
    values.startTime,
  ]);

  // Подсказки: тем же движком, что на посту; запрос — после паузы в наборе. Типы транспорта и виды
  // пропусков в подсказках уже отфильтрованы настройкой формы (сервер применяет её сам).
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

  const view = useMemo(
    () =>
      ctx && passForm
        ? buildFormView({
            form: passForm.form,
            ctx,
            enforced: passForm.enforced,
            allowedPassTypes: hints?.passTypes.map((p) => p.passType),
            windowRequiredByPolicy: Boolean(hints?.window.required),
            commentRequiredByPolicy: Boolean(hints?.commentRequired),
            // док обязателен только разовому пропуску (7b.1)
            dockRequired:
              values.passType === 'single' &&
              Boolean(
                hints?.dock.required ||
                  (values.participant === 'vehicle' &&
                    ctx.tenant.trucksDockRequired &&
                    ctx.categories.find((c) => c.id === values.categoryId)?.dockEligible),
              ),
          })
        : null,
    [ctx, passForm, hints, values.participant, values.categoryId, values.passType],
  );

  // Умные значения: единственный тип, единственная зона, единственный нужный док — подставлены;
  // вид пропуска — по умолчанию из настройки. Подставляется только пустое и только один раз на значение.
  const applied = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!view) return;
    const fill = (key: 'categoryId' | 'destinationZoneId' | 'dockId', value: string) => {
      if (value && applied.current[key] !== value) {
        applied.current[key] = value;
        setValues((v) => (v[key] === '' ? { ...v, [key]: value } : v));
      }
    };
    if (!fleetVehicle) fill('categoryId', view.defaultCategoryId);
    fill('destinationZoneId', view.defaultZoneId);
    fill('dockId', view.defaultDockId);
    if (view.passTypes && view.defaultPassType && applied.current.passType === undefined) {
      applied.current.passType = view.defaultPassType;
      setValues((v) =>
        view.passTypes?.includes(v.passType)
          ? v
          : { ...v, passType: view.defaultPassType ?? v.passType },
      );
    }
    // вид пропуска, который перестал быть доступным (права, настройка), заменяется доступным
    if (view.passTypes && view.passTypes.length > 0) {
      setValues((v) =>
        view.passTypes?.includes(v.passType)
          ? v
          : { ...v, passType: view.passTypes?.[0] ?? v.passType },
      );
    }
  }, [view, fleetVehicle]);

  if (!ctx || !tenant || !passForm || !view) return null;

  if (created) {
    const waiting = created.status === 'pending_approval';
    return (
      <div className="space-y-4" data-testid="pass-created">
        <Alert
          tone={waiting ? 'warning' : 'success'}
          title={waiting ? 'Пропуск отправлен на согласование' : 'Пропуск оформлен'}
        >
          {waiting
            ? 'Согласующий увидит его сразу. Решение появится в списке пропусков и в колокольчике — обновлять страницу не нужно.'
            : 'Он уже действует: охрана видит его на КПП.'}
          {created.passType === 'single' && created.validFrom ? (
            <span className="mt-1 block text-sm" data-testid="created-span">
              Действует с <SiteTime value={created.validFrom} /> до{' '}
              <SiteTime value={created.validTo} />
            </span>
          ) : null}
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
              applied.current = {};
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
  const noTypes = view.passTypes !== undefined && view.passTypes.length === 0;
  const approvalWait = hints?.approval?.mode === 'on_request';

  async function submit() {
    if (!ctx || !tenant || !view) return;
    setError(null);
    const built = buildPassBody(values, {
      tenantId: tenant.id,
      timezone: ctx.site.timezone,
      today: ctx.today,
      nowMs: serverNow(),
      commentRequired: view.fields.comment === 'required',
      windowRequired: view.fields.window === 'required',
      dockRequired: vehicle && view.dockRequired,
      fields: view.fields,
      pastToleranceMin: ctx.site.pastStartToleranceMin,
      singleMaxHours: ctx.site.singlePassMaxHours,
    });
    if (!built.ok) {
      setErrors(built.errors);
      setFixes(built.fixes);
      return;
    }
    setFixes([]);
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
      className="space-y-4"
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

      <PassFormFields
        ctx={ctx}
        view={view}
        values={values}
        set={set}
        errors={errors}
        hints={hints}
        fromFleet={Boolean(fleetVehicle)}
        more={more}
        setMore={setMore}
        nowMs={serverNow()}
        fixes={fixes}
        applyFix={applyFix}
      />

      <PassHintsPanel hints={hints} loading={hintsQuery.isFetching} />

      <ErrorAlert error={error} />
      {category && !category.available ? (
        <p className="text-xs text-warning">Этот тип для вашей компании не предусмотрен.</p>
      ) : null}
      {blockers.length > 0 ? (
        <p className="text-xs text-destructive">Оформить нельзя: {blockers[0]?.text}</p>
      ) : settling && hints ? (
        <p className="text-xs text-muted-foreground">Проверяем правила для введённого…</p>
      ) : null}
      <div
        data-testid="submit-bar"
        className="sticky bottom-16 z-20 -mx-4 border-t bg-background/95 px-4 py-2 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0"
      >
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
          {approvalWait ? 'Отправить на согласование' : 'Создать пропуск'}
        </Button>
      </div>
    </form>
  );
}

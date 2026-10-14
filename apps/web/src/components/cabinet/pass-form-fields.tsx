import type { CabinetContext, PassType } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Button,
  Card,
  CardContent,
  cn,
  DateInput,
  DateTimeInput,
  Field,
  type FieldErrorLike,
  formatInZone,
  Input,
  SegmentedChoice,
  Select,
  Textarea,
  TimeInput,
  TimeRangeInput,
} from '@oxrana/ui';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PassFormErrors, PassFormFix, PassFormValues } from '../../lib/pass-form';
import type { FormView } from '../../lib/pass-form-view';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';
import { endsNextDay } from '../../lib/pass-time';
import type { PassHints } from './pass-hints-panel';

const COUNTRY: Record<string, string> = {
  RU: 'Россия',
  BY: 'Беларусь',
  KZ: 'Казахстан',
  UZ: 'Узбекистан',
  TJ: 'Таджикистан',
  KG: 'Киргизия',
  AM: 'Армения',
};

const PASS_TYPE_MODE: Record<string, string> = {
  allow: 'без согласования',
  on_request: 'уйдёт на согласование',
};

/** Номер при вводе: как он будет записан и откуда (A10: пробелы, тире, кириллица — не ошибка). */
export function PlatePreview({ text }: { text: string }) {
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

export interface PassFormFieldsProps {
  readonly ctx: Pick<CabinetContext, 'today' | 'site' | 'tenant' | 'purposes'>;
  readonly view: FormView;
  readonly values: PassFormValues;
  readonly set: <K extends keyof PassFormValues>(key: K, value: PassFormValues[K]) => void;
  readonly errors: PassFormErrors;
  readonly hints?: PassHints | undefined;
  /** Подсказка «тип по умолчанию для вашей компании» (не при подстановке из автопарка). */
  readonly fromFleet?: boolean | undefined;
  readonly more: boolean;
  readonly setMore: (more: boolean) => void;
  /** «Сейчас» по часам сервера: для строки «Действует до …». */
  readonly nowMs: number;
  /** Исправления ошибки одним нажатием (окно раньше начала пропуска и т. п.). */
  readonly fixes?: readonly PassFormFix[] | undefined;
  readonly applyFix?: ((fix: PassFormFix) => void) | undefined;
}

/** Подсказка к окну прибытия: что это и что пропуск может действовать дольше. */
export const WINDOW_HINT =
  'Узкий интервал, когда машину ждут (например, на док). Пропуск может действовать дольше.';

/** Кнопки-исправления под ошибкой: «Начать окно с 13:50». */
function FixButtons({ props }: { props: PassFormFieldsProps }) {
  const fixes = props.fixes ?? [];
  if (fixes.length === 0 || !props.applyFix) return null;
  return (
    <div className="col-span-2 flex flex-wrap gap-2" data-testid="window-fixes">
      {fixes.map((fix) => (
        <Button
          key={fix.id}
          size="sm"
          variant="outline"
          onClick={() => props.applyFix?.(fix)}
          data-testid={`fix-${fix.id}`}
        >
          {fix.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Поля формы пропуска (ADR-023). Видно только разрешённое настройкой формы: скрытые поля и
 * недоступные типы и виды в списках не показываются вовсе. Обязательное — сразу, остальное на
 * телефоне свёрнуто под «Ещё», на компьютере показано.
 */
export function PassFormFields(props: PassFormFieldsProps) {
  const { ctx, view, values, set, errors, hints, more, setMore } = props;
  const vehicle = values.participant === 'vehicle';
  const mode = view.fields;
  const err = (name: keyof PassFormValues): FieldErrorLike | null => {
    const message = errors[name];
    return message ? { message } : null;
  };
  const single = values.passType === 'single';
  const hasDocks = vehicle && view.docks.length > 0;

  // Поля, которые сразу на виду (обязательные), и те, что под «Ещё».
  const primary: ReactNode[] = [];
  const secondary: ReactNode[] = [];
  const put = (required: boolean, node: ReactNode) => (required ? primary : secondary).push(node);

  if (vehicle && mode.brand !== 'hidden') {
    put(
      mode.brand === 'required',
      <Field key="brand" label="Марка" required={mode.brand === 'required'} error={err('brand')}>
        <Input
          value={values.brand}
          onChange={(e) => set('brand', e.target.value)}
          maxLength={100}
        />
      </Field>,
    );
  }
  if (vehicle && mode.driverName !== 'hidden') {
    put(
      mode.driverName === 'required',
      <Field
        key="driverName"
        label="ФИО водителя"
        required={mode.driverName === 'required'}
        error={err('driverName')}
      >
        <Input
          value={values.driverName}
          onChange={(e) => set('driverName', e.target.value)}
          maxLength={200}
        />
      </Field>,
    );
  }
  if (vehicle && mode.driverPhone !== 'hidden') {
    put(
      mode.driverPhone === 'required',
      <Field
        key="driverPhone"
        label="Телефон водителя"
        required={mode.driverPhone === 'required'}
        error={err('driverPhone')}
      >
        <Input
          type="tel"
          value={values.driverPhone}
          onChange={(e) => set('driverPhone', e.target.value)}
          maxLength={30}
        />
      </Field>,
    );
  }

  if (single) {
    const nextDay = endsNextDay(values.startTime, values.endTime);
    put(
      false,
      <Field
        key="span"
        label="Время действия"
        hint={spanHint(props, nextDay)}
        error={err('startTime') ?? err('endTime')}
        className="@md:col-span-2"
      >
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {values.startAuto && values.startTime
                ? 'с (сейчас — подставлено)'
                : view.startNow
                  ? 'с'
                  : 'с (по умолчанию — сейчас)'}
            </span>
            <TimeInput
              aria-label="Действует с"
              value={values.startTime}
              onChange={(v) => {
                set('startTime', v);
                set('startAuto', false);
              }}
            />
            {!values.startAuto && view.startNow && values.date === ctx.today ? (
              <button
                type="button"
                className="block text-xs text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  set('startAuto', true);
                  set('endAuto', true);
                }}
              >
                Поставить «сейчас»
              </button>
            ) : null}
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {values.endAuto && values.endTime
                ? `до (начало + ${view.singleHours} ч)`
                : `до (по умолчанию — начало + ${view.singleHours} ч)`}
            </span>
            <TimeInput
              aria-label="Действует до"
              value={values.endTime}
              onChange={(v) => {
                set('endTime', v);
                set('endAuto', false);
              }}
            />
            {nextDay ? (
              <p className="text-xs font-medium text-warning" data-testid="end-next-day">
                завтра
              </p>
            ) : null}
          </div>
        </div>
      </Field>,
    );
  }

  if (vehicle && mode.window !== 'hidden') {
    const required = mode.window === 'required';
    put(
      required,
      single ? (
        <div key="window" className="grid grid-cols-2 gap-3 @md:col-span-2">
          <Field
            label="Окно прибытия"
            required={required}
            error={err('windowFromTime') ?? err('windowToTime')}
            hint={`${WINDOW_HINT} Время объекта: ${ctx.site.timezoneLabel}.`}
            className="col-span-2"
          >
            <TimeRangeInput
              aria-label="Окно прибытия"
              from={values.windowFromTime}
              to={values.windowToTime}
              onChange={(from, to) => {
                set('windowFromTime', from);
                set('windowToTime', to);
              }}
            />
          </Field>
          <FixButtons props={props} />
          {hints?.window.autoFilled && !values.windowFromTime ? (
            <p className="col-span-2 text-xs text-muted-foreground" data-testid="window-auto">
              Окно можно не указывать — пропуск будет действовать весь срок.
            </p>
          ) : null}
        </div>
      ) : (
        <div key="window" className="grid gap-3 @md:col-span-2 @md:grid-cols-2">
          <p className="text-xs text-muted-foreground @md:col-span-2">{WINDOW_HINT}</p>
          <Field label="Окно прибытия, с" required={required} error={err('windowFrom')}>
            <DateTimeInput
              value={values.windowFrom}
              todayIso={ctx.today}
              onChange={(v) => set('windowFrom', v)}
            />
          </Field>
          <Field label="Окно прибытия, по" required={required} error={err('windowTo')}>
            <DateTimeInput
              value={values.windowTo}
              todayIso={ctx.today}
              onChange={(v) => set('windowTo', v)}
            />
          </Field>
          <FixButtons props={props} />
        </div>
      ),
    );
  }

  if (hasDocks) {
    put(
      view.dockRequired,
      <Field
        key="dock"
        label="Док"
        required={view.dockRequired}
        error={err('dockId')}
        hint={
          [
            hints?.dock.text,
            !single ? 'Необязательно: на много поездок док каждый раз может быть другой.' : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
      >
        <Select value={values.dockId} onChange={(e) => set('dockId', e.target.value)}>
          <option value="">{view.dockRequired ? 'Выберите док' : 'Без дока'}</option>
          {view.docks.map((d) => (
            <option key={d.id} value={d.id}>
              Док {d.number}
            </option>
          ))}
        </Select>
      </Field>,
    );
  }

  if (mode.destination !== 'hidden' && view.zones.length > 0 && !(vehicle && view.dockRequired)) {
    const required = mode.destination === 'required';
    put(
      required,
      <Field
        key="destination"
        label="Место назначения"
        required={required}
        error={err('destinationZoneId')}
      >
        <Select
          value={values.destinationZoneId}
          onChange={(e) => set('destinationZoneId', e.target.value)}
        >
          {view.zoneUnspecified ? <option value="">Не указано</option> : null}
          {view.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>,
    );
  }
  const purposes = ctx.purposes;
  if (mode.purpose !== 'hidden' && purposes.length > 0) {
    const required = mode.purpose === 'required';
    put(
      required,
      <Field key="purpose" label="Цель визита" required={required} error={err('purposeId')}>
        <Select value={values.purposeId} onChange={(e) => set('purposeId', e.target.value)}>
          <option value="">Не указана</option>
          {purposes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>,
    );
  }
  if (mode.comment !== 'hidden') {
    const required = mode.comment === 'required';
    put(
      required,
      <Field
        key="comment"
        label="Комментарий"
        required={required}
        error={err('comment')}
        hint={required && hints?.commentRequired ? 'Для чего и зачем нужен пропуск.' : undefined}
        className="@md:col-span-2"
      >
        <Textarea
          value={values.comment}
          onChange={(e) => set('comment', e.target.value)}
          rows={2}
          maxLength={2000}
        />
      </Field>,
    );
  }

  const passTypes = view.passTypes;
  const noTypes = passTypes !== undefined && passTypes.length === 0;
  const typeSelectable = passTypes?.includes(values.passType) ?? false;

  // ошибка в свёрнутом поле раскрывает «Ещё»
  const secondaryHasError =
    secondary.length > 0 && Object.keys(errors).some((k) => secondaryKeys.has(k));
  const open = more || secondaryHasError;

  return (
    <div className="@container space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 @md:grid-cols-2 sm:gap-4 sm:pt-5">
          {vehicle ? (
            <>
              <Field label="Номер машины" required error={err('plate')} className="@md:col-span-2">
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
                  values.categoryId === view.defaultCategoryId &&
                  view.categories.length > 1 &&
                  !props.fromFleet
                    ? 'Подставлен тип по умолчанию — можно выбрать другой.'
                    : undefined
                }
              >
                <Select
                  value={values.categoryId}
                  onChange={(e) => set('categoryId', e.target.value)}
                >
                  {view.categories.length === 1 ? null : <option value="">Выберите тип</option>}
                  {view.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
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

          {noTypes ? (
            <Field
              label="Вид пропуска"
              className="@md:col-span-2"
              disabledReason="Оформлять пропуска вам не разрешено. Обратитесь к ответственному вашей компании."
            >
              <Select disabled value="">
                <option value="">—</option>
              </Select>
            </Field>
          ) : passTypes && passTypes.length === 1 ? (
            <p className="self-end text-sm text-muted-foreground @md:col-span-2">
              Пропуск:{' '}
              <span className="font-medium text-foreground">
                {passTypeLabel(passTypes[0] as PassType, hints)}
              </span>
            </p>
          ) : (
            <Field label="Вид пропуска" required className="min-w-0 @md:col-span-2">
              {typeSelectable ? (
                <SegmentedChoice
                  aria-label="Вид пропуска"
                  value={values.passType}
                  onChange={(t) => set('passType', t)}
                  options={(passTypes ?? []).map((t) => ({
                    value: t,
                    label: PASS_TYPE_LABEL[t],
                  }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Загрузка…</p>
              )}
              {typeSelectable ? (
                <p className="text-xs text-muted-foreground" data-testid="pass-type-mode">
                  {PASS_TYPE_MODE[
                    hints?.passTypes.find((p) => p.passType === values.passType)?.mode ?? ''
                  ] ?? ''}
                </p>
              ) : null}
            </Field>
          )}

          {single ? (
            <Field label="Дата приезда" required error={err('date')}>
              <DateInput
                value={values.date}
                todayIso={ctx.today}
                onChange={(v) => set('date', v)}
              />
            </Field>
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
            </>
          )}
          {single ? (
            <p className="self-end text-xs text-muted-foreground sm:pb-2">
              Время объекта: {ctx.site.timezoneLabel}
            </p>
          ) : null}
          {primary}
        </CardContent>
      </Card>

      {secondary.length > 0 ? (
        <>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between sm:hidden"
            aria-expanded={open}
            onClick={() => setMore(!open)}
          >
            <span>Ещё: время, марка, комментарий…</span>
            <ChevronDown aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
          <Card className={cn(!open && 'hidden sm:block')} data-testid="form-more">
            <CardContent className="grid gap-3 pt-4 @md:grid-cols-2 sm:gap-4 sm:pt-5">
              {secondary}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

const secondaryKeys = new Set([
  'brand',
  'driverName',
  'driverPhone',
  'startTime',
  'endTime',
  'windowFromTime',
  'windowToTime',
  'windowFrom',
  'windowTo',
  'dockId',
  'destinationZoneId',
  'purposeId',
  'comment',
]);

function passTypeLabel(type: PassType, hints: PassHints | undefined): string {
  const mode = hints?.passTypes.find((p) => p.passType === type)?.mode;
  return mode
    ? `${PASS_TYPE_LABEL[type]} — ${PASS_TYPE_MODE[mode] ?? mode}`
    : PASS_TYPE_LABEL[type];
}

/** Что получится: «С сейчас до 11.03.2026 11:40 (Челябинск, UTC+5)» или «Весь день до 23:59». */
function spanHint(props: PassFormFieldsProps, nextDay: boolean): string {
  const { values, ctx, view, nowMs } = props;
  const label = ctx.site.timezoneLabel;
  if (values.date && values.date > ctx.today && !values.startTime && !values.endTime) {
    return `Время не указано — пропуск действует весь день, до 23:59 (${label}).`;
  }
  if (values.date === ctx.today && values.startAuto && values.endAuto && values.startTime) {
    const end = new Date(nowMs + view.singleHours * 3_600_000).toISOString();
    return `С «сейчас» до ${formatInZone(end, ctx.site.timezone)} (${label}).`;
  }
  return nextDay ? `Окончание — завтра. Время объекта: ${label}` : `Время объекта: ${label}`;
}

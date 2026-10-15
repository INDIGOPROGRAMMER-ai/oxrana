import type { FieldMode, Participant, PassFormFieldKey, PassType } from '@oxrana/contracts';
import { formatInZone, localToInstant } from '@oxrana/ui';
import { addDays, instantToLocal } from './dates';
import { endsNextDay, timeOf } from './pass-time';

/** Значения формы пропуска: всё текстом, как в полях ввода (даты `ГГГГ-ММ-ДД`, время `ЧЧ:ММ`). */
export interface PassFormValues {
  participant: Participant;
  plate: string;
  categoryId: string;
  brand: string;
  driverName: string;
  driverPhone: string;
  personName: string;
  personDocument: string;
  passType: PassType;
  /** Разовый: дата приезда. */
  date: string;
  /** Разовый: время начала («сейчас», если пусто) и окончания («начало + N ч», если пусто). */
  startTime: string;
  endTime: string;
  /**
   * Начало подставлено само («сейчас» по поясу объекта) и не менялось: в запрос не уходит, начало
   * ставит сервер по своим часам — к моменту нажатия «Создать» прошло время, а допуск «в прошлом» короткий.
   */
  startAuto: boolean;
  /** Окончание подставлено само (начало + N часов) и следует за началом, пока его не правили. */
  endAuto: boolean;
  /** Окно прибытия разового пропуска: время в пределах даты приезда. */
  windowFromTime: string;
  windowToTime: string;
  /** Многоразовый и постоянный: начало (и конец у многоразового), дата. */
  from: string;
  to: string;
  /** Окно у многоразового и постоянного: дата и время `ГГГГ-ММ-ДДTЧЧ:ММ`. */
  windowFrom: string;
  windowTo: string;
  dockId: string;
  destinationZoneId: string;
  purposeId: string;
  comment: string;
}

export type PassFormErrors = Partial<Record<keyof PassFormValues, string>>;

/** Режимы полей, как их видит форма: окно «по политике» к этому моменту уже решено сервером. */
export type EffectiveFields = Record<PassFormFieldKey, FieldMode>;

export interface BuildContext {
  readonly tenantId: string;
  readonly timezone: string;
  /** Сегодняшняя дата объекта. */
  readonly today: string;
  /** «Сейчас» по часам сервера (мс). */
  readonly nowMs: number;
  readonly commentRequired: boolean;
  readonly windowRequired: boolean;
  readonly dockRequired: boolean;
  /** Режимы полей формы; без них — всё необязательно и видно (пакет и старые вызовы). */
  readonly fields?: EffectiveFields | undefined;
  /** Допуск «начало в прошлом», минут: от него зависит, можно ли предложить «начать пропуск с …». */
  readonly pastToleranceMin?: number | undefined;
  /** Максимум разового пропуска объекта, часов. */
  readonly singleMaxHours?: number | undefined;
}

/** Исправление ошибки одним нажатием: какие значения формы заменить («Начать окно с 13:50»). */
export interface PassFormFix {
  readonly id: 'window_start' | 'pass_start' | 'window_end' | 'pass_end';
  readonly label: string;
  readonly apply: Partial<PassFormValues>;
}

export type BuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: PassFormErrors; fixes: PassFormFix[] };

const text = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const splitDateTime = (value: string): [string, string] => {
  const [d = '', t = ''] = value.split('T');
  return [d, t];
};

const FIELD_NAMES: Record<PassFormFieldKey, string> = {
  brand: 'марку',
  driverName: 'ФИО водителя',
  driverPhone: 'телефон водителя',
  window: 'окно прибытия',
  destination: 'место назначения',
  purpose: 'цель визита',
  comment: 'комментарий',
};

/**
 * Тело `POST /passes` из значений формы. Время — в поясе объекта (ADR-009). Разовый пропуск
 * (ADR-023): начало «сейчас» и окончание «начало + N часов» считает **сервер**, если их не указали
 * (поэтому форме достаточно номера и типа); будущая дата — с 00:00. Поля, скрытые настройкой формы,
 * в тело не попадают; обязательные по настройке проверяются здесь, до запроса. Остальное
 * проверяет сервер.
 */
export function buildPassBody(values: PassFormValues, c: BuildContext): BuildResult {
  const errors: PassFormErrors = {};
  const body: Record<string, unknown> = {
    tenantId: c.tenantId,
    passType: values.passType,
    participant: values.participant,
  };
  const vehicle = values.participant === 'vehicle';
  const mode = (key: PassFormFieldKey): FieldMode => c.fields?.[key] ?? 'optional';

  if (vehicle) {
    const plate = text(values.plate);
    if (!plate) errors.plate = 'Укажите номер машины.';
    else body.plate = plate;
    if (!values.categoryId) errors.categoryId = 'Выберите тип транспорта.';
    else body.categoryId = values.categoryId;
    for (const [key, field] of [
      ['brand', 'brand'],
      ['driverName', 'driverName'],
      ['driverPhone', 'driverPhone'],
    ] as const) {
      if (mode(key) === 'hidden') continue;
      const v = text(values[field]);
      if (v) body[field] = v;
      else if (mode(key) === 'required') errors[field] = `Укажите ${FIELD_NAMES[key]}.`;
    }
  } else {
    const name = text(values.personName);
    if (!name) errors.personName = 'Укажите фамилию и имя пешехода.';
    else body.personName = name;
    const doc = text(values.personDocument);
    if (doc) body.personDocument = doc;
  }

  if (values.dockId) body.dockId = values.dockId;
  // Док обязателен только разовому: многоразовый и постоянный — на много поездок, док каждый раз свой.
  else if (vehicle && c.dockRequired && values.passType === 'single')
    errors.dockId = 'Укажите док.';
  if (mode('destination') !== 'hidden') {
    if (values.destinationZoneId) body.destinationZoneId = values.destinationZoneId;
    else if (mode('destination') === 'required')
      errors.destinationZoneId = 'Укажите место назначения.';
  }
  if (mode('purpose') !== 'hidden') {
    if (values.purposeId) body.purposeId = values.purposeId;
    else if (mode('purpose') === 'required') errors.purposeId = 'Укажите цель визита.';
  }
  if (mode('comment') !== 'hidden') {
    const comment = text(values.comment);
    if (comment) body.comment = comment;
    else if (c.commentRequired || mode('comment') === 'required') {
      errors.comment = 'Укажите, для чего и зачем нужен пропуск.';
    }
  }

  const startOf = (date: string): string => localToInstant(date, '00:00', c.timezone);
  const endOf = (date: string): string => localToInstant(date, '23:59', c.timezone);
  const windowHidden = !vehicle || mode('window') === 'hidden';
  const fixes: PassFormFix[] = [];
  const tolerance = (c.pastToleranceMin ?? 0) * 60_000;
  const maxHours = c.singleMaxHours ?? 24;
  const hhmm = (ms: number) => timeOf(ms, c.timezone);
  const stamp = (ms: number) => formatInZone(new Date(ms).toISOString(), c.timezone);
  /** Одни и те же сутки — только время («13:50»), разные — с датой. */
  const say = (ms: number, ref: number) =>
    stamp(ms).slice(0, 10) === stamp(ref).slice(0, 10) ? hhmm(ms) : stamp(ms);

  /**
   * Окно внутри срока пропуска (7b.1): ошибка называет оба времени и предлагает исправить одним
   * нажатием — подвинуть окно или сам пропуск (если начало в допуске «в прошлом»).
   */
  const checkWindow = (
    wf: number,
    wt: number,
    start: number,
    end: number | undefined,
    where: { from: keyof PassFormValues; to: keyof PassFormValues; single: boolean },
  ) => {
    const range = `${say(wf, start)}–${say(wt, start)}`;
    const windowFix = (ms: number, edge: 'from' | 'to'): Partial<PassFormValues> =>
      where.single
        ? edge === 'from'
          ? { windowFromTime: hhmm(ms) }
          : { windowToTime: hhmm(ms) }
        : edge === 'from'
          ? { windowFrom: instantToLocal(new Date(ms).toISOString(), c.timezone) }
          : { windowTo: instantToLocal(new Date(ms).toISOString(), c.timezone) };
    if (wf < start) {
      errors[where.from] = `Окно ${range} начинается раньше начала пропуска (${say(start, wf)}).`;
      if (wt > start) {
        fixes.push({
          id: 'window_start',
          label: `Начать окно с ${say(start, wf)}`,
          apply: windowFix(start, 'from'),
        });
      }
      if (where.single && wf >= c.nowMs - tolerance && (end === undefined || wf < end)) {
        fixes.push({
          id: 'pass_start',
          label: `Начать пропуск с ${hhmm(wf)}`,
          apply: { startTime: hhmm(wf), startAuto: false },
        });
      }
    } else if (end !== undefined && wt > end) {
      errors[where.to] = `Окно ${range} заканчивается позже конца пропуска (${say(end, wt)}).`;
      if (wf < end) {
        fixes.push({
          id: 'window_end',
          label: `Закончить окно в ${say(end, wf)}`,
          apply: windowFix(end, 'to'),
        });
      }
      if (where.single && wt - start <= maxHours * 3_600_000 && end - wf < 24 * 3_600_000) {
        fixes.push({
          id: 'pass_end',
          label: `Продлить пропуск до ${hhmm(wt)}`,
          apply: { endTime: hhmm(wt), endAuto: false },
        });
      }
    }
  };

  if (values.passType === 'single') {
    if (!values.date) errors.date = 'Выберите дату приезда.';
    else if (values.date < c.today)
      errors.date = 'Дата приезда в прошлом — выберите сегодня или позже.';
    const hasFrom = !windowHidden && values.windowFromTime !== '';
    const hasTo = !windowHidden && values.windowToTime !== '';
    if (!windowHidden && c.windowRequired && !hasFrom)
      errors.windowFromTime = 'Окно прибытия обязательно: укажите «с».';
    if (!windowHidden && c.windowRequired && !hasTo)
      errors.windowToTime = 'Окно прибытия обязательно: укажите «по».';
    if (hasFrom !== hasTo && !c.windowRequired) {
      errors[hasFrom ? 'windowToTime' : 'windowFromTime'] = 'Укажите окно целиком: «с» и «по».';
    }
    if (hasFrom && hasTo && values.windowToTime <= values.windowFromTime) {
      errors.windowToTime = 'Конец окна должен быть позже начала.';
    }
    if (values.date && !errors.date) {
      const windowFrom = hasFrom
        ? localToInstant(values.date, values.windowFromTime, c.timezone)
        : undefined;
      const futureDay = values.date > c.today;
      // «сейчас» подставлено само и не менялось — начало и окончание ставит сервер по своим часам
      const startAuto = values.startAuto && values.startTime !== '' && !futureDay;
      const nextDay = endsNextDay(values.startTime, values.endTime);
      let validFrom: string | undefined;
      let validTo: string | undefined;
      if (values.startTime && !startAuto) {
        validFrom = localToInstant(values.date, values.startTime, c.timezone);
      } else if (!values.startTime && futureDay) {
        // будущая дата без времени: пропуск действует весь день (Q-87)
        validFrom = startOf(values.date);
      } else if (!values.startTime && windowFrom && Date.parse(windowFrom) > c.nowMs) {
        // окно позже «сейчас»: пропуск начинает действовать с окна
        validFrom = windowFrom;
      }
      // иначе начало не указано или подставлено само: сервер поставит «сейчас» по своим часам
      if (values.endTime) {
        if (!(startAuto && values.endAuto)) {
          validTo = localToInstant(
            nextDay ? addDays(values.date, 1) : values.date,
            values.endTime,
            c.timezone,
          );
        }
      } else if (!values.startTime && futureDay) {
        validTo = endOf(values.date);
      }
      if (validFrom) body.validFrom = validFrom;
      if (validTo) body.validTo = validTo;
      if (windowFrom && hasTo) {
        body.windowFrom = windowFrom;
        body.windowTo = localToInstant(values.date, values.windowToTime, c.timezone);
        if (!errors.windowToTime) {
          checkWindow(
            Date.parse(windowFrom),
            Date.parse(String(body.windowTo)),
            validFrom ? Date.parse(validFrom) : c.nowMs,
            validTo ? Date.parse(validTo) : undefined,
            { from: 'windowFromTime', to: 'windowToTime', single: true },
          );
        }
      }
    }
  } else {
    if (!values.from) errors.from = 'Выберите, с какой даты действует пропуск.';
    else if (values.from < c.today) errors.from = 'Начало в прошлом — выберите сегодня или позже.';
    if (values.passType === 'multi') {
      if (!values.to) errors.to = 'Выберите, по какую дату действует пропуск.';
      else if (values.from && values.to < values.from) errors.to = 'Окончание раньше начала.';
    }
    if (values.from && !errors.from) {
      body.validFrom =
        values.from === c.today ? new Date(c.nowMs).toISOString() : startOf(values.from);
    }
    if (values.passType === 'multi' && values.to && !errors.to) body.validTo = endOf(values.to);
    if (!windowHidden) {
      const [wfd, wft] = splitDateTime(values.windowFrom);
      const [wtd, wtt] = splitDateTime(values.windowTo);
      if (c.windowRequired && !(wfd && wft))
        errors.windowFrom = 'Окно прибытия обязательно: укажите «с».';
      if (c.windowRequired && !(wtd && wtt))
        errors.windowTo = 'Окно прибытия обязательно: укажите «по».';
      if (wfd && wft && wtd && wtt) {
        body.windowFrom = localToInstant(wfd, wft, c.timezone);
        body.windowTo = localToInstant(wtd, wtt, c.timezone);
        if (typeof body.validFrom === 'string' && !errors.from) {
          checkWindow(
            Date.parse(String(body.windowFrom)),
            Date.parse(String(body.windowTo)),
            Date.parse(body.validFrom),
            typeof body.validTo === 'string' ? Date.parse(body.validTo) : undefined,
            { from: 'windowFrom', to: 'windowTo', single: false },
          );
        }
      }
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors, fixes } : { ok: true, body };
}

/** Поле сервера → поле формы (сервер знает `validFrom`, форма — «дата приезда» и «окно с»). */
export function formField(
  serverField: string | null,
  passType: PassType,
): keyof PassFormValues | null {
  switch (serverField) {
    case 'validFrom':
      return passType === 'single' ? 'startTime' : 'from';
    case 'validTo':
      return passType === 'single' ? 'endTime' : 'to';
    case 'windowFrom':
      return passType === 'single' ? 'windowFromTime' : 'windowFrom';
    case 'windowTo':
      return passType === 'single' ? 'windowToTime' : 'windowTo';
    case 'plate':
    case 'categoryId':
    case 'personName':
    case 'dockId':
    case 'destinationZoneId':
    case 'purposeId':
    case 'comment':
    case 'brand':
    case 'driverName':
    case 'driverPhone':
    case 'personDocument':
      return serverField;
    default:
      return null;
  }
}

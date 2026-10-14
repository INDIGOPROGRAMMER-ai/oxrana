import type { Participant, PassType } from '@oxrana/contracts';
import { localToInstant } from '@oxrana/ui';

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
}

export type BuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: PassFormErrors };

const text = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const splitDateTime = (value: string): [string, string] => {
  const [d = '', t = ''] = value.split('T');
  return [d, t];
};

/**
 * Тело `POST /passes` из значений формы. Время — в поясе объекта (ADR-009): «сегодня без окна» —
 * начало «сейчас» по часам сервера, будущая дата — с 00:00, конец — 23:59. Проверка обязательных
 * полей здесь даёт человеку ошибку у нужного поля до запроса; остальное проверяет сервер.
 */
export function buildPassBody(values: PassFormValues, c: BuildContext): BuildResult {
  const errors: PassFormErrors = {};
  const body: Record<string, unknown> = {
    tenantId: c.tenantId,
    passType: values.passType,
    participant: values.participant,
  };
  const vehicle = values.participant === 'vehicle';

  if (vehicle) {
    const plate = text(values.plate);
    if (!plate) errors.plate = 'Укажите номер машины.';
    else body.plate = plate;
    if (!values.categoryId) errors.categoryId = 'Выберите тип транспорта.';
    else body.categoryId = values.categoryId;
    for (const key of ['brand', 'driverName', 'driverPhone'] as const) {
      const v = text(values[key]);
      if (v) body[key] = v;
    }
  } else {
    const name = text(values.personName);
    if (!name) errors.personName = 'Укажите фамилию и имя пешехода.';
    else body.personName = name;
    const doc = text(values.personDocument);
    if (doc) body.personDocument = doc;
  }

  if (values.dockId) body.dockId = values.dockId;
  else if (vehicle && c.dockRequired) errors.dockId = 'Укажите док.';
  if (values.destinationZoneId) body.destinationZoneId = values.destinationZoneId;
  if (values.purposeId) body.purposeId = values.purposeId;
  const comment = text(values.comment);
  if (comment) body.comment = comment;
  else if (c.commentRequired) errors.comment = 'Укажите, для чего и зачем нужен пропуск.';

  const startOf = (date: string): string =>
    date === c.today ? new Date(c.nowMs).toISOString() : localToInstant(date, '00:00', c.timezone);
  const endOf = (date: string): string => localToInstant(date, '23:59', c.timezone);

  if (values.passType === 'single') {
    if (!values.date) errors.date = 'Выберите дату приезда.';
    else if (values.date < c.today)
      errors.date = 'Дата приезда в прошлом — выберите сегодня или позже.';
    const hasFrom = values.windowFromTime !== '';
    const hasTo = values.windowToTime !== '';
    if (c.windowRequired && !hasFrom)
      errors.windowFromTime = 'Окно прибытия обязательно: укажите «с».';
    if (c.windowRequired && !hasTo)
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
      body.validFrom = windowFrom ?? startOf(values.date);
      body.validTo = endOf(values.date);
      if (windowFrom && hasTo) {
        body.windowFrom = windowFrom;
        body.windowTo = localToInstant(values.date, values.windowToTime, c.timezone);
      }
    }
  } else {
    if (!values.from) errors.from = 'Выберите, с какой даты действует пропуск.';
    else if (values.from < c.today) errors.from = 'Начало в прошлом — выберите сегодня или позже.';
    if (values.passType === 'multi') {
      if (!values.to) errors.to = 'Выберите, по какую дату действует пропуск.';
      else if (values.from && values.to < values.from) errors.to = 'Окончание раньше начала.';
    }
    if (values.from && !errors.from) body.validFrom = startOf(values.from);
    if (values.passType === 'multi' && values.to && !errors.to) body.validTo = endOf(values.to);
    const [wfd, wft] = splitDateTime(values.windowFrom);
    const [wtd, wtt] = splitDateTime(values.windowTo);
    if (c.windowRequired && !(wfd && wft))
      errors.windowFrom = 'Окно прибытия обязательно: укажите «с».';
    if (c.windowRequired && !(wtd && wtt))
      errors.windowTo = 'Окно прибытия обязательно: укажите «по».';
    if (wfd && wft && wtd && wtt) {
      body.windowFrom = localToInstant(wfd, wft, c.timezone);
      body.windowTo = localToInstant(wtd, wtt, c.timezone);
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body };
}

/** Поле сервера → поле формы (сервер знает `validFrom`, форма — «дата приезда» и «окно с»). */
export function formField(
  serverField: string | null,
  passType: PassType,
): keyof PassFormValues | null {
  switch (serverField) {
    case 'validFrom':
      return passType === 'single' ? 'date' : 'from';
    case 'validTo':
      return passType === 'single' ? 'date' : 'to';
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

import { maskDate, maskTime, parseRuDate, parseTime } from '@oxrana/ui';
import { endAfter, minutesOfTime, timeOf } from './pass-time';

/**
 * Время строки пакета (7b.2): у каждой машины свой срок. Ячейки «Дата», «С», «По» приходят из Excel
 * как текст («15.10.2026», «13:44», «1344», а то и числом Excel), а в предпросмотре правятся тем же
 * компонентом, что в форме. Пустая ячейка — общее значение сверху. Чистые функции без часов среды:
 * «сейчас» и пояс передаются параметром.
 */

/** Результат разбора ячейки: значение, `null` — ячейка пуста, `error` — не распознано. */
export type CellResult<T> = { value: T } | { error: string } | null;

const pad = (n: number) => String(n).padStart(2, '0');

/** Дата Excel (число дней от 30.12.1899) → `ГГГГ-ММ-ДД`. */
function excelDate(serial: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Время Excel (доля суток) → `ЧЧ:ММ`. */
function excelTime(fraction: number): string {
  const minutes = Math.round((fraction - Math.floor(fraction)) * 1440) % 1440;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

const SERIAL = /^\d{5}(?:[.,]\d+)?$/;
const FRACTION = /^0[.,]\d+$/;
/** Дата-время Excel одним числом: целая часть — день, дробная — время суток (`46311.33`). */
const SERIAL_STAMP = /^\d{5}[.,]\d+$/;

/** Число Excel с датой и временем → день и время суток (минуты округляются; полночь переносит день). */
function excelStamp(serial: number): { date: string; time: string } {
  const total = Math.round(serial * 1440);
  const day = Math.floor(total / 1440);
  const minutes = total - day * 1440;
  return { date: excelDate(day), time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` };
}

/** Допуск объекта для даты без года: сколько минут назад ещё считается «сегодня» (`pastToleranceMin`). */
export interface YearGrace {
  readonly minutesIntoDay: number;
  readonly toleranceMin: number;
}

function yesterdayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Дата из ячейки: `15.10.2026`, `15.10.26`, `15.10` (год — текущий), `2026-10-15`, число Excel.
 * `todayIso` — сегодняшняя дата объекта (год для записи без года).
 */
export function parseDateCell(
  text: string,
  todayIso: string,
  grace?: YearGrace,
): CellResult<string> {
  const raw = text.trim();
  if (raw === '') return null;
  if (SERIAL.test(raw)) {
    const serial = Number(raw.replace(',', '.'));
    if (serial >= 20_000 && serial <= 80_000) return { value: excelDate(serial) };
  }
  const short = /^(\d{1,2})[./](\d{1,2})$/.exec(raw);
  if (short) {
    // без года: этот год, а если день уже прошёл (с учётом допуска объекта) — следующий
    const year = Number(todayIso.slice(0, 4));
    const day = `${pad(Number(short[1]))}.${pad(Number(short[2]))}`;
    const thisYear = parseRuDate(`${day}.${year}`);
    if (thisYear) {
      const stillToday =
        grace !== undefined &&
        thisYear === yesterdayOf(todayIso) &&
        grace.minutesIntoDay < grace.toleranceMin;
      if (thisYear >= todayIso || stillToday) return { value: thisYear };
      const next = parseRuDate(`${day}.${year + 1}`);
      // 29.02 в високосный год: следующего 29.02 нет — дата не распознана, а не молча 01.03
      if (next) return { value: next };
    }
  }
  const twoDigitYear = /^(\d{1,2})[./](\d{1,2})[./](\d{2})$/.exec(raw);
  const normalized = twoDigitYear
    ? `${twoDigitYear[1]}.${twoDigitYear[2]}.20${twoDigitYear[3]}`
    : raw.replace(/\//g, '.');
  const iso = parseRuDate(maskDate(normalized));
  if (iso) return { value: iso };
  return { error: `Дата «${raw}» не распознана. Пишите так: ${todayRu(todayIso)}.` };
}

const todayRu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Время из ячейки: `13:44`, `13.44`, `1344`, `9`, `13:44:00`, число Excel (доля суток). */
export function parseTimeCell(text: string): CellResult<string> {
  const raw = text.trim();
  if (raw === '') return null;
  if (FRACTION.test(raw) || (SERIAL.test(raw) && /[.,]/.test(raw))) {
    return { value: excelTime(Number(raw.replace(',', '.'))) };
  }
  const withSeconds = /^(\d{1,2}):(\d{2}):\d{2}$/.exec(raw);
  if (withSeconds) {
    const value = parseTime(`${pad(Number(withSeconds[1]))}:${withSeconds[2]}`);
    if (value) return { value };
  }
  // в ячейке только час: «9» → 09:00
  if (/^\d{1,2}$/.test(raw) && Number(raw) <= 23) return { value: `${pad(Number(raw))}:00` };
  const dotted = /^(\d{1,2})[.](\d{2})$/.exec(raw);
  const value = parseTime(maskTime(dotted ? `${dotted[1]}${dotted[2]}` : raw));
  if (value) return { value };
  return { error: `Время «${raw}» не распознано. Пишите так: 13:44.` };
}

/**
 * Ячейка «С» или «По» может содержать и дату, и время: «15.10.2026 13:44», только дату
 * («15.10.2026»), число Excel с датой и временем («46311.33» — целая часть день, дробная время),
 * число-дату («46311») или только время. Возвращает куски текста для `parseDateCell`/`parseTimeCell`.
 */
export function splitStamp(text: string): { date: string; time: string } {
  const raw = text.trim();
  if (SERIAL_STAMP.test(raw)) {
    const serial = Number(raw.replace(',', '.'));
    if (serial >= 20_000 && serial <= 80_000) return excelStamp(serial);
  }
  if (/^\d{5}$/.test(raw) && Number(raw) >= 20_000 && Number(raw) <= 80_000) {
    return { date: raw, time: '' };
  }
  // только полная дата (с годом): «13.44» остаётся временем, «15.10» без года — тоже временем-ошибкой
  if (/^(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})$/.test(raw)) {
    return { date: raw, time: '' };
  }
  const m = /^(\S+)\s+(\d{1,2}[:.]\d{2}(?::\d{2})?)$/.exec(raw);
  return m ? { date: m[1] ?? '', time: m[2] ?? '' } : { date: '', time: raw };
}

/** Общие значения пакета: по умолчанию для строк с пустой ячейкой. */
export interface CommonTime {
  /** Разовый: дата приезда. Многоразовый и постоянный: не используется. */
  readonly date: string;
  /** Разовый: время начала («» — «сейчас», если включено в настройке формы). */
  readonly start: string;
  /** Разовый: время окончания («» — начало + часы из настройки). */
  readonly end: string;
  /** Многоразовый и постоянный: даты начала и конца. */
  readonly from: string;
  readonly to: string;
}

/** Свои значения строки: то, что в ячейках или правке в предпросмотре (текст как есть). */
export interface RowTimeText {
  readonly dateText: string;
  readonly fromText: string;
  readonly toText: string;
}

export interface TimeEnv {
  readonly todayIso: string;
  readonly nowMs: number;
  readonly timezone: string;
  /** Время начала по умолчанию — «сейчас» (настройка формы). */
  readonly startNow: boolean;
  readonly singleHours: number;
  readonly singleMaxHours: number;
  /** Допуск «начало в прошлом», мин: даты без года и «вчера» сразу после полуночи (7b.3). */
  readonly pastToleranceMin?: number | undefined;
}

/** Допуск для даты без года из окружения расчёта. */
export function graceOf(env: TimeEnv): YearGrace {
  return {
    minutesIntoDay: minutesOfTime(timeOf(env.nowMs, env.timezone)),
    toleranceMin: env.pastToleranceMin ?? 0,
  };
}

/** Итоговое время строки, как его понимает форма пропуска (`PassFormValues`), и откуда оно взято. */
export interface RowTime {
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startAuto: boolean;
  readonly endAuto: boolean;
  /** Конец разового с датой, указанной явно (`ДД.ММ.ГГГГ ЧЧ:ММ` в «По»); `''` — день определяется началом. */
  readonly endDate: string;
  readonly from: string;
  readonly to: string;
  /** Что в строке своё (не общее): подпись «время общее» в предпросмотре. */
  readonly own: boolean;
  /** Ячейка не распознана: текст ошибки (строка не создаётся, пока её не поправят). */
  readonly error: string | null;
}

/** Свои значения строки без подстановки общих: нормализованные дата и время или `''`. */
export interface OwnTime {
  readonly date: string;
  readonly start: string;
  readonly end: string;
  /** Дата конца, если она указана в «По» явно (разовый). */
  readonly endDate: string;
  readonly from: string;
  readonly to: string;
  readonly error: string | null;
}

/**
 * Что в строке своё. Разовый: «Дата», «С» и «По» — время; в «С» и «По» может стоять и дата со
 * временем («17.10.2026 09:00», число Excel «46311.33»): дата «По» — день конца. Многоразовый и
 * постоянный: «С» и «По» — даты, а если «С» пуста, годится «Дата». Дата без года — этот год, а если
 * день уже прошёл (с учётом допуска `grace`), то следующий.
 */
export function ownTime(
  passType: 'single' | 'multi' | 'permanent',
  row: RowTimeText,
  todayIso: string,
  grace?: YearGrace,
): OwnTime {
  let error: string | null = null;
  const take = <T>(result: CellResult<T>): T | '' => {
    if (result && 'error' in result) {
      error ??= result.error;
      return '';
    }
    return result ? result.value : '';
  };
  if (passType !== 'single') {
    const fromCell = row.fromText.trim() !== '' ? row.fromText : row.dateText;
    return {
      date: '',
      start: '',
      end: '',
      endDate: '',
      from: take(parseDateCell(splitStamp(fromCell).date || fromCell, todayIso, grace)),
      to: take(parseDateCell(splitStamp(row.toText).date || row.toText, todayIso, grace)),
      error,
    };
  }
  const from = splitStamp(row.fromText);
  const to = splitStamp(row.toText);
  const out = {
    date: take(
      parseDateCell(row.dateText.trim() !== '' ? row.dateText : from.date, todayIso, grace),
    ),
    start: take(parseTimeCell(from.time)),
    end: take(parseTimeCell(to.time)),
    endDate: take(parseDateCell(to.date, todayIso, grace)),
    from: '',
    to: '',
  };
  // дата конца без времени молча превратилась бы в «начало + N часов»
  if (out.endDate !== '' && out.end === '' && error === null) {
    error = `В «По» указана дата без времени. Пишите так: ${todayRu(out.endDate)} 18:00.`;
  }
  return { ...out, error };
}

/**
 * Итоговое время строки: своя ячейка, а если она пуста — общее значение. Окончание разового
 * подставляется само: начало + часы из настройки, не больше максимума объекта.
 */
export function rowTime(
  passType: 'single' | 'multi' | 'permanent',
  row: RowTimeText,
  common: CommonTime,
  env: TimeEnv,
): RowTime {
  const mine = ownTime(passType, row, env.todayIso, graceOf(env));
  const own = row.dateText.trim() !== '' || row.fromText.trim() !== '' || row.toText.trim() !== '';
  if (passType !== 'single') {
    return {
      date: '',
      startTime: '',
      endTime: '',
      startAuto: false,
      endAuto: false,
      endDate: '',
      from: mine.from || common.from,
      to: mine.to || common.to,
      own,
      error: mine.error,
    };
  }
  const day = mine.date || common.date;
  const startOwn = mine.start || common.start;
  const endOwn = mine.end || common.end;
  // «сейчас» подставляется само, пока время начала не задано (ни в строке, ни сверху)
  const startAuto = startOwn === '' && day === env.todayIso && env.startNow;
  const startTime = startAuto ? timeOf(env.nowMs, env.timezone) : startOwn;
  const endAuto = endOwn === '';
  const endTime =
    endAuto && startTime ? endAfter(startTime, env.singleHours, env.singleMaxHours).time : endOwn;
  return {
    date: day,
    startTime,
    endTime,
    startAuto,
    endAuto,
    endDate: mine.endDate,
    from: '',
    to: '',
    own,
    error: mine.error,
  };
}

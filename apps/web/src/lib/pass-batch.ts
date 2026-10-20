import { type ParsedRow, parseTableText, passFormFieldKeys } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import { formatInZone, localToInstant as localInstant } from '@oxrana/ui';
import {
  type BatchColumn,
  type BatchLayout,
  COLUMN_TITLE,
  fleetBatchLayout,
  passBatchLayout,
} from './batch-columns';
import { type RowTimeText, rowTime, type TimeEnv } from './batch-time';
import { addDays } from './dates';
import { buildPassBody, type EffectiveFields, type PassFormValues } from './pass-form';
import { timeOf } from './pass-time';

/** Что кабинет знает о справочниках для разбора таблицы. */
export interface BatchCatalog {
  readonly categories: readonly { id: string; name: string; dockEligible?: boolean }[];
  readonly docks: readonly { id: string; number: string }[];
  readonly zones?: readonly { id: string; name: string }[];
  readonly defaultCategoryId: string | null;
}

/**
 * Общие для всей пачки настройки: вид пропуска и срок. Срок — значения по умолчанию для строк, у
 * которых ячейки «Дата», «С», «По» пусты (7b.2).
 */
export interface BatchSettings {
  readonly passType: 'single' | 'multi' | 'permanent';
  /** Разовый: дата приезда. */
  readonly date: string;
  /** Разовый: время начала и окончания (`''` — «сейчас» и «начало + часы из настройки»). */
  readonly start: string;
  readonly end: string;
  /** Многоразовый и постоянный: начало и (у многоразового) конец. */
  readonly from: string;
  readonly to: string;
  /** Подставляется в строки без своего комментария. */
  readonly comment: string;
}

/**
 * Строка пачки: то, что было в таблице, уже сопоставленное со справочниками. Строка живёт в
 * состоянии экрана и правится прямо в предпросмотре — тип, док, место, время (этап 7b).
 */
export interface BatchRow extends RowTimeText {
  /** Номер строки в таблице (с 1, считая и заголовок). */
  readonly line: number;
  readonly plate: string;
  /** Тип как написан в таблице (для сообщений). */
  readonly categoryText: string;
  /** `''` — тип не выбран: пусто, не найден или неоднозначен. */
  readonly categoryId: string;
  /** Подходящие типы, когда написанное неоднозначно («грузовой» при двух грузовых типах). */
  readonly candidates: readonly string[];
  readonly brand: string;
  readonly driverName: string;
  readonly driverPhone: string;
  readonly comment: string;
  readonly dockId: string;
  readonly zoneId: string;
  /** Окно как текст: «12:00-14:00»; правится в предпросмотре. */
  readonly windowText: string;
  /** Что подставлено из других ячеек или справочников («тип по умолчанию»). */
  readonly note: string;
  /** Что не удалось понять в таблице (док, место) — показывается, пока строку не поправят. */
  readonly problems: Readonly<Partial<Record<'category' | 'dock' | 'zone', string>>>;
}

/** Результат разбора таблицы: строки и колонки, которые форма не принимает. */
export interface BatchImport {
  readonly rows: ParsedRow<BatchRow>[];
  /** Колонки таблицы, значения которых не попадут в пропуска (поле отключено настройкой формы). */
  readonly ignoredColumns: string[];
  readonly headerFound: boolean;
}

/** Названия колонок в заголовке: по началу слова, без регистра («С» и «По» — только целиком). */
const HEADER_WORDS: Record<BatchColumn, RegExp> = {
  plate: /^(номер|гос|гос\.?\s*номер|госномер|регистр|рег\.?\s*номер|№|plate)/,
  type: /^(тип|вид|категор|транспорт|тс\b|машин)/,
  brand: /^(марка|модел|brand)/,
  driver: /^(водител|фио|ф\.?\s?и\.?\s?о|имя)/,
  phone: /^(телефон|тел\b|тел\.|моб)/,
  window: /^(окно|врем|прибыт|приезд)/,
  comment: /^(коммент|примеч|цель|заметк)/,
  dock: /^(док|ворот|рампа)/,
  zone: /^(мест|назнач|зона|куда|площадк)/,
  date: /^(дата|день)/,
  from: /^(с|от|начало|начал\S*|действует с)$/,
  to: /^(по|до|конец|окончание|действует по|действует до)$/,
};

const clean = (value: string) =>
  value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ');

function headerColumn(cell: string): BatchColumn | null {
  const text = clean(cell).replace(/:+$/, '');
  if (text === '') return null;
  return (
    (Object.keys(HEADER_WORDS) as BatchColumn[]).find((c) => HEADER_WORDS[c].test(text)) ?? null
  );
}

/** Первая строка — заголовок, если в ней узнаются названия колонок и нет ничего похожего на номер. */
function headerMap(first: readonly string[]): (BatchColumn | null)[] | null {
  const mapped = first.map(headerColumn);
  const found = mapped.filter((c) => c !== null).length;
  if (found === 0) return null;
  // «А123ВС174» в первой ячейке — это уже данные, даже если рядом слово «тип»
  if (normalizePlate(first[0] ?? '').recognized) return null;
  return found >= 2 || mapped[0] === 'plate' ? mapped : null;
}

/** Таблица из буфера или файла: Tab (Excel), `;`, запятая. */
export const tableOf = (text: string): string[][] => parseTableText(text);

// ---------- тип транспорта: формы слова, неоднозначность ----------

/** Основа слова: окончания падежей и родов отброшены («легковые» и «легковой» → «легков»). */
export function stem(word: string): string {
  const w = clean(word).replace(/[^\p{L}\p{N}]/gu, '');
  if (w.length <= 3) return w;
  const stripped = w.replace(
    /(ыми|ими|ого|его|ому|ему|ых|их|ым|им|ом|ем|ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|а|я|ы|и|у|ю|е|о|ь|й)$/u,
    '',
  );
  return stripped.length >= 3 ? stripped : w;
}

const tokens = (text: string): string[] =>
  clean(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '')
    .map(stem);

export type CategoryMatch =
  | { kind: 'ok'; id: string; name: string }
  | { kind: 'ambiguous'; candidates: { id: string; name: string }[] }
  | { kind: 'none' };

/**
 * Тип транспорта из ячейки: без учёта регистра и с формами слова («легковые» → «легковой»,
 * «малотоннажные» → «малотоннажный»). Если написанное подходит к нескольким типам («грузовой» при
 * двух грузовых), выбирать за человека нельзя — `ambiguous`.
 */
export function matchCategory(
  text: string,
  categories: readonly { id: string; name: string }[],
): CategoryMatch {
  const wanted = tokens(text);
  if (wanted.length === 0) return { kind: 'none' };
  const exact = categories.filter((c) => {
    const have = tokens(c.name);
    return have.length === wanted.length && wanted.every((t) => have.includes(t));
  });
  if (exact.length === 1 && exact[0]) return { kind: 'ok', id: exact[0].id, name: exact[0].name };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
  const partial = categories.filter((c) => {
    const have = tokens(c.name);
    return wanted.every((t) => have.includes(t));
  });
  if (partial.length === 1 && partial[0]) {
    return { kind: 'ok', id: partial[0].id, name: partial[0].name };
  }
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial };
  return { kind: 'none' };
}

function resolveDock(
  text: string,
  catalog: BatchCatalog,
): { id: string; error?: undefined } | { id: ''; error: string } | null {
  if (text.trim() === '') return null;
  const number = text.replace(/^(док|№|n)\s*/i, '').trim();
  const found = catalog.docks.find((d) => d.number.toLowerCase() === number.toLowerCase());
  if (found) return { id: found.id };
  const list = catalog.docks.map((d) => d.number).join(', ');
  return {
    id: '',
    error: `Док «${text}» не закреплён за вашей компанией. Ваши доки: ${list || 'нет'}. Выберите док ниже.`,
  };
}

function resolveZone(
  text: string,
  catalog: BatchCatalog,
): { id: string; error?: undefined } | { id: ''; error: string } | null {
  if (text.trim() === '') return null;
  const wanted = clean(text);
  const zones = catalog.zones ?? [];
  const found = zones.filter((z) => clean(z.name) === wanted);
  const loose = zones.filter((z) => clean(z.name).includes(wanted));
  const hit = found.length === 1 ? found[0] : loose.length === 1 ? loose[0] : undefined;
  if (hit) return { id: hit.id };
  return {
    id: '',
    error: `Место назначения «${text}» не найдено. Выберите место ниже: ${zones.map((z) => z.name).join(', ') || '—'}.`,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function time(h: string, m: string): string | null {
  const hh = Number(h);
  const mm = Number(m);
  return hh <= 23 && mm <= 59 ? `${pad(hh)}:${pad(mm)}` : null;
}

/** Окно прибытия из ячейки: «12:00-14:00», «с 12 до 14», «10.03.2026 12:00–14:00». */
export function parseWindow(
  text: string,
): { date: string; from: string; to: string } | { error: string } | null {
  const raw = text.trim();
  if (raw === '') return null;
  let date = '';
  let rest = raw;
  const d = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(raw);
  if (d) {
    date = `${d[3]}-${pad(Number(d[2]))}-${pad(Number(d[1]))}`;
    rest = raw.replace(d[0], ' ');
  }
  const times = [...rest.matchAll(/(\d{1,2})[:.](\d{2})/g)].map((m) =>
    time(m[1] ?? '', m[2] ?? ''),
  );
  let pair: (string | null)[] = times;
  if (times.length === 0) {
    const hours = /(\d{1,2})\s*(?:-|–|—|до)\s*(\d{1,2})/.exec(rest);
    if (hours) pair = [time(hours[1] ?? '', '0'), time(hours[2] ?? '', '0')];
  }
  const [from, to] = pair;
  if (pair.length !== 2 || !from || !to) {
    return { error: `Окно «${raw}» не распознано. Пишите так: 12:00-14:00.` };
  }
  if (to <= from) return { error: `Окно «${raw}»: конец должен быть позже начала.` };
  return { date, from, to };
}

// ---------- разбор таблицы ----------

/** Все поля формы необязательны: раскладка, когда настройки формы нет (юнит-тесты, старые вызовы). */
const OPEN_FIELDS = Object.fromEntries(
  passFormFieldKeys.map((key) => [key, 'optional']),
) as EffectiveFields;

function defaultLayout(catalog: BatchCatalog, kind: 'pass' | 'fleet'): BatchLayout {
  const input = { fields: OPEN_FIELDS, hasDocks: catalog.docks.length > 0, zoneChoice: false };
  return kind === 'pass' ? passBatchLayout(input) : fleetBatchLayout(input);
}

/**
 * Колонки таблицы, значения которых пакет не примет (поле отключено настройкой формы): только те,
 * что узнаны по заголовку и непусты. Без заголовка колонки идут по раскладке и лишних нет.
 */
export function ignoredColumnTitles(
  table: readonly (readonly string[])[],
  layout: BatchLayout,
): string[] {
  const first = table[0];
  const header = first ? headerMap(first) : null;
  if (!header) return [];
  const ignored = new Set<BatchColumn>();
  header.forEach((column, index) => {
    if (!column || layout.accepted.has(column)) return;
    if (table.slice(1).some((row) => (row[index] ?? '').trim() !== '')) ignored.add(column);
  });
  return [...ignored].map((c) => COLUMN_TITLE[c]);
}

/**
 * Разбор таблицы пропусков (08_ «Пакетный ввод»): колонки по заголовку (если он есть) или по порядку
 * раскладки — той, что строится из настройки формы пользователя (скрытое поле — нет колонки). Строки
 * независимы; в одной пачке могут быть разные типы транспорта. Пробелы и разделители в номерах не
 * мешают. Колонки, отключённые настройкой формы, не попадают в пропуска — список таких колонок
 * возвращается.
 */
export function importPassTable(
  table: readonly (readonly string[])[],
  catalog: BatchCatalog,
  layout: BatchLayout = defaultLayout(catalog, 'pass'),
): BatchImport {
  const first = table[0];
  const header = first ? headerMap(first) : null;
  const order: (BatchColumn | null)[] = header ?? layout.columns.map((c) => c.key);
  const rows: ParsedRow<BatchRow>[] = [];

  table.forEach((cells, index) => {
    if (header && index === 0) return;
    const line = index + 1;
    const at = (column: BatchColumn): string => {
      const i = order.indexOf(column);
      const value = i >= 0 ? (cells[i] ?? '').trim() : '';
      return layout.accepted.has(column) ? value : '';
    };
    const plateCell = (cells[Math.max(order.indexOf('plate'), 0)] ?? '').trim();
    if (normalizePlate(plateCell).norm === '') {
      rows.push({ line, error: 'Нет номера — ячейка с номером пуста.' });
      return;
    }
    const typeCell = at('type');
    const problems: { category?: string; dock?: string; zone?: string } = {};
    let categoryId = '';
    let candidates: string[] = [];
    let note = '';
    if (typeCell === '') {
      const byDefault = catalog.categories.find((c) => c.id === catalog.defaultCategoryId);
      if (byDefault) {
        categoryId = byDefault.id;
        note = `тип по умолчанию: ${byDefault.name}`;
      } else if (catalog.categories.length === 1 && catalog.categories[0]) {
        categoryId = catalog.categories[0].id;
        note = `единственный доступный тип: ${catalog.categories[0].name}`;
      } else {
        problems.category = 'Не указан тип транспорта — выберите ниже.';
      }
    } else {
      const match = matchCategory(typeCell, catalog.categories);
      if (match.kind === 'ok') categoryId = match.id;
      else if (match.kind === 'ambiguous') {
        candidates = match.candidates.map((c) => c.id);
        problems.category = `«${typeCell}» подходит к нескольким типам: ${match.candidates.map((c) => c.name).join(', ')}. Выберите нужный ниже.`;
      } else {
        problems.category = `Тип «${typeCell}» не найден среди доступных вашей компании: ${catalog.categories.map((c) => c.name).join(', ') || '—'}. Выберите ниже.`;
      }
    }
    const dock = resolveDock(at('dock'), catalog);
    if (dock?.error) problems.dock = dock.error;
    const zone = resolveZone(at('zone'), catalog);
    if (zone?.error) problems.zone = zone.error;
    rows.push({
      line,
      value: {
        line,
        plate: plateCell,
        categoryText: typeCell,
        categoryId,
        candidates,
        brand: at('brand'),
        driverName: at('driver'),
        driverPhone: at('phone'),
        comment: at('comment'),
        dockId: dock?.id ?? '',
        zoneId: zone?.id ?? '',
        windowText: at('window'),
        dateText: at('date'),
        fromText: at('from'),
        toText: at('to'),
        note,
        problems,
      },
    });
  });
  return {
    rows,
    ignoredColumns: ignoredColumnTitles(table, layout),
    headerFound: header !== null,
  };
}

/** Вставленный текст → строки (см. `importPassTable`). */
export function parseBatchRows(
  text: string,
  catalog: BatchCatalog,
  layout?: BatchLayout,
): BatchImport {
  return importPassTable(tableOf(text), catalog, layout);
}

// ---------- строка → тело запроса ----------

export interface BatchBuildContext {
  readonly timezone: string;
  readonly today: string;
  readonly nowMs: number;
  /** Режимы полей формы (скрытое в тело не попадает, обязательное проверяется). */
  readonly fields?: EffectiveFields | undefined;
  /** Тип транспорта «к доку» и док обязателен арендатору. */
  readonly dockRequiredFor?: (categoryId: string) => boolean;
  /** Единственное место назначения подставляется в строки без места. */
  readonly defaultZoneId?: string | undefined;
  /** Допуск «начало в прошлом» и максимум разового пропуска — для исправлений ошибок срока. */
  readonly pastToleranceMin?: number | undefined;
  readonly singleMaxHours?: number | undefined;
  /** Время начала подставляется само («сейчас» по поясу объекта) — настройка формы. */
  readonly startNow?: boolean | undefined;
  /** Окончание разового по умолчанию: начало + столько часов (настройка формы). */
  readonly singleHours?: number | undefined;
}

/** Исправление ошибки строки одним нажатием: «Начать окно с 13:50» → новое окно в строке. */
export interface RowFix {
  readonly label: string;
  readonly patch: Partial<BatchRow>;
}

export type BatchDraftResult =
  | {
      ok: true;
      draft: Record<string, unknown>;
      /** Итоговое действие пропуска в поясе объекта: «15.10 13:44 → 16.10 12:44». */
      span: string;
    }
  | { ok: false; error: string; fixes: RowFix[] };

/** Окружение расчёта времени строки из контекста сборки. */
export function timeEnvOf(c: BatchBuildContext): TimeEnv {
  return {
    todayIso: c.today,
    nowMs: c.nowMs,
    timezone: c.timezone,
    startNow: c.startNow ?? true,
    singleHours: c.singleHours ?? 23,
    singleMaxHours: c.singleMaxHours ?? 24,
    pastToleranceMin: c.pastToleranceMin,
  };
}

/** Общие значения пачки — значения по умолчанию для пустых ячеек «Дата», «С», «По». */
export const commonTimeOf = (settings: BatchSettings) => ({
  date: settings.date,
  start: settings.start,
  end: settings.end,
  from: settings.from,
  to: settings.to,
});

/** `15.10 13:44` — день и время в поясе объекта, без года (подпись строки). */
function stamp(ms: number, timezone: string): string {
  const full = formatInZone(new Date(ms).toISOString(), timezone);
  return `${full.slice(0, 5)} ${full.slice(11, 16)}`;
}

/** Итоговое действие пропуска: из тела запроса, а чего в нём нет, то подставит сервер («сейчас», +N ч). */
function spanText(
  draft: Record<string, unknown>,
  passType: BatchSettings['passType'],
  c: BatchBuildContext,
): string {
  const start = typeof draft.validFrom === 'string' ? Date.parse(draft.validFrom) : c.nowMs;
  const end =
    typeof draft.validTo === 'string'
      ? Date.parse(draft.validTo)
      : passType === 'single'
        ? start + Math.min(c.singleHours ?? 23, c.singleMaxHours ?? 24) * 3_600_000
        : null;
  return `${stamp(start, c.timezone)} → ${end === null ? 'без окончания' : stamp(end, c.timezone)}`;
}

const hhmm = (ms: number, timezone: string) => timeOf(ms, timezone);

/** `15.10.2026 13:44` — день и время в поясе объекта. */
const stampFull = (ms: number, timezone: string) =>
  formatInZone(new Date(ms).toISOString(), timezone);

/**
 * Проверки срока разового пропуска со своими исправлениями: начало уже прошло и выходит за допуск;
 * срок длиннее максимума объекта. Ошибка называет время, кнопка исправляет только эту строку.
 */
function singleSpanProblem(
  t: ReturnType<typeof rowTime>,
  date: string,
  c: BatchBuildContext,
): { error: string; fixes: RowFix[] } | null {
  const tz = c.timezone;
  const toMs = (day: string, time: string) => Date.parse(localInstant(day, time, tz));
  const tolerance = (c.pastToleranceMin ?? 0) * 60_000;
  const max = c.singleMaxHours ?? 24;
  if (!t.startAuto && t.startTime && date === c.today) {
    const startMs = toMs(date, t.startTime);
    if (startMs < c.nowMs - tolerance) {
      const now = hhmm(c.nowMs, tz);
      return {
        error: `Начало в ${t.startTime} уже прошло (сейчас ${now}, допуск «начало в прошлом» — ${c.pastToleranceMin ?? 0} мин).`,
        fixes: [{ label: `Начать с ${now}`, patch: { fromText: now } }],
      };
    }
  }
  if (t.startTime && t.endTime && !t.endAuto) {
    const startMs = t.startAuto ? c.nowMs : toMs(date, t.startTime);
    const nextDay = t.endDate === '' && t.endTime <= t.startTime;
    const endDay = t.endDate || (nextDay ? addDays(date, 1) : date);
    const endMs = toMs(endDay, t.endTime);
    // конец с явной датой не подменяется «завтра»: раньше начала — ошибка (CLAUDE.md п. 8)
    if (t.endDate !== '' && endMs <= startMs) {
      return {
        error: `Конец ${stampFull(endMs, tz)} раньше начала (${stampFull(startMs, tz)}). Проверьте дату в «По».`,
        fixes: [],
      };
    }
    if (endMs - startMs > max * 3_600_000) {
      const latestMs = startMs + max * 3_600_000;
      const latest = hhmm(latestMs, tz);
      const patchText = t.endDate === '' ? latest : stampFull(latestMs, tz);
      return {
        error: `Пропуск ${t.endDate === '' ? `${hhmm(startMs, tz)}–${t.endTime}${nextDay ? ' (завтра)' : ''}` : `${stampFull(startMs, tz)} → ${stampFull(endMs, tz)}`} действует дольше максимума объекта — ${max} ч.`,
        fixes: [{ label: `Закончить в ${latest}`, patch: { toText: patchText } }],
      };
    }
  }
  return null;
}

/**
 * Строка пачки → тело строки `POST /passes/batch`. Время считается так же, как в форме пропуска
 * (`buildPassBody`): у строки своя дата и время («Дата», «С», «По»), а пустая ячейка — общее значение
 * сверху; окончание подставляется само (начало + часы из настройки, не больше максимума объекта).
 */
export function batchDraft(
  line: BatchRow,
  settings: BatchSettings,
  c: BatchBuildContext,
): BatchDraftResult {
  const window = parseWindow(line.windowText);
  if (window && 'error' in window) return { ok: false, error: window.error, fixes: [] };
  if (line.problems.category && !line.categoryId)
    return { ok: false, error: line.problems.category, fixes: [] };
  if (line.problems.dock && !line.dockId)
    return { ok: false, error: line.problems.dock, fixes: [] };
  if (line.problems.zone && !line.zoneId)
    return { ok: false, error: line.problems.zone, fixes: [] };
  const t = rowTime(settings.passType, line, commonTimeOf(settings), timeEnvOf(c));
  if (t.error) return { ok: false, error: t.error, fixes: [] };
  const single = settings.passType === 'single';
  const date = single ? window?.date || t.date : t.date;
  if (single && date >= c.today) {
    const problem = singleSpanProblem(t, date, c);
    if (problem) return { ok: false, ...problem };
  }
  // окно позже «сейчас» и начало не задано: пропуск начинается с окна (как у пропуска без времени)
  const windowStartMs =
    single && window ? Date.parse(localInstant(date, window.from, c.timezone)) : 0;
  const startFromWindow = single && t.startAuto && window !== null && windowStartMs > c.nowMs;
  const values: PassFormValues = {
    participant: 'vehicle',
    plate: line.plate,
    categoryId: line.categoryId,
    brand: line.brand,
    driverName: line.driverName,
    driverPhone: line.driverPhone,
    personName: '',
    personDocument: '',
    passType: settings.passType,
    date,
    startTime: startFromWindow ? '' : t.startTime,
    endTime: startFromWindow && t.endAuto ? '' : t.endTime,
    startAuto: startFromWindow ? false : t.startAuto,
    endAuto: startFromWindow ? false : t.endAuto,
    endDate: single ? t.endDate : '',
    windowFromTime: single ? (window?.from ?? '') : '',
    windowToTime: single ? (window?.to ?? '') : '',
    from: t.from,
    to: t.to,
    windowFrom: !single && window ? `${date || t.from}T${window.from}` : '',
    windowTo: !single && window ? `${date || t.from}T${window.to}` : '',
    dockId: line.dockId,
    destinationZoneId: line.zoneId || c.defaultZoneId || '',
    purposeId: '',
    comment: line.comment || settings.comment,
  };
  const built = buildPassBody(values, {
    tenantId: '',
    timezone: c.timezone,
    today: c.today,
    nowMs: c.nowMs,
    commentRequired: false,
    windowRequired: false,
    dockRequired: Boolean(line.categoryId && c.dockRequiredFor?.(line.categoryId)),
    fields: c.fields,
    pastToleranceMin: c.pastToleranceMin,
    singleMaxHours: c.singleMaxHours,
  });
  if (!built.ok) {
    // исправления переводятся в правку строки: окно, время начала и окончания, дата
    const fixes: RowFix[] = [];
    for (const fix of built.fixes) {
      if (fix.id === 'pass_start' && fix.apply.startTime) {
        fixes.push({ label: fix.label, patch: { fromText: fix.apply.startTime } });
      } else if (fix.id === 'pass_end' && fix.apply.endTime) {
        fixes.push({ label: fix.label, patch: { toText: fix.apply.endTime } });
      } else if ((fix.id === 'window_start' || fix.id === 'window_end') && window) {
        const from = fix.apply.windowFromTime ?? fix.apply.windowFrom?.split('T')[1] ?? window.from;
        const to = fix.apply.windowToTime ?? fix.apply.windowTo?.split('T')[1] ?? window.to;
        fixes.push({ label: fix.label, patch: { windowText: `${from}–${to}` } });
      }
    }
    if (single && built.errors.date && !window?.date) {
      fixes.push({ label: 'Поставить сегодня', patch: { dateText: c.today } });
    }
    return { ok: false, error: Object.values(built.errors)[0] ?? 'Проверьте срок.', fixes };
  }
  const { tenantId: _tenant, ...draft } = built.body;
  return { ok: true, draft, span: spanText(draft, settings.passType, c) };
}

// ---------- автопарк ----------

/** Строка пакета автопарка. */
export interface FleetLine {
  readonly plate: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly brand: string;
  readonly driverName: string;
  readonly driverPhone: string;
  /** Комментарий и док по умолчанию для машины: подставляются в пропуск на неё. */
  readonly comment: string;
  readonly dockId: string;
  readonly dockNumber: string;
}

/**
 * Вставка автопарка: колонки — из настройки формы пользователя (скрытое поле — нет колонки,
 * обязательное — обязательная колонка): Номер · Тип · Марка · Водитель · Телефон · Комментарий · Док.
 * Повтор номера внутри списка — ошибка строки.
 */
export function parseFleetRows(
  text: string,
  catalog: BatchCatalog,
  layout: BatchLayout = defaultLayout(catalog, 'fleet'),
): ParsedRow<FleetLine>[] {
  const table = tableOf(text);
  const first = table[0];
  const header = first ? headerMap(first) : null;
  const order: (BatchColumn | null)[] = header ?? layout.columns.map((c) => c.key);
  const seen = new Set<string>();
  const rows: ParsedRow<FleetLine>[] = [];
  const names = catalog.categories.map((c) => c.name).join(', ');
  table.forEach((cells, index) => {
    if (header && index === 0) return;
    const line = index + 1;
    const at = (column: BatchColumn): string => {
      const i = order.indexOf(column);
      const value = i >= 0 ? (cells[i] ?? '').trim() : '';
      return layout.accepted.has(column) ? value : '';
    };
    const plateCell = (cells[Math.max(order.indexOf('plate'), 0)] ?? '').trim();
    const typeCell = at('type');
    const norm = normalizePlate(plateCell).norm;
    if (norm === '') {
      rows.push({ line, error: 'Нет номера — ячейка с номером пуста.' });
      return;
    }
    if (seen.has(norm)) {
      rows.push({ line, error: `Номер ${norm} уже встречается выше в этом списке.` });
      return;
    }
    // обязательная колонка: пустая ячейка — ошибка строки (сервер проверяет так же)
    const missing = layout.columns.find(
      (c) => c.required && c.key !== 'plate' && c.key !== 'type' && at(c.key) === '',
    );
    if (missing) {
      rows.push({
        line,
        error: `Не заполнена колонка «${missing.title}» — она обязательна по настройке формы пропуска.`,
      });
      return;
    }
    let category: { id: string; name: string; note?: string } | null = null;
    if (typeCell === '') {
      const byDefault = catalog.categories.find((c) => c.id === catalog.defaultCategoryId);
      if (byDefault) {
        category = {
          id: byDefault.id,
          name: byDefault.name,
          note: `тип по умолчанию: ${byDefault.name}`,
        };
      } else {
        rows.push({
          line,
          error: `Не указан тип транспорта. Доступные: ${names || 'для вашей компании типов нет'}.`,
        });
        return;
      }
    } else {
      const match = matchCategory(typeCell, catalog.categories);
      if (match.kind === 'ok') category = match;
      else if (match.kind === 'ambiguous') {
        rows.push({
          line,
          error: `«${typeCell}» подходит к нескольким типам: ${match.candidates.map((c) => c.name).join(', ')}. Напишите название полностью.`,
        });
        return;
      } else {
        rows.push({
          line,
          error: `Тип «${typeCell}» не найден среди доступных вашей компании: ${names || '—'}.`,
        });
        return;
      }
    }
    const dock = resolveDock(at('dock'), catalog);
    if (dock?.error) {
      rows.push({ line, error: dock.error.replace(' Выберите док ниже.', '') });
      return;
    }
    seen.add(norm);
    rows.push({
      line,
      value: {
        plate: plateCell,
        categoryId: category.id,
        categoryName: category.name,
        brand: at('brand'),
        driverName: at('driver'),
        driverPhone: at('phone'),
        comment: at('comment'),
        dockId: dock?.id ?? '',
        dockNumber: catalog.docks.find((d) => d.id === dock?.id)?.number ?? '',
      },
      ...(category.note ? { note: category.note } : {}),
    });
  });
  return rows;
}

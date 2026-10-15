import { type ParsedRow, parseTableText } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import { buildPassBody, type EffectiveFields, type PassFormValues } from './pass-form';

/** Что кабинет знает о справочниках для разбора таблицы. */
export interface BatchCatalog {
  readonly categories: readonly { id: string; name: string; dockEligible?: boolean }[];
  readonly docks: readonly { id: string; number: string }[];
  readonly zones?: readonly { id: string; name: string }[];
  readonly defaultCategoryId: string | null;
}

/** Общие для всей пачки настройки: тип пропуска и срок. */
export interface BatchSettings {
  readonly passType: 'single' | 'multi' | 'permanent';
  /** Разовый: дата приезда. */
  readonly date: string;
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
export interface BatchRow {
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

/** Колонки пакета. */
export type BatchColumn =
  | 'plate'
  | 'type'
  | 'brand'
  | 'driver'
  | 'phone'
  | 'window'
  | 'comment'
  | 'dock'
  | 'zone';

/** Порядок колонок без строки заголовков. */
const DEFAULT_ORDER: BatchColumn[] = [
  'plate',
  'type',
  'brand',
  'driver',
  'window',
  'comment',
  'dock',
];

/** Названия колонок в заголовке: по началу слова, без регистра. */
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
};

const COLUMN_TITLE: Record<BatchColumn, string> = {
  plate: 'Номер',
  type: 'Тип',
  brand: 'Марка',
  driver: 'Водитель',
  phone: 'Телефон',
  window: 'Окно',
  comment: 'Комментарий',
  dock: 'Док',
  zone: 'Место назначения',
};

const clean = (value: string) =>
  value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ');

function headerColumn(cell: string): BatchColumn | null {
  const text = clean(cell);
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

/** Что считается «отключённым» для колонки: поле выключено настройкой формы. */
function hiddenColumns(fields: EffectiveFields | undefined): Set<BatchColumn> {
  const out = new Set<BatchColumn>();
  if (!fields) return out;
  if (fields.brand === 'hidden') out.add('brand');
  if (fields.driverName === 'hidden') out.add('driver');
  if (fields.driverPhone === 'hidden') out.add('phone');
  if (fields.window === 'hidden') out.add('window');
  if (fields.comment === 'hidden') out.add('comment');
  if (fields.destination === 'hidden') out.add('zone');
  return out;
}

/**
 * Разбор таблицы пропусков (08_ «Пакетный ввод»): колонки по заголовку (если он есть) или по
 * порядку Номер · Тип · Марка · Водитель · Окно · Комментарий · Док. Строки независимы; в одной
 * пачке могут быть разные типы транспорта. Пробелы и разделители в номерах не мешают. Колонки,
 * отключённые настройкой формы, не попадают в пропуска — список таких колонок возвращается.
 */
export function importPassTable(
  table: readonly (readonly string[])[],
  catalog: BatchCatalog,
  fields?: EffectiveFields,
): BatchImport {
  const first = table[0];
  const header = first ? headerMap(first) : null;
  const order: (BatchColumn | null)[] = header ?? DEFAULT_ORDER;
  const hidden = hiddenColumns(fields);
  const ignored = new Set<BatchColumn>();
  const rows: ParsedRow<BatchRow>[] = [];

  table.forEach((cells, index) => {
    if (header && index === 0) return;
    const line = index + 1;
    const at = (column: BatchColumn): string => {
      const i = order.indexOf(column);
      const value = i >= 0 ? (cells[i] ?? '').trim() : '';
      if (value !== '' && hidden.has(column)) ignored.add(column);
      return hidden.has(column) ? '' : value;
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
    const windowText = at('window');
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
        windowText,
        note,
        problems,
      },
    });
  });
  return {
    rows,
    ignoredColumns: [...ignored].map((c) => COLUMN_TITLE[c]),
    headerFound: header !== null,
  };
}

/** Вставленный текст → строки (см. `importPassTable`). */
export function parseBatchRows(
  text: string,
  catalog: BatchCatalog,
  fields?: EffectiveFields,
): BatchImport {
  return importPassTable(tableOf(text), catalog, fields);
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
  /** Допуск «начало в прошлом» и максимум разового пропуска — для исправлений ошибок окна. */
  readonly pastToleranceMin?: number | undefined;
  readonly singleMaxHours?: number | undefined;
}

/** Исправление ошибки строки одним нажатием: «Начать окно с 13:50» → новое окно в строке. */
export interface RowFix {
  readonly label: string;
  readonly patch: Partial<BatchRow>;
}

export type BatchDraftResult =
  | { ok: true; draft: Record<string, unknown> }
  | { ok: false; error: string; fixes: RowFix[] };

/**
 * Строка пачки → тело строки `POST /passes/batch`. Время считается так же, как в форме пропуска
 * (`buildPassBody`), поэтому «сегодня без окна» = «сейчас» (сервер), а окно — в пределах даты приезда.
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
  const date = window?.date || settings.date;
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
    startTime: '',
    endTime: '',
    startAuto: false,
    endAuto: false,
    windowFromTime: settings.passType === 'single' ? (window?.from ?? '') : '',
    windowToTime: settings.passType === 'single' ? (window?.to ?? '') : '',
    from: settings.from,
    to: settings.to,
    windowFrom:
      settings.passType !== 'single' && window ? `${date || settings.from}T${window.from}` : '',
    windowTo:
      settings.passType !== 'single' && window ? `${date || settings.from}T${window.to}` : '',
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
    // исправления окна переводятся в окно строки; исправления самого пропуска в пакете не нужны
    const fixes: RowFix[] = [];
    if (window && !('error' in window)) {
      for (const fix of built.fixes) {
        if (fix.id !== 'window_start' && fix.id !== 'window_end') continue;
        const from = fix.apply.windowFromTime ?? fix.apply.windowFrom?.split('T')[1] ?? window.from;
        const to = fix.apply.windowToTime ?? fix.apply.windowTo?.split('T')[1] ?? window.to;
        fixes.push({ label: fix.label, patch: { windowText: `${from}–${to}` } });
      }
    }
    return { ok: false, error: Object.values(built.errors)[0] ?? 'Проверьте срок.', fixes };
  }
  const { tenantId: _tenant, ...draft } = built.body;
  return { ok: true, draft };
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
}

/** Вставка автопарка: Номер · Тип · Марка · Водитель · Телефон. Повтор номера внутри списка — ошибка строки. */
export function parseFleetRows(text: string, catalog: BatchCatalog): ParsedRow<FleetLine>[] {
  const table = tableOf(text);
  const first = table[0];
  const header = first ? headerMap(first) : null;
  const seen = new Set<string>();
  const rows: ParsedRow<FleetLine>[] = [];
  const names = catalog.categories.map((c) => c.name).join(', ');
  table.forEach((cells, index) => {
    if (header && index === 0) return;
    const line = index + 1;
    const [plateCell = '', typeCell = '', brand = '', driver = '', phone = ''] = cells;
    const norm = normalizePlate(plateCell).norm;
    if (norm === '') {
      rows.push({ line, error: 'Нет номера — первая ячейка пуста.' });
      return;
    }
    if (seen.has(norm)) {
      rows.push({ line, error: `Номер ${norm} уже встречается выше в этом списке.` });
      return;
    }
    let category: { id: string; name: string; note?: string } | null = null;
    if (typeCell.trim() === '') {
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
    seen.add(norm);
    rows.push({
      line,
      value: {
        plate: plateCell.trim(),
        categoryId: category.id,
        categoryName: category.name,
        brand,
        driverName: driver,
        driverPhone: phone,
      },
      ...(category.note ? { note: category.note } : {}),
    });
  });
  return rows;
}

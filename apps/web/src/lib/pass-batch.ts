import { type ParsedRow, parsePastedTable } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import { buildPassBody, type PassFormValues } from './pass-form';

/** Что кабинет знает о справочниках для разбора вставленных строк. */
export interface BatchCatalog {
  readonly categories: readonly { id: string; name: string }[];
  readonly docks: readonly { id: string; number: string }[];
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

/** Строка пачки после разбора: то, что было в таблице, уже сопоставленное со справочниками. */
export interface BatchLine {
  readonly plate: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly brand: string;
  readonly driverName: string;
  readonly comment: string;
  readonly dockId: string;
  readonly dockNumber: string;
  /** Окно из таблицы: время «с» и «по», дата — если указана явно. */
  readonly window: { readonly date: string; readonly from: string; readonly to: string } | null;
  readonly windowText: string;
}

const HEADER = /номер|тип|марка|водител|окно|коммент|док/i;
const clean = (value: string) =>
  value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ');

/** Первый ряд — заголовок («Номер · Тип · Марка…»), если в нём нет цифр номера и есть слова колонок. */
function looksLikeHeader(first: readonly string[]): boolean {
  const cells = first.filter((c) => c !== '');
  return cells.length > 0 && HEADER.test(first.join(' ')) && !/\d/.test(first[0] ?? '');
}

/** Таблица из буфера: Excel (Tab), `;`, а если разделителей нет — запятые. */
function tableOf(text: string): string[][] {
  const table = parsePastedTable(text);
  if (
    table.length > 0 &&
    table.every((row) => row.length === 1) &&
    table.some((r) => r[0]?.includes(','))
  ) {
    return text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.split(',').map((c) => c.trim()));
  }
  return table;
}

function resolveCategory(
  name: string,
  catalog: BatchCatalog,
): { id: string; name: string; note?: string } | { error: string } {
  const names = catalog.categories.map((c) => c.name).join(', ');
  if (name === '') {
    const byDefault = catalog.categories.find((c) => c.id === catalog.defaultCategoryId);
    if (byDefault) {
      return {
        id: byDefault.id,
        name: byDefault.name,
        note: `тип по умолчанию: ${byDefault.name}`,
      };
    }
    return {
      error: `Не указан тип транспорта. Доступные: ${names || 'для вашей компании типов нет'}.`,
    };
  }
  const wanted = clean(name);
  const exact = catalog.categories.filter((c) => clean(c.name) === wanted);
  const loose = catalog.categories.filter(
    (c) => clean(c.name).startsWith(wanted) || wanted.startsWith(clean(c.name)),
  );
  const found = exact.length === 1 ? exact : loose.length === 1 ? loose : [];
  const hit = found[0];
  if (hit) return { id: hit.id, name: hit.name };
  return { error: `Тип «${name}» не найден среди доступных вашей компании: ${names || '—'}.` };
}

function resolveDock(
  text: string,
  catalog: BatchCatalog,
): { id: string; number: string } | { error: string } | null {
  if (text === '') return null;
  const number = text.replace(/^(док|№|n)\s*/i, '').trim();
  const found = catalog.docks.find((d) => d.number.toLowerCase() === number.toLowerCase());
  if (found) return found;
  const list = catalog.docks.map((d) => d.number).join(', ');
  return { error: `Док «${text}» не закреплён за вашей компанией. Ваши доки: ${list || 'нет'}.` };
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

/**
 * Разбор вставленных строк (08_ «Пакетный ввод»): Номер · Тип · Марка · Водитель · Окно ·
 * Комментарий · Док. Строки независимы; в одной пачке могут быть разные типы транспорта. Названия
 * типов и доков сопоставляются со справочниками арендатора; ошибка строки называет причину.
 */
export function parseBatchRows(text: string, catalog: BatchCatalog): ParsedRow<BatchLine>[] {
  const table = tableOf(text);
  const header = table[0] !== undefined && looksLikeHeader(table[0]);
  const rows: ParsedRow<BatchLine>[] = [];
  table.forEach((cells, index) => {
    if (header && index === 0) return;
    const line = index + 1;
    const [
      plateCell = '',
      typeCell = '',
      brand = '',
      driver = '',
      windowCell = '',
      comment = '',
      dockCell = '',
    ] = cells;
    if (normalizePlate(plateCell).norm === '') {
      rows.push({ line, error: 'Нет номера — первая ячейка пуста.' });
      return;
    }
    const category = resolveCategory(typeCell, catalog);
    if ('error' in category) {
      rows.push({ line, error: category.error });
      return;
    }
    const dock = resolveDock(dockCell, catalog);
    if (dock && 'error' in dock) {
      rows.push({ line, error: dock.error });
      return;
    }
    const window = parseWindow(windowCell);
    if (window && 'error' in window) {
      rows.push({ line, error: window.error });
      return;
    }
    rows.push({
      line,
      value: {
        plate: plateCell.trim(),
        categoryId: category.id,
        categoryName: category.name,
        brand,
        driverName: driver,
        comment,
        dockId: dock?.id ?? '',
        dockNumber: dock?.number ?? '',
        window,
        windowText: windowCell,
      },
      ...(category.note ? { note: category.note } : {}),
    });
  });
  return rows;
}

export interface BatchBuildContext {
  readonly timezone: string;
  readonly today: string;
  readonly nowMs: number;
}

/**
 * Строка пачки → тело строки `POST /passes/batch`. Время считается так же, как в форме пропуска
 * (`buildPassBody`), поэтому «сегодня без окна» = «сейчас», а окно — в пределах даты приезда.
 */
export function batchDraft(
  line: BatchLine,
  settings: BatchSettings,
  c: BatchBuildContext,
): { ok: true; draft: Record<string, unknown> } | { ok: false; error: string } {
  const date = line.window?.date || settings.date;
  const values: PassFormValues = {
    participant: 'vehicle',
    plate: line.plate,
    categoryId: line.categoryId,
    brand: line.brand,
    driverName: line.driverName,
    driverPhone: '',
    personName: '',
    personDocument: '',
    passType: settings.passType,
    date,
    windowFromTime: settings.passType === 'single' ? (line.window?.from ?? '') : '',
    windowToTime: settings.passType === 'single' ? (line.window?.to ?? '') : '',
    from: settings.from,
    to: settings.to,
    windowFrom:
      settings.passType !== 'single' && line.window
        ? `${date || settings.from}T${line.window.from}`
        : '',
    windowTo:
      settings.passType !== 'single' && line.window
        ? `${date || settings.from}T${line.window.to}`
        : '',
    dockId: line.dockId,
    destinationZoneId: '',
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
    dockRequired: false,
  });
  if (!built.ok) return { ok: false, error: Object.values(built.errors)[0] ?? 'Проверьте срок.' };
  const { tenantId: _tenant, ...draft } = built.body;
  return { ok: true, draft };
}

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
  const header = table[0] !== undefined && looksLikeHeader(table[0]);
  const seen = new Set<string>();
  const rows: ParsedRow<FleetLine>[] = [];
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
    const category = resolveCategory(typeCell, catalog);
    if ('error' in category) {
      rows.push({ line, error: category.error });
      return;
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

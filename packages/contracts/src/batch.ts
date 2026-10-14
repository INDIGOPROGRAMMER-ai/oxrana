/**
 * Пакетный ввод (CLAUDE.md, «Правила интерфейса»): диапазоны номеров («1–72», «З1–З7») и вставка
 * таблицы из Excel. Чистые функции без обращения к среде: ими пользуются форма в кабинете (предпросмотр
 * «добавится N, ошибки в M») и тесты; сервер повторно проверяет каждую строку своими схемами.
 */

export interface ParsedToken {
  /** Фрагмент ввода как его написал человек. */
  readonly token: string;
  readonly message: string;
}

export interface ExpandedSpec {
  /** Номера в порядке ввода, без повторов. */
  readonly values: string[];
  /** Повторы внутри самого ввода (показываются предупреждением). */
  readonly duplicates: string[];
  readonly errors: ParsedToken[];
}

/** Не больше стольких номеров за раз: защита от опечатки «1–720000». */
export const MAX_RANGE_SIZE = 1000;

const SEPARATORS = /[\s,;]+/;
const RANGE = /^(\D*?)(\d+)\s*(?:-|–|—|\.\.\.?|…)\s*(\D*?)(\d+)$/u;

/**
 * Разбор списка номеров: «1–72», «1-10, 15, 20..22», «З1–З7», «А01-А05» (ведущие нули сохраняются).
 * Разделители — пробел, запятая, точка с запятой, перенос строки. Ошибка в одном фрагменте не мешает
 * остальным.
 */
export function expandNumberSpec(text: string): ExpandedSpec {
  const values: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const errors: ParsedToken[] = [];
  const push = (value: string) => {
    if (seen.has(value)) {
      if (!duplicates.includes(value)) duplicates.push(value);
      return;
    }
    seen.add(value);
    values.push(value);
  };
  // «1 - 72» с пробелами вокруг дефиса — один диапазон, а не три фрагмента
  const normalized = text.replace(/\s*(-|–|—|\.\.\.?|…)\s*/gu, '$1');
  for (const token of normalized.split(SEPARATORS).filter((t) => t !== '')) {
    const range = RANGE.exec(token);
    if (!range) {
      push(token);
      continue;
    }
    const [, prefix = '', from = '', prefix2 = '', to = ''] = range;
    if (prefix2 !== '' && prefix2 !== prefix) {
      errors.push({
        token,
        message: `«${token}»: у начала и конца диапазона разные буквы (${prefix || 'без букв'} и ${prefix2}). Напишите, например, «${prefix}${from}–${prefix}${to}».`,
      });
      continue;
    }
    const start = Number(from);
    const end = Number(to);
    if (start > end) {
      errors.push({
        token,
        message: `«${token}»: начало диапазона больше конца. Напишите по возрастанию, например «${prefix}${to}–${prefix}${from}».`,
      });
      continue;
    }
    if (end - start + 1 > MAX_RANGE_SIZE) {
      errors.push({
        token,
        message: `«${token}»: больше ${MAX_RANGE_SIZE} номеров за раз. Разбейте диапазон на части.`,
      });
      continue;
    }
    const width = from.startsWith('0') ? from.length : 0;
    for (let n = start; n <= end; n++) push(`${prefix}${String(n).padStart(width, '0')}`);
  }
  return { values, duplicates, errors };
}

/**
 * Таблица из буфера обмена (Excel, Google Таблицы, CSV): строки по переводу строки, ячейки по табу;
 * если табов нет — по `;`. Кавычки CSV поддерживаются. Пустые строки отбрасываются.
 */
export function parsePastedTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((line) => line.trim() !== '');
  const delimiter = lines.some((l) => l.includes('\t')) ? '\t' : ';';
  return lines.map((line) => splitLine(line, delimiter));
}

/**
 * Таблица из вставки или файла: Tab (Excel), `;`, а если разделителей нет — запятые. Для писем и
 * CSV, где колонки через запятую (в кавычках запятая внутри ячейки не разделяет).
 */
export function parseTableText(text: string): string[][] {
  const table = parsePastedTable(text);
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const commas = clean.split('\n').filter((l) => l.trim() !== '');
  if (
    table.length > 0 &&
    table.every((row) => row.length === 1) &&
    commas.some((l) => l.includes(','))
  ) {
    return commas.map((line) => splitLine(line, ','));
  }
  return table;
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export interface ParsedRow<T> {
  /** Номер строки во вставленном тексте (с 1, считая и строку заголовка). */
  readonly line: number;
  readonly value?: T;
  readonly error?: string;
  /** Пояснение к допустимой строке: что подставлено из других ячеек. */
  readonly note?: string;
}

export interface TenantDraft {
  legalName: string;
  shortName: string;
  inn?: string | null;
  responsiblePhone?: string | null;
}

const HEADER_WORDS = /назван|арендатор|компани|наименован|инн|телефон/i;

/**
 * Вставка арендаторов: колонки «Краткое название · Полное название · ИНН · Телефон ответственного».
 * Достаточно одной колонки — тогда полное название совпадает с кратким (строка помечается заметкой,
 * правится в карточке). Первая строка пропускается, если похожа на заголовок.
 */
export function parseTenantRows(text: string): ParsedRow<TenantDraft>[] {
  const table = parsePastedTable(text);
  const first = table[0] ?? [];
  const hasHeader =
    first.length > 0 && HEADER_WORDS.test(first.join(' ')) && !/^\d{10,12}$/.test(first[2] ?? '');
  const rows: ParsedRow<TenantDraft>[] = [];
  const seen = new Set<string>();
  table.forEach((cells, index) => {
    if (hasHeader && index === 0) return;
    const line = index + 1;
    const [short = '', legalCell = '', innCell = '', phoneCell = ''] = cells;
    if (short === '') {
      rows.push({ line, error: 'Нет краткого названия — первая ячейка пуста.' });
      return;
    }
    const key = short.toLowerCase();
    if (seen.has(key)) {
      rows.push({ line, error: `«${short}» уже встречается выше в этом списке.` });
      return;
    }
    seen.add(key);
    const inn = innCell.replace(/\s/g, '');
    if (inn !== '' && !/^\d{10}(\d{2})?$/.test(inn)) {
      rows.push({ line, error: `ИНН «${innCell}» — должно быть 10 или 12 цифр.` });
      return;
    }
    const value: TenantDraft = {
      shortName: short,
      legalName: legalCell === '' ? short : legalCell,
      ...(inn !== '' ? { inn } : {}),
      ...(phoneCell !== '' ? { responsiblePhone: phoneCell } : {}),
    };
    rows.push({
      line,
      value,
      ...(legalCell === '' ? { note: 'Полное название = краткому, уточните в карточке' } : {}),
    });
  });
  return rows;
}

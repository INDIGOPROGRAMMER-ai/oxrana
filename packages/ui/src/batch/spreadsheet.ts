import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

/**
 * Чтение таблиц из файлов для пакетного ввода (этап 7b): `.xlsx` (Excel), `.csv`, `.tsv`, `.txt`.
 * Файл превращается в текст «ячейки через Tab, строки через перевод строки» — ровно то, что дала бы
 * вставка из Excel, поэтому один разбор строк служит и вставке, и файлу. Без тяжёлых библиотек:
 * `.xlsx` — это zip с XML, нужны общие строки и первый лист. Даты и время в ячейках Excel хранятся
 * числами; сюда они приходят как есть, поэтому в файле для пакета время лучше писать текстом.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    const known = ENTITIES[m];
    if (known) return known;
    const code = m.startsWith('&#x') ? Number.parseInt(m.slice(3, -1), 16) : Number(m.slice(2, -1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Текст всех `<t>` внутри фрагмента (обычная и «форматированная» строка Excel). */
function textOf(fragment: string): string {
  return [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => decodeXml(m[1] ?? ''))
    .join('');
}

/** Номер колонки по ссылке ячейки: `A1` → 0, `AB7` → 27. */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] ?? ''));
}

/** Путь первого листа: по `workbook.xml` и связям, а если не вышло — `sheet1.xml`. */
function firstSheetPath(files: Record<string, Uint8Array>): string | null {
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (workbook && rels) {
    const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(strFromU8(workbook));
    if (first) {
      const rel = [...strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => tag.includes(`Id="${first[1]}"`));
      const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
      if (target) {
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        if (files[path]) return path;
      }
    }
  }
  return (
    Object.keys(files)
      .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
      .sort()[0] ?? null
  );
}

/** Таблица первого листа книги `.xlsx`: строки × ячейки текстом; пустые строки в конце отброшены. */
export function xlsxToTable(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(
      'Не удалось открыть файл: это не книга Excel (.xlsx). Сохраните таблицу как .xlsx или .csv.',
    );
  }
  const sheetPath = firstSheetPath(files);
  const sheet = sheetPath ? files[sheetPath] : undefined;
  if (!sheet) throw new Error('В книге Excel не найден лист с данными.');
  const strings = sharedStrings(
    files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : undefined,
  );
  const rows: string[][] = [];
  for (const rowMatch of strFromU8(sheet).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cell of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      let text: string;
      if (type === 's') text = strings[Number(value)] ?? '';
      else if (type === 'inlineStr') text = textOf(body);
      else if (type === 'b') text = value === '1' ? 'да' : 'нет';
      else text = decodeXml(value);
      const column = ref ? columnOf(ref) : cells.length;
      while (cells.length < column) cells.push('');
      cells[column] = text.trim();
    }
    rows.push(cells);
  }
  while (rows.length > 0 && (rows.at(-1) ?? []).every((c) => c === '')) rows.pop();
  return rows;
}

/** Текст CSV из байтов: UTF-8, а у русского Excel — часто windows-1251. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** Таблица → текст «через Tab»: то, что дала бы вставка из Excel. */
export function tableToText(table: readonly (readonly string[])[]): string {
  return table.map((row) => row.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

/** Файл со списком → текст для пакетного ввода. Ошибка — понятным текстом, что делать. */
export async function fileToText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) return tableToText(xlsxToTable(bytes));
  if (name.endsWith('.xls')) {
    throw new Error(
      'Старый формат .xls не читается. Сохраните таблицу как .xlsx или .csv и загрузите снова.',
    );
  }
  return decodeCsv(bytes);
}

/** Какие файлы принимает пакетный ввод. */
export const BATCH_FILE_ACCEPT =
  '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain';

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const columnName = (index: number): string => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

/**
 * Книга `.xlsx` с одним листом — для тестов и будущей выгрузки (этап 7c). Строка записывается
 * текстовой ячейкой, число — числовой (как Excel хранит даты и время: `46311.33`).
 */
export function buildXlsx(
  table: readonly (readonly (string | number)[])[],
  sheetName = 'Лист1',
): Uint8Array {
  const sheetRows = table
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((cell, c) =>
            typeof cell === 'number'
              ? `<c r="${columnName(c)}${r + 1}"><v>${cell}</v></c>`
              : `<c r="${columnName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };
  return zipSync(files);
}

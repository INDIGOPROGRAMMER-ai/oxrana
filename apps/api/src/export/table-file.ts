import { strToU8, zipSync } from 'fflate';

/**
 * Выгрузка таблицы в файл (7b.1): XLSX без тяжёлой библиотеки (zip из нескольких XML, строки —
 * `inlineStr`) и CSV для Excel с русской локалью (UTF-8 с BOM, разделитель `;`). Всё строками:
 * время уже отформатировано в поясе объекта, номер не превращается в число или дату.
 */

export type ExportFormat = 'xlsx' | 'csv';
export type Cell = string;

export interface TableFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly extension: ExportFormat;
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Символы, недопустимые в XML 1.0: управляющие, кроме табуляции и переводов строк. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: чистим управляющие символы нарочно
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const xmlText = (value: string): string =>
  value
    .replace(XML_BAD, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** Номер столбца → буква (0 → A, 26 → AA). */
function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function sheetXml(header: readonly Cell[], rows: readonly (readonly Cell[])[]): string {
  const widths = header.map((h, i) => {
    const longest = Math.max(h.length, ...rows.slice(0, 200).map((r) => (r[i] ?? '').length));
    return Math.min(60, Math.max(10, longest + 2));
  });
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const line = (cells: readonly Cell[], rowNumber: number, style: number) =>
    `<row r="${rowNumber}">${cells
      .map(
        (c, i) =>
          `<c r="${columnName(i)}${rowNumber}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlText(c)}</t></is></c>`,
      )
      .join('')}</row>`;
  const body = [line(header, 1, 1), ...rows.map((r, i) => line(r, i + 2, 0))].join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs>' +
  '</styleSheet>';

/** Лист Excel не принимает в названии `: \ / ? * [ ]` и длиннее 31 символа. */
const sheetTitle = (title: string): string =>
  xmlText(title.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Лист');

function xlsx(sheet: string, header: readonly Cell[], rows: readonly (readonly Cell[])[]): Buffer {
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${sheetTitle(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(header, rows)),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

/**
 * Ячейка CSV. Значение, которое Excel принял бы за формулу (`=`, `+`, `-`, `@`, табуляция), получает
 * ведущий апостроф: данные из пропусков (комментарий, ФИО) — ввод пользователей.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csv(header: readonly Cell[], rows: readonly (readonly Cell[])[]): Buffer {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(';'));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export function renderTable(
  format: ExportFormat,
  sheet: string,
  header: readonly Cell[],
  rows: readonly (readonly Cell[])[],
): TableFile {
  return format === 'xlsx'
    ? { body: xlsx(sheet, header, rows), contentType: XLSX_TYPE, extension: 'xlsx' }
    : { body: csv(header, rows), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
}

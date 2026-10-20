import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildXlsx,
  decodeCsv,
  fileToText,
  tableToText,
  xlsxToTable,
} from '../src/batch/spreadsheet';

/** Книга, как её сохраняет Excel: общие строки, пропущенные ячейки, форматированный текст. */
function excelLikeBook(): Uint8Array {
  const sheet =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>2024</v></c><c r="D2" t="inlineStr"><is><t>12:00-14:00</t></is></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>5</v></c></row>' +
    '<row r="4"/>' +
    '</sheetData></worksheet>';
  const strings =
    '<sst><si><t>Номер</t></si><si><t>Тип</t></si><si><t>Окно</t></si>' +
    '<si><t xml:space="preserve">А 123 ВС 174 </t></si>' +
    '<si><r><t>легко</t></r><r><t>вые</t></r></si><si><t>Tom &amp; Jerry</t></si></sst>';
  return zipSync({
    'xl/workbook.xml': strToU8(
      '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId7"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet2.xml': strToU8(sheet),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>не тот лист</t></is></c></row></sheetData></worksheet>',
    ),
    'xl/sharedStrings.xml': strToU8(strings),
  });
}

describe('чтение .xlsx для пакетного ввода', () => {
  it('книга Excel: общие строки, форматированный текст, пустые ячейки, первый лист по связям', () => {
    expect(xlsxToTable(excelLikeBook())).toEqual([
      ['Номер', 'Тип', '', 'Окно'],
      ['А 123 ВС 174', 'легковые', '2024', '12:00-14:00'],
      ['Tom & Jerry'],
    ]);
  });

  it('собственная книга читается обратно; кириллица и спецсимволы сохраняются', () => {
    const table = [
      ['Номер', 'Комментарий'],
      ['А123ВС174', 'a < b & "c"'],
    ];
    expect(xlsxToTable(buildXlsx(table))).toEqual(table);
  });

  it('число в ячейке (дата-время Excel) читается числом как есть, строка — строкой', () => {
    const table = xlsxToTable(
      buildXlsx([
        ['С', 'По'],
        [46311.3333333333, '17.10.2026 09:00'],
      ]),
    );
    expect(table).toEqual([
      ['С', 'По'],
      ['46311.3333333333', '17.10.2026 09:00'],
    ]);
  });

  it('не книга Excel — понятная ошибка', () => {
    expect(() => xlsxToTable(strToU8('просто текст'))).toThrow(/не книга Excel/);
  });

  it('таблица → текст через Tab; табы и переносы внутри ячейки не ломают строки', () => {
    expect(tableToText([['a\tb', 'c'], ['d']])).toBe('a b\tc\nd');
  });

  it('файл .xlsx и .csv превращаются в текст; .xls — объяснение', async () => {
    const xlsx = new File([buildXlsx([['А1', 'легковой']]) as BlobPart], 'список.xlsx');
    expect(await fileToText(xlsx)).toBe('А1\tлегковой');
    const csv = new File(['﻿А1;легковой\n'], 'список.csv');
    expect(await fileToText(csv)).toBe('А1;легковой\n');
    await expect(fileToText(new File(['x'], 'старый.xls'))).rejects.toThrow(/\.xls/);
  });

  it('CSV в windows-1251 (русский Excel) читается', () => {
    // «Номер;Тип» в cp1251
    const bytes = Uint8Array.from([0xcd, 0xee, 0xec, 0xe5, 0xf0, 0x3b, 0xd2, 0xe8, 0xef]);
    expect(decodeCsv(bytes)).toBe('Номер;Тип');
  });
});

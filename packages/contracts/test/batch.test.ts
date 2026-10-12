import { describe, expect, it } from 'vitest';
import { expandNumberSpec, MAX_RANGE_SIZE, parsePastedTable, parseTenantRows } from '../src/batch';

describe('expandNumberSpec: номера и диапазоны', () => {
  it('«1–72» раскрывается в 72 номера', () => {
    const r = expandNumberSpec('1–72');
    expect(r.values).toHaveLength(72);
    expect(r.values[0]).toBe('1');
    expect(r.values.at(-1)).toBe('72');
    expect(r.errors).toEqual([]);
  });

  it('разные дефисы, пробелы вокруг и точки', () => {
    expect(expandNumberSpec('1 - 3, 5—6; 8..9').values).toEqual([
      '1',
      '2',
      '3',
      '5',
      '6',
      '8',
      '9',
    ]);
  });

  it('буквы и ведущие нули сохраняются', () => {
    expect(expandNumberSpec('З1–З3').values).toEqual(['З1', 'З2', 'З3']);
    expect(expandNumberSpec('А01-А03').values).toEqual(['А01', 'А02', 'А03']);
  });

  it('повторы сообщаются, ошибки в одном фрагменте не мешают остальным', () => {
    const r = expandNumberSpec('1-3 2 10-5 А1-Б3 7');
    expect(r.values).toEqual(['1', '2', '3', '7']);
    expect(r.duplicates).toEqual(['2']);
    expect(r.errors.map((e) => e.token)).toEqual(['10-5', 'А1-Б3']);
  });

  it('слишком большой диапазон — ошибка с подсказкой', () => {
    const r = expandNumberSpec(`1-${MAX_RANGE_SIZE + 1}`);
    expect(r.values).toEqual([]);
    expect(r.errors[0]?.message).toContain('Разбейте');
  });

  it('произвольные названия («Р-1», «Ворота север») остаются как есть', () => {
    expect(expandNumberSpec('Р-1,Север').values).toEqual(['Р-1', 'Север']);
  });
});

describe('parsePastedTable и parseTenantRows', () => {
  it('таб из Excel, кавычки, пустые строки', () => {
    expect(parsePastedTable('a\tb\n\n"с;д"\te\r\n')).toEqual([
      ['a', 'b'],
      ['с;д', 'e'],
    ]);
  });

  it('без табов — разделитель «;»', () => {
    expect(parsePastedTable('a;b\nc;d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('арендаторы: заголовок пропускается, ошибки по строкам, заметка про полное название', () => {
    const rows = parseTenantRows(
      'Краткое название\tПолное название\tИНН\nАльфа\tООО «Альфа»\t7700000001\nБета\nГамма\t\t123\nальфа\nЭпсилон\n',
    );
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
    expect(rows[0]?.value).toMatchObject({ shortName: 'Альфа', inn: '7700000001' });
    expect(rows[1]?.value).toMatchObject({ shortName: 'Бета', legalName: 'Бета' });
    expect(rows[1]?.note).toContain('Полное название');
    expect(rows[2]?.error).toContain('ИНН');
    expect(rows[3]?.error).toContain('уже встречается');
    expect(rows[4]?.value?.shortName).toBe('Эпсилон');
  });
});

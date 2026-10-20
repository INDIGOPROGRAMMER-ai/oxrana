import { describe, expect, it } from 'vitest';
import {
  findMultiPlateLines,
  multiPlateQuestion,
  platesInCell,
  splitMultiPlateLines,
} from '../src/lib/plate-split';

const plate = (i: number) => `К${String(i).padStart(3, '0')}ХМ174`;
const many = (n: number) => Array.from({ length: n }, (_, i) => plate(i + 1));

describe('несколько номеров в одной строке', () => {
  it('55 номеров через пробел → 55 строк после разбивки', () => {
    const text = many(55).join(' ');
    const lines = findMultiPlateLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.plates).toHaveLength(55);
    expect(multiPlateQuestion(lines)).toBe('Похоже, в строке 55 номеров — разбить по строкам?');
    const split = splitMultiPlateLines(text).split('\n');
    expect(split).toHaveLength(55);
    expect(split[0]).toBe(plate(1));
    expect(split[54]).toBe(plate(55));
    // после разбивки подсказки больше нет
    expect(findMultiPlateLines(splitMultiPlateLines(text))).toHaveLength(0);
  });

  it('запятые и точки с запятой разделяют так же, как пробелы', () => {
    expect(platesInCell('А123ВС174, В456НР174; Е789КХ174')).toEqual([
      'А123ВС174',
      'В456НР174',
      'Е789КХ174',
    ]);
    const text = `${plate(1)}, ${plate(2)}, ${plate(3)}`;
    expect(findMultiPlateLines(text)[0]?.plates).toHaveLength(3);
    expect(splitMultiPlateLines(text).split('\n')).toEqual([plate(1), plate(2), plate(3)]);
  });

  it('пробелы внутри одного номера допустимы — это один номер, подсказки нет', () => {
    expect(platesInCell('А 123 ВС 174')).toEqual(['А 123 ВС 174']);
    expect(findMultiPlateLines('А 123 ВС 174')).toHaveLength(0);
    expect(findMultiPlateLines('А 123 ВС 174\tфура\tVolvo')).toHaveLength(0);
  });

  it('несколько номеров с пробелами внутри каждого', () => {
    const cell = 'А 123 ВС 174 В 456 НР 174';
    expect(platesInCell(cell)).toEqual(['А 123 ВС 174', 'В 456 НР 174']);
  });

  it('чужие слова рядом с номерами — не список номеров', () => {
    expect(platesInCell('А123ВС174 фура')).toBeNull();
    expect(findMultiPlateLines('А123ВС174 В456НР174 Иванов')).toHaveLength(0);
    expect(findMultiPlateLines('Номер\tТип\tМарка')).toHaveLength(0);
  });

  it('остальные ячейки строки достаются каждому номеру', () => {
    const text = `${plate(1)} ${plate(2)}\tфура\tVolvo\n${plate(3)}\tлегковой`;
    expect(splitMultiPlateLines(text).split('\n')).toEqual([
      `${plate(1)}\tфура\tVolvo`,
      `${plate(2)}\tфура\tVolvo`,
      `${plate(3)}\tлегковой`,
    ]);
  });

  it('номера по колонкам (запятые стали разделителями) тоже разбиваются; номер строки — как в таблице', () => {
    const text = `${plate(1)}\n${plate(2)}, ${plate(3)}`;
    const lines = findMultiPlateLines(text);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.line).toBe(2);
    expect(splitMultiPlateLines(text).split('\n')).toEqual([plate(1), plate(2), plate(3)]);
  });

  it('несколько строк со списками — одна общая фраза со счётом', () => {
    const lines = findMultiPlateLines(
      `${plate(1)} ${plate(2)}\n${plate(3)} ${plate(4)} ${plate(5)}`,
    );
    expect(multiPlateQuestion(lines)).toBe(
      'Похоже, в 2 строках по несколько номеров (всего 5) — разбить по строкам?',
    );
  });
});

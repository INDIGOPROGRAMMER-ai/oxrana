import { describe, expect, it } from 'vitest';
import {
  canonicalPlate,
  detectPlateFormat,
  findSimilarPlates,
  normalizePlate,
  normalizePlateText,
  PLATE_COUNTRIES,
  PLATE_FORMATS,
  plateDigits,
  plateDistance,
} from '../src';

describe('нормализация номера (10_ §4, 16_ A10)', () => {
  it('сценарий 28: кириллический «Е121УР174» и латинский «E121YP174» — один и тот же номер', () => {
    expect(normalizePlate('Е121УР174').norm).toBe('E121YP174');
    expect(normalizePlate('E121YP174').norm).toBe('E121YP174');
    expect(normalizePlate('е121ур174').norm).toBe(normalizePlate('E121YP174').norm);
  });

  it('сценарий 36: пробел в конце «А123ВС174 » не мешает', () => {
    const plate = normalizePlate('А123ВС174 ');
    expect(plate.norm).toBe('A123BC174');
    expect(plate.raw).toBe('А123ВС174 ');
    expect(plate.recognized).toBe(true);
  });

  it('убирает пробелы, неразрывные пробелы, тире, точки и переводит в верхний регистр', () => {
    expect(normalizePlateText(' а 123 вс - 174 ')).toBe('A123BC174');
    expect(normalizePlateText('А123ВС 174')).toBe('A123BC174');
    expect(normalizePlateText('А123ВС—174')).toBe('A123BC174');
    expect(normalizePlateText('А.123.ВС.174')).toBe('A123BC174');
    expect(normalizePlateText('a123bc174')).toBe('A123BC174');
  });

  it('все двенадцать букв российского стандарта переводятся в латиницу', () => {
    expect(normalizePlateText('АВЕКМНОРСТУХ')).toBe('ABEKMHOPCTYX');
    expect(normalizePlateText('авекмнорстух')).toBe('ABEKMHOPCTYX');
  });

  it('буквы, которых нет в латинице, остаются — такой номер не распознан', () => {
    const plate = normalizePlate('Ж123ВС174');
    expect(plate.norm).toBe('Ж123BC174');
    expect(plate.recognized).toBe(false);
    expect(plate.country).toBeNull();
    expect(plate.format).toBeNull();
  });

  it('пустой ввод даёт пустой нормализованный номер без ошибки', () => {
    const plate = normalizePlate('  - . ');
    expect(plate.norm).toBe('');
    expect(plate.recognized).toBe(false);
  });
});

describe('форматы по странам', () => {
  it('сценарий 27: белорусский «1234 AB-7» → 1234AB7, страна BY, по цифрам «1234» находится', () => {
    const plate = normalizePlate('1234 AB-7');
    expect(plate.norm).toBe('1234AB7');
    expect(plate.country).toBe('BY');
    expect(plate.format).toBe('BY_STANDARD');
    expect(plateDigits(plate.norm).startsWith('1234')).toBe(true);
  });

  it('примеры масок из ТЗ', () => {
    expect(normalizePlate('А123ВС174').country).toBe('RU');
    expect(normalizePlate('А123ВС 77').format).toBe('RU_PRIVATE');
    expect(normalizePlate('АВ1234 174').format).toBe('RU_TRAILER');
    expect(normalizePlate('АВ123 74').format).toBe('RU_PUBLIC');
    expect(normalizePlate('1234АВ 174').format).toBe('RU_MOTO');
    expect(normalizePlate('А1234 174').format).toBe('RU_TRANSIT');
    expect(normalizePlate('123ABC02').country).toBe('KZ');
    expect(normalizePlate('123AB02').country).toBe('KZ');
    expect(normalizePlate('1234AB01').country).toBe('RU'); // совпадает с российской военной маской
    expect(normalizePlate('1234AB01', 'TJ').country).toBe('TJ');
    expect(normalizePlate('AB123401').country).toBe('RU'); // совпадает с маской прицепа
    expect(normalizePlate('AB123401', 'TJ').format).toBe('TJ_SERIES');
    expect(normalizePlate('01A123BC').country).toBe('UZ');
    expect(normalizePlate('01123ABC').country).toBe('UZ');
    expect(normalizePlate('01KG123ABC').country).toBe('KG');
    expect(normalizePlate('B1234AB').country).toBe('KG');
    expect(normalizePlate('12AB345').country).toBe('AM');
    expect(normalizePlate('123AB45', 'AM').country).toBe('AM');
    expect(normalizePlate('AB12347').country).toBe('RU'); // совпадает с маской АА999 77
    expect(normalizePlate('AB12347', 'BY').format).toBe('BY_TRUCK');
    expect(normalizePlate('1234A7').country).toBe('BY');
  });

  it('пример каждой маски распознаётся именно ею', () => {
    for (const format of PLATE_FORMATS) {
      expect(detectPlateFormat(format.example, format.country)?.code, format.code).toBe(
        format.code,
      );
    }
  });

  it('подсказка страны уточняет выбор, но не мешает другим маскам', () => {
    expect(detectPlateFormat('123AB02', 'AM')?.country).toBe('AM');
    expect(detectPlateFormat('A123BC174', 'KZ')?.country).toBe('RU');
    expect(detectPlateFormat('XYZ', 'KZ')).toBeNull();
  });

  it('неизвестный формат принимается с пометкой «не распознан»', () => {
    const plate = normalizePlate('ABC-12345678');
    expect(plate.norm).toBe('ABC12345678');
    expect(plate.recognized).toBe(false);
    expect(plate.country).toBeNull();
  });

  it('список стран соответствует маскам', () => {
    const countries = new Set(PLATE_FORMATS.map((f) => f.country));
    expect([...countries].sort()).toEqual([...PLATE_COUNTRIES].sort());
  });
});

describe('нечёткое совпадение', () => {
  it('O/0 и B/8 — один символ', () => {
    expect(canonicalPlate('O0B8I1S5Z2')).toBe('OOBBIISSZZ');
    expect(plateDistance('A123BC174', 'A123BC174')).toBe(0);
    expect(plateDistance('O123BC174', '0123BC174')).toBe(0);
    expect(plateDistance('B123BC174', '8123BC174')).toBe(0);
  });

  it('отличие на один символ: замена, пропуск, лишний', () => {
    expect(plateDistance('A123BC174', 'A124BC174')).toBe(1);
    expect(plateDistance('A123BC174', 'A123BC17')).toBe(1);
    expect(plateDistance('A123BC174', 'A123BC1744')).toBe(1);
    expect(plateDistance('A123BC174', 'A923BC175')).toBe(2);
    expect(plateDistance('', 'AB')).toBe(2);
    expect(plateDistance('AB', '')).toBe(2);
  });

  it('находит похожие среди кандидатов и сортирует по близости', () => {
    const passes = [
      { id: 'far', plate: 'K999KK99' },
      { id: 'near', plate: 'A124BC174' },
      { id: 'same', plate: 'A123BC174' },
      { id: 'none', plate: null },
    ];
    const found = findSimilarPlates('A123BC174', passes, (p) => p.plate);
    expect(found.map((f) => [f.item.id, f.distance])).toEqual([
      ['same', 0],
      ['near', 1],
    ]);
    expect(findSimilarPlates('A123BC174', passes, (p) => p.plate, 0)).toHaveLength(1);
  });
});

describe('plateDigits', () => {
  it('оставляет только цифры', () => {
    expect(plateDigits('А123ВС 174')).toBe('123174');
    expect(plateDigits('a 123 bc-74')).toBe('12374');
  });

  it('пустая строка и строка без цифр дают пустую строку', () => {
    expect(plateDigits('')).toBe('');
    expect(plateDigits('АВС')).toBe('');
  });
});

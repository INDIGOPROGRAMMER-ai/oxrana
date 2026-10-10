/**
 * Форматы номеров по странам (Q-14: код + тесты, не таблица БД). Маски применяются к
 * нормализованному номеру. Буквы на номерах — только те, что совпадают с латиницей.
 */

export const PLATE_COUNTRIES = ['RU', 'BY', 'KZ', 'UZ', 'TJ', 'KG', 'AM'] as const;
export type PlateCountry = (typeof PLATE_COUNTRIES)[number];

export interface PlateFormat {
  readonly country: PlateCountry;
  /** Код формата: `RU_PRIVATE`, `BY_STANDARD`… — для подписи и тестов. */
  readonly code: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly example: string;
}

/** Буквы российского стандарта (12 букв, совпадающих с латиницей). */
const L = '[ABEKMHOPCTYX]';
/** Код региона России: две или три цифры. */
const REGION = '\\d{2,3}';

/**
 * Порядок важен: при совпадении нескольких масок берётся первая. Россия — первая как основная
 * страна объекта: `1234AB01` читается как российский военный номер региона 01, а не как
 * таджикский; `123AB02` — как казахстанский, а не армянский. Страна в форме пропуска уточняет
 * выбор (`countryHint`).
 */
export const PLATE_FORMATS: readonly PlateFormat[] = [
  {
    country: 'RU',
    code: 'RU_PRIVATE',
    description: 'Россия: А999АА 777',
    pattern: new RegExp(`^${L}\\d{3}${L}{2}${REGION}$`),
    example: 'A123BC174',
  },
  {
    country: 'RU',
    code: 'RU_TRAILER',
    description: 'Россия, прицеп: АА9999 777',
    pattern: new RegExp(`^${L}{2}\\d{4}${REGION}$`),
    example: 'AB123474',
  },
  {
    country: 'RU',
    code: 'RU_PUBLIC',
    description: 'Россия, маршрутный транспорт: АА999 777',
    pattern: new RegExp(`^${L}{2}\\d{3}${REGION}$`),
    example: 'AB12374',
  },
  {
    country: 'RU',
    code: 'RU_MOTO',
    description: 'Россия, мототехника и военные: 9999АА 777',
    pattern: new RegExp(`^\\d{4}${L}{2}${REGION}$`),
    example: '1234AB74',
  },
  {
    country: 'RU',
    code: 'RU_TRANSIT',
    description: 'Россия, транзит: А9999 777',
    pattern: new RegExp(`^${L}\\d{4}${REGION}$`),
    example: 'A123474',
  },
  {
    country: 'BY',
    code: 'BY_STANDARD',
    description: 'Беларусь: 1234 AB-7',
    pattern: /^\d{4}[A-Z]{2}\d$/,
    example: '1234AB7',
  },
  {
    country: 'BY',
    code: 'BY_TRUCK',
    description: 'Беларусь, грузовые и прицепы: AB 1234-7',
    pattern: /^[A-Z]{2}\d{4}\d$/,
    example: 'AB12347',
  },
  {
    country: 'BY',
    code: 'BY_MOTO',
    description: 'Беларусь, мототехника: 1234A-7',
    pattern: /^\d{4}[A-Z]\d$/,
    example: '1234A7',
  },
  {
    country: 'KZ',
    code: 'KZ_STANDARD',
    description: 'Казахстан: 123 ABC 02',
    pattern: /^\d{3}[A-Z]{3}\d{2}$/,
    example: '123ABC02',
  },
  {
    country: 'KZ',
    code: 'KZ_SHORT',
    description: 'Казахстан: 123 AB 02',
    pattern: /^\d{3}[A-Z]{2}\d{2}$/,
    example: '123AB02',
  },
  {
    country: 'UZ',
    code: 'UZ_STANDARD',
    description: 'Узбекистан: 01 A 123 BC',
    pattern: /^\d{2}[A-Z]\d{3}[A-Z]{2}$/,
    example: '01A123BC',
  },
  {
    country: 'UZ',
    code: 'UZ_SERIES',
    description: 'Узбекистан: 01 123 ABC',
    pattern: /^\d{2}\d{3}[A-Z]{3}$/,
    example: '01123ABC',
  },
  {
    country: 'TJ',
    code: 'TJ_STANDARD',
    description: 'Таджикистан: 1234 AB 01',
    pattern: /^\d{4}[A-Z]{2}\d{2}$/,
    example: '1234AB01',
  },
  {
    country: 'TJ',
    code: 'TJ_SERIES',
    description: 'Таджикистан: AB 1234 01',
    pattern: /^[A-Z]{2}\d{4}\d{2}$/,
    example: 'AB123401',
  },
  {
    country: 'KG',
    code: 'KG_STANDARD',
    description: 'Киргизия: 01 KG 123 ABC',
    pattern: /^\d{2}KG\d{3}[A-Z]{3}$/,
    example: '01KG123ABC',
  },
  {
    country: 'KG',
    code: 'KG_OLD',
    description: 'Киргизия, старый образец: B 1234 AB',
    pattern: /^[A-Z]\d{4}[A-Z]{2}$/,
    example: 'B1234AB',
  },
  {
    country: 'AM',
    code: 'AM_STANDARD',
    description: 'Армения: 12 AB 345',
    pattern: /^\d{2}[A-Z]{2}\d{3}$/,
    example: '12AB345',
  },
  {
    country: 'AM',
    code: 'AM_OLD',
    description: 'Армения, старый образец: 123 AB 45',
    pattern: /^\d{3}[A-Z]{2}\d{2}$/,
    example: '123AB45',
  },
];

/**
 * Формат нормализованного номера. При подсказке страны её маски проверяются первыми; если ни одна
 * не подошла — общий порядок. `null` — формат не распознан (номер всё равно принимается).
 */
export function detectPlateFormat(norm: string, countryHint?: PlateCountry): PlateFormat | null {
  if (countryHint) {
    const own = PLATE_FORMATS.find((f) => f.country === countryHint && f.pattern.test(norm));
    if (own) return own;
  }
  return PLATE_FORMATS.find((f) => f.pattern.test(norm)) ?? null;
}

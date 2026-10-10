/**
 * Номера транспортных средств: нормализация, форматы стран, нечёткое совпадение. Чистый пакет
 * без зависимостей (ADR-002) — работает в API, в кабинете и на посту.
 */
import { detectPlateFormat, type PlateCountry } from './formats';
import { normalizePlateText } from './normalize';

export {
  detectPlateFormat,
  PLATE_COUNTRIES,
  PLATE_FORMATS,
  type PlateCountry,
  type PlateFormat,
} from './formats';
export {
  canonicalPlate,
  findSimilarPlates,
  plateDistance,
  type SimilarPlate,
} from './fuzzy';
export { normalizePlateText, plateDigits } from './normalize';

export interface NormalizedPlate {
  /** Как ввели — хранится в `plate_raw`. */
  readonly raw: string;
  /** Нормализованный номер — ключ поиска и дублей (`plate_norm`). */
  readonly norm: string;
  /** Страна по маске; `null` — формат не распознан (`plate_country` = `null`). */
  readonly country: PlateCountry | null;
  /** Код распознанного формата (`RU_PRIVATE`), `null` — не распознан. */
  readonly format: string | null;
  /** `false` — «формат не распознан»: номер принимается с пометкой (10_ §4). */
  readonly recognized: boolean;
}

/**
 * Нормализует введённый номер и определяет формат. Пустая строка после нормализации — тоже
 * результат (`norm === ''`), ошибку поднимает форма: «укажите номер».
 */
export function normalizePlate(raw: string, countryHint?: PlateCountry): NormalizedPlate {
  const norm = normalizePlateText(raw);
  const format = detectPlateFormat(norm, countryHint);
  return {
    raw,
    norm,
    country: format?.country ?? null,
    format: format?.code ?? null,
    recognized: format !== null,
  };
}

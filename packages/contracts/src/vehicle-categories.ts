import { z } from 'zod';

/**
 * Рекомендованный набор типов транспорта (ADR-012). Мастер настройки показывает его списком с
 * галочками; включённый тип становится строкой `vehicle_categories` с `preset_code`. Название
 * переименовывается свободно, порог тоннажа — данные, а не код (A1). Порядок списка — порядок
 * показа в мастере; порядок в формах задаёт `vehicle_categories.sort`.
 */
export const VEHICLE_CATEGORY_PRESET_CODES = [
  'car',
  'light_truck',
  'semi',
  'truck_5t',
  'special',
  'bus',
  'moto',
  'trailer',
  'minibus',
] as const;

export type VehicleCategoryPresetCode = (typeof VEHICLE_CATEGORY_PRESET_CODES)[number];

export const VehicleCategoryPresetCodeSchema = z.enum(VEHICLE_CATEGORY_PRESET_CODES);

export interface VehicleCategoryPreset {
  readonly code: VehicleCategoryPresetCode;
  /** Название по умолчанию — со строчной буквы: из названий собирается имя лимита «Малотоннажный + фура». */
  readonly name: string;
  /** «Обычно едет к доку»: к типу применяется настройка арендатора «грузовые только к докам» (A5). */
  readonly dockEligible: boolean;
}

export const VEHICLE_CATEGORY_PRESETS: readonly VehicleCategoryPreset[] = [
  { code: 'car', name: 'легковой', dockEligible: false },
  { code: 'light_truck', name: 'малотоннажный', dockEligible: true },
  { code: 'semi', name: 'фура', dockEligible: true },
  { code: 'truck_5t', name: 'грузовой свыше 5 т', dockEligible: true },
  { code: 'special', name: 'спецтехника', dockEligible: false },
  { code: 'bus', name: 'автобус', dockEligible: false },
  { code: 'moto', name: 'мототехника', dockEligible: false },
  { code: 'trailer', name: 'прицеп', dockEligible: true },
  { code: 'minibus', name: 'микроавтобус', dockEligible: false },
];

/** Пресет по коду; бросает исключение для неизвестного кода — это ошибка программы, а не данных. */
export function vehicleCategoryPreset(code: VehicleCategoryPresetCode): VehicleCategoryPreset {
  const preset = VEHICLE_CATEGORY_PRESETS.find((p) => p.code === code);
  if (!preset) throw new Error(`Неизвестный рекомендованный тип транспорта: ${code}`);
  return preset;
}

import type { EffectiveFields } from './pass-form';

/**
 * Колонки пакетного ввода из настройки формы (7b.2). Пакет — та же форма, только таблицей, поэтому
 * колонки берутся из той же действующей настройки для этого пользователя: скрытое поле — нет колонки,
 * обязательное — обязательная колонка. Подпись «Колонки: …», порядок колонок без заголовка и шаблон
 * для Excel строятся из одного списка.
 */

export type BatchColumn =
  | 'plate'
  | 'type'
  | 'brand'
  | 'driver'
  | 'phone'
  | 'window'
  | 'comment'
  | 'dock'
  | 'zone'
  | 'date'
  | 'from'
  | 'to';

export const COLUMN_TITLE: Record<BatchColumn, string> = {
  plate: 'Номер',
  type: 'Тип',
  brand: 'Марка',
  driver: 'Водитель',
  phone: 'Телефон',
  window: 'Окно',
  comment: 'Комментарий',
  dock: 'Док',
  zone: 'Место назначения',
  date: 'Дата',
  from: 'С',
  to: 'По',
};

export interface BatchColumnSpec {
  readonly key: BatchColumn;
  readonly title: string;
  readonly required: boolean;
}

export interface BatchColumnInput {
  /** Действующая форма пользователя: режим каждого поля. */
  readonly fields: EffectiveFields;
  /** У арендатора есть доки (в форме есть поле «Док»). */
  readonly hasDocks: boolean;
  /** Мест назначения два и больше — их нужно выбирать (одно подставляется само). */
  readonly zoneChoice: boolean;
}

const spec = (key: BatchColumn, required = false): BatchColumnSpec => ({
  key,
  title: COLUMN_TITLE[key],
  required,
});

/** Поля формы, у которых есть колонка в обоих пакетах (машина автопарка и пропуск). */
function vehicleFieldColumns(fields: EffectiveFields): BatchColumnSpec[] {
  const out: BatchColumnSpec[] = [];
  if (fields.brand !== 'hidden') out.push(spec('brand', fields.brand === 'required'));
  if (fields.driverName !== 'hidden') out.push(spec('driver', fields.driverName === 'required'));
  if (fields.driverPhone !== 'hidden') out.push(spec('phone', fields.driverPhone === 'required'));
  return out;
}

/**
 * Колонки пакета пропусков, в порядке «без заголовка»: Номер · Тип · Марка · Водитель · Телефон ·
 * Окно · Комментарий · Док · Место · Дата · С · По. Время (Дата · С · По) есть всегда: у каждой машины
 * свой срок, пустая ячейка — общее значение сверху.
 */
export function passBatchColumns(input: BatchColumnInput): BatchColumnSpec[] {
  const { fields } = input;
  return [
    spec('plate', true),
    spec('type', true),
    ...vehicleFieldColumns(fields),
    ...(fields.window !== 'hidden' ? [spec('window', fields.window === 'required')] : []),
    ...(fields.comment !== 'hidden' ? [spec('comment', fields.comment === 'required')] : []),
    ...(input.hasDocks ? [spec('dock')] : []),
    ...(fields.destination !== 'hidden' && input.zoneChoice
      ? [spec('zone', fields.destination === 'required')]
      : []),
    spec('date'),
    spec('from'),
    spec('to'),
  ];
}

/**
 * Колонки пакета автопарка: Номер · Тип · Марка · Водитель · Телефон · Комментарий · Док. Комментарий
 * и док — по умолчанию для машины, они подставляются в пропуск на неё.
 */
export function fleetBatchColumns(input: BatchColumnInput): BatchColumnSpec[] {
  const { fields } = input;
  return [
    spec('plate', true),
    spec('type', true),
    ...vehicleFieldColumns(fields),
    ...(fields.comment !== 'hidden' ? [spec('comment', fields.comment === 'required')] : []),
    ...(input.hasDocks ? [spec('dock')] : []),
  ];
}

/** Подпись под полем ввода: «Колонки: Номер · Тип · Марка (обязательные: Номер, Тип)». */
export function columnsLabel(columns: readonly BatchColumnSpec[]): string {
  const required = columns.filter((c) => c.required).map((c) => c.title);
  return `Колонки: ${columns.map((c) => c.title).join(' · ')} (обязательные: ${required.join(', ')}).`;
}

/** Раскладка пакета: показанные колонки (подпись, порядок, шаблон) и все принимаемые. */
export interface BatchLayout {
  readonly columns: readonly BatchColumnSpec[];
  /** Колонки, значения которых пакет принимает (на одну больше, чем показано: место, когда оно одно). */
  readonly accepted: ReadonlySet<BatchColumn>;
}

export function passBatchLayout(input: BatchColumnInput): BatchLayout {
  const columns = passBatchColumns(input);
  const accepted = new Set(columns.map((c) => c.key));
  // место назначения принимается и тогда, когда оно одно и подставлено само
  if (input.fields.destination !== 'hidden') accepted.add('zone');
  return { columns, accepted };
}

export function fleetBatchLayout(input: BatchColumnInput): BatchLayout {
  const columns = fleetBatchColumns(input);
  return { columns, accepted: new Set(columns.map((c) => c.key)) };
}

/** Строка заголовков шаблона для Excel — те же колонки, в том же порядке. */
export const templateTitles = (columns: readonly BatchColumnSpec[]): string[] =>
  columns.map((c) => c.title);

const EXAMPLES: Record<BatchColumn, readonly [string, string]> = {
  plate: ['А123ВС174', 'В456НР174'],
  type: ['фура', 'легковые'],
  brand: ['Volvo', 'Kia'],
  driver: ['Иванов И. И.', ''],
  phone: ['+7 900 000-00-00', ''],
  window: ['12:00-14:00', ''],
  comment: ['разгрузка', ''],
  dock: ['12', ''],
  zone: ['Склад А', ''],
  date: ['', ''],
  from: ['09:00', ''],
  to: ['18:00', ''],
};

/** Пример двух строк для поля ввода — в тех же колонках, что и подпись. `today` — «ДД.ММ.ГГГГ». */
export function placeholderOf(columns: readonly BatchColumnSpec[], today: string): string {
  const cell = (key: BatchColumn, row: 0 | 1) =>
    key === 'date' ? (row === 0 ? today : '') : EXAMPLES[key][row];
  const line = (row: 0 | 1) => columns.map((c) => cell(c.key, row)).join('\t');
  return `${line(0)}\n${line(1)}`;
}

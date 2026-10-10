import type { QuotaSeed, SeedData, TenantSeed } from './types';

/**
 * Демо-объект ЛЦ «Радонежский» (docs/reference/лимиты_для_сида.md, 16_ A1–A6, A11). Только этот
 * каталог знает названия объекта, КПП и арендаторов (ADR-012 п. 7). Реквизиты, договоры и
 * телефоны — заглушки: телефоны выдуманные (+7 000 …, таких номеров нет), ФИО и e-mail в сиде
 * не используются. Всё сомнительное перечислено в `checkList` и помечено «ПРОВЕРИТЬ».
 */

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Доки №1–72 основного склада, 7 доков стр. 5 (ПРОВЕРИТЬ нумерацию) и 11 наземных ворот ДНС. */
const WAREHOUSE_DOCKS = range(1, 72);
const BUILDING5_DOCKS = range(1, 7).map((n) => `З${n}`);
const DNS_GROUND_GATES = range(1, 11).map((n) => `Н${n}`);

const CONTRACT_STUB =
  'Заглушка сида: выписка из договора в репозиторий не включена — номер, даты и пункты ПРОВЕРИТЬ.';
const CLAUSE_STUB = 'п. … (ПРОВЕРИТЬ)';

/** Типовой набор «как у договора» (ADR-012 п. 4): Легковые, Грузовые, Спецтехника. */
function standardQuotas(
  cars: number,
  trucks: number,
  special: number,
  options: { trucksFromDocks?: boolean; carsNote?: string; note?: string } = {},
): QuotaSeed[] {
  const note = options.note ? ` ${options.note}` : '';
  return [
    {
      key: 'cars',
      name: 'Легковые',
      categories: ['car'],
      capacity: cars,
      clause: {
        ref: CLAUSE_STUB,
        summary: `Легковые: ${cars} на территории одновременно.${options.carsNote ? ` ${options.carsNote}` : ''}${note}`,
      },
    },
    {
      key: 'trucks',
      name: 'Грузовые',
      categories: ['light_truck', 'semi', 'truck_5t'],
      capacity: trucks,
      capacityFromDocks: options.trucksFromDocks ?? false,
      clause: {
        ref: CLAUSE_STUB,
        summary:
          trucks === 0
            ? `Грузовые не предусмотрены договором (лимит 0).${note}`
            : `Грузовые: ${trucks} на территории одновременно${options.trucksFromDocks ? ' — по числу доков' : ''}.${note}`,
      },
    },
    {
      key: 'special',
      name: 'Спецтехника',
      categories: ['special'],
      capacity: special,
      clause: {
        ref: CLAUSE_STUB,
        summary:
          special === 0
            ? `Спецтехника не предусмотрена договором (лимит 0).${note}`
            : `Спецтехника: ${special} на территории одновременно.${note}`,
      },
    },
  ];
}

const TENANTS: TenantSeed[] = [
  {
    key: 'dns',
    legalName: 'ДНС Ритейл',
    shortName: 'ДНС',
    trucksDockRequired: true,
    emergencyPhone: '+70000000011',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(30, 25, 2, { trucksFromDocks: true }),
    // 25 доков в лимите + 11 наземных ворот вне лимита (counts_in_quota = false)
    docks: [...range(1, 18), ...range(66, 72), ...DNS_GROUND_GATES],
    pedestrianRules: [
      {
        documentRequired: true,
        escort: 'if_no_document',
        escortPhone: '+70000000012',
        guardText:
          'Проверьте документ (паспорт, ВУ, Госуслуги) · без документа — позвоните, выйдет ответственный ДНС',
      },
    ],
  },
  {
    key: 'dl_trans',
    legalName: 'ДЛ-Транс',
    shortName: 'ДЛ-Транс',
    contractNotes: CONTRACT_STUB,
    quotas: [
      {
        key: 'cars',
        name: 'Легковые',
        categories: ['car'],
        capacity: 15,
        enforcement: 'soft',
        overageTariffRub: '67.00',
        clause: {
          ref: CLAUSE_STUB,
          summary:
            'Легковые: 15 на парковочных местах; сверх лимита — 67 ₽ за каждые сутки, неполные сутки = полные.',
        },
      },
      {
        key: 'trucks',
        name: 'Грузовые',
        categories: ['light_truck', 'semi', 'truck_5t'],
        capacity: 7,
        enforcement: 'soft',
        overageTariffRub: '233.00',
        clause: {
          ref: CLAUSE_STUB,
          summary:
            'Грузовые: 7 на парковочных местах, ворот нет; сверх лимита — 233 ₽ за каждые сутки, неполные сутки = полные.',
        },
      },
      {
        key: 'special',
        name: 'Спецтехника',
        categories: ['special'],
        capacity: 1,
        clause: {
          ref: CLAUSE_STUB,
          summary:
            'Спецтехника: 1 на территории, жёсткий лимит без тарифа (Q-50 закрыт 10.10.2026).',
        },
      },
    ],
    docks: [],
    pedestrianRules: [
      {
        zoneKey: 'office',
        documentRequired: true,
        escort: 'none',
        guardText: 'Проверьте документ · откройте дверь 1-го этажа к ДЛ-Транс',
      },
    ],
  },
  {
    key: 'kontinent',
    legalName: 'Континент',
    shortName: 'Континент',
    contractNotes: CONTRACT_STUB,
    quotas: [
      ...standardQuotas(28, 0, 0).filter((q) => q.key !== 'trucks'),
      {
        key: 'light_trucks',
        name: 'Малотоннажные',
        categories: ['light_truck'],
        capacity: 22,
        clause: {
          ref: CLAUSE_STUB,
          summary: 'Грузовые: 22, только малотоннажные (до 4,5 т), на парковочных местах.',
        },
      },
      {
        key: 'heavy_trucks',
        name: 'Фура и грузовой свыше 5 т',
        categories: ['semi', 'truck_5t'],
        capacity: 0,
        clause: {
          ref: CLAUSE_STUB,
          summary: 'Фуры и грузовые свыше 5 т не предусмотрены договором (лимит 0).',
        },
      },
    ],
    docks: [],
    pedestrianRules: [
      {
        zoneKey: 'office',
        documentRequired: false,
        escort: 'always',
        escortPhone: '+70000000021',
        guardText: 'Позвоните в Континент и дождитесь сотрудника — без него дальше не пускать',
      },
    ],
  },
  {
    key: 'relief',
    legalName: 'Рельеф-Центр',
    shortName: 'Рельеф-Центр',
    trucksDockRequired: true,
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(2, 18, 1, {
      trucksFromDocks: true,
      carsNote: 'Договорённость, не договор — основание ПРОВЕРИТЬ (Q-27).',
    }),
    docks: [...range(19, 32), ...range(62, 65)],
    pedestrianRules: [],
  },
  {
    key: 'x5',
    legalName: 'Агроторг (X5)',
    shortName: 'Агроторг (X5)',
    trucksDockRequired: true,
    defaultCategory: 'semi',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(2, 7, 1, { trucksFromDocks: true }),
    docks: BUILDING5_DOCKS,
    pedestrianRules: [],
  },
  {
    key: 'moll',
    legalName: 'ООО МОЛЛ',
    shortName: 'МОЛЛ',
    trucksDockRequired: true,
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(5, 29, 1, {
      trucksFromDocks: true,
      note: 'Данные неточные — ПРОВЕРИТЬ (Q-28).',
    }),
    docks: range(33, 61),
    pedestrianRules: [],
  },
  {
    key: 'coffee',
    legalName: 'ИП «Кофеавтоматы»',
    shortName: 'Кофеавтоматы',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(2, 0, 0),
    docks: [],
    pedestrianRules: [],
  },
  {
    key: 'canteen',
    legalName: 'ИП «Столовая»',
    shortName: 'Столовая',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(2, 0, 0),
    docks: [],
    pedestrianRules: [],
  },
  {
    key: 'multon',
    legalName: 'Мултон',
    shortName: 'Мултон',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(0, 0, 0, { note: 'Доступ, видимо, только пешком — ПРОВЕРИТЬ.' }),
    docks: [],
    pedestrianRules: [],
  },
  {
    key: 'energomax',
    legalName: 'ЭнергоМАКС',
    shortName: 'ЭнергоМАКС',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(1, 0, 0),
    docks: [],
    pedestrianRules: [],
  },
  {
    key: 'mastervent',
    legalName: 'Мастервент',
    shortName: 'Мастервент',
    contractNotes: CONTRACT_STUB,
    quotas: standardQuotas(5, 0, 0),
    docks: [],
    pedestrianRules: [],
  },
  {
    // A6: оператор — обычный арендатор без лимитов (нет лимита на тип = без ограничения, Q-7);
    // машины едут по общей матрице «тип × КПП» объекта (Q-54); «все КПП» для руководства — отдельным
    // исключением с waives: ['routing'] и match: {passIds}, оно в сиде не заводится
    key: 'integratsiya',
    legalName: 'ООО «Интеграция»',
    shortName: 'Интеграция',
    isOperator: true,
    quotas: [],
    docks: [],
    pedestrianRules: [],
  },
];

const DAILY_08_20 = [['08:00', '20:00']] as [string, string][];

export const RADONEZHSKY: SeedData = {
  organization: { key: 'integratsiya', name: 'ООО «Интеграция»', slug: 'integratsiya' },
  site: {
    key: 'radonezhsky',
    name: 'ЛЦ «Радонежский»',
    address: 'г. Челябинск',
    timezone: 'Asia/Yekaterinburg',
    // ПРОВЕРИТЬ (Q-17): заглушка 08:00–20:00 ежедневно
    workingHours: {
      mon: DAILY_08_20,
      tue: DAILY_08_20,
      wed: DAILY_08_20,
      thu: DAILY_08_20,
      fri: DAILY_08_20,
      sat: DAILY_08_20,
      sun: DAILY_08_20,
    },
    // остальное — значения по умолчанию SiteSettings (разовый до 24 ч, многоразовый 2–31 день,
    // вне рабочего времени — предупреждение, Q-17)
    settings: { dutyAdminPhone: '+70000000001' },
  },
  validFrom: { date: '2026-01-01', instant: '2026-01-01T00:00:00+05:00' },
  zones: [
    { key: 'warehouse', name: 'Основной склад', kind: 'building' },
    { key: 'building5', name: 'Стр. 5 (склад Агроторга)', kind: 'building' },
    { key: 'office', name: 'АБК (офисное здание)', kind: 'office' },
    { key: 'yard', name: 'Территория и стоянки', kind: 'yard' },
  ],
  gates: [
    {
      key: 'kpp1',
      name: 'КПП-1',
      kind: 'perimeter',
      admits: 'vehicles_and_pedestrians',
      sort: 10,
    },
    { key: 'kpp2', name: 'КПП-2', kind: 'perimeter', admits: 'vehicles', sort: 20 },
    // Q-20: пост в самом офисном здании; где он относительно периметра — ПРОВЕРИТЬ
    {
      key: 'office',
      name: 'КПП офис',
      kind: 'internal',
      admits: 'pedestrians',
      zoneKey: 'office',
      sort: 30,
    },
  ],
  categories: ['car', 'light_truck', 'semi', 'truck_5t', 'special'],
  docks: [
    ...WAREHOUSE_DOCKS.map((number) => ({
      number,
      zoneKey: 'warehouse',
      kind: 'leveller' as const,
      countsInQuota: true,
    })),
    ...BUILDING5_DOCKS.map((number) => ({
      number,
      zoneKey: 'building5',
      kind: 'leveller' as const,
      countsInQuota: true,
    })),
    // 11 наземных ворот ДНС в лимит не входят; нумерация и расположение — ПРОВЕРИТЬ
    ...DNS_GROUND_GATES.map((number) => ({
      number,
      kind: 'ground_gate' as const,
      countsInQuota: false,
    })),
  ],
  tenants: TENANTS,
  // Матрица «тип × КПП» (16_ A1); выезд — через любой КПП (Q-9), поэтому правила только на въезд.
  routing: [
    { participant: 'vehicle', category: 'car', gateKey: 'kpp1' },
    { participant: 'vehicle', category: 'light_truck', gateKey: 'kpp1' },
    { participant: 'vehicle', category: 'semi', gateKey: 'kpp2' },
    { participant: 'vehicle', category: 'truck_5t', gateKey: 'kpp2' },
    { participant: 'vehicle', category: 'special', gateKey: 'kpp2' },
    { participant: 'pedestrian', gateKey: 'kpp1' },
    { participant: 'pedestrian', destinationZoneKey: 'office', gateKey: 'office' },
  ],
  // ПРОВЕРИТЬ (Q-16): окно обязательно для грузовых, раньше — не пускать, опоздание до 60 мин
  timeWindowPolicies: [
    {
      key: 'trucks',
      windowRequired: true,
      earlyToleranceMin: 0,
      lateToleranceMin: 60,
      onViolation: 'hard',
      categories: ['light_truck', 'semi', 'truck_5t'],
    },
  ],
  exceptions: [
    {
      key: 'dns_bus',
      tenantKey: 'dns',
      name: 'Служебный автобус ДНС',
      // номер выдуманный — настоящий ПРОВЕРИТЬ; тип автобуса — «легковой» (сценарий 13: вне лимита легковых)
      match: { plates: ['A001AA174'] },
      waives: ['inspection', 'quota'],
      guardText: 'Служебный автобус ДНС — без досмотра, вне лимита',
      basis: 'Правила складского комплекса ДНС, п. 13; номер автобуса ПРОВЕРИТЬ',
    },
    {
      key: 'x5_24_7',
      tenantKey: 'x5',
      name: 'Агроторг (X5) — круглосуточно',
      match: { tenant: true },
      waives: ['working_hours', 'time_window'],
      guardText: 'Агроторг (X5): круглосуточно, окно прибытия не проверяется',
      basis: 'Договор с Агроторгом, пункт ПРОВЕРИТЬ',
    },
  ],
  // ПРОВЕРИТЬ (Q-25): разовый — без согласования; многоразовый и постоянный — на согласование
  // директору с обязательным комментарием, эскалация администратору через 4 ч
  approvalPolicies: [
    { creatorKind: 'tenant', passType: 'single', mode: 'allow' },
    {
      creatorKind: 'tenant',
      passType: 'multi',
      mode: 'on_request',
      commentRequired: true,
      escalationHours: 4,
      onTimeout: 'escalate',
    },
    {
      creatorKind: 'tenant',
      passType: 'permanent',
      mode: 'on_request',
      commentRequired: true,
      escalationHours: 4,
      onTimeout: 'escalate',
    },
    // охрана → разовый по запросу «без пропуска» (ARCHITECTURE 3.3)
    { creatorKind: 'gate', passType: 'single', mode: 'on_request' },
    { creatorKind: 'gate', passType: 'multi', mode: 'deny' },
    { creatorKind: 'gate', passType: 'permanent', mode: 'deny' },
    { creatorKind: 'admin', passType: 'single', mode: 'allow' },
    { creatorKind: 'admin', passType: 'multi', mode: 'allow' },
    { creatorKind: 'admin', passType: 'permanent', mode: 'allow' },
  ],
  gateAccountRoleTemplate: 'gate_post',
  checkList: [
    'Рабочее время комплекса: 08:00–20:00 ежедневно, вне его — предупреждение (Q-17).',
    'Нумерация 7 доков стр. 5 (Агроторг): «З1–З7» (Q-52).',
    'Нумерация и расположение 11 наземных ворот ДНС: «Н1–Н11», без зоны (Q-52).',
    'Расположение КПП офис относительно периметра; маршрут пешеходов в АБК — через КПП офис (Q-20).',
    'Рельеф-Центр: 2 легковых — договорённость, не договор (Q-27).',
    'ООО МОЛЛ: 5 легковых, 29 грузовых, доки №33–61, 1 спецтехника — данные неточные (Q-28).',
    'Мултон: лимиты 0/0/0 — доступ только пешком? (Q-51)',
    'Номер служебного автобуса ДНС (в сиде выдуманный A001AA174, тип «легковой»; Q-53).',
    'Политики согласования: разовый — без согласования, многоразовый и постоянный — на согласование с комментарием, эскалация через 4 ч (Q-25).',
    'Окно прибытия для грузовых: обязательно, раньше — не пускать, опоздание до 60 мин (Q-16).',
    'Договоры: номера, даты и пункты — заглушки «п. …»; юридические наименования и ИНН арендаторов — как в таблице лимитов.',
    'Начало действия лимитов, исключений и назначений доков — 01.01.2026.',
    'Телефоны дежурного администратора и сопровождающих ДНС и Континента — выдуманные.',
  ],
};

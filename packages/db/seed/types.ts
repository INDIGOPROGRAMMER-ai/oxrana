import type {
  ApprovalCreatorKind,
  ApprovalMode,
  ApprovalTimeoutAction,
  DockKind,
  ExceptionMatch,
  ExceptionWaive,
  GateAdmits,
  GateKind,
  PassType,
  PedestrianEscort,
  QuotaEnforcement,
  SiteSettingsInput,
  VehicleCategoryPresetCode,
  WindowViolationMode,
  WorkingHours,
  ZoneKind,
} from '@oxrana/contracts';

/**
 * Описание демо-объекта для сида (только тесты и разработка, ADR-016): обычные данные
 * справочников, ссылки — по ключам (`key`), id получаются из ключей (`seedId`).
 */
export interface SeedData {
  organization: { key: string; name: string; slug: string };
  site: {
    key: string;
    name: string;
    address: string;
    timezone: string;
    workingHours: WorkingHours | null;
    settings: SiteSettingsInput;
  };
  /** С какого момента действуют лимиты, исключения и назначения доков сида. */
  validFrom: { date: string; instant: string };
  zones: { key: string; name: string; kind: ZoneKind }[];
  gates: {
    key: string;
    name: string;
    kind: GateKind;
    admits: GateAdmits;
    zoneKey?: string;
    sort: number;
  }[];
  /** Включённые рекомендованные типы; порядок массива = порядок в списках. */
  categories: VehicleCategoryPresetCode[];
  docks: { number: string; zoneKey?: string; kind: DockKind; countsInQuota: boolean }[];
  tenants: TenantSeed[];
  routing: {
    tenantKey?: string;
    participant: 'vehicle' | 'pedestrian';
    category?: VehicleCategoryPresetCode;
    destinationZoneKey?: string;
    gateKey: string;
  }[];
  timeWindowPolicies: {
    key: string;
    tenantKey?: string;
    windowRequired: boolean;
    earlyToleranceMin: number;
    lateToleranceMin: number | null;
    onViolation: WindowViolationMode;
    categories: VehicleCategoryPresetCode[];
  }[];
  exceptions: {
    key: string;
    tenantKey?: string;
    name: string;
    match: ExceptionMatch;
    waives: ExceptionWaive[];
    guardText: string;
    basis: string;
  }[];
  approvalPolicies: {
    creatorKind: ApprovalCreatorKind;
    passType: PassType;
    mode: ApprovalMode;
    commentRequired?: boolean;
    escalationHours?: number;
    onTimeout?: ApprovalTimeoutAction;
  }[];
  /** Учётка на каждый КПП получает роль этого шаблона (A11). */
  gateAccountRoleTemplate: string;
}

export interface TenantSeed {
  key: string;
  legalName: string;
  shortName: string;
  isOperator?: boolean;
  trucksDockRequired?: boolean;
  defaultCategory?: VehicleCategoryPresetCode;
  responsiblePhone?: string;
  emergencyPhone?: string;
  /** Примечание демо-договора; у оператора договора нет. */
  contractNotes?: string;
  quotas: QuotaSeed[];
  /** Номера доков арендатора. */
  docks: string[];
  pedestrianRules: {
    zoneKey?: string;
    documentRequired: boolean;
    escort: PedestrianEscort;
    escortPhone?: string;
    guardText: string;
  }[];
}

export interface QuotaSeed {
  key: string;
  name: string;
  categories: VehicleCategoryPresetCode[];
  capacity: number;
  /** capacity = число доков арендатора с counts_in_quota (сид сверяет). */
  capacityFromDocks?: boolean;
  enforcement?: QuotaEnforcement;
  overageTariffRub?: string;
  /** Основание: пункт демо-договора. */
  clause: { ref: string; summary: string };
}

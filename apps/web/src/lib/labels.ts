import type {
  ApprovalCreatorKind,
  ApprovalMode,
  DockKind,
  ExceptionWaive,
  GateAdmits,
  GateKind,
  PassType,
  PedestrianEscort,
  QuotaEnforcement,
  ZoneKind,
} from '@oxrana/contracts';

/** Подписи перечислений для интерфейса (термины — `docs/GLOSSARY.md`). */
export const ADMITS_LABEL: Record<GateAdmits, string> = {
  vehicles_and_pedestrians: 'машины и пешеходы',
  vehicles: 'только машины',
  pedestrians: 'только пешеходы',
};
export const GATE_KIND_LABEL: Record<GateKind, string> = {
  perimeter: 'на периметре (въезд на территорию)',
  internal: 'внутри здания (только отметка прохода)',
};
export const ZONE_KIND_LABEL: Record<ZoneKind, string> = {
  building: 'здание',
  yard: 'двор',
  parking: 'парковка',
  dock_area: 'зона доков',
  office: 'офис',
  other: 'другое',
};
export const DOCK_KIND_LABEL: Record<DockKind, string> = {
  leveller: 'с уравнивающей платформой',
  ground_gate: 'наземные ворота',
  other: 'другой',
};
export const ENFORCEMENT_LABEL: Record<QuotaEnforcement, string> = {
  hard: 'жёсткий — сверх лимита не пускать',
  soft: 'мягкий — пускать, считать сверхлимит',
  warn: 'информирующий — только предупредить',
};
export const ENFORCEMENT_SHORT: Record<QuotaEnforcement, string> = {
  hard: 'жёсткий',
  soft: 'мягкий',
  warn: 'информирующий',
};
export const ESCORT_LABEL: Record<PedestrianEscort, string> = {
  none: 'не нужно',
  if_no_document: 'если нет документа',
  always: 'всегда',
};
export const WAIVE_LABEL: Record<ExceptionWaive, string> = {
  inspection: 'досмотр',
  quota: 'лимит',
  time_window: 'окно прибытия',
  working_hours: 'рабочее время',
  routing: 'маршрут КПП',
};
export const PASS_TYPE_LABEL: Record<PassType, string> = {
  single: 'разовый',
  multi: 'многоразовый',
  permanent: 'постоянный',
};
export const CREATOR_LABEL: Record<ApprovalCreatorKind, string> = {
  tenant: 'арендатор',
  admin: 'администратор',
  gate: 'охрана',
};
export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  allow: 'без согласования',
  on_request: 'на согласование',
  deny: 'запрещено',
};

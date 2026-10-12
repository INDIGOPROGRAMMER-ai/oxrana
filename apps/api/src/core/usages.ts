import type { Usage } from '@oxrana/db';

/** Как назвать ссылающуюся таблицу человеку: «КПП используется: правила маршрута — 4». */
const TABLE_LABELS: Record<string, string> = {
  routing_rules: 'правила маршрута',
  gate_accounts: 'учётки КПП',
  gate_decisions: 'журнал КПП',
  gate_passages: 'проходы внутреннего поста',
  gate_queue: 'очередь у ворот',
  gate_requests: 'запросы с поста',
  gate_actions: 'действия поста',
  override_requests: 'запросы исключений',
  visits: 'визиты',
  passes: 'пропуска',
  docks: 'доки',
  gates: 'КПП',
  zones: 'зоны',
  tenants: 'арендаторы',
  quotas: 'лимиты',
  quota_categories: 'наборы типов лимитов',
  time_window_policies: 'политики окна прибытия',
  time_window_policy_categories: 'типы в политиках окна',
  exceptions: 'исключения',
  approval_policies: 'политики согласования',
  pedestrian_rules: 'правила для пешеходов',
  contracts: 'договоры',
  contract_clauses: 'пункты договоров',
  tenant_dock_assignments: 'назначения доков',
  tenant_parking_assignments: 'назначения мест',
  fleet_vehicles: 'автопарк',
  vehicle_categories: 'типы транспорта',
  hardware_devices: 'оборудование',
  hardware_events: 'события оборудования',
  barrier_commands: 'команды шлагбауму',
  overage_charges: 'начисления за сверхлимит',
  pass_batches: 'пакеты пропусков',
  parking_areas: 'парковочные участки',
  violations: 'нарушения',
  role_assignments: 'назначения ролей',
  invitations: 'приглашения',
};

export interface UsageView {
  readonly table: string;
  readonly column: string;
  readonly label: string;
  readonly count: number;
}

export function usageView(usage: Usage): UsageView {
  return { ...usage, label: TABLE_LABELS[usage.table] ?? usage.table };
}

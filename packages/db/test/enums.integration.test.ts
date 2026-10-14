import * as c from '@oxrana/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src';

/**
 * Перечисления хранятся как `text` + `check` (DATA_MODEL, соглашения). Тест сверяет `check` в
 * применённых миграциях с zod-схемами из `packages/contracts`: поменяли список и не сгенерировали
 * миграцию (или наоборот) — тест красный.
 */
/** zod-перечисление: нужен только список значений. */
type EnumSchema = { readonly options: readonly string[] };

const ENUM_COLUMNS: [table: string, column: string, schema: EnumSchema][] = [
  ['zones', 'kind', c.ZoneKindSchema],
  ['gates', 'kind', c.GateKindSchema],
  ['gates', 'admits', c.GateAdmitsSchema],
  ['gates', 'direction', c.DirectionSchema],
  ['docks', 'kind', c.DockKindSchema],
  ['vehicle_categories', 'preset_code', c.VehicleCategoryPresetCodeSchema],
  ['tenants', 'status', c.TenantStatusSchema],
  ['contracts', 'status', c.ContractStatusSchema],
  ['pedestrian_rules', 'escort', c.PedestrianEscortSchema],
  ['quotas', 'participant', c.ParticipantSchema],
  ['quotas', 'counting', c.QuotaCountingSchema],
  ['quotas', 'enforcement', c.QuotaEnforcementSchema],
  ['routing_rules', 'participant', c.ParticipantSchema],
  ['routing_rules', 'direction', c.DirectionSchema],
  ['time_window_policies', 'on_violation', c.WindowViolationModeSchema],
  ['exceptions', 'waives', c.ExceptionWaiveSchema],
  ['approval_policies', 'creator_kind', c.ApprovalCreatorKindSchema],
  ['approval_policies', 'pass_type', c.PassTypeSchema],
  ['approval_policies', 'mode', c.ApprovalModeSchema],
  ['approval_policies', 'on_timeout', c.ApprovalTimeoutActionSchema],
  ['passes', 'pass_type', c.PassTypeSchema],
  ['passes', 'participant', c.ParticipantSchema],
  ['passes', 'status', c.PassStatusSchema],
  ['passes', 'created_via', c.PassSourceSchema],
  ['pass_change_requests', 'status', c.ChangeRequestStatusSchema],
  ['visits', 'participant', c.ParticipantSchema],
  ['visits', 'method_in', c.VisitMethodSchema],
  ['visits', 'method_out', c.VisitMethodSchema],
  ['visits', 'flags', c.VisitFlagSchema],
  ['gate_decisions', 'direction', c.PassageDirectionSchema],
  ['gate_decisions', 'verdict', c.VerdictCodeSchema],
  ['gate_decisions', 'action', c.GateActionSchema],
  ['gate_actions', 'type', c.GateActionTypeSchema],
  ['gate_actions', 'outcome', c.GateActionOutcomeSchema],
  ['gate_passages', 'direction', c.PassageDirectionSchema],
  ['gate_queue', 'left_reason', c.QueueLeaveReasonSchema],
  ['gate_requests', 'participant', c.ParticipantSchema],
  ['gate_requests', 'status', c.GateRequestStatusSchema],
  ['override_requests', 'direction', c.PassageDirectionSchema],
  ['override_requests', 'verdict_code', c.VerdictCodeSchema],
  ['override_requests', 'status', c.OverrideStatusSchema],
  ['override_requests', 'via', c.OverrideViaSchema],
  ['violations', 'status', c.ViolationStatusSchema],
  ['users', 'status', c.UserStatusSchema],
  ['password_resets', 'purpose', c.PasswordResetPurposeSchema],
  ['gate_accounts', 'status', c.GateAccountStatusSchema],
  ['gate_devices', 'kind', c.GateDeviceKindSchema],
  ['device_enrollments', 'kind', c.GateDeviceKindSchema],
  ['notification_preferences', 'channel', c.NotificationChannelSchema],
  ['hardware_devices', 'kind', c.HardwareDeviceKindSchema],
  ['hardware_devices', 'direction', c.DirectionSchema],
  ['hardware_devices', 'status', c.HardwareDeviceStatusSchema],
  ['hardware_events', 'type', c.HardwareEventTypeSchema],
  ['barrier_commands', 'type', c.BarrierCommandTypeSchema],
  ['barrier_commands', 'cause', c.BarrierCommandCauseSchema],
  ['barrier_commands', 'status', c.BarrierCommandStatusSchema],
  ['audit_log', 'actor_type', c.AuditActorTypeSchema],
  ['notifications', 'status', c.NotificationStatusSchema],
  ['pass_form_settings', 'level', c.PassFormLevelSchema],
];

const owner = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 1 });
afterAll(() => owner.end());

/** Все `check`-ограничения схемы public со списком значений: имя → значения по порядку. */
async function enumChecksInDb(): Promise<Map<string, string[]>> {
  const { rows } = await owner.query<{ name: string; def: string }>(`
    select con.conname as name, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      join pg_namespace n on n.oid = con.connamespace
     where n.nspname = 'public' and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%ARRAY[%'`);
  return new Map(
    rows.map((r) => [r.name, [...r.def.matchAll(/'([^']*)'::text/g)].map((m) => m[1] ?? '')]),
  );
}

describe('check-списки в БД совпадают с zod-перечислениями contracts', () => {
  it.each(ENUM_COLUMNS)('%s.%s', async (table, column, schema) => {
    const checks = await enumChecksInDb();
    expect(checks.get(`${table}_${column}_check`)).toEqual(schema.options);
  });

  it('в БД нет перечислений, не описанных в contracts', async () => {
    const described = new Set(ENUM_COLUMNS.map(([t, col]) => `${t}_${col}_check`));
    const undocumented = [...(await enumChecksInDb()).keys()].filter((n) => !described.has(n));
    expect(undocumented).toEqual([]);
  });

  it('недопустимое значение отклоняется базой', async () => {
    // check проверяется при вставке строки, раньше внешних ключей: site_id может быть любым.
    await expect(
      owner.query(
        `insert into zones (organization_id, site_id, name, kind)
           values (gen_random_uuid(), gen_random_uuid(), 'z', 'castle')`,
      ),
    ).rejects.toThrow(/zones_kind_check/);
  });
});

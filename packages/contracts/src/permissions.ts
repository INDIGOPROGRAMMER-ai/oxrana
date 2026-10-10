/**
 * Коды прав — единственный источник (ADR-007). Роль — набор этих кодов (`roles.permissions`);
 * новая роль пуста. Маршрут API объявляет одно право в `config.permission`.
 */
export const PERMISSIONS = [
  // настройка объекта
  'site.manage',
  'tenant.manage',
  'quota.manage',
  'rule.manage', // маршруты, окна, исключения, политики
  'user.manage',
  'role.manage',
  'device.manage',
  'hardware.manage',
  'tenant_user.manage', // пользователи своего арендатора
  // пропуска
  'pass.view',
  'pass.view_all_tenants',
  'pass.create.single',
  'pass.create.multi',
  'pass.create.permanent',
  'pass.create_for_any_tenant',
  'pass.edit',
  'pass.cancel',
  'pass.approve',
  'pass.change_request.create',
  'pass.change_request.decide',
  // действия поста
  'visit.check_in',
  'visit.check_out',
  'gate.redirect',
  'gate.refuse',
  'gate.request',
  'gate.undo',
  'gate.override_request',
  'gate.override',
  'gate.passage',
  // наблюдение, отчёты, прочее
  'queue.view',
  'occupancy.view',
  'violation.create',
  'violation.manage',
  'report.view',
  'report.export',
  'audit.view',
  'sandbox.use',
  'notification.manage_own',
  'profile.manage_own', // свои настройки: пояс, «показывать ещё и моё время» (ADR-009)
] as const satisfies readonly string[];

export type PermissionCode = (typeof PERMISSIONS)[number];

/** Действия поста: администратор объекта их не выполняет (A7, Q-13). */
export const GATE_POST_ONLY_PERMISSIONS = [
  'visit.check_in',
  'visit.check_out',
  'gate.redirect',
  'gate.refuse',
  'gate.undo',
  'gate.passage',
] as const satisfies readonly PermissionCode[];

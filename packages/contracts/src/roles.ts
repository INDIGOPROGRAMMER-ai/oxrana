import { GATE_POST_ONLY_PERMISSIONS, PERMISSIONS, type PermissionCode } from './permissions';

/** Область назначения роли (ADR-007): вся организация · объект · КПП · арендатор. */
export const ROLE_SCOPES = ['organization', 'site', 'gate', 'tenant'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

export interface RoleTemplate {
  /** Стабильный ключ шаблона; название роли в организации редактируется. */
  readonly code: string;
  readonly name: string;
  /** В какой области роль обычно назначают (подсказка мастеру, а не ограничение БД). */
  readonly scope: RoleScope;
  readonly permissions: readonly PermissionCode[];
}

const POST_PERMISSIONS = [
  'pass.view_all_tenants',
  'visit.check_in',
  'visit.check_out',
  'gate.redirect',
  'gate.refuse',
  'gate.request',
  'gate.undo',
  'gate.override_request',
  'gate.passage',
  'occupancy.view',
  'queue.view',
  'pass.create.single', // только через запрос «без пропуска» (gate_request)
] as const satisfies readonly PermissionCode[];

const postOnly = new Set<PermissionCode>(GATE_POST_ONLY_PERMISSIONS);

/**
 * Шаблоны ролей, которые получает новая организация (ADR-007, таблица «Шаблоны ролей»). Роли
 * создаются копиями с `is_template = true` и дальше редактируются как обычные.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: 'org_owner',
    name: 'Владелец организации',
    scope: 'organization',
    permissions: PERMISSIONS,
  },
  {
    code: 'site_admin',
    name: 'Администратор объекта',
    scope: 'site',
    permissions: PERMISSIONS.filter((p) => !postOnly.has(p)),
  },
  {
    code: 'approver',
    name: 'Согласующий',
    scope: 'site',
    permissions: [
      'pass.view_all_tenants',
      'pass.approve',
      'pass.change_request.decide',
      'report.view',
      'occupancy.view',
      'profile.manage_own',
    ],
  },
  { code: 'gate_post', name: 'Пост КПП', scope: 'gate', permissions: POST_PERMISSIONS },
  {
    code: 'shift_senior',
    name: 'Старший смены',
    scope: 'gate',
    permissions: [...POST_PERMISSIONS, 'gate.override'],
  },
  {
    code: 'accountant',
    name: 'Бухгалтер',
    scope: 'organization',
    permissions: ['report.view', 'report.export', 'profile.manage_own'],
  },
  {
    code: 'tenant_manager',
    name: 'Арендатор — ответственный',
    scope: 'tenant',
    permissions: [
      'pass.view',
      'pass.create.single',
      'pass.create.multi',
      'pass.create.permanent',
      'pass.edit',
      'pass.cancel',
      'pass.cancel_own',
      'pass.change_request.create',
      'fleet.manage',
      'tenant_user.manage',
      'gate.request',
      'report.view',
      'report.export',
      'occupancy.view',
      'profile.manage_own',
    ],
  },
  {
    code: 'tenant_requester',
    name: 'Арендатор — заказчик',
    scope: 'tenant',
    permissions: [
      'pass.view',
      'pass.create.single',
      'pass.create.multi',
      'pass.create.permanent',
      'pass.cancel_own',
      'pass.change_request.create',
      'occupancy.view', // лимиты своей компании на главной кабинета (Q-77)
      'profile.manage_own',
    ],
  },
  {
    code: 'tenant_viewer',
    name: 'Арендатор — наблюдатель',
    scope: 'tenant',
    permissions: ['pass.view', 'occupancy.view', 'profile.manage_own'],
  },
];

/** Шаблон по коду; неизвестный код — ошибка программы. */
export function roleTemplate(code: string): RoleTemplate {
  const template = ROLE_TEMPLATES.find((t) => t.code === code);
  if (!template) throw new Error(`Неизвестный шаблон роли: ${code}`);
  return template;
}

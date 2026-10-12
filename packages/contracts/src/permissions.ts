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
  'pass.cancel', // любые пропуска своего арендатора (или всех — у сотрудника оператора)
  'pass.cancel_own', // только созданные этим пользователем (Q-56)
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

/** Подписи прав для редактора ролей (по-русски, одна строка). */
export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  'site.manage': 'Настройка объекта: КПП, зоны, доки, типы транспорта',
  'tenant.manage': 'Арендаторы, договоры, доки арендаторов',
  'quota.manage': 'Лимиты',
  'rule.manage': 'Маршруты, окна, исключения, политики согласования',
  'user.manage': 'Пользователи и приглашения',
  'role.manage': 'Роли и права',
  'device.manage': 'Устройства КПП: привязка и отзыв',
  'hardware.manage': 'Оборудование КПП',
  'tenant_user.manage': 'Пользователи своей компании',
  'pass.view': 'Просмотр пропусков своей компании',
  'pass.view_all_tenants': 'Просмотр пропусков всех арендаторов',
  'pass.create.single': 'Создание разовых пропусков',
  'pass.create.multi': 'Создание многоразовых пропусков',
  'pass.create.permanent': 'Создание постоянных пропусков',
  'pass.create_for_any_tenant': 'Создание пропусков за любого арендатора',
  'pass.edit': 'Правка пропусков',
  'pass.cancel': 'Отмена любых пропусков своей компании',
  'pass.cancel_own': 'Отмена своих пропусков',
  'pass.approve': 'Согласование пропусков',
  'pass.change_request.create': 'Заявки на изменение пропуска',
  'pass.change_request.decide': 'Решение по заявкам на изменение',
  'visit.check_in': 'Пост: отметить въезд',
  'visit.check_out': 'Пост: отметить выезд',
  'gate.redirect': 'Пост: направить на другой КПП',
  'gate.refuse': 'Пост: отказать во въезде',
  'gate.request': 'Запросы «без пропуска»: создать и ответить',
  'gate.undo': 'Пост: отменить последнее действие',
  'gate.override_request': 'Пост: запросить исключение',
  'gate.override': 'Одобрение исключений по запросу поста',
  'gate.passage': 'Пост: отметить проход (внутренний пост)',
  'queue.view': 'Очередь у ворот',
  'occupancy.view': 'Табло занятости лимитов',
  'violation.create': 'Фиксация нарушений',
  'violation.manage': 'Нарушения и акты',
  'report.view': 'Отчёты',
  'report.export': 'Выгрузка отчётов',
  'audit.view': 'Журнал аудита',
  'sandbox.use': 'Песочница правил',
  'notification.manage_own': 'Свои уведомления',
  'profile.manage_own': 'Свои настройки',
};

/** Действия поста: администратор объекта их не выполняет (A7, Q-13). */
export const GATE_POST_ONLY_PERMISSIONS = [
  'visit.check_in',
  'visit.check_out',
  'gate.redirect',
  'gate.refuse',
  'gate.undo',
  'gate.passage',
] as const satisfies readonly PermissionCode[];

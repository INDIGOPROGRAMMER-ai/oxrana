/**
 * Коды прав — единственный источник (ADR-007). Роль — набор этих кодов (`roles.permissions`);
 * новая роль пуста. Маршрут API объявляет одно право в `config.permission`.
 */
export const PERMISSIONS = [
  // настройка объекта
  'site.manage',
  'tenant.manage',
  'tenant.block', // блокировка арендатора с последствиями
  'contract.file', // файл договора: загрузка и просмотр
  'blacklist.manage',
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
  'fleet.manage', // автопарк арендатора: добавление, правка, удаление (этап 7a)
  'pass_form.manage', // форма пропуска: уровни «объект» и «арендатор» (этап 7b)
  'pass_form.manage_users', // форма пропуска сотрудников своей компании (этап 7b)
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
  'tenant.block': 'Блокировка и разблокировка арендатора',
  'contract.file': 'Файлы договоров: загрузка и просмотр',
  'blacklist.manage': 'Чёрный список',
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
  'fleet.manage': 'Автопарк: постоянные машины компании',
  'pass_form.manage': 'Форма пропуска: настройка для объекта и арендаторов',
  'pass_form.manage_users': 'Форма пропуска: настройка для сотрудников своей компании',
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

/**
 * Группы прав для редактора ролей (этап 6b): человек видит не «tenant.block», а раздел «Настройка
 * объекта» и подписи. Каждое право — ровно в одной группе (проверяет тест contracts).
 */
export const PERMISSION_GROUPS: readonly {
  readonly title: string;
  readonly hint: string;
  readonly codes: readonly PermissionCode[];
}[] = [
  {
    title: 'Настройка объекта',
    hint: 'Объект, КПП, арендаторы, правила, лимиты, чёрный список, устройства.',
    codes: [
      'site.manage',
      'tenant.manage',
      'tenant.block',
      'contract.file',
      'blacklist.manage',
      'quota.manage',
      'rule.manage',
      'device.manage',
      'hardware.manage',
    ],
  },
  {
    title: 'Люди и роли',
    hint: 'Кто может приглашать людей и менять права.',
    codes: ['user.manage', 'role.manage', 'tenant_user.manage'],
  },
  {
    title: 'Пропуска',
    hint: 'Оформление, правка, отмена и согласование пропусков.',
    codes: [
      'pass.view',
      'pass.view_all_tenants',
      'pass.create.single',
      'pass.create.multi',
      'pass.create.permanent',
      'pass.create_for_any_tenant',
      'pass.edit',
      'pass.cancel',
      'pass.cancel_own',
      'pass.approve',
      'pass.change_request.create',
      'pass.change_request.decide',
      'fleet.manage',
      'pass_form.manage',
      'pass_form.manage_users',
    ],
  },
  {
    title: 'Пост охраны',
    hint: 'Действия на КПП. Администратору объекта их не выдают: «Впустить» нажимает охрана.',
    codes: [
      'visit.check_in',
      'visit.check_out',
      'gate.redirect',
      'gate.refuse',
      'gate.request',
      'gate.undo',
      'gate.override_request',
      'gate.override',
      'gate.passage',
    ],
  },
  {
    title: 'Наблюдение и отчёты',
    hint: 'Табло, очередь, отчёты, журнал, песочница правил.',
    codes: [
      'queue.view',
      'occupancy.view',
      'violation.create',
      'violation.manage',
      'report.view',
      'report.export',
      'audit.view',
      'sandbox.use',
    ],
  },
  {
    title: 'Личное',
    hint: 'Свои уведомления и настройки.',
    codes: ['notification.manage_own', 'profile.manage_own'],
  },
];

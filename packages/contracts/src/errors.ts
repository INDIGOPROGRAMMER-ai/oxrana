import { z } from 'zod';

/**
 * Коды ошибок API. Код — стабильный идентификатор для клиента, текст — для человека. Технические
 * коды каркаса — первые семь; доменные коды добавляются вместе с модулями, которые их бросают.
 * Модуль может уточнить текст по умолчанию: назвать причину и где её исправить (CLAUDE.md п. 8).
 */
export const ERROR_CODES = [
  // каркас (этап 1)
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'unavailable',
  'internal',
  // общие доменные (этап 4)
  'conflict',
  'in_use',
  'confirmation_required',
  'reason_required',
  'gate_device_required',
  // объект и пояса
  'timezone_invalid',
  'timezone_required',
  'timezone_change_separate',
  // пропуска
  'pass_type_forbidden',
  'tenant_blocked',
  'contract_expired',
  'plate_required',
  'person_required',
  'category_required',
  'category_unavailable',
  'dock_required',
  'dock_not_assigned',
  'comment_required',
  'starts_in_past',
  'invalid_period',
  'window_outside_validity',
  'pass_duplicate',
  'pass_not_editable',
  'change_request_closed',
  // пост
  'idempotency_conflict',
  'undo_window_passed',
  'nothing_to_undo',
  'gate_request_closed',
  'wrong_gate_kind',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Текст по умолчанию (по-русски). Модуль может уточнить его, назвав причину и где её исправить. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'Запрос не удалось разобрать. Проверьте формат отправленных данных.',
  validation_failed: 'Данные не прошли проверку. Исправьте отмеченное поле и повторите.',
  unauthenticated: 'Нужно войти в систему.',
  forbidden:
    'Недостаточно прав для этого действия. Права назначает администратор в разделе «Роли».',
  not_found: 'Запрошенный адрес или запись не найдены.',
  unavailable:
    'Сервис временно недоступен. Повторите через минуту; если не проходит — сообщите администратору.',
  internal: 'Внутренняя ошибка сервера. Сообщите администратору номер запроса.',
  conflict: 'Запись изменилась или уже существует. Обновите данные и повторите.',
  in_use:
    'Запись используется в других настройках. Посмотрите, где именно, и подтвердите удаление.',
  confirmation_required: 'Действие меняет важные настройки. Прочитайте последствия и подтвердите.',
  reason_required: 'Укажите причину изменения — она попадёт в журнал.',
  gate_device_required: 'Действие выполняется только с устройства поста КПП.',
  timezone_invalid: 'Неизвестный часовой пояс. Выберите пояс из списка.',
  timezone_required:
    'Укажите часовой пояс объекта: у организации не задан пояс по умолчанию (Настройки → Организация).',
  timezone_change_separate:
    'Часовой пояс объекта меняется отдельным действием «Сменить пояс» с подтверждением последствий.',
  pass_type_forbidden: 'Политика согласования запрещает создавать такой пропуск.',
  tenant_blocked: 'Арендатору запрещено оформлять новые пропуска.',
  contract_expired: 'Договор арендатора закончился — новые пропуска не оформляются.',
  plate_required: 'Укажите номер машины.',
  person_required: 'Укажите фамилию и имя пешехода.',
  category_required: 'Укажите тип транспорта.',
  category_unavailable: 'Этот тип транспорта недоступен на объекте.',
  dock_required: 'Укажите док.',
  dock_not_assigned: 'Этот док не закреплён за арендатором.',
  comment_required: 'Укажите, для чего и зачем нужен пропуск.',
  starts_in_past: 'Начало пропуска не может быть в прошлом.',
  invalid_period: 'Проверьте срок действия пропуска.',
  window_outside_validity: 'Окно прибытия должно попадать в срок действия пропуска.',
  pass_duplicate: 'У арендатора уже есть действующий пропуск на этот номер на пересекающийся срок.',
  pass_not_editable: 'Пропуск в этом статусе не редактируется.',
  change_request_closed: 'Заявка на изменение уже рассмотрена.',
  idempotency_conflict: 'Действие с этим идентификатором уже выполнено с другими данными.',
  undo_window_passed: 'Время на отмену прошло. Исправить запись может администратор с причиной.',
  nothing_to_undo: 'Отменять нечего: действие не открывало и не закрывало визит.',
  gate_request_closed: 'Запрос уже закрыт: на него ответили, его отменили или истёк срок.',
  wrong_gate_kind: 'Это действие не выполняется на КПП такого вида.',
};

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  unavailable: 503,
  internal: 500,
  conflict: 409,
  in_use: 409,
  confirmation_required: 409,
  reason_required: 422,
  gate_device_required: 403,
  timezone_invalid: 422,
  timezone_required: 422,
  timezone_change_separate: 422,
  pass_type_forbidden: 422,
  tenant_blocked: 422,
  contract_expired: 422,
  plate_required: 422,
  person_required: 422,
  category_required: 422,
  category_unavailable: 422,
  dock_required: 422,
  dock_not_assigned: 422,
  comment_required: 422,
  starts_in_past: 422,
  invalid_period: 422,
  window_outside_validity: 422,
  pass_duplicate: 409,
  pass_not_editable: 409,
  change_request_closed: 409,
  idempotency_conflict: 409,
  undo_window_passed: 409,
  nothing_to_undo: 409,
  gate_request_closed: 409,
  wrong_gate_kind: 422,
};

/**
 * Тело любой ошибки API (CLAUDE.md, правило 8). `field` — поле формы, в котором причина;
 * `settingLink` — путь экрана веб-интерфейса, где причину можно исправить. Оба `null`, если неприменимо.
 * `permission` приходит только с `forbidden` (ADR-007): какого права не хватило. `details` —
 * данные для экрана (где используется запись, какой пропуск дублируется), без ПДн сверх нужного.
 */
export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  field: z.string().nullable(),
  settingLink: z.string().nullable(),
  requestId: z.string().min(1),
  permission: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

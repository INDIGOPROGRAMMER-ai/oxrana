import { z } from 'zod';

/**
 * Коды ошибок API. Здесь только технические коды каркаса; доменные коды добавляются вместе с
 * модулями, которые их бросают. Код — стабильный идентификатор для клиента, текст — для человека.
 */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'unavailable',
  'internal',
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
};

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  unavailable: 503,
  internal: 500,
};

/**
 * Тело любой ошибки API (CLAUDE.md, правило 8). `field` — поле формы, в котором причина;
 * `settingLink` — путь экрана веб-интерфейса, где причину можно исправить. Оба `null`, если неприменимо.
 * `permission` приходит только с `forbidden` (ADR-007): какого права не хватило.
 */
export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  field: z.string().nullable(),
  settingLink: z.string().nullable(),
  requestId: z.string().min(1),
  permission: z.string().optional(),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

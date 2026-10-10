import { ERROR_HTTP_STATUS, ERROR_MESSAGES, type ErrorCode } from '@oxrana/contracts';

export interface AppErrorOptions {
  /** Текст вместо стандартного: назовите причину и где её исправить. */
  message?: string;
  /** Поле формы, в котором причина. */
  field?: string;
  /** Путь экрана веб-интерфейса, где причину можно исправить. */
  settingLink?: string;
  /** Не хватившее право (только для `forbidden`, ADR-007). */
  permission?: string;
  /** Данные для экрана: где используется запись, какой пропуск дублируется. */
  details?: Record<string, unknown>;
}

/** Ожидаемая ошибка прикладного уровня; обработчик превращает её в тело `{code, message, field, settingLink, requestId}`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field: string | null;
  readonly settingLink: string | null;
  readonly permission: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.field = options.field ?? null;
    this.settingLink = options.settingLink ?? null;
    this.permission = options.permission ?? null;
    this.details = options.details ?? null;
  }

  get statusCode(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

import { z } from 'zod';
import { useRussianZodMessages } from './i18n';

useRussianZodMessages();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string({ error: 'не задана строка подключения к БД' })
    .min(1, 'не задана строка подключения к БД'),
  /**
   * Адрес веб-кабинета, как его видит пользователь: из него собираются ссылки приглашений и
   * установки пароля, с него разрешены изменяющие запросы (защита от CSRF, ADR-018). При https
   * cookie сессии ставится с `Secure`.
   */
  PUBLIC_URL: z
    .url('PUBLIC_URL — адрес веб-кабинета, например https://pass.example.ru')
    .default('http://127.0.0.1:5173'),
  /**
   * Адрес приложения поста: в QR привязки устройства. Может лежать под путём общего домена
   * (`https://pass.example.ru/gate`) — проверка Origin сравнивает только origin.
   */
  GATE_URL: z.url('GATE_URL — адрес приложения поста').default('http://127.0.0.1:5174'),
  /**
   * Доверять заголовкам `X-Forwarded-*` от обратного прокси (Caddy на сервере). Включается только
   * когда порт API снаружи недоступен: иначе клиент подделает свой IP, а по IP считается ограничение
   * попыток входа и пишется аудит.
   */
  TRUST_PROXY: z
    .enum(['true', 'false'], { error: 'TRUST_PROXY — true или false' })
    .default('false')
    .transform((value) => value === 'true'),
  /** Каталог файлов (договоры): локальный том; на сервере — смонтированный том (Q-63). */
  FILES_DIR: z.string().min(1).default('./data/files'),
  /** Предел размера загружаемого файла, байт. */
  FILE_MAX_BYTES: z.coerce.number().int().min(1024).max(52_428_800).default(10_485_760),
  /** Версия сборки для `/healthz` и `/readyz`: тег образа; проверка после деплоя сверяет её. */
  APP_VERSION: z.string().min(1).optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Неверная конфигурация сервера:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Читает и проверяет переменные окружения. Ничего не подставляет молча: ошибка называет переменную. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  // Ссылки приглашений и проверка Origin на рабочем сервере не могут указывать на 127.0.0.1.
  if (parsed.data.NODE_ENV === 'production' && (!env.PUBLIC_URL || !env.GATE_URL)) {
    throw new ConfigError([
      'PUBLIC_URL и GATE_URL обязательны при NODE_ENV=production: адреса веба и поста, как их видит пользователь',
    ]);
  }
  return parsed.data;
}

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
  /** Адрес приложения поста: в QR привязки устройства. */
  GATE_URL: z.url('GATE_URL — адрес приложения поста').default('http://127.0.0.1:5174'),
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

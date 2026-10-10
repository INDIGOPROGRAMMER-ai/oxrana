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
  return parsed.data;
}

import type { LoggerOptions } from 'pino';

/**
 * Поля, в которых бывают персональные данные. Их значения в логах заменяются (CLAUDE.md: ПДн не
 * пишутся в логи). Модули, вводящие новые ПДн-поля, дописывают их сюда.
 */
export const PII_FIELDS = ['password', 'phone', 'email', 'fullName', 'passport', 'token'] as const;

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...PII_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[скрыто]' },
  };
}

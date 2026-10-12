import type { LoggerOptions } from 'pino';

/**
 * Поля, в которых бывают персональные данные. Их значения в логах заменяются (CLAUDE.md: ПДн не
 * пишутся в логи). Модули, вводящие новые ПДн-поля, дописывают их сюда.
 */
export const PII_FIELDS = [
  'password',
  'phone',
  'email',
  'fullName',
  'passport',
  'token',
  // этап 4: пропуска и пост
  'personName',
  'driverName',
  'driverPhone',
  'escortPhone',
  'responsiblePhone',
  'emergencyPhone',
  'plate',
  'plateRaw',
  'plateNorm',
  'plateQuery',
  'personQuery',
] as const;

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...PII_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
];

/**
 * Адрес запроса в логе — без строки запроса: в ней бывают номер или фамилия из поиска
 * (`/sites/…/passes?q=А123`).
 */
export function withoutQuery(url: string): string {
  const index = url.indexOf('?');
  return index < 0 ? url : `${url.slice(0, index)}?…`;
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[скрыто]' },
    serializers: {
      req: (req: { method?: string; url?: string; id?: string }) => ({
        method: req.method,
        url: req.url ? withoutQuery(req.url) : req.url,
        id: req.id,
      }),
    },
  };
}

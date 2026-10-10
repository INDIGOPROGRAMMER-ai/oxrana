import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from './errors';

const StatusSchema = z.object({ status: z.literal('ok'), version: z.string() });

export interface HealthOptions {
  version: string;
  /** Проверка зависимостей (БД). Бросает исключение, если сервис не готов принимать запросы. */
  readiness: () => Promise<void>;
}

/** `/healthz` — процесс жив (без обращения к БД); `/readyz` — готов работать (БД отвечает). Оба открыты. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/healthz',
    {
      config: { public: true },
      schema: { tags: ['system'], summary: 'Процесс жив', response: { 200: StatusSchema } },
    },
    async () => ({ status: 'ok' as const, version: options.version }),
  );

  typed.get(
    '/readyz',
    {
      config: { public: true },
      schema: {
        tags: ['system'],
        summary: 'Сервис готов (БД отвечает)',
        response: { 200: StatusSchema },
      },
    },
    async (request) => {
      try {
        await options.readiness();
      } catch (error) {
        request.log.error({ err: error }, 'Проверка готовности не прошла');
        throw new AppError('unavailable', {
          message:
            'Нет связи с базой данных. Повторите через минуту; если не проходит — сообщите администратору.',
        });
      }
      return { status: 'ok' as const, version: options.version };
    },
  );
}

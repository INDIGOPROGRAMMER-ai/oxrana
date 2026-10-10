import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { registerErrorHandling } from './error-handler';
import { registerHealthRoutes } from './health';
import { useRussianZodMessages } from './i18n';
import { type PermissionGuardOptions, registerPermissionGuard } from './permission-guard';

export interface AppOptions extends PermissionGuardOptions {
  logger?: FastifyServerOptions['logger'];
  version?: string;
  /** Проверка зависимостей для `/readyz`. По умолчанию — «всё готово» (юнит-тесты без БД). */
  readiness?: () => Promise<void>;
  /** Отдавать `/openapi.json`. В проде выключено. */
  exposeOpenApi?: boolean;
}

/**
 * Собирает приложение Fastify. Возвращает экземпляр до `ready()`: вызывающий может добавить маршруты,
 * а проверка прав сработает при `ready()` — маршрут без права не стартует.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  useRussianZodMessages();

  const app = Fastify({
    logger: options.logger ?? false,
    // Идентификатор запроса попадает в тело ошибки и в логи; присланный клиентом x-request-id сохраняется.
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Платформа пропускного режима — API', version: options.version ?? '0.0.0' },
    },
    transform: jsonSchemaTransform,
  });

  registerErrorHandling(app);
  registerPermissionGuard(app, {
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.resolveActor ? { resolveActor: options.resolveActor } : {}),
  });

  registerHealthRoutes(app, {
    version: options.version ?? '0.0.0',
    readiness: options.readiness ?? (async () => {}),
  });

  if (options.exposeOpenApi ?? true) {
    app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () =>
      app.swagger(),
    );
  }

  return app;
}

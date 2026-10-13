import swagger from '@fastify/swagger';
import type { Db } from '@oxrana/db';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { sessionCookie } from './auth/cookies';
import { registerCsrfGuard } from './auth/csrf';
import { type AuthMessenger, type MessengerLog, StubMessenger } from './auth/messenger';
import { createActorResolver } from './auth/resolve';
import { type Clock, systemClock } from './clock';
import type { AppDeps, ServiceHooks } from './core/context';
import { RuleSetCache } from './core/ruleset-cache';
import { registerErrorHandling } from './error-handler';
import { type FileStore, LocalFileStore } from './files/store';
import { registerHealthRoutes } from './health';
import { registerModules } from './modules';
import { type PermissionGuardOptions, registerPermissionGuard } from './permission-guard';
import { EventHub } from './realtime/hub';

/** Зависимости бизнес-модулей. Без них приложение поднимает только health (юнит-тесты каркаса). */
export interface AppServices {
  db: Db;
  clock?: Clock;
  hub?: EventHub;
  hooks?: ServiceHooks;
  /** Доставка приглашений и кодов; по умолчанию — заглушка до этапа уведомлений. */
  messenger?: AuthMessenger;
  /** Адрес веб-кабинета (ссылки, Origin); по умолчанию — dev-адрес. */
  publicUrl?: string;
  /** Адрес приложения поста (QR привязки). */
  gateUrl?: string;
  /** Хранилище файлов; по умолчанию — локальный каталог `./data/files`. */
  files?: FileStore;
  /** Предел размера загружаемого файла, байт. */
  fileMaxBytes?: number;
}

export const DEFAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DEV_PUBLIC_URL = 'http://127.0.0.1:5173';
const DEV_GATE_URL = 'http://127.0.0.1:5174';

export interface AppOptions extends PermissionGuardOptions {
  logger?: FastifyServerOptions['logger'];
  version?: string;
  /** За обратным прокси (Caddy): IP клиента берётся из `X-Forwarded-For`. */
  trustProxy?: boolean;
  /** Проверка зависимостей для `/readyz`. По умолчанию — «всё готово» (юнит-тесты без БД). */
  readiness?: () => Promise<void>;
  /** Отдавать `/openapi.json`. В проде выключено. */
  exposeOpenApi?: boolean;
  services?: AppServices;
}

/** Собирает зависимости сервисов: часы, кэш правил, хаб событий. */
export function createDeps(services: AppServices, log: MessengerLog | null = null): AppDeps {
  const clock = services.clock ?? systemClock;
  const publicUrl = services.publicUrl ?? DEV_PUBLIC_URL;
  return {
    auth: {
      publicUrl,
      gateUrl: services.gateUrl ?? DEV_GATE_URL,
      secureCookies: publicUrl.startsWith('https:'),
      messenger: services.messenger ?? new StubMessenger(log),
    },
    db: services.db,
    clock,
    hub: services.hub ?? new EventHub(),
    ruleSets: new RuleSetCache(clock),
    hooks: services.hooks ?? {},
    files: services.files ?? new LocalFileStore('./data/files'),
    fileMaxBytes: services.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES,
  };
}

/**
 * Собирает приложение Fastify. Возвращает экземпляр до `ready()`: вызывающий может добавить маршруты,
 * а проверка прав сработает при `ready()` — маршрут без права не стартует.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
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
  // CSRF — до определения актора: подделанный запрос не доходит даже до чтения сессии (ADR-018).
  registerCsrfGuard(app, [
    options.services?.publicUrl ?? DEV_PUBLIC_URL,
    options.services?.gateUrl ?? DEV_GATE_URL,
  ]);
  const deps = options.services ? createDeps(options.services, app.log) : null;
  app.decorateRequest('refreshedSessionToken', null);
  app.addHook('onSend', async (request, reply) => {
    // Скользящий срок сессии: продлённая на сервере сессия продлевает и cookie.
    if (request.refreshedSessionToken && deps && !reply.hasHeader('set-cookie')) {
      reply.header(
        'set-cookie',
        sessionCookie(request.refreshedSessionToken, deps.auth.secureCookies),
      );
    }
  });
  const resolveActor =
    options.resolveActor ?? (deps ? createActorResolver(deps.db, deps.clock) : undefined);
  registerPermissionGuard(app, {
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(resolveActor ? { resolveActor } : {}),
  });

  registerHealthRoutes(app, {
    version: options.version ?? '0.0.0',
    readiness: options.readiness ?? (async () => {}),
  });

  if (deps) {
    // Файл договора приходит телом запроса как есть (PDF или изображение): без multipart-зависимости.
    app.addContentTypeParser(
      ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
      { parseAs: 'buffer', bodyLimit: deps.fileMaxBytes },
      (_request, body, done) => done(null, body),
    );
    app.decorate('deps', deps);
    registerModules(app);
  }

  if (options.exposeOpenApi ?? true) {
    app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () =>
      app.swagger(),
    );
  }

  return app;
}

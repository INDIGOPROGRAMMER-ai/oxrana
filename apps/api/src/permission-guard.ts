import { PERMISSIONS } from '@oxrana/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors';

/** Кто делает запрос. Настоящая модель (пользователь, роли, область) — этап 5; хуку нужно лишь «есть ли право». */
export interface Actor {
  readonly id: string;
  readonly permissions: ReadonlySet<string>;
}

export type ActorResolver = (request: FastifyRequest) => Actor | null | Promise<Actor | null>;

export interface PermissionGuardOptions {
  /** Реестр известных прав. По умолчанию — `PERMISSIONS` из `@oxrana/contracts`. */
  permissions?: readonly string[];
  /** Определяет актора по запросу. По умолчанию никого не определяет: все закрытые маршруты отвечают 401. */
  resolveActor?: ActorResolver;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Право, нужное для маршрута (ADR-007). Обязательно, если маршрут не `public`. */
    permission?: string;
    /** Маршрут открыт без входа (health, публичная страница водителя). */
    public?: boolean;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/** Куда вести человека, чтобы выдать недостающее право (путь экрана веб-интерфейса). */
export const ROLES_SETTING_LINK = '/admin/roles';

/**
 * Единственное место проверки прав (ADR-007).
 *  - при регистрации: маршрут без `config.permission` и без `public: true` не стартует;
 *  - на каждом запросе: `onRequest` пропускает публичные, а остальным требует актора с правом.
 * Вызывать на корневом экземпляре до регистрации маршрутов — хуки наследуются вложенными плагинами.
 */
export function registerPermissionGuard(
  app: FastifyInstance,
  options: PermissionGuardOptions = {},
): void {
  const known = new Set<string>(options.permissions ?? PERMISSIONS);
  const resolveActor: ActorResolver = options.resolveActor ?? (() => null);

  app.decorateRequest('actor', null);

  app.addHook('onRoute', (route) => {
    const { permission, public: isPublic } = route.config ?? {};
    const where = `${Array.isArray(route.method) ? route.method.join(',') : route.method} ${route.url}`;

    if (isPublic === true && permission !== undefined) {
      throw new Error(
        `Маршрут ${where} объявлен и public: true, и config.permission — оставьте что-то одно.`,
      );
    }
    if (isPublic === true) return;
    if (permission === undefined || permission === '') {
      throw new Error(
        `Маршрут ${where} не объявляет config.permission и не помечен public: true. ` +
          'Укажите нужное право (ADR-007) — без него сервер не стартует.',
      );
    }
    if (!known.has(permission)) {
      throw new Error(
        `Маршрут ${where} требует неизвестное право «${permission}». Добавьте его в PERMISSIONS (packages/contracts/src/permissions.ts).`,
      );
    }
  });

  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const { permission, public: isPublic } = request.routeOptions.config;
    if (isPublic === true) return;

    const actor = await resolveActor(request);
    if (!actor) throw new AppError('unauthenticated');
    // permission заведомо задан: иначе маршрут не прошёл бы проверку при регистрации
    if (permission === undefined || !actor.permissions.has(permission)) {
      throw new AppError('forbidden', {
        permission: permission ?? '',
        settingLink: ROLES_SETTING_LINK,
        message: `Недостаточно прав: нужно право «${permission ?? ''}». Выдать его можно в разделе «Роли».`,
      });
    }
    request.actor = actor;
  });
}

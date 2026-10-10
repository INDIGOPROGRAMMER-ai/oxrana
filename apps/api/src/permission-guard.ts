import { PERMISSIONS } from '@oxrana/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from './actor';
import { AppError } from './errors';

export type { Actor } from './actor';

export type ActorResolver = (request: FastifyRequest) => Actor | null | Promise<Actor | null>;

export interface PermissionGuardOptions {
  /** Реестр известных прав. По умолчанию — `PERMISSIONS` из `@oxrana/contracts`. */
  permissions?: readonly string[];
  /** Определяет актора по запросу. По умолчанию никого не определяет: все закрытые маршруты отвечают 401. */
  resolveActor?: ActorResolver;
}

/** Право маршрута: одно или «любое из» (ADR-017): уточнение по телу запроса — в сервисе. */
export type RoutePermission = string | readonly string[];

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Право, нужное для маршрута (ADR-007); список — достаточно любого из них (ADR-017). */
    permission?: RoutePermission;
    /** Маршрут открыт без входа (health, публичная страница водителя). */
    public?: boolean;
    /**
     * Нужен вход, но не отдельное право (ADR-017): чтение справочников объекта (КПП, зоны, типы,
     * пояса) и свои настройки. Сервис всё равно ограничивает ответ областью актора. Только GET.
     */
    authenticated?: boolean;
  }
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/** Куда вести человека, чтобы выдать недостающее право (путь экрана веб-интерфейса). */
export const ROLES_SETTING_LINK = '/admin/roles';

export function permissionList(permission: RoutePermission | undefined): readonly string[] {
  if (permission === undefined) return [];
  return typeof permission === 'string' ? [permission] : permission;
}

/** Текст отказа: какое право нужно и где его выдать. */
export function forbiddenFor(permissions: readonly string[]): AppError {
  const quoted = permissions.map((p) => `«${p}»`);
  return new AppError('forbidden', {
    permission: permissions.join(' | '),
    settingLink: ROLES_SETTING_LINK,
    message:
      quoted.length === 1
        ? `Недостаточно прав: нужно право ${quoted[0]}. Выдать его можно в разделе «Роли».`
        : `Недостаточно прав: нужно одно из прав ${quoted.join(', ')}. Выдать их можно в разделе «Роли».`,
  });
}

/**
 * Единственное место проверки прав маршрута (ADR-007):
 *  - при регистрации: маршрут без `config.permission`, `public: true` или `authenticated: true`
 *    не стартует; `authenticated` — только для чтения (GET);
 *  - на каждом запросе: `onRequest` пропускает публичные, остальным нужен актор, а маршрутам с
 *    правом — актор с этим правом (или любым из списка).
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
    const { permission, public: isPublic, authenticated } = route.config ?? {};
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const where = `${methods.join(',')} ${route.url}`;
    const list = permissionList(permission);
    const modes = [isPublic === true, authenticated === true, list.length > 0].filter(Boolean);

    if (modes.length > 1) {
      throw new Error(
        `Маршрут ${where} объявляет сразу несколько режимов доступа (public, authenticated, permission) — оставьте один.`,
      );
    }
    if (isPublic === true) return;
    if (authenticated === true) {
      if (methods.some((m) => m !== 'GET' && m !== 'HEAD')) {
        throw new Error(
          `Маршрут ${where}: authenticated: true допустим только для чтения (GET). Изменения требуют права (ADR-007).`,
        );
      }
      return;
    }
    if (list.length === 0 || list.some((p) => p === '')) {
      throw new Error(
        `Маршрут ${where} не объявляет config.permission и не помечен public: true. ` +
          'Укажите нужное право (ADR-007) — без него сервер не стартует.',
      );
    }
    for (const p of list) {
      if (!known.has(p)) {
        throw new Error(
          `Маршрут ${where} требует неизвестное право «${p}». Добавьте его в PERMISSIONS (packages/contracts/src/permissions.ts).`,
        );
      }
    }
  });

  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const { permission, public: isPublic, authenticated } = request.routeOptions.config;
    if (isPublic === true) return;

    const actor = await resolveActor(request);
    if (!actor) throw new AppError('unauthenticated');
    if (authenticated !== true) {
      // список заведомо не пуст: иначе маршрут не прошёл бы проверку при регистрации
      const list = permissionList(permission);
      if (!list.some((p) => actor.permissions.has(p))) throw forbiddenFor(list);
    }
    request.actor = actor;
  });
}

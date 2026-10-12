import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { parseCookies, SESSION_COOKIE } from './cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Защита от CSRF (ADR-018) для изменяющих запросов. Cookie сессии — SameSite=Lax; поверх этого
 * проверяется Origin: браузер всегда присылает его с POST/PATCH/DELETE, и чужой сайт подделать его
 * не может. Разрешены адрес веба, адрес поста и тот же хост, на который пришёл запрос.
 *  - Origin есть — он должен быть разрешённым (в том числе для входа: защита от подмены сессии);
 *  - Origin нет, но есть cookie сессии — нужен разрешённый Referer;
 *  - нет ни Origin, ни cookie — запрос не из браузера (устройство с токеном, агент КПП) — пропускаем.
 */
export function registerCsrfGuard(app: FastifyInstance, allowed: readonly string[]): void {
  const origins = new Set(allowed.map((o) => originOf(o)).filter((o): o is string => o !== null));

  const isAllowed = (request: FastifyRequest, origin: string | null): boolean => {
    if (!origin) return false;
    if (origins.has(origin)) return true;
    const host = request.headers.host;
    return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
  };

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isAllowed(request, originOf(origin))) throw new AppError('csrf_failed');
      return;
    }
    if (parseCookies(request.headers.cookie)[SESSION_COOKIE] === undefined) return;
    if (!isAllowed(request, originOf(request.headers.referer))) throw new AppError('csrf_failed');
  });
}

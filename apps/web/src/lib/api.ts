import type { ErrorBody, Me } from '@oxrana/contracts';

/**
 * Запросы к API: тот же адрес, что у веба (`/api` проксирует Vite в разработке и Caddy на сервере),
 * cookie сессии — httpOnly, JS её не видит. Ошибка API — `ApiError` с кодом, текстом и полем.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Partial<ErrorBody>;
  constructor(status: number, body: Partial<ErrorBody>) {
    super(body.message ?? `Ошибка ${status}. Повторите или сообщите администратору.`);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, { message: 'Нет связи с сервером. Проверьте сеть и повторите.' });
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ApiError(res.status, data as Partial<ErrorBody>);
  return data as T;
}

/** «Кто я»; не вошёл — `null`. */
export async function loadMe(): Promise<Me | null> {
  try {
    return await api<Me>('/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Токен из ссылки: после `#`, он не уходит на сервер и не остаётся в журналах. */
export function tokenFromHash(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, ''));
}

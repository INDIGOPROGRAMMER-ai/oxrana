import type { ErrorBody } from '@oxrana/contracts';

/** Запросы поста к API (`/api` на том же адресе); вход — токеном устройства в заголовке. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Partial<ErrorBody>;
  constructor(status: number, body: Partial<ErrorBody>) {
    super(body.message ?? `Ошибка ${status}.`);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'omit',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, { message: 'Нет связи с сервером.' });
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ApiError(res.status, data as Partial<ErrorBody>);
  return data as T;
}

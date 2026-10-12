import type { Me } from '@oxrana/contracts';
import { ApiError, api } from '@oxrana/ui';

export { ApiError, api };

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

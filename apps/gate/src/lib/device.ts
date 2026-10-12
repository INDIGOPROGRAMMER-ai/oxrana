/**
 * Токен устройства поста (ADR-007): хранится в IndexedDB устройства, на сервере — только хэш.
 * Пост сам не разлогинивается: токен живёт до отзыва в админке. Офлайн-снимок (Dexie) — этап 9.
 */
const DB_NAME = 'oxrana-gate';
const STORE = 'device';
const KEY = 'token';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = fn(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadToken(): Promise<string | null> {
  const value = await run<unknown>('readonly', (s) => s.get(KEY));
  return typeof value === 'string' ? value : null;
}

export function saveToken(token: string): Promise<IDBValidKey> {
  return run('readwrite', (s) => s.put(token, KEY));
}

export function forgetToken(): Promise<undefined> {
  return run('readwrite', (s) => s.delete(KEY));
}

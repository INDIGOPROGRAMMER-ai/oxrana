import pg from 'pg';

export type DbPool = pg.Pool;

export interface PoolOptions {
  connectionString: string;
  /** Максимум соединений в пуле. */
  max?: number;
  /** Имя в `pg_stat_activity` — чтобы видеть, кто держит соединение. */
  applicationName?: string;
}

/**
 * Пул соединений PostgreSQL. Ошибка простаивающего соединения (рестарт сервера БД) не должна
 * ронять процесс, поэтому обработчик `error` обязателен.
 */
export function createPool(options: PoolOptions): DbPool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'oxrana',
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (error) => {
    console.error('Ошибка простаивающего соединения с БД:', error.message);
  });
  return pool;
}

/** Проверка связи с БД: бросает исключение, если запрос не прошёл. */
export async function pingDb(pool: DbPool): Promise<void> {
  await pool.query('select 1');
}

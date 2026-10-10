import pg from 'pg';

/**
 * Тестовые базы (ADR-003 п. 6, ADR-010 п. 3): шаблон `oxrana_test_template` с миграциями и копия
 * шаблона на каждый тестовый файл воркера Vitest — `oxrana_test_w<N>`.
 */
export const TEMPLATE_DB = 'oxrana_test_template';
export const WORKER_DB_PREFIX = 'oxrana_test_w';

/** Тот же сервер и пользователь, другая база. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Выполняет служебные команды (`create/drop database`) через отдельное соединение к базе из `url`
 * (это `oxrana`: удаляемая или копируемая база не должна быть занята этим соединением).
 */
export async function maintenance(url: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'oxrana-test-setup' });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/** `create database … template …` с повтором: шаблон может быть занят параллельной копией. */
export async function cloneTemplate(url: string, database: string): Promise<void> {
  const statements = [
    `drop database if exists ${quoteIdent(database)} with (force)`,
    `create database ${quoteIdent(database)} template ${quoteIdent(TEMPLATE_DB)}`,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      await maintenance(url, statements);
      return;
    } catch (error) {
      const busy = error instanceof Error && /is being accessed by other users/.test(error.message);
      if (!busy || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Недопустимое имя базы: ${name}`);
  return `"${name}"`;
}

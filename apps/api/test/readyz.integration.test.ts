import { createPool, pingDb } from '@oxrana/db';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const url = process.env.DATABASE_URL ?? '';
const pool = createPool({ connectionString: url, max: 2 });
afterAll(() => pool.end());

describe('/readyz на реальной БД', () => {
  it('отвечает 200, когда база доступна под ролью приложения', async () => {
    const app = await buildApp({ readiness: () => pingDb(pool) });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('отвечает 503, когда база недоступна', async () => {
    const dead = createPool({
      connectionString: 'postgres://oxrana_app:x@127.0.0.1:1/none',
      max: 1,
    });
    const app = await buildApp({ readiness: () => pingDb(dead) });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    await app.close();
    await dead.end();
  });
});

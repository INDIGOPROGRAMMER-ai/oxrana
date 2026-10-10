import { ErrorBodySchema } from '@oxrana/contracts';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

describe('/healthz и /readyz', () => {
  it('/healthz отвечает 200 без входа и без обращения к БД', async () => {
    const app = await buildApp({
      version: '1.2.3',
      readiness: async () => {
        throw new Error('БД не должна вызываться');
      },
    });
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '1.2.3' });
    await app.close();
  });

  it('/readyz: 200, когда зависимости отвечают', async () => {
    const app = await buildApp({ readiness: async () => {} });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('/readyz: 503 unavailable, когда БД не отвечает', async () => {
    const app = await buildApp({
      readiness: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(503);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.code).toBe('unavailable');
    expect(res.body).not.toContain('ECONNREFUSED');
    await app.close();
  });
});

describe('OpenAPI', () => {
  it('/openapi.json описывает маршруты из схем', async () => {
    const app = await buildApp({ version: '1.2.3' });
    const res = await app.inject('/openapi.json');
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.version).toBe('1.2.3');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/healthz', '/readyz']));
    expect(Object.keys(spec.paths)).not.toContain('/openapi.json');
    await app.close();
  });

  it('в проде /openapi.json не отдаётся', async () => {
    const app = await buildApp({ exposeOpenApi: false });
    const res = await app.inject('/openapi.json');
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

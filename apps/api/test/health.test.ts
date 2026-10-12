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

describe('IP клиента за обратным прокси (ADR-019)', () => {
  const ipOf = async (trustProxy: boolean) => {
    const app = await buildApp({ trustProxy });
    app.get('/ip', { config: { public: true } }, async (request) => ({ ip: request.ip }));
    await app.ready();
    const res = await app.inject({
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      remoteAddress: '172.18.0.2',
    });
    await app.close();
    return res.json().ip;
  };

  it('за Caddy (TRUST_PROXY=true) берётся адрес из X-Forwarded-For — по нему считается ограничение входа', async () => {
    expect(await ipOf(true)).toBe('203.0.113.7');
  });

  it('по умолчанию заголовок не доверяется: клиент не подделает свой IP', async () => {
    expect(await ipOf(false)).toBe('172.18.0.2');
  });
});

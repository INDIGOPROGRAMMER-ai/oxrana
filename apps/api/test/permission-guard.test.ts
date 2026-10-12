import { ErrorBodySchema } from '@oxrana/contracts';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Actor } from '../src/permission-guard';
import { testActor } from './support/actor';

const REGISTRY = ['report.view', 'pass.edit'] as const;

const viewer: Actor = testActor({ id: 'u1', permissions: new Set(['report.view']) });
const nobody: Actor = testActor({ id: 'u2' });
const editor: Actor = testActor({ id: 'u3', permissions: new Set(['pass.edit']) });

/** Собирает приложение с тестовым реестром прав; актор берётся из заголовка x-actor. */
async function startApp(register: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const actors: Record<string, Actor> = { viewer, nobody, editor };
  const app = await buildApp({
    permissions: REGISTRY,
    resolveActor: (request) => actors[String(request.headers['x-actor'])] ?? null,
  });
  register(app);
  await app.ready();
  return app;
}

describe('хук прав: регистрация маршрутов', () => {
  it('маршрут без config.permission не стартует', async () => {
    await expect(startApp((app) => app.get('/x', async () => ({ ok: true })))).rejects.toThrow(
      /GET \/x не объявляет config\.permission и не помечен public: true/,
    );
  });

  it('маршрут с пустой config не стартует', async () => {
    await expect(
      startApp((app) => app.post('/y', { config: {} }, async () => ({ ok: true }))),
    ).rejects.toThrow(/POST \/y не объявляет config\.permission/);
  });

  it('маршрут с пустой строкой вместо права не стартует', async () => {
    await expect(
      startApp((app) => app.get('/z', { config: { permission: '' } }, async () => ({ ok: true }))),
    ).rejects.toThrow(/не объявляет config\.permission/);
  });

  it('неизвестное право не стартует', async () => {
    await expect(
      startApp((app) =>
        app.get('/w', { config: { permission: 'nope.nope' } }, async () => ({ ok: true })),
      ),
    ).rejects.toThrow(/неизвестное право «nope\.nope»/);
  });

  it('public: true вместе с permission не стартует', async () => {
    await expect(
      startApp((app) =>
        app.get('/v', { config: { public: true, permission: 'report.view' } }, async () => ({})),
      ),
    ).rejects.toThrow(/сразу несколько режимов доступа/);
  });

  it('authenticated: true вместе с permission не стартует', async () => {
    await expect(
      startApp((app) =>
        app.get(
          '/t',
          { config: { authenticated: true, permission: 'report.view' } },
          async () => ({}),
        ),
      ),
    ).rejects.toThrow(/сразу несколько режимов доступа/);
  });

  it('authenticated: true допустим только для чтения: POST с ним не стартует', async () => {
    await expect(
      startApp((app) => app.post('/s', { config: { authenticated: true } }, async () => ({}))),
    ).rejects.toThrow(/только для чтения \(GET\)/);
  });

  it('в списке прав пустая строка или неизвестное право не проходят', async () => {
    await expect(
      startApp((app) =>
        app.get('/r', { config: { permission: ['report.view', ''] } }, async () => ({})),
      ),
    ).rejects.toThrow(/не объявляет config\.permission/);
    await expect(
      startApp((app) =>
        app.get('/q', { config: { permission: ['report.view', 'nope.x'] } }, async () => ({})),
      ),
    ).rejects.toThrow(/неизвестное право «nope\.x»/);
  });

  it('public: false без права тоже не стартует', async () => {
    await expect(
      startApp((app) => app.get('/u', { config: { public: false } }, async () => ({}))),
    ).rejects.toThrow(/не объявляет config\.permission/);
  });

  it('все встроенные маршруты объявляют право или public, приложение по умолчанию стартует', async () => {
    const app = await buildApp();
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});

describe('хук прав: запросы', () => {
  async function appWithRoutes(): Promise<FastifyInstance> {
    return startApp((app) => {
      app.get('/open', { config: { public: true } }, async () => ({ ok: true }));
      app.get('/report', { config: { permission: 'report.view' } }, async (request) => ({
        actor: request.actor?.id,
      }));
      app.post('/pass', { config: { permission: 'pass.edit' } }, async () => ({ ok: true }));
      app.get('/either', { config: { permission: ['report.view', 'pass.edit'] } }, async () => ({
        ok: true,
      }));
      app.get('/catalog', { config: { authenticated: true } }, async () => ({ ok: true }));
    });
  }

  it('публичный маршрут открыт без входа', async () => {
    const app = await appWithRoutes();
    const res = await app.inject('/open');
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('без входа закрытый маршрут отвечает 401 unauthenticated', async () => {
    const app = await appWithRoutes();
    const res = await app.inject('/report');
    expect(res.statusCode).toBe(401);
    expect(ErrorBodySchema.parse(res.json()).code).toBe('unauthenticated');
    await app.close();
  });

  it('актор без права получает 403 forbidden с названием права и ссылкой на настройку', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/pass',
      headers: { 'x-actor': 'viewer' },
    });
    expect(res.statusCode).toBe(403);
    const body = ErrorBodySchema.parse(res.json());
    expect(body).toMatchObject({
      code: 'forbidden',
      permission: 'pass.edit',
      field: null,
      settingLink: '/admin/roles',
    });
    expect(body.message).toContain('pass.edit');
    await app.close();
  });

  it('актор вообще без прав получает 403 даже на безобидный маршрут', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ url: '/report', headers: { 'x-actor': 'nobody' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('актор с правом проходит и виден в обработчике', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ url: '/report', headers: { 'x-actor': 'viewer' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actor: 'u1' });
    await app.close();
  });

  it('403 приходит до разбора тела: чужой запрос не доходит до валидации', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/pass',
      headers: { 'x-actor': 'viewer', 'content-type': 'application/json' },
      payload: '{ не json',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('список прав: достаточно любого из них; без всех — 403 со списком', async () => {
    const app = await appWithRoutes();
    for (const who of ['viewer', 'editor']) {
      const res = await app.inject({ url: '/either', headers: { 'x-actor': who } });
      expect(res.statusCode, who).toBe(200);
    }
    const res = await app.inject({ url: '/either', headers: { 'x-actor': 'nobody' } });
    expect(res.statusCode).toBe(403);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.permission).toBe('report.view | pass.edit');
    expect(body.message).toContain('одно из прав');
    await app.close();
  });

  it('authenticated: нужен вход, но не право', async () => {
    const app = await appWithRoutes();
    expect((await app.inject('/catalog')).statusCode).toBe(401);
    const res = await app.inject({ url: '/catalog', headers: { 'x-actor': 'nobody' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

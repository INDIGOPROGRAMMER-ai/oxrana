import { ErrorBodySchema } from '@oxrana/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { AppError } from '../src/errors';

async function startApp(): Promise<FastifyInstance> {
  const app = await buildApp({ permissions: ['pass.edit'] });
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/echo',
    {
      config: { public: true },
      schema: { body: z.object({ plate: z.string().min(3), count: z.number().int() }) },
    },
    async (request) => request.body,
  );
  app.get('/app-error', { config: { public: true } }, async () => {
    throw new AppError('not_found', {
      message: 'Пропуск не найден. Проверьте номер или создайте пропуск.',
      field: 'plate',
      settingLink: '/t/passes',
    });
  });
  app.get('/boom', { config: { public: true } }, async () => {
    throw new Error('секретная подробность: пароль к БД hunter2');
  });
  await app.ready();
  return app;
}

describe('формат ошибок {code, message, field, settingLink, requestId}', () => {
  it('AppError: код, текст, поле и ссылка доходят до клиента', async () => {
    const app = await startApp();
    const res = await app.inject('/app-error');
    expect(res.statusCode).toBe(404);
    expect(ErrorBodySchema.parse(res.json())).toMatchObject({
      code: 'not_found',
      message: 'Пропуск не найден. Проверьте номер или создайте пропуск.',
      field: 'plate',
      settingLink: '/t/passes',
    });
    await app.close();
  });

  it('несуществующий адрес: 404 в том же формате', async () => {
    const app = await startApp();
    const res = await app.inject('/nope');
    expect(res.statusCode).toBe(404);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.code).toBe('not_found');
    expect(body.field).toBeNull();
    expect(body.settingLink).toBeNull();
    await app.close();
  });

  it('ошибка валидации: 400, поле названо, текст по-русски', async () => {
    const app = await startApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { plate: 'аб', count: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.code).toBe('validation_failed');
    expect(body.field).toBe('plate');
    expect(body.message).toContain('«plate»');
    expect(body.message).toMatch(/[А-Яа-яЁё]{4,}/);
    await app.close();
  });

  it('валидный запрос проходит', async () => {
    const app = await startApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { plate: 'А123ВС', count: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plate: 'А123ВС', count: 2 });
    await app.close();
  });

  it('битый JSON: 400 bad_request, а не 500', async () => {
    const app = await startApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ не json',
    });
    expect(res.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(res.json()).code).toBe('bad_request');
    await app.close();
  });

  it('непредвиденная ошибка: 500 internal без подробностей, с requestId', async () => {
    const app = await startApp();
    const res = await app.inject({ url: '/boom', headers: { 'x-request-id': 'req-42' } });
    expect(res.statusCode).toBe(500);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.code).toBe('internal');
    expect(body.requestId).toBe('req-42');
    expect(res.headers['x-request-id']).toBe('req-42');
    expect(res.body).not.toContain('hunter2');
    await app.close();
  });

  it('requestId выдаётся сервером, если клиент его не прислал', async () => {
    const app = await startApp();
    const res = await app.inject('/nope');
    expect(ErrorBodySchema.parse(res.json()).requestId).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});

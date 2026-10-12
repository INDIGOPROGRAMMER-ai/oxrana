import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  customActor,
  KEYS,
  roleActor,
  seedDemo,
  startTestApp,
  TEST_ORIGIN,
  type TestApp,
} from './support/harness';

/**
 * Открытые потоки SSE человека закрываются сразу, как только его сессия отозвана (ADR-018 п. 2, 4):
 * «выйти на всех устройствах», выход, завершение одной сессии, смена пароля и отключение
 * пользователя — как поток отозванного устройства. Настоящий HTTP-сервер: поток читается fetch'ем.
 */
let t: TestApp;
let base = '';

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  base = await t.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await t.close();
});

interface OpenStream {
  /** Пришло `event: revoked` и поток завершился. */
  closed: Promise<string>;
  close(): void;
}

/** Открывает поток событий объекта; `closed` разрешается текстом потока, когда сервер его закрыл. */
async function open(headers: Record<string, string>): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`${base}/sites/${KEYS.siteId}/events`, {
    headers,
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('нет потока');
  const decoder = new TextDecoder();
  const closed = (async () => {
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { closed, close: () => controller.abort() };
}

/** Поток закрыт сервером в течение секунды и сказал почему; иначе — тест падает. */
async function expectClosedByServer(stream: OpenStream): Promise<void> {
  const text = await Promise.race([
    stream.closed,
    new Promise<string>((resolve) => setTimeout(() => resolve('__open__'), 1_000)),
  ]);
  stream.close();
  expect(text).not.toBe('__open__');
  expect(text).toContain('event: revoked');
  expect(text).toContain('session_revoked');
}

async function stillOpen(stream: OpenStream): Promise<boolean> {
  const text = await Promise.race([
    stream.closed,
    new Promise<string>((resolve) => setTimeout(() => resolve('__open__'), 300)),
  ]);
  stream.close();
  return text === '__open__';
}

describe('потоки SSE закрываются при отзыве сессии', () => {
  it('«выйти на всех устройствах» закрывает поток сразу', async () => {
    const user = customActor(['occupancy.view'], { siteIds: [KEYS.siteId] });
    const headers = await t.headersFor(user);
    const stream = await open(headers);
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { ...headers, origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(204);
    await expectClosedByServer(stream);
  });

  it('отключение пользователя закрывает его потоки; чужой поток остаётся открытым', async () => {
    const victim = customActor(['occupancy.view', 'pass.view'], { siteIds: [KEYS.siteId] });
    const bystander = customActor(['occupancy.view', 'queue.view'], { siteIds: [KEYS.siteId] });
    const victimStream = await open(await t.headersFor(victim));
    const bystanderStream = await open(await t.headersFor(bystander));
    const res = await t.as(roleActor('org_owner'), {
      method: 'POST',
      url: `/users/${victim.id}/disable`,
      payload: { reason: 'Уволился' },
    });
    expect(res.statusCode).toBe(200);
    await expectClosedByServer(victimStream);
    expect(await stillOpen(bystanderStream)).toBe(true);
  });

  it('выход закрывает поток своей сессии', async () => {
    const user = customActor(['occupancy.view', 'pass.view', 'queue.view'], {
      siteIds: [KEYS.siteId],
    });
    const headers = await t.headersFor(user);
    const stream = await open(headers);
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...headers, origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(204);
    await expectClosedByServer(stream);
  });
});

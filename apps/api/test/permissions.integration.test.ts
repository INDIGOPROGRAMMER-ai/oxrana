import { randomUUID } from 'node:crypto';
import { ErrorBodySchema } from '@oxrana/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteAccess } from '../src/permission-guard';
import { ACTION_VARIANTS, concreteUrl, isStream, matrixActors } from './permissions.matrix';
import { seedDemo, startTestApp, type TestApp } from './support/harness';

let t: TestApp;
let routes: RouteAccess[];

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  routes = t.app.routeAccess.filter((r) => r.url !== '/openapi.json');
});
afterAll(() => t.close());

const key = (r: RouteAccess) => `${r.method} ${r.url}`;
const describeAccess = (r: RouteAccess) =>
  r.access === 'permission' ? r.permissions.join(' | ') : r.access;

describe('тест-матрица прав (ADR-007, B12)', () => {
  it('реестр маршрутов этапа: метод, путь, доступ', () => {
    const table = [...routes]
      .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
      .map((r) => `${key(r)} → ${describeAccess(r)}`);
    expect(table).toMatchSnapshot();
    expect(routes.length).toBeGreaterThan(80);
  });

  it('без входа каждый закрытый маршрут отвечает 401 unauthenticated', async () => {
    for (const route of routes.filter((r) => r.access !== 'public')) {
      const res = await t.as(null, {
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      expect(res.statusCode, key(route)).toBe(401);
      expect(ErrorBodySchema.parse(res.json()).code, key(route)).toBe('unauthenticated');
    }
  });

  it('каждый маршрут × каждая роль-шаблон: есть право — пропускает, нет — 403 с названием права', async () => {
    const failures: string[] = [];
    for (const { role, actor } of matrixActors()) {
      for (const route of routes) {
        const allowed =
          route.access !== 'permission' || route.permissions.some((p) => actor.permissions.has(p));
        if (allowed && isStream(route.url)) continue;
        const res = await t.as(actor, {
          method: route.method as 'GET',
          url: concreteUrl(route.url),
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
        });
        const body = res.statusCode >= 400 ? ErrorBodySchema.safeParse(res.json()) : null;
        const guardDenied =
          res.statusCode === 403 &&
          body?.success === true &&
          body.data.permission === route.permissions.join(' | ');
        if (allowed && (res.statusCode === 401 || guardDenied)) {
          failures.push(`${role}: ${key(route)} — ожидался доступ, получено ${res.statusCode}`);
        }
        if (!allowed && !guardDenied) {
          failures.push(
            `${role}: ${key(route)} — ожидался 403 (${route.permissions.join(' | ')}), получено ${res.statusCode}`,
          );
        }
        if (res.statusCode >= 500)
          failures.push(`${role}: ${key(route)} — ошибка сервера ${res.statusCode}: ${res.body}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('действия поста: право своего вида, у каждой роли-шаблона', async () => {
    const failures: string[] = [];
    for (const { role, actor } of matrixActors()) {
      for (const variant of ACTION_VARIANTS) {
        const res = await t.as(actor, {
          method: 'POST',
          url: '/gate/actions',
          payload: { id: randomUUID(), type: variant.type, ...variant.body() },
        });
        const body = res.statusCode >= 400 ? ErrorBodySchema.safeParse(res.json()) : null;
        const permission = body?.success ? body.data.permission : undefined;
        const has = actor.permissions.has(variant.permission);
        const denied = res.statusCode === 403 && permission !== undefined;
        if (has && denied)
          failures.push(`${role}: ${variant.type} — отказ при наличии права (${permission})`);
        if (!has && !denied)
          failures.push(
            `${role}: ${variant.type} — нет права ${variant.permission}, получено ${res.statusCode}`,
          );
      }
    }
    expect(failures).toEqual([]);
  });

  it('администратор объекта не выполняет действий поста (A7), пост не правит пропуска (A11)', () => {
    const actors = Object.fromEntries(matrixActors().map((m) => [m.role, m.actor]));
    const siteAdmin = actors.site_admin;
    const post = actors.gate_post;
    for (const p of [
      'visit.check_in',
      'visit.check_out',
      'gate.refuse',
      'gate.redirect',
      'gate.undo',
      'gate.passage',
    ]) {
      expect(siteAdmin?.permissions.has(p), p).toBe(false);
    }
    expect(post?.permissions.has('pass.edit')).toBe(false);
  });
});

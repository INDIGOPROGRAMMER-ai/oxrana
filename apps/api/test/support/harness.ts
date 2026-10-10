import { type PermissionCode, ROLE_TEMPLATES, roleTemplate } from '@oxrana/contracts';
import { createDb, createPool, type Db, type DbPool, schema } from '@oxrana/db';
import { applySeed, DEMO_SEED, fixtureKeys, seedId } from '@oxrana/db/seed';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll } from 'vitest';
import type { Actor } from '../../src/actor';
import { buildApp } from '../../src/app';
import { FixedClock } from '../../src/clock';
import type { ServiceHooks } from '../../src/core/context';
import { EventHub } from '../../src/realtime/hub';

/**
 * Обвязка интеграционных тестов API: приложение на копии тестовой базы (ADR-014 п. 7) под ролью
 * приложения (RLS действует), демо-сид — под владельцем, фиктивные акторы (до этапа 5) — по
 * заголовку `x-test-actor`. Время — фиксированные часы: вторник 10.03.2026 12:00 по объекту.
 */
export const KEYS = fixtureKeys(DEMO_SEED);
/** 10.03.2026 12:00 Asia/Yekaterinburg (UTC+5). */
export const NOON = '2026-03-10T07:00:00.000Z';

const pools: DbPool[] = [];
afterAll(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана ${name}: интеграционным тестам нужна БД (pnpm db:up).`);
  return value;
}

export function appPool(max = 10): DbPool {
  const pool = createPool({
    connectionString: env('DATABASE_URL'),
    max,
    applicationName: 'oxrana-api-test',
  });
  pools.push(pool);
  return pool;
}

export function ownerDb(): Db {
  const pool = createPool({ connectionString: env('DATABASE_ADMIN_URL'), max: 2 });
  pools.push(pool);
  return createDb(pool);
}

let seeded: Promise<void> | undefined;
/** Демо-объект в базе этого тестового файла (один раз на файл). */
export function seedDemo(): Promise<void> {
  seeded ??= applySeed(ownerDb(), DEMO_SEED).then(() => ensureUsers());
  return seeded;
}

/** id пользователя-теста для шаблона роли; строка в `users` создаётся `ensureUsers` (ФИО и почта выдуманные). */
export function userIdFor(code: string): string {
  const index = ROLE_TEMPLATES.findIndex((t) => t.code === code);
  if (index < 0) throw new Error(`Нет шаблона роли ${code}`);
  return `00000000-0000-4000-8000-${String(0xb000 + index).padStart(12, '0')}`;
}

/** Пользователи-тесты для всех шаблонов: на них ссылаются `passes.created_by` и др. */
export async function ensureUsers(): Promise<void> {
  await ownerDb()
    .insert(schema.users)
    .values(
      ROLE_TEMPLATES.map((t) => ({
        id: userIdFor(t.code),
        fullName: `Тестовый ${t.code}`,
        email: `${t.code}@example.test`,
        status: 'active' as const,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Фиктивный актор-пользователь с правами шаблона роли и областью (ADR-007): шаблон «организация» —
 * вся организация, «объект» — демо-объект, «арендатор» — переданные арендаторы.
 */
export function roleActor(
  code: string,
  scope: { siteIds?: string[] | null; tenantIds?: string[] | null } = {},
): Actor {
  const template = roleTemplate(code);
  if (template.scope === 'gate') throw new Error('Учётку поста создаёт gateActor()');
  return {
    id: userIdFor(code),
    kind: 'user',
    organizationId: KEYS.organizationId,
    permissions: new Set<string>(template.permissions),
    siteIds:
      scope.siteIds !== undefined
        ? scope.siteIds
        : template.scope === 'organization'
          ? null
          : [KEYS.siteId],
    tenantIds: scope.tenantIds ?? (template.scope === 'tenant' ? [] : null),
    gateId: null,
    deviceId: null,
  };
}

/** Учётка КПП из сида (одна на КПП, A11) с правами шаблона «Пост КПП». */
export function gateActor(gateKey: string, code = 'gate_post'): Actor {
  const gateId = KEYS.gates[gateKey];
  if (!gateId) throw new Error(`Нет КПП ${gateKey}`);
  return {
    id: seedId(DEMO_SEED.organization.key, 'gate-account', gateKey),
    kind: 'gate_account',
    organizationId: KEYS.organizationId,
    permissions: new Set<string>(roleTemplate(code).permissions),
    siteIds: [KEYS.siteId],
    tenantIds: null,
    gateId,
    deviceId: null,
  };
}

/** Актор с произвольным набором прав (для отдельных проверок). */
export function customActor(
  permissions: readonly PermissionCode[],
  extra: Partial<Actor> = {},
): Actor {
  return {
    id: userIdFor('org_owner'),
    kind: 'user',
    organizationId: KEYS.organizationId,
    permissions: new Set<string>(permissions),
    siteIds: null,
    tenantIds: null,
    gateId: null,
    deviceId: null,
    ...extra,
  };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly clock: FixedClock;
  readonly hub: EventHub;
  readonly db: Db;
  /** Запрос от имени актора. */
  as(actor: Actor | null, options: InjectOptions): Promise<LightMyRequestResponse>;
  /** Заголовки для настоящего HTTP-запроса от имени актора (SSE через fetch). */
  headersFor(actor: Actor): Record<string, string>;
  close(): Promise<void>;
}

export async function startTestApp(
  options: { poolSize?: number; hooks?: ServiceHooks; now?: string } = {},
): Promise<TestApp> {
  const clock = new FixedClock(options.now ?? NOON);
  const hub = new EventHub();
  const db = createDb(appPool(options.poolSize ?? 10));
  const actors = new Map<string, Actor>();
  let counter = 0;
  const app = await buildApp({
    services: { db, clock, hub, ...(options.hooks ? { hooks: options.hooks } : {}) },
    resolveActor: (request) => actors.get(String(request.headers['x-test-actor'])) ?? null,
  });
  await app.ready();
  return {
    app,
    clock,
    hub,
    db,
    as(actor, inject) {
      const headers = { ...(inject.headers ?? {}) } as Record<string, string>;
      if (actor) {
        const key = `a${++counter}`;
        actors.set(key, actor);
        headers['x-test-actor'] = key;
      }
      return app.inject({ ...inject, headers });
    },
    headersFor(actor) {
      const key = `a${++counter}`;
      actors.set(key, actor);
      return { 'x-test-actor': key };
    },
    close: () => app.close(),
  };
}

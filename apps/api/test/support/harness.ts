import { type PermissionCode, roleTemplate } from '@oxrana/contracts';
import { createDb, createPool, type Db, type DbPool, schema } from '@oxrana/db';
import { applySeed, DEMO_SEED, fixtureKeys, seedId } from '@oxrana/db/seed';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll } from 'vitest';
import { buildApp } from '../../src/app';
import { randomToken, sha256Hex } from '../../src/auth/crypto';
import { MemoryMessenger } from '../../src/auth/messenger';
import { FixedClock } from '../../src/clock';
import type { ServiceHooks } from '../../src/core/context';
import { EventHub } from '../../src/realtime/hub';

/**
 * Обвязка интеграционных тестов API: приложение на копии тестовой базы (ADR-014 п. 7) под ролью
 * приложения (RLS действует), демо-сид — под владельцем. Субъекты — настоящие учётные записи:
 * пользователи с ролями-шаблонами и сессиями, устройства учёток КПП с токенами (ADR-018); актора
 * определяет сервер. Время — фиксированные часы: вторник 10.03.2026 12:00 по объекту.
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
  seeded ??= applySeed(ownerDb(), DEMO_SEED).then(() => undefined);
  return seeded;
}

/** Адрес веба в тестах: с него разрешены изменяющие запросы (проверка Origin, ADR-018). */
export const TEST_ORIGIN = 'http://127.0.0.1:5173';
/** Сессии и устройства тестов живут дольше любых часов теста. */
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z');

/**
 * Тестовый субъект (ADR-018): **настоящая** учётная запись в БД — пользователь с назначениями
 * реальных ролей-шаблонов демо-организации и cookie-сессией или устройство учётки КПП с токеном.
 * Сервер определяет актора сам, по сессии и токену, как в рабочем режиме; тест только описывает,
 * кого создать. Поля `permissions`, `tenantIds` — ожидания теста, сервер их не получает.
 */
export interface TestPrincipal {
  readonly key: string;
  readonly kind: 'user' | 'gate_account';
  /** id пользователя или учётки КПП. */
  readonly id: string;
  readonly permissions: ReadonlySet<string>;
  readonly siteIds: readonly string[] | null;
  readonly tenantIds: readonly string[] | null;
  readonly gateId: string | null;
  /** Как создать учётную запись в БД (под владельцем схемы). */
  readonly materialize: (db: Db) => Promise<{ cookie?: string; bearer?: string }>;
}

const testId = (...parts: string[]) => seedId('test', ...parts);
export const roleIdOf = (code: string) => seedId(DEMO_SEED.organization.key, 'role', code);

async function userSession(
  db: Db,
  key: string,
  fullName: string,
  assignments: { roleId: string; siteId: string | null; tenantId: string | null }[],
): Promise<{ cookie: string }> {
  const userId = testId('user', key);
  await db
    .insert(schema.users)
    .values({
      id: userId,
      fullName,
      email: `${sha256Hex(key).slice(0, 12)}@example.test`,
      status: 'active',
    })
    .onConflictDoNothing();
  for (const a of assignments) {
    await db
      .insert(schema.roleAssignments)
      .values({ organizationId: KEYS.organizationId, userId, ...a })
      .onConflictDoNothing();
  }
  const token = randomToken();
  await db.insert(schema.sessions).values({
    userId,
    organizationId: KEYS.organizationId,
    tokenHash: sha256Hex(token),
    lastSeenAt: FAR_FUTURE,
    expiresAt: FAR_FUTURE,
  });
  return { cookie: `sid=${token}` };
}

function scopeKey(scope: {
  siteIds?: readonly string[] | null;
  tenantIds?: readonly string[] | null;
}) {
  return `s:${scope.siteIds === undefined ? '-' : (scope.siteIds?.join(',') ?? 'all')}|t:${scope.tenantIds?.join(',') ?? '-'}`;
}

/**
 * Пользователь с ролью-шаблоном демо-организации и областью (ADR-007): шаблон «организация» —
 * вся организация, «объект» — демо-объект, «арендатор» — переданные арендаторы.
 */
export function roleActor(
  code: string,
  scope: { siteIds?: string[] | null; tenantIds?: string[] | null } = {},
): TestPrincipal {
  const template = roleTemplate(code);
  if (template.scope === 'gate') throw new Error('Учётку поста создаёт gateActor()');
  const key = `role:${code}:${scopeKey(scope)}`;
  const siteIds =
    scope.siteIds !== undefined
      ? scope.siteIds
      : template.scope === 'organization'
        ? null
        : [KEYS.siteId];
  const tenantIds = scope.tenantIds ?? (template.scope === 'tenant' ? [] : null);
  return {
    key,
    kind: 'user',
    id: testId('user', key),
    permissions: new Set<string>(template.permissions),
    siteIds,
    tenantIds,
    gateId: null,
    materialize: (db) =>
      userSession(
        db,
        key,
        `Тестовый ${code}`,
        template.scope === 'tenant'
          ? (tenantIds ?? []).map((tenantId) => ({
              roleId: roleIdOf(code),
              siteId: KEYS.siteId,
              tenantId,
            }))
          : siteIds === null
            ? [{ roleId: roleIdOf(code), siteId: null, tenantId: null }]
            : siteIds.map((siteId) => ({ roleId: roleIdOf(code), siteId, tenantId: null })),
      ),
  };
}

/**
 * Устройство учётки КПП демо-объекта (одна учётка на КПП, A11) с токеном. Роль, отличная от
 * «Пост КПП» (например, «Старший смены» в матрице), — у отдельного тестового КПП того же вида:
 * у КПП одна учётка, менять роль общей учётки нельзя.
 */
export function gateActor(
  gateKey: string,
  code = 'gate_post',
  custom?: readonly PermissionCode[],
): TestPrincipal {
  const seedGateId = KEYS.gates[gateKey];
  if (!seedGateId) throw new Error(`Нет КПП ${gateKey}`);
  if (custom) code = `custom-${[...custom].sort().join(',')}`;
  const own = code === DEMO_SEED.gateAccountRoleTemplate;
  const roleId = custom ? testId('gate-role', code) : roleIdOf(code);
  const gateId = own ? seedGateId : testId('gate', gateKey, code);
  const accountId = own
    ? seedId(DEMO_SEED.organization.key, 'gate-account', gateKey)
    : testId('gate-account', gateKey, code);
  const key = `gate:${gateKey}:${code}`;
  return {
    key,
    kind: 'gate_account',
    id: accountId,
    permissions: new Set<string>(custom ?? roleTemplate(code).permissions),
    siteIds: [KEYS.siteId],
    tenantIds: null,
    gateId,
    materialize: async (db) => {
      if (custom) {
        await db
          .insert(schema.roles)
          .values({
            id: roleId,
            organizationId: KEYS.organizationId,
            name: `Тестовая роль поста ${code}`.slice(0, 100),
            permissions: [...custom],
          })
          .onConflictDoNothing();
      }
      if (!own) {
        const [source] = await db
          .select()
          .from(schema.gates)
          .where(eq(schema.gates.id, seedGateId));
        if (!source) throw new Error(`Нет КПП ${gateKey} в базе`);
        await db
          .insert(schema.gates)
          .values({ ...source, id: gateId, name: `${source.name} (${code})`.slice(0, 100) })
          .onConflictDoNothing();
        await db
          .insert(schema.gateAccounts)
          .values({
            id: accountId,
            organizationId: KEYS.organizationId,
            siteId: source.siteId,
            gateId,
            roleId,
          })
          .onConflictDoNothing();
      }
      const token = randomToken();
      await db.insert(schema.gateDevices).values({
        organizationId: KEYS.organizationId,
        gateAccountId: accountId,
        name: `Тестовое устройство ${key}`,
        tokenHash: sha256Hex(token),
        enrolledAt: new Date(NOON),
        lastSeenAt: FAR_FUTURE,
      });
      return { bearer: token };
    },
  };
}

/** Пользователь с собственной ролью из заданных прав (для отдельных проверок). */
export function customActor(
  permissions: readonly PermissionCode[],
  extra: { siteIds?: string[] | null; tenantIds?: string[] | null } = {},
): TestPrincipal {
  const key = `custom:${[...permissions].sort().join(',')}:${scopeKey(extra)}`;
  const roleId = testId('role', key);
  const tenantIds = extra.tenantIds ?? null;
  const siteIds = extra.siteIds ?? null;
  return {
    key,
    kind: 'user',
    id: testId('user', key),
    permissions: new Set<string>(permissions),
    siteIds,
    tenantIds,
    gateId: null,
    materialize: async (db) => {
      await db
        .insert(schema.roles)
        .values({
          id: roleId,
          organizationId: KEYS.organizationId,
          name: `Тестовая роль ${key}`.slice(0, 100),
          permissions: [...permissions],
        })
        .onConflictDoNothing();
      return userSession(
        db,
        key,
        'Тестовый с особой ролью',
        tenantIds
          ? tenantIds.map((tenantId) => ({ roleId, siteId: KEYS.siteId, tenantId }))
          : siteIds
            ? siteIds.map((siteId) => ({ roleId, siteId, tenantId: null }))
            : [{ roleId, siteId: null, tenantId: null }],
      );
    },
  };
}

/** Учётные данные субъектов этого файла (база своя у каждого файла). */
const credentials = new Map<string, Promise<{ cookie?: string; bearer?: string }>>();

/** Заголовки входа субъекта: cookie сессии или токен устройства. */
export async function authHeaders(principal: TestPrincipal): Promise<Record<string, string>> {
  let entry = credentials.get(principal.key);
  if (!entry) {
    entry = principal.materialize(ownerDb());
    credentials.set(principal.key, entry);
  }
  const creds = await entry;
  return creds.bearer
    ? { authorization: `Bearer ${creds.bearer}` }
    : { cookie: creds.cookie ?? '' };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly clock: FixedClock;
  readonly hub: EventHub;
  readonly db: Db;
  /** Приглашения, ссылки и коды, которые «отправил» сервер. */
  readonly messenger: MemoryMessenger;
  /** Запрос от имени субъекта (`null` — без входа). Изменяющие запросы — с Origin веба. */
  as(principal: TestPrincipal | null, options: InjectOptions): Promise<LightMyRequestResponse>;
  /** Заголовки для настоящего HTTP-запроса от имени субъекта (SSE через fetch). */
  headersFor(principal: TestPrincipal): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export async function startTestApp(
  options: { poolSize?: number; hooks?: ServiceHooks; now?: string } = {},
): Promise<TestApp> {
  const clock = new FixedClock(options.now ?? NOON);
  const hub = new EventHub();
  const db = createDb(appPool(options.poolSize ?? 10));
  const messenger = new MemoryMessenger();
  const app = await buildApp({
    services: {
      db,
      clock,
      hub,
      messenger,
      publicUrl: TEST_ORIGIN,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    },
  });
  await app.ready();
  return {
    app,
    clock,
    hub,
    db,
    messenger,
    async as(principal, inject) {
      const headers = { ...(inject.headers ?? {}) } as Record<string, string>;
      if (principal) Object.assign(headers, await authHeaders(principal));
      const method = (inject.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && headers.origin === undefined) {
        headers.origin = TEST_ORIGIN;
      }
      return app.inject({ ...inject, headers });
    },
    headersFor: authHeaders,
    close: () => app.close(),
  };
}

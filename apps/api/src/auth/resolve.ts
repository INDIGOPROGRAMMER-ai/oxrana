import { PERMISSIONS } from '@oxrana/contracts';
import {
  type Db,
  organizationOfToken,
  schema,
  userOrganizations,
  withOrganization,
} from '@oxrana/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { type Actor, actorFromGrants, type Grant } from '../actor';
import type { Clock } from '../clock';
import { parseCookies, SESSION_COOKIE, SESSION_TTL_MS } from './cookies';
import { sha256Hex } from './crypto';

declare module 'fastify' {
  interface FastifyRequest {
    /** Сессию продлили — ответ обновит срок cookie (30 дней скользящих). */
    refreshedSessionToken: string | null;
  }
}

/** Как часто продлевать сессию и отмечать «последний раз видели» устройство. */
const TOUCH_EVERY_MS = 5 * 60_000;
const DEVICE_TOUCH_EVERY_MS = 60_000;

/**
 * Права роли при сборке актора. Владелец организации (`org_owner`) всегда имеет все права
 * платформы, что бы ни лежало в массиве БД: так владелец, созданный до добавления права, не
 * застрянет без него и не сможет остаться без пункта меню (ADR-007, «Новое право»).
 */
function rolePermissions(role: { permissions: string[]; templateCode: string | null }) {
  return new Set<string>(role.templateCode === 'org_owner' ? PERMISSIONS : role.permissions);
}

/** Назначения ролей пользователя в организации — права и область каждого (ADR-018). */
export async function userGrants(db: Db, organizationId: string, userId: string): Promise<Grant[]> {
  return withOrganization(db, organizationId, async (tx) => {
    const rows = await tx
      .select({
        permissions: schema.roles.permissions,
        templateCode: schema.roles.templateCode,
        siteId: schema.roleAssignments.siteId,
        tenantId: schema.roleAssignments.tenantId,
        tenantSiteId: schema.tenants.siteId,
        tenantDeleted: schema.tenants.deletedAt,
      })
      .from(schema.roleAssignments)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.roleAssignments.tenantId))
      .where(
        and(
          eq(schema.roleAssignments.organizationId, organizationId),
          eq(schema.roleAssignments.userId, userId),
          isNull(schema.roles.deletedAt),
        ),
      );
    return rows
      .filter((r) => r.tenantId === null || r.tenantDeleted === null)
      .map((r) => ({
        permissions: rolePermissions(r),
        siteId: r.tenantId !== null ? (r.tenantSiteId ?? r.siteId) : r.siteId,
        tenantId: r.tenantId,
      }));
  });
}

/** Актор пользователя в организации; без назначений — `null` (входить некуда). */
export async function userActor(
  db: Db,
  organizationId: string,
  userId: string,
  sessionId: string | null,
): Promise<Actor | null> {
  const grants = await userGrants(db, organizationId, userId);
  if (grants.length === 0) return null;
  return actorFromGrants({ id: userId, kind: 'user', organizationId, grants, sessionId });
}

/** Организация сессии: сохранённая, если назначения в ней ещё есть, иначе — первая из доступных. */
export async function sessionOrganization(
  db: Db,
  userId: string,
  preferred: string | null,
): Promise<string | null> {
  const orgs = await userOrganizations(db, userId);
  if (preferred && orgs.includes(preferred)) return preferred;
  return orgs[0] ?? null;
}

async function sessionActor(
  db: Db,
  clock: Clock,
  request: FastifyRequest,
  token: string,
): Promise<Actor | null> {
  const now = clock.now();
  const [row] = await db
    .select({ session: schema.sessions, status: schema.users.status })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.tokenHash, sha256Hex(token)),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date(now)),
      ),
    );
  if (row?.status !== 'active') return null;
  const { session } = row;
  const organizationId = await sessionOrganization(db, session.userId, session.organizationId);
  if (!organizationId) return null;
  const actor = await userActor(db, organizationId, session.userId, session.id);
  if (!actor) return null;
  const stale = !session.lastSeenAt || now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS;
  if (stale || session.organizationId !== organizationId) {
    await db
      .update(schema.sessions)
      .set({
        lastSeenAt: new Date(now),
        expiresAt: new Date(now + SESSION_TTL_MS),
        organizationId,
      })
      .where(eq(schema.sessions.id, session.id));
    request.refreshedSessionToken = token;
  }
  return actor;
}

/**
 * Устройство поста по токену (ADR-007): учётка КПП с ролью «Пост КПП», область — её КПП и объект.
 * Отозванное устройство, отключённая учётка и удалённый КПП не входят — сразу, без кэша.
 */
async function deviceActor(
  db: Db,
  clock: Clock,
  request: FastifyRequest,
  token: string,
): Promise<Actor | null> {
  const hash = sha256Hex(token);
  const organizationId = await organizationOfToken(db, 'device', hash);
  if (!organizationId) return null;
  const now = clock.now();
  return withOrganization(db, organizationId, async (tx) => {
    const [row] = await tx
      .select({
        device: schema.gateDevices,
        account: schema.gateAccounts,
        permissions: schema.roles.permissions,
      })
      .from(schema.gateDevices)
      .innerJoin(schema.gateAccounts, eq(schema.gateAccounts.id, schema.gateDevices.gateAccountId))
      .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
      .innerJoin(schema.roles, eq(schema.roles.id, schema.gateAccounts.roleId))
      .where(
        and(
          eq(schema.gateDevices.organizationId, organizationId),
          eq(schema.gateDevices.tokenHash, hash),
          isNull(schema.gateDevices.revokedAt),
          eq(schema.gateAccounts.status, 'active'),
          isNull(schema.gates.deletedAt),
          isNull(schema.roles.deletedAt),
        ),
      );
    if (!row) return null;
    const { device, account } = row;
    if (!device.lastSeenAt || now - device.lastSeenAt.getTime() > DEVICE_TOUCH_EVERY_MS) {
      await tx
        .update(schema.gateDevices)
        .set({ lastSeenAt: new Date(now), lastIp: request.ip ?? null })
        .where(eq(schema.gateDevices.id, device.id));
    }
    return actorFromGrants({
      id: account.id,
      kind: 'gate_account',
      organizationId,
      grants: [{ permissions: new Set(row.permissions), siteId: account.siteId, tenantId: null }],
      gateId: account.gateId,
      deviceId: device.id,
    });
  });
}

/** Токен устройства из `Authorization: Bearer …`. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(header);
  return match?.[1] ?? null;
}

export function sessionToken(request: FastifyRequest): string | null {
  const value = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  return value && /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
}

/**
 * Актор запроса (ADR-017 п. 1, ADR-018): токен устройства — учётка КПП, cookie `sid` — пользователь.
 * Ничего нет или токен отозван — `null`, хук прав ответит 401.
 */
export function createActorResolver(db: Db, clock: Clock) {
  return async (request: FastifyRequest): Promise<Actor | null> => {
    const bearer = bearerToken(request);
    if (bearer) return deviceActor(db, clock, request, bearer);
    const sid = sessionToken(request);
    if (sid) return sessionActor(db, clock, request, sid);
    return null;
  };
}

import type { AssignmentView, Me } from '@oxrana/contracts';
import { type Db, type DbTx, schema, userOrganizations, withOrganization } from '@oxrana/db';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../../actor';
import { clearSessionCookie, SESSION_TTL_MS, sessionCookie } from '../../auth/cookies';
import { randomToken, sha256Hex } from '../../auth/crypto';
import { type AuthEventKind, recordAuthEvent } from '../../auth/throttle';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../errors';

export type UserRow = typeof schema.users.$inferSelect;

/** Запись аудита вне `ctx.tx` (вход, привязка устройства): актора запроса ещё нет. */
export async function insertAudit(
  tx: DbTx,
  row: {
    organizationId: string;
    at: Date;
    actorType: 'user' | 'gate_account' | 'system';
    actorUserId?: string | null;
    actorGateAccountId?: string | null;
    deviceId?: string | null;
    requestId: string;
    ip: string | null;
    siteId?: string | null;
    entity: string;
    entityId: string;
    action: string;
    reason?: string | null;
    snapshot?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    organizationId: row.organizationId,
    siteId: row.siteId ?? null,
    at: row.at,
    actorType: row.actorType,
    actorUserId: row.actorUserId ?? null,
    actorGateAccountId: row.actorGateAccountId ?? null,
    deviceId: row.deviceId ?? null,
    requestId: row.requestId,
    ip: row.ip,
    entity: row.entity,
    entityId: row.entityId,
    action: row.action,
    reason: row.reason ?? null,
    snapshot: row.snapshot ?? null,
  });
}

/**
 * Событие входа пользователя — в журнал входа платформы и в аудит каждой его организации (там
 * администратор видит входы и неудачные попытки своих людей). Пароли, токены и коды — никогда.
 */
export async function recordUserAuth(
  deps: AppDeps,
  request: FastifyRequest,
  kind: AuthEventKind,
  user: { id: string } | null,
  loginHash: string | null = null,
): Promise<void> {
  const at = new Date(deps.clock.now());
  await recordAuthEvent(deps.db, {
    kind,
    userId: user?.id ?? null,
    loginHash,
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
    at,
  });
  if (!user) return;
  for (const organizationId of await userOrganizations(deps.db, user.id)) {
    await withOrganization(deps.db, organizationId, (tx) =>
      insertAudit(tx, {
        organizationId,
        at,
        actorType: 'user',
        actorUserId: user.id,
        requestId: request.id,
        ip: request.ip ?? null,
        entity: 'user',
        entityId: user.id,
        action: kind,
      }),
    );
  }
}

/** Новая сессия: токен — в cookie (httpOnly), в БД — хэш (ADR-007). */
export async function startSession(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  organizationId: string,
): Promise<string> {
  const token = randomToken();
  const now = deps.clock.now();
  const [row] = await deps.db
    .insert(schema.sessions)
    .values({
      userId,
      organizationId,
      tokenHash: sha256Hex(token),
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    })
    .returning({ id: schema.sessions.id });
  await deps.db
    .update(schema.users)
    .set({ lastLoginAt: new Date(now) })
    .where(eq(schema.users.id, userId));
  reply.header('set-cookie', sessionCookie(token, deps.auth.secureCookies));
  return row?.id ?? '';
}

export function endSessionCookie(deps: AppDeps, reply: FastifyReply): void {
  reply.header('set-cookie', clearSessionCookie(deps.auth.secureCookies));
}

/**
 * Все сессии пользователя отзываются: «выйти на всех устройствах», смена и сброс пароля, отключение.
 * Возвращает id отозванных сессий: после фиксации транзакции вызывающий закрывает их потоки SSE
 * (`closeSessionStreams`).
 */
export async function revokeUserSessions(
  db: Db | DbTx,
  userId: string,
  now: number,
  except: string | null = null,
): Promise<string[]> {
  const rows = await db
    .update(schema.sessions)
    .set({ revokedAt: new Date(now) })
    .where(
      and(
        eq(schema.sessions.userId, userId),
        isNull(schema.sessions.revokedAt),
        except ? ne(schema.sessions.id, except) : undefined,
      ),
    )
    .returning({ id: schema.sessions.id });
  return rows.map((r) => r.id);
}

export async function findUserByLogin(
  db: Db,
  login: { kind: 'email' | 'phone'; value: string },
): Promise<UserRow | null> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(
      login.kind === 'email'
        ? eq(schema.users.email, login.value)
        : eq(schema.users.phone, login.value),
    );
  return user ?? null;
}

/** Организация, куда войти: без назначений войти некуда — понятная ошибка, а не пустой кабинет. */
export async function firstOrganization(db: Db, userId: string): Promise<string> {
  const [first] = await userOrganizations(db, userId);
  if (!first) {
    throw new AppError('forbidden', {
      message:
        'У вашей учётной записи нет ролей ни в одной организации. Обратитесь к администратору объекта.',
    });
  }
  return first;
}

/** Назначения пользователя в организации с названиями роли, объекта и арендатора. */
export async function assignmentViews(
  tx: DbTx,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, AssignmentView[]>> {
  const out = new Map<string, AssignmentView[]>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({
      id: schema.roleAssignments.id,
      userId: schema.roleAssignments.userId,
      roleId: schema.roleAssignments.roleId,
      roleName: schema.roles.name,
      siteId: schema.roleAssignments.siteId,
      siteName: schema.sites.name,
      tenantId: schema.roleAssignments.tenantId,
      tenantName: schema.tenants.shortName,
    })
    .from(schema.roleAssignments)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.roleAssignments.siteId))
    .leftJoin(schema.tenants, eq(schema.tenants.id, schema.roleAssignments.tenantId))
    .where(
      and(
        eq(schema.roleAssignments.organizationId, organizationId),
        inArray(schema.roleAssignments.userId, [...userIds]),
        isNull(schema.roles.deletedAt),
      ),
    );
  for (const r of rows) {
    const { userId, ...view } = r;
    out.set(userId, [...(out.get(userId) ?? []), view]);
  }
  return out;
}

/** «Кто я» для веба и поста. */
export async function buildMe(db: Db, actor: Actor): Promise<Me> {
  const permissions = [...actor.permissions].sort();
  if (actor.kind === 'gate_account') {
    return withOrganization(db, actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({
          orgName: schema.organizations.name,
          gateName: schema.gates.name,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
          deviceName: schema.gateDevices.name,
        })
        .from(schema.gateDevices)
        .innerJoin(
          schema.gateAccounts,
          eq(schema.gateAccounts.id, schema.gateDevices.gateAccountId),
        )
        .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
        .innerJoin(schema.sites, eq(schema.sites.id, schema.gates.siteId))
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.gates.organizationId))
        .where(eq(schema.gateDevices.id, actor.deviceId ?? ''));
      if (!row) throw new AppError('unauthenticated');
      const organization = { id: actor.organizationId, name: row.orgName };
      return {
        kind: 'gate_account' as const,
        id: actor.id,
        organization,
        organizations: [organization],
        permissions,
        user: null,
        gate: {
          id: actor.gateId ?? '',
          name: row.gateName,
          siteId: row.siteId,
          siteName: row.siteName,
          deviceId: actor.deviceId ?? '',
          deviceName: row.deviceName,
        },
      };
    });
  }
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.id));
  if (!user) throw new AppError('unauthenticated');
  const organizations = [];
  for (const id of await userOrganizations(db, actor.id)) {
    const [org] = await withOrganization(db, id, (tx) =>
      tx
        .select({ id: schema.organizations.id, name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, id)),
    );
    if (org) organizations.push(org);
  }
  const assignments = await withOrganization(db, actor.organizationId, (tx) =>
    assignmentViews(tx, actor.organizationId, [actor.id]),
  );
  const organization = organizations.find((o) => o.id === actor.organizationId) ?? {
    id: actor.organizationId,
    name: '',
  };
  return {
    kind: 'user',
    id: actor.id,
    organization,
    organizations,
    permissions,
    user: {
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      mustChangePassword: user.mustChangePassword,
      assignments: assignments.get(actor.id) ?? [],
    },
    gate: null,
  };
}

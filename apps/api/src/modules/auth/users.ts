import {
  AssignmentInputSchema,
  AssignmentViewSchema,
  DisableUserSchema,
  IdParamsSchema,
  InvitationCreatedSchema,
  InvitationCreateSchema,
  InvitationListQuerySchema,
  InvitationViewSchema,
  NEVER_FOR_GATE_ACCOUNT_PERMISSIONS,
  OneTimeLinkSchema,
  PERMISSION_LABELS,
  PERMISSIONS,
  type PermissionCode,
  PermissionViewSchema,
  ROLE_TEMPLATES,
  RoleCreateSchema,
  RolePatchSchema,
  RoleViewSchema,
  UserListQuerySchema,
  UserViewSchema,
} from '@oxrana/contracts';
import { findUsages, schema, userOrganizations } from '@oxrana/db';
import { and, arrayContains, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Actor, isTenantUser } from '../../actor';
import { randomToken, sha256Hex } from '../../auth/crypto';
import { normalizeEmail, normalizePhone } from '../../auth/login';
import {
  assertSiteAccess,
  assertTenantAccess,
  type Ctx,
  can,
  ctxOf,
  requirePermission,
  type Scope,
} from '../../core/context';
import { changedFields } from '../../core/diff';
import { loadSite, loadTenant, notFound } from '../../core/loaders';
import { usageView } from '../../core/usages';
import { AppError } from '../../errors';
import { closeSessionStreams } from '../../realtime/routes';
import { invitationLink, issuePasswordLink } from './routes';
import { assignmentViews, revokeUserSessions } from './session';

/** Приглашение действует 7 дней (ADR-007). */
export const INVITATION_TTL_MS = 7 * 86_400_000;
/** Ссылка сброса пароля, выданная администратором, — сутки. */
const ADMIN_RESET_TTL_MS = 24 * 3_600_000;

const PEOPLE = ['user.manage', 'tenant_user.manage'] as const;
const ROLE_READ = ['role.manage', 'user.manage', 'tenant_user.manage'] as const;

type RoleRow = typeof schema.roles.$inferSelect;
type InvitationRow = typeof schema.invitations.$inferSelect;

interface AssignScope {
  readonly siteId: string | null;
  readonly tenantId: string | null;
}

/**
 * Права, которыми актор владеет в области назначения: только назначения, покрывающие её целиком.
 * На всю организацию — только назначения на всю организацию; на объект — сотрудника этого объекта
 * или всей организации; на арендатора — ещё и назначения в этом арендаторе.
 */
function heldIn(actor: Actor, scope: AssignScope): Set<string> {
  const out = new Set<string>();
  for (const g of actor.grants) {
    const siteOk = g.siteId === null || (scope.siteId !== null && g.siteId === scope.siteId);
    const tenantOk =
      g.tenantId === null || (scope.tenantId !== null && g.tenantId === scope.tenantId);
    if (siteOk && tenantOk) for (const p of g.permissions) out.add(p);
  }
  return out;
}

async function loadRole(s: Scope, roleId: string): Promise<RoleRow> {
  const [role] = await s.db
    .select()
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.organizationId, s.organizationId),
        eq(schema.roles.id, roleId),
        isNull(schema.roles.deletedAt),
      ),
    );
  if (!role) throw notFound('Роль');
  return role;
}

/** Область назначения: арендатор задаёт и объект; объект — сам по себе; ничего — вся организация. */
async function resolveScope(
  s: Scope,
  input: { siteId?: string | null | undefined; tenantId?: string | null | undefined },
): Promise<AssignScope> {
  if (input.tenantId) {
    const tenant = await loadTenant(s, input.tenantId);
    if (input.siteId && input.siteId !== tenant.siteId) {
      throw new AppError('validation_failed', {
        field: 'siteId',
        message: 'Арендатор находится на другом объекте.',
      });
    }
    return { siteId: tenant.siteId, tenantId: tenant.id };
  }
  if (input.siteId) {
    const site = await loadSite(s, input.siteId);
    return { siteId: site.id, tenantId: null };
  }
  return { siteId: null, tenantId: null };
}

/**
 * Можно ли выдать роль в этой области (ADR-018): `user.manage` — любую, `tenant_user.manage` —
 * только в своей компании; и в любом случае — не шире собственных прав в этой области.
 */
function assertCanAssign(ctx: Ctx, role: RoleRow, scope: AssignScope): void {
  if (scope.tenantId) assertTenantAccess(ctx, scope.tenantId);
  else if (scope.siteId) assertSiteAccess(ctx, scope.siteId);
  if (!can(ctx, 'user.manage')) {
    requirePermission(ctx, 'tenant_user.manage');
    if (!scope.tenantId || !isTenantUser(ctx.actor)) {
      throw new AppError('forbidden', {
        permission: 'user.manage',
        message: 'Вы приглашаете людей только в свою компанию: выберите её.',
        settingLink: '/admin/roles',
      });
    }
  }
  const held = heldIn(ctx.actor, scope);
  const missing = role.permissions.filter((p) => !held.has(p));
  if (missing.length > 0) {
    throw new AppError('role_too_broad', {
      field: 'roleId',
      details: { missing },
      message: `Роль «${role.name}» даёт права, которых у вас нет в этой области: ${missing
        .slice(0, 5)
        .map((p) => PERMISSION_LABELS[p as keyof typeof PERMISSION_LABELS] ?? p)
        .join('; ')}${missing.length > 5 ? '…' : ''}.`,
    });
  }
}

/** Пользователь только этой организации: глобальные действия (отключить, сбросить пароль) — здесь. */
/**
 * Глобальные действия над человеком (отключить, сбросить пароль): только если он работает лишь в
 * этой организации и все его роли здесь не шире прав того, кто действует, — иначе администратор
 * объекта мог бы сбросить пароль владельцу и войти под ним.
 */
async function assertCanManageUser(s: Scope, userId: string): Promise<void> {
  const orgs = await userOrganizations(s.db, userId);
  if (!orgs.includes(s.organizationId)) throw notFound('Пользователь');
  if (orgs.length > 1) {
    throw new AppError('conflict', {
      message:
        'Пользователь работает и в других организациях. Здесь можно только убрать его роли в вашей организации.',
    });
  }
  const rows = await s.db
    .select({ assignment: schema.roleAssignments, role: schema.roles })
    .from(schema.roleAssignments)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
    .where(
      and(
        eq(schema.roleAssignments.organizationId, s.organizationId),
        eq(schema.roleAssignments.userId, userId),
      ),
    );
  for (const { assignment, role } of rows) {
    assertCanAssign(s.ctx, role, { siteId: assignment.siteId, tenantId: assignment.tenantId });
  }
}

/** Роль меняет или удаляет только тот, у кого есть все её права: иначе — урезать права старшего. */
function assertCanEditRole(ctx: Ctx, role: RoleRow): void {
  const missing = role.permissions.filter((p) => !ctx.actor.permissions.has(p));
  if (missing.length > 0) {
    throw new AppError('role_too_broad', {
      details: { missing },
      message: `Роль «${role.name}» шире ваших прав — изменить её может владелец организации.`,
    });
  }
}

/**
 * Роль области «КПП» (шаблоны «Пост КПП» и «Старший смены») или роль, назначенная учётке КПП, не
 * может содержать права, которых учётка КПП не получает никогда (ADR-007, 7b.3).
 */
async function assertGateRoleAllowed(
  s: Scope,
  role: RoleRow,
  permissions: readonly string[],
): Promise<void> {
  const forbidden = permissions.filter((p) =>
    (NEVER_FOR_GATE_ACCOUNT_PERMISSIONS as readonly string[]).includes(p),
  );
  if (forbidden.length === 0) return;
  if (!isGateRole(role, await roleIdsOfGateAccounts(s, [role.id]))) return;
  throw new AppError('validation_failed', {
    field: 'permissions',
    message: `Роль «${role.name}» относится к КПП: право «${forbidden.map((p) => PERMISSION_LABELS[p as PermissionCode]).join('», «')}» учётке КПП не выдаётся никогда — история пропуска доступна сотрудникам и арендаторам.`,
  });
}

function invitationStatus(
  row: InvitationRow,
  now: number,
): 'pending' | 'accepted' | 'expired' | 'revoked' {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  return row.expiresAt.getTime() <= now ? 'expired' : 'pending';
}

function invitationView(row: InvitationRow, roleName: string, now: number) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    fullName: row.fullName,
    roleId: row.roleId,
    roleName,
    siteId: row.siteId,
    tenantId: row.tenantId,
    status: invitationStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Роли, назначенные учёткам КПП. */
async function roleIdsOfGateAccounts(s: Scope, roleIds: readonly string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();
  const rows = await s.db
    .selectDistinct({ roleId: schema.gateAccounts.roleId })
    .from(schema.gateAccounts)
    .where(
      and(
        eq(schema.gateAccounts.organizationId, s.organizationId),
        inArray(schema.gateAccounts.roleId, [...roleIds]),
      ),
    );
  return new Set(rows.map((r) => r.roleId));
}

/** Роль области «КПП»: шаблон «Пост КПП» / «Старший смены» либо назначена учётке КПП. */
function isGateRole(row: RoleRow, usedByGateAccounts: ReadonlySet<string>): boolean {
  return (
    ROLE_TEMPLATES.find((t) => t.code === row.templateCode)?.scope === 'gate' ||
    usedByGateAccounts.has(row.id)
  );
}

function roleView(row: RoleRow, forGate: boolean) {
  return {
    id: row.id,
    name: row.name,
    permissions: [...row.permissions],
    isTemplate: row.isTemplate,
    templateCode: row.templateCode,
    forGate,
  };
}

async function loadInvitationRow(s: Scope, id: string) {
  const [row] = await s.db
    .select({ invitation: schema.invitations, roleName: schema.roles.name, role: schema.roles })
    .from(schema.invitations)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.invitations.roleId))
    .where(
      and(eq(schema.invitations.organizationId, s.organizationId), eq(schema.invitations.id, id)),
    );
  if (!row) throw notFound('Приглашение');
  return row;
}

/** Права, которые актор добавляет в роль, должны быть у него самого (иначе — повышение прав). */
function assertCanGrantPermissions(ctx: Ctx, added: readonly string[]): void {
  const missing = added.filter((p) => !ctx.actor.permissions.has(p));
  if (missing.length > 0) {
    throw new AppError('role_too_broad', {
      field: 'permissions',
      details: { missing },
      message: `Нельзя добавить в роль права, которых нет у вас: ${missing.join(', ')}.`,
    });
  }
}

export function registerUserRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['users'];

  typed.get(
    '/users',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Пользователи организации (или своей компании) с ролями',
        querystring: UserListQuerySchema,
        response: { 200: z.object({ items: z.array(UserViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const ownTenantsOnly = !can(ctx, 'user.manage');
        if (request.query.tenantId) await loadTenant(s, request.query.tenantId);
        const tenantFilter = request.query.tenantId
          ? [request.query.tenantId]
          : ownTenantsOnly
            ? [...(ctx.actor.tenantIds ?? [])]
            : null;
        if (tenantFilter !== null && tenantFilter.length === 0) return { items: [] };
        const rows = await s.db
          .selectDistinct({ userId: schema.roleAssignments.userId })
          .from(schema.roleAssignments)
          .where(
            and(
              eq(schema.roleAssignments.organizationId, s.organizationId),
              tenantFilter ? inArray(schema.roleAssignments.tenantId, tenantFilter) : undefined,
            ),
          );
        const ids = rows.map((r) => r.userId);
        if (ids.length === 0) return { items: [] };
        const users = await s.db
          .select()
          .from(schema.users)
          .where(inArray(schema.users.id, ids))
          .orderBy(asc(schema.users.fullName));
        const assignments = await assignmentViews(s.db, s.organizationId, ids);
        return {
          items: users.map((u) => ({
            id: u.id,
            fullName: u.fullName,
            email: u.email,
            phone: u.phone,
            status: u.status,
            lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
            assignments: (assignments.get(u.id) ?? []).filter(
              (a) =>
                tenantFilter === null || (a.tenantId !== null && tenantFilter.includes(a.tenantId)),
            ),
          })),
        };
      });
    },
  );

  typed.post(
    '/invitations',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Пригласить человека: роль и область; ссылка на 7 дней, показывается один раз',
        body: InvitationCreateSchema,
        response: { 201: InvitationCreatedSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const body = request.body;
      const token = randomToken();
      const result = await ctx.tx(async (s) => {
        const role = await loadRole(s, body.roleId);
        const scope = await resolveScope(s, body);
        assertCanAssign(ctx, role, scope);
        const [row] = await s.db
          .insert(schema.invitations)
          .values({
            organizationId: s.organizationId,
            email: body.email ? normalizeEmail(body.email) : null,
            phone: body.phone ? normalizePhone(body.phone) : null,
            fullName: body.fullName ?? null,
            roleId: role.id,
            siteId: scope.siteId,
            tenantId: scope.tenantId,
            tokenHash: sha256Hex(token),
            expiresAt: new Date(ctx.now() + INVITATION_TTL_MS),
            invitedBy: ctx.actor.id,
          })
          .returning();
        if (!row) throw new Error('invitation insert');
        await s.audit({
          siteId: scope.siteId,
          entity: 'invitation',
          entityId: row.id,
          action: 'create',
          snapshot: { role: role.name, tenantId: scope.tenantId },
        });
        return invitationView(row, role.name, ctx.now());
      });
      const link = invitationLink(ctx.deps, token);
      await ctx.deps.auth.messenger.send({
        kind: 'invitation',
        to: { email: result.email, phone: result.phone },
        link,
      });
      return reply.status(201).send({ invitation: result, link });
    },
  );

  typed.get(
    '/invitations',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Приглашения организации (или своей компании)',
        querystring: InvitationListQuerySchema,
        response: { 200: z.object({ items: z.array(InvitationViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const own = !can(ctx, 'user.manage');
        if (own && (ctx.actor.tenantIds ?? []).length === 0) return { items: [] };
        const rows = await s.db
          .select({ invitation: schema.invitations, roleName: schema.roles.name })
          .from(schema.invitations)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.invitations.roleId))
          .where(
            and(
              eq(schema.invitations.organizationId, s.organizationId),
              own
                ? inArray(schema.invitations.tenantId, [...(ctx.actor.tenantIds ?? [])])
                : undefined,
            ),
          )
          .orderBy(desc(schema.invitations.createdAt));
        const now = ctx.now();
        return {
          items: rows
            .map((r) => invitationView(r.invitation, r.roleName, now))
            .filter((v) => !request.query.status || v.status === request.query.status),
        };
      });
    },
  );

  typed.post(
    '/invitations/:id/resend',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary:
          'Отправить приглашение снова: новая ссылка на 7 дней, прежняя перестаёт действовать',
        params: IdParamsSchema,
        response: { 200: InvitationCreatedSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const token = randomToken();
      const view = await ctx.tx(async (s) => {
        const { invitation, role } = await loadInvitationRow(s, request.params.id);
        assertCanAssign(ctx, role, { siteId: invitation.siteId, tenantId: invitation.tenantId });
        if (invitation.acceptedAt) {
          throw new AppError('conflict', { message: 'Приглашение уже принято.' });
        }
        const [row] = await s.db
          .update(schema.invitations)
          .set({
            tokenHash: sha256Hex(token),
            expiresAt: new Date(ctx.now() + INVITATION_TTL_MS),
            revokedAt: null,
          })
          .where(eq(schema.invitations.id, invitation.id))
          .returning();
        if (!row) throw notFound('Приглашение');
        await s.audit({
          siteId: invitation.siteId,
          entity: 'invitation',
          entityId: invitation.id,
          action: 'resend',
        });
        return invitationView(row, role.name, ctx.now());
      });
      const link = invitationLink(ctx.deps, token);
      await ctx.deps.auth.messenger.send({
        kind: 'invitation',
        to: { email: view.email, phone: view.phone },
        link,
      });
      return { invitation: view, link };
    },
  );

  typed.post(
    '/invitations/:id/revoke',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Отозвать приглашение: ссылка перестаёт действовать',
        params: IdParamsSchema,
        response: { 200: InvitationViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { invitation, role } = await loadInvitationRow(s, request.params.id);
        assertCanAssign(ctx, role, { siteId: invitation.siteId, tenantId: invitation.tenantId });
        if (invitation.acceptedAt) {
          throw new AppError('conflict', {
            message: 'Приглашение уже принято — уберите роль у пользователя.',
          });
        }
        const [row = invitation] = await s.db
          .update(schema.invitations)
          .set({ revokedAt: new Date(ctx.now()) })
          .where(eq(schema.invitations.id, invitation.id))
          .returning();
        await s.audit({
          siteId: invitation.siteId,
          entity: 'invitation',
          entityId: invitation.id,
          action: 'revoke',
        });
        return invitationView(row, role.name, ctx.now());
      });
    },
  );

  typed.post(
    '/users/:id/role-assignments',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Назначить роль пользователю организации',
        params: IdParamsSchema,
        body: AssignmentInputSchema,
        response: { 201: AssignmentViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const view = await ctx.tx(async (s) => {
        const orgs = await userOrganizations(s.db, request.params.id);
        if (!orgs.includes(s.organizationId)) throw notFound('Пользователь');
        const role = await loadRole(s, request.body.roleId);
        const scope = await resolveScope(s, request.body);
        assertCanAssign(ctx, role, scope);
        const [row] = await s.db
          .insert(schema.roleAssignments)
          .values({
            organizationId: s.organizationId,
            userId: request.params.id,
            roleId: role.id,
            siteId: scope.siteId,
            tenantId: scope.tenantId,
          })
          .onConflictDoNothing()
          .returning();
        if (!row)
          throw new AppError('conflict', { message: 'Такая роль у пользователя уже есть.' });
        await s.audit({
          siteId: scope.siteId,
          entity: 'user',
          entityId: request.params.id,
          action: 'assign_role',
          snapshot: { role: role.name, siteId: scope.siteId, tenantId: scope.tenantId },
        });
        const views = await assignmentViews(s.db, s.organizationId, [request.params.id]);
        const out = views.get(request.params.id)?.find((a) => a.id === row.id);
        if (!out) throw new Error('assignment view');
        return out;
      });
      return reply.status(201).send(view);
    },
  );

  typed.delete(
    '/role-assignments/:id',
    {
      config: { permission: PEOPLE },
      schema: {
        tags,
        summary: 'Убрать роль у пользователя (последнего владельца убрать нельзя)',
        params: IdParamsSchema,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      await ctx.tx(async (s) => {
        const [row] = await s.db
          .select({ assignment: schema.roleAssignments, role: schema.roles })
          .from(schema.roleAssignments)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
          .where(
            and(
              eq(schema.roleAssignments.organizationId, s.organizationId),
              eq(schema.roleAssignments.id, request.params.id),
            ),
          );
        if (!row) throw notFound('Назначение роли');
        const { assignment, role } = row;
        assertCanAssign(ctx, role, { siteId: assignment.siteId, tenantId: assignment.tenantId });
        if (
          role.permissions.includes('role.manage') &&
          assignment.siteId === null &&
          assignment.tenantId === null
        ) {
          const owners = await s.db
            .select({ id: schema.roleAssignments.id })
            .from(schema.roleAssignments)
            .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
            .innerJoin(schema.users, eq(schema.users.id, schema.roleAssignments.userId))
            .where(
              and(
                eq(schema.roleAssignments.organizationId, s.organizationId),
                isNull(schema.roleAssignments.siteId),
                isNull(schema.roleAssignments.tenantId),
                isNull(schema.roles.deletedAt),
                arrayContains(schema.roles.permissions, ['role.manage']),
                eq(schema.users.status, 'active'),
              ),
            );
          const others = owners.filter((o) => o.id !== assignment.id);
          if (others.length === 0) {
            throw new AppError('conflict', {
              message: 'Это последний управляющий организацией — сначала назначьте другого.',
            });
          }
        }
        await s.db
          .delete(schema.roleAssignments)
          .where(eq(schema.roleAssignments.id, assignment.id));
        await s.audit({
          siteId: assignment.siteId,
          entity: 'user',
          entityId: assignment.userId,
          action: 'unassign_role',
          snapshot: { role: role.name, siteId: assignment.siteId, tenantId: assignment.tenantId },
        });
      });
      return reply.status(204).send();
    },
  );

  for (const action of ['disable', 'enable'] as const) {
    typed.post(
      `/users/:id/${action}`,
      {
        config: { permission: 'user.manage' },
        schema: {
          tags,
          summary:
            action === 'disable'
              ? 'Отключить учётную запись: все сессии завершаются сразу'
              : 'Включить учётную запись',
          params: IdParamsSchema,
          body: DisableUserSchema,
          response: { 200: UserViewSchema },
        },
      },
      async (request) => {
        const ctx = ctxOf(request);
        const revoked: string[] = [];
        const view = await ctx.tx(async (s) => {
          if (request.params.id === ctx.actor.id) {
            throw new AppError('conflict', { message: 'Свою учётную запись отключить нельзя.' });
          }
          await assertCanManageUser(s, request.params.id);
          const [user] = await s.db
            .update(schema.users)
            .set({ status: action === 'disable' ? 'disabled' : 'active' })
            .where(eq(schema.users.id, request.params.id))
            .returning();
          if (!user) throw notFound('Пользователь');
          if (action === 'disable')
            revoked.push(...(await revokeUserSessions(s.db, user.id, ctx.now())));
          await s.audit({
            siteId: null,
            entity: 'user',
            entityId: user.id,
            action,
            reason: request.body.reason,
          });
          const assignments = await assignmentViews(s.db, s.organizationId, [user.id]);
          return {
            id: user.id,
            fullName: user.fullName,
            email: user.email,
            phone: user.phone,
            status: user.status,
            lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
            assignments: assignments.get(user.id) ?? [],
          };
        });
        // Потоки SSE отключённого закрываются сразу после фиксации (как у отозванных устройств).
        closeSessionStreams(revoked);
        return view;
      },
    );
  }

  typed.post(
    '/users/:id/password-reset',
    {
      config: { permission: 'user.manage' },
      schema: {
        tags,
        summary: 'Ссылка установки нового пароля (на сутки, один раз): передать человеку',
        params: IdParamsSchema,
        response: { 200: OneTimeLinkSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const userId = request.params.id;
      await ctx.tx(async (s) => {
        await assertCanManageUser(s, userId);
        await s.audit({
          siteId: null,
          entity: 'user',
          entityId: userId,
          action: 'password_reset_link',
        });
      });
      const { link, expiresAt } = await issuePasswordLink(
        ctx.deps,
        userId,
        'reset',
        ctx.actor.id,
        ADMIN_RESET_TTL_MS,
      );
      return { link, expiresAt: expiresAt.toISOString() };
    },
  );

  typed.get(
    '/permissions',
    {
      config: { permission: ROLE_READ },
      schema: {
        tags,
        summary: 'Список прав с подписями — для редактора ролей',
        response: { 200: z.object({ items: z.array(PermissionViewSchema) }) },
      },
    },
    async () => ({ items: PERMISSIONS.map((code) => ({ code, label: PERMISSION_LABELS[code] })) }),
  );

  typed.get(
    '/roles',
    {
      config: { permission: ROLE_READ },
      schema: {
        tags,
        summary: 'Роли организации',
        response: { 200: z.object({ items: z.array(RoleViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const rows = await s.db
          .select()
          .from(schema.roles)
          .where(
            and(eq(schema.roles.organizationId, s.organizationId), isNull(schema.roles.deletedAt)),
          )
          .orderBy(asc(schema.roles.name));
        const gate = await roleIdsOfGateAccounts(
          s,
          rows.map((r) => r.id),
        );
        return { items: rows.map((r) => roleView(r, isGateRole(r, gate))) };
      });
    },
  );

  typed.post(
    '/roles',
    {
      config: { permission: 'role.manage' },
      schema: {
        tags,
        summary: 'Новая роль (по умолчанию без прав)',
        body: RoleCreateSchema,
        response: { 201: RoleViewSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const view = await ctx.tx(async (s) => {
        assertCanGrantPermissions(ctx, request.body.permissions);
        const [row] = await s.db
          .insert(schema.roles)
          .values({
            organizationId: s.organizationId,
            name: request.body.name,
            permissions: [...new Set(request.body.permissions)],
          })
          .returning();
        if (!row) throw new Error('role insert');
        await s.audit({
          siteId: null,
          entity: 'role',
          entityId: row.id,
          action: 'create',
          diff: {
            name: { from: null, to: row.name },
            permissions: { from: null, to: row.permissions },
          },
        });
        return roleView(row, false);
      });
      return reply.status(201).send(view);
    },
  );

  typed.patch(
    '/roles/:id',
    {
      config: { permission: 'role.manage' },
      schema: {
        tags,
        summary: 'Изменить роль: название и права (только переданные поля)',
        params: IdParamsSchema,
        body: RolePatchSchema,
        response: { 200: RoleViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const role = await loadRole(s, request.params.id);
        assertCanEditRole(ctx, role);
        const next: Record<string, unknown> = {};
        if (request.body.name !== undefined) next.name = request.body.name;
        if (request.body.permissions !== undefined) {
          next.permissions = [...new Set(request.body.permissions)].sort();
        }
        const current = { name: role.name, permissions: [...role.permissions].sort() };
        const fields = changedFields(current, next);
        const gate = await roleIdsOfGateAccounts(s, [role.id]);
        if (fields.length === 0) return roleView(role, isGateRole(role, gate));
        if (request.body.permissions) {
          await assertGateRoleAllowed(
            s,
            role,
            request.body.permissions.filter((p) => !role.permissions.includes(p)),
          );
          assertCanGrantPermissions(
            ctx,
            request.body.permissions.filter((p) => !role.permissions.includes(p)),
          );
        }
        const set = Object.fromEntries(fields.map((f) => [f, next[f]]));
        const [row = role] = await s.db
          .update(schema.roles)
          .set(set)
          .where(eq(schema.roles.id, role.id))
          .returning();
        await s.audit({
          siteId: null,
          entity: 'role',
          entityId: role.id,
          action: 'update',
          diff: Object.fromEntries(
            fields.map((f) => [f, { from: current[f as keyof typeof current], to: next[f] }]),
          ),
        });
        return roleView(row, isGateRole(row, gate));
      });
    },
  );

  typed.delete(
    '/roles/:id',
    {
      config: { permission: 'role.manage' },
      schema: {
        tags,
        summary: 'Удалить роль (мягко): показывает, кому она назначена',
        params: IdParamsSchema,
        querystring: z.strictObject({ confirm: z.enum(['true', 'false']).optional() }),
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      await ctx.tx(async (s) => {
        const role = await loadRole(s, request.params.id);
        assertCanEditRole(ctx, role);
        const usages = (await findUsages(s.db, schema.roles, role.id)).map(usageView);
        const inGateAccounts = usages.some((u) => u.table === 'gate_accounts');
        if (inGateAccounts) {
          throw new AppError('in_use', {
            message:
              'Роль назначена учёткам КПП — без неё посты перестанут работать. Сначала смените роль учёток.',
            details: { usages },
          });
        }
        if (usages.length > 0 && request.query.confirm !== 'true') {
          throw new AppError('in_use', {
            message: `Роль используется: ${usages.map((u) => `${u.label} — ${u.count}`).join(', ')}. Эти люди потеряют её права; чтобы удалить, подтвердите (confirm=true).`,
            details: { usages },
          });
        }
        await s.db
          .update(schema.roles)
          .set({ deletedAt: new Date(ctx.now()) })
          .where(eq(schema.roles.id, role.id));
        await s.audit({
          siteId: null,
          entity: 'role',
          entityId: role.id,
          action: 'delete',
          snapshot: { name: role.name, usages },
        });
      });
      return reply.status(204).send();
    },
  );
}

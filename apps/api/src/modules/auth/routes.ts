import {
  AcceptedSchema,
  IdParamsSchema,
  InvitationAcceptSchema,
  InvitationInfoSchema,
  LinkInfoSchema,
  LinkInspectSchema,
  LoginCodeRequestSchema,
  LoginCodeVerifySchema,
  LoginRequestSchema,
  MeSchema,
  PasswordChangeSchema,
  PasswordForgotSchema,
  PasswordResetSchema,
  SessionViewSchema,
  SwitchOrganizationSchema,
} from '@oxrana/contracts';
import { organizationOfToken, schema, userOrganizations, withOrganization } from '@oxrana/db';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assertPasswordStrong,
  hashPassword,
  randomDigits,
  randomToken,
  sha256Hex,
  verifyAgainstDummy,
  verifyPassword,
} from '../../auth/crypto';
import { loginHash, normalizeEmail, normalizePhone, parseLogin } from '../../auth/login';
import { sessionToken, userActor } from '../../auth/resolve';
import {
  assertIpNotThrottled,
  assertLoginNotThrottled,
  mayRequestMessage,
} from '../../auth/throttle';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../errors';
import {
  buildMe,
  endSessionCookie,
  findUserByLogin,
  firstOrganization,
  insertAudit,
  recordUserAuth,
  revokeUserSessions,
  startSession,
  type UserRow,
} from './session';

/** Срок ссылки восстановления пароля и кода входа. */
export const RESET_LINK_TTL_MS = 60 * 60_000;
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
const LOGIN_CODE_MAX_ATTEMPTS = 5;

const SENT_MESSAGE =
  'Если такой пользователь есть, мы отправили ему сообщение. Проверьте почту или SMS.';

/** Ссылка установки пароля: токен — во фрагменте `#…`, он не уходит на сервер и в журналы. */
export function passwordLink(deps: AppDeps, token: string): string {
  return `${deps.auth.publicUrl}/password#${token}`;
}

export function invitationLink(deps: AppDeps, token: string): string {
  return `${deps.auth.publicUrl}/invite#${token}`;
}

/** Одноразовая ссылка установки пароля (`password_resets`), в БД — хэш. */
export async function issuePasswordLink(
  deps: AppDeps,
  userId: string,
  purpose: 'setup' | 'reset',
  createdBy: string | null,
  ttlMs = RESET_LINK_TTL_MS,
): Promise<{ link: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(deps.clock.now() + ttlMs);
  await deps.db.insert(schema.passwordResets).values({
    userId,
    purpose,
    tokenHash: sha256Hex(token),
    expiresAt,
    createdBy,
  });
  return { link: passwordLink(deps, token), expiresAt };
}

async function meOf(deps: AppDeps, userId: string, organizationId: string, sessionId: string) {
  const actor = await userActor(deps.db, organizationId, userId, sessionId);
  if (!actor) throw new AppError('unauthenticated');
  return buildMe(deps.db, actor);
}

/** Вход: сессия, журнал входа, аудит организации, «кто я». */
async function signIn(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  hash: string | null,
) {
  const organizationId = await firstOrganization(deps.db, user.id);
  const sessionId = await startSession(deps, request, reply, user.id, organizationId);
  await recordUserAuth(deps, request, 'login', user, hash);
  return meOf(deps, user.id, organizationId, sessionId);
}

/** Неудачная проверка ссылки или токена: в журнал входа (ограничение попыток по IP). */
async function linkFailed(deps: AppDeps, request: FastifyRequest): Promise<AppError> {
  await recordUserAuth(deps, request, 'link_failed', null);
  return new AppError('link_invalid');
}

async function loadPasswordLink(deps: AppDeps, token: string) {
  const now = new Date(deps.clock.now());
  const [row] = await deps.db
    .select({ link: schema.passwordResets, user: schema.users })
    .from(schema.passwordResets)
    .innerJoin(schema.users, eq(schema.users.id, schema.passwordResets.userId))
    .where(
      and(
        eq(schema.passwordResets.tokenHash, sha256Hex(token)),
        isNull(schema.passwordResets.usedAt),
        gt(schema.passwordResets.expiresAt, now),
      ),
    );
  if (!row || row.user.status === 'disabled') return null;
  return row;
}

async function loadInvitation(deps: AppDeps, token: string) {
  const hash = sha256Hex(token);
  const organizationId = await organizationOfToken(deps.db, 'invitation', hash);
  if (!organizationId) return null;
  const now = new Date(deps.clock.now());
  return withOrganization(deps.db, organizationId, async (tx) => {
    const [row] = await tx
      .select({
        invitation: schema.invitations,
        roleName: schema.roles.name,
        organizationName: schema.organizations.name,
        siteName: schema.sites.name,
        tenantName: schema.tenants.shortName,
      })
      .from(schema.invitations)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.invitations.roleId))
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.invitations.organizationId),
      )
      .leftJoin(schema.sites, eq(schema.sites.id, schema.invitations.siteId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.invitations.tenantId))
      .where(
        and(
          eq(schema.invitations.organizationId, organizationId),
          eq(schema.invitations.tokenHash, hash),
          isNull(schema.invitations.acceptedAt),
          isNull(schema.invitations.revokedAt),
          gt(schema.invitations.expiresAt, now),
          isNull(schema.roles.deletedAt),
        ),
      );
    return row ? { ...row, organizationId } : null;
  });
}

async function userForInvitation(
  deps: AppDeps,
  invitation: { email: string | null; phone: string | null },
): Promise<UserRow | null> {
  const conditions = [
    invitation.email ? eq(schema.users.email, normalizeEmail(invitation.email)) : undefined,
    invitation.phone ? eq(schema.users.phone, normalizePhone(invitation.phone)) : undefined,
  ].filter((c) => c !== undefined);
  if (conditions.length === 0) return null;
  const [user] = await deps.db
    .select()
    .from(schema.users)
    .where(or(...conditions));
  return user ?? null;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['auth'];
  const deps = () => app.deps;

  typed.post(
    '/auth/login',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Вход по логину (e-mail или телефон) и паролю: cookie-сессия',
        body: LoginRequestSchema,
        response: { 200: MeSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const now = d.clock.now();
      const ip = request.ip ?? null;
      await assertIpNotThrottled(d.db, ip, now);
      const login = parseLogin(request.body.login);
      const hash = loginHash(login);
      await assertLoginNotThrottled(d.db, hash, now);
      const user = await findUserByLogin(d.db, login);
      let ok = false;
      if (user?.passwordHash) ok = await verifyPassword(user.passwordHash, request.body.password);
      else await verifyAgainstDummy(request.body.password);
      // Одна и та же ошибка для неизвестного логина и неверного пароля (ADR-018).
      if (!user || !ok) {
        await recordUserAuth(d, request, 'login_failed', user, hash);
        throw new AppError('invalid_credentials');
      }
      if (user.status !== 'active') {
        await recordUserAuth(d, request, 'login_failed', user, hash);
        throw new AppError('account_disabled');
      }
      return signIn(d, request, reply, user, hash);
    },
  );

  typed.post(
    '/auth/logout',
    {
      config: { public: true },
      schema: { tags, summary: 'Выход: сессия отзывается, cookie удаляется' },
    },
    async (request, reply) => {
      const d = deps();
      const token = sessionToken(request);
      if (token) {
        const [row] = await d.db
          .update(schema.sessions)
          .set({ revokedAt: new Date(d.clock.now()) })
          .where(
            and(eq(schema.sessions.tokenHash, sha256Hex(token)), isNull(schema.sessions.revokedAt)),
          )
          .returning({ userId: schema.sessions.userId });
        if (row) await recordUserAuth(d, request, 'logout', { id: row.userId });
      }
      endSessionCookie(d, reply);
      return reply.status(204).send();
    },
  );

  typed.post(
    '/auth/logout-all',
    {
      config: { self: true },
      schema: { tags, summary: 'Выйти на всех устройствах: отзываются все сессии пользователя' },
    },
    async (request, reply) => {
      const d = deps();
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      await revokeUserSessions(d.db, actor.id, d.clock.now());
      await recordUserAuth(d, request, 'logout_all', { id: actor.id });
      endSessionCookie(d, reply);
      return reply.status(204).send();
    },
  );

  typed.get(
    '/auth/me',
    {
      config: { authenticated: true },
      schema: {
        tags,
        summary: 'Кто вошёл: пользователь или устройство поста',
        response: { 200: MeSchema },
      },
    },
    async (request) => {
      if (!request.actor) throw new AppError('unauthenticated');
      return buildMe(deps().db, request.actor);
    },
  );

  typed.post(
    '/auth/organization',
    {
      config: { self: true },
      schema: {
        tags,
        summary: 'Сменить организацию сессии (если их у пользователя несколько)',
        body: SwitchOrganizationSchema,
        response: { 200: MeSchema },
      },
    },
    async (request) => {
      const d = deps();
      const actor = request.actor;
      if (!actor?.sessionId) throw new AppError('unauthenticated');
      const orgs = await userOrganizations(d.db, actor.id);
      if (!orgs.includes(request.body.organizationId)) {
        throw new AppError('forbidden', { message: 'У вас нет ролей в этой организации.' });
      }
      await d.db
        .update(schema.sessions)
        .set({ organizationId: request.body.organizationId })
        .where(eq(schema.sessions.id, actor.sessionId));
      return meOf(d, actor.id, request.body.organizationId, actor.sessionId);
    },
  );

  typed.get(
    '/auth/sessions',
    {
      config: { self: true },
      schema: {
        tags,
        summary: 'Мои сессии: где выполнен вход',
        response: { 200: z.object({ items: z.array(SessionViewSchema) }) },
      },
    },
    async (request) => {
      const d = deps();
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      const rows = await d.db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, actor.id),
            isNull(schema.sessions.revokedAt),
            gt(schema.sessions.expiresAt, new Date(d.clock.now())),
          ),
        )
        .orderBy(desc(schema.sessions.lastSeenAt));
      return {
        items: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
          expiresAt: r.expiresAt.toISOString(),
          ip: r.ip,
          userAgent: r.userAgent,
          current: r.id === actor.sessionId,
        })),
      };
    },
  );

  typed.post(
    '/auth/sessions/:id/revoke',
    {
      config: { self: true },
      schema: { tags, summary: 'Завершить одну свою сессию', params: IdParamsSchema },
    },
    async (request, reply) => {
      const d = deps();
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      const [row] = await d.db
        .update(schema.sessions)
        .set({ revokedAt: new Date(d.clock.now()) })
        .where(
          and(
            eq(schema.sessions.id, request.params.id),
            eq(schema.sessions.userId, actor.id),
            isNull(schema.sessions.revokedAt),
          ),
        )
        .returning({ id: schema.sessions.id });
      if (!row)
        throw new AppError('not_found', { message: 'Сессия не найдена или уже завершена.' });
      await recordUserAuth(d, request, 'session_revoked', { id: actor.id });
      if (row.id === actor.sessionId) endSessionCookie(d, reply);
      return reply.status(204).send();
    },
  );

  typed.post(
    '/auth/password/change',
    {
      config: { self: true },
      schema: {
        tags,
        summary: 'Сменить свой пароль: остальные сессии завершаются',
        body: PasswordChangeSchema,
      },
    },
    async (request, reply) => {
      const d = deps();
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      await assertIpNotThrottled(d.db, request.ip ?? null, d.clock.now());
      const [user] = await d.db.select().from(schema.users).where(eq(schema.users.id, actor.id));
      if (
        !user?.passwordHash ||
        !(await verifyPassword(user.passwordHash, request.body.currentPassword))
      ) {
        await recordUserAuth(d, request, 'login_failed', user ?? null);
        throw new AppError('invalid_credentials', {
          field: 'currentPassword',
          message: 'Текущий пароль указан неверно.',
        });
      }
      assertPasswordStrong(request.body.newPassword, 'newPassword');
      await d.db
        .update(schema.users)
        .set({
          passwordHash: await hashPassword(request.body.newPassword),
          mustChangePassword: false,
        })
        .where(eq(schema.users.id, user.id));
      await revokeUserSessions(d.db, user.id, d.clock.now(), actor.sessionId ?? null);
      await recordUserAuth(d, request, 'password_changed', user);
      return reply.status(204).send();
    },
  );

  typed.post(
    '/auth/password/forgot',
    {
      config: { public: true },
      schema: {
        tags,
        summary:
          'Восстановление пароля: ссылка на e-mail или SMS (ответ не раскрывает, есть ли логин)',
        body: PasswordForgotSchema,
        response: { 202: AcceptedSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const login = parseLogin(request.body.login);
      const hash = loginHash(login);
      const send = await mayRequestMessage(d.db, hash, request.ip ?? null, d.clock.now());
      const user = await findUserByLogin(d.db, login);
      await recordUserAuth(d, request, 'password_reset_requested', null, hash);
      if (send && user && user.status === 'active') {
        const { link } = await issuePasswordLink(d, user.id, 'reset', null);
        await d.auth.messenger.send({
          kind: 'password_reset',
          to: { email: user.email, phone: user.phone },
          link,
        });
      }
      return reply.status(202).send({ message: SENT_MESSAGE });
    },
  );

  typed.post(
    '/auth/password/inspect',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Проверить ссылку установки пароля (токен — в теле, не в адресе)',
        body: LinkInspectSchema,
        response: { 200: LinkInfoSchema },
      },
    },
    async (request) => {
      const d = deps();
      await assertIpNotThrottled(d.db, request.ip ?? null, d.clock.now());
      const row = await loadPasswordLink(d, request.body.token);
      if (!row) throw await linkFailed(d, request);
      return {
        purpose: row.link.purpose,
        fullName: row.user.fullName,
        expiresAt: row.link.expiresAt.toISOString(),
      };
    },
  );

  typed.post(
    '/auth/password/reset',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Установить пароль по одноразовой ссылке: все прежние сессии завершаются, вход',
        body: PasswordResetSchema,
        response: { 200: MeSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const now = d.clock.now();
      await assertIpNotThrottled(d.db, request.ip ?? null, now);
      assertPasswordStrong(request.body.password);
      const row = await loadPasswordLink(d, request.body.token);
      if (!row) throw await linkFailed(d, request);
      const passwordHash = await hashPassword(request.body.password);
      // Ссылка одноразовая: второй запрос с тем же токеном не найдёт неиспользованную строку.
      const [used] = await d.db
        .update(schema.passwordResets)
        .set({ usedAt: new Date(now) })
        .where(and(eq(schema.passwordResets.id, row.link.id), isNull(schema.passwordResets.usedAt)))
        .returning({ id: schema.passwordResets.id });
      if (!used) throw await linkFailed(d, request);
      await d.db
        .update(schema.users)
        .set({ passwordHash, mustChangePassword: false, status: 'active' })
        .where(eq(schema.users.id, row.user.id));
      await revokeUserSessions(d.db, row.user.id, now);
      await recordUserAuth(d, request, 'password_set', row.user);
      return signIn(d, request, reply, row.user, null);
    },
  );

  typed.post(
    '/auth/code/request',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Код входа на e-mail или SMS (ответ не раскрывает, есть ли логин)',
        body: LoginCodeRequestSchema,
        response: { 202: AcceptedSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const now = d.clock.now();
      const login = parseLogin(request.body.login);
      const hash = loginHash(login);
      const send = await mayRequestMessage(d.db, hash, request.ip ?? null, now);
      const user = await findUserByLogin(d.db, login);
      await recordUserAuth(d, request, 'login_code_requested', null, hash);
      if (send && user && user.status === 'active') {
        // Новый код отменяет прежние неиспользованные.
        await d.db
          .update(schema.loginCodes)
          .set({ usedAt: new Date(now) })
          .where(and(eq(schema.loginCodes.userId, user.id), isNull(schema.loginCodes.usedAt)));
        const code = randomDigits(6);
        await d.db.insert(schema.loginCodes).values({
          userId: user.id,
          codeHash: sha256Hex(`${user.id}:${code}`),
          expiresAt: new Date(now + LOGIN_CODE_TTL_MS),
        });
        await d.auth.messenger.send({
          kind: 'login_code',
          to: { email: user.email, phone: user.phone },
          code,
        });
      }
      return reply.status(202).send({ message: SENT_MESSAGE });
    },
  );

  typed.post(
    '/auth/code/verify',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Вход по коду: 10 минут, не больше 5 попыток',
        body: LoginCodeVerifySchema,
        response: { 200: MeSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const now = d.clock.now();
      await assertIpNotThrottled(d.db, request.ip ?? null, now);
      const login = parseLogin(request.body.login);
      const hash = loginHash(login);
      await assertLoginNotThrottled(d.db, hash, now);
      const user = await findUserByLogin(d.db, login);
      const [code] = user
        ? await d.db
            .select()
            .from(schema.loginCodes)
            .where(
              and(
                eq(schema.loginCodes.userId, user.id),
                isNull(schema.loginCodes.usedAt),
                gt(schema.loginCodes.expiresAt, new Date(now)),
              ),
            )
            .orderBy(desc(schema.loginCodes.createdAt))
            .limit(1)
        : [];
      const matches =
        user && code && code.attempts < LOGIN_CODE_MAX_ATTEMPTS
          ? code.codeHash === sha256Hex(`${user.id}:${request.body.code}`)
          : false;
      if (!user || !code || !matches || user.status !== 'active') {
        if (code) {
          await d.db
            .update(schema.loginCodes)
            .set({ attempts: code.attempts + 1 })
            .where(eq(schema.loginCodes.id, code.id));
        }
        await recordUserAuth(d, request, 'login_code_failed', user, hash);
        throw new AppError('code_invalid', { field: 'code' });
      }
      const [used] = await d.db
        .update(schema.loginCodes)
        .set({ usedAt: new Date(now) })
        .where(and(eq(schema.loginCodes.id, code.id), isNull(schema.loginCodes.usedAt)))
        .returning({ id: schema.loginCodes.id });
      if (!used) throw new AppError('code_invalid', { field: 'code' });
      return signIn(d, request, reply, user, hash);
    },
  );

  typed.post(
    '/auth/invitations/inspect',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Проверить приглашение (токен — в теле, не в адресе)',
        body: LinkInspectSchema,
        response: { 200: InvitationInfoSchema },
      },
    },
    async (request) => {
      const d = deps();
      await assertIpNotThrottled(d.db, request.ip ?? null, d.clock.now());
      const row = await loadInvitation(d, request.body.token);
      if (!row) throw await linkFailed(d, request);
      const existing = await userForInvitation(d, row.invitation);
      return {
        organizationName: row.organizationName,
        roleName: row.roleName,
        siteName: row.siteName,
        tenantName: row.tenantName,
        fullName: row.invitation.fullName,
        email: row.invitation.email,
        phone: row.invitation.phone,
        expiresAt: row.invitation.expiresAt.toISOString(),
        existingAccount: existing?.passwordHash != null,
      };
    },
  );

  typed.post(
    '/auth/invitations/accept',
    {
      config: { public: true },
      schema: {
        tags,
        summary:
          'Принять приглашение: пароль, согласие на ПДн; роль назначается, вход выполняется сразу',
        body: InvitationAcceptSchema,
        response: { 200: MeSchema },
      },
    },
    async (request, reply) => {
      const d = deps();
      const now = d.clock.now();
      await assertIpNotThrottled(d.db, request.ip ?? null, now);
      const row = await loadInvitation(d, request.body.token);
      if (!row) throw await linkFailed(d, request);
      const { invitation, organizationId } = row;
      let user = await userForInvitation(d, invitation);
      if (user?.status === 'disabled') throw new AppError('account_disabled');

      if (user?.passwordHash) {
        // Есть учётная запись: приглашение принимается её паролем, а не перезаписывает его.
        if (!(await verifyPassword(user.passwordHash, request.body.password))) {
          await recordUserAuth(d, request, 'login_failed', user);
          throw new AppError('account_exists', { field: 'password' });
        }
        [user = user] = await d.db
          .update(schema.users)
          .set({ consentAt: new Date(now) })
          .where(eq(schema.users.id, user.id))
          .returning();
      } else {
        // Учётная запись уже работает, но пароль ещё не задан (владелец после чистого старта):
        // приглашение не задаёт ей пароль — иначе пригласивший мог бы войти под ней.
        if (user && (await userOrganizations(d.db, user.id)).length > 0) {
          throw new AppError('account_exists', {
            message:
              'У этой учётной записи ещё не задан пароль. Задайте его по своей ссылке установки пароля, затем примите приглашение.',
          });
        }
        assertPasswordStrong(request.body.password);
        const fullName = request.body.fullName ?? invitation.fullName;
        if (!fullName) {
          throw new AppError('validation_failed', {
            field: 'fullName',
            message: 'Укажите фамилию и имя.',
          });
        }
        const values = {
          fullName,
          passwordHash: await hashPassword(request.body.password),
          status: 'active' as const,
          consentAt: new Date(now),
        };
        if (user) {
          [user = user] = await d.db
            .update(schema.users)
            .set(values)
            .where(eq(schema.users.id, user.id))
            .returning();
        } else {
          [user = user] = await d.db
            .insert(schema.users)
            .values({
              ...values,
              email: invitation.email ? normalizeEmail(invitation.email) : null,
              phone: invitation.phone ? normalizePhone(invitation.phone) : null,
            })
            .returning();
        }
      }
      if (!user) throw new Error('user upsert');
      const userId = user.id;

      const accepted = await withOrganization(d.db, organizationId, async (tx) => {
        const [done] = await tx
          .update(schema.invitations)
          .set({ acceptedAt: new Date(now), acceptedUserId: userId })
          .where(
            and(eq(schema.invitations.id, invitation.id), isNull(schema.invitations.acceptedAt)),
          )
          .returning({ id: schema.invitations.id });
        if (!done) return false;
        await tx
          .insert(schema.roleAssignments)
          .values({
            organizationId,
            userId,
            roleId: invitation.roleId,
            siteId: invitation.siteId,
            tenantId: invitation.tenantId,
          })
          .onConflictDoNothing();
        await insertAudit(tx, {
          organizationId,
          at: new Date(now),
          actorType: 'user',
          actorUserId: userId,
          requestId: request.id,
          ip: request.ip ?? null,
          siteId: invitation.siteId,
          entity: 'invitation',
          entityId: invitation.id,
          action: 'accept',
          snapshot: { role: row.roleName, tenant: row.tenantName, site: row.siteName },
        });
        return true;
      });
      if (!accepted) throw await linkFailed(d, request);
      await recordUserAuth(d, request, 'invitation_accepted', user);
      const sessionId = await startSession(d, request, reply, userId, organizationId);
      await recordUserAuth(d, request, 'login', user);
      return meOf(d, userId, organizationId, sessionId);
    },
  );
}

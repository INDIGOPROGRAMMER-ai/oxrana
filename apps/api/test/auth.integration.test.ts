import { Writable } from 'node:stream';
import { ErrorBodySchema } from '@oxrana/contracts';
import { createDb, schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/crypto';
import { MemoryMessenger } from '../src/auth/messenger';
import { FixedClock } from '../src/clock';
import { loggerOptions } from '../src/logger';
import {
  appPool,
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  roleIdOf,
  seedDemo,
  startTestApp,
  TEST_ORIGIN,
  type TestApp,
} from './support/harness';

/**
 * Вход и сессии (ADR-007, ADR-018): пароль argon2id, cookie httpOnly, защита от CSRF, ограничение
 * попыток, одинаковая ошибка для неизвестного логина и неверного пароля, коды входа, восстановление
 * пароля и приглашения — одноразовые, в БД только хэши; вход и неудачи — в аудите, секреты — нигде
 * в журналах.
 */
let t: TestApp;
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const dns = KEYS.tenants.dns ?? '';
const roleId = roleIdOf;
const PASSWORD = 'Пароль-для-теста-42';

let userCounter = 0;
/** Пользователь с паролем и ролью демо-организации (выдуманные данные). */
async function createUser(
  code = 'site_admin',
  scope: { siteId?: string | null; tenantId?: string | null } = { siteId: KEYS.siteId },
) {
  userCounter++;
  const email = `user${userCounter}@example.test`;
  const [user] = await ownerDb()
    .insert(schema.users)
    .values({
      fullName: `Пользователь ${userCounter}`,
      email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'active',
    })
    .returning();
  if (!user) throw new Error('user');
  await ownerDb()
    .insert(schema.roleAssignments)
    .values({
      organizationId: KEYS.organizationId,
      userId: user.id,
      roleId: roleId(code),
      siteId: scope.siteId ?? null,
      tenantId: scope.tenantId ?? null,
    });
  return { user, email };
}

function login(loginName: string, password: string, headers: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: TEST_ORIGIN, ...headers },
    payload: { login: loginName, password },
  });
}

/** cookie `sid=…` из ответа входа. */
function sid(res: { headers: Record<string, unknown> }): string {
  const header = String(res.headers['set-cookie'] ?? '');
  const match = /sid=([^;]*)/.exec(header);
  if (!match?.[1]) throw new Error(`нет cookie сессии: ${header}`);
  return `sid=${match[1]}`;
}

const me = (cookie: string) => t.app.inject({ url: '/auth/me', headers: { cookie } });

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

describe('вход по паролю', () => {
  it('вход ставит cookie httpOnly + SameSite=Lax; пароль в БД — argon2id; «кто я» — роли и права', async () => {
    const { user, email } = await createUser();
    const res = await login(email.toUpperCase(), PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(
      /^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const body = (await me(sid(res))).json();
    expect(body).toMatchObject({
      kind: 'user',
      id: user.id,
      organization: { id: KEYS.organizationId },
      user: { email, assignments: [{ roleName: 'Администратор объекта', siteId: KEYS.siteId }] },
    });
    expect(body.permissions).toContain('pass.approve');
    expect(body.permissions).not.toContain('visit.check_in');
    // в БД — только хэш токена сессии
    const token = sid(res).slice(4);
    const rows = await ownerDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(rows.map((r) => r.tokenHash)).not.toContain(token);
  });

  it('неизвестный логин и неверный пароль — одна и та же ошибка, без подсказки', async () => {
    const { email } = await createUser();
    const wrong = await login(email, 'неверный-пароль-123');
    const unknown = await login('nobody@example.test', 'неверный-пароль-123');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const { requestId: _a, ...a } = error(wrong);
    const { requestId: _b, ...b } = error(unknown);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ code: 'invalid_credentials', message: 'Неверный логин или пароль.' });
  });

  it('пять неудач подряд — логин заблокирован на 15 минут даже с верным паролем; другой логин работает', async () => {
    const { email } = await createUser();
    const other = await createUser();
    for (let i = 0; i < 5; i++)
      expect((await login(email, `неверно-${i}-xxxx`)).statusCode).toBe(401);
    const blocked = await login(email, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(error(blocked).code).toBe('too_many_attempts');
    // неизвестный логин блокируется так же — ответ не выдаёт, есть ли он
    for (let i = 0; i < 5; i++) await login('ghost@example.test', `неверно-${i}-xxxx`);
    expect((await login('ghost@example.test', PASSWORD)).statusCode).toBe(429);
    expect((await login(other.email, PASSWORD)).statusCode).toBe(200);
    t.clock.advance(15 * 60_000 + 1000);
    expect((await login(email, PASSWORD)).statusCode).toBe(200);
  });

  it('неудачи и входы — в аудите организации и в журнале входа; логин в журнале — только хэшем', async () => {
    const { user, email } = await createUser();
    await login(email, 'неверный-пароль-777');
    await login(email, PASSWORD);
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'user'), eq(schema.auditLog.entityId, user.id)));
    expect(audit.map((a) => a.action)).toEqual(['login_failed', 'login']);
    expect(audit.every((a) => a.organizationId === KEYS.organizationId)).toBe(true);
    const events = await ownerDb()
      .select()
      .from(schema.authEvents)
      .where(eq(schema.authEvents.userId, user.id));
    expect(events.map((e) => e.kind)).toEqual(['login_failed', 'login']);
    expect(JSON.stringify(events)).not.toContain(email);
  });

  it('отключённую учётку не впускает, её сессии завершены сразу', async () => {
    const { user, email } = await createUser('tenant_manager', {
      siteId: KEYS.siteId,
      tenantId: dns,
    });
    const cookie = sid(await login(email, PASSWORD));
    const owner = roleActor('org_owner');
    const res = await t.as(owner, {
      method: 'POST',
      url: `/users/${user.id}/disable`,
      payload: { reason: 'Уволился' },
    });
    expect(res.statusCode).toBe(200);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(error(await login(email, PASSWORD)).code).toBe('account_disabled');
  });
});

describe('выход и сессии', () => {
  it('выход отзывает сессию; «выйти на всех устройствах» — все сессии пользователя', async () => {
    const { email } = await createUser();
    const a = sid(await login(email, PASSWORD));
    const b = sid(await login(email, PASSWORD));
    const c = sid(await login(email, PASSWORD));
    const out = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: a, origin: TEST_ORIGIN },
    });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(200);
    const list = await t.app.inject({ url: '/auth/sessions', headers: { cookie: b } });
    expect(list.json().items).toHaveLength(2);
    const all = await t.app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { cookie: b, origin: TEST_ORIGIN },
    });
    expect(all.statusCode).toBe(204);
    expect((await me(b)).statusCode).toBe(401);
    expect((await me(c)).statusCode).toBe(401);
  });

  it('смена пароля: старый пароль неверен — ошибка; новый слабый — ошибка; другие сессии завершены', async () => {
    const { email } = await createUser();
    const a = sid(await login(email, PASSWORD));
    const b = sid(await login(email, PASSWORD));
    const change = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { cookie: a, origin: TEST_ORIGIN },
        payload,
      });
    expect(
      error(await change({ currentPassword: 'не тот пароль', newPassword: 'Новый-пароль-2026' }))
        .code,
    ).toBe('invalid_credentials');
    expect(error(await change({ currentPassword: PASSWORD, newPassword: '1234567890' })).code).toBe(
      'password_weak',
    );
    expect(
      (await change({ currentPassword: PASSWORD, newPassword: 'Новый-пароль-2026' })).statusCode,
    ).toBe(204);
    expect((await me(a)).statusCode).toBe(200);
    expect((await me(b)).statusCode).toBe(401);
    expect((await login(email, 'Новый-пароль-2026')).statusCode).toBe(200);
  });
});

describe('защита от CSRF (проверка Origin)', () => {
  it('изменяющий запрос с cookie с чужого сайта или без Origin и Referer — 403, со своего — проходит', async () => {
    const { email } = await createUser();
    const cookie = sid(await login(email, PASSWORD));
    const call = (headers: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { cookie, ...headers },
        payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
      });
    const foreign = await call({ origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(error(foreign).code).toBe('csrf_failed');
    expect(error(await call({})).code).toBe('csrf_failed');
    expect(error(await call({ referer: 'https://evil.example/page' })).code).toBe('csrf_failed');
    expect((await call({ referer: `${TEST_ORIGIN}/admin` })).statusCode).toBe(204);
    expect((await call({ origin: TEST_ORIGIN })).statusCode).toBe(204);
    // вход с чужого сайта (подмена сессии) — тоже отказ
    expect(error(await login(email, PASSWORD, { origin: 'https://evil.example' })).code).toBe(
      'csrf_failed',
    );
  });

  it('чтение (GET) и запросы устройства с токеном без cookie проверку Origin не проходят — не нужно', async () => {
    const { email } = await createUser();
    const cookie = sid(await login(email, PASSWORD));
    const res = await t.app.inject({
      url: '/auth/me',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('восстановление пароля и коды входа', () => {
  it('восстановление: одинаковый ответ для любого логина; ссылка одноразовая, в БД — хэш; старые сессии завершены', async () => {
    const { user, email } = await createUser();
    const old = sid(await login(email, PASSWORD));
    const forgot = (loginName: string) =>
      t.app.inject({
        method: 'POST',
        url: '/auth/password/forgot',
        headers: { origin: TEST_ORIGIN },
        payload: { login: loginName },
      });
    const known = await forgot(email);
    const unknown = await forgot('nobody@example.test');
    expect(known.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    const message = t.messenger.last('password_reset');
    expect(message?.to.email).toBe(email);
    const token = message?.link?.split('#')[1] ?? '';
    expect(message?.link).toBe(`${TEST_ORIGIN}/password#${token}`);
    const stored = await ownerDb()
      .select()
      .from(schema.passwordResets)
      .where(eq(schema.passwordResets.userId, user.id));
    expect(stored.map((r) => r.tokenHash)).not.toContain(token);

    const inspect = await t.as(null, {
      method: 'POST',
      url: '/auth/password/inspect',
      payload: { token },
    });
    expect(inspect.json()).toMatchObject({ purpose: 'reset', fullName: user.fullName });
    const reset = await t.as(null, {
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, password: 'Совсем-новый-пароль' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await me(old)).statusCode).toBe(401);
    expect((await me(sid(reset))).statusCode).toBe(200);
    const again = await t.as(null, {
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, password: 'Ещё-один-пароль-1' },
    });
    expect(again.statusCode).toBe(410);
    expect(error(again).code).toBe('link_invalid');
  });

  it('код входа: 6 цифр на 10 минут, неверный — ошибка, после 5 неверных код не принимается', async () => {
    const { email } = await createUser();
    const request = () =>
      t.as(null, { method: 'POST', url: '/auth/code/request', payload: { login: email } });
    expect((await request()).statusCode).toBe(202);
    const code = t.messenger.last('login_code')?.code ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const verify = (value: string) =>
      t.as(null, {
        method: 'POST',
        url: '/auth/code/verify',
        payload: { login: email, code: value },
      });
    const wrong = code === '000000' ? '111111' : '000000';
    expect(error(await verify(wrong)).code).toBe('code_invalid');
    const ok = await verify(code);
    expect(ok.statusCode).toBe(200);
    expect(error(await verify(code)).code).toBe('code_invalid');

    await request();
    const second = t.messenger.last('login_code')?.code ?? '';
    for (let i = 0; i < 5; i++) await verify(second === '000000' ? '222222' : '000000');
    // пять неудач: и код исчерпан, и логин придержан
    expect((await verify(second)).statusCode).toBeGreaterThanOrEqual(401);
    t.clock.advance(16 * 60_000);
    expect(error(await verify(second)).code).toBe('code_invalid');
  });
});

describe('приглашения', () => {
  it('администратор приглашает → ссылка один раз, в БД хэш → человек задаёт пароль, даёт согласие и сразу работает', async () => {
    const admin = roleActor('site_admin');
    const res = await t.as(admin, {
      method: 'POST',
      url: '/invitations',
      payload: {
        email: 'Logist.New@Example.test',
        fullName: 'Петров Пётр',
        roleId: roleId('tenant_manager'),
        tenantId: dns,
      },
    });
    expect(res.statusCode).toBe(201);
    const { link, invitation } = res.json();
    expect(invitation).toMatchObject({
      email: 'logist.new@example.test',
      status: 'pending',
      siteId: KEYS.siteId,
    });
    const token = String(link).split('#')[1] ?? '';
    expect(link).toBe(`${TEST_ORIGIN}/invite#${token}`);
    expect(t.messenger.last('invitation')?.link).toBe(link);
    const [row] = await ownerDb()
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, invitation.id));
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.expiresAt.getTime()).toBe(t.clock.now() + 7 * 86_400_000);

    const info = await t.as(null, {
      method: 'POST',
      url: '/auth/invitations/inspect',
      payload: { token },
    });
    expect(info.json()).toMatchObject({
      roleName: 'Арендатор — ответственный',
      tenantName: expect.any(String),
      existingAccount: false,
    });
    const accept = (payload: object) =>
      t.as(null, {
        method: 'POST',
        url: '/auth/invitations/accept',
        payload: { token, ...payload },
      });
    expect(error(await accept({ password: '12345678901', consent: true })).code).toBe(
      'password_weak',
    );
    expect((await accept({ password: 'Надёжный-пароль-1', consent: false })).statusCode).toBe(400);
    const ok = await accept({ password: 'Надёжный-пароль-1', consent: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      kind: 'user',
      user: {
        fullName: 'Петров Пётр',
        assignments: [{ tenantId: dns, roleName: 'Арендатор — ответственный' }],
      },
    });
    const [user] = await ownerDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'logist.new@example.test'));
    expect(user?.consentAt).not.toBeNull();
    // ссылка одноразовая
    expect(error(await accept({ password: 'Надёжный-пароль-1', consent: true })).code).toBe(
      'link_invalid',
    );
    // работает сразу: видит пропуска своей компании
    const passes = await t.app.inject({
      url: `/sites/${KEYS.siteId}/passes`,
      headers: { cookie: sid(ok) },
    });
    expect(passes.statusCode).toBe(200);
  });

  it('у приглашённого уже есть учётная запись: приглашение принимается его паролем, а не перезаписывает его', async () => {
    const { email } = await createUser('tenant_viewer', { siteId: KEYS.siteId, tenantId: dns });
    const res = await t.as(roleActor('org_owner'), {
      method: 'POST',
      url: '/invitations',
      payload: { email, roleId: roleId('tenant_viewer'), tenantId: KEYS.tenants.x5 },
    });
    const token = String(res.json().link).split('#')[1] ?? '';
    const accept = (password: string) =>
      t.as(null, {
        method: 'POST',
        url: '/auth/invitations/accept',
        payload: { token, password, consent: true },
      });
    expect(error(await accept('Чужой-пароль-12345')).code).toBe('account_exists');
    const ok = await accept(PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.assignments).toHaveLength(2);
  });

  it('ответственный арендатора приглашает только в свою компанию и только не шире своих прав', async () => {
    const manager = roleActor('tenant_manager', { tenantIds: [dns] });
    const invite = (payload: object) =>
      t.as(manager, {
        method: 'POST',
        url: '/invitations',
        payload: { email: 'x@example.test', ...payload },
      });
    const own = await invite({ roleId: roleId('tenant_requester'), tenantId: dns });
    expect(own.statusCode, own.body).toBe(201);
    const foreign = await invite({ roleId: roleId('tenant_requester'), tenantId: KEYS.tenants.x5 });
    expect(foreign.statusCode).toBe(403);
    const broader = await invite({ roleId: roleId('site_admin'), tenantId: dns });
    expect(error(broader).code).toBe('role_too_broad');
    const siteWide = await invite({ roleId: roleId('tenant_viewer') });
    expect(siteWide.statusCode).toBe(403);
    // администратор объекта не выдаёт роль на всю организацию
    const admin = await t.as(roleActor('site_admin'), {
      method: 'POST',
      url: '/invitations',
      payload: { email: 'y@example.test', roleId: roleId('accountant') },
    });
    expect(error(admin).code).toBe('role_too_broad');
  });
});

describe('администратор не получает больше прав, чем имеет', () => {
  it('администратор объекта не сбрасывает пароль и не отключает владельца, не меняет роль владельца', async () => {
    const { user: owner } = await createUser('org_owner', { siteId: null });
    const admin = roleActor('site_admin');
    const reset = await t.as(admin, { method: 'POST', url: `/users/${owner.id}/password-reset` });
    expect(error(reset).code).toBe('role_too_broad');
    const disable = await t.as(admin, {
      method: 'POST',
      url: `/users/${owner.id}/disable`,
      payload: { reason: 'Попытка' },
    });
    expect(error(disable).code).toBe('role_too_broad');
    const edit = await t.as(admin, {
      method: 'PATCH',
      url: `/roles/${roleId('org_owner')}`,
      payload: { permissions: ['report.view'] },
    });
    expect(error(edit).code).toBe('role_too_broad');
    // а своего уровня — может: ссылка выдаётся один раз
    const { user: logist } = await createUser('tenant_viewer', {
      siteId: KEYS.siteId,
      tenantId: dns,
    });
    const ok = await t.as(admin, { method: 'POST', url: `/users/${logist.id}/password-reset` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().link).toMatch(/\/password#/);
  });

  it('приглашение на e-mail работающей учётки без пароля не задаёт ей пароль', async () => {
    const [owner] = await ownerDb()
      .insert(schema.users)
      .values({ fullName: 'Владелец без пароля', email: 'nopass@example.test', status: 'active' })
      .returning();
    await ownerDb()
      .insert(schema.roleAssignments)
      .values({
        organizationId: KEYS.organizationId,
        userId: owner?.id ?? '',
        roleId: roleId('org_owner'),
      });
    const res = await t.as(roleActor('org_owner'), {
      method: 'POST',
      url: '/invitations',
      payload: { email: 'nopass@example.test', roleId: roleId('tenant_viewer'), tenantId: dns },
    });
    const token = String(res.json().link).split('#')[1] ?? '';
    const accept = await t.as(null, {
      method: 'POST',
      url: '/auth/invitations/accept',
      payload: { token, password: 'Захват-учётки-123', consent: true },
    });
    expect(error(accept).code).toBe('account_exists');
    const [after] = await ownerDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, owner?.id ?? ''));
    expect(after?.passwordHash).toBeNull();
  });
});

describe('секреты не попадают в журналы', () => {
  it('пароль, токен сессии, ссылка приглашения и код входа не пишутся в лог', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const messenger = new MemoryMessenger();
    const app = await buildApp({
      logger: { ...loggerOptions('trace'), stream } as never,
      services: {
        db: createDb(appPool(2)),
        clock: new FixedClock(NOON),
        messenger,
        publicUrl: TEST_ORIGIN,
      },
    });
    await app.ready();
    const { email } = await createUser('org_owner', { siteId: null });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: { login: email, password: PASSWORD },
    });
    const cookie = sid(res);
    const invite = await app.inject({
      method: 'POST',
      url: '/invitations',
      headers: { cookie, origin: TEST_ORIGIN },
      payload: { email: 'secret.test@example.test', roleId: roleId('accountant') },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/code/request',
      headers: { origin: TEST_ORIGIN },
      payload: { login: email },
    });
    await app.close();
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    const inviteToken = String(invite.json().link).split('#')[1] ?? '';
    for (const secret of [
      PASSWORD,
      cookie.slice(4),
      inviteToken,
      messenger.last('login_code')?.code ?? '',
      email,
    ]) {
      expect(secret.length).toBeGreaterThan(0);
      expect(log).not.toContain(secret);
    }
  });
});

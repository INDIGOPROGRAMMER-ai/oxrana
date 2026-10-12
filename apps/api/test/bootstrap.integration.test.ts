import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapError, bootstrapOrganization, issueOwnerLink } from '../src/cli/bootstrap-core';
import { ownerDb, startTestApp, TEST_ORIGIN, type TestApp } from './support/harness';

/**
 * Чистый старт (ADR-016, ADR-018) на пустой базе — без демо-сида: организация, шаблоны ролей,
 * владелец; пароль — одноразовой ссылкой. Дальше владелец сам: объект (политики согласования по
 * умолчанию), КПП (учётка КПП), привязка устройства, приглашение. Повтор на непустой базе — отказ.
 */
let t: TestApp;
const run = promisify(execFile);
const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const INPUT = {
  organizationName: 'ООО «Пример»',
  slug: 'primer',
  timezone: 'Asia/Yekaterinburg',
  ownerName: 'Сидорова Анна',
  ownerEmail: 'owner@example.test',
  ownerPhone: null,
};

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

function cookieOf(res: { headers: Record<string, unknown> }): string {
  return /sid=[^;]*/.exec(String(res.headers['set-cookie']))?.[0] ?? '';
}

describe('чистый старт', () => {
  it('на пустой базе: организация, 9 шаблонов ролей, владелец; ссылка одноразовая; повтор — отказ', async () => {
    const result = await bootstrapOrganization(ownerDb(), INPUT, {
      publicUrl: TEST_ORIGIN,
      now: t.clock.now(),
    });
    expect(result.link).toMatch(new RegExp(`^${TEST_ORIGIN}/password#[A-Za-z0-9_-]{43}$`));
    const db = ownerDb();
    const [org] = await db.select().from(schema.organizations);
    expect(org).toMatchObject({
      name: 'ООО «Пример»',
      slug: 'primer',
      defaultTimezone: 'Asia/Yekaterinburg',
    });
    const roles = await db.select().from(schema.roles);
    expect(roles.map((r) => r.templateCode).sort()).toEqual([
      'accountant',
      'approver',
      'gate_post',
      'org_owner',
      'shift_senior',
      'site_admin',
      'tenant_manager',
      'tenant_requester',
      'tenant_viewer',
    ]);
    expect(await db.select().from(schema.sites)).toEqual([]);
    const [owner] = await db.select().from(schema.users);
    expect(owner).toMatchObject({
      fullName: 'Сидорова Анна',
      email: 'owner@example.test',
      passwordHash: null,
    });
    const [link] = await db.select().from(schema.passwordResets);
    expect(link?.purpose).toBe('setup');
    expect(result.link).not.toContain(link?.tokenHash ?? '-');
    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((a) => [a.action, a.actorType])).toEqual([['bootstrap', 'system']]);

    await expect(
      bootstrapOrganization(
        ownerDb(),
        { ...INPUT, slug: 'other' },
        { publicUrl: TEST_ORIGIN, now: t.clock.now() },
      ),
    ).rejects.toThrow(/База не пустая: организаций — 1, пользователей — 1/);
  });

  it('параметры проверяются до записи: ошибка называет параметр', async () => {
    const error = await bootstrapOrganization(
      ownerDb(),
      { ...INPUT, slug: 'Плохой slug', timezone: 'Mars/Olympus', ownerEmail: null },
      { publicUrl: TEST_ORIGIN, now: t.clock.now() },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootstrapError);
    expect(String((error as Error).message)).toMatch(/--slug[\s\S]*--timezone[\s\S]*--owner-email/);
  });

  it('владелец задаёт пароль по ссылке, входит и сам настраивает: объект, КПП, устройство, приглашение', async () => {
    const { link } = await issueOwnerLink(
      ownerDb(),
      { email: 'OWNER@example.test', phone: null },
      { publicUrl: TEST_ORIGIN, now: t.clock.now() },
    );
    const token = link.split('#')[1] ?? '';
    const info = await t.as(null, {
      method: 'POST',
      url: '/auth/password/inspect',
      payload: { token },
    });
    expect(info.json()).toMatchObject({ purpose: 'setup', fullName: 'Сидорова Анна' });
    const set = await t.as(null, {
      method: 'POST',
      url: '/auth/password/reset',
      payload: { token, password: 'Пароль-владельца-1' },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      kind: 'user',
      organization: { name: 'ООО «Пример»' },
      user: { assignments: [{ roleName: 'Владелец организации', siteId: null, tenantId: null }] },
    });
    const login = await t.as(null, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'owner@example.test', password: 'Пароль-владельца-1' },
    });
    expect(login.statusCode).toBe(200);
    const headers = { cookie: cookieOf(login), origin: TEST_ORIGIN };
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

    const site = await call('POST', '/sites', { name: 'Склад № 1' });
    expect(site.statusCode, site.body).toBe(201);
    expect(site.json().timezone).toBe('Asia/Yekaterinburg');
    const siteId = site.json().id as string;
    const policies = await call('GET', `/sites/${siteId}/approval-policies`);
    expect(policies.json().items).toHaveLength(9);
    expect((await call('GET', `/sites/${siteId}/approval-policies/missing`)).json().items).toEqual(
      [],
    );

    const gate = await call('POST', `/sites/${siteId}/gates`, {
      name: 'Въезд 1',
      kind: 'perimeter',
      admits: 'vehicles_and_pedestrians',
    });
    expect(gate.statusCode, gate.body).toBe(201);
    const accounts = (await call('GET', `/sites/${siteId}/gate-accounts`)).json().items;
    expect(accounts).toHaveLength(1);
    const enrollment = await call('POST', `/gate-accounts/${accounts[0].id}/enrollments`, {});
    const device = await t.as(null, {
      method: 'POST',
      url: '/devices/enroll',
      payload: { code: enrollment.json().code, name: 'ПК въезда' },
    });
    expect(device.statusCode).toBe(201);

    const roles = (await call('GET', '/roles')).json().items as {
      id: string;
      templateCode: string;
    }[];
    const adminRole = roles.find((r) => r.templateCode === 'site_admin');
    const invite = await call('POST', '/invitations', {
      email: 'admin@example.test',
      fullName: 'Козлов Олег',
      roleId: adminRole?.id,
      siteId,
    });
    expect(invite.statusCode, invite.body).toBe(201);
  });

  it('команда: на непустой базе — понятный отказ и код выхода 1; ссылка — только в выводе команды', async () => {
    const env = { ...process.env, PUBLIC_URL: TEST_ORIGIN };
    const args = [
      'exec',
      'tsx',
      'src/cli/bootstrap.ts',
      '--org',
      'ООО «Другая»',
      '--slug',
      'drugaya',
      '--timezone',
      'Europe/Moscow',
      '--owner-name',
      'Иванов Иван',
      '--owner-email',
      'ivanov@example.test',
    ];
    const failed = await run('pnpm', args, { cwd: API_DIR, env }).catch((e: unknown) => e);
    expect((failed as { code?: number }).code).toBe(1);
    expect(String((failed as { stderr?: string }).stderr)).toContain('База не пустая');
    const [user] = await ownerDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'ivanov@example.test'));
    expect(user).toBeUndefined();
  }, 30_000);
});

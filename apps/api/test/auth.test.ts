import { describe, expect, it } from 'vitest';
import { actorFromGrants, permissionsIn } from '../src/actor';
import { parseCookies, sessionCookie } from '../src/auth/cookies';
import {
  assertPasswordStrong,
  enrollmentCode,
  normalizeEnrollmentCode,
  randomToken,
  sha256Hex,
} from '../src/auth/crypto';
import { loginHash, normalizePhone, parseLogin } from '../src/auth/login';

/** Чистые части входа (ADR-018): актор из назначений, логины, коды, cookie — без БД. */
const ORG = '00000000-0000-4000-8000-00000000000a';
const SITE_A = '00000000-0000-4000-8000-0000000000a1';
const SITE_B = '00000000-0000-4000-8000-0000000000b1';
const TENANT_X = '00000000-0000-4000-8000-0000000000c1';
const TENANT_Y = '00000000-0000-4000-8000-0000000000c2';
const perms = (...p: string[]) => new Set(p);

describe('актор из назначений ролей', () => {
  it('сотрудник: объекты из назначений, права проверяются по объекту', () => {
    const actor = actorFromGrants({
      id: 'u',
      kind: 'user',
      organizationId: ORG,
      grants: [
        { permissions: perms('tenant.manage', 'pass.approve'), siteId: SITE_A, tenantId: null },
        { permissions: perms('pass.approve'), siteId: SITE_B, tenantId: null },
      ],
    });
    expect(actor.siteIds).toEqual([SITE_A, SITE_B]);
    expect(actor.tenantIds).toBeNull();
    expect(actor.permissions.has('tenant.manage')).toBe(true);
    expect(permissionsIn(actor, { siteId: SITE_B }).has('tenant.manage')).toBe(false);
    expect(permissionsIn(actor, { siteId: SITE_A }).has('tenant.manage')).toBe(true);
  });

  it('назначение на всю организацию — все объекты', () => {
    const actor = actorFromGrants({
      id: 'u',
      kind: 'user',
      organizationId: ORG,
      grants: [{ permissions: perms('report.view'), siteId: null, tenantId: null }],
    });
    expect(actor.siteIds).toBeNull();
    expect(permissionsIn(actor, { siteId: SITE_B }).has('report.view')).toBe(true);
  });

  it('пользователь арендатора: свои компании; права одной компании не действуют в другой', () => {
    const actor = actorFromGrants({
      id: 'u',
      kind: 'user',
      organizationId: ORG,
      grants: [
        {
          permissions: perms('pass.view', 'pass.create.single'),
          siteId: SITE_A,
          tenantId: TENANT_X,
        },
        { permissions: perms('pass.view'), siteId: SITE_A, tenantId: TENANT_Y },
      ],
    });
    expect(actor.tenantIds).toEqual([TENANT_X, TENANT_Y]);
    expect(actor.siteIds).toEqual([SITE_A]);
    expect(permissionsIn(actor, { tenantId: TENANT_Y }).has('pass.create.single')).toBe(false);
    expect(permissionsIn(actor, { tenantId: TENANT_X }).has('pass.create.single')).toBe(true);
  });

  it('есть роль сотрудника — назначения в арендаторах не расширяют её до объекта', () => {
    const actor = actorFromGrants({
      id: 'u',
      kind: 'user',
      organizationId: ORG,
      grants: [
        { permissions: perms('report.view'), siteId: SITE_A, tenantId: null },
        {
          permissions: perms('pass.view', 'pass.create.single'),
          siteId: SITE_B,
          tenantId: TENANT_X,
        },
      ],
    });
    expect(actor.tenantIds).toBeNull();
    expect(actor.siteIds).toEqual([SITE_A]);
    expect(actor.permissions.has('pass.create.single')).toBe(false);
  });
});

describe('логины, коды, cookie', () => {
  it('телефон — к виду +7…; e-mail — без регистра; в журнал — хэш', () => {
    expect(normalizePhone('8 (900) 123-45-67')).toBe('+79001234567');
    expect(normalizePhone('+7 900 1234567')).toBe('+79001234567');
    expect(normalizePhone('9001234567')).toBe('+79001234567');
    expect(parseLogin(' Owner@Example.TEST ')).toEqual({
      kind: 'email',
      value: 'owner@example.test',
    });
    expect(loginHash(parseLogin('8 900 123 45 67'))).toBe(loginHash(parseLogin('+79001234567')));
    expect(loginHash(parseLogin('a@b.ru'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('пароль: не короче 10 символов, не только цифры', () => {
    expect(() => assertPasswordStrong('короткий')).toThrow();
    expect(() => assertPasswordStrong('79001234567')).toThrow();
    expect(() => assertPasswordStrong('aaaaaaaaaaaa')).toThrow();
    expect(() => assertPasswordStrong('Надёжный пароль 1')).not.toThrow();
  });

  it('код привязки: без похожих символов, регистр и дефис не важны; токен — 32 байта', () => {
    for (let i = 0; i < 50; i++)
      expect(enrollmentCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(normalizeEnrollmentCode('ab2c-de3f')).toBe('AB2CDE3F');
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('x')).toHaveLength(64);
  });

  it('cookie сессии: httpOnly, SameSite=Lax, Secure — только при https', () => {
    expect(sessionCookie('tok', true)).toContain('; Secure');
    expect(sessionCookie('tok', false)).not.toContain('Secure');
    expect(sessionCookie('tok', false)).toContain('HttpOnly; SameSite=Lax');
    expect(parseCookies('a=1; sid=abc%2Fd; b')).toEqual({ a: '1', sid: 'abc/d' });
  });
});

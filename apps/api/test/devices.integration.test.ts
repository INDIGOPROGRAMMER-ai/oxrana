import { ErrorBodySchema } from '@oxrana/contracts';
import { createDb, schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { FixedClock } from '../src/clock';
import {
  appPool,
  KEYS,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  TEST_ORIGIN,
  type TestApp,
} from './support/harness';

/**
 * Учётки КПП и устройства (A11, ADR-007, ADR-018): учётка создаётся вместе с КПП, устройство
 * привязывается одноразовым кодом из админки (10 минут), токен хранится хэшем, отзыв действует
 * сразу; устройство поста само не разлогинивается (сценарий 44). Привязка и отзыв — в аудите.
 */
let t: TestApp;
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const admin = roleActor('site_admin');

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

async function newGate(name: string): Promise<{ gateId: string; accountId: string }> {
  const res = await t.as(admin, {
    method: 'POST',
    url: `/sites/${KEYS.siteId}/gates`,
    payload: { name, kind: 'perimeter', admits: 'vehicles_and_pedestrians' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const gateId = res.json().id as string;
  const [account] = await ownerDb()
    .select()
    .from(schema.gateAccounts)
    .where(eq(schema.gateAccounts.gateId, gateId));
  if (!account) throw new Error('учётка КПП не создана');
  return { gateId, accountId: account.id };
}

async function issueCode(accountId: string): Promise<{ code: string; enrollUrl: string }> {
  const res = await t.as(admin, {
    method: 'POST',
    url: `/gate-accounts/${accountId}/enrollments`,
    payload: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

function enroll(code: string, name = 'ПК поста') {
  return t.as(null, { method: 'POST', url: '/devices/enroll', payload: { code, name } });
}

const asDevice = (token: string, url: string) =>
  t.app.inject({ url, headers: { authorization: `Bearer ${token}` } });

describe('учётка КПП и привязка устройства', () => {
  it('учётка КПП создаётся вместе с КПП, с ролью «Пост КПП»; в списке учёток объекта', async () => {
    const { gateId, accountId } = await newGate('КПП-3');
    const res = await t.as(admin, { url: `/sites/${KEYS.siteId}/gate-accounts` });
    const account = res.json().items.find((a: { id: string }) => a.id === accountId);
    expect(account).toMatchObject({ gateId, gateName: 'КПП-3', roleName: 'Пост КПП', devices: [] });
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'gate'), eq(schema.auditLog.entityId, gateId)));
    expect(JSON.stringify(audit[0]?.diff)).toContain('Пост КПП');
  });

  it('код привязки — 10 минут, один раз, в БД хэш; устройство получает токен и работает как пост', async () => {
    const { accountId, gateId } = await newGate('КПП-4');
    const { code, enrollUrl } = await issueCode(accountId);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(enrollUrl).toBe(`http://127.0.0.1:5174/enroll#${code}`);
    const [stored] = await ownerDb()
      .select()
      .from(schema.deviceEnrollments)
      .where(eq(schema.deviceEnrollments.gateAccountId, accountId));
    expect(stored?.codeHash).not.toContain(code.replace('-', ''));
    expect(stored?.expiresAt.getTime()).toBe(t.clock.now() + 10 * 60_000);

    // регистр и дефис не важны — код набирают руками
    const res = await enroll(code.toLowerCase().replace('-', ' '), 'Планшет');
    expect(res.statusCode, res.body).toBe(201);
    const { token, device, gate } = res.json();
    expect(gate).toEqual({ id: gateId, name: 'КПП-4' });
    expect(device).toMatchObject({ name: 'Планшет', kind: 'post' });
    const [row] = await ownerDb()
      .select()
      .from(schema.gateDevices)
      .where(eq(schema.gateDevices.id, device.id));
    expect(row?.tokenHash).not.toBe(token);

    const me = await asDevice(token, '/auth/me');
    expect(me.json()).toMatchObject({
      kind: 'gate_account',
      gate: { id: gateId, name: 'КПП-4', deviceName: 'Планшет' },
    });
    expect(me.json().permissions).toContain('visit.check_in');

    // второй раз тот же код не работает
    expect(error(await enroll(code)).code).toBe('code_invalid');
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.entity, 'gate_device'), eq(schema.auditLog.entityId, device.id)),
      );
    expect(audit.map((a) => [a.action, a.actorType, a.deviceId])).toEqual([
      ['enroll', 'gate_account', device.id],
    ]);
  });

  it('код старше 10 минут не принимается; неверный код — понятная ошибка', async () => {
    const { accountId } = await newGate('КПП-5');
    const { code } = await issueCode(accountId);
    t.clock.advance(10 * 60_000 + 1);
    const late = await enroll(code);
    expect(late.statusCode).toBe(401);
    expect(error(late)).toMatchObject({ code: 'code_invalid', field: 'code' });
    expect(error(late).message).toContain('Устройства КПП');
    expect(error(await enroll('AAAA-BBBB')).code).toBe('code_invalid');
  });

  it('отзыв действует сразу: следующий запрос устройства — 401; в аудите — кто и почему', async () => {
    const { accountId } = await newGate('КПП-6');
    const { code } = await issueCode(accountId);
    const { token, device } = (await enroll(code)).json();
    expect((await asDevice(token, '/gate/snapshot')).statusCode).toBe(200);
    const revoke = await t.as(admin, {
      method: 'POST',
      url: `/gate-devices/${device.id}/revoke`,
      payload: { reason: 'Планшет потерян' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ revokeReason: 'Планшет потерян' });
    const after = await asDevice(token, '/gate/snapshot');
    expect(after.statusCode).toBe(401);
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entity, 'gate_device'), eq(schema.auditLog.action, 'revoke')));
    expect(audit.find((a) => a.entityId === device.id)).toMatchObject({
      reason: 'Планшет потерян',
      actorType: 'user',
    });
  });

  it('сценарий 44: пост после перезагрузки открывается в своей учётке без пароля — токен не истекает', async () => {
    const { accountId, gateId } = await newGate('КПП-7');
    const { code } = await issueCode(accountId);
    const { token } = (await enroll(code)).json();
    // «перезагрузка»: другой процесс API, через год — тот же токен из IndexedDB работает
    const app = await buildApp({
      services: {
        db: createDb(appPool(2)),
        clock: new FixedClock(t.clock.now() + 400 * 86_400_000),
        publicUrl: TEST_ORIGIN,
      },
    });
    await app.ready();
    const me = await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
    await app.close();
    expect(me.statusCode).toBe(200);
    expect(me.json().gate.id).toBe(gateId);
  });

  it('устройство не управляет устройствами и не выполняет действий пользователя; удалённый КПП — 401', async () => {
    const { accountId, gateId } = await newGate('КПП-8');
    const { code } = await issueCode(accountId);
    const { token } = (await enroll(code)).json();
    const auth = { authorization: `Bearer ${token}` };
    const issue = await t.app.inject({
      method: 'POST',
      url: `/gate-accounts/${accountId}/enrollments`,
      headers: auth,
      payload: {},
    });
    expect(issue.statusCode).toBe(403);
    const self = await t.app.inject({ url: '/auth/sessions', headers: auth });
    expect(self.statusCode).toBe(403);
    const del = await t.as(admin, { method: 'DELETE', url: `/gates/${gateId}?confirm=true` });
    expect(del.statusCode, del.body).toBe(200);
    expect((await asDevice(token, '/auth/me')).statusCode).toBe(401);
  });

  it('подбор кода с одного адреса ограничен: после 30 неудач — 429', async () => {
    for (let i = 0; i < 30; i++)
      await enroll(
        `ZZZZ-${String(1000 + i)
          .slice(-4)
          .replace(/[01]/g, '9')}`,
      );
    const res = await enroll('ZZZZ-9999');
    expect(res.statusCode).toBe(429);
  });
});

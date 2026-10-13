import { PERMISSIONS } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KEYS,
  ownerDb,
  roleActor,
  roleIdOf,
  seedDemo,
  startTestApp,
  type TestApp,
} from './support/harness';

let t: TestApp;
const owner = roleActor('org_owner');
const siteAdmin = roleActor('site_admin');

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());

/** Стенд после обновления: роли по шаблонам созданы до появления новых прав (ADR-007). */
async function stripToLegacy(code: string): Promise<void> {
  await ownerDb()
    .update(schema.roles)
    .set({ permissions: ['pass.view', 'pass.cancel_own'] })
    .where(
      and(
        eq(schema.roles.id, roleIdOf(code)),
        eq(schema.roles.organizationId, KEYS.organizationId),
      ),
    );
}

describe('владелец организации и устаревший массив прав в БД (ADR-007)', () => {
  it('владелец имеет все права платформы, даже если в роли в БД их нет', async () => {
    await stripToLegacy('org_owner');
    const res = await t.as(owner, { url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { permissions: string[] }).permissions).toEqual([...PERMISSIONS].sort());
  });

  it('владелец пользуется новым правом: чёрный список доступен', async () => {
    const res = await t.as(owner, { url: `/sites/${KEYS.siteId}/blacklist` });
    expect(res.statusCode).toBe(200);
  });

  it('другие роли по шаблону права не получают сами: их добирает миграция', async () => {
    await stripToLegacy('site_admin');
    const res = await t.as(siteAdmin, { url: `/sites/${KEYS.siteId}/blacklist` });
    expect(res.statusCode).toBe(403);
  });
});

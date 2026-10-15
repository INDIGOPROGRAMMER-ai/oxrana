import { ErrorBodySchema } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processApprovalTimeouts } from '../../src/modules/passes/approvals';
import {
  customActor,
  gateActor,
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  roleIdOf,
  seedDemo,
  startTestApp,
  type TestApp,
  windowFollowsPolicy,
} from '../support/harness';
import {
  action,
  at,
  categoryKey,
  dnsTruck,
  fillVisits,
  kpp2,
  resetTenant,
  tenantKey,
} from './gate-helpers';

/**
 * Этап 5 на демо-объекте: согласование (сценарий 24), запрос исключения с поста (сценарий 42),
 * администратор без «Впустить» (сценарий 39), решения Q-55–Q-58, изоляция арендаторов и права в
 * области записи. Часы — вторник 10.03.2026 12:00 по объекту.
 */
let t: TestApp;
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());
const dns = tenantKey('dns');
const x5 = tenantKey('x5');
const car = categoryKey('car');
const semi = categoryKey('semi');
const admin = roleActor('site_admin');
const approver = roleActor('approver');
const dnsLogist = roleActor('tenant_manager', { tenantIds: [dns] });

let plate = 500;
const nextPlate = () => `К${++plate}РС174`;

function multiPass(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: dns,
    passType: 'multi',
    participant: 'vehicle',
    plate: nextPlate(),
    categoryId: car,
    validFrom: at('13:00'),
    validTo: '2026-03-15T15:00:00.000Z',
    comment: 'Инвентаризация склада',
    ...overrides,
  };
}

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
  await windowFollowsPolicy(t);
});
beforeEach(() => t.clock.set(NOON));
afterAll(() => t.close());

describe('сценарий 24: согласование пропусков', () => {
  it('многоразовый с комментарием уходит согласующему; «одобрить с изменениями» меняет конец — арендатор видит изменение', async () => {
    const created = await t.as(dnsLogist, { method: 'POST', url: '/passes', payload: multiPass() });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().status).toBe('pending_approval');
    const passId = created.json().id as string;

    const queue = await t.as(approver, { url: `/sites/${KEYS.siteId}/approvals` });
    const card = queue.json().items.find((i: { pass: { id: string } }) => i.pass.id === passId);
    expect(card).toMatchObject({
      tenantName: 'ДНС',
      createdByName: 'Тестовый tenant_manager',
      pass: {
        validFrom: at('13:00'),
        validTo: '2026-03-15T15:00:00.000Z',
        comment: 'Инвентаризация склада',
      },
    });

    const approve = await t.as(approver, {
      method: 'POST',
      url: `/passes/${passId}/approve`,
      payload: { note: 'Хватит до 13-го', changes: { validTo: '2026-03-13T15:00:00.000Z' } },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const seen = (await t.as(dnsLogist, { url: `/passes/${passId}` })).json();
    expect(seen).toMatchObject({
      status: 'approved',
      validTo: '2026-03-13T15:00:00.000Z',
      approvalNote: 'Хватит до 13-го',
      approvalChanges: {
        validTo: { from: '2026-03-15T15:00:00.000Z', to: '2026-03-13T15:00:00.000Z' },
      },
    });
    const history = (await t.as(dnsLogist, { url: `/passes/${passId}/history` })).json().items;
    expect(history.map((h: { action: string }) => h.action)).toEqual([
      'create',
      'approve_with_changes',
    ]);

    const again = await t.as(approver, {
      method: 'POST',
      url: `/passes/${passId}/reject`,
      payload: { note: 'Передумал' },
    });
    expect(error(again).code).toBe('not_pending');
  });

  it('отклонение: причина видна арендатору, ссылка водителя отозвана', async () => {
    const created = await t.as(dnsLogist, { method: 'POST', url: '/passes', payload: multiPass() });
    const passId = created.json().id as string;
    const res = await t.as(approver, {
      method: 'POST',
      url: `/passes/${passId}/reject`,
      payload: { note: 'Нет основания' },
    });
    expect(res.json()).toMatchObject({ status: 'rejected', approvalNote: 'Нет основания' });
    const tokens = await ownerDb()
      .select()
      .from(schema.passTokens)
      .where(eq(schema.passTokens.passId, passId));
    expect(tokens.every((tk) => tk.revokedAt !== null)).toBe(true);
  });

  it('одобрение с изменением, которое нарушает правила, — та же ошибка, что при создании', async () => {
    const created = await t.as(dnsLogist, { method: 'POST', url: '/passes', payload: multiPass() });
    const res = await t.as(approver, {
      method: 'POST',
      url: `/passes/${created.json().id}/approve`,
      payload: { changes: { validTo: '2026-06-15T15:00:00.000Z' } },
    });
    expect(error(res)).toMatchObject({ code: 'invalid_period', field: 'validTo' });
  });

  it('эскалация: не рассмотрен за 4 ч — событие эскалации один раз', async () => {
    const created = await t.as(dnsLogist, { method: 'POST', url: '/passes', payload: multiPass() });
    const passId = created.json().id as string;
    const deps = t.app.deps;
    t.clock.advance(3 * 3_600_000);
    await processApprovalTimeouts(deps);
    const before = await ownerDb().select().from(schema.passes).where(eq(schema.passes.id, passId));
    expect(before[0]?.approvalEscalatedAt).toBeNull();
    t.clock.advance(3_600_000 + 1000);
    const first = await processApprovalTimeouts(deps);
    const second = await processApprovalTimeouts(deps);
    expect(first.escalated).toBeGreaterThanOrEqual(1);
    expect(second.escalated).toBe(0);
    const events = await ownerDb()
      .select()
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.type, 'pass.approval_escalated'),
          eq(schema.domainEvents.aggregateId, passId),
        ),
      );
    expect(events).toHaveLength(1);
  });
});

describe('политики, отмена, лимит 0, допуск (Q-55–Q-58)', () => {
  it('Q-55: нет политики на сочетание — пропуск уходит на согласование с предупреждением; список незаданных', async () => {
    const policyId = (
      await ownerDb()
        .select()
        .from(schema.approvalPolicies)
        .where(
          and(
            eq(schema.approvalPolicies.siteId, KEYS.siteId),
            eq(schema.approvalPolicies.creatorKind, 'admin'),
            eq(schema.approvalPolicies.passType, 'single'),
          ),
        )
    )[0]?.id;
    await t.as(roleActor('org_owner'), { method: 'DELETE', url: `/approval-policies/${policyId}` });
    const res = await t.as(admin, {
      method: 'POST',
      url: '/passes',
      payload: { ...multiPass(), passType: 'single', validTo: at('20:00'), windowFrom: undefined },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe('pending_approval');
    expect(res.json().warnings).toContainEqual({
      code: 'approval_policy_missing',
      message: 'Политика «Администратор → Разовый» не задана — пропуск ушёл на согласование.',
    });
    const gaps = await t.as(admin, { url: `/sites/${KEYS.siteId}/approval-policies/missing` });
    expect(gaps.json().items).toEqual([
      {
        creatorKind: 'admin',
        passType: 'single',
        message:
          'Политика «Администратор → Разовый» не задана: такие пропуска уходят на согласование.',
      },
    ]);
    const restore = await t.as(admin, {
      method: 'POST',
      url: `/sites/${KEYS.siteId}/approval-policies`,
      payload: { creatorKind: 'admin', passType: 'single', mode: 'allow' },
    });
    expect(restore.statusCode, restore.body).toBe(201);
  });

  it('Q-56: заказчик отменяет только свои пропуска, ответственный — любые своего арендатора', async () => {
    const requester = roleActor('tenant_requester', { tenantIds: [dns] });
    const single = { ...multiPass(), passType: 'single', validTo: at('20:00') };
    const own = (await t.as(requester, { method: 'POST', url: '/passes', payload: single })).json()
      .id;
    const other = (
      await t.as(dnsLogist, {
        method: 'POST',
        url: '/passes',
        payload: { ...single, plate: nextPlate() },
      })
    ).json().id;
    const cancel = (actor: typeof requester, passId: string) =>
      t.as(actor, {
        method: 'POST',
        url: `/passes/${passId}/cancel`,
        payload: { reason: 'Не приедет' },
      });
    expect((await cancel(requester, own)).statusCode).toBe(200);
    const denied = await cancel(requester, other);
    expect(denied.statusCode).toBe(403);
    expect(error(denied)).toMatchObject({ code: 'forbidden', permission: 'pass.cancel' });
    expect(error(denied).message).toContain('только свои пропуска');
    expect((await cancel(dnsLogist, other)).statusCode).toBe(200);
  });

  it('Q-57: тип с лимитом 0 — пользователю арендатора простыми словами и куда обратиться', async () => {
    const kontinent = tenantKey('kontinent');
    const res = await t.as(roleActor('tenant_manager', { tenantIds: [kontinent] }), {
      method: 'POST',
      url: '/passes',
      payload: {
        tenantId: kontinent,
        passType: 'single',
        participant: 'vehicle',
        plate: nextPlate(),
        categoryId: semi,
        validFrom: at('12:00'),
        validTo: at('20:00'),
        windowFrom: at('12:00'),
        windowTo: at('14:00'),
      },
    });
    expect(error(res), res.body).toMatchObject({
      code: 'category_unavailable',
      field: 'categoryId',
      message:
        'Тип «фура» для вашей компании не предусмотрен. Если нужен — обратитесь к администратору объекта.',
    });
  });

  it('Q-58: допуск на «начало в прошлом» — настройка объекта, по умолчанию 10 минут', async () => {
    const payload = () => ({
      ...multiPass(),
      passType: 'single',
      validFrom: at('11:55'),
      validTo: at('20:00'),
    });
    expect(
      (await t.as(admin, { method: 'POST', url: '/passes', payload: payload() })).statusCode,
    ).toBe(201);
    const patch = await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${KEYS.siteId}`,
      payload: { settings: { pastStartToleranceMin: 2 } },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const late = await t.as(admin, { method: 'POST', url: '/passes', payload: payload() });
    expect(error(late)).toMatchObject({ code: 'starts_in_past', field: 'validFrom' });
    await t.as(admin, {
      method: 'PATCH',
      url: `/sites/${KEYS.siteId}`,
      payload: { settings: { pastStartToleranceMin: 10 } },
    });
  });
});

describe('сценарий 42: запрос исключения с поста', () => {
  beforeEach(() => resetTenant(dns));

  it('фура ДНС при 25/25: пост запрашивает исключение с причиной → администратор одобряет → 🟢 и въезд с отметкой в журнале', async () => {
    await fillVisits(dns, semi, 25);
    const passId = await dnsTruck(t);
    const check = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    expect(check.json().verdict.code).toBe('wait');
    expect(check.json().verdict.secondaryActions).toContain('override_request');

    const request = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/override-requests',
      payload: {
        decisionId: check.json().decisionId,
        reason: 'Скоропортящийся груз, водитель ждёт 2 часа',
      },
    });
    expect(request.statusCode, request.body).toBe(201);
    expect(request.json()).toMatchObject({
      status: 'pending',
      verdictCode: 'wait',
      gateName: 'КПП-2',
      tenantId: dns,
    });
    const overrideId = request.json().id as string;

    // пост и согласующий без права исключения не одобряют
    const self = await t.as(kpp2, {
      method: 'POST',
      url: `/override-requests/${overrideId}/approve`,
      payload: {},
    });
    expect(self.statusCode).toBe(403);
    const noRight = await t.as(approver, {
      method: 'POST',
      url: `/override-requests/${overrideId}/approve`,
      payload: {},
    });
    expect(error(noRight)).toMatchObject({ code: 'forbidden', permission: 'gate.override' });

    const queue = await t.as(admin, {
      url: `/sites/${KEYS.siteId}/override-requests?status=pending`,
    });
    expect(queue.json().items.map((i: { id: string }) => i.id)).toContain(overrideId);
    const approve = await t.as(admin, {
      method: 'POST',
      url: `/override-requests/${overrideId}/approve`,
      payload: { note: 'Разрешаю, разгрузка в док 12' },
    });
    expect(approve.json()).toMatchObject({
      status: 'approved',
      decidedByName: 'Тестовый site_admin',
    });
    expect(approve.json().validUntil).toBe(new Date(t.clock.now() + 15 * 60_000).toISOString());

    const green = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    expect(green.json().verdict).toMatchObject({ code: 'allow', appliedOverrideId: overrideId });
    const entry = await action(t, kpp2, { type: 'check_in', passId });
    expect(entry.json().outcome, entry.body).toBe('applied');
    const [visit] = await ownerDb()
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.passId, passId));
    expect(visit?.overrideId).toBe(overrideId);
    const decisions = await ownerDb()
      .select()
      .from(schema.gateDecisions)
      .where(
        and(eq(schema.gateDecisions.passId, passId), eq(schema.gateDecisions.action, 'check_in')),
      );
    expect(decisions[0]).toMatchObject({ overrideId, gateId: KEYS.gates.kpp2 });
    expect(decisions[0]?.deviceId).not.toBeNull();
    const [used] = await ownerDb()
      .select()
      .from(schema.overrideRequests)
      .where(eq(schema.overrideRequests.id, overrideId));
    expect(used).toMatchObject({
      status: 'used',
      reason: 'Скоропортящийся груз, водитель ждёт 2 часа',
      via: 'admin',
    });
    const audit = await ownerDb()
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entity, 'override_request'),
          eq(schema.auditLog.entityId, overrideId),
        ),
      );
    expect(audit.map((a) => [a.action, a.actorType])).toEqual([
      ['create', 'gate_account'],
      ['approve', 'user'],
    ]);
  });

  it('по зелёному вердикту исключение не запрашивается; старый запрос не одобряется', async () => {
    const passId = await dnsTruck(t);
    const check = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    expect(check.json().verdict.code).toBe('allow');
    const res = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/override-requests',
      payload: { decisionId: check.json().decisionId, reason: 'на всякий случай' },
    });
    expect(error(res).code).toBe('conflict');

    await fillVisits(dns, semi, 25);
    const wait = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/check',
      payload: { direction: 'in', passId },
    });
    const request = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/override-requests',
      payload: { decisionId: wait.json().decisionId, reason: 'Водитель ждёт' },
    });
    t.clock.advance(11 * 60_000);
    const late = await t.as(admin, {
      method: 'POST',
      url: `/override-requests/${request.json().id}/approve`,
      payload: {},
    });
    expect(error(late).code).toBe('override_request_closed');
  });
});

describe('сценарий 39 и изоляция', () => {
  it('сценарий 39: у администратора объекта нет «Впустить» — права visit.check_in нет, действие — 403', async () => {
    const me = await t.as(admin, { url: '/auth/me' });
    expect(me.json().permissions).not.toContain('visit.check_in');
    const passId = await dnsTruck(t);
    const res = await action(t, admin, { type: 'check_in', passId });
    expect(res.statusCode).toBe(403);
  });

  it('арендатор не видит чужие компании: пропуска, арендаторы, пользователи, заявки', async () => {
    const x5Pass = (
      await t.as(admin, {
        method: 'POST',
        url: '/passes',
        payload: { ...multiPass(), tenantId: x5, passType: 'single', validTo: at('20:00') },
      })
    ).json().id as string;
    const list = await t.as(dnsLogist, { url: `/sites/${KEYS.siteId}/passes?limit=500` });
    expect(list.json().items.every((p: { tenantId: string }) => p.tenantId === dns)).toBe(true);
    expect((await t.as(dnsLogist, { url: `/passes/${x5Pass}` })).statusCode).toBe(403);
    expect(
      (await t.as(dnsLogist, { url: `/sites/${KEYS.siteId}/passes?tenantId=${x5}` })).statusCode,
    ).toBe(403);
    const tenants = await t.as(dnsLogist, { url: `/sites/${KEYS.siteId}/tenants` });
    expect(tenants.json().items.map((x: { id: string }) => x.id)).toEqual([dns]);
    expect((await t.as(dnsLogist, { url: `/tenants/${x5}` })).statusCode).toBe(403);
    expect((await t.as(dnsLogist, { url: `/users?tenantId=${x5}` })).statusCode).toBe(403);
    const users = await t.as(dnsLogist, { url: '/users' });
    for (const u of users.json().items) {
      expect(u.assignments.every((a: { tenantId: string }) => a.tenantId === dns)).toBe(true);
    }
    expect((await t.as(dnsLogist, { url: `/sites/${KEYS.siteId}/approvals` })).statusCode).toBe(
      403,
    );
    expect(
      (await t.as(dnsLogist, { url: '/invitations' }))
        .json()
        .items.every((i: { tenantId: string }) => i.tenantId === dns),
    ).toBe(true);
  });

  it('чужая организация не видна совсем: её пользователь получает 404 на записи демо-объекта', async () => {
    const db = ownerDb();
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: 'Чужая', slug: 'chuzhaya' })
      .returning();
    const [role] = await db
      .insert(schema.roles)
      .values({
        organizationId: org?.id ?? '',
        name: 'Владелец',
        permissions: ['pass.view_all_tenants', 'site.manage'],
      })
      .returning();
    const [user] = await db
      .insert(schema.users)
      .values({ fullName: 'Чужой', email: 'chuzhoy@example.test', status: 'active' })
      .returning();
    await db
      .insert(schema.roleAssignments)
      .values({ organizationId: org?.id ?? '', userId: user?.id ?? '', roleId: role?.id ?? '' });
    const { randomToken, sha256Hex } = await import('../../src/auth/crypto');
    const token = randomToken();
    await db.insert(schema.sessions).values({
      userId: user?.id ?? '',
      organizationId: org?.id ?? '',
      tokenHash: sha256Hex(token),
      lastSeenAt: new Date('2100-01-01'),
      expiresAt: new Date('2100-01-01'),
    });
    const res = await t.app.inject({
      url: `/sites/${KEYS.siteId}/passes`,
      headers: { cookie: `sid=${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('права проверяются в области записи: ответственный в ДНС и наблюдатель в X5 не оформляет пропуск за X5', async () => {
    const mixed = roleActor('tenant_manager', { tenantIds: [dns] });
    await t.as(mixed, { url: '/auth/me' });
    // второе назначение того же человека — наблюдатель X5
    const userId = mixed.id;
    await ownerDb()
      .insert(schema.roleAssignments)
      .values({
        organizationId: KEYS.organizationId,
        userId,
        roleId: roleIdOf('tenant_viewer'),
        siteId: KEYS.siteId,
        tenantId: x5,
      });
    const forX5 = await t.as(mixed, {
      method: 'POST',
      url: '/passes',
      payload: { ...multiPass(), tenantId: x5, passType: 'single', validTo: at('20:00') },
    });
    expect(forX5.statusCode).toBe(403);
    expect(error(forX5).permission).toContain('pass.create');
    const x5List = await t.as(mixed, { url: `/sites/${KEYS.siteId}/passes?tenantId=${x5}` });
    expect(x5List.statusCode).toBe(200);
    const forDns = await t.as(mixed, {
      method: 'POST',
      url: '/passes',
      payload: { ...multiPass(), passType: 'single', validTo: at('20:00') },
    });
    expect(forDns.statusCode).toBe(201);
  });

  it('пост видит пропуска всех арендаторов объекта, но не правит их и не управляет людьми', async () => {
    const custom = customActor(['pass.view']);
    expect((await t.as(custom, { url: '/users' })).statusCode).toBe(403);
    const post = gateActor('kpp1');
    expect((await t.as(post, { url: '/users' })).statusCode).toBe(403);
    expect(
      (
        await t.as(post, {
          method: 'PATCH',
          url: `/passes/${await dnsTruck(t)}`,
          payload: { comment: 'x' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

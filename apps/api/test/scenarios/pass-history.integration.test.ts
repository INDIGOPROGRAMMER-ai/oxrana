import { randomUUID } from 'node:crypto';
import { ErrorBodySchema, type PassHistoryEntry, roleTemplate } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  customActor,
  gateActor,
  KEYS,
  NOON,
  ownerDb,
  roleActor,
  seedDemo,
  startTestApp,
  type TestApp,
} from '../support/harness';
import {
  action,
  admin,
  at,
  categoryKey,
  dnsTruck,
  fillVisits,
  kpp1,
  kpp2,
  resetTenant,
  tenantKey,
} from './gate-helpers';

/**
 * Лента и карточка пропуска (7b.3, ADR-023): изменения и отметки КПП одним списком; арендатор
 * видит не всё, что администратор; учётке КПП лента недоступна никогда (ADR-007).
 */
let t: TestApp;
const dns = tenantKey('dns');
const dnsManager = roleActor('tenant_manager', { tenantIds: [dns] });
const otherTenantManager = roleActor('tenant_manager', { tenantIds: [tenantKey('x5')] });
const error = (res: { json(): unknown }) => ErrorBodySchema.parse(res.json());

type Entry = PassHistoryEntry;
const history = async (actor: Parameters<TestApp['as']>[0], passId: string, query = '') =>
  (await t.as(actor, { url: `/passes/${passId}/history${query}` })).json() as {
    items: Entry[];
    total: number;
  };

beforeAll(async () => {
  await seedDemo();
  t = await startTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  t.clock.set(NOON);
  await resetTenant(dns);
});

/** Оформлен, изменён срок, въезд, выезд — полный круг. */
async function fullCycle(): Promise<string> {
  const passId = await dnsTruck(t);
  t.clock.advance(60_000);
  const patch = await t.as(admin, {
    method: 'PATCH',
    url: `/passes/${passId}`,
    payload: { validTo: at('21:00'), reason: 'Задерживается разгрузка' },
  });
  expect(patch.statusCode, patch.body).toBe(200);
  t.clock.advance(60_000);
  expect((await action(t, kpp2, { type: 'check_in', passId })).json().outcome).toBe('applied');
  t.clock.advance(3_600_000);
  expect((await action(t, kpp2, { type: 'check_out', passId })).json().outcome).toBe('applied');
  return passId;
}

describe('лента пропуска', () => {
  it('администратор видит одну ленту: оформлен, изменён «было → стало», въезд и выезд с КПП и учёткой', async () => {
    const passId = await fullCycle();
    const { items, total } = await history(admin, passId);
    expect(total).toBe(4);
    // новые сверху
    expect(items.map((e) => e.kind)).toEqual(['check_out', 'check_in', 'updated', 'created']);

    const created = items[3];
    expect(created).toMatchObject({
      group: 'changes',
      title: 'Оформлен',
      actor: { kind: 'user', name: 'Тестовый site_admin' },
    });

    const updated = items[2];
    expect(updated?.reason).toBe('Задерживается разгрузка');
    expect(updated?.changes).toEqual([
      {
        field: 'validTo',
        label: 'Действует до',
        type: 'time',
        from: at('20:00'),
        to: at('21:00'),
      },
    ]);

    expect(items[1]).toMatchObject({
      group: 'gate',
      title: 'Въезд',
      place: 'КПП-2',
      offline: false,
      actor: { kind: 'gate', name: 'КПП-2' },
    });
    expect(items[1]?.staff?.device).toContain('Тестовое устройство');
    expect(items[0]).toMatchObject({ group: 'gate', title: 'Выезд', place: 'КПП-2' });
  });

  it('фильтр «Изменения» и «КПП», порции по limit/offset с итогом', async () => {
    const passId = await fullCycle();
    const changes = await history(admin, passId, '?group=changes');
    expect(changes.items.map((e) => e.kind)).toEqual(['updated', 'created']);
    const gate = await history(admin, passId, '?group=gate');
    expect(gate.items.map((e) => e.kind)).toEqual(['check_out', 'check_in']);

    const first = await history(admin, passId, '?limit=3');
    const rest = await history(admin, passId, '?limit=3&offset=3');
    expect(first.total).toBe(4);
    expect(first.items).toHaveLength(3);
    expect(rest.items.map((e) => e.kind)).toEqual(['created']);
  });

  it('арендатор: въезд и выезд с КПП и временем, изменения; без учётки КПП, устройства и служебных причин', async () => {
    const passId = await fullCycle();
    const { items } = await history(dnsManager, passId);
    expect(items.map((e) => e.kind)).toEqual(['check_out', 'check_in', 'updated', 'created']);
    const gateRows = items.filter((e) => e.group === 'gate');
    expect(gateRows.map((e) => e.place)).toEqual(['КПП-2', 'КПП-2']);
    for (const row of gateRows) {
      expect(row.actor).toBeNull();
      expect(row.staff).toBeNull();
    }
    expect(JSON.stringify(items)).not.toContain('Тестовое устройство');
    // изменения арендатор видит вместе с тем, кто менял
    expect(items[2]?.actor?.name).toBe('Тестовый site_admin');
  });

  it('отказ по вердикту: арендатор видит причину, администратор — ещё и проверки движка', async () => {
    await fillVisits(dns, categoryKey('semi'), 25);
    const passId = await dnsTruck(t, { categoryId: categoryKey('light_truck') });
    const rejected = await action(t, kpp2, { type: 'check_in', passId });
    expect(rejected.json().outcome).toBe('rejected');
    const refuse = await action(t, kpp2, {
      type: 'refuse',
      direction: 'in',
      passId,
      reason: 'Водитель отказался ехать на КПП-1',
    });
    expect(refuse.json().outcome).toBe('applied');

    const tenantView = (await history(dnsManager, passId, '?group=gate')).items;
    const denied = tenantView.find((e) => e.kind === 'wrong_gate');
    expect(denied?.title).toBe('Не тот КПП');
    expect(denied?.notes.length).toBeGreaterThan(0);
    expect(denied?.staff).toBeNull();

    const adminView = (await history(admin, passId, '?group=gate')).items;
    expect(adminView.find((e) => e.kind === 'wrong_gate')?.staff?.details.join(' ')).toContain(
      'Проверки:',
    );
    const refused = adminView.find((e) => e.kind === 'refused');
    expect(refused).toMatchObject({
      title: 'Охрана отказала',
      reason: 'Водитель отказался ехать на КПП-1',
      actor: { kind: 'gate', name: 'КПП-2' },
    });
  });

  it('очередь: «Ожидание в очереди» и выход из неё видны арендатору', async () => {
    await fillVisits(dns, categoryKey('semi'), 25);
    const passId = await dnsTruck(t);
    await action(t, kpp2, { type: 'check_in', passId });
    t.clock.advance(60_000);
    await t.as(admin, {
      method: 'POST',
      url: `/passes/${passId}/cancel`,
      payload: { reason: 'Не нужен' },
    });
    const items = (await history(dnsManager, passId)).items;
    expect(items.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['queued', 'left_queue', 'cancelled', 'created']),
    );
    expect(items.find((e) => e.kind === 'left_queue')?.notes).toEqual([
      'пропуск отменён или охрана отказала',
    ]);
    expect(items.find((e) => e.kind === 'cancelled')?.reason).toBe('Не нужен');
  });

  it('отмена отметки видна в ленте, а «Выезд» отменённого въезда не показывается', async () => {
    const passId = await dnsTruck(t);
    const checkIn = await action(t, kpp2, { type: 'check_in', passId });
    t.clock.advance(30_000);
    await action(t, kpp2, {
      type: 'undo',
      actionId: checkIn.json().actionId,
      reason: 'Не та машина',
    });
    const items = (await history(admin, passId, '?group=gate')).items;
    expect(items.map((e) => e.kind)).toEqual(['undo', 'check_in']);
    expect(items[0]).toMatchObject({
      title: 'Отметка отменена',
      reason: 'Не та машина',
      notes: ['Отменён въезд'],
    });
  });

  it('офлайн-отметка помечена и несёт время устройства', async () => {
    const passId = await dnsTruck(t);
    const clientAt = at('12:00');
    t.clock.set(at('12:30'));
    const res = await t.as(kpp2, {
      method: 'POST',
      url: '/gate/actions/sync',
      payload: {
        actions: [
          {
            seq: 1,
            action: { id: randomUUID(), type: 'check_in', passId, clientAt },
            localVerdict: { code: 'allow', headline: 'Грузовые по кэшу' },
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (await history(admin, passId, '?group=gate')).items.find(
      (e) => e.kind === 'check_in',
    );
    expect(row).toMatchObject({ offline: true, deviceAt: clientAt });
    expect(row?.notes).toEqual(['из офлайн-очереди поста']);
  });

  it('исключение: запрос и решение видит только администратор', async () => {
    const passId = await dnsTruck(t);
    const [gateRow] = await ownerDb()
      .select({ id: schema.gateAccounts.id })
      .from(schema.gateAccounts)
      .where(eq(schema.gateAccounts.gateId, kpp2.gateId ?? ''));
    await ownerDb()
      .insert(schema.overrideRequests)
      .values({
        organizationId: KEYS.organizationId,
        siteId: KEYS.siteId,
        gateId: kpp2.gateId ?? '',
        passId,
        direction: 'in',
        verdictCode: 'deny',
        reasons: [],
        reason: 'Директор разрешил, пропуск не успели оформить',
        status: 'approved',
        requestedByGateAccountId: gateRow?.id ?? '',
        decidedBy: admin.id,
        decidedAt: new Date(NOON),
        decisionNote: 'Согласовано по телефону',
        via: 'admin',
      });
    const adminKinds = (await history(admin, passId, '?group=gate')).items.map((e) => e.kind);
    expect(adminKinds).toEqual(expect.arrayContaining(['override_requested', 'override_decided']));
    const tenantKinds = (await history(dnsManager, passId, '?group=gate')).items.map((e) => e.kind);
    expect(tenantKinds).not.toContain('override_requested');
    expect(tenantKinds).not.toContain('override_decided');
  });
});

describe('карточка пропуска', () => {
  it('данные: арендатор, кто оформил, где сейчас — без права на историю тоже открывается', async () => {
    const passId = await dnsTruck(t);
    const before = (await t.as(admin, { url: `/passes/${passId}/card` })).json();
    expect(before).toMatchObject({
      pass: { id: passId },
      tenantName: expect.any(String),
      createdByName: 'Тестовый site_admin',
      presence: { state: 'none' },
    });
    await action(t, kpp2, { type: 'check_in', passId });
    const inside = (await t.as(admin, { url: `/passes/${passId}/card` })).json();
    expect(inside.presence).toMatchObject({ state: 'inside', gate: 'КПП-2' });
    t.clock.advance(60_000);
    await action(t, kpp2, { type: 'check_out', passId });
    const left = (await t.as(admin, { url: `/passes/${passId}/card` })).json();
    expect(left.presence).toMatchObject({ state: 'left', gate: 'КПП-2' });

    const noHistory = customActor(['pass.view_all_tenants']);
    expect((await t.as(noHistory, { url: `/passes/${passId}/card` })).statusCode).toBe(200);
    const denied = await t.as(noHistory, { url: `/passes/${passId}/history` });
    expect(denied.statusCode).toBe(403);
    expect(error(denied)).toMatchObject({ code: 'forbidden', permission: 'pass.history.view' });
  });

  it('область: арендатор не видит ленту и карточку чужого пропуска', async () => {
    const passId = await dnsTruck(t);
    expect((await t.as(otherTenantManager, { url: `/passes/${passId}/history` })).statusCode).toBe(
      403,
    );
    expect((await t.as(otherTenantManager, { url: `/passes/${passId}/card` })).statusCode).toBe(
      403,
    );
  });
});

describe('права: учётка КПП и история (ADR-007)', () => {
  const POST = roleTemplate('gate_post').permissions;

  it('«Пост КПП» и «Старший смены» без права: 403 на ленту и заявки на изменение', async () => {
    const passId = await dnsTruck(t);
    for (const url of [`/passes/${passId}/history`, `/passes/${passId}/change-requests`]) {
      for (const actor of [kpp1, gateActor('kpp2', 'shift_senior')]) {
        const res = await t.as(actor, { url });
        expect(res.statusCode, url).toBe(403);
        expect(error(res).permission).toBe('pass.history.view');
      }
    }
  });

  it('право, добавленное в роль учётки КПП, не действует: сервер отвечает 403', async () => {
    const passId = await dnsTruck(t);
    const sneaky = gateActor('kpp2', 'gate_post', [...POST, 'pass.history.view']);
    for (const url of [`/passes/${passId}/history`, `/passes/${passId}/change-requests`]) {
      expect((await t.as(sneaky, { url })).statusCode, url).toBe(403);
    }
  });

  it('шаблоны: право у владельца, администратора, согласующего и трёх ролей арендатора; у постов его нет', () => {
    const has = (code: string) => roleTemplate(code).permissions.includes('pass.history.view');
    for (const code of [
      'org_owner',
      'site_admin',
      'approver',
      'tenant_manager',
      'tenant_requester',
      'tenant_viewer',
    ]) {
      expect(has(code), code).toBe(true);
    }
    for (const code of ['gate_post', 'shift_senior', 'accountant']) {
      expect(has(code), code).toBe(false);
    }
  });

  it('редактор ролей: право нельзя выдать роли области «КПП»', async () => {
    const owner = roleActor('org_owner');
    const roles = (await t.as(owner, { url: '/roles' })).json().items as {
      id: string;
      templateCode: string | null;
      forGate: boolean;
      permissions: string[];
    }[];
    const post = roles.find((r) => r.templateCode === 'gate_post');
    expect(post?.forGate).toBe(true);
    expect(roles.find((r) => r.templateCode === 'tenant_manager')?.forGate).toBe(false);
    const res = await t.as(owner, {
      method: 'PATCH',
      url: `/roles/${post?.id}`,
      payload: { permissions: [...(post?.permissions ?? []), 'pass.history.view'] },
    });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toMatchObject({ code: 'validation_failed', field: 'permissions' });
  });
});

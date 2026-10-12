import { randomUUID } from 'node:crypto';
import { schema } from '@oxrana/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { gateActor, KEYS, ownerDb, roleActor, type TestApp } from '../support/harness';

/** Помощники сценарных тестов поста на демо-объекте. */
export const id = (map: Record<string, string>, name: string) => map[name] ?? '';
export const tenantKey = (name: string) => id(KEYS.tenants, name);
export const categoryKey = (name: string) => id(KEYS.categories, name);
export const dockKey = (n: string) => id(KEYS.docks, n);
export const gateKey = (name: string) => id(KEYS.gates, name);
export const quotaKey = (name: string) => id(KEYS.quotas, name);
/** Момент по местному времени объекта 10.03.2026: `at('12:00')`. */
export const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00+05:00`).toISOString();

export const admin = roleActor('site_admin');
export const kpp1 = gateActor('kpp1');
export const kpp2 = gateActor('kpp2');
export const office = gateActor('office');

let plateCounter = 0;
/** Уникальный номер российского формата: А{nnn}ВС174. */
export function uniquePlate(): string {
  plateCounter++;
  return `А${String(100 + plateCounter).padStart(3, '0')}ВС174`;
}

/** Разовый пропуск на фуру ДНС с доком и окном «сейчас» (создаёт администратор). */
export async function dnsTruck(
  t: TestApp,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await t.as(admin, {
    method: 'POST',
    url: '/passes',
    payload: {
      tenantId: tenantKey('dns'),
      passType: 'single',
      participant: 'vehicle',
      plate: uniquePlate(),
      categoryId: categoryKey('semi'),
      dockId: dockKey('12'),
      validFrom: at('12:00'),
      validTo: at('20:00'),
      windowFrom: at('12:00'),
      windowTo: at('14:00'),
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`пропуск не создан: ${res.body}`);
  return res.json().id;
}

/** Действие поста с новым id. */
export function action(
  t: TestApp,
  actor: typeof kpp2,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return t.as(actor, {
    method: 'POST',
    url: '/gate/actions',
    payload: { id: randomUUID(), ...body },
  });
}

/**
 * Заполнить лимит напрямую: N открытых визитов арендатора нужного типа (тестовые данные под
 * владельцем, минуя пост: так быстрее, а занятость считается так же — по открытым визитам).
 */
export async function fillVisits(tenant: string, category: string, n: number): Promise<void> {
  if (n === 0) return;
  await ownerDb()
    .insert(schema.visits)
    .values(
      Array.from({ length: n }, () => ({
        organizationId: KEYS.organizationId,
        siteId: KEYS.siteId,
        tenantId: tenant,
        participant: 'vehicle' as const,
        categoryId: category,
        snapshot: { note: 'тестовое заполнение' },
        gateInId: gateKey('kpp2'),
        timeIn: new Date(at('09:00')),
        methodIn: 'button' as const,
      })),
    );
}

/** Сбросить состояние между тестами: закрыть открытые визиты и очередь арендатора. */
export async function resetTenant(tenant: string): Promise<void> {
  const db = ownerDb();
  await db
    .update(schema.visits)
    .set({ timeOut: new Date(at('11:00')) })
    .where(and(eq(schema.visits.tenantId, tenant), isNull(schema.visits.timeOut)));
  await db
    .update(schema.gateQueue)
    .set({ leftAt: new Date(at('11:00')), leftReason: 'cancelled' })
    .where(and(eq(schema.gateQueue.tenantId, tenant), isNull(schema.gateQueue.leftAt)));
}

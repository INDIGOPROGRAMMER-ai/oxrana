import { randomUUID } from 'node:crypto';
import { ROLE_TEMPLATES } from '@oxrana/contracts';
import type { Actor } from '../src/actor';
import { gateActor, KEYS, roleActor } from './support/harness';

/**
 * Тест-матрица прав (ADR-007, B12): каждый маршрут API × каждая роль-шаблон × «без входа».
 * Маршруты берутся из реестра хука прав (`app.routeAccess`), поэтому новый маршрут попадает в
 * матрицу сам. Ожидание выводится из объявленного права: есть право (любое из списка) — хук
 * пропускает (ответ не 401 и не 403 с этим правом), нет — 403 с названием права; без входа — 401.
 * Акторы до этапа 5 фиктивные: права — из шаблона роли, область — демо-объект, у ролей арендатора —
 * первый арендатор сида (ключ dns).
 */
export interface MatrixActor {
  readonly role: string;
  readonly actor: Actor;
}

export function matrixActors(): MatrixActor[] {
  const dns = KEYS.tenants.dns ?? '';
  return ROLE_TEMPLATES.map((template) => ({
    role: template.code,
    actor:
      template.scope === 'gate'
        ? gateActor('kpp2', template.code)
        : roleActor(template.code, template.scope === 'tenant' ? { tenantIds: [dns] } : {}),
  }));
}

/** Подстановка параметров пути: реальные объект и арендатор демо-сида, остальное — новые uuid. */
export function concreteUrl(url: string): string {
  return url
    .replace(':siteId', KEYS.siteId)
    .replace(':tenantId', KEYS.tenants.dns ?? '')
    .replace(/:[A-Za-z]+/g, () => randomUUID());
}

/** Потоки SSE разрешённым акторам не открываем (inject ждал бы конца потока): их проверяет sse-тест. */
export const isStream = (url: string) => url.endsWith('/events');

/**
 * Варианты одного маршрута с уточнением права по телу запроса (ADR-017): действие поста требует
 * право своего вида. Тело проходит валидацию, поэтому до проверки права сервиса доходит.
 */
export const ACTION_VARIANTS: readonly { type: string; permission: string; body: () => object }[] =
  [
    { type: 'check_in', permission: 'visit.check_in', body: () => ({ passId: randomUUID() }) },
    { type: 'check_out', permission: 'visit.check_out', body: () => ({ passId: randomUUID() }) },
    {
      type: 'refuse',
      permission: 'gate.refuse',
      body: () => ({ passId: randomUUID(), direction: 'in', reason: 'проверка прав' }),
    },
    {
      type: 'redirect',
      permission: 'gate.redirect',
      body: () => ({ passId: randomUUID(), direction: 'in' }),
    },
    { type: 'undo', permission: 'gate.undo', body: () => ({ actionId: randomUUID() }) },
    { type: 'passage', permission: 'gate.passage', body: () => ({ passId: randomUUID() }) },
  ];

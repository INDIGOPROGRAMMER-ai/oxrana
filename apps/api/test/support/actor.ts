import type { Actor } from '../../src/actor';

/** Актор для юнит-тестов хука прав без БД (интеграционные тесты входят настоящими сессиями). */
export function testActor(overrides: Partial<Actor> & Pick<Actor, 'id'>): Actor {
  const permissions = overrides.permissions ?? new Set<string>();
  return {
    kind: 'user',
    organizationId: '00000000-0000-4000-8000-000000000000',
    permissions,
    grants: [{ permissions, siteId: null, tenantId: null }],
    siteIds: null,
    tenantIds: null,
    gateId: null,
    deviceId: null,
    ...overrides,
  };
}

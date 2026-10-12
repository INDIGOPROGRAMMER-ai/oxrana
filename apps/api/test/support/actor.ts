import type { Actor } from '../../src/actor';

/** Фиктивный актор для тестов (до этапа 5 актора не из чего строить). */
export function testActor(overrides: Partial<Actor> & Pick<Actor, 'id'>): Actor {
  return {
    kind: 'user',
    organizationId: '00000000-0000-4000-8000-000000000000',
    permissions: new Set(),
    siteIds: null,
    tenantIds: null,
    gateId: null,
    deviceId: null,
    ...overrides,
  };
}

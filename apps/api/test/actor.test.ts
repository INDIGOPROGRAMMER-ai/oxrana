import { describe, expect, it } from 'vitest';
import { actorFromGrants } from '../src/actor';

const grant = (permissions: string[]) => ({
  permissions: new Set(permissions),
  siteId: 'site-1',
  tenantId: null,
});

describe('актор учётки КПП (ADR-007, 7b.3)', () => {
  it('право «История пропуска» не действует, даже если оно есть в роли учётки', () => {
    const actor = actorFromGrants({
      id: 'acc-1',
      kind: 'gate_account',
      organizationId: 'org-1',
      grants: [grant(['pass.view_all_tenants', 'visit.check_in', 'pass.history.view'])],
      gateId: 'gate-1',
    });
    expect(actor.permissions.has('pass.history.view')).toBe(false);
    expect(actor.grants.every((g) => !g.permissions.has('pass.history.view'))).toBe(true);
    expect(actor.permissions.has('visit.check_in')).toBe(true);
  });

  it('сотруднику и пользователю арендатора право остаётся', () => {
    const user = actorFromGrants({
      id: 'u-1',
      kind: 'user',
      organizationId: 'org-1',
      grants: [grant(['pass.view', 'pass.history.view'])],
    });
    expect(user.permissions.has('pass.history.view')).toBe(true);
  });
});

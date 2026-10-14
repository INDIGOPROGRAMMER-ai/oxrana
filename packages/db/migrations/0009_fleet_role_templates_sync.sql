-- Этап 7a (ADR-007, «Новое право»). Новое право fleet.manage («Автопарк») не попало в роли, созданные
-- по шаблонам раньше: логист стенда не смог бы вести автопарк. Каждой роли с template_code
-- добавляются права её шаблона, которых в ней нет; лишние права роли не трогаются.
-- Текст получен `pnpm --filter @oxrana/db role-sync-sql`; следующее новое право — новая такая миграция.
UPDATE roles SET permissions = roles.permissions || ARRAY(
    SELECT p FROM unnest(t.permissions) AS p WHERE NOT (p = ANY (roles.permissions))
  )
  FROM (VALUES
    ('org_owner', ARRAY['site.manage', 'tenant.manage', 'tenant.block', 'contract.file', 'blacklist.manage', 'quota.manage', 'rule.manage', 'user.manage', 'role.manage', 'device.manage', 'hardware.manage', 'tenant_user.manage', 'pass.view', 'pass.view_all_tenants', 'pass.create.single', 'pass.create.multi', 'pass.create.permanent', 'pass.create_for_any_tenant', 'pass.edit', 'pass.cancel', 'pass.cancel_own', 'pass.approve', 'pass.change_request.create', 'pass.change_request.decide', 'fleet.manage', 'visit.check_in', 'visit.check_out', 'gate.redirect', 'gate.refuse', 'gate.request', 'gate.undo', 'gate.override_request', 'gate.override', 'gate.passage', 'queue.view', 'occupancy.view', 'violation.create', 'violation.manage', 'report.view', 'report.export', 'audit.view', 'sandbox.use', 'notification.manage_own', 'profile.manage_own']::text[]),
    ('site_admin', ARRAY['site.manage', 'tenant.manage', 'tenant.block', 'contract.file', 'blacklist.manage', 'quota.manage', 'rule.manage', 'user.manage', 'role.manage', 'device.manage', 'hardware.manage', 'tenant_user.manage', 'pass.view', 'pass.view_all_tenants', 'pass.create.single', 'pass.create.multi', 'pass.create.permanent', 'pass.create_for_any_tenant', 'pass.edit', 'pass.cancel', 'pass.cancel_own', 'pass.approve', 'pass.change_request.create', 'pass.change_request.decide', 'fleet.manage', 'gate.request', 'gate.override_request', 'gate.override', 'queue.view', 'occupancy.view', 'violation.create', 'violation.manage', 'report.view', 'report.export', 'audit.view', 'sandbox.use', 'notification.manage_own', 'profile.manage_own']::text[]),
    ('approver', ARRAY['pass.view_all_tenants', 'pass.approve', 'pass.change_request.decide', 'report.view', 'occupancy.view', 'profile.manage_own']::text[]),
    ('gate_post', ARRAY['pass.view_all_tenants', 'visit.check_in', 'visit.check_out', 'gate.redirect', 'gate.refuse', 'gate.request', 'gate.undo', 'gate.override_request', 'gate.passage', 'occupancy.view', 'queue.view', 'pass.create.single']::text[]),
    ('shift_senior', ARRAY['pass.view_all_tenants', 'visit.check_in', 'visit.check_out', 'gate.redirect', 'gate.refuse', 'gate.request', 'gate.undo', 'gate.override_request', 'gate.passage', 'occupancy.view', 'queue.view', 'pass.create.single', 'gate.override']::text[]),
    ('accountant', ARRAY['report.view', 'report.export', 'profile.manage_own']::text[]),
    ('tenant_manager', ARRAY['pass.view', 'pass.create.single', 'pass.create.multi', 'pass.create.permanent', 'pass.edit', 'pass.cancel', 'pass.cancel_own', 'pass.change_request.create', 'fleet.manage', 'tenant_user.manage', 'gate.request', 'report.view', 'report.export', 'occupancy.view', 'profile.manage_own']::text[]),
    ('tenant_requester', ARRAY['pass.view', 'pass.create.single', 'pass.create.multi', 'pass.create.permanent', 'pass.cancel_own', 'pass.change_request.create', 'profile.manage_own']::text[]),
    ('tenant_viewer', ARRAY['pass.view', 'occupancy.view', 'profile.manage_own']::text[])
  ) AS t(code, permissions)
 WHERE roles.template_code = t.code
   AND EXISTS (SELECT 1 FROM unnest(t.permissions) AS p WHERE NOT (p = ANY (roles.permissions)));

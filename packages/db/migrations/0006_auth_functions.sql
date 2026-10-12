-- Этап 5 (ADR-018). Вход и устройства.
--
-- 1. Токен устройства, код привязки и ссылка приглашения приходят без организации, а их таблицы
--    под RLS (роль приложения видит только строки своей организации). Функции ниже под владельцем
--    схемы находят по хэшу ТОЛЬКО id организации; дальше запрос идёт обычным путём, в контексте
--    этой организации и под RLS. Ничего, кроме id организации, они не возвращают.
CREATE FUNCTION auth_org_of_token(kind text, hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE kind
    WHEN 'device' THEN (SELECT organization_id FROM gate_devices WHERE token_hash = hash)
    WHEN 'enrollment' THEN (SELECT organization_id FROM device_enrollments WHERE code_hash = hash)
    WHEN 'invitation' THEN (SELECT organization_id FROM invitations WHERE token_hash = hash)
  END
$$;
--> statement-breakpoint
-- Организации, где у пользователя есть назначения ролей (сессия выбирает одну из них).
CREATE FUNCTION auth_user_organizations(uid uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ra.organization_id FROM role_assignments ra
    JOIN organizations o ON o.id = ra.organization_id AND o.deleted_at IS NULL
   WHERE ra.user_id = uid
   GROUP BY ra.organization_id
   ORDER BY min(ra.created_at), ra.organization_id
$$;
--> statement-breakpoint
-- Все организации — для фоновых задач (эскалация согласований), которые обходят их по одной.
CREATE FUNCTION app_organization_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM organizations WHERE deleted_at IS NULL ORDER BY created_at, id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_org_of_token(text, text), auth_user_organizations(uuid), app_organization_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_org_of_token(text, text), auth_user_organizations(uuid), app_organization_ids() TO oxrana_app;
--> statement-breakpoint
-- 2. Журнал входа только пополняется, как и другие журналы (миграции 0002, 0004).
REVOKE UPDATE, DELETE ON "auth_events" FROM oxrana_app;
--> statement-breakpoint
-- 3. Код шаблона у ролей, созданных до этапа 5 (сид): по названию шаблона, только у ролей-шаблонов.
UPDATE roles SET template_code = t.code
  FROM (VALUES
    ('org_owner', 'Владелец организации'),
    ('site_admin', 'Администратор объекта'),
    ('approver', 'Согласующий'),
    ('gate_post', 'Пост КПП'),
    ('shift_senior', 'Старший смены'),
    ('accountant', 'Бухгалтер'),
    ('tenant_manager', 'Арендатор — ответственный'),
    ('tenant_requester', 'Арендатор — заказчик'),
    ('tenant_viewer', 'Арендатор — наблюдатель')
  ) AS t(code, name)
 WHERE roles.is_template AND roles.template_code IS NULL AND roles.name = t.name;
--> statement-breakpoint
-- 4. Q-56: «Арендатор — заказчик» отменяет только свои пропуска (новое право pass.cancel_own);
--    владелец, администратор объекта и ответственный арендатора получают и его (иначе не смогут
--    пригласить заказчика: роль не шире своих прав).
UPDATE roles SET permissions = array_replace(permissions, 'pass.cancel', 'pass.cancel_own')
 WHERE template_code = 'tenant_requester';
--> statement-breakpoint
UPDATE roles SET permissions = array_append(permissions, 'pass.cancel_own')
 WHERE template_code IN ('org_owner', 'site_admin', 'tenant_manager') AND NOT ('pass.cancel_own' = ANY (permissions));

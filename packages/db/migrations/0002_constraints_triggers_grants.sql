-- Этап 2. То, что Drizzle не выражает в схеме (ADR-003 п. 2, ADR-014): exclusion-ограничения,
-- триггеры updated_at и outbox, права роли приложения на журналы. Выполняется под oxrana_owner.

-- 1. Невозможные состояния запрещает БД, а не только форма (DATA_MODEL §5 п. 15).

-- Док не бывает у двух арендаторов сразу (10_ §1). valid_to = null — бессрочно.
ALTER TABLE "tenant_dock_assignments" ADD CONSTRAINT "tenant_dock_assignments_no_overlap"
  EXCLUDE USING gist ("dock_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);
--> statement-breakpoint

-- Дубли действующих пропусков у одного арендатора запрещены (10_ §4); постоянный — до бесконечности (Z-14).
-- Пропуск на ту же машину у другого арендатора — не дубль («одна машина к двум арендаторам»).
ALTER TABLE "passes" ADD CONSTRAINT "passes_no_duplicate"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "plate_norm" WITH =,
    tstzrange("valid_from", coalesce("valid_to", 'infinity'::timestamptz)) WITH &&
  ) WHERE ("status" = 'approved' AND "plate_norm" IS NOT NULL);
--> statement-breakpoint

-- 2. updated_at ставит БД при любом UPDATE (DATA_MODEL, соглашения).
CREATE FUNCTION "set_updated_at"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- Триггер на каждой таблице с колонкой updated_at. Новая таблица в следующих миграциях создаёт
-- свой триггер явно; тест db/test/schema.integration.test.ts проверяет, что ни одна не забыта.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'updated_at' AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "set_updated_at"()',
      t || '_set_updated_at', t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- 3. Transactional outbox (ADR-004): после вставки события — NOTIFY с одними идентификаторами.
-- organizationId нужен слушателю, чтобы прочитать событие под RLS; доставляется при COMMIT.
CREATE FUNCTION "notify_domain_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'site_events',
    json_build_object('id', NEW."id", 'organizationId', NEW."organization_id", 'siteId', NEW."site_id")::text
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "domain_events_notify" AFTER INSERT ON "domain_events"
  FOR EACH ROW EXECUTE FUNCTION "notify_domain_event"();
--> statement-breakpoint

-- 4. Журналы не редактируются и не удаляются (ADR-003 п. 4, CLAUDE.md п. 6). Права по умолчанию
-- выданы миграцией 0000; здесь они урезаются. visits и barrier_commands обновляются (выезд, статус
-- команды), но не удаляются.
REVOKE UPDATE, DELETE ON "audit_log", "domain_events", "gate_decisions", "hardware_events" FROM oxrana_app;
--> statement-breakpoint
REVOKE DELETE ON "visits", "barrier_commands" FROM oxrana_app;

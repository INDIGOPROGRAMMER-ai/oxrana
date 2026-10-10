-- Этап 1. Расширения и права ролей. Таблиц нет: схема появится на этапе 2 (docs/DATA_MODEL.md).
-- Выполняется под oxrana_owner (ADR-003 п. 4). Роли создаёт scripts/db-up.sh или развёртывание (ADR-011).

-- Расширения (ADR-001): все «доверенные», владелец базы ставит их без суперпользователя.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

-- Роль приложения должна существовать и не обходить RLS (ADR-003 п. 4, DATA_MODEL §4).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxrana_app') THEN
    RAISE EXCEPTION 'Роль oxrana_app не найдена. Создайте её (pnpm db:up или раздел «Роли» в ADR-010) и повторите миграцию.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxrana_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Роль oxrana_app не должна быть суперпользователем и не должна иметь BYPASSRLS (ADR-003 п. 4).';
  END IF;
END
$$;
--> statement-breakpoint

-- Приложение подключается к базе и видит схему; таблицы, созданные следующими миграциями, получают
-- права по умолчанию. Урезать права на журналы (audit_log и др.) будут миграции этапа 2.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO oxrana_app', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO oxrana_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxrana_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO oxrana_app;

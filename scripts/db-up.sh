#!/usr/bin/env bash
# Поднимает PostgreSQL и готовит роли и базу (ADR-010). Идемпотентно, секунды.
#   облачная сессия: стартует системный кластер 16/main;
#   CI / внешний сервер: PGHOST задан, сервер уже работает — только роли и база.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/pg-admin.sh
source scripts/lib/pg-admin.sh

[ -f .env ] || cp .env.example .env

# Пароли ролей — из .env (dev-значения из .env.example).
set -a
# shellcheck disable=SC1091
source ./.env
set +a

if ! pg_isready -q ${PGHOST:+-h "$PGHOST"} ${PGPORT:+-p "$PGPORT"}; then
  if [ -n "${PGHOST:-}" ]; then
    echo "PostgreSQL на $PGHOST недоступен." >&2
    exit 1
  fi
  service postgresql start >&2
fi
wait_for_postgres

psql_admin -v owner_pw="${OXRANA_OWNER_PASSWORD:?}" -v app_pw="${OXRANA_APP_PASSWORD:?}" <<'SQL'
-- роли: создаются, если нет; пароли обновляются при каждом запуске
select 'create role oxrana_owner login createdb'
  where not exists (select from pg_roles where rolname = 'oxrana_owner') \gexec
select 'create role oxrana_app login'
  where not exists (select from pg_roles where rolname = 'oxrana_app') \gexec
alter role oxrana_owner password :'owner_pw';
alter role oxrana_app password :'app_pw';
-- база: расширения и права ставит первая миграция под oxrana_owner
select 'create database oxrana owner oxrana_owner'
  where not exists (select from pg_database where datname = 'oxrana') \gexec
SQL

echo "PostgreSQL готов: база oxrana, роли oxrana_owner и oxrana_app." >&2

#!/usr/bin/env bash
# Чистая база для E2E (ADR-016, ADR-018): oxrana_e2e пересоздаётся и получает только миграции —
# без демо-сида, как новый сервер перед «чистым стартом». Только dev/test.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/pg-admin.sh
source scripts/lib/pg-admin.sh

if [ "${NODE_ENV:-}" = "production" ]; then
  echo "e2e-db запрещён при NODE_ENV=production." >&2
  exit 1
fi
: "${E2E_DATABASE_ADMIN_URL:?Не задана E2E_DATABASE_ADMIN_URL (задаёт playwright.config.ts)}"

bash scripts/db-up.sh
psql_admin -c 'drop database if exists oxrana_e2e with (force)'
psql_admin -c 'create database oxrana_e2e owner oxrana_owner'
DATABASE_ADMIN_URL="$E2E_DATABASE_ADMIN_URL" pnpm --silent db:migrate >&2
echo "База oxrana_e2e готова: миграции без демо-данных." >&2

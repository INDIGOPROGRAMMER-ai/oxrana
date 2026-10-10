#!/usr/bin/env bash
# Пересоздаёт базу oxrana с нуля: миграции и демо-сид (ADR-010).
# Только для dev/test: данные в базе будут удалены.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/pg-admin.sh
source scripts/lib/pg-admin.sh

if [ "${NODE_ENV:-}" = "production" ]; then
  echo "db:reset запрещён при NODE_ENV=production." >&2
  exit 1
fi

bash scripts/db-up.sh
psql_admin -c 'drop database if exists oxrana with (force)'
bash scripts/db-up.sh
pnpm db:migrate
pnpm db:seed

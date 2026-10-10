#!/usr/bin/env bash
# Дымовая проверка сборки: запускает собранный API (apps/api/dist) и ждёт ответа /healthz.
# Ловит то, чего не видят тесты на исходниках (например, не те внешние зависимости бандла). Нужен `pnpm build`.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3199}"
LOG="$(mktemp)"
[ -f apps/api/dist/server.js ] || { echo "Нет apps/api/dist/server.js — сначала выполните pnpm build." >&2; exit 1; }

PORT="$PORT" NODE_ENV=production node --env-file-if-exists=.env apps/api/dist/server.js >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 1 40); do
  if body="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null)"; then
    echo "собранный API отвечает: $body"
    ready="$(curl -fsS "http://127.0.0.1:$PORT/readyz")" && echo "и готов к работе (БД отвечает): $ready"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.25
done

echo "Собранный API не ответил на /healthz. Лог:" >&2
cat "$LOG" >&2
exit 1

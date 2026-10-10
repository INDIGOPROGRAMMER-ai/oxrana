#!/bin/bash
# SessionStart-хук облачных сессий Claude Code (ADR-010 п. 6): к началу работы готовы зависимости,
# запущен PostgreSQL, применены миграции и демо-сид. Идемпотентен и быстр (~10 с на холодном контейнере,
# секунды на повторном запуске). Вне облака (CLAUDE_CODE_REMOTE != true) ничего не делает.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

failed=()
step() {
  local title="$1"
  shift
  echo "▶ $title" >&2
  if ! "$@" >&2; then
    echo "‼ Не удалось: $title" >&2
    failed+=("$title")
  fi
}

# Зависимости: при актуальном lock-файле pnpm завершается сразу. Каталог node_modules кэшируется контейнером.
step "pnpm install" pnpm install --frozen-lockfile --prefer-offline
# Postgres и роли: безопасно повторять; .env создаётся из .env.example при первом запуске.
step "pnpm db:up" pnpm db:up
step "pnpm db:migrate" pnpm db:migrate
# Демо-объект: сид идемпотентен, повторный запуск ничего не дублирует и не меняет.
step "pnpm db:seed" pnpm db:seed

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Окружение подготовлено не полностью (${failed[*]}). Повторите шаги вручную: см. раздел «Команды» в CLAUDE.md." >&2
  exit 1
fi
echo "Окружение готово: зависимости, PostgreSQL, миграции, демо-сид." >&2

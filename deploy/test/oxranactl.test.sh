#!/usr/bin/env bash
# shellcheck disable=SC2012 # ls в тестах используется только для подсчёта файлов с безопасными именами
# Проверка oxranactl без Docker: поддельные docker и curl (fakes/) моделируют контейнеры.
# Что доказывает: повторное обновление ничего не ломает (идемпотентность); неудачная проверка или
# миграция оставляют стенд на прежней версии; откат переключает версии; копии базы хранятся
# по правилам; чистый старт печатает ссылку только в терминал. Настоящий compose проверяет CI
# (задача «Стенд» в .github/workflows/ci.yml).
#   bash deploy/test/oxranactl.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export FAKE_DIR="$work/fake"
export OXRANA_HOME="$work/home"
export OXRANA_NO_REEXEC=1
export OXRANA_API_TIMEOUT=1
export OXRANA_PROXY_TIMEOUT=1
export PATH="$here/fakes:$PATH"
mkdir -p "$FAKE_DIR" "$OXRANA_HOME"
cp "$root/deploy/oxranactl" "$OXRANA_HOME/oxranactl"
cp "$root/deploy/compose.yml" "$OXRANA_HOME/compose.yml"
cat >"$OXRANA_HOME/.env" <<'ENV'
STAND_DOMAIN=stand.example.test
ACME_EMAIL=owner@example.test
POSTGRES_PASSWORD=pg-secret
OXRANA_OWNER_PASSWORD=owner-secret
OXRANA_APP_PASSWORD=app-secret
ENV
ctl() { bash "$OXRANA_HOME/oxranactl" "$@"; }

failures=0
check() { # check ОПИСАНИЕ КОМАНДА…
  local what=$1
  shift
  if "$@"; then
    printf '  ok   %s\n' "$what"
  else
    printf '  FAIL %s\n' "$what"
    failures=$((failures + 1))
  fi
}
state_is() { [ "$(cat "$OXRANA_HOME/state.env")" = "$(printf 'OXRANA_TAG=%s\nOXRANA_PREV_TAG=%s' "$1" "$2")" ]; }
api_runs() { [ "$(cat "$FAKE_DIR/api_tag")" = "$1" ]; }
add_images() { for t in "$@"; do printf 'oxrana-api:%s\noxrana-proxy:%s\n' "$t" "$t" >>"$FAKE_DIR/images"; done; }
fails() { ! "$@" >/dev/null 2>&1; }
quiet() { "$@" >/dev/null 2>&1; }

echo "первый деплой"
add_images v1
check "update v1 проходит" quiet ctl update v1
check "состояние v1, предыдущей нет" state_is v1 ''
check "api запущен на v1" api_runs v1
check "миграции запускались" grep -q 'migrate.js' "$FAKE_DIR/calls.log"
check "копии перед первым деплоем нет" test -z "$(ls "$OXRANA_HOME/backups" 2>/dev/null || true)"

echo "повторный деплой той же версии (идемпотентность)"
check "update v1 ещё раз проходит" quiet ctl update v1
check "состояние то же" state_is v1 ''
check "api на v1" api_runs v1

echo "обновление"
add_images v2
check "update v2 проходит" quiet ctl update v2
check "состояние v2, предыдущая v1" state_is v2 v1
check "перед обновлением сделана копия" test -n "$(ls "$OXRANA_HOME"/backups/pre-update-*.dump)"
check "права копии 600" test "$(stat -c %a "$OXRANA_HOME"/backups/pre-update-*.dump | sort -u)" = 600
check "повтор той же версии копий не плодит" test "$(ls "$OXRANA_HOME"/backups/pre-update-*.dump | wc -l)" -eq 1
check "update v2 повторно оставляет предыдущую v1" bash -c "bash '$OXRANA_HOME/oxranactl' update v2 >/dev/null"
check "…и состояние v2/v1" state_is v2 v1

echo "сбой проверки: стенд остаётся на прежней версии"
add_images v3
FAKE_BAD_TAG=v3 ctl update v3 >"$work/out.txt" 2>&1 && rc=0 || rc=$?
check "update v3 завершается ошибкой" test "$rc" -ne 0
check "состояние вернулось к v2/v1" state_is v2 v1
check "api вернулся на v2" api_runs v2
check "сообщение называет прежнюю версию" grep -q 'остался на прежней версии v2' "$work/out.txt"

echo "сбой контейнера (не healthy)"
FAKE_UNHEALTHY_TAG=v3 ctl update v3 >"$work/out.txt" 2>&1 && rc=0 || rc=$?
check "update v3 завершается ошибкой" test "$rc" -ne 0
check "состояние v2/v1, api на v2" bash -c "true"
check "состояние вернулось к v2/v1" state_is v2 v1
check "api вернулся на v2" api_runs v2

echo "сбой миграций: версия не переключается"
FAKE_FAIL_MIGRATE=1 ctl update v3 >"$work/out.txt" 2>&1 && rc=0 || rc=$?
check "update v3 завершается ошибкой" test "$rc" -ne 0
check "состояние v2/v1" state_is v2 v1
check "api на v2" api_runs v2

echo "версия без образов и неверный тег"
check "нет образов — отказ" fails ctl update v9
check "неверный тег — отказ" fails ctl update '../x'
check "пустой тег — отказ" fails ctl update

echo "откат"
check "rollback проходит" quiet ctl rollback
check "состояние v1/v2" state_is v1 v2
check "api на v1" api_runs v1
check "rollback на ту же версию — отказ" fails ctl rollback v1
check "rollback обратно проходит (переключение)" quiet ctl rollback
check "состояние v2/v1" state_is v2 v1
check "rollback без образов — отказ" fails ctl rollback v8

echo "копии базы"
rm -rf "$OXRANA_HOME/backups"
mkdir -p "$OXRANA_HOME/backups"
for d in 01 02 03 04 05 06 07 08 09; do : >"$OXRANA_HOME/backups/daily-202610$d-020000.dump"; done
check "backup проходит" quiet ctl backup
check "ночных копий осталось 7" test "$(ls "$OXRANA_HOME"/backups/daily-*.dump | wc -l)" -eq 7
check "самые старые удалены" test ! -e "$OXRANA_HOME/backups/daily-20261001-020000.dump"
check "свежая копия непустая" bash -c "find '$OXRANA_HOME/backups' -name 'daily-2*.dump' -size +0 | grep -q ."
for d in 01 02 03 04 05; do : >"$OXRANA_HOME/backups/pre-update-202610$d-020000.dump"; done
ctl backup >/dev/null
check "копии перед обновлением не вытесняются ночными" test "$(ls "$OXRANA_HOME"/backups/pre-update-*.dump | wc -l)" -eq 5

echo "восстановление"
check "без --yes — отказ" fails ctl restore "$OXRANA_HOME/backups/daily-20261005-020000.dump"
latest="$(ls "$OXRANA_HOME"/backups/daily-*.dump | tail -n 1)"
check "restore --yes проходит" quiet ctl restore "$latest" --yes
check "перед восстановлением сделана страховочная копия" test -n "$(ls "$OXRANA_HOME"/backups/pre-restore-*.dump)"

echo "чистый старт"
out="$(ctl bootstrap --org 'Тест' --slug test --timezone Asia/Yekaterinburg --owner-name 'Иван' --owner-email o@example.test)"
check "ссылка напечатана в терминал" bash -c "[[ '$out' == *SECRET-TOKEN* ]]"
check "параметры переданы команде" bash -c "[[ '$out' == *'--slug test'* ]]"
out="$(printf 'Тест\ntest\n\nИван\no@example.test\nд\n' | ctl bootstrap)"
check "вопросы по шагам: часовой пояс по умолчанию" bash -c "[[ '$out' == *'--timezone Asia/Yekaterinburg'* ]]"
check "ответ «нет» ничего не создаёт" fails bash -c "printf 'Тест\ntest\n\nИван\no@example.test\nн\n' | bash '$OXRANA_HOME/oxranactl' bootstrap"

echo "служебные команды"
check "status" ctl status
check "health" ctl health
check "logs" ctl logs api 5
check "load принимает образы" bash -c "echo x | FAKE_LOAD_TAGS=v4 bash '$OXRANA_HOME/oxranactl' load >/dev/null && grep -q oxrana-api:v4 '$FAKE_DIR/images'"
check "неизвестная команда — отказ" fails ctl nonsense

echo "очистка старых образов"
add_images v5 v6 v7 v8
ctl update v2 >/dev/null
check "текущая и предыдущая сохранены" grep -q 'oxrana-api:v2' "$FAKE_DIR/images"
check "лишние старые удалены" bash -c "test \"\$(grep -c '^oxrana-api:' '$FAKE_DIR/images')\" -le 6"

if [ "$failures" -ne 0 ]; then
  printf '\nПровалено проверок: %s\n' "$failures"
  exit 1
fi
printf '\nВсе проверки oxranactl пройдены.\n'

#!/usr/bin/env bash
# Проверка разбора параметров и записи .env в setup-vps.sh без изменения системы
# (сам скрипт настройки сервера проверяется shellcheck и ручным запуском на VPS).
#   bash deploy/test/setup-vps.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export SETUP_SOURCE_ONLY=1
export OXRANA_HOME="$work/home"
export OXRANA_KEY_DIR="$work/keys"
# shellcheck source=../setup-vps.sh
. "$here/../setup-vps.sh"

failures=0
check() {
  local what=$1
  shift
  if "$@"; then printf '  ok   %s\n' "$what"; else
    printf '  FAIL %s\n' "$what"
    failures=$((failures + 1))
  fi
}
rejects() { ! (parse_args "$@") >/dev/null 2>&1; }
accepts() { (parse_args "$@") >/dev/null 2>&1; }

echo "параметры"
check "домен и e-mail принимаются" accepts stand.example.ru owner@example.ru
check "поддомен глубже принимается" accepts a.b.stand.example.ru owner@example.ru
check "без параметров — отказ" rejects
check "один параметр — отказ" rejects stand.example.ru
check "домен без точки — отказ" rejects localhost owner@example.ru
check "IP вместо домена — отказ" rejects 203.0.113.5 owner@example.ru
check "домен с пробелом — отказ" rejects 'stand example.ru' owner@example.ru
check "e-mail без @ — отказ" rejects stand.example.ru owner.example.ru
check "лишние параметры — отказ" rejects stand.example.ru owner@example.ru extra
parse_args Stand.Example.RU owner@example.ru
check "домен приводится к нижнему регистру" test "$DOMAIN" = stand.example.ru

echo "запись .env"
env="$work/e.env"
printf 'A=1\nSTAND_DOMAIN=old.example.ru\n' >"$env"
set_env_value "$env" STAND_DOMAIN new.example.ru
set_env_value "$env" B 2
check "значение заменено" grep -qx 'STAND_DOMAIN=new.example.ru' "$env"
check "новое значение добавлено" grep -qx 'B=2' "$env"
check "чужие строки не тронуты" grep -qx 'A=1' "$env"
check "дубликатов нет" test "$(grep -c '^STAND_DOMAIN=' "$env")" -eq 1

if [ "$(id -u)" -eq 0 ]; then
  export DEPLOY_USER=root
  DOMAIN=stand.example.ru EMAIL=owner@example.ru write_env >/dev/null
  first="$(cat "$OXRANA_HOME/.env")"
  DOMAIN=stand.example.ru EMAIL=owner@example.ru write_env >/dev/null
  check "повторный запуск не меняет .env и пароли" test "$first" = "$(cat "$OXRANA_HOME/.env")"
  check "пароли сгенерированы (48 символов)" test "$(grep -c '^OXRANA_APP_PASSWORD=.\{48\}$' "$OXRANA_HOME/.env")" -eq 1
  check "права .env 600" test "$(stat -c %a "$OXRANA_HOME/.env")" = 600
  DOMAIN=other.example.ru EMAIL=owner@example.ru write_env >/dev/null
  check "смена домена обновляет только домен" test "$(grep -c '^STAND_DOMAIN=other.example.ru$' "$OXRANA_HOME/.env")" -eq 1
  check "…пароли прежние" test "$(grep '_PASSWORD=' "$OXRANA_HOME/.env")" = "$(printf '%s' "$first" | grep '_PASSWORD=')"
else
  echo "  --   запись .env пропущена (нужен root для chown)"
fi

if [ "$failures" -ne 0 ]; then
  printf '\nПровалено проверок: %s\n' "$failures"
  exit 1
fi
printf '\nВсе проверки setup-vps.sh пройдены.\n'

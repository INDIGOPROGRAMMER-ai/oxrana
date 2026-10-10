# Подключается через `source`. Даёт `psql_admin` — psql под суперпользователем PostgreSQL:
#  - в облачной сессии (ADR-010): локальный кластер, ОС-пользователь postgres, peer-авторизация;
#  - в CI и у разработчика с внешним сервером: задайте PGHOST (+ PGUSER, PGPASSWORD) — тогда обычный psql.

psql_admin() {
  if [ -n "${PGHOST:-}" ]; then
    psql -X -q -v ON_ERROR_STOP=1 "$@"
  elif [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"
  else
    sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}

# Ждёт, пока сервер начнёт принимать соединения (до 30 с).
wait_for_postgres() {
  local i
  for i in $(seq 1 60); do
    if pg_isready -q ${PGHOST:+-h "$PGHOST"} ${PGPORT:+-p "$PGPORT"}; then
      return 0
    fi
    sleep 0.5
  done
  echo "PostgreSQL не отвечает за 30 с. Проверьте: service postgresql status (или PGHOST/PGPORT для внешнего сервера)." >&2
  return 1
}

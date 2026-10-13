#!/usr/bin/env bash
# Первичная настройка VPS стенда (ADR-019, docs/STAND.md). Запускается один раз вставкой одной
# команды в окно SSH под root (ssh root@IP) на чистой Ubuntu 24.04:
#
#   curl -fsSL https://raw.githubusercontent.com/INDIGOPROGRAMMER-ai/oxrana/main/deploy/setup-vps.sh | bash -s -- ДОМЕН E-MAIL
#
# Делает: пользователь deploy (без root и sudo), Docker, брандмауэр (только 22, 80, 443), вход по SSH
# только по ключу, fail2ban, автоматические обновления безопасности, swap, пояс сервера UTC,
# ночная копия базы. Создаёт ключ деплоя и в конце печатает, что вставить в секреты GitHub.
# Идемпотентен: повторный запуск ничего не ломает и заново печатает данные для GitHub.
set -euo pipefail

REPO_RAW="${OXRANA_REPO_RAW:-https://raw.githubusercontent.com/INDIGOPROGRAMMER-ai/oxrana/main}"
HOME_DIR="${OXRANA_HOME:-/opt/oxrana}"
DEPLOY_USER="${OXRANA_DEPLOY_USER:-deploy}"
KEY_DIR="${OXRANA_KEY_DIR:-/root/.oxrana}"
ROOT_AUTH_KEYS="${OXRANA_ROOT_AUTH_KEYS:-/root/.ssh/authorized_keys}"
SWAP_SIZE_GB=2

DOMAIN=''
EMAIL=''

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() {
  printf '\nОшибка: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Использование: setup-vps.sh ДОМЕН E-MAIL
  ДОМЕН   адрес стенда, например stand.example.ru (A-запись должна указывать на этот сервер)
  E-MAIL  ваш адрес для служебных писем Let's Encrypt
EOF
}

parse_args() {
  [ $# -eq 2 ] || {
    usage
    die "нужны два параметра: домен и e-mail."
  }
  DOMAIN="${1,,}"
  EMAIL="$2"
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "«$1» не похоже на домен (пример: stand.example.ru)."
  [[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "«$2» не похоже на e-mail."
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "запустите от root (в веб-консоли хостера вы обычно уже root)."
}

check_os() {
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
    die "скрипт рассчитан на Ubuntu 24.04, а здесь ${PRETTY_NAME:-неизвестная система}. Пересоздайте сервер с Ubuntu 24.04."
  fi
}

# В файле есть хотя бы один ключ администратора: непустая строка, не комментарий, с типом ключа
# (допускаются параметры перед ним). Ключ деплоя пишется в authorized_keys пользователя deploy, не root.
admin_key_present() {
  local file=${1:-$ROOT_AUTH_KEYS}
  [ -f "$file" ] || return 1
  grep -Eq '^[[:space:]]*([^#[:space:]][^[:space:]]*[[:space:]]+)?(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp[0-9]+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[[:space:]]+[A-Za-z0-9+/=]{20,}' "$file"
}

# Без ключа администратора отключение входа по паролю закрыло бы сервер для владельца: не отключаем
# молча, а останавливаемся до любых изменений и объясняем, как добавить ключ.
require_admin_key() {
  admin_key_present && return 0
  cat >&2 <<EOF

Остановлено: на сервере нет вашего ключа SSH (файл $ROOT_AUTH_KEYS пуст или отсутствует).

Скрипт отключает вход по паролю — дальше на сервер пускают только по ключу. Если ключа нет, вы
заперли бы себя на сервере (останется только консоль хостера). Ничего не изменено.

Что сделать (один раз):
  1. На своём компьютере создайте ключ (если ещё нет) и покажите его открытую часть:
       Windows (PowerShell):  ssh-keygen -t ed25519
                              Get-Content \$env:USERPROFILE\.ssh\id_ed25519.pub
       macOS (Терминал):      ssh-keygen -t ed25519
                              cat ~/.ssh/id_ed25519.pub
     Это одна строка, начинается с ssh-ed25519. Закрытый файл (без .pub) никому не отправляйте.
  2. Добавьте её на сервер — в панели хостера («SSH-ключи») или командой здесь, в консоли сервера:
       mkdir -p ~/.ssh && chmod 700 ~/.ssh
       echo "ВАША_СТРОКА_ЦЕЛИКОМ" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  3. Проверьте с компьютера, что вход по ключу работает:  ssh root@IP_СЕРВЕРА  (пароль не спросит).
  4. Запустите ту же команду установки ещё раз.

Подробнее: docs/STAND.md, шаг 1 «Как получить ключ».
EOF
  exit 1
}

install_packages() {
  log "Пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg openssl ufw fail2ban python3-systemd unattended-upgrades openssh-server util-linux >/dev/null
}

set_time() {
  log "Время: пояс сервера UTC, синхронизация включена"
  timedatectl set-timezone UTC
  timedatectl set-ntp true || note "не удалось включить синхронизацию времени — проверьте позже: timedatectl"
}

setup_swap() {
  log "Swap ${SWAP_SIZE_GB} ГБ"
  if [ -n "$(swapon --show --noheadings)" ]; then
    note "swap уже есть — пропускаем"
  else
    if [ ! -f /swapfile ]; then
      fallocate -l "${SWAP_SIZE_GB}G" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_SIZE_GB * 1024)) status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-oxrana.conf
  sysctl -q -p /etc/sysctl.d/99-oxrana.conf >/dev/null
}

install_docker() {
  log "Docker"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    note "Docker уже установлен — пропускаем"
  else
    export DEBIAN_FRONTEND=noninteractive
    install -m 0755 -d /etc/apt/keyrings
    # Основной путь — официальный репозиторий Docker; если он недоступен с этого хостинга — пакеты Ubuntu.
    if curl -fsSL --max-time 30 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc &&
      chmod a+r /etc/apt/keyrings/docker.asc &&
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
        "$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$VERSION_CODENAME")" >/etc/apt/sources.list.d/docker.list &&
      apt-get update -qq &&
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null; then
      note "установлен Docker CE из репозитория Docker"
    else
      note "репозиторий Docker недоступен — ставим пакеты Ubuntu (docker.io)"
      rm -f /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
    fi
  fi
  # Журналы контейнеров не должны забить диск
  if [ ! -f /etc/docker/daemon.json ]; then
    install -d /etc/docker
    cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
    systemctl restart docker
  fi
  systemctl enable --now docker >/dev/null 2>&1
  docker compose version >/dev/null || die "docker compose не работает после установки."
}

create_deploy_user() {
  log "Пользователь $DEPLOY_USER (без root и sudo, в группе docker)"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$DEPLOY_USER" >/dev/null
  fi
  usermod -aG docker "$DEPLOY_USER"
}

create_deploy_key() {
  log "Ключ деплоя"
  install -d -m 700 "$KEY_DIR"
  if [ ! -f "$KEY_DIR/deploy_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "oxrana-deploy" -f "$KEY_DIR/deploy_key" </dev/null
    note "создан новый ключ"
  else
    note "ключ уже есть — используем его"
  fi
  local home ssh_dir
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  ssh_dir="$home/.ssh"
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ssh_dir"
  # Ключ ограничен (restrict): без перенаправления портов, агента и терминала; свои строки заменяем
  { grep -v ' oxrana-deploy$' "$ssh_dir/authorized_keys" 2>/dev/null || true; } >"$ssh_dir/authorized_keys.new"
  printf 'restrict %s\n' "$(cat "$KEY_DIR/deploy_key.pub")" >>"$ssh_dir/authorized_keys.new"
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ssh_dir/authorized_keys.new" "$ssh_dir/authorized_keys"
  rm -f "$ssh_dir/authorized_keys.new"
}

random_secret() {
  openssl rand -hex 24
}

# Устанавливает KEY=VALUE в файле: заменяет строку или добавляет в конец.
set_env_value() {
  local file=$1 key=$2 value=$3
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

write_env() {
  local env="$HOME_DIR/.env" key
  log "Каталог $HOME_DIR и настройки .env"
  install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR"
  if [ ! -f "$env" ]; then
    install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$env"
    note "создан $env со случайными паролями (в репозиторий они не попадают)"
  fi
  set_env_value "$env" STAND_DOMAIN "$DOMAIN"
  set_env_value "$env" ACME_EMAIL "$EMAIL"
  for key in POSTGRES_PASSWORD OXRANA_OWNER_PASSWORD OXRANA_APP_PASSWORD; do
    # существующие пароли не меняем: база уже могла быть создана с ними
    grep -qE "^$key=.+" "$env" || set_env_value "$env" "$key" "$(random_secret)"
  done
  chown "$DEPLOY_USER:$DEPLOY_USER" "$env"
  chmod 600 "$env"
}

fetch_files() {
  local f missing=0
  log "Файлы обслуживания (oxranactl, compose.yml)"
  for f in compose.yml oxranactl; do
    # Дальше их привозит каждый деплой; здесь — только первоначальная копия. Из РФ
    # raw.githubusercontent.com временами недоступен — тогда файлы привезёт первый деплой.
    if [ ! -f "$HOME_DIR/$f" ]; then
      if curl -fsSL --max-time 60 "$REPO_RAW/deploy/$f" -o "$HOME_DIR/$f.part"; then
        mv "$HOME_DIR/$f.part" "$HOME_DIR/$f"
        chown "$DEPLOY_USER:$DEPLOY_USER" "$HOME_DIR/$f"
      else
        rm -f "$HOME_DIR/$f.part"
        missing=1
      fi
    fi
  done
  if [ -f "$HOME_DIR/oxranactl" ]; then
    chmod 755 "$HOME_DIR/oxranactl"
  fi
  ln -sf "$HOME_DIR/oxranactl" /usr/local/bin/oxranactl
  if [ "$missing" -eq 1 ]; then
    note "GitHub сейчас не отдаёт файлы — их привезёт первый деплой (docs/STAND.md, шаг 5)"
  fi
}

harden_ssh() {
  local conf=/etc/ssh/sshd_config.d/00-oxrana.conf
  admin_key_present || die "нет ключа администратора в $ROOT_AUTH_KEYS — вход по паролю не отключаем."
  log "SSH: вход только по ключу"
  install -d /etc/ssh/sshd_config.d
  # Имя начинается с 00: в sshd первое найденное значение главнее, а cloud-init кладёт свой файл
  # с PasswordAuthentication yes позже по алфавиту.
  cat >"$conf" <<'EOF'
# Управляется deploy/setup-vps.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
  if ! sshd -t; then
    rm -f "$conf"
    die "настройка SSH не прошла проверку (sshd -t); изменения отменены."
  fi
  systemctl reload-or-restart ssh
  local effective
  effective="$(sshd -T)" # сначала целиком: grep -q закрыл бы канал раньше времени и pipefail счёл бы это сбоем
  if ! grep -qi '^passwordauthentication no$' <<<"$effective"; then
    die "вход по паролю в SSH остался включённым (проверьте /etc/ssh/sshd_config и sshd_config.d)."
  fi
  note "вход по паролю отключён, вход по ключу работает"
}

ssh_port() {
  local effective
  effective="$(sshd -T)"
  awk '$1 == "port" { print $2; exit }' <<<"$effective"
}

setup_firewall() {
  local port
  port="$(ssh_port)"
  log "Брандмауэр: открыты только $port (SSH), 80 и 443"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "$port/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  note "Docker публикует только порты 80 и 443; база и API наружу не выходят"
}

setup_fail2ban() {
  log "fail2ban: защита SSH от перебора"
  cat >/etc/fail2ban/jail.d/oxrana.local <<EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd
port = $(ssh_port)
EOF
  systemctl enable fail2ban >/dev/null 2>&1
  systemctl restart fail2ban
}

setup_auto_updates() {
  log "Автоматические обновления безопасности"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  # Перезагрузка только если обновление её требует, ночью (стенд поднимется сам: restart: unless-stopped)
  cat >/etc/apt/apt.conf.d/52oxrana-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
  systemctl enable --now unattended-upgrades >/dev/null 2>&1
}

setup_backup_timer() {
  log "Ночная копия базы (02:00 UTC, хранится 7 последних, каталог $HOME_DIR/backups)"
  cat >/etc/systemd/system/oxrana-backup.service <<EOF
[Unit]
Description=Копия базы стенда oxrana
After=docker.service

[Service]
Type=oneshot
User=$DEPLOY_USER
ExecStart=$HOME_DIR/oxranactl backup
EOF
  cat >/etc/systemd/system/oxrana-backup.timer <<'EOF'
[Unit]
Description=Ночная копия базы стенда oxrana

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now oxrana-backup.timer >/dev/null 2>&1
}

public_ip() {
  curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null ||
    curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null ||
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

report() {
  local ip dns_ip host_key
  ip="$(public_ip || true)"
  dns_ip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
  # Строка known_hosts: «адрес тип ключ». Без адреса в начале ssh её не сопоставит с сервером.
  host_key="${ip:-IP_СЕРВЕРА} $(awk '{ print $1 " " $2 }' /etc/ssh/ssh_host_ed25519_key.pub)"

  cat <<EOF

============================================================================
 СЕРВЕР НАСТРОЕН
============================================================================
 Домен:        $DOMAIN
 IP сервера:   ${ip:-не удалось определить — посмотрите в панели хостера}
EOF
  if [ -z "$dns_ip" ]; then
    cat <<EOF

 ВНИМАНИЕ: домен $DOMAIN пока не указывает ни на какой адрес. Создайте A-запись
 на IP сервера (docs/STAND.md, шаг 2). Первый деплой без неё не пройдёт.
EOF
  elif [ -n "$ip" ] && [ "$dns_ip" != "$ip" ]; then
    cat <<EOF

 ВНИМАНИЕ: домен $DOMAIN указывает на $dns_ip, а этот сервер — $ip.
 Исправьте A-запись (docs/STAND.md, шаг 2) и дождитесь обновления DNS.
EOF
  else
    printf '\n DNS в порядке: %s → %s\n' "$DOMAIN" "$dns_ip"
  fi
  cat <<EOF

----------------------------------------------------------------------------
 ЧТО ВСТАВИТЬ В GITHUB
 Репозиторий → Settings → Secrets and variables → Actions
----------------------------------------------------------------------------
 Вкладка «Secrets» → New repository secret (три секрета):

 1) Имя:    STAND_HOST
    Значение: ${ip:-IP сервера из панели хостера}

 2) Имя:    STAND_KNOWN_HOSTS
    Значение (одна строка):
$host_key
    (строка начинается с IP сервера; если IP выше определён неверно — замените первое слово на верный IP)

 3) Имя:    STAND_SSH_KEY
    Значение (всё, от строки BEGIN до строки END включительно):

$(cat "$KEY_DIR/deploy_key")

 Вкладка «Variables» → New repository variable (одна переменная):

 4) Имя:    STAND_DOMAIN
    Значение: $DOMAIN

----------------------------------------------------------------------------
 Ключ выше — пароль от деплоя на этот сервер. После того как вы вставили его
 в GitHub, очистите экран консоли и не пересылайте его никому. Если ключ
 попал не туда — удалите файл $KEY_DIR/deploy_key и запустите эту команду
 ещё раз: будет выпущен новый ключ, старый перестанет действовать.
============================================================================
EOF
}

main() {
  parse_args "$@"
  require_root
  check_os
  require_admin_key
  install_packages
  set_time
  setup_swap
  install_docker
  create_deploy_user
  create_deploy_key
  write_env
  fetch_files
  harden_ssh
  setup_firewall
  setup_fail2ban
  setup_auto_updates
  setup_backup_timer
  report
}

# Вызов — последней строкой, после определения всех функций: при запуске через `curl | bash`
# недокачанный скрипт не выполнится наполовину. SETUP_SOURCE_ONLY=1 — подключить функции в тестах.
if [ "${SETUP_SOURCE_ONLY:-}" != 1 ]; then
  main "$@" </dev/null
fi

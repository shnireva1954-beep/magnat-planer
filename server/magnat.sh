#!/usr/bin/env bash
# =============================================================================
#  Магнат на своём сервере — выкладка и состояние. Ставится командой
#  server/install.sh в /usr/local/sbin/magnat.
#
#    magnat deploy   забрать `main` из GitHub и выложить, если он новый.
#                    Его зовёт таймер раз в минуту — руками не нужно.
#    magnat status   что сейчас на сервере (только чтение) — это и присылать.
#
#  Как устроена выкладка (порядок важен, и каждый шаг откатный):
#   1. git fetch `main` под пользователем magnat (не root): сначала ключом
#      выкладки по SSH, пока репозиторий открыт — ещё и анонимно по HTTPS.
#   2. Новый коммит → распаковать в releases/<коммит>, вырезать служебное
#      (список — `exclude` в _config.yml, плюс server/, CNAME, файлы на «.» и
#      «_»), проверить, что index.html на месте и это Магнат.
#   3. Переключить ссылку current одним атомарным `mv` — посетитель видит
#      либо старую версию, либо новую, никогда не половину.
#   4. Если в коммите другой server/Caddyfile — `caddy validate`, применить,
#      проверить, что сайт отвечает; не ответил — вернуть прежний.
#   5. Хранить пять последних выкладок — откат: `magnat rollback`.
#
#  Плюс самолечение сертификата: пока адрес ещё смотрит на GitHub, Caddy не
#  может получить сертификат и ждёт с нарастающей паузой (до часа). Как только
#  адрес начал вести сюда, а HTTPS всё ещё не работает, — перезапускаем Caddy,
#  не чаще раза в 15 минут. Иначе после смены DNS сайт мог лежать час.
# =============================================================================
set -euo pipefail

DOMAIN="${MAGNAT_DOMAIN:-magnat-planer.ru}"
REPO="${MAGNAT_REPO:-shnireva1954-beep/magnat-planer}"
BRANCH="${MAGNAT_BRANCH:-main}"
BASE="${MAGNAT_BASE:-/srv/magnat}"
STATE="${MAGNAT_STATE:-/var/lib/magnat}"
CADDYFILE="${MAGNAT_CADDYFILE:-/etc/caddy/Caddyfile}"
USER_NAME="${MAGNAT_USER:-magnat}"
KEEP=5

SRC="$STATE/src"
KEY="$STATE/deploy_key"
KNOWN="$STATE/known_hosts"
URL_SSH="${MAGNAT_URL_SSH:-ssh://git@ssh.github.com:443/${REPO}.git}"   # 443 — пройдёт, даже если 22 режут
URL_HTTPS="${MAGNAT_URL_HTTPS:-https://github.com/${REPO}.git}"
HTTP_PORT="${MAGNAT_HTTP_PORT:-80}"
# MAGNAT_* переопределяет только проверка (tests/06-server.js); на сервере их нет.

log() { echo "magnat: $*"; }

as_user() {
  # Git ходит в сеть не от root: если с той стороны придёт что-то не то,
  # оно останется в правах пользователя magnat.
  if [ "$(id -u)" -eq 0 ] && [ "$(id -un)" != "$USER_NAME" ]; then
    runuser -u "$USER_NAME" -- env HOME="$STATE" "$@"
  else
    "$@"
  fi
}

git_src() {
  as_user env GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15" \
    git -C "$SRC" "$@"
}

# --- 1. забрать main ----------------------------------------------------------
fetch_main() {
  [ -d "$SRC/.git" ] || as_user git init -q "$SRC"
  local how=""
  if [ -s "$KEY" ] && git_src fetch -q --depth 1 "$URL_SSH" "$BRANCH" 2>"$STATE/fetch-ssh.err"; then
    how="ключ"
  elif git_src fetch -q --depth 1 "$URL_HTTPS" "$BRANCH" 2>"$STATE/fetch-https.err"; then
    how="открытый доступ"
  else
    echo "нет" > "$STATE/fetch-how"
    log "не забрал $BRANCH: ни ключом, ни открыто (подробно: $STATE/fetch-*.err)" >&2
    return 1
  fi
  echo "$how" > "$STATE/fetch-how"
  git_src rev-parse FETCH_HEAD
}

# Список «не выкладывать»: то же, что GitHub Pages прятал по _config.yml.
excluded_from() {
  local cfg="$1/_config.yml"
  [ -f "$cfg" ] || return 0
  awk '/^exclude:/{on=1; next} on && /^[^ \t-]/{on=0} on && /^[ \t]*-[ \t]*/{sub(/^[ \t]*-[ \t]*/,""); gsub(/["\047]/,""); sub(/[ \t]+#.*$/,""); print}' "$cfg"
}

# --- 2-3. выложить ------------------------------------------------------------
publish() {
  local sha="$1" rel="$BASE/releases/$1" tmp="$BASE/releases/.tmp-$1"
  rm -rf "$tmp"; mkdir -p "$tmp"
  git_src archive --format=tar "$sha" | tar -x -C "$tmp"

  local p
  while IFS= read -r p; do
    p="${p%/}"; [ -n "$p" ] || continue
    case "$p" in /*|*..*) continue ;; esac     # только внутри выкладки
    rm -rf -- "${tmp:?}/$p"
  done < <(excluded_from "$tmp")
  rm -rf -- "$tmp/server" "$tmp/CNAME" "$tmp/tests" "$tmp/tools"
  find "$tmp" -mindepth 1 \( -name '.*' -o -name '_*' -o -name '*.md' \) -prune -exec rm -rf {} +

  # Проверка: без index.html или с чужой страницей не выкладываем вовсе —
  # лучше остаться на прошлой версии, чем показать пустоту.
  if [ ! -s "$tmp/index.html" ] || ! grep -q 'Магнат' "$tmp/index.html"; then
    rm -rf "$tmp"
    echo "$1" > "$STATE/skip-sha"            # не пробовать его каждую минуту
    log "коммит ${sha:0:7}: нет index.html Магната — НЕ выкладываю, остаётся прежняя версия" >&2
    return 1
  fi
  chmod -R u=rwX,go=rX "$tmp"
  rm -rf "$rel"; mv "$tmp" "$rel"
  switch_to "$sha"
  log "выложено ${sha:0:7}"
}

switch_to() {
  ln -sfn "releases/$1" "$BASE/current.new"
  mv -Tf "$BASE/current.new" "$BASE/current"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE/deployed-at"
}

current_sha() { basename "$(readlink "$BASE/current" 2>/dev/null || echo none)"; }

prune() {
  local cur; cur="$(current_sha)"
  # shellcheck disable=SC2010,SC2012  # имена выкладок — хэши коммитов
  { ls -1t "$BASE/releases" 2>/dev/null | grep -v '^\.' | grep -vx "$cur" || true; } | tail -n +"$KEEP" |
    while IFS= read -r d; do rm -rf -- "${BASE:?}/releases/$d"; done
}

# --- 4. Caddyfile из репозитория ------------------------------------------------
https_ok() {
  curl --noproxy "*" -fsS -o /dev/null --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>/dev/null
}
http_ok() {
  # До сертификата HTTPS не работает, но Caddy жив, если отвечает на 80.
  curl --noproxy "*" -sS -o /dev/null --max-time 5 -H "Host: $DOMAIN" "http://127.0.0.1:$HTTP_PORT/" 2>/dev/null
}

apply_caddyfile() {
  local sha="$1" new; new="$(mktemp)"
  if ! git_src show "$sha:server/Caddyfile" > "$new" 2>/dev/null; then rm -f "$new"; return 0; fi
  if cmp -s "$new" "$CADDYFILE"; then rm -f "$new"; return 0; fi
  if ! caddy validate --config "$new" --adapter caddyfile >"$STATE/caddy-validate.log" 2>&1; then
    log "server/Caddyfile из ${sha:0:7} НЕ прошёл проверку — оставлен прежний ($STATE/caddy-validate.log)" >&2
    rm -f "$new"; return 0
  fi
  cp -f "$CADDYFILE" "$CADDYFILE.prev" 2>/dev/null || true
  install -m 0644 "$new" "$CADDYFILE"; rm -f "$new"
  if systemctl reload caddy && sleep 2 && { https_ok || http_ok; }; then
    log "применён Caddyfile из ${sha:0:7}"
  else
    log "Caddyfile из ${sha:0:7} сломал сайт — возвращаю прежний" >&2
    [ -f "$CADDYFILE.prev" ] && install -m 0644 "$CADDYFILE.prev" "$CADDYFILE"
    systemctl reload caddy || systemctl restart caddy || true
  fi
}

# --- самолечение сертификата ------------------------------------------------------
my_ip()  { cat "$STATE/my-ip" 2>/dev/null || true; }
dns_ip() { getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true; }

heal_cert() {
  https_ok && return 0
  local me; me="$(my_ip)"
  [ -n "$me" ] && [ "$(dns_ip)" = "$me" ] || return 0      # адрес ещё не наш — ждём
  local stamp="$STATE/caddy-kick" now; now="$(date +%s)"
  if [ -f "$stamp" ] && [ $((now - $(cat "$stamp"))) -lt 900 ]; then return 0; fi
  echo "$now" > "$stamp"
  log "адрес уже ведёт сюда, а HTTPS нет — перезапускаю Caddy за сертификатом"
  systemctl restart caddy || true
}

# --- режимы ---------------------------------------------------------------------
do_deploy() {
  exec 9>"$STATE/deploy.lock"
  flock -n 9 || exit 0                       # прошлая выкладка ещё идёт
  local sha
  if sha="$(fetch_main)"; then
    # skip-sha — коммит, который откатили руками или который не прошёл проверку:
    # его не выкладываем, пока в main не появится следующий.
    if [ "$sha" != "$(current_sha)" ] && [ "$sha" != "$(cat "$STATE/skip-sha" 2>/dev/null)" ]; then
      publish "$sha" && apply_caddyfile "$sha"
      prune
    fi
  fi
  heal_cert
}

do_rollback() {
  local cur prev; cur="$(current_sha)"
  # shellcheck disable=SC2010,SC2012  # имена выкладок — хэши коммитов
  prev="$({ ls -1t "$BASE/releases" 2>/dev/null | grep -v '^\.' | grep -vx "$cur" || true; } | head -1)"
  [ -n "$prev" ] || { log "откатываться не на что"; exit 1; }
  switch_to "$prev"
  log "вернул ${prev:0:7} (был ${cur:0:7}). Таймер выложит main снова, как только в нём появится новый коммит."
  # Чтобы таймер не вернул тот же сломанный коммит минутой позже:
  echo "$cur" > "$STATE/skip-sha"
}

do_status() {
  local me dns cur how
  me="$(my_ip)"; dns="$(dns_ip)"; cur="$(current_sha)"; how="$(cat "$STATE/fetch-how" 2>/dev/null || echo '?')"
  echo "=============================================="
  echo " Магнат — состояние сервера"
  echo "=============================================="
  echo "Caddy:          $(systemctl is-active caddy 2>/dev/null) ($(caddy version 2>/dev/null | awk '{print $1}'))"
  echo "Выкладка:       $(systemctl is-active magnat-deploy.timer 2>/dev/null), версия ${cur:0:7}, $(cat "$STATE/deployed-at" 2>/dev/null || echo '-')"
  echo "Берёт из GitHub: $how"
  echo "Адрес сервера:  ${me:-?}"
  if [ -n "$dns" ] && [ "$dns" = "$me" ]; then
    echo "DNS:            $DOMAIN -> $dns (сюда) ✅"
  else
    echo "DNS:            $DOMAIN -> ${dns:-нет ответа} (ещё не сюда)"
  fi
  if https_ok; then echo "HTTPS:          работает ✅"; else echo "HTTPS:          нет (до смены DNS — так и должно быть)"; fi
  # Считаем ВСЕ правила пересылки в nat, а не по метке: 02.10 строка по метке
  # показала «0», а три правила без метки уводили порт 443 в Амстердам.
  echo "Пересылка VPN:  $(iptables-save -t nat 2>/dev/null | grep -cE -- '-j (DNAT|MASQUERADE)' || true) правил (должно быть 0)"
  echo "Файрвол:        $(ufw status 2>/dev/null | head -1 | sed 's/Status: //')"
  echo "fail2ban:       $(systemctl is-active fail2ban 2>/dev/null)"
  if [ -s "$KEY.pub" ]; then
    echo
    echo "Ключ выкладки (GitHub -> magnat-planer -> Settings -> Deploy keys):"
    cat "$KEY.pub"
  fi
}

case "${1:-status}" in
  deploy)   do_deploy ;;
  status)   do_status ;;
  rollback) do_rollback ;;
  *) sed -n '2,13p' "$0" | sed 's/^#//'; exit 2 ;;
esac

#!/usr/bin/env bash
# =============================================================================
#  Магнат на своём сервере — выкладка и состояние. Ставится командой
#  server/install.sh в /usr/local/sbin/magnat.
#
#    magnat deploy   забрать `main` из GitHub и выложить, если он новый.
#                    Его зовёт таймер раз в минуту — руками не нужно.
#    magnat status   что сейчас на сервере (только чтение) — это и присылать.
#    magnat rollback вернуть прошлую версию сайта (API следует за ним).
#    magnat mail     почта для кодов входа: ящик, пароль, проверочное письмо.
#    magnat restart  перезапустить API и Caddy, снова попробовать новый API.
#    magnat upgrade  переустановить сервер из ВЫЛОЖЕННОЙ версии (не из сети).
#    magnat backup   копия базы: на этой машине и, если настроено, на Яндекс Диск;
#                    ночью её зовёт таймер — руками не нужно. Плюс письма-напоминания.
#    magnat backup-setup  один раз: копии на Яндекс Диск (токен и фраза-ключ).
#    magnat user show|export|delete АДРЕС  запрос человека о своих данных
#                    (delete и без аккаунта: отвязать почту от заказов, снять доступ).
#    magnat paid-until ДД.ММ.ГГГГ  до какого числа оплачен сервер (напомнит письмом).
#    magnat platega  ключи Платеги для оплаты Магната (ID мерчанта и секрет);
#                    magnat platega off — стереть их, новые счета не создаются.
#    magnat grant АДРЕС ДНЕЙ  выдать доступ вручную (оплата не включилась сама).
#    magnat orders [ГГГГ-ММ]  оплаты месяца для чеков самозанятого (адреса скрыты);
#                    magnat orders ГГГГ-ММ полностью — с полными адресами, чтобы
#                    отправить чек покупателю (такой вывод в чат не присылать).
#    magnat refund НОМЕР_ЗАКАЗА  деньги вернул в кабинете Платеги — заказ
#                    «возвращён», доступ за его остаток снимается.
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
#   6. API входа (server/api) следует за выложенным коммитом: проверка на
#      копии базы, копия базы, переключение, ответ /api/health — иначе
#      прежний. Код из репозитория root не запускает: только magnat-api.
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
# API входа: код — /srv/magnat-api/releases/<дерево server/api>, ссылка current;
# база и ключ — /var/lib/magnat-api (только magnat-api); секреты — /etc/magnat.
API_BASE="${MAGNAT_API_BASE:-/srv/magnat-api}"
API_STATE="${MAGNAT_API_STATE:-/var/lib/magnat-api}"
API_DB="$API_STATE/magnat.db"
API_USER="${MAGNAT_API_USER:-magnat-api}"
API_PORT="${MAGNAT_API_PORT:-8787}"
API_WAIT="${MAGNAT_API_WAIT:-15}"            # секунд ждать ответа нового API
ETC="${MAGNAT_ETC:-/etc/magnat}"
BACKUPS="${MAGNAT_BACKUPS:-/var/backups/magnat}"
PY="${MAGNAT_PY:-/usr/bin/python3}"
SELF="${MAGNAT_SELF:-/usr/local/sbin/magnat}"
SETUP="${MAGNAT_SETUP:-/root/magnat-setup}"
DISK_API="${MAGNAT_DISK_API:-https://cloud-api.yandex.net}"   # REST API Яндекс Диска; в проверке — поддельный
DISK_SLOTS=14                 # слотов на Диске: день года % 14 → копии не старше двух недель
BACKUP_MAX_AGE_H=27           # местная копия старше — «не делается», письмо
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

# --- API входа (server/api/api.py) ------------------------------------------------
# Код из репозитория root не запускает НИКОГДА: только от magnat-api, с чистым
# окружением, из «/». Секреты (пароль почты) — только через stdin, не в argv.
run_api() {
  local rel="$1"; shift
  local e=(env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$API_STATE" MAGNAT_STATE="$API_STATE" MAGNAT_DB="$API_DB")
  if [ "$(id -u)" -eq 0 ] && [ "$(id -un)" != "$API_USER" ]; then
    (cd / && runuser -u "$API_USER" -- "${e[@]}" "$PY" -I "$rel/api.py" "$@")
  else
    (cd / && "${e[@]}" "$PY" -I "$rel/api.py" "$@")
  fi
}

api_rel()    { basename "$(readlink "$API_BASE/current" 2>/dev/null || echo none)"; }
api_health() { curl --noproxy "*" -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null; }
# Дерево server/api в коммите — оно и имя выпуска (12 знаков, как пишет /api/health).
api_tree() {
  local t; t="$(git_src rev-parse --verify -q "$1:server/api" 2>/dev/null)" || return 1
  [ -n "$t" ] || return 1
  echo "${t:0:12}"
}
# Ждём, пока ответит именно этот выпуск: ok:true и v = дерево.
api_up() {
  local i h
  for ((i = 0; i < API_WAIT * 4; i++)); do
    h="$(api_health || true)"
    if grep -q '"ok": *true' <<<"$h" && grep -q "\"v\": *\"$1\"" <<<"$h"; then return 0; fi
    sleep 0.25
  done
  return 1
}
api_switch() {
  ln -sfn "releases/$1" "$API_BASE/current.new"
  mv -Tf "$API_BASE/current.new" "$API_BASE/current"
}
api_note() { echo "$(date -u '+%d.%m %H:%M UTC') $*" > "$STATE/api-last"; log "$*"; }
# Выпуск, который не прошёл, запоминаем — не пробовать его каждую минуту.
api_skip() { echo "$1" > "$STATE/api-skip"; api_note "$2"; }
api_prune() {
  local cur; cur="$(api_rel)"
  # shellcheck disable=SC2010,SC2012  # имена выпусков — хэши деревьев
  { ls -1t "$API_BASE/releases" 2>/dev/null | grep -v '^\.' | grep -vx "$cur" || true; } | tail -n +"$KEEP" |
    while IFS= read -r d; do rm -rf -- "${API_BASE:?}/releases/$d"; done
}
# Копия базы перед переключением (root, 0600, пять последних): новый код
# может менять схему — откат должен найти базу такой, какой она была.
api_backup_pre() {
  local rel="$1" tree="$2" d="$BACKUPS/deploy"
  [ -s "$API_DB" ] || return 0                               # базы ещё нет — копировать нечего
  install -d -m 0700 "$BACKUPS" "$d" || return 1
  if (umask 077; run_api "$rel" backup --db "$API_DB" --out - | gzip -c > "$d/pre-$tree.db.gz.tmp"); then
    mv -f "$d/pre-$tree.db.gz.tmp" "$d/pre-$tree.db.gz"
  else
    rm -f "$d/pre-$tree.db.gz.tmp"; return 1
  fi
  # shellcheck disable=SC2012  # имена — pre-<дерево>.db.gz
  { ls -1t "$d"/pre-*.db.gz 2>/dev/null || true; } | tail -n +6 | while IFS= read -r f; do rm -f -- "$f"; done
}

# API следует за выложенным коммитом сайта (значит, и за `magnat rollback`).
# Ничего не делает, если API ещё не поставлен, в коммите нет server/api, этот
# выпуск уже работает или уже не прошёл. Сайт от исхода не зависит.
apply_api() {
  local sha="$1" tree prev rel tmp out
  [ -d "$API_BASE/releases" ] || return 0                    # шаг 5 установки ещё не пройден
  tree="$(api_tree "$sha")" || return 0                       # в коммите нет server/api
  prev="$(api_rel)"
  [ "$tree" != "$prev" ] || return 0                          # уже работает
  [ "$tree" != "$(cat "$STATE/api-skip" 2>/dev/null)" ] || return 0
  rel="$API_BASE/releases/$tree"; tmp="$API_BASE/releases/.tmp-$tree"
  rm -rf "$tmp"; mkdir -p "$tmp"
  if ! git_src archive --format=tar "$sha" server/api | tar -x --no-same-owner --strip-components=2 -C "$tmp" ||
     [ ! -s "$tmp/api.py" ]; then
    rm -rf "$tmp"; api_skip "$tree" "API из ${sha:0:7} не распаковался — оставил прежний"; return 1
  fi
  chmod -R u=rwX,go=rX "$tmp"
  # Проверка нового кода на КОПИИ живой базы (миграции, вход, синхронизация).
  out="$(run_api "$tmp" check --db "$API_DB" 2>&1)" || true
  if ! grep -q '^api-check-ok' <<<"$out"; then
    rm -rf "$tmp"
    api_skip "$tree" "API из ${sha:0:7} не прошёл проверку ($(tail -n 1 <<<"$out" | cut -c1-80)) — оставил прежний"
    return 1
  fi
  if ! api_backup_pre "$tmp" "$tree"; then
    rm -rf "$tmp"; api_skip "$tree" "API из ${sha:0:7}: не сделалась копия базы — оставил прежний"; return 1
  fi
  rm -rf "$rel"; mv "$tmp" "$rel"
  api_switch "$tree"
  systemctl restart magnat-api || true
  if api_up "$tree"; then
    echo "$tree" > "$STATE/api-tree"; rm -f "$STATE/api-skip"
    api_note "API $tree работает (из ${sha:0:7})"
    api_prune
    return 0
  fi
  if [ "$prev" != none ] && [ -s "$API_BASE/releases/$prev/api.py" ]; then
    api_switch "$prev"
    systemctl restart magnat-api || true
    if api_up "$prev"; then
      api_skip "$tree" "API из ${sha:0:7} не поднялся — вернул прежний ($prev)"
    else
      api_skip "$tree" "API из ${sha:0:7} не поднялся, прежний ($prev) тоже не отвечает — набери magnat restart"
    fi
  else
    systemctl stop magnat-api || true
    api_skip "$tree" "API из ${sha:0:7} не поднялся, прежнего нет — API остановлен, сайт работает"
  fi
  return 1
}

# Таймер magnat-api-backup: копия базы раз в сутки, здесь же, семь последних.
# Служба запускает это уже от magnat-api — run_api идёт без runuser.
do_api_backup() {
  local d="$API_STATE/backup" f
  [ -s "$API_DB" ] || { log "базы ещё нет — копировать нечего"; return 0; }
  f="$d/magnat-$(date -u +%Y-%m-%d).db.gz"
  if ! (umask 077; mkdir -p "$d" && run_api "$API_BASE/current" backup --db "$API_DB" --out - | gzip -c > "$f.tmp"); then
    rm -f "$f.tmp"; log "копия базы НЕ сделалась" >&2; return 1
  fi
  mv -f "$f.tmp" "$f"
  # shellcheck disable=SC2012  # имена — magnat-ГГГГ-ММ-ДД.db.gz
  { ls -1t "$d"/magnat-*.db.gz 2>/dev/null || true; } | tail -n +8 | while IFS= read -r x; do rm -f -- "$x"; done
  log "копия базы: $(basename "$f")"
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
  apply_api "$(current_sha)" || true         # сайт уже выложен — API его не держит
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
  api_status "$cur"
  if [ -s "$KEY.pub" ]; then
    echo
    echo "Ключ выкладки (GitHub -> magnat-planer -> Settings -> Deploy keys):"
    cat "$KEY.pub"
  fi
}

# Строки API для magnat status. Ни одного секрета: из smtp.env — только адрес ящика,
# из platega.env — только есть ли в нём секрет.
api_status() {
  local cur="$1" h rel box n last
  if [ ! -d "$API_BASE/releases" ]; then
    echo "API входа:      не поставлен — набери magnat upgrade"
  else
    rel="$(api_rel)"; h="$(api_health || true)"
    if grep -q '"ok": *true' <<<"$h"; then
      if grep -q '"open": *true' <<<"$h"; then
        echo "API входа:      работает ✅ версия $rel, вход ОТКРЫТ (код получает любой адрес)"
      else
        echo "API входа:      работает ✅ версия $rel, вход закрыт (код — только ящикам владельца)"
      fi
    else
      echo "API входа:      не отвечает ❌ (версия ${rel/none/нет}) — набери magnat restart; не помогло — пришли этот вывод"
    fi
    box="$(sed -n 's/^SMTP_USER=//p' "$ETC/smtp.env" 2>/dev/null | head -n 1 || true)"
    if [ -n "$box" ] && grep -q '^SMTP_PASS=.' "$ETC/smtp.env" 2>/dev/null; then
      echo "Почта для кодов: настроена — $box ✅"
    else
      echo "Почта для кодов: не настроена → набери magnat mail"
    fi
    pay_line "$h"
    # shellcheck disable=SC2012  # имена — magnat-ГГГГ-ММ-ДД.db.gz
    n="$( { ls -1 "$API_STATE/backup"/magnat-*.db.gz 2>/dev/null || true; } | wc -l)"
    last="$( { ls -1t "$API_STATE/backup"/magnat-*.db.gz 2>/dev/null || true; } | head -n 1)"
    if [ -z "$last" ]; then
      echo "Копия базы:     ещё не было (делается сама раз в сутки)"
    elif [ "$(file_age_h "$last")" -ge "$BACKUP_MAX_AGE_H" ]; then
      echo "Копия базы:     $(date -u -r "$last" '+%d.%m %H:%M UTC') ⚠ старше суток — не делается (всего $n, на этой же машине)"
    else
      echo "Копия базы:     $(date -u -r "$last" '+%d.%m %H:%M UTC') ✅ (всего $n, на этой же машине)"
    fi
    disk_line
    [ ! -s "$STATE/api-last" ] || echo "Последнее событие API: $(cat "$STATE/api-last")"
  fi
  disk_free_line
  paid_line
  # Сам себя скрипт не обновляет (push в main не должен становиться root на
  # машине) — только говорит, что пора: magnat upgrade.
  if [ "$cur" != none ] && git_src cat-file -e "$cur:server/magnat.sh" 2>/dev/null &&
     ! git_src show "$cur:server/magnat.sh" 2>/dev/null | cmp -s - "$SELF"; then
    echo "⚠ Скрипт сервера устарел — набери magnat upgrade"
  fi
}

# --- почта для кодов -------------------------------------------------------------
lower_trim() { local v="${1//[[:space:]]/}"; printf '%s' "${v,,}"; }
is_email()   { [[ "$1" =~ ^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$ ]]; }
# Адрес покупателя (grant, user): здесь — только «есть @ и нет пробелов». Строгая проверка
# и нормализация (Почта.рф → xn--…) — в api.py, та же, что при оформлении: иначе адрес,
# с которым человек оплатил, здесь не находился бы.
soft_email() { [[ "$1" == *@* && "$1" != *[[:space:]]* ]]; }
# safe_ascii ОТ ДО СТРОКА: печатный ASCII без пробела, кавычек, \ $ ` — в .env
# такая строка не ломается. Строка идёт в tr через stdin, не аргументом.
safe_ascii() {
  local p="$3" rest
  [ "${#p}" -ge "$1" ] && [ "${#p}" -le "$2" ] || return 1
  rest="$(LC_ALL=C; printf '%s' "$p" | tr -d 'A-Za-z0-9!#%&()*+,./:;<=>?@^_{|}~-' | tr -d ']')"
  rest="${rest//[/}"
  [ -z "$rest" ]
}
# Пароль приложения: других почта и не выдаёт, а в smtp.env они ломали бы строку.
is_app_pass() { safe_ascii 4 128 "$1"; }
MAIL_NEW=""
do_mail() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  if [ ! -s "$API_BASE/current/api.py" ]; then
    echo "API входа ещё не поставлен — сначала строка установки (server/README.md)."; exit 1
  fi
  local box host port pass sup res
  echo "Почта для кодов входа. Пароль вводится только здесь — в чат его не присылай."
  read -rp "1) Адрес ящика для кодов (например имя@mail.ru): " box || true
  box="$(lower_trim "$box")"
  is_email "$box" || { echo "НЕ УШЛО: «$box» не похоже на адрес почты. Прежние настройки не тронуты."; exit 1; }
  case "${box#*@}" in
    mail.ru|inbox.ru|list.ru|bk.ru|internet.ru) host=smtp.mail.ru; port=465 ;;
    yandex.*|ya.ru|narod.ru)
      host=smtp.yandex.ru; port=465
      echo "⚠ Этот сервер не достучится до почты Яндекса: smtp.yandex.ru для него закрыт (проверено)."
      echo "  Нужен ящик на Mail.ru. Пробую всё равно — скорее всего, не уйдёт." ;;
    *)
      read -rp "   Сервер исходящей почты (SMTP) этого ящика, например smtp.example.ru: " host || true
      host="$(lower_trim "$host")"
      read -rp "   Порт — 465 или 587 (Enter — 465): " port || true
      port="$(lower_trim "$port")"; port="${port:-465}" ;;
  esac
  if ! [[ "$host" =~ ^[a-z0-9.-]{1,253}$ ]] || ! [[ "$port" =~ ^[0-9]{1,5}$ ]] ||
     { [ "$host" != 127.0.0.1 ] && [ "$port" != 465 ] && [ "$port" != 587 ]; }; then
    echo "НЕ УШЛО: сервер «$host» и порт «$port» не подходят (нужен порт 465 или 587). Прежние настройки не тронуты."; exit 1
  fi
  read -rsp "2) Пароль для внешнего приложения (букв не видно — так и надо): " pass || true
  echo
  is_app_pass "$pass" || { echo "НЕ УШЛО: это не похоже на пароль приложения. Прежние настройки не тронуты."; exit 1; }
  read -rp "3) Адрес поддержки — на него придёт проверочное письмо: " sup || true
  sup="$(lower_trim "$sup")"
  is_email "$sup" || { echo "НЕ УШЛО: «$sup» не похоже на адрес почты. Прежние настройки не тронуты."; exit 1; }

  install -d -m 0700 "$ETC"
  MAIL_NEW="$ETC/smtp.env.new"
  trap 'rm -f "$MAIL_NEW"' EXIT
  (umask 077; printf 'SMTP_HOST=%s\nSMTP_PORT=%s\nSMTP_USER=%s\nSMTP_PASS=%s\nSUPPORT=%s\n' \
    "$host" "$port" "$box" "$pass" "$sup" > "$MAIL_NEW")
  echo "Проверяю: шлю письмо на $sup через $host:$port…"
  # root только открывает файл; письмо отправляет magnat-api, пароль — через stdin.
  res="$(run_api "$API_BASE/current" mailtest --creds - --to "$sup" < "$MAIL_NEW" 2>&1)" || true
  if grep -q '^mail-ok' <<<"$res"; then
    chmod 0600 "$MAIL_NEW"; mv -f "$MAIL_NEW" "$ETC/smtp.env"
    systemctl restart magnat-api >/dev/null 2>&1 || true      # служба берёт smtp.env только на старте
    echo "ПОЧТА РАБОТАЕТ — проверочное письмо ушло на $sup. Коды входа будут приходить с $box."
    api_up "$(api_rel)" || echo "⚠ API после перезапуска пока не отвечает — через минуту набери magnat status."
    return 0
  fi
  rm -f "$MAIL_NEW"
  echo "НЕ УШЛО: $(mail_fail_hint "$res" "$host" "$port"). Прежние настройки не тронуты."
  exit 1
}

# Что сказать человеку по строке «mail-fail <вид> <Класс>» от api.py.
mail_fail_hint() {
  local kind cls
  kind="$(sed -n 's/^mail-fail \([a-z]*\).*/\1/p' <<<"$1" | head -n 1)"
  cls="$(sed -n 's/^mail-fail [a-z]* \([A-Za-z]*\).*/\1/p' <<<"$1" | head -n 1)"
  case "$kind" in
    auth)    echo "ящик не пустил: неверный пароль для внешнего приложения или в настройках почты не разрешены почтовые программы" ;;
    connect) echo "сервер не достучался до $2:$3 (сеть) — пришли этот вывод в чат" ;;
    tls)     echo "не сложилось защищённое соединение с $2:$3 (сеть) — пришли этот вывод в чат" ;;
    other)   echo "ящик отказался отправить письмо (${cls:-?}) — проверь адрес поддержки или пришли этот вывод в чат" ;;
    *)       echo "проверка не запустилась — пришли этот вывод в чат" ;;
  esac
}

do_restart() {
  exec 9>"$STATE/deploy.lock"
  flock -w 120 9 || { log "идёт выкладка — попробуй через пару минут"; exit 1; }
  rm -f "$STATE/api-skip"                     # снова попробовать выпуск, который не поднялся
  apply_api "$(current_sha)" || true
  systemctl restart magnat-api caddy || true
  api_up "$(api_rel)" || true                 # ждём ответа API (до 15 с), потом показываем
  do_status
}

# Переустановка из ВЫЛОЖЕННОЙ версии (той, что сейчас на сайте), не из сети:
# так push в main не превращается в root на машине без ведома владельца.
do_upgrade() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local cur; cur="$(current_sha)"
  [ "$cur" != none ] || { log "выкладки ещё нет — нужна строка установки"; exit 1; }
  rm -rf "$SETUP"; mkdir -p "$SETUP"
  if ! git_src archive --format=tar "$cur" server | tar -x -C "$SETUP" || [ ! -s "$SETUP/server/install.sh" ]; then
    log "не достал server/ из выложенной версии ${cur:0:7}"; exit 1
  fi
  log "переустанавливаю из выложенной версии ${cur:0:7}"
  exec bash "$SETUP/server/install.sh"
}

# --- копии, напоминания, запросы людей о данных --------------------------------
#  Копия базы живёт в двух местах: на этой машине (служба magnat-api-backup, от
#  magnat-api, без сети) и — если владелец один раз набрал `magnat backup-setup` —
#  на его Яндекс Диске: в папке приложения (токен видит только её), зашифрованная
#  фразой-ключом (AES-256, PBKDF2). Диск хранит шифртекст; без фразы копию не
#  открыть никому. Выгружает root ночью (`magnat backup`, таймер magnat-backup),
#  в один из 14 слотов по дню года — на Диске не больше двух недель истории, как
#  и обещано в политике. WebDAV Диска Яндекс закрывает (осень 2025) — поэтому
#  REST API: адрес загрузки → PUT → сверка размера и md5 с тем, что отправили.

plural() { # plural N один два пять — склонение: 1 день, 2 дня, 5 дней
  local n=$1 r=$(( $1 % 10 )) h=$(( $1 % 100 ))
  if [ "$h" -ge 11 ] && [ "$h" -le 14 ]; then echo "$4"
  elif [ "$r" -eq 1 ]; then echo "$2"
  elif [ "$r" -ge 2 ] && [ "$r" -le 4 ]; then echo "$3"
  else echo "$4"; fi
}
file_age_h() { echo $(( ( $(date +%s) - $(stat -c %Y "$1") ) / 3600 )); }
newest_local() {
  # shellcheck disable=SC2012  # имена — magnat-ГГГГ-ММ-ДД.db.gz
  { ls -1t "$API_STATE/backup"/magnat-*.db.gz 2>/dev/null || true; } | head -n 1
}
disk_ready() { [ -s "$ETC/disk.auth" ] && [ -s "$ETC/backup.pass" ]; }
DISK_OUT="$STATE/.disk-resp"   # последний ответ Диска (0600): адрес загрузки живёт 30 минут
DISK_CODE=""; DISK_ERR=""; DISK_NAME=""; DISK_SIZE=""

# Письмо-тревога на адрес поддержки — не чаще раза в сутки на вид. Нужны почта
# (magnat mail) и API: письмо отправляет api.py от magnat-api, пароль — через stdin.
alert() {
  local kind="$1" text="$2"
  local mark="$STATE/alert-$kind"
  grep -q '^SMTP_PASS=.' "$ETC/smtp.env" 2>/dev/null || return 0
  [ -s "$API_BASE/current/api.py" ] || return 0
  if [ -e "$mark" ] && [ "$(file_age_h "$mark")" -lt 24 ]; then return 0; fi
  if run_api "$API_BASE/current" alert --creds - --kind "$kind" --text "$text" < "$ETC/smtp.env" 2>/dev/null | grep -q '^mail-ok'; then
    date -u '+%d.%m %H:%M UTC' > "$mark"
  fi
}

# disk_call AUTH-ФАЙЛ METHOD URL → код в DISK_CODE, тело в $DISK_OUT; нет связи — 000.
# Токен идёт заголовком из файла (-H @файл), в аргументах его не видно.
disk_call() {
  (umask 077; : > "$DISK_OUT")
  DISK_CODE="$(curl -sS --max-time 60 -X "$2" -H @"$1" -H 'Accept: application/json' \
    -o "$DISK_OUT" -w '%{http_code}' "$3" 2>/dev/null)" || DISK_CODE=000
}
disk_field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$DISK_OUT" 2>/dev/null | head -n 1 | sed 's/\\u0026/\&/g; s#\\/#/#g'; }
disk_number() { sed -n "s/.*\"$1\": *\\([0-9][0-9]*\\).*/\\1/p" "$DISK_OUT" 2>/dev/null | head -n 1; }
disk_explain() { # код ответа API → человеческая причина в DISK_ERR; 0 — всё хорошо
  case "$DISK_CODE" in
    200|201|202) return 0 ;;
    401) DISK_ERR="Диск не пустил: токен неверный или истёк → magnat backup-setup" ;;
    403) DISK_ERR="у токена нет доступа к папке приложения на Диске (права при создании приложения) → magnat backup-setup" ;;
    000) DISK_ERR="нет связи с Диском (сеть)" ;;
    507) DISK_ERR="на Диске нет места" ;;
    *)   DISK_ERR="Диск ответил HTTP $DISK_CODE: $(disk_field message)" ;;
  esac
  return 1
}

# disk_upload AUTH-ФАЙЛ ФАЙЛ ИМЯ → файл лежит на Диске как app:/ИМЯ, размер и md5 сверены.
disk_upload() {
  local auth="$1" file="$2" name="$3" href i
  disk_call "$auth" GET "$DISK_API/v1/disk/resources/upload?path=app%3A%2F$name&overwrite=true"
  disk_explain || return 1
  href="$(disk_field href)"
  case "$href" in https://*|http://*) ;; *) DISK_ERR="Диск не дал адрес для загрузки"; return 1 ;; esac
  DISK_CODE="$(curl -sS --max-time 600 -T "$file" -o /dev/null -w '%{http_code}' "$href" 2>/dev/null)" || DISK_CODE=000
  case "$DISK_CODE" in
    201|202) ;;
    000) DISK_ERR="загрузка на Диск оборвалась (сеть)"; return 1 ;;
    507) DISK_ERR="на Диске нет места"; return 1 ;;
    *)   DISK_ERR="загрузка на Диск: HTTP $DISK_CODE"; return 1 ;;
  esac
  # Сверка: Диск отдаёт размер и md5 лежащего файла — должны совпасть с отправленным.
  for i in 1 2 3 4 5 6; do
    disk_call "$auth" GET "$DISK_API/v1/disk/resources?path=app%3A%2F$name&fields=size%2Cmd5"
    if [ "$DISK_CODE" != 404 ] || [ "$i" -ge 6 ]; then break; fi    # 202: файл ещё раскладывается
    sleep 2
  done
  disk_explain || { DISK_ERR="после загрузки файл на Диске не виден: $DISK_ERR"; return 1; }
  if [ "$(disk_number size)" != "$(stat -c %s "$file")" ] || [ "$(disk_field md5)" != "$(md5sum < "$file" | cut -c1-32)" ]; then
    DISK_ERR="файл на Диске не совпал с отправленным (размер или md5)"; return 1
  fi
  DISK_SIZE="$(stat -c %s "$file")"
}

# offsite_push AUTH-ФАЙЛ ФРАЗА-ФАЙЛ МЕСТНАЯ-КОПИЯ → зашифровать и выгрузить в слот дня.
offsite_push() {
  local auth="$1" pass="$2" src="$3" d="$BACKUPS/offsite" tmp rc=0
  install -d -m 0700 "$BACKUPS" "$d" || { DISK_ERR="нет папки для копий"; return 1; }
  DISK_NAME="magnat-$(printf '%02d' $(( 10#$(date -u +%j) % DISK_SLOTS ))).db.gz.enc"
  tmp="$d/$DISK_NAME.tmp"; rm -f "$tmp"
  if ! (umask 077; openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$pass" -in "$src" -out "$tmp" 2>/dev/null); then
    rm -f "$tmp"; DISK_ERR="не зашифровалось (фраза-ключ не прочиталась)"; return 1
  fi
  disk_upload "$auth" "$tmp" "$DISK_NAME" || rc=1
  rm -f "$tmp" "$DISK_OUT"
  return $rc
}
offsite_ok() {
  printf '%s|%s|%s\n' "$(date -u '+%d.%m %H:%M UTC')" "$DISK_NAME" "$DISK_SIZE" > "$STATE/offsite-at"
  rm -f "$STATE/offsite-err" "$STATE/offsite-fail"
  log "копия на Яндекс Диск: $DISK_NAME, $(( (DISK_SIZE + 1023) / 1024 )) КБ"
}
offsite_fail() {
  local n; n="$(cat "$STATE/offsite-fail" 2>/dev/null || true)"; [[ "$n" =~ ^[0-9]+$ ]] || n=0; n=$(( n + 1 ))
  echo "$n" > "$STATE/offsite-fail"
  echo "$(date -u '+%d.%m %H:%M UTC') — $1" > "$STATE/offsite-err"
  log "копия на Яндекс Диск НЕ ушла: $1" >&2
  [ "$n" -lt 2 ] || alert offsite_fail "Копия базы на Яндекс Диск не уходит $n $(plural "$n" ночь ночи ночей) подряд: $1"
}

# Местная копия за сегодня: сделала служба ночью; нет или старая — просим её сейчас.
local_copy() {
  local src; src="$(newest_local)"
  if [ -z "$src" ] || [ "$(file_age_h "$src")" -ge 20 ]; then
    systemctl start magnat-api-backup.service >/dev/null 2>&1 || true
    src="$(newest_local)"
  fi
  [ -n "$src" ] && [ "$(file_age_h "$src")" -lt "$BACKUP_MAX_AGE_H" ] || return 1
  echo "$src"
}

check_space() {
  local b; b="$(df -P -B1 "$API_STATE" 2>/dev/null | awk 'NR==2{print $4}')"
  [[ "$b" =~ ^[0-9]+$ ]] || return 0
  [ "$b" -ge 2000000000 ] || alert disk_low "На сервере мало места: свободно $(gb "$b") ГБ — копии и база могут не записаться"
}
gb() { awk -v b="$1" 'BEGIN{printf "%.1f", b/1e9}' | tr . ,; }
disk_free_line() {
  local b; b="$(df -P -B1 "$API_STATE" 2>/dev/null | awk 'NR==2{print $4}')"
  [[ "$b" =~ ^[0-9]+$ ]] || { echo "Место на диске: не измерилось"; return 0; }
  if [ "$b" -lt 2000000000 ]; then echo "Место на диске: ⚠ свободно $(gb "$b") ГБ — мало (меньше 2 ГБ)"
  else echo "Место на диске: свободно $(gb "$b") ГБ"; fi
}
disk_line() {
  local at name size err
  if ! disk_ready; then echo "Яндекс Диск:    копии не настроены (по желанию, один раз: magnat backup-setup)"; return 0; fi
  IFS='|' read -r at name size < "$STATE/offsite-at" 2>/dev/null || at=""
  err="$(cat "$STATE/offsite-err" 2>/dev/null || true)"
  if [ -n "$err" ]; then
    echo "Яндекс Диск:    копия НЕ ушла ❌ $err${at:+ (последняя удачная — $at)}"
  elif [ -n "$at" ]; then
    echo "Яндекс Диск:    копия $at ✅ ($name, $(( (${size:-0} + 1023) / 1024 )) КБ, зашифрована; слотов $DISK_SLOTS)"
  else
    echo "Яндекс Диск:    настроен, копии ещё не было — уйдёт ночью"
  fi
}

# --- ключи Платеги: оплата Магната ------------------------------------------------
#  /etc/magnat/platega.env (root, 0600) служба получает через LoadCredential=platega,
#  как smtp.env, — и только на старте, поэтому после записи перезапуск. Пустой файл —
#  «ключей нет»: страница оформления честно отвечает «оплата не подключена», служба
#  стартует. Секрет — только через read -s и встроенный printf: ни в выводе, ни в
#  аргументах программ его нет. Проверить ключи у самой Платеги без настоящего платежа
#  нечем — проверяется формат (строже, чем в api.py: что прошло здесь, примет и он)
#  и что служба их увидела (/api/health → payKeys).
PLATEGA_HOOK=/api/platega/callback      # адрес уведомлений — вписать в кабинете Платеги
PLATEGA_NEW=""
platega_in_file() { grep -q '^PLATEGA_SECRET=.' "$ETC/platega.env" 2>/dev/null; }
platega_put() { # platega_put СОДЕРЖИМОЕ — атомарно, 0600; пишет встроенный printf, не программа
  install -d -m 0700 "$ETC"
  PLATEGA_NEW="$ETC/platega.env.new"
  trap 'rm -f "$PLATEGA_NEW"' EXIT
  (umask 077; printf '%s' "$1" > "$PLATEGA_NEW")
  chmod 0600 "$PLATEGA_NEW"; mv -f "$PLATEGA_NEW" "$ETC/platega.env"
}
do_platega() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  case "$1" in
    ''|off) ;;
    *) echo "magnat platega — ввести ключи Платеги; magnat platega off — стереть их"; exit 2 ;;
  esac
  if [ ! -s "$API_BASE/current/api.py" ]; then
    echo "API ещё не поставлен — сначала строка установки (server/README.md)."; exit 1
  fi
  local mid sec h
  if [ "$1" = off ]; then
    platega_put ""
    systemctl restart magnat-api >/dev/null 2>&1 || true
    if api_up "$(api_rel)" && ! grep -q '"payKeys": *true' <<<"$(api_health || true)"; then
      echo "КЛЮЧИ СТЁРТЫ: $ETC/platega.env пуст, API их больше не видит. Новые счета не создаются —"
      echo "страница оформления скажет «оплата не подключена»; оплаченные сроки не тронуты."
      echo "Счета, что ждут оплаты, без ключей не проверяются: вернёшь ключи (magnat platega) в течение суток — подтвердятся сами."
      return 0
    fi
    echo "⚠ Ключи из файла стёрты, но API после перезапуска пока не отвечает — через минуту набери magnat status."
    exit 1
  fi
  echo "Ключи Платеги для оплаты Магната — в её личном кабинете (мерчант magnat-planer.ru)."
  echo "Секрет вводится только здесь — в чат его не присылай."
  read -rp "1) ID мерчанта (MerchantId, вида 3fa85f64-5717-4562-b3fc-2c963f66afa6): " mid || true
  mid="${mid//[[:space:]]/}"
  # Введённое не повторяем: вместо ID мог вставиться секрет, а вывод присылают в чат.
  [[ "$mid" =~ ^[A-Za-z0-9_-]{8,100}$ ]] ||
    { echo "НЕ УШЛО: это не похоже на ID мерчанта (латиница, цифры и «-»). Прежние ключи не тронуты."; exit 1; }
  read -rsp "2) Секретный ключ API (букв не видно — так и надо): " sec || true
  echo
  sec="${sec#"${sec%%[![:space:]]*}"}"; sec="${sec%"${sec##*[![:space:]]}"}"   # пробелы по краям — от копирования
  safe_ascii 8 512 "$sec" ||
    { echo "НЕ УШЛО: это не похоже на секретный ключ Платеги (латиница, цифры и знаки, без пробелов). Прежние ключи не тронуты."; exit 1; }
  [ "$sec" != "$mid" ] ||
    { echo "НЕ УШЛО: секрет совпал с ID мерчанта — во второй строке нужен секретный ключ API. Прежние ключи не тронуты."; exit 1; }
  platega_put "PLATEGA_MERCHANT_ID=$mid"$'\n'"PLATEGA_SECRET=$sec"$'\n'
  sec=""
  systemctl restart magnat-api >/dev/null 2>&1 || true
  if ! api_up "$(api_rel)"; then
    echo "⚠ Ключи записаны, но API после перезапуска пока не отвечает — через минуту набери magnat status."; exit 1
  fi
  h="$(api_health || true)"
  if ! grep -q '"payKeys": *true' <<<"$h"; then
    if grep -q '"payKeys"' <<<"$h"; then
      echo "⚠ Ключи записаны, но API их не видит: служба поставлена до оплаты — набери magnat upgrade, потом magnat status."
    else
      echo "⚠ Ключи записаны, но эта версия API оплату ещё не знает — заработают с новой выкладкой (magnat status)."
    fi
    exit 1
  fi
  echo "КЛЮЧИ ПРИНЯТЫ: записаны в $ETC/platega.env (0600), API их видит."
  echo "Теперь в кабинете Платеги впиши адрес для уведомлений об оплате (Callback URL):"
  echo "    https://$DOMAIN$PLATEGA_HOOK"
  if grep -q '"pay": *true' <<<"$h"; then
    echo "Оплата на сайте включена — покупатели уже платят через эти ключи."
  else
    echo "Оплата на сайте пока выключена — посетители ничего нового не видят; включается отдельно."
  fi
}

# Строка «Платега:» для magnat status. Ключи и флаг — как их видит служба
# (/api/health): файл без LoadCredential ей не виден. Счётчики — `api.py stats`
# (без ПДн). Секрет здесь не читается вовсе — только есть ли строка с ним.
rub_kop() { # копейки → «1 490 ₽», как rub() в api.py
  local n=$(( $1 / 100 )) s=""
  while [ "$n" -ge 1000 ]; do s=" $(printf '%03d' $(( n % 1000 )))$s"; n=$(( n / 1000 )); done
  echo "$n$s ₽"
}
stat_num() { sed -n "s/.*\"$1\": *\([0-9][0-9]*\).*/\1/p" <<<"$2" | head -n 1; }
pay_line() {
  local h="$1" keys on line s n paid sum cb fd
  if grep -q '"payKeys": *true' <<<"$h"; then keys="ключи заданы"
  elif ! platega_in_file; then keys="ключи не заданы → magnat platega"
  elif grep -q '"payKeys": *false' <<<"$h"; then keys="⚠ ключи записаны, но API их не видит → magnat upgrade"
  else keys="ключи заданы"; fi               # API молчит или ещё без оплаты — по файлу
  if grep -q '"pay": *true' <<<"$h"; then on="оплата включена"
  elif [ -n "$h" ]; then on="оплата выключена"
  else on="оплата — не узнать (API не отвечает)"; fi
  line="Платега:        $keys · $on"
  if [ -s "$API_DB" ] && s="$(run_api "$API_BASE/current" stats --db "$API_DB" 2>/dev/null)" &&
     n="$(stat_num pay_pending "$s")" && [ -n "$n" ]; then
    paid="$(stat_num pay_paid_month "$s")"; sum="$(stat_num pay_sum_month_kop "$s")"; cb="$(stat_num pay_last_callback "$s")"
    line="$line · ждут оплаты $n · оплат за месяц ${paid:-0} на $(rub_kop "${sum:-0}") · последнее уведомление "
    if [ "${cb:-0}" -gt 0 ]; then line="$line$(date -u -d "@$cb" '+%d.%m %H:%M UTC')"; else line="${line}не было"; fi
    # «ключи заданы» ещё не значит «ключи верные»: Платега отказывает — счёт failed, покупатель ушёл ни с чем
    fd="$(stat_num pay_failed_day "$s")"
    [ "${fd:-0}" -eq 0 ] || line="$line · ⚠ счета не создаются: $fd за сутки → проверь ключи: magnat platega"
  fi
  echo "$line"
}

# magnat grant АДРЕС ДНЕЙ: соглашение обещает «не включилось за 15 минут — включим
# вручную». Заказ на 0 ₽, срок прибавляется к остатку; отнять нельзя.
do_grant() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local em n res till
  em="$(lower_trim "$1")"
  if [ -z "$em" ] || [ -z "$2" ]; then
    echo "magnat grant АДРЕС ДНЕЙ — выдать доступ вручную, например: magnat grant ivan@mail.ru 30"; exit 2
  fi
  soft_email "$em" || { echo "«$em» не похоже на адрес почты. Ничего не выдано."; exit 1; }
  if ! [[ "$2" =~ ^[0-9]{1,4}$ ]] || [ $(( 10#$2 )) -lt 1 ] || [ $(( 10#$2 )) -gt 3660 ]; then
    echo "«$2» — нужно число дней от 1 до 3660, например 30. Ничего не выдано."; exit 1
  fi
  n=$(( 10#$2 ))
  if [ ! -s "$API_BASE/current/api.py" ] || [ ! -s "$API_DB" ]; then echo "Базы ещё нет — сначала строка установки (server/README.md)."; exit 1; fi
  res="$(run_api "$API_BASE/current" grant "$em" "$n" --db "$API_DB" 2>&1)" || true
  if [[ "$res" =~ grant-ok\ until=([0-9]{4})-([0-9]{2})-([0-9]{2}) ]]; then
    till="${BASH_REMATCH[3]}.${BASH_REMATCH[2]}.${BASH_REMATCH[1]}"
    # grant-ok пишет день по UTC, а письма и user show — по Москве: берём оттуда, чтобы даты не разошлись
    res="$(run_api "$API_BASE/current" user show "$em" --db "$API_DB" 2>/dev/null || true)"
    res="$(sed -n 's/^Доступ: до \([0-9.]*\),.*/\1/p' <<<"$res" | head -n 1)"
    echo "ДОСТУП ВЫДАН: $em — до ${res:-$till} (+$n $(plural "$n" день дня дней) к остатку, заказ на 0 ₽)."
    echo "Пусть войдёт в приложении по этой почте — доступ включится на всех его телефонах."
    return 0
  fi
  echo "НЕ ВЫДАНО: $(tail -n 1 <<<"$res")"
  exit 1
}

# magnat orders [ГГГГ-ММ] [полностью]: оплаты месяца (UTC) для чеков — строкой на оплату, адрес
# скрыт, итог. «полностью» (или --full) — полный адрес: чек надо отправить покупателю.
do_orders() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local a=() w
  for w in "$@"; do
    case "$w" in
      '') ;;
      полностью|--full) a+=(--full) ;;
      *) [[ "$w" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]] ||
           { echo "«$w» не похоже на месяц — нужно ГГГГ-ММ, например $(date -u +%Y-%m) (и «полностью» — с полными адресами)."; exit 1; }
         a+=(--month "$w") ;;
    esac
  done
  if [ ! -s "$API_BASE/current/api.py" ] || [ ! -s "$API_DB" ]; then echo "Базы ещё нет — оплат нет."; exit 1; fi
  [[ " ${a[*]} " != *" --full "* ]] || echo "⚠ здесь полные адреса — в чат не присылать"
  run_api "$API_BASE/current" orders --db "$API_DB" "${a[@]}"
}

# magnat refund НОМЕР_ЗАКАЗА: деньги вернул сам в кабинете Платеги (соглашение, раздел 5) — заказ
# «возвращён», срок доступа уменьшается на остаток ЭТОГО заказа (дни других оплат остаются).
do_refund() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local n res ans
  if [ -z "$1" ]; then
    echo "magnat refund НОМЕР_ЗАКАЗА — деньги вернул в кабинете Платеги, снять доступ за остаток заказа; номер — в magnat orders"; exit 2
  fi
  [[ "$1" =~ ^[0-9]{1,12}$ ]] || { echo "«$1» — нужен номер заказа (число из magnat orders или magnat user show). Ничего не изменено."; exit 1; }
  n=$(( 10#$1 ))
  if [ ! -s "$API_BASE/current/api.py" ] || [ ! -s "$API_DB" ]; then echo "Базы ещё нет — заказов нет."; exit 1; fi
  echo "Вернул деньги в кабинете Платеги? Снять доступ за остаток заказа $n?"
  read -rp "Напиши ДА: " ans || true
  [ "$ans" = "ДА" ] || { echo "Отмена — ничего не изменено."; exit 1; }
  res="$(run_api "$API_BASE/current" refund "$n" --db "$API_DB" 2>&1)" || true
  if [[ "$res" =~ refund-ok\ order=[0-9]+\ until=([0-9]{4})-([0-9]{2})-([0-9]{2}) ]]; then
    echo "ВОЗВРАТ ЗАПИСАН: заказ $n — возвращён, доступ теперь до ${BASH_REMATCH[3]}.${BASH_REMATCH[2]}.${BASH_REMATCH[1]} (дни других оплат остались)."
  elif [[ "$res" == *"refund-ok order=$n until=нет"* ]]; then
    echo "ВОЗВРАТ ЗАПИСАН: заказ $n — возвращён, доступа у покупателя больше нет."
  else
    echo "НЕ ЗАПИСАНО: $(tail -n 1 <<<"$res")"; exit 1
  fi
  echo "Чек по этому заказу аннулируй в «Мой налог» — в magnat orders он помечен «возврат — чек аннулировать»."
}

# --- оплата сервера -----------------------------------------------------------------
paid_days() { # дней до срока (минус — прошёл); нет записи — код 1
  local iso; iso="$(cat "$ETC/paid-until" 2>/dev/null || true)"
  [[ "$iso" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  echo $(( ( $(date -u -d "$iso" +%s) - $(date -u -d "$(date -u +%F)" +%s) ) / 86400 ))
}
paid_date() { date -u -d "$(cat "$ETC/paid-until")" '+%d.%m.%Y'; }
days_left() { if [ "$1" -eq 0 ]; then echo "сегодня последний день"; else echo "осталось $1 $(plural "$1" день дня дней)"; fi; }
paid_line() {
  local n
  if ! n="$(paid_days)"; then echo "Оплата сервера: срок не записан → magnat paid-until ДД.ММ.ГГГГ"; return 0; fi
  if [ "$n" -lt 0 ]; then echo "Оплата сервера: срок $(paid_date) ПРОШЁЛ ❌ — продли на RUVDS, иначе машину снесут"
  elif [ "$n" -le 5 ]; then echo "Оплата сервера: до $(paid_date) — ⚠ $(days_left "$n"), продли на RUVDS"
  else echo "Оплата сервера: до $(paid_date) ($(days_left "$n")) ✅"; fi
}
check_paid() {
  local n; n="$(paid_days)" || return 0
  if [ "$n" -lt 0 ]; then alert paid_soon "Срок оплаты сервера истёк $(paid_date) — продли на RUVDS, иначе машину снесут"
  elif [ "$n" -le 5 ]; then alert paid_soon "Сервер оплачен до $(paid_date) — $(days_left "$n"), продли на RUVDS"; fi
}
do_paid_until() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local d="$1" iso=""
  if [ -z "$d" ]; then paid_line; return 0; fi
  [[ "$d" =~ ^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$ ]] && iso="${BASH_REMATCH[3]}-${BASH_REMATCH[2]}-${BASH_REMATCH[1]}"
  if [ -z "$iso" ] || [ "$(date -u -d "$iso" +%F 2>/dev/null || true)" != "$iso" ]; then
    echo "«$d» не похоже на дату — нужно ДД.ММ.ГГГГ, например 25.10.2026. Прежняя запись не тронута."; exit 1
  fi
  install -d -m 0700 "$ETC"
  (umask 077; echo "$iso" > "$ETC/paid-until.new"); mv -f "$ETC/paid-until.new" "$ETC/paid-until"
  rm -f "$STATE/alert-paid_soon"            # новая дата — напоминание считается заново
  echo "Записал. $(paid_line)"
  echo "За 5 дней до срока придёт письмо на адрес поддержки (нужна почта: magnat mail)."
}

# --- magnat backup: ночью по таймеру и руками --------------------------------------
do_backup() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local src rc=0
  if [ -s "$API_DB" ]; then
    if ! src="$(local_copy)"; then
      src="$(newest_local)"
      alert backup_stale "Копия базы на сервере не делается: последняя — ${src:+$(date -u -r "$src" '+%d.%m %H:%M UTC')}${src:-ещё не было}"
      log "местной копии за сутки нет — на Диск выгружать нечего" >&2; rc=1
    elif disk_ready; then
      if offsite_push "$ETC/disk.auth" "$ETC/backup.pass" "$src"; then offsite_ok; else offsite_fail "$DISK_ERR"; rc=1; fi
    fi
  fi
  check_space; check_paid
  # Копии перед переключением и всё прочее в /var/backups/magnat — не старше 30 дней (политика).
  [ -d "$BACKUPS" ] && find "$BACKUPS" -type f -mtime +29 -delete 2>/dev/null
  return $rc
}

# --- magnat backup-setup: один раз, руками владельца --------------------------------
do_backup_setup() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  [ -s "$API_BASE/current/api.py" ] || { echo "API входа ещё не поставлен — сначала строка установки (server/README.md)."; exit 1; }
  local tok p1 p2 src auth_new="$ETC/disk.auth.new" pass_new="$ETC/backup.pass.new"
  echo "Копии базы на Яндекс Диск: в папку приложения, зашифрованные. Токен и фразу вводи только здесь — в чат не присылай."
  echo "Как получить токен — server/README.md, раздел «Копия вне сервера»."
  read -rsp "1) Токен OAuth Яндекса (букв не видно — так и надо): " tok || true; echo
  tok="${tok//[[:space:]]/}"
  [[ "$tok" =~ ^[A-Za-z0-9._-]{20,300}$ ]] || { echo "НЕ УШЛО: это не похоже на токен (строка вида y0_AgAAAA…). Прежние настройки не тронуты."; exit 1; }
  echo "2) Фраза-ключ — ею шифруются копии. Запиши её на бумагу: без неё копии не открыть никому."
  read -rsp "   Придумай фразу-ключ (не короче 12 знаков): " p1 || true; echo
  read -rsp "   Повтори фразу-ключ: " p2 || true; echo
  [ "$p1" = "$p2" ] || { echo "НЕ УШЛО: фразы не совпали. Прежние настройки не тронуты."; exit 1; }
  [ "${#p1}" -ge 12 ] || { echo "НЕ УШЛО: фраза короче 12 знаков. Прежние настройки не тронуты."; exit 1; }
  install -d -m 0700 "$ETC"
  # shellcheck disable=SC2064  # пути подставляются сейчас: при выходе local уже нет
  trap "rm -f '$auth_new' '$pass_new'" EXIT
  (umask 077; printf 'Authorization: OAuth %s\n' "$tok" > "$auth_new"; printf '%s\n' "$p1" > "$pass_new")
  if [ ! -s "$API_DB" ]; then
    # Базы ещё нет — проверяем только токен: папка приложения отвечает 200 или 404 (создаётся первой загрузкой).
    disk_call "$auth_new" GET "$DISK_API/v1/disk/resources?path=app%3A%2F"
    [ "$DISK_CODE" = 404 ] || disk_explain || { rm -f "$DISK_OUT"; echo "НЕ УШЛО: $DISK_ERR. Прежние настройки не тронуты."; exit 1; }
    rm -f "$DISK_OUT"
    chmod 0600 "$auth_new" "$pass_new"; mv -f "$auth_new" "$ETC/disk.auth"; mv -f "$pass_new" "$ETC/backup.pass"
    echo "НАСТРОЕНО: Диск пустил. Базы ещё нет — первая копия уйдёт ночью, как появится; смотреть — magnat status."
    return 0
  fi
  if ! src="$(local_copy)"; then
    echo "НЕ УШЛО: не вышло сделать местную копию базы (служба magnat-api-backup) — пришли вывод magnat status. Прежние настройки не тронуты."; exit 1
  fi
  echo "Шифрую копию и выгружаю на Диск…"
  if offsite_push "$auth_new" "$pass_new" "$src"; then
    chmod 0600 "$auth_new" "$pass_new"; mv -f "$auth_new" "$ETC/disk.auth"; mv -f "$pass_new" "$ETC/backup.pass"
    offsite_ok
    echo "КОПИЯ НА ДИСКЕ ЕСТЬ: $DISK_NAME ($(( (DISK_SIZE + 1023) / 1024 )) КБ) в папке приложения на Яндекс Диске."
    echo "Дальше — сама, каждую ночь; смотреть — magnat status. Открыть копию можно только фразой-ключом."
    return 0
  fi
  echo "НЕ УШЛО: $DISK_ERR. Прежние настройки не тронуты."
  exit 1
}

# --- magnat user: запросы людей о своих данных ---------------------------------------
do_user() {
  [ "$(id -u)" -eq 0 ] || { log "запускать от root"; exit 1; }
  local act="$1" em res host port ans rc
  em="$(lower_trim "$2")"
  case "$act" in show|export|delete) ;; *) echo "magnat user show|export|delete АДРЕС — что есть, выслать человеку его данные, удалить аккаунт или отвязать заказы"; exit 2 ;; esac
  soft_email "$em" || { echo "«$em» не похоже на адрес почты."; exit 1; }
  if [ ! -s "$API_BASE/current/api.py" ] || [ ! -s "$API_DB" ]; then echo "Базы входа ещё нет — аккаунтов нет."; exit 1; fi
  case "$act" in
    show) run_api "$API_BASE/current" user show "$em" --db "$API_DB" ;;
    export)
      grep -q '^SMTP_PASS=.' "$ETC/smtp.env" 2>/dev/null || { echo "НЕ УШЛО: почта не настроена → magnat mail."; exit 1; }
      rc=0; res="$(run_api "$API_BASE/current" user export "$em" --db "$API_DB" --creds - < "$ETC/smtp.env" 2>&1)" || rc=$?
      if grep -q '^export-ok' <<<"$res"; then
        echo "ВЫГРУЗКА ОТПРАВЛЕНА: письмо с данными ушло на $em — только на этот адрес."
      elif grep -q '^mail-fail' <<<"$res"; then
        host="$(sed -n 's/^SMTP_HOST=//p' "$ETC/smtp.env" | head -n 1)"; port="$(sed -n 's/^SMTP_PORT=//p' "$ETC/smtp.env" | head -n 1)"
        echo "НЕ УШЛО: $(mail_fail_hint "$res" "$host" "$port")."; exit 1
      else
        echo "$res"            # «Аккаунта с этим адресом нет.», «не похоже на адрес» — словами api.py
        [ "$rc" -eq 0 ] || exit 1
      fi ;;
    delete)
      res="$(run_api "$API_BASE/current" user show "$em" --db "$API_DB" 2>&1)" || { echo "$res"; exit 1; }
      echo "$res"
      if grep -q '^Аккаунт есть' <<<"$res"; then
        echo "Удалить аккаунт $em с сервера? Почта и все записи стираются сразу, из копий — в течение 30 дней. Восстановить будет нельзя."
      elif grep -q '^Заказы (' <<<"$res"; then
        # оплатил, но не входил: аккаунта нет, а почта, Telegram и IP лежат в заказах
        echo "Отвязать почту, Telegram и IP от заказов и снять срок доступа? Суммы заказов останутся для чеков, без адреса. Восстановить будет нельзя."
      else
        exit 0                 # «Аккаунта с этим адресом нет.» — удалять нечего
      fi
      read -rp "Напиши ДА: " ans || true
      [ "$ans" = "ДА" ] || { echo "Отмена — ничего не удалено."; exit 1; }
      run_api "$API_BASE/current" user delete "$em" --db "$API_DB" ;;
  esac
}

case "${1:-status}" in
  deploy)   do_deploy ;;
  status)   do_status ;;
  rollback) do_rollback ;;
  mail)     do_mail ;;
  restart)  do_restart ;;
  upgrade)  do_upgrade ;;
  api-backup) do_api_backup ;;
  backup)   do_backup ;;
  backup-setup) do_backup_setup ;;
  user)     do_user "${2:-}" "${3:-}" ;;
  paid-until) do_paid_until "${2:-}" ;;
  platega)  do_platega "${2:-}" ;;
  grant)    do_grant "${2:-}" "${3:-}" ;;
  orders)   do_orders "${2:-}" "${3:-}" ;;
  refund)   do_refund "${2:-}" ;;
  *) sed -n '2,/^#  Как устроена/{/^#  Как устроена/!p}' "$0" | sed 's/^#//'; exit 2 ;;
esac

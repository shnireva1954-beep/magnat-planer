#!/usr/bin/env bash
# =============================================================================
#  Магнат — установка сайта на свой сервер в России (Ubuntu 22.04/24.04)
# =============================================================================
#  Зачем свой сервер, а не GitHub Pages:
#   - оплата и вход по почте требуют своего сервера, а 152-ФЗ велит хранить
#     данные россиян в России;
#   - репозиторий можно закрыть: код и история перестанут быть видны всем;
#   - свои заголовки безопасности (CSP, HSTS) и сайт ближе к клиенту.
#
#  Запуск — одна строка в Termius на сервере (вся команда ASCII):
#    command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git); rm -rf /root/magnat-setup && git clone -q --depth 1 https://github.com/shnireva1954-beep/magnat-planer /root/magnat-setup && bash /root/magnat-setup/server/install.sh
#
#  Повторный запуск безопасен: всё пересобирается, ничего не плодится.
#  Что именно делает — по шагам ниже. Устройство и откат — server/README.md.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE=/var/lib/magnat
BASE=/srv/magnat

C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_OFF=$'\e[0m'
ok()   { echo "${C_OK}[ОК]${C_OFF}   $*"; }
warn() { echo "${C_WARN}[!]${C_OFF}    $*"; }
fail() { echo "${C_ERR}[ОШИБКА]${C_OFF} $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Запускать от root."
command -v apt-get >/dev/null || fail "Нужна Ubuntu или Debian."
export DEBIAN_FRONTEND=noninteractive

echo "=============================================="
echo " Магнат — установка на сервер"
echo "=============================================="

# --- 1. Снять старую пересылку VPN («обход глушилок») ---------------------------
# Решение Артёма 01.10.2026: эта машина больше не вход VPN, а дом Магната.
# Пересылка (install-relay.sh из репозитория GenaVPN) держала порт 443 — пока
# она стоит, сайту его не получить. Снимаем только своё, по метке.
echo; echo "--- 1/7 Снимаю старую пересылку VPN ---"
n_relay=0
for t in nat filter mangle; do
  while read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    iptables -t "$t" -D $rule 2>/dev/null && n_relay=$((n_relay + 1)) || true
  done < <(iptables-save -t "$t" 2>/dev/null | grep -- '--comment genavpn-relay' | sed 's/^-A //' || true)
done
for svc in gp genavpn-relay-check; do
  systemctl disable --now "$svc" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$svc.service"
done
rm -rf /opt/gp /opt/genavpn-relay /etc/sysctl.d/99-genavpn-relay.conf
systemctl daemon-reload
if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
ok "Пересылка снята (правил убрано: $n_relay), проверочная страница снята."

# --- 2. Пакеты ------------------------------------------------------------------
echo; echo "--- 2/7 Пакеты: Caddy, git, файрвол, защита SSH, автообновления ---"
# Полгигабайта памяти: apt и Caddy на старте могут упереться. Файл подкачки
# на 1 ГБ — дешёвая страховка от «убит по нехватке памяти».
if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Подкачка 1 ГБ включена."
fi
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban python3-systemd unattended-upgrades >/dev/null

# Caddy — из официального репозитория (свежий, сам обновляется). Не вышло —
# из репозитория Ubuntu: старее, но рабочий.
if [ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
fi
if [ -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || true
  apt-get update -qq || true
fi
apt-get install -y -qq caddy >/dev/null || fail "Caddy не поставился. Пришли вывод мне."
ok "Caddy $(caddy version | awk '{print $1}'), git, ufw, fail2ban на месте."

# --- 3. Пользователь, папки, ключ выкладки --------------------------------------------
echo; echo "--- 3/7 Пользователь выкладки и ключ к GitHub ---"
id magnat >/dev/null 2>&1 ||
  useradd --system --home-dir "$STATE" --create-home --shell /usr/sbin/nologin magnat
install -d -o magnat -g magnat -m 0750 "$STATE"
install -d -o root -g root -m 0755 "$BASE" "$BASE/releases"
if [ ! -s "$STATE/deploy_key" ]; then
  runuser -u magnat -- ssh-keygen -q -t ed25519 -N '' -C "magnat-server-deploy" -f "$STATE/deploy_key"
fi
# Ключи GitHub — из его документации (docs.github.com, «SSH key fingerprints»),
# сверены 02.10.2026. Подмена сервера по дороге не пройдёт.
cat > "$STATE/known_hosts" <<'EOF'
[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
[ssh.github.com]:443 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
[ssh.github.com]:443 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
chown magnat:magnat "$STATE/known_hosts"
# Свой внешний адрес — для самолечения сертификата (сравнить с DNS).
for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
  ip="$(curl -fsS --max-time 5 "$u" 2>/dev/null | tr -d '[:space:]')" || true
  if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "$ip" > "$STATE/my-ip"; break; fi
done
ok "Ключ выкладки готов (только чтение, ставится в GitHub одним действием)."

# --- 4. Выкладка: скрипт, таймер, первая выкладка ---------------------------------
echo; echo "--- 4/7 Выкладка из GitHub ---"
install -m 0755 "$HERE/magnat.sh" /usr/local/sbin/magnat
cat > /etc/systemd/system/magnat-deploy.service <<'EOF'
[Unit]
Description=Magnat: deploy main from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/magnat deploy
TimeoutStartSec=5min
EOF
cat > /etc/systemd/system/magnat-deploy.timer <<'EOF'
[Unit]
Description=Magnat: check GitHub for a new version every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
/usr/local/sbin/magnat deploy || true
[ -s "$BASE/current/index.html" ] || fail "Первая выкладка не удалась: сайт не скачался из GitHub. Пришли вывод мне."
ok "Сайт скачан: версия $(basename "$(readlink "$BASE/current")" | cut -c1-7)."

# --- 5. Caddy ---------------------------------------------------------------------
echo; echo "--- 5/7 Веб-сервер Caddy (HTTPS сам, заголовки безопасности) ---"
[ -f /etc/caddy/Caddyfile ] && cp -f /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig 2>/dev/null || true
install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || fail "Caddyfile не прошёл проверку."
busy="$(ss -tlnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)"
[ -z "$busy" ] || fail "Порт 80 или 443 занят чужой программой: $busy"
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 2
systemctl is-active --quiet caddy || fail "Caddy не запустился: journalctl -u caddy -n 30"
systemctl enable --now magnat-deploy.timer >/dev/null 2>&1
ok "Caddy работает, проверка новых версий — раз в минуту."

# --- 6. Файрвол и защита SSH --------------------------------------------------------
echo; echo "--- 6/7 Файрвол и защита входа ---"
ssh_ports="$({
  sshd -T 2>/dev/null | awk '/^port /{print $2}' || true
  [ -n "${SSH_CONNECTION:-}" ] && awk '{print $4}' <<<"${SSH_CONNECTION}"
  ss -tlpn 2>/dev/null | awk '/sshd/{split($4,a,":"); print a[length(a)]}' || true
} 2>/dev/null | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' || true)"
[ -n "${ssh_ports// /}" ] || ssh_ports="22"
# Правила ставим ДО включения — иначе можно отрезать себе вход.
ufw --force reset >/dev/null 2>&1 || true
sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="DROP"/' /etc/default/ufw
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $ssh_ports; do ufw allow "$p/tcp" comment 'SSH' >/dev/null; done
ufw allow 80/tcp comment 'HTTP: сертификат и переадресация' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw allow 443/udp comment 'HTTP/3' >/dev/null
ufw --force enable >/dev/null
cat > /etc/fail2ban/jail.d/magnat-sshd.conf <<EOF
[sshd]
enabled  = true
port     = $(echo "$ssh_ports" | tr -s ' ' ',' | sed 's/^,//; s/,$//')
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || warn "fail2ban не перезапустился — не страшно, сайт работает."
ok "Открыто только: SSH ($ssh_ports), 80, 443. Перебор пароля — бан на час."

# --- 7. Автообновления безопасности ---------------------------------------------------
echo; echo "--- 7/7 Автообновления ---"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52magnat-unattended <<'EOF'
// Обновления безопасности ставятся сами, Caddy — тоже (его репозиторий).
// Сам сервер НЕ перезагружается: перезагрузка — руками, в удобное время.
Unattended-Upgrade::Origins-Pattern { "origin=cloudsmith/caddy/stable"; };
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
systemctl enable unattended-upgrades >/dev/null 2>&1 || true
ok "Обновления безопасности и Caddy ставятся сами."

echo
/usr/local/sbin/magnat status
echo
echo "VSE-GOTOVO"

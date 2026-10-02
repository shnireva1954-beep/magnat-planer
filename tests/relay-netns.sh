#!/usr/bin/env bash
# Снятие старой пересылки VPN (server/install.sh, remove_relay) — на НАСТОЯЩЕМ
# iptables, в двух изолированных сетях (пробирках), с теми же пятью правилами,
# что стояли на сервере 193.108.113.70 (вывод iptables-save 02.10.2026, 15:07).
# Зовётся из 06-server.js. Нужны root и `ip netns`; нет — печатает «пропуск».
#   1. через пересылку идут живые соединения — установка СТОП, правила целы;
#   2. тишина — снимаются ровно пять правил, правила ufw целы, копия правил
#      отложена, ip_forward выключен, порт 443 теперь отвечает сам сервер.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(id -u)" -ne 0 ] || ! command -v ip >/dev/null || ! command -v iptables >/dev/null; then
  echo "SKIP нужен root, ip и iptables"; exit 0
fi
S="mtest-srv-$$"; C="mtest-cli-$$"; FS="$(mktemp -d)"
cleanup() { ip netns del "$S" 2>/dev/null; ip netns del "$C" 2>/dev/null; rm -rf "$FS"; }
trap cleanup EXIT
fails=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ FAIL: $*"; fails=$((fails + 1)); }

ip netns add "$S" && ip netns add "$C" || { echo "SKIP ip netns не работает"; exit 0; }
ip link add "v$$s" type veth peer name "v$$c"
ip link set "v$$s" netns "$S"; ip link set "v$$c" netns "$C"
ip -n "$S" addr add 10.77.0.1/24 dev "v$$s"; ip -n "$C" addr add 10.77.0.2/24 dev "v$$c"
ip -n "$S" link set "v$$s" up; ip -n "$C" link set "v$$c" up; ip -n "$S" link set lo up
in_srv() { ip netns exec "$S" "$@"; }

setup_rules() {
  in_srv iptables -t nat -F; in_srv iptables -F; in_srv iptables -X 2>/dev/null
  # ровно как на сервере 02.10
  in_srv iptables -A FORWARD -d 45.94.37.94/32 -j ACCEPT
  in_srv iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  in_srv iptables -t nat -A PREROUTING -p tcp -m tcp --dport 443 -j DNAT --to-destination 45.94.37.94:443
  in_srv iptables -t nat -A PREROUTING -p udp -m udp --dport 20443 -j DNAT --to-destination 45.94.37.94:20443
  in_srv iptables -t nat -A POSTROUTING -d 45.94.37.94/32 -j MASQUERADE
  # то, что трогать нельзя: цепочки ufw и переходы в них
  in_srv iptables -N ufw-before-forward; in_srv iptables -N ufw-user-input
  in_srv iptables -A FORWARD -j ufw-before-forward
  in_srv iptables -A ufw-before-forward -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  in_srv iptables -A INPUT -j ufw-user-input
  in_srv iptables -A ufw-user-input -p tcp --dport 443 -j ACCEPT
  mkdir -p "$FS/etc/iptables"
  in_srv iptables-save > "$FS/etc/iptables/rules.v4"
}
relay_left() { in_srv iptables-save | grep -cE -- '-j (DNAT|MASQUERADE)|^-A FORWARD -d 45\.94|^-A FORWARD -m conntrack' ; }
run_remove() {
  in_srv env MAGNAT_RELAY_ONLY=1 MAGNAT_ROOTFS="$FS" MAGNAT_MY_IP=193.108.113.70 \
    MAGNAT_RELAY_WINDOW="$1" MAGNAT_RELAY_MAX=30 bash "$ROOT/server/install.sh" 2>&1
}

# --- 1. живые соединения ------------------------------------------------------
setup_rules
( for _ in $(seq 1 150); do ip netns exec "$C" timeout 0.03 bash -c '</dev/tcp/10.77.0.1/443' 2>/dev/null; done ) &
out="$(run_remove 3)"; rc=$?; wait
if [ "$rc" -ne 0 ] && grep -q 'живые соединения' <<<"$out" && [ "$(relay_left)" -eq 5 ] && [ -f "$FS/etc/iptables/rules.v4" ]; then
  ok "через пересылку идут соединения — СТОП, все пять правил и копия на месте ($(grep -o 'пересылку: [0-9]*' <<<"$out"))"
else
  bad "живые соединения не остановили снятие (код $rc, осталось $(relay_left)): $out"
fi

# --- 2. тишина ----------------------------------------------------------------
setup_rules
out="$(run_remove 2)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(relay_left)" -eq 0 ] && ok "тишина — сняты все пять правил пересылки" || bad "правила не снялись (код $rc, осталось $(relay_left)): $out"
grep -q 'правил убрано: 5' <<<"$out" && ok "в отчёте честное «убрано: 5»" || bad "в отчёте не «убрано: 5»: $out"
in_srv iptables-save | grep -q -- '-A FORWARD -j ufw-before-forward' && in_srv iptables-save | grep -q -- '-A ufw-before-forward -m conntrack' \
  && in_srv iptables-save | grep -q -- '-A ufw-user-input -p tcp -m tcp --dport 443 -j ACCEPT' \
  && ok "правила ufw (переходы и цепочки) не тронуты" || bad "задеты правила ufw: $(in_srv iptables-save)"
[ ! -f "$FS/etc/iptables/rules.v4" ] && [ -f "$FS/etc/iptables/rules.v4.relay-old" ] && ok "копия правил отложена в rules.v4.relay-old, не удалена" || bad "rules.v4 не отложен"
[ "$(in_srv sysctl -n net.ipv4.ip_forward)" = "0" ] && ok "ip_forward выключен" || bad "ip_forward не выключен"
# 443 теперь ведёт на сам сервер: «отказ» сразу, а не ожидание Амстердама
err="$(ip netns exec "$C" timeout 2 bash -c '</dev/tcp/10.77.0.1/443' 2>&1)"
grep -q 'refused' <<<"$err" && ok "порт 443 отвечает сам сервер (до правки уходил в Амстердам)" || bad "443 всё ещё не на сервере: $err"
out="$(run_remove 1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q 'убрано: 0' <<<"$out" && ok "повторный запуск — ничего не ломает, «убрано: 0»" || bad "повторный запуск: $out"

[ "$fails" -eq 0 ] && echo "relay: всё чисто" || echo "✗ relay: $fails проблем"
exit "$fails"

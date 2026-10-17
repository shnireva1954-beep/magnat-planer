// Свой сервер (server/): выкладка, Caddy и заголовки безопасности — на
// настоящем Caddy, а не на словах. Что проверяется:
//   1. server/Caddyfile проходит `caddy validate` и отформатирован;
//   2. server/magnat.sh выкладывает коммит без служебного, не выкладывает
//      битый, хранит пять версий, откатывается и не возвращает откаченное,
//      не применяет сломанный Caddyfile и возвращает прежний, если сайт лёг;
//   3. Caddy с этим Caddyfile отдаёт заголовки, прячет служебное, ведёт
//      www на главный адрес;
//   4. всё приложение (01-scenarios) проходит под этими заголовками — CSP
//      не ломает ни одной кнопки (нарушение CSP — ошибка в консоли, её
//      01-scenarios и ловит);
//   5. продающая страница на «/» под той же CSP: без ошибок; кто уже
//      пользуется (есть данные) — сразу в приложение (app.html).
// Плюс API входа (server/api): шаг установки и службы (1д), выкладка API за
// сайтом с проверкой и откатом (2б), magnat mail / status / upgrade и копия
// базы (2в), копия на Яндекс Диск (поддельный REST API), запросы людей о
// данных и оплата сервера (2г), ключи Платеги, ручная выдача доступа, оплаты
// месяца и строка «Платега:» (2д, поддельная Платега), /api через Caddy — прокси,
// заголовки, колбэк Платеги без Origin, 413 и 503 JSON (3б).
// Caddy берётся из PATH, из CADDY= или скачивается с официального
// репозитория в node_modules/.cache (он в .gitignore) — tests/lib.js.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), zlib = require("zlib"), crypto = require("crypto");
const L = require("./lib");
const { findCaddy, freePort, get, waitPort } = L;

const ROOT = path.join(__dirname, "..");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };
const sh = (cmd, opts = {}) => spawnSync("bash", ["-c", cmd], { encoding: "utf8", ...opts });

(async () => {
  const CADDY = findCaddy();
  const caddyVer = sh(`"${CADDY}" version`).stdout.split(" ")[0];
  console.log("  Caddy:", caddyVer);
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "magnat-srv-"));
  const bin = path.join(T, "bin"); fs.mkdirSync(bin);
  // API входа в проверке: код — AB/releases, база — AS, секреты — ETC, копии — BK.
  const AB = path.join(T, "api-srv"), AS = path.join(T, "api-state"), ETC = path.join(T, "etc"), BK = path.join(T, "backups");
  fs.mkdirSync(AS, { mode: 0o700 }); fs.mkdirSync(ETC, { mode: 0o700 });
  fs.writeFileSync(path.join(ETC, "smtp.env"), "", { mode: 0o600 });       // как после install.sh: пустой
  fs.writeFileSync(path.join(ETC, "platega.env"), "", { mode: 0o600 });    // и этот
  const APORT = await freePort(), PIDF = path.join(T, "api.pid");
  const killApi = () => { try { process.kill(+fs.readFileSync(PIDF, "utf8"), "SIGKILL"); } catch (e) {} };
  process.on("exit", killApi);
  // systemctl здесь нет — двойник пишет, что его звали, а magnat-api — правда
  // запускает и гасит (как служба: python3 -I …/current/api.py serve, окружение юнита;
  // smtp.env и platega.env — как LoadCredential). api-extra.env — строки KEY=VALUE сверх
  // юнита: 2д включает ими оплату и подставляет поддельную Платегу.
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash
echo "$@" >> "${T}/systemctl.log"
pidf="${PIDF}"
stop_api() {
  [ -s "$pidf" ] || return 0
  local p; p="$(cat "$pidf")"; kill "$p" 2>/dev/null
  for _ in $(seq 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$p" 2>/dev/null; rm -f "$pidf"
}
start_api() {
  local extra=(); [ ! -s "${T}/api-extra.env" ] || mapfile -t extra < "${T}/api-extra.env"
  env -i PATH=/usr/bin:/bin MAGNAT_LISTEN=127.0.0.1:${APORT} MAGNAT_STATE="${AS}" MAGNAT_DB="${AS}/magnat.db" \\
    MAGNAT_SMTP_FILE="${ETC}/smtp.env" MAGNAT_PLATEGA_FILE="${ETC}/platega.env" MAGNAT_DISK_MIN_MB=0 "\${extra[@]}" \\
    setsid python3 -I "${AB}/current/api.py" serve \\
    >>"${T}/api.log" 2>&1 </dev/null 9>&- &
  echo $! > "$pidf"
}
cmd="$1"; shift
case " $* " in *" magnat-api "*|*" magnat-api.service "*) api=1 ;; *) api= ;; esac
case "$cmd" in
  restart|start) [ -z "$api" ] || { stop_api; start_api; } ;;
  stop) [ -z "$api" ] || stop_api ;;
esac
exit 0
`, { mode: 0o755 });
  // runuser и python — двойники-самописцы: по их журналам видно, что api.py
  // ни разу не запущен мимо runuser (root код из репозитория не запускает).
  fs.writeFileSync(path.join(bin, "runuser"), `#!/bin/bash
printf '%s\\n' "$*" >> "${T}/runuser.log"
[ "$1" = "-u" ] && [ "$3" = "--" ] || exit 99
shift 3; exec "$@"
`, { mode: 0o755 });
  const PYW = path.join(T, "py-wrap");
  fs.writeFileSync(PYW, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${T}/py.log"\nexec python3 "$@"\n`, { mode: 0o755 });
  const SELF = path.join(T, "self-magnat"); fs.copyFileSync(path.join(ROOT, "server/magnat.sh"), SELF);
  fs.symlinkSync(CADDY, path.join(bin, "caddy"));

  // ---- 1. Caddyfile --------------------------------------------------------
  console.log("\n1. server/Caddyfile");
  const v = sh(`"${CADDY}" validate --config server/Caddyfile --adapter caddyfile`, { cwd: ROOT });
  v.status === 0 ? ok("caddy validate — без ошибок") : bad("caddy validate: " + v.stderr.slice(-400));
  const f = sh(`"${CADDY}" fmt server/Caddyfile | diff -q - server/Caddyfile`, { cwd: ROOT });
  f.status === 0 ? ok("caddy fmt — отформатирован") : bad("Caddyfile не отформатирован: caddy fmt --overwrite server/Caddyfile");
  {
    const cft = fs.readFileSync(path.join(ROOT, "server/Caddyfile"), "utf8");
    const mb = (re) => { const m = re.exec(cft); return m ? parseFloat(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()]) : 0; };
    const maxB = mb(/max_size\s+([\d.]+)\s*(KB|MB|GB)/i), bufB = mb(/request_buffers\s+([\d.]+)\s*(KB|MB|GB)/i);
    maxB >= 1.5 && bufB >= maxB ? ok(`/api: тело до ${maxB} МБ, Caddy дочитывает его сам (request_buffers ${bufB} МБ) — медленный клиент не держит API`)
      : bad(`/api: max_size ${maxB} МБ, request_buffers ${bufB} МБ — буфер должен быть не меньше предела тела (≥ 1,5 МБ)`);
  }
  const sc = sh("command -v shellcheck >/dev/null && shellcheck -S style server/install.sh server/magnat.sh", { cwd: ROOT });
  if (sh("command -v shellcheck").status === 0) sc.status === 0 ? ok("shellcheck — чисто") : bad("shellcheck:\n" + sc.stdout);

  // ---- 1б. замок «не тот сервер» ------------------------------------------
  console.log("\n1б. server/install.sh — замок «не тот сервер» (до любого изменения)");
  const FS = path.join(T, "fs"); fs.mkdirSync(FS);
  const guard = (myIp, extra = {}) => spawnSync("bash", [path.join(ROOT, "server/install.sh")], { encoding: "utf8",
    env: { ...process.env, MAGNAT_GUARD_ONLY: "1", MAGNAT_ROOTFS: FS, MAGNAT_MY_IP: myIp, ...extra } });
  let g = guard("193.108.113.70");
  g.status === 0 ? ok("машина Магната (193.108.113.70, без следов VPN) — пускает") : bad("свою машину не пустил: " + g.stderr);
  g = guard("10.0.0.5 193.108.113.70 ");
  g.status === 0 ? ok("адрес нашёлся среди нескольких (внешний + на интерфейсе) — пускает") : bad("не нашёл адрес в списке: " + g.stderr);
  g = guard("45.94.37.94");
  g.status === 1 && /Не тот сервер/.test(g.stderr) ? ok("адрес сервера VPN (45.94.37.94) — СТОП") : bad("чужой адрес пропущен: " + g.status + g.stderr);
  g = guard("193.108.113.700");
  g.status === 1 ? ok("похожий, но другой адрес (…70 → …700) — СТОП") : bad("похожий адрес пропущен");
  g = guard("");
  g.status === 1 && /Не тот сервер/.test(g.stderr) ? ok("адрес узнаётся сам (здесь он чужой) — СТОП") : bad("сам узнанный чужой адрес: код " + g.status + " " + g.stderr.slice(-200));
  const before0 = fails;
  for (const mark of ["opt/genavpn-repo", "opt/remnanode", "opt/remnawave", "opt/genavpn-bot", "opt/caddy"]) {
    fs.mkdirSync(path.join(FS, mark), { recursive: true });
    g = guard("193.108.113.70");
    if (!(g.status === 1 && /сервер VPN/.test(g.stderr))) bad(`/${mark} на машине — не остановил: ${g.status} ${g.stderr}`);
    fs.rmSync(path.join(FS, mark), { recursive: true });
  }
  if (fails === before0) ok("следы VPN (/opt/genavpn-repo, remnanode, remnawave, genavpn-bot, caddy) — СТОП даже на верном адресе");
  g = guard("1.2.3.4", { MAGNAT_IP: "1.2.3.4" });
  g.status === 0 ? ok("новая машина под Магнат — MAGNAT_IP=<адрес> пускает") : bad("MAGNAT_IP не работает");
  // Замок стоит ДО первого изменения: ничего выше него не трогает систему.
  const inst = fs.readFileSync(path.join(ROOT, "server/install.sh"), "utf8");
  // Описания функций (name() { … }) не выполняются — их тела не считаем, только верхний уровень.
  const before = inst.slice(0, inst.indexOf("guard || exit 1")).replace(/^[a-z_]+\(\) \{\n[\s\S]*?^\}$/gm, "");
  /\b(iptables|apt-get|ufw|systemctl|rm -rf|useradd|install -|fallocate|sysctl|mv|remove_relay)\b/.test(before.replace(/^\s*#.*$/gm, "").replace(/command -v \w+/g, ""))
    ? bad("до замка есть команда, меняющая систему") : ok("до замка — ни одной команды, меняющей систему");

  // ---- 1в. старая пересылка VPN ---------------------------------------------
  console.log("\n1в. server/install.sh — снятие старой пересылки VPN");
  // Точный вывод iptables-save с сервера 193.108.113.70 (02.10.2026, 15:07):
  // правила без метки genavpn-relay — их установка сначала не увидела.
  const IPT = [
    "*filter", ":FORWARD DROP [0:0]", ":ufw-before-forward - [0:0]",
    "-A FORWARD -d 45.94.37.94/32 -j ACCEPT",
    "-A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "-A FORWARD -j ufw-before-logging-forward", "-A FORWARD -j ufw-before-forward",
    "-A ufw-before-forward -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "-A ufw-user-input -p tcp -m tcp --dport 443 -m comment --comment \"'dapp_HTTPS'\" -j ACCEPT", "COMMIT",
    "*nat",
    "-A PREROUTING -p tcp -m tcp --dport 443 -j DNAT --to-destination 45.94.37.94:443",
    "-A PREROUTING -p udp -m udp --dport 20443 -j DNAT --to-destination 45.94.37.94:20443",
    "-A POSTROUTING -d 45.94.37.94/32 -j MASQUERADE", "COMMIT",
    "*mangle", "-A FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment genavpn-relay -j TCPMSS --clamp-mss-to-pmtu", "COMMIT", ""].join("\n");
  const pr = spawnSync("bash", [path.join(ROOT, "server/install.sh")], { input: IPT, encoding: "utf8", env: { ...process.env, MAGNAT_RELAY_PARSE: "1" } });
  const picked = pr.stdout.trim().split("\n").map(l => l.replace("\t", " | "));
  const want = ["filter | FORWARD -d 45.94.37.94/32 -j ACCEPT", "filter | FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "nat | PREROUTING -p tcp -m tcp --dport 443 -j DNAT --to-destination 45.94.37.94:443",
    "nat | PREROUTING -p udp -m udp --dport 20443 -j DNAT --to-destination 45.94.37.94:20443",
    "nat | POSTROUTING -d 45.94.37.94/32 -j MASQUERADE",
    "mangle | FORWARD -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment genavpn-relay -j TCPMSS --clamp-mss-to-pmtu"];
  JSON.stringify(picked) === JSON.stringify(want) ? ok("разбор: выбраны ровно правила пересылки (5 без метки + подрезка с меткой), ufw не задет")
    : bad("разбор выбрал не то:\n    " + picked.join("\n    "));
  const nn = spawnSync("bash", [path.join(__dirname, "relay-netns.sh")], { encoding: "utf8", timeout: 120000 });
  const nout = (nn.stdout || "") + (nn.stderr || "");
  if (/^SKIP/.test(nout)) console.log("  ⚠ пропуск проверки на настоящем iptables: " + nout.trim().slice(5) + " (разбор выше — проверен)");
  else { process.stdout.write(nout.split("\n").filter(l => /✓|✗/.test(l)).join("\n") + "\n"); if (nn.status !== 0) bad("снятие пересылки на настоящем iptables (relay-netns.sh)"); }

  // ---- 1г. apt занят автообновлениями ----------------------------------------
  // 02.10 второй запуск упал на шаге 2: «Could not get lock …/lock-frontend».
  // Поддельный apt-get отвечает «занято» N раз, потом пускает; MAGNAT_MY_IP
  // чужой — если ручки проверки нет, замок остановит установку до изменений.
  console.log("\n1г. server/install.sh — apt занят автообновлениями");
  const FAKE = path.join(T, "fake-apt"); fs.mkdirSync(FAKE, { recursive: true });
  fs.writeFileSync(path.join(FAKE, "apt-get"), `#!/bin/bash
n=$(( $(cat "$APT_CNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$APT_CNT"; echo "$*" >> "$APT_CNT.log"
if [ "$n" -le "$APT_LOCKED" ]; then echo "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (unattended-upgr)" >&2; exit 100; fi
[ -z "$APT_OTHER" ] || { echo "E: Unable to locate package caddy" >&2; exit 100; }
exit 0
`, { mode: 0o755 });
  const apt = (locked, extra = {}) => {
    const cnt = path.join(T, "apt-cnt-" + Math.random().toString(36).slice(2));
    const r = spawnSync("bash", [path.join(ROOT, "server/install.sh")], { encoding: "utf8", timeout: 30000, env: { ...process.env,
      PATH: FAKE + ":" + process.env.PATH, MAGNAT_APT_TRY: "update -qq", MAGNAT_APT_PAUSE: "0", MAGNAT_MY_IP: "0.0.0.1",
      APT_CNT: cnt, APT_LOCKED: String(locked), APT_OTHER: "", ...extra } });
    const calls = fs.existsSync(cnt) ? fs.readFileSync(cnt + ".log", "utf8").trim().split("\n") : [];
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), calls };
  };
  let a = apt(3);
  a.status === 0 && a.calls.length === 4 && /жду/.test(a.out) ? ok("занято трижды — ждёт и ставит (4 попытки, говорит «жду»)")
    : bad(`занятый apt: код ${a.status}, попыток ${a.calls.length}\n    ${a.out.trim().slice(-300)}`);
  a.calls.length && a.calls.every(c => /DPkg::Lock::Timeout=\d+/.test(c)) ? ok("каждый вызов ещё и с DPkg::Lock::Timeout (замок dpkg ждёт сам apt)")
    : bad("вызов apt без DPkg::Lock::Timeout: " + a.calls[0]);
  a = apt(0, { APT_OTHER: "1" });
  a.status === 100 && a.calls.length === 1 && /Unable to locate package/.test(a.out) ? ok("другая ошибка apt — сразу наружу, с текстом и кодом apt")
    : bad(`другая ошибка: код ${a.status}, попыток ${a.calls.length}`);
  a = apt(1000, { MAGNAT_APT_WAIT: "1", MAGNAT_APT_PAUSE: "0.2" });
  a.status === 100 && /Could not get lock/.test(a.out) ? ok("занято дольше срока — сдаётся с ошибкой apt, а не висит")
    : bad(`бесконечно занятый apt: код ${a.status}`);
  // Ни одного вызова apt-get мимо ожидания (кроме строки запуска в шапке и проверки «есть ли apt»).
  const bare = inst.replace(/^apt_get\(\) \{\n[\s\S]*?^\}$/m, "").replace(/^\s*#.*$/gm, "").replace(/command -v apt-get/g, "")
    .split("\n").filter(l => /\bapt-get\b/.test(l));
  bare.length === 0 ? ok("все вызовы apt в установке — через ожидание") : bad("apt-get мимо ожидания:\n    " + bare.join("\n    "));

  // ---- 1д. API входа: шаг установки и службы ---------------------------------
  console.log("\n1д. server/install.sh — шаг «API входа» и его службы");
  {
    const at = (x) => inst.indexOf(x);
    const steps = [...inst.matchAll(/^echo; echo "--- (\d)\/(\d) /gm)].map(m => m[1] + "/" + m[2]);
    JSON.stringify(steps) === JSON.stringify(["1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "8/8"]) && /--- 5\/8 API входа/.test(inst)
      ? ok("шаги 1/8…8/8, «API входа» — пятый (после выкладки, до Caddy)") : bad("шаги установки: " + steps.join(" "));
    const ua = at("useradd --system --home-dir /var/lib/magnat-api");
    ua > at("guard || exit 1") && at("guard || exit 1") > 0 && ua > at("--- 4/8") && ua < at("--- 6/8")
      ? ok("пользователь magnat-api и всё API — после замка «не тот сервер»") : bad("шаг API стоит не там: useradd на " + ua);
    /install -d -o magnat-api -g magnat-api -m 0700 \/var\/lib\/magnat-api/.test(inst) && /\[ -e \/etc\/magnat\/smtp\.env \] \|\| install -o root -g root -m 0600 \/dev\/null \/etc\/magnat\/smtp\.env/.test(inst)
      && /install -d -o root -g root -m 0700 \/etc\/magnat/.test(inst)
      ? ok("/var/lib/magnat-api 0700 magnat-api, /etc/magnat 0700 root, пустой smtp.env 0600 — служба стартует и без почты") : bad("папки и smtp.env API не те");
    // ключи Платеги — так же: пустой файл, если его нет (повторная установка ключи не стирает), и до юнита
    const pe = at("[ -e /etc/magnat/platega.env ] || install -o root -g root -m 0600 /dev/null /etc/magnat/platega.env");
    pe > at("install -d -o root -g root -m 0700 /etc/magnat") && pe < at("cat > /etc/systemd/system/magnat-api.service") && at("guard || exit 1") < pe
      && !/(\brm\b|\btruncate\b|>)[^\n]*\/etc\/magnat\/platega\.env/.test(inst.replace(/^\s*#.*$/gm, "").replace(/\[ -e \/etc\/magnat\/platega\.env \] \|\| install[^\n]*/, ""))
      ? ok("пустой platega.env 0600 — только если его нет (ключи при повторной установке целы), до юнита: служба стартует и без ключей Платеги")
      : bad("platega.env в install.sh: создаётся на " + pe + " или переписывается");
    const unit = (name) => { const m = new RegExp(`cat > /etc/systemd/system/${name.replace(/\./g, "\\.")} <<'EOF'\\n([\\s\\S]*?)\\nEOF`).exec(inst); return m ? m[1] : ""; };
    const svc = unit("magnat-api.service"), bsvc = unit("magnat-api-backup.service"), btim = unit("magnat-api-backup.timer");
    const has = (u, lines) => lines.filter(l => !u.split("\n").includes(l));
    const miss = has(svc, ["User=magnat-api", "Group=magnat-api", "ExecStart=/usr/bin/python3 -I /srv/magnat-api/current/api.py serve",
      "LoadCredential=smtp:/etc/magnat/smtp.env", "LoadCredential=platega:/etc/magnat/platega.env", "Restart=on-failure", "MemoryMax=96M", "MemoryHigh=72M", "NoNewPrivileges=yes",
      "ProtectSystem=strict", "ReadWritePaths=/var/lib/magnat-api", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
      "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes", "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"]);
    !miss.length ? ok("magnat-api.service: magnat-api, песочница, память ≤ 96 МБ, почта и ключи Платеги через LoadCredential") : bad("в magnat-api.service нет: " + miss.join(", "));
    const env = (svc.match(/^Environment=(.*)$/m) || ["", ""])[1].split(/\s+/).filter(Boolean);
    JSON.stringify(env) === JSON.stringify(["MAGNAT_LISTEN=127.0.0.1:8787", "MAGNAT_DB=/var/lib/magnat-api/magnat.db", "MAGNAT_STATE=/var/lib/magnat-api", "MAGNAT_ORIGIN=https://magnat-planer.ru"])
      && (svc.match(/^Environment/gm) || []).length === 1
      ? ok("окружение службы — только адрес 127.0.0.1:8787, база, папка и сайт; ни одной ручки проверки") : bad("окружение службы: " + env.join(" "));
    const rw = [svc, bsvc].map(u => (u.match(/^ReadWritePaths=.*$/gm) || []).join("|"));
    rw.every(x => x === "ReadWritePaths=/var/lib/magnat-api") ? ok("писать службам можно только в /var/lib/magnat-api") : bad("ReadWritePaths: " + rw.join(" ; "));
    has(bsvc, ["User=magnat-api", "ExecStart=/usr/local/sbin/magnat api-backup", "PrivateNetwork=yes", "ProtectSystem=strict"]).length === 0
      && !/runuser/.test(bsvc) && /^OnCalendar=/m.test(btim) && /^Persistent=true$/m.test(btim) && /systemctl enable --now magnat-api-backup\.timer/.test(inst)
      ? ok("копия базы раз в сутки — служба от magnat-api без сети и без runuser, таймер включён") : bad("служба/таймер копии базы не те");
    const osvc = unit("magnat-backup.service"), otim = unit("magnat-backup.timer");
    has(osvc, ["Type=oneshot", "ExecStart=/usr/local/sbin/magnat backup", "After=magnat-api-backup.service", "ProtectSystem=full", "ProtectHome=yes", "PrivateTmp=yes"]).length === 0
      && !/^User=/m.test(osvc) && /^OnCalendar=.* 01:10:00 UTC$/m.test(otim) && /^Persistent=true$/m.test(otim) && /systemctl enable --now magnat-backup\.timer/.test(inst)
      && /apt_get install .* openssl /.test(inst) && /\/var\/backups\/magnat\/offsite/.test(inst)
      ? ok("ночной magnat backup — от root после местной копии (копия на Диск, письма, чистка), таймер включён, openssl ставится") : bad("служба/таймер magnat-backup не те");
    if (sh("command -v systemd-analyze").status === 0) {
      const UD = path.join(T, "units"); fs.mkdirSync(UD);
      fs.writeFileSync(path.join(UD, "magnat-api.service"), svc);
      fs.writeFileSync(path.join(UD, "magnat-api-backup.service"), bsvc.replace("/usr/local/sbin/magnat api-backup", "/bin/true"));
      fs.writeFileSync(path.join(UD, "magnat-api-backup.timer"), btim);
      fs.writeFileSync(path.join(UD, "magnat-backup.service"), osvc.replace("/usr/local/sbin/magnat backup", "/bin/true"));
      fs.writeFileSync(path.join(UD, "magnat-backup.timer"), otim);
      const va = sh("systemd-analyze verify --man=no ./magnat-api.service ./magnat-api-backup.service ./magnat-api-backup.timer ./magnat-backup.service ./magnat-backup.timer", { cwd: UD });
      va.status === 0 && !(va.stdout + va.stderr).trim() ? ok("systemd-analyze verify — службы и таймер без замечаний")
        : bad("systemd-analyze verify:\n    " + (va.stdout + va.stderr).trim().split("\n").slice(0, 6).join("\n    "));
    } else console.log("  ⚠ пропуск systemd-analyze verify: его здесь нет (тексты служб проверены выше)");
  }

  // ---- 2. выкладка --------------------------------------------------------
  console.log("\n2. server/magnat.sh — выкладка");
  // Репозиторий-образец из ТЕКУЩЕГО рабочего дерева (с несохранёнными правками).
  const REPO = path.join(T, "repo");
  const files = sh("git ls-files -co --exclude-standard -z", { cwd: ROOT }).stdout.split("\0").filter(Boolean);
  for (const fl of files) { if (!fs.existsSync(path.join(ROOT, fl))) continue; const d = path.join(REPO, fl); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(ROOT, fl), d); }
  const git = (c) => sh(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${c}`, { cwd: REPO });
  git("init -q -b main"); git("add -A"); git("commit -q -m start");
  const head = () => git("rev-parse HEAD").stdout.trim();

  const BASE = path.join(T, "srv"), STATE = path.join(T, "state");
  fs.mkdirSync(path.join(BASE, "releases"), { recursive: true }); fs.mkdirSync(STATE);
  const CF = path.join(T, "Caddyfile"); fs.copyFileSync(path.join(ROOT, "server/Caddyfile"), CF);
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, MAGNAT_BASE: BASE, MAGNAT_STATE: STATE,
    MAGNAT_USER: os.userInfo().username, MAGNAT_URL_SSH: "file:///nonexistent", MAGNAT_URL_HTTPS: "file://" + REPO,
    MAGNAT_CADDYFILE: CF, MAGNAT_DOMAIN: "magnat-test.invalid",
    MAGNAT_API_BASE: AB, MAGNAT_API_STATE: AS, MAGNAT_API_PORT: String(APORT), MAGNAT_API_WAIT: "8", MAGNAT_ETC: ETC,
    MAGNAT_BACKUPS: BK, MAGNAT_PY: PYW, MAGNAT_SELF: SELF, MAGNAT_SETUP: path.join(T, "setup") };
  const deploy = (mode = "deploy", extra = {}) => spawnSync("bash", [path.join(ROOT, "server/magnat.sh"), mode], { encoding: "utf8", env: { ...env, ...extra } });
  const cur = () => { try { return path.basename(fs.readlinkSync(path.join(BASE, "current"))); } catch (e) { return ""; } };
  const live = (p) => fs.existsSync(path.join(BASE, "current", p));

  let r = deploy(), sha1 = head();
  cur() === sha1 ? ok("первая выкладка: current → " + sha1.slice(0, 7)) : bad("первая выкладка не встала: " + r.stdout + r.stderr);
  for (const p of ["index.html", "app.html", "sw.js", "manifest.json", "icon.png", "fonts/manrope.woff2", "img/og.jpg"]) if (!live(p)) bad("в выкладке нет " + p);
  const leaked = ["CLAUDE.md", "README.md", "tests", "server", "_config.yml", "CNAME", ".gitignore"].filter(live);
  leaked.length ? bad("в выкладку попало служебное: " + leaked.join(", ")) : ok("служебного в выкладке нет (CLAUDE.md, tests/, server/, _config.yml, CNAME, .gitignore)");
  fs.readFileSync(path.join(STATE, "fetch-how"), "utf8").includes("открыт") ? ok("ключа нет — взял открыто, как и должен до закрытия репозитория") : bad("fetch-how: " + fs.readFileSync(path.join(STATE, "fetch-how"), "utf8"));

  // magnat status считает ВСЕ правила пересылки, а не помеченные (02.10 по метке было «0»).
  fs.writeFileSync(path.join(bin, "iptables-save"), `#!/bin/sh\ncat "${T}/ipt.txt"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(T, "ipt.txt"), IPT);
  let st = deploy("status");
  /Пересылка VPN:\s+3 правил/.test(st.stdout) ? ok("magnat status: три правила пересылки без метки — видит «3»") : bad("magnat status не видит пересылку без метки: " + (st.stdout.match(/Пересылка VPN:.*/) || [""])[0]);
  fs.writeFileSync(path.join(T, "ipt.txt"), "*nat\nCOMMIT\n");
  st = deploy("status");
  /Пересылка VPN:\s+0 правил/.test(st.stdout) ? ok("magnat status: пересылки нет — «0»") : bad("magnat status без пересылки: " + (st.stdout.match(/Пересылка VPN:.*/) || [""])[0]);
  fs.unlinkSync(path.join(bin, "iptables-save"));

  // Новая папка в exclude — тоже не выкладывается (список берётся из _config.yml).
  fs.mkdirSync(path.join(REPO, "drafts")); fs.writeFileSync(path.join(REPO, "drafts/x.html"), "секрет");
  fs.appendFileSync(path.join(REPO, "_config.yml"), "  - drafts/\n"); git("add -A"); git("commit -q -m drafts");
  deploy(); cur() === head() && !live("drafts") ? ok("новая строка exclude в _config.yml — папка не выложена") : bad("exclude из _config.yml не сработал");

  // Битый коммит не выкладывается, и его не пробуют каждую минуту.
  const good = cur();
  fs.writeFileSync(path.join(REPO, "index.html"), "<!doctype html><title>404</title>"); git("commit -qam broken");
  r = deploy();
  cur() === good ? ok("index.html без Магната — НЕ выложен, остался прежний") : bad("битый коммит выложен!");
  fs.readFileSync(path.join(STATE, "skip-sha"), "utf8").trim() === head() ? ok("битый коммит запомнен, повторно не пробуется") : bad("skip-sha не записан");
  git("checkout -q HEAD~1 -- index.html"); git("commit -qam fixed");
  deploy(); cur() === head() ? ok("следующий коммит после битого — выложен") : bad("после битого коммита выкладка встала");

  // Пять версий, откат, и откаченное не возвращается.
  for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(REPO, "v.txt"), String(i)); git("add -A"); git(`commit -qm v${i}`); deploy(); }
  const rels = fs.readdirSync(path.join(BASE, "releases")).filter(x => !x.startsWith("."));
  rels.length === 5 ? ok("хранится ровно 5 выкладок") : bad("выкладок хранится " + rels.length);
  const last = cur(); r = deploy("rollback");
  cur() !== last && rels.includes(cur()) ? ok("magnat rollback — вернул предыдущую") : bad("откат не сработал: " + r.stdout + r.stderr);
  const back = cur(); deploy();
  cur() === back ? ok("таймер не вернул откаченный коммит") : bad("откаченный коммит выложен снова");
  fs.writeFileSync(path.join(REPO, "v.txt"), "new"); git("commit -qam after-rollback"); deploy();
  cur() === head() ? ok("новый коммит после отката — выложен") : bad("после отката выкладка встала");

  // Caddyfile из репозитория: сломанный не применяется; сайт лёг — возвращается прежний.
  const cf0 = fs.readFileSync(CF, "utf8");
  fs.appendFileSync(path.join(REPO, "server/Caddyfile"), "\nэто не конфиг {\n"); git("commit -qam badcf"); r = deploy();
  fs.readFileSync(CF, "utf8") === cf0 && /НЕ прошёл проверку/.test(r.stdout + r.stderr) ? ok("Caddyfile с ошибкой — не применён") : bad("сломанный Caddyfile применён: " + r.stdout + r.stderr);
  git("checkout -q HEAD~1 -- server/Caddyfile");
  fs.appendFileSync(path.join(REPO, "server/Caddyfile"), "\n# правка\n"); git("commit -qam cf2");
  r = deploy("deploy", { MAGNAT_HTTP_PORT: String(await freePort()) });
  fs.readFileSync(CF, "utf8") === cf0 && /возвращаю прежний/.test(r.stdout + r.stderr) ? ok("новый Caddyfile, а сайт не ответил — вернул прежний") : bad("Caddyfile не откатился: " + r.stdout + r.stderr);

  // ---- 2б. API входа: выкладка за сайтом -------------------------------------
  // Настоящий api.py из этого дерева, «служба» — двойник systemctl выше.
  console.log("\n2б. server/magnat.sh — API входа следует за выложенным коммитом");
  const health = async () => { try { return (await L.request(APORT, { path: "/api/health", timeout: 3000 })).json || {}; } catch (e) { return {}; } };
  const treeOf = (rev = "HEAD") => git(`rev-parse ${rev}:server/api`).stdout.trim().slice(0, 12);
  const apiCur = () => { try { return path.basename(fs.readlinkSync(path.join(AB, "current"))); } catch (e) { return ""; } };
  const mark = (f) => { try { return fs.readFileSync(path.join(STATE, f), "utf8").trim(); } catch (e) { return ""; } };
  const slog = () => { try { return fs.readFileSync(path.join(T, "systemctl.log"), "utf8"); } catch (e) { return ""; } };
  const restarts = () => (slog().match(/^restart magnat-api/gm) || []).length;
  const tmpLeft = () => fs.readdirSync(path.join(AB, "releases")).filter(x => x.startsWith("."));
  try {
    r = deploy();
    const untouched = !fs.existsSync(path.join(AB, "current")) && !restarts();
    fs.mkdirSync(path.join(AB, "releases"), { recursive: true });
    r = deploy(); const t1 = treeOf(); let h = await health();
    untouched && apiCur() === t1 && h.ok === true && h.v === t1 && mark("api-tree") === t1 && /API .* работает/.test(mark("api-last"))
      ? ok(`API не поставлен (шаг 4 установки) — не тронут; поставлен — встаёт из выложенного коммита без нового: current → ${t1}, /api/health отвечает этой версией`)
      : bad(`API не встал (до установки не тронут: ${untouched}): current=${apiCur()} health=${JSON.stringify(h)}\n    ` + (r.stdout + r.stderr).trim().slice(-400));
    h.open === false ? ok("API закрыт (open:false) — код получают только ящики владельца") : bad("API открыт: " + JSON.stringify(h));

    const apiPy = path.join(REPO, "server/api/api.py"), apiSrc = fs.readFileSync(apiPy, "utf8");
    // (б) синтаксическая ошибка — не переключать, сайт выложить
    fs.writeFileSync(apiPy, apiSrc + "\ndef broken(:\n"); git("commit -qam api-syntax");
    let n0 = restarts(); r = deploy(); const t2 = treeOf(); h = await health();
    cur() === head() && apiCur() === t1 && h.v === t1 && restarts() === n0 && mark("api-skip") === t2 && /не прошёл проверку/.test(mark("api-last"))
      && !fs.existsSync(path.join(AB, "releases", t2)) && !tmpLeft().length
      ? ok("API с синтаксической ошибкой — не прошёл проверку, не переключён, отвечает прежний, недоделанное убрано; сайт выложен")
      : bad(`сломанный API: сайт ${cur() === head()} current=${apiCur()} v=${h.v} skip=${mark("api-skip")} last=${mark("api-last")} releases=${fs.readdirSync(path.join(AB, "releases")).join(" ")}`);
    r = deploy();
    restarts() === n0 && apiCur() === t1 ? ok("через минуту его не пробуют снова (api-skip)") : bad("не прошедший API пробуется каждую минуту");

    // (в) проверку прошёл, но служба не поднимается — вернуть прежний
    fs.writeFileSync(apiPy, apiSrc.replace("def cmd_serve(pos, opts):\n", "def cmd_serve(pos, opts):\n    return 3\n")); git("commit -qam api-dead");
    n0 = restarts(); r = deploy(); const t3 = treeOf(); h = await health();
    cur() === head() && restarts() === n0 + 2 && apiCur() === t1 && h.v === t1 && mark("api-skip") === t3 && /не поднялся — вернул прежний/.test(mark("api-last"))
      ? ok("API прошёл проверку, но не поднялся — переключил, увидел, вернул прежний; сайт выложен")
      : bad(`мёртвый API: перезапусков ${restarts() - n0}, current=${apiCur()} v=${h.v} skip=${mark("api-skip")} last=${mark("api-last")}`);

    // (г) следующий хороший — применяется, перед ним копия базы
    fs.writeFileSync(apiPy, apiSrc + "\n# следующая версия\n"); git("commit -qam api-next");
    r = deploy(); const t4 = treeOf(); h = await health();
    apiCur() === t4 && h.v === t4 && mark("api-tree") === t4 && !mark("api-skip") ? ok("следующий хороший API — выложен, отметка «не прошёл» снята")
      : bad(`хороший API после плохого: current=${apiCur()} v=${h.v} skip=${mark("api-skip")}\n    ` + (r.stdout + r.stderr).trim().slice(-300));
    const pre = path.join(BK, "deploy", `pre-${t4}.db.gz`);
    let preOk = false; try { preOk = (fs.statSync(pre).mode & 0o777) === 0o600 && zlib.gunzipSync(fs.readFileSync(pre)).slice(0, 15).toString() === "SQLite format 3"; } catch (e) {}
    preOk ? ok("перед переключением — копия базы (gzip, 0600, настоящая SQLite)") : bad("нет копии базы перед переключением: " + pre);
    const rels = fs.readdirSync(path.join(AB, "releases"));
    rels.includes(t1) && rels.includes(t4) && rels.includes(t3) ? ok("прежние выпуски лежат — есть куда вернуться") : bad("выпуски: " + rels.join(" "));

    // (е) коммит без server/api — API не трогать
    git("rm -rq server/api"); git("commit -qm no-api");
    n0 = restarts(); r = deploy(); h = await health();
    cur() === head() && apiCur() === t4 && h.v === t4 && restarts() === n0 ? ok("коммит без server/api — сайт выложен, API не тронут") : bad("коммит без API тронул API: " + apiCur());
    git("checkout -q HEAD~1 -- server/api"); git("commit -qm api-back"); deploy();
  } catch (e) { bad("2б упал: " + (e.stack || e)); }

  // ---- 2в. почта для кодов, состояние, переустановка, копия базы -------------
  console.log("\n2в. magnat mail, magnat status, magnat upgrade, копия базы");
  const PASS = "Ab1xYz9QrT5uVw2sKp4L";   // как пароль приложения Mail.ru
  const smtp = await L.fakeSmtp(); smtp.allow("box@example.ru", PASS);
  const mail = (input) => spawnSync("bash", [path.join(ROOT, "server/magnat.sh"), "mail"], { input, encoding: "utf8", env, timeout: 60000 });
  const smtpEnv = () => fs.readFileSync(path.join(ETC, "smtp.env"));
  try {
    st = deploy("status");
    /Почта для кодов: не настроена → набери magnat mail/.test(st.stdout) ? ok("magnat status до настройки: «Почта для кодов: не настроена → набери magnat mail»")
      : bad("status без почты: " + (st.stdout.match(/Почта.*/) || ["нет строки"])[0]);
    let m = mail(`box@example.ru\n127.0.0.1\n${smtp.port}\n${PASS}\nsupport@example.ru\n`);
    const se = smtpEnv().toString(), mode = fs.statSync(path.join(ETC, "smtp.env")).mode & 0o777;
    m.status === 0 && /ПОЧТА РАБОТАЕТ — проверочное письмо ушло на support@example\.ru/.test(m.stdout) && mode === 0o600 && se.includes(`\nSMTP_PASS=${PASS}\n`) && se.includes("SMTP_USER=box@example.ru")
      ? ok("magnat mail: письмо ушло → ПОЧТА РАБОТАЕТ, smtp.env 0600 с паролем") : bad(`magnat mail (код ${m.status}, права ${mode.toString(8)}):\n    ` + (m.stdout + m.stderr).trim().slice(-500));
    const au = smtp.auths.filter(a => a.ok);
    au.length === 1 && au[0].user === "box@example.ru" && au[0].pass === PASS && smtp.to("support@example.ru").length === 1
      ? ok("ящик пустил по этому паролю, проверочное письмо — на адрес поддержки") : bad("SMTP: " + JSON.stringify(smtp.auths) + " писем " + smtp.mails.length);
    /^restart magnat-api$/m.test(slog().trim().split("\n").pop()) ? ok("после настройки API перезапущен (служба берёт smtp.env на старте)") : bad("API не перезапущен после magnat mail");
    const mailed = /ПОЧТА РАБОТАЕТ/.test(m.stdout) && au.length === 1;
    mailed && !(m.stdout + m.stderr).includes(PASS) ? ok("пароля нет в выводе magnat mail") : bad("пароль в выводе или почта не настроилась");
    const argv = ["runuser.log", "py.log", "systemctl.log"].map(f => { try { return fs.readFileSync(path.join(T, f), "utf8"); } catch (e) { return ""; } }).join("\n");
    mailed && /mailtest --creds - --to support@example\.ru/.test(argv) && !argv.includes(PASS)
      ? ok("пароля нет в аргументах программ (runuser, python, systemctl) — проверка получила его через stdin") : bad("пароль в аргументах или проверки не было");
    mailed && !fs.existsSync(path.join(ETC, "smtp.env.new")) ? ok("временного файла с паролем не осталось") : bad("остался smtp.env.new или почта не настроилась");
    st = deploy("status");
    /API входа:\s+работает ✅ версия \w{12}, вход закрыт/.test(st.stdout) && /Почта для кодов: настроена — box@example\.ru ✅/.test(st.stdout) && !st.stdout.includes(PASS)
      ? ok("magnat status: «API входа: работает ✅ … закрыт», «Почта для кодов: настроена» — и без пароля") : bad("status:\n    " + st.stdout.split("\n").filter(l => /API|Почта/.test(l)).join("\n    "));

    // не ушло — прежний smtp.env байт в байт
    const good = smtpEnv(); smtp.mode = "535";
    m = mail(`box@example.ru\n127.0.0.1\n${smtp.port}\nWrongPass12345\nsupport@example.ru\n`);
    m.status === 1 && /НЕ УШЛО: ящик не пустил: неверный пароль/.test(m.stdout) && /Прежние настройки не тронуты/.test(m.stdout) && smtpEnv().equals(good) && !fs.existsSync(path.join(ETC, "smtp.env.new"))
      ? ok("ящик не пустил (535) → «НЕ УШЛО: ящик не пустил…», прежний smtp.env байт в байт") : bad(`535: код ${m.status}\n    ` + (m.stdout + m.stderr).trim().slice(-300));
    smtp.mode = "ok";
    m = mail(`box@example.ru\n127.0.0.1\n${await freePort()}\n${PASS}\nsupport@example.ru\n`);
    m.status === 1 && /НЕ УШЛО: сервер не достучался до 127\.0\.0\.1:\d+ \(сеть\)/.test(m.stdout) && smtpEnv().equals(good)
      ? ok("сеть не пускает → «НЕ УШЛО: сервер не достучался…», прежний не тронут") : bad("сеть: " + (m.stdout + m.stderr).trim().slice(-300));
    m = mail("kod@yandex.ru\nпароль с пробелом\n");
    /не достучится до почты Яндекса/.test(m.stdout) && /НЕ УШЛО: это не похоже на пароль приложения/.test(m.stdout) && smtpEnv().equals(good)
      ? ok("ящик на Яндексе — честное предупреждение; не пароль приложения — не пробует, прежний не тронут") : bad("яндекс/пароль: " + m.stdout.slice(-300));
    m = mail("box@mail.ru\n");
    /НЕ УШЛО: это не похоже на пароль приложения/.test(m.stdout) && !/Сервер исходящей почты/.test(m.stdout) && smtpEnv().equals(good)
      ? ok("Mail.ru — сервер не спрашивает (smtp.mail.ru:465 сам)") : bad("mail.ru: " + m.stdout.slice(-300));

    // устаревший скрипт сервера
    const same = !/устарел/.test(deploy("status").stdout);
    fs.appendFileSync(SELF, "\n# старая копия\n"); st = deploy("status");
    same && /⚠ Скрипт сервера устарел — набери magnat upgrade/.test(st.stdout)
      ? ok("«⚠ Скрипт сервера устарел — набери magnat upgrade» — только когда скрипт отличается от выложенного") : bad(`«устарел»: при равном скрипте ${!same}, при другом ${/устарел/.test(st.stdout)}`);
    fs.copyFileSync(path.join(ROOT, "server/magnat.sh"), SELF);

    // копия базы раз в сутки: свежая и семь последних
    const BD = path.join(AS, "backup"); fs.mkdirSync(BD, { recursive: true });
    for (let i = 1; i <= 9; i++) { const f = path.join(BD, `magnat-2026-01-0${i}.db.gz`); fs.writeFileSync(f, "old"); fs.utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i)); }
    r = deploy("api-backup");
    const today = `magnat-${new Date().toISOString().slice(0, 10)}.db.gz`, left = fs.readdirSync(BD).sort();
    let bOk = false; try { bOk = (fs.statSync(path.join(BD, today)).mode & 0o777) === 0o600 && zlib.gunzipSync(fs.readFileSync(path.join(BD, today))).slice(0, 15).toString() === "SQLite format 3"; } catch (e) {}
    bOk && left.length === 7 && left.includes(today) && !left.includes("magnat-2026-01-03.db.gz") && left.includes("magnat-2026-01-04.db.gz")
      ? ok("копия базы раз в сутки: свежая (gzip, 0600, SQLite), хранится семь последних") : bad(`копия базы: ${left.join(" ")}\n    ` + (r.stdout + r.stderr).trim().slice(-300));
    st = deploy("status");
    /Копия базы:\s+\d\d\.\d\d \d\d:\d\d UTC ✅ \(всего 7/.test(st.stdout) ? ok("magnat status: «Копия базы: … ✅ (всего 7…)»") : bad("status копии: " + (st.stdout.match(/Копия базы.*/) || ["нет"])[0]);

    // переустановка — из ВЫЛОЖЕННОЙ версии, не из main
    if (process.getuid && process.getuid() === 0) {
      fs.appendFileSync(path.join(REPO, "server/install.sh"), "\n# новее выложенного\n"); git("commit -qam newer-install");
      const up = deploy("upgrade", { MAGNAT_MY_IP: "0.0.0.1" });
      let got = ""; try { got = fs.readFileSync(path.join(T, "setup/server/install.sh"), "utf8"); } catch (e) {}
      got && got === git(`show ${cur()}:server/install.sh`).stdout && !got.includes("новее выложенного") && /Не тот сервер/.test(up.stderr)
        ? ok("magnat upgrade — install.sh из выложенной версии, а не из main; замок «не тот сервер» — первым") : bad("upgrade:\n    " + (up.stdout + up.stderr).trim().slice(-300));
    } else console.log("  ⚠ пропуск magnat upgrade: нужен root");

    // (з) api.py — только через runuser
    if (process.getuid && process.getuid() === 0) {
      const rdT = (f) => { try { return fs.readFileSync(path.join(T, f), "utf8"); } catch (e) { return ""; } };
      const py = rdT("py.log").trim().split("\n").filter(Boolean), ru = rdT("runuser.log");
      const kinds = new Set(py.map(c => (c.split(" ")[2] || "")));
      py.length >= 6 && ["check", "backup", "mailtest"].every(k => kinds.has(k)) && py.every(c => ru.includes("-u magnat-api -- env -i ") && ru.split("\n").some(l => l.startsWith("-u magnat-api -- env -i ") && l.endsWith(c)))
        ? ok(`api.py ни разу не запущен от root мимо runuser -u magnat-api (${py.length} вызовов: ${[...kinds].join(", ")})`) : bad("вызовы api.py мимо runuser:\n    " + py.filter(c => !ru.includes(c)).join("\n    "));
    } else console.log("  ⚠ пропуск проверки runuser: тест не от root — runuser не нужен");
  } catch (e) { bad("2в упал: " + (e.stack || e)); }

  // ---- 2г. копия на Яндекс Диск, запросы людей о данных, оплата сервера --------
  // Настоящие openssl и curl; Диск — поддельный REST API (tests/lib.js: fakeDisk).
  // curl — через самописец: токен обязан идти из файла (-H @…), не аргументом.
  console.log("\n2г. magnat backup-setup / backup, magnat user, magnat paid-until");
  const disk = await L.fakeDisk();
  const PHRASE = "тихая-гавань-42-копии";
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${T}/curl.log"\nexec /usr/bin/curl "$@"\n`, { mode: 0o755 });
  const denv = { MAGNAT_DISK_API: disk.url, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
  const run = (args, input) => spawnSync("bash", [path.join(ROOT, "server/magnat.sh"), ...args], { input, encoding: "utf8", env: { ...env, ...denv }, timeout: 120000 });
  const rd = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
  const rdT = (f) => { const b = rd(path.join(T, f)); return b ? b.toString() : ""; };
  const dec = (buf) => { // как на новой машине: openssl enc -d … -pass file:backup.pass
    const r = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-pass", "file:" + path.join(ETC, "backup.pass")], { input: buf, maxBuffer: 64 << 20 });
    return r.status === 0 ? r.stdout : null;
  };
  const secretsIn = (x) => [disk.token, PHRASE, PASS].filter(v => String(x).includes(v));
  const subj = (x) => L.parseMail(x.raw).subject;
  const alerts = () => smtp.to("support@example.ru").filter(x => /^Магнат: /.test(subj(x)));
  const statusLine = (re) => (st.stdout.match(re) || ["нет строки"])[0];
  const noFiles = () => ["disk.auth", "backup.pass", "disk.auth.new", "backup.pass.new"].every(f => !fs.existsSync(path.join(ETC, f)));
  const BD2 = path.join(AS, "backup");
  try {
    st = run(["status"]);
    /Яндекс Диск:\s+копии не настроены \(по желанию, один раз: magnat backup-setup\)/.test(st.stdout) && /Место на диске: свободно \d+,\d ГБ/.test(st.stdout)
      && /Оплата сервера: срок не записан → magnat paid-until ДД\.ММ\.ГГГГ/.test(st.stdout)
      ? ok("magnat status до настройки: «Яндекс Диск: копии не настроены…», «Место на диске: свободно …», «Оплата сервера: срок не записан…»")
      : bad("status до настройки:\n    " + st.stdout.split("\n").filter(l => /Яндекс|Место|Оплата/.test(l)).join("\n    "));

    let m = run(["backup-setup"], `${disk.token}\n${PHRASE}\nдругая фраза 12345\n`);
    m.status === 1 && /НЕ УШЛО: фразы не совпали/.test(m.stdout) && noFiles() ? ok("фразы не совпали → «НЕ УШЛО», ничего не записано") : bad("фразы: " + (m.stdout + m.stderr).slice(-300));
    m = run(["backup-setup"], `не токен\n${PHRASE}\n${PHRASE}\n`);
    m.status === 1 && /НЕ УШЛО: это не похоже на токен/.test(m.stdout) && noFiles() && disk.reqs.length === 0 ? ok("не токен → «НЕ УШЛО» без единого запроса к Диску") : bad("не токен: " + m.stdout.slice(-300));
    m = run(["backup-setup"], `y0_chuzhoy_token_1234567890abcdef\n${PHRASE}\n${PHRASE}\n`);
    m.status === 1 && /НЕ УШЛО: Диск не пустил: токен неверный или истёк → magnat backup-setup\. Прежние настройки не тронуты/.test(m.stdout) && noFiles() && disk.reqs.length === 1 && disk.reqs[0].status === 401
      ? ok("чужой токен → Диск отвечает 401 → «НЕ УШЛО: Диск не пустил…», настройки не записаны") : bad("401: " + (m.stdout + m.stderr).slice(-300) + " " + JSON.stringify(disk.reqs));

    // настоящий токен: шифрует сегодняшнюю местную копию, выгружает, сверяет размер и md5
    disk.clear();
    m = run(["backup-setup"], `${disk.token}\n${PHRASE}\n${PHRASE}\n`);
    const doy = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000), slotName = `magnat-${String(doy % 14).padStart(2, "0")}.db.gz.enc`;
    const local = rd(path.join(BD2, `magnat-${new Date().toISOString().slice(0, 10)}.db.gz`));
    const up = disk.read(slotName), plain = up && dec(up);
    const authF = rd(path.join(ETC, "disk.auth")), passF = rd(path.join(ETC, "backup.pass"));
    const modes = ["disk.auth", "backup.pass"].map(f => { try { return fs.statSync(path.join(ETC, f)).mode & 0o777; } catch (e) { return -1; } });
    m.status === 0 && /КОПИЯ НА ДИСКЕ ЕСТЬ: magnat-\d\d\.db\.gz\.enc \(\d+ КБ\) в папке приложения на Яндекс Диске/.test(m.stdout) && up && local && plain && plain.equals(local)
      && authF && authF.toString() === `Authorization: OAuth ${disk.token}\n` && passF && passF.toString() === PHRASE + "\n" && modes.every(x => x === 0o600)
      ? ok(`magnat backup-setup: «КОПИЯ НА ДИСКЕ ЕСТЬ», слот ${slotName}; расшифровка фразой даёт байт в байт сегодняшнюю местную копию; disk.auth и backup.pass 0600`)
      : bad(`backup-setup (код ${m.status}): up=${!!up} plain=${!!(plain && local && plain.equals(local))} modes=${modes.map(x => x.toString(8))}\n    ` + (m.stdout + m.stderr).trim().slice(-400));
    up && local && !up.equals(local) && up.slice(0, 8).toString() === "Salted__" ? ok("на Диске лежит шифртекст (Salted__…), а не база") : bad("на Диске не шифртекст");
    const ups = disk.reqs.filter(r => r.path === "/v1/disk/resources/upload"), puts = disk.reqs.filter(r => r.path.startsWith("/upload/") && r.method === "PUT"), stats = disk.reqs.filter(r => r.path === "/v1/disk/resources" && r.method === "GET");
    ups.length === 1 && ups[0].authOk && ups[0].query.overwrite === "true" && ups[0].query.path === "app:/" + slotName && puts.length === 1 && puts[0].status === 201 && stats.length === 1 && stats[0].status === 200
      ? ok("Диск: адрес загрузки по токену (папка приложения, overwrite=true) → PUT → сверка размера и md5") : bad("запросы к Диску: " + JSON.stringify(disk.reqs));
    const outAll = m.stdout + m.stderr, argvAll = ["curl.log", "runuser.log", "py.log", "systemctl.log"].map(rdT).join("\n");
    !secretsIn(outAll).length && !secretsIn(argvAll).length && /-H @/.test(rdT("curl.log")) ? ok("токена и фразы нет ни в выводе, ни в аргументах curl/runuser/python — токен идёт файлом (-H @…)") : bad("секреты утекли: вывод " + secretsIn(outAll).length + ", аргументы " + secretsIn(argvAll).length);
    !fs.readdirSync(path.join(BK, "offsite")).length && !fs.existsSync(path.join(STATE, ".disk-resp")) ? ok("временного шифртекста и ответа Диска не осталось") : bad("остались временные файлы: " + fs.readdirSync(path.join(BK, "offsite")).join(" "));
    st = run(["status"]);
    /Яндекс Диск:\s+копия \d\d\.\d\d \d\d:\d\d UTC ✅ \(magnat-\d\d\.db\.gz\.enc, \d+ КБ, зашифрована; слотов 14\)/.test(st.stdout) && !secretsIn(st.stdout).length
      ? ok("magnat status: «Яндекс Диск: копия … ✅ (…, зашифрована; слотов 14)» — без секретов") : bad("status Диска: " + statusLine(/Яндекс Диск.*/));

    // ночь: magnat backup — слот перезаписан, копии старше 30 дней убраны, свежие на месте
    const oldPre = path.join(BK, "deploy", "pre-old.db.gz"), keepPre = path.join(BK, "deploy", "pre-new.db.gz");
    fs.writeFileSync(oldPre, "old"); fs.utimesSync(oldPre, new Date(2026, 0, 1), new Date(2026, 0, 1)); fs.writeFileSync(keepPre, "new");
    disk.clear(); m = run(["backup"]);
    m.status === 0 && disk.reqs.some(r => r.path.startsWith("/upload/") && r.status === 201) && !fs.existsSync(oldPre) && fs.existsSync(keepPre) && !fs.readdirSync(path.join(BK, "offsite")).length
      ? ok("magnat backup: слот на Диске перезаписан, копии старше 30 дней убраны, свежие на месте") : bad(`magnat backup: код ${m.status}, pre-old ${fs.existsSync(oldPre)}\n    ` + (m.stdout + m.stderr).slice(-300));

    // Диск сломался: первая ночь — отметка в статусе, вторая — письмо, третья — без повтора (сутки)
    disk.fail = 507; let n0 = alerts().length;
    m = run(["backup"]); st = run(["status"]);
    m.status === 1 && /Яндекс Диск:\s+копия НЕ ушла ❌ \d\d\.\d\d \d\d:\d\d UTC — на Диске нет места \(последняя удачная — \d\d\.\d\d \d\d:\d\d UTC\)/.test(st.stdout) && alerts().length === n0
      ? ok("Диск ответил 507 → «копия НЕ ушла ❌ … на Диске нет места (последняя удачная — …)», после первой ночи письма нет")
      : bad(`507: код ${m.status}, писем ${alerts().length - n0}\n    ` + statusLine(/Яндекс Диск.*/) + "\n    " + (m.stdout + m.stderr).slice(-200));
    m = run(["backup"]);
    const al = await smtp.wait(x => /не уходит 2 ночи подряд/.test(subj(x)), 5000);
    al && alerts().length === n0 + 1 && /^Магнат: Копия базы на Яндекс Диск не уходит 2 ночи подряд: на Диске нет места$/.test(subj(al))
      ? ok("вторая ночь подряд → письмо на адрес поддержки «Магнат: Копия базы на Яндекс Диск не уходит 2 ночи подряд: на Диске нет места»") : bad("письмо о Диске: " + (al ? subj(al) : "нет") + ", всего новых " + (alerts().length - n0));
    m = run(["backup"]);
    alerts().length === n0 + 1 ? ok("третья ночь — письмо не повторяется (не чаще раза в сутки на вид)") : bad("письмо повторилось: " + (alerts().length - n0));
    disk.fail = 0; m = run(["backup"]); st = run(["status"]);
    m.status === 0 && /Яндекс Диск:\s+копия \d\d\.\d\d \d\d:\d\d UTC ✅/.test(st.stdout) && !fs.existsSync(path.join(STATE, "offsite-fail"))
      ? ok("Диск ожил → копия ушла, ❌ снята, счёт ночей сброшен") : bad("после починки: " + statusLine(/Яндекс Диск.*/));

    // оплата сервера
    const fmt = (d) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
    const inDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
    const q = (x) => x.replace(/\./g, "\\.");
    m = run(["paid-until", "31.02.2026"]);
    m.status === 1 && /«31\.02\.2026» не похоже на дату — нужно ДД\.ММ\.ГГГГ/.test(m.stdout) && !fs.existsSync(path.join(ETC, "paid-until")) ? ok("magnat paid-until 31.02.2026 → не дата, ничего не записано") : bad("плохая дата: " + m.stdout);
    m = run(["paid-until", inDays(13)]); st = run(["status"]);
    m.status === 0 && new RegExp(`Оплата сервера: до ${q(inDays(13))} \\(осталось 13 дней\\) ✅`).test(st.stdout) && (fs.statSync(path.join(ETC, "paid-until")).mode & 0o777) === 0o600
      ? ok(`magnat paid-until ${inDays(13)} → «Оплата сервера: до … (осталось 13 дней) ✅», файл 0600`) : bad("paid-until 13: " + statusLine(/Оплата.*/) + " | " + m.stdout);
    n0 = alerts().length; m = run(["backup"]);
    alerts().length === n0 ? ok("за 13 дней до срока письма нет") : bad("письмо об оплате раньше времени: " + subj(alerts().at(-1)));
    m = run(["paid-until", inDays(2)]); st = run(["status"]); m = run(["backup"]);
    const pa = await smtp.wait(x => /^Магнат: Сервер оплачен до/.test(subj(x)), 5000);
    new RegExp(`Оплата сервера: до ${q(inDays(2))} — ⚠ осталось 2 дня, продли на RUVDS`).test(st.stdout) && pa && subj(pa) === `Магнат: Сервер оплачен до ${inDays(2)} — осталось 2 дня, продли на RUVDS`
      ? ok("за 2 дня: «⚠ осталось 2 дня, продли на RUVDS» и письмо «Магнат: Сервер оплачен до … — осталось 2 дня, продли на RUVDS»") : bad("2 дня: " + statusLine(/Оплата.*/) + " письмо: " + (pa ? subj(pa) : "нет"));
    m = run(["paid-until", inDays(-1)]); st = run(["status"]);
    new RegExp(`Оплата сервера: срок ${q(inDays(-1))} ПРОШЁЛ ❌ — продли на RUVDS, иначе машину снесут`).test(st.stdout) ? ok("срок прошёл → «ПРОШЁЛ ❌ — продли на RUVDS, иначе машину снесут»") : bad("прошёл: " + statusLine(/Оплата.*/));

    // запросы людей о данных: аккаунт появляется после входа по коду (API закрыт — код только ящикам владельца)
    const ORIGIN = "https://magnat-planer.ru", EM = "support@example.ru", nBefore = smtp.to(EM).length;
    let rr = await L.postJson(APORT, "/api/code", { email: EM, purpose: "login" }, { origin: ORIGIN });
    const code = rr.status === 200 ? await L.waitCode(smtp, EM, { kind: "login", after: nBefore }) : null;
    rr = code ? await L.postJson(APORT, "/api/login", { email: EM, code, dev: "d_" + crypto.randomBytes(8).toString("hex"), label: "Проверка" }, { origin: ORIGIN }) : rr;
    rr.status === 200 && code ? ok("вход по коду — аккаунт на сервере появился") : bad("вход не удался: " + rr.status + " " + rr.text + " код " + code);
    m = run(["user", "show", EM]);
    m.status === 0 && /^Аккаунт есть: создан \d{4}-\d\d-\d\d, последний заход/m.test(m.stdout) && /Устройства \(1\)/.test(m.stdout) && !m.stdout.includes(EM)
      ? ok("magnat user show — «Аккаунт есть: создан …», устройства, без самого адреса в выводе") : bad("user show: " + (m.stdout + m.stderr).slice(-200));
    m = run(["user", "show", "nikogo@example.ru"]);
    m.status === 0 && /^Аккаунта с этим адресом нет\.$/m.test(m.stdout) ? ok("magnat user show чужого адреса — «Аккаунта с этим адресом нет.»") : bad("user show nobody: " + m.stdout);
    m = run(["user", "show", "не адрес"]);
    m.status === 1 && /не похоже на адрес почты/.test(m.stdout) ? ok("magnat user show «не адрес» — отказ без запуска api.py") : bad("user show bad: " + m.stdout);
    m = run(["user", "export", EM]);
    const ex = await smtp.wait(x => x.to.map(t => t.toLowerCase()).includes(EM) && /Твои данные в Магнате/.test(subj(x)), 5000);
    m.status === 0 && /ВЫГРУЗКА ОТПРАВЛЕНА: письмо с данными ушло на support@example\.ru — только на этот адрес/.test(m.stdout) && ex && /magnat-\d{4}-\d\d-\d\d\.json/.test(ex.raw) && ex.to.length === 1 && !secretsIn(m.stdout + m.stderr).length
      ? ok("magnat user export — «ВЫГРУЗКА ОТПРАВЛЕНА», письмо «Твои данные в Магнате» с magnat-<дата>.json только на этот адрес") : bad(`user export (код ${m.status}): ${(m.stdout + m.stderr).slice(-200)} письмо: ${ex ? "есть" : "нет"}`);
    m = run(["user", "delete", EM], "нет\n");
    let again = run(["user", "show", EM]);
    // подсказка «Напиши ДА:» — от read -p, он печатает её только терминалу; здесь stdin — труба
    m.status === 1 && /Удалить аккаунт support@example\.ru с сервера\?/.test(m.stdout) && /Отмена — ничего не удалено/.test(m.stdout) && /Аккаунт есть/.test(again.stdout)
      ? ok("magnat user delete без «ДА» — вопрос, отмена, аккаунт на месте") : bad(`delete без ДА (код ${m.status}, сигнал ${m.signal}): stdout «${m.stdout.slice(-120)}» stderr «${m.stderr.slice(-200)}»`);
    m = run(["user", "delete", EM], "ДА\n");
    again = run(["user", "show", EM]);
    m.status === 0 && /Аккаунт удалён, надгробие записано/.test(m.stdout) && /Аккаунта с этим адресом нет/.test(again.stdout) ? ok("magnat user delete с «ДА» — «Аккаунт удалён, надгробие записано», аккаунта больше нет") : bad("delete ДА: " + (m.stdout + m.stderr).slice(-300));
    const py2 = rdT("py.log").trim().split("\n").filter(c => / (user|alert) /.test(c)), ru2 = rdT("runuser.log");
    py2.length >= 6 && py2.every(c => ru2.split("\n").some(l => l.startsWith("-u ") && l.endsWith(c))) && !/(user export|alert) .*(SMTP_PASS|OAuth)/.test(rdT("py.log"))
      ? ok(`api.py user/alert — ${py2.length} вызовов, все через runuser, пароль почты только через stdin`) : bad("вызовы user/alert мимо runuser или с паролем: " + py2.length);
  } catch (e) { bad("2г упал: " + (e.stack || e)); }

  // ---- 2д. ключи Платеги, ручная выдача доступа, оплаты месяца, строка «Платега:» ---
  // Настоящий api.py (служба — двойник systemctl), Платега — поддельная, в этом же
  // процессе: по её журналу видно, с какими ключами api.py к ней пришёл.
  console.log("\n2д. magnat platega / grant / orders, строка «Платега:» в magnat status");
  const MID = "3fa85f64-5717-4562-b3fc-2c963f66afa6", SEC = "pk_Live-8f3Q2zX9!vR7#mT4@wL6";
  const PEF = path.join(ETC, "platega.env"), XENV = path.join(T, "api-extra.env"), SITE = "https://magnat-planer.ru";
  const pg = { reqs: [], status: "PENDING", tx: crypto.randomUUID() };
  const pgSrv = http.createServer((q, s) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
    const keysOk = q.headers["x-merchantid"] === MID && q.headers["x-secret"] === SEC;
    pg.reqs.push({ method: q.method, url: q.url, keysOk, body: b });
    const send = (code, o) => { s.writeHead(code, { "Content-Type": "application/json" }); s.end(JSON.stringify(o)); };
    if (!keysOk) return send(401, { error: "unauthorized" });
    if (q.method === "POST" && q.url === "/v2/transaction/process") return send(200, { transactionId: pg.tx, status: "PENDING", redirect: "https://pay.platega.test/" + pg.tx });
    if (q.method === "GET" && q.url === "/transaction/" + pg.tx) return send(200, { id: pg.tx, status: pg.status });
    send(404, { error: "not found" });
  }); });
  await new Promise(res => pgSrv.listen(0, "127.0.0.1", res));
  const prun = (args, input, extra = {}) => spawnSync("bash", [path.join(ROOT, "server/magnat.sh"), ...args], { input, encoding: "utf8", env: { ...env, ...extra }, timeout: 120000 });
  const pfile = () => { try { return fs.readFileSync(PEF, "utf8"); } catch (e) { return null; } };
  const pmode = () => { try { return fs.statSync(PEF).mode & 0o777; } catch (e) { return -1; } };
  const allLogs = () => ["runuser.log", "py.log", "systemctl.log", "curl.log", "api.log"].map(rdT).join("\n");
  const payLine = (x) => (x.match(/^Платега:.*$/m) || ["нет строки «Платега:»"])[0];
  const esc = (x) => x.replace(/[.+()]/g, "\\$&");
  const msk = (days) => { const d = new Date(Date.now() + 3 * 3600e3 + days * 86400e3); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`; };
  try {
    // служба стартовала с пустым platega.env, как после install.sh (2б и дальше)
    let h = await health();
    h.ok === true && h.pay === false && h.payKeys === false && pfile() === "" && pmode() === 0o600
      ? ok("служба стартует с пустым platega.env (0600): /api/health — ok, pay:false, payKeys:false")
      : bad("служба с пустым platega.env: " + JSON.stringify(h) + " файл " + JSON.stringify(pfile()) + " права " + pmode().toString(8));
    st = prun(["status"]);
    /^Платега:\s+ключи не заданы → magnat platega · оплата выключена · ждут оплаты 0 · оплат за месяц 0 на 0 ₽ · последнее уведомление не было$/m.test(st.stdout)
      ? ok("magnat status без ключей: «Платега: ключи не заданы → magnat platega · оплата выключена · ждут оплаты 0 · …»") : bad("status без ключей: " + payLine(st.stdout));

    // плохой формат — отказ, файл и служба не тронуты; введённое (мог быть секрет) не повторяется
    let n0 = restarts();
    const noId = /НЕ УШЛО: это не похоже на ID мерчанта/, noSec = /НЕ УШЛО: это не похоже на секретный ключ/;
    // [что введено, какой отказ, чего не должно быть в выводе]
    const refuse = [["pk!Live#9Qx\n", noId, "pk!Live#9Qx"], [`${MID}\nс пробелом 12345\n`, noSec, "с пробелом"],
      [`${MID}\nkey"with'quote\n`, noSec, "quote"], [`${MID}\nshort\n`, noSec, "short"], [`${MID}\n\n`, noSec, MID],
      [`${MID}\n${MID}\n`, /НЕ УШЛО: секрет совпал с ID мерчанта/, MID]];
    const wrong = refuse.map(([inp, re, echo]) => [inp, prun(["platega"], inp), re, echo]).filter(([inp, m, re, echo]) =>
      !(m.status === 1 && re.test(m.stdout) && /Прежние ключи не тронуты/.test(m.stdout) && !m.stdout.includes(echo)));
    !wrong.length && pfile() === "" && restarts() === n0 && !fs.existsSync(PEF + ".new")
      ? ok("плохой формат (секрет вместо ID, пробел или кавычка в секрете, короткий, пустой, секрет = ID) — «НЕ УШЛО», введённое не повторено, файл не тронут, API не перезапускался")
      : bad("плохой формат: " + wrong.map(([inp, m]) => JSON.stringify(inp) + " → код " + m.status + " " + m.stdout.trim().slice(-160)).join(" | ") + ` файл ${JSON.stringify(pfile())} перезапусков ${restarts() - n0}`);
    const use = prun(["platega", "on"]);
    use.status === 2 && pfile() === "" ? ok("magnat platega с чужим словом — подсказка, ничего не тронуто") : bad("magnat platega on: код " + use.status);

    // настоящие ключи (служба — с оплатой и поддельной Платегой)
    fs.writeFileSync(XENV, `MAGNAT_PAYMENTS=1\nMAGNAT_PLATEGA_URL=http://127.0.0.1:${pgSrv.address().port}\n`);
    n0 = restarts();
    let m = prun(["platega"], `${MID}\n  ${SEC}  \n`, { MAGNAT_DOMAIN: "magnat-planer.ru" });
    h = await health();
    m.status === 0 && /^КЛЮЧИ ПРИНЯТЫ: записаны в .*platega\.env \(0600\), API их видит\.$/m.test(m.stdout) && pfile() === `PLATEGA_MERCHANT_ID=${MID}\nPLATEGA_SECRET=${SEC}\n`
      && pmode() === 0o600 && !fs.existsSync(PEF + ".new") && restarts() === n0 + 1 && h.payKeys === true && h.pay === true
      ? ok("magnat platega: platega.env 0600 ровно с ID и секретом (пробелы по краям сняты), API перезапущен и видит ключи (payKeys:true)")
      : bad(`magnat platega (код ${m.status}, права ${pmode().toString(8)}, перезапусков ${restarts() - n0}, health ${JSON.stringify(h)}):\n    ` + (m.stdout + m.stderr).trim().slice(-400));
    /^ {4}https:\/\/magnat-planer\.ru\/api\/platega\/callback$/m.test(m.stdout) && /Callback URL/.test(m.stdout) && /Оплата на сайте включена/.test(m.stdout)
      ? ok("magnat platega печатает адрес уведомлений для кабинета: https://magnat-planer.ru/api/platega/callback") : bad("адреса уведомлений нет: " + m.stdout.trim().slice(-300));
    const keyed = /КЛЮЧИ ПРИНЯТЫ/.test(m.stdout);
    keyed && !(m.stdout + m.stderr).includes(SEC) && !allLogs().includes(SEC)
      ? ok("секрета нет ни в выводе magnat platega, ни в аргументах программ (runuser, python, systemctl, curl), ни в журнале API")
      : bad("секрет утёк или ключи не записались: вывод " + (m.stdout + m.stderr).includes(SEC) + ", аргументы и журнал " + allLogs().includes(SEC));

    // оплата насквозь: счёт этими ключами → колбэк → статус перечитан → оплачено
    const TERMS = (fs.readFileSync(path.join(ROOT, "server/api/api.py"), "utf8").match(/^TERMS_ED = '([^']+)'/m) || [])[1];
    const BUYER = "buyer@example.ru";
    const consent = "Оплачиваю доступ к Магнату на 30 дней — 299 ₽, разово, без автосписаний. Принимаю пользовательское соглашение, с политикой конфиденциальности ознакомлен.";
    const co = await L.postJson(APORT, "/api/checkout", { plan: "month", email: BUYER, telegram: "", consent, terms: TERMS }, { origin: SITE });
    const made = pg.reqs.find(x => x.method === "POST");
    co.status === 200 && co.json && co.json.ok === true && co.json.url === "https://pay.platega.test/" + pg.tx && made && made.keysOk
      ? ok("api.py берёт ключи из файла magnat platega: счёт у Платеги создан этими ID и секретом") : bad("оформление: " + co.status + " " + co.text + " " + JSON.stringify(pg.reqs.map(x => [x.method, x.url, x.keysOk])));
    pg.status = "CONFIRMED";
    const cb = await L.request(APORT, { method: "POST", path: "/api/platega/callback", body: { id: pg.tx, status: "CONFIRMED" }, headers: { "X-MerchantId": MID, "X-Secret": SEC } });
    const ord = co.json && co.json.o ? await L.postJson(APORT, "/api/order", { o: co.json.o }, { origin: SITE }) : {};
    cb.status === 200 && ord.json && ord.json.status === "paid" ? ok("колбэк с этими ключами → статус перечитан у Платеги → заказ оплачен")
      : bad("колбэк: " + cb.status + " " + cb.text + " заказ " + JSON.stringify(ord.json));
    st = prun(["status"]);
    /^Платега:\s+ключи заданы · оплата включена · ждут оплаты 0 · оплат за месяц 1 на 299 ₽ · последнее уведомление \d\d\.\d\d \d\d:\d\d UTC$/m.test(st.stdout) && !st.stdout.includes(SEC) && !st.stdout.includes(BUYER)
      ? ok("magnat status: «Платега: ключи заданы · оплата включена · ждут оплаты 0 · оплат за месяц 1 на 299 ₽ · последнее уведомление … UTC» — без секрета и адресов")
      : bad("status с оплатой: " + payLine(st.stdout));

    // оплаты месяца для чеков
    const ym = new Date().toISOString().slice(0, 7);
    m = prun(["orders"]);
    m.status === 0 && /^\d\d\.\d\d\.\d{4} \d\d:\d\d UTC · 299 ₽ · месяц · заказ \d+ · b•••@example\.ru$/m.test(m.stdout)
      && new RegExp(`^Итого за ${ym}: 1 оплата на 299 ₽\\.$`, "m").test(m.stdout) && !m.stdout.includes(BUYER)
      ? ok("magnat orders: «ДД.ММ.ГГГГ ЧЧ:ММ UTC · 299 ₽ · месяц · заказ N · b•••@example.ru» и итог — без полного адреса")
      : bad(`magnat orders (код ${m.status}): ` + (m.stdout + m.stderr).trim().slice(-300));
    const om = prun(["orders", "2026-13"]), oe = prun(["orders", "2001-01"]);
    om.status === 1 && /не похоже на месяц — нужно ГГГГ-ММ/.test(om.stdout) && oe.status === 0 && /^За 2001-01 оплат нет\.$/m.test(oe.stdout)
      ? ok("magnat orders 2026-13 — «не похоже на месяц»; 2001-01 — «За 2001-01 оплат нет.»") : bad("orders месяц: " + om.stdout + " | " + oe.stdout);

    // ручная выдача: на настоящем api.py, срок — к остатку
    const grants = () => (rdT("py.log").match(/ grant /g) || []).length, g0 = grants();
    const badG = [[["grant"], 2], [["grant", "не адрес", "30"], 1], [["grant", "gift@example.ru", "0"], 1], [["grant", "gift@example.ru", "-5"], 1],
      [["grant", "gift@example.ru", "3661"], 1], [["grant", "gift@example.ru", "30дней"], 1]].filter(([a, code]) => prun(a).status !== code);
    !badG.length && grants() === g0 ? ok("magnat grant без адреса, с «не адресом», 0, -5, 3661 или «30дней» — отказ, api.py не запускался")
      : bad("плохой grant пропущен: " + JSON.stringify(badG) + " вызовов api.py " + (grants() - g0));
    m = prun(["grant", "Gift@Example.ru", "30"]);
    let us = prun(["user", "show", "gift@example.ru"]);
    m.status === 0 && new RegExp(`^ДОСТУП ВЫДАН: gift@example\\.ru — до ${esc(msk(30))} \\(\\+30 дней к остатку, заказ на 0 ₽\\)\\.$`, "m").test(m.stdout)
      && new RegExp(`^Доступ: до ${esc(msk(30))}, действует\\.$`, "m").test(us.stdout) && /вручную · 0 ₽ · выдан вручную/.test(us.stdout)
      ? ok(`magnat grant gift@example.ru 30 — «ДОСТУП ВЫДАН: … до ${msk(30)}»; user show: «Доступ: до ${msk(30)}, действует», заказ на 0 ₽`)
      : bad(`grant (код ${m.status}): ${(m.stdout + m.stderr).trim().slice(-200)}\n    user show: ${us.stdout.trim().slice(-300)}`);
    m = prun(["grant", BUYER, "10"]); us = prun(["user", "show", BUYER]);
    m.status === 0 && new RegExp(`^Доступ: до ${esc(msk(40))}, действует\\.$`, "m").test(us.stdout) && /месяц · 299 ₽ · оплачен/.test(us.stdout)
      ? ok(`оплатил 30 дней + magnat grant 10 — доступ до ${msk(40)}: дни прибавились к остатку`) : bad("grant к остатку: " + us.stdout.trim().slice(-300));
    const pyPay = rdT("py.log").trim().split("\n").filter(c => / (grant|orders|stats) /.test(c)), ruPay = rdT("runuser.log").split("\n");
    pyPay.length >= 6 && pyPay.every(c => ruPay.some(l => l.startsWith("-u ") && l.endsWith(c)))
      ? ok(`api.py grant/orders/stats — ${pyPay.length} вызовов, все через runuser`) : bad("grant/orders/stats мимо runuser: " + pyPay.length);

    // magnat platega off — файл пуст (не удалён: без него служба не стартует), ключей у API нет
    n0 = restarts();
    m = prun(["platega", "off"]); h = await health(); st = prun(["status"]);
    const off = await L.postJson(APORT, "/api/checkout", { plan: "month", email: BUYER, telegram: "", consent, terms: TERMS }, { origin: SITE });
    m.status === 0 && /^КЛЮЧИ СТЁРТЫ/m.test(m.stdout) && pfile() === "" && pmode() === 0o600 && restarts() === n0 + 1 && h.ok === true && h.payKeys === false
      && /^Платега:\s+ключи не заданы → magnat platega · оплата включена · ждут оплаты 0 · оплат за месяц 1 на 299 ₽/m.test(st.stdout)
      && off.json && off.json.err === "pay_off"
      ? ok("magnat platega off — platega.env пуст (0600, на месте), API перезапущен без ключей, оформление отвечает pay_off, оплаты месяца в status целы")
      : bad(`platega off (код ${m.status}, файл ${JSON.stringify(pfile())}, health ${JSON.stringify(h)}, checkout ${off.text}):\n    ` + (m.stdout + m.stderr).trim().slice(-300) + "\n    " + payLine(st.stdout));
  } catch (e) { bad("2д упал: " + (e.stack || e)); }
  fs.rmSync(XENV, { force: true });
  pgSrv.close();
  await disk.close();
  await smtp.close();

  // ---- 3. Caddy ------------------------------------------------------------
  console.log("\n3. Caddy с server/Caddyfile");
  const P = await freePort(), PW = await freePort(), PA = await freePort();
  const cenv = { ...process.env, MAGNAT_SITE: `http://127.0.0.1:${P}`, MAGNAT_WWW: `http://127.0.0.1:${PW}`, MAGNAT_ROOT: path.join(BASE, "current"),
    MAGNAT_ADMIN: `localhost:${PA}`, XDG_DATA_HOME: path.join(T, "xdg"), XDG_CONFIG_HOME: path.join(T, "xdg") };
  const caddy = spawn(CADDY, ["run", "--config", path.join(ROOT, "server/Caddyfile"), "--adapter", "caddyfile"], { env: cenv, stdio: ["ignore", "ignore", "pipe"] });
  let clog = ""; caddy.stderr.on("data", d => clog += d);
  try {
    if (!(await waitPort(P))) throw new Error("Caddy не поднялся: " + clog.slice(-600));
    // Тот же Caddyfile, применённый выкладкой «на живую»: сайт отвечает — остаётся.
    fs.appendFileSync(path.join(REPO, "server/Caddyfile"), "\n# правка 2\n"); git("commit -qam cf3");
    r = deploy("deploy", { MAGNAT_HTTP_PORT: String(P) });
    fs.readFileSync(CF, "utf8") !== cf0 && /применён Caddyfile/.test(r.stdout) ? ok("новый Caddyfile, сайт отвечает — применён") : bad("рабочий Caddyfile не применён: " + r.stdout + r.stderr);
    fs.readFileSync(path.join(T, "systemctl.log"), "utf8").includes("reload caddy") ? ok("после замены Caddyfile — systemctl reload caddy") : bad("reload caddy не звали");

    const home = await get(P, "/", { "Accept-Encoding": "gzip" });
    home.status === 200 ? ok("/ → 200") : bad("/ → " + home.status);
    const need = { "strict-transport-security": /max-age=63072000/, "x-content-type-options": /^nosniff$/, "referrer-policy": /strict-origin/,
      "x-frame-options": /^DENY$/, "cross-origin-opener-policy": /same-origin/, "permissions-policy": /camera=\(\)/,
      "content-security-policy": /default-src 'self'.*connect-src 'self'.*frame-ancestors 'none'/, "cache-control": /^no-cache$/, "content-encoding": /gzip/ };
    const miss = Object.entries(need).filter(([k, re]) => !re.test(home.h[k] || ""));
    miss.length ? bad("заголовки не те: " + miss.map(([k]) => k + "=" + (home.h[k] || "нет")).join("; ")) : ok("заголовки безопасности, no-cache и сжатие — на месте");
    !home.h.server ? ok("заголовка Server нет") : bad("Server: " + home.h.server);
    // приложение (с 08.10.2026 — app.html) тоже всегда сверяется с сервером: иначе клиент застрял бы на старой версии
    const appH = await get(P, "/app.html");
    appH.status === 200 && /^no-cache$/.test(appH.h["cache-control"] || "") ? ok("/app.html → 200, no-cache") : bad("/app.html → " + appH.status + " " + appH.h["cache-control"]);
    const icon = await get(P, "/icon.png");
    /max-age=86400/.test(icon.h["cache-control"] || "") ? ok("картинки кэшируются на сутки") : bad("icon.png cache-control: " + icon.h["cache-control"]);
    // Второй замок: служебное, даже если оно попало в папку, — 404.
    fs.writeFileSync(path.join(BASE, "current", "CLAUDE.md"), "внутреннее");
    const hid = [];
    for (const p of ["/CLAUDE.md", "/README.md", "/tests/run.js", "/server/install.sh", "/_config.yml", "/CNAME", "/.git/config", "/.gitignore"]) {
      const x = await get(P, p); if (x.status !== 404) hid.push(p + "→" + x.status);
    }
    hid.length ? bad("служебное отдаётся: " + hid.join(", ")) : ok("служебное — 404, даже лежащее в папке сайта");
    fs.unlinkSync(path.join(BASE, "current", "CLAUDE.md"));
    const miss404 = await get(P, "/nety-takoy-stranicy");
    miss404.status === 302 && miss404.h.location === "/" ? ok("несуществующая страница → на главную") : bad("404 → " + miss404.status + " " + miss404.h.location);
    const www = await get(PW, "/app.html?x=1");
    www.status === 301 && www.h.location === "https://magnat-planer.ru/app.html?x=1" ? ok("www → https://magnat-planer.ru с тем же путём") : bad("www → " + www.status + " " + www.h.location);

    // ---- 3б. /api через Caddy ------------------------------------------------
    console.log("\n3б. /api через Caddy: прокси, заголовки, медленное тело, 413 и 503 ответом JSON");
    {
      const seen = [];
      const stub = http.createServer((q, s) => { const at = Date.now(); let n = 0; q.on("data", d => n += d.length);
        q.on("end", () => { seen.push({ url: q.url, at, xff: q.headers["x-forwarded-for"], n, mid: q.headers["x-merchantid"], sec: q.headers["x-secret"], origin: q.headers.origin });
          s.writeHead(200, { "Content-Type": "application/json", "Server": "stub-api", "Cache-Control": "no-store" }); s.end('{"ok":true,"stub":1}'); }); });
      await new Promise(res => stub.listen(0, "127.0.0.1", res));
      let C;
      try {
        C = await L.startCaddy({ root: path.join(BASE, "current"), api: stub.address().port });
        const pr = await L.request(C.port, { method: "POST", path: "/api/me", body: { a: 1 }, headers: { "X-Forwarded-For": "6.6.6.6" } });
        const missH = Object.entries(need).filter(([k, re]) => !["cache-control", "content-encoding"].includes(k) && !re.test(pr.h[k] || ""));
        pr.status === 200 && pr.json && pr.json.stub === 1 && !missH.length && !pr.h.server && pr.h["cache-control"] === "no-store"
          ? ok("POST /api/me → API: заголовки безопасности (HSTS, CSP…) на месте, Server нет, Cache-Control: no-store")
          : bad(`/api через Caddy: ${pr.status} server=${pr.h.server} cache=${pr.h["cache-control"]} нет: ${missH.map(([k]) => k).join(",")}`);
        seen.length && seen[seen.length - 1].xff === "127.0.0.1" ? ok("подделанный X-Forwarded-For до API не доходит — Caddy пишет настоящий адрес")
          : bad("X-Forwarded-For у API: " + (seen[seen.length - 1] || {}).xff);
        const body = '{"doc":"' + "x".repeat(4000) + '"}', n0 = seen.length, t0 = Date.now();
        const head = `POST /api/sync HTTP/1.1\r\nHost: 127.0.0.1:${C.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
        const sr = await L.rawHttp(C.port, [head + body.slice(0, 100), body.slice(100)], { gap: 1500, timeout: 15000 });
        const hit = seen[n0];
        hit && hit.at - t0 >= 1300 && hit.n === body.length && / 200 /.test(sr.data.split("\r\n")[0])
          ? ok(`медленное тело Caddy дочитывает сам: API получил запрос через ${hit.at - t0} мс, сразу целиком`)
          : bad(`медленное тело ушло в API раньше, чем пришло: через ${hit ? hit.at - t0 : "-"} мс, байт ${hit ? hit.n : "-"}`);
        // колбэк Платеги: POST без Origin и cookie, ключи — в заголовках, тело до 16 КБ (предел api.py для него)
        const cbBody = JSON.stringify({ id: "3fa85f64-0000-4000-8000-000000000000", status: "CONFIRMED", pad: "x".repeat(16300) }), n1 = seen.length;
        const cbr = await L.request(C.port, { method: "POST", path: "/api/platega/callback", body: cbBody, headers: { "Content-Type": "application/json", "X-MerchantId": "m-1", "X-Secret": "s-1" } });
        const hcb = seen[n1];
        cbBody.length <= 16384 && cbBody.length > 16000 && cbr.status === 200 && hcb && hcb.url === "/api/platega/callback" && hcb.n === cbBody.length && hcb.mid === "m-1" && hcb.sec === "s-1" && !hcb.origin
          ? ok(`колбэк Платеги через Caddy: POST без Origin доходит до API целиком (${cbBody.length} байт) с X-MerchantId и X-Secret`)
          : bad(`колбэк через Caddy: ${cbr.status} ${JSON.stringify(hcb && { ...hcb, at: undefined })}`);
        const q = (o) => L.request(C.port, o).catch(e => ({ status: 0, text: String(e.message), h: {} }));
        const big = await q({ method: "POST", path: "/api/sync", body: Buffer.alloc(3 << 20, 97), headers: { "Content-Type": "application/json" } });
        const hid = await q({ path: "/server/api/api.py" });
        big.status === 413 && big.text === '{"ok":false,"err":"big"}' && /application\/json/.test(big.h["content-type"] || "") && !big.h.server && hid.status === 404
          ? ok("тело 3 МБ → 413 {\"ok\":false,\"err\":\"big\"} (JSON, без Server); /server/api/api.py — по-прежнему 404")
          : bad(`3 МБ → ${big.status} ${big.text.slice(0, 80)} server=${big.h.server}; /server/api/api.py → ${hid.status}`);
        await C.restart({ api: null });
        const dn = await q({ method: "POST", path: "/api/me", body: { a: 1 } });
        const miss = await q({ path: "/nety-takoy-stranicy" });
        dn.status === 503 && dn.text === '{"ok":false,"err":"down"}' && /application\/json/.test(dn.h["content-type"] || "") && !dn.h.server && !dn.h.location
          && miss.status === 302 && miss.h.location === "/"
          ? ok("API не отвечает → 503 {\"ok\":false,\"err\":\"down\"} (JSON, не переадресация, без Server); пропавшая страница сайта — как была, на главную")
          : bad(`API выключен → ${dn.status} ${dn.text.slice(0, 80)} ${dn.h.location || ""}; нет страницы → ${miss.status}`);
        // настоящий api.py за этим Caddy
        const AP = await freePort();
        await C.restart({ api: AP });
        const A2 = await L.startApi({ port: AP, origin: C.origin, smtp: null });
        const me = await L.postJson(C.port, "/api/me", {}, { origin: C.origin });
        me.status === 200 && me.json && me.json.ok === true && /max-age=63072000/.test(me.h["strict-transport-security"] || "") && /connect-src 'self'/.test(me.h["content-security-policy"] || "") && !me.h.server
          ? ok("настоящий api.py за Caddy: POST /api/me → 200 JSON с HSTS и CSP, без Server") : bad(`api.py за Caddy: ${me.status} ${me.text.slice(0, 120)}`);
        const hh = await L.request(C.port, { path: "/api/health" });
        hh.status === 404 ? ok("/api/health снаружи — 404 (видно только с самой машины)") : bad("/api/health через Caddy → " + hh.status);
        // тот же api.py с оплатой: колбэк приходит без Origin — Caddy его не режет, ключи сверяет api.py
        const pf = path.join(T, "platega-3b.env");
        fs.writeFileSync(pf, "PLATEGA_MERCHANT_ID=m-3b-merchant\nPLATEGA_SECRET=s3b-Secret_01\n", { mode: 0o600 });
        await A2.restart({ MAGNAT_PAYMENTS: "1", MAGNAT_PLATEGA_FILE: pf });
        const hook = (sec) => L.request(C.port, { method: "POST", path: "/api/platega/callback", body: { id: "3fa85f64-0000-4000-8000-000000000001", status: "CONFIRMED" },
          headers: { "X-MerchantId": "m-3b-merchant", "X-Secret": sec } });
        const cbBad = await hook("wrong-secret"), cbOk = await hook("s3b-Secret_01");
        cbBad.status === 403 && cbBad.json && cbBad.json.err === "origin" && cbOk.status === 200 && cbOk.json && cbOk.json.ok === true && /callback unknown/.test(A2.log())
          ? ok("настоящий api.py за Caddy: колбэк без Origin — чужой секрет 403 «origin», верный — 200 (такого счёта нет — «callback unknown» в журнале)")
          : bad(`колбэк в api.py через Caddy: чужой ${cbBad.status} ${cbBad.text.slice(0, 80)}, верный ${cbOk.status} ${cbOk.text.slice(0, 80)}`);
      } catch (e) { bad("3б упал: " + (e.stack || e)); }
      finally { await L.cleanup(); stub.close(); }
    }

    // ---- 4. приложение целиком под этими заголовками ------------------------
    console.log("\n4. 01-scenarios на этом Caddy (CSP не должна ломать ни одной кнопки)");
    const s = spawnSync(process.execPath, [path.join(__dirname, "01-scenarios.js")], { encoding: "utf8", timeout: 600000, env: { ...process.env, MAGNAT_URL: `http://127.0.0.1:${P}/app.html` } });
    const out = (s.stdout || "") + (s.stderr || "");
    const failsIn = out.split("\n").filter(l => l.includes("✗"));
    const csp = out.split("\n").filter(l => /Content Security Policy|Refused to/.test(l));
    if (csp.length) bad("нарушения CSP:\n    " + csp.slice(0, 5).join("\n    "));
    s.status === 0 && !failsIn.length ? ok("01-scenarios на сервере — чисто (" + (out.match(/✓/g) || []).length + " проверок)")
      : bad(`01-scenarios на сервере (код ${s.status}):\n    ` + (failsIn.length ? failsIn : out.trim().split("\n").slice(-6)).slice(0, 8).join("\n    "));

    // ---- 5. продающая страница под этой же CSP ------------------------------
    console.log("\n5. Продающая страница на этом Caddy");
    {
      const { chromium, chromePath } = require("./lib");
      const br = await chromium.launch({ executablePath: chromePath() });
      try {
        const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });
        const pg = await ctx.newPage(), errs = [];
        pg.on("pageerror", e => errs.push(e.message));
        pg.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
        pg.on("requestfailed", q => errs.push("не загрузилось " + q.url()));
        await pg.goto(`http://127.0.0.1:${P}/`); await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(600);
        const land = await pg.evaluate(() => ({ h1: (document.querySelector("h1") || {}).textContent || "", path: location.pathname,
          font: [...document.fonts].some(f => f.family.includes("Manrope") && f.status === "loaded") }));
        !errs.length && /понедельника/.test(land.h1) && land.path === "/" && land.font
          ? ok("/ — продающая страница: без ошибок и нарушений CSP, свой шрифт")
          : bad("продающая страница на сервере: " + JSON.stringify(land) + " " + errs.slice(0, 3).join(" | "));
        await pg.evaluate(() => localStorage.setItem("magnat_app_v2", "{}"));
        await pg.goto(`http://127.0.0.1:${P}/`); await pg.waitForTimeout(500);
        const to = await pg.evaluate(() => location.pathname + (document.querySelector("#tabs") ? " (приложение)" : ""));
        to === "/app.html (приложение)" ? ok("кто уже пользуется — с «/» сразу в приложение") : bad("с данными «/» → " + to);
        await ctx.close();
      } finally { await br.close(); }
    }
  } finally {
    killApi();
    await L.cleanup();
    caddy.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(T, { recursive: true, force: true });
  }

  console.log(fails ? `\n✗ server: ${fails} проблем` : "\nserver: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

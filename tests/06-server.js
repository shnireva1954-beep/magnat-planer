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
// базы (2в), /api через Caddy — прокси, заголовки, 413 и 503 JSON (3б).
// Caddy берётся из PATH, из CADDY= или скачивается с официального
// репозитория в node_modules/.cache (он в .gitignore) — tests/lib.js.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), zlib = require("zlib");
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
  const APORT = await freePort(), PIDF = path.join(T, "api.pid");
  const killApi = () => { try { process.kill(+fs.readFileSync(PIDF, "utf8"), "SIGKILL"); } catch (e) {} };
  process.on("exit", killApi);
  // systemctl здесь нет — двойник пишет, что его звали, а magnat-api — правда
  // запускает и гасит (как служба: python3 -I …/current/api.py serve, окружение юнита).
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
  env -i PATH=/usr/bin:/bin MAGNAT_LISTEN=127.0.0.1:${APORT} MAGNAT_STATE="${AS}" MAGNAT_DB="${AS}/magnat.db" \\
    MAGNAT_SMTP_FILE="${ETC}/smtp.env" MAGNAT_DISK_MIN_MB=0 setsid python3 -I "${AB}/current/api.py" serve \\
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
    const unit = (name) => { const m = new RegExp(`cat > /etc/systemd/system/${name.replace(/\./g, "\\.")} <<'EOF'\\n([\\s\\S]*?)\\nEOF`).exec(inst); return m ? m[1] : ""; };
    const svc = unit("magnat-api.service"), bsvc = unit("magnat-api-backup.service"), btim = unit("magnat-api-backup.timer");
    const has = (u, lines) => lines.filter(l => !u.split("\n").includes(l));
    const miss = has(svc, ["User=magnat-api", "Group=magnat-api", "ExecStart=/usr/bin/python3 -I /srv/magnat-api/current/api.py serve",
      "LoadCredential=smtp:/etc/magnat/smtp.env", "Restart=on-failure", "MemoryMax=96M", "MemoryHigh=72M", "NoNewPrivileges=yes",
      "ProtectSystem=strict", "ReadWritePaths=/var/lib/magnat-api", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
      "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes", "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"]);
    !miss.length ? ok("magnat-api.service: magnat-api, песочница, память ≤ 96 МБ, почта через LoadCredential") : bad("в magnat-api.service нет: " + miss.join(", "));
    const env = (svc.match(/^Environment=(.*)$/m) || ["", ""])[1].split(/\s+/).filter(Boolean);
    JSON.stringify(env) === JSON.stringify(["MAGNAT_LISTEN=127.0.0.1:8787", "MAGNAT_DB=/var/lib/magnat-api/magnat.db", "MAGNAT_STATE=/var/lib/magnat-api", "MAGNAT_ORIGIN=https://magnat-planer.ru"])
      && (svc.match(/^Environment/gm) || []).length === 1
      ? ok("окружение службы — только адрес 127.0.0.1:8787, база, папка и сайт; ни одной ручки проверки") : bad("окружение службы: " + env.join(" "));
    const rw = [svc, bsvc].map(u => (u.match(/^ReadWritePaths=.*$/gm) || []).join("|"));
    rw.every(x => x === "ReadWritePaths=/var/lib/magnat-api") ? ok("писать службам можно только в /var/lib/magnat-api") : bad("ReadWritePaths: " + rw.join(" ; "));
    has(bsvc, ["User=magnat-api", "ExecStart=/usr/local/sbin/magnat api-backup", "PrivateNetwork=yes", "ProtectSystem=strict"]).length === 0
      && !/runuser/.test(bsvc) && /^OnCalendar=/m.test(btim) && /^Persistent=true$/m.test(btim) && /systemctl enable --now magnat-api-backup\.timer/.test(inst)
      ? ok("копия базы раз в сутки — служба от magnat-api без сети и без runuser, таймер включён") : bad("служба/таймер копии базы не те");
    if (sh("command -v systemd-analyze").status === 0) {
      const UD = path.join(T, "units"); fs.mkdirSync(UD);
      fs.writeFileSync(path.join(UD, "magnat-api.service"), svc);
      fs.writeFileSync(path.join(UD, "magnat-api-backup.service"), bsvc.replace("/usr/local/sbin/magnat api-backup", "/bin/true"));
      fs.writeFileSync(path.join(UD, "magnat-api-backup.timer"), btim);
      const va = sh("systemd-analyze verify --man=no ./magnat-api.service ./magnat-api-backup.service ./magnat-api-backup.timer", { cwd: UD });
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
        q.on("end", () => { seen.push({ url: q.url, at, xff: q.headers["x-forwarded-for"], n });
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
        await L.startApi({ port: AP, origin: C.origin, smtp: null });
        const me = await L.postJson(C.port, "/api/me", {}, { origin: C.origin });
        me.status === 200 && me.json && me.json.ok === true && /max-age=63072000/.test(me.h["strict-transport-security"] || "") && /connect-src 'self'/.test(me.h["content-security-policy"] || "") && !me.h.server
          ? ok("настоящий api.py за Caddy: POST /api/me → 200 JSON с HSTS и CSP, без Server") : bad(`api.py за Caddy: ${me.status} ${me.text.slice(0, 120)}`);
        const hh = await L.request(C.port, { path: "/api/health" });
        hh.status === 404 ? ok("/api/health снаружи — 404 (видно только с самой машины)") : bad("/api/health через Caddy → " + hh.status);
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

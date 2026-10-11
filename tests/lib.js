const { chromium } = require("playwright-core");
const path = require("path"), fs = require("fs");

// Chromium ищем там, где его кладёт окружение; можно задать свой путь через CHROME=
function chromePath(){
  if (process.env.CHROME) return process.env.CHROME;
  const roots = ["/opt/pw-browsers", path.join(process.env.HOME || "", ".cache/ms-playwright")];
  for (const r of roots) {
    let dirs = []; try { dirs = fs.readdirSync(r); } catch (e) { continue; }
    for (const d of dirs.filter(x => x.startsWith("chromium") && !x.includes("headless")).sort().reverse()) {
      const p = path.join(r, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("Chromium не найден. Укажи путь: CHROME=/путь/к/chrome node tests/run.js");
}

const APP_DIR = path.join(__dirname, "..");
// С 08.10.2026 приложение — app.html, а на «/» (index.html) продающая страница: её сторожит 05-landing
const APP_FILE = path.join(APP_DIR, "app.html");
// MAGNAT_URL — тот же прогон на настоящем веб-сервере (06-server: Caddy с
// заголовками безопасности, как на magnat-planer.ru). По умолчанию — файл.
const APP_URL = process.env.MAGNAT_URL || "file://" + APP_FILE;
const OUT_DIR = path.join(__dirname, "__snapshots");
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
const launch = () => chromium.launch({ executablePath: chromePath() });

// «Начать своё» с 29.09.2026 открывает выбор привычек: жмём «Начать» с тем,
// что отмечено по умолчанию (три привычки). Сам выбор проверяет 01-scenarios, блок 1б.
// С 06.10.2026 следом открывается урок 1 — закрываем «Готово», как человек.
// Само окно первого урока проверяет 01-scenarios, блок 1к.
async function startClean(p) {
  await p.click('#obFresh');
  await p.waitForSelector('#hpGo', { timeout: 3000 });
  await p.click('#hpGo');
  await p.waitForSelector('.lesm .ok', { timeout: 3000 });
  await p.click('.lesm .ok'); await p.waitForTimeout(400);
}


// ═══════════ Сервер в тестах (06-server, 09-account) ═══════════
// Caddy с настоящим server/Caddyfile, API (server/api/api.py), поддельные
// почта (SMTP) и WebDAV, прокси «проглотить ответ» и рамка, как в окне Claude.
// Всё — на свободных портах 127.0.0.1 и во временных папках. Всё гасится само:
// при выходе, при SIGINT/SIGTERM/SIGHUP, а Caddy и API (через prctl
// PR_SET_PDEATHSIG) — даже если сам тест убит SIGKILL. Явно — cleanup().
// fakeSmtp и fakeDav — в своём процессе: к ним можно ходить из spawnSync.
// dropProxy и frameServer — в этом: их клиенты только асинхронные (Caddy,
// браузер, request) — spawnSync остановит цикл событий, и они замолчат.
// Адреса в тестах — только *@example.ru. MAGNAT_KEEP_TMP=1 — не удалять папки.
const { spawn, spawnSync } = require("child_process");
const os = require("os"), http = require("http"), net = require("net"), crypto = require("crypto");

const sh = (cmd, opts = {}) => spawnSync("bash", ["-c", cmd], { encoding: "utf8", ...opts });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tail = (s, n = 1500) => String(s || "").slice(-n);

// Caddy: CADDY= → PATH → node_modules/.cache (свой; у git worktree — ещё и
// основной копии) → скачать с официального репозитория в node_modules/.cache.
function findCaddy() {
  if (process.env.CADDY) return process.env.CADDY;
  const w = sh("command -v caddy"); if (w.status === 0) return w.stdout.trim();
  const rel = path.join("node_modules", ".cache", "caddy");
  const cache = path.join(APP_DIR, rel);
  const bin = path.join(cache, "usr", "bin", "caddy");
  if (fs.existsSync(bin)) return bin;
  const common = sh("git rev-parse --path-format=absolute --git-common-dir", { cwd: APP_DIR }).stdout.trim();
  if (common) { const other = path.join(path.dirname(common), rel, "usr", "bin", "caddy"); if (fs.existsSync(other)) return other; }
  fs.mkdirSync(cache, { recursive: true });
  const base = "https://dl.cloudsmith.io/public/caddy/stable/deb/debian";
  // Качаем в свою временную папку и кладём файл одним mv: параллельный прогон не увидит половину.
  const r = sh(`set -e; cd "${cache}"; t=$(mktemp -d .dl-XXXXXX); trap 'rm -rf "${cache}/$t"' EXIT; cd "$t"
    f=$(curl -fsS --retry 2 --max-time 120 ${base}/dists/any-version/main/binary-amd64/Packages | awk '/^Version: /{v=$2} /^Filename: /{print v, $2}' | sort -V | tail -1 | cut -d' ' -f2)
    curl -fsS --retry 2 --max-time 300 -o caddy.deb "${base}/$f"; dpkg-deb -x caddy.deb .
    mkdir -p "${cache}/usr/bin"; mv -f usr/bin/caddy "${cache}/usr/bin/caddy"`);
  if (r.status !== 0 || !fs.existsSync(bin)) throw new Error("Caddy не нашёлся и не скачался: " + r.stderr);
  return bin;
}

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port, p, headers = {}) => new Promise((res, rej) => {
  const req = http.get({ host: "127.0.0.1", port, path: p, headers }, r => { let b = []; r.on("data", d => b.push(d)); r.on("end", () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(b) })); });
  req.on("error", rej); req.setTimeout(5000, () => req.destroy(new Error("timeout")));
});
async function waitPort(port, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { await get(port, "/"); return true; } catch (e) { await new Promise(r => setTimeout(r, 150)); } }
  return false;
}

// Любой HTTP-запрос. body: строка, Buffer или объект (→ JSON + Content-Type).
// Заголовок со значением null не посылается: { "Content-Length": null } —
// тело уйдёт кусками (chunked), так проверяется 411.
// Ответ: { status, h, body: Buffer, text, json|null, cookie: "a=1; b=2" }.
function request(port, { method = "GET", path: p = "/", headers = {}, body, host = "127.0.0.1", timeout = 15000 } = {}) {
  return new Promise((res, rej) => {
    const h = {}, off = new Set();
    for (const [k, v] of Object.entries(headers)) { if (v === null) off.add(k.toLowerCase()); else if (v !== undefined) h[k] = v; }
    const has = (n) => off.has(n) || Object.keys(h).some(k => k.toLowerCase() === n);
    let data = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || typeof body === "string") data = Buffer.from(body);
      else { data = Buffer.from(JSON.stringify(body)); if (!has("content-type")) h["Content-Type"] = "application/json"; }
      if (!has("content-length") && !has("transfer-encoding")) h["Content-Length"] = data.length;
    }
    const req = http.request({ host, port, method, path: p, headers: h, agent: false }, r => {
      const b = []; r.on("data", d => b.push(d)); r.on("error", rej);
      r.on("end", () => {
        const buf = Buffer.concat(b), text = buf.toString("utf8"); let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        const cookie = (r.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
        res({ status: r.statusCode, h: r.headers, body: buf, text, json, cookie });
      });
    });
    req.on("error", rej); req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}
// POST JSON как честный клиент: Origin, Sec-Fetch-Site: same-origin, cookie.
const postJson = (port, route, obj, { origin, cookie, headers = {}, timeout } = {}) => request(port, { method: "POST", path: route, body: obj, timeout,
  headers: { ...(origin ? { Origin: origin } : {}), "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}), ...headers } });
// Сырой TCP: куски с паузой gap мс (медленные заголовки). → { data, ms, closed, timedOut }
function rawHttp(port, chunks, { gap = 0, timeout = 20000, host = "127.0.0.1" } = {}) {
  return new Promise((res) => {
    const t0 = Date.now(), got = []; let done = false, timedOut = false, timer;
    const s = net.connect(port, host);
    const fin = (closed) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); res({ data: Buffer.concat(got).toString("utf8"), ms: Date.now() - t0, closed, timedOut }); };
    s.on("data", d => got.push(d)); s.on("end", () => fin(true)); s.on("close", () => fin(true)); s.on("error", () => fin(true));
    timer = setTimeout(() => { timedOut = true; fin(false); }, timeout);
    s.on("connect", async () => { for (const c of [].concat(chunks)) { if (done) return; s.write(c); if (gap) await sleep(gap); } });
  });
}

// ---- уборка -------------------------------------------------------------------
const LIVE = new Set(), TMP = new Set();
let hooked = false;
function cleanupSync() {
  for (const x of [...LIVE]) { try { x.killSync(); } catch (e) {} }
  LIVE.clear();
  if (!process.env.MAGNAT_KEEP_TMP) for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  TMP.clear();
}
function hookExit() {
  if (hooked) return; hooked = true;
  process.on("exit", cleanupSync);
  // Свой обработчик сигнала снимает поведение по умолчанию — возвращаем его, если других нет.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { cleanupSync(); if (!process.listenerCount(sig)) process.kill(process.pid, sig); });
}
// Явная уборка в finally: всё, что подняли помощники, гасится и удаляется.
async function cleanup() {
  await Promise.all([...LIVE].map(x => x.close().catch(() => {})));
  cleanupSync();
}
function tmpDir(prefix = "magnat-t-") { hookExit(); const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP.add(d); return d; }

// Сервер в этом же процессе: следим за сокетами, чтобы закрыть без ожидания.
function trackServer(server, extra = () => {}) {
  hookExit();
  const socks = new Set();
  server.on("connection", s => { socks.add(s); s.on("close", () => socks.delete(s)); });
  const item = {
    killSync() { extra(); for (const s of socks) s.destroy(); try { server.close(); } catch (e) {} },
    close() { LIVE.delete(item); extra(); return new Promise(r => { for (const s of socks) s.destroy(); server.close(() => r()); }); },
  };
  LIVE.add(item);
  return item;
}
const listen = (server, port = 0) => new Promise((res, rej) => { server.once("error", rej); server.listen(port, "127.0.0.1", () => { server.off("error", rej); res(server.address().port); }); });

// Дочерний процесс: вывод копится, умирает вместе с тестом (даже при SIGKILL теста).
const TIE = "import ctypes,os,sys\ntry: ctypes.CDLL(None).prctl(ctypes.c_int(1), ctypes.c_ulong(9), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0))\nexcept Exception: pass\nif os.getppid() != int(sys.argv[1]): sys.exit(70)\nos.execvp(sys.argv[2], sys.argv[2:])\n";
let hasPy = null;
function spawnLogged(cmd, args, { env = process.env, cwd } = {}) {
  hookExit();
  if (hasPy === null) hasPy = spawnSync("python3", ["-I", "-c", "import ctypes"]).status === 0;
  const p = hasPy ? spawn("python3", ["-I", "-c", TIE, String(process.pid), cmd, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] })
                  : spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const MAX = 8 << 20;
  const h = { proc: p, pid: p.pid, out: "", err: "", code: undefined, signal: undefined, dead: false };
  p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
  p.stdout.on("data", d => { h.out = (h.out + d).slice(-MAX); });
  p.stderr.on("data", d => { h.err = (h.err + d).slice(-MAX); });
  h.exited = new Promise(res => {
    p.on("exit", (code, signal) => { h.code = code; h.signal = signal; h.dead = true; LIVE.delete(h); res({ code, signal }); });
    p.on("error", e => { h.err += "spawn: " + e.message + "\n"; h.dead = true; LIVE.delete(h); res({ code: null, signal: null, error: e }); });
  });
  h.alive = () => !h.dead;
  h.killSync = () => { if (!h.dead) try { p.kill("SIGKILL"); } catch (e) {} };
  h.kill = async () => { h.killSync(); await h.exited; };
  h.stop = async (ms = 5000) => {
    if (h.dead) return;
    try { p.kill("SIGTERM"); } catch (e) {}
    let t; await Promise.race([h.exited, new Promise(r => { t = setTimeout(r, ms); })]); clearTimeout(t);
    await h.kill();
  };
  h.close = h.stop;
  LIVE.add(h);
  return h;
}
// Ждём HTTP-ответ (любой) от только что запущенного процесса.
async function waitUp(port, p, ms, proc) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (!proc.alive()) return { ok: false, why: `процесс вышел (код ${proc.code}, сигнал ${proc.signal})` };
    try { return { ok: true, res: await request(port, { path: p, timeout: 2000 }) }; } catch (e) { await sleep(100); }
  }
  return { ok: false, why: `нет ответа за ${Math.round(ms / 1000)} с` };
}
const BUSY = /address already in use|EADDRINUSE|Errno 98/i;
// 8787, "127.0.0.1:8787", "http://127.0.0.1:8787", { addr } или { port } → { host, port }
function addrOf(x) {
  if (x && typeof x === "object") return addrOf(x.addr || x.port);
  if (typeof x === "number" || /^\d+$/.test(String(x))) return { host: "127.0.0.1", port: +x };
  const s = String(x).replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, ""), i = s.lastIndexOf(":");
  return { host: s.slice(0, i).replace(/^\[|\]$/g, "") || "127.0.0.1", port: +s.slice(i + 1) };
}

// ---- Caddy -----------------------------------------------------------------------
// startCaddy({ site, root, api, config, env, timeout }) — настоящий server/Caddyfile
// с окружением, как в 06-server: сайт и www на свободных портах, свой admin,
// свои XDG-папки, MAGNAT_API = api (порт, "хост:порт", startApi или dropProxy).
// Без api — пустой порт: это «API выключен» (Caddy отвечает 503 down).
// site — порт или "http://127.0.0.1:P" (по умолчанию свободный). root — папка сайта
// (по умолчанию корень репозитория: служебное прячет сам Caddyfile).
async function startCaddy(o = {}) {
  const bin = o.caddy || findCaddy();
  const dir = tmpDir("magnat-caddy-");
  const C = { bin, dir, procs: [], root: path.resolve(o.root || APP_DIR), config: path.resolve(o.config || path.join(APP_DIR, "server", "Caddyfile")) };
  const apiStr = async (a) => { if (!a) return `127.0.0.1:${await freePort()}`; const { host, port } = addrOf(a); return `${host}:${port}`; };
  C.api = await apiStr(o.api);
  const fixed = o.site ? addrOf(o.site).port : 0;
  async function boot(port, canMove) {
    for (let attempt = 1; ; attempt++) {
      const www = await freePort(), admin = await freePort();
      const env = { ...process.env, MAGNAT_SITE: `http://127.0.0.1:${port}`, MAGNAT_WWW: `http://127.0.0.1:${www}`, MAGNAT_ROOT: C.root,
        MAGNAT_ADMIN: `localhost:${admin}`, MAGNAT_API: C.api, XDG_DATA_HOME: path.join(dir, "xdg"), XDG_CONFIG_HOME: path.join(dir, "xdg"), ...(o.env || {}) };
      const p = spawnLogged(bin, ["run", "--config", C.config, "--adapter", "caddyfile"], { env, cwd: dir });
      C.procs.push(p);
      const r = await waitUp(port, "/", o.timeout || 10000, p);
      if (r.ok) { Object.assign(C, { port, wwwPort: www, adminPort: admin, proc: p, env, url: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }); return; }
      await p.stop(1000);
      if (canMove && attempt < 4 && BUSY.test(p.err)) { port = await freePort(); continue; }
      throw new Error(`Caddy не поднялся (${r.why}): ` + tail(p.err));
    }
  }
  C.log = () => C.procs.map(p => p.out + p.err).join("");
  C.alive = () => !!C.proc && C.proc.alive();
  C.stop = async () => { if (C.proc) await C.proc.stop(3000); };
  C.kill = async () => { if (C.proc) await C.proc.kill(); };
  // Перезапуск на том же порту; { api } — направить /api в другое место.
  C.restart = async (more = {}) => { await C.stop(); if ("api" in more) C.api = await apiStr(more.api); await boot(C.port, false); return C; };
  C.close = C.stop;
  await boot(fixed || await freePort(), !fixed);
  return C;
}

// ---- API -------------------------------------------------------------------------
// startApi({ env, db, smtp, origin, script, dir, port, args, timeout, wait })
// `python3 -I server/api/api.py serve` на свободном порту: временная папка
// состояния (MAGNAT_STATE), временная БД (или db), smtp.env 0600 со случайным
// паролем. smtp: не задан — свой fakeSmtp(); fakeSmtp — его порт и пароль
// (подделка пустит только этот пароль); null — пустой файл (почта не настроена).
// Унаследованные MAGNAT_* не передаются: что нужно — в env. Готовность — ответ
// GET /api/health. stdout и stderr копятся: out(), err(), log() — за все запуски.
async function startApi(o = {}) {
  const script = path.resolve(o.script || path.join(APP_DIR, "server", "api", "api.py"));
  if (!fs.existsSync(script)) throw new Error("API не найден: " + script);
  const dir = o.dir || tmpDir("magnat-api-");
  try { fs.chmodSync(dir, 0o700); } catch (e) {}
  let smtp = o.smtp, ownSmtp = false;
  if (smtp === undefined) { smtp = await fakeSmtp(); ownSmtp = true; }
  const A = { script, dir, smtp: smtp || null, procs: [], port: 0, db: path.resolve(o.db || path.join(dir, "magnat.db")), smtpFile: path.join(dir, "smtp.env"),
    user: o.user || "box@example.ru", support: o.support || "support@example.ru", pass: o.pass || crypto.randomBytes(15).toString("base64url") };
  // Переписать smtp.env (0600, атомарно): fakeSmtp, объект {SMTP_HOST: …}, строка или null (пусто).
  A.setSmtp = (x) => {
    let txt = "";
    if (x && x._fakeSmtp) { x.allow(A.user, A.pass); txt = `SMTP_HOST=127.0.0.1\nSMTP_PORT=${x.port}\nSMTP_USER=${A.user}\nSMTP_PASS=${A.pass}\nSUPPORT=${A.support}\n`; }
    else if (x && typeof x === "object") txt = Object.entries(x).map(([k, v]) => `${k}=${v}\n`).join("");
    else if (typeof x === "string") txt = x;
    const t = A.smtpFile + ".tmp" + process.pid;
    fs.writeFileSync(t, txt, { mode: 0o600 }); fs.chmodSync(t, 0o600); fs.renameSync(t, A.smtpFile);
  };
  A.setSmtp(A.smtp);
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^MAGNAT_/.test(k) && k !== "CREDENTIALS_DIRECTORY") base[k] = v;
  A.env = { ...base, MAGNAT_DB: A.db, MAGNAT_STATE: dir, MAGNAT_SMTP_FILE: A.smtpFile, MAGNAT_DISK_MIN_MB: "0", ...(o.origin ? { MAGNAT_ORIGIN: o.origin } : {}), ...(o.env || {}) };
  const tidy = () => { for (const k of Object.keys(A.env)) { if (A.env[k] === undefined || A.env[k] === null) delete A.env[k]; else A.env[k] = String(A.env[k]); } };
  tidy();
  const fixed = o.port || (A.env.MAGNAT_LISTEN ? addrOf(A.env.MAGNAT_LISTEN).port : 0);
  async function boot(port, canMove) {
    for (let attempt = 1; ; attempt++) {
      const p = spawnLogged("python3", ["-I", script, ...(o.args || ["serve"])], { env: { ...A.env, MAGNAT_LISTEN: `127.0.0.1:${port}` }, cwd: dir });
      A.procs.push(p); A.proc = p; A.port = port;
      if (o.wait === false) return;
      const r = await waitUp(port, "/api/health", o.timeout || 15000, p);
      if (r.ok) { A.ready = r.res.json; return; }
      await p.stop(1000);
      if (canMove && attempt < 4 && BUSY.test(p.err)) { port = await freePort(); continue; }
      throw new Error(`API не поднялся (${r.why}): ` + tail(p.out + p.err));
    }
  }
  Object.defineProperty(A, "addr", { get: () => `127.0.0.1:${A.port}` });
  Object.defineProperty(A, "url", { get: () => `http://127.0.0.1:${A.port}` });
  A.out = () => A.procs.map(p => p.out).join("");
  A.err = () => A.procs.map(p => p.err).join("");
  A.log = () => A.procs.map(p => p.out + p.err).join("");
  A.alive = () => !!A.proc && A.proc.alive();
  A.stop = async () => { if (A.proc) await A.proc.stop(5000); };
  A.kill = async () => { if (A.proc) await A.proc.kill(); };
  // Перезапуск на том же порту (Caddy менять не нужно); env — добавить или (null) убрать.
  A.restart = async (env = {}) => { await A.stop(); Object.assign(A.env, env); tidy(); await boot(A.port, false); return A; };
  A.close = async () => { await A.stop(); if (ownSmtp) await A.smtp.close(); };
  // Прямой запрос к API, мимо Caddy (Origin — из MAGNAT_ORIGIN).
  A.post = (route, obj, opts = {}) => postJson(A.port, route, obj, { origin: A.env.MAGNAT_ORIGIN, ...opts });
  await boot(fixed || await freePort(), !fixed);
  return A;
}

// ---- поддельные почта и WebDAV: отдельный процесс ----------------------------------
// Подделки живут в своём процессе node (этот же файл с --fake), а всё, что
// видят, сразу пишут в файл. Поэтому к ним можно ходить и из spawnSync
// (06-server запускает magnat.sh именно так — цикл событий теста в это время
// стоит), а читать записанное — сразу после, синхронно. Настройки (mode, creds,
// fail) — файл ctl.json, подделка перечитывает его на каждом шаге.
function fakeDir(prefix, ctl) {
  const dir = tmpDir(prefix);
  const save = () => { const t = path.join(dir, "ctl.json.tmp"); fs.writeFileSync(t, JSON.stringify(ctl)); fs.renameSync(t, path.join(dir, "ctl.json")); };
  save();
  const file = path.join(dir, "events.jsonl");
  let off = 0, list = [];
  const events = () => { // дочитываем только новые полные строки
    let size = 0; try { size = fs.statSync(file).size; } catch (e) {}
    if (size < off) { off = 0; list = []; }
    if (size > off) {
      const fd = fs.openSync(file, "r"), b = Buffer.alloc(size - off); fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd);
      const end = b.lastIndexOf(10) + 1;
      for (const l of b.slice(0, end).toString("utf8").split("\n")) if (l) list.push(JSON.parse(l));
      off += end;
    }
    return list;
  };
  const clear = () => { try { fs.truncateSync(file, 0); } catch (e) {} off = 0; list = []; };
  return { dir, save, events, clear };
}
async function startFake(kind, dir) {
  const p = spawnLogged(process.execPath, [__filename, "--fake", kind, dir]);
  const t = Date.now(); let m;
  while (!(m = /^PORT (\d+)$/m.exec(p.out))) {
    if (!p.alive() || Date.now() - t > 10000) { await p.kill(); throw new Error(`поддельный ${kind} не поднялся: ` + tail(p.err)); }
    await sleep(20);
  }
  return { proc: p, port: +m[1] };
}

// fakeSmtp({ mode, delay, creds }) — SMTP: 220, EHLO/HELO, AUTH PLAIN и LOGIN
// (с начальным ответом и без), MAIL, RCPT, DATA, RSET, NOOP, QUIT.
// mails — письма { auth, from, to, raw, bytes, at }; auths — попытки входа
// { mech, user, pass, ok }; conns — число соединений.
// mode (меняется на ходу: smtp.mode = "535"): ok | 535 (вход не пускает) |
// drop (рвёт соединение сразу) | slow (приветствие через delay мс, 4 с) |
// drop-data (рвёт после письма, не подтвердив его).
// creds / allow(user, pass): если заданы — пускает только с ними, иначе 535.
async function fakeSmtp({ mode = "ok", delay = 4000, creds = null } = {}) {
  const ctl = { mode, delay, creds: [].concat(creds || []) };
  const F = fakeDir("magnat-smtp-", ctl);
  const S = { _fakeSmtp: true, host: "127.0.0.1", dir: F.dir };
  for (const k of ["mode", "delay"]) Object.defineProperty(S, k, { enumerable: true, get: () => ctl[k], set: (v) => { ctl[k] = v; F.save(); } });
  Object.defineProperty(S, "creds", { enumerable: true, get: () => ctl.creds.slice() });
  S.allow = (user, pass) => { if (!ctl.creds.some(c => c.user === user && c.pass === pass)) { ctl.creds.push({ user, pass }); F.save(); } return S; };
  const mails = new WeakMap();
  const mail = (e) => { if (!mails.has(e)) { const bytes = Buffer.from(e.raw64, "base64"); mails.set(e, { auth: e.auth, from: e.from, to: e.to, raw: bytes.toString("utf8"), bytes, at: e.at }); } return mails.get(e); };
  Object.defineProperty(S, "mails", { enumerable: true, get: () => F.events().filter(e => e.t === "mail").map(mail) });
  Object.defineProperty(S, "auths", { enumerable: true, get: () => F.events().filter(e => e.t === "auth").map(({ t, ...a }) => a) });
  Object.defineProperty(S, "conns", { enumerable: true, get: () => F.events().filter(e => e.t === "conn").length });
  S.to = (email) => { const e = String(email).toLowerCase(); return S.mails.filter(m => m.to.some(t => t.toLowerCase() === e)); };
  S.clear = F.clear;
  // Дождаться письма: pred(mail) → true. → письмо или null по таймауту.
  S.wait = async (pred = () => true, ms = 10000) => {
    const t = Date.now();
    for (;;) { const m = S.mails.find(pred); if (m) return m; if (Date.now() - t > ms) return null; await sleep(50); }
  };
  const { proc, port } = await startFake("smtp", F.dir);
  Object.assign(S, { proc, port, close: () => proc.stop(2000) });
  return S;
}
function smtpServer(ctl, rec) {
  return net.createServer(sock => {
    rec({ t: "conn", at: Date.now() });
    if (ctl().mode === "drop") { sock.destroy(); return; }
    sock.setEncoding("latin1"); // байты как есть: письмо собираем обратно в Buffer
    sock.setTimeout(60000, () => sock.destroy());
    sock.on("error", () => {});
    const st = { auth: null, from: null, to: [], data: null, step: null, user: null };
    const say = (l) => { if (!sock.destroyed) sock.write(l + "\r\n"); };
    const b64 = (x) => Buffer.from(x, "base64").toString("utf8");
    const judge = (mech, user, pass) => {
      const c = ctl(), good = c.mode !== "535" && (!(c.creds || []).length || c.creds.some(x => x.user === user && x.pass === pass));
      rec({ t: "auth", mech, user, pass, ok: good, at: Date.now() });
      if (!good) return say("535 5.7.8 Error: authentication failed");
      st.auth = { mech, user, pass }; say("235 2.7.0 Authentication successful");
    };
    const plain = (x) => { const [, u = "", p = ""] = b64(x).split("\0"); judge("PLAIN", u, p); };
    const line = (l) => {
      if (st.data) {
        if (l !== ".") { st.data.push(l.startsWith(".") ? l.slice(1) : l); return; }
        const bytes = Buffer.from(st.data.join("\r\n") + "\r\n", "latin1"); st.data = null;
        if (ctl().mode === "drop-data") { sock.destroy(); return; }
        rec({ t: "mail", auth: st.auth, from: st.from, to: st.to, raw64: bytes.toString("base64"), at: Date.now() });
        st.from = null; st.to = [];
        return say("250 2.0.0 Ok: queued");
      }
      if (st.step) {
        const step = st.step; st.step = null;
        if (l === "*") return say("501 5.7.0 Authentication aborted");
        if (step === "plain") return plain(l);
        if (step === "login-user") { st.user = b64(l); st.step = "login-pass"; return say("334 UGFzc3dvcmQ6"); }
        return judge("LOGIN", st.user, b64(l));
      }
      const m = /^(\S*)\s*(.*)$/.exec(l), cmd = m[1].toUpperCase(), arg = m[2];
      switch (cmd) {
        case "EHLO": return sock.write("250-fake-smtp.example.ru\r\n250-SIZE 41943040\r\n250-8BITMIME\r\n250-AUTH PLAIN LOGIN\r\n250 ENHANCEDSTATUSCODES\r\n");
        case "HELO": return say("250 fake-smtp.example.ru");
        case "AUTH": {
          if (st.auth) return say("503 5.5.1 Error: already authenticated");
          const [mech = "", init] = arg.split(/\s+/);
          if (mech.toUpperCase() === "PLAIN") { if (init) return plain(init); st.step = "plain"; return say("334 "); }
          if (mech.toUpperCase() === "LOGIN") {
            if (init) { st.user = b64(init); st.step = "login-pass"; return say("334 UGFzc3dvcmQ6"); }
            st.step = "login-user"; return say("334 VXNlcm5hbWU6");
          }
          return say("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL": {
          if (!st.auth) return say("530 5.7.0 Authentication required");
          const a = /^FROM:\s*<([^>]*)>/i.exec(arg); if (!a) return say("501 5.5.4 Syntax: MAIL FROM:<address>");
          st.from = a[1]; st.to = []; return say("250 2.1.0 Ok");
        }
        case "RCPT": {
          if (st.from === null) return say("503 5.5.1 Error: need MAIL command");
          const a = /^TO:\s*<([^>]*)>/i.exec(arg); if (!a) return say("501 5.5.4 Syntax: RCPT TO:<address>");
          st.to.push(a[1]); return say("250 2.1.5 Ok");
        }
        case "DATA": if (!st.to.length) return say("503 5.5.1 Error: need RCPT command"); st.data = []; return say("354 End data with <CR><LF>.<CR><LF>");
        case "RSET": st.from = null; st.to = []; return say("250 2.0.0 Ok");
        case "NOOP": return say("250 2.0.0 Ok");
        case "QUIT": say("221 2.0.0 Bye"); return sock.end();
        default: return say("502 5.5.2 Error: command not recognized");
      }
    };
    let buf = "", greeted = false;
    const feed = () => { let i; while (greeted && !sock.destroyed && (i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); line(l); } };
    sock.on("data", d => { buf += d; feed(); });
    const greet = () => { if (sock.destroyed) return; greeted = true; say("220 fake-smtp.example.ru ESMTP"); feed(); };
    const c = ctl();
    if (c.mode === "slow") setTimeout(greet, c.delay); else greet();
  });
}

// Письмо по частям: заголовки (RFC 2047 раскодированы), text, html, parts
// (с вложениями: filename, content: Buffer). Хватает для писем api.py.
function decodeCs(buf, cs = "utf-8") {
  cs = String(cs).toLowerCase();
  if (/^(utf-?8|us-ascii|ascii)$/.test(cs)) return buf.toString("utf8");
  if (/^(iso-8859-1|latin1)$/.test(cs)) return buf.toString("latin1");
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return buf.toString("utf8"); }
}
function qpBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(...Buffer.from(s[i], "utf8"));
  }
  return Buffer.from(out);
}
const decodeWords = (s) => s.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
  .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) =>
    decodeCs(enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : qpBytes(txt.replace(/_/g, " ")), cs));
function headerParams(v) {
  const type = String(v).split(";")[0].trim().toLowerCase(), p = {};
  for (const m of String(v).matchAll(/;\s*([^=\s;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g)) {
    let k = m[1].toLowerCase(), x = m[2].trim();
    if (x.startsWith('"')) x = x.slice(1, -1).replace(/\\(.)/g, "$1");
    if (k.endsWith("*")) { k = k.slice(0, -1); const q = /^([^']*)'[^']*'(.*)$/.exec(x); if (q) { try { x = decodeCs(Buffer.from(q[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"), q[1] || "utf-8"); } catch (e) {} } }
    p[k] = x;
  }
  return { type, p };
}
function parseMail(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const m = /\r?\n\r?\n/.exec(s);
  const head = m ? s.slice(0, m.index) : s, body = m ? s.slice(m.index + m[0].length) : "";
  const all = [];
  for (const l of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) { const i = l.indexOf(":"); if (i > 0) all.push([l.slice(0, i).trim().toLowerCase(), decodeWords(l.slice(i + 1).trim())]); }
  const headers = {}; for (const [k, v] of all) if (!(k in headers)) headers[k] = v;
  const ct = headerParams(headers["content-type"] || "text/plain; charset=us-ascii");
  const disp = headerParams(headers["content-disposition"] || "inline");
  const mail = { headers, all, type: ct.type, params: ct.p, subject: headers.subject || "", parts: [], text: "", html: "" };
  if (ct.type.startsWith("multipart/") && ct.p.boundary) {
    const b = "--" + ct.p.boundary, chunks = []; let cur = null;
    for (const l of body.split(/\r?\n/)) {
      if (l === b || l === b + "--") { if (cur) chunks.push(cur.join("\r\n")); cur = l === b ? [] : null; continue; }
      if (cur) cur.push(l);
    }
    for (const c of chunks) { const sub = parseMail(c); mail.parts.push(...sub.parts); }
  } else {
    const cte = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
    const bytes = cte === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : cte === "quoted-printable" ? qpBytes(body.replace(/=\r?\n/g, "")) : Buffer.from(body, "utf8");
    mail.content = bytes;
    mail.body = cte === "base64" || cte === "quoted-printable" ? decodeCs(bytes, ct.p.charset || "utf-8") : body;
    mail.filename = disp.p.filename || ct.p.name || null;
    mail.attachment = disp.type === "attachment";
    mail.parts.push(mail);
  }
  const leaf = (t) => mail.parts.find(x => x.type === t && !x.attachment);
  mail.text = (leaf("text/plain") || {}).body || "";
  mail.html = (leaf("text/html") || {}).body || "";
  return mail;
}
// Последний код, ушедший на email (из темы, иначе из текста). kind: login | delete.
function lastCode(smtp, email, kind) {
  const list = smtp.to(email);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = parseMail(list[i].raw);
    if (kind === "login" && !/код входа/i.test(p.subject)) continue;
    if (kind === "delete" && !/удален/i.test(p.subject)) continue;
    const re = /(?<!\d)(\d{6})(?!\d)/, c = re.exec(p.subject) || re.exec(p.text) || re.exec(p.html);
    if (c) return c[1];
  }
  return null;
}
// Дождаться НОВОГО кода: after — сколько писем на этот адрес было до запроса.
async function waitCode(smtp, email, { kind, after = 0, ms = 10000 } = {}) {
  const t = Date.now();
  for (;;) {
    if (smtp.to(email).length > after) { const c = lastCode(smtp, email, kind); if (c) return c; }
    if (Date.now() - t > ms) return null;
    await sleep(50);
  }
}

// fakeDav({ user, pass, strict }) — WebDAV для выгрузки бэкапа: MKCOL, PUT,
// GET/HEAD, DELETE, PROPFIND (Depth 0/1), basic auth (user: null — без входа).
// strict — как у настоящих: PUT и MKCOL без родительской папки → 409.
// fail = 507 — любой запрос отвечает этим кодом (меняется на ходу).
// reqs — { method, path, auth, status, size, sha256 }; files — Map путь → Buffer;
// dirs — Set папок; read(путь) → Buffer | null. url — "http://127.0.0.1:P/".
async function fakeDav({ user = "backup@example.ru", pass = crypto.randomBytes(12).toString("base64url"), strict = true } = {}) {
  const ctl = { user, pass, strict, fail: 0 };
  const F = fakeDir("magnat-dav-", ctl), root = path.join(F.dir, "root");
  fs.mkdirSync(root);
  const D = { dir: F.dir, root };
  for (const k of ["user", "pass", "strict", "fail"]) Object.defineProperty(D, k, { enumerable: true, get: () => ctl[k], set: (v) => { ctl[k] = v; F.save(); } });
  Object.defineProperty(D, "reqs", { enumerable: true, get: () => F.events().map(({ t, ...r }) => r) });
  const walk = (rel, out) => {
    for (const n of fs.readdirSync(path.join(root, rel))) { const k = rel + "/" + n, st = fs.statSync(path.join(root, k)); out.push([k, st.isDirectory()]); if (st.isDirectory()) walk(k, out); }
    return out;
  };
  Object.defineProperty(D, "files", { enumerable: true, get: () => new Map(walk("", []).filter(x => !x[1]).map(([k]) => [k, fs.readFileSync(path.join(root, k))])) });
  Object.defineProperty(D, "dirs", { enumerable: true, get: () => new Set(["/", ...walk("", []).filter(x => x[1]).map(x => x[0])]) });
  D.read = (p) => { try { return fs.readFileSync(path.join(root, path.posix.normalize("/" + p))); } catch (e) { return null; } };
  D.clear = F.clear;
  const { proc, port } = await startFake("dav", F.dir);
  Object.assign(D, { proc, port, url: `http://127.0.0.1:${port}/`, close: () => proc.stop(2000) });
  return D;
}
function davServer(ctl, rec, root) {
  const xmlEsc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const st = (k) => { try { return fs.statSync(path.join(root, k)); } catch (e) { return null; } };
  const isDir = (k) => { const s = st(k); return !!s && s.isDirectory(); }, isFile = (k) => { const s = st(k); return !!s && s.isFile(); };
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => {
      const c = ctl(), body = Buffer.concat(chunks);
      let p; try { p = decodeURIComponent(req.url.split("?")[0]); } catch (e) { p = req.url; }
      const key = path.posix.normalize("/" + p).replace(/\/+$/, "") || "/", parent = path.posix.dirname(key), disk = path.join(root, key);
      let auth = null; const m = /^Basic\s+(\S+)/i.exec(req.headers.authorization || "");
      if (m) { const x = Buffer.from(m[1], "base64").toString("utf8"), i = x.indexOf(":"); auth = { user: x.slice(0, i), pass: x.slice(i + 1) }; }
      const send = (code, b = "", h = {}) => {
        rec({ t: "req", method: req.method, path: key, auth, status: code, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"), at: Date.now() });
        const buf = Buffer.isBuffer(b) ? b : Buffer.from(b); res.writeHead(code, { "Content-Length": buf.length, ...h }); res.end(req.method === "HEAD" ? undefined : buf);
      };
      if (c.user !== null && (!auth || auth.user !== c.user || auth.pass !== c.pass)) return send(401, "", { "WWW-Authenticate": 'Basic realm="fake-dav"' });
      if (c.fail) return send(c.fail);
      switch (req.method) {
        case "MKCOL":
          if (st(key)) return send(405);
          if (c.strict && !isDir(parent)) return send(409);
          fs.mkdirSync(disk, { recursive: true }); return send(201);
        case "PUT": {
          if (isDir(key)) return send(405);
          if (c.strict && !isDir(parent)) return send(409);
          const had = isFile(key);
          fs.mkdirSync(path.dirname(disk), { recursive: true });
          fs.writeFileSync(disk + ".part", body); fs.renameSync(disk + ".part", disk);
          return send(had ? 204 : 201);
        }
        case "GET": case "HEAD": return isFile(key) ? send(200, fs.readFileSync(disk)) : send(404);
        case "DELETE":
          if (key === "/" || !st(key)) return send(404);
          fs.rmSync(disk, { recursive: true, force: true }); return send(204);
        case "PROPFIND": {
          if (!st(key)) return send(404);
          const items = [key];
          if (isDir(key) && req.headers.depth !== "0") for (const n of fs.readdirSync(disk)) items.push((key === "/" ? "" : key) + "/" + n);
          const resp = items.map(x => { const dirx = isDir(x); return `<d:response><d:href>${xmlEsc(encodeURI(dirx && x !== "/" ? x + "/" : x))}</d:href><d:propstat><d:prop>` +
            (dirx ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${st(x).size}</d:getcontentlength>`) +
            "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"; }).join("");
          return send(207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${resp}</d:multistatus>`, { "Content-Type": "application/xml; charset=utf-8" });
        }
        default: return send(405);
      }
    });
  });
}

// ---- прокси для сбоев (между Caddy и API) ------------------------------------------
// dropProxy(target) — HTTP-прокси на свободном порту к target (порт, "хост:порт",
// startApi). Каждый запрос — в log { method, path, reqBody, json, status, resBody,
// resJson, action }. Правила (match: { method, path: префикс или RegExp, when(e) }):
//   dropNext(match, { how: "reset"|"hang", count: 1 }) — отдать запрос upstream,
//     дождаться его ответа (upstream всё сделал) и проглотить ответ: оборвать
//     соединение (reset) или молчать (hang). → Promise записи журнала;
//   delay(ms, match, { phase: "response"|"request" }) — задерживать;
//   refuse(match) — рвать соединение, не отдавая upstream;
//   clear() — снять правила. count(prefix) — сколько запросов прошло.
async function dropProxy(target) {
  const T = addrOf(target);
  const P = { target: T, log: [], rules: [], port: 0 };
  const hung = new Set();
  const fits = (r, e) => (!r.method || r.method === e.method) && (!r.path || (r.path instanceof RegExp ? r.path.test(e.path) : e.path.startsWith(r.path))) && (!r.when || r.when(e));
  const take = (e) => { const r = P.rules.find(x => x.left > 0 && fits(x, e)); if (r && !--r.left) P.rules.splice(P.rules.indexOf(r), 1); return r; };
  const rule = (action, m, extra) => { let done; const pr = new Promise(r => { done = r; }); const r = { ...m, action, left: 1, ...extra, done: (e) => done(e) }; P.rules.push(r); return pr; };
  P.dropNext = (m = {}, { how = "reset", count = 1 } = {}) => rule("drop", m, { how, left: count });
  P.delay = (ms, m = {}, { phase = "response", count = Infinity } = {}) => { rule("delay", m, { ms, phase, left: count }); return P; };
  P.refuse = (m = {}, { count = Infinity } = {}) => { rule("refuse", m, { left: count }); return P; };
  P.clear = () => { P.rules.length = 0; return P; };
  P.count = (prefix = "/") => P.log.filter(e => e.path.startsWith(prefix)).length;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", async () => {
      const e = { method: req.method, path: req.url, headers: req.headers, reqBody: Buffer.concat(chunks), json: null, status: null, resBody: null, resJson: null, action: "pass", at: Date.now() };
      try { e.json = JSON.parse(e.reqBody.toString("utf8")); } catch (x) {}
      P.log.push(e);
      const r = take(e); if (r) e.action = r.action;
      if (r && r.action === "refuse") { req.socket.destroy(); r.done(e); return; }
      if (r && r.action === "delay" && r.phase === "request") await sleep(r.ms);
      const h = {}; for (const [k, v] of Object.entries(req.headers)) if (!/^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade)$/i.test(k)) h[k] = v;
      h["content-length"] = e.reqBody.length;
      const up = http.request({ host: T.host, port: T.port, method: req.method, path: req.url, headers: h, agent: false }, ur => {
        const b = [];
        ur.on("data", d => b.push(d));
        ur.on("error", () => req.socket.destroy());
        ur.on("end", async () => {
          e.status = ur.statusCode; e.resBody = Buffer.concat(b);
          try { e.resJson = JSON.parse(e.resBody.toString("utf8")); } catch (x) {}
          if (r && r.action === "drop") {
            if (r.how === "hang") { hung.add(req.socket); setTimeout(() => req.socket.destroy(), 60000).unref(); } else req.socket.destroy();
            r.done(e); return;
          }
          if (r && r.action === "delay" && r.phase !== "request") await sleep(r.ms);
          if (req.socket.destroyed) return;
          const rh = {}; for (const [k, v] of Object.entries(ur.headers)) if (!/^(connection|keep-alive|transfer-encoding)$/i.test(k)) rh[k] = v;
          rh["content-length"] = e.resBody.length;
          res.writeHead(ur.statusCode, rh); res.end(e.resBody);
          if (r) r.done(e);
        });
      });
      up.on("error", err => { e.error = err.code || err.message; req.socket.destroy(); if (r) r.done(e); });
      up.setTimeout(60000, () => up.destroy(new Error("timeout")));
      up.end(e.reqBody);
    });
  });
  const item = trackServer(server, () => { for (const s of hung) s.destroy(); hung.clear(); });
  P.port = await listen(server);
  P.addr = `127.0.0.1:${P.port}`;
  P.close = item.close;
  return P;
}

// ---- рамка, как в окне Claude ---------------------------------------------------
// frameServer(appDir) — два сервера: файлы appDir на 127.0.0.1:Y (без XFO и CSP)
// и обёртка на localhost:X: /frame → <iframe src="http://127.0.0.1:Y/app.html">
// (другой источник, как у артефакта). /frame?account → app.html?account,
// /frame/index.html → другая страница. Запросы к файлам — в reqs.
// appFrame(page) — кадр приложения в странице Playwright. Образец — magnat/check.js.
async function frameServer(appDir = APP_DIR, { page = "app.html", sandbox = "", width = 390, height = 844 } = {}) {
  const F = { appDir: path.resolve(appDir), reqs: [] };
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json" };
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const app = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    F.reqs.push({ method: req.method, path: u.pathname, url: req.url, at: Date.now() });
    const no = (st) => { res.writeHead(st, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 2 }); res.end("no"); };
    if (req.method !== "GET" && req.method !== "HEAD") return no(405);
    let rel; try { rel = decodeURIComponent(u.pathname); } catch (e) { return no(400); }
    if (rel.endsWith("/")) rel += "index.html";
    rel = path.posix.normalize(rel);
    const file = path.join(F.appDir, rel);
    if (!file.startsWith(F.appDir + path.sep) || /(^|\/)\./.test(rel)) return no(404);
    let body; try { body = fs.readFileSync(file); } catch (e) { return no(404); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  const frame = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (!/^\/frame(\/|$)/.test(u.pathname)) { res.writeHead(404, { "Content-Length": 0 }); return res.end(); }
    const target = u.pathname.slice(6).replace(/^\/+/, "") || page;
    const src = `http://127.0.0.1:${F.appPort}/${target.split("/").map(encodeURIComponent).join("/")}${u.search}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>рамка</title><style>html,body{margin:0;background:#111}iframe{display:block;width:${+width}px;height:${+height}px;border:0}</style></head>` +
      `<body><iframe id="app" src="${esc(src)}"${sandbox ? ` sandbox="${esc(sandbox)}"` : ""}></iframe></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-store" });
    res.end(html);
  });
  const i1 = trackServer(app), i2 = trackServer(frame);
  F.appPort = await listen(app); F.framePort = await listen(frame);
  F.appOrigin = `http://127.0.0.1:${F.appPort}`;
  F.appUrl = `${F.appOrigin}/${page}`;
  F.frameUrl = (q = "") => `http://localhost:${F.framePort}/frame${q}`;
  F.url = F.frameUrl();
  F.appFrame = (pg) => pg.frames().find(f => f.url().startsWith(F.appOrigin + "/"));
  F.count = (prefix = "/api") => F.reqs.filter(r => r.path.startsWith(prefix)).length;
  F.close = () => Promise.all([i1.close(), i2.close()]);
  return F;
}

module.exports = { chromium, launch, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR, startClean,
  findCaddy, freePort, get, waitPort, request, postJson, rawHttp, sleep, tmpDir, cleanup,
  startCaddy, startApi, fakeSmtp, fakeDav, dropProxy, frameServer, parseMail, lastCode, waitCode };

// Подделка в своём процессе: node tests/lib.js --fake smtp|dav <папка>
if (require.main === module && process.argv[2] === "--fake") {
  const [kind, dir] = process.argv.slice(3);
  const ctl = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "ctl.json"), "utf8")); } catch (e) { return {}; } };
  const rec = (o) => fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(o) + "\n");
  const server = kind === "smtp" ? smtpServer(ctl, rec) : davServer(ctl, rec, path.join(dir, "root"));
  server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\n"));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}

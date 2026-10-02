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
//      01-scenarios и ловит).
// Caddy берётся из PATH, из CADDY= или скачивается с официального
// репозитория в node_modules/.cache (он в .gitignore).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), net = require("net");

const ROOT = path.join(__dirname, "..");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };
const sh = (cmd, opts = {}) => spawnSync("bash", ["-c", cmd], { encoding: "utf8", ...opts });

function findCaddy() {
  if (process.env.CADDY) return process.env.CADDY;
  const w = sh("command -v caddy"); if (w.status === 0) return w.stdout.trim();
  const cache = path.join(ROOT, "node_modules", ".cache", "caddy");
  const bin = path.join(cache, "usr", "bin", "caddy");
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cache, { recursive: true });
  const base = "https://dl.cloudsmith.io/public/caddy/stable/deb/debian";
  const r = sh(`set -e; cd "${cache}"
    f=$(curl -fsS ${base}/dists/any-version/main/binary-amd64/Packages | awk '/^Version: /{v=$2} /^Filename: /{print v, $2}' | sort -V | tail -1 | cut -d' ' -f2)
    curl -fsS -o caddy.deb "${base}/$f"; dpkg-deb -x caddy.deb .; rm -f caddy.deb`);
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

(async () => {
  const CADDY = findCaddy();
  const caddyVer = sh(`"${CADDY}" version`).stdout.split(" ")[0];
  console.log("  Caddy:", caddyVer);
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "magnat-srv-"));
  const bin = path.join(T, "bin"); fs.mkdirSync(bin);
  // systemctl здесь нет — подставляем двойника, который пишет, что его звали.
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> "${T}/systemctl.log"\nexit 0\n`, { mode: 0o755 });
  fs.symlinkSync(CADDY, path.join(bin, "caddy"));

  // ---- 1. Caddyfile --------------------------------------------------------
  console.log("\n1. server/Caddyfile");
  const v = sh(`"${CADDY}" validate --config server/Caddyfile --adapter caddyfile`, { cwd: ROOT });
  v.status === 0 ? ok("caddy validate — без ошибок") : bad("caddy validate: " + v.stderr.slice(-400));
  const f = sh(`"${CADDY}" fmt server/Caddyfile | diff -q - server/Caddyfile`, { cwd: ROOT });
  f.status === 0 ? ok("caddy fmt — отформатирован") : bad("Caddyfile не отформатирован: caddy fmt --overwrite server/Caddyfile");
  const sc = sh("command -v shellcheck >/dev/null && shellcheck -S style server/install.sh server/magnat.sh", { cwd: ROOT });
  if (sh("command -v shellcheck").status === 0) sc.status === 0 ? ok("shellcheck — чисто") : bad("shellcheck:\n" + sc.stdout);

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
    MAGNAT_CADDYFILE: CF, MAGNAT_DOMAIN: "magnat-test.invalid" };
  const deploy = (mode = "deploy", extra = {}) => spawnSync("bash", [path.join(ROOT, "server/magnat.sh"), mode], { encoding: "utf8", env: { ...env, ...extra } });
  const cur = () => { try { return path.basename(fs.readlinkSync(path.join(BASE, "current"))); } catch (e) { return ""; } };
  const live = (p) => fs.existsSync(path.join(BASE, "current", p));

  let r = deploy(), sha1 = head();
  cur() === sha1 ? ok("первая выкладка: current → " + sha1.slice(0, 7)) : bad("первая выкладка не встала: " + r.stdout + r.stderr);
  for (const p of ["index.html", "sw.js", "manifest.json", "icon.png", "app.html"]) if (!live(p)) bad("в выкладке нет " + p);
  const leaked = ["CLAUDE.md", "README.md", "tests", "server", "_config.yml", "CNAME", ".gitignore"].filter(live);
  leaked.length ? bad("в выкладку попало служебное: " + leaked.join(", ")) : ok("служебного в выкладке нет (CLAUDE.md, tests/, server/, _config.yml, CNAME, .gitignore)");
  fs.readFileSync(path.join(STATE, "fetch-how"), "utf8").includes("открыт") ? ok("ключа нет — взял открыто, как и должен до закрытия репозитория") : bad("fetch-how: " + fs.readFileSync(path.join(STATE, "fetch-how"), "utf8"));

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

    // ---- 4. приложение целиком под этими заголовками ------------------------
    console.log("\n4. 01-scenarios на этом Caddy (CSP не должна ломать ни одной кнопки)");
    const s = spawnSync(process.execPath, [path.join(__dirname, "01-scenarios.js")], { encoding: "utf8", timeout: 600000, env: { ...process.env, MAGNAT_URL: `http://127.0.0.1:${P}/` } });
    const out = (s.stdout || "") + (s.stderr || "");
    const failsIn = out.split("\n").filter(l => l.includes("✗"));
    const csp = out.split("\n").filter(l => /Content Security Policy|Refused to/.test(l));
    if (csp.length) bad("нарушения CSP:\n    " + csp.slice(0, 5).join("\n    "));
    s.status === 0 && !failsIn.length ? ok("01-scenarios на сервере — чисто (" + (out.match(/✓/g) || []).length + " проверок)")
      : bad(`01-scenarios на сервере (код ${s.status}):\n    ` + (failsIn.length ? failsIn : out.trim().split("\n").slice(-6)).slice(0, 8).join("\n    "));
  } finally {
    caddy.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(T, { recursive: true, force: true });
  }

  console.log(fails ? `\n✗ server: ${fails} проблем` : "\nserver: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

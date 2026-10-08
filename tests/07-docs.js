// Тарифы, соглашение, политика и поддержка (07.10.2026) — их требует платёжный
// сервис до согласования проекта. Что сторожится:
//   1. страницы на месте, контакт поддержки вписан (заглушка @@SUPPORT@@ — красное:
//      без контакта модерацию не пройти), ссылки ведут на существующие файлы;
//   2. цена одна во всех документах — разъехавшаяся цена в документе, который
//      клиент принимает до оплаты, — проигранный спор с банком;
//   3. обещания политики правдивы: приложение ничего не отправляет наружу и не
//      ставит cookie. Добавил аналитику или запрос к серверу — сначала политика;
//   4. страницы в браузере: без ошибок под той же CSP, что на сервере (берётся из
//      server/Caddyfile), свой шрифт, без прокрутки вбок на 320–1280;
//   5. в приложении ссылки на всё это — в приветствии и внизу «Обзора».
const { chromium, chromePath, APP_DIR } = require("./lib");
const fs = require("fs"), path = require("path"), http = require("http");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };

const DOCS = ["pricing.html", "terms.html", "privacy.html"];
const SITE = "https://magnat-planer.ru/";
const read = f => fs.readFileSync(path.join(APP_DIR, f), "utf8");
const app = read("app.html");
const land = read("index.html");   // продающая страница — те же обещания политики

function serve(root, csp) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
  return new Promise(res => {
    const s = http.createServer((rq, rs) => {
      let f = decodeURIComponent(rq.url.split(/[?#]/)[0]); if (f === "/") f = "/index.html";
      const p = path.join(root, path.normalize(f).replace(/^(\.\.[/\\])+/, ""));
      fs.readFile(p, (e, d) => {
        if (e) { rs.writeHead(404); rs.end(); return; }
        rs.writeHead(200, { "Content-Type": types[path.extname(p)] || "text/plain", "Content-Security-Policy": csp });
        rs.end(d);
      });
    }).listen(0, "127.0.0.1", () => res(s));
  });
}

(async () => {
  // ---- 1. Страницы и контакт ------------------------------------------------
  console.log("\n1. Страницы на месте, контакт поддержки вписан");
  const missing = DOCS.concat(["doc.css", "fonts/manrope.woff2"]).filter(f => !fs.existsSync(path.join(APP_DIR, f)));
  missing.length ? bad("нет файлов: " + missing.join(", ")) : ok("тарифы, соглашение, политика, стиль и шрифт — на месте");
  const stub = DOCS.filter(f => /@@\w+@@/.test(read(f)));
  stub.length ? bad("контакт поддержки не вписан (заглушка @@SUPPORT@@): " + stub.join(", ")) : ok("контакт поддержки вписан во все страницы");
  const hrefs = DOCS.map(f => [f, [...read(f).matchAll(/href="([^"]*)"/g)].map(m => m[1])]);
  const support = new Set(), broken = [];
  for (const [f, list] of hrefs) for (const h of list) {
    if (/^(mailto:|https:\/\/t\.me\/)/.test(h)) { support.add(h); continue; }
    if (h === "/" || /@@\w+@@/.test(h)) continue;   // заглушка — уже названа выше
    const file = h.split("#")[0];
    if (/^[a-z]+:/i.test(h) || !file || !fs.existsSync(path.join(APP_DIR, file))) broken.push(f + " → " + h);
  }
  broken.length ? bad("ссылки в никуда: " + broken.join(", ")) : ok("все ссылки страниц ведут на существующие файлы");
  support.size === 1 ? ok("контакт поддержки один на всех страницах: " + [...support][0])
    : bad("контактов поддержки " + support.size + " (нужен один, почта mailto: или https://t.me/): " + [...support].join(", "));
  const linked = DOCS.every(f => DOCS.every(g => hrefs.find(([x]) => x === f)[1].includes(g)));
  linked ? ok("с каждой страницы видны все три") : bad("в подвале не все документы");

  // ---- 2. Цена одна везде ---------------------------------------------------
  console.log("\n2. Цена одна во всех документах");
  const prices = {};
  for (const f of DOCS) for (const m of read(f).matchAll(/data-price="(\w+)"[^>]*>([^<]+)</g)) (prices[m[1]] = prices[m[1]] || new Set()).add(m[2].replace(/\s+/g, " ").trim());
  const want = { month: "299 ₽", year: "1 490 ₽" };
  const diff = Object.entries(want).filter(([k, v]) => !prices[k] || prices[k].size !== 1 || ![...prices[k]][0].startsWith(v));
  diff.length ? bad("цены разъехались: " + JSON.stringify(Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, [...v]]))))
    : ok("месяц 299 ₽, год 1 490 ₽ — одинаково в тарифах и соглашении");
  const yearly = read("pricing.html");
  /≈ 124 ₽ в месяц/.test(yearly) && /на 58% дешевле/.test(yearly) ? ok("годовой: ≈ 124 ₽ в месяц, на 58% дешевле — сходится с 1 490 / 12 и 299 × 12")
    : bad("пересчёт годового тарифа на странице не совпадает с ценой");

  // ---- 3. Обещания политики правдивы -----------------------------------------
  console.log("\n3. Политика говорит правду о приложении");
  for (const [name, src] of [["приложении", app], ["продающей странице", land]]) {
    // canonical и alternate — адрес страницы для поисковиков, браузер по ним ничего не грузит
    const leaks = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /document\.cookie/, /new\s+WebSocket/, /<script[^>]+src=/i, /<link(?![^>]*rel="(?:canonical|alternate)")[^>]+href="https?:/i, /<img[^>]+src="https?:/i]
      .filter(re => re.test(src)).map(String);
    leaks.length ? bad("в " + name + " есть запрос наружу, cookie или чужой скрипт (" + leaks.join(", ") + ") — а политика обещает обратное; сначала поправь privacy.html")
      : ok("в " + name + " нет запросов наружу, cookie и чужих скриптов — как написано в политике");
  }
  const cf = read("server/Caddyfile");
  /Журнал запросов не ведём/.test(cf) && !/^\s*log\b/m.test(cf) ? ok("журнал посещений на сервере выключен — как написано в политике")
    : bad("в server/Caddyfile включён журнал запросов — политика обещает, что его нет");
  const font = app.match(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/);
  font && Buffer.from(font[1], "base64").equals(fs.readFileSync(path.join(APP_DIR, "fonts/manrope.woff2")))
    ? ok("шрифт страниц — тот же, что встроен в приложение") : bad("fonts/manrope.woff2 разошёлся со шрифтом приложения");
  const tok = s => Object.fromEntries([...s.matchAll(/--(bg|bg2|panel|panel2|line|line2|emerald|gold|ink|mut|mut2):\s*(#[0-9a-f]+)/gi)].map(m => [m[1], m[2].toLowerCase()]));
  const ta = tok(app.slice(0, app.indexOf("</style>"))), td = tok(read("doc.css"));
  const off = Object.keys(td).filter(k => ta[k] !== td[k]);
  off.length ? bad("цвета страниц разошлись с приложением: " + off.map(k => `--${k} ${td[k]} ≠ ${ta[k]}`).join(", ")) : ok(`цвета страниц — из приложения (${Object.keys(td).length} токенов)`);

  // ---- 4. Страницы в браузере --------------------------------------------------
  console.log("\n4. Страницы в браузере под CSP сервера");
  const csp = (cf.match(/Content-Security-Policy "([^"]+)"/) || [])[1];
  if (!csp) bad("CSP в server/Caddyfile не найдена");
  const srv = await serve(APP_DIR, csp || "");
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch({ executablePath: chromePath() });
  try {
    for (const f of DOCS) {
      const probs = [];
      for (const w of [320, 390, 1280]) {
        const ctx = await b.newContext({ viewport: { width: w, height: 800 } });
        const p = await ctx.newPage(), errs = [];
        p.on("pageerror", e => errs.push(e.message));
        p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
        p.on("requestfailed", r => errs.push("не загрузилось " + r.url()));
        await p.goto(base + f); await p.evaluate(() => document.fonts.ready);
        const r = await p.evaluate(() => ({ sx: document.documentElement.scrollWidth - innerWidth, font: document.fonts.check('16px "Manrope"') && [...document.fonts].some(x => x.family.includes("Manrope") && x.status === "loaded"),
          h1: !!document.querySelector("h1"), title: document.title, lang: document.documentElement.lang,
          small: [...document.querySelectorAll("header a, .toapp")].filter(a => a.getBoundingClientRect().height < 44).length }));
        if (errs.length) probs.push(`${w}px: ` + errs.slice(0, 2).join(" | "));
        if (r.sx > 0) probs.push(`${w}px: прокрутка вбок на ${r.sx}px`);
        if (!r.font) probs.push(`${w}px: Manrope не загрузился`);
        if (!r.h1 || !/Магнат/.test(r.title) || r.lang !== "ru") probs.push("нет заголовка, названия или lang=ru");
        if (w === 390 && r.small) probs.push("кнопки шапки ниже 44 px");
        await ctx.close();
      }
      probs.length ? bad(f + ": " + probs.join("; ")) : ok(f + ": 320 / 390 / 1280 — без ошибок и прокрутки вбок, свой шрифт, CSP не мешает");
    }

    // ---- 5. Ссылки в приложении ----------------------------------------------
    console.log("\n5. В приложении — ссылки на тарифы, документы и поддержку");
    const ctx = await b.newContext({ viewport: { width: 320, height: 700 } });
    const p = await ctx.newPage(), errs = [];
    p.on("pageerror", e => errs.push(e.message));
    await p.goto(base + "app.html"); await p.waitForTimeout(400);
    const want5 = ["pricing.html", "terms.html", "privacy.html", "pricing.html#support"].map(x => SITE + x);
    const links = sel => p.$$eval(sel + " .legal a", as => as.map(a => ({ h: a.getAttribute("href"), t: a.target, r: a.rel, vis: a.getBoundingClientRect().height >= 32 })));
    const ob = await links(".modal");
    JSON.stringify(ob.map(a => a.h)) === JSON.stringify(want5) && ob.every(a => a.t === "_blank" && /noopener/.test(a.r) && a.vis)
      ? ok("приветствие: Тарифы · Соглашение · Конфиденциальность · Поддержка — полный адрес, новая вкладка")
      : bad("ссылки в приветствии: " + JSON.stringify(ob));
    const sx0 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await p.click("#obDemo"); await p.waitForTimeout(500);
    const home = await links("main");
    JSON.stringify(home.map(a => a.h)) === JSON.stringify(want5) ? ok("внизу «Обзора» — те же четыре ссылки") : bad("ссылки внизу «Обзора»: " + JSON.stringify(home));
    const sx1 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    !errs.length && sx0 <= 0 && sx1 <= 0 ? ok("на 320 px без ошибок и прокрутки вбок") : bad(`ошибки или прокрутка вбок: ${errs.join(" | ")} (${sx0}/${sx1}px)`);
    const files = want5.map(u => u.slice(SITE.length).split("#")[0]).filter(f => !fs.existsSync(path.join(APP_DIR, f)));
    files.length ? bad("ссылки приложения ведут на несуществующие страницы: " + files.join(", ")) : ok("каждая ссылка приложения — на существующую страницу сайта");
    await ctx.close();
  } finally {
    await b.close(); srv.close();
  }

  console.log(fails ? `\n✗ docs: ${fails} проблем` : "\ndocs: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

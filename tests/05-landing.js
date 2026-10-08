// Продающая страница — главная сайта (index.html) с 08.10.2026; приложение — app.html.
// Сторожит то, что делает страницу ЧЕСТНОЙ и ПЕРЕДЕЛЫВАЕМОЙ:
//   1) правила игры, уроки, книги и звания на странице — те же, что в app.html (разошлись — красное);
//   2) цена живёт в одном месте (CFG) и совпадает с тарифами (pricing.html);
//   3) мини-игра и телефон на первом экране считают ровно как приложение;
// то, без чего она не выглядит премиальной:
//   4) свой шрифт загрузился, контраст текста по WCAG AA;
//   5) ширины 320–1440 без прокрутки вбок, надписи кнопок в строку, пальцу хватает места;
//   6) блоки проявляются при прокрутке и ни один не остаётся пустым; «меньше движения» — всё сразу;
// и путь клиента:
//   7) значок на экране «Домой» и кто уже пользуется — сразу в приложение; ?site — страница;
//   8) «Начать бесплатно» → сразу выбор привычек, «Посмотреть пример» → сразу пример, чужие данные целы;
//   9) ссылки, картинки, обложка ссылки, вес, ошибок нет.
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path"), http = require("http");
const { chromePath, APP_FILE } = require("./lib");

const ROOT = path.join(__dirname, "..");
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ПРОВАЛ: ") + msg); if (!cond) fails++; };

// правила и тексты приложения — прямо из app.html, а не переписанные сюда руками
function appData() {
  const s = fs.readFileSync(APP_FILE, "utf8");
  const grab = (re, what) => { const m = s.match(re); if (!m) throw new Error("в app.html не нашлось: " + what); return m[1]; };
  const arr = name => {   // массив-литерал целиком, со вложенными скобками
    const at = s.indexOf(`const ${name}=[`); if (at < 0) throw new Error("в app.html не нашлось: " + name);
    let i = s.indexOf("[", at), d = 0;
    for (let j = i; j < s.length; j++) { if (s[j] === "[") d++; else if (s[j] === "]" && --d === 0) return (0, eval)("(" + s.slice(i, j + 1) + ")"); }
    throw new Error("не закрыт массив " + name);
  };
  return {
    COIN: +grab(/const COIN=(\d+);/, "COIN"),
    DAYOK: +grab(/DAYOK=(\d+);/, "DAYOK"),
    LVLBONUS: +grab(/const LVLBONUS=(\d+);/, "LVLBONUS"),
    mult: eval(grab(/const mult=(s=>[^;]+);/, "mult")),
    xpForLevel: eval(grab(/const xpForLevel=(L=>\{[^}]+\});/, "xpForLevel")),
    RANKS: arr("RANKS").map(r => r.slice(0, 3)),
    PICK: arr("HABITPICK").filter(h => h[2]).map(h => h.slice(0, 2)),
    STAGES: arr("STAGES"), STAGEME: arr("STAGEME"), LESSONS: arr("LESSONS"),
  };
}

// контраст по WCAG: относительная яркость цветов «#rrggbb»
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// страница открывается через свой веб-сервер, как у клиента: с диска браузер не пускает
// предзагрузку шрифта и не отвечает 404 на битую ссылку
const MIME = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
function serve() {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(new URL(q.url, "http://x").pathname); if (p === "/") p = "/index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(f).pipe(r);
  });
  return new Promise(res => srv.listen(0, "127.0.0.1", () => res(srv)));
}

(async () => {
  const app = appData();
  const srv = await serve(), BASE = `http://127.0.0.1:${srv.address().port}/`, PAGE = BASE + "?site";
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "reduce", isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  p.on("response", r => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`); });
  // свежая страница сверху: reload() возвращает прежнюю прокрутку, и «первый экран» уже не первый
  const fresh = async (u = BASE) => { await p.goto("about:blank"); await p.goto(u); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(150); };
  await fresh();

  // ── 1) правила, уроки, книги ─────────────────────────────────────────────
  console.log("\n1) Игра на странице = игра в приложении");
  const land = await p.evaluate(() => ({
    COIN: RULES.COIN, DAYOK: RULES.DAYOK, LVLBONUS: RULES.LVLBONUS,
    mult: Array.from({ length: 16 }, (_, s) => RULES.mult(s)),
    xp: Array.from({ length: 40 }, (_, i) => RULES.xpForLevel(i + 1)),
    RANKS: RULES.RANKS, HABITS, PATH, LESSON2, BOOKS,
    card: ["lT", "lB", "lI", "lP"].map(id => document.getElementById(id).textContent.trim()),
    ladder: document.querySelectorAll("#ladder .rung").length,
  }));
  ok(land.COIN === app.COIN && land.DAYOK === app.DAYOK && land.LVLBONUS === app.LVLBONUS,
    `монеты за привычку ${land.COIN}, отметок для серии ${land.DAYOK}, за уровень ${land.LVLBONUS} — как в приложении (${app.COIN}/${app.DAYOK}/${app.LVLBONUS})`);
  ok(land.mult.every((m, s) => m === app.mult(s)), "множитель серии совпадает с приложением (0–15 дней)");
  ok(land.xp.every((x, i) => x === app.xpForLevel(i + 1)), "опыт до уровня совпадает с приложением (1–40)");
  ok(JSON.stringify(land.RANKS) === JSON.stringify(app.RANKS), "звания и их уровни совпадают с приложением");
  ok(JSON.stringify(land.HABITS) === JSON.stringify(app.PICK), "привычки мини-игры и телефона = отмеченные при старте приложения");
  // урок N открывается на N-м уровне — значит, урок i относится к званию уровня i
  const rankAt = L => { let r = 0; app.RANKS.forEach((x, i) => { if (L >= x[2]) r = i; }); return r; };
  const want = app.STAGES.map((st, i) => [st, app.STAGEME[i], app.LESSONS.filter((_, j) => rankAt(j + 1) === i).map(l => l.t)]);
  const bad1 = want.map((w, i) => JSON.stringify(w) === JSON.stringify(land.PATH[i]) ? "" : app.RANKS[i][1]).filter(Boolean);
  ok(!bad1.length && land.PATH.length === app.STAGES.length && land.ladder === app.RANKS.length,
    `Путь: темы, «кем становишься» и уроки по званиям — как в приложении (${app.LESSONS.length} уроков)` + (bad1.length ? " — разошлись: " + bad1.join(", ") : ""));
  const l1 = app.LESSONS[0], l2 = app.LESSONS[1];
  ok(JSON.stringify(land.card) === JSON.stringify([l1.t, `«${l1.b}» — ${l1.a}`, l1.i, l1.p]), `карточка урока = урок 1 приложения («${l1.t}»)`);
  ok(JSON.stringify(land.LESSON2) === JSON.stringify([l2.t, l2.b, l2.a]), `в телефоне открывается урок 2 приложения («${l2.t}»)`);
  const appBooks = [...new Set(app.LESSONS.map(l => l.b + " — " + l.a))].sort(), landBooks = land.BOOKS.map(x => x[0] + " — " + x[1]).sort();
  ok(JSON.stringify(appBooks) === JSON.stringify(landBooks), `книги на странице = книги уроков (${appBooks.length})`);
  const txt = () => p.evaluate(() => document.body.innerText.replace(/ /g, " "));
  let t = await txt();
  ok(t.includes(`${app.LESSONS.length} уроков из ${appBooks.length} книг`), `«${app.LESSONS.length} уроков из ${appBooks.length} книг» — число сходится с приложением`);

  // ── 2) цена ──────────────────────────────────────────────────────────────
  console.log("\n2) Цена из одного места и та же, что в тарифах");
  const cfg = await p.evaluate(() => ({ ...CFG }));
  const nf = n => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ");
  const pricing = fs.readFileSync(path.join(ROOT, "pricing.html"), "utf8").replace(/&nbsp;| /g, " ");
  const pp = k => ((pricing.match(new RegExp(`data-price="${k}"[^>]*>([^<]+)`)) || [])[1] || "").replace(/\s+/g, " ").trim();
  ok(pp("month").startsWith(`${nf(cfg.month)} ₽`) && pp("year").startsWith(`${nf(cfg.year)} ₽`) && new RegExp(`${cfg.trialDays} (дней|дня|день)`).test(pricing),
    `CFG = тарифы: ${cfg.month} ₽ в месяц, ${nf(cfg.year)} ₽ в год, ${cfg.trialDays} дней бесплатно`);
  ok(t.includes(`${nf(cfg.year)} ₽`) && t.includes(`${nf(cfg.month)} ₽`), "цены из CFG — на странице");
  ok(/Оплата на сайте подключается/.test(t) && /открыт целиком и бесплатно/.test(t), "честная плашка: оплата подключается, пока всё бесплатно (как в тарифах)");
  await p.evaluate(() => { CFG.month = 399; CFG.year = 2990; CFG.trialDays = 3; CFG.start = "./x?start"; fillPrices(); });
  t = await txt();
  const stale = await p.evaluate(() => [...document.querySelectorAll('[data-app="start"]')].filter(a => a.getAttribute("href") !== "./x?start").length);
  ok(t.includes("399 ₽") && t.includes("2 990 ₽") && !t.includes("299 ₽") && !t.includes("1 490"), "сменил цену в CFG — сменилась везде");
  const trials = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-k="trial"]')].map(e => e.textContent.replace(/\u00a0/g, " ")))]);
  ok(t.includes("Сначала 3 дня бесплатно") && t.includes("3 дня бесплатно, затем 2 990 ₽ в год") && JSON.stringify(trials) === '["3 дня"]' && !/7 дней бесплатно/.test(t),
    "сменил пробный срок в CFG — сменился везде, и в вопросах (и склонение): " + JSON.stringify(trials));
  ok(stale === 0, "сменил адрес в CFG — все «Начать бесплатно» ведут туда");
  await fresh();
  const note = () => p.evaluate(() => document.getElementById("pNote").textContent.replace(/ /g, " ").trim());
  const n0 = await note(); await p.click('[data-plan="month"]');
  const n1 = await note(), chk = await p.evaluate(() => [...document.querySelectorAll("[data-plan]")].map(x => x.getAttribute("aria-checked")).join(","));
  await p.click('[data-plan="year"]'); const n2 = await note();
  ok(n0.includes(`${nf(cfg.year)} ₽ в год`) && n1.includes(`${nf(cfg.month)} ₽ в месяц`) && n2 === n0 && chk === "false,true",
    `тариф переключается: год → «${n0}» · месяц → «${n1}»`);

  // ── 3) мини-игра и телефон считают как приложение ─────────────────────────
  console.log("\n3) Мини-игра и телефон на первом экране");
  let xp = 0, streak = 0;
  for (let d = 0; d < 7; d++) { xp += Math.round(3 * app.COIN * app.mult(streak)); streak++; }
  let L = 1; while (app.xpForLevel(L + 1) <= xp) L++;
  const coins = xp + (L - 1) * app.LVLBONUS;
  const cells = await p.$$(".cell");
  ok(cells.length === 21 && await p.evaluate(() => !!document.querySelector(".cell.hint")), `клеток ${cells.length} (3 привычки × 7 дней), первая подсказывает, куда нажать`);
  for (const c of cells) await c.click();
  await p.waitForTimeout(300);
  const shown = await p.evaluate(() => ({ coins: document.getElementById("dCoins").textContent.replace(/\D/g, ""),
    lv: document.getElementById("dLv").textContent, fin: getComputedStyle(document.getElementById("dFin")).display, hint: !!document.querySelector(".cell.hint") }));
  ok(shown.coins === String(coins) && shown.lv === `Уровень ${L}`, `вся неделя: ${shown.coins} монет и «${shown.lv}» — по правилам приложения ${coins} и уровень ${L}`);
  ok(shown.fin !== "none" && !shown.hint, "после недели — кнопка «Начать по-настоящему», подсказка ушла");
  await cells[0].click(); await p.waitForTimeout(200);
  ok(+(await p.evaluate(() => document.getElementById("dCoins").textContent.replace(/\D/g, ""))) < coins, "сняли галочку — монет стало меньше");
  // «меньше движения»: телефон стоит на готовом первом дне — три отметки, 60 монет
  const still = await p.evaluate(() => ({ done: document.getElementById("maDone").textContent, coins: document.getElementById("maCoins").textContent }));
  ok(still.done === "3" && still.coins === String(3 * app.COIN), `«меньше движения»: телефон без анимации, первый день закрыт (${still.done} из 3, ${still.coins} монет)`);
  {
    // с анимацией: два дня новичка — на второй отметке второго дня уровень 2, +50 и урок 2
    const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "no-preference" });
    const q = await c2.newPage(); await q.goto(PAGE);
    const d1 = 3 * app.COIN, d2two = Math.round(2 * app.COIN * app.mult(1));
    const expXp = d1 + d2two, expL = (() => { let l = 1; while (app.xpForLevel(l + 1) <= expXp) l++; return l; })();
    let seen = null;
    try {
      await q.waitForSelector("#maLvUp.on", { timeout: 20000 });
      await q.waitForTimeout(900);
      seen = await q.evaluate(() => ({ lv: document.getElementById("maLv").textContent, coins: document.getElementById("maCoins").textContent.replace(/\D/g, ""),
        les: document.getElementById("luL").textContent, day: document.getElementById("maDay").textContent }));
    } catch (e) { seen = { err: e.message }; }
    ok(seen && seen.lv === `Ур. ${expL}` && seen.coins === String(expXp + (expL - 1) * app.LVLBONUS) && seen.les === app.LESSONS[1].t && /день 2/.test(seen.day),
      `телефон: день 1 + две отметки дня 2 = ${expXp} опыта → «Ур. ${expL}», ${expXp + (expL - 1) * app.LVLBONUS} монет, урок «${app.LESSONS[1].t}» — ${JSON.stringify(seen)}`);
    await c2.close();
  }

  // ── 4) шрифт и контраст ──────────────────────────────────────────────────
  console.log("\n4) Шрифт и контраст");
  const font = await p.evaluate(() => ({
    loaded: [...document.fonts].filter(f => f.family.replace(/"/g, "") === "Manrope" && f.status === "loaded").length,
    h1: getComputedStyle(document.querySelector("h1")).fontFamily, check: document.fonts.check('800 40px "Manrope"', "Хватит"),
  }));
  ok(font.loaded >= 1 && font.check && /^"?Manrope/.test(font.h1), "шрифт Manrope загружен и стоит первым у заголовка");
  ok(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").includes('href="fonts/manrope.woff2"'), "шрифт — тот же файл, что у тарифов и документов (fonts/manrope.woff2)");
  const css = await p.evaluate(() => { const s = getComputedStyle(document.documentElement); return ["--bg", "--surface", "--surface-2", "--ink", "--ink-2", "--mut", "--dim", "--accent", "--gold"].reduce((o, k) => (o[k] = s.getPropertyValue(k).trim(), o), {}); });
  const pairs = [["--mut", "--bg"], ["--mut", "--surface-2"], ["--dim", "--bg"], ["--dim", "--surface"], ["--dim", "--surface-2"], ["--ink-2", "--surface-2"], ["--accent", "--bg"], ["--gold", "--surface"]];
  const weak = pairs.map(([f, g]) => [f, g, ratio(hex(css[f]), hex(css[g]))]).filter(x => x[2] < 4.5);
  ok(!weak.length, "контраст текста ≥ 4,5 (WCAG AA) для всех пар цветов" + (weak.length ? ": " + weak.map(w => `${w[0]} на ${w[1]} — ${w[2].toFixed(2)}`).join(", ") : ""));
  ok(ratio(hex("#03150c"), hex(css["--accent"])) >= 7, "текст на зелёной кнопке читается (контраст ≥ 7)");

  // ── 5) ширины и кнопки ───────────────────────────────────────────────────
  console.log("\n5) Ширины 320–1440");
  // 960–1200 — отдельно: там две колонки самые тесные (08.10 значок у телефона вылезал за край на 1040–1200)
  for (const w of [320, 360, 390, 430, 768, 960, 1024, 1100, 1180, 1280, 1440]) {
    await p.setViewportSize({ width: w, height: 820 }); await fresh(PAGE);
    const m = await p.evaluate(() => {
      const vis = e => e.offsetParent || getComputedStyle(e).position === "fixed";
      const lines = b => { const r = document.createRange(); r.selectNodeContents(b);
        const tops = [...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top)).sort((a, c) => a - c);
        let n = tops.length ? 1 : 0; for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 8) n++; return n; };
      // текст, вылезающий за край экрана (кроме бегущей строки и ленты экранов — там прокрутка своя)
      const over = [...document.querySelectorAll("h1,h2,h3,p,li,a,button,summary,.chip,.badge")].filter(e => vis(e) && !e.closest(".marquee,.shots,.ma,.sticky"))
        .filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(e => (e.className || e.tagName) + ":" + e.textContent.trim().slice(0, 24));
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, over,
        cell: Math.min(...[...document.querySelectorAll(".cell")].map(c => c.getBoundingClientRect().height)),
        tap: Math.min(...[...document.querySelectorAll(".btn, .plan, summary, .nav .brand, .task")].filter(vis).map(e => e.getBoundingClientRect().height)),
        broken: [...document.querySelectorAll(".btn")].filter(vis).map(b => [b.textContent.trim(), lines(b)]).filter(x => x[1] > 1),
        h1: lines(document.querySelector("h1 .grad")) };
    });
    ok(m.sw <= m.iw && !m.over.length && m.cell >= 30 && m.tap >= 44 && !m.broken.length && m.h1 === 1,
      `${w} px: без прокрутки вбок (${m.sw}/${m.iw}), клетка ${Math.round(m.cell)} px, кнопки от ${Math.round(m.tap)} px, надписи в строку, «с понедельника» одной строкой` +
      (m.over.length ? " — за краем: " + m.over.slice(0, 4).join(", ") : "") + (m.broken.length ? " — разваливаются: " + m.broken.map(([s, n]) => `«${s}» ${n}`).join(", ") : "") + (m.h1 !== 1 ? ` — «с понедельника» в ${m.h1} строки` : ""));
  }

  // ── 6) липкая кнопка и появление при прокрутке ───────────────────────────
  console.log("\n6) Липкая кнопка, появление при прокрутке");
  await p.setViewportSize({ width: 390, height: 844 }); await fresh(PAGE);
  const stickyOn = () => p.evaluate(() => document.getElementById("sticky").classList.contains("on"));
  ok(!(await stickyOn()), "липкая кнопка не видна на первом экране (там своя)");
  await p.evaluate(() => document.getElementById("inside").scrollIntoView()); await p.waitForTimeout(300);
  ok(await stickyOn(), "липкая кнопка видна посреди страницы");
  for (const c of (await p.$$(".cell")).slice(0, 7)) await c.click();
  await p.evaluate(() => { const f = document.getElementById("dFin"); scrollTo(0, f.getBoundingClientRect().top + scrollY - 300); }); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "у кнопки после мини-игры липкая прячется");
  await p.evaluate(() => document.getElementById("price").scrollIntoView()); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "у тарифов липкая кнопка прячется (там своя)");
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "в конце страницы липкая кнопка не видна (там финальная кнопка)");
  {
    const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "no-preference" });
    const q = await c2.newPage(); await q.goto(PAGE);
    const hiddenAtStart = await q.evaluate(() => [...document.querySelectorAll("[data-reveal]")].filter(e => getComputedStyle(e).opacity === "0").length);
    const H = await q.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y <= H; y += 500) { await q.evaluate(v => scrollTo(0, v), y); await q.waitForTimeout(110); }
    await q.waitForTimeout(1600);
    const left = await q.evaluate(() => [...document.querySelectorAll("[data-reveal]")].filter(e => !e.classList.contains("in") || getComputedStyle(e).opacity !== "1").length);
    const line = await q.evaluate(() => +getComputedStyle(document.querySelector(".steps-line")).getPropertyValue("--p"));
    ok(hiddenAtStart > 0 && left === 0, `появление при прокрутке: ${hiddenAtStart} блоков ждут своей очереди, после прокрутки скрытых — ${left}`);
    ok(line > .9, `линия шагов дорисовалась при прокрутке (${line})`);
    await c2.close();
  }
  {
    const c3 = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "reduce" });
    const q = await c3.newPage(); await q.goto(PAGE);
    const hid = await q.evaluate(() => [...document.querySelectorAll("[data-reveal]")].filter(e => getComputedStyle(e).opacity !== "1").length);
    ok(hid === 0, "«меньше движения»: всё видно сразу, без прокрутки-проявления");
    await c3.close();
  }

  // ── 7) кто открыл значком или уже пользуется — сразу в приложение ────────
  console.log("\n7) Значок и вернувшийся — сразу в приложение");
  {
    const c4 = await b.newContext({ viewport: { width: 390, height: 844 } });
    const q = await c4.newPage();
    await q.goto(BASE); await q.waitForTimeout(300);
    ok(await q.evaluate(() => location.pathname === "/" && !!document.querySelector("h1")), "новый человек на «/» видит продающую страницу");
    await q.evaluate(() => localStorage.setItem("magnat_app_v2", JSON.stringify({ habits: [] })));
    await q.goto(BASE); await q.waitForTimeout(500);
    ok(await q.evaluate(() => location.pathname === "/app.html" && !!document.querySelector("#tabs")), "есть данные Магната — «/» сразу открывает приложение");
    await q.goto(BASE + "?site"); await q.waitForTimeout(300);
    ok(await q.evaluate(() => location.pathname === "/" && !!document.querySelector("h1")), "?site — страница видна и с данными (владельцу для проверки)");
    await c4.close();
    // «Назад» из приложения возвращает на страницу, а не крутит по кругу обратно в приложение
    {
      const cb = await b.newContext({ viewport: { width: 390, height: 844 } });
      const qb = await cb.newPage();
      await qb.goto(BASE); await qb.click("#heroCta"); await qb.waitForSelector("#hpGo"); await qb.click("#hpGo");
      await qb.waitForSelector(".lesm .ok"); await qb.click(".lesm .ok"); await qb.waitForTimeout(300);
      await qb.goBack(); await qb.waitForTimeout(800);
      const back = await qb.evaluate(() => location.pathname + (document.querySelector("h1") ? " (страница)" : "") + (document.querySelector("#tabs") ? " (приложение)" : ""));
      ok(back === "/ (страница)", `«Назад» из приложения — на страницу, без петли обратно (${back})`);
      await cb.close();
    }
    const c5 = await b.newContext({ viewport: { width: 390, height: 844 } });
    await c5.addInitScript(() => Object.defineProperty(Navigator.prototype, "standalone", { get: () => true }));
    const q5 = await c5.newPage(); await q5.goto(BASE); await q5.waitForTimeout(500);
    ok(await q5.evaluate(() => location.pathname === "/app.html"), "старый значок на экране «Домой» (вёл на «/») — открывает приложение");
    await c5.close();
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
    ok(man.start_url === "./app.html" && man.id === "/" && man.scope === "./", "манифест: новый значок — сразу app.html, id прежний (это тот же Магнат, не второе приложение)");
  }

  // ── 8) кнопки страницы ведут в приложение правильно ──────────────────────
  console.log("\n8) «Начать бесплатно» и «Посмотреть пример»");
  {
    const c6 = await b.newContext({ viewport: { width: 390, height: 844 } });
    const q = await c6.newPage(); const e6 = []; q.on("pageerror", e => e6.push(e.message));
    await q.goto(BASE); await q.click("#heroCta"); await q.waitForTimeout(700);
    const st = await q.evaluate(() => ({ path: location.pathname + location.search, pick: !!document.querySelector("#hpGo"), welcome: !!document.querySelector("#obFresh") }));
    ok(st.path === "/app.html" && st.pick && !st.welcome, `«Начать бесплатно» → сразу выбор привычек, адрес очищен (${st.path})`);
    await q.click("#hpNo"); await q.waitForTimeout(300);
    ok(await q.evaluate(() => !!document.querySelector("#obFresh")), "передумал в выборе — окно «с чего начнём», как раньше");
    await q.click("#obFresh"); await q.click("#hpGo"); await q.waitForSelector(".lesm .ok"); await q.click(".lesm .ok"); await q.waitForTimeout(300);
    const saved = await q.evaluate(() => JSON.parse(localStorage.getItem("magnat_app_v2")).habits.length);
    await q.goto(BASE + "app.html?start"); await q.waitForTimeout(600);
    const again = await q.evaluate(() => ({ pick: !!document.querySelector("#hpGo"), n: JSON.parse(localStorage.getItem("magnat_app_v2")).habits.length }));
    ok(saved === 3 && !again.pick && again.n === 3, "у кого уже есть данные, ?start ничего не стирает и выбор не открывает");
    await c6.close();
    const c7 = await b.newContext({ viewport: { width: 390, height: 844 } });
    const q7 = await c7.newPage(); await q7.goto(BASE);
    await q7.click('.cta-row [data-app="demo"]'); await q7.waitForTimeout(700);
    const d = await q7.evaluate(() => ({ path: location.pathname + location.search, welcome: !!document.querySelector("#obFresh"), demo: JSON.parse(localStorage.getItem("magnat_app_v2") || "{}").demoData }));
    ok(d.path === "/app.html" && !d.welcome && d.demo === true, `«Посмотреть пример» → сразу пример, без окна выбора (${d.path})`);
    await c7.close();
    ok(!e6.length, "ошибок в приложении на этом пути нет" + (e6.length ? ": " + e6.join(" | ") : ""));
    // «Поделиться своей империей»: увидевший сторис должен знать адрес — на картинке и в тексте
    const c9 = await b.newContext({ viewport: { width: 390, height: 844 } });
    const q9 = await c9.newPage(); await q9.goto(BASE + "app.html?demo"); await q9.waitForTimeout(500);
    const sh = await q9.evaluate(() => new Promise(res => {
      const drawn = [], orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { drawn.push(String(s)); return orig.call(this, s, ...a); };
      navigator.canShare = () => true; navigator.share = d => { res({ drawn, text: d.text }); return Promise.resolve(); };
      try { shareCard(); } catch (e) { res({ err: e.message }); }
      setTimeout(() => res({ drawn, text: null }), 3000);
    }));
    ok(sh.drawn && sh.drawn.includes("magnat-planer.ru") && /magnat-planer\.ru/.test(sh.text || ""), `картинка «Поделиться» и её текст — с адресом сайта (текст: «${sh.text}»)`);
    await c9.close();
  }

  // ── 9) ссылки, картинки, обложка, вес, ошибки ────────────────────────────
  console.log("\n9) Ссылки, картинки, обложка, вес");
  await p.setViewportSize({ width: 390, height: 844 }); await fresh(PAGE);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const hrefs = [...html.matchAll(/href="([^"#]+)/g)].map(m => m[1]).filter(h => !/^(mailto:|https?:|data:)/.test(h) && !h.startsWith("$"));
  const dead = [...new Set(hrefs)].filter(h => !fs.existsSync(path.join(ROOT, h.split("?")[0])));
  const docs = ["pricing.html", "terms.html", "privacy.html"].every(f => hrefs.includes(f));
  const mail = [...new Set([...html.matchAll(/mailto:([^"]+)/g)].map(m => m[1]))], docMail = (pricing.match(/mailto:([^"]+)/) || [])[1];
  ok(!dead.length && docs, "ссылки ведут на существующие файлы, в подвале тарифы, соглашение и политика" + (dead.length ? " — мёртвые: " + dead.join(", ") : ""));
  ok(mail.length === 1 && mail[0] === docMail, `поддержка одна и та же, что в документах: ${mail.join(", ")}`);
  const a11y = await p.evaluate(() => ({
    h1: document.querySelectorAll("h1").length,
    deadAnchors: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href")).filter(h => h.length > 1 && !document.querySelector(h)),
    nameless: [...document.querySelectorAll("button, a")].filter(e => !(e.textContent.trim() || e.getAttribute("aria-label"))).length,
    noindex: !!document.querySelector('meta[name="robots"][content*="noindex"]'),
    og: (document.querySelector('meta[property="og:image"]') || {}).content, lang: document.documentElement.lang,
  }));
  ok(a11y.h1 === 1 && !a11y.deadAnchors.length && !a11y.nameless && a11y.lang === "ru",
    `один h1, все якоря на месте, у кнопок и ссылок есть названия, lang=ru${a11y.deadAnchors.length ? " (мёртвые: " + a11y.deadAnchors + ")" : ""}`);
  ok(!a11y.noindex, "страницу видят поисковики (noindex — только у приложения)");
  const robots = fs.existsSync(path.join(ROOT, "robots.txt")) ? fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8") : "";
  const smap = fs.existsSync(path.join(ROOT, "sitemap.xml")) ? fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8") : "";
  const locs = [...smap.matchAll(/<loc>https:\/\/magnat-planer\.ru\/([^<]*)<\/loc>/g)].map(m => m[1] || "index.html");
  ok(/^User-agent: \*/m.test(robots) && /Sitemap: https:\/\/magnat-planer\.ru\/sitemap\.xml/.test(robots) && locs.length >= 4 && locs.every(f => fs.existsSync(path.join(ROOT, f))),
    `robots.txt и карта сайта на месте, в карте — существующие страницы (${locs.join(", ")})`);
  const heads = await p.evaluate(() => [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(h => +h.tagName[1]));
  const skip = heads.findIndex((l, i) => i && l > heads[i - 1] + 1);
  ok(heads[0] === 1 && skip < 0, `заголовки идут по порядку, без пропуска уровня (${heads.join("")})`);
  const ogf = path.join(ROOT, "img/og.jpg"), ogb = fs.existsSync(ogf) ? fs.readFileSync(ogf) : null;
  const jpgSize = buf => { for (let i = 2; i < buf.length;) { const m = buf[i + 1], len = buf.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; i += 2 + len; } return [0, 0]; };
  const [ow, oh] = ogb ? jpgSize(ogb) : [0, 0];
  ok(a11y.og === "https://magnat-planer.ru/img/og.jpg" && ow === 1200 && oh === 630 && ogb.length < 200 * 1024,
    `обложка ссылки: og:image → img/og.jpg, ${ow}×${oh}, ${Math.round((ogb || []).length / 1024)} КБ`);
  await p.evaluate(() => document.querySelectorAll("img").forEach(i => i.loading = "eager"));
  await p.evaluate(() => document.getElementById("shots").scrollIntoView()); await p.waitForTimeout(900);
  const imgs = await p.evaluate(() => [...document.images].map(i => [i.getAttribute("src"), i.naturalWidth, !!i.alt]));
  ok(imgs.length === 4 && imgs.every(i => i[1] > 0 && i[2]), "настоящие экраны приложения грузятся и подписаны: " + imgs.map(i => i[0]).join(", "));
  const size = f => fs.statSync(path.join(ROOT, f)).size;
  const weight = size("index.html") + size("fonts/manrope.woff2") + imgs.reduce((s, i) => s + size(i[0]), 0);
  ok(weight <= 450 * 1024, `вес страницы со шрифтом и экранами: ${Math.round(weight / 1024)} КБ (бюджет 450, сжатием сервер отдаёт меньше)`);
  // встроенный браузер соцсети: зовём открыть в браузере, как и приложение
  {
    const c8 = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0" });
    const q = await c8.newPage(); await q.goto(PAGE);
    const ia = await q.evaluate(() => { const e = document.getElementById("inapp"); return [getComputedStyle(e).display, e.textContent]; });
    const plain = await p.evaluate(() => getComputedStyle(document.getElementById("inapp")).display);
    const above = await q.evaluate(() => document.getElementById("inapp").getBoundingClientRect().bottom <= document.getElementById("heroCta").getBoundingClientRect().top);
    ok(ia[0] !== "none" && /Instagram/.test(ia[1]) && /Открыть в браузере/.test(ia[1]) && plain === "none" && above,
      "во встроенном браузере Instagram — подсказка открыть в браузере, и стоит ДО кнопки «Начать»; в обычном её нет");
    await c8.close();
  }
  ok(errs.length === 0, "ошибок на странице нет" + (errs.length ? ": " + [...new Set(errs)].slice(0, 4).join(" | ") : ""));

  await b.close(); srv.close();
  console.log(fails ? `\n✗ landing: ${fails} проблем` : "\nlanding: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ ПРОВАЛ: " + (e.stack || e.message)); process.exit(1); });

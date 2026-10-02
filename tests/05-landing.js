// Продающая страница landing.html (черновик с 01.10.2026, переделка 02.10.2026).
// Сторожит то, что делает страницу ПЕРЕДЕЛЫВАЕМОЙ (просьба владельца):
//   1) правила мини-игры совпадают с правилами приложения — разошлись, красное;
//   2) цена живёт в одном месте (CFG): поменял число — поменялось всё;
//   3) неделя в мини-игре даёт ровно то, что дал бы тот же опыт в приложении;
// и то, без чего страница не выглядит продуктом «мирового уровня» (02.10.2026):
//   4) свой шрифт реально загрузился, текст читается (контраст WCAG AA);
//   5) ширины от 320 до 1440 без прокрутки вбок, надписи кнопок не разваливаются;
//   6) при прокрутке не остаётся невидимых блоков, липкая кнопка не дублирует соседнюю;
//   7) выбор тарифа работает, вес страницы в бюджете, картинки и ссылки на месте.
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path");
const { chromePath, APP_FILE } = require("./lib");

const ROOT = path.join(__dirname, "..");
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "✓ " : "✗ ") + msg); if (!cond) fails++; };

// правила приложения — прямо из index.html, а не переписанные сюда руками
function appRules() {
  const s = fs.readFileSync(APP_FILE, "utf8");
  const grab = (re, what) => { const m = s.match(re); if (!m) throw new Error("в index.html не нашлось: " + what); return m[1]; };
  return {
    COIN: +grab(/const COIN=(\d+);/, "COIN"),
    DAYOK: +grab(/DAYOK=(\d+);/, "DAYOK"),
    LVLBONUS: +grab(/const LVLBONUS=(\d+);/, "LVLBONUS"),
    mult: eval(grab(/const mult=(s=>[^;]+);/, "mult")),
    xpForLevel: eval(grab(/const xpForLevel=(L=>\{[^}]+\});/, "xpForLevel")),
    RANKS: eval(grab(/const RANKS=(\[[^\n]+\]);/, "RANKS")).map(r => r.slice(0, 3)),
    PICK: eval(grab(/const HABITPICK=(\[[\s\S]+?\]\]);/, "HABITPICK")).filter(h => h[2]).map(h => h.slice(0, 2)),
  };
}

// контраст по WCAG: относительная яркость цветов «#rrggbb»
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// страница открывается через свой маленький веб-сервер, а не с диска: так, как её откроет
// клиент (с диска браузер не пускает предзагрузку шрифта и не отвечает 404 на битую ссылку)
const http = require("http");
const MIME = { ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".json": "application/json" };
function serve() {
  const srv = http.createServer((q, r) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(q.url, "http://x").pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  });
  return new Promise(res => srv.listen(0, "127.0.0.1", () => res(srv)));
}

(async () => {
  const app = appRules();
  const srv = await serve(), PAGE = `http://127.0.0.1:${srv.address().port}/landing.html`;
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "reduce", isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  p.on("response", r => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`); });
  // свежая страница сверху: reload() возвращает прежнюю прокрутку, и «первый экран» уже не первый
  const fresh = async () => { await p.goto("about:blank"); await p.goto(PAGE); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(150); };
  await fresh();

  // 1) правила
  const land = await p.evaluate(() => ({
    COIN: RULES.COIN, DAYOK: RULES.DAYOK, LVLBONUS: RULES.LVLBONUS,
    mult: Array.from({ length: 16 }, (_, s) => RULES.mult(s)),
    xp: Array.from({ length: 40 }, (_, i) => RULES.xpForLevel(i + 1)),
    RANKS: RULES.RANKS, HABITS,
  }));
  ok(land.COIN === app.COIN, `монет за привычку: страница ${land.COIN}, приложение ${app.COIN}`);
  ok(land.DAYOK === app.DAYOK, `отметок для серии: страница ${land.DAYOK}, приложение ${app.DAYOK}`);
  ok(land.LVLBONUS === app.LVLBONUS, `монет за уровень: страница ${land.LVLBONUS}, приложение ${app.LVLBONUS}`);
  ok(land.mult.every((m, s) => m === app.mult(s)), "множитель серии совпадает с приложением (0–15 дней)");
  ok(land.xp.every((x, i) => x === app.xpForLevel(i + 1)), "опыт до уровня совпадает с приложением (1–40)");
  ok(JSON.stringify(land.RANKS) === JSON.stringify(app.RANKS), "звания и их уровни совпадают с приложением");
  ok(JSON.stringify(land.HABITS) === JSON.stringify(app.PICK), "привычки мини-игры = отмеченные при старте приложения");

  // 2) цена из одного места
  const cfg = await p.evaluate(() => ({ ...CFG }));
  const txt = () => p.evaluate(() => document.body.innerText.replace(/ /g, " "));
  const nf = n => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");
  let t = await txt();
  ok(t.includes(`${nf(cfg.year)} ₽`) && t.includes(`${nf(cfg.month)} ₽`), `цены из CFG на странице: ${cfg.month} и ${cfg.year} ₽`);
  await p.evaluate(() => { CFG.month = 399; CFG.year = 2990; CFG.trialDays = 3; CFG.appUrl = "./x/"; fillPrices(); });
  t = await txt();
  const stale = await p.evaluate(() => [...document.querySelectorAll("[data-app]")].filter(a => !a.getAttribute("href").endsWith("/x/")).length);
  ok(t.includes("399 ₽") && t.includes("2 990 ₽") && !t.includes("299 ₽") && !t.includes("1 490"), "сменил цену в CFG — сменилась везде");
  ok(t.includes("Сначала 3 дня бесплатно") && t.includes("3 дня бесплатно, затем 2 990 ₽ в год") && !/7 дней/.test(t), "сменил пробный срок в CFG — сменился везде (и склонение)");
  ok(stale === 0, "сменил адрес приложения в CFG — все кнопки ведут туда");
  await fresh();

  // 2б) выбор тарифа меняет подпись под кнопкой
  const note = () => p.evaluate(() => document.getElementById("pNote").textContent.replace(/ /g, " ").trim());
  const n0 = await note();
  await p.click('[data-plan="month"]');
  const n1 = await note(), chk = await p.evaluate(() => [...document.querySelectorAll("[data-plan]")].map(x => x.getAttribute("aria-checked")).join(","));
  await p.click('[data-plan="year"]');
  const n2 = await note();
  ok(n0.includes(`${nf(cfg.year)} ₽ в год`) && n1.includes(`${nf(cfg.month)} ₽ в месяц`) && n2 === n0 && chk === "false,true",
    `тариф переключается: год → «${n0}» · месяц → «${n1}»`);

  // 3) неделя в мини-игре = тот же опыт в приложении
  let xp = 0, streak = 0;
  for (let d = 0; d < 7; d++) { xp += Math.round(3 * app.COIN * app.mult(streak)); streak++; }
  let L = 1; while (app.xpForLevel(L + 1) <= xp) L++;
  const coins = xp + (L - 1) * app.LVLBONUS;
  const cells = await p.$$(".cell");
  ok(cells.length === 21, `клеток в мини-игре: ${cells.length} (3 привычки × 7 дней)`);
  ok(await p.evaluate(() => !!document.querySelector(".cell.hint")), "первая клетка подсказывает, куда нажать");
  for (const c of cells) await c.click();
  await p.waitForTimeout(300);
  const shown = await p.evaluate(() => ({ coins: document.getElementById("dCoins").textContent.replace(/\D/g, ""),
    lv: document.getElementById("dLv").textContent, fin: getComputedStyle(document.getElementById("dFin")).display,
    hint: !!document.querySelector(".cell.hint") }));
  ok(shown.coins === String(coins), `вся неделя: ${shown.coins} монет, по правилам приложения ${coins}`);
  ok(shown.lv === `Уровень ${L}`, `вся неделя: «${shown.lv}», по правилам приложения — уровень ${L}`);
  ok(shown.fin !== "none" && !shown.hint, "после недели — кнопка «Начать по-настоящему», подсказка ушла");
  await cells[0].click(); await p.waitForTimeout(200);
  const after = await p.evaluate(() => document.getElementById("dCoins").textContent.replace(/\D/g, ""));
  ok(+after < coins, "сняли галочку — монет стало меньше");

  // 4) шрифт и контраст
  const font = await p.evaluate(() => ({
    loaded: [...document.fonts].filter(f => f.family.replace(/"/g, "") === "Manrope" && f.status === "loaded").length,
    h1: getComputedStyle(document.querySelector("h1")).fontFamily, check: document.fonts.check('800 40px "Manrope"', "Хватит"),
  }));
  ok(font.loaded >= 1 && font.check && /^"?Manrope/.test(font.h1), `шрифт Manrope загружен (${font.loaded} файла) и стоит первым у заголовка`);
  const css = await p.evaluate(() => { const s = getComputedStyle(document.documentElement); return ["--bg", "--surface", "--surface-2", "--ink", "--ink-2", "--mut", "--dim", "--accent", "--gold"].reduce((o, k) => (o[k] = s.getPropertyValue(k).trim(), o), {}); });
  const pairs = [["--mut", "--bg"], ["--mut", "--surface-2"], ["--dim", "--bg"], ["--dim", "--surface"], ["--ink-2", "--surface-2"], ["--accent", "--bg"], ["--gold", "--surface"]];
  const weak = pairs.map(([f, g]) => [f, g, ratio(hex(css[f]), hex(css[g]))]).filter(x => x[2] < 4.5);
  ok(!weak.length, "контраст текста ≥ 4,5 (WCAG AA) для всех пар цветов" + (weak.length ? ": " + weak.map(w => `${w[0]} на ${w[1]} — ${w[2].toFixed(2)}`).join(", ") : ""));
  ok(ratio(hex("#03150c"), hex(css["--accent"])) >= 7, "текст на зелёной кнопке читается (контраст ≥ 7)");

  // 5) ширины и кнопки
  const btnLines = () => p.evaluate(() => [...document.querySelectorAll(".btn")].filter(b => b.offsetParent || b.closest(".sticky")).map(b => {
    const r = document.createRange(); r.selectNodeContents(b);
    const tops = [...r.getClientRects()].filter(x => x.width > 0).map(x => x.top).sort((a, c) => a - c);
    let lines = tops.length ? 1 : 0; for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 8) lines++;
    return [b.textContent.trim(), lines];
  }));
  for (const w of [320, 360, 390, 768, 1024, 1440]) {
    await p.setViewportSize({ width: w, height: 800 }); await fresh();
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth,
      cell: Math.min(...[...document.querySelectorAll(".cell")].map(c => c.getBoundingClientRect().height)),
      tap: Math.min(...[...document.querySelectorAll(".btn, .plan, summary")].filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height)) }));
    const bad = (await btnLines()).filter(([, n]) => n > 1);
    ok(m.sw <= m.iw && m.cell >= 30 && m.tap >= 44 && !bad.length,
      `${w} px: без прокрутки вбок (${m.sw}/${m.iw}), клетка ${Math.round(m.cell)} px, кнопки от ${Math.round(m.tap)} px, надписи в строку` +
      (bad.length ? " — разваливаются: " + bad.map(([s, n]) => `«${s}» ${n}`).join(", ") : ""));
  }

  // 6) липкая кнопка: появляется, когда первая ушла с экрана, и молчит там, где своя кнопка рядом
  await p.setViewportSize({ width: 390, height: 844 }); await fresh();
  const stickyOn = () => p.evaluate(() => document.getElementById("sticky").classList.contains("on"));
  ok(!(await stickyOn()), "липкая кнопка не видна на первом экране (там своя)");
  await p.evaluate(() => document.getElementById("inside").scrollIntoView()); await p.waitForTimeout(300);
  ok(await stickyOn(), "липкая кнопка видна посреди страницы");
  // после мини-игры своя кнопка «Начать по-настоящему» — липкая под ней была бы второй такой же
  for (const c of (await p.$$(".cell")).slice(0, 7)) await c.click();
  await p.evaluate(() => { const f = document.getElementById("dFin"); scrollTo(0, f.getBoundingClientRect().top + scrollY - 300); }); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "у кнопки после мини-игры липкая прячется");
  await p.evaluate(() => document.getElementById("price").scrollIntoView()); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "у тарифов липкая кнопка прячется (там своя)");
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "в конце страницы липкая кнопка не видна (там финальная кнопка)");

  // 6б) появление при прокрутке: с анимацией каждый блок проявляется, а не остаётся пустым местом
  {
    const c2 = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "no-preference" });
    const q = await c2.newPage(); await q.goto(PAGE);
    const hiddenAtStart = await q.evaluate(() => [...document.querySelectorAll("[data-reveal]")].filter(e => getComputedStyle(e).opacity === "0").length);
    const H = await q.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y <= H; y += 600) { await q.evaluate(v => scrollTo(0, v), y); await q.waitForTimeout(120); }
    await q.waitForTimeout(900);
    const left = await q.evaluate(() => [...document.querySelectorAll("[data-reveal]")].filter(e => !e.classList.contains("in") || getComputedStyle(e).opacity !== "1").length);
    ok(hiddenAtStart > 0 && left === 0, `появление при прокрутке: ${hiddenAtStart} блоков ждут своей очереди, после прокрутки скрытых — ${left}`);
    await c2.close();
  }

  // 7) вес, картинки, ссылки, доступность
  const size = f => fs.statSync(path.join(ROOT, f)).size;
  const imgsUsed = await p.evaluate(() => [...document.images].map(i => i.getAttribute("src")));
  const weight = size("landing.html") + ["manrope-cyrillic", "manrope-latin", "manrope-latin-ext"].reduce((s, f) => s + size(`fonts/${f}.woff2`), 0) + imgsUsed.reduce((s, f) => s + size(f), 0);
  ok(weight <= 400 * 1024, `вес страницы со шрифтом и картинками: ${Math.round(weight / 1024)} КБ (бюджет 400)`);
  await p.evaluate(() => document.querySelectorAll("img").forEach(i => i.loading = "eager"));
  await p.waitForTimeout(800);
  const imgs = await p.evaluate(() => [...document.images].map(i => [i.getAttribute("src"), i.naturalWidth, !!i.alt]));
  ok(imgs.length === 3 && imgs.every(i => i[1] > 0 && i[2]), "экраны приложения грузятся и подписаны: " + imgs.map(i => i[0]).join(", "));
  ok(["img/og.jpg", "img/mark.svg"].every(f => fs.existsSync(path.join(ROOT, f))), "есть превью ссылки (og.jpg) и значок вкладки (mark.svg)");
  const a11y = await p.evaluate(() => ({
    h1: document.querySelectorAll("h1").length,
    deadAnchors: [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href")).filter(h => h.length > 1 && !document.querySelector(h)),
    nameless: [...document.querySelectorAll("button, a")].filter(e => !(e.textContent.trim() || e.getAttribute("aria-label"))).length,
    todo: [...document.querySelectorAll("[data-todo]")].map(e => e.dataset.todo),
  }));
  ok(a11y.h1 === 1 && !a11y.deadAnchors.length && !a11y.nameless,
    `один заголовок h1, все якоря ведут на место${a11y.deadAnchors.length ? " (мёртвые: " + a11y.deadAnchors + ")" : ""}, у кнопок и ссылок есть названия`);
  console.log(`· до запуска заменить заглушки: ${a11y.todo.join(", ")}`);
  ok(errs.length === 0, "ошибок на странице нет" + (errs.length ? ": " + errs.join(" | ") : ""));

  await b.close(); srv.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("✗ " + e.message); process.exit(1); });

// Продающая страница landing.html (черновик 01.10.2026).
// Сторожит то, что делает страницу ПЕРЕДЕЛЫВАЕМОЙ (просьба владельца):
//   1) правила мини-игры совпадают с правилами приложения — разошлись, красное;
//   2) цена живёт в одном месте (CFG): поменял число — поменялось всё;
//   3) неделя в мини-игре даёт ровно то, что дал бы тот же опыт в приложении;
//   4) страница без горизонтальной прокрутки на 320 / 390 / 1280, без ошибок,
//      экраны приложения грузятся.
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path");
const { chromePath, APP_FILE } = require("./lib");

const LANDING = path.join(__dirname, "..", "landing.html");
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

(async () => {
  const app = appRules();
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "reduce", isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto("file://" + LANDING);

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
  ok(t.includes("399 ₽") && t.includes("2 990 ₽") && !t.includes("299 ₽ /") && !t.includes("1 490"), "сменил цену в CFG — сменилась везде");
  ok(t.includes("3 дня бесплатно") && t.includes("3 дня без карты") && !/7 дней/.test(t), "сменил пробный срок в CFG — сменился везде (и склонение)");
  ok(stale === 0, "сменил адрес приложения в CFG — все кнопки ведут туда");
  await p.reload();

  // 3) неделя в мини-игре = тот же опыт в приложении
  let xp = 0, streak = 0;
  for (let d = 0; d < 7; d++) { xp += Math.round(3 * app.COIN * app.mult(streak)); streak++; }
  let L = 1; while (app.xpForLevel(L + 1) <= xp) L++;
  const coins = xp + (L - 1) * app.LVLBONUS;
  const cells = await p.$$(".cell");
  ok(cells.length === 21, `клеток в мини-игре: ${cells.length} (3 привычки × 7 дней)`);
  for (const c of cells) await c.click();
  await p.waitForTimeout(300);
  const shown = await p.evaluate(() => ({ coins: document.getElementById("dCoins").textContent.replace(/\D/g, ""),
    lv: document.getElementById("dLv").textContent, fin: getComputedStyle(document.getElementById("dFin")).display }));
  ok(shown.coins === String(coins), `вся неделя: ${shown.coins} 🪙, по правилам приложения ${coins}`);
  ok(shown.lv === `Уровень ${L}`, `вся неделя: «${shown.lv}», по правилам приложения — уровень ${L}`);
  ok(shown.fin !== "none", "после недели видна кнопка «Начать по-настоящему»");
  await cells[0].click(); await p.waitForTimeout(200);
  const after = await p.evaluate(() => document.getElementById("dCoins").textContent.replace(/\D/g, ""));
  ok(+after < coins, "сняли галочку — монет стало меньше");

  // 4) ширины, картинки, ошибки
  // строк в надписи кнопки — по верхам кусочков текста (эмодзи сидит на 1–3 px иначе)
  const btnLines = () => p.evaluate(() => [...document.querySelectorAll(".btn")].filter(b => b.offsetParent || b.closest(".sticky")).map(b => {
    const r = document.createRange(); r.selectNodeContents(b);
    const tops = [...r.getClientRects()].filter(x => x.width > 0).map(x => x.top).sort((a, c) => a - c);
    let lines = tops.length ? 1 : 0; for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 8) lines++;
    return [b.textContent.trim(), lines];
  }));
  for (const w of [320, 390, 1280]) {
    await p.setViewportSize({ width: w, height: 800 }); await p.reload();
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth,
      cell: Math.min(...[...document.querySelectorAll(".cell")].map(c => c.getBoundingClientRect().height)) }));
    ok(m.sw <= m.iw, `${w} px: без прокрутки вбок (${m.sw} из ${m.iw})`);
    ok(m.cell >= 30, `${w} px: клетка мини-игры не меньше 30 px (${Math.round(m.cell)})`);
    // 01.10: у flex-кнопки «Попробовать 7 дней бесплатно» разваливалась в три столбика
    const most = w === 320 ? 2 : 1, bad = (await btnLines()).filter(([, n]) => n > most);
    ok(!bad.length, `${w} px: надпись на кнопке — не больше ${most === 1 ? "одной строки" : "двух строк"}${bad.length ? " — " + bad.map(([t, n]) => `«${t}» ${n}`).join(", ") : ""}`);
  }
  // липкая кнопка: появляется, когда первая ушла с экрана, и молчит там, где своя кнопка рядом
  await p.setViewportSize({ width: 390, height: 844 }); await p.reload();
  const stickyOn = () => p.evaluate(() => document.getElementById("sticky").classList.contains("on"));
  ok(!(await stickyOn()), "липкая кнопка не видна на первом экране (там своя)");
  await p.evaluate(() => document.getElementById("how").scrollIntoView()); await p.waitForTimeout(300);
  ok(await stickyOn(), "липкая кнопка видна посреди страницы");
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300);
  ok(!(await stickyOn()), "липкая кнопка не видна в конце страницы (там финальная кнопка)");
  await p.evaluate(() => document.querySelectorAll("img").forEach(i => i.loading = "eager"));
  await p.waitForTimeout(800);
  const imgs = await p.evaluate(() => [...document.images].map(i => [i.getAttribute("src"), i.naturalWidth]));
  ok(imgs.length === 3 && imgs.every(i => i[1] > 0), "экраны приложения грузятся: " + imgs.map(i => i[0]).join(", "));
  ok(errs.length === 0, "ошибок на странице нет" + (errs.length ? ": " + errs.join(" | ") : ""));

  await b.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("✗ " + e.message); process.exit(1); });

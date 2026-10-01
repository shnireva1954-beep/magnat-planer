#!/usr/bin/env node
// Экраны приложения для продающей страницы (landing.html) — переснять одной командой:
//     node tools/shots.js
// Зачем отдельный скрипт (01.10.2026): владелец сказал, что сам Магнат «ещё не
// полностью готов» и будет меняться. Картинки, снятые руками, тихо устареют —
// а эти пересоздаются из ТЕКУЩЕГО index.html за полминуты.
//
// Снимается режим примера («Посмотреть пример»), как его увидит новичок, с двумя
// обычными действиями пользователя: отмечены пять привычек дня (иначе с утра на
// «Обзоре» «0 из 8») и календарь пролистан на прошлый месяц (в начале месяца он
// пустой). Плашка «пример с демо-данными» на снимке скрыта — подпись под
// экранами на странице и так говорит, что данные — пример.
const { chromium } = require("playwright-core");
const path = require("path");
const { chromePath, APP_URL } = require("../tests/lib");

const OUT = path.join(__dirname, "..", "img");
const TODAY_HABITS = ["Тренировка", "Час на дело", "Шаг к деньгам", "День без залипания", "Вода 2 л"];

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: "ru-RU", reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(APP_URL);
  await p.click("text=Посмотреть пример"); await p.waitForTimeout(400);
  for (const t of TODAY_HABITS) { await p.locator(".today").getByText(t).first().click(); await p.waitForTimeout(250); }
  await p.waitForTimeout(1200);
  const tidy = () => p.evaluate(() => {
    for (const el of document.querySelectorAll(".card,.glass"))
      if (/пример с демо/.test(el.innerText) && el.innerText.length < 200) el.style.display = "none";
    window.scrollTo(0, 0);
  });
  const snap = async (file) => { await tidy(); await p.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 80 }); console.log("✓ img/" + file); };
  await snap("obzor.jpg");
  await p.locator(".tabs").getByText("Привычки").first().click(); await p.waitForTimeout(500);
  await p.locator("button", { hasText: "‹" }).first().click(); await p.waitForTimeout(500);
  await snap("privychki.jpg");
  await p.locator(".tabs").getByText("Награды").first().click(); await p.waitForTimeout(500);
  await snap("nagrady.jpg");
  await b.close();
  if (errs.length) { console.log("✗ ошибки на странице: " + errs.join(" | ")); process.exit(1); }
})().catch(e => { console.log("✗ " + e.message); process.exit(1); });

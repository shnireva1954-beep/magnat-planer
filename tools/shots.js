#!/usr/bin/env node
// Картинки продающей страницы (landing.html) — переснять одной командой:
//     node tools/shots.js
// Делает:   img/obzor.webp, img/privychki.webp, img/nagrady.webp — экраны приложения;
//           img/og.jpg — превью ссылки для Telegram, VK и мессенджеров (1200×630).
// Зачем отдельный скрипт (01.10.2026): владелец сказал, что сам Магнат «ещё не
// полностью готов» и будет меняться. Картинки, снятые руками, тихо устареют —
// а эти пересоздаются из ТЕКУЩЕГО index.html за полминуты.
//
// Снимается режим примера («Посмотреть пример»), как его увидит новичок, плюс одно
// обычное действие: к трём отметкам дня из примера добавлены ещё две (5 из 8 —
// кольцо дня заметно, но день не «закрыт»), а календарь пролистан на прошлый месяц
// (в начале месяца в нём почти пусто). Плашка «пример с демо-данными» на снимке
// скрыта — подпись на странице и так говорит, что экраны на примере данных.
// WebP — через canvas самого Chromium: втрое легче JPEG того же качества.
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path");
const { chromePath, APP_URL } = require("../tests/lib");

const ROOT = path.join(__dirname, ".."), OUT = path.join(ROOT, "img");
const MORE_TODAY = ["День без залипания", "Вода 2 л"];

async function toWebp(page, png, file, quality = 0.84) {
  const b64 = await page.evaluate(async ([src, q]) => {
    const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", q).split(",")[1];
  }, [png.toString("base64"), quality]);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, "base64"));
  console.log(`✓ img/${file} — ${Math.round(Buffer.from(b64, "base64").length / 1024)} КБ`);
}

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: "ru-RU", reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(APP_URL);
  await p.evaluate(() => document.fonts.ready);
  await p.click("text=Посмотреть пример"); await p.waitForTimeout(400);
  for (const t of MORE_TODAY) {
    const chip = p.locator(".today .tchip", { hasText: t }).first();
    if (!(await chip.getAttribute("class")).includes("on")) { await chip.click(); await p.waitForTimeout(250); }
  }
  await p.waitForTimeout(1200);
  const tidy = () => p.evaluate(() => {
    for (const el of document.querySelectorAll(".card,.glass"))
      if (/пример с демо/.test(el.innerText) && el.innerText.length < 200) el.style.display = "none";
    window.scrollTo(0, 0);
  });
  const snap = async file => { await tidy(); await toWebp(p, await p.screenshot({ type: "png" }), file); };
  await snap("obzor.webp");
  await p.locator(".tabs").getByText("Привычки").first().click(); await p.waitForTimeout(500);
  await p.locator("button", { hasText: "‹" }).first().click(); await p.waitForTimeout(500);
  await snap("privychki.webp");
  await p.locator(".tabs").getByText("Награды").first().click(); await p.waitForTimeout(500);
  await snap("nagrady.webp");

  // превью ссылки: тот же шрифт, знак и цвета, что на странице, плюс настоящий экран
  const og = await (await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })).newPage();
  const shot = fs.readFileSync(path.join(OUT, "obzor.webp")).toString("base64");
  // шрифт — внутрь страницы: из setContent (about:blank) file://-шрифты браузер не грузит
  const font = f => "data:font/woff2;base64," + fs.readFileSync(path.join(ROOT, "fonts", f)).toString("base64");
  await og.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:M;font-weight:400 800;src:url(${font("manrope-cyrillic.woff2")}) format("woff2");unicode-range:U+0400-045F;}
    @font-face{font-family:M;font-weight:400 800;src:url(${font("manrope-latin.woff2")}) format("woff2");}
    *{margin:0;box-sizing:border-box} body{width:1200px;height:630px;overflow:hidden;font-family:M,sans-serif;color:#f3f6f9;
      background:radial-gradient(700px 500px at 15% 10%,rgba(47,227,143,.18),transparent 70%),radial-gradient(600px 500px at 95% 100%,rgba(53,140,255,.12),transparent 70%),#07090d;}
    .t{position:absolute;left:72px;top:70px;width:640px} .b{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:800;letter-spacing:-.03em}
    h1{font-size:76px;line-height:1;letter-spacing:-.045em;font-weight:800;margin-top:64px}
    h1 span{background:linear-gradient(100deg,#3df2a1,#2fe38f 45%,#a6f7cf);-webkit-background-clip:text;color:transparent}
    p{font-size:27px;color:#98a5b4;margin-top:28px;line-height:1.4;font-weight:600}
    .ph{position:absolute;right:86px;top:56px;width:300px;border-radius:44px;padding:10px;background:linear-gradient(160deg,#1b222d,#0b0f15 40%,#151b25);
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 40px 80px -20px rgba(0,0,0,.8);transform:rotate(4deg)}
    .ph img{display:block;width:100%;border-radius:35px}
  </style></head><body>
    <div class="t"><div class="b"><svg width="46" height="46" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4af3a7"/><stop offset="1" stop-color="#13a865"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M16 7.6 7.6 12.2h16.8L16 7.6ZM9.6 14h12.8M10.8 15.4v6.4M16 15.4v6.4M21.2 15.4v6.4M8.4 23.6h15.2" fill="none" stroke="#03150c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Магнат</div>
      <h1>Хватит начинать с&nbsp;<span>понедельника</span></h1>
      <p>Привычки, задачи, деньги и тело — в одной игре. Сделал дело — получил монеты.</p></div>
    <div class="ph"><img src="data:image/webp;base64,${shot}"></div>
  </body></html>`);
  await og.evaluate(() => document.fonts.ready); await og.waitForTimeout(300);
  await og.screenshot({ path: path.join(OUT, "og.jpg"), type: "jpeg", quality: 86 });
  console.log(`✓ img/og.jpg — ${Math.round(fs.statSync(path.join(OUT, "og.jpg")).size / 1024)} КБ`);

  await b.close();
  if (errs.length) { console.log("✗ ошибки на странице: " + errs.join(" | ")); process.exit(1); }
})().catch(e => { console.log("✗ " + e.message); process.exit(1); });

#!/usr/bin/env node
// Снимки настоящих экранов приложения для продающей страницы и обложка ссылки (og.jpg).
// Всё снимается из ТЕКУЩЕГО app.html в режиме примера: поменял приложение — переснял одной
// командой из корня репозитория:
//   NODE_PATH=$(npm root -g) node tools/shots.js
// Пишет img/scr-home.webp, img/scr-path.webp, img/scr-habits.webp, img/scr-shop.webp и img/og.jpg.
// Нужны playwright-core (как тестам) и python3 с Pillow — PNG → WebP/JPEG.
const { chromium, chromePath } = require("../tests/lib");
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, ".."), IMG = path.join(ROOT, "img");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "magnat-shots-"));
fs.mkdirSync(IMG, { recursive: true });

// PNG → WebP/JPEG через Pillow: без лишних npm-зависимостей
function convert(src, dst, quality) {
  const py = `from PIL import Image\nim=Image.open(${JSON.stringify(src)}).convert("RGB")\nim.save(${JSON.stringify(dst)}, quality=${quality}, method=6) if ${JSON.stringify(dst)}.endswith(".webp") else im.save(${JSON.stringify(dst)}, quality=${quality}, optimize=True, progressive=True)`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("Pillow: " + r.stderr);
}

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });
  // Android-браузер, а не айфон: иначе сверху встанет подсказка «Поставь на экран Домой»
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1.6, isMobile: true, hasTouch: true, locale: "ru-RU",
    reducedMotion: "reduce", userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" });
  const p = await ctx.newPage();
  await p.goto("file://" + path.join(ROOT, "app.html") + "?demo");
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500);
  // плашка «внутри — пример» на витрине лишняя: на снимке и так видно, что это пример экрана
  await p.addStyleTag({ content: ".demonote{display:none!important}" });
  const shots = [
    ["home", async () => { await p.click('.tab[data-t="home"]'); }],
    ["path", async () => { await p.click('.tab[data-t="home"]'); await p.click("#lvlChip"); }],
    ["habits", async () => { await p.click('.tab[data-t="habits"]'); }],
    ["shop", async () => { await p.click('.tab[data-t="shop"]'); }],
  ];
  for (const [name, go] of shots) {
    await go(); await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(600);
    const png = path.join(TMP, name + ".png");
    await p.screenshot({ path: png });
    convert(png, path.join(IMG, `scr-${name}.webp`), 80);
    console.log("✓ img/scr-" + name + ".webp");
  }
  await ctx.close();

  // ── обложка ссылки 1200×630: то, что видно в Telegram, ВКонтакте, WhatsApp ──
  const home = "data:image/png;base64," + fs.readFileSync(path.join(TMP, "home.png")).toString("base64");
  const mark = '<svg viewBox="0 0 32 32"><rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="#0c1a1c" stroke="#25463d"/><g fill="#33e494"><path d="M16 7.4 7.3 12.1h17.4z"/><rect x="8.2" y="13.1" width="15.6" height="1.7" rx=".85"/><rect x="9.3" y="15.9" width="2.3" height="6.1" rx="1.1"/><rect x="13" y="15.9" width="2.3" height="6.1" rx="1.1"/><rect x="16.7" y="15.9" width="2.3" height="6.1" rx="1.1"/><rect x="20.4" y="15.9" width="2.3" height="6.1" rx="1.1"/><rect x="7.8" y="23.1" width="16.4" height="1.7" rx=".85"/></g></svg>';
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face{font-family:M; font-weight:400 800; src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, "fonts/manrope.woff2")).toString("base64")}) format("woff2");}
    *{margin:0;box-sizing:border-box} html,body{width:1200px;height:630px;overflow:hidden}
    body{font-family:M,sans-serif;color:#eef4fb;background:#06080d;position:relative}
    .bg{position:absolute;inset:0;background:radial-gradient(700px 520px at 6% -10%,rgba(47,227,143,.28),transparent 62%),radial-gradient(620px 520px at 96% 110%,rgba(245,196,81,.16),transparent 60%),radial-gradient(520px 420px at 80% 10%,rgba(53,208,255,.14),transparent 60%)}
    .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(148,178,214,.16) 1px,transparent 1.3px);background-size:24px 24px;-webkit-mask-image:radial-gradient(ellipse 60% 70% at 30% 40%,#000 20%,transparent 75%)}
    .l{position:absolute;left:72px;top:66px;width:660px}
    .brand{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:800;letter-spacing:-.02em}
    .brand svg{width:58px;height:58px}
    h1{margin-top:44px;font-size:74px;line-height:1;letter-spacing:-.045em;font-weight:800}
    .m{background:linear-gradient(180deg,#fff 20%,#aebdcc 120%);-webkit-background-clip:text;color:transparent}
    .g{background:linear-gradient(95deg,#7df5bf,#2fe38f 38%,#b6ef7a 72%,#f5c451);-webkit-background-clip:text;color:transparent}
    p{margin-top:26px;width:600px;font-size:27px;line-height:1.4;color:#a9bbcf;font-weight:500}
    .url{position:absolute;left:72px;bottom:56px;display:flex;align-items:center;gap:12px;font-size:24px;font-weight:700;color:#2fe38f}
    .url i{width:10px;height:10px;border-radius:50%;background:#2fe38f;box-shadow:0 0 14px #2fe38f}
    .ph{position:absolute;right:86px;top:58px;width:318px;height:640px;border-radius:52px;padding:10px;background:linear-gradient(150deg,#3a4656,#121821 22%,#0b0f15 50%,#1a222d 78%,#3b4757);box-shadow:0 0 0 1px rgba(255,255,255,.07),0 50px 90px -30px rgba(0,0,0,.95),0 30px 120px -40px rgba(47,227,143,.55);transform:rotate(-4deg)}
    .ph img{width:100%;height:100%;object-fit:cover;object-position:top;border-radius:43px;display:block}
    .chip{position:absolute;display:flex;align-items:center;gap:10px;padding:13px 18px;border-radius:18px;background:linear-gradient(180deg,rgba(27,38,56,.95),rgba(16,23,34,.95));border:1px solid rgba(148,178,214,.26);box-shadow:0 20px 40px -14px rgba(0,0,0,.9);font-size:21px;font-weight:800;white-space:nowrap}
    .coin{display:inline-block;width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#fff1b8 0 14%,#f9cf55 36%,#d99a2b 78%,#a96f12)}
    .c1{right:330px;top:478px;color:#f5c451} .c2{right:40px;top:380px}
  </style><div class="bg"></div><div class="dots"></div>
  <div class="l"><div class="brand">${mark}Магнат</div>
    <h1><span class="m">Хватит начинать</span><br><span class="g">с понедельника</span></h1>
    <p>Привычки дают монеты, монеты растят уровень, каждый уровень — урок из книг.</p></div>
  <div class="url"><i></i>magnat-planer.ru</div>
  <div class="ph"><img src="${home}"></div>
  <div class="chip c1"><span class="coin"></span>+20 за привычку</div>
  <div class="chip c2">📖 40 уроков из 23 книг</div>`;
  const og = await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const q = await og.newPage(); await q.setContent(html); await q.evaluate(() => document.fonts.ready); await q.waitForTimeout(300);
  const ogPng = path.join(TMP, "og.png"); await q.screenshot({ path: ogPng });
  convert(ogPng, path.join(IMG, "og.jpg"), 86);
  console.log("✓ img/og.jpg");
  await b.close(); fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error("✗ " + (e.stack || e.message)); process.exit(1); });

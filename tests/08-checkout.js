// Оформление подписки (09.10.2026) — путь покупки, который платёжный сервис хочет видеть до
// согласования проекта. Что сторожится:
//   1. путь виден: на главной и в тарифах есть «Оформить» → checkout.html с выбранным тарифом;
//   2. цена одна: CFG оформления = тарифы (data-price) = CFG главной; дата соглашения, которая
//      уходит с заказом, = дата в terms.html (иначе в споре с банком не доказать, что принято);
//   3. правила формы: флажок автопродления заранее НЕ отмечен; без него, без e-mail или с
//      неверным Telegram не отправить; Telegram — по желанию; сумма и текст согласия — по тарифу;
//   4. честность: пока CFG.pay пустой, форма никуда не уходит (ни одного запроса) и страница
//      говорит «оплата не подключена»; вписан адрес — уходит POST: тариф, почта, Telegram,
//      согласие его же словами и дата соглашения;
//   5. в браузере под CSP сервера: без ошибок, без прокрутки вбок на 320–1280, кнопки ≥ 44 px.
const { chromium, chromePath, APP_DIR } = require("./lib");
const fs = require("fs"), path = require("path"), http = require("http");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

const read = f => fs.readFileSync(path.join(APP_DIR, f), "utf8");
const nf = n => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ");
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];

// тот же сервер, что в 07-docs, плюс приём POST — им проверяется отправка заказа
const posted = [];
function serve(root, csp) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg" };
  return new Promise(res => {
    const s = http.createServer((rq, rs) => {
      if (rq.method === "POST") {
        let body = ""; rq.on("data", c => body += c);
        // ответ со значком: без него браузер просит /favicon.ico, а 404 — это «ошибка на странице»
        rq.on("end", () => { posted.push({ url: rq.url, body: new URLSearchParams(body) }); rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); rs.end('<!doctype html><title>принято</title><link rel="icon" href="data:,">'); });
        return;
      }
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
  const csp = (read("server/Caddyfile").match(/Content-Security-Policy "([^"]+)"/) || [])[1];
  if (!csp) bad("CSP в server/Caddyfile не найдена");
  const srv = await serve(APP_DIR, csp || "");
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch({ executablePath: chromePath() });
  const errs = [];
  const open = async (url, w = 390) => {
    const ctx = await b.newContext({ viewport: { width: w, height: 844 } });
    const p = await ctx.newPage();
    p.on("pageerror", e => errs.push(url + ": " + e.message));
    p.on("console", m => { if (m.type() === "error") errs.push(url + ": " + m.text()); });
    await p.goto(base + url); await p.waitForTimeout(300);
    return p;
  };
  try {
    // ---- 1. Путь виден ----------------------------------------------------------
    console.log("\n1. Путь покупки виден: главная и тарифы → оформление");
    check(fs.existsSync(path.join(APP_DIR, "checkout.html")), "checkout.html на месте");
    let p = await open("index.html?site");
    const h0 = await p.getAttribute("#priceBuy", "href");
    await p.click('[data-plan="month"]'); const h1 = await p.getAttribute("#priceBuy", "href");
    check(h0 === "checkout.html?plan=year" && h1 === "checkout.html?plan=month",
      `главная: «Оформить подписку» ведёт с выбранным тарифом (год → ${h0}, месяц → ${h1})`);
    const land = await p.evaluate(() => ({ ...CFG }));
    await Promise.all([p.waitForNavigation(), p.click("#priceBuy")]);
    check(/checkout\.html\?plan=month$/.test(p.url()) && await p.evaluate(() => document.querySelector('input[name="plan"]:checked').value) === "month",
      "с главной «Оформить» на месяце — открылось оформление, отмечен месяц");
    await p.context().close();
    p = await open("pricing.html");
    const go = await p.$$eval(".plan .go", as => as.map(a => [a.textContent.trim(), a.getAttribute("href"), a.getBoundingClientRect().height]));
    check(go.some(([t, h]) => t === "Оформить" && h === "checkout.html?plan=month") && go.some(([t, h]) => t === "Оформить" && h === "checkout.html?plan=year") && go.every(x => x[2] >= 44),
      "тарифы: «Оформить» у месяца и у года, кнопки ≥ 44 px: " + go.map(x => x[1]).join(", "));
    await Promise.all([p.waitForNavigation(), p.click('.plan .go[href="checkout.html?plan=year"]')]);
    check(await p.evaluate(() => document.querySelector('input[name="plan"]:checked').value) === "year", "из тарифов «Оформить» у года — отмечен год");
    await p.context().close();
    for (const junk of ['x"]', "toString", "__proto__"]) {
      p = await open("checkout.html?plan=" + encodeURIComponent(junk));
      check(await p.evaluate(() => document.querySelector('input[name="plan"]:checked').value === "year" && !document.getElementById("payBtn").disabled),
        `кривой ?plan=${junk} не роняет страницу: отмечен год, кнопка живая`);
      await p.context().close();
    }

    // ---- 2. Цена одна, дата соглашения та же ---------------------------------------
    console.log("\n2. Цена одна везде, дата соглашения та же");
    p = await open("checkout.html");
    const cfg = await p.evaluate(() => ({ ...CFG }));
    const pricing = read("pricing.html").replace(/&nbsp;| /g, " ");
    const pp = k => ((pricing.match(new RegExp(`data-price="${k}"[^>]*>([^<]+)`)) || [])[1] || "").replace(/\s+/g, " ").trim();
    check(pp("month").startsWith(`${nf(cfg.month)} ₽`) && pp("year").startsWith(`${nf(cfg.year)} ₽`) && cfg.month === land.month && cfg.year === land.year,
      `оформление = тарифы = главная: ${cfg.month} ₽ в месяц, ${nf(cfg.year)} ₽ в год`);
    const raw = read("checkout.html");
    const markup = k => ((raw.match(new RegExp(`data-price="${k}"[^>]*>([^<]+)`)) || [])[1] || "").replace(/&nbsp;| /g, " ").trim();
    check(markup("month").startsWith(`${nf(cfg.month)} ₽`) && markup("year").startsWith(`${nf(cfg.year)} ₽`), "запасные цены в разметке (без скрипта) — те же");
    const td = read("terms.html").match(/Дата обновления: (\d+) (\S+) (\d{4})/);
    const iso = td ? `${td[3]}-${String(MONTHS.indexOf(td[2]) + 1).padStart(2, "0")}-${td[1].padStart(2, "0")}` : "?";
    const sent = await p.getAttribute('input[name="terms"]', "value");
    check(sent === iso, `с заказом уходит редакция соглашения ${sent} — та же, что в terms.html (${iso})`);

    // ---- 3. Правила формы --------------------------------------------------------
    console.log("\n3. Правила формы");
    const st = () => p.evaluate(() => ({
      auto: document.getElementById("autopay").checked, done: !document.getElementById("done").hidden, form: !document.getElementById("buy").hidden,
      errs: ["emailErr", "tgErr", "autoErr"].filter(id => !document.getElementById(id).hidden),
      focus: document.activeElement && document.activeElement.id,
      now: document.getElementById("sumNow").textContent, next: document.getElementById("sumNext").textContent, consent: document.getElementById("autoTxt").textContent,
      btn: !document.getElementById("payBtn").disabled,
    }));
    let s = await st();
    check(!s.auto, "флажок автопродления заранее НЕ отмечен");
    check(s.btn, "кнопка «Перейти к оплате» включена скриптом (без скрипта выключена)");
    check(/disabled/.test((raw.match(/<button[^>]*id="payBtn"[^>]*>/) || [""])[0]), "в разметке кнопка выключена — без скрипта форма никуда не уйдёт");
    check(s.now === `${nf(cfg.year)} ₽` && s.next.includes("раз в год") && s.consent.includes(`${nf(cfg.year)} ₽`) && s.consent.includes("раз в год"),
      `по умолчанию год: к оплате ${s.now}, согласие «${s.consent}»`);
    await p.check('input[name="plan"][value="month"]'); s = await st();
    check(s.now === `${nf(cfg.month)} ₽` && s.next.includes("раз в месяц") && s.consent.includes(`${nf(cfg.month)} ₽`) && s.consent.includes("раз в месяц") && !s.consent.includes("год"),
      `сменил тариф на месяц — сумма и текст согласия сменились: «${s.consent}»`);
    await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "emailErr,autoErr" && s.focus === "email" && s.form && !s.done, "пустая форма не уходит: ошибки у e-mail и согласия, Telegram не обязателен, фокус на e-mail");
    await p.fill("#email", "  ivan@mail.ru "); await p.fill("#tg", "@ab"); await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "tgErr,autoErr" && s.focus === "tg", "e-mail принят (пробелы срезаны), короткое имя в Telegram — ошибка");
    await p.fill("#tg", "https://t.me/magnat_user"); await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "autoErr" && s.focus === "autopay" && !s.done, "ссылка t.me/имя принята; без согласия на автопродление — не уходит");
    for (const [v, good] of [["ivan@mail", false], ["ivan mail@mail.ru", false], ["ivan@mail.рф", true], ["a.b-c+d@yandex.ru", true]]) {
      const r = await p.evaluate(x => emailOk(x), v);
      if (r !== good) bad(`e-mail «${v}» — ${r ? "принят" : "отклонён"}, а должен быть ${good ? "принят" : "отклонён"}`);
    }
    for (const [v, good] of [["", true], ["@magnat_user", true], ["t.me/Magnat2026", true], ["1magnat", false], ["маг_нат_юзер", false], ["@abcd", false], ["a".repeat(33), false]]) {
      const r = await p.evaluate(x => tgOk(tgClean(x)), v);
      if (r !== good) bad(`Telegram «${v}» — ${r ? "принят" : "отклонён"}, а должен быть ${good ? "принят" : "отклонён"}`);
    }
    ok("проверка e-mail и Telegram на краях (домен, кириллица, @, t.me/, длина)");

    // ---- 4. Честность: оплата не подключена — ничего не уходит ---------------------
    console.log("\n4. Пока оплата не подключена — ничего не уходит");
    check(!cfg.pay && await p.isVisible("#soon"), "CFG.pay пустой, плашка «Оплата на сайте подключается» видна");
    const reqs = []; p.on("request", r => reqs.push(r.method() + " " + r.url()));
    await p.check("#autopay"); await p.click("#payBtn"); await p.waitForTimeout(400); s = await st();
    const doneTxt = await p.textContent("#done");
    check(s.done && !s.form && !s.errs.length && /не подключена/.test(doneTxt) && /никуда не отправлены/.test(doneTxt) && /Ничего не списано/.test(doneTxt),
      "заполненная форма: «Оплата пока не подключена… Ничего не списано, данные никуда не отправлены»");
    check(reqs.length === 0 && posted.length === 0, "ни одного запроса при отправке" + (reqs.length ? ": " + reqs.join(", ") : ""));
    check(await p.getAttribute("#done a.pay", "href") === "app.html?start", "дальше — «Открыть Магнат» (бесплатно)");
    await p.context().close();

    // ---- 4б. Оплата подключена — заказ уходит целиком ------------------------------
    p = await open("checkout.html?plan=month");
    await p.evaluate(() => { CFG.pay = "/api/checkout"; fill(); });
    check(!(await p.isVisible("#soon")), "вписан адрес оплаты — плашка «подключается» прячется");
    await p.fill("#email", "ivan@mail.ru"); await p.fill("#tg", "magnat_user"); await p.check("#autopay");
    const consent = await p.textContent("#autoTxt");
    await Promise.all([p.waitForNavigation(), p.click("#payBtn")]);
    const o = posted[0];
    const got = o ? Object.fromEntries(o.body) : {};
    check(o && o.url === "/api/checkout" && got.plan === "month" && got.email === "ivan@mail.ru" && got.telegram === "@magnat_user" && got.autopay === "1" && got.consent === consent && got.terms === iso,
      "вписан адрес — уходит POST: тариф, почта, Telegram, согласие его словами, редакция соглашения: " + JSON.stringify(got));
    await p.context().close();

    // ---- 5. В браузере -------------------------------------------------------------
    console.log("\n5. В браузере под CSP сервера");
    const probs = [];
    for (const w of [320, 390, 1280]) {
      const q = await open("checkout.html", w);
      await q.evaluate(() => document.fonts.ready);
      const r = await q.evaluate(() => ({
        sx: document.documentElement.scrollWidth - innerWidth,
        font: [...document.fonts].some(x => x.family.includes("Manrope") && x.status === "loaded"),
        small: [...document.querySelectorAll(".opt, .check, .inp, #payBtn, header a")].filter(e => e.getBoundingClientRect().height < 44).map(e => e.className || e.id),
        title: document.title, lang: document.documentElement.lang, h1: document.querySelectorAll("h1").length,
        noindex: !!document.querySelector('meta[name="robots"][content*="noindex"]'),
        labels: ["email", "tg"].every(id => document.querySelector(`label[for="${id}"]`)),
      }));
      if (r.sx > 0) probs.push(`${w}px: прокрутка вбок на ${r.sx}px`);
      if (!r.font) probs.push(`${w}px: Manrope не загрузился`);
      if (r.small.length) probs.push(`${w}px: ниже 44 px — ${r.small.join(", ")}`);
      if (!/Магнат/.test(r.title) || r.lang !== "ru" || r.h1 !== 1 || !r.noindex || !r.labels) probs.push("нет названия, lang=ru, одного h1, noindex или подписей полей");
      await q.context().close();
    }
    check(!probs.length, "320 / 390 / 1280 — без прокрутки вбок, свой шрифт, касания ≥ 44 px, поля подписаны" + (probs.length ? ": " + probs.join("; ") : ""));
    const hrefs = [...raw.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    const dead = hrefs.filter(h => !/^(mailto:|\/$)/.test(h) && !fs.existsSync(path.join(APP_DIR, h.split(/[?#]/)[0])));
    const mail = [...new Set(hrefs.filter(h => h.startsWith("mailto:")))], docMail = (pricing.match(/href="(mailto:[^"]+)"/) || [])[1];
    check(!dead.length && ["pricing.html", "terms.html", "privacy.html"].every(f => hrefs.includes(f)), "ссылки ведут на существующие файлы, внизу тарифы, соглашение и политика" + (dead.length ? " — мёртвые: " + dead.join(", ") : ""));
    check(mail.length === 1 && mail[0] === docMail, "поддержка та же, что в тарифах: " + mail.join(", "));
    check(!errs.length, "ошибок на страницах нет" + (errs.length ? ": " + [...new Set(errs)].slice(0, 3).join(" | ") : ""));
  } finally {
    await b.close(); srv.close();
  }
  console.log(fails ? `\n✗ checkout: ${fails} проблем` : "\ncheckout: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

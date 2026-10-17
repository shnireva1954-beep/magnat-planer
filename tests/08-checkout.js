// Оплата доступа (09.10.2026, разовая через Платегу — 17.10.2026) — путь покупки и честность
// формы. Что сторожится:
//   1. путь виден: на главной и в тарифах есть «Оформить» → checkout.html с выбранным тарифом;
//   2. цена одна: CFG оформления = тарифы (data-price) = CFG главной = PLANS сервера (рубли и
//      дни); дата соглашения, которая уходит с заказом, = дата в terms.html = TERMS_ED сервера
//      (иначе в споре с банком не доказать, что принято);
//   3. правила формы: флажок согласия заранее НЕ отмечен; без него, без e-mail или с неверным
//      Telegram не отправить; Telegram — по желанию; сумма и текст согласия — по тарифу; про
//      автопродление ни слова — оплата разовая; вошёл в приложении (magnat_app_v2 → _sync) —
//      почта входа сама в пустом поле и «Ты вошёл в Магнат как …», битые данные — мимо;
//   4. честность: пока CFG.pay пустой, форма никуда не уходит (ни одного запроса) и страница
//      говорит «оплата не подключена»; возврат ?o=… тоже ничего не спрашивает;
//   5. оплата подключена (CFG.pay подменяется в ответе сервера, файл остаётся с pay: ""):
//      уходит ровно один POST JSON {plan, email, telegram, consent, terms}, согласие — видимым
//      текстом; ok — заказ запомнен (magnat_pay_v1) и переход только на https://; ошибки
//      сервера — своими словами, кнопка снова живая;
//   6. возврат со страницы оплаты ?o=<номер>[&fail=1]: опрос /api/order сразу, каждые 3 с,
//      до 3 минут, дальше «Проверить ещё раз»; pending → paid — «Доступ до ДД.ММ.ГГГГ» по
//      Москве (как в письмах) и почта маской; оплачено, а почты нет — в поддержку, без
//      обещания входа; failed и fail=1 — «не прошла» и «Попробовать снова» с тарифом, но
//      «деньги не списаны» — только при failed от сервера (fail=1 при «ждём», без связи и до
//      ответа — «если всё же списались…»); кривой номер — обычная форма; данные сервера не
//      исполняются (никакого innerHTML);
//   7. в браузере под CSP сервера: без ошибок, без прокрутки вбок на 320–1280, кнопки ≥ 44 px.
const { chromium, chromePath, APP_DIR } = require("./lib");
const fs = require("fs"), path = require("path"), http = require("http");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };
const check = (cond, m) => cond ? ok(m) : bad(m);

const read = f => fs.readFileSync(path.join(APP_DIR, f), "utf8");
const nf = n => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ");
const MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const PUB = "k3_Zq9-xW2pL7mN4bV8cT1";            // номер заказа как у сервера: token_urlsafe(16), 22 знака
const PAYURL = "https://pay.example/pay/abc?x=1"; // страница оплаты — поддельная, в сеть не ходим
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ждать условия по настоящему времени (часы страницы в части проверок подделаны)
// (страница могла уйти по ссылке — тогда вопрос к ней бросает, это «нет»)
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(40); } return false; };

// тот же сервер, что в 07-docs, плюс приём POST: сюда не должно прийти ни одного —
// живой /api в проверках поддельный (page.route), а обычной отправки формы больше нет
const posted = [];
function serve(root, csp) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg" };
  return new Promise(res => {
    const s = http.createServer((rq, rs) => {
      if (rq.method === "POST") {
        let body = ""; rq.on("data", c => body += c);
        rq.on("end", () => { posted.push({ url: rq.url, body }); rs.writeHead(404); rs.end(); });
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
const json = (route, x) => route.fulfill({ status: 200, contentType: "application/json", body: typeof x === "string" ? x : JSON.stringify(x) });

(async () => {
  const csp = (read("server/Caddyfile").match(/Content-Security-Policy "([^"]+)"/) || [])[1];
  if (!csp) bad("CSP в server/Caddyfile не найдена");
  const srv = await serve(APP_DIR, csp || "");
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const b = await chromium.launch({ executablePath: chromePath() });
  const errs = [];
  // live — CFG.pay = "/api/checkout" (подмена строки в ответе сервера); api — поддельный /api;
  // clock — часы страницы стоят и идут только по runFor/fastForward; quiet — ожидаемые ошибки
  // консоли (оборванный запрос в проверке «нет сети»); tz — часовой пояс телефона; ls — ключи
  // localStorage, лежащие на телефоне до открытия страницы
  const open = async (url, o = {}) => {
    const ctx = await b.newContext({ viewport: { width: o.w || 390, height: 844 }, ...(o.tz ? { timezoneId: o.tz } : {}) });
    if (o.ls) await ctx.addInitScript(ls => { for (const [k, v] of Object.entries(ls)) try { localStorage.setItem(k, v); } catch (e) {} }, o.ls);
    if (o.live) await ctx.route(u => u.pathname === "/checkout.html", async route => {
      const r = await route.fetch(), t = await r.text();
      await route.fulfill({ response: r, body: t.replace('pay: "",', 'pay: "/api/checkout",') });
    });
    if (o.api) await ctx.route(u => u.pathname.startsWith("/api/"), o.api);
    await ctx.route(u => u.hostname === "pay.example", route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: '<!doctype html><title>Платега</title><link rel="icon" href="data:,">' }));
    const p = await ctx.newPage();
    if (o.clock) { const T = Date.now(); await p.clock.install({ time: T }); await p.clock.pauseAt(T + 1000); }
    p.reqs = []; p.on("request", r => p.reqs.push(r));
    p.on("pageerror", e => errs.push(url + ": " + e.message));
    p.on("console", m => { if (m.type() === "error" && !(o.quiet && o.quiet.test(m.text()))) errs.push(url + ": " + m.text()); });
    await p.goto(base + url); await p.waitForTimeout(300);
    if (o.live && await p.evaluate(() => CFG.pay) !== "/api/checkout") bad(`${url}: подмена CFG.pay не сработала — в checkout.html нет строки pay: "",`);
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
      `главная: «Оформить» ведёт с выбранным тарифом (год → ${h0}, месяц → ${h1})`);
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
    console.log("\n2. Цена одна везде (и на сервере), дата соглашения та же");
    p = await open("checkout.html");
    const cfg = await p.evaluate(() => JSON.parse(JSON.stringify(CFG)));
    const pricing = read("pricing.html").replace(/&nbsp;| /g, " ");
    const pp = k => ((pricing.match(new RegExp(`data-price="${k}"[^>]*>([^<]+)`)) || [])[1] || "").replace(/\s+/g, " ").trim();
    check(pp("month").startsWith(`${nf(cfg.month)} ₽`) && pp("year").startsWith(`${nf(cfg.year)} ₽`) && cfg.month === land.month && cfg.year === land.year,
      `оформление = тарифы = главная: ${cfg.month} ₽ за месяц, ${nf(cfg.year)} ₽ за год`);
    const raw = read("checkout.html");
    const markup = k => ((raw.match(new RegExp(`data-price="${k}"[^>]*>([^<]+)`)) || [])[1] || "").replace(/&nbsp;| /g, " ").trim();
    check(markup("month").startsWith(`${nf(cfg.month)} ₽`) && markup("year").startsWith(`${nf(cfg.year)} ₽`), "запасные цены в разметке (без скрипта) — те же");
    // сервер берёт деньги по своей таблице: PLANS = {'month': (копейки, дни, …), 'year': (…)}
    const apiSrc = read("server/api/api.py");
    const plans = (apiSrc.match(/^PLANS\s*=\s*\{([^}]*)\}/m) || [])[1] || "";
    const sp = k => { const m = plans.match(new RegExp(`['"]${k}['"]\\s*:\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)`)); return m ? { kop: +m[1], days: +m[2] } : null; };
    const sm = sp("month"), sy = sp("year");
    check(sm && sy && sm.kop === cfg.month * 100 && sy.kop === cfg.year * 100 && cfg.days && sm.days === cfg.days.month && sy.days === cfg.days.year,
      `оформление = PLANS сервера: ${sm ? sm.kop / 100 + " ₽ за " + sm.days + " дней" : "нет month"}, ${sy ? sy.kop / 100 + " ₽ за " + sy.days + " дней" : "нет year"}`);
    const td = read("terms.html").match(/Дата обновления: (\d+) (\S+) (\d{4})/);
    const iso = td ? `${td[3]}-${String(MONTHS.indexOf(td[2]) + 1).padStart(2, "0")}-${td[1].padStart(2, "0")}` : "?";
    const ted = (apiSrc.match(/^TERMS_ED\s*=\s*['"]([^'"]+)['"]/m) || [])[1];
    const sent = await p.getAttribute('input[name="terms"]', "value");
    check(sent === iso && sent === ted, `с заказом уходит редакция соглашения ${sent} — та же, что в terms.html (${iso}) и TERMS_ED сервера (${ted})`);
    const rp = (apiSrc.match(/^RE_PUB\s*=\s*re\.compile\(r?'([^']+)'\)/m) || [])[1];
    check(await p.evaluate(() => RE_PUB.source) === `^${rp}$`, `номер заказа в адресе возврата проверяется так же, как на сервере (RE_PUB ${rp})`);

    // ---- 3. Правила формы --------------------------------------------------------
    console.log("\n3. Правила формы");
    const st = () => p.evaluate(() => ({
      agree: document.getElementById("agree").checked, done: !document.getElementById("done").hidden, form: !document.getElementById("buy").hidden,
      errs: ["emailErr", "tgErr", "agreeErr"].filter(id => !document.getElementById(id).hidden),
      focus: document.activeElement && document.activeElement.id,
      now: document.getElementById("sumNow").textContent, days: document.getElementById("sumDays").textContent, consent: consent(),
      shown: document.getElementById("agreeTxt").innerText.replace(/\s+/g, " ").trim(),
      btn: !document.getElementById("payBtn").disabled,
    }));
    let s = await st();
    check(!s.agree, "флажок согласия заранее НЕ отмечен");
    check(s.btn, "кнопка «Перейти к оплате» включена скриптом (без скрипта выключена)");
    check(/disabled/.test((raw.match(/<button[^>]*id="payBtn"[^>]*>/) || [""])[0]), "в разметке кнопка выключена — без скрипта форма никуда не уйдёт");
    const auto = raw.match(/автопродл|autopay|продлевается|списываются|пока не отменишь|отменить подписку/i);
    check(!auto && raw.includes("Разовая оплата, без автосписаний. Продлить — оплатить снова, дни прибавятся."),
      "оплата разовая: строка «Разовая оплата, без автосписаний…» есть, про автопродление ни слова" + (auto ? ` — нашлось «${auto[0]}»` : ""));
    check(s.now === `${nf(cfg.year)} ₽` && s.days.includes(`${cfg.days.year} дней`) && s.consent.startsWith(`Оплачиваю доступ к Магнату на ${cfg.days.year} дней — ${nf(cfg.year)} ₽, разово, без автосписаний.`),
      `по умолчанию год: к оплате ${s.now}, согласие «${s.consent}»`);
    await p.check('input[name="plan"][value="month"]'); s = await st();
    check(s.now === `${nf(cfg.month)} ₽` && s.days.includes(`${cfg.days.month} дней`) && !s.consent.includes(String(cfg.days.year)) &&
      s.consent === `Оплачиваю доступ к Магнату на ${cfg.days.month} дней — ${nf(cfg.month)} ₽, разово, без автосписаний. Принимаю пользовательское соглашение, с политикой конфиденциальности ознакомлен.`,
      `сменил тариф на месяц — сумма и текст согласия сменились: «${s.consent}»`);
    check(s.consent === s.shown && await p.$$eval("#agreeTxt a", as => as.map(a => a.getAttribute("href")).join()) === "terms.html,privacy.html",
      "согласие — ровно видимый текст у флажка, со ссылками на соглашение и политику");
    await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "emailErr,agreeErr" && s.focus === "email" && s.form && !s.done, "пустая форма не уходит: ошибки у e-mail и согласия, Telegram не обязателен, фокус на e-mail");
    await p.fill("#email", "  ivan@mail.ru "); await p.fill("#tg", "@ab"); await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "tgErr,agreeErr" && s.focus === "tg", "e-mail принят (пробелы срезаны), короткое имя в Telegram — ошибка");
    await p.fill("#tg", "https://t.me/magnat_user"); await p.click("#payBtn"); s = await st();
    check(s.errs.join() === "agreeErr" && s.focus === "agree" && !s.done, "ссылка t.me/имя принята; без согласия — не уходит");
    for (const [v, good] of [["ivan@mail", false], ["ivan mail@mail.ru", false], ["ivan@mail.рф", true], ["a.b-c+d@yandex.ru", true]]) {
      const r = await p.evaluate(x => emailOk(x), v);
      if (r !== good) bad(`e-mail «${v}» — ${r ? "принят" : "отклонён"}, а должен быть ${good ? "принят" : "отклонён"}`);
    }
    for (const [v, good] of [["", true], ["@magnat_user", true], ["t.me/Magnat2026", true], ["1magnat", false], ["маг_нат_юзер", false], ["@abcd", false], ["a".repeat(33), false]]) {
      const r = await p.evaluate(x => tgOk(tgClean(x)), v);
      if (r !== good) bad(`Telegram «${v}» — ${r ? "принят" : "отклонён"}, а должен быть ${good ? "принят" : "отклонён"}`);
    }
    ok("проверка e-mail и Telegram на краях (домен, кириллица, @, t.me/, длина)");

    // вошёл в приложении по почте — оплата привяжется к этому аккаунту: почта входа в пустом поле
    const ACC = "Ты вошёл в Магнат как ivan@mail.ru: доступ привяжется к этому аккаунту.";
    const em = pg => pg.evaluate(() => { const h = document.getElementById("emailAcct"); return { v: document.getElementById("email").value, h: h.hidden ? "" : h.textContent, btn: !document.getElementById("payBtn").disabled }; });
    let pa = await open("checkout.html", { ls: { magnat_app_v2: JSON.stringify({ habits: [], _sync: { v: 1, acct: "a_7f3k", mail: "ivan@mail.ru", dev: "d1", off: false } }) } });
    let e0 = await em(pa);
    await pa.fill("#email", "petr@mail.ru"); const e1 = await em(pa);
    await pa.fill("#email", " Ivan@mail.ru "); const e2 = await em(pa);
    check(e0.v === "ivan@mail.ru" && e0.h === ACC && e1.h === "" && e2.h === ACC,
      `вошёл в приложении — почта входа в поле и «${e0.h}»; другая почта — подсказка прячется`);
    await pa.context().close();
    const junkAcc = [["вышел (off)", JSON.stringify({ _sync: { acct: "a_7f3k", mail: "ivan@mail.ru", off: true } })], ["без acct", JSON.stringify({ _sync: { mail: "ivan@mail.ru" } })],
      ["почта не строка", JSON.stringify({ _sync: { acct: "a_7f3k", mail: { x: 1 } } })], ["кривая почта", JSON.stringify({ _sync: { acct: "a_7f3k", mail: "ivan" } })],
      ["_sync строкой", JSON.stringify({ _sync: "a" })], ["битая строка", "{не JSON"], ["null", "null"], ["число", "5"]];
    const junkBad = [];
    for (const [what, v] of junkAcc) {
      pa = await open("checkout.html", { ls: { magnat_app_v2: v } });
      e0 = await em(pa);
      if (e0.v || e0.h || !e0.btn) junkBad.push(`${what}: «${e0.v}» «${e0.h}»${e0.btn ? "" : ", кнопка мёртвая"}`);
      await pa.context().close();
    }
    check(!junkBad.length, "не вошёл, вышел или данные битые — поле пустое, подсказки нет, страница живая" + (junkBad.length ? ": " + junkBad.join("; ") : ""));

    // ---- 4. Честность: оплата не подключена — ничего не уходит ---------------------
    console.log("\n4. Пока оплата не подключена — ничего не уходит");
    check(!cfg.pay && await p.isVisible("#soon"), "CFG.pay пустой, плашка «Оплата на сайте подключается» видна");
    const reqs = []; p.on("request", r => reqs.push(r.method() + " " + r.url()));
    await p.check("#agree"); await p.click("#payBtn"); await p.waitForTimeout(400); s = await st();
    const doneTxt = await p.textContent("#done");
    check(s.done && !s.form && !s.errs.length && /не подключена/.test(doneTxt) && /никуда не отправлены/.test(doneTxt) && /Ничего не списано/.test(doneTxt),
      "заполненная форма: «Оплата пока не подключена… Ничего не списано, данные никуда не отправлены»");
    check(reqs.length === 0 && posted.length === 0, "ни одного запроса при отправке" + (reqs.length ? ": " + reqs.join(", ") : ""));
    check(await p.getAttribute("#done a.pay", "href") === "app.html?start", "дальше — «Открыть Магнат» (бесплатно)");
    await p.context().close();
    p = await open(`checkout.html?o=${PUB}`);
    const offAsk = p.reqs.filter(r => r.method() !== "GET" || /fetch|xhr/.test(r.resourceType()) || /\/api\//.test(r.url())).map(r => r.method() + " " + r.url());
    const offTxt = await p.textContent("#back");
    check(!offAsk.length && await p.isVisible("#back") && !(await p.isVisible("#buy")) && /не подключена/.test(offTxt),
      "возврат ?o=… без оплаты: ни одного запроса к серверу, честное «не подключена»" + (offAsk.length ? ": " + offAsk.join(", ") : ""));
    await p.context().close();

    // ---- 5. Оплата подключена: заказ уходит целиком, ошибки словами --------------------
    console.log("\n5. Оплата подключена: один POST JSON, переход только на https://, ошибки словами");
    let reply = null; const calls = [];
    p = await open("checkout.html?plan=month", { live: true, quiet: /ERR_INTERNET_DISCONNECTED|Failed to load resource/, api: async (route, rq) => {
      calls.push(rq);
      if (reply === "abort") return route.abort("internetdisconnected");
      return json(route, reply);
    } });
    check(!(await p.isVisible("#soon")) && !(await p.isChecked("#agree")), "вписан адрес оплаты — плашка «подключается» спрятана, флажок согласия не отмечен");
    await p.click("#payBtn"); await p.waitForTimeout(150);
    await p.fill("#email", "ivan@mail.ru"); await p.fill("#tg", "@ab"); await p.click("#payBtn"); await p.waitForTimeout(150);
    await p.fill("#tg", "magnat_user"); await p.click("#payBtn"); await p.waitForTimeout(150);
    check(calls.length === 0 && await p.isVisible("#agreeErr"), "без почты, с плохим Telegram, без согласия — к серверу не ушло ничего" + (calls.length ? ` (ушло ${calls.length})` : ""));
    await p.check("#agree");
    const said = [];
    const store = async () => (await p.context().storageState()).origins.flatMap(x => x.localStorage).find(x => x.name === "magnat_pay_v1");
    for (const [code, re] of [["pay_off", /не подключена/], ["platega", /Платёжный сервис не ответил/], ["slow", /Слишком часто/], ["terms", /Условия обновились/],
      ["abort", /Нет связи/], ["bad", /в форме не так/], ["junk", /Не получилось начать оплату/]]) {
      reply = code === "abort" ? "abort" : code === "junk" ? "<html>не JSON</html>" : { ok: false, err: code };
      const n = calls.length;
      await p.click("#payBtn", { timeout: 3000 }).catch(() => {});
      const back = await until(() => p.evaluate(() => !document.getElementById("payBtn").disabled && !document.getElementById("payErr").hidden));
      const r = await p.evaluate(() => ({ t: document.getElementById("payErr").textContent, btn: document.getElementById("payBtn").textContent, url: location.pathname })).catch(() => ({}));
      said.push(r.t);
      check(back && calls.length === n + 1 && re.test(r.t) && r.btn === "Перейти к оплате" && r.url === "/checkout.html" && !(await store()),
        `ответ ${code === "abort" ? "«нет сети»" : code}: «${r.t}», кнопка снова живая, перехода нет`);
    }
    check(new Set(said).size === said.length, "у каждой ошибки свои слова");
    reply = { ok: false, err: "email" };
    await p.click("#payBtn", { timeout: 3000 }).catch(() => {});
    await until(() => p.evaluate(() => !document.getElementById("payBtn").disabled));
    s = await p.evaluate(() => ({ e: !document.getElementById("emailErr").hidden, f: document.activeElement.id, m: document.getElementById("payErr").hidden })).catch(() => ({}));
    check(s.e && s.f === "email" && s.m, "сервер не принял почту — ошибка под полем e-mail, фокус на нём");
    for (const url of ["http://pay.example/pay/abc", "javascript:alert(1)", "//pay.example/x"]) {
      reply = { ok: true, url, o: PUB };
      await p.click("#payBtn", { timeout: 3000 }).catch(() => {});
      const back = await until(() => p.evaluate(() => !document.getElementById("payBtn").disabled && !document.getElementById("payErr").hidden));
      const t = await p.textContent("#payErr", { timeout: 1000 }).catch(() => "");
      check(back && /неверную ссылку/.test(t) && new URL(p.url()).pathname === "/checkout.html" && !(await store()), `ссылка ${url} — не https: перехода нет, «${t}», заказ не запомнен`);
    }
    await p.context().close();

    // успешный заказ: двойное нажатие — один запрос; тело — ровно пять полей; переход на ссылку
    const sentReq = [];
    p = await open("checkout.html?plan=month", { live: true, api: async (route, rq) => {
      sentReq.push(rq); await sleep(300); return json(route, { ok: true, url: PAYURL, o: PUB });
    } });
    await p.fill("#email", "  ivan@mail.ru "); await p.fill("#tg", "magnat_user"); await p.check("#agree");
    const shown = await p.evaluate(() => document.getElementById("agreeTxt").innerText.replace(/\s+/g, " ").trim());
    await p.evaluate(() => { const f = document.getElementById("buy"); f.requestSubmit(); f.requestSubmit(); });
    const wait = await p.evaluate(() => [document.getElementById("payBtn").disabled, document.getElementById("payBtn").textContent]);
    check(wait[0] && wait[1] === "Переходим к оплате…", "пока сервер думает — кнопка выключена: «Переходим к оплате…»");
    await p.waitForURL(u => u.hostname === "pay.example", { timeout: 5000 }).catch(() => {});
    const q = sentReq[0], body = q ? q.postDataJSON() : {};
    check(sentReq.length === 1 && q.method() === "POST" && new URL(q.url()).pathname === "/api/checkout" && /^application\/json/.test(q.headers()["content-type"] || ""),
      `уходит ровно один POST JSON на /api/checkout (запросов: ${sentReq.length})`);
    check(Object.keys(body).sort().join() === "consent,email,plan,telegram,terms" && body.plan === "month" && body.email === "ivan@mail.ru" && body.telegram === "@magnat_user" && body.consent === shown && body.terms === sent,
      "в заказе тариф, почта, Telegram, согласие его же словами и редакция соглашения — и ничего больше: " + JSON.stringify(body));
    const saved = await store(); let sv = null; try { sv = JSON.parse(saved.value); } catch (e) {}
    check(sv && sv.o === PUB && sv.email === "ivan@mail.ru" && sv.plan === "month" && Math.abs(Date.now() - sv.at) < 60000,
      "заказ запомнен на телефоне (magnat_pay_v1: номер, почта, тариф, время): " + (saved ? saved.value : "нет"));
    check(p.url() === PAYURL, "переход на страницу оплаты из ответа сервера: " + p.url());
    await p.context().close();

    // ---- 6. Возврат со страницы оплаты -------------------------------------------------
    console.log("\n6. Возврат со страницы оплаты: статус заказа");
    const backSt = pg => pg.evaluate(() => {
      const el = id => document.getElementById(id), go = el("backGo");
      return { form: !el("buy").hidden, back: !el("back").hidden, title: el("backTitle").textContent, txt: el("backTxt").textContent,
        hint: el("backHint").hidden ? "" : el("backHint").textContent, go: go.hidden ? null : [go.textContent, go.getAttribute("href")], again: !el("again").hidden };
    });
    const UNTIL = Date.UTC(2026, 10, 16, 12) / 1000;   // полдень по UTC — 16.11.2026 в любом поясе России
    let seq = [], asked = [];
    const orderApi = async (route, rq) => { asked.push(rq); const x = seq.length > 1 ? seq.shift() : seq[0]; return x === "abort" ? route.abort("internetdisconnected") : json(route, x); };
    seq = [{ ok: true, status: "pending", plan: "month" }, { ok: true, status: "paid", plan: "month", until: UNTIL, email: "i•••@mail.ru" }];
    p = await open(`checkout.html?o=${PUB}`, { live: true, clock: true, api: orderApi });
    await until(() => asked.length >= 1);
    s = await backSt(p);
    const ab = asked[0] ? asked[0].postDataJSON() : {};
    check(asked.length === 1 && asked[0].method() === "POST" && new URL(asked[0].url()).pathname === "/api/order" && JSON.stringify(ab) === JSON.stringify({ o: PUB }),
      "возврат: сразу один POST /api/order {o} — " + JSON.stringify(ab));
    check(!s.form && s.back && /Ждём подтверждения/.test(s.title) && !s.go && !s.again, `pending — форма скрыта, «${s.title}»`);
    await p.clock.runFor(2900); await sleep(250);
    const n29 = asked.length;
    await p.clock.runFor(200); await until(() => asked.length >= 2); await sleep(100);
    s = await backSt(p);
    check(n29 === 1 && asked.length === 2, `следующий вопрос — через 3 с, не раньше (к 2,9 с: ${n29}, к 3,1 с: ${asked.length})`);
    check(s.title === "Оплата прошла" && s.txt === "Доступ до 16.11.2026." && s.hint.includes("i•••@mail.ru") && /на всех твоих телефонах/.test(s.hint) && s.go && s.go.join() === "Открыть Магнат,app.html",
      `paid — «${s.title}. ${s.txt}», ${s.hint}, кнопка ${s.go && s.go.join(" → ")}`);
    await p.clock.runFor(15000); await sleep(250);
    check(asked.length === 2, "оплачено — больше не спрашиваем" + (asked.length !== 2 ? ` (спросили ${asked.length})` : ""));
    await p.context().close();

    // три минуты без ответа — опрос встаёт, дальше «Проверить ещё раз»
    seq = [{ ok: true, status: "pending", plan: "year" }]; asked = [];
    p = await open(`checkout.html?o=${PUB}`, { live: true, clock: true, api: orderApi });
    await until(() => asked.length >= 1);
    await p.clock.fastForward(170000); await until(() => asked.length >= 2); await sleep(100);
    const s170 = await backSt(p);
    await p.clock.fastForward(10001); await until(() => asked.length >= 3); await sleep(100);
    s = await backSt(p);
    await p.clock.runFor(30000); await sleep(250);
    const n3 = asked.length;
    check(!s170.again && /Ждём/.test(s170.title) && s.again && /ещё не подтвердилась/.test(s.title) && /поддержку/.test(s.txt) && n3 === 3,
      `до 3 минут спрашиваем, после — стоп и «Проверить ещё раз» (вопросов: ${n3}, «${s.title}»)`);
    if (s.again) await p.click("#again", { timeout: 3000 }).catch(() => {});
    await until(() => asked.length >= 4); await sleep(100);
    s = await backSt(p);
    check(asked.length === 4 && !s.again && /Ждём/.test(s.title), "«Проверить ещё раз» — сразу спрашивает снова, кнопка прячется");
    await p.context().close();

    // не прошла: статус failed — и fail=1 из адреса Платеги, даже если сервер ещё ждёт.
    // «Деньги не списаны» — только со слов сервера; одна Платега — «если всё же списались…»
    const SURE = "Деньги не списаны. Можно попробовать ещё раз — тем же или другим способом.";
    const MAYBE = "Если деньги всё же списались, доступ включится сам — придёт письмо. Иначе можно попробовать ещё раз.";
    for (const [url, rep, k, txt, what] of [[`checkout.html?o=${PUB}`, { ok: true, status: "failed", plan: "month" }, "month", SURE, "failed"],
      [`checkout.html?o=${PUB}&fail=1`, { ok: true, status: "failed", plan: "month" }, "month", SURE, "fail=1 и failed"],
      [`checkout.html?o=${PUB}&fail=1`, { ok: true, status: "pending", plan: "year" }, "year", MAYBE, "fail=1 при pending"],
      [`checkout.html?o=${PUB}&fail=1`, "abort", "", MAYBE, "fail=1 без связи"]]) {
      seq = [rep]; asked = [];
      p = await open(url, { live: true, clock: true, api: orderApi, quiet: /ERR_INTERNET_DISCONNECTED|Failed to load resource/ });
      await until(() => asked.length >= 1); await sleep(100);
      await p.clock.runFor(15000); await sleep(250);
      s = await backSt(p);
      check(s.title === "Оплата не прошла" && s.txt === txt && s.go && s.go.join() === "Попробовать снова,checkout.html" + (k ? "?plan=" + k : "") && asked.length === 1,
        `${what} — «${s.title}. ${s.txt}», «Попробовать снова» → ${s.go && s.go[1]}, больше не спрашиваем`);
      await p.context().close();
    }
    // fail=1, сервер ещё не ответил — «не списаны» не обещаем; ответил failed — уже можно
    let release = null; const gate = new Promise(r => { release = r; }); asked = [];
    p = await open(`checkout.html?o=${PUB}&fail=1`, { live: true, api: async (route, rq) => { asked.push(rq); await gate; return json(route, { ok: true, status: "failed", plan: "month" }); } });
    await until(() => asked.length >= 1);
    const s0 = await backSt(p);
    release(); await until(() => p.evaluate(() => /не списаны/.test(document.getElementById("backTxt").textContent)));
    s = await backSt(p);
    check(s0.title === "Оплата не прошла" && s0.txt === MAYBE && s.txt === SURE,
      `fail=1 до ответа сервера — «${s0.txt}», после failed — «${s.txt}»`);
    await p.context().close();
    seq = [{ ok: true, status: "paid", plan: "year", until: UNTIL, email: "i•••@mail.ru" }]; asked = [];
    p = await open(`checkout.html?o=${PUB}&fail=1`, { live: true, api: orderApi });
    await until(() => asked.length >= 1); await sleep(100); s = await backSt(p);
    check(s.title === "Оплата прошла", "fail=1, но сервер говорит «оплачено» — верим серверу: " + s.title);
    await p.context().close();
    seq = [{ ok: false, err: "order" }]; asked = [];
    p = await open(`checkout.html?o=${PUB}`, { live: true, api: orderApi });
    await until(() => asked.length >= 1); await sleep(100); s = await backSt(p);
    check(/не найден/.test(s.title) && s.go && s.go[1] === "checkout.html", `сервер не знает заказ — «${s.title}», «${s.go && s.go[0]}»`);
    await p.context().close();

    // оплачено, а почты у заказа нет (аккаунт удалён, пока счёт ждал) — входа не обещаем, в поддержку
    const sup = (pricing.match(/href="mailto:([^"?]+)/) || [])[1] || "?";
    seq = [{ ok: true, status: "paid", plan: "year", until: UNTIL, email: "" }]; asked = [];
    p = await open(`checkout.html?o=${PUB}`, { live: true, api: orderApi });
    await until(() => asked.length >= 1); await sleep(100); s = await backSt(p);
    check(s.title === "Оплата прошла" && s.txt === `Напиши в поддержку (${sup}) с номером платежа — включим доступ вручную.` && !s.hint && !/войд|войти|Доступ до|включён/.test(s.txt) &&
      s.go && s.go[0] === "Написать в поддержку" && s.go[1].startsWith(`mailto:${sup}?`) && decodeURIComponent(s.go[1]).includes(PUB),
      `оплачено без почты — «${s.title}. ${s.txt}», вход не обещан, кнопка → ${s.go && s.go[1]}`);
    await p.context().close();

    // «Доступ до» — день по Москве, как в письмах сервера, а не по часам телефона
    const dayBad = [];
    for (const [tz, t, want] of [["Asia/Chita", Date.UTC(2026, 10, 16, 18) / 1000, "16.11.2026"], ["Europe/Kaliningrad", Date.UTC(2026, 10, 16, 21, 30) / 1000, "17.11.2026"]]) {
      seq = [{ ok: true, status: "paid", plan: "year", until: t, email: "i•••@mail.ru" }]; asked = [];
      p = await open(`checkout.html?o=${PUB}`, { live: true, tz, api: orderApi });
      await until(() => asked.length >= 1); await sleep(100); s = await backSt(p);
      if (s.txt !== `Доступ до ${want}.`) dayBad.push(`${tz}: «${s.txt}», а по Москве ${want}`);
      await p.context().close();
    }
    check(!dayBad.length, "«Доступ до» — день по Москве и в Чите, и в Калининграде" + (dayBad.length ? ": " + dayBad.join("; ") : ""));

    // кривой номер — обычная форма, к серверу ни слова
    for (const o of ["abc", "A".repeat(23), "A".repeat(21) + "."]) {
      asked = [];
      p = await open("checkout.html?o=" + encodeURIComponent(o), { live: true, api: orderApi });
      s = await backSt(p);
      check(s.form && !s.back && !asked.length, `?o=${o.length > 8 ? o.slice(0, 4) + "…(" + o.length + ")" : o} — обычная форма, к серверу не спрашивали`);
      await p.context().close();
    }

    // данные сервера — только текстом: <script> в почте и тарифе не исполняется
    seq = [{ ok: true, status: "paid", plan: '"><img src=x onerror="window.__xss=3">', until: UNTIL, email: '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script>p•••@gmail.com' }]; asked = [];
    p = await open(`checkout.html?o=${PUB}`, { live: true, api: orderApi });
    await until(() => asked.length >= 1); await sleep(200);
    const x = await p.evaluate(() => ({ xss: window.__xss, tags: document.querySelectorAll("#back img, #back script").length, hint: document.getElementById("backHint").textContent }));
    check(x.xss === undefined && x.tags === 0 && x.hint.includes("<script>"), "почта с <script> и <img onerror> от сервера — показана текстом, не исполнена");
    await p.context().close();
    seq = [{ ok: true, status: "failed", plan: "<script>" }]; asked = [];
    p = await open(`checkout.html?o=${PUB}`, { live: true, api: orderApi });
    await until(() => asked.length >= 1); await sleep(100); s = await backSt(p);
    check(s.go && s.go[1] === "checkout.html", "чужой тариф от сервера в ссылку «Попробовать снова» не попадает: " + (s.go && s.go[1]));
    await p.context().close();
    const html = raw.match(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
    check(!html, "на странице нет innerHTML и родни — данные сервера не могут стать разметкой" + (html ? `: ${html[0]}` : ""));

    // ---- 7. В браузере -------------------------------------------------------------
    console.log("\n7. В браузере под CSP сервера");
    const probs = [];
    const look = async (q, w) => {
      const r = await q.evaluate(() => ({
        sx: document.documentElement.scrollWidth - innerWidth,
        font: [...document.fonts].some(x => x.family.includes("Manrope") && x.status === "loaded"),
        small: [...document.querySelectorAll(".opt, .check, .inp, #payBtn, header a, #back .pay")].filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.className || e.id),
        title: document.title, lang: document.documentElement.lang, h1: document.querySelectorAll("h1").length,
        noindex: !!document.querySelector('meta[name="robots"][content*="noindex"]'),
        labels: ["email", "tg"].every(id => document.querySelector(`label[for="${id}"]`)),
      }));
      if (r.sx > 0) probs.push(`${w}px: прокрутка вбок на ${r.sx}px`);
      if (!r.font) probs.push(`${w}px: Manrope не загрузился`);
      if (r.small.length) probs.push(`${w}px: ниже 44 px — ${r.small.join(", ")}`);
      if (!/Магнат/.test(r.title) || r.lang !== "ru" || r.h1 !== 1 || !r.noindex || !r.labels) probs.push("нет названия, lang=ru, одного h1, noindex или подписей полей");
    };
    for (const w of [320, 390, 1280]) {
      const q = await open("checkout.html", { w });
      await q.evaluate(() => document.fonts.ready);
      await look(q, w);
      await q.context().close();
    }
    seq = [{ ok: true, status: "paid", plan: "year", until: UNTIL, email: "konstantin.konstantinopolsky•••@verylongdomain-example.ru" }]; asked = [];
    const qp = await open(`checkout.html?o=${PUB}`, { w: 320, live: true, api: orderApi });
    await until(() => asked.length >= 1); await qp.evaluate(() => document.fonts.ready);
    await look(qp, "320 (оплата прошла, длинная почта)");
    await qp.context().close();
    check(!probs.length, "320 / 390 / 1280 и экран «Оплата прошла» — без прокрутки вбок, свой шрифт, касания ≥ 44 px, поля подписаны" + (probs.length ? ": " + probs.join("; ") : ""));
    const hrefs = [...raw.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    const dead = hrefs.filter(h => !/^(mailto:|\/$)/.test(h) && !fs.existsSync(path.join(APP_DIR, h.split(/[?#]/)[0])));
    const mail = [...new Set(hrefs.filter(h => h.startsWith("mailto:")))], docMail = (pricing.match(/href="(mailto:[^"]+)"/) || [])[1];
    check(!dead.length && ["pricing.html", "terms.html", "privacy.html"].every(f => hrefs.includes(f)), "ссылки ведут на существующие файлы, внизу тарифы, соглашение и политика" + (dead.length ? " — мёртвые: " + dead.join(", ") : ""));
    check(mail.length === 1 && mail[0] === docMail, "поддержка та же, что в тарифах: " + mail.join(", "));
    check(!posted.length, "к настоящему серверу не ушло ни одного POST" + (posted.length ? ": " + posted.map(x => x.url).join(", ") : ""));
    check(!errs.length, "ошибок на страницах нет" + (errs.length ? ": " + [...new Set(errs)].slice(0, 3).join(" | ") : ""));
  } finally {
    await b.close(); srv.close();
  }
  console.log(fails ? `\n✗ checkout: ${fails} проблем` : "\ncheckout: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

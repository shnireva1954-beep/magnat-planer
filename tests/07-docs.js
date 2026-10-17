// Тарифы, соглашение, политика и поддержка (07.10.2026) — их требует платёжный
// сервис до согласования проекта. Что сторожится:
//   1. страницы на месте, контакт поддержки вписан (заглушка @@SUPPORT@@ — красное:
//      без контакта модерацию не пройти), ссылки ведут на существующие файлы;
//   2. цена одна во всех документах — разъехавшаяся цена в документе, который
//      клиент принимает до оплаты, — проигранный спор с банком;
//   3. обещания политики правдивы (13.10.2026: политика описывает вход по почте и
//      cookie после входа; сам вход в коде есть, но выключен — ACCOUNT_ON=false,
//      и для посетителя всё по-прежнему): в коде нет XMLHttpRequest,
//      sendBeacon, WebSocket, EventSource, document.cookie, чужих скриптов и
//      адресов наружу, а каждый fetch( в app.html — только на свой '/api/…', в
//      checkout.html — только на CFG.pay или '/api/order', на главной fetch нет; в
//      браузере посетитель (file:// и свой сервер) не делает ни одного запроса к
//      /api и на чужие адреса и не получает cookie; на file:// и в рамке Claude
//      — даже с флагом предпросмотра владельца. Добавил аналитику или включил
//      вход — сначала политика; политика обязана называть cookie «__Host-mg»,
//      Россию, «Удалить аккаунт», «Тело» только на телефоне, сроки 30/90 дней и
//      Роскомнадзор (план аккаунта, §9), а api.py — не писать личное в журнал;
//   3в. оплата разовая (17.10.2026): политика называет Platega, что ей уходит, 5 лет
//      и отвязку заказов при удалении аккаунта; соглашение — разовую оплату без
//      автосписаний, 30 и 365 дней, прибавку срока и возврат; ни одна страница сайта
//      не обещает автопродление, автосписание, отмену подписки или ссылку отмены;
//   4. страницы в браузере: без ошибок под той же CSP, что на сервере (берётся из
//      server/Caddyfile), свой шрифт, без прокрутки вбок на 320–1280;
//   5. в приложении ссылки на всё это — в приветствии и внизу «Обзора».
const { chromium, chromePath, APP_DIR, startClean } = require("./lib");
const fs = require("fs"), path = require("path"), http = require("http");
let fails = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { fails++; console.log("  ✗ FAIL:", m); };

const DOCS = ["pricing.html", "terms.html", "privacy.html"];
const SITE = "https://magnat-planer.ru/";
const read = f => fs.readFileSync(path.join(APP_DIR, f), "utf8");
const app = read("app.html");
const land = read("index.html");   // продающая страница — те же обещания политики
const buy = read("checkout.html"); // оформление оплаты: заказ — только на свой сервер, пока CFG.pay пуст — ничего

// seen — сюда пишется каждый пришедший запрос (путь и был ли заголовок Cookie):
// так видно и то, что ушло из service worker или при закрытии страницы (keepalive).
function serve(root, csp, seen) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
  return new Promise(res => {
    const s = http.createServer((rq, rs) => {
      if (seen) seen.push({ path: rq.url, cookie: !!rq.headers.cookie });
      let f = decodeURIComponent(rq.url.split(/[?#]/)[0]); if (f === "/") f = "/index.html";
      const p = path.join(root, path.normalize(f).replace(/^(\.\.[/\\])+/, ""));
      fs.readFile(p, (e, d) => {
        if (e) { rs.writeHead(404); rs.end(); return; }
        const h = { "Content-Type": types[path.extname(p)] || "text/plain" };
        if (csp) h["Content-Security-Policy"] = csp;
        rs.writeHead(200, h);
        rs.end(d);
      });
    }).listen(0, "127.0.0.1", () => res(s));
  });
}

// Вхождения шаблона в коде страницы — с номером строки. То, что стоит после «//»
// в начале строки или после пробела, — строчный комментарий JS, не код: фраза
// «// единственный fetch( в приложении» не должна краснеть.
function hits(src, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), out = [];
  for (const m of src.matchAll(g)) {
    const ls = src.lastIndexOf("\n", m.index) + 1;
    if (/(^|\s)\/\//.test(src.slice(ls, m.index))) continue;
    out.push({ i: m.index, at: "стр. " + src.slice(0, m.index).split("\n").length + ": " + src.slice(m.index, m.index + 60).split("\n")[0].trim() });
  }
  return out;
}

// Шпион сети для поведенческой проверки (раздел 3б): ставится до кода страницы во
// все рамки и докладывает каждую попытку уйти в сеть — даже на file://, где
// fetch('/api/…') превращается в file:///api/… и до сети не доходит. Флаг
// предпросмотра владельца ставится под обоими именами: в плане — sessionStorage
// magnat_acct_preview, в задаче выпуска — localStorage magnat_acc_preview.
function netSpy(flag) {
  const put = (kind, u) => {
    let s = ""; try { s = new URL(String((u && u.url) || u), location.href).href; } catch (e) { s = String(u); }
    try { window.__mgNet(kind, s); } catch (e) {}
  };
  try { const f = window.fetch; window.fetch = function (u) { put("fetch", u); return f.apply(this, arguments); }; } catch (e) {}
  try { const o = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u) { put("XMLHttpRequest", u); return o.apply(this, arguments); }; } catch (e) {}
  try { const b = navigator.sendBeacon; if (b) navigator.sendBeacon = function (u) { put("sendBeacon", u); return b.apply(navigator, arguments); }; } catch (e) {}
  for (const k of ["WebSocket", "EventSource"]) try { const C = window[k]; if (C) window[k] = new Proxy(C, { construct(t, a) { put(k, a[0]); return Reflect.construct(t, a); } }); } catch (e) {}
  try {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", { configurable: true,
      get() { put("cookie", location.href); return d.get.call(document); },
      set(v) { put("cookie", location.href); d.set.call(document, v); } });
  } catch (e) {}
  try { if (window.cookieStore) for (const k of ["get", "getAll", "set", "delete"]) { const f = cookieStore[k].bind(cookieStore); cookieStore[k] = function () { put("cookie", location.href); return f.apply(null, arguments); }; } } catch (e) {}
  if (flag) {
    let on = false;
    try { localStorage.setItem("magnat_acc_preview", "1"); localStorage.setItem("magnat_acct_preview", "1"); on = localStorage.getItem("magnat_acc_preview") === "1"; } catch (e) {}
    try { sessionStorage.setItem("magnat_acct_preview", "1"); sessionStorage.setItem("magnat_acc_preview", "1"); } catch (e) {}
    if (on && /app\.html$/.test(location.pathname)) try { window.__mgNet("flag", location.href); } catch (e) {}
  }
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
    const file = h.split(/[?#]/)[0];   // «Оформить» ведёт на checkout.html?plan=…
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
  // С 12.10.2026 вход по почте есть в коде app.html, но выключен (ACCOUNT_ON=false,
  // предпросмотр — только владельцу по ?account). Политика не тронута и обязана
  // быть правдой для посетителя. Поэтому код сторожится так: путей наружу, кроме
  // fetch на свой '/api/…', нет вовсе; а что посетитель в самом деле ничего не
  // шлёт — видно в браузере (раздел 3б).
  console.log("\n3. Политика говорит правду: в коде нет путей наружу, cookie и чужих скриптов");
  const EXT = String.raw`(?:https?:|wss?:)?\/\/`;   // адрес на другом сервере: https://…, //…
  const LEAKS = [
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"], [/\bsendBeacon\b/, "sendBeacon"],
    [/\bWebSocket\b/, "WebSocket"], [/\bEventSource\b/, "EventSource"],
    [/\bdocument\s*\.\s*cookie\b|\bcookieStore\b/, "cookie"], [/\bimportScripts\b/, "importScripts"],
    [new RegExp(String.raw`\bimport\s*\(\s*['"\x60]` + EXT), "import() с чужого адреса"],
    [new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*["']?` + EXT, "i"), "чужой <script src>"],
    // canonical и alternate — адрес страницы для поисковиков, браузер по ним ничего не грузит
    [new RegExp(String.raw`<link\b(?![^>]*rel="(?:canonical|alternate)")[^>]*\bhref\s*=\s*["']?` + EXT, "i"), "чужой <link href>"],
    [new RegExp(String.raw`<(?:img|iframe|video|audio|source|embed|object)\b[^>]*\b(?:src|data)\s*=\s*["']?` + EXT, "i"), "картинка или рамка с чужого адреса"],
    [new RegExp(String.raw`url\(\s*["']?` + EXT, "i"), "url() с чужого адреса в стиле"],
    [new RegExp(String.raw`<form\b[^>]*\baction\s*=\s*["']?` + EXT, "i"), "форма на чужой адрес"],
    [new RegExp(String.raw`\bformaction\s*=\s*["']?` + EXT, "i"), "formaction на чужой адрес"],
    [new RegExp(String.raw`\b(?:action|pay)\s*[:=]\s*['"\x60]` + EXT), "форма на чужой адрес (из кода)"],
    [new RegExp(String.raw`\.src\s*=\s*['"\x60]` + EXT), ".src = чужой адрес"],
  ];
  // fetch: в app.html — только вызов с адресом-литералом '/api/…' (свой сервер, тот же
  // адрес; на file:// и в рамке Claude он до сети не дойдёт), на главной — ни одного.
  // fetch без вызова (const f = fetch) — обход этой проверки.
  const fetchRule = (src, apiOk) => hits(src, /\bfetch\b/).filter(h => !(apiOk && /^fetch\s*\(\s*(['"`])\/api\/[\w\-/]*/.test(src.slice(h.i))));
  // Оформление оплаты (17.10.2026, разовая): заказ уходит только на свой сервер — каждый
  // fetch( на CFG.pay или литерал '/api/order'. Через помощника тоже можно: fetch(x) внутри
  // function имя(x, …), которая первым делом отсекает всё, кроме '/api/…', и которую зовут
  // только с CFG.pay, '/api/order' или CFG.order (если в CFG это литерал '/api/order').
  // Сам CFG.pay — пустой (оплата не подключена: ни одного запроса) или '/api/checkout'.
  const cfgOrder = /\border\s*:\s*(['"`])\/api\/order\1/.test(buy);
  const payArg = a => a === "CFG.pay" || /^(['"`])\/api\/order\1$/.test(a) || (cfgOrder && a === "CFG.order");
  const firstArg = (src, i) => (src.slice(i).match(/^[\w$.]+\s*\(\s*([^,()]+?)\s*[,)]/) || [])[1] || "";
  const payFetch = src => hits(src, /\bfetch\b/).filter(h => {
    const a = firstArg(src, h.i);
    if (payArg(a)) return false;
    if (!/^[A-Za-z_$][\w$]*$/.test(a)) return true;
    const d = [...src.slice(0, h.i).matchAll(new RegExp(String.raw`\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*` + a + String.raw`\b`, "g"))].pop();
    if (!d) return true;
    const guard = new RegExp(String.raw`\{\s*if\s*\(\s*!\s*\/\^\\\/api\\\/[^\n]*?\/\.test\(\s*` + a + String.raw`\s*\)\s*\)\s*return\b`).test(src.slice(d.index, h.i));
    const calls = hits(src, new RegExp(String.raw`\b` + d[1] + String.raw`\s*\(`)).filter(c => !/function\s+$/.test(src.slice(Math.max(0, c.i - 12), c.i)));
    return !(guard && calls.length && calls.every(c => payArg(firstArg(src, c.i))));
  });
  const payCfg = /\bpay\s*:\s*(['"`])(?:\/api\/checkout)?\1\s*,/.test(buy);
  for (const [name, src, fetches, fine] of [
    ["приложении", app, fetchRule(app, true), " (fetch — только на свой '/api/…')"],
    ["продающей странице", land, fetchRule(land, false), ", fetch нет"],
    ["оформлении оплаты", buy, payFetch(buy), " (fetch — только на CFG.pay и '/api/order', CFG.pay — пусто или '/api/checkout')"]]) {
    const found = LEAKS.flatMap(([re, what]) => hits(src, re).map(h => what + " (" + h.at + ")"))
      .concat(fetches.map(h => (src === app ? "fetch не на свой '/api/…'" : src === buy ? "fetch не на CFG.pay и не на '/api/order'" : "fetch") + " (" + h.at + ")"))
      .concat(src === buy && !payCfg ? ["CFG.pay — не пусто и не '/api/checkout'"] : []);
    found.length ? bad("в " + name + " есть путь наружу, cookie или чужой скрипт — а политика обещает обратное; сначала поправь privacy.html: " + found.slice(0, 4).join("; "))
      : ok("в " + name + " нет запросов наружу, cookie и чужих скриптов" + fine + " — как написано в политике");
  }
  // cookie нет нигде на сайте: ни в одной странице, ни в service worker
  const everywhere = fs.readdirSync(APP_DIR).filter(f => /\.(html|js)$/.test(f));
  const crumbs = everywhere.flatMap(f => hits(read(f), /\bdocument\s*\.\s*cookie\b|\bcookieStore\b/).map(h => f + " " + h.at));
  crumbs.length ? bad("сайт трогает cookie, а политика обещает, что их нет: " + crumbs.slice(0, 3).join("; "))
    : ok(`ни одна страница сайта и service worker не трогают cookie (${everywhere.length} файлов)`);
  // Политика описывает аккаунт — и обязана говорить о нём ровно то, что делает сервер
  // (план аккаунта, §9): без этих фраз текст не о нашем сервере.
  const pv = read("privacy.html");
  const MUST = [["__Host-mg", "имя служебной cookie"], ["в России", "где лежат данные"], ["Удалить аккаунт", "кнопка удаления"],
    ["остаются только на телефоне", "«Тело» не уходит на сервер"], ["30 дней", "срок прежних версий и копий"], ["90 дней", "срок закреплённой версии"],
    ["Роскомнадзор", "куда жаловаться и кого уведомлять об утечке"], ["IP-адрес", "IP только в памяти"], ["Mail.ru", "кто отправляет письма с кодом"],
    ["два года", "срок брошенного аккаунта"], ["10 рабочих дней", "срок ответа на запрос"]];
  const lost = MUST.filter(([s]) => !pv.includes(s));
  lost.length ? bad("в privacy.html нет: " + lost.map(([s, w]) => `«${s}» (${w})`).join(", "))
    : ok(`политика говорит об аккаунте всё обязательное (${MUST.length} фраз: cookie, Россия, удаление, «Тело», сроки, Роскомнадзор)`);
  const tm = read("terms.html");
  /<h2>\d+\. Аккаунт<\/h2>/.test(tm) && /кто владеет почтой, тот владеет аккаунтом/.test(tm) && /остаются только на телефоне/.test(tm)
    ? ok("соглашение: раздел «Аккаунт» — ящик = аккаунт, «Тело» не уходит на сервер") : bad("в terms.html нет раздела «Аккаунт» с правилом про ящик и «Тело»");
  // Сервер входа: журнал http.server переопределён, личное (адрес, код, токен, IP) в вывод не уходит.
  const api = read("server/api/api.py");
  const over = ["def log_message(", "def handle_error("].filter(s => !api.includes(s));
  const leak = [...api.matchAll(/^[^#\n]*\b(?:print|log(?:ging)?\.\w+|logger\.\w+|sys\.stderr\.write)\s*\([^\n]*\b(?:email|code|token|ip)\b/gm)]
    .map(m => "стр. " + api.slice(0, m.index).split("\n").length + ": " + m[0].trim().slice(0, 70));
  over.length || leak.length ? bad("api.py: " + over.map(s => "нет " + s).concat(leak.map(l => "в журнал уходит личное — " + l)).join("; "))
    : ok("api.py: журнал http.server переопределён (log_message, handle_error), print и лог не печатают email, code, token, ip");
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

  // ---- 3в. Оплата разовая (17.10.2026) ---------------------------------------
  // Платега дала мерчант без автосписаний: месяц или год разовой оплатой. Политика обязана
  // сказать, кому и что уходит, сколько хранится и что стирается при удалении аккаунта (так
  // делает forget_payments в api.py); соглашение — сам договор: разово, без автосписаний,
  // 30 и 365 дней, срок прибавляется, возврат за неиспользованные дни (ст. 32 ЗоЗПП).
  console.log("\n3в. Оплата разовая: политика и соглашение говорят о ней правду, автопродления нет нигде");
  const PAY = [["Platega", "кто проводит оплату"], ["только сумму и номер заказа", "что уходит в Platega"], ["о заказах и оплатах — 5 лет", "срок сведений об оплатах"],
    ["e-mail, Telegram и IP-адрес стираются из заказов", "отвязка заказов при удалении аккаунта"],
    ["записывается в одном случае — при оформлении оплаты", "IP пишется в заказ, а не «только в памяти»"], ["пункт 2 части 1 статьи 6", "основание для учёта оплат"]];
  const payLost = PAY.filter(([s]) => !pv.includes(s));
  payLost.length ? bad("в privacy.html об оплате нет: " + payLost.map(([s, w]) => `«${s}» (${w})`).join(", "))
    : ok(`политика об оплате: Platega получает только сумму и номер заказа, 5 лет, при удалении аккаунта почта, Telegram и IP стираются из заказов (${PAY.length} фраз)`);
  const TERMS = [["Оплата разовая", "разовая оплата"], ["автосписаний нет", "без автосписаний"], ["прибавляется к оставшемуся", "продление прибавляет к остатку"],
    ["за 30 дней", "срок месяца"], ["за 365 дней", "срок года"], ["неиспользованные полные дни", "возврат за остаток (ст. 32 ЗоЗПП)"],
    ["статья 782", "право отказаться (ГК РФ)"], ["полностью", "ошибочная или двойная оплата"]];
  const termsLost = TERMS.filter(([s]) => !tm.includes(s));
  termsLost.length ? bad("в terms.html об оплате нет: " + termsLost.map(([s, w]) => `«${s}» (${w})`).join(", "))
    : ok(`соглашение: оплата разовая, автосписаний нет, 30 и 365 дней, срок прибавляется, возврат за неиспользованные дни (${TERMS.length} фраз)`);
  // Ни одна страница сайта не обещает автопродление, автосписание, отмену подписки и ссылку
  // отмены: их нет. «Автосписаний» — только в отрицании: «без автосписаний», «автосписаний нет».
  // Комментарии кода и разметки человек не видит — их не смотрим.
  const prose = src => src.replace(/<!--[\s\S]*?-->/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const autoHits = [];
  for (const f of fs.readdirSync(APP_DIR).filter(f => /\.html$/.test(f))) {
    const t = prose(read(f));
    for (const m of t.matchAll(/автопродл[а-яё]*|автосписан[а-яё]*|отмен[а-яё]*(?:\s|&nbsp;)+подписк[а-яё]*|ссылк[а-яё]*(?:\s|&nbsp;)+(?:для(?:\s|&nbsp;)+)?отмен[а-яё]*/gi)) {
      const w = m[0].toLowerCase(), pre = t.slice(Math.max(0, m.index - 12), m.index), post = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (w === "автосписаний" && (/(?:^|[^а-яё])без(?:\s|&nbsp;)+$/i.test(pre) || /^(?:\s|&nbsp;)+нет(?![а-яё])/i.test(post))) continue;
      autoHits.push(f + ": «" + (pre.split(/[\n>]/).pop() + m[0] + post.split(/[\n<]/)[0]).trim() + "»");
    }
  }
  autoHits.length ? bad("страница обещает то, чего нет (оплата разовая, автосписаний нет): " + autoHits.slice(0, 4).join("; "))
    : ok("ни одна страница сайта не обещает автопродление, автосписание, отмену подписки или ссылку отмены — только «без автосписаний»");
  const servers = [];
  const b = await chromium.launch({ executablePath: chromePath() });
  try {
    // ---- 3б. Посетитель в браузере ---------------------------------------------
    // Страница открывается как у человека из ролика: чистый браузер, «Начать своё»,
    // отметка дня, поводы для синхронизации (online, focus, видимость), ожидание
    // отложенной отправки и уход со страницы (pagehide — там была бы keepalive-
    // отправка). Свой сервер — без CSP: запрос наружу должен быть виден, а не
    // молча зарублен. Каждый запрос на него записан — видно и то, что ушло из
    // service worker. Флаг предпросмотра владельца не включает вход на file:// и
    // в рамке Claude — там тоже ни одного запроса.
    console.log("\n3б. Посетитель в браузере: ни запроса к /api, ничего на чужие адреса, без cookie");
    const fileUrl = "file://" + path.join(APP_DIR, "app.html");
    const own = async () => { const seen = [], s = await serve(APP_DIR, null, seen); servers.push(s); return { seen, origin: `http://127.0.0.1:${s.address().port}` }; };
    const [A, L, F] = [await own(), await own(), await own()];
    // Окно Claude: страница другого адреса (свой порт — другой origin), приложение в рамке
    // с флагом. Не about:blank: у рамки внутри него хранилище закрыто, и флаг не встал бы.
    const top = await new Promise(res => { const s = http.createServer((rq, rs) => {
      rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      rs.end(`<!doctype html><title>Окно</title><iframe src="${F.origin}/app.html?account" style="width:390px;height:780px;border:0"></iframe>`);
    }).listen(0, "127.0.0.1", () => res(s)); });
    servers.push(top);
    const T = `http://127.0.0.1:${top.address().port}`;
    const runs = [
      { name: "посетитель, file://", url: fileUrl, own: ["file:"] },
      { name: "посетитель, свой сервер", url: A.origin + "/app.html", own: [A.origin], seen: A.seen },
      { name: "посетитель главной, свой сервер", url: L.origin + "/?site", own: [L.origin], seen: L.seen, landing: true },
      { name: "флаг предпросмотра (magnat_acc_preview=1, ?account), file://", url: fileUrl + "?account", own: ["file:"], flag: true },
      { name: "флаг предпросмотра, рамка Claude", url: T + "/", own: [F.origin, T], seen: F.seen, flag: true, framed: true },
    ];
    const visit = async (r) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 800 } }), net = [];
      try {
        await ctx.exposeBinding("__mgNet", (src, kind, url) => { net.push({ kind, url }); });
        await ctx.addInitScript(netSpy, !!r.flag);
        ctx.on("request", q => net.push({ kind: "запрос", url: q.url() }));
        const p = await ctx.newPage();
        let t = p;
        await p.goto(r.url);
        if (r.framed) t = await (await p.$("iframe")).contentFrame();
        await t.waitForTimeout(1500);                 // синхронизация пошла бы через 1 с после отрисовки
        if (r.landing) {
          await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(800);
        } else {
          await startClean(t);                        // «Начать своё» → три привычки → урок 1 закрыт
          await t.click("#todayChips .tchip");        // отметка дня — правка, которую было бы что отправить
          await t.evaluate(() => { dispatchEvent(new Event("online")); dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
          await t.waitForTimeout(3500);               // отправка пошла бы через 3 с после сохранения
        }
        await t.evaluate(() => fetch("data:,spy").catch(() => {}));   // шпион жив: этот вызов он обязан увидеть
        await p.goto("about:blank"); await p.waitForTimeout(400);     // уход со страницы: pagehide
        return { net, cookies: await ctx.cookies() };
      } finally { await ctx.close(); }
    };
    const done = await Promise.all(runs.map(r => visit(r).then(res => ({ r, res }), err => ({ r, err }))));
    for (const { r, res, err } of done) {
      if (err) { bad(r.name + ": визит не прошёл — " + String(err.message || err).split("\n")[0]); continue; }
      const api = new Set(), foreign = new Set(), cookie = new Set();
      for (const { kind, url } of res.net) {
        if (kind === "cookie") { cookie.add("document.cookie на " + url); continue; }
        let u; try { u = new URL(url); } catch (e) { continue; }
        if (/^(data|blob|about):$/.test(u.protocol)) continue;
        if (/^\/api(\/|$)/.test(u.pathname)) api.add(kind + " " + url);   // на file:// '/api/x' — это file:///api/x
        if (!r.own.includes(u.protocol === "file:" ? "file:" : u.origin)) foreign.add(kind + " " + url);
      }
      for (const s of r.seen || []) {
        if (/^\/api(\/|$|\?)/.test(s.path)) api.add("на сервер пришло " + s.path);
        if (s.cookie) cookie.add("запрос с заголовком Cookie: " + s.path);
      }
      for (const c of res.cookies) cookie.add("cookie " + c.name + " (" + c.domain + ")");
      const spy = res.net.some(x => x.kind === "fetch" && x.url === "data:,spy");
      const n = res.net.filter(x => x.kind === "запрос" && !/^(data|about):/.test(x.url)).length;
      const probs = [];
      if (!spy) probs.push("шпион сети не встал — проверка ничего не видит");
      if (r.flag && !res.net.some(x => x.kind === "flag")) probs.push("флаг предпросмотра не встал в хранилище приложения — проверка ничего не видит");
      if (api.size) probs.push("запросы к /api: " + [...api].slice(0, 3).join(", "));
      if (foreign.size) probs.push("запросы на чужие адреса: " + [...foreign].slice(0, 3).join(", "));
      if (cookie.size) probs.push("cookie: " + [...cookie].slice(0, 3).join(", "));
      probs.length ? bad(r.name + ": " + probs.join("; ") + " — а политика обещает обратное")
        : ok(r.name + `: ни запроса к /api, ничего на чужие адреса, без cookie (запросов страницы: ${n}` + (r.seen ? `, пришло на сервер: ${r.seen.length}` : "") + " — все свои)");
    }

    // ---- 4. Страницы в браузере --------------------------------------------------
    console.log("\n4. Страницы в браузере под CSP сервера");
    const csp = (cf.match(/Content-Security-Policy "([^"]+)"/) || [])[1];
    if (!csp) bad("CSP в server/Caddyfile не найдена");
    const srv = await serve(APP_DIR, csp || ""); servers.push(srv);
    const base = `http://127.0.0.1:${srv.address().port}/`;
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
    await b.close(); servers.forEach(s => s.close());
  }

  console.log(fails ? `\n✗ docs: ${fails} проблем` : "\ndocs: всё чисто");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("  ✗ FAIL:", e.stack || e.message); process.exit(1); });

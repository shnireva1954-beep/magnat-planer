#!/usr/bin/env node
// 13-pay: пробный период и экран оплаты в приложении (разовая оплата через Платегу, 17.10.2026) —
// против ПОДСТАВНОГО /api, как 12-sync: /api/me отдаёт sub {plan, until, active}, какой задан в
// тесте. Всё это живёт только при PAYWALL = ACCOUNT && (PAY_ON || ?pay); каждый блок краснеет без
// своей правки в app.html. С 17.10.2026 вход и оплата включены для всех (ACCOUNT_ON и PAY_ON —
// true); выключатель (оба false — прежний предпросмотр владельца) проверяется подменой строк в
// ответе сервера теста (OFF.on — блоки 1, 9 и 15):
//   1) выключатель: посетитель без меток (и с одной ?pay без ?account) — ни строки, ни экрана, ни
//      запроса, ни метки пробного периода; ?pay=false — не метка, ?pay=0 — снимает;
//  1а) включено для всех: посетитель без меток — строка пробного периода, день 4 — экран без
//      «предпросмотр» и без «Выключить предпросмотр», ?account=0&pay=0 его не снимают; без входа
//      ни одного запроса и ни одной куки;
//   2) рамка Claude и file:// с метками и кончившимся пробным периодом — ничего;
//   3) дни 1–3 — тихая строка «осталось N дня · Оформить» на «Обзоре», экрана нет, запросов нет;
//   4) день 4 — экран оплаты: заголовок, цены = PLANS в api.py, приложение под ним недоступно
//      (тап по вкладке, Tab, Escape, тап мимо), записи не тронуты, «Месяц»/«Год» ведут на
//      checkout.html?plan=…, «Скачать копию данных» — настоящий файл, анимация уважает
//      prefers-reduced-motion;
//   5) «Уже оплатил — войти по почте»: лист входа поверх экрана, почта из заказа (magnat_pay_v1),
//      код, /api/me sub.active — экран ушёл сам, на карточке «Доступ до ДД.ММ.ГГГГ»;
//   6) сервер молчит и сети нет — экран не возвращается до until; until прошёл — экран;
//   7) срок кончился — «Доступ закончился ДД.ММ.ГГГГ»; осталось ≤ 3 дней — строка «продли»;
//   8) «Выйти» — срок и почта заказа сняты, экран снова «Пробные 3 дня закончились»;
//   9) вошёл и срок кончился: «Уже оплатил» сначала спрашивает сервер (оплата пришла — экран ушёл
//      без входа; не пришла — «войди по другой почте»); с одной ?account /api/me не зовётся;
//  10) 320 px — без горизонтальной прокрутки: строка, экран, лист входа поверх экрана;
//  11) вошёл и стоит экран: на нём «Выйти» и «Удалить аккаунт», их листы — поверх экрана (ревью PAY-2);
//  12) вошёл с записями, оплаты нет: до «Войти по другой почте» — предупреждение, что записи уйдут
//      в скрытую копию, и что оплату перенесёт поддержка (PAY-1);
//  13) заказ на телефоне, входа нет: на «Обзоре» «Оплатил? Войди по почте», а не «Оформить» (PAY-3);
//  14) часы телефона спешат: сервер видит оплату — «часы спешат», а не «оплаты нет» (PAY-4);
//  15) предпросмотр: «Выключить предпросмотр» на экране снимает метку, без вопроса (SEC-4);
//  16) «Удалить аккаунт» при оплаченном доступе говорит, что срок пропадёт и как вернуть деньги (T4);
//  17) даты доступа — по Москве, как в письмах: телефон в Чите видит ту же дату (T9).
// Страница — http://127.0.0.1 (secure context), service worker выключен: /api ловит route.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, chromePath, APP_DIR, startClean } = require('./lib');

let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };
const J = (x) => JSON.stringify(x);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const dayAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
// дата по сдвигу от UTC в часах; приложение и письма сервера (dmy в api.py) — по Москве, UTC+3
const dmyAt = (sec, h) => { const d = new Date(sec * 1000 + h * 3600e3); return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear(); };
const dmy = (sec) => dmyAt(sec, 3);
const NOW = () => Math.floor(Date.now() / 1000), DAY = 86400;
const sp = (s) => String(s || '').replace(/\s+/g, ' ').trim();     // NBSP из toLocaleString — обычный пробел
const ACCT = 'a_0123456789abcdef', DEV = 'd_0123456789abcdef', RID0 = 'r_aaaaaaaaaaaaaaaa', GOOD = '482913';

// тарифы сервера — единственный источник цен (server/api/api.py, PLANS)
const PLANS = (() => {
  const src = fs.readFileSync(path.join(APP_DIR, 'server/api/api.py'), 'utf8');
  const m = src.match(/^PLANS = \{([^\n]+)\}/m), o = {};
  if (m) for (const x of m[1].matchAll(/'(\w+)': \((\d+), (\d+),/g)) o[x[1]] = { kop: +x[2], days: +x[3] };
  return o;
})();

// выключатель: OFF.on — app.html отдаётся с ACCOUNT_ON=false и PAY_ON=false (предпросмотр владельца)
const OFF = { on: false };
function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const s = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP_DIR, u === '/' ? '/app.html' : u);
    if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nope'); }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (OFF.on && u === '/app.html') {
      const t = fs.readFileSync(f, 'utf8'), o = t.replace('const ACCOUNT_ON=true,', 'const ACCOUNT_ON=false,').replace('const PAY_ON=true,', 'const PAY_ON=false,');
      return r.end(o === t ? '<!doctype html><title>нет строк ACCOUNT_ON=true и PAY_ON=true</title>' : o);
    }
    fs.createReadStream(f).pipe(r);
  });
  return new Promise(res => s.listen(0, '127.0.0.1', () => res({ s, url: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.close(r); s.closeAllConnections(); }) })));
}
// страница «окно Claude» на другом адресе: приложение в рамке
function frameServer(src) {
  const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.end(`<!doctype html><title>Окно</title><iframe src="${src}" style="width:390px;height:780px;border:0"></iframe>`); });
  return new Promise(res => s.listen(0, '127.0.0.1', () => res({ url: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.close(r); s.closeAllConnections(); }) })));
}

// модель API: вход по коду GOOD, синхронизация как в 12-sync по смыслу, /api/me с sub из subs[почта].
// down — сервер молчит (200 не-JSON: api() видит сбой, в консоли пусто)
function miniApi() {
  const st = { calls: [], accts: {}, cur: null, n: 0, subs: {}, down: false };
  const head = (a) => ({ rid: a.rid, rev: a.rev, sv: 1, at: 1760000000, label: 'Компьютер · Chrome', sum: {} });
  st.add = (mail, doc, rid = RID0, acct = ACCT) => (st.accts[mail] = { acct, rid, rev: rid ? 1 : 0, doc, seq: {} });
  st.handle = (p, b) => {
    const a = st.cur && st.accts[st.cur];
    if (p === 'code') return { ok: true, ttl: 900, resend: 60 };
    if (p === 'login') {
      if (b.code !== GOOD) return { ok: false, err: 'code', left: 4 };
      const em = String(b.email || '').trim().toLowerCase();
      const x = st.accts[em] || st.add(em, null, null, 'a_' + (0xabc000 + Object.keys(st.accts).length).toString(16).padStart(16, '0'));
      st.cur = em; return { ok: true, acct: x.acct, email: em, head: x.rid ? head(x) : null };
    }
    if (p === 'logout') { st.cur = null; return { ok: true }; }
    if (p === 'me') return a ? { ok: true, auth: true, acct: a.acct, email: st.cur, head: a.rid ? head(a) : null, sub: st.subs[st.cur] || null } : { ok: true, auth: false };
    if (!a) return { ok: false, err: 'auth' };
    if (p !== 'sync') return { ok: false, err: 'bad' };
    if (b.acct !== a.acct) return { ok: false, err: 'acct' };
    const seqMax = a.seq[b.dev] || 0;
    const pull = () => ({ ok: true, st: 'pull', head: head(a), doc: a.doc, known: false, parked: null, seqMax });
    if (b.doc == null) return !a.rid ? { ok: true, st: 'empty', seqMax } : b.base === a.rid ? { ok: true, st: 'same', head: head(a) } : pull();
    if (a.rid && b.base !== a.rid) return pull();
    a.rid = 'r_' + (++st.n).toString(16).padStart(16, '0'); a.rev++; a.doc = b.doc; a.seq[b.dev] = Math.max(seqMax, b.seq);
    return { ok: true, st: 'ok', head: head(a) };
  };
  st.paths = () => st.calls.map(c => c.path);
  return st;
}

let browser, SRV;
// quietFocus: фокус окна в headless приходит от самих действий теста (клик, ввод) и сам звал бы
// /api/me — глушим его, чтобы проверить, что срок спрашивает именно вход
// tz — часовой пояс телефона; ahead — на сколько дней спешат его часы (Date.now: им приложение
// меряет срок доступа)
async function mk({ api = null, vp = { width: 390, height: 844 }, reduced = false, quietFocus = false, tz = null, ahead = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block', acceptDownloads: true, reducedMotion: reduced ? 'reduce' : 'no-preference', ...(tz ? { timezoneId: tz } : {}) });
  if (ahead) await ctx.addInitScript((ms) => { const now = Date.now.bind(Date); Date.now = () => now() + ms; }, ahead * 864e5);
  await ctx.addInitScript((q) => {
    window.__quietFocus = q;
    addEventListener('focus', e => { if (e.target === window && window.__quietFocus) e.stopImmediatePropagation(); }, true);
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('toast');
      if (t) new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    });
  }, quietFocus);
  const reqs = [];
  ctx.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api')) reqs.push(u.pathname); });
  if (api) await ctx.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api\//, '');
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    api.calls.push({ path: p, body: b });
    if (api.down) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'down' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: J(api.handle(p, b)) });
  });
  const p = await ctx.newPage();
  Object.assign(p, { errs: [], dialogs: [] });
  p.on('pageerror', e => p.errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') p.errs.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => { p.dialogs.push(d.message()); return d.accept(); });
  return { ctx, p, reqs };
}
const errCheck = (p, label) => { if (p.errs.length) bad(`${label}: ошибки в консоли — ${p.errs.join(' | ')}`); else ok(`${label}: консоль чистая`); p.errs = []; };
const until = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);
const SETTLED = () => LOGGED() && !_sync.first && !_sync.out && !syncBusy && !ACST.pending && JSON.stringify(docOf(S)) === JSON.stringify(_sync.base);
// что видно: экран оплаты, строка на «Обзоре», карточка, хранилище пейвола
const look = (p) => p.evaluate(() => {
  const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  const j = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return 'bad'; } };
  return { wall: !!document.querySelector('#payWall'), title: t('#pwH'), note: t('#payNote'), sub: t('#acSub'),
    noteHref: (document.querySelector('#payNote a') || {}).getAttribute ? document.querySelector('#payNote a').getAttribute('href') : null,
    subHref: (document.querySelector('#acSub a') || {}).getAttribute ? document.querySelector('#acSub a').getAttribute('href') : null,
    inert: !!(document.querySelector('main') || {}).inert, trial: localStorage.getItem('magnat_trial_v1'),
    access: j('magnat_access_v1'), order: j('magnat_pay_v1'), logged: typeof LOGGED === 'function' && LOGGED() };
});
// пробный период начался n дней назад — с перезагрузкой
const trialFrom = async (p, n) => { await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(n)); await p.reload(); await p.waitForTimeout(350); };
const HB = (extra = {}) => ({ habits: [{ id: 101, ico: '', name: 'Бег', since: '' }, { id: 102, ico: '', name: 'Чтение', since: '' }], checks: { '2026-10-01': [101] }, rv: 2, lastLv: 1, ...extra });
// телефон уже вошёл: данные + _sync в хранилище, та же голова в модели API
async function seedLogged(p, api, mail, data) {
  const doc = await p.evaluate(({ data, mail, ACCT, DEV, RID0 }) => {
    const L = normalize(data), d = docOf(L);
    const sync = { v: 1, acct: ACCT, mail, dev: DEV, rid: RID0, rev: 1, hsv: 1, base: d, seq: 1, out: null, wsv: 1, reset: '', merge: false, auth: false, old: false, off: false, first: false, at: Date.now() };
    localStorage.setItem('magnat_app_v2', JSON.stringify({ ...L, _sync: sync }));
    return JSON.stringify(d);
  }, { data, mail, ACCT, DEV, RID0 });
  api.add(mail, doc); api.cur = mail;
  return doc;
}
// кнопка есть и нажимается: прокрутить к ней — в её середине она сама, а не экран или окно над ней
const onTop = (p, sel) => p.evaluate((s) => {
  const e = document.querySelector(s); if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect(), t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { txt: e.textContent.replace(/\s+/g, ' ').trim(), top: !!(t && e.contains(t)) };
}, sel);
// вошёл (seedLogged), пробный период кончился n дней назад, экран встал и срок уже спрошен
async function loggedWall(p, api, mail, data, n = 5) {
  await p.goto(SRV.url + '/app.html?account&pay'); await p.waitForTimeout(300);
  await seedLogged(p, api, mail, data);
  await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(n));
  await p.reload();
  return until(p, () => !!document.querySelector('#payWall') && !meQ && ME_AT > 0, null, 8000);
}
const wallMsg = (p) => p.evaluate(() => { const w = document.querySelector('#pwWarn');
  return { err: document.querySelector('#pwErr').textContent, warn: w && !w.hidden ? w.textContent : null, btn: document.querySelector('#pwLogin').textContent.trim(), sheet: !!document.querySelector('.accovl') }; });
// нет ли горизонтальной прокрутки и вылезающих за экран кусков
const overflow = (p) => p.evaluate(() => {
  const w = innerWidth, out = [];
  for (const e of document.querySelectorAll('#payWall *, #payNote, #payNote *, #acSub, #acSub *, .accovl *')) {
    const r = e.getBoundingClientRect(); if (r.width && (r.right > w + 0.5 || r.left < -0.5)) out.push((e.id || e.className || e.tagName) + ':' + Math.round(r.left) + '…' + Math.round(r.right));
  }
  return { sw: document.documentElement.scrollWidth, w, out: out.slice(0, 5), pw: (() => { const e = document.querySelector('#payWall'); return e ? e.scrollWidth - e.clientWidth : 0; })() };
});

(async () => {
  console.log('Пробный период и экран оплаты: против подставного /api');
  SRV = await staticServer();
  browser = await chromium.launch({ executablePath: chromePath() });
  const URL = SRV.url + '/app.html';
  const step = async (title, fn) => { console.log('\n' + title); try { await fn(); } catch (e) { bad(`${title}: упал — ${(e.stack || e).toString().split('\n').slice(0, 3).join(' / ')}`); } };
  try {
    await step('0) Цены экрана берутся не с потолка: в api.py есть PLANS месяца и года', async () => {
      (PLANS.month && PLANS.year) ? ok(`PLANS: месяц ${PLANS.month.kop / 100} ₽ за ${PLANS.month.days} дней, год ${PLANS.year.kop / 100} ₽ за ${PLANS.year.days} дней`)
        : bad('PLANS в server/api/api.py не разобран: ' + J(PLANS));
    });

    await step('1) Выключатель (ACCOUNT_ON и PAY_ON — false): посетитель без меток — ни строки, ни экрана, ни запроса, даже с кончившимся пробным периодом', async () => {
      OFF.on = true;
      try {
      const api = miniApi();
      const { ctx, p, reqs } = await mk({ api });
      await p.goto(URL); await p.waitForTimeout(300);
      await startClean(p);
      const fresh = await look(p);
      // чужие следы в хранилище: пробный период кончился, срок, заказ — посетителю всё равно ничего
      await p.evaluate((d) => { localStorage.setItem('magnat_trial_v1', d); localStorage.setItem('magnat_pay_v1', JSON.stringify({ o: 'x', email: 'buyer@example.ru', plan: 'month', at: Date.now() })); }, dayAgo(10));
      await p.reload(); await p.waitForTimeout(1600);                 // /api/me пошёл бы через секунду
      const old = await look(p);
      const flags = await p.evaluate(() => ({ PAYWALL, ACCOUNT }));
      (!fresh.wall && !fresh.note && fresh.trial === null) ? ok('чистый посетитель: строки и экрана нет, метка пробного периода не поставлена')
        : bad('посетитель: ' + J(fresh));
      (!old.wall && !old.note && !flags.PAYWALL && !flags.ACCOUNT && !old.inert) ? ok('пробный период «кончился» в хранилище — у посетителя ровно прежнее приложение')
        : bad('посетитель со старой меткой: ' + J({ old, flags }));
      // одна ?pay без ?account: метка встаёт (для владельца), но без входа пейвола нет
      await p.goto(URL + '?pay=false'); await p.waitForTimeout(250);
      const f1 = await p.evaluate(() => localStorage.getItem('magnat_pay_preview'));
      await p.goto(URL + '?pay'); await p.waitForTimeout(1600);
      const f2 = await p.evaluate(() => ({ mark: localStorage.getItem('magnat_pay_preview'), q: location.search, PAYWALL }));
      const pv = await look(p);
      await p.goto(URL + '?pay=0'); await p.waitForTimeout(250);
      const f3 = await p.evaluate(() => localStorage.getItem('magnat_pay_preview'));
      (f1 === null && f2.mark === '1' && !/pay/.test(f2.q) && f3 === null) ? ok('?pay=false — не метка, ?pay — метка (адрес очищен), ?pay=0 — снимает')
        : bad('метка ?pay: ' + J({ f1, f2, f3 }));
      (!f2.PAYWALL && !pv.wall && !pv.note) ? ok('одна ?pay без ?account — ни строки, ни экрана') : bad('?pay без входа: ' + J({ f2, pv }));
      (!reqs.length && !api.calls.length) ? ok('ни одного запроса к /api за все заходы') : bad('запросы к /api: ' + J(reqs));
      errCheck(p, 'посетитель');
      await ctx.close();
      } finally { OFF.on = false; }
    });

    await step('1а) Включено для всех (17.10.2026): посетитель без меток — пробный период и экран оплаты; без входа ни запроса, ни куки', async () => {
      const api = miniApi();
      const { ctx, p, reqs } = await mk({ api });
      await p.goto(URL); await p.waitForTimeout(300);
      await startClean(p);
      const d1 = await look(p), fl = await p.evaluate(() => ({ ACCOUNT_ON, PAY_ON, ACCOUNT, PAYWALL, acc: localStorage.getItem('magnat_acc_preview'), pay: localStorage.getItem('magnat_pay_preview') }));
      (fl.ACCOUNT_ON && fl.PAY_ON && fl.ACCOUNT && fl.PAYWALL && fl.acc === null && fl.pay === null) ? ok('ACCOUNT_ON и PAY_ON включены: вход и пейвол у посетителя без меток предпросмотра')
        : bad('флаги включения: ' + J(fl));
      (d1.trial === dayAgo(0) && /^Пробный период: осталось 3 дня · Оформить$/.test(d1.note) && d1.noteHref === 'checkout.html' && !d1.wall)
        ? ok(`день 1: «${d1.note}» → ${d1.noteHref}`) : bad('посетитель, день 1: ' + J(d1));
      await trialFrom(p, 3);
      const d4 = await look(p), pwOff = await p.evaluate(() => !!document.querySelector('#pwOff'));
      (d4.wall && d4.inert && d4.title === 'Пробные 3 дня закончились' && !pwOff)
        ? ok(`день 4: экран «${d4.title}» — без метки «предпросмотр» и без «Выключить предпросмотр»`) : bad('посетитель, день 4: ' + J({ d4, pwOff }));
      await p.goto(URL + '?account=0&pay=0'); await p.waitForTimeout(500);
      const d5 = await look(p);
      (d5.wall && d5.inert) ? ok('?account=0&pay=0 из чужой ссылки экран не снимают') : bad('?account=0&pay=0: ' + J(d5));
      const ck = await ctx.cookies();
      (!reqs.length && !api.calls.length && !ck.length) ? ok('без входа — ни одного запроса к /api и ни одной куки') : bad('посетитель без входа: ' + J({ reqs, ck: ck.length }));
      errCheck(p, 'включено для всех');
      await ctx.close();
    });

    await step('2) Рамка Claude и file:// с метками ?account и ?pay, пробный период кончился — ничего', async () => {
      // file://
      const { ctx, p, reqs } = await mk();
      const fileUrl = 'file://' + path.join(APP_DIR, 'app.html');
      await p.goto(fileUrl); await p.waitForTimeout(250);
      await p.evaluate((d) => { localStorage.setItem('magnat_trial_v1', d); localStorage.setItem('magnat_acc_preview', '1'); localStorage.setItem('magnat_pay_preview', '1'); }, dayAgo(10));
      await p.goto(fileUrl + '?account&pay'); await p.waitForTimeout(1600);
      const f = await look(p), ff = await p.evaluate(() => ({ PAYWALL, ACCOUNT }));
      (!f.wall && !f.note && !ff.PAYWALL && !ff.ACCOUNT) ? ok('file:// — ни экрана, ни строки') : bad('file://: ' + J({ f, ff }));
      errCheck(p, 'file://');
      // рамка: флаги и кончившийся пробный период — в хранилище адреса приложения
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(250);
      await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(10));
      const F = await frameServer(URL + '?account&pay');
      reqs.length = 0;
      await p.goto(F.url); await p.waitForTimeout(300);
      const fr = await (await p.$('iframe')).contentFrame();
      await fr.waitForTimeout(1600);
      const v = await fr.evaluate(() => ({ framed: FRAMED, PAYWALL, wall: !!document.querySelector('#payWall'), note: !!document.querySelector('#payNote'), inert: !!document.querySelector('main').inert }));
      (v.framed && !v.PAYWALL && !v.wall && !v.note && !v.inert) ? ok('рамка Claude — ни экрана, ни строки') : bad('рамка: ' + J(v));
      (!reqs.length) ? ok('в рамке и на file:// — ни одного запроса к /api') : bad('запросы: ' + J(reqs));
      errCheck(p, 'рамка');
      await F.close(); await ctx.close();
    });

    await step('3) Дни 1–3: тихая строка «Пробный период: осталось N дня · Оформить», экрана нет', async () => {
      const api = miniApi();
      const { ctx, p, reqs } = await mk({ api });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p);
      const d1 = await look(p);
      await trialFrom(p, 1); const d2 = await look(p);
      await trialFrom(p, 2); await p.waitForTimeout(1300); const d3 = await look(p);
      (d1.trial === dayAgo(0) && /^Пробный период: осталось 3 дня · Оформить$/.test(d1.note) && d1.noteHref === 'checkout.html' && !d1.wall)
        ? ok(`день 1: метка — сегодня, «${d1.note}» → ${d1.noteHref}`) : bad('день 1: ' + J(d1));
      (/осталось 2 дня/.test(d2.note) && !d2.wall) ? ok(`день 2: «${d2.note}»`) : bad('день 2: ' + J(d2));
      (/остался 1 день/.test(d3.note) && !d3.wall && !d3.inert) ? ok(`день 3: «${d3.note}», экрана нет`) : bad('день 3: ' + J(d3));
      (!reqs.length) ? ok('без входа — ни одного запроса к /api') : bad('запросы без входа: ' + J(reqs));
      errCheck(p, 'пробные дни');
      await ctx.close();
    });

    await step('4) День 4: экран оплаты поверх приложения — оно недоступно, записи целы, тарифы ведут на оформление', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p);
      const before = await p.evaluate(() => localStorage.getItem('magnat_app_v2'));
      await trialFrom(p, 3);
      const v = await look(p);
      (v.wall && /^Пробные 3 дня закончились/.test(v.title) && !/предпросмотр/.test(v.title) && v.inert) ? ok(`экран: «${v.title}», приложение под ним inert`) : bad('день 4: ' + J(v));
      // тап по вкладке «Привычки» — попадает в экран, вкладка не переключается
      const tab = await p.$eval('.tab[data-t="habits"]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const hit = await p.evaluate(({ x, y }) => !!document.elementFromPoint(x, y).closest('#payWall'), tab);
      await p.mouse.click(tab.x, tab.y); await p.waitForTimeout(300);
      // Tab по кругу: фокус не уходит в приложение под экраном
      const where = [];
      for (let i = 0; i < 16; i++) { await p.keyboard.press('Tab'); where.push(await p.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.closest('#payWall') ? 'wall' : (a.id || a.className || a.tagName); })); }
      await p.keyboard.press('Escape'); await p.mouse.click(5, 5); await p.waitForTimeout(200);
      const after = await p.evaluate(() => ({ cur, wall: !!document.querySelector('#payWall'), store: localStorage.getItem('magnat_app_v2') }));
      (hit && after.cur === 'home') ? ok('тап по вкладке «Привычки» попал в экран — вкладка не переключилась') : bad('вкладка под экраном: ' + J({ hit, cur: after.cur }));
      (where.every(w => w === 'wall' || w === 'body') && where.includes('wall')) ? ok('Tab ходит только по экрану оплаты') : bad('фокус ушёл под экран: ' + J(where));
      (after.wall) ? ok('Escape и тап мимо экран не закрывают') : bad('экран закрылся');
      (after.store === before) ? ok('запись magnat_app_v2 не изменилась — ни когда экран встал, ни под ним') : bad('записи под экраном изменились');
      // цены — как PLANS в api.py
      const plans = await p.evaluate(() => ['month', 'year'].map(k => { const a = document.querySelector('#pw_' + k); return a ? { href: a.getAttribute('href'), txt: a.textContent } : null; }));
      const rub = (k) => (PLANS[k].kop / 100).toLocaleString('ru-RU');
      const pr = ['month', 'year'].map((k, i) => plans[i] && sp(plans[i].txt).includes(sp(rub(k)) + ' ₽ за ' + PLANS[k].days + ' ' + (PLANS[k].days % 10 === 1 && PLANS[k].days % 100 !== 11 ? 'день' : 'дней')));
      (pr.every(Boolean)) ? ok(`тарифы как в api.py: «${sp(plans[0].txt)}», «${sp(plans[1].txt)}»`) : bad('цены экрана ≠ PLANS: ' + J({ plans, PLANS }));
      (plans[0] && plans[0].href === 'checkout.html?plan=month' && plans[1] && plans[1].href === 'checkout.html?plan=year') ? ok('«Месяц» → checkout.html?plan=month, «Год» → checkout.html?plan=year')
        : bad('ссылки тарифов: ' + J(plans));
      const legal = await p.evaluate(() => [...document.querySelectorAll('#payWall .legal a')].map(a => a.textContent));
      (legal.length === 4) ? ok('ссылки на документы: ' + legal.join(', ')) : bad('документы на экране: ' + J(legal));
      // «Скачать копию данных» — существующая копия, настоящим файлом
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('#pwSave')]);
      const file = await dl.path(), copy = JSON.parse(fs.readFileSync(file, 'utf8'));
      const sHabits = await p.evaluate(() => S.habits.length);
      (/^magnat-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()) && copy.habits.length === sHabits) ? ok(`«Скачать копию данных» — файл ${dl.suggestedFilename()}, привычек ${copy.habits.length}`)
        : bad('копия с экрана оплаты: ' + J({ name: dl.suggestedFilename(), n: copy.habits && copy.habits.length }));
      // «Год» — переход на оформление
      await Promise.all([p.waitForURL(/\/checkout\.html\?plan=year$/, { timeout: 5000 }), p.click('#pw_year')]);
      ok('нажал «Год» — открылось ' + new globalThis.URL(p.url()).pathname + new globalThis.URL(p.url()).search);
      errCheck(p, 'экран оплаты');
      await ctx.close();
      // prefers-reduced-motion: экран появляется без анимации
      const r = await mk({ api: miniApi(), reduced: true });
      await r.p.goto(URL + '?account&pay'); await r.p.waitForTimeout(300); await startClean(r.p); await trialFrom(r.p, 3);
      const an = await r.p.evaluate(() => { const w = document.querySelector('#payWall'); return w ? [getComputedStyle(w).animationName, getComputedStyle(w.firstElementChild).animationName] : null; });
      (an && an.every(x => x === 'none')) ? ok('prefers-reduced-motion — экран без анимации') : bad('анимация при reduce: ' + J(an));
      errCheck(r.p, 'reduce');
      await r.ctx.close();
    });

    await step('5) «Уже оплатил — войти по почте»: вход поверх экрана с почтой заказа, sub.active — экран ушёл сам', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p);
      await p.evaluate(() => localStorage.setItem('magnat_pay_v1', JSON.stringify({ o: 'AAAAAAAAAAAAAAAAAAAAAA', email: 'buyer@example.ru', plan: 'year', at: Date.now() })));
      await trialFrom(p, 3);
      await p.waitForTimeout(1200);              // проверка срока при открытии уже прошла — без входа она молчит
      const until1 = NOW() + 365 * DAY;
      api.subs['buyer@example.ru'] = { plan: 'year', until: until1, active: true };
      await p.click('#pwLogin'); await p.waitForSelector('#acMail', { timeout: 5000 });
      const pre = await p.inputValue('#acMail');
      const top = await p.evaluate(() => { const b = document.querySelector('#acGo').getBoundingClientRect(); return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2).closest('.accovl'); });
      (pre === 'buyer@example.ru') ? ok('в поле входа — почта из заказа (magnat_pay_v1)') : bad('почта в поле входа: «' + pre + '»');
      (top) ? ok('лист входа — поверх экрана оплаты') : bad('лист входа под экраном');
      await p.click('#acGo'); await p.waitForSelector('#acCode', { timeout: 5000 });
      await p.fill('#acCode', GOOD);
      const gone = await until(p, () => !document.querySelector('#payWall') && !document.querySelector('.accovl'), null, 8000);
      await until(p, SETTLED, null, 8000);
      const v = await look(p);
      (gone && !v.inert && v.logged && v.sub === `Доступ до ${dmy(until1)} · Продлить` && v.subHref === 'checkout.html?plan=year')
        ? ok(`экран ушёл сам, на карточке «${v.sub}» → ${v.subHref}`) : bad('после входа: ' + J({ gone, v }));
      (v.access && v.access.email === 'buyer@example.ru' && v.access.until === until1 && v.access.plan === 'year' && !v.note)
        ? ok('срок на телефоне: magnat_access_v1 = почта, until, тариф; строки «пробный период» больше нет') : bad('кэш доступа: ' + J(v.access));
      (api.paths().includes('me')) ? ok('срок спрошен у сервера (/api/me)') : bad('/api/me не звали: ' + J(api.paths()));
      const toasts = await p.evaluate(() => window.__toasts.slice());
      toasts.some(t => /Доступ открыт до/.test(t)) ? ok('сказано «Доступ открыт до …»') : bad('тосты: ' + J(toasts));
      errCheck(p, 'вход с экрана оплаты');

      await step('6) Сервер молчит и сети нет — экран не возвращается до until; until прошёл — экран', async () => {
        api.down = true;
        await p.reload(); await p.waitForTimeout(1600);
        const d = await look(p), me = api.paths().filter(x => x === 'me').length;
        (!d.wall && d.sub && d.sub.startsWith('Доступ до ' + dmy(until1)) && me >= 2) ? ok('сервер не ответил на /api/me — доступ по сроку на телефоне, экрана нет') : bad('сервер молчит: ' + J({ d, me }));
        api.down = false;
        await ctx.setOffline(true);
        const n0 = api.calls.length;
        await p.evaluate(() => { window.__quietFocus = false; dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); payPaint(); render(); });
        await p.waitForTimeout(500);
        const o = await look(p);
        (!o.wall && api.calls.length === n0) ? ok('без сети — экрана нет, запросов нет') : bad('без сети: ' + J({ o, calls: api.calls.slice(n0) }));
        // срок прошёл, пока сети нет (то же, что раз в минуту делает таймер)
        await p.evaluate(() => { const a = JSON.parse(localStorage.getItem('magnat_access_v1')); a.until = Math.floor(Date.now() / 1000) - 60; localStorage.setItem('magnat_access_v1', JSON.stringify(a)); payPaint(); });
        const o2 = await look(p);
        (o2.wall && o2.title.startsWith('Доступ закончился ' + dmy(NOW() - 60))) ? ok(`срок прошёл без сети — «${o2.title.replace(/ предпросмотр$/, '')}»`) : bad('until прошёл без сети: ' + J(o2));
        await ctx.setOffline(false);
        errCheck(p, 'без сети');
      });

      await step('7) Срок кончился — «Доступ закончился ДД.ММ.ГГГГ»; осталось ≤ 3 дней — строка «продли»', async () => {
        const gone2 = NOW() - 2 * DAY;
        api.subs['buyer@example.ru'] = { plan: 'year', until: gone2, active: false };
        await p.reload();
        const w = await until(p, (t) => { const h = document.querySelector('#pwH'); return !!h && h.textContent.includes(t); }, 'Доступ закончился ' + dmy(gone2), 6000);
        const e = await look(p);
        (w && e.title.startsWith('Доступ закончился ' + dmy(gone2)) && e.inert) ? ok(`сервер: срок вышел — «${e.title.replace(/ предпросмотр$/, '')}»`) : bad('срок кончился: ' + J(e));
        const soon = NOW() + 2 * DAY + 3600;
        api.subs['buyer@example.ru'] = { plan: 'month', until: soon, active: true };
        await p.reload();
        const okSoon = await until(p, () => !document.querySelector('#payWall') && !!document.querySelector('#payNote.warn'), null, 6000);
        const s = await look(p);
        (okSoon && s.note === `Доступ до ${dmy(soon).slice(0, 5)} — продли` && s.noteHref === 'checkout.html?plan=month' && s.sub === `Доступ до ${dmy(soon)} · Продлить`)
          ? ok(`осталось меньше 3 дней: «${s.note}» → ${s.noteHref}, на карточке «${s.sub}»`) : bad('скоро конец: ' + J({ okSoon, s }));
        errCheck(p, 'срок');
      });

      await step('8) «Выйти» — срок и почта заказа сняты, экран снова «Пробные 3 дня закончились»', async () => {
        await until(p, SETTLED, null, 8000);
        p.dialogs = [];
        await p.click('#acOut');
        await until(p, () => !LOGGED(), null, 6000);
        const g = await look(p);
        (!g.logged && g.access === null && g.order === null && p.dialogs.length === 1) ? ok('после «Выйти»: magnat_access_v1 и magnat_pay_v1 сняты') : bad('после выхода: ' + J({ g, dialogs: p.dialogs }));
        (g.wall && /^Пробные 3 дня закончились/.test(g.title)) ? ok(`экран снова: «${g.title.replace(/ предпросмотр$/, '')}»`) : bad('экран после выхода: ' + J(g));
        await p.click('#pwLogin'); await p.waitForSelector('#acMail', { timeout: 5000 });
        const pre = await p.inputValue('#acMail');
        (pre === '') ? ok('вход после «Выйти» — поле почты пустое') : bad('после выхода в поле: «' + pre + '»');
        errCheck(p, 'выход');
      });
      await ctx.close();
    });

    await step('9) Вошёл, срок кончился: «Уже оплатил» сначала спрашивает сервер; с одной ?account /api/me не зовётся', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      OFF.on = true;              // «только ?account» — это выключатель: при включённой оплате пейвол у всех
      await p.goto(URL + '?account'); await p.waitForTimeout(300);
      await seedLogged(p, api, 'box@example.ru', HB());
      await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(5));
      await p.reload(); await until(p, SETTLED, null, 8000); await p.waitForTimeout(1300);
      const acc = await look(p);
      OFF.on = false;
      (!api.paths().includes('me') && !acc.wall && !acc.note) ? ok('выключатель, только ?account: /api/me не звали, ни строки, ни экрана') : bad('?account без ?pay: ' + J({ paths: api.paths(), acc }));
      await p.goto(URL + '?pay'); await until(p, () => !!document.querySelector('#payWall'), null, 5000);
      await until(p, () => !meQ && ME_AT > 0, null, 5000);
      const w = await look(p);
      (w.wall && /^Пробные 3 дня закончились/.test(w.title) && w.access === null) ? ok('вошёл, не платил — экран оплаты') : bad('вошёл без оплаты: ' + J(w));
      // не пришла оплата — подсказка и вход по другой почте
      await p.click('#pwLogin');
      await until(p, () => /оплаты пока нет/.test(document.querySelector('#pwErr').textContent), null, 5000);
      const t = await p.evaluate(() => ({ err: document.querySelector('#pwErr').textContent, btn: document.querySelector('#pwLogin').textContent.trim(), sheet: !!document.querySelector('.accovl') }));
      (!t.sheet && /box@example\.ru/.test(t.err) && t.btn === 'Войти по другой почте') ? ok(`«${t.err}», кнопка — «${t.btn}»`) : bad('оплаты нет: ' + J(t));
      await p.click('#pwLogin'); await p.waitForSelector('#acMail', { timeout: 5000 });
      const pre = await p.inputValue('#acMail');
      (pre === '') ? ok('вход по другой почте — своя почта в поле не подставлена') : bad('в поле: «' + pre + '»');
      await p.click('#acNo');
      // оплата пришла, пока экран открыт, — «Уже оплатил» убирает его без входа
      await p.reload(); await until(p, () => !!document.querySelector('#payWall') && !meQ && ME_AT > 0, null, 5000);
      const u = NOW() + 30 * DAY;
      api.subs['box@example.ru'] = { plan: 'month', until: u, active: true };
      const logins = api.paths().filter(x => x === 'login').length;
      await p.click('#pwLogin');
      const gone = await until(p, () => !document.querySelector('#payWall'), null, 5000);
      const v = await look(p);
      (gone && !v.inert && v.sub === `Доступ до ${dmy(u)} · Продлить` && api.paths().filter(x => x === 'login').length === logins && !(await p.$('.accovl')))
        ? ok(`оплата пришла — экран ушёл без входа, на карточке «${v.sub}»`) : bad('после оплаты: ' + J({ gone, v }));
      errCheck(p, 'вошёл и срок кончился');
      await ctx.close();
    });

    await step('10) 320 px: строка, экран оплаты и лист входа поверх него — без горизонтальной прокрутки', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, vp: { width: 320, height: 568 } });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p);
      const a = await overflow(p), n = await look(p);
      (n.note && a.sw <= 320 && !a.out.length) ? ok('строка пробного периода на 320 px — в экране') : bad('строка на 320: ' + J({ a, note: n.note }));
      await trialFrom(p, 4);
      const b = await overflow(p);
      (b.sw <= 320 && !b.out.length && b.pw <= 0) ? ok('экран оплаты на 320 px — без прокрутки вбок') : bad('экран на 320: ' + J(b));
      const vis = await p.evaluate(() => ['#pw_month', '#pw_year', '#pwLogin', '#pwSave'].every(s => { const e = document.querySelector(s); const r = e && e.getBoundingClientRect(); return r && r.width > 0 && r.right <= innerWidth; }));
      vis ? ok('тарифы, «Уже оплатил» и «Скачать копию» видны целиком') : bad('кнопки экрана не влезли');
      await p.click('#pwLogin'); await p.waitForSelector('#acMail', { timeout: 5000 });
      const c = await overflow(p);
      (c.sw <= 320 && !c.out.length) ? ok('лист входа поверх экрана на 320 px — в экране') : bad('лист входа на 320: ' + J(c));
      errCheck(p, '320 px');
      await ctx.close();
    });

    await step('11) Вошёл, стоит экран оплаты: «Выйти» и «Удалить аккаунт» на нём, их листы — поверх экрана', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true });
      const w = await loggedWall(p, api, 'box@example.ru', HB());
      const o = await onTop(p, '#pwOut'), d = await onTop(p, '#pwDel');
      (w && o && o.top && o.txt === 'Выйти' && d && d.top && d.txt === 'Удалить аккаунт') ? ok('на экране оплаты — «Выйти» и «Удалить аккаунт», нажимаются')
        : bad('кнопки аккаунта на экране: ' + J({ w, o, d }));
      await p.click('#pwDel'); await p.waitForSelector('.accovl #acDlGo', { timeout: 5000 });
      const s = await onTop(p, '.accovl #acDlGo'), h = await p.evaluate(() => document.querySelector('.accovl #acH').textContent.trim());
      (s && s.top && /Удалить аккаунт\?/.test(h) && (await look(p)).wall) ? ok(`«Удалить аккаунт» — лист «${h}» поверх экрана оплаты, «${s.txt}» нажимается`) : bad('лист удаления: ' + J({ s, h }));
      await p.click('.accovl #acNo');
      // «Выйти» — тот же выход, что на карточке: вопрос, после — кнопок аккаунта нет, «войти по
      // другой почте» сброшено, экран снова «Пробные 3 дня закончились»
      await p.click('#pwLogin'); await until(p, () => /оплаты пока нет/.test(document.querySelector('#pwErr').textContent), null, 5000);
      await until(p, SETTLED, null, 8000);
      p.dialogs = [];
      await p.click('#pwOut');
      await until(p, () => !LOGGED(), null, 6000);
      const g = await look(p), m = await wallMsg(p), left = await p.evaluate(() => ['#pwOut', '#pwDel'].filter(x => document.querySelector(x)));
      (!g.logged && p.dialogs.length === 1 && g.wall && /^Пробные 3 дня закончились/.test(g.title) && !left.length && m.btn === 'Уже оплатил — войти по почте' && !m.err && !m.warn)
        ? ok('«Выйти» с экрана: вышел после вопроса, кнопок аккаунта нет, «Уже оплатил — войти по почте» снова на месте')
        : bad('выход с экрана: ' + J({ g, m, left, dialogs: p.dialogs }));
      // не вошёл — кнопок аккаунта на экране нет (как и было до входа)
      await p.reload(); await p.waitForSelector('#payWall', { timeout: 5000 });
      const none = await p.evaluate(() => ['#pwOut', '#pwDel'].filter(x => document.querySelector(x)));
      (!none.length) ? ok('без входа — ни «Выйти», ни «Удалить аккаунт» на экране') : bad('без входа на экране: ' + J(none));
      errCheck(p, 'кнопки аккаунта на экране');
      await ctx.close();
    });

    await step('12) Вошёл с записями, оплаты на этой почте нет: до входа по другой почте — про скрытую копию и поддержку', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true });
      await loggedWall(p, api, 'box@example.ru', HB());
      const m0 = await wallMsg(p);
      await p.click('#pwLogin'); await until(p, () => /оплаты пока нет/.test(document.querySelector('#pwErr').textContent), null, 5000);
      const m = await wallMsg(p);
      (!m0.warn && m.btn === 'Войти по другой почте' && m.warn && /^Вход по другой почте уберёт записи с этого телефона в скрытую копию — они вернутся, когда снова войдёшь по box@example\.ru\. Перенести оплату на эту почту может поддержка$/.test(m.warn))
        ? ok(`до «${m.btn}» — «${m.warn}»`) : bad('предупреждение про записи: ' + J({ m0, m }));
      errCheck(p, 'записи и другая почта');
      await ctx.close();
      // записей нет (пустой лист) — убирать нечего, предупреждения нет
      const api2 = miniApi();
      const b = await mk({ api: api2, quietFocus: true });
      await loggedWall(b.p, api2, 'empty@example.ru', { habits: [{ id: 101, ico: '', name: 'Бег', since: '' }], checks: {}, rv: 2, lastLv: 1 });
      await b.p.click('#pwLogin'); await until(b.p, () => /оплаты пока нет/.test(document.querySelector('#pwErr').textContent), null, 5000);
      const e = await wallMsg(b.p);
      (e.btn === 'Войти по другой почте' && !e.warn) ? ok('записей нет — «Войти по другой почте» без предупреждения') : bad('пустой лист: ' + J(e));
      errCheck(b.p, 'пустой лист');
      await b.ctx.close();
    });

    await step('13) Заказ на телефоне, входа нет: на «Обзоре» «Оплатил? Войди по почте — доступ включится», а не «Оформить»', async () => {
      const api = miniApi();
      const { ctx, p, reqs } = await mk({ api });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p);
      await p.evaluate(() => localStorage.setItem('magnat_pay_v1', JSON.stringify({ o: 'AAAAAAAAAAAAAAAAAAAAAA', email: 'buyer@example.ru', plan: 'year', at: Date.now() })));
      await p.reload(); await p.waitForTimeout(350);
      const v = await look(p);
      (v.note === 'Оплатил? Войди по почте — доступ включится' && !v.wall && v.noteHref === null) ? ok(`строка: «${v.note}» — без «Оформить»`) : bad('строка с заказом без входа: ' + J(v));
      await p.click('#payNoteIn'); await p.waitForSelector('#acMail', { timeout: 5000 });
      const pre = await p.inputValue('#acMail');
      (pre === 'buyer@example.ru') ? ok('«Войди по почте» — лист входа с почтой заказа') : bad('почта в листе: «' + pre + '»');
      await p.click('#acNo');
      (!reqs.length) ? ok('до входа — ни одного запроса к /api') : bad('запросы: ' + J(reqs));
      errCheck(p, 'заказ без входа');
      await ctx.close();
    });

    await step('14) Часы телефона спешат на 10 дней: сервер видит оплату — «часы спешат», а не «оплаты нет»', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true, ahead: 10 });
      const u = NOW() + 5 * DAY;
      api.subs['box@example.ru'] = { plan: 'month', until: u, active: true };
      const w = await loggedWall(p, api, 'box@example.ru', HB(), 20);
      const v = await look(p);
      await p.click('#pwLogin'); await until(p, () => !!document.querySelector('#pwErr').textContent, null, 5000);
      const m = await wallMsg(p);
      (w && v.access && v.access.until === u && m.err === `Оплата есть до ${dmy(u)}, но часы на телефоне спешат — проверь дату и время` && m.btn === 'Уже оплатил — войти по почте' && !m.warn && !m.sheet)
        ? ok(`«${m.err}», кнопка осталась «${m.btn}»`) : bad('часы спешат: ' + J({ w, access: v.access, m }));
      errCheck(p, 'часы спешат');
      await ctx.close();
    });

    await step('15) Выключатель, предпросмотр: «Выключить предпросмотр» на экране — метка снята, приложение прежнее, без вопроса', async () => {
      OFF.on = true;
      try {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await startClean(p); await trialFrom(p, 3);
      const b = await onTop(p, '#pwOff');
      (b && b.top && b.txt === 'Выключить предпросмотр') ? ok('на экране предпросмотра — «Выключить предпросмотр»') : bad('кнопка предпросмотра: ' + J(b));
      p.dialogs = [];
      await Promise.all([p.waitForEvent('load', { timeout: 5000 }), p.click('#pwOff')]); await p.waitForTimeout(400);
      const v = await look(p), f = await p.evaluate(() => ({ mark: localStorage.getItem('magnat_pay_preview'), PAYWALL, ACCOUNT }));
      (f.mark === null && !f.PAYWALL && f.ACCOUNT && !v.wall && !v.note && !v.inert && !p.dialogs.length)
        ? ok('метка magnat_pay_preview снята, страница перезагружена — ни экрана, ни строки, вопроса не было') : bad('после «Выключить предпросмотр»: ' + J({ f, v, dialogs: p.dialogs }));
      errCheck(p, 'выключить предпросмотр');
      await ctx.close();
      } finally { OFF.on = false; }
    });

    await step('16) «Удалить аккаунт» при оплаченном доступе: срок пропадёт, деньги за остаток — через поддержку', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true });
      const u = NOW() + 20 * DAY;
      api.subs['box@example.ru'] = { plan: 'month', until: u, active: true };
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await seedLogged(p, api, 'box@example.ru', HB());
      await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(5));
      await p.reload(); await until(p, () => !!document.querySelector('#acSub') && !document.querySelector('#payWall'), null, 8000);
      await p.click('#acDel'); await p.waitForSelector('.accovl #acDlGo', { timeout: 5000 });
      const t = sp(await p.evaluate(() => document.querySelector('.accovl').textContent));
      const need = `Оплаченный доступ до ${dmy(u)} пропадёт вместе с аккаунтом. Вернуть деньги за остаток — напиши в поддержку и назови номер заказа из письма об оплате.`;
      (t.includes(need)) ? ok(`оплачено — в окне удаления: «${need}»`) : bad('окно удаления при оплате: ' + t);
      await p.click('.accovl #acNo');
      // оплаты нет — этой строки нет (окно — с экрана оплаты)
      api.subs['box@example.ru'] = null;
      await p.reload(); await until(p, () => !!document.querySelector('#payWall') && !meQ && ME_AT > 0, null, 8000);
      await p.click('#pwDel'); await p.waitForSelector('.accovl #acDlGo', { timeout: 5000 });
      const t2 = sp(await p.evaluate(() => document.querySelector('.accovl').textContent));
      (!/Оплаченный доступ/.test(t2) && /Удалить аккаунт\?/.test(t2)) ? ok('не оплачено — окно удаления без строки про доступ') : bad('окно удаления без оплаты: ' + t2);
      errCheck(p, 'удаление при оплате');
      await ctx.close();
    });

    await step('17) Даты доступа — по Москве, как в письмах: телефон в Чите (UTC+9) видит дату письма', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api, quietFocus: true, tz: 'Asia/Chita' });
      // 22:30 по Москве — в Чите уже 04:30 следующего дня
      const msk0 = Math.floor((NOW() + 3 * 3600) / DAY) * DAY - 3 * 3600;
      const u = msk0 + 40 * DAY + 22.5 * 3600, gone = msk0 - 2 * DAY + 22.5 * 3600;
      (dmyAt(u, 9) !== dmy(u)) ? ok(`проверка с толком: в письме ${dmy(u)}, по часам Читы ${dmyAt(u, 9)}`) : bad('даты Москвы и Читы совпали — проверка пустая');
      api.subs['box@example.ru'] = { plan: 'year', until: u, active: true };
      await p.goto(URL + '?account&pay'); await p.waitForTimeout(300);
      await seedLogged(p, api, 'box@example.ru', HB());
      await p.evaluate((d) => localStorage.setItem('magnat_trial_v1', d), dayAgo(5));
      await p.reload(); await until(p, () => !!document.querySelector('#acSub'), null, 8000);
      const v = await look(p);
      (v.sub === `Доступ до ${dmy(u)} · Продлить`) ? ok(`на карточке «${v.sub}» — как в письме`) : bad('дата на карточке: ' + J(v.sub));
      api.subs['box@example.ru'] = { plan: 'year', until: gone, active: false };
      await p.reload();
      const w = await until(p, (t) => { const h = document.querySelector('#pwH'); return !!h && h.textContent.includes(t); }, 'Доступ закончился ' + dmy(gone), 6000);
      const e = await look(p);
      (w) ? ok(`экран: «${e.title.replace(/ предпросмотр$/, '')}» — по Москве`) : bad('дата на экране: ' + J(e.title));
      errCheck(p, 'даты по Москве');
      await ctx.close();
    });
  } finally {
    try { await browser.close(); } catch (e) {}
    await SRV.close();
  }
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

#!/usr/bin/env node
// 12-sync: синхронизация в приложении на краях — против ПОДСТАВНОГО /api (ревью R2, 12.10.2026).
// 09-account гоняет настоящий api.py; здесь сервер — маленькая модель в тесте (route), чтобы
// точно подать ответ, который трудно получить живьём: «записи сильно разошлись» на каждый
// запрос, голова ровно «телефон + ещё», нет сети при выходе. Каждый блок — одно замечание
// ревью, и каждый краснеет без своей правки в app.html:
//   1) ?account включает предпросмотр только явно (?account или ?account=1), не «=false»;
//   2) фоновая отправка (уход со страницы) не подменяет данные под открытым окном правки;
//   3) окно «Записи сильно разошлись» одно, а не по копии на каждую синхронизацию;
//   4) первый вход, где телефон — часть аккаунта: дальше обычные правки, а не «join»;
//   5) вход в другой аккаунт на телефоне с чужими записями: записи первого — в скрытую копию на
//      телефоне, в новый аккаунт не уходят, почту первого целиком не показываем; вернулся в
//      первый — записи вернулись (R2-дополнение 12.10, вечер);
//   6) «Выйти» без сети: выход на сервере доходит, когда сеть появится;
//   7) кошелёк в минусе после двух устройств: настоящий «−», красным, «Купить» выключена;
//   8) «Восстановить из копии» при входе спрашивает про аккаунт и все телефоны;
//   9) «Версии»: список с сервера, «Вернуть» — подтверждение, отправка restore, метки;
//  10) «Устройства»: список входов, «Выйти» на одном, «Выйти на всех других»;
//  11) удаление аккаунта: два шага, код с целью delete без адреса в теле, неверный код понятен,
//      после удаления — записи на телефоне, аккаунта и запросов нет;
//  12–15) ревью листов (12.10, вечер): вторая вкладка с открытым окном правки не уносит записи
//      прежнего аккаунта в новый; копия не записалась (нет места) — вход отменён, записи целы;
//      лист удаления закрыли во время запроса — «ok» всё равно прибирает аккаунт; «Вернуть
//      версию» во время медленной отправки уходит как restore, прежняя голова закреплена.
// Страница — http://127.0.0.1 (secure context), service worker выключен: /api ловит route.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, chromePath, APP_DIR, startClean } = require('./lib');

let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };
const J = (x) => JSON.stringify(x);
const ACCT = 'a_0123456789abcdef', DEV = 'd_0123456789abcdef', RID0 = 'r_aaaaaaaaaaaaaaaa';
const hex16 = (n) => n.toString(16).padStart(16, '0');
const TODAY_YMD = (d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'))(new Date());

// статика из корня репозитория. С 17.10.2026 вход и оплата включены для всех (ACCOUNT_ON и PAY_ON —
// true); OFF.on — app.html отдаётся с обоими false: выключатель, разбор меток предпросмотра (блок 1)
const OFF = { on: false };
function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp' };
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
  return new Promise(res => s.listen(0, '127.0.0.1', () => res({ url: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.close(r); s.closeAllConnections(); }) })));
}

// модель API: вход по любому коду, CAS по голове, pull/same/empty — как api.py по смыслу;
// ревизии с датой, причиной и сводкой (/api/versions, /api/version), сессии (/api/sessions,
// /api/logout {sid|all}), удаление (код с целью delete по сессии, /api/delete — код «482913»).
// over(path, body) — подменить ответ в блоке (вернуть объект) или пропустить (undefined)
const AT0 = 1760000000, LABEL = 'Компьютер · Chrome', GOOD = '482913';
const sumOf = (doc) => { try { const d = JSON.parse(doc); return { h: d.habits.length, d: Object.keys(d.checks).length, t: d.tasks.length, f: d.finance.entries.length }; } catch (e) { return {}; } };
function miniApi() {
  const st = { calls: [], accts: {}, cur: null, n: 0, over: null, sessions: null, deleted: [] };
  // revs — известные серверу rid (для known), vers — версии с блобом (для /api/versions)
  const ver = (a) => (a.rid && a.vers.get(a.rid)) || { at: AT0, sum: {} };
  const head = (a) => ({ rid: a.rid, rev: a.rev, sv: 1, at: ver(a).at, label: LABEL, sum: ver(a).sum });
  st.add = (mail, doc, rid = RID0, acct = ACCT) => (st.accts[mail] = { acct, rid, rev: rid ? 1 : 0, doc, seq: {}, revs: new Set(rid ? [rid] : []),
    vers: new Map(rid ? [[rid, { rid, rev: 1, at: AT0, kind: 'push', reason: 'first', label: LABEL, sum: sumOf(doc), doc, pin: null }]] : []) });
  st.handle = (p, b) => {
    const o = st.over && st.over(p, b); if (o) return o;
    const a = st.cur && st.accts[st.cur];
    if (p === 'code') return b.purpose === 'delete' ? (a ? { ok: true, ttl: 900, resend: 60 } : { ok: false, err: 'auth' }) : { ok: true, ttl: 900, resend: 60 };
    if (p === 'login') {
      const em = String(b.email || '').trim().toLowerCase();
      const x = st.accts[em] || st.add(em, null, null, 'a_' + hex16(0xabc000 + Object.keys(st.accts).length));
      st.cur = em; return { ok: true, acct: x.acct, email: em };
    }
    if (p === 'logout') {
      if (b.all) { if (st.sessions) st.sessions = st.sessions.filter(s => s.me); return { ok: true }; }
      if (b.sid) { if (st.sessions) st.sessions = st.sessions.filter(s => s.sid !== b.sid); return { ok: true }; }
      st.cur = null; return { ok: true };
    }
    if (p === 'me') return a ? { ok: true, auth: true, acct: a.acct, email: st.cur } : { ok: true, auth: false };
    if (!a) return { ok: false, err: 'auth' };
    if (p === 'versions') return { ok: true, list: [...a.vers.values()].reverse().map(({ doc, ...v }) => v) };
    if (p === 'version') { const v = a.vers.get(b.rid); return v ? { ok: true, rid: v.rid, at: v.at, doc: v.doc } : { ok: false, err: 'gone' }; }
    if (p === 'sessions') return { ok: true, list: st.sessions || [{ sid: 's_aaaaaaaaaaaa', label: LABEL, seen: TODAY_YMD, me: true }] };
    if (p === 'delete') { if (b.code !== GOOD) return { ok: false, err: 'code', left: 4 }; st.deleted.push(st.cur); delete st.accts[st.cur]; st.cur = null; return { ok: true }; }
    if (p !== 'sync') return { ok: false, err: 'bad' };
    if (b.acct !== a.acct) return { ok: false, err: 'acct' };
    const seqMax = a.seq[b.dev] || 0;
    const pull = () => ({ ok: true, st: 'pull', head: head(a), doc: a.doc, known: !!b.base && a.revs.has(b.base), parked: null, seqMax });
    if (b.doc == null) return !a.rid ? { ok: true, st: 'empty', seqMax } : b.base === a.rid ? { ok: true, st: 'same', head: head(a) } : pull();
    if (a.rid && b.base !== a.rid) return pull();
    const prev = a.rid && a.vers.get(a.rid);
    a.rid = 'r_' + hex16(++st.n); a.rev++; a.doc = b.doc; a.revs.add(a.rid); a.seq[b.dev] = Math.max(seqMax, b.seq);
    a.vers.set(a.rid, { rid: a.rid, rev: a.rev, at: AT0 + a.rev * 3600, kind: 'push', reason: b.reason, label: LABEL, sum: sumOf(b.doc), doc: b.doc, pin: null });
    if (prev && /^(reset|restore|join)$/.test(b.reason)) prev.pin = AT0 + 90 * 86400;   // прежняя голова закреплена на 90 дней
    return { ok: true, st: 'ok', head: head(a) };
  };
  st.syncs = () => st.calls.filter(c => c.path === 'sync');
  st.pushes = () => st.calls.filter(c => c.path === 'sync' && typeof c.body.doc === 'string');
  return st;
}

let browser, SRV;
async function mk({ api = null, vp = { width: 390, height: 844 } } = {}) {
  const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('toast');
      if (t) new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    });
  });
  const reqs = [];
  ctx.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api')) reqs.push(r.url()); });
  if (api) await ctx.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api\//, '');
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    api.calls.push({ path: p, body: b });
    const res = J(api.handle(p, b)), d = api.delayFor ? api.delayFor(p, b) : 0;   // ответ считается сразу, отдаётся с задержкой
    if (d) await new Promise(r => setTimeout(r, d));
    return route.fulfill({ status: 200, contentType: 'application/json', body: res });
  });
  const p = await ctx.newPage();
  Object.assign(p, { errs: [], dialogs: [], answer: true });
  p.on('pageerror', e => p.errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') p.errs.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => { p.dialogs.push(d.message()); return p.answer ? d.accept() : d.dismiss(); });
  return { ctx, p, reqs };
}
const errCheck = (p, label) => { if (p.errs.length) bad(`${label}: ошибки в консоли — ${p.errs.join(' | ')}`); else ok(`${label}: консоль чистая`); p.errs = []; };
const until = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);
const SETTLED = () => LOGGED() && !_sync.first && !_sync.out && !syncBusy && !ACST.pending && JSON.stringify(docOf(S)) === JSON.stringify(_sync.base);

// телефон уже вошёл: данные + _sync в хранилище, та же голова в модели API
async function seedLogged(p, api, mail, data) {
  const doc = await p.evaluate(({ data, mail, ACCT, DEV, RID0 }) => {
    const L = data ? normalize(data) : S, d = docOf(L);
    const sync = { v: 1, acct: ACCT, mail, dev: DEV, rid: RID0, rev: 1, hsv: 1, base: d, seq: 1, out: null, wsv: 1, reset: '', merge: false, auth: false, old: false, off: false, first: false, at: Date.now() };
    localStorage.setItem('magnat_app_v2', JSON.stringify({ ...L, _sync: sync }));
    return JSON.stringify(d);
  }, { data, mail, ACCT, DEV, RID0 });
  api.add(mail, doc); api.cur = mail;
  await p.reload(); await p.waitForTimeout(300);
  return doc;
}
// вход через интерфейс: почта → код (любой — модель пускает)
async function uiLogin(p, mail, from = '#acLogin') {
  await p.click(from); await p.waitForSelector('#acMail', { timeout: 5000 });
  const pre = await p.inputValue('#acMail');
  await p.fill('#acMail', mail); await p.click('#acGo');
  await p.waitForSelector('#acCode', { timeout: 5000 });
  await p.fill('#acCode', '482913');
  return pre;
}
const HB = (extra = {}) => ({ habits: [{ id: 101, ico: '', name: 'Бег', since: '' }, { id: 102, ico: '', name: 'Чтение', since: '' }], checks: { '2026-10-01': [101] }, rv: 2, lastLv: 1, ...extra });

(async () => {
  console.log('Синхронизация в приложении: края против подставного /api');
  SRV = await staticServer();
  browser = await chromium.launch({ executablePath: chromePath() });
  const URL = SRV.url + '/app.html';
  const step = async (title, fn) => { console.log('\n' + title); try { await fn(); } catch (e) { bad(`${title}: упал — ${(e.stack || e).toString().split('\n').slice(0, 3).join(' / ')}`); } };
  try {
    await step('1) Выключатель (ACCOUNT_ON=false): предпросмотр включается только явно — ?account и ?account=1 да, ?account=false нет, ?account=0 снимает', async () => {
      OFF.on = true;
      try {
      const api = miniApi();
      const { ctx, p, reqs } = await mk({ api });
      const look = async (q) => { await p.goto(URL + q); await p.waitForTimeout(250);
        return p.evaluate(() => ({ on: ACCOUNT, flag: localStorage.getItem('magnat_acc_preview'), q: location.search })); };
      const f1 = await look('?account=false'), f2 = await look('?account=yes'), f3 = await look('?account=1');
      await startClean(p);
      const card = await p.evaluate(() => { const c = document.querySelector('#acc'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : ''; });
      const f4 = await look('?account=0'), f5 = await look('?account');
      (!f1.on && f1.flag === null && !f2.on && f2.flag === null) ? ok('?account=false и ?account=yes — метки нет, аккаунта нет')
        : bad('случайное значение включило предпросмотр: ' + J({ f1, f2 }));
      (f3.on && f3.flag === '1' && !/account/.test(f3.q) && /Предпросмотр/i.test(card)) ? ok(`?account=1 — метка, адрес очищен, на карточке видно «предпросмотр»: «${card.slice(0, 40)}…»`)
        : bad('?account=1: ' + J({ f3, card }));
      (!f4.on && f4.flag === null && f5.on && f5.flag === '1') ? ok('?account=0 снимает метку, голое ?account ставит снова') : bad('?account=0 / ?account: ' + J({ f4, f5 }));
      (!reqs.length) ? ok('ни одного запроса к /api за все заходы') : bad('запросы к /api: ' + J(reqs));
      errCheck(p, 'метка предпросмотра');
      await ctx.close();
      } finally { OFF.on = false; }
    });

    await step('2) Ушёл со страницы при открытом окне правки — данные под окном не подменяются, «Сохранить» не теряется', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      // своя правка ждёт отправки, открыто окно правки привычки «Бег»
      await p.evaluate(() => { S.tasks.push({ id: uid(), name: 'Задача A', prio: 'md', due: TODAY, done: false }); save(); editHabit(101); });
      // другая вкладка записала свою отметку (хранилище уже не то, что видела эта вкладка)
      await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('magnat_app_v2')); d.checks[TODAY] = [102]; localStorage.setItem('magnat_app_v2', JSON.stringify(d)); });
      const pushes0 = api.pushes().length;
      await p.evaluate(() => { sync({ keep: true }); });                       // то, что зовёт visibilitychange→hidden
      await p.waitForTimeout(700);
      const mid = await p.evaluate(() => ({ mem: (S.checks[TODAY] || []).join(), modal: !!document.querySelector('#hSv') }));
      const pushesMid = api.pushes().length - pushes0;
      await p.evaluate(() => { document.querySelector('.modal input').value = 'Бег 5 км'; document.querySelector('#hSv').click(); });
      await p.waitForTimeout(300);
      const after = await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('magnat_app_v2'));
        return { names: d.habits.map(h => h.name).join(), today: (d.checks[TODAY] || []).join(), task: d.tasks.some(t => t.name === 'Задача A') }; });
      (mid.modal && mid.mem === '' && pushesMid === 0) ? ok('пока окно открыто: данные в памяти прежние, фоновая отправка ничего не отправила')
        : bad('под открытым окном: ' + J({ mid, pushesMid }));
      (after.names === 'Бег 5 км,Чтение' && after.today === '102' && after.task) ? ok('«Сохранить» в окне: переименование на месте, отметка другой вкладки и своя задача — тоже')
        : bad('после «Сохранить»: ' + J(after));
      const synced = await until(p, SETTLED, null, 12000);
      const hd = JSON.parse(api.accts['box@example.ru'].doc);
      (synced && hd.habits[0].name === 'Бег 5 км' && (hd.checks[await p.evaluate(() => TODAY)] || []).includes(102) && hd.tasks.some(t => t.name === 'Задача A'))
        ? ok('окно закрыто — синхронизация отправила всё вместе') : bad('после окна в аккаунте: ' + J({ synced, habits: hd.habits.map(h => h.name), tasks: hd.tasks.map(t => t.name) }));
      errCheck(p, 'фоновая отправка и окно');
      await ctx.close();
    });

    await step('3) «Записи на двух устройствах сильно разошлись» — одно окно, пока оно открыто, синхронизация молчит', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      // база — 20 дней, на телефоне остались 1–10, в аккаунте 11–20: слияние без потерь не выходит
      const H = await p.evaluate(({ ACCT, DEV, RID0 }) => {
        const days = n => { const o = {}; for (let i = 1; i <= n; i++) o['2026-09-' + String(i).padStart(2, '0')] = [101]; return o; };
        const B = normalize({ habits: [{ id: 101, ico: '', name: 'Бег', since: '' }, { id: 102, ico: '', name: 'Чтение', since: '' }], checks: days(20), rv: 2, lastLv: 50 });
        const base = docOf(B), L = JSON.parse(JSON.stringify(B)), Hd = docOf(B);
        for (let i = 11; i <= 20; i++) delete L.checks['2026-09-' + i];
        for (let i = 1; i <= 10; i++) delete Hd.checks['2026-09-' + String(i).padStart(2, '0')];
        const sync = { v: 1, acct: ACCT, mail: 'box@example.ru', dev: DEV, rid: RID0, rev: 1, hsv: 1, base, seq: 1, out: null, wsv: 1, reset: '', merge: false, auth: false, old: false, off: false, first: false, at: Date.now() };
        localStorage.setItem('magnat_app_v2', JSON.stringify({ ...L, _sync: sync }));
        return JSON.stringify(Hd);
      }, { ACCT, DEV, RID0 });
      api.add('box@example.ru', H, 'r_bbbbbbbbbbbbbbbb'); api.accts['box@example.ru'].revs.add(RID0); api.cur = 'box@example.ru';
      await p.reload();
      const one = await until(p, () => document.querySelectorAll('.accovl').length === 1);
      const n0 = api.syncs().length;
      await p.evaluate(() => { sync(); }); await p.waitForTimeout(600);
      await p.evaluate(() => { sync(); }); await p.waitForTimeout(600);
      await p.evaluate(() => { S.tasks.push({ id: uid(), name: 'Правка при окне', prio: 'md', due: TODAY, done: false }); save(); }); await p.waitForTimeout(2600);
      const v = await p.evaluate(() => ({ n: document.querySelectorAll('.accovl').length, h: [...document.querySelectorAll('.accovl h4')].map(x => x.textContent.trim()) }));
      const more = api.syncs().length - n0;
      (one && v.n === 1 && /сильно разошлись/.test(v.h[0] || '')) ? ok('окно выбора одно, хоть синхронизацию звали ещё трижды') : bad('окон выбора: ' + J(v));
      more === 0 ? ok('пока выбор открыт — ни одной отправки на сервер') : bad(`пока выбор открыт, ушло ${more} запросов sync`);
      await p.click('#chAcc'); await p.waitForTimeout(400);
      const c = await p.evaluate(() => ({ n: document.querySelectorAll('.accovl').length, days: Object.keys(S.checks).sort() }));
      (c.n === 0 && c.days.length === 10 && c.days[0] === '2026-09-11') ? ok('«Взять из аккаунта» — записи аккаунта (дни 11–20), окно закрыто') : bad('после выбора: ' + J(c));
      errCheck(p, 'выбор стороны');
      await ctx.close();
    });

    await step('4) Первый вход: телефон — часть аккаунта → итог = аккаунт, следующая правка уходит обычной, не «join»', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      const H = await p.evaluate(() => {
        const L = normalize({ habits: [{ id: 101, ico: '', name: 'Бег', since: '' }], checks: { '2026-10-01': [101] }, rv: 2, lastLv: 1,
          tasks: [{ id: 5, name: 'A', prio: 'md', due: '2026-10-01', done: true }] });
        const Hd = docOf(L); Hd.checks['2026-10-02'] = [101]; Hd.tasks.push({ id: 6, name: 'B', prio: 'md', due: '2026-10-02', done: false });
        localStorage.setItem('magnat_app_v2', JSON.stringify(L));
        return JSON.stringify(Hd);
      });
      api.add('box@example.ru', H, 'r_hhhhhhhhhhhhhhhh'); api.cur = null;
      await p.reload(); await p.waitForTimeout(300);
      await uiLogin(p, 'box@example.ru');
      const set = await until(p, SETTLED);
      const s1 = await p.evaluate(() => ({ reset: _sync.reset, same: JSON.stringify(docOf(S)) === JSON.stringify(_sync.base), toasts: window.__toasts.slice() }));
      await p.evaluate(() => { S.tasks.push({ id: uid(), name: 'C', prio: 'md', due: TODAY, done: false }); save(); });
      await until(p, SETTLED, null, 12000);
      const push = api.pushes().pop();
      (set && s1.same && s1.reset === '') ? ok('после входа: записи = аккаунт, служебный «join» не остался висеть') : bad('после входа: ' + J({ set, s1 }));
      (push && push.body.reason === 'edit') ? ok('следующая правка ушла как обычная (reason=edit) — сервер не закрепит голову зря и не посчитает «join»')
        : bad('следующая правка: ' + J(api.calls.map(c => c.path + ':' + (c.body.doc ? 'push:' + c.body.reason : 'pull'))));
      errCheck(p, 'первый вход, телефон — часть аккаунта');
      await ctx.close();
    });

    await step('5) Вход в другой аккаунт на телефоне с записями первого: записи — в скрытую копию, в новый не уходят; вернулся — вернулись', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250); await startClean(p);
      await p.click('#todayChips .tchip'); await p.waitForTimeout(200);
      await p.evaluate(() => { S.body.log.push({ date: TODAY, w: 81.5 }); save(); });    // «Тело» — только телефон, должно вернуться
      await uiLogin(p, 'anna@example.ru');
      await until(p, SETTLED);
      await p.click('#acOut'); await until(p, () => !LOGGED());
      await p.waitForTimeout(300);
      const before = await p.evaluate(() => JSON.stringify(docOf(S)));
      const annaAcct = api.accts['anna@example.ru'].acct;
      const n0 = api.calls.length; p.dialogs = [];
      const pre = await uiLogin(p, 'boris@example.ru');
      await until(p, () => LOGGED() && !_sync.first && !syncBusy && !!document.querySelector('#startOwn'), null, 8000);
      await p.waitForTimeout(500);
      const v = await p.evaluate(() => { const st = JSON.parse(localStorage.getItem('magnat_stash_v1') || '{}'), k = Object.keys(st);
        return { logged: LOGGED(), acct: _sync && _sync.acct, demo: !!S.demoData, doc: JSON.stringify(docOf(S)), own: !!document.querySelector('#startOwn'),
          keys: k, mail: k.length === 1 && st[k[0]].mail, stashDoc: k.length === 1 && JSON.stringify(docOf(st[k[0]].s)), stashBody: k.length === 1 && st[k[0]].s.body.log.length,
          toasts: window.__toasts.slice(), st: ((document.querySelector('#acSt') || {}).textContent || '').trim(), err: (document.querySelector('#acErr') || {}).textContent || '' }; });
      const after = api.calls.slice(n0).map(c => c.path + (c.body.doc ? ':push' : ''));
      const shown = v.toasts.join(' ') + ' ' + p.dialogs.join(' ') + ' ' + v.err;
      pre === '' ? ok('после «Выйти» почта прежнего аккаунта в поле входа не подставлена') : bad('в поле входа подставлено: ' + pre);
      const borisAcct = api.accts['boris@example.ru'].acct;
      (v.logged && v.acct === borisAcct && v.demo && v.own && v.doc !== before && /Это пример/.test(v.st))
        ? ok('вошёл в boris: на телефоне пример и «Начать своё», записи anna на экране не остались') : bad('после входа в boris: ' + J({ logged: v.logged, acct: v.acct, demo: v.demo, own: v.own, st: v.st }));
      (v.keys.length === 1 && v.keys[0] === annaAcct && v.mail === 'anna@example.ru' && v.stashDoc === before && v.stashBody === 1)
        ? ok('записи anna (с «Телом») лежат в скрытой копии под её аккаунтом') : bad('скрытая копия: ' + J({ keys: v.keys, mail: v.mail, same: v.stashDoc === before, body: v.stashBody }));
      (v.toasts.some(t => /скрытую копию/.test(t) && /a•••@example\.ru/.test(t)) && !/anna@/.test(shown))
        ? ok('сказано словами, адрес anna — только намёком') : bad('подсказка: ' + J({ toasts: v.toasts, shown }));
      const bDoc = api.accts['boris@example.ru'].doc;
      (!bDoc && !after.includes('sync:push') && !after.includes('logout'))
        ? ok('в аккаунт boris не ушло ничего, выхода из него не было: ' + after.join(',')) : bad('запросы после входа: ' + J({ after, bDoc: !!bDoc }));
      // обратно в anna: boris (пример) не прячем, записи anna возвращаются, на сервер ничего нового
      p.dialogs = []; const pushes0 = api.pushes().length;
      await p.click('#acOut'); await until(p, () => !LOGGED()); await p.waitForTimeout(300);
      await uiLogin(p, 'anna@example.ru');
      const set = await until(p, SETTLED, null, 12000);
      const r = await p.evaluate(() => ({ acct: _sync.acct, doc: JSON.stringify(docOf(S)), body: S.body.log.length, demo: !!S.demoData,
        stash: localStorage.getItem('magnat_stash_v1'), toasts: window.__toasts.slice(), rid: _sync.rid }));
      (set && r.acct === annaAcct && r.doc === before && r.body === 1 && !r.demo && r.stash === null && api.pushes().length === pushes0 && api.accts['anna@example.ru'].doc === before)
        ? ok('снова anna: записи и «Тело» вернулись из копии, копия убрана, отправок не понадобилось (same)') : bad('возврат в anna: ' + J({ set, acct: r.acct === annaAcct, same: r.doc === before, body: r.body, demo: r.demo, stash: r.stash, pushes: [pushes0, api.pushes().length] }));
      r.toasts.some(t => /вернулись из скрытой копии/.test(t)) ? ok('сказано «вернулись из скрытой копии»') : bad('тосты: ' + J(r.toasts));
      errCheck(p, 'смена аккаунта');
      await ctx.close();
    });

    await step('6) «Выйти» без сети: на телефоне вышел сразу, а выход на сервере уходит, как только сеть появилась', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      await p.evaluate(() => { const c = [...document.querySelectorAll('.tab')].find(t => t.dataset.t === 'home'); if (c) c.click(); });
      await ctx.setOffline(true);
      await p.click('#acOut'); await until(p, () => !LOGGED());
      await p.waitForTimeout(400);
      const off = await p.evaluate(() => ({ flag: localStorage.getItem('magnat_logout_v1'), toast: window.__toasts.slice(-1)[0] }));
      const lo0 = api.calls.filter(c => c.path === 'logout').length;
      await ctx.setOffline(false);
      const sent = await until(p, () => localStorage.getItem('magnat_logout_v1') === null, null, 6000);
      const lo = api.calls.filter(c => c.path === 'logout').length;
      (off.flag === '1' && lo0 === 0 && /вышел/.test(off.toast || '')) ? ok('без сети: «Ты вышел из аккаунта», запроса не было, выход на сервере запомнен')
        : bad('выход без сети: ' + J({ off, lo0 }));
      (sent && lo === 1 && !api.cur) ? ok('сеть появилась — /api/logout ушёл один раз, сессия на сервере снята') : bad('после сети: ' + J({ sent, lo, cur: api.cur }));
      const n1 = api.calls.length;
      await p.evaluate(() => { dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); await p.waitForTimeout(1500);
      api.calls.length === n1 ? ok('дальше — ни одного запроса') : bad('после выхода ещё запросы: ' + J(api.calls.slice(n1).map(c => c.path)));
      errCheck(p, 'выход без сети');
      await ctx.close();
    });

    await step('7) Кошелёк в минусе после двух устройств: «−300» красным, «Купить» выключена с пояснением', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      await p.evaluate(() => { S.spent = wallet() + 300; save(); render(); });
      await p.waitForTimeout(300);
      const chip = await p.evaluate(() => { const w = document.getElementById('wallet'), c = document.getElementById('coinChip');
        return { t: w.textContent, color: getComputedStyle(w).color, danger: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() }; });
      await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(300);
      const shop = await p.evaluate(() => ({ t: document.getElementById('shopW').textContent, color: getComputedStyle(document.getElementById('shopW')).color,
        note: (document.querySelector('.negnote') || {}).textContent || '', off: document.querySelectorAll('.si .buy.off').length, cards: document.querySelectorAll('.si').length, spent: S.spent }));
      p.dialogs = [];
      await p.click('.si >> nth=0'); await p.waitForTimeout(300);
      const tap = await p.evaluate(() => ({ toast: window.__toasts.slice(-1)[0] || '', spent: S.spent }));
      const red = 'rgb(255, 107, 107)';
      (chip.t === '−300' && chip.color === red) ? ok('в шапке «−300» (настоящий минус) красным') : bad('шапка: ' + J(chip));
      (shop.t === '−300' && shop.color === red && /на двух устройствах сразу/.test(shop.note) && shop.off === shop.cards && shop.cards > 0)
        ? ok(`в «Наградах» «−300» красным, «${shop.note.trim()}», «Купить» выключена у всех ${shop.cards}`) : bad('магазин: ' + J(shop));
      (!p.dialogs.length && tap.spent === shop.spent && /заработай/.test(tap.toast)) ? ok(`нажатие на награду — без покупки: «${tap.toast}»`) : bad('нажатие в минусе: ' + J({ tap, dialogs: p.dialogs }));
      errCheck(p, 'минус в кошельке');
      await ctx.close();
      // посетитель без аккаунта: кошелёк как сегодня (минус возможен — снял отметки после покупки)
      const v = await mk();
      await v.p.goto(URL); await v.p.waitForTimeout(250); await startClean(v.p);
      await v.p.evaluate(() => { S.spent = wallet() + 300; save(); render(); }); await v.p.waitForTimeout(300);
      const vt = await v.p.evaluate(() => ({ t: document.getElementById('wallet').textContent, note: !!document.querySelector('.negnote') }));
      (vt.t === '-300' && !vt.note) ? ok('посетитель без входа видит кошелёк ровно как раньше') : bad('посетитель: ' + J(vt));
      await v.ctx.close();
    });

    await step('8) «Восстановить из копии» при входе: вопрос про аккаунт и все телефоны', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      p.answer = false; p.dialogs = [];
      const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }), p.click('#bkLoad')]);
      await fc.setFiles({ name: 'magnat.json', mimeType: 'application/json', buffer: Buffer.from(J(HB({ checks: {} }))) });
      await p.waitForTimeout(500);
      const q = p.dialogs[0] || '';
      q === 'Заменить записи — в аккаунте и на всех телефонах — данными из копии?' ? ok(`вопрос: «${q}»`) : bad('вопрос при восстановлении: ' + J(p.dialogs));
      const kept = await p.evaluate(() => Object.keys(S.checks).length);
      kept === 1 ? ok('«Отмена» — записи не тронуты') : bad('после отмены: дней с отметками ' + kept);
      errCheck(p, 'восстановление при входе');
      await ctx.close();
    });

    // как SETTLED, но на нужной ревизии — функция уходит в страницу, узлу её константы не видны
    const settledRev = (n) => LOGGED() && !_sync.first && !_sync.out && !syncBusy && !ACST.pending && JSON.stringify(docOf(S)) === JSON.stringify(_sync.base) && _sync.rev === n;
    const YESTERDAY = (d => { d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(new Date());
    const rows = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map(r => ({ t: r.innerText.replace(/\s+/g, ' ').trim(), btn: !!r.querySelector('button.linkbtn'), now: !!r.querySelector('.vernow') })), sel);
    await step('9) «Версии»: список с сервера (новые первыми, нынешняя — «сейчас»), «Вернуть» — вопрос, записи как тогда, отправка restore, прежняя закреплена', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      const doc0 = await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      // правка без монет и уровня (иначе окно «Новый уровень» перекрыло бы карточку): переименование
      await p.evaluate(() => { S.habits[0].name = 'Бег утром'; save(); });
      if (!await until(p, settledRev, 2, 12000)) throw new Error('правка не ушла на сервер');
      const rid1 = api.accts['box@example.ru'].rid;
      await p.click('#acVer'); await p.waitForSelector('.verrow', { timeout: 5000 });
      const l = await rows(p, '.verrow');
      const head = await p.evaluate(() => (document.querySelector('.accovl h4') || {}).textContent || '');
      (l.length === 2 && l[0].now && !l[0].btn && l[1].btn && !l[1].now && /2 привычки · 1 день с отметками/.test(l[1].t) && /Компьютер · Chrome/.test(l[0].t) && /^\d+ окт, \d\d:\d\d/.test(l[1].t.replace(/^Сегодня, |^Вчера, /, '10 окт, ')) && /Версии записей/.test(head))
        ? ok(`две версии, новая — «сейчас»: «${l[1].t}»`) : bad('список версий: ' + J({ l, head }));
      p.dialogs = []; const n0 = api.calls.length;
      await p.click('.verrow button.linkbtn');
      const closed = await until(p, () => !document.querySelector('.accovl'), null, 5000);
      const set = await until(p, settledRev, 3, 12000);
      const r = await p.evaluate(() => ({ doc: JSON.stringify(docOf(S)), name: S.habits[0].name, toast: window.__toasts.slice(-1)[0] || '', reset: _sync.reset }));
      const push = api.pushes().pop();
      (p.dialogs.length === 1 && /^Вернуть записи к версии от .+\? Нынешние останутся в списке\.$/.test(p.dialogs[0]))
        ? ok(`вопрос: «${p.dialogs[0]}»`) : bad('вопрос при возврате: ' + J(p.dialogs));
      (closed && set && r.doc === doc0 && r.name === 'Бег' && push && push.body.reason === 'restore' && r.reset === '' && /возвращены к версии/.test(r.toast)
        && api.calls.slice(n0).some(c => c.path === 'version' && c.body.rid === RID0))
        ? ok('записи стали как в первой версии, ушли как restore, тост «возвращены»') : bad('возврат: ' + J({ closed, set, same: r.doc === doc0, name: r.name, reason: push && push.body.reason, reset: r.reset, toast: r.toast }));
      const pinned = api.accts['box@example.ru'].vers.get(rid1).pin;
      await p.click('#acVer'); await p.waitForSelector('.verrow', { timeout: 5000 });
      const l2 = await rows(p, '.verrow');
      (pinned && l2.length === 3 && l2[0].now && /до возврата/.test(l2[1].t) && !/до возврата/.test(l2[2].t))
        ? ok('снова список: три версии, прежняя голова помечена «до возврата»') : bad('список после возврата: ' + J({ pinned, l2 }));
      await p.keyboard.press('Escape'); await p.waitForTimeout(100);
      (await p.evaluate(() => !document.querySelector('.accovl'))) ? ok('Escape закрывает лист и без фокуса в нём') : bad('после Escape лист открыт');
      api.over = (pth) => pth === 'versions' ? { ok: true, list: [] } : undefined;
      await p.click('#acVer'); await until(p, () => /Пока пусто/.test((document.querySelector('#acVerList') || {}).textContent || ''), null, 5000)
        ? ok('пустой список — «Пока пусто — версии появятся по мере работы»') : bad('пустой список не показан');
      await p.click('#acClose');
      (await p.evaluate(() => !document.querySelector('.accovl'))) ? ok('«Закрыть» закрывает лист') : bad('лист не закрылся');
      errCheck(p, 'версии');
      await ctx.close();
    });

    await step('10) «Устройства»: список входов, это устройство без «Выйти», выход на одном и на всех других', async () => {
      const api = miniApi();
      api.sessions = [{ sid: 's_aaaaaaaaaaaa', label: 'Компьютер · Chrome', seen: TODAY_YMD, me: true }, { sid: 's_bbbbbbbbbbbb', label: 'iPhone · Safari', seen: YESTERDAY, me: false }, { sid: 's_cccccccccccc', label: 'Android · Chrome', seen: '2026-10-01', me: false }];
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      await p.click('#acDevs'); await p.waitForSelector('.devrow', { timeout: 5000 });
      const l = await rows(p, '.devrow');
      const allBtn = await p.evaluate(() => !document.querySelector('#acOutAll').hidden);
      (l.length === 3 && /Компьютер · Chrome заходил сегодня · это устройство/.test(l[0].t) && !l[0].btn && /iPhone · Safari заходил вчера Выйти/.test(l[1].t) && /Android · Chrome заходил 1 окт Выйти/.test(l[2].t) && l[1].btn && l[2].btn && allBtn)
        ? ok(`три входа: «${l[0].t}», «${l[1].t}»`) : bad('устройства: ' + J({ l, allBtn }));
      await p.click('.devrow:nth-child(2) button.linkbtn');
      await until(p, () => document.querySelectorAll('.devrow').length === 2, null, 5000);
      const one = api.calls.filter(c => c.path === 'logout').map(c => c.body);
      const l2 = await rows(p, '.devrow');
      (one.length === 1 && one[0].sid === 's_bbbbbbbbbbbb' && !one[0].all && l2.length === 2 && !/iPhone/.test(l2.map(x => x.t).join()) && (await p.evaluate(() => LOGGED())))
        ? ok('«Выйти» у iPhone: /api/logout {sid}, строка ушла, сам остался в аккаунте') : bad('выход одного: ' + J({ one, l2 }));
      p.dialogs = [];
      await p.click('#acOutAll');
      await until(p, () => document.querySelectorAll('.devrow').length === 1, null, 5000);
      const all = api.calls.filter(c => c.path === 'logout').map(c => c.body);
      const l3 = await rows(p, '.devrow'), hid = await p.evaluate(() => ({ hidden: document.querySelector('#acOutAll').hidden, logged: LOGGED(), toast: window.__toasts.slice(-1)[0] || '' }));
      (p.dialogs.length === 1 && /на всех других устройствах/.test(p.dialogs[0]) && all.length === 2 && all[1].all === true && l3.length === 1 && /это устройство/.test(l3[0].t) && hid.hidden && hid.logged && /других устройствах выполнен выход/.test(hid.toast) && api.cur === 'box@example.ru')
        ? ok(`«Выйти на всех других»: вопрос, /api/logout {all:true}, осталось это устройство, кнопка скрыта, «${hid.toast}»`) : bad('выход на всех: ' + J({ dialogs: p.dialogs, all, l3, hid }));
      await p.click('#acClose');
      errCheck(p, 'устройства');
      await ctx.close();
    });

    await step('11) Удаление аккаунта: два шага, код с целью delete без адреса в теле, неверный код понятен, после — записи на телефоне, аккаунта нет, запросов нет', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      const before = await p.evaluate(() => JSON.stringify(docOf(S)));
      await p.click('#acDel'); await p.waitForSelector('#acDlGo', { timeout: 5000 });
      const s1 = await p.evaluate(() => ({ h: document.querySelector('.accovl h4').textContent.trim(), txt: document.querySelector('.accovl .mtxt').textContent, save: !!document.querySelector('#acDlSave'),
        go: document.querySelector('#acDlGo').textContent, danger: document.querySelector('#acDlGo').classList.contains('danger'), code: !!document.querySelector('#acDlCode') }));
      (/Удалить аккаунт\?/.test(s1.h) && /сразу, из резервных копий — в течение 30 дней/.test(s1.txt) && /На этом телефоне записи останутся/.test(s1.txt) && s1.save && s1.go === 'Прислать код' && s1.danger && !s1.code)
        ? ok(`шаг 1: «${s1.h}», «Сначала скачать мои данные», красная «${s1.go}», поля кода ещё нет`) : bad('шаг 1: ' + J(s1));
      const n0 = api.calls.length;
      await p.click('#acDlGo'); await p.waitForSelector('#acDlCode', { timeout: 5000 });
      const codeReq = api.calls.slice(n0).find(c => c.path === 'code');
      (codeReq && codeReq.body.purpose === 'delete' && !('email' in codeReq.body)) ? ok('код запрошен с целью delete, адреса в теле нет — его знает сессия') : bad('запрос кода: ' + J(codeReq));
      const s2 = await p.evaluate(() => ({ txt: document.querySelector('.accovl .mtxt').textContent, go: document.querySelector('#acDlGo').textContent, resend: document.querySelector('#acResend').textContent }));
      (/box@example\.ru/.test(s2.txt) && /аккаунт будет удалён/.test(s2.txt) && s2.go === 'Удалить навсегда' && /ещё раз через/.test(s2.resend)) ? ok(`шаг 2: письмо на box@example.ru, «${s2.go}», повтор по таймеру`) : bad('шаг 2: ' + J(s2));
      await p.fill('#acDlCode', '000000'); await p.waitForTimeout(300);
      const auto = api.calls.filter(c => c.path === 'delete').length;
      await p.click('#acDlGo');
      await until(p, () => /\S/.test(document.querySelector('#acErr').textContent), null, 5000);
      const e1 = await p.evaluate(() => ({ err: document.querySelector('#acErr').textContent, open: !!document.querySelector('#acDlCode'), logged: LOGGED(), val: document.querySelector('#acDlCode').value }));
      (auto === 0 && e1.err === 'Код не подходит. Осталось попыток: 4' && e1.open && e1.logged && e1.val === '')
        ? ok(`шесть цифр сами не отправляются; неверный код: «${e1.err}», поле очищено, аккаунт на месте`) : bad('неверный код: ' + J({ auto, e1 }));
      await p.fill('#acDlCode', GOOD); await p.click('#acDlGo');
      const gone = await until(p, () => !LOGGED() && !document.querySelector('.accovl'), null, 5000);
      await p.waitForTimeout(300);
      const v = await p.evaluate(() => { const raw = JSON.parse(localStorage.getItem('magnat_app_v2')); return { sync: '_sync' in raw, who: JSON.parse(localStorage.getItem('magnat_who_v1') || '{}'), doc: JSON.stringify(docOf(S)), body: S.body.log.length,
        login: !!document.querySelector('#acLogin'), toast: window.__toasts.slice(-1)[0] || '', stash: localStorage.getItem('magnat_stash_v1'), sent: !!_sync }; });
      (gone && !v.sync && !v.sent && !v.who.acct && v.doc === before && v.login && /Аккаунт удалён\. Записи остались только на этом телефоне/.test(v.toast) && api.deleted.includes('box@example.ru') && !api.accts['box@example.ru'])
        ? ok(`удалён: «${v.toast}», снова «Войти по почте», записи на телефоне те же, служебного нет`) : bad('после удаления: ' + J({ gone, v, deleted: api.deleted }));
      const n1 = api.calls.length;
      await p.click('#todayChips .tchip'); await p.waitForTimeout(2600);
      await p.evaluate(() => { lastSync = 0; dispatchEvent(new Event('online')); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await p.waitForTimeout(1500);
      api.calls.length === n1 ? ok('дальше — ни одного запроса: правка, сеть, фокус, возвращение во вкладку') : bad('после удаления ещё запросы: ' + J(api.calls.slice(n1).map(c => c.path)));
      errCheck(p, 'удаление');
      await ctx.close();
    });

    // телефон с записями anna, вошли в anna; возвращает документ anna и её acct
    async function annaPhone(p) {
      await p.goto(URL + '?account'); await p.waitForTimeout(250); await startClean(p);
      await p.click('#todayChips .tchip'); await p.waitForTimeout(200);
      await uiLogin(p, 'anna@example.ru'); await until(p, SETTLED);
      return p.evaluate(() => JSON.stringify(docOf(S)));
    }

    await step('12) Вторая вкладка с открытым окном правки: первая вошла в другой аккаунт — «Сохранить» не уносит записи первого в новый', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      const before = await annaPhone(p);
      const annaAcct = api.accts['anna@example.ru'].acct;
      const p2 = await ctx.newPage(); Object.assign(p2, { errs: [] });
      p2.on('pageerror', e => p2.errs.push('PAGEERROR: ' + e.message)); p2.on('dialog', d => d.accept());
      await p2.goto(URL); await p2.waitForTimeout(400);
      await p2.evaluate(() => { editHabit(S.habits[0].id); });          // окно правки: чужую запись эта вкладка пока не принимает
      await p.click('#acOut'); await until(p, () => !LOGGED()); await p.waitForTimeout(300);
      await uiLogin(p, 'boris@example.ru');
      await until(p, () => LOGGED() && !_sync.first && !syncBusy && !!document.querySelector('#startOwn'), null, 8000);
      const borisAcct = api.accts['boris@example.ru'].acct;
      const mid = await p2.evaluate(() => ({ modal: !!document.querySelector('#hSv'), acct: _sync && _sync.acct, doc: JSON.stringify(docOf(S)) }));
      await p2.evaluate(() => { document.querySelector('#hSv').click(); });   // «Сохранить» → save() → casMerge с хранилищем boris
      await p2.waitForTimeout(3500);                                           // afterSave звал бы отправку через 2 с
      const after = await p2.evaluate(() => { const d = JSON.parse(localStorage.getItem('magnat_app_v2')), st = JSON.parse(localStorage.getItem('magnat_stash_v1') || '{}');
        return { acct: _sync && _sync.acct, demo: !!S.demoData, doc: JSON.stringify(docOf(S)), storedDemo: !!d.demoData, storedAcct: d._sync && d._sync.acct, stashDoc: st[Object.keys(st)[0]] && JSON.stringify(docOf(st[Object.keys(st)[0]].s)) }; });
      (mid.modal && mid.acct === annaAcct && mid.doc === before) ? ok('под окном во второй вкладке — ещё записи anna') : bad('вторая вкладка до «Сохранить»: ' + J(mid));
      (after.acct === borisAcct && after.demo && after.storedDemo && after.storedAcct === borisAcct && after.doc !== before && after.stashDoc === before)
        ? ok('«Сохранить» принял хранилище целиком: на обеих вкладках пример boris, записи anna — в скрытой копии') : bad('после «Сохранить»: ' + J({ ...after, stashSame: after.stashDoc === before }));
      const bDoc = api.accts['boris@example.ru'].doc;
      (!bDoc && !api.pushes().some(c => c.body.acct === borisAcct)) ? ok('в аккаунт boris не ушло ничего') : bad('в boris ушли записи anna: ' + J({ bDoc: !!bDoc, pushes: api.pushes().map(c => c.body.acct) }));
      errCheck(p, 'вкладка 1'); errCheck(p2, 'вкладка 2');
      await ctx.close();
    });

    await step('13) Место в браузере кончилось — копия прежнего аккаунта не записалась: вход в новый отменён, записи целы', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      const before = await annaPhone(p);
      const annaAcct = api.accts['anna@example.ru'].acct;
      await p.click('#acOut'); await until(p, () => !LOGGED()); await p.waitForTimeout(300);
      await p.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'magnat_stash_v1') throw new Error('QuotaExceededError'); return o.call(this, k, v); }; });
      const n0 = api.calls.length;
      await uiLogin(p, 'boris@example.ru'); await p.waitForTimeout(1500);
      const v = await p.evaluate(() => ({ logged: LOGGED(), acct: _sync && _sync.acct, doc: JSON.stringify(docOf(S)), stash: localStorage.getItem('magnat_stash_v1'), toasts: window.__toasts.slice(),
        who: JSON.parse(localStorage.getItem('magnat_who_v1') || '{}').acct, stored: !!localStorage.getItem('magnat_app_v2'), login: !!document.querySelector('#acLogin') }));
      const after = api.calls.slice(n0).map(c => c.path + (c.body.doc ? ':push' : ''));
      (!v.logged && v.login && v.acct === annaAcct && v.doc === before && v.stored && v.stash === null && !v.who && v.toasts.some(t => /вход отменён/.test(t)))
        ? ok(`вход отменён словами, записи anna на месте, в аккаунт не вошли: «${v.toasts.find(t => /отменён/.test(t))}»`) : bad('копия не записалась: ' + J(v));
      (after.join() === 'code,login,logout' && !api.accts['boris@example.ru'].doc) ? ok('сессия boris снята (/api/logout), отправок не было') : bad('запросы: ' + J(after));
      errCheck(p, 'нет места для копии');
      await ctx.close();
    });

    await step('14) Удаление: лист закрыли (Escape), пока шёл запрос, — ответ «ok» всё равно прибирает аккаунт на телефоне', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      await p.click('#acDel'); await p.waitForSelector('#acDlGo', { timeout: 5000 });
      await p.click('#acDlGo'); await p.waitForSelector('#acDlCode', { timeout: 5000 });
      api.delayFor = (pth) => pth === 'delete' ? 1200 : 0;
      await p.fill('#acDlCode', GOOD); await p.click('#acDlGo'); await p.waitForTimeout(150);
      await p.keyboard.press('Escape');
      const closed = await p.evaluate(() => !document.querySelector('.accovl'));
      await p.waitForTimeout(2200);
      const v = await p.evaluate(() => ({ logged: LOGGED(), sync: '_sync' in JSON.parse(localStorage.getItem('magnat_app_v2')), who: JSON.parse(localStorage.getItem('magnat_who_v1') || '{}').acct,
        login: !!document.querySelector('#acLogin'), toast: window.__toasts.slice(-1)[0] || '', checks: Object.keys(S.checks).length }));
      (closed && api.deleted.includes('box@example.ru') && !v.logged && !v.sync && !v.who && v.login && v.checks === 1 && /Аккаунт удалён/.test(v.toast))
        ? ok('лист закрыт до ответа, аккаунт на сервере удалён — на телефоне тоже прибрано, записи целы') : bad('удаление при закрытом листе: ' + J({ closed, v, deleted: api.deleted }));
      errCheck(p, 'удаление при закрытом листе');
      await ctx.close();
    });

    await step('15) «Вернуть версию» во время медленной отправки правки: возврат уходит как restore, прежняя голова закреплена', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250);
      const doc0 = await seedLogged(p, api, 'box@example.ru', HB());
      await until(p, SETTLED);
      await p.evaluate(() => { S.habits[0].name = 'Бег утром'; save(); });
      if (!await until(p, settledRev, 2, 12000)) throw new Error('первая правка не ушла');
      api.delayFor = (pth, b) => pth === 'sync' && typeof b.doc === 'string' ? 4000 : 0;   // вторая правка едет медленно
      await p.evaluate(() => { S.habits[1].name = 'Чтение вечером'; save(); });
      if (!await until(p, () => syncBusy && !!_sync.out, null, 6000)) throw new Error('отправка второй правки не началась');
      await p.click('#acVer'); await p.waitForSelector(`.verrow button[data-rid="${RID0}"]`, { timeout: 5000 });
      await p.click(`.verrow button[data-rid="${RID0}"]`);                     // «Вернуть …?» → да
      await until(p, () => !document.querySelector('.accovl') && S.habits[0].name === 'Бег', null, 5000);
      const midReset = await p.evaluate(() => _sync.reset);
      const set = await until(p, settledRev, 4, 20000);
      const reasons = api.pushes().map(c => c.body.reason);
      const a = api.accts['box@example.ru'], prev = [...a.vers.values()].find(v => v.rev === 3);
      const r = await p.evaluate(() => ({ doc: JSON.stringify(docOf(S)), reset: _sync.reset }));
      (midReset === 'restore' && set && reasons.join() === 'edit,edit,restore' && prev && prev.pin && r.doc === doc0 && r.reset === '')
        ? ok(`отправки: ${reasons.join(', ')} — возврат не превратился в edit, голова до возврата закреплена, записи как в первой версии`)
        : bad('гонка возврата: ' + J({ midReset, set, reasons, pin: prev && prev.pin, same: r.doc === doc0, reset: r.reset }));
      errCheck(p, 'гонка возврата');
      await ctx.close();
    });
  } finally {
    try { await browser.close(); } catch (e) {}
    await SRV.close();
  }
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

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
//   5) вход в другой аккаунт на телефоне с чужими записями: не переносим, почту не показываем;
//   6) «Выйти» без сети: выход на сервере доходит, когда сеть появится;
//   7) кошелёк в минусе после двух устройств: настоящий «−», красным, «Купить» выключена;
//   8) «Восстановить из копии» при входе спрашивает про аккаунт и все телефоны.
// Страница — http://127.0.0.1 (secure context), service worker выключен: /api ловит route.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, chromePath, APP_DIR, startClean } = require('./lib');

let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };
const J = (x) => JSON.stringify(x);
const ACCT = 'a_0123456789abcdef', DEV = 'd_0123456789abcdef', RID0 = 'r_aaaaaaaaaaaaaaaa';
const hex16 = (n) => n.toString(16).padStart(16, '0');

// статика из корня репозитория
function staticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp' };
  const s = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(APP_DIR, u === '/' ? '/app.html' : u);
    if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nope'); }
    r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise(res => s.listen(0, '127.0.0.1', () => res({ url: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.close(r); s.closeAllConnections(); }) })));
}

// модель API: вход по любому коду, CAS по голове, pull/same/empty — как api.py по смыслу.
// over(path, body) — подменить ответ в блоке (вернуть объект) или пропустить (undefined)
function miniApi() {
  const st = { calls: [], accts: {}, cur: null, n: 0, over: null };
  const head = (a) => ({ rid: a.rid, rev: a.rev, sv: 1, at: 1760000000, label: 'Компьютер · Chrome', sum: {} });
  st.add = (mail, doc, rid = RID0, acct = ACCT) => (st.accts[mail] = { acct, rid, rev: rid ? 1 : 0, doc, revs: new Set(rid ? [rid] : []), seq: {} });
  st.handle = (p, b) => {
    const o = st.over && st.over(p, b); if (o) return o;
    if (p === 'code') return { ok: true, ttl: 900, resend: 60 };
    if (p === 'login') {
      const em = String(b.email || '').trim().toLowerCase();
      const a = st.accts[em] || st.add(em, null, null, 'a_' + hex16(0xabc000 + Object.keys(st.accts).length));
      st.cur = em; return { ok: true, acct: a.acct, email: em };
    }
    if (p === 'logout') { st.cur = null; return { ok: true }; }
    if (p === 'me') { const a = st.cur && st.accts[st.cur]; return a ? { ok: true, auth: true, acct: a.acct, email: st.cur } : { ok: true, auth: false }; }
    if (p !== 'sync') return { ok: false, err: 'bad' };
    const a = st.cur && st.accts[st.cur];
    if (!a) return { ok: false, err: 'auth' };
    if (b.acct !== a.acct) return { ok: false, err: 'acct' };
    const seqMax = a.seq[b.dev] || 0;
    const pull = () => ({ ok: true, st: 'pull', head: head(a), doc: a.doc, known: !!b.base && a.revs.has(b.base), parked: null, seqMax });
    if (b.doc == null) return !a.rid ? { ok: true, st: 'empty', seqMax } : b.base === a.rid ? { ok: true, st: 'same', head: head(a) } : pull();
    if (a.rid && b.base !== a.rid) return pull();
    a.rid = 'r_' + hex16(++st.n); a.rev++; a.doc = b.doc; a.revs.add(a.rid); a.seq[b.dev] = Math.max(seqMax, b.seq);
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
  if (api) await ctx.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api\//, '');
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    api.calls.push({ path: p, body: b });
    return route.fulfill({ status: 200, contentType: 'application/json', body: J(api.handle(p, b)) });
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
    await step('1) Предпросмотр включается только явно: ?account и ?account=1 — да, ?account=false — нет, ?account=0 — снимает', async () => {
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

    await step('5) Вход в другой аккаунт на телефоне с записями первого: не переносим, почту первого целиком не показываем', async () => {
      const api = miniApi();
      const { ctx, p } = await mk({ api });
      await p.goto(URL + '?account'); await p.waitForTimeout(250); await startClean(p);
      await p.click('#todayChips .tchip'); await p.waitForTimeout(200);
      await uiLogin(p, 'anna@example.ru');
      await until(p, SETTLED);
      await p.click('#acOut'); await until(p, () => !LOGGED());
      await p.waitForTimeout(300);
      const before = await p.evaluate(() => JSON.stringify(docOf(S)));
      const n0 = api.calls.length; p.dialogs = [];
      const pre = await uiLogin(p, 'boris@example.ru');
      await until(p, () => /\S/.test((document.querySelector('#acErr') || {}).textContent || ''), null, 6000);
      await p.waitForTimeout(500);
      const v = await p.evaluate(() => ({ err: (document.querySelector('#acErr') || {}).textContent || '', open: !!document.querySelector('.accovl'),
        logged: LOGGED(), acct: _sync && _sync.acct, doc: JSON.stringify(docOf(S)) }));
      const after = api.calls.slice(n0).map(c => c.path + (c.body.doc ? ':push' : ''));
      const shown = v.err + ' ' + p.dialogs.join(' ');
      pre === '' ? ok('после «Выйти» почта прежнего аккаунта в поле входа не подставлена') : bad('в поле входа подставлено: ' + pre);
      (/другого аккаунта/.test(v.err) && /a•••@example\.ru/.test(v.err) && !/anna@/.test(shown) && v.open && !v.logged)
        ? ok(`окно входа не закрылось: «${v.err}»`) : bad('вход в другой аккаунт: ' + J({ v, dialogs: p.dialogs }));
      (after.join() === 'code,login,logout' && v.doc === before && v.acct === api.accts['anna@example.ru'].acct)
        ? ok('новый аккаунт сразу вышел (/api/logout), ни одной синхронизации с ним, записи телефона не тронуты') : bad('запросы после входа: ' + J(after));
      const bDoc = api.accts['boris@example.ru'] && api.accts['boris@example.ru'].doc;
      !bDoc ? ok('в аккаунт boris не ушло ничего') : bad('записи anna попали в аккаунт boris');
      errCheck(p, 'чужой аккаунт');
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
  } finally {
    try { await browser.close(); } catch (e) {}
    await SRV.close();
  }
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

#!/usr/bin/env node
// 09-account: вход по почте и синхронизация — сквозная проверка на НАСТОЯЩЕМ сервере.
// Настоящий server/api/api.py (вход закрыт, как на magnat-planer.ru: код получают только два
// ящика владельца из smtp.env — здесь box@example.ru и support@example.ru, почта — поддельная)
// за настоящим server/Caddyfile: приложение и /api — один адрес, как на сайте. Между Caddy и
// API — dropProxy из lib.js: он видит каждый запрос к API и умеет «проглотить» ответ.
// В выпуске R2 вход выключен (ACCOUNT_ON=false): посетитель — ни карточки, ни запроса, ни куки.
// Включает его только предпросмотр владельца (?account), в рамке Claude и на file:// — никогда.
// Порядок блоков важен: посетитель идёт первым, пока к API не ушёл ни один запрос. В конце — «Версии»
// и удаление аккаунта на B: настоящие ревизии, письмо «Код для удаления», БД без следа.
const path = require('path'), { spawnSync } = require('child_process');
const { chromium, chromePath, APP_DIR, APP_FILE, startClean, startCaddy, startApi, fakeSmtp, dropProxy, frameServer,
  waitCode, parseMail, freePort, cleanup } = require('./lib');

let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };
const J = (x) => JSON.stringify(x);
const OWNER = 'box@example.ru', SUPPORT = 'support@example.ru', STRANGER = 'stranger@example.ru';
const TASK = 'Отчёт для проверки входа';
// ответ, проглоченный нарочно, браузер пишет в консоль как ошибку загрузки (Caddy: 503 «down»)
const DOWN = (t, u) => /Failed to load resource.*\b503\b/.test(t) && /\/api\/sync$/.test(u);

let smtp, api, proxy, caddy, browser, URL;
const apiPath = (u) => { try { return new URL(u).pathname; } catch (e) { return ''; } };

async function mk(name, vp = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport: vp });
  // тосты живут 1,9 с — записываем каждый, чтобы не ловить их по таймеру
  await ctx.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('toast');
      if (t) new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    });
  });
  const p = await ctx.newPage();
  Object.assign(p, { name, errs: [], api: [], allow: null, allowed: [] });
  p.on('pageerror', e => p.errs.push('PAGEERROR: ' + e.message));
  // allow(текст, адрес) — ошибка, которую блок вызывает нарочно (и только её)
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const u = (m.location() || {}).url || '';
    if (p.allow && p.allow(m.text(), u)) p.allowed.push(u); else p.errs.push('CONSOLE: ' + m.text());
  });
  p.on('request', r => { const pa = apiPath(r.url()); if (pa.startsWith('/api')) p.api.push({ path: pa, body: r.postData() || '' }); });
  p.on('dialog', d => d.accept());
  return { ctx, p };
}
const errCheck = (p, label) => { if (p.errs.length) bad(`${label}: ошибки в консоли — ${p.errs.join(' | ')}`); else ok(`${label}: консоль чистая`); p.errs = []; };
// дождаться условия на странице; false — не дождались (без исключения)
const until = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 100 }).then(() => true, () => false);
const home = async (p) => { if (await p.$('.tab[data-t="home"]')) { await p.click('.tab[data-t="home"]'); await p.waitForTimeout(150); } };

// что видно и что внутри: документ аккаунта (docOf), служебное _sync, строка состояния, отметки дня
const snap = (p) => p.evaluate(() => ({
  on: typeof ACCOUNT !== 'undefined' && ACCOUNT, logged: LOGGED(),
  sync: _sync ? { acct: _sync.acct, rid: _sync.rid, seq: _sync.seq, out: _sync.out, first: _sync.first, off: _sync.off, auth: _sync.auth, dev: _sync.dev } : null,
  st: ((document.querySelector('#acSt') || {}).textContent || '').trim(),
  doc: JSON.stringify(docOf(S)), checks: JSON.stringify(S.checks), body: S.body.log.length,
  wallet: wallet(), spent: S.spent, bought: JSON.stringify(S.boughtCnt), lastLv: S.lastLv,
  chips: [...document.querySelectorAll('#todayChips .tchip')].map(c => c.getAttribute('aria-checked')).join(','),
  acc: !!document.querySelector('#acc'), login: !!document.querySelector('#acLogin'), out: !!document.querySelector('#acOut'),
  bk: !!document.querySelector('#bkSave') && !!document.querySelector('#bkLoad'), ob: !!document.querySelector('#obFresh'),
  obLogin: !!document.querySelector('#obLogin'), ovl: document.querySelectorAll('.ovl').length,
  toasts: (window.__toasts || []).slice(), flag: localStorage.getItem('magnat_acc_preview'), search: location.search,
}));
// синхронизация улеглась: вошли, отправлять нечего, ответ получен, строка «Синхронизировано»
const SETTLED = () => LOGGED() && !_sync.first && !_sync.out && !_sync.auth && !syncBusy && !ACST.pending
  && JSON.stringify(docOf(S)) === JSON.stringify(_sync.base) && /Синхронизировано/.test((document.querySelector('#acSt') || {}).textContent || '');
const settled = async (p, ms = 20000) => { await home(p); return until(p, SETTLED, null, ms); };

// БД API — прямо файлом (только чтение по смыслу: SELECT)
function db(sql) {
  const r = spawnSync('python3', ['-I', '-c', 'import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1],timeout=5)\nprint(json.dumps(c.execute(sys.argv[2]).fetchall()))', api.db, sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite: ' + r.stderr);
  return JSON.parse(r.stdout);
}
// запросы к API, дошедшие до сервера (через Caddy → dropProxy), с номера from
const srv = (from = 0) => proxy.log.slice(from);
// документ ревизии — из БД (блоб сжат zlib)
function dbDoc(rid) {
  const r = spawnSync('python3', ['-I', '-c', 'import sqlite3,zlib,sys\nc=sqlite3.connect(sys.argv[1],timeout=5)\nr=c.execute("SELECT blob FROM revisions WHERE rid=?",(sys.argv[2],)).fetchone()\nsys.stdout.write(zlib.decompress(r[0]).decode() if r and r[0] else "")', api.db, rid], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite: ' + r.stderr);
  return r.stdout;
}

// вход через интерфейс: почта → «Получить код» → код из письма (неверный, если wrong) → «Войти»
async function login(p, mail, { from = '#acLogin', wrong = false } = {}) {
  const before = smtp.to(mail).length;
  await p.click(from); await p.waitForSelector('#acMail', { timeout: 5000 });
  await p.fill('#acMail', mail); await p.click('#acGo');
  await p.waitForSelector('#acCode', { timeout: 10000 });
  const code = await waitCode(smtp, mail, { kind: 'login', after: before });
  if (!code) throw new Error('код не пришёл на ' + mail);
  let w = null;
  if (wrong) {
    const bad6 = code.split('').map(d => (+d + 1) % 10).join('');   // точно не тот
    await p.fill('#acCode', bad6);
    await until(p, () => /\S/.test(document.querySelector('#acErr').textContent), null, 10000);
    w = await p.evaluate(() => { const e = document.querySelector('#acErr'); return { text: e.textContent, on: e.classList.contains('on'), open: !!document.querySelector('#acCode'), val: document.querySelector('#acCode').value }; });
  }
  await p.fill('#acCode', code.slice(0, 3) + ' ' + code.slice(3));   // как вставляют из письма: «482 913»
  await p.waitForSelector('.accovl', { state: 'detached', timeout: 10000 });
  return { code, wrong: w };
}

(async () => {
  console.log('Аккаунт: настоящий api.py за настоящим Caddyfile, вход закрыт — код только ящикам владельца');
  try {
    smtp = await fakeSmtp();
    const apiPort = await freePort();
    proxy = await dropProxy(apiPort);
    caddy = await startCaddy({ api: proxy });
    // вход закрыт (OPEN по умолчанию False): разрешены SMTP_USER и SUPPORT из smtp.env, это fakeSmtp.
    // Пауза между кодами на один адрес — 0: два телефона входят одним ящиком подряд
    api = await startApi({ port: apiPort, origin: caddy.origin, smtp, env: { MAGNAT_CODE_GAP: '0' } });
    URL = caddy.url + '/app.html';
  } catch (e) {
    bad('сервер для проверки не поднялся (Caddy, api.py или подделки) — это провал, а не пропуск: ' + (e.stack || e));
    await cleanup(); process.exit(1);
  }
  console.log(`  сайт ${caddy.url}, API ${api.addr} через ${proxy.addr}, вход: ${api.ready && api.ready.ok ? 'API жив' : J(api.ready)}`);
  browser = await chromium.launch({ executablePath: chromePath() });
  let A, B;   // два «телефона» одного владельца
  const step = async (title, fn) => { console.log('\n' + title); try { await fn(); } catch (e) { bad(`${title}: упал — ${(e.stack || e).toString().split('\n').slice(0, 3).join(' / ')}`); } };

  try {
    // ───────────── 1. посетитель: ровно прежнее приложение ─────────────
    await step('1) Посетитель без метки: ни карточки, ни запроса к /api, ни куки', async () => {
      const { ctx, p } = await mk('посетитель');
      await p.goto(URL); await p.waitForTimeout(500);
      const v0 = await snap(p);
      await startClean(p);
      await p.click('#todayChips .tchip'); await p.waitForTimeout(2600);   // правка: afterSave ждал бы 2 с
      for (const t of ['habits', 'tasks', 'money', 'body', 'shop', 'home']) { await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(150); }
      await p.reload(); await p.waitForTimeout(1600);                     // загрузка: sync() звался бы через 1 с
      const v1 = await snap(p), ck = await ctx.cookies();
      (!v0.on && !v0.obLogin && v0.ob && !v1.acc && v1.bk && v1.flag === null && !p.api.length && proxy.count('/api') === 0 && !ck.length)
        ? ok('приветствие без «Войти», на «Обзоре» «Скачать копию / Восстановить», 0 запросов из браузера, 0 на сервере, 0 кук')
        : bad('посетитель: ' + J({ v0: { on: v0.on, obLogin: v0.obLogin }, acc: v1.acc, bk: v1.bk, flag: v1.flag, api: p.api, srv: proxy.count('/api'), ck }));
      errCheck(p, 'посетитель');
      await ctx.close();
    });

    // ───────────── 2. владелец: ?account, неверный код, верный код, загрузка своего ─────────────
    await step('2) Предпросмотр владельца: ?account → неверный код (понятно по-русски) → верный → свои записи уходят в аккаунт', async () => {
      A = await mk('A');
      const a = A.p;
      await a.goto(URL); await a.waitForTimeout(400); await startClean(a);
      // свои записи до входа: 10 прожитых дней по трём привычкам, задача, вес (вес в аккаунт не уходит)
      await a.evaluate((task) => {
        for (const h of S.habits) h.since = addDays(TODAY, -10);
        for (let k = 10; k >= 1; k--) S.checks[addDays(TODAY, -k)] = S.habits.map(h => h.id);
        S.tasks.push({ id: uid(), name: task, prio: 'md', due: TODAY, done: false });
        S.body.log.push({ date: TODAY, w: 80 });
        save(); S.lastLv = levelOf(totalXP()); save(); render();
      }, TASK);
      await a.click('#todayChips .tchip');                                   // и отметка сегодня — пальцем
      await a.waitForTimeout(400);
      const local = await snap(a);
      await a.goto(URL + '?account'); await a.waitForTimeout(2500);
      const v = await snap(a);
      (v.on && v.flag === '1' && !/account/.test(v.search) && v.acc && v.login && !v.out && !a.api.length && proxy.count('/api') === 0)
        ? ok('?account: метка в браузере, адрес очищен, карточка «Вход по почте»; до нажатия «Войти» — 0 запросов')
        : bad('?account до входа: ' + J({ on: v.on, flag: v.flag, search: v.search, acc: v.acc, login: v.login, api: a.api }));

      const n0 = proxy.log.length;
      const r = await login(a, OWNER, { wrong: true });
      const w = r.wrong;
      (w && w.text === 'Код не подходит. Осталось попыток: 4' && w.on && w.open && w.val === '' && !/[A-Za-z_]/.test(w.text))
        ? ok(`неверный код: «${w.text}», поле очищено, окно не закрылось`) : bad('неверный код: ' + J(w));
      const sentWrong = srv(n0).find(e => e.path === '/api/login' && e.resJson && e.resJson.err === 'code');
      sentWrong ? ok('сервер ответил на неверный код err=code, приложение не показало служебного слова') : bad('нет ответа code на неверный код: ' + J(srv(n0).map(e => [e.path, e.resJson])));
      const isSet = await settled(a);
      const s = await snap(a), ck = await A.ctx.cookies();
      (isSet && s.logged && s.sync.rid && s.doc === local.doc && s.toasts.some(t => /сохранён в аккаунте/.test(t)))
        ? ok(`верный код «${r.code.slice(0, 3)} ${r.code.slice(3)}» → вошёл, «${s.st}», тост «${s.toasts.find(t => /сохранён/.test(t))}»`)
        : bad('после входа: ' + J({ isSet, st: s.st, sync: s.sync, same: s.doc === local.doc, toasts: s.toasts }));
      (ck.length === 1 && ck[0].name === '__Host-mg' && ck[0].httpOnly && ck[0].secure && ck[0].sameSite === 'Strict' && await a.evaluate(() => document.cookie === ''))
        ? ok('кука одна: __Host-mg, HttpOnly, Secure, SameSite=Strict; document.cookie пуст')
        : bad('куки после входа: ' + J(ck));
      // первая отправка — свои записи: doc без «Тела», reason=first, сервер принял
      const up = srv(n0).filter(e => e.path === '/api/sync' && e.json && typeof e.json.doc === 'string');
      const first = up[0], fd = first ? JSON.parse(first.json.doc) : {};
      (first && first.json.reason === 'first' && first.resJson && first.resJson.st === 'ok' && JSON.stringify(fd.checks) === local.checks
        && fd.tasks.some(t => t.name === TASK) && !('body' in fd) && !('demoData' in fd) && first.json.seq === 1 && /^[0-9a-f]{64}$/.test(first.json.hash))
        ? ok(`первая отправка: reason=first, seq=1, все ${Object.keys(fd.checks).length} дней отметок и задача, без «Тела» — сервер: ok`)
        : bad('первая отправка: ' + J(first ? { reason: first.json.reason, seq: first.json.seq, st: first.resJson, body: 'body' in fd } : srv(n0).map(e => [e.path, e.json && e.json.reason, e.resJson && e.resJson.st])));
      const revs = db("SELECT kind, reason, seq FROM revisions"), head = db('SELECT head_rid, email FROM accounts');
      (revs.length === 1 && revs[0][0] === 'push' && revs[0][1] === 'first' && head.length === 1 && head[0][0] === s.sync.rid && head[0][1] === OWNER)
        ? ok('в БД сервера: один аккаунт box@example.ru, одна ревизия push/first, голова = rid телефона')
        : bad('БД после первого входа: ' + J({ revs, head, rid: s.sync.rid }));
      errCheck(a, 'телефон A, вход');
    });

    // ───────────── 3. второй телефон тем же ящиком ─────────────
    await step('3) Второй телефон (другой браузер) входит тем же ящиком с приветствия — получает те же отметки', async () => {
      B = await mk('B');
      const bb = B.p;
      await bb.goto(URL + '?account'); await bb.waitForTimeout(600);
      const v0 = await snap(bb);
      v0.obLogin ? ok('в приветствии «Уже пользуешься Магнатом? Войти по почте»') : bad('нет #obLogin в приветствии: ' + J(v0));
      await login(bb, OWNER, { from: '#obLogin' });
      const isSet = await settled(bb);
      const sa = await snap(A.p), sb = await snap(bb);
      (isSet && sb.doc === sa.doc && sb.checks === sa.checks && sb.chips === sa.chips && sb.chips.includes('true'))
        ? ok(`B получил те же записи (docOf совпал), отметки сегодня ${sb.chips}`)
        : bad('B после входа: ' + J({ isSet, same: sb.doc === sa.doc, a: sa.chips, b: sb.chips, st: sb.st }));
      (sb.body === 0 && sa.body === 1 && !sb.ob && sb.ovl === 0 && sb.toasts.some(t => /С возвращением/.test(t)))
        ? ok(`«Тело» осталось на A, у B пусто; приветствие закрыто, праздника уровня нет; тост «${sb.toasts.find(t => /С возвращением/.test(t))}»`)
        : bad('B: ' + J({ bodyB: sb.body, bodyA: sa.body, ob: sb.ob, ovl: sb.ovl, toasts: sb.toasts }));
      (sb.sync.dev !== sa.sync.dev && sb.sync.acct === sa.sync.acct) ? ok('один аккаунт, у каждого телефона свой dev') : bad('dev/acct: ' + J([sa.sync, sb.sync]));
      errCheck(bb, 'телефон B, вход');
    });

    // ───────────── 4. правка на одном видна на другом ─────────────
    await step('4) Правка на A видна на B после синхронизации, и наоборот', async () => {
      const a = A.p, bb = B.p;
      await home(a);
      const idx = await a.evaluate(() => [...document.querySelectorAll('#todayChips .tchip')].findIndex(c => c.getAttribute('aria-checked') === 'false'));
      await a.click(`#todayChips .tchip >> nth=${idx}`);                       // A ставит вторую отметку пальцем
      const aSet = await settled(a);
      const sa = await snap(a);
      await bb.reload();                                                     // B открывают снова: sync через 1 с
      const got = await until(bb, (want) => JSON.stringify(S.checks) === want, sa.checks, 15000) && await settled(bb);
      const sb = await snap(bb);
      (aSet && got && sb.chips === sa.chips && sb.doc === sa.doc)
        ? ok(`отметка A (${sa.chips}) доехала до B после открытия`) : bad('A→B: ' + J({ aSet, got, a: sa.chips, b: sb.chips, st: sb.st }));
      // B снимает первую отметку; A узнаёт, вернувшись во вкладку (visibilitychange)
      await home(bb);
      await bb.click('#todayChips .tchip >> nth=0');
      const bSet = await settled(bb);
      const sb2 = await snap(bb);
      await a.evaluate(() => { lastSync = Date.now() - 60000; document.dispatchEvent(new Event('visibilitychange')); });
      const got2 = await until(a, (want) => JSON.stringify(S.checks) === want, sb2.checks, 15000) && await settled(a);
      const sa2 = await snap(a);
      (bSet && got2 && sa2.chips === sb2.chips && sa2.doc === sb2.doc && sa2.chips.split(',')[0] === 'false' && sa2.toasts.some(t => /другого устройства/.test(t)))
        ? ok(`снятая на B отметка снята и на A (${sa2.chips}), тост «Подтянули изменения с другого устройства»`)
        : bad('B→A: ' + J({ bSet, got2, a: sa2.chips, b: sb2.chips, toasts: sa2.toasts.slice(-3) }));
      errCheck(a, 'A, синхронизация'); errCheck(bb, 'B, синхронизация');
    });

    // ───────────── 5. ответ потерян — монеты не удваиваются ─────────────
    await step('5) Ответ на отправку с покупкой награды потерян (dropProxy) → повтор с тем же seq → dup, монеты не удвоены', async () => {
      const a = A.p, bb = B.p;
      const before = await snap(a), revBefore = db("SELECT COUNT(*) FROM revisions WHERE kind='push'")[0][0];
      const n0 = proxy.log.length;
      const dropped = proxy.dropNext({ method: 'POST', path: '/api/sync', when: e => !!e.json && typeof e.json.doc === 'string' });
      a.allow = DOWN;
      await a.click('.tab[data-t="shop"]'); await a.waitForTimeout(250);
      const rw = await a.evaluate(() => { const r = S.rewards.filter(x => rwCost(x) <= wallet()).sort((x, y) => rwCost(x) - rwCost(y))[0]; return r ? { id: r.id, name: r.name, cost: rwCost(r) } : null; });
      if (!rw) throw new Error('на A не хватает монет ни на одну награду: ' + before.wallet);
      await a.click(`.si[data-pop="rw${rw.id}"] .buy`);                     // «Купить» → системное «Купить?» → да
      const e = await Promise.race([dropped, new Promise(r => setTimeout(() => r(null), 15000))]);
      const down = e && await until(a, () => /Сервер не отвечает/.test((document.querySelector('#acSt') || {}).textContent || ''), null, 4000).catch(() => false);
      const isSet = await settled(a, 30000);                                   // повтор через 5 с (backoff)
      a.allow = null;
      const after = await snap(a);
      const retry = e && srv(n0).filter(x => x !== e && x.path === '/api/sync' && x.json && typeof x.json.doc === 'string');
      const r1 = retry && retry[0];
      (e && e.resJson && e.resJson.st === 'ok' && e.action === 'drop')
        ? ok(`отправка seq=${e.json.seq} дошла до API (ok), ответ проглочен прокси — телефон его не получил`) : bad('проглатывание: ' + J(e && { st: e.resJson, action: e.action }));
      down ? ok('на A: «Сервер не отвечает — всё на телефоне, попробую позже», не отправленное помнит') : bad('нет строки «Сервер не отвечает» после потерянного ответа');
      (r1 && r1.json.seq === e.json.seq && r1.json.hash === e.json.hash && r1.json.outHash === e.json.hash && r1.resJson && r1.resJson.st === 'dup' && retry.length === 1)
        ? ok(`повтор: тот же seq=${r1.json.seq} и hash, outHash = hash → сервер узнал: dup`)
        : bad('повтор: ' + J(retry && retry.map(x => ({ seq: x.json.seq, hash: x.json.hash && x.json.hash.slice(0, 8), outHash: x.json.outHash && x.json.outHash.slice(0, 8), st: x.resJson && x.resJson.st, err: x.resJson && x.resJson.err })) || null) + ' исходная seq=' + (e && e.json.seq));
      const revAfter = db("SELECT COUNT(*) FROM revisions WHERE kind='push'")[0][0];
      revAfter === revBefore + 1 ? ok('на сервере ровно одна новая ревизия') : bad(`ревизий push: было ${revBefore}, стало ${revAfter}`);
      const cnt = (s) => JSON.parse(s.bought)[rw.id] || 0;
      (isSet && after.spent === before.spent + rw.cost && after.wallet === before.wallet - rw.cost && cnt(after) === cnt(before) + 1)
        ? ok(`A: «${rw.name}» куплена один раз — потрачено ${before.spent}→${after.spent}, кошелёк ${before.wallet}→${after.wallet}`)
        : bad('A после повтора: ' + J({ isSet, st: after.st, spent: [before.spent, after.spent], wallet: [before.wallet, after.wallet], cost: rw.cost, bought: [cnt(before), cnt(after)] }));
      await bb.reload();
      const got = await until(bb, (sp) => S.spent === sp, after.spent, 15000) && await settled(bb);
      const sb = await snap(bb);
      (got && sb.spent === after.spent && sb.wallet === after.wallet && sb.bought === after.bought && sb.doc === after.doc)
        ? ok(`B: потрачено ${sb.spent}, кошелёк ${sb.wallet}, куплено ×${cnt(sb)} — как на A, не вдвое`)
        : bad('B после потерянного ответа: ' + J({ got, spent: sb.spent, wallet: sb.wallet, want: [after.spent, after.wallet], bought: sb.bought }));
      errCheck(a, `A, потерянный ответ (разрешена только ошибка загрузки 503 на /api/sync — их ${a.allowed.length})`); errCheck(bb, 'B, потерянный ответ');
    });

    // ───────────── 6. выход: записи на телефоне, запросов больше нет ─────────────
    await step('6) Выход на A: записи остаются на телефоне, кука снята, запросов к /api больше нет', async () => {
      const a = A.p;
      await home(a);
      const before = await snap(a), ck0 = await A.ctx.cookies(), tok = ck0.length ? `${ck0[0].name}=${ck0[0].value}` : '';
      const n0 = proxy.log.length;
      await a.click('#acOut');                                                  // «Выйти из аккаунта?» → да
      await until(a, () => !LOGGED(), null, 10000);
      const t0 = Date.now(); let lo;
      while (!(lo = srv(n0).find(e => e.path === '/api/logout' && e.status)) && Date.now() - t0 < 10000) await a.waitForTimeout(100);
      const lr = lo && lo.resJson;
      await a.waitForTimeout(300);
      const mark = a.api.length, sMark = proxy.log.length;
      const s = await snap(a), ck = await A.ctx.cookies();
      (lr && lr.ok && s.login && !s.out && !s.logged && s.doc === before.doc && s.chips === before.chips && s.body === 1 && s.toasts.some(t => /вышел из аккаунта/.test(t)) && !ck.length)
        ? ok('«Ты вышел из аккаунта»: снова «Войти по почте», все записи и «Тело» на месте, /api/logout ok, кука удалена')
        : bad('выход: ' + J({ lr, login: s.login, logged: s.logged, same: s.doc === before.doc, body: s.body, toasts: s.toasts.slice(-2), ck }));
      // правка, возвращение во вкладку, сеть, перезагрузка, проход по вкладкам — ни одного запроса
      await a.click('#todayChips .tchip >> nth=0'); await a.waitForTimeout(2600);
      await a.evaluate(() => { lastSync = 0; dispatchEvent(new Event('online')); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await a.waitForTimeout(1200);
      await a.reload(); await a.waitForTimeout(1600);
      for (const t of ['habits', 'tasks', 'money', 'body', 'shop', 'home']) { await a.click(`.tab[data-t="${t}"]`); await a.waitForTimeout(150); }
      const s2 = await snap(a);
      const leak = srv(sMark).filter(e => !e.headers.cookie || (tok && e.headers.cookie.includes(tok)));
      (a.api.length === mark && !leak.length && s2.login && !s2.logged && s2.acc && JSON.parse(s2.doc).tasks.some(t => t.name === TASK))
        ? ok('после выхода: правка, «online», «focus», возвращение во вкладку, перезагрузка, все вкладки — 0 запросов (браузер и сервер)')
        : bad('после выхода были запросы: ' + J({ browser: a.api.slice(mark), server: leak.map(e => e.path), login: s2.login }));
      errCheck(a, 'A, выход');
    });

    // ───────────── 7. вход закрыт для чужого адреса ─────────────
    await step('7) Вход закрыт: чужой адрес — «Вход пока закрыт», письма нет; ящик поддержки владельца — код уходит', async () => {
      const { ctx, p } = await mk('C');
      await p.goto(URL + '?account'); await p.waitForTimeout(600);
      const n0 = proxy.log.length;
      await p.click('#obLogin'); await p.waitForSelector('#acMail');
      await p.fill('#acMail', STRANGER); await p.click('#acGo');
      await until(p, () => /\S/.test(document.querySelector('#acErr').textContent), null, 10000);
      const v = await p.evaluate(() => ({ err: document.querySelector('#acErr').textContent, code: !!document.querySelector('#acCode'), go: document.querySelector('#acGo').textContent, dis: document.querySelector('#acGo').disabled }));
      const r = srv(n0).find(e => e.path === '/api/code');
      (v.err === 'Вход пока закрыт — открывается позже' && !v.code && !v.dis && r && r.resJson && r.resJson.err === 'closed' && smtp.to(STRANGER).length === 0 && !(await ctx.cookies()).length)
        ? ok(`«${v.err}»: шага кода нет, кнопка снова «${v.go}», письма на чужой адрес нет, куки нет`)
        : bad('закрытый вход: ' + J({ v, res: r && r.resJson, mails: smtp.to(STRANGER).length }));
      const before = smtp.to(SUPPORT).length;
      await p.fill('#acMail', SUPPORT); await p.click('#acGo');
      const step2 = await p.waitForSelector('#acCode', { timeout: 10000 }).then(() => true, () => false);
      const code = await waitCode(smtp, SUPPORT, { kind: 'login', after: before });
      (step2 && code) ? ok('ящик поддержки (SUPPORT из smtp.env) — второй ящик владельца: шаг «Код из письма», письмо с кодом ушло') : bad('SUPPORT: ' + J({ step2, code }));
      await p.click('#acBack');
      errCheck(p, 'закрытый вход');
      await ctx.close();
    });

    // ───────────── 8. рамка Claude и file:// ─────────────
    await step('8) Рамка Claude (и file://): даже с ?account — ни карточки, ни «Войти», ни запроса', async () => {
      const F = await frameServer(APP_DIR);
      try {
        const { ctx, p } = await mk('рамка');
        // обёртка-рамка теста (не приложение) значка не отдаёт: Chrome просит /favicon.ico у неё
        p.allow = (t, u) => u === `http://localhost:${F.framePort}/favicon.ico`;
        await p.goto(F.frameUrl('?account')); await p.waitForTimeout(900);
        const fr = F.appFrame(p);
        if (!fr) throw new Error('кадр приложения не найден');
        const v0 = await fr.evaluate(() => ({ framed: FRAMED, on: ACCOUNT, ob: !!document.querySelector('#obFresh'), obLogin: !!document.querySelector('#obLogin'), flag: localStorage.getItem('magnat_acc_preview') }));
        await startClean(fr);
        await fr.click('#todayChips .tchip'); await p.waitForTimeout(2600);
        const v1 = await fr.evaluate(() => ({ acc: !!document.querySelector('#acc'), bk: !!document.querySelector('#bkSave') && !!document.querySelector('#bkLoad') }));
        (v0.framed && !v0.on && v0.ob && !v0.obLogin && v0.flag === null && !v1.acc && v1.bk && !p.api.length && F.count('/api') === 0 && !(await ctx.cookies()).length)
          ? ok('в рамке: FRAMED, аккаунт выключен, метка не ставится, «Скачать копию» на месте, 0 запросов к /api, 0 кук')
          : bad('рамка: ' + J({ v0, v1, api: p.api, srv: F.count('/api') }));
        errCheck(p, 'рамка');
        const fp = await ctx.newPage(); const fapi = [];
        fp.on('request', r => { if (apiPath(r.url()).startsWith('/api')) fapi.push(r.url()); });
        await fp.goto('file://' + APP_FILE + '?account'); await fp.waitForTimeout(500);
        const vf = await fp.evaluate(() => ({ on: ACCOUNT, obLogin: !!document.querySelector('#obLogin') }));
        (!vf.on && !vf.obLogin && !fapi.length) ? ok('file:// с ?account: аккаунта нет') : bad('file://: ' + J({ vf, fapi }));
        await ctx.close();
      } finally { await F.close(); }
    });

    // ───────────── 9. «Версии» на настоящем сервере ─────────────
    await step('9) «Версии» на B: список — все ревизии с блобом из БД, нынешняя «сейчас»; «Вернуть» первую: записи как тогда, ревизия restore, прежняя голова закреплена', async () => {
      const bb = B.p; await home(bb);
      if (!await settled(bb)) throw new Error('B не синхронизирован перед «Версиями»');
      const b0 = await snap(bb), acct = b0.sync.acct;
      const revs = db(`SELECT rid, rev, reason FROM revisions WHERE account_id='${acct}' AND blob IS NOT NULL ORDER BY at DESC, rowid DESC`);
      await bb.click('#acVer'); await bb.waitForSelector('.verrow', { timeout: 10000 });
      const l = await bb.evaluate(() => [...document.querySelectorAll('.verrow')].map(r => { const b = r.querySelector('button[data-rid]'); return { t: r.innerText.replace(/\s+/g, ' ').trim(), rid: b ? b.dataset.rid : null, now: !!r.querySelector('.vernow') }; }));
      (revs.length >= 2 && l.length === revs.length && l[0].now && l[0].rid === null && l.slice(1).every((x, i) => x.rid === revs[i + 1][0]) && l.every(x => /привыч/.test(x.t) && /с отметками/.test(x.t)))
        ? ok(`список: ${l.length} версий — ровно ревизии с блобом из БД, в том же порядке, нынешняя — «сейчас»: «${l[0].t}»`) : bad('список версий: ' + J({ l, revs }));
      const first = revs[revs.length - 1][0];
      const want = await bb.evaluate((d) => JSON.stringify(docOf(JSON.parse(d))), dbDoc(first));
      const headRid = revs[0][0];
      await bb.click(`.verrow button[data-rid="${first}"]`);                 // «Вернуть записи к версии от …?» → да
      const closed = await until(bb, () => !document.querySelector('.accovl'), null, 5000);
      const set = await settled(bb, 20000);
      const s = await snap(bb);
      const nr = db(`SELECT rid, reason, pin_until FROM revisions WHERE account_id='${acct}' ORDER BY rev DESC LIMIT 1`)[0];
      const pin = db(`SELECT pin_until FROM revisions WHERE rid='${headRid}'`)[0][0];
      (closed && set && s.doc === want && s.body === b0.body && nr[1] === 'restore' && s.sync.rid === nr[0] && pin && pin > Math.floor(Date.now() / 1000) + 80 * 86400 && s.toasts.some(t => /возвращены к версии/.test(t)))
        ? ok('вернули первую версию: записи как тогда, «Тело» не тронуто, на сервере ревизия restore, прежняя голова закреплена на 90 дней')
        : bad('возврат версии: ' + J({ closed, set, same: s.doc === want, body: s.body, nr, pin, rid: s.sync.rid, toasts: s.toasts.slice(-2) }));
      errCheck(bb, 'B, версии');
    });

    // ───────────── 10. удаление аккаунта на B ─────────────
    await step('10) Удаление на B: письмо «Код для удаления», неверный код понятен, верный — в БД ни аккаунта, ни сессий, ни ревизий, надгробие есть, кука снята, записи на телефоне целы', async () => {
      const bb = B.p; await home(bb);
      const before = await snap(bb), acct = before.sync.acct;
      const n0 = smtp.to(OWNER).length, mark = proxy.log.length;
      await bb.click('#acDel'); await bb.waitForSelector('#acDlGo', { timeout: 5000 });
      await bb.click('#acDlGo'); await bb.waitForSelector('#acDlCode', { timeout: 10000 });
      const code = await waitCode(smtp, OWNER, { kind: 'delete', after: n0 });
      if (!code) throw new Error('код удаления не пришёл на ' + OWNER);
      const m = parseMail(smtp.to(OWNER).slice(-1)[0].raw);
      const creq = srv(mark).find(e => e.path === '/api/code');
      (/удален/i.test(m.subject) && creq && creq.json && creq.json.purpose === 'delete' && !('email' in creq.json))
        ? ok(`письмо «${m.subject}»; запрос кода — purpose delete, без адреса`) : bad('код удаления: ' + J({ subject: m.subject, req: creq && creq.json }));
      const bad6 = code.split('').map(d => (+d + 1) % 10).join('');
      await bb.fill('#acDlCode', bad6); await bb.click('#acDlGo');
      await until(bb, () => /\S/.test(document.querySelector('#acErr').textContent), null, 10000);
      const e1 = await bb.evaluate(() => ({ err: document.querySelector('#acErr').textContent, logged: LOGGED(), open: !!document.querySelector('#acDlCode') }));
      (e1.err === 'Код не подходит. Осталось попыток: 4' && e1.logged && e1.open && db(`SELECT COUNT(*) FROM accounts WHERE id='${acct}'`)[0][0] === 1)
        ? ok(`неверный код: «${e1.err}», аккаунт на месте`) : bad('неверный код удаления: ' + J(e1));
      await bb.fill('#acDlCode', code); await bb.click('#acDlGo');
      const gone = await until(bb, () => !LOGGED() && !document.querySelector('.accovl'), null, 10000);
      await bb.waitForTimeout(500);
      const s = await snap(bb), ck = await B.ctx.cookies();
      const rows = { acc: db(`SELECT COUNT(*) FROM accounts WHERE id='${acct}'`)[0][0], ses: db(`SELECT COUNT(*) FROM sessions WHERE account_id='${acct}'`)[0][0],
        rev: db(`SELECT COUNT(*) FROM revisions WHERE account_id='${acct}'`)[0][0], tomb: db('SELECT COUNT(*) FROM deletions')[0][0] };
      (gone && rows.acc === 0 && rows.ses === 0 && rows.rev === 0 && rows.tomb === 1 && !ck.length && s.login && !s.logged && !s.sync && s.doc === before.doc && s.body === before.body && s.toasts.some(t => /Аккаунт удалён/.test(t)))
        ? ok('удалён: в БД 0 аккаунтов, 0 сессий, 0 ревизий, 1 надгробие; кука снята; на телефоне записи и «Тело» целы, «Войти по почте»')
        : bad('после удаления: ' + J({ gone, rows, ck: ck.length, login: s.login, logged: s.logged, sync: s.sync, same: s.doc === before.doc, body: s.body, toasts: s.toasts.slice(-2) }));
      const m2 = bb.api.length, sm2 = proxy.log.length;
      await bb.click('#todayChips .tchip >> nth=0'); await bb.waitForTimeout(2600);
      await bb.evaluate(() => { lastSync = 0; dispatchEvent(new Event('online')); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await bb.waitForTimeout(1200);
      (bb.api.length === m2 && srv(sm2).length === 0) ? ok('дальше — 0 запросов к /api (браузер и сервер)') : bad('после удаления запросы: ' + J({ browser: bb.api.slice(m2), server: srv(sm2).map(e => e.path) }));
      errCheck(bb, 'B, удаление');
    });
  } finally {
    try { await browser.close(); } catch (e) {}
    await cleanup();
  }
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

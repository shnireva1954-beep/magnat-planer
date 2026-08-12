// Финальный заход: то, что ещё не проверялось ни разу
const { chromium, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR } = require('./lib');
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const EXE = chromePath();
const APP = APP_DIR;
const TABS = ['home','habits','tasks','money','body','shop'];
let fails = 0;
const ok = m => console.log('  ✓', m);
const bad = m => { fails++; console.log('  ✗ ПРОВАЛ:', m); };

// Отдаём КОПИЮ приложения во временной папке: тест обновления версии подменяет
// файл, и трогать оригинал в репозитории нельзя ни при каком исходе.
function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magnat-'));
  for (const f of ['index.html', 'sw.js', 'manifest.json', 'icon.png', 'icon-512.png']) {
    const src = path.join(APP, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  return dir;
}
function serve(port, root) {
  const types = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.png':'image/png' };
  return http.createServer((rq, rs) => {
    let f = rq.url.split('?')[0]; if (f === '/') f = '/index.html';
    const p = path.join(root, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(p, (e, d) => {
      if (e) { rs.writeHead(404); rs.end(); return; }
      rs.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'text/plain', 'Cache-Control': 'no-cache' });
      rs.end(d);
    });
  }).listen(port);
}

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });

  // ---------- 1. Обновление версии доезжает до установленного приложения ----------
  console.log('\n1) Новая версия приезжает сама (service worker)');
  {
    const tmp = tempCopy();
    const srv = serve(8911, tmp);
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    await p.goto('http://localhost:8911/'); await p.waitForTimeout(700);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.evaluate(() => navigator.serviceWorker.ready); await p.waitForTimeout(1000);

    // подменяем ВРЕМЕННУЮ копию на «новую версию» — оригинал не трогаем
    const tf = path.join(tmp, 'index.html');
    const orig = fs.readFileSync(tf, 'utf8');
    fs.writeFileSync(tf, orig.replace('<title>Магнат</title>', '<title>Магнат v-НОВАЯ</title>'));
    await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(900);
    const t1 = await p.title();
    fs.writeFileSync(tf, orig);
    await p.reload({ waitUntil: 'load' }); await p.waitForTimeout(900);
    const t2 = await p.title();
    t1.includes('НОВАЯ') ? ok('новая версия подхватывается при первом открытии с сетью')
                         : bad('осталась старая версия: ' + t1);
    t2 === 'Магнат' ? ok('откат версии тоже подхватывается') : bad('после отката: ' + t2);
    await ctx.close(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 2. Перенос на новый телефон: файл копии через настоящий импорт ----------
  console.log('\n2) Копия данных: выгрузка и загрузка настоящим файлом');
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.evaluate(() => {
      S.checks[addDays(TODAY,-1)] = S.habits.slice(0,5).map(h => h.id);
      S.tasks = [{ id: 1, name: 'Сходить к врачу', prio: 'hi', due: TODAY, done: false }];
      S.finance.entries = [{ id: 1, type: 'in', cat: '💼 Работа', amount: 60000, date: TODAY }];
      S.body.log = [{ date: TODAY, w: 69 }]; S.body.goalW = 66;
      S.body.sex='m'; S.body.height=180; S.body.birth=1990;
      S.spent = 150; S.boughtCnt = { 1: 1 };
      save(); render();
    });
    const snapshot = await p.evaluate(() => JSON.stringify(S));
    const dl = await Promise.all([p.waitForEvent('download'), p.click('#bkSave')]);
    const file = await dl[0].path();
    const saved = fs.readFileSync(file, 'utf8');
    saved === snapshot ? ok('файл копии совпадает с данными в приложении') : bad('файл копии отличается');

    // «новый телефон»: чистое хранилище + импорт файла
    const ctx2 = await b.newContext({ viewport: { width: 390, height: 900 } });
    const p2 = await ctx2.newPage(); p2.on('dialog', d => d.accept());
    p2.errs = []; p2.on('pageerror', e => p2.errs.push(e.message));
    await p2.goto(APP_URL); await p2.waitForTimeout(400);
    await p2.click('#obFresh'); await p2.waitForTimeout(400);
    const [chooser] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('#bkLoad')]);
    await chooser.setFiles(file); await p2.waitForTimeout(800);
    const restored = await p2.evaluate(() => JSON.stringify(S));
    restored === snapshot ? ok('на «новом телефоне» данные восстановились один в один')
                          : bad('после восстановления данные отличаются');
    for (const t of TABS) { await p2.click(`.tab[data-t="${t}"]`); await p2.waitForTimeout(200); }
    p2.errs.length ? bad('ошибки после восстановления: ' + p2.errs.join(' | ')) : ok('все экраны после восстановления работают');
    await ctx.close(); await ctx2.close();
  }

  // ---------- 3. Нажать вообще всё, что нажимается ----------
  console.log('\n3) Обход всех кнопок на всех экранах');
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 1600 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
    p.on('dialog', d => d.dismiss());          // на всё отвечаем «нет», чтобы данные уцелели
    // «Восстановить из копии» открывает выбор файла: без обработчика прогон подвиснет
    p.on('filechooser', fc => fc.setFiles([]).catch(() => {}));
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(600);
    let clicks = 0;
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(400);
      const sels = ['.addbtn','.bk','.reset','.share-btn','.hedit2','.ted','.del','.si .rm','.tchip','.prow','.frow','.q','.card[data-go]','.ok2'];
      for (const sel of sels) {
        const n = await p.$$eval(sel, e => e.length).catch(() => 0);
        for (let i = 0; i < Math.min(n, 3); i++) {
          const el = (await p.$$(sel))[i]; if (!el) continue;
          await el.click({ timeout: 2500 }).catch(() => {}); clicks++;
          await p.waitForTimeout(120);
          const ovl = await p.$('.ovl');                     // форму закрываем Escape
          if (ovl) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
          const still = await p.$('.ovl');
          if (still) { await p.evaluate(() => document.querySelectorAll('.ovl').forEach(o => o.remove())); }
          await p.click(`.tab[data-t="${t}"]`).catch(() => {}); await p.waitForTimeout(150);
        }
      }
    }
    const alive = await p.$eval('#wallet', e => e.textContent).catch(() => null);
    errs.length ? bad(`${clicks} нажатий → ошибки: ` + [...new Set(errs)].slice(0,4).join(' | '))
                : ok(`${clicks} нажатий по всем экранам — ни одной ошибки, кошелёк «${alive}»`);
    await ctx.close();
  }

  // ---------- 4. Часовые пояса ----------
  console.log('\n4) Часовые пояса: край земли и Москва');
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Midway', 'Europe/Moscow']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, timezoneId: tz });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const back = addDays(TODAY, -1), fwd = addDays(back, 1);
      let ok30 = true, d = TODAY;
      for (let i = 0; i < 40; i++) { const prev = addDays(d, -1); if (addDays(prev, 1) !== d) ok30 = false; d = prev; }
      return { today: TODAY, roundtrip: fwd === TODAY, chain: ok30, streak: curStreak() };
    });
    (r.roundtrip && r.chain) ? ok(`${tz}: сегодня ${r.today}, даты ходят туда-обратно без сдвига, серия ${r.streak}`)
                             : bad(`${tz}: даты плывут ${JSON.stringify(r)}`);
    if (p.errs.length) bad(tz + ': ' + p.errs.join(' | '));
    await ctx.close();
  }

  // ---------- 5. Режим «меньше движения» ----------
  console.log('\n5) prefers-reduced-motion: приложение полностью работоспособно');
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.click('#todayChips .tchip'); await p.waitForTimeout(300);
    const parts = await p.evaluate(() => document.querySelectorAll('body > i').length);
    for (const t of TABS) { await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(200); }
    (parts === 0 && !p.errs.length) ? ok('анимаций нет, все экраны работают')
                                    : bad('частиц: ' + parts + ' ошибок: ' + p.errs.join(' | '));
    await ctx.close();
  }

  // ---------- 6. Две вкладки одновременно ----------
  console.log('\n6) Приложение открыто в двух вкладках');
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
    const p1 = await ctx.newPage(), p2 = await ctx.newPage();
    [p1, p2].forEach(p => { p.errs = []; p.on('dialog', d => d.accept()); p.on('pageerror', e => p.errs.push(e.message)); });
    await p1.goto(APP_URL); await p1.waitForTimeout(400);
    await p1.click('#obFresh'); await p1.waitForTimeout(400);
    await p2.goto(APP_URL); await p2.waitForTimeout(600);
    await p1.bringToFront(); await p1.click('#todayChips .tchip'); await p1.waitForTimeout(300);
    await p2.bringToFront(); await p2.reload(); await p2.waitForTimeout(600);
    const w2 = await p2.$eval('#wallet', e => e.textContent);
    (w2 === '20' && !p1.errs.length && !p2.errs.length)
      ? ok('вторая вкладка после перезагрузки видит отметку первой: ' + w2)
      : bad(`кошелёк во второй вкладке «${w2}» (ожидали 20) ` + p1.errs.concat(p2.errs).join(' | '));
    await ctx.close();
  }

  // ---------- 7. Долгая жизнь: 300 перерисовок подряд ----------
  console.log('\n7) Триста перерисовок подряд — не течёт ли');
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const n0 = document.getElementsByTagName('*').length;
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) render();
      const t1 = performance.now();
      return { n0, n1: document.getElementsByTagName('*').length, ms: Math.round((t1 - t0) / 300 * 10) / 10 };
    });
    (Math.abs(r.n1 - r.n0) <= 2 && !p.errs.length)
      ? ok(`узлов в DOM ${r.n0} → ${r.n1}, средняя перерисовка ${r.ms} мс`)
      : bad(`узлы растут: ${r.n0} → ${r.n1} ` + p.errs.join(' | '));
    await ctx.close();
  }

  await b.close();
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

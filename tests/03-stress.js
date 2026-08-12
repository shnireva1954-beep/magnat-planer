const { chromium, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR } = require('./lib');
const EXE = chromePath();
const URL = APP_URL;
const TABS = ['home','habits','tasks','money','body','shop'];
const say = (...a) => console.log(' ', ...a);
let fails = 0;
const bad = m => { fails++; console.log('  ✗ ПРОВАЛ:', m); };

async function fresh(b, vp, demo) {
  const ctx = await b.newContext({ viewport: vp || { width: 390, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', e => p.errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') p.errs.push('CONSOLE ' + m.text()); });
  p.on('dialog', d => d.accept());
  await p.goto(URL); await p.waitForTimeout(400);
  await p.click(demo ? '#obDemo' : '#obFresh'); await p.waitForTimeout(500);
  return { ctx, p };
}
const kill = async p => { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(200); } };

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });

  console.log('\n— M. Телефон в альбомной ориентации (844×390)');
  { const { ctx, p } = await fresh(b, { width: 844, height: 390 }, true);
    let worst = 0;
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(400);
      const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (o > worst) worst = o;
    }
    say('горизонтальный скролл:', worst || 'нет', '· ошибок:', p.errs.length || 'нет');
    // форма в альбомной
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(300);
    await p.click('#addW'); await p.waitForTimeout(300);
    const okv = await p.evaluate(() => { const o=document.querySelector('.ovl'); o.scrollTop=o.scrollHeight;
      const r=document.querySelector('.modal .ok').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight+1; });
    say('кнопка «Готово» достижима в альбомной:', okv);
    await ctx.close(); }

  console.log('\n— N. Совсем узкие экраны (маленький телефон, крупный шрифт)');
  // Настоящий зум браузера меняет и медиазапросы, а CSS-свойство zoom — нет,
  // поэтому вместо подделки зума проверяем реально узкие ширины.
  for (const w of [280, 320, 360]) {
    const { ctx, p } = await fresh(b, { width: w, height: 1400 }, true);
    let worst = 0;
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(400);
      const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (o > worst) worst = o;
    }
    worst ? bad(`${w}px: горизонтальный скролл ${worst}px`)
          : say(`${w}px: горизонтального скролла нет · ошибок: ${p.errs.length || 'нет'}`);
    await ctx.close();
  }

  console.log('\n— O. Быстрые повторные касания привычки');
  { const { ctx, p } = await fresh(b);
    for (let i = 0; i < 6; i++) { await p.click('#todayChips .tchip'); await p.waitForTimeout(60); }
    await p.waitForTimeout(600);
    const r = await p.evaluate(() => ({ checks: checksOf(TODAY).length, wallet: wallet(), dup: JSON.stringify(S.checks[TODAY]||[]) }));
    say('после 6 быстрых касаний:', JSON.stringify(r), '· ошибок:', p.errs.length || 'нет');
    await ctx.close(); }

  console.log('\n— P. Хранилище переполнено');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
      let crashed = false;
      try { S.tasks.push({ id: 1, name: 'Тест', prio: 'md', due: TODAY, done: false }); save(); render(); }
      catch (e) { crashed = true; }
      const t = document.getElementById('toast');
      const msg = t.classList.contains('show') ? t.textContent : '(тихо)';
      Storage.prototype.setItem = orig;
      return { crashed, msg, alive: !!document.querySelector('#v-home').innerHTML.length };
    });
    say('упало:', r.crashed, '· сообщение:', r.msg, '· приложение живо:', r.alive);
    await ctx.close(); }

  console.log('\n— Q. Покупка награды: подтверждение и отказ');
  { const ctx = await b.newContext({ viewport: { width: 390, height: 1200 } });
    const p = await ctx.newPage();
    const asked = [];
    p.on('dialog', d => { asked.push(d.message()); d.dismiss(); });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(600);
    await kill(p);
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(500);
    const before = await p.evaluate(() => wallet());
    await p.click('#shopGrid .si .i'); await p.waitForTimeout(400);
    const after = await p.evaluate(() => wallet());
    say('спросили:', JSON.stringify(asked), '· монеты после отказа целы:', before === after);
    await ctx.close(); }

  console.log('\n— R. Тридцать привычек и двести операций');
  { const { ctx, p } = await fresh(b, { width: 390, height: 1200 });
    const r = await p.evaluate(() => {
      S.habits = []; for (let i = 1; i <= 30; i++) S.habits.push({ id: i, ico: '⭐', name: 'Привычка номер ' + i, since: '' });
      S.checks = {}; for (let k = 1; k <= 60; k++) S.checks[addDays(TODAY, -k)] = S.habits.slice(0, 20).map(h => h.id);
      S.finance.entries = []; for (let i = 1; i <= 200; i++)
        S.finance.entries.push({ id: i, type: i % 3 ? 'out' : 'in', cat: '🍔 Еда', amount: 100 + i, date: TODAY });
      save();
      const t0 = performance.now(); render(); return { ms: Math.round(performance.now() - t0) };
    });
    await kill(p);
    say('рендер с 30 привычками:', r.ms + ' мс');
    let worst = 0;
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(500);
      const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (o > worst) worst = o;
    }
    say('горизонтальный скролл:', worst || 'нет', '· ошибок:', p.errs.length || 'нет');
    await ctx.close(); }

  console.log('\n— S. Вес и цель вне разумных границ');
  { const ctx = await b.newContext({ viewport: { width: 390, height: 1000 } });
    const p = await ctx.newPage(); p.on('dialog', d => d.accept());
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(300);
    await p.click('#addW'); await p.waitForTimeout(250);
    await p.fill('.modal input', '7'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    const n1 = await p.evaluate(() => S.body.log.length);
    say('вес 7 кг записан:', n1 > 0, '(должно быть false)');
    await p.fill('.modal input', '78'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    say('вес 78 кг записан:', await p.evaluate(() => S.body.log.length) === 1);
    await ctx.close(); }

  console.log('\n— T. Награда с пустым названием и один эмодзи');
  { const { ctx, p } = await fresh(b);
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(400);
    const n0 = await p.evaluate(() => S.rewards.length);
    await p.click('#addReward'); await p.waitForTimeout(300);
    await p.click('.modal .ok'); await p.waitForTimeout(400);           // пусто
    const n1 = await p.evaluate(() => S.rewards.length);
    await p.click('#addReward'); await p.waitForTimeout(300);
    await p.fill('.modal input', '🎣'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    const last = await p.evaluate(() => S.rewards[S.rewards.length - 1]);
    say('пустое название не создаёт награду:', n1 === n0, '· один эмодзи →', JSON.stringify(last && { ico: last.ico, name: last.name }));
    say('ошибок:', p.errs.length || 'нет');
    await ctx.close(); }

  await b.close();
  if (fails) process.exit(1);
})();

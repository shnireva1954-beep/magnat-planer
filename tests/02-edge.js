const { chromium, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR } = require('./lib');
const EXE = chromePath();
const URL = APP_URL;
const TABS = ['home','habits','tasks','money','body','shop'];
const say = (...a) => console.log(' ', ...a);

async function fresh(b, vp) {
  const ctx = await b.newContext({ viewport: vp || { width: 390, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', e => p.errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') p.errs.push('CONSOLE ' + m.text()); });
  p.on('dialog', d => d.accept());
  await p.goto(URL); await p.waitForTimeout(400);
  const f = await p.$('#obFresh'); if (f) { await f.click(); await p.waitForTimeout(400); }
  return { ctx, p };
}
const kill = async p => { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(200); } };

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });

  console.log('\n— A. Удалил все награды → возвращаются после перезагрузки?');
  { const { ctx, p } = await fresh(b);
    await p.evaluate(() => { S.rewards = []; save(); });
    await p.reload(); await p.waitForTimeout(500);
    say('наград после перезагрузки:', await p.evaluate(() => S.rewards.length), '(ожидание: 0)');
    await ctx.close(); }

  console.log('\n— B. Одна-две привычки: возможна ли вообще серия?');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      S.habits = [{ id: 1, ico: '🏃', name: 'Бег' }]; S.checks = {};
      for (let k = 0; k < 10; k++) S.checks[addDays(TODAY, -k)] = [1];
      save(); render();
      return { streak: curStreak(), mult: mult(curStreak()), dayok: DAYOK, xp: totalXP() };
    });
    say('10 дней подряд с одной привычкой → серия', r.streak, '· множитель', r.mult, '· опыт', r.xp);
    await ctx.close(); }

  console.log('\n— C. Инсайт про «слабый день» у новичка (данные всего за 3 дня)');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      S.checks = {};
      for (let k = 0; k < 8; k++) S.checks[addDays(TODAY, -k)] = S.habits.map(h => h.id);  // всё выполнено!
      save(); render();
      return homeInsight();
    });
    say('инсайт при 100% выполнении за 8 дней:', JSON.stringify(r));
    await ctx.close(); }

  console.log('\n— D. Модалка при маленькой высоте экрана (клавиатура открыта)');
  { const { ctx, p } = await fresh(b, { width: 390, height: 380 });
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(300);
    await p.click('#addW'); await p.waitForTimeout(250);
    await p.fill('.modal input', '80'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    await p.click('#editProf'); await p.waitForTimeout(400);
    const r = await p.evaluate(() => {
      const m = document.querySelector('.modal'), o = document.querySelector('.ovl');
      const mr = m.getBoundingClientRect(), or_ = o.getBoundingClientRect();
      const okBtn = m.querySelector('.ok').getBoundingClientRect();
      return { modalH: Math.round(mr.height), viewH: Math.round(or_.height),
               okVisible: okBtn.bottom <= innerHeight + 1 && okBtn.top >= 0,
               ovlScrollable: getComputedStyle(o).overflowY, canScroll: o.scrollHeight > o.clientHeight };
    });
    say('высота модалки', r.modalH, 'при экране', r.viewH, '· кнопка «Готово» видна:', r.okVisible,
        '· overflow оверлея:', r.ovlScrollable, '· можно прокрутить:', r.canScroll);
    await ctx.close(); }

  console.log('\n— E. Размер целей для пальца (минимум по гайдлайнам ~44px)');
  { const { ctx, p } = await fresh(b);
    await p.evaluate(() => {
      S.tasks = [{ id: 1, name: 'Задача', prio: 'md', due: TODAY, done: false }];
      S.finance.entries = [{ id: 1, type: 'out', cat: '🍔 Еда', amount: 500, date: TODAY }];
      save(); render();
    });
    for (const [tab, sel, nm] of [['tasks','.q .del','крестик задачи'], ['tasks','.q .ted','карандаш задачи'],
                                  ['money','.frow .del','крестик операции'], ['shop','.si .rm','карандаш награды']]) {
      await p.click(`.tab[data-t="${tab}"]`); await p.waitForTimeout(300);
      const sz = await p.$eval(sel, e => { const r = e.getBoundingClientRect(); return Math.round(r.width) + '×' + Math.round(r.height); });
      say(nm.padEnd(20), sz);
    }
    await ctx.close(); }

  console.log('\n— F. Деньги удаляются только с подтверждением');
  { const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctx.newPage();
    const asked = [];
    p.on('dialog', d => { asked.push(d.message()); d.dismiss(); });   // на всё отвечаем «нет»
    await p.goto(APP_URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.evaluate(() => {
      S.finance.entries = [{ id: 1, type: 'in', cat: '💼 Работа', amount: 60000, date: TODAY }];
      S.tasks = [{ id: 1, name: 'Важная задача', prio: 'hi', due: TODAY, done: false }]; save(); render();
    });
    await p.click('.tab[data-t="money"]'); await p.waitForTimeout(300);
    await p.click('.frow .del'); await p.waitForTimeout(400);
    const keptMoney = await p.evaluate(() => S.finance.entries.length) === 1;
    say('спросили перед удалением операции:', JSON.stringify(asked), '· после отказа операция на месте:', keptMoney);
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(400);
    const wBefore = await p.evaluate(() => wallet());
    await p.click('#shopGrid .si .i').catch(() => {}); await p.waitForTimeout(400);
    say('покупка награды тоже спрашивает · монеты после отказа целы:',
        wBefore === await p.evaluate(() => wallet()));
    say('задачи удаляются сразу, без вопроса — так задумано, цена ошибки мала');
    await ctx.close(); }

  console.log('\n— G. Очень длинные названия');
  { const { ctx, p } = await fresh(b, { width: 320, height: 1600 });
    await p.evaluate(() => {
      const long = 'Очень длинное название привычки которое точно не поместится ни в одну колонку';
      S.habits = [{ id: 1, ico: '🏋️', name: long }, { id: 2, ico: '', name: long.toUpperCase() }];
      S.tasks = [{ id: 1, name: long, prio: 'hi', due: TODAY, done: false }];
      S.rewards = [{ id: 1, ico: '🎁', name: long, days: 7, cost: 1000 }];
      S.finance.entries = [{ id: 1, type: 'out', cat: '🍔 ' + long, amount: 1234567, date: TODAY }];
      save(); render();
    });
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(400);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over) say('!! горизонтальный скролл на', t, over + 'px');
    }
    say('длинные названия — проверено, ошибок:', p.errs.length || 'нет');
    await ctx.close(); }

  console.log('\n— H. Картинка «Поделиться империей»');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => new Promise(res => {
      const origCreate = document.createElement.bind(document);
      let clicked = false;
      document.createElement = tag => { const e = origCreate(tag); if (tag === 'a') e.click = () => { clicked = true; }; return e; };
      try { shareCard(); } catch (e) { return res('ИСКЛЮЧЕНИЕ: ' + e.message); }
      setTimeout(() => res(clicked ? 'картинка собрана и отдана на скачивание' : 'НИЧЕГО НЕ ПРОИЗОШЛО'), 1500);
    }));
    say(r); say('ошибок:', p.errs.length ? p.errs : 'нет');
    await ctx.close(); }

  console.log('\n— I. Два года истории: не тормозит ли');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      S.checks = {};
      for (let k = 1; k <= 730; k++) S.checks[addDays(TODAY, -k)] = S.habits.map(h => h.id);
      save();
      const t0 = performance.now(); render(); const t1 = performance.now();
      return { ms: Math.round(t1 - t0), xp: totalXP(), streak: curStreak() };
    });
    await kill(p);
    say('рендер «Обзора» с 730 днями:', r.ms + ' мс · опыт', r.xp, '· серия', r.streak);
    const t2 = await p.evaluate(() => { const a = performance.now(); render(); return Math.round(performance.now() - a); });
    say('повторный рендер:', t2 + ' мс');
    await ctx.close(); }

  console.log('\n— J. Экспорт → импорт: данные совпадают?');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      S.tasks = [{ id: 7, name: 'Проверка', prio: 'lo', due: TODAY, done: true }];
      S.checks[addDays(TODAY, -1)] = [1, 2, 3];
      S.body.log = [{ date: TODAY, w: 81.4 }]; S.body.height = 180; S.body.birth = 1990; S.body.sex = 'm';
      S.spent = 300; S.boughtCnt = { 1: 2 };
      save();
      const dump = JSON.stringify(S);
      const back = normalize(JSON.parse(dump));
      return { same: JSON.stringify(back) === dump, before: dump.length, after: JSON.stringify(back).length };
    });
    say('копия переживает круг экспорт→импорт без изменений:', r.same, `(${r.before} → ${r.after} байт)`);
    await ctx.close(); }

  console.log('\n— K. Смена месяца: что видно 1-го числа');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      // данные за прошлый месяц
      const prev = addDays(TODAY.slice(0, 8) + '01', -5);
      S.checks[prev] = S.habits.map(h => h.id);
      S.finance.entries = [{ id: 1, type: 'out', cat: '🍔 Еда', amount: 5000, date: prev }];
      save();
      return { prev, видноВФинансах: monthEntries().length, вОпыте: totalXP() > 0 };
    });
    say('операция за', r.prev, '→ видна в «Финансах»:', r.видноВФинансах > 0, '· в опыте учтена:', r.вОпыте);
    await ctx.close(); }

  console.log('\n— L. Максимальный уровень');
  { const { ctx, p } = await fresh(b);
    const r = await p.evaluate(() => {
      S.checks = {}; for (let k = 1; k <= 200; k++) S.checks[addDays(TODAY, -k)] = S.habits.map(h => h.id);
      save(); render();
      const bar = document.querySelector('.bar-m').textContent.replace(/\s+/g, ' ').trim();
      return { xp: totalXP(), lvl: levelIdx(totalXP()), bar };
    });
    await kill(p);
    say('на максимуме:', r.xp, 'опыта, уровень', r.lvl + 1, '→ «' + r.bar + '»');
    await ctx.close(); }

  await b.close();
})();

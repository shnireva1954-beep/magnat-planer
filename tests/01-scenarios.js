const { chromium, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR } = require('./lib');
const EXE = chromePath();
const URL = APP_URL;
const OUT = OUT_DIR;
const TABS = ['home','habits','tasks','money','body','shop'];
let fails = 0;
const ok  = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };

async function newPage(b, vp) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', e => p.errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') p.errs.push('CONSOLE: ' + m.text()); });
  p.on('dialog', d => d.accept());
  return { ctx, p };
}
const errCheck = (p, label) => { if (p.errs.length) bad(label + ' → ' + p.errs.join(' | ')); else ok(label + ' — без ошибок'); p.errs = []; };

async function walkTabs(p, label) {
  for (const t of TABS) {
    await p.click(`.tab[data-t="${t}"]`);
    await p.waitForTimeout(250);
    const html = await p.$eval(`#v-${t}`, e => e.innerHTML.length);
    if (html < 50) bad(`${label}: вкладка ${t} пустая`);
  }
  errCheck(p, label);
  await p.click('.tab[data-t="home"]'); await p.waitForTimeout(200);
}

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });

  // ---------- 1. чистый лист ----------
  console.log('\n1) Онбординг → «Начать своё» (пустое состояние)');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await walkTabs(p, 'чистый лист');
    const wallet = await p.$eval('#wallet', e => e.textContent);
    if (wallet !== '0') bad('кошелёк на чистом листе = ' + wallet); else ok('кошелёк 0');
    // удалить все привычки → пустые состояния
    await p.evaluate(() => { S.habits = []; S.checks = {}; save(); render(); });
    await p.waitForTimeout(200);
    await walkTabs(p, 'без единой привычки');
    await ctx.close();
  }

  // ---------- 2. демо ----------
  console.log('\n2) Онбординг → «Посмотреть пример» (демо-данные)');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(400);
    await walkTabs(p, 'демо');

    // полоски «Топ привычек» должны иметь ненулевую ширину
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(400);
    const fillW = await p.$$eval('.pfill', els => els.map(e => e.getBoundingClientRect().width));
    if (!fillW.length || fillW.every(w => w < 1)) bad('.pfill не рисуется: ' + JSON.stringify(fillW));
    else ok('полоски «Топ привычек» рисуются: ' + fillW.map(w => Math.round(w)).join(','));

    // календарь должен показывать сегодня, а не будущие дни
    const cal = await p.evaluate(() => {
      const hs = document.querySelector('.hscroll'), td = document.querySelector('th.tdy');
      const r1 = hs.getBoundingClientRect(), r2 = td.getBoundingClientRect();
      const nameW = document.querySelector('th.name').getBoundingClientRect().width;
      return { visible: r2.left >= r1.left + nameW - 2 && r2.right <= r1.right + 2 };
    });
    cal.visible ? ok('«сегодня» видно в календаре (не под липким столбцом)')
                : bad('колонка «сегодня» не видна в календаре');

    // галочки в календаре реально отрисованы
    const onCells = await p.$$eval('.hcell.on', els => els.length);
    onCells > 0 ? ok('в календаре ' + onCells + ' отмеченных клеток') : bad('в календаре нет отметок');

    await ctx.close();
  }

  // ---------- 3. взаимодействия ----------
  console.log('\n3) Реальные действия пользователя');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);

    // отметить привычку чипом на Обзоре
    const w0 = await p.$eval('#wallet', e => e.textContent);
    await p.click('#todayChips .tchip'); await p.waitForTimeout(350);
    const w1 = await p.$eval('#wallet', e => e.textContent);
    w1 !== w0 ? ok(`чип привычки: кошелёк ${w0} → ${w1}`) : bad('чип привычки не начислил монеты');
    // снять обратно
    await p.click('#todayChips .tchip'); await p.waitForTimeout(300);
    const w2 = await p.$eval('#wallet', e => e.textContent);
    w2 === w0 ? ok('снятие галочки возвращает кошелёк') : bad(`снятие: ${w2} ≠ ${w0}`);

    // клетка календаря
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(300);
    await p.evaluate(() => document.querySelector('.hcell:not(.fut)').click());
    await p.waitForTimeout(300);
    const marked = await p.$$eval('.hcell.on', e => e.length);
    marked === 1 ? ok('клетка календаря отмечается') : bad('клетка календаря: отмечено ' + marked);

    // задача
    await p.click('.tab[data-t="tasks"]'); await p.waitForTimeout(250);
    await p.click('#addTask'); await p.waitForTimeout(250);
    await p.fill('.modal input[type=text]', 'Тестовая задача');
    await p.click('.modal .ok'); await p.waitForTimeout(300);
    let nTasks = await p.evaluate(() => S.tasks.length);
    nTasks === 1 ? ok('задача добавлена') : bad('задач после добавления: ' + nTasks);
    await p.click('.q .box'); await p.waitForTimeout(300);   // отметить выполненной
    const doneT = await p.evaluate(() => S.tasks[0].done);
    doneT ? ok('задача отмечается выполненной') : bad('задача не отмечается');
    await p.click('.q .del'); await p.waitForTimeout(300);
    nTasks = await p.evaluate(() => S.tasks.length);
    nTasks === 0 ? ok('задача удаляется') : bad('задача не удалилась');

    // финансы: доход и расход, дробное и отрицательное
    await p.click('.tab[data-t="money"]'); await p.waitForTimeout(250);
    await p.click('#addIn'); await p.waitForTimeout(250);
    await p.fill('.modal input.amt-in', '60000.75');
    await p.click('.modal .ok'); await p.waitForTimeout(350);
    await p.click('#addOut'); await p.waitForTimeout(250);
    await p.fill('.modal input.amt-in', '-2500');
    await p.click('.modal .ok'); await p.waitForTimeout(350);
    const fin = await p.evaluate(() => S.finance.entries.map(e => [e.type, e.amount]));
    JSON.stringify(fin) === JSON.stringify([['in',60001],['out',2500]])
      ? ok('суммы: дробь округляется, минус превращается в плюс ' + JSON.stringify(fin))
      : bad('суммы записаны неверно: ' + JSON.stringify(fin));
    // ноль не должен добавляться
    await p.click('#addOut'); await p.waitForTimeout(250);
    await p.fill('.modal input.amt-in', '0');
    await p.click('.modal .ok'); await p.waitForTimeout(300);
    const stillOpen = await p.$('.ovl');
    stillOpen ? ok('нулевая сумма не проходит') : bad('нулевая сумма записалась');
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    await p.click('.frow .del'); await p.waitForTimeout(350);
    const finN = await p.evaluate(() => S.finance.entries.length);
    finN === 1 ? ok('операция удаляется') : bad('операций после удаления: ' + finN);

    // тело
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(250);
    await p.click('#addW'); await p.waitForTimeout(250);
    await p.fill('.modal input', '82,4');
    await p.click('.modal .ok'); await p.waitForTimeout(350);
    const bodyLog = await p.evaluate(() => S.body.log);
    bodyLog.length === 1 && bodyLog[0].w === 82.4
      ? ok('вес пишется, запятая понимается: ' + bodyLog[0].w)
      : bad('вес записан неверно: ' + JSON.stringify(bodyLog));
    // второй раз за тот же день — перезапись, не дубль
    await p.click('#addW'); await p.waitForTimeout(250);
    await p.fill('.modal input', '82.1');
    await p.click('.modal .ok'); await p.waitForTimeout(350);
    const bodyLog2 = await p.evaluate(() => S.body.log);
    bodyLog2.length === 1 && bodyLog2[0].w === 82.1
      ? ok('повторная запись за день перезаписывает') : bad('дубль записи веса: ' + JSON.stringify(bodyLog2));

    // награды
    await p.evaluate(() => { S.spent = 0; for (let k = 1; k < 20; k++) S.checks[addDays(TODAY,-k)] = S.habits.map(h => h.id); save(); render(); });
    // прыжок XP поднимает уровень — сначала закрываем окно празднования
    const cel = await p.$('.ovl .ok'); if (cel) { await cel.click(); await p.waitForTimeout(300); ok('окно нового уровня закрывается'); }
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(300);
    const before = await p.evaluate(() => wallet());
    const cost0 = await p.evaluate(() => S.rewards[0].cost);
    await p.click('#shopGrid .si .i'); await p.waitForTimeout(350);
    const after = await p.evaluate(() => wallet());
    after === before - cost0 ? ok(`награда покупается: ${before} → ${after} (−${cost0})`) : bad(`покупка: ${before} → ${after}`);
    const nR0 = await p.evaluate(() => S.rewards.length);
    await p.click('#addReward'); await p.waitForTimeout(250);
    await p.fill('.modal input[type=text]', '🎣 Рыбалка');
    await p.click('.modal .ok'); await p.waitForTimeout(350);
    const myR = await p.evaluate(() => S.rewards.length);
    myR === nR0 + 1 ? ok('своя награда добавляется') : bad('наград: ' + myR);

    errCheck(p, 'сценарии действий');

    // данные переживают перезагрузку
    await p.reload(); await p.waitForTimeout(500);
    const after2 = await p.evaluate(() => ({ t: S.tasks.length, f: S.finance.entries.length, b: S.body.log.length, r: S.rewards.length }));
    JSON.stringify(after2) === JSON.stringify({ t: 0, f: 1, b: 1, r: 7 })
      ? ok('данные пережили перезагрузку') : bad('после перезагрузки: ' + JSON.stringify(after2));
    errCheck(p, 'после перезагрузки');
    await ctx.close();
  }

  // ---------- 4. битые данные ----------
  console.log('\n4) Битые/старые данные в localStorage');
  const broken = {
    'нет finance/body/spent': '{"habits":[{"id":1,"ico":"🏋️","name":"Зал","coin":20}],"checks":{}}',
    'мусор в полях':          '{"habits":"нет","checks":null,"tasks":[{"name":123}],"finance":{"entries":[{"amount":"пять"}]},"body":{"log":[{"date":"кривая","w":"x"}]},"spent":"много"}',
    'совсем не тот json':     '{"foo":1}',
    'битая строка':           '{не json',
    'чужие id в checks':      '{"habits":[{"id":1,"name":"A","coin":10}],"checks":{"2026-08-10":[1,99,"x"]},"spent":-500}',
  };
  for (const [name, raw] of Object.entries(broken)) {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL);
    await p.evaluate(v => localStorage.setItem('magnat_app_v2', v), raw);
    await p.reload(); await p.waitForTimeout(500);
    const dlg = await p.$('#obFresh'); if (dlg) await p.click('#obFresh');
    await p.waitForTimeout(300);
    for (const t of TABS) { await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(150); }
    const alive = await p.$eval('#wallet', e => e.textContent);
    const rescued = await p.$('#rsSave');
    if (p.errs.length || rescued) bad(`${name}: ${rescued ? 'экран спасения' : ''} ${p.errs.join(' | ')}`);
    else ok(`${name}: приложение работает, кошелёк «${alive}»`);
    p.errs = [];
    await ctx.close();
  }

  // ---------- 5. смена суток ----------
  console.log('\n5) Переход через полночь');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    const res = await p.evaluate(() => {
      const before = TODAY;
      const RealDate = Date, fake = new RealDate(RealDate.now() + 24 * 3600 * 1000);
      // подменяем «сейчас» на завтра и просим приложение пересчитать дату
      window.Date = class extends RealDate {
        constructor(...a) { return a.length ? new RealDate(...a) : fake; }
        static now() { return fake.getTime(); }
      };
      const changed = refreshToday();
      const after = TODAY;
      window.Date = RealDate;
      return { before, after, changed };
    });
    res.changed && res.after === addDaysNode(res.before)
      ? ok(`дата пересчитывается: ${res.before} → ${res.after}`)
      : bad('дата не пересчиталась: ' + JSON.stringify(res));
    errCheck(p, 'смена суток');
    await ctx.close();
  }

  // ---------- 6. вёрстка ----------
  console.log('\n6) Вёрстка на телефоне и десктопе');
  for (const [nm, vp] of [['мобайл 390', { width: 390, height: 2400 }], ['узкий 320', { width: 320, height: 2400 }], ['десктоп 1280', { width: 1280, height: 2000 }]]) {
    const { ctx, p } = await newPage(b, vp);
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(400);
    let worst = 0;
    for (const t of TABS) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(400);
      const hs = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (hs > worst) worst = hs;
      if (nm === 'мобайл 390') {
        const h = await p.evaluate(() => Math.min(2400, document.body.scrollHeight));
        await p.screenshot({ path: `${OUT}/fix-${t}.png`, clip: { x: 0, y: 0, width: 390, height: h } });
      }
    }
    worst === 0 ? ok(`${nm}: горизонтального скролла нет`) : bad(`${nm}: h-scroll ${worst}px`);
    errCheck(p, nm);
    await ctx.close();
  }

  // ---------- 7. нормы калорий и воды ----------
  console.log('\n7) Нормы калорий и воды считаются сами');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 1400 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(300);

    // без веса — сначала просят вес
    (await p.$('#addW')) ? ok('без веса зовут записать вес') : bad('нет приглашения записать вес');
    await p.click('#addW'); await p.waitForTimeout(250);
    await p.fill('.modal input', '80'); await p.click('.modal .ok'); await p.waitForTimeout(400);

    // вес есть, профиля нет — предлагают заполнить
    const prompt = await p.$eval('#v-body', e => e.textContent.includes('Заполнить профиль'));
    prompt ? ok('без профиля предлагают его заполнить') : bad('нет приглашения заполнить профиль');

    // заполняем профиль
    await p.click('#editProf'); await p.waitForTimeout(300);
    const inputs = await p.$$('.modal input');
    await inputs[0].fill('180'); await inputs[1].fill('1990');
    await p.click('.modal .ok'); await p.waitForTimeout(400);

    // Миффлин — Сан Жеор вручную: 10*80 + 6.25*180 - 5*36 + 5 = 1750 (муж, 2026-1990=36)
    // цель = 80-3 = 77 → дефицит 15%; активность без тренировок = 1.2
    const got = await p.evaluate(() => ({ n: norms(), cal: calGoalNow(), water: waterGoalNow(), goal: S.body.goalW }));
    const expBmr = 10*80 + 6.25*180 - 5*36 + 5;
    const expCal = Math.round(expBmr*1.2*0.85/10)*10;
    got.n.bmr === Math.round(expBmr/10)*10 ? ok('основной обмен ' + got.n.bmr + ' ккал — формула сходится')
                                           : bad(`обмен ${got.n.bmr}, ожидали ${Math.round(expBmr/10)*10}`);
    got.cal === expCal ? ok(`норма калорий ${got.cal} (дефицит на цель ${got.goal} кг)`)
                       : bad(`калории ${got.cal}, ожидали ${expCal}`);
    got.water === 2400 ? ok('норма воды 2400 мл = 30 мл на кг') : bad('вода ' + got.water);
    // отметили тренировку сегодня — воды должно стать на 0,5 л больше
    await p.evaluate(() => { const h = S.habits.find(x => /трениров/i.test(x.name)).id;
      S.checks[TODAY] = [h]; save(); render(); });
    await p.waitForTimeout(350);
    { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(250); } }
    const wTr = await p.evaluate(() => waterGoalNow());
    wTr === 2900 ? ok('в день тренировки норма воды +0,5 л → ' + wTr) : bad('вода в день тренировки: ' + wTr);
    await p.evaluate(() => { delete S.checks[TODAY]; save(); render(); });
    await p.waitForTimeout(300);

    // активность подтягивается из реальных тренировок
    await p.evaluate(() => {
      const wh = S.habits.find(h => /трениров/i.test(h.name)).id;
      for (let k = 0; k < 28; k += 1) if (k % 2 === 0) S.checks[addDays(TODAY, -k)] = [wh];
      save(); render();
    });
    await p.waitForTimeout(400);
    { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(300); } }  // окно нового уровня
    const act = await p.evaluate(() => norms());
    act.f > 1.2 ? ok(`активность выросла до ${act.f} (${act.perWeek} тренировок в неделю по отметкам)`)
                : bad('активность не отреагировала на тренировки: ' + act.f);

    // норма следует за весом
    const calBefore = await p.evaluate(() => calGoalNow());
    await p.evaluate(() => { logWeight(90); save(); render(); });
    await p.waitForTimeout(300);
    { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(300); } }
    const calAfter = await p.evaluate(() => calGoalNow());
    calAfter > calBefore ? ok(`норма пересчиталась при смене веса: ${calBefore} → ${calAfter}`)
                         : bad(`норма не изменилась: ${calBefore} → ${calAfter}`);

    // ручное значение и возврат к авто
    await p.click('#editCal'); await p.waitForTimeout(300);
    await p.fill('.modal input', '2000'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    let man = await p.evaluate(() => ({ v: calGoalNow(), m: S.body.calManual }));
    (man.v === 2000 && man.m) ? ok('ручное значение принимается') : bad('ручное: ' + JSON.stringify(man));
    await p.click('#editCal'); await p.waitForTimeout(300);
    await p.fill('.modal input', ''); await p.click('.modal .ok'); await p.waitForTimeout(400);
    man = await p.evaluate(() => ({ v: calGoalNow(), m: S.body.calManual }));
    (!man.m && man.v === calAfter) ? ok('пустое поле возвращает автоматический расчёт') : bad('возврат к авто: ' + JSON.stringify(man));

    // мусор в профиле не проходит
    await p.click('#editProf'); await p.waitForTimeout(300);
    const i2 = await p.$$('.modal input');
    await i2[0].fill('12'); await p.click('.modal .ok'); await p.waitForTimeout(300);
    const h = await p.evaluate(() => S.body.height);
    h === 180 ? ok('нелепый рост отклоняется') : bad('рост стал ' + h);
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);

    errCheck(p, 'нормы');
    await ctx.close();
  }

  // ---------- 8. монеты, эмодзи и награды ----------
  console.log('\n8) Монеты без ценника, эмодзи снимается, награды правятся');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 1600 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(400);

    // при добавлении привычки цену не спрашивают
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(300);
    await p.click('#addHabit'); await p.waitForTimeout(300);
    let nIn = await p.$$eval('.modal input, .modal select', e => e.length);
    nIn === 1 ? ok('у новой привычки спрашивают только название') : bad('полей в форме привычки: ' + nIn);
    await p.fill('.modal input', 'Бег 5 км');   // намеренно без эмодзи
    await p.click('.modal .ok'); await p.waitForTimeout(400);
    let h = await p.evaluate(() => S.habits[S.habits.length - 1]);
    (h.ico === '' && h.name === 'Бег 5 км' && h.coin === undefined)
      ? ok('привычка без эмодзи и без ценника: ' + JSON.stringify(h))
      : bad('привычка: ' + JSON.stringify(h));

    // все привычки стоят одинаково
    const perOne = await p.evaluate(() => { S.checks[TODAY] = [S.habits[0].id]; save(); return coinsFor(TODAY); });
    perOne === 20 ? ok('одна отметка = 20 🪙') : bad('одна отметка дала ' + perOne);
    await p.evaluate(() => { delete S.checks[TODAY]; save(); render(); });

    // эмодзи стирается и не возвращается
    await p.evaluate(() => { document.querySelector('.hedit').click(); }); await p.waitForTimeout(300);
    const before = await p.$eval('.modal input', e => e.value);
    await p.fill('.modal input', 'Тренировка');   // убрали смайлик
    await p.click('#hSv'); await p.waitForTimeout(400);
    h = await p.evaluate(() => S.habits[0]);
    (h.ico === '' && h.name === 'Тренировка')
      ? ok(`эмодзи снимается: «${before}» → «${h.name}»`)
      : bad('эмодзи не снялся: ' + JSON.stringify(h));
    const shown = await p.$eval('.hn', e => e.textContent.trim());
    shown === 'Тренировка' ? ok('в календаре тоже без эмодзи') : bad('в календаре: «' + shown + '»');

    // и на «Обзоре» чип без эмодзи
    await p.click('.tab[data-t="home"]'); await p.waitForTimeout(400);
    const chip = await p.$eval('#todayChips .tchip .nm', e => e.textContent.trim());
    chip === 'Тренировка' ? ok('чип на Обзоре без эмодзи') : bad('чип: «' + chip + '»');

    // награды: цену не спрашивают, только размер
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(400);
    const nRew = await p.$$eval('#shopGrid .si', e => e.length);
    nRew === 6 ? ok('шесть готовых наград на месте') : bad('наград: ' + nRew);
    await p.click('#addReward'); await p.waitForTimeout(300);
    const fields = await p.$$eval('.modal input, .modal select', e => e.map(x => x.tagName));
    JSON.stringify(fields) === JSON.stringify(['INPUT','SELECT'])
      ? ok('у награды спрашивают название и размер, не цену') : bad('поля: ' + JSON.stringify(fields));
    await p.fill('.modal input', '🎣 Рыбалка');
    await p.selectOption('.modal select', '7');
    await p.click('.modal .ok'); await p.waitForTimeout(400);
    const rw = await p.evaluate(() => S.rewards[S.rewards.length - 1]);
    (rw.days === 7 && rw.cost > 0) ? ok(`цена посчиталась сама: ${rw.name} — ${rw.cost} 🪙 за неделю`)
                                   : bad('награда: ' + JSON.stringify(rw));

    // встроенную награду можно переименовать и сменить размер
    await p.evaluate(() => document.querySelectorAll('#shopGrid .si .rm')[0].click());
    await p.waitForTimeout(300);
    await p.fill('.modal input', 'Приставка');    // и эмодзи убрали
    await p.selectOption('.modal select', '30');
    await p.click('.modal .ok'); await p.waitForTimeout(400);
    const r0 = await p.evaluate(() => S.rewards[0]);
    (r0.name === 'Приставка' && r0.days === 30) ? ok(`встроенная награда правится: ${r0.name}, ${r0.cost} 🪙`)
                                                : bad('награда 0: ' + JSON.stringify(r0));

    // и удаляется
    const n0 = await p.evaluate(() => S.rewards.length);
    await p.evaluate(() => document.querySelectorAll('#shopGrid .si .rm')[0].click());
    await p.waitForTimeout(300);
    await p.click('.modal .dl'); await p.waitForTimeout(400);
    const n1 = await p.evaluate(() => S.rewards.length);
    n1 === n0 - 1 ? ok('встроенная награда удаляется') : bad(`наград было ${n0}, стало ${n1}`);

    errCheck(p, 'монеты и награды');
    await ctx.close();
  }

  // ---------- 9. перенос старых данных ----------
  console.log('\n9) Данные старого формата переезжают');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL);
    await p.evaluate(() => localStorage.setItem('magnat_app_v2', JSON.stringify({
      habits: [{ id: 1, ico: '🏋️', name: 'Зал', coin: 25 }],
      checks: { }, tasks: [], finance: { entries: [] }, body: { log: [] },
      bought: [0, 0, 2],                                  // старые покупки по индексам
      myRewards: [{ id: 555, ico: '🎣', name: 'Рыбалка', cost: 900 }],
      boughtMy: { 555: 2 }, spent: 1300,
    })));
    await p.reload(); await p.waitForTimeout(600);
    const st = await p.evaluate(() => ({
      rew: S.rewards.length, custom: S.rewards.find(r => r.name === 'Рыбалка'),
      cnt: S.boughtCnt, spent: S.spent, old: S.myRewards === undefined && S.bought === undefined,
    }));
    st.rew === 7 ? ok('шесть встроенных + своя награда в одном списке') : bad('наград: ' + st.rew);
    st.custom && st.custom.cost === 900 ? ok('своя награда сохранила цену 900 🪙') : bad('своя: ' + JSON.stringify(st.custom));
    (st.cnt['1'] === 2 && st.cnt['3'] === 1 && st.cnt['555'] === 2)
      ? ok('счётчики покупок перенеслись: ' + JSON.stringify(st.cnt)) : bad('счётчики: ' + JSON.stringify(st.cnt));
    st.spent === 1300 ? ok('потрачено сохранилось') : bad('spent ' + st.spent);
    st.old ? ok('старые поля убраны') : bad('старые поля остались');
    for (const t of TABS) { await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(150); }
    errCheck(p, 'перенос старых данных');
    await ctx.close();
  }

  await b.close();
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})();

function addDaysNode(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + 1);
  const p = x => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

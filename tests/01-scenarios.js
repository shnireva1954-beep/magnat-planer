const { chromium, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR, startClean } = require('./lib');
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
    await startClean(p);
    await walkTabs(p, 'чистый лист');
    const wallet = await p.$eval('#wallet', e => e.textContent);
    if (wallet !== '0') bad('кошелёк на чистом листе = ' + wallet); else ok('кошелёк 0');
    // удалить все привычки → пустые состояния
    await p.evaluate(() => { S.habits = []; S.checks = {}; save(); render(); });
    await p.waitForTimeout(200);
    await walkTabs(p, 'без единой привычки');
    await ctx.close();
  }

  // ---------- 1б. выбор привычек на старте (решение владельца 29.09.2026) ----------
  console.log('\n1б) «Начать своё» → выбор привычек, а не восемь готовых');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obFresh'); await p.waitForTimeout(300);
    const on = await p.$$eval('#hpList .tchip.on .nm', e => e.map(x => x.textContent));
    const all = await p.$$eval('#hpList .tchip', e => e.length);
    (on.length === 3 && on.join('|') === '🏋️ Тренировка|📵 Лента не больше 30 минут|💼 Шаг к работе')
      ? ok(`отмечены три из ${all}: ${on.join(', ')}`) : bad('по умолчанию отмечено: ' + JSON.stringify(on));
    const fits = await p.$eval('#hpGo', e => e.getBoundingClientRect().bottom <= innerHeight);
    fits ? ok('кнопка «Начать» видна без прокрутки на 390×844') : bad('кнопка «Начать» за краем экрана');
    // «Назад» — онбординг на месте, пример не тронут
    await p.click('#hpNo'); await p.waitForTimeout(200);
    const back = await p.evaluate(() => ({ ob: !!document.querySelector('#obFresh'), pick: !!document.querySelector('#hpGo'), n: S.habits.length }));
    (back.ob && !back.pick && back.n === 8) ? ok('«Назад» вернул к приветствию, ничего не создано') : bad('после «Назад»: ' + JSON.stringify(back));
    // снять одну, добавить свою Enter-ом, ещё одну набрать и сразу «Начать» — набранное не теряется
    await p.click('#obFresh'); await p.waitForTimeout(300);
    await p.click('#hpList .tchip:has-text("Шаг к работе")'); await p.waitForTimeout(100);
    await p.fill('#hpOwn', '🤐 Без мата'); await p.press('#hpOwn', 'Enter'); await p.waitForTimeout(100);
    await p.fill('#hpOwn', 'Чтение');
    const label = await p.$eval('#hpGo', e => e.textContent);
    await p.click('#hpGo'); await p.waitForTimeout(400);
    const st = await p.evaluate(() => ({ hs: S.habits.map(h => [h.id, h.ico, h.name, h.since]), gone: !document.querySelector('.ovl'),
      cnt: document.querySelector('#todayCnt').textContent, w: wallet(), sport: S.habits.filter(isWorkout).map(h => h.name) }));
    const names = st.hs.map(h => h[2]).join('|');
    names === 'Тренировка|Лента не больше 30 минут|Без мата|Чтение' ? ok('привычки ровно выбранные: ' + names) : bad('привычки: ' + JSON.stringify(st.hs));
    (st.hs[2][1] === '🤐' && st.hs.every((h, i) => h[0] === i + 1 && h[3] === '')) ? ok('своя с эмодзи, id по порядку') : bad('поля: ' + JSON.stringify(st.hs));
    (st.gone && st.cnt.trim() === '0 из 4 привычек' && st.w === 0) ? ok('окна закрыты, «0 из 4», кошелёк 0') : bad('после старта: ' + JSON.stringify(st));
    st.sport.join() === 'Тренировка' ? ok('тренировкой считается только «Тренировка»') : bad('тренировки: ' + st.sport);
    label === '🚀 Начать (4)' ? ok('на кнопке число выбранных: ' + label) : bad('кнопка: ' + label);
    // ничего не выбрано — начать нельзя
    await p.evaluate(() => { document.querySelector('#resetBtn').click(); }); await p.waitForTimeout(300);
    while (await p.$('#hpList .tchip.on')) await p.click('#hpList .tchip.on');
    (await p.$eval('#hpGo', e => e.disabled)) ? ok('без выбора кнопка выключена') : bad('без выбора можно начать');
    // сброс и «Назад» — прогресс не стёрт
    await p.click('#hpNo'); await p.waitForTimeout(200);
    const kept = await p.evaluate(() => S.habits.length);
    kept === 4 ? ok('сброс → «Назад»: прогресс не стёрт') : bad('после отмены сброса привычек ' + kept);
    errCheck(p, 'выбор привычек');
    await ctx.close();
  }

  // ---------- 1в. айфон во вкладке: зовём на экран «Домой» (29.09.2026) ----------
  // WebKit стирает данные сайта во вкладке через 7 дней без открытия; значок на экране — нет
  console.log('\n1в) Подсказка «на экран Домой» — только айфону во вкладке');
  {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const probe = async (ua, standalone) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: ua || undefined });
      const p = await ctx.newPage(); p.errs = [];
      p.on('pageerror', e => p.errs.push('PAGEERROR: ' + e.message));
      await p.addInitScript(st => {
        if (st) Object.defineProperty(navigator, 'standalone', { get: () => true });
        window.__persist = 0;
        if (navigator.storage) navigator.storage.persist = () => { window.__persist++; return Promise.resolve(true); };
      }, !!standalone);
      await p.goto(URL); await p.waitForTimeout(400);
      await startClean(p);
      return { ctx, p, hint: !!(await p.$('#a2hs')), persist: await p.evaluate(() => window.__persist) };
    };
    let r = await probe(IPHONE, false);
    r.hint ? ok('айфон во вкладке: подсказка есть') : bad('айфон во вкладке: подсказки нет');
    r.persist > 0 ? ok('айфон: браузер попросили хранить данные постоянно') : bad('storage.persist() не вызван');
    await r.p.click('#a2hsOk'); await r.p.waitForTimeout(200);
    const gone = !(await r.p.$('#a2hs'));
    await r.p.reload(); await r.p.waitForTimeout(400);
    const still = !(await r.p.$('#a2hs'));
    (gone && still) ? ok('«Понятно» прячет подсказку, и после перезагрузки её нет') : bad(`после «Понятно»: скрыта ${gone}, после перезагрузки ${still}`);
    const back = await r.p.evaluate(() => { localStorage.setItem('magnat_a2hs_hide', String(Date.now() - 1)); render(); return !!document.querySelector('#a2hs'); });
    back ? ok('через неделю подсказка возвращается') : bad('через неделю подсказка не вернулась');
    errCheck(r.p, 'подсказка на айфоне');
    await r.ctx.close();
    r = await probe(IPHONE, true);
    !r.hint ? ok('айфон со значка на экране «Домой»: подсказки нет') : bad('подсказка показана в приложении с экрана «Домой»');
    await r.ctx.close();
    r = await probe(null, false);
    (!r.hint && r.persist === 0) ? ok('компьютер: ни подсказки, ни просьбы хранить (Firefox спросил бы окном)') : bad(`компьютер: подсказка ${r.hint}, persist ${r.persist}`);
    await r.ctx.close();
  }

  // ---------- 1г. дизайн 29.09.2026: календарь, кнопки «Добавить», анимации ----------
  console.log('\n1г) Календарь похож на календарь, кнопки видно, отметка «щёлкает»');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    await startClean(p);
    // «Сегодня» на Обзоре: отметка запускает анимацию, снятие — нет
    await p.click('#todayChips .tchip'); await p.waitForTimeout(60);
    // считаем анимации на САМОМ чипе: летящая монета — отдельный элемент и не в счёт
    const popAnims = await p.evaluate(() => document.querySelector('#todayChips .tchip.on').getAnimations().length);
    popAnims > 0 ? ok('отметка привычки «щёлкает» (анимаций на чипе: ' + popAnims + ')') : bad('при отметке чип не анимирован');
    await p.waitForTimeout(600);
    await p.click('#todayChips .tchip'); await p.waitForTimeout(300);
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(40);
    const viewAnim = await p.evaluate(() => document.querySelector('#v-habits').getAnimations().length);
    viewAnim > 0 ? ok('новая вкладка въезжает плавно') : bad('смена вкладки без анимации');
    await p.waitForTimeout(400);
    const c = await p.evaluate(() => {
      const t = new Date(), mon = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
      const diM = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
      const cells = [...document.querySelectorAll('.cday')], r = cells[0].getBoundingClientRect();
      const cols = new Set(cells.map(e => Math.round(e.getBoundingClientRect().left))).size;
      return { title: document.querySelector('.calt').textContent, want: mon[t.getMonth()] + t.getFullYear(),
        wd: [...document.querySelectorAll('.calwd')].map(e => e.textContent).join(' '), n: cells.length, diM, cols,
        sq: Math.abs(r.width - r.height) < 2 && r.width >= 30, next: document.querySelector('#calNext').disabled,
        sw: document.documentElement.scrollWidth > innerWidth };
    });
    c.title === c.want ? ok('над календарём месяц и год: ' + c.title) : bad('заголовок календаря: ' + c.title);
    c.wd === 'Пн Вт Ср Чт Пт Сб Вс' ? ok('дни недели с понедельника') : bad('дни недели: ' + c.wd);
    (c.n === c.diM && c.cols === 7 && c.sq && !c.sw) ? ok(`весь месяц на экране: ${c.n} дней, 7 столбцов, клетки квадратные, прокрутки вбок нет`)
                                                   : bad('сетка: ' + JSON.stringify(c));
    c.next ? ok('в будущий месяц листать нельзя') : bad('кнопка «следующий месяц» активна на текущем');
    await p.click('#calPrev'); await p.waitForTimeout(250);
    const prev = await p.evaluate(() => ({ t: document.querySelector('.calt').textContent, n: document.querySelectorAll('.cday').length,
      fut: document.querySelectorAll('.cday.fut').length }));
    await p.click('#calNext'); await p.waitForTimeout(250);
    const back = await p.$eval('.calt', e => e.textContent);
    (prev.t !== c.title && prev.fut === 0 && back === c.title) ? ok(`листается: ${prev.t} (${prev.n} дн.) → обратно ${back}`) : bad('листание: ' + JSON.stringify({ prev, back }));
    // «Все»: день открывает окно с отметками за этот день
    await p.click('.cday.tdy'); await p.waitForTimeout(300);
    const nChips = await p.$$eval('#dayChips .tchip', e => e.length);
    await p.click('#dayChips .tchip'); await p.waitForTimeout(200);
    const dayOk = await p.evaluate(() => checksOf(TODAY).includes(S.habits[0].id));
    await p.click('.ovl .ok'); await p.waitForTimeout(250);
    const ring = await p.$eval('.cday.tdy', e => e.className);
    (nChips === 3 && dayOk && /part|full/.test(ring)) ? ok('день в «Все» открывает окно, отметка видна кольцом') : bad(`окно дня: чипов ${nChips}, отмечено ${dayOk}, класс ${ring}`);
    // одна привычка: нажатие на день ставит и снимает галочку
    const hid = await p.evaluate(() => S.habits[1].id);
    await p.click(`.fchip[data-f="${hid}"]`); await p.waitForTimeout(250);
    await p.click('.hcell.tdy'); await p.waitForTimeout(60);
    const cellPop = await p.evaluate(() => document.querySelector('.hcell.tdy').getAnimations().length);
    await p.waitForTimeout(400);
    const on1 = await p.evaluate(h => checksOf(TODAY).includes(h), hid);
    await p.click('.hcell.tdy'); await p.waitForTimeout(250);
    const on2 = await p.evaluate(h => checksOf(TODAY).includes(h), hid);
    (on1 && !on2 && cellPop > 0) ? ok('день одной привычки отмечается и снимается, отметка «щёлкает»') : bad(`одна привычка: ${on1}/${on2}, анимаций ${cellPop}`);
    const futN = await p.$$eval('.hcell.fut', e => e.length);
    if (futN) { await p.click('.hcell.fut'); await p.waitForTimeout(200);
      const futOn = await p.evaluate(h => Object.keys(S.checks).some(d => d > TODAY), hid);
      !futOn ? ok('будущий день не отмечается') : bad('отметился будущий день'); }
    // окно появляется анимацией
    await p.click('#addHabit'); await p.waitForTimeout(30);
    const mAnim = await p.evaluate(() => document.getAnimations().some(a => a.animationName === 'modalIn'));
    mAnim ? ok('окно появляется, а не выскакивает') : bad('у окна нет анимации появления');
    await p.click('.modal .no'); await p.waitForTimeout(250);
    // кнопки «Добавить» на всех экранах: видимая рамка с контрастом ≥ 3 (WCAG 1.4.11), высота ≥ 48
    const lum = rgb => { const [r, g, bl] = rgb.match(/\d+/g).slice(0, 3).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * bl; };
    const btns = [];
    for (const t of ['habits', 'tasks', 'money', 'body', 'shop']) {
      await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(250);
      btns.push(...await p.$$eval('.view.on .addbtn', els => els.map(e => { const cs = getComputedStyle(e);
        return { id: e.id, border: cs.borderTopColor, style: cs.borderTopStyle, h: e.getBoundingClientRect().height, pl: !!e.querySelector('.pl') }; })));
    }
    const card = 'rgb(17,24,42)';   // стеклянная карточка на тёмном фоне
    const weak = btns.filter(x => { const a = lum(x.border), c2 = lum(card); return (Math.max(a, c2) + .05) / (Math.min(a, c2) + .05) < 3 || x.style !== 'solid' || x.h < 48 || !x.pl; });
    (btns.length >= 5 && !weak.length) ? ok(`кнопки «Добавить» заметные и одинаковые: ${btns.map(x => x.id).join(', ')}`) : bad('слабые кнопки: ' + JSON.stringify(weak));
    // Обзор (30.09.2026): «Сегодня» — первым, галочки на первом экране айфона без прокрутки.
    // Было: карточка уровня сверху и кольцо 150 px — галочки начинались на 631 px из 664
    await p.click('.tab[data-t="home"]'); await p.waitForTimeout(300);
    await p.setViewportSize({ width: 390, height: 664 }); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200);
    const fold = await p.evaluate(() => { const ch = document.querySelector('#todayChips').getBoundingClientRect(),
      t = document.querySelector('.today'), h = document.querySelector('.hero');
      return { bottom: Math.round(ch.bottom), vh: innerHeight, first: !!t && !!h && (t.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
        seria: document.querySelector('.tds').textContent }; });
    (fold.first && fold.bottom <= fold.vh) ? ok(`«Сегодня» первым, галочки видны без прокрутки (низ ${fold.bottom} из ${fold.vh})`)
                                           : bad('Обзор: ' + JSON.stringify(fold));
    /от 3 отметок/.test(fold.seria) ? ok('подпись про серию верная при трёх привычках: ' + fold.seria.trim()) : bad('подпись серии: ' + fold.seria);
    await p.evaluate(() => { S.habits = S.habits.slice(0, 1); save(); render(); }); await p.waitForTimeout(150);
    const one = await p.$eval('.tds', e => e.textContent);
    /от 1 отметки/.test(one) ? ok('с одной привычкой — «в серию от 1 отметки», а не «от 3»') : bad('подпись при одной привычке: ' + one);
    errCheck(p, 'дизайн 29.09');
    await ctx.close();
  }

  // ---------- 1д. глазами клиента 30.09.2026: понятно ли всё, анимация ----------
  console.log('\n1д) Глазами клиента: приветствие, кошелёк ждёт монету, награды, цифры в ряд');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    // приветствие объясняет игру короткими строками, а не одним абзацем
    const how = await p.$$eval('.how > div', e => e.length);
    how === 4 ? ok('приветствие: четыре строки «как это работает»') : bad('строк в приветствии: ' + how);
    await startClean(p);
    // пустые графики не рисуют выдуманных линий; «Разгон» переименован в понятное
    const home = await p.evaluate(() => ({ body: !!document.querySelector('#hBody'), money: !!document.querySelector('#hMoney'),
      t: document.querySelector('#v-home').textContent }));
    (!home.body && !home.money && !/Разгон/.test(home.t) && /Монеты по дням/.test(home.t))
      ? ok('без веса и денег пустых графиков нет, «Монеты по дням» вместо «Разгона»') : bad('Обзор новичка: ' + JSON.stringify({ body: home.body, money: home.money }));
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(300);
    const wk = await p.evaluate(() => ({ empty: !!document.querySelector('#v-habits .chempty'), cv: !!document.querySelector('#hbWeeks') }));
    (wk.empty && !wk.cv) ? ok('«Сила по неделям» без отметок говорит словами') : bad('пустая «Сила по неделям»: ' + JSON.stringify(wk));
    await p.click('.tab[data-t="home"]'); await p.waitForTimeout(300);
    // кошелёк меняется, когда монета долетела, а не в миг нажатия
    await p.click('#todayChips .tchip'); await p.waitForTimeout(120);
    const early = await p.$eval('#wallet', e => e.textContent);
    await p.waitForTimeout(1300);
    const late = await p.$eval('#wallet', e => e.textContent);
    (early === '0' && late === '20') ? ok(`кошелёк ждёт монету: через 0,1 с «${early}», после прилёта «${late}»`)
                                     : bad(`кошелёк: через 0,1 с «${early}», потом «${late}» (ожидали «0» → «20»)`);
    // награды: не хватает — полоска и «ещё N привычек»; хватает — кнопка «Купить»
    await p.click('.tab[data-t="shop"]'); await p.waitForTimeout(400);
    const poor = await p.$$eval('#shopGrid .si', els => els.map(e => ({ buy: !!e.querySelector('.buy'), bar: !!e.querySelector('.sbar'), t: e.textContent })));
    (poor.length && poor.every(x => x.bar && !x.buy) && /ещё 4 привычки/.test(poor[0].t))
      ? ok('на 20 🪙 у наград полоска и «ещё 4 привычки»') : bad('награды без монет: ' + JSON.stringify(poor.slice(0, 2)));
    await p.evaluate(() => { for (let k = 1; k <= 4; k++) S.checks[addDays(TODAY, -k)] = S.habits.map(h => h.id); save(); render(); });
    const cel = await p.$('.ovl .ok'); if (cel) { await cel.click(); await p.waitForTimeout(300); }
    const rich = await p.$$eval('#shopGrid .si', els => els.map(e => ({ buy: e.querySelector('.buy') && e.querySelector('.buy').textContent, bar: !!e.querySelector('.sbar'), afford: e.classList.contains('afford') })));
    (rich.some(x => x.buy === 'Купить') && rich.every(x => x.afford ? x.buy === 'Купить' && !x.bar : x.bar && !x.buy))
      ? ok('хватает — «Купить», не хватает — полоска') : bad('награды с монетами: ' + JSON.stringify(rich));
    // покупка: карточка откликается, сумма докручивается вниз, а не прыгает
    const w0 = await p.evaluate(() => wallet()), cost = await p.evaluate(() => rwCost(S.rewards[0]));
    await p.click('#shopGrid .si .i'); await p.waitForTimeout(80);
    const mid = await p.evaluate(() => ({ pop: document.querySelector('#shopGrid .si').getAnimations().length, shown: (document.querySelector('#shopW') || {}).textContent }));
    await p.waitForTimeout(700);
    const end = await p.evaluate(() => ({ w: wallet(), shown: (document.querySelector('#shopW') || {}).textContent, head: document.querySelector('#wallet').textContent, nf: nf(wallet()) }));
    (end.w === w0 - cost && mid.pop > 0 && mid.shown !== end.shown && end.shown === end.nf + ' 🪙' && end.head === end.nf)
      ? ok(`покупка: карточка щёлкнула, сумма докрутилась ${w0} → ${end.nf}`) : bad('покупка: ' + JSON.stringify({ w0, cost, mid, end }));
    // «Задачи», «Тело»: три цифры одной строкой, и на 320 px тоже
    await p.evaluate(() => { logWeight(80); save(); });
    for (const W of [390, 320]) {
      await p.setViewportSize({ width: W, height: 800 });
      for (const t of ['tasks', 'body']) {
        await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(300);
        const r = await p.evaluate(() => ({ tops: [...document.querySelectorAll('.view.on .g3 > .card')].map(e => Math.round(e.getBoundingClientRect().top)),
          sw: document.documentElement.scrollWidth > innerWidth }));
        (r.tops.length === 3 && new Set(r.tops).size === 1 && !r.sw) ? ok(`${t} на ${W} px: три цифры в одну строку`) : bad(`${t} на ${W} px: ` + JSON.stringify(r));
      }
    }
    await p.setViewportSize({ width: 390, height: 844 });
    // приоритет задачи — под названием, чтобы название не ломалось по слову
    await p.evaluate(() => { S.tasks.push({ id: 5, name: 'Смонтировать ролик', prio: 'hi', due: TODAY, done: false }); save(); cur = 'tasks'; render(); });
    // строк у названия = прямоугольников у его текста
    const tq = await p.evaluate(() => { const n = document.querySelector('.q .nm'), r = document.createRange();
      r.selectNodeContents(n.firstChild); return { tagIn: !!n.querySelector('.meta .tag'), lines: r.getClientRects().length }; });
    (tq.tagIn && tq.lines === 1) ? ok('приоритет под названием, «Смонтировать ролик» в одну строку') : bad('строка задачи: ' + JSON.stringify(tq));
    // «Финансы»: итог месяца назван месяцем, «Доход» и «Расход» рядом
    await p.click('.tab[data-t="money"]'); await p.waitForTimeout(300);
    const fin = await p.evaluate(() => { const mon = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'][new Date().getMonth()];
      return { month: ((document.querySelector('#v-money h3') || {}).textContent || '').includes(mon), fsum: !!document.querySelector('.fsum'),
        row: Math.round(document.querySelector('#addIn').getBoundingClientRect().top) === Math.round(document.querySelector('#addOut').getBoundingClientRect().top) }; });
    (fin.month && fin.fsum && fin.row) ? ok('«Финансы»: итог назван месяцем, «Доход» и «Расход» в одну строку') : bad('финансы: ' + JSON.stringify(fin));
    errCheck(p, 'глазами клиента 30.09');
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

    // календарь — весь месяц на экране: «сегодня» видно без прокрутки вбок
    const cal = await p.evaluate(() => {
      const td = document.querySelector('.cd.tdy'), r = td.getBoundingClientRect();
      return { visible: r.left >= 0 && r.right <= innerWidth, sw: document.documentElement.scrollWidth > innerWidth };
    });
    (cal.visible && !cal.sw) ? ok('«сегодня» видно в календаре, прокрутки вбок нет')
                             : bad('календарь: ' + JSON.stringify(cal));

    // отметки в календаре реально отрисованы: в «Все» — кольца и полные дни
    const onCells = await p.$$eval('.cday.full, .cday.part', els => els.length);
    onCells > 0 ? ok('в календаре ' + onCells + ' дней с отметками') : bad('в календаре нет отметок');

    await ctx.close();
  }

  // ---------- 3. взаимодействия ----------
  console.log('\n3) Реальные действия пользователя');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await startClean(p);

    // отметить привычку чипом на Обзоре
    const w0 = await p.$eval('#wallet', e => e.textContent);
    // число в кошельке меняется, когда монета долетела (620 мс) и докрутилась (450 мс)
    await p.click('#todayChips .tchip'); await p.waitForTimeout(1300);
    const w1 = await p.$eval('#wallet', e => e.textContent);
    w1 !== w0 ? ok(`чип привычки: кошелёк ${w0} → ${w1}`) : bad('чип привычки не начислил монеты');
    // снять обратно
    await p.click('#todayChips .tchip'); await p.waitForTimeout(300);
    const w2 = await p.$eval('#wallet', e => e.textContent);
    w2 === w0 ? ok('снятие галочки возвращает кошелёк') : bad(`снятие: ${w2} ≠ ${w0}`);

    // клетка календаря: выбрать привычку и нажать на день
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(300);
    await p.click('.fchip:not([data-f="all"])'); await p.waitForTimeout(250);
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
    const cost0 = await p.evaluate(() => rwCost(S.rewards[0]));   // цена = привычки × 20
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
    if (await p.$('#obFresh')) await startClean(p);
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
    await startClean(p);
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
    await startClean(p);
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
    // цель = 80-3 = 77, до неё 3 кг → дефицит 8% + 1,5%×3 = 12,5%; активность без тренировок = 1.2
    // (с 24.09.2026 дефицит зависит от расстояния до цели: 10–25%, раньше был ровно 15%)
    const got = await p.evaluate(() => ({ n: norms(), cal: calGoalNow(), water: waterGoalNow(), goal: S.body.goalW }));
    const expBmr = 10*80 + 6.25*180 - 5*36 + 5;
    const expCal = Math.round(expBmr*1.2*(1-0.125)/10)*10;
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

    // норма следует за весом: 90 кг при цели 77 — до цели 13 кг, дефицит упирается в потолок 25%
    const calBefore = await p.evaluate(() => calGoalNow());
    await p.evaluate(() => { logWeight(90); save(); render(); });
    await p.waitForTimeout(300);
    { const c = await p.$('.ovl .ok'); if (c) { await c.click(); await p.waitForTimeout(300); } }
    const calAfter = await p.evaluate(() => calGoalNow());
    const exp90 = Math.round((10*90 + 6.25*180 - 5*36 + 5)*act.f*0.75/10)*10;
    calAfter === exp90 ? ok(`норма пересчиталась при смене веса: ${calBefore} → ${calAfter}`)
                       : bad(`норма при 90 кг: ${calAfter}, ожидали ${exp90} (было ${calBefore})`);

    // норма следует за ЦЕЛЬЮ — жалоба владельца 24.09: «при изменении цели веса не меняется норма».
    // Раньше цели 77 и 85 при весе 90 давали одно число (ровно −15%)
    const calGoal85 = await p.evaluate(() => { S.body.goalW = 85; save(); const v = calGoalNow(); S.body.goalW = 77; save(); render(); return v; });
    const exp85 = Math.round((10*90 + 6.25*180 - 5*36 + 5)*act.f*(1-(0.08+0.015*5))/10)*10;
    (calGoal85 === exp85 && calGoal85 > calAfter)
      ? ok(`цель ближе — дефицит меньше: цель 77 → ${calAfter}, цель 85 → ${calGoal85}`)
      : bad(`норма от цели: цель 77 → ${calAfter}, цель 85 → ${calGoal85}, ожидали ${exp85}`);

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
    await startClean(p);

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

    // эмодзи стирается и не возвращается: привычку правят из календаря («✏️ изменить»)
    await p.evaluate(() => { calH = S.habits[0].id; render(); }); await p.waitForTimeout(200);
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
    await p.selectOption('.modal select', '40');
    await p.click('.modal .ok'); await p.waitForTimeout(400);
    const rw = await p.evaluate(() => ({ ...S.rewards[S.rewards.length - 1], cost: rwCost(S.rewards[S.rewards.length - 1]) }));
    (rw.n === 40 && rw.cost === 800) ? ok(`цена посчиталась сама: ${rw.name} — ${rw.cost} 🪙 = 40 привычек`)
                                     : bad('награда: ' + JSON.stringify(rw));
    const card = await p.$$eval('#shopGrid .si', e => e[e.length - 1].textContent);
    /= 40 привычек/.test(card) ? ok('на карточке написано, сколько привычек она стоит')
                               : bad('на карточке нет цены в привычках: ' + card);

    // встроенную награду можно переименовать и сменить размер
    await p.evaluate(() => document.querySelectorAll('#shopGrid .si .rm')[0].click());
    await p.waitForTimeout(300);
    await p.fill('.modal input', 'Приставка');    // и эмодзи убрали
    await p.selectOption('.modal select', '150');
    await p.click('.modal .ok'); await p.waitForTimeout(400);
    const r0 = await p.evaluate(() => ({ ...S.rewards[0], cost: rwCost(S.rewards[0]) }));
    (r0.name === 'Приставка' && r0.n === 150) ? ok(`встроенная награда правится: ${r0.name}, ${r0.cost} 🪙`)
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
    // с 24.09.2026 цена — в привычках (5/15/40/150): 900 🪙 = 45 привычек → ближайший размер 40 (800 🪙)
    st.custom && st.custom.n === 40 ? ok('своя награда переехала в размер «40 привычек» (была 900 🪙)') : bad('своя: ' + JSON.stringify(st.custom));
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

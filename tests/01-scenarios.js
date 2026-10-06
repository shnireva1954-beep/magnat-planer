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
    // следом — урок 1 (06.10.2026); «Готово» закрывает его, и дальше всё как раньше
    const first = await p.evaluate(() => ({ n: document.querySelectorAll('.ovl').length, h: (document.querySelector('.lesm h4') || {}).textContent }));
    (first.n === 1 && first.h === 'Правило 1%') ? ok('после «Начать» открыт урок 1 — одно окно') : bad('после «Начать»: ' + JSON.stringify(first));
    await p.click('.lesm .ok'); await p.waitForTimeout(300);
    const st = await p.evaluate(() => ({ hs: S.habits.map(h => [h.id, h.ico, h.name, h.since]), today: TODAY, gone: !document.querySelector('.ovl'),
      cnt: document.querySelector('#todayCnt').textContent, w: wallet(), sport: S.habits.filter(isWorkout).map(h => h.name) }));
    const names = st.hs.map(h => h[2]).join('|');
    names === 'Тренировка|Лента не больше 30 минут|Без мата|Чтение' ? ok('привычки ровно выбранные: ' + names) : bad('привычки: ' + JSON.stringify(st.hs));
    // с 30.09.2026 привычки чистого листа считаются с сегодняшнего дня, а не «всегда»
    (st.hs[2][1] === '🤐' && st.hs.every((h, i) => h[0] === i + 1 && h[3] === st.today)) ? ok('своя с эмодзи, id по порядку, считаются с сегодня') : bad('поля: ' + JSON.stringify(st.hs));
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

    // 1в-2. встроенный браузер соцсети (02.10.2026): хранилище отдельно от Safari/Chrome, «На экран
    // Домой» там нет — зовём открыть в браузере, а не к кнопке, которой нет
    const IG_IOS = IPHONE.replace('Safari/604.1', 'Instagram 390.0.0.28.85 (iPhone15,3; iOS 17_5; ru_RU; ru-RU; scale=3.00; 1290x2796; 0)');
    const IG_AND = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 Instagram 390.0.0.28.85 Android';
    const TT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36 BytedanceWebview/d8a21c6 musical_ly_2023';
    const inapp = async ua => { const q = await probe(ua, false);
      const t = await q.p.evaluate(() => (document.querySelector('#inapp') || {}).textContent || '');
      return { q, t, a2hs: q.hint }; };
    let ia = await inapp(IG_IOS);
    (ia.t.includes('Открой Магнат в браузере') && ia.t.includes('«⋯»') && ia.t.includes('Instagram') && !ia.a2hs)
      ? ok('Instagram на айфоне: «открой в браузере» через ⋯, подсказки про «На экран Домой» нет') : bad('Instagram на айфоне: ' + JSON.stringify({ t: ia.t, a2hs: ia.a2hs }));
    await ia.q.p.click('#inappOk'); await ia.q.p.waitForTimeout(200); await ia.q.p.reload(); await ia.q.p.waitForTimeout(400);
    !(await ia.q.p.$('#inapp')) ? ok('«Понятно» прячет её, и после перезагрузки её нет') : bad('подсказка вернулась после «Понятно»');
    errCheck(ia.q.p, 'Instagram на айфоне'); await ia.q.ctx.close();
    ia = await inapp(IG_AND);
    (ia.t.includes('«⋮»') && ia.t.includes('Instagram')) ? ok('Instagram на Android: меню «⋮»') : bad('Instagram на Android: ' + ia.t);
    await ia.q.ctx.close();
    ia = await inapp(TT);
    ia.t.includes('TikTok') ? ok('TikTok: та же подсказка, с его названием') : bad('TikTok: ' + ia.t);
    await ia.q.ctx.close();
    ia = await inapp(IPHONE);
    (!ia.t && ia.a2hs) ? ok('обычный Safari: «открой в браузере» не показана, «На экран Домой» на месте') : bad('Safari: ' + JSON.stringify({ t: ia.t, a2hs: ia.a2hs }));
    await ia.q.ctx.close();
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
    // с 03.10.2026 вкладки внизу и закрывают низ экрана — видимая высота без них
    const fold = await p.evaluate(() => { const ch = document.querySelector('#todayChips').getBoundingClientRect(),
      t = document.querySelector('.today'), h = document.querySelector('.hero'), nav = document.querySelector('nav.tabs');
      return { bottom: Math.round(ch.bottom), vh: Math.round(nav ? nav.getBoundingClientRect().top : innerHeight), first: !!t && !!h && (t.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
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
      share: !!document.querySelector('#shareBtn'), t: document.querySelector('#v-home').textContent }));
    // «Поделиться» у новичка нет: в карточке была бы пустая империя и 0 монет
    !home.share ? ok('на 1-м уровне кнопки «Поделиться» нет') : bad('новичку предлагают поделиться пустой империей');
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
    const share2 = await p.evaluate(() => { cur = 'home'; render(); const b = !!document.querySelector('#shareBtn'); cur = 'shop'; render();
      return { b, L: levelOf(totalXP()) }; });
    (share2.L > 1 && share2.b) ? ok(`на ${share2.L}-м уровне «Поделиться» появилась`) : bad('«Поделиться» после роста: ' + JSON.stringify(share2));
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
    // столбики «Доход vs Расход» повторяли две цифры итога — их нет; разбор трат по категориям остался
    const fin2 = await p.evaluate(() => { S.finance.entries.push({ id: 91, type: 'in', amount: 50000, cat: '💼 Работа', date: TODAY },
      { id: 92, type: 'out', amount: 12000, cat: '🍔 Еда', date: TODAY }); save(); render();
      return { bars: !!document.querySelector('#mBars'), pie: !!document.querySelector('#mPie') }; });
    (!fin2.bars && fin2.pie) ? ok('в «Финансах» нет дублирующих столбиков, круг трат на месте') : bad('графики финансов: ' + JSON.stringify(fin2));
    errCheck(p, 'глазами клиента 30.09');
    await ctx.close();
  }

  // ---------- 1е. второй проход клиентом 30.09.2026: первый день ----------
  console.log('\n1е) Первый день: месяц не 3%, серия объясняет себя, цель не выдумана, запятые');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    await startClean(p);
    // «Сила по неделям» — шкала от 0 до 100%, а не от самого высокого столбика
    const wkOpt = await p.evaluate(() => { let seen = null; const orig = bars;
      bars = (cv, d, c, o) => { if (cv && cv.id === 'hbWeeks') seen = o; return orig(cv, d, c, o); };
      S.checks[TODAY] = [S.habits[0].id]; save(); cur = 'habits'; render(); bars = orig; cur = 'home'; delete S.checks[TODAY]; save(); render();
      return seen && seen.max; });
    wkOpt === 100 ? ok('«Сила по неделям» меряется от 0 до 100%') : bad('шкала недель: ' + wkOpt);
    // сделал в первый день всё — месяц 100%, а не 3%; третья галочка говорит про серию
    const toasts = [];
    await p.exposeFunction('__t', m => toasts.push(m));
    await p.evaluate(() => { const t = document.getElementById('toast'); new MutationObserver(() => { if (t.classList.contains('show')) __t(t.textContent); }).observe(t, { attributes: true, childList: true }); });
    for (let i = 0; i < 3; i++) { await p.click('#todayChips .tchip:not(.on)'); await p.waitForTimeout(250); }
    await p.waitForTimeout(300);
    const d1 = await p.evaluate(() => ({ month: document.querySelector('#hDonutP').textContent,
      tile: [...document.querySelectorAll('.tile .l')].map(e => e.textContent).join('|'), mult: document.querySelectorAll('.tile .v')[1].textContent }));
    d1.month === '100%' ? ok('первый день, всё отмечено — «Месяц выполнен 100%»') : bad('месяц в первый день: ' + d1.month);
    toasts.some(t => /День в серии: 1 · завтра монеты ×1,1/.test(t)) ? ok('третья галочка: «🔥 День в серии: 1 · завтра монеты ×1,1»') : bad('тосты: ' + JSON.stringify(toasts));
    (/бонус серии/.test(d1.tile) && d1.mult === '×1,1') ? ok('плитка «бонус серии ×1,1» — с запятой') : bad('плитки: ' + JSON.stringify(d1));
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(300);
    const top = await p.$$eval('.prow .pc', e => e.map(x => x.textContent));
    top.every(t => t === '100%') ? ok('«Топ привычек» в первый день — 100%') : bad('топ: ' + top.join(','));
    // первый вес: цель спрашивают, не выдумывают; вес и числа — с запятой
    await p.click('.tab[data-t="body"]'); await p.waitForTimeout(300);
    await p.click('#addW'); await p.waitForTimeout(250);
    const nIn = await p.$$eval('.modal input', e => e.length);
    await p.fill('.modal input >> nth=0', '82,4'); await p.click('.modal .ok'); await p.waitForTimeout(400);
    const bd = await p.evaluate(() => ({ goal: S.body.goalW, t: document.querySelector('#v-body').textContent }));
    (nIn === 2 && bd.goal === 0 && /82,4 кг/.test(bd.t) && !/82\.4/.test(bd.t) && /1\s*тренировка · 30 дн/.test(bd.t))
      ? ok('в форме веса есть цель; пустая — не выдумана; «82,4 кг»; «1 тренировка»') : bad('тело: ' + JSON.stringify({ nIn, goal: bd.goal, t: bd.t.slice(0, 160) }));
    const hb = await p.evaluate(() => { cur = 'home'; render(); return { line: !!document.querySelector('#hBody'), t: document.querySelector('[data-go="body"]').textContent }; });
    (!hb.line && /82,4 кг/.test(hb.t) && /цель не задана/.test(hb.t)) ? ok('на Обзоре один замер без черты, «цель не задана»') : bad('вес на Обзоре: ' + JSON.stringify(hb));
    // активность новичка: неделя тренировок не делится на 4 недели
    await p.evaluate(() => { S.body.sex = 'm'; S.body.height = 180; S.body.birth = 2000; save(); });
    const act = await p.evaluate(() => { const N = norms(); return { f: N.f, pw: N.perWeek, line: actLine(N) }; });
    (act.pw === 1 && act.f === 1.375 && /за 7 дней/.test(act.line)) ? ok(`первый день с тренировкой: ${act.pw} в неделю → лёгкая, «${act.line.match(/в среднем[^)]*/)[0]}»`)
      : bad('активность новичка: ' + JSON.stringify(act));
    // без цели норма не пишет «поддержание 2 560 · поддержание веса», а говорит, что цели нет
    const nt = await p.evaluate(() => { cur = 'body'; render(); return document.querySelector('#editCal .nrm').textContent; });
    (/цель не задана/.test(nt) && !/поддержание веса.*поддержание|поддержание \d.*поддержание веса/.test(nt)) ? ok('норма без цели: «' + nt.trim().slice(0, 40) + '…»') : bad('подпись нормы без цели: ' + nt);
    errCheck(p, 'первый день 30.09');
    await ctx.close();
  }

  // ---------- 1ж. клавиатура (02.10.2026) ----------
  // вкладки, фильтр календаря и галочки «Сегодня» были <div> без tabindex — с клавиатуры не нажать
  console.log('\n1ж) Клавиатура: Tab доходит до вкладок и галочек, Enter и пробел их нажимают');
  {
    const { ctx, p } = await newPage(b, { width: 1280, height: 900 });
    await p.goto(URL); await p.waitForTimeout(400);
    await startClean(p);
    await p.focus('.tab[data-t="habits"]').catch(() => {});
    const focusedTab = await p.evaluate(() => document.activeElement && document.activeElement.dataset.t);
    await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    const onTab = await p.evaluate(() => ({ cur, aria: document.querySelector('.tab[data-t="habits"]').getAttribute('aria-current') }));
    await p.focus('.fchip[data-f="1"]').catch(() => {});
    await p.keyboard.press(' '); await p.waitForTimeout(300);
    const fil = await p.evaluate(() => calH);
    await p.evaluate(() => { cur = 'home'; render(); });
    await p.focus('#todayChips .tchip').catch(() => {});
    await p.keyboard.press(' '); await p.waitForTimeout(400);
    const st = await p.evaluate(() => ({ n: (S.checks[TODAY] || []).length, aria: document.querySelector('#todayChips .tchip').getAttribute('aria-checked'), y: scrollY }));
    (focusedTab === 'habits' && onTab.cur === 'habits' && onTab.aria === 'page')
      ? ok('вкладка: фокус клавиатурой, Enter открыл «Привычки», отмечена для экранного чтеца') : bad('вкладка с клавиатуры: ' + JSON.stringify({ focusedTab, onTab }));
    fil === 1 ? ok('фильтр календаря: пробел выбрал привычку') : bad('фильтр календаря с клавиатуры: calH=' + fil);
    (st.n === 1 && st.aria === 'true' && st.y === 0) ? ok('галочка «Сегодня»: пробел отметил, страница не прыгнула') : bad('галочка с клавиатуры: ' + JSON.stringify(st));
    errCheck(p, 'клавиатура');
    await ctx.close();
  }

  // ---------- 1з. дизайн и удобство 03.10.2026 ----------
  // Владелец: «дизайн, удобство… ты лучше можешь сделать». Найдено по снимкам 390 px: видно
  // 3 вкладки из 6, Georgia вперемешку с системным, рваные пилюли «Сегодня», неон.
  console.log('\n1з) Вкладки внизу все шесть, свой шрифт, ровный список дня, без неона');
  {
    const pictRe = /\p{Extended_Pictographic}/u;
    for (const w of [320, 390]) {
      const { ctx, p } = await newPage(b, { width: w, height: 640 });
      await p.goto(URL); await p.waitForTimeout(400);
      await p.click('#obDemo'); await p.waitForTimeout(400);
      const nav = await p.evaluate(() => {
        const n = document.querySelector('nav.tabs'), tabs = [...document.querySelectorAll('.tab')];
        return { nav: !!n, atBottom: !!n && Math.abs(n.getBoundingClientRect().bottom - innerHeight) < 1 && getComputedStyle(n).position === 'fixed',
          tabs: tabs.map(t => { const r = t.getBoundingClientRect(), l = t.querySelector('.tl');
            return { t: t.textContent.trim(), in: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
              w: Math.round(r.width), h: Math.round(r.height), cut: !l || l.scrollWidth > l.clientWidth + 1, svg: !!t.querySelector('svg') }; }) };
      });
      const badTabs = nav.tabs.filter(t => !t.in || t.cut || t.w < 44 || t.h < 44 || !t.svg || pictRe.test(t.t));
      (nav.nav && nav.atBottom && nav.tabs.length === 6 && !badTabs.length)
        ? ok(`${w}px: внизу все 6 вкладок, подписи целиком, цель ≥ 44 px, значки — SVG (${nav.tabs.map(t => t.t).join(', ')})`)
        : bad(`${w}px вкладки: ` + JSON.stringify({ nav: nav.nav, atBottom: nav.atBottom, n: nav.tabs.length, badTabs }));
      // последний элемент страницы не прячется под панелью
      const last = await p.evaluate(() => { window.scrollTo(0, 1e6); const n = document.querySelector('nav.tabs');
        const r = document.querySelector('#resetBtn').getBoundingClientRect(); return { b: Math.round(r.bottom), top: Math.round(n ? n.getBoundingClientRect().top : innerHeight) }; });
      last.b <= last.top ? ok(`${w}px: низ Обзора не уходит под панель (${last.b} ≤ ${last.top})`) : bad(`${w}px: низ страницы под панелью: ` + JSON.stringify(last));
      await ctx.close();
    }
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(500);
    const f = await p.evaluate(() => {
      const fam = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).fontFamily : '—'; };
      return { body: fam('body'), big: ['.brand b', '.lvl-name', '.tdt b', '.chip.lvl'].map(fam),
        loaded: document.fonts.check('800 20px Manrope') && document.fonts.check('400 14px Manrope'),
        mark: !!document.querySelector('header svg.mk'), hdrEmoji: /\p{Extended_Pictographic}/u.test(document.querySelector('.brand').textContent),
        fav: (document.querySelector('link[rel=icon]') || {}).href || '' };
    });
    (/^"?Manrope/.test(f.body) && f.big.every(x => /^"?Manrope/.test(x) && !/Georgia/.test(x)) && f.loaded)
      ? ok('шрифт один — Manrope, встроен и загружен; Georgia нигде нет') : bad('шрифт: ' + JSON.stringify(f));
    (f.mark && !f.hdrEmoji && /svg/.test(f.fav) && !/%F0%9F/.test(f.fav)) ? ok('в шапке и на вкладке браузера — знак-SVG, как значок телефона, а не 🏛')
      : bad('знак: ' + JSON.stringify({ mark: f.mark, hdrEmoji: f.hdrEmoji, fav: f.fav.slice(0, 60) }));
    // «Сегодня» — ровный список: одинаковые левый край и ширина, строка ≥ 48, флажок ≥ 24
    const rows = await p.$$eval('#todayChips .tchip', els => els.map(e => { const r = e.getBoundingClientRect(), d = e.querySelector('.d').getBoundingClientRect();
      return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), d: Math.round(d.width) }; }));
    (rows.length === 8 && new Set(rows.map(r => r.l)).size === 1 && new Set(rows.map(r => r.w)).size === 1 && rows.every(r => r.h >= 48 && r.d >= 24))
      ? ok(`«Сегодня» ровным списком: ${rows.length} строк по ${rows[0].w}×${rows[0].h}, флажок ${rows[0].d} px`) : bad('список дня: ' + JSON.stringify(rows));
    const demoToday = await p.$$eval('#todayChips .tchip.on', e => e.length);
    demoToday === 3 ? ok('пример живой: сегодня уже 3 отметки из 8') : bad('отметок сегодня в примере: ' + demoToday);
    // без неона: ни одного свечения (тень без смещения) у кнопок, полос и выбранного
    const glow = await p.evaluate(() => [...document.styleSheets[0].cssRules].map(r => r.cssText).filter(t => /box-shadow:\s*rgba?\([^)]*\)\s+0px\s+0px\s+[1-9]|box-shadow:\s*0px\s+0px\s+[1-9]/.test(t)).map(t => t.slice(0, 60)));
    !glow.length ? ok('неоновых свечений в стилях нет') : bad('свечения: ' + glow.join(' | '));
    const home = await p.evaluate(() => ({ money: !!document.querySelector('#hMoney'), shareBg: getComputedStyle(document.querySelector('#shareBtn')).backgroundImage }));
    (!home.money && home.shareBg === 'none') ? ok('на Обзоре нет столбиков-повтора «доход/расход», «Поделиться» — второстепенной кнопкой')
      : bad('Обзор: ' + JSON.stringify(home));
    await p.click('.tab[data-t="tasks"]'); await p.waitForTimeout(300);
    const meta = await p.$$eval('#v-tasks .meta', els => els.map(e => e.textContent));
    (meta.some(t => /сегодня/.test(t)) && meta.some(t => /завтра/.test(t)) && !meta.some(t => new RegExp(new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }).replace('.', '\\.')).test(t)))
      ? ok('сроки задач словами: «сегодня», «завтра»') : bad('сроки задач: ' + meta.join(' | '));
    // флажок один и тот же везде: у задачи такой же круг, как у привычки «Сегодня»
    const box = await p.$eval('#v-tasks .q .box', e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), br: getComputedStyle(e).borderRadius }; });
    (box.w === 26 && box.br === '50%') ? ok('флажок задачи — тот же круг 26 px, что у привычек') : bad('флажок задачи: ' + JSON.stringify(box));
    errCheck(p, 'дизайн 03.10');
    await ctx.close();
  }

  // ---------- 1и. Путь Магната 06.10.2026: урок за уровень, рост, срок в своём темпе ----------
  // Владелец: «акцент на саморазвитие — человек должен знать, что станет лучше». Каждый уровень
  // открывает урок из книги и задание (+20 🪙); экран «Путь» — с уровня в шапке и с карточки уровня
  console.log('\n1и) Путь Магната: уроки по уровням, задание даёт монеты, срок в своём темпе');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    const how = await p.$$eval('.how > div', e => e.map(x => x.textContent).join(' | '));
    /урок/.test(how) ? ok('приветствие говорит про уроки за уровни') : bad('приветствие: ' + how);
    await startClean(p);
    // содержимое: 40 уроков (06.10.2026: книги владельца и психология), у каждого книга, автор, мысль и задание;
    // ступеней столько же, сколько званий
    const meta = await p.evaluate(() => ({ n: LESSONS.length, st: STAGES.length, rk: RANKS.length,
      bad: LESSONS.filter(l => !(l.t && l.b && l.a && l.i && l.p) || (l.go && !GOLBL[l.go])).map(l => l.t),
      // честность: урок пересказывает книгу, а не обещает результат
      promise: LESSONS.filter(l => /100\s*%|гарант/i.test(l.i + l.p)).map(l => l.t),
      lastStage: RANKS[RANKS.length - 1][2] <= LESSONS.length }));
    (meta.n === 40 && meta.st === meta.rk && !meta.bad.length && !meta.promise.length && meta.lastStage)
      ? ok(`${meta.n} уроков по ${meta.st} ступеням, у каждого книга, автор, мысль и задание, обещаний «100%» нет`) : bad('уроки: ' + JSON.stringify(meta));
    // новичок: на Обзоре урок 1, в пути урок 1 открыт, урок 2 закрыт; вместо «+0%» — само правило
    const row = await p.$eval('#lesRow', e => ({ n: e.dataset.n, t: e.textContent }));
    (row.n === '1' && /Правило 1%/.test(row.t)) ? ok('на Обзоре новичка — урок 1 «Правило 1%»') : bad('строка урока: ' + JSON.stringify(row));
    await p.click('#lvlChip'); await p.waitForTimeout(300);
    const path = await p.evaluate(() => ({ cur, tab: document.querySelector('.tab.on').dataset.t,
      stg: document.querySelectorAll('#v-path .stg').length, open: [...document.querySelectorAll('#v-path [data-les]')].map(e => e.dataset.les),
      big: document.querySelector('#v-path .pgrow .big').textContent, fc: document.querySelectorAll('#v-path .fcr').length,
      t: document.querySelector('#v-path').textContent, sw: document.documentElement.scrollWidth, w: innerWidth }));
    (path.cur === 'path' && path.tab === 'home' && path.stg === 5) ? ok('уровень в шапке открывает путь: 5 ступеней, подсвечен «Обзор»') : bad('путь: ' + JSON.stringify({ cur: path.cur, tab: path.tab, stg: path.stg }));
    (path.open.join() === '1' && /откроется на 2-м уровне/.test(path.t)) ? ok('урок 1 открыт, урок 2 ждёт 2-го уровня') : bad('открытые уроки: ' + path.open.join());
    (path.big === '1%' && !path.fc && /три дня/.test(path.t)) ? ok('у новичка «1%» вместо «+0%», срока без данных нет — сказано словами')
      : bad('новичок в пути: ' + JSON.stringify({ big: path.big, fc: path.fc }));
    path.sw <= path.w ? ok('путь без прокрутки вбок на 390') : bad(`путь шире экрана: ${path.sw} > ${path.w}`);
    // окно урока: книга и автор, задание даёт +20 и столько же опыта; снятое — отнимает (не ферма)
    await p.click('#v-path [data-les="1"]'); await p.waitForTimeout(300);
    const m = await p.evaluate(() => ({ t: document.querySelector('.lesm').textContent, role: document.querySelector('.lesm .ltask').getAttribute('role') }));
    (/Атомные привычки/.test(m.t) && /Джеймс Клир/.test(m.t) && /Задание/.test(m.t) && m.role === 'checkbox') ? ok('окно урока: книга, автор, задание флажком') : bad('окно урока: ' + m.t.slice(0, 120));
    await p.click('.lesm .ltask'); await p.waitForTimeout(1300);
    const on = await p.evaluate(() => ({ les: S.les.join(), xp: totalXP(), w: wallet(), head: document.querySelector('#wallet').textContent, aria: document.querySelector('.lesm .ltask').getAttribute('aria-checked') }));
    (on.les === '1' && on.xp === 20 && on.w === 20 && on.head === '20' && on.aria === 'true') ? ok('задание урока: +20 🪙 и +20 ⭐, кошелёк в шапке 20') : bad('после задания: ' + JSON.stringify(on));
    await p.click('.lesm .ltask'); await p.waitForTimeout(300);
    const off = await p.evaluate(() => ({ les: S.les.length, xp: totalXP() }));
    (off.les === 0 && off.xp === 0) ? ok('снятое задание монеты отнимает — фермы нет') : bad('после снятия: ' + JSON.stringify(off));
    await p.click('.lesm .ltask'); await p.waitForTimeout(300);
    await p.click('.lesm .ok'); await p.waitForTimeout(200);
    // новый уровень называет открытый урок и ведёт в него; «Строим дальше» закрывает как раньше
    await p.evaluate(() => { S.checks[TODAY] = S.habits.slice(0, 3).map(h => h.id); S.tasks.push({ id: uid(), name: 'т', prio: 'md', due: TODAY, done: true }); save(); render(); });
    await p.waitForTimeout(300);
    const cel = await p.evaluate(() => ({ L: levelOf(totalXP()), t: (document.querySelector('.ovl .modal') || {}).textContent || '', les: !!document.querySelector('#celLes') }));
    (cel.L === 2 && /Открыт урок 2/.test(cel.t) && /Зеркало ответственности/.test(cel.t) && cel.les) ? ok('праздник 2-го уровня называет урок 2 «Зеркало ответственности»') : bad('праздник: ' + JSON.stringify(cel));
    await p.click('#celLes'); await p.waitForTimeout(300);
    const l2 = await p.evaluate(() => ({ h: (document.querySelector('.lesm h4') || {}).textContent, ovl: document.querySelectorAll('.ovl').length }));
    (l2.h === 'Зеркало ответственности' && l2.ovl === 1) ? ok('«📖 Урок» из праздника открывает урок 2') : bad('урок из праздника: ' + JSON.stringify(l2));
    await p.click('.lesm .ok'); await p.waitForTimeout(200);
    // срок в своём темпе и дисциплина неделя к неделе — из истории; без неё их нет (проверено выше)
    await p.evaluate(() => { const ids = S.habits.map(h => h.id); S.habits.forEach(h => { h.since = addDays(TODAY, -20); });
      for (let k = 20; k >= 1; k--) S.checks[addDays(TODAY, -k)] = k > 13 ? ids.slice(0, 1) : ids; save(); goPath(); });
    await p.waitForTimeout(300);
    const fc = await p.evaluate(() => ({ rows: [...document.querySelectorAll('#v-path .fcr')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      cmp: (document.querySelector('#v-path .pcmp') || {}).textContent || '', pace: Math.round(pace()), big: document.querySelector('#v-path .pgrow .big').textContent, closed: stats().closed,
      next: RANKS[rankOf(levelOf(totalXP())) + 1][1] }));
    (fc.pace > 0 && fc.rows.length === 2 && fc.rows[0].includes(fc.next) && /Магнат/.test(fc.rows[1]) && fc.rows.every(r => /≈ \d+ д/.test(r)))
      ? ok(`срок в темпе ${fc.pace} ⭐/день: ${fc.rows.join(' · ')}`) : bad('срок: ' + JSON.stringify(fc));
    (/первая неделя 33% → последние 7 дней 100%/.test(fc.cmp)) ? ok('дисциплина: первая неделя 33% → последние 7 дней 100%') : bad('сравнение недель: ' + fc.cmp);
    (fc.closed >= 14 && fc.big === `+${Math.round((Math.pow(1.01, fc.closed) - 1) * 100)}%`) ? ok(`рост по правилу 1%: ${fc.closed} закрытых дней → ${fc.big}`) : bad('рост: ' + JSON.stringify({ c: fc.closed, big: fc.big }));
    errCheck(p, 'путь магната');
    await ctx.close();
  }
  // данные: S.les переживает копию, мусор отсеивается, у старых данных поля нет — пустой список
  {
    const { ctx, p } = await newPage(b, { width: 320, height: 640 });
    await p.goto(URL); await p.waitForTimeout(300);
    await startClean(p);
    const d = await p.evaluate(() => {
      const junk = normalize({ ...JSON.parse(JSON.stringify(S)), les: ['x', 0, 99, 3, 3, 2.5, '5'] }).les.join();
      const old = { ...JSON.parse(JSON.stringify(S)) }; delete old.les;
      S.les = [4, 1]; const a = JSON.stringify(S), back = JSON.stringify(normalize(JSON.parse(a)));
      return { junk, old: JSON.stringify(normalize(old).les), round: a === back, last: Object.keys(normalize(old)).slice(-1)[0] };
    });
    (d.junk === '3,5' && d.old === '[]' && d.round) ? ok('уроки в данных: мусор отсеян (3,5), старые данные — [], копия проходит круг байт в байт')
      : bad('данные уроков: ' + JSON.stringify(d));
    await p.evaluate(() => { S.les = [1]; save(); goPath(); }); await p.waitForTimeout(300);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    w.sw <= w.w ? ok('путь без прокрутки вбок на 320') : bad(`путь на 320 шире экрана: ${w.sw}`);
    errCheck(p, 'данные пути');
    await ctx.close();
  }

  // ---------- 1к. Книги владельца, урок 1 на старте, пройденное по паспорту урока (06.10.2026) ----------
  // Владелец: «акцент книгами Дэвида Гоггинса… Вавилон, трансерфинг реальности, 48 законов власти,
  // счастливый карман полный денег». Проход клиентом: урок — главное, а новичок его не видел (ниже
  // первого экрана). Пройденное хранится по id урока: порядок пути меняли — у людей ничего не сбилось
  console.log('\n1к) Книги владельца, урок 1 сразу после старта, пройденное по id урока');
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 844 });
    await p.goto(URL); await p.waitForTimeout(400);
    const how = await p.$$eval('.how > div', e => e.map(x => x.textContent).join(' | '));
    (/Гоггинс/.test(how) && /Вавилон/.test(how) && /48\u00a0законов власти/.test(how)) ? ok('приветствие называет книги: Гоггинс, «Вавилон», «48 законов власти»') : bad('приветствие: ' + how);
    await p.click('#obFresh'); await p.waitForSelector('#hpGo', { timeout: 3000 });
    await p.click('#hpGo'); await p.waitForTimeout(500);
    const f = await p.evaluate(() => { const m = document.querySelector('.lesm'); return m && { h: m.querySelector('h4').textContent,
      hint: (m.querySelector('.lfirst') || {}).textContent || '', ovl: document.querySelectorAll('.ovl').length,
      fits: m.getBoundingClientRect().bottom <= innerHeight, habits: S.habits.length }; });
    (f && f.h === 'Правило 1%' && f.ovl === 1 && f.habits === 3) ? ok('после «Начать» сразу урок 1 «Правило 1%», привычки уже созданы') : bad('после «Начать»: ' + JSON.stringify(f));
    (f && /на каждом уровне/.test(f.hint) && /карточку уровня на Обзоре/.test(f.hint)) ? ok('подсказка: урок на каждом уровне, все — в «Пути» через карточку уровня (она есть и на 320, значок в шапке там скрыт)') : bad('подсказка: ' + JSON.stringify(f && f.hint));
    (f && f.fits) ? ok('окно первого урока целиком на экране 390×844') : bad('окно первого урока не влезает');
    await p.click('.lesm .ok'); await p.waitForTimeout(300);
    // тот же урок из пути — уже без подсказки новичка
    await p.click('#lvlChip'); await p.waitForTimeout(300);
    await p.click('#v-path [data-les="1"]'); await p.waitForTimeout(300);
    const again = await p.evaluate(() => !!document.querySelector('.lesm .lfirst'));
    !again ? ok('из «Пути» урок открывается без подсказки новичка') : bad('подсказка новичка не к месту');
    await p.click('.lesm .ok'); await p.waitForTimeout(200);
    // содержимое: книги, которые назвал владелец; Гоггинс — акцент, и он рано
    const c = await p.evaluate(() => {
      const nb = re => LESSONS.filter(l => re.test(l.b)).length;
      return { n: LESSONS.length, gog: LESSONS.filter(l => /Гоггинс/.test(l.a)).length,
        gogEarly: LESSONS.slice(0, 14).filter(l => /Гоггинс/.test(l.a)).length,
        zel: nb(/Трансерфинг/), gr: nb(/48 законов власти/), bab: nb(/Вавилон/), pocket: nb(/Счастливый карман/),
        trial: LESSONS.slice(0, 4).map(l => l.b),
        ids: LESSONS.map(l => l.id), map: Object.fromEntries(LESSONS.map(l => [l.id, l.t])),
        // мысль книги своими словами, а не простыня; задание — на один день; тире настоящие
        style: LESSONS.filter(l => l.t.length > 24 || l.i.length < 150 || l.i.length > 240 || l.p.length > 80 || / - /.test(l.t + l.i + l.p) || /\.$/.test(l.p)).map(l => l.t),
        banned: LESSONS.filter(l => /Маркарян/i.test(l.a + l.b + l.i + l.p)).map(l => l.t),
        // одна книга — одно название: у Гоггинса было «Меня не сломить» рядом с «Меня не сломать»
        twoNames: Object.entries(LESSONS.reduce((m, l) => ((m[l.a] = m[l.a] || new Set()).add(l.b), m), {})).filter(([, v]) => v.size > 1).map(([a, v]) => a + ': ' + [...v].join(' / ')) };
    });
    (c.gog >= 5 && c.gogEarly >= 3) ? ok(`Гоггинс — акцент: ${c.gog} уроков, ${c.gogEarly} из них в первых 14`) : bad('Гоггинс: ' + JSON.stringify({ gog: c.gog, early: c.gogEarly }));
    (c.zel >= 2 && c.gr >= 3 && c.bab >= 5 && c.pocket >= 1) ? ok(`книги владельца: «Трансерфинг» ${c.zel}, «48 законов власти» ${c.gr}, «Вавилон» ${c.bab}, «Счастливый карман» ${c.pocket}`)
      : bad('книги: ' + JSON.stringify({ zel: c.zel, gr: c.gr, bab: c.bab, pocket: c.pocket }));
    // пробные 7 дней — это уроки 1–4: в них Гоггинс, «Вавилон» и «Трансерфинг»
    (c.trial.some(b => /Меня не сломать/.test(b)) && c.trial.some(b => /Вавилон/.test(b)) && c.trial.some(b => /Трансерфинг/.test(b)))
      ? ok('первые 4 урока (неделя новичка): Гоггинс, «Вавилон», «Трансерфинг»') : bad('первые 4 урока: ' + c.trial.join(' | '));
    !c.style.length ? ok(`все ${c.n} уроков по мерке: название ≤ 24, мысль 150–240 знаков, задание ≤ 80, тире «—»`) : bad('не по мерке: ' + c.style.join(', '));
    !c.banned.length ? ok('авторов с уголовными делами нет') : bad('нельзя: ' + c.banned.join(', '));
    !c.twoNames.length ? ok('у каждого автора одна книга под одним названием') : bad('книга под двумя названиями: ' + c.twoNames.join('; '));
    // паспорта: уникальные целые; 1–24 — ровно те уроки, что были 06.10 (иначе у людей сменилось бы пройденное)
    const FROZEN = { 1: 'Правило 1%', 2: 'Голос за себя', 3: 'Заплати сначала себе', 4: 'Знай, куда уходят деньги', 5: 'Актив или пассив',
      6: 'Точная цель', 7: 'Круг влияния', 8: 'Пока не умею', 9: 'Дневник успехов', 10: 'Петля привычки', 11: 'Съешь лягушку',
      12: 'Сначала главное', 13: 'Глубокая работа', 14: 'Правило 40%', 15: 'Накопительный эффект', 16: 'Сила воли — мышца',
      17: 'Принцип 80/20', 18: 'Боль + разбор = рост', 19: 'Деньги-работники', 20: 'Защищай капитал', 21: 'Время — главный процент',
      22: 'Расти в цене', 23: 'Мастермайнд', 24: 'Начинай с конца' };
    const idsOk = c.ids.every(Number.isInteger) && new Set(c.ids).size === c.ids.length;
    const lost = Object.entries(FROZEN).filter(([id, t]) => c.map[id] !== t).map(([id, t]) => `${id} ${t} → ${c.map[id]}`);
    (idsOk && !lost.length) ? ok(`паспорта уроков уникальны; 1–24 — прежние уроки 06.10`) : bad('паспорта: ' + JSON.stringify({ idsOk, lost }));
    // старые данные: «пройден урок 2» значило «Голос за себя» — он и отмечен, где бы ни стоял сейчас
    const mv = await p.evaluate(() => { S.les = normalize({ ...JSON.parse(JSON.stringify(S)), les: [2] }).les; save(); render();
      const at = LESSONS.findIndex(l => l.id === 2) + 1;
      return { at, doneThere: lesDone(at), doneAt2: at === 2 || lesDone(2), xp: totalXP(), pick: lessonPick(1),
        row: document.querySelector('#lesRow').textContent };
    });
    (mv.doneThere && (mv.at === 2 || !mv.doneAt2) && mv.xp === 20 && mv.pick === 1 && /Правило 1%/.test(mv.row))
      ? ok(`пройденное по паспорту: «Голос за себя» (теперь урок ${mv.at}) отмечен, на его старом месте — нет, опыт +20`) : bad('перенос пройденного: ' + JSON.stringify(mv));
    // закрытая ступень говорит, из каких книг её уроки; конец пути — сколько книг
    await p.evaluate(() => goPath()); await p.waitForTimeout(300);
    const pt = await p.evaluate(() => ({ bk: [...document.querySelectorAll('#v-path .stg-bk')].map(e => e.parentElement.textContent),
      end: document.querySelector('#v-path .pend').textContent, nb: new Set(LESSONS.map(l => l.b)).size,
      sw: document.documentElement.scrollWidth, w: innerWidth }));
    (pt.bk.length === 4 && pt.bk.every(t => /^\d+ урок(а|ов)? из книг: «/.test(t)) && pt.bk.join().includes('«48\u00a0законов власти»'))
      ? ok('у закрытых ступеней — «N уроков из книг: …», среди них «48 законов власти»') : bad('книги ступеней: ' + JSON.stringify(pt.bk));
    (pt.end.includes(`${c.n} уроков из ${pt.nb} книг`)) ? ok(`конец пути: «${c.n} уроков из ${pt.nb} книг»`) : bad('конец пути: ' + pt.end);
    pt.sw <= pt.w ? ok('путь без прокрутки вбок') : bad(`путь шире экрана: ${pt.sw}`);
    errCheck(p, 'книги и паспорта уроков');
    await ctx.close();
  }
  // самое длинное окно урока на 320×568 — прокручивается, кнопки достижимы, вбок не едет
  {
    const { ctx, p } = await newPage(b, { width: 320, height: 568 });
    await p.goto(URL); await p.waitForTimeout(300);
    await startClean(p);
    const longest = await p.evaluate(() => { let k = 0; LESSONS.forEach((l, i) => { if ((l.i + l.p).length > (LESSONS[k].i + LESSONS[k].p).length) k = i; });
      S.les = []; S.checks = {}; for (let d = 1; d <= 400; d++) S.checks[addDays(TODAY, -d)] = S.habits.map(h => h.id);
      S.habits.forEach(h => { h.since = addDays(TODAY, -400); }); save(); render(); document.querySelectorAll('.ovl').forEach(o => o.remove()); return k + 1; });
    await p.evaluate(n => openLesson(n), longest); await p.waitForTimeout(300);
    const fit = await p.evaluate(() => { const ok = document.querySelector('.lesm .ok'); ok.scrollIntoView({ block: 'nearest' });
      const r = ok.getBoundingClientRect(); return { vis: r.bottom <= innerHeight && r.top >= 0, sw: document.documentElement.scrollWidth, w: innerWidth }; });
    (fit.vis && fit.sw <= fit.w) ? ok(`самый длинный урок (${longest}) на 320×568: «Готово» достижимо, вбок не едет`) : bad('длинный урок на 320: ' + JSON.stringify(fit));
    errCheck(p, 'длинный урок на 320');
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

  // 2б) пример 1-го числа: до 02.10.2026 он кончался вчерашним днём, и 1-го числа
  // любого месяца календарь и «Топ привычек» были пустыми — новичок видел мёртвый пример.
  // Часы ставим на 1-е число явно, иначе проверка краснеет раз в месяц и молчит остальные дни.
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await ctx.clock.install({ time: new Date(2026, 10, 1, 12, 0) });   // 1 ноября, полдень
    await p.goto(URL); await p.waitForTimeout(400);
    await p.click('#obDemo'); await p.waitForTimeout(400);
    const today = await p.evaluate(() => ({ t: TODAY, n: (S.checks[TODAY] || []).length }));
    await p.click('.tab[data-t="habits"]'); await p.waitForTimeout(400);
    const marks = await p.$$eval('.cday.full, .cday.part', els => els.length);
    const fill = await p.$$eval('.pfill', els => els.filter(e => e.getBoundingClientRect().width >= 1).length);
    (today.t.endsWith('-01') && today.n > 0 && marks > 0 && fill > 0)
      ? ok(`пример 1-го числа (${today.t}) живой: сегодня ${today.n} отметки, в календаре ${marks}, полосок «Топ» ${fill}`)
      : bad('пример 1-го числа пустой: ' + JSON.stringify({ ...today, marks, fill }));
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

  // 4б) чужая «копия данных» с HTML вместо текста не выполняет код (02.10.2026). До этого
  // категория трат в легенде «Финансов» и значок награды вставлялись без esc(): копия,
  // присланная кем-то «загрузи мои привычки», запускала скрипт на странице Магната
  {
    const { ctx, p } = await newPage(b, { width: 390, height: 900 });
    await p.goto(URL);
    const evil = { habits: [{ id: 1, ico: '', name: 'Тест' }], checks: {}, rv: 2,
      finance: { income: 0, entries: [{ id: 1, type: 'out', cat: '<img src=x onerror="window.__xss=1">', amount: 100, date: '2026-01-01' }] },
      rewards: [{ id: 1, ico: '<img src=x onerror="window.__xss=2">', name: 'Награда', n: 5 }] };
    await p.evaluate(d => { const t = new Date(), ds = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`;
      d.finance.entries[0].date = ds; localStorage.setItem('magnat_app_v2', JSON.stringify(d)); }, evil);
    await p.reload(); await p.waitForTimeout(400);
    for (const t of ['money', 'shop']) { await p.click(`.tab[data-t="${t}"]`); await p.waitForTimeout(300); }
    const r = await p.evaluate(() => ({ xss: window.__xss || 0, shown: [...document.querySelectorAll('#shopGrid .si .i')].map(e => e.textContent) }));
    (!r.xss && r.shown.some(s => s.includes('<img'))) ? ok('чужая копия с HTML: код не выполнен, показан как текст')
      : bad('чужая копия с HTML выполнила код: ' + JSON.stringify(r));
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
    // цель спрашивают в той же форме (с 30.09.2026 она больше не ставится сама «вес − 3»)
    await p.fill('.modal input >> nth=0', '80'); await p.fill('.modal input >> nth=1', '77');
    await p.click('.modal .ok'); await p.waitForTimeout(400);

    // вес есть, профиля нет — предлагают заполнить
    const prompt = await p.$eval('#v-body', e => e.textContent.includes('Заполнить профиль'));
    prompt ? ok('без профиля предлагают его заполнить') : bad('нет приглашения заполнить профиль');

    // заполняем профиль
    await p.click('#editProf'); await p.waitForTimeout(300);
    const inputs = await p.$$('.modal input');
    await inputs[0].fill('180'); await inputs[1].fill('1990');
    await p.click('.modal .ok'); await p.waitForTimeout(400);

    // Миффлин — Сан Жеор вручную: 10*80 + 6.25*180 - 5*36 + 5 = 1750 (муж, 2026-1990=36)
    // цель 77, до неё 3 кг → дефицит 8% + 1,5%×3 = 12,5%; активность без тренировок = 1.2
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

// Слияние данных merge3(база, своё, чужое) — ворота выпуска (11.10.2026).
// Две вкладки уже сейчас, два устройства — после входа по почте: всё, что сливается, проходит
// через одну чистую функцию в app.html. Здесь — таблица случаев на каждое правило и блок
// свойств: 300 случайных раундов с сидом, действия — функциями приложения или их зеркалом.
// Страница — file://, сервер не нужен. Весь файл укладывается меньше чем в 60 секунд.
const fs = require('fs'), path = require('path');
const { chromium, chromePath, APP_DIR, APP_URL } = require('./lib');
let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗ FAIL:', m); };
const t0 = Date.now();
const J = JSON.stringify;
const clone = (x) => JSON.parse(J(x));

// база для таблицы: три привычки, две награды. Остальное normalize дополнит сам
const BASE = {
  habits: [{ id: 1, ico: '', name: 'Бег', since: '' }, { id: 2, ico: '', name: 'Чтение', since: '' }, { id: 3, ico: '', name: 'Вода', since: '' }],
  checks: { '2026-10-01': [1, 2] }, tasks: [], taskBank: 0, finance: { income: 0, entries: [] }, body: {},
  rewards: [{ id: 1, ico: '📱', name: '30 минут TikTok', n: 5 }, { id: 2, ico: '🎮', name: 'Час игр', n: 5 }],
  rv: 2, boughtCnt: {}, spent: 0, les: [], chal: { d: '', k: 0, n: 0 }, rev: {},
};
const D = '2026-10-05';
// копия базы с правкой: mod(B, s => { ... })
const mod = (src, fn) => { const s = clone(src); fn(s); return s; };

(async () => {
  const b = await chromium.launch({ executablePath: chromePath() });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await p.goto(APP_URL); await p.waitForTimeout(300);
  const m3 = (bb, l, r, lsv, rsv) => p.evaluate(([bb, l, r, lsv, rsv]) => merge3(bb, l, r, lsv, rsv), [bb, l, r, lsv, rsv]);
  const norm = (x) => p.evaluate(x => normalize(x), x);
  const B = await norm(BASE);

  // ---------- 1. Тождества и общее правило ----------
  console.log('\n1) Тождества: одинаковые стороны, одна сторона без изменений');
  {
    const x = mod(B, s => { s.checks[D] = [3]; s.tasks.push({ id: 5, name: 'Задача', prio: 'hi', due: D, done: true }); s.spent = 100; s.boughtCnt = { 1: 1 }; });
    const nx = await norm(x);
    J(await m3(B, x, x)) === J(nx) ? ok('merge3(b, x, x) = x') : bad('merge3(b,x,x) ≠ x');
    J(await m3(B, B, x)) === J(nx) ? ok('merge3(b, b, r) = r') : bad('merge3(b,b,r) ≠ r');
    J(await m3(B, x, B)) === J(nx) ? ok('merge3(b, l, b) = l') : bad('merge3(b,l,b) ≠ l');
    // пример целиком: 8 привычек, 8 недель отметок, задачи, финансы, уроки
    const seedDoc = await p.evaluate(() => normalize(seed()));
    const e = await p.evaluate(sd => { const m = merge3(sd, sd, sd); return J(m) === J(normalize(sd)); function J(v) { return JSON.stringify(v); } }, seedDoc);
    e ? ok('пример приложения: merge3(x, x, x) = x байт в байт') : bad('пример приложения не проходит тождество');
  }

  // ---------- 2. Привычки и отметки ----------
  console.log('\n2) Привычки и отметки');
  {
    // удаление побеждает переименование и новые отметки
    const l = mod(B, s => { s.habits = s.habits.filter(h => h.id !== 1); s.checks['2026-10-01'] = [2]; });
    const r = mod(B, s => { s.habits[0].name = 'Бег 5 км'; s.checks[D] = [1, 3]; });
    let M = await m3(B, l, r);
    (!M.habits.some(h => h.id === 1) && !Object.values(M.checks).some(a => a.includes(1)) && J(M.checks[D]) === '[3]')
      ? ok('удаление привычки сильнее переименования и новых отметок на другой стороне') : bad('удаление привычки: ' + J(M.habits) + ' ' + J(M.checks));
    // ячейка — 3-стороннее множество: снятое доходит, поставленное выживает
    const l2 = mod(B, s => { s.checks['2026-10-01'] = [2]; });
    const r2 = mod(B, s => { s.checks['2026-10-01'] = [1, 2, 3]; s.checks[D] = [2]; });
    M = await m3(B, l2, r2);
    (J(M.checks['2026-10-01']) === '[2,3]' && J(M.checks[D]) === '[2]') ? ok('отметки: снятая отметка уходит, поставленные с обеих сторон остаются')
      : bad('отметки: ' + J(M.checks));
    // since — более раннее; ico/name — общее правило; порядок — чужой, затем свои добавления
    const l3 = mod(B, s => { s.habits[1].since = '2026-09-01'; s.habits.push({ id: 200001, ico: '', name: 'Своя', since: '' }); });
    const r3 = mod(B, s => { s.habits[1].since = '2026-09-15'; s.habits[1].ico = '📚'; s.habits.reverse(); s.habits.push({ id: 300001, ico: '', name: 'Чужая', since: '' }); });
    M = await m3(B, l3, r3);
    const h2 = M.habits.find(h => h.id === 2);
    (h2.since === '2026-09-01' && h2.ico === '📚' && J(M.habits.map(h => h.id)) === '[3,2,1,300001,200001]')
      ? ok('since — более раннее, значок с другой стороны, порядок: чужой, затем свои новые') : bad('поля привычек: ' + J(M.habits));
    // один id добавлен обеими с разными именами — своя получает newHabitId() и уносит свои отметки
    const l4 = mod(B, s => { s.habits.push({ id: 500000, ico: '', name: 'Зал', since: '' }); s.checks[D] = [500000]; });
    const r4 = mod(B, s => { s.habits.push({ id: 500000, ico: '', name: 'Медитация', since: '' }); s.checks['2026-10-06'] = [500000]; });
    M = await m3(B, l4, r4);
    const zal = M.habits.find(h => h.name === 'Зал'), med = M.habits.find(h => h.name === 'Медитация');
    (med && med.id === 500000 && zal && zal.id !== 500000 && zal.id >= 100000 && J(M.checks[D]) === J([zal.id]) && J(M.checks['2026-10-06']) === '[500000]')
      ? ok(`коллизия id привычки: своя получила ${zal && zal.id}, её отметки переехали с ней`) : bad('коллизия привычек: ' + J({ h: M.habits, c: M.checks }));
    // тот же id и то же имя с обеих сторон — одна привычка
    const r5 = mod(B, s => { s.habits.push({ id: 500000, ico: '🏋️', name: 'зал ', since: '' }); s.checks['2026-10-06'] = [500000]; });
    M = await m3(B, l4, r5);
    (M.habits.filter(h => h.id === 500000).length === 1 && M.habits.length === 4 && J(M.checks[D]) === '[500000]' && J(M.checks['2026-10-06']) === '[500000]')
      ? ok('один id и одно имя с обеих сторон — одна привычка, отметки обеих') : bad('одинаковая новая привычка: ' + J(M.habits));
  }

  // ---------- 3. Задачи, вызовы, главное, копилка ----------
  console.log('\n3) Задачи: удаление и выполнение, вызовы дня, «главное», копилка');
  {
    const T = { id: 10, name: 'Отчёт', prio: 'md', due: D, done: false };
    const b1 = mod(B, s => { s.tasks = [T]; });
    let M = await m3(b1, mod(b1, s => { s.tasks = []; }), mod(b1, s => { s.tasks[0].done = true; }));
    (M.tasks.length === 1 && M.tasks[0].done) ? ok('удалили здесь, выполнили там — задача остаётся выполненной') : bad('выполнение против удаления: ' + J(M.tasks));
    M = await m3(b1, mod(b1, s => { s.tasks[0].done = true; }), mod(b1, s => { s.tasks = []; }));
    (M.tasks.length === 1 && M.tasks[0].done) ? ok('и наоборот: выполнили здесь, удалили там — выполнена') : bad('выполнение против удаления (2): ' + J(M.tasks));
    M = await m3(b1, mod(b1, s => { s.tasks[0].name = 'Отчёт v2'; }), mod(b1, s => { s.tasks = []; }));
    M.tasks.length === 0 ? ok('удаление сильнее правки без выполнения') : bad('удаление против правки: ' + J(M.tasks));
    // удалившая сторона сначала выполнила задачу (её 20 ушли в копилку), другая тоже выполнила —
    // задача возвращается выполненной, а 20 монет платятся один раз, а не дважды (ревью R0, 12.10)
    const paid = (x) => x.taskBank + x.tasks.filter(t => t.done).length * 20;
    const doneDel = mod(b1, s => { s.tasks = []; s.taskBank = 20; s.checks[D] = [1]; });
    const doneThere = mod(b1, s => { s.tasks[0].done = true; });
    const pd = [await m3(b1, doneDel, doneThere), await m3(b1, doneThere, doneDel)];
    pd.every(x => x.tasks.length === 1 && x.tasks[0].done && paid(x) === 20)
      ? ok('выполнил и удалил здесь, выполнил там: задача выполнена, монеты за неё — один раз (20, а не 40), в обе стороны')
      : bad('выполнение против удаления платит дважды: ' + J(pd.map(x => ({ t: x.tasks, bank: x.taskBank }))));
    M = await m3(b1, mod(b1, s => { s.tasks = []; s.taskBank = 0; }), doneThere);
    paid(M) === 20 ? ok('удалил без выполнения, выполнил там: копилка не уменьшается (20)') : bad('удаление без выполнения: ' + J({ t: M.tasks, bank: M.taskBank }));
    // в копилке удалившей стороны ещё и выполненная в базе и удалённая ею задача — её 20 не трогаем
    const b3 = mod(B, s => { s.tasks = [T, { id: 11, name: 'Старое', prio: 'md', due: D, done: true }]; s.taskBank = 0; });
    M = await m3(b3, mod(b3, s => { s.tasks = []; s.taskBank = 40; }), mod(b3, s => { s.tasks[0].done = true; }));
    (M.tasks.length === 1 && M.tasks[0].id === 10 && M.taskBank === 20) ? ok('копилка удалившей: 20 за выполненную в базе остаются, лишние 20 за вернувшуюся сняты')
      : bad('копилка с выполненной в базе: ' + J({ t: M.tasks, bank: M.taskBank }));
    // удалившая выполнила и удалила ДРУГУЮ задачу базы, а вернувшуюся удалила не выполняя:
    // её +20 в копилке — за другую, с вернувшейся не снимаем ничего (ревью R2), в обе стороны
    const b4 = mod(B, s => { s.tasks = [T, { id: 11, name: 'Купить X', prio: 'md', due: D, done: false }]; s.taskBank = 0; });
    const delOther = mod(b4, s => { s.tasks = []; s.taskBank = 20; }), doneT = mod(b4, s => { s.tasks[0].done = true; });
    const ob = [await m3(b4, delOther, doneT), await m3(b4, doneT, delOther)];
    ob.every(x => x.tasks.length === 1 && x.tasks[0].id === 10 && x.tasks[0].done && paid(x) === 40)
      ? ok('выполнил и удалил другую задачу, эту удалил не выполняя, там её выполнили: монеты за обе — 40, ничего не снято, в обе стороны')
      : bad('копилка за другую задачу снята с вернувшейся: ' + J(ob.map(x => ({ t: x.tasks, bank: x.taskBank, paid: paid(x) }))));
    const cb = mod(B, s => { s.tasks = [{ ...T, chal: true }]; s.chal = { d: D, k: 0, n: 2 }; });
    M = await m3(cb, mod(cb, s => { s.tasks = []; s.taskBank = 20; s.chal.n = 3; }), mod(cb, s => { s.tasks[0].done = true; s.chal.n = 3; }));
    (M.tasks.length === 1 && paid(M) === 20 && M.chal.n === 3) ? ok('то же с вызовом дня: монеты один раз и chal.n +1, а не +2')
      : bad('вызов: выполнение против удаления: ' + J({ t: M.tasks, bank: M.taskBank, n: M.chal.n }));
    // поля по общему правилу, chal/main — ИЛИ
    M = await m3(b1, mod(b1, s => { s.tasks[0].prio = 'hi'; }), mod(b1, s => { s.tasks[0].due = '2026-10-07'; s.tasks[0].main = true; }));
    (M.tasks[0].prio === 'hi' && M.tasks[0].due === '2026-10-07' && M.tasks[0].main === true) ? ok('правки задачи по полю: приоритет отсюда, срок и «главное» оттуда') : bad('поля задачи: ' + J(M.tasks));
    // выполненная в базе и удалённая обеими: в копилку по 20 с каждой стороны — одно лишнее вычитается
    const b2 = mod(B, s => { s.tasks = [{ ...T, done: true }]; s.taskBank = 40; });
    const gone = mod(b2, s => { s.tasks = []; s.taskBank = 60; });
    M = await m3(b2, gone, mod(gone, s => { s.checks[D] = [2]; }));
    (M.tasks.length === 0 && M.taskBank === 60) ? ok('копилка: выполненную удалили обе стороны → +20 один раз (60, а не 80)') : bad('копилка: ' + M.taskBank);
    M = await m3(mod(B, s => { s.taskBank = 10; }), mod(B, s => { s.taskBank = 30; }), mod(B, s => { s.taskBank = 50; }));
    M.taskBank === 70 ? ok('копилка: b + Δl + Δr (10 + 20 + 40)') : bad('копилка сумма: ' + M.taskBank);
    // вызовы дня: две выполненные копии на одну дату — одна, chal.n с поправкой
    const ch = (id, done) => ({ id, name: 'Вызов', prio: 'hi', due: D, done, chal: true });
    const bc = mod(B, s => { s.chal = { d: '', k: 0, n: 3 }; });
    M = await m3(bc, mod(bc, s => { s.tasks = [ch(2000, true)]; s.chal.n = 4; }), mod(bc, s => { s.tasks = [ch(1000, true)]; s.chal.n = 4; }));
    (M.tasks.length === 1 && M.tasks[0].id === 1000 && M.chal.n === 4) ? ok('«Беру» в один день на обоих, оба выполнены → один вызов (меньший id), chal.n +1') : bad('дубли вызовов: ' + J({ t: M.tasks, n: M.chal.n }));
    M = await m3(bc, mod(bc, s => { s.tasks = [ch(1000, false)]; }), mod(bc, s => { s.tasks = [ch(2000, true)]; s.chal.n = 4; }));
    (M.tasks.length === 1 && M.tasks[0].id === 2000 && M.tasks[0].done && M.chal.n === 4) ? ok('дубль вызова: остаётся выполненный, невыполненный уходит без поправки') : bad('дубль вызова (выполненный): ' + J({ t: M.tasks, n: M.chal.n }));
    const bc2 = mod(bc, s => { s.tasks = [ch(1500, false)]; });
    M = await m3(bc2, mod(bc2, s => { s.tasks[0].done = true; s.chal.n = 4; }), mod(bc2, s => { s.tasks[0].done = true; s.chal.n = 4; s.spent = 0; s.checks[D] = [3]; }));
    (M.tasks.length === 1 && M.chal.n === 4) ? ok('один вызов отмечен на обеих сторонах → chal.n +1, а не +2') : bad('вызов на обеих: ' + J({ t: M.tasks, n: M.chal.n }));
    M = await m3(bc, mod(bc, s => { s.tasks = [ch(2000, false)]; }), mod(bc, s => { s.tasks = [ch(1000, false)]; s.checks[D] = [1]; }));
    (M.tasks.length === 1 && M.tasks[0].id === 1000) ? ok('два невыполненных вызова на дату → один, с меньшим id') : bad('невыполненные вызовы: ' + J(M.tasks));
    const other = { id: 4000, name: 'Обычная', prio: 'md', due: D, done: false };
    M = await m3(mod(bc, s => { s.tasks = [ch(3000, false)]; }), mod(bc, s => { s.tasks = [ch(3000, false), ch(100, false)]; }), mod(bc, s => { s.tasks = [ch(3000, false), other]; }));
    (M.tasks.length === 2 && M.tasks.filter(t => t.chal).map(t => t.id).join() === '3000') ? ok('вызов из базы сильнее нового с меньшим id') : bad('вызов из базы: ' + J(M.tasks));
    // «главное»: одно на дату — из базы, иначе своё; второе становится обычной задачей, текст цел
    const mn = (id, name) => ({ id, name, prio: 'hi', due: D, done: false, main: true });
    M = await m3(B, mod(B, s => { s.tasks = [mn(300, 'Главное здесь')]; }), mod(B, s => { s.tasks = [mn(400, 'Главное там')]; }));
    (M.tasks.length === 2 && M.tasks.find(t => t.id === 300).main === true && !M.tasks.find(t => t.id === 400).main && M.tasks.some(t => t.name === 'Главное там'))
      ? ok('два «главных» на дату: своё остаётся главным, чужое — обычная задача с тем же текстом') : bad('главное: ' + J(M.tasks));
    const bm = mod(B, s => { s.tasks = [mn(1, 'Из базы')]; });
    M = await m3(bm, mod(bm, s => { s.tasks.push(mn(300, 'Новое здесь')); }), mod(bm, s => { s.tasks.push({ id: 500, name: 'Обычная', prio: 'md', due: D, done: false }); }));
    (M.tasks.find(t => t.id === 1).main === true && !M.tasks.find(t => t.id === 300).main) ? ok('«главное» из базы сильнее нового') : bad('главное из базы: ' + J(M.tasks));
    // коллизия id задачи — своей новый uid
    M = await m3(B, mod(B, s => { s.tasks = [{ id: 900, name: 'Моя', prio: 'md', due: D, done: false }]; }), mod(B, s => { s.tasks = [{ id: 900, name: 'Чужая', prio: 'md', due: D, done: false }]; }));
    const mine = M.tasks.find(t => t.name === 'Моя');
    (M.tasks.length === 2 && M.tasks.find(t => t.name === 'Чужая').id === 900 && mine && mine.id !== 900) ? ok('коллизия id задачи: своя получила новый uid') : bad('коллизия задач: ' + J(M.tasks));
  }

  // ---------- 4. Финансы, награды, покупки ----------
  console.log('\n4) Финансы, награды, покупки, потрачено');
  {
    const e = (id, amount, cat = '🍔 Еда') => ({ id, type: 'out', cat, amount, date: D });
    const bf = mod(B, s => { s.finance = { income: 50000, entries: [e(1, 100), e(2, 200)] }; });
    let M = await m3(bf, mod(bf, s => { s.finance.entries[0].amount = 150; s.finance.entries = s.finance.entries.filter(x => x.id !== 2); s.finance.entries.push(e(3, 300)); }),
                         mod(bf, s => { s.finance.entries[0].cat = '🛒 Продукты'; s.finance.entries[1].amount = 250; s.finance.entries.push(e(4, 400)); s.finance.income = 60000; }));
    const e1 = M.finance.entries.find(x => x.id === 1);
    (e1 && e1.amount === 150 && e1.cat === '🛒 Продукты' && !M.finance.entries.some(x => x.id === 2) && J(M.finance.entries.map(x => x.id)) === '[1,4,3]' && M.finance.income === 60000)
      ? ok('записи: по полю, удаление сильнее правки, добавления обеих (чужие, затем свои), доход — общее правило') : bad('финансы: ' + J(M.finance));
    M = await m3(B, mod(B, s => { s.finance.entries = [e(77, 10)]; }), mod(B, s => { s.finance.entries = [e(77, 20)]; }));
    (M.finance.entries.length === 2 && M.finance.entries.find(x => x.amount === 20).id === 77 && M.finance.entries.find(x => x.amount === 10).id !== 77)
      ? ok('коллизия id записи: своя получила новый uid') : bad('коллизия записей: ' + J(M.finance.entries));
    // награды: удаление сильнее правки; покупки по id — b + Δl + Δr; потрачено — так же
    const br = mod(B, s => { s.boughtCnt = { 1: 2, 2: 1 }; s.spent = 300; });
    M = await m3(br, mod(br, s => { s.boughtCnt[1] = 3; s.spent = 400; s.rewards = s.rewards.filter(w => w.id !== 2); delete s.boughtCnt[2]; }),
                     mod(br, s => { s.boughtCnt[1] = 4; s.boughtCnt[2] = 2; s.spent = 600; s.rewards[1].name = 'Два часа игр'; }));
    (M.boughtCnt['1'] === 5 && M.boughtCnt['2'] === undefined && !M.rewards.some(w => w.id === 2) && M.spent === 700)
      ? ok('покупки: 2+1+2 = 5, счётчик удалённой награды выброшен, награда удалена несмотря на правку; потрачено 300+100+300') : bad('награды: ' + J({ c: M.boughtCnt, r: M.rewards, s: M.spent }));
    M = await m3(br, mod(br, s => { s.rewards[0].n = 15; }), mod(br, s => { s.rewards[0].ico = '📺'; }));
    (M.rewards[0].n === 15 && M.rewards[0].ico === '📺') ? ok('награда: цена отсюда, значок оттуда') : bad('поля награды: ' + J(M.rewards[0]));
    // коллизия id награды — своей новый id, её счётчик покупок переезжает с ней
    M = await m3(B, mod(B, s => { s.rewards.push({ id: 777, ico: '☕', name: 'Кофе', n: 5 }); s.boughtCnt = { 777: 2 }; s.spent = 200; }),
                    mod(B, s => { s.rewards.push({ id: 777, ico: '🎬', name: 'Кино', n: 15 }); s.boughtCnt = { 777: 1 }; s.spent = 300; }));
    const cof = M.rewards.find(w => w.name === 'Кофе'), kino = M.rewards.find(w => w.name === 'Кино');
    (kino && kino.id === 777 && cof && cof.id !== 777 && M.boughtCnt['777'] === 1 && M.boughtCnt[String(cof.id)] === 2 && M.spent === 500)
      ? ok('коллизия id награды: своя получила новый id, «куплено ×2» переехало с ней') : bad('коллизия наград: ' + J({ r: M.rewards, c: M.boughtCnt }));
  }

  // ---------- 5. Уроки, вызов дня, разборы, мелкие поля ----------
  console.log('\n5) Уроки, вызов дня, разборы, rv/lastLv, «Тело», пример, незнакомые ключи');
  {
    const bl = mod(B, s => { s.les = [1, 3]; });
    let M = await m3(bl, mod(bl, s => { s.les = [3, 4]; }), mod(bl, s => { s.les = [1, 3, 6]; }));
    J(M.les) === '[3,6,4]' ? ok('уроки: 3-стороннее множество, порядок чужой, затем свои') : bad('уроки: ' + J(M.les));
    M = await m3(B, mod(B, s => { s.chal = { d: '2026-10-10', k: 2, n: 0 }; }), mod(B, s => { s.chal = { d: '2026-10-11', k: 0, n: 0 }; }));
    (M.chal.d === '2026-10-11' && M.chal.k === 0) ? ok('вызов дня: более поздний день') : bad('chal.d: ' + J(M.chal));
    M = await m3(B, mod(B, s => { s.chal = { d: '2026-10-11', k: 2, n: 0 }; }), mod(B, s => { s.chal = { d: '2026-10-11', k: 1, n: 0 }; }));
    M.chal.k === 2 ? ok('вызов дня: при равном дне — больший k') : bad('chal.k: ' + J(M.chal));
    // день вызова не уезжает назад, даже если одна сторона не менялась (часы другого телефона сбиты)
    const bk = mod(B, s => { s.chal = { d: '2026-10-11', k: 1, n: 0 }; }), back = mod(bk, s => { s.chal = { d: '2026-10-10', k: 2, n: 0 }; });
    const dk = [await m3(bk, bk, back), await m3(bk, back, bk), await m3(bk, mod(bk, s => { s.checks[D] = [2]; }), back)];
    dk.every(x => x.chal.d === '2026-10-11' && x.chal.k === 1) ? ok('вызов дня: более поздний день побеждает и против «не менялось» (§7), в обе стороны')
      : bad('chal.d уехал назад: ' + J(dk.map(x => x.chal)));
    const rv = { [D]: { g: 'Сделал', b: '' }, '2026-10-06': { g: 'x', b: 'y' }, '2026-10-07': { g: 'a', b: 'b' } };
    const bv = mod(B, s => { s.rev = rv; });
    M = await m3(bv, mod(bv, s => { delete s.rev[D]; delete s.rev['2026-10-06']; s.rev['2026-10-07'].g = 'a2'; }),
                     mod(bv, s => { s.rev[D].g = 'Сделал и проверил'; s.rev['2026-10-07'].b = 'b2'; }));
    (M.rev[D] && M.rev[D].g === 'Сделал и проверил' && !M.rev['2026-10-06'] && M.rev['2026-10-07'].g === 'a2' && M.rev['2026-10-07'].b === 'b2')
      ? ok('разборы: правка сильнее удаления, удаление без правки уходит, поля g/b сливаются по отдельности') : bad('разборы: ' + J(M.rev));
    M = await m3(B, mod(B, s => { s.lastLv = 3; s.rv = 2; }), mod(B, s => { s.lastLv = 5; s.rv = 3; }));
    (M.lastLv === 5 && M.rv === 3) ? ok('rv и lastLv — большее') : bad('rv/lastLv: ' + J({ rv: M.rv, l: M.lastLv }));
    M = await m3(B, mod(B, s => { s.body = { goalW: 70, log: [{ date: D, w: 80 }] }; }), mod(B, s => { s.body = { goalW: 90 }; }));
    let M2 = await m3(B, B, mod(B, s => { s.body = { goalW: 90 }; }));
    (M.body.goalW === 70 && M.body.log.length === 1 && M2.body.goalW === 0) ? ok('«Тело» всегда своё — и когда чужое менялось, а своё нет') : bad('тело: ' + J([M.body, M2.body]));
    M = await m3(B, mod(B, s => { s.demoData = true; s.checks[D] = [1]; }), B);
    M2 = await m3(null, mod(B, s => { s.demoData = true; }), mod(B, s => { s.demoData = true; }));
    (M.demoData === undefined && M2.demoData === undefined) ? ok('пометка примера (demoData) в итог не попадает') : bad('demoData: ' + J([M.demoData, M2.demoData]));
    // незнакомые ключи верхнего уровня — общее правило по JSON-равенству
    const bu = mod(B, s => { s.goals = [1]; s.old = 'x'; s.both = 1; });
    M = await m3(bu, mod(bu, s => { s.goals = [1, 2]; s.both = 2; s.mine = true; }), mod(bu, s => { delete s.old; s.both = 3; s.theirs = { a: 1 }; }));
    (J(M.goals) === '[1,2]' && M.old === undefined && M.both === 2 && M.mine === true && J(M.theirs) === '{"a":1}')
      ? ok('незнакомые ключи: правка, удаление, конфликт (своё), добавления обеих') : bad('незнакомые ключи: ' + J(M));
    // незнакомый ключ с тысячами вложенных [[[…]]] (кривая копия): normalize его не берёт, и
    // merge3 не падает переполнением стека; 32 уровня — берёт, 33 — нет (ревью R0, 12.10)
    const deep = await p.evaluate(() => {
      const nest = n => JSON.parse('['.repeat(n) + ']'.repeat(n));
      const out = { d32: 'd32' in normalize({ d32: nest(32) }), d33: 'd33' in normalize({ d33: nest(33) }),
                    str: 'txt' in normalize({ txt: '[[[[' + '['.repeat(100) }) };
      const base = normalize({}), l = { ...base, zz: nest(6000) }, r = { ...base, checks: { '2026-10-05': [1] } };
      try { const m = merge3(base, l, r); out.merged = !('zz' in m) && JSON.stringify(m.checks) === JSON.stringify(r.checks); }
      catch (e) { out.merged = 'упал: ' + e.message; }
      return out;
    });
    (deep.d32 && !deep.d33 && deep.str && deep.merged === true) ? ok('глубокий незнакомый ключ: 32 уровня — берётся, 33 и 6000 — нет, merge3 не падает; скобки внутри строки не считаются')
      : bad('глубокий ключ: ' + J(deep));
  }

  // ---------- 6. FIELD_SV: поле, которого не знает старая версия ----------
  console.log('\n6) FIELD_SV: сторона старой версии не стирает новое поле');
  {
    const bs = mod(B, s => { s.habits[0].sport = true; s.finance.income = 5000; });
    // старая версия не знает sport и income: её normalize их потерял, а заодно она переименовала привычку
    const old = mod(bs, s => { delete s.habits[0].sport; s.habits[0].name = 'Бег утром'; s.finance.income = 0; s.finance.entries = [{ id: 9, type: 'out', cat: '🍔 Еда', amount: 5, date: D }]; });
    const cur = mod(bs, s => { s.habits[1].name = 'Книга'; s.finance.entries = [{ id: 8, type: 'out', cat: '🍔 Еда', amount: 7, date: D }]; });
    const before = await m3(bs, old, cur);
    await p.evaluate(() => { FIELD_SV['habits[].sport'] = 2; FIELD_SV['finance.income'] = 2; });
    const asL = await m3(bs, old, cur, 1, 2), asR = await m3(bs, cur, old, 2, 1), both = await m3(bs, old, cur, 2, 2);
    await p.evaluate(() => { delete FIELD_SV['habits[].sport']; delete FIELD_SV['finance.income']; });
    const fx = M => ({ sp: M.habits.find(h => h.id === 1).sport, nm: M.habits.find(h => h.id === 1).name, inc: M.finance.income, n: M.finance.entries.length });
    (fx(before).sp === undefined && fx(before).inc === 0) ? ok('без FIELD_SV незнание старой стороны выглядит удалением (так и задумано проверить)') : bad('без FIELD_SV: ' + J(fx(before)));
    (fx(asL).sp === true && fx(asL).inc === 5000 && fx(asL).nm === 'Бег утром' && fx(asL).n === 2)
      ? ok('старая — своя сторона (lsv=1): sport и доход взяты из базы, её правки на месте') : bad('FIELD_SV своя: ' + J(fx(asL)));
    (fx(asR).sp === true && fx(asR).inc === 5000 && fx(asR).nm === 'Бег утром' && fx(asR).n === 2)
      ? ok('старая — чужая сторона (rsv=1): то же') : bad('FIELD_SV чужая: ' + J(fx(asR)));
    J(both) === J(before) ? ok('обе стороны новой версии — FIELD_SV не вмешивается') : bad('FIELD_SV при равных версиях меняет итог');
  }

  // ---------- 7. Без базы ----------
  console.log('\n7) Без базы: объединение, ничего не удаляется, счётчики — максимум');
  {
    const l = mod(B, s => {
      s.rewards = [{ id: 111, ico: '📱', name: '30 минут TikTok', n: 5 }, { id: 3, ico: '🍕', name: 'Пицца', n: 15 }]; s.boughtCnt = { 111: 2, 3: 1 };
      s.habits.push({ id: 400000, ico: '', name: 'Зарядка', since: '2026-10-03' }); s.checks[D] = [1, 400000];
      s.tasks = [{ id: 50, name: 'Купить хлеб', prio: 'md', due: D, done: true }]; s.spent = 400; s.taskBank = 20; s.chal.n = 2;
      s.les = [1]; s.rev = { [D]: { g: 'свой', b: '' } }; s.finance.income = 0; s.mine = 1;
    });
    const r = mod(B, s => {
      s.rewards = [{ id: 222, ico: '📱', name: '30 минут TikTok', n: 5 }]; s.boughtCnt = { 222: 3 };
      s.habits = [{ id: 7, ico: '', name: 'бег', since: '' }, { id: 400000, ico: '', name: 'Йога', since: '' }]; s.checks = { [D]: [7, 400000], '2026-10-06': [7] };
      s.tasks = [{ id: 60, name: 'Купить хлеб', prio: 'hi', due: D, done: false }, { id: 61, name: 'Другое', prio: 'md', due: D, done: false }];
      s.spent = 100; s.taskBank = 60; s.chal.n = 1; s.les = [3]; s.rev = { [D]: { g: '', b: 'чужой' } }; s.finance.income = 30000;
    });
    const M = await m3(null, l, r);
    const tik = M.rewards.filter(w => /TikTok/.test(w.name));
    (tik.length === 1 && tik[0].id === 222 && M.boughtCnt['222'] === 3 && M.rewards.some(w => w.name === 'Пицца'))
      ? ok('награда TikTok с разными id сопоставлена по имени: одна, покупки — максимум (3)') : bad('TikTok без базы: ' + J({ r: M.rewards, c: M.boughtCnt }));
    const run = M.habits.find(h => h.id === 7), zar = M.habits.find(h => h.name === 'Зарядка'), yoga = M.habits.find(h => h.name === 'Йога');
    (run && M.habits.filter(h => nk(h.name) === 'бег').length === 1 && zar && zar.id !== 400000 && yoga && yoga.id === 400000
      && J([...M.checks[D]].sort()) === J([7, 400000, zar.id].sort()) && J(M.checks['2026-10-06']) === '[7]' && M.habits.length === 5)
      ? ok('привычки по имени («Бег» = «бег»), коллизия id — новый id, все отметки обеих сторон на месте') : bad('привычки без базы: ' + J({ h: M.habits, c: M.checks }));
    (M.tasks.length === 2 && M.tasks.find(t => t.name === 'Купить хлеб').done && M.spent === 400 && M.taskBank === 60 && M.chal.n === 2)
      ? ok('задача по имени и сроку — одна и выполнена; потрачено, копилка, вызовы — максимум') : bad('без базы, задачи и счётчики: ' + J({ t: M.tasks, s: M.spent, tb: M.taskBank, n: M.chal.n }));
    (J(M.les) === '[3,1]' && M.rev[D].g === 'свой' && M.rev[D].b === 'чужой' && M.finance.income === 30000 && M.mine === 1)
      ? ok('уроки — объединение, разбор — непустое с каждой стороны, доход — непустая сторона, свои ключи целы') : bad('без базы, прочее: ' + J({ les: M.les, rev: M.rev, inc: M.finance.income }));
  }

  // ---------- 8. Свойства: 300 случайных раундов ----------
  console.log('\n8) Свойства на 300 случайных раундах (сид 20261011)');
  {
    const res = await p.evaluate(({ sd, rounds }) => {
      const J = JSON.stringify, clone = x => JSON.parse(J(x));
      let st = sd >>> 0;
      const rnd = () => { st = (st + 0x6D2B79F5) >>> 0; let t = st; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      const realRandom = Math.random; Math.random = rnd;            // newHabitId и uid тоже идут от сида
      const ri = n => Math.floor(rnd() * n), any = a => a[ri(a.length)];
      const days = Array.from({ length: 8 }, (_, i) => addDays(TODAY, -i));
      const keepS = S, out = { fail: [], rounds: 0, merges: 0, add: 0 };
      // база: пример приложения (8 привычек, 8 недель, задачи, финансы) плюс покупки, вызов и разборы
      const mkBase = () => {
        S = normalize(seed());
        S.habits = S.habits.slice(0, 3 + ri(5));
        S = normalize(S);
        if (rnd() < .5) { const w = any(S.rewards); S.boughtCnt[w.id] = 1 + ri(3); S.spent = rwCost(w) * S.boughtCnt[w.id]; }
        if (rnd() < .5) { S.tasks.push({ id: uid(), name: chalText(), prio: 'hi', due: TODAY, done: false, chal: true }); }
        if (rnd() < .3) dropTasks(t => t.done);
        if (rnd() < .5) S.rev[addDays(TODAY, -1)] = { g: 'вчера', b: '' };
        S.chal.n = ri(4);
        return normalize(S);
      };
      // действия — функции приложения (dropTasks, chalText/chalTask, rwCost, revs, newHabitId, uid) или их зеркало
      const ACTS = [
        (T) => { const h = any(S.habits); if (!h) return; const d = any(days), a = checksOf(d).slice(), i = a.indexOf(h.id);
                 if (i >= 0) a.splice(i, 1); else a.push(h.id); if (a.length) S.checks[d] = a; else delete S.checks[d]; T.add('h' + h.id); },
        (T) => { const id = newHabitId(); S.habits.push({ id, ico: '', name: 'П' + id, since: TODAY }); T.add('h' + id); },
        (T) => { const h = any(S.habits); if (!h) return; S.habits = S.habits.filter(x => x.id !== h.id);
                 for (const d in S.checks) { S.checks[d] = S.checks[d].filter(i => i !== h.id); if (!S.checks[d].length) delete S.checks[d]; } T.add('h' + h.id); },
        (T) => { const id = uid(); S.tasks.push({ id, name: 'З' + id, prio: any(['hi', 'md', 'lo']), due: TODAY, done: false }); T.add('t' + id); },
        (T) => { const t = any(S.tasks.filter(x => !x.chal)); if (!t) return; t.done = !t.done; T.add('t' + t.id); },
        (T) => { const t = any(S.tasks.filter(x => !x.chal)); if (!t) return; dropTasks(x => x.id === t.id); T.add('t' + t.id); },
        (T) => { let t = chalTask(); if (!t) { t = { id: uid(), name: chalText(), prio: 'hi', due: TODAY, done: false, chal: true }; S.tasks.push(t); }
                 if (!t.done) { t.done = true; chalSt().n = (chalSt().n || 0) + 1; } T.add('chal'); },
        (T) => { const w = any(S.rewards); if (!w) return; S.boughtCnt[w.id] = (S.boughtCnt[w.id] || 0) + 1; S.spent += rwCost(w); T.add('w' + w.id); },
        (T) => { const w = any(S.rewards); if (!w) return; S.rewards = S.rewards.filter(x => x.id !== w.id); delete S.boughtCnt[w.id]; T.add('w' + w.id); },
        (T) => { const id = uid(); S.rewards.push({ id, ico: '🎁', name: 'Н' + id, n: any([5, 15, 40]) }); T.add('w' + id); },
        (T) => { const id = uid(); S.finance.entries.push({ id, type: any(['in', 'out']), cat: '🍔 Еда', amount: 1 + ri(5000), date: TODAY }); T.add('e' + id); },
        (T) => { const e = any(S.finance.entries); if (!e) return; S.finance.entries = S.finance.entries.filter(x => x.id !== e.id); T.add('e' + e.id); },
        (T) => { const L = any(LESSONS.slice(0, 12)), i = S.les.indexOf(L.id); if (i >= 0) S.les.splice(i, 1); else S.les.push(L.id); T.add('l' + L.id); },
        (T) => { const d = any(days); revs()[d] = { g: 'итог ' + ri(100), b: rnd() < .5 ? 'мешало' : '' }; T.add('r' + d); },
      ];
      const side = (b) => { S = clone(b); const T = new Set(), n = ri(7); for (let i = 0; i < n; i++) any(ACTS)(T); return { d: normalize(S), T }; };
      // кошелёк без множителя серии и бонуса уровня: они нелинейны, а сумма проверяется по слагаемым
      const flat = d => Object.values(d.checks).reduce((a, x) => a + x.length, 0) * COIN + d.tasks.filter(t => t.done).length * TASKCOIN + d.taskBank + d.les.length * TASKCOIN - d.spent;
      const F = (m) => { if (out.fail.length < 8) out.fail.push(m); };
      const ids = a => new Set(a.map(x => x.id));
      for (let k = 0; k < rounds; k++) {
        const b = mkBase(), L = side(b), R = side(b), l = L.d, r = R.d;
        out.rounds++;
        if (J(merge3(b, l, l)) !== J(l)) F(k + ': merge3(b,x,x) ≠ x');
        if (J(merge3(b, b, r)) !== J(r)) F(k + ': merge3(b,b,r) ≠ r');
        if (J(merge3(b, l, b)) !== J(l)) F(k + ': merge3(b,l,b) ≠ l');
        const M = merge3(b, l, r); out.merges += 4;
        if (J(normalize(JSON.parse(J(M)))) !== J(M)) F(k + ': normalize(M) не проходит круг байт в байт');
        // добавленное одной стороной и не удалённое другой — на месте
        for (const [X, Y, TY] of [[l, r, R.T], [r, l, L.T]]) {
          const bH = ids(b.habits), bT = ids(b.tasks), bE = ids(b.finance.entries), bW = ids(b.rewards);
          // и обратное: удалённое одной стороной, которое другая не трогала, — не вернулось
          const xH = ids(X.habits), xT = ids(X.tasks), xE = ids(X.finance.entries), xW = ids(X.rewards);
          for (const h of b.habits) if (!xH.has(h.id) && !TY.has('h' + h.id) && M.habits.some(m => m.id === h.id)) F(k + ': удалённая привычка вернулась');
          for (const t of b.tasks) if (!xT.has(t.id) && !TY.has('t' + t.id) && !t.chal && M.tasks.some(m => m.id === t.id)) F(k + ': удалённая задача вернулась');
          for (const e of b.finance.entries) if (!xE.has(e.id) && !TY.has('e' + e.id) && M.finance.entries.some(m => m.id === e.id)) F(k + ': удалённая запись вернулась');
          for (const w of b.rewards) if (!xW.has(w.id) && !TY.has('w' + w.id) && M.rewards.some(m => m.id === w.id)) F(k + ': удалённая награда вернулась');
          for (const h of X.habits) if (!bH.has(h.id) && !M.habits.some(m => m.name === h.name)) F(k + ': пропала новая привычка ' + h.name);
          for (const t of X.tasks) if (!bT.has(t.id) && !t.chal && !M.tasks.some(m => m.id === t.id || (m.name === t.name && m.due === t.due))) F(k + ': пропала новая задача ' + t.name);
          for (const e of X.finance.entries) if (!bE.has(e.id) && !M.finance.entries.some(m => m.amount === e.amount && m.date === e.date && m.type === e.type)) F(k + ': пропала новая запись');
          for (const w of X.rewards) if (!bW.has(w.id) && !M.rewards.some(m => m.name === w.name)) F(k + ': пропала новая награда ' + w.name);
          for (const id of X.les) if (!b.les.includes(id) && !M.les.includes(id)) F(k + ': пропал урок ' + id);
          for (const d in X.rev) if (!b.rev[d] && !M.rev[d]) F(k + ': пропал разбор ' + d);
          for (const d in X.checks) for (const id of X.checks[d]) {
            const inB = (b.checks[d] || []).includes(id), h = X.habits.find(x => x.id === id), mh = h && M.habits.find(m => m.name === h.name);
            if (!inB && mh && !(M.checks[d] || []).includes(mh.id)) F(k + ': пропала новая отметка ' + d + '/' + h.name);
          }
        }
        // стороны трогали разное — кошелёк (без серии и уровня) = b + Δl + Δr
        if (![...L.T].some(x => R.T.has(x))) {
          out.add++;
          const want = flat(b) + (flat(l) - flat(b)) + (flat(r) - flat(b));
          if (flat(M) !== want) F(k + ': кошелёк ' + flat(M) + ' ≠ b + Δl + Δr = ' + want);
        }
        // без базы: все ячейки обеих сторон на месте (по имени привычки), счётчики не меньше максимума
        const N = merge3(null, l, r); out.merges++;
        if (J(normalize(JSON.parse(J(N)))) !== J(N)) F(k + ': без базы normalize не проходит круг');
        for (const X of [l, r]) {
          for (const d in X.checks) for (const id of X.checks[d]) {
            const h = X.habits.find(x => x.id === id), mh = N.habits.find(m => m.name.toLowerCase() === h.name.toLowerCase());
            if (!mh || !(N.checks[d] || []).includes(mh.id)) { F(k + ': без базы пропала отметка ' + d + '/' + h.name); break; }
          }
          for (const h of X.habits) if (!N.habits.some(m => m.name.toLowerCase() === h.name.toLowerCase())) F(k + ': без базы пропала привычка');
          for (const w of X.rewards) if (!N.rewards.some(m => m.name === w.name)) F(k + ': без базы пропала награда');
          for (const e of X.finance.entries) if (!N.finance.entries.some(m => m.amount === e.amount && m.date === e.date && m.type === e.type && m.cat === e.cat)) F(k + ': без базы пропала запись');
          for (const t of X.tasks) if (!t.chal && !N.tasks.some(m => m.name === t.name && m.due === t.due)) F(k + ': без базы пропала задача');
          for (const w of X.rewards) { const c = X.boughtCnt[w.id] || 0, m = N.rewards.find(x => x.name === w.name); if (c && (!m || (N.boughtCnt[m.id] || 0) < c)) F(k + ': без базы покупок меньше'); }
        }
        if (N.spent < Math.max(l.spent, r.spent) || N.taskBank < Math.max(l.taskBank, r.taskBank) || N.chal.n < Math.max(l.chal.n, r.chal.n)) F(k + ': без базы счётчики меньше максимума');
      }
      Math.random = realRandom; S = keepS;
      return out;
    }, { sd: 20261011, rounds: 300 });
    res.rounds === 300 ? ok(`300 раундов, ${res.merges} слияний; кошелёк проверен по слагаемым в ${res.add} раундах, где стороны трогали разное`) : bad('раундов: ' + res.rounds);
    res.fail.length ? res.fail.forEach(f => bad('свойство: ' + f))
      : ok('тождества, «добавленное не пропадает», кошелёк b + Δl + Δr, круг normalize, слияние без базы — во всех раундах');
    res.add >= 30 ? ok('раундов с разными элементами достаточно для проверки суммы: ' + res.add) : bad('мало раундов для суммы: ' + res.add);
  }

  // ---------- 9. sw.js не трогает /api/ ----------
  console.log('\n9) sw.js: /api/ мимо воркера, кэш новой версии');
  {
    const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
    const at = sw.indexOf('startsWith("/api/")'), resp = sw.indexOf('respondWith');
    (/const CACHE = "magnat-app-v4"/.test(sw) && at > 0 && at < resp && /if \(url\.pathname\.startsWith\("\/api\/"\)\) return;/.test(sw))
      ? ok('sw.js: запросы /api/ возвращаются до respondWith, CACHE magnat-app-v4') : bad('sw.js: нет обхода /api/ или старый CACHE');
  }

  errs.length ? bad('ошибки страницы: ' + errs.join(' | ')) : ok('страница без ошибок');
  const sec = (Date.now() - t0) / 1000;
  sec < 60 ? ok(`весь файл — ${sec.toFixed(1)} с (меньше 60)`) : bad(`слишком долго: ${sec.toFixed(1)} с`);
  await b.close();
  console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : '\n=== ВСЁ ЗЕЛЁНОЕ ===');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('  ✗ FAIL: набор упал: ' + (e && e.stack || e)); process.exit(1); });

function nk(s) { return String(s).trim().toLowerCase(); }

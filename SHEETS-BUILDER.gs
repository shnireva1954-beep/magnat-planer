/**
 * МАГНАТ · Генератор 5 планеров для Google Таблиц
 * ------------------------------------------------
 * Как запустить (5 минут, подробно — в SHEETS-INSTALL.md):
 *   1. Открой script.google.com → «Создать проект».
 *   2. Удали заготовку, вставь ВЕСЬ этот файл, нажми 💾.
 *   3. Вверху выбери функцию buildAll и нажми «Выполнить».
 *   4. Разреши доступ своему аккаунту (Дополнительно → Перейти).
 *   5. Открой Google Диск → папка «Магнат · Планеры» — там 5 таблиц.
 *
 * Скрипт создаёт таблицы по ТЗ SHEETS-SPEC.md: дашборды с KPI,
 * диаграммами, тепловой картой, инсайтами; рабочие листы с чекбоксами;
 * скрытый лист _calc с формулами; защиту от случайного стирания формул;
 * демо-данные относительно сегодняшней даты (их легко стереть).
 *
 * Формулы записываются в международном синтаксисе — Google сам покажет
 * их по-русски (СУММПРОИЗВ и т.д.), локаль файла ставится ru_RU.
 */

var PAL = {
  grn: '#12a565', gold: '#c98a12', red: '#e0556a', vio: '#7a52d0', blu: '#2f8fd8',
  head: '#eef2f8', grid: '#e0e6ef', ink: '#212a36', mut: '#5b6b82', mut2: '#8a97a8',
  grnb: '#e2f6ec', goldb: '#fdf1d7', redb: '#fbe9ec', blub: '#e3f0fb',
  insight: '#fdf7e7', insightBd: '#f0e2b6', gray: '#eef2f7'
};
var LVL_N = '{0;300;1500;5000;15000}';
var LVL_T = '{"🐣 Новичок";"🚀 Стартапер";"💼 Предприниматель";"🏢 Директор";"👑 Магнат"}';
var MONDAY = 'TODAY()-WEEKDAY(TODAY(),2)'; // понедельник = MONDAY+1 … вс = MONDAY+7
var DAYS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function buildAll() {
  var folder = getFolder_('Магнат · Планеры');
  var links = [];
  links.push(buildHabits_(folder));
  links.push(buildTasks_(folder));
  links.push(buildBody_(folder));
  links.push(buildWeek_(folder));
  links.push(buildFinance_(folder));
  Logger.log('ГОТОВО! Таблицы в папке «Магнат · Планеры»:\n' + links.join('\n'));
}

/* ==================== ОБЩИЕ ХЕЛПЕРЫ ==================== */

function getFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Создаёт файл с нужными листами (все листы сразу, чтобы ссылки между ними не давали #REF!). */
function makeFile_(name, folder, sheetNames) {
  var ss = SpreadsheetApp.create(name);
  // КРИТИЧНО: формулы пишутся с запятыми (международный вид), поэтому на время
  // сборки файл держим в локали en_US, где запятая — разделитель аргументов.
  // Под ru_RU setFormula парсит запятую как ДЕСЯТИЧНЫЙ разделитель и все формулы
  // с аргументами превращаются в #ERROR!. В конце сборки finishFile_ переключает
  // файл на ru_RU: формулы хранятся канонически и не ломаются, а отображение
  // становится русским (запятая-десятичный, «40 000 ₽», «15 янв»).
  try { ss.setSpreadsheetLocale('en_US'); } catch (e) {}
  var first = ss.getSheets()[0];
  first.setName(sheetNames[0]);
  for (var i = 1; i < sheetNames.length; i++) ss.insertSheet(sheetNames[i]);
  try { DriveApp.getFileById(ss.getId()).moveTo(folder); } catch (e) { Logger.log('Не удалось перенести в папку: ' + e); }
  return ss;
}

/** Финал сборки файла: переключить на русскую локаль (формулы уже записаны и не ломаются). */
function finishFile_(ss) {
  SpreadsheetApp.flush();
  try { ss.setSpreadsheetLocale('ru_RU'); } catch (e) { Logger.log('Локаль ru_RU: ' + e); }
}

/** Оформление дашборда: сетка-«клеточки» видна (владельцу так живее),
    узкая колонка A, контентные B..I. */
function dashBase_(sh, tabColor) {
  sh.setHiddenGridlines(false);   // сетка видна — справа не белая пустота, а клетки
  sh.setTabColor(tabColor);
  sh.setColumnWidth(1, 16);
  sh.setColumnWidths(2, 8, 112);
  sh.setRowHeight(1, 34);
}

/** Заголовок дашборда: B1 название, H1:I1 показатель справа. */
function dashTitle_(sh, text, accent, rightFormula, rightColor) {
  sh.getRange('B1:F1').merge().setValue(text)
    .setFontSize(13).setFontWeight('bold').setFontColor(PAL.ink).setVerticalAlignment('middle');
  sh.getRange('B1').setBorder(null, true, null, null, null, null, accent, SpreadsheetApp.BorderStyle.SOLID_THICK);
  sh.getRange('H1:I1').merge().setFormula(rightFormula)
    .setFontSize(13).setFontWeight('bold').setFontColor(rightColor)
    .setHorizontalAlignment('right').setVerticalAlignment('middle');
}

/** Маленькая серая подпись-заголовок блока. */
function label_(sh, a1, text) {
  sh.getRange(a1).setValue(text.toUpperCase())
    .setFontSize(8).setFontWeight('bold').setFontColor(PAL.mut2);
}

/**
 * KPI-плитка 2 колонки × 3 строки: подпись / значение / бейдж.
 * col — левая колонка плитки (2,4,6,8 для четырёх плиток).
 */
function kpi_(sh, row, col, title, valueF, badgeF, accent, badgeBg, badgeColor) {
  var r1 = sh.getRange(row, col, 1, 2).merge().setValue(title.toUpperCase())
    .setFontSize(8).setFontWeight('bold').setFontColor(PAL.mut2);
  var r2 = sh.getRange(row + 1, col, 1, 2).merge().setFontSize(15).setFontWeight('bold').setFontColor(PAL.ink);
  if (String(valueF).charAt(0) === '=') r2.setFormula(valueF); else r2.setValue(valueF);
  var r3 = sh.getRange(row + 2, col, 1, 2).merge().setFontSize(9).setFontColor(badgeColor).setBackground(badgeBg);
  if (String(badgeF).charAt(0) === '=') r3.setFormula(badgeF); else r3.setValue(badgeF);
  var block = sh.getRange(row, col, 3, 2);
  block.setBackground('#ffffff').setVerticalAlignment('middle');
  r3.setBackground(badgeBg);
  block.setBorder(true, true, true, true, false, false, PAL.grid, SpreadsheetApp.BorderStyle.SOLID);
  block.setBorder(null, true, null, null, null, null, accent, SpreadsheetApp.BorderStyle.SOLID_THICK);
  sh.setRowHeight(row, 18); sh.setRowHeight(row + 1, 26); sh.setRowHeight(row + 2, 18);
}

/** Инсайт-строка «💡 …» на светло-жёлтом. */
function insight_(sh, row, formula) {
  var r = sh.getRange(row, 2, 1, 8).merge().setFormula(formula)
    .setBackground(PAL.insight).setFontColor(PAL.mut).setFontSize(10)
    .setWrap(true).setVerticalAlignment('middle');
  r.setBorder(true, true, true, true, false, false, PAL.insightBd, SpreadsheetApp.BorderStyle.SOLID);
  sh.setRowHeight(row, 42);
}

/** Шапка таблицы данных. */
function header_(sh, row, col, titles) {
  var r = sh.getRange(row, col, 1, titles.length);
  r.setValues([titles]).setBackground(PAL.head).setFontColor(PAL.mut)
    .setFontWeight('bold').setFontSize(9);
  r.setBorder(true, true, true, true, true, true, PAL.grid, SpreadsheetApp.BorderStyle.SOLID);
}

/** Блок «Старт за 60 секунд» на листе настроек. */
function starterBlock_(sh, row, lines) {
  sh.getRange(row, 1, 1, 4).merge().setValue('🚀 СТАРТ ЗА 60 СЕКУНД')
    .setFontWeight('bold').setFontSize(11).setFontColor(PAL.ink);
  for (var i = 0; i < lines.length; i++) {
    sh.getRange(row + 1 + i, 1, 1, 4).merge().setValue((i + 1) + '. ' + lines[i])
      .setFontColor(PAL.mut).setFontSize(10);
  }
}

/** Защита листа: предупреждение при правке всего, кроме ячеек ввода. */
function protectWarn_(sh, unprotectedA1s) {
  try {
    var p = sh.protect().setWarningOnly(true);
    if (unprotectedA1s && unprotectedA1s.length) {
      p.setUnprotectedRanges(unprotectedA1s.map(function (a1) { return sh.getRange(a1); }));
    }
  } catch (e) { Logger.log('Защита ' + sh.getName() + ': ' + e); }
}

/** Лист _calc: предупреждение, серый фон, скрыть. */
function finishCalc_(sh) {
  sh.getRange('A1').setValue('⚙️ Служебные формулы. Не редактируй — сломается дашборд.')
    .setFontWeight('bold').setFontColor(PAL.red);
  protectWarn_(sh, null);
  try { sh.hideSheet(); } catch (e) {}
}

/** Безопасная вставка диаграммы: ошибка одной диаграммы не валит сборку. */
function chartSafe_(sh, builder, what) {
  try { sh.insertChart(builder.build()); }
  catch (e) { Logger.log('Диаграмма «' + what + '» не создалась (добавь вручную): ' + e); }
}

/** Условное форматирование: добавить правило к листу. */
function addRule_(sh, rule) {
  var rules = sh.getConditionalFormatRules();
  rules.push(rule);
  sh.setConditionalFormatRules(rules);
}

/* ==================== 1. ПРИВЫЧКИ — «ШТАБ ДИСЦИПЛИНЫ» ==================== */

function buildHabits_(folder) {
  var ss = makeFile_('Магнат · Привычки', folder, ['📊 Дашборд', 'Привычки', 'История', 'Настройки', '_calc']);
  var dash = ss.getSheetByName('📊 Дашборд'),
      data = ss.getSheetByName('Привычки'),
      hist = ss.getSheetByName('История'),
      set  = ss.getSheetByName('Настройки'),
      calc = ss.getSheetByName('_calc');

  /* ---- Настройки ---- */
  set.setTabColor(PAL.mut2);
  set.getRange('A1').setValue('⚙️ Настройки «Штаба дисциплины»').setFontWeight('bold').setFontSize(13);
  starterBlock_(set, 3, [
    'Впиши свои привычки и цену каждой в монетах (таблица ниже).',
    'Ставь галочки на листе «Привычки» — каждая даёт монеты.',
    'Дни подряд дают серию и множитель до ×2.',
    'Смотри лист «📊 Дашборд» — там уровень, карта месяца и инсайты.',
    'Не редактируй серые ячейки — в них формулы.'
  ]);
  header_(set, 10, 1, ['Привычка', 'Монет за день']);
  set.getRange('A11:B15').setValues([
    ['🏋️ Тренировка', 25], ['📚 Час на дело', 25], ['💰 Шаг к деньгам', 30],
    ['🧊 Холодный душ', 20], ['💧 Вода 2 литра', 15]
  ]);
  set.getRange('A17').setValue('Минимум привычек для зачёта дня в серию');
  set.getRange('B17').setValue(3);
  set.getRange('A19').setValue('Уровни (справочно):').setFontColor(PAL.mut);
  set.getRange('A20:B24').setValues([
    ['🐣 Новичок', 0], ['🚀 Стартапер', 300], ['💼 Предприниматель', 1500],
    ['🏢 Директор', 5000], ['👑 Магнат', 15000]
  ]).setFontColor(PAL.mut);
  set.setColumnWidth(1, 260); set.setColumnWidth(2, 120);
  ss.setNamedRange('HABIT_NAMES', set.getRange('A11:A15'));
  ss.setNamedRange('HABIT_PRICES', set.getRange('B11:B15'));
  ss.setNamedRange('MIN_DONE', set.getRange('B17'));

  /* ---- Лист Привычки: чекбоксы 5×31 ---- */
  data.setTabColor(PAL.grn);
  var dhead = ['Привычка'];
  for (var d = 1; d <= 31; d++) dhead.push(d);
  dhead.push('%');
  header_(data, 1, 1, dhead);
  for (var h = 0; h < 5; h++) {
    data.getRange(2 + h, 1).setFormula('=IF(Настройки!A' + (11 + h) + '="","",Настройки!A' + (11 + h) + ')');
    data.getRange(2 + h, 33).setFormula('=IFERROR(COUNTIF(B' + (2 + h) + ':AF' + (2 + h) + ',TRUE)/MAX(1,MIN(DAY(TODAY()),31)),0)')
      .setNumberFormat('0%').setFontWeight('bold').setFontColor(PAL.vio);
  }
  var boxes = data.getRange('B2:AF6');
  boxes.insertCheckboxes();
  seedHabitChecks_(data);
  data.setFrozenRows(1); data.setFrozenColumns(1);
  data.setColumnWidth(1, 160);
  data.setColumnWidths(2, 31, 30);
  data.setColumnWidth(33, 52);
  // зачтённые дни подсвечивать не нужно — карта на дашборде; лёгкая зебра:
  addRule_(data, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=B2=TRUE').setBackground(PAL.grnb)
    .setRanges([boxes]).build());

  /* ---- История ---- */
  hist.setTabColor(PAL.mut2);
  header_(hist, 1, 1, ['Месяц', 'Монеты', '% месяца', 'Лучшая серия']);
  hist.getRange('A2').setNote('В конце месяца перенеси сюда итоги с дашборда и очисти галочки — начнётся новый месяц.');
  hist.setColumnWidths(1, 4, 130);

  /* ---- _calc: дни месяца ---- */
  // A дата · B галочек · C % дня · D зачтён · E серия · F монеты · G множитель · H монеты× · I день недели
  calc.getRange('A2:I2').setValues([['Дата', 'Галочек', '% дня', 'Зачтён', 'Серия', 'Монеты', 'Множ.', 'Монеты ×', 'ДН']]);
  var f = [];
  for (var i = 0; i < 31; i++) {
    var r = 3 + i, day = i + 1;
    f.push([
      '=IF(' + day + '>DAY(EOMONTH(TODAY(),0)),"",DATE(YEAR(TODAY()),MONTH(TODAY()),' + day + '))',
      '=IF($A' + r + '="","",IF($A' + r + '>TODAY(),"",COUNTIF(INDEX(Привычки!$B$2:$AF$6,0,' + day + '),TRUE)))',
      '=IF($B' + r + '="","",IFERROR($B' + r + '/COUNTA(HABIT_NAMES),0))',
      '=IF($B' + r + '="","",IF($B' + r + '>=MIN_DONE,1,0))',
      (i === 0 ? '=IF($D3="","",IF($D3=1,1,0))'
               : '=IF($D' + r + '="","",IF($D' + r + '=1,N($E' + (r - 1) + ')+1,0))'),
      '=IF($B' + r + '="","",SUMPRODUCT(--INDEX(Привычки!$B$2:$AF$6,0,' + day + '),HABIT_PRICES))',
      '=IF($F' + r + '="","",MIN(2,1+0.1*N($E' + (r - 1) + ')))',
      '=IF($F' + r + '="","",ROUND($F' + r + '*$G' + r + '))',
      '=IF($A' + r + '="","",WEEKDAY($A' + r + ',2))'
    ]);
  }
  calc.getRange(3, 1, 31, 9).setFormulas(f);
  // сводные
  var K = {
    'K2': '=IFERROR(VLOOKUP(TODAY(),A3:E33,5,FALSE),0)',                       // серия
    'K3': '=MIN(2,1+0.1*K2)',                                                  // множитель
    'K4': '=IFERROR(N(VLOOKUP(TODAY(),A3:H33,8,FALSE)),0)',                    // монеты сегодня
    'K5': '=SUM(H3:H33)',                                                      // монеты месяца
    'K6': '=LOOKUP(K5,' + LVL_N + ',' + LVL_T + ')',                           // уровень
    'K7': '=MATCH(K5,' + LVL_N + ')',                                          // индекс уровня
    'K8': '=K5-INDEX(' + LVL_N + ',K7)',                                       // монет внутри уровня
    'K9': '=IF(K7>=5,1,INDEX({300;1500;5000;15000},K7)-INDEX({0;300;1500;5000},K7))',
    'K10': '=IF(K7>=5,"максимум",INDEX({"🚀 Стартапер";"💼 Предприниматель";"🏢 Директор";"👑 Магнат"},K7))',
    'K11': '=IF(K7>=5,0,INDEX({300;1500;5000;15000},K7)-K5)',                  // осталось монет
    'K12': '=IFERROR(INDEX({"понедельник";"вторник";"среда";"четверг";"пятница";"суббота";"воскресенье"},MATCH(MAX(M3:M9),M3:M9,0)),"")',
    'K13': '=IFERROR(MAX(M3:M9),0)',
    'K14': '=IF(K5=0,"Отмечай привычки — здесь появятся инсайты недели","Твой сильный день — "&K12&" ("&TEXT(K13,"0%")&"). Ещё 1 день серии — и множитель вырастет до "&TEXT(MIN(2,1.1+0.1*K2),"0.0")&".")',
    // пончик месяца
    'N2': '=SUM(B3:B33)',
    'N3': '=MAX(0,COUNTA(HABIT_NAMES)*MIN(DAY(TODAY()),DAY(EOMONTH(TODAY(),0)))-N2)',
    'P2': '=IFERROR(N2/MAX(1,N2+N3),0)'
  };
  for (var a1 in K) calc.getRange(a1).setFormula(K[a1]);
  calc.getRange('M2').setValue('ср.% по дням недели');
  for (var w = 0; w < 7; w++) {
    calc.getRange(3 + w, 13).setFormula('=IFERROR(AVERAGEIFS($C$3:$C$33,$I$3:$I$33,' + (w + 1) + '),0)');
  }
  calc.getRange('M10:M11').setValues([['Выполнено'], ['Осталось']]); // подписи пончика
  calc.getRange('M10').offset(0, 1).setFormula('=N2'); // N10
  calc.getRange('M11').offset(0, 1).setFormula('=N3'); // N11

  /* ---- Дашборд ---- */
  dashBase_(dash, PAL.grn);
  dashTitle_(dash, '✅ ШТАБ ДИСЦИПЛИНЫ', PAL.grn, '=TEXT(_calc!P2,"0%")', PAL.grn);
  kpi_(dash, 3, 2, 'Серия', '="🔥 "&_calc!K2&" дн"',
    '=IF(_calc!K2>=3,"огонь, держи темп",IF(_calc!K2>0,"разгоняемся","начни сегодня"))',
    PAL.gold, PAL.goldb, '#a5720a');
  kpi_(dash, 3, 4, 'Множитель', '="×"&TEXT(_calc!K3,"0.0")', 'максимум ×2', PAL.grn, PAL.gray, PAL.mut);
  kpi_(dash, 3, 6, 'Сегодня', '="+"&_calc!K4&" 🪙"',
    '=IF(_calc!K4>0,"монеты капают","поставь галочку")', PAL.gold, PAL.grnb, '#0d7a4c');
  kpi_(dash, 3, 8, 'Уровень', '=_calc!K6',
    '=IF(_calc!K7>=5,"вершина империи","до «"&_calc!K10&"» — "&TEXT(_calc!K11,"#,##0")&" 🪙")',
    PAL.vio, PAL.gray, PAL.mut);

  label_(dash, 'B7', 'Кривая прогресса · % по дням');
  label_(dash, 'H7', 'Месяц');
  // диаграммы: область + пончик (строки 8–16 под ними)
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.AREA)
    .addRange(calc.getRange('A3:A33')).addRange(calc.getRange('C3:C33'))
    .setPosition(8, 2, 0, 6)
    .setOption('width', 540).setOption('height', 180)
    .setOption('colors', [PAL.grn]).setOption('legend', { position: 'none' })
    .setOption('vAxis', { format: 'percent' }), 'Кривая прогресса');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.PIE)
    .addRange(calc.getRange('M10:N11'))
    .setPosition(8, 8, 0, 6)
    .setOption('width', 210).setOption('height', 180)
    .setOption('pieHole', 0.62).setOption('colors', [PAL.grn, '#e9edf3'])
    .setOption('legend', { position: 'none' }).setOption('pieSliceText', 'none'), 'Пончик месяца');
  for (var rr = 8; rr <= 16; rr++) dash.setRowHeight(rr, 20);

  label_(dash, 'B18', 'Карта активности · месяц');
  dash.getRange('C19:I19').setValues([DAYS_RU]).setFontSize(8)
    .setFontColor(PAL.mut2).setFontWeight('bold').setHorizontalAlignment('center');
  // тепловая карта C20:I25: n = 1..42, idx = n − (WEEKDAY 1-го − 1)
  var offExpr = '(WEEKDAY(DATE(YEAR(TODAY()),MONTH(TODAY()),1),2)-1)';
  var heatF = [];
  for (var hr = 0; hr < 6; hr++) {
    var rowF = [];
    for (var hc = 0; hc < 7; hc++) {
      var n = hr * 7 + hc + 1;
      var idx = '(' + n + '-' + offExpr + ')';
      rowF.push('=IFERROR(IF(OR(' + idx + '<1,' + idx + '>DAY(EOMONTH(TODAY(),0))),"",INDEX(_calc!$C$3:$C$33,' + idx + ')),"")');
    }
    heatF.push(rowF);
  }
  var heat = dash.getRange('C20:I25');
  // светло-серый фон всей сетки: пустые/будущие дни — часть календаря (стиль
  // GitHub-графика), а не белая дыра. Активные дни красит шкала цвета сверху.
  heat.setFormulas(heatF).setNumberFormat(';;;').setBackground(PAL.gray)
    .setBorder(true, true, true, true, true, true, '#ffffff', SpreadsheetApp.BorderStyle.SOLID_THICK);
  for (var hrr = 20; hrr <= 25; hrr++) dash.setRowHeight(hrr, 16);
  // «сегодня» — светло-золотая заливка (правило выше шкалы цвета)
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(C20<>"",(ROW(C20)-20)*7+COLUMN(C20)-2-' + offExpr + '=DAY(TODAY()))')
    .setBackground('#f3c94e').setRanges([heat]).build());
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue(PAL.gray, SpreadsheetApp.InterpolationType.NUMBER, '0')
    .setGradientMaxpointWithValue(PAL.grn, SpreadsheetApp.InterpolationType.NUMBER, '1')
    .setRanges([heat]).build());

  label_(dash, 'B27', 'Эта неделя');
  dash.getRange('C28:I28').setValues([DAYS_RU]).setFontSize(8)
    .setFontColor(PAL.mut2).setFontWeight('bold').setHorizontalAlignment('center');
  for (var wh = 0; wh < 5; wh++) {
    dash.getRange(29 + wh, 2).setFormula('=IF(INDEX(HABIT_NAMES,' + (wh + 1) + ')="","",INDEX(HABIT_NAMES,' + (wh + 1) + '))').setFontSize(10);
    for (var wc = 1; wc <= 7; wc++) {
      var dExpr = MONDAY + '+' + wc;
      dash.getRange(29 + wh, 2 + wc).setFormula(
        '=IF(' + dExpr + '>TODAY(),"",IF(MONTH(' + dExpr + ')<>MONTH(TODAY()),"—",' +
        'IFERROR(IF(INDEX(Привычки!$B$2:$AF$6,' + (wh + 1) + ',DAY(' + dExpr + '))=TRUE,"✓","·"),"·")))'
      ).setHorizontalAlignment('center').setFontSize(10);
    }
  }
  var weekR = dash.getRange('C29:I33');
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('✓').setBackground(PAL.grnb).setFontColor('#0d7a4c')
    .setRanges([weekR]).build());

  dash.getRange('B35').setFormula('=_calc!K6').setFontWeight('bold').setFontSize(10);
  dash.getRange('C35:E35').merge().setFormula(
    '=IFERROR(SPARKLINE(_calc!K8,{"charttype","bar";"max",MAX(1,_calc!K9);"color1","#12a565"}),"")');
  dash.getRange('F35:I35').merge().setFormula(
    '=IF(_calc!K7>=5,"👑 Максимальный уровень достигнут",TEXT(_calc!K8,"#,##0")&" / "&TEXT(_calc!K9,"#,##0")&" 🪙 до уровня «"&_calc!K10&"»")')
    .setFontSize(9).setFontColor(PAL.mut);
  insight_(dash, 37, '="💡 "&_calc!K14');

  finishCalc_(calc);
  protectWarn_(dash, null);
  protectWarn_(data, ['B2:AF6']);
  protectWarn_(set, ['A11:B15', 'B17']);
  protectWarn_(hist, ['A2:D100']);
  finishFile_(ss);
  Logger.log('Привычки: ' + ss.getUrl());
  return 'Привычки: ' + ss.getUrl();
}

/** Демо-галочки: последние 6 дней зачтены (серия 6), пара пропусков раньше. */
function seedHabitChecks_(data) {
  var D = new Date().getDate();
  var vals = data.getRange('B2:AF6').getValues(); // [привычка][день]
  for (var d = 1; d <= Math.min(D, 31); d++) {
    var n; // сколько привычек выполнено в день d
    if (d === Math.max(1, D - 6)) n = 2;            // день-пропуск: серия начинается после него
    else if (d === 4 && D > 10) n = 1;              // ранний слабый день
    else n = 3 + (d % 3);                            // 3..5
    if (d === D) n = Math.max(n, 4);                 // сегодня — бодро
    for (var k = 0; k < Math.min(n, 5); k++) {
      var habit = (d + k) % 5;
      vals[habit][d - 1] = true;
    }
  }
  data.getRange('B2:AF6').setValues(vals);
}

/* ==================== 2. ЗАДАЧИ — «ЦЕНТР ЗАДАЧ» ==================== */

function buildTasks_(folder) {
  var ss = makeFile_('Магнат · Задачи', folder, ['📊 Дашборд', 'Задачи', 'Архив', 'Настройки', '_calc']);
  var dash = ss.getSheetByName('📊 Дашборд'),
      data = ss.getSheetByName('Задачи'),
      arch = ss.getSheetByName('Архив'),
      set  = ss.getSheetByName('Настройки'),
      calc = ss.getSheetByName('_calc');
  var PRIOS = ['Срочно', 'Высокий', 'Средний', 'Низкий'];

  /* ---- Настройки ---- */
  set.setTabColor(PAL.mut2);
  set.getRange('A1').setValue('⚙️ Настройки «Центра задач»').setFontWeight('bold').setFontSize(13);
  starterBlock_(set, 3, [
    'Пиши задачи на листе «Задачи»: название, срок, приоритет.',
    'Выполнил — ставь галочку и дату выполнения (для статистики).',
    'Просрочка подсвечивается красным сама.',
    'Раз в неделю переноси выполненные в «Архив» (вырезать → вставить).',
    'Не редактируй колонку «Осталось» — в ней формула.'
  ]);

  /* ---- Задачи ---- */
  data.setTabColor(PAL.gold);
  header_(data, 1, 1, ['Задача', 'Срок', 'Приоритет', '✓', 'Дата вып.', 'Осталось']);
  var t = new Date();
  function dPlus(n) { return new Date(t.getFullYear(), t.getMonth(), t.getDate() + n); }
  data.getRange('A2:E6').setValues([
    ['🎬 Смонтировать ролик', dPlus(0), 'Высокий', false, ''],
    ['✍️ Написать 5 сценариев', dPlus(1), 'Средний', false, ''],
    ['📚 Прочитать 20 страниц', dPlus(-1), 'Низкий', true, dPlus(-1)],
    ['💸 Оплатить кредитку', dPlus(-1), 'Срочно', false, ''],
    ['📞 Позвонить маме', dPlus(3), 'Средний', false, '']
  ]);
  data.getRange('D2:D200').insertCheckboxes();
  data.getRange('D2:D6').setValues([[false], [false], [true], [false], [false]]);
  var fRem = [];
  for (var r = 2; r <= 200; r++) {
    fRem.push(['=IF($A' + r + '="","",IF($D' + r + '=TRUE,"✓",IF($B' + r + '="","—",$B' + r + '-TODAY())))']);
  }
  data.getRange(2, 6, 199, 1).setFormulas(fRem);
  data.getRange('C2:C200').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(PRIOS, true).setAllowInvalid(false).build());
  data.getRange('B2:B200').setNumberFormat('d MMM');
  data.getRange('E2:E200').setNumberFormat('d MMM');
  data.setFrozenRows(1);
  data.setColumnWidth(1, 260); data.setColumnWidths(2, 5, 100);
  // УФ: просрочка / выполнено / пилюли приоритетов
  var all = data.getRange('A2:F200');
  addRule_(data, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($A2<>"",$D2=FALSE,$B2<>"",$B2<TODAY())')
    .setFontColor(PAL.red).setRanges([all]).build());
  addRule_(data, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2=TRUE')
    .setFontColor('#9aa6b4').setStrikethrough(true).setRanges([all]).build());
  var prioR = data.getRange('C2:C200');
  [['Срочно', PAL.redb, '#c0344a'], ['Высокий', PAL.redb, '#c0344a'],
   ['Средний', PAL.goldb, '#a5720a'], ['Низкий', PAL.blub, '#1d6fb0']].forEach(function (p) {
    addRule_(data, SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(p[0]).setBackground(p[1]).setFontColor(p[2]).setRanges([prioR]).build());
  });

  /* ---- Архив (демо для графика «закрыто по дням») ---- */
  arch.setTabColor(PAL.mut2);
  header_(arch, 1, 1, ['Задача', 'Срок', 'Приоритет', '✓', 'Дата вып.']);
  var demo = ['🧾 Отправить отчёт', '🛒 Купить продукты', '📮 Ответить на письма', '🧹 Разобрать стол',
              '📈 Обновить таблицу трат', '🎨 Обложка для ролика', '📖 Конспект главы', '🔧 Починить кран',
              '🚗 Записаться на ТО', '💬 Созвон с командой', '🏦 Перевести накопления', '📝 План на неделю'];
  var rows = [];
  for (var i = 0; i < demo.length; i++) {
    var back = [1, 1, 2, 3, 3, 3, 4, 5, 5, 6, 8, 9][i]; // дней назад
    rows.push([demo[i], dPlus(-back), PRIOS[(i + 2) % 4], true, dPlus(-back)]);
  }
  arch.getRange(2, 1, rows.length, 5).setValues(rows);
  arch.getRange('D2:D100').insertCheckboxes();
  arch.getRange(2, 4, rows.length, 1).setValue(true);
  arch.getRange('B2:B100').setNumberFormat('d MMM');
  arch.getRange('E2:E100').setNumberFormat('d MMM');
  arch.setColumnWidth(1, 260);

  /* ---- _calc ---- */
  calc.getRange('A2:A8').setValues(DAYS_RU.map(function (x) { return [x]; }));
  for (var w = 0; w < 7; w++) {
    calc.getRange(2 + w, 2).setFormula(
      '=COUNTIF(Задачи!$E$2:$E$500,' + MONDAY + '+' + (w + 1) + ')+COUNTIF(Архив!$E$2:$E$500,' + MONDAY + '+' + (w + 1) + ')');
  }
  var C = {
    'B10': '=COUNTIFS(Задачи!A2:A500,"<>",Задачи!D2:D500,FALSE)',
    'B11': '=COUNTIFS(Задачи!A2:A500,"<>",Задачи!D2:D500,FALSE,Задачи!B2:B500,"<>",Задачи!B2:B500,"<"&TODAY())',
    'B12': '=COUNTIFS(Задачи!E2:E500,">="&TODAY()-6)+COUNTIFS(Архив!E2:E500,">="&TODAY()-6)',
    'B13': '=IFERROR((SUMPRODUCT((Задачи!$E$2:$E$500<>"")*(Задачи!$B$2:$B$500<>"")*(Задачи!$E$2:$E$500<=Задачи!$B$2:$B$500))+SUMPRODUCT((Архив!$E$2:$E$500<>"")*(Архив!$B$2:$B$500<>"")*(Архив!$E$2:$E$500<=Архив!$B$2:$B$500)))/MAX(1,COUNTIF(Задачи!$E$2:$E$500,"<>")+COUNTIF(Архив!$E$2:$E$500,"<>")),0)',
    'B14': '=IFERROR(INDEX(A2:A8,MATCH(MAX(B2:B8),B2:B8,0)),"—")',
    'B15': '=IFERROR(INDEX(Задачи!A:A,MATCH(MINIFS(Задачи!B2:B500,Задачи!D2:D500,FALSE,Задачи!B2:B500,"<"&TODAY()),Задачи!B:B,0)),"")',
    'B16': '=IF(B10+B12=0,"Добавь задачи со сроками — аналитика появится сама",IF(B12>0,"Пик продуктивности — "&B14&". ","")&IF(B11>0,"«"&B15&"» просрочена — закрой её первой.","Просрочек нет — так держать!"))',
    'B17': '=COUNTIFS(Задачи!B2:B500,TODAY(),Задачи!D2:D500,FALSE)',
    'E2': '=COUNTIFS(Задачи!C2:C500,"Срочно",Задачи!D2:D500,FALSE,Задачи!A2:A500,"<>")+COUNTIFS(Задачи!C2:C500,"Высокий",Задачи!D2:D500,FALSE,Задачи!A2:A500,"<>")',
    'E3': '=COUNTIFS(Задачи!C2:C500,"Средний",Задачи!D2:D500,FALSE,Задачи!A2:A500,"<>")',
    'E4': '=COUNTIFS(Задачи!C2:C500,"Низкий",Задачи!D2:D500,FALSE,Задачи!A2:A500,"<>")'
  };
  for (var a1 in C) calc.getRange(a1).setFormula(C[a1]);
  calc.getRange('D2:D4').setValues([['Срочно + высокий'], ['Средний'], ['Низкий']]);

  /* ---- Дашборд ---- */
  dashBase_(dash, PAL.gold);
  dashTitle_(dash, '🎯 ЦЕНТР ЗАДАЧ', PAL.gold, '=TEXT(_calc!B13,"0%")&" в срок"', PAL.gold);
  kpi_(dash, 3, 2, 'Открыто', '=_calc!B10', '=_calc!B17&" на сегодня"', PAL.gold, PAL.gray, PAL.mut);
  kpi_(dash, 3, 4, 'Горит', '="⚠ "&_calc!B11',
    '=IF(_calc!B11>0,"разгреби первым делом","просрочек нет")', PAL.red, PAL.redb, '#c0344a');
  kpi_(dash, 3, 6, 'За неделю', '=_calc!B12&" ✓"', 'закрыто за 7 дней', PAL.grn, PAL.grnb, '#0d7a4c');
  kpi_(dash, 3, 8, 'В срок', '=TEXT(_calc!B13,"0%")', 'доля вовремя', PAL.grn, PAL.gray, PAL.mut);

  label_(dash, 'B7', 'Ближайшие задачи');
  dash.getRange('B8:E8').setValues([['Задача', 'Срок', 'Осталось', 'Приоритет']])
    .setBackground(PAL.head).setFontColor(PAL.mut).setFontWeight('bold').setFontSize(9);
  dash.getRange('B9').setFormula(
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({Задачи!A2:A500,Задачи!B2:B500,Задачи!F2:F500,Задачи!C2:C500},Задачи!D2:D500=FALSE,Задачи!A2:A500<>""),2,TRUE),5,4),"Пока пусто — добавь задачи на листе «Задачи»")');
  dash.getRange('C9:C13').setNumberFormat('d MMM');
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISNUMBER(D9),D9<0)').setFontColor(PAL.red)
    .setRanges([dash.getRange('D9:D13')]).build());
  [['Срочно', PAL.redb, '#c0344a'], ['Высокий', PAL.redb, '#c0344a'],
   ['Средний', PAL.goldb, '#a5720a'], ['Низкий', PAL.blub, '#1d6fb0']].forEach(function (p) {
    addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(p[0]).setBackground(p[1]).setFontColor(p[2])
      .setRanges([dash.getRange('E9:E13')]).build());
  });

  label_(dash, 'B15', 'Закрыто по дням · неделя');
  label_(dash, 'G15', 'Приоритеты открытых');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(calc.getRange('A2:B8'))
    .setPosition(16, 2, 0, 6)
    .setOption('width', 430).setOption('height', 180)
    .setOption('colors', ['#e0a93a']).setOption('legend', { position: 'none' }), 'Закрыто по дням');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.PIE)
    .addRange(calc.getRange('D2:E4'))
    .setPosition(16, 7, 0, 6)
    .setOption('width', 320).setOption('height', 180)
    .setOption('pieHole', 0.6).setOption('colors', [PAL.red, PAL.gold, PAL.blu])
    .setOption('legend', { position: 'right' }).setOption('pieSliceText', 'value'), 'Приоритеты');
  for (var rr = 16; rr <= 24; rr++) dash.setRowHeight(rr, 20);

  insight_(dash, 26, '="💡 "&_calc!B16');

  finishCalc_(calc);
  protectWarn_(dash, null);
  protectWarn_(data, ['A2:E200']);
  protectWarn_(arch, ['A2:E500']);
  protectWarn_(set, []);
  finishFile_(ss);
  Logger.log('Задачи: ' + ss.getUrl());
  return 'Задачи: ' + ss.getUrl();
}

/* ==================== 3. ТЕЛО — «ПАНЕЛЬ ФОРМЫ» ==================== */

function buildBody_(folder) {
  var ss = makeFile_('Магнат · Тело', folder, ['📊 Дашборд', 'Тренировки', 'Замеры', 'Настройки', '_calc']);
  var dash = ss.getSheetByName('📊 Дашборд'),
      data = ss.getSheetByName('Тренировки'),
      meas = ss.getSheetByName('Замеры'),
      set  = ss.getSheetByName('Настройки'),
      calc = ss.getSheetByName('_calc');
  var GROUPS = ['Грудь', 'Спина', 'Ноги', 'Руки', 'Плечи', 'Пресс'];
  var MOODS = ['😄', '🙂', '😐', '💪', '😮‍💨'];

  /* ---- Настройки ---- */
  set.setTabColor(PAL.mut2);
  set.getRange('A1').setValue('⚙️ Настройки «Панели формы»').setFontWeight('bold').setFontSize(13);
  starterBlock_(set, 3, [
    'Впиши стартовый вес и цель (ниже) — путь к цели посчитается сам.',
    'Каждый день заполняй строку на листе «Тренировки» (что есть — то и пиши).',
    'Тренировка = галочка + группа мышц: радар покажет баланс.',
    'Замеры (талия, грудь…) — на листе «Замеры» раз в неделю.',
    'Не редактируй серые ячейки — в них формулы.'
  ]);
  header_(set, 10, 1, ['Параметр', 'Значение']);
  set.getRange('A11:B15').setValues([
    ['Стартовый вес, кг', 84], ['Цель, кг', 76], ['Норма калорий', 2400],
    ['Норма воды, л', 2], ['Тренировок в неделю (план)', 5]
  ]);
  set.setColumnWidth(1, 260);
  ss.setNamedRange('W_START', set.getRange('B11'));
  ss.setNamedRange('W_GOAL', set.getRange('B12'));
  ss.setNamedRange('KCAL_GOAL', set.getRange('B13'));
  ss.setNamedRange('WATER_GOAL', set.getRange('B14'));
  ss.setNamedRange('TRAIN_PLAN', set.getRange('B15'));

  /* ---- Тренировки (демо 30 дней) ---- */
  data.setTabColor(PAL.red);
  header_(data, 1, 1, ['Дата', 'Вес', 'Ккал', 'Вода, л', 'Сон, ч', 'Тренировка', 'Группа мышц', 'Настроение']);
  var t = new Date();
  var rows = [], gi = 0;
  for (var i = 0; i < 30; i++) {
    var date = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29 + i);
    var weight = (i % 7 === 2) ? '' : Math.round((80.3 - 1.4 * (i / 29) + (((i * 7) % 3) - 1) * 0.1) * 10) / 10;
    var kcal = 2250 + ((i * 37) % 250);
    var water = Math.round(12 + ((i * 13) % 10)) / 10;
    var sleep = Math.round(68 + ((i * 17) % 14)) / 10;
    var trained = [0, 2, 3, 5].indexOf(i % 7) !== -1;
    var group = '';
    if (trained) { group = (gi === 10) ? 'Плечи' : GROUPS[[0, 1, 2, 3, 5][gi % 5]]; gi++; }
    rows.push([date, weight, kcal, water, sleep, trained, group, MOODS[i % 5]]);
  }
  data.getRange(2, 1, 30, 8).setValues(rows);
  data.getRange('F2:F400').insertCheckboxes();
  for (var ri = 0; ri < 30; ri++) data.getRange(2 + ri, 6).setValue(rows[ri][5]);
  data.getRange('G2:G400').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(GROUPS, true).setAllowInvalid(true).build());
  data.getRange('H2:H400').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(MOODS, true).setAllowInvalid(true).build());
  data.getRange('A2:A400').setNumberFormat('d MMM');
  data.getRange('B2:B400').setNumberFormat('0.0');
  data.getRange('D2:E400').setNumberFormat('0.0');
  data.setFrozenRows(1);

  /* ---- Замеры ---- */
  meas.setTabColor(PAL.mut2);
  header_(meas, 1, 1, ['Дата', 'Талия, см', 'Грудь, см', 'Бицепс, см', 'Бёдра, см']);
  meas.getRange('A2').setNote('Меряй раз в неделю — динамика скажет больше, чем вес.');

  /* ---- _calc ---- */
  var B = {
    'B2': '=IFERROR(LOOKUP(2,1/(Тренировки!B2:B500<>""),Тренировки!B2:B500),W_START)',
    'B3': '=IFERROR(INDEX(Тренировки!B:B,MATCH(MINIFS(Тренировки!A2:A500,Тренировки!A2:A500,">="&TODAY()-29,Тренировки!B2:B500,"<>"),Тренировки!A:A,0)),B2)',
    'B4': '=B2-B3',
    'B5': '=COUNTIFS(Тренировки!F2:F500,TRUE,Тренировки!A2:A500,">="&TODAY()-6)',
    'B6': '=COUNTIFS(Тренировки!F2:F500,TRUE,Тренировки!A2:A500,">="&TODAY()-29)',
    'B7': '=IFERROR(LOOKUP(2,1/(Тренировки!C2:C500<>""),Тренировки!C2:C500),"—")',
    'B8': '=IFERROR(TEXT(AVERAGEIFS(Тренировки!E2:E500,Тренировки!A2:A500,">="&TODAY()-6),"0.0"),"—")',
    'B9': '=IFERROR(MAX(0,MIN(1,(W_START-B2)/MAX(0.1,W_START-W_GOAL))),0)',
    'B10': '=IFERROR(MAX(H2:H61),0)',
    'B11': '=IFERROR(ROUND(AVERAGEIFS(Тренировки!B2:B500,Тренировки!A2:A500,">="&TODAY()-6),1),B2)',
    'B12': '=IFERROR(INDEX(J2:J7,MATCH(MIN(K2:K7),K2:K7,0)),"")',
    'B13': '=IF(B6=0,"Заполни дневник — инсайты появятся здесь","За 30 дней "&B6&" тренировок. "&IF(B12<>"",B12&" отстаёт — добавь один подход, и радар выровняется.",""))'
  };
  for (var a1 in B) calc.getRange(a1).setFormula(B[a1]);
  // серия тренировок по календарным дням (последние 60)
  calc.getRange('F1').setValue('серия по дням');
  var streakF = [];
  for (var s = 0; s < 60; s++) {
    var r = 2 + s;
    streakF.push([
      '=TODAY()-' + (59 - s),
      '=IF(COUNTIFS(Тренировки!$A$2:$A$500,$F' + r + ',Тренировки!$F$2:$F$500,TRUE)>0,1,0)',
      (s === 0 ? '=G2' : '=IF(G' + r + '=1,H' + (r - 1) + '+1,0)')
    ]);
  }
  calc.getRange(2, 6, 60, 3).setFormulas(streakF);
  // радар
  calc.getRange('J1').setValue('радар 30 дней');
  for (var g = 0; g < GROUPS.length; g++) {
    calc.getRange(2 + g, 10).setValue(GROUPS[g]);
    calc.getRange(2 + g, 11).setFormula(
      '=COUNTIFS(Тренировки!G2:G500,J' + (2 + g) + ',Тренировки!A2:A500,">="&TODAY()-29,Тренировки!F2:F500,TRUE)');
  }
  // серия для графика веса: дата · вес · цель
  calc.getRange('M1:O1').setValues([['Дата', 'Вес', 'Цель']]);
  var wf = [];
  for (var wr = 0; wr < 120; wr++) {
    var rw = 2 + wr, src = 2 + wr;
    wf.push([
      '=IF(Тренировки!A' + src + '="","",Тренировки!A' + src + ')',
      '=IF(Тренировки!B' + src + '="","",Тренировки!B' + src + ')',
      '=IF(Тренировки!A' + src + '="","",W_GOAL)'
    ]);
  }
  calc.getRange(2, 13, 120, 3).setFormulas(wf);

  /* ---- Дашборд ---- */
  dashBase_(dash, PAL.red);
  dashTitle_(dash, '💪 ПАНЕЛЬ ФОРМЫ', PAL.red, '=TEXT(_calc!B4,"+0.0;-0.0;0.0")&" кг за месяц"', PAL.grn);
  kpi_(dash, 3, 2, 'Вес', '=TEXT(_calc!B2,"0.0")&" кг"',
    '=TEXT(_calc!B4,"+0.0;-0.0;0.0")&" за месяц"', PAL.grn, PAL.grnb, '#0d7a4c');
  kpi_(dash, 3, 4, 'Тренировки', '=_calc!B5&" / 7"', '="план "&TRAIN_PLAN&" в неделю"', PAL.red, PAL.gray, PAL.mut);
  kpi_(dash, 3, 6, 'Калории', '=_calc!B7', '="цель "&TEXT(KCAL_GOAL,"#,##0")', PAL.gold, PAL.gray, PAL.mut);
  kpi_(dash, 3, 8, 'Сон', '=_calc!B8&" ч"', 'среднее за 7 дней', PAL.blu, PAL.gray, PAL.mut);

  label_(dash, 'B7', 'Вес, кг · линия цели');
  label_(dash, 'H7', 'Баланс мышц · 30 дней');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.AREA)
    .addRange(calc.getRange('M2:O121'))
    .setPosition(8, 2, 0, 6)
    .setOption('width', 540).setOption('height', 190)
    .setOption('colors', [PAL.red, PAL.gold])
    .setOption('series', { 1: { lineDashStyle: [4, 4] } })
    .setOption('interpolateNulls', true)
    .setOption('legend', { position: 'none' }), 'График веса');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.RADAR)
    .addRange(calc.getRange('J2:K7'))
    .setPosition(8, 8, 0, 6)
    .setOption('width', 220).setOption('height', 190)
    .setOption('colors', [PAL.red]).setOption('legend', { position: 'none' }), 'Радар мышц');
  for (var rr = 8; rr <= 17; rr++) dash.setRowHeight(rr, 20);

  dash.getRange('B19').setValue('🎯 ПУТЬ К ЦЕЛИ').setFontWeight('bold').setFontSize(10);
  dash.getRange('C19:E19').merge().setFormula(
    '=IFERROR(SPARKLINE(_calc!B9,{"charttype","bar";"max",1;"color1","#c98a12"}),"")');
  dash.getRange('F19:I19').merge().setFormula(
    '=W_START&" → "&TEXT(_calc!B2,"0.0")&" → "&W_GOAL&" кг · пройдено "&TEXT(_calc!B9,"0%")')
    .setFontSize(9).setFontColor(PAL.mut);

  kpi_(dash, 21, 2, 'Тренировок · 30 дн', '=_calc!B6', 'держи ритм', PAL.red, PAL.gray, PAL.mut);
  kpi_(dash, 21, 4, 'Лучшая серия', '=_calc!B10&" дн"', 'тренировки подряд', PAL.grn, PAL.gray, PAL.mut);
  kpi_(dash, 21, 6, 'Ср. вес недели', '=TEXT(_calc!B11,"0.0")', 'по 7 дням', PAL.gold, PAL.gray, PAL.mut);
  kpi_(dash, 21, 8, 'Вода сегодня', '=IFERROR(TEXT(N(VLOOKUP(TODAY(),Тренировки!A2:D500,4,FALSE)),"0.0"),"0")&" / "&WATER_GOAL&" л"',
    'заполняется из дневника', PAL.blu, PAL.gray, PAL.mut);

  label_(dash, 'B25', 'Тренировки недели');
  for (var wc = 1; wc <= 7; wc++) {
    var dExpr = MONDAY + '+' + wc;
    dash.getRange(26, 2 + wc).setFormula(
      '=IF(' + dExpr + '>TODAY(),"' + DAYS_RU[wc - 1] + '",IF(COUNTIFS(Тренировки!$A$2:$A$500,' + dExpr + ',Тренировки!$F$2:$F$500,TRUE)>0,"' + DAYS_RU[wc - 1] + ' ✓","' + DAYS_RU[wc - 1] + '"))'
    ).setHorizontalAlignment('center').setFontSize(9).setBackground(PAL.gray);
  }
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('✓').setBackground(PAL.grnb).setFontColor('#0d7a4c')
    .setRanges([dash.getRange('C26:I26')]).build());

  insight_(dash, 28, '="💡 "&_calc!B13');

  finishCalc_(calc);
  protectWarn_(dash, null);
  protectWarn_(data, ['A2:H400']);
  protectWarn_(meas, ['A2:E200']);
  protectWarn_(set, ['B11:B15']);
  finishFile_(ss);
  Logger.log('Тело: ' + ss.getUrl());
  return 'Тело: ' + ss.getUrl();
}

/* ==================== 4. НЕДЕЛЯ — «ПУЛЬТ НЕДЕЛИ» ==================== */

function buildWeek_(folder) {
  var ss = makeFile_('Магнат · Неделя', folder, ['📊 Дашборд', 'Неделя', 'Рефлексия', 'Настройки', '_calc']);
  var dash = ss.getSheetByName('📊 Дашборд'),
      data = ss.getSheetByName('Неделя'),
      refl = ss.getSheetByName('Рефлексия'),
      set  = ss.getSheetByName('Настройки'),
      calc = ss.getSheetByName('_calc');
  var MOODS = ['😄', '🙂', '😐', '😴', '💪'];

  /* ---- Настройки ---- */
  set.setTabColor(PAL.mut2);
  set.getRange('A1').setValue('⚙️ Настройки «Пульта недели»').setFontWeight('bold').setFontSize(13);
  starterBlock_(set, 3, [
    'Каждое утро впиши 3 главных дела дня на листе «Неделя».',
    'Вечером — галочки, энергия (1–5) и настроение.',
    'Фокус-цели недели — под таблицей дней, их три.',
    'В воскресенье заполни «Рефлексию» и очисти галочки — новая неделя.',
    'Не редактируй серые ячейки — в них формулы.'
  ]);
  set.getRange('A10').setValue('Монет за выполненное дело');
  set.getRange('B10').setValue(25);
  set.setColumnWidth(1, 260);
  ss.setNamedRange('TASK_COIN', set.getRange('B10'));

  /* ---- Неделя ---- */
  data.setTabColor(PAL.vio);
  header_(data, 1, 1, ['День', 'Дата', 'Дело 1', '✓', 'Дело 2', '✓', 'Дело 3', '✓', 'Энергия 1–5', 'Настроение']);
  var demoTasks = [
    ['Запустить лендинг', 'Тренировка', 'Прочитать 20 стр'],
    ['Смонтировать ролик', 'Прогулка 30 мин', 'Разобрать почту'],
    ['Скрипт для клиента', 'Тренировка', 'Лечь до 23:00'],
    ['Большая задача дня', 'Купить продукты', 'Час без телефона'],
    ['Сдать проект', 'Тренировка', 'Встреча с другом'],
    ['План на неделю', 'Уборка', 'Кино вечером'],
    ['Отдых без чувства вины', 'Прогулка', 'Ранний сон']
  ];
  var checks = [[1, 1, 1], [1, 1, 0], [1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0], [0, 0, 0]];
  var energy = [3, 2, 3, 1, 5, 3, 2];
  var moods = ['😄', '🙂', '😄', '😐', '💪', '🙂', '😴'];
  var DAYS_FULL = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  for (var d = 0; d < 7; d++) {
    var r = 2 + d;
    data.getRange(r, 1).setValue(DAYS_FULL[d]);
    data.getRange(r, 2).setFormula('=' + MONDAY + '+' + (d + 1)).setNumberFormat('d MMM');
    data.getRange(r, 3).setValue(demoTasks[d][0]);
    data.getRange(r, 5).setValue(demoTasks[d][1]);
    data.getRange(r, 7).setValue(demoTasks[d][2]);
    data.getRange(r, 9).setValue(energy[d]);
    data.getRange(r, 10).setValue(moods[d]);
  }
  ['D', 'F', 'H'].forEach(function (col, ci) {
    var rng = data.getRange(col + '2:' + col + '8');
    rng.insertCheckboxes();
    rng.setValues(checks.map(function (c) { return [c[ci] === 1]; }));
  });
  data.getRange('I2:I8').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(false).build());
  data.getRange('J2:J8').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(MOODS, true).setAllowInvalid(true).build());
  data.getRange('A10').setValue('Фокус-цели недели').setFontWeight('bold');
  data.getRange('A11:A13').setValues([['Запустить сайт'], ['3 тренировки'], ['Дочитать книгу']]);
  data.getRange('B11:B13').insertCheckboxes();
  data.getRange('B11:B13').setValues([[true], [true], [false]]);
  data.setColumnWidth(1, 120); data.setColumnWidth(2, 70);
  [3, 5, 7].forEach(function (c) { data.setColumnWidth(c, 180); });
  data.setFrozenRows(1);

  /* ---- Рефлексия ---- */
  refl.setTabColor(PAL.mut2);
  header_(refl, 1, 1, ['Неделя', 'Что получилось', 'Что мешало', 'Что изменю']);
  refl.setColumnWidth(1, 90); refl.setColumnWidths(2, 3, 240);

  /* ---- _calc ---- */
  var W = {
    'B2': '=COUNTIF(Неделя!C2:H8,TRUE)',
    'B3': '=IFERROR(TEXT(AVERAGE(Неделя!I2:I8),"0.0"),"0")',
    'B4': '=IFERROR(INDEX(Неделя!A2:A8,MATCH(MAX(Неделя!I2:I8),Неделя!I2:I8,0)),"")',
    'B5': '=IFERROR(INDEX(Неделя!A2:A8,MATCH(MIN(Неделя!I2:I8),Неделя!I2:I8,0)),"")',
    'B6': '=COUNTIF(Неделя!B11:B13,TRUE)',
    'B7': '=B2*TASK_COIN',
    'B8': '=IF(B2=0,"Отмечай дела и энергию — инсайт появится к вечеру","Меньше всего энергии — "&B5&". Ставь лёгкие задачи на этот день, и процент недели вырастет.")'
  };
  for (var a1 in W) calc.getRange(a1).setFormula(W[a1]);

  /* ---- Дашборд ---- */
  dashBase_(dash, PAL.vio);
  dashTitle_(dash, '📅 ПУЛЬТ НЕДЕЛИ', PAL.vio, '=TEXT(_calc!B2/21,"0%")', PAL.vio);
  kpi_(dash, 3, 2, 'Выполнено', '=_calc!B2&" / 21"', '=TEXT(_calc!B2/21,"0%")&" недели"', PAL.vio, PAL.gray, PAL.mut);
  kpi_(dash, 3, 4, 'Энергия', '="⚡ "&_calc!B3&" / 5"', '="пик — "&_calc!B4', PAL.gold, PAL.goldb, '#a5720a');
  kpi_(dash, 3, 6, 'Фокус-цели', '=_calc!B6&" / 3"', 'главные цели недели', PAL.grn, PAL.gray, PAL.mut);
  kpi_(dash, 3, 8, 'Монеты', '="+"&_calc!B7&" 🪙"', 'за дела недели', PAL.gold, PAL.grnb, '#0d7a4c');

  label_(dash, 'B7', 'Дни недели');
  dash.getRange('B8:F8').setValues([['День', 'Дела', 'Энергия', 'Настроение', 'Итог']])
    .setBackground(PAL.head).setFontColor(PAL.mut).setFontWeight('bold').setFontSize(9);
  for (var d2 = 0; d2 < 7; d2++) {
    var rr = 9 + d2, src = 2 + d2;
    dash.getRange(rr, 2).setFormula('=Неделя!A' + src).setFontSize(10);
    dash.getRange(rr, 3).setFormula(
      '=REPT("✓ ",COUNTIF(Неделя!C' + src + ':H' + src + ',TRUE))&REPT("· ",3-COUNTIF(Неделя!C' + src + ':H' + src + ',TRUE))')
      .setFontColor(PAL.grn).setFontWeight('bold');
    dash.getRange(rr, 4).setFormula(
      '=IFERROR(SPARKLINE(Неделя!I' + src + ',{"charttype","bar";"max",5;"color1","#e0a93a"}),"")');
    dash.getRange(rr, 5).setFormula('=Неделя!J' + src).setHorizontalAlignment('center');
    dash.getRange(rr, 6).setFormula('=TEXT(COUNTIF(Неделя!C' + src + ':H' + src + ',TRUE)/3,"0%")')
      .setFontWeight('bold').setFontColor(PAL.vio);
  }

  label_(dash, 'B17', 'Фокус-цели недели');
  for (var fg = 0; fg < 3; fg++) {
    dash.getRange(18, 2 + fg * 2, 1, 2).merge().setFormula(
      '=IF(Неделя!B' + (11 + fg) + '=TRUE,"✓ ","○ ")&Неделя!A' + (11 + fg))
      .setFontSize(9).setBackground(PAL.gray).setHorizontalAlignment('center');
  }
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('✓').setBackground(PAL.grnb).setFontColor('#0d7a4c')
    .setRanges([dash.getRange('B18:G18')]).build());

  label_(dash, 'B20', 'Энергия недели');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.AREA)
    .addRange(data.getRange('A2:A8')).addRange(data.getRange('I2:I8'))
    .setPosition(21, 2, 0, 6)
    .setOption('width', 760).setOption('height', 170)
    .setOption('colors', [PAL.vio]).setOption('legend', { position: 'none' })
    .setOption('vAxis', { minValue: 0, maxValue: 5 }), 'Энергия недели');
  for (var er = 21; er <= 28; er++) dash.setRowHeight(er, 20);

  insight_(dash, 30, '="💡 "&_calc!B8');

  finishCalc_(calc);
  protectWarn_(dash, null);
  protectWarn_(data, ['A2:A8', 'C2:J8', 'A11:B13']);
  protectWarn_(refl, ['A2:D100']);
  protectWarn_(set, ['B10']);
  finishFile_(ss);
  Logger.log('Неделя: ' + ss.getUrl());
  return 'Неделя: ' + ss.getUrl();
}

/* ==================== 5. ФИНАНСЫ — «КАПИТАЛ» ==================== */

function buildFinance_(folder) {
  var ss = makeFile_('Магнат · Финансы', folder, ['📊 Дашборд', 'Операции', 'Долги', 'Цели', '_calc']);
  var dash = ss.getSheetByName('📊 Дашборд'),
      ops  = ss.getSheetByName('Операции'),
      debt = ss.getSheetByName('Долги'),
      goal = ss.getSheetByName('Цели'),
      calc = ss.getSheetByName('_calc');
  var CATS = ['🍔 Еда', '🏠 Жильё', '🚗 Транспорт', '🎮 Досуг', '📦 Другое'];
  var ALL_CATS = ['💼 Зарплата'].concat(CATS);

  /* ---- Цели (+ инструкция) ---- */
  goal.setTabColor(PAL.mut2);
  goal.getRange('A1').setValue('🎯 Цели и планы').setFontWeight('bold').setFontSize(13);
  starterBlock_(goal, 3, [
    'Записывай операции на листе «Операции»: дата, тип, категория, сумма.',
    'Планы по категориям на месяц — в таблице ниже.',
    'Подушка = накопления в месяцах жизни. Впиши, сколько уже отложено.',
    'Долги — на отдельном листе, прогресс закрытия считается сам.',
    'Не редактируй серые ячейки — в них формулы.'
  ]);
  header_(goal, 10, 1, ['Категория (меняй под себя)', 'План на месяц, ₽']);
  goal.getRange('A11:B15').setValues([
    ['🍔 Еда', 40000], ['🏠 Жильё', 25000], ['🚗 Транспорт', 18000],
    ['🎮 Досуг', 15000], ['📦 Другое', 8000]
  ]);
  // категория дохода — тоже редактируемая, попадает в выпадающий список «Операций»
  goal.getRange('A16').setValue('💼 Зарплата').setNote('Категория доходов. Переименуй/добавь свои категории прямо здесь — список в «Операциях» обновится сам.');
  goal.getRange('A10').setNote('Это твои категории. Переименовывай, удаляй, добавляй строки — выпадающий список в «Операциях» берётся отсюда. Первые 5 (расходы) показываются на дашборде, «Другое» — всё остальное.');
  goal.getRange('A17').setValue('Цель: доля дохода в сбережения');
  goal.getRange('B17').setValue(0.15).setNumberFormat('0%');
  goal.getRange('A18').setValue('Цель подушки, месяцев');
  goal.getRange('B18').setValue(6);
  goal.getRange('A19').setValue('Уже отложено (стартовая подушка), ₽');
  goal.getRange('B19').setValue(200000);
  goal.setColumnWidth(1, 280); goal.setColumnWidth(2, 140);
  ss.setNamedRange('SAVE_GOAL', goal.getRange('B17'));
  ss.setNamedRange('PILLOW_GOAL', goal.getRange('B18'));
  ss.setNamedRange('PILLOW_START', goal.getRange('B19'));

  /* ---- Операции (демо 6 месяцев) ---- */
  ops.setTabColor(PAL.gold);
  header_(ops, 1, 1, ['Дата', 'Тип', 'Категория', 'Сумма, ₽']);
  var t = new Date();
  var rows = [];
  for (var m = 5; m >= 0; m--) {
    var y = t.getFullYear(), mo = t.getMonth() - m;
    var maxDay = (m === 0) ? t.getDate() : 28;
    function od(day) { return new Date(y, mo, Math.min(day, maxDay)); }
    rows.push([od(1), 'Доход', '💼 Зарплата', 100000 + (5 - m) * 3500]);
    if (m >= 2) rows.push([od(15), 'Доход', '💼 Зарплата', 8000]); // подработка в старых месяцах
    rows.push([od(2), 'Расход', '🏠 Жильё', 24000]);
    [5, 12, 19, 26].forEach(function (day, k) {
      if (day <= maxDay) rows.push([od(day), 'Расход', '🍔 Еда', 8900 + ((m * 4 + k) % 5) * 350]);
    });
    [7, 21].forEach(function (day, k) {
      if (day <= maxDay) rows.push([od(day), 'Расход', '🚗 Транспорт', 7800 + ((m + k) % 4) * 900]);
    });
    if (10 <= maxDay) rows.push([od(10), 'Расход', '🎮 Досуг', 6200 + (m % 3) * 800]);
    if (23 <= maxDay) rows.push([od(23), 'Расход', '🎮 Досуг', 5400]);
    if (17 <= maxDay) rows.push([od(17), 'Расход', '📦 Другое', 3300 + (m % 2) * 700]);
  }
  ops.getRange(2, 1, rows.length, 4).setValues(rows);
  var lastOp = rows.length + 1;
  ops.getRange('B2:B1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Доход', 'Расход'], true).setAllowInvalid(false).build());
  // категории берём ИЗ листа «Цели» (редактируемый список), плюс разрешаем
  // вписать свою вручную (allowInvalid). Так можно менять/удалять/добавлять категории.
  ops.getRange('C2:C1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(goal.getRange('A11:A16'), true).setAllowInvalid(true).build());
  ops.getRange('A2:A1000').setNumberFormat('d MMM yyyy');
  ops.getRange('D2:D1000').setNumberFormat('#,##0" ₽"');
  ops.setFrozenRows(1);
  ops.setColumnWidths(1, 4, 130);
  addRule_(ops, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$B2="Доход"').setFontColor('#0d7a4c')
    .setRanges([ops.getRange('D2:D1000')]).build());

  /* ---- Долги ---- */
  debt.setTabColor(PAL.mut2);
  header_(debt, 1, 1, ['Кому / что', 'Всего, ₽', 'Выплачено, ₽', 'Осталось, ₽', 'Прогресс']);
  debt.getRange('A2:C3').setValues([['Кредитная карта', 45000, 20000], ['Брату за ноутбук', 30000, 18000]]);
  var df = [];
  for (var dr = 2; dr <= 30; dr++) {
    df.push([
      '=IF($A' + dr + '="","",$B' + dr + '-$C' + dr + ')',
      '=IF($A' + dr + '="","",IFERROR(SPARKLINE($C' + dr + ',{"charttype","bar";"max",MAX(1,$B' + dr + ');"color1","#12a565"}),""))'
    ]);
  }
  debt.getRange(2, 4, 29, 2).setFormulas(df);
  debt.getRange('B2:D30').setNumberFormat('#,##0" ₽"');
  debt.setColumnWidth(1, 220); debt.setColumnWidth(5, 160);

  /* ---- _calc ---- */
  // категории месяца
  for (var c = 0; c < 5; c++) {
    var rc = 2 + c;
    calc.getRange(rc, 1).setFormula('=IF(Цели!A' + (11 + c) + '="","",Цели!A' + (11 + c) + ')');
    calc.getRange(rc, 2).setFormula(
      '=SUMIFS(Операции!$D$2:$D$1000,Операции!$C$2:$C$1000,$A' + rc + ',Операции!$B$2:$B$1000,"Расход",Операции!$A$2:$A$1000,">="&EOMONTH(TODAY(),-1)+1)');
    calc.getRange(rc, 3).setFormula('=Цели!B' + (11 + c));
  }
  // 6 месяцев: H старт · E имя · F доход · I расход · G сбережения
  for (var m2 = 0; m2 < 6; m2++) {
    var rm = 2 + m2;
    calc.getRange(rm, 8).setFormula('=EOMONTH(TODAY(),' + (m2 - 6) + ')+1');
    calc.getRange(rm, 5).setFormula('=TEXT(H' + rm + ',"MMM")');
    calc.getRange(rm, 6).setFormula(
      '=SUMIFS(Операции!$D$2:$D$1000,Операции!$B$2:$B$1000,"Доход",Операции!$A$2:$A$1000,">="&H' + rm + ',Операции!$A$2:$A$1000,"<="&EOMONTH(H' + rm + ',0))');
    calc.getRange(rm, 9).setFormula(
      '=SUMIFS(Операции!$D$2:$D$1000,Операции!$B$2:$B$1000,"Расход",Операции!$A$2:$A$1000,">="&H' + rm + ',Операции!$A$2:$A$1000,"<="&EOMONTH(H' + rm + ',0))');
    calc.getRange(rm, 7).setFormula('=F' + rm + '-I' + rm);
  }
  var F = {
    'B8': '=SUMIFS(Операции!$D$2:$D$1000,Операции!$B$2:$B$1000,"Доход",Операции!$A$2:$A$1000,">="&EOMONTH(TODAY(),-1)+1)',
    'B9': '=SUMIFS(Операции!$D$2:$D$1000,Операции!$B$2:$B$1000,"Расход",Операции!$A$2:$A$1000,">="&EOMONTH(TODAY(),-1)+1)',
    'B10': '=B8-B9',
    'B11': '=IF(B8=0,0,B10/B8)',
    'B12': '=IF(SUM(I2:I7)=0,0,MAX(1,AVERAGE(I5:I7)))',
    'B13': '=IFERROR(AVERAGE(G5:G7),0)',
    'B14': '=PILLOW_START+SUMIF(Операции!B2:B1000,"Доход",Операции!D2:D1000)-SUMIF(Операции!B2:B1000,"Расход",Операции!D2:D1000)',
    'B15': '=IF(B12=0,0,IFERROR(MAX(0,B14)/B12,0))',
    'B16': '=IF(B15>=PILLOW_GOAL,"цель достигнута — держи уровень!",IF(B13<=0,"начни откладывать — прогноз появится","темп +"&TEXT(B13,"#,##0")&" ₽/мес → цель "&PILLOW_GOAL&" мес через ~"&MAX(1,ROUNDUP((PILLOW_GOAL*B12-B14)/B13,0))&" мес"))',
    'B17': '=ARRAYFORMULA(IFERROR(IF(MAX(B2:B6-C2:C6)>0,INDEX(A2:A6,MATCH(MAX(B2:B6-C2:C6),B2:B6-C2:C6,0)),""),""))',
    'B18': '=ARRAYFORMULA(IFERROR(MAX(B2:B6-C2:C6),0))',
    'B19': '=IF(B8+B9=0,"Добавь операции — аналитика появится сама","Сбережения "&TEXT(B11,"0%")&" дохода"&IF(B18>0," · "&B17&" превысила план на "&TEXT(B18,"#,##0")&" ₽ — проверь её первой",IF(B11>=SAVE_GOAL," — выше цели "&TEXT(SAVE_GOAL,"0%")&", так держать!"," — цель "&TEXT(SAVE_GOAL,"0%")&", чуть поднажми")))'
  };
  for (var a1 in F) calc.getRange(a1).setFormula(F[a1]);

  /* ---- Дашборд ---- */
  dashBase_(dash, PAL.gold);
  dashTitle_(dash, '💰 КАПИТАЛ · МЕСЯЦ', PAL.gold, '=TEXT(_calc!B10,"+#,##0;-#,##0")&" ₽"', PAL.grn);
  kpi_(dash, 3, 2, 'Доход', '=TEXT(_calc!B8,"#,##0")', 'за текущий месяц', PAL.grn, PAL.grnb, '#0d7a4c');
  kpi_(dash, 3, 4, 'Расход', '=TEXT(_calc!B9,"#,##0")', 'за текущий месяц', PAL.red, PAL.redb, '#c0344a');
  kpi_(dash, 3, 6, 'Сбережения', '=TEXT(_calc!B10,"#,##0")', '=TEXT(_calc!B11,"0%")&" дохода"', PAL.gold, PAL.grnb, '#0d7a4c');
  kpi_(dash, 3, 8, 'Подушка', '=TEXT(_calc!B15,"0.0")&" мес"', '="цель — "&PILLOW_GOAL&" мес"', PAL.blu, PAL.gray, PAL.mut);

  label_(dash, 'B7', 'Расходы месяца');
  label_(dash, 'F7', 'План против факта');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.PIE)
    .addRange(calc.getRange('A2:B6'))
    .setPosition(8, 2, 0, 6)
    .setOption('width', 380).setOption('height', 200)
    .setOption('pieHole', 0.6)
    .setOption('colors', [PAL.grn, PAL.blu, PAL.gold, PAL.vio, '#9aa6b4'])
    .setOption('legend', { position: 'right' }).setOption('pieSliceText', 'percentage'), 'Пончик расходов');
  dash.getRange('F8:I8').setValues([['Категория', 'План', 'Факт', '']])
    .setBackground(PAL.head).setFontColor(PAL.mut).setFontWeight('bold').setFontSize(9);
  for (var pc = 0; pc < 5; pc++) {
    var pr = 9 + pc, cr = 2 + pc;
    dash.getRange(pr, 6).setFormula('=_calc!A' + cr).setFontSize(10);
    dash.getRange(pr, 7).setFormula('=_calc!C' + cr).setNumberFormat('#,##0');
    dash.getRange(pr, 8).setFormula('=_calc!B' + cr).setNumberFormat('#,##0');
    dash.getRange(pr, 9).setFormula(
      '=IFERROR(SPARKLINE(_calc!B' + cr + ',{"charttype","bar";"max",MAX(1,_calc!B' + cr + ',_calc!C' + cr + ');"color1",IF(_calc!B' + cr + '>_calc!C' + cr + ',"#e0556a","#12a565")}),"")');
  }
  addRule_(dash, SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISNUMBER(H9),H9>G9)').setFontColor(PAL.red)
    .setRanges([dash.getRange('H9:H13')]).build());
  for (var rr = 8; rr <= 17; rr++) dash.setRowHeight(rr, 20);

  label_(dash, 'B19', 'Копилка · 6 месяцев');
  chartSafe_(dash, dash.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(calc.getRange('E2:E7')).addRange(calc.getRange('G2:G7'))
    .setPosition(20, 2, 0, 6)
    .setOption('width', 760).setOption('height', 170)
    .setOption('colors', [PAL.gold]).setOption('legend', { position: 'none' }), 'Копилка');
  for (var kr = 20; kr <= 27; kr++) dash.setRowHeight(kr, 20);

  dash.getRange('B29').setValue('🛡️ ПОДУШКА').setFontWeight('bold').setFontSize(10);
  dash.getRange('C29:E29').merge().setFormula(
    '=IFERROR(SPARKLINE(_calc!B15,{"charttype","bar";"max",MAX(1,PILLOW_GOAL);"color1","#2f8fd8"}),"")');
  dash.getRange('F29:I29').merge().setFormula('=TEXT(_calc!B15,"0.0")&" / "&PILLOW_GOAL&" мес · "&_calc!B16')
    .setFontSize(9).setFontColor(PAL.mut);

  insight_(dash, 31, '="💡 "&_calc!B19');

  finishCalc_(calc);
  protectWarn_(dash, null);
  protectWarn_(ops, ['A2:D1000']);
  protectWarn_(debt, ['A2:C30']);
  protectWarn_(goal, ['A11:B16', 'B17:B19']);
  finishFile_(ss);
  Logger.log('Финансы: ' + ss.getUrl());
  return 'Финансы: ' + ss.getUrl();
}

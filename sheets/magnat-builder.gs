/**
 * ══════════════════════════════════════════════════════════════════
 *  МАГНАТ — генератор 5 планеров для Google Таблиц
 * ══════════════════════════════════════════════════════════════════
 *
 *  Как пользоваться (подробно — sheets/README.md):
 *   1. Откройте script.google.com → «Новый проект».
 *   2. Замените содержимое Code.gs этим файлом целиком, сохраните.
 *   3. Вверху выберите функцию buildAll и нажмите «Выполнить»,
 *      разрешите доступ (скрипт создаёт файлы только в ВАШЕМ Drive).
 *   4. Через 2–4 минуты в Drive появится папка «🏛 Магнат — планеры»
 *      с пятью готовыми таблицами, заполненными демо-данными.
 *
 *  buildAll()      — 5 планеров с демо-данными (для скриншотов и демо)
 *  buildAllClean() — 5 чистых планеров (для отправки покупателям)
 *
 *  Игровая механика сверена с приложением app.html:
 *   монеты за привычки → серия дней → множитель ×1.1…×2 → уровни
 *   0 / 300 / 1500 / 5000 / 15000 🪙 (Новичок → Магнат).
 */

/* ═══════════════ 0. ПАЛИТРА И КОНСТАНТЫ ═══════════════ */

var C = {
  green:  '#12a565', gold:   '#c98a12', red:    '#e0556a',
  purple: '#7a52d0', blue:   '#2f8fd8',
  ink:    '#1f2a37', dim:    '#8a97a8',
  header: '#eef2f8', grid:   '#dfe6ef', page:   '#ffffff',
  insight:'#fff8e1', insightBorder:'#f2dfa0',
  greenSoft:'#e9f7f0', goldSoft:'#fbf3e2', redSoft:'#fdedf0',
  purpleSoft:'#f2ecfb', blueSoft:'#e9f3fb', graySoft:'#f5f7fa',
  track:  '#e8edf4'
};

// Пороги уровней — как в приложении
var LEVELS_RU = '{"🐣 Новичок";"🚀 Стартапер";"💼 Предприниматель";"🏢 Директор";"👑 Магнат"}';
var LEVELS_N  = '{0;300;1500;5000;15000}';
var LEVEL_NEXT = '{300;1500;5000;15000;99999}';

var FONT = 'Inter';           // при отсутствии Google подставит похожий
var FOLDER_DEMO  = '🏛 Магнат — планеры (демо)';
var FOLDER_CLEAN = '🏛 Магнат — планеры (для покупателя)';

/* ═══════════════ 1. ТОЧКИ ВХОДА ═══════════════ */

function buildAll()      { buildSet_(true);  }
function buildAllClean() { buildSet_(false); }

function buildSet_(demo) {
  var folder = DriveApp.createFolder(demo ? FOLDER_DEMO : FOLDER_CLEAN);
  var urls = [];
  urls.push(buildHabits(demo, folder));
  urls.push(buildTasks(demo, folder));
  urls.push(buildFitness(demo, folder));
  urls.push(buildWeek(demo, folder));
  urls.push(buildFinance(demo, folder));
  Logger.log('Готово! Папка: ' + folder.getUrl());
  urls.forEach(function (u) { Logger.log(u); });
}

/* ═══════════════ 2. ОБЩИЕ ХЕЛПЕРЫ ═══════════════ */

// Буква колонки: 1 → A, 27 → AA
function colA1(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Новый файл таблицы: локаль ru, один служебный лист (удалим в конце)
function newSpreadsheet_(title, folder) {
  var ss = SpreadsheetApp.create(title);
  // ВАЖНО: пока строим — локаль en_US, иначе формулы с запятыми не парсятся.
  // На русскую локаль каждый билдер переключает файл в самом конце.
  ss.setSpreadsheetLocale('en_US');
  try { DriveApp.getFileById(ss.getId()).moveTo(folder); } catch (e) { folder.addFile(DriveApp.getFileById(ss.getId())); }
  return ss;
}

// Лист точного размера с цветом ярлыка
function makeSheet_(ss, name, rows, cols, tabColor) {
  var sh = ss.insertSheet(name);
  if (sh.getMaxColumns() > cols) sh.deleteColumns(cols + 1, sh.getMaxColumns() - cols);
  else if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  if (sh.getMaxRows() > rows) sh.deleteRows(rows + 1, sh.getMaxRows() - rows);
  else if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (tabColor) sh.setTabColor(tabColor);
  sh.getRange(1, 1, rows, cols)
    .setFontFamily(FONT).setFontColor(C.ink).setFontSize(10)
    .setVerticalAlignment('middle');
  return sh;
}

// Удалить стартовый «Лист1»
function dropDefaultSheet_(ss, s0) {
  try { ss.deleteSheet(s0); } catch (e) {}
}

// Дашборд: белый холст без сетки, узкие поля, ровные колонки
function dashCanvas_(sh, contentCols, colWidth) {
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setBackground(C.page);
  sh.setColumnWidth(1, 18);
  sh.setColumnWidths(2, contentCols, colWidth);
  if (sh.getMaxColumns() > contentCols + 1) sh.setColumnWidth(contentCols + 2, 18);
}

// Крупный заголовок дашборда: ■ ЗАГОЛОВОК ................. значение
function dashTitle_(sh, row, col, w, text, accent, rightFormula, rightColor) {
  sh.setRowHeight(row, 34);
  sh.getRange(row, col).setBackground(accent);           // цветной квадратик
  sh.setColumnWidth(col, 18);
  var t = sh.getRange(row, col + 1, 1, w - 3).merge();
  t.setValue(text).setFontSize(14).setFontWeight('bold').setFontColor(C.ink);
  var r = sh.getRange(row, col + w - 2, 1, 2).merge();
  r.setFontSize(13).setFontWeight('bold').setFontColor(rightColor || accent)
   .setHorizontalAlignment('right');
  if (rightFormula) r.setFormula(rightFormula);
}

// KPI-плитка 3 строки высотой: ЯРЛЫК / значение / подпись-дельта
function kpiTile_(sh, row, col, w, opt) {
  var box = sh.getRange(row, col, 3, w);
  box.setBackground('#ffffff')
     .setBorder(true, true, true, true, false, false, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  // толстая цветная граница слева — фирменный акцент плитки
  sh.getRange(row, col, 3, 1).setBorder(null, true, null, null, null, null,
    opt.accent || C.green, SpreadsheetApp.BorderStyle.SOLID_THICK);

  var lab = sh.getRange(row, col, 1, w).merge();
  lab.setValue(opt.label).setFontSize(7).setFontColor(C.dim).setFontWeight('bold')
     .setHorizontalAlignment('left').setVerticalAlignment('bottom');
  // отступ слева имитируем пробелом в ярлыке — Sheets не умеет padding
  lab.setValue('  ' + opt.label.toUpperCase());

  var val = sh.getRange(row + 1, col, 1, w).merge();
  val.setFontSize(16).setFontWeight('bold').setFontColor(opt.valueColor || C.ink)
     .setHorizontalAlignment('left');
  if (opt.f) val.setFormula(opt.f); else if (opt.v !== undefined) val.setValue(opt.v);
  if (opt.fmt) val.setNumberFormat(opt.fmt);

  var d = sh.getRange(row + 2, col, 1, w).merge();
  d.setFontSize(8).setFontColor(opt.deltaColor || C.dim)
   .setHorizontalAlignment('left').setVerticalAlignment('top');
  if (opt.df) d.setFormula(opt.df); else if (opt.dv !== undefined) d.setValue(opt.dv);
}

// Высоты строк под ряд KPI-плиток
function kpiRowHeights_(sh, row) {
  sh.setRowHeight(row, 16);
  sh.setRowHeight(row + 1, 26);
  sh.setRowHeight(row + 2, 15);
}

// Серый ярлык-подпись секции
function sectionLab_(sh, row, col, w, text) {
  var r = sh.getRange(row, col, 1, w).merge();
  r.setValue(text.toUpperCase()).setFontSize(7).setFontColor(C.dim)
   .setFontWeight('bold').setVerticalAlignment('bottom');
  sh.setRowHeight(row, 16);
}

// Инсайт-ячейка 💡 на светло-жёлтом
function insightCell_(sh, row, col, w, formula, h) {
  var r = sh.getRange(row, col, h || 2, w).merge();
  r.setBackground(C.insight)
   .setBorder(true, true, true, true, false, false, C.insightBorder, SpreadsheetApp.BorderStyle.SOLID)
   .setFontSize(9.5).setFontColor(C.ink).setWrap(true)
   .setHorizontalAlignment('left').setVerticalAlignment('middle');
  r.setFormula(formula);
}

// Шапка таблички данных
function gridHeader_(range) {
  range.setBackground(C.header).setFontWeight('bold').setFontSize(8)
       .setFontColor('#5b6b7f')
       .setHorizontalAlignment('center');
}

// Тонкие границы вокруг и внутри диапазона
function boxBorder_(range) {
  range.setBorder(true, true, true, true, true, true, C.grid, SpreadsheetApp.BorderStyle.SOLID);
}

// Правило УФ по формуле
function cfRule_(sh, formula, bg, fontColor, ranges, opts) {
  var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula);
  if (bg) b.setBackground(bg);
  if (fontColor) b.setFontColor(fontColor);
  if (opts && opts.strike) b.setStrikethrough(true);
  if (opts && opts.bold) b.setBold(true);
  return b.setRanges(ranges).build();
}

// Вставка диаграммы
function addChart_(sh, type, ranges, anchorRow, anchorCol, opts) {
  var b = sh.newChart();
  ranges.forEach(function (r) { b.addRange(r); });
  b.setChartType(type).setPosition(anchorRow, anchorCol, 4, 4);
  if (opts && typeof opts.numHeaders === 'number') b.setNumHeaders(opts.numHeaders);
  b.setOption('backgroundColor', '#ffffff');
  b.setOption('fontName', FONT);
  // у линейных/столбчатых первая колонка данных — всегда ось X
  if (type !== Charts.ChartType.PIE && type !== Charts.ChartType.RADAR) {
    b.setOption('useFirstColumnAsDomain', true);
  }
  b.setOption('legend', { position: (opts && opts.legend) || 'none', textStyle: { fontSize: 9, color: '#5b6b7f' } });
  b.setOption('chartArea', (opts && opts.chartArea) || { left: 30, top: 14, width: '88%', height: '72%' });
  if (opts) {
    for (var k in opts) {
      if (k === 'legend' || k === 'chartArea' || k === 'numHeaders') continue;
      b.setOption(k, opts[k]);
    }
  }
  sh.insertChart(b.build());
}

// Мягкая защита листа (предупреждение при правке формул)
function protectWarn_(sh, description, unprotected) {
  var p = sh.protect().setDescription(description);
  p.setWarningOnly(true);
  if (unprotected && unprotected.length) p.setUnprotectedRanges(unprotected);
}

// Ярлык «как настроить» на листе настроек
function settingsHint_(sh, row, col, w, lines) {
  var r = sh.getRange(row, col, lines.length, w);
  r.mergeAcross();
  for (var i = 0; i < lines.length; i++) {
    sh.getRange(row + i, col).setValue(lines[i]).setFontSize(9)
      .setFontColor(i === 0 ? C.ink : C.dim).setFontWeight(i === 0 ? 'bold' : 'normal');
  }
}

// Демо-даты: смещение от сегодня
function dAgo_(days) {
  var d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

/* ═══════════════════════════════════════════════════════════════
 * 3. ПЛАНЕР ПРИВЫЧЕК — «ШТАБ ДИСЦИПЛИНЫ» (ядро игры)
 *    Сетка месяца с чекбоксами → монеты, серия, множитель, уровень.
 * ═══════════════════════════════════════════════════════════════ */

function buildHabits(demo, folder) {
  var ss = newSpreadsheet_('Магнат · Привычки', folder);
  var s0 = ss.getSheets()[0];

  var dash = makeSheet_(ss, '📊 Дашборд',   36, 16, C.green);
  var grid = makeSheet_(ss, '✅ Привычки',  16, 33, null);
  var hist = makeSheet_(ss, '📅 История',   24,  7, null);
  var set  = makeSheet_(ss, '⚙️ Настройки', 34,  6, null);
  var calc = makeSheet_(ss, '_calc',        60, 16, null);
  dropDefaultSheet_(ss, s0);

  /* ---------- ⚙️ Настройки ---------- */
  var today = new Date();
  set.setColumnWidth(1, 230); set.setColumnWidth(2, 110);
  set.setColumnWidths(3, 4, 130);
  set.getRange('A1').setValue('⚙️ НАСТРОЙКИ ШТАБА').setFontWeight('bold').setFontSize(13);
  set.getRange('A3').setValue('Год');   set.getRange('B3').setValue(today.getFullYear());
  set.getRange('A4').setValue('Месяц (1–12)'); set.getRange('B4').setValue(today.getMonth() + 1);
  set.getRange('A6').setValue('День в зачёт серии — привычек минимум'); set.getRange('B6').setValue(3);
  set.getRange('A7').setValue('Монеты прошлых месяцев 🪙'); set.getRange('B7').setValue(demo ? 2140 : 0);
  set.getRange('A8').setValue('Рекорд серии прошлых месяцев'); set.getRange('B8').setValue(demo ? 9 : 0);
  set.getRange('A3:A8').setFontColor(C.dim);
  set.getRange('B3:B8').setFontWeight('bold').setHorizontalAlignment('left');

  set.getRange('A9').setValue('Привычка (до 10)').setFontWeight('bold');
  set.getRange('B9').setValue('Монет за раз').setFontWeight('bold');
  gridHeader_(set.getRange('A9:B9'));
  var habits = [
    ['🏋️ Тренировка', 30], ['📚 Час на главное дело', 25], ['💰 Шаг к деньгам', 30],
    ['🧊 Холодный душ', 15], ['💧 Вода 2 литра', 10], ['🧘 Медитация 10 минут', 15]
  ];
  set.getRange(10, 1, habits.length, 2).setValues(habits);
  boxBorder_(set.getRange('A9:B19'));
  set.getRange('B10:B19').setHorizontalAlignment('center');

  // Справочник уровней (только чтение)
  set.getRange('D9').setValue('Уровень').setFontWeight('bold');
  set.getRange('E9').setValue('Монет нужно').setFontWeight('bold');
  gridHeader_(set.getRange('D9:E9'));
  set.getRange(10, 4, 5, 2).setValues([
    ['🐣 Новичок', 0], ['🚀 Стартапер', 300], ['💼 Предприниматель', 1500],
    ['🏢 Директор', 5000], ['👑 Магнат', 15000]
  ]);
  boxBorder_(set.getRange('D9:E14'));
  set.getRange('E10:E14').setNumberFormat('#,##0').setHorizontalAlignment('center');

  settingsHint_(set, 22, 1, 5, [
    'Как настроить под себя (1 минута):',
    '1. Впиши свои привычки и «цену» каждой в монетах (10–30). Пустые строки — можно.',
    '2. Новый месяц: на листе «📅 История» скопируй строку итогов вниз (как значения),',
    '    затем поменяй месяц здесь и сними галочки на листе «✅ Привычки».',
    '3. Больше ничего трогать не нужно — дашборд считает всё сам.'
  ]);

  /* ---------- ✅ Привычки: сетка месяца ---------- */
  grid.setColumnWidth(1, 168);
  grid.setColumnWidths(2, 31, 27);
  grid.setColumnWidth(33, 52);
  grid.setFrozenColumns(1);
  grid.setFrozenRows(2);

  grid.getRange('B1').setFormula("=DATE('⚙️ Настройки'!$B$3,'⚙️ Настройки'!$B$4,1)");
  for (var c = 3; c <= 32; c++) {
    grid.getRange(1, c).setFormula('=IF(' + colA1(c - 1) + '1="","",IF(' + colA1(c - 1) + '1+1>EOMONTH($B$1,0),"",' + colA1(c - 1) + '1+1))');
  }
  grid.getRange('B1:AF1').setNumberFormat('d').setFontWeight('bold').setFontSize(8)
      .setHorizontalAlignment('center').setFontColor(C.ink);
  for (var c2 = 2; c2 <= 32; c2++) {
    grid.getRange(2, c2).setFormula('=IF(' + colA1(c2) + '$1="","",CHOOSE(WEEKDAY(' + colA1(c2) + '$1,2),"пн","вт","ср","чт","пт","сб","вс"))');
  }
  grid.getRange('B2:AF2').setFontSize(7).setFontColor(C.dim).setHorizontalAlignment('center');
  grid.getRange('A1').setValue('ПРИВЫЧКА');
  grid.getRange('A2').setValue('отмечай галочкой ↓');
  grid.getRange('A1').setFontWeight('bold').setFontSize(8).setFontColor(C.dim);
  grid.getRange('A2').setFontSize(7).setFontColor(C.dim);
  grid.getRange('AG1').setValue('%').setFontWeight('bold').setFontSize(8).setHorizontalAlignment('center');

  for (var r = 3; r <= 12; r++) {
    grid.getRange(r, 1).setFormula("=IF('⚙️ Настройки'!A" + (r + 7) + '="","",\'⚙️ Настройки\'!A' + (r + 7) + ')');
    grid.getRange(r, 33).setFormula('=IF($A' + r + '="","",IFERROR(COUNTIFS($B' + r + ':$AF' + r + ',TRUE)/MAX(1,MIN(TODAY(),EOMONTH($B$1,0))-$B$1+1),0))');
  }
  grid.getRange('A3:A12').setFontSize(9).setFontWeight('bold');
  grid.getRange('AG3:AG12').setNumberFormat('0%').setFontSize(8).setHorizontalAlignment('center');
  grid.getRange(3, 2, 10, 31).insertCheckboxes();
  grid.getRange(3, 2, 10, 31).setHorizontalAlignment('center').setFontSize(8);

  grid.getRange('A13').setValue('Монеты дня 🪙').setFontWeight('bold').setFontSize(8).setFontColor(C.gold);
  grid.getRange('A14').setValue('Выполнено, % дня').setFontWeight('bold').setFontSize(8).setFontColor(C.green);
  for (var c3 = 2; c3 <= 32; c3++) {
    var L = colA1(c3);
    grid.getRange(13, c3).setFormula('=IF(' + L + '$1="","",SUMPRODUCT(--(' + L + '$3:' + L + '$12=TRUE),\'⚙️ Настройки\'!$B$10:$B$19))');
    grid.getRange(14, c3).setFormula('=IF(' + L + '$1="","",IFERROR(COUNTIF(' + L + '$3:' + L + '$12,TRUE)/COUNTA(\'⚙️ Настройки\'!$A$10:$A$19),0))');
  }
  grid.getRange('B13:AF13').setFontSize(7).setHorizontalAlignment('center').setFontColor(C.gold);
  grid.getRange('B14:AF14').setNumberFormat('0%').setFontSize(6).setHorizontalAlignment('center').setFontColor(C.green);
  grid.getRange('A16').setValue('💡 Сегодняшний столбец подсвечен золотым. Заполняй раз в день — 20 секунд.')
      .setFontSize(8).setFontColor(C.dim);

  boxBorder_(grid.getRange(1, 1, 14, 33));

  var gridRules = [];
  // пустые «хвостовые» дни короткого месяца — приглушить
  gridRules.push(cfRule_(grid, '=B$1=""', C.graySoft, C.graySoft, [grid.getRange('B1:AF14')]));
  // сегодня — золотая колонка
  gridRules.push(cfRule_(grid, '=B$1=TODAY()', C.goldSoft, null, [grid.getRange('B1:AF14')]));
  // отмеченные чекбоксы — зелёная заливка
  gridRules.push(cfRule_(grid, '=B3=TRUE', C.greenSoft, C.green, [grid.getRange('B3:AF12')]));
  // heatmap: % дня
  gridRules.push(SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
    .setGradientMaxpointWithValue('#8fd6b4', SpreadsheetApp.InterpolationType.NUMBER, '1')
    .setRanges([grid.getRange('B14:AF14')]).build());
  grid.setConditionalFormatRules(gridRules);

  /* ---------- _calc ---------- */
  calc.getRange('A1:M1').setValues([['день', 'дата', 'монеты', 'сделано', 'зачёт', 'серия', 'множитель', 'монеты×', 'накоп.', 'день нед.', 'ср. сделано', '', '% дня (график)']]);
  var idx = [];
  for (var i = 1; i <= 31; i++) idx.push([i]);
  calc.getRange(2, 1, 31, 1).setValues(idx);
  for (var r2 = 2; r2 <= 32; r2++) {
    calc.getRange(r2, 2).setFormula('=IF($A' + r2 + '>DAY(EOMONTH(DATE(\'⚙️ Настройки\'!$B$3,\'⚙️ Настройки\'!$B$4,1),0)),"",DATE(\'⚙️ Настройки\'!$B$3,\'⚙️ Настройки\'!$B$4,1)+$A' + r2 + '-1)');
    calc.getRange(r2, 3).setFormula('=IF($B' + r2 + '="","",INDEX(\'✅ Привычки\'!$B$13:$AF$13,1,$A' + r2 + '))');
    calc.getRange(r2, 4).setFormula('=IF($B' + r2 + '="",0,COUNTIF(INDEX(\'✅ Привычки\'!$B$3:$AF$12,0,$A' + r2 + '),TRUE))');
    calc.getRange(r2, 5).setFormula('=IF(OR($B' + r2 + '="",$B' + r2 + '>TODAY()),0,IF(D' + r2 + '>=\'⚙️ Настройки\'!$B$6,1,0))');
    calc.getRange(r2, 6).setFormula('=IF(E' + r2 + '=1,N(F' + (r2 - 1) + ')+1,0)');
    calc.getRange(r2, 7).setFormula('=IF($B' + r2 + '="","",MIN(2,1+0.1*N(F' + (r2 - 1) + ')))');
    calc.getRange(r2, 8).setFormula('=IF(OR($B' + r2 + '="",$B' + r2 + '>TODAY()),0,ROUND(N(C' + r2 + ')*G' + r2 + ',0))');
    calc.getRange(r2, 9).setFormula('=SUM($H$2:H' + r2 + ')');
    calc.getRange(r2, 13).setFormula('=IF(OR($B' + r2 + '="",$B' + r2 + '>TODAY()),"",INDEX(\'✅ Привычки\'!$B$14:$AF$14,1,$A' + r2 + '))');
  }
  calc.getRange('B2:B32').setNumberFormat('dd.MM');

  // средний «сделано» по дням недели
  calc.getRange(2, 10, 7, 1).setValues([['пн'], ['вт'], ['ср'], ['чт'], ['пт'], ['сб'], ['вс']]);
  for (var k = 2; k <= 8; k++) {
    calc.getRange(k, 11).setFormula('=IFERROR(SUMPRODUCT(($B$2:$B$32<>"")*($B$2:$B$32<=TODAY())*(WEEKDAY(IF($B$2:$B$32="",1,$B$2:$B$32),2)=(ROW()-1))*$D$2:$D$32)/(COUNTA(\'⚙️ Настройки\'!$A$10:$A$19)*SUMPRODUCT(($B$2:$B$32<>"")*($B$2:$B$32<=TODAY())*(WEEKDAY(IF($B$2:$B$32="",1,$B$2:$B$32),2)=(ROW()-1)))),0)');
  }

  // сводные показатели
  var S = [
    ['монеты сегодня',    '=IFERROR(INDEX($H$2:$H$32,MATCH(TODAY(),$B$2:$B$32,0)),0)'],
    ['серия',             '=IFERROR(INDEX($F$2:$F$32,MATCH(TODAY(),$B$2:$B$32,0)),0)'],
    ['множитель',         '=MIN(2,1+0.1*B36)'],
    ['рекорд серии (мес)', '=MAX($F$2:$F$32)'],
    ['монеты месяца',     '=SUM($H$2:$H$32)'],
    ['монеты всего',      "='⚙️ Настройки'!$B$7+B39"],
    ['уровень',           '=LOOKUP(B40,' + LEVELS_N + ',' + LEVELS_RU + ')'],
    ['порог следующего',  '=LOOKUP(B40,' + LEVELS_N + ',' + LEVEL_NEXT + ')'],
    ['монет в уровне',    '=B40-LOOKUP(B40,' + LEVELS_N + ',' + LEVELS_N + ')'],
    ['размер уровня',     '=B42-LOOKUP(B40,' + LEVELS_N + ',' + LEVELS_N + ')'],
    ['осталось до след.', '=MAX(0,B42-B40)'],
    ['% месяца',          '=IFERROR(SUMPRODUCT(($B$2:$B$32<>"")*($B$2:$B$32<=TODAY())*$D$2:$D$32)/(COUNTA(\'⚙️ Настройки\'!$A$10:$A$19)*SUMPRODUCT(($B$2:$B$32<>"")*($B$2:$B$32<=TODAY()))),0)'],
    ['сделано сегодня',   '=IFERROR(INDEX($D$2:$D$32,MATCH(TODAY(),$B$2:$B$32,0)),0)'],
    ['лучший день',       '=IFERROR(INDEX($J$2:$J$8,MATCH(MAX($K$2:$K$8),$K$2:$K$8,0)),"")'],
    ['лучший день, ср.',  '=IFERROR(MAX($K$2:$K$8)/COUNTA(\'⚙️ Настройки\'!$A$10:$A$19)*COUNTA(\'⚙️ Настройки\'!$A$10:$A$19),0)'],
    ['инсайт',            ''],
    ['лучшая привычка',   "=IFERROR(INDEX('✅ Привычки'!$A$3:$A$12,MATCH(MAX('✅ Привычки'!$AG$3:$AG$12),'✅ Привычки'!$AG$3:$AG$12,0)),\"\")"],
    ['отстающая привычка', "=IFERROR(INDEX('✅ Привычки'!$A$3:$A$12,MATCH(MIN(FILTER('✅ Привычки'!$AG$3:$AG$12,'✅ Привычки'!$A$3:$A$12<>\"\")),'✅ Привычки'!$AG$3:$AG$12,0)),\"\")"],
    ['донат: остаток',    '=MAX(0,1-B46)']
  ];
  for (var s = 0; s < S.length; s++) {
    calc.getRange(35 + s, 1).setValue(S[s][0]);
    if (S[s][1]) calc.getRange(35 + s, 2).setFormula(S[s][1]);
  }
  // K-значения — «в среднем сделано из N»; лучший день в долях для текста
  calc.getRange('B49').setFormula('=IFERROR(MAX($K$2:$K$8)/COUNTA(\'⚙️ Настройки\'!$A$10:$A$19),0)');
  calc.getRange('B50').setFormula('=IF(SUM($D$2:$D$32)=0,"💡 Отметь первые привычки на листе «✅ Привычки» — серия, монеты и уровень посчитаются сами.","💡 Твой сильный день — "&B48&" ("&TEXT(B49,"0%")&" привычек). "&IF(B36>0,"Серия "&B36&" дн., множитель ×"&TEXT(B37,"0.0")&" — ещё день, и он вырастет до ×"&TEXT(MIN(2,1+0.1*(B36+1)),"0.0")&".","Сегодня серия на нуле: отметь "&\'⚙️ Настройки\'!$B$6&" привычки — и день пойдёт в зачёт."))');
  // данные для пончика
  calc.getRange('O2').setValue('Выполнено'); calc.getRange('P2').setFormula('=B46');
  calc.getRange('O3').setValue('Осталось');  calc.getRange('P3').setFormula('=B53');

  /* ---------- 📅 История ---------- */
  hist.setColumnWidth(1, 120); hist.setColumnWidths(2, 5, 120);
  hist.getRange('A1').setValue('📅 ИСТОРИЯ МЕСЯЦЕВ').setFontWeight('bold').setFontSize(13);
  hist.getRange('A3:F3').setValues([['Месяц', '% месяца', 'Монеты 🪙', 'Рекорд серии', 'Лучшая привычка', '']]);
  gridHeader_(hist.getRange('A3:F3'));
  hist.getRange('A4').setFormula("=TEXT(DATE('⚙️ Настройки'!$B$3,'⚙️ Настройки'!$B$4,1),\"MMMM yyyy\")&\" (текущий)\"");
  hist.getRange('B4').setFormula("='_calc'!$B$46").setNumberFormat('0%');
  hist.getRange('C4').setFormula("='_calc'!$B$39");
  hist.getRange('D4').setFormula("='_calc'!$B$38");
  hist.getRange('E4').setFormula("='_calc'!$B$51");
  hist.getRange('A4:F4').setBackground(C.greenSoft);
  if (demo) {
    hist.getRange(5, 1, 2, 5).setValues([
      ['май 2026', 0.71, 1080, 9, '💧 Вода 2 литра'],
      ['июнь 2026', 0.78, 1060, 7, '🏋️ Тренировка']
    ]);
    hist.getRange('B5:B6').setNumberFormat('0%');
  }
  boxBorder_(hist.getRange('A3:F10'));
  hist.getRange('A12').setValue('В конце месяца: выдели строку 4 → Ctrl+C → вставь ниже через «Специальная вставка → Только значения».')
      .setFontSize(8).setFontColor(C.dim);
  hist.getRange('A2').setValue('Динамика монет по месяцам:').setFontSize(8).setFontColor(C.dim);
  hist.getRange('F4').setFormula('=IFERROR(SPARKLINE($C$4:$C$10,{"charttype","column";"color","#c98a12"}),"")');

  /* ---------- 📊 Дашборд ---------- */
  dashCanvas_(dash, 14, 64);
  dash.setRowHeight(1, 10);
  dashTitle_(dash, 2, 2, 14, 'ШТАБ ДИСЦИПЛИНЫ', C.green,
    "=TEXT(DATE('⚙️ Настройки'!$B$3,'⚙️ Настройки'!$B$4,1),\"MMMM yyyy\")", C.dim);
  dash.setRowHeight(3, 8);

  kpiRowHeights_(dash, 4);
  kpiTile_(dash, 4, 2, 3,  { label: 'Серия', accent: C.gold,
    f: "=\"🔥 \"&'_calc'!$B$36&\" дн.\"",
    df: "=\"рекорд — \"&MAX('_calc'!$B$38,'⚙️ Настройки'!$B$8)&\" дн.\"" });
  kpiTile_(dash, 4, 5, 3,  { label: 'Множитель', accent: C.green,
    f: "=\"×\"&TEXT('_calc'!$B$37,\"0.0\")", dv: 'максимум — ×2' });
  kpiTile_(dash, 4, 8, 3,  { label: 'Монеты сегодня', accent: C.gold, valueColor: C.gold,
    f: "=\"+\"&'_calc'!$B$35&\" 🪙\"",
    df: "=IF('_calc'!$B$47>='⚙️ Настройки'!$B$6,\"день в зачёте ✓\",\"ещё \"&MAX(0,'⚙️ Настройки'!$B$6-'_calc'!$B$47)&\" — и день в зачёте\")" });
  kpiTile_(dash, 4, 11, 3, { label: 'Уровень', accent: C.purple,
    f: "='_calc'!$B$41",
    df: "=IF('_calc'!$B$45=0,\"это максимум — ты Магнат!\",\"до следующего — \"&'_calc'!$B$45&\" 🪙\")" });
  kpiTile_(dash, 4, 14, 2, { label: '% месяца', accent: C.blue,
    f: "=TEXT('_calc'!$B$46,\"0%\")",
    df: "=\"монет за месяц: \"&'_calc'!$B$39" });

  dash.setRowHeight(7, 10);
  sectionLab_(dash, 8, 2, 7, 'Кривая месяца · выполнено привычек по дням');
  sectionLab_(dash, 8, 10, 5, 'Месяц выполнен на');
  for (var rr = 9; rr <= 17; rr++) dash.setRowHeight(rr, 21);
  addChart_(dash, Charts.ChartType.AREA,
    [calc.getRange('A2:A32'), calc.getRange('M2:M32')], 9, 2,
    { width: 500, height: 186, colors: [C.green],
      vAxis: { format: 'percent', textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });
  addChart_(dash, Charts.ChartType.PIE,
    [calc.getRange('O2:P3')], 9, 10,
    { width: 310, height: 186, pieHole: 0.62, colors: [C.green, C.track],
      pieSliceText: 'none', legend: 'right' });

  dash.setRowHeight(18, 24);
  dash.getRange(18, 2, 1, 3).merge().setFormula("='_calc'!$B$41")
      .setFontWeight('bold').setFontColor(C.purple).setFontSize(11);
  dash.getRange(18, 5, 1, 7).merge().setFormula(
    '=IFERROR(SPARKLINE(\'_calc\'!$B$43,{"charttype","bar";"max",MAX(1,\'_calc\'!$B$44);"color1","#7a52d0"}),"")');
  dash.getRange(18, 12, 1, 3).merge()
      .setFormula("='_calc'!$B$40&\" / \"&'_calc'!$B$42&\" 🪙\"")
      .setFontSize(9).setFontColor(C.dim).setHorizontalAlignment('right');

  dash.setRowHeight(19, 10);
  sectionLab_(dash, 20, 2, 5, 'Сильные дни · в среднем сделано');
  sectionLab_(dash, 20, 7, 9, 'Эта неделя');
  for (var rr2 = 21; rr2 <= 29; rr2++) dash.setRowHeight(rr2, 21);
  addChart_(dash, Charts.ChartType.COLUMN,
    [calc.getRange('J2:J8'), calc.getRange('K2:K8')], 21, 2,
    { width: 340, height: 186, colors: [C.gold],
      vAxis: { textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });

  // Срез текущей недели: первые 7 привычек × пн…вс
  gridHeader_(dash.getRange(21, 7, 1, 9));
  dash.getRange(21, 7, 1, 2).merge();
  dash.getRange(21, 7).setValue('Привычка').setHorizontalAlignment('left');
  for (var wd = 0; wd < 7; wd++) {
    dash.getRange(21, 9 + wd).setFormula('=TODAY()-WEEKDAY(TODAY(),2)+1+' + wd).setNumberFormat('ddd');
  }
  for (var hi = 0; hi < 7; hi++) {
    var drow = 22 + hi;
    dash.getRange(drow, 7, 1, 2).merge();
    dash.getRange(drow, 7).setFormula("=IF('✅ Привычки'!$A$" + (3 + hi) + '="","",\'✅ Привычки\'!$A$' + (3 + hi) + ')')
        .setFontSize(8).setHorizontalAlignment('left');
    for (var dj = 0; dj < 7; dj++) {
      var hdr = colA1(9 + dj) + '$21';
      dash.getRange(drow, 9 + dj).setFormula(
        '=IF($G' + drow + '="","",IFERROR(IF(INDEX(\'✅ Привычки\'!$B$3:$AF$12,' + (hi + 1) + ',MATCH(' + hdr + ',\'✅ Привычки\'!$B$1:$AF$1,0))=TRUE,"✓",IF(' + hdr + '>TODAY(),"","·")),"–"))')
        .setFontSize(9).setHorizontalAlignment('center');
    }
  }
  boxBorder_(dash.getRange(21, 7, 8, 9));
  var dashRules = [];
  dashRules.push(cfRule_(dash, '=I$21=TODAY()', C.goldSoft, null, [dash.getRange(21, 9, 8, 7)]));
  dashRules.push(cfRule_(dash, '=I22="✓"', null, C.green, [dash.getRange(22, 9, 7, 7)], { bold: true }));
  dashRules.push(cfRule_(dash, '=I22="·"', null, '#c3ccd8', [dash.getRange(22, 9, 7, 7)]));
  dash.setConditionalFormatRules(dashRules);

  dash.setRowHeight(30, 8);
  insightCell_(dash, 31, 2, 14, "='_calc'!$B$50");
  dash.getRange(34, 2, 1, 14).merge()
      .setValue('Считается само. Твоя задача одна: раз в день отметить галочки на листе «✅ Привычки».')
      .setFontSize(8).setFontColor(C.dim);

  /* ---------- демо-данные ---------- */
  if (demo) {
    var dToday = today.getDate();
    var vals = [];
    for (var hI = 0; hI < habits.length; hI++) {
      var row = [];
      for (var dD = 1; dD <= dToday; dD++) {
        var on = ((hI * 13 + dD * 7) % 10) < 8;
        if (dD > dToday - 6 && hI < 3) on = true;      // живая серия ≥ 3 привычек в день
        if (dD === dToday && hI >= 4) on = false;      // сегодня день ещё не закончен
        row.push(on);
      }
      vals.push(row);
    }
    grid.getRange(3, 2, habits.length, dToday).setValues(vals);
  }

  /* ---------- защита и порядок ---------- */
  protectWarn_(dash, 'Дашборд считается сам — правки не нужны');
  protectWarn_(grid, 'Меняй только галочки', [grid.getRange(3, 2, 10, 31)]);
  protectWarn_(calc, 'Служебные формулы');
  calc.hideSheet();
  ss.setActiveSheet(dash);
  ss.setSpreadsheetLocale('ru_RU'); // формулы уже сохранены — теперь можно
  SpreadsheetApp.flush();
  return 'Привычки: ' + ss.getUrl();
}

/* ═══════════════════════════════════════════════════════════════
 * 4. ПЛАНЕР ЗАДАЧ — «ЦЕНТР ЗАДАЧ» (управление потоком дел)
 *    Просрочка краснеет сама, «Осталось» считается само,
 *    дашборд следит за скоростью и дисциплиной сроков.
 * ═══════════════════════════════════════════════════════════════ */

var PRIO = ['🔴 Срочно', '🟠 Высокий', '🟡 Средний', '🟢 Низкий'];
var PRIO_COLORS = ['#e0556a', '#e0812a', '#c98a12', '#12a565'];

function buildTasks(demo, folder) {
  var ss = newSpreadsheet_('Магнат · Задачи', folder);
  var s0 = ss.getSheets()[0];

  var dash = makeSheet_(ss, '📊 Дашборд', 34, 16, C.gold);
  var t    = makeSheet_(ss, '🎯 Задачи', 150,  7, null);
  var arc  = makeSheet_(ss, '📁 Архив',  300,  7, null);
  var calc = makeSheet_(ss, '_calc',      20, 18, null);
  dropDefaultSheet_(ss, s0);

  /* ---------- 🎯 Задачи ---------- */
  var HEAD = [['✓', 'Задача', 'Приоритет', 'Срок', 'Осталось', 'Добавлена', 'Закрыта']];
  function taskSheetSkeleton(sh, rows) {
    sh.getRange('A1:G1').setValues(HEAD);
    gridHeader_(sh.getRange('A1:G1'));
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 34);  sh.setColumnWidth(2, 330); sh.setColumnWidth(3, 104);
    sh.setColumnWidth(4, 92);  sh.setColumnWidth(5, 80);  sh.setColumnWidth(6, 92);
    sh.setColumnWidth(7, 92);
    sh.getRange(2, 1, rows - 1, 1).insertCheckboxes();
    sh.getRange(2, 3, rows - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(PRIO, true).setAllowInvalid(true).build());
    sh.getRange(2, 4, rows - 1, 1).setNumberFormat('dd.MM.yyyy');
    sh.getRange(2, 6, rows - 1, 2).setNumberFormat('dd.MM.yyyy');
    sh.getRange(2, 5, rows - 1, 1).setHorizontalAlignment('center').setFontSize(9);
    sh.getRange(2, 2, rows - 1, 1).setFontSize(10);
    sh.getRange(2, 3, rows - 1, 2).setFontSize(9).setHorizontalAlignment('center');
    sh.getRange(2, 6, rows - 1, 2).setFontSize(9).setHorizontalAlignment('center').setFontColor(C.dim);
    boxBorder_(sh.getRange(1, 1, rows, 7));

    var rules = [];
    // выполненные — серые и зачёркнутые
    rules.push(cfRule_(sh, '=$A2=TRUE', null, '#9aa5b1', [sh.getRange(2, 2, rows - 1, 6)], { strike: true }));
    // просрочка — красная строка
    rules.push(cfRule_(sh, '=AND($A2<>TRUE,$B2<>"",$D2<>"",$D2<TODAY())', C.redSoft, C.red, [sh.getRange(2, 1, rows - 1, 7)]));
    // срок сегодня — золотая строка
    rules.push(cfRule_(sh, '=AND($A2<>TRUE,$B2<>"",$D2=TODAY())', C.goldSoft, null, [sh.getRange(2, 1, rows - 1, 7)]));
    // пилюли приоритетов
    rules.push(cfRule_(sh, '=$C2="🔴 Срочно"',  C.redSoft,  C.red,     [sh.getRange(2, 3, rows - 1, 1)], { bold: true }));
    rules.push(cfRule_(sh, '=$C2="🟠 Высокий"', '#fdf1e3',  '#b05f10', [sh.getRange(2, 3, rows - 1, 1)]));
    rules.push(cfRule_(sh, '=$C2="🟡 Средний"', C.goldSoft, C.gold,    [sh.getRange(2, 3, rows - 1, 1)]));
    rules.push(cfRule_(sh, '=$C2="🟢 Низкий"',  C.greenSoft, C.green,  [sh.getRange(2, 3, rows - 1, 1)]));
    sh.setConditionalFormatRules(rules);
  }
  taskSheetSkeleton(t, 150);
  taskSheetSkeleton(arc, 300);
  t.getRange('E2').setFormula(
    '=ARRAYFORMULA(IF($B$2:$B$150="","",IF($A$2:$A$150=TRUE,"✓",IF($D$2:$D$150="","—",IF($D$2:$D$150-TODAY()<0,TEXT($D$2:$D$150-TODAY(),"0")&" дн.",IF($D$2:$D$150-TODAY()=0,"сегодня",IF($D$2:$D$150-TODAY()=1,"завтра",($D$2:$D$150-TODAY())&" дн.")))))))');
  arc.getRange('E2').setFormula('=ARRAYFORMULA(IF($B$2:$B$300="","","✓"))');

  /* ---------- _calc ---------- */
  var T = "'🎯 Задачи'!";
  var A = "'📁 Архив'!";
  var KP = [
    ['открыто',        '=COUNTIFS(' + T + '$B$2:$B$150,"<>",' + T + '$A$2:$A$150,FALSE)'],
    ['горит',          '=COUNTIFS(' + T + '$B$2:$B$150,"<>",' + T + '$A$2:$A$150,FALSE,' + T + '$D$2:$D$150,"<"&TODAY(),' + T + '$D$2:$D$150,"<>")'],
    ['к сегодня',      '=COUNTIFS(' + T + '$B$2:$B$150,"<>",' + T + '$A$2:$A$150,FALSE,' + T + '$D$2:$D$150,"<="&TODAY(),' + T + '$D$2:$D$150,"<>")'],
    ['закрыто 7 дн',   '=COUNTIFS(' + T + '$G$2:$G$150,">="&TODAY()-6,' + T + '$G$2:$G$150,"<="&TODAY())+COUNTIFS(' + A + '$G$2:$G$300,">="&TODAY()-6,' + A + '$G$2:$G$300,"<="&TODAY())'],
    ['закрыто пред 7', '=COUNTIFS(' + T + '$G$2:$G$150,">="&TODAY()-13,' + T + '$G$2:$G$150,"<="&TODAY()-7)+COUNTIFS(' + A + '$G$2:$G$300,">="&TODAY()-13,' + A + '$G$2:$G$300,"<="&TODAY()-7)'],
    ['% в срок',       '=IFERROR((SUMPRODUCT((' + T + '$G$2:$G$150<>"")*(' + T + '$D$2:$D$150<>"")*(' + T + '$G$2:$G$150<=' + T + '$D$2:$D$150))+SUMPRODUCT((' + A + '$G$2:$G$300<>"")*(' + A + '$D$2:$D$300<>"")*(' + A + '$G$2:$G$300<=' + A + '$D$2:$D$300)))/(SUMPRODUCT((' + T + '$G$2:$G$150<>"")*(' + T + '$D$2:$D$150<>""))+SUMPRODUCT((' + A + '$G$2:$G$300<>"")*(' + A + '$D$2:$D$300<>""))),"")'],
    ['ср. возраст',    '=IFERROR(ROUND(AVERAGE(FILTER(TODAY()-' + T + '$F$2:$F$150,' + T + '$A$2:$A$150=FALSE,' + T + '$F$2:$F$150<>"",' + T + '$B$2:$B$150<>"")),0),"")'],
    ['старейшая просрочка', '=IFERROR(INDEX(SORT(FILTER({' + T + '$B$2:$B$150,' + T + '$D$2:$D$150},' + T + '$A$2:$A$150=FALSE,' + T + '$D$2:$D$150<>"",' + T + '$D$2:$D$150<TODAY()),2,TRUE),1,1),"")'],
    ['просрочена дней','=IFERROR(TODAY()-MIN(FILTER(' + T + '$D$2:$D$150,' + T + '$A$2:$A$150=FALSE,' + T + '$D$2:$D$150<>"",' + T + '$D$2:$D$150<TODAY())),"")'],
    ['пик-день',       '=IF(MAX($K$2:$K$8)=0,"",INDEX($J$2:$J$8,MATCH(MAX($K$2:$K$8),$K$2:$K$8,0)))'],
    ['закрыто всего',  '=COUNT(' + T + '$G$2:$G$150)+COUNT(' + A + '$G$2:$G$300)'],
    ['закрыто в этом месяце', '=COUNTIFS(' + T + '$G$2:$G$150,">="&EOMONTH(TODAY(),-1)+1)+COUNTIFS(' + A + '$G$2:$G$300,">="&EOMONTH(TODAY(),-1)+1)'],
    ['лучший день, закрыто', '=MAX($K$2:$K$8)'],
    ['инсайт',         '=IF(COUNTIF(' + T + '$B$2:$B$150,"<>")=0,"💡 Добавь первые задачи на листе «🎯 Задачи» — дашборд оживёт.",IF(N(B3)>0,"💡 «"&B9&"» просрочена на "&B10&" дн. — закрой её первой."&IF(B11<>""," Твой пик продуктивности — "&B11&".",""),"💡 Просрочек нет — идеальный контроль сроков."&IF(B11<>""," Пик продуктивности — "&B11&": ставь сложное на него.","")))']
  ];
  for (var i = 0; i < KP.length; i++) {
    calc.getRange(2 + i, 1).setValue(KP[i][0]);
    calc.getRange(2 + i, 2).setFormula(KP[i][1]);
  }
  calc.getRange(2, 10, 7, 1).setValues([['пн'], ['вт'], ['ср'], ['чт'], ['пт'], ['сб'], ['вс']]); // J
  for (var k = 2; k <= 8; k++) {
    calc.getRange(k, 11).setFormula('=SUMPRODUCT((' + T + '$G$2:$G$150<>"")*(WEEKDAY(IF(' + T + '$G$2:$G$150="",1,' + T + '$G$2:$G$150),2)=(ROW()-1)))+SUMPRODUCT((' + A + '$G$2:$G$300<>"")*(WEEKDAY(IF(' + A + '$G$2:$G$300="",1,' + A + '$G$2:$G$300),2)=(ROW()-1)))');
  }
  calc.getRange(2, 13, 4, 1).setValues(PRIO.map(function (p) { return [p]; })); // M
  for (var p = 0; p < 4; p++) {
    calc.getRange(2 + p, 14).setFormula('=COUNTIFS(' + T + '$B$2:$B$150,"<>",' + T + '$A$2:$A$150,FALSE,' + T + '$C$2:$C$150,$M' + (2 + p) + ')');
  }
  calc.getRange('P2').setFormula('=IFERROR(SORTN(FILTER({' + T + '$B$2:$B$150,' + T + '$C$2:$C$150,' + T + '$D$2:$D$150},' + T + '$A$2:$A$150=FALSE,' + T + '$B$2:$B$150<>"",' + T + '$D$2:$D$150<>"",' + T + '$D$2:$D$150<=TODAY()+1),6,0,3,TRUE),"")');

  /* ---------- 📊 Дашборд ---------- */
  dashCanvas_(dash, 14, 64);
  dash.setRowHeight(1, 10);
  dashTitle_(dash, 2, 2, 14, 'ЦЕНТР ЗАДАЧ', C.gold,
    '=IFERROR(IF(\'_calc\'!$B$7="","",TEXT(\'_calc\'!$B$7,"0%")&" в срок"),"")', C.gold);
  dash.setRowHeight(3, 8);

  kpiRowHeights_(dash, 4);
  kpiTile_(dash, 4, 2, 3,  { label: 'Открыто', accent: C.gold,
    f: "='_calc'!$B$2",
    df: "='_calc'!$B$4&\" — к сегодняшнему дню\"" });
  kpiTile_(dash, 4, 5, 3,  { label: 'Горит', accent: C.red, valueColor: C.red,
    f: '=IF(\'_calc\'!$B$3=0,"0 🎉","⚠ "&\'_calc\'!$B$3)',
    df: '=IF(\'_calc\'!$B$3=0,"просрочек нет","старейшая — "&\'_calc\'!$B$10&" дн.")', deltaColor: C.red });
  kpiTile_(dash, 4, 8, 3,  { label: 'Закрыто за 7 дней', accent: C.green,
    f: "='_calc'!$B$5&\" ✓\"",
    df: '=IF(\'_calc\'!$B$6=0,"прошлая неделя — 0",TEXT(\'_calc\'!$B$5-\'_calc\'!$B$6,"+0;-0;0")&" к прошлой неделе")' });
  kpiTile_(dash, 4, 11, 3, { label: 'В срок', accent: C.blue,
    f: '=IF(\'_calc\'!$B$7="","—",TEXT(\'_calc\'!$B$7,"0%"))',
    dv: 'из закрытых со сроком' });
  kpiTile_(dash, 4, 14, 2, { label: 'Ср. возраст', accent: C.purple,
    f: '=IF(\'_calc\'!$B$8="","—",\'_calc\'!$B$8&" дн.")',
    dv: 'открытой задачи' });

  dash.setRowHeight(7, 10);
  sectionLab_(dash, 8, 2, 7, 'Сегодня в фокусе · срок сегодня-завтра и просрочка');
  sectionLab_(dash, 8, 10, 5, 'Открытые по приоритету');
  gridHeader_(dash.getRange(9, 2, 1, 7));
  dash.getRange(9, 2, 1, 5).merge();
  dash.getRange(9, 2).setValue('Задача').setHorizontalAlignment('left');
  dash.getRange(9, 7).setValue('Приоритет');
  dash.getRange(9, 8).setValue('Срок');
  for (var f = 0; f < 6; f++) {
    var frow = 10 + f;
    dash.setRowHeight(frow, 22);
    dash.getRange(frow, 2, 1, 5).merge();
    if (f === 0) {
      dash.getRange(frow, 2).setFormula('=IF(\'_calc\'!$P2="","🎉 Горящих задач нет — займись важным, но несрочным",\'_calc\'!$P2)');
    } else {
      dash.getRange(frow, 2).setFormula("=IF('_calc'!$P" + (2 + f) + '="","",\'_calc\'!$P' + (2 + f) + ')');
    }
    dash.getRange(frow, 2).setFontSize(9).setHorizontalAlignment('left');
    dash.getRange(frow, 7).setFormula("=IF('_calc'!$Q" + (2 + f) + '="","",\'_calc\'!$Q' + (2 + f) + ')')
        .setFontSize(8).setHorizontalAlignment('center');
    dash.getRange(frow, 8).setFormula("=IF('_calc'!$R" + (2 + f) + '="","",\'_calc\'!$R' + (2 + f) + ')')
        .setNumberFormat('d MMM').setFontSize(8).setHorizontalAlignment('center').setFontColor(C.dim);
  }
  boxBorder_(dash.getRange(9, 2, 7, 7));
  var dRules = [];
  dRules.push(cfRule_(dash, '=AND($H10<>"",$H10<TODAY())', null, C.red, [dash.getRange(10, 8, 6, 1)], { bold: true }));
  dRules.push(cfRule_(dash, '=$G10="🔴 Срочно"', null, C.red, [dash.getRange(10, 7, 6, 1)], { bold: true }));
  dash.setConditionalFormatRules(dRules);

  addChart_(dash, Charts.ChartType.PIE, [calc.getRange('M2:N5')], 9, 10,
    { width: 316, height: 160, pieHole: 0.6, colors: PRIO_COLORS, pieSliceText: 'value', legend: 'right' });
  for (var rr = 9; rr <= 15; rr++) if (rr > 9) dash.setRowHeight(rr, 22);

  dash.setRowHeight(16, 12);
  sectionLab_(dash, 17, 2, 6, 'Закрыто по дням недели');
  sectionLab_(dash, 17, 9, 7, 'Статистика потока');
  for (var rr2 = 18; rr2 <= 26; rr2++) dash.setRowHeight(rr2, 21);
  addChart_(dash, Charts.ChartType.COLUMN,
    [calc.getRange('J2:J8'), calc.getRange('K2:K8')], 18, 2,
    { width: 400, height: 186, colors: [C.gold],
      vAxis: { textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });

  var stats = [
    ['Закрыто всего',            "='_calc'!$B$12"],
    ['Закрыто в этом месяце',    "='_calc'!$B$13"],
    ['Лучший день недели',       '=IF(\'_calc\'!$B$11="","—",\'_calc\'!$B$11&" · "&\'_calc\'!$B$14&" задач")'],
    ['Скорость, задач в неделю', "='_calc'!$B$5"],
    ['Дисциплина сроков',        '=IF(\'_calc\'!$B$7="","—",TEXT(\'_calc\'!$B$7,"0%")&" в срок")']
  ];
  for (var st = 0; st < stats.length; st++) {
    var srow = 18 + st * 2;
    dash.getRange(srow, 9, 1, 4).merge().setValue(stats[st][0]).setFontSize(9).setFontColor(C.dim);
    dash.getRange(srow, 13, 1, 3).merge().setFormula(stats[st][1])
        .setFontSize(10).setFontWeight('bold').setHorizontalAlignment('right');
    dash.getRange(srow, 9, 1, 7).setBorder(null, null, true, null, null, null, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  }

  dash.setRowHeight(28, 10);
  insightCell_(dash, 29, 2, 14, "='_calc'!$B$15");
  dash.getRange(32, 2, 1, 14).merge()
      .setValue('Поставил(а) ✓ — впиши дату в «Закрыта»: графики скорости и «% в срок» строятся по ней. Разросся список — перенеси закрытые в «📁 Архив».')
      .setFontSize(8).setFontColor(C.dim);

  /* ---------- демо-данные ---------- */
  if (demo) {
    var demoT = [
      [false, '🎬 Смонтировать ролик из поездки',   '🟠 Высокий', 0,  3, null],
      [false, '✍️ Написать 5 сценариев для Reels',  '🟡 Средний', 1,  2, null],
      [true,  '📚 Прочитать 20 страниц «Атланта»',  '🟢 Низкий', -1,  6, 1],
      [false, '💸 Оплатить кредитку',               '🔴 Срочно', -1,  4, null],
      [false, '📞 Позвонить маме',                  '🟡 Средний', 3, 1, null],
      [true,  '🧾 Отправить отчёт самозанятого',    '🟠 Высокий', -2, 8, 2],
      [true,  '🛒 Заказать корм коту',              '🟢 Низкий', -3,  5, 3],
      [true,  '📨 Ответить на письма клиентов',     '🟡 Средний', -4, 6, 4],
      [true,  '📊 Свести бюджет месяца',            '🟠 Высокий', -5, 7, 5],
      [true,  '🧹 Разобрать рабочий стол',          '🟢 Низкий', -6,  9, 6],
      [false, '🎨 Обновить обложку канала',         '🟡 Средний', 5,  2, null],
      [true,  '🚗 Записаться на ТО',                '🟢 Низкий', -7, 10, 7]
    ];
    for (var d = 0; d < demoT.length; d++) {
      var row = 2 + d;
      t.getRange(row, 1).setValue(demoT[d][0]);
      t.getRange(row, 2).setValue(demoT[d][1]);
      t.getRange(row, 3).setValue(demoT[d][2]);
      t.getRange(row, 4).setValue(dAgo_(-demoT[d][3]));   // срок = сегодня + смещение
      t.getRange(row, 6).setValue(dAgo_(demoT[d][4]));
      if (demoT[d][5] !== null) t.getRange(row, 7).setValue(dAgo_(demoT[d][5]));
    }
    arc.getRange(2, 1, 3, 4).setValues([
      [true, '🏦 Открыть вклад под 16%',     '🟠 Высокий', dAgo_(12)],
      [true, '📦 Продать велосипед на Авито', '🟢 Низкий',  dAgo_(10)],
      [true, '🧯 Поменять батарейку в датчике дыма', '🟡 Средний', dAgo_(9)]
    ]);
    arc.getRange(2, 6, 3, 2).setValues([
      [dAgo_(15), dAgo_(12)], [dAgo_(20), dAgo_(11)], [dAgo_(14), dAgo_(9)]
    ]);
  }

  /* ---------- защита и порядок ---------- */
  protectWarn_(dash, 'Дашборд считается сам');
  protectWarn_(t, 'Вводи задачи, колонка «Осталось» считается сама',
    [t.getRange(2, 1, 149, 4), t.getRange(2, 6, 149, 2)]);
  protectWarn_(calc, 'Служебные формулы');
  calc.hideSheet();
  ss.setActiveSheet(dash);
  ss.setSpreadsheetLocale('ru_RU'); // формулы уже сохранены — теперь можно
  SpreadsheetApp.flush();
  return 'Задачи: ' + ss.getUrl();
}

/* ═══════════════════════════════════════════════════════════════
 * 5. ФИТНЕС-ПЛАНЕР — «ПАНЕЛЬ ФОРМЫ» (путь к цели)
 *    Одна запись в день → вес с прогнозом даты цели, радар мышц,
 *    сон/ккал/вода против личных норм.
 * ═══════════════════════════════════════════════════════════════ */

var MUSCLES = ['Грудь', 'Спина', 'Ноги', 'Руки', 'Плечи', 'Пресс'];
var MOODS = ['😄', '🙂', '😐', '😕', '😫'];

function buildFitness(demo, folder) {
  var ss = newSpreadsheet_('Магнат · Тело', folder);
  var s0 = ss.getSheets()[0];

  var dash = makeSheet_(ss, '📊 Дашборд',  30, 16, C.red);
  var d    = makeSheet_(ss, '📓 Дневник', 400,  9, null);
  var set  = makeSheet_(ss, '⚙️ Настройки', 26, 6, null);
  var calc = makeSheet_(ss, '_calc',      410, 18, null);
  dropDefaultSheet_(ss, s0);

  var DN = "'📓 Дневник'!";

  /* ---------- ⚙️ Настройки ---------- */
  set.setColumnWidth(1, 230); set.setColumnWidth(2, 110); set.setColumnWidths(3, 4, 130);
  set.getRange('A1').setValue('⚙️ НАСТРОЙКИ ФОРМЫ').setFontWeight('bold').setFontSize(13);
  set.getRange('A3').setValue('Цель веса, кг');            set.getRange('B3').setValue(demo ? 75 : '');
  set.getRange('A4').setValue('Норма калорий в день');     set.getRange('B4').setValue(2400);
  set.getRange('A5').setValue('Норма воды, л');            set.getRange('B5').setValue(2);
  set.getRange('A6').setValue('План тренировок в неделю'); set.getRange('B6').setValue(demo ? 5 : 3);
  set.getRange('A7').setValue('Стартовый вес, кг (сам берёт первый замер)');
  set.getRange('B7').setFormula('=IFERROR(INDEX(FILTER(' + DN + '$B$2:$B$400,' + DN + '$B$2:$B$400<>""),1),"")');
  set.getRange('A3:A7').setFontColor(C.dim);
  set.getRange('B3:B7').setFontWeight('bold').setHorizontalAlignment('left');
  set.getRange('D9').setValue('Группы мышц (для радара)').setFontWeight('bold');
  set.getRange(10, 4, MUSCLES.length, 1).setValues(MUSCLES.map(function (m) { return [m]; }));
  settingsHint_(set, 20, 1, 5, [
    'Как пользоваться (20 секунд в день):',
    '1. Впиши цель веса — «Путь к цели» и прогноз даты построятся сами.',
    '2. Раз в день добавляй строку в «📓 Дневник»: вес и что успел отметить.',
    '3. Пустые клетки — нормально: формулы считают только по заполненным.'
  ]);

  /* ---------- 📓 Дневник ---------- */
  d.getRange('A1:I1').setValues([['Дата', 'Вес, кг', 'Ккал', 'Вода, л', 'Сон, ч', 'Тренировка', 'Группа мышц', 'Настроение', 'Заметка']]);
  gridHeader_(d.getRange('A1:I1'));
  d.setFrozenRows(1);
  d.setColumnWidth(1, 86); d.setColumnWidths(2, 4, 68); d.setColumnWidth(6, 86);
  d.setColumnWidth(7, 110); d.setColumnWidth(8, 92); d.setColumnWidth(9, 220);
  d.getRange('A2:A400').setNumberFormat('dd.MM.yyyy');
  d.getRange('B2:B400').setNumberFormat('0.0');
  d.getRange('D2:E400').setNumberFormat('0.0');
  d.getRange(2, 6, 399, 1).insertCheckboxes();
  d.getRange(2, 7, 399, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(set.getRange('D10:D15'), true).setAllowInvalid(true).build());
  d.getRange(2, 8, 399, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(MOODS, true).setAllowInvalid(true).build());
  d.getRange(2, 2, 399, 7).setHorizontalAlignment('center');
  d.getRange(2, 9, 399, 1).setHorizontalAlignment('left').setFontColor(C.dim).setFontSize(9);
  boxBorder_(d.getRange(1, 1, 60, 9));
  var dRules = [];
  dRules.push(cfRule_(d, '=$F2=TRUE', C.greenSoft, null, [d.getRange(2, 1, 399, 9)]));
  dRules.push(cfRule_(d, '=AND($A2<>"",$A2=TODAY())', C.goldSoft, null, [d.getRange(2, 1, 399, 9)]));
  d.setConditionalFormatRules(dRules);

  /* ---------- _calc ---------- */
  var FK = [
    ['', ''],
    ['вес последний',   '=IFERROR(LOOKUP(2,1/(' + DN + '$B$2:$B$400<>""),' + DN + '$B$2:$B$400),"")'],
    ['вес 30 дн назад', '=IFERROR(INDEX(FILTER(' + DN + '$B$2:$B$400,' + DN + '$B$2:$B$400<>"",' + DN + '$A$2:$A$400>=TODAY()-30),1),"")'],
    ['дельта месяц',    '=IF(OR($B$2="",$B$3=""),"",$B$2-$B$3)'],
    ['старт',           "='⚙️ Настройки'!$B$7"],
    ['цель',            "='⚙️ Настройки'!$B$3"],
    ['прогресс, доля',  '=IFERROR(IF($B$5=$B$6,1,MAX(0,MIN(1,($B$5-$B$2)/($B$5-$B$6)))),0)'],
    ['осталось, кг',    '=IF(OR($B$2="",$B$6=""),"",ROUND(ABS($B$2-$B$6),1))'],
    ['тренировки 30 дн','=COUNTIFS(' + DN + '$F$2:$F$400,TRUE,' + DN + '$A$2:$A$400,">="&TODAY()-29)'],
    ['тренировки 7 дн', '=COUNTIFS(' + DN + '$F$2:$F$400,TRUE,' + DN + '$A$2:$A$400,">="&TODAY()-6)'],
    ['сон ср 7 дн',     '=IFERROR(ROUND(AVERAGE(FILTER(' + DN + '$E$2:$E$400,' + DN + '$E$2:$E$400<>"",' + DN + '$A$2:$A$400>=TODAY()-6)),1),"")'],
    ['сон ср пред 7',   '=IFERROR(ROUND(AVERAGE(FILTER(' + DN + '$E$2:$E$400,' + DN + '$E$2:$E$400<>"",' + DN + '$A$2:$A$400>=TODAY()-13,' + DN + '$A$2:$A$400<=TODAY()-7)),1),"")'],
    ['ккал сегодня',    '=IFERROR(INDEX(FILTER(' + DN + '$C$2:$C$400,' + DN + '$C$2:$C$400<>"",' + DN + '$A$2:$A$400=TODAY()),1),"")'],
    ['вода сегодня',    '=IFERROR(INDEX(FILTER(' + DN + '$D$2:$D$400,' + DN + '$D$2:$D$400<>"",' + DN + '$A$2:$A$400=TODAY()),1),"")'],
    ['темп кг/нед (30 дн)', '=IFERROR(SLOPE(FILTER(' + DN + '$B$2:$B$400,' + DN + '$B$2:$B$400<>"",' + DN + '$A$2:$A$400>=TODAY()-29),FILTER(' + DN + '$A$2:$A$400,' + DN + '$B$2:$B$400<>"",' + DN + '$A$2:$A$400>=TODAY()-29))*7,"")'],
    ['прогноз даты цели','=IF(OR($B$15="",$B$15=0,$B$2="",$B$6=""),"",IF($B$2=$B$6,"цель достигнута 🎉",IF(SIGN($B$6-$B$2)<>SIGN($B$15),"",TEXT(TODAY()+($B$6-$B$2)/($B$15/7),"d MMMM yyyy"))))'],
    ['отстающая группа', '=IF(SUM($K$2:$K$7)=0,"",INDEX($J$2:$J$7,MATCH(MIN($K$2:$K$7),$K$2:$K$7,0)))'],
    ['сильная группа',  '=IF(SUM($K$2:$K$7)=0,"",INDEX($J$2:$J$7,MATCH(MAX($K$2:$K$7),$K$2:$K$7,0)))'],
    ['настроение недели','=IFERROR(TEXTJOIN(" ",TRUE,FILTER(' + DN + '$H$2:$H$400,' + DN + '$H$2:$H$400<>"",' + DN + '$A$2:$A$400>=TODAY()-6)),"")'],
    ['инсайт', '=IF(COUNT(' + DN + '$B$2:$B$400)=0,"💡 Внеси первую запись в «📓 Дневник» — график веса, радар мышц и прогноз оживут.","💡 "&IF($B$4="","",("За 30 дней "&TEXT($B$4,"+0.0;-0.0;0")&" кг. "))&IF($B$16="","",IF($B$16="цель достигнута 🎉","Цель достигнута — удерживай результат! ","Таким темпом цель "&TEXT($B$6,"0.0")&" кг будет достигнута к "&$B$16&". "))&IF($B$17="","",IF($B$17=$B$18,"",$B$18&" — твоя сильная сторона, а вот "&$B$17&" отстают: добавь один подход. ")))']
  ];
  for (var i = 1; i < FK.length; i++) {
    calc.getRange(i + 1, 1).setValue(FK[i][0]);
    calc.getRange(i + 1, 2).setFormula(FK[i][1]);
  }
  // радар: подходы по группам за 30 дней
  calc.getRange(1, 10, 1, 2).setValues([['группа', 'тренировок']]);
  for (var m = 0; m < MUSCLES.length; m++) {
    calc.getRange(2 + m, 10).setFormula("='⚙️ Настройки'!$D$" + (10 + m));
    calc.getRange(2 + m, 11).setFormula('=COUNTIFS(' + DN + '$G$2:$G$400,$J$' + (2 + m) + ',' + DN + '$F$2:$F$400,TRUE,' + DN + '$A$2:$A$400,">="&TODAY()-29)');
  }
  // график веса: отсортированные пары дата-вес + линия цели
  calc.getRange('N1:P1').setValues([['дата', 'вес', 'цель']]);
  calc.getRange('N2').setFormula('=IFERROR(SORT(FILTER({' + DN + '$A$2:$A$400,' + DN + '$B$2:$B$400},' + DN + '$B$2:$B$400<>"",' + DN + '$A$2:$A$400<>""),1,TRUE),"")');
  calc.getRange('P2').setFormula('=ARRAYFORMULA(IF($N$2:$N$400="","",IF(\'⚙️ Настройки\'!$B$3="","",\'⚙️ Настройки\'!$B$3+0*ROW($N$2:$N$400))))');
  calc.getRange('N2:N30').setNumberFormat('dd.MM');

  /* ---------- 📊 Дашборд ---------- */
  dashCanvas_(dash, 14, 64);
  dash.setRowHeight(1, 10);
  dashTitle_(dash, 2, 2, 14, 'ПАНЕЛЬ ФОРМЫ', C.red,
    '=IF(\'_calc\'!$B$4="","",TEXT(\'_calc\'!$B$4,"+0.0;-0.0;0")&" кг за месяц")', C.green);
  dash.setRowHeight(3, 8);

  kpiRowHeights_(dash, 4);
  kpiTile_(dash, 4, 2, 3,  { label: 'Вес', accent: C.red,
    f: '=IF(\'_calc\'!$B$2="","—",TEXT(\'_calc\'!$B$2,"0.0")&" кг")',
    df: '=IF(\'_calc\'!$B$4="","добавь замеры",TEXT(\'_calc\'!$B$4,"+0.0;-0.0;0")&" кг за 30 дней")' });
  kpiTile_(dash, 4, 5, 3,  { label: 'Тренировки за неделю', accent: C.green,
    f: '=\'_calc\'!$B$10&" / "&\'⚙️ Настройки\'!$B$6',
    df: '="за 30 дней — "&\'_calc\'!$B$9' });
  kpiTile_(dash, 4, 8, 3,  { label: 'Калории сегодня', accent: C.gold,
    f: '=IF(\'_calc\'!$B$13="","—",\'_calc\'!$B$13)',
    df: '="норма — "&\'⚙️ Настройки\'!$B$4' });
  kpiTile_(dash, 4, 11, 3, { label: 'Сон · 7 дней', accent: C.blue,
    f: '=IF(\'_calc\'!$B$11="","—",TEXT(\'_calc\'!$B$11,"0.0")&" ч")',
    df: '=IF(OR(\'_calc\'!$B$11="",\'_calc\'!$B$12=""),"считаю по неделе",TEXT(\'_calc\'!$B$11-\'_calc\'!$B$12,"+0.0;-0.0;0")&" ч к прошлой неделе")' });
  kpiTile_(dash, 4, 14, 2, { label: 'Вода', accent: C.blue,
    f: '=IF(\'_calc\'!$B$14="","—",TEXT(\'_calc\'!$B$14,"0.0")&" л")',
    df: '="норма — "&TEXT(\'⚙️ Настройки\'!$B$5,"0.0")&" л"' });

  dash.setRowHeight(7, 10);
  sectionLab_(dash, 8, 2, 14, 'Путь к цели');
  dash.setRowHeight(9, 24);
  dash.getRange(9, 2, 1, 2).merge()
      .setFormula('=IF(\'_calc\'!$B$5="","старт: —","старт "&TEXT(\'_calc\'!$B$5,"0.0"))')
      .setFontSize(9).setFontColor(C.dim);
  dash.getRange(9, 4, 1, 8).merge().setFormula(
    '=IFERROR(SPARKLINE(\'_calc\'!$B$7,{"charttype","bar";"max",1;"color1","#12a565"}),"")');
  dash.getRange(9, 12, 1, 3).merge()
      .setFormula('=IF(\'_calc\'!$B$8="","поставь цель в Настройках","осталось "&TEXT(\'_calc\'!$B$8,"0.0")&" кг · "&TEXT(\'_calc\'!$B$7,"0%")&" пути · цель "&TEXT(\'_calc\'!$B$6,"0.0"))')
      .setFontSize(9).setFontColor(C.ink).setFontWeight('bold').setHorizontalAlignment('right');

  dash.setRowHeight(10, 10);
  sectionLab_(dash, 11, 2, 7, 'Вес · факт и цель');
  sectionLab_(dash, 11, 10, 5, 'Баланс мышц · тренировок за 30 дней');
  for (var rr = 12; rr <= 21; rr++) dash.setRowHeight(rr, 21);
  addChart_(dash, Charts.ChartType.LINE,
    [calc.getRange('N1:P400')], 12, 2,
    { width: 500, height: 208, colors: [C.red, C.gold], numHeaders: 1,
      series: { 0: { lineWidth: 3 }, 1: { lineWidth: 1 } },
      vAxis: { textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });
  addChart_(dash, Charts.ChartType.RADAR,
    [calc.getRange('J1:K7')], 12, 10,
    { width: 316, height: 208, colors: [C.red], legend: 'none', numHeaders: 1 });

  sectionLab_(dash, 22, 2, 7, 'Тренировки этой недели');
  sectionLab_(dash, 22, 10, 6, 'Настроение недели');
  dash.setRowHeight(23, 24);
  for (var wd = 0; wd < 7; wd++) {
    var cell = dash.getRange(23, 2 + wd);
    cell.setFormula('=TEXT(TODAY()-WEEKDAY(TODAY(),2)+1+' + wd + ',"ddd")&" "&IF(COUNTIFS(' + DN + '$A$2:$A$400,TODAY()-WEEKDAY(TODAY(),2)+1+' + wd + ',' + DN + '$F$2:$F$400,TRUE)>0,"✓",IF(TODAY()-WEEKDAY(TODAY(),2)+1+' + wd + '>TODAY(),"","·"))')
        .setFontSize(9).setHorizontalAlignment('center')
        .setBorder(true, true, true, true, false, false, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  }
  dash.getRange(23, 10, 1, 6).merge().setFormula("='_calc'!$B$19")
      .setFontSize(12).setHorizontalAlignment('left');
  var fRules = [];
  fRules.push(cfRule_(dash, '=RIGHT(B23,1)="✓"', C.greenSoft, C.green, [dash.getRange(23, 2, 1, 7)], { bold: true }));
  dash.setConditionalFormatRules(fRules);

  dash.setRowHeight(24, 10);
  insightCell_(dash, 25, 2, 14, "='_calc'!$B$20");
  dash.getRange(28, 2, 1, 14).merge()
      .setValue('Одна строка в день в «📓 Дневник» — вес, галочка тренировки, группа мышц. Остальное построится само.')
      .setFontSize(8).setFontColor(C.dim);

  /* ---------- демо-данные ---------- */
  if (demo) {
    var rows = [];
    var groups = ['Ноги', 'Грудь', 'Спина', 'Пресс', 'Руки', 'Ноги', 'Спина', 'Грудь', 'Пресс', 'Ноги', 'Руки', 'Спина'];
    var gi = 0;
    for (var back = 29; back >= 0; back--) {
      var dayIdx = 29 - back;
      var w = Math.round((83.6 - dayIdx * 0.163 + ((dayIdx * 7) % 3) * 0.12) * 10) / 10;
      var kcal = 2250 + ((dayIdx * 13) % 5) * 50;
      var water = Math.round((1.5 + ((dayIdx * 7) % 4) * 0.3) * 10) / 10;
      var sleep = Math.round((6.9 + ((dayIdx * 11) % 5) * 0.3) * 10) / 10;
      var wo = (back % 7 !== 1 && back % 7 !== 3 && back % 7 !== 6);
      var grp = wo ? groups[(gi++) % groups.length] : '';
      var mood = MOODS[(dayIdx * 3) % MOODS.length];
      rows.push([dAgo_(back), w, kcal, water, sleep, wo, grp, mood, '']);
    }
    d.getRange(2, 1, rows.length, 9).setValues(rows);
  }

  /* ---------- защита и порядок ---------- */
  protectWarn_(dash, 'Дашборд считается сам');
  protectWarn_(d, 'Дневник — твой лист ввода', [d.getRange(2, 1, 399, 9)]);
  protectWarn_(calc, 'Служебные формулы');
  calc.hideSheet();
  ss.setActiveSheet(dash);
  ss.setSpreadsheetLocale('ru_RU'); // формулы уже сохранены — теперь можно
  SpreadsheetApp.flush();
  return 'Тело: ' + ss.getUrl();
}

/* ═══════════════════════════════════════════════════════════════
 * 6. ПЛАНЕР НЕДЕЛИ — «ПУЛЬТ НЕДЕЛИ» (энергия и фокус)
 *    3 главных дела в день + энергия 1–5 + настроение.
 *    Дашборд сравнивает неделю с прошлой (архив в «Рефлексии»).
 * ═══════════════════════════════════════════════════════════════ */

function buildWeek(demo, folder) {
  var ss = newSpreadsheet_('Магнат · Неделя', folder);
  var s0 = ss.getSheets()[0];

  var dash = makeSheet_(ss, '📊 Дашборд',   30, 16, C.purple);
  var wk   = makeSheet_(ss, '📅 Неделя',    34,  6, null);
  var ref  = makeSheet_(ss, '🧭 Рефлексия', 26,  6, null);
  var calc = makeSheet_(ss, '_calc',        20, 12, null);
  dropDefaultSheet_(ss, s0);

  var WN = "'📅 Неделя'!";

  /* ---------- 📅 Неделя ---------- */
  // понедельник текущей недели — значением (пользователь двигает раз в неделю)
  var now = new Date(); now.setHours(12, 0, 0, 0);
  var monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  wk.getRange('A1').setValue('Неделя с').setFontColor(C.dim);
  wk.getRange('B1').setValue(monday).setNumberFormat('dd.MM.yyyy').setFontWeight('bold');
  wk.getRange('C1').setValue('← в понедельник поставь новую дату (итог недели прежде сохрани в «🧭 Рефлексия»)')
    .setFontSize(8).setFontColor(C.dim);

  wk.getRange('A2:E2').setValues([['День', 'Три главных дела', '✓', 'Энергия 1–5', 'Настроение']]);
  gridHeader_(wk.getRange('A2:E2'));
  wk.setColumnWidth(1, 110); wk.setColumnWidth(2, 330); wk.setColumnWidth(3, 40);
  wk.setColumnWidth(4, 90);  wk.setColumnWidth(5, 96);  wk.setColumnWidth(6, 40);
  for (var i = 0; i < 7; i++) {
    var r0 = 3 + i * 3;
    wk.getRange(r0, 1, 3, 1).merge();
    wk.getRange(r0, 1).setFormula('=$B$1+' + i).setNumberFormat('ddd, d MMM')
      .setFontWeight('bold').setFontSize(9).setHorizontalAlignment('center');
    wk.getRange(r0, 3, 3, 1).insertCheckboxes();
    wk.getRange(r0, 4, 3, 1).merge();
    wk.getRange(r0, 4).setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(true)
        .setHelpText('Энергия дня: от 1 (выжат) до 5 (огонь)').build())
      .setHorizontalAlignment('center').setFontWeight('bold').setFontColor(C.purple);
    wk.getRange(r0, 5, 3, 1).merge();
    wk.getRange(r0, 5).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(MOODS, true).setAllowInvalid(true).build())
      .setHorizontalAlignment('center').setFontSize(13);
    // нижняя граница блока дня
    wk.getRange(r0 + 2, 1, 1, 5).setBorder(null, null, true, null, null, null, C.grid, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  }
  boxBorder_(wk.getRange(2, 1, 22, 5));
  wk.getRange('A26').setValue('🎯 ФОКУС-ЦЕЛИ НЕДЕЛИ (максимум три)').setFontWeight('bold').setFontSize(10);
  wk.getRange(27, 2, 3, 1).setFontSize(10);
  wk.getRange(27, 3, 3, 1).insertCheckboxes();
  boxBorder_(wk.getRange(27, 2, 3, 2));
  var wkRules = [];
  wkRules.push(cfRule_(wk, '=$B$1+INT((ROW()-3)/3)=TODAY()', C.purpleSoft, null, [wk.getRange(3, 1, 21, 5)]));
  wkRules.push(cfRule_(wk, '=$C3=TRUE', null, '#9aa5b1', [wk.getRange(3, 2, 21, 1)], { strike: true }));
  wk.setConditionalFormatRules(wkRules);

  /* ---------- _calc ---------- */
  calc.getRange('A1:G1').setValues([['i', 'дата', 'день', 'сделано', 'план', 'энергия', 'настроение']]);
  for (var j = 0; j < 7; j++) {
    var cr = 2 + j, br = 3 + j * 3;
    calc.getRange(cr, 1).setValue(j);
    calc.getRange(cr, 2).setFormula('=' + WN + '$B$1+' + j);
    calc.getRange(cr, 3).setFormula('=TEXT($B' + cr + ',"ddd")');
    calc.getRange(cr, 4).setFormula('=COUNTIF(' + WN + '$C$' + br + ':$C$' + (br + 2) + ',TRUE)');
    calc.getRange(cr, 5).setFormula('=COUNTA(' + WN + '$B$' + br + ':$B$' + (br + 2) + ')');
    calc.getRange(cr, 6).setFormula('=IF(' + WN + '$D$' + br + '="","",' + WN + '$D$' + br + ')');
    calc.getRange(cr, 7).setFormula('=IF(' + WN + '$E$' + br + '="","",' + WN + '$E$' + br + ')');
  }
  calc.getRange('B2:B8').setNumberFormat('dd.MM');
  var WS = [
    ['сделано всего',   '=SUM($D$2:$D$8)'],
    ['план всего',      '=SUM($E$2:$E$8)'],
    ['% недели',        '=IFERROR($B$11/$B$12,0)'],
    ['энергия средняя', '=IFERROR(ROUND(AVERAGE(FILTER($F$2:$F$8,$F$2:$F$8<>"")),1),"")'],
    ['пик энергии',     '=IFERROR(INDEX($C$2:$C$8,MATCH(MAX(FILTER($F$2:$F$8,$F$2:$F$8<>"")),$F$2:$F$8,0)),"")'],
    ['спад энергии',    '=IFERROR(INDEX($C$2:$C$8,MATCH(MIN(FILTER($F$2:$F$8,$F$2:$F$8<>"")),$F$2:$F$8,0)),"")'],
    ['фокус сделано',   '=COUNTIF(' + WN + '$C$27:$C$29,TRUE)'],
    ['фокус план',      '=COUNTA(' + WN + '$B$27:$B$29)'],
    ['прошлая неделя %','=IFERROR(LOOKUP(2,1/(\'🧭 Рефлексия\'!$B$3:$B$22<>""),\'🧭 Рефлексия\'!$B$3:$B$22),"")'],
    ['инсайт',          '=IF($B$12=0,"💡 Впиши в «📅 Неделя» три главных дела на каждый день — пульт оживёт.","💡 "&IF($B$16="","Отмечай энергию дней 1–5 — увижу, когда ты на пике. ",IF($B$15=$B$16,"Энергия ровная всю неделю. ","Пик энергии — "&$B$15&", спад — "&$B$16&": сложное планируй на "&$B$15&", лёгкое — на "&$B$16&". "))&IF($B$19="","",("Прошлая неделя — "&TEXT($B$19,"0%")&", эта — "&TEXT($B$13,"0%")&IF($B$13>=$B$19," 📈.",".")))&IF(AND($B$18>0,$B$17=$B$18)," Все фокус-цели закрыты 👑.",""))']
  ];
  for (var w = 0; w < WS.length; w++) {
    calc.getRange(11 + w, 1).setValue(WS[w][0]);
    calc.getRange(11 + w, 2).setFormula(WS[w][1]);
  }

  /* ---------- 🧭 Рефлексия ---------- */
  ref.setColumnWidth(1, 150); ref.setColumnWidths(2, 4, 110); ref.setColumnWidth(5, 320);
  ref.getRange('A1').setValue('🧭 РЕФЛЕКСИЯ · АРХИВ НЕДЕЛЬ').setFontWeight('bold').setFontSize(13);
  ref.getRange('A2:E2').setValues([['Неделя', '% дел', 'Энергия ср.', 'Фокус-цели', 'Главный итог недели (впиши сам)']]);
  gridHeader_(ref.getRange('A2:E2'));
  ref.getRange('A3').setFormula('=TEXT(' + WN + '$B$1,"d MMM")&" – "&TEXT(' + WN + '$B$1+6,"d MMM")&" (текущая)"');
  ref.getRange('B3').setFormula("='_calc'!$B$13").setNumberFormat('0%');
  ref.getRange('C3').setFormula("='_calc'!$B$14");
  ref.getRange('D3').setFormula("='_calc'!$B$17&\" / \"&'_calc'!$B$18");
  ref.getRange('A3:E3').setBackground(C.purpleSoft);
  if (demo) {
    ref.getRange(4, 1, 2, 5).setValues([
      ['22 июн – 28 июн', 0.58, 3.1, '1 / 3', 'Запустил лендинг, но распылялся на мелочи'],
      ['29 июн – 5 июл',  0.64, 3.4, '2 / 3', 'Лучшая неделя месяца — помог план на утро']
    ]);
    ref.getRange('B4:B5').setNumberFormat('0%');
  }
  boxBorder_(ref.getRange('A2:E12'));
  ref.getRange('A14').setValue('Вечер воскресенья: строку 3 скопируй ниже через «Специальная вставка → Только значения», впиши главный итог, затем на «📅 Неделя» поставь дату нового понедельника и сними галочки.')
     .setFontSize(8).setFontColor(C.dim);

  /* ---------- 📊 Дашборд ---------- */
  dashCanvas_(dash, 14, 64);
  dash.setRowHeight(1, 10);
  dashTitle_(dash, 2, 2, 14, 'ПУЛЬТ НЕДЕЛИ', C.purple,
    '="неделя "&TEXT(' + WN + '$B$1,"d MMM")&" – "&TEXT(' + WN + '$B$1+6,"d MMM")', C.dim);
  dash.setRowHeight(3, 8);

  kpiRowHeights_(dash, 4);
  kpiTile_(dash, 4, 2, 3,  { label: 'Выполнено', accent: C.purple,
    f: "='_calc'!$B$11&\" / \"&'_calc'!$B$12",
    df: '=TEXT(\'_calc\'!$B$13,"0%")&" недели"' });
  kpiTile_(dash, 4, 5, 3,  { label: 'Энергия', accent: C.gold,
    f: '=IF(\'_calc\'!$B$14="","—","⚡ "&TEXT(\'_calc\'!$B$14,"0.0")&" / 5")',
    df: '=IF(\'_calc\'!$B$15="","отмечай энергию дней","пик — "&\'_calc\'!$B$15)' });
  kpiTile_(dash, 4, 8, 3,  { label: 'Фокус-цели', accent: C.green,
    f: "='_calc'!$B$17&\" / \"&'_calc'!$B$18",
    dv: 'главные цели недели' });
  kpiTile_(dash, 4, 11, 3, { label: 'К прошлой неделе', accent: C.blue,
    f: '=IF(\'_calc\'!$B$19="","—",TEXT(\'_calc\'!$B$13-\'_calc\'!$B$19,"+0%;-0%;0%"))',
    df: '=IF(\'_calc\'!$B$19="","появится после первой записи в Рефлексии","прошлая — "&TEXT(\'_calc\'!$B$19,"0%"))' });
  kpiTile_(dash, 4, 14, 2, { label: 'Сегодня', accent: C.gold,
    f: '=IFERROR(INDEX(\'_calc\'!$D$2:$D$8,MATCH(TODAY(),\'_calc\'!$B$2:$B$8,0))&" / "&INDEX(\'_calc\'!$E$2:$E$8,MATCH(TODAY(),\'_calc\'!$B$2:$B$8,0)),"—")',
    dv: 'дела дня' });

  dash.setRowHeight(7, 10);
  sectionLab_(dash, 8, 2, 14, 'Дни недели · дела, энергия, настроение');
  dash.setRowHeight(9, 20); dash.setRowHeight(10, 24); dash.setRowHeight(11, 14); dash.setRowHeight(12, 22);
  for (var cday = 0; cday < 7; cday++) {
    var cc = 2 + cday * 2, crr = 2 + cday;
    dash.getRange(9, cc, 1, 2).merge();
    dash.getRange(9, cc).setFormula("='_calc'!$B$" + crr).setNumberFormat('ddd d')
        .setFontSize(8).setFontWeight('bold').setFontColor(C.dim).setHorizontalAlignment('center');
    dash.getRange(10, cc, 1, 2).merge();
    dash.getRange(10, cc).setFormula("=IF('_calc'!$E$" + crr + '=0,"—",\'_calc\'!$D$' + crr + '&" / "&\'_calc\'!$E$' + crr + ')')
        .setFontSize(12).setFontWeight('bold').setHorizontalAlignment('center');
    dash.getRange(11, cc, 1, 2).merge();
    dash.getRange(11, cc).setFormula('=IF(\'_calc\'!$F$' + crr + '="","",IFERROR(SPARKLINE(\'_calc\'!$F$' + crr + ',{"charttype","bar";"max",5;"color1","#7a52d0"}),""))');
    dash.getRange(12, cc, 1, 2).merge();
    dash.getRange(12, cc).setFormula('=IF(\'_calc\'!$G$' + crr + '="","·",\'_calc\'!$G$' + crr + ')')
        .setFontSize(13).setHorizontalAlignment('center');
    dash.getRange(9, cc, 4, 2).setBorder(true, true, true, true, false, false, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  }
  var wdRules = [];
  wdRules.push(cfRule_(dash, '=B$9=TODAY()', C.purpleSoft, null, [dash.getRange(9, 2, 4, 14)]));
  dash.setConditionalFormatRules(wdRules);

  dash.setRowHeight(13, 12);
  sectionLab_(dash, 14, 2, 7, 'Кривая энергии');
  sectionLab_(dash, 14, 10, 6, 'Фокус-цели недели');
  for (var rr = 15; rr <= 22; rr++) dash.setRowHeight(rr, 21);
  addChart_(dash, Charts.ChartType.AREA,
    [calc.getRange('C2:C8'), calc.getRange('F2:F8')], 15, 2,
    { width: 470, height: 166, colors: [C.purple],
      vAxis: { minValue: 0, maxValue: 5, textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });
  for (var g = 0; g < 3; g++) {
    var grow = 15 + g * 2;
    dash.getRange(grow, 10, 1, 6).merge();
    dash.getRange(grow, 10).setFormula('=IF(' + WN + '$B$' + (27 + g) + '="","○ впиши цель на листе «📅 Неделя»",IF(' + WN + '$C$' + (27 + g) + '=TRUE,"✅ ","○ ")&' + WN + '$B$' + (27 + g) + ')')
        .setFontSize(10).setFontWeight('bold');
    dash.getRange(grow, 10, 1, 6).setBorder(null, null, true, null, null, null, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  }
  dash.getRange(21, 10, 1, 3).merge().setValue('ПРОШЛЫЕ НЕДЕЛИ, % ДЕЛ')
      .setFontSize(7).setFontColor(C.dim).setFontWeight('bold');
  dash.getRange(22, 10, 1, 6).merge().setFormula(
    '=IFERROR(SPARKLINE(\'🧭 Рефлексия\'!$B$4:$B$22,{"charttype","column";"color","#7a52d0"}),"")');

  dash.setRowHeight(23, 10);
  insightCell_(dash, 24, 2, 14, "='_calc'!$B$20");
  dash.getRange(27, 2, 1, 14).merge()
      .setValue('Утром — три дела и фокус, вечером — галочки, энергия и настроение. В воскресенье строка итога сохраняется в «🧭 Рефлексия».')
      .setFontSize(8).setFontColor(C.dim);

  /* ---------- демо-данные ---------- */
  if (demo) {
    var todayIdx = (now.getDay() + 6) % 7; // 0 = понедельник
    var deeds = [
      ['Смонтировать интро для канала', 'Тренировка ноги', 'Разобрать почту до нуля'],
      ['Написать план запуска', 'Позвонить бухгалтеру', 'Прогулка 5 км'],
      ['Снять 3 сторис', 'Тренировка грудь', 'Прочитать 30 страниц'],
      ['Собрать смету ремонта', 'Встреча с партнёром', 'Ранний отбой в 23:00'],
      ['Финалить лендинг', 'Тренировка спина', 'Свести бюджет недели'],
      ['Генеральная уборка', 'Баня с друзьями', 'План на следующую неделю'],
      ['День без соцсетей', 'Долгая прогулка', 'Приготовить обеды на 3 дня']
    ];
    var energy = [3, 4, 3, 2, 5, 4, 3];
    for (var dd = 0; dd < 7; dd++) {
      var rr0 = 3 + dd * 3;
      wk.getRange(rr0, 2, 3, 1).setValues([[deeds[dd][0]], [deeds[dd][1]], [deeds[dd][2]]]);
      if (dd <= todayIdx) {
        var doneCnt = (dd === todayIdx) ? 2 : (dd % 3 === 0 ? 3 : 2);
        for (var dc = 0; dc < doneCnt; dc++) wk.getRange(rr0 + dc, 3).setValue(true);
        wk.getRange(rr0, 4).setValue(energy[dd]);
        wk.getRange(rr0, 5).setValue(MOODS[[1, 0, 1, 3, 0, 1, 2][dd]]);
      }
    }
    wk.getRange(27, 2, 3, 1).setValues([['Запустить сайт-визитку'], ['3 тренировки за неделю'], ['Дочитать «Атланта»']]);
    wk.getRange(27, 3).setValue(true);
    wk.getRange(28, 3).setValue(true);
  }

  /* ---------- защита и порядок ---------- */
  protectWarn_(dash, 'Дашборд считается сам');
  protectWarn_(wk, 'Заполняй дела, галочки, энергию и настроение',
    [wk.getRange('B1'), wk.getRange(3, 2, 21, 4), wk.getRange(27, 2, 3, 2)]);
  protectWarn_(calc, 'Служебные формулы');
  calc.hideSheet();
  ss.setActiveSheet(dash);
  ss.setSpreadsheetLocale('ru_RU'); // формулы уже сохранены — теперь можно
  SpreadsheetApp.flush();
  return 'Неделя: ' + ss.getUrl();
}

/* ═══════════════════════════════════════════════════════════════
 * 7. ФИНАНСОВЫЙ ПЛАНЕР — «КАПИТАЛ» (деньги под контролем)
 *    Журнал операций → план/факт, копилка, подушка безопасности,
 *    прогноз расхода до конца месяца, топ-траты, долги.
 * ═══════════════════════════════════════════════════════════════ */

var CAT_EXP = ['🍔 Еда', '🏠 Жильё', '🚗 Транспорт', '🎮 Досуг', '👕 Одежда', '💊 Здоровье',
               '📚 Образование', '🎁 Подарки', '📱 Связь', '🧴 Быт', '✈️ Путешествия', '📦 Прочее'];
var CAT_INC = ['💼 Зарплата', '🚀 Подработка', '📈 Инвестиции', '🎉 Прочий доход'];
var CAT_COLORS = ['#12a565', '#2f8fd8', '#c98a12', '#7a52d0', '#e0556a', '#0e7a99',
                  '#8a6d3b', '#d0679d', '#5b6b7f', '#66a61e', '#b45f06', '#98a2b3'];

function buildFinance(demo, folder) {
  var ss = newSpreadsheet_('Магнат · Финансы', folder);
  var s0 = ss.getSheets()[0];

  var dash = makeSheet_(ss, '📊 Дашборд',  34, 16, C.gold);
  var op   = makeSheet_(ss, '💸 Операции', 500,  5, null);
  var pl   = makeSheet_(ss, '📋 Планы',    16,  6, null);
  var debt = makeSheet_(ss, '🧾 Долги',    12,  6, null);
  var set  = makeSheet_(ss, '⚙️ Настройки', 36,  6, null);
  var calc = makeSheet_(ss, '_calc',       20, 14, null);
  dropDefaultSheet_(ss, s0);

  var OP = "'💸 Операции'!";
  var PL = "'📋 Планы'!";
  var DB = "'🧾 Долги'!";

  /* ---------- ⚙️ Настройки ---------- */
  set.setColumnWidth(1, 250); set.setColumnWidth(2, 110); set.setColumnWidths(3, 4, 140);
  set.getRange('A1').setValue('⚙️ НАСТРОЙКИ КАПИТАЛА').setFontWeight('bold').setFontSize(13);
  set.getRange('A3').setValue('Цель сбережений, % дохода'); set.getRange('B3').setValue(0.15).setNumberFormat('0%');
  set.getRange('A4').setValue('Подушка безопасности, цель в месяцах'); set.getRange('B4').setValue(6);
  set.getRange('A5').setValue('Подушка: уже накоплено, ₽'); set.getRange('B5').setValue(demo ? 245000 : 0).setNumberFormat('#,##0');
  set.getRange('A3:A5').setFontColor(C.dim);
  set.getRange('B3:B5').setFontWeight('bold').setHorizontalAlignment('left');
  set.getRange('D8').setValue('Категории расходов').setFontWeight('bold');
  set.getRange(9, 4, CAT_EXP.length, 1).setValues(CAT_EXP.map(function (c) { return [c]; }));
  set.getRange('E8').setValue('Категории доходов').setFontWeight('bold');
  set.getRange(9, 5, CAT_INC.length, 1).setValues(CAT_INC.map(function (c) { return [c]; }));
  settingsHint_(set, 24, 1, 5, [
    'Как настроить под себя (2 минуты):',
    '1. Поправь категории под свою жизнь (можно переименовать, дописать до 12).',
    '2. На листе «📋 Планы» поставь план на месяц по каждой категории.',
    '3. Впиши, сколько уже отложено в подушку, — дашборд посчитает месяцы запаса.',
    '4. Дальше — просто заноси операции. 15 секунд на запись.'
  ]);

  /* ---------- 💸 Операции ---------- */
  op.getRange('A1:E1').setValues([['Дата', 'Тип', 'Категория', 'Сумма, ₽', 'Комментарий']]);
  gridHeader_(op.getRange('A1:E1'));
  op.setFrozenRows(1);
  op.setColumnWidth(1, 90); op.setColumnWidth(2, 100); op.setColumnWidth(3, 140);
  op.setColumnWidth(4, 100); op.setColumnWidth(5, 240);
  op.getRange('A2:A500').setNumberFormat('dd.MM.yyyy');
  op.getRange('D2:D500').setNumberFormat('#,##0');
  op.getRange(2, 2, 499, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['💸 Расход', '💰 Доход'], true).setAllowInvalid(false).build());
  op.getRange(2, 3, 499, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(set.getRange('D9:E20'), true).setAllowInvalid(true).build());
  op.getRange(2, 1, 499, 4).setHorizontalAlignment('center');
  op.getRange(2, 5, 499, 1).setFontColor(C.dim).setFontSize(9);
  boxBorder_(op.getRange(1, 1, 40, 5));
  var opRules = [];
  opRules.push(cfRule_(op, '=$B2="💰 Доход"', C.greenSoft, C.green, [op.getRange(2, 1, 499, 5)]));
  opRules.push(cfRule_(op, '=AND($A2<>"",$A2=TODAY())', C.goldSoft, null, [op.getRange(2, 1, 499, 5)]));
  op.setConditionalFormatRules(opRules);

  /* ---------- 📋 Планы ---------- */
  pl.getRange('A1:F1').setValues([['Категория', 'План на месяц, ₽', 'Факт, ₽', 'Осталось, ₽', 'Заполнение плана', 'Отклонение']]);
  gridHeader_(pl.getRange('A1:F1'));
  pl.setColumnWidth(1, 140); pl.setColumnWidths(2, 4, 120); pl.setColumnWidth(5, 160);
  for (var p = 0; p < 12; p++) {
    var prow = 2 + p;
    pl.getRange(prow, 1).setFormula("=IF('⚙️ Настройки'!D" + (9 + p) + '="","",\'⚙️ Настройки\'!D' + (9 + p) + ')');
    pl.getRange(prow, 3).setFormula('=IF($A' + prow + '="","",SUMIFS(' + OP + '$D$2:$D$500,' + OP + '$C$2:$C$500,$A' + prow + ',' + OP + '$B$2:$B$500,"💸 Расход",' + OP + '$A$2:$A$500,">="&EOMONTH(TODAY(),-1)+1,' + OP + '$A$2:$A$500,"<="&EOMONTH(TODAY(),0)))');
    pl.getRange(prow, 4).setFormula('=IF(OR($A' + prow + '="",$B' + prow + '=""),"",$B' + prow + '-$C' + prow + ')');
    pl.getRange(prow, 5).setFormula('=IF(OR($A' + prow + '="",$B' + prow + '="",$B' + prow + '=0),"",SPARKLINE(MIN($C' + prow + ',$B' + prow + '),{"charttype","bar";"max",$B' + prow + ';"color1",IF($C' + prow + '>$B' + prow + ',"#e0556a","#12a565")}))');
    pl.getRange(prow, 6).setFormula('=IF(OR($A' + prow + '="",$B' + prow + '=""),"",$C' + prow + '-$B' + prow + ')');
  }
  pl.getRange('B2:D13').setNumberFormat('#,##0');
  pl.getRange('F2:F13').setNumberFormat('+#,##0;-#,##0;0').setFontColor(C.dim).setFontSize(9);
  boxBorder_(pl.getRange(1, 1, 13, 6));
  var plRules = [];
  plRules.push(cfRule_(pl, '=AND($B2<>"",$C2>$B2)', C.redSoft, C.red, [pl.getRange(2, 3, 12, 2)]));
  plRules.push(cfRule_(pl, '=AND($F2<>"",$F2>0)', null, C.red, [pl.getRange(2, 6, 12, 1)], { bold: true }));
  pl.setConditionalFormatRules(plRules);
  pl.getRange('A15').setValue('План вводится один раз, «Факт» собирается сам из журнала операций за текущий месяц.')
    .setFontSize(8).setFontColor(C.dim);

  /* ---------- 🧾 Долги ---------- */
  debt.getRange('A1:F1').setValues([['Кому / что', 'Всего, ₽', 'Выплачено, ₽', 'Осталось, ₽', 'Прогресс', 'Комментарий']]);
  gridHeader_(debt.getRange('A1:F1'));
  debt.setColumnWidth(1, 180); debt.setColumnWidths(2, 3, 110); debt.setColumnWidth(5, 150); debt.setColumnWidth(6, 200);
  for (var q = 2; q <= 9; q++) {
    debt.getRange(q, 4).setFormula('=IF($A' + q + '="","",$B' + q + '-$C' + q + ')');
    debt.getRange(q, 5).setFormula('=IF(OR($A' + q + '="",$B' + q + '="",$B' + q + '=0),"",SPARKLINE($C' + q + ',{"charttype","bar";"max",$B' + q + ';"color1","#12a565"}))');
  }
  debt.getRange('B2:D9').setNumberFormat('#,##0');
  debt.getRange('A10').setValue('ИТОГО').setFontWeight('bold');
  debt.getRange('B10').setFormula('=SUM($B$2:$B$9)').setFontWeight('bold').setNumberFormat('#,##0');
  debt.getRange('C10').setFormula('=SUM($C$2:$C$9)').setFontWeight('bold').setNumberFormat('#,##0');
  debt.getRange('D10').setFormula('=SUM($D$2:$D$9)').setFontWeight('bold').setNumberFormat('#,##0').setFontColor(C.red);
  boxBorder_(debt.getRange(1, 1, 10, 6));
  var dbRules = [cfRule_(debt, '=AND($A2<>"",$D2=0)', C.greenSoft, C.green, [debt.getRange(2, 1, 8, 6)])];
  debt.setConditionalFormatRules(dbRules);

  /* ---------- _calc ---------- */
  // помесячная сводка за 6 месяцев (строка 7 = текущий месяц)
  calc.getRange('A1:E1').setValues([['сдвиг', 'месяц', 'доход', 'расход', 'сбережения']]);
  for (var m = 0; m < 6; m++) {
    var mrow = 2 + m, off = m - 5;
    calc.getRange(mrow, 1).setValue(off);
    calc.getRange(mrow, 2).setFormula('=TEXT(EOMONTH(TODAY(),' + off + '),"MMM")');
    calc.getRange(mrow, 3).setFormula('=SUMIFS(' + OP + '$D$2:$D$500,' + OP + '$B$2:$B$500,"💰 Доход",' + OP + '$A$2:$A$500,">="&EOMONTH(TODAY(),' + (off - 1) + ')+1,' + OP + '$A$2:$A$500,"<="&EOMONTH(TODAY(),' + off + '))');
    calc.getRange(mrow, 4).setFormula('=SUMIFS(' + OP + '$D$2:$D$500,' + OP + '$B$2:$B$500,"💸 Расход",' + OP + '$A$2:$A$500,">="&EOMONTH(TODAY(),' + (off - 1) + ')+1,' + OP + '$A$2:$A$500,"<="&EOMONTH(TODAY(),' + off + '))');
    calc.getRange(mrow, 5).setFormula('=C' + mrow + '-D' + mrow);
  }
  var FIN = [
    ['доход месяц',      '=$C$7'],
    ['расход месяц',     '=$D$7'],
    ['сбережения месяц', '=$E$7'],
    ['% дохода',         '=IFERROR($E$7/$C$7,"")'],
    ['подушка, мес',     '=IFERROR(\'⚙️ Настройки\'!$B$5/AVERAGE(FILTER($D$2:$D$7,$D$2:$D$7>0)),"")'],
    ['прогноз расхода',  '=IF($D$7=0,"",ROUND($D$7/DAY(TODAY())*DAY(EOMONTH(TODAY(),0)),0))'],
    ['перерасход: категория', '=IFERROR(IF(MAX(FILTER(' + PL + '$F$2:$F$13,' + PL + '$F$2:$F$13<>""))>0,INDEX(' + PL + '$A$2:$A$13,MATCH(MAX(FILTER(' + PL + '$F$2:$F$13,' + PL + '$F$2:$F$13<>"")),' + PL + '$F$2:$F$13,0)),""),"")'],
    ['перерасход: сумма', '=IFERROR(MAX(0,MAX(FILTER(' + PL + '$F$2:$F$13,' + PL + '$F$2:$F$13<>""))),"")'],
    ['долгов осталось',  '=SUM(' + DB + '$D$2:$D$9)'],
    ['долгов активных',  '=COUNTIFS(' + DB + '$D$2:$D$9,">0")'],
    ['инсайт',           '=IF(COUNT(' + OP + '$D$2:$D$500)=0,"💡 Занеси первые операции на листе «💸 Операции» — капитал начнёт считаться сам.","💡 "&IF($B$12="","",("Сбережения — "&TEXT($B$12,"0%")&" дохода"&IF($B$12>=\'⚙️ Настройки\'!$B$3," — выше цели "&TEXT(\'⚙️ Настройки\'!$B$3,"0%")&" 👏. "," при цели "&TEXT(\'⚙️ Настройки\'!$B$3,"0%")&". ")))&IF($B$15="","Все категории в рамках плана. ","«"&$B$15&"» превысила план на "&TEXT($B$16,"#,##0")&" ₽ — проверь операции. ")&IF(AND($B$14<>"",$B$9>0,$B$14>$B$9),"⚠ Таким темпом расход к концу месяца ≈ "&TEXT($B$14,"#,##0")&" ₽ — больше дохода.",""))']
  ];
  for (var fi = 0; fi < FIN.length; fi++) {
    calc.getRange(9 + fi, 1).setValue(FIN[fi][0]);
    calc.getRange(9 + fi, 2).setFormula(FIN[fi][1]);
  }
  // топ-3 траты месяца
  calc.getRange('K1:M1').setValues([['дата', 'категория', 'сумма']]);
  calc.getRange('K2').setFormula('=IFERROR(SORTN(FILTER({' + OP + '$A$2:$A$500,' + OP + '$C$2:$C$500,' + OP + '$D$2:$D$500},' + OP + '$B$2:$B$500="💸 Расход",' + OP + '$D$2:$D$500<>"",' + OP + '$A$2:$A$500>=EOMONTH(TODAY(),-1)+1),3,0,3,FALSE),"")');
  calc.getRange('K2:K4').setNumberFormat('d MMM');

  /* ---------- 📊 Дашборд ---------- */
  dashCanvas_(dash, 14, 64);
  dash.setRowHeight(1, 10);
  dashTitle_(dash, 2, 2, 14, 'КАПИТАЛ', C.gold,
    '=IF(\'_calc\'!$B$11=0,"",TEXT(\'_calc\'!$B$11,"+#,##0;-#,##0;0")&" ₽ за месяц")', C.green);
  dash.setRowHeight(3, 8);

  kpiRowHeights_(dash, 4);
  kpiTile_(dash, 4, 2, 3,  { label: 'Доход · месяц', accent: C.green,
    f: '=TEXT(\'_calc\'!$B$9,"#,##0")',
    df: '=IF(\'_calc\'!$C$6=0,"прошлый месяц — нет данных",TEXT(\'_calc\'!$C$7/\'_calc\'!$C$6-1,"+0%;-0%;0%")&" к прошлому месяцу")' });
  kpiTile_(dash, 4, 5, 3,  { label: 'Расход · месяц', accent: C.red,
    f: '=TEXT(\'_calc\'!$B$10,"#,##0")',
    df: '=IF(\'_calc\'!$D$6=0,"прошлый месяц — нет данных",TEXT(\'_calc\'!$D$7/\'_calc\'!$D$6-1,"+0%;-0%;0%")&" к прошлому месяцу")' });
  kpiTile_(dash, 4, 8, 3,  { label: 'Сбережения', accent: C.gold, valueColor: C.gold,
    f: '=TEXT(\'_calc\'!$B$11,"#,##0")',
    df: '=IF(\'_calc\'!$B$12="","доход пока 0",TEXT(\'_calc\'!$B$12,"0%")&" дохода · цель "&TEXT(\'⚙️ Настройки\'!$B$3,"0%"))' });
  kpiTile_(dash, 4, 11, 3, { label: 'Подушка', accent: C.blue,
    f: '=IF(\'_calc\'!$B$13="","—",TEXT(\'_calc\'!$B$13,"0.0")&" мес")',
    df: '="цель — "&\'⚙️ Настройки\'!$B$4&" мес · отложено "&TEXT(\'⚙️ Настройки\'!$B$5,"#,##0")&" ₽"' });
  kpiTile_(dash, 4, 14, 2, { label: 'Прогноз расхода', accent: C.purple,
    f: '=IF(\'_calc\'!$B$14="","—","≈ "&TEXT(\'_calc\'!$B$14,"#,##0"))',
    dv: 'к концу месяца, по темпу' });

  dash.setRowHeight(7, 10);
  sectionLab_(dash, 8, 2, 6, 'Расходы месяца по категориям');
  sectionLab_(dash, 8, 9, 8, 'План vs факт · текущий месяц');
  for (var rr = 9; rr <= 17; rr++) dash.setRowHeight(rr, 20);
  addChart_(dash, Charts.ChartType.PIE,
    [pl.getRange('A2:A13'), pl.getRange('C2:C13')], 9, 2,
    { width: 380, height: 196, pieHole: 0.6, colors: CAT_COLORS, pieSliceText: 'none', legend: 'right' });
  gridHeader_(dash.getRange(9, 9, 1, 7));
  dash.getRange(9, 9, 1, 2).merge();
  dash.getRange(9, 9).setValue('Категория').setHorizontalAlignment('left');
  dash.getRange(9, 11).setValue('План');
  dash.getRange(9, 12).setValue('Факт');
  dash.getRange(9, 13, 1, 3).merge();
  dash.getRange(9, 13).setValue('Заполнение');
  for (var tp = 0; tp < 8; tp++) {
    var trow = 10 + tp, srcRow = 2 + tp;
    dash.getRange(trow, 9, 1, 2).merge();
    dash.getRange(trow, 9).setFormula('=IF(' + PL + '$A$' + srcRow + '="","",' + PL + '$A$' + srcRow + ')')
        .setFontSize(9).setHorizontalAlignment('left');
    dash.getRange(trow, 11).setFormula('=IF(' + PL + '$B$' + srcRow + '="","",' + PL + '$B$' + srcRow + ')')
        .setNumberFormat('#,##0').setFontSize(9).setHorizontalAlignment('right');
    dash.getRange(trow, 12).setFormula('=IF(' + PL + '$A$' + srcRow + '="","",' + PL + '$C$' + srcRow + ')')
        .setNumberFormat('#,##0').setFontSize(9).setHorizontalAlignment('right');
    dash.getRange(trow, 13, 1, 3).merge();
    dash.getRange(trow, 13).setFormula('=IF(OR(' + PL + '$A$' + srcRow + '="",' + PL + '$B$' + srcRow + '="",' + PL + '$B$' + srcRow + '=0),"",SPARKLINE(MIN(' + PL + '$C$' + srcRow + ',' + PL + '$B$' + srcRow + '),{"charttype","bar";"max",' + PL + '$B$' + srcRow + ';"color1",IF(' + PL + '$C$' + srcRow + '>' + PL + '$B$' + srcRow + ',"#e0556a","#12a565")}))');
  }
  boxBorder_(dash.getRange(9, 9, 9, 7));
  var finRules = [cfRule_(dash, '=AND($L10<>"",$K10<>"",$L10>$K10)', null, C.red, [dash.getRange(10, 12, 8, 1)], { bold: true })];
  dash.setConditionalFormatRules(finRules);

  dash.setRowHeight(18, 12);
  sectionLab_(dash, 19, 2, 6, 'Копилка · сбережения по месяцам');
  sectionLab_(dash, 19, 9, 7, 'Топ-3 траты месяца');
  for (var rr2 = 20; rr2 <= 27; rr2++) dash.setRowHeight(rr2, 21);
  addChart_(dash, Charts.ChartType.COLUMN,
    [calc.getRange('B2:B7'), calc.getRange('E2:E7')], 20, 2,
    { width: 380, height: 168, colors: [C.gold],
      vAxis: { textStyle: { fontSize: 8, color: '#8a97a8' }, gridlines: { color: '#eef2f8' } },
      hAxis: { textStyle: { fontSize: 8, color: '#8a97a8' } } });
  for (var tt = 0; tt < 3; tt++) {
    var ttrow = 20 + tt;
    dash.getRange(ttrow, 9).setFormula("=IF('_calc'!$K$" + (2 + tt) + '="","",\'_calc\'!$K$' + (2 + tt) + ')')
        .setNumberFormat('d MMM').setFontSize(9).setFontColor(C.dim);
    dash.getRange(ttrow, 10, 1, 3).merge();
    dash.getRange(ttrow, 10).setFormula("=IF('_calc'!$L$" + (2 + tt) + '="","",\'_calc\'!$L$' + (2 + tt) + ')')
        .setFontSize(9).setHorizontalAlignment('left');
    dash.getRange(ttrow, 13, 1, 3).merge();
    dash.getRange(ttrow, 13).setFormula("=IF('_calc'!$M$" + (2 + tt) + '="","",TEXT(\'_calc\'!$M$' + (2 + tt) + ',"#,##0")&" ₽")')
        .setFontSize(10).setFontWeight('bold').setHorizontalAlignment('right').setFontColor(C.red);
    dash.getRange(ttrow, 9, 1, 7).setBorder(null, null, true, null, null, null, C.grid, SpreadsheetApp.BorderStyle.SOLID);
  }
  dash.getRange(24, 9, 1, 4).merge().setValue('ДОЛГИ')
      .setFontSize(7).setFontColor(C.dim).setFontWeight('bold').setVerticalAlignment('bottom');
  dash.getRange(25, 9, 1, 7).merge().setFormula(
    '=IF(\'_calc\'!$B$17=0,"Долгов нет 🎉","Осталось "&TEXT(\'_calc\'!$B$17,"#,##0")&" ₽ · активных: "&\'_calc\'!$B$18&" (лист «🧾 Долги»)")')
      .setFontSize(10).setFontWeight('bold');

  dash.setRowHeight(28, 10);
  insightCell_(dash, 29, 2, 14, "='_calc'!$B$19");
  dash.getRange(32, 2, 1, 14).merge()
      .setValue('15 секунд на запись в «💸 Операции» — дата, тип, категория, сумма. Планы и подушка настраиваются один раз.')
      .setFontSize(8).setFontColor(C.dim);

  /* ---------- демо-данные ---------- */
  if (demo) {
    pl.getRange(2, 2, 12, 1).setValues([[40000], [25000], [18000], [15000], [6000], [5000], [4000], [4000], [1500], [5000], [8000], [5000]]);
    var ops = [];
    var dayNow = new Date().getDate();
    // прошлые 5 месяцев — по 4 сводных операции, чтобы жила копилка
    for (var pm = 5; pm >= 1; pm--) {
      var anchor = new Date(); anchor.setHours(12, 0, 0, 0);
      anchor.setDate(1); anchor.setMonth(anchor.getMonth() - pm); anchor.setDate(5);
      var inc = 104000 + pm * 2600, food = 36000 + pm * 900, home = 24000, fun = 26000 - pm * 1800;
      ops.push([new Date(anchor.getFullYear(), anchor.getMonth(), 3, 12), '💰 Доход', '💼 Зарплата', inc, '']);
      ops.push([new Date(anchor.getFullYear(), anchor.getMonth(), 8, 12), '💸 Расход', '🍔 Еда', food, '']);
      ops.push([new Date(anchor.getFullYear(), anchor.getMonth(), 10, 12), '💸 Расход', '🏠 Жильё', home, '']);
      ops.push([new Date(anchor.getFullYear(), anchor.getMonth(), 18, 12), '💸 Расход', '🎮 Досуг', fun, '']);
    }
    // текущий месяц — живой журнал
    var cur = [
      [1, '💰 Доход', '💼 Зарплата', 92400, 'аванс + основная'],
      [2, '💸 Расход', '🏠 Жильё', 24000, 'аренда'],
      [3, '💸 Расход', '🍔 Еда', 8200, 'закупка на неделю'],
      [4, '💸 Расход', '📱 Связь', 1100, ''],
      [5, '💰 Доход', '🚀 Подработка', 26000, 'монтаж ролика'],
      [6, '💸 Расход', '🚗 Транспорт', 12400, 'бензин + мойка'],
      [7, '💸 Расход', '🎮 Досуг', 5600, 'кино и ужин'],
      [8, '💸 Расход', '🍔 Еда', 7900, ''],
      [9, '💸 Расход', '🚗 Транспорт', 7000, 'такси, ремонт колеса'],
      [10, '💸 Расход', '💊 Здоровье', 3200, 'стоматолог']
    ];
    for (var ci = 0; ci < cur.length; ci++) {
      if (cur[ci][0] <= dayNow) {
        ops.push([dAgo_(dayNow - cur[ci][0]), cur[ci][1], cur[ci][2], cur[ci][3], cur[ci][4]]);
      }
    }
    op.getRange(2, 1, ops.length, 5).setValues(ops);
    debt.getRange(2, 1, 2, 3).setValues([
      ['💳 Кредитная карта', 45000, 26000],
      ['🤝 Долг другу', 15000, 15000]
    ]);
    debt.getRange('F2').setValue('закрыть до октября');
  }

  /* ---------- защита и порядок ---------- */
  protectWarn_(dash, 'Дашборд считается сам');
  protectWarn_(op, 'Журнал операций — твой лист ввода', [op.getRange(2, 1, 499, 5)]);
  protectWarn_(pl, 'Меняй только колонку «План»', [pl.getRange(2, 2, 12, 1)]);
  protectWarn_(debt, 'Вводи долги и выплаты', [debt.getRange(2, 1, 8, 3), debt.getRange(2, 6, 8, 1)]);
  protectWarn_(calc, 'Служебные формулы');
  calc.hideSheet();
  ss.setActiveSheet(dash);
  ss.setSpreadsheetLocale('ru_RU'); // формулы уже сохранены — теперь можно
  SpreadsheetApp.flush();
  return 'Финансы: ' + ss.getUrl();
}

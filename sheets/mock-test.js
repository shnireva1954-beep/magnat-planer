/* Мок-харнесс SpreadsheetApp: прогоняет magnat-builder.gs и ловит
 * ошибки диапазонов, формул и ссылок на несуществующие листы. */
'use strict';
const fs = require('fs');

let ERRORS = [];
function fail(msg) { ERRORS.push(msg); }

const KNOWN_FN = new Set(['IF','IFERROR','SUM','SUMIF','SUMIFS','SUMPRODUCT','COUNTIF','COUNTIFS',
  'COUNTA','COUNT','MAX','MIN','ROUND','AVERAGE','AVERAGEIFS','FILTER','SORT','SORTN','INDEX','MATCH',
  'LOOKUP','VLOOKUP','TEXT','TODAY','NOW','EOMONTH','DATE','DAY','MONTH','YEAR','WEEKDAY','CHOOSE',
  'N','OR','AND','NOT','ROW','COLUMN','SIGN','SLOPE','SPARKLINE','ARRAYFORMULA','TEXTJOIN','INT','ABS',
  'RIGHT','LEFT','MID','LEN','ISNUMBER','SEQUENCE','TRANSPOSE','MOD','OFFSET','INDIRECT']);

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function checkFormula(f, ss, where) {
  if (typeof f !== 'string' || f[0] !== '=') { fail(`${where}: формула не начинается с '=': ${f}`); return; }
  // баланс скобок вне строк
  let depth = 0, brace = 0, inStr = false;
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === '{') brace++; else if (ch === '}') brace--;
      if (depth < 0 || brace < 0) { fail(`${where}: лишняя закрывающая скобка: ${f}`); return; }
    }
  }
  if (inStr) fail(`${where}: незакрытая кавычка: ${f}`);
  if (depth !== 0) fail(`${where}: дисбаланс () [${depth}]: ${f}`);
  if (brace !== 0) fail(`${where}: дисбаланс {} [${brace}]: ${f}`);
  // ссылки на листы
  const refs = f.match(/'([^']+)'!/g) || [];
  for (const r of refs) {
    const name = r.slice(1, -2);
    if (ss && !ss._sheets.some(s => s._name === name)) fail(`${where}: ссылка на несуществующий лист «${name}»: ${f}`);
  }
  // имена функций (кириллицу и A1-ссылки не трогаем)
  const cleaned = f.replace(/"[^"]*"/g, '""').replace(/'[^']+'!/g, '');
  const fns = cleaned.match(/[A-Z][A-Z0-9_.]*\(/g) || [];
  for (const fn of fns) {
    const nm = fn.slice(0, -1);
    if (/^[A-Z]{1,3}[0-9]/.test(nm)) continue; // это не функция, а ссылка вида A1(
    if (!KNOWN_FN.has(nm)) fail(`${where}: неизвестная функция ${nm} в: ${f}`);
  }
}

class Range {
  constructor(sheet, r, c, nr, nc) {
    this._sh = sheet; this._r = r; this._c = c; this._nr = nr; this._nc = nc;
    if (r < 1 || c < 1) fail(`${this._where()}: диапазон < 1`);
    if (r + nr - 1 > sheet._rows || c + nc - 1 > sheet._cols)
      fail(`${this._where()}: выход за границы листа (${sheet._rows}×${sheet._cols})`);
  }
  _where() { return `${this._sh._ss._name} → ${this._sh._name}!R${this._r}C${this._c}:${this._nr}×${this._nc}`; }
  setValue(v) { return this; }
  setValues(vals) {
    if (!Array.isArray(vals) || vals.length !== this._nr) { fail(`${this._where()}: setValues строк ${vals.length} ≠ ${this._nr}`); return this; }
    for (const row of vals) if (row.length !== this._nc) { fail(`${this._where()}: setValues колонок ${row.length} ≠ ${this._nc}`); break; }
    return this;
  }
  setFormula(f) { checkFormula(f, this._sh._ss, this._where()); return this; }
  merge() { this._sh._addMerge(this._r, this._c, this._nr, this._nc); return this; }
  mergeAcross() {
    for (let i = 0; i < this._nr; i++) this._sh._addMerge(this._r + i, this._c, 1, this._nc);
    return this;
  }
  insertCheckboxes() { return this; }
  setDataValidation() { return this; }
  setNumberFormat() { return this; }
  setBackground() { return this; } setFontColor() { return this; } setFontSize() { return this; }
  setFontWeight() { return this; } setFontFamily() { return this; } setFontStyle() { return this; }
  setHorizontalAlignment() { return this; } setVerticalAlignment() { return this; }
  setWrap() { return this; } setBorder() { return this; }
}

class Protection {
  setDescription() { return this; }
  setWarningOnly() { return this; }
  setUnprotectedRanges(rs) { if (!Array.isArray(rs)) fail('setUnprotectedRanges: не массив'); return this; }
}

class ChartBuilder {
  constructor(sheet) { this._sh = sheet; this._ranges = 0; this._type = null; this._pos = false; }
  addRange(r) { if (!(r instanceof Range)) fail('chart.addRange: не Range'); this._ranges++; return this; }
  setChartType(t) { this._type = t; if (!t) fail('chart: пустой тип'); return this; }
  setPosition(r, c) { this._pos = true; if (r < 1 || c < 1) fail('chart.setPosition: <1'); return this; }
  setOption() { return this; }
  setNumHeaders() { return this; }
  build() {
    if (!this._type) fail(`${this._sh._name}: chart без типа`);
    if (!this._ranges) fail(`${this._sh._name}: chart без данных`);
    if (!this._pos) fail(`${this._sh._name}: chart без позиции`);
    return { _chart: true };
  }
}

class Sheet {
  constructor(ss, name, rows, cols) { this._ss = ss; this._name = name; this._rows = rows; this._cols = cols; this._charts = 0; this._merges = []; }
  _addMerge(r, c, nr, nc) {
    if (nr === 1 && nc === 1) return;
    for (const m of this._merges) {
      const sep = r + nr - 1 < m.r || m.r + m.nr - 1 < r || c + nc - 1 < m.c || m.c + m.nc - 1 < c;
      if (!sep) fail(`${this._ss._name} → ${this._name}: пересечение merge R${r}C${c}(${nr}×${nc}) с R${m.r}C${m.c}(${m.nr}×${m.nc})`);
    }
    this._merges.push({ r, c, nr, nc });
  }
  getName() { return this._name; }
  getMaxRows() { return this._rows; }
  getMaxColumns() { return this._cols; }
  insertColumnsAfter(after, n) { this._cols += n; return this; }
  insertRowsAfter(after, n) { this._rows += n; return this; }
  deleteColumns(start, n) {
    if (start + n - 1 > this._cols) fail(`${this._name}: deleteColumns за границей`);
    this._cols -= n; return this;
  }
  deleteRows(start, n) {
    if (start + n - 1 > this._rows) fail(`${this._name}: deleteRows за границей`);
    this._rows -= n; return this;
  }
  setTabColor() { return this; }
  setHiddenGridlines() { return this; }
  setFrozenRows(n) { return this; }
  setFrozenColumns(n) { return this; }
  setColumnWidth(c, w) { if (c > this._cols) fail(`${this._name}: setColumnWidth col ${c} > ${this._cols}`); return this; }
  setColumnWidths(c, n, w) { if (c + n - 1 > this._cols) fail(`${this._name}: setColumnWidths ${c}+${n} > ${this._cols}`); return this; }
  setRowHeight(r, h) { if (r > this._rows) fail(`${this._name}: setRowHeight row ${r} > ${this._rows}`); return this; }
  setRowHeights(r, n, h) { if (r + n - 1 > this._rows) fail(`${this._name}: setRowHeights за границей`); return this; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if (!m) { fail(`${this._name}: непонятный A1 «${a}»`); return new Range(this, 1, 1, 1, 1); }
      const r1 = +m[2], c1 = colToNum(m[1]);
      const r2 = m[3] ? +m[4] : r1, c2 = m[3] ? colToNum(m[3]) : c1;
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
  setConditionalFormatRules(rules) { for (const r of rules) if (!r || !r._built) fail(`${this._name}: правило УФ не build()`); return this; }
  newChart() { return new ChartBuilder(this); }
  insertChart(ch) { if (!ch || !ch._chart) fail(`${this._name}: insertChart без build()`); this._charts++; return this; }
  protect() { return new Protection(); }
  hideSheet() { return this; }
}

class Spreadsheet {
  constructor(name) { this._name = name; this._sheets = [new Sheet(this, 'Лист1', 1000, 26)]; }
  setSpreadsheetLocale() { return this; }
  getId() { return 'id-' + this._name; }
  getUrl() { return 'https://sheets.mock/' + encodeURIComponent(this._name); }
  getSheets() { return this._sheets.slice(); }
  insertSheet(name) {
    if (this._sheets.some(s => s._name === name)) fail(`${this._name}: дубликат листа «${name}»`);
    const sh = new Sheet(this, name, 1000, 26);
    this._sheets.push(sh); return sh;
  }
  deleteSheet(sh) {
    const i = this._sheets.indexOf(sh);
    if (i < 0) throw new Error('нет такого листа');
    if (this._sheets.length === 1) throw new Error('нельзя удалить последний лист');
    this._sheets.splice(i, 1);
  }
  setActiveSheet(sh) { return this; }
}

class CFBuilder {
  whenFormulaSatisfied(f) { this._f = f; return this; }
  setBackground() { return this; } setFontColor() { return this; }
  setStrikethrough() { return this; } setBold() { return this; }
  setGradientMinpointWithValue() { return this; }
  setGradientMaxpointWithValue() { return this; }
  setGradientMidpointWithValue() { return this; }
  setRanges(rs) {
    this._ranges = rs;
    for (const r of rs) if (!(r instanceof Range)) fail('УФ: setRanges не Range');
    return this;
  }
  build() {
    if (this._f && this._ranges && this._ranges.length) {
      // формулы УФ не могут ссылаться на другие листы
      const ss = this._ranges[0]._sh._ss;
      checkFormula(this._f, ss, `УФ на ${this._ranges[0]._where()}`);
      if (/'[^']+'!/.test(this._f)) fail(`УФ не может ссылаться на другой лист: ${this._f}`);
    }
    return { _built: true };
  }
}

class DVBuilder {
  requireValueInList() { return this; }
  requireValueInRange(r) { if (!(r instanceof Range)) fail('validation: requireValueInRange не Range'); return this; }
  requireNumberBetween() { return this; }
  setAllowInvalid() { return this; }
  setHelpText() { return this; }
  build() { return { _dv: true }; }
}

global.SpreadsheetApp = {
  create: (name) => new Spreadsheet(name),
  flush: () => {},
  newConditionalFormatRule: () => new CFBuilder(),
  newDataValidation: () => new DVBuilder(),
  BorderStyle: { SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM', SOLID_THICK: 'SOLID_THICK', DASHED: 'DASHED' },
  InterpolationType: { NUMBER: 'NUMBER', PERCENT: 'PERCENT' }
};
global.Charts = { ChartType: { AREA: 'AREA', PIE: 'PIE', COLUMN: 'COLUMN', LINE: 'LINE', RADAR: 'RADAR', BAR: 'BAR' } };
global.DriveApp = {
  createFolder: (n) => ({ getUrl: () => 'https://drive.mock/' + n, addFile: () => {} }),
  getFileById: () => ({ moveTo: () => {} })
};
global.Logger = { log: (m) => console.log('  [log]', m) };

// загрузка и прогон
const code = fs.readFileSync(process.argv[2] || '/home/user/magnat-planer/sheets/magnat-builder.gs', 'utf8');
(0, eval)(code);

for (const mode of [['buildAll (демо)', () => buildAll()], ['buildAllClean (чистые)', () => buildAllClean()]]) {
  console.log('▶', mode[0]);
  try { mode[1](); } catch (e) { fail(`ИСКЛЮЧЕНИЕ в ${mode[0]}: ${e.stack}`); }
}

if (ERRORS.length) {
  console.log('\n✗ ОШИБКИ (' + ERRORS.length + '):');
  const uniq = [...new Set(ERRORS)];
  uniq.slice(0, 60).forEach(e => console.log(' -', e));
  process.exit(1);
} else {
  console.log('\n✓ Мок-прогон чистый: диапазоны, формулы, листы, диаграммы — ок');
}

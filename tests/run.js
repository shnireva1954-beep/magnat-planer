#!/usr/bin/env node
// Прогон всех проверок «Магната». Запуск: node tests/run.js
// Ничего, кроме playwright-core, не нужно: npm i playwright-core
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path");
const { chromePath, APP_FILE } = require("./lib");

const SUITES = [
  ["01-scenarios.js", "Сценарии: онбординг, все экраны, реальные действия, битые данные", true],
  ["02-edge.js",      "Края: пустые списки, одна привычка, два года истории, максимум",   false],
  ["03-stress.js",    "Нагрузка: альбомная, зум, быстрые касания, тридцать привычек",     false],
  ["04-final.js",     "Целостность: обновление версии, копия данных, часовые пояса",      true],
  ["05-landing.js",   "Продающая страница: правила игры = приложение, цена, ширины, анимации", true],
  ["06-server.js",    "Свой сервер: выкладка, Caddy, заголовки, приложение под CSP",     true],
  ["07-docs.js",      "Тарифы, соглашение, политика, поддержка: правда и одна цена",    true],
];

// 0. Синтаксис скриптов внутри страниц — самая дешёвая и самая важная проверка
function checkSyntax() {
  for (const file of [APP_FILE, path.join(__dirname, "..", "index.html")]) {
    const name = path.basename(file), html = fs.readFileSync(file, "utf8");
    const parts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!parts.length) { console.log("✗ В " + name + " не найден <script>"); return false; }
    for (const code of parts) {
      const tmp = path.join(require("os").tmpdir(), "magnat-check.js");
      fs.writeFileSync(tmp, code);
      const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
      fs.unlinkSync(tmp);
      if (r.status !== 0) { console.log("✗ Синтаксическая ошибка в скрипте " + name + ":\n" + r.stderr); return false; }
    }
    console.log("✓ Синтаксис скриптов в " + name + " — в порядке");
  }
  const sw = spawnSync(process.execPath, ["--check", path.join(__dirname, "..", "sw.js")], { encoding: "utf8" });
  if (sw.status !== 0) { console.log("✗ Синтаксическая ошибка в sw.js:\n" + sw.stderr); return false; }
  console.log("✓ Синтаксис sw.js — в порядке");
  try { JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")); }
  catch (e) { console.log("✗ manifest.json не читается: " + e.message); return false; }
  console.log("✓ manifest.json — корректный JSON");
  return true;
}

console.log("Проверка приложения «Магнат»");
console.log("Chromium: " + chromePath());
console.log("Файл: " + APP_FILE + "\n");

let failed = [];
if (!checkSyntax()) failed.push("синтаксис");

for (const [file, title, gate] of SUITES) {
  console.log("\n" + "─".repeat(64) + "\n" + title + "  (" + file + ")");
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: "utf8", timeout: 600000 });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  // упавший набор — провал всегда, не только у «ворот»: 29.09.2026 02-edge и 03-stress
  // падали с SyntaxError, «✗» в выводе не было, и прогон отчитался «ВСЁ ЧИСТО»
  const hasFail = out.includes("✗") || r.status !== 0;
  if (hasFail) failed.push(file);
}

console.log("\n" + "═".repeat(64));
if (failed.length) { console.log("ЕСТЬ ПРОБЛЕМЫ: " + failed.join(", ")); process.exit(1); }
console.log("ВСЁ ЧИСТО — приложение можно публиковать");

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
];

// 0. Синтаксис скрипта внутри страницы — самая дешёвая и самая важная проверка
function checkSyntax() {
  const html = fs.readFileSync(APP_FILE, "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) { console.log("✗ В index.html не найден <script>"); return false; }
  const tmp = path.join(require("os").tmpdir(), "magnat-check.js");
  fs.writeFileSync(tmp, m[1]);
  const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.unlinkSync(tmp);
  if (r.status !== 0) { console.log("✗ Синтаксическая ошибка в скрипте:\n" + r.stderr); return false; }
  console.log("✓ Синтаксис скрипта в index.html — в порядке");
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
  const hasFail = out.includes("✗") || (gate && r.status !== 0);
  if (hasFail) failed.push(file);
}

console.log("\n" + "═".repeat(64));
if (failed.length) { console.log("ЕСТЬ ПРОБЛЕМЫ: " + failed.join(", ")); process.exit(1); }
console.log("ВСЁ ЧИСТО — приложение можно публиковать");

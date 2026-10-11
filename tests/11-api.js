// Сервер входа по коду (server/api/api.py): самопроверка без сети и HTTP-проверки на настоящем порту.
// До 12.10.2026 их никто не запускал — тесты с сокетами (медленные клиенты, отказ почты, параллельные
// отправки, флаги cookie) лежали рядом с api.py и уезжали на сервер. Теперь они в tests/api_test.py
// и стоят воротами в run.js: красный сервер не выкладывается.
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };   // байткод не должен появиться в репозитории
let fails = 0;

function run(title, args, timeout) {
  const t0 = Date.now();
  const r = spawnSync("python3", args, { cwd: ROOT, env, encoding: "utf8", timeout });
  const out = (r.stdout || "") + (r.stderr || "");
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) { console.log(`  ✓ ${title} (${sec} с)`); return out; }
  fails++;
  console.log(`  ✗ FAIL: ${title} — код ${r.status}${r.error ? ", " + r.error.message : ""}`);
  console.log(out.split("\n").filter(l => /FAIL|Error|error|Traceback|assert/.test(l)).slice(0, 30).join("\n"));
  return out;
}

console.log("\n1) Самопроверка api.py (без сети)");
const self = run("python3 -I server/api/api.py selftest", ["-I", "server/api/api.py", "selftest"], 180000);
const m = self.match(/selftest ok \((\d+) провер/);
if (m) console.log(`  · проверок: ${m[1]}`);

console.log("\n2) HTTP: служба на настоящем порту, поддельная почта");
const http = run("python3 -I tests/api_test.py", ["-I", "tests/api_test.py"], 300000);
const n = http.match(/Ran (\d+) tests?/);
if (n) console.log(`  · тестов: ${n[1]}`);

console.log("\n3) На сервер едет только api.py");
const fs = require("fs");
const extra = fs.readdirSync(path.join(ROOT, "server", "api")).filter(f => f !== "api.py");
extra.length ? (fails++, console.log("  ✗ FAIL: лишнее в server/api: " + extra.join(", ")))
             : console.log("  ✓ в server/api только api.py");

console.log(fails ? `\n=== ПРОВАЛОВ: ${fails} ===` : "\n=== ВСЁ ЗЕЛЁНОЕ ===");
process.exit(fails ? 1 : 0);

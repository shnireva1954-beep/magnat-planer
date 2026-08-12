const { chromium } = require("playwright-core");
const path = require("path"), fs = require("fs");

// Chromium ищем там, где его кладёт окружение; можно задать свой путь через CHROME=
function chromePath(){
  if (process.env.CHROME) return process.env.CHROME;
  const roots = ["/opt/pw-browsers", path.join(process.env.HOME || "", ".cache/ms-playwright")];
  for (const r of roots) {
    let dirs = []; try { dirs = fs.readdirSync(r); } catch (e) { continue; }
    for (const d of dirs.filter(x => x.startsWith("chromium") && !x.includes("headless")).sort().reverse()) {
      const p = path.join(r, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("Chromium не найден. Укажи путь: CHROME=/путь/к/chrome node tests/run.js");
}

const APP_DIR = path.join(__dirname, "..");
const APP_FILE = path.join(APP_DIR, "index.html");
const APP_URL = "file://" + APP_FILE;
const OUT_DIR = path.join(__dirname, "__snapshots");
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (e) {}
const launch = () => chromium.launch({ executablePath: chromePath() });

module.exports = { chromium, launch, chromePath, APP_DIR, APP_FILE, APP_URL, OUT_DIR };

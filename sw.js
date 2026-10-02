/* Магнат — офлайн-оболочка приложения.
   Стратегия «сначала сеть, кэш как запаска»: свежая версия приезжает сама,
   а без интернета приложение всё равно открывается. */
const CACHE = "magnat-app-v3";
// шрифт — в оболочке с 02.10.2026: без него первый запуск без сети рисовался бы системным
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon.png", "./icon-512.png",
  "./fonts/manrope-cyrillic.woff2", "./fonts/manrope-latin.woff2", "./fonts/manrope-latin-ext.woff2"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => {})            // нет сети при установке — не валим воркер
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
        .then(hit => hit || Response.error()))
  );
});

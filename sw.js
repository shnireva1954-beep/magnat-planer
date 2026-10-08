/* Магнат — офлайн-оболочка приложения.
   Стратегия «сначала сеть, кэш как запаска»: свежая версия приезжает сама,
   а без интернета приложение всё равно открывается.
   С 08.10.2026 на «/» — продающая страница, приложение — app.html. Старые значки
   ведут на «/», а она сразу отправляет в приложение, поэтому в запасе обе. */
const CACHE = "magnat-app-v3";
const ASSETS = ["./", "./index.html", "./app.html", "./manifest.json", "./icon.png", "./icon-512.png", "./fonts/manrope.woff2"];

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
        // без сети незнакомый адрес — в приложение: открывший значок хочет Магнат, а не страницу продажи
        .then(hit => hit || (req.mode === "navigate" ? caches.match("./app.html") : undefined))
        .then(hit => hit || Response.error()))
  );
});

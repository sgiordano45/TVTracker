/* Queue service worker — app shell cached, TMDB data always network,
   TMDB poster images cached opportunistically. Bump VERSION on deploys. */

const VERSION = "queue-v11";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./firebase-config.js",
  "./icons/icon-180.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // TMDB API: network only (data must be fresh; app has its own cache layer)
  if (url.hostname === "api.themoviedb.org") return;

  // TMDB images: cache-first, populate as you go
  if (url.hostname === "image.tmdb.org") {
    e.respondWith(
      caches.open(VERSION + "-img").then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // Google Fonts + app shell: cache-first with network fallback
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request).then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname.includes("fonts.") || url.hostname === "www.gstatic.com")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});

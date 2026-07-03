const CACHE_NAME = "recall-v20260703-2";
const APP_SHELL = [
  "./",
  "./styles.css?v=20260703-2",
  "./app.js?v=20260703-2",
  "./manifest.webmanifest",
  "./fevicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => key === CACHE_NAME ? null : caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdnAsset = url.hostname === "cdn.jsdelivr.net";

  // Never intercept the service worker itself
  if (url.pathname.endsWith("/sw.js")) return;

  if (!isSameOrigin && !isCdnAsset) return;

  if (isCdnAsset) {
    // CDN assets (KaTeX, Prism): stale-while-revalidate — they're pinned versioned
    // URLs that never change, so serving from cache is always correct
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchPromise = fetch(request)
            .then((response) => {
              if (response.status === 200) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // All same-origin assets (HTML, app.js, styles.css, etc.): network-first.
  // Always fetch the latest from the server; only fall back to cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

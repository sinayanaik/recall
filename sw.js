const CACHE_NAME = "recall-v20260803-02";

// How long a same-origin request may stall before the cached copy is served
// instead. The failure this exists for is NOT being offline — that fails fast
// and always fell back correctly. It's a network that is up but answers
// nothing: a dead cell, a captive portal, hotel wifi. There, `fetch` neither
// resolves nor rejects for tens of seconds, and a network-first handler with no
// timeout hangs the whole app on a launch it could have served from cache in
// 200ms. Measured against a server that accepts and never answers, with all 91
// assets already precached: the app never painted at all (still waiting past
// 140s); with this, it is fully loaded in 2.7s. The network response still
// lands — it just updates the cache in the background instead of holding the
// page hostage.
const NETWORK_TIMEOUT_MS = 2500;

// Uploaded images live in the user's own Supabase Storage bucket, on a
// different origin from both the app and the CDN — so nothing here used to
// intercept them and EVERY image in EVERY deck was a broken icon offline.
// They get their own cache, deliberately NOT versioned with CACHE_NAME: an app
// update must not throw away a library's worth of images that would then have
// to be re-downloaded (and are unavailable offline until they are). The
// activate sweep below spares it by name for the same reason.
const IMAGE_CACHE_NAME = "recall-images-v1";

// Objects are written at immutable, randomly-named paths (see
// uploadImageToSupabase), so a cache hit is always correct and there is no
// revalidation to do. Keep a ceiling anyway — an image-heavy EPUB import is
// hundreds of uploads and this would otherwise grow without limit. Cache
// entries are appended in fetch order, so the oldest keys are the coldest.
const IMAGE_CACHE_LIMIT = 400;

function isSupabaseImageUrl(url) {
  return url.hostname.endsWith(".supabase.co")
    && url.pathname.includes("/storage/v1/object/public/");
}

async function trimImageCache() {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_LIMIT).map((key) => cache.delete(key)));
}

// Same-origin app shell — cached atomically on install (must all succeed).
//
// The ?v= strings MUST match index.html's <link>/<script> exactly: the cache is
// keyed by full URL, so a stale one here precaches a file the page never asks
// for and leaves the real one to be picked up (or not) by the network-first
// handler below. styles.css drifted to -7 while index.html moved to -9 and the
// precached copy was dead weight for the whole of that release.
const APP_SHELL = [
  "./",
  "./styles.css?v=20260803-02",
  "./app.js?v=20260803-02",
  "./manifest.webmanifest",
  "./fevicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

// Third-party runtime dependencies. These are loaded from cdn.jsdelivr.net and
// are what make the difference between "works offline because I happened to
// exercise every feature while online" and "actually works offline". We
// precache them during install so the very first offline session has math,
// diagrams, syntax highlighting, exports, etc. — not just the bare shell.
const CDN = "https://cdn.jsdelivr.net/npm/";

// KaTeX ships its glyphs as separate woff2 files that the browser only fetches
// when a formula using them actually renders. Precache the full set so *any*
// formula renders offline, not just ones seen while online.
const KATEX_FONTS = [
  "KaTeX_AMS-Regular", "KaTeX_Caligraphic-Bold", "KaTeX_Caligraphic-Regular",
  "KaTeX_Fraktur-Bold", "KaTeX_Fraktur-Regular", "KaTeX_Main-Bold",
  "KaTeX_Main-BoldItalic", "KaTeX_Main-Italic", "KaTeX_Main-Regular",
  "KaTeX_Math-BoldItalic", "KaTeX_Math-Italic", "KaTeX_SansSerif-Bold",
  "KaTeX_SansSerif-Italic", "KaTeX_SansSerif-Regular", "KaTeX_Script-Regular",
  "KaTeX_Size1-Regular", "KaTeX_Size2-Regular", "KaTeX_Size3-Regular",
  "KaTeX_Size4-Regular", "KaTeX_Typewriter-Regular"
].map((f) => `${CDN}katex@0.16.11/dist/fonts/${f}.woff2`);

// The Prism autoloader injects a grammar <script> from the CDN the first time a
// code block of a given language is highlighted. Offline, an un-fetched grammar
// silently fails, so precache the common languages (plus the base grammars they
// depend on). Anything outside this set still works online and degrades to a
// plain, unhighlighted code block offline.
const PRISM_LANGS = [
  "clike", "markup", "markup-templating", "css", "css-extras",
  "javascript", "typescript", "jsx", "tsx", "json", "yaml",
  "bash", "c", "cpp", "csharp", "java", "go", "rust", "ruby", "php", "sql",
  "python", "markdown", "latex", "kotlin", "swift", "coffeescript", "fsharp",
  "r", "matlab", "perl", "lua", "dart", "scala", "haskell", "docker", "git",
  "ini", "toml", "graphql", "regex", "diff", "powershell", "makefile",
  "nginx", "http"
].map((l) => `${CDN}prismjs@1.30.0/components/prism-${l}.min.js`);

const CDN_ASSETS = [
  // Stylesheets + scripts referenced directly by index.html.
  `${CDN}katex@0.16.11/dist/katex.min.css`,
  `${CDN}prismjs@1.30.0/themes/prism-tomorrow.min.css`,
  `${CDN}dompurify@3.1.6/dist/purify.min.js`,
  `${CDN}marked@14.1.2/marked.min.js`,
  `${CDN}prismjs@1.30.0/components/prism-core.min.js`,
  `${CDN}prismjs@1.30.0/components/prism-python.min.js`,
  `${CDN}prismjs@1.30.0/plugins/autoloader/prism-autoloader.min.js`,
  `${CDN}katex@0.16.11/dist/katex.min.js`,
  `${CDN}katex@0.16.11/dist/contrib/auto-render.min.js`,
  `${CDN}mermaid@10.9.1/dist/mermaid.min.js`,
  `${CDN}jszip@3.10.1/dist/jszip.min.js`,
  `${CDN}@supabase/supabase-js@2`,
  `${CDN}@panzoom/panzoom@4.5.0/dist/panzoom.min.js`,
  `${CDN}graphre/dist/graphre.js`,
  `${CDN}nomnoml/dist/nomnoml.js`,
  `${CDN}turndown@7.1.2/dist/turndown.js`,
  `${CDN}turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js`,
  ...KATEX_FONTS,
  ...PRISM_LANGS
];

// Fetch a cross-origin asset and store it under its request URL. jsdelivr sends
// permissive CORS, so we get a real (inspectable) response. Some URLs (unpinned
// packages like @supabase/supabase-js@2) redirect to a resolved version;
// Cache.put() refuses redirected responses, so rebuild a clean Response from the
// body before storing. The page later requests the same URL (as a no-cors
// <script>/<link>) and Cache.match resolves it by URL regardless of mode.
async function cacheCdnAsset(cache, url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.blob();
  const clean = new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  });
  await cache.put(url, clean);
}

// Re-fetch only the CDN assets that aren't in the cache. The install's precache
// is deliberately best-effort (Promise.allSettled), which means an install that
// ran on a bad connection leaves permanent holes — and a hole in this list is a
// library that is simply absent offline: no markdown rendering, no formulas, no
// export. Nothing ever went back for them, because the cache is only rebuilt
// when CACHE_NAME changes. This is that repair pass. Returns how many landed.
async function repairCdnCache() {
  const cache = await caches.open(CACHE_NAME);
  const missing = [];
  for (const url of CDN_ASSETS) {
    if (!(await cache.match(url))) missing.push(url);
  }
  if (!missing.length) return 0;
  const results = await Promise.allSettled(missing.map((url) => cacheCdnAsset(cache, url)));
  return results.filter((r) => r.status === "fulfilled").length;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        // App shell is same-origin and must all cache — fail install if not.
        // "./" is handled separately: it is the one entry with no ?v= stamp, so
        // addAll would take it from the browser's HTTP cache and precache the
        // PREVIOUS release's HTML into this release's cache. Same reason as the
        // no-store fetch in sameOriginNetworkFirst.
        await cache.addAll(APP_SHELL.filter((asset) => asset !== "./"));
        const shell = await fetch("./", { cache: "no-store", credentials: "same-origin" });
        if (!shell.ok) throw new Error(`app shell fetch failed: ${shell.status}`);
        await cache.put("./", shell);
        // CDN assets are best-effort: one flaky/unavailable file must not abort
        // the whole install and leave the app with no cache at all. What that
        // drops, repairCdnCache picks up later.
        await Promise.allSettled(CDN_ASSETS.map((url) => cacheCdnAsset(cache, url)));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // IMAGE_CACHE_NAME is spared: it holds the user's own uploaded images,
      // which are expensive to re-fetch and simply unavailable offline once
      // dropped. Deleting every non-CACHE_NAME key would wipe it on every
      // single app update.
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== IMAGE_CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => trimImageCache())
      .then(() => self.clients.claim())
  );
});

// The page asks for a deck's images to be pre-cached right after pulling it, so
// a deck synced on wifi is readable offline later — not just the images that
// happened to be on screen while online. Best-effort and chunked: a broken or
// deleted URL must not abort the rest.
self.addEventListener("message", (event) => {
  // The page asks for this when it comes back online (see registerServiceWorker),
  // because that's the moment a hole left by a bad install can actually be
  // filled. Cheap when there's nothing to do: a cache.match per asset, no
  // network at all.
  if (event.data && event.data.type === "repair-offline-cache") {
    event.waitUntil(repairCdnCache().then((count) => {
      if (count) console.info(`[sw] refetched ${count} offline asset(s) that were missing`);
    }).catch(() => {}));
    return;
  }

  const urls = event.data && event.data.type === "cache-images" ? event.data.urls : null;
  if (!Array.isArray(urls) || !urls.length) return;
  event.waitUntil(
    caches.open(IMAGE_CACHE_NAME).then(async (cache) => {
      for (const url of urls.slice(0, IMAGE_CACHE_LIMIT)) {
        try {
          if (await cache.match(url)) continue;
          const response = await fetch(url, { mode: "cors" });
          if (response.ok) await cache.put(url, response);
        } catch (_) { /* offline or gone — nothing to warm */ }
      }
      await trimImageCache();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdnAsset = url.hostname === "cdn.jsdelivr.net";
  const isImage = !isSameOrigin && isSupabaseImageUrl(url);

  // Never intercept the service worker itself
  if (url.pathname.endsWith("/sw.js")) return;

  if (!isSameOrigin && !isCdnAsset && !isImage) return;

  if (isImage) {
    // Cache-first, in the image cache. The path is immutable, so a hit needs no
    // revalidation — and cache-first is what makes the image render at all with
    // no connection. A miss falls through to the network and stores a copy.
    // Never let a failed fetch reject: an <img> that 404s should show as a
    // broken image, not take the request down with an uncaught error.
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request)
            .then((response) => {
              if (response.ok) cache.put(request, response.clone()).then(trimImageCache).catch(() => {});
              return response;
            })
            .catch(() => cached || Response.error());
        })
      )
    );
    return;
  }

  if (isCdnAsset) {
    // CDN assets (scripts, KaTeX CSS/fonts, Prism grammars): cache-first. They
    // live at versioned URLs whose contents never change, so a cache hit is
    // always correct — and cache-first is what guarantees they resolve offline.
    // On a miss we fetch, cache a clean (non-redirected) copy, and serve it.
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request)
            .then(async (response) => {
              if (response.ok || response.type === "opaque") {
                try {
                  const body = await response.clone().blob();
                  await cache.put(request, new Response(body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                  }));
                } catch (_) { /* opaque/redirected — serve without caching */ }
              }
              return response;
            })
            // `cached` is necessarily undefined here (this is the miss path),
            // and respondWith resolving to undefined is a hard TypeError rather
            // than a failed request — hand back a real network error so the
            // <script>/<link> simply fails to load.
            .catch(() => Response.error());
        })
      )
    );
    return;
  }

  // Same-origin assets that carry a release stamp (app.js?v=…, styles.css?v=…)
  // or are precached and only ever change with a release (icons, manifest,
  // favicon): cache-first. Their URL changes when their content does — that is
  // the entire point of the ?v= convention — so a hit can never be stale, and
  // going to the network first only means the app's two largest files sit
  // behind whatever the connection is doing. This is what makes a launch on a
  // bad connection as fast as a launch offline instead of NETWORK_TIMEOUT_MS
  // slower. Only the HTML, which has no version in its URL, still needs to ask.
  if (isVersionedAsset(url)) {
    event.respondWith(cacheFirstSameOrigin(event, request));
    return;
  }

  // Everything else same-origin (the navigation/HTML above all): network-first,
  // but only for as long as the network is actually answering. See
  // NETWORK_TIMEOUT_MS — past that, the cached copy wins and the request keeps
  // running in the background purely to refresh the cache for next time.
  event.respondWith(sameOriginNetworkFirst(event, request));
});

// Content-addressed by URL, so a cache hit is always the right answer.
function isVersionedAsset(url) {
  if (url.searchParams.has("v")) return true;
  return /\/(icons\/[^/]+\.png|fevicon\.png|manifest\.webmanifest)$/.test(url.pathname);
}

async function cacheFirstSameOrigin(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  // Miss: a release whose ?v= this cache predates, or an install that never
  // finished. Fetch and keep it — but on a bounded wait, because hanging here
  // would reintroduce the exact stall this file exists to prevent, just one
  // release later.
  const network = fetch(request).then(async (response) => {
    if (response && response.status === 200) {
      const copy = response.clone();
      try { await cache.put(request, copy); } catch (_) { /* quota */ }
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => null), timeout]);
  if (winner && winner.ok) return winner;

  // Last resort: the same path from a previous release (ignoreSearch drops the
  // ?v=). An app one version behind is a working app; a hung fetch is not.
  return (await cache.match(request, { ignoreSearch: true })) || (winner || Response.error());
}

async function sameOriginNetworkFirst(event, request) {
  const cache = await caches.open(CACHE_NAME);

  // What we'd serve if the network doesn't come through — resolved UP FRONT,
  // because the decision to wait indefinitely can only be made once we know
  // there is genuinely nothing to fall back to. The second half matters more
  // than it looks: a navigation to /index.html is not cached under that URL
  // (only "./" is precached, and a first load has nothing else), so treating
  // "no exact match" as "no fallback" left the one request the whole app waits
  // on with no timeout at all — measured hanging past 140s on a stalled
  // network, which is exactly the failure this file is meant to prevent.
  const cached = (await cache.match(request))
    || (request.mode === "navigate" ? await cache.match("./") : undefined);

  // Kept as a bare promise (never awaited on the fast path) so a stalled
  // response can still populate the cache after we've already replied. The
  // cache write is awaited INSIDE it, and the whole thing is handed to
  // waitUntil right here — waitUntil throws InvalidStateError once the
  // respondWith promise has settled, so a background continuation cannot
  // register its own, and the refresh would be dropped the moment the timeout
  // path won (i.e. exactly when it matters).
  //
  // `cache: "no-store"` is what makes this network-FIRST rather than
  // network-shaped. The only same-origin request that reaches here is the HTML,
  // whose URL carries no ?v= stamp — so with the default cache mode this fetch
  // is answered by the browser's own HTTP cache, and the SW then "refreshes"
  // its cache with a stale copy of index.html. Every release after the first
  // one was invisible: the new sw.js installed and activated correctly, but the
  // page it served still pointed at the PREVIOUS build's app.js?v=…, which
  // cache-first then happily served from the new cache. Reloading never helped,
  // because every reload repeated the same loop. Requests are GET-only and
  // same-origin here (see the fetch handler), so rebuilding from the URL loses
  // nothing.
  const network = fetch(request.url, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
    if (response && response.status === 200) {
      const copy = response.clone();
      try { await cache.put(request, copy); } catch (_) { /* quota, or evicted */ }
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  if (!cached) {
    // Genuinely nothing to fall back to (a first visit, or an asset this build
    // never precached) — the network is the only answer there is, so wait for
    // it however long it takes rather than failing the load outright.
    try {
      return await network;
    } catch (_) {
      return Response.error();
    }
  }

  // Give the network a head start, then stop waiting. A rejected fetch (genuinely
  // offline) resolves the race immediately with null, so being offline still
  // costs nothing.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => null), timeout]);
  // A 5xx/404 from a half-working server is worse than the copy we already have.
  return winner && winner.ok ? winner : cached;
}

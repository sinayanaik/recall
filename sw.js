// The placeholder below is replaced with the deploying commit's short SHA by
// .github/workflows/deploy.yml at publish time. It is never typed.
//
// It used to be a hand-edited YYYYMMDD-NN string in four files that all had to
// agree, and twice they did not: commit d7a92e2 shipped 177 lines of
// app.js/index.html/styles.css changes with the stamp left at 20260807-02 and
// this file untouched, so CACHE_NAME never changed, no new worker installed,
// and every existing install kept being served the previous bundle cache-first.
// A CI check policed that, but a check that fires after you already typed the
// wrong thing is a worse answer than not typing it: the commit SHA changes on
// every commit by construction, so a release can no longer forget to bump.
const CACHE_NAME = "recall-__BUILD__";

// The release stamp, derived from CACHE_NAME rather than repeated, so APP_SHELL
// below cannot disagree with it.
const STAMP = CACHE_NAME.slice("recall-".length);

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

// A versioned asset (app.js?v=…, styles.css?v=…) that misses the cache gets a
// much longer budget than the HTML does, because the two failures are not
// comparable. Falling back on the HTML costs one launch of freshness; falling
// back on app.js means there is no correct copy to serve at all — the only
// other option is the PREVIOUS release's bundle under the new URL, which runs
// old code inside new markup. 2.5s was routinely exceeded by a 1.4MB app.js on
// mobile data while being unreachable on the developer's wifi, which is exactly
// why this only ever broke for other people.
const ASSET_NETWORK_TIMEOUT_MS = 15000;

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
// hundreds of uploads and this would otherwise grow without limit.
//
// The trim below drops the oldest INSERTED keys, not the least recently used,
// which makes a ceiling below the size of the library actively harmful: warming
// deck B evicts deck A's images, opening A re-warms and evicts B, and no deck is
// ever warm. The old 400 was well inside that range. Images are stored
// downscaled to 1600px WebP (see optimizeImage) at roughly 200-400KB each, so
// this ceiling is a few hundred MB — comfortably inside what a browser grants a
// persisted origin.
const IMAGE_CACHE_LIMIT = 1500;

// trimImageCache materialises every key in the cache, so calling it after each
// individual put is O(n) work per image on the one thread every image request
// is routed through. Batch it.
const IMAGE_TRIM_INTERVAL = 50;
let imagePutsSinceTrim = 0;

// How many warm fetches run at once. Serial warming held the connection pool
// while the user was looking at a note whose images needed those same
// connections; unbounded parallelism would be just as bad the other way.
const IMAGE_WARM_CONCURRENCY = 5;

function isSupabaseImageUrl(url) {
  return url.hostname.endsWith(".supabase.co")
    && url.pathname.includes("/storage/v1/object/public/");
}

async function trimImageCache() {
  imagePutsSinceTrim = 0;
  const cache = await caches.open(IMAGE_CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - IMAGE_CACHE_LIMIT).map((key) => cache.delete(key)));
}

function maybeTrimImageCache() {
  imagePutsSinceTrim += 1;
  if (imagePutsSinceTrim < IMAGE_TRIM_INTERVAL) return Promise.resolve();
  return trimImageCache();
}

// Fetch an image in a form that can actually be stored.
//
// The rendered <img> carries no crossorigin attribute, so its request is
// no-cors and fetching IT yields an opaque response: status 0, ok === false,
// and cache.put throws on it. That is why this cache was, in practice, only
// ever written by the upload and warm paths — every image viewed on a device
// that had not uploaded it went to the network on every single load, forever.
// Re-requesting the same URL in CORS mode gets a real, inspectable, cacheable
// response (Supabase Storage sends Access-Control-Allow-Origin: *), and a CORS
// response renders in an <img> just fine.
function fetchImageForCache(url) {
  return fetch(new Request(url, { mode: "cors", credentials: "omit" }));
}

// Same-origin app shell, precached on install.
//
// The ?v= strings must match index.html's <link>/<script> exactly — the cache
// is keyed by full URL, so a stale one here precaches a file the page never
// asks for and leaves the real one to the handlers below. They are built from
// STAMP rather than typed out, and index.html's two are substituted from the
// same commit SHA by the same deploy step, so they cannot disagree.
//
// Deliberately NOT cached with addAll. addAll is atomic: one 5xx on one icon
// rejects the whole install, the new worker never activates, and that client
// keeps being served the old release forever with the error swallowed by the
// .catch() on registration.update(). Individual puts mean a flaky asset costs
// that one asset, which the miss handler and repairCdnCache can both recover.
const APP_SHELL = [
  "./",
  `./styles.css?v=${STAMP}`,
  // The module entry point. Everything it imports is stamped with the same
  // ?v=, so those URLs change with every release too — which is what lets the
  // cache-first handler below serve them without revalidating and still never
  // mix a new entry point with an old dependency. As the split proceeds, each
  // new module must be added here: a module missing from this list still works
  // (the miss handler fetches and caches it) but is absent on a first offline
  // launch, which is precisely the case this precache exists for. CI compares
  // this list against the files on disk.
  `./src/main.js?v=${STAMP}`,
  `./src/backup/backup.js?v=${STAMP}`,
  `./src/backup/restore.js?v=${STAMP}`,
  `./src/cloud/auth.js?v=${STAMP}`,
  `./src/cloud/deck-list.js?v=${STAMP}`,
  `./src/cloud/net.js?v=${STAMP}`,
  `./src/cloud/style-sync.js?v=${STAMP}`,
  `./src/cloud/supabase-client.js?v=${STAMP}`,
  `./src/cloud/web-decks.js?v=${STAMP}`,
  `./src/core/build.js?v=${STAMP}`,
  `./src/core/constants.js?v=${STAMP}`,
  `./src/core/dom.js?v=${STAMP}`,
  `./src/core/lib-loader.js?v=${STAMP}`,
  `./src/core/text.js?v=${STAMP}`,
  `./src/export/decks.js?v=${STAMP}`,
  `./src/export/sql.js?v=${STAMP}`,
  `./src/import/parse-cards.js?v=${STAMP}`,
  `./src/library/categories.js?v=${STAMP}`,
  `./src/library/deck-rows.js?v=${STAMP}`,
  `./src/library/folder-tree.js?v=${STAMP}`,
  `./src/library/folders.js?v=${STAMP}`,
  `./src/library/my-decks-actions.js?v=${STAMP}`,
  `./src/library/my-decks-icons.js?v=${STAMP}`,
  `./src/library/my-decks-prefs.js?v=${STAMP}`,
  `./src/library/my-decks-render.js?v=${STAMP}`,
  `./src/library/my-decks-selection.js?v=${STAMP}`,
  `./src/render/code-language.js?v=${STAMP}`,
  `./src/sync/cards.js?v=${STAMP}`,
  `./src/sync/diff.js?v=${STAMP}`,
  `./src/sync/notes-conflict.js?v=${STAMP}`,
  `./src/sync/push.js?v=${STAMP}`,
  `./src/sync/report.js?v=${STAMP}`,
  `./src/ui/back-gesture.js?v=${STAMP}`,
  `./src/ui/boot-screens.js?v=${STAMP}`,
  `./src/ui/deck-header.js?v=${STAMP}`,
  `./src/ui/feedback.js?v=${STAMP}`,
  `./src/ui/nav-history.js?v=${STAMP}`,
  `./src/ui/overlays.js?v=${STAMP}`,
  `./src/ui/pickers.js?v=${STAMP}`,
  `./src/ui/style-schema.js?v=${STAMP}`,
  `./src/ui/style-settings.js?v=${STAMP}`,
  `./src/ui/style-tokens.js?v=${STAMP}`,
  `./src/ui/theme-catalog.js?v=${STAMP}`,
  `./src/ui/theme.js?v=${STAMP}`,
  "./manifest.webmanifest",
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

// NOTE: this list is deliberately WIDER than index.html's <script> tags. Most
// of these are now injected on demand by app.js (LIB_URLS / loadScriptOnce)
// rather than loaded up front, and precaching them here is exactly what keeps
// "on demand" working with no connection — an offline first-render of a diagram
// gets mermaid from this cache. Every URL must therefore stay byte-identical to
// its counterpart in app.js.
const CDN_ASSETS = [
  // Stylesheets + scripts index.html loads up front.
  `${CDN}katex@0.16.11/dist/katex.min.css`,
  `${CDN}prismjs@1.30.0/themes/prism-tomorrow.min.css`,
  `${CDN}dompurify@3.1.6/dist/purify.min.js`,
  `${CDN}marked@14.1.2/marked.min.js`,
  `${CDN}prismjs@1.30.0/components/prism-core.min.js`,
  `${CDN}prismjs@1.30.0/components/prism-python.min.js`,
  `${CDN}prismjs@1.30.0/plugins/autoloader/prism-autoloader.min.js`,
  `${CDN}katex@0.16.11/dist/katex.min.js`,
  `${CDN}katex@0.16.11/dist/contrib/auto-render.min.js`,
  // Injected on demand by app.js rather than loaded up front (LIB_URLS), which
  // is precisely why they must be precached here — see the note above.
  `${CDN}mermaid@10.9.1/dist/mermaid.min.js`,
  `${CDN}jszip@3.10.1/dist/jszip.min.js`,
  // Must stay byte-identical to the <script src> in index.html — the cache is
  // keyed by URL, so a mismatch here precaches a file the page never asks for
  // and leaves the auth client to the network on every load. See the comment at
  // that tag for why it is pinned at all.
  `${CDN}@supabase/supabase-js@2.112.2`,
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // "./" is fetched separately from the rest: it is the one entry with no ?v=
    // stamp, so a default-cache fetch would take it from the browser's HTTP
    // cache and precache the PREVIOUS release's HTML into this release's cache.
    // Same reason as the no-store fetch in sameOriginNetworkFirst.
    const stamped = APP_SHELL.filter((asset) => asset !== "./");
    await Promise.allSettled(stamped.map(async (asset) => {
      const response = await fetch(asset, { cache: "no-cache", credentials: "same-origin" });
      if (!response.ok) throw new Error(`${asset} -> ${response.status}`);
      await cache.put(asset, response);
    }));

    // The HTML is the one asset worth failing the install over. Everything else
    // has a recovery path; this doesn't — a cache whose "./" is the previous
    // release's markup would have the new worker serving old HTML, which is the
    // precise mixed-build state the fetch handler below exists to prevent.
    const shell = await fetch("./", { cache: "no-store", credentials: "same-origin" });
    if (!shell.ok) throw new Error(`app shell fetch failed: ${shell.status}`);
    await cache.put("./", shell);

    // Take over NOW. The 83-asset CDN precache below is best-effort by design
    // (allSettled) and already has a repair pass, so it has no business gating
    // activation — yet it used to, and on a phone that meant a release could sit
    // unactivated behind 3.2MB of mermaid and 20 KaTeX fonts until the browser
    // killed the install, silently, permanently. Availability of the shell is
    // what a release needs; the libraries can land afterwards or later.
    await self.skipWaiting();

    await Promise.allSettled(CDN_ASSETS.map((url) => cacheCdnAsset(cache, url)));
  })());
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
  // Sent by the update banner's Reload button. A worker that finished installing
  // while the page still had a controller sits in "waiting" — and a plain reload
  // does NOT promote it, because the old worker is still controlling the client.
  // Without this the button would appear to do nothing on the first press, which
  // is precisely the "I clicked reload and it's still the old version" report.
  if (event.data && event.data.type === "skip-waiting") {
    self.skipWaiting();
    return;
  }

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
      // Deduped: the same image can appear in several decks, and this message
      // arrives once per pulled deck.
      const pending = [...new Set(urls)].slice(0, IMAGE_CACHE_LIMIT);
      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          const url = pending[next++];
          try {
            if (await cache.match(url, { ignoreVary: true })) continue;
            const response = await fetchImageForCache(url);
            if (response.ok) await cache.put(url, response);
          } catch (_) { /* offline or gone — nothing to warm */ }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(IMAGE_WARM_CONCURRENCY, pending.length) }, worker)
      );
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
    // no connection. A miss fetches a CORS copy (see fetchImageForCache: the
    // <img>'s own no-cors request is opaque and unstorable), serves it, and
    // keeps it.
    //
    // Keyed by URL STRING, and matched with ignoreVary. Supabase Storage
    // answers CORS requests with `Vary: Origin`, so an entry stored from a
    // request that carried an Origin header would not match the rendered
    // <img>'s request, which carries none — every warmed image would miss and
    // the whole warm-on-pull feature would quietly be a no-op.
    //
    // Never let a failed fetch reject: an <img> that 404s should show as a
    // broken image, not take the request down with an uncaught error.
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then((cache) =>
        cache.match(request.url, { ignoreVary: true }).then((cached) => {
          if (cached) return cached;
          return fetchImageForCache(request.url)
            .then((response) => {
              if (response.ok) cache.put(request.url, response.clone()).then(maybeTrimImageCache).catch(() => {});
              return response;
            })
            // A CORS fetch can fail where the plain one would not (a
            // misconfigured bucket, a proxy stripping the header). Showing the
            // image still beats caching it, so fall back to the request as the
            // page made it and simply store nothing.
            .catch(() => fetch(request).catch(() => Response.error()));
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

// Does this HTML belong to the release this worker was built for? Compares the
// ?v= stamp its <script src="src/main.js?v=…"> carries against our own STAMP.
//
// Only navigations are judged. A same-origin non-navigation that reaches the
// network-first handler is not the app shell and has no stamp to check, and a
// document with no recognisable stamp at all (a fork, an error page, a captive
// portal) is passed through rather than blocked — this guards against a known
// mismatch, not against the unknown.
//
// Also kicks off a worker update on a mismatch: the newer markup existing on
// the server is the strongest possible evidence that a newer sw.js does too,
// and holding this client on the old release is only correct if it is also
// briefly held. Without it, a client whose 30-minute timer has just fired would
// wait another 30 for a release it has already seen.
async function htmlMatchesThisRelease(response, request) {
  if (request.mode !== "navigate") return true;
  let text;
  try {
    text = await response.clone().text();
  } catch (_) {
    return true; // unreadable (opaque, streaming failure) — don't block on it
  }
  const stamp = text.match(/src\/main\.js\?v=([^"'&\s]+)/)?.[1];
  if (!stamp) return true;
  if (stamp === STAMP) return true;
  try { self.registration.update(); } catch (_) { /* best effort */ }
  return false;
}

// Content-addressed by URL, so a cache hit is always the right answer.
function isVersionedAsset(url) {
  if (url.searchParams.has("v")) return true;
  return /\/(icons\/[^/]+\.png|manifest\.webmanifest)$/.test(url.pathname);
}

// Tell every open page that it is running a body whose version does not match
// the URL it asked for. Without this the page cannot possibly know: the App Info
// screen reads the ?v= off its own <script src> ATTRIBUTE, which is the request
// URL, so a cross-version fallback made it report the new stamp while executing
// the old bundle — announcing "You're up to date ✓" to a user who was not.
async function announceMixedBuild(url) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    for (const client of clients) client.postMessage({ type: "mixed-build", url: String(url), stamp: STAMP });
  } catch (_) { /* nothing listening */ }
}

async function cacheFirstSameOrigin(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  // Miss. With version-coherent HTML (see sameOriginNetworkFirst) the page only
  // ever asks for assets stamped like the markup it was served, and this
  // worker's own install precached exactly those — so a miss here means the
  // install was incomplete, not that a new release is being picked up
  // piecemeal. Either way the network is the only source of a CORRECT copy, so
  // it gets a long budget (see ASSET_NETWORK_TIMEOUT_MS) rather than the HTML's.
  const network = fetch(request).then(async (response) => {
    if (response && response.status === 200) {
      const copy = response.clone();
      try { await cache.put(request, copy); } catch (_) { /* quota */ }
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ASSET_NETWORK_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => null), timeout]);
  if (winner && winner.ok) return winner;

  // Genuinely nothing correct to serve. Falling back to the same path from a
  // previous release (ignoreSearch drops the ?v=) keeps the app usable rather
  // than handing back a hard error — but it is a MIXED BUILD, and the one thing
  // that must not happen is the page believing otherwise, so say so out loud.
  const stale = await cache.match(request, { ignoreSearch: true });
  if (stale) {
    event.waitUntil(announceMixedBuild(request.url));
    return stale;
  }
  return winner || Response.error();
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
      // Version-coherent serving. An OLD worker must never hand out NEW HTML.
      // If it does, the page asks for app.js?v=NEW, which this cache cannot
      // have, and the miss handler above is left choosing between a long stall
      // and last release's bundle — the mixed-build failure that made "stuck on
      // an old version" both real and invisible (the page reports the new stamp
      // either way). Refusing the newer markup keeps this client wholly on the
      // release it already has; registration.update() fetches sw.js (never
      // intercepted, see the fetch handler), the new worker installs,
      // skipWaiting/claim run, and the version changes as one atomic step.
      const coherent = await htmlMatchesThisRelease(response, request);
      if (!coherent) return null;
      const copy = response.clone();
      try { await cache.put(request, copy); } catch (_) { /* quota, or evicted */ }
    }
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  if (!cached) {
    // Genuinely nothing to fall back to (a first visit, or an asset this build
    // never precached) — the network is the only answer there is, so wait for
    // it however long it takes rather than failing the load outright. A `null`
    // here is the coherence refusal above with no cached copy to refuse in
    // favour of, which can only happen if this worker's own install never
    // stored "./"; serving the newer markup is then strictly better than
    // serving nothing.
    try {
      return (await network) || (await fetch(request.url, { cache: "no-store", credentials: "same-origin" }));
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

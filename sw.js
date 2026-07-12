const CACHE_NAME = "recall-v20260712-1";

// Same-origin app shell — cached atomically on install (must all succeed).
const APP_SHELL = [
  "./",
  "./styles.css?v=20260712-1",
  "./app.js?v=20260712-1",
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        // App shell is same-origin and must all cache — fail install if not.
        await cache.addAll(APP_SHELL);
        // CDN assets are best-effort: one flaky/unavailable file must not abort
        // the whole install and leave the app with no cache at all.
        await Promise.allSettled(CDN_ASSETS.map((url) => cacheCdnAsset(cache, url)));
      })
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
            .catch(() => cached);
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
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // Offline navigation to a URL variant that was never cached verbatim
          // (e.g. /index.html when only "./" is precached) still gets the shell.
          if (request.mode === "navigate") return caches.match("./");
          return undefined;
        })
      )
  );
});

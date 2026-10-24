// Does importing a web page bring in the article, and only the article?
//
//   node tools/web-page-import-check.mjs
//
// A saved page (.html, or the .mhtml Chrome on a phone writes with ⋮ → Download
// page) is read by src/import/web-page.js: ads, menus, banners and the rest of
// the page's furniture are taken out, lazy-loaded pictures are resolved to their
// real addresses, and what is left becomes Markdown on the Import review step.
// Its pictures are then copied into Recall's own storage when the import is
// confirmed (src/import/web-images.js), and pictures from other sites are asked
// for without a Referer, which is what hotlink protection refuses.
//
// Everything here goes through the real modules in the real app: the fixtures
// are handed to loadFiles as File objects, exactly as the file picker would, and
// what is asserted is what the review step would show. The network is never
// touched — the CDN is cut off, the vendored libraries are injected, and the
// picture copy runs against a stand-in fetch and upload.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();
if (!CHROME) {
  // Not a skip: a check that cannot run has not passed.
  console.error("web-page-import-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

// Runs INSIDE the page. Returns [{ name, ok, detail }].
const PROBE = String.raw`async () => {
  const V = "?v=__BUILD__";
  const [files, staging, webPage, webImages, preprocess, dom] = await Promise.all([
    import("/src/import/files.js" + V),
    import("/src/import/staging.js" + V),
    import("/src/import/web-page.js" + V),
    import("/src/import/web-images.js" + V),
    import("/src/render/preprocess.js" + V),
    import("/src/core/dom.js" + V)
  ]);
  const el = dom.el;
  const results = [];
  const record = (name, detail) => results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });
  const check = async (name, fn) => {
    try { record(name, await fn()); } catch (error) { record(name, "THREW: " + (error && error.stack || error)); }
  };
  const show = (text) => JSON.stringify(String(text).slice(0, 300));

  // ── The fixture: an article inside everything a news or food site wraps
  // around one. Every piece of furniture carries a word the article never uses,
  // so "is it gone" is a plain text search.
  const ARTICLE = [
    '<article class="post">',
    '<header class="entry-header"><h1>Garlic Green Beans</h1><p class="byline">By Asha</p></header>',
    '<p>Crisp beans with plenty of garlic, ready in fifteen minutes.</p>',
    '<div class="adthrive-ad mv-ad-box"><span>Advertisement</span><img src="https://ads.example/creative.jpg"></div>',
    '<h2>Ingredients</h2>',
    '<ul><li>500 g green beans</li><li>4 cloves garlic</li></ul>',
    '<figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-lazy-src="/wp-content/uploads/beans-lazy.jpg" alt="Beans in a pan"><figcaption>Beans in a pan</figcaption></figure>',
    '<p><img src="/img/srcset-small.jpg" srcset="/img/srcset-small.jpg 400w, /img/srcset-large.jpg 1200w" alt="srcset picture"></p>',
    '<p><img class="lazyload" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" alt="noscript picture"><noscript><img src="https://cdn.example/real-noscript.jpg" alt="noscript picture"></noscript></p>',
    '<table><thead><tr><th>Step</th><th>Minutes</th></tr></thead><tbody><tr><td>Blanch</td><td>3</td></tr></tbody></table>',
    '<pre><code>oil = 2 # tablespoons</code></pre>',
    '<div class="sharedaddy sd-sharing"><a href="https://facebook.com/share">Share on Facebook ZZSHARE</a></div>',
    '<p>Serve warm. Read <a href="/more/tips">more tips</a> or <a href="#comments">jump down</a>.</p>',
    '<div class="sponsored-box"><p>ZZSPONSOR Buy this pan</p></div>',
    '<div id="taboola-below-article"><p>ZZTABOOLA You will not believe</p></div>',
    '<section class="newsletter-signup"><p>ZZNEWS Subscribe to our newsletter</p></section>',
    '<div class="related-posts"><a href="/x">ZZRELATED Five more bean recipes</a></div>',
    '<div id="comments" class="comments-area"><p>ZZCOMMENT Lovely!</p></div>',
    '</article>'
  ].join("");
  const PAGE = (body, head = "") => '<!DOCTYPE html><html><head><title>Garlic Green Beans | Food Trails</title>' + head + '</head><body>' + body + '</body></html>';
  const NEWS = PAGE([
    '<a class="skip-link" href="#main">ZZSKIP Skip to content</a>',
    '<header class="site-header"><nav><a href="/">ZZNAV Home</a><a href="/recipes">ZZNAV Recipes</a></nav></header>',
    '<div id="cookie-consent" role="dialog"><p>ZZCOOKIE We use cookies</p><button>OK</button></div>',
    '<ins class="adsbygoogle" data-ad-client="ca-pub-1" data-ad-slot="2">ZZADSENSE</ins>',
    '<div id="div-gpt-ad-1234"><p>ZZGPT</p></div>',
    '<main id="main">', ARTICLE, '<aside class="sidebar"><p>ZZSIDEBAR About me</p></aside>', '</main>',
    '<footer class="site-footer"><p>ZZFOOTER © 2026</p></footer>',
    '<img src="https://pixel.example/t.gif" width="1" height="1">',
    '<script>document.write("ZZSCRIPT")</script>'
  ].join(""), '<meta property="og:url" content="https://foodtrails.example/garlic-green-beans/">');
  const JUNK = ["ZZSKIP", "ZZNAV", "ZZCOOKIE", "ZZADSENSE", "ZZGPT", "ZZSIDEBAR", "ZZFOOTER", "ZZSCRIPT", "ZZSHARE", "ZZSPONSOR", "ZZTABOOLA", "ZZNEWS", "ZZRELATED", "ZZCOMMENT", "Advertisement", "ads.example", "pixel.example"];
  const KEPT = ["# Garlic Green Beans", "By Asha", "Crisp beans with plenty of garlic", "## Ingredients", "500 g green beans", "4 cloves garlic", "| Step | Minutes |", "| Blanch | 3 |", "oil = 2 # tablespoons", "Serve warm."];

  const stageFile = async (file) => {
    staging.clearImportStaging();
    await files.loadFiles([file], null);
    return staging.importStaging;
  };
  const htmlFile = (html, name = "garlic-green-beans.html", type = "text/html") => new File([html], name, { type });

  // ── 1. A saved .html: the article, and nothing around it ──────────────────
  let staged = null;
  await check("saved .html: staged as a web page", async () => {
    staged = await stageFile(htmlFile(NEWS));
    if (!staged) return "nothing was staged";
    const source = staged.sources[0];
    if (!source.webPage) return "the source carries no web-page reading";
    return true;
  });
  const md = () => staged.sources[0].markdown;

  await check("the article's words, headings, list, table and code are all there", () => {
    const missing = KEPT.filter((text) => !md().includes(text));
    return missing.length ? "missing " + missing.join(" · ") + "\n" + show(md()) : true;
  });
  await check("no ad, menu, banner, sidebar, footer, script or tracker survives", () => {
    const left = JUNK.filter((text) => md().includes(text));
    return left.length ? "still there: " + left.join(" · ") : true;
  });
  await check("the removal is counted for the review step", () => {
    const removed = staged.sources[0].webPage.removed;
    if (removed.ads < 4) return "only " + removed.ads + " ads counted";
    if (removed.clutter < 6) return "only " + removed.clutter + " pieces of clutter counted";
    const chips = staging.importDetectionChips().map((chip) => chip.text).join(" | ");
    return /removed \d+ ads and \d+ menus/.test(chips) ? true : "chips: " + chips;
  });
  await check("pictures: lazy, srcset and noscript resolve to the real address", () => {
    const want = [
      "https://foodtrails.example/wp-content/uploads/beans-lazy.jpg",
      "https://foodtrails.example/img/srcset-large.jpg",
      "https://cdn.example/real-noscript.jpg"
    ];
    const missing = want.filter((url) => !md().includes("](" + url));
    if (missing.length) return "missing " + missing.join(", ") + "\n" + show(md());
    return /data:image/.test(md()) ? "a placeholder data: URI was kept" : true;
  });
  await check("links: made absolute against the page, a jump within it unwrapped", () => {
    if (!md().includes("[more tips](https://foodtrails.example/more/tips)")) return show(md());
    return md().includes("#comments") ? "the in-page link survived" : true;
  });
  await check("the review step offers Keep everything", () => {
    staging.renderImportReview();
    const button = el.importDetect.querySelector("[data-import-webpage-toggle]");
    return button && /Keep everything/.test(button.textContent) ? true : "no switch: " + el.importDetect.innerHTML.slice(0, 300);
  });
  // Whichever "Import as" choice is not the default, so keeping it means something.
  let chosen = "notes";
  await check("Keep everything brings the page back, keeping the Import-as choice", () => {
    chosen = staging.importStaging.modes.find((mode) => mode !== staging.importStaging.content) || staging.importStaging.content;
    staging.importStaging.content = chosen;
    el.importDetect.querySelector("[data-import-webpage-toggle]").click();
    const now = staging.importStaging;
    if (!now.sources[0].webPage.keepAll) return "the switch did not take";
    if (!now.sources[0].markdown.includes("ZZNEWS")) return "the whole page is not what is staged";
    if (now.sources[0].markdown.includes("ZZSCRIPT")) return "even the whole page must not carry the script";
    if (now.content !== chosen) return "Import as went from " + chosen + " to " + now.content;
    return /Remove ads and menus again/.test(el.importDetect.textContent) ? true : "the switch label did not change";
  });
  await check("...and Remove ads and menus again takes them out again", () => {
    el.importDetect.querySelector("[data-import-webpage-toggle]").click();
    const now = staging.importStaging;
    if (now.sources[0].webPage.keepAll || now.sources[0].markdown.includes("ZZNEWS")) return "still the whole page";
    return now.content === chosen ? true : "Import as went from " + chosen + " to " + now.content;
  });

  // ── 2. The guards: what looks like furniture but is not ───────────────────
  await check("an ad-free wrapper around the whole page is not taken for an ad", async () => {
    const s = await stageFile(htmlFile(PAGE('<div class="site-wrap ad-free">' + ARTICLE + '</div>')));
    const text = s.sources[0].markdown;
    return text.includes("Crisp beans") && text.includes("500 g green beans") ? true : show(text);
  });
  await check("a page with no <article> falls back to its densest text", async () => {
    const prose = "<p>" + "Plain prose about beans and garlic. ".repeat(20) + "</p>";
    const s = await stageFile(htmlFile(PAGE('<nav>ZZNAV</nav><div class="content">' + prose + '<p>Last line here.</p></div><footer>ZZFOOTER</footer>')));
    const text = s.sources[0].markdown;
    if (!text.includes("Last line here.") || !text.includes("Plain prose")) return show(text);
    return text.includes("ZZNAV") || text.includes("ZZFOOTER") ? "furniture kept: " + show(text) : true;
  });
  await check("the article's own <header> with its title stays", () => {
    return md().includes("# Garlic Green Beans") && md().includes("By Asha") ? true : show(md());
  });

  // ── 3. The same page as Chrome on a phone saves it (.mhtml) ───────────────
  await check(".mhtml: read through its MIME, same article, same cleaning", async () => {
    const qp = NEWS.replace(/=/g, "=3D").replace(/(.{70})/g, "$1=\r\n");
    const mhtml = [
      "From: <Saved by Blink>",
      "Snapshot-Content-Location: https://foodtrails.example/garlic-green-beans/",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="----MultipartBoundary--x----"',
      "",
      "------MultipartBoundary--x----",
      "Content-Type: text/html",
      "Content-Transfer-Encoding: quoted-printable",
      "Content-Location: https://foodtrails.example/garlic-green-beans/",
      "",
      qp,
      "------MultipartBoundary--x------",
      ""
    ].join("\r\n");
    const s = await stageFile(new File([mhtml], "Garlic Green Beans.mhtml", { type: "" }));
    if (!s) return "nothing staged";
    const text = s.sources[0].markdown;
    const missing = KEPT.filter((t) => !text.includes(t));
    if (missing.length) return "missing " + missing.join(" · ");
    const left = JUNK.filter((t) => text.includes(t));
    if (left.length) return "still there: " + left.join(" · ");
    return text.includes("](https://foodtrails.example/wp-content/uploads/beans-lazy.jpg") ? true : "pictures not resolved against Content-Location";
  });

  // ── 4. A desktop "Save page as": the address in the comment, the folder lost
  await check("saved .html: the 'saved from' address, and the _files pictures counted", async () => {
    const saved = '<!DOCTYPE html>\n<!-- saved from url=(0047)https://foodtrails.example/garlic-green-beans/ -->\n' +
      PAGE('<article><h1>Saved</h1><p>' + "Text of the saved article. ".repeat(15) + '</p><img src="./Garlic Green Beans_files/beans.jpg" alt="local"><img src="/remote.jpg" alt="remote"><p><a href="/about">about</a></p></article>');
    const s = await stageFile(htmlFile(saved, "Garlic Green Beans.html"));
    const text = s.sources[0].markdown;
    if (text.includes("_files")) return "a picture in the saved folder was kept: " + show(text);
    if (!text.includes("](https://foodtrails.example/remote.jpg")) return "the remote picture was not resolved: " + show(text);
    if (!text.includes("[about](https://foodtrails.example/about)")) return "the link was not resolved";
    const chips = staging.importDetectionChips().map((chip) => chip.text).join(" | ");
    return /1 picture stayed in the saved page's folder/.test(chips) ? true : "chips: " + chips;
  });

  // ── 5. Pictures from other sites are asked for without a Referer ──────────
  await check("an outside picture renders with referrerpolicy=no-referrer", () => {
    const html = preprocess.markdownToSafeHtml("![a](https://foodtrails.example/beans.jpg)");
    return /referrerpolicy="no-referrer"/.test(html) ? true : show(html);
  });
  await check("...and Recall's own stored pictures are left as they were", () => {
    const html = preprocess.markdownToSafeHtml("![a](https://proj.supabase.co/storage/v1/object/public/images/u/x.jpg)");
    return /referrerpolicy/.test(html) ? show(html) : true;
  });

  // ── 6. Confirming copies the pictures into Recall ─────────────────────────
  await check("pictures copied: direct, through the proxy, or left on the web", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const fetched = [];
    const uploaded = [];
    webImages.setWebImageTransport({
      online: () => true,
      fetch: async (url) => {
        fetched.push(url);
        const direct = url.startsWith("https://cdn.example/");
        const proxied = url.startsWith(webImages.IMAGE_PROXY_BASE) && !url.includes("srcset-large");
        if (!direct && !proxied) throw new TypeError("Failed to fetch");
        return new Response(new Blob([png], { type: "image/png" }), { status: 200, headers: { "content-type": "image/png" } });
      },
      upload: async (file, options) => {
        uploaded.push(options.folder);
        return "https://proj.supabase.co/storage/v1/object/public/images/u/" + options.folder + "/" + uploaded.length + ".png";
      }
    });
    try {
      await stageFile(htmlFile(NEWS));
      const note = await staging.copyStagedWebImages();
      const text = JSON.stringify(staging.importStaging.decks);
      if (!fetched.some((url) => url === "https://cdn.example/real-noscript.jpg")) return "the direct route was not tried";
      if (!fetched.some((url) => url.startsWith(webImages.IMAGE_PROXY_BASE) && url.includes(encodeURIComponent("https://foodtrails.example/wp-content/uploads/beans-lazy.jpg")))) return "the proxy route was not tried";
      if (text.includes("cdn.example/real-noscript.jpg") || text.includes("uploads/beans-lazy.jpg")) return "a copied picture still points at the web";
      if (!text.includes("https://foodtrails.example/img/srcset-large.jpg")) return "the picture neither route could get lost its web address";
      if (!uploaded.every((folder) => /^web\/garlic-green-beans--/.test(folder))) return "folders: " + uploaded.join(", ");
      return /1 picture couldn't be saved/.test(note) ? true : "note: " + show(note);
    } finally {
      webImages.resetWebImageTransport();
    }
  });
  await check("offline: nothing is copied, the import still goes ahead", async () => {
    webImages.setWebImageTransport({ online: () => false, fetch: async () => { throw new Error("must not fetch"); } });
    try {
      await stageFile(htmlFile(NEWS));
      const note = await staging.copyStagedWebImages();
      return /offline/.test(note) && JSON.stringify(staging.importStaging.decks).includes("cdn.example/real-noscript.jpg") ? true : "note: " + show(note);
    } finally {
      webImages.resetWebImageTransport();
    }
  });

  // ── 7. One Import, in My Files ────────────────────────────────────────────
  await check("Import is not in the menu, on Home, or on an empty file", () => {
    const gone = ["importBtn", "homeImportBtn", "deckEmptyImportBtn", "myDecksImportEpubBtn", "myDecksImportPdfBtn", "myDecksImportInput"];
    const still = gone.filter((id) => document.getElementById(id));
    return still.length ? "still there: " + still.join(", ") : true;
  });
  await check("My Files' Import opens the Import screen aimed at the folder on screen", async () => {
    const prefs = await import("/src/library/my-decks-prefs.js" + V);
    staging.clearImportStaging();
    prefs.setMyDecksCwd("Recipes/Sides");
    document.getElementById("myDecksImportBtn").click();
    if (!el.importPanel.classList.contains("is-open")) return "the Import screen did not open";
    if (staging.importAimFolder !== "Recipes/Sides") return "aimed at " + JSON.stringify(staging.importAimFolder);
    el.pasteMarkdownInput.value = "# Pasted\n\nSome notes.";
    files.stagePastedMarkdown();
    return staging.importStaging && staging.importStaging.folder === "Recipes/Sides" ? true : "staged into " + JSON.stringify(staging.importStaging && staging.importStaging.folder);
  });
  await check("closing the Import screen forgets the folder", async () => {
    const header = await import("/src/ui/deck-header.js" + V);
    header.closeImportPanel();
    return staging.importAimFolder === null ? true : "still aimed at " + staging.importAimFolder;
  });
  await check("the file picker takes saved pages", () => {
    const accept = el.fileInput.getAttribute("accept") || "";
    const missing = [".html", ".htm", ".mhtml", ".mht", "multipart/related", "text/html"].filter((type) => !accept.split(",").includes(type));
    return missing.length ? "missing " + missing.join(", ") : true;
  });

  return results;
}`;

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  const browser = await launch({
    headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let results;
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js",
      "recall-clipper/vendor/turndown.js", "recall-clipper/vendor/turndown-plugin-gfm.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify && window.TurndownService)))) {
      throw new Error("marked/DOMPurify/Turndown never loaded — every case would fail for the wrong reason");
    }
    results = await page.evaluate(async (src) => (0, eval)("(" + src + ")")(), PROBE);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ${r.detail}`}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} web-page import cases · ${failed.length} failed`);
  console.log(`CHECK: ${results.length} checks · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}

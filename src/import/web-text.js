// The string half of importing from the web: reading a saved page's bytes,
// and tidying the Markdown a page turns into. Nothing here touches the DOM or
// imports anything, so tools/import-check.mjs can drive it in plain Node —
// src/import/web-page.js is the half that parses HTML.

// ── Recognising a saved page ───────────────────────────────────────────────

export const WEB_PAGE_EXTENSION_RE = /\.(?:html?|mhtml?|mht)$/i;

export const MHTML_EXTENSION_RE = /\.(?:mhtml?|mht)$/i;

// What phones and desktops label a saved page as. Android has no settled type
// for an .mhtml: the same file arrives as any of the last three.
export const WEB_PAGE_TYPES = new Set(["text/html", "application/xhtml+xml", "multipart/related", "message/rfc822", "application/x-mimearchive"]);

export const MHTML_TYPES = new Set(["multipart/related", "message/rfc822", "application/x-mimearchive"]);

export function isWebPageName(name) {
  return WEB_PAGE_EXTENSION_RE.test(String(name || ""));
}

export function isWebPageFile(file) {
  if (!file) return false;
  return isWebPageName(file.name) || WEB_PAGE_TYPES.has(String(file.type || "").toLowerCase());
}

// An .mhtml by its name or type, or — for a file that arrived with neither —
// by its first lines, which are always MIME headers declaring a multipart.
export function looksLikeMhtml(name, type, head) {
  if (MHTML_EXTENSION_RE.test(String(name || ""))) return true;
  if (MHTML_TYPES.has(String(type || "").toLowerCase())) return true;
  const top = String(head || "").slice(0, 4096);
  return /^MIME-Version:/im.test(top) && /multipart\/related/i.test(top);
}

// ── Bytes ──────────────────────────────────────────────────────────────────

// One character per byte, so the MIME structure can be read as text and any
// part's bytes recovered exactly afterwards, whatever its encoding.
export function bytesToLatin1(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

export function latin1ToBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

// Decoded with the named charset, or UTF-8 when the label is one this engine
// does not know (TextDecoder throws on those rather than guessing).
export function decodeBytes(bytes, charset = "utf-8") {
  const label = String(charset || "utf-8").trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (_) {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// The charset an HTML file declares in its first few kilobytes, after any byte
// order mark, which outranks it.
export function sniffHtmlCharset(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = bytesToLatin1(bytes.subarray(0, 4096));
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : "utf-8";
}

export function decodeQuotedPrintable(text) {
  const soft = String(text).replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < soft.length; i += 1) {
    const ch = soft[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function") return latin1ToBytes(atob(clean));
  return Uint8Array.from(Buffer.from(clean, "base64"));
}

// ── MHTML ──────────────────────────────────────────────────────────────────

// Header block → { name: value } with lower-cased names, folded lines joined.
export function parseMimeHeaders(block) {
  const headers = {};
  const unfolded = String(block).replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

// One parameter of a header value: `boundary` of a Content-Type, quoted or not.
export function mimeParam(value, name) {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i");
  const m = re.exec(String(value || ""));
  return m ? (m[1] ?? m[2] ?? "") : "";
}

export function splitHeadersAndBody(text) {
  const m = /\r?\n\r?\n/.exec(text);
  if (!m) return { head: text, body: "" };
  return { head: text.slice(0, m.index), body: text.slice(m.index + m[0].length) };
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

// A saved .mhtml, read as one character per byte (see bytesToLatin1), →
// { html, baseUrl } from its first text/html part, or null if it has none.
// The page's own address rides on that part's Content-Location — Chrome keeps
// every image's ORIGINAL address in the HTML, which is why the pictures still
// load from the web after the import.
export function parseMhtml(latin1) {
  const { head, body } = splitHeadersAndBody(String(latin1 || ""));
  const top = parseMimeHeaders(head);
  const boundary = mimeParam(top["content-type"], "boundary");
  if (!boundary) return null;
  const parts = body.split(`--${boundary}`);
  for (const raw of parts.slice(1)) {
    if (raw.startsWith("--")) break;
    const part = splitHeadersAndBody(raw.replace(/^\r?\n/, ""));
    const headers = parseMimeHeaders(part.head);
    const type = String(headers["content-type"] || "").toLowerCase();
    if (!type.startsWith("text/html")) continue;
    const encoding = String(headers["content-transfer-encoding"] || "").toLowerCase();
    const content = part.body.replace(/\r?\n$/, "");
    const bytes = encoding === "quoted-printable"
      ? decodeQuotedPrintable(content)
      : encoding === "base64"
        ? decodeBase64(content)
        : latin1ToBytes(content);
    const location = headers["content-location"] || top["snapshot-content-location"] || "";
    return {
      html: decodeBytes(bytes, mimeParam(headers["content-type"], "charset") || "utf-8"),
      baseUrl: isHttpUrl(location) ? location : ""
    };
  }
  return null;
}

// The address a desktop browser saved an .html from: Chrome and Edge write it
// into a comment at the top ("<!-- saved from url=(0042)https://… -->").
export function savedFromUrl(html) {
  const m = /<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i.exec(String(html || "").slice(0, 4096));
  return m && isHttpUrl(m[1]) ? m[1] : "";
}

// A page's <title> without the " | Site name" most of them carry.
export function cleanPageTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  const m = /^(.{10,}?)\s+[|·•–—-]\s+[^|·•–—]{1,60}$/.exec(text);
  return m ? m[1].trim() : text;
}

// ── Markdown that came from a web page ─────────────────────────────────────

// The reader proxy (r.jina.ai) labels every picture "Image 1: …" and passes
// lazy-load placeholders through as data: URIs that show nothing. The label
// goes; a placeholder image goes entirely.
export function cleanReaderMarkdown(markdown) {
  return String(markdown || "")
    .replace(/!\[\s*Image\s+\d+\s*:?\s*([^\]]*)\]/g, "![$1]")
    .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/gi, "");
}

// Every picture a piece of Markdown points at on the open web, in order, each
// once. Covers ![alt](url "title"), ![alt](<url>) and <img src="url">.
export function webImageUrls(markdown) {
  const text = String(markdown || "");
  const urls = [];
  const add = (url) => {
    const clean = String(url || "").trim();
    if (isHttpUrl(clean) && !urls.includes(clean)) urls.push(clean);
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  return urls;
}

// Swap every address in `map` for its replacement, wherever it appears in a
// string. Exact string matches only: an address is never rewritten inside a
// longer one, because longer addresses are replaced first.
export function rewriteUrls(text, map) {
  let out = String(text ?? "");
  const keys = Object.keys(map || {}).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (out.includes(key)) out = out.split(key).join(map[key]);
  }
  return out;
}

// The same, applied to every string anywhere inside a staged file — its notes,
// each card's question and answer, whatever the analysis kept.
export function rewriteUrlsDeep(value, map, seen = new Set()) {
  if (typeof value === "string") return rewriteUrls(value, map);
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = rewriteUrlsDeep(value[i], map, seen);
    return value;
  }
  for (const key of Object.keys(value)) value[key] = rewriteUrlsDeep(value[key], map, seen);
  return value;
}

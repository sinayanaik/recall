// A PDF made by the Recall Web Clipper browser extension (Save as PDF; before
// it, the Recall Web to PDF extension) carries where it came
// from in its document info: the page's address, site, the time it was
// captured and when the page was published (recall-clipper/lib/pdf-info.js
// writes them). importPdfFile (src/import/pdf.js) reads them here, so the new
// file remembers its source and its Notes open with a link back to the page.
//
// Imports nothing, so tools/import-check.mjs can test it without a browser.

const WEB_CAPTURE_MAX = 2048;

function cleanInfoField(value, max = 300) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The web page a PDF was saved from, or null for any other PDF.
 * @param {{info?: object}} metadata  what pdf.js's getMetadata() returns
 * @returns {{url, site, capturedAt, published, author, title} | null}
 */
export function webCaptureOf(metadata) {
  const info = (metadata && metadata.info) || {};
  const custom = info.Custom || {};
  const url = cleanInfoField(custom.RecallSourceURL, WEB_CAPTURE_MAX);
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  let site = cleanInfoField(custom.RecallSiteName, 120);
  if (!site) {
    try { site = new URL(url).hostname.replace(/^www\./, ""); } catch { site = ""; }
  }
  const capturedAt = cleanInfoField(custom.RecallCapturedAt, 40);
  const published = cleanInfoField(custom.RecallPublished, 40);
  return {
    url,
    site,
    capturedAt: Number.isNaN(Date.parse(capturedAt)) ? "" : capturedAt,
    published: Number.isNaN(Date.parse(published)) ? "" : published,
    author: cleanInfoField(info.Author, 200),
    title: cleanInfoField(info.Title, 300)
  };
}

function escapeLinkText(text) {
  return text.replace(/([\\[\]*_`<>])/g, "\\$1");
}

function readableDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The line a web capture's Notes start with:
 * "Source: [Headline](https://…) · Site · by Author · published 1 Oct 2026 · saved 5 Nov 2026"
 */
export function webCaptureNoteLine(capture, fallbackTitle = "") {
  if (!capture) return "";
  const label = escapeLinkText(capture.title || fallbackTitle || capture.site || capture.url);
  // Angle brackets keep an address with spaces or parentheses in one piece.
  const target = /[\s()<>]/.test(capture.url) ? `<${capture.url.replace(/[<>]/g, encodeURIComponent)}>` : capture.url;
  const bits = [`Source: [${label}](${target})`];
  if (capture.site) bits.push(escapeLinkText(capture.site));
  if (capture.author) bits.push(`by ${escapeLinkText(capture.author)}`);
  const published = readableDate(capture.published);
  const saved = readableDate(capture.capturedAt);
  if (published) bits.push(`published ${published}`);
  if (saved) bits.push(`saved ${saved}`);
  return bits.join(" · ");
}

// Importing from a URL, through a reader proxy when the page needs one.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { countQuestionHeadings, parseCards, stripReaderMetadata } from "./parse-cards.js?v=__BUILD__";
import { importAimFolder, stageImportSources } from "./staging.js?v=__BUILD__";
import { webPageSource } from "./files.js?v=__BUILD__";
import { webPageToMarkdown } from "./web-page.js?v=__BUILD__";
import { cleanReaderMarkdown } from "./web-text.js?v=__BUILD__";
import { setButtonLoading, setStatus } from "../ui/feedback.js?v=__BUILD__";

// Fetch a page the user asked to import. Named for its caller because there is
// a second, unrelated text fetch further down for the release check — and when
// both were called `fetchText`, the later declaration silently won for these
// callers too. That handed every URL import the release check's 8-second abort,
// which is far too short for a large page on a slow connection: the fetch was
// aborted, the reader-proxy retry was aborted the same way, and the user was
// told "Could not fetch this URL" about a URL that was fine.
//
// Bounded, but on this job's own terms. Unbounded was the original intent here
// and is its own bug — the Fetch button would sit on "Fetching…" for as long as
// a dead connection cared to stall.
export const IMPORT_FETCH_TIMEOUT_MS = 45000;

export async function fetchImportText(url) {
  let signal;
  try { signal = AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS); } catch (_) { /* pre-2022 engine */ }
  const direct = await fetch(url, { mode: "cors", signal });
  if (!direct.ok) throw new Error(`HTTP ${direct.status}`);
  return direct.text();
}

export function cleanImportUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);

    if (parsed.hostname === "r.jina.ai") {
      return decodeURIComponent(`${parsed.pathname}${parsed.search}`.replace(/^\/+/, ""));
    }

    if (parsed.hostname.endsWith("notion.site") || parsed.hostname.endsWith("notion.so")) {
      parsed.searchParams.delete("source");
      parsed.searchParams.delete("pvs");
    }

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function readerUrlFor(url) {
  return `https://r.jina.ai/${url}`;
}

// A fetched page that came back as HTML (a site that allows the direct fetch)
// rather than the reader proxy's Markdown.
export function looksLikeHtml(text) {
  return /^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(String(text || "").slice(0, 2000));
}

export async function fetchUrl() {
  return importFromUrl(el.urlInput.value, { folder: importAimFolder });
}

export async function importFromUrl(rawUrl, { folder = null } = {}) {
  const url = cleanImportUrl(rawUrl);
  if (!url) {
    setStatus("Enter a URL first.", "error");
    return;
  }

  state.importTitleHint = url;
  setButtonLoading(el.fetchBtn, true, "Fetching…");
  setStatus("Fetching source...");

  try {
    let text;
    const isNotionUrl = /\/\/[^/]*(notion\.site|notion\.so)\//i.test(url);

    try {
      if (isNotionUrl) throw new Error("Use Reader for Notion pages");
      text = await fetchImportText(url);
    } catch {
      text = await fetchImportText(readerUrlFor(url));
    }

    // The page itself: cleaned of its ads and furniture the same way a saved
    // page is, rather than staged as raw HTML.
    if (looksLikeHtml(text)) {
      const page = await webPageToMarkdown({ html: text, baseUrl: url });
      if (!page) {
        setStatus("Couldn't read this page — turning a page into notes needs a connection the first time.", "error");
        return;
      }
      setStatus("Fetched. Checking what's in it...");
      stageImportSources([webPageSource(page, page.title || url)], { folder });
      return;
    }

    const source = cleanReaderMarkdown(stripReaderMetadata(text));

    // A public Notion page renders its toggles collapsed, so the fetch comes
    // back as question headings with nothing under them. Say so instead of
    // staging a page that would import as a list of empty prompts.
    if (!parseCards(source).length && countQuestionHeadings(source)) {
      setStatus("This public Notion URL only exposes collapsed question headings, not answers. Use Export -> Markdown & CSV, then upload the zip or paste the exported Markdown.", "error");
      return;
    }

    setStatus("Fetched. Checking what's in it...");
    // Marked as from the web, so its pictures are copied into Recall when the
    // import is confirmed (see src/import/web-images.js).
    stageImportSources([{ kind: "markdown", name: url, markdown: cleanReaderMarkdown(text), baseUrl: url, web: true }], { folder });
  } catch (error) {
    setStatus("Could not fetch this URL. For a page you're signed in to, save it in your browser (Chrome: ⋮ → Download page) and import the saved file.", "error");
  } finally {
    setButtonLoading(el.fetchBtn, false);
  }
}

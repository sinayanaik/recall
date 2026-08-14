// Importing from a URL, through a reader proxy when the page needs one.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { countQuestionHeadings, parseCards, stripReaderMetadata } from "./parse-cards.js?v=__BUILD__";
import { stageMarkdownImport } from "./staging.js?v=__BUILD__";
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

export async function fetchUrl() {
  const url = cleanImportUrl(el.urlInput.value);
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

    const source = stripReaderMetadata(text);

    // A public Notion page renders its toggles collapsed, so the fetch comes
    // back as question headings with nothing under them. Say so instead of
    // staging a page that would import as a list of empty prompts.
    if (!parseCards(source).length && countQuestionHeadings(source)) {
      setStatus("This public Notion URL only exposes collapsed question headings, not answers. Use Export -> Markdown & CSV, then upload the zip or paste the exported Markdown.", "error");
      return;
    }

    setStatus("Fetched. Checking what's in it...");
    stageMarkdownImport(text, { name: url, folder: null });
  } catch (error) {
    setStatus("Could not fetch this URL. If it is private Notion content, export Markdown or paste the page content.", "error");
  } finally {
    setButtonLoading(el.fetchBtn, false);
  }
}

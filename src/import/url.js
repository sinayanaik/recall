// Importing from a URL, through a reader proxy when the page needs one.

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

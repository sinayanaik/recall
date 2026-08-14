// Deck -> markdown, and the filename it gets.

import { state } from "../main.js?v=__BUILD__";

// A card's question/answer can legitimately contain a standalone "---" line
// (a Markdown horizontal rule — "Both sides support Markdown" per
// FlashCard_Format.txt), which is otherwise indistinguishable from the
// front/back separator this same format uses. Escape it so export→import
// round-trips instead of truncating the question at the first such line (see
// parseDelimitedCards, which unescapes "\---" back to "---"). Fence-aware to
// match the parser, which never treats "---" inside a ``` block as anything
// but literal content — e.g. YAML frontmatter inside a fenced code sample
// must NOT be escaped, or it comes back out of the parser still escaped.
export function escapeCardSideSeparator(text) {
  let inFence = false;
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && /^\s*---(?!-)/.test(line)) return line.replace(/^(\s*)---/, "$1\\---");
      return line;
    })
    .join("\n");
}

export function formatCardList(title, cards) {
  const body = cards.length
    ? cards.map((card) => `::\n${escapeCardSideSeparator(card.question.trim())}\n\n---\n\n${escapeCardSideSeparator(card.answer.trim())}\n::`).join("\n\n")
    : "_None_";
  return `## ${title}\n\n${body}`;
}

export function slugifyFileName(value, fallback = "recall") {
  const source = String(value || "").trim() || fallback;
  const cleaned = source
    .replace(/\.(md|markdown|mdown|mkdn|txt|json|zip)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function exportBaseName(scope = "all") {
  const base = slugifyFileName(state.deckTitle || state.sourceTitle || "recall");
  if (scope === "known") return `${base} - known`;
  if (scope === "review") return `${base} - review`;
  if (scope === "uncategorized") return `${base} - uncategorized`;
  return base;
}

export function normalizeCardStatus(status) {
  return status === "known" || status === "review" ? status : "";
}

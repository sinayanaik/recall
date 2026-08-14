// Working out what an incoming file actually IS before importing it: one deck
// or several, cards or notes.

import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { NOTES_BLOCK_PRESENT_RE, classifyCardSyntax, extractNotesFromMarkdown, hasExplicitCardSyntax, inferDeckTitle, normalizeMarkdown, parseCards, removeEmptyHeadingGroups, stripReaderMetadata, titleFromImportHint } from "./parse-cards.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { normalizeCardStatus } from "../main.js?v=__BUILD__";

// Deck metadata lines webDeckPayloadMarkdown writes under the title. They are
// bookkeeping — never notes text and never card content.
export const DECK_META_LINE_RE = /^(?:Category|Deck ID|Exported):\s*/i;

export function stripDeckMetaLines(markdown) {
  return normalizeMarkdown(markdown)
    .split("\n")
    .filter((line) => !DECK_META_LINE_RE.test(line.trim()))
    .join("\n")
    .trim();
}

// Splits a Markdown file at its top-level `#` headings into candidate deck
// sections. Splitting alone proves nothing — sectionsLookLikeSeparateDecks
// below decides whether the split is real.
export function splitDeckSections(markdown) {
  const source = removeEmptyHeadingGroups(stripReaderMetadata(markdown));
  const lines = source.split("\n");
  const sections = [];
  let current = null;
  let inNotesBlock = false;

  const start = (title) => ({ title, category: defaultDeckCategory, hadMeta: false, lines: [] });

  for (const line of lines) {
    // Never read inside a deck-notes block: notes are freeform and may contain
    // `#` headings, `Category:` lines and card-looking syntax of their own.
    if (/^<!--\s*recall:notes\s*-->\s*$/.test(line.trim())) inNotesBlock = true;
    if (inNotesBlock) {
      if (!current) current = start("");
      current.lines.push(line);
      if (/^<!--\s*\/recall:notes\s*-->\s*$/.test(line.trim())) inNotesBlock = false;
      continue;
    }

    const heading = line.match(/^#\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      current = start(heading[1].trim());
      continue;
    }

    if (!current) {
      if (!line.trim()) continue;
      current = start("");
    }

    const category = line.match(/^Category:\s*(.+)$/i);
    if (category) {
      current.category = normalizeDeckCategory(category[1].trim());
      current.hadMeta = true;
      continue;
    }
    if (/^(?:Deck ID|Exported):\s*/i.test(line.trim())) {
      current.hadMeta = true;
      continue;
    }
    current.lines.push(line);
  }

  if (current) sections.push(current);
  return sections
    .map((section) => ({ ...section, content: section.lines.join("\n").trim() }))
    .filter((section) => section.content || section.title);
}

// A section is its own deck only if it proves it: Recall's own export metadata
// (`Category:` / `Deck ID:`), a saved notes block, or genuine card syntax.
export function sectionLooksLikeDeck(section) {
  return section.hadMeta
    || NOTES_BLOCK_PRESENT_RE.test(section.content)
    || hasExplicitCardSyntax(section.content);
}

// True only for files that really are several decks glued together. A long
// notes document with several `#` chapters fails this test — it used to be torn
// into one deck per chapter.
export function sectionsLookLikeSeparateDecks(sections) {
  if (sections.length < 2) return false;
  return sections.every(sectionLooksLikeDeck);
}

// Everything the import panel needs to know about one candidate deck inside the
// staged file. `cards` is the generous read (plain headings included) offered
// behind the "Cards" choice; `explicitCards` is the conservative read used when
// the document is kept as notes and its real cards are pulled out alongside.
export function analyzeIncomingDeck({ title = "", category = defaultDeckCategory, content = "", titleHint = "", source = "" }) {
  const body = stripDeckMetaLines(content);
  const { notes: notesFromBlock } = extractNotesFromMarkdown(body);
  return {
    title: title || inferDeckTitle(body, titleHint),
    category: normalizeDeckCategory(category),
    source,
    content: body,
    notesFromBlock,
    // The document as notes: Recall's own exports keep their notes in a
    // sentinel block, everything else IS the notes.
    notesBody: notesFromBlock || body,
    cardSyntax: classifyCardSyntax(body),
    cards: parseCards(body),
    explicitCards: parseCards(body, { allowHeuristicHeadings: false }),
    selected: true
  };
}

// A candidate deck built from a Recall .json export. Its notes/cards split is
// already recorded in the file, so nothing is parsed or guessed — the payload
// rides along so a lone snapshot can still take the full-fidelity path (cloud
// id, per-card statuses, quick-note labels) through loadDeckSnapshot.
export function snapshotIncomingDeck(payload, { name = "", source = "" } = {}) {
  const notes = String(payload?.notes || "");
  const cards = (Array.isArray(payload?.cards) ? payload.cards : [])
    .filter((card) => card && (card.question || card.answer))
    .map((card) => ({
      question: String(card.question || ""),
      answer: String(card.answer || ""),
      status: normalizeCardStatus(card.status)
    }));
  return {
    title: String(payload?.deckTitle || "").trim() || titleFromImportHint(name) || "Imported deck",
    category: normalizeDeckCategory(payload?.deckCategory || payload?.category),
    source,
    content: "",
    notesFromBlock: notes,
    notesBody: notes,
    cardSyntax: "explicit",
    cards,
    explicitCards: cards,
    snapshot: payload,
    selected: true
  };
}

// What a chosen content mode actually produces for one candidate deck.
export function resolveIncomingDeck(deck, mode) {
  const base = { title: deck.title, category: deck.category, source: deck.source };
  if (mode === "cards") return { ...base, notes: "", cards: deck.cards };
  if (mode === "both") return { ...base, notes: deck.notesBody, cards: deck.explicitCards };
  return { ...base, notes: deck.notesBody, cards: [] };
}

// Which "Import as" choices make sense for this file, and which one to preselect.
// The default is the heart of the fix: plain headings ("heuristic") mean a
// document, so notes wins unless the file proves it holds real cards.
export function importContentModesFor(decks) {
  const anyCards = decks.some((deck) => deck.cards.length > 0);
  const anyExplicitCards = decks.some((deck) => deck.explicitCards.length > 0);
  const anyNotes = decks.some((deck) => deck.notesBody.trim());
  const anyNotesBlock = decks.some((deck) => deck.notesFromBlock.trim());

  const modes = [];
  if (anyNotes) modes.push("notes");
  if (anyCards) modes.push("cards");
  if (anyExplicitCards && anyNotes) modes.push("both");
  if (!modes.length) modes.push("notes");

  // "cards" is only safe when EVERY file proves it holds cards. In a mixed
  // batch — a folder of lecture notes with one quiz file among them — one file's
  // card syntax must not drag the prose files into being shredded at their
  // headings, so those batches fall to "both": each document is kept whole and
  // only genuine card syntax is pulled out of it.
  const withContent = decks.filter((deck) => deck.cards.length || deck.notesBody.trim());
  const allExplicit = withContent.length > 0 && withContent.every((deck) => deck.explicitCards.length > 0);

  let suggested;
  if (anyNotesBlock && anyExplicitCards) suggested = "both";
  else if (allExplicit) suggested = "cards";
  else if (anyExplicitCards) suggested = "both";
  else suggested = "notes";
  if (!modes.includes(suggested)) suggested = modes[0];

  return { modes, suggested };
}

export function analyzeMarkdownImport(rawMarkdown, { name = "" } = {}) {
  const sections = splitDeckSections(rawMarkdown);
  const multi = sectionsLookLikeSeparateDecks(sections);
  const titleHint = titleFromImportHint(name);

  const decks = multi
    ? sections.map((section) => analyzeIncomingDeck({ ...section, titleHint, source: name }))
    : [analyzeIncomingDeck({
      title: sections.length === 1 ? sections[0].title : "",
      category: sections.length === 1 ? sections[0].category : defaultDeckCategory,
      // Single-document imports keep the file verbatim (minus reader chrome and
      // export bookkeeping) so a notes import round-trips exactly as written.
      content: stripReaderMetadata(rawMarkdown),
      titleHint,
      source: name
    })];

  const { modes, suggested } = importContentModesFor(decks);
  return { decks, modes, suggested, multi };
}

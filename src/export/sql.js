// Exporting decks as INSERT statements, so a library can be reloaded into a
// fresh Supabase project without going through the app.

import { downloadTextFile, quickNoteCategoryForCard } from "../cloud/web-decks.js?v=__BUILD__";
import { exportBaseName, normalizeCardStatus, slugifyFileName } from "./markdown.js?v=__BUILD__";
import { cardsForScope } from "./pdf.js?v=__BUILD__";
import { normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { isQuickNotesDeck } from "../quick-notes/categories.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";

export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function sqlTimestamp(value, fallback = new Date().toISOString()) {
  const parsed = value ? new Date(value) : null;
  return sqlValue(parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : fallback);
}

// `includeNotes`/`includeCards` default true (today's full-deck export). A
// bulk "Cards" or "Notes" only export sets one of these false — critically,
// that must OMIT the notes column / the cards DELETE+INSERT entirely rather
// than sending a blanked value through the normal upsert, which would (if this
// script is ever run against a live database) silently wipe the omitted half
// of every deck it touches instead of just leaving it out of the file.
export function buildDeckSql(payloads, title = "Recall SQL Export", { includeNotes = true, includeCards = true } = {}) {
  const lines = [
    `-- ${title}`,
    `-- Exported: ${new Date().toISOString()}`,
    "BEGIN;"
  ];

  payloads.forEach((payload) => {
    const deck = payload.deck;
    lines.push("");
    // Strip newlines before interpolating into a line comment — unlike the
    // INSERT below (escaped via sqlValue), a title containing a literal
    // newline here would break out of the "--" comment and let the rest of
    // the title be interpreted as SQL.
    lines.push(`-- Deck: ${String(deck.title || "").replace(/\r?\n/g, " ")}`);
    const notesColumns = includeNotes ? [["notes", sqlValue(deck.notes || "")]] : [];
    const columns = [
      ["id", sqlValue(deck.id)],
      ["title", sqlValue(deck.title)],
      ["category", sqlValue(deck.category)],
      ...notesColumns,
      // Carries the quick_notes deck's managed category set; without it a
      // restore from this file leaves every note's label pointing at a
      // category that no longer exists.
      ["meta", `${sqlValue(JSON.stringify(deck.meta || {}))}::jsonb`],
      ["current_card_index", Number(deck.current_card_index) || 0],
      ["created_at", sqlTimestamp(deck.created_at)],
      ["updated_at", sqlTimestamp(deck.updated_at)],
      ["last_accessed_at", sqlTimestamp(deck.last_accessed_at)]
    ];
    const updateColumns = ["title", "category", ...(includeNotes ? ["notes"] : []), "meta", "current_card_index", "updated_at", "last_accessed_at"];
    lines.push(
      `INSERT INTO decks (${columns.map(([name]) => name).join(", ")}) VALUES ` +
      `(${columns.map(([, value]) => value).join(", ")}) ` +
      "ON CONFLICT (id) DO UPDATE SET " +
      updateColumns.map((name) => `${name} = EXCLUDED.${name}`).join(", ") + ";"
    );

    if (includeCards) {
      lines.push(`DELETE FROM cards WHERE deck_id = ${sqlValue(deck.id)};`);
      if (payload.cards.length) {
        const values = payload.cards.map((card, index) => (
          `(${sqlValue(card.id)}, ${sqlValue(deck.id)}, ${sqlValue(card.question)}, ${sqlValue(card.answer)}, ${Number.isFinite(Number(card.position)) ? Number(card.position) : index}, ${sqlValue(normalizeCardStatus(card.status))}, ${sqlValue(card.category || null)}, ${sqlTimestamp(card.created_at)}, ${sqlTimestamp(card.updated_at)})`
        ));
        lines.push(
          "INSERT INTO cards (id, deck_id, question, answer, position, status, category, created_at, updated_at) VALUES\n" +
          values.join(",\n") +
          "\nON CONFLICT (id) DO UPDATE SET " +
          "deck_id = EXCLUDED.deck_id, question = EXCLUDED.question, answer = EXCLUDED.answer, position = EXCLUDED.position, status = EXCLUDED.status, category = EXCLUDED.category, updated_at = EXCLUDED.updated_at;"
        );
      }
    }
  });

  lines.push("");
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

export function currentDeckPayload(scope = "all") {
  const deckTitle = state.deckTitle || state.sourceTitle || "Untitled Deck";
  const deckId = state.deckId || slugifyFileName(deckTitle);
  const cards = cardsForScope(scope).map((card, index) => ({
    id: card.id,
    deck_id: deckId,
    question: card.question,
    answer: card.answer,
    position: index,
    status: normalizeCardStatus(state.statusById[card.id]),
    category: quickNoteCategoryForCard(card),
    created_at: null,
    updated_at: new Date().toISOString()
  }));

  return {
    deck: {
      id: deckId,
      title: deckTitle,
      category: normalizeDeckCategory(state.deckCategory),
      notes: state.notes || "",
      meta: isQuickNotesDeck(deckId, deckTitle) && state.quickNoteCategories.length
        ? { quickNoteCategories: state.quickNoteCategories }
        : {},
      current_card_index: Number.isFinite(state.current) ? state.current : 0,
      created_at: null,
      updated_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    },
    cards
  };
}

export function exportSql(scope = "all") {
  const payload = currentDeckPayload(scope);
  if (!payload.cards.length) {
    setStatus("No cards to export as SQL.", "error");
    return;
  }

  downloadTextFile(
    buildDeckSql([payload], `${payload.deck.title} SQL Export`),
    `${exportBaseName(scope)}.sql`,
    "application/sql;charset=utf-8"
  );
  setStatus("Exported current deck as SQL.");
}

// Exporting one deck, a selection, or the whole library, in whichever format
// the user picked.

import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { deckPayloadSnapshot, downloadTextFile, statusByIdFromCards, touchWebDeckAccess, webDeckPayloadMarkdown } from "../cloud/web-decks.js?v=__BUILD__";
import { buildDeckSql } from "./sql.js?v=__BUILD__";
import { myDeckPayload } from "../library/my-decks-selection.js?v=__BUILD__";
import { buildCornellFlatDocument, buildDocxBytes, buildNotesFlatDocument, exportCardsPdf, exportNotesFlatPdf, fetchCloudDeckList, imageEmbedSuffix, isDeckTombstoned, listLocalDecks, normalizeCardStatus, prepareExportHtml, slugifyFileName, wrapStandaloneHtmlDocument } from "../main.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import { chooseExportContent } from "../ui/pickers.js?v=__BUILD__";

// Shared writer for every My Decks export path. `payloads` come from
// myDeckPayload; a single payload exports as that deck, several export as one
// document/file with per-deck dividers (PDF) or concatenation (MD/SQL/JSON).
// `contentType` — "both" (default, the single/per-row export's long-standing
// behaviour: cards-only for pdf/html/doc, cards+notes combined for
// markdown/json/sql), or "cards"/"notes" when a bulk export (Export All /
// multi-select) asked the user which one they wanted via chooseExportContent().
export async function exportDeckPayloads(payloads, format, { fileBaseName, title }, contentType = "both") {
  if (contentType === "notes") {
    if (format === "pdf") {
      await exportNotesFlatPdf(payloads, { fileBaseName, title });
      return;
    }
    if (format === "html" || format === "doc") {
      const sections = payloads.map((payload) => ({
        title: payload.deck.title,
        category: payload.deck.category,
        notes: payload.deck.notes || ""
      }));
      const rawBodyHtml = buildNotesFlatDocument(title, sections);
      if (format === "doc") {
        const { bytes, failedImageCount } = await buildDocxBytes(rawBodyHtml, fileBaseName);
        downloadTextFile(bytes, `${fileBaseName}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        setStatus(`Exported notes as Word (.docx).${imageEmbedSuffix(failedImageCount)}`);
      } else {
        const { html: bodyHtml, failedImageCount } = await prepareExportHtml(rawBodyHtml);
        const html = await wrapStandaloneHtmlDocument(bodyHtml, fileBaseName);
        downloadTextFile(html, `${fileBaseName}.html`, "text/html;charset=utf-8");
        setStatus(`Exported notes as standalone HTML.${imageEmbedSuffix(failedImageCount)}`);
      }
      return;
    }
    if (format === "markdown") {
      // Wrapped in the recall:notes sentinels the importer looks for, so a
      // notes export re-imports as notes. Without them the file is just a
      // Markdown document with headings, and importing it used to chop it into
      // one flashcard per heading. The sentinels are HTML comments, so the file
      // still reads normally in any other Markdown tool.
      downloadTextFile(
        payloads.map((payload) => {
          const body = String(payload.deck.notes || "").trim();
          return `# ${payload.deck.title}\n\n${body ? notesExportBlock(body) : "*No notes for this deck.*"}`;
        }).join("\n\n---\n\n"),
        `${fileBaseName}.md`,
        "text/markdown;charset=utf-8"
      );
      setStatus("Exported notes as Markdown.");
      return;
    }
    // sql / json: keep the deck row itself, but strip cards down to none.
    payloads = payloads.map((payload) => ({ ...payload, cards: [] }));
  } else if (contentType === "cards") {
    // sql / json: keep the cards, but blank the notes column/field. pdf/html/doc
    // never included notes in the first place, so nothing changes for them.
    payloads = payloads.map((payload) => ({ ...payload, deck: { ...payload.deck, notes: "" } }));
  }

  if (format === "pdf") {
    if (payloads.length === 1) {
      const payload = payloads[0];
      await exportCardsPdf(payload.deck.title, payload.cards, {
        fileBaseName,
        statusById: statusByIdFromCards(payload.cards)
      });
      return;
    }
    const cards = [];
    const statusById = {};
    payloads.forEach((payload) => {
      cards.push({
        type: "deck-divider",
        title: payload.deck.title,
        category: payload.deck.category
      });
      payload.cards.forEach((card) => {
        const id = `${payload.deck.id}:${card.id}`;
        cards.push({ id, question: card.question, answer: card.answer, position: cards.length });
        const status = normalizeCardStatus(card.status);
        if (status) statusById[id] = status;
      });
    });
    await exportCardsPdf(title, cards, { fileBaseName, statusById });
    return;
  }

  if (format === "html" || format === "doc") {
    const cards = [];
    const statusById = {};
    if (payloads.length === 1) {
      payloads[0].cards.forEach((card) => cards.push(card));
      Object.assign(statusById, statusByIdFromCards(payloads[0].cards));
    } else {
      payloads.forEach((payload) => {
        cards.push({
          type: "deck-divider",
          title: payload.deck.title,
          category: payload.deck.category
        });
        payload.cards.forEach((card) => {
          const id = `${payload.deck.id}:${card.id}`;
          cards.push({ id, question: card.question, answer: card.answer, position: cards.length });
          const status = normalizeCardStatus(card.status);
          if (status) statusById[id] = status;
        });
      });
    }
    const rawBodyHtml = buildCornellFlatDocument(title, cards, { sourceTitle: title, statusById });
    if (format === "doc") {
      const { bytes, failedImageCount } = await buildDocxBytes(rawBodyHtml, fileBaseName);
      downloadTextFile(bytes, `${fileBaseName}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      setStatus(`Exported as Word (.docx).${imageEmbedSuffix(failedImageCount)}`);
    } else {
      const { html: bodyHtml, failedImageCount } = await prepareExportHtml(rawBodyHtml);
      const html = await wrapStandaloneHtmlDocument(bodyHtml, fileBaseName);
      downloadTextFile(html, `${fileBaseName}.html`, "text/html;charset=utf-8");
      setStatus(`Exported as standalone HTML.${imageEmbedSuffix(failedImageCount)}`);
    }
    return;
  }

  if (format === "markdown") {
    downloadTextFile(
      payloads.map(webDeckPayloadMarkdown).join("\n\n---\n\n"),
      `${fileBaseName}.md`,
      "text/markdown;charset=utf-8"
    );
    setStatus("Exported as Markdown.");
    return;
  }

  if (format === "sql") {
    // Derived from contentType directly rather than the (possibly already
    // blanked/emptied) `payloads` above — buildDeckSql needs to know to omit
    // the notes column / the cards statements entirely, not just receive an
    // empty value for them (see buildDeckSql's own comment for why).
    const sqlOptions = { includeNotes: contentType !== "cards", includeCards: contentType !== "notes" };
    downloadTextFile(buildDeckSql(payloads, `${title} SQL Export`, sqlOptions), `${fileBaseName}.sql`, "application/sql;charset=utf-8");
    setStatus("Exported as SQL.");
    return;
  }

  const body = payloads.length === 1
    ? deckPayloadSnapshot(payloads[0])
    : {
      app: "recall",
      version: 1,
      exportedAt: new Date().toISOString(),
      decks: payloads.map(deckPayloadSnapshot)
    };
  downloadTextFile(`${JSON.stringify(body, null, 2)}\n`, `${fileBaseName}.json`, "application/json;charset=utf-8");
  setStatus("Exported as JSON.");
}

export async function exportMyDeck(sel, format) {
  try {
    setStatus("Exporting deck...");
    const payload = await myDeckPayload(sel);
    await exportDeckPayloads([payload], format, {
      fileBaseName: slugifyFileName(payload.deck.title || "recall"),
      title: payload.deck.title || "Deck"
    });
    if (format !== "pdf") showToast(`Exported "${payload.deck.title || "deck"}" as ${format.toUpperCase()}`);
    if (sel.deckId && supabaseClient && isSignedIn && navigator.onLine) {
      touchWebDeckAccess(sel.deckId).catch(() => {});
    }
  } catch (error) {
    console.error("Failed to export deck", error);
    setStatus("Failed to export deck.", "error");
    showToast("Export failed", "error");
  }
}

export async function exportSelectedMyDecks(selections, format) {
  if (!selections.length) return;
  const contentType = await chooseExportContent();
  if (!contentType) return; // cancelled
  try {
    setStatus(`Exporting ${selections.length} deck${selections.length === 1 ? "" : "s"}...`);
    const payloads = [];
    for (const sel of selections) payloads.push(await myDeckPayload(sel));
    await exportDeckPayloads(payloads, format, { fileBaseName: `selected-decks-${contentType}`, title: "Selected Decks" }, contentType);
    if (format !== "pdf") showToast(`Exported ${payloads.length} deck${payloads.length === 1 ? "" : "s"} ${contentType} as ${format.toUpperCase()}`);
  } catch (error) {
    console.error("Failed to export selected decks", error);
    setStatus("Failed to export selected decks.", "error");
    showToast("Export failed", "error");
  }
}

// Everything My Decks shows: all on-device decks, plus cloud-only decks when
// the cloud is reachable (skipped with a warning when it isn't).
export async function allMyDeckSelections() {
  const localDecks = listLocalDecks();
  const selections = localDecks.map((deck) => ({ localId: deck.id, deckId: deck.deckId || null }));
  if (supabaseClient && isSignedIn && navigator.onLine) {
    try {
      const localCloudIds = new Set(localDecks.map((d) => String(d.deckId)).filter((id) => id && id !== "null"));
      (await fetchCloudDeckList())
        .filter((deck) => !localCloudIds.has(String(deck.id)) && !isDeckTombstoned(deck.id))
        .forEach((deck) => selections.push({ localId: null, deckId: String(deck.id) }));
    } catch (error) {
      console.warn("Could not include cloud-only decks in the export", error);
    }
  }
  return selections;
}

export async function exportAllMyDecks(format) {
  const contentType = await chooseExportContent();
  if (!contentType) return; // cancelled
  try {
    setStatus("Exporting all decks...");
    const selections = await allMyDeckSelections();
    if (!selections.length) {
      setStatus("No decks to export.", "error");
      return;
    }
    const payloads = [];
    for (const sel of selections) payloads.push(await myDeckPayload(sel));
    await exportDeckPayloads(payloads, format, { fileBaseName: `all-decks-${contentType}`, title: "All Decks" }, contentType);
    if (format !== "pdf") showToast(`Exported all decks' ${contentType} as ${format.toUpperCase()}`);
  } catch (error) {
    console.error("Failed to export all decks", error);
    setStatus("Failed to export all decks.", "error");
    showToast("Export failed", "error");
  }
}

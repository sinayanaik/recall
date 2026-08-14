// Every relative import in src/ carries ?v=__BUILD__, substituted by
// .github/workflows/deploy.yml. Without it, a release could serve a new
// main.js against a browser- or worker-cached copy of an old dependency — the
// mixed-build failure this repo has already shipped twice. deploy.yml and
// tools/module-symbols.mjs both refuse a relative import without it.

import { BACKUP_IMAGE_REF_RE, decodeImageRefEntities, exportLibraryBackupZip } from "./backup/backup.js?v=__BUILD__";
import { runRestoreFlow } from "./backup/restore.js?v=__BUILD__";
import { clearAllCardDropTargets, closeAllCardsPanel, createBlankCard, deleteAllCard, goToCard, handleAllCardDragOver, handleAllCardDragStart, handleAllCardDrop, insertCardAfter, pushCardUndoSnapshot, redoCardAction, setAllCardStatus, snapshotCardsState, undoCardAction } from "./cards/all-cards-edit.js?v=__BUILD__";
import { adjustCornellRows, allCardById, allCardsAnswersVisible, allCardsCompact, flipAllCard, handleAllCardDragEnd, openAllCardEditor, openAllCardsPanel, setAllCardsAnswersVisible, setAllCardsCompact, setAllCardsFilter, toggleAllCardEditor } from "./cards/all-cards.js?v=__BUILD__";
import { hasActiveDeck } from "./cards/card-status.js?v=__BUILD__";
import { showCard } from "./cards/card-view.js?v=__BUILD__";
import { flipCard, moveCard, navigateCard, replayDeck, resetQuiz, shuffleCards } from "./cards/deck-actions.js?v=__BUILD__";
import { afterPaint, questionFitDeferredBySelection, scheduleLiveQuestionFit } from "./cards/question-fit.js?v=__BUILD__";
import { resetStudyDeck } from "./cards/study.js?v=__BUILD__";
import { describeAuthError, explicitLogout, getCachedSession, handleLogin, handleLogout, handleSignup, setExplicitLogout, verifiedCloudUserId } from "./cloud/auth.js?v=__BUILD__";
import { isMissingColumnError, isMissingRelationError } from "./cloud/deck-list.js?v=__BUILD__";
import { CLOUD_TIMEOUT_MS, abortable, withTimeout } from "./cloud/net.js?v=__BUILD__";
import { PENDING_STYLE_KEY, closeStylePanel, handleStyleEnvironmentChange, loadStyleFromWeb, openStylePanel, switchStyleEditProfile, syncStyleToWeb } from "./cloud/style-sync.js?v=__BUILD__";
import { clearSupabaseConfig, initSupabaseClient, isSignedIn, loadSupabaseConfig, reloadSupabaseLibrary, saveSupabaseConfig, setSignedIn, setSupabaseClient, supabaseClient, waitForSupabaseLibrary } from "./cloud/supabase-client.js?v=__BUILD__";
import { closeWebDeckExportMenus, downloadTextFile, loadWebDeck } from "./cloud/web-decks.js?v=__BUILD__";
import { BUILD_STAMP, BUILD_TIME, IS_DEV_BUILD } from "./core/build.js?v=__BUILD__";
import { deckStorageKey, defaultDeckCategory, themeStorageKey } from "./core/constants.js?v=__BUILD__";
import { el } from "./core/dom.js?v=__BUILD__";
import { ensureJsZip, ensureMermaid, ensureTurndown, warmDeferredLibraries } from "./core/lib-loader.js?v=__BUILD__";
import { escapeHtml, escapeXml } from "./core/text.js?v=__BUILD__";
import { exportAllMyDecks, exportSelectedMyDecks } from "./export/decks.js?v=__BUILD__";
import { childBlocks, collectDocxMedia, createDocxRenderContext } from "./export/docx.js?v=__BUILD__";
import { finishExportRoot, prepareExportHtml, prepareExportRoot, wrapStandaloneHtmlDocument } from "./export/html.js?v=__BUILD__";
import { exportBaseName, normalizeCardStatus, slugifyFileName } from "./export/markdown.js?v=__BUILD__";
import { buildCornellFlatDocument, buildCornellPrintDocument, buildNotesExportBody, buildNotesFlatPrintDocument, buildNotesPrintDocument, cardsForScope, closePrintPreview, exportJson, exportMarkdown, pdfPrintStyleId, printPreviewOpen, printableCardCount, scopeTitle, setPrintTitleBeforeExport } from "./export/pdf.js?v=__BUILD__";
import { exportSql } from "./export/sql.js?v=__BUILD__";
import { buildZipArchive, utf8Bytes } from "./export/zip.js?v=__BUILD__";
import { eraseNotesSelection, makeClozeFromSelection } from "./format/cloze.js?v=__BUILD__";
import { LIST_MARKER_RE, MARK_CLOSE_TAG, MARK_HIGHLIGHT_DEFAULT, markHighlightSwatchButtonsHtml, markOpenTag, toggleMarkColorInText } from "./format/highlight.js?v=__BUILD__";
import { CLOZE_MAKE_ICON, RENDER_HIGHLIGHT_GLYPH, closeAllRenderMenus, handleRenderToolbarAction, initRenderToolbars, refreshRenderSwatches, renderFormatDefaults, renderTargetConfig, setRenderDefault } from "./format/render-toolbar.js?v=__BUILD__";
import { applyPillHighlight, buildPillHighlightMenu, clozeTextareaSelection, eraseTextareaSelection, extractSelectionToNote, hideNotesSelectionButtonUnlessPinned, pillActionTarget } from "./format/selection-tools.js?v=__BUILD__";
import { countQuestionHeadings, parseCards, stripReaderMetadata } from "./import/parse-cards.js?v=__BUILD__";
import { clearImportStaging, commitStagedImport, importDestinationFolder, importStaging, renderImportReview, setPendingImportFolder, stageImportSources, stageMarkdownImport } from "./import/staging.js?v=__BUILD__";
import { closeAllDeckTileMenus, createFolder, decksUnderFolder, setAllFoldersExpanded } from "./library/folder-tree.js?v=__BUILD__";
import { FOLDER_SEP, addKnownFolder, normalizeDeckCategory } from "./library/folders.js?v=__BUILD__";
import { appendCardToLocalLibraryDeck, loadDeckFromLibrary, pruneOrphanedDeckSnapshots, readLocalDeckIndex, runEscapedMathRepair, saveDeckToLibrary, saveDeckToLibrarySync, writeLocalDeckIndex } from "./library/local-library.js?v=__BUILD__";
import { categorizeSelectedMyDecks, deleteSelectedMyDecks, loadSelectedMyDecks } from "./library/my-decks-actions.js?v=__BUILD__";
import { hydrateMyDecksIcons } from "./library/my-decks-icons.js?v=__BUILD__";
import { setMyDecksCwd, setMyDecksDisplay, setMyDecksSort, setMyDecksView } from "./library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList, repaintMyDecks } from "./library/my-decks-render.js?v=__BUILD__";
import { selectedMyDecks, selectedMyFolders, updateMyDecksBulkBar } from "./library/my-decks-selection.js?v=__BUILD__";
import { resetActiveDeckAfterDelete } from "./library/tombstones.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection, jumpToNoteForCurrentCard, notesAnchorPlainText, onAnchorSourceDeck, scheduleNoteJump } from "./notes/anchors.js?v=__BUILD__";
import { scheduleNotesCaretCheck, scrollTextareaToOffset } from "./notes/caret.js?v=__BUILD__";
import { closeNoteLinkPicker, commitNoteLinkPicker, isNoteLinkPickerOpen, moveNoteLinkPicker, updateNoteLinkPicker } from "./notes/link-picker.js?v=__BUILD__";
import { followNoteLink, revealNoteHeading } from "./notes/note-links.js?v=__BUILD__";
import { commitNotesEditIfActive, discardNotesEditingForDeckSwap, enterNotesEditing, isNotesEditing, isProgrammaticNotesScroll, renderNotesViewPinned, setNotesScrolledSource } from "./notes/notes-view.js?v=__BUILD__";
import { findRawOffsetForRenderedPoint } from "./notes/raw-offset.js?v=__BUILD__";
import { rawOffsetForCurrentNotesScroll, scheduleReadingAnchorCapture } from "./notes/scroll-anchor.js?v=__BUILD__";
import { currentNotesSelectionMarkdown, hideNotesSelectionButton, pillSelectionCapture, scheduleNotesSelectionCheck } from "./notes/selection.js?v=__BUILD__";
import { closeNotesToc, isNotesTocOpen, notesTocHeadings, notesTocScrollFrame, scrollNotesEditToHeadingIndex, scrollNotesHeadingIntoView, setNotesTocScrollFrame, tocPushesNotes, toggleNotesToc, updateNotesTocActive } from "./notes/toc.js?v=__BUILD__";
import { renderMarkdown } from "./render/block-cache.js?v=__BUILD__";
import { applyDiagramTransform, beginDiagramPan, beginDiagramPinch, clampDiagramScale, closeDiagramModal, currentDiagramZoom, diagramLocalPoint, diagramPointers, pointerCenter, pointerDistance, zoomDiagramBy, zoomDiagramTo } from "./render/diagram-zoom.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "./render/enhance.js?v=__BUILD__";
import { findMathRanges, repairEscapedMathMarkdown } from "./render/math.js?v=__BUILD__";
import { markdownToSafeHtml } from "./render/preprocess.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "./render/tables.js?v=__BUILD__";
import { clearBrowserPersistence } from "./storage/deck-snapshot.js?v=__BUILD__";
import { allDeckSnapshotIds, clearAllDeckSnapshots, deckSnapshotCache, deckStoreChannel, deckStoreRequest, forEachDeckSnapshot, indexedDbUnavailable, initDeckStorage, journalPendingDeckWrites, pendingDeckWrites, readDeckSnapshot, requestPersistentStorage, scheduleDeckAutosave, setDeckStoreChannel, storagePersisted, touchDeckSnapshotCache, withDeckLock, writeDeckSnapshot } from "./storage/deck-store.js?v=__BUILD__";
import { LAST_BG_SYNC_PROBLEM_KEY, LAST_GLOBAL_SYNC_ERROR_KEY, LAST_GLOBAL_SYNC_KEY, LOCAL_DECKS_INDEX_KEY, LOCAL_DECK_TOMBSTONES_KEY, MISSING_DECK_WATCH_KEY, reportBackgroundSyncProblem } from "./storage/keys.js?v=__BUILD__";
import { isQuotaExceededError, lastSaveErrorWasQuota, persistWorkingDeck, setDeckAutosaveStorageFailed } from "./storage/quota.js?v=__BUILD__";
import { dropTombstonesForLiveCards, mergeCloudCardsIntoSnapshot } from "./sync/cards.js?v=__BUILD__";
import { formatRelativeTime, refreshSyncIndicatorBaseline, renderSyncCountdown, setSyncIndicator, updateDeckEmptyStatus } from "./sync/indicator.js?v=__BUILD__";
import { showNotesConflictModal } from "./sync/notes-conflict.js?v=__BUILD__";
import { reconcileAllDecks, reconcileInFlight } from "./sync/reconcile.js?v=__BUILD__";
import { closeTopmostOverlay, initBackGesture } from "./ui/back-gesture.js?v=__BUILD__";
import { showAuthenticatedUI, showLibraryFailedScreen, showLoginScreen, showSetupScreen } from "./ui/boot-screens.js?v=__BUILD__";
import { applyChromeCollapse, chromeFocusPinned, chromeMobileMedia, chromeScrollFrame, hasStudyTextSelection, isMobileChrome, measureChromeHeights, setChromeFocusPinned, setChromeScrollFrame, setFocusMode, trackChromeScroll } from "./ui/chrome.js?v=__BUILD__";
import { closeImportPanel, closeMyDecksPanel, dismissSwipeHint, editCurrentDeckCategory, editCurrentDeckTitle, openImportPanel, openMyDecksPanel } from "./ui/deck-header.js?v=__BUILD__";
import { setButtonLoading, setStatus, showConfirmModal, showPromptModal, showToast } from "./ui/feedback.js?v=__BUILD__";
import { goNavBack, recordNavHistory, refreshNavBack, suppressNavRecording } from "./ui/nav-history.js?v=__BUILD__";
import { anyModalOpen, lockPageScroll, unlockPageScroll } from "./ui/overlays.js?v=__BUILD__";
import { chooseDeckCategory } from "./ui/pickers.js?v=__BUILD__";
import { defaultStyleProfiles, styleDefaults } from "./ui/style-schema.js?v=__BUILD__";
import { applyActiveStyleSettings, applyStyleDensity, detectStyleProfile, handleStyleControlChange, loadLocalStyleSettings, normalizeStyleValue, resetStyleField, resetStyleProfile, setStyleProfiles, setStyleStatus, trackKeyboardInset } from "./ui/style-settings.js?v=__BUILD__";
import { styleMobileMedia, styleProfiles } from "./ui/style-tokens.js?v=__BUILD__";
import { configureMermaid, currentThemeId, renderThemeMenu, setTheme, setThemeMenuOpen } from "./ui/theme.js?v=__BUILD__";
import { FOCUS_MODE_KEY, setViewMode } from "./ui/view-mode.js?v=__BUILD__";

// Run `fn` once the DOM is parsed AND this module has finished evaluating.
//
// The second half is the part that is easy to get wrong, and it broke the app
// the moment this file became a module. The old shape was written inline at
// each call site:
//
//   if (document.readyState === "loading") addEventListener("DOMContentLoaded", fn);
//   else fn();
//
// As a classic <script> at the end of <body>, readyState is "loading" — the
// parser has not finished — so the listener branch always won and `fn` ran after
// the whole file had evaluated. A module script is deferred: it runs AFTER
// parsing, so readyState is already "interactive" and the else branch fires
// immediately, partway down the file. initToolbars() then reached a `const`
// declared 700 lines further on and threw "Cannot access
// 'highlightBackdropSync' before initialization" — a temporal-dead-zone error
// that aborted the rest of the module, on every load.
//
// queueMicrotask is what makes the else branch honest: it runs after the current
// synchronous execution — this entire module body — so every top-level binding
// is initialised, while still being earlier than any timer or event. The
// boot-click replay at the bottom of this file depends on that ordering: it
// hands its click to setTimeout, a macrotask, which is necessarily later.
function onDomReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else queueMicrotask(fn);
}


const sampleMarkdown = `::
## What is the derivative of $x^2$?

---

The derivative is $2x$.

$$
\\frac{d}{dx}x^2 = 2x
$$
::

::
## What does this Mermaid graph show?

---

It shows a simple spaced-repetition loop.

\`\`\`mermaid
flowchart LR
  A[Read note] --> B[Answer card]
  B --> C{Remembered?}
  C -->|Yes| D[Known]
  C -->|No| E[Review]
\`\`\`
::

::
## How do Markdown flashcards become cards?

---

Each \`::\` block becomes one flashcard. The \`---\` line separates the front from the back.
::`;


export const state = {
  deckId: null,
  localDeckId: null,
  cards: [],
  masterCards: [],
  statusById: {},
  // Per-card subject label for quick_notes cards (id -> category id). Parallel
  // to statusById; only populated when the active deck is the quick_notes deck.
  categoryById: {},
  // Managed category set for the quick_notes deck: [{ id, name, color }].
  quickNoteCategories: [],
  // The open deck's meta bag, carried forward from load so per-deck fields
  // (quick_notes categories, a synced reading position, …) survive autosave.
  meta: {},
  previewCard: null,
  deckTitle: "",
  deckCategory: "Uncategorized",
  notes: "",
  viewMode: "cards",
  // My Decks library UI preferences (persisted per device).
  myDecksView: (() => { try { const v = localStorage.getItem("flashcards_mydecks_view_v1"); return ["grid", "folder", "tree"].includes(v) ? v : "folder"; } catch (_) { return "folder"; } })(),
  myDecksDisplay: (() => { try { const v = localStorage.getItem("flashcards_mydecks_display_v1"); return ["tiles", "list"].includes(v) ? v : "list"; } catch (_) { return "list"; } })(),
  myDecksSort: (() => { try { const v = localStorage.getItem("flashcards_mydecks_sort_v1"); return ["recent", "title-asc", "title-desc", "updated-desc", "created-desc", "size-desc"].includes(v) ? v : "recent"; } catch (_) { return "recent"; } })(),
  // Always start at Home (root) on app open, even though the current folder
  // is persisted per navigation below — the persisted value is only there so
  // helpers like currentMyDecksFolder() have something to read mid-session.
  myDecksCwd: "",
  myDecksSearch: "",
  sourceTitle: "",
  importTitleHint: "",
  results: {
    known: [],
    review: []
  },
  current: 0,
  known: 0,
  review: 0,
  flipped: false,
  dragStartX: 0,
  dragStartY: 0,
  dragCurrentX: 0,
  dragCurrentY: 0,
  dragPointerId: null,
  dragPointerType: "",
  dragCaptured: false,
  dragStartTime: 0,
  dragLastX: 0,
  dragLastY: 0,
  dragLastTime: 0,
  dragging: false,
  dragMoved: false,
  suppressClickUntil: 0,
  transitionToken: 0,
  styleSettings: {},
  styleProfiles: {
    desktop: {},
    mobile: {}
  },
  activeStyleProfile: "desktop",
  styleEditProfile: "desktop",
  styleEditProfileFollowsDevice: true,
  styleTouched: false,
  stylePanelScrollY: 0,
  stylePanelTouchY: 0
};


       // grid | folder | tree
 // tiles | list
         // Folder-view path


// ── Per-card sync bookkeeping ───────────────────────────────────────────────
// Deck-level last-write-wins used to be the whole conflict story: a pull
// replaced the local snapshot wholesale, so every card this device had changed
// while offline was destroyed — silently, unrecoverably — the moment another
// device touched the same deck afterwards. Two device-local fields on each
// snapshot card are what let the pull MERGE instead of overwrite:
//
//   dirty     — changed here and not yet confirmed present in the cloud
//   updatedAt — when this device last changed it
//
// Together they encode the sync base without storing a second full snapshot per
// deck (localStorage is already the binding constraint here — see
// isQuotaExceededError / deckAutosaveStorageFailed). Neither field is ever sent
// to the cloud; they describe this device's relationship to it.
//
// Snapshots written by older builds carry neither: a missing `dirty` reads as
// false and a missing `updatedAt` falls back to the deck's own timestamp, which
// reduces the merge to exactly the old take-the-cloud behaviour for decks that
// predate this change.


// ── Notes conflicts: reaching, and answering, one ──────────────────────────
// A conflict is a purely local condition — a stashed copy of the notes this
// device lost, sitting beside the deck under NOTES_CONFLICT_SUFFIX. The status
// pills (deckSyncStatus, setSyncIndicator) report it, and both now open the
// resolver below.
//
// They previously did not, and there was no other way in: the only "Restore my
// notes" button lived inside the post-sync report, which is built from the log
// of ONE reconcile. Running "Sync Now" again — exactly what the pill told the
// reader to do — found the deck already matching, logged nothing, and rendered
// no report at all, while a background sync's report only ever painted on the
// welcome screen and was gone on reload. So the pill said "notes conflict" and
// offered nothing, permanently. The stash was intact the whole time; it just
// had no door.


const swipeConfig = {
  intentDistance: 12,
  intentRatio: 1.12,
  commitRatio: 1.18,
  minCommitDistance: 66,
  maxCommitDistance: 142,
  widthCommitRatio: 0.18,
  flickDistance: 34,
  flickVelocity: 0.42,
  resistance: 0.74,
  maxPreviewOffset: 128,
  // A finger that has rested this long without travelling is pressing, not
  // swiping — Android's long-press selection is about to fire. See updateSwipe.
  longPressGraceMs: 340
};


export let draggedAllCardId = "";

// Setter: an imported binding is read-only, and the All Cards drag handlers in cards/all-cards-edit.js set it.
export function setDraggedAllCardId(value) {
  draggedAllCardId = value;
}

marked.setOptions({
  breaks: true,
  gfm: true,
  mangle: false,
  headerIds: false
});


 // confident: this is what the block is
 // …and the winner must beat the runner-up by this
 // plausible: one signal, uncontested


 // enough signal; keeps long blocks cheap


if (window.Prism?.plugins?.autoloader) {
  Prism.plugins.autoloader.languages_path = "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/";
}


// (applyCurrentStyleSettings lived here. It was the "Apply" button's handler,
// and the button is gone: every control already applied live, so pressing it
// re-ran what had happened on the last keystroke. Its one distinct effect —
// the { force: true } re-fit — is now scheduleStyleRefit, off the edit path.)


// ── Unified deck access ────────────────────────────────────────────────────
// Every My Decks feature that needs full deck content (export, combined bulk
// load) goes through myDeckPayload so it behaves identically for on-device
// decks (offline included) and cloud-only decks: the local snapshot is
// preferred, the cloud is the fallback.


// ── Selection & bulk-action bar ────────────────────────────────────────────


// ── Category editing (works for local, synced, and cloud-only decks) ───────


// ── Rename (local library + immediate cloud rename when reachable) ─────────


// ── Exports (single deck, selected decks, everything) ──────────────────────


// ══════════════════════════════════════════════════════════════════════════
// Library Backup (.zip) + Safe Restore
//
// Backup packs every deck (cards, statuses, notes, category, timestamps) into a
// versioned, self-describing zip. Restore reads that archive (or a legacy JSON
// bundle), diffs each deck against the CURRENT device state without writing
// anything, shows a preview, and only on confirm applies an additive merge:
// it adds missing decks/cards and applies backup edits, but NEVER deletes a
// local-only deck or card. A full safety backup is auto-downloaded first.
// Reuses deckPayloadSnapshot / calculateSyncDiff / syncTextChanged / the local
// library index+snapshot model so the on-disk format is unchanged.
// ══════════════════════════════════════════════════════════════════════════


// ── Bulk actions ───────────────────────────────────────────────────────────


// ── Rows ───────────────────────────────────────────────────────────────────


 // node -> run(batch)
 // scroll root -> IntersectionObserver
 // live nodes with queued work, for flushing
 // came into view, not yet run — see drainReadyDeferredWork


 // view -> { generation, source, blocks: [{key, nodes}] }
 // view -> number, so a superseded render can bail

 // container -> rAF id


// ── No editor guides ───────────────────────────────────────────────────────
//
// The raw editor draws NOTHING over the text. A "typewriter" pair of marks used
// to live here — a dashed hairline on notesReadingLineOffset and a tinted band
// on the caret's row — and both are gone. The band had to be re-measured against
// the highlight mirror on every frame of every scroll, which is what made long
// notes stutter; the hairline was cheap but read as a stray rule across the
// page, pinned to an arbitrary height, with nothing to explain it.
//
// notesReadingLineOffset itself stays. It is arithmetic, not a mark: every jump
// still targets that line and every scroll sampler still reads from it, so a
// raw<->rendered round trip lands where you left. It is simply invisible again.


el.notesView?.addEventListener("scroll", () => {
  // A scroll the app performed itself (the raw<->rendered restore, a TOC jump)
  // is not the reader moving, and re-deriving an anchor from it would just
  // re-measure the position we were asked to go to.
  if (isProgrammaticNotesScroll()) return;
  scheduleReadingAnchorCapture();
}, { passive: true });

el.notesView?.addEventListener("click", (event) => {
  // >= 3, not === 3, matching the card faces: a fast fourth click is still a
  // "jump me to this text" gesture, and an exact test made it silently do
  // nothing.
  if (event.detail < 3 || isNotesEditing()) return;
  if (event.target.closest("button, a")) return;
  // ?? the reading-line resolver, not a bare null: an unmatchable click point
  // (a widget, a phrase the snippet search can't place) would otherwise open the
  // editor at offset 0, which is the same "took me to the top of the note"
  // failure the toggle had.
  const at = findRawOffsetForRenderedPoint(el.notesView, state.notes, event.clientX, event.clientY);
  enterNotesEditing(at ?? rawOffsetForCurrentNotesScroll());
});

// Bumped on every deferred switch so a superseded paint (two fast taps on the
// toggle) is dropped rather than rendering a view that is no longer chosen.
export let viewModePaintToken = 0;


el.editNotesBtn?.addEventListener("click", () => {
  if (isNotesEditing()) commitNotesEditIfActive();
  else enterNotesEditing(rawOffsetForCurrentNotesScroll());
});

el.notesEdit?.addEventListener("input", () => {
  state.notes = el.notesEdit.value;
  // Typing edits the note you're already in — it doesn't open a new one. Kept
  // in step here so leaving the editor for the cards and coming back doesn't
  // read as "different note" and throw away your place.
  setNotesScrolledSource(state.notes);
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  // Writing at the end of the note must not push what you just typed off the
  // bottom of the box. See keepNotesCaretVisible.
  scheduleNotesCaretCheck();
  // "[[" anywhere on the current line opens the note picker.
  updateNoteLinkPicker();
  scheduleDeckAutosave();
});

// Moving the caret with the arrow keys or a click fires no input event, but it
// can just as easily take you out of (or into) a "[[…" the picker cares about.
el.notesEdit?.addEventListener("keyup", (event) => {
  if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") updateNoteLinkPicker();
  scheduleNotesCaretCheck();
});
// No caret check here: a click adds no text, so it cannot be what pushed the
// caret under the bottom edge. (There is deliberately no `scroll` listener on
// the editor either — see scheduleNotesCaretCheck.)
el.notesEdit?.addEventListener("click", () => updateNoteLinkPicker());
el.notesEdit?.addEventListener("focus", () => scheduleNotesCaretCheck());

el.viewModeToggle?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view-mode]");
  if (button) setViewMode(button.dataset.viewMode, { deferRender: true });
});

// (No drawer listener for the notes view: the Cards / Notes / Highlights toggle
// above is the only way in, and it's always on screen when a deck is loaded.)


 // px of downward travel before folding away
 // px back up before it returns — deliberately
 // within this much of the top, always show
 // the CSS collapse transition (220ms) plus a
                              // couple of frames. Was 320 with a comment
                              // claiming it matched — 100ms of extra dead time
                              // in which a genuine upward flick right after a
                              // toggle was thrown away.


try {
  setChromeFocusPinned(localStorage.getItem(FOCUS_MODE_KEY) === "1");
} catch (_) {
  setChromeFocusPinned(false);
}

// ── Measuring what the collapse actually has to travel ─────────────────────
// The CSS animates `max-height` (not `height`) because the appbar's natural
// height depends on how many lines the deck title wraps to — there is no fixed
// value to animate from. That was implemented as a hard-coded 300px, and it is
// the reason focus mode never felt seamless: the real appbar is ~45-70px tall,
// so a 300px→0 tween spends roughly its first 80% shrinking a box that is
// still taller than its own content. Nothing moves, then everything moves at
// once in the last few frames — a stall followed by a snap, on both the way in
// and the way out.
//
// So measure it. The observer below publishes the live heights as custom
// properties and the CSS animates between the real value and 0, which makes
// the 220ms buy 220ms of visible motion.


if (typeof ResizeObserver === "function") {
  const chromeSizeObserver = new ResizeObserver(() => measureChromeHeights());
  const appbarEl = document.querySelector(".appbar");
  if (appbarEl) chromeSizeObserver.observe(appbarEl);
  if (el.viewModeToggle) chromeSizeObserver.observe(el.viewModeToggle);
}


// Capture phase on document, because `scroll` doesn't bubble: this one listener
// covers every scroller in the study area (rendered notes, the raw-notes
// textarea, both card faces) without each needing to be wired up — and stays
// correct when a new one is added. Scoped to .study-layout so the full-screen
// overlays (All Cards, Quick Notes board), which cover the appbar anyway, don't
// leave the chrome collapsed behind them.
document.addEventListener(
  "scroll",
  (event) => {
    // Frame gate FIRST. A fling delivers scroll events faster than it delivers
    // frames, and every one of the extra ones used to pay for a closest() walk
    // up the tree before being thrown away here anyway.
    if (chromeScrollFrame) return;
    if (chromeFocusPinned || !isMobileChrome()) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".study-layout")) return;
    setChromeScrollFrame(requestAnimationFrame(() => {
      setChromeScrollFrame(0);
      trackChromeScroll(target);
    }));
  },
  true,
);


el.focusModeBtn?.addEventListener("click", () => setFocusMode(!chromeFocusPinned));

// Rotating to landscape (or resizing a desktop window down) crosses the mobile
// breakpoint, which turns the scroll-driven half on or off; re-evaluate.
chromeMobileMedia?.addEventListener("change", applyChromeCollapse);

// Restore a remembered focus-mode pin before the first paint, then arm the CSS
// transitions a frame later — otherwise every launch in focus mode would open
// with the header up and visibly fold it away.
applyChromeCollapse();
requestAnimationFrame(() => document.body.classList.add("chrome-ready"));


el.notesTocBtn?.addEventListener("click", toggleNotesToc);
el.notesTocCloseBtn?.addEventListener("click", closeNotesToc);

el.notesTocList?.addEventListener("click", (event) => {
  const link = event.target.closest(".notes-toc-link");
  if (!link) return;
  event.preventDefault();
  const index = Number(link.dataset.tocIndex);
  // In raw/edit mode the rendered view is hidden — scroll the textarea instead.
  if (isNotesEditing()) {
    scrollNotesEditToHeadingIndex(index);
  } else {
    const heading = notesTocHeadings[index];
    scrollNotesHeadingIntoView(heading);
    heading?.classList.add("notes-heading-flash");
    setTimeout(() => heading?.classList.remove("notes-heading-flash"), 1200);
  }
  // Only when the drawer overlays the notes: it has to step out of the way to
  // show you what you just jumped to. When it pushes instead, the destination
  // is already fully visible and closing would throw away the contents list
  // you are working through.
  if (!tocPushesNotes()) closeNotesToc();
});

el.notesView?.addEventListener(
  "scroll",
  () => {
    // Checked here as well as inside updateNotesTocActive so a closed drawer
    // doesn't even cost a scheduled frame — which is the state it is in for
    // almost all reading.
    if (!isNotesTocOpen()) return;
    if (notesTocScrollFrame) return;
    setNotesTocScrollFrame(requestAnimationFrame(() => {
      setNotesTocScrollFrame(0);
      updateNotesTocActive();
    }));
  },
  { passive: true }
);

// No private Escape listener for the TOC drawer: it is an entry in
// OVERLAY_LAYERS, which gives it the one global Escape handler in correct
// stack order plus the hardware Back key. Click-outside stays local, since
// that is genuinely this drawer's own behaviour and not part of any stack.

// Clicking anywhere outside the open drawer (including the notes themselves)
// dismisses the TOC. The toggle button is excluded so its own click still
// toggles rather than close-then-reopen.
//
// Only while the drawer OVERLAYS the notes, though. Once it pushes them aside
// it is covering nothing, and dismiss-on-outside-click would mean that clicking
// into the notes to read — the entire reason you opened the contents — shut the
// contents. Use the ☰ or ✕ to close it there.
document.addEventListener("pointerdown", (event) => {
  if (!el.notesTocDrawer?.classList.contains("is-open")) return;
  if (tocPushesNotes()) return;
  if (el.notesTocDrawer.contains(event.target)) return;
  if (el.notesTocBtn?.contains(event.target)) return;
  closeNotesToc();
});

// ── Select text in notes OR a card (rendered OR raw) → make a flashcard ──
// Highlighting text/images in the notes preview, a card's question/answer
// preview, or a text range in any of their raw markdown editors, floats a
// "+ Make card · N words" pill next to the selection; tapping it opens the
// frame-card modal where the captured selection (serialized back to
// markdown, so images and math survive) is previewed as the ANSWER and the
// user frames the question.
// Works offline — the new card syncs with the normal flow.


// ── Card ⇄ Notes linking ───────────────────────────────────────────────────
// A card distilled from a notes selection remembers where it came from
// (captureNotesAnchor at creation time), and offers a "Go to notes" button
// that switches to the notes view and scrolls/flashes that exact spot
// (jumpToNoteForCurrentCard). The link survives note edits and cloud round-
// trips: an explicit anchor is stored on the card when possible, and cards
// that lost it (e.g. reloaded from a pre-feature cloud row) fall back to
// matching their answer text against the current notes.


 // offset of the "[[" that opened it, or -1


// Capture phase, and before the editor's own handlers: while the picker is up
// these keys belong to it. Arrow keys would otherwise move the caret out from
// under the query, and Enter would break the line being typed.
el.notesEdit?.addEventListener("keydown", (event) => {
  if (!isNoteLinkPickerOpen()) return;
  if (event.key === "ArrowDown") { event.preventDefault(); moveNoteLinkPicker(1); return; }
  if (event.key === "ArrowUp") { event.preventDefault(); moveNoteLinkPicker(-1); return; }
  if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); commitNoteLinkPicker(); return; }
  if (event.key === "Escape") {
    event.preventDefault();
    // Stopped here so the global Escape handler doesn't also close whatever is
    // behind the editor — dismissing the popup is the whole of what was meant.
    event.stopPropagation();
    closeNoteLinkPicker();
  }
}, true);

el.notesEdit?.addEventListener("blur", () => {
  // Deferred: a pointerdown on a picker row blurs the textarea before the row's
  // own handler runs, and closing here immediately would delete the row that is
  // in the middle of being chosen.
  setTimeout(() => {
    if (document.activeElement !== el.notesEdit) closeNoteLinkPicker();
  }, 150);
});

// ── Clicking a reference ────────────────────────────────────────────────────
// Coexists with the triple-click-to-edit handler on the same element: that one
// already ignores anything inside an <a>, and this one ignores everything that
// isn't one.
el.notesView?.addEventListener("click", (event) => {
  const noteLink = event.target.closest?.("a.note-link");
  if (noteLink) {
    event.preventDefault();
    followNoteLink(noteLink);
    return;
  }
  // In-page anchors. enhanceRenderedMarkdown no longer forces these to open in
  // a new tab, so something has to actually perform the jump.
  const inPage = event.target.closest?.('a[href^="#"]');
  if (inPage) {
    event.preventDefault();
    revealNoteHeading(decodeURIComponent(inPage.getAttribute("href").slice(1)));
  }
});

// Keyboard equivalent — these anchors have no href, so Enter does nothing on
// its own.
el.notesView?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const noteLink = event.target.closest?.("a.note-link");
  if (!noteLink) return;
  event.preventDefault();
  followNoteLink(noteLink);
});

document.addEventListener("selectionchange", scheduleNotesSelectionCheck);

// Pay back a question refit that fitLiveQuestion skipped to avoid reflowing text
// out from under a live selection.
document.addEventListener("selectionchange", () => {
  if (questionFitDeferredBySelection && !hasStudyTextSelection()) scheduleLiveQuestionFit();
});


// <textarea> selections don't fire the document "selectionchange" event
// reliably across browsers, so raw/edit mode is covered separately via
// direct mouse/keyboard selection events on each editor itself.
[el.notesEdit, el.questionEdit, el.answerEdit].forEach((edit) => {
  edit?.addEventListener("mouseup", scheduleNotesSelectionCheck);
  edit?.addEventListener("keyup", scheduleNotesSelectionCheck);
  edit?.addEventListener("select", scheduleNotesSelectionCheck);
  edit?.addEventListener("scroll", hideNotesSelectionButtonUnlessPinned, { passive: true });
});

el.makeCardFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  // preventDefault keeps the selection from dissolving mid-tap.
  event.preventDefault();
  event.stopPropagation();
  const text = el.makeCardFromSelectionBtn.dataset.selectionText || "";
  // Capture the note anchor while the selection is still live, before we clear it.
  const anchor = captureNotesAnchor();
  hideNotesSelectionButton();
  window.getSelection()?.removeAllRanges();
  createCardFromNotesSelection(text, anchor);
});


// The floater's cloze button: hide the selection as a fill-in-the-blank, in
// place. Works whether the selection is in a rendered view or the raw editor.
el.makeClozeFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const target = pillActionTarget();
  if (target?.kind === "rendered") {
    makeClozeFromSelection(renderTargetConfig(target.name), target.sel);
  } else if (target?.kind === "editing") {
    clozeTextareaSelection(target.target);
  }
  hideNotesSelectionButton();
});

// The floater's quick-note button: pin the selection to the quick_notes deck —
// same destination as the render-toolbar 📌 and the raw-editor toolbar button.
el.pinQuickNoteFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  // preventDefault keeps the selection alive so we can read its markdown + anchor.
  event.preventDefault();
  event.stopPropagation();
  const text = currentNotesSelectionMarkdown() || pillSelectionCapture?.markdown || "";
  // Capture the source location (deck + note offset) while the selection is
  // still live, so the pinned card can offer a "Go to notes" jump back.
  const anchor = captureSourceAnchor();
  const button = el.pinQuickNoteFromSelectionBtn;
  hideNotesSelectionButton();
  window.getSelection()?.removeAllRanges();
  saveQuickNote(text, button, anchor);
});


// The floater's highlight button: mark the selection with the shared last-used
// swatch. Works on every face (notes, question, answer) in BOTH modes —
// rendered via the source-search driver, raw via the textarea wrap above.
el.highlightSelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  applyPillHighlight(renderFormatDefaults.highlight);
});


el.highlightSelectionMenuBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  buildPillHighlightMenu();
  const willOpen = el.highlightSelectionMenu.hidden;
  el.highlightSelectionMenu.hidden = !willOpen;
  el.highlightSelectionMenuBtn.setAttribute("aria-expanded", String(willOpen));
});

el.highlightSelectionMenu?.addEventListener("pointerdown", (event) => {
  const btn = event.target.closest("[data-pill-highlight]");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const value = btn.dataset.pillHighlight;
  // "clear" is an action, not a default — setRenderDefault ignores it, and
  // highlightToggleInSource reads it as "strip the marks off this selection".
  setRenderDefault("highlight", value);
  applyPillHighlight(value);
});

// The floater's eraser button: delete the selection from the source — every
// face, both modes (rendered via eraseNotesSelection's locate-then-splice,
// raw via a plain textarea splice).
el.eraseNotesSelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const target = pillActionTarget();
  if (target?.kind === "rendered") {
    eraseNotesSelection(renderTargetConfig(target.name), target.sel);
  } else if (target?.kind === "editing") {
    eraseTextareaSelection(target.target);
  }
  hideNotesSelectionButton();
});


el.extractNoteFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  // pointerdown, not click: a click would have already destroyed the selection
  // this reads. Same reason as every other button in this strip.
  event.preventDefault();
  event.stopPropagation();
  extractSelectionToNote();
});

[el.notesView, el.questionView, el.answerView].forEach((view) => {
  view?.addEventListener("scroll", hideNotesSelectionButtonUnlessPinned, { passive: true });
});

// The persistent "make a card" control (the floating pill only exists while a
// selection is live) used to be a ➕ in each face header, beside the mode
// toggles it had nothing to do with. It now lives in the selection strip with
// the other selection tools — see the `make-card` action in
// handleRenderToolbarAction (rendered view) and the edit-toolbar handler (raw).

// ── Make a cloze from a rendered-view text selection ───────────────────────
// Clozes ({{…}}) can be authored in the raw editor, but it's far quicker to
// highlight the word(s) you want to hide right in the rendered card or notes
// and press the header "make cloze" button ([…]). We find the highlighted text
// in the underlying markdown SOURCE and wrap it in {{ }} — or unwrap it if it
// was already a cloze (a toggle, matching the editor's [{…}] button) — then
// re-render and save. No need to drop into edit mode.


// The standalone per-face "[…] make cloze" buttons were folded into the inline
// render toolbar's cloze control (data-render-action="cloze" → the same
// makeClozeFromSelection driver), so there's no separate button to wire here.

// ── Rendered-view formatting toolbar ───────────────────────────────────────
// A persistent row (bold/italic/underline/strike/code, a text-colour and a
// highlight split-button, and cloze) sits above each rendered card face and the
// notes preview. It formats the current text selection WITHOUT entering raw-edit
// mode: it locates the selection in the markdown source (occurrence-aware, so a
// repeated word is styled in place) and reuses the exact same transform
// functions as the raw editor's toolbar (toggleWrap, applyInlineStyleProperty,
// …), then re-renders and autosaves.


onDomReady(initRenderToolbars);


// pointerdown (not click) so preventDefault preserves the live selection.
// Host is any [data-render-target] ancestor rather than .render-toolbar
// specifically: the notes header carries the target too, so its cloze /
// make-card / pin buttons route through this same handler without needing a
// second, near-identical listener. Nearest ancestor wins, so a button inside
// the render toolbar still resolves to the toolbar (which owns the colour menus).
document.addEventListener("pointerdown", (event) => {
  const btn = event.target.closest("[data-render-action], [data-render-color]");
  const host = btn?.closest("[data-render-target]");
  if (btn && host) {
    event.preventDefault();
    event.stopPropagation();
    handleRenderToolbarAction(btn, host);
    return;
  }
  // A pointer down anywhere outside an open split control dismisses its menu.
  if (!event.target.closest(".render-split")) closeAllRenderMenus();
});

// ── Editable images in rendered Notes: corner-drag resize ─────────────────
// state.notes is a plain markdown string, so resizing works by tokenizing it
// into top-level blocks with marked.lexer() (each token's `.raw` is the exact
// source slice), rewriting the one image block, and rejoining `.raw` strings
// back into state.notes — safe inside arbitrary surrounding markdown (lists,
// quotes, code fences) because marked already knows the real block boundaries.
//
// A resized image is persisted as a raw <img> HTML block/inline element
// carrying an absolute pixel width (marked/DOMPurify pass it through
// untouched; DOMPurify's ADD_ATTR allows style/class). Untouched
// `![alt](url)` images are left alone. A standalone image (its own
// paragraph) or one sharing a paragraph with other text are both directly
// resizable in place — every rendered <img> gets wrapped in a block-level
// .diagram-shell, so it always occupies its own visual row regardless of
// markdown-source block boundaries. Only an image buried inside a list or
// blockquote still needs the one-click "move to own line" promote button,
// since extracting it means splicing its enclosing token, not just swapping
// an inline slice. Images are always centered.


// ── Import — one vocabulary, one flow ───────────────────────────────────────
//
// Recall has exactly two kinds of content, and every import produces one or
// both of them:
//
//   deck  — what you open from My Decks. A title, a category (the folder it
//           lives in), ONE notes document, and any number of cards.
//   notes — that single freeform Markdown document (the deck's "Notes" view).
//   cards — question / answer pairs (the deck's "Cards" view).
//
// There is no third thing: files that other apps call slides, pages or
// documents all arrive here as notes, as cards, or as both. The import panel
// says which one it is and lets you change it BEFORE anything is created —
// importing a plain Markdown page used to silently shred it into one card per
// heading, because the parser had no way to say "this is a document, not a
// deck of cards".


// ── Import review UI ────────────────────────────────────────────────────────


// ── Committing a staged import ──────────────────────────────────────────────


try {
  setDeckStoreChannel(typeof BroadcastChannel === "function" ? new BroadcastChannel("recall-deck-store") : null);
} catch {
  setDeckStoreChannel(null); // not supported — single-tab behaviour, as before
}
if (deckStoreChannel) {
  deckStoreChannel.onmessage = (event) => {
    const { type, id } = event.data || {};
    if (indexedDbUnavailable) return;
    // The library was wiped elsewhere (account switch / "Clear this device").
    // Keeping a full cache here would let this tab's next write re-persist
    // decks that were just deleted — or, after an account switch, write the
    // previous account's decks into the new one's library.
    if (type === "clear") {
      deckSnapshotCache.clear();
      pendingDeckWrites.clear();
      return;
    }
    if (!id) return;
    // A write of our own is still in flight for this deck: it is the newer
    // intent, and it will broadcast in turn once it commits. Refreshing here
    // would just install the other tab's copy over ours moments before we
    // overwrite it again.
    if (pendingDeckWrites.has(String(id))) return;
    if (type === "delete") {
      deckSnapshotCache.delete(String(id));
      return;
    }
    deckStoreRequest("readonly", (store) => store.get(String(id)))
      .then((row) => {
        if (pendingDeckWrites.has(String(id))) return; // raced with a local write
        if (row && row.snapshot) {
          deckSnapshotCache.set(String(id), row.snapshot);
          touchDeckSnapshotCache(String(id));
        } else {
          deckSnapshotCache.delete(String(id));
        }
      })
      .catch((error) => console.warn("Could not refresh a deck snapshot after another tab changed it", id, error));
  };
}


// Delegated once rather than re-bound on every pill repaint (setSyncIndicator
// rewrites textContent constantly).
el.syncIndicator?.addEventListener("click", () => {
  const action = el.syncIndicator.dataset.action;
  if (action === "signin") showLoginScreen();
  else if (action === "notes-conflict") showNotesConflictModal(el.syncIndicator.dataset.conflictDeck);
});


// ---------------------------------------------------------------------------
// Two-way cloud mirror (last-write-wins per deck, by `updated_at` timestamp).
// The device keeps a full local copy of every cloud deck so the PWA works
// offline; when connectivity returns each deck is reconciled by comparing the
// local library's `updatedAt` against the cloud's `updated_at`.
// ---------------------------------------------------------------------------


// Bulk counterpart of exportNotesPdf() — combines every selected deck's notes
// into one print-preview document instead of the single active deck's own.
export async function exportNotesFlatPdf(payloads, { fileBaseName, title }) {
  const sections = payloads.map((payload) => ({
    title: payload.deck.title || "Untitled",
    category: payload.deck.category,
    notes: payload.deck.notes || ""
  }));
  if (!sections.some((section) => section.notes.trim())) {
    setStatus("No notes to export as PDF.", "error");
    return;
  }

  setStatus(`Preparing ${title} notes PDF...`);
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = fileBaseName;
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesFlatPrintDocument(title, sections);
    // Must precede configureMermaid("print"): with mermaid loaded on demand,
    // an unloaded library makes that call a silent no-op, and the
    // enhanceRenderedMarkdown below would then load mermaid itself and
    // configure it with the SCREEN theme — exporting every diagram in the
    // dark palette onto white paper.
    await ensureMermaid();
    configureMermaid("print");
    try {
      await enhanceRenderedMarkdown(el.printRoot);
    } finally {
      configureMermaid(currentThemeId());
    }
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    installPdfPrintStyle();
    const opened = printPreparedDocument();
    setStatus(opened
      ? `Opening ${title} notes PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the notes PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("Notes PDF export failed", error);
    setStatus("Could not prepare the notes PDF export.", "error");
  } finally {
    closePrintPreview();
  }
}


// ── Real .docx export ───────────────────────────────────────────────────
// Word's HTML filter never evaluates var(...), and — separately, the actual
// root cause of the "Read Error" image placeholder — it's notoriously
// unable to decode `data:` base64 image URIs at all, even ones a real
// browser renders fine. An HTML-file-wearing-a-.doc-extension can never be
// fully reliable for embedded images because of this. A .docx, on the other
// hand, is just a zip archive of XML parts plus real media files — the
// format Word actually reads natively — so this builds one from scratch:
// a small hand-rolled (uncompressed/STORE) zip writer, and an HTML-DOM to
// WordprocessingML converter that walks the exact same rendered/enhanced
// DOM the HTML and PDF exports use (headings, paragraphs, lists, tables,
// code blocks, links, bold/italic/underline/strike, and images/diagrams —
// each raster-decoded once via canvas and embedded as a real media part
// referenced by relationship id, never as inline base64 text).


// Resolves any valid CSS color expression (a plain hex custom property, a
// var() reference, or a color-mix() expression) to a concrete hex string by
// actually applying it to a real CSS property on a throwaway element and
// reading back the browser's resolved value — custom properties don't
// evaluate functions like color-mix() themselves (they're just substituted
// token text), but a real used property always does.
function resolveCssColorValue(expression, fallbackHex) {
  if (!expression) return fallbackHex;
  const probe = document.createElement("div");
  probe.style.display = "none";
  probe.style.color = expression;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  // Plain rgb()/rgba() — 0–255 integers.
  const rgbMatch = resolved.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
    return [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // A color-mix() result (used by --print-question/--print-accent-strong)
  // resolves in Chromium to the CSS Color 4 `color(srgb r g b)` syntax —
  // 0–1 floats, not 0–255 — which the rgb() regex above never matches, so
  // this silently fell back to the hardcoded default for every theme.
  const colorFnMatch = resolved.match(/color\([a-z0-9-]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (colorFnMatch) {
    const [r, g, b] = colorFnMatch.slice(1, 4).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n) * 255))));
    return [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  return fallbackHex;
}

// A Word document page is always white paper — reusing the app's live
// theme colors verbatim would be unreadable for any dark theme (near-white
// text on a white page). The app already solves exactly this problem for
// the Cornell PDF export with a fixed, always-print-safe --print-* palette
// (only its accent tracks the live theme); the .docx export reuses that
// same palette rather than inventing its own.
function docxThemeFromPrintVars() {
  const computed = getComputedStyle(document.documentElement);
  const raw = (name) => computed.getPropertyValue(name).trim();
  const resolve = (name, fallbackHex) => resolveCssColorValue(raw(name), fallbackHex);
  return {
    card: resolve("--print-surface", "FFFFFF"),
    panel2: resolve("--print-question", "F0EEE7"),
    text: resolve("--print-text", "17201C"),
    muted: resolve("--print-muted", "56645F"),
    line: resolve("--print-line", "B9C9C5"),
    accent: resolve("--print-accent", "16796C"),
    accentStrong: resolve("--print-accent-strong", "0D5E53")
  };
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCX_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
${[0, 1, 2, 3].map((lvl) => `<w:lvl w:ilvl="${lvl}"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:pPr><w:ind w:left="${720 + lvl * 720}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>`).join("\n")}
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
${[0, 1, 2, 3].map((lvl) => `<w:lvl w:ilvl="${lvl}"><w:numFmt w:val="decimal"/><w:lvlText w:val="%${lvl + 1}."/><w:pPr><w:ind w:left="${720 + lvl * 720}" w:hanging="360"/></w:pPr></w:lvl>`).join("\n")}
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function buildDocxStylesXml(theme) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:color w:val="${theme.text}"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="${theme.text}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="${theme.text}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="${theme.text}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="${theme.text}"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="${theme.accentStrong}"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
}

function buildDocxCoreXml(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>Recall</dc:creator>
<cp:lastModifiedBy>Recall</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

const DOCX_APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Recall</Application></Properties>`;

function buildDocxDocumentRelsXml(media, hyperlinks) {
  const mediaRels = media.map(({ rId, name }) => `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`).join("\n");
  const linkRels = hyperlinks.map(({ rId, url }) => `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${mediaRels}
${linkRels}
</Relationships>`;
}

function buildDocxDocumentXml(bodyBlocksXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${bodyBlocksXml}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
}

// Ties the whole pipeline together: mounts+renders+embeds bodyHtml (same
// as the HTML/PDF exports), rasterizes its images/diagrams to PNG media
// parts, walks the DOM into WordprocessingML, and zips it all into a real
// .docx byte stream.
export async function buildDocxBytes(bodyHtml, title) {
  const failedImageCount = await prepareExportRoot(bodyHtml);
  const { media, elementMedia } = await collectDocxMedia(el.printRoot);
  const theme = docxThemeFromPrintVars();
  const ctx = createDocxRenderContext(elementMedia, theme);
  const bodyBlocksXml = childBlocks(el.printRoot, ctx).join("\n");
  finishExportRoot();

  const documentXml = buildDocxDocumentXml(bodyBlocksXml);
  const documentRelsXml = buildDocxDocumentRelsXml(media, ctx.hyperlinks);
  const stylesXml = buildDocxStylesXml(theme);
  const coreXml = buildDocxCoreXml(title);

  const files = [
    { name: "[Content_Types].xml", data: utf8Bytes(DOCX_CONTENT_TYPES) },
    { name: "_rels/.rels", data: utf8Bytes(DOCX_ROOT_RELS) },
    { name: "docProps/core.xml", data: utf8Bytes(coreXml) },
    { name: "docProps/app.xml", data: utf8Bytes(DOCX_APP_XML) },
    { name: "word/document.xml", data: utf8Bytes(documentXml) },
    { name: "word/styles.xml", data: utf8Bytes(stylesXml) },
    { name: "word/numbering.xml", data: utf8Bytes(DOCX_NUMBERING_XML) },
    { name: "word/_rels/document.xml.rels", data: utf8Bytes(documentRelsXml) },
    ...media.map(({ name, bytes }) => ({ name: `word/media/${name}`, data: bytes }))
  ];

  return { bytes: buildZipArchive(files), failedImageCount };
}

// Appended to the success status when embedImagesAsDataUris couldn't inline
// every image (e.g. a private Drive share or a host that blocks hotlinking),
// so the user knows some images were kept as plain links instead of quietly
// discovering a broken image glyph after opening the file.
export function imageEmbedSuffix(failedImageCount) {
  if (!failedImageCount) return "";
  return ` (${failedImageCount} image${failedImageCount === 1 ? "" : "s"} couldn't be embedded — kept as ${failedImageCount === 1 ? "a link" : "links"})`;
}

async function exportCardsFlat(scope, format) {
  const cards = cardsForScope(scope);
  const title = scopeTitle(scope);
  if (!printableCardCount(cards)) {
    setStatus(`No ${scope === "review" ? "review" : scope} cards to export.`, "error");
    return;
  }
  const formatLabel = format === "doc" ? "Word" : "standalone HTML";
  setStatus(`Preparing ${title.toLowerCase()} ${formatLabel} export...`);
  el.exportBtn.disabled = true;
  try {
    const docTitle = exportBaseName(scope);
    const rawBodyHtml = buildCornellFlatDocument(title, cards, { sourceTitle: state.deckTitle || state.sourceTitle });
    let failedImageCount;
    if (format === "doc") {
      const result = await buildDocxBytes(rawBodyHtml, docTitle);
      failedImageCount = result.failedImageCount;
      downloadTextFile(result.bytes, `${docTitle}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      const { html: bodyHtml, failedImageCount: htmlFailed } = await prepareExportHtml(rawBodyHtml);
      failedImageCount = htmlFailed;
      const html = await wrapStandaloneHtmlDocument(bodyHtml, docTitle);
      downloadTextFile(html, `${docTitle}.html`, "text/html;charset=utf-8");
    }
    setStatus(`Exported ${title.toLowerCase()} as ${format === "doc" ? "Word (.docx)" : formatLabel}.${imageEmbedSuffix(failedImageCount)}`);
  } catch (error) {
    console.error("Cards export failed", error);
    setStatus("Could not prepare the export.", "error");
  } finally {
    el.exportBtn.disabled = false;
  }
}

function notesExportBaseName() {
  return `${slugifyFileName(state.deckTitle || state.sourceTitle || "recall")} - notes`;
}

async function exportNotesFlat(format) {
  const notes = state.notes || "";
  if (!notes.trim()) {
    setStatus("No notes to export.", "error");
    return;
  }
  const title = state.deckTitle || "Notes";
  const docTitle = notesExportBaseName();

  if (format === "markdown") {
    downloadTextFile(`# ${title}\n\n${notes.trim()}\n`, `${docTitle}.md`, "text/markdown;charset=utf-8");
    setStatus("Exported notes as Markdown.");
    return;
  }

  const formatLabel = format === "doc" ? "Word" : "standalone HTML";
  setStatus(`Preparing notes ${formatLabel} export...`);
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = true;
  try {
    const rawBodyHtml = buildNotesExportBody(title, notes);
    let failedImageCount;
    if (format === "doc") {
      const result = await buildDocxBytes(rawBodyHtml, docTitle);
      failedImageCount = result.failedImageCount;
      downloadTextFile(result.bytes, `${docTitle}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else {
      const { html: bodyHtml, failedImageCount: htmlFailed } = await prepareExportHtml(rawBodyHtml);
      failedImageCount = htmlFailed;
      const html = await wrapStandaloneHtmlDocument(bodyHtml, docTitle);
      downloadTextFile(html, `${docTitle}.html`, "text/html;charset=utf-8");
    }
    setStatus(`Exported notes as ${format === "doc" ? "Word (.docx)" : formatLabel}.${imageEmbedSuffix(failedImageCount)}`);
  } catch (error) {
    console.error("Notes export failed", error);
    setStatus("Could not prepare the notes export.", "error");
  } finally {
    if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  }
}

function markOversizePrintRows() {
  const a4PortraitContentHeightMm = 277;
  const pageHeight = Math.round(a4PortraitContentHeightMm * 96 / 25.4);
  el.printRoot.querySelectorAll(".cornell-print-row").forEach((row) => {
    row.classList.toggle("is-oversize", row.scrollHeight > pageHeight);
  });
}

function installPdfPrintStyle() {
  let style = document.querySelector(`#${pdfPrintStyleId}`);
  if (!style) {
    style = document.createElement("style");
    style.id = pdfPrintStyleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    @media print {
      @page { size: A4 portrait; margin: 14mm; }

      /* Card layout */
      .cornell-print-document { width: auto !important; border: none !important; box-shadow: none !important; }
      .cornell-print-table { padding: 7mm 0 0 !important; }
      .cornell-print-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        border: 1.5px solid #bbb !important;
        border-radius: 8px !important;
        margin-bottom: 7mm !important;
        overflow: hidden !important;
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .cornell-print-row .cornell-question-rail {
        flex: 0 0 45mm !important;
        width: 45mm !important;
        min-width: 45mm !important;
        border-right: 1.5px solid #bbb !important;
        padding: 5mm !important;
      }
      .cornell-print-row .cornell-answer-cell {
        flex: 1 1 0 !important;
        min-width: 0 !important;
        padding: 5mm 6mm !important;
      }
      .cornell-print-row .rendered { line-height: 1.42 !important; }
      .cornell-print-row .rendered p { margin: 0 0 0.55em !important; }
      .cornell-print-row .rendered p:last-child { margin-bottom: 0 !important; }

      /* Cover header spacing */
      .cornell-print-cover { padding: 0 0 5mm !important; margin-bottom: 3mm !important; }

      /* Clozes: always shown filled-in (never blank) in the exported PDF.
         Bold in the strong accent colour — no italics, no serif switch — so
         the answers stand out clearly without looking faint. */
      .cornell-print-document .cloze,
      .cornell-print-document .cloze.is-revealed {
        color: var(--print-accent-strong) !important;
        font-family: inherit !important;
        font-style: normal !important;
        font-weight: 700 !important;
        background: transparent !important;
        box-shadow: none !important;
        padding: 0 !important;
      }
      .cornell-print-document .cloze * {
        visibility: visible !important;
        color: inherit !important;
        font-weight: 700 !important;
      }
      /* Oversized cards (taller than a page): let them fragment but start on new page */
      .cornell-print-row.is-oversize {
        break-inside: auto !important;
        page-break-inside: auto !important;
        break-before: page;
        page-break-before: always;
      }

      /* Code block light theme for print */
      .cornell-print-row pre,
      .cornell-print-row pre[class*="language-"] {
        background: #f6f8fa !important;
        border: 1px solid #d0d0d0 !important;
        color: #24292e !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }
      .cornell-print-row pre code,
      .cornell-print-row pre code[class*="language-"] {
        color: #24292e !important;
        background: transparent !important;
      }
      .cornell-print-row .token.comment,
      .cornell-print-row .token.prolog,
      .cornell-print-row .token.doctype,
      .cornell-print-row .token.cdata { color: #6a737d !important; font-style: italic !important; }
      .cornell-print-row .token.keyword,
      .cornell-print-row .token.atrule { color: #d73a49 !important; font-weight: bold !important; }
      .cornell-print-row .token.function { color: #6f42c1 !important; }
      .cornell-print-row .token.string,
      .cornell-print-row .token.char,
      .cornell-print-row .token.attr-value { color: #032f62 !important; }
      .cornell-print-row .token.number,
      .cornell-print-row .token.boolean { color: #005cc5 !important; }
      .cornell-print-row .token.operator { color: #d73a49 !important; }
      .cornell-print-row .token.punctuation { color: #24292e !important; }
      .cornell-print-row .token.tag,
      .cornell-print-row .token.selector { color: #22863a !important; }
      .cornell-print-row .token.variable { color: #e36209 !important; }

      /* Tables */
      .cornell-print-row table {
        width: 100% !important;
        border-collapse: collapse !important;
        font-size: 8.5pt !important;
      }
      .cornell-print-row th { background: #f0f0f0 !important; font-weight: bold !important; color: #222 !important; }
      .cornell-print-row th,
      .cornell-print-row td { border: 1px solid #bbb !important; padding: 3px 6px !important; }

      /* Images */
      .cornell-print-row img {
        max-width: 100% !important;
        max-height: 50mm !important;
        object-fit: contain !important;
      }
    }
  `;
}

function standalonePrintStyles() {
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((link) => `<link rel="stylesheet" href="${escapeHtml(link.href)}">`)
    .join("\n");
  const pdfPrintStyle = document.querySelector(`#${pdfPrintStyleId}`)?.textContent || "";
  return `
    ${links}
    <style>
      html,
      body {
        margin: 0;
        background: var(--print-bg);
        color: var(--print-text);
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      body {
        padding: 0;
      }
      .print-root,
      .print-root.is-preview,
      .print-root.is-preparing {
        position: static !important;
        display: block !important;
        width: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        background: var(--print-bg) !important;
        color: var(--print-text) !important;
        padding: 0 !important;
        box-shadow: none !important;
        print-color-adjust: exact !important;
        -webkit-print-color-adjust: exact !important;
      }
      .cornell-print-document {
        width: auto !important;
        margin: 0 !important;
        box-shadow: none !important;
      }
      .print-preview-actions,
      [data-print-ui] {
        display: none !important;
      }
      @media screen {
        body {
          padding: 10px;
        }
      }
      ${pdfPrintStyle}
    </style>
  `;
}

function standalonePrintDocumentHtml() {
  const documentNode = el.printRoot.querySelector(".cornell-print-document");
  if (!documentNode) return "";
  return `<!doctype html>
    <html lang="en" data-theme="${escapeHtml(currentThemeId())}">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <base href="${escapeHtml(document.baseURI)}">
        <title>${escapeHtml(document.title || "Recall PDF")}</title>
        ${standalonePrintStyles()}
      </head>
      <body>
        <section class="print-root is-preview" aria-label="Cornell PDF export">
          ${documentNode.outerHTML}
        </section>
        <script>
          (() => {
            const printWhenReady = () => {
              const waitForImages = Promise.all(Array.from(document.images).map((img) => {
                if (img.complete) return Promise.resolve();
                return new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                });
              }));
              Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), waitForImages])
                .then(() => setTimeout(() => window.print(), 250));
            };
            if (document.readyState === "complete") {
              printWhenReady();
            } else {
              window.addEventListener("load", printWhenReady, { once: true });
            }
          })();
        <\/script>
      </body>
    </html>`;
}

async function generatePdfDirectly() {
  const documentNode = el.printRoot.querySelector(".cornell-print-document");
  if (!documentNode) {
    setStatus("PDF preview is not ready yet.", "error");
    return;
  }

  // Use fast standalone print window — browser print is instant and uses @media print CSS
  openStandalonePrintDocument();
}

function openStandalonePrintDocument() {
  const html = standalonePrintDocumentHtml();
  if (!html) {
    setStatus("PDF preview is not ready yet.", "error");
    return;
  }

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    setStatus("Could not open the print page. Allow pop-ups, then try Print / Save PDF again.", "error");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  setStatus("Opened a dedicated print page. Choose Save as PDF there.");
}

// One-click PDF: print the prepared document through a hidden same-origin iframe
// instead of a pop-up window. The iframe needs no user gesture (so it survives
// the async render step that a pop-up blocker would otherwise kill) and prints
// only its own document. The embedded auto-print script fires window.print()
// once fonts and images settle; we tear the frame down on afterprint.
function printViaHiddenIframe(html) {
  document.querySelector("#recallPrintFrame")?.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "recallPrintFrame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed; right:0; bottom:0; width:0; height:0; border:0; opacity:0; pointer-events:none;";
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return false;
  }

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    window.setTimeout(() => iframe.remove(), 1000);
  };
  win.addEventListener("afterprint", cleanup, { once: true });
  // Safety net in case afterprint never arrives (some mobile browsers).
  window.setTimeout(cleanup, 120000);

  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

// Serialize the freshly rendered print root and send it straight to the browser
// print dialog — the one-click path shared by every PDF export. Returns false
// when the root isn't ready yet.
function printPreparedDocument() {
  const html = standalonePrintDocumentHtml();
  if (!html) {
    setStatus("Could not prepare the PDF export.", "error");
    return false;
  }
  return printViaHiddenIframe(html);
}

// Reveal every {{cloze}} in the print root so the exported PDF shows the answers
// filled in rather than as blank redaction bars. Run before measuring rows so
// the revealed text is accounted for in the page layout.
function revealPrintRootClozes() {
  el.printRoot.querySelectorAll(".cloze").forEach((node) => node.classList.add("is-revealed"));
}

export async function exportCardsPdf(sourceTitle, cards, options = {}) {
  const title = options.title || "All Cards";
  const statusById = options.statusById || {};
  const fileBaseName = slugifyFileName(options.fileBaseName || sourceTitle || "recall");
  const cardCount = printableCardCount(cards);

  if (!cardCount) {
    setStatus("No cards to export as PDF.", "error");
    return;
  }

  setStatus(`Preparing ${sourceTitle} Cornell PDF...`);
  el.exportBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = fileBaseName;

  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, "all", { sourceTitle, statusById });
    // Must precede configureMermaid("print"): with mermaid loaded on demand,
    // an unloaded library makes that call a silent no-op, and the
    // enhanceRenderedMarkdown below would then load mermaid itself and
    // configure it with the SCREEN theme — exporting every diagram in the
    // dark palette onto white paper.
    await ensureMermaid();
    configureMermaid("print");
    try {
      await enhanceRenderedMarkdown(el.printRoot);
    } finally {
      configureMermaid(currentThemeId());
    }
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    markOversizePrintRows();
    const opened = printPreparedDocument();
    setStatus(opened
      ? `Opening ${sourceTitle} Cornell PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("PDF export failed", error);
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
    closePrintPreview();
    el.exportBtn.disabled = false;
  }
}

async function exportPdf(scope = "all") {
  const cards = cardsForScope(scope);
  const title = scopeTitle(scope);
  if (!cards.length) {
    setStatus(`No ${scope === "review" ? "review" : scope} cards to export.`, "error");
    return;
  }

  setStatus(`Preparing ${title.toLowerCase()} Cornell PDF...`);
  el.exportBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = exportBaseName(scope);
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, scope);
    // Must precede configureMermaid("print"): with mermaid loaded on demand,
    // an unloaded library makes that call a silent no-op, and the
    // enhanceRenderedMarkdown below would then load mermaid itself and
    // configure it with the SCREEN theme — exporting every diagram in the
    // dark palette onto white paper.
    await ensureMermaid();
    configureMermaid("print");
    try {
      await enhanceRenderedMarkdown(el.printRoot);
    } finally {
      configureMermaid(currentThemeId());
    }
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    markOversizePrintRows();
    const opened = printPreparedDocument();
    setStatus(opened
      ? `Opening ${title} Cornell PDF — choose Save as PDF in the dialog.`
      : "Could not prepare the PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("PDF export failed", error);
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
    closePrintPreview();
    el.exportBtn.disabled = false;
  }
}

function handleExportAction(format, scope) {
  el.exportMenu.hidden = true;
  if (format === "pdf") {
    setStatus("Opening PDF export...");
    window.setTimeout(() => exportPdf(scope), 0);
    return;
  }
  if (format === "json") {
    exportJson();
    return;
  }
  if (format === "sql") {
    exportSql(scope);
    return;
  }
  if (format === "html" || format === "doc") {
    exportCardsFlat(scope, format);
    return;
  }
  exportMarkdown(scope);
}

async function exportNotesPdf() {
  const notes = state.notes || "";
  if (!notes.trim()) {
    setStatus("No notes to export as PDF.", "error");
    return;
  }
  const title = state.deckTitle || "Notes";

  setStatus("Preparing notes PDF...");
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = true;
  el.printRoot.innerHTML = "";
  el.printRoot.classList.add("is-preparing");
  el.printRoot.classList.remove("is-preview");
  el.printRoot.setAttribute("aria-hidden", "true");
  setPrintTitleBeforeExport(document.title);
  document.title = notesExportBaseName();
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesPrintDocument(title, notes);
    // Must precede configureMermaid("print"): with mermaid loaded on demand,
    // an unloaded library makes that call a silent no-op, and the
    // enhanceRenderedMarkdown below would then load mermaid itself and
    // configure it with the SCREEN theme — exporting every diagram in the
    // dark palette onto white paper.
    await ensureMermaid();
    configureMermaid("print");
    try {
      await enhanceRenderedMarkdown(el.printRoot);
    } finally {
      configureMermaid(currentThemeId());
    }
    revealPrintRootClozes();
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    installPdfPrintStyle();
    const opened = printPreparedDocument();
    setStatus(opened
      ? "Opening notes PDF — choose Save as PDF in the dialog."
      : "Could not prepare the notes PDF export.", opened ? undefined : "error");
  } catch (error) {
    console.error("Notes PDF export failed", error);
    setStatus("Could not prepare the notes PDF export.", "error");
  } finally {
    closePrintPreview();
    if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  }
}

function handleExportNotesAction(format) {
  if (el.exportNotesMenu) el.exportNotesMenu.hidden = true;
  if (format === "pdf") {
    setStatus("Opening notes PDF export...");
    window.setTimeout(() => exportNotesPdf(), 0);
    return;
  }
  exportNotesFlat(format);
}

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
const IMPORT_FETCH_TIMEOUT_MS = 45000;

async function fetchImportText(url) {
  let signal;
  try { signal = AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS); } catch (_) { /* pre-2022 engine */ }
  const direct = await fetch(url, { mode: "cors", signal });
  if (!direct.ok) throw new Error(`HTTP ${direct.status}`);
  return direct.text();
}

function cleanImportUrl(rawUrl) {
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

function readerUrlFor(url) {
  return `https://r.jina.ai/${url}`;
}

async function fetchUrl() {
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

function normalizedArchiveName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function isMarkdownName(name) {
  return /\.(md|markdown|mdown|mkdn|txt)$/i.test(normalizedArchiveName(name).split("?")[0]);
}

function isZipName(name) {
  return /\.zip$/i.test(normalizedArchiveName(name).split("?")[0]);
}

function isJsonName(name) {
  return /\.json$/i.test(normalizedArchiveName(name).split("?")[0]);
}

function isEpubName(name) {
  return /\.epub$/i.test(normalizedArchiveName(name).split("?")[0]);
}

// ── EPUB import: one folder per book, one deck per chapter ─────────────────
// An EPUB is a zip container (OCF): META-INF/container.xml points at the
// package document (.opf), whose <manifest> lists every resource and whose
// <spine> gives the reading order. Chapters are converted to Markdown "as
// is" via the same Turndown pipeline used for pasted rich text; embedded
// images are uploaded through the existing Supabase Storage pipeline first so chapter
// Markdown can reference hosted URLs instead of in-zip paths.

function epubDirname(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// True for an href that already points outside the book (a remote image, a
// data: URI) — it needs no zip lookup and must survive into the markdown as-is.
function isExternalEpubHref(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(href || "").trim());
}

function joinEpubPath(baseDir, relative) {
  const stack = baseDir ? baseDir.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

// Resolves a relative href against a base directory inside the zip (both EPUB
// manifest hrefs and in-chapter image srcs are relative like this). Hrefs are
// URLs, so they arrive percent-encoded ("a%20b.jpg") while the zip entry they
// name is literal ("a b.jpg") — decode, or every book with a space or a
// non-ASCII character in a filename silently loses that file. `.raw` keeps the
// undecoded form for the rare archive whose entry names are encoded too.
function resolveEpubPath(baseDir, href) {
  if (!href) return "";
  const raw = href.split("#")[0].trim();
  if (!raw || isExternalEpubHref(raw)) return raw;
  return joinEpubPath(baseDir, normalizedArchiveName(raw));
}

function resolveEpubPathRaw(baseDir, href) {
  if (!href) return "";
  const raw = href.split("#")[0].trim();
  if (!raw || isExternalEpubHref(raw)) return raw;
  return joinEpubPath(baseDir, raw);
}

// zip.file() by resolved path, tolerating either naming convention.
function epubZipFile(zip, path, rawPath = "") {
  return zip.file(path) || (rawPath && rawPath !== path ? zip.file(rawPath) : null);
}

// Finds every element with a given local name, ignoring namespace prefixes —
// EPUB package documents mix the OPF namespace with prefixed Dublin Core
// (dc:title) and manifest items sometimes carry no prefix at all, so a plain
// CSS tag selector on the parsed XML doc isn't reliable across parsers.
function epubElementsByLocalName(doc, localName) {
  return Array.from(doc.getElementsByTagName("*")).filter((el) => el.localName === localName);
}

async function readEpubXml(zip, path, rawPath = "") {
  const entry = epubZipFile(zip, path, rawPath);
  if (!entry) throw new Error(`Missing ${path} in EPUB`);
  const text = await entry.async("text");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`Could not parse ${path}`);
  return doc;
}

// Finds the package document (.opf) path from META-INF/container.xml.
async function parseEpubContainer(zip) {
  const doc = await readEpubXml(zip, "META-INF/container.xml");
  const rootfile = epubElementsByLocalName(doc, "rootfile").find((el) => el.hasAttribute("full-path"));
  const href = rootfile?.getAttribute("full-path");
  if (!href) throw new Error("EPUB container.xml has no rootfile");
  return { path: resolveEpubPath("", href), rawPath: resolveEpubPathRaw("", href) };
}

// Parses the package document → book title, author, manifest
// (id -> {path, rawPath, mediaType}), and the spine in reading order.
async function parseEpubPackage(zip, opf) {
  const doc = await readEpubXml(zip, opf.path, opf.rawPath);
  const opfDir = epubDirname(opf.path);
  const opfDirRaw = epubDirname(opf.rawPath);

  const title = epubElementsByLocalName(doc, "title")[0]?.textContent?.trim() || "";
  const author = epubElementsByLocalName(doc, "creator")[0]?.textContent?.trim() || "";

  const manifest = new Map();
  epubElementsByLocalName(doc, "item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") || "";
    if (!id || !href) return;
    manifest.set(id, {
      path: resolveEpubPath(opfDir, href),
      rawPath: resolveEpubPathRaw(opfDirRaw, href),
      mediaType
    });
  });

  const spine = [];
  epubElementsByLocalName(doc, "itemref").forEach((itemref) => {
    const idref = itemref.getAttribute("idref");
    const entry = idref && manifest.get(idref);
    if (entry) spine.push(entry);
  });

  // Locates the table of contents: an EPUB3 nav document (the manifest item
  // flagged properties="nav") if present, else the EPUB2 NCX the spine's toc
  // attribute points at. Either is the authoritative, human-authored source
  // for chapter titles — far more reliable than sniffing a body heading or a
  // per-chapter <title>, which many converted/scanned books leave blank or
  // set to the same placeholder ("Unknown", "Untitled") on every page.
  let tocPath = "", tocRawPath = "";
  const navItem = epubElementsByLocalName(doc, "item").find((item) =>
    (item.getAttribute("properties") || "").split(/\s+/).includes("nav")
  );
  if (navItem?.getAttribute("href")) {
    tocPath = resolveEpubPath(opfDir, navItem.getAttribute("href"));
    tocRawPath = resolveEpubPathRaw(opfDirRaw, navItem.getAttribute("href"));
  } else {
    const tocId = epubElementsByLocalName(doc, "spine")[0]?.getAttribute("toc");
    const tocEntry = tocId && manifest.get(tocId);
    if (tocEntry) {
      tocPath = tocEntry.path;
      tocRawPath = tocEntry.rawPath;
    }
  }

  return { title, author, manifest, spine, tocPath, tocRawPath };
}

// Reads the EPUB3 nav doc / EPUB2 NCX located above into an ordered list of
// { path, anchorId, title } entries — one per TOC entry, in book reading
// order. anchorId is "" for an entry that names an entire spine file (a
// bare href with no #fragment) and non-empty for one that names a specific
// point *inside* a shared file (many real books — this NCX included — mix
// both: a bare entry per "chapter" file, and several anchored entries for
// finer sub-headings that live inside one physical page alongside other
// sub-headings). planEpubChapters below is what actually turns this list
// into chapter boundaries, splitting mid-file where an anchor demands it.
async function parseEpubToc(zip, pkg) {
  const entries = [];
  if (!pkg.tocPath) return entries;
  let doc;
  try {
    doc = await readEpubXml(zip, pkg.tocPath, pkg.tocRawPath);
  } catch (error) {
    console.warn("EPUB table of contents could not be parsed, falling back to headings", error);
    return entries;
  }
  const tocDir = epubDirname(pkg.tocPath);
  const seen = new Set();

  const addEntry = (href, label) => {
    const text = String(label || "").trim().replace(/\s+/g, " ");
    if (!href || !text) return;
    const hashIndex = href.indexOf("#");
    const anchorId = hashIndex === -1 ? "" : decodeURIComponent(href.slice(hashIndex + 1).trim());
    const path = resolveEpubPath(tocDir, href);
    if (!path) return;
    const key = `${path}#${anchorId}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path, anchorId, title: text });
  };

  // EPUB3 nav: <nav epub:type="toc">…<a href="…">Label</a>…</nav>
  const navEls = epubElementsByLocalName(doc, "nav");
  const tocNav = navEls.find((nav) =>
    (nav.getAttribute("epub:type") || nav.getAttribute("type") || "").includes("toc")
  ) || navEls[0];
  if (tocNav) {
    epubElementsByLocalName(tocNav, "a").forEach((a) => addEntry(a.getAttribute("href"), a.textContent));
  }

  // EPUB2 NCX: <navPoint><navLabel><text>Label</text></navLabel><content src="…"/></navPoint>
  epubElementsByLocalName(doc, "navPoint").forEach((navPoint) => {
    const label = epubElementsByLocalName(navPoint, "text")[0]?.textContent;
    const src = epubElementsByLocalName(navPoint, "content")[0]?.getAttribute("src");
    addEntry(src, label);
  });

  return entries;
}

// Placeholder text some EPUB-generation tools stamp into every chapter's
// <head><title> when the real per-page title wasn't preserved — treated as
// "no title" rather than surfaced verbatim (which is what previously made
// most chapters of a converted book show up as decks literally named
// "Unknown").
const GENERIC_EPUB_TITLE_RE = /^(unknown|untitled|no\s*title|n\/a|null|undefined)$/i;
function isGenericEpubTitle(text) {
  return GENERIC_EPUB_TITLE_RE.test(String(text || "").trim());
}

// Calibre-converted books commonly wrap an entire page's text in <h1> purely
// as a page-break styling hook, not because it's a real heading — so a body
// heading (or a stray <title>) longer than any real chapter title would be
// is discarded rather than trusted, falling through to the next candidate.
const MAX_EPUB_TITLE_LENGTH = 120;
function normalizeEpubTitleCandidate(text) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (!value || value.length > MAX_EPUB_TITLE_LENGTH || isGenericEpubTitle(value)) return "";
  return value;
}

// Shared title-resolution priority used by both the real import and the
// table-of-contents preview shown before it starts, so the preview never
// shows a chapter name the actual import wouldn't also produce: the book's
// own table of contents beats a visible body heading, which beats the
// chapter file's own <title> (skipped when generic or implausibly long).
function epubChapterRawTitle(headingText, docTitleText, tocTitle, chapterNumber) {
  const headingTitle = normalizeEpubTitleCandidate(headingText);
  const docTitle = normalizeEpubTitleCandidate(docTitleText);
  return tocTitle || headingTitle || docTitle || `Chapter ${chapterNumber}`;
}

// Hands control back to the browser so progress-modal updates actually paint
// between heavy steps — without this, a chain of promises that each resolve
// near-instantly (a cached zip read, a tiny parse) runs back-to-back as
// microtasks and the page never gets to repaint, which is what made earlier
// imports look frozen even though work was genuinely progressing.
// requestAnimationFrame is the right yield when visible, but it does NOT fire
// in a background tab — on its own it would hang the whole import the moment
// the user switched away mid-book, so fall back to a timer when hidden.
function epubYield() {
  if (typeof document !== "undefined" && document.hidden) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// One image, retried before being given up on. An illustrated book is
// hundreds of uploads back-to-back — exactly what trips a storage rate limiter
// or catches a transient network blip — and unlike a one-off paste the user
// can just redo, a single silent failure here is a figure permanently missing
// from the middle of a chapter. So back off and try again rather than
// dropping the image on the first refusal. Errors that re-trying cannot fix
// (not signed in, or the request itself being rejected) fail out immediately.
const EPUB_IMAGE_UPLOAD_ATTEMPTS = 4;
const EPUB_IMAGE_RETRY_BASE_MS = 600;

// A sleep that ends early the moment the import is cancelled, instead of making
// the user wait out the full backoff. On a low network every upload attempt
// already burns the full CLOUD_TIMEOUT_MS before failing, so an un-abortable
// backoff on top of that is exactly what made Cancel feel unresponsive there.
function cancellableDelay(ms, progress) {
  return new Promise((resolve) => {
    const step = 150;
    let waited = 0;
    const tick = () => {
      if (progress?.cancelled() || waited >= ms) return resolve();
      waited += step;
      setTimeout(tick, Math.min(step, ms - waited + step));
    };
    tick();
  });
}

async function uploadEpubImageWithRetry(file, progress, destination = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadImageToSupabase(file, destination);
    } catch (error) {
      const worthRetrying = error?.message !== "NOT_SIGNED_IN" && !error?.authFailed;
      if (!worthRetrying || attempt >= EPUB_IMAGE_UPLOAD_ATTEMPTS) throw error;
      // Cancelled mid-run — stop retrying immediately rather than sitting
      // through more doomed attempts the user has already backed out of.
      if (progress?.cancelled()) throw error;
      // 600ms, 1.2s, 2.4s — enough for a per-minute rate limit window to
      // drain a little between attempts instead of hammering through it and
      // burning every remaining image in the book. Abortable so a cancel
      // during the wait takes effect at once.
      await cancellableDelay(EPUB_IMAGE_RETRY_BASE_MS * 2 ** (attempt - 1), progress);
      if (progress?.cancelled()) throw error;
    }
  }
}

// Uploads every manifest image through the existing optimize+Supabase Storage
// pipeline, returning { urlMap: Map(zip path -> hosted URL), failed: [zip path], reason }.
// An image that still won't upload after retries is left out of the map, and
// epubContainerToMarkdown then drops that <img> rather than failing the whole
// book — but the paths and the last failure message come back so the import can
// tell the user how many figures are missing and *why*, instead of leaving them
// to notice the gaps themselves and guess. `reason` matters more than the count:
// every image vanishing is almost always one systemic cause (a lost session,
// a rate limit), and the message is what makes that fixable.
// `folder` is this import run's own bucket folder — every figure in the book
// lands there and nowhere else, so the whole run can be inspected or removed as
// one unit.
async function uploadEpubImages(zip, imageEntries, progress, folder = null) {
  const urlMap = new Map();
  const failed = [];
  let reason = "";
  for (let i = 0; i < imageEntries.length; i++) {
    const { path, rawPath, mediaType } = imageEntries[i];
    const label = `Uploading images ${i + 1}/${imageEntries.length}…`;
    setStatus(label);
    progress?.update(label, i / Math.max(imageEntries.length, 1));
    await epubYield();
    if (progress?.cancelled()) return { urlMap, failed, reason };
    const entry = epubZipFile(zip, path, rawPath);
    if (!entry) continue;
    try {
      const blob = await entry.async("blob");
      const name = path.split("/").pop() || `image-${i}`;
      const file = new File([blob], name, { type: mediaType || blob.type || "image/jpeg" });
      const optimized = await optimizeImage(file);
      // Keep the book's own filename so a figure is identifiable in the bucket,
      // behind a zero-padded index. The index both preserves the book's image
      // order in an alphabetically-sorted listing and guarantees uniqueness
      // within the folder — EPUBs routinely reuse a basename across
      // subdirectories (images/fig1.png and cover/fig1.png), and upsert is off,
      // so unprefixed names would collide and lose figures.
      const storageName = `${String(i + 1).padStart(4, "0")}-${storageFolderSlug(
        name.replace(/\.[^.]+$/, ""), "image"
      )}`;
      urlMap.set(path, await uploadEpubImageWithRetry(optimized, progress, { folder, name: storageName }));
    } catch (error) {
      // Cancelled mid-upload (uploadEpubImageWithRetry bails out of its backoff
      // on cancel): stop the run without counting this image as a real failure —
      // the user chose to stop, it isn't missing data to warn them about.
      if (progress?.cancelled()) return { urlMap, failed, reason };
      console.warn("EPUB image upload failed, skipping", path, error);
      failed.push(path);
      reason = error?.message === "NOT_SIGNED_IN" ? "you're not signed in"
        : error?.message === "OFFLINE" ? "this device is offline"
        : String(error?.message || "upload failed");
      // Give up on the whole run only when sign-in itself is the problem —
      // missing, or rejected by storage's RLS policy. Every remaining upload
      // would fail identically, and without this a lost session means sitting
      // through hundreds of doomed uploads before being told none of them
      // worked. Deliberately NOT triggered by ordinary failures: a rate limit
      // or a single oversized file must not abandon the rest of the book's
      // figures.
      if (error?.message === "NOT_SIGNED_IN" || error?.authFailed) {
        for (let j = i + 1; j < imageEntries.length; j++) failed.push(imageEntries[j].path);
        break;
      }
    }
  }
  return { urlMap, failed, reason };
}

// Parses one spine entry's XHTML into a Document. Falls back to HTML
// parsing if the chapter isn't strict XHTML (common in loosely-authored
// EPUBs).
async function epubParseChapterDoc(zip, spineEntry) {
  const entry = epubZipFile(zip, spineEntry.path, spineEntry.rawPath);
  if (!entry) return null;
  const html = await entry.async("text");
  const xmlDoc = new DOMParser().parseFromString(html, "application/xhtml+xml");
  return xmlDoc.querySelector("parsererror")
    ? new DOMParser().parseFromString(html, "text/html")
    : xmlDoc;
}

// Rewrites embedded image references within a container element (a whole
// chapter body, or a Range-extracted fragment of one — see
// extractEpubRangeMarkdown) to their uploaded hosted URLs (or drops the
// image if it wasn't uploaded), then runs it through the same
// htmlToMarkdown() used for pasted rich text.
function epubContainerToMarkdown(container, doc, chapterPath, imageUrlMap) {
  const chapterDir = epubDirname(chapterPath);

  // An href already pointing outside the book (remote URL, data: URI) is
  // usable as-is and is kept untouched; an in-book one is swapped for its
  // uploaded URL, or dropped if the upload didn't happen (skipped, failed,
  // or upload rejected) since an in-zip path would render as a broken image.
  const hostedSrcFor = (href) => {
    if (!href) return null;
    if (isExternalEpubHref(href)) return href.trim();
    return imageUrlMap.get(resolveEpubPath(chapterDir, href)) || null;
  };

  container.querySelectorAll("img[src]").forEach((img) => {
    const src = hostedSrcFor(img.getAttribute("src"));
    if (src) img.setAttribute("src", src);
    else img.remove();
  });
  container.querySelectorAll("image").forEach((image) => {
    const src = hostedSrcFor(
      image.getAttributeNS("http://www.w3.org/1999/xlink", "href")
      || image.getAttribute("xlink:href")
      || image.getAttribute("href")
    );
    if (src) {
      const replacement = doc.createElement("img");
      replacement.setAttribute("src", src);
      image.replaceWith(replacement);
    } else {
      image.remove();
    }
  });

  // epubMode keeps citation/footnote <sup> markers (and <sub>) instead of
  // stripping them the way the web-paste path does — see htmlToMarkdown.
  return htmlToMarkdown(container.innerHTML, { epubMode: true }).trim();
}

// Maps every id in one parsed chapter document to its element, for resolving
// in-file TOC anchors (href="chapter.html#some-id"). Built by scanning once
// rather than doing a `[id="…"]` CSS lookup per anchor: ids come straight out
// of arbitrary book markup and one containing a quote or bracket would break
// selector syntax, and a single file here can carry dozens of anchors. First
// id wins, matching how a browser resolves a duplicated id.
function buildEpubIdMap(doc) {
  const map = new Map();
  const all = doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getAttribute("id");
    if (id && !map.has(id)) map.set(id, all[i]);
  }
  return map;
}

// Extracts the Markdown for the slice of one chapter document's body that
// falls between two points — startNode inclusive (or the very start of the
// body when null) up to endNode exclusive (or the very end when null) —
// using Range.cloneContents(), which correctly reconstructs any ancestor
// element straddling the cut (e.g. a <div> that has to be "split" because
// only its second half belongs in this slice) rather than requiring the
// split points to land on clean element boundaries. This is what lets a
// single physical chapter file be divided at its own internal sub-heading
// anchors — see planEpubChapters / convertEpubChapters.
function extractEpubRangeMarkdown(doc, body, startNode, endNode, chapterPath, imageUrlMap) {
  const range = doc.createRange();
  if (startNode) range.setStartBefore(startNode);
  else range.setStart(body, 0);
  if (endNode) range.setEndBefore(endNode);
  else range.setEnd(body, body.childNodes.length);
  if (range.collapsed) return "";
  const container = doc.createElement("div");
  container.appendChild(range.cloneContents());
  return epubContainerToMarkdown(container, doc, chapterPath, imageUrlMap);
}

// Turns the book's table of contents into an ordered list of chapter-start
// "markers" — { spineIndex, anchorId, title } — spanning the whole book.
// Two kinds of source, both from parseEpubToc's entries:
//  - a bare entry (anchorId "") names an entire spine file as one chapter;
//  - an anchored entry names a point *inside* a spine file that also holds
//    other content — e.g. one physical page with an unlabeled intro
//    paragraph followed by several named sub-headings, which is exactly
//    how this class of Calibre conversion lays a chapter out. Each such
//    anchor becomes its own chapter boundary rather than being ignored or
//    merged wholesale into whichever chapter the file's name suggests.
// If the very first marker doesn't already sit at the top of the very
// first spine file, a synthetic leading marker (title resolved later via
// heading fallback) is prepended to cover the front matter a book's TOC
// often doesn't bother naming (cover, half-title, etc). Falls back to one
// marker per spine file — title resolved per-file via heading fallback,
// the pre-TOC behavior — when the book has no usable TOC at all.
function planEpubChapters(spine, tocEntries) {
  if (!tocEntries.length) {
    return spine.map((entry, i) => ({ spineIndex: i, anchorId: "", title: "" }));
  }
  const pathToIndex = new Map(spine.map((entry, i) => [entry.path, i]));
  const markers = [];
  tocEntries.forEach((e) => {
    const spineIndex = pathToIndex.get(e.path);
    if (spineIndex === undefined) return; // TOC points outside the spine (broken/foreign book) — ignore
    markers.push({ spineIndex, anchorId: e.anchorId, title: e.title });
  });
  markers.sort((a, b) => a.spineIndex - b.spineIndex); // stable: preserves TOC order within the same file
  if (!markers.length || markers[0].spineIndex !== 0 || markers[0].anchorId) {
    markers.unshift({ spineIndex: 0, anchorId: "", title: "" });
  }
  return markers;
}

// Fills in the title of every marker that doesn't already have one, in
// place, so the preview list and the decks the import actually creates are
// guaranteed to read from the same resolved titles rather than each running
// their own fallback (which previously disagreed: the preview named the
// leading front-matter chapter from its heading while the import, which had
// no fallback on that path, called the same deck "Chapter 1"). Markers
// sourced from the TOC already carry their real title; only a synthetic
// leading marker — or every marker, for a book with no TOC at all — needs
// the per-file heading/<title> fallback that costs a zip read.
async function resolveEpubMarkerTitles(zip, spine, markers) {
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].title) continue;
    try {
      const doc = await epubParseChapterDoc(zip, spine[markers[i].spineIndex]);
      const body = doc?.body || doc?.documentElement;
      const heading = body?.querySelector("h1, h2, h3, h4, h5, h6");
      markers[i].title = epubChapterRawTitle(heading?.textContent, doc?.title, "", i + 1);
    } catch (error) {
      markers[i].title = `Chapter ${i + 1}`;
    }
  }
  return markers;
}

// The numbered chapter-title lines shown in the preview modal, so the user
// sees the book's actual table of contents before committing to the import
// rather than just a chapter count. Titles come from resolveEpubMarkerTitles,
// the same ones the import itself will use.
function buildEpubTocPreview(markers) {
  const padWidth = String(markers.length).length;
  return markers.map((m, i) => `${String(i + 1).padStart(padWidth, "0")}. ${m.title}`);
}

// ── EPUB content preview (local, before any upload) ───────────────────────
// The preview must show the exact notes the import will save WITHOUT uploading
// anything — so it reuses convertEpubChapters (the very converter the real
// import runs) but hands it this resolver in place of the hosted-URL image map.
// Every in-book image path that exists in the manifest resolves to an inert
// same-document fragment marker ("#epub-img=<zip path>") instead of a hosted
// URL: truthy, so epubContainerToMarkdown KEEPS the <img> exactly as the real
// import would (it drops only images whose lookup is falsy), and it fetches
// nothing. showEpubPreview swaps each marker for a real object URL lazily, only
// when its chapter is expanded (hydrateEpubPreviewImages), and revokes them all
// when the modal closes — so a preview the user cancels uploads and leaks
// nothing.
const EPUB_PREVIEW_IMG_PREFIX = "epub-img=";

function makeEpubPreviewImageResolver(imageEntries) {
  const paths = new Set(imageEntries.map((entry) => entry.path));
  return {
    get(path) {
      if (!paths.has(path)) return null;
      // encodeURIComponent leaves ()' unescaped, and a bare "(" or ")" in a
      // markdown image URL truncates the link — encode those too so the marker
      // survives the html→markdown→html round trip intact.
      const encoded = encodeURIComponent(path).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16));
      return `#${EPUB_PREVIEW_IMG_PREFIX}${encoded}`;
    }
  };
}

// Converts every chapter to Markdown locally for the preview — byte-identical
// to what the real import saves (same convertEpubChapters, same markers) except
// image srcs are the inert markers above rather than hosted URLs. No network,
// no image decode. Returns [{ title, markdown }], the same shape the import
// uses. progress is null: convertEpubChapters treats a missing progress as
// "no modal / never cancelled", so it runs to completion in the background.
async function convertEpubChaptersForPreview(zip, spine, markers, imageEntries) {
  const resolver = makeEpubPreviewImageResolver(imageEntries);
  const chapters = await convertEpubChapters(zip, spine, markers, resolver, null);
  // A marker image with an EMPTY alt renders as "![](#epub-img=…)", whose
  // "[](#…)" tail collides with the notes renderer's footnote-backref cleanup
  // (normalizeCitations strips "[<whitespace>](#…)") — it eats the image and
  // leaves a stray "!". Books that wrap art in <svg><image> (Kindle covers,
  // full-page illustrations) produce exactly these alt-less images. Give every
  // empty/whitespace-alt marker a non-empty alt so it survives the pipeline and
  // renders as a real image. Preview-only: the hosted import is unaffected.
  const emptyAltMarker = new RegExp(`!\\[\\s*\\]\\((#${EPUB_PREVIEW_IMG_PREFIX}[^)]*)\\)`, "g");
  return chapters.map((chapter) => ({
    ...chapter,
    markdown: (chapter.markdown || "").replace(emptyAltMarker, "![image]($1)")
  }));
}

// Renders one chapter's cached preview Markdown into `body` using the same
// pipeline the notes view uses (markdownToSafeHtml + enhanceRenderedMarkdown),
// then hydrates its inert image markers into real object URLs read straight
// from the zip. The markers are stripped of their src BEFORE enhancement so the
// browser never tries to fetch "#epub-img=…" as an image (which would flash a
// broken-image icon); the real src is set only once its blob is decoded.
// `cache` = { urls: Map(path -> objectURL), created: [objectURL] } is shared
// across the whole modal so an image shown in two chapters decodes once, and
// every created URL is tracked for revocation on close.
async function renderEpubPreviewChapter(body, markdown, zip, cache) {
  body.innerHTML = markdownToSafeHtml(markdown || "");
  const pending = [];
  body.querySelectorAll(`img[src^="#${EPUB_PREVIEW_IMG_PREFIX}"]`).forEach((img) => {
    const marker = img.getAttribute("src").slice(1 + EPUB_PREVIEW_IMG_PREFIX.length);
    let path;
    try { path = decodeURIComponent(marker); } catch { path = marker; }
    img.removeAttribute("src");
    img.dataset.epubPreviewPath = path;
    pending.push(img);
  });
  await enhanceRenderedMarkdown(body);
  await hydrateEpubPreviewImages(pending, zip, cache);
}

async function hydrateEpubPreviewImages(imgs, zip, cache) {
  for (const img of imgs) {
    const path = img.dataset.epubPreviewPath;
    if (!path) continue;
    if (cache.urls.has(path)) { img.src = cache.urls.get(path); continue; }
    try {
      const entry = zip.file(path);
      if (!entry) { img.remove(); continue; }
      const blob = await entry.async("blob");
      const url = URL.createObjectURL(blob);
      cache.urls.set(path, url);
      cache.created.push(url);
      img.src = url;
    } catch (error) {
      console.warn("EPUB preview image could not be shown", path, error);
      img.remove();
    }
  }
}

// Walks the spine once, cutting each file's body at whichever of its
// markers resolve to a real in-file anchor (Range-based — see
// extractEpubRangeMarkdown) and appending each slice's Markdown to whatever
// chapter is "current" at that point in the book. A file with no markers of
// its own is entirely a continuation of the chapter already running; a
// file's content before its own first anchor (when that anchor isn't at the
// very top) continues the chapter running from before this file, same as a
// markerless file would. Returns the final {title, markdown} decks, already
// numbered and with empty ones dropped.
async function convertEpubChapters(zip, spine, markers, imageUrlMap, progress) {
  const markersByFile = new Map();
  markers.forEach((m) => {
    if (!markersByFile.has(m.spineIndex)) markersByFile.set(m.spineIndex, []);
    markersByFile.get(m.spineIndex).push(m);
  });

  const chapters = [];
  let current = null;
  const startChapter = (title) => {
    current = { title: title || `Chapter ${chapters.length + 1}`, parts: [] };
    chapters.push(current);
  };

  for (let spineIndex = 0; spineIndex < spine.length; spineIndex++) {
    // Counted in spine files, not chapters: one file can hold several
    // chapters (or half of one), so a "chapter i/N" label here would
    // contradict the chapter count the preview just showed.
    const label = `Converting page ${spineIndex + 1}/${spine.length}…`;
    setStatus(label);
    progress?.update(label, spineIndex / Math.max(spine.length, 1));
    await epubYield();
    if (progress?.cancelled()) break;
    const spineEntry = spine[spineIndex];
    let doc;
    try {
      doc = await epubParseChapterDoc(zip, spineEntry);
    } catch (error) {
      console.warn("EPUB chapter parse failed, skipping", spineEntry.path, error);
      continue;
    }
    const body = doc?.body || doc?.documentElement;
    if (!body) continue;

    const fileMarkers = markersByFile.get(spineIndex) || [];
    const positions = [];
    if (fileMarkers.length) {
      const idMap = fileMarkers.some((m) => m.anchorId) ? buildEpubIdMap(doc) : null;
      const seenNodes = new Set();
      fileMarkers.forEach((m) => {
        if (!m.anchorId) { positions.push({ marker: m, node: null }); return; }
        const node = idMap.get(m.anchorId);
        // Anchors that don't resolve to a real element inside this file's
        // body, and two anchors landing on the same element, are dropped
        // rather than allowed to cut the body at a nonsense point: either
        // would produce an empty or backwards Range below and silently eat
        // the text around it.
        if (!node || !body.contains(node) || seenNodes.has(node)) return;
        seenNodes.add(node);
        positions.push({ marker: m, node });
      });
      // A TOC's listed order isn't guaranteed to match the order its anchors
      // physically appear in the file. Cutting at points taken out of
      // document order would build backwards Ranges, which collapse to
      // nothing and drop that chapter's text, so sort by real document
      // position. The bare (whole-file) marker, if any, always leads.
      positions.sort((a, b) => {
        if (!a.node) return -1;
        if (!b.node) return 1;
        return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    }

    if (!positions.length) {
      // Nothing usable targets this file specifically: it's either a pure
      // continuation page, or (only possible for spine index 0) a book with
      // no TOC at all reaching its per-file fallback.
      const markdown = epubContainerToMarkdown(body, doc, spineEntry.path, imageUrlMap);
      if (markdown) {
        // No chapter is running yet only if every file before this one
        // failed to parse — the plan always puts a marker on spine index 0.
        if (!current) {
          const heading = body.querySelector("h1, h2, h3, h4, h5, h6");
          startChapter(epubChapterRawTitle(heading?.textContent, doc.title, "", chapters.length + 1));
        }
        current.parts.push(markdown);
      }
      continue;
    }

    try {
      if (positions[0].node) {
        const leading = extractEpubRangeMarkdown(doc, body, null, positions[0].node, spineEntry.path, imageUrlMap);
        if (leading && current) current.parts.push(leading);
      }
      for (let i = 0; i < positions.length; i++) {
        const startNode = positions[i].node;
        const endNode = positions[i + 1]?.node || null;
        startChapter(positions[i].marker.title);
        const segment = extractEpubRangeMarkdown(doc, body, startNode, endNode, spineEntry.path, imageUrlMap);
        if (segment) current.parts.push(segment);
      }
    } catch (error) {
      console.warn("EPUB chapter split failed for this file, its remaining content may be missing", spineEntry.path, error);
    }
  }

  // Chapters that produced nothing at all (an image-only cover page when
  // images were skipped, a bare divider heading) are dropped rather than
  // saved as blank decks — and the numbering is applied only after that, so
  // what lands in My Decks is always a gapless 01..N rather than starting at
  // "02" with a hole where the dropped chapter would have been.
  const kept = chapters.filter((c) => c.parts.length);
  const padWidth = String(kept.length).length;
  return kept.map((c, i) => ({
    title: `${String(i + 1).padStart(padWidth, "0")}. ${c.title}`,
    markdown: c.parts.join("\n\n")
  }));
}

// How many decks already sit in the folder this book would import into.
// Importing always creates fresh decks, so a second import of the same book
// silently doubles every chapter — worth warning about before it happens.
function epubTargetFolderDeckCount(bookTitle) {
  const sanitized = bookTitle.replace(/\//g, "-").trim() || "Imported Book";
  const parent = currentMyDecksFolder();
  const folderPath = normalizeDeckCategory(parent ? `${parent}${FOLDER_SEP}${sanitized}` : sanitized);
  return decksUnderFolder(folderPath).length;
}

// Analysis panel shown right after a fast, network-free parse of the EPUB's
// container.xml + package document — before any image upload or chapter
// conversion starts, so the user sees book title/author/counts almost
// instantly instead of a silent wait. Resolves { mode: "chapters" | "book" }
// (Import) or null (Cancel).
function showEpubPreview({ title, author, chapterCount, imageCount, existingDeckCount = 0, chaptersPromise, previewChaptersPromise, zip }) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal epub-preview-modal";
    modal.setAttribute("aria-label", "Import EPUB");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell epub-preview-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2 class="epub-preview-title"></h2>
          <p class="epub-preview-author"></p>
        </div>
        <button type="button" data-epub-cancel aria-label="Close">&#215;</button>
      </div>
      <div class="epub-preview-stats">
        <div class="epub-preview-stat"><strong class="epub-preview-chapters"></strong><span>Chapters</span></div>
        <div class="epub-preview-stat"><strong class="epub-preview-images"></strong><span>Images</span></div>
      </div>
      <div class="epub-preview-mode" role="radiogroup" aria-label="Import as">
        <label class="epub-preview-mode-option">
          <input type="radio" name="epub-import-mode" value="chapters" checked>
          <span>
            <strong>Separate deck per chapter</strong>
            <small>One deck per chapter (notes only), inside a new folder named after the book.</small>
          </span>
        </label>
        <label class="epub-preview-mode-option">
          <input type="radio" name="epub-import-mode" value="book">
          <span>
            <strong>Single deck for the whole book</strong>
            <small>All chapters combined into one deck's notes, with chapter titles kept as headings.</small>
          </span>
        </label>
      </div>
      <div class="epub-preview-toc">
        <p class="epub-preview-toc-label">Chapter preview — tap a chapter to read the note</p>
        <p class="epub-preview-toc-loading">Reading chapter titles…</p>
        <ol class="epub-preview-toc-list" hidden></ol>
      </div>
      <p class="restore-note epub-preview-warning" hidden></p>
      <div class="category-choice-actions">
        <button type="button" data-epub-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-epub-confirm>Import</button>
      </div>
    `;

    // Set via textContent (never innerHTML) so book metadata can't inject markup.
    shell.querySelector(".epub-preview-title").textContent = title || "Untitled book";
    shell.querySelector(".epub-preview-author").textContent = author ? `by ${author}` : "";
    shell.querySelector(".epub-preview-chapters").textContent = String(chapterCount);
    shell.querySelector(".epub-preview-images").textContent = String(imageCount);

    // Every object URL created to show a preview image is tracked here and
    // revoked in cleanup(), so nothing is committed to the notes and no
    // blob: handle leaks whether the user confirms or cancels.
    const cache = { urls: new Map(), created: [] };
    const tocLoading = shell.querySelector(".epub-preview-toc-loading");
    const tocList = shell.querySelector(".epub-preview-toc-list");

    // Fast pass: the plain chapter-title list needs only a light local walk
    // over the zip, so it streams in first (behind a loading line) to give
    // the modal visible structure. These rows are replaced in place by the
    // expandable content rows below as soon as the real conversion lands.
    if (chaptersPromise) {
      chaptersPromise.then((lines) => {
        if (!modal.isConnected || tocList.childElementCount) return;
        if (!lines.length) {
          if (tocLoading) tocLoading.textContent = "No table of contents found.";
          return;
        }
        if (tocLoading) tocLoading.textContent = "Rendering preview…";
        tocList.hidden = false;
        lines.forEach((line) => {
          const li = document.createElement("li");
          li.className = "epub-preview-toc-item";
          li.title = line;
          li.textContent = line;
          tocList.appendChild(li);
        });
      }).catch(() => {
        if (tocLoading && !tocList.childElementCount) tocLoading.textContent = "Could not read chapter titles.";
      });
    }

    // Authoritative pass: the real converted chapters (same keep/drop as the
    // actual import). Rebuild the list as expandable rows whose bodies render
    // the true note — images included — lazily on first expand. Nothing here
    // touches the network; images are decoded from the local zip on demand.
    const buildPreviewChapterRow = (chapter, index) => {
      const li = document.createElement("li");
      li.className = "epub-preview-chapter";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "epub-preview-chapter-toggle";
      header.setAttribute("aria-expanded", "false");

      const name = document.createElement("span");
      name.className = "epub-preview-chapter-name";
      name.textContent = chapter.title || `Chapter ${index + 1}`;
      name.title = name.textContent;

      const chevron = document.createElement("span");
      chevron.className = "epub-preview-chapter-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "▸";

      header.append(name, chevron);

      const body = document.createElement("div");
      body.className = "epub-preview-chapter-body";
      body.hidden = true;

      let rendered = false;
      header.addEventListener("click", async () => {
        const open = header.getAttribute("aria-expanded") === "true";
        if (open) {
          header.setAttribute("aria-expanded", "false");
          body.hidden = true;
          return;
        }
        header.setAttribute("aria-expanded", "true");
        body.hidden = false;
        if (rendered) return;
        rendered = true;
        body.innerHTML = '<p class="epub-preview-chapter-loading">Rendering…</p>';
        try {
          await renderEpubPreviewChapter(body, chapter.markdown, zip, cache);
        } catch (error) {
          console.warn("EPUB preview chapter render failed", error);
          rendered = false;
          body.innerHTML = '<p class="epub-preview-chapter-loading">Could not render this chapter.</p>';
        }
      });

      li.append(header, body);
      return li;
    };

    if (previewChaptersPromise) {
      previewChaptersPromise.then((chapters) => {
        if (!modal.isConnected) return;
        if (!chapters || !chapters.length) {
          if (tocLoading) tocLoading.textContent = "No previewable content found.";
          tocList.hidden = true;
          tocList.replaceChildren();
          return;
        }
        tocLoading?.remove();
        tocList.hidden = false;
        tocList.replaceChildren();
        chapters.forEach((chapter, index) => {
          tocList.appendChild(buildPreviewChapterRow(chapter, index));
        });
      }).catch((error) => {
        console.warn("EPUB content preview failed", error);
        if (tocLoading) tocLoading.textContent = "Could not render chapter preview.";
      });
    }

    // The "folder already holds N decks" warning only applies to the
    // per-chapter mode (the whole-book mode saves one deck, no folder), so
    // it toggles with the mode choice rather than being fixed at open time.
    const warning = shell.querySelector(".epub-preview-warning");
    const modeInputs = shell.querySelectorAll('input[name="epub-import-mode"]');
    const selectedMode = () => shell.querySelector('input[name="epub-import-mode"]:checked')?.value || "chapters";
    const updateWarningVisibility = () => {
      warning.hidden = !(selectedMode() === "chapters" && existingDeckCount > 0);
    };
    if (existingDeckCount > 0) {
      warning.textContent = `⚠ That folder already holds ${existingDeckCount} deck${existingDeckCount === 1 ? "" : "s"} — importing again adds a second copy of every chapter rather than replacing them.`;
    }
    modeInputs.forEach((input) => input.addEventListener("change", updateWarningVisibility));
    updateWarningVisibility();

    const cleanup = (value) => {
      // Revoke every preview blob URL so nothing leaks once the modal closes
      // (cancel or hand-off to import). The real import re-fetches/re-uploads
      // from the zip, so these preview-only URLs are never referenced again.
      cache.created.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
      });
      cache.created.length = 0;
      cache.urls.clear();
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-epub-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelector("[data-epub-confirm]")?.addEventListener("click", () => cleanup({ mode: selectedMode() }));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector("[data-epub-confirm]")?.focus();
  });
}

// Live progress modal shown once the import actually starts (image uploads +
// chapter conversion + deck creation) — replaces the earlier silent wait
// (status-bar text alone, easy to miss behind the My Decks panel) with
// continuous visible feedback so the import never looks frozen.
function showEpubProgress(title) {
  const modal = document.createElement("section");
  modal.className = "category-choice-modal epub-progress-modal";
  modal.setAttribute("aria-label", "Importing EPUB");

  const shell = document.createElement("div");
  shell.className = "category-choice-shell epub-progress-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2 class="epub-progress-title"></h2>
        <p class="epub-progress-line">Starting…</p>
      </div>
    </div>
    <div class="job-progress-track"><div class="job-progress-fill"></div></div>
    <div class="category-choice-actions">
      <button type="button" data-epub-stop>Cancel</button>
    </div>
  `;
  shell.querySelector(".epub-progress-title").textContent = `Importing “${title}”`;

  modal.appendChild(shell);
  document.body.appendChild(modal);

  const line = shell.querySelector(".epub-progress-line");
  const fill = shell.querySelector(".job-progress-fill");
  const stopBtn = shell.querySelector("[data-epub-stop]");
  // A big illustrated book is minutes of uploads; without this the user is
  // stuck watching it. The loops poll cancelled() between steps and stop at
  // the next boundary, keeping whatever chapters were already saved.
  let cancelled = false;
  stopBtn?.addEventListener("click", () => {
    cancelled = true;
    stopBtn.disabled = true;
    if (line) line.textContent = "Finishing the current step…";
  });

  return {
    update(text, fraction) {
      if (line && !cancelled) line.textContent = text;
      if (fill && typeof fraction === "number") fill.style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
    },
    cancelled() { return cancelled; },
    close() { modal.remove(); }
  };
}

// Uploads images, converts every spine chapter, then saves one deck per
// chapter into a new folder named after the book.
async function runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode = "chapters", folderPath = null) {
  const progress = showEpubProgress(bookTitle);
  // Hoisted out of the try so the catch below can put the user's own working
  // deck back even if the import blows up partway through the save loop.
  let savedState = null;
  try {
    // One bucket folder per import RUN, not per book title: importing the same
    // book twice must not have the second run's figures overwrite or interleave
    // with the first's, and abandoning a bad import has to be one folder to
    // delete. storageGroupId is what makes each run distinct.
    const imageFolder = `books/${storageFolderSlug(bookTitle, "book")}--${storageGroupId()}`;
    const { urlMap: imageUrlMap, failed: failedImages, reason: imageFailReason } =
      await uploadEpubImages(zip, imageEntries, progress, imageFolder);
    const chapters = await convertEpubChapters(zip, pkg.spine, markers, imageUrlMap, progress);

    if (!chapters.length) {
      const message = progress.cancelled()
        ? "EPUB import cancelled."
        : "Could not extract any chapter content from this EPUB.";
      setStatus(message, progress.cancelled() ? undefined : "error");
      showToast(message, progress.cancelled() ? "info" : "error");
      return;
    }

    // Chapter decks are written directly via saveDeckToLibrary rather than the
    // single-deck-at-a-time editor flow (createNewDeck etc.) — save/restore the
    // in-memory working deck around the save(s) so this doesn't clobber
    // whatever deck the user had open before starting the import.
    savedState = {
      deckId: state.deckId, localDeckId: state.localDeckId, deckTitle: state.deckTitle,
      deckCategory: state.deckCategory, notes: state.notes, masterCards: state.masterCards,
      sourceTitle: state.sourceTitle
    };

    const sanitizedTitle = bookTitle.replace(/\//g, "-").trim() || "Imported Book";
    // An explicit target (a folder's own "Import here" button) wins; otherwise
    // the book lands where My Decks is currently looking, as it always has.
    // NOTE: deliberately NOT named folderPath. A `let folderPath` here is
    // block-scoped to this try, so it shadows the parameter for the whole
    // block — and the parentFolder line above then reads it before its
    // declaration, throwing a TDZ ReferenceError on every single import
    // (after the images had already been uploaded, so the book's figures
    // landed in the bucket and no deck was ever written).
    const parentFolder = folderPath != null ? folderPath : currentMyDecksFolder();
    let targetFolder;
    let saved = 0;
    let saveFailed = false;

    if (mode === "book") {
      // Whole-book mode: one deck, no book-named folder — each chapter's
      // title survives as a "##" heading inside the single note, so the
      // existing in-note table of contents still gives chapter-by-chapter
      // navigation without creating a deck per chapter.
      targetFolder = parentFolder;
      const combinedMarkdown = chapters.map((c) => `## ${c.title}\n\n${c.markdown}`).join("\n\n---\n\n");
      setStatus(`Saving "${bookTitle}"…`);
      progress.update(`Saving "${bookTitle}"…`, 0.9);
      state.deckId = null;
      state.localDeckId = null;
      state.deckTitle = sanitizedTitle;
      state.deckCategory = targetFolder;
      state.notes = combinedMarkdown;
      state.masterCards = [];
      state.sourceTitle = sanitizedTitle;
      // Brand new deck — don't inherit whatever meta was in state before this import.
      state.meta = {};
      if (await saveDeckToLibrary({ silent: true })) saved = 1;
      else saveFailed = true;
    } else {
      targetFolder = normalizeDeckCategory(parentFolder ? `${parentFolder}${FOLDER_SEP}${sanitizedTitle}` : sanitizedTitle);
      addKnownFolder(targetFolder);

      // My Decks defaults to sorting by recency descending (deckAccessTime) —
      // so chapter 1 gets the newest updatedAt/createdAt and each later
      // chapter a second older, which is what puts them back in reading
      // order on screen under the default sort (and under "Last updated" /
      // "Date created", which derive from the same stagger). A user who's
      // switched to title or size sort will see chapters in that order
      // instead — an accepted tradeoff of sort being user-selectable now.
      const baseTime = Date.now();
      for (let i = 0; i < chapters.length; i++) {
        const label = `Creating chapter decks ${i + 1}/${chapters.length}…`;
        setStatus(label);
        progress.update(label, i / Math.max(chapters.length, 1));
        await epubYield();
        if (progress.cancelled()) break;
        state.deckId = null;
        state.localDeckId = null;
        state.deckTitle = chapters[i].title;
        state.deckCategory = targetFolder;
        state.notes = chapters[i].markdown;
        state.masterCards = [];
        state.sourceTitle = chapters[i].title;
        // Each chapter deck is brand new — don't inherit meta from the
        // previous chapter's iteration or the deck open before this import.
        state.meta = {};
        // A book is many decks in one go, so this is the realistic way to hit
        // the storage quota. saveDeckToLibrary returns null (never throws) on
        // failure — ignoring that would leave a half-imported book behind a
        // "Done" toast.
        if (!(await saveDeckToLibrary({ silent: true, updatedAt: new Date(baseTime - i * 1000).toISOString() }))) {
          saveFailed = true;
          break;
        }
        saved += 1;
      }
    }

    Object.assign(state, savedState);
    persistWorkingDeck();

    setMyDecksView("folder");
    setMyDecksCwd(targetFolder);
    // renderMyDecksList, NOT repaintMyDecks: repaint redraws from the cached
    // deck set captured before this import, so the new book folder would render
    // from the known-folder registry alone — visible but claiming "0 decks",
    // with nothing for a folder selection to act on. Every other path that
    // changes deck data re-reads the same way.
    if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    else openMyDecksPanel();

    if (saveFailed) {
      const message = mode === "book"
        ? (lastSaveErrorWasQuota ? "Could not save — device storage is full." : "Could not save this deck.")
        : lastSaveErrorWasQuota
          ? `Only ${saved} of ${chapters.length} chapters saved — device storage is full. Delete some decks and re-import.`
          : `Only ${saved} of ${chapters.length} chapters could be saved.`;
      progress.update(message, saved / Math.max(mode === "book" ? 1 : chapters.length, 1));
      setStatus(message, "error");
      showToast(message, "error");
      return;
    }

    const chapterWord = `chapter${saved === 1 ? "" : "s"}`;
    const bookChapterWord = `chapter${chapters.length === 1 ? "" : "s"}`;
    const summary = mode === "book"
      ? (progress.cancelled()
          ? `Import stopped — saved "${bookTitle}" with ${chapters.length} ${bookChapterWord} converted so far`
          : `Imported "${bookTitle}" as one deck (${chapters.length} ${bookChapterWord})`)
      : progress.cancelled()
        ? `Import stopped — kept ${saved} ${chapterWord} of "${bookTitle}"`
        : `Imported "${bookTitle}" — ${saved} ${chapterWord}`;
    progress.update(summary, 1);
    setStatus(`${summary}.`);
    // An image that never made it into the notes is silent data loss — the
    // book still imports and the toast would otherwise claim a clean run,
    // leaving the reader to find the holes themselves. Said out loud, with
    // the cause, since "0 of 218 images" is only actionable once you know why.
    const imageNote = failedImages.length
      ? `${failedImages.length} of ${imageEntries.length} image${failedImages.length === 1 ? "" : "s"} could not be uploaded${imageFailReason ? ` (${imageFailReason})` : ""} and are missing from the notes.`
      : "";
    if (imageNote) {
      setStatus(`${summary}. ${imageNote}`, "error");
      showToast(`${summary} — ${imageNote}`, "error");
    } else {
      showToast(summary, progress.cancelled() ? "info" : undefined);
    }
  } catch (error) {
    // Without this, any bug in here left the images sitting in the bucket, the
    // progress modal closing on its own, and NO deck and NO explanation — the
    // only visible error was whatever unrelated toast happened to fire next
    // (typically the autosave's "device storage full"), which sent debugging
    // in exactly the wrong direction. Always name the real cause.
    console.error("EPUB import failed", error);
    if (savedState) {
      Object.assign(state, savedState);
      persistWorkingDeck();
    }
    const message = `Could not import "${bookTitle}" — ${error?.message || error?.name || "unexpected error"}`;
    setStatus(message, "error");
    showToast(message, "error");
  } finally {
    progress.close();
  }
}

// Both entry points below call importEpubFile without awaiting it, so anything
// that throws outside runEpubImport's own catch (the TOC/plan/preview stage)
// would otherwise become a console-only unhandled rejection with nothing on
// screen. Every EPUB failure must say so out loud.
function reportEpubImportCrash(error) {
  console.error("EPUB import failed", error);
  const message = `Could not import this EPUB — ${error?.message || error?.name || "unexpected error"}`;
  setStatus(message, "error");
  showToast(message, "error");
}

// Entry point wired to the "Import EPUB" button's file input.
async function importEpubFile(file, folderPath = null) {
  if (!file) return;
  if (!(await ensureJsZip())) {
    setStatus("Zip support did not load — cannot read EPUB files.", "error");
    return;
  }

  setStatus(`Reading ${file.name}…`);
  let zip, pkg;
  try {
    zip = await JSZip.loadAsync(file);
    const opf = await parseEpubContainer(zip);
    pkg = await parseEpubPackage(zip, opf);
  } catch (error) {
    console.error("EPUB parse failed", error);
    setStatus("Could not read this EPUB.", "error");
    showToast("Could not read this EPUB", "error");
    return;
  }

  if (!pkg.spine.length) {
    setStatus("This EPUB has no readable chapters.", "error");
    showToast("This EPUB has no readable chapters", "error");
    return;
  }

  const bookTitle = pkg.title || file.name.replace(/\.epub$/i, "");
  const imageEntries = Array.from(pkg.manifest.values()).filter((entry) => entry.mediaType.startsWith("image/"));

  // Computed once up front and reused by both the preview and the real
  // import. markers — not the raw spine — is the real source of truth for
  // "how many decks will this book become": see planEpubChapters for why a
  // spine file and a resulting chapter deck aren't always one-to-one.
  // Resolving the titles can need a zip read per marker, so it stays off the
  // modal's critical path behind a loading line and the stat tiles still
  // appear as fast as before.
  const tocEntries = await parseEpubToc(zip, pkg);
  const markers = planEpubChapters(pkg.spine, tocEntries);
  const titlesPromise = resolveEpubMarkerTitles(zip, pkg.spine, markers);
  const tocPreviewPromise = titlesPromise.then(buildEpubTocPreview);
  // The full per-chapter note content, converted locally (no upload) so the
  // user can read the actual notes before committing. Chained after the titles
  // resolve so each converted chapter carries its real name, and kept off the
  // modal's critical path — the stat tiles/TOC still show instantly while this
  // renders in the background behind a "Rendering preview…" line.
  const previewChaptersPromise = titlesPromise
    .then(() => convertEpubChaptersForPreview(zip, pkg.spine, markers, imageEntries));

  const choice = await showEpubPreview({
    title: bookTitle,
    author: pkg.author,
    chapterCount: markers.length,
    imageCount: imageEntries.length,
    existingDeckCount: epubTargetFolderDeckCount(bookTitle),
    chaptersPromise: tocPreviewPromise,
    previewChaptersPromise,
    zip
  });
  if (!choice) {
    setStatus("EPUB import cancelled.");
    return;
  }
  const mode = choice.mode === "book" ? "book" : "chapters";

  // resolveEpubMarkerTitles fills the markers in place, and Import is
  // clickable before it finishes — so settle it here or a fast click would
  // hand runEpubImport half-untitled markers and name those decks
  // "Chapter N". Already-resolved by now in every practical case; a failure
  // is non-fatal (the titles it couldn't read just keep their fallbacks).
  await tocPreviewPromise.catch(() => {});

  await runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode, folderPath);
}

async function collectMarkdownFromZip(input, prefix = "", depth = 0) {
  if (depth > 4) return [];

  const zip = await JSZip.loadAsync(input);
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  const found = [];

  for (const entry of entries) {
    if (entry.dir) continue;

    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (isMarkdownName(entry.name)) {
      found.push({
        name: path,
        text: await entry.async("text")
      });
      continue;
    }

    if (isZipName(entry.name)) {
      try {
        const nested = await entry.async("arraybuffer");
        found.push(...await collectMarkdownFromZip(nested, path, depth + 1));
      } catch (error) {
        console.warn("Nested zip could not be read", path, error);
      }
    }
  }

  return found;
}

// Pulls every Markdown document out of a zip (including nested zips) as its own
// import source, so a zipped export folder behaves exactly like selecting those
// files by hand.
async function readZipSources(file) {
  if (!(await ensureJsZip())) {
    setStatus("Zip support did not load. Extract the zip and upload the .md files.", "error");
    return [];
  }
  const markdownFiles = await collectMarkdownFromZip(file);
  if (!markdownFiles.length) {
    setStatus(`No Markdown file found in ${file.name}, including nested zip files.`, "error");
    return [];
  }
  return markdownFiles.map((entry) => ({
    kind: "markdown",
    name: entry.name || file.name,
    markdown: entry.text
  }));
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}`)));
    reader.readAsText(file);
  });
}

// One picked file → zero or more import sources. Zips fan out; everything else
// is a single source. Never throws: an unreadable file is reported and skipped
// so one bad file can't sink a batch of twenty good ones.
async function readImportSources(file) {
  if (isZipName(file.name) || /zip/i.test(file.type)) {
    try {
      return await readZipSources(file);
    } catch (error) {
      setStatus(`Could not read ${file.name}.`, "error");
      return [];
    }
  }

  let text;
  try {
    text = await readFileText(file);
  } catch (error) {
    setStatus(`Could not read ${file.name}.`, "error");
    return [];
  }

  if (isJsonName(file.name) || file.type === "application/json") {
    try {
      // A JSON export already records its own notes/cards split, so it needs no
      // analysis — only a destination.
      return [{ kind: "snapshot", name: file.name, payload: JSON.parse(text) }];
    } catch (error) {
      setStatus(`${file.name} is not readable Recall JSON.`, "error");
      return [];
    }
  }

  return [{ kind: "markdown", name: file.name, markdown: text }];
}

// Reads everything that was picked and stages it for review. `folderPath` files
// the resulting decks under that folder (the My Decks "Import here" buttons);
// null — every ordinary import — leaves them under their own category.
//
// Nothing is created here: every source except EPUB hands off to the review
// step, where you say whether the files become notes, cards, or both, and
// whether they land as separate decks, one merged deck, or the open one.
async function loadFiles(fileList, folderPath = null) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  setPendingImportFolder(null);

  // An EPUB *is* a zip, and its "application/epub+zip" type matches the /zip/i
  // test, so it has to be split off before anything else looks at the list.
  const isEpub = (file) => isEpubName(file.name) || /epub/i.test(file.type);
  const epubs = files.filter(isEpub);
  const rest = files.filter((file) => !isEpub(file));

  // An EPUB becomes a whole folder of chapter decks behind its own preview
  // modal, so it can't share the review step. On its own (or several at once)
  // it runs that flow directly; mixed into a batch it is left out and named,
  // rather than silently dropped.
  if (epubs.length && !rest.length) {
    for (const file of epubs) {
      await importEpubFile(file, folderPath).catch(reportEpubImportCrash);
    }
    return;
  }

  if (files.length > 1) setStatus(`Reading ${files.length} files…`);
  const sources = [];
  for (const file of rest) {
    sources.push(...await readImportSources(file));
  }

  stageImportSources(sources, {
    folder: folderPath,
    skipped: epubs.map((file) => `${file.name} — import EPUBs on their own`)
  });
}

function loadFile(file, folderPath = null) {
  return loadFiles(file ? [file] : [], folderPath);
}

function loadSample() {
  stageMarkdownImport(sampleMarkdown, { name: "Sample flashcards", folder: null });
}

// ── Import panel: source pickers ────────────────────────────────────────────

export function showImportSourceDrawer(which) {
  if (el.importUrlRow) el.importUrlRow.hidden = which !== "url";
  if (el.importPasteRow) el.importPasteRow.hidden = which !== "paste";
  if (el.importPasteSourceBtn) el.importPasteSourceBtn.classList.toggle("is-active", which === "paste");
  if (el.importUrlSourceBtn) el.importUrlSourceBtn.classList.toggle("is-active", which === "url");
  if (which === "paste") window.setTimeout(() => el.pasteMarkdownInput?.focus(), 0);
  if (which === "url") window.setTimeout(() => el.urlInput?.focus(), 0);
}

function stagePastedMarkdown() {
  const markdown = el.pasteMarkdownInput?.value || "";
  if (!markdown.trim()) {
    setStatus("Paste some Markdown first.", "error");
    el.pasteMarkdownInput?.focus();
    return;
  }
  stageMarkdownImport(markdown, { name: "", folder: null });
}

function currentCardCanMove() {
  return Boolean(state.previewCard || state.cards[state.current] || (state.cards.length > 0 && state.current === state.cards.length));
}

export function closestElement(target, selector) {
  if (target instanceof Element) return target.closest(selector);
  if (typeof target?.closest === "function") return target.closest(selector);
  if (typeof target?.parentElement?.closest === "function") return target.parentElement.closest(selector);
  return null;
}

// `.notes-img-resize-handle` is a bare <div> (it has to be, so its pointerdown
// can start a drag without a button's own activation behaviour getting in the
// way), so it needs naming here explicitly or dragging an image's corner on a
// card face would also flip the card.
function isCardActionTarget(target) {
  return Boolean(closestElement(target, "a, button, input, textarea, .cloze, .render-toolbar, .notes-img-resize-handle"));
}

function isHorizontallyScrollable(node) {
  if (!(node instanceof Element)) return false;
  const styles = window.getComputedStyle(node);
  const allowsHorizontalScroll = !["hidden", "clip", "visible"].includes(styles.overflowX);
  return allowsHorizontalScroll && node.scrollWidth > node.clientWidth + 2;
}

function horizontalScrollRegion(target) {
  let node = target instanceof Element ? target : target?.parentElement;

  while (node && node !== el.card) {
    if (isHorizontallyScrollable(node)) {
      return node;
    }
    node = node.parentElement;
  }

  return null;
}

function isHorizontalScrollTarget(target) {
  return Boolean(horizontalScrollRegion(target));
}

function hasCardTextSelection() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean((anchorNode && el.card.contains(anchorNode)) || (focusNode && el.card.contains(focusNode)));
}

function swipeCommitDistance() {
  return Math.min(
    swipeConfig.maxCommitDistance,
    Math.max(swipeConfig.minCommitDistance, el.card.offsetWidth * swipeConfig.widthCommitRatio)
  );
}

function dragVelocity(current, previous, time) {
  const elapsed = Math.max(time - state.dragLastTime, 1);
  return (current - previous) / elapsed;
}

function beginSwipe(clientX, clientY, pointerId = null, pointerType = "") {
  const time = performance.now();
  state.dragging = false;
  state.dragMoved = false;
  state.dragStartX = clientX;
  state.dragStartY = clientY;
  state.dragCurrentX = clientX;
  state.dragCurrentY = clientY;
  state.dragLastX = clientX;
  state.dragLastY = clientY;
  state.dragStartTime = time;
  state.dragLastTime = time;
  state.dragPointerId = pointerId;
  state.dragPointerType = pointerType;
  state.dragCaptured = false;
}

export function resetCardDrag() {
  state.dragging = false;
  state.dragPointerId = null;
  state.dragPointerType = "";
  state.dragCaptured = false;
  state.dragMoved = false;
  el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
}

function updateSwipe(clientX, clientY, event) {
  // Never hijack an active text selection — for either mouse-drag or touch
  // (finger dragging the selection handles). preventDefault() on the move
  // event would otherwise cancel the browser's native selection.
  if (hasCardTextSelection()) {
    if (state.dragCaptured && typeof state.dragPointerId === "number") {
      el.card.releasePointerCapture?.(state.dragPointerId);
    }
    resetCardDrag();
    return;
  }

  const time = performance.now();
  const velocityX = dragVelocity(clientX, state.dragLastX, time);
  state.dragCurrentX = clientX;
  state.dragCurrentY = clientY;

  const dx = state.dragCurrentX - state.dragStartX;
  const dy = state.dragCurrentY - state.dragStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  state.dragMoved = state.dragMoved || absX > 6 || absY > 6;

  // A touch that has dwelled this long without going anywhere is a long-press:
  // the browser is about to hand back a text selection, and the preventDefault()
  // further down cancels a pending one. The hasCardTextSelection() guard at the
  // top of this function can't help, because it only becomes true once the
  // selection already EXISTS — by which point the swipe has been running for a
  // frame or two and eaten the gesture. This is the fix for text selection on a
  // phone being unreliable: press, pause, then drag now always selects, and only
  // a touch that moves promptly is treated as a swipe.
  if (!state.dragging
      && !state.dragMoved
      && state.dragPointerType !== "mouse"
      && time - state.dragStartTime > swipeConfig.longPressGraceMs) {
    resetCardDrag();
    return;
  }

  if (!state.dragging) {
    const hasHorizontalIntent = absX >= swipeConfig.intentDistance && absX >= absY * swipeConfig.intentRatio;
    const hasVerticalIntent = absY >= swipeConfig.intentDistance && absY >= absX * swipeConfig.intentRatio;

    if (!hasHorizontalIntent && !hasVerticalIntent) {
      state.dragLastX = clientX;
      state.dragLastY = clientY;
      state.dragLastTime = time;
      return;
    }

    if (hasVerticalIntent) {
      state.suppressClickUntil = time + 360;
      resetCardDrag();
      return;
    }

    state.dragging = true;
    if (event?.pointerId !== undefined && !state.dragCaptured) {
      if (event.pointerType !== "mouse" || !hasCardTextSelection()) {
        el.card.setPointerCapture?.(event.pointerId);
        state.dragCaptured = true;
      }
    }
    el.card.classList.add("is-dragging");
  }

  if (event?.cancelable && typeof event.preventDefault === "function") {
    if (event.pointerType !== "mouse" || state.dragCaptured) {
      event.preventDefault();
    }
  }

  const direction = dx > 0 ? 1 : -1;
  const resisted = direction * Math.min(absX * swipeConfig.resistance, swipeConfig.maxPreviewOffset);
  const progress = Math.min(absX / swipeCommitDistance(), 1);
  const flicking = absX >= swipeConfig.flickDistance && Math.abs(velocityX) >= swipeConfig.flickVelocity;
  const choosing = progress > 0.45 || flicking;
  el.card.classList.toggle("drag-prev", dx > 0 && choosing);
  el.card.classList.toggle("drag-next", dx < 0 && choosing);
  el.card.style.transform = `translateX(${resisted}px) rotate(${direction * progress * 2.2}deg) scale(${1 - progress * 0.01})`;

  state.dragLastX = clientX;
  state.dragLastY = clientY;
  state.dragLastTime = time;
}

function finishSwipe() {
  const dx = state.dragCurrentX - state.dragStartX;
  const dy = state.dragCurrentY - state.dragStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const elapsed = Math.max(performance.now() - state.dragStartTime, 1);
  const averageVelocity = absX / elapsed;
  const committed = state.dragging
    && absX >= absY * swipeConfig.commitRatio
    && (
      absX >= swipeCommitDistance()
      || (absX >= swipeConfig.flickDistance && averageVelocity >= swipeConfig.flickVelocity)
    );

  // Gated on `dragging` — a gesture that showed real directional intent (see
  // hasHorizontalIntent/hasVerticalIntent in updateSwipe) — and NOT on
  // `dragMoved`, which is merely ">6px of travel". A finger tap is rarely
  // pixel-perfect, so the old condition swallowed the click of any tap that
  // wobbled 7px for a full 360ms: the card did not flip and nothing on screen
  // acknowledged the press. That is the purest form of "I clicked and nothing
  // happened", and it was reachable on every tap.
  //
  // The card's own click handler still has an independent 8px isDrag guard, so
  // dropping the low-threshold case here loses no protection against a real
  // swipe being read as a tap.
  if (state.dragging) {
    state.suppressClickUntil = performance.now() + 360;
  }

  if (committed) {
    el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
    el.card.style.transform = "";
    state.dragging = false;
    state.dragPointerId = null;
    state.dragPointerType = "";
    state.dragCaptured = false;
    state.dragMoved = false;

    navigateCard(dx > 0 ? -1 : 1, dx > 0 ? "prev" : "next");
    return;
  }

  resetCardDrag();
}

function handlePointerDown(event) {
  if (!currentCardCanMove() || isCardActionTarget(event.target)) return;
  if (isHorizontalScrollTarget(event.target)) return;
  // Touch/pen: an active selection means the user is dragging a selection
  // handle — don't start a swipe. (Mouse keeps its mid-drag guard in updateSwipe
  // so a lingering selection never blocks starting a fresh drag.)
  if (event.pointerType !== "mouse" && hasCardTextSelection()) return;
  dismissSwipeHint();
  beginSwipe(event.clientX, event.clientY, event.pointerId, event.pointerType);
}

function handlePointerMove(event) {
  if (state.dragPointerId !== event.pointerId) return;
  updateSwipe(event.clientX, event.clientY, event);
}

function handlePointerUp(event) {
  if (state.dragPointerId !== event.pointerId) return;
  if (state.dragCaptured) el.card.releasePointerCapture?.(event.pointerId);
  finishSwipe();
}

function handlePointerCancel(event) {
  if (state.dragPointerId === event.pointerId) {
    if (state.dragCaptured) el.card.releasePointerCapture?.(event.pointerId);
    resetCardDrag();
  }
}

function touchPoint(event) {
  return event.changedTouches?.[0] || event.touches?.[0] || null;
}

function handleTouchStart(event) {
  if (!currentCardCanMove() || isCardActionTarget(event.target)) return;
  if (isHorizontalScrollTarget(event.target)) return;
  // A selection is already up (e.g. dragging a selection handle after a
  // long-press) — leave the gesture to the browser instead of starting a swipe.
  if (hasCardTextSelection()) return;
  const point = touchPoint(event);
  if (!point) return;
  beginSwipe(point.clientX, point.clientY, "touch", "touch");
}

function handleTouchMove(event) {
  if (state.dragPointerId !== "touch") return;
  const point = touchPoint(event);
  if (!point) return;
  updateSwipe(point.clientX, point.clientY, event);
}

function handleTouchEnd() {
  if (state.dragPointerId !== "touch") return;
  finishSwipe();
}

function handleTouchCancel() {
  if (state.dragPointerId !== "touch") return;
  resetCardDrag();
}

function preventCancelableScroll(event) {
  if (event.cancelable && typeof event.preventDefault === "function") {
    event.preventDefault();
  }
}

function styleScrollRegion(target) {
  return closestElement(target, ".style-grid, .all-cards-list, .import-preview-body, .import-decklist-rows, textarea, .import-card, .web-decks-table-wrap, .my-decks-grid, .diagram-modal-body");
}

function canScrollStyleRegion(region) {
  return Boolean(region && region.scrollHeight > region.clientHeight + 1);
}

function isStyleRegionAtTop(region) {
  return region.scrollTop <= 0;
}

function isStyleRegionAtBottom(region) {
  return region.scrollTop + region.clientHeight >= region.scrollHeight - 1;
}

function containStylePanelScroll(event, deltaY) {
  const region = styleScrollRegion(event.target);
  if (!region || !canScrollStyleRegion(region)) {
    preventCancelableScroll(event);
    return;
  }

  if ((deltaY < 0 && isStyleRegionAtTop(region)) || (deltaY > 0 && isStyleRegionAtBottom(region))) {
    preventCancelableScroll(event);
  }
}

function handleStylePanelTouchStart(event) {
  const point = event.touches?.[0];
  state.stylePanelTouchY = point ? point.clientY : 0;
}

function handleStylePanelTouchMove(event) {
  if (event.touches?.length !== 1) return;
  if (closestElement(event.target, "input, button, a, label, textarea, .import-action-btn")) return;

  const point = event.touches[0];
  const previousY = state.stylePanelTouchY || point.clientY;
  const deltaY = previousY - point.clientY;
  state.stylePanelTouchY = point.clientY;
  containStylePanelScroll(event, deltaY);
}

function handleStylePanelWheel(event) {
  containStylePanelScroll(event, event.deltaY);
}

function handleDiagramWheel(event) {
  if (!currentDiagramZoom) return;
  preventCancelableScroll(event);
  const direction = event.deltaY > 0 ? 0.9 : 1.1;
  zoomDiagramTo(currentDiagramZoom.scale * direction, event);
}

function handleDiagramPointerDown(event) {
  const isPrimaryContact = event.button === 0 || event.pointerType === "touch" || event.pointerType === "pen";
  if (!currentDiagramZoom || !isPrimaryContact || event.target.closest("button, a")) return;
  preventCancelableScroll(event);
  el.diagramModalBody.setPointerCapture?.(event.pointerId);
  currentDiagramZoom.pointers.set(event.pointerId, diagramLocalPoint(event));
  el.diagramModalBody.classList.add("is-panning");

  const points = diagramPointers();
  if (points.length >= 2) beginDiagramPinch();
  else beginDiagramPan(points[0]);
}

function handleDiagramPointerMove(event) {
  if (!currentDiagramZoom?.pointers.has(event.pointerId)) return;
  preventCancelableScroll(event);
  currentDiagramZoom.pointers.set(event.pointerId, diagramLocalPoint(event));

  const points = diagramPointers();
  if (points.length >= 2) {
    if (currentDiagramZoom.mode !== "pinch") beginDiagramPinch();
    const distance = pointerDistance(points) || currentDiagramZoom.pinchStartDistance;
    const center = pointerCenter(points);
    const nextScale = clampDiagramScale(currentDiagramZoom.pinchStartScale * (distance / currentDiagramZoom.pinchStartDistance));
    currentDiagramZoom.scale = nextScale;
    currentDiagramZoom.x = center.x - currentDiagramZoom.pinchAnchorX * nextScale;
    currentDiagramZoom.y = center.y - currentDiagramZoom.pinchAnchorY * nextScale;
    applyDiagramTransform();
    return;
  }

  if (currentDiagramZoom.mode !== "pan") beginDiagramPan(points[0]);
  const local = diagramLocalPoint(event);
  currentDiagramZoom.x = currentDiagramZoom.panStartX + local.x - currentDiagramZoom.pointerStartX;
  currentDiagramZoom.y = currentDiagramZoom.panStartY + local.y - currentDiagramZoom.pointerStartY;
  applyDiagramTransform();
}

function handleDiagramPointerEnd(event) {
  if (!currentDiagramZoom?.pointers.has(event.pointerId)) return;
  currentDiagramZoom.pointers.delete(event.pointerId);
  el.diagramModalBody.releasePointerCapture?.(event.pointerId);

  const points = diagramPointers();
  if (points.length >= 2) {
    beginDiagramPinch();
  } else if (points.length === 1) {
    beginDiagramPan(points[0]);
  } else {
    currentDiagramZoom.mode = "";
    el.diagramModalBody.classList.remove("is-panning");
  }
}

// Every Supabase Storage image URL referenced by a deck's markdown. Used to
// pre-cache a pulled deck's images so it reads offline later — the service
// worker's cache-first rule only covers images it has already SEEN, which means
// only the ones that happened to be on screen while online.
const SUPABASE_IMAGE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/[^\s)"'<>]+/gi;

function collectDeckImageUrls(snapshot) {
  const seen = new Set();
  const scan = (text) => {
    for (const match of String(text || "").matchAll(SUPABASE_IMAGE_URL_PATTERN)) seen.add(match[0]);
  };
  scan(snapshot?.notes);
  for (const card of snapshot?.cards || []) {
    scan(card.question);
    scan(card.answer);
  }
  return Array.from(seen);
}

// Hand a deck's image URLs to the service worker to warm its image cache.
// Fire-and-forget: this is an optimisation, and a controller that isn't ready
// yet (first load, before the SW has claimed the page) just means the images
// get cached the normal way — on first view, while online.
export function warmDeckImageCache(snapshot) {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
  const urls = collectDeckImageUrls(snapshot);
  if (!urls.length) return;
  try {
    navigator.serviceWorker.controller.postMessage({ type: "cache-images", urls });
  } catch (error) {
    console.warn("Could not warm the image cache", error);
  }
}

let serviceWorkerRegistered = false;
// Kept so the App Info modal's "Check for updates" can poke the worker on
// demand (see refreshAppInfo).
let serviceWorkerRegistration = null;

// ── Update state, shared with the App Info modal ────────────────────────────
// True once a newer worker has installed and is waiting to take over.
let updateIsWaiting = false;
// True once an install has been discarded before taking over — a release that
// could not be downloaded. Distinct from "no update": the difference decides
// whether the honest answer is "you're up to date" or "an update exists and
// this device keeps failing to get it".
let updateDownloadFailed = false;
// Set by the service worker when it had to serve one release's bytes under
// another release's URL (see announceMixedBuild in sw.js). Holds the URLs it
// happened to, because the App Info screen otherwise CANNOT detect this: it
// reads the ?v= off the <script> attribute, which is the URL that was
// requested, not the bundle that actually ran.
const mixedBuildUrls = new Set();

function isMixedBuild() {
  if (mixedBuildUrls.size > 0) return true;
  // Self-detection, for the load where the worker's message never arrived: if
  // the URL this file was fetched from carries a different stamp than the one
  // compiled into it, the bytes running now are not the bytes that URL names.
  const requested = requestedAppVersion();
  return Boolean(requested && requested !== BUILD_STAMP);
}

let updateBannerEl = null;

// A persistent, dismissible bar — deliberately not a toast. A toast for "your
// app is out of date" is a message that disappears before it can be acted on,
// which is how everyone stayed on the old release while the app believed it had
// told them.
function showUpdateBanner() {
  updateIsWaiting = true;
  updateDownloadFailed = false;
  markUpdateAvailableInMenu();
  if (updateBannerEl) return;

  updateBannerEl = document.createElement("div");
  updateBannerEl.className = "update-banner";
  updateBannerEl.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "update-banner-text";
  text.textContent = "A new version of Recall is ready.";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "update-banner-action";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => {
    // Straight to the waiting worker if there is one: reloading alone does not
    // promote it when the page still has a controller, so without this the
    // button would appear to do nothing on the first press.
    const waiting = serviceWorkerRegistration?.waiting;
    if (waiting) {
      try { waiting.postMessage({ type: "skip-waiting" }); } catch (_) { /* fall through */ }
    }
    location.reload();
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "update-banner-dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    updateBannerEl?.remove();
    updateBannerEl = null;
    // The dot in the menu deliberately stays: dismissing the bar means "not
    // now", not "pretend this build is current".
  });

  updateBannerEl.append(text, reload, dismiss);
  document.body.appendChild(updateBannerEl);
}

function setUpdateFailedHint() {
  // Only meaningful if nothing is waiting — a redundant worker that was simply
  // superseded by a newer one is not a failure.
  if (updateIsWaiting) return;
  updateDownloadFailed = true;
  markUpdateAvailableInMenu();
}

// A dot on the hamburger button, which is the one control always on screen.
// The App Info modal is behind it, so this is what makes the modal findable at
// the moment it has something to say.
function markUpdateAvailableInMenu() {
  document.getElementById("mobileMenuBtn")?.classList.add("has-update");
  document.getElementById("appInfoBtn")?.classList.add("has-update");
}

function registerServiceWorker() {
  if (serviceWorkerRegistered) return;
  if (!pwaAssetsSupported()) return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  // Never run the worker against a dev server. Versioned assets (app.js?v=…)
  // are cache-first and deliberately never revalidated — that is what makes a
  // release load instantly — but it also means an edit to app.js WITHOUT a new
  // ?v= is invisible forever: the browser keeps serving the bundle it cached
  // under that URL, so the page reloads into frozen code and the fix looks
  // broken. Fine for releases, useless while editing. Unregister anything a
  // previous visit left behind and drop its caches, so localhost always runs
  // the files on disk.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    serviceWorkerRegistered = true;
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then((unregistered) => caches.keys()
        // Only the versioned app shell. The image cache holds the user's
        // uploaded pictures and is spared here for the same reason the worker
        // spares it on every release — re-downloading them is pure waste. It
        // has to be named explicitly: it shares the "recall-" prefix, and back
        // when shell caches were "recall-v…" the prefix alone happened to
        // exclude it.
        .then((keys) => keys.filter((key) => key.startsWith("recall-") && key !== "recall-images-v1"))
        .then((stale) => Promise.all(stale.map((key) => caches.delete(key))).then(() => stale.length))
        .then((cleared) => {
          // Reload only when something was actually removed, so this settles
          // after one pass instead of looping. The page that reached here was
          // still being served by the worker, so it needs the reload to pick
          // up the files on disk.
          if (unregistered.some(Boolean) || cleared) location.reload();
        }))
      .catch((error) => console.warn("Could not unregister dev service worker", error));
    return;
  }

  serviceWorkerRegistered = true;
  // Ask the worker to re-fetch any offline asset its install failed to get.
  // The install's third-party precache is best-effort, so a first run on a bad
  // connection leaves the app permanently missing libraries offline — no
  // markdown, no formulas, no export — and nothing retried, because the cache
  // is only rebuilt when the worker's version changes. Sent once the worker is
  // in control, and again whenever the connection comes back, which is exactly
  // when the gap can be filled.
  const requestOfflineCacheRepair = () => {
    navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: "repair-offline-cache" }))
      .catch(() => { /* no worker yet — the next online event tries again */ });
  };

  // A worker that takes over a page which already had one has just swapped the
  // app's files underneath a page still running the PREVIOUS release's JS. The
  // markup can already be the new build while the behaviour is the old one, so
  // half the app quietly does the old thing. It used to just show a toast and
  // wait — but nobody reads it and everyone kept running the old release for
  // days, which is exactly the "browsers serve the stale version" report.
  // Reload straight into the new release instead; notes/cards autosave on
  // input, so at most a keystroke is in flight. The sessionStorage guard keeps
  // a flapping update (bad deploy, oscillating server) from reload-looping the
  // tab: one automatic reload per minute at most.
  // The worker reporting that it served one release's bytes under another
  // release's URL. This is the only way the page can learn it is running a mixed
  // build — see mixedBuildUrls.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "mixed-build") return;
    const known = mixedBuildUrls.size > 0;
    mixedBuildUrls.add(String(event.data.url || ""));
    // Say it once. Repeating it per asset would be three toasts for one fault.
    if (!known) {
      showToast("Some of this app didn't load in the right version — reload when you can", "error");
      markUpdateAvailableInMenu();
    }
  });

  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // first-ever install: this page is already current
      return;
    }
    let lastReload = 0;
    try { lastReload = Number(sessionStorage.getItem("recall:updateReloadAt")) || 0; } catch (_) {}
    if (Date.now() - lastReload < 60_000) {
      showToast("Recall updated — reload to finish", "info");
      return;
    }
    try { sessionStorage.setItem("recall:updateReloadAt", String(Date.now())); } catch (_) {}
    location.reload();
  });

  // A worker that reaches "installed" while this page already has a controller
  // is a release waiting to take over; one that reaches "redundant" without ever
  // installing is a release that FAILED to download. Both were previously
  // invisible — the only automatic signal was controllerchange, which by
  // definition never fires in the second case, and the only manual one was a
  // modal buried in the hamburger drawer that most users never open. So a user
  // whose install kept failing on a bad connection sat on an old build
  // indefinitely with the app insisting nothing was wrong.
  const watchInstallingWorker = (registration) => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateBanner();
      } else if (worker.state === "redundant") {
        // Discarded before it could take over: a failed precache, a quota
        // rejection, or a newer worker superseding it. Only worth saying
        // anything about in the first case, which is the one that repeats.
        setUpdateFailedHint();
      }
    });
  };

  const register = () => {
    // updateViaCache: "none" — the browser's own HTTP cache must never answer
    // the "is there a new sw.js?" check, or a host that serves the worker with
    // cacheable headers delays every release by up to a day (the browser's
    // forced re-check cap). The .update() calls below are the proactive half:
    // without them the check only runs on navigation, so a tab left open for
    // days never sees a release at all.
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((registration) => {
        serviceWorkerRegistration = registration;
        requestOfflineCacheRepair();
        // A worker may already be waiting from a previous visit — updatefound
        // has long since fired for it and will not fire again.
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner();
        watchInstallingWorker(registration);
        registration.addEventListener("updatefound", () => watchInstallingWorker(registration));
        const checkForUpdate = () => registration.update().catch(() => {});
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") checkForUpdate();
        });
        setInterval(checkForUpdate, 30 * 60 * 1000);
      })
      .catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    window.addEventListener("online", requestOfflineCacheRepair);
  };
  // Register after `load` to avoid competing with first-paint fetches — but if
  // the page has already finished loading (this runs from the async auth/boot
  // flow, long after `load` fires), a "load" listener would never run, so
  // register immediately instead. This is why offline previously never worked:
  // the SW was only ever set up inside initAppForUser(), after `load`.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function pwaAssetsSupported() {
  return location.protocol === "http:" || location.protocol === "https:";
}

function installManifestLink() {
  if (!pwaAssetsSupported() || document.querySelector('link[rel="manifest"]')) return;

  const link = document.createElement("link");
  link.rel = "manifest";
  link.href = "manifest.webmanifest";
  document.head.appendChild(link);
}

function createNewDeck({ title = "New Deck", category = defaultDeckCategory, notesMode = false } = {}) {
  const name = String(title || "New Deck").trim() || "New Deck";
  const cat = normalizeDeckCategory(category);
  const doCreate = () => {
    setDeckAutosaveStorageFailed(false);
    state.deckId = null;
    // Detach from any previously-loaded library entry so this new deck saves as
    // its own entry rather than overwriting the deck that was just open.
    state.localDeckId = null;
    state.deckTitle = name;
    state.deckCategory = cat;
    state.notes = "";
    state.sourceTitle = name;
    state.importTitleHint = name;
    state.masterCards = [];
    resetStudyDeck(state.masterCards);
    setViewMode(notesMode ? "notes" : "cards");
    closeImportPanel();
    closeAllCardsPanel();
    showCard();
    setStatus("Created new deck.");
  };
  if (hasActiveDeck()) {
    showConfirmModal("Create a new deck? Unsaved local progress will be lost.", doCreate, { confirmLabel: "Create New" });
  } else {
    doCreate();
  }
}

// Creates a deck inside a folder from the My Decks library: prompts for a title,
// files it under `folderPath`, closes the panel, and drops the user into the new
// deck in notes mode ready to write. The deck is filed under `folderPath` (set on
// state.deckCategory) and persists to the library + cloud on the first edit via
// autosave — the library never stores a truly empty deck.
export function newDeckInFolder(folderPath = "") {
  const cat = normalizeDeckCategory(folderPath);
  const where = cat === defaultDeckCategory ? "" : ` in "${cat}"`;
  showPromptModal("New deck", `Name your new deck${where}. Start adding notes and cards right away.`, "", (title) => {
    // Empty field, "New Deck" placeholder — falls back to that indicative name
    // if left blank, so the field never needs clearing before typing.
    const name = String(title || "").trim() || "New Deck";
    createNewDeck({ title: name, category: cat, notesMode: true });
    closeMyDecksPanel();
    showToast(`New deck "${name}"${where} — add notes or cards to save it`);
  }, { placeholder: "New Deck" });
}


document.getElementById("setupForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = document.getElementById("setupUrl").value.trim();
  const key = document.getElementById("setupKey").value.trim();
  const errEl = document.getElementById("setupError");
  errEl.textContent = "";

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co")) {
      errEl.textContent = "URL should look like: https://xxxxx.supabase.co";
      return;
    }
  } catch {
    errEl.textContent = "URL should look like: https://xxxxx.supabase.co";
    return;
  }
  if (!key || key.length < 20) {
    errEl.textContent = "Anon key looks too short — paste the full key.";
    return;
  }

  saveSupabaseConfig(url, key);
  // Checked, not discarded: initSupabaseClient leaves supabaseClient null when
  // the library is missing, and setupAuthListener would then throw on
  // `null.auth` — so showLoginScreen() below never ran and Connect looked
  // permanently dead, with the real cause (a blocked CDN) never stated.
  if (initSupabaseClient() !== "ok") {
    showLibraryFailedScreen();
    return;
  }
  setupAuthListener();
  showLoginScreen();
});

document.getElementById("offlineBootRetryBtn")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const errEl = document.getElementById("offlineBootError");
  btn.disabled = true;
  if (errEl) errEl.textContent = "";
  try {
    await reloadSupabaseLibrary();
    if (initSupabaseClient() !== "ok") {
      if (errEl) {
        errEl.textContent = navigator.onLine
          ? "Still couldn't load it. A content blocker or network proxy may be blocking cdn.jsdelivr.net."
          : "You're offline — reconnect and try again.";
      }
      return;
    }
    setupAuthListener();
    const session = await getCachedSession();
    if (session?.user) {
      setSignedIn(true);
      await ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        appInitialized = true;
        initAppForUser();
      }
    } else {
      showLoginScreen();
    }
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("offlineBootChangeProjectBtn")?.addEventListener("click", () => {
  clearSupabaseConfig();
  setSupabaseClient(null);
  showSetupScreen();
});

document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const isSignup = document.getElementById("loginForm").dataset.mode === "signup";
  const errEl = document.getElementById("loginError");
  const submitBtn = document.getElementById("loginSubmitBtn");
  errEl.textContent = "";
  errEl.classList.remove("is-notice");
  submitBtn.disabled = true;
  try {
    if (isSignup) {
      const { outcome } = await handleSignup(email, password);
      if (outcome === "already-registered") {
        errEl.textContent = "That email already has an account — switch to Sign In.";
      } else if (outcome === "confirm-email") {
        // Not an error: the account exists, it just can't sign in yet. Said
        // plainly because the alternative — what this used to do — was nothing
        // at all, which reads as a broken button.
        errEl.textContent = "Account created. Check your email for a confirmation link, then sign in.";
        errEl.classList.add("is-notice");
      }
      // "signed-in" needs no message: onAuthStateChange has already swapped the
      // screen out from under this handler.
    } else {
      await handleLogin(email, password);
    }
  } catch (err) {
    errEl.textContent = describeAuthError(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("loginToggleBtn")?.addEventListener("click", () => {
  const form = document.getElementById("loginForm");
  const isSignup = form.dataset.mode === "signup";
  form.dataset.mode = isSignup ? "login" : "signup";
  document.getElementById("loginSubmitBtn").textContent = isSignup ? "Sign In" : "Create Account";
  document.getElementById("loginToggleBtn").textContent = isSignup ? "Create account" : "Back to sign in";
  document.getElementById("loginError").textContent = "";
});

document.getElementById("loginChangeProjectBtn")?.addEventListener("click", () => {
  clearSupabaseConfig();
  setSupabaseClient(null);
  showSetupScreen();
});

document.getElementById("logoutBtn")?.addEventListener("click", handleLogout);

document.getElementById("cancelSyncBtn")?.addEventListener("click", () => {
  el.syncModal.hidden = true;
});

el.sampleBtn?.addEventListener("click", loadSample);
el.fetchBtn.addEventListener("click", fetchUrl);
el.urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fetchUrl();
});
el.importBtn.addEventListener("click", () => {
  openImportPanel();
});
el.myDecksBtn?.addEventListener("click", () => {
  openMyDecksPanel();
});
el.syncNowBtn?.addEventListener("click", () => {
  reconcileAllDecks({ explicit: true });
});

// ── User-defined auto-sync ──────────────────────────────────────────────────
// Runs the same two-way reconcile as "Sync Now" on a cadence the user picks, so
// they don't have to click it. Device-local (each device sets its own).
//
// This used to be a bare setInterval(mins × 60s), which is why auto-sync looked
// like it ran once and then went to sleep:
//
//   • A backgrounded tab has its timers throttled hard (on mobile, often frozen
//     outright), so a 5-minute interval on a phone fires nowhere near every 5
//     minutes — and nothing caught up when the tab came back.
//   • A tick that landed while signed out or offline was dropped entirely, and
//     the next one was a full interval away. Coming back online meant waiting.
//   • An explicit Sync Now didn't reset the interval, so a sync could fire
//     seconds after the user had just synced by hand.
//
// So the schedule is a DEADLINE (autoSyncNextAt) rather than an interval, and a
// 1-second ticker compares it against the clock. Wall-clock time can't be
// throttled away: however long the tab was frozen, the first tick after it wakes
// sees the deadline is past and syncs. The same ticker paints the pill's
// countdown, and every completed sync — background or explicit — re-arms the
// deadline from when it actually finished.
const AUTOSYNC_KEY = "recall_autosync_minutes";
const AUTOSYNC_ALLOWED = new Set([0, 1, 2, 5, 10, 15, 30]);
const AUTOSYNC_TICK_MS = 1000;
let autoSyncTicker = null;
export let autoSyncNextAt = Infinity;

// What a device that has never opened the setting gets. It used to be 0 — off —
// which meant a new user's only syncs were: boot, reconnect, returning to the
// foreground after a minute away, and the manual button. Nothing was broken;
// nothing was scheduled either, and "my decks don't reach my other device" is
// what that feels like. Anyone who once set an interval (including the
// developer) had a completely different experience of the same build.
const AUTOSYNC_DEFAULT_MINUTES = 5;

export function getAutoSyncMinutes() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTOSYNC_KEY);
  } catch (_) {
    raw = null;
  }
  // Absent means "never chosen", which is NOT the same as a stored 0. An
  // explicit "Off" is a real preference and has to survive; only the untouched
  // case gets the default.
  if (raw === null) return AUTOSYNC_DEFAULT_MINUTES;
  const v = parseInt(raw, 10);
  return AUTOSYNC_ALLOWED.has(v) ? v : 0;
}

// Push the next auto-sync a full interval out from now. Called when the cadence
// changes and after every sync completes, so "next in 5m" always means five
// minutes since the last one actually ran, not since some fixed grid.
export function rearmAutoSync() {
  const mins = getAutoSyncMinutes();
  autoSyncNextAt = mins ? Date.now() + mins * 60 * 1000 : Infinity;
  renderSyncCountdown();
}

function autoSyncTick() {
  // Only the repaint is skipped behind a hidden tab — the sync check below
  // still runs, because a backgrounded tab is exactly when an auto-sync is
  // worth having. The countdown is derived from wall-clock time, so it is
  // correct again as soon as the tab is shown.
  if (!document.hidden) renderSyncCountdown();
  if (!getAutoSyncMinutes()) return;
  if (Date.now() < autoSyncNextAt) return;
  // Not syncable right now (signed out, offline, or a sync already running).
  // Leave the deadline in the past so the very next tick that CAN sync does,
  // instead of silently forfeiting this cycle and waiting a whole interval.
  if (!supabaseClient || !isSignedIn || !navigator.onLine || reconcileInFlight) return;
  // reconcileAllDecks re-arms in its finally block; do it here too so a rejected
  // promise (it handles its own errors, but be safe) can't wedge the loop into
  // firing on every single tick.
  rearmAutoSync();
  reconcileAllDecks({ explicit: false });
}

function applyAutoSyncInterval() {
  const mins = getAutoSyncMinutes();
  if (el.autoSyncSelect) el.autoSyncSelect.value = String(mins);
  rearmAutoSync();
  // One ticker for the life of the page: it also drives the countdown, which is
  // wanted even with auto-sync off (it's what says "off").
  if (!autoSyncTicker) autoSyncTicker = setInterval(autoSyncTick, AUTOSYNC_TICK_MS);
}

// Coming back from a frozen tab or a dead connection: check the deadline
// immediately rather than waiting up to a second (and, more importantly, make
// sure a tab that was throttled for an hour syncs the moment it's looked at).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoSyncTick();
});
window.addEventListener("online", autoSyncTick);

function setAutoSyncMinutes(mins) {
  const clean = AUTOSYNC_ALLOWED.has(mins) ? mins : 0;
  try {
    localStorage.setItem(AUTOSYNC_KEY, String(clean));
  } catch (_) {
    /* storage unavailable (private mode) — timer still applies for this session */
  }
  applyAutoSyncInterval();
  showToast(clean ? `Auto-sync on — every ${clean} min${clean === 1 ? "" : "s"}` : "Auto-sync off", "info");
}

el.autoSyncSelect?.addEventListener("change", (e) => {
  setAutoSyncMinutes(parseInt(e.target.value, 10) || 0);
});

// Reflect the saved cadence in the dropdown and start the timer on boot. The
// timer's ticks self-gate on sign-in/online, so it's safe to arm before login.
applyAutoSyncInterval();
// Every static [data-md-icon] button gets its SVG once, at startup.
hydrateMyDecksIcons();

el.closeMyDecksBtn?.addEventListener("click", closeMyDecksPanel);
el.myDecksRefreshBtn?.addEventListener("click", () => { closeMyDecksMoreMenu(); renderMyDecksList(); });

// ── The toolbar's "⋯" menu ──────────────────────────────────────────────────
// Holds Refresh, Expand all, Import EPUB, Restore and every Export All format,
// so the toolbar itself stays a single row at any width.
export function closeMyDecksMoreMenu() {
  if (!el.myDecksMoreMenu || el.myDecksMoreMenu.hidden) return;
  el.myDecksMoreMenu.hidden = true;
  el.myDecksMoreBtn?.setAttribute("aria-expanded", "false");
}

function toggleMyDecksMoreMenu() {
  if (!el.myDecksMoreMenu) return;
  const willOpen = el.myDecksMoreMenu.hidden;
  el.myDecksMoreMenu.hidden = !willOpen;
  el.myDecksMoreBtn?.setAttribute("aria-expanded", String(willOpen));
}

el.myDecksMoreBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleMyDecksMoreMenu(); });
document.getElementById("myDecksMoreCloseBtn")?.addEventListener("click", closeMyDecksMoreMenu);
// The EPUB picker is a <label> whose click opens the file dialog; close the menu
// alongside it so the sheet isn't still sitting there behind the OS dialog.
document.getElementById("myDecksImportEpubBtn")?.addEventListener("click", () => closeMyDecksMoreMenu());
document.addEventListener("click", (e) => {
  if (!e.target.closest(".my-decks-more")) closeMyDecksMoreMenu();
});

// The folder new decks/folders are created under: the cwd in Folder view, else the
// scope-filter value (root when neither is set).
function currentMyDecksFolder() {
  if (state.myDecksView === "folder") return state.myDecksCwd || "";
  return el.myDecksCategoryFilter?.value || "";
}
el.myDecksNewFolderBtn?.addEventListener("click", () => createFolder(currentMyDecksFolder()));
el.myDecksNewDeckBtn?.addEventListener("click", () => newDeckInFolder(currentMyDecksFolder()));

// ── Import into a folder ────────────────────────────────────────────────────
// The third way to put something in the folder you're looking at, alongside New
// deck and New folder — previously every import landed in Uncategorized no
// matter where you started it from, leaving you to drag the deck back. One
// shared <input type="file"> serves both the toolbar button and every folder
// row's own Import button; this records which folder opened it, since the change
// event can't tell them apart.
let myDecksImportFolder = "";

export function importIntoFolder(folderPath = "") {
  const input = el.myDecksImportInput;
  if (!input) return;
  myDecksImportFolder = folderPath || "";
  closeMyDecksMoreMenu();
  input.value = ""; // re-picking the same file must still fire `change`
  input.click();
}

el.myDecksImportBtn?.addEventListener("click", () => importIntoFolder(currentMyDecksFolder()));

el.myDecksImportInput?.addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  const folder = myDecksImportFolder;
  // An EPUB has its own preview modal and re-renders My Decks itself when it is
  // done, so the library stays open for it. EVERYTHING else goes through the
  // Import panel's review step, which must be closed over — the library sits at
  // z-index 100 and the import panel at 50, so leaving it open buried the whole
  // review step behind it and picking files looked like it did nothing at all.
  // (A batch still returns to the library afterwards: commitSeparateDecks
  // reopens it at the folder it wrote to.)
  const allEpub = files.every((file) => isEpubName(file.name) || /epub/i.test(file.type));
  if (!allEpub) closeMyDecksPanel();
  loadFiles(files, folder);
});

// A dismissed picker must not leave a folder armed for whatever import happens
// next. (loadFile and loadDeckFromLibrary both reset it too — this is just the
// earliest place to notice.)
el.myDecksImportInput?.addEventListener("cancel", () => {
  setPendingImportFolder(null);
});
el.myDecksImportEpubInput?.addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = ""; // allow re-importing the same file again
  if (file) importEpubFile(file).catch(reportEpubImportCrash);
});

// View switcher (Grid / Folder / Tree) — pure presentation, repaint from cache.
el.myDecksViewSwitch?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mydecks-view]");
  if (!btn) return;
  setMyDecksView(btn.dataset.mydecksView);
  repaintMyDecks();
});

// Display toggle (Tiles / List) — pure presentation, repaint from cache.
el.myDecksDisplayToggle?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mydecks-display]");
  if (!btn) return;
  setMyDecksDisplay(btn.dataset.mydecksDisplay);
  repaintMyDecks();
});

// Expand-all / Collapse-all (Tree view)
el.myDecksTreeToggleAll?.addEventListener("click", () => {
  setAllFoldersExpanded(el.myDecksTreeToggleAll.dataset.expandAll === "1");
  closeMyDecksMoreMenu();
});

// Title search (debounced) — filters the cached set, no refetch.
let myDecksSearchTimer = null;
el.myDecksSearch?.addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(myDecksSearchTimer);
  myDecksSearchTimer = setTimeout(() => { state.myDecksSearch = value; repaintMyDecks(); }, 160);
});

// Close any open deck-tile overflow menu on an outside click or Escape.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".deck-tile-overflow")) closeAllDeckTileMenus();
});
// Escape is handled by closeTopmostOverlay(), which peels these menus back
// before the panel itself — a listener here would close both at once.
el.closeImportBtn.addEventListener("click", closeImportPanel);
el.editDeckTitleBtn.addEventListener("click", editCurrentDeckTitle);
el.editDeckCategoryBtn?.addEventListener("click", editCurrentDeckCategory);

// ── My Decks: selection, bulk actions, category filter, export-all ─────────
el.myDecksCategoryFilter?.addEventListener("change", () => renderMyDecksList());

// Sort order — pure presentation, repaint from cache.
el.myDecksSort?.addEventListener("change", () => {
  setMyDecksSort(el.myDecksSort.value);
  repaintMyDecks();
});

el.myDecksSelectAllCheckbox?.addEventListener("change", (e) => {
  const checked = e.target.checked;
  const host = el.myDecksBody || el.myDecksListTable;
  host?.querySelectorAll(".my-deck-row-checkbox, .my-folder-row-checkbox").forEach((cb) => {
    cb.checked = checked;
  });
  updateMyDecksBulkBar();
});

document.getElementById("myDecksBulkLoadBtn")?.addEventListener("click", () => {
  const selections = selectedMyDecks();
  if (selections.length) loadSelectedMyDecks(selections);
});

document.getElementById("myDecksBulkCategoryBtn")?.addEventListener("click", () => {
  const selections = selectedMyDecks();
  if (selections.length) categorizeSelectedMyDecks(selections);
});

document.getElementById("myDecksBulkDeleteBtn")?.addEventListener("click", () => {
  // Folders are passed alongside the decks (rather than guarding on deck count)
  // so a checked empty folder is still deletable.
  deleteSelectedMyDecks(selectedMyDecks(), selectedMyFolders());
});

{
  const bulkExportBtn = document.getElementById("myDecksBulkExportBtn");
  const bulkExportMenu = document.getElementById("myDecksBulkExportMenu");
  if (bulkExportBtn && bulkExportMenu) {
    bulkExportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const shouldOpen = bulkExportMenu.hidden;
      closeWebDeckExportMenus(bulkExportMenu);
      bulkExportMenu.hidden = !shouldOpen;
      bulkExportBtn.setAttribute("aria-expanded", String(shouldOpen));
    });
    bulkExportMenu.querySelectorAll("[data-bulk-export]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        bulkExportMenu.hidden = true;
        bulkExportBtn.setAttribute("aria-expanded", "false");
        const selections = selectedMyDecks();
        if (selections.length) exportSelectedMyDecks(selections, btn.dataset.bulkExport);
      });
    });
  }

  // Export All no longer has a button of its own — its formats are a group
  // inside the "⋯" menu, so picking one closes that menu instead.
  el.myDecksMoreMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-export-all]");
    if (!button) return;
    event.stopPropagation();
    closeMyDecksMoreMenu();
    if (button.dataset.exportAll === "backup") {
      exportLibraryBackupZip();
    } else {
      exportAllMyDecks(button.dataset.exportAll);
    }
  });

  const restoreBtn = document.getElementById("myDecksRestoreBtn");
  const restoreInput = document.getElementById("restoreFileInput");
  if (restoreBtn && restoreInput) {
    restoreBtn.addEventListener("click", () => { closeMyDecksMoreMenu(); restoreInput.click(); });
    restoreInput.addEventListener("change", async () => {
      const file = restoreInput.files && restoreInput.files[0];
      restoreInput.value = ""; // allow re-selecting the same file later
      if (file) await runRestoreFlow(file);
    });
  }
}
el.styleBtn.addEventListener("click", openStylePanel);
el.closeStyleBtn.addEventListener("click", closeStylePanel);
el.storageBtn?.addEventListener("click", openStoragePanel);
el.closeStorageBtn?.addEventListener("click", closeStoragePanel);
el.storageRefreshBtn?.addEventListener("click", () => refreshStorageReport());
el.storageBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-storage-action]");
  if (button && !button.disabled) runStorageAction(button.dataset.storageAction);
});
el.resetStyleBtn?.addEventListener("click", resetStyleProfile);
el.syncUpBtn.addEventListener("click", syncStyleToWeb);
el.syncDownBtn.addEventListener("click", () => loadStyleFromWeb(true));
// `button[...]`, not a bare attribute selector. applyActiveStyleSettings puts
// data-style-profile on <html>, and closest() walks all the way to the root —
// so `closest("[data-style-profile]")` matched the DOCUMENT ELEMENT for every
// click that landed anywhere in this panel. Two consequences, one of them old:
// it silently called switchStyleEditProfile(<device profile>), so clicking a
// label while editing the Mobile profile on a desktop screen bounced you back
// to Desktop; and it made every branch below it unreachable, because the first
// one always matched. The buttons are the only real targets here, so say so.
el.styleControls.addEventListener("click", (event) => {
  const profileButton = event.target.closest("button[data-style-profile]");
  if (profileButton) { switchStyleEditProfile(profileButton.dataset.styleProfile); return; }

  const densityButton = event.target.closest("button[data-style-density]");
  if (densityButton) { applyStyleDensity(densityButton.dataset.styleDensity); return; }

  const resetButton = event.target.closest("button[data-style-reset]");
  if (resetButton) { resetStyleField(resetButton.dataset.styleReset); return; }
});
el.styleControls.addEventListener("input", (event) => {
  if (event.target.matches("[data-style-key]")) {
    handleStyleControlChange();
  }
});
el.styleControls.addEventListener("change", (event) => {
  if (event.target.matches("[data-style-key]")) {
    handleStyleControlChange();
  }
});
// Normalization happens HERE, not on every keystroke. updateStyleControls
// refuses to touch the focused field (that's what fixed typing), so this is
// where "28" finally becomes "28px" and a field left empty gets the default
// put back into it.
el.styleControls.addEventListener("focusout", (event) => {
  if (!event.target.matches("[data-style-key]")) return;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  const key = event.target.dataset.styleKey;
  const normalized = normalizeStyleValue(key, event.target.value, defaults[key]);
  // Leaving a field you didn't touch is not an edit. Without this, tabbing
  // through the panel would mark the profile "Unsynced" and set styleTouched,
  // which also makes Sync Down refuse to overwrite (see loadStyleFromWeb).
  if (normalized === event.target.value) return;
  event.target.value = normalized;
  handleStyleControlChange();
});
el.stylePanel.addEventListener("touchstart", handleStylePanelTouchStart, { passive: true });
el.stylePanel.addEventListener("touchmove", handleStylePanelTouchMove, { passive: false });
el.stylePanel.addEventListener("wheel", handleStylePanelWheel, { passive: false });

el.allCardsPanel.addEventListener("touchstart", handleStylePanelTouchStart, { passive: true });
el.allCardsPanel.addEventListener("touchmove", handleStylePanelTouchMove, { passive: false });
el.allCardsPanel.addEventListener("wheel", handleStylePanelWheel, { passive: false });

el.importPanel.addEventListener("touchstart", handleStylePanelTouchStart, { passive: true });
el.importPanel.addEventListener("touchmove", handleStylePanelTouchMove, { passive: false });
el.importPanel.addEventListener("wheel", handleStylePanelWheel, { passive: false });

if (el.myDecksPanel) {
  el.myDecksPanel.addEventListener("touchstart", handleStylePanelTouchStart, { passive: true });
  el.myDecksPanel.addEventListener("touchmove", handleStylePanelTouchMove, { passive: false });
  el.myDecksPanel.addEventListener("wheel", handleStylePanelWheel, { passive: false });
}

el.diagramModalBody.addEventListener("wheel", handleDiagramWheel, { passive: false });
el.diagramModalBody.addEventListener("pointerdown", handleDiagramPointerDown);
el.diagramModalBody.addEventListener("pointermove", handleDiagramPointerMove);
el.diagramModalBody.addEventListener("pointerup", handleDiagramPointerEnd);
el.diagramModalBody.addEventListener("pointercancel", handleDiagramPointerEnd);

el.allCardsBtn.addEventListener("click", openAllCardsPanel);

// ── Quick Notes board wiring ─────────────────────────────────────
// The toolbar button always opens a fresh board — pass no args, since a click
// event object would otherwise arrive as the options argument.
el.quickNotesBoardBtn?.addEventListener("click", () => openQuickNotesBoard());
el.appBackBtn?.addEventListener("click", goNavBack);
el.qnCloseBtn?.addEventListener("click", closeQuickNotesBoard);
el.qnManageBtn?.addEventListener("click", openQnCatModal);
el.qnFilters?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-qn-filter]");
  if (!btn) return;
  const key = btn.dataset.qnFilter;
  // "All" clears the selection; every other chip toggles on top of it.
  if (key === "all") qnBoard.filters.clear();
  else if (qnBoard.filters.has(key)) qnBoard.filters.delete(key);
  else qnBoard.filters.add(key);
  renderQuickNotesBoard();
});
// Column count changes on resize, so the cards rewrap and every span is stale.
window.addEventListener("resize", () => {
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) layoutQuickNotesGrid();
});
el.qnSearch?.addEventListener("input", () => {
  qnBoard.query = el.qnSearch.value || "";
  renderQuickNotesBoard();
});
// Escape inside the search box clears it first, and only closes the board once
// the box is already empty.
el.qnSearch?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !el.qnSearch.value) return;
  event.stopPropagation();
  el.qnSearch.value = "";
  qnBoard.query = "";
  renderQuickNotesBoard();
});
el.qnBody?.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-qn-jump]");
  if (jump) { jumpToQuickNoteSource(jump.dataset.qnJump); return; }
  const copy = event.target.closest("[data-qn-copy]");
  if (copy) { copyQuickNote(copy.dataset.qnCopy, copy); return; }
  const catBtn = event.target.closest("[data-qn-cat-btn]");
  if (catBtn) { event.stopPropagation(); openQnCatMenu(catBtn.dataset.qnCatBtn, catBtn); }
});
// Floating category-picker actions (menu lives on document.body).
document.addEventListener("click", (event) => {
  const setItem = event.target.closest("[data-qn-set]");
  if (setItem && setItem.closest(".qn-cat-menu")) {
    const menu = setItem.closest(".qn-cat-menu");
    assignQuickNoteCategory(menu.dataset.card, setItem.dataset.qnSet);
    return;
  }
  const manageItem = event.target.closest("[data-qn-manage]");
  if (manageItem && manageItem.closest(".qn-cat-menu")) {
    closeQnCatMenu();
    openQnCatModal();
  }
});
// Manage-categories modal
el.qnCatModalClose?.addEventListener("click", closeQnCatModal);
el.qnCatModal?.addEventListener("click", (event) => {
  if (event.target === el.qnCatModal) closeQnCatModal();
});
el.qnCatAddBtn?.addEventListener("click", addQuickNoteCategory);
el.qnCatNewName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addQuickNoteCategory(); }
});
el.qnCatColorPicker?.addEventListener("click", (event) => {
  const swatch = event.target.closest("[data-qn-new-color]");
  if (!swatch) return;
  qnNewColor = swatch.dataset.qnNewColor;
  renderQnColorPicker(el.qnCatColorPicker, qnNewColor, "qn-new-color");
});
el.qnCatList?.addEventListener("click", (event) => {
  const del = event.target.closest("[data-qn-del]");
  if (del) { deleteQuickNoteCategory(del.dataset.qnDel); return; }
  const recolor = event.target.closest("[data-qn-recolor]");
  if (recolor) { openQnRecolorMenu(recolor.dataset.qnRecolor, recolor); return; }
});
el.qnCatList?.addEventListener("change", (event) => {
  const rename = event.target.closest("[data-qn-rename]");
  if (rename) renameQuickNoteCategory(rename.dataset.qnRename, rename.value);
});

el.toggleAllAnswersBtn?.addEventListener("click", () => {
  setAllCardsAnswersVisible(!allCardsAnswersVisible);
});
el.toggleCompactBtn?.addEventListener("click", () => {
  setAllCardsCompact(!allCardsCompact);
});
el.allCardsFilter?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (btn) setAllCardsFilter(btn.dataset.filter);
});
el.closeAllCardsBtn.addEventListener("click", closeAllCardsPanel);
// ── Triple-click a rendered card → open its editor, caret at that spot ──────
// Mirrors the notes triple-click-to-edit, reusing findRawOffsetForRenderedPoint.
//
// The flip is NOT deferred while we wait to see whether a second and third
// click follow. It used to be — a 250ms setTimeout on EVERY single click of
// every card in this list — which is a quarter-second of nothing after each
// tap, paid by everyone, to smooth over a gesture almost nobody uses. The
// study card had already made the opposite call for exactly this reason (see
// tripleClickCardToEditor); this list simply never got the same treatment.
//
// Clicks 1 and 2 cancel out, so on click 3 the face under the pointer IS the
// face the user started on — which is what makes `side` below correct without
// any deferral. The card is then flipped back to it before the editor opens,
// because clicks 1 and 2 leave the DOM mid-gesture.
function tripleClickAllCardToEditor(item, rendered, clientX, clientY) {
  const card = allCardById(item.dataset.cardId);
  if (!card) return;
  const side = rendered.closest(".all-card-answer") ? "answer" : "question";
  const source = side === "answer" ? card.answer : card.question;
  const offset = findRawOffsetForRenderedPoint(rendered, source, clientX, clientY);
  // openAllCardEditor only ever ADDS is-flipped (for the answer side), so an
  // odd number of preceding flips would leave the item showing the wrong face
  // behind the editor. Settle it here, as the study card does.
  item.classList.toggle("is-flipped", side === "answer");
  openAllCardEditor(item, side);
  const textarea = item.querySelector(".all-card-editor [data-all-edit-value]");
  if (!textarea) return;
  const pos = offset != null ? Math.max(0, Math.min(offset, textarea.value.length)) : 0;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  // scrollTextareaToOffset measures the highlight mirror, so it has to be
  // painted first — the editor was only just opened with this card's text.
  refreshHighlightBackdrop(textarea);
  scrollTextareaToOffset(textarea, pos);
}

el.allCardsList.addEventListener("click", (event) => {
  const gotoButton = event.target.closest("[data-all-goto]");
  if (gotoButton) {
    event.stopPropagation();
    goToCard(gotoButton.closest(".all-card").dataset.cardId);
    return;
  }

  const deleteButton = event.target.closest("[data-all-delete]");
  if (deleteButton) {
    event.stopPropagation();
    deleteAllCard(deleteButton.closest(".all-card").dataset.cardId);
    return;
  }

  const addAfterButton = event.target.closest("[data-all-add-after]");
  if (addAfterButton) {
    event.stopPropagation();
    insertCardAfter(addAfterButton.closest(".all-card").dataset.cardId);
    return;
  }

  const editButton = event.target.closest("[data-all-edit-current]");
  if (editButton) {
    event.stopPropagation();
    toggleAllCardEditor(editButton.closest(".all-card"));
    return;
  }

  const statusButton = event.target.closest("[data-all-status]");
  if (statusButton) {
    event.stopPropagation();
    const item = statusButton.closest(".all-card");
    setAllCardStatus(item.dataset.cardId, statusButton.dataset.allStatus);
    return;
  }

  const item = event.target.closest(".all-card");
  if (item && event.target.closest("a, button, textarea, .cloze") === null) {
    const rendered = event.target.closest(".all-card-question .rendered, .all-card-answer .rendered");
    if (rendered && !item.classList.contains("is-editing")) {
      if (event.detail >= 3) {
        // Triple-click: jump into the raw editor. The two flips this gesture
        // already performed cancel out, so we are back on the clicked face.
        tripleClickAllCardToEditor(item, rendered, event.clientX, event.clientY);
      } else {
        // Clicks 1 and 2 both flip, immediately. Flipping is this list's main
        // gesture and must never wait on a maybe-triple-click.
        flipAllCard(item);
      }
      return;
    }
    flipAllCard(item);
  }
});
el.allCardsList.addEventListener("input", (event) => {
  if (event.target.closest(".all-card-editor")) event.stopPropagation();
});
el.allCardsList.addEventListener("dragstart", handleAllCardDragStart);
el.allCardsList.addEventListener("dragover", handleAllCardDragOver);
el.allCardsList.addEventListener("drop", handleAllCardDrop);
el.allCardsList.addEventListener("dragend", handleAllCardDragEnd);
el.allCardsList.addEventListener("dragleave", (event) => {
  if (!el.allCardsList.contains(event.relatedTarget)) clearAllCardDropTargets();
});
el.allCardsList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest(".all-card");
  if (!item || event.target.closest("button, .cloze")) return;
  event.preventDefault();
  flipAllCard(item);
});
el.exportBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  if (el.exportNotesMenu) el.exportNotesMenu.hidden = true;
  el.exportMenu.hidden = !el.exportMenu.hidden;
});
el.exportMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-export]");
  if (!button) return;
  handleExportAction(button.dataset.export, button.dataset.scope);
});
el.exportNotesBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  el.exportMenu.hidden = true;
  el.exportNotesMenu.hidden = !el.exportNotesMenu.hidden;
});
el.exportNotesMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-export-notes]");
  if (!button) return;
  handleExportNotesAction(button.dataset.exportNotes);
});
el.printRoot.addEventListener("click", (event) => {
  if (event.target.closest("[data-print-close]")) {
    closePrintPreview();
    setStatus("Closed PDF preview.");
    return;
  }
  if (event.target.closest("[data-print-now]")) {
    generatePdfDirectly();
  }
});
el.themeBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setThemeMenuOpen(el.themeMenu?.hidden ?? true);
});
el.themeMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-option]");
  if (!button) return;
  setTheme(button.dataset.themeOption);
  setThemeMenuOpen(false);
});
el.fileInput.addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = ""; // re-picking the same files must still fire `change`
  loadFiles(files, null);
});
el.importPasteSourceBtn?.addEventListener("click", () => {
  showImportSourceDrawer(el.importPasteRow?.hidden ? "paste" : null);
});
el.importUrlSourceBtn?.addEventListener("click", () => {
  showImportSourceDrawer(el.importUrlRow?.hidden ? "url" : null);
});
el.importPasteContinueBtn?.addEventListener("click", stagePastedMarkdown);
el.importPasteCancelBtn?.addEventListener("click", () => showImportSourceDrawer(null));
el.pasteMarkdownInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") showImportSourceDrawer(null);
});

// ── Import review step ──────────────────────────────────────────────────────
el.importContentOptions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-import-choice]");
  if (!button || button.disabled || !importStaging) return;
  importStaging.content = button.dataset.importChoice;
  renderImportReview();
});
el.importTargetOptions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-import-choice]");
  if (!button || button.disabled || !importStaging) return;
  importStaging.target = button.dataset.importChoice;
  renderImportReview();
});
el.importDeckListRows?.addEventListener("change", (event) => {
  const box = event.target.closest("[data-import-deck]");
  if (!box || !importStaging) return;
  const deck = importStaging.decks[Number(box.dataset.importDeck)];
  if (deck) deck.selected = box.checked;
  renderImportReview();
});
el.importDeckSelectAll?.addEventListener("change", (event) => {
  if (!importStaging) return;
  importStaging.decks.forEach((deck) => { deck.selected = event.target.checked; });
  renderImportReview();
});
el.importFolderChangeBtn?.addEventListener("click", async () => {
  if (!importStaging) return;
  const chosen = await chooseDeckCategory(importDestinationFolder());
  if (chosen == null || !importStaging) return;
  importStaging.folder = normalizeDeckCategory(chosen);
  renderImportReview();
});
el.importConfirmBtn?.addEventListener("click", commitStagedImport);
el.importStartOverBtn?.addEventListener("click", () => {
  clearImportStaging();
  showImportSourceDrawer(null);
  setStatus("");
});
el.prevCardBtn.addEventListener("click", () => navigateCard(-1, "prev"));
el.nextCardBtn.addEventListener("click", () => navigateCard(1, "next"));
el.knownBtn.addEventListener("click", () => moveCard("known"));
el.reviewBtn.addEventListener("click", () => moveCard("review"));
el.replayReviewBtn.addEventListener("click", () => replayDeck("review"));
el.replayKnownBtn.addEventListener("click", () => replayDeck("known"));
el.replayUncategorizedBtn.addEventListener("click", () => replayDeck("uncategorized"));
el.replayAllBtn.addEventListener("click", () => replayDeck("all"));
el.shuffleBtn.addEventListener("click", shuffleCards);
el.resetBtn.addEventListener("click", resetQuiz);
el.card.addEventListener("click", (event) => {
  if (performance.now() < state.suppressClickUntil) {
    event.preventDefault();
    return;
  }
  // Deck summary replay buttons
  const replayBtn = event.target.closest("[data-replay]");
  if (replayBtn) {
    replayDeck(replayBtn.dataset.replay);
    return;
  }
  // Checked BEFORE the text-selection guard below: a triple-click has already
  // selected the paragraph by the time this fires, so that guard was swallowing
  // the third click and the gesture never reached the editor at all.
  const rendered = event.target.closest?.("#questionView, #answerView");
  if (rendered && event.detail >= 3 && !isCardActionTarget(event.target)) {
    tripleClickCardToEditor(rendered, event.clientX, event.clientY);
    return;
  }
  if (hasCardTextSelection()) return;
  const isDrag = Math.abs(state.dragCurrentX - state.dragStartX) >= 8 || Math.abs(state.dragCurrentY - state.dragStartY) >= 8;
  if (isDrag || isCardActionTarget(event.target)) return;
  flipCard();
});

// ── Triple-click a rendered card face → raw editor, caret at that spot ──────
// The notes view and the All Cards list both have this; the study card didn't,
// so there was no way to jump from a spot in the rendered card to the same spot
// in its markdown. Reuses findRawOffsetForRenderedPoint, exactly as the other
// two do.
//
// Unlike All Cards, the flip is NOT deferred while we wait to see whether a
// second and third click follow: a quarter-second of nothing after tapping the
// card would be far worse than the flicker three fast clicks cause, and flipping
// is the card's main gesture. The clicked side is recovered afterwards instead —
// clicks 1 and 2 cancel out, so the face under the pointer on click 3 is the one
// the user started on, and the card is flipped back to it before its editor
// opens.
function tripleClickCardToEditor(view, clientX, clientY) {
  const card = state.cards[state.current];
  if (!card || view.hidden) return;
  const side = view === el.answerView ? "answer" : "question";
  const offset = findRawOffsetForRenderedPoint(view, side === "answer" ? card.answer : card.question, clientX, clientY);
  const shouldBeFlipped = side === "answer";
  if (state.flipped !== shouldBeFlipped) {
    state.flipped = shouldBeFlipped;
    el.card.classList.toggle("is-flipped", state.flipped);
  }
  // Clears the browser's own triple-click word/paragraph selection, which would
  // otherwise sit behind the editor and make hasCardTextSelection() true.
  window.getSelection()?.removeAllRanges();
  toggleEditMode(side, { cursorOffset: offset });
}
el.card.addEventListener("pointerdown", handlePointerDown);
el.card.addEventListener("pointermove", handlePointerMove);
el.card.addEventListener("pointerup", handlePointerUp);
el.card.addEventListener("pointercancel", handlePointerCancel);
el.card.addEventListener("touchstart", handleTouchStart, { passive: true });
el.card.addEventListener("touchmove", handleTouchMove, { passive: false });
el.card.addEventListener("touchend", handleTouchEnd);
el.card.addEventListener("touchcancel", handleTouchCancel);

document.addEventListener("keydown", (event) => {
  // Ctrl/Cmd+E toggles raw/rendered view — checked first so it still fires
  // while focus is inside the question/answer/notes edit textareas.
  if ((event.ctrlKey || event.metaKey) && (event.key === "e" || event.key === "E")) {
    event.preventDefault();
    if (state.viewMode === "notes") {
      // Same position handoff as the toolbar button (see el.editNotesBtn) —
      // without the offset this always dropped the caret at line 1, so the
      // shortcut and the button disagreed about where raw mode opens.
      isNotesEditing()
        ? commitNotesEditIfActive()
        : enterNotesEditing(rawOffsetForCurrentNotesScroll());
    } else if (state.viewMode === "cards" && state.cards[state.current]) {
      toggleEditMode(state.flipped ? "answer" : "question");
    }
    return;
  }
  // Structural card undo/redo (add/delete/reorder) — checked before the
  // input/textarea guard below so it works from anywhere in the app, but
  // deliberately excluded while a text field is focused so it doesn't fight
  // that field's own native per-keystroke undo (see cardUndoStack comment).
  if ((event.ctrlKey || event.metaKey) && !event.target.matches("input, textarea") && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    event.shiftKey ? redoCardAction() : undoCardAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.target.matches("input, textarea") && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    redoCardAction();
    return;
  }
  if (event.target.matches("input, textarea")) return;
  if (event.key === "Escape") {
    closeTopmostOverlay();
    return;
  }
  // Ctrl/Cmd+. toggles focus mode. Above the viewMode guard below, or it would
  // never fire in the one view it exists for; below the textarea guard, so it
  // can't shadow anything while you're typing raw markdown.
  if ((event.ctrlKey || event.metaKey) && event.key === ".") {
    event.preventDefault();
    setFocusMode(!chromeFocusPinned);
    return;
  }
  // Card shortcuts are meaningless while any modal/panel is open (it either
  // covers the card stage or shouldn't let keys leak through to it) or while
  // the Notes/Highlights view covers the card stage.
  if (anyModalOpen()) return;
  if (state.viewMode !== "cards") return;
  // A focused cloze handles its own Space/Enter (reveal) — don't also flip.
  if (event.target.closest?.(".cloze")) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    flipCard();
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    if (event.key === "ArrowDown") event.preventDefault(); // don't also scroll the page
    navigateCard(1, "next");
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    if (event.key === "ArrowUp") event.preventDefault();
    navigateCard(-1, "prev");
  }
  if (event.key === "k" || event.key === "K") moveCard("known");
  if (event.key === "r" || event.key === "R") moveCard("review");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".theme-select")) {
    setThemeMenuOpen(false);
  }
  if (!event.target.closest(".web-deck-export-wrap, .bulk-export-dropdown")) {
    closeWebDeckExportMenus();
    document.getElementById("myDecksBulkExportBtn")?.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".menu-wrap")) {
    el.exportMenu.hidden = true;
    if (el.exportNotesMenu) el.exportNotesMenu.hidden = true;
  }
});

el.closeDiagramBtn.addEventListener("click", closeDiagramModal);
el.diagramZoomInBtn?.addEventListener("click", () => zoomDiagramBy(1.25));
el.diagramZoomOutBtn?.addEventListener("click", () => zoomDiagramBy(0.8));
el.diagramModal.addEventListener("click", (event) => {
  if (event.target === el.diagramModal) closeDiagramModal();
});

window.addEventListener("afterprint", () => {
  if (printPreviewOpen || el.printRoot.classList.contains("is-preparing") || el.printRoot.classList.contains("is-preview")) {
    closePrintPreview();
  }
});

window.addEventListener("resize", () => {
  scheduleMarkdownTableFit();
  scheduleLiveQuestionFit();
});
if (styleMobileMedia?.addEventListener) {
  styleMobileMedia.addEventListener("change", handleStyleEnvironmentChange);
} else if (styleMobileMedia?.addListener) {
  styleMobileMedia.addListener(handleStyleEnvironmentChange);
}

let appInitialized = false;

function initAppForUser() {
  clearBrowserPersistence();
  setStyleProfiles(loadLocalStyleSettings());
  applyActiveStyleSettings({ force: true });
  renderThemeMenu();
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem(themeStorageKey);
  } catch (error) {
    console.warn("Could not read saved theme", error);
  }
  setTheme(savedTheme || "dark-amoled");
  setStatus("");
  // Start on a clean home screen each load — the last-open deck is no longer
  // auto-restored (only credentials, the saved "My Decks" library, and styles persist).
  showCard();
  setStyleStatus("Local style");
  installManifestLink();
  registerServiceWorker();
  // One-time-per-boot cleanup of snapshots orphaned by a since-fixed race in
  // pullCloudDeckToLibrary (concurrent tabs reconciling the same cloud deck
  // could each mint a different local id; the loser's snapshot was never
  // referenced by the index again and leaked in storage forever). Safe to
  // run regardless of connectivity — it only looks at already-persisted data.
  pruneOrphanedDeckSnapshots().catch((error) => console.warn("Could not prune orphaned deck snapshots", error));
  // Mirror every cloud deck onto this device (and push anything newer locally)
  // so the PWA has a full, up-to-date offline library. Runs in the background.
  if (navigator.onLine) {
    setTimeout(() => reconcileAllDecks({ explicit: false }), 1200);
    // Once per account, well after the sync has had its turn. A project that
    // never had supabase_setup.sql fully applied otherwise announces itself only
    // as things quietly not working — and the person who would have to fix it is
    // the same person who is about to conclude the app is broken.
    setTimeout(() => announceProjectHealthOnce(), 6000);
  }
}

// The health check as a background nudge rather than a screen the user has to
// go and find. Runs once per account per project: the answer only changes when
// somebody runs SQL, so repeating it on every launch would be a network call
// that exists to say the same thing forever.
const HEALTH_CHECKED_KEY = "recall:projectHealthCheckedFor";

async function announceProjectHealthOnce() {
  let marker = null;
  const config = loadSupabaseConfig();
  const userId = (() => {
    try { return localStorage.getItem(LAST_USER_STORAGE_KEY); } catch { return null; }
  })();
  if (!config?.url || !userId) return;
  const signature = `${config.url}::${userId}`;
  try { marker = localStorage.getItem(HEALTH_CHECKED_KEY); } catch (_) {}
  if (marker === signature) return;

  let results;
  try {
    results = await checkProjectHealth();
  } catch (error) {
    console.warn("Background project health check failed", error);
    return;
  }
  // Don't remember a run that couldn't reach the project — it proved nothing,
  // and marking it done would suppress the real check forever.
  if (results.some((r) => r.status === "skip")) return;
  if (results.length === 1 && results[0].status === "fail") return;

  try { localStorage.setItem(HEALTH_CHECKED_KEY, signature); } catch (_) {}

  const broken = results.filter((r) => r.status === "fail" || r.status === "warn");
  if (!broken.length) return;
  showToast(
    `Your Supabase project needs attention — ${broken[0].label.toLowerCase()}. See ☰ → App Info.`,
    "error"
  );
  markUpdateAvailableInMenu();
}

// The on-device deck library is a mirror of ONE account's cloud data. If a
// different account signs in on this device, the previous user's local decks
// must not survive — the next reconcile would push them straight into the new
// account's cloud (and the old tombstones would suppress the new user's own
// decks). The previous user's data is safe in their own cloud account.
export const LAST_USER_STORAGE_KEY = "flashcards_last_user_id";

async function ensureLocalLibraryOwner(userId) {
  if (!userId) return;
  try {
    const previous = localStorage.getItem(LAST_USER_STORAGE_KEY);
    if (previous && previous !== String(userId)) {
      await clearAllDeckSnapshots();
      localStorage.removeItem(LOCAL_DECKS_INDEX_KEY);
      localStorage.removeItem(LOCAL_DECK_TOMBSTONES_KEY);
      // Observations about the previous account's decks say nothing about this
      // one's, and a stale entry is a head start toward deleting a deck.
      localStorage.removeItem(MISSING_DECK_WATCH_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_ERROR_KEY);
      localStorage.removeItem(LAST_BG_SYNC_PROBLEM_KEY);
      // Unscoped, unlike the quick-note queues, so it would be replayed by
      // whoever signs in next — uploading one account's style into another's
      // row on a shared device.
      localStorage.removeItem(PENDING_STYLE_KEY);
      localStorage.removeItem(deckStorageKey);
      // Persisted state was cleared but the OPEN DECK was not: state.deckId,
      // masterCards and notes survived the switch in memory, so the next
      // autosave filed the previous account's deck into this one's library and
      // the next reconcile pushed it to their cloud.
      state.localDeckId = null;
      state.deckId = null;
      state.masterCards = [];
      // Nothing repaints on this path, so the setViewMode net never runs — the
      // raw editor would sit there still holding the PREVIOUS account's note,
      // ready to be typed back into whatever this account opens first.
      discardNotesEditingForDeckSwap();
      state.notes = "";
      console.log("Cleared local deck library — different account signed in.");
    }
    localStorage.setItem(LAST_USER_STORAGE_KEY, String(userId));
  } catch (error) {
    console.warn("Could not verify local library owner", error);
  }
}

// The other half of the offline-SIGNED_OUT forgiveness in setupAuthListener.
// Being lenient about a refresh that failed with no network is only correct if
// something tries again once there IS a network — otherwise `isSignedIn` stays
// false, autoSyncTick and reconcileAllDecks both bail on it without a word, and
// the app goes on looking signed in while never syncing again until a reload.
// That is the shape of "sync just stopped working" for a phone that spent a
// week in a pocket.
let sessionRecoveryInFlight = false;

async function recoverSessionIfPossible() {
  if (sessionRecoveryInFlight) return;
  if (isSignedIn || !supabaseClient || !navigator.onLine) return;
  if (!loadSupabaseConfig()) return;
  sessionRecoveryInFlight = true;
  try {
    // getSession() refreshes an expired access token when the refresh token is
    // still good, which is exactly the case this exists for.
    const session = await getCachedSession();
    if (session?.user) {
      setSignedIn(true);
      await ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        appInitialized = true;
        initAppForUser();
      }
      refreshSyncIndicatorBaseline();
      return;
    }
    // Genuinely signed out, and now demonstrably online — so say so instead of
    // leaving the app in a state that looks signed in and syncs nothing.
    if (!document.getElementById("loginOverlay")?.hidden) return; // already there
    setSyncIndicator("signedout");
    reportBackgroundSyncProblem(
      "signed-out",
      "Signed out — sign in again to resume syncing. Your decks are safe on this device."
    );
  } catch (error) {
    console.warn("Session recovery attempt failed", error);
  } finally {
    sessionRecoveryInFlight = false;
  }
}

window.addEventListener("online", () => { recoverSessionIfPossible(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recoverSessionIfPossible();
});

let authListenerSubscription = null;

function setupAuthListener() {
  if (authListenerSubscription) {
    authListenerSubscription.unsubscribe();
    authListenerSubscription = null;
  }
  const { data } = supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session?.user) {
      setSignedIn(true);
      await ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        appInitialized = true;
        initAppForUser();
      }
    } else if (event === "SIGNED_OUT") {
      setSignedIn(false);
      const wasExplicit = explicitLogout;
      // Reset unconditionally. It used to be cleared only past the offline
      // guard below, so one sign-out attempt made while offline left it true for
      // the life of the page — and the next failed refresh, which should have
      // been forgiven, then threw the user out of their offline decks.
      setExplicitLogout(false);
      // Only drop to the login screen for a real sign-out. A failed token
      // refresh while offline also emits SIGNED_OUT — ignore it so the user
      // isn't locked out of their offline decks. recoverSessionIfPossible()
      // picks this back up when the connection returns; without it the session
      // stayed dead and every subsequent sync no-opped in silence.
      if (!wasExplicit && !navigator.onLine) return;
      appInitialized = false;
      showLoginScreen();
    }
  });
  authListenerSubscription = data.subscription;
}

async function bootApp() {
  // Before anything reads a deck: set up the IndexedDB-backed deck store
  // (and migrate any pre-existing localStorage snapshots into it) so every
  // downstream readDeckSnapshot/writeDeckSnapshot call sees a consistent
  // picture from the very first render. requestPersistentStorage is
  // best-effort and doesn't need to block boot; the math repair DOES need to
  // finish before any deck can be opened, so it's awaited.
  await initDeckStorage();
  requestPersistentStorage();
  await runEscapedMathRepair();

  let status = initSupabaseClient();

  // A configured device whose library didn't arrive gets one patient retry
  // before being told anything: the script is a blocking tag, so if it is merely
  // slow rather than blocked it will land within this window.
  if (status === "no-library" && loadSupabaseConfig()) {
    if (await waitForSupabaseLibrary()) status = initSupabaseClient();
  }

  if (status === "no-config") {
    showSetupScreen();
    return;
  }
  if (status !== "ok") {
    // Deliberately NOT the setup screen. See initSupabaseClient.
    showLibraryFailedScreen();
    return;
  }

  setupAuthListener();

  // Use the cached session (local, no network) so offline / flaky-network loads
  // still let a signed-in user reach their decks instead of the login wall.
  const session = await getCachedSession();
  if (session?.user) {
    setSignedIn(true);
    await ensureLocalLibraryOwner(session.user.id);
    showAuthenticatedUI();
    if (!appInitialized) {
      appInitialized = true;
      initAppForUser();
    }
    // Only on the signed-in path: the setup, library-failed and login screens
    // have no diagrams to draw, no archives to write and nothing to paste into.
    warmDeferredLibraries();
  } else {
    showLoginScreen();
  }
}

// Set up offline support up front, regardless of Supabase config or auth state.
// The service worker and its precache are what make the app usable offline, so
// they must not be gated behind login or a configured cloud project — a logged
// -out user on the login/setup screen should still get the cached app shell and
// all rendering dependencies. (initAppForUser() also calls these post-login; both
// are idempotent.)
installManifestLink();
registerServiceWorker();
// Independent of auth and of any deck being open: the login screen has input
// fields too, and the listener is two cheap handlers on visualViewport.
trackKeyboardInset();
// Must run before the first navigation, so history.replaceState stamps OUR
// entry as the base rather than leaving whatever the page loaded with.
initBackGesture();

bootApp();

// Commit any in-progress edit into the session before the tab is hidden or closed.
export function flushWorkingDeck() {
  try {
    commitEditIfActive();
  } catch (error) {
    console.warn("Could not commit active edit before save", error);
  }
  // The working-deck localStorage snapshot that used to be taken here is gone —
  // it was write-only (see persistWorkingDeck) and on a large deck it meant a
  // multi-megabyte synchronous JSON.stringify on every single app switch, which
  // on a phone PWA is constant. The durable save below is the one that matters.
  //
  // If the tab/process is killed right after this — the whole reason this
  // handler exists — an edit committed above but not yet flushed by the
  // debounced scheduleDeckAutosave() timer would otherwise never reach the
  // library, and the next reconcile wouldn't even know it happened.
  //
  // saveDeckToLibrarySync, deliberately NOT the async saveDeckToLibrary: this
  // runs from pagehide/visibilitychange, and there is no guarantee an awaited
  // IndexedDB round trip gets to complete before the page is torn down — an
  // OS killing a backgrounded phone app doesn't wait for pending disk I/O.
  // The sync version reads the (already cache-resident, see its own comment)
  // previous snapshot with zero I/O, so by the time this line returns the
  // write has genuinely been issued — pendingDeckWrites already reflects it —
  // and journalPendingDeckWrites below has something real to write down.
  saveDeckToLibrarySync({ silent: true });
  // That write itself still reaches IndexedDB asynchronously in the
  // background. Mirror it into a synchronous localStorage journal so the next
  // boot can replay it — without this, the last edit before a phone kills the
  // backgrounded app is lost.
  journalPendingDeckWrites();
}
// Deck storage is asynchronous now (IndexedDB), so a large amount of this app
// runs in promises — and a promise nobody awaited that rejects is completely
// silent by default. That is the worst possible failure mode for something
// people rely on daily: the app looks like it worked. Nothing here can repair
// the operation, but it makes the failure visible instead of invisible, so a
// save/pin/sync that quietly didn't happen is at least reported once.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.error("Unhandled promise rejection", reason);
  // Storage-shaped failures are the ones worth interrupting for: they mean a
  // write may not have landed. Anything else stays in the console.
  if (isQuotaExceededError(reason) || /indexeddb|objectstore|transaction|database/i.test(String(reason?.name || reason?.message || reason))) {
    showToast("Something didn't save correctly — reload the app to be safe", "error");
  }
});

window.addEventListener("pagehide", () => {
  flushWorkingDeck();
  // Blob URLs for still-queued images are per-document; releasing them here
  // keeps a long-lived PWA session from accumulating them across navigations.
  revokeLocalImageUrls();
});

// How long the app has to have been in the background before returning to it is
// worth a sync. Short enough that picking the phone back up gets fresh data;
// long enough that flicking between apps doesn't fire one every few seconds.
const FOREGROUND_SYNC_IDLE_MS = 60000;
let lastHiddenAt = 0;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    lastHiddenAt = Date.now();
    flushWorkingDeck();
    return;
  }
  // Coming back to a backgrounded PWA used to show whatever was on screen when
  // you left it until the next auto-sync tick (off by default) — so on a phone,
  // where the app is backgrounded constantly, edits from another device could
  // sit unseen indefinitely. reconcileAllDecks self-gates on sign-in and
  // connectivity and dedupes overlapping runs, so this is safe to just call.
  if (!lastHiddenAt || Date.now() - lastHiddenAt < FOREGROUND_SYNC_IDLE_MS) return;
  lastHiddenAt = 0;
  if (!isSignedIn || !navigator.onLine) return;
  reconcileAllDecks({ explicit: false });
});

// Surface connectivity so it's obvious cloud actions are paused while offline.
function updateOnlineIndicator() {
  const indicator = document.getElementById("offlineIndicator");
  if (indicator) indicator.hidden = navigator.onLine;
}
let onlineReconcileTimer = null;
window.addEventListener("online", () => {
  updateOnlineIndicator();
  updateDeckEmptyStatus();
  showToast("Back online", "success");
  // Connectivity returned — reconcile the local mirror with the cloud. Debounced
  // so a flaky connection flapping doesn't kick off overlapping syncs.
  if (onlineReconcileTimer) clearTimeout(onlineReconcileTimer);
  onlineReconcileTimer = setTimeout(() => {
    onlineReconcileTimer = null;
    reconcileAllDecks({ explicit: false });
  }, 1500);
});
window.addEventListener("offline", () => {
  updateOnlineIndicator();
  updateDeckEmptyStatus();
  showToast("You're offline — local decks still work", "info");
});
updateOnlineIndicator();

export function commitEditIfActive() {
  const sides = [
    { side: "question", view: el.questionView, edit: el.questionEdit, toolbar: el.questionEditToolbar, renderToolbar: el.questionRenderToolbar, btn: el.editQuestionBtn },
    { side: "answer",   view: el.answerView,   edit: el.answerEdit,   toolbar: el.answerEditToolbar,   renderToolbar: el.answerRenderToolbar,   btn: el.editAnswerBtn },
  ];
  const card = state.cards[state.current];
  let committed = false;
  for (const { side, view, edit, toolbar, renderToolbar, btn } of sides) {
    if (view.hidden === false) continue; // not in edit mode for this side
    committed = true;
    if (card) {
      const newValue = edit.value.trim();
      // A card with no question is dropped outright by loadDeckSnapshot on the
      // next deck load, so committing a blank one destroys the card — and the
      // next push then deletes it from the cloud too. Discard the empty edit and
      // keep what was there. (A blank ANSWER is legitimate: every quick_notes
      // pin is front-only, which is why only the question is guarded.)
      if (side === "question" && !newValue) {
        setStatus("Question cannot be empty — kept the previous text.", "error");
      } else {
        if (side === "question") card.question = newValue;
        else card.answer = newValue;
        const masterIndex = state.masterCards.findIndex(c => c.id === card.id);
        if (masterIndex > -1) {
          if (side === "question") state.masterCards[masterIndex].question = newValue;
          else state.masterCards[masterIndex].answer = newValue;
        }
      }
    }
    view.hidden = false;
    edit.hidden = true;
    edit.value = "";
    if (toolbar) toolbar.hidden = true;
    if (renderToolbar) renderToolbar.hidden = false;
    if (btn) {
      btn.classList.remove('is-editing');
      btn.title = side === "question" ? "Edit question" : "Edit answer";
    }
  }
  return committed;
}

// Whether the user has explicitly asked to see the card as raw markdown. Every
// flip used to drop back to the rendered view, so editing both sides of a card
// meant re-tapping ✎ after each flip. Only the EXPLICIT toggles (the ✎ buttons,
// Ctrl+E, triple-click) write this — never the blur-driven commit, which is
// exactly what tapping the card to flip triggers on the way out of the side you
// were editing, and which would otherwise clear the preference every time.
// Reset in showCard, so arriving at a different card always starts rendered.
export let cardRawModePreferred = false;

// Setter: an imported binding is read-only, and cards/card-view.js records the preference when a card is shown.
export function setCardRawModePreferred(value) {
  cardRawModePreferred = value;
}

// Carries that choice across a flip: the newly-shown side opens in whichever
// mode was last chosen instead of always resetting to rendered.
export function applyCardRawModePreference() {
  if (!state.cards[state.current]) return;
  const shownSide = state.flipped ? "answer" : "question";
  const hiddenSide = state.flipped ? "question" : "answer";
  const viewFor = (side) => (side === "answer" ? el.answerView : el.questionView);

  // Commit the side we just turned away from. Tapping the card to flip normally
  // blurs its textarea and the blur handler does this, but a flip from anywhere
  // that doesn't move focus (Ctrl+E, a swipe, the nav buttons) would otherwise
  // leave that editor open behind the now-hidden face — so it reappeared, still
  // open, the next time the card was flipped back.
  if (viewFor(hiddenSide)?.hidden) toggleEditMode(hiddenSide, { remember: false });

  if (!cardRawModePreferred) return;
  const view = viewFor(shownSide);
  if (!view || view.hidden) return; // already raw on this side
  toggleEditMode(shownSide, { remember: false });
}

// `cursorOffset` (raw-markdown character index) places the caret there instead
// of at the start of the text — used by the triple-click handler so switching to
// raw mode doesn't lose your place, the same way enterNotesEditing does it.
// `remember: false` opts out of updating cardRawModePreferred, for the toggles
// that are a side effect of something else (a blur, a flip) rather than a
// deliberate choice.
function toggleEditMode(side, { cursorOffset = null, remember = true } = {}) {
  const isQuestion = side === 'question';
  const btn = isQuestion ? el.editQuestionBtn : el.editAnswerBtn;
  const view = isQuestion ? el.questionView : el.answerView;
  const edit = isQuestion ? el.questionEdit : el.answerEdit;
  const toolbar = isQuestion ? el.questionEditToolbar : el.answerEditToolbar;
  const renderToolbar = isQuestion ? el.questionRenderToolbar : el.answerRenderToolbar;
  const currentCard = state.cards[state.current];

  if (!currentCard) return;

  const isEditing = view.hidden;
  hideNotesSelectionButton();
  if (remember) cardRawModePreferred = !isEditing;

  if (!isEditing) {
    view.hidden = true;
    edit.hidden = false;
    if (toolbar) toolbar.hidden = false;
    if (renderToolbar) renderToolbar.hidden = true;
    edit.value = isQuestion ? currentCard.question : currentCard.answer;
    if (btn) {
      btn.classList.add('is-editing');
      btn.title = 'Back to preview';
    }
    refreshHighlightBackdrop(edit);
    edit.focus();
    // Assigning .value leaves the caret at the very end in most browsers, so
    // always place it explicitly — a matched offset when we have one, otherwise
    // the top of the text. Never let a failed match silently dump you at the end.
    const pos = cursorOffset != null
      ? Math.max(0, Math.min(cursorOffset, edit.value.length))
      : 0;
    edit.setSelectionRange(pos, pos);
    scrollTextareaToOffset(edit, pos);
  } else {
    const typed = edit.value.trim();
    // A card with no question is dropped by loadDeckSnapshot on the next deck
    // load, so committing a blank one silently destroys the card — and the next
    // push deletes it from the cloud too. This path also runs on BLUR, so it
    // discards the empty edit and keeps the existing question rather than
    // refusing to close and trapping focus in the textarea. (A blank ANSWER is
    // legitimate: every quick_notes pin is front-only.)
    const rejected = isQuestion && !typed;
    const newValue = rejected ? currentCard.question : typed;

    if (!rejected) {
      if (isQuestion) {
        currentCard.question = newValue;
      } else {
        currentCard.answer = newValue;
      }

      const masterIndex = state.masterCards.findIndex(c => c.id === currentCard.id);
      if (masterIndex > -1) {
        if (isQuestion) state.masterCards[masterIndex].question = newValue;
        else state.masterCards[masterIndex].answer = newValue;
      }
    }

    view.hidden = false;
    edit.hidden = true;
    if (toolbar) toolbar.hidden = true;
    if (renderToolbar) renderToolbar.hidden = false;
    if (btn) {
      btn.classList.remove('is-editing');
      btn.title = isQuestion ? 'Edit question' : 'Edit answer';
    }

    renderMarkdown(view, newValue, true).then(() => {
      if (isQuestion) scheduleLiveQuestionFit();
    });

    if (rejected) {
      setStatus("Question cannot be empty — kept the previous text.", "error");
      return;
    }

    scheduleDeckAutosave();
    setStatus(state.deckId ? "Card updated locally. Sync to update the web deck." : "Card updated.");
  }
}

el.editQuestionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEditMode('question');
});

el.editAnswerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEditMode('answer');
});

el.goToNotesBtn?.addEventListener('click', (e) => {
  // stopPropagation so tapping it doesn't also flip the card.
  e.stopPropagation();
  jumpToNoteForCurrentCard();
});

el.questionEdit.addEventListener('click', (e) => e.stopPropagation());
el.answerEdit.addEventListener('click', (e) => e.stopPropagation());

// True while the toolbar image file picker is open. Opening the native file dialog
// blurs the textarea; without this guard the blur handler would exit edit mode before
// the picked image is inserted, so the insertion would land in a reset textarea.
let imagePickerActive = false;

// Auto-save when focus leaves the textarea (blur), unless focus moved to the edit button (which handles its own toggle)
// remember:false — a blur is not a decision to go back to the rendered view. It
// fires when you tap the card to flip it, and clearing the raw/rendered
// preference there is precisely what made every flip snap back to rendered.
el.questionEdit.addEventListener('blur', (e) => {
  if (imagePickerActive) return;
  if (!el.questionEdit.hidden && e.relatedTarget !== el.editQuestionBtn) toggleEditMode('question', { remember: false });
});
el.answerEdit.addEventListener('blur', (e) => {
  if (imagePickerActive) return;
  if (!el.answerEdit.hidden && e.relatedTarget !== el.editAnswerBtn) toggleEditMode('answer', { remember: false });
});


if (el.newDeckBtn) {
  el.newDeckBtn.addEventListener("click", () => createNewDeck());
}

function addBlankCardAtCursor() {
  if (!state.masterCards.length && !state.deckTitle) {
    setStatus("Create a new deck or import one first.", "error");
    return;
  }
  // From zero cards there's no "current" card to navigate from — land
  // directly on the new sole card instead of animating navigateCard(1),
  // which assumes a real current card and would overshoot to the
  // deck-complete summary.
  const wasEmpty = state.masterCards.length === 0;
  pushCardUndoSnapshot(snapshotCardsState());
  const newCard = createBlankCard();
  const insertAt = wasEmpty ? 0 : state.current + 1;
  state.masterCards.splice(insertAt, 0, newCard);
  state.cards.splice(insertAt, 0, newCard);
  if (wasEmpty) {
    state.current = 0;
    showCard();
  } else {
    navigateCard(1, "next");
  }
  setStatus("Card added. Click the edit icon to modify it.");
}

if (el.addCardBtn) {
  el.addCardBtn.addEventListener("click", addBlankCardAtCursor);
}

el.deckEmptyAddCardBtn?.addEventListener("click", addBlankCardAtCursor);
el.deckEmptyGoNotesBtn?.addEventListener("click", () => setViewMode("notes"));

if (el.deleteCardBtn) {
  el.deleteCardBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!state.masterCards.length) return;
    const card = state.cards[state.current];
    showConfirmModal("Delete this card?", () => {
      pushCardUndoSnapshot(snapshotCardsState());
      state.masterCards = state.masterCards.filter(c => c.id !== card.id);
      state.cards = state.cards.filter(c => c.id !== card.id);
      delete state.statusById[card.id];
      if (state.current >= state.cards.length) {
        state.current = Math.max(0, state.cards.length - 1);
      }
      showCard();
      setStatus(state.deckId ? "Card deleted locally. Sync to update the web deck." : "Card deleted. Ctrl+Z to undo.");
    }, { confirmLabel: "Delete", danger: true });
  });
}

const deckEmptyNewBtn = document.getElementById("deckEmptyNewBtn");
const deckEmptyImportBtn2 = document.getElementById("deckEmptyImportBtn");
const deckEmptyWebBtn = document.getElementById("deckEmptyWebBtn");
if (deckEmptyNewBtn) deckEmptyNewBtn.addEventListener("click", () => createNewDeck());
if (deckEmptyImportBtn2) deckEmptyImportBtn2.addEventListener("click", () => openImportPanel());
if (deckEmptyWebBtn) deckEmptyWebBtn.addEventListener("click", () => openMyDecksPanel());

export const helpModal = document.getElementById("helpModal");
const helpBtn = document.getElementById("helpBtn");
const helpModalCloseBtn = document.getElementById("helpModalCloseBtn");
const helpModalCloseFootBtn = document.getElementById("helpModalCloseFootBtn");

function openHelpModal() {
  if (!helpModal) return;
  helpModal.hidden = false;
  lockPageScroll();
}

export function closeHelpModal() {
  if (!helpModal) return;
  helpModal.hidden = true;
  unlockPageScroll();
}

if (helpBtn) helpBtn.addEventListener("click", openHelpModal);
if (helpModalCloseBtn) helpModalCloseBtn.addEventListener("click", closeHelpModal);
if (helpModalCloseFootBtn) helpModalCloseFootBtn.addEventListener("click", closeHelpModal);
if (helpModal) {
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) closeHelpModal();
  });
  helpModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeHelpModal(); }
  });
}

// ── App Info modal ─────────────────────────────────────────────────────────
// BUILD_STAMP / BUILD_TIME / IS_DEV_BUILD now live in core/build.js — see the
// import at the top of this file. They moved because deploy.yml substitutes
// them, and a placeholder is far easier to reason about in a 35-line leaf
// module than at line 29,441 of a 35,000-line one.

// The running build's version. Normally the commit SHA above; "dev" for an
// unstamped checkout, "unknown" only if this file was somehow loaded without one.
function runningAppVersion() {
  if (IS_DEV_BUILD) return "dev";
  return BUILD_STAMP || "unknown";
}

// The build time as a human would read it, or "" when there is nothing honest
// to show — an unstamped checkout, or a value sed never reached.
function runningBuildTime() {
  if (IS_DEV_BUILD || !BUILD_TIME || BUILD_TIME.startsWith("__")) return "";
  const when = new Date(BUILD_TIME);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// What the "Installed version" row says: the commit, and when that commit was
// made. Both come from the deploy, so neither can be stale relative to the
// other the way a typed stamp and a typed date could.
function runningVersionLabel() {
  const version = runningAppVersion();
  const builtAt = runningBuildTime();
  return builtAt ? `${version} · ${builtAt}` : version;
}

// What the page REQUESTED, as distinct from what it got. Compared against
// BUILD_STAMP to catch a cross-release fallback the worker didn't report — the
// message needs a controller and an open channel, and neither is guaranteed on
// the very load that went wrong.
function requestedAppVersion() {
  const src = document.querySelector('script[src*="main.js"]')?.getAttribute("src") || "";
  return src.match(/[?&]v=([^&]+)/)?.[1] || null;
}

// Where the source of truth lives. One place, so a fork edits one line.
const GITHUB_REPO = { owner: "sinayanaik", repo: "recall", branch: "main" };
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}`;

// The release stamp as it appears in index.html — the SAME string the running
// page's <script src> carries, which is the whole point: the old check compared
// index.html's ?v= against sw.js's CACHE_NAME, two hand-maintained numbers in
// five different places. Whenever they drifted, the app announced "Update
// available" forever and offered a Reload button that could not possibly fix
// it, because there was no newer build to reload into.
//
// Since the deploy substitutes a commit SHA, that stamp IS the deployed commit,
// which is why the repo half of this check no longer has to download a file to
// read a version out of it.
const RELEASE_STAMP_RE = /src\/main\.js\?v=([^"'&\s]+)/;
// `const` is part of the pattern deliberately: the cache name no longer carries
// a "v" prefix, so a bare `CACHE_NAME\s*=` would also match sw.js's
// IMAGE_CACHE_NAME ("recall-images-v1") and report the image cache as a second,
// disagreeing release version.
const CACHE_NAME_RE = /const CACHE_NAME\s*=\s*"recall-([^"]+)"/;

function stampFromHtml(text) {
  return text.match(RELEASE_STAMP_RE)?.[1] || null;
}

// Every ?v= in a served index.html, plus sw.js's CACHE_NAME. All must agree for
// a release to be coherent.
//
// sw.js's APP_SHELL entries are deliberately NOT read any more: they are now
// built from CACHE_NAME (`./app.js?v=${STAMP}`) rather than typed out, so there
// is nothing left there to disagree. Scanning for them regardless was actively
// wrong — the pattern matched the template literal and captured "${STAMP}`," as
// a stamp, so every build reported itself inconsistent and the modal refused to
// compare anything at all.
function releaseStampsIn(html, sw) {
  const stamps = [];
  if (html) {
    for (const match of html.matchAll(/(?:app|styles)\.(?:js|css)\?v=([^"'&\s]+)/g)) {
      stamps.push({ where: "index.html", stamp: match[1] });
    }
  }
  if (sw) {
    const cacheName = sw.match(CACHE_NAME_RE);
    if (cacheName) stamps.push({ where: "sw.js CACHE_NAME", stamp: cacheName[1] });
    // A literal stamp here means an older sw.js that still hand-maintains them,
    // which is exactly the drift worth reporting. The template form contains
    // "${" and is skipped.
    for (const match of sw.matchAll(/\.\/(?:app|styles)\.(?:js|css)\?v=([^"'&\s`]+)/g)) {
      if (match[1].includes("${")) continue;
      stamps.push({ where: "sw.js APP_SHELL", stamp: match[1] });
    }
  }
  return stamps;
}

// Every request this check makes is bounded. Without it the modal's rows sit on
// "checking…" for as long as the network cares to hang — and a version
// indicator that can silently never finish is exactly the thing it exists not
// to be. A timeout is a real answer ("couldn't reach it"); no answer is not.
const UPDATE_CHECK_TIMEOUT_MS = 8000;

function updateCheckSignal() {
  try {
    return AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  } catch (_) {
    return undefined; // pre-2022 engine: fall back to an unbounded fetch
  }
}

// Same-origin fetch for the update check, on UPDATE_CHECK_TIMEOUT_MS. Renamed
// from `fetchText` because a second function of that name existed 4,000 lines
// up for URL imports; see fetchImportText for what that collision cost.
async function fetchReleaseText(url, options = {}) {
  const response = await fetch(url, { signal: updateCheckSignal(), ...options });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

// What this origin would hand a visitor arriving right now. `no-store` keeps
// both the browser's HTTP cache and the service worker's cached copy out of the
// answer — and sw.js exempts itself from interception outright (see its fetch
// handler), so neither file can come back stale.
async function fetchLiveRelease() {
  const [html, sw] = await Promise.all([
    fetchReleaseText("./index.html", { cache: "no-store" }),
    fetchReleaseText("./sw.js", { cache: "no-store" }).catch(() => null)
  ]);
  return { stamp: stampFromHtml(html), html, sw };
}

// The repo itself: the newest commit on the branch. Cross-origin and not a CDN
// asset, so the service worker's fetch handler returns early and never touches
// this.
//
// This used to additionally download index.html and sw.js from
// raw.githubusercontent.com at that commit, purely to read a hand-typed stamp
// out of them. It no longer has to: the deployed version IS the short SHA, so
// the commit listing already answers the question and two round-trips per check
// disappeared with it.
let githubReleaseCache = { at: 0, value: null };
const GITHUB_CACHE_MS = 5 * 60 * 1000;

function githubHeaders() {
  return { Accept: "application/vnd.github+json" };
}

// 403 and 429 are the unauthenticated rate limit (60/hr, shared per IP), not a
// broken repo — worth saying so rather than reporting the repo as unreachable.
function throwIfRateLimited(response) {
  if (response.status === 403 || response.status === 429) {
    throw Object.assign(new Error("rate limited"), { rateLimited: true });
  }
}

async function fetchRepoRelease() {
  if (githubReleaseCache.value && Date.now() - githubReleaseCache.at < GITHUB_CACHE_MS) {
    return githubReleaseCache.value;
  }
  const commitResponse = await fetch(`${GITHUB_API}/commits/${GITHUB_REPO.branch}`, { headers: githubHeaders(), cache: "no-store", signal: updateCheckSignal() });
  throwIfRateLimited(commitResponse);
  if (!commitResponse.ok) throw new Error(`commits -> ${commitResponse.status}`);
  const commit = await commitResponse.json();

  const value = {
    // Seven characters, matching what the deploy writes into the files, so the
    // two are directly comparable without normalising either side.
    sha: String(commit.sha || "").slice(0, 7),
    date: commit.commit?.author?.date || commit.commit?.committer?.date || null,
    subject: String(commit.commit?.message || "").split("\n")[0]
  };
  githubReleaseCache = { at: Date.now(), value };
  return value;
}

// Which way round two commits sit. Answers the one question that decides
// between "Pages hasn't published your push yet" and "you're running something
// that isn't on the branch at all" — and answers it from git's actual history
// rather than, as the old code did, by comparing two YYYYMMDD-NN strings
// lexically and hoping the author's typed dates ran in the right order.
//
// Returns GitHub's own status: "identical", "ahead" (deployed is an ancestor of
// HEAD, i.e. the branch has moved on), "behind", or "diverged". Plus two of our
// own, and the difference between them matters:
//
//   "absent"  — 404. The sha is not in this repo at all, which is a real answer.
//   "unknown" — rate limited, offline, timed out. NOT an answer.
//
// Collapsing those two was tempting and wrong: the repo row can come from the
// 5-minute cache while this call is the one that trips the 60/hr rate limit,
// and reporting "this build isn't on the branch" because GitHub declined to
// say is exactly the kind of confident-but-baseless claim this whole rewrite
// exists to remove.
async function compareCommits(base, head) {
  try {
    const response = await fetch(`${GITHUB_API}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      headers: githubHeaders(),
      cache: "no-store",
      signal: updateCheckSignal()
    });
    if (response.status === 404) return "absent";
    if (!response.ok) return "unknown";
    const body = await response.json();
    return body?.status || "unknown";
  } catch (_) {
    return "unknown";
  }
}

export const appInfoModal = document.getElementById("appInfoModal");
const appInfoBtn = document.getElementById("appInfoBtn");
const appInfoCloseBtn = document.getElementById("appInfoCloseBtn");
const appInfoVersion = document.getElementById("appInfoVersion");
const appInfoLatest = document.getElementById("appInfoLatest");
const appInfoStatus = document.getElementById("appInfoStatus");
const appInfoRepo = document.getElementById("appInfoRepo");
const appInfoCommit = document.getElementById("appInfoCommit");
const appInfoWarning = document.getElementById("appInfoWarning");
const appInfoCheckBtn = document.getElementById("appInfoCheckBtn");
const appInfoReloadBtn = document.getElementById("appInfoReloadBtn");

function setAppInfoStatus(text, cls = "") {
  if (!appInfoStatus) return;
  appInfoStatus.textContent = text;
  appInfoStatus.classList.toggle("is-ok", cls === "ok");
  appInfoStatus.classList.toggle("is-outdated", cls === "outdated");
}

function setAppInfoWarning(text) {
  if (!appInfoWarning) return;
  appInfoWarning.textContent = text || "";
  appInfoWarning.hidden = !text;
}

// Fills every row. Also pokes the service worker's own update check — when a
// new worker is already waiting, that alone finishes the update
// (controllerchange then reloads the page; see registerServiceWorker).
//
// Three commits get compared, not two:
//   installed — the build this page is actually running (BUILD_STAMP)
//   live      — the build the server would hand a fresh visitor right now
//   repo      — the newest commit on the GitHub branch
//
// Which pair disagrees is what decides the message. installed ≠ live means
// there IS a newer build sitting on the server and reloading gets it. live ≠
// repo means the newest code is pushed but GitHub Pages hasn't published it —
// reloading cannot help, and the old check's "Update available" was a nag that
// no amount of reloading would ever clear.
//
// All three are now commit SHAs written by the deploy, so "same build" is
// literal identity rather than agreement between hand-typed strings.
let appInfoCheckToken = 0;

async function refreshAppInfo() {
  if (!appInfoLatest || !appInfoStatus) return;
  const token = ++appInfoCheckToken;
  const running = runningAppVersion();
  if (appInfoVersion) appInfoVersion.textContent = runningVersionLabel();

  appInfoLatest.textContent = "checking…";
  if (appInfoRepo) appInfoRepo.textContent = "checking…";
  if (appInfoCommit) appInfoCommit.textContent = "checking…";
  setAppInfoStatus("");
  setAppInfoWarning("");
  if (appInfoReloadBtn) appInfoReloadBtn.hidden = true;
  if (serviceWorkerRegistration) serviceWorkerRegistration.update().catch(() => {});

  // Both start together, but the same-origin answer is painted the moment it
  // lands rather than waiting on GitHub — it's the one that decides whether to
  // offer Reload, and it must not be held hostage by a slow or blocked API.
  // allSettled, not all: a GitHub outage or rate limit costs us the repo row
  // and nothing else.
  const livePromise = fetchLiveRelease();
  const repoPromise = fetchRepoRelease();
  livePromise
    .then((live) => { if (token === appInfoCheckToken && appInfoLatest) appInfoLatest.textContent = live?.stamp || "unknown"; })
    .catch(() => {});

  const [liveResult, repoResult] = await Promise.allSettled([livePromise, repoPromise]);
  // A second press while the first check is still in flight would otherwise
  // finish later and repaint the rows with the older run's answers.
  if (token !== appInfoCheckToken) return;

  const live = liveResult.status === "fulfilled" ? liveResult.value : null;
  const repo = repoResult.status === "fulfilled" ? repoResult.value : null;

  // An unstamped build has no version, so the "Live site" row would read back
  // the raw placeholder — not an answer. Everything else on this panel is still
  // a real fact and still worth showing: the repo rows say what has been pushed
  // and when, which is the only checkable thing left.
  appInfoLatest.textContent = IS_DEV_BUILD ? "not stamped" : (live?.stamp || "unknown");
  if (appInfoRepo) appInfoRepo.textContent = repo?.sha || (repoResult.reason?.rateLimited ? "unavailable (rate limited)" : "unavailable");
  if (appInfoCommit) {
    appInfoCommit.textContent = repo
      ? `${repo.sha}${repo.date ? ` · ${new Date(repo.date).toLocaleDateString()}` : ""}${repo.subject ? ` · ${repo.subject.slice(0, 60)}` : ""}`
      : "—";
  }

  // Nothing below can compare an unstamped build against anything, but WHY it
  // is unstamped is the useful part, and the two causes are opposite. Served
  // from localhost it is normal and expected. Served from a real host it is a
  // deployment that skipped the stamping step — which is invisible in every
  // other way, ships the same frozen ?v= to every future release, and is
  // exactly the failure this panel should name rather than shrug at.
  if (IS_DEV_BUILD) {
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = true;
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (local) {
      setAppInfoStatus("Running from a local checkout — nothing to compare");
      setAppInfoWarning(
        repo
          ? `Files are served straight from disk, so there is no build version. Newest commit on ${GITHUB_REPO.branch} is ${repo.sha} — compare it against your working tree with git.`
          : "Files are served straight from disk, so there is no build version."
      );
    } else {
      setAppInfoStatus("This deploy was never stamped", "outdated");
      setAppInfoWarning(
        "The site was published without the deploy workflow's stamping step, so every asset URL is a literal placeholder and updates cannot be detected or cache-busted. " +
        "Fix: repo Settings → Pages → Source → \"GitHub Actions\", then re-run the deploy workflow."
      );
    }
    return;
  }

  // The failproof half. One deploy step writes every occurrence, so these can
  // only disagree if the site was published some other way — a half-finished
  // upload, a fork deploying from a branch, a stale file behind a CDN. No
  // comparison built on them would mean anything, so say THAT rather than
  // dressing the inconsistency up as an update.
  const stamps = releaseStampsIn(live?.html, live?.sw);
  const distinct = [...new Set(stamps.map((entry) => entry.stamp))];
  if (distinct.length > 1) {
    // One line per distinct place-and-value; index.html and APP_SHELL each
    // carry the stamp twice, and listing "index.html: X, index.html: X" makes
    // the one entry that actually differs harder to spot, not easier.
    const detail = [...new Set(stamps.map((entry) => `${entry.where}: ${entry.stamp}`))].join(", ");
    setAppInfoWarning(`Build versions disagree on the server — ${detail}. Every one of these is written from the same commit by the deploy workflow, so the site was published from something other than a completed deploy. Re-running it fixes this.`);
    setAppInfoStatus("Can't compare — the deployed build is inconsistent", "outdated");
    return;
  }

  if (!live) {
    setAppInfoStatus("Offline — can't check right now");
    return;
  }
  if (!live.stamp || running === "unknown") {
    setAppInfoStatus("Couldn't read a version to compare");
    return;
  }

  if (running !== live.stamp) {
    setAppInfoStatus("Update available — reload to update", "outdated");
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }

  // Everything below this line compares stamps, and a stamp is only as honest as
  // the assumption that the bundle which ran is the bundle the URL named. These
  // two cases are where that assumption breaks, so they have to be answered
  // before "up to date" is allowed to be said at all.
  if (isMixedBuild()) {
    setAppInfoStatus("Running a mixed build — reload to fix", "outdated");
    setAppInfoWarning(
      "Part of this app was served from an older release than the page itself, so the version above " +
      "is the version that was requested, not the one that ran. Reloading on a working connection fixes it."
    );
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }
  if (updateIsWaiting) {
    setAppInfoStatus("Update downloaded — reload to finish", "outdated");
    if (appInfoReloadBtn) appInfoReloadBtn.hidden = false;
    return;
  }
  if (updateDownloadFailed) {
    setAppInfoStatus("An update couldn't be downloaded — will retry", "outdated");
    setAppInfoWarning(
      "This device started downloading a newer version and didn't finish it. It retries automatically; " +
      "a stronger connection, or freeing up storage, is what usually lets it through."
    );
    return;
  }

  // Running the newest build the server has. The only question left is whether
  // the server has caught up with the repo — and, when it hasn't, WHICH WAY
  // round they sit. A server serving something that isn't on the branch is an
  // ordinary local build or a deploy from somewhere else, not something to warn
  // about; calling that "Pages hasn't published yet" would be exactly backwards.
  //
  // git answers this, so ask git. The old code guessed from string ordering of
  // two hand-typed YYYYMMDD-NN stamps, which was only ever right by convention
  // and said nothing at all once two builds shared a date.
  if (repo?.sha && repo.sha !== live.stamp) {
    const relation = await compareCommits(live.stamp, repo.sha);
    if (token !== appInfoCheckToken) return;
    if (relation === "ahead") {
      // The deployed commit is an ancestor of the branch head: the push landed,
      // the deploy hasn't finished.
      setAppInfoStatus(`Up to date with the live site — GitHub Pages hasn't published ${repo.sha} yet`, "outdated");
      setAppInfoWarning("Nothing to do here: your browser already has the newest build that exists on the server. Pages usually publishes within a couple of minutes of a push.");
    } else if (relation === "identical") {
      // Different short SHAs for the same commit shouldn't happen, but if they
      // do, the honest answer is that there is nothing to update.
      setAppInfoStatus("You're up to date ✓", "ok");
    } else if (relation === "unknown") {
      // Couldn't reach GitHub for the comparison. Everything reloading could
      // fix has already been ruled out above, so the useful half is still true.
      setAppInfoStatus("Up to date with the live site ✓", "ok");
      setAppInfoWarning(`Couldn't ask GitHub how ${live.stamp} relates to ${repo.sha}, so this only compares against the live site.`);
    } else {
      setAppInfoStatus("Up to date — this build isn't on the branch", "ok");
      setAppInfoWarning(`What the server is serving (${live.stamp}) isn't an ancestor of ${GITHUB_REPO.branch} (${repo.sha}) — a build published from somewhere else, or a branch that has been rewritten. Nothing to update.`);
    }
    return;
  }

  setAppInfoStatus(repo ? "You're up to date ✓" : "Up to date with the live site ✓", "ok");
  if (!repo) setAppInfoWarning("Couldn't reach GitHub, so this only compares against the live site.");
}

// ── Supabase project health check ──────────────────────────────────────────
// Every user connects their OWN Supabase project, and the setup form validates
// only the SHAPE of the URL and key — never that the project behind them has the
// schema this app needs. So a half-applied supabase_setup.sql, a storage policy
// block that was skipped because the SQL Editor's role couldn't alter
// storage.objects, or an upgrade from a pre-auth deployment whose rows have no
// user_id all present as "sync just doesn't work", with the real cause reachable
// only through a console the user does not have.
//
// Everything here is read-only: `limit(0)`/`limit(1)` reads and one storage
// list. Nothing is written, so running it can never make a broken project worse.
const HEALTH_TIMEOUT_MS = 12000;

// PostgREST rejects a select naming a column that doesn't exist, so asking for
// the full column list is itself the column check — no information_schema
// access required (the anon role doesn't have it anyway).
const HEALTH_TABLES = [
  {
    table: "decks",
    columns: "id, title, category, notes, meta, updated_at, last_accessed_at, current_card_index",
    label: "Decks table"
  },
  {
    table: "cards",
    columns: "id, deck_id, question, answer, position, status, category, updated_at",
    label: "Cards table"
  },
  {
    table: "deleted_decks",
    columns: "deck_id",
    label: "Delete tombstones",
    // The app degrades to local-only deletes without this rather than failing,
    // so it is a warning rather than a hard fault — but a deck deleted on one
    // device silently returning on the next sync is not something a user can
    // diagnose.
    soft: true
  },
  {
    table: "app_style_settings",
    columns: "id",
    label: "Style settings",
    soft: true
  }
];

const RERUN_SQL = "Re-run supabase_setup.sql in your Supabase project's SQL Editor.";

async function checkProjectHealth() {
  const results = [];
  const add = (label, status, detail) => results.push({ label, status, detail });

  if (!supabaseClient) {
    add("Connection", "fail", "No Supabase project is connected on this device.");
    return results;
  }
  if (!navigator.onLine) {
    add("Connection", "skip", "You're offline — reconnect to check.");
    return results;
  }

  const userId = await verifiedCloudUserId();
  if (!userId) {
    // Worth stopping for: under RLS every check below would come back
    // empty-and-successful, so an unauthenticated run would report a perfectly
    // healthy project as perfectly healthy while nothing actually worked.
    add("Signed in", "fail", "Not signed in, so nothing below can be checked. Sign in and try again.");
    return results;
  }
  add("Signed in", "ok", "Your session is valid.");

  for (const spec of HEALTH_TABLES) {
    try {
      const { error } = await withTimeout(
        abortable((signal) =>
          supabaseClient.from(spec.table).select(spec.columns).limit(1).abortSignal(signal)
        ),
        HEALTH_TIMEOUT_MS,
        `check ${spec.table}`
      );
      if (error) throw error;
      add(spec.label, "ok", `\`${spec.table}\` is present with every column this version needs.`);
    } catch (error) {
      const status = spec.soft ? "warn" : "fail";
      if (isMissingRelationError(error)) {
        add(spec.label, status, `The \`${spec.table}\` table doesn't exist. ${RERUN_SQL}`);
      } else if (String(error?.code || "") === "42703") {
        // The message names the offending column; it is the single most useful
        // string in the whole check, so pass it through rather than paraphrase.
        add(spec.label, status, `A column is missing — ${error.message}. ${RERUN_SQL}`);
      } else if (String(error?.code || "") === "42501") {
        add(spec.label, status, `Permission denied by Row Level Security. ${RERUN_SQL}`);
      } else {
        add(spec.label, status, error?.message || "Couldn't read this table.");
      }
    }
  }

  // Storage. The setup SQL's storage block is wrapped in an EXCEPTION handler
  // that downgrades insufficient_privilege to a NOTICE, so a project can finish
  // setup "successfully" with no image policies at all — after which every
  // upload fails and the outbox entry is discarded.
  try {
    const { error } = await withTimeout(
      supabaseClient.storage.from("images").list("", { limit: 1 }),
      HEALTH_TIMEOUT_MS,
      "check images bucket"
    );
    if (error) throw error;
    add("Image storage", "ok", "The `images` bucket is reachable.");
  } catch (error) {
    add(
      "Image storage",
      "warn",
      `The \`images\` bucket isn't reachable (${error?.message || "unknown error"}), so pasted images can't upload. ` +
      "Section 7 of supabase_setup.sql creates it and its policies."
    );
  }

  // The pre-auth-upgrade case. Rows whose user_id is NULL are hidden by RLS, so
  // the client cannot see them directly — it can only notice the shape they
  // make: this device is holding decks it previously confirmed in the cloud,
  // and the cloud now reports none at all.
  try {
    const { data, error } = await withTimeout(
      abortable((signal) => supabaseClient.from("decks").select("id").limit(1).abortSignal(signal)),
      HEALTH_TIMEOUT_MS,
      "check deck visibility"
    );
    if (error) throw error;
    const syncedLocally = readLocalDeckIndex().filter((entry) => entry.deckId && entry.lastSyncedAt).length;
    if ((!data || data.length === 0) && syncedLocally > 0) {
      add(
        "Deck ownership",
        "fail",
        `This device has ${syncedLocally} deck${syncedLocally === 1 ? "" : "s"} it previously synced, but your account ` +
        "can see none in the cloud. On a project upgraded from before sign-in existed, the existing rows have no owner " +
        "and RLS hides them. Section 8 of supabase_setup.sql has the one-line UPDATE that claims them."
      );
    } else {
      add("Deck ownership", "ok", "Your account can read its own decks.");
    }
  } catch (_) {
    // The table checks above already reported whatever is wrong here.
  }

  return results;
}

const appInfoHealthList = document.getElementById("appInfoHealthList");
const appInfoHealthSummary = document.getElementById("appInfoHealthSummary");
const appInfoHealthBtn = document.getElementById("appInfoHealthBtn");

function renderProjectHealth(results) {
  if (!appInfoHealthList) return;
  appInfoHealthList.textContent = "";
  const glyph = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
  for (const row of results) {
    const li = document.createElement("li");
    li.className = `app-info-health-item is-${row.status}`;
    const mark = document.createElement("span");
    mark.className = "app-info-health-mark";
    mark.textContent = glyph[row.status] || "–";
    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = row.label;
    body.append(name, document.createTextNode(` — ${row.detail}`));
    li.append(mark, body);
    appInfoHealthList.appendChild(li);
  }
  if (!appInfoHealthSummary) return;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  if (failed) {
    appInfoHealthSummary.textContent =
      `${failed} problem${failed === 1 ? "" : "s"} will stop syncing from working properly. ${RERUN_SQL} It is safe to re-run and safe on a project that already holds decks.`;
    appInfoHealthSummary.hidden = false;
  } else if (warned) {
    appInfoHealthSummary.textContent =
      `Syncing works, but ${warned} feature${warned === 1 ? " is" : "s are"} degraded. ${RERUN_SQL}`;
    appInfoHealthSummary.hidden = false;
  } else {
    appInfoHealthSummary.hidden = true;
  }
}

let healthCheckInFlight = false;

async function runProjectHealthCheck() {
  if (healthCheckInFlight) return;
  healthCheckInFlight = true;
  if (appInfoHealthBtn) setButtonLoading(appInfoHealthBtn, true, "Checking…");
  if (appInfoHealthList) appInfoHealthList.textContent = "";
  if (appInfoHealthSummary) appInfoHealthSummary.hidden = true;
  try {
    renderProjectHealth(await checkProjectHealth());
  } catch (error) {
    console.warn("Project health check failed", error);
    renderProjectHealth([{ label: "Check", status: "fail", detail: error?.message || "Couldn't complete the check." }]);
  } finally {
    healthCheckInFlight = false;
    if (appInfoHealthBtn) setButtonLoading(appInfoHealthBtn, false);
  }
}

if (appInfoHealthBtn) appInfoHealthBtn.addEventListener("click", runProjectHealthCheck);

function openAppInfoModal() {
  if (!appInfoModal) return;
  if (appInfoVersion) appInfoVersion.textContent = runningVersionLabel();
  appInfoModal.hidden = false;
  lockPageScroll();
  refreshAppInfo();
}

// "Check for updates" should mean it. The 5-minute GitHub cache exists to keep
// the modal's automatic refresh off the 60/hr budget — a deliberate press has
// to be able to look past it.
function forceRefreshAppInfo() {
  githubReleaseCache = { at: 0, value: null };
  return refreshAppInfo();
}

export function closeAppInfoModal() {
  if (!appInfoModal) return;
  appInfoModal.hidden = true;
  unlockPageScroll();
}

if (appInfoBtn) appInfoBtn.addEventListener("click", openAppInfoModal);
if (appInfoCloseBtn) appInfoCloseBtn.addEventListener("click", closeAppInfoModal);
if (appInfoCheckBtn) appInfoCheckBtn.addEventListener("click", forceRefreshAppInfo);
if (appInfoReloadBtn) appInfoReloadBtn.addEventListener("click", () => location.reload());
if (appInfoModal) {
  appInfoModal.addEventListener("click", (e) => {
    if (e.target === appInfoModal) closeAppInfoModal();
  });
  appInfoModal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeAppInfoModal(); }
  });
}

// ----- Image upload (Supabase Storage) -------------------------------------
// Insert `text` at the textarea's caret and fire an input event so card state saves.
// `atPos` overrides the live caret — needed for the toolbar image button, where the
// file picker blurs the textarea and resets its selection before insertion.
function insertAtCursor(textarea, text, atPos) {
  textarea.focus();
  if (typeof atPos === "number") {
    const p = Math.max(0, Math.min(atPos, textarea.value.length));
    textarea.selectionStart = textarea.selectionEnd = p;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  textarea.value = val.substring(0, start) + text + val.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Replace the first occurrence of `find` with `replace` in the textarea (used to swap the
// "uploading…" placeholder for the final markdown once the upload resolves).
// Used to swap an "uploading…" placeholder for the final markdown once an
// async image upload resolves. The caret is preserved relative to the
// replaced region rather than always snapped to right after the replacement
// — the upload is async, so the user may have kept typing further down in
// the textarea while it was in flight; without this, the caret would jump
// back and split their in-progress typing as soon as the upload finished.
function replaceInTextarea(textarea, find, replace) {
  const idx = textarea.value.indexOf(find);
  if (idx === -1) return;
  const findEnd = idx + find.length;
  const delta = replace.length - find.length;
  const adjust = (pos) => {
    if (pos <= idx) return pos;
    if (pos >= findEnd) return pos + delta;
    return idx + replace.length; // caret was inside the placeholder itself
  };
  const newStart = adjust(textarea.selectionStart);
  const newEnd = adjust(textarea.selectionEnd);

  textarea.value = textarea.value.slice(0, idx) + replace + textarea.value.slice(findEnd);
  textarea.selectionStart = newStart;
  textarea.selectionEnd = newEnd;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Downscale + re-encode an image before upload to cut file size (screenshots are
// often huge PNGs). Animated GIFs and SVGs are passed through untouched — canvas
// would flatten/rasterize them. Falls back to the original file on any error or if
// the "optimized" result isn't actually smaller.
const IMAGE_MAX_DIMENSION = 1600; // longest edge, in px
const IMAGE_QUALITY = 0.82;
const IMAGE_MIME_EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

// Count a GIF's frames by walking its block structure. Only an ANIMATED gif has
// to skip optimization — the canvas path would flatten it to a still — but a
// single-frame GIF is just a picture, and passing every GIF through untouched
// meant a multi-megabyte one was stored and served at full size forever.
// Anything unparseable returns 2, i.e. "treat as animated", which is the answer
// that can only cost bytes rather than destroy the image.
function gifFrameCount(bytes) {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return 2;
  let at = 10;
  // Global colour table: flag is the high bit of the packed field at byte 10,
  // and its size is 3 × 2^(N+1) where N is the low three bits.
  if (bytes[at] & 0x80) at += 3 * (1 << ((bytes[at] & 0x07) + 1));
  at += 3; // packed field + background colour index + pixel aspect ratio
  const skipSubBlocks = () => {
    while (at < bytes.length) {
      const size = bytes[at++];
      if (!size) return true;
      at += size;
    }
    return false;
  };
  let frames = 0;
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3B) break;            // trailer
    if (marker === 0x21) {                 // extension: label, then sub-blocks
      at += 1;
      if (!skipSubBlocks()) return 2;
      continue;
    }
    if (marker !== 0x2C) return 2;         // not a valid block boundary
    frames += 1;
    if (frames > 1) return frames;         // animated — no need to finish
    at += 8;                               // image descriptor, up to its packed field
    const packed = bytes[at++];
    if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1)); // local colour table
    at += 1;                               // LZW minimum code size
    if (!skipSubBlocks()) return 2;
  }
  return frames;
}

async function optimizeImage(file) {
  const fileType = (file && file.type) || "";
  // SVG is vector: already small, and rasterizing it would be a downgrade.
  if (!fileType.startsWith("image/") || fileType === "image/svg+xml") return file;
  if (fileType === "image/gif") {
    try {
      const head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
      if (gifFrameCount(head) > 1) return file;
    } catch {
      return file;
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { resolve(file); return; }
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(w, h));
      // Whether the re-encode is allowed to lose on bytes alone. If the source
      // is oversized, the downscale is the point: a 4000px JPEG that is already
      // well compressed would otherwise be stored at 4000px and decoded at that
      // size on every single view, on every device.
      const wasDownscaled = scale < 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const toBlob = (mime) => new Promise((res) => canvas.toBlob(res, mime, IMAGE_QUALITY));
      // WebP keeps transparency and compresses better; fall back to JPEG if it's unsupported.
      toBlob("image/webp")
        .then((blob) => blob || toBlob("image/jpeg"))
        .then((blob) => {
          if (!blob || (blob.size >= file.size && !wasDownscaled)) { resolve(file); return; }
          const ext = IMAGE_MIME_EXT[blob.type] || "img";
          const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
          resolve(new File([blob], `${baseName}.${ext}`, { type: blob.type }));
        })
        .catch(() => resolve(file));
    };
    img.src = url;
  });
}

// Storage bucket for uploaded images (see supabase_setup.sql, section 7). Public
// read so a rendered `![](url)` works with no signed-in context; writes are
// scoped per-user by RLS, keyed on the user.id folder prefix used below.
const IMAGE_BUCKET = "images";

// Extension for the stored object's filename. Superset of IMAGE_MIME_EXT (which
// only ever sees optimized webp/jpeg/png blobs) so GIF/SVG — passed through
// un-optimized — get a real extension instead of ".img". Purely cosmetic:
// Storage serves the content-type set at upload, not one inferred from the name.
const IMAGE_STORAGE_EXT = {
  "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png",
  "image/gif": "gif", "image/svg+xml": "svg"
};

// ── Where an uploaded image lands in the bucket ────────────────────────────
// Everything used to go straight into one flat `{uid}/` folder with a
// timestamp-random filename, which made a bucket of thousands of images
// impossible to read: you couldn't tell which book or deck any object came
// from, and you couldn't clear out one import without picking objects off
// one at a time. Uploads are now filed as:
//
//   {uid}/books/{book-slug}--{importId}/{NNN}-{original-name}.{ext}
//   {uid}/decks/{deck-slug}--{localDeckId}/{ts}-{rand}.{ext}
//   {uid}/unfiled/{ts}-{rand}.{ext}
//
// The `--{id}` suffix is what makes each folder unique: two imports of the
// same book, or two same-titled decks, never share a folder, so one can be
// deleted without touching the other. It's a suffix (not a prefix) so a
// rename-tolerant lookup can still find every folder belonging to one deck by
// matching on the id, while the human-readable slug stays in front where it's
// useful in the Storage browser.
//
// Only NEW uploads are affected. Images already in notes are absolute URLs and
// keep working wherever they sit — supabaseImagePathFromUrl below reads a path
// of any depth, so deleting an old flat-path image still works too.
const UNFILED_IMAGE_FOLDER = "unfiled";
const MAX_STORAGE_SLUG_LENGTH = 48;

// One path segment, safe for a Storage object key and readable in the Storage
// browser: lowercase a-z0-9 and dashes only. Storage accepts more than this,
// but spaces and non-ASCII turn into percent-escapes in every URL and log line
// that mentions the object, which defeats the point of naming the folder.
export function storageFolderSlug(value, fallback = "untitled") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_STORAGE_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug || fallback;
}

// Short, collision-resistant id for one upload group (one EPUB import run).
// Timestamp-first so folders sort chronologically in the Storage browser.
function storageGroupId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Folder for images pasted/dropped into a deck's notes. Keyed on the deck's
// local id, which is stable for the deck's whole life, so every image a deck
// accumulates stays together. Returns null before the deck has ever been saved
// (no id to key on yet) — those go to `unfiled/`.
function deckImageFolder() {
  const localId = state.localDeckId;
  if (!localId) return null;
  const slug = storageFolderSlug(state.deckTitle || state.sourceTitle, "untitled-deck");
  return `decks/${slug}--${localId}`;
}

// Resolves a Supabase public-storage URL back to its object path within
// IMAGE_BUCKET, or null if `url` isn't one of ours (a legacy ImgBB/Drive/
// external link) — the signal deleteSupabaseImage uses to know whether
// there's anything it can actually delete.
export function supabaseImagePathFromUrl(url) {
  if (!supabaseClient || !url) return null;
  const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl("");
  const prefix = data?.publicUrl || "";
  if (!prefix || !url.startsWith(prefix)) return null;
  return url.slice(prefix.length).replace(/^\/+/, "");
}

// Best-effort delete of an uploaded image's underlying storage object. A no-op
// for URLs we didn't host (nothing to delete) or once the reference is already
// gone — this only ever runs after the note-side removal already succeeded, so
// a failure here is logged, not surfaced, rather than undoing that removal.
export async function deleteSupabaseImage(url) {
  const path = supabaseImagePathFromUrl(url);
  if (!path) return;
  try {
    const { error } = await supabaseClient.storage.from(IMAGE_BUCKET).remove([path]);
    if (error) console.warn("Could not delete image from storage", error);
  } catch (error) {
    console.warn("Could not delete image from storage", error);
  }
}

// Upload an image File/Blob to the signed-in user's own Supabase Storage
// bucket, returning its permanent public URL. Unlike ImgBB there's no separate
// API key to manage — the same login that unlocks sync also unlocks uploads,
// and because it's the user's own project, the image can later be deleted too
// (deleteSupabaseImage), which ImgBB's plain public-link API never allowed.
//
// `folder` is the per-book / per-deck subfolder the object is filed under (see
// the path scheme above); null means "no known owner" and lands in unfiled/.
// `name` is an optional extension-less basename — the EPUB importer passes the
// book's own image filename so a figure is recognisable in the bucket instead
// of being another anonymous timestamp.
async function uploadImageToSupabase(file, { folder = null, name = null } = {}) {
  if (!navigator.onLine) throw new Error("OFFLINE");
  if (!supabaseClient || !isSignedIn) throw new Error("NOT_SIGNED_IN");
  // Read the id from the cached session (no network) rather than getUser()
  // (a round-trip per call) — a bulk EPUB import is hundreds of uploads
  // back-to-back, and one auth request each would dominate the import time.
  const session = await getCachedSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("NOT_SIGNED_IN");
  const ext = IMAGE_STORAGE_EXT[file.type] || "img";
  // The first segment stays the raw auth.uid() — the storage RLS policies match
  // on (storage.foldername(name))[1], so anything else here is rejected. Deeper
  // segments are unconstrained, which is why this nesting needs no SQL change.
  const dir = `${userId}/${folder || UNFILED_IMAGE_FOLDER}`;
  const base = name || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const path = `${dir}/${base}.${ext}`;
  const { error } = await withTimeout(
    supabaseClient.storage.from(IMAGE_BUCKET).upload(path, file, {
      contentType: file.type || "application/octet-stream",
      // Without this Supabase serves max-age=3600, so the browser re-fetched
      // every image in any session more than an hour after the last one. The
      // path above is random and never overwritten (upsert: false), so the
      // bytes at this URL cannot change and the cache can be permanent.
      cacheControl: "31536000, immutable",
      upsert: false
    }),
    CLOUD_TIMEOUT_MS,
    "upload image"
  );
  if (error) {
    const err = new Error(error.message || "Upload failed");
    // An RLS rejection is permanent for this session the same way a bad ImgBB
    // key was — retrying identically-forbidden uploads would just burn through
    // the rest of an EPUB import's images for nothing.
    err.authFailed = /permission|policy|not.*authoriz|row-level security/i.test(error.message || "");
    throw err;
  }
  const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  await cacheUploadedImageOffline(data.publicUrl, file);
  return data.publicUrl;
}

// The service worker's image cache is populated by FETCHING images — which
// means an image the user just added was the one image guaranteed to be missing
// from it: the markdown now points at a public URL, but the only copy that ever
// existed on this device was the file they picked, and it was uploaded, never
// downloaded. Going offline right after adding an image showed it as broken.
// We already hold the bytes, so write them straight into the same cache the
// worker reads (same name as sw.js's IMAGE_CACHE_NAME — it is deliberately not
// versioned, so this survives app updates). Best-effort: a failure here costs a
// re-download later, nothing more.
export const OFFLINE_IMAGE_CACHE = "recall-images-v1";

export async function cacheUploadedImageOffline(url, blob) {
  if (!url || !blob || typeof caches === "undefined") return;
  try {
    const cache = await caches.open(OFFLINE_IMAGE_CACHE);
    await cache.put(url, new Response(blob, {
      headers: { "Content-Type": blob.type || "application/octet-stream" }
    }));
  } catch (error) {
    console.warn("Could not pre-cache the uploaded image for offline use", error);
  }
}

// Insert an "uploading…" placeholder, upload the image, then swap in `![](url)`.
// Dropped in wherever the caret is — no surrounding blank-line padding needed:
// every rendered <img> gets wrapped in a block-level .diagram-shell (see
// enhanceSurfaceImageControls below), so it always lands on its own visual row
// regardless of whether it shares a markdown paragraph with other text. That
// same paragraph-sharing case gets the corner-drag resize grip immediately
// too (findImageTokens' `isInline` case), not a "move to its own line" step.
// `atPos` (optional) forces the placeholder to the caret captured before the file
// picker opened; without it the current caret is used (paste/drop already have focus).
// ── Offline image outbox ─────────────────────────────────────────────────────
// An image picked while offline used to be thrown away with "Can't upload image
// while offline" — the placeholder was deleted from the markdown and the file
// was gone. Now the blob is parked in IndexedDB (localStorage can't hold binary
// without a ~33% base64 tax on an already-tight quota), the markdown gets a
// `recall-img:<token>` placeholder that renders from the local blob, and the
// next reconcile uploads it and rewrites the placeholder to the real URL.
const IMAGE_OUTBOX_DB = "recall-outbox";
const IMAGE_OUTBOX_STORE = "images";
// The scheme used in markdown for a not-yet-uploaded image. Deliberately not a
// bare `blob:` URL: those die with the page, and the markdown outlives it.
export const LOCAL_IMAGE_SCHEME = "recall-img:";

function openImageOutbox() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(IMAGE_OUTBOX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_OUTBOX_STORE)) {
        db.createObjectStore(IMAGE_OUTBOX_STORE, { keyPath: "token" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function imageOutboxRequest(mode, run) {
  return openImageOutbox().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_OUTBOX_STORE, mode);
    const request = run(tx.objectStore(IMAGE_OUTBOX_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  }));
}

export const putOutboxImage = (entry) => imageOutboxRequest("readwrite", (store) => store.put(entry));
export const getOutboxImage = (token) => imageOutboxRequest("readonly", (store) => store.get(token));
const allOutboxImages = () => imageOutboxRequest("readonly", (store) => store.getAll());
const deleteOutboxImage = (token) => imageOutboxRequest("readwrite", (store) => store.delete(token));

// Whether an image is still parked under this token. Used by restore to leave a
// `recall-img:` reference alone when this device's outbox already holds it,
// instead of parking (and later uploading) a second copy of the same image.
export async function outboxHasToken(token) {
  try {
    return Boolean(await getOutboxImage(token));
  } catch {
    return false;
  }
}

// Object URLs minted for queued images, so they can be revoked rather than
// leaked. Keyed by token, since the same image may render many times.
const localImageObjectUrls = new Map();

// Resolve `recall-img:<token>` to a displayable blob URL. Returns null when the
// token is gone (already uploaded, or the outbox was cleared), which the caller
// treats as a missing image rather than an error.
async function resolveLocalImageUrl(token) {
  if (localImageObjectUrls.has(token)) return localImageObjectUrls.get(token);
  try {
    const entry = await getOutboxImage(token);
    if (!entry?.blob) return null;
    const url = URL.createObjectURL(entry.blob);
    // Resolves run in parallel now (see hydrateLocalImages), so the same token —
    // the same image used twice in one note — can be read twice at once. Without
    // this the loser's blob URL is overwritten in the map and never revoked,
    // pinning the image's bytes for the life of the session.
    if (localImageObjectUrls.has(token)) {
      URL.revokeObjectURL(url);
      return localImageObjectUrls.get(token);
    }
    localImageObjectUrls.set(token, url);
    return url;
  } catch (error) {
    console.warn("Could not read the queued image", error);
    return null;
  }
}

// Every blob URL minted so far, released.
//
// Called on pagehide, on clear-this-device, and — the one that matters for a
// session that never navigates — on every deck swap. Each entry pins a whole
// image's bytes in memory for as long as the URL exists, and a PWA can go hours
// without a pagehide, so holding them for the session meant image memory only
// ever grew. Safe to do eagerly because resolveLocalImageUrl re-mints on demand
// from the outbox: a revoked URL costs one lazy IndexedDB read, and the render
// that follows a deck swap re-resolves every placeholder anyway.
export function revokeLocalImageUrls() {
  for (const url of localImageObjectUrls.values()) URL.revokeObjectURL(url);
  localImageObjectUrls.clear();
}

// Swap every recall-img: placeholder in the DOM for its blob URL. Called after
// a render, since markdown-to-HTML leaves the custom scheme untouched.
// `root` is a container, or the list of freshly rendered nodes the incremental
// renderer just built (which may themselves be the images).
export async function hydrateLocalImages(root = document) {
  const nodes = Array.isArray(root)
    ? scopedQueryAll(root, `img[src^="${LOCAL_IMAGE_SCHEME}"]`)
    : root.querySelectorAll?.(`img[src^="${LOCAL_IMAGE_SCHEME}"]`);
  if (!nodes || !nodes.length) return;
  // In parallel, not one awaited IndexedDB read after another: revokeLocalImageUrls
  // runs on every deck swap, so every render after a swap re-resolves each
  // pending image from scratch and serialising them showed as the images
  // appearing one by one.
  await Promise.all(Array.from(nodes, async (node) => {
    const token = node.getAttribute("src").slice(LOCAL_IMAGE_SCHEME.length);
    const url = await resolveLocalImageUrl(token);
    if (url) {
      node.src = url;
      node.dataset.pendingUpload = "1";
      node.title = "Waiting to upload — will sync when you're back online";
    }
  }));
}

// Upload everything the outbox is holding and rewrite the markdown that points
// at it. Called from reconcileAllDecks. Returns how many images landed.
export async function flushPendingImageUploads() {
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return 0;
  let queued;
  try {
    queued = await allOutboxImages();
  } catch (error) {
    console.warn("Could not read the image outbox", error);
    return 0;
  }
  if (!queued?.length) return 0;

  let uploaded = 0;
  for (const entry of queued) {
    let url;
    try {
      url = await uploadImageToSupabase(entry.blob, { folder: entry.folder || null });
    } catch (error) {
      // A permanent rejection (RLS) would fail identically forever, and holding
      // the blob would re-attempt it on every single sync. Anything else is
      // worth keeping for the next try.
      if (error?.authFailed) {
        console.warn("Dropping a queued image the server refuses", error);
        await deleteOutboxImage(entry.token).catch(() => {});
      }
      continue;
    }
    await rewriteLocalImageReferences(entry.token, url);
    await deleteOutboxImage(entry.token).catch(() => {});
    const objectUrl = localImageObjectUrls.get(entry.token);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      localImageObjectUrls.delete(entry.token);
    }
    uploaded++;
  }
  return uploaded;
}

// Point every copy of a placeholder at the real URL: the live editor and state
// (so the change is visible now) and every stored snapshot (so it survives, and
// so the deck's own updatedAt bump carries it to the cloud).
async function rewriteLocalImageReferences(token, url) {
  const placeholder = LOCAL_IMAGE_SCHEME + token;
  const swap = (text) => String(text || "").split(placeholder).join(url);
  const touched = (text) => String(text || "").includes(placeholder);

  if (touched(state.notes)) state.notes = swap(state.notes);
  for (const list of [state.masterCards, state.cards]) {
    for (const card of list || []) {
      if (touched(card.question)) card.question = swap(card.question);
      if (touched(card.answer)) card.answer = swap(card.answer);
    }
  }

  const now = new Date().toISOString();
  // Cursor-streamed for the same reason as the math repair: this scans the
  // whole library to find the (usually one) deck holding the placeholder, and
  // reading every deck by id would pull the entire library into memory just to
  // rewrite one string. Rewrites are collected and applied after the scan —
  // the cursor's transaction is readonly.
  const rewritten = [];
  await forEachDeckSnapshot((id, snapshot) => {
    const notesTouched = touched(snapshot.notes);
    const touchedCards = (snapshot.cards || []).filter((card) => touched(card.question) || touched(card.answer));
    if (!notesTouched && !touchedCards.length) return;
    if (notesTouched) snapshot.notes = swap(snapshot.notes);
    for (const card of touchedCards) {
      card.question = swap(card.question);
      card.answer = swap(card.answer);
      // The card's text genuinely changed, so it owes the cloud a push.
      card.dirty = true;
      card.updatedAt = now;
    }
    // IndexedDB's own clone of the record, not the shared cache object — safe
    // to have mutated in place above.
    rewritten.push({ id: String(id), snapshot });
  });

  if (!rewritten.length) return;
  for (const { id, snapshot } of rewritten) writeDeckSnapshot(id, snapshot);
  // One index write for the whole batch, read fresh so a concurrent change
  // isn't reverted. A notes-conflict stash has no index entry — it simply
  // doesn't match, which is correct: its content was still rewritten above.
  const touchedIds = new Set(rewritten.map((r) => r.id));
  const index = readLocalDeckIndex();
  let indexChanged = false;
  for (const entry of index) {
    if (!touchedIds.has(String(entry.id))) continue;
    entry.updatedAt = now;
    indexChanged = true;
  }
  if (indexChanged) writeLocalDeckIndex(index);
}

async function insertImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const uploadToken = `![uploading…](#upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)})`;
  insertAtCursor(textarea, uploadToken, atPos);
  showToast("Optimizing image…", "info");
  let optimized = file;
  // Resolved before the await so the image is filed under the deck the user
  // actually pasted into, even if they switch decks while it uploads.
  const folder = deckImageFolder();
  try {
    optimized = await optimizeImage(file);
    const url = await uploadImageToSupabase(optimized, { folder });
    replaceInTextarea(textarea, uploadToken, `![](${url})`);
    showToast("Image uploaded", "success");
    return;
  } catch (err) {
    if (err.message !== "OFFLINE") {
      replaceInTextarea(textarea, uploadToken, "");
      if (err.message === "NOT_SIGNED_IN") {
        showToast("Sign in to upload images", "error");
      } else {
        console.error("Image upload failed", err);
        showToast("Image upload failed", "error");
      }
      return;
    }
  }

  // Offline: park the blob and leave a placeholder that renders from it, rather
  // than discarding the image the user just chose.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  try {
    // `folder` rides along so a queued image still lands beside the rest of its
    // deck's images when it finally uploads, however many decks the user has
    // opened in between. Entries queued before this existed have no folder and
    // fall back to unfiled/.
    await putOutboxImage({ token, blob: optimized, folder, savedAt: new Date().toISOString() });
  } catch (error) {
    console.warn("Could not queue the image for upload", error);
    replaceInTextarea(textarea, uploadToken, "");
    showToast("Can't upload image while offline", "error");
    return;
  }
  replaceInTextarea(textarea, uploadToken, `![](${LOCAL_IMAGE_SCHEME}${token})`);
  showToast("Image saved here — uploads when you're back online", "info");
}

// ══════════════════════════════════════════════════════════════════════════
// Storage & Data
//
// What the account is actually holding — decks and cards in the database,
// image objects in the Storage bucket, and the copies this device keeps — plus
// the cleanup that used to have no home.
//
// It lives in the app rather than in a SQL snippet for a hard reason: Supabase
// REFUSES to let you delete from the storage tables in SQL (`storage.protect_delete`
// raises "Direct deletion from storage tables is not allowed. Use the Storage
// API instead."), because rows deleted that way leave the underlying files
// orphaned. The Storage API is reachable from here, with the session that owns
// the files — so this is the only place the cleanup can honestly happen.
//
// Everything below is scoped to the signed-in account: RLS makes another user's
// rows invisible, and the bucket policies confine writes and deletes to that
// user's own `{uid}/` folder. There is deliberately no way to wipe someone
// else's data from the app.
// ══════════════════════════════════════════════════════════════════════════

const STORAGE_LIST_PAGE = 100;
// Storage's remove() takes a path array; keep each request modest so one slow
// batch can't stall the whole cleanup.
const STORAGE_DELETE_BATCH = 100;

let storageReport = null;
let storageBusy = false;

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Every object under one prefix, walking into subfolders. Storage's list() is
// one level at a time and pages at `limit`, and a folder entry is distinguished
// from a file by having no `id` — an EPUB import alone can nest hundreds of
// figures under books/<slug>--<run>/, so the recursion is not optional.
async function listStorageObjects(prefix, onProgress, out = []) {
  for (let offset = 0; ; offset += STORAGE_LIST_PAGE) {
    const { data, error } = await withTimeout(
      supabaseClient.storage.from(IMAGE_BUCKET).list(prefix, {
        limit: STORAGE_LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" }
      }),
      CLOUD_TIMEOUT_MS,
      "list images"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (row.id) {
        out.push({
          path,
          name: row.name,
          size: Number(row.metadata?.size) || 0,
          mimetype: row.metadata?.mimetype || "",
          updatedAt: row.updated_at || row.created_at || null
        });
        onProgress?.(out.length);
      } else {
        // A folder. `.emptyFolderPlaceholder` rows come back as files with a
        // real id and are counted like any other object — they're tiny, and
        // pretending they don't exist would make the count disagree with the
        // dashboard.
        await listStorageObjects(path, onProgress, out);
      }
    }
    if (rows.length < STORAGE_LIST_PAGE) break;
  }
  return out;
}

// Every storage path the library still points at. Read from the CLOUD (the
// authoritative copy — a deck may exist only there) unioned with this device's
// local snapshots (which may hold decks not pushed yet). Throws rather than
// returning a partial set: an incomplete reference list would mark live images
// as orphans, and this is the input to a delete.
async function collectReferencedStoragePaths(onProgress) {
  const paths = new Set();
  const add = (text) => {
    for (const match of String(text || "").matchAll(BACKUP_IMAGE_REF_RE)) {
      const ref = decodeImageRefEntities(match[1] || match[2] || match[3] || match[4] || "");
      const path = ref && !ref.startsWith(LOCAL_IMAGE_SCHEME) ? supabaseImagePathFromUrl(ref) : null;
      if (path) paths.add(path);
    }
  };

  // Streamed via a cursor (see forEachDeckSnapshot), not the index: this also
  // catches a stashed notes-conflict copy (see NOTES_CONFLICT_SUFFIX), which
  // has its own `notes` field and isn't listed in the index at all — a real
  // image referenced only from an unresolved conflict used to be able to
  // read as orphaned and get deleted out from under it.
  await forEachDeckSnapshot((id, snapshot) => {
    add(snapshot.notes);
    for (const card of snapshot.cards || []) { add(card.question); add(card.answer); }
  });

  onProgress?.("Reading decks in the cloud…");
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("decks").select("id, notes").range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "read deck notes"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) add(row.notes);
    if (rows.length < pageSize) break;
  }

  onProgress?.("Reading cards in the cloud…");
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient.from("cards").select("id, question, answer").range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "read cards"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) { add(row.question); add(row.answer); }
    if (rows.length < pageSize) break;
  }

  return paths;
}

// Counts straight out of the database, as cheaply as PostgREST allows: a
// head-only select with count returns the number without the rows.
async function countCloudRows(table) {
  const { count, error } = await withTimeout(
    supabaseClient.from(table).select("*", { count: "exact", head: true }),
    CLOUD_TIMEOUT_MS,
    `count ${table}`
  );
  if (error) throw error;
  return count || 0;
}

async function localLibraryStats() {
  const index = readLocalDeckIndex();
  // Card count comes from the index (already maintained there) — no need to
  // touch a single snapshot body for it.
  const cards = index.reduce((n, meta) => n + (Number(meta.cardCount) || 0), 0);
  // Bytes, though, means measuring actual snapshot content — streamed via a
  // cursor (see forEachDeckSnapshot) rather than reading each by id, and this
  // also picks up stashed notes-conflict copies the index doesn't list, which
  // is arguably more accurate: they really are bytes on this device.
  let bytes = 0;
  try {
    await forEachDeckSnapshot((id, snapshot) => {
      bytes += JSON.stringify(snapshot).length;
    });
  } catch (error) {
    console.warn("Could not measure local library size", error);
  }
  return { decks: index.length, cards, bytes };
}

async function deviceStorageStats() {
  const stats = { ...(await localLibraryStats()), queuedImages: 0, cachedImages: 0, quotaUsed: 0, quota: 0 };
  try {
    stats.queuedImages = (await allOutboxImages())?.length || 0;
  } catch { /* no outbox yet */ }
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      stats.cachedImages = (await cache.keys()).length;
    }
  } catch { /* cache storage unavailable (private window) */ }
  try {
    const estimate = await navigator.storage?.estimate?.();
    stats.quotaUsed = estimate?.usage || 0;
    stats.quota = estimate?.quota || 0;
  } catch { /* not supported */ }
  return stats;
}

// One pass over everything, so the panel's numbers all describe the same
// moment. Cloud-side failures are captured per section rather than thrown:
// being offline should still show what this device holds.
async function buildStorageReport(onProgress) {
  const report = {
    at: new Date(),
    signedIn: Boolean(supabaseClient && isSignedIn),
    online: navigator.onLine,
    cloud: null,
    cloudError: "",
    storage: null,
    storageError: "",
    device: await deviceStorageStats()
  };

  if (!report.signedIn) {
    report.cloudError = "Not signed in — cloud figures unavailable.";
    report.storageError = report.cloudError;
    return report;
  }
  if (!report.online) {
    report.cloudError = "This device is offline — cloud figures unavailable.";
    report.storageError = report.cloudError;
    return report;
  }

  try {
    onProgress?.("Counting decks and cards…");
    const [decks, cards, tombstones] = await Promise.all([
      countCloudRows("decks"),
      countCloudRows("cards"),
      countCloudRows("deleted_decks").catch(() => 0)
    ]);
    report.cloud = { decks, cards, tombstones };
  } catch (error) {
    report.cloudError = error?.message || "Could not read the database.";
  }

  try {
    const session = await getCachedSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error("no session");
    onProgress?.("Listing images…");
    const objects = await listStorageObjects(userId, (n) => onProgress?.(`Listing images… ${n}`));
    const bytes = objects.reduce((sum, object) => sum + object.size, 0);

    // Grouped the way uploads are filed: books/<book>, decks/<deck>, unfiled/,
    // and whatever sits directly in {uid}/ from before the subfolder scheme.
    const groups = new Map();
    for (const object of objects) {
      const rest = object.path.slice(userId.length + 1);
      const parts = rest.split("/");
      const label = parts.length > 2 ? `${parts[0]}/${parts[1]}`
        : parts.length === 2 ? parts[0]
          : "(loose files)";
      const group = groups.get(label) || { label, count: 0, bytes: 0 };
      group.count += 1;
      group.bytes += object.size;
      groups.set(label, group);
    }

    let orphans = [];
    let orphanError = "";
    try {
      onProgress?.("Checking which images are still used…");
      const referenced = await collectReferencedStoragePaths(onProgress);
      orphans = objects.filter((object) => !referenced.has(object.path));
    } catch (error) {
      // Never guess here: an incomplete reference scan would present live
      // images as deletable.
      orphanError = error?.message || "Could not check which images are in use.";
    }

    report.storage = {
      userId,
      objects,
      count: objects.length,
      bytes,
      groups: Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes),
      orphans,
      orphanBytes: orphans.reduce((sum, object) => sum + object.size, 0),
      orphanError
    };
  } catch (error) {
    report.storageError = error?.message || "Could not read the image bucket.";
  }

  return report;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

async function deleteStorageObjects(paths, onProgress) {
  let deleted = 0;
  for (let i = 0; i < paths.length; i += STORAGE_DELETE_BATCH) {
    const batch = paths.slice(i, i + STORAGE_DELETE_BATCH);
    const { error } = await withTimeout(
      supabaseClient.storage.from(IMAGE_BUCKET).remove(batch),
      CLOUD_TIMEOUT_MS,
      "delete images"
    );
    if (error) throw error;
    deleted += batch.length;
    onProgress?.(`Deleting images ${deleted}/${paths.length}…`);
  }
  // The offline cache still holds copies of files that no longer exist.
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(OFFLINE_IMAGE_CACHE);
      const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl("");
      const prefix = (data?.publicUrl || "").replace(/\/+$/, "");
      for (const path of paths) await cache.delete(`${prefix}/${path}`);
    }
  } catch (error) {
    console.warn("Could not drop deleted images from the offline cache", error);
  }
  return deleted;
}

// Delete every deck row for this account. Cards go with them (cards.deck_id is
// ON DELETE CASCADE), and RLS confines the delete to rows this user owns, so
// the `neq` filter below is only there because PostgREST refuses an unfiltered
// DELETE outright.
async function deleteAllCloudDecks() {
  const { error } = await withTimeout(
    supabaseClient.from("decks").delete().neq("id", " "),
    CLOUD_TIMEOUT_MS,
    "delete decks"
  );
  if (error) throw error;
}

async function deleteAllCloudTombstones() {
  const { error } = await withTimeout(
    supabaseClient.from("deleted_decks").delete().neq("deck_id", " "),
    CLOUD_TIMEOUT_MS,
    "delete tombstones"
  );
  if (error) throw error;
}

// Everything this device keeps: the deck index and every snapshot, the queued
// image outbox, and the offline image cache. Deliberately does NOT touch the
// Supabase config or the session — clearing those would sign the user out and
// make them re-enter the project URL and key, which is a different (and much
// more annoying) action than emptying the library.
async function wipeLocalLibrary() {
  const snapshotCount = (await allDeckSnapshotIds()).length;
  await clearAllDeckSnapshots();
  localStorage.removeItem(LOCAL_DECKS_INDEX_KEY);
  // Clearing the device is the explicit "free up space" action — the same
  // reason deleteDeckFromLibrary resets this — so a quota latch from before
  // must not keep blocking autosave after the library that caused it is gone.
  setDeckAutosaveStorageFailed(false);
  try {
    for (const entry of await allOutboxImages()) await deleteOutboxImage(entry.token);
  } catch { /* nothing queued */ }
  revokeLocalImageUrls();
  try {
    if (typeof caches !== "undefined") await caches.delete(OFFLINE_IMAGE_CACHE);
  } catch { /* nothing cached */ }
  resetActiveDeckAfterDelete();
  await renderMyDecksList();
  return snapshotCount + 1;
}

// ── Panel ──────────────────────────────────────────────────────────────────

function openStoragePanel() {
  lockPageScroll();
  el.storagePanel.hidden = false;
  renderStoragePanel();
  refreshStorageReport();
}

export function closeStoragePanel() {
  el.storagePanel.hidden = true;
  unlockPageScroll();
}

async function refreshStorageReport() {
  if (storageBusy) return;
  storageBusy = true;
  renderStoragePanel("Reading…");
  try {
    storageReport = await buildStorageReport((text) => renderStoragePanel(text));
  } catch (error) {
    console.error("Storage report failed", error);
    storageReport = null;
    renderStoragePanel(`Could not read storage: ${error?.message || "unknown error"}`);
    storageBusy = false;
    return;
  }
  storageBusy = false;
  renderStoragePanel();
}

function storageStatTile(value, label, tone = "") {
  return `<div class="storage-stat${tone ? ` ${tone}` : ""}"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderStoragePanel(busyText = "") {
  const body = el.storageBody;
  if (!body) return;
  const report = storageReport;

  if (busyText || !report) {
    body.innerHTML = `
      <div class="storage-card">
        <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
        <p class="storage-busy">${escapeHtml(busyText || "Reading…")}</p>
      </div>`;
    return;
  }

  const cloud = report.cloud;
  const store = report.storage;
  const device = report.device;

  const cloudSection = cloud
    ? `<div class="storage-stats">
         ${storageStatTile(cloud.decks, "Decks")}
         ${storageStatTile(cloud.cards, "Cards")}
         ${storageStatTile(cloud.tombstones, "Delete records")}
       </div>`
    : `<p class="storage-note is-warning">${escapeHtml(report.cloudError || "No cloud data.")}</p>`;

  const storageSection = store
    ? `<div class="storage-stats">
         ${storageStatTile(store.count, "Images")}
         ${storageStatTile(formatStorageBytes(store.bytes), "Used")}
         ${storageStatTile(store.orphanError ? "?" : store.orphans.length, "Unused", store.orphans.length ? "is-warn" : "")}
       </div>
       ${store.groups.length ? `<ul class="storage-groups">${store.groups.map((group) => `
         <li><span class="storage-group-name">${escapeHtml(group.label)}</span>
             <span class="storage-group-count">${group.count} file${group.count === 1 ? "" : "s"}</span>
             <span class="storage-group-size">${escapeHtml(formatStorageBytes(group.bytes))}</span></li>`).join("")}</ul>` : ""}
       ${store.orphanError
        ? `<p class="storage-note is-warning">${escapeHtml(store.orphanError)} Unused-image cleanup is disabled until this succeeds.</p>`
        : store.orphans.length
          ? `<p class="storage-note">${store.orphans.length} image${store.orphans.length === 1 ? " is" : "s are"} no longer referenced by any deck or note (${escapeHtml(formatStorageBytes(store.orphanBytes))}). These are what deleting an image or a deck leaves behind.</p>`
          : `<p class="storage-note">Every stored image is still in use.</p>`}`
    : `<p class="storage-note is-warning">${escapeHtml(report.storageError || "No image data.")}</p>`;

  body.innerHTML = `
    <div class="storage-card">
      <h2>Cloud database</h2>
      <p class="storage-sub">Your decks, cards and cross-device delete records.</p>
      ${cloudSection}
    </div>

    <div class="storage-card">
      <h2>Image storage</h2>
      <p class="storage-sub">Files in the <code>images</code> bucket, under your own folder.</p>
      ${storageSection}
    </div>

    <div class="storage-card">
      <h2>This device</h2>
      <p class="storage-sub">The local copy that makes the app work offline.</p>
      <div class="storage-stats">
        ${storageStatTile(device.decks, "Decks")}
        ${storageStatTile(formatStorageBytes(device.bytes), "On this device")}
        ${storageStatTile(device.cachedImages, "Cached images")}
        ${storageStatTile(device.queuedImages, "Queued uploads", device.queuedImages ? "is-warn" : "")}
      </div>
      ${device.quota ? `<p class="storage-note">Browser storage used by this site: ${escapeHtml(formatStorageBytes(device.quotaUsed))} of about ${escapeHtml(formatStorageBytes(device.quota))} available${storagePersisted === false ? " (not persisted — the browser may reclaim some of this under disk pressure)" : storagePersisted ? " (persisted)" : ""}.</p>` : ""}
      ${device.queuedImages ? `<p class="storage-note is-warning">${device.queuedImages} image${device.queuedImages === 1 ? "" : "s"} still waiting to upload. Sync before clearing this device, or those images are lost.</p>` : ""}
    </div>

    <div class="storage-card is-danger">
      <h2>Clean up</h2>
      <p class="storage-sub">Nothing here drops a table, a bucket or your account — it only empties contents, and only for your account.</p>
      <div class="storage-actions">
        <button type="button" class="storage-action" data-storage-action="orphans"
          ${store && !store.orphanError && store.orphans.length ? "" : "disabled"}>
          Delete unused images${store && !store.orphanError && store.orphans.length ? ` (${store.orphans.length})` : ""}
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="images" ${store && store.count ? "" : "disabled"}>
          Delete all images
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="decks" ${cloud && (cloud.decks || cloud.tombstones) ? "" : "disabled"}>
          Delete all cloud decks &amp; cards
        </button>
        <button type="button" class="storage-action" data-storage-action="device" ${device.decks || device.cachedImages || device.queuedImages ? "" : "disabled"}>
          Clear this device
        </button>
        <button type="button" class="storage-action is-danger" data-storage-action="everything">
          Reset everything
        </button>
      </div>
      <p class="storage-note">Take a backup first — <strong>My Decks → ⋯ → Export All → Backup (.zip)</strong> holds every deck, note and image.</p>
    </div>

    <p class="storage-timestamp">Counted ${escapeHtml(report.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }))}${report.online ? "" : " · offline"}</p>
  `;
}

// A destructive action has to be typed out, not just clicked past.
function confirmByTyping(word, title, hint) {
  return new Promise((resolve) => {
    showPromptModal(title, hint, "", (value) => {
      resolve(String(value || "").trim().toUpperCase() === word.toUpperCase());
    }, { placeholder: word });
  });
}

async function runStorageAction(action) {
  if (storageBusy) return;
  const report = storageReport;
  const store = report?.storage;
  const device = report?.device;

  const run = async (label, work) => {
    storageBusy = true;
    renderStoragePanel(label);
    try {
      await work((text) => renderStoragePanel(text));
      storageBusy = false;
      await refreshStorageReport();
      showToast("Done", "success");
    } catch (error) {
      console.error("Storage cleanup failed", error);
      storageBusy = false;
      renderStoragePanel(`Failed: ${error?.message || "unknown error"}`);
      showToast("Cleanup failed", "error");
    }
  };

  if (action === "orphans") {
    if (!store?.orphans.length) return;
    const paths = store.orphans.map((object) => object.path);
    showConfirmModal(
      `Delete ${paths.length} unused image${paths.length === 1 ? "" : "s"} (${formatStorageBytes(store.orphanBytes)})? No deck or note points at ${paths.length === 1 ? "it" : "them"}.`,
      () => run("Deleting unused images…", (progress) => deleteStorageObjects(paths, progress)),
      { confirmLabel: "Delete", danger: true }
    );
    return;
  }

  if (action === "images") {
    if (!store?.count) return;
    if (!await confirmByTyping("DELETE", "Delete every image?",
      `All ${store.count} images (${formatStorageBytes(store.bytes)}) will be removed from your storage. Decks and notes stay, but the pictures in them become broken links. Type DELETE to confirm.`)) return;
    await run("Deleting images…", (progress) => deleteStorageObjects(store.objects.map((object) => object.path), progress));
    return;
  }

  if (action === "decks") {
    if (!await confirmByTyping("DELETE", "Delete all cloud decks and cards?",
      `${report.cloud.decks} deck${report.cloud.decks === 1 ? "" : "s"} and ${report.cloud.cards} card${report.cloud.cards === 1 ? "" : "s"} will be deleted from the database. Every device that has synced them will drop its copy on its next sync. Type DELETE to confirm.`)) return;
    await run("Deleting decks…", async (progress) => {
      await deleteAllCloudDecks();
      progress("Clearing delete records…");
      await deleteAllCloudTombstones().catch((error) => console.warn("Could not clear tombstones", error));
    });
    return;
  }

  if (action === "device") {
    const warning = device.queuedImages
      ? ` ${device.queuedImages} image${device.queuedImages === 1 ? "" : "s"} still waiting to upload will be lost.`
      : "";
    showConfirmModal(
      `Clear this device's copy of the library? Your cloud data is untouched and syncs back down.${warning} You stay signed in.`,
      () => run("Clearing this device…", () => wipeLocalLibrary()),
      { confirmLabel: "Clear device", danger: true }
    );
    return;
  }

  if (action === "everything") {
    if (!await confirmByTyping("RESET", "Reset everything?",
      "Deletes every deck, card and image in your account AND this device's copy. Tables, buckets, policies and your login all stay, so the app keeps working — it just starts empty. This cannot be undone. Type RESET to confirm.")) return;
    await run("Resetting…", async (progress) => {
      if (store?.objects.length) await deleteStorageObjects(store.objects.map((object) => object.path), progress);
      progress("Deleting decks and cards…");
      await deleteAllCloudDecks();
      progress("Clearing delete records…");
      await deleteAllCloudTombstones().catch((error) => console.warn("Could not clear tombstones", error));
      progress("Clearing this device…");
      await wipeLocalLibrary();
    });
    return;
  }
}

// ── Keeping a pasted GIF animated ──────────────────────────────────────────
// Copying an animated GIF from a web page puts a FLATTENED still on the
// clipboard — Chrome rasterises whichever frame was showing and hands it over as
// image/png — so pasting one stored a motionless picture, no matter that
// optimizeImage and IMAGE_STORAGE_EXT both already handle image/gif correctly.
// The animation is still reachable: the same clipboard/drag carries a text/html
// fragment (or a text/uri-list) pointing at the original file, so when that
// points at a GIF we fetch the real bytes and store those instead.
//
// Best-effort throughout: a host that serves no CORS headers, a URL that turns
// out not to be a GIF after all, or an offline device all fall back to the
// flattened frame rather than losing the paste.

// A GIF URL carried alongside the flattened bitmap, or null. DOMParser (not
// innerHTML) so parsing the fragment can't kick off a load of every image in it.
function gifSourceUrlFromTransfer(dataTransfer) {
  const looksLikeGif = (url) => /^https?:/i.test(url) && /\.gif(\?|#|$)/i.test(url);
  let html = "";
  try {
    html = dataTransfer?.getData?.("text/html") || "";
  } catch (_) { /* some transfer types are unreadable outside their own event */ }
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const imgs = doc.querySelectorAll("img");
      // More than one image means the paste is a chunk of a page, not a single
      // copied image — the markdown converter handles that case, not this one.
      if (imgs.length === 1) {
        const src = imgs[0].getAttribute("src") || "";
        if (looksLikeGif(src)) return src;
      }
    } catch (_) { /* malformed fragment — fall through to the uri-list */ }
  }
  let uriList = "";
  try {
    uriList = dataTransfer?.getData?.("text/uri-list") || "";
  } catch (_) { /* as above */ }
  const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  return uri && looksLikeGif(uri) ? uri : null;
}

async function fetchGifFile(url) {
  if (!navigator.onLine) return null;
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    // The URL ended in .gif; trust what came back over what it was named.
    if (blob.type !== "image/gif" || !blob.size) return null;
    const name = (url.split("/").pop() || "image.gif").split(/[?#]/)[0] || "image.gif";
    return new File([blob], name, { type: "image/gif" });
  } catch (_) {
    return null;
  }
}

// Insert an image that arrived by paste or drop. Identical to insertImageUpload
// except that a clipboard-flattened GIF is swapped back for the real animated
// file first. Both `gifUrl` and `atPos` are captured by the CALLER while the
// event is still live, because a DataTransfer can't be read after its handler
// returns and the caret may move while the GIF is being fetched.
async function insertTransferImage(textarea, file, gifUrl, atPos) {
  let toUpload = file;
  if (gifUrl) {
    showToast("Fetching the original GIF…", "info");
    toUpload = (await fetchGifFile(gifUrl)) || file;
    if (toUpload === file) showToast("Couldn't fetch the animated GIF — kept the still frame", "info");
  }
  insertImageUpload(textarea, toUpload, atPos);
}

// Detect an image in a DataTransfer during `dragover`, where getAsFile() is still
// null (file data is protected until drop). Reads item kind/type (exposed during
// dragover) with a "Files" types fallback for browsers that don't populate items yet.
function dragContainsImage(dataTransfer) {
  if (!dataTransfer) return false;
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) return true;
    }
  }
  const types = dataTransfer.types;
  if (types) {
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
  }
  return false;
}

// Pull the first image File from a clipboard/drag DataTransfer, if any.
function firstImageFile(dataTransfer) {
  if (!dataTransfer) return null;
  const files = dataTransfer.files;
  if (files && files.length) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f && f.type && f.type.startsWith("image/")) return f;
    }
  }
  const items = dataTransfer.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  }
  return null;
}

// Hidden file input (created once, reused) for the toolbar "Insert image" button.
// The caret position is captured before the picker opens (it blurs the textarea and
// resets the selection) and applied to the first image; later images follow it.
let imagePickerInput = null;
function openImagePicker(textarea, atPos) {
  if (!imagePickerInput) {
    imagePickerInput = document.createElement("input");
    imagePickerInput.type = "file";
    imagePickerInput.accept = "image/*";
    imagePickerInput.multiple = true;
    imagePickerInput.style.display = "none";
    document.body.appendChild(imagePickerInput);
    imagePickerInput.addEventListener("change", () => {
      imagePickerActive = false;
      const target = imagePickerInput._targetTextarea;
      const pos = imagePickerInput._targetPos;
      const files = Array.from(imagePickerInput.files || [])
        .filter((file) => file.type && file.type.startsWith("image/"));
      files.forEach((file, i) => {
        // First image lands at the captured caret; the rest follow (the caret has
        // advanced past each inserted placeholder), so use the live caret for them.
        insertImageUpload(target, file, i === 0 ? pos : undefined);
      });
      imagePickerInput.value = "";
    });
  }
  imagePickerInput._targetTextarea = textarea;
  imagePickerInput._targetPos = atPos;
  // Keep edit mode alive across the file-dialog blur; the change handler (or a
  // cancelled dialog's window refocus) clears it again.
  imagePickerActive = true;
  window.addEventListener("focus", () => { imagePickerActive = false; }, { once: true });
  imagePickerInput.click();
}

// Turndown escapes Markdown punctuation in every text node it converts, which
// is fatal inside LaTeX: "x_k" comes out "x\_k" (KaTeX then prints a literal
// underscore) and "\int"/"\frac" come out "\\int"/"\\frac", which KaTeX reads
// as a line break followed by the words "int"/"frac". Pages that ship math as
// plain "$…$" text rather than rendered KaTeX/MathJax — AI transcripts, paper
// readers, raw README views — hit this on every paste.
//
// Escaping cannot be fixed one text node at a time, because a display block
// written as "$$<br>…<br>$$" (or with each line in its own <p>) puts the
// delimiters and the body in SEPARATE text nodes: escaping the body on its own
// cannot see that it is math at all. So the spans are found before Turndown
// runs, across the fragment's whole flattened text, and lifted into placeholder
// elements that convert back to their exact source text.
//
// Marks such a placeholder. Read back by the "raw-math" Turndown rule.
const RAW_MATH_ATTR = "data-recall-raw-math";

// Stands in for an opaque subtree in the flat text: a character no pasted
// document contains, so it can never be mistaken for part of a formula.
const MATH_OPAQUE_MARK = "\u0000";

// Subtrees the math scan must not look inside: their text is either code (where
// "$" is not a delimiter) or math that already has its own Turndown rule.
const MATH_OPAQUE_SELECTOR =
  "code, pre, script, style, math, .katex, .MathJax, .MathJax_Preview, .MathJax_Display, mjx-container";

// Elements Turndown renders as their own block — the boundary between two of
// them is a line break in the markdown, so it has to be one in the flat text.
const MATH_BLOCK_LEVEL = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

// Flattens `root`'s text the way Turndown will end up reading it — <br> and
// block edges become newlines, opaque subtrees become a single character that
// can never open a delimiter — while recording which node backs each offset,
// so a span found in the flat string can be cut back out of the DOM.
function flattenTextForMath(root) {
  const segments = [];
  let flat = "";

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const start = flat.length;
        flat += child.nodeValue;
        segments.push({ kind: "text", node: child, start, end: flat.length });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (child.nodeName === "BR") {
        const start = flat.length;
        flat += "\n";
        segments.push({ kind: "break", node: child, start, end: flat.length });
        continue;
      }
      if (child.matches && child.matches(MATH_OPAQUE_SELECTOR)) {
        flat += MATH_OPAQUE_MARK;
        continue;
      }

      const isBlock = MATH_BLOCK_LEVEL.test(child.nodeName);
      if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
      walk(child);
      if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
    }
  };

  walk(root);
  return { flat, segments };
}

// Replaces every LaTeX span under `root` with a single placeholder element
// carrying its exact source text. See the note in htmlToMarkdown for why this
// has to happen before Turndown rather than inside its escape step.
function protectMathInDom(root) {
  const { flat, segments } = flattenTextForMath(root);

  const ranges = findMathRanges(flat).filter(([start, end]) => {
    const tex = flat.slice(start, end);
    // An opaque subtree fell inside the span, so the text is not what the
    // markdown will say — leave it to the rules that own those nodes.
    if (tex.includes(MATH_OPAQUE_MARK)) return false;
    // Inline "$…$" is never multi-line. Without this, two dollar AMOUNTS in
    // different paragraphs ("costs $5" … "or $7 each") would swallow every
    // line between them.
    return !(tex.startsWith("$") && !tex.startsWith("$$") && tex.includes("\n"));
  });

  // Back to front: cutting a later span can't shift the offsets of an earlier one.
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const [start, end] = ranges[i];
    const covered = segments.filter((segment) => segment.start < end && segment.end > start);
    if (!covered.length) continue;

    const tex = flat.slice(start, end);
    const placeholder = document.createElement("span");
    placeholder.setAttribute(RAW_MATH_ATTR, tex);
    // Also the placeholder's text, for two reasons: Turndown deletes any node
    // whose textContent is blank BEFORE consulting the rules, so an empty span
    // would vanish; and if the rule ever stops matching, the fallback is the
    // formula rather than a hole where it used to be.
    placeholder.textContent = tex;

    covered.forEach((segment, index) => {
      if (segment.kind === "break") {
        if (index === 0) segment.node.parentNode.insertBefore(placeholder, segment.node);
        segment.node.remove();
        return;
      }
      const node = segment.node;
      const value = node.nodeValue;
      const from = Math.max(start, segment.start) - segment.start;
      const to = Math.min(end, segment.end) - segment.start;
      if (index === 0) {
        const parent = node.parentNode;
        const next = node.nextSibling;
        node.nodeValue = value.slice(0, from);
        parent.insertBefore(placeholder, next);
        const suffix = value.slice(to);
        if (suffix) parent.insertBefore(document.createTextNode(suffix), next);
        return;
      }
      node.nodeValue = value.slice(0, from) + value.slice(to);
    });
  }

  return root;
}

// Turndown escapes every literal "[" and "]" in prose so a bracket can never
// be re-read as link syntax. That is one bracket too many for us: "\[…\]" is
// also KaTeX's display-math delimiter, so pasted prose like "[citation needed]"
// or "[Figure 1]" came out escaped and then RENDERED AS MATH.
//
// Only one shape actually needs the escape — a bracket pair immediately
// followed by "(", which is what would turn back into a link the source never
// had. Everything else is relaxed to a bare bracket: it renders as itself,
// keeps the raw markdown readable, and carries no "\[" for protectMath to trip
// over. The one shape that stays escaped is handled on the other side —
// protectMath declines "\[…\](", see its comment. (Reference syntax,
// "[foo][ref]", needs a "[ref]:" definition that a pasted fragment never
// carries, so it is left bare like any other prose bracket.)
//
// Relaxing is deliberately unconditional rather than limited to balanced pairs:
// protectMathInDom cuts formulas out of their text node, so "[see $x$]" reaches
// this function as two separate calls with one bracket each. Leaving those
// escaped would hand protectMath a "\[…\]" straddling the formula and turn the
// whole phrase into math — the exact bug this is here to kill. The cost is that
// link text containing an unbalanced "]" is no longer protected, which Turndown
// only ever guarded heuristically anyway.
function relaxEscapedBrackets(text) {
  const marks = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") continue;
    const next = text[index + 1];
    if (next === "[" || next === "]") marks.push({ index, kind: next });
    // Whatever followed the backslash was consumed by it, so it can never be
    // an escape itself — this is what keeps "\\\[" (a literal backslash before
    // an escaped bracket) from being misread.
    index += 1;
  }
  if (!marks.length) return text;

  const keep = new Set();
  const open = [];
  marks.forEach((mark) => {
    if (mark.kind === "[") {
      open.push(mark);
      return;
    }
    const start = open.pop();
    if (!start) return;
    if (text[mark.index + 2] === "(") {
      keep.add(start.index);
      keep.add(mark.index);
    }
  });

  const drop = new Set(marks.map((mark) => mark.index).filter((index) => !keep.has(index)));
  if (!drop.size) return text;

  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!drop.has(index)) output += text[index];
  }
  return output;
}

// Shared HTML→Markdown converter (paste handler + notes selection capture).
// Returns "" when Turndown is unavailable or conversion fails.
// A configured TurndownService per option combination, built once.
//
// The whole setup below — the GFM plugin plus ~15 custom rules — used to be
// rebuilt on EVERY call, and htmlToMarkdown is called from
// positionNotesSelectionButton, i.e. every 160ms while a selection is being
// dragged. The rules are pure functions of the two option flags, so there are
// only a handful of distinct services and they can simply be kept.
const turndownServices = new Map();

function turndownServiceFor(options) {
  const key = `${options.preserveInlineStyles ? 1 : 0}:${options.epubMode ? 1 : 0}`;
  let service = turndownServices.get(key);
  if (!service) {
    service = buildTurndownService(options);
    turndownServices.set(key, service);
  }
  return service;
}

export function htmlToMarkdown(html, options = {}) {
  // Synchronous by contract — its callers run inside paste and selection
  // handlers that cannot await. turndown loads on demand (ensureTurndown) and
  // is warmed at idle right after boot, so in practice it is always here by
  // the time a human has selected or pasted anything. In the window where it
  // isn't, this returns "" exactly as it did before and every caller already
  // falls back to plain text; kick off the load so the next attempt works.
  if (typeof TurndownService === "undefined") {
    ensureTurndown();
    return "";
  }
  const turndownService = turndownServiceFor(options);
  return turndownWithService(turndownService, html, options);
}

function buildTurndownService(options = {}) {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-"
  });

  // Load GFM plugin for tables, strikethrough, etc. if available
  if (typeof turndownPluginGfm !== "undefined" && turndownPluginGfm.gfm) {
    turndownService.use(turndownPluginGfm.gfm);
  }

  const escapeMarkdown = turndownService.escape.bind(turndownService);
  turndownService.escape = (string) => relaxEscapedBrackets(escapeMarkdown(string));

  // Emits the LaTeX protectMathInDom lifted out of the DOM, exactly as the
  // source wrote it. Display math keeps its own blank lines so it survives as a
  // block (protectMath's normalizeDisplayMathIndentation handles the 4-space
  // indent Turndown adds when the block sits inside a list item).
  turndownService.addRule("raw-math", {
    filter: (node) => node.nodeName === "SPAN" && node.hasAttribute && node.hasAttribute(RAW_MATH_ATTR),
    replacement: (content, node) => {
      const tex = node.getAttribute(RAW_MATH_ATTR);
      const isDisplay = tex.startsWith("$$") || tex.startsWith("\\[");
      return isDisplay ? `\n\n${tex}\n\n` : tex;
    }
  });

  // <mark> carries its colour as data-color (see MARK_HIGHLIGHT_COLORS) — the
  // generic keep-tag loop below would drop it, so a copied highlight would
  // always turn yellow (or lose the highlight entirely) on the far side
  // regardless of what it actually was. Unlike the preserveInlineStyles-gated
  // rules below, this one is unconditional: a highlight is this app's own
  // semantic markup, not web/Office style noise, so it must survive being
  // copied and pasted anywhere in the app (including the general clipboard-
  // paste path), not just the notes-selection path.
  turndownService.addRule("keep-mark", {
    filter: (node) => node.nodeName === "MARK",
    replacement: (content, node) => {
      const color = node.getAttribute("data-color");
      return `${markOpenTag(color)}${content}${MARK_CLOSE_TAG}`;
    }
  });

  // Notes carry inline styling as raw HTML — colored/font-family text
  // (`<span style="…">` from the toolbar's color/font pickers), underline
  // (`<u>`) and keyboard keys (`<kbd>`). Turndown drops these by default,
  // keeping only the text, so a card made from a styled notes selection lost
  // its color/font/underline. When preserveInlineStyles is set (the notes-
  // selection path), re-emit them so the styling survives into the card
  // exactly as it looked in the notes. This is intentionally NOT enabled for
  // the general clipboard-paste path, where preserving every web/Office
  // `<span style>` would just litter pasted markdown.
  if (options.preserveInlineStyles) {
    turndownService.addRule("styled-span", {
      filter: (node) =>
        node.nodeName === "SPAN" &&
        node.getAttribute("style") &&
        /(?:^|;)\s*(?:color|font-family|background-color|background)\s*:/i.test(node.getAttribute("style")),
      replacement: (content, node) => `<span style="${node.getAttribute("style")}">${content}</span>`
    });
    [
      ["u", "U"],
      ["kbd", "KBD"]
    ].forEach(([tag, nodeName]) => {
      turndownService.addRule(`keep-${tag}`, {
        filter: (node) => node.nodeName === nodeName,
        replacement: (content) => `<${tag}>${content}</${tag}>`
      });
    });

    // A rendered mermaid/nomnoml diagram is an <svg>, which carries no usable
    // text for Turndown's generic element handling to fall back on — a
    // selection spanning one used to come out empty or as jumbled label
    // fragments. preprocessSpecialBlocks stashes the original fence source,
    // URL-encoded, in data-diagram on this exact node (and never clears it —
    // renderDiagramNodes re-reads it on every re-render), so recover it here
    // instead of serializing the SVG, the same way notesSelectionCodeFence
    // recovers a code block's source ahead of the generic path.
    turndownService.addRule("keep-diagram-source", {
      filter: (node) =>
        node.nodeName === "DIV" &&
        (node.classList.contains("mermaid") || node.classList.contains("nomnoml-diagram")) &&
        Boolean(node.dataset.diagram),
      replacement: (content, node) => {
        const lang = node.classList.contains("mermaid") ? "mermaid" : "nomnoml";
        let source = "";
        try {
          source = decodeURIComponent(node.dataset.diagram);
        } catch (err) {
          source = "";
        }
        return source ? `\n\n\`\`\`${lang}\n${source}\n\`\`\`\n\n` : "";
      }
    });
  }

  // App clozes render as <span class="cloze">…</span>. Turn them back into
  // {{…}} so a card (or note) built from a selection that includes a cloze
  // keeps the fill-in-the-blank instead of flattening it to plain text. The
  // inner content is converted first, so a cloze wrapping bold/math/an image
  // round-trips as {{**ATP**}}, {{$x$}}, {{![](url)}} etc. Added unconditionally
  // (not gated on preserveInlineStyles): .cloze is our own class, so pasted web
  // HTML never carries it, and any Recall content copied as HTML should keep it.
  turndownService.addRule("cloze", {
    filter: (node) =>
      node.nodeName === "SPAN" && node.classList && node.classList.contains("cloze"),
    replacement: (content) => {
      const inner = content.trim();
      return inner ? `{{${inner}}}` : "";
    }
  });

  // Rendered math is a tree of KaTeX glyph spans — nothing Turndown's generic
  // handling can make sense of, exactly like the mermaid SVG above. And exactly
  // like mermaid, the original source is already stashed on the node:
  // preprocessSpecialBlocks writes the URL-encoded TeX to data-tex on this host
  // and katex.render only ever replaces its CHILDREN, so the attribute survives
  // every re-render. Read it instead of serializing the glyphs.
  //
  // Registered unconditionally (like the cloze rule above, unlike the diagram
  // one): .math-inline/.math-display are our own markup, so pasted web HTML
  // never carries them, and Recall content copied as HTML should keep its math.
  turndownService.addRule("math-source", {
    filter: (node) =>
      node.nodeType === 1 && node.dataset && node.dataset.tex &&
      node.classList && (node.classList.contains("math-inline") || node.classList.contains("math-display")),
    replacement: (content, node) => {
      let tex = "";
      try {
        tex = decodeURIComponent(node.dataset.tex);
      } catch (err) {
        tex = "";
      }
      if (!tex.trim()) return content;
      return node.classList.contains("math-display")
        ? `\n\n$$\n${tex.trim()}\n$$\n\n`
        : `$${tex.trim()}$`;
    }
  });

  // Fallback for math with no data-tex host: the renderMathInElement safety net
  // in enhanceRenderedMarkdown renders bare \[…\] / \(…\) delimiters straight
  // out of the DOM, and pasted web HTML arrives pre-rendered by somebody else's
  // KaTeX. Both leave only KaTeX's own <annotation> to recover the TeX from.
  turndownService.addRule("katex", {
    filter: function (node) {
      return node.nodeName === "SPAN" && node.classList.contains("katex");
    },
    replacement: function (content, node) {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        const tex = annotation.textContent.trim();
        // .katex-display is the PARENT of span.katex, neither the node itself
        // nor a descendant — so the old check was never true and display math
        // always came back as inline $…$. That mattered: findInlineDollarClose
        // caps inline math at INLINE_MATH_MAX_SPAN and stops at a blank line,
        // so a long \begin{aligned} block landed on the card as literal
        // unrendered "$\begin{aligned}…$" text. (recall-clipper's picker.js
        // splits this into katexDisplay/katexInline rules for the same reason.)
        const isDisplay = Boolean(node.closest?.(".katex-display"));
        return isDisplay ? "\n\n$$\n" + tex + "\n$$\n\n" : "$" + tex + "$";
      }
      // No annotation — KaTeX built with output:"html" emits none, and a clone
      // can lose it. `content` here is the serialized glyph soup, so try the
      // stashed source one more time before falling back to it.
      const host = node.closest?.("[data-tex]");
      if (host) {
        try {
          const tex = decodeURIComponent(host.dataset.tex).trim();
          if (tex) {
            return host.classList.contains("math-display")
              ? `\n\n$$\n${tex}\n$$\n\n`
              : `$${tex}$`;
          }
        } catch (err) {
          /* fall through to content */
        }
      }
      return content;
    }
  });

  if (options.epubMode) {
    // EPUB citation/footnote markers point at real in-book footnotes or
    // endnotes (often on the same page, or their own spine chapter) — unlike
    // a web paste, the target isn't dead, so keep the marker instead of
    // stripping it. Rendered via textContent (not the link's markdown) so a
    // nested markdown link inside a raw <sup> HTML tag never has to survive
    // the app's Markdown renderer, which isn't guaranteed to re-parse
    // markdown syntax nested inside inline HTML.
    turndownService.addRule("epub-sup", {
      filter: "sup",
      replacement: (content, node) => `<sup>${node.textContent.trim()}</sup>`
    });
    turndownService.addRule("epub-sub", {
      filter: "sub",
      replacement: (content, node) => `<sub>${node.textContent.trim()}</sub>`
    });
  } else {
    // Citation/footnote markers (Wikipedia's "[1]", "[a]" etc.) are a <sup> that
    // wraps a single link to an in-page anchor (e.g. #cite_note-6, or — when
    // copied from a live page rather than raw HTML — the browser resolves that
    // to an absolute URL like ".../Albert_Einstein#cite_note-6"). The anchor
    // target never survives the paste, so keeping them just litters notes with
    // dead, bracket-clad links scattered through the text — drop the marker and
    // keep the surrounding prose clean.
    turndownService.addRule("footnote-reference", {
      filter: function (node) {
        if (node.nodeName !== "SUP") return false;
        const links = node.querySelectorAll("a");
        if (links.length !== 1) return false;
        const href = links[0].getAttribute("href") || "";
        const hashIndex = href.indexOf("#");
        if (hashIndex === -1) return false;
        if (href.startsWith("#")) return true;
        const fragment = href.slice(hashIndex + 1);
        return /^(cite_note|cite_ref|fn|footnote|note)[-_]/i.test(fragment);
      },
      replacement: function () {
        return "";
      }
    });
  }

  // Intercept and ignore MathJax rendering containers, extracting raw text from mjx-copytext
  turndownService.addRule("mathjax-containers", {
    filter: function (node) {
      return (
        (node.classList && (
          node.classList.contains("MathJax") ||
          node.classList.contains("MathJax_Preview") ||
          node.classList.contains("MathJax_Display")
        )) ||
        node.nodeName === "MJX-CONTAINER"
      );
    },
    replacement: function (content, node) {
      if (node.nodeName === "MJX-CONTAINER") {
        const copyTextEl = node.querySelector("mjx-copytext");
        if (copyTextEl) return copyTextEl.textContent.trim();
      }
      return "";
    }
  });

  // Extract LaTeX from MathJax 2 script tags
  turndownService.addRule("mathjax-script", {
    filter: function (node) {
      return node.nodeName === "SCRIPT" && node.type && node.type.startsWith("math/tex");
    },
    replacement: function (content, node) {
      const tex = node.textContent.trim();
      const isDisplay = node.type.includes("mode=display");
      return isDisplay ? "\n$$\n" + tex + "\n$$\n" : "$" + tex + "$";
    }
  });

  // Page chrome that is never content: scripts, styles, widgets, form fields,
  // icon SVGs and buttons. Turndown's own tables keep SCRIPT around
  // ("meaningful when blank"), so its text — "var x = 1;", ".a{color:red}",
  // "Copy code" — used to leak into pasted notes as if it were prose. The
  // selection-capture path already removes these from the fragment
  // (cleanedSelectionFragment), so this just makes paste agree with it.
  turndownService.addRule("page-chrome", {
    filter: (node) =>
      node.nodeType === 1 &&
      /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|CANVAS|SVG|SELECT|BUTTON|INPUT|TEXTAREA)$/.test(node.nodeName),
    replacement: () => ""
  });

  // MathML with no usable glyph fallback: Wikipedia and pandoc put the TeX in
  // an <annotation> or in alttext, and Turndown would otherwise serialize the
  // presentation glyphs ("x=-b2a") — math destroyed on the way in. Recover the
  // source, the same way the katex rule above recovers it for KaTeX markup.
  turndownService.addRule("mathml-tex", {
    filter: (node) => node.nodeType === 1 && node.nodeName.toLowerCase() === "math",
    replacement: (content, node) => {
      const annotation =
        node.querySelector('annotation[encoding="application/x-tex"]') || node.querySelector("annotation");
      const tex = (annotation?.textContent || node.getAttribute("alttext") || "").trim();
      if (!tex) return content;
      return node.getAttribute("display") === "block"
        ? `\n\n$$\n${tex}\n$$\n\n`
        : `$${tex}$`;
    }
  });

  // AI chats (Claude/ChatGPT/Gemini/Copilot) wrap the <code> of a fenced block
  // in extra divs, or put their header bar INSIDE the <pre>. Turndown's
  // built-in fencedCodeBlock only fires when the <code> is the <pre>'s FIRST
  // child, so those blocks used to collapse into a single inline-code line
  // with the newlines flattened out. Same output shape as the built-in rule,
  // just found deeper.
  turndownService.addRule("fenced-code-nested", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      !(node.firstElementChild && node.firstElementChild.nodeName === "CODE") &&
      Boolean(node.querySelector("code")),
    replacement: (content, node) => {
      const code = node.querySelector("code");
      const language = ((code.getAttribute("class") || "").match(/language-([\w+-]+)/) || [])[1] || "";
      const text = code.textContent.replace(/\n$/, "");
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
  });

  // Turndown 7.1.2's built-in listItem rule always indents a list item's
  // second+ line (a loose <li> with more than one <p>, e.g. an endnote's
  // citation followed by a "go to reference" link) by a hardcoded 4 spaces,
  // regardless of how wide the marker actually is. That only lines up for a
  // single-digit ordered marker ("1.  " is 4 chars); a two-digit one ("32.  "
  // is 5 chars) leaves the continuation one column short of the list's
  // content column. marked/CommonMark then stops treating it as part of the
  // list item — a bare 4-space-indented line at that point IS the syntax for
  // an indented code block, so the link renders as inert code instead of a
  // clickable link. Re-deriving the indent from the actual prefix width (the
  // same computation turndown itself does) fixes this for every marker size.
  turndownService.addRule("list-item-indent-fix", {
    filter: "li",
    replacement: function (content, node, options) {
      content = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n");
      let prefix = options.bulletListMarker + "   ";
      const parent = node.parentNode;
      if (parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + ".  ";
      }
      content = content.replace(/\n/gm, "\n" + " ".repeat(prefix.length));
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
    }
  });

  return turndownService;
}

// Strips page chrome out of a parsed clipboard fragment before Turndown sees
// it. Copied web/AI-chat HTML carries a lot of markup that is not content:
// visually-hidden duplicate glyphs (aria-hidden), and code-block header bars
// ("python  ⧉ Copy") sitting next to the <pre>. Turndown's default handling
// keeps their TEXT as if it were prose, so a paste used to come out with
// "pythonCopy" lines baked in.
function cleanClipboardDom(root) {
  // aria-hidden nodes duplicate what the visible nodes already say (KaTeX's
  // glyph half, screen-reader spans) or are pure decoration (icon fonts).
  root.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());

  // A code block's header bar is the <pre>'s immediate sibling and holds the
  // language label plus a copy button. Once the button itself is dropped (the
  // page-chrome rule below) only the stray label word would be left — remove
  // the whole bar instead. The button is the evidence: a plain short div of
  // prose in front of a <pre> is content and stays.
  root.querySelectorAll("pre").forEach((pre) => {
    const sibling = pre.previousElementSibling;
    if (!sibling || /^(P|UL|OL|DL|H[1-6]|BLOCKQUOTE|TABLE)$/.test(sibling.nodeName)) return;
    if (sibling.querySelector("a, img, pre, code")) return;
    if (!sibling.querySelector("button, [role='button'], [class*='copy' i]")) return;
    if (sibling.textContent.trim().length > 30) return;
    sibling.remove();
  });

  return root;
}

function turndownWithService(turndownService, html, options = {}) {
  try {
    // Parsed here rather than handed to Turndown as a string, because the math
    // spans have to be lifted out of the DOM before conversion — see
    // protectMathInDom.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const markdown = turndownService.turndown(protectMathInDom(cleanClipboardDom(doc.body)));
    // Belt and braces. protectMathInDom works from the DOM, so it depends on
    // recognising how a given site lays its formulas out, and sites keep
    // inventing new ways — math split across elements the flattener treats as
    // opaque, delimiters buried in a widget, and so on. This pass works on the
    // finished markdown instead, where the damage has an unmistakable
    // signature ("\\begin", "\\dots", "x\_v"), so it heals what got through no
    // matter what the source markup looked like. Same function that repairs
    // notes already in storage, so paste and repair can never disagree.
    return repairEscapedMathMarkdown(markdown);
  } catch (err) {
    console.error("Turndown conversion failed", err);
    return "";
  }
}

// Convert rich text/HTML to Markdown on paste in all textareas
document.addEventListener("paste", (event) => {
  const target = event.target;
  if (target.tagName !== "TEXTAREA") return;

  const clipboardData = event.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  // Image on the clipboard (screenshot, copied image) → upload to Supabase Storage and insert markdown.
  const imageFile = firstImageFile(clipboardData);
  if (imageFile) {
    event.preventDefault();
    // Read the caret and the clipboard's GIF hint synchronously: the event's
    // clipboardData is unreadable once the handler returns, and resolving a GIF
    // is async, so both have to be captured before awaiting anything.
    const atPos = target.selectionStart;
    const gifUrl = imageFile.type === "image/gif" ? null : gifSourceUrlFromTransfer(clipboardData);
    insertTransferImage(target, imageFile, gifUrl, atPos);
    return;
  }

  // See htmlToMarkdown: nothing here can await (clipboardData dies with the
  // handler), so an unloaded converter means the browser's own plain-text
  // paste happens, which is what used to happen when the CDN failed anyway.
  if (typeof TurndownService === "undefined") {
    ensureTurndown();
    return;
  }

  const types = clipboardData.types || [];
  if (!types.includes("text/html")) return;

  const html = clipboardData.getData("text/html");
  if (!html) return;

  const plainText = clipboardData.getData("text/plain") || "";

  let markdown = htmlToMarkdown(html);

  // Fall back to plain text when the conversion comes back empty (a fragment
  // that was all page chrome, or a converter that threw). Only then, when
  // there is genuinely something to insert, suppress the native paste — the
  // old order preventDefault-ed first, so a failed conversion swallowed the
  // clipboard entirely and the paste simply never happened.
  if (!markdown.trim()) markdown = plainText;
  if (!markdown) return;

  // Prevent default paste behavior
  event.preventDefault();

  target.focus();
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const val = target.value;
  target.value = val.substring(0, start) + markdown + val.substring(end);
  target.selectionStart = target.selectionEnd = start + markdown.length;
  target.dispatchEvent(new Event("input", { bubbles: true }));
});

// Drag & drop an image file onto a card editor textarea → upload to Supabase Storage and insert markdown.
// dragover must preventDefault on textareas so the drop event fires.
document.addEventListener("dragover", (event) => {
  if (event.target.tagName === "TEXTAREA" && dragContainsImage(event.dataTransfer)) {
    event.preventDefault();
  }
});

document.addEventListener("drop", (event) => {
  if (event.target.tagName !== "TEXTAREA") return;
  // Only intercept file drops. Dragging text/URLs into the textarea keeps its
  // normal behavior (they get inserted as text).
  if (!dragContainsImage(event.dataTransfer)) return;
  // Prevent the browser from navigating away to open the dropped file.
  event.preventDefault();
  const imageFile = firstImageFile(event.dataTransfer);
  if (imageFile) {
    // Same GIF-flattening problem as paste: dragging an animated GIF out of a
    // page hands over a still, with the original's URL alongside it.
    const gifUrl = imageFile.type === "image/gif" ? null : gifSourceUrlFromTransfer(event.dataTransfer);
    insertTransferImage(event.target, imageFile, gifUrl, event.target.selectionStart);
  } else showToast("Only image files can be dropped here", "info");
});

// Dynamic HTML template for the inline edit toolbar.
// Pass { quickNote: true } to append the "save selection to quick_notes" button.
// The + / quick-note pair mirrors the rendered-view render-toolbar's capture
// group: this toolbar REPLACES that one while raw-editing, so anything only
// present there would silently disappear the moment you tapped ✎.
export function createToolbarHtml(options = {}) {
  const quickNoteBtn = options.quickNote
    ? `
    <span class="edit-toolbar-divider" aria-hidden="true"></span>
    <button type="button" data-action="make-card" class="toolbar-make-card" title="Make a flashcard from the selection">+</button>
    <button type="button" data-action="quick-note" class="toolbar-quick-note" title="Save selection to the quick_notes deck">📌</button>`
    : "";
  // The notes header owns cloze/capture and stays visible while raw-editing, so
  // repeating them here would show each action twice in the same header.
  const clozeBtn = options.cloze === false
    ? ""
    : `
    <button type="button" data-action="cloze" class="make-cloze-btn" title="Cloze — hide selection as a fill-in-the-blank (tap the card to reveal)">${CLOZE_MAKE_ICON}</button>`;
  return `
    <button type="button" data-action="bold" title="Bold"><b>B</b></button>
    <button type="button" data-action="italic" title="Italic"><i>I</i></button>
    <button type="button" data-action="underline" title="Underline"><u>U</u></button>
    <button type="button" data-action="strikethrough" title="Strikethrough"><span style="text-decoration: line-through;">S</span></button>
    <button type="button" data-action="code" title="Code Block"><code>&lt;/&gt;</code></button>${clozeBtn}

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Font Family">Aa</button>
      <div class="toolbar-dropdown-content font-menu">
        <button type="button" data-font="sans-serif" style="font-family: sans-serif;">Sans-Serif</button>
        <button type="button" data-font="serif" style="font-family: serif;">Serif</button>
        <button type="button" data-font="monospace" style="font-family: monospace;">Monospace</button>
        <button type="button" data-font="cursive" style="font-family: cursive;">Cursive</button>
        <button type="button" data-font="system-ui" style="font-family: system-ui;">System UI</button>
        <button type="button" data-font="georgia" style="font-family: georgia, serif;">Georgia</button>
        <button type="button" data-font="Garamond" style="font-family: Garamond, serif;">Garamond</button>
        <button type="button" data-font="Impact" style="font-family: Impact, sans-serif;">Impact</button>
        <button type="button" data-font="Trebuchet MS" style="font-family: 'Trebuchet MS', sans-serif;">Trebuchet</button>
        <button type="button" data-font="Arial" style="font-family: Arial, sans-serif;">Arial</button>
        <button type="button" data-font="Times New Roman" style="font-family: 'Times New Roman', serif;">Times New Roman</button>
        <button type="button" data-font="Verdana" style="font-family: Verdana, sans-serif;">Verdana</button>
        <button type="button" data-font="Tahoma" style="font-family: Tahoma, sans-serif;">Tahoma</button>
        <button type="button" data-font="Courier New" style="font-family: 'Courier New', monospace;">Courier New</button>
        <button type="button" data-font="Consolas" style="font-family: Consolas, monospace;">Consolas</button>
        <button type="button" data-font="Comic Sans MS" style="font-family: 'Comic Sans MS', cursive;">Comic Sans</button>
      </div>
    </div>

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Text Color"><span class="render-glyph">A</span><span class="render-underbar"></span></button>
      <div class="toolbar-dropdown-content color-menu">
        <button type="button" data-color="#ef4444" style="--btn-bg: #ef4444;" title="Red"></button>
        <button type="button" data-color="#f97316" style="--btn-bg: #f97316;" title="Orange"></button>
        <button type="button" data-color="#f59e0b" style="--btn-bg: #f59e0b;" title="Yellow"></button>
        <button type="button" data-color="#10b981" style="--btn-bg: #10b981;" title="Green"></button>
        <button type="button" data-color="#14b8a6" style="--btn-bg: #14b8a6;" title="Teal"></button>
        <button type="button" data-color="#3b82f6" style="--btn-bg: #3b82f6;" title="Blue"></button>
        <button type="button" data-color="#6366f1" style="--btn-bg: #6366f1;" title="Indigo"></button>
        <button type="button" data-color="#8b5cf6" style="--btn-bg: #8b5cf6;" title="Purple"></button>
        <button type="button" data-color="#ec4899" style="--btn-bg: #ec4899;" title="Pink"></button>
        <button type="button" data-color="var(--accent-strong)" style="--btn-bg: var(--accent-strong);" title="Accent"></button>
        <button type="button" data-color="#ffffff" style="--btn-bg: #ffffff;" title="White"></button>
        <button type="button" data-color="#9ca3af" style="--btn-bg: #9ca3af;" title="Gray"></button>
        <button type="button" data-color="clear" class="color-clear" title="Clear Color">Clear Color</button>
      </div>
    </div>

    <div class="toolbar-dropdown">
      <button type="button" class="toolbar-dropdown-toggle" title="Highlight">${RENDER_HIGHLIGHT_GLYPH}</button>
      <div class="toolbar-dropdown-content highlight-menu">
        ${markHighlightSwatchButtonsHtml()}
        <button type="button" data-highlight="clear" class="highlight-clear" title="Clear Highlight">Clear Highlight</button>
      </div>
    </div>

    <button type="button" data-action="bullet" title="Toggle Bullet List">-</button>
    <button type="button" data-action="insert-image" title="Insert image (upload to Supabase Storage)">🖼️</button>
    <button type="button" data-action="clear-all" title="Clear Formatting">Tx</button>${quickNoteBtn}
  `;
}

// Populate toolbars for static question & answer fields on load
function initToolbars() {
  const qToolbar = el.questionEditToolbar;
  if (qToolbar) qToolbar.innerHTML = createToolbarHtml({ quickNote: true });

  const aToolbar = el.answerEditToolbar;
  if (aToolbar) aToolbar.innerHTML = createToolbarHtml({ quickNote: true });

  // Notes: no capture group and no cloze — the notes header carries all three
  // and, unlike this toolbar, doesn't disappear when you leave raw-edit mode.
  const nToolbar = el.notesEditToolbar;
  if (nToolbar) nToolbar.innerHTML = createToolbarHtml({ quickNote: false, cloze: false });

  if (el.questionEdit) enableSyntaxHighlighting(el.questionEdit);
  if (el.answerEdit) enableSyntaxHighlighting(el.answerEdit);
  if (el.notesEdit) enableSyntaxHighlighting(el.notesEdit);
  // These toolbars carry their own copy of the highlight glyph (RENDER_HIGHLIGHT_GLYPH,
  // inside the Highlight dropdown toggle) — paint it now rather than leaving it
  // unstyled until the reader happens to change the default highlight colour.
  // Safe to call again: refreshRenderSwatches just re-paints every match.
  refreshRenderSwatches();
}

onDomReady(initToolbars);

// Global click delegation for any formatting toolbar button
document.addEventListener("click", (e) => {
  const button = e.target.closest(".edit-toolbar button");
  if (button) {
    handleToolbarClick(e);
  }
});

// Toggle a single cloze (fill-in-the-blank) between hidden and revealed on tap.
document.addEventListener("click", (e) => {
  const cloze = e.target.closest(".cloze");
  if (cloze) cloze.classList.toggle("is-revealed");
});

// --- Global "flip all clozes" button (current card / notes only) ------------
// A plain alternating switch: each press flips EVERY cloze in the view to the
// opposite of the button's current state — press once to reveal them all, press
// again to hide them all. The button's aria-pressed is the single source of
// truth (true = currently showing), so the action is always predictable. The
// button resets to hidden whenever the view re-renders (see resetClozeButton).
// Tapping an individual cloze still overrides just that one afterwards.
function setClozeButtonState(button, revealed) {
  if (!button) return;
  button.setAttribute("aria-pressed", revealed ? "true" : "false");
  const label = button.querySelector(".cloze-toggle-label");
  if (label) label.textContent = revealed ? "Hide clozes" : "Reveal clozes";
  // The glyph itself is drawn in CSS off aria-pressed (an "A" you can reveal,
  // becoming the bare blank you'd go back to) rather than swapped here — block
  // characters render at wildly different weights across platforms, and this
  // button now sits next to two other cloze controls it must stay distinct from.
  button.title = revealed ? "Hide all clozes on this card" : "Reveal all clozes on this card";
}

function toggleClozes(container, button) {
  if (!container || !button) return;
  const reveal = button.getAttribute("aria-pressed") !== "true";
  container.querySelectorAll(".cloze").forEach((c) => c.classList.toggle("is-revealed", reveal));
  setClozeButtonState(button, reveal);
}

// New card / re-rendered notes start with every cloze hidden again.
export function resetClozeButton(button) {
  setClozeButtonState(button, false);
}

el.clozeToggleBtn?.addEventListener("click", () => toggleClozes(el.card, el.clozeToggleBtn));
el.clozeToggleNotesBtn?.addEventListener("click", () => toggleClozes(el.notesStage, el.clozeToggleNotesBtn));

// Keyboard activation for clozes (they carry role="button").
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cloze = e.target.closest?.(".cloze");
  if (!cloze) return;
  e.preventDefault();
  cloze.classList.toggle("is-revealed");
});

// ── Cloze Review panel ──────────────────────────────────────────────────────
// A deck-wide list of every {{cloze}} — across the Study Notes document and each
// card's Question/Answer — showing one sentence of context on either side, with
// tap-to-reveal reusing the normal .cloze span behaviour. Also offers a
// "quick-cloze a whole column" tool for the tables in the notes document.

const CLOZE_SCAN_RE = /\{\{([\s\S]+?)\}\}/g;

// A lone table row / heading / list item isn't valid standalone markdown, so
// normalise it to readable inline text before rendering the context snippet.
function clozeCleanUnit(unit) {
  let s = String(unit).trim();
  if (s.includes("|") && /\|/.test(s.replace(/^\||\|$/g, ""))) {
    s = s
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

// Table delimiter rows (|---|---|) are dropped so a cloze inside a table gets
// the header row as its "before" context instead of a row of dashes.
const CLOZE_TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const CLOZE_UNIT_SPLIT_RE = /(?<=[.!?])\s+|\n+/g;
const CLOZE_MASK_CHAR = "";

// A copy of `source` the SAME LENGTH, with every cloze's hidden text blanked
// out. Equal length is the point: unit boundaries found in here are offsets
// into the original, so units can be described as spans instead of rebuilt as
// strings. Blanking also stops a cloze's own punctuation ("{{Rome. Then
// Ravenna}}") from splitting the sentence it is buried in, which is right on
// its own terms: a cloze is one opaque blank, not a sentence boundary.
function clozeMaskSource(source) {
  const scan = new RegExp(CLOZE_SCAN_RE.source, "g");
  let masked = "";
  let at = 0;
  let m;
  while ((m = scan.exec(source))) {
    const innerLength = m[0].length - 4; // minus the "{{" and "}}"
    masked += source.slice(at, m.index + 2) + CLOZE_MASK_CHAR.repeat(innerLength);
    at = m.index + m[0].length - 2;
  }
  return masked + source.slice(at);
}

// -- Why the unit list is built once per source -----------------------------
// This used to be done per cloze, inside clozeContextParts: rebuild the whole
// document with this one cloze replaced by a marker, split it into lines,
// filter every line, join it back, split THAT into sentence units, then scan
// the units for the marker. Roughly five full copies of the note plus two big
// arrays, once per {{...}} -- O(clozes x note). Opening the cloze panel on a
// long note was not merely slow, it was fatal: measured 161ms at 100KB,
// 2,270ms at 400KB, and at 1MB it exhausted a 4GB heap outright.
//
// The same information, computed once: split the masked source into units and
// remember each one's span. Locating any cloze is then a binary search.
function clozeUnitIndex(source) {
  const masked = clozeMaskSource(source);
  CLOZE_UNIT_SPLIT_RE.lastIndex = 0;
  const bounds = [];
  let from = 0;
  let m;
  while ((m = CLOZE_UNIT_SPLIT_RE.exec(masked))) {
    bounds.push([from, m.index]);
    from = m.index + m[0].length;
  }
  bounds.push([from, masked.length]);

  const units = [];
  for (const [rawStart, rawEnd] of bounds) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(source[start])) start += 1;
    while (end > start && /\s/.test(source[end - 1])) end -= 1;
    if (start >= end) continue;
    const text = source.slice(start, end);
    if (CLOZE_TABLE_DELIMITER_RE.test(text)) continue;
    units.push({ start, end, text });
  }
  return units;
}

// The index of the unit containing `offset`, or -1.
function clozeUnitAt(units, offset) {
  let low = 0;
  let high = units.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (units[mid].end <= offset) low = mid + 1;
    else if (units[mid].start > offset) high = mid - 1;
    else return mid;
  }
  return -1;
}

// Build {prev, cur, next} context around one cloze occurrence. `cur` keeps the
// {{...}} braces so it renders as a live redaction span; neighbours are plain.
function clozeContextParts(units, source, start, end) {
  const index = clozeUnitAt(units, start);
  if (index === -1) {
    // No unit covers this offset (a dropped delimiter row, or pure whitespace)
    // -- show the cloze on its own rather than losing the row entirely.
    return { prev: "", cur: clozeCleanUnit(source.slice(start, end)), next: "" };
  }
  return {
    prev: index > 0 ? clozeCleanUnit(units[index - 1].text) : "",
    cur: clozeCleanUnit(units[index].text),
    next: index < units.length - 1 ? clozeCleanUnit(units[index + 1].text) : "",
  };
}

// Gather clozes from every source in the deck, grouped by where they live.
function collectDeckClozes() {
  const groups = [];
  const pushGroup = (label, source) => {
    if (!source || source.indexOf("{{") === -1) return;
    const items = [];
    // A sentence with several clozes yields the SAME context snippet for each
    // (every blank in that sentence is already shown), so collapse duplicates:
    // list each sentence once instead of once per cloze. Keyed on the unit
    // itself rather than on the assembled text, so a sentence with twenty
    // blanks costs one row's work instead of twenty.
    const seen = new Set();
    const units = clozeUnitIndex(source);
    CLOZE_SCAN_RE.lastIndex = 0;
    let m;
    while ((m = CLOZE_SCAN_RE.exec(source))) {
      const unitIndex = clozeUnitAt(units, m.index);
      const key = unitIndex === -1 ? "@" + m.index : "u" + unitIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(clozeContextParts(units, source, m.index, m.index + m[0].length));
    }
    if (items.length) groups.push({ label, items });
  };
  pushGroup("Study Notes", state.notes || "");
  (state.masterCards || []).forEach((card, i) => {
    pushGroup(`Card ${i + 1} · Question`, card.question || "");
    pushGroup(`Card ${i + 1} · Answer`, card.answer || "");
  });
  return groups;
}

// ── Highlights view ────────────────────────────────────────────────────────
// A highlight is a literal <mark>…</mark> pair sitting in state.notes — same
// authored-in-source approach as {{cloze}}, which is what already makes it
// render correctly (DOMPurify's default allowlist includes <mark>, no
// SANITIZE_CONFIG change needed) and round-trip out of a selection (the
// existing "keep-mark" Turndown rule). There is deliberately no separate
// stored list: collectDeckHighlights, like collectDeckClozes above, is fully
// derived from state.notes on every call, so an edit made in the raw editor
// (typing <mark> by hand, or deleting one) can never drift out of sync with
// what the Highlights tab shows.
// data-color (see MARK_HIGHLIGHT_COLORS) makes the open tag's length variable,
// so the offset below is measured off the actual match rather than a fixed
// "<mark>".length constant — a coloured highlight would otherwise report an
// anchor that starts a few characters into its own text. Colour is captured
// (not just detected) so adjacent matches can be compared when grouping below.
const HIGHLIGHT_SCAN_RE = /<mark(?:\s+data-color="([a-z]+)")?>([\s\S]+?)<\/mark>/g;

// What can legally sit between two adjacent <mark>s that wrapAcrossBlocks
// produced from ONE highlight action: nothing but the block boundary itself —
// a blank line, or a newline plus the next list item's own "- "/"1. " marker.
// Real note content between two marks (including a non-highlighted list item)
// is always more than this, so it never matches and those stay separate rows.
const HIGHLIGHT_GROUP_GAP_RE = /^\n+(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?$/;

// wrapAcrossBlocks always keeps a list item's own marker OUTSIDE the mark
// (see its comment for why one inside breaks marked's list parsing), so a
// mark's captured `inner` text never knows it was ever a bullet — rendering
// `inner` alone would show plain text where the note shows a list. If the
// mark starts exactly where its line's own marker ends (nothing else on the
// line before it), that marker is captured here so the preview can put the
// bullet back. Returns null for a highlight that's a sub-span of a line
// (marker, if any, isn't immediately adjacent) — those render as plain text,
// which is correct: they were never "the whole item" to begin with.
function precedingListMarker(source, start) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  const match = LIST_MARKER_RE.exec(prefix);
  return match && match[0].length === prefix.length ? prefix : null;
}

// A highlight is usually a FRAGMENT of a sentence — a phrase mid-clause, not a
// whole line — and showing only the marked words left the panel full of rows
// that read as gibberish out of context ("eigenvalue problem", "treating a song
// as a list of air pressure readings"). Every part of a row is therefore widened
// to whole sentences: the highlight is shown inside the complete sentence it
// lives in, between the sentence before and the sentence after.
//
// The unit index is the cloze panel's (clozeUnitIndex / clozeUnitAt, which split
// on sentence ends AND newlines and drop table rules): built once per panel
// render rather than per highlight, and searched by bisection. Reusing it keeps
// one definition of "a sentence" for both panels, including the awkward parts —
// a cloze's own punctuation never splits a unit, and a lone |---|---| row is
// never offered as context.
//
// Returns null when no unit covers the highlight (all-whitespace, or a dropped
// table rule), and the caller falls back to the bare marked fragment.
// clozeUnitIndex drops table rules but not code-fence markers, and a lone "```js"
// offered as context opens a block that never closes — swallowing the rest of the
// row into a code block. Neighbours therefore step outward past any unit that
// isn't showable on its own.
const HIGHLIGHT_CONTEXT_FENCE_RE = /^\s*(?:```|~~~)/;

function highlightContextUnit(units, index, step) {
  for (let i = index + step; i >= 0 && i < units.length; i += step) {
    const text = clozeCleanUnit(units[i].text);
    if (text && !HIGHLIGHT_CONTEXT_FENCE_RE.test(text)) return text;
  }
  return "";
}

function highlightSentenceParts(units, source, group) {
  const first = clozeUnitAt(units, group.pieces[0].start);
  if (first === -1) return null;
  // A highlight can run past the end of its own sentence (a drag across two of
  // them, or across a block boundary), so the closing unit is looked up
  // separately and everything between the two is kept.
  const lastFrom = clozeUnitAt(units, Math.max(group.pieces[0].start, group.end - 1));
  const last = lastFrom === -1 ? first : Math.max(first, lastFrom);
  const cur = source.slice(units[first].start, units[last].end);
  // A slice that ends between a <mark> and its </mark> would render as an
  // element the browser closes at the end of the row, highlighting all the
  // context after it. Only reachable if the closing tag's own unit was dropped
  // (a table rule), so the cheap answer is to decline and let the caller fall
  // back to the bare fragment rather than to widen and guess.
  if ((cur.match(/<mark\b/g) || []).length !== (cur.match(/<\/mark>/g) || []).length) return null;
  return {
    // Raw source, not a rebuilt fragment: the <mark> tags keep their colours and
    // each line keeps its own list marker / quote / heading prefix, so a
    // highlighted bullet still renders as a bullet here.
    cur,
    // Neighbours are normalised the way the cloze panel normalises its side
    // context — a lone table row becomes "a · b", a heading loses its hashes —
    // because a fragment of a construct is not valid standalone markdown.
    prev: highlightContextUnit(units, first, -1),
    next: highlightContextUnit(units, last, 1)
  };
}

// One entry per highlight: the complete sentence it sits in (rendered as-is in
// the Highlights tab, not flattened to plain text or cropped — see
// renderHighlightsPanel), the sentences either side of it, and a
// trimNoteAnchor-shaped anchor (offset + exact source span + plain text) so
// "Go to →" can reuse scheduleNoteJump/revealNoteAnchor exactly as the
// note-origin and cloze-jump features already do — no separate jump logic.
//
// `markIndex`/`markCount` are what make the jump EXACT: see revealNoteMark. The
// anchor is still carried for the raw editor and as the fallback.
//
// Highlighting a selection that crosses a paragraph or list-item boundary
// (wrapAcrossBlocks, see makeHighlightFromSelection) leaves several adjacent
// <mark> tags behind — one per block, because a single one can't legally span
// a boundary. Without the grouping pass below, that ONE highlight action
// showed up here as three separate rows. Adjacent same-colour matches
// separated by nothing but boundary syntax (HIGHLIGHT_GROUP_GAP_RE) are
// merged back into one entry, matching what the user actually did — and each
// piece's own list marker (if it had one) is restored so a highlighted list
// still LOOKS like a list here, not three plain-text lines.
function collectDeckHighlights() {
  const source = state.notes || "";
  const raw = [];
  HIGHLIGHT_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = HIGHLIGHT_SCAN_RE.exec(source))) {
    const color = m[1] || MARK_HIGHLIGHT_DEFAULT;
    const inner = m[2];
    const openTagLength = m[0].length - inner.length - MARK_CLOSE_TAG.length;
    const start = m.index;
    raw.push({
      // Ordinal among ALL marks in the source, which is also this mark's
      // position among the rendered <mark> elements (revealNoteMark).
      markIndex: raw.length,
      start,
      end: start + m[0].length,
      offset: start + openTagLength,
      color,
      inner,
      marker: precedingListMarker(source, start)
    });
  }

  const groups = [];
  raw.forEach((entry) => {
    const last = groups[groups.length - 1];
    if (last && last.color === entry.color && HIGHLIGHT_GROUP_GAP_RE.test(source.slice(last.end, entry.start))) {
      last.end = entry.end;
      last.pieces.push(entry);
    } else {
      groups.push({ offset: entry.offset, end: entry.end, color: entry.color, pieces: [entry] });
    }
  });

  // One pass for the whole note, shared by every row below — see
  // highlightSentenceParts, and clozeUnitIndex's own comment for why this is
  // built once rather than per highlight.
  const units = clozeUnitIndex(source);

  const items = [];
  groups.forEach((group) => {
    const parts = highlightSentenceParts(units, source, group);
    // Fallback only: no sentence unit covers this highlight. Marks are reapplied
    // (not just the bare inner text) so a highlight's own colour still shows
    // here, and each piece's list marker is restored so a highlighted list still
    // LOOKS like a list rather than three plain-text lines.
    const markdown = parts ? parts.cur : group.pieces.reduce((acc, piece, i) => {
      const markedPiece = markOpenTag(group.color) + piece.inner + MARK_CLOSE_TAG;
      const rendered = piece.marker ? piece.marker + markedPiece : markedPiece;
      if (i === 0) return rendered;
      return acc + (piece.marker ? "\n" : "\n\n") + rendered;
    }, "");
    // The needle is the FIRST piece's own inner text, not the preview markdown:
    // the preview carries <mark> tags and a restored list marker, neither of
    // which appears in the rendered notes, so an anchor built from it could
    // never be found again (that was the "Go to takes me somewhere else" bug —
    // every match failed and the retry loop's proportional estimate is what the
    // reader saw). The first piece is also the right place to land for a
    // highlight that spans several blocks.
    const text = notesAnchorPlainText(group.pieces[0].inner);
    if (!text) return;
    items.push({
      markdown,
      prevSentence: parts ? parts.prev : "",
      nextSentence: parts ? parts.next : "",
      markIndex: group.pieces[0].markIndex,
      markCount: raw.length,
      anchor: trimNoteAnchor({ offset: group.offset, source: group.pieces[0].inner, text, deckId: state.deckId, deckTitle: state.deckTitle })
    });
  });
  return items;
}

// Redraws the Highlights tab from scratch — cheap enough to just always
// rebuild (same choice collectDeckClozes/renderClozePanel already make)
// rather than diffing, and it only runs when that tab is actually opened.
// Each row renders its markdown fragment exactly like the notes view does —
// bold/links/images/lists intact, nothing flattened to plain text or cropped
// with an ellipsis — via the same synchronous safe-HTML pass renderMarkdown
// itself is built on (markdownToSafeHtml), since a highlight preview is
// always short enough not to need that function's viewport-deferral machinery.
// The neighbouring source lines are rendered the same way, dimmed and clamped by
// CSS (never truncated as a string — cutting markdown mid-syntax renders broken
// output), so a row can be recognised without opening the note.
// The markdown each pending context node is waiting to render, keyed by the node
// so nothing large ends up in a dataset attribute.
const pendingHighlightContext = new WeakMap();
let highlightContextObserver = null;

// A context line, left EMPTY until it is near the viewport.
//
// Each of these is a full marked + DOMPurify pass, and there are two per
// highlight on top of the preview — so a note with a couple of hundred
// highlights paid six hundred parses on the single tap that opens this panel,
// nearly all of them for rows nobody had scrolled to yet.
function highlightContextNode(markdown) {
  const node = document.createElement("div");
  node.className = "highlight-ctx is-side rendered";
  if (!highlightContextObserver && typeof IntersectionObserver !== "undefined") {
    highlightContextObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        renderPendingHighlightContext(entry.target);
      });
    }, { rootMargin: "600px 0px" });
  }
  if (!highlightContextObserver) {
    node.innerHTML = markdownToSafeHtml(markdown);
    return node;
  }
  pendingHighlightContext.set(node, markdown);
  highlightContextObserver.observe(node);
  return node;
}

function renderPendingHighlightContext(node) {
  const markdown = pendingHighlightContext.get(node);
  if (markdown == null) return;
  pendingHighlightContext.delete(node);
  node.innerHTML = markdownToSafeHtml(markdown);
}

export function renderHighlightsPanel() {
  const list = el.highlightsList;
  if (!list) return;
  // Rows from the previous render are about to be discarded; drop their
  // observations rather than leaving the observer holding detached nodes.
  highlightContextObserver?.disconnect();
  list.innerHTML = "";
  const items = collectDeckHighlights();
  if (el.highlightsEmpty) el.highlightsEmpty.hidden = items.length > 0;
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "highlight-row";
    // The three stacked lines share one column so the jump button still sits
    // BESIDE the highlight rather than under the context below it.
    const body = document.createElement("div");
    body.className = "highlight-body";
    const preview = document.createElement("div");
    preview.className = "highlight-preview rendered";
    preview.innerHTML = markdownToSafeHtml(item.markdown);
    if (item.prevSentence) body.appendChild(highlightContextNode(item.prevSentence));
    body.appendChild(preview);
    if (item.nextSentence) body.appendChild(highlightContextNode(item.nextSentence));
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "highlight-jump-btn";
    jumpBtn.title = "Go to this highlight in the notes";
    jumpBtn.setAttribute("aria-label", "Go to this highlight in the notes");
    jumpBtn.textContent = "Go to →";
    jumpBtn.addEventListener("click", () =>
      scheduleNoteJump(item.anchor, undefined, { markIndex: item.markIndex, markCount: item.markCount })
    );
    row.append(body, jumpBtn);
    list.appendChild(row);
  });
}

// Split a markdown table row into trimmed cell strings (drops the outer pipes).
function clozeSplitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

// Find GitHub-style tables in the notes source: a header row, a |---|---| delim
// row, then consecutive pipe rows. Returns header labels + data-row line indices.
function parseNotesTables(source) {
  const lines = String(source).split("\n");
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue;
    const delim = lines[i + 1];
    if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(delim)) continue;
    const headers = clozeSplitTableRow(lines[i]);
    const rowLines = [];
    let j = i + 2;
    while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
      rowLines.push(j);
      j++;
    }
    tables.push({ headers, rowLines });
    i = j - 1;
  }
  return tables;
}

// Wrap every data cell in one column of one notes table as its own {{cloze}}.
function clozeNotesTableColumn(tableIndex, colIndex) {
  const lines = (state.notes || "").split("\n");
  const table = parseNotesTables(state.notes || "")[tableIndex];
  if (!table) return;
  let changed = 0;
  table.rowLines.forEach((lineNo) => {
    const cells = clozeSplitTableRow(lines[lineNo]);
    if (colIndex >= cells.length) return;
    const bare = cells[colIndex].trim();
    if (!bare || /^\{\{[\s\S]*\}\}$/.test(bare)) return; // empty or already clozed
    cells[colIndex] = "{{" + bare + "}}";
    lines[lineNo] = "| " + cells.join(" | ") + " |";
    changed++;
  });
  if (!changed) {
    showToast("Those cells are already clozed", "info");
    return;
  }
  state.notes = lines.join("\n");
  if (el.notesEdit) el.notesEdit.value = state.notes;
  scheduleDeckAutosave();
  renderNotesViewPinned();
  showToast(`Clozed ${changed} cell${changed === 1 ? "" : "s"}`);
  renderClozePanel();
}

function clozeContextNode(markdown, isSide) {
  const node = document.createElement("div");
  node.className = "cloze-ctx" + (isSide ? " is-side" : "");
  node.innerHTML = markdownToSafeHtml(markdown);
  return node;
}

function renderClozePanel() {
  const body = el.clozeReviewBody;
  if (!body) return;
  body.innerHTML = "";
  const groups = collectDeckClozes();
  const tables = parseNotesTables(state.notes || "");
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  if (el.clozeReviewSummary) {
    el.clozeReviewSummary.textContent =
      total === 0 ? "No clozes yet" : `${total} cloze${total === 1 ? "" : "s"} across this deck`;
  }

  if (tables.length) {
    const sec = document.createElement("section");
    sec.className = "cloze-tables";
    const h = document.createElement("h2");
    h.textContent = "Quick-cloze a notes table column";
    sec.appendChild(h);
    tables.forEach((table, ti) => {
      const row = document.createElement("div");
      row.className = "cloze-table-row";
      const name = document.createElement("span");
      name.className = "cloze-table-name";
      name.textContent = table.headers.filter(Boolean).slice(0, 3).join(" · ") || `Table ${ti + 1}`;
      const select = document.createElement("select");
      table.headers.forEach((hd, ci) => {
        const opt = document.createElement("option");
        opt.value = String(ci);
        opt.textContent = hd || `Column ${ci + 1}`;
        select.appendChild(opt);
      });
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cloze-table-cloze-btn";
      btn.textContent = "Cloze column";
      btn.addEventListener("click", () => clozeNotesTableColumn(ti, Number(select.value)));
      row.append(name, select, btn);
      sec.appendChild(row);
    });
    body.appendChild(sec);
  }

  if (total === 0 && !tables.length) {
    const p = document.createElement("p");
    p.className = "cloze-empty";
    p.textContent =
      "No fill-in-the-blank clozes in this deck yet. Select text in your notes or a card and press […] to hide it as a cloze.";
    body.appendChild(p);
    resetClozePanelBulk();
    return;
  }

  groups.forEach((group) => {
    const sec = document.createElement("section");
    sec.className = "cloze-group";
    const h = document.createElement("h2");
    h.textContent = `${group.label} — ${group.items.length}`;
    sec.appendChild(h);
    group.items.forEach((it) => {
      const item = document.createElement("div");
      item.className = "cloze-item";
      if (it.prev) item.appendChild(clozeContextNode(it.prev, true));
      item.appendChild(clozeContextNode(it.cur, false));
      if (it.next) item.appendChild(clozeContextNode(it.next, true));
      sec.appendChild(item);
    });
    body.appendChild(sec);
  });

  resetClozePanelBulk();
}

// The bulk button is a plain toggle (its own aria-pressed is the source of
// truth), separate from the per-view "flip all clozes" header buttons.
function resetClozePanelBulk() {
  if (!el.clozeBulkBtn) return;
  el.clozeBulkBtn.setAttribute("aria-pressed", "false");
  el.clozeBulkBtn.textContent = "[A] Reveal all";
}

function toggleClozePanelAll() {
  if (!el.clozeBulkBtn || !el.clozeReviewBody) return;
  const reveal = el.clozeBulkBtn.getAttribute("aria-pressed") !== "true";
  el.clozeReviewBody.querySelectorAll(".cloze").forEach((c) => c.classList.toggle("is-revealed", reveal));
  el.clozeBulkBtn.setAttribute("aria-pressed", reveal ? "true" : "false");
  el.clozeBulkBtn.textContent = reveal ? "[_] Hide all" : "[A] Reveal all";
}

function openClozePanel() {
  if (!el.clozePanel) return;
  commitNotesEditIfActive();
  lockPageScroll();
  renderClozePanel();
  el.clozePanel.hidden = false;
}

export function closeClozePanel() {
  if (!el.clozePanel || el.clozePanel.hidden) return;
  el.clozePanel.hidden = true;
  unlockPageScroll();
}

el.clozeReviewBtn?.addEventListener("click", openClozePanel);
el.closeClozeBtn?.addEventListener("click", closeClozePanel);
el.clozeBulkBtn?.addEventListener("click", toggleClozePanelAll);
el.clozePanel?.addEventListener("click", (e) => {
  if (e.target === el.clozePanel) closeClozePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el.clozePanel && !el.clozePanel.hidden) closeClozePanel();
});

// Syntax highlighting backdrop creator for textareas.
//
// The textarea's own text is transparent (see .edit-textarea) — what you read in
// raw mode is this mirror underneath it, which is why it can't simply be skipped
// for a big document. What it CAN do is stop rebuilding itself more than once
// per frame: a burst of keystrokes (or a held key) used to re-escape and re-lay
// out the whole document once per event.
const highlightBackdropSync = new WeakMap(); // textarea -> force a resync now

export function refreshHighlightBackdrop(textarea) {
  highlightBackdropSync.get(textarea)?.();
}

// ── Why very large notes edit without the highlight mirror ─────────────────
// The raw editor is a transparent <textarea> laid over a backdrop <div> holding
// a styled copy of the same text — that mirror is the only thing you actually
// see, and it's what tints {{cloze}} braces and fades HTML tags. Its cost is a
// second full text layout of the whole document, and unlike the textarea's own
// (native, cheap) layout it is ordinary DOM text with spans, which measured
// roughly ten times more expensive.
//
// On a large note that is ruinous, and it dominated everything the editor does.
// Measured on an 800KB note, entering raw mode took 1,950ms with the mirror and
// 186ms without it; a single keystroke took 442ms with and 187ms without,
// because every keystroke replaces the mirror's entire innerHTML and re-lays out
// the document. The string work itself is nothing (~1ms) — it is purely the
// layout of a second copy of the text.
//
// So past this threshold the mirror is switched off and the textarea shows its
// own text instead (see .highlight-textarea-wrapper.is-plain in styles.css,
// which un-hides the textarea's colour and moves the visible border onto it).
// What that costs is the cloze/HTML-tag tinting, on exactly the notes least
// likely to use clozes — an imported book chapter — and what it buys is an
// editor that responds to typing. Everything below the threshold is unchanged.
export const HIGHLIGHT_MIRROR_MAX_CHARS = 60000;

export function enableSyntaxHighlighting(textarea) {
  if (!textarea || textarea.dataset.highlighted === "true") return;
  textarea.dataset.highlighted = "true";

  const wrapper = document.createElement("div");
  wrapper.className = "highlight-textarea-wrapper";

  const backdrop = document.createElement("div");
  backdrop.className = "highlight-textarea-backdrop";

  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.appendChild(backdrop);
  wrapper.appendChild(textarea);

  let syncedText = null;
  let syncFrame = 0;
  let plainMode = false;

  function sync() {
    const text = textarea.value;
    if (text === syncedText) return;
    syncedText = text;

    // Checked before any string work: past the threshold the whole point is to
    // never build or lay out a second copy of the text.
    const wantPlain = text.length > HIGHLIGHT_MIRROR_MAX_CHARS;
    if (wantPlain !== plainMode) {
      plainMode = wantPlain;
      wrapper.classList.toggle("is-plain", wantPlain);
      // Dropping the old mirror content matters as much as not building a new
      // one — leaving a stale 800KB subtree in the DOM would keep costing
      // layout and memory for as long as the editor is open.
      if (wantPlain) backdrop.textContent = "";
    }
    if (plainMode) return;

    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Fade out HTML syntax tags
    let highlighted = escaped.replace(/(&lt;\/?[a-zA-Z0-9]+(?:\s+[^&]*)?&gt;)/g, '<span class="syntax-tag">$1</span>');

    // Tint {{cloze}} enclosures so blanks stand out in the raw markdown. Only
    // colour changes are applied here (never font-style/weight/family) — the
    // backdrop must keep identical character metrics to the transparent
    // textarea it sits behind, or the caret would drift out of alignment.
    highlighted = highlighted.replace(
      /(\{\{)([\s\S]*?)(\}\})/g,
      '<span class="syntax-cloze"><span class="syntax-cloze-brace">$1</span>$2<span class="syntax-cloze-brace">$3</span></span>'
    );

    // [[note reference]] — tinted so a link is visible in the raw text too.
    // Colour only, for the same reason as the cloze rule above.
    highlighted = highlighted.replace(
      /\[\[[^[\]\n]*?\]\]/g,
      '<span class="syntax-note-link">$&</span>'
    );

    if (highlighted.endsWith("\n") || highlighted === "") {
      highlighted += " ";
    }

    backdrop.innerHTML = highlighted;
  }

  // One rebuild per frame at most. The mirror only has to be right by the time
  // the frame is painted, so several inputs landing in the same frame (fast
  // typing, autorepeat, a paste followed by a programmatic edit) collapse into a
  // single pass over the text.
  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      sync();
    });
  }

  function syncNow() {
    if (syncFrame) {
      cancelAnimationFrame(syncFrame);
      syncFrame = 0;
    }
    sync();
  }

  // Deliberately synchronous, and deliberately NOT rAF-coalesced: the backdrop
  // is the only thing painting visible text, so deferring this by even one frame
  // would tear the text away from the scroll on a fling. Two property writes on
  // an element whose styles are already clean is not what makes scrolling
  // expensive — measuring the mirror was (see scheduleNotesCaretCheck).
  function syncScroll() {
    // Nothing to keep in step in plain mode, and skipping it keeps scrolling a
    // large note free of a per-event write that would force layout.
    if (plainMode) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }

  textarea.addEventListener("input", scheduleSync);
  textarea.addEventListener("scroll", syncScroll, { passive: true });
  highlightBackdropSync.set(textarea, syncNow);

  // Initialize
  sync();
  syncScroll();
}

// One shared resize handler re-syncs every highlight backdrop still in the DOM.
// (A per-textarea window listener would leak: the All Cards panel recreates its
// editor textareas on every render, and each captured listener would pin the
// detached DOM subtree in memory forever.)
window.addEventListener("resize", () => {
  document.querySelectorAll(".highlight-textarea-wrapper > textarea").forEach((textarea) => {
    const backdrop = textarea.parentElement?.querySelector(".highlight-textarea-backdrop");
    if (!backdrop) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  });
});

// Formatting helpers
// Toggles a marker pair around the current selection. A naive check of just
// the selected substring's own edges breaks two ways: (1) if the user
// double-clicks to reselect only the word inside an already-wrapped run
// (double-click stops at the marker's punctuation), the markers sit just
// OUTSIDE the new selection and get missed, so toggling re-wraps instead of
// un-wrapping (**hello** -> ****hello****); (2) a selection spanning multiple
// independently-wrapped runs (e.g. "**a** **b**") coincidentally starts/ends
// with the wrapper too, so a naive strip chops off the wrong characters and
// produces unbalanced markup. This checks the characters just outside the
// selection first (unambiguous), then falls back to stripping the selection's
// own edges only when doing so is unambiguous (no marker recurs inside),
// otherwise it just wraps — non-destructive nesting instead of corrupting text.
export function toggleWrapPair(val, start, end, open, close = open) {
  const before = val.slice(Math.max(0, start - open.length), start);
  const after = val.slice(end, end + close.length);
  if (before === open && after === close) {
    return { text: val.slice(start, end), rangeStart: start - open.length, rangeEnd: end + close.length };
  }

  const selected = val.slice(start, end);
  if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
    const inner = selected.slice(open.length, selected.length - close.length);
    if (!inner.includes(open) && !inner.includes(close)) {
      return { text: inner, rangeStart: start, rangeEnd: end };
    }
  }

  return { text: open + selected + close, rangeStart: start, rangeEnd: end };
}

export function toggleWrap(val, start, end, wrapper) {
  return toggleWrapPair(val, start, end, wrapper, wrapper);
}

export function toggleUnderline(val, start, end) {
  return toggleWrapPair(val, start, end, "<u>", "</u>");
}

export function toggleStrikethrough(val, start, end) {
  return toggleWrapPair(val, start, end, "~~", "~~");
}

// Inline code can't contain a literal newline in Markdown, so a multi-line
// selection needs a fenced ``` block instead of backticks — everything else
// (single line, or no selection) keeps the lighter-weight ` ` wrap.
export function toggleCode(val, start, end) {
  const selected = val.slice(start, end);
  return selected.includes("\n") ? toggleFence(val, start, end) : toggleWrapPair(val, start, end, "`", "`");
}

// Wrap/unwrap a multi-line selection in a fenced code block, mirroring
// toggleWrapPair's toggle behavior (wrap plain text, or strip an existing
// wrap back to plain text) but for ``` fences.
function toggleFence(val, start, end) {
  const selected = val.slice(start, end);

  // Selection is a complete fenced block ("```lang\n...\n```") -> unwrap.
  const selfFenced = selected.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (selfFenced) {
    return { text: selfFenced[1], rangeStart: start, rangeEnd: end };
  }

  // Selection is just the inner lines, with the fence markers sitting just
  // outside it (what re-selecting the toggled-in text looks like) -> unwrap
  // by growing the replaced range to swallow those markers too.
  const beforeFence = val.slice(0, start).match(/```[^\n]*\n$/);
  const afterFence = val.slice(end).match(/^\n```/);
  if (beforeFence && afterFence) {
    return { text: selected, rangeStart: start - beforeFence[0].length, rangeEnd: end + afterFence[0].length };
  }

  // Otherwise wrap, only adding the surrounding newlines the text doesn't
  // already have so the fence doesn't create a stray blank line.
  const leadNl = start > 0 && val[start - 1] !== "\n" ? "\n" : "";
  const trailNl = end < val.length && val[end] !== "\n" ? "\n" : "";
  return { text: `${leadNl}\`\`\`\n${selected}\n\`\`\`${trailNl}`, rangeStart: start, rangeEnd: end };
}

function toggleKbd(val, start, end) {
  return toggleWrapPair(val, start, end, "<kbd>", "</kbd>");
}

function toggleCloze(val, start, end) {
  return toggleWrapPair(val, start, end, "{{", "}}");
}

// Strips opening/closing tags individually rather than pair-matching them
// with a lazy [\s\S]*? capture — pair-matching mishandles nesting (e.g. two
// nested <span style> wrappers: the lazy match consumes the outer open tag
// through the FIRST </span> it finds, which is the inner one, so the outer
// </span> is left behind unmatched and the inner span survives disguised as
// the only one). Stripping tags individually is correct at any nesting depth
// and needs no pairing at all. Used by the explicit "Clear formatting"
// action — per-property toolbar actions (font/color/highlight) use
// applyInlineStyleProperty/clearInlineStyleProperty instead, which merge
// into existing styling rather than destroying it.
function clearStyling(text) {
  let cleared = text;
  cleared = cleared.replace(/<span style="[^"]*">/gi, "").replace(/<\/span>/gi, "");
  cleared = cleared.replace(/<font [^>]*>/gi, "").replace(/<\/font>/gi, "");
  cleared = cleared.replace(/<mark>/gi, "").replace(/<\/mark>/gi, "");
  cleared = cleared.replace(/<u>/gi, "").replace(/<\/u>/gi, "");
  cleared = cleared.replace(/<del>/gi, "").replace(/<\/del>/gi, "");
  cleared = cleared.replace(/<kbd[^>]*>/gi, "").replace(/<\/kbd>/gi, "");
  return cleared;
}

function parseInlineStyle(styleAttr) {
  const props = {};
  String(styleAttr || "").split(";").forEach((decl) => {
    const idx = decl.indexOf(":");
    if (idx === -1) return;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop && value) props[prop] = value;
  });
  return props;
}

function serializeInlineStyle(props) {
  return Object.entries(props).map(([k, v]) => `${k}: ${v};`).join(" ");
}

// A selection that is ENTIRELY one <span style="..."> wrapping — no partial
// wrap, no sibling spans, no unmatched nesting inside — so a font/color/
// highlight action can merge a property into it instead of stripping
// whatever styling is already there.
function matchWholeStyleSpan(text) {
  const m = /^<span style="([^"]*)">([\s\S]*)<\/span>$/.exec(text);
  if (!m) return null;
  const inner = m[2];
  const opens = (inner.match(/<span\b/gi) || []).length;
  const closes = (inner.match(/<\/span>/gi) || []).length;
  if (opens !== closes) return null;
  return { styleAttr: m[1], inner };
}

// Sets one CSS property on the selection's existing style span (merging with
// whatever else is set — e.g. a prior color survives a later font change)
// instead of clearStyling's old behavior of nuking every other inline style/
// tag first. Falls back to a fresh wrap when the selection isn't already
// entirely one style span (e.g. plain text, or a selection spanning multiple
// runs) — in that case there's nothing to merge into.
export function applyInlineStyleProperty(text, property, value) {
  const whole = matchWholeStyleSpan(text);
  const props = whole ? parseInlineStyle(whole.styleAttr) : {};
  const inner = whole ? whole.inner : text;
  props[property] = value;
  return `<span style="${serializeInlineStyle(props)}">${inner}</span>`;
}

export function clearInlineStyleProperty(text, property) {
  const whole = matchWholeStyleSpan(text);
  if (!whole) return text;
  const props = parseInlineStyle(whole.styleAttr);
  delete props[property];
  return Object.keys(props).length
    ? `<span style="${serializeInlineStyle(props)}">${whole.inner}</span>`
    : whole.inner;
}

function toggleBulletPoints(text) {
  const lines = text.split("\n");
  const allAreBulleted = lines.every(line => line.trim() === "" || line.trim().startsWith("- "));
  
  const formatted = lines.map(line => {
    if (allAreBulleted) {
      return line.replace(/^(\s*)-\s?/, "$1");
    } else {
      if (line.trim() === "") return line;
      if (line.trim().startsWith("- ")) return line;
      return "- " + line;
    }
  });
  return formatted.join("\n");
}

function clearFormatting(text) {
  let cleared = text;
  
  // 1. Strip styling HTML wrappers
  cleared = clearStyling(cleared);
  
  // 2. Strip standard Markdown markup (bold, italic, strikethrough, inline code)
  cleared = cleared.replace(/\*\*([\s\S]*?)\*\*/g, "$1");
  cleared = cleared.replace(/__([\s\S]*?)__/g, "$1");
  cleared = cleared.replace(/\*([\s\S]*?)\*/g, "$1");
  cleared = cleared.replace(/_([\s\S]*?)_/g, "$1");
  cleared = cleared.replace(/~~([\s\S]*?)~~/g, "$1");
  cleared = cleared.replace(/`([\s\S]*?)`/g, "$1");
  
  // 3. Strip list bullets and header tags on each line
  const lines = cleared.split("\n");
  const processed = lines.map(line => {
    let l = line;
    l = l.replace(/^(\s*)[-*+]\s+/, "$1");
    l = l.replace(/^(\s*)\d+\.\s+/, "$1");
    l = l.replace(/^(\s*)#+\s+/, "$1");
    return l;
  });
  return processed.join("\n");
}

// Global mousedown listener to prevent focus loss in textareas
document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".edit-toolbar")) {
    e.preventDefault();
  }
});

// Dropdown click-to-open toggler (prevents opening on hover)
document.addEventListener("click", (e) => {
  const dropdownToggle = e.target.closest(".edit-toolbar .toolbar-dropdown-toggle");
  if (dropdownToggle) {
    e.preventDefault();
    e.stopPropagation();
    const dropdown = dropdownToggle.closest(".toolbar-dropdown");
    const wasOpen = dropdown.classList.contains("is-open");
    
    // Close all dropdowns first
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
      d.classList.remove("is-open");
    });
    
    // Toggle current
    if (!wasOpen) {
      dropdown.classList.add("is-open");
    }
    return;
  }

  // Close dropdowns if clicked anywhere else
  if (!e.target.closest(".edit-toolbar .toolbar-dropdown-content")) {
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
      d.classList.remove("is-open");
    });
  }
});

// Handle toolbar actions
function handleToolbarClick(event) {
  const button = event.target.closest("button");
  if (!button) return;

  const toolbar = button.closest(".edit-toolbar");
  if (!toolbar) return;

  // Find the associated textarea
  let textarea = null;
  if (toolbar.id === "questionEditToolbar") {
    textarea = el.questionEdit;
  } else if (toolbar.id === "answerEditToolbar") {
    textarea = el.answerEdit;
  } else if (toolbar.id === "notesEditToolbar") {
    textarea = el.notesEdit;
  } else {
    // Inside dynamic "All cards" editor
    const container = toolbar.closest(".all-card-editor");
    if (container) {
      textarea = container.querySelector("[data-all-edit-value]");
    }
  }

  if (!textarea) return;

  event.preventDefault();

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);

  // Quick note: save the selected text as a new card (question) in the
  // quick_notes web deck instead of formatting the textarea.
  if (button.dataset.action === "quick-note") {
    // Capture before closing menus / dropping the selection, so a pin from the
    // raw notes editor can link the quick_notes card back to this spot.
    const anchor = captureSourceAnchor();
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
      d.classList.remove("is-open");
    });
    saveQuickNote(selectedText, button, anchor);
    return;
  }

  // Make a flashcard from the raw-editor selection. The textarea gives exact
  // offsets, so captureNotesAnchor's editing branch resolves the source spot
  // precisely — no fuzzy re-find needed.
  if (button.dataset.action === "make-card") {
    if (!selectedText.trim()) {
      setStatus("Select some text first, then tap + to turn it into a card.", "error");
      return;
    }
    const anchor = captureNotesAnchor();
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach((d) => {
      d.classList.remove("is-open");
    });
    createCardFromNotesSelection(selectedText, anchor);
    return;
  }

  // Insert image: open a file picker, then upload each chosen image to Supabase Storage and
  // insert markdown at the caret this toolbar's textarea had before the picker opened.
  if (button.dataset.action === "insert-image") {
    openImagePicker(textarea, start);
    return;
  }

  let formatFn = null;

  // Toggle actions look at text just outside the selection too (see
  // toggleWrapPair), so they take the full value + range and may return an
  // extended range that swallows adjacent markers. Everything else only
  // touches the selected substring and keeps the original [start, end) range.
  if (button.dataset.action === "bold") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "**");
  } else if (button.dataset.action === "italic") {
    formatFn = (val, s, e) => toggleWrap(val, s, e, "*");
  } else if (button.dataset.action === "underline") {
    formatFn = (val, s, e) => toggleUnderline(val, s, e);
  } else if (button.dataset.action === "strikethrough") {
    formatFn = (val, s, e) => toggleStrikethrough(val, s, e);
  } else if (button.dataset.action === "code") {
    formatFn = (val, s, e) => toggleCode(val, s, e);
  } else if (button.dataset.action === "cloze") {
    formatFn = (val, s, e) => toggleCloze(val, s, e);
  } else if (button.dataset.action === "kbd") {
    formatFn = (val, s, e) => toggleKbd(val, s, e);
  } else if (button.dataset.action === "bullet") {
    formatFn = (val, s, e) => toggleBulletPoints(val.slice(s, e));
  } else if (button.dataset.action === "clear-all") {
    formatFn = (val, s, e) => clearFormatting(val.slice(s, e));
  } else if (button.dataset.font) {
    const font = button.dataset.font;
    formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "font-family", font);
  } else if (button.dataset.color) {
    const color = button.dataset.color;
    // Same choice, same shared default. Without this the raw editor and the
    // rendered view kept two different opinions about "the current colour":
    // pick Green here and the floating pill's swatch (and its one-tap apply)
    // still said yellow. setRenderDefault ignores "clear", which is an action.
    setRenderDefault("color", color);
    if (color === "clear") {
      formatFn = (val, s, e) => clearInlineStyleProperty(val.slice(s, e), "color");
    } else {
      formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "color", color);
    }
  } else if (button.dataset.highlight) {
    const highlight = button.dataset.highlight;
    setRenderDefault("highlight", highlight);
    formatFn = (val, s, e) => toggleMarkColorInText(val.slice(s, e), highlight);
  }

  if (!formatFn) return;

  textarea.focus();
  const val = textarea.value;
  const result = formatFn(val, start, end);
  const isRange = result && typeof result === "object";
  const replacement = isRange ? result.text : result;
  const rangeStart = isRange ? result.rangeStart : start;
  const rangeEnd = isRange ? result.rangeEnd : end;

  textarea.value = val.substring(0, rangeStart) + replacement + val.substring(rangeEnd);

  // Restore selection
  textarea.selectionStart = rangeStart;
  textarea.selectionEnd = rangeStart + replacement.length;

  // Trigger input event to save values to state
  textarea.dispatchEvent(new Event("input", { bubbles: true }));

  // Close all open dropdowns after action is applied
  document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
    d.classList.remove("is-open");
  });
}

// Persisted id of the user's quick_notes deck. Deterministic per user so
// repeated saves always append to the same deck.
export const QUICK_NOTES_DECK_TITLE = "quick_notes";

// ── Quick Notes: glanceable, subject-categorised board ───────────
// The quick_notes deck is special: rather than a known/unknown study deck it's
// a place to skim pinned snippets across all decks at a glance, sorted into
// user-defined subject categories. Everything below powers that treatment.

// Curated swatch palette offered when creating a category (theme-friendly).
const QUICK_NOTE_COLOR_PALETTE = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#64748b"
];
const QUICK_NOTE_DEFAULT_COLOR = QUICK_NOTE_COLOR_PALETTE[0];

// Local mirror of the managed category set, so the board can render instantly
// (and offline) before/without a cloud deck load.
const QUICK_NOTE_CATEGORIES_CACHE_KEY = "recall:quickNoteCategories";

// Current signed-in user's id, read synchronously from the marker written by
// ensureLocalLibraryOwner — lets render code detect the quick_notes deck and
// build its id without an async auth round-trip.
export function cachedUserId() {
  try { return localStorage.getItem(LAST_USER_STORAGE_KEY) || null; } catch { return null; }
}

// Deterministic id of the current user's quick_notes deck (or null if unknown).
export function getQuickNotesDeckId() {
  const uid = cachedUserId();
  return uid ? `quick-notes-${uid}` : null;
}

// True when a deck (by id and/or title) is the special quick_notes deck.
export function isQuickNotesDeck(deckId = state.deckId, title = state.deckTitle) {
  if (deckId && String(deckId).startsWith("quick-notes-")) return true;
  const qid = getQuickNotesDeckId();
  if (qid && String(deckId) === qid) return true;
  return String(title || "").trim().toLowerCase() === QUICK_NOTES_DECK_TITLE;
}

function normalizeCategoryColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : QUICK_NOTE_DEFAULT_COLOR;
}

function generateCategoryId() {
  return `qc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Coerce any stored list into clean [{ id, name, color }] entries (deduped).
function normalizeQuickNoteCategories(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    const name = String(raw.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, color: normalizeCategoryColor(raw.color) });
  }
  return out;
}

// Pull the managed category set out of a deck row's meta JSON (defensive: meta
// may be a parsed object, a JSON string, or missing on pre-migration rows).
export function quickNoteCategoriesFromMeta(meta) {
  let bag = meta;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  const list = bag && typeof bag === "object" ? bag.quickNoteCategories : null;
  return normalizeQuickNoteCategories(list);
}

export function readCachedQuickNoteCategories() {
  try {
    return normalizeQuickNoteCategories(JSON.parse(localStorage.getItem(QUICK_NOTE_CATEGORIES_CACHE_KEY) || "[]"));
  } catch { return []; }
}

export function writeCachedQuickNoteCategories(list) {
  try { localStorage.setItem(QUICK_NOTE_CATEGORIES_CACHE_KEY, JSON.stringify(list)); } catch (_) {}
}

// Read a local deck snapshot by its cloud deckId (not the local ld_ id).
async function readLocalSnapshotByDeckId(deckId) {
  if (!deckId) return null;
  const entry = readLocalDeckIndex().find((e) => e.deckId === deckId);
  if (!entry) return null;
  const snapshot = await readDeckSnapshot(entry.id);
  return snapshot ? { localId: entry.id, snapshot } : null;
}

// The local quick_notes snapshot, creating an empty one if this device has none
// yet. Every quick-note write is local-first now, so there has to be somewhere
// on this device for it to land — a device that has opened the board (which
// reads the cloud directly) but never run a reconcile would otherwise have no
// snapshot at all, and the write would vanish.
//
// The local id is derived from the cloud id for the same reason
// pullCloudDeckToLibrary derives its own: "find existing, else create" isn't
// atomic across tabs, and a deterministic id makes concurrent creators converge
// instead of leaving an orphan snapshot behind.
// The local id the quick_notes deck resolves to — the index entry if one
// exists, else the same deterministic fallback ensureLocalQuickNotesSnapshot
// and pullCloudDeckToLibrary both use, so all three agree on the lock key even
// before the snapshot exists.
function quickNotesLocalId(deckId) {
  return readLocalDeckIndex().find((e) => e.deckId === deckId)?.id || `ld_cloud_${deckId}`;
}

// NOT locked on purpose: it's called from inside locked operations
// (setQuickNoteCardCategory, adoptQuickNoteCategories, saveQuickNote's path),
// and taking the same deck's lock again from in there would deadlock.
async function ensureLocalQuickNotesSnapshot() {
  const deckId = getQuickNotesDeckId();
  if (!deckId) return null;
  const existing = await readLocalSnapshotByDeckId(deckId);
  if (existing) return existing;

  const localId = quickNotesLocalId(deckId);
  const now = new Date().toISOString();
  const snapshot = {
    app: "recall",
    version: 1,
    exportedAt: now,
    deckTitle: QUICK_NOTES_DECK_TITLE,
    deckCategory: defaultDeckCategory,
    notes: "",
    sourceTitle: QUICK_NOTES_DECK_TITLE,
    importTitleHint: QUICK_NOTES_DECK_TITLE,
    deckId,
    current: 0,
    meta: state.quickNoteCategories?.length ? { quickNoteCategories: state.quickNoteCategories } : {},
    cards: [],
    localDeckId: localId
  };
  writeDeckSnapshot(localId, snapshot);
  // A brand-new local deck with no cloud counterpart yet reads as "newer than
  // the cloud", which is what makes the next reconcile push it — including
  // creating the decks row, so ensureQuickNotesDeck is no longer needed on the
  // write path.
  const index = readLocalDeckIndex().filter((e) => e.id !== localId);
  writeLocalDeckIndex([{
    id: localId,
    title: QUICK_NOTES_DECK_TITLE,
    category: defaultDeckCategory,
    cardCount: 0,
    hasNotes: false,
    updatedAt: now,
    createdAt: now,
    lastSyncedAt: null,
    accessedAt: now,
    deckId
  }, ...index]);
  return { localId, snapshot };
}

// ── Category edits are OPERATIONS, not list replacements ─────────
// Saving the whole list is what makes two devices fight: A's list is a snapshot
// of what A could see, so writing it says "these are ALL the categories that
// exist" — silently deleting anything B added that A hadn't heard of yet. There
// is no way to tell "I never had Y" apart from "I deleted Y" in a bare list.
//
// An op says only what the user actually did, so it can be applied on top of
// whatever the cloud holds *now* and leaves every category it doesn't name
// alone. Deletion is explicit, so no tombstones are needed in the shared blob
// and its shape is unchanged.
//
//   { type: "upsert", id, fields: { name?, color? }, full: { id, name, color } }
//   { type: "delete", id }
//
// `fields` is only what changed, so A renaming a category can't revert B's
// concurrent recolour of it. `full` is the fallback used when the id isn't in
// the target list at all (B deleted it, or this is a fresh add).
function categoryUpsertOp(category, fields) {
  return {
    type: "upsert",
    id: String(category.id),
    fields,
    full: { id: String(category.id), name: category.name, color: category.color }
  };
}

function categoryDeleteOp(id) {
  return { type: "delete", id: String(id) };
}

// Replay ops onto a list. Pure, and the same function is used for the local
// list and the cloud's — so what you see locally is what the merge produces.
function applyCategoryOpsToList(list, ops) {
  let out = normalizeQuickNoteCategories(list);
  for (const op of ops || []) {
    if (!op || !op.id) continue;
    if (op.type === "delete") {
      out = out.filter((c) => c.id !== op.id);
      continue;
    }
    const index = out.findIndex((c) => c.id === op.id);
    if (index === -1) {
      // Not there to patch: either a new category, or one another device
      // deleted. Re-inserting on a rename/recolour is deliberate — the user
      // just acted on it, so treat that as intent to keep it.
      out = [...out, { ...(op.full || {}), ...op.fields, id: op.id }];
    } else {
      out = out.map((c, i) => i === index ? { ...c, ...op.fields } : c);
    }
  }
  return normalizeQuickNoteCategories(out);
}

// Apply category edits locally — state + cache + snapshot mirror — and QUEUE
// them for the cloud. The cloud write no longer happens here: a rename or a
// recolour used to cost a read-merge-write round trip the moment you made it,
// which offline did nothing at all. The queue is delivered by the next
// reconcile, batched with every other pending change.
//
// Queuing the OPS (not the resulting list) is what lets the eventual replay
// merge with whatever other devices did in the meantime — see the header above
// categoryUpsertOp.
//
// Returns "queued" so callers can tell the user where the edit landed.
async function applyQuickNoteCategoryOps(ops) {
  await adoptQuickNoteCategories(applyCategoryOpsToList(state.quickNoteCategories, ops));
  queuePendingQuickNoteCategoryOps(getQuickNotesDeckId(), ops);
  return "queued";
}

// The cloud half of applyQuickNoteCategoryOps. Always call it through
// serialiseQuickNoteMetaWrite — it read-merge-writes the shared meta blob.
async function writeQuickNoteCategoryOpsToCloud(deckId, ops) {
  if (!supabaseClient || !isSignedIn || !navigator.onLine || !deckId) return "offline";
  try {
    // Merge into whatever meta the deck already has so we don't clobber future
    // sibling keys (noteAnchors above all — they live in the same blob).
    const { data: existing } = await supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle();
    const base = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
    // Replay our ops onto the CLOUD's current list, not over the top of it.
    // This is the whole fix: a category another device added while we were
    // offline is in `base` and no op names it, so it survives untouched.
    const merged = applyCategoryOpsToList(quickNoteCategoriesFromMeta(base), ops);
    const meta = { ...base, quickNoteCategories: merged };
    let { data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id");
    // By error code first, not by the word "meta" appearing anywhere in the
    // message — see isMissingColumnError. The loose check would read an
    // unrelated failure that happened to name the column as "the migration
    // hasn't run", discard the write, and report it as an ordinary local-only
    // outcome that nothing ever retries.
    if (error && isMissingColumnError(error, "meta")) {
      // Database hasn't run supabase_setup.sql — categories still work
      // locally; just can't sync until the column exists.
      console.warn("decks.meta column missing — quick-note categories are local-only until you run supabase_setup.sql");
      return "no-column";
    }
    if (error) throw error;
    // An UPDATE that matches no row is not an error — it just does nothing. On
    // an account that has never pinned a note the quick_notes deck row doesn't
    // exist yet (only the pin flow creates it), so this reported success while
    // saving nothing at all. `.select()` is what makes that case visible.
    if (!updated || !updated.length) {
      const userId = cachedUserId();
      if (!userId) return "failed";
      await ensureQuickNotesDeck(userId);
      ({ data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id"));
      if (error) throw error;
      if (!updated || !updated.length) return "failed";
    }
    // The merge is authoritative now, so adopt it: it's our edit PLUS whatever
    // other devices had added. Without this the board would keep showing only
    // our own view until the next reload, and the following edit would be built
    // from a list already missing their categories.
    await adoptQuickNoteCategories(merged);
  } catch (error) {
    console.warn("Could not sync quick-note categories to cloud", error);
    return "failed";
  }
  return "synced";
}

// Point every local mirror of the category list at one list.
async function adoptQuickNoteCategories(list) {
  const clean = normalizeQuickNoteCategories(list);
  state.quickNoteCategories = clean;
  writeCachedQuickNoteCategories(clean);
  const deckId = getQuickNotesDeckId();
  if (!deckId) return clean;
  // Locked: this read-modify-writes the quick_notes snapshot's meta bag, which
  // a pull of the same deck also rewrites. readLocalSnapshotByDeckId is
  // deliberately unlocked so it can be called from in here without deadlocking.
  await withDeckLock(quickNotesLocalId(deckId), async () => {
    const local = await readLocalSnapshotByDeckId(deckId);
    if (!local) return;
    local.snapshot.meta = { ...(local.snapshot.meta || {}), quickNoteCategories: clean };
    writeDeckSnapshot(local.localId, local.snapshot);
  });
  return clean;
}

// ── Pending category writes ──────────────────────────────────────
// Category edits made offline (or against a not-yet-created deck row) that
// still owe the cloud a write. Kept per deck id so signing in as someone else
// can never deliver the previous account's categories to the new one's deck.
//
// Stores OPS, not the resulting list. A queued list would say "these are all
// the categories that exist" and delete whatever another device added while
// this one was offline; a queued op only re-states what the user did.
const PENDING_QN_CATEGORIES_KEY = "recall:pendingQuickNoteCategories";

function readPendingQuickNoteCategories() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_QN_CATEGORIES_KEY) || "null");
    if (!raw) return null;
    if (Array.isArray(raw.ops)) {
      const ops = raw.ops.filter((op) => op && op.id && (op.type === "delete" || op.type === "upsert"));
      return ops.length ? { deckId: String(raw.deckId || ""), ops, savedAt: raw.savedAt || "" } : null;
    }
    // Older builds queued a whole list. Convert it to upserts so the edit still
    // lands — the deletions it implied are unrecoverable from a list, which is
    // exactly why this format is gone.
    if (Array.isArray(raw.categories)) {
      const ops = normalizeQuickNoteCategories(raw.categories)
        .map((c) => categoryUpsertOp(c, { name: c.name, color: c.color }));
      return ops.length ? { deckId: String(raw.deckId || ""), ops, savedAt: raw.savedAt || "" } : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Appends to whatever is already queued: several offline edits must all be
// replayed, in order, or the earlier ones are lost.
function queuePendingQuickNoteCategoryOps(deckId, ops) {
  const existing = readPendingQuickNoteCategories();
  const merged = existing && existing.deckId === (deckId || "") ? [...existing.ops, ...ops] : [...ops];
  try {
    localStorage.setItem(PENDING_QN_CATEGORIES_KEY, JSON.stringify({
      deckId: deckId || "", ops: merged, savedAt: new Date().toISOString()
    }));
  } catch (_) {}
}

function clearPendingQuickNoteCategories() {
  try { localStorage.removeItem(PENDING_QN_CATEGORIES_KEY); } catch (_) {}
}

// Deliver queued category edits. Returns true only when something actually
// landed, so the sync report can say so. Safe to call on every sync: it's a
// no-op with nothing pending.
export async function flushPendingQuickNoteCategories() {
  const pending = readPendingQuickNoteCategories();
  if (!pending) return false;
  const deckId = getQuickNotesDeckId();
  if (!deckId) return false;
  // Queued against a different account's deck — not ours to deliver, and
  // pushing it would write one user's categories onto another's board.
  if (pending.deckId && pending.deckId !== deckId) {
    clearPendingQuickNoteCategories();
    return false;
  }
  const outcome = await serialiseQuickNoteMetaWrite(
    () => writeQuickNoteCategoryOpsToCloud(deckId, pending.ops)
  );
  // Only a confirmed write clears the queue. "no-column" is a permanent failure
  // for this database (the migration hasn't been run) but is still cleared —
  // replaying it forever on every sync would never succeed and the local copy
  // is already correct.
  if (outcome === "synced" || outcome === "no-column") clearPendingQuickNoteCategories();
  return outcome === "synced";
}

// ── Quick-note source anchors ────────────────────────────────────
// A pin's noteAnchor (where it was pinned FROM) used to live only in the local
// deck snapshot, and appendCardToLocalLibraryDeck drops it entirely when this
// device has no local copy of the quick_notes deck — the normal case, since you
// pin from OTHER decks. That's why source buttons went missing. Anchors now
// live in the quick_notes deck's `meta.noteAnchors` bag ({ [cardId]: anchor }),
// so they're cloud-synced and survive on every device. No migration needed:
// decks.meta already exists.

// Keep the stored anchor small — meta is one JSON blob for the whole deck, and
// only these fields are needed to find the spot again.
export function trimNoteAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const text = String(anchor.text || "").slice(0, 300);
  const trimmed = {
    offset: Number.isFinite(anchor.offset) ? anchor.offset : null,
    source: String(anchor.source || "").slice(0, 120),
    text,
    deckId: anchor.deckId || null,
    deckLocalId: anchor.deckLocalId || null,
    deckTitle: String(anchor.deckTitle || "").slice(0, 120),
    // Set when the anchor was recovered by searching for the note's text rather
    // than captured at pin time — the UI says so, since it's a best guess.
    ...(anchor.guessed ? { guessed: true } : {})
  };
  // Nothing to jump to without either a locator or a target deck.
  if (!trimmed.text && !trimmed.source && !trimmed.deckId && !trimmed.deckLocalId) return null;
  return trimmed;
}

export function noteAnchorsFromMeta(meta) {
  let bag = meta;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  const anchors = bag && typeof bag === "object" ? bag.noteAnchors : null;
  return anchors && typeof anchors === "object" && !Array.isArray(anchors) ? anchors : {};
}

// Merge anchor patches into the quick_notes deck's meta.noteAnchors. Read-merge
// -write so sibling meta keys (quickNoteCategories) are never clobbered.
// `keepIds`, when given, also drops anchors whose card no longer exists — the
// re-read happens inside this call, so a card deleted elsewhere can't strand its
// anchor in the bag forever.
// Anchor writes are read-merge-write, and two of them run per board open (the
// local backfill and the source recovery). Serialised through one chain so they
// can't interleave — overlapping reads would silently drop one side's anchors.
// EVERY writer of decks.meta must go through this chain. meta is a single JSON
// blob and each writer read-merge-writes the whole of it, so two overlapping
// writes race: the second one's read predates the first one's write, and its
// write puts the stale copy back. Anchors were already serialised here; the
// category writer was NOT, despite touching the same blob — so recolouring a
// category while the board's anchor backfill was in flight could drop either
// side's work. One chain, all writers.
let qnMetaWriteChain = Promise.resolve();

function serialiseQuickNoteMetaWrite(task) {
  qnMetaWriteChain = qnMetaWriteChain.catch(() => {}).then(task);
  return qnMetaWriteChain;
}

// ── Pending anchor writes ────────────────────────────────────────
// Anchors are queued rather than written when they're made, for the same two
// reasons the categories are: a pin shouldn't cost a read-merge-write round trip
// of its own, and offline the write simply vanished. The queue holds a PATCH
// ({ [cardId]: anchor }) plus an optional prune set — never the resolved map,
// which would say "these are all the anchors that exist" and delete whatever
// another device pinned while this one was offline.
const PENDING_QN_ANCHORS_KEY = "recall:pendingQuickNoteAnchors";

function readPendingQuickNoteAnchors() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_QN_ANCHORS_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const patch = raw.patch && typeof raw.patch === "object" ? raw.patch : {};
    const keepIds = Array.isArray(raw.keepIds) ? raw.keepIds.map(String) : null;
    if (!Object.keys(patch).length && !keepIds) return null;
    return { deckId: String(raw.deckId || ""), patch, keepIds };
  } catch {
    return null;
  }
}

// Merges into whatever is already queued — several pins between two syncs must
// all be delivered, not just the last one.
function queuePendingQuickNoteAnchors(patch, { keepIds = null } = {}) {
  const deckId = getQuickNotesDeckId() || "";
  const existing = readPendingQuickNoteAnchors();
  const sameDeck = existing && existing.deckId === deckId;
  const merged = { ...(sameDeck ? existing.patch : {}), ...(patch || {}) };
  // A prune is a statement about the whole bag, so the newest one wins outright
  // rather than intersecting with an older, staler view of what still exists.
  let keep = keepIds ? Array.from(keepIds).map(String) : (sameDeck ? existing.keepIds : null);
  if (!Object.keys(merged).length && !keep) return;
  try {
    localStorage.setItem(PENDING_QN_ANCHORS_KEY, JSON.stringify({
      deckId, patch: merged, keepIds: keep, savedAt: new Date().toISOString()
    }));
  } catch (_) { /* storage full — the anchor is still on the card locally */ }
}

function clearPendingQuickNoteAnchors() {
  try { localStorage.removeItem(PENDING_QN_ANCHORS_KEY); } catch (_) {}
}

// Kept as the queueing entry point so every existing caller keeps working — it
// just no longer touches the network.
function saveQuickNoteAnchors(patch, options) {
  queuePendingQuickNoteAnchors(patch, options);
}

// Deliver queued anchors. Called from reconcileAllDecks (before the pull, so the
// cloud already agrees with us by the time it's read back). Returns true only
// when something actually landed, so the sync report can say so.
export async function flushPendingQuickNoteAnchors() {
  const pending = readPendingQuickNoteAnchors();
  if (!pending) return false;
  const deckId = getQuickNotesDeckId();
  if (!deckId) return false;
  // Queued against a different account's deck — not ours to deliver.
  if (pending.deckId && pending.deckId !== deckId) {
    clearPendingQuickNoteAnchors();
    return false;
  }
  const keepIds = pending.keepIds ? new Set(pending.keepIds) : null;
  const delivered = await serialiseQuickNoteMetaWrite(
    () => writeQuickNoteAnchors(deckId, pending.patch, { keepIds })
  );
  if (delivered) clearPendingQuickNoteAnchors();
  return delivered;
}

// The cloud half. Always call through serialiseQuickNoteMetaWrite — decks.meta
// is one JSON blob and every writer read-merge-writes the whole of it.
async function writeQuickNoteAnchors(deckId, patch, { keepIds = null } = {}) {
  if (!deckId) return false;
  const hasPatch = patch && Object.keys(patch).length;
  if (!hasPatch && !keepIds) return false;
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return false;
  try {
    const { data: existing } = await supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle();
    const base = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
    let anchors = { ...noteAnchorsFromMeta(base), ...(patch || {}) };
    if (keepIds) {
      anchors = Object.fromEntries(Object.entries(anchors).filter(([id]) => keepIds.has(String(id))));
    }
    const meta = { ...base, noteAnchors: anchors };
    // `.select()` because an UPDATE matching no row is not an error — it just
    // does nothing, which is exactly what happens on an account whose
    // quick_notes deck row doesn't exist yet. Same trap the category writer hit.
    let { data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id");
    if (error) throw error;
    if (!updated || !updated.length) {
      const userId = cachedUserId();
      if (!userId) return false;
      await ensureQuickNotesDeck(userId);
      ({ data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id"));
      if (error) throw error;
      if (!updated || !updated.length) return false;
    }
    return true;
  } catch (error) {
    console.warn("Could not sync quick-note source anchors to cloud", error);
    return false;
  }
}

// ── Recovering lost source links ─────────────────────────────────
// Notes pinned before anchors were stored have no anchor anywhere, so there is
// nothing to restore — but the note's TEXT was copied out of some deck's notes,
// so the origin can be found by searching for it. Every hit is persisted as a
// real anchor, so this search runs once per note and the button is permanent
// from then on. Same idea as resolveCardNoteAnchor's content fallback.

// Deck notes indexed for searching, built once per board open (notes can be
// large; one pass beats re-fetching per card).
let qnDeckNotesCache = null;

async function loadDeckNotesForSearch() {
  if (qnDeckNotesCache) return qnDeckNotesCache;
  const qid = getQuickNotesDeckId();
  const decks = [];
  const seen = new Set();

  // Local snapshots first: free, offline, and they carry the localId that makes
  // the jump instant. Streamed via a cursor (see forEachDeckSnapshot) rather
  // than reading each by id — the index is only consulted for its title
  // fallback, not to drive the loop, so a stashed notes-conflict entry
  // (which isn't in the index) is simply skipped by the `if (!indexEntry)`
  // below instead of needing to be filtered out explicitly.
  const indexById = new Map(readLocalDeckIndex().map((entry) => [String(entry.id), entry]));
  await forEachDeckSnapshot((id, snapshot) => {
    const indexEntry = indexById.get(String(id));
    if (!indexEntry) return;
    if (snapshot.deckId && snapshot.deckId === qid) return; // never match the board itself
    const plain = notesAnchorPlainText(snapshot.notes || "");
    if (!plain) return;
    if (snapshot.deckId) seen.add(String(snapshot.deckId));
    decks.push({
      localId: indexEntry.id,
      deckId: snapshot.deckId || null,
      title: snapshot.deckTitle || indexEntry.title || "source",
      plain
    });
  });

  // Then any cloud deck this device has no local copy of.
  if (supabaseClient && isSignedIn && navigator.onLine) {
    try {
      const { data, error } = await supabaseClient.from("decks").select("id, title, notes");
      if (error) throw error;
      for (const deck of data || []) {
        if (!deck || String(deck.id) === qid || seen.has(String(deck.id))) continue;
        const plain = notesAnchorPlainText(deck.notes || "");
        if (!plain) continue;
        decks.push({ localId: null, deckId: String(deck.id), title: deck.title || "source", plain });
      }
    } catch (error) {
      console.warn("Could not load deck notes to recover quick-note sources", error);
    }
  }

  qnDeckNotesCache = decks;
  return decks;
}

// Find and persist source anchors for every note that lacks one. Runs in the
// background after the board paints, then re-renders so the buttons appear.
async function resolveMissingQuickNoteSources() {
  const missing = qnBoard.cards.filter((c) => !c.noteAnchor);
  if (!missing.length) return;
  const decks = await loadDeckNotesForSearch();
  if (!decks.length) return;

  const patch = {};
  for (const card of missing) {
    const needle = notesAnchorPlainText(card.question);
    // Very short snippets match half the library; a wrong jump is worse than
    // no button.
    if (needle.length < 6) continue;
    const hit = decks.find((d) => d.plain.includes(needle));
    if (!hit) continue;
    const anchor = trimNoteAnchor({
      offset: null,
      source: "",
      text: needle,
      deckId: hit.deckId,
      deckLocalId: hit.localId,
      deckTitle: hit.title,
      guessed: true
    });
    if (!anchor) continue;
    card.noteAnchor = anchor;
    patch[String(card.id)] = anchor;
  }

  if (!Object.keys(patch).length) return;
  renderQuickNotesBoard();
  // One write for the whole batch, so this never runs again for these notes.
  saveQuickNoteAnchors(patch);
}

// Assign (or clear, when categoryId is falsy) a card's subject category.
// Local-only: patches the snapshot, marks the card dirty, and bumps updatedAt
// so the next reconcile carries it up with everything else. It used to fire an
// immediate `cards` UPDATE per tap, which on a phone meant a round trip for
// every chip you touched — and did nothing at all offline.
async function setQuickNoteCardCategory(cardId, categoryId) {
  if (!cardId) return false;
  const value = categoryId ? String(categoryId) : null;
  const now = new Date().toISOString();
  const deckId = getQuickNotesDeckId();
  // Serialised per deck (see withDeckLock) — recategorising a note while a
  // background sync pulls quick_notes must not have either write computed away.
  const patched = deckId
    ? await withDeckLock(quickNotesLocalId(deckId), () => patchQuickNoteCardCategory(cardId, value, now))
    : await patchQuickNoteCardCategory(cardId, value, now);

  // Keep the active study deck in step if the quick_notes deck is open.
  // Outside the lock: this is pure in-memory UI state, no storage involved.
  if (isQuickNotesDeck(state.deckId, state.deckTitle)) {
    if (value) state.categoryById[cardId] = value;
    else delete state.categoryById[cardId];
    // The card's own field has to be cleared too. quickNoteCategoryForCard
    // falls back to it when categoryById has no entry, so leaving a stale value
    // behind made "Uncategorized" spring back to the old label on the next save.
    for (const list of [state.masterCards, state.cards]) {
      const card = Array.isArray(list) ? list.find((c) => String(c.id) === String(cardId)) : null;
      if (card) card.category = value;
    }
  }

  return patched;
}

// The storage half of setQuickNoteCardCategory. Only ever called while holding
// the quick_notes deck lock; must not take it again (deadlock).
async function patchQuickNoteCardCategory(cardId, value, now) {
  // Local snapshot patch — the only write there is now, and the source of truth
  // the next reconcile pushes from.
  const local = await ensureLocalQuickNotesSnapshot();
  let patched = false;
  if (local && Array.isArray(local.snapshot.cards)) {
    let card = local.snapshot.cards.find((c) => String(c.id) === String(cardId));
    if (!card) {
      // The board reads the cloud directly, so it can show a note this device
      // has never pulled. Adopt it into the snapshot rather than dropping the
      // edit — with the write no longer going straight to the cloud, "not in
      // the local copy" would otherwise mean "silently ignored".
      const fromBoard = qnBoard.cards.find((c) => String(c.id) === String(cardId));
      if (fromBoard) {
        card = {
          id: String(fromBoard.id),
          question: fromBoard.question || "",
          answer: fromBoard.answer || "",
          status: normalizeCardStatus(fromBoard.status),
          category: fromBoard.category || null,
          ...(fromBoard.noteAnchor ? { noteAnchor: fromBoard.noteAnchor } : {})
        };
        local.snapshot.cards.push(card);
        // Adopting a card back into the snapshot must retire any tombstone for
        // it, or the invariant "a present card is not tombstoned" breaks and
        // the two rules fight: the push re-uploads this card while the pull
        // skips it as deleted, so the user's recategorisation flip-flops and
        // is ultimately lost. Same reason appendCardToLocalLibraryDeck and the
        // restore merge call this.
        dropTombstonesForLiveCards(local.snapshot);
      }
    }
    if (card) {
      patched = true;
      card.category = value;
      card.updatedAt = now;
      // Written straight into the snapshot rather than through
      // saveDeckToLibrary, so the dirty flag has to be set by hand — without it
      // the next pull would take the cloud's older category back.
      card.dirty = true;
      local.snapshot.updatedAt = now;
      writeDeckSnapshot(local.localId, local.snapshot);
      const index = readLocalDeckIndex();
      const entry = index.find((e) => e.id === local.localId);
      if (entry) {
        entry.updatedAt = now;
        entry.cardCount = local.snapshot.cards.length;
        writeLocalDeckIndex(index);
      }
    }
  }

  return patched;
}

// ── Quick Notes board (dedicated skim surface) ───────────────────
// Independent of the active study deck: pulls the quick_notes deck's cards
// straight from the cloud (falling back to the local snapshot offline), so the
// board can be opened at any time without disturbing whatever you're studying.
export const qnBoard = {
  cards: [],       // [{ id, question, answer, category, noteAnchor, updatedAt }]
  // Selected category chips: a Set of category ids, plus the literal "none" for
  // uncategorised. Empty means "All". Multi-select, so several subjects can be
  // read side by side.
  filters: new Set(),
  query: "",       // free-text search across note bodies
  loading: false
};

// A card passes when nothing is selected (All), or when its own category is
// among the selected chips.
function quickNoteMatchesFilters(card) {
  if (!qnBoard.filters.size) return true;
  const known = card.category && findQuickNoteCategory(card.category);
  return known ? qnBoard.filters.has(card.category) : qnBoard.filters.has("none");
}

// The search box narrows the board before the category filter and the chip
// counts are applied, so the counts always describe what you can actually see.
function quickNotesMatchingQuery() {
  const q = qnBoard.query.trim().toLowerCase();
  if (!q) return qnBoard.cards;
  return qnBoard.cards.filter((c) =>
    String(c.question || "").toLowerCase().includes(q) ||
    String(c.answer || "").toLowerCase().includes(q)
  );
}

function findQuickNoteCategory(id) {
  return state.quickNoteCategories.find((c) => c.id === id) || null;
}

// Merge cloud cards (authoritative for text/category) with the deck's cloud
// meta bag (source anchors) and the local snapshot (offline fallback + anchors
// pinned before anchors were synced).
async function loadQuickNotesData() {
  const deckId = getQuickNotesDeckId();
  const local = await readLocalSnapshotByDeckId(deckId);
  const localCards = local && Array.isArray(local.snapshot.cards) ? local.snapshot.cards : [];
  const anchorById = new Map(
    localCards.filter((c) => c.noteAnchor).map((c) => [String(c.id), c.noteAnchor])
  );

  let categories = readCachedQuickNoteCategories();
  if (!categories.length && local) categories = quickNoteCategoriesFromMeta(local.snapshot.meta);

  let cards = localCards.map((c) => ({
    id: String(c.id),
    question: String(c.question || ""),
    answer: String(c.answer || ""),
    category: c.category || null,
    noteAnchor: c.noteAnchor || null,
    updatedAt: c.updatedAt || null
  }));

  if (supabaseClient && isSignedIn && navigator.onLine && deckId) {
    try {
      // Deliver pending offline meta edits BEFORE the read below, because that
      // read treats the cloud row as authoritative. Reading first would show the
      // pre-offline categories, and the next edit from the board would then
      // write that stale list back and clear the pending record — losing the
      // offline edit permanently. Same ordering rule as reconcileAllDecks.
      await flushPendingQuickNoteCategories();
      await flushPendingQuickNoteAnchors();

      const [deckRes, cardsRes] = await Promise.all([
        supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle(),
        supabaseClient.from("cards").select("id, question, answer, status, category, updated_at").eq("deck_id", deckId).order("position", { ascending: true })
      ]);
      const cloudAnchors = deckRes.data && !deckRes.error ? noteAnchorsFromMeta(deckRes.data.meta) : {};
      if (!cardsRes.error && Array.isArray(cardsRes.data)) {
        // Merged, not replaced. Pins are local writes now, so a note made since
        // the last sync exists only on this device — reading the cloud straight
        // into the board would make it disappear the moment you opened the
        // board, which is exactly the bug the pull-side merge exists to stop.
        const { cards: mergedCards } = mergeCloudCardsIntoSnapshot(
          local?.snapshot || { cards: localCards },
          cardsRes.data,
          new Date().toISOString()
        );
        cards = mergedCards.map((c) => ({
          id: String(c.id),
          question: String(c.question || ""),
          answer: String(c.answer || ""),
          category: c.category || null,
          // Cloud anchor first (works on every device), local snapshot second.
          noteAnchor: cloudAnchors[String(c.id)] || c.noteAnchor || anchorById.get(String(c.id)) || null,
          updatedAt: c.updatedAt || null
        }));
      }
      // The cloud deck row is authoritative whenever we could read it —
      // including when it comes back empty. Preferring the local cache on an
      // empty cloud set meant deleting your last category on another device
      // never propagated: the stale cache kept resurrecting it here.
      if (deckRes.data && !deckRes.error) categories = quickNoteCategoriesFromMeta(deckRes.data.meta);

      // Repair pins made before anchors were synced: any anchor this device
      // still has locally but the cloud doesn't gets pushed up once, so the
      // source button comes back here and appears on other devices too. Only
      // safe when the cloud card list actually loaded — pruning against the
      // local fallback list would delete anchors for cards this device simply
      // hasn't pulled yet.
      if (!cardsRes.error && Array.isArray(cardsRes.data)) {
        const backfill = {};
        for (const card of cards) {
          const id = String(card.id);
          if (cloudAnchors[id]) continue;
          const trimmed = trimNoteAnchor(anchorById.get(id));
          if (trimmed) backfill[id] = trimmed;
        }
        const liveIds = new Set(cards.map((c) => String(c.id)));
        const orphaned = Object.keys(cloudAnchors).some((id) => !liveIds.has(String(id)));
        if (Object.keys(backfill).length || orphaned) {
          saveQuickNoteAnchors(backfill, { keepIds: liveIds });
        }
      }
    } catch (error) {
      console.warn("Quick notes cloud load failed; using local snapshot", error);
    }
  }

  state.quickNoteCategories = normalizeQuickNoteCategories(categories);
  writeCachedQuickNoteCategories(state.quickNoteCategories);
  // Newest pins first — a skim board wants the freshest thoughts on top.
  cards.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  qnBoard.cards = cards;
}

function quickNoteCounts(cards = quickNotesMatchingQuery()) {
  const counts = { all: cards.length, none: 0 };
  for (const cat of state.quickNoteCategories) counts[cat.id] = 0;
  for (const card of cards) {
    if (card.category && counts[card.category] !== undefined) counts[card.category] += 1;
    else counts.none += 1;
  }
  return counts;
}

// The chips ARE the category navigation now that the board is one flat grid:
// each toggles independently, so you can read two or three subjects together.
// "All" is simply the state where nothing is selected.
function renderQuickNotesFilters(cards = quickNotesMatchingQuery()) {
  const counts = quickNoteCounts(cards);
  const chip = (key, label, color) => {
    const selected = key === "all" ? !qnBoard.filters.size : qnBoard.filters.has(key);
    const dot = color ? `<span class="qn-chip-dot" style="background:${color}"></span>` : "";
    // The chip wears its category's colour while selected, so the active
    // filters and the cards they let through read as the same thing.
    const style = color ? ` style="--qn-accent:${color}"` : "";
    return `<button type="button" class="qn-chip${selected ? " is-active" : ""}"${style}` +
      ` data-qn-filter="${escapeHtml(key)}" aria-pressed="${selected}">` +
      `${dot}${escapeHtml(label)} <span class="qn-chip-count">${counts[key] || 0}</span></button>`;
  };
  let html = chip("all", "All");
  for (const cat of state.quickNoteCategories) html += chip(cat.id, cat.name, cat.color);
  html += chip("none", "Uncategorized");
  el.qnFilters.innerHTML = html;
}

function renderQnCard(card) {
  const cat = card.category ? findQuickNoteCategory(card.category) : null;
  // The category colour drives the whole card (tint, border, badge) via this
  // one custom property — uncategorised cards fall back to a neutral treatment.
  const accent = cat ? cat.color : "var(--qn-neutral)";
  const anchor = card.noteAnchor;
  // A recovered anchor is a best guess (matched by text), so say so on hover
  // rather than promising it's exactly where you pinned from.
  const hint = anchor && anchor.guessed
    ? "Best match — found by searching your decks' notes"
    : "Go to where this was pinned";
  const source = anchor && (anchor.deckTitle || anchor.deckId || anchor.deckLocalId)
    ? `<button type="button" class="qn-card-source" data-qn-jump="${escapeHtml(card.id)}" title="${escapeHtml(hint)}">&#8618; ${escapeHtml(anchor.deckTitle || "source")}</button>`
    : "";
  const catLabel = cat
    ? `<span class="qn-chip-dot" style="background:${cat.color}"></span>${escapeHtml(cat.name)}`
    : `<span class="qn-chip-dot qn-dot-empty"></span><span class="qn-card-cat-empty">Set category</span>`;
  const when = formatRelativeTime(card.updatedAt);
  const time = when ? `<time class="qn-card-time" datetime="${escapeHtml(card.updatedAt || "")}">${escapeHtml(when)}</time>` : "";
  const classes = `qn-card${cat ? "" : " qn-card-uncat"}`;
  return `<article class="${classes}" data-qn-card="${escapeHtml(card.id)}" style="--qn-accent:${accent}">
    <div class="qn-card-top">
      <button type="button" class="qn-card-cat-btn" data-qn-cat-btn="${escapeHtml(card.id)}" aria-haspopup="true" title="Change category">${catLabel}<span class="qn-caret" aria-hidden="true">&#9662;</span></button>
      ${time}
    </div>
    <div class="qn-card-body">${markdownToSafeHtml(card.question || "")}</div>
    <div class="qn-card-foot">
      ${source}
      <button type="button" class="qn-card-copy" data-qn-copy="${escapeHtml(card.id)}" title="Copy this note" aria-label="Copy this note">&#128203;</button>
    </div>
  </article>`;
}

function updateQnSummary(matching = quickNotesMatchingQuery()) {
  const total = qnBoard.cards.length;
  const cats = state.quickNoteCategories.length;
  if (!total) {
    el.qnSummary.textContent = "Pinned snippets across all your decks, at a glance.";
    return;
  }
  if (qnBoard.query.trim()) {
    el.qnSummary.textContent = `${matching.length} of ${total} note${total === 1 ? "" : "s"} match your search.`;
    return;
  }
  const uncategorized = quickNoteCounts(qnBoard.cards).none;
  const tail = uncategorized ? ` · ${uncategorized} to sort` : "";
  el.qnSummary.textContent = `${total} note${total === 1 ? "" : "s"} across ${cats} categor${cats === 1 ? "y" : "ies"}${tail}.`;
}

// Masonry pass: give every card a row span equal to its own rendered height, so
// a short note doesn't reserve the height of the tallest card in its row. The
// grid is 1px rows (see .qn-grid) and the 12px gap is the card's margin-bottom.
function layoutQuickNotesGrid(retries = 3) {
  const grid = el.qnBody?.querySelector(".qn-grid");
  if (!grid) return;
  const gap = 12;
  const cards = [...grid.children];
  // Zero heights mean the grid hasn't been laid out yet (the board was still
  // hidden when this ran). Retry on the next frame rather than burning in a
  // wrong span — a bounded retry so a permanently-hidden board can't spin.
  if (cards.length && cards.every((card) => !card.getBoundingClientRect().height)) {
    if (retries > 0) requestAnimationFrame(() => layoutQuickNotesGrid(retries - 1));
    return;
  }
  for (const card of cards) {
    const height = card.getBoundingClientRect().height;
    if (!height) continue;
    card.style.gridRowEnd = `span ${Math.max(1, Math.ceil(height) + gap)}`;
  }
  grid.classList.add("is-measured");
}

// Cards change height when the window resizes (text rewraps) or when late
// content lands (images, fonts, KaTeX), so re-measure on both.
let qnCardResizeObserver = null;
function observeQuickNotesGrid() {
  const grid = el.qnBody?.querySelector(".qn-grid");
  if (!grid || typeof ResizeObserver === "undefined") return;
  if (!qnCardResizeObserver) {
    // rAF-batched: one relayout per frame no matter how many cards report.
    let queued = false;
    qnCardResizeObserver = new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; layoutQuickNotesGrid(); });
    });
  }
  qnCardResizeObserver.disconnect();
  for (const card of grid.children) qnCardResizeObserver.observe(card);
}

function renderQuickNotesBoard() {
  const matching = quickNotesMatchingQuery();
  renderQuickNotesFilters(matching);
  updateQnSummary(matching);

  if (qnBoard.loading) {
    el.qnBody.innerHTML = `<div class="qn-empty">Loading your quick notes&#8230;</div>`;
    return;
  }
  if (!qnBoard.cards.length) {
    el.qnBody.innerHTML = `<div class="qn-empty"><p class="qn-empty-title">No quick notes yet</p><p>Select text anywhere in a deck's notes and tap &#128204; to pin it here for a quick skim later.</p></div>`;
    return;
  }

  // One flat, newest-first grid — never grouped by category. Grouping meant a
  // card physically jumped to another section the moment you categorised it,
  // which loses your place; here it stays exactly where it is and only its
  // colour changes.
  const visible = matching.filter(quickNoteMatchesFilters);
  if (visible.length) {
    el.qnBody.innerHTML = `<div class="qn-grid">${visible.map(renderQnCard).join("")}</div>`;
    layoutQuickNotesGrid();
    observeQuickNotesGrid();
    return;
  }
  el.qnBody.innerHTML = qnBoard.query.trim()
    ? `<div class="qn-empty"><p class="qn-empty-title">No matches</p><p>Nothing here matches &ldquo;${escapeHtml(qnBoard.query.trim())}&rdquo;.</p></div>`
    : `<div class="qn-empty">No notes in the selected categories.</div>`;
}

// ── Quick Notes return state ─────────────────────────────────────
// The board's slice of a history location (filters/search/scroll, and the note
// you opened from it). Set by goToNavLocation from the recorded location, then
// consumed by the next board render. See currentNavLocation.
export let qnReturnState = null;

// Setter: an imported binding is read-only, and this is written both from the
// Quick Notes board below and from ui/nav-history.js when Back restores it.
export function setQnReturnState(value) {
  qnReturnState = value;
}

// Put the board back the way it was and mark the note you left from, so it's
// obvious where you were.
function restoreQnReturnState() {
  if (!qnReturnState) return;
  const { cardId, scrollTop } = qnReturnState;
  setQnReturnState(null);
  el.qnBody.scrollTop = scrollTop || 0;
  // cardId is only set when the board was left by opening a note from it — a
  // board recorded any other way has no card to point at.
  if (!cardId) return;
  const card = el.qnBody.querySelector(`.qn-card[data-qn-card="${CSS.escape(cardId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.classList.add("is-returned");
  setTimeout(() => card.classList.remove("is-returned"), 1600);
}

export async function openQuickNotesBoard({ restore = false } = {}) {
  if (!getQuickNotesDeckId()) {
    setStatus("Sign in to use quick notes.", "error");
    return;
  }
  closeAllCardsPanel();
  // A navigation door — remember the deck the user is leaving behind.
  recordNavHistory();
  lockPageScroll();
  el.quickNotesBoard.hidden = false;
  refreshNavBack(); // arrived — now the button knows where "here" is
  const returning = restore && qnReturnState;
  if (returning) {
    // Coming back from a source jump — keep the view the user left behind.
    qnBoard.query = qnReturnState.query;
    qnBoard.filters = new Set(qnReturnState.filters);
  } else {
    // A fresh open starts clean — a stale search or chip selection from last
    // time would look like missing notes.
    qnBoard.query = "";
    qnBoard.filters.clear();
    setQnReturnState(null);
  }
  if (el.qnSearch) el.qnSearch.value = qnBoard.query;
  // Deck notes may have changed since the last open — rebuild the search index.
  qnDeckNotesCache = null;
  qnBoard.loading = true;
  renderQuickNotesBoard();
  try {
    await loadQuickNotesData();
  } finally {
    qnBoard.loading = false;
    renderQuickNotesBoard();
    if (returning) restoreQnReturnState();
  }
  // Deliberately not awaited: the board is already usable, and recovering the
  // missing source links repaints them a moment later.
  resolveMissingQuickNoteSources().catch((error) =>
    console.warn("Could not recover quick-note sources", error)
  );
}

export function closeQuickNotesBoard() {
  closeQnCatMenu();
  closeQnCatModal();
  el.quickNotesBoard.hidden = true;
  unlockPageScroll();
  // Closing changes where "here" is, which changes whether back has anywhere
  // to go (the deck below is usually the newest history entry).
  refreshNavBack();
}

// Jump from a board card to the notes spot it was pinned from (may live in a
// different deck), closing the board first. Mirrors jumpToNoteForCurrentCard.
async function jumpToQuickNoteSource(cardId) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  const anchor = card && card.noteAnchor;
  if (!anchor) {
    setStatus("This note isn't linked to a source spot.", "info");
    return;
  }
  // Record the board itself, WHILE it's still open and tagged with the note
  // being opened, so back returns to this exact card. The deck loads below are
  // part of this same navigation — they must not record on top of it.
  recordNavHistory({ cardId });
  closeQuickNotesBoard();
  if (onAnchorSourceDeck(anchor)) { scheduleNoteJump(anchor); return; }
  setStatus("Opening the source deck…");
  if (anchor.deckLocalId && (await suppressNavRecording(() => loadDeckFromLibrary(anchor.deckLocalId)))) {
    scheduleNoteJump(anchor);
    return;
  }
  if (anchor.deckId && supabaseClient && navigator.onLine) {
    suppressNavRecording(() => loadWebDeck(anchor.deckId))
      .then(() => scheduleNoteJump(anchor))
      .catch(() => setStatus("Couldn't open the source deck for this note.", "error"));
    return;
  }
  setStatus("Couldn't open the source deck for this note — it isn't available on this device.", "error");
}

// Copy a note's text straight to the clipboard — the most common thing to want
// from a board you're skimming.
async function copyQuickNote(cardId, button) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;
  const text = [card.question, card.answer].filter((part) => String(part || "").trim()).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.classList.add("is-copied");
      setTimeout(() => button.classList.remove("is-copied"), 1000);
    }
    showToast("Note copied");
  } catch (error) {
    console.warn("Clipboard write failed", error);
    showToast("Couldn't copy the note", "error");
  }
}

// ── Floating category picker (assign a category to one card) ──────
export function closeQnCatMenu() {
  document.querySelectorAll(".qn-cat-menu").forEach((m) => m.remove());
  document.removeEventListener("click", qnCatMenuOutside, true);
  document.removeEventListener("keydown", qnCatMenuEsc, true);
}
function qnCatMenuOutside(e) {
  if (!e.target.closest(".qn-cat-menu") && !e.target.closest("[data-qn-cat-btn]")) closeQnCatMenu();
}
function qnCatMenuEsc(e) { if (e.key === "Escape") closeQnCatMenu(); }

function openQnCatMenu(cardId, btn) {
  const already = document.querySelector(`.qn-cat-menu[data-card="${CSS.escape(String(cardId))}"]`);
  closeQnCatMenu();
  if (already) return; // second click on the same button closes it
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (!card) return;

  const menu = document.createElement("div");
  menu.className = "qn-cat-menu";
  menu.dataset.card = String(cardId);
  const item = (id, name, color) => {
    const active = (card.category || "") === (id || "") ? " is-active" : "";
    const dot = color
      ? `<span class="qn-chip-dot" style="background:${color}"></span>`
      : `<span class="qn-chip-dot qn-dot-empty"></span>`;
    return `<button type="button" class="qn-cat-menu-item${active}" data-qn-set="${escapeHtml(id)}">${dot}<span>${escapeHtml(name)}</span></button>`;
  };
  let html = state.quickNoteCategories.map((c) => item(c.id, c.name, c.color)).join("");
  html += item("", "Uncategorized", null);
  html += `<button type="button" class="qn-cat-menu-item qn-cat-menu-manage" data-qn-manage="1">&#9881; Manage categories&#8230;</button>`;
  menu.innerHTML = html;
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  const width = menu.offsetWidth || 200;
  menu.style.left = `${Math.min(r.left, window.innerWidth - width - 12)}px`;
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < menu.offsetHeight + 12) menu.style.top = `${Math.max(12, r.top - menu.offsetHeight - 6)}px`;
  else menu.style.top = `${r.bottom + 6}px`;

  setTimeout(() => {
    document.addEventListener("click", qnCatMenuOutside, true);
    document.addEventListener("keydown", qnCatMenuEsc, true);
  }, 0);
}

async function assignQuickNoteCategory(cardId, categoryId) {
  const card = qnBoard.cards.find((c) => String(c.id) === String(cardId));
  if (card) card.category = categoryId || null;
  closeQnCatMenu();
  renderQuickNotesBoard();
  // A local write now — it rides the next sync rather than costing a round trip
  // per tap. Still say where it landed: silence here used to read as "your
  // change was lost" when a later sync reported "nothing to sync".
  const cat = categoryId ? findQuickNoteCategory(categoryId) : null;
  const label = cat ? `“${cat.name}”` : "Uncategorized";
  const ok = await setQuickNoteCardCategory(cardId, categoryId || null);
  if (!ok) {
    showToast(`Could not set ${label} — this note isn't saved on this device`, "error");
  } else {
    showToast(`Set to ${label} — saved here, syncs with everything else`, "success");
  }
}

// Floating palette used to recolour a category from the manage modal.
function openQnRecolorMenu(catId, anchorEl) {
  closeQnCatMenu();
  const menu = document.createElement("div");
  menu.className = "qn-cat-menu qn-recolor-menu";
  menu.innerHTML = QUICK_NOTE_COLOR_PALETTE
    .map((color) => `<button type="button" class="qn-swatch" style="background:${color}" data-qn-pick="${color}" aria-label="Colour ${color}"></button>`)
    .join("");
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-qn-pick]");
    if (!swatch) return;
    recolorQuickNoteCategory(catId, swatch.dataset.qnPick);
    closeQnCatMenu();
  });
  setTimeout(() => {
    document.addEventListener("click", qnCatMenuOutside, true);
    document.addEventListener("keydown", qnCatMenuEsc, true);
  }, 0);
}

// ── Manage categories modal ──────────────────────────────────────
let qnNewColor = QUICK_NOTE_DEFAULT_COLOR;

function renderQnColorPicker(container, selected, attr) {
  container.innerHTML = QUICK_NOTE_COLOR_PALETTE.map((color) => {
    const active = color === selected ? " is-active" : "";
    return `<button type="button" class="qn-swatch${active}" style="background:${color}" data-${attr}="${color}" aria-label="Colour ${color}"></button>`;
  }).join("");
}

function renderQnCatModal() {
  el.qnCatList.innerHTML = state.quickNoteCategories.length
    ? state.quickNoteCategories.map((c) => `
      <div class="qn-cat-row" data-cat="${escapeHtml(c.id)}">
        <button type="button" class="qn-cat-row-swatch" data-qn-recolor="${escapeHtml(c.id)}" style="background:${c.color}" title="Change colour" aria-label="Change colour"></button>
        <input type="text" class="qn-cat-row-name" data-qn-rename="${escapeHtml(c.id)}" value="${escapeHtml(c.name)}" maxlength="40" aria-label="Category name" />
        <button type="button" class="qn-cat-row-del" data-qn-del="${escapeHtml(c.id)}" title="Delete category" aria-label="Delete category">&#128465;</button>
      </div>`).join("")
    : `<p class="qn-cat-empty">No categories yet — add your first below.</p>`;
  renderQnColorPicker(el.qnCatColorPicker, qnNewColor, "qn-new-color");
}

function openQnCatModal() {
  qnNewColor = QUICK_NOTE_COLOR_PALETTE.find((c) => !state.quickNoteCategories.some((x) => x.color === c)) || QUICK_NOTE_DEFAULT_COLOR;
  renderQnCatModal();
  el.qnCatModal.hidden = false;
  setTimeout(() => el.qnCatNewName && el.qnCatNewName.focus(), 30);
}
export function closeQnCatModal() {
  if (el.qnCatModal) el.qnCatModal.hidden = true;
}

// `what` names the edit that was just made ("Added “Vocabulary”"), so the toast
// reports the specific action rather than a generic "saved".
async function commitQuickNoteCategoryOps(ops, what = "Categories updated") {
  await applyQuickNoteCategoryOps(ops);
  renderQnCatModal();
  renderQuickNotesBoard();
  showToast(`${what} — saved here, syncs with everything else`, "success");
}

async function addQuickNoteCategory() {
  const name = String(el.qnCatNewName.value || "").trim();
  if (!name) { el.qnCatNewName.focus(); return; }
  const cat = { id: generateCategoryId(), name, color: normalizeCategoryColor(qnNewColor) };
  el.qnCatNewName.value = "";
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { name: cat.name, color: cat.color })], `Added “${name}”`);
}

async function renameQuickNoteCategory(id, name) {
  const clean = String(name || "").trim();
  const previous = findQuickNoteCategory(id);
  // A blank rename is ignored, so report — and send — the name that stuck.
  const applied = clean || previous?.name || "Category";
  if (previous && applied === previous.name) return;
  // Only `name` travels: sending the whole category would revert a recolour
  // another device made while this one was offline.
  const cat = { ...(previous || { id }), name: applied };
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { name: applied })], `Renamed to “${applied}”`);
}

async function recolorQuickNoteCategory(id, color) {
  const previous = findQuickNoteCategory(id);
  const applied = normalizeCategoryColor(color);
  if (previous && previous.color === applied) return;
  const cat = { ...(previous || { id }), color: applied };
  await commitQuickNoteCategoryOps([categoryUpsertOp(cat, { color: applied })], `Recoloured “${previous ? previous.name : "category"}”`);
}

function deleteQuickNoteCategory(id) {
  const cat = findQuickNoteCategory(id);
  const used = qnBoard.cards.filter((c) => c.category === id).length;
  const msg = used
    ? `Delete "${cat ? cat.name : "this category"}"? ${used} note${used === 1 ? "" : "s"} will become Uncategorized.`
    : `Delete "${cat ? cat.name : "this category"}"?`;
  showConfirmModal(msg, async () => {
    // Detach the category from any board cards + persist those clears.
    const affected = qnBoard.cards.filter((c) => c.category === id);
    for (const card of affected) { card.category = null; await setQuickNoteCardCategory(card.id, null); }
    // Drop the deleted category's chip from the selection, or the board would
    // keep filtering on an id that no longer exists and look empty.
    qnBoard.filters.delete(id);
    const freed = affected.length ? `, ${affected.length} note${affected.length === 1 ? "" : "s"} now Uncategorized` : "";
    await commitQuickNoteCategoryOps([categoryDeleteOp(id)], `Deleted “${cat ? cat.name : "category"}”${freed}`);
  }, { confirmLabel: "Delete", danger: true });
}

// Ensure the quick_notes web deck ROW exists for the current user, returning
// its id. No longer on the pin path — a pin is a pure local write now, and the
// reconcile push creates this row as a side effect of upserting the deck. Still
// used by the meta writers, which UPDATE a row that has to already exist.
async function ensureQuickNotesDeck(userId) {
  const deckId = `quick-notes-${userId}`;

  const { data: existing, error: lookupError } = await supabaseClient
    .from("decks")
    .select("id")
    .eq("id", deckId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return deckId;

  const now = new Date().toISOString();
  const { error: insertError } = await supabaseClient
    .from("decks")
    .upsert({
      id: deckId,
      title: QUICK_NOTES_DECK_TITLE,
      category: defaultDeckCategory,
      current_card_index: 0,
      updated_at: now,
      last_accessed_at: now
    });
  if (insertError) throw insertError;
  return deckId;
}

// Save the selected text as a new card (text becomes the question, answer left
// blank to fill in later) appended to the quick_notes deck.
//
// Entirely local. Pinning used to cost five sequential Supabase round trips —
// deck lookup, deck insert, card count, card insert, deck bump — plus a sixth
// read-merge-write for the source anchor, all before the toast appeared. On a
// phone that's most of a second per pin, and offline it simply failed, losing
// the selection. Now it's a localStorage write, and the whole batch of pins
// goes up with everything else on the next reconcile.
export async function saveQuickNote(rawText, button, sourceAnchor = null) {
  const text = String(rawText || "").trim();
  if (!text) {
    setStatus("Select some text first to save a quick note.", "error");
    return;
  }

  // cachedUserId reads the marker ensureLocalLibraryOwner wrote at sign-in, so
  // this stays synchronous and works offline — getCurrentUser() was a network
  // round trip that made pinning impossible with no connection.
  if (!cachedUserId()) {
    setStatus("Sign in to save quick notes.", "error");
    showToast("Sign in to save quick notes", "error");
    return;
  }

  const local = await ensureLocalQuickNotesSnapshot();
  if (!local) {
    setStatus("Could not save quick note — try signing in again.", "error");
    showToast("Couldn't save quick note", "error");
    return;
  }

  const now = new Date().toISOString();
  const cardId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The source location (deck + note offset) behind the card's "Go to notes"
  // jump. Kept on the card locally AND queued for the deck's cloud meta bag —
  // the cards table has no column for it, so the queue is the only way it
  // reaches another device.
  const anchor = trimNoteAnchor(sourceAnchor);
  const quickCard = { id: cardId, question: text, answer: "", status: null, category: null };
  if (anchor) quickCard.noteAnchor = anchor;

  // The only write that makes this pin real. It can now genuinely fail (an
  // IndexedDB read failure throws rather than silently reading as "no such
  // deck" — see readDeckSnapshot), and a pin that failed must NEVER report
  // success: the user has already moved on from the text they selected, and a
  // false "Saved" is how a note is lost without anyone noticing.
  try {
    await appendCardToLocalLibraryDeck(local.snapshot.deckId, quickCard, now);
  } catch (error) {
    console.error("Could not save quick note", error);
    setStatus("Couldn't save that quick note — reload the app and try again.", "error");
    showToast("Couldn't save quick note — nothing was written", "error");
    return;
  }
  if (anchor) queuePendingQuickNoteAnchors({ [cardId]: anchor });

  // Mirror into the open board so a pin shows up without a reload.
  if (Array.isArray(qnBoard.cards)) {
    qnBoard.cards.unshift({
      id: cardId, question: text, answer: "", category: null,
      noteAnchor: anchor || null, updatedAt: now
    });
  }

  setStatus("Saved to quick_notes.");
  showToast(navigator.onLine ? "Saved to quick_notes" : "Saved to quick_notes — syncs when you're back online");
  if (button) {
    button.classList.add("quick-note-saved");
    setTimeout(() => button.classList.remove("quick-note-saved"), 1200);
  }
}

// ── Hamburger menu (side drawer, all screen sizes) ───────────────
// The drawer's controls live inside the block below, but the overlay stack
// (OVERLAY_LAYERS) and the Back key have to be able to see and close it from
// outside. These two are the seam. They default to "there is no drawer" so
// nothing has to null-check them if the markup is ever absent.
export let isMainMenuOpen = () => false;
export let closeMainMenu = () => {};
{
  const menuBtn = document.getElementById("mobileMenuBtn");
  const toolbar = document.getElementById("mainToolbar");
  const backdrop = document.getElementById("mobileBackdrop");
  const closeBtn = document.getElementById("toolbarCloseBtn");

  if (menuBtn && toolbar && backdrop) {
    const openMenu = () => {
      toolbar.classList.add("mobile-open");
      backdrop.classList.add("is-open");
      backdrop.hidden = false;
      menuBtn.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
    };

    const closeMenu = () => {
      toolbar.classList.remove("mobile-open");
      backdrop.classList.remove("is-open");
      backdrop.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    };

    isMainMenuOpen = () => toolbar.classList.contains("mobile-open");
    closeMainMenu = closeMenu;

    menuBtn.addEventListener("click", () => {
      toolbar.classList.contains("mobile-open") ? closeMenu() : openMenu();
    });

    if (closeBtn) closeBtn.addEventListener("click", closeMenu);
    backdrop.addEventListener("click", closeMenu);

    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      // Export menus have inline expansion inside the drawer — don't close for them
      if (btn.id === "exportBtn" || btn.id === "exportNotesBtn") return;
      // Close button, section-label clicks, and all other actions close the
      // drawer — SYNCHRONOUSLY. This used to be setTimeout(closeMenu, 150), and
      // that 150ms was the single largest source of "I press a button and
      // nothing happens". The button's own listener runs first (target phase)
      // and has already opened its panel by the time this bubble handler fires
      // — but every one of those panels is z-indexed 70-240, i.e. UNDER the
      // backdrop (499) and the drawer (500). So the work was done in frame 1
      // and then hidden behind a 55%-black scrim for 150ms before the drawer
      // even began its 220ms slide. Closing here puts the panel on screen in
      // the same frame as the press.
      closeMenu();
    });

    // No private Escape listener here any more: the drawer is an entry in
    // OVERLAY_LAYERS, so the one global Escape handler closes it in the right
    // order relative to everything else (a dialog opened FROM the drawer used
    // to lose its Escape to the drawer underneath it), and the hardware Back
    // key gets the same behaviour for free.
  }
}

// NOTE: the escaped-math repair used to run here, at module scope. It can't
// any more: deck bodies moved to IndexedDB, and bootApp() suspends on its first
// await (initDeckStorage) — so module scope now runs with an EMPTY cache.
// The repair would read every deck as missing, repair nothing, and still stamp
// MATH_ESCAPE_REPAIR_KEY, permanently skipping itself on every device. It is
// now invoked from bootApp immediately after the cache loads, which preserves
// the original guarantee (repaired before any deck can be opened) against the
// new async storage. See runEscapedMathRepair.

// Everything above attaches at module scope, and this file only finishes parsing
// several seconds after the toolbar is on screen (see the boot-click queue in
// index.html). Anything the user pressed in that window landed on a control with
// no listener yet; now that they all have one, honour the press.
(function replayBootClick() {
  const boot = window.__recallBoot;
  if (!boot || typeof boot.take !== "function") return;
  const id = boot.take();
  if (!id) return;
  const target = document.getElementById(id);
  if (!target) return;
  // Must land after initToolbars, which wires several controls — notably the ☰
  // drawer, which every toolbar action lives behind. Replaying before that would
  // click a button whose handler does not exist yet: the exact failure this is
  // here to fix.
  //
  // Both halves of onDomReady put initToolbars first (it registers earlier, on
  // the same listener or the same microtask queue), and setTimeout is a
  // macrotask, so it is later than either. Belt and braces, cheaply.
  const fire = () => window.setTimeout(() => target.click(), 0);
  onDomReady(fire);
})();

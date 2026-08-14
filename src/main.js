// Every relative import in src/ carries ?v=__BUILD__, substituted by
// .github/workflows/deploy.yml. Without it, a release could serve a new
// main.js against a browser- or worker-cached copy of an old dependency — the
// mixed-build failure this repo has already shipped twice. deploy.yml and
// tools/module-symbols.mjs both refuse a relative import without it.

import { exportLibraryBackupZip } from "./backup/backup.js?v=__BUILD__";
import { runRestoreFlow } from "./backup/restore.js?v=__BUILD__";
import { LAST_USER_STORAGE_KEY, appInitialized, bootApp, ensureLocalLibraryOwner, initAppForUser, recoverSessionIfPossible, setAppInitialized, setupAuthListener } from "./boot.js?v=__BUILD__";
import { clearAllCardDropTargets, closeAllCardsPanel, deleteAllCard, goToCard, handleAllCardDragOver, handleAllCardDragStart, handleAllCardDrop, insertCardAfter, pushCardUndoSnapshot, redoCardAction, setAllCardStatus, snapshotCardsState, undoCardAction } from "./cards/all-cards-edit.js?v=__BUILD__";
import { allCardsAnswersVisible, allCardsCompact, flipAllCard, handleAllCardDragEnd, openAllCardsPanel, setAllCardsAnswersVisible, setAllCardsCompact, setAllCardsFilter, toggleAllCardEditor } from "./cards/all-cards.js?v=__BUILD__";
import { showCard } from "./cards/card-view.js?v=__BUILD__";
import { flipCard, moveCard, navigateCard, replayDeck, resetQuiz, shuffleCards } from "./cards/deck-actions.js?v=__BUILD__";
import { createNewDeck, newDeckInFolder } from "./cards/new-deck.js?v=__BUILD__";
import { afterPaint, questionFitDeferredBySelection, scheduleLiveQuestionFit } from "./cards/question-fit.js?v=__BUILD__";
import { handleDiagramPointerDown, handleDiagramPointerEnd, handleDiagramPointerMove, handleDiagramWheel, handlePointerCancel, handlePointerDown, handlePointerMove, handlePointerUp, handleStylePanelTouchMove, handleStylePanelTouchStart, handleStylePanelWheel, handleTouchCancel, handleTouchEnd, handleTouchMove, handleTouchStart, hasCardTextSelection, isCardActionTarget } from "./cards/swipe.js?v=__BUILD__";
import { describeAuthError, getCachedSession, handleLogin, handleLogout, handleSignup } from "./cloud/auth.js?v=__BUILD__";
import { isMissingColumnError } from "./cloud/deck-list.js?v=__BUILD__";
import { closeStylePanel, handleStyleEnvironmentChange, loadStyleFromWeb, openStylePanel, switchStyleEditProfile, syncStyleToWeb } from "./cloud/style-sync.js?v=__BUILD__";
import { clearSupabaseConfig, initSupabaseClient, isSignedIn, reloadSupabaseLibrary, saveSupabaseConfig, setSignedIn, setSupabaseClient, supabaseClient } from "./cloud/supabase-client.js?v=__BUILD__";
import { closeWebDeckExportMenus, loadWebDeck } from "./cloud/web-decks.js?v=__BUILD__";
import { defaultDeckCategory } from "./core/constants.js?v=__BUILD__";
import { el } from "./core/dom.js?v=__BUILD__";
import { ensureMermaid, ensureTurndown } from "./core/lib-loader.js?v=__BUILD__";
import { escapeHtml } from "./core/text.js?v=__BUILD__";
import { initToolbars, toggleClozes } from "./editor/toolbars.js?v=__BUILD__";
import { tripleClickAllCardToEditor, tripleClickCardToEditor } from "./editor/triple-click.js?v=__BUILD__";
import { exportAllMyDecks, exportSelectedMyDecks } from "./export/decks.js?v=__BUILD__";
import { normalizeCardStatus } from "./export/markdown.js?v=__BUILD__";
import { buildNotesFlatPrintDocument, closePrintPreview, printPreviewOpen, setPrintTitleBeforeExport } from "./export/pdf.js?v=__BUILD__";
import { generatePdfDirectly, handleExportAction, handleExportNotesAction, installPdfPrintStyle, printPreparedDocument, revealPrintRootClozes } from "./export/run.js?v=__BUILD__";
import { eraseNotesSelection, makeClozeFromSelection } from "./format/cloze.js?v=__BUILD__";
import { toggleMarkColorInText } from "./format/highlight.js?v=__BUILD__";
import { closeAllRenderMenus, handleRenderToolbarAction, initRenderToolbars, renderFormatDefaults, renderTargetConfig, setRenderDefault } from "./format/render-toolbar.js?v=__BUILD__";
import { applyPillHighlight, buildPillHighlightMenu, clozeTextareaSelection, eraseTextareaSelection, extractSelectionToNote, hideNotesSelectionButtonUnlessPinned, pillActionTarget } from "./format/selection-tools.js?v=__BUILD__";
import { revokeLocalImageUrls } from "./images/outbox.js?v=__BUILD__";
import { dragContainsImage, firstImageFile, gifSourceUrlFromTransfer, insertTransferImage, openImagePicker } from "./images/paste.js?v=__BUILD__";
import { imagePickerActive } from "./images/upload.js?v=__BUILD__";
import { importEpubFile, isEpubName, reportEpubImportCrash } from "./import/epub.js?v=__BUILD__";
import { loadFiles, loadSample, showImportSourceDrawer, stagePastedMarkdown } from "./import/files.js?v=__BUILD__";
import { htmlToMarkdown } from "./import/html-to-markdown.js?v=__BUILD__";
import { countQuestionHeadings, parseCards, stripReaderMetadata } from "./import/parse-cards.js?v=__BUILD__";
import { clearImportStaging, commitStagedImport, importDestinationFolder, importStaging, renderImportReview, setPendingImportFolder, stageMarkdownImport } from "./import/staging.js?v=__BUILD__";
import { cleanImportUrl, fetchImportText, readerUrlFor } from "./import/url.js?v=__BUILD__";
import { closeAllDeckTileMenus, createFolder, setAllFoldersExpanded } from "./library/folder-tree.js?v=__BUILD__";
import { normalizeDeckCategory } from "./library/folders.js?v=__BUILD__";
import { appendCardToLocalLibraryDeck, loadDeckFromLibrary, readLocalDeckIndex, writeLocalDeckIndex } from "./library/local-library.js?v=__BUILD__";
import { categorizeSelectedMyDecks, deleteSelectedMyDecks, loadSelectedMyDecks } from "./library/my-decks-actions.js?v=__BUILD__";
import { hydrateMyDecksIcons } from "./library/my-decks-icons.js?v=__BUILD__";
import { closeMyDecksMoreMenu, currentMyDecksFolder, importIntoFolder, myDecksImportFolder, toggleMyDecksMoreMenu } from "./library/my-decks-menu.js?v=__BUILD__";
import { setMyDecksDisplay, setMyDecksSort, setMyDecksView } from "./library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList, repaintMyDecks } from "./library/my-decks-render.js?v=__BUILD__";
import { selectedMyDecks, selectedMyFolders, updateMyDecksBulkBar } from "./library/my-decks-selection.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection, jumpToNoteForCurrentCard, notesAnchorPlainText, onAnchorSourceDeck, scheduleNoteJump } from "./notes/anchors.js?v=__BUILD__";
import { scheduleNotesCaretCheck } from "./notes/caret.js?v=__BUILD__";
import { closeNoteLinkPicker, commitNoteLinkPicker, isNoteLinkPickerOpen, moveNoteLinkPicker, updateNoteLinkPicker } from "./notes/link-picker.js?v=__BUILD__";
import { followNoteLink, revealNoteHeading } from "./notes/note-links.js?v=__BUILD__";
import { commitNotesEditIfActive, enterNotesEditing, isNotesEditing, isProgrammaticNotesScroll, renderNotesViewPinned, setNotesScrolledSource } from "./notes/notes-view.js?v=__BUILD__";
import { findRawOffsetForRenderedPoint } from "./notes/raw-offset.js?v=__BUILD__";
import { rawOffsetForCurrentNotesScroll, scheduleReadingAnchorCapture } from "./notes/scroll-anchor.js?v=__BUILD__";
import { currentNotesSelectionMarkdown, hideNotesSelectionButton, pillSelectionCapture, scheduleNotesSelectionCheck } from "./notes/selection.js?v=__BUILD__";
import { closeNotesToc, isNotesTocOpen, notesTocHeadings, notesTocScrollFrame, scrollNotesEditToHeadingIndex, scrollNotesHeadingIntoView, setNotesTocScrollFrame, tocPushesNotes, toggleNotesToc, updateNotesTocActive } from "./notes/toc.js?v=__BUILD__";
import { collectDeckClozes } from "./panels/cloze-panel.js?v=__BUILD__";
import { appInfoBtn, appInfoCheckBtn, appInfoCloseBtn, appInfoHealthBtn, appInfoModal, appInfoReloadBtn, closeAppInfoModal, forceRefreshAppInfo, openAppInfoModal, runProjectHealthCheck } from "./pwa/app-info.js?v=__BUILD__";
import { FOREGROUND_SYNC_IDLE_MS, lastHiddenAt, onlineReconcileTimer, setLastHiddenAt, setOnlineReconcileTimer, updateOnlineIndicator } from "./pwa/online.js?v=__BUILD__";
import { installManifestLink, registerServiceWorker } from "./pwa/service-worker-client.js?v=__BUILD__";
import { closeDiagramModal, zoomDiagramBy } from "./render/diagram-zoom.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "./render/enhance.js?v=__BUILD__";
import { markdownToSafeHtml } from "./render/preprocess.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "./render/tables.js?v=__BUILD__";
import { deckSnapshotCache, deckStoreChannel, deckStoreRequest, forEachDeckSnapshot, indexedDbUnavailable, pendingDeckWrites, readDeckSnapshot, scheduleDeckAutosave, setDeckStoreChannel, touchDeckSnapshotCache, withDeckLock, writeDeckSnapshot } from "./storage/deck-store.js?v=__BUILD__";
import { isQuotaExceededError } from "./storage/quota.js?v=__BUILD__";
import { closeStoragePanel, openStoragePanel, refreshStorageReport, runStorageAction } from "./storage/storage-panel.js?v=__BUILD__";
import { applyAutoSyncInterval, autoSyncTick, setAutoSyncMinutes } from "./sync/auto-sync.js?v=__BUILD__";
import { dropTombstonesForLiveCards, mergeCloudCardsIntoSnapshot } from "./sync/cards.js?v=__BUILD__";
import { formatRelativeTime, updateDeckEmptyStatus } from "./sync/indicator.js?v=__BUILD__";
import { showNotesConflictModal } from "./sync/notes-conflict.js?v=__BUILD__";
import { reconcileAllDecks } from "./sync/reconcile.js?v=__BUILD__";
import { closeTopmostOverlay, initBackGesture } from "./ui/back-gesture.js?v=__BUILD__";
import { showAuthenticatedUI, showLibraryFailedScreen, showLoginScreen, showSetupScreen } from "./ui/boot-screens.js?v=__BUILD__";
import { applyChromeCollapse, chromeFocusPinned, chromeMobileMedia, chromeScrollFrame, hasStudyTextSelection, isMobileChrome, measureChromeHeights, setChromeFocusPinned, setChromeScrollFrame, setFocusMode, trackChromeScroll } from "./ui/chrome.js?v=__BUILD__";
import { closeImportPanel, closeMyDecksPanel, editCurrentDeckCategory, editCurrentDeckTitle, openImportPanel, openMyDecksPanel } from "./ui/deck-header.js?v=__BUILD__";
import { addBlankCardAtCursor, flushWorkingDeck, toggleEditMode } from "./ui/edit-mode.js?v=__BUILD__";
import { setButtonLoading, setStatus, showConfirmModal, showToast } from "./ui/feedback.js?v=__BUILD__";
import { closeHelpModal, helpBtn, helpModal, helpModalCloseBtn, helpModalCloseFootBtn, openHelpModal } from "./ui/help.js?v=__BUILD__";
import { goNavBack, recordNavHistory, refreshNavBack, suppressNavRecording } from "./ui/nav-history.js?v=__BUILD__";
import { anyModalOpen, lockPageScroll, unlockPageScroll } from "./ui/overlays.js?v=__BUILD__";
import { chooseDeckCategory } from "./ui/pickers.js?v=__BUILD__";
import { defaultStyleProfiles, styleDefaults } from "./ui/style-schema.js?v=__BUILD__";
import { applyStyleDensity, detectStyleProfile, handleStyleControlChange, normalizeStyleValue, resetStyleField, resetStyleProfile, trackKeyboardInset } from "./ui/style-settings.js?v=__BUILD__";
import { styleMobileMedia, styleProfiles } from "./ui/style-tokens.js?v=__BUILD__";
import { configureMermaid, currentThemeId, setTheme, setThemeMenuOpen } from "./ui/theme.js?v=__BUILD__";
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


export const sampleMarkdown = `::
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


export const swipeConfig = {
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


// ── EPUB import: one folder per book, one deck per chapter ─────────────────
// An EPUB is a zip container (OCF): META-INF/container.xml points at the
// package document (.opf), whose <manifest> lists every resource and whose
// <spine> gives the reading order. Chapters are converted to Markdown "as
// is" via the same Turndown pipeline used for pasted rich text; embedded
// images are uploaded through the existing Supabase Storage pipeline first so chapter
// Markdown can reference hosted URLs instead of in-zip paths.


// ── Import panel: source pickers ────────────────────────────────────────────


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
        setAppInitialized(true);
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


// Coming back from a frozen tab or a dead connection: check the deadline
// immediately rather than waiting up to a second (and, more importantly, make
// sure a tab that was throttled for an hour syncs the moment it's looked at).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoSyncTick();
});
window.addEventListener("online", autoSyncTick);


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


el.myDecksMoreBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleMyDecksMoreMenu(); });
document.getElementById("myDecksMoreCloseBtn")?.addEventListener("click", closeMyDecksMoreMenu);
// The EPUB picker is a <label> whose click opens the file dialog; close the menu
// alongside it so the sheet isn't still sitting there behind the OS dialog.
document.getElementById("myDecksImportEpubBtn")?.addEventListener("click", () => closeMyDecksMoreMenu());
document.addEventListener("click", (e) => {
  if (!e.target.closest(".my-decks-more")) closeMyDecksMoreMenu();
});


el.myDecksNewFolderBtn?.addEventListener("click", () => createFolder(currentMyDecksFolder()));
el.myDecksNewDeckBtn?.addEventListener("click", () => newDeckInFolder(currentMyDecksFolder()));


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


window.addEventListener("online", () => { recoverSessionIfPossible(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") recoverSessionIfPossible();
});


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


document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    setLastHiddenAt(Date.now());
    flushWorkingDeck();
    return;
  }
  // Coming back to a backgrounded PWA used to show whatever was on screen when
  // you left it until the next auto-sync tick (off by default) — so on a phone,
  // where the app is backgrounded constantly, edits from another device could
  // sit unseen indefinitely. reconcileAllDecks self-gates on sign-in and
  // connectivity and dedupes overlapping runs, so this is safe to just call.
  if (!lastHiddenAt || Date.now() - lastHiddenAt < FOREGROUND_SYNC_IDLE_MS) return;
  setLastHiddenAt(0);
  if (!isSignedIn || !navigator.onLine) return;
  reconcileAllDecks({ explicit: false });
});


window.addEventListener("online", () => {
  updateOnlineIndicator();
  updateDeckEmptyStatus();
  showToast("Back online", "success");
  // Connectivity returned — reconcile the local mirror with the cloud. Debounced
  // so a flaky connection flapping doesn't kick off overlapping syncs.
  if (onlineReconcileTimer) clearTimeout(onlineReconcileTimer);
  setOnlineReconcileTimer(setTimeout(() => {
    setOnlineReconcileTimer(null);
    reconcileAllDecks({ explicit: false });
  }, 1500));
});
window.addEventListener("offline", () => {
  updateOnlineIndicator();
  updateDeckEmptyStatus();
  showToast("You're offline — local decks still work", "info");
});
updateOnlineIndicator();


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


if (appInfoHealthBtn) appInfoHealthBtn.addEventListener("click", runProjectHealthCheck);


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


 // longest edge, in px


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


// ── Cleanup ────────────────────────────────────────────────────────────────


// ── Panel ──────────────────────────────────────────────────────────────────


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

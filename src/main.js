// Every relative import in src/ carries ?v=__BUILD__, substituted by
// .github/workflows/deploy.yml. Without it, a release could serve a new
// main.js against a browser- or worker-cached copy of an old dependency — the
// mixed-build failure this repo has already shipped twice. deploy.yml and
// tools/module-symbols.mjs both refuse a relative import without it.

import { exportLibraryBackupZip } from "./backup/backup.js?v=__BUILD__";
import { runBrokenImageScan } from "./backup/broken-images.js?v=__BUILD__";
import { runRestoreFlow } from "./backup/restore.js?v=__BUILD__";
import { appInitialized, bootApp, ensureLocalLibraryOwner, initAppForUser, recoverSessionIfPossible, resetLocalLibrary, setAppInitialized, setupAuthListener } from "./boot.js?v=__BUILD__";
import { clearAllCardDropTargets, closeAllCardsPanel, deleteAllCard, goToCard, handleAllCardDragOver, handleAllCardDragStart, handleAllCardDrop, insertCardAfter, pushCardUndoSnapshot, redoCardAction, setAllCardStatus, snapshotCardsState, undoCardAction } from "./cards/all-cards-edit.js?v=__BUILD__";
import { allCardsAnswersVisible, allCardsCompact, flipAllCard, handleAllCardDragEnd, openAllCardsPanel, setAllCardsAnswersVisible, setAllCardsCompact, setAllCardsFilter, toggleAllCardEditor } from "./cards/all-cards.js?v=__BUILD__";
import { showCard } from "./cards/card-view.js?v=__BUILD__";
import { flipCard, moveCard, navigateCard, replayDeck, resetQuiz, shuffleCards } from "./cards/deck-actions.js?v=__BUILD__";
import { createNewDeck, newDeckInFolder } from "./cards/new-deck.js?v=__BUILD__";
import { questionFitDeferredBySelection, scheduleLiveQuestionFit } from "./cards/question-fit.js?v=__BUILD__";
import { handleDiagramPointerDown, handleDiagramPointerEnd, handleDiagramPointerMove, handleDiagramWheel, handlePointerCancel, handlePointerDown, handlePointerMove, handlePointerUp, handleStylePanelTouchMove, handleStylePanelTouchStart, handleStylePanelWheel, handleTouchCancel, handleTouchEnd, handleTouchMove, handleTouchStart, hasCardTextSelection, isCardActionTarget } from "./cards/swipe.js?v=__BUILD__";
import { describeAuthError, getCachedSession, handleLogin, handleLogout, handleSignup } from "./cloud/auth.js?v=__BUILD__";
import { closeStylePanel, handleStyleEnvironmentChange, loadStyleFromWeb, openStylePanel, switchStyleEditProfile, syncStyleToWeb } from "./cloud/style-sync.js?v=__BUILD__";
import { resolveUnresolvedStorageImages } from "./cloud/storage-urls.js?v=__BUILD__";
import { clearSupabaseConfig, initSupabaseClient, isSignedIn, onSigningReadyChange, reloadSupabaseLibrary, saveSupabaseConfig, setSignedIn, setSupabaseClient } from "./cloud/supabase-client.js?v=__BUILD__";
import { closeWebDeckExportMenus } from "./cloud/web-decks.js?v=__BUILD__";
import { deckEmptyImportBtn2, deckEmptyNewBtn, deckEmptyWebBtn, el, onDomReady } from "./core/dom.js?v=__BUILD__";
import { assertBootLibraries } from "./core/lib-guard.js?v=__BUILD__";
import { ensureTurndown } from "./core/lib-loader.js?v=__BUILD__";
import { state } from "./core/state.js?v=__BUILD__";
import { formatStorageBytes } from "./core/text.js?v=__BUILD__";
import { handleToolbarClick } from "./editor/toolbar-actions.js?v=__BUILD__";
import { closeAllEditToolbarDropdowns, closeMainMenu, initToolbars, setCloseMainMenu, setIsMainMenuOpen, toggleClozes } from "./editor/toolbars.js?v=__BUILD__";
import { tripleClickAllCardToEditor, tripleClickCardToEditor } from "./editor/triple-click.js?v=__BUILD__";
import { exportAllMyDecks, exportSelectedMyDecks } from "./export/decks.js?v=__BUILD__";
import { closePrintPreview, printPreviewOpen } from "./export/pdf.js?v=__BUILD__";
import { generatePdfDirectly, handleExportAction, handleExportDocumentAction, handleExportHighlightsAction, handleExportNotesAction } from "./export/run.js?v=__BUILD__";
import { eraseNotesSelection, makeClozeFromSelection } from "./format/cloze.js?v=__BUILD__";
import { closeAllRenderMenus, handleRenderToolbarAction, initRenderToolbars, renderFormatDefaults, renderTargetConfig, setRenderDefault } from "./format/render-toolbar.js?v=__BUILD__";
import { applyPillHighlight, buildPillHighlightMenu, clozeTextareaSelection, eraseTextareaSelection, extractSelectionToNote, hideNotesSelectionButtonUnlessPinned, pillActionTarget } from "./format/selection-tools.js?v=__BUILD__";
import { markBrokenImages } from "./images/broken.js?v=__BUILD__";
import { revokeLocalImageUrls } from "./images/outbox.js?v=__BUILD__";
import { allImageFiles, dragContainsImage, gifSourceUrlFromTransfer, insertTransferImages } from "./images/paste.js?v=__BUILD__";
import { imagePickerActive } from "./images/upload.js?v=__BUILD__";
import { importEpubFile, isEpubName, reportEpubImportCrash } from "./import/epub.js?v=__BUILD__";
import { loadFiles, loadSample, showImportSourceDrawer, stagePastedMarkdown } from "./import/files.js?v=__BUILD__";
import { htmlToMarkdown } from "./import/html-to-markdown.js?v=__BUILD__";
import { clearImportStaging, commitStagedImport, importDestinationFolder, importStaging, renderImportReview, setPendingImportFolder } from "./import/staging.js?v=__BUILD__";
import { fetchUrl } from "./import/url.js?v=__BUILD__";
import { closeAllDeckTileMenus, createFolder, setAllFoldersExpanded } from "./library/folder-tree.js?v=__BUILD__";
import { normalizeDeckCategory } from "./library/folders.js?v=__BUILD__";
import { flushIndexBatch, readLocalDeckIndex } from "./library/local-library.js?v=__BUILD__";
import { categorizeSelectedMyDecks, deleteSelectedMyDecks, loadSelectedMyDecks } from "./library/my-decks-actions.js?v=__BUILD__";
import { hydrateMyDecksIcons } from "./library/my-decks-icons.js?v=__BUILD__";
import { closeMyDecksMoreMenu, currentMyDecksFolder, importIntoFolder, myDecksImportFolder, myDecksSearchTimer, setMyDecksSearchTimer, toggleMyDecksMoreMenu } from "./library/my-decks-menu.js?v=__BUILD__";
import { setMyDecksDisplay, setMyDecksSort, setMyDecksView } from "./library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList, repaintMyDecks } from "./library/my-decks-render.js?v=__BUILD__";
import { selectedMyDecks, selectedMyFolders, updateMyDecksBulkBar } from "./library/my-decks-selection.js?v=__BUILD__";
import { captureNotesAnchor, captureSourceAnchor, createCardFromNotesSelection, jumpToNoteForCurrentCard } from "./notes/anchors.js?v=__BUILD__";
import { sourceMarkIndexFor } from "./notes/anchors.js?v=__BUILD__";
import { refreshHighlightBadges, setHighlightBadgeHandler } from "./notes/highlight-badges.js?v=__BUILD__";
import { openHighlightNoteEditor } from "./notes/highlight-note-editor.js?v=__BUILD__";
import { bookmarkCurrentSpot, goToBookmark } from "./notes/bookmark.js?v=__BUILD__";
import { initNotesCaretLine } from "./notes/caret-line.js?v=__BUILD__";
import { scheduleNotesCaretCheck } from "./notes/caret.js?v=__BUILD__";
import { closeNoteLinkPicker, commitNoteLinkPicker, isNoteLinkPickerOpen, moveNoteLinkPicker, updateNoteLinkPicker } from "./notes/link-picker.js?v=__BUILD__";
import { followNoteLink, revealNoteHeading } from "./notes/note-links.js?v=__BUILD__";
import { initNotesHeadOverflow } from "./notes/notes-head-overflow.js?v=__BUILD__";
import { commitNotesEditIfActive, enterNotesEditing, isNotesEditing, isProgrammaticNotesScroll, setNotesScrolledSource } from "./notes/notes-view.js?v=__BUILD__";
import { sourceFromRawEditor } from "./notes/notes-edit-split.js?v=__BUILD__";
import { initPagedNotes } from "./notes/paged-view.js?v=__BUILD__";
import { findRawOffsetForRenderedPoint } from "./notes/raw-offset.js?v=__BUILD__";
import { flushReadingPositionSave } from "./notes/reading-position.js?v=__BUILD__";
import { rawOffsetForCurrentNotesScroll, scheduleReadingAnchorCapture } from "./notes/scroll-anchor.js?v=__BUILD__";
import { beginSelectionGesture, currentNotesSelectionMarkdown, currentSelectionPlainText, endSelectionGesture, hideNotesSelectionButton, noteSelectionChanged, pillSelectionCapture, scheduleNotesSelectionCheck, setDocumentPillCaptureHook } from "./notes/selection.js?v=__BUILD__";
import { initTouchSelection } from "./notes/touch-selection.js?v=__BUILD__";
import { recordNotesTyping, redoNotes, undoNotes } from "./notes/notes-history.js?v=__BUILD__";
import { initMarkMenu } from "./notes/mark-menu.js?v=__BUILD__";
import { markDrawerHighlightsDirty, setDrawerRowJumpHook, setDrawerSideBySideHandler } from "./panels/drawer-highlights.js?v=__BUILD__";
import { cycleToLocator, initHighlightCycle, isHighlightSplitOpen, openHighlightSplit, refreshHighlightCycle, refreshHighlightSplitSpace, repaintHighlightLink, splitFollowsViewMode } from "./panels/highlight-cycle.js?v=__BUILD__";
import { setHighlightsChangedHandler } from "./format/highlight-edit.js?v=__BUILD__";
import { closeNotesToc, flashNotesHeading, initNotesTocFolding, isNotesTocOpen, notesTocHeadings, notesTocScrollFrame, scrollNotesEditToHeadingIndex, scrollNotesHeadingIntoView, setNotesTocScrollFrame, tocPushesNotes, toggleNotesToc, updateNotesTocActive } from "./notes/toc.js?v=__BUILD__";
import { closeClozePanel, openClozePanel, toggleClozePanelAll } from "./panels/cloze-panel.js?v=__BUILD__";
import { appInfoBtn, appInfoCheckBtn, appInfoCloseBtn, appInfoHealthBtn, appInfoModal, appInfoReloadBtn, closeAppInfoModal, forceRefreshAppInfo, openAppInfoModal, runProjectHealthCheck } from "./pwa/app-info.js?v=__BUILD__";
import { FOREGROUND_SYNC_IDLE_MS, lastHiddenAt, onlineReconcileTimer, setLastHiddenAt, setOnlineReconcileTimer, updateOnlineIndicator } from "./pwa/online.js?v=__BUILD__";
import { installManifestLink, registerServiceWorker } from "./pwa/service-worker-client.js?v=__BUILD__";
import { addQuickNoteCategory, assignQuickNoteCategory, closeQnCatMenu, closeQnCatModal, closeQuickNotesBoard, copyQuickNote, deleteQuickNoteCategory, jumpToQuickNoteSource, layoutQuickNotesGrid, openQnCatMenu, openQnCatModal, openQnRecolorMenu, openQuickNotesBoard, qnBoard, qnNewColor, renameQuickNoteCategory, renderQnColorPicker, renderQuickNotesBoard, saveQuickNote, setQnNewColor } from "./quick-notes/board.js?v=__BUILD__";
import { closeDiagramModal, zoomDiagramBy } from "./render/diagram-zoom.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "./render/tables.js?v=__BUILD__";
import { deckSnapshotCache, deckStoreChannel, deckStoreRequest, indexedDbUnavailable, pendingDeckWrites, scheduleDeckAutosave, setDeckStoreChannel, touchDeckSnapshotCache } from "./storage/deck-store.js?v=__BUILD__";
import { isQuotaExceededError } from "./storage/quota.js?v=__BUILD__";
import { closeStoragePanel, offloadStorageDocument, openStoragePanel, refreshStorageReport, runStorageAction } from "./storage/storage-panel.js?v=__BUILD__";
import { applyAutoSyncInterval, autoSyncTick, setAutoSyncMinutes } from "./sync/auto-sync.js?v=__BUILD__";
import { updateDeckEmptyStatus } from "./sync/indicator.js?v=__BUILD__";
import { showNotesConflictModal } from "./sync/notes-conflict.js?v=__BUILD__";
import { reconcileAllDecks } from "./sync/reconcile.js?v=__BUILD__";
import { closeTopmostOverlay, initBackGesture } from "./ui/back-gesture.js?v=__BUILD__";
import { showAuthenticatedUI, showLibraryFailedScreen, showLoginScreen, showSetupScreen } from "./ui/boot-screens.js?v=__BUILD__";
import { applyChromeCollapse, chromeMobileMedia, chromeScrollFrame, hasStudyTextSelection, initImmersiveMode, isFocusModeActive, isMobileChrome, measureChromeHeights, setChromeCollapseHandler, setChromeFocusPinned, setChromeModesHandler, setChromeScrollFrame, setFocusMode, toggleImmersiveMode, trackChromeScroll } from "./ui/chrome.js?v=__BUILD__";
import { captureDocumentSelection } from "./documents/pdf-selection.js?v=__BUILD__";
import { closeImportPanel, closeMyDecksPanel, editCurrentDeckCategory, editCurrentDeckTitle, openImportPanel, openMyDecksPanel } from "./ui/deck-header.js?v=__BUILD__";
import { addBlankCardAtCursor, flushWorkingDeck, toggleEditMode } from "./ui/edit-mode.js?v=__BUILD__";
import { setStatus, showConfirmModal, showToast } from "./ui/feedback.js?v=__BUILD__";
import { closeHelpModal, helpBtn, helpModal, helpModalCloseBtn, helpModalCloseFootBtn, openHelpModal } from "./ui/help.js?v=__BUILD__";
import { goNavBack } from "./ui/nav-history.js?v=__BUILD__";
import { anyModalOpen, lockPageScroll, unlockPageScroll } from "./ui/overlays.js?v=__BUILD__";
import { chooseDeckCategory } from "./ui/pickers.js?v=__BUILD__";
import { defaultStyleProfiles, styleDefaults } from "./ui/style-schema.js?v=__BUILD__";
import { applyStyleDensity, detectStyleProfile, handleStyleControlChange, normalizeStyleValue, resetStyleField, resetStyleProfile, trackKeyboardInset } from "./ui/style-settings.js?v=__BUILD__";
import { styleMobileMedia, styleProfiles } from "./ui/style-tokens.js?v=__BUILD__";
import { setTheme, setThemeMenuOpen } from "./ui/theme.js?v=__BUILD__";
import { FOCUS_MODE_KEY, closeViewExportMenu, paintViewExportMenu, setSplitViewHook, setViewMode } from "./ui/view-mode.js?v=__BUILD__";
import { initDocumentMarkMenu, repairDocumentHighlightQuads, repairDocumentHighlightText } from "./documents/pdf-highlights.js?v=__BUILD__";
import { closeDocumentToc, documentOutlineEntries, initDocumentOutlineFolding, isDocumentTocOpen, resolveOutlineEntryPage, toggleDocumentToc } from "./documents/pdf-outline.js?v=__BUILD__";
import { deleteRemoteDocument } from "./documents/pdf-store.js?v=__BUILD__";
import { currentPdfDocument, documentFittedWidth, fitDocumentToWidth, initDocumentPinchZoom, isDocumentFitWidth, reattachDocument, relayoutDocument, scheduleDocumentPositionSave, scrollToDocumentPage, setDocumentAttachHandler, setDocumentOpenedHook, setDocumentPagePaintedHook, togglePdfInvert, updatePageIndicator, zoomDocument } from "./documents/pdf-view.js?v=__BUILD__";
import { initDocumentRegionSelect, toggleRegionSelect } from "./documents/pdf-region.js?v=__BUILD__";
import { paintPageNoteBadges, paintPdfPageNotesButton, readPdfPageNotesPreference, refreshPdfPageNotes, repaintPdfPageNotes, setDocumentNoteRevealHook, setPdfPageNotesFlag, togglePdfPageNotes } from "./documents/pdf-page-notes.js?v=__BUILD__";
import { initReadingRail, refreshReadingRail, refreshReadingRailModes } from "./ui/reading-rail.js?v=__BUILD__";
import { attachPdfToOpenDeck, importPdfFile, reportPdfImportCrash } from "./import/pdf.js?v=__BUILD__";

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


// Before anything reads one of the vendored globals. Returns false only when
// markdown itself is unavailable, in which case it has already put a message on
// screen naming the file — and carrying on would mean a blank app instead.
const bootLibrariesPresent = assertBootLibraries();

// GUARDED, and the guard is the point. This is module-scope code in the entry
// module: an absent `marked` here was a ReferenceError that stopped the whole
// 140-module graph from evaluating, so registerServiceWorker() and bootApp() at
// the bottom of this file never ran and the page stayed blank forever — with no
// worker registered, which meant the next load failed exactly the same way.
if (typeof marked !== "undefined") {
  marked.setOptions({
    breaks: true,
    gfm: true,
    mangle: false,
    headerIds: false
  });
}


 // confident: this is what the block is
 // …and the winner must beat the runner-up by this
 // plausible: one signal, uncontested


 // enough signal; keeps long blocks cheap


// Vendored, like the core grammar. The autoloader injects a <script> for a
// language the first time a code block uses it, so pointing this at the CDN
// meant syntax highlighting silently reached the network mid-render — and got
// nothing offline. tools/vendor-sync.mjs keeps this directory populated.
if (window.Prism?.plugins?.autoloader) {
  Prism.plugins.autoloader.languages_path = "vendor/prismjs-1.30.0/components/";
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


el.editNotesBtn?.addEventListener("click", () => {
  if (isNotesEditing()) commitNotesEditIfActive();
  else enterNotesEditing(rawOffsetForCurrentNotesScroll());
});

el.bookmarkSetBtn?.addEventListener("click", () => bookmarkCurrentSpot());
el.bookmarkGoBtn?.addEventListener("click", () => goToBookmark());

el.notesEdit?.addEventListener("input", () => {
  // Through sourceFromRawEditor, never straight across. The textarea holds the
  // note's BODY — the highlight-notes block is sliced off it when the editor
  // opens (see src/notes/notes-edit-split.js) — so a bare assignment here would
  // delete every highlight note in the deck on the first keystroke.
  state.notes = sourceFromRawEditor(el.notesEdit.value);
  // Before anything else reacts to the new text. recordNotesTyping is told what
  // the note BECAME; it keeps the previous value itself, because a keystroke can
  // only ever report the result. Consecutive keystrokes coalesce into one undo
  // step, and an action that already pushed its own snapshot is not folded in.
  recordNotesTyping(state.notes);
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

// ...and the Document surface's counterpart. Its own key, deliberately: whether
// a reader wants a paper's annotations printed under its pages is a different
// question from whether they want a note's printed in its paragraphs, and one
// preference answering both would get one of them wrong.
setPdfPageNotesFlag(readPdfPageNotesPreference());

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
  // The ROW, matching what readChromeHeights measures. The row also holds the
  // TOC button, the edit pill and the ⋯ menu, and those show and hide per view
  // WITHOUT resizing the tabs inside — so observing only the toggle left
  // --view-toggle-h stale, and .view-mode-row's `max-height: var(--view-toggle-h)`
  // then clipped its own contents.
  const viewModeRow = document.getElementById("viewModeRow");
  if (viewModeRow) chromeSizeObserver.observe(viewModeRow);
  else if (el.viewModeToggle) chromeSizeObserver.observe(el.viewModeToggle);
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
    // isFocusModeActive, not chromeFocusPinned: once a scroll down has locked
    // the chrome away there is nothing further for this listener to decide, and
    // a reader who spends the next twenty minutes scrolling should not pay a
    // closest() walk and a rAF per frame to be told so. Both ways out of the
    // mode reset the anchor (setFocusMode, resetChromeAutoHide), so the next
    // scroll after one re-anchors from wherever the reader actually is.
    if (isFocusModeActive() || !isMobileChrome()) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".study-layout")) return;
    setChromeScrollFrame(requestAnimationFrame(() => {
      setChromeScrollFrame(0);
      trackChromeScroll(target);
    }));
  },
  true,
);


el.focusModeBtn?.addEventListener("click", () => setFocusMode(!isFocusModeActive()));

// A click, not a pointerdown: requestFullscreen needs a user gesture and a
// click IS one, while none of the pill's "don't destroy the selection" reasons
// apply to a button in the ⋯ menu.
el.immersiveModeBtn?.addEventListener("click", () => toggleImmersiveMode());
initImmersiveMode();

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
    // The flash waits for the jump: on a viewport-built note the heading's
    // element does not exist until scrollNotesHeadingIntoView has built its
    // span, so flashing first would flash nothing.
    Promise.resolve(scrollNotesHeadingIntoView(heading)).then(() => flashNotesHeading(heading));
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

// noteSelectionChanged first, and NOT inside the debounce: it stamps the "still
// moving" clock and frees the containment under the selection, both of which
// have to be in place before the next drag frame. scheduleNotesSelectionCheck is
// the thing being deferred; this is the thing that decides how long for.
document.addEventListener("selectionchange", () => {
  noteSelectionChanged();
  scheduleNotesSelectionCheck();
});

// ── The selection GESTURE, so the pill can wait for it to finish ───────────
//
// Registered on the document with capture, because a drag routinely leaves the
// element it started in (that is what auto-scrolling to extend a selection IS),
// and pointercancel is as much an ending as pointerup — a touch taken over by
// the scroller never sends pointerup at all, and without it the pill would stay
// suppressed until the next gesture.
//
// A press on the pill itself is not a selection gesture: those handlers
// preventDefault precisely so the selection survives, and treating one as the
// start of a drag would hide the bar the user is reaching for.
document.addEventListener("pointerdown", (event) => {
  if (event.target?.closest?.(".selection-float")) return;
  beginSelectionGesture();
}, { capture: true, passive: true });

["pointerup", "pointercancel"].forEach((type) => {
  document.addEventListener(type, endSelectionGesture, { capture: true, passive: true });
});

// A drag released outside the window never delivers pointerup to the document.
window.addEventListener("blur", endSelectionGesture);

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

// Every button on the floating pill preventDefaults its own pointerdown, for
// the reason each of them repeats below: reading the selection is the whole
// point, and letting the press through dissolves it. The pill ITSELF did not —
// so a press that landed on its padding, on a gap between two buttons, or on
// the colour menu's own chrome went through to the notes underneath, dropped a
// caret there, and threw away the selection the pill was floating there to act
// on. Measured: pressing 4px inside the pill's corner replaced a 280-character
// selection with a different 54-character one.
//
// preventDefault only, and no stopPropagation: the buttons stop the event
// themselves, so this listener never runs for them — it exists purely for the
// gaps between them, and must not get in the way of anything reaching them.
//
// BOTH events, and mousedown is the one that does the work. Cancelling
// pointerdown does not stop Chrome placing a caret and dropping the selection
// (measured: the pill still ate a live selection with a pointerdown-only
// guard) — that default belongs to mousedown. pointerdown is kept for the
// touch path, where the compatibility mousedown arrives late or not at all.
["pointerdown", "mousedown"].forEach((type) => {
  el.selectionFloat?.addEventListener(type, (event) => {
    event.preventDefault();
  });
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


// The ⋯ disclosure that used to reveal the formatting row on the bottom-pinned
// phone bar is gone, and with it this handler. It was shown ONLY on a phone —
// so the one place with the least room to spare was the one place where bold
// cost two taps and the second one had to land on a 34px target that had just
// appeared. The bar carries all five groups at every width now; see the
// .sel-group wrappers in index.html.


el.extractNoteFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  // pointerdown, not click: a click would have already destroyed the selection
  // this reads. Same reason as every other button in this strip.
  event.preventDefault();
  event.stopPropagation();
  extractSelectionToNote();
});

// ── The three that replace the platform's own selection bar ────────────────
//
// src/notes/touch-selection.js suppresses Android's long-press-to-select
// outright, and with it the Copy / Share / Select all / Web search bar that
// used to come with it. Taking the gesture over without offering these back
// would mean a phone reader could no longer copy a sentence out of a note —
// a straight regression, and the reason they live here rather than being left
// for later.
//
// All three read PLAIN TEXT (currentSelectionPlainText), not the markdown every
// other button in this strip works from: a web search for `**bold**` finds
// nothing, and nobody shares a sentence wanting the asterisks. Each takes the
// same pointerdown + preventDefault as its neighbours, for the same reason —
// letting the press through would dissolve the selection being acted on.
el.copySelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const text = currentSelectionPlainText();
  if (!text) {
    showToast("Select some text first, then tap copy.", "error");
    return;
  }
  // The async clipboard API needs a secure context and a user gesture; this IS
  // the gesture, but a file:// open or an insecure LAN host is not a secure
  // context, and that is a normal way to run this app. execCommand("copy") is
  // deprecated and still the only thing that works there.
  const fallback = () => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(scratch);
    scratch.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    scratch.remove();
    showToast(ok ? "Copied" : "Couldn't copy — your browser refused clipboard access.", ok ? "success" : "error");
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast("Copied"), fallback);
  } else {
    fallback();
  }
  hideNotesSelectionButton();
});

el.shareSelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const text = currentSelectionPlainText();
  if (!text) {
    showToast("Select some text first, then tap share.", "error");
    return;
  }
  // AbortError is the reader dismissing the share sheet, which is not a failure
  // and must not raise a toast saying it was.
  navigator.share?.({ text }).catch((error) => {
    if (error?.name !== "AbortError") showToast("Couldn't open the share sheet.", "error");
  });
  hideNotesSelectionButton();
});

el.searchSelectionBtn?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const text = currentSelectionPlainText();
  if (!text) {
    showToast("Select some text first, then tap search.", "error");
    return;
  }
  // Capped: a search URL carrying a whole selected page is rejected by every
  // engine and by most proxies before it gets there.
  const query = encodeURIComponent(text.slice(0, 512));
  window.open(`https://www.google.com/search?q=${query}`, "_blank", "noopener");
  hideNotesSelectionButton();
});

// A button that cannot do anything is worse than an absent one, and there is no
// polyfill for a share sheet. Removed rather than hidden so nothing — the
// formatting row's overflow arithmetic, a screen reader, the phone bar's
// wrap — has to know about a permanently invisible child.
if (!navigator.share) el.shareSelectionBtn?.remove();

// ── The touch selection controller ─────────────────────────────────────────
//
// Armed only on a real touchscreen whose PRIMARY pointer is a finger, and only
// where the CSS Custom Highlight API exists to paint what it takes over — see
// canTouchSelect(). On every other machine this call binds nothing, adds no
// class, and leaves the native path and styles/31-touch-selection.css exactly as
// they were. Called unconditionally all the same: the gate is re-evaluated on
// the media query's own `change` event, so a tablet that gains or loses a mouse
// switches paths without a reload.
initTouchSelection();

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

// After initRenderToolbars, which fills the selection pill's format slot: the
// overflow menu records what it is moving, and both want the markup settled.
onDomReady(initNotesHeadOverflow);
onDomReady(initNotesTocFolding);
onDomReady(initPagedNotes);
onDomReady(initNotesCaretLine);
onDomReady(initMarkMenu);
onDomReady(initDocumentMarkMenu);
onDomReady(initDocumentPinchZoom);
onDomReady(initDocumentRegionSelect);
onDomReady(() => {
  initReadingRail();
  // Two things care that the chrome just folded or unfolded, and only one of
  // them can hold the single handler slot — so this file, which knows both,
  // calls both. The second is the side-by-side pane: on a phone its two halves
  // are LENGTHS measured from where the reading stage starts (see
  // applyStackedSpace), and folding the appbar and the tabs row moves that by
  // ~130px without firing a resize. Left un-remeasured the halves stayed sized
  // for the old layout, so the panel and the screen disagreed about how much
  // room there was and the page scrolled past it into blank.
  setChromeCollapseHandler(() => {
    refreshReadingRail();
    refreshHighlightSplitSpace();
  });
  // The rail's Focus mode and Full screen rows are copies that read their state
  // back off the original buttons, so they have to be told when a mode changes
  // by some route other than pressing them: Ctrl+. , Ctrl+Q, Escape, the phone's
  // Back key, or the browser's own F11. Registered rather than imported for the
  // reason the collapse handler above is — src/ui/chrome.js sits low in the
  // import graph and the rail sits high; this file is the one that knows both.
  setChromeModesHandler(refreshReadingRailModes);
});
// The pill's Highlight and ✕ need a description of the PDF selection taken
// while it is still alive, and src/notes/selection.js cannot import the module
// that makes one without closing an import cycle it documents at length. Same
// registration idiom as the two hooks above.
onDomReady(() => setDocumentPillCaptureHook(captureDocumentSelection));
// Pressing the number on an annotated highlight opens that note.
//
// Registered rather than imported for the reason setHighlightBadgeHandler's own
// comment gives: the badge module runs inside the render pipeline, and both
// halves of this call — the mark-ordinal lookup in notes/anchors.js and the
// popup in notes/highlight-note-editor.js — reach back into that pipeline. This
// file already knows both ends, which is what makes it the place to join them.
//
// The ordinal, not the DOM position: on a note built lazily chunk by chunk the
// two are different numbers, and sourceMarkIndexFor is what maps between them.
onDomReady(() => setHighlightBadgeHandler((mark, rect, noteText) => {
  const index = sourceMarkIndexFor(el.notesView, mark);
  if (index < 0) return;
  // The pane first, when there is one: the note this badge names is already on
  // screen there, and revealing it beats covering the note with a window
  // showing what is beside it. cycleToLocator says whether it could — false
  // means the pane is closed, is beside the paper rather than this note, or does
  // not list this highlight — and the popup is the answer for all three.
  //
  // markCount is what revealNoteMark tests before it will trust an ordinal, and
  // the pane's own entries carry it; here the ordinal is already resolved
  // against the DOM, so the locator needs only the index.
  if (cycleToLocator({ markIndex: index })) return;
  openHighlightNoteEditor(index, rect, noteText);
}));
// ── Side by side ────────────────────────────────────────────────────────────
//
// Three ends wired here because none of the three modules may import another:
// src/panels/drawer-highlights.js is reached from the document surface, and
// src/ui/view-mode.js is on the far side of the anchors cycle. main.js is the
// file that knows all of them — the same arrangement setHighlightsChangedHandler
// and setDocumentAttachHandler already use.
onDomReady(() => {
  initHighlightCycle();
  // The drawer's "Side by side" button, in whichever of the two drawers it was
  // pressed in.
  setDrawerSideBySideHandler((surface) => openHighlightSplit(surface));
  // ...and a press on one of that drawer's rows, so an open split follows it
  // rather than showing a different highlight from the one just jumped to.
  setDrawerRowJumpHook((locator) => cycleToLocator(locator));
  // ...and a press on a numbered badge on a page, or on one of the notes printed
  // under it. Same question, same answer: show it here rather than in a window
  // over the page, whenever there is a here to show it in.
  setDocumentNoteRevealHook((locator) => cycleToLocator(locator));
  // Leaving for Cards or the Highlights tab closes the split; moving between
  // Notes and Document moves it.
  setSplitViewHook((next) => splitFollowsViewMode(next));
});
// The badges are painted with each page as it renders, and the printed notes are
// rebuilt when a document opens — see the note on setDocumentPagePaintedHook for
// why these are registered rather than imported.
onDomReady(() => {
  // Two things happen as a page paints, in this order and for this reason.
  //
  // repairDocumentHighlightText re-reads the words of any highlight on the page
  // that was stored before the text layer had separators in it (see its own
  // comment) — so the badge, and everything else that names a highlight, is
  // built from the corrected text rather than showing the welded version for one
  // frame and then changing under the reader.
  //
  // repairDocumentHighlightQuads is the same idea about the highlight's
  // GEOMETRY: a quad captured before the text layer knew about font ascents
  // sits a fifth of an em above the words it marks. It repaints the page's
  // marks itself, so it has to run before the badges below, which are pinned to
  // the corner of a quad and would otherwise be placed against the old one.
  setDocumentPagePaintedHook((pageNumber) => {
    repairDocumentHighlightText(pageNumber);
    repairDocumentHighlightQuads(pageNumber);
    paintPageNoteBadges(pageNumber);
    // ...and the tint that says which of these marks the pane is currently on.
    // The mark layer was rebuilt from scratch a moment ago — paintDocument
    // Highlights empties it — so the class went with the elements that carried
    // it, and only the pane knows which ones should have it back.
    repaintHighlightLink();
  });
  setDocumentOpenedHook(refreshPdfPageNotes);
});
// So an edit made on a mark in the note refreshes the highlights pane, without
// highlight-edit.js having to import the panel that owns it.
// Three surfaces answer to a highlight changing. The pane is the obvious
// consumer; the PDF's note badges and printed notes are the second, because
// adding or deleting a note renumbers every note after it. Registered here
// rather than imported into src/documents/pdf-highlights.js, which
// pdf-page-notes.js already imports — this file is the one that knows both ends
// (the same reason setDocumentPagePaintedHook exists below).
onDomReady(() => setHighlightsChangedHandler(() => {
  // Only when the pane is actually on screen. It is the one container the cards
  // are ever built into now, and building several hundred of them into a hidden
  // box for nobody is the cost this guard exists to refuse.
  if (isHighlightSplitOpen()) refreshHighlightCycle();
  repaintPdfPageNotes();
  // ...and the number on a <mark> in the note, which is the same fact on the
  // other reading surface and had nothing painting it.
  //
  // refreshHighlightBadges' only caller was renderNotesView, and every in-place
  // note editor writes with { rerender: false } precisely so that a book is not
  // repainted between keystrokes — so a note written beside the highlight it is
  // about never made its badge appear. Leaving the view and coming back did,
  // because that is a render. That is "I have to juggle to some other panel,
  // then only the numbering appears".
  //
  // Free when nothing moved: the pass returns on its own signature unless a
  // note's NUMBER or TEXT actually changed, which is the only time there is
  // anything to redo.
  refreshHighlightBadges();
  // ...and the two drawers, which are the third consumer. Marked stale rather
  // than rebuilt: both are closed almost all of the time, and rebuilding a
  // book's worth of rows for a drawer nobody is looking at is the cost this
  // whole feature was written to avoid.
  markDrawerHighlightsDirty();
}));


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

// The standing signed-out chip (see setSignedOutChip). Boot no longer answers
// an unconfirmed session by showing the login form, so this is the deliberate
// way to it — the user asks for the sign-in when they want syncing back,
// instead of being asked for a password to read decks already on the device.
document.getElementById("signedOutIndicator")?.addEventListener("click", () => {
  showLoginScreen();
});


// ---------------------------------------------------------------------------
// Two-way cloud mirror (last-write-wins per deck, by `updated_at` timestamp).
// The device keeps a full local copy of every cloud deck so the PWA works
// offline; when connectivity returns each deck is reconciled by comparing the
// local library's `updatedAt` against the cloud's `updated_at`.
// ---------------------------------------------------------------------------


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

// Signing out takes the decks off the device with it.
//
// The library is a mirror of ONE account's cloud data, and leaving it behind
// on sign-out left that account's entire contents readable by whoever used the
// browser next — the decks stayed in My Decks and opened normally, because
// every read is local. (The account switch already wiped it; the sign-out that
// wasn't followed by another sign-in did not.)
//
// Confirmed, never silent, and the count is in the question: a deck that never
// reached the cloud has no other copy, and "your decks are safe on this
// device" is a promise this app makes everywhere else. Which is also why the
// never-synced ones are called out separately — those are the only decks this
// can actually cost, and the user is the only one who can weigh that.
document.getElementById("logoutBtn")?.addEventListener("click", () => {
  const index = readLocalDeckIndex();
  const total = index.length;
  const localOnly = index.filter((meta) => !meta.deckId || !meta.lastSyncedAt).length;

  const signOutAndWipe = async () => {
    // Sign out FIRST. It flips isSignedIn, which is what every sync entry point
    // gates on — wiping while a reconcile could still start would have it read
    // an empty library against a full cloud and spend the next few minutes
    // downloading everything back.
    await handleLogout();
    try {
      await resetLocalLibrary();
      showToast(total ? `Signed out — ${total} deck${total === 1 ? "" : "s"} removed from this device` : "Signed out", "success");
    } catch (error) {
      console.warn("Could not clear the local deck library on sign-out", error);
      showToast("Signed out, but the decks on this device could not be removed", "error");
    }
  };

  if (!total) return void signOutAndWipe();

  showConfirmModal(
    // One paragraph, no newlines: .confirm-modal-message renders with textContent
    // and the default white-space, so a "\n\n" here would collapse to a space.
    `Sign out and remove all ${total} deck${total === 1 ? "" : "s"} from this device? `
    + "Everything already synced stays in your Supabase project and comes back when you sign in again."
    + (localOnly
      ? ` But ${localOnly} deck${localOnly === 1 ? " has" : "s have"} never synced — `
        + `${localOnly === 1 ? "it exists" : "they exist"} only on this device and will be gone for good. `
        + "Cancel and use My Decks → ⋯ → Backup first if you need them."
      : ""),
    () => { signOutAndWipe(); },
    { confirmLabel: "Sign out & delete", danger: true }
  );
});

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

// One deck per paper, so several papers picked at once is several decks —
// sequentially, because each one uploads and each upload wants the connection
// to itself.
el.myDecksImportPdfInput?.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = ""; // allow re-importing the same file again
  for (const file of files) {
    await importPdfFile(file).catch(reportPdfImportCrash);
  }
});
document.getElementById("myDecksImportPdfBtn")?.addEventListener("click", () => closeMyDecksMoreMenu());

// The same file, onto the deck already open, for a deck that was created without
// a PDF. Not an import: nothing about the deck's title, category, cards or notes
// body is touched — see attachPdfToOpenDeck.
el.attachPdfInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0] || null;
  event.target.value = ""; // allow picking the same file again after a failure
  if (!file) return;
  closeMainMenu();
  await attachPdfToOpenDeck(file).catch(reportPdfImportCrash);
});

// ...and the same function again, for the Document panel's own attach card —
// which is now the route a reader is most likely to find, the drawer row above
// being the one you have to be told about. Registered rather than imported,
// because src/import/pdf.js already imports openDocumentView from
// src/documents/pdf-view.js and the reverse edge would close that cycle; this
// file is the one that knows both ends. Same crash reporter, so a malformed PDF
// says the same thing whichever route picked it.
setDocumentAttachHandler((file) => attachPdfToOpenDeck(file).catch(reportPdfImportCrash));

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


el.myDecksSearch?.addEventListener("input", (e) => {
  const value = e.target.value;
  clearTimeout(myDecksSearchTimer);
  setMyDecksSearchTimer(setTimeout(() => { state.myDecksSearch = value; repaintMyDecks(); }, 160));
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

  document.getElementById("myDecksCheckImagesBtn")?.addEventListener("click", () => {
    closeMyDecksMoreMenu();
    runBrokenImageScan();
  });
}
el.styleBtn.addEventListener("click", openStylePanel);
el.closeStyleBtn.addEventListener("click", closeStylePanel);
el.storageBtn?.addEventListener("click", openStoragePanel);
el.closeStorageBtn?.addEventListener("click", closeStoragePanel);
el.storageRefreshBtn?.addEventListener("click", () => refreshStorageReport());
el.storageBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-storage-action]");
  if (button && !button.disabled) runStorageAction(button.dataset.storageAction);
  // Per-document offload — one row's own button rather than a panel-wide
  // action, because the whole point is choosing WHICH paper to let go of.
  const offload = event.target.closest("[data-storage-offload]");
  if (offload && !offload.disabled) offloadStorageDocument(offload.dataset.storageOffload);
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
  setQnNewColor(swatch.dataset.qnNewColor);
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
const openExportHighlightsModal = () => {
  if (!el.exportHighlightsModal) return;
  el.exportHighlightsModal.hidden = false;
  lockPageScroll();
};
el.drawerExportHighlightsBtn?.addEventListener("click", openExportHighlightsModal);
// The same dialog from the side-by-side pane's own header, which is the only
// place a reader working through a PDF's highlights can reach it without
// leaving the paper — the drawer's row is on the notes side of the ☰ menu.
el.highlightCycleExportBtn?.addEventListener("click", openExportHighlightsModal);

// ── The export button beside the tabs ────────────────────────────────────
//
// It means "export what I am looking at", so its rows come from the view
// (paintViewExportMenu, src/ui/view-mode.js) and every one of them dispatches
// into an export that already existed — the three drawer entries above, the
// highlights dialog, and the Document surface's own three.
el.viewExportBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!el.viewExportMenu) return;
  const open = el.viewExportMenu.hidden;
  // Rebuilt on open as well as on every setViewMode: a deck loaded while the
  // menu has never been opened has never had it painted.
  if (open) paintViewExportMenu();
  el.viewExportMenu.hidden = !open;
  el.viewExportBtn.setAttribute("aria-expanded", String(open));
});

document.addEventListener("pointerdown", (event) => {
  if (!el.viewExportMenu || el.viewExportMenu.hidden) return;
  if (event.target.closest("#viewExportMenu, #viewExportBtn")) return;
  closeViewExportMenu();
}, { capture: true, passive: true });

el.viewExportMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view-export]");
  if (!button) return;
  closeViewExportMenu();
  const action = button.dataset.viewExport;
  // "surface:format". A bare format is the cards menu, which is the one that
  // also carries a scope — always "all" from here; the drawer's own menu is
  // still where a known/review/uncategorized scope is chosen.
  const [surface, format] = action.includes(":") ? action.split(":") : ["cards", action];
  if (surface === "cards") handleExportAction(format, "all");
  else if (surface === "notes") handleExportNotesAction(format);
  else if (surface === "doc") handleExportDocumentAction(format);
});
el.exportHighlightsCancelBtn?.addEventListener("click", () => {
  if (!el.exportHighlightsModal) return;
  el.exportHighlightsModal.hidden = true;
  unlockPageScroll();
});
el.exportHighlightsModal?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-export-highlights]");
  if (!button) return;
  const options = {
    contextLines: Math.max(0, Number(el.exportHighlightsContext?.value) || 0),
    includeChapter: el.exportHighlightsChapterToggle?.checked !== false,
    includeNotes: el.exportHighlightsNotesToggle?.checked !== false
  };
  unlockPageScroll();
  handleExportHighlightsAction(button.dataset.exportHighlights, options);
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
  // An editor that owns a key stops the event on its own element, so nothing
  // below should ever see one — installMarkdownKeys does exactly that for the
  // note popup and the Highlights tab's in-place editor. This is the guard
  // against the next surface someone adds and forgets: the handler below
  // catches Ctrl+E wherever it lands, deliberately, which is how it came to
  // flip the notes view behind a popup somebody was typing into.
  if (event.target.closest?.(".highlight-note-editor, .hl-note")) return;
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
  // ── Notes undo/redo ──────────────────────────────────────────────────────
  //
  // Checked BEFORE the card stack and before the textarea guard below, and that
  // reverses a deliberate old decision: those guards exist because "notes
  // textareas already get native per-keystroke undo from the browser". They do
  // not. Every toolbar action, every pill button, every pasted image, every
  // cloze and every highlight writes `textarea.value = …`, and a programmatic
  // value assignment DISCARDS the element's undo transaction — so from the
  // first time you used any feature of the editor, Ctrl+Z could not step back
  // past it. In the rendered view, where highlights are actually made,
  // `state.notes` is mutated directly and there was never any undo at all.
  //
  // Scoped to the notes surface: a card face or any other input keeps the
  // browser's own undo, which for plain typing is finer-grained than this.
  const inNotesSurface = state.viewMode === "notes"
    && (event.target === el.notesEdit || !event.target.matches("input, textarea"));
  if ((event.ctrlKey || event.metaKey) && inNotesSurface && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    event.shiftKey ? redoNotes() : undoNotes();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && inNotesSurface && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    redoNotes();
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
    setFocusMode(!isFocusModeActive());
    return;
  }
  // Ctrl/Cmd+Q: the same idea one step further — the app's chrome AND the
  // browser's, through the Fullscreen API (see setImmersiveMode). Sits here for
  // the same two reasons Ctrl+. does.
  //
  // Reached from a real keypress, so the user-gesture requirement on
  // requestFullscreen is satisfied. Note that Chrome on Linux and macOS bind
  // this to quitting the browser at a level preventDefault cannot always reach;
  // ⛶ in the notes ⋯ menu is the way in where that happens.
  if ((event.ctrlKey || event.metaKey) && (event.key === "q" || event.key === "Q")) {
    event.preventDefault();
    toggleImmersiveMode();
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

// The width a table fit was last computed against. A table is fitted to the
// width it has to fit in, and nothing else — so a resize that did not change
// the width has nothing to redo. That matters because on a phone `resize` is
// mostly the keyboard and the URL bar changing the HEIGHT, and a refit walks
// every table in the note (re-wrapping, re-labelling and re-columning each one)
// before it even gets to the binary search for a font size.
let lastTableFitWidth = window.innerWidth;

window.addEventListener("resize", () => {
  if (window.innerWidth !== lastTableFitWidth) {
    lastTableFitWidth = window.innerWidth;
    scheduleMarkdownTableFit();
  }
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

// The service worker is registered above regardless, and deliberately: if a
// library really is missing, the single most useful thing this load can do is
// leave behind a worker that has precached the whole app, so the NEXT load
// works. Only the app itself is held back, and only when markdown — which
// every view in Recall goes through — could not be loaded at all.
if (bootLibrariesPresent) bootApp();
else console.error("Boot halted: the markdown libraries are unavailable. See the message on screen.");


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
  // Before flushWorkingDeck, which builds the deck snapshot the anchor rides
  // in: this is a synchronous localStorage write and it is the copy that
  // survives an OS killing a backgrounded phone app mid-IndexedDB-write.
  flushReadingPositionSave();
  flushWorkingDeck();
  // A sync in progress holds the deck index in memory between checkpoints (see
  // beginIndexBatch), so a tab that goes away mid-sync would leave the last few
  // pulled decks with a snapshot in IndexedDB and no index entry naming it —
  // which the next boot's orphan sweep would then throw away. Backgrounding a
  // phone mid-sync is the ordinary way that happens, and this is the moment to
  // close it. Nothing to do when no batch is open.
  try { flushIndexBatch(); } catch (error) { console.warn("Could not flush the deck index", error); }
  // Blob URLs for still-queued images are per-document; releasing them here
  // keeps a long-lived PWA session from accumulating them across navigations.
  revokeLocalImageUrls();
});


document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    setLastHiddenAt(Date.now());
    flushReadingPositionSave();
    flushWorkingDeck();
    // Same reason as the pagehide handler above; on mobile this is the event
    // that actually fires when the app is swiped away.
    try { flushIndexBatch(); } catch (error) { console.warn("Could not flush the deck index", error); }
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

// ── Pictures that were rendered before this device could sign for them ──────
//
// The images bucket is private, so an <img> needs a signed URL, and a signature
// needs a session. bootApp deliberately opens this device's own decks BEFORE
// the session is confirmed (a lapsed token must not be a blank page), so the
// render tail can run with nothing signable — and every image in the note is
// left holding the canonical URL, which the bucket answers 400 to.
//
// On the device that uploaded a picture this is invisible: its bytes are in the
// worker's image cache under exactly that canonical URL. On every other device
// it was the whole bug — a deck arrived by sync, none of its images had ever
// been fetched here, and all of them came up as broken-image placeholders that
// nothing ever revisited.
//
// So the moment the answer lands, ask again. Also on `online`, which covers the
// device that booted with no connection at all. Both are cheap when there is
// nothing waiting: one querySelectorAll that matches nothing.
async function resolveImagesAwaitingSignature() {
  try {
    const retried = await resolveUnresolvedStorageImages(document);
    if (retried.length) await markBrokenImages(retried);
  } catch (error) {
    console.warn("Could not re-resolve images waiting on a signature", error);
  }
}

onSigningReadyChange(() => { resolveImagesAwaitingSignature(); });
window.addEventListener("online", () => { resolveImagesAwaitingSignature(); });
// ...and once now. bootApp() is started higher up this file, and two of its
// paths settle the session question synchronously — before this line has run
// and there is a listener to hear it. Costs one querySelectorAll that normally
// matches nothing, and removes the dependency on where in the file this sits.
resolveImagesAwaitingSignature();


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

  // Image(s) on the clipboard (a screenshot, a copied image, or a multi-file
  // copy out of a folder) → ask how to compress them, then upload to Supabase
  // Storage and insert the markdown.
  const imageFiles = allImageFiles(clipboardData);
  if (imageFiles.length) {
    event.preventDefault();
    // Read the caret and the clipboard's GIF hint synchronously: the event's
    // clipboardData is unreadable once the handler returns, and resolving a GIF
    // is async, so both have to be captured before awaiting anything.
    const atPos = target.selectionStart;
    const gifUrl = imageFiles.length === 1 && imageFiles[0].type !== "image/gif" ? gifSourceUrlFromTransfer(clipboardData) : null;
    insertTransferImages(target, imageFiles, gifUrl, atPos);
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
  const imageFiles = allImageFiles(event.dataTransfer);
  if (imageFiles.length) {
    // Same GIF-flattening problem as paste: dragging an animated GIF out of a
    // page hands over a still, with the original's URL alongside it. Only a
    // single dragged image can carry that hint — a multi-file drop is files
    // from a folder, which arrive whole.
    const gifUrl = imageFiles.length === 1 && imageFiles[0].type !== "image/gif" ? gifSourceUrlFromTransfer(event.dataTransfer) : null;
    insertTransferImages(event.target, imageFiles, gifUrl, event.target.selectionStart);
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


el.clozeReviewBtn?.addEventListener("click", openClozePanel);
el.closeClozeBtn?.addEventListener("click", closeClozePanel);
el.clozeBulkBtn?.addEventListener("click", toggleClozePanelAll);
el.clozePanel?.addEventListener("click", (e) => {
  if (e.target === el.clozePanel) closeClozePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el.clozePanel && !el.clozePanel.hidden) closeClozePanel();
});

 // textarea -> force a resync now


// One shared resize handler re-syncs every highlight backdrop still in the DOM.
// (A per-textarea window listener would leak: the All Cards panel recreates its
// editor textareas on every render, and each captured listener would pin the
// detached DOM subtree in memory forever.)
window.addEventListener("resize", () => {
  // By class, then down. `.highlight-textarea-wrapper > textarea` is a child
  // combinator, which no engine can answer from a class index — so it was a
  // full CSS match over the document, and on a phone `resize` fires every time
  // the keyboard or the URL bar moves. The two-step form is a class lookup
  // (indexed) plus a query inside a handful of small boxes.
  document.querySelectorAll(".highlight-textarea-wrapper").forEach((wrapper) => {
    const textarea = wrapper.querySelector("textarea");
    const backdrop = wrapper.querySelector(".highlight-textarea-backdrop");
    if (!textarea || !backdrop) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  });
});


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
    closeAllEditToolbarDropdowns();
    // Toggle current
    if (!wasOpen) {
      dropdown.classList.add("is-open");
    }
    return;
  }

  // Close dropdowns if clicked anywhere else. Scoped to the three toolbars
  // rather than swept out of the document — see closeAllEditToolbarDropdowns:
  // this branch runs on every click in the app, and the sweep it replaces was
  // a full-document CSS match with a book-sized note in the way of it.
  if (!e.target.closest(".edit-toolbar .toolbar-dropdown-content")) {
    closeAllEditToolbarDropdowns();
  }
});


// ── Quick Notes: glanceable, subject-categorised board ───────────
// The quick_notes deck is special: rather than a known/unknown study deck it's
// a place to skim pinned snippets across all decks at a glance, sorted into
// user-defined subject categories. Everything below powers that treatment.


// ── Quick-note source anchors ────────────────────────────────────
// A pin's noteAnchor (where it was pinned FROM) used to live only in the local
// deck snapshot, and appendCardToLocalLibraryDeck drops it entirely when this
// device has no local copy of the quick_notes deck — the normal case, since you
// pin from OTHER decks. That's why source buttons went missing. Anchors now
// live in the quick_notes deck's `meta.noteAnchors` bag ({ [cardId]: anchor }),
// so they're cloud-synced and survive on every device. No migration needed:
// decks.meta already exists.


// ── Recovering lost source links ─────────────────────────────────
// Notes pinned before anchors were stored have no anchor anywhere, so there is
// nothing to restore — but the note's TEXT was copied out of some deck's notes,
// so the origin can be found by searching for it. Every hit is persisted as a
// real anchor, so this search runs once per note and the button is permanent
// from then on. Same idea as resolveCardNoteAnchor's content fallback.


{
  const menuBtn = document.getElementById("mobileMenuBtn");
  const toolbar = document.getElementById("mainToolbar");
  const backdrop = document.getElementById("mobileBackdrop");
  const closeBtn = document.getElementById("toolbarCloseBtn");

  if (menuBtn && toolbar && backdrop) {
    // lockPageScroll(), not `document.body.style.overflow = "hidden"`.
    //
    // The hand-rolled write is what every other overlay in the app already had
    // a shared helper for, and it was the most expensive thing the ☰ button
    // did. body's overflow PROPAGATES to the viewport (styles/01-tokens.css:373
    // sets only overflow-x, so overflow-y is visible and <html> is still the
    // scrolling box), so writing it changes what the viewport scrolls and the
    // browser re-lays out the document to find out. Measured on a 2.5MB book at
    // a 6x CPU throttle: ~75ms on open and ~75ms again on close, against 0-3ms
    // for the class flip that actually moves the drawer.
    //
    // The shared helper now asks whether the page can scroll at all before
    // touching anything (see pageCanScroll), and on this app shell it cannot —
    // so the common case costs nothing, and the rare case where the reader has
    // made the shell taller than the screen gets the same lock every other
    // overlay uses instead of a weaker one that only this button knew about.
    const openMenu = () => {
      toolbar.classList.add("mobile-open");
      backdrop.classList.add("is-open");
      backdrop.hidden = false;
      menuBtn.setAttribute("aria-expanded", "true");
      lockPageScroll();
    };

    const closeMenu = () => {
      toolbar.classList.remove("mobile-open");
      backdrop.classList.remove("is-open");
      backdrop.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
      unlockPageScroll();
    };

    setIsMainMenuOpen(() => toolbar.classList.contains("mobile-open"));
    setCloseMainMenu(closeMenu);

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

// ── The Document surface's own controls ─────────────────────────────────────
//
// Wired here rather than inside src/documents/pdf-view.js for the same reason
// every other surface's listeners are: this file is where the app's DOM is
// bound to its behaviour, and a module that also owned its listeners would have
// to be loaded before the elements it binds to could respond.

// Dark page and region select, as buttons rather than rows in the ⋯ menu. Both
// are MODES, and a mode you cannot see the state of is a mode people report as
// missing — which is exactly what happened to dark page while it was buried in
// the menu ("I am not seeing any option where I can select dark mode"). Their
// aria-pressed is painted by the functions that own the state, so the button is
// right however the mode was flipped.
el.documentDarkBtn?.addEventListener("click", () => { togglePdfInvert(); });
el.documentRegionBtn?.addEventListener("click", () => { toggleRegionSelect(); });

el.documentZoomInBtn?.addEventListener("click", () => zoomDocument(1.25));
el.documentZoomOutBtn?.addEventListener("click", () => zoomDocument(1 / 1.25));
el.documentFitBtn?.addEventListener("click", () => fitDocumentToWidth());

el.documentPageInput?.addEventListener("change", () => {
  const page = Number(el.documentPageInput.value);
  if (Number.isFinite(page) && page > 0) scrollToDocumentPage(page, 0);
  el.documentPageInput.value = "";
});

// The page indicator and the saved reading position both follow the scroller.
//
// ── Once a frame, and never inside the scroll event ──────────────────────
//
// This used to call all three straight from the listener, and "both are cheap
// enough to run on it" was wrong in a way that only a measurement shows. The
// work is not the script — that is tens of milliseconds — it is that each of
// these READS the scroller's geometry and then WRITES to the document, three
// times over: updatePageIndicator reads and then writes the indicator's text,
// scheduleDocumentPositionSave reads again (twice: the page, then the ratio
// within it), and wakeDocumentPager writes a class. Every read after a write
// forces the browser to recompute style and layout there and then, and on a
// paper the recompute is expensive because a PDF's text layer is hundreds of
// positioned spans per page. That flush happens INSIDE the scroll event, which
// is to say inside the frame the reader is waiting on.
//
// Measured on a 40-page paper under a real wheel scroll, this listener alone
// accounted for 362ms of forced style recalculation and 123 extra layouts over
// a 4.6s scroll — against 47ms of script. Taking the same measurement with the
// listener disabled is what identified it: style recalc fell from 481ms to
// 119ms and layouts from 158 to 35.
//
// So: coalesced into one animation frame, so a fling that fires several scroll
// events per frame costs one pass; and inside that pass every read happens
// before any write — currentDocumentPage and currentDocumentRatio now share one
// reading of the page geometry (see documentPageGeometry), so the whole pass
// forces at most one recompute instead of three.
let documentScrollFrame = 0;

el.documentView?.addEventListener("scroll", () => {
  if (documentScrollFrame) return;
  documentScrollFrame = requestAnimationFrame(() => {
    documentScrollFrame = 0;
    // A frame armed by a scroll can run after the document it was about is gone
    // — a deck swap or a tab change lands between the two. Each call below
    // already declines on a torn-down document, so this is not a crash being
    // caught; it is one test in place of three, and a place to say why the frame
    // outlives its document at all.
    if (state.viewMode !== "document") return;
    // READS first, together, off one geometry table.
    scheduleDocumentPositionSave();
    // ...then the writes.
    updatePageIndicator();
    // The pager sits over the page at 45% opacity so it does not compete with
    // it, and comes up to full while the page number it shows is actually
    // changing — which is the one moment a reader is looking at it without
    // having reached for it. Re-armed rather than stacked, so a fling costs one
    // timer.
    wakeDocumentPager();
  });
}, { passive: true });

let documentPagerTimer = 0;

function wakeDocumentPager() {
  if (!el.documentPager) return;
  // classList.add is cheap when the class is absent and pointless when it is
  // present, which during a scroll is almost always — the timer below only takes
  // it off more than a second after the last event. Asked before written for the
  // same reason the indicator's text is: this runs once a frame for the whole of
  // a scroll.
  if (!el.documentPager.classList.contains("is-active")) el.documentPager.classList.add("is-active");
  clearTimeout(documentPagerTimer);
  documentPagerTimer = setTimeout(() => el.documentPager?.classList.remove("is-active"), DOCUMENT_PAGER_WAKE_MS);
}

// Long enough to read the page number after a flick has settled, short enough
// that the cluster is not simply always on for anyone reading downward.
const DOCUMENT_PAGER_WAKE_MS = 1200;

// ── Re-fitting the page, and the three ways this used to be wrong ─────────
//
// Fit-width has to be re-measured when the window changes: the whole point of
// the mode is that the page is as wide as the room there is for it. This used
// to be a bare `fitDocumentToWidth()` on every resize, which on a phone is
// three separate bugs at once.
//
//   1. fitDocumentToWidth SETS fitWidth. So a reader who had pinched to read a
//      dense figure had that zoom thrown away by any resize at all — they were
//      put back at fit-width without touching anything.
//   2. On a phone, "any resize at all" means ordinary scrolling. Showing and
//      hiding the URL bar changes the viewport height, and
//      interactive-widget=resizes-content (index.html) fires one more every
//      time a keyboard opens. None of those change the WIDTH, which is the
//      only measurement fit-width depends on.
//   3. Each one ran a full relayoutDocument(), which re-rasterises every page
//      in the render window and rebuilds its text layer — hundreds to a few
//      thousand spans a page. That is most of what "the PDF viewer is very slow
//      on mobile" was: the viewer re-rendering itself while being scrolled.
//
// So: only in fit-width mode, only when the width actually changed, and
// debounced — a drag-resize on a desktop fires this continuously. refit:true is
// relayoutDocument's own path for exactly this and re-measures the scale
// without claiming the mode.
//
// "The width actually changed" is asked of documentFittedWidth() — the width
// the page's current scale was measured against — and not of a memo kept here.
// A memo here is only ever written while the Document view is on screen, so a
// phone rotated in the notes view and switched back would be holding the
// portrait width and conclude, at landscape width, that nothing had changed.
// (openDocumentView re-fits on the way back in for the same reason; this is the
// half that covers a resize while the document is already the view.)
let documentRefitTimer = 0;

window.addEventListener("resize", () => {
  if (state.viewMode !== "document") return;
  const width = el.documentView?.clientWidth || 0;
  if (!width || width === documentFittedWidth()) return;
  if (!isDocumentFitWidth()) return;
  clearTimeout(documentRefitTimer);
  documentRefitTimer = setTimeout(() => relayoutDocument({ refit: true }), DOCUMENT_REFIT_MS);
});

// Long enough that a desktop drag-resize costs one relayout rather than sixty,
// short enough that a rotation looks like it re-fitted immediately.
const DOCUMENT_REFIT_MS = 150;

// Both ways into the drawer go through openDocumentToc/closeDocumentToc
// (src/documents/pdf-outline.js) — this button and the reading rail's Contents
// row. They used to be two copies of `drawer.hidden = !open`, and both of them
// left out the `.is-open` class the drawer is actually revealed by, so the
// panel was unhidden fully transparent and off the left edge of the screen.
el.documentTocBtn?.addEventListener("click", toggleDocumentToc);
el.documentTocCloseBtn?.addEventListener("click", closeDocumentToc);
initDocumentOutlineFolding();
// Landing on a contents entry, including one whose page is not known yet.
//
// A big book's outline is resolved a chunk at a time in the background
// (resolveOutlineTail), so between opening the document and that pass reaching
// the bottom of the list there is a window where a row genuinely has no page on
// it. This used to be `if (!entry?.page) return;` — a press in that window, or
// on ANY entry past the 300-entry eager cap before it was lifted, did nothing
// whatsoever: no jump, no message, the drawer just sitting there. That is the
// "clicking a TOC entry at the bottom of a large PDF does nothing" report.
//
// So the press resolves the destination itself and then goes. The drawer closes
// only once there is somewhere to go: a broken destination leaves it open with
// that row marked, because closing the contents on a jump that did not happen
// is the same silence with an extra step.
el.documentOutlineList?.addEventListener("click", (event) => {
  const link = event.target.closest(".notes-toc-link");
  if (!link) return;
  event.preventDefault();
  const index = Number(link.dataset.outlineIndex);
  const entry = documentOutlineEntries()[index];
  if (!entry) return;
  if (entry.page) {
    goToOutlineEntry(entry.page);
    return;
  }
  // One worker round trip. Unawaited on purpose — the handler cannot block —
  // and guarded inside against the document having changed underneath it.
  resolveOutlineEntryPage(index, currentPdfDocument()).then((page) => {
    if (page) goToOutlineEntry(page);
  });
});

function goToOutlineEntry(page) {
  scrollToDocumentPage(page, 0);
  // Always, unlike the notes contents, and the difference is not an oversight.
  // Above 720px the notes STAGE makes room for its drawer (the
  // .notes-stage.is-toc-open rules in styles/12-notes.css), so the drawer covers
  // nothing and a reader can walk down the list. Nothing equivalent exists here
  // and nothing should: a .pdf-page is fit to the width of its scroller, so
  // narrowing that scroller would re-rasterise every page in the render window
  // for the length of a drawer being open. It overlays at every width instead —
  // and a drawer that stayed open over the page it just took you to would be
  // hiding the thing it was asked to show.
  closeDocumentToc();
}

// Clicking outside the open drawer dismisses it. The notes drawer makes this
// conditional — it stops dismissing once the stage makes room for it, since
// clicking into the notes to read is the whole reason you opened the contents —
// and this one cannot, because it never stops covering the page (see above).
// The toggle button is excluded so its own click still toggles rather than
// close-then-reopen.
document.addEventListener("pointerdown", (event) => {
  if (!isDocumentTocOpen()) return;
  if (el.documentOutlineDrawer?.contains(event.target)) return;
  if (el.documentTocBtn?.contains(event.target)) return;
  closeDocumentToc();
});

el.documentMoreBtn?.addEventListener("click", () => {
  if (!el.documentMoreMenu) return;
  const open = el.documentMoreMenu.hidden;
  el.documentMoreMenu.hidden = !open;
  el.documentMoreBtn.setAttribute("aria-expanded", String(open));
  // "Notes on the page" is a MODE, so its switch has to say which way it is set
  // — and its hint has to say how many notes there are to print, because
  // pressing a toggle on an unannotated paper and seeing nothing change is the
  // same puzzle the notes ⋯ menu's own rows were rewritten to remove.
  if (open) paintPdfPageNotesButton();
});

// The button and the menu are direct children of #viewModeRow now (they were
// lifted out of the deleted .document-toolbar at boot), so the wrapper this used
// to test for no longer exists — the two ids are the test.
document.addEventListener("pointerdown", (event) => {
  if (!el.documentMoreMenu || el.documentMoreMenu.hidden) return;
  if (event.target.closest("#documentMoreMenu, #documentMoreBtn")) return;
  el.documentMoreMenu.hidden = true;
  el.documentMoreBtn?.setAttribute("aria-expanded", "false");
}, { capture: true, passive: true });

el.documentMoreMenu?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-document-action]");
  if (!button) return;
  const action = button.dataset.documentAction;
  // The re-attach row is a <label> wrapping a file input — closing the menu on
  // its own click would remove the input before the picker opened.
  if (action === "reattach") return;
  // A mode row stays put: flipping it and watching the switch move is the
  // feedback, and a menu that closed underneath the press would take that away.
  if (action !== "page-notes") {
    el.documentMoreMenu.hidden = true;
    el.documentMoreBtn?.setAttribute("aria-expanded", "false");
  }
  if (action === "page-notes") {
    togglePdfPageNotes();
    return;
  }
  if (action === "offload") await offloadCurrentDocument();
});

el.documentReattachInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (el.documentMoreMenu) el.documentMoreMenu.hidden = true;
  el.documentMoreBtn?.setAttribute("aria-expanded", "false");
  if (file) await reattachDocument(file, state.meta?.pdf);
});

// "Remove from cloud" — the offload half of the finish-a-paper loop.
//
// Deliberately explicit about what stays, because the words "remove" and
// "delete" have burned people before: the highlights, the notes and the cards
// are untouched, and the device copy is untouched. What goes is the megabytes
// in the bucket, which is the only part that costs anything.
async function offloadCurrentDocument() {
  const pdfMeta = state.meta?.pdf;
  if (!pdfMeta?.path || pdfMeta.offloaded) {
    showToast("This document isn't in the cloud", "error");
    return false;
  }
  showConfirmModal(
    `“${pdfMeta.name || "This document"}” will be deleted from your cloud storage, freeing ${formatStorageBytes(pdfMeta.size || 0)}. Your highlights, notes and cards all stay, and so does the copy on this device — but other devices will need the file re-attached to read it.`,
    async () => {
      const removed = await deleteRemoteDocument(pdfMeta.path);
      if (!removed) {
        showToast("Could not remove the document from the cloud", "error");
        return;
      }
      // `path` is kept, not cleared: it records where the object USED to live,
      // so an offloaded deck that is later re-uploaded lands in the same place
      // rather than accumulating a second folder.
      state.meta = { ...state.meta, pdf: { ...pdfMeta, offloaded: true } };
      scheduleDeckAutosave();
      showToast(`Removed from cloud · ${formatStorageBytes(pdfMeta.size || 0)} freed`);
    },
    { confirmLabel: "Remove", danger: true }
  );
  return true;
}

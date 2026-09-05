// Every element the app talks to, looked up once.
//
// This runs at import time, which is safe because a module script is deferred:
// the document is fully parsed before any of this evaluates. It was equally
// safe as a classic script only because the tag sat at the end of <body>.

export const el = {
  sourceInput: document.querySelector("#sourceInput"),
  urlInput: document.querySelector("#urlInput"),
  fileInput: document.querySelector("#fileInput"),
  fetchBtn: document.querySelector("#fetchBtn"),
  pasteMarkdownInput: document.querySelector("#pasteMarkdownInput"),
  importSourceStep: document.querySelector("#importSourceStep"),
  importFilePick: document.querySelector("#importFilePick"),
  importPasteSourceBtn: document.querySelector("#importPasteSourceBtn"),
  importUrlSourceBtn: document.querySelector("#importUrlSourceBtn"),
  importUrlRow: document.querySelector("#importUrlRow"),
  importPasteRow: document.querySelector("#importPasteRow"),
  importPasteContinueBtn: document.querySelector("#importPasteContinueBtn"),
  importPasteCancelBtn: document.querySelector("#importPasteCancelBtn"),
  importReviewStep: document.querySelector("#importReviewStep"),
  importDetect: document.querySelector("#importDetect"),
  importContentOptions: document.querySelector("#importContentOptions"),
  importContentHint: document.querySelector("#importContentHint"),
  importTargetOptions: document.querySelector("#importTargetOptions"),
  importTargetHint: document.querySelector("#importTargetHint"),
  importFolderRow: document.querySelector("#importFolderRow"),
  importFolderPath: document.querySelector("#importFolderPath"),
  importFolderChangeBtn: document.querySelector("#importFolderChangeBtn"),
  importDeckList: document.querySelector("#importDeckList"),
  importDeckListLabel: document.querySelector("#importDeckListLabel"),
  importDeckListRows: document.querySelector("#importDeckListRows"),
  importDeckSelectAll: document.querySelector("#importDeckSelectAll"),
  importPreviewSummary: document.querySelector("#importPreviewSummary"),
  importPreviewBody: document.querySelector("#importPreviewBody"),
  importConfirmBtn: document.querySelector("#importConfirmBtn"),
  importStartOverBtn: document.querySelector("#importStartOverBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  newDeckBtn: document.querySelector("#newDeckBtn"),
  importBtn: document.querySelector("#importBtn"),
  myDecksBtn: document.querySelector("#myDecksBtn"),
  syncNowBtn: document.querySelector("#syncNowBtn"),
  autoSyncSelect: document.querySelector("#autoSyncSelect"),
  myDecksPanel: document.querySelector("#myDecksPanel"),
  myDecksListTable: document.querySelector("#myDecksListTable"),
  myDecksBody: document.querySelector("#myDecksBody"),
  myDecksTableWrap: document.querySelector("#myDecksTableWrap"),
  myDecksGrid: document.querySelector("#myDecksGrid"),
  myDecksViewSwitch: document.querySelector("#myDecksViewSwitch"),
  myDecksDisplayToggle: document.querySelector("#myDecksDisplayToggle"),
  myDecksBreadcrumb: document.querySelector("#myDecksBreadcrumb"),
  myDecksSearch: document.querySelector("#myDecksSearch"),
  myDecksNewDeckBtn: document.querySelector("#myDecksNewDeckBtn"),
  myDecksTreeToggleAll: document.querySelector("#myDecksTreeToggleAll"),
  myDecksCategoryFilter: document.querySelector("#myDecksCategoryFilter"),
  myDecksSort: document.querySelector("#myDecksSort"),
  myDecksFilterWrap: document.querySelector("#myDecksFolderFilterWrap"),
  myDecksSelectAllCheckbox: document.querySelector("#myDecksSelectAllCheckbox"),
  myDecksBulkActions: document.querySelector("#myDecksBulkActions"),
  myDecksSelectedCount: document.querySelector("#myDecksSelectedCount"),
  myDecksCount: document.querySelector("#myDecksCount"),
  myDecksMoreBtn: document.querySelector("#myDecksMoreBtn"),
  myDecksMoreMenu: document.querySelector("#myDecksMoreMenu"),
  closeMyDecksBtn: document.querySelector("#closeMyDecksBtn"),
  myDecksRefreshBtn: document.querySelector("#myDecksRefreshBtn"),
  myDecksNewFolderBtn: document.querySelector("#myDecksNewFolderBtn"),
  myDecksImportBtn: document.querySelector("#myDecksImportBtn"),
  myDecksImportInput: document.querySelector("#myDecksImportInput"),
  myDecksImportEpubInput: document.querySelector("#myDecksImportEpubInput"),
  closeImportBtn: document.querySelector("#closeImportBtn"),
  importPanel: document.querySelector("#importPanel"),
  quickNotesBoardBtn: document.querySelector("#quickNotesBoardBtn"),
  quickNotesBoard: document.querySelector("#quickNotesBoard"),
  qnSummary: document.querySelector("#qnSummary"),
  qnSearch: document.querySelector("#qnSearch"),
  appBackBtn: document.querySelector("#appBackBtn"),
  qnFilters: document.querySelector("#qnFilters"),
  qnBody: document.querySelector("#qnBody"),
  qnManageBtn: document.querySelector("#qnManageBtn"),
  qnCloseBtn: document.querySelector("#qnCloseBtn"),
  qnCatModal: document.querySelector("#qnCatModal"),
  qnCatModalClose: document.querySelector("#qnCatModalClose"),
  qnCatList: document.querySelector("#qnCatList"),
  qnCatColorPicker: document.querySelector("#qnCatColorPicker"),
  qnCatNewName: document.querySelector("#qnCatNewName"),
  qnCatAddBtn: document.querySelector("#qnCatAddBtn"),
  printRoot: document.querySelector("#printRoot"),
  diagramModal: document.querySelector("#diagramModal"),
  diagramModalBody: document.querySelector("#diagramModalBody"),
  closeDiagramBtn: document.querySelector("#closeDiagramBtn"),
  diagramZoomInBtn: document.querySelector("#diagramZoomInBtn"),
  diagramZoomOutBtn: document.querySelector("#diagramZoomOutBtn"),
  // No exportBtn / exportMenu / exportNotesBtn / exportNotesMenu /
  // drawerExportHighlightsBtn here any more. Those five were the ☰ drawer's
  // three export rows and their two inline popovers; the first two menus were
  // row-for-row duplicates of what the ⇓ beside the tabs already offers
  // (VIEW_EXPORT_MENUS in src/ui/view-mode.js), and the highlights row became a
  // row on that same ⇓. The dialog below is unchanged and still has two
  // openers — the ⇓ and the side-by-side pane's own header.
  exportHighlightsModal: document.querySelector("#exportHighlightsModal"),
  exportHighlightsContext: document.querySelector("#exportHighlightsContext"),
  exportHighlightsChapterToggle: document.querySelector("#exportHighlightsChapterToggle"),
  exportHighlightsNotesToggle: document.querySelector("#exportHighlightsNotesToggle"),
  exportHighlightsCancelBtn: document.querySelector("#exportHighlightsCancelBtn"),
  allCardsBtn: document.querySelector("#allCardsBtn"),
  allCardsPanel: document.querySelector("#allCardsPanel"),
  allCardsList: document.querySelector("#allCardsList"),
  allCardsSummary: document.querySelector("#allCardsSummary"),
  toggleAllAnswersBtn: document.querySelector("#toggleAllAnswersBtn"),
  toggleCompactBtn: document.querySelector("#toggleCompactBtn"),
  allCardsFilter: document.querySelector("#allCardsFilter"),
  closeAllCardsBtn: document.querySelector("#closeAllCardsBtn"),
  storageBtn: document.querySelector("#storageBtn"),
  storagePanel: document.querySelector("#storagePanel"),
  storageBody: document.querySelector("#storageBody"),
  storageRefreshBtn: document.querySelector("#storageRefreshBtn"),
  closeStorageBtn: document.querySelector("#closeStorageBtn"),
  styleBtn: document.querySelector("#styleBtn"),
  stylePanel: document.querySelector("#stylePanel"),
  styleControls: document.querySelector("#styleControls"),
  closeStyleBtn: document.querySelector("#closeStyleBtn"),
  syncUpBtn: document.querySelector("#syncUpBtn"),
  resetStyleBtn: document.querySelector("#resetStyleBtn"),
  syncDownBtn: document.querySelector("#syncDownBtn"),
  styleSyncStatus: document.querySelector("#styleSyncStatus"),
  themeBtn: document.querySelector("#themeBtn"),
  themeMenu: document.querySelector("#themeMenu"),
  themeCurrentLabel: document.querySelector("#themeCurrentLabel"),
  deckTitleWrap: document.querySelector("#deckTitleWrap"),
  deckMeta2Row: document.querySelector("#deckMeta2Row"),
  deckTitle: document.querySelector("#deckTitle"),
  editDeckTitleBtn: document.querySelector("#editDeckTitleBtn"),
  deckCategory: document.querySelector("#deckCategory"),
  editDeckCategoryBtn: document.querySelector("#editDeckCategoryBtn"),
  shuffleBtn: document.querySelector("#shuffleBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  clozeToggleBtn: document.querySelector("#clozeToggleBtn"),
  clozeToggleNotesBtn: document.querySelector("#clozeToggleNotesBtn"),
  clozeReviewBtn: document.querySelector("#clozeReviewBtn"),
  clozePanel: document.querySelector("#clozePanel"),
  closeClozeBtn: document.querySelector("#closeClozeBtn"),
  clozeBulkBtn: document.querySelector("#clozeBulkBtn"),
  clozeReviewBody: document.querySelector("#clozeReviewBody"),
  clozeReviewSummary: document.querySelector("#clozeReviewSummary"),
  card: document.querySelector("#card"),
  questionView: document.querySelector("#questionView"),
  answerView: document.querySelector("#answerView"),
  questionStatusBadge: document.querySelector("#questionStatusBadge"),
  answerStatusBadge: document.querySelector("#answerStatusBadge"),
  editQuestionBtn: document.querySelector("#editQuestionBtn"),
  editAnswerBtn: document.querySelector("#editAnswerBtn"),
  questionEdit: document.querySelector("#questionEdit"),
  answerEdit: document.querySelector("#answerEdit"),
  deleteCardBtn: document.querySelector("#deleteCardBtn"),
  goToNotesBtn: document.querySelector("#goToNotesBtn"),
  addCardBtn: document.querySelector("#addCardBtn"),
  positionText: document.querySelector("#positionText"),
  scoreText: document.querySelector("#scoreText"),
  syncIndicator: document.querySelector("#syncIndicator"),
  progressBar: document.querySelector("#progressBar"),
  progressKnown: document.querySelector("#progressKnown"),
  progressReview: document.querySelector("#progressReview"),
  deckEmptyState: document.querySelector("#deckEmptyState"),
  deckEmptyPanel: document.querySelector("#deckEmptyPanel"),
  deckEmptySyncValue: document.querySelector("#deckEmptySyncValue"),
  deckEmptyLibraryValue: document.querySelector("#deckEmptyLibraryValue"),
  deckEmptyIcon: document.querySelector("#deckEmptyIcon"),
  deckEmptyTitle: document.querySelector("#deckEmptyTitle"),
  deckEmptyBody: document.querySelector("#deckEmptyBody"),
  deckEmptyActionsNone: document.querySelector("#deckEmptyActionsNone"),
  deckEmptyActionsActive: document.querySelector("#deckEmptyActionsActive"),
  deckEmptyAddCardBtn: document.querySelector("#deckEmptyAddCardBtn"),
  deckEmptyGoNotesBtn: document.querySelector("#deckEmptyGoNotesBtn"),
  deckEmptySyncReport: document.querySelector("#deckEmptySyncReport"),
  swipeHint: document.querySelector("#swipeHint"),
  confirmModal: document.querySelector("#confirmModal"),
  confirmModalMessage: document.querySelector("#confirmModalMessage"),
  confirmModalOkBtn: document.querySelector("#confirmModalOkBtn"),
  confirmModalCancelBtn: document.querySelector("#confirmModalCancelBtn"),
  promptModal: document.querySelector("#promptModal"),
  promptModalTitle: document.querySelector("#promptModalTitle"),
  promptModalHint: document.querySelector("#promptModalHint"),
  promptModalInput: document.querySelector("#promptModalInput"),
  promptModalOkBtn: document.querySelector("#promptModalOkBtn"),
  promptModalCancelBtn: document.querySelector("#promptModalCancelBtn"),
  statusText: document.querySelector("#statusText"),
  prevCardBtn: document.querySelector("#prevCardBtn"),
  nextCardBtn: document.querySelector("#nextCardBtn"),
  knownBtn: document.querySelector("#knownBtn"),
  reviewBtn: document.querySelector("#reviewBtn"),
  replayReviewBtn: document.querySelector("#replayReviewBtn"),
  replayKnownBtn: document.querySelector("#replayKnownBtn"),
  replayUncategorizedBtn: document.querySelector("#replayUncategorizedBtn"),
  replayAllBtn: document.querySelector("#replayAllBtn"),
  deckSummary: document.querySelector("#deckSummary"),
  questionEditToolbar: document.querySelector("#questionEditToolbar"),
  answerEditToolbar: document.querySelector("#answerEditToolbar"),
  viewModeToggle: document.querySelector("#viewModeToggle"),
  viewExportBtn: document.querySelector("#viewExportBtn"),
  viewExportMenu: document.querySelector("#viewExportMenu"),
  notesStage: document.querySelector("#notesStage"),
  notesView: document.querySelector("#notesView"),
  notesTocBtn: document.querySelector("#notesTocBtn"),
  notesTocDrawer: document.querySelector("#notesTocDrawer"),
  notesBacklinks: document.querySelector("#notesBacklinks"),
  notesBacklinksList: document.querySelector("#notesBacklinksList"),
  notesTocList: document.querySelector("#notesTocList"),
  notesTocEmpty: document.querySelector("#notesTocEmpty"),
  notesTocCloseBtn: document.querySelector("#notesTocCloseBtn"),
  notesEdit: document.querySelector("#notesEdit"),
  notesEditToolbar: document.querySelector("#notesEditToolbar"),
  editNotesBtn: document.querySelector("#editNotesBtn"),
  bookmarkGoBtn: document.querySelector("#bookmarkGoBtn"),
  focusModeBtn: document.querySelector("#focusModeBtn"),
  makeCardFromSelectionBtn: document.querySelector("#makeCardFromSelectionBtn"),
  makeClozeFromSelectionBtn: document.querySelector("#makeClozeFromSelectionBtn"),
  pinQuickNoteFromSelectionBtn: document.querySelector("#pinQuickNoteFromSelectionBtn"),
  highlightSelectionBtn: document.querySelector("#highlightSelectionBtn"),
  highlightSelectionMenuBtn: document.querySelector("#highlightSelectionMenuBtn"),
  highlightAnnotateSelectionBtn: document.querySelector("#highlightAnnotateSelectionBtn"),
  highlightSelectionMenu: document.querySelector("#highlightSelectionMenu"),
  eraseNotesSelectionBtn: document.querySelector("#eraseNotesSelectionBtn"),
  extractNoteFromSelectionBtn: document.querySelector("#extractNoteFromSelectionBtn"),
  // The three that replace Android's own selection bar, which the touch
  // selection controller suppresses along with the native long press.
  copySelectionBtn: document.querySelector("#copySelectionBtn"),
  shareSelectionBtn: document.querySelector("#shareSelectionBtn"),
  searchSelectionBtn: document.querySelector("#searchSelectionBtn"),
  // "Done" — the phone bar's own way out. See the handler in src/main.js and
  // the outside-press listener in src/notes/touch-selection.js.
  dismissSelectionBtn: document.querySelector("#dismissSelectionBtn"),
  selectionFloat: document.querySelector("#selectionFloat"),
  selectionFloatFormat: document.querySelector("#selectionFloatFormat"),
  immersiveModeBtn: document.querySelector("#immersiveModeBtn"),
  // Side by side — the reading surface keeps its own place in the panel's grid
  // and these take the column (or, on a phone, the row) beside it. See
  // src/panels/highlight-cycle.js.
  //
  // There is no #highlightsStage / #highlightsList any more. That was the
  // Highlights TAB, and it rendered the very cards this pane renders, through
  // the same renderHighlightsEditor, somewhere you had to leave the paper to
  // reach. One surface, one container.
  splitDivider: document.querySelector("#splitDivider"),
  highlightCycle: document.querySelector("#highlightCycle"),
  highlightCycleBody: document.querySelector("#highlightCycleBody"),
  highlightCycleEmpty: document.querySelector("#highlightCycleEmpty"),
  highlightCycleCount: document.querySelector("#highlightCycleCount"),
  highlightCyclePrevBtn: document.querySelector("#highlightCyclePrevBtn"),
  highlightCycleNextBtn: document.querySelector("#highlightCycleNextBtn"),
  highlightCycleCloseBtn: document.querySelector("#highlightCycleCloseBtn"),
  highlightCycleExportBtn: document.querySelector("#highlightCycleExportBtn"),
  // The switch between the two widths the pane has: beside the reading surface,
  // or holding the whole panel on its own. See splitMode in highlight-cycle.js.
  highlightCycleWideBtn: document.querySelector("#highlightCycleWideBtn"),
  // The Document surface — the PDF itself, for a deck with meta.pdf. See
  // src/documents/pdf-view.js; #documentView is the scroller that holds one
  // .pdf-page per page.
  documentStage: document.querySelector("#documentStage"),
  documentView: document.querySelector("#documentView"),
  // The page number and the zoom controls, in the cluster that floats over the
  // bottom-right of the page rather than in a bar above it.
  documentPager: document.querySelector("#documentPager"),
  documentPageInput: document.querySelector("#documentPageInput"),
  documentPageIndicator: document.querySelector("#documentPageIndicator"),
  documentZoomInBtn: document.querySelector("#documentZoomInBtn"),
  documentZoomOutBtn: document.querySelector("#documentZoomOutBtn"),
  documentFitBtn: document.querySelector("#documentFitBtn"),
  // Two modes, as buttons in the view-mode row rather than rows in the ⋯ menu:
  // dark page read as missing while it was buried there, and region select is
  // the only way to highlight a figure at all.
  documentDarkBtn: document.querySelector("#documentDarkBtn"),
  documentRegionBtn: document.querySelector("#documentRegionBtn"),
  documentInkBtn: document.querySelector("#documentInkBtn"),
  documentInkRail: document.querySelector("#documentInkRail"),
  inkRailPens: document.querySelector("#inkRailPens"),
  inkRailWidths: document.querySelector("#inkRailWidths"),
  inkRailEraser: document.querySelector("#inkRailEraser"),
  inkRailSelection: document.querySelector("#inkRailSelection"),
  // The Write tab has no panel, no stage and — since the row that carried them
  // crushed its own tab labels — no chrome of its own either. Handwriting is
  // #documentStage showing the deck's OTHER document (src/documents/doc-slot.js);
  // what goes on the page lives in the pen's rail and what is done to the page
  // lives in the ⋯ menu, both of which are the Document surface's own furniture.
  // The picker is the one exception, because a <label> over a file input has to
  // be reachable by id to be disabled.
  handwritingImageBtn: document.querySelector("#handwritingImageBtn"),
  handwritingImageInput: document.querySelector("#handwritingImageInput"),
  documentMoreBtn: document.querySelector("#documentMoreBtn"),
  documentMoreMenu: document.querySelector("#documentMoreMenu"),
  documentReattachInput: document.querySelector("#documentReattachInput"),
  documentTocBtn: document.querySelector("#documentTocBtn"),
  documentTocCloseBtn: document.querySelector("#documentTocCloseBtn"),
  documentOutlineDrawer: document.querySelector("#documentOutlineDrawer"),
  documentOutlineList: document.querySelector("#documentOutlineList"),
  documentOutlineEmpty: document.querySelector("#documentOutlineEmpty"),
  // The rail focus mode brings back — see src/ui/reading-rail.js.
  readingRail: document.querySelector("#readingRail"),
  readingRailGrip: document.querySelector("#readingRailGrip"),
  readingRailTray: document.querySelector("#readingRailTray"),
  readingRailCloseBtn: document.querySelector("#readingRailCloseBtn"),
  readingRailViewName: document.querySelector("#readingRailViewName"),
  myDecksImportPdfInput: document.querySelector("#myDecksImportPdfInput"),
  // No attachPdfBtn / attachPdfInput. They were the drawer's "Attach a PDF"
  // row, which existed because the Document surface only existed once meta.pdf
  // did. It is on every open deck now (refreshDocumentTab), and a deck with no
  // paper opens it to a card carrying the same picker and calling the same
  // attachPdfToOpenDeck — see renderAttachDocumentPrompt.
  frameCardModal: document.querySelector("#frameCardModal"),
  frameCardAnswerPreview: document.querySelector("#frameCardAnswerPreview"),
  frameCardQuestionInput: document.querySelector("#frameCardQuestionInput"),
  frameCardAddBtn: document.querySelector("#frameCardAddBtn"),
  frameCardCancelBtn: document.querySelector("#frameCardCancelBtn"),
  syncModal: document.querySelector("#syncModal"),
  syncDetailsContent: document.querySelector("#syncDetailsContent"),
  logoutBtn: document.querySelector("#logoutBtn"),
};

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
export function onDomReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else queueMicrotask(fn);
}

export const deckEmptyNewBtn = document.getElementById("deckEmptyNewBtn");

export const deckEmptyImportBtn2 = document.getElementById("deckEmptyImportBtn");

export const deckEmptyWebBtn = document.getElementById("deckEmptyWebBtn");

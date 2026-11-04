// What a style setting IS: the defaults, the controls that edit each one, and
// the CSS variable each writes.
//
// Data only — no behaviour. The panel and popovers that render these and the
// code that applies them live elsewhere, which is what lets this be read without
// understanding either.

import { fontFamilyOptionGroups, fontFamilyOptions } from "./theme-catalog.js?v=__BUILD__";

// ── Sections ────────────────────────────────────────────────────────────────
//
// Every control belongs to exactly ONE section (`scope`), and each section is
// edited from its own ◐ button, in the chrome of the thing it styles — the view
// row for Cards / Notes / PDFs / Canvas, the head of the Highlights pane, the
// contents drawer, a tapped highlight's menu, the highlight note window, All
// Cards, Quick Notes, Home and My Files. The ☰ drawer's "Theme & App" panel holds
// the `app` section: what is true of the whole app rather than of one surface.
//
// This replaced one panel of ~70 controls (Global / Text per tab / Spacing &
// controls / More) where the control that sized a thing was rarely near the
// thing, and several controls quietly reached three or four surfaces at once.
// A setting that used to be shared is now one per section, each seeded from the
// shared value on the v6 upgrade (src/ui/style-settings.js) so nothing moved.
//
// `entry` is where that section's ◐ lives, for the panel's list and the Help
// guide; `label` is what the popover's head says.
export const styleScopes = [
  { id: "app", label: "Theme & App", entry: "☰ → Theme & App" },
  { id: "cards", label: "Cards", entry: "◐ in the tab row, on Cards" },
  { id: "notes", label: "Notes", entry: "◐ in the tab row, on Notes" },
  { id: "highlightsPane", label: "Highlights pane", entry: "◐ in the Highlights pane's head" },
  { id: "marks", label: "Highlights in text", entry: "Tap a highlight → Style highlights" },
  { id: "noteEditor", label: "Highlight note window", entry: "◐ in the note window's head" },
  { id: "toc", label: "Contents", entry: "◐ in the contents drawer's head" },
  { id: "document", label: "PDFs", entry: "◐ in the tab row, on PDFs" },
  { id: "handwriting", label: "Canvas", entry: "◐ in the tab row, on Canvas" },
  { id: "allCards", label: "All Cards", entry: "◐ in All Cards' head" },
  { id: "quickNotes", label: "Quick Notes", entry: "◐ in Quick Notes' head" },
  { id: "home", label: "Home", entry: "◐ beside Home's title" },
  { id: "myFiles", label: "My Files", entry: "My Files → ⋯ → Style My Files" }
];

export const styleScopeById = Object.fromEntries(styleScopes.map((scope) => [scope.id, scope]));

// Values shared by both profiles. The `auto` ones are controls that did not
// exist before v6: "auto" writes nothing, so the stylesheet's own value — the
// one the app has always used, media queries and all — is what applies until
// somebody types something.
const sharedDefaults = {
  // Highlights in text
  markTintPercent: "100",
  markRadius: "auto",
  markNoteUnderline: "dotted",
  markNoteUnderlineWidth: "auto",
  markNoteFoldSize: "auto",
  // Highlight note window
  noteEdTextSize: "auto",
  noteEdLineHeight: "auto",
  noteEdWidth: "auto",
  noteEdPadding: "auto",
  noteEdRadius: "auto",
  // Contents
  tocFontSize: "auto",
  tocLineHeight: "auto",
  tocRowPadding: "auto",
  tocWidth: "auto",
  // All Cards
  allCardsFontSize: "auto",
  allCardsLineHeight: "auto",
  // Quick Notes
  qnFontSize: "auto",
  qnLineHeight: "auto",
  qnCardPadding: "auto",
  qnCardRadius: "auto",
  qnColumnWidth: "auto",
  // Home
  homeWidth: "auto",
  homeTileWidth: "auto",
  homeTitleSize: "auto",
  homeCardRadius: "14px",
  // My Files
  myFilesWidth: "auto",
  myFilesTextSize: "auto",
  myFilesTileWidth: "auto",
  myFilesPadding: "12px",
  // App — dialogs
  dialogCornerRadius: "14px"
};

// One entry per control in styleControlGroups, per profile — nothing more.
// Keys the panel doesn't expose used to accumulate here (stackCard*,
// sidePanelWidthPercent, the per-face font families) and normalizeStyleSettings
// iterates THIS object, so a stale key is a setting the app carries around, syncs
// to Supabase and back-fills from the wrong profile, while doing nothing at all.
export const defaultStyleProfiles = {
  "mobile": {
    // App
    "fontFamily": "system",
    "uiFontSize": "16px",
    "appGap": "6px",
    "buttonGap": "6px",
    "modalPadding": "12px",
    "toolbarButtonHeight": "34px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "buttonCornerRadius": "8px",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "modalWidthPercent": "60",
    // Cards
    "baseFontSize": "12px",
    "baseLineHeight": "1.23",
    "questionMaxFontSize": "23px",
    "questionLineHeight": "1.17",
    "answerFontSize": "13px",
    "answerLineHeight": "1.58",
    "rawMarkdownFontSize": "16px",
    // Matches baseFontSize: --code-font-size had NO consumer until v3, so every
    // stored value for it is noise — see normalizeStyleProfiles, which drops a
    // pre-v3 one rather than letting anyone's code blocks suddenly shrink.
    "codeFontSize": "12px",
    "codeLineHeight": "1.17",
    "headingH1Scale": "1.2",
    "headingH2Scale": "1.12",
    "headingH3Scale": "1.06",
    "headingH4Scale": "1",
    "headingH5Scale": "1",
    "headingH6Scale": "1",
    "panelPadding": "6px",
    "cardPadding": "16px",
    "cardContentGap": "10px",
    "cardWidthPercent": "96",
    "cardMaxHeightPercent": "80",
    "visualMaxWidthPercent": "90",
    "questionFillPercent": "75",
    "questionAlign": "left",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerFontWeight": "300",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "cardBorderWidth": "1px",
    // Notes. The three code/raw sizes are seeded from the Cards ones on the v5
    // upgrade, and the v6 ones (headings, tables, images, frame) from what the
    // Notes used to share, so a note looks exactly as it did before it had its own.
    "notesFontFamily": "inherit",
    "notesFontSize": "15px",
    "notesLineHeight": "1.5",
    "notesFontWeight": "400",
    "notesRawFontSize": "16px",
    "notesCodeFontSize": "12px",
    "notesCodeLineHeight": "1.17",
    "notesTableFontSize": "12px",
    "headingNumbers": "on",
    "notesHeadingH1Scale": "1.2",
    "notesHeadingH2Scale": "1.12",
    "notesHeadingH3Scale": "1.06",
    "notesHeadingH4Scale": "1",
    "notesHeadingH5Scale": "1",
    "notesHeadingH6Scale": "1",
    "notesReadingMode": "continuous",
    "notesMaxWidthPercent": "100",
    "notesPadding": "4px",
    "notesVisualMaxWidthPercent": "90",
    "notesFrameRadius": "14px",
    "notesFrameBorder": "1px",
    // Highlights pane
    "hlNoteFontSize": "inherit",
    "hlNoteLineHeight": "inherit",
    "hlNoteWeight": "inherit",
    "hlQuoteFontSize": "0.95em",
    "hlQuoteInkPercent": "74",
    "hlCardPadding": "8px",
    "hlCardGap": "12px",
    "hlCardRadius": "10px",
    "hlCardRail": "3px",
    "hlNoteEmptyHeight": "18px",
    // Highlights in text
    "codeHighlightStrength": "medium",
    // Highlight note window — its editor size is seeded from the Cards' raw size,
    // which is what it used before it had its own.
    "noteEdRawFontSize": "16px",
    // PDFs
    "docBlockFontSize": "0.82rem",
    "docBlockLineHeight": "1.4",
    "docCodeFontSize": "1em",
    // Canvas
    "canvasBlockFontSize": "0.82rem",
    "canvasBlockLineHeight": "1.4",
    "canvasCodeFontSize": "1em",
    ...sharedDefaults
  },
  "desktop": {
    // App
    "fontFamily": "system",
    "uiFontSize": "16px",
    "appGap": "6px",
    "buttonGap": "6px",
    "modalPadding": "12px",
    "toolbarButtonHeight": "38px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "buttonCornerRadius": "8px",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "modalWidthPercent": "60",
    // Cards
    "baseFontSize": "18px",
    "baseLineHeight": "1.58",
    "questionMaxFontSize": "19px",
    "questionLineHeight": "1.18",
    "answerFontSize": "23px",
    "answerLineHeight": "1.58",
    "rawMarkdownFontSize": "18px",
    "codeFontSize": "18px",
    "codeLineHeight": "1.55",
    "headingH1Scale": "1.2",
    "headingH2Scale": "1.12",
    "headingH3Scale": "1.06",
    "headingH4Scale": "1",
    "headingH5Scale": "1",
    "headingH6Scale": "1",
    "panelPadding": "6px",
    "cardPadding": "16px",
    "cardContentGap": "10px",
    "cardWidthPercent": "100",
    "cardMaxHeightPercent": "84",
    "visualMaxWidthPercent": "50",
    "questionFillPercent": "58",
    "questionAlign": "center",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerFontWeight": "400",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "cardBorderWidth": "1px",
    // Notes
    "notesFontFamily": "inherit",
    "notesFontSize": "18px",
    "notesLineHeight": "1.58",
    "notesFontWeight": "400",
    "notesRawFontSize": "18px",
    "notesCodeFontSize": "18px",
    "notesCodeLineHeight": "1.55",
    "notesTableFontSize": "18px",
    "headingNumbers": "on",
    "notesHeadingH1Scale": "1.2",
    "notesHeadingH2Scale": "1.12",
    "notesHeadingH3Scale": "1.06",
    "notesHeadingH4Scale": "1",
    "notesHeadingH5Scale": "1",
    "notesHeadingH6Scale": "1",
    "notesReadingMode": "continuous",
    "notesMaxWidthPercent": "100",
    "notesPadding": "4px",
    "notesVisualMaxWidthPercent": "50",
    "notesFrameRadius": "14px",
    "notesFrameBorder": "1px",
    // Highlights pane
    "hlNoteFontSize": "inherit",
    "hlNoteLineHeight": "inherit",
    "hlNoteWeight": "inherit",
    "hlQuoteFontSize": "0.95em",
    "hlQuoteInkPercent": "74",
    "hlCardPadding": "8px",
    "hlCardGap": "12px",
    "hlCardRadius": "10px",
    "hlCardRail": "3px",
    "hlNoteEmptyHeight": "18px",
    // Highlights in text
    "codeHighlightStrength": "medium",
    // Highlight note window
    "noteEdRawFontSize": "18px",
    // PDFs
    "docBlockFontSize": "0.82rem",
    "docBlockLineHeight": "1.4",
    "docCodeFontSize": "1em",
    // Canvas
    "canvasBlockFontSize": "0.82rem",
    "canvasBlockLineHeight": "1.4",
    "canvasCodeFontSize": "1em",
    ...sharedDefaults
  },
  "version": 2
};

// The spacing defaults before v5 made them tight. normalizeStyleProfiles moves a
// stored value that still equals one of these to the new default — it was never
// chosen, only inherited — and leaves anything somebody actually typed alone.
export const legacySpacingDefaults = {
  mobile: { appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", buttonGap: "8px", hlCardPadding: "10px", hlCardGap: "16px", modalPadding: "18px" },
  desktop: { appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", buttonGap: "8px", notesPadding: "6px", hlCardPadding: "11px", hlCardGap: "20px", modalPadding: "18px" }
};

// The v6 split: [new key, the shared key it was split from]. A profile stored
// before v6 gets each new key as a COPY of the old shared value, so the section
// that now has its own control looks exactly as it did the day it got one.
export const styleV6Seeds = [
  ["notesTableFontSize", "baseFontSize"],
  ...[1, 2, 3, 4, 5, 6].map((level) => [`notesHeadingH${level}Scale`, `headingH${level}Scale`]),
  ["notesVisualMaxWidthPercent", "visualMaxWidthPercent"],
  ["notesFrameRadius", "cardCornerRadius"],
  ["notesFrameBorder", "cardBorderWidth"],
  ["noteEdRawFontSize", "rawMarkdownFontSize"],
  ["canvasBlockFontSize", "docBlockFontSize"],
  ["canvasBlockLineHeight", "docBlockLineHeight"],
  ["canvasCodeFontSize", "docCodeFontSize"],
  ["homeCardRadius", "cardCornerRadius"],
  ["myFilesPadding", "modalPadding"],
  ["dialogCornerRadius", "panelCornerRadius"]
];

export const styleDefaults = defaultStyleProfiles.desktop;

// ── The controls ────────────────────────────────────────────────────────────
//
// Nothing in here may write a CSS variable no stylesheet reads: a control that
// silently does nothing is worse than a missing one.
//
// Every numeric control is a plain textbox (type "text") — no sliders, no
// dropdown of allowed values and no min/max clamps: whatever you type is what
// gets applied. A bare number in a px field gets the unit appended for
// convenience ("18" → "18px"); anything else passes through verbatim, so
// calc()/rem/em values work too. The layout boxes read a bare number as a
// percent and anything else as the CSS length it is.
//
// Two kinds of field have an EMPTY box as their default state, with a
// placeholder saying what applies instead — clearing the box is how you get back:
//   `inherits` — "follow another setting" (stored "inherit"); the placeholder
//                names it and its value.
//   `auto`     — "the app's own value" (stored "auto"); the placeholder shows it.
//                These are the v6 controls for things that never had one, so the
//                stylesheet keeps its own number, media queries and all, until
//                somebody types one.
// Neither writes its variable in that state — see applyStyleSettings.
//
// `spacing: true` marks the fields the Density presets are allowed to write.
const followsNotes = (key) => ({ label: "Notes", key });

const pxField = (key, label, hint, extra = {}) => ({ key, label, type: "text", unit: "px", probe: "font-size", hint, ...extra });
const lineField = (key, label, hint, extra = {}) => ({ key, label, type: "text", probe: "line-height", hint, ...extra });
const spacingField = (key, label, hint, extra = {}) => ({ key, label, type: "text", unit: "px", probe: "width", hint, spacing: true, ...extra });
const radiusField = (key, label, hint, extra = {}) => ({ key, label, type: "text", unit: "px", probe: "border-radius", hint, ...extra });
const headingFields = (prefix, where) => [1, 2, 3, 4, 5, 6].map((level) => ({
  key: `${prefix}${level}Scale`,
  label: `H${level} size`,
  type: "text",
  probe: "number",
  hint: `Heading ${level} ${where}, as a multiple of the text around it — 1 is the same size, 1.2 is a fifth bigger.`
}));

export const styleControlGroups = [
  // ── Theme & App ──────────────────────────────────────────────────────────
  {
    title: "Type",
    scope: "app",
    fields: [
      { key: "fontFamily", label: "Font", type: "select", options: fontFamilyOptions, groups: fontFamilyOptionGroups, hint: "Typeface for the whole app. Notes can choose their own under ◐ Notes." },
      // Written as <html>'s font-size, so every rem-sized label, menu and badge
      // in the chrome scales with it. 16px is the browser default, i.e. exactly
      // what the app looked like before this control existed.
      pxField("uiFontSize", "Interface size", "Size of menus, labels and other interface text.")
    ]
  },
  {
    title: "Buttons & inputs",
    scope: "app",
    fields: [
      { key: "toolbarButtonHeight", label: "Button height", type: "text", unit: "px", probe: "height", spacing: true, hint: "Icon buttons, Review/Prev/Next and the replay row." },
      pxField("buttonFontSize", "Button text size", "Text inside buttons."),
      spacingField("buttonGap", "Button gap", "Space between buttons."),
      { key: "inputHeight", label: "Input height", type: "text", unit: "px", probe: "height", hint: "Height of textboxes and selects." },
      radiusField("buttonCornerRadius", "Control corners", "Roundness of buttons, textboxes and selects.")
    ]
  },
  {
    title: "Layout",
    scope: "app",
    fields: [
      { key: "appWidthPercent", label: "App width", type: "text", probe: "length-percentage", hint: "Width of the whole app. A number is a percent of the screen; any CSS width works as written." },
      { key: "appHeightPercent", label: "App height", type: "text", probe: "length-percentage", hint: "Height of the whole app. A number is a percent of the screen; any CSS height works as written." },
      spacingField("appGap", "Main gap", "Space between major app sections.")
    ]
  },
  {
    title: "Dialogs",
    scope: "app",
    fields: [
      { key: "modalWidthPercent", label: "Dialog width", type: "text", probe: "length-percentage", hint: "Width of the Import and shared-file dialogs. A number is a percent of the screen; any CSS width works as written." },
      spacingField("modalPadding", "Dialog padding", "Inside spacing of the Import dialog."),
      radiusField("dialogCornerRadius", "Dialog corners", "Roundness of dialogs and panels: Import, Help, Storage, confirmations and this one.")
    ]
  },

  // ── Cards ────────────────────────────────────────────────────────────────
  {
    title: "Text",
    scope: "cards",
    fields: [
      pxField("baseFontSize", "Text size", "Card text, and Markdown outside the other sections (import previews, prints)."),
      lineField("baseLineHeight", "Line spacing", "Reading spacing for card text."),
      pxField("rawMarkdownFontSize", "Raw editor size", "Markdown while editing a card, and the import boxes."),
      pxField("codeFontSize", "Code size", "Code blocks on cards."),
      lineField("codeLineHeight", "Code line spacing", "Line spacing inside code blocks on cards.")
    ]
  },
  {
    title: "Question",
    scope: "cards",
    fields: [
      pxField("questionMaxFontSize", "Question size (max)", "Largest question size. Short questions grow up to this; long ones shrink."),
      lineField("questionLineHeight", "Question line spacing", "Line spacing for question text."),
      { key: "questionFontWeight", label: "Question weight", type: "text", probe: "font-weight", hint: "Question text thickness: 1 to 1000, or normal/bold." },
      { key: "questionAlign", label: "Question align", type: "select", options: ["left", "center", "right", "justify"], hint: "Question text alignment." },
      { key: "questionVerticalAlign", label: "Question vertical align", type: "select", options: ["start", "center", "end"], hint: "Question vertical position." },
      { key: "questionFillPercent", label: "Question fill %", type: "text", probe: "number", hint: "How much of the card the question tries to fill, as a percent." }
    ]
  },
  {
    title: "Answer",
    scope: "cards",
    fields: [
      pxField("answerFontSize", "Answer size", "Answer text size."),
      lineField("answerLineHeight", "Answer line spacing", "Line spacing on the answer side."),
      { key: "answerFontWeight", label: "Answer weight", type: "text", probe: "font-weight", hint: "Answer text thickness: 1 to 1000, or normal/bold." }
    ]
  },
  // Headings: one multiplier per level, of the text around the heading — not a
  // size, because the headings sit on their section's own Text size, so a ratio
  // keeps them "a little bigger than the words around them" whatever that is.
  // Not limited: 1 is text-sized, below 1 is smaller. styles/79-tab-text.css
  // applies them; Notes has its own six (below).
  {
    title: "Headings",
    scope: "cards",
    fields: headingFields("headingH", "on cards and in All Cards")
  },
  {
    title: "Card",
    scope: "cards",
    fields: [
      { key: "cardWidthPercent", label: "Card width", type: "text", probe: "length-percentage", hint: "Card width. A number is a percent of the study area; any CSS width works as written." },
      { key: "cardMaxHeightPercent", label: "Card max height", type: "text", probe: "length-percentage", hint: "Maximum card height. A number is a percent of the screen; any CSS height works as written." },
      spacingField("cardPadding", "Card padding", "Inside spacing on question and answer faces."),
      spacingField("cardContentGap", "Card label gap", "Space between the Question/Answer label and its content."),
      radiusField("cardCornerRadius", "Card corners", "Roundness of card corners."),
      { key: "cardBorderWidth", label: "Card border", type: "text", unit: "px", probe: "border-top-width", hint: "Border thickness around the card." },
      { key: "visualMaxWidthPercent", label: "Image max width", type: "text", probe: "length-percentage", hint: "Maximum width of images, videos and diagrams on cards. A number is a percent; any CSS width works as written." },
      spacingField("panelPadding", "Study panel padding", "Inside spacing of the panel around the card."),
      radiusField("panelCornerRadius", "Study panel corners", "Roundness of the panel around the card.")
    ]
  },

  // ── Notes ────────────────────────────────────────────────────────────────
  {
    title: "Text",
    scope: "notes",
    fields: [
      // A KEY into fontFamilyChoices rather than a font stack, so it is written
      // by hand in applyStyleSettings. "inherit" leaves --notes-font-family
      // aliasing --app-font-family.
      {
        key: "notesFontFamily", label: "Font", type: "select",
        options: ["inherit", ...fontFamilyOptions],
        groups: [{ label: "Notes", options: ["inherit"] }, ...fontFamilyOptionGroups],
        optionLabels: { inherit: "Same as Global font" },
        hint: "Typeface for notes only."
      },
      pxField("notesFontSize", "Text size", "Rendered notes text."),
      lineField("notesLineHeight", "Line spacing", "Reading spacing in notes."),
      { key: "notesFontWeight", label: "Weight", type: "text", probe: "font-weight", hint: "Notes text thickness: 1 to 1000, or normal/bold." },
      pxField("notesRawFontSize", "Raw editor size", "Markdown while editing notes."),
      pxField("notesCodeFontSize", "Code size", "Code blocks in notes."),
      lineField("notesCodeLineHeight", "Code line spacing", "Line spacing inside code blocks in notes."),
      pxField("notesTableFontSize", "Table text size", "Tables, and cards shown inside a note.")
    ]
  },
  {
    title: "Headings",
    scope: "notes",
    fields: [
      // Drives a CLASS on <html> and a flag the exports read, not a variable —
      // see src/notes/heading-numbers.js.
      {
        key: "headingNumbers", label: "Number headings", type: "select", options: ["on", "off"],
        optionLabels: { on: "On — 1, 1.1, 1.2…", off: "Off" },
        hint: "Numbers each heading by its place in the note, like 1, 1.1, 1.2. The numbers are only drawn: your text is not changed."
      },
      ...headingFields("notesHeadingH", "in notes, the Highlights pane, Quick Notes and text blocks on PDFs and Canvas")
    ]
  },
  {
    title: "Page",
    scope: "notes",
    fields: [
      // Drives a CLASS on #notesView, not a variable: the paged layout is a
      // different set of rules. See src/notes/paged-view.js.
      { key: "notesReadingMode", label: "Layout", type: "select", options: ["continuous", "paged-1", "paged-2"], hint: "Continuous scrolls the whole note. Paged lays it out in pages — one column, or two side by side." },
      { key: "notesMaxWidthPercent", label: "Column width", type: "text", probe: "length-percentage", hint: "Maximum width of the notes column. A number is a percent; 900px, 60ch or calc(…) work as written." },
      spacingField("notesPadding", "Padding", "Inside spacing around notes."),
      { key: "notesVisualMaxWidthPercent", label: "Image max width", type: "text", probe: "length-percentage", hint: "Maximum width of images, videos and diagrams in notes. A number is a percent; any CSS width works as written." },
      radiusField("notesFrameRadius", "Frame corners", "Roundness of the Notes frame, the contents drawers of Notes and PDFs, and the Highlights pane."),
      { key: "notesFrameBorder", label: "Frame border", type: "text", unit: "px", probe: "border-top-width", hint: "Border thickness around the Notes frame and the Highlights pane." }
    ]
  },

  // ── Highlights pane ──────────────────────────────────────────────────────
  // "inherit" on the three type fields means the same as notesFontFamily's:
  // applyStyleSettings does not write the variable at all, so the stylesheet's
  // fallback — the matching --notes-* value — applies.
  {
    title: "Text",
    scope: "highlightsPane",
    fields: [
      pxField("hlNoteFontSize", "Text size", "Notes in the side-by-side highlights pane; the cards scale with it. Leave empty to follow Notes.", { inherits: followsNotes("notesFontSize") }),
      lineField("hlNoteLineHeight", "Line spacing", "Reading spacing in the pane. Leave empty to follow Notes.", { inherits: followsNotes("notesLineHeight") }),
      { key: "hlNoteWeight", label: "Weight", type: "text", probe: "font-weight", inherits: followsNotes("notesFontWeight"), hint: "Text thickness in the pane. Leave empty to follow Notes." },
      { key: "hlQuoteFontSize", label: "Quoted line size", type: "text", probe: "font-size", hint: "The highlighted passage at the top of each card, relative to its note." },
      { key: "hlQuoteInkPercent", label: "Quoted line contrast %", type: "text", probe: "number", hint: "How strongly the quoted passage is inked against its note." }
    ]
  },
  {
    title: "Cards in the pane",
    scope: "highlightsPane",
    fields: [
      spacingField("hlCardPadding", "Padding", "Inside spacing on each highlight card."),
      spacingField("hlCardGap", "Gap", "Space between highlight cards."),
      radiusField("hlCardRadius", "Corners", "Roundness of a highlight card."),
      { key: "hlCardRail", label: "Colour rail", type: "text", unit: "px", probe: "border-top-width", hint: "Width of the coloured edge on each highlight card." },
      { key: "hlNoteEmptyHeight", label: "Empty note box height", type: "text", unit: "px", probe: "height", hint: "Height of the blank box on a highlight with no note yet." }
    ]
  },

  // ── Highlights in text ───────────────────────────────────────────────────
  {
    title: "Marks",
    scope: "marks",
    fields: [
      { key: "markTintPercent", label: "Tint strength %", type: "text", probe: "number", hint: "How strongly a highlight colours the words behind it. 100 is the usual; 50 is half as strong." },
      radiusField("markRadius", "Corners", "Roundness of a highlight's tint.", { auto: "3px" }),
      { key: "codeHighlightStrength", label: "On code", type: "select", options: ["subtle", "medium", "strong"], hint: "How strongly a highlight shows on code blocks." }
    ]
  },
  {
    title: "A highlight with a note",
    scope: "marks",
    fields: [
      {
        key: "markNoteUnderline", label: "Underline", type: "select", options: ["dotted", "dashed", "solid", "wavy", "none"],
        hint: "The line under a highlight that has a note."
      },
      { key: "markNoteUnderlineWidth", label: "Underline thickness", type: "text", unit: "px", probe: "border-top-width", auto: "1.5px", hint: "Thickness of that line." },
      { key: "markNoteFoldSize", label: "Note marker size", type: "text", probe: "width", auto: "0.36em", hint: "The folded corner on a highlight that has a note. em is relative to the text." }
    ]
  },

  // ── Highlight note window ────────────────────────────────────────────────
  {
    title: "Note window",
    scope: "noteEditor",
    fields: [
      pxField("noteEdTextSize", "Preview text size", "The note as it reads, in the window.", { auto: "0.88rem" }),
      lineField("noteEdLineHeight", "Preview line spacing", "Line spacing of the preview.", { auto: "1.4" }),
      pxField("noteEdRawFontSize", "Editor text size", "Markdown while writing the note."),
      { key: "noteEdWidth", label: "Width", type: "text", probe: "width", auto: "min(460px, 100vw - 24px)", hint: "How wide the window opens. Dragging its corner still sizes it; on a phone it is a sheet across the screen." },
      spacingField("noteEdPadding", "Padding", "Inside spacing of the window.", { auto: "12px", spacing: false }),
      radiusField("noteEdRadius", "Corners", "Roundness of the window.", { auto: "14px" })
    ]
  },

  // ── Contents ─────────────────────────────────────────────────────────────
  {
    title: "Contents drawer",
    scope: "toc",
    fields: [
      pxField("tocFontSize", "Text size", "Entries in the contents drawer of Notes and PDFs. Deeper levels stay a touch smaller.", { auto: "0.82rem" }),
      lineField("tocLineHeight", "Line spacing", "Line spacing of an entry that wraps.", { auto: "1.35" }),
      { key: "tocRowPadding", label: "Entry padding", type: "text", unit: "px", probe: "padding", auto: "3px 8px", hint: "Inside spacing of each entry: one value, or top/bottom then left/right." },
      { key: "tocWidth", label: "Drawer width", type: "text", probe: "width", auto: "min(300px, 82%)", hint: "Width of the drawer. Any CSS width works as written." }
    ]
  },

  // ── PDFs ─────────────────────────────────────────────────────────────────
  {
    title: "Text blocks",
    scope: "document",
    fields: [
      pxField("docBlockFontSize", "Text block size", "Text blocks on a PDF's pages. A block given its own size keeps it."),
      lineField("docBlockLineHeight", "Line spacing", "Line spacing inside text blocks."),
      pxField("docCodeFontSize", "Code size", "Code inside blocks and PDF notes. 1em is the size of the words around it."),
    ]
  },

  // ── Canvas ───────────────────────────────────────────────────────────────
  {
    title: "Text blocks",
    scope: "handwriting",
    fields: [
      pxField("canvasBlockFontSize", "Text block size", "Text blocks on Canvas pages. A block given its own size keeps it."),
      lineField("canvasBlockLineHeight", "Line spacing", "Line spacing inside text blocks."),
      pxField("canvasCodeFontSize", "Code size", "Code inside blocks. 1em is the size of the words around it."),
    ]
  },

  // ── All Cards ────────────────────────────────────────────────────────────
  {
    title: "The card list",
    scope: "allCards",
    fields: [
      pxField("allCardsFontSize", "Text size", "Questions and answers in the list.", { auto: "0.95rem" }),
      lineField("allCardsLineHeight", "Line spacing", "Line spacing in the list.", { auto: "1.45" })
    ]
  },

  // ── Quick Notes ──────────────────────────────────────────────────────────
  {
    title: "Quick Notes",
    scope: "quickNotes",
    fields: [
      pxField("qnFontSize", "Text size", "Text on each quick note.", { auto: "0.92rem" }),
      lineField("qnLineHeight", "Line spacing", "Line spacing on each quick note.", { auto: "1.5" }),
      { key: "qnCardPadding", label: "Padding", type: "text", unit: "px", probe: "padding", auto: "11px 13px", hint: "Inside spacing of each quick note: one value, or top/bottom then left/right." },
      radiusField("qnCardRadius", "Corners", "Roundness of each quick note.", { auto: "10px" }),
      { key: "qnColumnWidth", label: "Column width", type: "text", unit: "px", probe: "width", auto: "240px", hint: "The narrowest a column of quick notes gets before the board uses fewer columns." }
    ]
  },

  // ── Home ─────────────────────────────────────────────────────────────────
  {
    title: "Home",
    scope: "home",
    fields: [
      { key: "homeWidth", label: "Page width", type: "text", probe: "width", auto: "min(1040px, 100%)", hint: "How wide Home's content runs. Any CSS width works as written." },
      { key: "homeTileWidth", label: "File tile width", type: "text", unit: "px", probe: "width", auto: "190px", hint: "The narrowest a recent-file tile gets." },
      pxField("homeTitleSize", "File title size", "Titles on the recent-file tiles.", { auto: "0.98rem" }),
      radiusField("homeCardRadius", "Card corners", "Roundness of the Continue card and the reading-time card.")
    ]
  },

  // ── My Files ─────────────────────────────────────────────────────────────
  {
    title: "My Files",
    scope: "myFiles",
    fields: [
      { key: "myFilesWidth", label: "Panel width", type: "text", probe: "width", auto: "min(85vw, 1160px)", hint: "Width of the My Files panel. Any CSS width works as written." },
      pxField("myFilesTextSize", "List text size", "Text in the list view's rows.", { auto: "0.84rem" }),
      { key: "myFilesTileWidth", label: "Tile width", type: "text", unit: "px", probe: "width", auto: "190px", hint: "The narrowest a file or folder tile gets." },
      spacingField("myFilesPadding", "Padding", "Inside spacing of the My Files panel.")
    ]
  }
];

// Density presets: shortcuts that write the SPACING fields (`spacing: true`),
// never text — text sizes belong to their sections, and a spacing button that
// also re-sized the cards was the opposite of "clear-cut". Not stored: nothing
// reads these back, so pressing one is exactly typing its values by hand.
// Compact is the default; Comfortable is what the defaults were before v5. The
// per-section panel paddings (v6) take the panel value, so Density still moves
// every section's spacing together, as it always has.
const withSections = (preset) => ({
  ...preset,
  myFilesPadding: preset.modalPadding
});

export const styleDensityPresets = {
  desktop: {
    compact:     withSections({ appGap: "6px",  panelPadding: "6px",  cardPadding: "16px", cardContentGap: "10px", notesPadding: "4px",  hlCardPadding: "8px",  hlCardGap: "12px", modalPadding: "12px", buttonGap: "6px",  toolbarButtonHeight: "38px" }),
    comfortable: withSections({ appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", notesPadding: "6px",  hlCardPadding: "11px", hlCardGap: "20px", modalPadding: "18px", buttonGap: "8px",  toolbarButtonHeight: "38px" }),
    large:       withSections({ appGap: "14px", panelPadding: "14px", cardPadding: "32px", cardContentGap: "22px", notesPadding: "12px", hlCardPadding: "14px", hlCardGap: "26px", modalPadding: "24px", buttonGap: "11px", toolbarButtonHeight: "44px" })
  },
  mobile: {
    compact:     withSections({ appGap: "6px",  panelPadding: "6px",  cardPadding: "16px", cardContentGap: "10px", notesPadding: "4px",  hlCardPadding: "8px",  hlCardGap: "12px", modalPadding: "12px", buttonGap: "6px",  toolbarButtonHeight: "34px" }),
    comfortable: withSections({ appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", notesPadding: "4px",  hlCardPadding: "10px", hlCardGap: "16px", modalPadding: "18px", buttonGap: "8px",  toolbarButtonHeight: "34px" }),
    large:       withSections({ appGap: "13px", panelPadding: "13px", cardPadding: "30px", cardContentGap: "20px", notesPadding: "10px", hlCardPadding: "13px", hlCardGap: "22px", modalPadding: "22px", buttonGap: "10px", toolbarButtonHeight: "40px" })
  }
};

export const styleFieldByKey = styleControlGroups.reduce((fields, group) => {
  group.fields.forEach((field) => {
    fields[field.key] = { ...field, scope: group.scope };
  });
  return fields;
}, {});

// The keys of one section, in the order its popover shows them.
export function styleScopeKeys(scope) {
  return styleControlGroups.filter((group) => group.scope === scope).flatMap((group) => group.fields.map((field) => field.key));
}

// key → the CSS variable it writes verbatim. Percent keys are deliberately
// ABSENT: they were mapped to `--*-percent` variables no rule ever read, while
// the value that actually did the work was the derived `--app-width: 100vw`
// etc. set further down in applyStyleSettings. Two variables per setting, one
// of them a decoy, is how "why doesn't this slider do anything" starts.
//
// An `inherits` or `auto` field in its empty state is REMOVED rather than
// written (applyStyleSettings), so every rule that reads one of those carries
// its own fallback: `var(--hl-note-font-size, var(--notes-font-size))`,
// `var(--toc-font-size, 0.82rem)`.
export const styleCssVariables = {
  baseFontSize: "--content-font-size",
  baseLineHeight: "--content-line-height",
  rawMarkdownFontSize: "--raw-markdown-font-size",
  codeFontSize: "--code-font-size",
  codeLineHeight: "--code-line-height",
  questionMaxFontSize: "--question-max-font-size",
  questionLineHeight: "--question-line-height",
  questionAlign: "--question-align",
  questionVerticalAlign: "--question-vertical-align",
  questionFontWeight: "--question-font-weight",
  answerFontSize: "--answer-font-size",
  answerLineHeight: "--answer-line-height",
  answerFontWeight: "--answer-font-weight",
  notesFontSize: "--notes-font-size",
  notesLineHeight: "--notes-line-height",
  notesFontWeight: "--notes-font-weight",
  notesPadding: "--notes-padding",
  headingH1Scale: "--heading-h1-scale",
  headingH2Scale: "--heading-h2-scale",
  headingH3Scale: "--heading-h3-scale",
  headingH4Scale: "--heading-h4-scale",
  headingH5Scale: "--heading-h5-scale",
  headingH6Scale: "--heading-h6-scale",
  // Per-section text. Each is re-pointed onto the shared variable inside its own
  // surface by styles/79-tab-text.css.
  notesRawFontSize: "--notes-raw-font-size",
  notesCodeFontSize: "--notes-code-font-size",
  notesCodeLineHeight: "--notes-code-line-height",
  notesTableFontSize: "--notes-table-font-size",
  notesHeadingH1Scale: "--notes-heading-h1-scale",
  notesHeadingH2Scale: "--notes-heading-h2-scale",
  notesHeadingH3Scale: "--notes-heading-h3-scale",
  notesHeadingH4Scale: "--notes-heading-h4-scale",
  notesHeadingH5Scale: "--notes-heading-h5-scale",
  notesHeadingH6Scale: "--notes-heading-h6-scale",
  notesFrameRadius: "--notes-frame-radius",
  notesFrameBorder: "--notes-frame-border",
  docBlockFontSize: "--doc-block-font-size",
  docBlockLineHeight: "--doc-block-line-height",
  docCodeFontSize: "--doc-code-font-size",
  canvasBlockFontSize: "--canvas-block-font-size",
  canvasBlockLineHeight: "--canvas-block-line-height",
  canvasCodeFontSize: "--canvas-code-font-size",
  // The highlights pane. The three type fields default to "inherit", which
  // applyStyleSettings expresses by removing the property so the stylesheet's
  // --notes-* fallback applies. hlQuoteInkPercent is not here: it stores a bare
  // number that has to become "${n}%" — hand-written beside notesMaxWidthPercent.
  hlNoteFontSize: "--hl-note-font-size",
  hlNoteLineHeight: "--hl-note-line-height",
  hlNoteWeight: "--hl-note-weight",
  hlQuoteFontSize: "--hl-quote-font-size",
  hlCardPadding: "--hl-card-padding",
  hlCardGap: "--hl-card-gap",
  hlCardRadius: "--hl-card-radius",
  hlCardRail: "--hl-card-rail",
  hlNoteEmptyHeight: "--hl-note-empty-height",
  // Highlights in text. markTintPercent and markNoteUnderline are hand-written
  // (a number that becomes a factor; a choice that becomes two properties).
  markRadius: "--mark-radius",
  markNoteUnderlineWidth: "--mark-note-underline-width",
  markNoteFoldSize: "--mark-note-fold-size",
  // Highlight note window
  noteEdTextSize: "--note-ed-text-size",
  noteEdLineHeight: "--note-ed-line-height",
  noteEdRawFontSize: "--note-ed-raw-font-size",
  noteEdWidth: "--note-ed-width",
  noteEdPadding: "--note-ed-padding",
  noteEdRadius: "--note-ed-radius",
  // Contents
  tocFontSize: "--toc-font-size",
  tocLineHeight: "--toc-line-height",
  tocRowPadding: "--toc-row-padding",
  tocWidth: "--toc-width-setting",
  // All Cards
  allCardsFontSize: "--all-cards-font-size",
  allCardsLineHeight: "--all-cards-line-height",
  // Quick Notes
  qnFontSize: "--qn-font-size",
  qnLineHeight: "--qn-line-height",
  qnCardPadding: "--qn-card-padding",
  qnCardRadius: "--qn-card-radius",
  qnColumnWidth: "--qn-column-width",
  // Home
  homeWidth: "--home-width",
  homeTileWidth: "--home-tile-width",
  homeTitleSize: "--home-title-size",
  homeCardRadius: "--home-card-radius",
  // My Files
  myFilesWidth: "--my-files-width",
  myFilesTextSize: "--my-files-text-size",
  myFilesTileWidth: "--my-files-tile-width",
  myFilesPadding: "--my-files-padding",
  // App
  dialogCornerRadius: "--dialog-corner-radius",
  appGap: "--app-gap",
  panelPadding: "--panel-padding",
  cardPadding: "--card-face-padding",
  cardContentGap: "--card-face-gap",
  buttonGap: "--toolbar-gap",
  cardBorderWidth: "--card-border-width",
  cardCornerRadius: "--card-radius",
  panelCornerRadius: "--panel-corner-radius",
  buttonCornerRadius: "--toolbar-button-radius",
  toolbarButtonHeight: "--toolbar-button-height",
  buttonFontSize: "--button-font-size",
  inputHeight: "--input-height",
  modalPadding: "--modal-padding"
};

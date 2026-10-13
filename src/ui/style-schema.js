// What a style setting IS: the defaults, the controls that edit each one, and
// the CSS variable each writes.
//
// Data only — no behaviour. The panel that renders these and the code that
// applies them live elsewhere, which is what lets this be read without
// understanding either.

import { fontFamilyOptionGroups, fontFamilyOptions } from "./theme-catalog.js?v=__BUILD__";

// One entry per control in styleControlGroups, per profile — nothing more.
// Keys the panel doesn't expose used to accumulate here (stackCard*,
// sidePanelWidthPercent, the per-face font families) and normalizeStyleSettings
// iterates THIS object, so a stale key is a setting the app carries around, syncs
// to Supabase and back-fills from the wrong profile, while doing nothing at all.
// Ordered to match the panel so the two can be checked against each other.
export const defaultStyleProfiles = {
  "mobile": {
    // Global
    "fontFamily": "system",
    "uiFontSize": "16px",
    "headingH1Scale": "1.2",
    "headingH2Scale": "1.12",
    "headingH3Scale": "1.06",
    "headingH4Scale": "1",
    "headingH5Scale": "1",
    "headingH6Scale": "1",
    // Text — Cards
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
    // Text — Notes. The three code/raw sizes are seeded from the Cards ones on
    // the v5 upgrade, so a note looks exactly as it did before it had its own.
    "notesFontFamily": "inherit",
    "notesFontSize": "15px",
    "notesLineHeight": "1.5",
    "notesRawFontSize": "16px",
    "notesCodeFontSize": "12px",
    "notesCodeLineHeight": "1.17",
    // Text — Highlights
    "hlNoteFontSize": "inherit",
    "hlNoteLineHeight": "inherit",
    "hlQuoteFontSize": "0.95em",
    // Text — PDF / Write
    "docBlockFontSize": "0.82rem",
    "docBlockLineHeight": "1.4",
    "docCodeFontSize": "1em",
    // Spacing — tight by default (v5). The old roomier values are the
    // "Comfortable" density preset.
    "appGap": "6px",
    "panelPadding": "6px",
    "cardPadding": "16px",
    "cardContentGap": "10px",
    "buttonGap": "6px",
    "notesPadding": "4px",
    "hlCardPadding": "8px",
    "hlCardGap": "12px",
    "modalPadding": "12px",
    // Controls. Heights stay where they were: a tap target is not padding.
    "toolbarButtonHeight": "34px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "buttonCornerRadius": "8px",
    // More
    "notesReadingMode": "continuous",
    "notesMaxWidthPercent": "100",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "cardWidthPercent": "96",
    "cardMaxHeightPercent": "80",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "90",
    "questionFillPercent": "75",
    "questionAlign": "left",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerFontWeight": "300",
    "notesFontWeight": "400",
    "hlNoteWeight": "inherit",
    "hlQuoteInkPercent": "74",
    "codeHighlightStrength": "medium",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "cardBorderWidth": "1px",
    "hlCardRadius": "10px",
    "hlCardRail": "3px",
    "hlNoteEmptyHeight": "18px"
  },
  "desktop": {
    // Global
    "fontFamily": "system",
    "uiFontSize": "16px",
    "headingH1Scale": "1.2",
    "headingH2Scale": "1.12",
    "headingH3Scale": "1.06",
    "headingH4Scale": "1",
    "headingH5Scale": "1",
    "headingH6Scale": "1",
    // Text — Cards
    "baseFontSize": "18px",
    "baseLineHeight": "1.58",
    "questionMaxFontSize": "19px",
    "questionLineHeight": "1.18",
    "answerFontSize": "23px",
    "answerLineHeight": "1.58",
    "rawMarkdownFontSize": "18px",
    "codeFontSize": "18px",
    "codeLineHeight": "1.55",
    // Text — Notes
    "notesFontFamily": "inherit",
    "notesFontSize": "18px",
    "notesLineHeight": "1.58",
    "notesRawFontSize": "18px",
    "notesCodeFontSize": "18px",
    "notesCodeLineHeight": "1.55",
    // Text — Highlights
    "hlNoteFontSize": "inherit",
    "hlNoteLineHeight": "inherit",
    "hlQuoteFontSize": "0.95em",
    // Text — PDF / Write
    "docBlockFontSize": "0.82rem",
    "docBlockLineHeight": "1.4",
    "docCodeFontSize": "1em",
    // Spacing — tight by default (v5)
    "appGap": "6px",
    "panelPadding": "6px",
    "cardPadding": "16px",
    "cardContentGap": "10px",
    "buttonGap": "6px",
    "notesPadding": "4px",
    "hlCardPadding": "8px",
    "hlCardGap": "12px",
    "modalPadding": "12px",
    // Controls
    "toolbarButtonHeight": "38px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "buttonCornerRadius": "8px",
    // More
    "notesReadingMode": "continuous",
    "notesMaxWidthPercent": "100",
    "appWidthPercent": "100",
    "appHeightPercent": "100",
    "cardWidthPercent": "100",
    "cardMaxHeightPercent": "84",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "50",
    "questionFillPercent": "58",
    "questionAlign": "center",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    "answerFontWeight": "400",
    "notesFontWeight": "400",
    "hlNoteWeight": "inherit",
    "hlQuoteInkPercent": "74",
    "codeHighlightStrength": "medium",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "cardBorderWidth": "1px",
    "hlCardRadius": "10px",
    "hlCardRail": "3px",
    "hlNoteEmptyHeight": "18px"
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

export const styleDefaults = defaultStyleProfiles.desktop;

// ── The panel ───────────────────────────────────────────────────────────────
//
// Three sections and a fold, nothing else:
//
//   global  — the app's typeface and the size every rem in the chrome hangs off.
//   text    — one group per TAB (`tab`), shown one at a time behind a tab row.
//             Each holds every text element of that surface: rendered text, the
//             raw editor, code, line spacing. A tab's code and raw sizes are its
//             own — styles/79-tab-text.css re-points the shared variables inside
//             each surface — so tuning Notes' code no longer moves the cards'.
//   spacing — padding, gaps and the control family (buttons, inputs). Tight by
//             default, with the Density presets as shortcuts.
//   more    — everything that is not a size: widths, weights, alignment, corner
//             radii, the notes page layout. Kept, folded shut.
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
// `inherits` marks a field whose default is "follow another setting". Its box
// is EMPTY in that state, with a placeholder naming what it follows and that
// value — so clearing the box is how you get back to it, and nobody has to know
// the word "inherit" exists. (Typing "inherit" still works.)
const followsNotes = (key) => ({ label: "Notes", key });

export const styleTextTabs = [
  { id: "cards", label: "Cards" },
  { id: "notes", label: "Notes" },
  { id: "highlights", label: "Highlights" },
  { id: "document", label: "PDF / Write" }
];

export const styleControlGroups = [
  {
    title: "Global",
    section: "global",
    fields: [
      { key: "fontFamily", label: "Font", type: "select", options: fontFamilyOptions, groups: fontFamilyOptionGroups, hint: "Typeface for the whole app — cards, notes and chrome." },
      // Written as <html>'s font-size, so every rem-sized label, menu and badge
      // in the chrome scales with it. 16px is the browser default, i.e. exactly
      // what the app looked like before this control existed.
      { key: "uiFontSize", label: "Interface size", type: "text", unit: "px", probe: "font-size", hint: "Size of menus, labels and other interface text." }

    ]
  },
  // Headings: one multiplier per level, of the text around the heading — not
  // a size, because every tab's headings sit on that tab's own Text size, so a
  // ratio keeps them "a little bigger than the words around them" whatever each
  // tab is set to. Not limited: 1 is text-sized, below 1 is smaller.
  // styles/79-tab-text.css applies them.
  {
    title: "Headings",
    section: "global",
    fields: [1, 2, 3, 4, 5, 6].map((level) => ({
      key: `headingH${level}Scale`,
      label: `H${level} size`,
      type: "text",
      probe: "number",
      hint: `Heading ${level} as a multiple of the text around it — 1 is the same size, 1.2 is a fifth bigger.`
    }))
  },
  {
    title: "Cards",
    section: "text",
    tab: "cards",
    fields: [
      { key: "baseFontSize", label: "Text size", type: "text", unit: "px", probe: "font-size", hint: "Card text, the card list and general Markdown." },
      { key: "baseLineHeight", label: "Line spacing", type: "text", probe: "line-height", hint: "Reading spacing for card text." },
      { key: "questionMaxFontSize", label: "Question size (max)", type: "text", unit: "px", probe: "font-size", hint: "Largest question size. Short questions grow up to this; long ones shrink." },
      { key: "questionLineHeight", label: "Question line spacing", type: "text", probe: "line-height", hint: "Line spacing for question text." },
      { key: "answerFontSize", label: "Answer size", type: "text", unit: "px", probe: "font-size", hint: "Answer text size." },
      { key: "answerLineHeight", label: "Answer line spacing", type: "text", probe: "line-height", hint: "Line spacing on the answer side." },
      { key: "rawMarkdownFontSize", label: "Raw editor size", type: "text", unit: "px", probe: "font-size", hint: "Markdown while editing a card, and the import boxes." },
      { key: "codeFontSize", label: "Code size", type: "text", unit: "px", probe: "font-size", hint: "Code blocks on cards." },
      { key: "codeLineHeight", label: "Code line spacing", type: "text", probe: "line-height", hint: "Line spacing inside code blocks on cards." }
    ]
  },
  {
    title: "Notes",
    section: "text",
    tab: "notes",
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
      { key: "notesFontSize", label: "Text size", type: "text", unit: "px", probe: "font-size", hint: "Rendered notes text." },
      { key: "notesLineHeight", label: "Line spacing", type: "text", probe: "line-height", hint: "Reading spacing in notes." },
      { key: "notesRawFontSize", label: "Raw editor size", type: "text", unit: "px", probe: "font-size", hint: "Markdown while editing notes." },
      { key: "notesCodeFontSize", label: "Code size", type: "text", unit: "px", probe: "font-size", hint: "Code blocks in notes." },
      { key: "notesCodeLineHeight", label: "Code line spacing", type: "text", probe: "line-height", hint: "Line spacing inside code blocks in notes." }
    ]
  },
  // "inherit" on the two type fields means the same as notesFontFamily's:
  // applyStyleSettings does not write the variable at all, so the stylesheet's
  // fallback — the matching --notes-* value — applies.
  {
    title: "Highlights",
    section: "text",
    tab: "highlights",
    fields: [
      { key: "hlNoteFontSize", label: "Text size", type: "text", unit: "px", probe: "font-size", inherits: followsNotes("notesFontSize"), hint: "Notes in the side-by-side highlights pane; the cards scale with it. Leave empty to follow Notes." },
      { key: "hlNoteLineHeight", label: "Line spacing", type: "text", probe: "line-height", inherits: followsNotes("notesLineHeight"), hint: "Reading spacing in the pane. Leave empty to follow Notes." },
      { key: "hlQuoteFontSize", label: "Quoted line size", type: "text", probe: "font-size", hint: "The highlighted passage at the top of each card, relative to its note." }
    ]
  },
  {
    title: "PDF / Write",
    section: "text",
    tab: "document",
    fields: [
      { key: "docBlockFontSize", label: "Text block size", type: "text", unit: "px", probe: "font-size", hint: "Text blocks on PDF and handwriting pages. A block given its own size keeps it." },
      { key: "docBlockLineHeight", label: "Line spacing", type: "text", probe: "line-height", hint: "Line spacing inside text blocks." },
      { key: "docCodeFontSize", label: "Code size", type: "text", unit: "px", probe: "font-size", hint: "Code inside blocks and PDF notes. 1em is the size of the words around it." }
    ]
  },
  {
    title: "Spacing",
    section: "spacing",
    fields: [
      { key: "appGap", label: "Main gap", type: "text", unit: "px", probe: "width", hint: "Space between major app sections." },
      { key: "panelPadding", label: "Panel padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing of the study panel." },
      { key: "cardPadding", label: "Card padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing on question and answer faces." },
      { key: "cardContentGap", label: "Card label gap", type: "text", unit: "px", probe: "width", hint: "Space between the Question/Answer label and its content." },
      { key: "notesPadding", label: "Notes padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing around notes." },
      { key: "hlCardPadding", label: "Highlight card padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing on each highlight card." },
      { key: "hlCardGap", label: "Highlight card gap", type: "text", unit: "px", probe: "width", hint: "Space between highlight cards." },
      { key: "modalPadding", label: "Dialog padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing of the import and My Decks panels." }
    ]
  },
  {
    title: "Controls",
    section: "spacing",
    fields: [
      { key: "toolbarButtonHeight", label: "Button height", type: "text", unit: "px", probe: "height", hint: "Icon buttons, Review/Prev/Next and the replay row." },
      { key: "buttonFontSize", label: "Button text size", type: "text", unit: "px", probe: "font-size", hint: "Text inside buttons." },
      { key: "buttonGap", label: "Button gap", type: "text", unit: "px", probe: "width", hint: "Space between buttons." },
      { key: "inputHeight", label: "Input height", type: "text", unit: "px", probe: "height", hint: "Height of textboxes and selects." },
      { key: "buttonCornerRadius", label: "Control corners", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of buttons, textboxes and selects." }
    ]
  },
  {
    title: "Layout",
    section: "more",
    fields: [
      // Drives a CLASS on #notesView, not a variable: the paged layout is a
      // different set of rules. See src/notes/paged-view.js.
      { key: "notesReadingMode", label: "Notes layout", type: "select", options: ["continuous", "paged-1", "paged-2"], hint: "Continuous scrolls the whole note. Paged lays it out in pages — one column, or two side by side." },
      { key: "notesMaxWidthPercent", label: "Notes width", type: "text", probe: "length-percentage", hint: "Maximum width of the notes column. A number is a percent; 900px, 60ch or calc(…) work as written." },
      { key: "appWidthPercent", label: "App width", type: "text", probe: "length-percentage", hint: "Width of the whole app. A number is a percent of the screen; any CSS width works as written." },
      { key: "appHeightPercent", label: "App height", type: "text", probe: "length-percentage", hint: "Height of the whole app. A number is a percent of the screen; any CSS height works as written." },
      { key: "cardWidthPercent", label: "Card width", type: "text", probe: "length-percentage", hint: "Flashcard width. A number is a percent of the study area; any CSS width works as written." },
      { key: "cardMaxHeightPercent", label: "Card max height", type: "text", probe: "length-percentage", hint: "Maximum flashcard height. A number is a percent of the screen; any CSS height works as written." },
      { key: "modalWidthPercent", label: "Dialog width", type: "text", probe: "length-percentage", hint: "Width of the Import and shared-deck dialogs (My Decks sizes itself to its table). A number is a percent of the screen; any CSS width works as written." },
      { key: "visualMaxWidthPercent", label: "Image max width", type: "text", probe: "length-percentage", hint: "Maximum width of images, videos and diagrams. A number is a percent; any CSS width works as written." },
      { key: "questionFillPercent", label: "Question fill %", type: "text", probe: "number", hint: "How much of the card the question tries to fill, as a percent." }
    ]
  },
  {
    title: "Weight and alignment",
    section: "more",
    fields: [
      { key: "questionAlign", label: "Question align", type: "select", options: ["left", "center", "right", "justify"], hint: "Question text alignment." },
      { key: "questionVerticalAlign", label: "Question vertical align", type: "select", options: ["start", "center", "end"], hint: "Question vertical position." },
      { key: "questionFontWeight", label: "Question weight", type: "text", probe: "font-weight", hint: "Question text thickness: 1 to 1000, or normal/bold." },
      { key: "answerFontWeight", label: "Answer weight", type: "text", probe: "font-weight", hint: "Answer text thickness: 1 to 1000, or normal/bold." },
      { key: "notesFontWeight", label: "Notes weight", type: "text", probe: "font-weight", hint: "Notes text thickness: 1 to 1000, or normal/bold." },
      { key: "hlNoteWeight", label: "Highlight note weight", type: "text", probe: "font-weight", inherits: followsNotes("notesFontWeight"), hint: "Text thickness in the highlights pane. Leave empty to follow Notes." },
      { key: "hlQuoteInkPercent", label: "Quoted line contrast %", type: "text", probe: "number", hint: "How strongly the quoted passage is inked against its note." },
      { key: "codeHighlightStrength", label: "Code highlight strength", type: "select", options: ["subtle", "medium", "strong"], hint: "How strongly a highlight shows on code blocks." }
    ]
  },
  {
    title: "Shape",
    section: "more",
    fields: [
      { key: "cardCornerRadius", label: "Card corners", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of flashcard corners." },
      { key: "panelCornerRadius", label: "Panel corners", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of the study, import and My Decks panels." },
      { key: "cardBorderWidth", label: "Card border", type: "text", unit: "px", probe: "border-top-width", hint: "Border thickness around the flashcard." },
      { key: "hlCardRadius", label: "Highlight card corners", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of a highlight card." },
      { key: "hlCardRail", label: "Highlight colour rail", type: "text", unit: "px", probe: "border-top-width", hint: "Width of the coloured edge on each highlight card." },
      { key: "hlNoteEmptyHeight", label: "Empty note box height", type: "text", unit: "px", probe: "height", hint: "Height of the blank box on a highlight with no note yet." }
    ]
  }
];

// Density presets: shortcuts that write the SPACING and CONTROL fields, never
// text — text sizes belong to their tabs now, and a spacing button that also
// re-sized the cards was the opposite of "clear-cut". Not stored: nothing reads
// these back, so pressing one is exactly typing its values by hand. Compact is
// the default; Comfortable is what the defaults were before v5.
export const styleDensityPresets = {
  desktop: {
    compact:     { appGap: "6px",  panelPadding: "6px",  cardPadding: "16px", cardContentGap: "10px", notesPadding: "4px",  hlCardPadding: "8px",  hlCardGap: "12px", modalPadding: "12px", buttonGap: "6px",  toolbarButtonHeight: "38px" },
    comfortable: { appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", notesPadding: "6px",  hlCardPadding: "11px", hlCardGap: "20px", modalPadding: "18px", buttonGap: "8px",  toolbarButtonHeight: "38px" },
    large:       { appGap: "14px", panelPadding: "14px", cardPadding: "32px", cardContentGap: "22px", notesPadding: "12px", hlCardPadding: "14px", hlCardGap: "26px", modalPadding: "24px", buttonGap: "11px", toolbarButtonHeight: "44px" }
  },
  mobile: {
    compact:     { appGap: "6px",  panelPadding: "6px",  cardPadding: "16px", cardContentGap: "10px", notesPadding: "4px",  hlCardPadding: "8px",  hlCardGap: "12px", modalPadding: "12px", buttonGap: "6px",  toolbarButtonHeight: "34px" },
    comfortable: { appGap: "10px", panelPadding: "10px", cardPadding: "24px", cardContentGap: "16px", notesPadding: "4px",  hlCardPadding: "10px", hlCardGap: "16px", modalPadding: "18px", buttonGap: "8px",  toolbarButtonHeight: "34px" },
    large:       { appGap: "13px", panelPadding: "13px", cardPadding: "30px", cardContentGap: "20px", notesPadding: "10px", hlCardPadding: "13px", hlCardGap: "22px", modalPadding: "22px", buttonGap: "10px", toolbarButtonHeight: "40px" }
  }
};

export const styleFieldByKey = styleControlGroups.reduce((fields, group) => {
  group.fields.forEach((field) => {
    fields[field.key] = field;
  });
  return fields;
}, {});

// key → the CSS variable it writes verbatim. Percent keys are deliberately
// ABSENT: they were mapped to `--*-percent` variables no rule ever read, while
// the value that actually did the work was the derived `--app-width: 100vw`
// etc. set further down in applyStyleSettings. Two variables per setting, one
// of them a decoy, is how "why doesn't this slider do anything" starts.
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
  // Per-tab text. Each is re-pointed onto the shared variable inside its own
  // surface by styles/79-tab-text.css.
  notesRawFontSize: "--notes-raw-font-size",
  notesCodeFontSize: "--notes-code-font-size",
  notesCodeLineHeight: "--notes-code-line-height",
  docBlockFontSize: "--doc-block-font-size",
  docBlockLineHeight: "--doc-block-line-height",
  docCodeFontSize: "--doc-code-font-size",
  // The highlights pane. The three type fields are NOT here — they default to
  // "inherit", which applyStyleSettings expresses by removing the property so
  // the stylesheet's --notes-* fallback applies, and the generic loop below can
  // only ever write. hlQuoteInkPercent is not here either: it stores a bare
  // number that has to become "${n}%". All four are hand-written beside
  // notesFontFamily and notesMaxWidthPercent, which are absent for the same two
  // reasons.
  hlQuoteFontSize: "--hl-quote-font-size",
  hlCardPadding: "--hl-card-padding",
  hlCardGap: "--hl-card-gap",
  hlCardRadius: "--hl-card-radius",
  hlCardRail: "--hl-card-rail",
  hlNoteEmptyHeight: "--hl-note-empty-height",
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

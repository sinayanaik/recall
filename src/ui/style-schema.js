// What a style setting IS: the defaults, the controls that edit each one, and
// the CSS variable each writes.
//
// Data only — no behaviour. The panel that renders these and the code that
// applies them live elsewhere, which is what lets this be read without
// understanding either.

// One entry per control in styleControlGroups, per profile — nothing more.
// Keys the panel doesn't expose used to accumulate here (stackCard*,
// sidePanelWidthPercent, the per-face font families) and normalizeStyleSettings
// iterates THIS object, so a stale key is a setting the app carries around, syncs
// to Supabase and back-fills from the wrong profile, while doing nothing at all.
// Ordered to match the panel so the two can be checked against each other.
export const defaultStyleProfiles = {
  "mobile": {
    // Basics
    "notesReadingMode": "continuous",
    "fontFamily": "system",
    "baseFontSize": "12px",
    "baseLineHeight": "1.23",
    "notesFontSize": "15px",
    "notesMaxWidthPercent": "100",
    "answerFontSize": "13px",
    "questionMaxFontSize": "23px",
    "appWidthPercent": "100",
    // Layout
    "appHeightPercent": "100",
    "cardWidthPercent": "96",
    "cardMaxHeightPercent": "80",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "90",
    // Spacing and shape
    "appGap": "10px",
    "panelPadding": "10px",
    "cardPadding": "24px",
    "cardContentGap": "16px",
    "buttonGap": "8px",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "buttonCornerRadius": "8px",
    "cardBorderWidth": "1px",
    // Question
    "questionFillPercent": "75",
    "questionLineHeight": "1.17",
    "questionAlign": "left",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    // Answer and notes
    "answerLineHeight": "1.58",
    "answerFontWeight": "300",
    "notesLineHeight": "1.5",
    "notesFontWeight": "400",
    "notesPadding": "4px",
    // Controls and text
    // 34px, not desktop's 38: this now drives the Review/Prev/Next row too,
    // which the old hardcoded mobile override pinned at exactly 34px.
    "toolbarButtonHeight": "34px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "modalPadding": "18px",
    "rawMarkdownFontSize": "16px",
    // Matches baseFontSize: --code-font-size had NO consumer until now, so every
    // stored value for it is noise — see migrateLegacyStyleSettings, which
    // rewrites it rather than letting anyone's code blocks suddenly shrink.
    "codeFontSize": "12px",
    "codeLineHeight": "1.17"
  },
  "desktop": {
    // Basics
    "notesReadingMode": "continuous",
    "fontFamily": "system",
    "baseFontSize": "18px",
    "baseLineHeight": "1.58",
    "notesFontSize": "18px",
    "notesMaxWidthPercent": "100",
    "answerFontSize": "23px",
    "questionMaxFontSize": "19px",
    "appWidthPercent": "100",
    // Layout
    "appHeightPercent": "100",
    "cardWidthPercent": "100",
    "cardMaxHeightPercent": "84",
    "modalWidthPercent": "60",
    "visualMaxWidthPercent": "50",
    // Spacing and shape
    "appGap": "10px",
    "panelPadding": "10px",
    "cardPadding": "24px",
    "cardContentGap": "16px",
    "buttonGap": "8px",
    "cardCornerRadius": "14px",
    "panelCornerRadius": "14px",
    "buttonCornerRadius": "8px",
    "cardBorderWidth": "1px",
    // Question
    "questionFillPercent": "58",
    "questionLineHeight": "1.18",
    "questionAlign": "center",
    "questionVerticalAlign": "center",
    "questionFontWeight": "500",
    // Answer and notes
    "answerLineHeight": "1.58",
    "answerFontWeight": "400",
    "notesLineHeight": "1.58",
    "notesFontWeight": "400",
    "notesPadding": "6px",
    // Controls and text
    "toolbarButtonHeight": "38px",
    "buttonFontSize": "14px",
    "inputHeight": "40px",
    "modalPadding": "18px",
    "rawMarkdownFontSize": "18px",
    "codeFontSize": "18px",
    "codeLineHeight": "1.55"
  },
  "version": 2
};

export const styleDefaults = defaultStyleProfiles.desktop;

// The panel is two tiers. `basic` groups render as a plain always-visible list
// at the top — the handful of settings people actually reach for. Everything
// else is `advanced`: still here, still per-profile, but folded behind one
// disclosure so the panel opens as something you can read rather than 40-odd
// sliders across seven accordions.
//
// `basic` is now Theme, Density and Font/Text size, and nothing else. It used to
// carry eight fields, which meant the "short visible list" was still a wall of
// textboxes before you'd expanded anything. The six that moved out (line
// spacing, notes/answer/question sizes, the two width percents) are one click
// away under Advanced → Text; no control was removed and no stored value
// changed, so there is nothing to migrate.
//
// Nothing in here may write a CSS variable no stylesheet reads. Several
// controls used to: "Code font size" drove --code-font-size while .rendered pre
// was hardcoded to font-size:1em, and three of the four font pickers were
// overwritten by resolveFontFamily before anything could inherit them. A
// control that silently does nothing is worse than a missing one, because you
// spend your time deciding it's your eyes rather than the app.
// Every numeric control is a plain textbox (type "text") — no sliders and no
// min/max clamps: whatever you type is what gets applied. A bare number in a
// px field gets the unit appended for convenience ("18" → "18px"); anything
// else passes through verbatim, so calc()/rem/vh values work too.
export const styleControlGroups = [
  {
    title: "Basics",
    tier: "basic",
    fields: [
      // Not in styleCssVariables: this one drives a CLASS on #notesView, not a
      // variable, because the paged layout is a different set of rules rather
      // than a different number. See src/notes/paged-view.js.
      { key: "notesReadingMode", label: "Notes layout", type: "select", options: ["continuous", "paged-1", "paged-2"], hint: "Continuous scrolls the whole note. Paged lays it out in fixed pages you turn — one column, or two side by side like a book." },
      { key: "fontFamily", label: "Font", type: "select", options: ["system", "serif", "mono", "rounded"], hint: "Typeface for the whole app — cards, notes and chrome." },
      { key: "baseFontSize", label: "Text size", type: "text", unit: "px", probe: "font-size", hint: "General Markdown and interface text size." }
    ]
  },
  {
    title: "Text",
    tier: "advanced",
    fields: [
      { key: "baseLineHeight", label: "Line spacing", type: "text", probe: "line-height", hint: "General reading spacing." },
      { key: "notesFontSize", label: "Notes text size", type: "text", unit: "px", probe: "font-size", hint: "Body text size in the Study Notes view." },
      { key: "notesMaxWidthPercent", label: "Notes reading width %", type: "text", probe: "number", hint: "Maximum width of the notes column as a percent of the notes area." },
      { key: "answerFontSize", label: "Answer text size", type: "text", unit: "px", probe: "font-size", hint: "Main answer text size." },
      { key: "questionMaxFontSize", label: "Question max text size", type: "text", unit: "px", probe: "font-size", hint: "Largest question text size. Small questions can still shrink without a floor." },
      { key: "appWidthPercent", label: "App width %", type: "text", probe: "number", hint: "Width of the whole app as a percent of screen width." }
    ]
  },
  {
    title: "Layout",
    tier: "advanced",
    fields: [
      { key: "appHeightPercent", label: "App height %", type: "text", probe: "number", hint: "Height of the whole app as a percent of screen height." },
      { key: "cardWidthPercent", label: "Card width %", type: "text", probe: "number", hint: "Flashcard width as a percent of the middle study area." },
      { key: "cardMaxHeightPercent", label: "Card max height %", type: "text", probe: "number", hint: "Maximum flashcard height as a percent of screen height." },
      { key: "modalWidthPercent", label: "Modal width %", type: "text", probe: "number", hint: "Import and My Decks panel width as a percent of screen width." },
      { key: "visualMaxWidthPercent", label: "Visual max width %", type: "text", probe: "number", hint: "Maximum width of images, videos, and diagrams as a percent of available space." }
    ]
  },
  {
    title: "Spacing and shape",
    tier: "advanced",
    fields: [
      { key: "appGap", label: "Main gap", type: "text", unit: "px", probe: "width", hint: "Space between major app sections." },
      { key: "panelPadding", label: "Panel padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing for the study panel." },
      { key: "cardPadding", label: "Card padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing on question and answer faces." },
      { key: "cardContentGap", label: "Card label gap", type: "text", unit: "px", probe: "width", hint: "Space between the Question/Answer label and content." },
      { key: "buttonGap", label: "Button gap", type: "text", unit: "px", probe: "width", hint: "Space between buttons." },
      { key: "cardCornerRadius", label: "Card corner radius", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of the flashcard corners." },
      { key: "panelCornerRadius", label: "Panel corner radius", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of the study, import, and My Decks panels." },
      { key: "buttonCornerRadius", label: "Control corner radius", type: "text", unit: "px", probe: "border-radius", hint: "Roundness of buttons, textboxes and selects." },
      { key: "cardBorderWidth", label: "Card border width", type: "text", unit: "px", probe: "border-top-width", hint: "Border thickness around the flashcard." }
    ]
  },
  {
    title: "Question",
    tier: "advanced",
    fields: [
      { key: "questionFillPercent", label: "Question fill %", type: "text", probe: "number", hint: "How much vertical card space the question tries to occupy." },
      { key: "questionLineHeight", label: "Question line spacing", type: "text", probe: "line-height", hint: "Line spacing for question text." },
      { key: "questionAlign", label: "Question horizontal align", type: "select", options: ["left", "center", "right", "justify"], hint: "Question text alignment." },
      { key: "questionVerticalAlign", label: "Question vertical align", type: "select", options: ["start", "center", "end"], hint: "Question vertical position." },
      { key: "questionFontWeight", label: "Question weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Question text thickness." }
    ]
  },
  {
    title: "Answer and notes",
    tier: "advanced",
    fields: [
      { key: "answerLineHeight", label: "Answer line spacing", type: "text", probe: "line-height", hint: "Reading spacing on the answer side." },
      { key: "answerFontWeight", label: "Answer weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Answer text thickness." },
      { key: "notesLineHeight", label: "Notes line spacing", type: "text", probe: "line-height", hint: "Reading spacing in the Study Notes view." },
      { key: "notesFontWeight", label: "Notes weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Notes text thickness." },
      { key: "notesPadding", label: "Notes padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing around the Study Notes content." }
    ]
  },
  {
    title: "Controls and text",
    tier: "advanced",
    fields: [
      { key: "toolbarButtonHeight", label: "Button height", type: "text", unit: "px", probe: "height", hint: "Height of icon buttons, Review/Prev/Next, and the replay buttons (slightly shorter). Menu rows keep their own size." },
      { key: "buttonFontSize", label: "Button font size", type: "text", unit: "px", probe: "font-size", hint: "Text size inside buttons." },
      { key: "inputHeight", label: "Input height", type: "text", unit: "px", probe: "height", hint: "Height of URL and style textboxes." },
      { key: "modalPadding", label: "Modal padding", type: "text", unit: "px", probe: "width", hint: "Inside spacing for the import and My Decks panels." },
      { key: "rawMarkdownFontSize", label: "Raw Markdown font size", type: "text", unit: "px", probe: "font-size", hint: "Text size inside Markdown edit boxes." },
      { key: "codeFontSize", label: "Code font size", type: "text", unit: "px", probe: "font-size", hint: "Text size inside code blocks." },
      { key: "codeLineHeight", label: "Code line spacing", type: "text", probe: "line-height", hint: "Line spacing inside code blocks." }
    ]
  }
];

// Density presets. A shortcut that writes several real controls at once, NOT a
// stored setting: deliberately absent from defaultStyleProfiles, whose comment
// above is explicit that a key there which no control maps to is a value the app
// syncs, back-fills across profiles and does nothing with. Nothing reads these
// back, so there is no "current preset" to get out of step with the controls —
// pressing one is exactly equivalent to typing the eight values by hand.
export const styleDensityPresets = {
  desktop: {
    compact:     { baseFontSize: "16px", baseLineHeight: "1.45", cardPadding: "16px", appGap: "6px",  panelPadding: "6px",  cardContentGap: "10px", buttonGap: "6px",  toolbarButtonHeight: "34px" },
    comfortable: { baseFontSize: "18px", baseLineHeight: "1.58", cardPadding: "24px", appGap: "10px", panelPadding: "10px", cardContentGap: "16px", buttonGap: "8px",  toolbarButtonHeight: "38px" },
    large:       { baseFontSize: "21px", baseLineHeight: "1.7",  cardPadding: "32px", appGap: "14px", panelPadding: "14px", cardContentGap: "22px", buttonGap: "11px", toolbarButtonHeight: "44px" }
  },
  mobile: {
    compact:     { baseFontSize: "11px", baseLineHeight: "1.15", cardPadding: "16px", appGap: "6px",  panelPadding: "6px",  cardContentGap: "10px", buttonGap: "6px",  toolbarButtonHeight: "30px" },
    comfortable: { baseFontSize: "12px", baseLineHeight: "1.23", cardPadding: "24px", appGap: "10px", panelPadding: "10px", cardContentGap: "16px", buttonGap: "8px",  toolbarButtonHeight: "34px" },
    large:       { baseFontSize: "15px", baseLineHeight: "1.45", cardPadding: "30px", appGap: "13px", panelPadding: "13px", cardContentGap: "20px", buttonGap: "10px", toolbarButtonHeight: "40px" }
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

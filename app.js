const delimitedCardBoundaryPattern = /(?:^|\n)\s*::/;
const cardSideSeparatorPattern = /^\s*---(?!-)/;

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

const styleProfiles = ["desktop", "mobile"];
const styleMobileQuery = "(max-width: 720px)";
const styleMobileMedia = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(styleMobileQuery) : null;

const state = {
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
  previewCard: null,
  deckTitle: "",
  deckCategory: "Uncategorized",
  notes: "",
  viewMode: "cards",
  // My Decks library UI preferences (persisted per device).
  myDecksView: (() => { try { const v = localStorage.getItem("flashcards_mydecks_view_v1"); return ["grid", "folder", "tree"].includes(v) ? v : "folder"; } catch (_) { return "folder"; } })(),
  myDecksDisplay: (() => { try { const v = localStorage.getItem("flashcards_mydecks_display_v1"); return ["tiles", "list"].includes(v) ? v : "tiles"; } catch (_) { return "tiles"; } })(),
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

const deckStorageKey = "swipe-notes-current-deck-v1";
const styleStorageKey = "swipe-notes-style-settings-v1";
const themeStorageKey = "swipe-notes-theme";
const defaultDeckCategory = "Uncategorized";
let webDeckCategories = [defaultDeckCategory];

const themeCatalog = [
  {
    id: "dark-amoled",
    label: "AMOLED Black",
    mode: "dark",
    description: "Pure black with cyan focus",
    colors: { bg: "#000000", panel: "#050606", text: "#f4fbfb", line: "#1a2424", accent: "#27e0d0" }
  },
  {
    id: "dark-amoled-emerald",
    label: "AMOLED Emerald",
    mode: "dark",
    description: "Pure black with green accents",
    colors: { bg: "#000000", panel: "#040705", text: "#f2fbf5", line: "#16251b", accent: "#34d96f" }
  },
  {
    id: "dark-amoled-violet",
    label: "AMOLED Violet",
    mode: "dark",
    description: "Pure black with violet accents",
    colors: { bg: "#000000", panel: "#070408", text: "#fbf5ff", line: "#25172a", accent: "#c084fc" }
  },
  {
    id: "dark-forest",
    label: "Forest Dark",
    mode: "dark",
    description: "Deep green-black panels",
    colors: { bg: "#0d1110", panel: "#131917", text: "#eef5f1", line: "#2b3933", accent: "#55d6bf" }
  },
  {
    id: "dark-graphite",
    label: "Graphite Dark",
    mode: "dark",
    description: "Neutral charcoal and cyan",
    colors: { bg: "#101113", panel: "#181a1d", text: "#f1f3f4", line: "#333841", accent: "#7cc7d8" }
  },
  {
    id: "dark-navy",
    label: "Navy Dark",
    mode: "dark",
    description: "Low-glare blue workspace",
    colors: { bg: "#0b1020", panel: "#121a2b", text: "#eef3fb", line: "#2b3a55", accent: "#8ab4ff" }
  },
  {
    id: "dark-bronze",
    label: "Bronze Dark",
    mode: "dark",
    description: "Dark neutral with amber focus",
    colors: { bg: "#12110d", panel: "#1b1913", text: "#f3f0e7", line: "#3a3427", accent: "#e1b86b" }
  },
  {
    id: "light-paper",
    label: "Paper Light",
    mode: "light",
    description: "Warm paper with teal accents",
    colors: { bg: "#f4f2ec", panel: "#fffdf8", text: "#161a18", line: "#d8d4c8", accent: "#16796c" }
  },
  {
    id: "light-snow",
    label: "Snow Light",
    mode: "light",
    description: "Clean neutral workspace",
    colors: { bg: "#f6f8f9", panel: "#ffffff", text: "#172026", line: "#d8e0e5", accent: "#2c6f91" }
  },
  {
    id: "light-ink",
    label: "Ink Light",
    mode: "light",
    description: "Cool blue-gray contrast",
    colors: { bg: "#f3f5fb", panel: "#ffffff", text: "#151b2a", line: "#d3dbea", accent: "#3f63b5" }
  }
];

const themeAliases = {
  dark: "dark-amoled",
  light: "light-paper"
};

const fontFamilyChoices = {
  system: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  serif: "Georgia, \"Times New Roman\", Times, serif",
  mono: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", Menlo, monospace",
  rounded: "ui-rounded, \"Avenir Next\", \"Nunito Sans\", Inter, ui-sans-serif, system-ui, sans-serif"
};

const defaultStyleProfiles = {
  "mobile": {
    "appGap": "10px",
    "buttonGap": "8px",
    "fontFamily": "system",
    "cardPadding": "24px",
    "inputHeight": "40px",
    "baseFontSize": "12px",
    "codeFontSize": "10px",
    "modalPadding": "18px",
    "panelPadding": "10px",
    "stackCardGap": "7px",
    "answerPadding": "0px",
    "questionAlign": "left",
    "answerFontSize": "13px",
    "baseLineHeight": "1.23",
    "buttonFontSize": "14px",
    "cardContentGap": "16px",
    "codeLineHeight": "1.17",
    "appWidthPercent": "100",
    "cardBorderWidth": "1px",
    "questionPadding": "2px",
    "answerFontFamily": "system",
    "answerFontWeight": "300",
    "answerLineHeight": "1.58",
    "appHeightPercent": "100",
    "cardCornerRadius": "14px",
    "cardWidthPercent": "96",
    "inputCornerRadius": "8px",
    "modalWidthPercent": "60",
    "panelCornerRadius": "14px",
    "stackCardFontSize": "13px",
    "actionButtonHeight": "42px",
    "buttonCornerRadius": "8px",
    "questionFontFamily": "system",
    "questionFontWeight": "500",
    "questionLineHeight": "1.17",
    "replayButtonHeight": "30px",
    "questionFillPercent": "75",
    "questionMaxFontSize": "23px",
    "rawMarkdownFontSize": "16px",
    "stackCardLineHeight": "1.28",
    "toolbarButtonHeight": "38px",
    "cardMaxHeightPercent": "80",
    "questionVerticalAlign": "center",
    "sidePanelWidthPercent": "16",
    "visualMaxWidthPercent": "90",
    "markdownBoxHeightPercent": "30",
    "notesFontFamily": "system",
    "notesFontSize": "15px",
    "notesLineHeight": "1.5",
    "notesFontWeight": "400",
    "notesMaxWidthPercent": "100",
    "notesPadding": "4px"
  },
  "desktop": {
    "appGap": "10px",
    "buttonGap": "8px",
    "fontFamily": "system",
    "cardPadding": "24px",
    "inputHeight": "40px",
    "baseFontSize": "18px",
    "codeFontSize": "12px",
    "modalPadding": "18px",
    "panelPadding": "10px",
    "stackCardGap": "7px",
    "answerPadding": "0px",
    "questionAlign": "center",
    "answerFontSize": "23px",
    "baseLineHeight": "1.58",
    "buttonFontSize": "14px",
    "cardContentGap": "16px",
    "codeLineHeight": "1.55",
    "appWidthPercent": "100",
    "cardBorderWidth": "1px",
    "questionPadding": "2px",
    "answerFontFamily": "system",
    "answerFontWeight": "400",
    "answerLineHeight": "1.58",
    "appHeightPercent": "100",
    "cardCornerRadius": "14px",
    "cardWidthPercent": "100",
    "inputCornerRadius": "8px",
    "modalWidthPercent": "60",
    "panelCornerRadius": "14px",
    "stackCardFontSize": "13px",
    "actionButtonHeight": "42px",
    "buttonCornerRadius": "8px",
    "questionFontFamily": "system",
    "questionFontWeight": "500",
    "questionLineHeight": "1.18",
    "replayButtonHeight": "30px",
    "questionFillPercent": "58",
    "questionMaxFontSize": "19px",
    "rawMarkdownFontSize": "18px",
    "stackCardLineHeight": "1.28",
    "toolbarButtonHeight": "38px",
    "cardMaxHeightPercent": "84",
    "questionVerticalAlign": "center",
    "sidePanelWidthPercent": "6",
    "visualMaxWidthPercent": "50",
    "markdownBoxHeightPercent": "30",
    "notesFontFamily": "system",
    "notesFontSize": "18px",
    "notesLineHeight": "1.58",
    "notesFontWeight": "400",
    "notesMaxWidthPercent": "100",
    "notesPadding": "6px"
  },
  "version": 2
};

const styleDefaults = defaultStyleProfiles.desktop;

const styleControlGroups = [
  {
    title: "Typography",
    fields: [
      { key: "fontFamily", label: "Base font family", type: "select", options: ["system", "serif", "mono", "rounded"], hint: "Base app font." },
      { key: "baseFontSize", label: "Base font size", type: "range", min: 10, max: 36, step: 1, unit: "px", hint: "General Markdown and interface text size." },
      { key: "baseLineHeight", label: "Base line spacing", type: "range", min: 0.9, max: 2.6, step: 0.01, hint: "General reading spacing." },
      { key: "rawMarkdownFontSize", label: "Raw Markdown font size", type: "range", min: 8, max: 36, step: 1, unit: "px", hint: "Text size inside Markdown edit boxes." },
      { key: "codeFontSize", label: "Code font size", type: "range", min: 10, max: 28, step: 1, unit: "px", hint: "Text size inside code blocks." },
      { key: "codeLineHeight", label: "Code line spacing", type: "range", min: 0.9, max: 2.6, step: 0.01, hint: "Line spacing inside code blocks." }
    ]
  },
  {
    title: "Layout Percentages",
    fields: [
      { key: "appWidthPercent", label: "App width %", type: "range", min: 50, max: 100, step: 1, hint: "Width of the whole app as a percent of screen width." },
      { key: "appHeightPercent", label: "App height %", type: "range", min: 50, max: 100, step: 1, hint: "Height of the whole app as a percent of screen height." },
      { key: "cardWidthPercent", label: "Card width %", type: "range", min: 40, max: 100, step: 1, hint: "Flashcard width as a percent of the middle study area." },
      { key: "cardMaxHeightPercent", label: "Card max height %", type: "range", min: 30, max: 100, step: 1, hint: "Maximum flashcard height as a percent of screen height." },
      { key: "modalWidthPercent", label: "Modal width %", type: "range", min: 30, max: 100, step: 1, hint: "Import/Web/Style panel width as a percent of screen width." },
      { key: "visualMaxWidthPercent", label: "Visual max width %", type: "range", min: 10, max: 100, step: 1, hint: "Maximum width of images, videos, and diagrams as a percent of available space." },
      { key: "markdownBoxHeightPercent", label: "Markdown box height %", type: "range", min: 10, max: 80, step: 1, hint: "Import textarea height as a percent of screen height." }
    ]
  },
  {
    title: "Spacing And Shape",
    fields: [
      { key: "appGap", label: "Main gap", type: "range", min: 0, max: 40, step: 1, unit: "px", hint: "Space between major app sections." },
      { key: "panelPadding", label: "Panel padding", type: "range", min: 0, max: 48, step: 1, unit: "px", hint: "Inside spacing for study and side panels." },
      { key: "cardPadding", label: "Card padding", type: "range", min: 0, max: 80, step: 1, unit: "px", hint: "Inside spacing on question and answer faces." },
      { key: "cardContentGap", label: "Card label gap", type: "range", min: 0, max: 48, step: 1, unit: "px", hint: "Space between the Question/Answer label and content." },
      { key: "buttonGap", label: "Button gap", type: "range", min: 0, max: 32, step: 1, unit: "px", hint: "Space between buttons." },
      { key: "cardCornerRadius", label: "Card corner radius", type: "range", min: 0, max: 48, step: 1, unit: "px", hint: "Roundness of the flashcard corners." },
      { key: "panelCornerRadius", label: "Panel corner radius", type: "range", min: 0, max: 48, step: 1, unit: "px", hint: "Roundness of study, side, import, and style panels." },
      { key: "buttonCornerRadius", label: "Button corner radius", type: "range", min: 0, max: 32, step: 1, unit: "px", hint: "Roundness of buttons." },
      { key: "inputCornerRadius", label: "Input corner radius", type: "range", min: 0, max: 32, step: 1, unit: "px", hint: "Roundness of textboxes and selects." }
    ]
  },
  {
    title: "Question",
    fields: [
      { key: "questionFontFamily", label: "Question font family", type: "select", options: ["system", "serif", "mono", "rounded"], hint: "Question-only font." },
      { key: "questionFillPercent", label: "Question fill %", type: "range", min: 10, max: 95, step: 1, hint: "How much vertical card space the question tries to occupy." },
      { key: "questionMaxFontSize", label: "Question max font size", type: "range", min: 8, max: 180, step: 1, unit: "px", hint: "Largest question text size. Small questions can still shrink without a floor." },
      { key: "questionLineHeight", label: "Question line spacing", type: "range", min: 0.8, max: 2.4, step: 0.01, hint: "Line spacing for question text." },
      { key: "questionAlign", label: "Question horizontal align", type: "select", options: ["left", "center", "right", "justify"], hint: "Question text alignment." },
      { key: "questionVerticalAlign", label: "Question vertical align", type: "select", options: ["start", "center", "end"], hint: "Question vertical position." },
      { key: "questionFontWeight", label: "Question weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Question text thickness." },
      { key: "questionPadding", label: "Question padding", type: "range", min: 0, max: 120, step: 1, unit: "px", hint: "Internal padding for the question text." }
    ]
  },
  {
    title: "Answer And Card",
    fields: [
      { key: "answerFontFamily", label: "Answer font family", type: "select", options: ["system", "serif", "mono", "rounded"], hint: "Answer-only font." },
      { key: "answerFontSize", label: "Answer font size", type: "range", min: 10, max: 64, step: 1, unit: "px", hint: "Main answer text size." },
      { key: "answerLineHeight", label: "Answer line spacing", type: "range", min: 0.9, max: 2.6, step: 0.01, hint: "Reading spacing on the answer side." },
      { key: "answerFontWeight", label: "Answer weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Answer text thickness." },
      { key: "answerPadding", label: "Answer padding", type: "range", min: 0, max: 120, step: 1, unit: "px", hint: "Internal padding for the answer text." },
      { key: "cardBorderWidth", label: "Card border width", type: "range", min: 0, max: 8, step: 1, unit: "px", hint: "Border thickness around the flashcard." }
    ]
  },
  {
    title: "Notes",
    fields: [
      { key: "notesFontFamily", label: "Notes font family", type: "select", options: ["system", "serif", "mono", "rounded"], hint: "Font for the Study Notes document." },
      { key: "notesFontSize", label: "Notes font size", type: "range", min: 10, max: 40, step: 1, unit: "px", hint: "Body text size in the Study Notes view." },
      { key: "notesLineHeight", label: "Notes line spacing", type: "range", min: 0.9, max: 2.6, step: 0.01, hint: "Reading spacing in the Study Notes view." },
      { key: "notesFontWeight", label: "Notes weight", type: "select", options: ["300", "400", "500", "600", "700", "800", "900"], hint: "Notes text thickness." },
      { key: "notesMaxWidthPercent", label: "Notes reading width %", type: "range", min: 40, max: 100, step: 1, hint: "Maximum width of the notes column as a percent of the notes area." },
      { key: "notesPadding", label: "Notes padding", type: "range", min: 0, max: 64, step: 1, unit: "px", hint: "Inside spacing around the Study Notes content." }
    ]
  },
  {
    title: "Buttons And Inputs",
    fields: [
      { key: "toolbarButtonHeight", label: "Toolbar button height", type: "range", min: 24, max: 72, step: 1, unit: "px", hint: "Height of Import, Export, and icon buttons." },
      { key: "actionButtonHeight", label: "Action button height", type: "range", min: 28, max: 80, step: 1, unit: "px", hint: "Height of Review, Prev, Next, Known buttons." },
      { key: "buttonFontSize", label: "Button font size", type: "range", min: 10, max: 28, step: 1, unit: "px", hint: "Text size inside buttons." },
      { key: "replayButtonHeight", label: "Replay button height", type: "range", min: 20, max: 56, step: 1, unit: "px", hint: "Height of All cards / Review only replay buttons." },
      { key: "inputHeight", label: "Input height", type: "range", min: 24, max: 72, step: 1, unit: "px", hint: "Height of URL and style textboxes." },
      { key: "modalPadding", label: "Modal padding", type: "range", min: 0, max: 64, step: 1, unit: "px", hint: "Inside spacing for import, web deck, and style panels." }
    ]
  }
];

const styleFieldByKey = styleControlGroups.reduce((fields, group) => {
  group.fields.forEach((field) => {
    fields[field.key] = field;
  });
  return fields;
}, {});

const styleCssVariables = {
  questionFontFamily: "--question-font-family",
  answerFontFamily: "--answer-font-family",
  appWidthPercent: "--app-width-percent",
  appHeightPercent: "--app-height-percent",
  sidePanelWidthPercent: "--side-panel-width-percent",
  cardWidthPercent: "--card-width-percent",
  cardMaxHeightPercent: "--card-max-height-percent",
  modalWidthPercent: "--modal-width-percent",
  visualMaxWidthPercent: "--visual-max-width-percent",
  markdownBoxHeightPercent: "--markdown-box-height-percent",
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
  questionPadding: "--question-padding",
  answerFontSize: "--answer-font-size",
  answerLineHeight: "--answer-line-height",
  answerFontWeight: "--answer-font-weight",
  answerPadding: "--answer-padding",
  notesFontSize: "--notes-font-size",
  notesLineHeight: "--notes-line-height",
  notesFontWeight: "--notes-font-weight",
  notesPadding: "--notes-padding",
  appGap: "--app-gap",
  panelPadding: "--panel-padding",
  cardPadding: "--card-face-padding",
  cardContentGap: "--card-face-gap",
  buttonGap: "--toolbar-gap",
  stackCardGap: "--brick-gap",
  cardBorderWidth: "--card-border-width",
  cardCornerRadius: "--card-radius",
  panelCornerRadius: "--panel-corner-radius",
  buttonCornerRadius: "--toolbar-button-radius",
  inputCornerRadius: "--input-radius",
  toolbarButtonHeight: "--toolbar-button-height",
  actionButtonHeight: "--action-button-height",
  buttonFontSize: "--button-font-size",
  replayButtonHeight: "--replay-button-height",
  stackCardFontSize: "--brick-font-size",
  stackCardLineHeight: "--brick-line-height",
  inputHeight: "--input-height",
  modalPadding: "--modal-padding"
};


// Supabase config is stored in localStorage — no hardcoded credentials.
// Users enter their own project URL and anon key on first launch.
const SUPABASE_CONFIG_STORAGE_KEY = "flashcards_supabase_config";

function loadSupabaseConfig() {
  try {
    const raw = localStorage.getItem(SUPABASE_CONFIG_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSupabaseConfig(url, key) {
  localStorage.setItem(SUPABASE_CONFIG_STORAGE_KEY, JSON.stringify({ url: url.trim(), key: key.trim() }));
}

function clearSupabaseConfig() {
  localStorage.removeItem(SUPABASE_CONFIG_STORAGE_KEY);
}

let supabaseClient = null;
// Tracks whether a real user session is active, so background auto-sync only
// fires for signed-in users (and never tries to push while logged out).
let isSignedIn = false;

function initSupabaseClient() {
  const config = loadSupabaseConfig();
  if (!config?.url || !config?.key) return false;
  if (!window.supabase) return false;
  supabaseClient = window.supabase.createClient(config.url, config.key);
  return true;
}

async function getCurrentUser() {
  if (!supabaseClient) return null;
  const { data } = await supabaseClient.auth.getUser();
  return data?.user ?? null;
}

// Reads the session straight from local storage — no network — so a user who
// has signed in at least once can keep using the app while offline.
async function getCachedSession() {
  if (!supabaseClient) return null;
  try {
    const { data } = await supabaseClient.auth.getSession();
    return data?.session ?? null;
  } catch (error) {
    console.warn("Could not read cached session", error);
    return null;
  }
}

let explicitLogout = false;

async function handleLogin(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

async function handleSignup(email, password) {
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) throw error;
  return data.user;
}

async function handleLogout() {
  explicitLogout = true;
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (error) {
      // Offline sign-out still clears the local session below via the listener.
      console.warn("Sign-out network call failed (continuing locally)", error);
    }
  }
}

function showSetupScreen() {
  document.getElementById("setupOverlay").hidden = false;
  document.getElementById("loginOverlay").hidden = true;
  document.querySelector(".app-shell").hidden = true;
  document.getElementById("logoutBtn").hidden = true;
}

function showLoginScreen() {
  document.getElementById("setupOverlay").hidden = true;
  document.getElementById("loginOverlay").hidden = false;
  document.querySelector(".app-shell").hidden = true;
  document.getElementById("logoutBtn").hidden = true;
}

function showAuthenticatedUI() {
  document.getElementById("setupOverlay").hidden = true;
  document.getElementById("loginOverlay").hidden = true;
  document.querySelector(".app-shell").hidden = false;
  document.getElementById("logoutBtn").hidden = false;
}


// A deck's `category` is a "/"-delimited folder path (e.g. "Math/Calculus"):
// each segment is a folder, nesting is arbitrary depth. Legacy flat categories
// (no "/") are simply single-segment paths, so this stays backward compatible.
const FOLDER_SEP = "/";

// Splits a category into its trimmed, non-empty folder segments.
function folderSegments(value) {
  return String(value || "")
    .split(FOLDER_SEP)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeDeckCategory(value) {
  const segments = folderSegments(value);
  return segments.length ? segments.join(FOLDER_SEP) : defaultDeckCategory;
}

// True when `path` is `ancestor` itself or nested beneath it.
function isCategoryUnder(path, ancestor) {
  const p = normalizeDeckCategory(path);
  const a = normalizeDeckCategory(ancestor);
  return p === a || p.startsWith(a + FOLDER_SEP);
}

// Rewrites a category whose path is `fromPath` (or nested under it) so its
// `fromPath` prefix becomes `toPath`; returns it unchanged otherwise.
function rewriteCategoryPrefix(category, fromPath, toPath) {
  const current = normalizeDeckCategory(category);
  const from = normalizeDeckCategory(fromPath);
  if (current === from) return normalizeDeckCategory(toPath);
  if (current.startsWith(from + FOLDER_SEP)) {
    return normalizeDeckCategory(toPath + current.slice(from.length));
  }
  return current;
}

function categorySortValue(value) {
  const category = normalizeDeckCategory(value);
  return category === defaultDeckCategory ? "" : category.toLowerCase();
}

// ── Empty-folder registry ──────────────────────────────────────────────────
// Folders only exist implicitly, as prefixes of deck categories — so a folder
// with no decks yet has nowhere to live. This device-local list keeps such
// freshly-created (or emptied) folders visible until a deck lands in them; once
// one does, the folder persists everywhere via that deck's synced category.
const KNOWN_FOLDERS_KEY = "flashcards_folders_v1";
const COLLAPSED_FOLDERS_KEY = "flashcards_folder_collapsed_v1";

function readKnownFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(KNOWN_FOLDERS_KEY) || "[]");
    return Array.isArray(list) ? list.map(normalizeDeckCategory).filter((p) => p !== defaultDeckCategory) : [];
  } catch (error) {
    console.warn("Could not read known folders", error);
    return [];
  }
}

function writeKnownFolders(list) {
  const unique = Array.from(new Set((list || []).map(normalizeDeckCategory)))
    .filter((p) => p !== defaultDeckCategory);
  try { localStorage.setItem(KNOWN_FOLDERS_KEY, JSON.stringify(unique)); } catch (_) {}
  return unique;
}

function addKnownFolder(path) {
  const normalized = normalizeDeckCategory(path);
  if (normalized === defaultDeckCategory) return;
  writeKnownFolders([...readKnownFolders(), normalized]);
}

// Forgets a folder and every subfolder under it: drops them from the
// known-folder registry and from the collapsed/expanded UI state, and lifts
// the Folder-view cwd out if it pointed inside. A folder has no record of its
// own — it is a deck-category prefix plus a registry entry — so once its decks
// are gone this is the only thing still holding it on screen, which is exactly
// how a deleted folder used to linger as an empty "0 decks" shell.
function forgetFolderTree(path) {
  const target = normalizeDeckCategory(path);
  if (target === defaultDeckCategory) return;

  writeKnownFolders(readKnownFolders().filter((p) => !isCategoryUnder(p, target)));

  const prune = (set) => {
    const next = new Set();
    set.forEach((p) => { if (!isCategoryUnder(p, target)) next.add(p); });
    return next;
  };
  writeCollapsedFolders(prune(readCollapsedFolders()));
  writeExpandedFolders(prune(readExpandedFolders()));

  if (state.myDecksCwd && isCategoryUnder(state.myDecksCwd, target)) {
    setMyDecksCwd(folderSegments(target).slice(0, -1).join(FOLDER_SEP));
  }
}

function readCollapsedFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.map(normalizeDeckCategory) : []);
  } catch (error) {
    console.warn("Could not read collapsed folders", error);
    return new Set();
  }
}

function writeCollapsedFolders(set) {
  try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
}

// Folders are FOLDED BY DEFAULT: a folder is expanded only if its path is in this
// set (the inverse of a "collapsed" list), so a fresh library shows everything
// folded. Supersedes COLLAPSED_FOLDERS_KEY for the tree view.
const EXPANDED_FOLDERS_KEY = "flashcards_folder_expanded_v1";

function readExpandedFolders() {
  try {
    const list = JSON.parse(localStorage.getItem(EXPANDED_FOLDERS_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.map(normalizeDeckCategory) : []);
  } catch (error) {
    console.warn("Could not read expanded folders", error);
    return new Set();
  }
}

function writeExpandedFolders(set) {
  try { localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
}

function isFolderCollapsed(path) {
  return !readExpandedFolders().has(normalizeDeckCategory(path));
}

// ── My Decks view + display preferences (persisted per device) ──────────────
const MYDECKS_VIEW_KEY = "flashcards_mydecks_view_v1";       // grid | folder | tree
const MYDECKS_DISPLAY_KEY = "flashcards_mydecks_display_v1"; // tiles | list
const MYDECKS_CWD_KEY = "flashcards_mydecks_cwd_v1";         // Folder-view path
const MYDECKS_SORT_KEY = "flashcards_mydecks_sort_v1";
const MYDECKS_SORT_OPTIONS = ["recent", "title-asc", "title-desc", "updated-desc", "created-desc", "size-desc"];

function setMyDecksView(view) {
  if (!["grid", "folder", "tree"].includes(view)) return;
  state.myDecksView = view;
  try { localStorage.setItem(MYDECKS_VIEW_KEY, view); } catch (_) {}
}

function setMyDecksDisplay(display) {
  if (!["tiles", "list"].includes(display)) return;
  state.myDecksDisplay = display;
  try { localStorage.setItem(MYDECKS_DISPLAY_KEY, display); } catch (_) {}
}

function setMyDecksSort(sort) {
  if (!MYDECKS_SORT_OPTIONS.includes(sort)) return;
  state.myDecksSort = sort;
  try { localStorage.setItem(MYDECKS_SORT_KEY, sort); } catch (_) {}
}

function setMyDecksCwd(path) {
  state.myDecksCwd = normalizeDeckCategory(path) === defaultDeckCategory ? "" : normalizeDeckCategory(path);
  try { localStorage.setItem(MYDECKS_CWD_KEY, state.myDecksCwd); } catch (_) {}
}

// Builds a nested folder tree from a set of category paths and the decks that
// carry them. Each node: { name, path, children:Map<name,node>, decks:[] }.
// `deckEntries` is an array of { deck, kind } where kind is "local"|"cloud".
function buildFolderTree(deckEntries = [], extraFolders = []) {
  const root = { name: "", path: "", children: new Map(), decks: [] };
  const ensure = (path) => {
    const segments = folderSegments(path);
    let node = root;
    let acc = "";
    segments.forEach((segment) => {
      acc = acc ? acc + FOLDER_SEP + segment : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, path: acc, children: new Map(), decks: [] });
      }
      node = node.children.get(segment);
    });
    return node;
  };
  // Uncategorized decks live at the tree root so they aren't buried in a folder.
  extraFolders.forEach((path) => ensure(path));
  deckEntries.forEach((entry) => {
    const category = normalizeDeckCategory(entry.deck.category);
    const node = category === defaultDeckCategory ? root : ensure(category);
    node.decks.push(entry);
  });
  return root;
}

function categoriesFromDecks(decks = [], extraCategories = []) {
  return Array.from(new Set([
    defaultDeckCategory,
    ...extraCategories.map(normalizeDeckCategory),
    ...(decks || []).map((deck) => normalizeDeckCategory(deck.category))
  ])).sort((a, b) => categorySortValue(a).localeCompare(categorySortValue(b)));
}

function setKnownWebDeckCategories(categories = []) {
  webDeckCategories = categoriesFromDecks([], categories);
  return webDeckCategories;
}

async function refreshKnownWebDeckCategories() {
  if (!supabaseClient) return webDeckCategories;
  const { data, error } = await supabaseClient
    .from("decks")
    .select("category");
  if (error) throw error;
  return setKnownWebDeckCategories(categoriesFromDecks(data || []));
}

async function chooseDeckCategory(currentCategory = defaultDeckCategory) {
  try {
    await refreshKnownWebDeckCategories();
  } catch (error) {
    console.warn("Could not load deck categories", error);
  }

  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal";
    modal.setAttribute("aria-label", "Choose deck category");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Deck Category</h2>
          <p>Choose an existing category or create a new one.</p>
        </div>
        <button type="button" data-category-cancel aria-label="Close category editor">&#215;</button>
      </div>
      <label class="category-choice-field">
        <span>Category</span>
        <select data-category-select></select>
      </label>
      <label class="category-choice-field" data-category-new-field hidden>
        <span>New category</span>
        <input type="text" data-category-new autocomplete="off" spellcheck="false">
      </label>
      <div class="category-choice-actions">
        <button type="button" data-category-cancel>Cancel</button>
        <button type="button" data-category-save>Apply</button>
      </div>
    `;

    const select = shell.querySelector("[data-category-select]");
    categoriesFromDecks([], [...webDeckCategories, currentCategory]).forEach((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = "+ New category";
    select.appendChild(newOption);
    select.value = normalizeDeckCategory(currentCategory);

    const newField = shell.querySelector("[data-category-new-field]");
    const newInput = shell.querySelector("[data-category-new]");
    const cleanup = (value = null) => {
      modal.remove();
      resolve(value);
    };

    select.addEventListener("change", () => {
      newField.hidden = select.value !== "__new__";
      if (!newField.hidden) newInput.focus();
    });
    shell.querySelectorAll("[data-category-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelector("[data-category-save]").addEventListener("click", () => {
      if (select.value === "__new__" && !newInput.value.trim()) {
        setStatus("Category cannot be empty.", "error");
        newInput.focus();
        return;
      }
      cleanup(normalizeDeckCategory(select.value === "__new__" ? newInput.value : select.value));
    });
    newInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (!newInput.value.trim()) {
          setStatus("Category cannot be empty.", "error");
          return;
        }
        cleanup(normalizeDeckCategory(newInput.value));
      }
      if (event.key === "Escape") cleanup(null);
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    select.focus();
  });
}

// Asks Cards vs Notes before a bulk export (Export All / multi-select) runs —
// unlike the single active-deck view, which already has separate Export and
// Export Notes buttons, a bulk export otherwise has no way to say which one
// you actually wanted. Resolves "cards" | "notes" | null (cancelled).
function chooseExportContent() {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal";
    modal.setAttribute("aria-label", "Choose what to export");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Export</h2>
          <p>What would you like to export?</p>
        </div>
        <button type="button" data-export-content-cancel aria-label="Close">&#215;</button>
      </div>
      <div class="export-content-choices">
        <button type="button" class="export-content-choice" data-export-content="cards">
          <span class="export-content-choice-icon">&#128209;</span>
          <span>Cards</span>
        </button>
        <button type="button" class="export-content-choice" data-export-content="notes">
          <span class="export-content-choice-icon">&#128221;</span>
          <span>Notes</span>
        </button>
      </div>
      <div class="category-choice-actions">
        <button type="button" data-export-content-cancel>Cancel</button>
      </div>
    `;

    const cleanup = (value = null) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-export-content-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelectorAll("[data-export-content]").forEach((button) => {
      button.addEventListener("click", () => cleanup(button.dataset.exportContent));
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector(".export-content-choice")?.focus();
  });
}

// Whichever of two ISO timestamps (either may be null/undefined) is later,
// or null if neither parses.
function laterIsoTimestamp(a, b) {
  const ta = Date.parse(a || "");
  const tb = Date.parse(b || "");
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

// Local counterpart of touchWebDeckAccess: bumps a deck's "last opened" time
// without touching updatedAt, so background reconcile reloads (which also call
// loadDeckFromLibrary) don't masquerade as a real visit — only the explicit
// open-from-My-Decks call sites invoke this.
function touchLocalDeckAccess(id) {
  if (!id) return;
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.id === id);
  if (!entry) return;
  entry.accessedAt = new Date().toISOString();
  writeLocalDeckIndex(index);
}

async function touchWebDeckAccess(deckId) {
  if (!deckId || !supabaseClient) return false;

  const { error } = await supabaseClient
    .from("decks")
    .update({
      last_accessed_at: new Date().toISOString()
    })
    .eq("id", deckId);

  if (error) throw error;
  return true;
}



async function updateWebDeckTitle(deckId, title) {
  if (!deckId || !supabaseClient) return false;

  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("decks")
    .update({
      title,
      updated_at: now
    })
    .eq("id", deckId);

  if (error) throw error;
  syncLocalLibraryMetaForDeck(deckId, { title, now });
  return true;
}

async function updateWebDeckCategory(deckId, category) {
  if (!deckId || !supabaseClient) return false;

  const normalized = normalizeDeckCategory(category);
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from("decks")
    .update({
      category: normalized,
      updated_at: now
    })
    .eq("id", deckId);

  if (error) throw error;
  syncLocalLibraryMetaForDeck(deckId, { category: normalized, now });
  return true;
}

async function applyWebDeckCategory(deckId, category) {
  const normalized = normalizeDeckCategory(category);
  setKnownWebDeckCategories([...webDeckCategories, normalized]);
  await updateWebDeckCategory(deckId, normalized);

  if (state.deckId === deckId) {
    state.deckCategory = normalized;
    updateMeta();
  }

  return normalized;
}

function closeWebDeckExportMenus(exceptMenu = null) {
  document.querySelectorAll(".web-deck-export-menu, .web-decks-global-export-menu, .bulk-export-menu").forEach((menu) => {
    if (menu !== exceptMenu) {
      menu.hidden = true;
      const trigger = menu.previousElementSibling;
      if (trigger?.matches("[aria-expanded]")) trigger.setAttribute("aria-expanded", "false");
    }
  });
}

function downloadTextFile(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function normalizeWebDeckPayload(deckData, cardsData = []) {
  const deck = {
    id: String(deckData.id || ""),
    title: String(deckData.title || "Untitled"),
    category: normalizeDeckCategory(deckData.category),
    notes: String(deckData.notes || ""),
    meta: deckData.meta && typeof deckData.meta === "object" ? deckData.meta : {},
    current_card_index: Number(deckData.current_card_index) || 0,
    created_at: deckData.created_at || null,
    updated_at: deckData.updated_at || null,
    last_accessed_at: deckData.last_accessed_at || null
  };

  const cards = (cardsData || []).map((card, index) => ({
    id: String(card.id || `${deck.id}-${index}`),
    deck_id: String(card.deck_id || deck.id),
    question: String(card.question || ""),
    answer: String(card.answer || ""),
    position: Number.isFinite(Number(card.position)) ? Number(card.position) : index,
    status: normalizeCardStatus(card.status),
    // Free subject label for quick_notes cards; null on regular study cards.
    category: card.category ? String(card.category) : null,
    created_at: card.created_at || null,
    updated_at: card.updated_at || null
  }));

  return { deck, cards };
}

function deckPayloadSnapshot(payload) {
  return {
    app: "recall", // informational only — imports never read this field, so old "markdown-flashcards" exports still load
    version: 1,
    exportedAt: new Date().toISOString(),
    // The deck's REAL last-edited time (distinct from exportedAt, the moment the
    // archive was written). Restore compares this to decide newest-wins, so it
    // must survive the round-trip; falls back to null for older exports.
    updatedAt: payload.deck.updated_at || null,
    deckTitle: payload.deck.title,
    deckCategory: payload.deck.category,
    notes: payload.deck.notes || "",
    // Deck-level bag — carries the quick_notes managed category set through
    // backup/restore so restored notes still resolve their labels.
    meta: payload.deck.meta && typeof payload.deck.meta === "object" ? payload.deck.meta : {},
    sourceTitle: payload.deck.title,
    importTitleHint: payload.deck.title,
    deckId: payload.deck.id,
    current: payload.deck.current_card_index || 0,
    cards: payload.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      status: card.status,
      // Quick-note subject label carried through backup/restore + reconcile.
      category: card.category || null,
      // Per-card last-edited time when known, so card-level conflicts can also
      // resolve newest-wins instead of blindly overwriting a newer local edit.
      updatedAt: card.updated_at || null
    }))
  };
}

function statusByIdFromCards(cards = []) {
  return cards.reduce((statusById, card) => {
    const status = normalizeCardStatus(card.status);
    if (status) statusById[card.id] = status;
    return statusById;
  }, {});
}

// Quick-note subject label for a card: state.categoryById is authoritative
// while a deck is open (the board writes there), with the card's own field as
// the fallback for cards that never went through a deck load.
function quickNoteCategoryForCard(card) {
  if (!card || !card.id) return null;
  const assigned = state.categoryById[card.id];
  if (assigned) return String(assigned);
  return card.category ? String(card.category) : null;
}

// Apply a loaded deck's meta bag to the in-memory category set. Only the
// quick_notes deck owns this set: loading an ordinary deck must leave it alone,
// or its (empty) meta would blank the categories the board still needs. Falls
// back to the local cache so an offline/pre-migration load still has labels.
function applyDeckMetaCategories(meta, deckId, title) {
  if (!isQuickNotesDeck(deckId, title)) return;
  const fromMeta = quickNoteCategoriesFromMeta(meta);
  if (fromMeta.length) {
    state.quickNoteCategories = fromMeta;
    writeCachedQuickNoteCategories(fromMeta);
  } else {
    state.quickNoteCategories = readCachedQuickNoteCategories();
  }
}

async function fetchWebDeckPayload(deckId) {
  const { data: deckData, error: deckError } = await supabaseClient
    .from("decks")
    .select("*")
    .eq("id", deckId)
    .single();

  if (deckError) throw deckError;

  const { data: cardsData, error: cardsError } = await supabaseClient
    .from("cards")
    .select("*")
    .eq("deck_id", deckId)
    .order("position", { ascending: true });

  if (cardsError) throw cardsError;
  return normalizeWebDeckPayload(deckData, cardsData || []);
}

function webDeckPayloadMarkdown(payload) {
  const notesBlock = notesExportBlock(payload.deck.notes);
  return [
    `# ${payload.deck.title}`,
    "",
    `Category: ${payload.deck.category}`,
    `Deck ID: ${payload.deck.id}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    formatCardList("Cards", payload.cards),
    notesBlock ? "" : null,
    notesBlock || null
  ].filter((line) => line !== null).join("\n");
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTimestamp(value, fallback = new Date().toISOString()) {
  const parsed = value ? new Date(value) : null;
  return sqlValue(parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : fallback);
}

// `includeNotes`/`includeCards` default true (today's full-deck export). A
// bulk "Cards" or "Notes" only export sets one of these false — critically,
// that must OMIT the notes column / the cards DELETE+INSERT entirely rather
// than sending a blanked value through the normal upsert, which would (if this
// script is ever run against a live database) silently wipe the omitted half
// of every deck it touches instead of just leaving it out of the file.
function buildDeckSql(payloads, title = "Recall SQL Export", { includeNotes = true, includeCards = true } = {}) {
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

function currentDeckPayload(scope = "all") {
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

function exportSql(scope = "all") {
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

async function loadWebDeck(deckId) {
  if (!deckId || !supabaseClient) return;
  if (!navigator.onLine) {
    setStatus("Offline — can't load web decks. Try “My Decks” for device copies.", "error");
    showToast("Offline — can't load web deck", "info");
    return;
  }

  setStatus("Loading deck from web...");
  // A navigation door — see recordNavHistory. Recorded synchronously, before
  // the await below can let anything else move the user.
  recordNavHistory();

  try {
    const [deckResult, cardsResult] = await Promise.all([
      supabaseClient.from("decks").select("*").eq("id", deckId).single(),
      supabaseClient.from("cards").select("*").eq("deck_id", deckId).order("position", { ascending: true })
    ]);

    const { data: deckData, error: deckError } = deckResult;
    if (deckError) throw deckError;

    const { data: cardsData, error: cardsError } = cardsResult;
    if (cardsError) throw cardsError;

    const statusById = {};
    const categoryById = {};
    const cards = cardsData.map((rawCard, index) => {
      const id = String(rawCard.id || `${index}-${rawCard.question.slice(0, 32)}`);
      const status = normalizeCardStatus(rawCard.status);
      if (status) {
        statusById[id] = status;
      }
      if (rawCard.category) categoryById[id] = String(rawCard.category);
      return { id, question: rawCard.question, answer: rawCard.answer };
    });

    state.deckId = deckData.id;
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
    state.categoryById = categoryById;
    // Managed category set lives on the deck's meta bag (quick_notes only).
    applyDeckMetaCategories(deckData.meta, deckData.id, deckData.title);
    state.current = 0; // always start from the first card on fresh load
    state.deckTitle = deckData.title || "";
    state.deckCategory = normalizeDeckCategory(deckData.category);
    // Pre-migration databases have no notes column; select("*") just omits it.
    state.notes = String(deckData.notes || "");
    state.sourceTitle = deckData.title || "";
    state.importTitleHint = deckData.title || "";
    setViewMode("notes");

    syncResults();
    touchWebDeckAccess(deckData.id).catch((error) => console.error("Failed to touch deck access", error));
    closeAllCardsPanel();
    setStatus(`Loaded ${cards.length} cards from web successfully.`);
    showToast(`Loaded "${state.deckTitle || "deck"}" · ${cards.length} cards`);
    if (el.myDecksPanel) el.myDecksPanel.hidden = true;
    unlockPageScroll();
    closeImportPanel();
    showCard();
    // Mirror the freshly-loaded web deck into the on-device library (deduped by
    // cloud id) so it stays readable offline without an extra manual save. Align
    // its timestamps to the cloud copy so it reads as already in-sync — otherwise
    // it would look "newer" and trigger a redundant re-push on the next reconcile.
    state.localDeckId = null;
    const mirroredMeta = saveDeckToLibrary({ silent: true, updatedAt: deckData.updated_at, lastSyncedAt: deckData.updated_at });
    if (mirroredMeta) touchLocalDeckAccess(mirroredMeta.id);
    refreshSyncIndicatorBaseline();
    refreshNavBack(); // arrived — now the button knows where "here" is
  } catch (error) {
    setStatus("Failed to load deck from web.", "error");
    showToast("Couldn't load deck", "error");
    console.error(error);
  }
}

function normalizeSyncText(value) {
  return normalizeMarkdown(String(value || ""))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function syncTextChanged(localValue, webValue) {
  return normalizeSyncText(localValue) !== normalizeSyncText(webValue);
}

function sameSyncContent(localCard, webCard) {
  return !syncTextChanged(localCard.question, webCard.question)
    && !syncTextChanged(localCard.answer, webCard.answer);
}

function uniqueMatchingWebCard(webCards, predicate) {
  const matches = webCards.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function fallbackWebCardFor(localCard, localIndex, unmatchedWebCards, localIds) {
  const candidates = unmatchedWebCards.filter((webCard) => !localIds.has(String(webCard.id)));

  return uniqueMatchingWebCard(candidates, (webCard) => sameSyncContent(localCard, webCard))
    || uniqueMatchingWebCard(candidates, (webCard) => Number(webCard.position) === localIndex)
    || uniqueMatchingWebCard(candidates, (webCard) => (
      normalizeSyncText(localCard.question)
      && normalizeSyncText(localCard.question) === normalizeSyncText(webCard.question)
    ))
    || uniqueMatchingWebCard(candidates, (webCard) => (
      normalizeSyncText(localCard.answer)
      && normalizeSyncText(localCard.answer) === normalizeSyncText(webCard.answer)
    ));
}

// `fuzzy` (default on) lets a local card with no exact id match pair up with a
// web card by content/position — right when the two sides may have drifted ids
// (e.g. an import-minted local deck vs its first web copy). It is WRONG for a
// stable-id diff (old library snapshot vs the same deck's cloud rows), where a
// genuinely deleted card would get spuriously paired with a genuinely added one
// and both miscounted as an "update" — pass `{ fuzzy: false }` there.
function calculateSyncDiff(localCards, webCards, statusById = {}, { fuzzy = true } = {}) {
  const unmatchedWeb = new Map(webCards.map((card) => [String(card.id), card]));
  const localIds = new Set(localCards.map((card) => String(card.id)));
  const changes = {
    added: 0,
    deleted: 0,
    edited: 0,
    moved: 0,
    statusChanges: 0,
    categoryChanges: 0
  };

  localCards.forEach((localCard, index) => {
    const id = String(localCard.id);
    let webCard = unmatchedWeb.get(id) || null;

    if (!webCard && fuzzy) {
      webCard = fallbackWebCardFor(localCard, index, Array.from(unmatchedWeb.values()), localIds);
    }

    if (!webCard) {
      changes.added += 1;
      return;
    }

    unmatchedWeb.delete(String(webCard.id));

    if (syncTextChanged(localCard.question, webCard.question) || syncTextChanged(localCard.answer, webCard.answer)) {
      changes.edited += 1;
    }

    const webPosition = Number(webCard.position);
    if (Number.isFinite(webPosition) && webPosition !== index) {
      changes.moved += 1;
    }

    const localStatus = normalizeCardStatus(statusById[id]);
    const webStatus = normalizeCardStatus(webCard.status);
    if (localStatus !== webStatus) {
      changes.statusChanges += 1;
    }

    // Quick-note label moves are real changes; without this a pull that only
    // recategorised notes reported "no per-card changes".
    if ((localCard.category || null) !== (webCard.category || null)) {
      changes.categoryChanges += 1;
    }
  });

  changes.deleted = unmatchedWeb.size;
  return changes;
}

// Shared HTML for a sync report — every deck reconcileAllDecks() touched,
// what direction it went, and exactly what changed (cards added/updated/
// deleted, notes). Used both by the explicit-sync modal and the inline
// startup report on the welcome screen.
function buildSyncReportHtml(deckLog, { pulled = 0, pushed = 0, failed = 0 } = {}) {
  const describeCounts = (entry) => {
    const parts = describeSyncStats(entry);
    return parts.length ? parts.join(", ") : "no per-card changes (deck metadata only)";
  };

  const rows = deckLog.map((entry) => {
    if (entry.direction === "failed") {
      return `<li class="sync-report-row sync-report-row-error">
        <strong>${escapeHtml(entry.title)}</strong> — sync failed
        <div class="sync-report-detail">${escapeHtml(entry.error || "Unknown error")}</div>
      </li>`;
    }
    const dirLabel = entry.direction === "pulled" ? "⬇ Downloaded from cloud" : "⬆ Uploaded to cloud";
    return `<li class="sync-report-row">
      <strong>${escapeHtml(entry.title)}</strong> — ${dirLabel}
      <div class="sync-report-detail">${describeCounts(entry)}</div>
    </li>`;
  }).join("");

  return `
    <p class="sync-report-summary">${pulled} deck${pulled === 1 ? "" : "s"} downloaded, ${pushed} deck${pushed === 1 ? "" : "s"} uploaded${failed ? `, ${failed} failed` : ""}</p>
    <ul class="sync-report-list">${rows}</ul>
  `;
}

// Post-sync report modal for an EXPLICIT "Sync Now" click only — background
// startup/reconnect syncs render their report inline on the welcome screen
// instead (see renderWelcomeSyncReport) rather than popping a modal.
// Reuses the (otherwise-dead, since the manual "Sync to Cloud" button it was
// written for no longer exists) #syncModal chrome, repurposed as a plain
// report instead of a confirm-before-you-sync prompt.
function showSyncReport(deckLog, { pulled = 0, pushed = 0, failed = 0 } = {}) {
  const modal = el.syncModal;
  const content = el.syncDetailsContent;
  if (!modal || !content) return;

  const titleEl = document.getElementById("syncModalTitle");
  const confirmBtn = document.getElementById("confirmSyncBtn");
  const cancelBtn = document.getElementById("cancelSyncBtn");
  if (titleEl) titleEl.textContent = "Sync Report";
  if (confirmBtn) confirmBtn.hidden = true;
  if (cancelBtn) cancelBtn.textContent = "Close";

  content.innerHTML = buildSyncReportHtml(deckLog, { pulled, pushed, failed });
  modal.hidden = false;
}

// How long any single cloud read/write is allowed to hang before we give up.
// A Supabase call over a dropped/stalled connection otherwise never settles,
// wedging sync (reconcileInFlight never resets) or an EPUB import (whose
// Cancel only polls between steps, not during a hung await).
const CLOUD_TIMEOUT_MS = 20000;

// Reject a hangable network promise after `ms` so a stalled connection fails
// cleanly instead of hanging forever. The message carries "load failed" so it
// classifies as offline through the existing detection regex (see the reconcile
// catch) and the user sees "Couldn't reach the cloud" rather than a spinner
// that never stops. The underlying request may still complete server-side; we
// only wrap idempotent upserts/reads/uploads, so a late success is harmless.
function withTimeout(promise, ms = CLOUD_TIMEOUT_MS, label = "") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Load failed — request timed out${label ? ` (${label})` : ""}`));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Upsert one chunk of card rows, retrying without `category` if the database
// hasn't run supabase_quick_notes.sql yet (no cards.category column). Mirrors
// the deck-level `notes` fallback: never lose card edits over a missing
// optional column.
async function upsertCardRows(rows) {
  if (!rows.length) return;
  const { error } = await withTimeout(supabaseClient.from("cards").upsert(rows), CLOUD_TIMEOUT_MS, "save cards");
  if (!error) return;
  if (!String(error.message || "").includes("category")) throw error;
  console.warn("cards.category column missing — run supabase_quick_notes.sql to sync quick-note categories");
  const stripped = rows.map(({ category: _omit, ...rest }) => rest);
  const { error: retryError } = await withTimeout(supabaseClient.from("cards").upsert(stripped), CLOUD_TIMEOUT_MS, "save cards");
  if (retryError) throw retryError;
}

// Core cloud writer shared by the active-deck sync and the headless
// library-reconcile sync. Upserts the deck row and diff-upserts its cards from
// an explicit payload (never touches `state`). Throws on failure.
// `cards`: [{ id, question, answer, status, category }] in display order.
// `webCards`: this deck's existing cloud rows if the caller already fetched
// them (reconcileAllDecks fetches every deck's in one batched request), else
// null to fetch them here.
async function pushDeckRowsToCloud({ deckId, title, category, notes, currentIndex, cards, isNewDeck, overwrite, now, webCards = null, say = () => {}, silent = true }) {
  const deckData = {
    id: deckId,
    title,
    category,
    notes: notes || "",
    current_card_index: Number.isFinite(currentIndex) ? currentIndex : 0,
    updated_at: now,
    last_accessed_at: now
  };

  // Crash-safe ordering: write the deck row FIRST (a new deck's row must exist
  // to satisfy the cards.deck_id foreign key) but with a stale `updated_at`, so
  // an interrupted push leaves the deck looking un-synced and retriable rather
  // than "current" with missing cards. The real `now` timestamp is stamped last
  // (deckBumpData below), only after every card chunk has landed.
  const PENDING_TS = new Date(0).toISOString();
  const deckDataPending = { ...deckData, updated_at: PENDING_TS };

  let { error: deckError } = await withTimeout(supabaseClient.from("decks").upsert(deckDataPending), CLOUD_TIMEOUT_MS, "save deck");
  if (deckError && String(deckError.message || "").includes("notes")) {
    // Database hasn't run supabase_deck_notes.sql yet — sync everything else so
    // the user doesn't lose card changes, but warn about notes.
    const { notes: _omit, ...deckDataWithoutNotes } = deckDataPending;
    ({ error: deckError } = await withTimeout(supabaseClient.from("decks").upsert(deckDataWithoutNotes), CLOUD_TIMEOUT_MS, "save deck"));
    if (!deckError && String(notes || "").trim() && !silent) {
      showToast("Notes not synced — run supabase_deck_notes.sql in Supabase", "error");
    }
  }
  if (deckError) throw deckError;

  let webCardsById = new Map();
  let cardsDeleted = 0;
  if (overwrite) {
    say("Syncing... (2/3) Replacing existing web cards");
    const { error } = await withTimeout(supabaseClient.from("cards").delete().eq("deck_id", deckId), CLOUD_TIMEOUT_MS, "replace cards");
    if (error) throw error;
  } else if (!isNewDeck) {
    say("Syncing... (2/3) Checking for changes");
    let existing = webCards;
    if (!existing) {
      const { data, error } = await withTimeout(
        supabaseClient
          .from("cards")
          .select("id, question, answer, position, status, category")
          .eq("deck_id", deckId),
        CLOUD_TIMEOUT_MS,
        "read cards"
      );
      if (error) console.warn("Could not read cloud cards before push", deckId, error);
      existing = error ? null : data;
    }
    if (existing) {
      webCardsById = new Map(existing.map((wc) => [String(wc.id), wc]));
      const localIds = new Set(cards.map((c) => String(c.id)));
      const idsToDelete = existing.filter((wc) => !localIds.has(String(wc.id))).map((wc) => wc.id);
      cardsDeleted = idsToDelete.length;
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await withTimeout(
          supabaseClient.from("cards").delete().eq("deck_id", deckId).in("id", idsToDelete),
          CLOUD_TIMEOUT_MS,
          "prune cards"
        );
        if (deleteError) throw deleteError;
      }
    }
  }

  // Tally WHICH kind of change each row represents, not just that it changed —
  // the report names them individually (see describeSyncStats).
  const pushStats = emptySyncStats();
  const cardsData = cards
    .map((card, index) => {
      const status = normalizeCardStatus(card.status);
      const category = card.category ? String(card.category) : null;
      const webCard = webCardsById.get(String(card.id));
      if (!webCard) {
        // isNewDeck/overwrite wiped the web side, so there's nothing to diff
        // against and every row legitimately counts as an addition.
        pushStats.cardsAdded += 1;
        return { id: card.id, deck_id: deckId, question: card.question, answer: card.answer, position: index, status, category, updated_at: now };
      }
      const edited = syncTextChanged(card.question, webCard.question) || syncTextChanged(card.answer, webCard.answer);
      const moved = Number(webCard.position) !== index;
      const restacked = normalizeCardStatus(webCard.status) !== status;
      const recategorised = (webCard.category || null) !== category;
      if (!edited && !moved && !restacked && !recategorised) return null;
      if (edited) pushStats.cardsEdited += 1;
      if (moved) pushStats.cardsMoved += 1;
      if (restacked) pushStats.statusChanges += 1;
      if (recategorised) pushStats.categoryChanges += 1;
      // `category` is sent on EVERY row, never conditionally. PostgREST requires
      // all objects in a bulk upsert to share one key set (PGRST102, "All object
      // keys must match"), so omitting it on the uncategorised rows failed the
      // whole batch for any deck with a mix — and made clearing a category
      // impossible to push. Databases without the column are handled by the
      // retry in upsertCardRows.
      return { id: card.id, deck_id: deckId, question: card.question, answer: card.answer, position: index, status, category, updated_at: now };
    })
    .filter(Boolean);

  say(`Syncing... (3/3) Saving ${cardsData.length} of ${cards.length} cards`);
  const chunkSize = 50;
  // Upload chunks sequentially — parallel Promise.all could leave the cloud
  // in a partial state if chunk N fails while chunk N+1 already succeeded,
  // silently dropping the cards in the failed chunk.
  for (let i = 0; i < cardsData.length; i += chunkSize) {
    await upsertCardRows(cardsData.slice(i, i + chunkSize));
  }

  // Every card is in — NOW advance the deck's `updated_at` (and last-accessed)
  // to the real timestamp. This is the last write of the push, so a crash any
  // time before here leaves the deck stamped at PENDING_TS and therefore
  // re-pushed on the next sync, never falsely current. The caller marks the
  // local deck's lastSyncedAt only after this whole function resolves, and it
  // throws on any failure above, so a partial push is never marked synced.
  const { error: bumpError } = await withTimeout(
    supabaseClient.from("decks").update({ updated_at: now, last_accessed_at: now }).eq("id", deckId),
    CLOUD_TIMEOUT_MS,
    "finalize deck"
  );
  if (bumpError) throw bumpError;

  pushStats.cardsDeleted = cardsDeleted;
  return pushStats;
}


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
  maxPreviewOffset: 128
};

let allCardsRenderId = 0;
let draggedAllCardId = "";
let printTitleBeforeExport = "";
let printPreviewOpen = false;
let allCardsAnswersVisible = false;
// Dense one-line-per-card view for the All Cards panel — ideal for decks of
// short entries (e.g. quick_notes single words / phrases). Persisted so the
// preference sticks across sessions.
let allCardsCompact = localStorage.getItem("recall:allCardsCompact") === "1";
// Status filter for the All Cards panel: "all" | "none" (uncategorized) |
// "review" | "known". Applied as a data-attr on the list so it's a pure CSS
// hide/show that survives status changes without a re-render.
const ALL_CARDS_FILTERS = new Set(["all", "none", "review", "known"]);
let allCardsFilter = localStorage.getItem("recall:allCardsFilter") || "all";
if (!ALL_CARDS_FILTERS.has(allCardsFilter)) allCardsFilter = "all";
const pdfPrintStyleId = "pdfPrintStyle";
let liveQuestionFitFrame = 0;
let markdownTableFitFrame = 0;
let pasteImportAppend = false;
let pastePreviewSource = "";
let pastePreviewCards = [];

const el = {
  sourceInput: document.querySelector("#sourceInput"),
  urlInput: document.querySelector("#urlInput"),
  fileInput: document.querySelector("#fileInput"),
  fileInputCards: document.querySelector("#fileInputCards"),
  fetchBtn: document.querySelector("#fetchBtn"),
  pasteDeckBtn: document.querySelector("#pasteDeckBtn"),
  pasteCardsBtn: document.querySelector("#pasteCardsBtn"),
  pasteEditorPanel: document.querySelector("#pasteEditorPanel"),
  pasteEditorTitle: document.querySelector("#pasteEditorTitle"),
  pasteEditorHint: document.querySelector("#pasteEditorHint"),
  pasteMarkdownInput: document.querySelector("#pasteMarkdownInput"),
  pastePreviewBtn: document.querySelector("#pastePreviewBtn"),
  pastePreviewSummary: document.querySelector("#pastePreviewSummary"),
  pastePreviewList: document.querySelector("#pastePreviewList"),
  pasteImportBtn: document.querySelector("#pasteImportBtn"),
  pasteCancelBtn: document.querySelector("#pasteCancelBtn"),
  parseBtn: document.querySelector("#parseBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  newDeckBtn: document.querySelector("#newDeckBtn"),
  importBtn: document.querySelector("#importBtn"),
  myDecksBtn: document.querySelector("#myDecksBtn"),
  syncNowBtn: document.querySelector("#syncNowBtn"),
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
  closeMyDecksBtn: document.querySelector("#closeMyDecksBtn"),
  myDecksRefreshBtn: document.querySelector("#myDecksRefreshBtn"),
  myDecksNewFolderBtn: document.querySelector("#myDecksNewFolderBtn"),
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
  exportBtn: document.querySelector("#exportBtn"),
  exportMenu: document.querySelector("#exportMenu"),
  exportNotesBtn: document.querySelector("#exportNotesBtn"),
  exportNotesMenu: document.querySelector("#exportNotesMenu"),
  allCardsBtn: document.querySelector("#allCardsBtn"),
  allCardsPanel: document.querySelector("#allCardsPanel"),
  allCardsList: document.querySelector("#allCardsList"),
  allCardsSummary: document.querySelector("#allCardsSummary"),
  toggleAllAnswersBtn: document.querySelector("#toggleAllAnswersBtn"),
  toggleCompactBtn: document.querySelector("#toggleCompactBtn"),
  allCardsFilter: document.querySelector("#allCardsFilter"),
  closeAllCardsBtn: document.querySelector("#closeAllCardsBtn"),
  styleBtn: document.querySelector("#styleBtn"),
  stylePanel: document.querySelector("#stylePanel"),
  styleControls: document.querySelector("#styleControls"),
  closeStyleBtn: document.querySelector("#closeStyleBtn"),
  syncUpBtn: document.querySelector("#syncUpBtn"),
  applyStyleBtn: document.querySelector("#applyStyleBtn"),
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
  questionRenderToolbar: document.querySelector("#questionRenderToolbar"),
  answerRenderToolbar: document.querySelector("#answerRenderToolbar"),
  notesRenderToolbar: document.querySelector("#notesRenderToolbar"),
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
  importSelectorPanel: document.querySelector("#importSelectorPanel"),
  importSelectorListTable: document.querySelector("#importSelectorListTable"),
  selectAllImportSelectorCheckbox: document.querySelector("#selectAllImportSelectorCheckbox"),
  importSelectorLoadBtn: document.querySelector("#importSelectorLoadBtn"),
  importSelectorCancelBtn: document.querySelector("#importSelectorCancelBtn"),
  closeImportSelectorBtn: document.querySelector("#closeImportSelectorBtn"),
  questionEditToolbar: document.querySelector("#questionEditToolbar"),
  answerEditToolbar: document.querySelector("#answerEditToolbar"),
  viewModeToggle: document.querySelector("#viewModeToggle"),
  notesBtn: document.querySelector("#notesBtn"),
  notesStage: document.querySelector("#notesStage"),
  notesView: document.querySelector("#notesView"),
  notesTocBtn: document.querySelector("#notesTocBtn"),
  notesTocDrawer: document.querySelector("#notesTocDrawer"),
  notesTocList: document.querySelector("#notesTocList"),
  notesTocEmpty: document.querySelector("#notesTocEmpty"),
  notesTocCloseBtn: document.querySelector("#notesTocCloseBtn"),
  notesEdit: document.querySelector("#notesEdit"),
  notesEditToolbar: document.querySelector("#notesEditToolbar"),
  editNotesBtn: document.querySelector("#editNotesBtn"),
  makeCardFromSelectionBtn: document.querySelector("#makeCardFromSelectionBtn"),
  makeCardFromNotesBtn: document.querySelector("#makeCardFromNotesBtn"),
  makeCardFromQuestionBtn: document.querySelector("#makeCardFromQuestionBtn"),
  makeCardFromAnswerBtn: document.querySelector("#makeCardFromAnswerBtn"),
  frameCardModal: document.querySelector("#frameCardModal"),
  frameCardAnswerPreview: document.querySelector("#frameCardAnswerPreview"),
  frameCardQuestionInput: document.querySelector("#frameCardQuestionInput"),
  frameCardAddBtn: document.querySelector("#frameCardAddBtn"),
  frameCardCancelBtn: document.querySelector("#frameCardCancelBtn"),
  syncModal: document.querySelector("#syncModal"),
  syncDetailsContent: document.querySelector("#syncDetailsContent"),
  logoutBtn: document.querySelector("#logoutBtn"),
};

marked.setOptions({
  breaks: true,
  gfm: true,
  mangle: false,
  headerIds: false
});

const codeLanguageAliases = {
  cjs: "javascript",
  coffee: "coffeescript",
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  html: "markup",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  tex: "latex",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml"
};

if (window.Prism?.plugins?.autoloader) {
  Prism.plugins.autoloader.languages_path = "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/";
}

let prismPythonConfigured = false;

function configurePrismLanguages() {
  if (prismPythonConfigured || !window.Prism?.languages?.python) return;

  Prism.languages.insertBefore("python", "function", {
    method: {
      pattern: /(\.)[A-Za-z_]\w*(?=\s*\()/,
      lookbehind: true
    },
    "uppercase-constant": /\b[A-Z][A-Z0-9_]*\b/
  });

  prismPythonConfigured = true;
}

function themeById(themeId) {
  const normalized = normalizeThemeId(themeId);
  return themeCatalog.find((theme) => theme.id === normalized) || themeCatalog[0];
}

function normalizeThemeId(themeId) {
  const requested = String(themeId || "").trim();
  const normalized = themeAliases[requested] || requested;
  return themeCatalog.some((theme) => theme.id === normalized) ? normalized : "dark-amoled";
}

function currentThemeId() {
  return normalizeThemeId(document.documentElement.dataset.theme || "dark-amoled");
}

function cssVariableColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function applyThemePreviewStyles(node, theme) {
  if (!node) return;
  node.style.setProperty("--theme-bg", theme.colors.bg);
  node.style.setProperty("--theme-panel", theme.colors.panel);
  node.style.setProperty("--theme-text", theme.colors.text);
  node.style.setProperty("--theme-line", theme.colors.line);
  node.style.setProperty("--theme-accent", theme.colors.accent);
}

function configureMermaid(themeId) {
  const theme = themeById(themeId);
  const isPrintTheme = themeId === "print";
  const card = isPrintTheme ? cssVariableColor("--print-surface", "#ffffff") : cssVariableColor("--card", theme.colors.panel);
  const panel = isPrintTheme ? cssVariableColor("--print-panel", "#ffffff") : cssVariableColor("--panel", theme.colors.panel);
  const bg = isPrintTheme ? cssVariableColor("--print-bg", "#eef2f2") : cssVariableColor("--bg", theme.colors.bg);
  const text = isPrintTheme ? cssVariableColor("--print-text", "#17201c") : cssVariableColor("--text", theme.colors.text);
  const line = isPrintTheme ? cssVariableColor("--print-line", "#b9c9c5") : cssVariableColor("--line", theme.colors.line);
  const muted = isPrintTheme ? cssVariableColor("--print-muted", "#56645f") : cssVariableColor("--muted", theme.colors.text);
  const accent = isPrintTheme ? cssVariableColor("--print-accent", theme.colors.accent) : cssVariableColor("--accent", theme.colors.accent);
  mermaid.initialize({
    startOnLoad: false,
    // "strict" — deck markdown can come from arbitrary URLs/files, and "loose"
    // lets diagram source register click callbacks / unsanitized labels that
    // bypass the DOMPurify pipeline every other rendered surface goes through.
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      primaryColor: card,
      primaryTextColor: text,
      primaryBorderColor: accent,
      lineColor: muted,
      secondaryColor: panel,
      tertiaryColor: bg,
      edgeLabelBackground: panel,
      clusterBkg: panel,
      clusterBorder: line
    }
  });
}

function setTheme(theme) {
  const themeId = normalizeThemeId(theme);
  document.documentElement.dataset.theme = themeId;
  updateThemeControl(themeId);
  configureMermaid(themeId);
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) metaThemeColor.setAttribute("content", themeById(themeId).colors.bg);
  if (state.cards[state.current]) showCard();
  if (el.allCardsPanel && !el.allCardsPanel.hidden) {
    allCardsRenderId += 1;
    renderAllCards();
  }
  try {
    localStorage.setItem(themeStorageKey, themeId);
  } catch (error) {
    console.warn("Could not save theme", error);
  }
}

function renderThemeMenu() {
  if (!el.themeMenu) return;
  el.themeMenu.innerHTML = "";
  ["dark", "light"].forEach((mode) => {
    const label = document.createElement("div");
    label.className = "theme-group-label";
    label.textContent = mode === "light" ? "Light themes" : "Dark themes";
    el.themeMenu.appendChild(label);

    themeCatalog.filter((theme) => theme.mode === mode).forEach((theme) => {
      const button = document.createElement("button");
      button.className = "theme-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.themeOption = theme.id;
      applyThemePreviewStyles(button, theme);
      button.innerHTML = `
        <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
        <span><strong>${theme.label}</strong><small>${theme.description}</small></span>
        <span class="theme-check" aria-hidden="true"></span>
      `;
      applyThemePreviewStyles(button.querySelector(".theme-preview"), theme);
      el.themeMenu.appendChild(button);
    });
  });
}

function updateThemeControl(themeId = currentThemeId()) {
  const theme = themeById(themeId);
  if (el.themeCurrentLabel) el.themeCurrentLabel.textContent = theme.label;
  if (el.themeBtn) {
    el.themeBtn.title = `Theme: ${theme.label}`;
    el.themeBtn.setAttribute("aria-label", `Theme: ${theme.label}. Choose theme.`);
    applyThemePreviewStyles(el.themeBtn.querySelector(".theme-preview"), theme);
  }
  el.themeMenu?.querySelectorAll("[data-theme-option]").forEach((button) => {
    const selected = button.dataset.themeOption === theme.id;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    const check = button.querySelector(".theme-check");
    if (check) check.textContent = selected ? "*" : "";
  });
}

function setThemeMenuOpen(open) {
  if (!el.themeMenu || !el.themeBtn) return;
  el.themeMenu.hidden = !open;
  el.themeBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function resolveFontFamily(value) {
  return fontFamilyChoices[value] || value;
}

function styleValue(source, key, defaults = styleDefaults) {
  return Object.prototype.hasOwnProperty.call(source, key) ? String(source[key]) : defaults[key];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStyleValue(key, value, customDefault) {
  const field = styleFieldByKey[key];
  const defaultValue = customDefault ?? styleDefaults[key];
  const raw = String(value ?? defaultValue ?? "").trim();

  if (!field) return raw || defaultValue;

  if (field.type === "select") {
    return field.options.includes(raw) ? raw : defaultValue;
  }

  if (field.type !== "range") return raw || defaultValue;

  if (!raw) return defaultValue;
  if (!field.unit) return raw;

  const repeatedUnit = new RegExp(`^(-?\\d*\\.?\\d+)(${escapeRegExp(field.unit)})+$`, "i");
  const repeatedUnitMatch = raw.match(repeatedUnit);
  if (repeatedUnitMatch) return `${repeatedUnitMatch[1]}${field.unit}`;

  return /^-?\d*\.?\d+$/.test(raw) ? `${raw}${field.unit}` : raw;
}

function migrateLegacyStyleSettings(raw = {}) {
  const migrated = { ...raw };
  if (Object.prototype.hasOwnProperty.call(raw, "appMaxWidth")) migrated.appWidthPercent = "100";
  if (Object.prototype.hasOwnProperty.call(raw, "cardWidth")) migrated.cardWidthPercent = "96";
  if (Object.prototype.hasOwnProperty.call(raw, "cardMaxHeight")) migrated.cardMaxHeightPercent = "74";
  if (Object.prototype.hasOwnProperty.call(raw, "modalWidth")) migrated.modalWidthPercent = "60";
  if (Object.prototype.hasOwnProperty.call(raw, "textareaMinHeight")) migrated.markdownBoxHeightPercent = "30";
  if (Object.prototype.hasOwnProperty.call(raw, "questionFill")) migrated.questionFillPercent = String(raw.questionFill);
  if (Object.prototype.hasOwnProperty.call(raw, "answerFont")) migrated.answerFontSize = `${Math.round(Number(raw.answerFont) * 16)}px`;
  if (Object.prototype.hasOwnProperty.call(raw, "bodyFont")) migrated.baseFontSize = `${Math.round(Number(raw.bodyFont) * 16)}px`;
  if (Object.prototype.hasOwnProperty.call(raw, "lineHeight")) {
    migrated.baseLineHeight = String(raw.lineHeight);
    migrated.answerLineHeight = String(raw.lineHeight);
    migrated.questionLineHeight = String(raw.lineHeight);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "cardPadding")) migrated.cardPadding = `${raw.cardPadding}px`;
  if (Object.prototype.hasOwnProperty.call(raw, "bodyFontSize")) migrated.baseFontSize = raw.bodyFontSize;
  if (Object.prototype.hasOwnProperty.call(raw, "bodyLineHeight")) migrated.baseLineHeight = raw.bodyLineHeight;
  if (Object.prototype.hasOwnProperty.call(raw, "cardFacePadding")) migrated.cardPadding = raw.cardFacePadding;
  if (Object.prototype.hasOwnProperty.call(raw, "cardFaceGap")) migrated.cardContentGap = raw.cardFaceGap;
  if (Object.prototype.hasOwnProperty.call(raw, "toolbarGap")) migrated.buttonGap = raw.toolbarGap;
  if (Object.prototype.hasOwnProperty.call(raw, "quizPanelPadding")) migrated.panelPadding = raw.quizPanelPadding;
  if (Object.prototype.hasOwnProperty.call(raw, "quizPanelRadius")) migrated.panelCornerRadius = raw.quizPanelRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "cardRadius")) migrated.cardCornerRadius = raw.cardRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "toolbarButtonRadius")) migrated.buttonCornerRadius = raw.toolbarButtonRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "inputRadius")) migrated.inputCornerRadius = raw.inputRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "actionButtonFontSize")) migrated.buttonFontSize = raw.actionButtonFontSize;
  if (Object.prototype.hasOwnProperty.call(raw, "brickGap")) migrated.stackCardGap = raw.brickGap;
  if (Object.prototype.hasOwnProperty.call(raw, "brickFontSize")) migrated.stackCardFontSize = raw.brickFontSize;
  if (Object.prototype.hasOwnProperty.call(raw, "brickLineHeight")) migrated.stackCardLineHeight = raw.brickLineHeight;
  return migrated;
}

function normalizeStyleSettings(raw = {}, profile = "desktop") {
  const source = migrateLegacyStyleSettings(raw || {});
  const defaults = defaultStyleProfiles[profile] || styleDefaults;
  return Object.keys(styleDefaults).reduce((normalized, key) => {
    normalized[key] = normalizeStyleValue(key, styleValue(source, key, defaults), defaults[key]);
    return normalized;
  }, {});
}

function detectStyleProfile() {
  return styleMobileMedia?.matches ? "mobile" : "desktop";
}

function styleProfileLabel(profile) {
  return profile === "mobile" ? "Mobile" : "Desktop";
}

function normalizeStyleProfiles(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const profileSource = source.profiles && typeof source.profiles === "object" ? source.profiles : source;
  const hasProfiles = Boolean(profileSource.desktop || profileSource.mobile);

  if (!hasProfiles) {
    const legacy = normalizeStyleSettings(source, "desktop");
    const mobileLegacySource = { ...defaultStyleProfiles.mobile, ...migrateLegacyStyleSettings(source) };
    return {
      desktop: { ...legacy },
      mobile: normalizeStyleSettings(mobileLegacySource, "mobile")
    };
  }

  const desktopSource = profileSource.desktop || profileSource.mobile || defaultStyleProfiles.desktop;
  const mobileSource = profileSource.mobile || profileSource.desktop || defaultStyleProfiles.mobile;
  return {
    desktop: normalizeStyleSettings(desktopSource, "desktop"),
    mobile: normalizeStyleSettings(mobileSource, "mobile")
  };
}

function setStyleProfiles(raw = {}) {
  state.styleProfiles = normalizeStyleProfiles(raw);
  try {
    localStorage.setItem(styleStorageKey, JSON.stringify(state.styleProfiles));
  } catch (error) {
    console.warn("Could not save style profiles", error);
  }
  return state.styleProfiles;
}

function getStyleProfileSettings(profile = state.styleEditProfile) {
  const normalizedProfile = styleProfiles.includes(profile) ? profile : detectStyleProfile();
  const settings = state.styleProfiles?.[normalizedProfile] || defaultStyleProfiles[normalizedProfile];
  return normalizeStyleSettings(settings, normalizedProfile);
}

function setStyleProfileSettings(profile, rawSettings) {
  const normalizedProfile = styleProfiles.includes(profile) ? profile : detectStyleProfile();
  const settings = normalizeStyleSettings(rawSettings, normalizedProfile);
  state.styleProfiles = {
    ...state.styleProfiles,
    [normalizedProfile]: settings
  };
  if (normalizedProfile === state.activeStyleProfile) state.styleSettings = settings;
  try {
    localStorage.setItem(styleStorageKey, JSON.stringify(state.styleProfiles));
  } catch (error) {
    console.warn("Could not save style profiles", error);
  }
  return settings;
}

function styleProfilesPayload() {
  return {
    version: 2,
    desktop: getStyleProfileSettings("desktop"),
    mobile: getStyleProfileSettings("mobile")
  };
}

function setStyleStatus(message) {
  if (el.styleSyncStatus) el.styleSyncStatus.textContent = message;
}

function renderStyleControls() {
  if (!el.styleControls || el.styleControls.dataset.rendered === "true") return;
  const themeField = el.styleControls.querySelector(".style-field");
  el.styleControls.innerHTML = "";
  if (themeField) el.styleControls.appendChild(themeField);

  const profileField = document.createElement("section");
  profileField.className = "style-profile-field";
  profileField.setAttribute("aria-label", "Style profile");

  const profileHeader = document.createElement("div");
  profileHeader.className = "style-profile-head";
  const profileTitle = document.createElement("span");
  profileTitle.textContent = "Editing profile";
  const profileBadge = document.createElement("strong");
  profileBadge.id = "styleProfileBadge";
  profileHeader.append(profileTitle, profileBadge);
  profileField.appendChild(profileHeader);

  const profileButtons = document.createElement("div");
  profileButtons.className = "style-profile-toggle";
  styleProfiles.forEach((profile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.styleProfile = profile;
    button.textContent = styleProfileLabel(profile);
    profileButtons.appendChild(button);
  });
  profileField.appendChild(profileButtons);

  const profileHint = document.createElement("small");
  profileHint.id = "styleProfileHint";
  profileField.appendChild(profileHint);
  el.styleControls.appendChild(profileField);

  styleControlGroups.forEach((group, groupIndex) => {
    const section = document.createElement("details");
    section.className = "style-section";
    // Start every section folded — the panel opens as a compact list of headings
    // the user expands only where they need to, instead of one long unfolded wall.
    section.open = false;

    const heading = document.createElement("summary");
    heading.textContent = group.title;
    section.appendChild(heading);

    const body = document.createElement("div");
    body.className = "style-section-body";

    group.fields.forEach((field) => {
      const label = document.createElement("label");
      label.className = "style-field";

      const name = document.createElement("span");
      name.textContent = field.label;
      label.appendChild(name);

      let control;
      if (field.type === "select") {
        control = document.createElement("select");
        field.options.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
          control.appendChild(option);
        });
        control.dataset.styleKey = field.key;
        label.appendChild(control);
      } else if (field.type === "range") {
        const rangeRow = document.createElement("div");
        rangeRow.className = "style-range-row";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(field.min);
        slider.max = String(field.max);
        slider.step = String(field.step);
        slider.dataset.styleSlider = field.key;
        slider.dataset.unit = field.unit || "";
        rangeRow.appendChild(slider);

        control = document.createElement("input");
        control.type = "text";
        control.spellcheck = false;
        control.placeholder = styleDefaults[field.key] || "";
        control.dataset.styleKey = field.key;
        control.dataset.unit = field.unit || "";
        rangeRow.appendChild(control);
        label.appendChild(rangeRow);
      } else {
        control = document.createElement("input");
        control.type = "text";
        control.spellcheck = false;
        control.placeholder = styleDefaults[field.key] || "";
        control.dataset.styleKey = field.key;
        label.appendChild(control);
      }

      const hint = document.createElement("small");
      hint.textContent = field.hint;
      label.appendChild(hint);

      body.appendChild(label);
    });

    section.appendChild(body);
    el.styleControls.appendChild(section);
  });

  el.styleControls.dataset.rendered = "true";
}

function numericStyleValue(value) {
  const number = parseFloat(String(value ?? "").match(/-?\d*\.?\d+/)?.[0] ?? "");
  return Number.isFinite(number) ? number : null;
}

function sliderTextValue(slider) {
  return `${slider.value}${slider.dataset.unit || ""}`;
}

function syncSliderFromText(input) {
  const slider = el.styleControls?.querySelector(`[data-style-slider="${input.dataset.styleKey}"]`);
  if (!slider) return;
  const number = numericStyleValue(input.value);
  if (number !== null) slider.value = String(number);
}

function updateStyleProfileUi() {
  if (!el.styleControls) return;
  const activeProfile = detectStyleProfile();
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : activeProfile;
  const badge = el.styleControls.querySelector("#styleProfileBadge");
  const hint = el.styleControls.querySelector("#styleProfileHint");
  if (badge) badge.textContent = styleProfileLabel(editProfile);
  if (hint) {
    const activeLabel = styleProfileLabel(activeProfile);
    const editLabel = styleProfileLabel(editProfile);
    hint.textContent = editProfile === activeProfile
      ? `${activeLabel} values are active on this screen.`
      : `Editing ${editLabel} values. This screen is currently using ${activeLabel}.`;
  }
  el.styleControls.querySelectorAll("[data-style-profile]").forEach((button) => {
    const isEditProfile = button.dataset.styleProfile === editProfile;
    const isActiveProfile = button.dataset.styleProfile === activeProfile;
    button.classList.toggle("is-active", isEditProfile);
    button.classList.toggle("is-device", isActiveProfile);
    button.setAttribute("aria-pressed", String(isEditProfile));
  });
}

function updateStyleControls() {
  renderStyleControls();
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const settings = getStyleProfileSettings(editProfile);
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  updateStyleProfileUi();
  el.styleControls?.querySelectorAll("[data-style-key]").forEach((input) => {
    input.value = settings[input.dataset.styleKey] ?? "";
    input.placeholder = defaults[input.dataset.styleKey] || "";
    syncSliderFromText(input);
  });
}

function applyStyleSettings(rawSettings, options = {}) {
  const settings = normalizeStyleSettings(rawSettings);
  const activeProfile = state.activeStyleProfile || detectStyleProfile();
  state.styleSettings = settings;
  const appWidthPercent = numericStyleValue(settings.appWidthPercent) ?? 100;
  const appHeightPercent = numericStyleValue(settings.appHeightPercent) ?? 100;
  const sidePanelWidthPercent = numericStyleValue(settings.sidePanelWidthPercent) ?? 16;
  const cardWidthPercent = numericStyleValue(settings.cardWidthPercent) ?? 96;
  const cardMaxHeightPercent = numericStyleValue(settings.cardMaxHeightPercent) ?? 74;
  const modalWidthPercent = numericStyleValue(settings.modalWidthPercent) ?? 60;
  const visualMaxWidthPercent = numericStyleValue(settings.visualMaxWidthPercent) ?? (activeProfile === "mobile" ? 90 : 50);
  const markdownBoxHeightPercent = numericStyleValue(settings.markdownBoxHeightPercent) ?? 30;

  const notesMaxWidthPercent = numericStyleValue(settings.notesMaxWidthPercent) ?? 100;

  const root = document.documentElement;
  root.style.setProperty("--app-font-family", resolveFontFamily(settings.fontFamily));
  root.style.setProperty("--question-font-family", resolveFontFamily(settings.questionFontFamily));
  root.style.setProperty("--answer-font-family", resolveFontFamily(settings.answerFontFamily));
  root.style.setProperty("--notes-font-family", resolveFontFamily(settings.notesFontFamily));
  root.style.setProperty("--question-justify-items", questionJustifyItems(settings.questionAlign));
  Object.entries(styleCssVariables).forEach(([key, cssVariable]) => {
    if (key === "questionFontFamily" || key === "answerFontFamily" || key === "notesFontFamily") return;
    root.style.setProperty(cssVariable, settings[key]);
  });
  root.style.setProperty("--notes-max-width", `${notesMaxWidthPercent}%`);
  root.style.setProperty("--question-fill", `${settings.questionFillPercent}%`);
  root.style.setProperty("--app-width", `${appWidthPercent}vw`);
  root.style.setProperty("--app-height", `${appHeightPercent}vh`);
  root.style.setProperty("--app-mobile-width", `${appWidthPercent}vw`);
  root.style.setProperty("--app-mobile-height", `${appHeightPercent}dvh`);
  root.style.setProperty("--side-panel-width", `${sidePanelWidthPercent}%`);
  root.style.setProperty("--card-width", `${cardWidthPercent}%`);
  root.style.setProperty("--card-mobile-width", `${cardWidthPercent}%`);
  root.style.setProperty("--card-max-height", `${cardMaxHeightPercent}vh`);
  root.style.setProperty("--card-mobile-max-height", `${cardMaxHeightPercent}dvh`);
  root.style.setProperty("--modal-width", `${modalWidthPercent}vw`);
  root.style.setProperty("--visual-max-width", `${visualMaxWidthPercent}%`);
  root.style.setProperty("--textarea-min-height", `${markdownBoxHeightPercent}vh`);

  if (!el.stylePanel || el.stylePanel.hidden || state.styleEditProfile === state.activeStyleProfile) {
    updateStyleControls();
  } else {
    updateStyleProfileUi();
  }
  scheduleLiveQuestionFit();
  if (options.force) forceStyleRefresh();

  return settings;
}

function applyActiveStyleSettings(options = {}) {
  const activeProfile = detectStyleProfile();
  state.activeStyleProfile = activeProfile;
  document.documentElement.dataset.styleProfile = activeProfile;
  return applyStyleSettings(getStyleProfileSettings(activeProfile), options);
}

function loadLocalStyleSettings() {
  try {
    const stored = localStorage.getItem(styleStorageKey);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.warn("Could not load style settings from local storage", error);
  }
  return defaultStyleProfiles;
}

function hasMeaningfulStyleSettings(settings) {
  return Boolean(settings && typeof settings === "object" && Object.keys(settings).length > 0);
}

function questionJustifyItems(align) {
  if (align === "right") return "end";
  if (align === "center") return "center";
  if (align === "justify") return "stretch";
  return "start";
}

function styleSettingsFromControls() {
  const settings = {};
  el.styleControls?.querySelectorAll("[data-style-key]").forEach((input) => {
    settings[input.dataset.styleKey] = input.value;
  });
  return normalizeStyleSettings(settings);
}

function handleStyleControlChange() {
  state.styleTouched = true;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const settings = setStyleProfileSettings(editProfile, styleSettingsFromControls());
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings();
  else updateStyleProfileUi();
  scheduleMarkdownTableFit();
  setStyleStatus(`Unsynced ${styleProfileLabel(editProfile).toLowerCase()} style`);
  return settings;
}

function forceStyleRefresh() {
  [el.questionView, el.answerView].forEach((node) => {
    if (!node) return;
    node.style.fontSize = "";
    node.style.transform = "";
    node.style.width = "";
    node.style.removeProperty("--question-fit-font-size");
  });
  document.querySelectorAll(".rendered table").forEach((table) => {
    table.style.fontSize = "";
    delete table.dataset.baseFontSize;
  });
  scheduleMarkdownTableFit();
  scheduleLiveQuestionFit();
  requestAnimationFrame(() => {
    scheduleMarkdownTableFit();
    scheduleLiveQuestionFit();
    if (!el.allCardsPanel?.hidden) renderAllCards();
  });
}

function applyCurrentStyleSettings(statusMessage = "Style applied") {
  state.styleTouched = true;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  setStyleProfileSettings(editProfile, styleSettingsFromControls());
  if (editProfile === detectStyleProfile()) {
    applyActiveStyleSettings({ force: true });
  } else {
    updateStyleProfileUi();
  }
  if (state.previewCard || state.cards[state.current]) {
    showCard();
  }
  setStyleStatus(`${styleProfileLabel(editProfile)} ${statusMessage.toLowerCase()}`);
}

function lockPageScroll() {
  if (document.documentElement.classList.contains("modal-scroll-lock")) return;
  state.stylePanelScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${state.stylePanelScrollY}px`;
  document.documentElement.classList.add("modal-scroll-lock");
  document.body.classList.add("modal-scroll-lock");
}

function unlockPageScroll() {
  if (!document.documentElement.classList.contains("modal-scroll-lock")) return;
  const scrollY = state.stylePanelScrollY || 0;
  document.documentElement.classList.remove("modal-scroll-lock");
  document.body.classList.remove("modal-scroll-lock");
  document.body.style.top = "";
  window.scrollTo(0, scrollY);
}

// True while any modal/panel/overlay is on screen — used to keep the global
// keydown handler's card shortcuts (Space/Enter/arrows/K/R) from silently
// acting on the card underneath an open dialog.
function anyModalOpen() {
  return Boolean(
    (el.confirmModal && !el.confirmModal.hidden) ||
    (el.promptModal && !el.promptModal.hidden) ||
    (el.frameCardModal && !el.frameCardModal.hidden) ||
    (el.myDecksPanel && !el.myDecksPanel.hidden) ||
    (typeof helpModal !== "undefined" && helpModal && !helpModal.hidden) ||
    (el.importSelectorPanel && !el.importSelectorPanel.hidden) ||
    (el.stylePanel && !el.stylePanel.hidden) ||
    (el.diagramModal && !el.diagramModal.hidden) ||
    (el.syncModal && !el.syncModal.hidden) ||
    (el.allCardsPanel && !el.allCardsPanel.hidden) ||
    (el.quickNotesBoard && !el.quickNotesBoard.hidden) ||
    (el.qnCatModal && !el.qnCatModal.hidden) ||
    (el.importPanel && el.importPanel.classList.contains("is-open"))
  );
}

// ── Universal back ───────────────────────────────────────────────
// The appbar's ← works like the back key on a remote: it steps back through the
// places you've been, whatever they were. There is no per-feature wiring and no
// destination label — every navigation records where you WERE on its way out,
// and back replays that.
//
// A "location" is whatever you're looking at: a deck (with the card you were on
// and the view mode) or the Quick Notes board (with its filters/search/scroll).
// Recording happens at the three doors every navigation goes through:
// loadDeckFromLibrary, loadWebDeck and openQuickNotesBoard.
const navHistory = [];
// Bounded: an unbounded stack would pin snapshots forever, and nobody steps
// back further than this.
const NAV_HISTORY_LIMIT = 25;

// >0 while we're replaying history — restoring a location must never be
// recorded as a new navigation, or back would bounce between two places.
let navSuppressDepth = 0;
function suppressNavRecording(fn) {
  navSuppressDepth += 1;
  try { return fn(); } finally { navSuppressDepth -= 1; }
}

// Where the user is right now, or null on the welcome screen (nothing to record).
function currentNavLocation(hint = {}) {
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) {
    return {
      kind: "quick-notes",
      state: {
        cardId: hint.cardId || null,
        filters: [...qnBoard.filters],
        query: qnBoard.query,
        scrollTop: el.qnBody ? el.qnBody.scrollTop : 0
      }
    };
  }
  if (state.localDeckId || state.deckId) {
    return {
      kind: "deck",
      localId: state.localDeckId || null,
      deckId: state.deckId || null,
      current: Number.isFinite(state.current) ? state.current : 0,
      viewMode: state.viewMode
    };
  }
  return null;
}

// Same place? Deck identity only — flipping cards inside a deck isn't a
// navigation, and there's only ever one Quick Notes board.
function sameNavLocation(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "quick-notes") return true;
  return (a.localId || a.deckId) === (b.localId || b.deckId);
}

// Called by each navigation door BEFORE it moves the user.
//
// Deliberately does NOT refresh the button: at this instant the user is still
// at the old location, so "is there anywhere to go back to?" would answer no.
// Each door calls refreshNavBack() once it has actually arrived.
function recordNavHistory(hint) {
  if (navSuppressDepth) return;
  const here = currentNavLocation(hint);
  if (!here) return;
  const top = navHistory[navHistory.length - 1];
  if (top && sameNavLocation(top, here)) navHistory.pop(); // refresh, don't stack
  navHistory.push(here);
  if (navHistory.length > NAV_HISTORY_LIMIT) navHistory.shift();
}

// The newest entry that isn't simply where we already are. Closing the board,
// for instance, lands you back on the deck that's still sitting on top of the
// history — going "back" to it would be a no-op, so skip past it.
function peekNavBack() {
  const here = currentNavLocation();
  for (let i = navHistory.length - 1; i >= 0; i--) {
    if (!sameNavLocation(navHistory[i], here)) return { entry: navHistory[i], index: i };
  }
  return null;
}

function refreshNavBack() {
  if (el.appBackBtn) el.appBackBtn.disabled = !peekNavBack();
}

function clearNavHistory() {
  navHistory.length = 0;
  refreshNavBack();
}

async function goToNavLocation(location) {
  if (location.kind === "quick-notes") {
    qnReturnState = location.state;
    await openQuickNotesBoard({ restore: true });
    return;
  }
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) closeQuickNotesBoard();
  // Prefer the local copy: instant, and works offline.
  if (location.localId && loadDeckFromLibrary(location.localId)) {
    restoreDeckPosition(location);
    return;
  }
  if (location.deckId && supabaseClient && navigator.onLine) {
    await loadWebDeck(location.deckId);
    restoreDeckPosition(location);
    return;
  }
  setStatus("Couldn't go back — that deck isn't available on this device.", "error");
}

// Step back one place. Re-entrancy guarded: restoring is async (it may load a
// deck), and a double-tap would otherwise skip two entries.
let navBackBusy = false;
async function goNavBack() {
  if (navBackBusy) return;
  const found = peekNavBack();
  if (!found) return;
  // Drop the target and anything above it, so back never revisits.
  navHistory.length = found.index;
  navBackBusy = true;
  try {
    await suppressNavRecording(() => goToNavLocation(found.entry));
  } catch (error) {
    console.warn("Could not go back", error);
    setStatus("Couldn't go back to where you were.", "error");
  } finally {
    navBackBusy = false;
    refreshNavBack();
  }
}

// Put the user back on the card and view they were on when they left.
function restoreDeckPosition(location) {
  if (Array.isArray(state.cards) && state.cards.length) {
    state.current = Math.min(Math.max(location.current || 0, 0), state.cards.length - 1);
    showCard();
  }
  if (location.viewMode) setViewMode(location.viewMode);
}

// Closes whichever modal/panel/overlay is currently open, reusing each one's
// own Cancel/Close control so its cleanup (unbinding onclick handlers, etc.)
// runs exactly as it would from a real click — then releases the scroll lock.
// Used by the global Escape handler, which previously only closed a subset of
// these (exportMenu/deckMenu/diagramModal/allCardsPanel/stylePanel/
// importPanel) while unconditionally unlocking scroll — so e.g.
// a confirm/help/prompt dialog was left stuck open with the page scrollable
// behind it.
function closeTopmostOverlay() {
  // Quick Notes: peel back its layers innermost-first so one Escape doesn't
  // dismiss the whole board when only a popover/modal is open.
  if (document.querySelector(".qn-cat-menu")) { closeQnCatMenu(); return; }
  if (el.qnCatModal && !el.qnCatModal.hidden) { closeQnCatModal(); return; }
  if (el.quickNotesBoard && !el.quickNotesBoard.hidden) { closeQuickNotesBoard(); return; }
  el.exportMenu.hidden = true;
  if (el.exportNotesMenu) el.exportNotesMenu.hidden = true;
  closeDiagramModal();
  closeAllCardsPanel();
  closeStylePanel();
  closeImportPanel();
  if (el.myDecksPanel && !el.myDecksPanel.hidden) closeMyDecksPanel();
  if (el.importSelectorPanel && !el.importSelectorPanel.hidden) closeImportSelectorPanel();
  if (typeof helpModal !== "undefined" && helpModal && !helpModal.hidden) closeHelpModal();
  if (el.confirmModal && !el.confirmModal.hidden) el.confirmModalCancelBtn?.click();
  if (el.promptModal && !el.promptModal.hidden) el.promptModalCancelBtn?.click();
  if (el.frameCardModal && !el.frameCardModal.hidden) el.frameCardCancelBtn?.click();
  if (el.syncModal && !el.syncModal.hidden) el.syncModal.hidden = true;
  unlockPageScroll();
}

function openStylePanel() {
  lockPageScroll();
  state.styleEditProfile = detectStyleProfile();
  state.styleEditProfileFollowsDevice = true;
  el.stylePanel.hidden = false;
  updateStyleControls();
}

function closeStylePanel() {
  el.stylePanel.hidden = true;
  unlockPageScroll();
}

function switchStyleEditProfile(profile, options = {}) {
  if (!styleProfiles.includes(profile)) return;
  state.styleEditProfile = profile;
  state.styleEditProfileFollowsDevice = options.followDevice ?? false;
  updateStyleControls();
  setStyleStatus(`Editing ${styleProfileLabel(profile).toLowerCase()} style`);
}

function handleStyleEnvironmentChange() {
  const previousProfile = state.activeStyleProfile;
  applyActiveStyleSettings({ force: true });
  if (!el.stylePanel?.hidden && (state.styleEditProfileFollowsDevice || state.styleEditProfile === previousProfile)) {
    switchStyleEditProfile(detectStyleProfile(), { followDevice: true });
  } else {
    updateStyleProfileUi();
  }
}

async function loadStyleFromWeb(force = false) {
  if (!supabaseClient) {
    setStyleStatus("Local style");
    return;
  }

  setStyleStatus("Loading synced style...");
  try {
    const { data, error } = await supabaseClient
      .from("app_style_settings")
      .select("settings, updated_at")
      .eq("id", "global")
      .maybeSingle();

    if (error) throw error;
    if (!hasMeaningfulStyleSettings(data?.settings)) {
      setStyleStatus("No synced style yet");
      return;
    }
    if (state.styleTouched && !force) {
      setStyleStatus("Unsynced local style");
      return;
    }

    setStyleProfiles(data.settings);
    applyActiveStyleSettings({ force: true });
    state.styleTouched = false;
    updateStyleControls();
    setStyleStatus(data.updated_at ? `Loaded ${new Date(data.updated_at).toLocaleString()}` : "Loaded synced style");
  } catch (error) {
    console.warn("Could not load synced style", error);
    setStyleStatus(
      error?.code === "42501"
        ? "Style sync blocked — check app_style_settings RLS policy"
        : "Style sync table not ready"
    );
  }
}

async function syncStyleToWeb() {
  if (!supabaseClient) {
    setStyleStatus("Supabase unavailable");
    setStatus("Supabase is not available for style sync.", "error");
    return;
  }

  const syncBtn = el.syncUpBtn;
  state.styleTouched = true;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  setStyleProfileSettings(editProfile, styleSettingsFromControls());
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings({ force: true });
  const settings = styleProfilesPayload();
  syncBtn.disabled = true;
  setStyleStatus("Syncing style...");
  try {
    const { error } = await supabaseClient
      .from("app_style_settings")
      .upsert({
        id: "global",
        settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "id" });

    if (error) throw error;
    state.styleTouched = false;
    setStyleStatus("Style synced");
    setStatus("Style synced to web.");
  } catch (error) {
    console.error("Failed to sync style", error);
    setStyleStatus("Sync failed");
    setStatus(
      error?.code === "42501"
        ? "Failed to sync style — its RLS policy doesn't match id: \"global\". Re-run supabase_style_settings.sql (or the app_style_settings section of supabase_schema.sql)."
        : "Failed to sync style. Create the app_style_settings table first.",
      "error"
    );
  } finally {
    syncBtn.disabled = false;
  }
}

function setStatus(message, type = "info") {
  el.statusText.textContent = message;
  el.statusText.classList.toggle("error", type === "error");
}

// Transient toast notification, anchored top-center, used to confirm that
// web-sync actions (sync, load, delete, rename, export, quick note) actually
// completed — visible regardless of where the triggering button lives.
function showToast(message, type = "success") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icon = type === "error" ? "✕" : type === "info" ? "ℹ" : "✓";
  const iconEl = document.createElement("span");
  iconEl.className = "toast-icon";
  iconEl.setAttribute("aria-hidden", "true");
  iconEl.textContent = icon;
  const msgEl = document.createElement("span");
  msgEl.className = "toast-msg";
  msgEl.textContent = message;
  toast.append(iconEl, msgEl);
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("is-visible"));

  const duration = type === "error" ? 4200 : 2600;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.remove("is-visible");
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 280);
  };
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener("click", dismiss);
}

function setButtonLoading(btn, loading, text = "…") {
  if (!btn) return;
  if (loading) {
    btn._loadingOriginalText = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    if (btn._loadingOriginalText !== undefined) btn.textContent = btn._loadingOriginalText;
    btn.disabled = false;
  }
}

function showConfirmModal(message, onConfirm, { confirmLabel = "Confirm", danger = false } = {}) {
  if (!el.confirmModal) return onConfirm();
  el.confirmModalMessage.textContent = message;
  el.confirmModalOkBtn.textContent = confirmLabel;
  el.confirmModalOkBtn.classList.toggle("is-danger", danger);
  el.confirmModal.hidden = false;
  lockPageScroll();
  const cleanup = (confirmed) => {
    el.confirmModal.hidden = true;
    unlockPageScroll();
    el.confirmModalOkBtn.onclick = null;
    el.confirmModalCancelBtn.onclick = null;
    if (confirmed) onConfirm();
  };
  el.confirmModalOkBtn.onclick = () => cleanup(true);
  el.confirmModalCancelBtn.onclick = () => cleanup(false);
}

function showPromptModal(title, hint, defaultValue, onConfirm, { placeholder = "" } = {}) {
  if (!el.promptModal) {
    // Native prompt has no placeholder, so surface the indicative name as the
    // (rare) fallback's default text.
    const result = prompt(title, defaultValue || placeholder);
    if (result !== null) onConfirm(result);
    return;
  }
  el.promptModalTitle.textContent = title;
  el.promptModalHint.textContent = hint || "";
  el.promptModalHint.hidden = !hint;
  // An empty field with an indicative placeholder (e.g. "New Deck") — nothing to
  // clear before typing — instead of a concrete default the user must delete.
  el.promptModalInput.value = defaultValue || "";
  el.promptModalInput.placeholder = placeholder;
  el.promptModal.hidden = false;
  lockPageScroll();
  requestAnimationFrame(() => el.promptModalInput.focus());
  const cleanup = (confirmed) => {
    el.promptModal.hidden = true;
    unlockPageScroll();
    el.promptModalOkBtn.onclick = null;
    el.promptModalCancelBtn.onclick = null;
    el.promptModalInput.onkeydown = null;
    if (confirmed) onConfirm(el.promptModalInput.value);
  };
  el.promptModalOkBtn.onclick = () => cleanup(true);
  el.promptModalCancelBtn.onclick = () => cleanup(false);
  el.promptModalInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
  };
}

let swipeHintTimer = null;
function maybeShowSwipeHint() {
  if (!el.swipeHint) return;
  if (localStorage.getItem("swipe-hint-seen")) return;
  if (!("ontouchstart" in window) && navigator.maxTouchPoints < 1) return;
  el.swipeHint.hidden = false;
  swipeHintTimer = setTimeout(dismissSwipeHint, 3500);
}

function dismissSwipeHint() {
  if (!el.swipeHint || el.swipeHint.hidden) return;
  clearTimeout(swipeHintTimer);
  try { localStorage.setItem("swipe-hint-seen", "1"); } catch (_) {}
  el.swipeHint.classList.add("is-fading");
  setTimeout(() => {
    if (el.swipeHint) {
      el.swipeHint.hidden = true;
      el.swipeHint.classList.remove("is-fading");
    }
  }, 420);
}

function setDeckTitle(title, options = {}) {
  const normalized = String(title || "").trim();
  state.deckTitle = normalized;
  if (options.updateSourceTitle || !state.sourceTitle) {
    state.sourceTitle = normalized;
  }
  if (options.save !== false)  updateMeta();
}

function setDeckCategory(category, options = {}) {
  state.deckCategory = normalizeDeckCategory(category);
  if (options.save !== false)  updateMeta();
}

async function editCurrentDeckTitle() {
  if (!hasActiveDeck()) {
    setStatus("Create or import a deck before editing its title.", "error");
    return;
  }

  showPromptModal("Edit Deck Title", "", state.deckTitle || state.sourceTitle || "Untitled Deck", async (nextTitle) => {
    const title = nextTitle.trim();
    if (!title) {
      setStatus("Deck title cannot be empty.", "error");
      return;
    }

    // 1) Update the live view + every title field (deckTitle/sourceTitle/
    //    importTitleHint) right away so the header never reverts to the old name.
    setDeckTitle(title, { updateSourceTitle: true, save: false });
    state.importTitleHint = title;
    updateMeta();

    // 2) Persist to the local library IMMEDIATELY — independent of any network
    //    round-trip — so the new name survives navigation/reload and, because
    //    renameDeckInLibrary bumps updatedAt, the next reconcile pushes it even
    //    if the cloud call below fails or the device is offline. A working deck
    //    not yet in the library gets saved for the first time. (Previously the
    //    local snapshot was only rewritten inside the awaited cloud call, so a
    //    slow/failed sync left the deck saved under its old name.)
    if (state.localDeckId) {
      renameDeckInLibrary(state.localDeckId, title);
    } else {
      saveDeckToLibrary({ silent: true });
    }
    renderMyDecksList();
    setStatus("Deck title updated.");
    showToast(`Renamed to "${title}"`);

    // 3) Best-effort immediate cloud rename so other devices see it now instead
    //    of waiting for the next periodic reconcile. Failure is non-fatal.
    if (state.deckId && supabaseClient && isSignedIn && navigator.onLine) {
      try {
        await updateWebDeckTitle(state.deckId, title);
        setStatus("Deck title updated in the cloud.");
      } catch (error) {
        console.warn("Cloud rename failed — the next sync will push it", error);
        setStatus("Deck renamed. Cloud update will retry on the next sync.");
      }
    }
  });
}

async function editCurrentDeckCategory() {
  if (!hasActiveDeck()) {
    setStatus("Create or import a deck before editing its category.", "error");
    return;
  }

  const category = await chooseDeckCategory(state.deckCategory);
  if (category === null) return;
  setDeckCategory(category);

  if (!state.deckId || !supabaseClient) {
    setStatus("Deck category updated locally. Sync to update the web deck.");
    return;
  }

  try {
    setStatus("Updating web deck category...");
    await applyWebDeckCategory(state.deckId, category);
    setStatus("Deck category updated in the cloud.");
  } catch (error) {
    console.error("Failed to update web deck category", error);
    setStatus("Deck category updated locally, but cloud category update failed. Run the deck category SQL migration first.", "error");
  }
}

function openImportPanel() {
  lockPageScroll();
  closePasteEditor(false);
  el.importPanel.classList.add("is-open");
}

function closeImportPanel() {
  closePasteEditor(true);
  el.importPanel.classList.remove("is-open");
  unlockPageScroll();
}

function openMyDecksPanel() {
  lockPageScroll();
  el.myDecksPanel.hidden = false;
  // Reset the transient search each time the panel opens so it never surprises
  // the user with a stale filter; keep the persisted view/display/cwd.
  state.myDecksSearch = "";
  if (el.myDecksSearch) el.myDecksSearch.value = "";
  renderMyDecksList();
}

function closeMyDecksPanel() {
  el.myDecksPanel.hidden = true;
  unlockPageScroll();
}

function formatLocalDeckSavedDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

function myDecksEmptyRow(message) {
  return `<tr><td colspan="7" class="web-decks-empty">${escapeHtml(message)}</td></tr>`;
}

// ── Unified deck access ────────────────────────────────────────────────────
// Every My Decks feature that needs full deck content (export, combined bulk
// load) goes through myDeckPayload so it behaves identically for on-device
// decks (offline included) and cloud-only decks: the local snapshot is
// preferred, the cloud is the fallback.

function localDeckPayload(localId) {
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + localId);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    const meta = readLocalDeckIndex().find((m) => m.id === localId) || {};
    return normalizeWebDeckPayload({
      id: snapshot.deckId || localId,
      title: snapshot.deckTitle || meta.title || "Untitled",
      category: snapshot.deckCategory || meta.category,
      notes: snapshot.notes || "",
      current_card_index: snapshot.current || 0,
      created_at: null,
      updated_at: meta.updatedAt || null,
      last_accessed_at: meta.updatedAt || null
    }, (snapshot.cards || []).map((card, index) => ({
      id: card.id,
      deck_id: snapshot.deckId || localId,
      question: card.question,
      answer: card.answer,
      position: index,
      status: card.status
    })));
  } catch (error) {
    console.warn("Could not read local deck snapshot", localId, error);
    return null;
  }
}

async function myDeckPayload({ localId = null, deckId = null } = {}) {
  if (localId) {
    const payload = localDeckPayload(localId);
    if (payload) return payload;
  }
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    return fetchWebDeckPayload(deckId);
  }
  throw new Error("Deck data unavailable — cloud-only decks need a connection");
}

// ── Selection & bulk-action bar ────────────────────────────────────────────

// The single source of truth for the title search, shared by the renderer
// (paintMyDecks) and by folder selection below. They MUST agree: the folder
// tree, its "N decks" label, and what checking that folder selects are all
// derived from this — if selection saw decks the render had filtered out, a
// folder Delete would destroy decks the user could neither see nor count.
function myDecksSearchTerm() {
  return (state.myDecksSearch || "").trim().toLowerCase();
}

function myDeckMatchesSearch(deck) {
  const search = myDecksSearchTerm();
  if (!search) return true;
  return String(deck.title || "").toLowerCase().includes(search);
}

// Checking a folder is equivalent to checking every deck inside it (recursively,
// via decksUnderFolder — same helper folder rename/move/delete already use) — so
// bulk actions Just Work on folders without exportSelectedMyDecks/deleteSelectedMyDecks/
// etc. needing to know folders exist at all. Deduped so a deck both individually
// checked AND covered by a checked ancestor folder isn't acted on twice.
function selectedMyDecks() {
  const host = el.myDecksBody || el.myDecksListTable;
  const direct = Array.from(host?.querySelectorAll(".my-deck-row-checkbox:checked") || [])
    .map((checkbox) => ({
      localId: checkbox.dataset.localId || null,
      deckId: checkbox.dataset.deckId || null
    }));
  const fromFolders = Array.from(host?.querySelectorAll(".my-folder-row-checkbox:checked") || [])
    .map((checkbox) => checkbox.dataset.folderPath)
    .filter(Boolean)
    // Search-filtered to match the folder row the user actually clicked: while a
    // search is active that row is built from — and counts — only the matching
    // decks, so selecting it must not reach the ones hiding behind the filter.
    .flatMap((path) => decksUnderFolder(path).filter(myDeckMatchesSearch).map((entry) => entry.sel));

  const seen = new Set();
  const merged = [];
  [...direct, ...fromFolders].forEach((sel) => {
    const key = `${sel.localId || ""} ${sel.deckId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(sel);
  });
  return merged;
}

// The checked folders themselves. selectedMyDecks() above flattens them away
// into decks, which is all Export/Load/Categorize need — but Delete also has to
// remove the folder, so it needs the paths that selection came from.
function selectedMyFolders() {
  const host = el.myDecksBody || el.myDecksListTable;
  return Array.from(host?.querySelectorAll(".my-folder-row-checkbox:checked") || [])
    .map((checkbox) => checkbox.dataset.folderPath)
    .filter(Boolean);
}

function myDeckSelKey(sel) {
  return `${sel.localId || ""} ${sel.deckId || ""}`;
}

function updateMyDecksBulkBar() {
  // Query the whole body host, not just the table — tiles live in a sibling grid.
  const host = el.myDecksBody || el.myDecksListTable;
  const allBoxes = host?.querySelectorAll(".my-deck-row-checkbox, .my-folder-row-checkbox") || [];
  const checkedBoxes = host?.querySelectorAll(".my-deck-row-checkbox:checked, .my-folder-row-checkbox:checked") || [];
  // Counts what a bulk action will actually touch — a checked folder stands in
  // for the decks inside it — rather than the raw number of ticked boxes. The
  // folder count is spelled out separately because it isn't derivable from the
  // deck count: an empty folder contributes 0 decks but is still deletable.
  const deckCount = selectedMyDecks().length;
  const folderCount = selectedMyFolders().length;
  if (el.myDecksSelectedCount) {
    const bits = [];
    if (folderCount) bits.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    bits.push(`${deckCount} deck${deckCount === 1 ? "" : "s"}`);
    el.myDecksSelectedCount.textContent = folderCount ? bits.join(" · ") : String(deckCount);
  }
  if (el.myDecksBulkActions) el.myDecksBulkActions.hidden = checkedBoxes.length === 0;
  if (el.myDecksSelectAllCheckbox) {
    el.myDecksSelectAllCheckbox.checked = allBoxes.length > 0 && checkedBoxes.length === allBoxes.length;
    el.myDecksSelectAllCheckbox.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < allBoxes.length;
  }
}

// The bare selection checkbox, shared by table rows (wrapped in a <td>) and grid
// tiles. Both keep the same `.my-deck-row-checkbox` class + data-* so bulk
// selection works identically regardless of how the deck is drawn.
function createDeckSelectControl({ localId = null, deckId = null, title = "" } = {}) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "my-deck-row-checkbox web-deck-row-checkbox";
  if (localId) checkbox.dataset.localId = localId;
  if (deckId) checkbox.dataset.deckId = deckId;
  checkbox.setAttribute("aria-label", `Select ${title || "deck"}`);
  checkbox.addEventListener("change", updateMyDecksBulkBar);
  return checkbox;
}

function createDeckSelectCell({ localId = null, deckId = null, title = "" } = {}) {
  const td = document.createElement("td");
  td.dataset.label = "Select";
  td.className = "web-deck-select-cell";
  td.appendChild(createDeckSelectControl({ localId, deckId, title }));
  return td;
}

// Folder counterpart to createDeckSelectControl — same class family (so
// select-all and the bulk-bar counters see it) plus data-folder-path instead
// of a deck id, which selectedMyDecks() expands via decksUnderFolder().
function createFolderSelectControl(path, name = "") {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "my-folder-row-checkbox web-deck-row-checkbox";
  checkbox.dataset.folderPath = path;
  checkbox.setAttribute("aria-label", `Select folder ${name || path}`);
  // Stop click/dragstart from bubbling to the row/tile's own handlers (enter
  // folder, start a re-parent drag) — checking the box should only check it.
  checkbox.addEventListener("click", (e) => e.stopPropagation());
  checkbox.addEventListener("change", updateMyDecksBulkBar);
  return checkbox;
}

// ── Category editing (works for local, synced, and cloud-only decks) ───────

// Offline / not-yet-uploaded path: update the local library only. Bumping
// updatedAt counts as an edit, so the next reconcile pushes the new category.
function setLocalDeckCategory(localId, category) {
  const normalized = normalizeDeckCategory(category);
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.id === localId);
  if (!entry) return;
  entry.category = normalized;
  entry.updatedAt = new Date().toISOString();
  writeLocalDeckIndex(index);
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + localId);
    if (raw) {
      const snapshot = JSON.parse(raw);
      snapshot.deckCategory = normalized;
      localStorage.setItem(LOCAL_DECK_PREFIX + localId, JSON.stringify(snapshot));
    }
  } catch (error) {
    console.warn("Could not update local deck snapshot category", error);
  }
}

async function setMyDeckCategory({ localId = null, deckId = null } = {}, category) {
  const normalized = normalizeDeckCategory(category);
  setKnownWebDeckCategories([...webDeckCategories, normalized]);
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    // Updates the cloud row and keeps the local mirror's meta/timestamp aligned.
    await applyWebDeckCategory(deckId, normalized);
  } else if (localId) {
    setLocalDeckCategory(localId, normalized);
    if (state.localDeckId === localId) {
      state.deckCategory = normalized;
      updateMeta();
    }
  } else {
    throw new Error("Offline — a cloud-only deck can't be categorized right now");
  }
  return normalized;
}

function createDeckCategoryControl(sel, currentCategory, categories, deckTitle) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-category-editor";

  const select = document.createElement("select");
  select.className = "web-deck-category-select";
  select.setAttribute("aria-label", `Category for ${deckTitle || "Untitled"}`);

  categoriesFromDecks([], [...categories, currentCategory]).forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "+ New category";
  select.appendChild(newOption);
  select.value = normalizeDeckCategory(currentCategory);

  const newRow = document.createElement("div");
  newRow.className = "web-deck-category-new";
  newRow.hidden = true;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New category";
  input.autocomplete = "off";
  input.spellcheck = false;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";

  const commit = async (nextCategory) => {
    select.disabled = true;
    saveBtn.disabled = true;
    try {
      setStatus("Updating deck category...");
      const normalized = await setMyDeckCategory(sel, nextCategory);
      setStatus("Deck category updated.");
      showToast(`Category set to "${normalized}"`);
      renderMyDecksList();
    } catch (error) {
      console.error("Failed to update deck category", error);
      setStatus("Failed to update deck category.", "error");
      showToast("Couldn't update category", "error");
      select.disabled = false;
      saveBtn.disabled = false;
      select.value = normalizeDeckCategory(currentCategory);
    }
  };

  select.addEventListener("change", () => {
    if (select.value === "__new__") {
      newRow.hidden = false;
      input.value = "";
      input.focus();
      return;
    }
    const nextCategory = normalizeDeckCategory(select.value);
    if (nextCategory === normalizeDeckCategory(currentCategory)) return;
    commit(nextCategory);
  });

  const saveNewCategory = () => {
    if (!input.value.trim()) {
      setStatus("Category cannot be empty.", "error");
      input.focus();
      return;
    }
    commit(input.value);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveNewCategory();
    if (event.key === "Escape") {
      newRow.hidden = true;
      select.value = normalizeDeckCategory(currentCategory);
    }
  });
  saveBtn.addEventListener("click", saveNewCategory);
  cancelBtn.addEventListener("click", () => {
    newRow.hidden = true;
    select.value = normalizeDeckCategory(currentCategory);
  });

  newRow.append(input, saveBtn, cancelBtn);
  wrap.append(select, newRow);
  return wrap;
}

// ── Rename (local library + immediate cloud rename when reachable) ─────────

function renameMyDeck({ localId = null, deckId = null } = {}, currentTitle = "") {
  showPromptModal("Rename Deck", "", currentTitle || "Untitled", async (nextTitle) => {
    const title = nextTitle.trim();
    if (!title) {
      setStatus("Deck title cannot be empty.", "error");
      return;
    }
    try {
      if (localId) renameDeckInLibrary(localId, title);
      if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
        // Best-effort immediate cloud rename (also re-aligns the local
        // mirror's timestamp); on failure the local rename, whose updatedAt
        // was just bumped, is pushed by the next reconcile anyway.
        try {
          await updateWebDeckTitle(deckId, title);
        } catch (error) {
          console.warn("Cloud rename failed — the next sync will push it", error);
        }
      }
      if ((localId && state.localDeckId === localId) || (deckId && state.deckId && String(state.deckId) === String(deckId))) {
        state.deckTitle = title;
        state.sourceTitle = title;
        updateMeta();
      }
      renderMyDecksList();
      setStatus("Deck renamed.");
      showToast(`Renamed to "${title}"`);
    } catch (error) {
      console.error("Failed to rename deck", error);
      setStatus("Failed to rename deck.", "error");
      showToast("Couldn't rename deck", "error");
    }
  });
}

// ── Exports (single deck, selected decks, everything) ──────────────────────

// Shared writer for every My Decks export path. `payloads` come from
// myDeckPayload; a single payload exports as that deck, several export as one
// document/file with per-deck dividers (PDF) or concatenation (MD/SQL/JSON).
// `contentType` — "both" (default, the single/per-row export's long-standing
// behaviour: cards-only for pdf/html/doc, cards+notes combined for
// markdown/json/sql), or "cards"/"notes" when a bulk export (Export All /
// multi-select) asked the user which one they wanted via chooseExportContent().
async function exportDeckPayloads(payloads, format, { fileBaseName, title }, contentType = "both") {
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
      downloadTextFile(
        payloads.map((payload) => `# ${payload.deck.title}\n\n${String(payload.deck.notes || "").trim() || "*No notes for this deck.*"}`).join("\n\n---\n\n"),
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

async function exportMyDeck(sel, format) {
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

async function exportSelectedMyDecks(selections, format) {
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
async function allMyDeckSelections() {
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

async function exportAllMyDecks(format) {
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

const BACKUP_SCHEMA = "recall-backup";
const BACKUP_VERSION = 1;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Filesystem-safe local timestamp with SECONDS, so multiple backups on the same
// day (and a backup + its pre-restore safety backup moments apart) get distinct
// names instead of colliding. Colons are illegal in filenames -> dashes.
function backupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// Coerce any deck shape we might read from an archive — a per-deck backup file,
// a legacy deckPayloadSnapshot, or a normalizeWebDeckPayload deck+cards bundle —
// into the single shape planRestore/applyRestore work with.
function normalizeBackupDeck(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const title = raw.deckTitle || raw.title || (raw.deck && raw.deck.title) || "Untitled deck";
  return {
    deckId: raw.deckId || raw.deck_id || (raw.deck && raw.deck.id) || null,
    title: String(title),
    category: normalizeDeckCategory(raw.deckCategory || raw.category || (raw.deck && raw.deck.category)),
    notes: String(raw.notes || (raw.deck && raw.deck.notes) || ""),
    current: Number.isFinite(Number(raw.current)) ? Number(raw.current) : 0,
    updatedAt: raw.updatedAt || raw.updated_at || raw.exportedAt || null,
    cards: cards.map((card, index) => ({
      id: String(card.id || `${index}`),
      question: String(card.question || ""),
      answer: String(card.answer || ""),
      status: normalizeCardStatus(card.status),
      ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
    }))
  };
}

async function collectBackupPayloads() {
  const selections = await allMyDeckSelections();
  const payloads = [];
  for (const sel of selections) {
    try {
      payloads.push(await myDeckPayload(sel));
    } catch (error) {
      console.warn("Skipping unavailable deck in backup", sel, error);
    }
  }
  return payloads;
}

async function exportLibraryBackupZip({ fileBaseName } = {}) {
  if (!window.JSZip) {
    setStatus("Backup needs the zip library, which failed to load.", "error");
    return false;
  }
  const payloads = await collectBackupPayloads();
  if (!payloads.length) {
    setStatus("No decks to back up.", "error");
    return false;
  }

  const zip = new JSZip();
  const decksFolder = zip.folder("decks");
  const now = new Date();
  const manifestDecks = [];
  const usedNames = new Set();

  payloads.forEach((payload) => {
    const snapshot = deckPayloadSnapshot(payload);
    const idPart = String(payload.deck.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16)
      || Math.random().toString(36).slice(2, 8);
    const base = `${slugifyFileName(payload.deck.title || "deck") || "deck"}-${idPart}`;
    let name = `${base}.json`;
    let n = 2;
    while (usedNames.has(name)) name = `${base}-${n++}.json`;
    usedNames.add(name);
    decksFolder.file(name, `${JSON.stringify(snapshot, null, 2)}\n`);
    manifestDecks.push({
      file: `decks/${name}`,
      deckId: payload.deck.id || null,
      title: payload.deck.title || "Untitled deck",
      category: payload.deck.category || "",
      cardCount: payload.cards.length,
      hasNotes: Boolean(String(payload.deck.notes || "").trim()),
      updatedAt: payload.deck.updated_at || null
    });
  });

  const manifest = {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    app: "recall",
    exportedAt: now.toISOString(),
    deckCount: payloads.length,
    decks: manifestDecks
  };
  zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file("README.txt", [
    "Recall library backup",
    "",
    `Created: ${now.toISOString()}`,
    `Decks:   ${payloads.length}`,
    "",
    "Layout:",
    "  manifest.json   index of every deck in this archive",
    "  decks/*.json    one file per deck (cards, statuses, notes, category)",
    "",
    "Restore from the app: Import panel -> Restore from backup (or the My Decks",
    "toolbar). Restore compares every deck, card and note against your current",
    "decks and shows a preview before changing anything. It never deletes your",
    "local-only decks or cards; it only adds what's missing and applies edits",
    "from this backup.",
    ""
  ].join("\n"));

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  const name = `${fileBaseName || `recall-backup-${backupTimestamp(now)}`}.zip`;
  downloadBlob(blob, name);
  setStatus(`Backed up ${payloads.length} deck${payloads.length === 1 ? "" : "s"} to ${name}.`);
  return true;
}

// A parsed JSON node is either a multi-deck bundle ({decks:[...]}) or a single
// deck snapshot — normalise both into `out`.
function expandBackupBundleInto(parsed, out) {
  if (parsed && Array.isArray(parsed.decks)) {
    parsed.decks.forEach((deck) => {
      const normalized = normalizeBackupDeck(deck);
      if (normalized) out.push(normalized);
    });
  } else {
    const normalized = normalizeBackupDeck(parsed);
    if (normalized) out.push(normalized);
  }
}

async function readBackupArchive(file) {
  const name = String(file.name || "").toLowerCase();
  const looksZip = /\.zip$/.test(name)
    || file.type === "application/zip"
    || file.type === "application/x-zip-compressed";

  const decks = [];
  if (looksZip) {
    if (!window.JSZip) throw new Error("the zip library failed to load, so this .zip can't be read");
    const zip = await JSZip.loadAsync(file);
    let deckPaths = Object.keys(zip.files).filter((path) => /^decks\/.+\.json$/i.test(path) && !zip.files[path].dir);
    if (!deckPaths.length) {
      // No decks/ folder: accept any root .json (a zipped single/bundle export).
      deckPaths = Object.keys(zip.files).filter((path) => /\.json$/i.test(path) && !path.includes("/") && !/manifest\.json$/i.test(path));
    }
    for (const path of deckPaths) {
      try {
        expandBackupBundleInto(JSON.parse(await zip.files[path].async("string")), decks);
      } catch (error) {
        console.warn("Skipping unreadable deck file in archive", path, error);
      }
    }
    if (!decks.length) throw new Error("no decks found in this archive");
    return decks;
  }

  // Plain JSON export (single snapshot or {decks:[...]} bundle).
  expandBackupBundleInto(JSON.parse(await file.text()), decks);
  if (!decks.length) throw new Error("no decks found in this file");
  return decks;
}

// Match a backup deck to a local library entry: cloud/deck id first, then a
// unique title match. Ambiguous title (2+ local decks share it) → treat as new.
function findLocalMatchForBackupDeck(backupDeck, index) {
  if (backupDeck.deckId) {
    const byId = index.find((meta) => meta.deckId && String(meta.deckId) === String(backupDeck.deckId));
    if (byId) return byId;
  }
  const title = normalizeSyncText(backupDeck.title);
  if (title) {
    const byTitle = index.filter((meta) => normalizeSyncText(meta.title) === title);
    if (byTitle.length === 1) return byTitle[0];
  }
  return null;
}

// Dry run — classify every backup deck against the current device state WITHOUT
// writing anything. Reuses the sync diff engine (fuzzy:false: stable-id diff).
function planRestore(backupDecks) {
  const index = readLocalDeckIndex();
  const decks = [];
  const totals = { newDecks: 0, cardsAdded: 0, cardsUpdated: 0, cardsKept: 0, notesUpdated: 0, unchanged: 0 };

  backupDecks.forEach((backupDeck) => {
    const localMeta = findLocalMatchForBackupDeck(backupDeck, index);
    if (!localMeta) {
      decks.push({ title: backupDeck.title, status: "new", localId: null, backupDeck, counts: { added: backupDeck.cards.length } });
      totals.newDecks += 1;
      totals.cardsAdded += backupDeck.cards.length;
      return;
    }

    let localSnapshot = null;
    try {
      localSnapshot = JSON.parse(localStorage.getItem(LOCAL_DECK_PREFIX + localMeta.id) || "null");
    } catch {
      localSnapshot = null;
    }
    // Newest-wins per deck: the backup only overwrites an existing card or the
    // notes when the backup deck was edited more recently than the local one.
    // A missing card is ALWAYS added back and a local-only card is ALWAYS kept,
    // regardless of direction — those can't lose data either way. Tie / unknown
    // timestamps favour keeping local (never overwrite on a guess).
    const localTime = Date.parse(localMeta.updatedAt || "") || 0;
    const backupTime = Date.parse(backupDeck.updatedAt || "") || 0;
    const backupNewer = backupTime > localTime;

    const localCards = (localSnapshot && localSnapshot.cards) || [];
    // Count by DISTINCT card (id-keyed union), matching exactly what
    // mergeDeckSnapshots does on apply, so the preview never over/under-states.
    const localById = new Map(localCards.map((card) => [String(card.id), card]));
    const backupIds = new Set(backupDeck.cards.map((card) => String(card.id)));
    let backupOnly = 0;  // in backup, not local -> always added back
    let differing = 0;   // id-matched card whose question/answer/status differs
    backupDeck.cards.forEach((backupCard) => {
      const local = localById.get(String(backupCard.id));
      if (!local) {
        backupOnly += 1;
      } else if (
        syncTextChanged(local.question, backupCard.question)
        || syncTextChanged(local.answer, backupCard.answer)
        || normalizeCardStatus(local.status) !== normalizeCardStatus(backupCard.status)
      ) {
        differing += 1;
      }
    });
    const localOnly = localCards.reduce((n, card) => n + (backupIds.has(String(card.id)) ? 0 : 1), 0);

    const localNotes = (localSnapshot && localSnapshot.notes) || "";
    const notesDiffer = syncTextChanged(localNotes, backupDeck.notes);

    // What will actually be written, given the direction.
    const overwritten = backupNewer ? differing : 0;   // matched cards replaced by backup
    const heldLocal = backupNewer ? 0 : differing;     // matched cards kept (local newer/tie)
    const notesUpdated = backupNewer && notesDiffer;
    const notesHeldLocal = notesDiffer && !backupNewer;

    // A write happens only if a card is added, an existing card is overwritten,
    // or the notes are replaced. Differences we deliberately keep local are NOT
    // changes, so a deck where the backup is older with only conflicting edits
    // (and nothing to add) is correctly "unchanged".
    if (!backupOnly && !overwritten && !notesUpdated) {
      decks.push({ title: backupDeck.title, status: "unchanged", localId: localMeta.id, localMeta, localSnapshot, backupDeck, backupNewer, counts: {} });
      totals.unchanged += 1;
      return;
    }

    decks.push({
      title: backupDeck.title,
      status: "conflict",
      localId: localMeta.id,
      localMeta,
      localSnapshot,
      backupDeck,
      backupNewer,
      counts: {
        added: backupOnly,
        overwritten,
        heldLocal,
        kept: localOnly,
        notesUpdated: notesUpdated ? 1 : 0,
        notesHeldLocal: notesHeldLocal ? 1 : 0
      }
    });
    totals.cardsAdded += backupOnly;
    totals.cardsUpdated += overwritten;
    totals.cardsKept += localOnly + heldLocal;
    if (notesUpdated) totals.notesUpdated += 1;
  });

  return { decks, totals };
}

// Stable local id for a restored deck so re-running a restore updates in place
// instead of duplicating (mirrors the deterministic-id reconcile at
// applyCloudDeckToLocal). Reuses an existing local entry if the deckId is known.
function deterministicRestoreLocalId(backupDeck) {
  const index = readLocalDeckIndex();
  if (backupDeck.deckId) {
    const existing = index.find((meta) => meta.deckId && String(meta.deckId) === String(backupDeck.deckId));
    if (existing) return existing.id;
    return `ld_restore_${String(backupDeck.deckId).replace(/[^A-Za-z0-9_-]/g, "")}`;
  }
  return `ld_restore_${slugifyFileName(backupDeck.title || "deck") || "deck"}`;
}

function backupDeckToSnapshot(backupDeck, localId) {
  return {
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: backupDeck.title || "",
    deckCategory: normalizeDeckCategory(backupDeck.category),
    notes: backupDeck.notes || "",
    sourceTitle: backupDeck.title || "",
    importTitleHint: backupDeck.title || "",
    deckId: backupDeck.deckId || null,
    current: backupDeck.current || 0,
    localDeckId: localId,
    cards: backupDeck.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      status: normalizeCardStatus(card.status),
      ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
    }))
  };
}

// Newest-wins union merge. Always: keep every local card, append backup-only
// cards. Only when `backupNewer` is true does the backup overwrite an
// id-matched card's content/status or replace the notes — otherwise the local
// copy is kept. Local-only cards are never dropped in either direction.
function mergeDeckSnapshots(localSnapshot, backupDeck, backupNewer) {
  const local = localSnapshot || {};
  const cards = Array.isArray(local.cards) ? local.cards.slice() : [];
  const indexById = new Map(cards.map((card, i) => [String(card.id), i]));
  let added = 0;
  let updated = 0;

  backupDeck.cards.forEach((backupCard) => {
    const key = String(backupCard.id);
    if (indexById.has(key)) {
      if (!backupNewer) return; // local is newer/tie -> keep the local card as-is
      const i = indexById.get(key);
      const current = cards[i];
      const changed = syncTextChanged(current.question, backupCard.question)
        || syncTextChanged(current.answer, backupCard.answer)
        || normalizeCardStatus(current.status) !== normalizeCardStatus(backupCard.status);
      cards[i] = {
        ...current,
        question: backupCard.question,
        answer: backupCard.answer,
        status: normalizeCardStatus(backupCard.status),
        ...(backupCard.noteAnchor ? { noteAnchor: backupCard.noteAnchor } : {})
      };
      if (changed) updated += 1;
    } else {
      cards.push({
        id: backupCard.id,
        question: backupCard.question,
        answer: backupCard.answer,
        status: normalizeCardStatus(backupCard.status),
        ...(backupCard.noteAnchor ? { noteAnchor: backupCard.noteAnchor } : {})
      });
      added += 1;
    }
  });

  const snapshot = {
    ...local,
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: local.deckTitle || backupDeck.title || "",
    deckCategory: local.deckCategory || normalizeDeckCategory(backupDeck.category),
    notes: backupNewer && syncTextChanged(local.notes || "", backupDeck.notes || "")
      ? (backupDeck.notes || "")
      : (local.notes || ""),
    deckId: local.deckId || backupDeck.deckId || null,
    cards
  };
  return { snapshot, added, updated };
}

function upsertRestoredMeta(localId, snapshot, backupDeck) {
  const index = readLocalDeckIndex();
  const existing = index.find((meta) => meta.id === localId);
  const now = new Date().toISOString();
  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory || defaultDeckCategory,
    cardCount: (snapshot.cards || []).length,
    hasNotes: Boolean(String(snapshot.notes || "").trim()),
    updatedAt: now,
    createdAt: existing?.createdAt || now,
    lastSyncedAt: existing ? existing.lastSyncedAt || null : null,
    accessedAt: existing ? existing.accessedAt || null : null,
    deckId: snapshot.deckId || backupDeck.deckId || null
  };
  writeLocalDeckIndex([meta, ...index.filter((entry) => entry.id !== localId)]);
}

// Confirmation preview — resolves true to apply, false to cancel. Nothing is
// written until the returned promise resolves true.
function showRestorePreview(report) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal restore-preview-modal";
    modal.setAttribute("aria-label", "Restore preview");

    const total = report.totals;
    const summaryBits = [];
    if (total.newDecks) summaryBits.push(`${total.newDecks} new deck${total.newDecks === 1 ? "" : "s"}`);
    if (total.cardsAdded) summaryBits.push(`${total.cardsAdded} card${total.cardsAdded === 1 ? "" : "s"} restored`);
    if (total.cardsUpdated) summaryBits.push(`${total.cardsUpdated} updated`);
    if (total.cardsKept) summaryBits.push(`${total.cardsKept} local kept`);
    if (total.notesUpdated) summaryBits.push(`${total.notesUpdated} notes updated`);
    if (total.unchanged) summaryBits.push(`${total.unchanged} unchanged`);
    const willChange = total.newDecks || total.cardsAdded || total.cardsUpdated || total.notesUpdated;

    const rowsHtml = report.decks.map((entry) => {
      let badge = "MERGE";
      let cls = "is-conflict";
      let detail = "";
      if (entry.status === "new") {
        badge = "NEW";
        cls = "is-new";
        detail = `${entry.counts.added} card${entry.counts.added === 1 ? "" : "s"}`;
      } else if (entry.status === "unchanged") {
        badge = "=";
        cls = "is-unchanged";
        detail = "unchanged";
      } else {
        const c = entry.counts;
        const bits = [];
        if (c.added) bits.push(`+${c.added} restored`);
        if (c.overwritten) bits.push(`~${c.overwritten} updated`);
        if (c.heldLocal) bits.push(`${c.heldLocal} local newer (kept)`);
        if (c.kept) bits.push(`${c.kept} local kept`);
        if (c.notesUpdated) bits.push("notes updated");
        if (c.notesHeldLocal) bits.push("notes differ (local newer, kept)");
        detail = bits.join(" · ") || "changes";
      }
      return `<li class="restore-row ${cls}">`
        + `<span class="restore-badge">${badge}</span>`
        + `<span class="restore-title"></span>`
        + `<span class="restore-detail">${escapeHtml(detail)}</span>`
        + `</li>`;
    }).join("");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell restore-preview-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2>Restore from backup</h2>
          <p>Reviewed against your current decks. Nothing changes until you confirm.</p>
        </div>
        <button type="button" data-restore-cancel aria-label="Close">&#215;</button>
      </div>
      <ul class="restore-deck-list">${rowsHtml}</ul>
      <p class="restore-summary">${escapeHtml(summaryBits.join(" · ") || "No changes to apply.")}</p>
      <p class="restore-note">A full backup of your current decks is saved first, so this is reversible. Local-only decks and cards are never deleted.</p>
      <div class="category-choice-actions">
        <button type="button" data-restore-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-restore-confirm ${willChange ? "" : "disabled"}>Merge &amp; Restore</button>
      </div>
    `;

    // Titles set via textContent (never innerHTML) so deck names can't inject markup.
    const titleSpans = shell.querySelectorAll(".restore-title");
    report.decks.forEach((entry, i) => {
      if (titleSpans[i]) titleSpans[i].textContent = entry.title || "Untitled deck";
    });

    const cleanup = (value) => {
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-restore-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(false));
    });
    shell.querySelector("[data-restore-confirm]")?.addEventListener("click", () => cleanup(true));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(false);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    (shell.querySelector("[data-restore-confirm]:not([disabled])") || shell.querySelector("[data-restore-cancel]"))?.focus();
  });
}

async function applyRestore(report, { autoBackup = true } = {}) {
  if (autoBackup) {
    try {
      await exportLibraryBackupZip({ fileBaseName: `recall-backup-before-restore-${backupTimestamp()}` });
    } catch (error) {
      console.warn("Pre-restore safety backup failed (continuing)", error);
    }
  }

  let addedDecks = 0;
  let mergedDecks = 0;
  let cardsAdded = 0;
  let cardsUpdated = 0;

  report.decks.forEach((entry) => {
    try {
      if (entry.status === "new") {
        const localId = deterministicRestoreLocalId(entry.backupDeck);
        const snapshot = backupDeckToSnapshot(entry.backupDeck, localId);
        localStorage.setItem(LOCAL_DECK_PREFIX + localId, JSON.stringify(snapshot));
        upsertRestoredMeta(localId, snapshot, entry.backupDeck);
        addedDecks += 1;
        cardsAdded += entry.backupDeck.cards.length;
      } else if (entry.status === "conflict") {
        const merged = mergeDeckSnapshots(entry.localSnapshot, entry.backupDeck, entry.backupNewer);
        localStorage.setItem(LOCAL_DECK_PREFIX + entry.localId, JSON.stringify(merged.snapshot));
        upsertRestoredMeta(entry.localId, merged.snapshot, entry.backupDeck);
        mergedDecks += 1;
        cardsAdded += merged.added;
        cardsUpdated += merged.updated;
      }
    } catch (error) {
      console.warn("Failed to restore deck", entry.title, error);
    }
  });

  await renderMyDecksList();

  const parts = [];
  if (addedDecks) parts.push(`${addedDecks} deck${addedDecks === 1 ? "" : "s"} added`);
  if (mergedDecks) parts.push(`${mergedDecks} merged`);
  if (cardsAdded) parts.push(`${cardsAdded} card${cardsAdded === 1 ? "" : "s"} restored`);
  if (cardsUpdated) parts.push(`${cardsUpdated} updated`);
  setStatus(`Restore complete — ${parts.length ? parts.join(", ") : "no changes"}.`);
  showToast("Restore complete", "success");
}

async function runRestoreFlow(file) {
  try {
    setStatus("Reading backup…");
    const backupDecks = await readBackupArchive(file);
    const report = planRestore(backupDecks);
    const confirmed = await showRestorePreview(report);
    if (!confirmed) {
      setStatus("Restore cancelled.");
      return;
    }
    setStatus("Restoring…");
    await applyRestore(report);
  } catch (error) {
    console.error("Restore failed", error);
    setStatus(`Restore failed: ${error && error.message ? error.message : "unreadable backup"}`, "error");
    showToast("Restore failed", "error");
  }
}

function createDeckExportControl(sel, deckTitle, { compact = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-export-wrap";

  const button = document.createElement("button");
  button.className = compact ? "bulk-action-btn bulk-export icon-action" : "bulk-action-btn bulk-export";
  button.type = "button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = "Export deck";
  button.setAttribute("aria-label", `Export ${deckTitle || "Untitled"}`);
  button.textContent = compact ? "⬇" : "Export";

  const menu = document.createElement("div");
  menu.className = "web-deck-export-menu";
  menu.hidden = true;

  [
    ["pdf", "Cornell PDF"],
    ["html", "Standalone HTML"],
    ["doc", "Word (.docx)"],
    ["markdown", "Markdown"],
    ["json", "JSON"],
    ["sql", "SQL"]
  ].forEach(([format, label]) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      exportMyDeck(sel, format);
    });
    menu.appendChild(item);
  });

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldOpen = menu.hidden;
    closeWebDeckExportMenus(menu);
    menu.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
  });

  wrap.append(button, menu);
  return wrap;
}

// ── Bulk actions ───────────────────────────────────────────────────────────

async function loadSelectedMyDecks(selections) {
  if (!selections.length) return;

  if (selections.length === 1) {
    const sel = selections[0];
    // Persist the outgoing deck before its in-memory state is replaced (see
    // the per-row Load handler for why the flush matters).
    flushWorkingDeck();
    if (sel.localId) {
      if (loadDeckFromLibrary(sel.localId)) {
        touchLocalDeckAccess(sel.localId);
        closeMyDecksPanel();
        showToast("Deck loaded");
      }
    } else if (sel.deckId) {
      closeMyDecksPanel();
      loadWebDeck(sel.deckId);
    }
    return;
  }

  setStatus(`Loading ${selections.length} decks...`);
  try {
    const payloads = [];
    for (const sel of selections) payloads.push(await myDeckPayload(sel));
    flushWorkingDeck();

    const combinedCards = [];
    const combinedStatusById = {};
    const usedIds = new Set();
    const titles = [];
    let combinedCategory = "";
    payloads.forEach((payload) => {
      titles.push(payload.deck.title || "Untitled");
      if (!combinedCategory) combinedCategory = normalizeDeckCategory(payload.deck.category);
      payload.cards.forEach((card) => {
        // Older decks may carry deterministic ids that collide across decks —
        // remint on collision so statuses/navigation stay per-card.
        let id = String(card.id);
        while (usedIds.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
        usedIds.add(id);
        combinedCards.push({ id, question: card.question, answer: card.answer });
        const status = normalizeCardStatus(card.status);
        if (status) combinedStatusById[id] = status;
      });
    });

    state.deckId = null;
    // Fresh combined deck — detach from any previously-loaded library entry so
    // its first autosave creates a NEW deck instead of overwriting that one.
    state.localDeckId = null;
    state.masterCards = combinedCards;
    resetStudyDeck(state.masterCards);
    state.statusById = combinedStatusById;
    state.current = 0;
    state.deckTitle = `Combined: ${titles.join(", ")}`.slice(0, 80);
    state.deckCategory = combinedCategory || defaultDeckCategory;
    state.sourceTitle = state.deckTitle;
    state.importTitleHint = state.deckTitle;
    state.notes = "";
    setViewMode("cards");

    syncResults();
    closeAllCardsPanel();
    closeMyDecksPanel();
    showCard();
    setStatus(`Loaded ${selections.length} decks.`);
    showToast(`Loaded ${selections.length} decks · ${combinedCards.length} cards`);
  } catch (error) {
    console.error("Failed to load selected decks", error);
    setStatus("Failed to load selected decks.", "error");
    showToast("Couldn't load selected decks", "error");
  }
}

async function categorizeSelectedMyDecks(selections) {
  if (!selections.length) return;
  const category = await chooseDeckCategory();
  if (category === null) return;

  setStatus(`Updating category for ${selections.length} deck${selections.length === 1 ? "" : "s"}...`);
  let failed = 0;
  for (const sel of selections) {
    try {
      await setMyDeckCategory(sel, category);
    } catch (error) {
      failed += 1;
      console.error("Failed to update deck category", sel, error);
    }
  }
  renderMyDecksList();
  if (failed) {
    setStatus(`Category updated, but ${failed} deck${failed === 1 ? "" : "s"} failed.`, "error");
    showToast(`Couldn't update ${failed} deck${failed === 1 ? "" : "s"}`, "error");
  } else {
    setStatus("Deck categories updated.");
    showToast(`Set category "${normalizeDeckCategory(category)}" on ${selections.length} deck${selections.length === 1 ? "" : "s"}`);
  }
}

// `folders` are the checked folder paths (see selectedMyFolders). Their decks
// are already flattened into `selections`; the paths are needed on top of that
// so the folder itself goes away instead of lingering as an empty "0 decks"
// shell. An empty folder is a valid delete on its own, hence no deck guard.
function deleteSelectedMyDecks(selections, folders = []) {
  if (!selections.length && !folders.length) return;

  const deckPart = `${selections.length} ${selections.length === 1 ? "deck" : "decks"}`;
  const folderPart = `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`;
  const what = folders.length
    ? (selections.length ? `${folderPart} and ${deckPart}` : folderPart)
    : deckPart;

  showConfirmModal(
    `Delete ${what} from this device and the cloud? This cannot be undone.`,
    async () => {
      setStatus(`Deleting ${what}...`);
      // Snapshot which decks are being removed BEFORE deleting, so a folder is
      // only forgotten when the delete empties it. Under an active search a
      // folder keeps decks the filter hid, and those still imply the folder.
      const deletedKeys = new Set(selections.map(myDeckSelKey));
      const emptiedByThisDelete = folders.filter((path) =>
        decksUnderFolder(path).every((entry) => deletedKeys.has(myDeckSelKey(entry.sel)))
      );

      let cloudFailures = 0;
      for (const sel of selections) {
        const { cloudError } = await deleteDeckEverywhere({ localId: sel.localId, deckId: sel.deckId });
        if (cloudError) cloudFailures += 1;
      }
      emptiedByThisDelete.forEach(forgetFolderTree);

      renderMyDecksList();
      if (cloudFailures) {
        showToast("Deleted here — cloud delete will retry on next sync", "info");
      } else {
        showToast(`Deleted ${what} everywhere`, "info");
      }
      setStatus(`Deleted ${what}.`);
    },
    { confirmLabel: "Delete All", danger: true }
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────

// Shared deck helpers used by both the table rows and the grid tiles, so the two
// presentations stay in lock-step. `kind` is "local" | "cloud".
function deckSelOf(deck, kind) {
  return kind === "cloud"
    ? { localId: null, deckId: String(deck.id) }
    : { localId: deck.id, deckId: deck.deckId || null };
}

function deckCardInfo(deck, kind) {
  const count = kind === "cloud"
    ? (Array.isArray(deck.cards) ? deck.cards[0]?.count : deck.cardCount)
    : deck.cardCount;
  const hasNotes = kind === "cloud" ? Boolean(String(deck.notes || "").trim()) : Boolean(deck.hasNotes);
  return { count: count ?? null, hasNotes };
}

// Loads a deck into the study view. Persists the outgoing deck first — the
// autosave debounce resets on every edit, so a pending timer can hold all
// edits/marks since the last pause; without this flush, switching decks before it
// fires would drop them.
function loadDeckEntry(deck, kind) {
  flushWorkingDeck();
  if (kind === "cloud") {
    closeMyDecksPanel();
    loadWebDeck(deck.id);
  } else if (loadDeckFromLibrary(deck.id)) {
    touchLocalDeckAccess(deck.id);
    closeMyDecksPanel();
    showToast(`Loaded "${deck.title || "deck"}"`);
  }
}

function buildDeckLoadButton(deck, kind) {
  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "bulk-action-btn bulk-load";
  loadBtn.textContent = "Load";
  loadBtn.addEventListener("click", () => loadDeckEntry(deck, kind));
  return loadBtn;
}

function buildDeckRenameButton(sel, deck) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bulk-action-btn bulk-category";
  b.textContent = "Rename";
  b.addEventListener("click", () => renameMyDeck(sel, deck.title || ""));
  return b;
}

// Confirms and deletes a deck (from device and/or cloud as appropriate).
function deleteDeckEntry(deck, kind) {
  if (kind === "cloud") {
    showConfirmModal(`Delete "${deck.title || "this deck"}" from the cloud? This cannot be undone.`, async () => {
      const { cloudError } = await deleteDeckEverywhere({ localId: null, deckId: deck.id });
      renderMyDecksList();
      showToast(cloudError ? "Delete failed — will retry on next sync" : "Deck deleted everywhere", "info");
    }, { confirmLabel: "Delete", danger: true });
  } else {
    const inCloud = Boolean(deck.deckId);
    const scope = inCloud ? "from this device and the cloud" : "from this device";
    showConfirmModal(`Delete "${deck.title || "this deck"}" ${scope}? This cannot be undone.`, async () => {
      const { cloudError } = await deleteDeckEverywhere({ localId: deck.id, deckId: deck.deckId || null });
      renderMyDecksList();
      if (cloudError) showToast("Deleted here — cloud delete will retry on next sync", "info");
      else showToast(inCloud ? "Deck deleted everywhere" : "Deck deleted from device", "info");
    }, { confirmLabel: "Delete", danger: true });
  }
}

function buildDeckDeleteButton(deck, kind) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bulk-action-btn bulk-delete";
  b.textContent = "Delete";
  b.addEventListener("click", () => deleteDeckEntry(deck, kind));
  return b;
}

// A compact icon button for the My Decks list actions. Icon-only (with a tooltip
// and aria-label) so the whole row stays tight and never overflows.
function iconActionButton(icon, label, cls, deck, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bulk-action-btn icon-action ${cls}`;
  b.textContent = icon;
  b.title = label;
  b.setAttribute("aria-label", `${label} ${deck.title || "deck"}`);
  b.addEventListener("click", handler);
  return b;
}

// The Load / Export / Rename / Delete cluster for list rows — self-explanatory
// icons (▶ open · ⬇ export · ✎ rename · 🗑 delete) with tooltips + aria-labels.
function buildDeckActions(deck, kind) {
  const sel = deckSelOf(deck, kind);
  const wrap = document.createElement("div");
  wrap.className = "my-deck-actions";
  wrap.append(
    iconActionButton("▶", "Load", "bulk-load", deck, () => loadDeckEntry(deck, kind)),
    createDeckExportControl(sel, deck.title, { compact: true }),
    iconActionButton("✎", "Rename", "bulk-category", deck, () => renameMyDeck(sel, deck.title || "")),
    iconActionButton("🗑", "Delete", "bulk-delete", deck, () => deleteDeckEntry(deck, kind)),
  );
  return wrap;
}

// One row for a deck stored in the on-device library. `cloudById` (Map or null)
// drives the Sync column — null renders a tentative state before the cloud
// fetch resolves.
function buildLocalDeckRow(deck, cloudById = null, categories = webDeckCategories) {
  const tr = document.createElement("tr");
  if (deck.id === state.localDeckId) tr.classList.add("is-current-local-deck");
  const sel = deckSelOf(deck, "local");
  const { count, hasNotes } = deckCardInfo(deck, "local");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.appendChild(createDeckCategoryControl(sel, deck.category, categories, deck.title));

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  tdCount.textContent = String(count ?? "—") + (hasNotes ? " 📝" : "");
  if (hasNotes) tdCount.title = "This deck has study notes";

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.textContent = formatLocalDeckSavedDate(deck.updatedAt);

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  // The flex layout goes on an inner wrapper, not the <td> itself — a table
  // cell with display:flex stops participating in the table's column-track
  // sizing (it gets sized by its flex content instead), which was squeezing
  // this column down to a sliver regardless of its CSS width.
  tdActions.append(buildDeckActions(deck, "local"));

  tr.append(createDeckSelectCell({ ...sel, title: deck.title }), tdTitle, tdCategory, tdCount, tdSaved, deckSyncStatusCell(deck, cloudById), tdActions);
  return tr;
}

// One row for a deck that only exists in the cloud (not yet on this device).
function buildCloudDeckRow(deck, categories = webDeckCategories) {
  const tr = document.createElement("tr");
  tr.classList.add("is-cloud-only-deck");
  const sel = deckSelOf(deck, "cloud");
  const { count, hasNotes } = deckCardInfo(deck, "cloud");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.appendChild(createDeckCategoryControl(sel, deck.category, categories, deck.title));

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  tdCount.textContent = String(count ?? "—") + (hasNotes ? " 📝" : "");

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.className = "my-deck-cloud-tag";
  tdSaved.textContent = "☁ Cloud";
  tdSaved.title = "In the cloud — tap Load to pull it onto this device";

  const status = deckSyncStatus(deck, null, true);
  const tdSync = document.createElement("td");
  tdSync.dataset.label = "Sync";
  tdSync.classList.add("my-deck-sync", status.cls);
  tdSync.textContent = status.label;
  tdSync.title = status.title;

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  tdActions.append(buildDeckActions(deck, "cloud"));

  tr.append(createDeckSelectCell({ ...sel, title: deck.title }), tdTitle, tdCategory, tdCount, tdSaved, tdSync, tdActions);
  return tr;
}

async function fetchCloudDeckList() {
  const { data, error } = await withTimeout(
    supabaseClient
      .from("decks")
      .select("*, cards(count)")
      .order("last_accessed_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false }),
    CLOUD_TIMEOUT_MS,
    "read deck list"
  );
  if (error) throw error;
  return data || [];
}

// Cards for MANY decks in one request, instead of one round trip per deck.
// On a phone each round trip costs a full RTT, so a 20-deck sync spent most of
// its time waiting rather than transferring — the per-deck loops now read from
// the map this returns. Paged because PostgREST caps a response at ~1000 rows
// (a limit a per-deck query rarely hit but a batched one easily does): keep
// asking until a short page comes back, or rows would be silently dropped and
// the sync would read the missing cards as "deleted in the cloud".
async function fetchCardsForDecks(deckIds, columns = "*") {
  const byDeck = new Map(deckIds.map((id) => [String(id), []]));
  if (!deckIds.length) return byDeck;
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await withTimeout(
      supabaseClient
        .from("cards")
        .select(columns)
        .in("deck_id", deckIds)
        .order("deck_id", { ascending: true })
        .order("position", { ascending: true })
        .range(from, from + pageSize - 1),
      CLOUD_TIMEOUT_MS,
      "download cards"
    );
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      const bucket = byDeck.get(String(row.deck_id));
      if (bucket) bucket.push(row);
    }
    if (rows.length < pageSize) break;
  }
  return byDeck;
}

// Cross-device delete tombstones (see supabase_deck_tombstones.sql). A local
// tombstone alone only stops THIS device from resurrecting a deck it deleted —
// another device that hasn't reconciled since still holds a local copy and
// will push it right back. This durable, shared list is what lets that other
// device learn "this deck was deleted elsewhere" before it re-pushes.
// Best-effort: an unmigrated project (table doesn't exist yet) degrades to the
// old local-only behavior rather than breaking sync.
async function fetchDeletedDeckIds() {
  try {
    const { data, error } = await withTimeout(supabaseClient.from("deleted_decks").select("deck_id"), CLOUD_TIMEOUT_MS, "read tombstones");
    if (error) throw error;
    return (data || []).map((row) => String(row.deck_id));
  } catch (error) {
    console.warn("Could not fetch deck-deletion tombstones (run supabase_deck_tombstones.sql?)", error);
    return [];
  }
}

// Per-deck sync state for the My Decks "Sync" column, comparing the on-device
// copy against the cloud (when we can reach it). `cloudById` is a Map of cloud
// decks, or null when we haven't/can't fetch it. Mirrors the timestamp logic
// reconcileAllDecks uses to decide direction, so the column predicts what the
// next sync will do to each deck.
// Presentation-agnostic sync state — { label, cls, title } — consumed by both the
// table "Sync" cell and the grid-tile sync badge. `cloudOnly` short-circuits to the
// cloud-only badge (a deck not yet on this device).
function deckSyncStatus(deck, cloudById, cloudOnly = false) {
  if (cloudOnly) {
    return { label: "☁ Cloud only", cls: "sync-cloud-only", title: "In the cloud but not on this device yet — Load to pull it down." };
  }
  const canCloud = Boolean(supabaseClient && isSignedIn);
  let label, cls, title;
  if (!canCloud) {
    label = "💾 On device"; cls = "sync-local";
    title = "Saved on this device. Sign in to back it up to the cloud.";
  } else if (!navigator.onLine || !cloudById) {
    if (!deck.deckId) {
      label = "⬆ Pending"; cls = "sync-pending";
      title = "Not uploaded yet — will sync once you're back online.";
    } else {
      label = "📴 Offline"; cls = "sync-local";
      title = "Can't reach the cloud right now — will re-check when you're online.";
    }
  } else if (!deck.deckId) {
    label = "⬆ Pending"; cls = "sync-pending";
    title = "Not uploaded yet — will upload on the next sync.";
  } else {
    const cloud = cloudById.get(String(deck.deckId));
    if (!cloud) {
      label = "⬆ Pending"; cls = "sync-pending";
      title = "Not in the cloud yet — will upload on the next sync.";
    } else {
      const localMs = tsMs(deck.updatedAt);
      const cloudMs = tsMs(cloud.updated_at);
      if (localMs > cloudMs) {
        label = "⬆ Pending"; cls = "sync-pending";
        title = "Edited here since the last sync — will upload on the next sync.";
      } else if (cloudMs > localMs) {
        label = "⬇ Update"; cls = "sync-behind";
        title = "A newer copy is in the cloud — will download on the next sync.";
      } else {
        label = "✅ Synced"; cls = "sync-ok";
        title = "In sync with the cloud.";
      }
    }
  }
  return { label, cls, title };
}

function deckSyncStatusCell(deck, cloudById) {
  const { label, cls, title } = deckSyncStatus(deck, cloudById);
  const td = document.createElement("td");
  td.dataset.label = "Sync";
  td.classList.add("my-deck-sync", cls);
  td.textContent = label;
  td.title = title;
  return td;
}

// Repopulates the category filter from every known category, preserving the
// current selection when it still exists. Returns the active filter value.
function populateMyDecksCategoryFilter(categories) {
  const filter = el.myDecksCategoryFilter;
  if (!filter) return "";

  const selected = filter.value || "";
  filter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All folders";
  filter.appendChild(allOption);
  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    filter.appendChild(option);
  });
  filter.value = categories.includes(selected) ? selected : "";
  return filter.value;
}

// ── Folder tree: drag-and-drop state & operations ──────────────────────────
// The deck currently being dragged, or a folder being re-parented. Held at
// module scope because dragstart (on the row) and drop (on a folder) are
// separate events on different elements.
let myDecksDrag = null;
// Snapshot of the decks in the last render, so folder rename/move/delete can
// iterate every affected deck (including cloud-only ones) without re-fetching.
let myDecksRendered = { local: [], cloudOnly: [] };

function clearFolderDropHighlights() {
  el.myDecksListTable?.querySelectorAll(".drag-over").forEach((row) => row.classList.remove("drag-over"));
}

function toggleFolderCollapsed(path) {
  const expanded = readExpandedFolders();
  const key = normalizeDeckCategory(path);
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  writeExpandedFolders(expanded);
  repaintMyDecks();
}

// Expands (or collapses) every folder currently in the tree at once.
function setAllFoldersExpanded(expand) {
  if (!expand) { writeExpandedFolders(new Set()); repaintMyDecks(); return; }
  const paths = new Set();
  const walk = (node) => node.children.forEach((child) => { paths.add(child.path); walk(child); });
  const entries = [
    ...(myDecksRendered.local || []).map((deck) => ({ deck, kind: "local" })),
    ...(myDecksRendered.cloudOnly || []).map((deck) => ({ deck, kind: "cloud" })),
  ];
  walk(buildFolderTree(entries, readKnownFolders()));
  writeExpandedFolders(paths);
  repaintMyDecks();
}

// True when every folder in the current tree is already expanded (drives the
// Expand-all / Collapse-all toggle label).
function allFoldersExpanded() {
  const expanded = readExpandedFolders();
  const entries = [
    ...(myDecksRendered.local || []).map((deck) => ({ deck, kind: "local" })),
    ...(myDecksRendered.cloudOnly || []).map((deck) => ({ deck, kind: "cloud" })),
  ];
  let total = 0, open = 0;
  const walk = (node) => node.children.forEach((child) => { total += 1; if (expanded.has(child.path)) open += 1; walk(child); });
  walk(buildFolderTree(entries, readKnownFolders()));
  return total > 0 && open === total;
}

function folderTotalDeckCount(node) {
  let count = node.decks.length;
  node.children.forEach((child) => { count += folderTotalDeckCount(child); });
  return count;
}

// Most-recent "opened" time for one deck entry, local or cloud, as epoch ms
// (0 if never recorded) — the shared key everything in the My Decks
// navigation sorts by, so recently-used decks and folders surface first.
function deckAccessTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local"
    ? (deck.accessedAt || deck.updatedAt)
    : (deck.last_accessed_at || deck.updated_at);
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

// A folder's own recency is the most recent access time among any deck it
// (or any of its descendants) contains — so a folder you touched five
// minutes ago outranks one you haven't opened in months, same as a deck would.
function folderMostRecentAccess(node) {
  let max = 0;
  node.decks.forEach((entry) => { max = Math.max(max, deckAccessTime(entry)); });
  node.children.forEach((child) => { max = Math.max(max, folderMostRecentAccess(child)); });
  return max;
}

// Sort key builders for My Decks — each returns a comparable value for one
// entry ({ deck, kind }). deckAccessTime() above is the "recent" key; these
// cover the rest of MYDECKS_SORT_OPTIONS.
function deckUpdatedTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local" ? deck.updatedAt : deck.updated_at;
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

// Local decks only started recording createdAt once this sort existed — a
// deck saved before that falls back to updatedAt, the closest thing on hand.
function deckCreatedTime(entry) {
  const deck = entry.deck;
  const raw = entry.kind === "local" ? (deck.createdAt || deck.updatedAt) : (deck.created_at || deck.updated_at);
  const t = Date.parse(raw || "");
  return Number.isFinite(t) ? t : 0;
}

function deckSizeValue(entry) {
  return deckCardInfo(entry.deck, entry.kind).count ?? 0;
}

function deckTitleValue(entry) {
  return (entry.deck.title || "Untitled deck").toLowerCase();
}

function myDecksSortComparator(sort) {
  switch (sort) {
    case "title-asc": return (a, b) => deckTitleValue(a).localeCompare(deckTitleValue(b));
    case "title-desc": return (a, b) => deckTitleValue(b).localeCompare(deckTitleValue(a));
    case "updated-desc": return (a, b) => deckUpdatedTime(b) - deckUpdatedTime(a);
    case "created-desc": return (a, b) => deckCreatedTime(b) - deckCreatedTime(a);
    case "size-desc": return (a, b) => deckSizeValue(b) - deckSizeValue(a);
    default: return (a, b) => deckAccessTime(b) - deckAccessTime(a);
  }
}

function sortedFolderChildren(node) {
  const children = Array.from(node.children.values());
  const sort = state.myDecksSort;
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (sort === "title-asc" || sort === "title-desc") {
    children.sort((a, b) => byName(a, b) * (sort === "title-desc" ? -1 : 1));
  } else if (sort === "size-desc") {
    children.sort((a, b) => folderTotalDeckCount(b) - folderTotalDeckCount(a) || byName(a, b));
  } else {
    // recent / updated / created all fall back to the same recency proxy —
    // a folder has no single "updated at" of its own beyond what its decks did.
    children.sort((a, b) => folderMostRecentAccess(b) - folderMostRecentAccess(a) || byName(a, b));
  }
  return children;
}

// Every visible deck (local + cloud-only) whose category is `path` or nested
// under it, as { sel, category } — the unit folder rename/move/delete act on.
function decksUnderFolder(path) {
  const out = [];
  (myDecksRendered.local || []).forEach((deck) => {
    if (isCategoryUnder(deck.category, path)) {
      out.push({ sel: { localId: deck.id, deckId: deck.deckId || null }, category: normalizeDeckCategory(deck.category), title: deck.title || "" });
    }
  });
  (myDecksRendered.cloudOnly || []).forEach((deck) => {
    if (isCategoryUnder(deck.category, path)) {
      out.push({ sel: { localId: null, deckId: String(deck.id) }, category: normalizeDeckCategory(deck.category), title: deck.title || "" });
    }
  });
  return out;
}

// Re-paths every deck under `fromPath` (and the known-folder + collapsed
// registries) so the `fromPath` prefix becomes `toPath`. Used by folder
// rename, move (re-parent), and delete-into-parent.
async function rewriteFolderPaths(fromPath, toPath) {
  const affected = decksUnderFolder(fromPath);
  for (const item of affected) {
    await setMyDeckCategory(item.sel, rewriteCategoryPrefix(item.category, fromPath, toPath));
  }
  writeKnownFolders(readKnownFolders().map((p) => rewriteCategoryPrefix(p, fromPath, toPath)));
  const nextExpanded = new Set();
  readExpandedFolders().forEach((p) => nextExpanded.add(rewriteCategoryPrefix(p, fromPath, toPath)));
  writeExpandedFolders(nextExpanded);
  // Keep the Folder-view cwd pointing at the renamed/moved folder if we were in it.
  if (state.myDecksCwd && isCategoryUnder(state.myDecksCwd, fromPath)) {
    setMyDecksCwd(rewriteCategoryPrefix(state.myDecksCwd, fromPath, toPath));
  }
  return affected.length;
}

function createFolder(parentPath = "") {
  showPromptModal("New folder", parentPath ? `Inside "${parentPath}"` : "", "", (rawName) => {
    // Empty field, "New folder" placeholder — falls back to that indicative name
    // if left blank, so there's nothing to clear before typing.
    const name = String(rawName || "").trim() || "New folder";
    const path = normalizeDeckCategory(parentPath ? `${parentPath}${FOLDER_SEP}${name}` : name);
    if (path === defaultDeckCategory) { showToast("Folder name can't be empty", "error"); return; }
    addKnownFolder(path);
    if (parentPath) { const ex = readExpandedFolders(); ex.add(normalizeDeckCategory(parentPath)); writeExpandedFolders(ex); }
    showToast(`Folder "${path}" created`);
    renderMyDecksList();
  }, { placeholder: "New folder" });
}

function renameFolder(path) {
  const segments = folderSegments(path);
  const parent = segments.slice(0, -1).join(FOLDER_SEP);
  showPromptModal("Rename folder", "", segments[segments.length - 1] || "", async (name) => {
    const nextPath = normalizeDeckCategory(parent ? `${parent}${FOLDER_SEP}${name}` : name);
    if (nextPath === defaultDeckCategory) { showToast("Folder name can't be empty", "error"); return; }
    if (nextPath === normalizeDeckCategory(path)) return;
    try {
      await rewriteFolderPaths(path, nextPath);
      showToast(`Renamed to "${nextPath}"`);
      renderMyDecksList();
    } catch (error) {
      console.error("Folder rename failed", error);
      showToast("Couldn't rename — offline?", "error");
    }
  });
}

// Re-parents `fromPath` under `newParentPath` (root when ""), keeping its own
// last segment. Refuses to drop a folder into itself or its own descendant.
async function moveFolder(fromPath, newParentPath) {
  const from = normalizeDeckCategory(fromPath);
  const leaf = folderSegments(from).slice(-1)[0] || "";
  const nextPath = normalizeDeckCategory(newParentPath ? `${newParentPath}${FOLDER_SEP}${leaf}` : leaf);
  if (nextPath === from) return 0;
  if (isCategoryUnder(nextPath, from)) return 0; // would nest a folder inside itself
  return rewriteFolderPaths(from, nextPath);
}

function deleteFolder(path) {
  const segments = folderSegments(path);
  const leaf = segments[segments.length - 1] || path;
  const parent = segments.slice(0, -1).join(FOLDER_SEP);
  const total = decksUnderFolder(path).length;
  const message = total > 0
    ? `Delete folder "${leaf}"? Its ${total === 1 ? "1 deck moves" : total + " decks move"} to ${parent || "Uncategorized"}. No decks are deleted.`
    : `Delete empty folder "${leaf}"?`;
  showConfirmModal(message, async () => {
    try {
      await rewriteFolderPaths(path, parent);
      showToast(`Folder "${leaf}" deleted`);
      renderMyDecksList();
    } catch (error) {
      console.error("Folder delete failed", error);
      showToast("Couldn't delete — offline?", "error");
    }
  }, { confirmLabel: "Delete", danger: true });
}

// Resolves a completed drop onto `folderPath` ("" = root/Uncategorized).
async function handleDropOnFolder(folderPath) {
  const drag = myDecksDrag;
  myDecksDrag = null;
  clearFolderDropHighlights();
  if (!drag) return;
  try {
    if (drag.type === "deck") {
      if (normalizeDeckCategory(drag.category) === normalizeDeckCategory(folderPath)) return;
      await setMyDeckCategory(drag.sel, folderPath);
      showToast(`Moved to "${normalizeDeckCategory(folderPath)}"`);
      renderMyDecksList();
    } else if (drag.type === "folder") {
      if (folderPath === drag.path || isCategoryUnder(folderPath, drag.path)) return;
      await moveFolder(drag.path, folderPath);
      showToast("Folder moved");
      renderMyDecksList();
    }
  } catch (error) {
    console.error("Drop failed", error);
    showToast("Couldn't move — offline?", "error");
  }
}

// Wires an element as a drop target for `folderPath`; rejects illegal folder
// drops (onto self/descendant) so the cursor shows "no-drop".
function attachFolderDropTarget(row, folderPath) {
  row.addEventListener("dragover", (e) => {
    if (!myDecksDrag) return;
    if (myDecksDrag.type === "folder" && (folderPath === myDecksDrag.path || isCategoryUnder(folderPath, myDecksDrag.path))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => { e.preventDefault(); handleDropOnFolder(folderPath); });
}

// One collapsible folder header row (spans all columns).
function buildFolderRow(node, depth, isCollapsed) {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row";
  tr.dataset.folderPath = node.path;
  tr.style.setProperty("--folder-depth", String(depth));
  tr.draggable = true;

  const td = document.createElement("td");
  td.colSpan = 7;
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-wrap";
  wrap.appendChild(createFolderSelectControl(node.path, node.name));

  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "deck-folder-twisty";
  twisty.setAttribute("aria-label", isCollapsed ? "Expand folder" : "Collapse folder");
  twisty.textContent = isCollapsed ? "▶" : "▼";
  twisty.addEventListener("click", () => toggleFolderCollapsed(node.path));

  const label = document.createElement("button");
  label.type = "button";
  label.className = "deck-folder-label";
  label.innerHTML = `<span class="deck-folder-icon">📁</span><span class="deck-folder-name"></span>`;
  label.querySelector(".deck-folder-name").textContent = node.name;
  label.addEventListener("click", () => toggleFolderCollapsed(node.path));

  const total = folderTotalDeckCount(node);
  const count = document.createElement("span");
  count.className = "deck-folder-count";
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;

  const actions = document.createElement("div");
  actions.className = "deck-folder-actions";
  const mkBtn = (text, title, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "deck-folder-action";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", handler);
    return b;
  };
  actions.append(
    mkBtn("+", "New subfolder", () => createFolder(node.path)),
    mkBtn("Rename", "Rename folder", () => renameFolder(node.path)),
    mkBtn("Delete", "Delete folder", () => deleteFolder(node.path)),
  );

  wrap.append(twisty, label, count, actions);
  td.append(wrap);
  tr.append(td);

  attachFolderDropTarget(tr, node.path);
  tr.addEventListener("dragstart", (e) => {
    if (e.target.closest(".deck-folder-action, .deck-folder-twisty, input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tr.addEventListener("dragend", () => { tr.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tr;
}

// The always-present root drop target — drag a deck or folder here to lift it
// out of any folder (back to Uncategorized / top level).
function buildRootDropRow() {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row deck-root-row";
  const td = document.createElement("td");
  td.colSpan = 7;
  td.innerHTML = `<div class="deck-folder-wrap"><span class="deck-folder-icon">🏠</span><span class="deck-folder-name">All decks</span><span class="deck-root-hint">drop here to remove from a folder</span></div>`;
  tr.append(td);
  attachFolderDropTarget(tr, "");
  return tr;
}

// Makes any deck element (table row or grid tile) a drag source for filing into a
// folder. Dragging is suppressed when it starts on an interactive control so the
// checkbox, buttons, and inline category editor stay usable.
function makeDeckDraggable(el, sel, deck) {
  el.dataset.folder = normalizeDeckCategory(deck.category);
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    if (e.target.closest("input, select, textarea, button, a, .web-deck-category-editor")) { e.preventDefault(); return; }
    myDecksDrag = { type: "deck", sel, category: normalizeDeckCategory(deck.category), title: deck.title || "" };
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", deck.title || "deck"); } catch (_) {}
  });
  el.addEventListener("dragend", () => { el.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
}

// Table-row variant: adds the tree indent + row class, then shared drag behaviour.
function decorateDeckRow(tr, sel, deck, indentLevel) {
  tr.classList.add("my-deck-row");
  tr.style.setProperty("--folder-depth", String(indentLevel));
  makeDeckDraggable(tr, sel, deck);
}

function renderFolderDecks(tbody, node, depth, ctx) {
  node.decks.forEach((entry) => {
    const tr = entry.kind === "local"
      ? buildLocalDeckRow(entry.deck, ctx.cloudById, ctx.categories)
      : buildCloudDeckRow(entry.deck, ctx.categories);
    const sel = entry.kind === "local"
      ? { localId: entry.deck.id, deckId: entry.deck.deckId || null }
      : { localId: null, deckId: String(entry.deck.id) };
    decorateDeckRow(tr, sel, entry.deck, depth);
    tbody.appendChild(tr);
  });
}

function renderFolderChildren(tbody, node, depth, ctx) {
  sortedFolderChildren(node).forEach((child) => {
    const isCollapsed = !ctx.expanded.has(child.path);
    tbody.appendChild(buildFolderRow(child, depth, isCollapsed));
    if (!isCollapsed) {
      renderFolderChildren(tbody, child, depth + 1, ctx);
      renderFolderDecks(tbody, child, depth + 1, ctx);
    }
  });
}

// The unified library view rendered as a nested folder tree: folders (from deck
// category paths plus any empty "known" folders) with their decks nested
// beneath, and Uncategorized decks loose at the root. `cloudById` (a Map, or
// null before/without a cloud fetch) drives the per-deck Sync column.
// ── Folder-view navigation helpers ─────────────────────────────────────────
function setMyDecksCwdAndRender(path) {
  setMyDecksCwd(path);
  repaintMyDecks();
}

// Walks the built tree to the node for `path` (root when ""), or null if the path
// no longer exists (e.g. the folder was just deleted out from under the cwd).
function findTreeNode(tree, path) {
  if (!path) return tree;
  let node = tree;
  for (const seg of folderSegments(path)) {
    node = node.children.get(seg);
    if (!node) return null;
  }
  return node;
}

function renderMyDecksBreadcrumb() {
  const nav = el.myDecksBreadcrumb;
  if (!nav) return;
  nav.innerHTML = "";
  const cwd = state.myDecksCwd;
  const mk = (label, path, isCurrent) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "breadcrumb-crumb";
    b.textContent = label;
    if (isCurrent) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => setMyDecksCwdAndRender(path));
    attachFolderDropTarget(b, path); // drop a deck/folder on a crumb to move it here
    return b;
  };
  nav.appendChild(mk("🏠 All", "", cwd === ""));
  let acc = "";
  const segs = folderSegments(cwd);
  segs.forEach((seg, i) => {
    acc = acc ? acc + FOLDER_SEP + seg : seg;
    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "›";
    nav.appendChild(sep);
    nav.appendChild(mk(seg, acc, i === segs.length - 1));
  });
}

// ── Folder + deck cluster builders (shared by tiles and folder-nav rows) ────
function buildFolderActionCluster(path) {
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-actions";
  const mk = (text, title, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "deck-folder-action";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
    return b;
  };
  wrap.append(
    mk("＋ Deck", "New deck in this folder", () => newDeckInFolder(path)),
    mk("＋ Folder", "New subfolder", () => createFolder(path)),
    mk("Rename", "Rename folder", () => renameFolder(path)),
    mk("Delete", "Delete folder", () => deleteFolder(path)),
  );
  return wrap;
}

// A folder as a grid tile (Folder view, Tiles display). Double-click / Enter drills
// in; it is a drop target and is itself draggable for re-parenting. No inline action
// buttons — folder management lives in the toolbar and Tree view.
function buildFolderTile(node) {
  const tile = document.createElement("div");
  tile.className = "folder-tile";
  tile.tabIndex = 0;
  tile.dataset.folderPath = node.path;
  tile.title = "Open folder";
  const total = folderTotalDeckCount(node);

  // Same absolutely-positioned wrapper the deck tiles use (.deck-tile-select),
  // for identical placement AND because it's what keeps the global
  // `input { width: 100% }` text-field rule from stretching the checkbox into a
  // full-width slab — a bare checkbox in the flex row below does exactly that.
  const selWrap = document.createElement("label");
  selWrap.className = "deck-tile-select";
  selWrap.title = "Select folder";
  selWrap.appendChild(createFolderSelectControl(node.path, node.name));
  // The whole tile is a click-to-open target; ticking its checkbox must not
  // also drill into the folder. Needed on the label as well as the checkbox —
  // a click landing on the label's padding never touches the input itself.
  selWrap.addEventListener("click", (e) => e.stopPropagation());

  const main = document.createElement("div");
  main.className = "folder-tile-main";
  main.innerHTML = `<span class="folder-tile-icon">📁</span><span class="folder-tile-name"></span>`;
  main.querySelector(".folder-tile-name").textContent = node.name;
  const count = document.createElement("span");
  count.className = "folder-tile-count";
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;
  // A sibling row below the name (not crammed into the same flex row as the
  // icon) — otherwise a long name has almost no width left to wrap into.
  tile.append(selWrap, main, count);

  const enter = () => setMyDecksCwdAndRender(node.path);
  tile.addEventListener("click", enter);
  tile.addEventListener("dblclick", enter);
  tile.addEventListener("keydown", (e) => { if (e.target !== tile) return; if (e.key === "Enter") { e.preventDefault(); enter(); } });
  attachFolderDropTarget(tile, node.path);
  tile.draggable = true;
  tile.addEventListener("dragstart", (e) => {
    if (e.target.closest("input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tile.addEventListener("dragend", () => { tile.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tile;
}

// A folder as a table row for Folder view (List display) — single level, click to
// enter (unlike the Tree view's expand-in-place row).
function buildFolderNavRow(node) {
  const tr = document.createElement("tr");
  tr.className = "deck-folder-row deck-folder-nav";
  tr.dataset.folderPath = node.path;
  const td = document.createElement("td");
  td.colSpan = 7;
  const wrap = document.createElement("div");
  wrap.className = "deck-folder-wrap";
  wrap.appendChild(createFolderSelectControl(node.path, node.name));
  const label = document.createElement("button");
  label.type = "button";
  label.className = "deck-folder-label";
  label.innerHTML = `<span class="deck-folder-icon">📁</span><span class="deck-folder-name"></span>`;
  label.querySelector(".deck-folder-name").textContent = node.name;
  label.addEventListener("click", () => setMyDecksCwdAndRender(node.path));
  const total = folderTotalDeckCount(node);
  const count = document.createElement("span");
  count.className = "deck-folder-count";
  count.textContent = total === 1 ? "1 deck" : `${total} decks`;
  wrap.append(label, count, buildFolderActionCluster(node.path));
  td.append(wrap);
  tr.append(td);
  attachFolderDropTarget(tr, node.path);
  tr.draggable = true;
  tr.addEventListener("dragstart", (e) => {
    if (e.target.closest("button, input")) { e.preventDefault(); return; }
    myDecksDrag = { type: "folder", path: node.path };
    tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", node.path); } catch (_) {}
  });
  tr.addEventListener("dragend", () => { tr.classList.remove("dragging"); myDecksDrag = null; clearFolderDropHighlights(); });
  return tr;
}

// Closes any open deck-tile overflow menus (one-at-a-time behaviour).
function closeAllDeckTileMenus(except) {
  el.myDecksGrid?.querySelectorAll(".deck-tile-overflow-menu:not([hidden])").forEach((menu) => {
    if (menu !== except) {
      menu.hidden = true;
      menu.style.position = "";
      menu.style.right = "";
      menu.style.left = "";
      menu.style.top = "";
      menu.previousElementSibling?.setAttribute("aria-expanded", "false");
    }
  });
}

// A deck as a grid tile. Reuses the shared select control, sync status, category,
// and Load/Export/Rename/Delete operations so tiles behave exactly like rows.
function buildDeckTile(entry, ctx) {
  const { deck, kind } = entry;
  const sel = deckSelOf(deck, kind);
  const { count, hasNotes } = deckCardInfo(deck, kind);
  const status = deckSyncStatus(deck, ctx.cloudById, kind === "cloud");

  const tile = document.createElement("div");
  tile.className = "deck-tile";
  tile.tabIndex = 0;
  if (kind === "local" && deck.id === state.localDeckId) tile.classList.add("is-current-local-deck");
  if (kind === "cloud") tile.classList.add("is-cloud-only-deck");

  const selWrap = document.createElement("label");
  selWrap.className = "deck-tile-select";
  selWrap.title = "Select";
  selWrap.appendChild(createDeckSelectControl({ ...sel, title: deck.title }));

  const title = document.createElement("div");
  title.className = "deck-tile-title";
  title.textContent = deck.title || "Untitled deck";
  title.title = deck.title || "";

  const chip = document.createElement("span");
  chip.className = "deck-tile-chip";
  chip.textContent = normalizeDeckCategory(deck.category);
  chip.title = normalizeDeckCategory(deck.category);

  const meta = document.createElement("div");
  meta.className = "deck-tile-meta";
  const countEl = document.createElement("span");
  countEl.className = "deck-tile-count";
  countEl.textContent = `${count ?? "—"} ${count === 1 ? "card" : "cards"}${hasNotes ? " · 📝" : ""}`;
  if (hasNotes) countEl.title = "This deck has study notes";
  const badge = document.createElement("span");
  badge.className = `deck-tile-sync ${status.cls}`;
  badge.textContent = status.label;
  badge.title = status.title;
  meta.append(countEl, badge);

  const actions = document.createElement("div");
  actions.className = "deck-tile-actions";
  actions.append(buildDeckLoadButton(deck, kind), createDeckExportControl(sel, deck.title));

  // Overflow (⋯): Rename / Move to folder / Delete
  const overflow = document.createElement("div");
  overflow.className = "deck-tile-overflow";
  const ovBtn = document.createElement("button");
  ovBtn.type = "button";
  ovBtn.className = "deck-tile-overflow-btn";
  ovBtn.setAttribute("aria-haspopup", "true");
  ovBtn.setAttribute("aria-expanded", "false");
  ovBtn.title = "More actions";
  ovBtn.textContent = "⋯";
  const menu = document.createElement("div");
  menu.className = "deck-tile-overflow-menu";
  menu.hidden = true;
  const mkItem = (text, handler) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => { menu.hidden = true; ovBtn.setAttribute("aria-expanded", "false"); handler(); });
    return b;
  };
  menu.append(
    mkItem("Rename", () => renameMyDeck(sel, deck.title || "")),
    mkItem("Move to folder…", () => moveDeckViaMenu(deck, kind)),
    mkItem("Delete", () => buildDeckDeleteButton(deck, kind).click()),
  );
  ovBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    closeAllDeckTileMenus(menu);
    menu.hidden = !willOpen;
    ovBtn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      // The grid this tile lives in scrolls, and the menu can otherwise be
      // clipped by that scroll container near the bottom of the list —
      // promote it to a viewport-fixed position computed from the button.
      const r = ovBtn.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.right = "auto"; // the default CSS anchors with `right: 0`, which
      // would otherwise stretch the box once `left` is also set explicitly below.
      menu.style.left = "0px";
      menu.style.top = "0px";
      const menuW = menu.offsetWidth;
      const menuH = menu.offsetHeight;
      menu.style.left = `${Math.min(r.right - menuW, window.innerWidth - menuW - 4)}px`;
      menu.style.top = (r.bottom + menuH + 4 > window.innerHeight)
        ? `${r.top - menuH - 4}px`
        : `${r.bottom + 4}px`;
    }
  });
  overflow.append(ovBtn, menu);
  actions.append(overflow);

  tile.append(selWrap, title, chip, meta, actions);

  // Enter / double-click loads the deck (checkbox handles selection).
  tile.addEventListener("dblclick", (e) => { if (e.target.closest("button, input, label, .deck-tile-overflow")) return; loadDeckEntry(deck, kind); });
  tile.addEventListener("keydown", (e) => { if (e.target !== tile) return; if (e.key === "Enter") { e.preventDefault(); loadDeckEntry(deck, kind); } });
  makeDeckDraggable(tile, sel, deck);
  return tile;
}

async function moveDeckViaMenu(deck, kind) {
  const sel = deckSelOf(deck, kind);
  const category = await chooseDeckCategory(normalizeDeckCategory(deck.category));
  if (category === null) return;
  try {
    await setMyDeckCategory(sel, category);
    showToast(`Moved to "${normalizeDeckCategory(category)}"`);
    renderMyDecksList();
  } catch (error) {
    console.error("Move via menu failed", error);
    showToast("Couldn't move — offline?", "error");
  }
}

// ── Empty states ────────────────────────────────────────────────────────────
function myDecksEmptyMessage(ctx) {
  if (ctx.search) return `No decks match “${ctx.search}”.`;
  if (ctx.totalDecks === 0) return ctx.loading ? "Checking the cloud for your decks…" : "No decks yet. Use ＋ New deck to create your first one.";
  return "Nothing filed here yet. Use ＋ New deck, or drag a deck onto a folder.";
}

function buildEmptyCard(message) {
  const div = document.createElement("div");
  div.className = "my-decks-empty-card";
  div.textContent = message;
  return div;
}

function appendEmptyRow(tbody, message) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td colspan="7" class="web-decks-empty"></td>`;
  tr.querySelector("td").textContent = message;
  tbody.appendChild(tr);
}

// ── The three views ─────────────────────────────────────────────────────────
function renderDeckRowInto(tbody, entry, ctx, { draggable = false } = {}) {
  const tr = entry.kind === "local"
    ? buildLocalDeckRow(entry.deck, ctx.cloudById, ctx.categories)
    : buildCloudDeckRow(entry.deck, ctx.categories);
  if (draggable) makeDeckDraggable(tr, deckSelOf(entry.deck, entry.kind), entry.deck);
  tbody.appendChild(tr);
}

// Tree — the full nested, collapsible hierarchy (always a list).
function renderMyDecksTreeView(entries, ctx) {
  const tbody = el.myDecksListTable;
  tbody.innerHTML = "";
  const knownFolders = ctx.search ? [] : readKnownFolders().filter((path) => !ctx.scope || isCategoryUnder(path, ctx.scope));
  const tree = buildFolderTree(entries, knownFolders);
  const rctx = { cloudById: ctx.cloudById, categories: ctx.categories, expanded: readExpandedFolders() };
  tbody.appendChild(buildRootDropRow());
  renderFolderChildren(tbody, tree, 0, rctx);
  renderFolderDecks(tbody, tree, 0, rctx); // loose (Uncategorized) decks at the root
  if (!tbody.querySelector(".my-deck-row, .deck-folder-row:not(.deck-root-row)")) {
    appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// Grid — every deck flat, no hierarchy.
function renderMyDecksGridView(entries, ctx) {
  if (state.myDecksDisplay === "tiles") {
    const grid = el.myDecksGrid;
    grid.innerHTML = "";
    entries.forEach((entry) => grid.appendChild(buildDeckTile(entry, ctx)));
    if (!entries.length) grid.appendChild(buildEmptyCard(myDecksEmptyMessage(ctx)));
  } else {
    const tbody = el.myDecksListTable;
    tbody.innerHTML = "";
    entries.forEach((entry) => renderDeckRowInto(tbody, entry, ctx));
    if (!entries.length) appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// Folder — Finder-style, one level of the tree at `state.myDecksCwd`.
function renderMyDecksFolderView(entries, ctx) {
  const knownFolders = ctx.search ? [] : readKnownFolders();
  const tree = buildFolderTree(entries, knownFolders);
  let node = findTreeNode(tree, state.myDecksCwd);
  if (!node) { setMyDecksCwd(""); node = tree; renderMyDecksBreadcrumb(); }
  const childFolders = sortedFolderChildren(node);
  const decks = node.decks;

  if (state.myDecksDisplay === "tiles") {
    const grid = el.myDecksGrid;
    grid.innerHTML = "";
    childFolders.forEach((child) => grid.appendChild(buildFolderTile(child)));
    decks.forEach((entry) => grid.appendChild(buildDeckTile(entry, ctx)));
    if (!childFolders.length && !decks.length) grid.appendChild(buildEmptyCard(myDecksEmptyMessage(ctx)));
  } else {
    const tbody = el.myDecksListTable;
    tbody.innerHTML = "";
    // No root drop row here — the breadcrumb's "🏠 All" crumb is the drop-to-root
    // target, so a second "All decks" row would just be a confusing duplicate.
    childFolders.forEach((child) => tbody.appendChild(buildFolderNavRow(child)));
    decks.forEach((entry) => renderDeckRowInto(tbody, entry, ctx, { draggable: true }));
    if (!childFolders.length && !decks.length) appendEmptyRow(tbody, myDecksEmptyMessage(ctx));
  }
}

// ── Chrome (view switch / display toggle / breadcrumb / host) ───────────────
function setMyDecksHost(useTiles) {
  if (el.myDecksTableWrap) el.myDecksTableWrap.hidden = useTiles;
  if (el.myDecksGrid) el.myDecksGrid.hidden = !useTiles;
  // Clear the inactive host so stale nodes — and crucially their selection
  // checkboxes, which the bulk bar counts across the whole body — don't linger.
  // Runs before the active renderer repopulates its own host.
  if (useTiles) { if (el.myDecksListTable) el.myDecksListTable.innerHTML = ""; }
  else if (el.myDecksGrid) el.myDecksGrid.innerHTML = "";
}

function syncMyDecksChrome() {
  const view = state.myDecksView;
  const display = view === "tree" ? "list" : state.myDecksDisplay;
  el.myDecksViewSwitch?.querySelectorAll("[data-mydecks-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mydecksView === view)));
  el.myDecksDisplayToggle?.querySelectorAll("[data-mydecks-display]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mydecksDisplay === display)));
  if (el.myDecksSort && el.myDecksSort.value !== state.myDecksSort) el.myDecksSort.value = state.myDecksSort;
  if (el.myDecksDisplayToggle) el.myDecksDisplayToggle.hidden = (view === "tree");
  if (el.myDecksTreeToggleAll) {
    el.myDecksTreeToggleAll.hidden = (view !== "tree");
    if (view === "tree") {
      const allOpen = allFoldersExpanded();
      el.myDecksTreeToggleAll.textContent = allOpen ? "⊟ Collapse all" : "⊞ Expand all";
      el.myDecksTreeToggleAll.dataset.expandAll = allOpen ? "0" : "1";
    }
  }
  if (el.myDecksBreadcrumb) {
    el.myDecksBreadcrumb.hidden = (view !== "folder");
    if (view === "folder") renderMyDecksBreadcrumb();
  }
  // Folder view's breadcrumb IS the "which folder am I in" control — the
  // scope dropdown is a second, unsynced way to answer the same question
  // (and can silently narrow the view further than the breadcrumb shows).
  // Only Grid/Tree need it, since they have no drill-down of their own.
  if (el.myDecksFilterWrap) el.myDecksFilterWrap.hidden = (view === "folder");
  setMyDecksHost(display === "tiles");
}

// Last painted data set, so pure presentation changes (switching view/display,
// searching, drilling into a folder, expand/collapse) can repaint instantly from
// memory instead of re-hitting the cloud.
let myDecksCache = null;

// Repaints the current view from the cached data set — no network. Falls back to a
// full (re)load if nothing has been painted yet.
function repaintMyDecks() {
  if (!myDecksCache) { renderMyDecksList(); return; }
  const c = myDecksCache;
  paintMyDecks(c.localDecks, c.cloudById, { cloudOnly: c.cloudOnly, categories: c.categories, scope: c.scope, loading: false });
}

// Renders whichever view is active from an already-scoped deck set, applying the
// title search first. `loading` marks a first paint still awaiting the cloud.
function paintMyDecks(localDecks, cloudById, { cloudOnly = [], categories = webDeckCategories, scope = "", loading = false } = {}) {
  myDecksCache = { localDecks, cloudById, cloudOnly, categories, scope };
  myDecksRendered = { local: localDecks, cloudOnly };
  const search = myDecksSearchTerm();
  // Sorted per state.myDecksSort (default: most-recently-accessed first),
  // local and cloud-only decks interleaved on the same timeline.
  const entries = [
    ...localDecks.filter(myDeckMatchesSearch).map((deck) => ({ deck, kind: "local" })),
    ...cloudOnly.filter(myDeckMatchesSearch).map((deck) => ({ deck, kind: "cloud" })),
  ].sort(myDecksSortComparator(state.myDecksSort));
  const ctx = { cloudById, categories, scope, search, loading, totalDecks: localDecks.length + cloudOnly.length };
  syncMyDecksChrome();
  if (state.myDecksView === "grid") renderMyDecksGridView(entries, ctx);
  else if (state.myDecksView === "folder") renderMyDecksFolderView(entries, ctx);
  else renderMyDecksTreeView(entries, ctx);
  updateMyDecksBulkBar();
}

// Guards against a stale cloud fetch overwriting a newer render.
let myDecksRenderSeq = 0;

async function renderMyDecksList() {
  if (!el.myDecksBody) return;
  const seq = ++myDecksRenderSeq;

  const localDecks = listLocalDecks();
  const localCloudIds = new Set(localDecks.map((d) => String(d.deckId)).filter((id) => id && id !== "null"));
  const canCloud = Boolean(supabaseClient && isSignedIn);

  // Category lists (for the filter and the inline per-row category editor) include
  // empty "known" folders so they can be selected before a deck lands.
  let categories = categoriesFromDecks(localDecks, [...webDeckCategories, ...readKnownFolders()]);
  // Repopulate the dropdown regardless of view so it's ready the moment the
  // user switches to Grid/Tree, but only let its value narrow the result set
  // there — Folder view scopes itself via the breadcrumb + cwd instead, and
  // applying both would silently narrow it further than the breadcrumb shows.
  const filterValue = populateMyDecksCategoryFilter(categories);
  let selectedCategory = state.myDecksView === "folder" ? "" : filterValue;
  const inScope = (deck) => !selectedCategory || isCategoryUnder(deck.category, selectedCategory);

  // Paint on-device decks immediately (tentative Sync column) so the library never
  // waits on the network; the cloud fetch below repaints with real sync state.
  paintMyDecks(localDecks.filter(inScope), null, { categories, scope: selectedCategory, loading: canCloud && navigator.onLine });

  if (!(canCloud && navigator.onLine)) return;

  try {
    const cloudDecks = await fetchCloudDeckList();
    if (seq !== myDecksRenderSeq) return; // a newer render superseded this one
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudOnly = cloudDecks.filter((deck) => !localCloudIds.has(String(deck.id)) && !isDeckTombstoned(deck.id));
    categories = categoriesFromDecks([...localDecks, ...cloudOnly], [...webDeckCategories, ...readKnownFolders()]);
    setKnownWebDeckCategories(categoriesFromDecks([...localDecks, ...cloudOnly], webDeckCategories));
    const filterValue2 = populateMyDecksCategoryFilter(categories);
    selectedCategory = state.myDecksView === "folder" ? "" : filterValue2;
    const inScope2 = (deck) => !selectedCategory || isCategoryUnder(deck.category, selectedCategory);
    paintMyDecks(localDecks.filter(inScope2), cloudById, { cloudOnly: cloudOnly.filter(inScope2), categories, scope: selectedCategory, loading: false });
  } catch (error) {
    if (seq !== myDecksRenderSeq) return;
    console.warn("Could not fetch cloud decks for My Decks", error);
    // The on-device paint already stands; nothing more to show.
  }
}

function normalizeMarkdown(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

function stripReaderMetadata(markdown) {
  const source = normalizeMarkdown(markdown).trim();
  const marker = "\nMarkdown Content:\n";
  const markerIndex = source.indexOf(marker);
  return markerIndex === -1 ? source : source.slice(markerIndex + marker.length).trim();
}

// Deck study notes travel inside markdown exports between HTML-comment
// sentinels so the card parsers never mistake freeform notes (which may
// legitimately contain `::` lines, `---` rules, or headings) for cards.
const NOTES_BLOCK_RE = /\n?<!--\s*recall:notes\s*-->\n?([\s\S]*?)\n?<!--\s*\/recall:notes\s*-->\n?/g;

function extractNotesFromMarkdown(markdown) {
  const found = [];
  const rest = normalizeMarkdown(String(markdown || "")).replace(NOTES_BLOCK_RE, (match, body) => {
    const cleaned = body.replace(/^\s*##\s+Notes\s*\n/, "").trim();
    if (cleaned) found.push(cleaned);
    return "\n";
  });
  return { markdown: rest, notes: found.join("\n\n---\n\n") };
}

function notesExportBlock(notes) {
  const body = String(notes || "")
    // A literal end sentinel inside the notes would truncate the block on import.
    .replace(/<!--\s*\/recall:notes\s*-->/g, "<!- - /recall:notes - ->")
    .trim();
  if (!body) return "";
  return `<!-- recall:notes -->\n## Notes\n\n${body}\n<!-- /recall:notes -->`;
}

function removeEmptyHeadingGroups(markdown) {
  return normalizeMarkdown(markdown)
    .split("\n")
    .filter((line) => !/^#{1,6}\s*[^\S\r\n]*$/.test(line))
    .join("\n");
}

function humanizeSourceTitle(value) {
  const cleaned = normalizeMarkdown(String(value || ""))
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop() || "";
  const withoutExtension = cleaned.replace(/\.(md|markdown|mdown|mkdn|txt|zip)$/i, "");
  const withoutNotionId = withoutExtension
    .replace(/[-_\s]+[a-f0-9]{32}$/i, "")
    .replace(/[-_\s]+[a-f0-9]{8,}$/i, "");
  return withoutNotionId
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFileTitle(value) {
  const cleaned = normalizeMarkdown(String(value || ""))
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop() || "";
  const decoded = (() => {
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  })();
  return decoded
    .replace(/\.(md|markdown|mdown|mkdn|txt|json|zip)$/i, "")
    .replace(/[-_\s]+[a-f0-9]{32}$/i, "")
    .replace(/[-_\s]+[a-f0-9]{8,}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromImportHint(titleHint = "") {
  return sourceFileTitle(titleHint) || humanizeSourceTitle(titleHint);
}

function inferDeckTitle(markdown, fallback = "") {
  const source = stripReaderMetadata(markdown);
  const lines = normalizeMarkdown(source).split("\n");
  const h1 = lines.find((line) => /^#\s+.+/.test(line.trim()));
  if (h1) return h1.replace(/^#\s+/, "").replace(/\s+#*$/, "").trim();

  const nonQuestionHeading = lines.find((line) => {
    const match = line.trim().match(/^#{2,6}\s+(.+?)\s*#*$/);
    return match && !match[1].trim().endsWith("?");
  });
  if (nonQuestionHeading) {
    return nonQuestionHeading.replace(/^#{2,6}\s+/, "").replace(/\s+#*$/, "").trim();
  }

  return humanizeSourceTitle(fallback) || "Pasted Deck";
}

function stripQuoteMarker(line) {
  return line.replace(/^\s{0,3}>\s?/, "");
}

function cleanToggleContent(lines) {
  return lines
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDelimitedCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let inCard = false;
  let side = "front";
  let front = [];
  let back = [];
  let inFence = false;

  const reset = () => {
    inCard = false;
    side = "front";
    front = [];
    back = [];
    inFence = false;
  };

  const flush = () => {
    const question = cleanToggleContent(front);
    const answer = cleanToggleContent(back);
    if (question && answer) cards.push({ question, answer });
    reset();
  };

  const pushContent = (line) => {
    if (!inCard) return;
    if (side === "front") {
      front.push(line);
    } else {
      back.push(line);
    }
    if (/^\s*```/.test(line.trim())) inFence = !inFence;
  };

  const toggleCardBoundary = () => {
    if (inCard) {
      flush();
    } else {
      reset();
      inCard = true;
    }
  };

  for (const line of lines) {
    let rest = line;

    if (!inFence && rest.trim() === "::") {
      toggleCardBoundary();
      continue;
    }

    if (!inFence && /^\s*::/.test(rest)) {
      toggleCardBoundary();
      rest = rest.replace(/^\s*::/, "");
      if (!rest.trim()) continue;
    }

    if (!inCard) continue;

    // A literal "---" the user typed inside a card (e.g. a Markdown horizontal
    // rule) is escaped as "\---" on export (see formatCardList) so it round-trips
    // instead of being mistaken for the front/back separator below. Unescape it
    // back to plain content and skip the separator checks for this line.
    if (!inFence && /^\s*\\---(?!-)/.test(rest)) {
      pushContent(rest.replace(/^(\s*)\\---/, "$1---"));
      continue;
    }

    if (!inFence && side === "front" && rest.trim() === "---") {
      side = "back";
      continue;
    }

    if (!inFence && side === "front" && cardSideSeparatorPattern.test(rest)) {
      side = "back";
      rest = rest.replace(cardSideSeparatorPattern, "");
      if (!rest.trim()) continue;
    }

    if (!inFence && rest.trim().endsWith("::")) {
      const content = rest.replace(/::\s*$/, "");
      if (content.trim()) pushContent(content);
      flush();
      continue;
    }

    pushContent(rest);
  }

  return cards;
}

function parseBlockquoteCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let block = [];
  let inFence = false;

  const flush = () => {
    const body = cleanToggleContent(block);
    block = [];
    if (!body) return;

    const parts = body.split("\n");
    const firstContentIndex = parts.findIndex((line) => line.trim());
    if (firstContentIndex === -1) return;

    const question = parts[firstContentIndex].trim();
    const answer = cleanToggleContent(parts.slice(firstContentIndex + 1));
    if (question && answer) {
      cards.push({ question, answer });
    }
  };

  for (const line of lines) {
    const isQuote = /^\s{0,3}>/.test(line);

    if (isQuote) {
      const stripped = stripQuoteMarker(line);
      if (/^\s*```/.test(stripped)) inFence = !inFence;
      block.push(stripped);
      continue;
    }

    if (line.trim() === "" && block.length && inFence) {
      block.push("");
      continue;
    }

    flush();
    inFence = false;
  }

  flush();
  return cards;
}

function parseDetailsCards(markdown) {
  const cards = [];
  const detailsPattern = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let match;

  while ((match = detailsPattern.exec(markdown))) {
    const question = match[1].replace(/<[^>]*>/g, "").trim();
    const answer = match[2].trim();
    if (question && answer) cards.push({ question, answer });
  }

  return cards;
}

function parseQACards(markdown) {
  const cards = [];
  const chunks = normalizeMarkdown(markdown).split(/\n{2,}(?=(?:Q|Question)\s*:)/i);

  for (const chunk of chunks) {
    const match = chunk.match(/^(?:Q|Question)\s*:\s*([\s\S]*?)\n(?:A|Answer)\s*:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim() && match?.[2]?.trim()) {
      cards.push({
        question: match[1].trim(),
        answer: match[2].trim()
      });
    }
  }

  return cards;
}

function hasStructuredSectionLabels(lines) {
  const studyLabelPattern = /^\*\*\s*(?:original(?:\s+sanskrit)?|(?:english\s+)?transliteration|(?:complete\s+)?translation|word(?:-by-word|\s+meanings?)?(?:\s+breakdown)?|(?:philosophical\s+)?meaning|memorization\s+tip|explanation|example|summary|notes)\s*:\*\*\s*$/i;
  const labels = lines.filter((line) => studyLabelPattern.test(line.trim()));
  return labels.length >= 2;
}

function hasMeaningfulContent(lines) {
  return lines.some((line) => {
    const trimmed = line.trim();
    return trimmed
      && !/^-{3,}$/.test(trimmed)
      && !/^<alphaxiv-thinking-title\b/i.test(trimmed);
  });
}

function isStudySectionTitle(title) {
  return /^(?:what|how|why|when|where|which|who|can|does|do|is|are|explain|describe|summari[sz]e|summary|compare|contrast)\b/i.test(title);
}

function parseHeadingCards(markdown, options = {}) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let current = null;
  const includeStudySections = options.includeStudySections === true;

  const flush = () => {
    if (!current) return;
    const answer = cleanToggleContent(current.answer);
    const shouldKeep = current.isQuestion
      || (
        includeStudySections
        && !current.hasNestedHeading
        && hasMeaningfulContent(current.answer)
        && (isStudySectionTitle(current.question) || hasStructuredSectionLabels(current.answer))
      );

    if (current.question && answer && shouldKeep) {
      cards.push({
        question: current.question,
        answer
      });
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      const level = heading[1].length;
      const question = heading[2].trim();
      const isQuestionHeading = question.endsWith("?");

      if (isQuestionHeading || includeStudySections) {
        if (current && level > current.level) {
          if (current.isQuestion) {
            current.answer.push(line);
            continue;
          }

          current.hasNestedHeading = true;
          flush();
          current = null;
        }

        flush();
        current = {
          question,
          level,
          isQuestion: isQuestionHeading,
          hasNestedHeading: false,
          answer: []
        };
        continue;
      }

      if (current && level <= current.level) {
        flush();
        current = null;
      }
    }

    if (current) current.answer.push(line);
  }

  flush();
  return cards;
}

function parseLegacyHeadingFallbackCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let current = null;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const answer = cleanToggleContent(current.answer);
    if (current.question && answer) {
      cards.push({
        question: current.question,
        answer
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line.trim())) inFence = !inFence;

    const heading = inFence ? null : line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      current = {
        question: heading[2].trim(),
        answer: []
      };
      continue;
    }

    if (current) current.answer.push(line);
  }

  flush();
  return cards;
}

function countQuestionHeadings(markdown) {
  return normalizeMarkdown(markdown)
    .split("\n")
    .filter((line) => /^#{2,6}\s+.+\?\s*$/.test(line.trim()))
    .length;
}

function parseCards(markdown) {
  // Deck notes blocks are never card material — strip them defensively so
  // notes content can't leak into any of the parsers below.
  const withoutNotes = extractNotesFromMarkdown(markdown).markdown;
  const source = removeEmptyHeadingGroups(stripReaderMetadata(withoutNotes));
  const delimitedCards = parseDelimitedCards(source);
  const hasDelimitedCardSyntax = delimitedCardBoundaryPattern.test(source);
  const structuredLegacyCards = [
    ...parseDetailsCards(source),
    ...parseBlockquoteCards(source),
    ...parseQACards(source)
  ];
  const legacyHeadingCards = parseLegacyHeadingFallbackCards(source);
  const parsedCards = delimitedCards.length
    ? delimitedCards
    : hasDelimitedCardSyntax
      ? []
    : structuredLegacyCards.length
      ? [
        ...structuredLegacyCards,
        ...parseHeadingCards(source, { includeStudySections: true })
      ]
      : legacyHeadingCards.length
        ? legacyHeadingCards
        : parseHeadingCards(source, { includeStudySections: true });
  const seen = new Set();
  const cards = parsedCards.filter((card) => {
    const key = `${card.question.trim()}\u0000${card.answer.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ids include a random suffix because card ids are the GLOBAL primary key in
  // the cloud `cards` table (not scoped per deck): a purely index+question id
  // collides whenever two decks are imported from similar (or the same)
  // markdown, and the sync upsert would then silently reassign the existing
  // row's deck_id — stealing the card from the other deck.
  return cards.map((card, index) => ({
    id: `${index}-${card.question.slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`,
    question: card.question,
    answer: card.answer
  }));
}

function syncResults() {
  state.results = {
    known: state.masterCards.filter((card) => state.statusById[card.id] === "known"),
    review: state.masterCards.filter((card) => state.statusById[card.id] === "review")
  };
  state.known = state.results.known.length;
  state.review = state.results.review.length;
}

function uncategorizedCards() {
  return state.masterCards.filter((card) => !state.statusById[card.id]);
}

function resetResults() {
  state.statusById = {};
  state.previewCard = null;
  state.results = {
    known: [],
    review: []
  };
  state.known = 0;
  state.review = 0;
}

function resetStudyDeck(cards = state.masterCards) {
  state.transitionToken += 1;
  state.cards = cards.slice();
  state.current = 0;
  state.previewCard = null;
  state.flipped = false;
  resetResults();
  resetCardUndoHistory();
}


function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function encodeAttribute(value) {
  return escapeHtml(encodeURIComponent(value));
}

function isEscaped(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isSingleDollarLine(source, index) {
  if (source[index] !== "$" || source[index - 1] === "$" || source[index + 1] === "$" || isEscaped(source, index)) {
    return false;
  }

  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = source.indexOf("\n", index);
  const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
  return line.trim() === "$";
}

function findSingleDollarLine(source, start) {
  for (let index = source.indexOf("$", start); index !== -1; index = source.indexOf("$", index + 1)) {
    if (isSingleDollarLine(source, index)) return index;
  }
  return -1;
}

function findUnescaped(source, token, start) {
  for (let index = source.indexOf(token, start); index !== -1; index = source.indexOf(token, index + token.length)) {
    if (!isEscaped(source, index)) return index;
  }
  return -1;
}

function canOpenInlineDollar(source, index) {
  const next = source[index + 1];
  return next && next !== "$" && !/\s/.test(next) && !isEscaped(source, index);
}

function findInlineDollarClose(source, start) {
  for (let index = source.indexOf("$", start); index !== -1; index = source.indexOf("$", index + 1)) {
    const previous = source[index - 1];
    if (source[index + 1] !== "$" && previous && !/\s/.test(previous) && !isEscaped(source, index)) {
      return index;
    }
  }
  return -1;
}

function mathNode(tex, displayMode) {
  const tag = displayMode ? "div" : "span";
  const className = displayMode ? "math-display" : "math-inline";
  return `<${tag} class="${className}" data-tex="${encodeAttribute(tex.trim())}"></${tag}>`;
}

function normalizeDisplayMathIndentation(markdown) {
  return markdown
    .replace(/(^|\n)[ \t]{4,}\$\$[ \t]*\n([\s\S]*?)\n[ \t]{4,}\$\$[ \t]*(?=\n|$)/g, (match, prefix, tex) => {
      const normalizedTex = tex
        .split("\n")
        .map((line) => line.replace(/^[ \t]{4}/, ""))
        .join("\n");
      return `${prefix}$$\n${normalizedTex}\n$$`;
    })
    .replace(/(^|\n)[ \t]{4,}\$\$([^\n]+?)\$\$[ \t]*(?=\n|$)/g, "$1$$$$$2$$$$");
}

function protectMath(markdown) {
  let output = "";
  let index = 0;
  const source = normalizeDisplayMathIndentation(markdown);

  while (index < source.length) {
    if (source.startsWith("$$", index) && !isEscaped(source, index)) {
      const close = findUnescaped(source, "$$", index + 2);
      if (close !== -1) {
        // Surround display math with blank lines so marked exits HTML-block mode
        // and correctly parses any markdown (headings, paragraphs) that follows.
        const node = mathNode(source.slice(index + 2, close), true);
        const needsLeading = output.length > 0 && !output.endsWith("\n\n");
        output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        index = close + 2;
        // Skip any trailing newlines that were already part of $$...$$
        while (index < source.length && source[index] === "\n") index++;
        continue;
      }
    }

    if (isSingleDollarLine(source, index)) {
      const openLineEnd = source.indexOf("\n", index);
      const contentStart = openLineEnd === -1 ? index + 1 : openLineEnd + 1;
      const close = findSingleDollarLine(source, contentStart);
      if (close !== -1) {
        const closeLineStart = source.lastIndexOf("\n", close - 1) + 1;
        const node = mathNode(source.slice(contentStart, closeLineStart), true);
        const needsLeading = output.length > 0 && !output.endsWith("\n\n");
        output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        const closeLineEnd = source.indexOf("\n", close);
        index = closeLineEnd === -1 ? close + 1 : closeLineEnd + 1;
        while (index < source.length && source[index] === "\n") index++;
        continue;
      }
    }

    // A literal "[" immediately before "\[" (or "\(") is Markdown's escaped-bracket
    // syntax for bracket characters inside link text — e.g. Turndown emits
    // "[\[1\]](url)" for a link whose visible text is "[1]" (citation markers).
    // That's never a real LaTeX delimiter someone typed, so don't swallow it as math.
    const precededByLinkBracket = index > 0 && source[index - 1] === "[" && !isEscaped(source, index - 1);
    if (!precededByLinkBracket && (source.startsWith("\\[", index) || source.startsWith("\\(", index)) && !isEscaped(source, index)) {
      const displayMode = source[index + 1] === "[";
      const closeToken = displayMode ? "\\]" : "\\)";
      const close = findUnescaped(source, closeToken, index + 2);
      if (close !== -1) {
        const node = mathNode(source.slice(index + 2, close), displayMode);
        if (displayMode) {
          const needsLeading = output.length > 0 && !output.endsWith("\n\n");
          output += (needsLeading ? "\n\n" : "") + node + "\n\n";
        } else {
          output += node;
        }
        index = close + 2;
        continue;
      }
    }

    if (source[index] === "$" && canOpenInlineDollar(source, index)) {
      const close = findInlineDollarClose(source, index + 1);
      if (close !== -1) {
        output += mathNode(source.slice(index + 1, close), false);
        index = close + 1;
        continue;
      }
    }

    output += source[index];
    index += 1;
  }

  return output;
}

// Convert {{cloze}} spans into hidden fill-in-the-blank markup. Rendered as a
// redaction bar that reveals its text when tapped (see the .cloze click handler).
// Runs before protectMath so any math inside a cloze ($x$) still gets processed.
function applyClozeMarkup(text) {
  return String(text).replace(
    /\{\{([\s\S]+?)\}\}/g,
    (_match, inner) =>
      `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${inner}</span>`
  );
}

// Apply the inline transforms (cloze, then math) that run on non-fenced text.
// Inline code spans (`code`, or ``code`` etc. so a literal backtick can appear
// inside — CommonMark closes on a run of exactly the same length as the
// opener) must be skipped, the same way preprocessSpecialBlocks already skips
// ``` fences — otherwise typing `{{x}}` or `$x$` as literal documentation
// (e.g. showing Mustache/Jinja2 syntax, or LaTeX syntax itself) turns it into
// a live cloze/math widget instead of staying inline code. Triple-backtick
// FENCES never reach here at all (already sliced out by preprocessSpecialBlocks).
//
// Cloze and code-span detection can't just run as two independent passes
// (cloze-then-code or code-then-cloze) — whichever delimiter the text writer
// meant to open FIRST has to win: "{{`SELECT`}}" clozes a code term (cloze
// opens first, its content includes an ordinary code span, which still
// becomes <code> once marked.parse() sees it — cloze's own regex is left
// alone, it doesn't need to know about code), while "`{{x}}`" documents
// literal cloze syntax as code (backtick opens first, content stays fully
// literal). This scans left-to-right and lets whichever token starts earlier
// consume its full span before continuing.
function protectInline(segment) {
  let output = "";
  let i = 0;
  const len = segment.length;

  while (i < len) {
    const clozeStart = segment.indexOf("{{", i);
    const backtickMatch = /`+/.exec(segment.slice(i));
    const codeStart = backtickMatch ? i + backtickMatch.index : -1;

    if (codeStart !== -1 && (clozeStart === -1 || codeStart < clozeStart)) {
      const tickRun = backtickMatch[0];
      const afterOpen = codeStart + tickRun.length;
      const closeRe = new RegExp("`{" + tickRun.length + "}(?!`)");
      const closeMatch = closeRe.exec(segment.slice(afterOpen));
      if (closeMatch) {
        const codeEnd = afterOpen + closeMatch.index + closeMatch[0].length;
        output += protectMath(applyClozeMarkup(segment.slice(i, codeStart)));
        output += segment.slice(codeStart, codeEnd); // raw code span, untouched
        i = codeEnd;
        continue;
      }
      // Backtick run with no matching close — not a real code span. Fall
      // through to check for a cloze at/after this position instead.
    }

    if (clozeStart !== -1) {
      const closeIdx = segment.indexOf("}}", clozeStart + 2);
      if (closeIdx !== -1) {
        output += protectMath(applyClozeMarkup(segment.slice(i, clozeStart)));
        const inner = segment.slice(clozeStart + 2, closeIdx);
        output += `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${protectMath(inner)}</span>`;
        i = closeIdx + 2;
        continue;
      }
    }

    // Neither a valid code span nor a valid cloze from here on — process
    // whatever's left as plain text (any stray "`"/"{{" survive literally,
    // same as CommonMark treats an unmatched backtick) and stop.
    output += protectMath(applyClozeMarkup(segment.slice(i)));
    break;
  }

  return output;
}

// Raw-markdown convenience for side-by-side images: a line that is two or more
// images separated by "|" renders as one row, e.g.
//   ![](a.png) | ![](b.png) | ![](c.png)
// Each image may be markdown `![alt](url)` or a raw `<img>` tag. The whole line
// must be images + "|" separators (anything else, or a single image, is left
// alone), which also keeps GFM table rows — those start with a leading "|" —
// untouched. The line becomes a `<div class="notes-img-row">` block, the same
// wrapper the resize grips understand, so each image stays individually
// resizable.
const IMG_TOKEN_SOURCE = "!\\[[^\\]]*\\]\\([^)]*\\)|<img\\b[^>]*>";
function renderImageRows(segment) {
  const lineRe = new RegExp(
    `^[^\\S\\n]*(?:${IMG_TOKEN_SOURCE})(?:[^\\S\\n]*\\|[^\\S\\n]*(?:${IMG_TOKEN_SOURCE}))+[^\\S\\n]*$`,
    "gm"
  );
  const imgRe = new RegExp(IMG_TOKEN_SOURCE, "gi");
  return segment.replace(lineRe, (line) => {
    const imgs = (line.match(imgRe) || []).map(imageMarkupToTag).filter(Boolean);
    if (imgs.length < 2) return line;
    return `<div class="notes-img-row">${imgs.join("")}</div>`;
  });
}

// Normalizes a single image token (markdown or raw <img>) to an <img> tag.
function imageMarkupToTag(token) {
  const md = token.trim().match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
  if (md) return `<img src="${escapeHtml(md[2].trim())}" alt="${escapeHtml(md[1])}">`;
  if (/^<img\b[^>]*>$/i.test(token.trim())) return token.trim();
  return "";
}

// Citation / footnote markers render as noise in notes that were clipped or
// pasted from the web. Turndown escapes every "[" → "\[" and turns same-page
// reference anchors into links, so a footnote marker arrives as `[\[1\]](#fn1)`
// (backslash litter + a dead #fn1 link); plain reference brackets arrive as
// `\[1\]`, and footnote lists trail a back-reference arrow (↩). The clipper now
// fixes this at capture time, but notes captured earlier — or pasted from
// elsewhere — still carry it, so the renderer normalises the same shapes to a
// clean inline `[1]`. Deliberately narrow (numeric citation shapes, footnote
// hrefs only) so real escaped brackets, exponents, and ordinary links survive.
const CITE_INNER = "\\d+[a-z]?(?:\\s*[-\\u2013\\u2014,;]\\s*\\d+[a-z]?)*";
const CITE_HREF_FRAG = "#(?:fn|fnref|cite|ref|reference|footnote|note|endnote|_?ftn)";
const CITATION_LINK_RE = new RegExp(
  "\\[\\s*\\\\?\\[?\\s*(" + CITE_INNER + ")\\s*\\\\?\\]?\\s*\\]\\(" + CITE_HREF_FRAG + "[^)]*\\)",
  "gi"
);
const CITATION_ESCAPED_RE = new RegExp("\\\\\\[(\\s*" + CITE_INNER + "\\s*)\\\\\\]", "gi");
const FOOTNOTE_BACKREF_LINK_RE = /\[[↩↵⮐︎\s]*\]\(#[^)]*\)/g;
const FOOTNOTE_BACKREF_ARROW_RE = /[↩↵⮐]︎?/g;

function normalizeCitations(text) {
  return String(text)
    // `[\[1\]](#fn1)` / `[1](#fn12)` → `[1]`, dropping the dead footnote anchor.
    .replace(CITATION_LINK_RE, "[$1]")
    // Bare escaped reference brackets: `\[1\]`, `\[1, 2\]`, `\[3-5\]` → `[1]` …
    .replace(CITATION_ESCAPED_RE, "[$1]")
    // Back-reference affordances left over from footnote lists.
    .replace(FOOTNOTE_BACKREF_LINK_RE, "")
    .replace(FOOTNOTE_BACKREF_ARROW_RE, "");
}

function preprocessSpecialBlocks(markdown) {
  const source = normalizeMarkdown(markdown || "");
  const fencePattern = /```[ \t]*([^\n]*)\n([\s\S]*?)```/g;
  let output = "";
  let lastIndex = 0;
  let match;

  while ((match = fencePattern.exec(source))) {
    output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex, match.index))));
    if (/\bmermaid\b/i.test(match[1])) {
      output += `<div class="mermaid" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else if (/\bnomnoml\b/i.test(match[1])) {
      output += `<div class="nomnoml-diagram" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else {
      output += match[0];
    }
    lastIndex = fencePattern.lastIndex;
  }

  output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex))));
  return output;
}

// Rewrite Google Drive "share/viewer" links to a directly-embeddable image URL.
// A link like https://drive.google.com/file/d/FILE_ID/view is a viewer page, not an
// image, so it renders as a broken <img>. The /thumbnail?id=…&sz=w1000 route serves the
// actual image bytes for public files (the old uc?export=view route now hits a virus-scan
// interstitial). Returns the original url when it isn't a recognizable Drive link.
function normalizeImageUrl(url) {
  if (!url) return url;
  const m = String(url).match(
    /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^&]*&)*id=|thumbnail\?(?:[^&]*&)*id=)([\w-]{20,})/
  );
  if (!m) return url;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
}

function markdownToSafeHtml(markdown) {
  const prepared = preprocessSpecialBlocks(markdown || "");
  const html = marked.parse(prepared);
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["foreignObject", "font", "u", "del", "kbd"],
    ADD_ATTR: ["target", "rel", "class", "data-tex", "data-diagram", "style", "color", "face", "tabindex", "role", "aria-label"]
  });
}

function nomnomlThemeDefaults(print = false) {
  return {
    background: cssVariableColor(print ? "--print-surface" : "--card", "#ffffff"),
    fill: [
      cssVariableColor(print ? "--print-surface" : "--card", "#ffffff"),
      cssVariableColor(print ? "--print-panel" : "--panel", "#fffdf8"),
      cssVariableColor(print ? "--print-panel-2" : "--panel-2", "#f3f6fb"),
      cssVariableColor(print ? "--print-question" : "--card-answer", "#eaf7f3")
    ].join("; "),
    stroke: cssVariableColor(print ? "--print-text" : "--text", "#263238"),
    font: "Arial",
    fontSize: "12",
    lineWidth: "1.4"
  };
}

function sourceWithNomnomlTheme(source, print = false) {
  const diagramSource = String(source || "").trim();
  const configured = new Set();

  diagramSource.split("\n").forEach((line) => {
    const match = line.trim().match(/^#([A-Za-z][A-Za-z0-9_]*)\s*:/);
    if (match) configured.add(match[1].toLowerCase());
  });

  const injected = Object.entries(nomnomlThemeDefaults(print))
    .filter(([key]) => !configured.has(key.toLowerCase()))
    .map(([key, value]) => `#${key}: ${value}`);

  return injected.length ? `${injected.join("\n")}\n${diagramSource}` : diagramSource;
}

function declaredCodeLanguage(code) {
  const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
  return languageClass ? languageClass.replace(/^language-/, "").trim() : "";
}

function normalizeCodeLanguage(language) {
  const normalized = String(language || "").toLowerCase();
  return codeLanguageAliases[normalized] || normalized;
}

function codeLanguageLabel(language) {
  return language
    .replace(/^language-/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toUpperCase();
}

function enhanceCodeBlocks(container) {
  configurePrismLanguages();

  container.querySelectorAll("pre code").forEach((code) => {
    const pre = code.closest("pre");
    const declaredLanguage = declaredCodeLanguage(code);
    const normalizedLanguage = normalizeCodeLanguage(declaredLanguage);

    pre?.classList.add("code-block");

    if (declaredLanguage && pre) {
      pre.classList.add("has-code-language");
      pre.dataset.language = codeLanguageLabel(declaredLanguage);

      // Inject a real button for the language badge so it can be clicked to copy.
      // Guard against double-injection when the block is re-rendered.
      if (!pre.querySelector(".code-copy-btn")) {
        const label = codeLanguageLabel(declaredLanguage);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy-btn";
        btn.textContent = label;
        btn.title = "Copy code";
        btn.addEventListener("click", async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(code.textContent ?? "");
            btn.textContent = "✓";
            btn.classList.add("is-copied");
            setTimeout(() => {
              btn.textContent = label;
              btn.classList.remove("is-copied");
            }, 1400);
          } catch {
            // clipboard unavailable — silent fail
          }
        });
        pre.appendChild(btn);
      }
    }

    if (!window.Prism || !normalizedLanguage || code.dataset.highlighted === "yes") return;

    code.classList.add(`language-${normalizedLanguage}`);
    pre?.classList.add(`language-${normalizedLanguage}`);
    Prism.highlightElement(code);
  });
}

async function enhanceRenderedMarkdown(container) {
  container.querySelectorAll("a[href]").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  enhanceCodeBlocks(container);

  container.querySelectorAll(".math-display[data-tex], .math-inline[data-tex]").forEach((node) => {
    try {
      katex.render(decodeURIComponent(node.dataset.tex), node, {
        displayMode: node.classList.contains("math-display"),
        throwOnError: false
      });
    } catch (error) {
      node.textContent = decodeURIComponent(node.dataset.tex);
    }
  });

  renderMathInElement(container, {
    delimiters: [
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false }
    ],
    throwOnError: false
  });

  const diagrams = container.querySelectorAll(".mermaid");
  diagrams.forEach((node) => {
    if (node.dataset.diagram) {
      node.textContent = decodeURIComponent(node.dataset.diagram);
    }
    node.removeAttribute("data-processed");
  });
  if (diagrams.length) {
    try {
      await mermaid.run({ nodes: diagrams });
      diagrams.forEach(addDiagramZoomControl);
    } catch (error) {
      console.warn("Mermaid render failed", error);
    }
  }

  const nomnomlDiagrams = container.querySelectorAll(".nomnoml-diagram");
  nomnomlDiagrams.forEach((node) => {
    if (node.dataset.diagram) {
      node.textContent = decodeURIComponent(node.dataset.diagram);
    }
    node.removeAttribute("data-processed");
  });

  if (nomnomlDiagrams.length) {
    nomnomlDiagrams.forEach((node) => {
      try {
        const diagramSource = node.textContent;
        const printTheme = Boolean(node.closest(".print-root"));
        const svg = nomnoml.renderSvg(sourceWithNomnomlTheme(diagramSource, printTheme));
        node.classList.add("nomnoml-light-theme");
        node.innerHTML = svg;
        node.querySelector("svg")?.classList.add("nomnoml-light-svg");
        addDiagramZoomControl(node);
      } catch (err) {
        console.warn("Nomnoml render error:", err);
        node.textContent = "Error rendering Nomnoml: " + err.message;
      }
    });
  }

  container.querySelectorAll("img").forEach((img) => {
    const rewritten = normalizeImageUrl(img.getAttribute("src"));
    if (rewritten !== img.getAttribute("src")) img.setAttribute("src", rewritten);
    addDiagramZoomControl(img);
  });

  fitMarkdownTables(container);
}

// Notes frequently start at ## (or deeper) because the top-level # is reserved
// for a document title elsewhere. Promote the whole heading tree so the
// shallowest heading in the notes renders as <h1>: if the topmost level is ##,
// it becomes #, ### becomes ##, and so on. Every heading is shifted by the same
// amount, so the relative structure (and the derived TOC) is preserved. Only
// affects the rendered notes view — the raw markdown and card parsing are left
// untouched. Fenced code is skipped so a leading `#` in code isn't mistaken for
// a heading.
function promoteNotesHeadings(markdown) {
  const lines = String(markdown || "").split("\n");
  const levels = new Array(lines.length).fill(0);
  let inFence = false;
  let fenceChar = "";
  let minLevel = 7;
  lines.forEach((line, i) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
      return;
    }
    if (inFence) return;
    const heading = line.match(/^(#{1,6})\s+\S/);
    if (heading) {
      levels[i] = heading[1].length;
      if (heading[1].length < minLevel) minLevel = heading[1].length;
    }
  });
  const shift = minLevel <= 6 ? minLevel - 1 : 0;
  if (shift <= 0) return String(markdown || "");
  return lines.map((line, i) => (levels[i] ? "#".repeat(levels[i] - shift) + line.slice(levels[i]) : line)).join("\n");
}

async function renderMarkdown(container, markdown, allowPlaceholder = false) {
  let displayMarkdown = markdown;
  if (allowPlaceholder && (!markdown || String(markdown).trim() === "")) {
    if (container.closest(".all-card-question") || container.closest(".card-question")) {
      displayMarkdown = "<div class='empty-placeholder'>Question</div>";
    } else if (container.closest(".all-card-answer") || container.closest(".card-answer")) {
      displayMarkdown = "<div class='empty-placeholder'>Answer</div>";
    }
  }
  if (container === el.notesView) displayMarkdown = promoteNotesHeadings(displayMarkdown);
  container.innerHTML = markdownToSafeHtml(displayMarkdown);
  await enhanceRenderedMarkdown(container);
  if (container === el.notesView) {
    enhanceNotesImageControls();
    buildNotesToc();
  }
}

function markdownTableColumnCount(table) {
  return Array.from(table.rows).reduce((max, row) => {
    const count = Array.from(row.cells).reduce((sum, cell) => sum + Math.max(1, cell.colSpan || 1), 0);
    return Math.max(max, count);
  }, 0);
}

function tableCellWeight(cell) {
  const text = String(cell.textContent || "").replace(/\s+/g, " ").trim();
  const longestWord = text.split(/\s+/).reduce((max, word) => Math.max(max, word.length), 0);
  return Math.max(4, Math.min(80, text.length * 0.58 + longestWord * 0.9));
}

function applyMarkdownTableColumns(table) {
  const columnCount = markdownTableColumnCount(table);
  if (!columnCount) return;
  table.style.setProperty("--markdown-table-columns", String(columnCount));

  const weights = Array(columnCount).fill(4);
  Array.from(table.rows).forEach((row) => {
    let columnIndex = 0;
    Array.from(row.cells).forEach((cell) => {
      const span = Math.max(1, cell.colSpan || 1);
      const weight = tableCellWeight(cell) / span;
      for (let offset = 0; offset < span && columnIndex + offset < weights.length; offset += 1) {
        weights[columnIndex + offset] = Math.max(weights[columnIndex + offset], weight);
      }
      columnIndex += span;
    });
  });

  table.querySelector(":scope > colgroup")?.remove();
  const colgroup = document.createElement("colgroup");
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  weights.forEach((weight) => {
    const col = document.createElement("col");
    col.style.width = `${(weight / total) * 100}%`;
    colgroup.appendChild(col);
  });
  table.insertBefore(colgroup, table.firstChild);
}

function markdownTableHeaderCells(table) {
  if (table.tHead?.rows.length) {
    return Array.from(table.tHead.rows[table.tHead.rows.length - 1].cells);
  }

  return Array.from(table.rows)
    .find((row) => Array.from(row.cells).some((cell) => cell.tagName === "TH"))
    ?.cells || [];
}

function markdownTableHeaders(table) {
  const labels = [];
  Array.from(markdownTableHeaderCells(table)).forEach((cell) => {
    const label = String(cell.textContent || "").replace(/\s+/g, " ").trim();
    const span = Math.max(1, cell.colSpan || 1);
    for (let index = 0; index < span; index += 1) {
      labels.push(label || `Column ${labels.length + 1}`);
    }
  });
  return labels;
}

function applyMarkdownTableLabels(table) {
  const labels = markdownTableHeaders(table);
  const columnCount = markdownTableColumnCount(table);
  while (labels.length < columnCount) {
    labels.push(`Column ${labels.length + 1}`);
  }
  if (!labels.length) return;

  const headerCells = new Set(Array.from(markdownTableHeaderCells(table)));
  Array.from(table.rows).forEach((row) => {
    let columnIndex = 0;
    Array.from(row.cells).forEach((cell) => {
      const span = Math.max(1, cell.colSpan || 1);
      if (!headerCells.has(cell)) {
        cell.dataset.label = labels[columnIndex] || `Column ${columnIndex + 1}`;
      }
      columnIndex += span;
    });
  });
}

function wrapMarkdownTable(table) {
  if (table.parentElement?.classList.contains("markdown-table-wrap")) return table.parentElement;
  const wrapper = document.createElement("div");
  wrapper.className = "markdown-table-wrap";
  table.parentNode.insertBefore(wrapper, table);
  wrapper.appendChild(table);
  return wrapper;
}

function markdownTableFits(table, wrapper) {
  const allowance = 1;
  if (table.scrollWidth > wrapper.clientWidth + allowance) return false;
  return Array.from(table.cells || table.querySelectorAll("th, td"))
    .every((cell) => cell.scrollWidth <= cell.clientWidth + allowance);
}

function fitMarkdownTables(container) {
  container.querySelectorAll("table").forEach((table) => {
    // Genuine markdown tables always live inside a `.rendered` block. Skip
    // anything else (e.g. the structural <table> the Cornell HTML/Word
    // export uses for its question/answer columns) so this auto-fit pass
    // doesn't reflow layout tables it was never meant to touch.
    if (table.closest("pre") || !table.closest(".rendered")) return;

    const wrapper = wrapMarkdownTable(table);
    applyMarkdownTableLabels(table);
    applyMarkdownTableColumns(table);
    if (!wrapper.clientWidth) return;

    if (!table.dataset.baseFontSize) {
      table.dataset.baseFontSize = String(parseFloat(getComputedStyle(table).fontSize) || 16);
    }

    const baseFontSize = parseFloat(table.dataset.baseFontSize) || 16;
    const minimumFontSize = 7;
    table.style.fontSize = `${baseFontSize}px`;

    if (styleMobileMedia?.matches) return;

    if (markdownTableFits(table, wrapper)) return;

    let low = minimumFontSize;
    let high = baseFontSize;
    let best = low;

    for (let index = 0; index < 10; index += 1) {
      const mid = (low + high) / 2;
      table.style.fontSize = `${mid}px`;
      if (markdownTableFits(table, wrapper)) {
        best = mid;
        low = mid;
      } else {
        high = mid;
      }
    }

    table.style.fontSize = `${Math.max(minimumFontSize, best - 0.25)}px`;
  });
}

function scheduleMarkdownTableFit() {
  cancelAnimationFrame(markdownTableFitFrame);
  markdownTableFitFrame = requestAnimationFrame(() => {
    document.querySelectorAll(".rendered").forEach((node) => fitMarkdownTables(node));
  });
}

function addDiagramZoomControl(node) {
  if (node.closest("#printRoot")) return;
  if (node.parentElement?.classList.contains("diagram-shell")) return;

  const shell = document.createElement("div");
  shell.className = "diagram-shell";
  if (node.classList.contains("nomnoml-light-theme")) {
    shell.classList.add("nomnoml-light-shell");
  }
  const button = document.createElement("button");
  button.className = "diagram-zoom";
  button.type = "button";
  button.textContent = "Zoom";
  button.addEventListener("click", () => openDiagramModal(node));

  node.parentNode.insertBefore(shell, node);
  shell.appendChild(node);
  shell.appendChild(button);
}

let currentDiagramZoom = null;
const diagramZoomRange = {
  min: 0.2,
  max: 8
};

function clampDiagramScale(value) {
  return Math.min(diagramZoomRange.max, Math.max(diagramZoomRange.min, value));
}

function diagramViewportCenter() {
  const rect = el.diagramModalBody.getBoundingClientRect();
  return {
    x: rect.width / 2,
    y: rect.height / 2
  };
}

function diagramLocalPoint(point) {
  if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
    return { x: point.x, y: point.y };
  }
  const rect = el.diagramModalBody.getBoundingClientRect();
  return {
    x: point.clientX - rect.left,
    y: point.clientY - rect.top
  };
}

function zoomDiagramTo(scale, focalPoint = diagramViewportCenter()) {
  if (!currentDiagramZoom) return;
  const nextScale = clampDiagramScale(scale);
  const focal = diagramLocalPoint(focalPoint);
  const anchorX = (focal.x - currentDiagramZoom.x) / currentDiagramZoom.scale;
  const anchorY = (focal.y - currentDiagramZoom.y) / currentDiagramZoom.scale;
  currentDiagramZoom.scale = nextScale;
  currentDiagramZoom.x = focal.x - anchorX * nextScale;
  currentDiagramZoom.y = focal.y - anchorY * nextScale;
  applyDiagramTransform();
}

function zoomDiagramBy(multiplier) {
  if (!currentDiagramZoom) return;
  zoomDiagramTo(currentDiagramZoom.scale * multiplier);
}

function diagramPointers() {
  return Array.from(currentDiagramZoom?.pointers.values() || []);
}

function pointerDistance(points) {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function pointerCenter(points) {
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2
  };
}

function isVectorDiagramContent(content) {
  return content instanceof SVGElement;
}

function baseDiagramSize(content) {
  const rect = content.getBoundingClientRect();
  const viewBox = content instanceof SVGElement ? content.viewBox?.baseVal : null;
  if (viewBox?.width && viewBox?.height) {
    return {
      width: viewBox.width,
      height: viewBox.height
    };
  }
  if (content instanceof HTMLImageElement && content.naturalWidth && content.naturalHeight) {
    return {
      width: content.naturalWidth,
      height: content.naturalHeight
    };
  }
  return {
    width: rect.width || Number(content.getAttribute("width")) || 1,
    height: rect.height || Number(content.getAttribute("height")) || 1
  };
}

function applyDiagramTransform() {
  if (!currentDiagramZoom?.content) return;
  const { content, scale, x, y, baseWidth, baseHeight, isVector } = currentDiagramZoom;
  if (isVector) {
    content.style.width = `${baseWidth}px`;
    content.style.height = `${baseHeight}px`;
  }

  content.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`;
}

function beginDiagramPan(point) {
  if (!currentDiagramZoom) return;
  const local = diagramLocalPoint(point);
  currentDiagramZoom.mode = "pan";
  currentDiagramZoom.panStartX = currentDiagramZoom.x;
  currentDiagramZoom.panStartY = currentDiagramZoom.y;
  currentDiagramZoom.pointerStartX = local.x;
  currentDiagramZoom.pointerStartY = local.y;
}

function beginDiagramPinch() {
  if (!currentDiagramZoom) return;
  const points = diagramPointers();
  if (points.length < 2) return;

  const center = pointerCenter(points);
  currentDiagramZoom.mode = "pinch";
  currentDiagramZoom.pinchStartDistance = pointerDistance(points) || 1;
  currentDiagramZoom.pinchStartScale = currentDiagramZoom.scale;
  currentDiagramZoom.pinchAnchorX = (center.x - currentDiagramZoom.x) / currentDiagramZoom.scale;
  currentDiagramZoom.pinchAnchorY = (center.y - currentDiagramZoom.y) / currentDiagramZoom.scale;
}

function centerDiagramContent(content) {
  if (!currentDiagramZoom || currentDiagramZoom.content !== content) return;
  const bodyRect = el.diagramModalBody.getBoundingClientRect();
  const { width, height } = baseDiagramSize(content);
  currentDiagramZoom.baseWidth = width;
  currentDiagramZoom.baseHeight = height;
  const fitPadding = 24;
  const fitScale = Math.min(
    1,
    Math.max(0.1, (bodyRect.width - fitPadding * 2) / Math.max(width, 1)),
    Math.max(0.1, (bodyRect.height - fitPadding * 2) / Math.max(height, 1))
  );

  currentDiagramZoom.scale = clampDiagramScale(fitScale);
  currentDiagramZoom.x = (bodyRect.width - width * currentDiagramZoom.scale) / 2;
  currentDiagramZoom.y = (bodyRect.height - height * currentDiagramZoom.scale) / 2;
  applyDiagramTransform();
}

function initializeDiagramZoom(content) {
  const { width, height } = baseDiagramSize(content);
  currentDiagramZoom = {
    content,
    isVector: isVectorDiagramContent(content),
    baseWidth: width,
    baseHeight: height,
    scale: 1,
    x: 0,
    y: 0,
    pointers: new Map(),
    mode: "",
    panStartX: 0,
    panStartY: 0,
    pointerStartX: 0,
    pointerStartY: 0,
    pinchStartDistance: 1,
    pinchStartScale: 1,
    pinchAnchorX: 0,
    pinchAnchorY: 0
  };
  requestAnimationFrame(() => centerDiagramContent(content));
}

function resetDiagramZoom() {
  currentDiagramZoom = null;
}

function openDiagramModal(node) {
  lockPageScroll();
  el.diagramModalBody.innerHTML = "";
  el.diagramModalBody.classList.remove("nomnoml-light-modal-body");
  if (node.tagName === "IMG") {
    el.diagramModalBody.appendChild(node.cloneNode(true));
  } else {
    el.diagramModalBody.innerHTML = node.innerHTML;
  }
  el.diagramModal.hidden = false;
  
  const content = el.diagramModalBody.querySelector("svg, img");
  if (content) {
    content.classList.add("diagram-zoom-content");
    if (content.classList.contains("nomnoml-light-svg")) {
      el.diagramModalBody.classList.add("nomnoml-light-modal-body");
    }
    initializeDiagramZoom(content);
  }
}

function closeDiagramModal() {
  el.diagramModal.hidden = true;
  el.diagramModalBody.innerHTML = "";
  el.diagramModalBody.classList.remove("nomnoml-light-modal-body");
  resetDiagramZoom();
  unlockPageScroll();
}

function closeAllCardsPanel() {
  allCardsRenderId += 1;
  el.allCardsPanel.hidden = true;
  unlockPageScroll();
}

function goToCard(cardId) {
  let index = state.cards.findIndex(c => c.id === cardId);
  if (index === -1) {
    // Revert to studying all master cards
    state.cards = state.masterCards.slice();
    index = state.cards.findIndex(c => c.id === cardId);
  }
  if (index !== -1) {
    state.current = index;
    state.previewCard = null;
    showCard();
    closeAllCardsPanel();
  } else {
    setStatus("Card not found.", "error");
  }
}

// ── Structural card undo/redo (add / delete / reorder) ─────────────────────
// Deliberately scoped to the card array only, not text edits — question/answer/
// notes textareas already get native per-keystroke undo from the browser, and
// folding those into this stack would replace that fine-grained undo with
// coarse snapshot jumps. Reset whenever a different deck's cards are loaded
// (see resetStudyDeck) so Ctrl+Z can't reach across decks.
const CARD_UNDO_LIMIT = 50;
let cardUndoStack = [];
let cardRedoStack = [];

function snapshotCardsState() {
  return {
    masterCards: state.masterCards.map((c) => ({ ...c })),
    cards: state.cards.map((c) => ({ ...c })),
    statusById: { ...state.statusById },
    current: state.current,
  };
}

function pushCardUndoSnapshot(snapshot) {
  cardUndoStack.push(snapshot);
  if (cardUndoStack.length > CARD_UNDO_LIMIT) cardUndoStack.shift();
  cardRedoStack = [];
}

function resetCardUndoHistory() {
  cardUndoStack = [];
  cardRedoStack = [];
}

function restoreCardsState(snapshot) {
  state.masterCards = snapshot.masterCards.map((c) => ({ ...c }));
  state.cards = snapshot.cards.map((c) => ({ ...c }));
  state.statusById = { ...snapshot.statusById };
  state.current = state.cards.length ? Math.min(snapshot.current, state.cards.length - 1) : 0;
  state.previewCard = null;
  syncResults();
  updateMeta();
  showCard();
  allCardsRenderId += 1;
  renderAllCards();
}

function undoCardAction() {
  if (!cardUndoStack.length) {
    setStatus("Nothing to undo.");
    return;
  }
  cardRedoStack.push(snapshotCardsState());
  restoreCardsState(cardUndoStack.pop());
  scheduleDeckAutosave();
  setStatus("Undid last card change.");
}

function redoCardAction() {
  if (!cardRedoStack.length) {
    setStatus("Nothing to redo.");
    return;
  }
  cardUndoStack.push(snapshotCardsState());
  restoreCardsState(cardRedoStack.pop());
  scheduleDeckAutosave();
  setStatus("Redid card change.");
}

function deleteAllCard(cardId) {
  showConfirmModal("Delete this card?", () => {
    pushCardUndoSnapshot(snapshotCardsState());
    state.masterCards = state.masterCards.filter(c => c.id !== cardId);
    state.cards = state.cards.filter(c => c.id !== cardId);
    delete state.statusById[cardId];
    if (state.current >= state.cards.length) {
      state.current = Math.max(0, state.cards.length - 1);
    }
    showCard();
    renderAllCards();
    setStatus(state.deckId ? "Card deleted locally. Sync to update the web deck." : "Card deleted. Ctrl+Z to undo.");
  }, { confirmLabel: "Delete", danger: true });
}

function setAllCardStatus(cardId, status) {
  if (state.statusById[cardId] === status) {
    delete state.statusById[cardId];
  } else {
    state.statusById[cardId] = status;
  }
  syncResults();
  updateMeta();
  updateAllCardStatuses();
  scheduleDeckAutosave();
}

function createBlankCard() {
  // Random suffix: bare Date.now() collides when two cards are added within
  // the same millisecond (rapid double-click on Add), and card ids must be
  // globally unique in the cloud (see parseCards).
  return { id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, question: '', answer: '' };
}

function refreshAllCardsAround(cardId, side = "question") {
  allCardsRenderId += 1;
  const renderId = allCardsRenderId;
  return renderAllCards().then(async () => {
    if (renderId !== allCardsRenderId) return null;
    const item = Array.from(el.allCardsList.querySelectorAll(".all-card"))
      .find((node) => node.dataset.cardId === cardId);
    if (item && side === "answer") {
      item.classList.add("is-flipped");
      await ensureAllCardAnswer(item);
    }
    if (item) updateAllCardEditButton(item);
    item?.scrollIntoView({ block: "nearest" });
    item?.focus({ preventScroll: true });
    return item || null;
  });
}

function insertCardAfter(cardId) {
  if (!state.masterCards.length && !state.deckTitle) {
    setStatus("Create a new deck or import one first.", "error");
    return;
  }

  const insertAfterIndex = state.masterCards.findIndex((card) => card.id === cardId);
  if (insertAfterIndex < 0) return;

  const currentCardId = state.cards[state.current]?.id || null;
  const shouldRefreshActiveDeck = activeDeckMatchesMasterOrder();
  pushCardUndoSnapshot(snapshotCardsState());
  const newCard = createBlankCard();
  state.masterCards.splice(insertAfterIndex + 1, 0, newCard);

  if (shouldRefreshActiveDeck) {
    state.cards = state.masterCards.slice();
    state.current = currentCardId
      ? Math.max(0, state.cards.findIndex((item) => item.id === currentCardId))
      : 0;
  }

  state.previewCard = null;
  updateMeta();
  showCard();
  refreshAllCardsAround(newCard.id).then((item) => {
    if (item) openAllCardEditor(item, "question");
  });
  setStatus(state.deckId ? "Card inserted locally. Sync to update the web deck." : "Card inserted.");
}

function activeDeckMatchesMasterOrder() {
  if (state.cards.length !== state.masterCards.length) return false;
  return state.cards.every((card, index) => card.id === state.masterCards[index]?.id);
}

function clearAllCardDropTargets() {
  el.allCardsList.querySelectorAll(".all-card").forEach((item) => {
    item.classList.remove("is-dragging", "drop-before", "drop-after");
  });
}

function finishMasterCardReorder(cardId, shouldRefreshActiveDeck, currentCardId) {
  if (shouldRefreshActiveDeck) {
    state.cards = state.masterCards.slice();
    state.current = currentCardId
      ? Math.max(0, state.cards.findIndex((item) => item.id === currentCardId))
      : Math.min(state.current, Math.max(state.cards.length - 1, 0));
  }

  state.previewCard = null;
  syncResults();
  updateMeta();
  showCard();

  allCardsRenderId += 1;
  const renderId = allCardsRenderId;
  renderAllCards().then(() => {
    if (renderId !== allCardsRenderId) return;
    const movedItem = Array.from(el.allCardsList.querySelectorAll(".all-card"))
      .find((item) => item.dataset.cardId === cardId);
    movedItem?.scrollIntoView({ block: "nearest" });
    movedItem?.focus({ preventScroll: true });
  });
  setStatus(state.deckId ? "Card order updated locally. Sync to update the web deck." : "Card order updated.");
}

function reorderMasterCard(cardId, targetCardId, placement) {
  if (!cardId || !targetCardId || cardId === targetCardId) return;

  const fromIndex = state.masterCards.findIndex((card) => card.id === cardId);
  const targetIndex = state.masterCards.findIndex((card) => card.id === targetCardId);

  if (fromIndex < 0 || targetIndex < 0) return;

  const currentCardId = state.cards[state.current]?.id || null;
  const shouldRefreshActiveDeck = activeDeckMatchesMasterOrder();
  const beforeSnapshot = snapshotCardsState();
  const [card] = state.masterCards.splice(fromIndex, 1);
  let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  if (fromIndex < insertIndex) insertIndex -= 1;
  insertIndex = Math.min(Math.max(insertIndex, 0), state.masterCards.length);

  if (insertIndex === fromIndex) {
    state.masterCards.splice(fromIndex, 0, card);
    return;
  }

  state.masterCards.splice(insertIndex, 0, card);
  pushCardUndoSnapshot(beforeSnapshot);
  finishMasterCardReorder(cardId, shouldRefreshActiveDeck, currentCardId);
}

function allCardDropPlacement(item, event) {
  const rect = item.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function markAllCardDropTarget(item, placement) {
  clearAllCardDropTargets();
  item.classList.add(placement === "after" ? "drop-after" : "drop-before");
  const draggedItem = Array.from(el.allCardsList.querySelectorAll(".all-card"))
    .find((node) => node.dataset.cardId === draggedAllCardId);
  draggedItem?.classList.add("is-dragging");
}

function handleAllCardDragStart(event) {
  const item = closestElement(event.target, ".all-card");
  if (!item || closestElement(event.target, "button, a, input, textarea")) {
    event.preventDefault();
    return;
  }

  draggedAllCardId = item.dataset.cardId;
  item.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedAllCardId);
}

function handleAllCardDragOver(event) {
  if (!draggedAllCardId) return;
  const item = closestElement(event.target, ".all-card");
  if (!item) return;
  if (item.dataset.cardId === draggedAllCardId) {
    clearAllCardDropTargets();
    item.classList.add("is-dragging");
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  markAllCardDropTarget(item, allCardDropPlacement(item, event));
}

function handleAllCardDrop(event) {
  if (!draggedAllCardId) return;
  const item = closestElement(event.target, ".all-card");
  if (!item || item.dataset.cardId === draggedAllCardId) return;

  event.preventDefault();
  const placement = allCardDropPlacement(item, event);
  const droppedCardId = draggedAllCardId;
  draggedAllCardId = "";
  clearAllCardDropTargets();
  reorderMasterCard(droppedCardId, item.dataset.cardId, placement);
}

function handleAllCardDragEnd() {
  draggedAllCardId = "";
  clearAllCardDropTargets();
}

function updateAllCardStatuses() {
  el.allCardsList.querySelectorAll(".all-card").forEach((node) => {
    const status = state.statusById[node.dataset.cardId] || "";
    node.dataset.status = status;
    setCardStatusBadge(node.querySelector("[data-all-status-label]"), status);
    node.querySelectorAll("[data-all-status]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.allStatus === status);
    });
  });
  // A card whose status just changed may fall in/out of an active filter —
  // refresh the CSS filter + header count so it drops out (or the count updates).
  applyAllCardsFilter();
}

function allCardById(cardId) {
  return state.masterCards.find((card) => card.id === cardId) || null;
}

function closeAllCardEditor(item) {
  const editor = item?.querySelector(".all-card-editor");
  if (!editor) return;
  editor.hidden = true;
  editor.dataset.side = "";
  item.classList.remove("is-editing");
  item.draggable = true;
  updateAllCardEditButton(item);
  adjustCornellRowHeight(item);
}

function closeAllCardEditors(exceptItem = null) {
  el.allCardsList.querySelectorAll(".all-card.is-editing").forEach((item) => {
    if (item !== exceptItem) closeAllCardEditor(item);
  });
}

function allCardVisibleSide(item) {
  return item?.classList.contains("is-flipped") ? "answer" : "question";
}

function updateAllCardEditButton(item) {
  const button = item?.querySelector("[data-all-edit-current]");
  if (!button) return;
  const editing = item.classList.contains("is-editing");
  const side = editing
    ? item.querySelector(".all-card-editor")?.dataset.side || allCardVisibleSide(item)
    : allCardVisibleSide(item);
  button.innerHTML = editing ? "&#128190;" : "&#9998;";
  button.classList.toggle("is-saving", editing);
  button.title = editing
    ? `Save ${side}`
    : `Edit ${side}`;
  button.setAttribute("aria-label", button.title);
}

function openAllCardEditor(item, side = allCardVisibleSide(item)) {
  const card = allCardById(item?.dataset.cardId);
  const editor = item?.querySelector(".all-card-editor");
  if (!card || !editor) return;

  closeAllCardEditors(item);
  item.classList.add("is-editing");
  item.draggable = false;
  if (side === "answer") item.classList.add("is-flipped");
  editor.hidden = false;
  editor.dataset.side = side;
  editor.querySelector("[data-all-edit-label]").textContent = side === "answer" ? "Answer" : "Question";
  const textarea = editor.querySelector("[data-all-edit-value]");
  textarea.value = side === "answer" ? card.answer : card.question;
  updateAllCardEditButton(item);
  adjustCornellRowHeight(item);
  enableSyntaxHighlighting(textarea);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggleAllCardEditor(item) {
  if (!item) return;
  const editor = item.querySelector(".all-card-editor");
  if (item.classList.contains("is-editing")) {
    saveAllCardEditor(item);
    return;
  }
  openAllCardEditor(item, allCardVisibleSide(item));
}

function saveAllCardEditor(item) {
  const card = allCardById(item?.dataset.cardId);
  const editor = item?.querySelector(".all-card-editor");
  if (!card || !editor) return;

  const side = editor.dataset.side === "answer" ? "answer" : "question";
  const value = editor.querySelector("[data-all-edit-value]").value.trim();

  if (!value) {
    setStatus(`${side === "answer" ? "Answer" : "Question"} cannot be empty.`, "error");
    return;
  }

  card[side] = value;
  updateMeta();
  // showCard (below) schedules an autosave, but only runs when the edited card
  // is the one on screen — schedule explicitly so edits to any other card are
  // persisted too instead of waiting for the next navigation/tab-hide flush.
  scheduleDeckAutosave();
  if (state.cards[state.current]?.id === card.id || state.previewCard?.id === card.id) {
    showCard();
  }

  refreshAllCardsAround(card.id, side);
  setStatus(state.deckId ? "Card updated locally. Sync to update the web deck." : "Card updated.");
}

async function ensureAllCardAnswer(item) {
  if (item.dataset.answerRendered === "true") {
    adjustCornellRowHeight(item);
    return;
  }
  if (item.dataset.answerRendered === "rendering") return;
  const card = item.cardData;
  if (!card) return;

  item.dataset.answerRendered = "rendering";
  const answerView = item.querySelector(".all-card-answer .rendered");
  answerView.textContent = "Rendering...";
  await renderMarkdown(answerView, card.answer, true);
  item.dataset.answerRendered = "true";
  adjustCornellRowHeight(item);
}

function flipAllCard(item) {
  if (item.dataset.answerRendered === "rendering") return;
  if (item.classList.contains("is-editing")) return;
  const willShowAnswer = !item.classList.contains("is-flipped");
  item.classList.toggle("is-flipped", willShowAnswer);
  if (willShowAnswer) {
    ensureAllCardAnswer(item).then(() => adjustCornellRowHeight(item));
  } else {
    adjustCornellRowHeight(item);
  }
  updateAllCardEditButton(item);
}

function adjustCornellRowHeight(row) {
  if (!row) return;
  row.style.minHeight = "";
  // Compact rows size to their content — no forced min-height.
  if (row.closest(".all-cards-list.is-compact")) return;
  const rail = row.querySelector(".cornell-question-rail");
  const question = rail?.querySelector(".rendered");
  const answerCell = row.querySelector(".cornell-answer-cell");
  if (!rail || !question || !answerCell) return;

  const railStyle = getComputedStyle(rail);
  const railPaddingY = (parseFloat(railStyle.paddingTop) || 0) + (parseFloat(railStyle.paddingBottom) || 0);
  const railGap = parseFloat(railStyle.rowGap || railStyle.gap) || 0;
  const badge = rail.querySelector(".cornell-row-number");
  const badgeHeight = badge ? badge.getBoundingClientRect().height : 0;
  const questionBuffer = row.classList.contains("cornell-print-row") ? 10 : 16;
  const questionHeight = question.scrollHeight + railPaddingY + badgeHeight + railGap + questionBuffer;
  const answerHeight = answerCell.scrollHeight;
  const minHeight = row.classList.contains("cornell-print-row") ? 72 : 108;
  row.style.minHeight = `${Math.ceil(Math.max(minHeight, rail.scrollHeight, questionHeight, answerHeight))}px`;
}

function adjustCornellRows(container = document) {
  container.querySelectorAll(".cornell-card, .cornell-print-row").forEach(adjustCornellRowHeight);
}

function updateAllAnswersToggleButton() {
  if (!el.toggleAllAnswersBtn) return;
  el.toggleAllAnswersBtn.textContent = allCardsAnswersVisible ? "Hide answers" : "Show answers";
  el.toggleAllAnswersBtn.setAttribute("aria-pressed", allCardsAnswersVisible ? "true" : "false");
}

function updateCompactToggleButton() {
  if (!el.toggleCompactBtn) return;
  el.toggleCompactBtn.classList.toggle("is-active", allCardsCompact);
  el.toggleCompactBtn.setAttribute("aria-pressed", allCardsCompact ? "true" : "false");
}

// Toggle the dense one-line-per-card view. Pure CSS switch on the list, so no
// re-render is needed — just clear the JS-computed inline row heights (compact
// rows size to their content) and re-measure.
function setAllCardsCompact(on) {
  allCardsCompact = Boolean(on);
  try { localStorage.setItem("recall:allCardsCompact", allCardsCompact ? "1" : "0"); } catch (_) {}
  updateCompactToggleButton();
  if (el.allCardsList) {
    el.allCardsList.classList.toggle("is-compact", allCardsCompact);
    el.allCardsList.querySelectorAll(".cornell-card").forEach((row) => { row.style.minHeight = ""; });
    if (!allCardsCompact) adjustCornellRows(el.allCardsList);
  }
}

// Number of cards matching the active status filter.
function allCardsFilterMatchCount() {
  if (allCardsFilter === "all") return state.masterCards.length;
  return state.masterCards.filter((card) => {
    const status = normalizeCardStatus(state.statusById[card.id]);
    return allCardsFilter === "none" ? !status : status === allCardsFilter;
  }).length;
}

// Reflect the active filter on the list (drives the CSS hide/show), the filter
// buttons, and the header count. Called on render, on filter change, and after
// a status change (so a card toggled under an active filter drops out live).
function applyAllCardsFilter() {
  if (el.allCardsList) el.allCardsList.dataset.filter = allCardsFilter;
  if (el.allCardsFilter) {
    el.allCardsFilter.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.filter === allCardsFilter);
    });
  }
  if (el.allCardsSummary) {
    const total = state.masterCards.length;
    const totalLabel = `${total} ${total === 1 ? "card" : "cards"}`;
    if (allCardsFilter === "all") {
      el.allCardsSummary.textContent = totalLabel;
    } else {
      el.allCardsSummary.textContent = `${allCardsFilterMatchCount()} of ${totalLabel}`;
    }
  }
}

function setAllCardsFilter(filter) {
  allCardsFilter = ALL_CARDS_FILTERS.has(filter) ? filter : "all";
  try { localStorage.setItem("recall:allCardsFilter", allCardsFilter); } catch (_) {}
  applyAllCardsFilter();
}

async function setAllCardsAnswersVisible(visible) {
  allCardsAnswersVisible = Boolean(visible);
  updateAllAnswersToggleButton();

  const rows = Array.from(el.allCardsList.querySelectorAll(".cornell-card"));
  for (const row of rows) {
    row.classList.toggle("is-flipped", allCardsAnswersVisible);
    if (allCardsAnswersVisible) {
      await ensureAllCardAnswer(row);
    } else {
      adjustCornellRowHeight(row);
    }
  }
  await afterPaint();
  adjustCornellRows(el.allCardsList);
}

async function renderAllCards() {
  const cards = state.masterCards;
  const renderId = allCardsRenderId;
  el.allCardsList.innerHTML = "";
  el.allCardsList.classList.toggle("is-compact", allCardsCompact);
  updateAllAnswersToggleButton();
  updateCompactToggleButton();
  applyAllCardsFilter();

  for (const [index, card] of cards.entries()) {
    if (renderId !== allCardsRenderId) return;

    const template = document.createElement("template");
    template.innerHTML = cornellCardHtml(card, index, { answerVisible: allCardsAnswersVisible });
    const item = template.content.firstElementChild;
    item.cardData = card;
    const dragHandle = document.createElement("div");
    dragHandle.className = "all-card-drag-handle";
    dragHandle.setAttribute("aria-hidden", "true");
    dragHandle.textContent = "⠿";
    item.prepend(dragHandle);
    const editor = document.createElement("div");
    editor.className = "all-card-editor";
    editor.hidden = true;
    editor.innerHTML = `
      <label>
        <div class="all-card-editor-header">
          <span data-all-edit-label>Question</span>
          <div class="edit-toolbar" data-all-card-toolbar>
            ${createToolbarHtml()}
          </div>
        </div>
        <textarea data-all-edit-value spellcheck="false"></textarea>
      </label>
    `;
    item.querySelector(".cornell-answer-cell").appendChild(editor);
    el.allCardsList.appendChild(item);
    await enhanceRenderedMarkdown(item.querySelector(".all-card-question .rendered"));
    if (allCardsAnswersVisible) {
      await enhanceRenderedMarkdown(item.querySelector(".cornell-answer-body"));
    }
    adjustCornellRowHeight(item);
  }

  updateAllCardStatuses();
  await afterPaint();
  adjustCornellRows(el.allCardsList);
}

function openAllCardsPanel() {
  if (!state.masterCards.length) {
    setStatus("Import a deck before opening all cards.", "error");
    return;
  }

  lockPageScroll();
  allCardsRenderId += 1;
  el.allCardsPanel.hidden = false;
  renderAllCards();
}

function cardStatusLabel(status) {
  if (status === "known") return "Known";
  if (status === "review") return "Review";
  return "Uncategorized";
}

function setCardStatusBadge(badge, status) {
  if (!badge) return;
  badge.dataset.status = status;
  badge.textContent = cardStatusLabel(status);
}

function updateActiveCardStatusBadges() {
  const card = state.previewCard || state.cards[state.current] || null;
  const status = card ? normalizeCardStatus(state.statusById[card.id]) : "";
  setCardStatusBadge(el.questionStatusBadge, status);
  setCardStatusBadge(el.answerStatusBadge, status);
}

// A deck "exists" for UI purposes once it's been created/loaded (has a title),
// has cards, or has study notes — so a freshly created deck with zero cards
// still shows its title/toolbar instead of looking like nothing is loaded.
function hasActiveDeck() {
  return Boolean(state.deckTitle) || state.masterCards.length > 0 || Boolean(state.notes.trim());
}

function updateMeta() {
  const total = state.cards.length;
  const finished = Math.min(state.current, total);
  const hasDeck = hasActiveDeck();
  syncResults();
  updateActiveCardStatusBadges();
  el.deckTitle.textContent = state.deckTitle;
  el.deckTitle.title = state.deckTitle;
  el.deckTitleWrap.hidden = !hasDeck;
  if (el.deckMeta2Row) el.deckMeta2Row.hidden = !hasDeck;
  if (!hasDeck) setSyncIndicator("idle");
  el.editDeckTitleBtn.disabled = !hasDeck;
  if (el.deckCategory) {
    el.deckCategory.textContent = normalizeDeckCategory(state.deckCategory);
    el.deckCategory.title = `Category: ${normalizeDeckCategory(state.deckCategory)}`;
  }
  if (el.editDeckCategoryBtn) {
    el.editDeckCategoryBtn.disabled = !hasDeck;
  }
  el.positionText.textContent = state.previewCard ? "Preview" : total ? `${Math.min(state.current + 1, total)}/${total}` : "0/0";
  el.scoreText.textContent = `Known ${state.known} / Review ${state.review}`;
  const knownPct = total ? (state.results.known.length / state.masterCards.length) * 100 : 0;
  const reviewPct = total ? (state.results.review.length / state.masterCards.length) * 100 : 0;
  const remainingPct = total ? Math.max(0, (finished / total) * 100 - knownPct - reviewPct) : 0;
  if (el.progressKnown) el.progressKnown.style.width = `${knownPct}%`;
  if (el.progressReview) el.progressReview.style.width = `${reviewPct}%`;
  el.progressBar.style.width = `${remainingPct}%`;

  const disabled = !state.previewCard && (total === 0 || state.current >= total);
  el.prevCardBtn.disabled = Boolean(state.previewCard) || total === 0 || state.current <= 0;
  // Next stays enabled on the LAST card — one more step shows the end-of-deck
  // summary (same as swiping/arrow keys); it only disables on the summary itself.
  el.nextCardBtn.disabled = Boolean(state.previewCard) || total === 0 || state.current >= total;
  el.knownBtn.disabled = disabled;
  el.reviewBtn.disabled = disabled;
  el.shuffleBtn.disabled = total < 2;
  el.resetBtn.disabled = total === 0;
  el.allCardsBtn.disabled = state.masterCards.length === 0;
  el.exportBtn.disabled = !hasDeck && state.results.known.length === 0 && state.results.review.length === 0;
  el.replayKnownBtn.disabled = state.results.known.length === 0;
  el.replayReviewBtn.disabled = state.results.review.length === 0;
  el.replayUncategorizedBtn.disabled = uncategorizedCards().length === 0;
  el.replayAllBtn.disabled = state.masterCards.length === 0;
  if (el.viewModeToggle) el.viewModeToggle.hidden = !hasDeck;
  if (el.notesBtn) el.notesBtn.disabled = !hasDeck;
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = !hasDeck || !state.notes.trim();
  if (!hasDeck && state.viewMode === "notes") setViewMode("cards");
}

// ── Deck study notes view ──────────────────────────────────────────
// Notes and Cards are two complementary views of the same deck: study/write
// notes first, then distill them into flashcards (or skip notes entirely).
const quizPanel = document.querySelector(".quiz-panel");

function isNotesEditing() {
  return Boolean(el.notesEdit && !el.notesEdit.hidden);
}

// UI-only exit from notes edit mode. Deliberately does NOT copy the textarea
// into state.notes — the textarea's input listener keeps state in sync while
// typing, and deck-load paths call this after state.notes was already replaced.
function resetNotesEditingUI() {
  if (!isNotesEditing()) return;
  el.notesEdit.hidden = true;
  el.notesView.hidden = false;
  el.notesEditToolbar.hidden = true;
  if (el.notesRenderToolbar) el.notesRenderToolbar.hidden = false;
  el.editNotesBtn.classList.remove("is-editing");
  el.editNotesBtn.title = "Edit notes";
  hideNotesSelectionButton();
}

function commitNotesEditIfActive() {
  if (!isNotesEditing()) return;
  state.notes = el.notesEdit.value;
  resetNotesEditingUI();
  renderMarkdown(el.notesView, state.notes, true).then(() => resetClozeButton(el.clozeToggleNotesBtn));
  scheduleDeckAutosave();
  updateMeta();
}

// `cursorOffset` (raw-markdown character index), when given, places the caret
// there instead of the textarea's default start-of-text position — used by the
// triple-click-to-edit handler below so switching to raw mode doesn't lose your
// place.
function enterNotesEditing(cursorOffset = null) {
  if (!el.notesEdit || isNotesEditing()) return;
  el.notesEdit.value = state.notes;
  el.notesView.hidden = true;
  el.notesEdit.hidden = false;
  el.notesEditToolbar.hidden = false;
  if (el.notesRenderToolbar) el.notesRenderToolbar.hidden = true;
  el.editNotesBtn.classList.add("is-editing");
  el.editNotesBtn.title = "Back to preview";
  if (el.notesTocDrawer?.classList.contains("is-open")) closeNotesToc();
  hideNotesSelectionButton();
  el.notesEdit.dispatchEvent(new Event("input", { bubbles: true }));
  el.notesEdit.focus();
  // Assigning .value leaves the caret at the very end in most browsers, so
  // always place it explicitly — a matched offset when we have one, otherwise
  // the top of the notes. Never let a failed match silently dump you at the end.
  const pos = cursorOffset != null
    ? Math.max(0, Math.min(cursorOffset, el.notesEdit.value.length))
    : 0;
  el.notesEdit.setSelectionRange(pos, pos);
  scrollTextareaToOffset(el.notesEdit, pos);
}

// ── Triple-click a rendered block → raw edit mode, cursor at that spot ──────
// marked/the DOM give no source-position map back to the raw markdown, so this
// is a best-effort text match: grab a short snippet of plain text immediately
// before/after the click inside its block (paragraph/heading/list item/...),
// then locate that snippet in state.notes with a regex tolerant of the
// markdown syntax (**, `, [text](url), etc.) the renderer stripped out around
// it. Returns null on no confident match — the caller just skips the cursor
// hint rather than guessing wrong.
const NOTES_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd";

function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

// Character offset of (node, offset) within root's flattened text — Range
// accepts either a text node + character offset or an element + child index,
// so this works for both kinds of caret target.
function textOffsetWithin(root, node, offset) {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch (_) {
    return null;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Locate `before`+`after` snippets (either may be empty) inside state.notes and
// return the character offset of the seam between them. `allowNewline` lets the
// gap and fuzzified whitespace cross line breaks — essential inside fenced code
// blocks, whose raw markdown keeps the newlines the click snippet spans.
function matchSnippetInNotes(before, after, allowNewline) {
  if (!before && !after) return null;
  // Lazy bounded gap absorbs stripped markdown syntax (a link's
  // `](https://example.com)` tail is full of letters/digits, so a gap of only
  // non-alphanumerics can't skip it). For prose the gap excludes newlines so a
  // short generic fragment can't bridge into an unrelated block; inside code we
  // must allow them so a snippet straddling two code lines still matches.
  const gap = allowNewline ? "[\\s\\S]{0,300}?" : "[^\\n]{0,300}?";
  // Fuzzify: keep alphanumeric runs literal, let every run of punctuation/whitespace
  // in the snippet absorb stripped markdown syntax — not just the one at the click
  // seam. A snippet like "bold text" must also match raw "**bold text**", where the
  // stripped `**` sits mid-snippet (right after "text"), not at the before/after join.
  const fuzzify = (s) => s.split(/([^A-Za-z0-9]+)/).map((part, i) => (i % 2 === 0 ? escapeRe(part) : gap)).join("");
  const pattern = before && after
    ? `(${fuzzify(before)})${gap}(${fuzzify(after)})`
    : `(${fuzzify(before || after)})`;
  try {
    const match = new RegExp(pattern).exec(state.notes);
    if (!match) return null;
    return before ? match.index + match[1].length : match.index;
  } catch (_) {
    return null;
  }
}

function findRawOffsetForRenderedPoint(clientX, clientY) {
  const caret = caretFromPoint(clientX, clientY);
  // Widgets (rendered code fences, cloze/math, images) can swallow the caret or
  // sit outside a text block — fall back to the element under the pointer so the
  // block lookup below can still land us in the right region of the raw notes.
  const anchorNode = caret && el.notesView?.contains(caret.node)
    ? caret.node
    : document.elementFromPoint(clientX, clientY);
  if (!anchorNode || !el.notesView?.contains(anchorNode)) return null;

  const startEl = anchorNode.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
  const block = startEl?.closest?.(NOTES_BLOCK_SELECTOR);
  if (!block || !el.notesView.contains(block)) return null;

  // Code fences render verbatim, so their raw markdown keeps the exact newlines
  // and punctuation the click snippet spans — match across lines for those.
  const isCode = block.tagName === "PRE" || Boolean(startEl.closest("pre, code"));
  const blockText = block.textContent || "";

  // Precise hit: match the text on both sides of the exact click point.
  const localOffset = caret && el.notesView.contains(caret.node)
    ? textOffsetWithin(block, caret.node, caret.offset)
    : null;
  if (localOffset != null) {
    const before = blockText.slice(Math.max(0, localOffset - 24), localOffset).trim();
    const after = blockText.slice(localOffset, localOffset + 24).trim();
    const hit = matchSnippetInNotes(before, after, isCode);
    if (hit != null) return hit;
  }

  // Fallback: we know which block was clicked but not the precise seam (widget,
  // failed fuzzy match, …). Land at the start of that block rather than leaving
  // the caret to snap to the very end of the notes.
  const blockStart = blockText.replace(/^\s+/, "").slice(0, 40).trim();
  return matchSnippetInNotes(blockStart, "", isCode);
}

// setSelectionRange alone doesn't reliably re-scroll a long textarea in every
// browser, so approximate a centered scroll from the line number of `pos`.
function scrollTextareaToOffset(textarea, pos) {
  const before = textarea.value.slice(0, pos);
  const lineIndex = (before.match(/\n/g) || []).length;
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 2);
}

el.notesView?.addEventListener("click", (event) => {
  if (event.detail !== 3 || isNotesEditing()) return;
  if (event.target.closest("button, a")) return;
  enterNotesEditing(findRawOffsetForRenderedPoint(event.clientX, event.clientY));
});

function setViewMode(mode) {
  const next = mode === "notes" ? "notes" : "cards";
  if (!el.notesStage || !el.viewModeToggle) {
    state.viewMode = next;
    return;
  }
  if (next === "cards") resetNotesEditingUI();
  const changed = state.viewMode !== next;
  state.viewMode = next;
  const notesActive = next === "notes";
  quizPanel?.classList.toggle("notes-mode", notesActive);
  el.notesStage.hidden = !notesActive;
  el.viewModeToggle.querySelectorAll("[data-view-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewMode === next);
  });
  hideNotesSelectionButton();
  if (notesActive) {
    renderMarkdown(el.notesView, state.notes, true).then(() => resetClozeButton(el.clozeToggleNotesBtn));
    if (!state.notes.trim()) enterNotesEditing();
  } else if (changed) {
    showCard();
  }
}

el.editNotesBtn?.addEventListener("click", () => {
  if (isNotesEditing()) commitNotesEditIfActive();
  else enterNotesEditing();
});

el.notesEdit?.addEventListener("input", () => {
  state.notes = el.notesEdit.value;
  if (el.exportNotesBtn) el.exportNotesBtn.disabled = !state.notes.trim();
  scheduleDeckAutosave();
});

el.viewModeToggle?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view-mode]");
  if (button) setViewMode(button.dataset.viewMode);
});

el.notesBtn?.addEventListener("click", () => setViewMode("notes"));

// ── Notes table of contents ────────────────────────────────────────
// The rendered notes carry no navigation of their own; long study notes
// become a wall of text. buildNotesToc() scans the freshly rendered
// headings, gives each a stable anchor id, and mirrors them into a
// slide-in drawer (the ☰ hamburger in the notes head). Clicking an entry
// scrolls that heading to the top of the notes viewport, and a scroll-spy
// keeps the entry for the section you're reading highlighted.
let notesTocHeadings = [];
let notesTocScrollFrame = 0;

function slugifyHeading(text, used) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
  let slug = `toc-${base}`;
  let n = 2;
  while (used.has(slug)) slug = `toc-${base}-${n++}`;
  used.add(slug);
  return slug;
}

// Is `depths[i]` the last item among its own sibling group? (No later entry
// at the same depth before the group is closed by something shallower.)
function tocIsLastSibling(depths, i) {
  const depth = depths[i];
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return true;
    if (depths[j] === depth) return false;
  }
  return true;
}

// Does the ancestor guide line at `depth` still have a later sibling coming
// (i.e. should the vertical rail continue straight through this row at that
// column), or has that branch already closed?
function tocGuideContinues(depths, i, depth) {
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < depth) return false;
    if (depths[j] === depth) return true;
  }
  return false;
}

function buildNotesToc() {
  if (!el.notesView || !el.notesTocList) return;
  const used = new Set();
  notesTocHeadings = Array.from(
    el.notesView.querySelectorAll("h1, h2, h3, h4, h5, h6")
  ).filter((h) => h.textContent.trim() !== "");

  el.notesTocList.innerHTML = "";
  const hasHeadings = notesTocHeadings.length > 0;
  if (el.notesTocEmpty) el.notesTocEmpty.hidden = hasHeadings;
  el.notesTocList.hidden = !hasHeadings;

  if (!hasHeadings) {
    if (el.notesTocDrawer && !el.notesTocDrawer.hidden) closeNotesToc();
    if (el.notesTocBtn) el.notesTocBtn.classList.remove("has-toc");
    return;
  }
  if (el.notesTocBtn) el.notesTocBtn.classList.add("has-toc");

  // Normalise the shallowest heading level to depth 0 so notes that start at
  // ## still indent from the left edge rather than looking pushed-in.
  const minLevel = notesTocHeadings.reduce(
    (min, h) => Math.min(min, Number(h.tagName[1])),
    6
  );
  const depths = notesTocHeadings.map((h) => Math.min(Number(h.tagName[1]) - minLevel, 4));

  notesTocHeadings.forEach((heading, index) => {
    if (!heading.id) heading.id = slugifyHeading(heading.textContent, used);
    else used.add(heading.id);
    const level = Number(heading.tagName[1]);
    const depth = depths[index];

    const li = document.createElement("li");
    li.className = "notes-toc-item";
    const link = document.createElement("a");
    link.className = "notes-toc-link";
    link.href = `#${heading.id}`;
    link.dataset.tocIndex = String(index);
    link.style.setProperty("--toc-depth", String(depth));

    // Tree rail: one column per ancestor level, plus an elbow connecting up
    // to the parent chain and across to this item's dot — the last column
    // is a "├" (more siblings follow) or "└" (last child) elbow, columns
    // before it are plain vertical guides that only continue if that
    // ancestor branch still has more siblings coming later in the list.
    let rail = "";
    for (let d = 0; d < depth; d++) {
      if (d === depth - 1) {
        rail += `<span class="notes-toc-elbow" data-last="${tocIsLastSibling(depths, index)}"></span>`;
      } else {
        // Column d represents the ancestor ONE level below it (d+1) — e.g.
        // column 0 for a depth-3 item is its grandparent's level (depth 1),
        // not the root's (depth 0); the root gets no column of its own since
        // depth-0 headings never get a rail at all.
        rail += `<span class="notes-toc-guide" data-state="${tocGuideContinues(depths, index, d + 1) ? "line" : "blank"}"></span>`;
      }
    }

    link.innerHTML =
      (rail ? `<span class="notes-toc-rail" aria-hidden="true">${rail}</span>` : "") +
      `<span class="notes-toc-dot" data-level="${level}"></span>` +
      `<span class="notes-toc-text"></span>`;
    link.querySelector(".notes-toc-text").textContent = heading.textContent.trim();
    li.appendChild(link);
    el.notesTocList.appendChild(li);
  });

  updateNotesTocActive();
}

function scrollNotesHeadingIntoView(heading) {
  if (!heading || !el.notesView) return;
  const viewTop = el.notesView.getBoundingClientRect().top;
  const headTop = heading.getBoundingClientRect().top;
  const target = el.notesView.scrollTop + (headTop - viewTop) - 8;
  el.notesView.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

// Raw-mode counterpart of scrollNotesHeadingIntoView: the rendered notes view is
// hidden while editing, so a TOC click must scroll the textarea instead. The Nth
// TOC entry is the Nth ATX heading in source order (rendering preserves order and
// count), so walk the raw lines — skipping fenced code, where a leading # isn't a
// heading — to the Nth heading and drop the caret on that line.
function scrollNotesEditToHeadingIndex(index) {
  const textarea = el.notesEdit;
  if (!textarea) return;
  const lines = textarea.value.split("\n");
  let inFence = false;
  let fenceChar = "";
  let count = -1;
  let targetLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+\S/.test(line)) {
      count += 1;
      if (count === index) { targetLine = i; break; }
    }
  }
  if (targetLine < 0) return;
  const pos = lines.slice(0, targetLine).reduce((n, l) => n + l.length + 1, 0);
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  scrollTextareaToOffset(textarea, pos);
  // Setting scrollTop programmatically doesn't reliably fire a scroll event in
  // every browser, so nudge the syntax-highlight backdrop to follow.
  textarea.dispatchEvent(new Event("scroll"));
}

function updateNotesTocActive() {
  if (!el.notesTocList || !notesTocHeadings.length) return;
  const viewTop = el.notesView.getBoundingClientRect().top;
  // The active section is the last heading whose top has scrolled to (or above)
  // a line a little below the viewport top.
  let activeIndex = 0;
  notesTocHeadings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top - viewTop <= 24) activeIndex = index;
  });
  el.notesTocList.querySelectorAll(".notes-toc-link").forEach((link) => {
    const on = Number(link.dataset.tocIndex) === activeIndex;
    link.classList.toggle("is-active", on);
    if (on) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  });
}

function openNotesToc() {
  if (!el.notesTocDrawer) return;
  el.notesTocDrawer.hidden = false;
  // Force reflow so the open transition runs from the hidden state.
  void el.notesTocDrawer.offsetWidth;
  el.notesTocDrawer.classList.add("is-open");
  el.notesTocBtn?.classList.add("is-active");
  el.notesTocBtn?.setAttribute("aria-expanded", "true");
  updateNotesTocActive();
}

function closeNotesToc() {
  if (!el.notesTocDrawer) return;
  el.notesTocDrawer.classList.remove("is-open");
  el.notesTocBtn?.classList.remove("is-active");
  el.notesTocBtn?.setAttribute("aria-expanded", "false");
  const drawer = el.notesTocDrawer;
  const hideAfter = () => {
    if (!drawer.classList.contains("is-open")) drawer.hidden = true;
  };
  drawer.addEventListener("transitionend", hideAfter, { once: true });
  // Fallback in case the transition never fires (e.g. reduced motion).
  setTimeout(hideAfter, 260);
}

function toggleNotesToc() {
  if (el.notesTocDrawer?.classList.contains("is-open")) closeNotesToc();
  else openNotesToc();
}

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
  // On narrow screens the drawer overlays the notes, so step out of the way.
  if (window.matchMedia("(max-width: 720px)").matches) closeNotesToc();
});

el.notesView?.addEventListener(
  "scroll",
  () => {
    if (notesTocScrollFrame) return;
    notesTocScrollFrame = requestAnimationFrame(() => {
      notesTocScrollFrame = 0;
      updateNotesTocActive();
    });
  },
  { passive: true }
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el.notesTocDrawer?.classList.contains("is-open")) {
    closeNotesToc();
  }
});

// Clicking anywhere outside the open drawer (including the notes themselves)
// dismisses the TOC. The toggle button is excluded so its own click still
// toggles rather than close-then-reopen.
document.addEventListener("pointerdown", (event) => {
  if (!el.notesTocDrawer?.classList.contains("is-open")) return;
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

// The three faces that support "select text → make a flashcard". Only one is
// ever active at a time: notes while state.viewMode === "notes", question/
// answer while state.viewMode === "cards".
const SELECTION_TARGETS = [
  { name: "notes", view: el.notesView, edit: el.notesEdit, isActive: () => state.viewMode === "notes" },
  { name: "question", view: el.questionView, edit: el.questionEdit, isActive: () => state.viewMode === "cards" },
  { name: "answer", view: el.answerView, edit: el.answerEdit, isActive: () => state.viewMode === "cards" },
];

function isTargetEditing(target) {
  return Boolean(target.edit && !target.edit.hidden);
}

// The active target (if any) currently in raw-edit mode with a live,
// non-collapsed selection in its textarea.
function activeEditingTarget() {
  return (
    SELECTION_TARGETS.find((t) => {
      if (!t.isActive() || !isTargetEditing(t)) return false;
      const { selectionStart, selectionEnd } = t.edit;
      return selectionStart !== selectionEnd;
    }) || null
  );
}

// The active target (if any) whose RENDERED view contains the live selection.
function activeRenderedTarget() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  return (
    SELECTION_TARGETS.find(
      (t) =>
        t.isActive() &&
        !isTargetEditing(t) &&
        t.view &&
        !t.view.hidden &&
        t.view.contains(selection.anchorNode) &&
        t.view.contains(selection.focusNode)
    ) || null
  );
}

let notesSelectionTimer = null;

function hideNotesSelectionButton() {
  if (!el.makeCardFromSelectionBtn) return;
  el.makeCardFromSelectionBtn.hidden = true;
  el.makeCardFromSelectionBtn.dataset.selectionText = "";
}

// The live selection's range, but only when it's a real selection inside the
// given target's rendered view.
function notesSelectionRange(target) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!target?.view || target.view.hidden) return null;
  if (!target.view.contains(selection.anchorNode) || !target.view.contains(selection.focusNode)) return null;
  return selection.getRangeAt(0);
}

// Clone the selected fragment with rendered-markdown UI chrome removed
// (image/diagram Zoom pills, code-block copy buttons, language badges).
function cleanedSelectionFragment(range) {
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());
  container.querySelectorAll("button, .code-lang-badge").forEach((node) => node.remove());
  return container;
}

// If the selection lands inside a rendered code block, rebuild the fence
// directly from the raw selected text and the <code> element's language
// class instead of going through the generic HTML→Markdown conversion —
// Turndown's fenced-block rule only fires when the selection's boundary
// crosses the whole <pre>; a selection that starts/ends *inside* the <code>
// (the common case — dragging across a few lines of a longer block) falls
// through to its inline-code rule instead, which collapses every newline to
// a space and drops the language. Returns null for a non-code selection.
function notesSelectionCodeFence(range, target) {
  const anchor = range.commonAncestorContainer;
  const node = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  const codeEl = node?.closest?.("code");
  if (!codeEl || !target?.view?.contains(codeEl)) return null;
  const raw = range.toString();
  if (!raw.trim()) return null;
  const langMatch = codeEl.className.match(/language-([\w+-]*)/);
  const lang = langMatch ? langMatch[1] : (codeEl.closest("pre")?.dataset.language || "").toLowerCase();
  const trimmed = raw.replace(/^\n+|\n+$/g, "");
  return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
}

// Serialize the notes selection back to MARKDOWN, so images, math, bold text
// etc. survive into the card. selection.toString() would only give plain
// text — for a selected image it literally yields the "Zoom" button label of
// its .diagram-shell wrapper.
function notesSelectionMarkdown(range, target) {
  const codeFence = notesSelectionCodeFence(range, target);
  if (codeFence) return codeFence;
  const fragment = cleanedSelectionFragment(range);
  const markdown = htmlToMarkdown(fragment.innerHTML, { preserveInlineStyles: true }).trim();
  return markdown || fragment.textContent.trim();
}

// If [start, end) in the raw markdown sits inside an existing ```lang fence,
// return its language and body bounds; else null. Used so selecting just the
// inner lines of a code block (not the ``` marker lines themselves) still
// keeps its fence + language when turned into a card.
function findRawCodeFence(value, start, end) {
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  let match;
  while ((match = fenceRe.exec(value))) {
    const bodyStart = match.index + 3 + match[1].length + 1;
    const bodyEnd = bodyStart + match[2].length;
    if (start >= bodyStart && end <= bodyEnd) return { language: match[1].trim() };
  }
  return null;
}

// The raw-textarea equivalent of notesSelectionRange(): plain selected text
// (already markdown source, so no HTML→markdown conversion needed) plus its
// image count, counted from markdown image syntax since there's no DOM to
// query. If the selection is the inner lines of an existing fence (fence
// markers just outside the selected range), re-wraps it in that same fence
// + language so it doesn't turn into unfenced plain text on the new card.
function notesEditSelectionText(target) {
  if (!isTargetEditing(target)) return "";
  const { selectionStart, selectionEnd, value } = target.edit;
  if (selectionStart === selectionEnd) return "";
  const raw = value.slice(selectionStart, selectionEnd);
  if (/^```/.test(raw.trim())) return raw;
  const fence = findRawCodeFence(value, selectionStart, selectionEnd);
  return fence ? `\`\`\`${fence.language}\n${raw}\n\`\`\`` : raw;
}

// The current selection's markdown, regardless of which face (notes,
// question, answer) is active and whether it's viewed (rendered) or edited
// (raw) — shared by the floating pill and the persistent header buttons.
function currentNotesSelectionMarkdown() {
  const editingTarget = activeEditingTarget();
  if (editingTarget) return notesEditSelectionText(editingTarget).trim();
  const renderedTarget = activeRenderedTarget();
  if (!renderedTarget) return "";
  const range = notesSelectionRange(renderedTarget);
  return range ? notesSelectionMarkdown(range, renderedTarget) : "";
}

function scheduleNotesSelectionCheck() {
  if (notesSelectionTimer) clearTimeout(notesSelectionTimer);
  notesSelectionTimer = setTimeout(positionNotesSelectionButton, 160);
}

// Textareas have no native API for "where on screen is this selection" (the
// rendered view gets that for free from Range.getBoundingClientRect()) — this
// is the standard workaround: clone the textarea's box/font metrics into an
// offscreen mirror div, split its text at the selection boundaries with
// marker spans, and read the spans' positions back out. Returns a viewport-
// relative rect, same shape as getBoundingClientRect().
function textareaSelectionRect(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textTransform", "wordSpacing", "tabSize", "wordBreak",
  ].forEach((prop) => { mirror.style[prop] = style[prop]; });
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.height = "auto";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  const markerStart = document.createElement("span");
  markerStart.textContent = "​";
  const markerEnd = document.createElement("span");
  markerEnd.textContent = "​";
  mirror.append(
    document.createTextNode(value.slice(0, selectionStart)),
    markerStart,
    document.createTextNode(value.slice(selectionStart, selectionEnd)),
    markerEnd,
    document.createTextNode(value.slice(selectionEnd))
  );
  document.body.appendChild(mirror);

  const textareaRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const startRect = markerStart.getBoundingClientRect();
  const endRect = markerEnd.getBoundingClientRect();
  mirror.remove();

  const toViewport = (r) => ({
    top: textareaRect.top + (r.top - mirrorRect.top) - textarea.scrollTop,
    bottom: textareaRect.top + (r.bottom - mirrorRect.top) - textarea.scrollTop,
    left: textareaRect.left + (r.left - mirrorRect.left) - textarea.scrollLeft,
    right: textareaRect.left + (r.right - mirrorRect.left) - textarea.scrollLeft,
  });
  const start = toViewport(startRect);
  const end = toViewport(endRect);
  return {
    top: Math.min(start.top, end.top),
    bottom: Math.max(start.bottom, end.bottom),
    left: Math.min(start.left, end.left),
    right: Math.max(start.right, end.right),
  };
}

// On narrow/touch screens, reaching past the visible edge of a big selection
// means dragging a handle until the view auto-scrolls (or scrolling by hand
// mid-selection) — the selection's bounding rect then spans more than one
// screen, and pinning the button to its top/bottom edge can put it anywhere
// from the very top of the screen to the very bottom depending on which edge
// is currently on-screen. Anchor it to a fixed spot instead: always the same
// thumb-reachable place, regardless of how big the selection is or where it
// scrolled to. Desktop keeps the precise follow-the-selection positioning
// below, since dragging with a mouse doesn't hit the same problem.
function pinSelectionButtonToBottom(button) {
  button.style.top = "";
  button.style.left = "";
  button.classList.add("is-pinned-bottom");
}

function positionNotesSelectionButton() {
  const button = el.makeCardFromSelectionBtn;
  if (!button) return;
  const mobile = Boolean(styleMobileMedia?.matches);
  if (!mobile) button.classList.remove("is-pinned-bottom");

  const editingTarget = activeEditingTarget();
  if (editingTarget) {
    const raw = notesEditSelectionText(editingTarget);
    const text = raw.trim();
    if (!text) {
      hideNotesSelectionButton();
      return;
    }
    button.dataset.selectionText = text;
    const words = text.split(/\s+/).filter(Boolean).length;
    const imageMatches = text.match(/!\[[^\]]*\]\([^)]*\)/g) || [];
    const parts = [];
    if (words) parts.push(`${words} word${words === 1 ? "" : "s"}`);
    if (imageMatches.length) parts.push(imageMatches.length === 1 ? "1 image" : `${imageMatches.length} images`);
    button.textContent = `+ Make card · ${parts.join(" + ")}`;
    button.hidden = false;
    if (mobile) return pinSelectionButtonToBottom(button);
    // Track the actual selection (same approach as the rendered-view branch
    // below) instead of parking in the textarea's corner regardless of where
    // the selection actually is.
    const selRect = textareaSelectionRect(editingTarget.edit);
    const editRect = editingTarget.edit.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const margin = 8;
    let top = selRect.bottom + margin;
    if (top + btnRect.height > window.innerHeight - margin) {
      top = Math.max(margin, selRect.top - btnRect.height - margin);
    }
    top = Math.min(Math.max(top, editRect.top + margin), editRect.bottom - btnRect.height - margin);
    const left = Math.min(
      Math.max(margin, selRect.left + (selRect.right - selRect.left) / 2 - btnRect.width / 2),
      window.innerWidth - btnRect.width - margin
    );
    button.style.top = `${top}px`;
    button.style.left = `${Math.max(margin, left)}px`;
    return;
  }

  const renderedTarget = activeRenderedTarget();
  const range = renderedTarget ? notesSelectionRange(renderedTarget) : null;
  const fragment = range ? cleanedSelectionFragment(range) : null;
  const text = fragment ? fragment.textContent.trim() : "";
  const imageCount = fragment ? fragment.querySelectorAll("img").length : 0;
  if (!text && !imageCount) {
    hideNotesSelectionButton();
    return;
  }
  // Capture the selection as markdown now: tapping the button may dissolve
  // the selection before the click handler runs.
  button.dataset.selectionText = notesSelectionMarkdown(range, renderedTarget);
  // Show how much is being captured, so the selection size is obvious.
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const parts = [];
  if (words) parts.push(`${words} word${words === 1 ? "" : "s"}`);
  if (imageCount) parts.push(imageCount === 1 ? "1 image" : `${imageCount} images`);
  button.textContent = `+ Make card · ${parts.join(" + ")}`;
  button.hidden = false;
  if (mobile) return pinSelectionButtonToBottom(button);
  const rect = range.getBoundingClientRect();
  const btnRect = button.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + margin;
  if (top + btnRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - btnRect.height - margin);
  }
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - btnRect.width / 2),
    window.innerWidth - btnRect.width - margin
  );
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
}

function addCardFromNotes(question, answer, noteAnchor = null) {
  const card = {
    // Random suffix: bare Date.now() collides when cards are created from
    // several selections in quick succession.
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer
  };
  // Remember where in these notes the answer came from, so the card can offer
  // a "Go to notes" jump back to that exact spot (see resolveCardNoteAnchor /
  // jumpToNoteForCurrentCard). Only cards distilled from a notes selection get
  // this; a selection made in a card face passes null.
  if (noteAnchor && (noteAnchor.text || noteAnchor.source)) card.noteAnchor = noteAnchor;
  const refreshActive = activeDeckMatchesMasterOrder();
  state.masterCards.push(card);
  if (refreshActive) state.cards.push(card);
  syncResults();
  updateMeta();
  scheduleDeckAutosave();
  showToast(`Card added · ${state.masterCards.length} total`);
  setStatus(state.deckId ? "Card added from notes locally. Sync to update the web deck." : "Card added from notes.");
}

function createCardFromNotesSelection(markdown, noteAnchor = null) {
  // The highlighted fact is what you want to recall — it becomes the ANSWER;
  // the user frames the question that should bring it to mind. The modal
  // shows exactly what was captured (rendered, images included) so there's
  // no doubt about the selection, and gives a proper textarea to write in.
  const answer = String(markdown || "").trim();
  if (!answer || !el.frameCardModal) return;

  el.frameCardModal.hidden = false;
  lockPageScroll();
  renderMarkdown(el.frameCardAnswerPreview, answer, true);
  el.frameCardQuestionInput.value = "";
  requestAnimationFrame(() => el.frameCardQuestionInput.focus());

  const cleanup = (confirmed) => {
    el.frameCardModal.hidden = true;
    unlockPageScroll();
    el.frameCardAddBtn.onclick = null;
    el.frameCardCancelBtn.onclick = null;
    el.frameCardQuestionInput.onkeydown = null;
    if (!confirmed) return;
    const question = el.frameCardQuestionInput.value.trim();
    if (!question) {
      // Blank-question cards are dropped by loadDeckSnapshot on the next
      // load, so keeping one would silently lose it anyway.
      setStatus("Card not added — a question is required.", "error");
      return;
    }
    addCardFromNotes(question, answer, noteAnchor);
  };
  el.frameCardAddBtn.onclick = () => cleanup(true);
  el.frameCardCancelBtn.onclick = () => cleanup(false);
  el.frameCardQuestionInput.onkeydown = (e) => {
    // Plain Enter inserts a newline (questions can be multi-line);
    // Ctrl/Cmd+Enter confirms, Escape cancels.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cleanup(true); }
    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
  };
}

// ── Card ⇄ Notes linking ───────────────────────────────────────────────────
// A card distilled from a notes selection remembers where it came from
// (captureNotesAnchor at creation time), and offers a "Go to notes" button
// that switches to the notes view and scrolls/flashes that exact spot
// (jumpToNoteForCurrentCard). The link survives note edits and cloud round-
// trips: an explicit anchor is stored on the card when possible, and cards
// that lost it (e.g. reloaded from a pre-feature cloud row) fall back to
// matching their answer text against the current notes.

// Strip markdown syntax down to the plain text a reader sees — used both to
// build a searchable anchor snippet and to match a card's answer against the
// rendered notes for the content fallback.
function notesAnchorPlainText(src) {
  return String(src || "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, "").replace(/```/g, "")) // code fences → inner text
    .replace(/`([^`]*)`/g, "$1")                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // links → label
    .replace(/\{\{|\}\}/g, "")                   // cloze braces
    .replace(/[*_~>#]+/g, "")                    // inline emphasis / heading / quote markers
    .replace(/\s+/g, " ")
    .trim();
}

// Snapshot of where the current NOTES selection sits, captured while the
// selection is still live. Returns null for a selection made anywhere other
// than the notes surface (so cards framed from a card face aren't note-linked).
function captureNotesAnchor() {
  const notes = state.notes || "";
  if (!notes.trim()) return null;
  const notesTarget = SELECTION_TARGETS[0]; // { name: "notes", ... }
  if (state.viewMode !== "notes") return null;

  // Raw editor: exact character offsets are available directly.
  if (isTargetEditing(notesTarget)) {
    const { selectionStart, selectionEnd } = notesTarget.edit;
    if (selectionStart === selectionEnd) return null;
    const source = notes.slice(selectionStart, selectionEnd);
    const text = notesAnchorPlainText(source);
    if (!source.trim() && !text) return null;
    return { offset: selectionStart, source: source.slice(0, 400), text: text.slice(0, 400) };
  }

  // Rendered view: locate the selection back in the markdown source for an
  // offset hint; the plain text is the reliable key for re-finding it.
  const range = notesSelectionRange(notesTarget);
  if (!range) return null;
  const sel = renderedSelectionStrings(notesTarget.view);
  const plain = (range.toString() || (sel && sel.asText) || "").trim();
  let offset = null;
  let source = "";
  if (sel) {
    const loc = locateSelectionInSource(notes, sel);
    if (loc) {
      offset = loc.idx;
      source = notes.slice(loc.idx, loc.end);
    }
  }
  if (!plain && !source) return null;
  return { offset, source: source.slice(0, 400), text: plain.slice(0, 400) };
}

// Like captureNotesAnchor, but tags the anchor with the deck the notes belong
// to — so a card stored in a DIFFERENT deck (a quick_notes pin) can navigate
// back to the right deck first before searching its notes.
function captureSourceAnchor() {
  const anchor = captureNotesAnchor();
  if (!anchor) return null;
  anchor.deckLocalId = state.localDeckId || null;
  anchor.deckId = state.deckId || null;
  anchor.deckTitle = state.deckTitle || "";
  return anchor;
}

// The note anchor to use for a card: its stored anchor, or a content fallback
// when the card's answer text still appears in the notes. Returns null when
// there's nothing to link to.
function resolveCardNoteAnchor(card) {
  if (!card) return null;
  const stored = card.noteAnchor;
  if (stored && (stored.text || stored.source)) {
    // A cross-deck anchor (e.g. a quick_notes pin) points at ANOTHER deck's
    // notes — trust it unconditionally; jumpToNoteForCurrentCard loads that
    // deck before searching. A same-deck anchor only earns the button when this
    // deck actually has notes to jump into.
    if (stored.deckLocalId || stored.deckId) return stored;
    return (state.notes || "").trim() ? stored : null;
  }
  // Content fallback (same deck only): the answer's text still sits in the notes.
  const notes = state.notes || "";
  if (!notes.trim()) return null;
  const plain = notesAnchorPlainText(card.answer);
  if (plain.length < 12) return null;
  if (notesAnchorPlainText(notes).includes(plain)) return { offset: null, source: "", text: plain };
  return null;
}

function cardHasNoteLink(card) {
  return Boolean(resolveCardNoteAnchor(card));
}

// Character index of the anchor within raw state.notes (for raw-editor jumps),
// or null if it can't be found.
function resolveRawNoteIndex(anchor) {
  const notes = state.notes || "";
  const needle = anchor.source || anchor.text;
  if (!needle) return null;
  if (anchor.offset != null && notes.slice(anchor.offset, anchor.offset + needle.length) === needle) {
    return anchor.offset;
  }
  let idx = notes.indexOf(needle);
  if (idx === -1 && anchor.text) idx = notes.indexOf(anchor.text);
  return idx === -1 ? null : idx;
}

// Build a DOM Range spanning the anchor text inside the rendered notes view, so
// it can be scrolled to and flashed. Falls back to a shorter prefix when the
// full selection can't be matched verbatim (e.g. the notes were edited since).
function findRenderedNoteRange(anchor) {
  const view = el.notesView;
  const needle = (anchor.text || "").trim();
  if (!view || !needle) return null;

  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  const segments = [];
  let full = "";
  let node;
  while ((node = walker.nextNode())) {
    segments.push({ node, start: full.length });
    full += node.textContent;
  }
  if (!segments.length) return null;

  let matchStart = full.indexOf(needle);
  let matchLen = needle.length;
  if (matchStart === -1) {
    // The rendered text collapses source whitespace differently — retry with a
    // short prefix, which is far likelier to survive verbatim.
    const prefix = needle.slice(0, 40).trim();
    matchStart = prefix ? full.indexOf(prefix) : -1;
    if (matchStart === -1) return null;
    matchLen = prefix.length;
  }
  const matchEnd = matchStart + matchLen;

  const locate = (pos) => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (pos >= segments[i].start) {
        return { node: segments[i].node, offset: pos - segments[i].start };
      }
    }
    return { node: segments[0].node, offset: 0 };
  };

  try {
    const s = locate(matchStart);
    const e = locate(matchEnd);
    const range = document.createRange();
    range.setStart(s.node, Math.min(s.offset, s.node.textContent.length));
    range.setEnd(e.node, Math.min(e.offset, e.node.textContent.length));
    return range;
  } catch (_) {
    return null;
  }
}

// Scroll to the anchor and briefly flash it. Handles both rendered and raw
// notes. Returns true when it found and revealed the spot.
function revealNoteAnchor(anchor) {
  const notesTarget = SELECTION_TARGETS[0];
  if (isTargetEditing(notesTarget)) {
    const idx = resolveRawNoteIndex(anchor);
    if (idx == null) return false;
    const len = Math.max(1, (anchor.source || anchor.text || "").length);
    const edit = notesTarget.edit;
    edit.focus();
    edit.setSelectionRange(idx, idx + len);
    scrollTextareaToOffset(edit, idx);
    return true;
  }

  const range = findRenderedNoteRange(anchor);
  if (!range) return false;
  const startEl = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const block = startEl?.closest?.(NOTES_BLOCK_SELECTOR) || startEl;
  (block || el.notesView).scrollIntoView({ behavior: "smooth", block: "center" });
  // The browser's own selection highlight makes the exact span obvious; the
  // block flash draws the eye there first.
  const sel = window.getSelection();
  sel?.removeAllRanges();
  try { sel?.addRange(range); } catch (_) {}
  if (block && block.classList) {
    block.classList.add("note-anchor-flash");
    setTimeout(() => block.classList.remove("note-anchor-flash"), 1800);
  }
  return true;
}

// Switch to the notes view (if needed) and reveal the anchor. setViewMode
// re-renders the notes markdown asynchronously, so retry across a few frames
// before giving up. Two rAFs cover the initial render; the timeout loop is a
// belt-and-braces fallback for slower renders / a just-loaded deck.
function scheduleNoteJump(anchor) {
  if (state.viewMode !== "notes") setViewMode("notes");
  const attempt = (retries) => {
    if (revealNoteAnchor(anchor)) return;
    if (retries > 0) setTimeout(() => attempt(retries - 1), 120);
    else setStatus("Couldn't find that spot in the notes — it may have been edited.", "info");
  };
  requestAnimationFrame(() => requestAnimationFrame(() => attempt(8)));
}

// True when the currently-loaded deck is the one this anchor came from (so no
// deck switch is needed before jumping).
function onAnchorSourceDeck(anchor) {
  if (anchor.deckLocalId) return anchor.deckLocalId === state.localDeckId;
  if (anchor.deckId) return anchor.deckId === state.deckId;
  return true; // no deck tag = same deck by construction (in-deck make-card)
}

function jumpToNoteForCurrentCard() {
  const card = state.cards[state.current];
  const anchor = resolveCardNoteAnchor(card);
  if (!anchor) {
    setStatus("This card isn't linked to a spot in the notes.", "error");
    return;
  }

  if (onAnchorSourceDeck(anchor)) {
    scheduleNoteJump(anchor);
    return;
  }

  // Cross-deck anchor (quick_notes pin): open the source deck first, then jump.
  // The deck loaders record the back history themselves — nothing to do here.
  setStatus("Opening the source deck…");
  if (anchor.deckLocalId && loadDeckFromLibrary(anchor.deckLocalId)) {
    scheduleNoteJump(anchor);
    return;
  }
  if (anchor.deckId && supabaseClient && navigator.onLine) {
    loadWebDeck(anchor.deckId)
      .then(() => scheduleNoteJump(anchor))
      .catch(() => setStatus("Couldn't open the source deck for this note.", "error"));
    return;
  }
  setStatus("Couldn't open the source deck for this note — it isn't available on this device.", "error");
}

document.addEventListener("selectionchange", scheduleNotesSelectionCheck);

// On mobile the button is pinned to a fixed spot at the bottom of the screen
// (see pinSelectionButtonToBottom) rather than tracking the selection's own
// position, precisely so that scrolling — the normal way to extend a
// selection past the visible edge — doesn't make it disappear. Desktop keeps
// hiding it on scroll, since there its position is tied to the selection rect
// and would otherwise go stale.
function hideNotesSelectionButtonUnlessPinned() {
  if (styleMobileMedia?.matches) return;
  hideNotesSelectionButton();
}

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

[el.notesView, el.questionView, el.answerView].forEach((view) => {
  view?.addEventListener("scroll", hideNotesSelectionButtonUnlessPinned, { passive: true });
});

// Persistent alternative to the floating pill (which only appears while a
// selection is live) — sits in each face's header and works from whatever
// text is currently selected there, rendered or raw, when tapped.
function wireMakeCardButton(button, label) {
  button?.addEventListener("click", () => {
    const text = currentNotesSelectionMarkdown();
    if (!text) {
      setStatus(`Select some text in ${label} first, then tap this to turn it into a card.`, "error");
      return;
    }
    const anchor = captureNotesAnchor();
    hideNotesSelectionButton();
    window.getSelection()?.removeAllRanges();
    createCardFromNotesSelection(text, anchor);
  });
}
wireMakeCardButton(el.makeCardFromNotesBtn, "your notes");
wireMakeCardButton(el.makeCardFromQuestionBtn, "the question");
wireMakeCardButton(el.makeCardFromAnswerBtn, "the answer");

// ── Make a cloze from a rendered-view text selection ───────────────────────
// Clozes ({{…}}) can be authored in the raw editor, but it's far quicker to
// highlight the word(s) you want to hide right in the rendered card or notes
// and press the header "make cloze" button ([…]). We find the highlighted text
// in the underlying markdown SOURCE and wrap it in {{ }} — or unwrap it if it
// was already a cloze (a toggle, matching the editor's [{…}] button) — then
// re-render and save. No need to drop into edit mode.

// The current selection inside `view`, captured both as markdown (so inline
// bold/math/etc. survive) and as plain text — either may be the string that
// appears verbatim in the source. Returns null when there's no live selection
// inside this rendered view.
function renderedSelectionStrings(view) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!view || view.hidden) return null;
  const range = selection.getRangeAt(0);
  if (!view.contains(range.commonAncestorContainer)) return null;
  const fragment = cleanedSelectionFragment(range);
  const asText = fragment.textContent.trim();
  let asMarkdown = "";
  try {
    asMarkdown = htmlToMarkdown(fragment.innerHTML, { preserveInlineStyles: true }).trim();
  } catch { asMarkdown = ""; }
  if (!asText && !asMarkdown) return null;
  // Which occurrence of the plain-text selection this is within the rendered
  // view — i.e. how many identical copies precede it. Without this a repeated
  // word (e.g. "the") would always cloze the FIRST copy in the source, not the
  // one you highlighted, so the toast says "Cloze added" while your selection
  // visibly stays put. 0 = first occurrence, so a match is still found even if
  // this measurement is off.
  let occurrence = 0;
  if (asText) {
    try {
      const pre = document.createRange();
      pre.setStart(view, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      occurrence = countOccurrences(pre.toString(), asText);
    } catch { occurrence = 0; }
  }
  return { asText, asMarkdown, occurrence };
}

// Non-overlapping count of `needle` in `haystack`.
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// Index of the n-th (0-based) occurrence of `needle`, or -1 if there are fewer.
function nthIndexOf(haystack, needle, n) {
  let idx = -1;
  for (let i = 0; i <= n; i += 1) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

// Locate the SELECTED occurrence of a rendered selection inside the markdown
// source. Targets `sel.occurrence` (the copy the user actually highlighted)
// rather than blindly the first match, so repeated words act in place. Tries
// the plain text first (occurrence-aware); falls back to the markdown
// serialization (so a selected image / math / bold run that isn't present
// verbatim as plain text still matches). Returns { idx, end, needle } or null
// when the selection can't be located at all (e.g. it spans block boundaries).
function locateSelectionInSource(source, sel) {
  const attempts = [];
  if (sel.asText) attempts.push({ needle: sel.asText, occurrence: sel.occurrence || 0 });
  if (sel.asMarkdown && sel.asMarkdown !== sel.asText) attempts.push({ needle: sel.asMarkdown, occurrence: 0 });

  for (const { needle, occurrence } of attempts) {
    let idx = nthIndexOf(source, needle, occurrence);
    if (idx === -1) idx = source.indexOf(needle); // occurrence miscounted → first match
    if (idx === -1) continue;
    return { idx, end: idx + needle.length, needle };
  }
  return null;
}

// Wrap the located occurrence in {{ }} — or strip the braces if it's already
// exactly a cloze. Returns { text, action } or null when the selection can't be
// located in the source (the user can still use the raw editor).
function clozeToggleInSource(source, sel) {
  const loc = locateSelectionInSource(source, sel);
  if (!loc) return null;
  const { idx, end, needle } = loc;
  // Already exactly wrapped in {{ }}? Toggle the cloze off.
  if (source.slice(Math.max(0, idx - 2), idx) === "{{" && source.slice(end, end + 2) === "}}") {
    return { text: source.slice(0, idx - 2) + needle + source.slice(end + 2), action: "removed" };
  }
  // Sub-selection inside a larger existing cloze (an unclosed {{ precedes the
  // match, with a }} still to come): wrapping it would nest clozes and break
  // rendering. Report it as already hidden instead.
  const before = source.slice(0, idx);
  if (before.lastIndexOf("{{") > before.lastIndexOf("}}") && source.indexOf("}}", end) !== -1) {
    return { text: source, action: "already" };
  }
  return { text: source.slice(0, idx) + "{{" + needle + "}}" + source.slice(end), action: "added" };
}

// Shared driver for the three "make cloze from selection" header buttons.
function makeClozeFromSelection({ view, label, getSource, setSource, rerender }) {
  const sel = renderedSelectionStrings(view);
  if (!sel) {
    setStatus(`Select some text in the ${label} first, then tap […] to hide it as a cloze.`, "error");
    return;
  }
  const result = clozeToggleInSource(getSource(), sel);
  if (!result) {
    setStatus("Couldn't match that selection in the source — try selecting whole words, or use the editor to place the {{cloze}}.", "error");
    return;
  }
  if (result.action === "already") {
    showToast("That text is already inside a cloze", "info");
    return;
  }
  setSource(result.text);
  window.getSelection()?.removeAllRanges();
  rerender();
  scheduleDeckAutosave();
  showToast(result.action === "removed" ? "Cloze removed" : "Cloze added");
}

// Persist a question/answer edit to both the active deck and the master list
// (mirrors the save path in toggleEditMode / commitEditIfActive).
function setCurrentCardField(side, value) {
  const card = state.cards[state.current];
  if (!card) return;
  if (side === "question") card.question = value;
  else card.answer = value;
  const masterIndex = state.masterCards.findIndex((c) => c.id === card.id);
  if (masterIndex > -1) {
    if (side === "question") state.masterCards[masterIndex].question = value;
    else state.masterCards[masterIndex].answer = value;
  }
}

// One place that knows, for each rendered surface (card question/answer, notes),
// its view element, how to read/write its markdown source, how to re-render, and
// whether it's currently in raw-edit mode. Shared by the header cloze buttons
// and the rendered-view formatting toolbar so both stay in lock-step.
function renderTargetConfig(target) {
  if (target === "notes") {
    return {
      view: el.notesView,
      label: "notes",
      isEditing: () => isNotesEditing(),
      getSource: () => state.notes,
      setSource: (v) => {
        state.notes = v;
        if (el.notesEdit) el.notesEdit.value = v;
      },
      rerender: () =>
        renderMarkdown(el.notesView, state.notes, true).then(() => resetClozeButton(el.clozeToggleNotesBtn)),
    };
  }
  const side = target === "answer" ? "answer" : "question";
  const view = side === "question" ? el.questionView : el.answerView;
  return {
    view,
    label: side,
    // The rendered view is hidden (edit mode) or there's simply no card.
    isEditing: () => !state.cards[state.current] || !view || view.hidden,
    getSource: () => state.cards[state.current]?.[side] || "",
    setSource: (v) => setCurrentCardField(side, v),
    rerender: () =>
      renderMarkdown(view, state.cards[state.current]?.[side] || "", true).then(() => {
        if (side === "question") scheduleLiveQuestionFit();
        resetClozeButton(el.clozeToggleBtn);
      }),
  };
}

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

// Text-colour palette mirrors the editor toolbar's; highlight uses soft tints
// that stay legible behind dark text.
const RENDER_TEXT_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#f59e0b" },
  { name: "Green", value: "#10b981" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Accent", value: "var(--accent-strong)" },
  { name: "White", value: "#ffffff" },
  { name: "Gray", value: "#9ca3af" },
];
const RENDER_HIGHLIGHT_COLORS = [
  { name: "Yellow", value: "#fde68a" },
  { name: "Green", value: "#bbf7d0" },
  { name: "Blue", value: "#bfdbfe" },
  { name: "Pink", value: "#fbcfe8" },
  { name: "Orange", value: "#fed7aa" },
  { name: "Purple", value: "#e9d5ff" },
  { name: "Teal", value: "#99f6e4" },
  { name: "Gray", value: "#e5e7eb" },
];

// The currently-chosen default for each split-button's one-click apply. Persisted
// so it survives reloads; seeded from the first palette swatch.
const renderFormatDefaults = {
  color: localStorage.getItem("recall:renderColorDefault") || RENDER_TEXT_COLORS[0].value,
  highlight: localStorage.getItem("recall:renderHighlightDefault") || RENDER_HIGHLIGHT_COLORS[0].value,
};

function renderSplitControlHtml(prop, glyph, label, swatches) {
  const items = swatches
    .map(
      (c) =>
        `<button type="button" class="render-swatch-btn" data-render-color="${c.value}" data-render-prop="${prop}" style="--sw:${c.value};" title="${c.name}"></button>`
    )
    .join("");
  return `
    <span class="render-split" data-render-split="${prop}">
      <button type="button" class="render-btn render-split-main" data-render-action="${prop}-apply" title="Apply ${label} (current default)">${glyph}</button>
      <button type="button" class="render-btn render-split-side" data-render-action="${prop}-menu" title="Choose ${label}" aria-haspopup="true" aria-expanded="false"><span class="render-swatch" data-render-swatch="${prop}"></span><span class="render-caret" aria-hidden="true">▾</span></button>
      <div class="render-color-menu" data-render-menu="${prop}" hidden>
        ${items}
        <button type="button" class="render-swatch-clear" data-render-color="clear" data-render-prop="${prop}" title="Remove ${label}">Clear</button>
      </div>
    </span>`;
}

function createRenderToolbarHtml() {
  return `
    <button type="button" class="render-btn" data-render-action="bold" title="Bold"><b>B</b></button>
    <button type="button" class="render-btn" data-render-action="italic" title="Italic"><i>I</i></button>
    <button type="button" class="render-btn" data-render-action="underline" title="Underline"><u>U</u></button>
    <button type="button" class="render-btn" data-render-action="strikethrough" title="Strikethrough"><s>S</s></button>
    <button type="button" class="render-btn" data-render-action="code" title="Inline code"><code>&lt;/&gt;</code></button>
    ${renderSplitControlHtml("color", "🎨", "text colour", RENDER_TEXT_COLORS)}
    ${renderSplitControlHtml("highlight", "🖍️", "highlight", RENDER_HIGHLIGHT_COLORS)}
    <button type="button" class="render-btn make-cloze-btn" data-render-action="cloze" title="Cloze — hide the selection as a fill-in-the-blank">[&hellip;]</button>
    <span class="edit-toolbar-divider" aria-hidden="true"></span>
    <button type="button" class="render-btn render-quick-note" data-render-action="quick-note" title="Save selection to the quick_notes deck">📌</button>`;
}

// Paint the little swatch on each split-button's side control to the current
// default colour, so you can see what a one-click apply will use.
function refreshRenderSwatches() {
  document.querySelectorAll('[data-render-swatch="color"]').forEach((s) => {
    s.style.background = renderFormatDefaults.color;
  });
  document.querySelectorAll('[data-render-swatch="highlight"]').forEach((s) => {
    s.style.background = renderFormatDefaults.highlight;
  });
}

function initRenderToolbars() {
  [el.questionRenderToolbar, el.answerRenderToolbar, el.notesRenderToolbar].forEach((tb) => {
    if (tb) tb.innerHTML = createRenderToolbarHtml();
  });
  refreshRenderSwatches();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initRenderToolbars);
} else {
  initRenderToolbars();
}

function closeAllRenderMenus() {
  document.querySelectorAll(".render-color-menu").forEach((m) => (m.hidden = true));
  document.querySelectorAll(".render-split-side").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

// When the located text is exactly the inner content of a <span style="…">…
// </span>, return the range of the WHOLE span. Colour/highlight/clear then see
// the entire span (via matchWholeStyleSpan) so they merge a new property in or
// strip one, instead of nesting yet another span around the inner text.
function enclosingStyleSpan(source, idx, end) {
  const open = /<span style="[^"]*">$/.exec(source.slice(0, idx));
  if (!open) return null;
  if (!source.slice(end).startsWith("</span>")) return null;
  return { start: idx - open[0].length, end: end + "</span>".length };
}

// Core engine: apply a raw-editor transform fn to the selected occurrence in the
// source, then persist + re-render. `formatFn(value, start, end)` returns either
// a replacement string for [start,end) or a { text, rangeStart, rangeEnd } range
// object — exactly the shape the editor toolbar's fns already return. Pass
// { expandStyleSpan: true } (colour/highlight) so an existing style span around
// the selection is merged into rather than nested.
function applyRenderFormat(config, formatFn, opts = {}) {
  if (config.isEditing()) {
    setStatus(`Switch the ${config.label} to preview to format a selection there.`, "error");
    return;
  }
  const sel = renderedSelectionStrings(config.view);
  if (!sel) {
    setStatus(`Select some text in the ${config.label} first, then tap a formatting button.`, "error");
    return;
  }
  const source = config.getSource();
  const loc = locateSelectionInSource(source, sel);
  if (!loc) {
    setStatus("Couldn't match that selection in the source — try selecting whole words, or use the editor.", "error");
    return;
  }
  let { idx, end } = loc;
  if (opts.expandStyleSpan) {
    const span = enclosingStyleSpan(source, idx, end);
    if (span) {
      idx = span.start;
      end = span.end;
    }
  }
  const result = formatFn(source, idx, end);
  const isRange = result && typeof result === "object";
  const replacement = isRange ? result.text : result;
  const rangeStart = isRange ? result.rangeStart : idx;
  const rangeEnd = isRange ? result.rangeEnd : end;
  config.setSource(source.substring(0, rangeStart) + replacement + source.substring(rangeEnd));
  window.getSelection()?.removeAllRanges();
  config.rerender();
  scheduleDeckAutosave();
}

const RENDER_INLINE_FORMATS = {
  bold: (v, s, e) => toggleWrap(v, s, e, "**"),
  italic: (v, s, e) => toggleWrap(v, s, e, "*"),
  underline: (v, s, e) => toggleUnderline(v, s, e),
  strikethrough: (v, s, e) => toggleStrikethrough(v, s, e),
  code: (v, s, e) => toggleCode(v, s, e),
};

function applyRenderColor(config, prop, value) {
  const property = prop === "highlight" ? "background-color" : "color";
  const formatFn =
    value === "clear"
      ? (v, s, e) => clearInlineStyleProperty(v.slice(s, e), property)
      : (v, s, e) => applyInlineStyleProperty(v.slice(s, e), property, value);
  applyRenderFormat(config, formatFn, { expandStyleSpan: true });
}

function setRenderDefault(prop, value) {
  if (value === "clear") return; // "clear" is an action, never a default
  renderFormatDefaults[prop] = value;
  try { localStorage.setItem(prop === "highlight" ? "recall:renderHighlightDefault" : "recall:renderColorDefault", value); } catch (_) {}
  refreshRenderSwatches();
}

function handleRenderToolbarAction(btn, toolbar) {
  const target = toolbar.dataset.renderTarget;
  const config = renderTargetConfig(target);
  const action = btn.dataset.renderAction;
  const colorVal = btn.dataset.renderColor;

  // Open/close a split-button's colour menu.
  if (action === "color-menu" || action === "highlight-menu") {
    const prop = action.slice(0, action.indexOf("-"));
    const menu = toolbar.querySelector(`.render-color-menu[data-render-menu="${prop}"]`);
    const willOpen = menu && menu.hidden;
    closeAllRenderMenus();
    if (menu && willOpen) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    }
    return;
  }

  // A swatch (or Clear) inside a menu: set it as the new default, then apply.
  if (colorVal !== undefined) {
    const prop = btn.dataset.renderProp;
    closeAllRenderMenus();
    setRenderDefault(prop, colorVal);
    applyRenderColor(config, prop, colorVal);
    return;
  }

  // One-click apply of the current default colour/highlight.
  if (action === "color-apply") return applyRenderColor(config, "color", renderFormatDefaults.color);
  if (action === "highlight-apply") return applyRenderColor(config, "highlight", renderFormatDefaults.highlight);

  // Cloze reuses its dedicated driver (toggle + "already"/"removed" toasts).
  if (action === "cloze") return makeClozeFromSelection(config);

  // Save the selection as a new card (question) in the quick_notes deck —
  // same destination and behaviour as the raw-editor toolbar's 📌 button.
  if (action === "quick-note") {
    const sel = renderedSelectionStrings(config.view);
    if (!sel) {
      setStatus(`Select some text in the ${config.label} first, then tap 📌 to save it to quick_notes.`, "error");
      return;
    }
    // Capture the source location while the selection is still live so the
    // quick_notes card can offer a "Go to notes" jump back here.
    saveQuickNote(sel.asMarkdown || sel.asText, btn, captureSourceAnchor());
    return;
  }

  // Plain inline toggles.
  const fn = RENDER_INLINE_FORMATS[action];
  if (fn) applyRenderFormat(config, fn);
}

// pointerdown (not click) so preventDefault preserves the live selection.
document.addEventListener("pointerdown", (event) => {
  const btn = event.target.closest(".render-toolbar [data-render-action], .render-toolbar [data-render-color]");
  if (btn) {
    event.preventDefault();
    event.stopPropagation();
    handleRenderToolbarAction(btn, btn.closest(".render-toolbar"));
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

function notesLexTokens() {
  return marked.lexer(state.notes || "");
}

function parseImgTagFromHtml(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const img = wrap.querySelector("img");
  if (!img) return null;
  const wProp = img.style.getPropertyValue("--notes-img-w").trim();
  return {
    url: img.getAttribute("src") || "",
    alt: img.getAttribute("alt") || "",
    widthPx: wProp ? parseInt(wProp, 10) || null : null
  };
}

// Sizing is stored as an absolute pixel width (not a percentage of whatever
// happens to contain it), so it's stable regardless of viewport width changes.
function imgTagHtml({ url, alt = "", widthPx = null }) {
  const style = widthPx ? ` style="--notes-img-w:${widthPx}px; width:${widthPx}px"` : "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${style}>`;
}

// Walks top-level marked tokens and returns every image-bearing block in
// document order. A standalone image (its own paragraph / raw <img>) and one
// sharing a paragraph with other text (isInline) are both directly
// resizable — commitImageWidth rewrites just that image's own raw slice for
// the isInline case, leaving the surrounding text untouched. One nested in a
// list/quote (isDeep) is resized in place too, via commitDeepImageWidth, which
// swaps its raw slice inside the enclosing token without pulling it out.
// Legacy side-by-side rows (`.notes-img-row`, no longer creatable) are still
// detected so their images stay resizable and the DOM↔token mapping in
// enhanceNotesImageControls stays aligned.
// A paragraph written as `![](a) | ![](b) | …` (images separated by "|") is a
// side-by-side row: returns the ordered image infos, or null if the paragraph
// is anything else. Mirrors renderImageRows so the controls treat what renders
// as a row as a row (resize grip per image), not as loose inline images.
function pipeRowImages(token) {
  if (token.type !== "paragraph" || !Array.isArray(token.tokens)) return null;
  // Drop pure-whitespace text tokens with no pipe (stray spacing between
  // items); real separators keep their "|".
  const toks = token.tokens.filter((t) => {
    if (t.type !== "text" && t.type !== "escape") return true;
    const s = String(t.raw ?? t.text ?? "");
    return !(/^\s*$/.test(s));
  });
  if (toks.length < 3 || toks.length % 2 === 0) return null; // image (sep image)+
  const images = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i % 2 === 0) {
      if (t.type === "image") {
        images.push({ url: t.href, alt: t.text || "", widthPx: null });
      } else if (t.type === "html" && /^<img\b/i.test((t.raw || t.text || "").trim())) {
        const info = parseImgTagFromHtml(t.raw || t.text);
        if (!info) return null;
        images.push(info);
      } else {
        return null;
      }
    } else if (!/^\s*\|\s*$/.test(String(t.raw ?? t.text ?? ""))) {
      return null; // separator must be a single "|"
    }
  }
  return images.length >= 2 ? images : null;
}

function findImageTokens(tokens) {
  const results = [];
  tokens.forEach((token, tokenIndex) => {
    const rowImages = pipeRowImages(token);
    if (rowImages) {
      results.push({ tokenIndex, isRow: true, images: rowImages });
      return;
    }
    if (token.type === "paragraph" && Array.isArray(token.tokens) && token.tokens.length === 1) {
      const inline = token.tokens[0];
      if (inline.type === "image") {
        results.push({ tokenIndex, isRow: false, images: [{ url: inline.href, alt: inline.text || "", widthPx: null }] });
        return;
      }
      if (inline.type === "html" && /^<img\b/i.test((inline.raw || inline.text || "").trim())) {
        const info = parseImgTagFromHtml(inline.raw || inline.text);
        if (info) results.push({ tokenIndex, isRow: false, images: [info] });
        return;
      }
    }
    // An image pasted mid-sentence shares its paragraph with other text.
    // `inlinePos` lets commitImageWidth find and replace just this image's
    // own raw slice within the paragraph, so it's still resizable in place.
    if (token.type === "paragraph" && Array.isArray(token.tokens) && token.tokens.length > 1) {
      token.tokens.forEach((inline, inlinePos) => {
        if (inline.type === "image") {
          results.push({ tokenIndex, isRow: false, isInline: true, inlinePos, images: [{ url: inline.href, alt: inline.text || "", widthPx: null }] });
        } else if (inline.type === "html" && /^<img\b/i.test((inline.raw || inline.text || "").trim())) {
          const info = parseImgTagFromHtml(inline.raw || inline.text);
          if (info) results.push({ tokenIndex, isRow: false, isInline: true, inlinePos, images: [info] });
        }
      });
      return;
    }
    if (token.type === "html") {
      const wrap = document.createElement("div");
      wrap.innerHTML = token.raw;
      const rowDiv = wrap.querySelector(".notes-img-row");
      if (rowDiv) {
        const images = Array.from(rowDiv.querySelectorAll("img")).map((img) => {
          const wProp = img.style.getPropertyValue("--notes-img-w").trim();
          return {
            url: img.getAttribute("src") || "",
            alt: img.getAttribute("alt") || "",
            widthPx: wProp ? parseInt(wProp, 10) || null : null
          };
        });
        if (images.length) results.push({ tokenIndex, isRow: true, images });
        return;
      }
      if (/^<img\b/i.test(token.raw.trim())) {
        const info = parseImgTagFromHtml(token.raw);
        if (info) results.push({ tokenIndex, isRow: false, images: [info] });
      }
      return;
    }
    // Anything else — most commonly a list or blockquote — can have images
    // buried in its nested items/sub-tokens. Those get the same corner resize
    // grip, committed in place by commitDeepImageWidth.
    const deep = [];
    collectImagesDeep(token, deep);
    deep.forEach((found) => {
      results.push({ tokenIndex, isRow: false, isDeep: true, imageRaw: found.raw, images: [{ url: found.url, alt: found.alt, widthPx: found.widthPx ?? null }] });
    });
  });
  return results;
}

// Recursively collects every image (markdown ![]() or raw <img> HTML) found
// anywhere within a token's subtree — marked's list_item/blockquote tokens nest
// their content under .tokens (and .items), so an image pasted under a bullet
// lives several levels deep, not at the top level findImageTokens checks.
function collectImagesDeep(token, results) {
  if (!token || typeof token !== "object") return;
  if (token.type === "image") {
    results.push({ raw: token.raw || `![${token.text || ""}](${token.href})`, url: token.href, alt: token.text || "" });
    return;
  }
  if (token.type === "html" && /^<img\b/i.test((token.raw || token.text || "").trim())) {
    const info = parseImgTagFromHtml(token.raw || token.text);
    if (info) results.push({ raw: token.raw || token.text, ...info });
    return;
  }
  if (Array.isArray(token.tokens)) token.tokens.forEach((t) => collectImagesDeep(t, results));
  if (Array.isArray(token.items)) token.items.forEach((t) => collectImagesDeep(t, results));
}

// Resizes an image found via collectImagesDeep IN PLACE — nested in its
// enclosing top-level token (a list item, blockquote, etc.). Its exact raw
// source slice is swapped for a sized raw <img> tag, leaving the surrounding
// list/quote structure untouched, so the image stays put under its bullet
// instead of being promoted to its own line. On the next resize the slice is
// the <img> tag itself (collectImagesDeep re-detects it and reads back the
// width), so repeated drags keep working.
function commitDeepImageWidth(tokenIndex, imageRaw, info, px) {
  const widthPx = Math.min(2000, Math.max(20, Math.round(px)));
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token) return;
  const idx = token.raw.indexOf(imageRaw);
  if (idx === -1) return;
  const newImgRaw = imgTagHtml({ ...info, widthPx });
  const newRaw = token.raw.slice(0, idx) + newImgRaw + token.raw.slice(idx + imageRaw.length);
  tokens[tokenIndex] = { ...token, raw: newRaw };
  rebuildNotesFromTokens(tokens);
}

// Rebuilds state.notes from a (possibly mutated) token array, keeps the raw
// editor in sync if it's open, re-renders, and autosaves — the single write
// path every resize/promote commit goes through. Every token is normalized to
// end in a blank line so blocks stay safely separated after a splice; "space"
// tokens (marked's blank-line gaps) are dropped since each kept token already
// gets its own trailing blank line.
function rebuildNotesFromTokens(tokens) {
  state.notes = tokens
    .filter((t) => t.type !== "space")
    .map((t) => t.raw.replace(/\n*$/, "\n\n"))
    .join("")
    .replace(/\n+$/, "\n");
  if (isNotesEditing()) el.notesEdit.value = state.notes;
  renderMarkdown(el.notesView, state.notes, true).then(() => resetClozeButton(el.clozeToggleNotesBtn));
  scheduleDeckAutosave();
}

// Freestyle sizing — an absolute pixel width with only a sanity floor/ceiling,
// so an image can be shrunk to a small accent or blown up past its container
// (the shell scrolls). `subPos` disambiguates when a single token carries more
// than one image: a side-by-side `|`-separated row (subPos = index in the
// row) or an image sharing a paragraph with other text (subPos = inlinePos).
// Resizing a row image rewrites that line into the explicit
// `<div class="notes-img-row">` form (the only representation that can carry
// a per-image width); it renders identically. Resizing an inline image
// replaces just its own raw slice within the shared paragraph, in place —
// the surrounding text is left untouched, no promotion/extraction needed.
function commitImageWidth(tokenIndex, subPos, px) {
  const widthPx = Math.min(2000, Math.max(20, Math.round(px)));
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token) return;
  const entries = findImageTokens(tokens).filter((e) => e.tokenIndex === tokenIndex);

  const rowEntry = subPos !== null ? entries.find((e) => e.isRow) : null;
  const inlineEntry = subPos !== null ? entries.find((e) => e.isInline && e.inlinePos === subPos) : null;

  if (rowEntry) {
    if (!rowEntry.images[subPos]) return;
    const images = rowEntry.images.map((im, i) => (i === subPos ? { ...im, widthPx } : im));
    const rowHtml = `<div class="notes-img-row">${images.map(imgTagHtml).join("")}</div>\n\n`;
    tokens[tokenIndex] = { type: "html", raw: rowHtml, text: rowHtml, pre: false, block: true };
  } else if (inlineEntry) {
    const inline = token.tokens[inlineEntry.inlinePos];
    if (!inline) return;
    const newImgRaw = imgTagHtml({ ...inlineEntry.images[0], widthPx });
    tokens[tokenIndex] = { ...token, raw: token.raw.replace(inline.raw, newImgRaw) };
  } else {
    const entry = entries.find((e) => !e.isRow && !e.isInline);
    if (!entry) return;
    const html = imgTagHtml({ ...entry.images[0], widthPx }) + "\n\n";
    tokens[tokenIndex] = { type: "html", raw: html, text: html, pre: false, block: true };
  }
  rebuildNotesFromTokens(tokens);
}

// Removes one image occurrence from the notes — the delete-button counterpart
// to commitImageWidth/commitDeepImageWidth, using the same row/inline/deep/
// standalone dispatch so removal handles every shape resizing does. `imageRaw`
// (deep case) strips just that raw slice from its enclosing token, leaving the
// surrounding list/quote untouched; every other case rewrites or drops the
// whole token, same as a resize commit would.
function removeImageAt(tokenIndex, subPos, imageRaw) {
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token) return;

  if (imageRaw) {
    const idx = token.raw.indexOf(imageRaw);
    if (idx === -1) return;
    const newRaw = token.raw.slice(0, idx) + token.raw.slice(idx + imageRaw.length);
    tokens[tokenIndex] = { ...token, raw: newRaw };
    rebuildNotesFromTokens(tokens);
    return;
  }

  const entries = findImageTokens(tokens).filter((e) => e.tokenIndex === tokenIndex);
  const rowEntry = subPos !== null ? entries.find((e) => e.isRow) : null;
  const inlineEntry = subPos !== null ? entries.find((e) => e.isInline && e.inlinePos === subPos) : null;

  if (rowEntry) {
    const remaining = rowEntry.images.filter((_, i) => i !== subPos);
    if (remaining.length >= 2) {
      const rowHtml = `<div class="notes-img-row">${remaining.map(imgTagHtml).join("")}</div>\n\n`;
      tokens[tokenIndex] = { type: "html", raw: rowHtml, text: rowHtml, pre: false, block: true };
    } else if (remaining.length === 1) {
      const html = imgTagHtml(remaining[0]) + "\n\n";
      tokens[tokenIndex] = { type: "html", raw: html, text: html, pre: false, block: true };
    } else {
      tokens.splice(tokenIndex, 1);
    }
  } else if (inlineEntry) {
    const inline = token.tokens[inlineEntry.inlinePos];
    if (!inline) return;
    // Drop just this image's own raw slice. Any double space it leaves behind
    // in the surrounding prose is harmless (Markdown/HTML collapse runs of
    // whitespace) — deliberately NOT globally collapsing spaces here, which
    // would corrupt intentional spacing inside inline code in the paragraph.
    tokens[tokenIndex] = { ...token, raw: token.raw.replace(inline.raw, "") };
  } else {
    tokens.splice(tokenIndex, 1);
  }
  rebuildNotesFromTokens(tokens);
}

// Removes the image from the notes immediately (so the UI never waits on a
// network round-trip), then best-effort deletes its underlying storage object.
function removeNotesImage(tokenIndex, subPos, imageRaw, url) {
  removeImageAt(tokenIndex, subPos, imageRaw);
  // Only hard-delete the stored file once NO other reference to it survives in
  // this note — a duplicated image (same URL used twice, or the `![](url)`
  // markdown copy-pasted) otherwise deletes the file out from under its other
  // copies, turning them into broken links. This is the deletion ImgBB's plain
  // public-link API never allowed from inside the app; guarding it keeps that
  // power from becoming accidental data loss. (A copy pasted into a *different*
  // deck is still not seen here — checking every deck is too costly — so cross-
  // deck reuse of the exact same uploaded URL remains a caveat, not the norm
  // since each upload gets a unique path.)
  if (url && !(state.notes || "").includes(url)) {
    deleteSupabaseImage(url);
  }
}

// Bottom-right corner-grip resize (the universal affordance): drag out from the
// corner to grow, in to shrink. Width is what's stored; height is auto, so
// aspect ratio is preserved for free. A live badge shows the current px width
// and its share of the notes column so sizing isn't guesswork.
function beginImageResize(event, shell, img, onCommit) {
  event.preventDefault();
  event.stopPropagation();
  shell.setPointerCapture?.(event.pointerId);
  const startX = event.clientX;
  const startWidth = img.getBoundingClientRect().width || shell.getBoundingClientRect().width;
  const refWidth = el.notesView?.clientWidth || 600;
  let widthPx = Math.round(startWidth);

  const badge = document.createElement("div");
  badge.className = "notes-img-size-badge";
  shell.appendChild(badge);
  const paintBadge = () => {
    const pct = Math.round((widthPx / refWidth) * 100);
    badge.textContent = `${widthPx}px · ${pct}%`;
  };

  shell.classList.add("is-resizing");
  const onMove = (e) => {
    const dx = e.clientX - startX;
    widthPx = Math.min(2000, Math.max(20, Math.round(startWidth + dx)));
    img.style.setProperty("--notes-img-w", `${widthPx}px`);
    img.style.width = `${widthPx}px`;
    img.classList.add("has-custom-size");
    paintBadge();
  };
  // A single teardown for every way the drag can end. Without also handling
  // pointercancel (fired when a touch/pen gesture is interrupted — scroll
  // takeover, second finger, the browser stealing the pointer), onUp would never
  // run: the live size badge would stay stranded in the DOM and the document
  // pointermove listener would leak, which is the "stray UI element that pops up
  // and won't go away" symptom.
  let finished = false;
  const end = (commit) => {
    if (finished) return;
    finished = true;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    shell.classList.remove("is-resizing");
    badge.remove();
    if (commit) onCommit(widthPx);
  };
  const onUp = () => end(true);
  const onCancel = () => end(false); // interrupted — drop the badge, keep last live width
  paintBadge();
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// Attaches the blue corner-drag resize grip and a delete button to an image.
// `onCommit(widthPx)` persists the final size and `onDelete()` removes the
// image — the caller supplies the right write path for each, matching the
// image's shape (standalone/row/inline, or nested in a list/quote). These are
// the only image controls: every rendered notes image gets them, so images
// buried in bullet points are resized/removed in place just like any other,
// with no intermediate "move to own line" step.
function attachNotesImageResizeHandle(shell, img, onCommit, onDelete) {
  shell.querySelector(".notes-img-controls")?.remove();
  shell.querySelector(".notes-img-resize-handle")?.remove();
  shell.querySelector(".notes-img-delete-btn")?.remove();
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "notes-img-resize-handle";
  resizeHandle.title = "Drag to resize";
  resizeHandle.setAttribute("aria-hidden", "true");
  resizeHandle.addEventListener("pointerdown", (e) => beginImageResize(e, shell, img, onCommit));
  shell.appendChild(resizeHandle);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "notes-img-delete-btn";
  deleteBtn.title = "Remove image";
  deleteBtn.setAttribute("aria-label", "Remove image");
  deleteBtn.textContent = "🗑";
  deleteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete();
  });
  shell.appendChild(deleteBtn);
}

// Re-attaches the resize grip / promote button after every notes render.
//
// Rendering wraps EVERY <img> in a .diagram-shell (addDiagramZoomControl), but
// findImageTokens only classifies the images it can map back to a resizable /
// promotable source block — an image buried in a table cell or wrapped in a link
// inside running text is rendered (and shelled) yet left unclassified. Pairing
// the two lists purely by ordinal position therefore slipped the whole sequence
// the moment one such image appeared: a resize grip meant for a later image got
// attached to (and would then rewrite) the wrong one.
//
// Instead, match each classified image to its shell by src, walked as an ordered
// subsequence: a shell whose image isn't in the classified list fails the src
// check and is simply skipped (keeping only its Zoom pill) rather than consuming
// a control slot. src is compared through normalizeImageUrl so a Drive link whose
// rendered src was already rewritten still matches its raw markdown href.
function enhanceNotesImageControls() {
  if (!el.notesView) return;
  const tokens = notesLexTokens();
  const imageTokens = findImageTokens(tokens);
  const shells = Array.from(el.notesView.querySelectorAll(".diagram-shell")).filter((s) => s.querySelector("img"));

  // One slot per classified image, in document order, carrying its owning entry.
  const slots = [];
  imageTokens.forEach((entry) => {
    entry.images.forEach((img, subIndex) => {
      slots.push({ entry, subIndex, url: normalizeImageUrl(img.url || "") });
    });
  });

  let slotIdx = 0;
  shells.forEach((shell) => {
    const img = shell.querySelector("img");
    if (!img) return;
    if (slotIdx >= slots.length) return;
    const slot = slots[slotIdx];
    const src = normalizeImageUrl(img.getAttribute("src") || "");
    if (src !== slot.url) return; // unclassified image (table cell, linked, …) — Zoom only
    slotIdx++;

    const { entry, subIndex } = slot;
    img.draggable = false;
    shell.dataset.tokenIndex = String(entry.tokenIndex);
    const widthPx = entry.images[subIndex]?.widthPx;
    if (widthPx) {
      img.style.setProperty("--notes-img-w", `${widthPx}px`);
      img.classList.add("has-custom-size");
    } else {
      img.classList.remove("has-custom-size");
    }
    if (entry.isDeep) {
      // An image nested in a list/quote is resized in place too: instead of
      // extracting it to its own line first, commitDeepImageWidth rewrites just
      // its raw slice within the enclosing token's content, keeping it exactly
      // where it sits under the bullet.
      const info = entry.images[0];
      attachNotesImageResizeHandle(shell, img,
        (px) => commitDeepImageWidth(entry.tokenIndex, entry.imageRaw, info, px),
        () => removeNotesImage(entry.tokenIndex, null, entry.imageRaw, info.url)
      );
    } else {
      const subPos = entry.isRow ? subIndex : (entry.isInline ? entry.inlinePos : null);
      const url = entry.images[entry.isRow ? subIndex : 0]?.url || "";
      attachNotesImageResizeHandle(shell, img,
        (px) => commitImageWidth(entry.tokenIndex, subPos, px),
        () => removeNotesImage(entry.tokenIndex, subPos, null, url)
      );
    }
  });
}

function transitionClassFor(direction, phase) {
  if (!direction) return "";
  const suffix = phase === "in" ? "in" : "out";
  if (direction === "known") return `transition-right-${suffix}`;
  if (direction === "review") return `transition-left-${suffix}`;
  if (direction === "next") return `transition-left-${suffix}`;
  if (direction === "prev") return `transition-right-${suffix}`;
  if (direction > 0) return `transition-down-${suffix}`;
  if (direction < 0) return `transition-up-${suffix}`;
  return "";
}

function clearCardTransitionClasses() {
  el.card.classList.remove(
    "transition-left-out",
    "transition-left-in",
    "transition-right-out",
    "transition-right-in",
    "transition-up-out",
    "transition-up-in",
    "transition-down-out",
    "transition-down-in"
  );
}

function buildDeckSummaryHtml() {
  syncResults();
  const total = state.masterCards.length;
  const known = state.results.known.length;
  const review = state.results.review.length;
  const uncategorized = total - known - review;

  const knownPct   = total ? Math.round((known / total) * 100) : 0;
  const reviewPct  = total ? Math.round((review / total) * 100) : 0;
  const uncatPct   = total ? (100 - knownPct - reviewPct) : 0;

  // SVG pie chart using stroke-dasharray on a circle (r=15.9, circumference≈100)
  const r = 15.9155;
  const circ = 2 * Math.PI * r; // ≈100
  const knownArc   = (known / total) * circ || 0;
  const reviewArc  = (review / total) * circ || 0;
  const uncatArc   = (uncategorized / total) * circ || 0;

  // Rotation offsets so segments start at top (-90deg = top)
  const knownOffset   = circ * 0.25; // start at top
  const reviewOffset  = knownOffset - knownArc;
  const uncatOffset   = reviewOffset - reviewArc;

  const isEmpty = total === 0;

  const pieSlices = isEmpty ? `
    <circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--line)" stroke-width="8" stroke-dasharray="${circ} 0"/>
  ` : `
    ${known > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--known,#22c55e)" stroke-width="8"
      stroke-dasharray="${knownArc} ${circ - knownArc}"
      stroke-dashoffset="${knownOffset}"
      class="pie-segment pie-known"/>` : ""}
    ${review > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--review,#f59e0b)" stroke-width="8"
      stroke-dasharray="${reviewArc} ${circ - reviewArc}"
      stroke-dashoffset="${reviewOffset}"
      class="pie-segment pie-review"/>` : ""}
    ${uncategorized > 0 ? `<circle r="${r}" cx="21" cy="21" fill="none"
      stroke="var(--muted,#94a3b8)" stroke-width="8"
      stroke-dasharray="${uncatArc} ${circ - uncatArc}"
      stroke-dashoffset="${uncatOffset}"
      class="pie-segment pie-uncat"/>` : ""}
  `;

  return `<div class="deck-summary">
    <div class="deck-summary-header">
      <div class="deck-summary-icon">🎉</div>
      <h2 class="deck-summary-title">Deck Complete!</h2>
      <p class="deck-summary-subtitle">${escapeHtml(state.deckTitle || "All cards reviewed")}</p>
    </div>
    <div class="deck-summary-body">
      <div class="deck-summary-chart-wrap">
        <svg class="deck-summary-pie" viewBox="0 0 42 42" role="img" aria-label="Score breakdown">
          ${pieSlices}
          <text x="21" y="19.5" class="pie-center-num">${total}</text>
          <text x="21" y="24.5" class="pie-center-label">cards</text>
        </svg>
      </div>
      <div class="deck-summary-stats">
        <div class="deck-stat deck-stat-known">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Known</span>
          <span class="deck-stat-count">${known}</span>
          <span class="deck-stat-pct">${knownPct}%</span>
        </div>
        <div class="deck-stat deck-stat-review">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Review</span>
          <span class="deck-stat-count">${review}</span>
          <span class="deck-stat-pct">${reviewPct}%</span>
        </div>
        <div class="deck-stat deck-stat-uncat">
          <span class="deck-stat-dot"></span>
          <span class="deck-stat-label">Uncategorized</span>
          <span class="deck-stat-count">${uncategorized}</span>
          <span class="deck-stat-pct">${uncatPct}%</span>
        </div>
      </div>
    </div>
    <div class="deck-summary-actions">
      <button class="deck-summary-btn deck-summary-btn-primary" data-replay="all">↺ Restart All</button>
      <button class="deck-summary-btn deck-summary-btn-review" data-replay="review" ${review === 0 ? "disabled" : ""}>❌ Review (${review})</button>
      <button class="deck-summary-btn deck-summary-btn-uncat" data-replay="uncategorized" ${uncategorized === 0 ? "disabled" : ""}>? Uncategorized (${uncategorized})</button>
      <button class="deck-summary-btn deck-summary-btn-known" data-replay="known" ${known === 0 ? "disabled" : ""}>✅ Known (${known})</button>
    </div>
  </div>`;
}

async function showCard(direction = 0) {
  hideNotesSelectionButton();
  scheduleDeckAutosave();
  const token = state.transitionToken;
  state.previewCard = null;
  state.flipped = false;
  el.card.classList.remove("is-flipped", "swipe-left", "swipe-right", "is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  clearCardTransitionClasses();
  el.card.style.transform = "";
  const enterClass = transitionClassFor(direction, "in");
  if (enterClass) el.card.classList.add(enterClass);

  const card = state.cards[state.current];
  if (!card) {
    if (state.cards.length > 0) {
      // Deck finished — show rich summary overlay covering the whole card
      if (el.deckSummary) {
        el.deckSummary.innerHTML = buildDeckSummaryHtml();
        el.deckSummary.hidden = false;
      }
      if (el.deckEmptyState) el.deckEmptyState.hidden = true;
      el.card.hidden = false;
      el.card.closest(".quiz-panel")?.classList.add("deck-complete");
    } else {
      // Zero cards — either a freshly created/loaded deck waiting for its
      // first card, or truly nothing loaded. Same container, different copy.
      if (el.deckSummary) el.deckSummary.hidden = true;
      if (el.deckEmptyState) el.deckEmptyState.hidden = false;
      renderDeckEmptyState(hasActiveDeck() ? "active" : "none");
      el.card.hidden = true;
      el.card.closest(".quiz-panel")?.classList.remove("deck-complete");
      el.card.closest(".quiz-panel")?.classList.add("is-deck-empty");
    }
    updateMeta();
    return;
  }

  // Normal card — hide summary overlay and empty state
  if (el.deckSummary) el.deckSummary.hidden = true;
  if (el.deckEmptyState) el.deckEmptyState.hidden = true;
  el.card.hidden = false;
  el.card.closest(".quiz-panel")?.classList.remove("deck-complete", "is-deck-empty");
  maybeShowSwipeHint();
  if (el.goToNotesBtn) el.goToNotesBtn.hidden = !cardHasNoteLink(card);
  await renderMarkdown(el.questionView, card.question, true);
  await renderMarkdown(el.answerView, card.answer, true);
  // Fresh spans render hidden; reset the bulk button label to "Reveal clozes".
  resetClozeButton(el.clozeToggleBtn);
  scheduleLiveQuestionFit();
  updateMeta();
  if (enterClass) {
    window.setTimeout(() => {
      if (state.transitionToken !== token) return;
      el.card.classList.remove(enterClass);
    }, 280);
  }
}

function animateToCard(direction, updateState) {
  const token = state.transitionToken + 1;
  state.transitionToken = token;
  const exitClass = transitionClassFor(direction, "out");
  clearCardTransitionClasses();
  el.card.classList.remove("swipe-left", "swipe-right", "is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
  if (exitClass) el.card.classList.add(exitClass);

  window.setTimeout(() => {
    if (state.transitionToken !== token) return;
    commitEditIfActive();
    updateState();
    showCard(direction);
  }, 210);
}

function detectDecksInMarkdown(markdown) {
  const source = removeEmptyHeadingGroups(stripReaderMetadata(markdown));
  const lines = source.split("\n");
  const deckSections = [];
  let currentDeck = null;

  let inNotesBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Never treat lines inside a deck-notes block as deck boundaries or
    // metadata — notes are freeform and may contain `# headings` of their own.
    if (/^<!--\s*recall:notes\s*-->\s*$/.test(line.trim())) inNotesBlock = true;
    if (inNotesBlock) {
      if (currentDeck) {
        currentDeck.lines.push(line);
      } else {
        currentDeck = { title: "", category: "General", lines: [line] };
      }
      if (/^<!--\s*\/recall:notes\s*-->\s*$/.test(line.trim())) inNotesBlock = false;
      continue;
    }
    const match = line.match(/^#\s+(.+)$/);
    if (match) {
      if (currentDeck) {
        deckSections.push(currentDeck);
      }
      currentDeck = {
        title: match[1].trim(),
        category: "General",
        lines: []
      };
    } else if (currentDeck) {
      const catMatch = line.match(/^Category:\s*(.+)$/i);
      if (catMatch) {
        currentDeck.category = catMatch[1].trim();
      } else {
        const isDeckId = /^Deck ID:\s*/i.test(line);
        const isExported = /^Exported:\s*/i.test(line);
        if (!isDeckId && !isExported) {
          currentDeck.lines.push(line);
        }
      }
    } else {
      const trimmed = line.trim();
      if (trimmed) {
        currentDeck = {
          title: "",
          category: "General",
          lines: [line]
        };
      }
    }
  }
  if (currentDeck) {
    deckSections.push(currentDeck);
  }

  const parsedDecks = [];
  deckSections.forEach((d) => {
    const rawContent = d.lines.join("\n").trim();
    if (!rawContent) return;
    const { markdown: content, notes } = extractNotesFromMarkdown(rawContent);
    const cards = parseCards(content);
    if (cards.length > 0 || notes.trim()) {
      parsedDecks.push({
        title: d.title || "",
        category: d.category || "General",
        cards: cards,
        notes: notes,
        content: content
      });
    }
  });

  return parsedDecks;
}

let currentDetectedDecks = [];
let currentImportTitleHint = "";

function showImportDecksSelector(decks, titleHint) {
  currentDetectedDecks = decks;
  currentImportTitleHint = titleHint;

  el.importSelectorListTable.innerHTML = decks.map((deck, index) => {
    const deckTitle = deck.title || titleHint || `Deck ${index + 1}`;
    return `
      <tr>
        <td style="text-align: center; vertical-align: middle;">
          <input type="checkbox" class="import-selector-checkbox" data-index="${index}" checked style="cursor: pointer; width: 16px; height: 16px; accent-color: var(--accent);">
        </td>
        <td style="vertical-align: middle; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;"><strong>${escapeHtml(deckTitle)}</strong></td>
        <td style="vertical-align: middle;"><span class="cornell-status" data-status="uncategorized">${escapeHtml(deck.category)}</span></td>
        <td style="vertical-align: middle; text-align: right; padding-right: 14px; font-weight: 800;">${deck.cards.length}</td>
      </tr>
    `;
  }).join("");

  el.selectAllImportSelectorCheckbox.checked = true;
  el.importSelectorPanel.hidden = false;
  lockPageScroll();
}

function closeImportSelectorPanel() {
  el.importSelectorPanel.hidden = true;
  unlockPageScroll();
}

function toggleAllImportSelector() {
  const checked = el.selectAllImportSelectorCheckbox.checked;
  const checkboxes = el.importSelectorListTable.querySelectorAll(".import-selector-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = checked;
  });
}

async function loadSelectedImportDecks() {
  const checkboxes = el.importSelectorListTable.querySelectorAll(".import-selector-checkbox");
  const selectedDecks = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) {
      const index = parseInt(cb.dataset.index, 10);
      selectedDecks.push(currentDetectedDecks[index]);
    }
  });

  if (selectedDecks.length === 0) {
    setStatus("Please select at least one deck to import.", "error");
    return;
  }

  closeImportSelectorPanel();

  let combinedCards = [];
  selectedDecks.forEach((deck) => {
    combinedCards = combinedCards.concat(deck.cards);
  });

  // Random suffix for the same reason as parseCards: card ids are globally
  // unique in the cloud, so deterministic index+question ids collide across decks.
  const cards = combinedCards.map((card, index) => ({
    id: `${index}-${card.question.slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`,
    question: card.question,
    answer: card.answer
  }));

  state.masterCards = cards.slice();
  state.deckId = null;
  // Fresh import → detach from any previously-loaded library entry so the first
  // autosave creates a NEW deck instead of overwriting the old one.
  state.localDeckId = null;
  resetStudyDeck(state.masterCards);

  if (selectedDecks.length === 1) {
    state.deckTitle = selectedDecks[0].title || currentImportTitleHint || "Imported Deck";
    state.deckCategory = selectedDecks[0].category || defaultDeckCategory;
  } else {
    state.deckTitle = `Combined: ${selectedDecks.map(d => d.title || "Untitled").join(", ")}`.slice(0, 80);
    state.deckCategory = defaultDeckCategory;
  }
  state.sourceTitle = state.deckTitle;
  state.notes = selectedDecks
    .map((deck) => String(deck.notes || "").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
  setViewMode("notes");

  closeAllCardsPanel();
  closeImportPanel();

  if (cards.length) {
    setStatus(`Imported ${selectedDecks.length} deck(s) with ${cards.length} total card(s).`);
  }

  showCard();
}

function buildCards(titleHint = state.importTitleHint || "", append = false) {
  const rawSource = stripReaderMetadata(el.sourceInput.value);
  if (!append) {
    const detectedDecks = detectDecksInMarkdown(rawSource);
    if (detectedDecks.length > 1) {
      showImportDecksSelector(detectedDecks, titleHint);
      return 0;
    }
  }
  const { markdown: source, notes: extractedNotes } = extractNotesFromMarkdown(rawSource);
  const cards = parseCards(source);
  const headingCount = countQuestionHeadings(source);
  const importTitle = titleFromImportHint(titleHint);
  if (append) {
    state.cards = state.cards.concat(cards);
    state.masterCards = state.masterCards.concat(cards);
  } else {
    const hasContent = cards.length > 0 || Boolean(extractedNotes.trim());
    state.masterCards = cards.slice();
    state.deckId = null;
    // Fresh deck → detach from any previously-loaded library entry, or the first
    // autosave would overwrite THAT deck's snapshot under its stale localDeckId.
    state.localDeckId = null;
    resetStudyDeck(state.masterCards);
    state.deckTitle = hasContent ? importTitle || inferDeckTitle(source, titleHint) : "";
    state.deckCategory = defaultDeckCategory;
    state.sourceTitle = hasContent ? importTitle || state.deckTitle : "";
    state.notes = extractedNotes;
    setViewMode("cards");
  }
  state.importTitleHint = titleHint;
  closeAllCardsPanel();

  if (cards.length) {
    setStatus(`Built ${cards.length} card${cards.length === 1 ? "" : "s"}.`);
    closeImportPanel();
  } else {
    const message = headingCount
      ? `Found ${headingCount} question heading${headingCount === 1 ? "" : "s"}, but no answer text. This Notion page is exposing collapsed toggle titles only; export Markdown or paste expanded toggle content.`
      : "No cards found. Use :: card blocks with a --- separator, legacy > toggle blocks, Q:/A: blocks, or ##/###/#### headings with answer content.";
    setStatus(message, "error");
  }

  showCard();
  return cards.length;
}

function flipCard() {
  if (!state.previewCard && !state.cards[state.current]) return;
  state.flipped = !state.flipped;
  el.card.classList.toggle("is-flipped", state.flipped);
}

function navigateCard(direction, animationDirection = direction) {
  if (state.previewCard || !state.cards.length) return;

  // Allow going one step past the last card to show the end-of-deck summary
  if (direction > 0 && state.current >= state.cards.length - 1) {
    if (state.current >= state.cards.length) {
      return; // Already on summary, don't try to go past it
    }
    animateToCard(animationDirection, () => {
      state.current = state.cards.length; // triggers summary in showCard
      state.previewCard = null;
      state.flipped = false;
    });
    return;
  }

  const nextIndex = Math.min(Math.max(state.current + direction, 0), state.cards.length - 1);
  if (nextIndex === state.current) return;
  setStatus(direction > 0 ? "Moved to next card." : "Moved to previous card.");
  animateToCard(animationDirection, () => {
    state.current = nextIndex;
    state.previewCard = null;
    state.flipped = false;
  });
}

function moveCard(result) {
  const card = state.previewCard || state.cards[state.current];
  if (!card) return;
  el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
  state.statusById[card.id] = result;
  syncResults();
  scheduleDeckAutosave();

  if (state.previewCard) {
    commitEditIfActive();
    state.previewCard = null;
    setStatus(`Moved card to ${result}.`);
    showCard();
    return;
  }

  animateToCard(result, () => {
    state.current += 1;
  });
}

function shuffleCards() {
  // Clear any active inline edit and reset gesture/drag state first, so the
  // freshly shown card is immediately tappable/swipeable — matches what
  // resetQuiz/replayDeck do before re-rendering.
  commitEditIfActive();
  resetCardDrag();
  for (let index = state.cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [state.cards[index], state.cards[swap]] = [state.cards[swap], state.cards[index]];
  }
  state.current = 0;
  setStatus("Deck shuffled.");
  showCard();
}

function resetQuiz() {
  commitEditIfActive();
  resetStudyDeck(state.masterCards);
  setStatus("Studying all cards.");
  showCard();
}

function replayDeck(scope) {
  commitEditIfActive();
  syncResults();
  const selected = scope === "known"
    ? state.results.known.slice()
    : scope === "review"
      ? state.results.review.slice()
      : scope === "uncategorized"
        ? uncategorizedCards()
        : state.masterCards.slice();

  if (!selected.length) {
    setStatus(scope === "uncategorized" ? "No uncategorized cards to replay." : `No ${scope} cards to replay.`, "error");
    return;
  }

  state.cards = selected;
  state.current = 0;
  state.previewCard = null;
  setStatus(scope === "all" ? "Studying all cards." : `Studying ${scope} cards.`);
  showCard();
}

// A card's question/answer can legitimately contain a standalone "---" line
// (a Markdown horizontal rule — "Both sides support Markdown" per
// FlashCard_Format.txt), which is otherwise indistinguishable from the
// front/back separator this same format uses. Escape it so export→import
// round-trips instead of truncating the question at the first such line (see
// parseDelimitedCards, which unescapes "\---" back to "---"). Fence-aware to
// match the parser, which never treats "---" inside a ``` block as anything
// but literal content — e.g. YAML frontmatter inside a fenced code sample
// must NOT be escaped, or it comes back out of the parser still escaped.
function escapeCardSideSeparator(text) {
  let inFence = false;
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && /^\s*---(?!-)/.test(line)) return line.replace(/^(\s*)---/, "$1\\---");
      return line;
    })
    .join("\n");
}

function formatCardList(title, cards) {
  const body = cards.length
    ? cards.map((card) => `::\n${escapeCardSideSeparator(card.question.trim())}\n\n---\n\n${escapeCardSideSeparator(card.answer.trim())}\n::`).join("\n\n")
    : "_None_";
  return `## ${title}\n\n${body}`;
}

function slugifyFileName(value, fallback = "recall") {
  const source = String(value || "").trim() || fallback;
  const cleaned = source
    .replace(/\.(md|markdown|mdown|mkdn|txt|json|zip)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function exportBaseName(scope = "all") {
  const base = slugifyFileName(state.deckTitle || state.sourceTitle || "recall");
  if (scope === "known") return `${base} - known`;
  if (scope === "review") return `${base} - review`;
  if (scope === "uncategorized") return `${base} - uncategorized`;
  return base;
}

function normalizeCardStatus(status) {
  return status === "known" || status === "review" ? status : "";
}

function deckSnapshot() {
  return {
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: state.deckTitle || "",
    deckCategory: normalizeDeckCategory(state.deckCategory),
    notes: state.notes || "",
    sourceTitle: state.sourceTitle || state.deckTitle || "",
    importTitleHint: state.importTitleHint || "",
    deckId: state.deckId,
    current: Number.isFinite(state.current) ? state.current : 0,
    // Deck-level bag. Only the quick_notes deck owns a category set, and
    // autosave must carry it or saving the deck erases the names/colours every
    // card chip resolves against.
    ...(isQuickNotesDeck(state.deckId, state.deckTitle) && state.quickNoteCategories.length
      ? { meta: { quickNoteCategories: state.quickNoteCategories } }
      : {}),
    cards: state.masterCards.map((card, index) => {
      const id = card.id || `${index}-${card.question.slice(0, 32)}`;
      return {
        id,
        question: card.question,
        answer: card.answer,
        status: normalizeCardStatus(state.statusById[card.id]),
        // Quick-note subject label. Must round-trip: without it every autosave
        // rewrote the snapshot with no category, and the next reconcile pushed
        // those blanks over the cloud — silently clearing the board.
        category: quickNoteCategoryForCard(card),
        // Preserve the note-link so "Go to notes" survives a save/reload.
        ...(card.noteAnchor ? { noteAnchor: card.noteAnchor } : {})
      };
    })
  };
}

function clearBrowserPersistence() {
  try {
    // themeStorageKey is intentionally kept — setTheme saves the user's theme
    // choice there and initAppForUser restores it on the next boot.
    localStorage.removeItem("flashcards_style_cache");
    // deckStorageKey is cleared on every boot — a refresh should start on the
    // clean home screen, not reopen the last deck. Only credentials, the saved
    // deck library (LOCAL_DECKS_INDEX_KEY / LOCAL_DECK_PREFIX), and styles persist.
    localStorage.removeItem(deckStorageKey);
    // styleStorageKey is intentionally kept — styles persist locally across sessions
  } catch (error) {
    console.warn("Could not clear browser persistence", error);
  }
}

function loadDeckSnapshot(payload, titleHint = "", append = false) {
  deckAutosaveStorageFailed = false;
  if (!payload || !Array.isArray(payload.cards)) {
    throw new Error("Invalid flashcard JSON");
  }

  const usedIds = new Set(append ? state.masterCards.map(c => c.id) : []);
  const statusById = append ? { ...state.statusById } : {};
  const categoryById = append ? { ...state.categoryById } : {};
  const cards = payload.cards
    .map((rawCard, index) => {
      const question = String(rawCard?.question || "").trim();
      const answer = String(rawCard?.answer || "").trim();
      // A card only needs a question — a blank answer is valid (front-only
      // "capture now, fill later" cards, e.g. every quick_notes pin). Dropping
      // answer-blank cards here silently emptied the quick_notes deck on load,
      // while the cloud loader (loadWebDeck) kept them; this aligns the two.
      if (!question) return null;

      let id = String(rawCard.id || `${index}-${question.slice(0, 32)}`);
      while (usedIds.has(id)) id = `${index}-${Math.random().toString(36).slice(2, 6)}-${id}`;
      usedIds.add(id);

      const status = normalizeCardStatus(rawCard?.status || payload.statusById?.[id]);
      if (status) statusById[id] = status;

      const card = { id, question, answer };
      // Quick-note subject label, mirrored into categoryById so the board and
      // the next autosave both see it.
      if (rawCard?.category) {
        card.category = String(rawCard.category);
        categoryById[id] = card.category;
      }
      // Carry the note-link through the snapshot round-trip so cards keep their
      // "Go to notes" jump after a reload or a My Decks re-open.
      if (rawCard?.noteAnchor && typeof rawCard.noteAnchor === "object") card.noteAnchor = rawCard.noteAnchor;
      return card;
    })
    .filter(Boolean);

  const payloadNotes = String(payload.notes || "");
  if (!cards.length && !payloadNotes.trim()) {
    throw new Error("No cards in flashcard JSON");
  }

  if (append) {
    state.cards = state.cards.concat(cards);
    state.masterCards = state.masterCards.concat(cards);
    state.statusById = statusById;
    state.categoryById = categoryById;
  } else {
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
    // Reset with the deck — a stale map from the previously open deck would
    // otherwise leak its labels onto same-id cards and get pushed to the cloud.
    state.categoryById = categoryById;
    applyDeckMetaCategories(payload.meta, payload.deckId, payload.deckTitle);
    state.current = Math.min(Math.max(Number(payload.current) || 0, 0), cards.length);
    state.deckTitle = String(payload.deckTitle || "").trim() || humanizeSourceTitle(titleHint);
    state.deckCategory = normalizeDeckCategory(payload.deckCategory || payload.category);
    state.deckId = payload.deckId || null;
    // Detach from any previously-loaded library entry. loadDeckFromLibrary sets
    // the correct localDeckId immediately after this returns; every other caller
    // (file open, snapshot import) genuinely wants a fresh, unattached deck so
    // its first autosave doesn't overwrite the deck that was open before.
    state.localDeckId = null;
    state.sourceTitle = String(payload.sourceTitle || "").trim() || sourceFileTitle(titleHint) || state.deckTitle;
    state.importTitleHint = String(payload.importTitleHint || "").trim() || titleHint;
    state.notes = payloadNotes;
    setViewMode("notes");
  }
  syncResults();
  closeAllCardsPanel();
  showCard();
}

// ---------------------------------------------------------------------------
// Offline persistence — all plain localStorage, so it works with no network.
//   • deckStorageKey            : the single "working" deck, saved during a session
//                                 but NOT auto-restored on boot (cleared on launch,
//                                 see clearBrowserPersistence) so a refresh starts
//                                 on the clean home screen
//   • LOCAL_DECKS_INDEX_KEY     : array of saved-deck metadata (the "My Decks" list)
//   • LOCAL_DECK_PREFIX + <id>  : the full snapshot for one saved deck
// ---------------------------------------------------------------------------
const LOCAL_DECKS_INDEX_KEY = "flashcards_local_decks_index_v1";
const LOCAL_DECK_PREFIX = "flashcards_local_deck_v1:";
// Timestamp of the last reconcile that completed without throwing (whether or
// not it found anything to change) — survives reloads so the startup screen
// can say "last checked Xm ago" even before the next reconcile finishes.
const LAST_GLOBAL_SYNC_KEY = "flashcards_last_global_sync_at";
// Set when a reconcile throws, cleared the next time one completes cleanly —
// lets the welcome screen show "Sync failed" the same way the per-deck pill
// (setSyncIndicator) would, even though no deck is loaded to attach it to.
const LAST_GLOBAL_SYNC_ERROR_KEY = "flashcards_last_global_sync_error";
// Cloud deck ids that were explicitly deleted on this device, mapped to the
// time of deletion. A two-way mirror with no deletion record can never make a
// delete "stick": deleting only the local copy lets the next pull re-download
// it, and deleting only the cloud copy lets the next push re-upload it. These
// tombstones let reconcileAllDecks re-assert the deletion (delete the cloud row
// again, never pull it back) until the cloud copy is confirmed gone.
const LOCAL_DECK_TOMBSTONES_KEY = "flashcards_deleted_deck_ids_v1";

let deckAutosaveTimer = null;

function persistWorkingDeck() {
  try {
    if (!state.masterCards.length && !state.notes.trim()) {
      localStorage.removeItem(deckStorageKey);
      return;
    }
    const snapshot = deckSnapshot();
    snapshot.localDeckId = state.localDeckId || null;
    localStorage.setItem(deckStorageKey, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("Could not save working deck", error);
  }
}

// Debounced so the rapid-fire mutations during study don't thrash localStorage.
// Every change auto-persists into the "My Decks" library — so there is no
// longer a manual "Save to Device" step. Cloud sync is intentionally NOT
// triggered here: pushing to Supabase on every keystroke-ish edit was
// chatty and unnecessary. The cloud only gets touched at app startup, when
// connectivity returns, and via the explicit "Sync Now" button — all through
// reconcileAllDecks().
// True only for an actual DOMException quota failure — checked by name/code
// rather than assuming, since browsers vary (modern: "QuotaExceededError";
// legacy WebKit/Firefox: code 22 / 1014, or name "NS_ERROR_DOM_QUOTA_REACHED").
function isQuotaExceededError(error) {
  if (!error) return false;
  return error.name === "QuotaExceededError"
    || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || error.code === 22
    || error.code === 1014;
}

let deckAutosaveStorageFailed = false;
// Set by saveDeckToLibrary's catch block so scheduleDeckAutosave can tell a
// genuine quota failure apart from any other save error without changing
// saveDeckToLibrary's return contract (many callers just check truthiness).
let lastSaveErrorWasQuota = false;
function scheduleDeckAutosave() {
  // After a storage-quota failure, stop scheduling further writes — the
  // toast already told the user, and hammering a full localStorage just
  // wastes CPU and fires more confusing errors.
  if (deckAutosaveStorageFailed) return;
  if (deckAutosaveTimer) clearTimeout(deckAutosaveTimer);
  deckAutosaveTimer = setTimeout(() => {
    deckAutosaveTimer = null;
    persistWorkingDeck();
    // An empty deck (e.g. the last card was just deleted) has nothing to
    // save — saveDeckToLibrary correctly no-ops and returns null for this,
    // but that's not a storage failure, so don't treat it as one.
    if (!state.masterCards.length && !state.notes.trim()) {
      setSyncIndicator("saved");
      return;
    }
    const savedMeta = saveDeckToLibrary({ silent: true });
    if (!savedMeta) {
      // Only latch (and stop future autosaves) on a REAL quota error. Any
      // other save failure is presumably transient/one-off — don't lock the
      // rest of the session out of autosaving over it.
      if (lastSaveErrorWasQuota) {
        deckAutosaveStorageFailed = true;
        setSyncIndicator("error");
        showToast("Device storage full — clear old decks to keep saving", "error");
      } else {
        setSyncIndicator("error");
      }
      return;
    }
    setSyncIndicator("saved");
  }, 400);
}

// Coarse "Xm ago" style relative time, for the sync pill's last-synced suffix.
function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

// Reflects the auto-save / cloud-sync lifecycle in the deck-meta pill.
function setSyncIndicator(stateName) {
  const node = el.syncIndicator;
  if (!node) return;
  if (!hasActiveDeck()) {
    node.textContent = "";
    node.dataset.state = "idle";
    return;
  }
  const labels = {
    signin: "Saved on device",
    saved: "Saved on device",
    saving: "Syncing…",
    synced: "Synced",
    offline: "Offline · saved on device",
    error: "Sync failed · saved on device",
  };
  node.dataset.state = stateName === "signin" ? "saved" : stateName;
  let text = labels[stateName] || "";
  if (stateName === "synced" && state.localDeckId) {
    const localMeta = readLocalDeckIndex().find((m) => m.id === state.localDeckId);
    const relative = formatRelativeTime(localMeta?.lastSyncedAt);
    if (relative) text += ` · ${relative}`;
  }
  node.textContent = text;
}

// Sets the resting state of the pill (used after a deck loads, when there are no
// pending edits) based on where the deck currently lives.
function refreshSyncIndicatorBaseline() {
  if (!hasActiveDeck()) return setSyncIndicator("idle");
  if (!supabaseClient || !isSignedIn) return setSyncIndicator("saved");
  if (!navigator.onLine) return setSyncIndicator("offline");
  return setSyncIndicator(state.deckId ? "synced" : "signin");
}

// Swaps the shared #deckEmptyState container between two variants: "none"
// (nothing loaded at all — New Deck/Import/My Decks) and "active" (a deck
// exists but has zero cards yet — prompts to add one or draft notes first).
function renderDeckEmptyState(mode) {
  const isActive = mode === "active";
  if (el.deckEmptyIcon) el.deckEmptyIcon.textContent = isActive ? "🗂️" : "📚";
  if (el.deckEmptyTitle) el.deckEmptyTitle.textContent = isActive ? "No cards yet" : "Recall";
  if (el.deckEmptyBody) {
    el.deckEmptyBody.textContent = isActive
      ? "Add your first card, or draft in Notes first:"
      : "Choose how to get started:";
  }
  if (el.deckEmptyActionsNone) el.deckEmptyActionsNone.hidden = isActive;
  if (el.deckEmptyActionsActive) el.deckEmptyActionsActive.hidden = !isActive;
  if (el.deckEmptyPanel) el.deckEmptyPanel.hidden = isActive;
  if (isActive) {
    if (el.deckEmptySyncReport) el.deckEmptySyncReport.hidden = true;
  } else {
    updateDeckEmptyStatus();
    renderWelcomeSyncReport();
  }
}

// Inline replacement for the old "Startup Sync Report" popup: the same
// per-deck breakdown, rendered directly on the welcome screen instead of a
// modal, so it's only ever seen where it's actually relevant (nothing else
// to look at) and never interrupts active use.
function renderWelcomeSyncReport() {
  const node = el.deckEmptySyncReport;
  if (!node) return;
  if (!lastStartupSyncReport) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  const { deckLog, pulled, pushed, failed } = lastStartupSyncReport;
  node.innerHTML = `<p class="deck-empty-sync-report-title">Startup Sync Report</p>${buildSyncReportHtml(deckLog, { pulled, pushed, failed })}`;
  node.hidden = false;
}

// Fills in the Sync Status / Your Decks rows on the "Recall" welcome screen so
// it's never a dead end — this is the same information the per-deck sync
// pill (setSyncIndicator) shows once a deck is loaded, plus the local
// library's deck count, laid out as two clearly labeled fields instead of one
// blended sentence. Called whenever that screen is shown, at the start/end of
// a reconcile, and on online/offline transitions.
function updateDeckEmptyStatus() {
  const syncNode = el.deckEmptySyncValue;
  const libraryNode = el.deckEmptyLibraryValue;
  if (!syncNode || !libraryNode) return;

  const count = listLocalDecks().length;
  libraryNode.textContent = count ? `${count} saved deck${count === 1 ? "" : "s"} on this device` : "No decks yet";

  if (!supabaseClient || !isSignedIn) {
    syncNode.textContent = "💾 Local only — sign in to back up to the cloud";
    return;
  }
  if (!navigator.onLine) {
    syncNode.textContent = "📴 Offline — will sync once you're back online";
    return;
  }
  if (reconcileInFlight) {
    syncNode.textContent = "🔄 Checking for updates from the cloud…";
    return;
  }
  if (localStorage.getItem(LAST_GLOBAL_SYNC_ERROR_KEY)) {
    syncNode.textContent = "⚠️ Sync failed — will retry automatically";
    return;
  }
  const lastSync = formatRelativeTime(localStorage.getItem(LAST_GLOBAL_SYNC_KEY));
  syncNode.textContent = lastSync ? `✅ Synced · last checked ${lastSync}` : "✅ Signed in and ready to sync";
}

// ---------------------------------------------------------------------------
// Two-way cloud mirror (last-write-wins per deck, by `updated_at` timestamp).
// The device keeps a full local copy of every cloud deck so the PWA works
// offline; when connectivity returns each deck is reconciled by comparing the
// local library's `updatedAt` against the cloud's `updated_at`.
// ---------------------------------------------------------------------------

// Normalizes any ISO / timestamptz string to epoch ms so timestamps written by
// the JS client and read back from Postgres compare correctly.
function tsMs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// The one shape every push/pull reports its diff in. Both directions fill the
// same fields so the report can describe them with one vocabulary — and so a
// change kind can never be silently invisible just because the side that
// detected it had nowhere to put it (recategorising a quick note used to land
// in exactly that gap, and the sync then claimed "nothing to sync").
function emptySyncStats() {
  return {
    cardsAdded: 0,
    cardsDeleted: 0,
    cardsEdited: 0,      // question/answer text
    cardsMoved: 0,       // reordered within the deck
    statusChanges: 0,    // known / review / unsorted
    categoryChanges: 0,  // a card's quick-note subject label
    notesChanged: false,
    titleChanged: false,
    deckCategoryChanged: false,
    noteCategoriesChanged: false  // the deck's category DEFINITIONS (decks.meta)
  };
}

// The counted stats (summed across decks), as opposed to the deck-level
// booleans below them, which are counted as "how many decks".
const SYNC_COUNT_STATS = ["cardsAdded", "cardsDeleted", "cardsEdited", "statusChanges", "cardsMoved", "categoryChanges"];
const SYNC_FLAG_STATS = ["notesChanged", "titleChanged", "deckCategoryChanged", "noteCategoriesChanged"];

// Human phrases for a diff, most consequential first. Returns an array so
// callers can join, count, or truncate it. With `asTotals`, the deck-level
// booleans have been summed into deck counts by totalSyncStats and say so.
function describeSyncStats(stats = {}, { asTotals = false } = {}) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (stats.cardsAdded) parts.push(`${plural(stats.cardsAdded, "card", "cards")} added`);
  if (stats.cardsDeleted) parts.push(`${plural(stats.cardsDeleted, "card", "cards")} deleted`);
  if (stats.cardsEdited) parts.push(`${plural(stats.cardsEdited, "card", "cards")} edited`);
  if (stats.statusChanges) parts.push(`${plural(stats.statusChanges, "card", "cards")} restacked (known/review)`);
  if (stats.cardsMoved) parts.push(`${plural(stats.cardsMoved, "card", "cards")} reordered`);
  if (stats.categoryChanges) parts.push(`${plural(stats.categoryChanges, "note", "notes")} recategorised`);
  const flag = (value, label) => {
    if (!value) return;
    parts.push(asTotals && value > 1 ? `${label} on ${value} decks` : label);
  };
  flag(stats.notesChanged, "notes edited");
  flag(stats.titleChanged, "deck renamed");
  flag(stats.deckCategoryChanged, "deck category changed");
  flag(stats.noteCategoriesChanged, "note categories added/renamed/removed");
  return parts;
}

// Did the deck's quick-note category DEFINITIONS change (added, renamed,
// recoloured, removed, reordered)? Compares through quickNoteCategoriesFromMeta
// so both sides are normalised the same way and a meta bag that's a JSON string
// on one side and a parsed object on the other doesn't read as a change.
function quickNoteCategoriesDiffer(metaA, metaB) {
  const key = (meta) => JSON.stringify(quickNoteCategoriesFromMeta(meta).map((c) => [c.id, c.name, c.color]));
  return key(metaA) !== key(metaB);
}

// A pull/push whose diff stats are all-zero is just a timestamp-alignment
// artifact (e.g. clock granularity between an edit-time stamp and a push-time
// stamp) — nothing actually moved, so it shouldn't be counted or reported as
// user-visible sync activity. Derived from describeSyncStats so a newly added
// stat can never be counted by one and ignored by the other.
function isNoOpStats(stats) {
  return describeSyncStats(stats).length === 0;
}

// Sums each change kind across every deck the sync touched, for the one-line
// summary. Booleans count the DECKS affected ("notes edited on 2 decks").
function totalSyncStats(deckLog) {
  const totals = emptySyncStats();
  for (const entry of deckLog) {
    if (entry.direction === "failed") continue;
    for (const key of SYNC_COUNT_STATS) totals[key] += entry[key] || 0;
    for (const key of SYNC_FLAG_STATS) {
      if (entry[key]) totals[key] = (totals[key] || 0) + 1;
    }
  }
  return totals;
}

// Pulls one cloud deck (metadata already in hand) plus its cards into the local
// library, WITHOUT disturbing the active in-memory deck. Stamps the local copy
// with the cloud's `updated_at` so they read as in sync afterwards.
// `prefetchedCards`: this deck's cloud rows in position order if the caller
// already batch-fetched them (see fetchCardsForDecks), else null to fetch here.
async function pullCloudDeckToLibrary(cloud, prefetchedCards = null) {
  let cards = prefetchedCards;
  if (!cards) {
    const { data, error } = await supabaseClient
      .from("cards")
      .select("*")
      .eq("deck_id", cloud.id)
      .order("position", { ascending: true });
    if (error) throw error;
    cards = data;
  }

  const snapshot = {
    app: "recall",
    version: 1,
    exportedAt: new Date().toISOString(),
    deckTitle: cloud.title || "",
    deckCategory: normalizeDeckCategory(cloud.category),
    notes: String(cloud.notes || ""),
    sourceTitle: cloud.title || "",
    importTitleHint: cloud.title || "",
    deckId: cloud.id,
    current: Number.isFinite(cloud.current_card_index) ? cloud.current_card_index : 0,
    // Deck-level bag (quick_notes' managed category set) — a pull that dropped
    // it left every pulled note pointing at categories this device no longer
    // knew the name or colour of.
    meta: cloud.meta && typeof cloud.meta === "object" ? cloud.meta : {},
    cards: (cards || []).map((c, i) => ({
      id: String(c.id || `${i}-${String(c.question || "").slice(0, 32)}`),
      question: c.question,
      answer: c.answer,
      status: normalizeCardStatus(c.status),
      category: c.category ? String(c.category) : null
    }))
  };

  const existing = readLocalDeckIndex().find((m) => String(m.deckId) === String(cloud.id));
  // Derived from cloud.id rather than a random generateLocalDeckId() when no
  // local entry exists yet: this "find existing, else create" isn't atomic
  // (read the index, then write it back), so two overlapping reconciles for
  // the SAME cloud deck — most commonly two tabs of the app open at once,
  // each with its own independent in-memory reconcile guard — can both miss
  // seeing each other's in-progress write and each mint a DIFFERENT random
  // id. Whichever's index write lands last "wins"; the other's snapshot is
  // never referenced by the index again and leaks in localStorage forever.
  // A deterministic id means both racing calls converge on the same key —
  // one just overwrites the other with equivalent data, no orphan created.
  const localId = existing?.id || `ld_cloud_${cloud.id}`;
  snapshot.localDeckId = localId;

  // Diff against whatever was on this device before we overwrite it below,
  // for the detailed sync report — a brand-new-to-this-device deck just
  // reports its total card count instead of an add/edit/delete breakdown.
  let stats;
  const oldRaw = existing ? localStorage.getItem(LOCAL_DECK_PREFIX + localId) : null;
  let oldSnapshot = null;
  // A corrupt snapshot must not abort the pull — it's about to be overwritten
  // with fresh cloud data anyway; only the report's diff falls back to "all new".
  try {
    oldSnapshot = oldRaw ? JSON.parse(oldRaw) : null;
  } catch {
    oldSnapshot = null;
  }
  if (oldSnapshot) {
    // noteAnchor is a device-local link (the cloud `cards` table has no column
    // for it), so the incoming rows never carry one. Re-attach the anchors this
    // device already had, or every pull would permanently break the quick-note
    // "jump to where this was pinned" button.
    const oldAnchorById = new Map(
      (oldSnapshot.cards || [])
        .filter((c) => c && c.noteAnchor)
        .map((c) => [String(c.id), c.noteAnchor])
    );
    if (oldAnchorById.size) {
      for (const card of snapshot.cards) {
        const anchor = oldAnchorById.get(String(card.id));
        if (anchor) card.noteAnchor = anchor;
      }
    }

    const oldStatusById = Object.fromEntries((oldSnapshot.cards || []).map((c) => [String(c.id), c.status]));
    // calculateSyncDiff(local, web) reports "added" as local-only and
    // "deleted" as web-only. Here "local"=old snapshot (the stale/outgoing
    // side) and "web"=new cloud data (the incoming side), so from the
    // pull's point of view those two are swapped: web-only cards are what
    // just arrived (added), and local-only cards are what's now gone
    // (deleted from this device's copy).
    const diff = calculateSyncDiff(oldSnapshot.cards || [], cards || [], oldStatusById, { fuzzy: false });
    // calculateSyncDiff already separates edits from restacks, moves and
    // recategorisations — keep them apart rather than summing them into one
    // "updated" count the report can't explain.
    stats = {
      ...emptySyncStats(),
      cardsAdded: diff.deleted,
      cardsDeleted: diff.added,
      cardsEdited: diff.edited,
      cardsMoved: diff.moved,
      statusChanges: diff.statusChanges,
      categoryChanges: diff.categoryChanges,
      notesChanged: syncTextChanged(oldSnapshot.notes || "", snapshot.notes),
      titleChanged: syncTextChanged(oldSnapshot.deckTitle || "", snapshot.deckTitle || ""),
      deckCategoryChanged: normalizeDeckCategory(oldSnapshot.deckCategory) !== normalizeDeckCategory(snapshot.deckCategory),
      // The quick-note category DEFINITIONS live in decks.meta, so a rename or
      // recolour on another device arrives here and nowhere else.
      noteCategoriesChanged: quickNoteCategoriesDiffer(oldSnapshot.meta, snapshot.meta)
    };
  } else {
    stats = { ...emptySyncStats(), cardsAdded: snapshot.cards.length, notesChanged: Boolean(snapshot.notes.trim()) };
  }

  localStorage.setItem(LOCAL_DECK_PREFIX + localId, JSON.stringify(snapshot));

  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory,
    cardCount: snapshot.cards.length,
    hasNotes: Boolean(snapshot.notes.trim()),
    updatedAt: cloud.updated_at || new Date().toISOString(),
    createdAt: cloud.created_at || existing?.createdAt || cloud.updated_at || new Date().toISOString(),
    // Distinct from updatedAt (which also bumps on plain local edits) — this
    // specifically means "last confirmed match with the cloud", surfaced in
    // the sync indicator pill.
    lastSyncedAt: cloud.updated_at || new Date().toISOString(),
    // Take whichever "last opened" is more recent — this device's own record,
    // or the cloud's (another device may have opened it more recently).
    accessedAt: laterIsoTimestamp(existing?.accessedAt, cloud.last_accessed_at),
    deckId: String(cloud.id),
  };
  writeLocalDeckIndex([meta, ...readLocalDeckIndex().filter((m) => m.id !== localId)]);
  return { localId, meta, stats };
}

// Pushes one library deck (by its local metadata) to the cloud, WITHOUT
// disturbing the active in-memory deck. Mints a stable cloud id if the deck has
// never been synced, then records it locally and aligns the timestamp.
async function pushLibraryDeckToCloud(localMeta, { cloudExists = false, cloudDeck = null, webCards = null } = {}) {
  const raw = localStorage.getItem(LOCAL_DECK_PREFIX + localMeta.id);
  if (!raw) throw new Error("Local deck snapshot missing");
  const snapshot = JSON.parse(raw);

  let deckId = snapshot.deckId || localMeta.deckId || null;
  let isNewDeck = !cloudExists;
  if (!deckId) {
    const base = slugifyFileName(snapshot.deckTitle || "deck") || "deck";
    deckId = `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    isNewDeck = true;
  }

  const now = new Date().toISOString();
  const title = snapshot.deckTitle || "Untitled Deck";
  const deckCategory = normalizeDeckCategory(snapshot.deckCategory);
  const pushStats = await pushDeckRowsToCloud({
    deckId,
    title,
    category: deckCategory,
    notes: snapshot.notes || "",
    currentIndex: snapshot.current,
    cards: (snapshot.cards || []).map((c) => ({
      id: c.id, question: c.question, answer: c.answer, status: normalizeCardStatus(c.status), category: c.category || null
    })),
    isNewDeck,
    overwrite: false,
    now,
    webCards,
    silent: true
  });

  snapshot.deckId = deckId;
  localStorage.setItem(LOCAL_DECK_PREFIX + localMeta.id, JSON.stringify(snapshot));
  const index = readLocalDeckIndex();
  const entry = index.find((m) => m.id === localMeta.id);
  if (entry) {
    entry.deckId = deckId;
    entry.updatedAt = now;
    entry.lastSyncedAt = now;
    writeLocalDeckIndex(index);
  }
  // If we just pushed the active deck (first sync), adopt its new cloud id.
  if (state.localDeckId === localMeta.id && !state.deckId) state.deckId = deckId;
  // Deck-level changes ride along on the same upsert as the cards, so they'd
  // otherwise go unreported — a rename or a notes edit on its own looked
  // identical to "nothing happened".
  const stats = { ...pushStats };
  if (isNewDeck) {
    stats.notesChanged = Boolean(String(snapshot.notes || "").trim());
  } else {
    stats.notesChanged = syncTextChanged(snapshot.notes, cloudDeck?.notes || "");
    stats.titleChanged = syncTextChanged(title, cloudDeck?.title || "");
    stats.deckCategoryChanged = normalizeDeckCategory(cloudDeck?.category) !== deckCategory;
  }
  return { now, stats };
}

let reconcileInFlight = false;
// Most recent background (non-explicit) sync's report, or null once nothing's
// left to show — rendered inline on the welcome screen, never as a modal.
let lastStartupSyncReport = null;

// The full bidirectional sync. Pulls every cloud deck that's missing locally or
// newer in the cloud; pushes every local deck that's new or newer locally.
async function reconcileAllDecks({ explicit = false } = {}) {
  if (!supabaseClient || !isSignedIn) {
    if (explicit) showToast("Sign in to sync with the cloud", "info");
    return;
  }
  if (!navigator.onLine) {
    if (explicit) showToast("Offline — your decks are safe on this device", "info");
    setSyncIndicator("offline");
    updateDeckEmptyStatus();
    return;
  }
  if (reconcileInFlight) return;
  reconcileInFlight = true;

  if (el.syncNowBtn) setButtonLoading(el.syncNowBtn, true, "Syncing…");
  setSyncIndicator("saving");
  updateDeckEmptyStatus();

  // Says what the sync is doing RIGHT NOW, not just that it's doing something.
  // On a slow connection the old single "Syncing all decks…" sat there for the
  // whole run, so a sync that was working through 12 decks was indistinguishable
  // from one that had hung. Writes the button text directly rather than calling
  // setButtonLoading again, which would capture "Syncing…" as the label to
  // restore and leave the button stuck on it.
  const progress = (message) => {
    if (!explicit) return;
    setStatus(message);
    if (el.syncNowBtn) el.syncNowBtn.textContent = message;
  };
  progress("Checking the cloud…");

  // Commit any open card editor into state first. Card edit text lives only in
  // the textarea (there's no live input listener, unlike the notes editor) until
  // a blur/commit event — and a background reconcile (the auto-sync when
  // connectivity returns) fires with no such event. Left uncommitted, the edit
  // isn't in state, so the flush below can't save it: if the cloud copy then
  // reads as "newer", the pull would reload the active deck and silently drop
  // the in-progress edit. Committing lands it in state so the flush persists it
  // and it wins the last-write-wins comparison. (Mirrors flushWorkingDeck, which
  // already does this on pagehide/visibilitychange for the same reason.)
  let committedActiveEdit = false;
  try {
    committedActiveEdit = commitEditIfActive();
  } catch (error) {
    console.warn("Could not commit active edit before sync", error);
  }

  // Flush any pending debounced autosave. Without this, an edit made in the last
  // ~400ms lives only in memory (deckAutosaveTimer hasn't fired), so the library
  // copy's `updatedAt` is stale — a cloud copy could then read as "newer" and
  // the pull below would overwrite and reload the deck, silently discarding that
  // in-flight edit. Flushing writes it out and bumps the timestamp so local
  // edits correctly win the last-write-wins comparison. Also runs when we just
  // committed an editor edit above, which schedules no timer of its own.
  if (deckAutosaveTimer || committedActiveEdit) {
    if (deckAutosaveTimer) {
      clearTimeout(deckAutosaveTimer);
      deckAutosaveTimer = null;
    }
    persistWorkingDeck();
    saveDeckToLibrary({ silent: true });
  }
  // commitEditIfActive updates state but doesn't re-render the card (it's
  // display-agnostic), so re-render the current card to show the committed text
  // rather than the stale pre-edit render left behind when the editor closed.
  // Local now wins last-write-wins, so the active deck won't be pulled/reloaded.
  if (committedActiveEdit) showCard();

  // A brand-new deck that's only in memory (never auto-saved) still belongs in
  // the mirror — add it so it gets pushed. Decks already in the library keep
  // their accurate timestamps and are left untouched here.
  if ((state.masterCards.length || state.notes.trim()) && !state.localDeckId) {
    saveDeckToLibrary({ silent: true });
  }

  const activeDeckId = state.deckId;
  let activePulledLocalId = null;
  let pulled = 0, pushed = 0, failed = 0;
  // Decks whose timestamp said "newer" but whose content already matched the
  // cloud. Not nothing: it's what a live write (e.g. recategorising a quick
  // note, which saves to the cloud the moment you tap it) looks like by the
  // time the sync runs — so the summary can say the changes are already safe
  // instead of the bare, alarming "nothing to sync".
  const alreadyMatched = [];
  // Per-deck breakdown for the detailed sync report — every deck actually
  // touched (or that failed) gets an entry naming it, its direction, and
  // exactly what changed (cards added/updated/deleted, notes).
  const deckLog = [];

  try {
    // Deliver any category edit that couldn't reach the cloud when it was made,
    // BEFORE reading the deck list. Order is the whole point: the pull below
    // overwrites the local snapshot's meta with the cloud's copy, so flushing
    // afterwards would be racing the very thing that erases the edit. Flushing
    // first also means the pull reads a cloud that already agrees with us, and
    // so reports no spurious category change.
    const noteCategoriesFlushed = await flushPendingQuickNoteCategories();

    // The deck list and the deletion tombstones don't depend on each other, so
    // fetch them together — serially they cost two full round trips before any
    // real work could start.
    const [cloudDecks, remoteDeletedIds] = await Promise.all([
      fetchCloudDeckList(),
      fetchDeletedDeckIds()
    ]);
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudIdSet = new Set(cloudDecks.map((d) => String(d.id)));

    // Cross-device delete: a deck this device never tombstoned locally, but
    // that another device deleted (and recorded in the shared deleted_decks
    // table). Adopt the tombstone and remove the stale local copy now, before
    // the push loop below would otherwise see "no cloud row, so mine must be
    // newer" and re-create it.
    const remoteDeletedSet = new Set(remoteDeletedIds.map(String));
    for (const deckId of remoteDeletedIds) {
      if (isDeckTombstoned(deckId)) continue;
      tombstoneDeck(deckId);
      const staleLocal = readLocalDeckIndex().find((m) => String(m.deckId) === String(deckId));
      if (staleLocal) {
        const wasActive = state.deckId && String(state.deckId) === String(deckId);
        deleteDeckFromLibrary(staleLocal.id);
        if (wasActive) resetActiveDeckAfterDelete();
      }
    }

    // Reconcile local tombstones against the cloud. A tombstone may only be
    // forgotten once the deck row is gone AND its durable cross-device record
    // (deleted_decks) is in place. Pruning on "row is gone" alone is unsafe:
    // if the original delete's deleted_decks write failed, another device that
    // still holds a copy would re-push it and resurrect the deck. When the row
    // is gone but that shared record is missing, re-assert it here and keep the
    // local tombstone until it lands.
    const tombstonesToReassert = [];
    for (const tid of Object.keys(readDeckTombstones())) {
      // Deck row still present (or re-pushed by another device) — the pull loop
      // below re-deletes it; keep blocking so it can't be adopted back locally.
      if (cloudIdSet.has(String(tid))) continue;
      if (remoteDeletedSet.has(String(tid))) {
        clearDeckTombstone(tid); // fully propagated — safe to forget
      } else {
        tombstonesToReassert.push({ deck_id: tid });
      }
    }
    if (tombstonesToReassert.length) {
      // One upsert for every outstanding tombstone rather than a round trip
      // each. supabase-js reports failures via the returned `error`, not by
      // throwing — check it, or a failed write looks like success.
      const { error: retryError } = await supabaseClient.from("deleted_decks").upsert(tombstonesToReassert);
      if (retryError) console.warn("Retry of cross-device delete tombstones failed", retryError);
    }

    // 1) Cloud → local: pull anything missing locally or newer in the cloud.
    //    Decide the whole list up front so the cards for every deck being
    //    pulled can be fetched in one request instead of one per deck.
    const localByDeckId = new Map(
      readLocalDeckIndex().filter((m) => m.deckId).map((m) => [String(m.deckId), m])
    );
    const toPull = [];
    const tombstonedInCloud = [];
    for (const cloud of cloudDecks) {
      // A deck deleted here but still (or again) present in the cloud — e.g. a
      // race with an in-flight sync, or another device that re-pushed it. Don't
      // pull it back; re-assert the deletion in the cloud instead.
      if (isDeckTombstoned(cloud.id)) {
        tombstonedInCloud.push(cloud.id);
        continue;
      }
      const localMeta = localByDeckId.get(String(cloud.id));
      if (!localMeta || tsMs(cloud.updated_at) > tsMs(localMeta.updatedAt)) toPull.push(cloud);
    }
    if (tombstonedInCloud.length) {
      const { error: redeleteError } = await supabaseClient.from("decks").delete().in("id", tombstonedInCloud);
      if (redeleteError) console.warn("Tombstone re-delete failed", tombstonedInCloud, redeleteError);
    }

    // The download is the batched fetch below — the loop after it only writes to
    // localStorage and never yields, so a per-deck "downloading 3 of 8" in there
    // would never get a chance to paint. Say it once, here, where the wait is.
    if (toPull.length) progress(`Downloading ${toPull.length} deck${toPull.length === 1 ? "" : "s"} from the cloud…`);
    const pullCardsByDeck = toPull.length
      ? await fetchCardsForDecks(toPull.map((d) => d.id))
      : new Map();

    for (const cloud of toPull) {
      try {
        const res = await pullCloudDeckToLibrary(cloud, pullCardsByDeck.get(String(cloud.id)) || []);
        if (!isNoOpStats(res.stats)) {
          pulled++;
          deckLog.push({ title: cloud.title || "Untitled deck", direction: "pulled", ...res.stats });
          // Only reload the on-screen deck when the pull actually changed its
          // content. A no-op pull (cloud read "newer" purely from a timestamp
          // artifact, with identical cards/notes) must NOT reload — doing so
          // would reset the user's live study position to the cloud's index
          // for no real reason.
          if (activeDeckId && String(cloud.id) === String(activeDeckId)) activePulledLocalId = res.localId;
        } else {
          alreadyMatched.push(cloud.title || "Untitled deck");
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: cloud.title || "Untitled deck", direction: "failed", error: e?.message || String(e) });
        console.warn("Reconcile pull failed", cloud.id, e);
      }
    }

    // 2) Local → cloud: push anything not in the cloud or newer locally.
    //    Re-read the index because the pull pass may have rewritten it, and
    //    again decide the whole list up front so every deck's existing cloud
    //    rows (which the push diffs against) come back in one request.
    const toPush = [];
    for (const localMeta of readLocalDeckIndex()) {
      // Never re-upload a deck that was deleted here (a stray local copy that
      // outlived the delete) — that's exactly how a deleted deck comes back.
      if (isDeckTombstoned(localMeta.deckId)) continue;
      const cloud = localMeta.deckId ? cloudById.get(String(localMeta.deckId)) : null;
      if (!cloud || tsMs(localMeta.updatedAt) > tsMs(cloud.updated_at)) toPush.push({ localMeta, cloud });
    }

    // Only decks that already exist in the cloud have rows to diff against; a
    // brand-new deck's push writes every card regardless.
    const pushDiffIds = toPush.filter((e) => e.cloud).map((e) => e.localMeta.deckId);
    const pushCardsByDeck = pushDiffIds.length
      ? await fetchCardsForDecks(pushDiffIds, "id, deck_id, question, answer, position, status, category")
      : new Map();

    let pushIndex = 0;
    for (const { localMeta, cloud } of toPush) {
      pushIndex++;
      progress(`Uploading “${localMeta.title || "Untitled deck"}” (${pushIndex} of ${toPush.length})…`);
      try {
        const res = await pushLibraryDeckToCloud(localMeta, {
          cloudExists: Boolean(cloud),
          cloudDeck: cloud,
          webCards: cloud ? (pushCardsByDeck.get(String(localMeta.deckId)) || []) : null
        });
        if (!isNoOpStats(res.stats)) {
          pushed++;
          deckLog.push({ title: localMeta.title || "Untitled deck", direction: "pushed", ...res.stats });
        } else {
          alreadyMatched.push(localMeta.title || "Untitled deck");
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: localMeta.title || "Untitled deck", direction: "failed", error: e?.message || String(e) });
        console.warn("Reconcile push failed", localMeta.id, e);
      }
    }

    // A flushed category edit is real sync work and has to show up in the
    // report. Fold it into the quick_notes deck's own row if the loops above
    // already logged one, so a single deck never appears twice.
    if (noteCategoriesFlushed) {
      const row = deckLog.find((e) => e.direction !== "failed" && e.title === QUICK_NOTES_DECK_TITLE);
      if (row) {
        row.noteCategoriesChanged = true;
      } else {
        deckLog.push({ title: QUICK_NOTES_DECK_TITLE, direction: "pushed", ...emptySyncStats(), noteCategoriesChanged: true });
        pushed++;
      }
    }

    // If the on-screen deck was refreshed from the cloud, reload it so the user
    // sees the newer content. (Local edits bump the timestamp, so this only
    // happens when the cloud copy genuinely won the last-write-wins.)
    if (activePulledLocalId) {
      loadDeckFromLibrary(activePulledLocalId);
    } else {
      refreshSyncIndicatorBaseline();
    }
    if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    localStorage.setItem(LAST_GLOBAL_SYNC_KEY, new Date().toISOString());
    localStorage.removeItem(LAST_GLOBAL_SYNC_ERROR_KEY);

    // Lead with the direction (how many decks moved, which way), then name the
    // actual changes — "2 decks uploaded" alone never said WHAT was uploaded.
    const parts = [];
    if (pulled) parts.push(`${pulled} deck${pulled === 1 ? "" : "s"} downloaded from the cloud`);
    if (pushed) parts.push(`${pushed} deck${pushed === 1 ? "" : "s"} uploaded to the cloud`);
    const changes = describeSyncStats(totalSyncStats(deckLog), { asTotals: true });
    const detail = changes.length ? ` — ${changes.join(", ")}` : "";
    // Name the decks that failed. "See console" asked the user to open devtools
    // to learn WHICH of their decks didn't make it — on a phone, where this app
    // mostly runs, that's not an option at all.
    const failedTitles = deckLog.filter((e) => e.direction === "failed").map((e) => e.title);
    const failedNote = failed
      ? `${failed} deck${failed === 1 ? "" : "s"} failed: ${failedTitles.slice(0, 2).join(", ")}` +
        `${failedTitles.length > 2 ? ` and ${failedTitles.length - 2} more` : ""}`
      : "";
    // "Nothing to sync" was the single most misleading string in the app: it's
    // also what you got right after recategorising a quick note, because that
    // change is written to the cloud the instant you make it, leaving the sync
    // genuinely nothing to carry. Say which of the two actually happened.
    const nothingMoved = alreadyMatched.length
      ? `Already up to date — ${alreadyMatched.length} deck${alreadyMatched.length === 1 ? "" : "s"} checked, ` +
        `everything already matches the cloud (board edits save as you make them)`
      : "Already up to date — nothing changed here or in the cloud since the last sync";
    const summary = parts.length
      ? `Sync complete — ${parts.join(", ")}${detail}${failed ? `. ${failedNote}` : ""}`
      : failed
        ? `Sync incomplete — ${failedNote}`
        : nothingMoved;
    if (explicit) {
      setStatus(summary);
      showToast(summary, failed ? "error" : "success");
      // Detailed report modal — only for the explicit "Sync Now" click, and
      // only when there's actually something to report.
      if (deckLog.length) showSyncReport(deckLog, { pulled, pushed, failed });
    } else {
      // Silent startup/reconnect sync never pops a modal — its report is
      // rendered inline on the welcome screen instead (see
      // renderWelcomeSyncReport), so it's only ever seen if that screen is
      // already what the user is looking at.
      lastStartupSyncReport = deckLog.length ? { deckLog, pulled, pushed, failed } : null;
      if (el.deckEmptyState && !el.deckEmptyState.hidden) renderDeckEmptyState(hasActiveDeck() ? "active" : "none");
    }
  } catch (error) {
    console.error("Reconcile failed", error);
    setSyncIndicator("error");
    localStorage.setItem(LAST_GLOBAL_SYNC_ERROR_KEY, "1");
    if (explicit) {
      // A dropped connection mid-sync is by far the most common failure, and
      // the raw error for it ("Failed to fetch") reads like a bug rather than
      // "your network went away" — say so in words the user can act on.
      const offlineNow = !navigator.onLine || /failed to fetch|networkerror|load failed/i.test(error?.message || "");
      const reason = offlineNow
        ? "Couldn't reach the cloud — check your connection"
        : error?.message || "Unknown error";
      setStatus(`Sync failed — ${reason}. Your decks are safe on this device.`, "error");
      showToast(`Sync failed — ${reason}`, "error");
    }
  } finally {
    reconcileInFlight = false;
    if (el.syncNowBtn) setButtonLoading(el.syncNowBtn, false);
    updateDeckEmptyStatus();
  }
}

function readLocalDeckIndex() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_DECKS_INDEX_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeLocalDeckIndex(list) {
  localStorage.setItem(LOCAL_DECKS_INDEX_KEY, JSON.stringify(list));
}

function generateLocalDeckId() {
  return `ld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Mirrors a card that was appended straight to a cloud deck (currently only
// saveQuickNote) into the matching local library entry, if one exists. Without
// this the local quick_notes snapshot's updatedAt stays behind the cloud's, so
// the next reconcile treats the cloud as newer and pulls it over any
// not-yet-synced local edit to that same deck — silently dropping it (see
// commit b72c48a for the conflict this is a partial, additive-only fix for).
function appendCardToLocalLibraryDeck(deckId, card, now) {
  if (!deckId) return;
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.deckId === deckId);
  if (!entry) return;
  const resolvedNow = now || new Date().toISOString();
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + entry.id);
    if (!raw) return;
    const snapshot = JSON.parse(raw);
    snapshot.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    snapshot.cards.push(card);
    localStorage.setItem(LOCAL_DECK_PREFIX + entry.id, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("Could not append card to local deck snapshot", error);
    return;
  }
  entry.cardCount = (entry.cardCount || 0) + 1;
  entry.updatedAt = resolvedNow;
  writeLocalDeckIndex(index);
}

// Keeps the local library mirror in step with a deck-metadata write that went
// straight to Supabase (a title/category edit from the active-deck menu, a
// list-row rename, or a bulk category change) — without this, the local
// copy's updatedAt stays behind the cloud's, so the next reconcile sees the
// cloud as "newer" and pulls it over any not-yet-synced local card edits,
// silently discarding them. Only patches title/category + updatedAt; leaves
// card content alone so it doesn't clobber other pending local edits.
function syncLocalLibraryMetaForDeck(deckId, { title, category, now } = {}) {
  if (!deckId) return;
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.deckId === deckId);
  if (!entry) return;
  const resolvedNow = now || new Date().toISOString();
  if (title !== undefined) entry.title = title;
  if (category !== undefined) entry.category = category;
  entry.updatedAt = resolvedNow;
  writeLocalDeckIndex(index);

  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + entry.id);
    if (raw) {
      const snapshot = JSON.parse(raw);
      if (title !== undefined) {
        snapshot.deckTitle = title;
        // Keep the title mirrors in step so a later loadDeckFromLibrary (which
        // reads sourceTitle first) can't resurrect the old name.
        snapshot.sourceTitle = title;
        snapshot.importTitleHint = title;
      }
      if (category !== undefined) snapshot.deckCategory = category;
      localStorage.setItem(LOCAL_DECK_PREFIX + entry.id, JSON.stringify(snapshot));
    }
  } catch (error) {
    console.warn("Could not update local deck snapshot metadata", error);
  }
}

// Newest first.
function listLocalDecks() {
  return readLocalDeckIndex()
    .slice()
    .sort((a, b) => String(b.accessedAt || b.updatedAt || "").localeCompare(String(a.accessedAt || a.updatedAt || "")));
}

// A content fingerprint of everything that counts as a real edit — title,
// category, notes, and each card's id/question/answer/status in order — but NOT
// the current-card position or the export timestamp. `updatedAt` (the field the
// whole two-way sync compares on) must bump ONLY when this changes; otherwise
// merely viewing or paging through a deck would make it read as "newer" than the
// cloud and overwrite a genuinely newer cloud edit on the next reconcile.
function deckContentSignature(snapshot) {
  if (!snapshot) return "";
  const cards = (snapshot.cards || []).map((c) => [
    String(c.id),
    normalizeSyncText(c.question),
    normalizeSyncText(c.answer),
    normalizeCardStatus(c.status),
  ].join("␟"));
  return JSON.stringify({
    title: normalizeSyncText(snapshot.deckTitle),
    category: normalizeDeckCategory(snapshot.deckCategory),
    notes: normalizeSyncText(snapshot.notes),
    cards,
  });
}

// Save the current deck into the local library. Re-saving the same deck (matched
// by local id, or by cloud deckId for decks pulled from the web) updates in place
// rather than creating a duplicate. Returns the stored metadata, or null on failure.
// `updatedAt` may be overridden to align the local copy's timestamp with the
// cloud's after a successful push (so two-way reconcile sees them in sync).
function saveDeckToLibrary({ id = null, silent = false, updatedAt = null, lastSyncedAt = undefined } = {}) {
  if (!state.masterCards.length && !state.notes.trim()) {
    if (!silent) setStatus("Add some cards or notes before saving a deck.", "error");
    return null;
  }
  const snapshot = deckSnapshot();
  let localId = id || state.localDeckId;
  if (!localId && snapshot.deckId) {
    const existing = readLocalDeckIndex().find((entry) => entry.deckId === snapshot.deckId);
    if (existing) localId = existing.id;
  }
  localId = localId || generateLocalDeckId();
  snapshot.localDeckId = localId;

  const previousEntry = readLocalDeckIndex().find((entry) => entry.id === localId);
  // Read the copy we're about to overwrite, BEFORE writing, so we can tell a
  // real content edit apart from a position-only / no-op save and keep the cloud
  // id from ever being dropped.
  let previousSnapshot = null;
  try {
    const prevRaw = localStorage.getItem(LOCAL_DECK_PREFIX + localId);
    if (prevRaw) previousSnapshot = JSON.parse(prevRaw);
  } catch { previousSnapshot = null; }
  if (!snapshot.deckId) snapshot.deckId = previousSnapshot?.deckId || previousEntry?.deckId || null;

  try {
    localStorage.setItem(LOCAL_DECK_PREFIX + localId, JSON.stringify(snapshot));
    lastSaveErrorWasQuota = false;
  } catch (error) {
    console.warn("Could not save deck to library", error);
    lastSaveErrorWasQuota = isQuotaExceededError(error);
    if (!silent) {
      setStatus(
        lastSaveErrorWasQuota
          ? "Could not save deck — device storage is full. Delete some old decks to free space."
          : `Could not save deck: ${error?.message || error?.name || "unknown error"}`,
        "error"
      );
    }
    return null;
  }

  // Only advance updatedAt when the content actually changed (or on an explicit
  // caller-supplied timestamp, e.g. aligning to the cloud after a push). A pure
  // navigation/position save keeps the deck's existing updatedAt so it stays in
  // sync with the cloud instead of falsely winning last-write-wins.
  const contentChanged = !previousSnapshot
    || deckContentSignature(previousSnapshot) !== deckContentSignature(snapshot);
  const resolvedUpdatedAt = updatedAt
    || (contentChanged ? new Date().toISOString() : (previousEntry?.updatedAt || new Date().toISOString()));

  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory || defaultDeckCategory,
    cardCount: snapshot.cards.length,
    hasNotes: Boolean(String(snapshot.notes || "").trim()),
    updatedAt: resolvedUpdatedAt,
    createdAt: previousEntry?.createdAt || new Date().toISOString(),
    lastSyncedAt: lastSyncedAt !== undefined ? lastSyncedAt : (previousEntry?.lastSyncedAt || null),
    // Preserved as-is here — only touchLocalDeckAccess (called on a genuine
    // open, not on every autosave) advances this.
    accessedAt: previousEntry?.accessedAt || null,
    deckId: snapshot.deckId || null,
  };
  writeLocalDeckIndex([meta, ...readLocalDeckIndex().filter((entry) => entry.id !== localId)]);
  state.localDeckId = localId;
  persistWorkingDeck();
  return meta;
}

function loadDeckFromLibrary(id) {
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + id);
    if (!raw) {
      setStatus("That saved deck could not be found.", "error");
      return false;
    }
    // A navigation door: remember where the user was before this deck replaces
    // it. Recorded only once the deck is known to exist — a failed open doesn't
    // move anyone.
    recordNavHistory();
    const payload = JSON.parse(raw);
    loadDeckSnapshot(payload, payload.sourceTitle || payload.deckTitle || "");
    state.localDeckId = id;
    persistWorkingDeck();
    refreshSyncIndicatorBaseline();
    refreshNavBack(); // arrived — now the button knows where "here" is
    return true;
  } catch (error) {
    console.warn("Could not load saved deck", error);
    setStatus("That saved deck is corrupted and could not be loaded.", "error");
    return false;
  }
}

function deleteDeckFromLibrary(id) {
  localStorage.removeItem(LOCAL_DECK_PREFIX + id);
  writeLocalDeckIndex(readLocalDeckIndex().filter((entry) => entry.id !== id));
  if (state.localDeckId === id) state.localDeckId = null;
  // Deleting a deck is the natural "free up space" action after a quota
  // failure latched autosave off — give the next edit a chance to retry
  // instead of requiring a full new-deck/page reload to recover.
  deckAutosaveStorageFailed = false;
}

// One-time cleanup for snapshots orphaned by the race in pullCloudDeckToLibrary
// (see its comment) — a deck snapshot written to LOCAL_DECK_PREFIX + id but
// never referenced by the index again after a losing race, so it sits in
// localStorage forever, invisible in My Decks, silently eating quota. Removes
// any LOCAL_DECK_PREFIX key whose id isn't in the current index. Safe: a
// snapshot only ever exists there if it was written alongside a matching
// index entry, so "not in the index" means nothing currently references it.
function pruneOrphanedDeckSnapshots() {
  const validIds = new Set(readLocalDeckIndex().map((entry) => String(entry.id)));
  // readLocalDeckIndex() returns [] both when the library is genuinely empty
  // AND when the index key is corrupt/unparseable (its own catch-and-return-[]).
  // Treating the latter as "nothing is valid" would delete every real
  // snapshot on the device. If the index is legitimately empty there's
  // nothing to prune anyway, so skipping costs nothing either way.
  if (!validIds.size) return 0;
  let removed = 0;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(LOCAL_DECK_PREFIX)) continue;
    const id = key.slice(LOCAL_DECK_PREFIX.length);
    if (!validIds.has(id)) {
      localStorage.removeItem(key);
      removed++;
    }
  }
  if (removed) console.log(`Cleaned up ${removed} orphaned local deck snapshot(s).`);
  return removed;
}

function readDeckTombstones() {
  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_DECK_TOMBSTONES_KEY) || "{}");
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function writeDeckTombstones(map) {
  localStorage.setItem(LOCAL_DECK_TOMBSTONES_KEY, JSON.stringify(map));
}

function isDeckTombstoned(deckId) {
  return deckId ? Boolean(readDeckTombstones()[String(deckId)]) : false;
}

function tombstoneDeck(deckId) {
  if (!deckId) return;
  const map = readDeckTombstones();
  map[String(deckId)] = new Date().toISOString();
  writeDeckTombstones(map);
}

function clearDeckTombstone(deckId) {
  if (!deckId) return;
  const map = readDeckTombstones();
  if (map[String(deckId)] !== undefined) {
    delete map[String(deckId)];
    writeDeckTombstones(map);
  }
}

// Clear the currently-open deck back to the empty home screen and cancel any
// pending autosave. Used when the deck you're looking at is deleted — without
// this, the lingering debounced save (or the next navigation on the still-
// visible deck) would call saveDeckToLibrary and re-create it as a brand-new
// local deck, resurrecting exactly what was just deleted.
function resetActiveDeckAfterDelete() {
  if (deckAutosaveTimer) {
    clearTimeout(deckAutosaveTimer);
    deckAutosaveTimer = null;
  }
  state.deckId = null;
  state.localDeckId = null;
  state.deckTitle = "";
  state.deckCategory = defaultDeckCategory;
  state.notes = "";
  state.sourceTitle = "";
  state.importTitleHint = "";
  state.masterCards = [];
  state.statusById = {};
  state.current = 0;
  resetStudyDeck(state.masterCards);
  try { localStorage.removeItem(deckStorageKey); } catch { /* storage may be unavailable */ }
  setViewMode("cards");
  closeAllCardsPanel();
  showCard();
}

// Delete a deck from EVERYWHERE it lives — the on-device library AND the cloud
// mirror — and tombstone its cloud id so a background reconcile (or another
// device still holding a copy) can't resurrect it. This is the only correct way
// to delete in a two-way mirror; deleting just one side always lets sync bring
// the deck back. `localId` and/or `deckId` may be given; a missing `deckId` is
// resolved from the local index. Returns { cloudError } (best-effort: the
// tombstone still blocks re-pull if the cloud delete fails and is retried later).
async function deleteDeckEverywhere({ localId = null, deckId = null } = {}) {
  if (localId && !deckId) {
    const meta = readLocalDeckIndex().find((m) => m.id === localId);
    deckId = meta?.deckId || null;
  }

  // Capture this BEFORE deleteDeckFromLibrary nulls state.localDeckId.
  const wasActiveDeck =
    (localId && state.localDeckId && String(localId) === String(state.localDeckId)) ||
    (deckId && state.deckId && String(deckId) === String(state.deckId));

  if (deckId) tombstoneDeck(deckId);
  if (localId) deleteDeckFromLibrary(localId);
  if (state.deckId && String(state.deckId) === String(deckId)) state.deckId = null;
  if (wasActiveDeck) resetActiveDeckAfterDelete();

  let cloudError = null;
  if (deckId && supabaseClient && isSignedIn && navigator.onLine) {
    // Record the durable cross-device tombstone FIRST — it's the signal every
    // other device relies on to not re-push its still-held copy (see
    // supabase_deck_tombstones.sql). Writing it before the row delete is
    // strictly safer: if the delete below fails, a device that adopts this
    // tombstone re-deletes the row (see the pull loop in reconcileAllDecks),
    // whereas the reverse order can delete the row but leave no record — and a
    // later reconcile would then prune the local tombstone and let the deck
    // resurrect. A failed write here (offline blip, or unmigrated project with
    // no deleted_decks table) is retried by reconcileAllDecks while the local
    // tombstone persists, so the deletion still eventually propagates.
    // supabase-js reports failures via the returned `error`, not by throwing.
    // A failed write here is retried by reconcileAllDecks while the local
    // tombstone persists, so the deletion still eventually propagates.
    const { error: tombstoneError } = await supabaseClient.from("deleted_decks").upsert({ deck_id: deckId });
    if (tombstoneError) console.warn("Could not record cross-device delete tombstone", tombstoneError);
    const { error } = await supabaseClient.from("decks").delete().eq("id", deckId);
    cloudError = error || null;
  }
  return { cloudError };
}

function renameDeckInLibrary(id, title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return;
  const index = readLocalDeckIndex();
  const entry = index.find((e) => e.id === id);
  if (entry) {
    entry.title = trimmed;
    entry.updatedAt = new Date().toISOString();
    writeLocalDeckIndex(index);
  }
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + id);
    if (raw) {
      const payload = JSON.parse(raw);
      payload.deckTitle = trimmed;
      // Keep sourceTitle in sync so the snapshot is self-consistent — without
      // this, loadDeckFromLibrary reads the stale sourceTitle and the card's
      // header reverts to the old name even though the index shows the new one.
      payload.sourceTitle = trimmed;
      payload.importTitleHint = trimmed;
      localStorage.setItem(LOCAL_DECK_PREFIX + id, JSON.stringify(payload));
    }
  } catch (error) {
    console.warn("Could not rename saved deck snapshot", error);
  }
  if (state.localDeckId === id) {
    state.deckTitle = trimmed;
    state.sourceTitle = trimmed;
    persistWorkingDeck();
  }
}

function cardsForScope(scope) {
  syncResults();
  if (scope === "known") return state.results.known;
  if (scope === "review") return state.results.review;
  if (scope === "uncategorized") return uncategorizedCards();
  return state.masterCards.length ? state.masterCards : state.cards;
}

function exportMarkdown(scope = "all") {
  const cards = cardsForScope(scope);
  const title = scope === "known" ? "Known" : scope === "review" ? "Review" : scope === "uncategorized" ? "Uncategorized" : "All Cards";
  const uncategorized = uncategorizedCards();
  const output = [
    `# ${state.deckTitle || "Flashcard Export"}`,
    "",
    `Category: ${state.deckCategory || defaultDeckCategory}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    formatCardList(title, cards),
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Known", state.results.known) : null,
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Review", state.results.review) : null,
    scope === "all" ? "" : null,
    scope === "all" ? formatCardList("Uncategorized", uncategorized) : null,
    scope === "all" && state.notes.trim() ? "" : null,
    scope === "all" && state.notes.trim() ? notesExportBlock(state.notes) : null
  ].filter((line) => line !== null).join("\n");

  const blob = new Blob([output], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportBaseName(scope)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${title.toLowerCase()} as Markdown.`);
}

function exportJson() {
  if (!state.masterCards.length && !state.notes.trim()) {
    setStatus("No cards to export.", "error");
    return;
  }

  const blob = new Blob([`${JSON.stringify(deckSnapshot(), null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exportBaseName("all")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus("Exported all cards and markers as JSON.");
}

function fitLiveQuestion() {
  const node = el.questionView;
  const face = node?.closest(".card-question");
  if (!node) return;

  node.style.fontSize = "";
  node.style.transform = "";
  node.style.width = "";
  node.style.removeProperty("--question-fit-font-size");

  if (!face || !node.textContent.trim()) return;
  if (face.clientHeight <= 0 || face.clientWidth <= 0) return;

  const settings = normalizeStyleSettings(state.styleSettings);
  const faceStyle = getComputedStyle(face);
  const paddingY = (parseFloat(faceStyle.paddingTop) || 0) + (parseFloat(faceStyle.paddingBottom) || 0);
  const paddingX = (parseFloat(faceStyle.paddingLeft) || 0) + (parseFloat(faceStyle.paddingRight) || 0);
  const rowGap = parseFloat(faceStyle.rowGap || faceStyle.gap) || 0;
  const visibleItems = Array.from(face.children).filter((child) => {
    if (child === node || child.hidden) return child === node;
    return getComputedStyle(child).display !== "none";
  });
  const occupiedHeight = visibleItems.reduce((total, child) => {
    if (child === node) return total;
    const childStyle = getComputedStyle(child);
    return total
      + child.getBoundingClientRect().height
      + (parseFloat(childStyle.marginTop) || 0)
      + (parseFloat(childStyle.marginBottom) || 0);
  }, 0);
  const gapHeight = Math.max(visibleItems.length - 1, 0) * rowGap;
  const lineHeight = parseFloat(settings.questionLineHeight) || parseFloat(styleDefaults.questionLineHeight) || 1.18;
  const fillRatio = Math.min(Math.max((parseFloat(settings.questionFillPercent) || parseFloat(styleDefaults.questionFillPercent)) / 100, 0.1), 0.95);
  const maxQuestionFontSize = numericStyleValue(settings.questionMaxFontSize) ?? numericStyleValue(styleDefaults.questionMaxFontSize) ?? 64;
  const availableHeight = Math.max(face.clientHeight - paddingY - occupiedHeight - gapHeight, 1);
  const availableWidth = Math.max(face.clientWidth - paddingX, 1);
  // Pre-measure fixed-height elements (code blocks / scrollable children) whose height
  // doesn't change as we vary --question-fit-font-size, so the target can account for them.
  const isScrollableChild = (child) => {
    const s = getComputedStyle(child);
    return s.overflowX === "auto" || s.overflowX === "scroll"
      || s.overflow === "auto" || s.overflow === "scroll";
  };
  const fixedContentHeight = Array.from(node.children).reduce((sum, child) => {
    if (getComputedStyle(child).display === "none") return sum;
    if (!isScrollableChild(child)) return sum;
    const s = getComputedStyle(child);
    return sum + child.getBoundingClientRect().height
      + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
  }, 0);
  // Space available for scalable text after reserving room for code blocks
  const textAvailableHeight = Math.max(availableHeight - fixedContentHeight, 1);
  const targetHeight = Math.max(textAvailableHeight * fillRatio, 1);
  const searchCeiling = Math.max(1, Math.min(maxQuestionFontSize, 360, targetHeight / Math.max(lineHeight, 0.1) * 2.2, availableWidth * 1.6));
  let low = 1;
  let high = searchCeiling;
  let best = low;

  if (node.clientWidth <= 0) node.style.width = `${availableWidth}px`;

  const questionContentSize = () => {
    const children = Array.from(node.children).filter((child) => getComputedStyle(child).display !== "none");
    if (!children.length) {
      const nodeStyle = getComputedStyle(node);
      const h = parseFloat(nodeStyle.lineHeight) || node.scrollHeight;
      return { width: Math.min(node.scrollWidth, Math.max(node.clientWidth, availableWidth)), height: h, fitHeight: h };
    }

    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let width = 0;
    let fitHeight = 0;  // sum of scalable (text) element heights — not a bounding box

    children.forEach((child) => {
      const childStyle = getComputedStyle(child);
      const scrollable = isScrollableChild(child);
      const rect = child.getBoundingClientRect();
      const marginTop = parseFloat(childStyle.marginTop) || 0;
      const marginRight = parseFloat(childStyle.marginRight) || 0;
      const marginBottom = parseFloat(childStyle.marginBottom) || 0;
      const marginLeft = parseFloat(childStyle.marginLeft) || 0;
      top = Math.min(top, rect.top - marginTop);
      right = Math.max(right, rect.right + marginRight);
      bottom = Math.max(bottom, rect.bottom + marginBottom);
      left = Math.min(left, rect.left - marginLeft);
      // Use rendered rect.width for scrollable elements — their scrollWidth includes
      // off-screen code that doesn't overflow the container visually
      const effectiveWidth = scrollable ? rect.width : child.scrollWidth;
      width = Math.max(width, rect.width + marginLeft + marginRight, effectiveWidth + marginLeft + marginRight);
      // Accumulate only scalable children for the fit-height — summing, not bounding box,
      // so a code block sandwiched between text elements doesn't inflate the measurement
      if (!scrollable) {
        fitHeight += rect.height + marginTop + marginBottom;
      }
    });

    return {
      width: Math.max(width, right - left),
      height: Math.max(0, bottom - top),
      fitHeight
    };
  };

  const fits = () => {
    const contentSize = questionContentSize();
    // No scalable text (question is only a code block) — nothing to fit, use max size
    if (contentSize.fitHeight === 0) return true;
    return contentSize.width <= Math.max(node.clientWidth, availableWidth) + 4
      && contentSize.fitHeight <= targetHeight + 2
      && contentSize.fitHeight <= textAvailableHeight + 2;
  };

  for (let index = 0; index < 10; index += 1) {
    const mid = (low + high) / 2;
    node.style.setProperty("--question-fit-font-size", `${mid}px`);
    if (fits()) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  node.style.setProperty("--question-fit-font-size", `${Math.min(maxQuestionFontSize, Math.max(1, best - 0.5))}px`);
}

function scheduleLiveQuestionFit() {
  cancelAnimationFrame(liveQuestionFitFrame);
  liveQuestionFitFrame = requestAnimationFrame(() => {
    liveQuestionFitFrame = requestAnimationFrame(fitLiveQuestion);
  });
}

function afterPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function scopeTitle(scope = "all") {
  if (scope === "known") return "Known Cards";
  if (scope === "review") return "Review Cards";
  if (scope === "uncategorized") return "Uncategorized Cards";
  return "All Cards";
}

function closePrintPreview() {
  printPreviewOpen = false;
  el.printRoot.classList.remove("is-preparing", "is-preview");
  el.printRoot.innerHTML = "";
  el.printRoot.setAttribute("aria-hidden", "true");
  document.querySelector(`#${pdfPrintStyleId}`)?.remove();
  if (printTitleBeforeExport) document.title = printTitleBeforeExport;
  printTitleBeforeExport = "";
  unlockPageScroll();
}

function cardOrdinalLabel(index) {
  return `Q${index + 1}`;
}

function isPrintDeckDivider(entry) {
  return entry?.type === "deck-divider";
}

function printableCardCount(entries = []) {
  return entries.filter((entry) => !isPrintDeckDivider(entry)).length;
}

function cornellDeckDividerHtml(entry) {
  return `
    <article class="cornell-print-deck-divider">
      <span>Deck</span>
      <h2>${escapeHtml(entry.title || "Untitled")}</h2>
      <p>Category: ${escapeHtml(normalizeDeckCategory(entry.category))}</p>
    </article>
  `;
}

function cornellCardHtml(card, index, { answerVisible = false, print = false, statusById = state.statusById } = {}) {
  const status = normalizeCardStatus(statusById[card.id] || card.status);
  const statusLabel = cardStatusLabel(status);
  const rowClass = print ? "cornell-print-row" : "all-card cornell-card";
  const openClass = answerVisible ? " is-flipped" : "";
  const idAttr = print ? "" : ` data-card-id="${escapeHtml(card.id)}" data-status="${escapeHtml(status)}" data-answer-rendered="${answerVisible ? "true" : "false"}"`;
  const draggableAttr = print ? "" : ` tabindex="0" draggable="true"`;
  const answerHtml = answerVisible ? markdownToSafeHtml(card.answer) : "";
  // Use clean class names for print — strip interactive all-card-* classes that have display:none rules
  const questionClass = print ? "cornell-question-rail" : "cornell-question-rail all-card-question";
  const answerClass = print ? "cornell-answer-cell" : "cornell-answer-cell all-card-answer";

  return `
    <article class="${rowClass}${openClass}"${idAttr}${draggableAttr}>
      <aside class="${questionClass}">
        <span class="cornell-row-number">${cardOrdinalLabel(index)}</span>
        <div class="rendered">${markdownToSafeHtml(card.question)}</div>
      </aside>
      <section class="${answerClass}">
        <div class="cornell-row-head">
          ${print ? "" : `<span class="all-card-status-label cornell-status" data-all-status-label data-status="${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>`}
          ${print ? "" : `
            <div class="all-card-actions" aria-label="Card controls">
              <button class="all-card-goto" type="button" data-all-goto title="Go to card in main view" aria-label="Go to card in main view">&#128065;</button>
              <button class="all-card-add" type="button" data-all-add-after title="Insert card after this one" aria-label="Insert card after this one">+</button>
              <button class="all-card-edit" type="button" data-all-edit-current title="Edit question" aria-label="Edit question">&#9998;</button>
              <button class="all-card-review" type="button" data-all-status="review">Review</button>
              <button class="all-card-known" type="button" data-all-status="known">Known</button>
              <button class="all-card-delete" type="button" data-all-delete title="Delete card" aria-label="Delete card">&#128465;</button>
            </div>
          `}
        </div>
        <div class="cornell-answer-body rendered">${answerHtml}</div>
        ${print ? "" : `<div class="cornell-answer-cue">Tap row to ${answerVisible ? "hide" : "show"} answer</div>`}
      </section>
    </article>
  `;
}

function buildCornellPrintDocument(title, cards, scope, options = {}) {
  const total = printableCardCount(cards);
  const sourceTitle = options.sourceTitle || state.deckTitle || state.sourceTitle || "Recall";
  const statusById = options.statusById || state.statusById;
  let cardIndex = 0;
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(sourceTitle)}</h1>
          <p>${total} ${total === 1 ? "card" : "cards"} · ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section class="cornell-print-table" aria-label="${escapeHtml(title)} Cornell notes">
        ${cards.map((entry) => {
          if (isPrintDeckDivider(entry)) return cornellDeckDividerHtml(entry);
          const html = cornellCardHtml(entry, cardIndex, { answerVisible: true, print: true, statusById });
          cardIndex += 1;
          return html;
        }).join("\n")}
      </section>
    </div>
  `;
}

// ── Standalone HTML export ──────────────────────────────────────────────
// A Cornell layout built from <table> (not flex/grid) so the same markup
// reads fine both as a self-contained HTML file and — for the .docx export
// further below, which shares this same rendering step — inside a real
// Word document. Math/Mermaid/Nomnoml are baked to static markup by
// rendering off-screen in el.printRoot first, same as the Cornell PDF flow,
// so the exported file needs no JS to display right.
let cachedExportStylesheetCss = null;

async function fetchExportStylesheetCss() {
  if (cachedExportStylesheetCss != null) return cachedExportStylesheetCss;
  const hrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).map((link) => link.href);
  const chunks = await Promise.all(hrefs.map(async (href) => {
    try {
      const response = await fetch(href);
      if (!response.ok) return "";
      return await response.text();
    } catch (error) {
      console.warn("Could not inline stylesheet for standalone export:", href, error);
      return "";
    }
  }));
  cachedExportStylesheetCss = chunks.join("\n");
  return cachedExportStylesheetCss;
}

// Only feeds the standalone HTML export (the .docx export builds its own
// WordprocessingML further below and never touches this CSS) — a real
// browser resolves var(...) fine, so this stays var()-based rather than
// baking in literal colors.
function exportExtraCss() {
  return `
    html, body { margin: 0; background: var(--bg, #eef2f2); color: var(--text, #17201c); }
    body { padding: 24px; font-family: var(--app-font-family, Arial, Helvetica, sans-serif); }
    .flat-export-document { max-width: 900px; margin: 0 auto; }
    .flat-export-cover { margin-bottom: 24px; border-bottom: 2px solid var(--line, #b9c9c5); padding-bottom: 12px; }
    .flat-export-cover h1 { margin: 0 0 6px; font-size: 1.6em; }
    .flat-export-cover p { margin: 0; color: var(--muted, #56645f); }
    .flat-export-notes { padding-top: 4px; }
    .flat-export-divider { margin: 20px 0; }
    .flat-export-divider td {
      border: 1px dashed var(--line, #b9c9c5);
      border-radius: 10px;
      padding: 10px 14px;
      text-align: center;
    }
    .flat-export-divider span { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted, #56645f); }
    .flat-export-divider h2 { margin: 4px 0; }

    /* Cornell-style two-column card, built as a <table> (not flex/grid) so
       Word's HTML filter — which drops modern layout CSS — still renders the
       question/answer columns side by side instead of stacking them. */
    table.cornell-flat-row {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      margin-bottom: 18px;
      border: 2px solid var(--line, #b9c9c5);
      page-break-inside: avoid;
    }
    .cornell-flat-question, .cornell-flat-answer { padding: 14px 16px; vertical-align: top; }
    .cornell-flat-question {
      width: 34%;
      background: var(--panel-2, #f0eee7);
      border-right: 2px solid var(--line, #b9c9c5);
      font-weight: 700;
    }
    .cornell-flat-answer { background: var(--card, #ffffff); }
    .cornell-flat-row-number {
      display: inline-block;
      min-width: 20px;
      padding: 2px 7px;
      margin-bottom: 8px;
      border: 1px solid var(--accent, #16796c);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      color: var(--accent-strong, #0d5e53);
    }
    .flat-export-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
      color: var(--muted, #56645f);
      margin-bottom: 6px;
    }

    /* Rendered markdown prose (questions/answers/notes). */
    .rendered { color: var(--text, #17201c); }
    .rendered h1, .rendered h2, .rendered h3, .rendered h4, .rendered h5, .rendered h6 { color: var(--text, #17201c); margin: 0.5em 0 0.3em; }
    .rendered p { margin: 0 0 0.6em; }
    .rendered ul, .rendered ol { margin: 0 0 0.6em; padding-left: 1.4em; }
    .rendered blockquote { margin: 0 0 0.6em; padding-left: 12px; border-left: 3px solid var(--accent, #16796c); color: var(--muted, #56645f); }
    .rendered a { color: var(--accent-strong, #0d5e53); }
    .rendered code { background: var(--panel-2, #f0eee7); padding: 1px 5px; border-radius: 4px; font-family: "Courier New", monospace; }
    .rendered pre { background: var(--panel-2, #f0eee7); border: 1px solid var(--line, #b9c9c5); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
    .rendered pre code { background: none; padding: 0; }
    .rendered table { border-collapse: collapse; width: 100%; margin: 0 0 0.6em; }
    .rendered th, .rendered td { border: 1px solid var(--line, #b9c9c5); padding: 6px 8px; }
    img { max-width: 100%; }
    .export-image-fallback {
      display: inline-block;
      padding: 3px 10px;
      border: 1px dashed var(--line, #b9c9c5);
      border-radius: 6px;
      color: var(--accent-strong, #0d5e53);
      text-decoration: none;
    }
  `;
}

async function buildExportStyleTag() {
  const css = await fetchExportStylesheetCss();
  return `<style>${css}\n${exportExtraCss()}</style>`;
}

// Table-based Cornell layout for HTML/Word export — a real <table> (not the
// flex .cornell-question-rail/.cornell-answer-cell the app and PDF print use)
// so the question/answer columns still sit side by side once Word's HTML
// filter strips out anything it doesn't understand.
function cornellFlatCardHtml(card, index, { statusById = state.statusById } = {}) {
  const status = normalizeCardStatus(statusById[card.id] || card.status);
  const statusLabel = cardStatusLabel(status);
  return `
    <table class="cornell-flat-row" cellspacing="0" cellpadding="0">
      <tr>
        <td class="cornell-flat-question">
          <span class="cornell-flat-row-number">${cardOrdinalLabel(index)}</span>
          <div class="rendered">${markdownToSafeHtml(card.question)}</div>
        </td>
        <td class="cornell-flat-answer">
          <span class="flat-export-label">${escapeHtml(statusLabel)}</span>
          <div class="rendered">${markdownToSafeHtml(card.answer)}</div>
        </td>
      </tr>
    </table>
  `;
}

function cornellFlatDeckDividerHtml(entry) {
  return `
    <table class="flat-export-divider" cellspacing="0" cellpadding="0" width="100%">
      <tr><td>
        <span>Deck</span>
        <h2>${escapeHtml(entry.title || "Untitled")}</h2>
        <p>Category: ${escapeHtml(normalizeDeckCategory(entry.category))}</p>
      </td></tr>
    </table>
  `;
}

function buildCornellFlatDocument(title, cards, options = {}) {
  const total = printableCardCount(cards);
  const sourceTitle = options.sourceTitle || state.deckTitle || state.sourceTitle || "Recall";
  const statusById = options.statusById || state.statusById;
  let cardIndex = 0;
  const cardsHtml = cards.map((entry) => {
    if (isPrintDeckDivider(entry)) return cornellFlatDeckDividerHtml(entry);
    const html = cornellFlatCardHtml(entry, cardIndex, { statusById });
    cardIndex += 1;
    return html;
  }).join("\n");
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(sourceTitle)}</h1>
      <p>${escapeHtml(title)} &middot; ${total} ${total === 1 ? "card" : "cards"} &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="cornell-flat-cards" aria-label="${escapeHtml(title)} cards">
      ${cardsHtml}
    </section>
  `;
}

function buildNotesExportBody(title, notesMarkdown) {
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(title)}</h1>
      <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="flat-export-notes rendered">
      ${markdownToSafeHtml(notesMarkdown)}
    </section>
  `;
}

// Notes have no Cornell table (no fixed question/answer columns), so unlike
// the card PDF they just flow as regular paragraphs — the layout that was
// splitting oddly across pages for cards was the fixed-height Cornell rows,
// which don't apply here.
function buildNotesPrintDocument(title, notesMarkdown) {
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section class="rendered" aria-label="${escapeHtml(title)} notes">
        ${markdownToSafeHtml(notesMarkdown)}
      </section>
    </div>
  `;
}

// The bulk (multi-deck) counterpart of buildNotesExportBody/buildNotesPrintDocument
// — used when a bulk export picks "Notes". `sections` is [{ title, category, notes }];
// a single section renders exactly like the single-deck body, multiple sections get
// the same deck-divider treatment the cards PDF already uses between decks.
function notesFlatSectionsHtml(sections) {
  if (sections.length === 1) {
    return `<div class="rendered">${markdownToSafeHtml(sections[0].notes || "*No notes for this deck.*")}</div>`;
  }
  return sections.map((section) => `
    ${cornellDeckDividerHtml({ title: section.title, category: section.category })}
    <div class="rendered">${markdownToSafeHtml(section.notes || "*No notes for this deck.*")}</div>
  `).join("");
}

function buildNotesFlatDocument(title, sections) {
  return `
    <header class="flat-export-cover">
      <h1>${escapeHtml(title)}</h1>
      <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
    </header>
    <section class="flat-export-notes">
      ${notesFlatSectionsHtml(sections)}
    </section>
  `;
}

function buildNotesFlatPrintDocument(title, sections) {
  return `
    <div class="print-preview-actions" data-print-ui>
      <button type="button" data-print-close>Close</button>
      <button type="button" data-print-now>Download PDF</button>
    </div>
    <div class="cornell-print-document">
      <header class="cornell-print-cover">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Study Notes &middot; ${new Date().toLocaleString()}</p>
        </div>
      </header>
      <section aria-label="${escapeHtml(title)} notes">
        ${notesFlatSectionsHtml(sections)}
      </section>
    </div>
  `;
}

// Bulk counterpart of exportNotesPdf() — combines every selected deck's notes
// into one print-preview document instead of the single active deck's own.
async function exportNotesFlatPdf(payloads, { fileBaseName, title }) {
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
  printTitleBeforeExport = document.title;
  document.title = fileBaseName;
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesFlatPrintDocument(title, sections);
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

// Renders off-screen in el.printRoot (same trick exportCardsPdf uses) so
// math/diagrams are baked to static markup, then hands back plain HTML.
// Word only ever sees the file we hand it (no live network fetch the way a
// browser does while printing), and a saved standalone HTML file is meant to
// keep working with no connection at all — so every <img src> pointing at a
// remote URL gets pulled down once here and turned into a data: URI.
//
// Some remote hosts (private Drive shares, hotlink protection, rate limits)
// respond 200 with an HTML sign-in/error page instead of image bytes, or
// reject the cross-origin fetch outright. Embedding that response verbatim
// produces an unreadable image (Word shows this as a broken "Read Error"
// tile), so any src that doesn't resolve to real image bytes is swapped for
// a plain link instead — broken but honest, rather than silently corrupt.
function unembeddableImageFallback(img, src) {
  const link = document.createElement("a");
  link.className = "export-image-fallback";
  link.href = src;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = img.getAttribute("alt")?.trim() || "View image";
  return link;
}

async function embedImagesAsDataUris(container) {
  const images = Array.from(container.querySelectorAll("img[src]"));
  let failedCount = 0;
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) return;
    try {
      const response = await fetch(src, { mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error(`Not image bytes (got ${blob.type || "unknown"})`);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", dataUrl);
    } catch (error) {
      console.warn("Could not embed image for export, linking to original instead:", src, error);
      failedCount += 1;
      img.replaceWith(unembeddableImageFallback(img, src));
    }
  }));
  return failedCount;
}

// Mounts + renders + embeds into el.printRoot and leaves it mounted (unlike
// prepareExportHtml, which serializes it to a string and tears it down).
// The .docx builder needs the live DOM — real <img>/<svg> elements it can
// rasterize with their actual pixel dimensions — not a string it would have
// to re-parse, so it shares this step and calls finishExportRoot() itself
// once it's done reading the DOM.
async function prepareExportRoot(bodyHtml) {
  el.printRoot.innerHTML = bodyHtml;
  el.printRoot.classList.remove("is-preview");
  el.printRoot.classList.add("is-preparing");
  el.printRoot.setAttribute("aria-hidden", "true");
  configureMermaid("print");
  try {
    await enhanceRenderedMarkdown(el.printRoot);
  } finally {
    configureMermaid(currentThemeId());
  }
  const failedImageCount = await embedImagesAsDataUris(el.printRoot);
  await (document.fonts?.ready || Promise.resolve());
  await afterPaint();
  return failedImageCount;
}

function finishExportRoot() {
  el.printRoot.innerHTML = "";
  el.printRoot.classList.remove("is-preparing");
  el.printRoot.setAttribute("aria-hidden", "true");
}

async function prepareExportHtml(bodyHtml) {
  const failedImageCount = await prepareExportRoot(bodyHtml);
  const html = el.printRoot.innerHTML;
  finishExportRoot();
  return { html, failedImageCount };
}

// A real browser (unlike Word) resolves var() fine, so the standalone HTML
// export embeds the actual stylesheet plus the live inline custom-property
// overrides from the style settings panel (fonts, sizes, widths, theme) —
// opening the file reproduces the exact look of the app when it was
// exported, not just its default theme.
async function wrapStandaloneHtmlDocument(bodyHtml, title) {
  const styleTag = await buildExportStyleTag();
  const liveStyle = document.documentElement.getAttribute("style") || "";
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(currentThemeId())}" style="${escapeHtml(liveStyle)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styleTag}
</head>
<body>
<div class="flat-export-document">
${bodyHtml}
</div>
</body>
</html>`;
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

let cachedCrc32Table = null;
function crc32Table() {
  if (cachedCrc32Table) return cachedCrc32Table;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  cachedCrc32Table = table;
  return table;
}

function crc32(bytes) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

// Minimal ZIP writer — STORE method only (no compression). No zip library
// is available in this project, so this hand-rolls just enough of the ZIP
// spec (local file headers, central directory, end record) to produce a
// valid archive any zip/docx reader — including Word itself — can open.
function buildZipArchive(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBytes = utf8Bytes(name);
    const checksum = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, 0, true);
    localHeader.setUint16(12, 0, true);
    localHeader.setUint32(14, checksum, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    localChunks.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, 0, true);
    centralHeader.setUint16(14, 0, true);
    centralHeader.setUint32(16, checksum, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    centralChunks.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  });

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const endRecord = new DataView(new ArrayBuffer(22));
  endRecord.setUint32(0, 0x06054b50, true);
  endRecord.setUint16(4, 0, true);
  endRecord.setUint16(6, 0, true);
  endRecord.setUint16(8, files.length, true);
  endRecord.setUint16(10, files.length, true);
  endRecord.setUint32(12, centralSize, true);
  endRecord.setUint32(16, centralStart, true);
  endRecord.setUint16(20, 0, true);

  const allChunks = [...localChunks, ...centralChunks, new Uint8Array(endRecord.buffer)];
  const totalLength = allChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  allChunks.forEach((chunk) => {
    result.set(chunk, pos);
    pos += chunk.length;
  });
  return result;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[ --]/g, "");
}

function hex6(value, fallback) {
  const clean = String(value || "").replace(/^#/, "").trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image for Word export"));
    img.src = src;
  });
}

// Re-encodes any image (jpeg/png/gif/webp/whatever a browser can decode) to
// PNG via canvas — guarantees a single, universally Word-safe media type
// regardless of the source format's quirks.
async function rasterizeToPng(src) {
  const img = await loadImageElement(src);
  const width = img.naturalWidth || img.width || 300;
  const height = img.naturalHeight || img.height || 200;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const buffer = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buffer), widthPx: width, heightPx: height };
}

async function svgElementToPngBytes(svg) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const width = Math.max(1, Math.round(rect.width) || Math.round(viewBox?.width) || 400);
  const height = Math.max(1, Math.round(rect.height) || Math.round(viewBox?.height) || 300);
  const clone = svg.cloneNode(true);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const serialized = new XMLSerializer().serializeToString(clone);
  const svgSrc = `data:image/svg+xml;base64,${bytesToBase64(utf8Bytes(serialized))}`;
  return rasterizeToPng(svgSrc);
}

// Walks the already-rendered export DOM once, rasterizing every real <img>
// (embedImagesAsDataUris already turned remote URLs into data: URIs, or
// swapped unreadable ones for a plain <a> fallback link — nothing left to
// do for those) and every <svg> diagram (mermaid/nomnoml) to PNG bytes,
// keyed by element so the XML walk below can look each one up directly.
async function collectDocxMedia(container) {
  const media = [];
  const elementMedia = new Map();
  let mediaIndex = 0;

  const images = Array.from(container.querySelectorAll("img[src]"));
  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src || !src.startsWith("data:")) continue;
    try {
      const { bytes, widthPx, heightPx } = await rasterizeToPng(src);
      mediaIndex += 1;
      const rId = `rIdImage${mediaIndex}`;
      media.push({ rId, name: `image${mediaIndex}.png`, bytes });
      elementMedia.set(img, { rId, widthPx, heightPx });
    } catch (error) {
      console.warn("Could not rasterize image for Word export:", src, error);
    }
  }

  const svgs = Array.from(container.querySelectorAll("svg"));
  for (const svg of svgs) {
    try {
      const { bytes, widthPx, heightPx } = await svgElementToPngBytes(svg);
      mediaIndex += 1;
      const rId = `rIdImage${mediaIndex}`;
      media.push({ rId, name: `image${mediaIndex}.png`, bytes });
      elementMedia.set(svg, { rId, widthPx, heightPx });
    } catch (error) {
      console.warn("Could not rasterize diagram for Word export:", error);
    }
  }

  return { media, elementMedia };
}

function docxImageExtent(widthPx, heightPx, maxWidthIn) {
  const emuPerPx = 9525;
  const maxWidthEmu = Math.round(maxWidthIn * 914400);
  let widthEmu = Math.round(widthPx * emuPerPx);
  let heightEmu = Math.round(heightPx * emuPerPx);
  if (widthEmu > maxWidthEmu && widthEmu > 0) {
    const scale = maxWidthEmu / widthEmu;
    widthEmu = maxWidthEmu;
    heightEmu = Math.round(heightEmu * scale);
  }
  return { widthEmu: Math.max(1, widthEmu), heightEmu: Math.max(1, heightEmu) };
}

function ooxmlInlineImageRun(rId, widthEmu, heightEmu, docPrId, name) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${escapeXml(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function ooxmlRunProps(props, theme) {
  const parts = [];
  if (props.bold) parts.push("<w:b/>");
  if (props.italic) parts.push("<w:i/>");
  if (props.underline) parts.push('<w:u w:val="single"/>');
  if (props.strike) parts.push("<w:strike/>");
  if (props.code) {
    parts.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="${theme.panel2}"/>`);
  }
  if (props.color) parts.push(`<w:color w:val="${hex6(props.color, theme.text)}"/>`);
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function ooxmlTextRun(text, props, theme) {
  if (!text) return "";
  return `<w:r>${ooxmlRunProps(props, theme)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// Recursive inline (run-level) HTML→OOXML walk. `ctx` carries render-wide
// state (media lookup, hyperlink relationships, theme colors, doc-level
// counters); `props` carries the current run formatting inherited from
// ancestor tags (bold/italic/underline/strike/color/monospace) plus the
// max width (in inches) images should be constrained to in this context.
function inlineRunsForNode(node, ctx, props) {
  if (node.nodeType === Node.TEXT_NODE) {
    return ooxmlTextRun(node.textContent, props, ctx.theme);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();

  if (node.dataset && node.dataset.tex) {
    return ooxmlTextRun(decodeURIComponent(node.dataset.tex), { ...props, code: true }, ctx.theme);
  }
  if (tag === "br") return "<w:r><w:br/></w:r>";
  if (tag === "script" || tag === "style") return "";

  if (tag === "img" || tag === "svg") {
    const info = ctx.elementMedia.get(node);
    if (!info) return "";
    ctx.docPrCounter.value += 1;
    const { widthEmu, heightEmu } = docxImageExtent(info.widthPx, info.heightPx, props.maxWidthIn);
    const name = tag === "img" ? (node.getAttribute("alt") || "image") : "diagram";
    return ooxmlInlineImageRun(info.rId, widthEmu, heightEmu, ctx.docPrCounter.value, name);
  }

  if (tag === "a" && node.getAttribute("href")) {
    const href = node.getAttribute("href");
    const rId = ctx.getHyperlinkRelId(href);
    const linkProps = { ...props, color: ctx.theme.accentStrong, underline: true };
    const inner = Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, linkProps)).join("");
    return `<w:hyperlink r:id="${rId}" w:history="1">${inner || ooxmlTextRun(href, linkProps, ctx.theme)}</w:hyperlink>`;
  }

  const nextProps = { ...props };
  if (tag === "strong" || tag === "b") nextProps.bold = true;
  if (tag === "em" || tag === "i") nextProps.italic = true;
  if (tag === "u") nextProps.underline = true;
  if (tag === "del") nextProps.strike = true;
  if (tag === "kbd" || tag === "code") nextProps.code = true;
  if (tag === "font") {
    const color = node.getAttribute("color");
    if (color) nextProps.color = color;
  }

  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, nextProps)).join("");
}

function childInlineRuns(node, ctx, props) {
  return Array.from(node.childNodes).map((child) => inlineRunsForNode(child, ctx, props)).join("");
}

function ooxmlParagraph(runsXml, pProps = {}) {
  const parts = [];
  if (pProps.styleId) parts.push(`<w:pStyle w:val="${pProps.styleId}"/>`);
  if (pProps.numId) parts.push(`<w:numPr><w:ilvl w:val="${pProps.ilvl || 0}"/><w:numId w:val="${pProps.numId}"/></w:numPr>`);
  if (pProps.jc) parts.push(`<w:jc w:val="${pProps.jc}"/>`);
  if (pProps.indentLeftTwips) parts.push(`<w:ind w:left="${pProps.indentLeftTwips}"/>`);
  const borders = [];
  if (pProps.borderLeftColor) borders.push(`<w:left w:val="single" w:sz="18" w:space="8" w:color="${pProps.borderLeftColor}"/>`);
  if (pProps.borderBottomColor) borders.push(`<w:bottom w:val="single" w:sz="6" w:space="1" w:color="${pProps.borderBottomColor}"/>`);
  if (borders.length) parts.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
  if (pProps.shadeFill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${pProps.shadeFill}"/>`);
  if (pProps.spacingAfter != null) parts.push(`<w:spacing w:after="${pProps.spacingAfter}"/>`);
  const pPr = parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

function mergeOverride(base, override) {
  return { ...override, ...base };
}

function withScope(ctx, patch) {
  return { ...ctx, ...patch };
}

const DOCX_HEADING_STYLE_BY_LEVEL = { 1: "Heading1", 2: "Heading2", 3: "Heading3", 4: "Heading4", 5: "Heading4", 6: "Heading4" };
const DOCX_NESTED_BLOCK_TAGS = new Set(["ul", "ol", "p", "pre", "blockquote", "table", "div"]);

function childBlocks(node, ctx) {
  const blocks = [];
  Array.from(node.childNodes).forEach((child) => {
    blocksForNode(child, ctx).forEach((block) => blocks.push(block));
  });
  return blocks;
}

function blocksForListItem(li, ctx, numId) {
  const inlineChildren = [];
  const nestedElements = [];
  Array.from(li.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && DOCX_NESTED_BLOCK_TAGS.has(child.tagName.toLowerCase())) {
      nestedElements.push(child);
    } else {
      inlineChildren.push(child);
    }
  });
  const runs = inlineChildren.map((child) => inlineRunsForNode(child, ctx, ctx.inlineProps)).join("");
  const itemProps = mergeOverride({ numId, ilvl: Math.min(ctx.listDepth, 3), spacingAfter: 40 }, ctx.blockOverride);
  const blocks = [ooxmlParagraph(runs, itemProps)];
  nestedElements.forEach((nested) => {
    const tag = nested.tagName.toLowerCase();
    const nestedCtx = tag === "ul" || tag === "ol" ? withScope(ctx, { listDepth: ctx.listDepth + 1 }) : ctx;
    blocksForNode(nested, nestedCtx).forEach((block) => blocks.push(block));
  });
  return blocks;
}

function tcXml(cellBlocks, { widthTwips, shadeFill, theme } = {}) {
  const parts = [];
  if (widthTwips) parts.push(`<w:tcW w:w="${widthTwips}" w:type="dxa"/>`);
  if (shadeFill) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shadeFill}"/>`);
  parts.push(`<w:tcBorders><w:top w:val="single" w:sz="4" w:color="${theme.line}"/><w:left w:val="single" w:sz="4" w:color="${theme.line}"/><w:bottom w:val="single" w:sz="4" w:color="${theme.line}"/><w:right w:val="single" w:sz="4" w:color="${theme.line}"/></w:tcBorders>`);
  const tcPr = `<w:tcPr>${parts.join("")}</w:tcPr>`;
  const body = cellBlocks.length ? cellBlocks.join("") : ooxmlParagraph("");
  return `<w:tc>${tcPr}${body}</w:tc>`;
}

const DOCX_PAGE_WIDTH_TWIPS = 10080;

function tableToOoxml(table, ctx) {
  const theme = ctx.theme;
  const borderBlock = `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="${theme.line}"/><w:left w:val="single" w:sz="4" w:color="${theme.line}"/><w:bottom w:val="single" w:sz="4" w:color="${theme.line}"/><w:right w:val="single" w:sz="4" w:color="${theme.line}"/><w:insideH w:val="single" w:sz="4" w:color="${theme.line}"/><w:insideV w:val="single" w:sz="4" w:color="${theme.line}"/></w:tblBorders>`;

  if (table.classList.contains("cornell-flat-row")) {
    const questionTd = table.querySelector(".cornell-flat-question");
    const answerTd = table.querySelector(".cornell-flat-answer");
    const questionWidth = Math.round(DOCX_PAGE_WIDTH_TWIPS * 0.34);
    const answerWidth = DOCX_PAGE_WIDTH_TWIPS - questionWidth;
    const questionBlocks = questionTd ? childBlocks(questionTd, withScope(ctx, { maxWidthIn: questionWidth / 1440 })) : [];
    const answerBlocks = answerTd ? childBlocks(answerTd, withScope(ctx, { maxWidthIn: answerWidth / 1440 })) : [];
    return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/>${borderBlock}</w:tblPr><w:tblGrid><w:gridCol w:w="${questionWidth}"/><w:gridCol w:w="${answerWidth}"/></w:tblGrid><w:tr>${tcXml(questionBlocks, { widthTwips: questionWidth, shadeFill: theme.panel2, theme })}${tcXml(answerBlocks, { widthTwips: answerWidth, shadeFill: theme.card, theme })}</w:tr></w:tbl>`;
  }

  if (table.classList.contains("flat-export-divider")) {
    const cell = table.querySelector("td") || table;
    const blocks = childBlocks(cell, withScope(ctx, { blockOverride: mergeOverride({ jc: "center" }, ctx.blockOverride) }));
    return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/><w:tblBorders><w:top w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:left w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:bottom w:val="dashed" w:sz="6" w:color="${theme.line}"/><w:right w:val="dashed" w:sz="6" w:color="${theme.line}"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="${DOCX_PAGE_WIDTH_TWIPS}"/></w:tblGrid><w:tr>${tcXml(blocks, { widthTwips: DOCX_PAGE_WIDTH_TWIPS, theme })}</w:tr></w:tbl>`;
  }

  // Genuine markdown table.
  const rows = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"));
  const columnCount = rows.reduce((max, row) => Math.max(max, row.children.length), 0) || 1;
  const colWidth = Math.round(DOCX_PAGE_WIDTH_TWIPS / columnCount);
  const cellCtx = withScope(ctx, { maxWidthIn: colWidth / 1440 });
  const rowsXml = rows.map((row) => {
    const cellsXml = Array.from(row.children).map((cell) => {
      const isHeader = cell.tagName.toLowerCase() === "th";
      const blocks = childBlocks(cell, cellCtx);
      return tcXml(blocks.length ? blocks : [ooxmlParagraph(childInlineRuns(cell, cellCtx, cellCtx.inlineProps))], {
        widthTwips: colWidth,
        shadeFill: isHeader ? theme.panel2 : undefined,
        theme
      });
    }).join("");
    return `<w:tr>${cellsXml}</w:tr>`;
  }).join("");

  return `<w:tbl><w:tblPr><w:tblW w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:type="dxa"/>${borderBlock}</w:tblPr><w:tblGrid>${"<w:gridCol w:w=\"" + colWidth + "\"/>".repeat(columnCount)}</w:tblGrid>${rowsXml}</w:tbl>`;
}

// Recursive block-level HTML→OOXML walk, dispatched by tag name. Produces
// an array of block XML strings (each a <w:p> paragraph or a <w:tbl>
// table) — never nested inside one another, matching how WordprocessingML
// requires block content to be siblings under <w:body> or <w:tc>.
function blocksForNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, " ");
    return text.trim() ? [ooxmlParagraph(ooxmlTextRun(text, ctx.inlineProps, ctx.theme), ctx.blockOverride)] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const tag = node.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "button") return [];

  if (/^h[1-6]$/.test(tag)) {
    const runs = childInlineRuns(node, ctx, ctx.inlineProps);
    return [ooxmlParagraph(runs, mergeOverride({ styleId: DOCX_HEADING_STYLE_BY_LEVEL[Number(tag[1])], spacingAfter: 120 }, ctx.blockOverride))];
  }

  if (tag === "p") {
    const runs = childInlineRuns(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ spacingAfter: 160 }, ctx.blockOverride))] : [];
  }

  if (tag === "hr") {
    return [ooxmlParagraph("", mergeOverride({ borderBottomColor: ctx.theme.line, spacingAfter: 160 }, ctx.blockOverride))];
  }

  // Diagrams (mermaid/nomnoml) render as a bare <svg> sitting directly
  // inside a block-level wrapper div, not inside a <p> — so unlike an <img>
  // (which marked.js always wraps in a paragraph), this needs its own
  // block case. Without it, the fallback below would descend into the
  // SVG's internal <text> elements and leak out raw diagram label text
  // instead of embedding the rasterized image.
  if (tag === "svg" || tag === "img") {
    const runs = inlineRunsForNode(node, ctx, ctx.inlineProps);
    return runs ? [ooxmlParagraph(runs, mergeOverride({ jc: "center", spacingAfter: 160 }, ctx.blockOverride))] : [];
  }

  if (tag === "blockquote") {
    const nextOverride = mergeOverride({ indentLeftTwips: 360, borderLeftColor: ctx.theme.accent }, ctx.blockOverride);
    return childBlocks(node, withScope(ctx, { blockOverride: nextOverride, inlineProps: { ...ctx.inlineProps, color: ctx.theme.muted } }));
  }

  if (tag === "ul" || tag === "ol") {
    const numId = tag === "ul" ? ctx.bulletNumId : ctx.decimalNumId;
    const blocks = [];
    Array.from(node.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      blocksForListItem(li, ctx, numId).forEach((block) => blocks.push(block));
    });
    return blocks;
  }

  if (tag === "pre") {
    const codeEl = node.querySelector("code") || node;
    const text = codeEl.textContent.replace(/\n+$/, "");
    const lines = text.length ? text.split("\n") : [""];
    return lines.map((line) => ooxmlParagraph(
      ooxmlTextRun(line || " ", { ...ctx.inlineProps, code: true }, ctx.theme),
      mergeOverride({ shadeFill: ctx.theme.panel2, spacingAfter: 0 }, ctx.blockOverride)
    ));
  }

  if (tag === "table") {
    return [tableToOoxml(node, ctx)];
  }

  return childBlocks(node, ctx);
}

function createDocxRenderContext(elementMedia, theme) {
  const hyperlinkCache = new Map();
  const hyperlinks = [];
  return {
    elementMedia,
    theme,
    docPrCounter: { value: 0 },
    hyperlinks,
    getHyperlinkRelId(url) {
      if (hyperlinkCache.has(url)) return hyperlinkCache.get(url);
      const rId = `rIdLink${hyperlinks.length + 1}`;
      hyperlinks.push({ rId, url });
      hyperlinkCache.set(url, rId);
      return rId;
    },
    bulletNumId: 1,
    decimalNumId: 2,
    blockOverride: {},
    inlineProps: { maxWidthIn: DOCX_PAGE_WIDTH_TWIPS / 1440 },
    listDepth: 0
  };
}

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
async function buildDocxBytes(bodyHtml, title) {
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
function imageEmbedSuffix(failedImageCount) {
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

async function exportCardsPdf(sourceTitle, cards, options = {}) {
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
  printTitleBeforeExport = document.title;
  document.title = fileBaseName;

  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, "all", { sourceTitle, statusById });
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
  printTitleBeforeExport = document.title;
  document.title = exportBaseName(scope);
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildCornellPrintDocument(title, cards, scope);
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
  printTitleBeforeExport = document.title;
  document.title = notesExportBaseName();
  try {
    await afterPaint();
    el.printRoot.innerHTML = buildNotesPrintDocument(title, notes);
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

async function fetchText(url) {
  const direct = await fetch(url, { mode: "cors" });
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
      text = await fetchText(url);
    } catch {
      text = await fetchText(readerUrlFor(url));
    }

    el.sourceInput.value = text;
    const source = stripReaderMetadata(text);
    const cards = parseCards(source);

    if (!cards.length && countQuestionHeadings(source)) {
      state.cards = [];
      state.masterCards = [];
      state.statusById = {};
      state.previewCard = null;
      state.deckId = null;
      state.deckTitle = "";
      state.deckCategory = defaultDeckCategory;
      state.notes = "";
      state.sourceTitle = "";
      state.importTitleHint = url;
      state.current = 0;
      resetResults();
      setViewMode("cards");
      setStatus("This public Notion URL only exposes collapsed question headings, not answers. Use Export -> Markdown & CSV, then upload the zip or paste the exported Markdown.", "error");
      showCard();
      return;
    }

    setStatus("Fetched source. Building cards...");
    buildCards(url);
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
async function uploadEpubImageWithRetry(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadImageToSupabase(file);
    } catch (error) {
      const worthRetrying = error?.message !== "NOT_SIGNED_IN" && !error?.authFailed;
      if (!worthRetrying || attempt >= EPUB_IMAGE_UPLOAD_ATTEMPTS) throw error;
      // 600ms, 1.2s, 2.4s — enough for a per-minute rate limit window to
      // drain a little between attempts instead of hammering through it and
      // burning every remaining image in the book.
      await new Promise((resolve) => setTimeout(resolve, EPUB_IMAGE_RETRY_BASE_MS * 2 ** (attempt - 1)));
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
async function uploadEpubImages(zip, imageEntries, progress) {
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
      urlMap.set(path, await uploadEpubImageWithRetry(optimized));
    } catch (error) {
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
    <div class="epub-progress-bar"><div class="epub-progress-fill"></div></div>
    <div class="category-choice-actions">
      <button type="button" data-epub-stop>Cancel</button>
    </div>
  `;
  shell.querySelector(".epub-progress-title").textContent = `Importing “${title}”`;

  modal.appendChild(shell);
  document.body.appendChild(modal);

  const line = shell.querySelector(".epub-progress-line");
  const fill = shell.querySelector(".epub-progress-fill");
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
async function runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode = "chapters") {
  const progress = showEpubProgress(bookTitle);
  try {
    const { urlMap: imageUrlMap, failed: failedImages, reason: imageFailReason } =
      await uploadEpubImages(zip, imageEntries, progress);
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
    const savedState = {
      deckId: state.deckId, localDeckId: state.localDeckId, deckTitle: state.deckTitle,
      deckCategory: state.deckCategory, notes: state.notes, masterCards: state.masterCards,
      sourceTitle: state.sourceTitle
    };

    const sanitizedTitle = bookTitle.replace(/\//g, "-").trim() || "Imported Book";
    const parentFolder = currentMyDecksFolder();
    let folderPath;
    let saved = 0;
    let saveFailed = false;

    if (mode === "book") {
      // Whole-book mode: one deck, no book-named folder — each chapter's
      // title survives as a "##" heading inside the single note, so the
      // existing in-note table of contents still gives chapter-by-chapter
      // navigation without creating a deck per chapter.
      folderPath = parentFolder;
      const combinedMarkdown = chapters.map((c) => `## ${c.title}\n\n${c.markdown}`).join("\n\n---\n\n");
      setStatus(`Saving "${bookTitle}"…`);
      progress.update(`Saving "${bookTitle}"…`, 0.9);
      state.deckId = null;
      state.localDeckId = null;
      state.deckTitle = sanitizedTitle;
      state.deckCategory = folderPath;
      state.notes = combinedMarkdown;
      state.masterCards = [];
      state.sourceTitle = sanitizedTitle;
      if (saveDeckToLibrary({ silent: true })) saved = 1;
      else saveFailed = true;
    } else {
      folderPath = normalizeDeckCategory(parentFolder ? `${parentFolder}${FOLDER_SEP}${sanitizedTitle}` : sanitizedTitle);
      addKnownFolder(folderPath);

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
        state.deckCategory = folderPath;
        state.notes = chapters[i].markdown;
        state.masterCards = [];
        state.sourceTitle = chapters[i].title;
        // A book is many decks in one go, so this is the realistic way to hit
        // the storage quota. saveDeckToLibrary returns null (never throws) on
        // failure — ignoring that would leave a half-imported book behind a
        // "Done" toast.
        if (!saveDeckToLibrary({ silent: true, updatedAt: new Date(baseTime - i * 1000).toISOString() })) {
          saveFailed = true;
          break;
        }
        saved += 1;
      }
    }

    Object.assign(state, savedState);
    persistWorkingDeck();

    setMyDecksView("folder");
    setMyDecksCwd(folderPath);
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
  } finally {
    progress.close();
  }
}

// Entry point wired to the "Import EPUB" button's file input.
async function importEpubFile(file) {
  if (!file) return;
  if (!window.JSZip) {
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

  await runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode);
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

async function loadZipFile(file, append = false) {
  if (!window.JSZip) {
    setStatus("Zip support did not load. Extract the zip and upload the .md file.", "error");
    return;
  }

  try {
    setStatus("Reading zip export...");
    const markdownFiles = await collectMarkdownFromZip(file);

    if (!markdownFiles.length) {
      setStatus("No Markdown file found in this zip export, including nested zip files.", "error");
      return;
    }

    const markdown = markdownFiles
      .map((entry) => `<!-- Source: ${entry.name} -->\n\n${entry.text}`)
      .join("\n\n---\n\n");
    el.sourceInput.value = markdown;
    state.importTitleHint = markdownFiles.length === 1 ? markdownFiles[0].name : file.name;
    setStatus(`Loaded ${markdownFiles.length} Markdown file${markdownFiles.length === 1 ? "" : "s"} from ${file.name}.`);
    buildCards(state.importTitleHint, append);
  } catch (error) {
    setStatus("Could not read this zip export.", "error");
  }
}

function loadFile(file, append = false) {
  if (!file) return;

  // Must precede the zip branch: an EPUB *is* a zip, and its "application/
  // epub+zip" type matches the /zip/i test below — without this it fell into
  // the markdown-in-a-zip reader and dead-ended on "No Markdown file found".
  if (isEpubName(file.name) || /epub/i.test(file.type)) {
    importEpubFile(file);
    return;
  }

  if (isZipName(file.name) || /zip/i.test(file.type)) {
    loadZipFile(file, append);
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const text = String(reader.result || "");

    if (isJsonName(file.name) || file.type === "application/json") {
      try {
        loadDeckSnapshot(JSON.parse(text), file.name, append);
        el.sourceInput.value = "";
        setStatus(`Loaded ${state.masterCards.length} card${state.masterCards.length === 1 ? "" : "s"} from ${file.name}.`);
        closeImportPanel();
      } catch (error) {
        setStatus("Could not read this flashcard JSON export.", "error");
      }
      return;
    }

    el.sourceInput.value = text;
    state.importTitleHint = file.name;
    setStatus(`Loaded ${file.name}.`);
    buildCards(state.importTitleHint, append);
  });
  reader.addEventListener("error", () => setStatus("Could not read the selected file.", "error"));
  reader.readAsText(file);
}

function loadSample() {
  el.sourceInput.value = sampleMarkdown;
  state.importTitleHint = "Sample flashcards";
  setStatus("Sample loaded.");
  buildCards(state.importTitleHint);
}

function resetPastePreview(message = "Paste Markdown and click Preview.", summary = "No preview yet") {
  pastePreviewSource = "";
  pastePreviewCards = [];
  if (el.pastePreviewSummary) el.pastePreviewSummary.textContent = summary;
  if (el.pastePreviewList) {
    el.pastePreviewList.innerHTML = `<div class="paste-preview-empty">${escapeHtml(message)}</div>`;
  }
  if (el.pasteImportBtn) el.pasteImportBtn.disabled = true;
}

function closePasteEditor(clear = false) {
  if (el.pasteEditorPanel) el.pasteEditorPanel.hidden = true;
  if (clear && el.pasteMarkdownInput) el.pasteMarkdownInput.value = "";
  resetPastePreview();
}

function openPasteEditor(append = false) {
  pasteImportAppend = append;

  if (el.pasteEditorTitle) {
    el.pasteEditorTitle.textContent = append ? "Paste Markdown Cards" : "Paste Markdown Deck";
  }
  if (el.pasteEditorHint) {
    el.pasteEditorHint.textContent = append
      ? "Append pasted Markdown cards to the current deck."
      : "Replace the current deck with pasted Markdown.";
  }
  if (el.pasteImportBtn) {
    el.pasteImportBtn.textContent = append ? "Import Pasted Cards" : "Import Pasted Deck";
  }
  if (el.pasteMarkdownInput) {
    el.pasteMarkdownInput.placeholder = append
      ? "Paste Markdown cards here"
      : "Paste Markdown deck here";
  }
  if (el.pasteEditorPanel) el.pasteEditorPanel.hidden = false;
  resetPastePreview();

  window.setTimeout(() => el.pasteMarkdownInput?.focus(), 0);
}

async function previewPastedMarkdown() {
  const markdown = el.pasteMarkdownInput?.value || "";
  if (!markdown.trim()) {
    setStatus("Paste Markdown before importing.", "error");
    el.pasteMarkdownInput?.focus();
    resetPastePreview("Paste Markdown to generate a preview.", "No preview");
    return;
  }

  const cards = parseCards(markdown);
  if (!cards.length) {
    const headingCount = countQuestionHeadings(markdown);
    const message = headingCount
      ? `Found ${headingCount} question heading${headingCount === 1 ? "" : "s"}, but no answer text.`
      : "No cards found in this Markdown.";
    resetPastePreview(message, "0 cards");
    setStatus(message, "error");
    return;
  }

  pastePreviewSource = markdown;
  pastePreviewCards = cards;
  if (el.pastePreviewSummary) {
    el.pastePreviewSummary.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"}`;
  }
  if (el.pastePreviewList) {
    el.pastePreviewList.innerHTML = cards.map((card, index) => `
      <article class="paste-preview-card">
        <div class="paste-preview-card-head">Card ${index + 1}</div>
        <div class="paste-preview-card-side">
          <span class="paste-preview-card-label">Question</span>
          <div class="rendered">${markdownToSafeHtml(card.question)}</div>
        </div>
        <div class="paste-preview-card-side">
          <span class="paste-preview-card-label">Answer</span>
          <div class="rendered">${markdownToSafeHtml(card.answer)}</div>
        </div>
      </article>
    `).join("");
    await enhanceRenderedMarkdown(el.pastePreviewList);
  }
  if (el.pasteImportBtn) el.pasteImportBtn.disabled = false;
  setStatus(`Previewed ${cards.length} card${cards.length === 1 ? "" : "s"}.`);
}

async function importPastedMarkdown() {
  const markdown = el.pasteMarkdownInput?.value || "";
  if (!markdown.trim()) {
    setStatus("Paste Markdown before importing.", "error");
    el.pasteMarkdownInput?.focus();
    resetPastePreview("Paste Markdown to generate a preview.", "No preview");
    return;
  }

  if (!pastePreviewCards.length || pastePreviewSource !== markdown) {
    await previewPastedMarkdown();
    if (!pastePreviewCards.length || pastePreviewSource !== markdown) return;
  }

  el.sourceInput.value = markdown;
  const titleHint = pasteImportAppend
    ? state.importTitleHint || state.deckTitle || "Pasted cards"
    : "";
  state.importTitleHint = titleHint;
  setStatus(pasteImportAppend ? "Importing pasted cards..." : "Importing pasted deck...");
  const builtCount = buildCards(titleHint, pasteImportAppend);
  if (builtCount) closePasteEditor(true);
}

function currentCardCanMove() {
  return Boolean(state.previewCard || state.cards[state.current] || (state.cards.length > 0 && state.current === state.cards.length));
}

function closestElement(target, selector) {
  if (target instanceof Element) return target.closest(selector);
  if (typeof target?.closest === "function") return target.closest(selector);
  if (typeof target?.parentElement?.closest === "function") return target.parentElement.closest(selector);
  return null;
}

function isCardActionTarget(target) {
  return Boolean(closestElement(target, "a, button, input, textarea, .cloze, .render-toolbar"));
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

function resetCardDrag() {
  state.dragging = false;
  state.dragPointerId = null;
  state.dragPointerType = "";
  state.dragCaptured = false;
  state.dragMoved = false;
  el.card.classList.remove("is-dragging", "drag-review", "drag-known", "drag-prev", "drag-next");
  el.card.style.transform = "";
}

function updateSwipe(clientX, clientY, event) {
  if (event?.pointerType === "mouse" && hasCardTextSelection()) {
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

  if (state.dragMoved || state.dragging) {
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
  return closestElement(target, ".style-grid, .all-cards-list, .paste-preview-list, textarea, .import-card, .web-decks-table-wrap, .my-decks-grid, .diagram-modal-body");
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

let serviceWorkerRegistered = false;

function registerServiceWorker() {
  if (serviceWorkerRegistered) return;
  if (!pwaAssetsSupported()) return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  serviceWorkerRegistered = true;
  const register = () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
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
    deckAutosaveStorageFailed = false;
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
function newDeckInFolder(folderPath = "") {
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
  initSupabaseClient();
  setupAuthListener();
  showLoginScreen();
});

document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const isSignup = document.getElementById("loginForm").dataset.mode === "signup";
  const errEl = document.getElementById("loginError");
  const submitBtn = document.getElementById("loginSubmitBtn");
  errEl.textContent = "";
  submitBtn.disabled = true;
  try {
    if (isSignup) {
      await handleSignup(email, password);
    } else {
      await handleLogin(email, password);
    }
  } catch (err) {
    errEl.textContent = err.message;
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
  supabaseClient = null;
  showSetupScreen();
});

document.getElementById("logoutBtn")?.addEventListener("click", handleLogout);

document.getElementById("cancelSyncBtn")?.addEventListener("click", () => {
  el.syncModal.hidden = true;
});

el.parseBtn.addEventListener("click", () => buildCards());
el.sampleBtn.addEventListener("click", loadSample);
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
el.closeMyDecksBtn?.addEventListener("click", closeMyDecksPanel);
el.myDecksRefreshBtn?.addEventListener("click", () => renderMyDecksList());

// The folder new decks/folders are created under: the cwd in Folder view, else the
// scope-filter value (root when neither is set).
function currentMyDecksFolder() {
  if (state.myDecksView === "folder") return state.myDecksCwd || "";
  return el.myDecksCategoryFilter?.value || "";
}
el.myDecksNewFolderBtn?.addEventListener("click", () => createFolder(currentMyDecksFolder()));
el.myDecksNewDeckBtn?.addEventListener("click", () => newDeckInFolder(currentMyDecksFolder()));
el.myDecksImportEpubInput?.addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = ""; // allow re-importing the same file again
  if (file) importEpubFile(file);
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllDeckTileMenus();
});
el.closeImportBtn.addEventListener("click", closeImportPanel);
el.closeImportSelectorBtn.addEventListener("click", closeImportSelectorPanel);
el.importSelectorCancelBtn.addEventListener("click", closeImportSelectorPanel);
el.selectAllImportSelectorCheckbox.addEventListener("change", toggleAllImportSelector);
el.importSelectorLoadBtn.addEventListener("click", loadSelectedImportDecks);
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

  const exportAllBtn = document.getElementById("myDecksExportAllBtn");
  const exportAllMenu = document.getElementById("myDecksExportAllMenu");
  if (exportAllBtn && exportAllMenu) {
    exportAllBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = exportAllMenu.hidden;
      closeWebDeckExportMenus(exportAllMenu);
      exportAllMenu.hidden = !shouldOpen;
      exportAllBtn.setAttribute("aria-expanded", String(shouldOpen));
    });
    exportAllMenu.addEventListener("click", (event) => {
      const button = event.target.closest("[data-export-all]");
      if (!button) return;
      event.stopPropagation();
      exportAllMenu.hidden = true;
      exportAllBtn.setAttribute("aria-expanded", "false");
      if (button.dataset.exportAll === "backup") {
        exportLibraryBackupZip();
      } else {
        exportAllMyDecks(button.dataset.exportAll);
      }
    });
  }

  const restoreBtn = document.getElementById("myDecksRestoreBtn");
  const restoreInput = document.getElementById("restoreFileInput");
  if (restoreBtn && restoreInput) {
    restoreBtn.addEventListener("click", () => restoreInput.click());
    restoreInput.addEventListener("change", async () => {
      const file = restoreInput.files && restoreInput.files[0];
      restoreInput.value = ""; // allow re-selecting the same file later
      if (file) await runRestoreFlow(file);
    });
  }
}
el.styleBtn.addEventListener("click", openStylePanel);
el.closeStyleBtn.addEventListener("click", closeStylePanel);
el.applyStyleBtn.addEventListener("click", () => applyCurrentStyleSettings());
el.syncUpBtn.addEventListener("click", syncStyleToWeb);
el.syncDownBtn.addEventListener("click", () => loadStyleFromWeb(true));
el.styleControls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-style-profile]");
  if (!button) return;
  switchStyleEditProfile(button.dataset.styleProfile);
});
el.styleControls.addEventListener("input", (event) => {
  if (event.target.matches("[data-style-slider]")) {
    const input = el.styleControls.querySelector(`[data-style-key="${event.target.dataset.styleSlider}"]`);
    if (input) input.value = sliderTextValue(event.target);
    handleStyleControlChange();
  }
  if (event.target.matches("[data-style-key]")) {
    syncSliderFromText(event.target);
    handleStyleControlChange();
  }
});
el.styleControls.addEventListener("change", (event) => {
  if (event.target.matches("[data-style-key]")) {
    syncSliderFromText(event.target);
    handleStyleControlChange();
  }
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
el.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0], false));
if (el.fileInputCards) el.fileInputCards.addEventListener("change", (event) => loadFile(event.target.files[0], true));
el.pasteDeckBtn?.addEventListener("click", () => openPasteEditor(false));
el.pasteCardsBtn?.addEventListener("click", () => openPasteEditor(true));
el.pastePreviewBtn?.addEventListener("click", previewPastedMarkdown);
el.pasteImportBtn?.addEventListener("click", importPastedMarkdown);
el.pasteCancelBtn?.addEventListener("click", () => closePasteEditor(false));
el.pasteMarkdownInput?.addEventListener("input", () => resetPastePreview("Preview is out of date. Click Preview again.", "Needs preview"));
el.pasteMarkdownInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePasteEditor(false);
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
      isNotesEditing() ? commitNotesEditIfActive() : enterNotesEditing();
    } else if (state.cards[state.current]) {
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
  // Card shortcuts are meaningless while any modal/panel is open (it either
  // covers the card stage or shouldn't let keys leak through to it) or while
  // the Notes view covers the card stage.
  if (anyModalOpen()) return;
  if (state.viewMode === "notes") return;
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
  if (!event.target.closest(".web-deck-export-wrap, .web-decks-global-export, .bulk-export-dropdown")) {
    closeWebDeckExportMenus();
    document.getElementById("myDecksExportAllBtn")?.setAttribute("aria-expanded", "false");
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
  pruneOrphanedDeckSnapshots();
  // Mirror every cloud deck onto this device (and push anything newer locally)
  // so the PWA has a full, up-to-date offline library. Runs in the background.
  if (navigator.onLine) {
    setTimeout(() => reconcileAllDecks({ explicit: false }), 1200);
  }
}

// The on-device deck library is a mirror of ONE account's cloud data. If a
// different account signs in on this device, the previous user's local decks
// must not survive — the next reconcile would push them straight into the new
// account's cloud (and the old tombstones would suppress the new user's own
// decks). The previous user's data is safe in their own cloud account.
const LAST_USER_STORAGE_KEY = "flashcards_last_user_id";

function ensureLocalLibraryOwner(userId) {
  if (!userId) return;
  try {
    const previous = localStorage.getItem(LAST_USER_STORAGE_KEY);
    if (previous && previous !== String(userId)) {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(LOCAL_DECK_PREFIX))
        .forEach((key) => localStorage.removeItem(key));
      localStorage.removeItem(LOCAL_DECKS_INDEX_KEY);
      localStorage.removeItem(LOCAL_DECK_TOMBSTONES_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_KEY);
      localStorage.removeItem(LAST_GLOBAL_SYNC_ERROR_KEY);
      localStorage.removeItem(deckStorageKey);
      state.localDeckId = null;
      console.log("Cleared local deck library — different account signed in.");
    }
    localStorage.setItem(LAST_USER_STORAGE_KEY, String(userId));
  } catch (error) {
    console.warn("Could not verify local library owner", error);
  }
}

let authListenerSubscription = null;

function setupAuthListener() {
  if (authListenerSubscription) {
    authListenerSubscription.unsubscribe();
    authListenerSubscription = null;
  }
  const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      isSignedIn = true;
      ensureLocalLibraryOwner(session.user.id);
      showAuthenticatedUI();
      if (!appInitialized) {
        appInitialized = true;
        initAppForUser();
      }
    } else if (event === "SIGNED_OUT") {
      isSignedIn = false;
      // Only drop to the login screen for a real sign-out. A failed token
      // refresh while offline also emits SIGNED_OUT — ignore it so the user
      // isn't locked out of their offline decks.
      if (!explicitLogout && !navigator.onLine) return;
      explicitLogout = false;
      appInitialized = false;
      showLoginScreen();
    }
  });
  authListenerSubscription = data.subscription;
}

async function bootApp() {
  const hasConfig = initSupabaseClient();

  if (!hasConfig) {
    showSetupScreen();
    return;
  }

  setupAuthListener();

  // Use the cached session (local, no network) so offline / flaky-network loads
  // still let a signed-in user reach their decks instead of the login wall.
  const session = await getCachedSession();
  if (session?.user) {
    isSignedIn = true;
    ensureLocalLibraryOwner(session.user.id);
    showAuthenticatedUI();
    if (!appInitialized) {
      appInitialized = true;
      initAppForUser();
    }
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

bootApp();

// Commit any in-progress edit into the session before the tab is hidden or closed.
// (The working deck is snapshotted too, but it's intentionally not restored on the
// next load — see clearBrowserPersistence — so a refresh starts on the home screen.)
function flushWorkingDeck() {
  try {
    commitEditIfActive();
  } catch (error) {
    console.warn("Could not commit active edit before save", error);
  }
  persistWorkingDeck();
  // persistWorkingDeck only writes the ephemeral working-deck cache (wiped on
  // every boot). If the tab/process is killed right after this — the whole
  // reason this handler exists — an edit committed above but not yet flushed
  // by the debounced scheduleDeckAutosave() timer would otherwise never reach
  // the library, and the next reconcile wouldn't even know it happened.
  saveDeckToLibrary({ silent: true });
}
window.addEventListener("pagehide", flushWorkingDeck);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushWorkingDeck();
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

function commitEditIfActive() {
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
      if (side === "question") card.question = newValue;
      else card.answer = newValue;
      const masterIndex = state.masterCards.findIndex(c => c.id === card.id);
      if (masterIndex > -1) {
        if (side === "question") state.masterCards[masterIndex].question = newValue;
        else state.masterCards[masterIndex].answer = newValue;
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

function toggleEditMode(side) {
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
    edit.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const newValue = edit.value.trim();
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
el.questionEdit.addEventListener('blur', (e) => {
  if (imagePickerActive) return;
  if (!el.questionEdit.hidden && e.relatedTarget !== el.editQuestionBtn) toggleEditMode('question');
});
el.answerEdit.addEventListener('blur', (e) => {
  if (imagePickerActive) return;
  if (!el.answerEdit.hidden && e.relatedTarget !== el.editAnswerBtn) toggleEditMode('answer');
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

const helpModal = document.getElementById("helpModal");
const helpBtn = document.getElementById("helpBtn");
const helpModalCloseBtn = document.getElementById("helpModalCloseBtn");
const helpModalCloseFootBtn = document.getElementById("helpModalCloseFootBtn");

function openHelpModal() {
  if (!helpModal) return;
  helpModal.hidden = false;
  lockPageScroll();
}

function closeHelpModal() {
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

function optimizeImage(file) {
  return new Promise((resolve) => {
    const type = (file && file.type) || "";
    if (!type.startsWith("image/") || type === "image/gif" || type === "image/svg+xml") {
      resolve(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { resolve(file); return; }
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(w, h));
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
          if (!blob || blob.size >= file.size) { resolve(file); return; }
          const ext = IMAGE_MIME_EXT[blob.type] || "img";
          const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
          resolve(new File([blob], `${baseName}.${ext}`, { type: blob.type }));
        })
        .catch(() => resolve(file));
    };
    img.src = url;
  });
}

// Storage bucket for uploaded images (see supabase_image_storage.sql). Public
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

// Resolves a Supabase public-storage URL back to its object path within
// IMAGE_BUCKET, or null if `url` isn't one of ours (a legacy ImgBB/Drive/
// external link) — the signal deleteSupabaseImage uses to know whether
// there's anything it can actually delete.
function supabaseImagePathFromUrl(url) {
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
async function deleteSupabaseImage(url) {
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
async function uploadImageToSupabase(file) {
  if (!navigator.onLine) throw new Error("OFFLINE");
  if (!supabaseClient || !isSignedIn) throw new Error("NOT_SIGNED_IN");
  // Read the id from the cached session (no network) rather than getUser()
  // (a round-trip per call) — a bulk EPUB import is hundreds of uploads
  // back-to-back, and one auth request each would dominate the import time.
  const session = await getCachedSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("NOT_SIGNED_IN");
  const ext = IMAGE_STORAGE_EXT[file.type] || "img";
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
  const { error } = await withTimeout(
    supabaseClient.storage.from(IMAGE_BUCKET).upload(path, file, {
      contentType: file.type || "application/octet-stream",
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
  return data.publicUrl;
}

// Insert an "uploading…" placeholder, upload the image, then swap in `![](url)`.
// Dropped in wherever the caret is — no surrounding blank-line padding needed:
// every rendered <img> gets wrapped in a block-level .diagram-shell (see
// enhanceNotesImageControls below), so it always lands on its own visual row
// regardless of whether it shares a markdown paragraph with other text. That
// same paragraph-sharing case gets the corner-drag resize grip immediately
// too (findImageTokens' `isInline` case), not a "move to its own line" step.
// `atPos` (optional) forces the placeholder to the caret captured before the file
// picker opened; without it the current caret is used (paste/drop already have focus).
async function insertImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const uploadToken = `![uploading…](#upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)})`;
  insertAtCursor(textarea, uploadToken, atPos);
  showToast("Optimizing image…", "info");
  try {
    const optimized = await optimizeImage(file);
    const url = await uploadImageToSupabase(optimized);
    replaceInTextarea(textarea, uploadToken, `![](${url})`);
    showToast("Image uploaded", "success");
  } catch (err) {
    replaceInTextarea(textarea, uploadToken, "");
    if (err.message === "OFFLINE") {
      showToast("Can't upload image while offline", "error");
    } else if (err.message === "NOT_SIGNED_IN") {
      showToast("Sign in to upload images", "error");
    } else {
      console.error("Image upload failed", err);
      showToast("Image upload failed", "error");
    }
  }
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

// Shared HTML→Markdown converter (paste handler + notes selection capture).
// Returns "" when Turndown is unavailable or conversion fails.
function htmlToMarkdown(html, options = {}) {
  if (typeof TurndownService === "undefined") return "";

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

  // Notes carry inline styling as raw HTML — colored/font-family text
  // (`<span style="…">` from the toolbar's color/font pickers), underline
  // (`<u>`), highlight (`<mark>`) and keyboard keys (`<kbd>`). Turndown drops
  // these by default, keeping only the text, so a card made from a styled
  // notes selection lost its color/font/underline. When preserveInlineStyles
  // is set (the notes-selection path), re-emit them so the styling survives
  // into the card exactly as it looked in the notes. This is intentionally NOT
  // enabled for the general clipboard-paste path, where preserving every
  // web/Office `<span style>` would just litter pasted markdown.
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
      ["mark", "MARK"],
      ["kbd", "KBD"]
    ].forEach(([tag, nodeName]) => {
      turndownService.addRule(`keep-${tag}`, {
        filter: (node) => node.nodeName === nodeName,
        replacement: (content) => `<${tag}>${content}</${tag}>`
      });
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

  // Restore KaTeX rendered math back into standard LaTeX ($...$ or $$...$$)
  turndownService.addRule("katex", {
    filter: function (node) {
      return node.nodeName === "SPAN" && node.classList.contains("katex");
    },
    replacement: function (content, node) {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        const tex = annotation.textContent.trim();
        const isDisplay = node.classList.contains("katex-display") || node.querySelector(".katex-display");
        return isDisplay ? "\n$$\n" + tex + "\n$$\n" : "$" + tex + "$";
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

  try {
    return turndownService.turndown(html);
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
    insertImageUpload(target, imageFile);
    return;
  }

  if (typeof TurndownService === "undefined") return;

  const types = clipboardData.types || [];
  if (!types.includes("text/html")) return;

  const html = clipboardData.getData("text/html");
  if (!html) return;

  const plainText = clipboardData.getData("text/plain");

  // Prevent default paste behavior
  event.preventDefault();

  let markdown = htmlToMarkdown(html);

  // Fallback to plain text if the markdown conversion was empty
  if (!markdown.trim() && plainText.trim()) {
    markdown = plainText;
  }

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
  if (imageFile) insertImageUpload(event.target, imageFile);
  else showToast("Only image files can be dropped here", "info");
});

// Dynamic HTML template for the inline edit toolbar.
// Pass { quickNote: true } to append the "save selection to quick_notes" button.
function createToolbarHtml(options = {}) {
  const quickNoteBtn = options.quickNote
    ? `
    <span class="edit-toolbar-divider" aria-hidden="true"></span>
    <button type="button" data-action="quick-note" class="toolbar-quick-note" title="Save selection to the quick_notes deck">📌</button>`
    : "";
  return `
    <button type="button" data-action="bold" title="Bold"><b>B</b></button>
    <button type="button" data-action="italic" title="Italic"><i>I</i></button>
    <button type="button" data-action="underline" title="Underline"><u>U</u></button>
    <button type="button" data-action="strikethrough" title="Strikethrough"><span style="text-decoration: line-through;">S</span></button>
    <button type="button" data-action="code" title="Code Block"><code>&lt;/&gt;</code></button>
    <button type="button" data-action="cloze" title="Cloze — hide selection as a fill-in-the-blank (tap the card to reveal)">[&hellip;]</button>

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
      <button type="button" class="toolbar-dropdown-toggle" title="Text Color">🎨</button>
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

  const nToolbar = el.notesEditToolbar;
  if (nToolbar) nToolbar.innerHTML = createToolbarHtml({ quickNote: true });

  if (el.questionEdit) enableSyntaxHighlighting(el.questionEdit);
  if (el.answerEdit) enableSyntaxHighlighting(el.answerEdit);
  if (el.notesEdit) enableSyntaxHighlighting(el.notesEdit);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initToolbars);
} else {
  initToolbars();
}

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
  const glyph = button.querySelector(".cloze-toggle-glyph");
  if (glyph) glyph.textContent = revealed ? "🙈" : "👀";
  button.title = revealed ? "Hide all clozes on this card" : "Reveal all clozes on this card";
}

function toggleClozes(container, button) {
  if (!container || !button) return;
  const reveal = button.getAttribute("aria-pressed") !== "true";
  container.querySelectorAll(".cloze").forEach((c) => c.classList.toggle("is-revealed", reveal));
  setClozeButtonState(button, reveal);
}

// New card / re-rendered notes start with every cloze hidden again.
function resetClozeButton(button) {
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

// Syntax highlighting backdrop creator for textareas
function enableSyntaxHighlighting(textarea) {
  if (!textarea || textarea.dataset.highlighted === "true") return;
  textarea.dataset.highlighted = "true";

  const wrapper = document.createElement("div");
  wrapper.className = "highlight-textarea-wrapper";

  const backdrop = document.createElement("div");
  backdrop.className = "highlight-textarea-backdrop";

  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.appendChild(backdrop);
  wrapper.appendChild(textarea);

  function sync() {
    const text = textarea.value;
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

    if (highlighted.endsWith("\n") || highlighted === "") {
      highlighted += " ";
    }

    backdrop.innerHTML = highlighted;
  }

  function syncScroll() {
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }

  textarea.addEventListener("input", sync);
  textarea.addEventListener("scroll", syncScroll);

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
function toggleWrapPair(val, start, end, open, close = open) {
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

function toggleWrap(val, start, end, wrapper) {
  return toggleWrapPair(val, start, end, wrapper, wrapper);
}

function toggleUnderline(val, start, end) {
  return toggleWrapPair(val, start, end, "<u>", "</u>");
}

function toggleStrikethrough(val, start, end) {
  return toggleWrapPair(val, start, end, "~~", "~~");
}

// Inline code can't contain a literal newline in Markdown, so a multi-line
// selection needs a fenced ``` block instead of backticks — everything else
// (single line, or no selection) keeps the lighter-weight ` ` wrap.
function toggleCode(val, start, end) {
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
function applyInlineStyleProperty(text, property, value) {
  const whole = matchWholeStyleSpan(text);
  const props = whole ? parseInlineStyle(whole.styleAttr) : {};
  const inner = whole ? whole.inner : text;
  props[property] = value;
  return `<span style="${serializeInlineStyle(props)}">${inner}</span>`;
}

function clearInlineStyleProperty(text, property) {
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
    if (color === "clear") {
      formatFn = (val, s, e) => clearInlineStyleProperty(val.slice(s, e), "color");
    } else {
      formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "color", color);
    }
  } else if (button.dataset.highlight) {
    const highlight = button.dataset.highlight;
    if (highlight === "clear") {
      formatFn = (val, s, e) => clearInlineStyleProperty(val.slice(s, e), "background-color");
    } else {
      formatFn = (val, s, e) => applyInlineStyleProperty(val.slice(s, e), "background-color", highlight);
    }
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
const QUICK_NOTES_DECK_TITLE = "quick_notes";

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
function cachedUserId() {
  try { return localStorage.getItem(LAST_USER_STORAGE_KEY) || null; } catch { return null; }
}

// Deterministic id of the current user's quick_notes deck (or null if unknown).
function getQuickNotesDeckId() {
  const uid = cachedUserId();
  return uid ? `quick-notes-${uid}` : null;
}

// True when a deck (by id and/or title) is the special quick_notes deck.
function isQuickNotesDeck(deckId = state.deckId, title = state.deckTitle) {
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
function quickNoteCategoriesFromMeta(meta) {
  let bag = meta;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  const list = bag && typeof bag === "object" ? bag.quickNoteCategories : null;
  return normalizeQuickNoteCategories(list);
}

function readCachedQuickNoteCategories() {
  try {
    return normalizeQuickNoteCategories(JSON.parse(localStorage.getItem(QUICK_NOTE_CATEGORIES_CACHE_KEY) || "[]"));
  } catch { return []; }
}

function writeCachedQuickNoteCategories(list) {
  try { localStorage.setItem(QUICK_NOTE_CATEGORIES_CACHE_KEY, JSON.stringify(list)); } catch (_) {}
}

// Read a local deck snapshot by its cloud deckId (not the local ld_ id).
function readLocalSnapshotByDeckId(deckId) {
  if (!deckId) return null;
  const entry = readLocalDeckIndex().find((e) => e.deckId === deckId);
  if (!entry) return null;
  try {
    const raw = localStorage.getItem(LOCAL_DECK_PREFIX + entry.id);
    return raw ? { localId: entry.id, snapshot: JSON.parse(raw) } : null;
  } catch { return null; }
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

// Apply category edits everywhere: local state + cache + snapshot mirror, then
// the cloud (merged, never replaced). Anything that can't reach the cloud is
// queued as ops and replayed by the next sync.
//
// Returns WHY it ended where it did — "synced" | "offline" | "no-column" |
// "failed" — so the caller can tell the user. Every one of these outcomes used
// to be a silent console.warn returning undefined, which is how a category that
// only ever existed on one device still looked saved.
async function applyQuickNoteCategoryOps(ops) {
  // Apply locally first so the board reacts immediately, online or not. The
  // cloud write below may widen this with other devices' categories.
  adoptQuickNoteCategories(applyCategoryOpsToList(state.quickNoteCategories, ops));

  const deckId = getQuickNotesDeckId();
  const outcome = await serialiseQuickNoteMetaWrite(() => writeQuickNoteCategoryOpsToCloud(deckId, ops));
  // Anything that didn't land is remembered and retried by the next sync. The
  // local snapshot alone was never enough: reconcile's push doesn't carry meta
  // (only the pull does), so nothing on this device would ever have delivered
  // it, and the next cloud-newer pull would overwrite the mirror and lose the
  // edit outright. Queuing the OPS (not the resulting list) is what lets the
  // replay merge with whatever other devices did in the meantime.
  if (outcome === "synced") clearPendingQuickNoteCategories();
  else queuePendingQuickNoteCategoryOps(deckId, ops);
  return outcome;
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
    if (error && String(error.message || "").includes("meta")) {
      // Database hasn't run supabase_quick_notes.sql — categories still work
      // locally; just can't sync until the column exists.
      console.warn("decks.meta column missing — quick-note categories are local-only until you run supabase_quick_notes.sql");
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
    adoptQuickNoteCategories(merged);
  } catch (error) {
    console.warn("Could not sync quick-note categories to cloud", error);
    return "failed";
  }
  return "synced";
}

// Point every local mirror of the category list at one list.
function adoptQuickNoteCategories(list) {
  const clean = normalizeQuickNoteCategories(list);
  state.quickNoteCategories = clean;
  writeCachedQuickNoteCategories(clean);
  const deckId = getQuickNotesDeckId();
  const local = deckId ? readLocalSnapshotByDeckId(deckId) : null;
  if (local) {
    local.snapshot.meta = { ...(local.snapshot.meta || {}), quickNoteCategories: clean };
    try { localStorage.setItem(LOCAL_DECK_PREFIX + local.localId, JSON.stringify(local.snapshot)); } catch (_) {}
  }
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

// Deliver a category edit that couldn't reach the cloud when it was made.
// Returns true only when something was actually delivered, so the sync report
// can say so. Safe to call on every sync: it's a no-op with nothing pending.
async function flushPendingQuickNoteCategories() {
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
  // Clear first: applyQuickNoteCategoryOps re-queues on failure, and leaving the
  // old entry in place would make it append these ops to themselves and replay
  // each one twice on the next attempt.
  clearPendingQuickNoteCategories();
  // Goes back through applyQuickNoteCategoryOps so a still-failing write is
  // re-queued rather than dropped, and the local mirrors stay in step.
  return (await applyQuickNoteCategoryOps(pending.ops)) === "synced";
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
function trimNoteAnchor(anchor) {
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

function noteAnchorsFromMeta(meta) {
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

function saveQuickNoteAnchors(patch, options) {
  return serialiseQuickNoteMetaWrite(() => writeQuickNoteAnchors(patch, options));
}

async function writeQuickNoteAnchors(patch, { keepIds = null } = {}) {
  const deckId = getQuickNotesDeckId();
  if (!deckId) return;
  const hasPatch = patch && Object.keys(patch).length;
  if (!hasPatch && !keepIds) return;
  if (!supabaseClient || !isSignedIn || !navigator.onLine) return;
  try {
    const { data: existing } = await supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle();
    const base = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
    let anchors = { ...noteAnchorsFromMeta(base), ...(patch || {}) };
    if (keepIds) {
      anchors = Object.fromEntries(Object.entries(anchors).filter(([id]) => keepIds.has(String(id))));
    }
    const meta = { ...base, noteAnchors: anchors };
    const { error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId);
    if (error) throw error;
  } catch (error) {
    console.warn("Could not sync quick-note source anchors to cloud", error);
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
  // the jump instant.
  for (const entry of readLocalDeckIndex()) {
    try {
      const raw = localStorage.getItem(LOCAL_DECK_PREFIX + entry.id);
      if (!raw) continue;
      const snapshot = JSON.parse(raw);
      if (snapshot.deckId && snapshot.deckId === qid) continue; // never match the board itself
      const plain = notesAnchorPlainText(snapshot.notes || "");
      if (!plain) continue;
      if (snapshot.deckId) seen.add(String(snapshot.deckId));
      decks.push({
        localId: entry.id,
        deckId: snapshot.deckId || null,
        title: snapshot.deckTitle || entry.title || "source",
        plain
      });
    } catch (_) { /* a corrupt snapshot just isn't searchable */ }
  }

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

// Assign (or clear, when categoryId is falsy) a card's subject category. Writes
// the cloud cards row + the local snapshot + bumps updatedAt so reconcile sees
// the change. Returns true on a best-effort local success.
async function setQuickNoteCardCategory(cardId, categoryId) {
  if (!cardId) return false;
  const value = categoryId ? String(categoryId) : null;
  const now = new Date().toISOString();
  const deckId = getQuickNotesDeckId();

  // Local snapshot patch (source of truth for offline + reconcile).
  const local = readLocalSnapshotByDeckId(deckId);
  if (local && Array.isArray(local.snapshot.cards)) {
    const card = local.snapshot.cards.find((c) => String(c.id) === String(cardId));
    if (card) {
      card.category = value;
      card.updatedAt = now;
      local.snapshot.updatedAt = now;
      try {
        localStorage.setItem(LOCAL_DECK_PREFIX + local.localId, JSON.stringify(local.snapshot));
      } catch (_) {}
      const index = readLocalDeckIndex();
      const entry = index.find((e) => e.id === local.localId);
      if (entry) { entry.updatedAt = now; writeLocalDeckIndex(index); }
    }
  }

  // Keep the active study deck in step if the quick_notes deck is open.
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

  if (!supabaseClient || !isSignedIn || !navigator.onLine) return true;
  try {
    const { error } = await supabaseClient
      .from("cards")
      .update({ category: value, updated_at: now })
      .eq("id", cardId);
    if (error) throw error;
  } catch (error) {
    console.warn("Could not sync quick-note card category to cloud", error);
    return false;
  }
  return true;
}

// ── Quick Notes board (dedicated skim surface) ───────────────────
// Independent of the active study deck: pulls the quick_notes deck's cards
// straight from the cloud (falling back to the local snapshot offline), so the
// board can be opened at any time without disturbing whatever you're studying.
const qnBoard = {
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
  const local = readLocalSnapshotByDeckId(deckId);
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
      // Deliver a pending offline category edit BEFORE the read below, because
      // that read treats the cloud row as authoritative. Reading first would
      // show the pre-offline categories, and the next edit from the board would
      // then write that stale list back and clear the pending record — losing
      // the offline edit permanently. Same ordering rule as reconcileAllDecks.
      await flushPendingQuickNoteCategories();

      const [deckRes, cardsRes] = await Promise.all([
        supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle(),
        supabaseClient.from("cards").select("id, question, answer, category, updated_at").eq("deck_id", deckId).order("position", { ascending: true })
      ]);
      const cloudAnchors = deckRes.data && !deckRes.error ? noteAnchorsFromMeta(deckRes.data.meta) : {};
      if (!cardsRes.error && Array.isArray(cardsRes.data)) {
        cards = cardsRes.data.map((c) => ({
          id: String(c.id),
          question: String(c.question || ""),
          answer: String(c.answer || ""),
          category: c.category || null,
          // Cloud anchor first (works on every device), local snapshot second.
          noteAnchor: cloudAnchors[String(c.id)] || anchorById.get(String(c.id)) || null,
          updatedAt: c.updated_at || null
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
let qnReturnState = null;

// Put the board back the way it was and mark the note you left from, so it's
// obvious where you were.
function restoreQnReturnState() {
  if (!qnReturnState) return;
  const { cardId, scrollTop } = qnReturnState;
  qnReturnState = null;
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

async function openQuickNotesBoard({ restore = false } = {}) {
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
    qnReturnState = null;
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

function closeQuickNotesBoard() {
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
function jumpToQuickNoteSource(cardId) {
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
  if (anchor.deckLocalId && suppressNavRecording(() => loadDeckFromLibrary(anchor.deckLocalId))) {
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
function closeQnCatMenu() {
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
  // This write goes straight to the cloud, so say so — otherwise the only
  // feedback you ever get is a later sync reporting "nothing to sync", which
  // reads as "your change was lost". The return value matters: it's false when
  // the cloud write failed, and that used to be swallowed entirely, leaving the
  // board showing a category that exists on no other device.
  const cat = categoryId ? findQuickNoteCategory(categoryId) : null;
  const label = cat ? `“${cat.name}”` : "Uncategorized";
  const ok = await setQuickNoteCardCategory(cardId, categoryId || null);
  if (!ok) {
    showToast(`Set to ${label} on this device — could not reach the cloud, will sync later`, "error");
  } else if (!supabaseClient || !isSignedIn || !navigator.onLine) {
    showToast(`Set to ${label} — saved on this device, will sync when you're back online`, "info");
  } else {
    showToast(`Set to ${label} — saved and synced`, "success");
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
function closeQnCatModal() {
  if (el.qnCatModal) el.qnCatModal.hidden = true;
}

// `what` names the edit that was just made ("Added “Vocabulary”"), so the toast
// reports the specific action rather than a generic "saved".
async function commitQuickNoteCategoryOps(ops, what = "Categories updated") {
  const outcome = await applyQuickNoteCategoryOps(ops);
  renderQnCatModal();
  renderQuickNotesBoard();
  const message = {
    synced: `${what} — saved and synced`,
    offline: `${what} — saved on this device, will sync when you're back online`,
    "no-column": `${what} — saved on this device only. Run supabase_quick_notes.sql in Supabase to sync categories`,
    failed: `${what} — saved on this device, but the cloud update failed`
  }[outcome] || `${what} — saved`;
  showToast(message, outcome === "synced" ? "success" : outcome === "offline" ? "info" : "error");
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

// Ensure the quick_notes web deck exists for the current user, returning its id.
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
// blank to fill in later) appended to the quick_notes web deck.
async function saveQuickNote(rawText, button, sourceAnchor = null) {
  const text = String(rawText || "").trim();
  if (!text) {
    setStatus("Select some text first to save a quick note.", "error");
    return;
  }

  if (!supabaseClient) {
    setStatus("Connect to Supabase and sign in to save quick notes.", "error");
    return;
  }

  const user = await getCurrentUser();
  if (!user) {
    setStatus("Sign in to save quick notes to the cloud.", "error");
    return;
  }

  if (button) button.disabled = true;
  setStatus("Saving quick note…");

  try {
    const deckId = await ensureQuickNotesDeck(user.id);

    const { count, error: countError } = await supabaseClient
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("deck_id", deckId);
    if (countError) throw countError;

    const now = new Date().toISOString();
    const cardId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { error: cardError } = await supabaseClient
      .from("cards")
      .insert({
        id: cardId,
        deck_id: deckId,
        question: text,
        answer: "",
        position: count || 0,
        status: null,
        updated_at: now
      });
    if (cardError) throw cardError;

    // Bump the deck so it surfaces as recently used in My Decks.
    await supabaseClient
      .from("decks")
      .update({ updated_at: now, last_accessed_at: now })
      .eq("id", deckId);

    // Attach the source location (deck + note offset) so the quick_notes card
    // offers a "Go to notes" jump back to where it was pinned from. Written to
    // the deck's cloud meta bag as well as the local snapshot: the snapshot
    // alone is silently dropped whenever this device has no local copy of the
    // quick_notes deck, which is what detached these links before.
    const anchor = trimNoteAnchor(sourceAnchor);
    const quickCard = { id: cardId, question: text, answer: "", status: null, category: null };
    if (anchor) quickCard.noteAnchor = anchor;
    appendCardToLocalLibraryDeck(deckId, quickCard, now);
    if (anchor) await saveQuickNoteAnchors({ [cardId]: anchor });

    setStatus("Saved to quick_notes.");
    showToast("Saved to quick_notes");
    if (button) {
      button.classList.add("quick-note-saved");
      setTimeout(() => button.classList.remove("quick-note-saved"), 1200);
    }
  } catch (error) {
    setStatus("Failed to save quick note.", "error");
    showToast("Couldn't save quick note", "error");
    console.error(error);
  } finally {
    if (button) button.disabled = false;
  }
}

// ── Hamburger menu (side drawer, all screen sizes) ───────────────
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
      // Close button, section-label clicks, and all other actions close the drawer
      setTimeout(closeMenu, 150);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && toolbar.classList.contains("mobile-open")) closeMenu();
    });
  }
}

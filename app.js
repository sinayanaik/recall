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
  previewCard: null,
  deckTitle: "",
  deckCategory: "Uncategorized",
  notes: "",
  viewMode: "cards",
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
    "markdownBoxHeightPercent": "30"
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
    "markdownBoxHeightPercent": "30"
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

// ImgBB API key for image paste/drop/upload. Stored in localStorage like the Supabase
// config — no hardcoded credentials. The key only permits uploads to the user's ImgBB
// account (get a free one at https://api.imgbb.com/).
const IMGBB_KEY_STORAGE_KEY = "flashcards_imgbb_key";

function loadImgbbKey() {
  return (localStorage.getItem(IMGBB_KEY_STORAGE_KEY) || "").trim();
}

function saveImgbbKey(key) {
  const trimmed = (key || "").trim();
  if (trimmed) localStorage.setItem(IMGBB_KEY_STORAGE_KEY, trimmed);
  else localStorage.removeItem(IMGBB_KEY_STORAGE_KEY);
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
  const imgbbField = document.getElementById("setupImgbbKey");
  if (imgbbField) imgbbField.value = loadImgbbKey();
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


function normalizeDeckCategory(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim() || defaultDeckCategory;
}

function categorySortValue(value) {
  const category = normalizeDeckCategory(value);
  return category === defaultDeckCategory ? "" : category.toLowerCase();
}

function categoryForSync(existingDeck = null) {
  const localCategory = normalizeDeckCategory(state.deckCategory);
  const existingCategory = normalizeDeckCategory(existingDeck?.category);
  if (localCategory === defaultDeckCategory && existingCategory !== defaultDeckCategory) {
    return existingCategory;
  }
  return localCategory;
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

function populateWebDeckCategoryFilter(decks = []) {
  const filter = el.webDeckCategoryFilter;
  if (!filter) return "";

  const selected = filter.value || "";
  const categories = setKnownWebDeckCategories(categoriesFromDecks(decks));

  filter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All categories";
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

function deckLastAccessedAt(deck = {}) {
  return deck.last_accessed_at || deck.updated_at || deck.created_at || "";
}

function formatWebDeckAccessDate(value) {
  if (!value) return { date: "Never", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "Never", time: "" };
  return {
    date: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  };
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



function webDecksSkeletonRows(count = 4) {
  const row = "<tr class=\"web-decks-skeleton-row\">" + Array.from({ length: 5 }, () => "<td><div class=\"skeleton-bar\"></div></td>").join("") + "</tr>";
  return row.repeat(count);
}

async function fetchWebDecks({ toast = false } = {}) {
  if (!supabaseClient) return;
  if (!navigator.onLine) {
    const tbody = el.webDecksListTable;
    if (tbody) tbody.innerHTML = "<tr><td colspan=\"5\" class=\"web-decks-empty\">You're offline. Open “My Decks” to study decks saved on this device.</td></tr>";
    setStatus("Offline — web decks need a connection. Your device decks still work.", "error");
    if (toast) showToast("Offline — can't reach web decks", "info");
    return;
  }
  const refreshBtn = document.getElementById("refreshWebDecksBtn");
  if (refreshBtn) setButtonLoading(refreshBtn, true, "Loading…");
  if (el.webDecksListTable && !el.webDecksListTable.children.length) {
    el.webDecksListTable.innerHTML = webDecksSkeletonRows();
  }
  try {
    setStatus("Fetching web decks...");
    const { data, error } = await supabaseClient
      .from("decks")
      .select("*, cards(count)")
      .order("last_accessed_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false });
      
    if (error) throw error;
    
    const tbody = el.webDecksListTable;
    if (!tbody) return;

    tbody.innerHTML = "";

    if (el.selectAllWebDecksCheckbox) {
      el.selectAllWebDecksCheckbox.checked = false;
      el.selectAllWebDecksCheckbox.indeterminate = false;
    }
    updateBulkActionVisibility();

    const selectedCategory = populateWebDeckCategoryFilter(data || []);
    const visibleDecks = selectedCategory
      ? (data || []).filter((deck) => normalizeDeckCategory(deck.category) === selectedCategory)
      : (data || []);
    const categories = webDeckCategories;

    if (!data || data.length === 0) {
      tbody.innerHTML = "<tr><td colspan=\"5\" class=\"web-decks-empty\">No web decks found.</td></tr>";
      setStatus("Web decks loaded.");
      if (toast) showToast("No web decks found", "info");
      return;
    }

    if (!visibleDecks.length) {
      tbody.innerHTML = "<tr><td colspan=\"5\" class=\"web-decks-empty\">No decks in this category.</td></tr>";
      setStatus("Web decks loaded.");
      if (toast) showToast("No decks in this category", "info");
      return;
    }
    
    visibleDecks.forEach(deck => {
      const accessed = formatWebDeckAccessDate(deckLastAccessedAt(deck));
      const category = normalizeDeckCategory(deck.category);
      const tr = document.createElement("tr");

      const tdSelect = document.createElement("td");
      tdSelect.dataset.label = "Select";
      tdSelect.className = "web-deck-select-cell";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "web-deck-row-checkbox";
      checkbox.dataset.deckId = deck.id;
      checkbox.addEventListener("change", () => {
        updateBulkActionVisibility();
      });
      tdSelect.appendChild(checkbox);

      const tdTitle = document.createElement("td");
      tdTitle.dataset.label = "Title";
      const titleWrap = document.createElement("div");
      titleWrap.className = "web-deck-title";

      const titleText = document.createElement("span");
      titleText.className = "web-deck-title-text";
      titleText.textContent = deck.title || "Untitled";

      const cardCount = deck.cards?.[0]?.count ?? null;
      const countBadge = document.createElement("span");
      countBadge.className = "web-deck-card-count";
      countBadge.textContent = cardCount !== null ? `${cardCount} cards` : "";
      if (cardCount === null) countBadge.hidden = true;

      const renameBtn = document.createElement("button");
      renameBtn.className = "web-deck-rename";
      renameBtn.type = "button";
      renameBtn.title = "Rename web deck";
      renameBtn.setAttribute("aria-label", `Rename ${deck.title || "Untitled"}`);
      renameBtn.textContent = "Rename";
      renameBtn.onclick = () => renameWebDeck(deck.id, deck.title || "Untitled");

      titleWrap.appendChild(titleText);
      tdTitle.appendChild(titleWrap);

      const tdDate = document.createElement("td");
      tdDate.dataset.label = "Accessed";
      const dateWrap = document.createElement("div");
      dateWrap.className = "web-deck-accessed";
      const dateText = document.createElement("strong");
      dateText.textContent = accessed.date;
      const timeText = document.createElement("span");
      timeText.textContent = accessed.time;
      dateWrap.appendChild(dateText);
      dateWrap.appendChild(timeText);
      tdDate.appendChild(dateWrap);

      const tdCategory = document.createElement("td");
      tdCategory.dataset.label = "Category";
      tdCategory.appendChild(createWebDeckCategoryControl(deck, category, categories));
      
      const tdActions = document.createElement("td");
      tdActions.dataset.label = "Actions";
      const actionsWrap = document.createElement("div");
      actionsWrap.className = "web-deck-actions";
      
      const loadBtn = document.createElement("button");
      loadBtn.className = "web-deck-action";
      loadBtn.textContent = "Load";
      loadBtn.onclick = () => loadWebDeck(deck.id);

      const exportWrap = createWebDeckExportControl(deck);
      
      const delBtn = document.createElement("button");
      delBtn.className = "web-deck-action web-deck-delete";
      delBtn.textContent = "Delete";
      delBtn.onclick = () => deleteWebDeck(deck.id);
      
      // Mobile-only meta row: category pill + count + date (all hidden on desktop via CSS)
      const mobileMeta = document.createElement("div");
      mobileMeta.className = "web-deck-mobile-meta";
      const mobileCat = document.createElement("span");
      mobileCat.className = "web-deck-cat-pill";
      mobileCat.textContent = category;
      if (!category || category === defaultDeckCategory) mobileCat.hidden = true;
      const mobileDate = document.createElement("span");
      mobileDate.className = "web-deck-mobile-date";
      mobileDate.textContent = accessed.date;
      mobileMeta.appendChild(mobileCat);
      if (cardCount !== null) mobileMeta.appendChild(countBadge);
      mobileMeta.appendChild(mobileDate);
      actionsWrap.appendChild(mobileMeta);

      const buttonRow = document.createElement("div");
      buttonRow.className = "web-deck-button-row";
      buttonRow.appendChild(loadBtn);
      buttonRow.appendChild(exportWrap);
      buttonRow.appendChild(renameBtn);
      buttonRow.appendChild(delBtn);
      actionsWrap.appendChild(buttonRow);
      tdActions.appendChild(actionsWrap);
      
      tr.appendChild(tdSelect);
      tr.appendChild(tdTitle);
      tr.appendChild(tdCategory);
      tr.appendChild(tdDate);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
    setStatus("Web decks updated.");
    if (toast) showToast(`Refreshed · ${visibleDecks.length} ${visibleDecks.length === 1 ? "deck" : "decks"}`);
  } catch (error) {
    console.error("Failed to fetch web decks", error);
    setStatus("Failed to fetch web decks.", "error");
    if (toast) showToast("Couldn't refresh web decks", "error");
  } finally {
    if (refreshBtn) setButtonLoading(refreshBtn, false);
  }
}

async function updateWebDeckTitle(deckId, title) {
  if (!deckId || !supabaseClient) return false;

  const { error } = await supabaseClient
    .from("decks")
    .update({
      title,
      updated_at: new Date().toISOString()
    })
    .eq("id", deckId);

  if (error) throw error;
  return true;
}

async function updateWebDeckCategory(deckId, category) {
  if (!deckId || !supabaseClient) return false;

  const { error } = await supabaseClient
    .from("decks")
    .update({
      category: normalizeDeckCategory(category),
      updated_at: new Date().toISOString()
    })
    .eq("id", deckId);

  if (error) throw error;
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

function createWebDeckCategoryControl(deck, currentCategory, categories = webDeckCategories) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-category-editor";

  const select = document.createElement("select");
  select.className = "web-deck-category-select";
  select.setAttribute("aria-label", `Category for ${deck.title || "Untitled"}`);

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

  const saveNewCategory = async () => {
    if (!input.value.trim()) {
      setStatus("Category cannot be empty.", "error");
      input.focus();
      return;
    }

    const nextCategory = normalizeDeckCategory(input.value);
    saveBtn.disabled = true;
    try {
      setStatus("Updating deck category...");
      await applyWebDeckCategory(deck.id, nextCategory);
      setStatus("Deck category updated.");
      showToast(`Category set to "${nextCategory}"`);
      fetchWebDecks();
    } catch (error) {
      console.error("Failed to update deck category", error);
      setStatus("Failed to update deck category. Run the deck category SQL migration first.", "error");
      showToast("Couldn't update category", "error");
      saveBtn.disabled = false;
    }
  };

  select.addEventListener("change", async () => {
    if (select.value === "__new__") {
      newRow.hidden = false;
      input.value = "";
      input.focus();
      return;
    }

    const nextCategory = normalizeDeckCategory(select.value);
    if (nextCategory === normalizeDeckCategory(currentCategory)) return;

    select.disabled = true;
    try {
      setStatus("Updating deck category...");
      await applyWebDeckCategory(deck.id, nextCategory);
      setStatus("Deck category updated.");
      showToast(`Category set to "${nextCategory}"`);
      fetchWebDecks();
    } catch (error) {
      console.error("Failed to update deck category", error);
      setStatus("Failed to update deck category. Run the deck category SQL migration first.", "error");
      showToast("Couldn't update category", "error");
      select.disabled = false;
      select.value = normalizeDeckCategory(currentCategory);
    }
  });

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

function closeWebDeckExportMenus(exceptMenu = null) {
  document.querySelectorAll(".web-deck-export-menu, .web-decks-global-export-menu, .bulk-export-menu").forEach((menu) => {
    if (menu !== exceptMenu) {
      menu.hidden = true;
      const trigger = menu.previousElementSibling;
      if (trigger?.matches("[aria-expanded]")) trigger.setAttribute("aria-expanded", "false");
    }
  });
}

function createWebDeckExportControl(deck) {
  const wrap = document.createElement("div");
  wrap.className = "web-deck-export-wrap";

  const button = document.createElement("button");
  button.className = "web-deck-action web-deck-export";
  button.type = "button";
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.title = "Export deck";
  button.setAttribute("aria-label", `Export ${deck.title || "Untitled"}`);
  button.textContent = "Export";

  const menu = document.createElement("div");
  menu.className = "web-deck-export-menu";
  menu.hidden = true;

  [
    ["pdf", "Cornell PDF"],
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
      exportWebDeck(deck.id, format);
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

async function renameWebDeck(deckId, currentTitle = "") {
  if (!deckId || !supabaseClient) return;

  showPromptModal("Rename Deck", "", currentTitle || "Untitled", async (nextTitle) => {
    const title = nextTitle.trim();
    if (!title) {
      setStatus("Deck title cannot be empty.", "error");
      return;
    }
    try {
      setStatus("Renaming web deck...");
      await updateWebDeckTitle(deckId, title);
      if (state.deckId === deckId) {
        state.deckTitle = title;
        state.sourceTitle = title;
        updateMeta();
      }
      setStatus("Web deck renamed.");
      showToast(`Renamed to "${title}"`);
      fetchWebDecks();
    } catch (error) {
      console.error("Failed to rename web deck", error);
      setStatus("Failed to rename web deck.", "error");
      showToast("Couldn't rename deck", "error");
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
    deckTitle: payload.deck.title,
    deckCategory: payload.deck.category,
    notes: payload.deck.notes || "",
    sourceTitle: payload.deck.title,
    importTitleHint: payload.deck.title,
    deckId: payload.deck.id,
    current: payload.deck.current_card_index || 0,
    cards: payload.cards.map((card) => ({
      id: card.id,
      question: card.question,
      answer: card.answer,
      status: card.status
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

async function fetchAllWebDeckPayloads() {
  const { data: decksData, error: decksError } = await supabaseClient
    .from("decks")
    .select("*")
    .order("last_accessed_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });

  if (decksError) throw decksError;

  const { data: cardsData, error: cardsError } = await supabaseClient
    .from("cards")
    .select("*")
    .order("deck_id", { ascending: true })
    .order("position", { ascending: true });

  if (cardsError) throw cardsError;

  const cardsByDeck = (cardsData || []).reduce((grouped, card) => {
    const deckId = String(card.deck_id || "");
    if (!grouped.has(deckId)) grouped.set(deckId, []);
    grouped.get(deckId).push(card);
    return grouped;
  }, new Map());

  return (decksData || []).map((deck) => normalizeWebDeckPayload(deck, cardsByDeck.get(String(deck.id)) || []));
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

function buildDeckSql(payloads, title = "Recall SQL Export") {
  const lines = [
    `-- ${title}`,
    `-- Exported: ${new Date().toISOString()}`,
    "BEGIN;"
  ];

  payloads.forEach((payload) => {
    const deck = payload.deck;
    lines.push("");
    lines.push(`-- Deck: ${deck.title}`);
    lines.push(
      "INSERT INTO decks (id, title, category, notes, current_card_index, created_at, updated_at, last_accessed_at) VALUES " +
      `(${sqlValue(deck.id)}, ${sqlValue(deck.title)}, ${sqlValue(deck.category)}, ${sqlValue(deck.notes || "")}, ${Number(deck.current_card_index) || 0}, ${sqlTimestamp(deck.created_at)}, ${sqlTimestamp(deck.updated_at)}, ${sqlTimestamp(deck.last_accessed_at)}) ` +
      "ON CONFLICT (id) DO UPDATE SET " +
      "title = EXCLUDED.title, category = EXCLUDED.category, notes = EXCLUDED.notes, current_card_index = EXCLUDED.current_card_index, updated_at = EXCLUDED.updated_at, last_accessed_at = EXCLUDED.last_accessed_at;"
    );
    lines.push(`DELETE FROM cards WHERE deck_id = ${sqlValue(deck.id)};`);

    if (payload.cards.length) {
      const values = payload.cards.map((card, index) => (
        `(${sqlValue(card.id)}, ${sqlValue(deck.id)}, ${sqlValue(card.question)}, ${sqlValue(card.answer)}, ${Number.isFinite(Number(card.position)) ? Number(card.position) : index}, ${sqlValue(normalizeCardStatus(card.status))}, ${sqlTimestamp(card.created_at)}, ${sqlTimestamp(card.updated_at)})`
      ));
      lines.push(
        "INSERT INTO cards (id, deck_id, question, answer, position, status, created_at, updated_at) VALUES\n" +
        values.join(",\n") +
        "\nON CONFLICT (id) DO UPDATE SET " +
        "deck_id = EXCLUDED.deck_id, question = EXCLUDED.question, answer = EXCLUDED.answer, position = EXCLUDED.position, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;"
      );
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
    created_at: null,
    updated_at: new Date().toISOString()
  }));

  return {
    deck: {
      id: deckId,
      title: deckTitle,
      category: normalizeDeckCategory(state.deckCategory),
      notes: state.notes || "",
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

async function exportWebDeck(deckId, format) {
  if (!deckId || !supabaseClient) return;

  try {
    setStatus("Exporting web deck...");
    const payload = await fetchWebDeckPayload(deckId);
    const baseName = slugifyFileName(payload.deck.title || "recall");

    if (format === "pdf") {
      await exportCardsPdf(payload.deck.title, payload.cards, {
        fileBaseName: baseName,
        statusById: statusByIdFromCards(payload.cards)
      });
    } else if (format === "markdown") {
      downloadTextFile(webDeckPayloadMarkdown(payload), `${baseName}.md`, "text/markdown;charset=utf-8");
      setStatus("Exported web deck as Markdown.");
    } else if (format === "sql") {
      downloadTextFile(buildDeckSql([payload], `${payload.deck.title} SQL Export`), `${baseName}.sql`, "application/sql;charset=utf-8");
      setStatus("Exported web deck as SQL.");
    } else {
      downloadTextFile(`${JSON.stringify(deckPayloadSnapshot(payload), null, 2)}\n`, `${baseName}.json`, "application/json;charset=utf-8");
      setStatus("Exported web deck as JSON.");
    }

    if (format !== "pdf") showToast(`Exported "${payload.deck.title || "deck"}" as ${format.toUpperCase()}`);
    await touchWebDeckAccess(deckId);
    fetchWebDecks();
  } catch (error) {
    console.error("Failed to export web deck", error);
    setStatus("Failed to export web deck.", "error");
    showToast("Export failed", "error");
  }
}

async function exportAllWebDecks(format) {
  if (!supabaseClient) return;

  try {
    setStatus("Exporting all web decks...");
    const payloads = await fetchAllWebDeckPayloads();
    if (!payloads.length) {
      setStatus("No web decks to export.", "error");
      return;
    }

    if (format === "pdf") {
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
          cards.push({
            id,
            question: card.question,
            answer: card.answer,
            position: cards.length
          });
          const status = normalizeCardStatus(card.status);
          if (status) statusById[id] = status;
        });
      });
      await exportCardsPdf("All Web Decks", cards, { fileBaseName: "all-web-decks", statusById });
    } else if (format === "markdown") {
      downloadTextFile(
        payloads.map(webDeckPayloadMarkdown).join("\n\n---\n\n"),
        "all-web-decks.md",
        "text/markdown;charset=utf-8"
      );
      setStatus("Exported all web decks as Markdown.");
    } else if (format === "sql") {
      downloadTextFile(buildDeckSql(payloads, "All Web Decks SQL Export"), "all-web-decks.sql", "application/sql;charset=utf-8");
      setStatus("Exported all web decks as SQL.");
    } else {
      downloadTextFile(
        `${JSON.stringify({
          app: "recall",
          version: 1,
          exportedAt: new Date().toISOString(),
          decks: payloads.map(deckPayloadSnapshot)
        }, null, 2)}\n`,
        "all-web-decks.json",
        "application/json;charset=utf-8"
      );
      setStatus("Exported all web decks as JSON.");
    }

    if (format !== "pdf") showToast(`Exported all web decks as ${format.toUpperCase()}`);
    fetchWebDecks();
  } catch (error) {
    console.error("Failed to export all web decks", error);
    setStatus("Failed to export all web decks.", "error");
    showToast("Export failed", "error");
  }
}

async function deleteWebDeck(deckId) {
  if (!supabaseClient) return;
  showConfirmModal("Delete this deck from this device and the cloud? This cannot be undone.", async () => {
    try {
      setStatus("Deleting deck...");
      // Remove the on-device mirror copy too (matched by cloud id). Deleting only
      // the cloud row lets the surviving local copy re-upload it on next sync.
      const localMeta = readLocalDeckIndex().find((m) => String(m.deckId) === String(deckId));
      const { cloudError } = await deleteDeckEverywhere({ localId: localMeta?.id || null, deckId });
      if (cloudError) throw cloudError;
      setStatus("Deck deleted successfully.");
      showToast("Deck deleted everywhere");
      fetchWebDecks();
      if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    } catch (error) {
      console.error("Failed to delete web deck", error);
      setStatus("Failed to delete web deck.", "error");
      showToast("Couldn't delete deck", "error");
    }
  }, { confirmLabel: "Delete", danger: true });
}

async function loadWebDeck(deckId) {
  if (!deckId || !supabaseClient) return;
  if (!navigator.onLine) {
    setStatus("Offline — can't load web decks. Try “My Decks” for device copies.", "error");
    showToast("Offline — can't load web deck", "info");
    return;
  }

  setStatus("Loading deck from web...");

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
    const cards = cardsData.map((rawCard, index) => {
      const id = String(rawCard.id || `${index}-${rawCard.question.slice(0, 32)}`);
      const status = normalizeCardStatus(rawCard.status);
      if (status) {
        statusById[id] = status;
      }
      return { id, question: rawCard.question, answer: rawCard.answer };
    });

    state.deckId = deckData.id;
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
    state.current = 0; // always start from the first card on fresh load
    state.deckTitle = deckData.title || "";
    state.deckCategory = normalizeDeckCategory(deckData.category);
    // Pre-migration databases have no notes column; select("*") just omits it.
    state.notes = String(deckData.notes || "");
    state.sourceTitle = deckData.title || "";
    state.importTitleHint = deckData.title || "";
    setViewMode("cards");

    syncResults();
    touchWebDeckAccess(deckData.id).catch((error) => console.error("Failed to touch deck access", error));
    closeAllCardsPanel();
    setStatus(`Loaded ${cards.length} cards from web successfully.`);
    showToast(`Loaded "${state.deckTitle || "deck"}" · ${cards.length} cards`);
    el.webDecksPanel.hidden = true;
    if (el.myDecksPanel) el.myDecksPanel.hidden = true;
    unlockPageScroll();
    closeImportPanel();
    showCard();
    // Mirror the freshly-loaded web deck into the on-device library (deduped by
    // cloud id) so it stays readable offline without an extra manual save. Align
    // its timestamps to the cloud copy so it reads as already in-sync — otherwise
    // it would look "newer" and trigger a redundant re-push on the next reconcile.
    state.localDeckId = null;
    saveDeckToLibrary({ silent: true, updatedAt: deckData.updated_at, lastSyncedAt: deckData.updated_at });
    refreshSyncIndicatorBaseline();
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

function normalizeDeckTitleForSync(value) {
  return normalizeSyncText(value).toLowerCase();
}

async function findExistingWebDeckForLocalSync(deckTitle, preferredDeckId = "") {
  if (!supabaseClient) return null;

  const normalizedTitle = normalizeDeckTitleForSync(deckTitle);
  const normalizedPreferredId = String(preferredDeckId || "").trim();

  if (normalizedPreferredId) {
    const { data, error } = await supabaseClient
      .from("decks")
      .select("*")
      .eq("id", normalizedPreferredId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  if (!normalizedTitle) return null;

  const { data, error } = await supabaseClient
    .from("decks")
    .select("*")
    .order("last_accessed_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });

  if (error) throw error;

  return (data || []).find((deck) => normalizeDeckTitleForSync(deck.title) === normalizedTitle) || null;
}

async function resolveSyncTargetDeck(deckTitle) {
  const preferredDeckId = state.deckId || slugifyFileName(deckTitle);

  if (state.deckId) {
    const existingDeck = supabaseClient
      ? await findExistingWebDeckForLocalSync(deckTitle, state.deckId)
      : null;

    return {
      deckId: preferredDeckId,
      existingDeck: existingDeck,
      overwriteExisting: false
    };
  }

  if (!supabaseClient) {
    return {
      deckId: preferredDeckId,
      existingDeck: null,
      overwriteExisting: false
    };
  }

  const existingDeck = await findExistingWebDeckForLocalSync(deckTitle, preferredDeckId);

  return {
    deckId: existingDeck?.id || preferredDeckId || ("deck-" + Date.now()),
    existingDeck,
    overwriteExisting: Boolean(existingDeck)
  };
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
    statusChanges: 0
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
  });

  changes.deleted = unmatchedWeb.size;
  return changes;
}

async function showSyncModal() {
  const modal = el.syncModal;
  const content = el.syncDetailsContent;
  const confirmBtn = document.getElementById("confirmSyncBtn");

  if (!state.masterCards.length && !state.notes.trim()) {
    setStatus("No deck to sync.", "error");
    return;
  }
  if (!navigator.onLine) {
    setStatus("Offline — can't sync to cloud. Use “Save to Device” to keep this deck locally.", "error");
    showToast("Offline — saved to device instead", "info");
    saveDeckToLibrary({ silent: true });
    return;
  }

  const deckTitle = state.deckTitle || state.sourceTitle || "Untitled Deck";
  const cardsCount = state.masterCards.length;
  const knownCount = state.results.known.length;
  const reviewCount = state.results.review.length;

  let syncTarget = {
    deckId: state.deckId || slugifyFileName(deckTitle) || ("deck-" + Date.now()),
    existingDeck: state.deckId ? { id: state.deckId, title: deckTitle } : null,
    overwriteExisting: false
  };
  try {
    syncTarget = await resolveSyncTargetDeck(deckTitle);
  } catch (error) {
    console.error("Failed to resolve sync target", error);
  }

  const isUpdate = Boolean(syncTarget.existingDeck);
  const actionText = syncTarget.overwriteExisting
    ? "Overwrite existing web deck"
    : isUpdate
      ? "Update existing web deck"
      : "Create new web deck";
  const deckCategory = categoryForSync(syncTarget.existingDeck);
  
  modal.hidden = false;
  if (confirmBtn) confirmBtn.disabled = true;
  
  content.innerHTML = `
    <p><strong>Action:</strong> ${actionText}</p>
    <p><strong>Title:</strong> ${escapeHtml(deckTitle)}</p>
    <p><strong>Category:</strong> ${escapeHtml(deckCategory)}</p>
    <p><strong>Cards:</strong> ${cardsCount} total (${knownCount} known, ${reviewCount} review)</p>
    <p><strong>Current Position:</strong> Card ${state.current + 1}</p>
    <br>
    <p style="color: var(--text-secondary);">Calculating differences...</p>
  `;
  
  let diffHtml = "";

  if (!isUpdate || !supabaseClient) {
    diffHtml = `<p style="color: var(--text-secondary);">This will create a new deck on the web with your ${cardsCount} cards.</p>`;
  } else {
    try {
      const { data: webCards, error } = await supabaseClient
        .from("cards")
        .select("id, question, answer, status, position")
        .eq("deck_id", syncTarget.deckId);

      if (error) throw error;

      const { added, deleted, edited, moved, statusChanges } = calculateSyncDiff(state.masterCards, webCards || [], state.statusById);
      // Notes live on the deck row, not on cards, so they are compared
      // separately from the card diff.
      const notesChanged = syncTextChanged(state.notes, syncTarget.existingDeck?.notes || "");

      if (added === 0 && deleted === 0 && edited === 0 && moved === 0 && statusChanges === 0 && !notesChanged) {
        diffHtml = `<p style="color: var(--text-secondary);">No changes detected. The web deck is up to date.</p>`;
      } else {
        diffHtml = `<p style="color: var(--text-secondary); margin-bottom: 0.5rem;"><strong>${syncTarget.overwriteExisting ? "Local import will overwrite web deck:" : "Changes to sync:"}</strong></p>
        <ul style="color: var(--text-secondary); margin-left: 1.5rem; list-style-type: disc;">`;
        if (added > 0) diffHtml += `<li>${added} card${added > 1 ? 's' : ''} added</li>`;
        if (deleted > 0) diffHtml += `<li>${deleted} card${deleted > 1 ? 's' : ''} deleted</li>`;
        if (edited > 0) diffHtml += `<li>${edited} card${edited > 1 ? 's' : ''} modified</li>`;
        if (moved > 0) diffHtml += `<li>${moved} card position${moved > 1 ? 's' : ''} updated</li>`;
        if (statusChanges > 0) diffHtml += `<li>${statusChanges} status update${statusChanges > 1 ? 's' : ''}</li>`;
        if (notesChanged) diffHtml += `<li>Study notes updated</li>`;
        diffHtml += `</ul>`;
      }
    } catch (err) {
      console.error("Failed to calculate sync differences", err);
      diffHtml = `<p style="color: #ff4a4a;">Could not calculate differences. Proceeding will overwrite web data.</p>`;
    }
  }

  content.innerHTML = `
    <p><strong>Action:</strong> ${actionText}</p>
    <p><strong>Title:</strong> ${escapeHtml(deckTitle)}</p>
    <p><strong>Category:</strong> ${escapeHtml(deckCategory)}</p>
    <p><strong>Cards:</strong> ${cardsCount} total (${knownCount} known, ${reviewCount} review)</p>
    <p><strong>Current Position:</strong> Card ${state.current + 1}</p>
    <br>
    ${diffHtml}
  `;
  
  if (confirmBtn) confirmBtn.disabled = false;
}

// Shared HTML for a sync report — every deck reconcileAllDecks() touched,
// what direction it went, and exactly what changed (cards added/updated/
// deleted, notes). Used both by the explicit-sync modal and the inline
// startup report on the welcome screen.
function buildSyncReportHtml(deckLog, { pulled = 0, pushed = 0, failed = 0 } = {}) {
  const describeCounts = (entry) => {
    const parts = [];
    if (entry.cardsAdded) parts.push(`${entry.cardsAdded} card${entry.cardsAdded === 1 ? "" : "s"} added`);
    if (entry.cardsUpdated) parts.push(`${entry.cardsUpdated} card${entry.cardsUpdated === 1 ? "" : "s"} updated`);
    if (entry.cardsDeleted) parts.push(`${entry.cardsDeleted} card${entry.cardsDeleted === 1 ? "" : "s"} deleted`);
    if (entry.notesChanged) parts.push("notes updated");
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

// Core cloud writer shared by the active-deck sync and the headless
// library-reconcile sync. Upserts the deck row and diff-upserts its cards from
// an explicit payload (never touches `state`). Throws on failure.
// `cards`: [{ id, question, answer, status }] in display order.
async function pushDeckRowsToCloud({ deckId, title, category, notes, currentIndex, cards, isNewDeck, overwrite, now, say = () => {}, silent = true }) {
  const deckData = {
    id: deckId,
    title,
    category,
    notes: notes || "",
    current_card_index: Number.isFinite(currentIndex) ? currentIndex : 0,
    updated_at: now,
    last_accessed_at: now
  };

  let { error: deckError } = await supabaseClient.from("decks").upsert(deckData);
  if (deckError && String(deckError.message || "").includes("notes")) {
    // Database hasn't run supabase_deck_notes.sql yet — sync everything else so
    // the user doesn't lose card changes, but warn about notes.
    const { notes: _omit, ...deckDataWithoutNotes } = deckData;
    ({ error: deckError } = await supabaseClient.from("decks").upsert(deckDataWithoutNotes));
    if (!deckError && String(notes || "").trim() && !silent) {
      showToast("Notes not synced — run supabase_deck_notes.sql in Supabase", "error");
    }
  }
  if (deckError) throw deckError;

  let webCardsById = new Map();
  let cardsDeleted = 0;
  if (overwrite) {
    say("Syncing... (2/3) Replacing existing web cards");
    const { error } = await supabaseClient.from("cards").delete().eq("deck_id", deckId);
    if (error) throw error;
  } else if (!isNewDeck) {
    say("Syncing... (2/3) Checking for changes");
    const { data: webCards, error } = await supabaseClient
      .from("cards")
      .select("id, question, answer, position, status")
      .eq("deck_id", deckId);
    if (!error && webCards) {
      webCardsById = new Map(webCards.map((wc) => [String(wc.id), wc]));
      const localIds = new Set(cards.map((c) => String(c.id)));
      const idsToDelete = webCards.filter((wc) => !localIds.has(String(wc.id))).map((wc) => wc.id);
      cardsDeleted = idsToDelete.length;
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await supabaseClient
          .from("cards").delete().eq("deck_id", deckId).in("id", idsToDelete);
        if (deleteError) throw deleteError;
      }
    }
  }

  const cardsData = cards
    .map((card, index) => {
      const status = normalizeCardStatus(card.status);
      const webCard = webCardsById.get(String(card.id));
      const unchanged = webCard
        && !syncTextChanged(card.question, webCard.question)
        && !syncTextChanged(card.answer, webCard.answer)
        && Number(webCard.position) === index
        && normalizeCardStatus(webCard.status) === status;
      if (unchanged) return null;
      return { id: card.id, deck_id: deckId, question: card.question, answer: card.answer, position: index, status, updated_at: now };
    })
    .filter(Boolean);

  say(`Syncing... (3/3) Saving ${cardsData.length} of ${cards.length} cards`);
  const chunkSize = 50;
  // Upload chunks sequentially — parallel Promise.all could leave the cloud
  // in a partial state if chunk N fails while chunk N+1 already succeeded,
  // silently dropping the cards in the failed chunk.
  for (let i = 0; i < cardsData.length; i += chunkSize) {
    const { error: chunkError } = await supabaseClient.from("cards").upsert(cardsData.slice(i, i + chunkSize));
    if (chunkError) throw chunkError;
  }

  // Stats for the detailed sync report — cardsAdded are new ids the cloud
  // didn't have yet; the rest of cardsData are existing cards whose text,
  // status, or position actually changed (isNewDeck/overwrite never had a
  // prior web copy to diff against, so every card counts as "added" there).
  const cardsAdded = cardsData.filter((c) => !webCardsById.has(String(c.id))).length;
  return {
    cardsAdded,
    cardsUpdated: cardsData.length - cardsAdded,
    cardsDeleted
  };
}

// Pushes the currently-loaded deck. Returns the ISO timestamp written to the
// cloud on success (so callers can align the local library copy), or false.
async function syncDeckToWeb({ silent = false } = {}) {
  if (!supabaseClient) return false;
  el.syncModal.hidden = true;

  if (!state.masterCards.length && !state.notes.trim()) {
    if (!silent) setStatus("No deck to sync.", "error");
    return false;
  }

  const say = (msg, kind) => { if (!silent) setStatus(msg, kind); };
  const syncBtn = document.getElementById("syncBtn");
  if (syncBtn) setButtonLoading(syncBtn, true, "Syncing…");

  try {
    const deckTitle = state.deckTitle || state.sourceTitle || "Untitled Deck";
    const syncTarget = await resolveSyncTargetDeck(deckTitle);
    state.deckId = syncTarget.deckId;
    state.deckCategory = categoryForSync(syncTarget.existingDeck);

    say(`Syncing... (1/3) Saving deck info "${deckTitle}"`);
    const now = new Date().toISOString();

    await pushDeckRowsToCloud({
      deckId: state.deckId,
      title: deckTitle,
      category: state.deckCategory,
      notes: state.notes,
      currentIndex: state.current,
      cards: state.masterCards.map((c) => ({
        id: c.id, question: c.question, answer: c.answer, status: normalizeCardStatus(state.statusById[c.id])
      })),
      isNewDeck: !syncTarget.existingDeck,
      overwrite: syncTarget.overwriteExisting,
      now, say, silent
    });

    // Align the local library copy's timestamps with the cloud so the next
    // reconcileAllDecks doesn't re-push this deck (or worse, pull a
    // slightly-newer cloud copy over it due to clock skew).
    saveDeckToLibrary({ silent: true, updatedAt: now, lastSyncedAt: now });
    refreshSyncIndicatorBaseline();

    say("Deck synced to web successfully.");
    if (!silent) showToast(`Synced "${deckTitle}" to cloud · ${state.masterCards.length} cards`);
    return now;
  } catch (error) {
    const errorMessage = String(error?.message || "");
    say(
      errorMessage.includes("category") || errorMessage.includes("last_accessed_at")
        ? "Failed to sync deck metadata. Run supabase_deck_categories.sql in Supabase first."
        : errorMessage.includes("notes")
          ? "Failed to sync deck metadata. Run supabase_deck_notes.sql in Supabase first."
          : "Failed to sync deck to web.",
      "error"
    );
    if (!silent) showToast("Cloud sync failed", "error");
    console.error(error);
    return false;
  } finally {
    if (syncBtn) setButtonLoading(syncBtn, false);
  }
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
  openWebDecksFromImportBtn: document.querySelector("#openWebDecksFromImportBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  deckMenuBtn: document.querySelector("#deckMenuBtn"),
  deckMenu: document.querySelector("#deckMenu"),
  newDeckBtn: document.querySelector("#newDeckBtn"),
  newDeckFromImportBtn: document.querySelector("#newDeckFromImportBtn"),
  importBtn: document.querySelector("#importBtn"),
  myDecksBtn: document.querySelector("#myDecksBtn"),
  syncNowBtn: document.querySelector("#syncNowBtn"),
  myDecksPanel: document.querySelector("#myDecksPanel"),
  myDecksListTable: document.querySelector("#myDecksListTable"),
  closeMyDecksBtn: document.querySelector("#closeMyDecksBtn"),
  myDecksRefreshBtn: document.querySelector("#myDecksRefreshBtn"),
  closeImportBtn: document.querySelector("#closeImportBtn"),
  importPanel: document.querySelector("#importPanel"),
  printRoot: document.querySelector("#printRoot"),
  diagramModal: document.querySelector("#diagramModal"),
  diagramModalBody: document.querySelector("#diagramModalBody"),
  closeDiagramBtn: document.querySelector("#closeDiagramBtn"),
  diagramZoomInBtn: document.querySelector("#diagramZoomInBtn"),
  diagramZoomOutBtn: document.querySelector("#diagramZoomOutBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  exportMenu: document.querySelector("#exportMenu"),
  allCardsBtn: document.querySelector("#allCardsBtn"),
  allCardsPanel: document.querySelector("#allCardsPanel"),
  allCardsList: document.querySelector("#allCardsList"),
  allCardsSummary: document.querySelector("#allCardsSummary"),
  toggleAllAnswersBtn: document.querySelector("#toggleAllAnswersBtn"),
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
  webDeckCategoryFilter: document.querySelector("#webDeckCategoryFilter"),
  globalWebExportBtn: document.querySelector("#globalWebExportBtn"),
  globalWebExportMenu: document.querySelector("#globalWebExportMenu"),
  shuffleBtn: document.querySelector("#shuffleBtn"),
  resetBtn: document.querySelector("#resetBtn"),
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
  notesEdit: document.querySelector("#notesEdit"),
  notesEditToolbar: document.querySelector("#notesEditToolbar"),
  editNotesBtn: document.querySelector("#editNotesBtn"),
  makeCardFromSelectionBtn: document.querySelector("#makeCardFromSelectionBtn"),
  makeCardFromNotesBtn: document.querySelector("#makeCardFromNotesBtn"),
  frameCardModal: document.querySelector("#frameCardModal"),
  frameCardAnswerPreview: document.querySelector("#frameCardAnswerPreview"),
  frameCardQuestionInput: document.querySelector("#frameCardQuestionInput"),
  frameCardAddBtn: document.querySelector("#frameCardAddBtn"),
  frameCardCancelBtn: document.querySelector("#frameCardCancelBtn"),
  syncModal: document.querySelector("#syncModal"),
  syncDetailsContent: document.querySelector("#syncDetailsContent"),
  webDecksPanel: document.querySelector("#webDecksPanel"),
  webDecksListTable: document.querySelector("#webDecksListTable"),
  selectAllWebDecksCheckbox: document.querySelector("#selectAllWebDecksCheckbox"),
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
    securityLevel: "loose",
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

function decimalPlaces(value) {
  const text = String(value);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

function formatStyleNumber(value, step) {
  const precision = decimalPlaces(step || 1);
  const fixed = value.toFixed(precision);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") || "0" : fixed;
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
    section.open = true;

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

  const root = document.documentElement;
  root.style.setProperty("--app-font-family", resolveFontFamily(settings.fontFamily));
  root.style.setProperty("--question-font-family", resolveFontFamily(settings.questionFontFamily));
  root.style.setProperty("--answer-font-family", resolveFontFamily(settings.answerFontFamily));
  root.style.setProperty("--question-justify-items", questionJustifyItems(settings.questionAlign));
  Object.entries(styleCssVariables).forEach(([key, cssVariable]) => {
    if (key === "questionFontFamily" || key === "answerFontFamily") return;
    root.style.setProperty(cssVariable, settings[key]);
  });
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
    setStyleStatus("Style sync table not ready");
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
    setStatus("Failed to sync style. Create the app_style_settings table first.", "error");
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

function showPromptModal(title, hint, defaultValue, onConfirm) {
  if (!el.promptModal) {
    const result = prompt(title, defaultValue);
    if (result !== null) onConfirm(result);
    return;
  }
  el.promptModalTitle.textContent = title;
  el.promptModalHint.textContent = hint || "";
  el.promptModalHint.hidden = !hint;
  el.promptModalInput.value = defaultValue || "";
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
  localStorage.setItem("swipe-hint-seen", "1");
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
    setDeckTitle(title, { updateSourceTitle: true });
    if (!state.deckId || !supabaseClient) {
      setStatus("Deck title updated.");
      return;
    }
    try {
      setStatus("Updating web deck title...");
      await updateWebDeckTitle(state.deckId, title);
      setStatus("Deck title updated in the cloud.");
    } catch (error) {
      console.error("Failed to update web deck title", error);
      setStatus("Deck title updated locally, but cloud rename failed.", "error");
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

function openWebDecksPanel() {
  lockPageScroll();
  el.webDecksPanel.hidden = false;
  // Prefetch the deck list on open so the panel is never stale/empty; the
  // "Refresh List" button remains for an on-demand re-fetch.
  fetchWebDecks();
}

function closeImportPanel() {
  closePasteEditor(true);
  el.importPanel.classList.remove("is-open");
  unlockPageScroll();
}

function openMyDecksPanel() {
  lockPageScroll();
  el.myDecksPanel.hidden = false;
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
  return `<tr><td colspan="6" class="web-decks-empty">${escapeHtml(message)}</td></tr>`;
}

// One row for a deck stored in the on-device library. `cloudById` (Map or null)
// drives the Sync column — null renders a tentative state before the cloud
// fetch resolves.
function buildLocalDeckRow(deck, cloudById = null) {
  const tr = document.createElement("tr");
  if (deck.id === state.localDeckId) tr.classList.add("is-current-local-deck");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.textContent = normalizeDeckCategory(deck.category);

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  tdCount.textContent = String(deck.cardCount ?? "—") + (deck.hasNotes ? " 📝" : "");
  if (deck.hasNotes) tdCount.title = "This deck has study notes";

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.textContent = formatLocalDeckSavedDate(deck.updatedAt);

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  // The flex layout goes on an inner wrapper, not the <td> itself — a table
  // cell with display:flex stops participating in the table's column-track
  // sizing (it gets sized by its flex content instead), which was squeezing
  // this column down to a sliver regardless of its CSS width.
  const actionsWrap = document.createElement("div");
  actionsWrap.className = "my-deck-actions";

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "bulk-action-btn bulk-load";
  loadBtn.textContent = "Load";
  loadBtn.addEventListener("click", () => {
    if (loadDeckFromLibrary(deck.id)) {
      closeMyDecksPanel();
      showToast(`Loaded "${deck.title || "deck"}"`);
    }
  });

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "bulk-action-btn bulk-category";
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("click", () => {
    const next = window.prompt("Rename deck", deck.title || "");
    if (next && next.trim()) {
      renameDeckInLibrary(deck.id, next);
      renderMyDecksList();
      if (state.localDeckId === deck.id) updateMeta();
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "bulk-action-btn bulk-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    const inCloud = Boolean(deck.deckId);
    const scope = inCloud ? "from this device and the cloud" : "from this device";
    showConfirmModal(`Delete "${deck.title || "this deck"}" ${scope}? This cannot be undone.`, async () => {
      const { cloudError } = await deleteDeckEverywhere({ localId: deck.id, deckId: deck.deckId || null });
      renderMyDecksList();
      if (cloudError) {
        showToast("Deleted here — cloud delete will retry on next sync", "info");
      } else {
        showToast(inCloud ? "Deck deleted everywhere" : "Deck deleted from device", "info");
      }
    }, { confirmLabel: "Delete", danger: true });
  });

  actionsWrap.append(loadBtn, renameBtn, deleteBtn);
  tdActions.append(actionsWrap);
  tr.append(tdTitle, tdCategory, tdCount, tdSaved, deckSyncStatusCell(deck, cloudById), tdActions);
  return tr;
}

// One row for a deck that only exists in the cloud (not yet on this device).
function buildCloudDeckRow(deck) {
  const tr = document.createElement("tr");
  tr.classList.add("is-cloud-only-deck");

  const tdTitle = document.createElement("td");
  tdTitle.dataset.label = "Title";
  tdTitle.textContent = deck.title || "Untitled deck";

  const tdCategory = document.createElement("td");
  tdCategory.dataset.label = "Category";
  tdCategory.textContent = normalizeDeckCategory(deck.category);

  const tdCount = document.createElement("td");
  tdCount.dataset.label = "Cards";
  const cloudCount = Array.isArray(deck.cards) ? deck.cards[0]?.count : deck.cardCount;
  tdCount.textContent = String(cloudCount ?? "—") + (String(deck.notes || "").trim() ? " 📝" : "");

  const tdSaved = document.createElement("td");
  tdSaved.dataset.label = "Saved";
  tdSaved.className = "my-deck-cloud-tag";
  tdSaved.textContent = "☁ Cloud";
  tdSaved.title = "In the cloud — tap Load to pull it onto this device";

  const tdSync = document.createElement("td");
  tdSync.dataset.label = "Sync";
  tdSync.classList.add("my-deck-sync", "sync-cloud-only");
  tdSync.textContent = "☁ Cloud only";
  tdSync.title = "In the cloud but not on this device yet — Load to pull it down.";

  const tdActions = document.createElement("td");
  tdActions.dataset.label = "Actions";
  const actionsWrap = document.createElement("div");
  actionsWrap.className = "my-deck-actions";

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "bulk-action-btn bulk-load";
  loadBtn.textContent = "Load";
  loadBtn.addEventListener("click", () => {
    closeMyDecksPanel();
    loadWebDeck(deck.id);
  });

  actionsWrap.append(loadBtn);
  tdActions.append(actionsWrap);
  tr.append(tdTitle, tdCategory, tdCount, tdSaved, tdSync, tdActions);
  return tr;
}

async function fetchCloudDeckList() {
  const { data, error } = await supabaseClient
    .from("decks")
    .select("*, cards(count)")
    .order("last_accessed_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Per-deck sync state for the My Decks "Sync" column, comparing the on-device
// copy against the cloud (when we can reach it). `cloudById` is a Map of cloud
// decks, or null when we haven't/can't fetch it. Mirrors the timestamp logic
// reconcileAllDecks uses to decide direction, so the column predicts what the
// next sync will do to each deck.
function deckSyncStatusCell(deck, cloudById) {
  const td = document.createElement("td");
  td.dataset.label = "Sync";
  td.classList.add("my-deck-sync");

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
  td.textContent = label;
  td.classList.add(cls);
  td.title = title;
  return td;
}

// The unified library view: on-device decks first, then any cloud decks that
// aren't on this device yet (for signed-in, online users). `cloudById` (a Map,
// or null before/without a cloud fetch) drives the per-deck Sync column.
function renderMyDecksRows(localDecks, cloudById, { cloudOnly = [] } = {}) {
  const tbody = el.myDecksListTable;
  if (!tbody) return;
  tbody.innerHTML = "";
  localDecks.forEach((deck) => tbody.appendChild(buildLocalDeckRow(deck, cloudById)));
  cloudOnly.forEach((deck) => tbody.appendChild(buildCloudDeckRow(deck)));
}

async function renderMyDecksList() {
  const tbody = el.myDecksListTable;
  if (!tbody) return;

  const localDecks = listLocalDecks();
  const localCloudIds = new Set(localDecks.map((d) => String(d.deckId)).filter((id) => id && id !== "null"));

  const canCloud = Boolean(supabaseClient && isSignedIn);

  // Render on-device rows immediately (with a tentative Sync column) so the list
  // never waits on the network; the cloud fetch below re-renders with the real
  // sync state and appends any cloud-only decks.
  renderMyDecksRows(localDecks, null);

  if (!(canCloud && navigator.onLine)) {
    if (!localDecks.length) {
      tbody.innerHTML = myDecksEmptyRow(
        canCloud
          ? "No decks on this device yet. Create or import a deck — it saves and syncs automatically."
          : "No decks yet. Create or import a deck to get started."
      );
    }
    return;
  }

  const loadingRow = document.createElement("tr");
  loadingRow.innerHTML = `<td colspan="6" class="web-decks-empty">Checking the cloud for more decks…</td>`;
  tbody.appendChild(loadingRow);

  try {
    const cloudDecks = await fetchCloudDeckList();
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudOnly = cloudDecks.filter((deck) => !localCloudIds.has(String(deck.id)) && !isDeckTombstoned(deck.id));
    renderMyDecksRows(localDecks, cloudById, { cloudOnly });
    if (!localDecks.length && !cloudOnly.length) {
      tbody.innerHTML = myDecksEmptyRow("No decks yet. Create or import a deck — it saves and syncs automatically.");
    }
  } catch (error) {
    loadingRow.remove();
    console.warn("Could not fetch cloud decks for My Decks", error);
    if (!localDecks.length) {
      tbody.innerHTML = myDecksEmptyRow("No decks on this device yet. (Couldn't reach the cloud right now.)");
    }
  }
}

function saveCurrentDeckToDevice() {
  const meta = saveDeckToLibrary();
  if (!meta) return;
  showToast(`Saved "${meta.title}" to device · ${meta.cardCount} cards`);
  setStatus("Deck saved to this device.");
  if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
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

  return cards.map((card, index) => ({
    id: `${index}-${card.question.slice(0, 32)}`,
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

    if ((source.startsWith("\\[", index) || source.startsWith("\\(", index)) && !isEscaped(source, index)) {
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
function protectInline(segment) {
  return protectMath(applyClozeMarkup(segment));
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

function preprocessSpecialBlocks(markdown) {
  const source = normalizeMarkdown(markdown || "");
  const fencePattern = /```[ \t]*([^\n]*)\n([\s\S]*?)```/g;
  let output = "";
  let lastIndex = 0;
  let match;

  while ((match = fencePattern.exec(source))) {
    output += protectInline(renderImageRows(source.slice(lastIndex, match.index)));
    if (/\bmermaid\b/i.test(match[1])) {
      output += `<div class="mermaid" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else if (/\bnomnoml\b/i.test(match[1])) {
      output += `<div class="nomnoml-diagram" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else {
      output += match[0];
    }
    lastIndex = fencePattern.lastIndex;
  }

  output += protectInline(renderImageRows(source.slice(lastIndex)));
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

async function renderMarkdown(container, markdown, allowPlaceholder = false) {
  let displayMarkdown = markdown;
  if (allowPlaceholder && (!markdown || String(markdown).trim() === "")) {
    if (container.closest(".all-card-question") || container.closest(".card-question")) {
      displayMarkdown = "<div class='empty-placeholder'>Question</div>";
    } else if (container.closest(".all-card-answer") || container.closest(".card-answer")) {
      displayMarkdown = "<div class='empty-placeholder'>Answer</div>";
    }
  }
  container.innerHTML = markdownToSafeHtml(displayMarkdown);
  await enhanceRenderedMarkdown(container);
  if (container === el.notesView) enhanceNotesImageControls();
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
    if (table.closest("pre")) return;

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

function deleteAllCard(cardId) {
  showConfirmModal("Delete this card? This cannot be undone.", () => {
    state.masterCards = state.masterCards.filter(c => c.id !== cardId);
    state.cards = state.cards.filter(c => c.id !== cardId);
    delete state.statusById[cardId];
    if (state.current >= state.cards.length) {
      state.current = Math.max(0, state.cards.length - 1);
    }
    showCard();
    renderAllCards();
    setStatus(state.deckId ? "Card deleted locally. Sync to update the web deck." : "Card deleted.");
  }, { confirmLabel: "Delete", danger: true });
}

function updateBulkActionVisibility() {
  const selectedCheckboxes = document.querySelectorAll(".web-deck-row-checkbox:checked");
  const count = selectedCheckboxes.length;
  const bulkBar = document.getElementById("webDecksBulkActions");
  const countSpan = document.getElementById("selectedDecksCount");
  
  if (countSpan) countSpan.textContent = count;
  
  if (bulkBar) {
    bulkBar.hidden = count === 0;
  }

  const allCheckboxes = document.querySelectorAll(".web-deck-row-checkbox");
  if (el.selectAllWebDecksCheckbox && allCheckboxes.length > 0) {
    el.selectAllWebDecksCheckbox.checked = selectedCheckboxes.length === allCheckboxes.length;
    el.selectAllWebDecksCheckbox.indeterminate = selectedCheckboxes.length > 0 && selectedCheckboxes.length < allCheckboxes.length;
  }
}

async function loadSelectedWebDecks(deckIds) {
  if (!deckIds.length || !supabaseClient) return;
  setStatus(`Loading ${deckIds.length} decks from web...`);
  try {
    const combinedCards = [];
    const combinedStatusById = {};
    const titles = [];
    let combinedCategory = "";

    for (const deckId of deckIds) {
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

      titles.push(deckData.title || "Untitled");
      if (!combinedCategory) {
        combinedCategory = normalizeDeckCategory(deckData.category);
      }

      cardsData.forEach((rawCard, index) => {
        const id = String(rawCard.id || `${index}-${rawCard.question.slice(0, 32)}`);
        const status = normalizeCardStatus(rawCard.status);
        if (status) {
          combinedStatusById[id] = status;
        }
        combinedCards.push({ id, question: rawCard.question, answer: rawCard.answer });
      });
    }

    state.deckId = null;
    state.masterCards = combinedCards;
    resetStudyDeck(state.masterCards);
    state.statusById = combinedStatusById;
    state.current = 0;
    state.deckTitle = titles.join(" + ");
    state.deckCategory = combinedCategory;
    state.sourceTitle = state.deckTitle;
    state.importTitleHint = state.deckTitle;

    syncResults();
    closeAllCardsPanel();
    el.webDecksPanel.hidden = true;
    unlockPageScroll();
    showCard();
    setStatus(`Successfully loaded ${deckIds.length} decks.`);
    showToast(`Loaded ${deckIds.length} decks · ${combinedCards.length} cards`);
  } catch (error) {
    console.error("Failed to load selected web decks", error);
    setStatus("Failed to load selected web decks.", "error");
    showToast("Couldn't load selected decks", "error");
  }
}

async function deleteSelectedWebDecks(deckIds) {
  if (!deckIds.length || !supabaseClient) return;
  showConfirmModal(
    `Delete ${deckIds.length} selected ${deckIds.length === 1 ? "deck" : "decks"} from this device and the cloud? This cannot be undone.`,
    async () => {
      setStatus(`Deleting ${deckIds.length} decks...`);
      try {
        const localIndex = readLocalDeckIndex();
        for (const deckId of deckIds) {
          const localMeta = localIndex.find((m) => String(m.deckId) === String(deckId));
          const { cloudError } = await deleteDeckEverywhere({ localId: localMeta?.id || null, deckId });
          if (cloudError) throw cloudError;
        }
        setStatus(`Successfully deleted ${deckIds.length} decks.`);
        showToast(`Deleted ${deckIds.length} decks everywhere`);
        fetchWebDecks();
        if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
      } catch (error) {
        console.error("Failed to delete selected web decks", error);
        setStatus("Failed to delete selected web decks.", "error");
        showToast("Couldn't delete selected decks", "error");
      }
    },
    { confirmLabel: "Delete All", danger: true }
  );
}

async function changeSelectedWebDecksCategory(deckIds) {
  if (!deckIds.length || !supabaseClient) return;

  showPromptModal("Set Category", `Apply to ${deckIds.length} selected decks`, "General", async (nextCategory) => {
    const category = normalizeDeckCategory(nextCategory.trim());
    if (!category) {
      setStatus("Category cannot be empty.", "error");
      return;
    }
    setStatus(`Updating category for ${deckIds.length} decks...`);
    try {
      for (const deckId of deckIds) {
        await applyWebDeckCategory(deckId, category);
        if (state.deckId === deckId) state.deckCategory = category;
      }
      updateMeta();
      setStatus(`Updated category for ${deckIds.length} decks.`);
      showToast(`Set category "${category}" on ${deckIds.length} decks`);
      fetchWebDecks();
    } catch (error) {
      console.error("Failed to update selected decks category", error);
      setStatus("Failed to update selected decks category.", "error");
      showToast("Couldn't update categories", "error");
    }
  });
}

async function exportSelectedWebDecks(deckIds, format) {
  if (!deckIds.length || !supabaseClient) return;

  try {
    setStatus(`Exporting ${deckIds.length} web decks...`);
    const payloads = [];
    for (const deckId of deckIds) {
      const payload = await fetchWebDeckPayload(deckId);
      payloads.push(payload);
    }

    if (format === "pdf") {
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
          cards.push({
            id,
            question: card.question,
            answer: card.answer,
            position: cards.length
          });
          const status = normalizeCardStatus(card.status);
          if (status) statusById[id] = status;
        });
      });
      await exportCardsPdf("Selected Web Decks", cards, { fileBaseName: "selected-web-decks", statusById });
    } else if (format === "markdown") {
      downloadTextFile(
        payloads.map(webDeckPayloadMarkdown).join("\n\n---\n\n"),
        "selected-web-decks.md",
        "text/markdown;charset=utf-8"
      );
      setStatus("Exported selected web decks as Markdown.");
    } else if (format === "sql") {
      downloadTextFile(buildDeckSql(payloads, "Selected Web Decks SQL Export"), "selected-web-decks.sql", "application/sql;charset=utf-8");
      setStatus("Exported selected web decks as SQL.");
    } else {
      downloadTextFile(
        `${JSON.stringify({
          app: "recall",
          version: 1,
          exportedAt: new Date().toISOString(),
          decks: payloads.map(deckPayloadSnapshot)
        }, null, 2)}\n`,
        "selected-web-decks.json",
        "application/json;charset=utf-8"
      );
      setStatus("Exported selected web decks as JSON.");
    }
    
    if (format !== "pdf") showToast(`Exported ${deckIds.length} decks as ${format.toUpperCase()}`);
    for (const deckId of deckIds) {
      await touchWebDeckAccess(deckId);
    }
    fetchWebDecks();
  } catch (error) {
    console.error("Failed to export selected web decks", error);
    setStatus("Failed to export selected web decks.", "error");
    showToast("Export failed", "error");
  }
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
  return { id: 'card-' + Date.now(), question: '', answer: '' };
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
  const [card] = state.masterCards.splice(fromIndex, 1);
  let insertIndex = targetIndex + (placement === "after" ? 1 : 0);
  if (fromIndex < insertIndex) insertIndex -= 1;
  insertIndex = Math.min(Math.max(insertIndex, 0), state.masterCards.length);

  if (insertIndex === fromIndex) {
    state.masterCards.splice(fromIndex, 0, card);
    return;
  }

  state.masterCards.splice(insertIndex, 0, card);
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
  el.allCardsSummary.textContent = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  updateAllAnswersToggleButton();

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
  el.nextCardBtn.disabled = Boolean(state.previewCard) || total === 0 || state.current >= total - 1;
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
  el.editNotesBtn.classList.remove("is-editing");
  el.editNotesBtn.title = "Edit notes";
  hideNotesSelectionButton();
}

function commitNotesEditIfActive() {
  if (!isNotesEditing()) return;
  state.notes = el.notesEdit.value;
  resetNotesEditingUI();
  renderMarkdown(el.notesView, state.notes, true);
  scheduleDeckAutosave();
  updateMeta();
}

function enterNotesEditing() {
  if (!el.notesEdit || isNotesEditing()) return;
  el.notesEdit.value = state.notes;
  el.notesView.hidden = true;
  el.notesEdit.hidden = false;
  el.notesEditToolbar.hidden = false;
  el.editNotesBtn.classList.add("is-editing");
  el.editNotesBtn.title = "Back to preview";
  hideNotesSelectionButton();
  el.notesEdit.dispatchEvent(new Event("input", { bubbles: true }));
  el.notesEdit.focus();
}

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
    renderMarkdown(el.notesView, state.notes, true);
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
  scheduleDeckAutosave();
});

el.viewModeToggle?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-view-mode]");
  if (button) setViewMode(button.dataset.viewMode);
});

el.notesBtn?.addEventListener("click", () => setViewMode("notes"));

// ── Select text in notes (rendered OR raw) → make a flashcard in this deck ──
// Highlighting text/images in the notes preview, or a text range in the raw
// markdown editor, floats a "+ Make card · N words" pill next to the
// selection; tapping it opens the frame-card modal where the captured
// selection (serialized back to markdown, so images and math survive) is
// previewed as the ANSWER and the user frames the question.
// Works offline — the new card syncs with the normal flow.
let notesSelectionTimer = null;

function hideNotesSelectionButton() {
  if (!el.makeCardFromSelectionBtn) return;
  el.makeCardFromSelectionBtn.hidden = true;
  el.makeCardFromSelectionBtn.dataset.selectionText = "";
}

// The live selection's range, but only when it's a real selection inside the
// rendered notes view.
function notesSelectionRange() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!el.notesView || el.notesView.hidden) return null;
  if (!el.notesView.contains(selection.anchorNode) || !el.notesView.contains(selection.focusNode)) return null;
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

// Serialize the notes selection back to MARKDOWN, so images, math, bold text
// etc. survive into the card. selection.toString() would only give plain
// text — for a selected image it literally yields the "Zoom" button label of
// its .diagram-shell wrapper.
function notesSelectionMarkdown(range) {
  const fragment = cleanedSelectionFragment(range);
  const markdown = htmlToMarkdown(fragment.innerHTML).trim();
  return markdown || fragment.textContent.trim();
}

// The raw-textarea equivalent of notesSelectionRange(): plain selected text
// (already markdown source, so no HTML→markdown conversion needed) plus its
// image count, counted from markdown image syntax since there's no DOM to
// query.
function notesEditSelectionText() {
  if (!isNotesEditing()) return "";
  const { selectionStart, selectionEnd, value } = el.notesEdit;
  if (selectionStart === selectionEnd) return "";
  return value.slice(selectionStart, selectionEnd);
}

// The current selection's markdown, regardless of whether notes are being
// viewed (rendered) or edited (raw) — shared by the floating pill and the
// persistent toolbar button.
function currentNotesSelectionMarkdown() {
  if (isNotesEditing()) return notesEditSelectionText().trim();
  const range = notesSelectionRange();
  return range ? notesSelectionMarkdown(range) : "";
}

function scheduleNotesSelectionCheck() {
  if (notesSelectionTimer) clearTimeout(notesSelectionTimer);
  notesSelectionTimer = setTimeout(positionNotesSelectionButton, 160);
}

function positionNotesSelectionButton() {
  const button = el.makeCardFromSelectionBtn;
  if (!button) return;
  if (state.viewMode !== "notes") {
    hideNotesSelectionButton();
    return;
  }

  if (isNotesEditing()) {
    const raw = notesEditSelectionText();
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
    const editRect = el.notesEdit.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const margin = 12;
    const top = Math.min(editRect.bottom - btnRect.height - margin, window.innerHeight - btnRect.height - margin);
    const left = Math.min(editRect.right - btnRect.width - margin, window.innerWidth - btnRect.width - margin);
    button.style.top = `${Math.max(margin, top)}px`;
    button.style.left = `${Math.max(margin, left)}px`;
    return;
  }

  const range = notesSelectionRange();
  const fragment = range ? cleanedSelectionFragment(range) : null;
  const text = fragment ? fragment.textContent.trim() : "";
  const imageCount = fragment ? fragment.querySelectorAll("img").length : 0;
  if (!text && !imageCount) {
    hideNotesSelectionButton();
    return;
  }
  const rect = range.getBoundingClientRect();
  // Capture the selection as markdown now: tapping the button may dissolve
  // the selection before the click handler runs.
  button.dataset.selectionText = notesSelectionMarkdown(range);
  // Show how much is being captured, so the selection size is obvious.
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const parts = [];
  if (words) parts.push(`${words} word${words === 1 ? "" : "s"}`);
  if (imageCount) parts.push(imageCount === 1 ? "1 image" : `${imageCount} images`);
  button.textContent = `+ Make card · ${parts.join(" + ")}`;
  button.hidden = false;
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

function addCardFromNotes(question, answer) {
  const card = {
    // Random suffix: bare Date.now() collides when cards are created from
    // several selections in quick succession.
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer
  };
  const refreshActive = activeDeckMatchesMasterOrder();
  state.masterCards.push(card);
  if (refreshActive) state.cards.push(card);
  syncResults();
  updateMeta();
  scheduleDeckAutosave();
  showToast(`Card added · ${state.masterCards.length} total`);
  setStatus(state.deckId ? "Card added from notes locally. Sync to update the web deck." : "Card added from notes.");
}

function createCardFromNotesSelection(markdown) {
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
    addCardFromNotes(question, answer);
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

document.addEventListener("selectionchange", () => {
  if (state.viewMode !== "notes") return;
  scheduleNotesSelectionCheck();
});

// <textarea> selections don't fire the document "selectionchange" event
// reliably across browsers, so raw/edit mode is covered separately via
// direct mouse/keyboard selection events on the editor itself.
el.notesEdit?.addEventListener("mouseup", scheduleNotesSelectionCheck);
el.notesEdit?.addEventListener("keyup", scheduleNotesSelectionCheck);
el.notesEdit?.addEventListener("select", scheduleNotesSelectionCheck);
el.notesEdit?.addEventListener("scroll", hideNotesSelectionButton, { passive: true });

el.makeCardFromSelectionBtn?.addEventListener("pointerdown", (event) => {
  // preventDefault keeps the selection from dissolving mid-tap.
  event.preventDefault();
  event.stopPropagation();
  const text = el.makeCardFromSelectionBtn.dataset.selectionText || "";
  hideNotesSelectionButton();
  window.getSelection()?.removeAllRanges();
  createCardFromNotesSelection(text);
});

el.notesView?.addEventListener("scroll", hideNotesSelectionButton, { passive: true });

// Persistent alternative to the floating pill (which only appears while a
// selection is live) — sits in the notes header and works from whatever text
// is currently selected, rendered or raw, when tapped.
el.makeCardFromNotesBtn?.addEventListener("click", () => {
  const text = currentNotesSelectionMarkdown();
  if (!text) {
    setStatus("Select some text in your notes first, then tap this to turn it into a card.", "error");
    return;
  }
  hideNotesSelectionButton();
  window.getSelection()?.removeAllRanges();
  createCardFromNotesSelection(text);
});

// ── Editable images in rendered Notes: corner-drag resize ─────────────────
// state.notes is a plain markdown string, so resizing works by tokenizing it
// into top-level blocks with marked.lexer() (each token's `.raw` is the exact
// source slice), rewriting the one image block, and rejoining `.raw` strings
// back into state.notes — safe inside arbitrary surrounding markdown (lists,
// quotes, code fences) because marked already knows the real block boundaries.
//
// A resized image is persisted as a raw <img> HTML block carrying an absolute
// pixel width (marked/DOMPurify pass it through untouched; DOMPurify's ADD_ATTR
// allows style/class). Untouched `![alt](url)` images are left alone. Only an
// image on its own blank-line-separated line is directly resizable; one mixed
// into running text or nested in a list/quote first gets a one-click "move to
// own line" button that promotes it to such a block. Images are always centered.

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
// document order. A standalone image (its own paragraph / raw <img>) is
// directly resizable. An image inside running text (isInline) or nested in a
// list/quote (isDeep) is flagged so it can be promoted to its own line first.
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
    // An image pasted mid-sentence shares its paragraph with other text — it
    // can't be resized in place, so it's flagged for the "move to own line"
    // promote control instead.
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
    // buried in its nested items/sub-tokens. Those get a "move to its own line"
    // control that extracts them to a clean top-level block (promoteDeepImage).
    const deep = [];
    collectImagesDeep(token, deep);
    deep.forEach((found) => {
      results.push({ tokenIndex, isRow: false, isDeep: true, imageRaw: found.raw, images: [{ url: found.url, alt: found.alt, widthPx: null }] });
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

// Extracts an image found via collectImagesDeep out of its enclosing top-level
// token (a list, blockquote, etc.) by removing its exact raw source slice, then
// inserts it as a standalone block immediately after so it becomes resizable.
function promoteDeepImage(tokenIndex, imageRaw, info) {
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token) return;
  const idx = token.raw.indexOf(imageRaw);
  if (idx === -1) return;
  const newRaw = token.raw.slice(0, idx) + token.raw.slice(idx + imageRaw.length);
  const imgHtml = imgTagHtml(info) + "\n\n";
  const replacement = [
    { ...token, raw: newRaw },
    { type: "html", raw: imgHtml, text: imgHtml, pre: false, block: true }
  ];
  tokens.splice(tokenIndex, 1, ...replacement);
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
  renderMarkdown(el.notesView, state.notes, true);
  scheduleDeckAutosave();
}

// Freestyle sizing — an absolute pixel width with only a sanity floor/ceiling,
// so an image can be shrunk to a small accent or blown up past its container
// (the shell scrolls). rowPos targets one image of a side-by-side row. Resizing
// an image in a `|`-separated row rewrites that line into the explicit
// `<div class="notes-img-row">` form (the only representation that can carry a
// per-image width); it renders identically.
function commitImageWidth(tokenIndex, rowPos, px) {
  const widthPx = Math.min(2000, Math.max(20, Math.round(px)));
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token) return;

  if (rowPos !== null) {
    const entry = findImageTokens(tokens).find((e) => e.tokenIndex === tokenIndex && e.isRow);
    if (!entry || !entry.images[rowPos]) return;
    const images = entry.images.map((im, i) => (i === rowPos ? { ...im, widthPx } : im));
    const rowHtml = `<div class="notes-img-row">${images.map(imgTagHtml).join("")}</div>\n\n`;
    tokens[tokenIndex] = { type: "html", raw: rowHtml, text: rowHtml, pre: false, block: true };
  } else {
    const entry = findImageTokens(tokens).find((e) => e.tokenIndex === tokenIndex);
    if (!entry) return;
    const html = imgTagHtml({ ...entry.images[0], widthPx }) + "\n\n";
    tokens[tokenIndex] = { type: "html", raw: html, text: html, pre: false, block: true };
  }
  rebuildNotesFromTokens(tokens);
}

// Bottom-right corner-grip resize (the universal affordance): drag out from the
// corner to grow, in to shrink. Width is what's stored; height is auto, so
// aspect ratio is preserved for free. A live badge shows the current px width
// and its share of the notes column so sizing isn't guesswork.
function beginImageResize(event, shell, img, tokenIndex, rowPos) {
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
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    shell.classList.remove("is-resizing");
    badge.remove();
    commitImageWidth(tokenIndex, rowPos, widthPx);
  };
  paintBadge();
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
}

// Splits a mixed paragraph (image pasted mid-sentence, alongside other text)
// into up to three blocks — text-before, the image as its own standalone block,
// text-after — using the paragraph's own inline tokens' raw slices so
// formatting either side survives. The image then qualifies as a standalone
// block on the next render and gets the resize grip.
function promoteInlineImage(tokenIndex, inlinePos) {
  const tokens = notesLexTokens();
  const token = tokens[tokenIndex];
  if (!token || token.type !== "paragraph" || !Array.isArray(token.tokens)) return;
  const inline = token.tokens[inlinePos];
  if (!inline) return;

  const info = inline.type === "image"
    ? { url: inline.href, alt: inline.text || "", widthPx: null }
    : parseImgTagFromHtml(inline.raw || inline.text || "");
  if (!info) return;

  const before = token.tokens.slice(0, inlinePos).map((t) => t.raw).join("").trim();
  const after = token.tokens.slice(inlinePos + 1).map((t) => t.raw).join("").trim();

  const replacement = [];
  if (before) replacement.push({ type: "paragraph", raw: before + "\n\n", text: before, tokens: [] });
  const imgHtml = imgTagHtml(info) + "\n\n";
  replacement.push({ type: "html", raw: imgHtml, text: imgHtml, pre: false, block: true });
  if (after) replacement.push({ type: "paragraph", raw: after + "\n\n", text: after, tokens: [] });

  tokens.splice(tokenIndex, 1, ...replacement);
  rebuildNotesFromTokens(tokens);
}

// Minimal overlay for an image that isn't (yet) its own clean top-level block —
// still embedded in running text, or buried inside a list/quote. Clicking the
// button promotes it via the callback; the resize grip then appears once
// findImageTokens sees it as a standalone block on the next render.
function attachImagePromoteControl(shell, onPromote) {
  shell.querySelector(".notes-img-controls")?.remove();
  shell.querySelector(".notes-img-resize-handle")?.remove();
  const controls = document.createElement("div");
  controls.className = "notes-img-controls";
  const promoteBtn = document.createElement("button");
  promoteBtn.type = "button";
  promoteBtn.className = "notes-img-promote-btn";
  promoteBtn.title = "Move to its own line to resize it";
  promoteBtn.textContent = "⤢ Move to own line";
  promoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onPromote();
  });
  controls.appendChild(promoteBtn);
  shell.appendChild(controls);
}

// Attaches the blue corner-drag resize grip to a standalone (or legacy-row)
// image. This is the only image control.
function attachNotesImageResizeHandle(shell, img, tokenIndex, rowPos) {
  shell.querySelector(".notes-img-controls")?.remove();
  shell.querySelector(".notes-img-resize-handle")?.remove();
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "notes-img-resize-handle";
  resizeHandle.title = "Drag to resize";
  resizeHandle.setAttribute("aria-hidden", "true");
  resizeHandle.addEventListener("pointerdown", (e) => beginImageResize(e, shell, img, tokenIndex, rowPos));
  shell.appendChild(resizeHandle);
}

// Re-attaches the resize grip after every notes render. Cross-references
// rendered .diagram-shell elements (DOM order) against findImageTokens (source
// order) — both orders match since none of preprocessSpecialBlocks's transforms
// reorder or remove image blocks.
function enhanceNotesImageControls() {
  if (!el.notesView) return;
  const tokens = notesLexTokens();
  const imageTokens = findImageTokens(tokens);
  const shells = Array.from(el.notesView.querySelectorAll(".diagram-shell")).filter((s) => s.querySelector("img"));

  let cursor = 0;
  imageTokens.forEach((entry) => {
    const count = entry.images.length;
    const entryShells = shells.slice(cursor, cursor + count);
    cursor += count;
    entryShells.forEach((shell, i) => {
      const img = shell.querySelector("img");
      if (!img) return;
      img.draggable = false;
      shell.dataset.tokenIndex = String(entry.tokenIndex);
      const widthPx = entry.images[i]?.widthPx;
      if (widthPx) {
        img.style.setProperty("--notes-img-w", `${widthPx}px`);
        img.classList.add("has-custom-size");
      } else {
        img.classList.remove("has-custom-size");
      }
      if (entry.isInline) {
        attachImagePromoteControl(shell, () => promoteInlineImage(entry.tokenIndex, entry.inlinePos));
      } else if (entry.isDeep) {
        attachImagePromoteControl(shell, () => promoteDeepImage(entry.tokenIndex, entry.imageRaw, entry.images[0]));
      } else {
        attachNotesImageResizeHandle(shell, img, entry.tokenIndex, entry.isRow ? i : null);
      }
    });
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
  await renderMarkdown(el.questionView, card.question, true);
  await renderMarkdown(el.answerView, card.answer, true);
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

  const cards = combinedCards.map((card, index) => ({
    id: `${index}-${card.question.slice(0, 32)}`,
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
  setViewMode("cards");

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

function formatCardList(title, cards) {
  const body = cards.length
    ? cards.map((card) => `::\n${card.question.trim()}\n\n---\n\n${card.answer.trim()}\n::`).join("\n\n")
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
    cards: state.masterCards.map((card, index) => ({
      id: card.id || `${index}-${card.question.slice(0, 32)}`,
      question: card.question,
      answer: card.answer,
      status: normalizeCardStatus(state.statusById[card.id])
    }))
  };
}

function clearBrowserPersistence() {
  try {
    localStorage.removeItem(themeStorageKey);
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
  const cards = payload.cards
    .map((rawCard, index) => {
      const question = String(rawCard?.question || "").trim();
      const answer = String(rawCard?.answer || "").trim();
      if (!question || !answer) return null;

      let id = String(rawCard.id || `${index}-${question.slice(0, 32)}`);
      while (usedIds.has(id)) id = `${index}-${Math.random().toString(36).slice(2, 6)}-${id}`;
      usedIds.add(id);

      const status = normalizeCardStatus(rawCard?.status || payload.statusById?.[id]);
      if (status) statusById[id] = status;

      return { id, question, answer };
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
  } else {
    state.masterCards = cards.slice();
    resetStudyDeck(state.masterCards);
    state.statusById = statusById;
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
    setViewMode("cards");
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
let deckAutosaveStorageFailed = false;
function scheduleDeckAutosave() {
  // After a storage-quota failure, stop scheduling further writes — the
  // toast already told the user, and hammering a full localStorage just
  // wastes CPU and fires more confusing errors.
  if (deckAutosaveStorageFailed) return;
  if (deckAutosaveTimer) clearTimeout(deckAutosaveTimer);
  deckAutosaveTimer = setTimeout(() => {
    deckAutosaveTimer = null;
    persistWorkingDeck();
    const savedMeta = saveDeckToLibrary({ silent: true });
    if (!savedMeta) {
      deckAutosaveStorageFailed = true;
      setSyncIndicator("error");
      showToast("Device storage full — clear old decks to keep saving", "error");
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

// A pull/push whose diff stats are all-zero is just a timestamp-alignment
// artifact (e.g. clock granularity between an edit-time stamp and a push-time
// stamp) — nothing actually moved, so it shouldn't be counted or reported as
// user-visible sync activity.
function isNoOpStats(stats) {
  return !stats.cardsAdded && !stats.cardsUpdated && !stats.cardsDeleted && !stats.notesChanged;
}

// Pulls one cloud deck (metadata already in hand) plus its cards into the local
// library, WITHOUT disturbing the active in-memory deck. Stamps the local copy
// with the cloud's `updated_at` so they read as in sync afterwards.
async function pullCloudDeckToLibrary(cloud) {
  const { data: cards, error } = await supabaseClient
    .from("cards")
    .select("*")
    .eq("deck_id", cloud.id)
    .order("position", { ascending: true });
  if (error) throw error;

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
    cards: (cards || []).map((c, i) => ({
      id: String(c.id || `${i}-${String(c.question || "").slice(0, 32)}`),
      question: c.question,
      answer: c.answer,
      status: normalizeCardStatus(c.status)
    }))
  };

  const existing = readLocalDeckIndex().find((m) => String(m.deckId) === String(cloud.id));
  const localId = existing?.id || generateLocalDeckId();
  snapshot.localDeckId = localId;

  // Diff against whatever was on this device before we overwrite it below,
  // for the detailed sync report — a brand-new-to-this-device deck just
  // reports its total card count instead of an add/edit/delete breakdown.
  let stats;
  const oldRaw = existing ? localStorage.getItem(LOCAL_DECK_PREFIX + localId) : null;
  const oldSnapshot = oldRaw ? JSON.parse(oldRaw) : null;
  if (oldSnapshot) {
    const oldStatusById = Object.fromEntries((oldSnapshot.cards || []).map((c) => [String(c.id), c.status]));
    // calculateSyncDiff(local, web) reports "added" as local-only and
    // "deleted" as web-only. Here "local"=old snapshot (the stale/outgoing
    // side) and "web"=new cloud data (the incoming side), so from the
    // pull's point of view those two are swapped: web-only cards are what
    // just arrived (added), and local-only cards are what's now gone
    // (deleted from this device's copy).
    const diff = calculateSyncDiff(oldSnapshot.cards || [], cards || [], oldStatusById, { fuzzy: false });
    stats = {
      cardsAdded: diff.deleted,
      cardsUpdated: diff.edited + diff.statusChanges + diff.moved,
      cardsDeleted: diff.added,
      notesChanged: syncTextChanged(oldSnapshot.notes || "", snapshot.notes)
    };
  } else {
    stats = { cardsAdded: snapshot.cards.length, cardsUpdated: 0, cardsDeleted: 0, notesChanged: Boolean(snapshot.notes.trim()) };
  }

  localStorage.setItem(LOCAL_DECK_PREFIX + localId, JSON.stringify(snapshot));

  const meta = {
    id: localId,
    title: snapshot.deckTitle || "Untitled deck",
    category: snapshot.deckCategory,
    cardCount: snapshot.cards.length,
    hasNotes: Boolean(snapshot.notes.trim()),
    updatedAt: cloud.updated_at || new Date().toISOString(),
    // Distinct from updatedAt (which also bumps on plain local edits) — this
    // specifically means "last confirmed match with the cloud", surfaced in
    // the sync indicator pill.
    lastSyncedAt: cloud.updated_at || new Date().toISOString(),
    deckId: String(cloud.id),
  };
  writeLocalDeckIndex([meta, ...readLocalDeckIndex().filter((m) => m.id !== localId)]);
  return { localId, meta, stats };
}

// Pushes one library deck (by its local metadata) to the cloud, WITHOUT
// disturbing the active in-memory deck. Mints a stable cloud id if the deck has
// never been synced, then records it locally and aligns the timestamp.
async function pushLibraryDeckToCloud(localMeta, { cloudExists = false, cloudNotes = "" } = {}) {
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
  const pushStats = await pushDeckRowsToCloud({
    deckId,
    title: snapshot.deckTitle || "Untitled Deck",
    category: normalizeDeckCategory(snapshot.deckCategory),
    notes: snapshot.notes || "",
    currentIndex: snapshot.current,
    cards: (snapshot.cards || []).map((c) => ({
      id: c.id, question: c.question, answer: c.answer, status: normalizeCardStatus(c.status)
    })),
    isNewDeck,
    overwrite: false,
    now,
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
  return {
    now,
    stats: {
      ...pushStats,
      notesChanged: isNewDeck ? Boolean(String(snapshot.notes || "").trim()) : syncTextChanged(snapshot.notes, cloudNotes)
    }
  };
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
  if (explicit) setStatus("Syncing all decks…");

  // Flush any pending debounced autosave first. Without this, an edit made in
  // the last ~400ms lives only in memory (deckAutosaveTimer hasn't fired), so
  // the library copy's `updatedAt` is stale — a cloud copy could then read as
  // "newer" and the pull below would overwrite and reload the deck, silently
  // discarding that in-flight edit. Flushing writes it out and bumps the
  // timestamp so local edits correctly win the last-write-wins comparison.
  if (deckAutosaveTimer) {
    clearTimeout(deckAutosaveTimer);
    deckAutosaveTimer = null;
    persistWorkingDeck();
    saveDeckToLibrary({ silent: true });
  }

  // A brand-new deck that's only in memory (never auto-saved) still belongs in
  // the mirror — add it so it gets pushed. Decks already in the library keep
  // their accurate timestamps and are left untouched here.
  if ((state.masterCards.length || state.notes.trim()) && !state.localDeckId) {
    saveDeckToLibrary({ silent: true });
  }

  const activeDeckId = state.deckId;
  let activePulledLocalId = null;
  let pulled = 0, pushed = 0, failed = 0;
  // Per-deck breakdown for the detailed sync report — every deck actually
  // touched (or that failed) gets an entry naming it, its direction, and
  // exactly what changed (cards added/updated/deleted, notes).
  const deckLog = [];

  try {
    const cloudDecks = await fetchCloudDeckList();
    const cloudById = new Map(cloudDecks.map((d) => [String(d.id), d]));
    const cloudIdSet = new Set(cloudDecks.map((d) => String(d.id)));

    // Prune tombstones whose cloud row is already gone — the deletion has fully
    // propagated, so there's nothing left to re-assert and no reason to keep
    // blocking that id forever.
    for (const tid of Object.keys(readDeckTombstones())) {
      if (!cloudIdSet.has(String(tid))) clearDeckTombstone(tid);
    }

    // 1) Cloud → local: pull anything missing locally or newer in the cloud.
    for (const cloud of cloudDecks) {
      // A deck deleted here but still (or again) present in the cloud — e.g. a
      // race with an in-flight sync, or another device that re-pushed it. Don't
      // pull it back; re-assert the deletion in the cloud instead.
      if (isDeckTombstoned(cloud.id)) {
        try {
          await supabaseClient.from("decks").delete().eq("id", cloud.id);
        } catch (e) {
          console.warn("Tombstone re-delete failed", cloud.id, e);
        }
        continue;
      }
      const localMeta = readLocalDeckIndex().find((m) => String(m.deckId) === String(cloud.id));
      const cloudNewer = !localMeta || tsMs(cloud.updated_at) > tsMs(localMeta.updatedAt);
      if (!cloudNewer) continue;
      try {
        const res = await pullCloudDeckToLibrary(cloud);
        if (!isNoOpStats(res.stats)) {
          pulled++;
          deckLog.push({ title: cloud.title || "Untitled deck", direction: "pulled", ...res.stats });
          // Only reload the on-screen deck when the pull actually changed its
          // content. A no-op pull (cloud read "newer" purely from a timestamp
          // artifact, with identical cards/notes) must NOT reload — doing so
          // would reset the user's live study position to the cloud's index
          // for no real reason.
          if (activeDeckId && String(cloud.id) === String(activeDeckId)) activePulledLocalId = res.localId;
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: cloud.title || "Untitled deck", direction: "failed", error: e?.message || String(e) });
        console.warn("Reconcile pull failed", cloud.id, e);
      }
    }

    // 2) Local → cloud: push anything not in the cloud or newer locally.
    //    Re-read the index because the pull pass may have rewritten it.
    for (const localMeta of readLocalDeckIndex()) {
      // Never re-upload a deck that was deleted here (a stray local copy that
      // outlived the delete) — that's exactly how a deleted deck comes back.
      if (isDeckTombstoned(localMeta.deckId)) continue;
      const cloud = localMeta.deckId ? cloudById.get(String(localMeta.deckId)) : null;
      const localNewer = !cloud || tsMs(localMeta.updatedAt) > tsMs(cloud.updated_at);
      if (!localNewer) continue;
      try {
        const res = await pushLibraryDeckToCloud(localMeta, { cloudExists: Boolean(cloud), cloudNotes: cloud?.notes || "" });
        if (!isNoOpStats(res.stats)) {
          pushed++;
          deckLog.push({ title: localMeta.title || "Untitled deck", direction: "pushed", ...res.stats });
        }
      } catch (e) {
        failed++;
        deckLog.push({ title: localMeta.title || "Untitled deck", direction: "failed", error: e?.message || String(e) });
        console.warn("Reconcile push failed", localMeta.id, e);
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

    const parts = [];
    if (pulled) parts.push(`${pulled} deck${pulled === 1 ? "" : "s"} downloaded from the cloud`);
    if (pushed) parts.push(`${pushed} deck${pushed === 1 ? "" : "s"} uploaded to the cloud`);
    const summary = parts.length
      ? `Synced — ${parts.join(", ")}${failed ? ` (${failed} failed — see console)` : ""}`
      : failed
        ? `Sync finished, but ${failed} deck${failed === 1 ? "" : "s"} failed — see console`
        : "Already up to date — nothing to sync";
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
      const reason = error?.message ? `: ${error.message}` : "";
      setStatus(`Sync failed${reason}. Your decks are safe on this device.`, "error");
      showToast(`Sync failed${reason}`, "error");
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

// Newest first.
function listLocalDecks() {
  return readLocalDeckIndex()
    .slice()
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
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
  } catch (error) {
    console.warn("Could not save deck to library", error);
    if (!silent) setStatus("Could not save deck — device storage may be full.", "error");
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
    lastSyncedAt: lastSyncedAt !== undefined ? lastSyncedAt : (previousEntry?.lastSyncedAt || null),
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
    const payload = JSON.parse(raw);
    loadDeckSnapshot(payload, payload.sourceTitle || payload.deckTitle || "");
    state.localDeckId = id;
    persistWorkingDeck();
    refreshSyncIndicatorBaseline();
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

function contentFits(node) {
  return node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1;
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

function fitPrintNode(node) {
  node.style.transform = "";
  node.style.width = "";

  const shouldGrow = node.classList.contains("fit-question");
  const settings = normalizeStyleSettings(state.styleSettings);
  const answerFontSize = parseFloat(settings.answerFontSize) || parseFloat(styleDefaults.answerFontSize);
  const fillRatio = Math.min(Math.max((parseFloat(settings.questionFillPercent) || parseFloat(styleDefaults.questionFillPercent)) / 100, 0.1), 0.95);
  const lineHeight = parseFloat(settings.questionLineHeight) || parseFloat(styleDefaults.questionLineHeight) || 1.18;
  const maxQuestionFontSize = numericStyleValue(settings.questionMaxFontSize) ?? numericStyleValue(styleDefaults.questionMaxFontSize) ?? 64;
  const questionUpper = Math.max(1, Math.min(maxQuestionFontSize, 220, node.clientHeight * fillRatio / Math.max(lineHeight, 0.1), Math.max(node.clientWidth, 1)));

  if (!shouldGrow && contentFits(node)) return;

  let low = shouldGrow ? 1 : 4;
  let high = shouldGrow ? questionUpper : Math.max(4, answerFontSize);
  let best = low;

  for (let index = 0; index < 10; index += 1) {
    const mid = (low + high) / 2;
    node.style.fontSize = `${mid}px`;
    if (contentFits(node)) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  node.style.fontSize = `${Math.max(low, best - 0.5)}px`;

  if (!contentFits(node)) {
    const xScale = node.clientWidth / Math.max(node.scrollWidth, 1);
    const yScale = node.clientHeight / Math.max(node.scrollHeight, 1);
    const scale = Math.max(0.35, Math.min(xScale, yScale, 1) - 0.02);
    node.style.width = `${100 / scale}%`;
    node.style.transform = `scale(${scale})`;
  }
}

function fitPrintPages() {
  el.printRoot.querySelectorAll(".fit-content").forEach(fitPrintNode);
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
      @page { size: A4 portrait; margin: 12mm; }

      /* Card layout */
      .cornell-print-document { width: auto !important; border: none !important; box-shadow: none !important; }
      .cornell-print-table { padding: 6mm 0 0 !important; }
      .cornell-print-row {
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        border: 2px solid #bbb !important;
        border-radius: 0 !important;
        margin-bottom: 6mm !important;
        overflow: hidden !important;
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .cornell-print-row .cornell-question-rail {
        flex: 0 0 45mm !important;
        width: 45mm !important;
        min-width: 45mm !important;
        border-right: 2px solid #bbb !important;
      }
      .cornell-print-row .cornell-answer-cell {
        flex: 1 1 0 !important;
        min-width: 0 !important;
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
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    el.printRoot.classList.remove("is-preparing");
    el.printRoot.classList.add("is-preview");
    el.printRoot.setAttribute("aria-hidden", "false");
    printPreviewOpen = true;
    lockPageScroll();
    markOversizePrintRows();
    setStatus(`${sourceTitle} Cornell PDF preview is ready. Use Download PDF.`);
  } catch (error) {
    console.error("PDF export failed", error);
    closePrintPreview();
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
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
    await (document.fonts?.ready || Promise.resolve());
    await afterPaint();

    adjustCornellRows(el.printRoot);
    await afterPaint();
    installPdfPrintStyle();
    el.printRoot.classList.remove("is-preparing");
    el.printRoot.classList.add("is-preview");
    el.printRoot.setAttribute("aria-hidden", "false");
    printPreviewOpen = true;
    lockPageScroll();
    markOversizePrintRows();
    setStatus(`${title} Cornell PDF preview is ready. Use Download PDF.`);
  } catch (error) {
    console.error("PDF export failed", error);
    closePrintPreview();
    setStatus("Could not prepare the PDF export.", "error");
  } finally {
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
  exportMarkdown(scope);
}

function exportResults() {
  exportMarkdown("all");
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
  return Boolean(closestElement(target, "a, button, input, textarea, .cloze"));
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
  return closestElement(target, ".style-grid, .all-cards-list, .paste-preview-list, textarea, .import-card, .web-decks-table-wrap, .diagram-modal-body");
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

function registerServiceWorker() {
  if (!pwaAssetsSupported()) return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
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

function setDeckMenuOpen(open) {
  if (!el.deckMenu || !el.deckMenuBtn) return;
  el.deckMenu.hidden = !open;
  el.deckMenuBtn.setAttribute("aria-expanded", String(open));
}

function closeDeckMenu() {
  setDeckMenuOpen(false);
}

function createNewDeck() {
  closeDeckMenu();
  const doCreate = () => {
    deckAutosaveStorageFailed = false;
    state.deckId = null;
    // Detach from any previously-loaded library entry so this new deck saves as
    // its own entry rather than overwriting the deck that was just open.
    state.localDeckId = null;
    state.deckTitle = "New Deck";
    state.deckCategory = defaultDeckCategory;
    state.notes = "";
    state.sourceTitle = "New Deck";
    state.importTitleHint = "New Deck";
    state.masterCards = [];
    resetStudyDeck(state.masterCards);
    setViewMode("cards");
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
  const imgbbKey = document.getElementById("setupImgbbKey")?.value || "";
  saveImgbbKey(imgbbKey);
  initSupabaseClient();
  setupAuthListener();
  showLoginScreen();
});

document.getElementById("setupResetBtn")?.addEventListener("click", () => {
  clearSupabaseConfig();
  supabaseClient = null;
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

document.getElementById("closeWebDecksBtn")?.addEventListener("click", () => {
  el.webDecksPanel.hidden = true;
  unlockPageScroll();
});
document.getElementById("syncBtn")?.addEventListener("click", showSyncModal);
document.getElementById("cancelSyncBtn")?.addEventListener("click", () => {
  el.syncModal.hidden = true;
});
document.getElementById("confirmSyncBtn")?.addEventListener("click", syncDeckToWeb);
document.getElementById("refreshWebDecksBtn")?.addEventListener("click", () => fetchWebDecks({ toast: true }));

el.parseBtn.addEventListener("click", () => buildCards());
el.sampleBtn.addEventListener("click", loadSample);
el.fetchBtn.addEventListener("click", fetchUrl);
el.urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") fetchUrl();
});
if (el.deckMenuBtn) {
  el.deckMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    el.exportMenu.hidden = true;
    setDeckMenuOpen(el.deckMenu.hidden);
  });
}
el.importBtn.addEventListener("click", () => {
  closeDeckMenu();
  openImportPanel();
});
el.myDecksBtn?.addEventListener("click", () => {
  closeDeckMenu();
  openMyDecksPanel();
});
el.syncNowBtn?.addEventListener("click", () => {
  closeDeckMenu();
  reconcileAllDecks({ explicit: true });
});
el.closeMyDecksBtn?.addEventListener("click", closeMyDecksPanel);
el.myDecksRefreshBtn?.addEventListener("click", () => renderMyDecksList());
el.closeImportBtn.addEventListener("click", closeImportPanel);
el.closeImportSelectorBtn.addEventListener("click", closeImportSelectorPanel);
el.importSelectorCancelBtn.addEventListener("click", closeImportSelectorPanel);
el.selectAllImportSelectorCheckbox.addEventListener("change", toggleAllImportSelector);
el.importSelectorLoadBtn.addEventListener("click", loadSelectedImportDecks);
el.editDeckTitleBtn.addEventListener("click", editCurrentDeckTitle);
el.editDeckCategoryBtn?.addEventListener("click", editCurrentDeckCategory);
el.webDeckCategoryFilter?.addEventListener("change", fetchWebDecks);

// Web Decks selection & bulk actions event listener initialization
el.selectAllWebDecksCheckbox?.addEventListener("change", (e) => {
  const checked = e.target.checked;
  document.querySelectorAll(".web-deck-row-checkbox").forEach((cb) => {
    cb.checked = checked;
  });
  updateBulkActionVisibility();
});

const bulkLoadBtn = document.getElementById("bulkLoadBtn");
if (bulkLoadBtn) {
  bulkLoadBtn.addEventListener("click", () => {
    const selectedIds = Array.from(document.querySelectorAll(".web-deck-row-checkbox:checked")).map(cb => cb.dataset.deckId);
    if (selectedIds.length > 0) {
      loadSelectedWebDecks(selectedIds);
    }
  });
}

const bulkCategoryBtn = document.getElementById("bulkCategoryBtn");
if (bulkCategoryBtn) {
  bulkCategoryBtn.addEventListener("click", () => {
    const selectedIds = Array.from(document.querySelectorAll(".web-deck-row-checkbox:checked")).map(cb => cb.dataset.deckId);
    if (selectedIds.length > 0) {
      changeSelectedWebDecksCategory(selectedIds);
    }
  });
}

const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
if (bulkDeleteBtn) {
  bulkDeleteBtn.addEventListener("click", () => {
    const selectedIds = Array.from(document.querySelectorAll(".web-deck-row-checkbox:checked")).map(cb => cb.dataset.deckId);
    if (selectedIds.length > 0) {
      deleteSelectedWebDecks(selectedIds);
    }
  });
}

const bulkExportBtn = document.getElementById("bulkExportBtn");
const bulkExportMenu = document.getElementById("bulkExportMenu");
if (bulkExportBtn && bulkExportMenu) {
  bulkExportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const shouldOpen = bulkExportMenu.hidden;
    closeWebDeckExportMenus(bulkExportMenu);
    bulkExportMenu.hidden = !shouldOpen;
    bulkExportBtn.setAttribute("aria-expanded", String(shouldOpen));
  });

  bulkExportMenu.querySelectorAll("[data-bulk-export]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      bulkExportMenu.hidden = true;
      bulkExportBtn.setAttribute("aria-expanded", "false");
      const format = btn.dataset.bulkExport;
      const selectedIds = Array.from(document.querySelectorAll(".web-deck-row-checkbox:checked")).map(cb => cb.dataset.deckId);
      if (selectedIds.length > 0) {
        exportSelectedWebDecks(selectedIds, format);
      }
    });
  });
}
el.globalWebExportBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  const shouldOpen = el.globalWebExportMenu?.hidden;
  closeWebDeckExportMenus(el.globalWebExportMenu);
  if (el.globalWebExportMenu) el.globalWebExportMenu.hidden = !shouldOpen;
  el.globalWebExportBtn.setAttribute("aria-expanded", String(Boolean(shouldOpen)));
});
el.globalWebExportMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-global-web-export]");
  if (!button) return;
  event.stopPropagation();
  el.globalWebExportMenu.hidden = true;
  el.globalWebExportBtn?.setAttribute("aria-expanded", "false");
  exportAllWebDecks(button.dataset.globalWebExport);
});
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

el.webDecksPanel.addEventListener("touchstart", handleStylePanelTouchStart, { passive: true });
el.webDecksPanel.addEventListener("touchmove", handleStylePanelTouchMove, { passive: false });
el.webDecksPanel.addEventListener("wheel", handleStylePanelWheel, { passive: false });

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
el.toggleAllAnswersBtn?.addEventListener("click", () => {
  setAllCardsAnswersVisible(!allCardsAnswersVisible);
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
  closeDeckMenu();
  el.exportMenu.hidden = !el.exportMenu.hidden;
});
el.exportMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-export]");
  if (!button) return;
  handleExportAction(button.dataset.export, button.dataset.scope);
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
  if (event.target.matches("input, textarea")) return;
  if (event.key === "Escape") {
    el.exportMenu.hidden = true;
    closeDeckMenu();
    closeDiagramModal();
    closeAllCardsPanel();
    closeStylePanel();
    closeImportPanel();
    el.webDecksPanel.hidden = true;
    unlockPageScroll();
  }
  if (!el.allCardsPanel.hidden) return;
  // Card shortcuts are meaningless while the Notes view covers the card stage.
  if (state.viewMode === "notes") return;
  // A focused cloze handles its own Space/Enter (reveal) — don't also flip.
  if (event.target.closest?.(".cloze")) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    flipCard();
  }
  if (event.key === "ArrowRight") navigateCard(1, "next");
  if (event.key === "ArrowLeft") navigateCard(-1, "prev");
  if (event.key === "k" || event.key === "K") moveCard("known");
  if (event.key === "r" || event.key === "R") moveCard("review");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".theme-select")) {
    setThemeMenuOpen(false);
  }
  if (!event.target.closest(".web-deck-export-wrap, .web-decks-global-export, .bulk-export-dropdown")) {
    closeWebDeckExportMenus();
    el.globalWebExportBtn?.setAttribute("aria-expanded", "false");
    const bulkExportBtn = document.getElementById("bulkExportBtn");
    if (bulkExportBtn) bulkExportBtn.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".menu-wrap")) {
    el.exportMenu.hidden = true;
    closeDeckMenu();
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
  setTheme("dark-amoled");
  setStatus("");
  // Start on a clean home screen each load — the last-open deck is no longer
  // auto-restored (only credentials, the saved "My Decks" library, and styles persist).
  showCard();
  setStyleStatus("Local style");
  installManifestLink();
  registerServiceWorker();
  // Mirror every cloud deck onto this device (and push anything newer locally)
  // so the PWA has a full, up-to-date offline library. Runs in the background.
  if (navigator.onLine) {
    setTimeout(() => reconcileAllDecks({ explicit: false }), 1200);
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
    showAuthenticatedUI();
    if (!appInitialized) {
      appInitialized = true;
      initAppForUser();
    }
  } else {
    showLoginScreen();
  }
}

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
    { side: "question", view: el.questionView, edit: el.questionEdit, toolbar: el.questionEditToolbar, btn: el.editQuestionBtn },
    { side: "answer",   view: el.answerView,   edit: el.answerEdit,   toolbar: el.answerEditToolbar,   btn: el.editAnswerBtn },
  ];
  const card = state.cards[state.current];
  for (const { side, view, edit, toolbar, btn } of sides) {
    if (view.hidden === false) continue; // not in edit mode for this side
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
    if (btn) {
      btn.classList.remove('is-editing');
      btn.title = side === "question" ? "Edit question" : "Edit answer";
    }
  }
}

function toggleEditMode(side) {
  const isQuestion = side === 'question';
  const btn = isQuestion ? el.editQuestionBtn : el.editAnswerBtn;
  const view = isQuestion ? el.questionView : el.answerView;
  const edit = isQuestion ? el.questionEdit : el.answerEdit;
  const toolbar = isQuestion ? el.questionEditToolbar : el.answerEditToolbar;
  const currentCard = state.cards[state.current];
  
  if (!currentCard) return;

  const isEditing = view.hidden;
  
  if (!isEditing) {
    view.hidden = true;
    edit.hidden = false;
    if (toolbar) toolbar.hidden = false;
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
  el.newDeckBtn.addEventListener("click", createNewDeck);
}

if (el.newDeckFromImportBtn) {
  el.newDeckFromImportBtn.addEventListener("click", createNewDeck);
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
    showConfirmModal("Delete this card? This cannot be undone.", () => {
      state.masterCards = state.masterCards.filter(c => c.id !== card.id);
      state.cards = state.cards.filter(c => c.id !== card.id);
      delete state.statusById[card.id];
      if (state.current >= state.cards.length) {
        state.current = Math.max(0, state.cards.length - 1);
      }
      showCard();
      setStatus(state.deckId ? "Card deleted locally. Sync to update the web deck." : "Card deleted.");
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

// ----- Image upload (ImgBB) -----------------------------------------------
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
function replaceInTextarea(textarea, find, replace) {
  const idx = textarea.value.indexOf(find);
  if (idx === -1) return;
  textarea.value = textarea.value.slice(0, idx) + replace + textarea.value.slice(idx + find.length);
  const caret = idx + replace.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
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

// Upload an image File/Blob to ImgBB, returning the permanent direct URL (i.ibb.co/…).
async function uploadImageToImgbb(file) {
  const key = loadImgbbKey();
  if (!key) throw new Error("NO_KEY");
  if (!navigator.onLine) throw new Error("OFFLINE");
  const form = new FormData();
  form.append("image", file);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: form
  });
  const json = await res.json().catch(() => null);
  if (!json?.success || !json?.data?.url) {
    throw new Error(json?.error?.message || "Upload failed");
  }
  return json.data.url;
}

// Show the in-app ImgBB key modal (a real overlay — unlike window.prompt it survives
// switching windows to copy the key). On save it stores the key and runs the pending
// callback. Listeners are wired once; the callback is kept in module scope so calling
// this again (e.g. a second image before a key is set) just replaces the callback
// instead of stacking duplicate handlers.
let imgbbModalWired = false;
let imgbbPendingOnSaved = null;

function showImgbbKeyModal(onSaved) {
  const overlay = document.getElementById("imgbbOverlay");
  const form = document.getElementById("imgbbForm");
  const input = document.getElementById("imgbbKeyInput");
  const errEl = document.getElementById("imgbbError");
  const cancelBtn = document.getElementById("imgbbCancelBtn");
  if (!overlay || !form || !input) return;

  imgbbPendingOnSaved = typeof onSaved === "function" ? onSaved : null;
  errEl.textContent = "";
  input.value = loadImgbbKey();
  overlay.hidden = false;
  input.focus();

  if (imgbbModalWired) return;
  imgbbModalWired = true;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (key.length < 20) {
      errEl.textContent = "That key looks too short — paste the full ImgBB API key.";
      return;
    }
    saveImgbbKey(key);
    overlay.hidden = true;
    const cb = imgbbPendingOnSaved;
    imgbbPendingOnSaved = null;
    if (cb) cb();
  });

  cancelBtn.addEventListener("click", () => {
    overlay.hidden = true;
    imgbbPendingOnSaved = null;
    showToast("Image upload cancelled — no ImgBB key", "info");
  });
}

// Prompt the user for an ImgBB key, save it, then retry the upload for `file`.
// `atPos` is threaded through so the retry still lands at the original caret.
function promptForImgbbKeyThenRetry(textarea, file, atPos) {
  showImgbbKeyModal(() => insertImageUpload(textarea, file, atPos));
}

// Insert an "uploading…" placeholder, upload the image, then swap in `![](url)`.
// `atPos` (optional) forces the placeholder to the caret captured before the file
// picker opened; without it the current caret is used (paste/drop already have focus).
async function insertImageUpload(textarea, file, atPos) {
  if (!textarea || !file || !file.type || !file.type.startsWith("image/")) return;
  const token = `![uploading…](#upl-${Date.now()}-${Math.random().toString(36).slice(2, 7)})`;
  insertAtCursor(textarea, token, atPos);
  showToast("Optimizing image…", "info");
  try {
    const optimized = await optimizeImage(file);
    const url = await uploadImageToImgbb(optimized);
    replaceInTextarea(textarea, token, `![](${url})`);
    showToast("Image uploaded", "success");
  } catch (err) {
    replaceInTextarea(textarea, token, "");
    if (err.message === "NO_KEY") {
      promptForImgbbKeyThenRetry(textarea, file, atPos);
    } else if (err.message === "OFFLINE") {
      showToast("Can't upload image while offline", "error");
    } else {
      console.error("ImgBB upload failed", err);
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
function htmlToMarkdown(html) {
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

  // Image on the clipboard (screenshot, copied image) → upload to ImgBB and insert markdown.
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

// Drag & drop an image file onto a card editor textarea → upload to ImgBB and insert markdown.
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
    <button type="button" data-action="insert-image" title="Insert image (upload to ImgBB)">🖼️</button>
    <button type="button" data-action="clear-all" title="Clear Formatting">Tx</button>${quickNoteBtn}
  `;
}

// Populate toolbars for static question & answer fields on load
function initToolbars() {
  const qToolbar = el.questionEditToolbar;
  if (qToolbar) qToolbar.innerHTML = createToolbarHtml();

  const aToolbar = el.answerEditToolbar;
  if (aToolbar) aToolbar.innerHTML = createToolbarHtml({ quickNote: true });

  const nToolbar = el.notesEditToolbar;
  if (nToolbar) nToolbar.innerHTML = createToolbarHtml();

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

// Toggle a cloze (fill-in-the-blank) between hidden and revealed when tapped.
document.addEventListener("click", (e) => {
  const cloze = e.target.closest(".cloze");
  if (cloze) cloze.classList.toggle("is-revealed");
});

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
  window.addEventListener("resize", syncScroll);
}

// Formatting helpers
function toggleWrap(text, wrapper) {
  if (text.startsWith(wrapper) && text.endsWith(wrapper)) {
    return text.substring(wrapper.length, text.length - wrapper.length);
  }
  return wrapper + text + wrapper;
}

function toggleUnderline(text) {
  if (text.startsWith("<u>") && text.endsWith("</u>")) {
    return text.substring(3, text.length - 4);
  }
  return "<u>" + text + "</u>";
}

function toggleStrikethrough(text) {
  if (text.startsWith("~~") && text.endsWith("~~")) {
    return text.substring(2, text.length - 2);
  }
  return "~~" + text + "~~";
}

function toggleCode(text) {
  if (text.startsWith("`") && text.endsWith("`")) {
    return text.substring(1, text.length - 1);
  }
  return "`" + text + "`";
}

function toggleKbd(text) {
  if (text.startsWith("<kbd>") && text.endsWith("</kbd>")) {
    return text.substring(5, text.length - 6);
  }
  return "<kbd>" + text + "</kbd>";
}

function toggleCloze(text) {
  if (text.startsWith("{{") && text.endsWith("}}")) {
    return text.substring(2, text.length - 2);
  }
  return "{{" + text + "}}";
}

function clearStyling(text) {
  let cleared = text;
  cleared = cleared.replace(/<span style="[^"]*">([\s\S]*?)<\/span>/gi, "$1");
  cleared = cleared.replace(/<font [^>]*>([\s\S]*?)<\/font>/gi, "$1");
  cleared = cleared.replace(/<mark>([\s\S]*?)<\/mark>/gi, "$1");
  cleared = cleared.replace(/<u>([\s\S]*?)<\/u>/gi, "$1");
  cleared = cleared.replace(/<del>([\s\S]*?)<\/del>/gi, "$1");
  cleared = cleared.replace(/<kbd[^>]*>([\s\S]*?)<\/kbd>/gi, "$1");
  return cleared;
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
    document.querySelectorAll(".edit-toolbar .toolbar-dropdown").forEach(d => {
      d.classList.remove("is-open");
    });
    saveQuickNote(selectedText, button);
    return;
  }

  // Insert image: open a file picker, then upload each chosen image to ImgBB and
  // insert markdown at the caret this toolbar's textarea had before the picker opened.
  if (button.dataset.action === "insert-image") {
    openImagePicker(textarea, start);
    return;
  }

  let formatFn = null;

  if (button.dataset.action === "bold") {
    formatFn = text => toggleWrap(text, "**");
  } else if (button.dataset.action === "italic") {
    formatFn = text => toggleWrap(text, "*");
  } else if (button.dataset.action === "underline") {
    formatFn = text => toggleUnderline(text);
  } else if (button.dataset.action === "strikethrough") {
    formatFn = text => toggleStrikethrough(text);
  } else if (button.dataset.action === "code") {
    formatFn = text => toggleCode(text);
  } else if (button.dataset.action === "cloze") {
    formatFn = text => toggleCloze(text);
  } else if (button.dataset.action === "kbd") {
    formatFn = text => toggleKbd(text);
  } else if (button.dataset.action === "bullet") {
    formatFn = text => toggleBulletPoints(text);
  } else if (button.dataset.action === "clear-all") {
    formatFn = text => clearFormatting(text);
  } else if (button.dataset.font) {
    const font = button.dataset.font;
    formatFn = text => `<span style="font-family: ${font};">${clearStyling(text)}</span>`;
  } else if (button.dataset.color) {
    const color = button.dataset.color;
    if (color === "clear") {
      formatFn = text => clearStyling(text);
    } else {
      formatFn = text => `<span style="color: ${color};">${clearStyling(text)}</span>`;
    }
  } else if (button.dataset.highlight) {
    const highlight = button.dataset.highlight;
    if (highlight === "clear") {
      formatFn = text => clearStyling(text);
    } else {
      formatFn = text => `<span style="background-color: ${highlight};">${clearStyling(text)}</span>`;
    }
  }

  if (!formatFn) return;

  const replacement = formatFn(selectedText);

  textarea.focus();
  const val = textarea.value;
  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));

  // Restore selection
  textarea.selectionStart = start;
  textarea.selectionEnd = start + replacement.length;
  
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
async function saveQuickNote(rawText, button) {
  const text = String(rawText || "").trim();
  if (!text) {
    setStatus("Select some text in the answer first to save a quick note.", "error");
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

    // Bump the deck so it surfaces as recently used in the Web Decks panel.
    await supabaseClient
      .from("decks")
      .update({ updated_at: now, last_accessed_at: now })
      .eq("id", deckId);

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
      // Export has inline expansion inside the drawer — don't close for it
      if (btn.id === "exportBtn") return;
      // Close button, section-label clicks, and all other actions close the drawer
      setTimeout(closeMenu, 150);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && toolbar.classList.contains("mobile-open")) closeMenu();
    });
  }
}

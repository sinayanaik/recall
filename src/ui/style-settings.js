// Reading, normalising, applying and editing the per-profile style settings.
//
// Settings are stored per profile (desktop/mobile) and migrated forward from
// the older flat shape on read, so a device that has not synced since still
// loads. Controls that wrote a CSS variable nothing read have been removed;
// normalisation drops them rather than applying garbage.

import { renderAllCards } from "../cards/all-cards.js?v=__BUILD__";
import { showCard } from "../cards/card-view.js?v=__BUILD__";
import { scheduleLiveQuestionFit } from "../cards/question-fit.js?v=__BUILD__";
import { styleStorageKey } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeRegExp } from "../core/text.js?v=__BUILD__";
import { scheduleNotesCaretCheck } from "../notes/caret.js?v=__BUILD__";
import { isNotesEditing } from "../notes/notes-view.js?v=__BUILD__";
import { setNotesReadingMode } from "../notes/paged-view.js?v=__BUILD__";
import { setHeadingNumbersOn } from "../notes/heading-numbers.js?v=__BUILD__";
import { scheduleMarkdownTableFit } from "../render/tables.js?v=__BUILD__";
import { showConfirmModal, showToast } from "./feedback.js?v=__BUILD__";
import { defaultStyleProfiles, legacySpacingDefaults, styleControlGroups, styleCssVariables, styleDefaults, styleDensityPresets, styleFieldByKey, styleScopeById, styleScopeKeys, styleScopes, styleV6Seeds } from "./style-schema.js?v=__BUILD__";
import { prefersMobileStyleProfile, styleProfiles } from "./style-tokens.js?v=__BUILD__";
import { resolveFontFamily } from "./fonts.js?v=__BUILD__";
import { currentThemeId } from "./theme.js?v=__BUILD__";

export function styleValue(source, key, defaults = styleDefaults) {
  return Object.prototype.hasOwnProperty.call(source, key) ? String(source[key]) : defaults[key];
}

export function normalizeStyleValue(key, value, customDefault) {
  const field = styleFieldByKey[key];
  const defaultValue = customDefault ?? styleDefaults[key];
  const raw = String(value ?? defaultValue ?? "").trim();

  if (!field) return raw || defaultValue;

  if (field.type === "select") {
    return field.options.includes(raw) ? raw : defaultValue;
  }

  // Text controls: no clamping, no range checks — whatever was typed wins.
  // The only fix-up is unit completion: a bare number in a px field means px.
  if (!raw) return defaultValue;
  if (!field.unit) return raw;

  const repeatedUnit = new RegExp(`^(-?\\d*\\.?\\d+)(${escapeRegExp(field.unit)})+$`, "i");
  const repeatedUnitMatch = raw.match(repeatedUnit);
  if (repeatedUnitMatch) return `${repeatedUnitMatch[1]}${field.unit}`;

  return /^-?\d*\.?\d+$/.test(raw) ? `${raw}${field.unit}` : raw;
}

// Is `value` something CSS can actually use for this control?
//
// Custom properties accept ANY token — `--content-font-size: 2px4` is a
// perfectly legal declaration — so an invalid value fails silently at the
// consumer instead of here, and the symptom is a whole subsystem quietly
// losing its sizing with nothing to connect it to what you typed. Probing a
// REAL property (the `probe` on each field) is what turns that into an answer.
//
// `probe: "number"` is for the percent controls: they store a bare number that
// applyStyleSettings turns into `${n}%`, and CSS.supports would reject the bare
// number on its own.
// The two kinds of field whose default is an EMPTY box (see style-schema.js):
// `inherits` follows another setting, `auto` keeps the stylesheet's own value.
// In that state the field writes nothing — applyStyleSettings removes its
// variable — and this is the one test of whether a value IS that state.
export function styleFieldFollows(field) {
  return Boolean(field?.inherits || field?.auto);
}

export function isStyleFollowValue(field, value) {
  if (!styleFieldFollows(field)) return false;
  const raw = String(value ?? "").trim();
  return raw === "" || (field.inherits && raw === "inherit") || (field.auto && raw === "auto");
}

export function isStyleValueUsable(field, value) {
  if (!field || field.type === "select") return true;
  const raw = String(value ?? "").trim();
  if (!raw) return styleFieldFollows(field);
  if (isStyleFollowValue(field, raw)) return true;
  if (field.probe === "number") return /^-?\d*\.?\d+%?$/.test(raw) && Number.isFinite(parseFloat(raw));
  // The layout boxes: a bare number is a percent (of whatever unit
  // applyStyleSettings gives that box), anything else must be a CSS length.
  if (field.probe === "length-percentage") {
    if (/^-?\d*\.?\d+$/.test(raw)) return true;
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
    try { return CSS.supports("width", raw); } catch (_) { return false; }
  }
  if (!field.probe || typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  try {
    return CSS.supports(field.probe, raw);
  } catch (_) {
    return false;
  }
}

// What the box shows for a stored value. A follows-another-setting field shows
// nothing at all in that state — its placeholder says what it is following —
// so emptying the box is how you get back there.
export function styleDisplayValue(key, value) {
  const field = styleFieldByKey[key];
  if (isStyleFollowValue(field, value)) return "";
  return value ?? "";
}

// The placeholder: the default for most boxes; for a follows-another-setting
// box, what it follows and that setting's current value; for an `auto` box, the
// value the app uses on its own.
function stylePlaceholder(key, settings, defaults) {
  const field = styleFieldByKey[key];
  if (field?.inherits) return `${field.inherits.label} · ${settings?.[field.inherits.key] ?? defaults[field.inherits.key] ?? ""}`;
  // Just the value: the box is narrow, and a placeholder is already greyed —
  // which is the whole of "this is the app's own, not something you typed".
  if (field?.auto) return field.auto;
  return defaults[key] || "";
}

// ── Where the controls are ──────────────────────────────────────────────────
//
// The Theme & App panel (#styleControls) and, while one is open, a section's
// popover (src/ui/style-popover.js). Every input carries data-style-key, so
// everything below works on whichever of them holds the key — and never assumes
// one host holds every key, which is what the single panel used to let it do.
const extraStyleHosts = new Set();

export function registerStyleHost(root) {
  if (root) extraStyleHosts.add(root);
}

export function unregisterStyleHost(root) {
  extraStyleHosts.delete(root);
}

function isStylePanelOpen() {
  return Boolean(el.stylePanel && !el.stylePanel.hidden);
}

// Is any place that edits style on screen? (The panel, or a section popover.)
export function isStyleEditorOpen() {
  return isStylePanelOpen() || [...extraStyleHosts].some((root) => root.isConnected);
}

// Every rendered host, open or not: painting a hidden one is harmless and keeps
// it right for when it next opens.
function allStyleHosts() {
  return [el.styleControls, ...extraStyleHosts].filter((root) => root && root.isConnected);
}

// Only the hosts on screen — the ones whose values are the reader's, as opposed
// to a hidden panel still holding what it said the last time it was open.
function openStyleHosts() {
  return [isStylePanelOpen() ? el.styleControls : null, ...extraStyleHosts].filter((root) => root && root.isConnected);
}

function styleInputs(hosts = allStyleHosts()) {
  return hosts.flatMap((root) => [...root.querySelectorAll("[data-style-key]")]);
}

function currentEditProfile() {
  return styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
}

// Paints the two per-field affordances: the invalid marker, and the ↺ that only
// appears once a value differs from this profile's default.
export function updateStyleFieldStates() {
  const editProfile = currentEditProfile();
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  styleInputs().forEach((input) => {
    const key = input.dataset.styleKey;
    const field = styleFieldByKey[key];
    const usable = isStyleValueUsable(field, input.value);
    input.setAttribute("aria-invalid", usable ? "false" : "true");
    const label = input.closest(".style-field");
    if (!label) return;
    label.classList.toggle("is-invalid", !usable);
    const reset = label.querySelector(".style-field-reset");
    if (reset) reset.hidden = normalizeStyleValue(key, input.value, defaults[key]) === defaults[key];
  });
}

export function migrateLegacyStyleSettings(raw = {}) {
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
  // The legacy cardPadding was a bare NUMBER; only those get the px appended.
  // Anything already carrying its own unit (or any free-form CSS, now that the
  // controls are textboxes) must pass through untouched — this append used to
  // mangle "calc(20px + 1vw)" into "calc(20px + 1vw)px" on every pass, and the
  // repeated-unit collapse in normalizeStyleValue could only heal the plain
  // "24pxpx" shape.
  if (Object.prototype.hasOwnProperty.call(raw, "cardPadding") && /^-?\d*\.?\d+$/.test(String(raw.cardPadding).trim())) {
    migrated.cardPadding = `${String(raw.cardPadding).trim()}px`;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "bodyFontSize")) migrated.baseFontSize = raw.bodyFontSize;
  if (Object.prototype.hasOwnProperty.call(raw, "bodyLineHeight")) migrated.baseLineHeight = raw.bodyLineHeight;
  if (Object.prototype.hasOwnProperty.call(raw, "cardFacePadding")) migrated.cardPadding = raw.cardFacePadding;
  if (Object.prototype.hasOwnProperty.call(raw, "cardFaceGap")) migrated.cardContentGap = raw.cardFaceGap;
  if (Object.prototype.hasOwnProperty.call(raw, "toolbarGap")) migrated.buttonGap = raw.toolbarGap;
  if (Object.prototype.hasOwnProperty.call(raw, "quizPanelPadding")) migrated.panelPadding = raw.quizPanelPadding;
  if (Object.prototype.hasOwnProperty.call(raw, "quizPanelRadius")) migrated.panelCornerRadius = raw.quizPanelRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "cardRadius")) migrated.cardCornerRadius = raw.cardRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "toolbarButtonRadius")) migrated.buttonCornerRadius = raw.toolbarButtonRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "actionButtonFontSize")) migrated.buttonFontSize = raw.actionButtonFontSize;

  // Merged controls. Each of these used to be its own slider writing its own
  // variable; the survivor takes the old value so nobody's tuned theme resets.
  // inputCornerRadius (and the legacy inputRadius before it) → buttonCornerRadius:
  //   --input-radius is now an alias of --toolbar-button-radius.
  if (Object.prototype.hasOwnProperty.call(raw, "inputRadius")) migrated.buttonCornerRadius = raw.inputRadius;
  if (Object.prototype.hasOwnProperty.call(raw, "inputCornerRadius")) migrated.buttonCornerRadius = raw.inputCornerRadius;
  // questionPadding/answerPadding → cardTextPadding. Question wins: it was the
  // one with a non-zero default, so it's the one people actually moved.
  if (Object.prototype.hasOwnProperty.call(raw, "answerPadding")) migrated.cardTextPadding = raw.answerPadding;
  if (Object.prototype.hasOwnProperty.call(raw, "questionPadding")) migrated.cardTextPadding = raw.questionPadding;
  // actionButtonHeight/replayButtonHeight → toolbarButtonHeight. Those two were
  // dead on the Mobile profile (hardcoded 34px/24px overrides, now removed) and
  // both are derived from the toolbar height in :root, so only take them as a
  // fallback — an explicitly-set toolbar height still wins.
  if (!Object.prototype.hasOwnProperty.call(raw, "toolbarButtonHeight")
      && Object.prototype.hasOwnProperty.call(raw, "actionButtonHeight")) {
    migrated.toolbarButtonHeight = raw.actionButtonHeight;
  }

  return migrated;
}

export function normalizeStyleSettings(raw = {}, profile = "desktop") {
  const source = migrateLegacyStyleSettings(raw || {});
  const defaults = defaultStyleProfiles[profile] || styleDefaults;
  return Object.keys(styleDefaults).reduce((normalized, key) => {
    normalized[key] = normalizeStyleValue(key, styleValue(source, key, defaults), defaults[key]);
    return normalized;
  }, {});
}

export function detectStyleProfile() {
  return prefersMobileStyleProfile() ? "mobile" : "desktop";
}

export function styleProfileLabel(profile) {
  return profile === "mobile" ? "Mobile" : "Desktop";
}

// Bumped to 3 when the panel was trimmed to only controls that do something,
// to 4 when sliders were dropped for plain textboxes and the two dead
// controls (cardTextPadding, markdownBoxHeightPercent) were removed. Carried
// on the stored blob (not just the cloud payload) so one-shot migrations run
// exactly once per device rather than on every load.
// codeHighlightStrength -> the multiplier applyStyleSettings writes as
// --code-mark-scale. Not exported: nothing else reads it.
const CODE_MARK_SCALES = { subtle: "0.7", medium: "1", strong: "1.5" };

// 5: the panel became Global / Text per tab / Spacing & controls. Notes got its
// own raw-editor and code sizes, and the spacing defaults went tight.
// 6: one section per surface, each edited from its own ◐. Settings that several
// surfaces used to share were split, one per section (styleV6Seeds).
export const STYLE_SETTINGS_VERSION = 6;

// The v6 upgrade, applied to a profile stored before it: each split-off key
// starts as a copy of the shared value it came from, so no section changes the
// day it gets its own control. Only where the new key is absent — a v6 value
// somebody chose is never overwritten — and only from a value that was actually
// stored; an absent source leaves the default, which equals the source's.
//
// Also what makes a sync from an older build harmless: its payload says v5 and
// carries none of these keys, so they are re-seeded from the shared values it
// does carry rather than reset.
function upgradeToV6(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const has = (key) => Object.prototype.hasOwnProperty.call(settings, key);
  const next = { ...settings };
  styleV6Seeds.forEach(([key, source]) => {
    if (!has(key) && has(source)) next[key] = settings[source];
  });
  return next;
}

// The v5 upgrade, applied once to a profile stored before it.
//
// Notes' new code and raw-editor sizes start as copies of the shared values they
// split off from, so nobody's notes change size the day they get their own
// control. A spacing value still equal to the old default is moved to the new
// tight one: it was inherited, never chosen. A value somebody typed is kept.
function upgradeToV5(settings, profile) {
  if (!settings || typeof settings !== "object") return settings;
  const has = (key) => Object.prototype.hasOwnProperty.call(settings, key);
  const next = { ...settings };
  if (!has("notesRawFontSize") && has("rawMarkdownFontSize")) next.notesRawFontSize = settings.rawMarkdownFontSize;
  if (!has("notesCodeFontSize") && has("codeFontSize")) next.notesCodeFontSize = settings.codeFontSize;
  if (!has("notesCodeLineHeight") && has("codeLineHeight")) next.notesCodeLineHeight = settings.codeLineHeight;
  const oldDefaults = legacySpacingDefaults[profile] || {};
  const newDefaults = defaultStyleProfiles[profile] || styleDefaults;
  Object.entries(oldDefaults).forEach(([key, oldValue]) => {
    if (has(key) && String(settings[key]).trim() === oldValue) next[key] = newDefaults[key];
  });
  return next;
}

export function normalizeStyleProfiles(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const profileSource = source.profiles && typeof source.profiles === "object" ? source.profiles : source;
  const hasProfiles = Boolean(profileSource.desktop || profileSource.mobile);
  const storedVersion = Number(source.version) || 1;

  // v3 pointed --code-font-size at a real CSS rule for the first time; before
  // it, .rendered pre was font-size:1em and the slider was decoration. Honouring
  // a pre-v3 stored value would shrink every existing user's code blocks to a
  // number they never saw the effect of choosing, so drop it once and let the
  // new default (which equals the base text size, i.e. today's rendering) win.
  const dropPreV3 = (settings) => {
    if (storedVersion >= 3 || !settings || typeof settings !== "object") return settings;
    const { codeFontSize, ...rest } = settings;
    return rest;
  };

  const upgrade = (settings, profile) => {
    let out = settings;
    if (storedVersion < 5) out = upgradeToV5(dropPreV3(out), profile);
    if (storedVersion < 6) out = upgradeToV6(out);
    return out;
  };

  if (!hasProfiles) {
    const legacy = normalizeStyleSettings(upgrade(migrateLegacyStyleSettings(source), "desktop"), "desktop");
    const mobileLegacySource = { ...defaultStyleProfiles.mobile, ...upgrade(migrateLegacyStyleSettings(source), "mobile") };
    return {
      desktop: { ...legacy },
      mobile: normalizeStyleSettings(mobileLegacySource, "mobile"),
      version: STYLE_SETTINGS_VERSION
    };
  }

  const desktopSource = profileSource.desktop || profileSource.mobile || defaultStyleProfiles.desktop;
  const mobileSource = profileSource.mobile || profileSource.desktop || defaultStyleProfiles.mobile;
  return {
    desktop: normalizeStyleSettings(upgrade(migrateLegacyStyleSettings(desktopSource), "desktop"), "desktop"),
    mobile: normalizeStyleSettings(upgrade(migrateLegacyStyleSettings(mobileSource), "mobile"), "mobile"),
    version: STYLE_SETTINGS_VERSION
  };
}

export function setStyleProfiles(raw = {}) {
  state.styleProfiles = normalizeStyleProfiles(raw);
  try {
    localStorage.setItem(styleStorageKey, JSON.stringify(state.styleProfiles));
  } catch (error) {
    console.warn("Could not save style profiles", error);
  }
  return state.styleProfiles;
}

export function getStyleProfileSettings(profile = state.styleEditProfile) {
  const normalizedProfile = styleProfiles.includes(profile) ? profile : detectStyleProfile();
  const settings = state.styleProfiles?.[normalizedProfile] || defaultStyleProfiles[normalizedProfile];
  return normalizeStyleSettings(settings, normalizedProfile);
}

export function setStyleProfileSettings(profile, rawSettings) {
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

export function styleProfilesPayload() {
  return {
    version: STYLE_SETTINGS_VERSION,
    // The theme travels WITH the style. It sits at the top of the style panel,
    // above the very Sync Up / Sync Down buttons that used to skip it — it lived
    // only in its own localStorage key, so syncing your style to a second device
    // brought every font and margin across and left it on whatever theme that
    // device happened to be on. Top level, not inside a profile: one theme for
    // the account, the way it has always behaved locally.
    theme: currentThemeId(),
    desktop: getStyleProfileSettings("desktop"),
    mobile: getStyleProfileSettings("mobile")
  };
}

export function setStyleStatus(message) {
  if (el.styleSyncStatus) el.styleSyncStatus.textContent = message;
}

// ── Building the controls ───────────────────────────────────────────────────

// One row: name (with its ↺), the control, and a one-line hint the stylesheet
// only shows while the row has focus — the hints were half the panel's height.
function buildStyleField(field) {
  const label = document.createElement("label");
  label.className = "style-field";

  // The ↺ is hidden until the value differs from this profile's default
  // (updateStyleFieldStates), so an untouched panel shows no reset at all.
  const name = document.createElement("span");
  name.className = "style-field-name";
  name.textContent = field.label;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "style-field-reset";
  reset.dataset.styleReset = field.key;
  reset.textContent = "↺";
  reset.title = `Reset ${field.label.toLowerCase()} to its default`;
  reset.setAttribute("aria-label", `Reset ${field.label} to its default`);
  reset.hidden = true;
  name.appendChild(reset);
  label.appendChild(name);

  let control;
  if (field.type === "select") {
    control = document.createElement("select");
    const makeOption = (value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = field.optionLabels?.[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
      return option;
    };
    // Only the font pickers set `groups`; every other select is short enough
    // that a flat list is the fastest to scan.
    if (field.groups) {
      field.groups.forEach(({ label: groupLabel, options }) => {
        const optgroup = document.createElement("optgroup");
        optgroup.label = groupLabel;
        options.forEach((value) => optgroup.appendChild(makeOption(value)));
        control.appendChild(optgroup);
      });
    } else {
      field.options.forEach((value) => control.appendChild(makeOption(value)));
    }
  } else {
    // Plain textbox, no slider and no min/max — see styleControlGroups.
    control = document.createElement("input");
    control.type = "text";
    control.spellcheck = false;
    control.placeholder = stylePlaceholder(field.key, null, styleDefaults);
    control.dataset.unit = field.unit || "";
  }
  control.dataset.styleKey = field.key;
  label.appendChild(control);

  const hint = document.createElement("small");
  hint.textContent = field.hint;
  label.appendChild(hint);
  return label;
}

function buildStyleFieldList(fields) {
  const body = document.createElement("div");
  body.className = "style-section-body";
  fields.forEach((field) => body.appendChild(buildStyleField(field)));
  return body;
}

function buildStyleBlock(section, title) {
  const block = document.createElement("section");
  block.className = "style-block";
  block.dataset.styleSection = section;
  block.setAttribute("aria-label", title);
  const head = document.createElement("h2");
  head.className = "style-block-head";
  head.textContent = title;
  block.appendChild(head);
  return block;
}

// One section's controls: a box per group, in schema order. The same builder
// fills the Theme & App panel and every section popover, so a control looks and
// behaves the same wherever it is reached from.
export function buildStyleScope(scope) {
  const fragment = document.createDocumentFragment();
  styleControlGroups.filter((group) => group.scope === scope).forEach((group) => {
    const block = buildStyleBlock(scope, group.title);
    block.dataset.styleGroup = group.title;
    block.appendChild(buildStyleFieldList(group.fields));
    fragment.appendChild(block);
  });
  return fragment;
}

// The Desktop / Mobile switch: which profile these controls edit. Shared by the
// panel and the popovers; the buttons are found by data-style-profile.
export function buildStyleProfileToggle({ compact = false } = {}) {
  const profileField = document.createElement("section");
  profileField.className = compact ? "style-profile-field is-compact" : "style-profile-field";
  profileField.setAttribute("aria-label", "Style profile");

  const profileHeader = document.createElement("div");
  profileHeader.className = "style-profile-head";
  const profileTitle = document.createElement("span");
  profileTitle.textContent = "Editing profile";
  const profileBadge = document.createElement("strong");
  profileBadge.dataset.styleProfileBadge = "";
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
  profileHint.dataset.styleProfileHint = "";
  profileField.appendChild(profileHint);
  return profileField;
}

// The Theme & App panel: the theme picker (static, in index.html), the profile,
// Density, the `app` section, and a list of every other section — each of which
// has its own ◐ where it lives, and can also be opened from here.
export function renderStyleControls() {
  if (!el.styleControls || el.styleControls.dataset.rendered === "true") return;
  const themeField = el.styleControls.querySelector(".style-field");
  el.styleControls.innerHTML = "";
  if (themeField) el.styleControls.appendChild(themeField);

  el.styleControls.appendChild(buildStyleProfileToggle());

  // Density writes the spacing fields of EVERY section (see styleDensityPresets):
  // a shortcut, not a mode — the fields stay what decides.
  const density = buildStyleBlock("density", "Density — spacing in every section");
  const densityButtons = document.createElement("div");
  densityButtons.className = "style-density-toggle";
  densityButtons.setAttribute("aria-label", "Density");
  ["compact", "comfortable", "large"].forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.styleDensity = preset;
    button.textContent = preset.charAt(0).toUpperCase() + preset.slice(1);
    densityButtons.appendChild(button);
  });
  density.appendChild(densityButtons);
  el.styleControls.appendChild(density);

  el.styleControls.appendChild(buildStyleScope("app"));

  const sections = buildStyleBlock("sections", "Section styles");
  const intro = document.createElement("p");
  intro.className = "style-sections-intro";
  intro.textContent = "Each part of the app has its own ◐ button, beside it. These open the same controls from here.";
  sections.appendChild(intro);
  const list = document.createElement("div");
  list.className = "style-sections-list";
  styleScopes.filter(({ id }) => id !== "app").forEach(({ id, label, entry }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "style-section-link";
    button.dataset.styleOpenScope = id;
    const name = document.createElement("span");
    name.className = "style-section-link-name";
    name.textContent = label;
    const where = document.createElement("small");
    where.textContent = entry;
    button.append(name, where);
    list.appendChild(button);
  });
  sections.appendChild(list);
  el.styleControls.appendChild(sections);

  el.styleControls.dataset.rendered = "true";
}

export function numericStyleValue(value) {
  const number = parseFloat(String(value ?? "").match(/-?\d*\.?\d+/)?.[0] ?? "");
  return Number.isFinite(number) ? number : null;
}

export function updateStyleProfileUi() {
  const activeProfile = detectStyleProfile();
  const editProfile = currentEditProfile();
  allStyleHosts().forEach((root) => {
    root.querySelectorAll("[data-style-profile-badge]").forEach((badge) => { badge.textContent = styleProfileLabel(editProfile); });
    root.querySelectorAll("[data-style-profile-hint]").forEach((hint) => {
      const activeLabel = styleProfileLabel(activeProfile);
      const editLabel = styleProfileLabel(editProfile);
      hint.textContent = editProfile === activeProfile
        ? `${activeLabel} values are active on this screen.`
        : `Editing ${editLabel} values. This screen is currently using ${activeLabel}.`;
    });
    root.querySelectorAll("button[data-style-profile]").forEach((button) => {
      const isEditProfile = button.dataset.styleProfile === editProfile;
      const isActiveProfile = button.dataset.styleProfile === activeProfile;
      button.classList.toggle("is-active", isEditProfile);
      button.classList.toggle("is-device", isActiveProfile);
      button.setAttribute("aria-pressed", String(isEditProfile));
    });
  });
}

export function updateStyleControls() {
  renderStyleControls();
  const editProfile = currentEditProfile();
  const settings = getStyleProfileSettings(editProfile);
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  updateStyleProfileUi();
  styleInputs().forEach((input) => {
    // NEVER rewrite the field being typed in. This runs on every keystroke —
    // the input listener applies the change, applyStyleSettings calls back in
    // here, and this line used to overwrite the caret out from under you. The
    // value it wrote was the NORMALIZED one, so typing "2" into a px field
    // became "2px" with the caret at the end, and the next digit produced
    // "2px4" — which normalizeStyleValue passes through verbatim into a custom
    // property, taking out whatever read it. Two keystrokes to break the app's
    // text sizing, with no way to type a two-digit number at all.
    //
    // The field is normalized on focusout instead (see wireStyleHost), so
    // "28" still becomes "28px" — just once you've finished saying it.
    const key = input.dataset.styleKey;
    input.placeholder = stylePlaceholder(key, settings, defaults);
    if (input === document.activeElement) return;
    input.value = styleDisplayValue(key, settings[key]);
  });
  updateStyleFieldStates();
}

// Which profile the controls edit. Lives here rather than in the cloud module
// that used to own it so the section popovers can switch it without importing
// the sync code; src/cloud/style-sync.js re-exports it.
export function switchStyleEditProfile(profile, options = {}) {
  if (!styleProfiles.includes(profile)) return;
  state.styleEditProfile = profile;
  state.styleEditProfileFollowsDevice = options.followDevice ?? false;
  updateStyleControls();
  setStyleStatus(`Editing ${styleProfileLabel(profile).toLowerCase()} style`);
}

// ── One set of listeners, for every host ─────────────────────────────────────
//
// The panel and each popover are wired by the same function, so a control does
// exactly the same thing wherever it was reached from. `onOpenScope` is how the
// panel's "Section styles" list asks for a section (the popover module answers).
export function wireStyleHost(root, { onOpenScope = null, onResetScope = null } = {}) {
  if (!root || root.dataset.styleWired === "true") return;
  root.dataset.styleWired = "true";
  // `button[...]`, not a bare attribute selector. applyActiveStyleSettings puts
  // data-style-profile on <html>, and closest() walks all the way to the root —
  // so `closest("[data-style-profile]")` matched the DOCUMENT ELEMENT for every
  // click that landed anywhere in this panel. The buttons are the only real
  // targets here, so say so.
  root.addEventListener("click", (event) => {
    const profileButton = event.target.closest("button[data-style-profile]");
    if (profileButton) { switchStyleEditProfile(profileButton.dataset.styleProfile); return; }

    const densityButton = event.target.closest("button[data-style-density]");
    if (densityButton) { applyStyleDensity(densityButton.dataset.styleDensity); return; }

    const resetButton = event.target.closest("button[data-style-reset]");
    if (resetButton) { resetStyleField(resetButton.dataset.styleReset); return; }

    const scopeReset = event.target.closest("button[data-style-reset-scope]");
    if (scopeReset) { (onResetScope || resetStyleScope)(scopeReset.dataset.styleResetScope); return; }

    const scopeButton = event.target.closest("button[data-style-open-scope]");
    if (scopeButton && onOpenScope) { onOpenScope(scopeButton.dataset.styleOpenScope, scopeButton); return; }
  });
  root.addEventListener("input", (event) => {
    if (event.target.matches("[data-style-key]")) handleStyleControlChange();
  });
  root.addEventListener("change", (event) => {
    if (event.target.matches("[data-style-key]")) handleStyleControlChange();
  });
  // Normalization happens HERE, not on every keystroke. updateStyleControls
  // refuses to touch the focused field (that's what fixed typing), so this is
  // where "28" finally becomes "28px" and a field left empty gets the default
  // put back into it.
  root.addEventListener("focusout", (event) => {
    if (!event.target.matches("[data-style-key]")) return;
    const defaults = defaultStyleProfiles[currentEditProfile()] || styleDefaults;
    const key = event.target.dataset.styleKey;
    // An emptied follows-Notes (or automatic) box stays empty: that IS its
    // follow state, and its placeholder says so.
    const normalized = styleDisplayValue(key, normalizeStyleValue(key, event.target.value, defaults[key]));
    // Leaving a field you didn't touch is not an edit. Without this, tabbing
    // through the panel would mark the profile "Unsynced" and set styleTouched,
    // which also makes Sync Down refuse to overwrite (see loadStyleFromWeb).
    if (normalized === event.target.value) return;
    event.target.value = normalized;
    handleStyleControlChange();
  });
}

export function applyStyleSettings(rawSettings, options = {}) {
  const settings = normalizeStyleSettings(rawSettings);
  const activeProfile = state.activeStyleProfile || detectStyleProfile();
  state.styleSettings = settings;
  // A value CSS can't use never reaches the page. The controls are free text on
  // purpose (calc(), rem, vh all work), but "free text" also means "one typo
  // away from a declaration that parses as garbage" — and a custom property
  // accepts garbage happily, so the breakage surfaced somewhere else entirely.
  // Fall back to this profile's default for anything that fails its probe; the
  // field itself is marked invalid by updateStyleFieldStates, which is where
  // the user finds out.
  const profileDefaults = defaultStyleProfiles[activeProfile] || styleDefaults;
  const usable = (key) => {
    const field = styleFieldByKey[key];
    return isStyleValueUsable(field, settings[key]) ? settings[key] : profileDefaults[key];
  };
  // The layout boxes. A bare number keeps its old meaning — a percent of the
  // screen or the container, in the unit each variable has always used — and
  // anything else (900px, 60ch, calc(…)) is used exactly as written.
  const layout = (key, unit) => {
    const value = usable(key);
    return /^-?\d*\.?\d+$/.test(String(value).trim()) ? `${String(value).trim()}${unit}` : value;
  };

  const root = document.documentElement;
  // ONE font variable. --question/answer/notes-font-family are declared in
  // :root as `var(--app-font-family)`, so they inherit from this for free.
  // Setting all four here (from four separate pickers that all defaulted to
  // "system") meant the inheritance never took effect, and "Base font family"
  // appeared to do nothing to any card or note — it only reached app chrome.
  root.style.setProperty("--app-font-family", resolveFontFamily(settings.fontFamily));
  // Interface size: <html>'s own font-size, so every rem in the chrome follows
  // it. Not a custom property — rem is defined against this and nothing else.
  root.style.fontSize = usable("uiFontSize");
  // …except the notes, which can now opt out of it. Same reason this one is
  // hand-written rather than left to the styleCssVariables loop below: the
  // stored value is a KEY into fontFamilyChoices, not a font stack, so it has to
  // go through resolveFontFamily. "inherit" clears the override entirely rather
  // than writing the word "inherit" into the property — the :root declaration is
  // already `var(--app-font-family)`, so removing ours restores that alias and
  // the Basics font keeps reaching the notes exactly as before.
  if (settings.notesFontFamily && settings.notesFontFamily !== "inherit") {
    root.style.setProperty("--notes-font-family", resolveFontFamily(settings.notesFontFamily));
  } else {
    root.style.removeProperty("--notes-font-family");
  }
  root.style.setProperty("--question-justify-items", questionJustifyItems(settings.questionAlign));
  // The generic writes. An `inherits` or `auto` field in its empty state is not
  // a value to write, it is an instruction NOT to: same device as
  // notesFontFamily above. The rules that read one carry their own fallback —
  // `var(--hl-note-font-size, var(--notes-font-size))`, `var(--toc-font-size,
  // 0.82rem)` — so removing ours hands the surface back to what it follows, or
  // to the stylesheet's own value. Writing the literal word "inherit" would be a
  // different thing entirely: `font-size: inherit` on .hl-notes inherits from
  // the PANE, not from the notes. And the fallback for an unusable value is
  // checked too: an `auto` field's default IS "auto", which must not be written.
  Object.entries(styleCssVariables).forEach(([key, cssVariable]) => {
    const field = styleFieldByKey[key];
    const value = usable(key);
    if (isStyleFollowValue(field, value)) root.style.removeProperty(cssVariable);
    else root.style.setProperty(cssVariable, value);
  });
  // Highlights in text. The tint is a bare number in storage and a factor on the
  // page (styles/12-notes.css multiplies each colour's own strength by it); the
  // note underline is a choice that is two properties, because "none" is a
  // text-decoration-line and the rest are text-decoration-styles.
  const tint = numericStyleValue(settings.markTintPercent) ?? numericStyleValue(profileDefaults.markTintPercent) ?? 100;
  root.style.setProperty("--mark-tint", String(Math.max(0, tint) / 100));
  const underline = settings.markNoteUnderline || "dotted";
  root.style.setProperty("--mark-note-line", underline === "none" ? "none" : "underline");
  root.style.setProperty("--mark-note-style", underline === "none" ? "dotted" : underline);
  // --question-padding/--answer-padding and --textarea-min-height are NOT set
  // here: their controls were removed (the first padded inside cardPadding —
  // two ways to push the same text inward; the second only sized the import
  // box). The :root defaults in styles.css carry them now.
  root.style.setProperty("--notes-max-width", layout("notesMaxWidthPercent", "%"));
  // A bare number in storage, a percentage on the page — the same shape as the
  // line above, and absent from styleCssVariables for the same reason: the
  // generic loop writes a setting's value verbatim, and "74" is not a colour
  // stop. Consumed by .hl-note-quote's color-mix.
  root.style.setProperty("--hl-quote-ink", `${numericStyleValue(settings.hlQuoteInkPercent) ?? numericStyleValue(profileDefaults.hlQuoteInkPercent) ?? 74}%`);
  // An enum in storage, a multiplier on the page — absent from styleCssVariables
  // for the same reason as the line above. Scales the per-theme --code-mark-wash
  // and --code-mark-edge tokens in styles/66-code-marks.css.
  root.style.setProperty("--code-mark-scale", CODE_MARK_SCALES[settings.codeHighlightStrength] || CODE_MARK_SCALES.medium);
  // Deliberately not in styleCssVariables above: this setting selects a
  // different LAYOUT for the notes view (a class plus a repagination), not a
  // different value for one of its properties. See src/notes/paged-view.js.
  setNotesReadingMode(settings.notesReadingMode);
  // Also a class, not a value: the stylesheet draws the numbers only while it
  // is on <html>, so the switch needs no re-render. See heading-numbers.js.
  setHeadingNumbersOn(settings.headingNumbers !== "off");
  // The only percent that isn't run through numericStyleValue above, so it's the
  // only one where a non-numeric entry would reach CSS as "abc%".
  root.style.setProperty("--question-fill", `${numericStyleValue(settings.questionFillPercent) ?? numericStyleValue(profileDefaults.questionFillPercent) ?? 58}%`);
  root.style.setProperty("--app-width", layout("appWidthPercent", "vw"));
  root.style.setProperty("--app-height", layout("appHeightPercent", "vh"));
  root.style.setProperty("--app-mobile-width", layout("appWidthPercent", "vw"));
  root.style.setProperty("--app-mobile-height", layout("appHeightPercent", "dvh"));
  root.style.setProperty("--card-width", layout("cardWidthPercent", "%"));
  root.style.setProperty("--card-mobile-width", layout("cardWidthPercent", "%"));
  root.style.setProperty("--card-max-height", layout("cardMaxHeightPercent", "vh"));
  root.style.setProperty("--card-mobile-max-height", layout("cardMaxHeightPercent", "dvh"));
  root.style.setProperty("--modal-width", layout("modalWidthPercent", "vw"));
  root.style.setProperty("--visual-max-width", layout("visualMaxWidthPercent", "%"));
  root.style.setProperty("--notes-visual-max-width", layout("notesVisualMaxWidthPercent", "%"));

  if (!isStyleEditorOpen() || state.styleEditProfile === state.activeStyleProfile) {
    updateStyleControls();
  } else {
    updateStyleProfileUi();
  }
  scheduleLiveQuestionFit();
  if (options.force) forceStyleRefresh();

  return settings;
}

export function applyActiveStyleSettings(options = {}) {
  const activeProfile = detectStyleProfile();
  state.activeStyleProfile = activeProfile;
  document.documentElement.dataset.styleProfile = activeProfile;
  return applyStyleSettings(getStyleProfileSettings(activeProfile), options);
}

// ── On-screen keyboard inset ────────────────────────────────────────────────
//
// How much of the viewport the software keyboard is covering right now, exposed
// to CSS as --kb-inset (see the token in styles.css).
//
// Why it's needed at all: the layout viewport does not necessarily shrink when
// the keyboard opens. index.html asks for interactive-widget=resizes-content,
// which makes Chrome on Android do exactly that — but iOS Safari ignores the
// hint, and there the page keeps its full height while the keyboard is drawn
// over the bottom of it. The browser's own "scroll the caret into view" then
// does nothing, because in layout terms the caret is already on screen. What
// the user sees is text they just typed disappearing under the keyboard.
//
// visualViewport reports the region actually visible, so innerHeight minus it
// is the covered strip. Where the browser DID resize the layout, innerHeight
// shrank too and this reads ~0 — so the two mechanisms compose instead of
// double-counting. Rounded and change-gated because visualViewport fires a
// burst of events during the keyboard animation and each write invalidates
// layout for the whole shell.
export let keyboardInsetPx = 0;

export function currentKeyboardInset() {
  return keyboardInsetPx;
}

export function trackKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    // offsetTop matters: pinch-zoomed or scrolled-within-the-visual-viewport,
    // the visible band is shorter AND displaced, and only the part below it is
    // keyboard. A small floor keeps browser-chrome jitter from reading as a
    // keyboard.
    const covered = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
    const next = covered > 24 ? covered : 0;
    if (next === keyboardInsetPx) return;
    keyboardInsetPx = next;
    document.documentElement.style.setProperty("--kb-inset", `${next}px`);
    // The editor's own scroll has to be re-checked against the new usable
    // height, or the caret is left behind the keyboard for as long as it stays
    // still.
    if (isNotesEditing()) scheduleNotesCaretCheck();
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

export function loadLocalStyleSettings() {
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

export function hasMeaningfulStyleSettings(settings) {
  return Boolean(settings && typeof settings === "object" && Object.keys(settings).length > 0);
}

export function questionJustifyItems(align) {
  if (align === "right") return "end";
  if (align === "center") return "center";
  if (align === "justify") return "stretch";
  return "start";
}

// What the controls on screen say, ON TOP OF what is stored.
//
// The merge is the whole point. This used to read every control in the one
// panel and normalize the result, which was right while the panel held every
// key; a section popover holds five, and normalizing five keys back-fills the
// other ninety with defaults — one keystroke in "Contents" would have reset
// everyone's card sizes. Only hosts on screen are read, so a hidden panel still
// holding what it said the last time it was open cannot overwrite anything.
export function styleSettingsFromControls() {
  // Normalize against the profile being EDITED. Without the argument this
  // defaulted to "desktop", so anything the controls didn't supply was
  // back-filled with desktop values while you were editing the Mobile profile.
  const editProfile = currentEditProfile();
  const settings = { ...getStyleProfileSettings(editProfile) };
  styleInputs(openStyleHosts()).forEach((input) => {
    settings[input.dataset.styleKey] = input.value;
  });
  return normalizeStyleSettings(settings, editProfile);
}

// The re-fit that the old "Apply" button existed to trigger. Every control has
// always applied live on input; Apply's only remaining job was passing
// { force: true } so the question auto-fit and table fits were recomputed from
// scratch. That's a thing to do when you stop typing, not a button to hunt for,
// so it runs on its own once the field has been quiet for a moment.
export let styleRefitTimer = null;

export function scheduleStyleRefit() {
  clearTimeout(styleRefitTimer);
  styleRefitTimer = setTimeout(() => {
    styleRefitTimer = null;
    if (state.styleEditProfile === detectStyleProfile()) forceStyleRefresh();
  }, 200);
}

// Save these settings to the profile being edited, put them on the page if that
// profile is this screen's, and repaint the controls. Every edit path ends here
// — typing, ↺, Reset this section, Density — so they cannot drift apart.
function commitStyleEdit(settings, { repaint = false, force = false, status = null } = {}) {
  state.styleTouched = true;
  const editProfile = currentEditProfile();
  const saved = setStyleProfileSettings(editProfile, settings);
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings(force ? { force: true } : {});
  else updateStyleProfileUi();
  // A path that did not type into the controls has to tell them: applying only
  // repaints them when this screen's profile is the one being edited.
  if (repaint) updateStyleControls();
  scheduleMarkdownTableFit();
  scheduleStyleRefit();
  updateStyleFieldStates();
  setStyleStatus(status || `Unsynced ${styleProfileLabel(editProfile).toLowerCase()} style`);
  return saved;
}

export function handleStyleControlChange() {
  return commitStyleEdit(styleSettingsFromControls());
}

// ── Reset ──────────────────────────────────────────────────────────
// The panel had no way back. With free-text controls and no clamping, a stray
// "2" in Text size renders the whole app — including this panel — too small to
// read, and the only recovery was clearing site data, which takes the user's
// decks with it.
export function resetStyleField(key) {
  if (!styleFieldByKey[key]) return;
  const defaults = defaultStyleProfiles[currentEditProfile()] || styleDefaults;
  // Straight to the settings, not through the box: the box may be the one with
  // focus, which updateStyleControls will not touch, so it is set here too.
  styleInputs().filter((input) => input.dataset.styleKey === key).forEach((input) => {
    input.value = styleDisplayValue(key, defaults[key]);
  });
  commitStyleEdit({ ...styleSettingsFromControls(), [key]: defaults[key] }, { repaint: true });
}

// One section back to its defaults, and nothing else: the reason sections exist
// is that tuning one cannot move another, and a reset is a tuning too.
export function resetStyleScope(scope) {
  const keys = styleScopeKeys(scope);
  if (!keys.length) return;
  const editProfile = currentEditProfile();
  const label = styleProfileLabel(editProfile);
  const sectionLabel = styleScopeById[scope]?.label || scope;
  showConfirmModal(
    `Put the ${sectionLabel} style controls on the ${label.toLowerCase()} profile back to their defaults? Every other section is left alone.`,
    () => {
      const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
      const next = { ...getStyleProfileSettings(editProfile) };
      keys.forEach((key) => { next[key] = defaults[key]; });
      commitStyleEdit(next, { repaint: true, force: true, status: `${sectionLabel} style reset to defaults` });
      if (state.previewCard || state.cards[state.current]) showCard();
      showToast(`${sectionLabel} style reset`, "success");
    },
    { confirmLabel: "Reset" }
  );
}

export function resetStyleProfile() {
  const editProfile = currentEditProfile();
  const label = styleProfileLabel(editProfile);
  const other = editProfile === "desktop" ? "mobile" : "desktop";
  showConfirmModal(
    `Put every ${label.toLowerCase()} style control, in every section, back to its default? Your theme and your ${other} profile are left alone.`,
    () => {
      state.styleTouched = true;
      setStyleProfileSettings(editProfile, { ...defaultStyleProfiles[editProfile] });
      if (editProfile === detectStyleProfile()) applyActiveStyleSettings({ force: true });
      updateStyleControls();
      if (state.previewCard || state.cards[state.current]) showCard();
      setStyleStatus(`${label} style reset to defaults`);
      showToast(`${label} style reset`, "success");
    },
    { confirmLabel: "Reset" }
  );
}

// Writes the preset's real values — into every section it covers, most of which
// are not on screen — then saves, applies and re-paints exactly like typing
// them would.
export function applyStyleDensity(preset) {
  const editProfile = currentEditProfile();
  const values = styleDensityPresets[editProfile]?.[preset];
  if (!values) return;
  commitStyleEdit({ ...styleSettingsFromControls(), ...values }, {
    repaint: true,
    force: true,
    status: `${styleProfileLabel(editProfile)} density: ${preset}`
  });
}

export function forceStyleRefresh() {
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

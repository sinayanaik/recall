// Reading, normalising, applying and editing the per-profile style settings.
//
// Settings are stored per profile (desktop/mobile) and migrated forward from
// the older flat shape on read, so a device that has not synced since still
// loads. Controls that wrote a CSS variable nothing read have been removed;
// normalisation drops them rather than applying garbage.

import { styleStorageKey } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeRegExp } from "../core/text.js?v=__BUILD__";
import { isNotesEditing, renderAllCards, scheduleLiveQuestionFit, scheduleMarkdownTableFit, scheduleNotesCaretCheck, showCard, showConfirmModal, showToast, state } from "../main.js?v=__BUILD__";
import { defaultStyleProfiles, styleControlGroups, styleCssVariables, styleDefaults, styleDensityPresets, styleFieldByKey } from "./style-schema.js?v=__BUILD__";
import { styleMobileMedia, styleProfiles } from "./style-tokens.js?v=__BUILD__";
import { fontFamilyChoices } from "./theme-catalog.js?v=__BUILD__";
import { currentThemeId } from "./theme.js?v=__BUILD__";

export function resolveFontFamily(value) {
  return fontFamilyChoices[value] || value;
}

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
export function isStyleValueUsable(field, value) {
  if (!field || field.type === "select") return true;
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (field.probe === "number") return /^-?\d*\.?\d+$/.test(raw) && Number.isFinite(parseFloat(raw));
  if (!field.probe || typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  try {
    return CSS.supports(field.probe, raw);
  } catch (_) {
    return false;
  }
}

// Paints the two per-field affordances: the invalid marker, and the ↺ that only
// appears once a value differs from this profile's default.
export function updateStyleFieldStates() {
  if (!el.styleControls) return;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  el.styleControls.querySelectorAll("[data-style-key]").forEach((input) => {
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
  return styleMobileMedia?.matches ? "mobile" : "desktop";
}

export function styleProfileLabel(profile) {
  return profile === "mobile" ? "Mobile" : "Desktop";
}

// Bumped to 3 when the panel was trimmed to only controls that do something,
// to 4 when sliders were dropped for plain textboxes and the two dead
// controls (cardTextPadding, markdownBoxHeightPercent) were removed. Carried
// on the stored blob (not just the cloud payload) so one-shot migrations run
// exactly once per device rather than on every load.
export const STYLE_SETTINGS_VERSION = 4;

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

  if (!hasProfiles) {
    const legacySource = dropPreV3(source);
    const legacy = normalizeStyleSettings(legacySource, "desktop");
    const mobileLegacySource = { ...defaultStyleProfiles.mobile, ...migrateLegacyStyleSettings(legacySource) };
    return {
      desktop: { ...legacy },
      mobile: normalizeStyleSettings(mobileLegacySource, "mobile"),
      version: STYLE_SETTINGS_VERSION
    };
  }

  const desktopSource = profileSource.desktop || profileSource.mobile || defaultStyleProfiles.desktop;
  const mobileSource = profileSource.mobile || profileSource.desktop || defaultStyleProfiles.mobile;
  return {
    desktop: normalizeStyleSettings(dropPreV3(desktopSource), "desktop"),
    mobile: normalizeStyleSettings(dropPreV3(mobileSource), "mobile"),
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

export function renderStyleControls() {
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

  // Density: one press for the eight size/spacing values almost everyone was
  // opening Advanced to tune one at a time. It writes the real controls (see
  // styleDensityPresets), so the fields underneath move with it and stay the
  // thing that decides — this is a shortcut, not a mode.
  const density = document.createElement("section");
  density.className = "style-density-field";
  density.setAttribute("aria-label", "Density");
  const densityHead = document.createElement("div");
  densityHead.className = "style-density-head";
  densityHead.textContent = "Density";
  density.appendChild(densityHead);
  const densityButtons = document.createElement("div");
  densityButtons.className = "style-density-toggle";
  ["compact", "comfortable", "large"].forEach((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.styleDensity = preset;
    button.textContent = preset.charAt(0).toUpperCase() + preset.slice(1);
    densityButtons.appendChild(button);
  });
  density.appendChild(densityButtons);
  const densityHint = document.createElement("small");
  densityHint.textContent = "Sets text size, line spacing, padding, gaps and button height together. Fine-tune any of them under Advanced.";
  density.appendChild(densityHint);
  el.styleControls.appendChild(density);

  // Everything past the basics goes inside ONE fold. Seven peer accordions read
  // as seven equally-important things to work through; a short visible list plus
  // "Advanced" reads as a setting you change and a drawer you can ignore.
  const advanced = document.createElement("details");
  advanced.className = "style-advanced";
  advanced.open = false;
  const advancedHeading = document.createElement("summary");
  advancedHeading.textContent = "Advanced";
  advanced.appendChild(advancedHeading);
  const advancedBody = document.createElement("div");
  advancedBody.className = "style-advanced-body";
  advanced.appendChild(advancedBody);

  styleControlGroups.forEach((group) => {
    const isBasic = group.tier === "basic";
    // Basics render as a plain list — no summary, nothing to expand. A
    // disclosure you always want open is just a click in the way.
    const section = document.createElement(isBasic ? "section" : "details");
    section.className = isBasic ? "style-basics" : "style-section";

    if (isBasic) {
      section.setAttribute("aria-label", group.title);
    } else {
      section.open = false;
      const heading = document.createElement("summary");
      heading.textContent = group.title;
      section.appendChild(heading);
    }

    const body = document.createElement("div");
    body.className = "style-section-body";

    group.fields.forEach((field) => {
      const label = document.createElement("label");
      label.className = "style-field";

      // Name row, so the per-field ↺ can sit opposite the label rather than
      // pushing the control around. It's hidden until the value differs from
      // this profile's default (updateStyleFieldStates), so an untouched panel
      // shows no reset affordance at all.
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
        field.options.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
          control.appendChild(option);
        });
        control.dataset.styleKey = field.key;
        label.appendChild(control);
      } else {
        // Plain textbox, no slider companion and no min/max — see the comment
        // on styleControlGroups.
        control = document.createElement("input");
        control.type = "text";
        control.spellcheck = false;
        control.placeholder = styleDefaults[field.key] || "";
        control.dataset.styleKey = field.key;
        control.dataset.unit = field.unit || "";
        label.appendChild(control);
      }

      const hint = document.createElement("small");
      hint.textContent = field.hint;
      label.appendChild(hint);

      body.appendChild(label);
    });

    section.appendChild(body);
    (isBasic ? el.styleControls : advancedBody).appendChild(section);
  });

  el.styleControls.appendChild(advanced);
  el.styleControls.dataset.rendered = "true";
}

export function numericStyleValue(value) {
  const number = parseFloat(String(value ?? "").match(/-?\d*\.?\d+/)?.[0] ?? "");
  return Number.isFinite(number) ? number : null;
}

export function updateStyleProfileUi() {
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

export function updateStyleControls() {
  renderStyleControls();
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const settings = getStyleProfileSettings(editProfile);
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  updateStyleProfileUi();
  el.styleControls?.querySelectorAll("[data-style-key]").forEach((input) => {
    // NEVER rewrite the field being typed in. This runs on every keystroke —
    // the input listener applies the change, applyStyleSettings calls back in
    // here, and this line used to overwrite the caret out from under you. The
    // value it wrote was the NORMALIZED one, so typing "2" into a px field
    // became "2px" with the caret at the end, and the next digit produced
    // "2px4" — which normalizeStyleValue passes through verbatim into a custom
    // property, taking out whatever read it. Two keystrokes to break the app's
    // text sizing, with no way to type a two-digit number at all.
    //
    // The field is normalized on focusout instead (see the listener below), so
    // "28" still becomes "28px" — just once you've finished saying it.
    if (input === document.activeElement) {
      input.placeholder = defaults[input.dataset.styleKey] || "";
      return;
    }
    input.value = settings[input.dataset.styleKey] ?? "";
    input.placeholder = defaults[input.dataset.styleKey] || "";
  });
  updateStyleFieldStates();
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
  const appWidthPercent = numericStyleValue(settings.appWidthPercent) ?? 100;
  const appHeightPercent = numericStyleValue(settings.appHeightPercent) ?? 100;
  const cardWidthPercent = numericStyleValue(settings.cardWidthPercent) ?? 96;
  const cardMaxHeightPercent = numericStyleValue(settings.cardMaxHeightPercent) ?? 74;
  const modalWidthPercent = numericStyleValue(settings.modalWidthPercent) ?? 60;
  const visualMaxWidthPercent = numericStyleValue(settings.visualMaxWidthPercent) ?? (activeProfile === "mobile" ? 90 : 50);

  const notesMaxWidthPercent = numericStyleValue(settings.notesMaxWidthPercent) ?? 100;

  const root = document.documentElement;
  // ONE font variable. --question/answer/notes-font-family are declared in
  // :root as `var(--app-font-family)`, so they inherit from this for free.
  // Setting all four here (from four separate pickers that all defaulted to
  // "system") meant the inheritance never took effect, and "Base font family"
  // appeared to do nothing to any card or note — it only reached app chrome.
  root.style.setProperty("--app-font-family", resolveFontFamily(settings.fontFamily));
  root.style.setProperty("--question-justify-items", questionJustifyItems(settings.questionAlign));
  Object.entries(styleCssVariables).forEach(([key, cssVariable]) => {
    root.style.setProperty(cssVariable, usable(key));
  });
  // --question-padding/--answer-padding and --textarea-min-height are NOT set
  // here: their controls were removed (the first padded inside cardPadding —
  // two ways to push the same text inward; the second only sized the import
  // box). The :root defaults in styles.css carry them now.
  root.style.setProperty("--notes-max-width", `${notesMaxWidthPercent}%`);
  // The only percent that isn't run through numericStyleValue above, so it's the
  // only one where a non-numeric entry would reach CSS as "abc%".
  root.style.setProperty("--question-fill", `${numericStyleValue(settings.questionFillPercent) ?? numericStyleValue(profileDefaults.questionFillPercent) ?? 58}%`);
  root.style.setProperty("--app-width", `${appWidthPercent}vw`);
  root.style.setProperty("--app-height", `${appHeightPercent}vh`);
  root.style.setProperty("--app-mobile-width", `${appWidthPercent}vw`);
  root.style.setProperty("--app-mobile-height", `${appHeightPercent}dvh`);
  root.style.setProperty("--card-width", `${cardWidthPercent}%`);
  root.style.setProperty("--card-mobile-width", `${cardWidthPercent}%`);
  root.style.setProperty("--card-max-height", `${cardMaxHeightPercent}vh`);
  root.style.setProperty("--card-mobile-max-height", `${cardMaxHeightPercent}dvh`);
  root.style.setProperty("--modal-width", `${modalWidthPercent}vw`);
  root.style.setProperty("--visual-max-width", `${visualMaxWidthPercent}%`);

  if (!el.stylePanel || el.stylePanel.hidden || state.styleEditProfile === state.activeStyleProfile) {
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

export function styleSettingsFromControls() {
  const settings = {};
  el.styleControls?.querySelectorAll("[data-style-key]").forEach((input) => {
    settings[input.dataset.styleKey] = input.value;
  });
  // Normalize against the profile being EDITED. Without the argument this
  // defaulted to "desktop", so anything the controls didn't supply was
  // back-filled with desktop values while you were editing the Mobile profile.
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
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

export function handleStyleControlChange() {
  state.styleTouched = true;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const settings = setStyleProfileSettings(editProfile, styleSettingsFromControls());
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings();
  else updateStyleProfileUi();
  scheduleMarkdownTableFit();
  scheduleStyleRefit();
  updateStyleFieldStates();
  setStyleStatus(`Unsynced ${styleProfileLabel(editProfile).toLowerCase()} style`);
  return settings;
}

// ── Reset ──────────────────────────────────────────────────────────
// The panel had no way back. With free-text controls and no clamping, a stray
// "2" in Text size renders the whole app — including this panel — too small to
// read, and the only recovery was clearing site data, which takes the user's
// decks with it.
export function resetStyleField(key) {
  if (!styleFieldByKey[key]) return;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const defaults = defaultStyleProfiles[editProfile] || styleDefaults;
  const input = el.styleControls?.querySelector(`[data-style-key="${key}"]`);
  if (!input) return;
  input.value = defaults[key] ?? "";
  handleStyleControlChange();
}

export function resetStyleProfile() {
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const label = styleProfileLabel(editProfile);
  const other = editProfile === "desktop" ? "mobile" : "desktop";
  showConfirmModal(
    `Put every ${label.toLowerCase()} style control back to its default? Your theme and your ${other} profile are left alone.`,
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

// Writes the preset's real control values, then hands off to the normal change
// path so it saves, applies and re-paints exactly like typing them would.
export function applyStyleDensity(preset) {
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  const values = styleDensityPresets[editProfile]?.[preset];
  if (!values) return;
  Object.entries(values).forEach(([key, value]) => {
    const input = el.styleControls?.querySelector(`[data-style-key="${key}"]`);
    if (input) input.value = value;
  });
  handleStyleControlChange();
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings({ force: true });
  setStyleStatus(`${styleProfileLabel(editProfile)} density: ${preset}`);
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

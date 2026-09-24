// The controls that say what a block looks like, built once and arranged twice.
//
// A reader wants to restyle a block in two quite different moments, and they are
// not the same control:
//
//   • while writing it, in the editor window, where the size and the fill are
//     part of what is being written and the block is on the page behind the
//     sheet to be judged against;
//   • without opening anything, from the block itself, because "make that one
//     yellow" should not cost a modal, a Done and a repaint of the whole page.
//
// So this module owns the CONTROLS and nothing else — no window, no popover
// chrome beyond the box it floats in — and hands the nodes to the caller to
// arrange. That is the same division src/notes/note-editor-kit.js draws for the
// editor it lends to three surfaces, and it exists for the reason that one
// states: two implementations of one control is exactly how a surface ends up
// with a quarter of the options.
//
// ── What this looked like first, and why it does not any more ─────────────
//
// Seven labelled rows of pills and swatches, all on screen at once, in a 340px
// panel over a page. "Too cluttered", and it was. The app had already solved
// this for its own settings and written down how, above styleControlGroups in
// src/ui/style-schema.js: a short always-visible tier of what people reach for,
// everything else behind ONE disclosure — the fix for a panel that "was still a
// wall of textboxes before you'd expanded anything".
//
// So: a Fill/Text switch over ONE row of chips rather than two rows of them
// (nobody is choosing both at the same moment), the size and the alignment, and
// then More. Four rows against seven, and the folded half can now hold the
// things a block could not say at all before.
//
// ── ...and why the numbers are typed ──────────────────────────────────────
//
// The same file's other rule: "every numeric control is a plain textbox — no
// sliders and no min/max clamps: whatever you type is what gets applied." The
// ladder this replaces was xs/s/m/l/xl, which is five sizes and no sixth.
//
// Nothing here writes anything. `onChange` is handed the keys that changed and
// the caller decides what that means — which is what lets the popover act on the
// block it is anchored to and the sheet act on the block it is editing, without
// this module knowing what a block is.

import {
  BLOCK_ALIGNS, BLOCK_FILLS, BLOCK_FILL_HEX, BLOCK_FILL_LABEL, BLOCK_FRAMES, BLOCK_FRAME_LABEL,
  BLOCK_INKS, blockFillVar, blockInkVar, normalizeBlockStyle
} from "./block-style.js?v=__BUILD__";
import { MD_SVG_ATTRS } from "../library/my-decks-icons.js?v=__BUILD__";
import { blockPanelPreference, writeBlockPanelPreference } from "../storage/ink-prefs.js?v=__BUILD__";
import { fontFamilyOptionGroups } from "../ui/theme-catalog.js?v=__BUILD__";

const INK_LABEL = { default: "Theme colour" };

// Three icons on the app's own 24x24 grid, drawn rather than typed. The rule
// README states for the pen's rail is that a control which is genuinely iconic
// keeps its glyph and everything else carries the word — and alignment is the
// clearest case of iconic there is, in an app where the same three lines would
// otherwise be "Left", "Centre", "Right" eating a row of a panel this pass
// exists to shorten. Not unicode: ≡ and its relatives are a different weight in
// every font and tofu in some.
const ALIGN_ICONS = {
  left: `<path d="M4 6h16M4 11h10M4 16h14M4 21h8"/>`,
  center: `<path d="M4 6h16M7 11h10M5 16h14M8 21h8"/>`,
  right: `<path d="M4 6h16M10 11h10M6 16h14M12 21h8"/>`
};

const ALIGN_LABEL = { left: "Align left", center: "Align centre", right: "Align right" };

function labelFor(map, token) {
  return map[token] || (token[0].toUpperCase() + token.slice(1));
}

// `label` is the word beside the controls and `aria` is what the group is called
// where there is no room for one — alignment is three icons on a line it shares
// with the size box, and a screen reader is owed the name a sighted reader gets
// from the pictures.
function styleRow(label, { className = "", aria = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `bstyle-row${className ? ` ${className}` : ""}`;
  const group = document.createElement("div");
  group.className = "bstyle-group";
  if (label) {
    const name = document.createElement("span");
    name.className = "bstyle-label";
    name.textContent = label;
    wrap.appendChild(name);
  }
  // A group of mutually exclusive choices, which is what a screen reader is owed
  // for a row of buttons that behave like radios — the same aria-pressed idiom
  // the ink rail uses, with the grouping it has no room for.
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", aria || label);
  wrap.appendChild(group);
  return { wrap, group };
}

// One choice. `key` is the style field it sets, `token` the value.
function styleChoice(key, token, { label = "", swatch = "", icon = "", title = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = swatch ? "bstyle-swatch" : (icon ? "bstyle-icon" : "bstyle-pill");
  button.dataset.bstyleKey = key;
  button.dataset.bstyleValue = token;
  button.title = title || label;
  button.setAttribute("aria-label", title || label);
  if (swatch) button.style.setProperty("--bstyle-swatch", swatch);
  else if (icon) button.innerHTML = `<svg ${MD_SVG_ATTRS}>${icon}</svg>`;
  else button.textContent = label;
  return button;
}

// A typed number with its unit beside it. The Style panel's shape, minus the
// per-field reset it has room for: a box you can empty IS the reset here, and
// what an empty box means is written on the placeholder.
function styleNumber(key, { label, unit, placeholder = "" }) {
  const wrap = document.createElement("label");
  wrap.className = "bstyle-row bstyle-number";
  const name = document.createElement("span");
  name.className = "bstyle-label";
  name.textContent = label;
  const input = document.createElement("input");
  // "text" and not "number", which is the app's own choice for every numeric
  // setting it has: a spinner is two more targets on a panel over a page, and
  // number inputs refuse to tell you what somebody typed while it is mid-way to
  // being a number.
  input.type = "text";
  input.inputMode = "decimal";
  input.spellcheck = false;
  input.className = "bstyle-input";
  input.dataset.bstyleNumber = key;
  input.placeholder = placeholder;
  const suffix = document.createElement("span");
  suffix.className = "bstyle-unit";
  suffix.textContent = unit;
  wrap.append(name, input, suffix);
  return { wrap, input };
}

function styleSelect(key, { label, groups, extra = null }) {
  const wrap = document.createElement("label");
  wrap.className = "bstyle-row bstyle-select";
  const name = document.createElement("span");
  name.className = "bstyle-label";
  name.textContent = label;
  const select = document.createElement("select");
  select.dataset.bstyleSelect = key;
  const option = (value, text) => {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text || value;
    return node;
  };
  if (extra) select.appendChild(option(extra.value, extra.label));
  groups.forEach(({ label: groupLabel, options }) => {
    // Grouped for the reason fontFamilyOptionGroups exists at all — its own
    // comment: "a flat 32-entry dropdown is not what exhaustive should feel like
    // to scroll through".
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupLabel;
    options.forEach(([value, text]) => optgroup.appendChild(option(value, text)));
    select.appendChild(optgroup);
  });
  wrap.append(name, select);
  return { wrap, select };
}

function switchButton(key, label) {
  const button = styleChoice(key, "toggle", { label });
  button.classList.add("bstyle-switch");
  return button;
}

// `has` says what is inside this block — { code, image } — so the two rows that
// are about the markdown's contents appear only when there are contents for them
// to be about. A control acting on nothing is the clutter this pass is about,
// and it is also a control that looks broken.
export function createBlockStyleBar({ style = null, kind = "text", has = null, onChange = () => {} } = {}) {
  const isImage = kind === "image";
  const holds = { code: false, image: false, ...(has || {}) };
  const panel = blockPanelPreference();
  let value = normalizeBlockStyle(style);
  // Which palette the one chip row is showing. Meaningless on a picture, which
  // has no words to colour, so its row is the fill and there is no switch.
  let swatchKey = (!isImage && panel.swatch === "ink") ? "ink" : "fill";

  const root = document.createElement("div");
  root.className = "bstyle";
  if (isImage) root.classList.add("is-image");

  // ── The one chip row, and the switch that says what it paints ────────────
  const tabs = document.createElement("div");
  tabs.className = "bstyle-tabs";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "What the colours below change");
  const tabFor = (key, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bstyle-tab";
    button.dataset.bstyleTab = key;
    button.textContent = label;
    return button;
  };
  tabs.append(tabFor("fill", "Fill"), tabFor("ink", "Text"));
  if (!isImage) root.appendChild(tabs);

  const swatches = document.createElement("div");
  swatches.className = "bstyle-swatches";
  swatches.setAttribute("role", "group");
  root.appendChild(swatches);

  function paintSwatches() {
    swatches.replaceChildren();
    swatches.setAttribute("aria-label", swatchKey === "ink" ? "Text colour" : "Fill");
    const tokens = swatchKey === "ink" ? BLOCK_INKS : BLOCK_FILLS;
    tokens.forEach((token) => {
      const property = swatchKey === "ink" ? blockInkVar(token) : blockFillVar(token);
      swatches.appendChild(styleChoice(swatchKey, token, {
        // The chip is the token's own custom property, so the picker shows the
        // colour the block will actually be on THIS theme rather than the
        // light-theme hex the table happens to list. The fallbacks are for the
        // one case a property cannot cover: a chip rendered before the
        // stylesheet defining it has loaded.
        swatch: swatchKey === "ink"
          ? (property ? `var(${property})` : "var(--text)")
          : `var(${property}, ${BLOCK_FILL_HEX[token]})`,
        title: swatchKey === "ink" ? labelFor(INK_LABEL, token) : labelFor(BLOCK_FILL_LABEL, token)
      }));
    });
  }

  // ── Size and alignment, the other half of the visible tier ───────────────
  const size = styleNumber("size", {
    label: "Size",
    unit: "pt",
    // What an empty box means, said where the empty box is. Points, because
    // that is the unit the block's own position and the pen's nib are in, so
    // this number means the same thing at every zoom and in an export.
    placeholder: "as is"
  });
  const align = styleRow("", { className: "bstyle-aligns", aria: "Alignment" });
  BLOCK_ALIGNS.forEach((token) => {
    align.group.appendChild(styleChoice("align", token, {
      icon: ALIGN_ICONS[token],
      title: labelFor(ALIGN_LABEL, token)
    }));
  });
  const line = document.createElement("div");
  line.className = "bstyle-line";
  if (!isImage) {
    line.append(size.wrap, align.wrap);
    root.appendChild(line);
  }

  // ── ...and everything else, folded ───────────────────────────────────────
  const more = document.createElement("details");
  more.className = "bstyle-more";
  more.open = panel.more;
  const summary = document.createElement("summary");
  summary.textContent = "More";
  more.appendChild(summary);

  const face = styleSelect("font", {
    label: "Face",
    extra: { value: "inherit", label: "App font" },
    groups: fontFamilyOptionGroups.map((group) => ({
      label: group.label,
      options: group.options.map((option) => [option, option])
    }))
  });
  const frame = styleSelect("frame", {
    label: "Frame",
    groups: [{ label: "Frame", options: BLOCK_FRAMES.map((token) => [token, labelFor(BLOCK_FRAME_LABEL, token)]) }]
  });
  const fit = styleRow("Height");
  fit.group.appendChild(switchButton("fit", "Follows the text"));

  // The code and the picture: two rows about what is INSIDE the block rather
  // than about the block. Both are drawn by rules the app already had — see
  // paintBlockStyle — and both are here only when this block holds one.
  const codeSize = styleNumber("codeSize", { label: "Code", unit: "pt", placeholder: "as text" });
  const codeWrap = styleRow("", { className: "bstyle-codewrap", aria: "Code lines" });
  codeWrap.group.appendChild(switchButton("codeWrap", "Wrap long lines"));
  const imageWidth = styleNumber("imageWidth", { label: "Picture", unit: "%", placeholder: "100" });

  if (isImage) {
    more.appendChild(frame.wrap);
  } else {
    more.append(face.wrap, frame.wrap, fit.wrap);
    if (holds.code) {
      // The two code controls share a line, the way the size and the alignment
      // do above: neither fills one, and a switch on a row of its own under a
      // labelled box reads as a control belonging to nothing.
      const codeLine = document.createElement("div");
      codeLine.className = "bstyle-line";
      codeLine.append(codeSize.wrap, codeWrap.wrap);
      more.appendChild(codeLine);
    }
    if (holds.image) more.appendChild(imageWidth.wrap);
  }
  root.appendChild(more);

  // aria-pressed is what draws every button here, exactly as it draws the ink
  // rail — see paintInkRailPressed. One read of the value, one pass over the
  // controls, so a panel can never come to disagree with the block it describes.
  function paint() {
    root.querySelectorAll("[data-bstyle-key]").forEach((button) => {
      const { bstyleKey: key, bstyleValue: token } = button.dataset;
      const on = (key === "fit" || key === "codeWrap") ? Boolean(value[key]) : value[key] === token;
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    tabs.querySelectorAll("[data-bstyle-tab]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.bstyleTab === swatchKey ? "true" : "false");
    });
    root.querySelectorAll("[data-bstyle-select]").forEach((select) => {
      select.value = value[select.dataset.bstyleSelect];
    });
    root.querySelectorAll("[data-bstyle-number]").forEach((input) => {
      const held = value[input.dataset.bstyleNumber];
      // The box a reader is TYPING IN is never rewritten from the value, or a
      // half-typed "1" of "18" comes back as "1" the moment the block repaints.
      if (document.activeElement === input) return;
      input.value = held === null ? "" : String(held);
    });
  }

  function change(patch) {
    value = normalizeBlockStyle({ ...value, ...patch });
    paint();
    onChange(patch);
  }

  // pointerdown rather than click, with preventDefault, for the reason the ink
  // rail gives for the controls it floats over the same page: a press must not
  // travel on to the paper underneath and start a stroke, and on a stylus the
  // two are a few pixels apart. The <select>s and the <input>s are left alone —
  // both need the browser's own press to open or focus.
  root.addEventListener("pointerdown", (event) => {
    if (event.target.closest("select, input, summary")) return;
    const tab = event.target.closest("[data-bstyle-tab]");
    if (tab) {
      event.preventDefault();
      event.stopPropagation();
      swatchKey = tab.dataset.bstyleTab === "ink" ? "ink" : "fill";
      writeBlockPanelPreference({ swatch: swatchKey });
      paintSwatches();
      paint();
      return;
    }
    const button = event.target.closest("[data-bstyle-key]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const key = button.dataset.bstyleKey;
    change((key === "fit" || key === "codeWrap")
      ? { [key]: !value[key] }
      : { [key]: button.dataset.bstyleValue });
  });

  // Live, on every keystroke: the block is on the page behind this panel and
  // watching the type grow as the number is typed is the whole reason the box
  // is here rather than an OK button beside it. What that costs the undo ring
  // is answered in pdf-blocks.js, at pushBlockUndo's coalesce key.
  root.addEventListener("input", (event) => {
    const input = event.target.closest("[data-bstyle-number]");
    if (input) { change({ [input.dataset.bstyleNumber]: input.value }); return; }
    const select = event.target.closest("[data-bstyle-select]");
    if (select) change({ [select.dataset.bstyleSelect]: select.value });
  });

  // Written when it is folded rather than on every open, because the question is
  // "how does this reader want the panel", and the answer they gave last is the
  // one to keep.
  more.addEventListener("toggle", () => writeBlockPanelPreference({ more: more.open }));

  paintSwatches();
  paint();

  return {
    root,
    value: () => ({ ...value }),
    setValue: (next) => { value = normalizeBlockStyle(next); paint(); }
  };
}

// ── ...and the popover the block's own Aa opens ────────────────────────────
//
// One at a time, and rebuilt per open rather than kept: the rows differ between
// a picture and a paragraph, and between a paragraph with code in it and one
// without, so a panel held over from the last block would have to be rebuilt
// anyway.

let popover = null;

// The scroll listener's rAF handle — see scrollHandler in openBlockStylePopover
// for why this exists at all.
let styleBarScrollFrame = 0;

export function isBlockStylePopoverOpen() {
  return Boolean(popover);
}

export function closeBlockStylePopover() {
  if (!popover) return false;
  window.removeEventListener("resize", popover.place);
  // Capture, because what moves this is the document scroller — not the window —
  // and a scroll event does not bubble.
  document.removeEventListener("scroll", popover.scrollHandler, true);
  // A frame can already be in flight (a scroll landed, the rAF is queued, then
  // Escape or a row press closes the popover before it fires) — drop it, or it
  // calls place() against a root that has just been removed from the document.
  if (styleBarScrollFrame) {
    cancelAnimationFrame(styleBarScrollFrame);
    styleBarScrollFrame = 0;
  }
  popover.root.remove();
  popover = null;
  return true;
}

export function openBlockStylePopover({ anchor, kind = "text", style = null, has = null, onChange = () => {} } = {}) {
  closeBlockStylePopover();
  if (!anchor) return null;
  const bar = createBlockStyleBar({ style, kind, has, onChange });

  const root = document.createElement("div");
  root.className = "pdf-block-style-pop";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", kind === "image" ? "Frame this picture" : "Style this block");
  root.appendChild(bar.root);
  document.body.appendChild(root);

  // ── Placing it, which is mostly about not placing it off the screen ───────
  //
  // Under the block if there is room and over it if there is not, and clamped to
  // the viewport in both axes. A block can be dragged to the bottom right corner
  // of a page and a popover that opened faithfully below it would be a panel
  // half off the glass with no way to scroll to the rest of it.
  const place = () => {
    if (!anchor.isConnected) { closeBlockStylePopover(); return; }
    const box = anchor.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const margin = 8;
    const below = box.bottom + margin;
    const top = below + size.height > window.innerHeight - margin
      ? Math.max(margin, box.top - size.height - margin)
      : below;
    const left = Math.min(
      Math.max(margin, box.left),
      Math.max(margin, window.innerWidth - size.width - margin)
    );
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
  };

  // Escape shuts it from anywhere inside, including from the size box — the key
  // map in src/main.js stands down for a press inside an <input>, as it must,
  // and a panel a reader cannot dismiss from the control they are typing in is
  // one they dismiss by pressing the page and losing the selection instead.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeBlockStylePopover();
  });

  // Coalesced into one rAF per frame, the same fix (and the same reason)
  // documentScrollFrame in main.js applies to the document view's own scroll
  // handler: a fling delivers scroll events faster than it delivers frames, and
  // `place` forces two getBoundingClientRect() reads plus two style writes —
  // paying that on every raw event instead of once per frame is exactly the
  // kind of per-scroll layout thrash that fix was measured against.
  const scrollHandler = () => {
    if (styleBarScrollFrame) return;
    styleBarScrollFrame = requestAnimationFrame(() => {
      styleBarScrollFrame = 0;
      place();
    });
  };

  popover = { root, place, bar, scrollHandler };
  place();
  // Re-placed rather than closed on a scroll: the panel is about the block, the
  // block is on a page that scrolls under it, and a control that vanishes when
  // the surface moves an inch is one nobody trusts. `place` also closes it if
  // the block it is about has gone.
  window.addEventListener("resize", place);
  document.addEventListener("scroll", scrollHandler, true);
  return popover;
}

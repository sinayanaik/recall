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
// So this module owns the ROW and nothing else — no window, no popover chrome
// beyond the box it floats in — and hands the nodes to the caller to arrange.
// That is the same division src/notes/note-editor-kit.js draws for the editor it
// lends to three surfaces, and it exists for the reason that one states: two
// implementations of one control is exactly how a surface ends up with a quarter
// of the options.
//
// Nothing here writes anything. `onChange` is handed the keys that changed and
// the caller decides what that means — which is what lets the popover act on the
// block it is anchored to and the sheet act on the block it is editing, without
// this module knowing what a block is.

import {
  BLOCK_ALIGNS, BLOCK_FILLS, BLOCK_FILL_HEX, BLOCK_FONTS, BLOCK_FRAMES, BLOCK_INKS, BLOCK_SIZES,
  blockFillVar, blockInkVar, normalizeBlockStyle
} from "./block-style.js?v=__BUILD__";

// What each token is called where a reader can see it. Words rather than glyphs
// for everything that is not iconic, which is the rule README states for the
// pen's own rail after the same problem: "+✎", "+📷" and "+▯" were a plus jammed
// against a pencil, an emoji a head taller than its neighbours, and tofu on any
// font without a white rectangle. Left/Centre/Right and Card/Outline/None are
// four characters wider and need no decoding at all.
const FILL_LABEL = {
  paper: "Paper", clear: "No fill", yellow: "Yellow", green: "Green",
  blue: "Blue", pink: "Pink", violet: "Violet", grey: "Grey"
};

const INK_LABEL = { default: "Theme" };

const SIZE_LABEL = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };

const FONT_LABEL = { sans: "Sans", serif: "Serif", mono: "Mono", hand: "Hand" };

const ALIGN_LABEL = { left: "Left", center: "Centre", right: "Right" };

const FRAME_LABEL = { card: "Card", outline: "Outline", none: "None" };

function labelFor(map, token) {
  return map[token] || (token[0].toUpperCase() + token.slice(1));
}

function styleRow(label) {
  const wrap = document.createElement("div");
  wrap.className = "bstyle-row";
  const name = document.createElement("span");
  name.className = "bstyle-label";
  name.textContent = label;
  const group = document.createElement("div");
  group.className = "bstyle-group";
  // A group of mutually exclusive choices, which is what a screen reader is owed
  // for a row of buttons that behave like radios — the same aria-pressed idiom
  // the ink rail uses, with the grouping it does not have room for.
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  wrap.append(name, group);
  return { wrap, group };
}

// One choice in a row. `key` is the style field it sets, `token` the value.
function styleChoice(key, token, { label = "", swatch = "", title = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = swatch ? "bstyle-swatch" : "bstyle-pill";
  button.dataset.bstyleKey = key;
  button.dataset.bstyleValue = token;
  button.title = title || label;
  button.setAttribute("aria-label", title || label);
  if (swatch) button.style.setProperty("--bstyle-swatch", swatch);
  else button.textContent = label;
  return button;
}

export function createBlockStyleBar({ style = null, kind = "text", onChange = () => {} } = {}) {
  const isImage = kind === "image";
  let value = normalizeBlockStyle(style);

  const root = document.createElement("div");
  root.className = "bstyle";

  const fill = styleRow("Fill");
  BLOCK_FILLS.forEach((token) => {
    fill.group.appendChild(styleChoice("fill", token, {
      // The chip is the token's own custom property, so the picker shows the
      // colour the block will actually be on THIS theme rather than the light-
      // theme hex the table happens to list. BLOCK_FILL_HEX is the fallback for
      // the one case a custom property cannot cover: a swatch rendered before
      // the stylesheet that defines it has loaded.
      swatch: `var(${blockFillVar(token)}, ${BLOCK_FILL_HEX[token]})`,
      title: labelFor(FILL_LABEL, token)
    }));
  });
  root.appendChild(fill.wrap);

  const frame = styleRow("Frame");
  BLOCK_FRAMES.forEach((token) => {
    frame.group.appendChild(styleChoice("frame", token, { label: labelFor(FRAME_LABEL, token) }));
  });
  root.appendChild(frame.wrap);

  // Everything below is about TYPE, so a picture gets none of it: an image block
  // has no words to size, colour, align or set in a face, and a row of controls
  // that do nothing is worse than a row that is not there. Its ▣ opens the two
  // rows above, which are the two that mean something about a photograph.
  if (!isImage) {
    const ink = styleRow("Text");
    BLOCK_INKS.forEach((token) => {
      const property = blockInkVar(token);
      ink.group.appendChild(styleChoice("ink", token, {
        // The theme's own text colour for "default", which is what it resolves
        // to on the page — a swatch showing a pen colour for it would be a chip
        // that lies about the result.
        swatch: property ? `var(${property})` : "var(--text)",
        title: labelFor(INK_LABEL, token)
      }));
    });
    root.appendChild(ink.wrap);

    const size = styleRow("Size");
    BLOCK_SIZES.forEach((token) => {
      size.group.appendChild(styleChoice("size", token, { label: labelFor(SIZE_LABEL, token) }));
    });
    root.appendChild(size.wrap);

    const font = styleRow("Face");
    BLOCK_FONTS.forEach((token) => {
      const button = styleChoice("font", token, { label: labelFor(FONT_LABEL, token) });
      // Each name set in the face it names, the way the editor's own font menu
      // already does it: the sample IS the label.
      button.dataset.bstyleFontSample = token;
      font.group.appendChild(button);
    });
    root.appendChild(font.wrap);

    const align = styleRow("Align");
    BLOCK_ALIGNS.forEach((token) => {
      align.group.appendChild(styleChoice("align", token, { label: labelFor(ALIGN_LABEL, token) }));
    });
    root.appendChild(align.wrap);

    const fit = styleRow("Height");
    // A switch rather than a third pill beside two sizes, because it is not a
    // choice between heights: it says who decides, the reader or the text.
    const toggle = styleChoice("fit", "toggle", { label: "Follows the text" });
    toggle.classList.add("bstyle-switch");
    fit.group.appendChild(toggle);
    root.appendChild(fit.wrap);
  }

  // aria-pressed is what draws every one of these, exactly as it draws the ink
  // rail — see paintInkRailPressed. One read of the value, one pass over the
  // buttons, so a bar can never come to disagree with the block it describes.
  function paint() {
    root.querySelectorAll("[data-bstyle-key]").forEach((button) => {
      const { bstyleKey: key, bstyleValue: token } = button.dataset;
      const on = key === "fit" ? Boolean(value.fit) : value[key] === token;
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // pointerdown rather than click, with preventDefault, for the reason the ink
  // rail gives for the controls it floats over the same page: a press must not
  // travel on to the paper underneath and start a stroke, and on a stylus the
  // two are a few pixels apart.
  root.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-bstyle-key]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const key = button.dataset.bstyleKey;
    const patch = key === "fit" ? { fit: !value.fit } : { [key]: button.dataset.bstyleValue };
    value = normalizeBlockStyle({ ...value, ...patch });
    paint();
    onChange(patch);
  });

  paint();

  return {
    root,
    value: () => ({ ...value }),
    setValue: (next) => { value = normalizeBlockStyle(next); paint(); }
  };
}

// ── ...and the popover the block's own ▣ / Aa opens ────────────────────────
//
// One at a time, and rebuilt per open rather than kept: the rows differ between
// a picture and a paragraph, and a bar held over from the last block would have
// to be rebuilt anyway.

let popover = null;

export function isBlockStylePopoverOpen() {
  return Boolean(popover);
}

export function closeBlockStylePopover() {
  if (!popover) return false;
  window.removeEventListener("resize", popover.place);
  // Capture, because what moves this is the document scroller — not the window —
  // and a scroll event does not bubble.
  document.removeEventListener("scroll", popover.place, true);
  popover.root.remove();
  popover = null;
  return true;
}

export function openBlockStylePopover({ anchor, kind = "text", style = null, onChange = () => {} } = {}) {
  closeBlockStylePopover();
  if (!anchor) return null;
  const bar = createBlockStyleBar({ style, kind, onChange });

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

  popover = { root, place, bar };
  place();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", place, true);
  return popover;
}

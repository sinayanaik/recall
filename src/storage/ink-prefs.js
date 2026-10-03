// Which pen you last wrote with, and what paper you last wrote it on — on this
// device.
//
// A device preference and not a deck one, deliberately: the colour you write
// corrections in is a fact about you, and having to choose it again on every
// paper would be the kind of small friction that stops people reaching for the
// pen at all. It rides in localStorage beside every other per-device setting
// rather than in the deck's meta bag, which syncs — a phone and a laptop can
// disagree about the nib and neither is wrong.
//
// Normalised on the way out through the palette's own functions, so a value
// written by a build with a different palette becomes one of this build's
// rather than a fifth pen nothing in the rail is ever shown as selected for.

import { BLANK_PAPER_DEFAULT, normalizeBlankPaper } from "../documents/blank-pdf.js?v=__BUILD__";
import { normalizeBlockStyle } from "../documents/block-style.js?v=__BUILD__";
import { INK_ERASER_SIZE_DEFAULT, INK_ERASE_MODE_DEFAULT, INK_ERASE_TARGET_DEFAULT, INK_HL_TOKEN_DEFAULT, INK_HL_WIDTH_DEFAULT, INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkEraseMode, normalizeInkEraseTarget, normalizeInkEraserSize, normalizeInkHex, normalizeInkHlWidth, normalizeInkToken, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";

// How many colours of the reader's own are kept to hand. Six is a row in the
// pen's panel, and more is a palette nobody chose.
export const INK_RECENT_COLORS_MAX = 6;

function normalizeRecentColors(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((value) => {
    const hex = normalizeInkHex(value);
    if (hex && !out.includes(hex) && out.length < INK_RECENT_COLORS_MAX) out.push(hex);
  });
  return out;
}

// The tool a session may come back on. The pen, the highlighter and Text are
// all ways of marking or reading the page that cannot take anything away; the
// eraser and the lasso are not offered back, for the reason given below.
function rememberableTool(tool) {
  return tool === "pen" || tool === "highlighter" ? tool : INK_TOOL_DEFAULT;
}
import { inkPreferencesKey } from "./keys.js?v=__BUILD__";

// ── ...and whether the rail is up, per surface ─────────────────────────────
//
// Two different defaults, because they are two different questions. On somebody
// else's paper the pen is an occasional visitor and the rail is a panel over
// what you are reading, so it stays shut until asked for. On a notebook the pen
// IS the surface: a page of blank paper with the colours, the nib, the eraser
// and the lasso hidden behind a button is a drawing app that looks like it has
// no drawing tools — which is exactly how it was reported. It is also the only
// way a mouse can draw at all (inkTakesPointer), so a desktop arriving at a
// notebook with the rail shut cannot make a mark.
//
// Remembered either way: a reader who shuts it has said something, and it would
// be worse to keep re-opening it than never to have opened it.
const RAIL_OPEN_DEFAULT = { doc: false, notebook: true };

export function inkRailOpen(slot) {
  const key = slot === "notebook" ? "notebook" : "doc";
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = raw ? JSON.parse(raw) : null;
    const stored = parsed?.railOpen?.[key];
    return typeof stored === "boolean" ? stored : RAIL_OPEN_DEFAULT[key];
  } catch (_) {
    return RAIL_OPEN_DEFAULT[key];
  }
}

export function writeInkRailOpen(slot, open) {
  const key = slot === "notebook" ? "notebook" : "doc";
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    const railOpen = (parsed.railOpen && typeof parsed.railOpen === "object") ? parsed.railOpen : {};
    railOpen[key] = Boolean(open);
    localStorage.setItem(inkPreferencesKey, JSON.stringify({ ...parsed, railOpen }));
  } catch (error) {
    console.warn("Could not remember the rail", error);
  }
}

export function inkPreferences() {
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      // A whole colour word now — a custom colour or an opacity rides in it — so
      // it is read back through the pen's own normaliser rather than the
      // palette's, which would turn every one of those back into plain ink.
      pen: normalizeInkToken(parsed?.pen, "pen"),
      width: normalizeInkWidth(parsed?.width),
      // The tool is remembered too, but never as the eraser or the lasso: a
      // session that opens with the eraser selected is one where the first
      // stroke of the day silently deletes something.
      tool: rememberableTool(parsed?.tool),
      // The highlighter's own colour word, width and Straight switch. Absent
      // Straight means on, for the reason snapShapes below gives.
      hlPen: normalizeInkToken(parsed?.hlPen, "highlighter"),
      hlWidth: normalizeInkHlWidth(parsed?.hlWidth),
      hlStraight: parsed?.hlStraight !== false,
      eraseTarget: normalizeInkEraseTarget(parsed?.eraseTarget),
      // Absent means on — see setInkTapDots.
      tapDots: parsed?.tapDots !== false,
      recentColors: normalizeRecentColors(parsed?.recentColors),
      // The eraser's own two settings are remembered outright, unlike the tool
      // above, and the difference is deliberate: arming the eraser is something
      // the reader does per use, but how big it is and whether it takes part of
      // a stroke are how they like the eraser to work — asking again every
      // session is the friction this file exists to avoid.
      eraserSize: normalizeInkEraserSize(parsed?.eraserSize),
      eraseMode: normalizeInkEraseMode(parsed?.eraseMode),
      // Absent means on. The offer is the feature; this is the way out of it,
      // and a build that has never written the key must not read as "refused".
      snapShapes: parsed?.snapShapes !== false
    };
  } catch (_) {
    return {
      pen: INK_PEN_DEFAULT,
      width: INK_WIDTH_DEFAULT,
      tool: INK_TOOL_DEFAULT,
      hlPen: INK_HL_TOKEN_DEFAULT,
      hlWidth: INK_HL_WIDTH_DEFAULT,
      hlStraight: true,
      eraseTarget: INK_ERASE_TARGET_DEFAULT,
      tapDots: true,
      recentColors: [],
      eraserSize: INK_ERASER_SIZE_DEFAULT,
      eraseMode: INK_ERASE_MODE_DEFAULT,
      snapShapes: true
    };
  }
}

// A PATCH, not a record. Only what the caller names is written; everything it
// leaves out keeps whatever was stored. It was a record — every key normalised
// and written whether it was passed or not — and the drawing sheet passes three
// of the six, so pressing a swatch on the sheet quietly reset the eraser's size,
// its part/whole mode and the shape-snapper to their defaults on the paper too.
export function writeInkPreferences(patch = {}) {
  try {
    // Merged rather than assigned: railOpen lives in the same bag and a bare
    // write here would forget which surfaces the reader had shut the rail on.
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    const next = { ...parsed };
    const {
      pen, width, tool, eraserSize, eraseMode, snapShapes,
      hlPen, hlWidth, hlStraight, eraseTarget, tapDots, recentColors
    } = patch || {};
    if (pen !== undefined) next.pen = normalizeInkToken(pen, "pen");
    if (width !== undefined) next.width = normalizeInkWidth(width);
    if (tool !== undefined) next.tool = normalizeInkTool(tool);
    if (hlPen !== undefined) next.hlPen = normalizeInkToken(hlPen, "highlighter");
    if (hlWidth !== undefined) next.hlWidth = normalizeInkHlWidth(hlWidth);
    if (hlStraight !== undefined) next.hlStraight = hlStraight !== false;
    if (eraseTarget !== undefined) next.eraseTarget = normalizeInkEraseTarget(eraseTarget);
    if (tapDots !== undefined) next.tapDots = tapDots !== false;
    if (recentColors !== undefined) next.recentColors = normalizeRecentColors(recentColors);
    if (eraserSize !== undefined) next.eraserSize = normalizeInkEraserSize(eraserSize);
    if (eraseMode !== undefined) next.eraseMode = normalizeInkEraseMode(eraseMode);
    if (snapShapes !== undefined) next.snapShapes = snapShapes !== false;
    localStorage.setItem(inkPreferencesKey, JSON.stringify(next));
  } catch (error) {
    // Quota or a private window. Losing the preference costs the reader one
    // press next time, never a stroke.
    console.warn("Could not remember the pen", error);
  }
}

// A colour of the reader's own, put at the front of the recent row — moved
// there if it was already in it, and the oldest dropped off the end.
export function rememberInkRecentColor(hex) {
  const value = normalizeInkHex(hex);
  if (!value) return inkPreferences().recentColors;
  const next = [value, ...inkPreferences().recentColors.filter((entry) => entry !== value)];
  writeInkPreferences({ recentColors: next });
  return normalizeRecentColors(next);
}

// ── ...and which paper, which is the same kind of fact ────────────────────
//
// Grid, ruled or blank is a choice about how somebody writes — the same kind of
// statement as the colour and the nib above, and remembered for the same reason.
// It was not: every notebook was made on the default grid, so a reader who works
// on ruled paper chose it again on every deck they ever started, and the choice
// they had just made on the last one counted for nothing. That is the whole of
// "remember the page style too".
//
// Per device rather than in the deck's meta bag, exactly like the pen: the
// notebook itself records the paper it is DRAWN on (meta.notebook.paper, which
// syncs and must, or the same notebook would be ruled on one device and squared
// on another). This is only the default a NEW one starts from, and a phone and a
// laptop are allowed to disagree about that.
//
// Changing an existing notebook's paper writes here too — see
// runHandwritingMenuAction. Choosing ruled on the notebook in front of you is
// the clearest statement anybody can make about which paper they want, and
// treating it as a fact about that one notebook is how the preference would go
// on never learning anything.
export function notebookPaperPreference() {
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = raw ? JSON.parse(raw) : null;
    // Absent means the default, not an invalid value — normalizeBlankPaper
    // already answers both the same way, which is what makes a build with a
    // fourth paper safe to read a record written by this one.
    return normalizeBlankPaper(parsed?.notebookPaper);
  } catch (_) {
    return BLANK_PAPER_DEFAULT;
  }
}

export function writeNotebookPaperPreference(kind) {
  try {
    // Merged, like every other writer here: the pen, the rail and this share one
    // bag and a bare write would forget the other two.
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    localStorage.setItem(inkPreferencesKey, JSON.stringify({
      ...parsed,
      notebookPaper: normalizeBlankPaper(kind)
    }));
  } catch (error) {
    console.warn("Could not remember the paper", error);
  }
}

// ── ...and how the last block was styled ───────────────────────────────────
//
// The same argument as the pen's colour, one surface over: styling a block
// yellow, 18pt and centred and then having to say all three again for the next
// one is exactly the friction that stops people using the controls at all. So
// the last bag a reader chose is remembered, and a new block starts from it.
//
// PER KIND, which is the one thing that is not obvious. A picture is styled with
// two of the ten keys and a paragraph with all of them, and handing a photograph
// the yellow fill of the last caption written would be the preference confidently
// answering a question nobody asked. Two bags, one each.
//
// Normalised on the way out through normalizeBlockStyle for the reason the pen's
// values go through theirs: a bag written by a build whose defaults have moved
// becomes one of THIS build's, rather than a set of values no control is ever
// shown as holding.
export function blockStylePreference(kind) {
  const slot = kind === "image" ? "image" : "text";
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return normalizeBlockStyle(parsed?.blockStyle?.[slot]);
  } catch (_) {
    return normalizeBlockStyle(null);
  }
}

export function writeBlockStylePreference(kind, style) {
  const slot = kind === "image" ? "image" : "text";
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    const blockStyle = (parsed.blockStyle && typeof parsed.blockStyle === "object") ? parsed.blockStyle : {};
    blockStyle[slot] = normalizeBlockStyle(style);
    localStorage.setItem(inkPreferencesKey, JSON.stringify({ ...parsed, blockStyle }));
  } catch (error) {
    console.warn("Could not remember the block style", error);
  }
}

// ── ...and how the panel itself was left ───────────────────────────────────
//
// Which of Fill/Text the one swatch row was showing, and whether More was open.
// Not part of the style bag above and deliberately not on the block: it is a
// fact about how this reader works, not about any block, and it would be a
// strange thing to sync to their other device mid-sentence.
const BLOCK_PANEL_DEFAULT = { swatch: "fill", more: false };

export function blockPanelPreference() {
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = raw ? JSON.parse(raw) : null;
    const stored = parsed?.blockPanel;
    return {
      swatch: stored?.swatch === "ink" ? "ink" : BLOCK_PANEL_DEFAULT.swatch,
      more: typeof stored?.more === "boolean" ? stored.more : BLOCK_PANEL_DEFAULT.more
    };
  } catch (_) {
    return { ...BLOCK_PANEL_DEFAULT };
  }
}

export function writeBlockPanelPreference(next) {
  try {
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    localStorage.setItem(inkPreferencesKey, JSON.stringify({
      ...parsed,
      blockPanel: { ...blockPanelPreference(), ...next }
    }));
  } catch (error) {
    console.warn("Could not remember the style panel", error);
  }
}

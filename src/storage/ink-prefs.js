// Which pen you last wrote with, on this device.
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

import { INK_ERASER_SIZE_DEFAULT, INK_ERASE_MODE_DEFAULT, INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkEraseMode, normalizeInkEraserSize, normalizeInkPen, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";
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
      pen: normalizeInkPen(parsed?.pen),
      width: normalizeInkWidth(parsed?.width),
      // The tool is remembered too, but never as the eraser or the lasso: a
      // session that opens with the eraser selected is one where the first
      // stroke of the day silently deletes something.
      tool: parsed?.tool === "pen" ? "pen" : INK_TOOL_DEFAULT,
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
      eraserSize: INK_ERASER_SIZE_DEFAULT,
      eraseMode: INK_ERASE_MODE_DEFAULT,
      snapShapes: true
    };
  }
}

export function writeInkPreferences({ pen, width, tool, eraserSize, eraseMode, snapShapes } = {}) {
  try {
    // Merged rather than assigned: railOpen lives in the same bag and a bare
    // write here would forget which surfaces the reader had shut the rail on.
    const raw = localStorage.getItem(inkPreferencesKey);
    const parsed = (raw ? JSON.parse(raw) : null) || {};
    localStorage.setItem(inkPreferencesKey, JSON.stringify({
      ...parsed,
      pen: normalizeInkPen(pen),
      width: normalizeInkWidth(width),
      tool: normalizeInkTool(tool),
      eraserSize: normalizeInkEraserSize(eraserSize),
      eraseMode: normalizeInkEraseMode(eraseMode),
      snapShapes: snapShapes !== false
    }));
  } catch (error) {
    // Quota or a private window. Losing the preference costs the reader one
    // press next time, never a stroke.
    console.warn("Could not remember the pen", error);
  }
}

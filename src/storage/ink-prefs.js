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

import { INK_PEN_DEFAULT, INK_TOOL_DEFAULT, INK_WIDTH_DEFAULT, normalizeInkPen, normalizeInkTool, normalizeInkWidth } from "../format/ink-colors.js?v=__BUILD__";
import { inkPreferencesKey } from "./keys.js?v=__BUILD__";

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
      tool: parsed?.tool === "pen" ? "pen" : INK_TOOL_DEFAULT
    };
  } catch (_) {
    return { pen: INK_PEN_DEFAULT, width: INK_WIDTH_DEFAULT, tool: INK_TOOL_DEFAULT };
  }
}

export function writeInkPreferences({ pen, width, tool } = {}) {
  try {
    localStorage.setItem(inkPreferencesKey, JSON.stringify({
      pen: normalizeInkPen(pen),
      width: normalizeInkWidth(width),
      tool: normalizeInkTool(tool)
    }));
  } catch (error) {
    // Quota or a private window. Losing the preference costs the reader one
    // press next time, never a stroke.
    console.warn("Could not remember the pen", error);
  }
}

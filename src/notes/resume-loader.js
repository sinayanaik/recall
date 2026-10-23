// What a reopening note shows while it finds the reader's place.
//
// A file's Notes reopen where the reader left off (scheduleNoteJump in
// src/notes/anchors.js), and on a big book that waits for the render: up to
// NOTE_RESUME_HIDE_MS with the note kept out of sight, so it does not show its
// contents page and then jump. Out of sight was a blank screen, and the report
// was exactly that — "when I am opening last note I am seeing blank".
//
// So the wait is shown instead of hidden. Over the note, while it is out of
// sight: a little page of lines that keeps scrolling, a track with the place
// marked on it and a bar travelling there, the section the reader is being
// taken back to ("Taking you back to 14.3 Methods"), and a way out — Start from
// the top. It goes the moment the resume lands, gives up or is cancelled.
//
// Everything that moves is a transform keyframe in styles/85-resume.css, so it
// runs on the compositor while the main thread is busy rendering the book — a
// loader that needed the main thread to animate would freeze exactly when it
// is on screen. It lives in #notesStage, not #notesView: the resume measures
// the note's blocks, and nothing of this may be among them.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { readerNotesBody } from "../format/notes-fence.js?v=__BUILD__";
import { sectionHeadingIndexFor, sectionIndexForOffset } from "./chapters.js?v=__BUILD__";
import { numberedHeadingLabel } from "./heading-numbers.js?v=__BUILD__";

export const RESUME_LOADER_CLASS = "notes-resume-loader";

// Long enough for the fade in styles/85-resume.css.
const RESUME_LOADER_FADE_MS = 200;

let resumeLoader = null;
let removeTimer = 0;

// "14.3 Methods" for the section `offset` falls in, numbered the way the note
// draws it, or "" before the first heading. The index is memoized per source
// string and the highlight lists build the same one, so this is a lookup on
// any note whose highlights have been listed.
export function resumeSectionLabel(offset) {
  if (!Number.isFinite(offset)) return "";
  const headings = sectionHeadingIndexFor(readerNotesBody(state.notes || ""));
  const at = sectionIndexForOffset(headings, offset);
  return at >= 0 ? numberedHeadingLabel(headings[at]) : "";
}

function buildResumeLoader() {
  const root = document.createElement("div");
  root.className = RESUME_LOADER_CLASS;
  root.setAttribute("role", "status");
  root.innerHTML =
    '<div class="notes-resume-card">'
    + '<div class="notes-resume-page" aria-hidden="true"><div class="notes-resume-lines"></div></div>'
    + '<div class="notes-resume-text">'
    + '<span class="notes-resume-kicker">Taking you back to</span>'
    + '<strong class="notes-resume-where"></strong>'
    + "</div>"
    + '<div class="notes-resume-track" aria-hidden="true">'
    + '<span class="notes-resume-fill"></span><span class="notes-resume-marker"></span>'
    + "</div>"
    + '<span class="notes-resume-through"></span>'
    + '<button type="button" class="notes-resume-top">Start from the top</button>'
    + "</div>";
  return root;
}

// `offset` is the raw offset being resumed to; `onStartFromTop` ends the resume
// (anchors.js owns that) — this only puts the note back at the top afterwards.
export function showResumeLoader({ offset = null, onStartFromTop = null } = {}) {
  const stage = el.notesStage;
  if (!stage) return;
  clearTimeout(removeTimer);
  removeTimer = 0;
  if (!resumeLoader || !resumeLoader.isConnected) {
    resumeLoader = buildResumeLoader();
    stage.appendChild(resumeLoader);
  }
  resumeLoader.classList.remove("is-leaving");
  const length = (state.notes || "").length;
  const fraction = Number.isFinite(offset) && length > 0 ? Math.min(1, Math.max(0, offset / length)) : 0;
  resumeLoader.style.setProperty("--resume-at", fraction.toFixed(3));
  const label = resumeSectionLabel(offset);
  resumeLoader.querySelector(".notes-resume-where").textContent = label || "where you left off";
  const percent = Math.round(fraction * 100);
  resumeLoader.querySelector(".notes-resume-through").textContent = percent > 0 ? `${percent}% through` : "";
  resumeLoader.setAttribute("aria-label", `Taking you back to ${label || "where you left off"}`);
  const top = resumeLoader.querySelector(".notes-resume-top");
  top.onclick = () => {
    onStartFromTop?.();
    if (el.notesView) el.notesView.scrollTop = 0;
    hideResumeLoader();
  };
}

export function hideResumeLoader() {
  if (!resumeLoader?.isConnected || resumeLoader.classList.contains("is-leaving")) return;
  const leaving = resumeLoader;
  leaving.classList.add("is-leaving");
  clearTimeout(removeTimer);
  removeTimer = setTimeout(() => {
    removeTimer = 0;
    leaving.remove();
    if (resumeLoader === leaving) resumeLoader = null;
  }, RESUME_LOADER_FADE_MS);
}

export function isResumeLoaderShown() {
  return Boolean(resumeLoader?.isConnected && !resumeLoader.classList.contains("is-leaving"));
}

// Reading a passage out loud.
//
// The one verb here that needs no network, no key, no vendored library and no
// service in the middle: speechSynthesis has been in every browser this app
// supports for a decade, and it is exactly the thing a reader wants for the
// sentence they cannot parse on the fourth attempt at midnight.
//
// ── Why it is a module rather than a closure ───────────────────────────────
//
// Because "is something being read right now" is one fact, and two places ask
// it: the row that starts the speech has to say "Stop reading" while it is
// running, and everything that dismisses the surface the row is on has to stop
// it. A closure in the mark menu would have made the pill's copy of this a
// second answer to the same question.
//
// A leaf: it imports one thing (the toast), so any surface can reach it without
// a cycle to think about.

import { showToast } from "./feedback.js?v=__BUILD__";

// Long passages, spoken. Chrome stops mid-utterance somewhere north of ~32k
// characters and gives no error for it, and nobody presses "read aloud" on
// half a book anyway.
export const SPEECH_MAX_CHARS = 8000;

// Nothing is speaking, and nothing can. Both callers below check this before
// offering the verb at all, so a browser without it shows no row rather than a
// row that apologises.
export function canSpeak() {
  return typeof window !== "undefined" && Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === "function";
}

let speaking = false;

export function isSpeaking() {
  return speaking && Boolean(window.speechSynthesis?.speaking);
}

export function stopSpeaking() {
  speaking = false;
  try { window.speechSynthesis?.cancel(); } catch (_) { /* nothing to cancel */ }
}

// Speak `text`, replacing whatever was being read. One utterance at a time and
// deliberately so: tapping a second highlight means "read this one instead",
// and speechSynthesis's own default is a QUEUE — without the cancel, the second
// passage would wait out the first, which reads as the button having done
// nothing at all.
//
// Returns whether it started, so a caller can leave its label alone when it
// did not.
export function speakText(text) {
  if (!canSpeak()) return false;
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  // A second press on the thing already being read is "stop", not "start
  // again". The caller does not have to know which press this is.
  if (isSpeaking()) {
    stopSpeaking();
    return false;
  }
  stopSpeaking();
  try {
    const utterance = new window.SpeechSynthesisUtterance(value.slice(0, SPEECH_MAX_CHARS));
    // Both ends of the utterance clear the flag, so a passage that finishes on
    // its own leaves the same state a stop does. Without the `onend` the next
    // press would read as "stop" and do nothing audible.
    utterance.onend = () => { speaking = false; };
    utterance.onerror = () => { speaking = false; };
    speaking = true;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch (error) {
    speaking = false;
    console.warn("Could not read that aloud", error);
    showToast("Couldn't read that aloud on this device.", "error");
    return false;
  }
}

// Leaving the page mid-sentence must not leave a voice running: speechSynthesis
// belongs to the browser, not to the document, and in Chrome an utterance
// outlives a navigation away from the page that started it.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stopSpeaking);
  // Escape is the app's universal "stop that", and the surface that STARTED the
  // speech is gone by the time it is running — the mark menu closes on the same
  // press that begins it. So the listener is here, where the fact lives, rather
  // than in whichever menu happened to be open.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSpeaking()) stopSpeaking();
  });
}

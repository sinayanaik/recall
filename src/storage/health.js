// Can this browser actually keep anything?
//
// Every "Signed out — sign in again" this app shows assumes the session COULD
// have been stored and simply wasn't. That assumption is load-bearing and it is
// sometimes wrong. initSupabaseClient sets `persistSession: true` and
// supabase-js's store is localStorage, so a browser that refuses a write does
// not sign the reader out once with a reason — it signs them out again on every
// load, in silence, and typing the correct password changes nothing. A private
// window, a "block site data" setting, a profile with cookies disabled for the
// origin, and a full quota all present exactly that way.
//
// Told apart by PROBING rather than assuming, because reading keeps working in
// several of the cases where writing does not: the decks load, the library
// renders, everything looks healthy, and only the sign-in never sticks.
//
// A leaf module on purpose. The sync layer, the boot path and the App Info
// panel all need this answer and none of them may import each other.

export const STORAGE_PROBE_KEY = "recall:storage-probe";

// Quota and refusal need different words: one is "make room", the other is "let
// this site store things". Telling a reader whose disk is fine to clear space is
// how a diagnosis becomes another dead end.
export function describeStorageFailure(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  if (name === "QuotaExceededError" || /quota/i.test(message)) {
    return "This device is out of storage room for this site.";
  }
  if (name === "SecurityError" || /denied|access is denied|not allowed/i.test(message)) {
    return "This browser is blocking site data for Recall — check its cookie or site-data settings, and whether this is a private window.";
  }
  return message || "The browser refused the write without saying why.";
}

// Writes, reads back, and removes. All three, because the failure this exists
// for is not always an exception: a browser can accept `setItem` and hand back
// something else — or nothing — on the next read, which is a storage that
// "works" right up until the moment something depends on it persisting.
export function probeLocalStorage() {
  try {
    const token = `probe-${Date.now()}`;
    localStorage.setItem(STORAGE_PROBE_KEY, token);
    const readBack = localStorage.getItem(STORAGE_PROBE_KEY);
    localStorage.removeItem(STORAGE_PROBE_KEY);
    if (readBack !== token) {
      return {
        writable: false,
        reason: "This browser accepted the write and then gave back something else, so nothing can be relied on to persist."
      };
    }
    return { writable: true, reason: "" };
  } catch (error) {
    return { writable: false, reason: describeStorageFailure(error) };
  }
}

// What to actually SAY when the app finds itself without a session.
//
// "Sign in again to resume syncing" is the right sentence exactly once: when
// signing in again would help. On a device whose storage is refusing writes it
// is an instruction that cannot be carried out, offered over and over, which is
// the difference between an app that has a problem and an app that appears to
// be broken. The kind is different too, so the once-per-problem gate in
// reportBackgroundSyncProblem treats it as its own condition rather than a
// repeat of the ordinary lapse.
export function describeSignedOutProblem() {
  const probe = probeLocalStorage();
  if (probe.writable) {
    return {
      kind: "signed-out",
      message: "Signed out — sign in again to resume syncing. Your decks are safe on this device."
    };
  }
  return {
    kind: "storage-blocked",
    message: `Recall can't save your sign-in on this browser, so it can't stay signed in. ${probe.reason} Your decks are safe on this device.`
  };
}

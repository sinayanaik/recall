// Online/offline state, and syncing again after the app has been in the
// background long enough for the cloud to have moved on.
//
// Grouped here rather than left beside the editor, where source order in the
// original file had happened to put it.

// How long the app has to have been in the background before returning to it is
// worth a sync. Short enough that picking the phone back up gets fresh data;
// long enough that flicking between apps doesn't fire one every few seconds.
export const FOREGROUND_SYNC_IDLE_MS = 60000;

export let lastHiddenAt = 0;

// Setter: an imported binding is read-only, and the visibility listener in main.js records when the app was hidden.
export function setLastHiddenAt(value) {
  lastHiddenAt = value;
}

// Surface connectivity so it's obvious cloud actions are paused while offline.
export function updateOnlineIndicator() {
  const indicator = document.getElementById("offlineIndicator");
  if (indicator) indicator.hidden = navigator.onLine;
}

export let onlineReconcileTimer = null;

// Setter: an imported binding is read-only, and the online listener in main.js schedules the catch-up sync.
export function setOnlineReconcileTimer(value) {
  onlineReconcileTimer = value;
}

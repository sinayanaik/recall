// The style panel, and syncing its settings to the user's project.
//
// Style settings are per user, keyed by auth uid. The table predates auth and
// once held a single shared 'global' row, which meant whoever synced last
// overwrote everyone else — that row is still READ so an account that has never
// synced inherits it, but it is no longer written.

import { CLOUD_TIMEOUT_MS, withTimeout } from "./net.js?v=__BUILD__";
import { supabaseClient } from "./supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { cachedUserId } from "../quick-notes/categories.js?v=__BUILD__";
import { setStatus } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";
import { applyActiveStyleSettings, detectStyleProfile, hasMeaningfulStyleSettings, setStyleProfileSettings, setStyleProfiles, setStyleStatus, styleProfileLabel, styleProfilesPayload, styleSettingsFromControls, updateStyleControls, updateStyleProfileUi } from "../ui/style-settings.js?v=__BUILD__";
import { styleProfiles } from "../ui/style-tokens.js?v=__BUILD__";
import { setTheme } from "../ui/theme.js?v=__BUILD__";

export function openStylePanel() {
  lockPageScroll();
  state.styleEditProfile = detectStyleProfile();
  state.styleEditProfileFollowsDevice = true;
  el.stylePanel.hidden = false;
  updateStyleControls();
}

export function closeStylePanel() {
  el.stylePanel.hidden = true;
  unlockPageScroll();
}

export function switchStyleEditProfile(profile, options = {}) {
  if (!styleProfiles.includes(profile)) return;
  state.styleEditProfile = profile;
  state.styleEditProfileFollowsDevice = options.followDevice ?? false;
  updateStyleControls();
  setStyleStatus(`Editing ${styleProfileLabel(profile).toLowerCase()} style`);
}

export function handleStyleEnvironmentChange() {
  const previousProfile = state.activeStyleProfile;
  applyActiveStyleSettings({ force: true });
  if (!el.stylePanel?.hidden && (state.styleEditProfileFollowsDevice || state.styleEditProfile === previousProfile)) {
    switchStyleEditProfile(detectStyleProfile(), { followDevice: true });
  } else {
    updateStyleProfileUi();
  }
}

// Which app_style_settings row belongs to this user. The table predates auth and
// held ONE row, id "global", that every account on a deployment read and wrote —
// so a second user signing in silently overwrote the first's fonts/sizes/layout.
// Styles are now per-account, keyed on the user id, with "global" kept as a
// read-only legacy fallback so an existing deployment's shared style is still
// what a user sees until they save their own. Signed out (no cached id) there's
// nothing to scope to, so the legacy row is all there is.
export const LEGACY_STYLE_ROW_ID = "global";

export function styleSettingsRowId() {
  return cachedUserId() || LEGACY_STYLE_ROW_ID;
}

export async function loadStyleFromWeb(force = false) {
  if (!supabaseClient) {
    setStyleStatus("Local style");
    return;
  }

  setStyleStatus("Loading synced style...");
  try {
    const rowId = styleSettingsRowId();
    // Both rows in one request; this user's own wins, the legacy shared row is
    // the fallback for an account that has never synced a style of its own.
    const wanted = rowId === LEGACY_STYLE_ROW_ID ? [LEGACY_STYLE_ROW_ID] : [rowId, LEGACY_STYLE_ROW_ID];
    const { data: rows, error } = await supabaseClient
      .from("app_style_settings")
      .select("id, settings, updated_at")
      .in("id", wanted);

    if (error) throw error;
    const data = (rows || []).find((row) => row.id === rowId)
      || (rows || []).find((row) => row.id === LEGACY_STYLE_ROW_ID)
      || null;
    if (!hasMeaningfulStyleSettings(data?.settings)) {
      setStyleStatus("No synced style yet");
      return;
    }
    if (state.styleTouched && !force) {
      setStyleStatus("Unsynced local style");
      return;
    }

    setStyleProfiles(data.settings);
    // Pre-theme-sync rows have no `theme` key at all; leaving this device's
    // theme alone is the right answer there, so only act when one is present.
    if (data.settings.theme) setTheme(data.settings.theme);
    applyActiveStyleSettings({ force: true });
    state.styleTouched = false;
    updateStyleControls();
    setStyleStatus(data.updated_at ? `Loaded ${new Date(data.updated_at).toLocaleString()}` : "Loaded synced style");
  } catch (error) {
    console.warn("Could not load synced style", error);
    setStyleStatus(
      error?.code === "42501"
        ? "Style sync blocked — check app_style_settings RLS policy"
        : "Style sync table not ready"
    );
  }
}

// A style upload that couldn't reach the cloud, held until the next reconcile.
// Without this, tapping "Sync style" offline was a flat "Failed to sync style.
// Create the app_style_settings table first." — a wrong diagnosis and a dead
// end, when the settings were sitting perfectly safe on the device.
export const PENDING_STYLE_KEY = "recall:pendingStyleSync";

export function queuePendingStyleSync(settings) {
  try {
    localStorage.setItem(PENDING_STYLE_KEY, JSON.stringify({ settings, savedAt: new Date().toISOString() }));
  } catch (_) { /* storage full — the style is still applied locally */ }
}

export function clearPendingStyleSync() {
  try { localStorage.removeItem(PENDING_STYLE_KEY); } catch (_) {}
}

// The cloud write, shared by the button and the reconcile replay. Returns
// "synced" | "offline" | "failed" rather than throwing, so both callers can say
// something accurate about where the style ended up.
export async function writeStyleToCloud(settings) {
  if (!supabaseClient || !navigator.onLine) return "offline";
  try {
    const { error } = await withTimeout(
      supabaseClient.from("app_style_settings").upsert({
        // This user's own row (see styleSettingsRowId) — never the legacy
        // shared "global" one, which writing would push onto every other
        // account on the deployment.
        id: styleSettingsRowId(),
        settings,
        updated_at: new Date().toISOString()
      }, { onConflict: "id" }),
      CLOUD_TIMEOUT_MS,
      "sync style"
    );
    if (error) throw error;
    return "synced";
  } catch (error) {
    console.warn("Failed to sync style", error);
    // A dropped connection is not a missing table — telling the user to go
    // create one is what made this failure so misleading.
    if (/failed to fetch|networkerror|load failed/i.test(error?.message || "")) return "offline";
    return error?.code === "42501" ? "denied" : "failed";
  }
}

// Deliver a style upload queued while offline. Called from reconcileAllDecks.
export async function flushPendingStyleSync() {
  let pending;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_STYLE_KEY) || "null");
  } catch {
    pending = null;
  }
  if (!pending?.settings) return false;
  const outcome = await writeStyleToCloud(pending.settings);
  // "denied" is an RLS misconfiguration — permanent for this project, so
  // replaying it on every sync forever would accomplish nothing.
  if (outcome === "synced" || outcome === "denied") clearPendingStyleSync();
  return outcome === "synced";
}

export async function syncStyleToWeb() {
  if (!supabaseClient) {
    setStyleStatus("Supabase unavailable");
    setStatus("Supabase is not available for style sync.", "error");
    return;
  }

  const syncBtn = el.syncUpBtn;
  state.styleTouched = true;
  const editProfile = styleProfiles.includes(state.styleEditProfile) ? state.styleEditProfile : detectStyleProfile();
  setStyleProfileSettings(editProfile, styleSettingsFromControls());
  if (editProfile === detectStyleProfile()) applyActiveStyleSettings({ force: true });
  const settings = styleProfilesPayload();
  syncBtn.disabled = true;
  setStyleStatus("Syncing style...");
  const outcome = await writeStyleToCloud(settings);
  syncBtn.disabled = false;

  if (outcome === "synced") {
    clearPendingStyleSync();
    state.styleTouched = false;
    setStyleStatus("Style synced");
    setStatus("Style synced to web.");
    return;
  }
  if (outcome === "offline") {
    queuePendingStyleSync(settings);
    setStyleStatus("Style saved — syncs when online");
    setStatus("Offline — your style is saved on this device and will sync automatically.");
    return;
  }
  setStyleStatus("Sync failed");
  setStatus(
    outcome === "denied"
      ? "Failed to sync style — the app_style_settings RLS policy doesn't allow your own row. Re-run supabase_setup.sql in Supabase."
      : "Failed to sync style. Create the app_style_settings table first.",
    "error"
  );
}

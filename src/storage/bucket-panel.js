// The Cloud bucket panel: the reader's own S3-compatible bucket, on its own.
//
// ── Why this is not a card in Storage & Data any more ──────────────────────
//
// It was, and it shared that panel's one busy flag with the image census — a
// recursive listing of every figure in Supabase followed by a scan of every
// deck and card, which starts the moment the panel opens and can run for a
// long time on a large library. While it ran, every button on the panel,
// "Move them to the bucket" included, returned without doing anything and
// without saying so. Pressing it again did nothing again. That, and a move
// that could not tell it had already moved a paper (see document-migration.js),
// is how "Papers still elsewhere" sat unchanged however often it was pressed.
//
// So the bucket has a panel, a report and a busy state of its own. Nothing here
// reads the census or waits for it, and the census never waits for this. The
// one thing the two share is the image lock in image-storage.js: neither may
// CHANGE figures while the other is — but that is said to the reader, never
// swallowed.
//
// ── What is here ──────────────────────────────────────────────────────────
//
//   • the keys: the form, Save and test, the CORS policy, Forget
//   • papers: how many are in the bucket, which are waiting to go up
//   • papers still elsewhere: the move out of Google Drive and Supabase, and
//     what happened to each paper the last time it ran
//   • images: how many are in the bucket, the copy out of Supabase, and —
//     separately, and only when asked — removing the Supabase copies

import { cachedUserId } from "../quick-notes/categories.js?v=__BUILD__";
import { S3_DEFAULT_REGION, canReachS3, canSignS3Requests, clearS3Config, isS3Configured, loadS3Config, markS3ConfigVerified, readS3ConfigRecord, s3CorsPolicy, saveS3Config } from "../cloud/s3-config.js?v=__BUILD__";
import { pushS3ConfigNow, s3ConfigSyncStatus } from "../cloud/s3-config-sync.js?v=__BUILD__";
import { S3_PREFIX, listS3Objects, testS3Connection } from "../cloud/s3-files.js?v=__BUILD__";
import { listS3Images, refreshS3ImageIndex } from "../cloud/s3-images.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml, formatStorageBytes } from "../core/text.js?v=__BUILD__";
import { countBackfillOnDevice, documentBackfillStatus, migrateDocumentsToS3, migrationSummary, planDocumentBackfill, planDocumentMigration, rememberMigrationSummary, scheduleDocumentBackfill } from "./document-migration.js?v=__BUILD__";
import { claimImageStorage, copyImagesToS3, imageStorageBusyLabel, releaseImageStorage, removeSupabaseImageCopies, surveyImageStorage } from "./image-storage.js?v=__BUILD__";
import { confirmByTyping, storageStatTile } from "./storage-panel.js?v=__BUILD__";
import { showConfirmModal, showPromptModal, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";

export let bucketReport = null;

// What the panel is DOING — a move, a copy, a test — as a sentence, or "".
// Distinct from reading the report: a refresh never blocks a button.
export let bucketWork = "";

let bucketProgress = "";

let bucketReading = null;

// The last look at the figures on both sides (image-storage.js), or null until
// the reader asks. It is a listing of every figure in Supabase, so it is never
// taken just because the panel opened.
let imageSurvey = null;

let imageSurveyError = "";

let lastImageCopy = null;

// Set by main.js: an ordinary sync, run to completion (syncAllDecksAndWait in
// sync/reconcile.js). Passed in rather than imported so this module does not
// pull the whole sync in, and so the move can be driven without one.
let bucketSyncRunner = null;

export function setBucketSyncRunner(fn) {
  bucketSyncRunner = typeof fn === "function" ? fn : null;
}

export function openBucketPanel() {
  if (!el.bucketPanel) return;
  lockPageScroll();
  el.bucketPanel.hidden = false;
  renderBucketPanel();
  refreshBucketReport();
}

export function closeBucketPanel() {
  if (!el.bucketPanel) return;
  el.bucketPanel.hidden = true;
  unlockPageScroll();
}

export function bucketPanelOpen() {
  return Boolean(el.bucketPanel && !el.bucketPanel.hidden);
}

// ── The report ──────────────────────────────────────────────────────────────

// Everything here is cheap: one LIST of the papers, one of the figures, and a
// read of this device's own deck snapshots. No Supabase table is touched and no
// Supabase figure is listed.
export async function buildBucketReport() {
  const report = {
    at: new Date(),
    online: navigator.onLine,
    signedIn: Boolean(supabaseClient && isSignedIn),
    s3: null,
    s3Error: "",
    images: null,
    migration: [],
    backfill: { here: 0, elsewhere: 0, unknown: 0 }
  };
  if (canReachS3() && navigator.onLine) {
    // Read in full or not at all: a listing that failed used to read as "0
    // papers", which is a claim, and the wrong one.
    try {
      const papers = await listS3Objects(`${S3_PREFIX}/`, { strict: true });
      if (papers) report.s3 = { count: papers.length, bytes: papers.reduce((sum, file) => sum + (Number(file.size) || 0), 0) };
      else report.s3Error = "Could not read the bucket just now — check the connection, and that the CORS policy is in place.";
    } catch (error) {
      report.s3Error = error?.message || "Could not read the bucket.";
    }
    try {
      const images = await listS3Images({ strict: true });
      report.images = images
        ? { count: images.length, bytes: images.reduce((sum, image) => sum + (Number(image.size) || 0), 0) }
        : null;
      refreshS3ImageIndex({ force: true });
    } catch (error) {
      console.warn("Could not count the images in the bucket", error);
    }
  }
  try {
    report.migration = await planDocumentMigration();
  } catch (error) {
    console.warn("Could not plan the document migration", error);
  }
  try {
    // Papers still in Drive or the old Supabase bucket are counted by the card
    // below, and can already be read from there; these are the ones that are
    // in NO cloud, which is what "only on one device" means.
    const unsent = (await planDocumentBackfill()).filter((job) => !job.legacy);
    report.backfill = await countBackfillOnDevice(unsent);
  } catch (error) {
    console.warn("Could not count the papers waiting to upload", error);
  }
  return report;
}

// Re-reads the report. Concurrent callers share one read. A report already on
// screen stays on screen while the next one is read.
export function refreshBucketReport() {
  if (bucketReading) return bucketReading;
  bucketReading = (async () => {
    try {
      bucketReport = await buildBucketReport();
    } catch (error) {
      console.error("Bucket report failed", error);
      if (!bucketReport) showToast(`Could not read the bucket: ${error?.message || "unknown error"}`, "error");
    } finally {
      bucketReading = null;
    }
    renderBucketPanel();
  })();
  renderBucketPanel();
  return bucketReading;
}

// ── Rendering ───────────────────────────────────────────────────────────────

// One sentence on whether the bucket keys have reached the account. Nothing at
// all when there are no keys anywhere to talk about.
export function bucketKeysSyncLine(report) {
  const record = readS3ConfigRecord();
  const sync = s3ConfigSyncStatus();
  if (!record.config && sync.state !== "unavailable") return "";
  const note = (text, warn = false) => `<p class="storage-note${warn ? " is-warning" : ""}">${text}</p>`;
  if (record.config && record.verified === false) {
    return note("These keys have not passed <strong>Save and test</strong> yet, so they stay on this device and are not sent to your other devices.", true);
  }
  if (!report?.signedIn) return note("The keys are on this device only until you sign in — then every device on your account gets them.");
  switch (sync.state) {
    case "synced":
      return note("Keys synced to your account — every device you sign in on can open these papers and images.");
    case "unavailable":
      return note("The keys are on this device only: your Supabase project has no <code>app_storage_settings</code> table yet. Re-run <code>supabase_setup.sql</code> and they sync to your other devices.", true);
    case "offline":
      return note("The keys sync to your other devices when you are back online.");
    case "failed":
      return note(`The keys could not be synced to your account${sync.detail ? ` — ${escapeHtml(sync.detail)}` : ""}. They are still used on this device.`, true);
    default:
      return note("The keys sync to your account at the next sync.");
  }
}

// A backfill run's stop reason, in the reader's terms. The raw tokens are what
// the upload path throws; a CORS or refusal message is already a sentence.
export function describeBackfillStop(reason) {
  if (reason === "NO_STORAGE") return "the bucket is not set up on this device.";
  if (reason === "OFFLINE") return "this device went offline.";
  return reason;
}

const MIGRATION_RESULT_PREVIEW = 12;

function migrationResultsHtml(summary) {
  if (!summary?.results?.length) return "";
  const when = new Date(summary.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const left = summary.results.filter((row) => row.status === "left");
  const open = summary.results.filter((row) => row.status === "waiting" || row.status === "failed");
  const parts = [];
  parts.push(`<p class="storage-note">Last run, ${escapeHtml(when)}: ${summary.moved} moved${summary.left ? `, ${summary.left} moved with the Drive copy left in place` : ""}${summary.waiting ? `, ${summary.waiting} waiting` : ""}${summary.failed ? `, ${summary.failed} not moved` : ""}${summary.bytes ? ` · ${escapeHtml(formatStorageBytes(summary.bytes))} freed` : ""}.</p>`);
  if (open.length) {
    parts.push(`<ul class="storage-groups">${open.slice(0, MIGRATION_RESULT_PREVIEW).map((row) => `
      <li><span class="storage-group-name">${escapeHtml(row.name)}</span>
          <span class="storage-group-count">${escapeHtml(row.status === "waiting" ? `safe in the bucket — ${row.reason}` : row.reason)}</span></li>`).join("")}
      ${open.length > MIGRATION_RESULT_PREVIEW ? `<li><span class="storage-group-name">…and ${open.length - MIGRATION_RESULT_PREVIEW} more</span></li>` : ""}</ul>`);
  }
  if (left.length) {
    parts.push(`<p class="storage-note">${left.length === 1 ? "This paper is" : "These papers are"} safely in your bucket, and every device now opens ${left.length === 1 ? "it" : "them"} from there. Google no longer lets Recall delete from your Drive, so ${left.length === 1 ? "its Drive copy was" : "their Drive copies were"} left where ${left.length === 1 ? "it is" : "they are"}. Delete ${left.length === 1 ? "it" : "them"} at drive.google.com if you want the space back:</p>
      <ul class="storage-groups">${left.slice(0, MIGRATION_RESULT_PREVIEW).map((row) => `
        <li><span class="storage-group-name">${escapeHtml(row.name)}</span>
            <span class="storage-group-count">${escapeHtml(row.deckTitle || "")}</span></li>`).join("")}
        ${left.length > MIGRATION_RESULT_PREVIEW ? `<li><span class="storage-group-name">…and ${left.length - MIGRATION_RESULT_PREVIEW} more</span></li>` : ""}</ul>`);
  }
  return parts.join("");
}

function imagesSectionHtml(report, reachable, disabled) {
  if (!reachable) return `<p class="storage-note">Once the bucket is set up, new images go there too, and the ones already in Supabase can be moved across from here.</p>`;
  const images = report?.images;
  const survey = imageSurvey;
  const tiles = [
    storageStatTile(images ? images.count : "—", "Images in the bucket"),
    storageStatTile(images ? formatStorageBytes(images.bytes) : "—", "Used by images")
  ];
  if (survey) {
    tiles.push(storageStatTile(survey.toCopy.length, "Only in Supabase", survey.toCopy.length ? "is-warn" : ""));
    tiles.push(storageStatTile(survey.inBoth.length, "In both"));
  }
  const toCopyBytes = survey ? survey.toCopy.reduce((sum, object) => sum + (Number(object.size) || 0), 0) : 0;
  const inBothBytes = survey ? survey.inBoth.reduce((sum, object) => sum + (Number(object.size) || 0), 0) : 0;
  const signedIn = Boolean(report?.signedIn);
  const busyImages = imageStorageBusyLabel();
  return `
    <div class="storage-stats">${tiles.join("")}</div>
    <p class="storage-note">New images go into the bucket. Your notes do not change: each image keeps the address it always had, and Recall loads it from whichever storage holds it.</p>
    ${survey
      ? `<p class="storage-note">Checked ${escapeHtml(new Date(survey.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}: ${survey.supabase.count} image${survey.supabase.count === 1 ? "" : "s"} in Supabase (${escapeHtml(formatStorageBytes(survey.supabase.bytes))}); ${survey.toCopy.length} not in the bucket yet${survey.toCopy.length ? ` (${escapeHtml(formatStorageBytes(toCopyBytes))})` : ""}; ${survey.inBoth.length} safely in both.</p>`
      : `<p class="storage-note">${signedIn ? "Press <strong>Check images in Supabase</strong> to see how many are still only there." : "Sign in to compare with the images still in Supabase."}</p>`}
    ${imageSurveyError ? `<p class="storage-note is-warning">${escapeHtml(imageSurveyError)}</p>` : ""}
    ${lastImageCopy ? `<p class="storage-note${lastImageCopy.failed ? " is-warning" : ""}">Last copy: ${lastImageCopy.copied} copied${lastImageCopy.failed ? `, ${lastImageCopy.failed} could not be (${escapeHtml(lastImageCopy.failures[0]?.reason || "")}). Run it again to retry them` : ""}. Nothing was deleted.</p>` : ""}
    ${busyImages && !bucketWork ? `<p class="storage-note is-warning">Images are busy: ${escapeHtml(busyImages)}.</p>` : ""}
    <div class="storage-actions">
      <button type="button" class="storage-action" data-bucket-action="images-survey" ${signedIn && !disabled ? "" : "disabled"}>Check images in Supabase</button>
      <button type="button" class="storage-action" data-bucket-action="images-copy" ${signedIn && !disabled && (!survey || survey.toCopy.length) ? "" : "disabled"}>
        Move images to the bucket${survey && survey.toCopy.length ? ` (${survey.toCopy.length})` : ""}
      </button>
      <button type="button" class="storage-action is-danger" data-bucket-action="images-remove" ${signedIn && !disabled && survey?.inBoth.length ? "" : "disabled"}>
        Remove the Supabase copies${survey?.inBoth.length ? ` (${survey.inBoth.length} · ${escapeHtml(formatStorageBytes(inBothBytes))})` : ""}
      </button>
    </div>
    <p class="storage-note"><strong>Move</strong> only copies: every image is checked in the bucket, byte count and all, and nothing is deleted. <strong>Remove the Supabase copies</strong> is separate and asks first. It deletes only images it finds in the bucket at the same size at that moment, and it keeps this device's offline copies.</p>`;
}

export function renderBucketPanel() {
  const body = el.bucketBody;
  if (!body) return;
  const report = bucketReport;
  const reachable = canReachS3();
  const working = Boolean(bucketWork);

  const banner = working
    ? `<div class="storage-card">
         <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
         <p class="storage-busy">${escapeHtml(bucketProgress || bucketWork)}</p>
         <p class="storage-note">You can close this panel; the work carries on.</p>
       </div>`
    : "";

  if (!report) {
    body.innerHTML = `${banner}
      <div class="storage-card">
        <div class="job-progress-track is-indeterminate"><div class="job-progress-fill"></div></div>
        <p class="storage-busy">Reading your bucket…</p>
      </div>`;
    return;
  }

  // ── The keys ─────────────────────────────────────────────────────────────
  //
  // The form is shown whenever the bucket is NOT actually reachable, prefilled
  // with whatever is saved — not only when nothing is configured. Hiding it the
  // moment a value is stored was a trap the Drive card fell into: paste one
  // with a typo, watch the connect fail, and there is no longer anywhere to
  // correct it.
  //
  // The secret is rendered into a password field and never into the panel's
  // prose. It is not much of a defence — anything that can read the DOM can
  // read localStorage too — but it does cover the case this panel is genuinely
  // likely to meet, which is a screenshot or a shared screen.
  const s3 = report.s3;
  const s3Config = loadS3Config();
  const saved = s3Config || { endpoint: "", bucket: "", region: "", accessKeyId: "", secretAccessKey: "" };
  const disabled = working ? "disabled" : "";
  const s3Form = `
    <label class="storage-field" for="s3Endpoint">Endpoint</label>
    <input id="s3Endpoint" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="https://<account>.r2.cloudflarestorage.com" value="${escapeHtml(saved.endpoint)}">
    <label class="storage-field" for="s3Bucket">Bucket</label>
    <input id="s3Bucket" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="recall-papers" value="${escapeHtml(saved.bucket)}">
    <label class="storage-field" for="s3Region">Region</label>
    <input id="s3Region" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="${escapeHtml(S3_DEFAULT_REGION)}" value="${escapeHtml(saved.region || "")}">
    <label class="storage-field" for="s3KeyId">Access key ID</label>
    <input id="s3KeyId" class="storage-input" type="text" autocomplete="off" spellcheck="false"
           placeholder="" value="${escapeHtml(saved.accessKeyId)}">
    <label class="storage-field" for="s3Secret">Secret access key</label>
    <input id="s3Secret" class="storage-input" type="password" autocomplete="new-password" spellcheck="false"
           placeholder="" value="${escapeHtml(saved.secretAccessKey)}">
    <button type="button" class="storage-action" data-bucket-action="s3-save" ${disabled}>${isS3Configured() ? "Save and test again" : "Save and test"}</button>
    <button type="button" class="storage-action" data-bucket-action="s3-cors">Copy the CORS policy</button>
    ${isS3Configured() ? `<button type="button" class="storage-action" data-bucket-action="s3-forget" ${disabled}>Forget these keys everywhere</button>` : ""}
    <p class="storage-note">Cloudflare R2 gives 10GB free with no charge for downloads; Backblaze B2 and anything else speaking S3 work the same way. Mint the token for <strong>this one bucket</strong> with object read &amp; write and nothing else.</p>
    <p class="storage-note is-warning">The secret key really is a secret. Once it passes the test it is kept in this browser <em>and</em> in your own Supabase project, so every device you sign in on gets it without pasting it again. Row Level Security keeps it to your account; whoever administers the Supabase project can still read it, and so can anyone using this browser profile — which is why the token should reach this one bucket and nothing else.</p>
    <p class="storage-note">Before the first upload works, the bucket needs a CORS policy allowing this site. <strong>Copy the CORS policy</strong> puts the exact JSON on your clipboard; paste it into the bucket's settings.</p>`;
  // Whether the keys have reached the account, which is the whole of whether a
  // second device can open anything. Said in one line, and said as a warning
  // when the answer is "no" — that was the silent half of "connected, but the
  // papers are not on my phone".
  const keysLine = bucketKeysSyncLine(report);
  const backfill = report.backfill || { here: 0, elsewhere: 0, unknown: 0 };
  const backfillRun = documentBackfillStatus();
  const backfillFailure = backfillRun.last?.stopped || backfillRun.last?.failures?.[0]?.reason || "";
  const one = backfill.here === 1;
  const backfillLine = backfill.here
    ? `<p class="storage-note${reachable ? "" : " is-warning"}">${backfill.here} paper${one ? " is" : "s are"} on this device and not in the bucket yet, so no other device can open ${one ? "it" : "them"}. ${reachable
        ? (backfillRun.running ? "Uploading now…" : `${one ? "It uploads by itself" : "They upload by themselves"} at every sync.`)
        : `${one ? "It uploads by itself" : "They upload by themselves"} once the bucket is set up.`}</p>
       ${reachable && !backfillRun.running ? `<button type="button" class="storage-action" data-bucket-action="s3-backfill">Upload ${one ? "it" : "them"} now</button>` : ""}
       ${backfillFailure && reachable ? `<p class="storage-note is-warning">The last attempt stopped: ${escapeHtml(describeBackfillStop(backfillFailure))}</p>` : ""}`
    : "";
  const waitingLine = backfill.elsewhere
    ? `<p class="storage-note">${backfill.elsewhere} paper${backfill.elsewhere === 1 ? " is" : "s are"} not in the bucket and not on this device either. ${backfill.elsewhere === 1 ? "It uploads" : "They upload"} from the device that imported ${backfill.elsewhere === 1 ? "it" : "them"}, the next time that device syncs with the bucket set up.</p>`
    : "";
  const keysSection = !canSignS3Requests()
    ? `<p class="storage-note is-warning">This page is not being served over https, so the browser will not let it sign bucket requests. Papers and images stay where they are until it is.</p>`
    : reachable
      ? `<div class="storage-stats">
           ${storageStatTile(s3 ? s3.count : "—", "Papers in the bucket")}
           ${storageStatTile(s3 ? formatStorageBytes(s3.bytes) : "—", "Used by papers")}
           ${storageStatTile(s3Config.bucket, "Bucket")}
         </div>
         <p class="storage-note">Set up. New papers and images go here, deleting one gives the space straight back, and no sign-in is ever asked for.</p>
         ${keysLine}
         ${backfillLine}
         ${waitingLine}
         ${report.s3Error ? `<p class="storage-note is-warning">${escapeHtml(report.s3Error)}</p>` : ""}
         <details class="storage-details"><summary>Change the keys</summary>${s3Form}</details>`
      : `<p class="storage-note">Not set up. Papers you import are kept on this device and nowhere else, and images go to Supabase, until a bucket is added. If you already set one up on another device, sign in and sync — the keys come across by themselves.</p>
         ${keysLine}
         ${backfillLine}
         ${waitingLine}
         ${s3Form}`;

  // ── What has not moved across yet ────────────────────────────────────────
  //
  // Counted from the LOCAL deck snapshots, not from either old backend. That
  // is deliberate and it is why this line is free: it needs no Drive token, no
  // Supabase session and no network, so it is honest on a train and honest on
  // a device that was never connected to the Google account in question.
  const pending = report.migration || [];
  const pendingBytes = pending.reduce((sum, job) => sum + (job.bytes || 0), 0);
  const fromDrive = pending.filter((job) => job.source === "drive").length;
  const lastRun = migrationSummary();
  const migrationSection = `${pending.length
    ? `<div class="storage-stats">
         ${storageStatTile(pending.length, "Papers to move")}
         ${storageStatTile(formatStorageBytes(pendingBytes), "Still elsewhere")}
         ${storageStatTile(`${fromDrive} · ${pending.length - fromDrive}`, "Drive · Supabase")}
       </div>
       <button type="button" class="storage-action" data-bucket-action="migrate" ${reachable && !working ? "" : "disabled"}>
         Move them to the bucket${reachable ? "" : " — add a bucket first"}
       </button>
       <p class="storage-note">Each paper is copied into the bucket and checked there, then your decks sync, so every device knows where it went. Only after that is the old copy removed. An interrupted move leaves a duplicate, never a gap. A paper another deck still relies on keeps its old copy until that deck has moved too.</p>
       ${fromDrive ? `<p class="storage-note is-warning">${fromDrive} of these ${fromDrive === 1 ? "is" : "are"} in Google Drive. Google no longer lets Recall read or delete there, so ${fromDrive === 1 ? "it moves" : "they move"} from a device that already holds the file. The Drive copy is left in your Drive for you to delete by hand.</p>` : ""}`
    : `<p class="storage-note">Nothing left to move. Every paper in this library is either in the bucket or on this device alone.</p>`}
    ${migrationResultsHtml(lastRun)}`;

  body.innerHTML = `${banner}
    <div class="storage-card">
      <h2>Your bucket</h2>
      <p class="storage-sub">Your own S3-compatible bucket, for papers and images. Four values, pasted once on any device, and every device you sign in on gets them.</p>
      ${keysSection}
    </div>

    <div class="storage-card">
      <h2>Papers still elsewhere</h2>
      <p class="storage-sub">PDFs uploaded before the bucket, in Google Drive or the old Supabase <code>documents</code> bucket.</p>
      ${migrationSection}
    </div>

    <div class="storage-card">
      <h2>Images</h2>
      <p class="storage-sub">Pictures in your notes, cards and PDF pages.</p>
      ${imagesSectionHtml(report, reachable, working)}
    </div>

    <p class="storage-timestamp">Read ${escapeHtml(report.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }))}${report.online ? "" : " · offline"}${bucketReading ? " · reading…" : ""}</p>
  `;
}

// ── Actions ─────────────────────────────────────────────────────────────────

// One piece of work at a time, said out loud. `work` receives `say(text)` for
// progress and returns { message, tone } for the closing toast. The busy state
// is cleared however it ends.
async function runBucketWork(label, work, { touchesImages = false } = {}) {
  if (bucketWork) {
    showToast(`Still working — ${bucketWork}`, "info");
    return;
  }
  if (touchesImages && !claimImageStorage(label)) {
    showToast(`Images are busy: ${imageStorageBusyLabel()}. Try again when that finishes.`, "info");
    return;
  }
  bucketWork = label;
  bucketProgress = "";
  renderBucketPanel();
  let outcome = null;
  try {
    outcome = await work((text) => {
      bucketProgress = text;
      renderBucketPanel();
    });
  } catch (error) {
    console.error(`${label} failed`, error);
    outcome = { message: `${label.replace(/…$/, "")} stopped: ${error?.message || "unknown error"}`, tone: "error" };
  } finally {
    bucketWork = "";
    bucketProgress = "";
    if (touchesImages) releaseImageStorage();
  }
  if (outcome?.message) showToast(outcome.message, outcome.tone || "success");
  await refreshBucketReport();
}

function migrationProgressText(phase, done, count, name) {
  if (phase === "sync") return "Syncing your decks…";
  if (phase === "retire") return `Removing old copies ${Math.min(done + 1, count)} of ${count} — ${name}`;
  return `Copying ${Math.min(done + 1, count)} of ${count} into the bucket — ${name}`;
}

function migrationToast(summary) {
  const parts = [];
  if (summary.moved) parts.push(`${summary.moved} moved`);
  if (summary.left) parts.push(`${summary.left} moved (Drive copy left)`);
  if (summary.waiting) parts.push(`${summary.waiting} in the bucket, old copy waiting`);
  if (summary.failed) parts.push(`${summary.failed} not moved`);
  const freed = summary.bytes ? ` · ${formatStorageBytes(summary.bytes)} freed` : "";
  return {
    message: `${parts.join(", ") || "Nothing to move"}${freed}. The panel lists each one.`,
    tone: summary.failed || summary.waiting ? "info" : "success"
  };
}

export async function runBucketAction(action) {
  const blocking = ["s3-save", "s3-forget", "migrate", "images-survey", "images-copy", "images-remove"];
  if (bucketWork && blocking.includes(action)) {
    showToast(`Still working — ${bucketWork}`, "info");
    return;
  }

  // Saving the keys tests the credential — one LIST and one tiny PUT against
  // the reader's own bucket — and re-renders this panel. Nothing else waits on
  // it, and it waits on nothing else.
  if (action === "s3-save") {
    const typed = {
      endpoint: document.getElementById("s3Endpoint")?.value || "",
      bucket: document.getElementById("s3Bucket")?.value || "",
      region: document.getElementById("s3Region")?.value || "",
      accessKeyId: document.getElementById("s3KeyId")?.value || "",
      secretAccessKey: document.getElementById("s3Secret")?.value || ""
    };
    // Saved UNVERIFIED: kept here so a failed test leaves every field in the
    // form, but not fit to publish to the other devices until it passes.
    saveS3Config(typed, { ownerId: cachedUserId() || "", verified: false });
    if (!isS3Configured()) {
      showToast("Fill in the endpoint, bucket, key ID and secret", "error");
      renderBucketPanel();
      return;
    }
    await runBucketWork("Testing the bucket…", async (say) => {
      const result = await testS3Connection();
      if (!result.ok) {
        // The config is deliberately LEFT SAVED on a failure. A reader who has
        // one field wrong needs the other four still in the form to fix it.
        return { message: result.reason, tone: "error" };
      }
      markS3ConfigVerified(cachedUserId() || "");
      say("Sharing the keys with your other devices…");
      const shared = await pushS3ConfigNow();
      const where = shared.status === "synced"
        ? "your other devices get the keys at their next sync"
        : shared.status === "unavailable"
          ? "on this device only until supabase_setup.sql is re-run"
          : shared.status === "signed-out"
            ? "on this device only until you sign in"
            : "the keys reach your other devices at the next sync";
      if (result.warning) showToast(result.warning, "info");
      // Anything imported before this moment is still only on this device.
      scheduleDocumentBackfill({ force: true });
      bucketKeysChanged?.();
      return { message: `Bucket connected — ${where}`, tone: shared.status === "unavailable" ? "info" : "success" };
    });
    return;
  }

  if (action === "s3-backfill") {
    if (!canReachS3()) {
      showToast("Add a bucket first", "error");
      return;
    }
    // Not a panel job: a paper can take minutes. The run reports back when it
    // lands (see onDocumentBackfillDone in main.js).
    scheduleDocumentBackfill({ force: true });
    showToast("Uploading in the background — you can carry on", "info");
    renderBucketPanel();
    return;
  }

  if (action === "s3-cors") {
    const policy = JSON.stringify(s3CorsPolicy(), null, 2);
    try {
      await navigator.clipboard.writeText(policy);
      showToast("CORS policy copied — paste it into the bucket's settings", "success");
    } catch {
      // A clipboard the browser will not hand over is not a dead end: the
      // policy is short, and a prompt the reader can select from beats a toast
      // saying it failed.
      showPromptModal(
        "Copy this into the bucket's CORS settings",
        "Your browser would not let the page write to the clipboard, so here it is to select and copy.",
        policy,
        () => {}
      );
    }
    return;
  }

  if (action === "s3-forget") {
    // Everywhere, now that the keys are the account's rather than this
    // device's: forgetting them here alone would last until the next sync
    // brought them straight back.
    showConfirmModal(
      "Forget the bucket keys on every device? Nothing in the bucket is deleted, and papers already downloaded keep opening. But images and papers that are only in the bucket stop loading on every device until the keys are added again, and new papers stay on the device they were imported on.",
      async () => {
        clearS3Config({ ownerId: cachedUserId() || "" });
        const shared = await pushS3ConfigNow();
        bucketKeysChanged?.();
        showToast(shared.status === "synced"
          ? "Keys forgotten on every device — papers already downloaded still open"
          : "Keys forgotten here — your other devices drop them once this one syncs", "info");
        imageSurvey = null;
        await refreshBucketReport();
      },
      { confirmLabel: "Forget everywhere", danger: true }
    );
    return;
  }

  if (action === "migrate") {
    if (!canReachS3()) {
      showToast("Add a bucket first", "error");
      return;
    }
    const jobs = await planDocumentMigration();
    if (!jobs.length) {
      showToast("Nothing left to move", "info");
      await refreshBucketReport();
      return;
    }
    const total = jobs.reduce((sum, job) => sum + job.bytes, 0);
    showConfirmModal(
      `${jobs.length} paper${jobs.length === 1 ? "" : "s"} (${formatStorageBytes(total)}) will be copied into your bucket and checked there. Your decks then sync so every device knows where each one went, and only then is the old copy removed from Supabase. Copies in Google Drive are left in your Drive and listed for you. Your highlights, notes and cards are untouched, and so is every copy on this device.`,
      () => runBucketWork("Moving papers to the bucket…", async (say) => {
        const summary = await migrateDocumentsToS3(jobs, {
          sync: bucketSyncRunner,
          onProgress: (phase, done, count, name) => say(migrationProgressText(phase, done, count, name))
        });
        rememberMigrationSummary(summary);
        return migrationToast(summary);
      }),
      { confirmLabel: "Move to the bucket" }
    );
    return;
  }

  if (action === "images-survey") {
    await runBucketWork("Checking the images…", async (say) => {
      try {
        imageSurvey = await surveyImageStorage(say);
        imageSurveyError = "";
      } catch (error) {
        imageSurvey = null;
        imageSurveyError = error?.message || "Could not compare the two.";
        return { message: imageSurveyError, tone: "error" };
      }
      return { message: `${imageSurvey.toCopy.length} image${imageSurvey.toCopy.length === 1 ? "" : "s"} still only in Supabase`, tone: "info" };
    });
    return;
  }

  if (action === "images-copy") {
    await runBucketWork("Moving images to the bucket…", async (say) => {
      let survey;
      try {
        survey = await surveyImageStorage(say);
      } catch (error) {
        imageSurveyError = error?.message || "Could not compare the two.";
        return { message: imageSurveyError, tone: "error" };
      }
      if (!survey.toCopy.length) {
        imageSurvey = survey;
        return { message: "Every image in Supabase is already in the bucket", tone: "success" };
      }
      lastImageCopy = await copyImagesToS3(survey.toCopy, survey.host, {
        onProgress: (done, count) => say(`Copying images ${done} of ${count}…`)
      });
      // A fresh look, so the counts on screen are what is true now.
      try {
        imageSurvey = await surveyImageStorage(say);
        imageSurveyError = "";
      } catch (error) {
        imageSurveyError = error?.message || "";
      }
      return {
        message: `Copied ${lastImageCopy.copied} image${lastImageCopy.copied === 1 ? "" : "s"}${lastImageCopy.failed ? `, ${lastImageCopy.failed} could not be` : ""} — nothing deleted`,
        tone: lastImageCopy.failed ? "info" : "success"
      };
    }, { touchesImages: true });
    return;
  }

  if (action === "images-remove") {
    const confirmed = new Set((imageSurvey?.inBoth || []).map((object) => object.path));
    if (!confirmed.size) {
      showToast("Check the images first — nothing is known to be safely in both yet", "info");
      return;
    }
    const bytes = (imageSurvey?.inBoth || []).reduce((sum, object) => sum + (Number(object.size) || 0), 0);
    if (!await confirmByTyping("DELETE", "Remove the Supabase copies?",
      `${confirmed.size} image${confirmed.size === 1 ? "" : "s"} (${formatStorageBytes(bytes)}) are in your bucket at the same size, so their Supabase copies can go. Each is checked again at the moment of deleting, and anything that no longer matches is kept. Before you do this: take a backup (My Decks → ⋯ → Export All → Backup), and open Recall once on your other devices so they are on this version — an older version only knows how to load images from Supabase. Type DELETE to confirm.`)) return;
    await runBucketWork("Removing the Supabase copies…", async (say) => {
      const result = await removeSupabaseImageCopies(confirmed, { onProgress: say });
      try {
        imageSurvey = await surveyImageStorage(say);
        imageSurveyError = "";
      } catch (error) {
        imageSurvey = null;
        imageSurveyError = error?.message || "";
      }
      return {
        message: `Removed ${result.removed} Supabase cop${result.removed === 1 ? "y" : "ies"} (${formatStorageBytes(result.bytes)})${result.skipped ? ` · ${result.skipped} kept because they no longer matched` : ""}`,
        tone: "success"
      };
    }, { touchesImages: true });
  }
}

// Set by main.js: what else has to hear that the keys changed — the image
// index, the images already on screen. Registered rather than imported, for the
// same reason as the sync runner.
let bucketKeysChanged = null;

export function setBucketKeysChanged(fn) {
  bucketKeysChanged = typeof fn === "function" ? fn : null;
}

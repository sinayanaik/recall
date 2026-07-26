# Handwritten notes (S Pen) — technical design

Status: **design only, nothing implemented.** This is the plan of record for adding
re-editable handwriting to Recall: ink over notes, ink on cards, and clozes made out of
strokes.

Everything here is written against the app as it exists today — `app.js`, `sw.js`,
`index.html`, `styles.css`, and the `supabase_*.sql` files at the repo root. Function and
constant names in `code font` are real and can be grepped.

---

## 1. Goals and non-goals

**In scope**

- Capture S Pen strokes that feel like a pen — low latency, pressure-varying width, no
  dropped samples, no palm marks.
- Strokes are **objects, not pixels**: individually erasable, selectable, re-colourable,
  re-renderable crisply at any zoom, long after they were drawn.
- Handwriting on cards (question and answer side).
- Handwriting over deck notes.
- Lasso a group of strokes → make a cloze out of it.
- Lasso a group of strokes → make a new card out of it.
- All of it works offline and syncs across devices without resurrecting deleted strokes.

**Explicitly out of scope (for now)**

- Handwriting → text recognition. Chrome has an experimental Handwriting Recognition API
  but availability is narrow and it would be a separate project. Do not design around it.
- Samsung Air Actions / Air Command / pen-detach events. These are OS-level and BLE, and
  are not exposed to a web page. There is no Samsung SDK path for a PWA.
- Shape/handwriting beautification, OCR search over ink.

**Non-negotiable constraints inherited from the app**

| Constraint | Why it matters here |
|---|---|
| No build step. Static files, CDN `<script>` tags. | Ink code is plain JS loaded the same way. Any library must be a pinned CDN URL. |
| `localStorage` quota is already the binding constraint (see `isQuotaExceededError`, `deckAutosaveStorageFailed`). | **Ink must never be written to localStorage.** Not in the deck snapshot, not anywhere. |
| Offline-first: every write lands locally, queues, and syncs later. | Ink needs its own outbox, modelled on the image one. |
| Deletions must propagate. | Stroke deletion needs tombstones **from day one**. See §7.4 — we have already fixed this bug twice, at card level and deck level. |
| `?v=` in `index.html` must match `APP_SHELL` in `sw.js`, and `CACHE_NAME` bumps with it. | Adding `ink.js` means touching three places or it silently won't be cached offline. |

---

## 2. Keeping it a standalone static app

No bundler, no npm, no framework. Concretely:

1. **New file `ink.js`**, loaded from `index.html` after `app.js`:
   ```html
   <script src="ink.js?v=YYYYMMDD-NN"></script>
   ```
   It attaches one namespace (`window.RecallInk`) and nothing else. `app.js` calls into it;
   `ink.js` never reaches into `app.js` internals except through a small injected adapter
   (see §9). That keeps the engine liftable into another project later.

2. **Register it for offline** — add to `APP_SHELL` in `sw.js`:
   ```js
   "./ink.js?v=YYYYMMDD-NN",
   ```
   and bump `CACHE_NAME`. The `?v=` strings must match `index.html` exactly; there is a
   comment in `sw.js` about a past release where they drifted and the precached copy was
   dead weight for the whole release.

3. **Third-party libraries, if any, go in `CDN_ASSETS`** in `sw.js` so they are precached
   at install and repaired by `repairCdnCache()`. Candidate: `perfect-freehand` (small,
   turns points + pressure into a filled outline polygon). It is optional — §4.6 describes
   a dependency-free path. Prefer zero new dependencies; every CDN asset is one more thing
   that has to be present for the app to work on a plane.

4. **No new global CSS coupling.** Ink styles live in a clearly delimited block in
   `styles.css`, and the canvas layers are positioned by a single wrapper class.

---

## 3. Making the S Pen feel like an actual pen

This is the part that decides whether the feature is pleasant or abandoned. Be honest
about the ceiling: Samsung Notes uses native low-latency paths a web page cannot reach, so
we will not match it exactly. A careful web implementation lands in the range where it
still reads as "ink following the nib" rather than "line catching up with the pen"; a
careless one is unusable. The techniques below are the difference, roughly in order of
how much each one buys.

### 3.1 Two canvases: wet and dry

Never redraw the whole page per frame.

- **Dry layer** — every committed stroke, rasterised once. Only redrawn on resize, zoom,
  theme change, undo, or erase.
- **Wet layer** — the single stroke currently under the nib. Cleared and redrawn cheaply,
  or better, appended to incrementally.

On `pointerup`, the wet stroke is drawn into the dry layer and the wet layer is cleared.

### 3.2 Low-latency canvas

```js
const ctx = wetCanvas.getContext("2d", { desynchronized: true, alpha: true });
```

`desynchronized: true` lets Chrome skip a compositing step for that canvas. It is the
single biggest perceived-latency win available to a web page on Android. Use it on the
**wet layer only** — it can tear, which is invisible for a stroke in progress and ugly for
committed content.

### 3.3 Draw in the event handler, not in rAF

Deferring to `requestAnimationFrame` costs a frame. With `desynchronized`, drawing the wet
stroke synchronously inside `pointermove` is the low-latency path. (The dry layer's
occasional full redraw *should* be in rAF — different job, not latency-critical.)

### 3.4 Coalesced events — the fidelity fix

The S Pen digitiser samples far faster than the display refreshes. Chrome fires one
`pointermove` per frame and hides the intermediate samples inside it:

```js
for (const p of event.getCoalescedEvents?.() ?? [event]) addPoint(p);
```

Without this, fast strokes are visibly polygonal and pressure is stair-stepped. With it,
curves are smooth at speed. This is cheap and mandatory.

### 3.5 Predicted events — optional, use with care

`event.getPredictedEvents()` returns extrapolated future points. Drawing them as a faint
tail that is erased on the next real sample masks a chunk of remaining latency. It
overshoots on sharp direction changes, so: draw at most 1–2 predicted points, only on the
wet layer, never commit them. Ship it behind a setting and evaluate on the real device.

### 3.6 Geometry: from points to a stroke that looks drawn

A constant-width `ctx.lineTo` polyline looks like a whiteboard marker, not a pen. Two
options:

- **Dependency-free**: quadratic curves through the midpoints of consecutive points
  (`ctx.quadraticCurveTo(p[i], midpoint(p[i], p[i+1]))`) for the centreline, and for
  variable width, stamp the segment as a filled quad between the two offset edges
  (`width = f(pressure)` at each end). Accumulate into a `Path2D` and fill once per
  segment.
- **`perfect-freehand`**: give it points + pressure, get back an outline polygon, fill it.
  Better-looking tapers for less code, at the cost of a CDN dependency.

Start dependency-free; the quad-strip approach is ~60 lines and good enough to judge feel.

### 3.7 Pressure, tilt, and the fallbacks they need

- `event.pressure` is 0–1. The S Pen reports genuine pressure, but **the first
  `pointerdown` frequently reports 0** and some device/driver combinations report a
  constant `0.5`. Handle both: ignore the first sample's pressure, and if pressure never
  varies across a stroke, fall back to **velocity-based width** (faster = thinner), which
  looks natural on its own.
- Map pressure to width non-linearly: `w = minW + (maxW - minW) * pressure ** 0.7`. Linear
  feels dead at the light end.
- `tiltX` / `tiltY` are available on many S Pen models — useful later for a calligraphy or
  shading nib. Not needed for v1.
- Smooth the width, not just the position: a per-point EMA on width kills the "sausage
  links" artefact when pressure is noisy.

### 3.8 Input smoothing without adding lag

- Light exponential moving average on incoming points (α ≈ 0.4–0.6). Heavier stabilisation
  visibly lags the nib — that is the classic mistake.
- Drop points closer than ~0.5 px to the previous one; they add noise and cost.
- **Simplify on commit, not during**: run Ramer–Douglas–Peucker with a small epsilon
  (≈0.3 px in logical units) when the stroke ends. Typically removes 50–80% of points with
  no visible change, and it is the cheapest thing you can do for storage and sync size.

### 3.9 Palm rejection and gesture conflicts

The app already has swipe handling on the card surface (`swipeConfig`), a mobile chrome
auto-hide on scroll, and a selection pill — plus a documented history of swipe hijacking
text selection. Ink mode must not fight them.

- Accept only `event.pointerType === "pen"` for drawing.
- **Ignore `touch` entirely while ink mode is active** on the ink surface. This is real
  palm rejection: the palm arrives as `touch`, the nib as `pen`.
- Keep two-finger `touch` for pan/zoom even in ink mode — it is the expected gesture.
- `touch-action: none` on the ink surface, applied **only in ink mode** (the app already
  uses `touch-action` extensively; do not make it global).
- `setPointerCapture(event.pointerId)` on `pointerdown` so a stroke that leaves the canvas
  still completes.
- While ink mode is active: suppress swipe-to-next-card, suppress chrome auto-hide, hide
  the selection pill.

### 3.10 Hover, eraser, and the barrel button

- **Hover** works for the S Pen in Chrome on Android: `pointermove` with `pressure === 0`
  and `buttons === 0`. Draw a small cursor ring at the hover point — it markedly improves
  the sense of a physical nib. Cheap, do it.
- **Eraser**: the Pointer Events spec exposes an eraser via `buttons & 32` and the barrel
  button via `buttons & 2`. Whether the S Pen's side button surfaces as either **must be
  verified on the actual device** — see §12.1. Always ship a toolbar eraser too, since the
  button may not be available at all.
- Eraser modes: whole-stroke (hit-test and delete the stroke) is more useful for study
  notes than pixel erase, and it is far simpler with vector strokes. Offer stroke-erase
  first.

### 3.11 Resolution and fill rate

- Size the backing store to `devicePixelRatio` but **cap it at 2–2.5**. A 3× tablet canvas
  is 9× the fill and will drop frames for no visible gain.
- Fixed canvas size while drawing. No CSS transforms, no layout changes mid-stroke.
- On zoom, re-render the dry layer from the vector strokes rather than scaling the bitmap —
  this is the payoff for storing vectors.

### 3.12 A "feels right" checklist

Judge on the real tablet, not a desktop with a mouse:

- No perceptible gap between nib and line at normal writing speed.
- Fast diagonal strokes are curved, not faceted (coalesced events working).
- Slow, deliberate strokes have no visible stair-stepping or jitter (smoothing working).
- Resting a palm produces nothing at all.
- Line weight varies with how hard you press, without sausage-links.
- Writing a full page does not slow down (dry layer not being re-rendered).

---

## 4. Data model

### 4.1 Stroke

```js
{
  id: "s_<base36>",        // stable, generated on this device
  t: 1753500000000,        // created-at, ms
  tool: "pen" | "highlighter" | "eraser-mark",
  color: "#e8e8e8",        // resolved at draw time, not a theme token
  w: 2.4,                  // base width, logical units
  pts: Int16Array | number[],   // see §5.2 for the packed form
  cloze: "cz_ab12" | null, // cloze group membership, §8
  dirty: true,             // device-local, never uploaded
  updatedAt: "2026-07-26T05:00:00.000Z"  // device-local
}
```

`dirty` and `updatedAt` are deliberately the same two fields cards carry
(`stampCardSyncState`, `cardIsDirty`). Same names, same meaning, same merge rules — so
there is one concept in the codebase, not two.

### 4.2 Ink layer

A layer is all the ink attached to one target:

```js
{
  v: 1,
  target: { kind: "note" | "card-q" | "card-a", deckLocalId, cardId? },
  space: { w: 800, h: null },   // logical authoring width; height grows
  strokes: [...],
  deleted: { "s_x1": "2026-07-26T..." },  // stroke tombstones, §7.4
  updatedAt: "..."
}
```

### 4.3 Coordinate space

All coordinates are in a **fixed logical space** (`space.w`, e.g. 800 units wide),
never device pixels. Rendering scales logical → CSS px → device px. This is what makes
ink survive a phone/desktop/rotation change, and it is a prerequisite for §6.

---

## 5. Storage

### 5.1 Where it lives locally

**IndexedDB, never localStorage.** The deck snapshot in
`localStorage[LOCAL_DECK_PREFIX + localId]` is already close to quota on large libraries;
a single page of handwriting would blow it and trip `deckAutosaveStorageFailed`, which
disables autosave for the whole deck.

The app already has an IndexedDB: `IMAGE_OUTBOX_DB = "recall-outbox"`, version **1**, one
store `images` keyed by `token` (`openImageOutbox`).

> **Trap**: `indexedDB.open(name, version)` with a *lower* version than the stored one
> throws, and two call sites opening the same DB at different versions will break each
> other. Adding an ink store means bumping `recall-outbox` to version **2**, creating both
> stores in a single `onupgradeneeded` that handles the v0→v2 and v1→v2 paths, and routing
> **all** access — images included — through one `openRecallDb()`. Do not add a second
> `indexedDB.open` with a different version.

Stores after the change:

| Store | Key | Holds |
|---|---|---|
| `images` | `token` | existing offline image blobs |
| `ink` | `layerId` | one packed ink layer |
| `inkOutbox` | `layerId` | layers awaiting upload |

### 5.2 Wire format

JSON with float arrays is the obvious choice and roughly 4–6× larger than it needs to be.
Pack instead:

- Quantise x/y to 1/8 logical unit → 16-bit integers.
- **Delta-encode** consecutive points (handwriting moves in tiny steps, so deltas are
  mostly within ±127) and varint them.
- Pressure → `uint8`.
- Concatenate strokes into one buffer with a small header table (id, offset, length).

Then run the whole buffer through `CompressionStream("gzip")`, which is available in
Chrome and needs no library.

Indicative sizes — **measure these early, they drive the sync design**: a 200-point stroke
is ~1.2 KB as JSON, ~400 B packed, ~200 B packed+gzipped. A densely written page at
300–800 strokes is therefore roughly 150–500 KB as JSON versus 60–160 KB packed and
gzipped. A modest note with a few annotations is a few KB.

### 5.3 In the cloud

Two candidates:

- **Supabase Storage object per layer** (recommended). Mirrors what images already do:
  a bucket, an RLS policy modelled on `supabase_image_storage.sql`, upload via
  `supabaseClient.storage.from(INK_BUCKET).upload(path, blob)`. Blobs are cheap, arbitrarily
  large, and never bloat the `decks`/`cards` row you fetch on every sync — which matters,
  because `fetchCloudDeckIndex` and `fetchCardsForDecks` are on the hot path of every
  reconcile.
- A `text`/`bytea` column on a new table. Simpler to query, but puts hundreds of KB inside
  rows the sync reads constantly. Rejected for that reason.

Plus a small metadata table so the merge has something cheap to compare:

```sql
CREATE TABLE ink_layers (
  layer_id    TEXT PRIMARY KEY,
  user_id     UUID NOT NULL DEFAULT auth.uid(),
  deck_id     TEXT NOT NULL,
  card_id     TEXT,
  kind        TEXT NOT NULL,          -- note | card-q | card-a
  object_path TEXT NOT NULL,          -- Storage path of the packed blob
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

New file `supabase_ink.sql`, following the shape and re-runnability of the existing
migrations, with the same "run this in the SQL Editor" comment header.

### 5.4 Offline caching

Ink blobs need the same treatment images got:

- A sibling SW cache `recall-ink-v1`, spared by name in the `activate` sweep exactly as
  `IMAGE_CACHE_NAME` is (the sweep deletes everything that is not explicitly spared).
- Cache-first in the `fetch` handler, like `isSupabaseImageUrl`.
- **Seed the cache at upload time**, mirroring `cacheUploadedImageOffline`: we already hold
  the bytes; an ink layer you just drew must not be missing offline because the cache is
  only populated by downloading.
- `warmDeckImageCache` gains an ink equivalent so a deck pulled on wifi is fully readable
  on the train.

---

## 6. Anchoring ink over notes

The hard problem. Rendered markdown reflows (width, style settings, phone vs desktop);
ink does not. Three models:

| Model | How | Correctness | Cost to reading UX |
|---|---|---|---|
| **A. Fixed-width page** | Notes render at one logical width everywhere; narrow screens zoom/pan. Ink shares that space. | Exact, always | High — reflowed reading is lost on phones |
| **B. Block anchors** | Each rendered block gets a stable id; strokes stored relative to that block's box. | Survives width changes; drifts when a block's own height changes | None |
| **C. Interleaved ink blocks** | Ink occupies its own regions in the markdown flow, like images but re-editable. | Exact | None, but it isn't annotation |

There is prior art for B in the app: quick notes carry a `noteAnchor` ("jump to where this
was pinned") and the All Cards editor has triple-click-to-source. Same class of problem,
already solved once.

**Recommendation**: ship **C** first (it is nearly free once the engine exists and it is
genuinely useful for handwritten working-out between paragraphs), and treat **A** as an
opt-in per-deck "page mode" for decks you actually annotate. **B** looks like a compromise
and behaves like one — permanent small drift is more irritating than either honest answer.

This decision must be made before stage 4 of §11, not during it.

---

## 7. Sync

### 7.1 Principle

Reuse the model that is already correct, do not invent a second one. Cards sync per-card
with `dirty` + `updatedAt` + tombstones. **Ink syncs per-stroke with the same three
things.** The transport is a blob; the *merge* is per stroke.

### 7.2 Merge rules

Directly mirroring `mergeCloudCardsIntoSnapshot`:

| local | cloud | rule |
|---|---|---|
| only, dirty | absent | keep — drawn here, never pushed |
| only, clean | absent | **delete** — it reached the cloud once, so its absence *is* an erase |
| both, local dirty AND strictly newer | present | keep local |
| both, otherwise | present | take cloud, mark clean |
| absent | present | add |
| tombstoned here | present | **skip**, and re-assert the deletion on the next push |

And mirroring `reconcileCardsBeforePush` on the way up: a stroke present in the cloud and
absent locally is only pruned if it is **tombstoned here**; otherwise it was drawn on
another device and must be adopted, not deleted.

### 7.3 The read-modify-write race

An ink layer is one object in Storage, so two devices can clobber each other. Mitigations,
all of which have precedent in the codebase:

- Merge client-side: download the cloud blob, merge stroke-by-stroke, upload the union.
- Guard with `ink_layers.updated_at`: refuse the write if it changed since the read, and
  retry the merge. (Cheap optimistic concurrency; Storage itself has no CAS.)
- **Re-read the local layer after the upload await**, not before — `pushLibraryDeckToCloud`
  learned this the hard way: a multi-second push discarded every edit made during it. Only
  clear `dirty` on strokes whose content still matches what was sent.

### 7.4 Stroke tombstones

Non-negotiable, designed in from the start. An erased stroke leaves
`layer.deleted[strokeId] = iso`. Rules, copied from the card tombstones
(`recordDeletedCardIds`, `readCardTombstones`, `pruneCardTombstones`,
`dropTombstonesForLiveCards`):

- Written when a stroke disappears from a layer that previously contained it.
- Retired as soon as the cloud is observed **not** to have that stroke.
- A stroke that comes back (undo) retires its own tombstone — a present stroke is never
  tombstoned.
- Age/count capped so the map cannot grow without bound.

Skipping this means erasing a stroke on the tablet and watching it return from the
desktop. That exact bug has now been fixed twice in this app, at card level and deck level;
there is no reason to write it a third time.

### 7.5 Offline

- Layers are saved to IndexedDB immediately and queued in `inkOutbox`.
- A `recall-ink:<layerId>` placeholder scheme mirroring `LOCAL_IMAGE_SCHEME`
  (`recall-img:`) for anything that needs a URL before upload. **If it ever appears in
  sanitised HTML it must be added to the `ALLOWED_URI_REGEXP` in `markdownToSafeHtml`** —
  and note the existing warning there: do not also add `data:`.
- `flushPendingInkUploads()` modelled on `flushPendingImageUploads`, drained **at the top
  of `reconcileAllDecks`, before the deck list is read**, for the same reason the other
  queues are: a pull would otherwise erase what they carry.

### 7.6 Reporting

Add ink counts to `emptySyncStats` / `SYNC_COUNT_STATS` / `describeSyncStats` so the sync
report says "12 strokes added, 3 erased" rather than staying silent. Every other sync
outcome in this app is reported; ink should not be the exception.

### 7.7 Backup and restore

`exportLibraryBackupZip` must include ink layers, and `mergeDeckSnapshots` needs an ink
rule. Restore is **additive** by design, so the natural rule is: union the strokes, and let
a restored stroke retire its tombstone (same as `dropTombstonesForLiveCards` does for
cards).

---

## 8. Clozes and ink → card

Text clozes are `{{...}}` in the markdown source (`CLOZE_SCAN_RE`, `applyClozeMarkup`,
`makeClozeFromSelection`, `toggleClozes`). Ink cannot use that representation, but it can
use the same *behaviour*.

**Ink cloze = a named set of stroke ids.**

- Lasso strokes → assign them a `cloze` group id → they render hidden (or as a filled
  placeholder box sized to their bounding box) until revealed.
- Reveal/hide hooks into the existing cloze toggle so "Reveal clozes" affects text and ink
  together, and `collectDeckClozes` learns to count ink groups.
- Ordering (cloze 1, 2, 3…) comes free from a group index.

**Ink → card**: lasso → create a card whose question or answer side owns a new ink layer,
with the selected strokes translated to that layer's origin. This is why cards need an ink
layer of their own, not just notes — and it is also why card ink boxes should be
fixed-size, which conveniently sidesteps §6 entirely.

Knock-on: the All Cards editor, PDF/markdown export, and the Quick Notes board all assume
card text. Each needs at minimum a "this card has ink" affordance, and export needs to
rasterise ink to an image.

---

## 9. Integration points in the existing code

The concrete list of things that get touched. Useful as a scope check.

| Area | File / symbol | Change |
|---|---|---|
| Load | `index.html`, `sw.js` `APP_SHELL`, `CACHE_NAME` | add `ink.js?v=…` |
| Surface | `#notesView`, `#notesEdit`, `#questionEdit`, `#answerEdit` | ink layer wrapper + mode toggle |
| Gestures | `swipeConfig`, chrome auto-hide, selection pill | suppress while inking |
| Local store | `openImageOutbox` → `openRecallDb` v2 | new `ink`, `inkOutbox` stores |
| Deck save | `saveDeckToLibrary`, `deckContentSignature` | ink presence flag only — **never the ink itself** |
| Sync | `reconcileAllDecks`, `pullCloudDeckToLibrary`, `pushLibraryDeckToCloud` | flush queue, pull/push/merge layers |
| Stats | `emptySyncStats`, `SYNC_COUNT_STATS`, `describeSyncStats`, `buildSyncReportHtml` | stroke counts |
| SW | `IMAGE_CACHE_NAME` sweep, `fetch` handler, `CDN_ASSETS` | `recall-ink-v1` cache |
| Upload | `uploadImageToSupabase`, `cacheUploadedImageOffline` | ink equivalents |
| Cloze | `CLOZE_SCAN_RE`, `toggleClozes`, `collectDeckClozes` | ink cloze groups |
| Backup | `exportLibraryBackupZip`, `mergeDeckSnapshots`, `backupDeckToSnapshot` | include ink |
| Migration | new `supabase_ink.sql` | bucket + `ink_layers` table + RLS |

---

## 10. Challenges, ranked by how likely they are to hurt

1. **Anchoring over reflowing markdown** (§6). The only genuinely unsolved one. Decide the
   model before writing code.
2. **Feel.** If latency or palm rejection is wrong, nothing else matters. De-risk on day
   one with the spike in §12.1 — not after the data model is built.
3. **Sync of a blob with per-item merge semantics** (§7.3). The race is real and the
   codebase has already been bitten by the equivalent one.
4. **Size and quota.** Ink is orders of magnitude larger than anything the app stores
   today. Measure §5.2 early; if the numbers are worse than estimated, the sync design
   changes (chunk per page rather than per layer).
5. **Surface area.** Ink on cards means every place that renders a card needs to cope:
   All Cards, exports, Quick Notes board, print/PDF.
6. **Undo/redo.** The app has `pushCardUndoSnapshot` / `restoreCardsState` for cards. Ink
   needs its own stack, and snapshotting whole layers per stroke is too expensive — use an
   operation log (add stroke / erase stroke / group).
7. **Theme.** Colours are resolved at draw time, so ink drawn in dark theme may be
   invisible in light. Store a semantic colour slot alongside the literal colour, or force
   an ink palette that works in both.

---

## 11. Staged plan

Each stage is independently useful and none is thrown away by the next.

**Stage 0 — Spike (small).** Pointer event log on the real tablet + throwaway stroke
capture. Answers: latency, pressure fidelity, palm rejection, whether the side button and
eraser bit are exposed. Output: a decision on §3.5, §3.10 and the feel budget.

**Stage 1 — Stroke engine + local storage (largest single chunk).** Capture, smoothing,
two-canvas rendering, stroke objects with ids/`dirty`/`updatedAt`/tombstones, IndexedDB v2,
packed format, undo log. No sync, no UI beyond a scratch surface.

**Stage 2 — Ink on cards.** Fixed-size ink box on the question/answer side. No anchoring
problem. Proves the engine end to end and is useful on its own.

**Stage 3 — Sync.** Bucket, `ink_layers`, merge, tombstones, outbox, report lines, backup.
Test with the two-device harness before trusting it.

**Stage 4 — Clozes over strokes.** Lasso, grouping, reveal integration. Small once 1–3
exist.

**Stage 5 — Ink over notes.** The §6 decision, implemented.

**Stage 6 — Ink → card extraction.** Mostly UI at that point.

Stages 1–4 already deliver handwritten cards with handwritten clozes that sync — a
coherent product on their own.

---

## 12. Testing

### 12.1 The device spike

A scratch page (not in the repo) that logs, for every pointer event: `pointerType`,
`pressure`, `tiltX/Y`, `twist`, `buttons`, `getCoalescedEvents().length`, and the
timestamp delta. Write on it with the S Pen for thirty seconds. That single page settles
most of the open questions in §3.

### 12.2 Automated

The existing headless harness pattern applies (a static server + puppeteer + a stubbed
Supabase sharing one in-memory cloud across two browser contexts). Two additions:

- **Synthetic pen input**: CDP `Input.dispatchMouseEvent` accepts `pointerType: "pen"`
  along with `force`, `tiltX`, `tiltY`, so strokes can be driven programmatically.
- **Merge as pure functions**: keep `mergeInkLayers` / `reconcileStrokesBeforePush` free of
  DOM and storage so they can be exercised directly, the way the card merge functions can.

The regression that matters most, and the one to write first: *erase a stroke on device A,
sync both, confirm it does not come back on the next three cycles.*

---

## 13. Open questions

- §6: annotation over text, or interleaved handwritten blocks, or both?
- Is ink per card side (Q and A separately) or one layer per card?
- Highlighter as a separate tool with multiply blending, or just a wide translucent pen?
- Do ink clozes need per-stroke granularity, or is a lassoed group always the unit?
- Page mode: per deck, per note, or a global setting?

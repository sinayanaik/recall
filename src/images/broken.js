// A picture that did not load, made visible.
//
// Every upload path writes `![](url)` with an EMPTY alt, and
// `#notesView .diagram-shell img:not(.has-custom-size)` (styles/06-rendered.css)
// forces `width: auto`. So an <img> whose source cannot be fetched paints
// nothing whatsoever: measured in Chrome at 393px against the app's own
// stylesheets, the element computes to 0x0 and its .diagram-shell collapses to
// 82x50 — an empty rounded box holding only the "Zoom" pill. That is the whole
// of "the image is not visible". There was no error path at all: nothing in the
// app listened for an <img> error, so a dead reference had no placeholder, no
// explanation, and — inside a box that small — nowhere for its own delete
// button to sit that was not on top of something else.
//
// Two answers here, in order:
//
//   1. Try once to make it load. The images bucket is private, so what an <img>
//      is given is a SIGNED url with a lifetime, and the one failure this app
//      can actually repair is a signature that has stopped working — cached
//      before a session change, or slept through. Forget it and sign again.
//   2. Failing that, say so on the page. The shell gets a floor and a label, so
//      the reader can see there is a picture here, read which one it was, and
//      remove it with the delete button that now has room to exist.
//
// Deliberately NOT an edit to the note: a broken reference is often temporary
// (offline, an expired session, a host having a bad day) and rewriting the
// markdown on the strength of one failed GET would destroy the one copy of the
// link. My Decks -> More -> Check for broken images is where a deliberate
// clean-up belongs.

import { CANONICAL_SRC_ATTR, canSignStorageUrls, forgetSignedUrl, signedUrlsFor, storagePathFromUrl } from "../cloud/storage-urls.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";
import { IMAGE_BUCKET } from "./upload.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME } from "./outbox.js?v=__BUILD__";

export const BROKEN_IMAGE_CLASS = "is-broken-image";

export const BROKEN_SHELL_CLASS = "has-broken-image";

// Has this <img> finished trying and come back with nothing? `complete` is true
// after a FAILURE as well as after a success, and a failure is the only way it
// can be true with no natural width — so the pair is the test. An element with
// no src at all (a scheme the sanitiser stripped) answers the same way, which
// is correct: there is equally nothing to show.
export function isBrokenImage(node) {
  return Boolean(node && node.tagName === "IMG" && node.complete && !node.naturalWidth);
}

// What the note actually points at, which is not necessarily the `src`: two
// passes rewrite that between the render and here (see sourceUrlForImage in
// src/images/surface-controls.js, which reads it back the same way for the same
// reason). A signed URL's basename is the storage object's random name, and its
// query string is a JWT — neither belongs in a label.
export function brokenImageSource(img) {
  const token = img?.dataset?.localToken;
  if (token) return `${LOCAL_IMAGE_SCHEME}${token}`;
  return img?.getAttribute(CANONICAL_SRC_ATTR) || img?.getAttribute("src") || "";
}

// A short name for the picture: its alt text if the note gave it one, else the
// file's own name. Capped, because a data: URI or a deep storage path is not a
// label and would push the shell to whatever width it felt like.
export const BROKEN_LABEL_MAX_CHARS = 42;

export function brokenImageLabel(img) {
  const alt = (img?.getAttribute("alt") || "").trim();
  if (alt) return alt.slice(0, BROKEN_LABEL_MAX_CHARS);
  const source = brokenImageSource(img);
  if (!source) return "no image address";
  if (source.startsWith(LOCAL_IMAGE_SCHEME)) return "waiting to upload";
  if (/^data:/i.test(source)) return "embedded image";
  const name = source.split(/[?#]/)[0].split("/").filter(Boolean).pop() || source;
  try {
    return decodeURIComponent(name).slice(0, BROKEN_LABEL_MAX_CHARS);
  } catch (_) {
    return name.slice(0, BROKEN_LABEL_MAX_CHARS);
  }
}

// Paint (or unpaint) the placeholder for one image. The classes go on BOTH the
// image and its shell: the shell is what carries the floor and draws the box,
// because fighting `.diagram-shell img`'s `!important` width from a stylesheet
// that loads after a frozen slice is a losing game, and the shell needs the
// size anyway so the grip and the delete button have somewhere to be.
export function applyBrokenImageState(img) {
  if (!img) return false;
  // Never in an export. The placeholder exists to be ACTED on — the delete
  // button beside it is the whole point — and there is nothing to act on in a
  // PDF that has already been handed to someone. An export keeps the gap it
  // has always had rather than gaining a box that says a picture is missing.
  if (img.closest("#printRoot, .print-root")) return isBrokenImage(img);
  const broken = isBrokenImage(img);
  img.classList.toggle(BROKEN_IMAGE_CLASS, broken);
  const shell = img.closest(".diagram-shell");
  if (!shell) return broken;
  shell.classList.toggle(BROKEN_SHELL_CLASS, broken);
  if (broken) {
    shell.dataset.brokenLabel = brokenImageLabel(img);
    shell.title = `This image didn't load — ${brokenImageSource(img) || "it has no address"}`;
  } else {
    delete shell.dataset.brokenLabel;
    shell.removeAttribute("title");
  }
  return broken;
}

// One forced re-sign, for an image of the user's own that failed. Returns true
// when a fresh URL was actually put on the element — the caller then leaves the
// placeholder off and waits for the load or the second failure.
export async function retrySignedImage(img) {
  if (!img || img.dataset.signRetried) return false;
  const canonical = img.getAttribute(CANONICAL_SRC_ATTR);
  if (!canonical || !canSignStorageUrls()) return false;
  const path = storagePathFromUrl(IMAGE_BUCKET, canonical);
  if (!path) return false;
  // Marked before the await, not after: a second error can arrive while this
  // one is in flight, and two retries for one image is the loop this guards.
  img.dataset.signRetried = "1";
  forgetSignedUrl(IMAGE_BUCKET, path);
  const signed = (await signedUrlsFor(IMAGE_BUCKET, [path])).get(path);
  if (!signed || signed === img.getAttribute("src")) return false;
  img.setAttribute("src", signed);
  return true;
}

// ── When a verdict is allowed to be reached ────────────────────────────────
//
// Not on the first error an element reports. A rendered <img> starts life
// holding whatever the markdown says, and the pipeline then rewrites it —
// hydrateLocalImages swaps a recall-img: token for a blob URL, and
// resolveStorageImages swaps a canonical Storage URL for a signed one, which
// costs a network round trip. Both of those initial sources fail to load by
// design, so marking on the first error would flash the placeholder over every
// image in every note on every signed-in device.
//
// So the render tail says when an image has been through both swaps
// (markBrokenImages, called after them), and only from that point is a failure
// this element's own answer rather than a step in its resolution.
export function imageSettled(img) {
  return img?.dataset?.imageSettled === "1";
}

export function watchImageLoading(img) {
  if (!img || img.dataset.brokenWatch) return;
  img.dataset.brokenWatch = "1";
  img.addEventListener("load", () => applyBrokenImageState(img));
  img.addEventListener("error", async () => {
    if (!imageSettled(img)) return;
    if (await retrySignedImage(img)) return;
    applyBrokenImageState(img);
  });
}

// Every image in the freshly rendered nodes, judged. Called from the render
// tail AFTER hydrateLocalImages and resolveStorageImages — see imageSettled.
// `root` is a container or the list of nodes the incremental renderer built,
// the same shape those two take.
export async function markBrokenImages(root = document) {
  const nodes = Array.isArray(root)
    ? scopedQueryAll(root, "img")
    : root?.querySelectorAll?.("img");
  if (!nodes || !nodes.length) return;
  const retries = [];
  for (const img of nodes) {
    img.dataset.imageSettled = "1";
    watchImageLoading(img);
    if (!isBrokenImage(img)) {
      applyBrokenImageState(img);
      continue;
    }
    // Already failed by the time the swaps finished — the error event fired
    // before this element was settled, so nothing acted on it. Same two steps
    // the listener would have taken.
    retries.push(retrySignedImage(img).then((retried) => {
      if (!retried) applyBrokenImageState(img);
    }));
  }
  if (retries.length) await Promise.all(retries).catch((error) => console.warn("Could not re-sign an image", error));
}

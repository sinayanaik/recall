// Resizing and deleting an image or diagram in place.
//
// The handle drags on the rendered element, but the width is committed back
// into the markdown token it came from — so the size survives a re-render, an
// export and a sync.

import { el } from "../core/dom.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { renderTargetConfig } from "../format/render-toolbar.js?v=__BUILD__";
import { deleteSupabaseImage, scheduleDeckAutosave, state } from "../main.js?v=__BUILD__";
import { DIAGRAM_WIDTH_MAX, DIAGRAM_WIDTH_MIN, fenceInfoWithWidth, fencePattern, normalizeImageUrl, parseDiagramWidth } from "../render/preprocess.js?v=__BUILD__";

// ── Which surfaces carry editable images ───────────────────────────────────
// The resize/delete grips started out as a notes-only feature, reading and
// rewriting state.notes directly. A card face is the same problem with a
// different backing string, so everything below takes an "image surface"
// instead: the render target (renderTargetConfig already knows how to read,
// write and re-render each one) plus the element the width badge measures its
// percentage against. One implementation, three surfaces — notes, question,
// answer — so an image pasted into a card is resized and deleted exactly the
// way one pasted into the notes is.
export const IMAGE_SURFACE_NAMES = ["notes", "question", "answer"];

export function imageSurfaceFor(name) {
  const target = renderTargetConfig(name);
  if (!target.view) return null;
  return { name, ...target };
}

// The surface that owns a rendered container, or null if it isn't one of the
// three (the All Cards list, a print root, the paste preview, …) — those render
// read-only and get no grips.
export function imageSurfaceForView(view) {
  if (!view) return null;
  const name = IMAGE_SURFACE_NAMES.find((n) => renderTargetConfig(n).view === view);
  return name ? imageSurfaceFor(name) : null;
}

export function lexMarkdownTokens(source) {
  return marked.lexer(source || "");
}

export function surfaceLexTokens(surface) {
  return lexMarkdownTokens(surface?.getSource?.() || "");
}

export function parseImgTagFromHtml(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const img = wrap.querySelector("img");
  if (!img) return null;
  const wProp = img.style.getPropertyValue("--notes-img-w").trim();
  return {
    url: img.getAttribute("src") || "",
    alt: img.getAttribute("alt") || "",
    widthPx: wProp ? parseInt(wProp, 10) || null : null
  };
}

// Sizing is stored as an absolute pixel width (not a percentage of whatever
// happens to contain it), so it's stable regardless of viewport width changes.
export function imgTagHtml({ url, alt = "", widthPx = null }) {
  const style = widthPx ? ` style="--notes-img-w:${widthPx}px; width:${widthPx}px"` : "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${style}>`;
}

// Walks top-level marked tokens and returns every image-bearing block in
// document order. A standalone image (its own paragraph / raw <img>) and one
// sharing a paragraph with other text (isInline) are both directly
// resizable — commitImageWidth rewrites just that image's own raw slice for
// the isInline case, leaving the surrounding text untouched. One nested in a
// list/quote (isDeep) is resized in place too, via commitDeepImageWidth, which
// swaps its raw slice inside the enclosing token without pulling it out.
// Legacy side-by-side rows (`.notes-img-row`, no longer creatable) are still
// detected so their images stay resizable and the DOM↔token mapping in
// enhanceSurfaceImageControls stays aligned.
// A paragraph written as `![](a) | ![](b) | …` (images separated by "|") is a
// side-by-side row: returns the ordered image infos, or null if the paragraph
// is anything else. Mirrors renderImageRows so the controls treat what renders
// as a row as a row (resize grip per image), not as loose inline images.
export function pipeRowImages(token) {
  if (token.type !== "paragraph" || !Array.isArray(token.tokens)) return null;
  // Drop pure-whitespace text tokens with no pipe (stray spacing between
  // items); real separators keep their "|".
  const toks = token.tokens.filter((t) => {
    if (t.type !== "text" && t.type !== "escape") return true;
    const s = String(t.raw ?? t.text ?? "");
    return !(/^\s*$/.test(s));
  });
  if (toks.length < 3 || toks.length % 2 === 0) return null; // image (sep image)+
  const images = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i % 2 === 0) {
      if (t.type === "image") {
        images.push({ url: t.href, alt: t.text || "", widthPx: null });
      } else if (t.type === "html" && /^<img\b/i.test((t.raw || t.text || "").trim())) {
        const info = parseImgTagFromHtml(t.raw || t.text);
        if (!info) return null;
        images.push(info);
      } else {
        return null;
      }
    } else if (!/^\s*\|\s*$/.test(String(t.raw ?? t.text ?? ""))) {
      return null; // separator must be a single "|"
    }
  }
  return images.length >= 2 ? images : null;
}

export function findImageTokens(tokens) {
  const results = [];
  tokens.forEach((token, tokenIndex) => {
    const rowImages = pipeRowImages(token);
    if (rowImages) {
      results.push({ tokenIndex, isRow: true, images: rowImages });
      return;
    }
    if (token.type === "paragraph" && Array.isArray(token.tokens) && token.tokens.length === 1) {
      const inline = token.tokens[0];
      if (inline.type === "image") {
        results.push({ tokenIndex, isRow: false, images: [{ url: inline.href, alt: inline.text || "", widthPx: null }] });
        return;
      }
      if (inline.type === "html" && /^<img\b/i.test((inline.raw || inline.text || "").trim())) {
        const info = parseImgTagFromHtml(inline.raw || inline.text);
        if (info) results.push({ tokenIndex, isRow: false, images: [info] });
        return;
      }
    }
    // An image pasted mid-sentence shares its paragraph with other text.
    // `inlinePos` lets commitImageWidth find and replace just this image's
    // own raw slice within the paragraph, so it's still resizable in place.
    if (token.type === "paragraph" && Array.isArray(token.tokens) && token.tokens.length > 1) {
      token.tokens.forEach((inline, inlinePos) => {
        if (inline.type === "image") {
          results.push({ tokenIndex, isRow: false, isInline: true, inlinePos, images: [{ url: inline.href, alt: inline.text || "", widthPx: null }] });
        } else if (inline.type === "html" && /^<img\b/i.test((inline.raw || inline.text || "").trim())) {
          const info = parseImgTagFromHtml(inline.raw || inline.text);
          if (info) results.push({ tokenIndex, isRow: false, isInline: true, inlinePos, images: [info] });
        }
      });
      return;
    }
    if (token.type === "html") {
      const wrap = document.createElement("div");
      wrap.innerHTML = token.raw;
      const rowDiv = wrap.querySelector(".notes-img-row");
      if (rowDiv) {
        const images = Array.from(rowDiv.querySelectorAll("img")).map((img) => {
          const wProp = img.style.getPropertyValue("--notes-img-w").trim();
          return {
            url: img.getAttribute("src") || "",
            alt: img.getAttribute("alt") || "",
            widthPx: wProp ? parseInt(wProp, 10) || null : null
          };
        });
        if (images.length) results.push({ tokenIndex, isRow: true, images });
        return;
      }
      if (/^<img\b/i.test(token.raw.trim())) {
        const info = parseImgTagFromHtml(token.raw);
        if (info) results.push({ tokenIndex, isRow: false, images: [info] });
      }
      return;
    }
    // Anything else — most commonly a list or blockquote — can have images
    // buried in its nested items/sub-tokens. Those get the same corner resize
    // grip, committed in place by commitDeepImageWidth.
    const deep = [];
    collectImagesDeep(token, deep);
    deep.forEach((found) => {
      results.push({ tokenIndex, isRow: false, isDeep: true, imageRaw: found.raw, images: [{ url: found.url, alt: found.alt, widthPx: found.widthPx ?? null }] });
    });
  });
  return results;
}

// Recursively collects every image (markdown ![]() or raw <img> HTML) found
// anywhere within a token's subtree — marked's list_item/blockquote tokens nest
// their content under .tokens (and .items), so an image pasted under a bullet
// lives several levels deep, not at the top level findImageTokens checks.
export function collectImagesDeep(token, results) {
  if (!token || typeof token !== "object") return;
  if (token.type === "image") {
    results.push({ raw: token.raw || `![${token.text || ""}](${token.href})`, url: token.href, alt: token.text || "" });
    return;
  }
  if (token.type === "html" && /^<img\b/i.test((token.raw || token.text || "").trim())) {
    const info = parseImgTagFromHtml(token.raw || token.text);
    if (info) results.push({ raw: token.raw || token.text, ...info });
    return;
  }
  if (Array.isArray(token.tokens)) token.tokens.forEach((t) => collectImagesDeep(t, results));
  if (Array.isArray(token.items)) token.items.forEach((t) => collectImagesDeep(t, results));
}

// Resizes an image found via collectImagesDeep IN PLACE — nested in its
// enclosing top-level token (a list item, blockquote, etc.). Its exact raw
// source slice is swapped for a sized raw <img> tag, leaving the surrounding
// list/quote structure untouched, so the image stays put under its bullet
// instead of being promoted to its own line. On the next resize the slice is
// the <img> tag itself (collectImagesDeep re-detects it and reads back the
// width), so repeated drags keep working.
export function commitDeepImageWidth(surface, tokenIndex, imageRaw, info, px) {
  const widthPx = Math.min(2000, Math.max(20, Math.round(px)));
  const tokens = surfaceLexTokens(surface);
  const token = tokens[tokenIndex];
  if (!token) return;
  const idx = token.raw.indexOf(imageRaw);
  if (idx === -1) return;
  const newImgRaw = imgTagHtml({ ...info, widthPx });
  const newRaw = token.raw.slice(0, idx) + newImgRaw + token.raw.slice(idx + imageRaw.length);
  tokens[tokenIndex] = { ...token, raw: newRaw };
  rebuildSurfaceFromTokens(surface, tokens);
}

// Rebuilds a surface's markdown from a (possibly mutated) token array, writes it
// back through the surface's own setter (which keeps the raw editor / master card
// list in sync), re-renders, and autosaves — the single write path every resize
// and delete commit goes through. Every token is normalized to end in a blank
// line so blocks stay safely separated after a splice; "space" tokens (marked's
// blank-line gaps) are dropped since each kept token already gets its own
// trailing blank line.
export function rebuildSurfaceFromTokens(surface, tokens) {
  const next = tokens
    .filter((t) => t.type !== "space")
    .map((t) => t.raw.replace(/\n*$/, "\n\n"))
    .join("")
    .replace(/\n+$/, "\n");
  surface.setSource(next);
  surface.rerender();
  scheduleDeckAutosave();
}

// Freestyle sizing — an absolute pixel width with only a sanity floor/ceiling,
// so an image can be shrunk to a small accent or blown up past its container
// (the shell scrolls). `subPos` disambiguates when a single token carries more
// than one image: a side-by-side `|`-separated row (subPos = index in the
// row) or an image sharing a paragraph with other text (subPos = inlinePos).
// Resizing a row image rewrites that line into the explicit
// `<div class="notes-img-row">` form (the only representation that can carry
// a per-image width); it renders identically. Resizing an inline image
// replaces just its own raw slice within the shared paragraph, in place —
// the surrounding text is left untouched, no promotion/extraction needed.
export function commitImageWidth(surface, tokenIndex, subPos, px) {
  const widthPx = Math.min(2000, Math.max(20, Math.round(px)));
  const tokens = surfaceLexTokens(surface);
  const token = tokens[tokenIndex];
  if (!token) return;
  const entries = findImageTokens(tokens).filter((e) => e.tokenIndex === tokenIndex);

  const rowEntry = subPos !== null ? entries.find((e) => e.isRow) : null;
  const inlineEntry = subPos !== null ? entries.find((e) => e.isInline && e.inlinePos === subPos) : null;

  if (rowEntry) {
    if (!rowEntry.images[subPos]) return;
    const images = rowEntry.images.map((im, i) => (i === subPos ? { ...im, widthPx } : im));
    const rowHtml = `<div class="notes-img-row">${images.map(imgTagHtml).join("")}</div>\n\n`;
    tokens[tokenIndex] = { type: "html", raw: rowHtml, text: rowHtml, pre: false, block: true };
  } else if (inlineEntry) {
    const inline = token.tokens[inlineEntry.inlinePos];
    if (!inline) return;
    const newImgRaw = imgTagHtml({ ...inlineEntry.images[0], widthPx });
    tokens[tokenIndex] = { ...token, raw: token.raw.replace(inline.raw, newImgRaw) };
  } else {
    const entry = entries.find((e) => !e.isRow && !e.isInline);
    if (!entry) return;
    const html = imgTagHtml({ ...entry.images[0], widthPx }) + "\n\n";
    tokens[tokenIndex] = { type: "html", raw: html, text: html, pre: false, block: true };
  }
  rebuildSurfaceFromTokens(surface, tokens);
}

// Removes one image occurrence from the surface — the delete-button counterpart
// to commitImageWidth/commitDeepImageWidth, using the same row/inline/deep/
// standalone dispatch so removal handles every shape resizing does. `imageRaw`
// (deep case) strips just that raw slice from its enclosing token, leaving the
// surrounding list/quote untouched; every other case rewrites or drops the
// whole token, same as a resize commit would.
export function removeImageAt(surface, tokenIndex, subPos, imageRaw) {
  const tokens = surfaceLexTokens(surface);
  const token = tokens[tokenIndex];
  if (!token) return;

  if (imageRaw) {
    const idx = token.raw.indexOf(imageRaw);
    if (idx === -1) return;
    const newRaw = token.raw.slice(0, idx) + token.raw.slice(idx + imageRaw.length);
    tokens[tokenIndex] = { ...token, raw: newRaw };
    rebuildSurfaceFromTokens(surface, tokens);
    return;
  }

  const entries = findImageTokens(tokens).filter((e) => e.tokenIndex === tokenIndex);
  const rowEntry = subPos !== null ? entries.find((e) => e.isRow) : null;
  const inlineEntry = subPos !== null ? entries.find((e) => e.isInline && e.inlinePos === subPos) : null;

  if (rowEntry) {
    const remaining = rowEntry.images.filter((_, i) => i !== subPos);
    if (remaining.length >= 2) {
      const rowHtml = `<div class="notes-img-row">${remaining.map(imgTagHtml).join("")}</div>\n\n`;
      tokens[tokenIndex] = { type: "html", raw: rowHtml, text: rowHtml, pre: false, block: true };
    } else if (remaining.length === 1) {
      const html = imgTagHtml(remaining[0]) + "\n\n";
      tokens[tokenIndex] = { type: "html", raw: html, text: html, pre: false, block: true };
    } else {
      tokens.splice(tokenIndex, 1);
    }
  } else if (inlineEntry) {
    const inline = token.tokens[inlineEntry.inlinePos];
    if (!inline) return;
    // Drop just this image's own raw slice. Any double space it leaves behind
    // in the surrounding prose is harmless (Markdown/HTML collapse runs of
    // whitespace) — deliberately NOT globally collapsing spaces here, which
    // would corrupt intentional spacing inside inline code in the paragraph.
    tokens[tokenIndex] = { ...token, raw: token.raw.replace(inline.raw, "") };
  } else {
    tokens.splice(tokenIndex, 1);
  }
  rebuildSurfaceFromTokens(surface, tokens);
}

// True while ANY text in the open deck still points at `url` — the notes or
// either side of any card. Deleting an image from a card face has to check the
// whole deck, not just that face: the same upload is routinely pasted into the
// notes and then captured into a card, and hard-deleting the storage object
// because one of those copies went away turns every other one into a broken
// link.
export function deckStillReferencesImage(url) {
  if (!url) return true;
  if ((state.notes || "").includes(url)) return true;
  return state.masterCards.some(
    (card) => String(card.question || "").includes(url) || String(card.answer || "").includes(url)
  );
}

// Removes the image from its surface immediately (so the UI never waits on a
// network round-trip), then best-effort deletes its underlying storage object.
export function removeSurfaceImage(surface, tokenIndex, subPos, imageRaw, url) {
  removeImageAt(surface, tokenIndex, subPos, imageRaw);
  // Only hard-delete the stored file once NO other reference to it survives in
  // this deck — a duplicated image (same URL used twice, or the `![](url)`
  // markdown copy-pasted) otherwise deletes the file out from under its other
  // copies, turning them into broken links. This is the deletion ImgBB's plain
  // public-link API never allowed from inside the app; guarding it keeps that
  // power from becoming accidental data loss. (A copy pasted into a *different*
  // deck is still not seen here — checking every deck is too costly — so cross-
  // deck reuse of the exact same uploaded URL remains a caveat, not the norm
  // since each upload gets a unique path.)
  if (url && !deckStillReferencesImage(url)) {
    deleteSupabaseImage(url);
  }
}

// Bottom-right corner-grip resize (the universal affordance): drag out from the
// corner to grow, in to shrink. Width is what's stored; height is auto, so
// aspect ratio is preserved for free. A live badge shows the current px width
// and its share of the surface's own column so sizing isn't guesswork.
// `bounds` lets a diagram use its own floor/ceiling (a diagram shrunk to 20px is
// unreadable in a way a small image isn't).
export function beginImageResize(event, shell, img, onCommit, refEl, bounds = null) {
  event.preventDefault();
  event.stopPropagation();
  shell.setPointerCapture?.(event.pointerId);
  const minWidth = bounds?.min ?? 20;
  const maxWidth = bounds?.max ?? 2000;
  const startX = event.clientX;
  // For a diagram, `img` is the block that HOLDS the drawing and is as wide as
  // the column even when the <svg> inside is drawn narrower (the Style panel's
  // "visual width" setting). Start from what the user can actually see, so the
  // edge tracks the pointer from the first pixel of the drag.
  const drawn = img.tagName === "IMG" ? img : img.querySelector("svg") || img;
  const startWidth = drawn.getBoundingClientRect().width || shell.getBoundingClientRect().width;
  const refWidth = refEl?.clientWidth || el.notesView?.clientWidth || 600;
  let widthPx = Math.round(startWidth);

  const badge = document.createElement("div");
  badge.className = "notes-img-size-badge";
  shell.appendChild(badge);
  const paintBadge = () => {
    const pct = Math.round((widthPx / refWidth) * 100);
    badge.textContent = `${widthPx}px · ${pct}%`;
  };

  shell.classList.add("is-resizing");
  // Native pointermove can fire well past 60/sec; writing style.width straight
  // from the event forces a layout on every one of them. rAF-batch it to at
  // most one write per rendered frame, keeping only the latest pointer x.
  let pendingEvent = null;
  let rafId = null;
  const applyMove = () => {
    rafId = null;
    const dx = pendingEvent.clientX - startX;
    widthPx = Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + dx)));
    img.style.setProperty("--notes-img-w", `${widthPx}px`);
    img.style.width = `${widthPx}px`;
    img.classList.add("has-custom-size");
    paintBadge();
  };
  const onMove = (e) => {
    pendingEvent = e;
    if (rafId == null) rafId = requestAnimationFrame(applyMove);
  };
  // A single teardown for every way the drag can end. Without also handling
  // pointercancel (fired when a touch/pen gesture is interrupted — scroll
  // takeover, second finger, the browser stealing the pointer), onUp would never
  // run: the live size badge would stay stranded in the DOM and the document
  // pointermove listener would leak, which is the "stray UI element that pops up
  // and won't go away" symptom.
  let finished = false;
  const end = (commit) => {
    if (finished) return;
    finished = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    shell.classList.remove("is-resizing");
    badge.remove();
    if (commit) onCommit(widthPx);
  };
  const onUp = () => end(true);
  const onCancel = () => end(false); // interrupted — drop the badge, keep last live width
  paintBadge();
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// Attaches the blue corner-drag resize grip and a delete button to an image.
// `onCommit(widthPx)` persists the final size and `onDelete()` removes the
// image — the caller supplies the right write path for each, matching the
// image's shape (standalone/row/inline, or nested in a list/quote). These are
// the only image controls: every rendered image on an editable surface gets
// them, so images buried in bullet points are resized/removed in place just
// like any other, with no intermediate "move to own line" step.
// `onDelete` may be null for a target that only resizes (a diagram, whose source
// is a fenced code block the user edits as text).
export function attachNotesImageResizeHandle(shell, img, onCommit, onDelete, refEl, bounds = null) {
  shell.querySelector(".notes-img-controls")?.remove();
  shell.querySelector(".notes-img-resize-handle")?.remove();
  shell.querySelector(".notes-img-delete-btn")?.remove();
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "notes-img-resize-handle";
  resizeHandle.title = "Drag to resize";
  resizeHandle.setAttribute("aria-hidden", "true");
  resizeHandle.addEventListener("pointerdown", (e) => beginImageResize(e, shell, img, onCommit, refEl, bounds));
  shell.appendChild(resizeHandle);

  if (!onDelete) return;

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "notes-img-delete-btn";
  deleteBtn.title = "Remove image";
  deleteBtn.setAttribute("aria-label", "Remove image");
  deleteBtn.textContent = "🗑";
  deleteBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete();
  });
  shell.appendChild(deleteBtn);
}

// Re-attaches the resize grip / delete button after every render of an editable
// surface (the notes view or either card face).
//
// Rendering wraps EVERY <img> in a .diagram-shell (addDiagramZoomControl), but
// findImageTokens only classifies the images it can map back to a resizable /
// promotable source block — an image buried in a table cell or wrapped in a link
// inside running text is rendered (and shelled) yet left unclassified. Pairing
// the two lists purely by ordinal position therefore slipped the whole sequence
// the moment one such image appeared: a resize grip meant for a later image got
// attached to (and would then rewrite) the wrong one.
//
// Instead, match each classified image to its shell by src, walked as an ordered
// subsequence: a shell whose image isn't in the classified list fails the src
// check and is simply skipped (keeping only its Zoom pill) rather than consuming
// a control slot. src is compared through normalizeImageUrl so a Drive link whose
// rendered src was already rewritten still matches its raw markdown href.
export function enhanceSurfaceImageControls(surface) {
  const view = surface?.view;
  if (!view) return;
  const tokens = surfaceLexTokens(surface);
  const imageTokens = findImageTokens(tokens);
  const shells = Array.from(view.querySelectorAll(".diagram-shell")).filter((s) => s.querySelector("img"));

  // One slot per classified image, in document order, carrying its owning entry.
  const slots = [];
  imageTokens.forEach((entry) => {
    entry.images.forEach((img, subIndex) => {
      slots.push({ entry, subIndex, url: normalizeImageUrl(img.url || "") });
    });
  });

  let slotIdx = 0;
  shells.forEach((shell) => {
    const img = shell.querySelector("img");
    if (!img) return;
    if (slotIdx >= slots.length) return;
    const slot = slots[slotIdx];
    const src = normalizeImageUrl(img.getAttribute("src") || "");
    if (src !== slot.url) return; // unclassified image (table cell, linked, …) — Zoom only
    slotIdx++;

    const { entry, subIndex } = slot;
    img.draggable = false;
    shell.dataset.tokenIndex = String(entry.tokenIndex);
    const widthPx = entry.images[subIndex]?.widthPx;
    if (widthPx) {
      img.style.setProperty("--notes-img-w", `${widthPx}px`);
      img.classList.add("has-custom-size");
    } else {
      img.classList.remove("has-custom-size");
    }
    if (entry.isDeep) {
      // An image nested in a list/quote is resized in place too: instead of
      // extracting it to its own line first, commitDeepImageWidth rewrites just
      // its raw slice within the enclosing token's content, keeping it exactly
      // where it sits under the bullet.
      const info = entry.images[0];
      attachNotesImageResizeHandle(shell, img,
        (px) => commitDeepImageWidth(surface, entry.tokenIndex, entry.imageRaw, info, px),
        () => removeSurfaceImage(surface, entry.tokenIndex, null, entry.imageRaw, info.url),
        view
      );
    } else {
      const subPos = entry.isRow ? subIndex : (entry.isInline ? entry.inlinePos : null);
      const url = entry.images[entry.isRow ? subIndex : 0]?.url || "";
      attachNotesImageResizeHandle(shell, img,
        (px) => commitImageWidth(surface, entry.tokenIndex, subPos, px),
        () => removeSurfaceImage(surface, entry.tokenIndex, subPos, null, url),
        view
      );
    }
  });
}

// ── Editable diagrams: the same corner-drag resize images get ──────────────
// A mermaid/nomnoml diagram renders as a picture, so it should be sizeable like
// one. Its source is a fenced code block rather than an <img>, so the width is
// written back into the fence's info string (```mermaid w=520 — see
// parseDiagramWidth) instead of onto a tag.
//
// The DOM→source mapping is by ordinal position, which is exact here in a way it
// isn't for images: preprocessSpecialBlocks turns every diagram fence into
// exactly one .mermaid/.nomnoml-diagram element, in source order, wherever the
// fence sits. Walking the shared fencePattern() keeps the two lists in lockstep;
// if the counts ever disagree, no grip is attached rather than a grip that would
// resize the wrong diagram.
export function findDiagramFences(source) {
  const text = String(source || "");
  const pattern = fencePattern();
  const fences = [];
  let match;
  while ((match = pattern.exec(text))) {
    if (!/\b(?:mermaid|nomnoml)\b/i.test(match[1])) continue;
    const headEnd = text.indexOf("\n", match.index);
    fences.push({
      start: match.index,
      headEnd: headEnd === -1 ? text.length : headEnd,
      info: match[1],
      widthPx: parseDiagramWidth(match[1])
    });
  }
  return fences;
}

export function commitDiagramWidth(surface, fenceIndex, px) {
  const widthPx = Math.min(DIAGRAM_WIDTH_MAX, Math.max(DIAGRAM_WIDTH_MIN, Math.round(px)));
  const source = surface.getSource() || "";
  const fence = findDiagramFences(source)[fenceIndex];
  if (!fence) return;
  const head = "```" + fenceInfoWithWidth(fence.info, widthPx);
  surface.setSource(source.slice(0, fence.start) + head + source.slice(fence.headEnd));
  surface.rerender();
  scheduleDeckAutosave();
}

export function enhanceSurfaceDiagramControls(surface) {
  const view = surface?.view;
  if (!view) return;
  const fences = findDiagramFences(surface.getSource());
  const diagrams = Array.from(view.querySelectorAll(".mermaid, .nomnoml-diagram"));
  if (!diagrams.length || diagrams.length !== fences.length) return;

  diagrams.forEach((node, index) => {
    const shell = node.parentElement;
    if (!shell?.classList.contains("diagram-shell")) return;
    const widthPx = fences[index].widthPx;
    if (widthPx) {
      node.style.setProperty("--notes-img-w", `${widthPx}px`);
      node.style.width = `${widthPx}px`;
      node.classList.add("has-custom-size");
    }
    attachNotesImageResizeHandle(
      shell,
      node,
      (px) => commitDiagramWidth(surface, index, px),
      null,
      view,
      { min: DIAGRAM_WIDTH_MIN, max: DIAGRAM_WIDTH_MAX }
    );
  });
}

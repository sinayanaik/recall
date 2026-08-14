// Everything done to rendered markdown after the HTML exists: code blocks get
// their language and copy button, equations get numbered, diagrams render,
// dead note links get marked.

import { ensureMermaid, ensureNomnoml } from "../core/lib-loader.js?v=__BUILD__";
import { loadNoteLinkIndex, noteLinkEntriesByTitle, parseNoteLinkTarget } from "../notes/note-links.js?v=__BUILD__";
import { codeLanguageLabel, codeLanguageOrGeneric, configurePrismLanguages, declaredCodeLanguage, inferCodeLanguage, normalizeCodeLanguage } from "./code-language.js?v=__BUILD__";
import { EAGER_IMAGE_COUNT, deferrableRenderRoot, runNearViewportAndDefer, scopedQueryAll } from "./deferred-work.js?v=__BUILD__";
import { addDiagramZoomControl } from "./diagram-zoom.js?v=__BUILD__";
import { sourceWithNomnomlTheme } from "./diagrams.js?v=__BUILD__";
import { noteLinkEntryMatchesId } from "./note-links.js?v=__BUILD__";
import { normalizeImageUrl } from "./preprocess.js?v=__BUILD__";
import { fitMarkdownTables } from "./tables.js?v=__BUILD__";

export function enhanceCodeBlocks(roots) {
  configurePrismLanguages();

  scopedQueryAll(roots, "pre code").forEach((code) => {
    const pre = code.closest("pre");
    const declared = declaredCodeLanguage(code);
    // No ```lang on the fence? Guess one from the body (see
    // inferCodeLanguage) so the block still highlights, still gets a badge,
    // and — via code.dataset.codeLanguage below — so anything selected out of
    // it can be re-fenced with a real language. The guess is cached on the
    // element: enhancement passes run again on re-render, and the answer can't
    // change for a body that hasn't changed. Rendering never rewrites the
    // user's markdown; the fence in the source stays exactly as they wrote it.
    let inferred = "";
    if (!declared) {
      if (code.dataset.inferredLanguage === undefined) {
        code.dataset.inferredLanguage = inferCodeLanguage(code.textContent);
      }
      // Falls back to `text` when the guess came up empty — a block with no
      // language at all is what left some blocks flat and badge-less.
      inferred = codeLanguageOrGeneric(code.dataset.inferredLanguage);
    }
    const declaredLanguage = declared || inferred;
    const normalizedLanguage = normalizeCodeLanguage(declaredLanguage);

    pre?.classList.add("code-block");
    // Single source of truth for "what language is this block", read back by
    // the selection→fence path on both the rendered and raw sides.
    if (normalizedLanguage) code.dataset.codeLanguage = normalizedLanguage;

    if (declaredLanguage && pre) {
      pre.classList.add("has-code-language");
      pre.dataset.language = codeLanguageLabel(declaredLanguage);
      // Marks the badge as a guess rather than something the note declared —
      // used for the tooltip, and available to CSS if it should ever look
      // different.
      if (inferred) pre.dataset.languageInferred = "1";

      // Inject a real button for the language badge so it can be clicked to copy.
      // Guard against double-injection when the block is re-rendered.
      if (!pre.querySelector(".code-copy-btn")) {
        const label = codeLanguageLabel(declaredLanguage);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy-btn";
        btn.textContent = label;
        btn.title = inferred ? `Copy code · ${label} detected` : "Copy code";
        btn.addEventListener("click", async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(code.textContent ?? "");
            btn.textContent = "✓";
            btn.classList.add("is-copied");
            setTimeout(() => {
              btn.textContent = label;
              btn.classList.remove("is-copied");
            }, 1400);
          } catch {
            // clipboard unavailable — silent fail
          }
        });
        pre.appendChild(btn);
      }
    }

    if (!normalizedLanguage) return;

    // Set the class even when Prism isn't around: it's what Turndown reads to
    // put the language on the fence when a selection spanning the whole block
    // goes through the HTML→Markdown path.
    code.classList.add(`language-${normalizedLanguage}`);
    pre?.classList.add(`language-${normalizedLanguage}`);

    if (!window.Prism || code.dataset.highlighted === "yes") return;
    Prism.highlightElement(code);
  });
}

// Flags every display equation that carries an equation number, because two
// things in this app quietly break KaTeX's numbering and both of them are only
// worth correcting where a number actually exists.
//
// 1. The number is drawn by a pure CSS counter — katex.css has
//    `body{counter-reset:katexEqnNo}` and `.eqn-num:before{content:"("
//    counter(katexEqnNo) ")";counter-increment:katexEqnNo}`. But
//    `content-visibility: auto` on every top-level notes block (see
//    .notes-rendered > * in styles.css) implies STYLE containment, and style
//    containment scopes counters to the contained subtree. Each block therefore
//    started its own katexEqnNo, so every numbered equation in a note rendered
//    as "(1)". The block holding one opts out of content-visibility; blocks
//    without equations keep it, and since they never touch the counter the
//    numbering across the ones that do stays continuous.
//
// 2. KaTeX lays a multi-line environment's whole number column out as ONE
//    absolutely-positioned `.tag` pinned to `right: 0` of `.katex-html`, which
//    is a block and so only as wide as the visible container — not as wide as
//    the (white-space: nowrap) formula. `.math-display` is an overflow-x scroll
//    container, so on a narrow screen a formula wider than the viewport slid
//    straight underneath its own equation numbers. See .katex-display.has-eqn-num
//    in styles.css for the sizing that re-anchors them past the real content.
export function markNumberedEquations(scope) {
  scopedQueryAll(scope, ".katex-display").forEach((display) => {
    // .eqn-num is an auto-numbered row (align/gather/equation); a bare .tag
    // holds a hand-written \tag{...}, which has the same overlap problem but
    // no counter to fix.
    if (!display.querySelector(".eqn-num, .katex-html > .tag")) return;
    display.classList.add("has-eqn-num");
    const surface = display.closest(".notes-rendered");
    if (!surface) return;
    let block = display;
    while (block.parentElement && block.parentElement !== surface) block = block.parentElement;
    block.classList.add("has-eqn-num-block");
  });
}

// `roots` (optional) narrows every pass to the nodes the incremental renderer
// just created; omit it to enhance the whole container, which is what the
// export/print paths and every non-incremental surface do.
export async function enhanceRenderedMarkdown(container, roots = null) {
  const scope = roots || [container];

  scopedQueryAll(scope, "a[href]").forEach((link) => {
    // A bare "#foo" is a jump within this note, not a destination on the web.
    // It used to be swept up here with everything else and opened a blank tab —
    // now that notes can link to each other, "where will this take me" has to
    // be answerable at a glance, and an in-page anchor that teleports you to an
    // empty tab is the opposite of that.
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) {
      link.classList.add("in-page-link");
      link.removeAttribute("target");
      return;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  enhanceCodeBlocks(scope);

  scopedQueryAll(scope, ".math-display[data-tex], .math-inline[data-tex]").forEach((node) => {
    try {
      katex.render(decodeURIComponent(node.dataset.tex), node, {
        displayMode: node.classList.contains("math-display"),
        throwOnError: false
      });
    } catch (error) {
      node.textContent = decodeURIComponent(node.dataset.tex);
    }
  });

  // Safety net for delimiters that reached the DOM without going through
  // protectMath. Deliberately WITHOUT a bare "$" pair: protectMath has already
  // converted every real $…$ / $$…$$ span into a .math-* node above, using
  // CommonMark-ish rules (no whitespace just inside the delimiters). What is
  // left is text protectMath examined and declined — overwhelmingly two dollar
  // AMOUNTS on one line, e.g. "$5 for one and $10 for two", which this pass
  // would otherwise swallow and render as math.
  scope.filter((node) => node.nodeType === 1).forEach((node) => {
    renderMathInElement(node, {
      delimiters: [
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false }
      ],
      throwOnError: false
    });
  });

  // After BOTH math passes, so a numbered equation is caught whether it came
  // through protectMath or the \[…\] safety net above.
  markNumberedEquations(scope);

  // Diagrams get their shell (and so their Zoom pill and resize grip) up front,
  // even when the drawing itself is deferred — the shell is what reserves the
  // space and carries the controls.
  const diagrams = scopedQueryAll(scope, ".mermaid, .nomnoml-diagram");
  diagrams.forEach((node) => {
    node.classList.add("is-diagram-pending");
    addDiagramZoomControl(node);
  });

  const lazyRoot = deferrableRenderRoot(container);
  const diagramWork = runNearViewportAndDefer(diagrams, lazyRoot, renderDiagramNodes);

  // The first few images of a note are the ones the reader is already looking
  // at, so they must not wait for an intersection to start downloading — with
  // content-visibility: auto on every top-level block, a lazy image at the top
  // of the note can be a blank box for a full round trip on open. Everything
  // after them stays lazy, which is the whole point on a note carrying dozens
  // of screenshots. Counted across calls because the notes view renders
  // incrementally, block by block, into the same container.
  let eagerBudget = lazyRoot
    ? Math.max(0, EAGER_IMAGE_COUNT - lazyRoot.querySelectorAll("img[data-eager-image]").length)
    : 0;

  scopedQueryAll(scope, "img").forEach((img) => {
    const rewritten = normalizeImageUrl(img.getAttribute("src"));
    if (rewritten !== img.getAttribute("src")) img.setAttribute("src", rewritten);
    // Long notes routinely carry dozens of screenshots; letting the browser skip
    // the ones below the fold is the cheapest win available here. Card faces and
    // the print/export roots stay eager — both are measured right after render.
    if (lazyRoot) {
      if (eagerBudget > 0) {
        eagerBudget -= 1;
        img.dataset.eagerImage = "1";
        img.loading = "eager";
        img.setAttribute("fetchpriority", "high");
      } else {
        img.loading = "lazy";
      }
      img.decoding = "async";
    }
    addDiagramZoomControl(img);
  });

  fitMarkdownTables(container, roots);
  markMissingNoteLinks(scope);
  await diagramWork;
}

// Grey out any [[reference]] whose target no longer exists, so a broken link is
// visible while reading rather than only on the click that fails.
//
// Fire-and-forget and never awaited: it needs the deck index (and possibly a
// cloud round trip on the very first call), and blocking the paint of a note on
// that would be a poor trade for a styling detail. Links render in their normal
// state and the broken ones fade a moment later.
export function markMissingNoteLinks(scope) {
  const links = scopedQueryAll(scope, "a.note-link");
  if (!links.length) return;
  loadNoteLinkIndex().then((index) => {
    for (const link of links) {
      if (!link.isConnected) continue;
      const parts = parseNoteLinkTarget(link.getAttribute("data-note-target") || "");
      // A quick_notes pin isn't in the deck index; leave it alone rather than
      // calling it broken on the strength of a lookup that never applied.
      if (parts.cardId) continue;
      const label = (link.getAttribute("data-note-title") || "").trim();
      // A pipe-less label may carry a "#Heading" (see resolveNoteLink), and
      // "[[#Proof]]" names a heading in THIS note, which always exists as far
      // as the deck index is concerned. Comparing the whole label against deck
      // titles would grey out both as broken.
      const hash = label.indexOf("#");
      const title = (hash === -1 ? label : label.slice(0, hash)).trim();
      // Must reach the SAME verdict resolveNoteLink would, including its
      // unique-title fallback — a link drawn as broken that opens perfectly
      // well is its own bug, and the two tests drifting apart is how that
      // happens. Both go through noteLinkEntryMatchesId / noteLinkEntriesByTitle.
      const found = parts.id
        ? index.some((entry) => noteLinkEntryMatchesId(entry, parts.id))
          || noteLinkEntriesByTitle(index, label).length === 1
        : !title || noteLinkEntriesByTitle(index, title).length > 0;
      // An index that couldn't reach the account is missing every cloud-only
      // deck, so it cannot say an id doesn't exist — only that it isn't in the
      // half we have. Leave those links in their normal state: neutral is
      // honest, grey is a claim. Title-form links are unaffected; they were
      // never resolvable against decks this device has not pulled anyway.
      if (!found && parts.id && !index.cloudComplete) {
        link.classList.remove("is-missing");
        continue;
      }
      link.classList.toggle("is-missing", !found);
    }
  }).catch((error) => console.warn("Could not check note links", error));
}

// Draws one batch of diagrams (mermaid and/or nomnoml). The source lives in
// data-diagram and is only written into the element here, at render time, so a
// deferred diagram never flashes its raw source on screen.
export async function renderDiagramNodes(nodes) {
  const mermaidNodes = nodes.filter((node) => node.classList.contains("mermaid"));
  const nomnomlNodes = nodes.filter((node) => node.classList.contains("nomnoml-diagram"));

  nodes.forEach((node) => {
    if (node.dataset.diagram) node.textContent = decodeURIComponent(node.dataset.diagram);
    node.removeAttribute("data-processed");
    node.classList.remove("is-diagram-pending");
  });

  if (mermaidNodes.length && await ensureMermaid()) {
    // One diagram mermaid can't lay out rejects the whole batch, so a bad
    // diagram must not take its neighbours' drawings down with it: retry the
    // batch one node at a time and let only the broken one fail.
    try {
      await mermaid.run({ nodes: mermaidNodes });
    } catch (error) {
      console.warn("Mermaid render failed", error);
      for (const node of mermaidNodes) {
        if (node.querySelector("svg")) continue;
        try {
          await mermaid.run({ nodes: [node] });
        } catch (nodeError) {
          console.warn("Mermaid render failed", nodeError);
        }
      }
    }
  }

  if (nomnomlNodes.length && await ensureNomnoml()) {
    nomnomlNodes.forEach((node) => {
      try {
        const printTheme = Boolean(node.closest(".print-root"));
        const svg = nomnoml.renderSvg(sourceWithNomnomlTheme(node.textContent, printTheme));
        node.classList.add("nomnoml-light-theme");
        node.innerHTML = svg;
        node.querySelector("svg")?.classList.add("nomnoml-light-svg");
        // The shell is created before the diagram is drawn now, so it can't pick
        // nomnoml's light background up from the class it used to wait for.
        if (node.parentElement?.classList.contains("diagram-shell")) {
          node.parentElement.classList.add("nomnoml-light-shell");
        }
      } catch (err) {
        console.warn("Nomnoml render error:", err);
        node.textContent = "Error rendering Nomnoml: " + err.message;
      }
    });
  }
}

// Notes frequently start at ## (or deeper) because the top-level # is reserved
// for a document title elsewhere. Promote the whole heading tree so the
// shallowest heading in the notes renders as <h1>: if the topmost level is ##,
// it becomes #, ### becomes ##, and so on. Every heading is shifted by the same
// amount, so the relative structure (and the derived TOC) is preserved. Only
// affects the rendered notes view — the raw markdown and card parsing are left
// untouched. Fenced code is skipped so a leading `#` in code isn't mistaken for
// a heading.
export function promoteNotesHeadings(markdown) {
  const lines = String(markdown || "").split("\n");
  const levels = new Array(lines.length).fill(0);
  let inFence = false;
  let fenceChar = "";
  let minLevel = 7;
  lines.forEach((line, i) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (line.trim().startsWith(fenceChar)) { inFence = false; }
      return;
    }
    if (inFence) return;
    const heading = line.match(/^(#{1,6})\s+\S/);
    if (heading) {
      levels[i] = heading[1].length;
      if (heading[1].length < minLevel) minLevel = heading[1].length;
    }
  });
  const shift = minLevel <= 6 ? minLevel - 1 : 0;
  if (shift <= 0) return String(markdown || "");
  return lines.map((line, i) => (levels[i] ? "#".repeat(levels[i] - shift) + line.slice(levels[i]) : line)).join("\n");
}

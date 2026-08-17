// Can you actually reach the end of a note in paged reading mode?
//
//   node tools/paged-check.mjs
//
// Paging is arithmetic over a real multi-column layout, so it cannot be checked
// as a pure function — the numbers only mean anything once a browser has broken
// the note into columns. This drives the real #notesView with a real note.
//
// The reported bug: "for dual column layout when I'm at the end of the note and
// there is only one column and not two column then I'm seeing problem". A note
// whose content stops partway through its final page leaves scrollWidth a
// FRACTIONAL multiple of clientWidth, and notesPageCount() used Math.round —
// so that page was rounded away. Everything downstream then agreed the note was
// a page shorter than it is: the End key and the ▸ button clamped early, the
// indicator disabled ▸, and scheduleNotesPageSettle snapped the reader back off
// the last page every time they swiped to it.
//
// The cases below therefore run at several note lengths, because whether the
// last page is full or half full is exactly what the bug depended on — a single
// fixture would have passed on the broken build about half the time.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);

function loadPuppeteer() {
  for (const base of [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) { console.log("paged-check: no puppeteer/Chrome — skipping."); process.exit(0); }

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

// Runs INSIDE the page.
const PROBE = `async (api) => {
  const results = [];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = document.getElementById("notesView");
  if (!view) return [{ name: "setup", ok: false, detail: "no #notesView in the page" }];

  // ── Get a real, laid-out notes stage ───────────────────────────────────
  //
  // Not optional, and not obvious: without this the app sits on its sign-in
  // screen, #notesView has clientWidth 0, and a zero-width multicol box reports
  // one page and zero scrollable width — so EVERY assertion below passes
  // vacuously. This check silently did exactly that until the widths were
  // printed. Anything that reduces the stage to zero width again must fail
  // loudly, hence the guard at the end of this block.
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("paged-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Paged fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(400);
  // A notes-mode deck opens straight into the RAW editor, which leaves
  // #notesView hidden (and therefore zero-width). Leaving the editor is what
  // puts the rendered view on screen — there is no other way in.
  api.commitNotesEditIfActive();
  await settle(400);
  if (!(view.clientWidth > 200)) {
    return [{ name: "setup", ok: false, detail: "#notesView is " + view.clientWidth + "px wide — the stage never became visible, so nothing below would mean anything" }];
  }

  // Section counts chosen from measured layouts so that BOTH shapes of last
  // page occur: ones that end flush on a page boundary and ones that end in the
  // first column of their last page. That distinction is the entire bug, and a
  // fixture set that happens to contain only flush endings passes on a build
  // with the defect — which the first version of this check did.
  const lengths = [10, 14, 17, 20, 26, 31, 40, 57];

  // One column and two. A column is a page in one-column mode, so its flow is
  // always a whole number of pages — it is here to prove the filler stays out
  // of a layout that never needs it.
  for (const mode of ["paged-1", "paged-2"]) {
  for (const n of lengths) {
    const body = Array.from({ length: n }, (_, i) =>
      // The heading is long enough to hold a selection of its own: the pin's
      // anchor in paged mode is the first block on the page, which is usually a
      // heading, and the jump this file guards against needs that block to be
      // the one highlighted.
      "## Section " + (i + 1) + " of the paged fixture note\\n\\nParagraph " + (i + 1) + " of this note. " +
      "It carries enough words to occupy a useful fraction of a column so that " +
      "the pagination has something real to break across pages.\\n"
    ).join("\\n");
    api.state.notes = "# Paged fixture\\n\\n" + body;
    await api.renderNotesView();
    api.setNotesReadingMode(mode);
    await settle(400);

    const label = mode + ", " + n + " sections";
    const check = (name, fn) => {
      try {
        const detail = fn();
        results.push({ name: label + " — " + name, ok: detail === true, detail: detail === true ? "" : String(detail) });
      } catch (e) {
        results.push({ name: label + " — " + name, ok: false, detail: "THREW: " + e.message });
      }
    };

    const pages = api.notesPageCount();
    const width = api.notesPageWidth();
    // Read off the DOM, not from the module — this check has to be runnable
    // against a build that predates notesMaxScrollLeft(), or it cannot show
    // that it catches the bug it was written for.
    const maxScroll = Math.max(0, view.scrollWidth - view.clientWidth);

    check("the page count covers the whole flow", () => {
      // Every pixel of the flow has to belong to some page. The old Math.round
      // could report a count whose last page ended BEFORE scrollWidth.
      if (pages * width < view.scrollWidth - 4) {
        return "scrollWidth " + view.scrollWidth + " exceeds " + pages + " pages x " + width;
      }
      return true;
    });

    check("the page count does not invent an empty page", () => {
      if (pages > 1 && (pages - 1) * width >= view.scrollWidth) {
        return "page " + (pages - 1) + " starts at or past scrollWidth " + view.scrollWidth;
      }
      return true;
    });

    // ── Go to the last page and stay there ────────────────────────────────
    api.goToNotesPage(pages - 1, { smooth: false });
    await settle(120);

    check("the last page is actually reached", () => {
      if (maxScroll <= 0) return true; // note fits on one page; nothing to reach
      if (view.scrollLeft < maxScroll - 4) {
        return "stopped at scrollLeft " + Math.round(view.scrollLeft) + " of " + Math.round(maxScroll);
      }
      return true;
    });

    check("the last page starts on a page boundary", () => {
      // THE end-of-note bug. A two-column note ending in its final page's first
      // column leaves the flow half a page short, so the furthest the box can
      // scroll stops half a page early: the reader turns to the end and gets
      // the previous page's right-hand column filling the left of the screen,
      // with the actual end of the note beside it. The page is reachable and
      // the last block is visible — which is why the weaker assertions above
      // pass on a build with this defect — but the page does not BEGIN where a
      // page begins.
      if (maxScroll <= 0) return true;
      const off = view.scrollLeft % width;
      if (Math.min(off, width - off) > 4) {
        return "last page starts " + Math.round(off) + "px into a " + Math.round(width) +
               "px page (flow is " + view.scrollWidth + ", " + pages + " pages)";
      }
      return true;
    });

    check("the indicator agrees we are on the last page", () => {
      const at = api.notesCurrentPage();
      if (at !== pages - 1) return "notesCurrentPage() says " + at + " of " + pages;
      return true;
    });

    check("the note's last block is on screen", () => {
      // The one the reader actually cares about: the end of the note has to be
      // visible once you have turned to the end of the note.
      const blocks = api.notesTopLevelBlocks(view);
      const last = blocks[blocks.length - 1];
      if (!last) return "the note rendered no blocks";
      const box = view.getBoundingClientRect();
      const rect = last.getBoundingClientRect();
      if (rect.right < box.left - 4 || rect.left > box.right + 4) {
        return "last block sits outside the viewport (block " + Math.round(rect.left) + "-" +
               Math.round(rect.right) + " vs view " + Math.round(box.left) + "-" + Math.round(box.right) + ")";
      }
      return true;
    });

    // ── The settle must not pull the reader back off it ───────────────────
    const landed = view.scrollLeft;
    api.scheduleNotesPageSettle();
    await settle(500);

    check("the settle leaves the last page alone", () => {
      if (Math.abs(view.scrollLeft - landed) > 4) {
        return "snapped from " + Math.round(landed) + " to " + Math.round(view.scrollLeft);
      }
      return true;
    });

    // ── And a page turn from the second-to-last still lands on the last ───
    if (pages > 1) {
      api.goToNotesPage(pages - 2, { smooth: false });
      await settle(120);
      api.turnNotesPage(1);
      // A page turn is a 260ms tween (PAGE_TURN_MS) followed by a 140ms settle
      // (SETTLE_MS). Reading the page number before both have finished measures
      // the animation, not the destination — which reads as a failure on a
      // perfectly good build.
      await settle(700);
      check("turning forward from the second-to-last reaches the last", () => {
        const at = api.notesCurrentPage();
        if (at !== pages - 1) return "landed on page " + at + " of " + pages;
        return true;
      });
    }

    // ── Highlighting must not turn the page ──────────────────────────────
    //
    // THE reported bug: "when I'm highlighting in the first column from left I
    // am noticing the jump, but in the right column I am not". Both columns are
    // exercised, because the asymmetry IS the symptom — a check that only
    // highlighted in column two would have passed on the broken build.
    //
    // Cause: in paged mode both reading-line resolvers answer
    // firstVisibleNotesBlock(), the block at the top of column ONE. Highlighting
    // that block rebuilds it, so the pin fell through to its previous sibling —
    // the last block of the PREVIOUS page — and paged backwards.
    if (pages > 2) {
      for (const column of [0, 1]) {
        if (column >= api.notesPagedColumns()) continue;
        api.goToNotesPage(1, { smooth: false });
        await settle(300);
        const before = view.scrollLeft;
        const picked = await (async () => {
          const box = view.getBoundingClientRect();
          const colWidth = box.width / api.notesPagedColumns();
          const lo = box.left + column * colWidth;
          const hi = lo + colWidth;
          // Column one starts at the PIN'S OWN anchor — firstVisibleNotesBlock()
          // is what blockAtNotesReadingLine() answers in paged mode, and the bug
          // needs the highlighted block to be that block: highlighting it
          // rebuilds it, which is what pushed the pin onto a neighbour living on
          // the previous page. Highlighting the paragraph BELOW the anchor
          // heading leaves the anchor connected and reproduces nothing.
          const anchor = column === 0 ? api.firstVisibleNotesBlock() : null;
          const candidates = anchor
            ? [anchor, ...api.notesTopLevelBlocks(view)]
            : api.notesTopLevelBlocks(view);
          for (const block of candidates) {
            const r = block.getBoundingClientRect();
            if (!r.width || r.left < lo - 4 || r.left >= hi) continue;
            // A text node long enough to hold a distinctive selection.
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
              if (node.nodeValue.trim().length > 30) {
                const range = document.createRange();
                range.setStart(node, 5);
                range.setEnd(node, 25);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return { text: range.toString() };
              }
              node = walker.nextNode();
            }
          }
          return null;
        })();
        const label2 = "highlighting in column " + (column + 1) + " does not turn the page";
        const fail = (detail) => results.push({ name: label + " — " + label2, ok: false, detail });
        if (!picked) { fail("no block in this column had text to select — nothing was tested"); continue; }
        const marksBefore = (api.state.notes.match(/<mark/g) || []).length;
        api.makeHighlightFromSelection(api.renderTargetConfig("notes"), "green");
        // Long enough for the repaint, the pin, and every re-aim attempt.
        await settle(1200);
        // A highlight that never landed cannot move the page, so without this
        // the case would pass for the wrong reason — the exact way the first
        // version of this file passed on a build with the bug in it.
        const marksAfter = (api.state.notes.match(/<mark/g) || []).length;
        if (marksAfter <= marksBefore) {
          fail("the highlight never applied (" + marksBefore + " marks before, " + marksAfter +
               " after) — the page could not have moved, so nothing was tested");
          continue;
        }
        const after = view.scrollLeft;
        results.push({
          name: label + " — " + label2,
          ok: Math.abs(after - before) <= 4,
          detail: Math.abs(after - before) <= 4 ? ""
            : "scrollLeft moved from " + Math.round(before) + " to " + Math.round(after) +
              " (" + Math.round((after - before) / width * 100) / 100 + " pages)"
        });
      }
    }

    check("the filler is only ever used where a page is short", () => {
      const filled = view.classList.contains("has-page-filler");
      if (mode === "paged-1" && filled) return "a one-column flow is always whole pages; nothing to fill";
      // With the filler applied the flow must now BE a whole number of pages.
      const off = view.scrollWidth % width;
      if (Math.min(off, width - off) > 4) {
        return "flow is still " + Math.round(off) + "px into a page (filler " + (filled ? "on" : "off") + ")";
      }
      return true;
    });
  }
  }

  // ── A book, not a note ───────────────────────────────────────────────────
  //
  // Paged mode used to refuse outright above 250,000 characters — "Note too long
  // for pages (4103KB) — scrolling instead" — because multi-column layout has to
  // measure everything it is given. It is now given one chapter at a time, so
  // these cases run at a size the old build would not even attempt.
  {
    const o = [];
    for (let c = 0; c < 60; c += 1) {
      o.push("# Chapter " + (c + 1) + "\\n");
      for (let p = 0; p < 60; p += 1) {
        o.push("Paragraph " + (p + 1) + " of chapter " + (c + 1) + ". " +
          "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(4) + "\\n");
      }
    }
    api.state.notes = "# A whole book\\n\\n" + o.join("\\n");
    await api.renderNotesView();
    api.setNotesReadingMode("paged-2");
    await settle(900);

    const big = (name, fn) => {
      try {
        const detail = fn();
        results.push({ name: "book — " + name, ok: detail === true, detail: detail === true ? "" : String(detail) });
      } catch (e) {
        results.push({ name: "book — " + name, ok: false, detail: "THREW: " + e.message });
      }
    };
    const wrappers = () => [...view.querySelectorAll(":scope > .notes-chunk")];
    const activeIdx = () => wrappers().findIndex((n) => n.classList.contains("is-active-chapter"));

    big("a note far past the old 250KB cap still pages", () => {
      if (api.state.notes.length < 400000) return "the fixture is only " + api.state.notes.length + " chars — it would not have tripped the cap";
      if (!view.classList.contains("is-paged")) return "paged mode refused a large note";
      if (getComputedStyle(view).columnCount !== "2") return "columnCount is " + getComputedStyle(view).columnCount + ", not 2";
      return true;
    });

    big("the note is split into chapters", () => {
      const w = wrappers();
      if (w.length < 10) return "expected many chapter wrappers, found " + w.length;
      if (w.length !== api.chapterIndexFor(api.state.notes).length) {
        return "wrappers (" + w.length + ") disagree with the chapter index (" + api.chapterIndexFor(api.state.notes).length + ")";
      }
      return true;
    });

    big("exactly one chapter is active", () => {
      const active = wrappers().filter((n) => n.classList.contains("is-active-chapter"));
      if (active.length !== 1) return active.length + " chapters are active";
      return true;
    });

    big("the other chapters are not laid out at all", () => {
      // THE point of the whole design: an inactive chapter costs no layout, so
      // the cost of paging a book is the cost of paging one chapter.
      const idle = wrappers().filter((n) => !n.classList.contains("is-active-chapter"));
      const sample = idle.slice(0, 5).map((n) => n.firstElementChild).filter(Boolean);
      if (!sample.length) return "no inactive chapter had a block to measure";
      const laidOut = sample.filter((b) => b.getBoundingClientRect().width > 0);
      if (laidOut.length) return laidOut.length + " of " + sample.length + " sampled inactive blocks are still laid out";
      return true;
    });

    // Onto a chapter with real content: chapter 0 is the title block alone, and
    // "is a chapter more than one page" asked of a one-block chapter answers no
    // for a reason that has nothing to do with paging.
    api.goToNotesChapter(1);
    await settle(400);
    big("a chapter is more than one page", () => {
      // Otherwise "turn to the next chapter" would be the only navigation there
      // is, and the paging assertions below would prove nothing.
      const pagesHere = api.notesPageCount();
      if (pagesHere < 2) return "the active chapter is only " + pagesHere + " page(s)";
      return true;
    });

    api.goToNotesPage(api.notesPageCount() - 1, { smooth: false });
    await settle(300);
    const wasAt = activeIdx();
    api.turnNotesPage(1);
    await settle(800);
    big("turning past a chapter's last page opens the next chapter", () => {
      const now = activeIdx();
      if (now !== wasAt + 1) return "went from chapter " + wasAt + " to " + now;
      if (Math.round(view.scrollLeft) > 4) return "landed " + Math.round(view.scrollLeft) + "px in, not on page 1";
      return true;
    });

    api.goToNotesPage(0, { smooth: false });
    await settle(300);
    const wasAt2 = activeIdx();
    api.turnNotesPage(-1);
    await settle(800);
    big("turning back before page 1 opens the previous chapter at its end", () => {
      const now = activeIdx();
      if (now !== wasAt2 - 1) return "went from chapter " + wasAt2 + " to " + now;
      const last = api.notesPageCount() - 1;
      const at = Math.round(view.scrollLeft / api.notesPageWidth());
      if (at !== last) return "landed on page " + at + " of " + (last + 1) + ", not the last";
      return true;
    });

    // THE regression that came with paging by chapter: a highlight in a chapter
    // that is not on screen is display:none, so it has no box, no page, and
    // "Go to" scrolled nowhere. Reported as "by rendering few chapters once a
    // time the highlighter go to is not working".
    api.goToNotesChapter(0);
    await settle(300);
    // Mark something deep in the book, well past the chapter on screen.
    api.state.notes = api.state.notes.replace(
      "Paragraph 5 of chapter 40.",
      "Paragraph 5 of chapter 40 <mark>find me here</mark>."
    );
    await api.renderNotesView();
    api.setNotesReadingMode("paged-2");
    await settle(700);
    api.goToNotesChapter(0);
    await settle(300);
    const marksNow = view.querySelectorAll("mark");
    const startedOn = activeIdx();
    if (marksNow.length) {
      api.revealNoteMark({ markIndex: 0, markCount: marksNow.length }, { flash: true, smooth: false });
      await settle(1200);
    }
    big("Go to reaches a highlight in another chapter", () => {
      if (!marksNow.length) return "no <mark> rendered, so nothing was tested";
      const mark = view.querySelectorAll("mark")[0];
      if (!mark) return "the mark vanished";
      const owner = mark.closest(".notes-chunk");
      if (!owner) return "the mark is not inside a chapter wrapper";
      if (!owner.classList.contains("is-active-chapter")) {
        return "the mark's chapter was never activated (still on chapter " + activeIdx() + ", started on " + startedOn + ")";
      }
      // ...and it is actually on screen, not merely in a displayed chapter.
      const box = view.getBoundingClientRect();
      const r = mark.getBoundingClientRect();
      if (!r.width) return "the mark has no box";
      if (r.right < box.left - 4 || r.left > box.right + 4) {
        return "the mark is off-screen (" + Math.round(r.left) + "-" + Math.round(r.right) + " vs view " + Math.round(box.left) + "-" + Math.round(box.right) + ")";
      }
      return true;
    });

    big("the indicator names the chapter", () => {
      const label = document.querySelector(".notes-page-label")?.textContent || "";
      // Checked without a regex on purpose: the backslash classes in one are
      // eaten by this template literal before the probe is ever parsed, which
      // turned the first attempt into a syntax error rather than a failing case.
      if (label.indexOf("Ch ") !== 0) return "label reads " + JSON.stringify(label);
      const sep = label.indexOf(" \u00b7 ");
      if (sep === -1) return "label has no page part: " + JSON.stringify(label);
      if (label.slice(3, sep).split("/").length !== 2) return "chapter part reads " + JSON.stringify(label.slice(3, sep));
      if (label.slice(sep + 3).split("/").length !== 2) return "page part reads " + JSON.stringify(label.slice(sep + 3));
      return true;
    });
  }

  // ── Tapping a highlight in the note ──────────────────────────────────────
  //
  // The controls for an existing highlight live on the mark, in the note —
  // "near the actual note itself, not in the highlight panel". Driven here as a
  // real click, because that is the gesture, and asserted on the SOURCE: what
  // matters is that the right mark changed.
  {
    api.setNotesReadingMode("continuous");
    await settle(200);
    // Two highlights with IDENTICAL text, so an implementation that searched by
    // words instead of by ordinal would have to guess — and would be caught.
    api.state.notes = "# Marks\\n\\nOne <mark>same words</mark> here.\\n\\nTwo <mark>same words</mark> here.";
    api.setNotesScrolledSource(null);
    await api.renderNotesView();
    await settle(500);

    const mk = (name, detail) => results.push({ name: "mark menu — " + name, ok: detail === true, detail: detail === true ? "" : String(detail) });
    mk("the note rendered both marks", view.querySelectorAll("mark").length === 2 ? true : "found " + view.querySelectorAll("mark").length);

    const second = view.querySelectorAll("mark")[1];
    if (second) second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(250);
    const menu = document.querySelector(".mark-menu");
    mk("tapping a highlight opens its menu", menu && !menu.hidden ? true : "no menu appeared");

    mk("the menu marks the colour it already is", (() => {
      if (!menu || menu.hidden) return "no menu";
      const current = menu.querySelectorAll(".mark-menu-swatch.is-current").length;
      if (current !== 1) return current + " swatches marked current";
      return true;
    })());

    const green = menu ? menu.querySelector("[data-mark-color=" + JSON.stringify("green") + "]") : null;
    if (green) green.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settle(700);
    mk("recolouring changes the mark that was tapped, not the first one", (() => {
      const src = api.state.notes;
      const first = src.indexOf("<mark");
      const rest = src.indexOf("<mark", first + 1);
      if (rest === -1) return "a mark disappeared: " + JSON.stringify(src);
      if (src.slice(first, first + 40).indexOf("green") !== -1) return "the FIRST mark was recoloured";
      if (src.slice(rest, rest + 40).indexOf("green") === -1) return "the second mark was not recoloured: " + JSON.stringify(src.slice(rest, rest + 40));
      return true;
    })());

    mk("the menu closes after acting", (() => {
      const m2 = document.querySelector(".mark-menu");
      return !m2 || m2.hidden ? true : "the menu stayed open";
    })());

    const again = view.querySelectorAll("mark")[1];
    if (again) again.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(250);
    const menu2 = document.querySelector(".mark-menu");
    const rm = menu2 ? menu2.querySelector(".mark-menu-remove") : null;
    if (rm) rm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await settle(700);
    mk("removing a highlight keeps its words", (() => {
      const src = api.state.notes;
      if ((src.match(/<mark/g) || []).length !== 1) return "expected one mark left, source is " + JSON.stringify(src);
      if (src.indexOf("Two same words here.") === -1) return "the words were removed with the mark: " + JSON.stringify(src);
      return true;
    })());
  }

  api.setNotesReadingMode("continuous");
  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/notes/paged-view.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"),
    import("/src/render/block-cache.js?v=__BUILD__"),
    import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"),
    import("/src/cloud/supabase-client.js?v=__BUILD__"),
    import("/src/cards/new-deck.js?v=__BUILD__"),
    import("/src/boot.js?v=__BUILD__"),
    import("/src/format/highlight.js?v=__BUILD__"),
    import("/src/format/render-toolbar.js?v=__BUILD__"),
    import("/src/notes/chapters.js?v=__BUILD__"),
    import("/src/notes/anchors.js?v=__BUILD__"),
    import("/src/core/state.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// One full attempt: fresh browser, fresh page, run the probe. Returns null when
// the libraries are unavailable (a skip, not a failure).
async function attempt(base, errors) {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (e) => errors.push(e.message));
    // BEFORE navigation, not after. index.html pulls marked/DOMPurify/KaTeX from
    // a CDN, and injecting them once the page has already loaded is too late:
    // the app's own boot has run by then, thrown on the missing globals, and
    // left half its wiring undone — initToolbars in particular, which is what
    // builds the raw editor's highlight mirror. Everything measured here then
    // measures an app that never finished starting. Same evaluateOnNewDocument
    // + request-abort pair tools/ui-smoke.mjs uses, for the same reason.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    // index.html pulls marked/DOMPurify from a CDN, so without the clipper's
    // vendored copies this check would depend on the network being up — which
    // says nothing about whether pagination is right. Same hermetic injection
    // behaviour-parity uses.
    // KaTeX too: rendering a note reaches for renderMathInElement, and without
    // it every render throws inside enhance.js. Harmless for pagination, but it
    // fills the transcript with errors that hide a real one.
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 })
      .catch(() => {});
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) return null;
    // The app boots asynchronously; paging needs the notes stage laid out.
    await new Promise((r) => setTimeout(r, 2500));
    return await page.evaluate(
      async (probeSrc, apiSrc) => {
        const api = await (0, eval)(apiSrc)();
        return await (0, eval)("(" + probeSrc + ")")(api);
      },
      PROBE, API_SRC
    );
  } finally {
    await browser.close();
  }
}

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  await new Promise((r) => setTimeout(r, 800));

  // Retried once. Everything this measures is layout, and launching a second
  // Chrome right after several other browser checks have just exited
  // occasionally fails to come up at all — a flake that says nothing about
  // pagination. A real failure reproduces on the second attempt; a launch that
  // never happened does not. Only the LAUNCH is retried: a probe that ran and
  // reported failures is returned as-is.
  const errors = [];
  let results = null;
  let launchError = null;
  for (let tries = 0; tries < 2 && results == null; tries += 1) {
    if (tries) await new Promise((r) => setTimeout(r, 1500));
    try {
      results = await attempt(server.base, errors);
      if (results == null) {
        console.log("  SKIPPED: marked/DOMPurify unavailable (no CDN and no vendored copy)");
        process.exit(0);
      }
    } catch (e) {
      launchError = e;
    }
  }
  if (results == null) throw launchError || new Error("paged-check could not run");

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} paged cases · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}

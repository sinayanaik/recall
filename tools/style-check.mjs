// Do the Style panel's settings actually reach the thing they name?
//
//   node tools/style-check.mjs
//
// A style control is four separate pieces — a default in each profile, a field
// in a control group, sometimes an entry in styleCssVariables, sometimes a
// hand-written line in applyStyleSettings — and getting three of them right
// produces a control that moves and changes nothing. That has happened here
// before: the code-size slider wrote a variable no rule read, and the base font
// picker was overridden by three per-face pickers that all defaulted to the
// same value, so it appeared to do nothing to any card or note.
//
// So this asserts the end of the chain, in a real browser: set the setting,
// read the computed style of the element it is supposed to control, and check
// that the elements it is NOT supposed to control did not move.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Chrome comes from tools/browser.mjs, which drives it over the DevTools
// protocol rather than through puppeteer. This used to be a hard-coded list of
// five /usr/bin paths plus a puppeteer under one person's nvm directory, and on
// any machine that matched neither — every container, every CI runner — the
// guard below printed "skipping." and exited 0, which the suite scored as a
// pass. See tools/browser.mjs for the whole story.
const CHROME = findChrome();

if (!CHROME) {
  // Not a skip: a check that cannot run has not passed. tools/check.mjs counts
  // this as a failure and names it.
  console.error("style-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

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

const PROBE = `async (api) => {
  const results = [];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const push = (name, detail) => results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("style-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Style fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(200);
  api.commitNotesEditIfActive();
  await settle(200);
  api.state.notes = "# Style fixture\\n\\nA paragraph of notes text to measure.\\n";
  await api.renderNotesView();
  await settle(400);

  const notes = document.getElementById("notesView");
  const question = document.getElementById("questionView");
  if (!notes) return [{ name: "setup", ok: false, detail: "no #notesView" }];

  const profile = api.detectStyleProfile();
  const fontOf = (node) => (node ? getComputedStyle(node).fontFamily : "");
  const setNotesFont = async (value) => {
    api.setStyleProfileSettings(profile, { ...api.getStyleProfileSettings(profile), notesFontFamily: value });
    api.applyActiveStyleSettings({ force: true });
    await settle(200);
  };

  // ── The default must be exactly today's behaviour ────────────────────────
  await setNotesFont("inherit");
  const inheritedNotes = fontOf(notes);
  const appFont = getComputedStyle(document.documentElement).getPropertyValue("--app-font-family").trim();
  push("the default follows the app font", (() => {
    if (!appFont) return "--app-font-family is unset";
    // The notes resolve to whatever the app font is; comparing the first family
    // is enough and survives the browser re-quoting the stack.
    const first = (s) => s.split(",")[0].replace(/["']/g, "").trim().toLowerCase();
    if (first(inheritedNotes) !== first(appFont)) {
      return "notes font is " + JSON.stringify(first(inheritedNotes)) + " but the app font is " + JSON.stringify(first(appFont));
    }
    return true;
  })());

  // ── An explicit choice reaches the notes ─────────────────────────────────
  const questionBefore = fontOf(question);
  await setNotesFont("serif");
  push("choosing a notes font changes the notes", (() => {
    const now = fontOf(notes);
    if (!/georgia|times/i.test(now)) return "notes font is still " + JSON.stringify(now.slice(0, 60));
    return true;
  })());

  push("choosing a notes font leaves the card faces alone", (() => {
    const now = fontOf(question);
    if (question && now !== questionBefore) {
      return "the question face changed from " + JSON.stringify(questionBefore.slice(0, 40)) + " to " + JSON.stringify(now.slice(0, 40));
    }
    return true;
  })());

  // ── And it is a stored setting, not a one-off write ──────────────────────
  push("the choice survives normalisation", (() => {
    const stored = api.normalizeStyleSettings({ ...api.getStyleProfileSettings(profile) }, profile);
    if (stored.notesFontFamily !== "serif") return "normalised to " + JSON.stringify(stored.notesFontFamily);
    return true;
  })());

  push("an older stored profile back-fills to inherit", (() => {
    // A device that saved its settings before this control existed has no such
    // key. It must come back as "inherit" — i.e. unchanged rendering — rather
    // than as undefined, which would write the string "undefined" into CSS.
    const legacy = { ...api.getStyleProfileSettings(profile) };
    delete legacy.notesFontFamily;
    const filled = api.normalizeStyleSettings(legacy, profile);
    if (filled.notesFontFamily !== "inherit") return "back-filled to " + JSON.stringify(filled.notesFontFamily);
    return true;
  })());

  // ── The panel actually offers it ─────────────────────────────────────────
  push("the control appears in the Style panel", (() => {
    const field = api.styleFieldByKey.notesFontFamily;
    if (!field) return "notesFontFamily is in no control group, so nothing renders it";
    if (field.type !== "select") return "expected a select, got " + field.type;
    if (!field.options.includes("inherit")) return "the options do not include 'inherit'";
    return true;
  })());

  await setNotesFont("inherit");

  // ── The highlights pane, which had no settings at all ────────────────────
  //
  // It claimed in its own stylesheet to inherit the Notes scale and did not:
  // --notes-font-size and its siblings are read by one rule (.notes-rendered)
  // and the pane is not inside it, so a reader who had tuned Notes to their eyes
  // found this surface untouched by any of it. Two things to assert, and they
  // are the two halves of every control in this file: the default is exactly
  // today's rendering, and an explicit choice reaches the thing it names and
  // nothing else.
  const setHighlightStyle = async (patch) => {
    api.setStyleProfileSettings(profile, { ...api.getStyleProfileSettings(profile), ...patch });
    api.applyActiveStyleSettings({ force: true });
    await settle(200);
  };
  const card = document.createElement("div");
  card.className = "hl-notes";
  card.innerHTML = '<section class="hl-notes-group"><article class="hl-note"><div class="hl-note-body rendered">note</div></article></section>';
  document.body.appendChild(card);
  try {
    const cardBody = card.querySelector(".hl-note");
    const px = (node, prop) => parseFloat(getComputedStyle(node)[prop]) || 0;

    await setHighlightStyle({ hlNoteFontSize: "inherit", hlCardPadding: "11px" });
    const inheritedSize = px(card, "fontSize");
    const notesSize = px(notes, "fontSize");
    push("the pane's default type IS the Notes type", (() => {
      // Not "close to": the fallback in the stylesheet is literally
      // var(--notes-font-size), so this is an equality or the wiring is wrong.
      if (Math.abs(inheritedSize - notesSize) > 0.5) {
        return "the pane is at " + inheritedSize + "px while the notes are at " + notesSize + "px";
      }
      return true;
    })());

    const notesBefore = px(notes, "fontSize");
    await setHighlightStyle({ hlNoteFontSize: "31px", hlCardPadding: "27px" });
    push("a Highlights setting reaches the pane", (() => {
      if (Math.abs(px(card, "fontSize") - 31) > 0.5) return "the pane is at " + px(card, "fontSize") + "px, expected 31";
      if (Math.abs(px(cardBody, "paddingTop") - 27) > 0.5) return "card padding is " + px(cardBody, "paddingTop") + "px, expected 27";
      return true;
    })());

    push("...and reaches nothing else", (() => {
      if (Math.abs(px(notes, "fontSize") - notesBefore) > 0.5) {
        return "the notes moved from " + notesBefore + "px to " + px(notes, "fontSize") + "px";
      }
      return true;
    })());

    // ...and back. "inherit" is expressed by REMOVING the property, not by
    // writing the word — a literal "font-size: inherit" on .hl-notes would
    // inherit from the pane around it, which is a different and wrong answer.
    await setHighlightStyle({ hlNoteFontSize: "inherit" });
    push("resetting to inherit hands the pane back to the Notes scale", (() => {
      if (document.documentElement.style.getPropertyValue("--hl-note-font-size")) {
        return "--hl-note-font-size was written as " + JSON.stringify(document.documentElement.style.getPropertyValue("--hl-note-font-size"));
      }
      if (Math.abs(px(card, "fontSize") - px(notes, "fontSize")) > 0.5) {
        return "the pane is at " + px(card, "fontSize") + "px against the notes' " + px(notes, "fontSize") + "px";
      }
      return true;
    })());

    push("every Highlights control is in a group the panel renders", (() => {
      const keys = ["hlNoteFontSize", "hlNoteLineHeight", "hlNoteWeight", "hlQuoteFontSize",
        "hlQuoteInkPercent", "hlCardPadding", "hlCardGap", "hlCardRadius", "hlCardRail", "hlNoteEmptyHeight"];
      const missing = keys.filter((key) => !api.styleFieldByKey[key]);
      if (missing.length) return "no control renders " + missing.join(", ");
      // ...and every one of them is a stored setting in both profiles, or it
      // resets to undefined the first time somebody presses ↺.
      const gone = keys.filter((key) => !(key in api.defaultStyleProfiles.desktop) || !(key in api.defaultStyleProfiles.mobile));
      if (gone.length) return "no stored default for " + gone.join(", ");
      return true;
    })());
  } finally {
    card.remove();
    await setHighlightStyle({
      hlNoteFontSize: "inherit",
      hlCardPadding: api.defaultStyleProfiles[profile].hlCardPadding
    });
  }

  // ── The panel is three sections and a fold ───────────────────────────────
  api.updateStyleControls();
  const controls = document.getElementById("styleControls");
  push("the panel renders Global, Text, Spacing & controls and More", (() => {
    const sections = [...controls.querySelectorAll("[data-style-section]")].map((node) => node.dataset.styleSection);
    if (sections.join(",") !== "global,text,spacing,more") return "sections are " + JSON.stringify(sections);
    if (controls.querySelector('[data-style-section="more"]').open) return "More starts open";
    return true;
  })());

  push("each Text tab holds exactly its own fields, one tab shown at a time", (() => {
    const problems = [];
    for (const group of api.styleControlGroups.filter((g) => g.section === "text")) {
      const body = controls.querySelector('[data-style-tab-body="' + group.tab + '"]');
      if (!body) { problems.push("no body for " + group.tab); continue; }
      const keys = [...body.querySelectorAll("[data-style-key]")].map((node) => node.dataset.styleKey).join(",");
      if (keys !== group.fields.map((f) => f.key).join(",")) problems.push(group.tab + " holds " + keys);
    }
    api.setStyleTextTab("notes");
    const shown = [...controls.querySelectorAll("[data-style-tab-body]")].filter((node) => !node.hidden).map((node) => node.dataset.styleTabBody);
    if (shown.join(",") !== "notes") problems.push("showing " + JSON.stringify(shown) + " after choosing notes");
    return problems.length ? problems.join(" · ") : true;
  })());

  // ── A tab's code and raw-editor sizes are its own ────────────────────────
  const notesPre = document.createElement("pre");
  notesPre.textContent = "x = 1";
  notes.appendChild(notesPre);
  const cardPre = document.createElement("pre");
  cardPre.textContent = "x = 1";
  question.appendChild(cardPre);
  const notesEdit = document.getElementById("notesEdit");
  const questionEdit = document.getElementById("questionEdit");
  const size = (node) => parseFloat(getComputedStyle(node).fontSize) || 0;
  const original = { ...api.getStyleProfileSettings(profile) };
  try {
    await setHighlightStyle({ notesCodeFontSize: "29px", codeFontSize: "13px", notesRawFontSize: "27px", rawMarkdownFontSize: "15px" });
    push("Notes code size reaches notes code and not card code", (() => {
      if (Math.abs(size(notesPre) - 29) > 0.5) return "notes code is " + size(notesPre) + "px, expected 29";
      if (Math.abs(size(cardPre) - 13) > 0.5) return "card code is " + size(cardPre) + "px, expected 13";
      return true;
    })());
    push("Notes raw editor size reaches the notes editor and not the card editor", (() => {
      if (!notesEdit || !questionEdit) return "missing #notesEdit or #questionEdit";
      if (Math.abs(size(notesEdit) - 27) > 0.5) return "notes editor is " + size(notesEdit) + "px, expected 27";
      if (Math.abs(size(questionEdit) - 15) > 0.5) return "card editor is " + size(questionEdit) + "px, expected 15";
      return true;
    })());

    await setHighlightStyle({ uiFontSize: "20px" });
    push("Interface size sets the root font size", (() => {
      const got = size(document.documentElement);
      return Math.abs(got - 20) > 0.5 ? "html is " + got + "px, expected 20" : true;
    })());
  } finally {
    notesPre.remove();
    cardPre.remove();
    await setHighlightStyle(original);
  }

  // ── "Follow Notes" is an empty box, not a magic word ─────────────────────
  api.setStyleTextTab("highlights");
  api.updateStyleControls();
  const hlSize = controls.querySelector('[data-style-key="hlNoteFontSize"]');
  push("a follows-Notes box is empty and its placeholder says what it follows", (() => {
    if (!hlSize) return "no hlNoteFontSize box";
    if (hlSize.value !== "") return "the box shows " + JSON.stringify(hlSize.value);
    const notesSize = api.getStyleProfileSettings(profile).notesFontSize;
    if (!hlSize.placeholder.includes("Notes") || !hlSize.placeholder.includes(notesSize)) return "placeholder is " + JSON.stringify(hlSize.placeholder);
    return true;
  })());
  push("clearing a follows-Notes box puts it back to following", (() => {
    hlSize.value = "24px";
    hlSize.dispatchEvent(new Event("input", { bubbles: true }));
    if (api.getStyleProfileSettings(profile).hlNoteFontSize !== "24px") return "typing 24px stored " + api.getStyleProfileSettings(profile).hlNoteFontSize;
    hlSize.focus();
    hlSize.value = "";
    hlSize.dispatchEvent(new Event("input", { bubbles: true }));
    hlSize.blur();
    if (hlSize.value !== "") return "after clearing, the box shows " + JSON.stringify(hlSize.value);
    if (api.getStyleProfileSettings(profile).hlNoteFontSize !== "inherit") return "stored " + api.getStyleProfileSettings(profile).hlNoteFontSize;
    if (document.documentElement.style.getPropertyValue("--hl-note-font-size")) return "--hl-note-font-size is still written";
    return true;
  })());
  push("the notes font offers 'Same as Global font', not 'Inherit'", (() => {
    const option = controls.querySelector('[data-style-key="notesFontFamily"] option[value="inherit"]');
    return option?.textContent === "Same as Global font" ? true : "the option reads " + JSON.stringify(option?.textContent);
  })());

  // ── No caps: what is typed is what is drawn ──────────────────────────────
  try {
    await setHighlightStyle({ appWidthPercent: "130", modalWidthPercent: "1500px", notesMaxWidthPercent: "40ch", notesFontWeight: "350", toolbarButtonHeight: "20px" });
    const rootStyle = document.documentElement.style;
    push("layout boxes take a percent or any CSS length, uncapped", (() => {
      const problems = [];
      if (rootStyle.getPropertyValue("--app-width").trim() !== "130vw") problems.push("--app-width " + rootStyle.getPropertyValue("--app-width"));
      if (rootStyle.getPropertyValue("--modal-width").trim() !== "1500px") problems.push("--modal-width " + rootStyle.getPropertyValue("--modal-width"));
      if (rootStyle.getPropertyValue("--notes-max-width").trim() !== "40ch") problems.push("--notes-max-width " + rootStyle.getPropertyValue("--notes-max-width"));
      const shell = document.querySelector(".app-shell");
      const wanted = window.innerWidth * 1.3;
      if (shell && Math.abs(shell.getBoundingClientRect().width - wanted) > 2) problems.push("the app is " + shell.getBoundingClientRect().width + "px wide, expected " + wanted);
      return problems.length ? problems.join(" · ") : true;
    })());
    push("a weight outside the old 300–900 list is applied", (() => {
      const weight = getComputedStyle(notes).fontWeight;
      return weight === "350" ? true : "notes weight is " + weight;
    })());
    push("the replay row has no floor under Button height", (() => {
      const got = getComputedStyle(document.documentElement).getPropertyValue("--replay-button-height").trim();
      return got.includes("max(") ? "still wrapped: " + got : true;
    })());
  } finally {
    await setHighlightStyle(original);
  }

  // ── Density only touches spacing and controls ────────────────────────────
  push("every density preset writes only Spacing & controls fields", (() => {
    const spacingKeys = new Set(api.styleControlGroups.filter((g) => g.section === "spacing").flatMap((g) => g.fields.map((f) => f.key)));
    const stray = [];
    for (const byDensity of Object.values(api.styleDensityPresets)) {
      for (const preset of Object.values(byDensity)) {
        for (const key of Object.keys(preset)) if (!spacingKeys.has(key)) stray.push(key);
      }
    }
    return stray.length ? "outside Spacing & controls: " + [...new Set(stray)].join(", ") : true;
  })());

  // ── The v5 upgrade ───────────────────────────────────────────────────────
  push("a v4 profile keeps its own spacing, tightens inherited spacing, and seeds the notes sizes", (() => {
    const v4 = { version: 4, desktop: { ...api.defaultStyleProfiles.desktop, appGap: "10px", cardPadding: "30px", rawMarkdownFontSize: "21px", codeFontSize: "17px", codeLineHeight: "1.3" }, mobile: { ...api.defaultStyleProfiles.mobile } };
    for (const key of ["notesRawFontSize", "notesCodeFontSize", "notesCodeLineHeight"]) { delete v4.desktop[key]; delete v4.mobile[key]; }
    const out = api.normalizeStyleProfiles(v4).desktop;
    const problems = [];
    if (out.appGap !== api.defaultStyleProfiles.desktop.appGap) problems.push("appGap stayed " + out.appGap);
    if (out.cardPadding !== "30px") problems.push("a chosen cardPadding became " + out.cardPadding);
    if (out.notesRawFontSize !== "21px") problems.push("notesRawFontSize is " + out.notesRawFontSize);
    if (out.notesCodeFontSize !== "17px") problems.push("notesCodeFontSize is " + out.notesCodeFontSize);
    if (out.notesCodeLineHeight !== "1.3") problems.push("notesCodeLineHeight is " + out.notesCodeLineHeight);
    const again = api.normalizeStyleProfiles({ ...api.normalizeStyleProfiles(v4), desktop: { ...out, appGap: "10px" } }).desktop;
    if (again.appGap !== "10px") problems.push("a v5 profile's 10px appGap was rewritten to " + again.appGap);
    return problems.length ? problems.join(" · ") : true;
  })());
  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/ui/style-settings.js?v=__BUILD__"),
    import("/src/ui/style-schema.js?v=__BUILD__"),
    import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"),
    import("/src/cloud/supabase-client.js?v=__BUILD__"),
    import("/src/cards/new-deck.js?v=__BUILD__"),
    import("/src/boot.js?v=__BUILD__"),
    import("/src/core/state.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  await new Promise((r) => setTimeout(r, 800));

  const errors = [];
  const browser = await launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"]
  });
  let results;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    // No .catch() here. A page that never boots is the loudest failure this
    // check can find, and swallowing the rejection turned it into the quietest:
    // the next line asks whether marked and DOMPurify are present, a dead page
    // has neither, and the answer was "skipped" rather than "the app did not
    // start".
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    // marked and DOMPurify are VENDORED and same-origin now (vendor/marked-14.1.2,
    // vendor/dompurify-3.1.6) — that is the whole point of 3c4b8e2 and of
    // tools/offline-check.mjs. "Unavailable" was a real possibility while they
    // were CDN <script> tags; today it means the page is broken, so this fails
    // rather than returning a null that reads as "nothing to report".
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      throw new Error("marked/DOMPurify never loaded — they are vendored and same-origin, so the page is broken");
    }
    await new Promise((r) => setTimeout(r, 2000));
    results = await page.evaluate(
      async (probeSrc, apiSrc) => {
        const api = await (0, eval)(apiSrc)();
        return await (0, eval)("(" + probeSrc + ")")(api);
      },
      PROBE, API_SRC
    );
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} style cases · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}

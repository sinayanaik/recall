// A browser, for the checks that ask puppeteer for one.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Sixteen checks in this directory begin with some version of:
//
//     function loadPuppeteer() {
//       const candidates = [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"];
//       ...
//     }
//     const CHROME = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
//                     "/usr/bin/chromium-browser", "/usr/bin/chromium",
//                     "/snap/bin/chromium"].find(existsSync);
//     if (!puppeteer || !CHROME) { console.log("…: no puppeteer/Chrome — skipping."); process.exit(0); }
//
// Neither half is portable. The puppeteer path is one person's nvm directory;
// the Chrome list is five absolute paths and honours no environment variable,
// so a machine whose browser lives anywhere else — every container, every CI
// runner, this repo's own dev environment — matches nothing. Both guards then
// print a sentence and exit 0, which the suite scored as a pass. Twelve checks
// were in that state, and among them was every end-to-end one this repo has:
// ui-smoke, selection, highlight, style, paged, ribbon, boot-check, behaviour,
// sync, reconcile, interaction, and offline — the last of which exists because
// the app once shipped unable to launch without a network and nothing noticed.
//
// tools/cdp.mjs already solved this correctly for the thirteen checks written
// after it: it speaks the DevTools protocol over Node 22's global WebSocket,
// finds Chrome by searching including CHROME_PATH and Playwright's bundled
// build, and needs nothing installed. Its own header says why — "a check that
// skips is a check that never catches anything."
//
// So rather than rewrite sixteen large files onto that API, this presents the
// slice of puppeteer's surface they actually use, over the same transport. Each
// of them then changes one line, and this repo still has no npm dependency of
// any kind, which is a property it goes to some length to keep (see vendor/).
//
// ── What it is not ──────────────────────────────────────────────────────────
//
// It is not puppeteer. It is the twenty-odd methods the checks in this
// directory call, and it is deliberately shaped so that an unimplemented one
// throws by name rather than resolving to undefined and being mistaken for a
// result. If a new check needs more of the protocol, prefer writing it against
// tools/cdp.mjs directly — that is the native surface, and this is a bridge for
// what was already written.

import { readFileSync, writeFileSync } from "node:fs";
import { connect, findChrome, launchChrome } from "./cdp.mjs";

export { findChrome };

// Arguments are passed as ARGUMENTS (Runtime.callFunctionOn), not spliced into
// the source as JSON literals.
//
// The first draft did splice, the way tools/cdp.mjs's own evaluate does, and it
// worked for every call that passes a number or a short string — which is most
// of them, and is why the fault took a while to surface. tools/highlight-check.mjs
// passes its 57KB probe SOURCE as an argument, and a source string spliced into
// a source string has to survive being re-parsed as part of a larger program.
// It did not: "SyntaxError: Invalid or unexpected token", from inside the page,
// with no indication of which of the two nested evals had failed.
//
// callFunctionOn hands the string to the page as a value, so it is never parsed
// at all. It is what puppeteer does, for this reason.
const arg = (v) => (v === undefined ? { value: null } : { value: v });

// A stand-in for puppeteer's JSHandle, carrying the value the wait resolved
// with. Only .jsonValue() is used here (offline-check reads the signed-out chip
// out of one), and anything else is better written as a second evaluate.
function handle(value) {
  return {
    async jsonValue() { return value; },
    async dispose() {},
    toString() { return `JSHandle(${JSON.stringify(value)?.slice(0, 60)})`; }
  };
}

const RESOURCE_TYPES = {
  Document: "document", Stylesheet: "stylesheet", Image: "image", Media: "media",
  Font: "font", Script: "script", XHR: "xhr", Fetch: "fetch", Other: "other"
};

async function makePage(client, browserState) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => client.send(method, params, sessionId);

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");

  const listeners = new Map(); // event name -> Set(handler)
  const emit = (name, payload) => {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      // A listener that throws must not take the socket's message pump with it.
      try { fn(payload); } catch (error) { browserState.listenerErrors.push(error); }
    }
  };

  // Network.loadingFailed carries only a requestId, so the URL has to be
  // remembered from the requestWillBeSent that opened it. Kept small: entries
  // are dropped as soon as the request finishes or fails.
  const inFlight = new Map();
  let pendingRequests = 0;
  let lastActivityAt = Date.now();

  let intercepting = false;

  const off = client.on((message) => {
    if (message.sessionId !== sessionId) return;
    const p = message.params || {};
    switch (message.method) {
      case "Runtime.consoleAPICalled":
        emit("console", {
          type: () => p.type,
          text: () => (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || "")).join(" ")
        });
        break;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails || {};
        const error = new Error(d.exception?.description || d.text || "page error");
        emit("pageerror", error);
        break;
      }
      case "Page.javascriptDialogOpening":
        emit("dialog", {
          type: () => p.type,
          message: () => p.message,
          dismiss: () => call("Page.handleJavaScriptDialog", { accept: false }),
          accept: (text) => call("Page.handleJavaScriptDialog", { accept: true, promptText: text })
        });
        break;
      case "Network.requestWillBeSent":
        inFlight.set(p.requestId, p.request?.url || "");
        pendingRequests += 1;
        lastActivityAt = Date.now();
        break;
      case "Network.loadingFinished":
      case "Network.requestServedFromCache":
        if (inFlight.delete(p.requestId)) pendingRequests -= 1;
        lastActivityAt = Date.now();
        break;
      case "Network.loadingFailed": {
        const url = inFlight.get(p.requestId) || "";
        if (inFlight.delete(p.requestId)) pendingRequests -= 1;
        lastActivityAt = Date.now();
        emit("requestfailed", { url: () => url, failure: () => ({ errorText: p.errorText || "failed" }) });
        break;
      }
      case "Fetch.requestPaused": {
        const requestId = p.requestId;
        let settled = false;
        const request = {
          url: () => p.request.url,
          method: () => p.request.method,
          headers: () => p.request.headers || {},
          resourceType: () => RESOURCE_TYPES[p.resourceType] || "other",
          continue: () => {
            if (settled) return Promise.resolve();
            settled = true;
            return call("Fetch.continueRequest", { requestId }).catch(() => {});
          },
          abort: () => {
            if (settled) return Promise.resolve();
            settled = true;
            return call("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
          },
          respond: ({ status = 200, contentType = "text/plain", body = "" } = {}) => {
            if (settled) return Promise.resolve();
            settled = true;
            return call("Fetch.fulfillRequest", {
              requestId,
              responseCode: status,
              responseHeaders: [{ name: "content-type", value: contentType }],
              body: Buffer.from(body).toString("base64")
            }).catch(() => {});
          }
        };
        const handlers = listeners.get("request");
        if (!handlers || !handlers.size) {
          // Interception on with nobody listening would stall every request.
          // Puppeteer stalls too; a check that meant to do that says so by
          // registering a handler that returns, which is what offline-check
          // does to reproduce a CDN that hangs rather than refuses.
          request.continue();
          break;
        }
        emit("request", request);
        break;
      }
      default:
        break;
    }
  });

  // Resolve when a given page lifecycle event fires. Used by goto and reload.
  const onceLifecycle = (method, timeout, label) => new Promise((resolve, reject) => {
    const stop = client.on((message) => {
      if (message.sessionId !== sessionId || message.method !== method) return;
      clearTimeout(deadline);
      stop();
      resolve();
    });
    const deadline = setTimeout(() => { stop(); reject(new Error(`timed out waiting for ${label}`)); }, timeout);
  });

  // networkidle2: puppeteer's rule is "no more than 2 connections for 500ms".
  const networkIdle = async (timeout) => {
    const until = Date.now() + timeout;
    for (;;) {
      if (pendingRequests <= 2 && Date.now() - lastActivityAt > 500) return;
      if (Date.now() > until) return; // idle is best-effort; the load already fired
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // ── Which execution context to call into ────────────────────────────────
  //
  // Runtime.callFunctionOn needs one, and a navigation replaces it. Runtime is
  // already enabled above, so the events arrive without asking: keep the id of
  // the page's own default context, and forget it when the page throws its
  // contexts away. Without the invalidation, the first evaluate after a
  // page.goto would be made against a context that no longer exists — which
  // fails as "Cannot find context with specified id", i.e. loudly, but only
  // once somebody navigates twice.
  let currentContextId = null;
  client.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.executionContextCreated") {
      const ctx = message.params?.context;
      if (ctx?.auxData?.isDefault) currentContextId = ctx.id;
    } else if (message.method === "Runtime.executionContextsCleared") {
      currentContextId = null;
    } else if (message.method === "Runtime.executionContextDestroyed") {
      if (message.params?.executionContextId === currentContextId) currentContextId = null;
    }
  });

  // The context id, waiting briefly for one if a navigation has just cleared it.
  async function contextId() {
    for (let i = 0; i < 200 && currentContextId == null; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (currentContextId == null) throw new Error("no execution context in the page");
    return currentContextId;
  }

  // One line, not a stack: the checks print this as a case's detail. The whole
  // description is worth having when the failure is a SyntaxError raised by an
  // eval INSIDE the page, where the first line is just "SyntaxError: Invalid or
  // unexpected token" and says nothing about where — so RECALL_CDP_VERBOSE=1
  // keeps it.
  function pageError(details) {
    const full = String(details.exception?.description || details.text || "evaluation failed");
    return new Error(process.env.RECALL_CDP_VERBOSE ? full : full.split("\n")[0]);
  }

  const mouseState = { buttons: 0, x: 0, y: 0 };
  const dispatchMouse = (type, x, y, button = "left") =>
    call("Input.dispatchMouseEvent", {
      type, x, y, button: mouseState.buttons || type === "mousePressed" ? button : "none",
      buttons: mouseState.buttons, clickCount: type === "mouseMoved" ? 0 : 1
    });

  const page = {
    // The escape hatch, for anything this file does not wrap.
    _call: call,
    _sessionId: sessionId,

    async evaluate(fn, ...args) {
      // A bare expression string, which several checks pass
      // ("window.marked && window.DOMPurify"), is evaluated as one.
      if (typeof fn === "string" && !args.length) {
        const evaluated = await call("Runtime.evaluate", {
          expression: fn, awaitPromise: true, returnByValue: true, userGesture: true
        });
        if (evaluated.exceptionDetails) throw pageError(evaluated.exceptionDetails);
        return evaluated.result?.value;
      }
      const declaration = typeof fn === "string" ? `(${fn})` : fn.toString();
      const result = await call("Runtime.callFunctionOn", {
        functionDeclaration: declaration,
        executionContextId: await contextId(),
        arguments: args.map(arg),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) throw pageError(result.exceptionDetails);
      return result.result?.value;
    },

    // Runs before any of the page's own scripts on every navigation. Several
    // checks use this to put the vendored marked/DOMPurify in place, because
    // main.js reaches for them during module evaluation and a <script> added
    // after navigation is far too late.
    async evaluateOnNewDocument(source, ...args) {
      // A raw string is injected as-is — that is how every caller uses it, to
      // put a vendored library in place before the page's own scripts run.
      // A function is turned into an immediately-invoked call; its arguments
      // have to be serialised here because there is no page to hold them yet,
      // which is the one place this file cannot avoid splicing.
      const text = typeof source === "string"
        ? source
        : `(${source.toString()})(${args.map((a) => JSON.stringify(a === undefined ? null : a)).join(",")});`;
      await call("Page.addScriptToEvaluateOnNewDocument", { source: text });
    },

    async goto(url, { waitUntil = "load", timeout = 90000 } = {}) {
      const settled = waitUntil === "domcontentloaded"
        ? onceLifecycle("Page.domContentEventFired", timeout, `DOMContentLoaded on ${url}`)
        : onceLifecycle("Page.loadEventFired", timeout, `load on ${url}`);
      await call("Page.navigate", { url });
      await settled;
      if (waitUntil === "networkidle2") await networkIdle(Math.min(timeout, 10000));
      return null;
    },

    async reload({ waitUntil = "load", timeout = 90000 } = {}) {
      const settled = waitUntil === "domcontentloaded"
        ? onceLifecycle("Page.domContentEventFired", timeout, "DOMContentLoaded on reload")
        : onceLifecycle("Page.loadEventFired", timeout, "load on reload");
      await call("Page.reload", {});
      await settled;
      if (waitUntil === "networkidle2") await networkIdle(Math.min(timeout, 10000));
      return null;
    },

    async waitForNavigation({ waitUntil = "load", timeout = 90000 } = {}) {
      const settled = waitUntil === "domcontentloaded"
        ? onceLifecycle("Page.domContentEventFired", timeout, "DOMContentLoaded")
        : onceLifecycle("Page.loadEventFired", timeout, "navigation");
      await settled;
      if (waitUntil === "networkidle2") await networkIdle(Math.min(timeout, 10000));
      return null;
    },

    // Polls in the page, like puppeteer's default. Resolves with a handle over
    // the truthy value, which is what the two call sites that read a result
    // expect (`.then((h) => h.jsonValue())`).
    async waitForFunction(fn, { timeout = 30000, polling = 50 } = {}, ...args) {
      const started = Date.now();
      const step = typeof polling === "number" ? polling : 50;
      for (;;) {
        const value = await page.evaluate(fn, ...args);
        if (value) return handle(value);
        if (Date.now() - started > timeout) throw new Error("waitForFunction timed out");
        await new Promise((r) => setTimeout(r, step));
      }
    },

    async waitForSelector(selector, { timeout = 30000, visible = false } = {}) {
      const found = await page.waitForFunction(
        (sel, mustBeVisible) => {
          const node = document.querySelector(sel);
          if (!node) return null;
          if (mustBeVisible) {
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
          }
          return true;
        },
        { timeout },
        selector, visible
      );
      return found ? { async jsonValue() { return true; }, async dispose() {} } : null;
    },

    async setViewport({ width, height, deviceScaleFactor = 1, isMobile = false, hasTouch = false } = {}) {
      await call("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor, mobile: isMobile
      });
      // maxTouchPoints must be 1-16 even when disabling — passing 0 with
      // enabled:false is rejected outright ("Touch points must be between 1
      // and 16"), which took down every check that set a desktop viewport.
      await call("Emulation.setTouchEmulationEnabled", { enabled: hasTouch, maxTouchPoints: hasTouch ? 5 : 1 });
    },

    async setRequestInterception(enabled) {
      intercepting = Boolean(enabled);
      if (intercepting) await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      else await call("Fetch.disable", {});
    },

    async setOfflineMode(offline) {
      await call("Network.emulateNetworkConditions", {
        offline: Boolean(offline),
        latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1
      });
    },

    async setBypassServiceWorker(bypass) {
      await call("Network.setBypassServiceWorker", { bypass: Boolean(bypass) });
    },

    async addScriptTag({ path: file, content, url }) {
      const source = content != null ? content : (file ? readFileSync(file, "utf8") : null);
      if (source == null && url) {
        await page.evaluate((src) => new Promise((resolve, reject) => {
          const tag = document.createElement("script");
          tag.src = src;
          tag.onload = resolve;
          tag.onerror = () => reject(new Error(`could not load ${src}`));
          document.head.appendChild(tag);
        }), url);
        return;
      }
      // Injected as a text node rather than evaluated directly, because these
      // are classic scripts (marked, DOMPurify) that expect to define globals.
      await page.evaluate((text) => {
        const tag = document.createElement("script");
        tag.textContent = text;
        document.head.appendChild(tag);
      }, source);
    },

    async click(selector) {
      const box = await page.evaluate((sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, selector);
      if (!box) throw new Error(`click: no element matches ${selector}`);
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
    },

    mouse: {
      async move(x, y) {
        mouseState.x = x; mouseState.y = y;
        await dispatchMouse("mouseMoved", x, y);
      },
      async down({ button = "left" } = {}) {
        mouseState.buttons = 1;
        await call("Input.dispatchMouseEvent", {
          type: "mousePressed", x: mouseState.x, y: mouseState.y, button, buttons: 1, clickCount: 1
        });
      },
      async up({ button = "left" } = {}) {
        await call("Input.dispatchMouseEvent", {
          type: "mouseReleased", x: mouseState.x, y: mouseState.y, button, buttons: 0, clickCount: 1
        });
        mouseState.buttons = 0;
      }
    },

    async screenshot({ path: file } = {}) {
      const { data } = await call("Page.captureScreenshot", { format: "png" });
      const bytes = Buffer.from(data, "base64");
      if (file) writeFileSync(file, bytes);
      return bytes;
    },

    // release-check reaches for a raw session to talk to the service worker.
    // It already has one.
    target() {
      return { async createCDPSession() { return { send: call, async detach() {} }; } };
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return page;
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
      return page;
    },

    async close() {
      off();
      try { await client.send("Target.closeTarget", { targetId }); } catch (_) { /* already gone */ }
      browserState.pages.delete(page);
    }
  };

  browserState.pages.add(page);
  return page;
}

/**
 * Launch a browser. Accepts the options the checks in this directory pass:
 * `executablePath`, `args`, `userDataDir`. `headless` and `defaultViewport` are
 * accepted and ignored — this is always headless, and a viewport is set with
 * page.setViewport.
 */
export async function launch({ executablePath, args = [], userDataDir } = {}) {
  const chromePath = executablePath || findChrome();
  if (!chromePath) {
    throw new Error(
      "No Chrome found. Set CHROME_PATH, or install one of the browsers " +
      "tools/cdp.mjs looks for (see CHROME_CANDIDATES)."
    );
  }
  const chrome = await launchChrome(chromePath, args, { profile: userDataDir, windowSize: "1280,900" });
  const client = await connect(chrome.wsUrl);
  const state = { pages: new Set(), listenerErrors: [] };

  return {
    async newPage() { return makePage(client, state); },
    pages() { return [...state.pages]; },
    // Anything a page listener threw, so a check can assert on it rather than
    // having it disappear into the socket's message pump.
    listenerErrors() { return state.listenerErrors; },
    async close() {
      for (const p of [...state.pages]) { try { await p.close(); } catch (_) { /* closing anyway */ } }
      try { client.close(); } catch (_) { /* already closed */ }
      // Awaited, not fired and forgotten: a caller that owns the profile — and
      // offline-check does — removes the directory the moment this resolves.
      await chrome.close();
    }
  };
}

export default { launch, findChrome };

// A very small Chrome DevTools Protocol client, for checks that puppeteer
// cannot serve.
//
// tools/interaction-scale-check.mjs drives Chrome through puppeteer and skips
// itself outright when the package is not installed. That is fine for a check
// you can also run locally — but the one thing this repo most needs to measure
// (a phone-class CPU, see tools/mobile-menu-check.mjs) has to run wherever the
// code is being worked on, and a check that skips is a check that never catches
// anything.
//
// So this speaks the protocol directly. Node 22 has a global WebSocket, Chrome
// is already on disk, and the surface actually needed is small: attach to a
// page, evaluate script in it, dispatch a real input event, and set the two
// emulation overrides that make a desktop look like a phone. Everything else a
// browser automation library does is out of scope here on purpose.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Playwright's bundled Chromium first: it is what this environment ships, and
// it is a full `chrome` rather than the headless shell (which has no renderer
// features some of this leans on). A system Chrome is used when present.
export const CHROME_CANDIDATES = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium"
];

export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const globbed = CHROME_CANDIDATES.find(existsSync);
  if (globbed) return globbed;
  // The pinned build above moves with the image; fall back to any sibling.
  const base = "/opt/pw-browsers";
  if (!existsSync(base)) return null;
  try {
    const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
    const guess = dir && path.join(base, dir, "chrome-linux", "chrome");
    return guess && existsSync(guess) ? guess : null;
  } catch (_) {
    return null;
  }
}

// Chrome prints "DevTools listening on ws://…" to stderr once, on startup.
// --remote-debugging-port=0 asks the OS for a free port, so this line is the
// only way to learn it — there is no fixed port to guess at and no race with a
// second Chrome on the same machine.
export function launchChrome(chromePath, extraArgs = []) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "recall-cdp-"));
  const proc = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=390,844",
    ...extraArgs
  ], { stdio: ["ignore", "ignore", "pipe"] });

  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk;
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(deadline);
      proc.stderr.off("data", onData);
      resolve({
        proc,
        wsUrl: match[1],
        close() {
          try { proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
          try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
      });
    };
    // Cleared on success, like every other deadline in this file — see the
    // comment on `send` below for what an uncleared one costs.
    const deadline = setTimeout(() => reject(new Error("Chrome did not report a DevTools endpoint")), 30000);
    proc.stderr.on("data", onData);
    proc.on("error", (error) => { clearTimeout(deadline); reject(error); });
    proc.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`Chrome exited before listening (code ${code})`));
    });
  });
}

// One connection, many sessions. `flatten` mode puts the sessionId on the
// message itself rather than tunnelling through Target.sendMessageToTarget,
// which is the only sane way to talk to a page over a browser-level socket.
export async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
      else resolve(message.result);
      return;
    }
    listeners.forEach((fn) => fn(message));
  });

  // Generous, because the thing these checks measure is a slow page: rendering
  // a book under a 6x CPU throttle is minutes of renderer work, and a timeout
  // tuned for a responsive page would abort the measurement rather than take it.
  const CALL_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 600000);

  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    // The timer is CLEARED when the answer arrives, and cleared through the
    // pending entry so the message handler can reach it. It used to be left
    // armed: an answered call kept a ten-minute timer on the event loop, so a
    // check that had printed its summary and killed its browser still would
    // not EXIT for ten minutes after the last CDP call. Under check.mjs, which
    // reads each check through spawnSync, that is indistinguishable from a
    // hang — the suite stops, on a check that has already passed.
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });

  return {
    send,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { try { socket.close(); } catch (_) { /* already closed */ } }
  };
}

// A page, with the protocol domains this repo's checks need already enabled.
export async function openPage(client) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => client.send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  const page = {
    sessionId,
    targetId,
    call,

    // Evaluating an expression that returns a promise has to await it in the
    // renderer (awaitPromise), not here: the protocol would otherwise hand back
    // a Promise handle and the check would compare against "[object Promise]".
    async evaluate(fn, ...args) {
      const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a === undefined ? null : a)).join(",")})`;
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || "evaluation failed";
        throw new Error(String(text).split("\n")[0]);
      }
      return result.result?.value;
    },

    // Poll in the page rather than round-tripping a boolean per frame: at a 6x
    // CPU throttle the protocol round trip is a meaningful share of what is
    // being measured, and the answer this returns has to be the page's clock.
    async waitFor(fn, { timeout = 30000, label = "condition" } = {}) {
      const started = Date.now();
      for (;;) {
        if (await page.evaluate(fn)) return Date.now() - started;
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    // A real trusted press, through the browser's own input pipeline. A
    // synthesised dispatchEvent inside the page runs the handler synchronously
    // and so measures the handler — never the wait in front of it, which is the
    // whole of what a frozen button feels like.
    async tap(x, y) {
      await call("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }]
      });
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },

    // ── A stylus ──────────────────────────────────────────────────────────
    //
    // Input.dispatchMouseEvent carries `pointerType`, `force`, `tiltX` and
    // `tiltY`, so a real pen — one the page sees as `pointerType: "pen"` with a
    // pressure on it — can be driven through the browser's own input pipeline
    // rather than synthesised inside the page. That distinction is the whole
    // reason this file exists (see tap above), and it matters more here than
    // anywhere: the ink surface decides what to do with a press by reading
    // pointerType off a trusted event, so a dispatchEvent from inside the page
    // would be testing a code path no stylus ever takes.
    //
    // What this canNOT reproduce is the compatibility TOUCH events a real
    // S-Pen or Apple Pencil fires alongside its pointer events — CDP has no way
    // to say "a touch that is also a pen". So the half of src/documents/pdf-ink.js
    // that keeps the touch-selection controller and the scroller out of a
    // stroke's way is checked by hand on real hardware, and is marked as such
    // wherever it is asserted here.
    async penDown(x, y, { pressure = 0.5, tiltX = 0, tiltY = 0, buttons = 1 } = {}) {
      await call("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", buttons, clickCount: 1,
        pointerType: "pen", force: pressure, tiltX, tiltY
      });
    },

    async penMove(x, y, { pressure = 0.5, tiltX = 0, tiltY = 0, buttons = 1 } = {}) {
      await call("Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y, button: "left", buttons,
        pointerType: "pen", force: pressure, tiltX, tiltY
      });
    },

    async penUp(x, y, { pressure = 0, buttons = 0 } = {}) {
      await call("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", buttons, clickCount: 1,
        pointerType: "pen", force: pressure
      });
    },

    // One whole stroke. `points` are [x, y] or [x, y, pressure]; the pauses are
    // real awaits rather than a burst, because the ink surface times a press to
    // tell a tap from a stroke and a burst would arrive inside that window.
    async penStroke(points, { stepMs = 12, pressure = 0.6 } = {}) {
      if (!points.length) return;
      const at = (p) => ({ x: p[0], y: p[1], pressure: p.length > 2 ? p[2] : pressure });
      const first = at(points[0]);
      await this.penDown(first.x, first.y, { pressure: first.pressure });
      for (let i = 1; i < points.length; i += 1) {
        const p = at(points[i]);
        await new Promise((r) => setTimeout(r, stepMs));
        await this.penMove(p.x, p.y, { pressure: p.pressure });
      }
      const last = at(points[points.length - 1]);
      await this.penUp(last.x, last.y);
    },

    // A pen TAP: down and straight back up, under the tap window and inside the
    // slop. What this must do is press whatever is underneath and leave no ink.
    async penTap(x, y) {
      await this.penDown(x, y, { pressure: 0.4 });
      await this.penUp(x, y);
    },

    // Resolves on the load event rather than on Page.navigate's own answer,
    // which returns as soon as the navigation is COMMITTED — before a single
    // module has run.
    async goto(url, { timeout = 90000 } = {}) {
      const loaded = new Promise((resolve, reject) => {
        let off = () => {};
        const deadline = setTimeout(() => {
          off();
          reject(new Error(`navigation to ${url} timed out`));
        }, timeout);
        off = client.on((message) => {
          if (message.sessionId !== sessionId) return;
          if (message.method !== "Page.loadEventFired") return;
          clearTimeout(deadline);
          off();
          resolve();
        });
      });
      await call("Page.navigate", { url });
      await loaded;
    }
  };
  return page;
}

// A phone. deviceScaleFactor 2 and mobile:true matter for more than pixel
// density — they are what puts the page under the mobile media queries this
// app changes behaviour on (CHROME_MOBILE_QUERY is max-width: 720px).
export async function emulatePhone(page, { width = 390, height = 844, cpuThrottle = 1 } = {}) {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 2, mobile: true
  });
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (cpuThrottle > 1) await page.call("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
}

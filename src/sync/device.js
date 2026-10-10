// Which device made a change — so sync messages can say "from your phone"
// instead of the faceless "from the cloud".
//
// A stable random id per browser profile, and a label a person can recognise.
// The label is derived from the browser and system the first time and can be
// renamed; it travels with every push (decks.last_device) and into each version
// in the history, which is where it is read back.

export const DEVICE_ID_KEY = "recall_device_id";
export const DEVICE_LABEL_KEY = "recall_device_label";

function readKey(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeKey(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: this session only */ }
}

let sessionDeviceId = null;

export function deviceId() {
  const stored = readKey(DEVICE_ID_KEY);
  if (stored) return stored;
  if (!sessionDeviceId) {
    sessionDeviceId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    writeKey(DEVICE_ID_KEY, sessionDeviceId);
  }
  return sessionDeviceId;
}

// "Chrome on Android", "Safari on iPhone", "Firefox on Windows"…
export function describeThisDevice(ua = (typeof navigator !== "undefined" && navigator.userAgent) || "") {
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
      : /Firefox\//.test(ua) ? "Firefox"
        : /CriOS\/|Chrome\//.test(ua) ? "Chrome"
          : /Safari\//.test(ua) ? "Safari"
            : "Browser";
  const system = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
        : /Mac OS X|Macintosh/.test(ua) ? "Mac"
          : /Windows/.test(ua) ? "Windows"
            : /CrOS/.test(ua) ? "Chromebook"
              : /Linux/.test(ua) ? "Linux"
                : "this device";
  return `${browser} on ${system}`;
}

export function deviceLabel() {
  const stored = String(readKey(DEVICE_LABEL_KEY) || "").trim();
  return stored || describeThisDevice();
}

export function setDeviceLabel(label) {
  const clean = String(label || "").trim().slice(0, 60);
  if (clean) writeKey(DEVICE_LABEL_KEY, clean);
  else {
    try { localStorage.removeItem(DEVICE_LABEL_KEY); } catch { /* nothing stored */ }
  }
  return deviceLabel();
}

// The name to show for a change another device made. A push from THIS device
// carries this device's label, so a label equal to ours (two devices of the same
// make, never renamed) is still shown — it is the best name there is.
export function otherDeviceName(label) {
  const clean = String(label || "").trim();
  return clean || "another device";
}

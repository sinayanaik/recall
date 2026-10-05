// The two style profiles a device can be on. A phone and a laptop want
// different sizes, so settings are stored per profile and the active one is
// chosen by a media query.

export const styleProfiles = ["desktop", "mobile"];

// The phone LAYOUT: the breakpoint the stylesheets switch at. Several modules
// ask it "is the CSS in its narrow arrangement right now" (a sheet rather than
// a popover, a table left to scroll), so it has to stay exactly the CSS's own
// 720px — whatever device is showing it.
export const styleMobileQuery = "(max-width: 720px)";

export const styleMobileMedia = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(styleMobileQuery) : null;

// ── The phone PROFILE is not the phone layout ───────────────────────────────
//
// A phone turned sideways is still a phone. The layout query alone used to pick
// the profile, and almost every phone is wider than 720px lying down — so
// turning one swapped the whole profile mid-read: 15px text became 18px, the
// line height, padding and image width changed, and a reader with a different
// reading mode per profile was moved between paged and continuous. Everything on
// the screen re-flowed at once and the place they were reading went with it.
//
// So a touch screen whose SHORT side is phone-sized keeps the phone profile at
// any width. The screen, not the viewport: the viewport's height is what the
// keyboard takes away (interactive-widget=resizes-content, index.html), and a
// tablet on its side with the keyboard up is under 500px tall without being a
// phone. A screen's short side is the same either way up.
export const PHONE_SCREEN_SHORT_SIDE_PX = 500;

export const styleCoarsePointerMedia = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(pointer: coarse)") : null;

function isPhoneScreen() {
  if (!styleCoarsePointerMedia?.matches || typeof screen === "undefined") return false;
  const shortSide = Math.min(screen.width || 0, screen.height || 0);
  return shortSide > 0 && shortSide <= PHONE_SCREEN_SHORT_SIDE_PX;
}

export function prefersMobileStyleProfile() {
  return Boolean(styleMobileMedia?.matches) || isPhoneScreen();
}

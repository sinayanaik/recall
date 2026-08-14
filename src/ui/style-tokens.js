// The two style profiles a device can be on. A phone and a laptop want
// different sizes, so settings are stored per profile and the active one is
// chosen by a media query.

export const styleProfiles = ["desktop", "mobile"];

export const styleMobileQuery = "(max-width: 720px)";

export const styleMobileMedia = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(styleMobileQuery) : null;

// Inline SVG icons for the library list, built once and stamped into rows on
// render rather than shipped as separate requests.

// ── My Decks icon set ───────────────────────────────────────────────────────
// Hand-drawn on the same 24×24 grid, stroke weight and currentColor contract as
// CLOZE_SVG_ATTRS, so one visual language runs through the whole app. Emoji were
// used here before; they render at a different size, weight and colour on every
// platform, and can't pick up the accent colour of a pressed segmented button.
//
// Defined once, in JS, even though most of these live on static buttons in
// index.html — those carry `data-md-icon="<name>"` and are filled in by
// hydrateMyDecksIcons() below, so a path is never written down twice.
export const MD_SVG_ATTRS =
  'class="md-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const MD_DOT = (cx, cy, r = 1.6) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;

export const MD_ICONS = {
  // Views: every deck at once · one folder at a time · the whole hierarchy
  grid: `<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>`,
  folder: `<path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h4.1l2 2.6h8.7A1.6 1.6 0 0 1 21 9.2v8.8a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 18Z"/>`,
  tree: `<rect x="2.5" y="1.8" width="10" height="4.2" rx="1.4"/><path d="M5.2 6v10.6a2 2 0 0 0 2 2h3.6M5.2 10.9h5.6"/><rect x="12" y="8.4" width="9.5" height="5" rx="1.4"/><rect x="12" y="16.2" width="9.5" height="5" rx="1.4"/>`,
  // Display: side-by-side cards · a dotted list
  tiles: `<rect x="2.6" y="4.4" width="8.4" height="15.2" rx="1.7"/><rect x="13" y="4.4" width="8.4" height="15.2" rx="1.7"/>`,
  list: `<path d="M8.5 6h12.5M8.5 12h12.5M8.5 18h12.5"/>${MD_DOT(4, 6, 1.4)}${MD_DOT(4, 12, 1.4)}${MD_DOT(4, 18, 1.4)}`,
  // Create
  newDeck: `<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M12 9.2v6M9 12.2h6"/>`,
  newFolder: `<path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h4.1l2 2.6h8.7A1.6 1.6 0 0 1 21 9.2v8.8a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 18Z"/><path d="M12 11.6v4.8M9.6 14h4.8"/>`,
  // Import / export / sync
  // A deck with an arrow landing inside it — "put a file in here". Deliberately
  // not `upload`/`download`, which both read as moving data in or out of the
  // app as a whole rather than into one folder.
  importDeck: `<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M12 7.4v6.4M9.2 11l2.8 2.8L14.8 11"/>`,
  book: `<path d="M12 6.9a3 3 0 0 0-2.4-1.4H4v12h5.6A2.7 2.7 0 0 1 12 19Z"/><path d="M12 6.9a3 3 0 0 1 2.4-1.4H20v12h-5.6A2.7 2.7 0 0 0 12 19Z"/>`,
  refresh: `<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6"/><path d="M20.6 3.6v5.6H15"/>`,
  download: `<path d="M12 3.4v11.2M7.6 10.4 12 14.8l4.4-4.4"/><path d="M4 16.6v2.8A1.6 1.6 0 0 0 5.6 21h12.8a1.6 1.6 0 0 0 1.6-1.6v-2.8"/>`,
  upload: `<path d="M12 15.2V4M7.6 8.4 12 4l4.4 4.4"/><path d="M4 16.6v2.8A1.6 1.6 0 0 0 5.6 21h12.8a1.6 1.6 0 0 0 1.6-1.6v-2.8"/>`,
  cloud: `<path d="M7.2 18.6a4.3 4.3 0 0 1-.5-8.5 5.7 5.7 0 0 1 10.9-1.3 3.95 3.95 0 0 1 .6 9.8Z"/>`,
  // "All decks" — the root drop target that files a deck out of every folder
  home: `<path d="M3.6 10.2 12 3.4l8.4 6.8v9a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z"/><path d="M9.4 20.8v-6.4h5.2v6.4"/>`,
  // Row + menu actions
  more: `${MD_DOT(5, 12)}${MD_DOT(12, 12)}${MD_DOT(19, 12)}`,
  play: `<path d="M7.6 4.9 19 12 7.6 19.1Z" fill="currentColor"/>`,
  pencil: `<path d="M4 20.6 4.9 16 16.3 4.6a1.9 1.9 0 0 1 2.7 0l1.4 1.4a1.9 1.9 0 0 1 0 2.7L9 20.1Z"/><path d="m15 6.6 3.4 3.4"/>`,
  trash: `<path d="M4 6.4h16M9.6 6.4V4.7a1.3 1.3 0 0 1 1.3-1.3h2.2a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="m6.6 6.4.9 13.3a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l.9-13.3"/><path d="M10.2 10.4v6.8M13.8 10.4v6.8"/>`,
  // Tree expand / collapse — arrows apart, arrows together
  expand: `<path d="m8 9.6 4-4 4 4M8 14.4l4 4 4-4"/>`,
  collapse: `<path d="m8 6.4 4 4 4-4M8 17.6l4-4 4 4"/>`,
  // Chevron: the folder twisty. CSS rotates it 90° when the folder is open.
  chevron: `<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>`,
  close: `<path d="m6 6 12 12M18 6 6 18"/>`,
  search: `<circle cx="10.6" cy="10.6" r="6.6"/><path d="m15.4 15.4 4.6 4.6"/>`,
  sort: `<path d="M4 6.4h11M4 12h7.5M4 17.6h4"/><path d="M18.2 7.8v9.4M15.2 14.2l3 3 3-3"/>`,
};

// Renders one icon as an <svg> string. Unknown names render nothing rather than
// throwing, so a typo degrades to a text-only button instead of a blank panel.
export function mdIcon(name) {
  const body = MD_ICONS[name];
  return body ? `<svg ${MD_SVG_ATTRS}>${body}</svg>` : "";
}

// Fills in every static `data-md-icon` button in index.html. The icon is
// *prepended* so an existing text label stays put as the button's second child.
export function hydrateMyDecksIcons(root = document) {
  root.querySelectorAll("[data-md-icon]").forEach((node) => {
    if (node.querySelector("svg.md-ico")) return; // already hydrated
    node.insertAdjacentHTML("afterbegin", mdIcon(node.dataset.mdIcon));
  });
}

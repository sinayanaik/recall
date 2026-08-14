// Turning a flat list of decks into the folder tree the library renders, and
// tracking which categories exist across local and cloud decks.

import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { FOLDER_SEP, categorySortValue, folderSegments, normalizeDeckCategory } from "./folders.js?v=__BUILD__";

// Builds a nested folder tree from a set of category paths and the decks that
// carry them. Each node: { name, path, children:Map<name,node>, decks:[] }.
// `deckEntries` is an array of { deck, kind } where kind is "local"|"cloud".
export function buildFolderTree(deckEntries = [], extraFolders = []) {
  const root = { name: "", path: "", children: new Map(), decks: [] };
  const ensure = (path) => {
    const segments = folderSegments(path);
    let node = root;
    let acc = "";
    segments.forEach((segment) => {
      acc = acc ? acc + FOLDER_SEP + segment : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, { name: segment, path: acc, children: new Map(), decks: [] });
      }
      node = node.children.get(segment);
    });
    return node;
  };
  // Uncategorized decks live at the tree root so they aren't buried in a folder.
  extraFolders.forEach((path) => ensure(path));
  deckEntries.forEach((entry) => {
    const category = normalizeDeckCategory(entry.deck.category);
    const node = category === defaultDeckCategory ? root : ensure(category);
    node.decks.push(entry);
  });
  return root;
}

export function categoriesFromDecks(decks = [], extraCategories = []) {
  return Array.from(new Set([
    defaultDeckCategory,
    ...extraCategories.map(normalizeDeckCategory),
    ...(decks || []).map((deck) => normalizeDeckCategory(deck.category))
  ])).sort((a, b) => categorySortValue(a).localeCompare(categorySortValue(b)));
}

export function setKnownWebDeckCategories(categories = []) {
  webDeckCategories = categoriesFromDecks([], categories);
  return webDeckCategories;
}

export async function refreshKnownWebDeckCategories() {
  if (!supabaseClient) return webDeckCategories;
  const { data, error } = await supabaseClient
    .from("decks")
    .select("category");
  if (error) throw error;
  return setKnownWebDeckCategories(categoriesFromDecks(data || []));
}

export let webDeckCategories = [defaultDeckCategory];

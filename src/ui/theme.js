// Picking a theme and telling everything that cares — CSS variables, the
// theme menu, and Mermaid, which needs its colours at configure time rather
// than reading them from the page.

import { bumpAllCardsRenderId, renderAllCards } from "../cards/all-cards.js?v=__BUILD__";
import { themeStorageKey } from "../core/constants.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { showCard, state } from "../main.js?v=__BUILD__";
import { invalidateRenderedBlockCache } from "../render/block-cache.js?v=__BUILD__";
import { themeAliases, themeCatalog } from "./theme-catalog.js?v=__BUILD__";

export function themeById(themeId) {
  const normalized = normalizeThemeId(themeId);
  return themeCatalog.find((theme) => theme.id === normalized) || themeCatalog[0];
}

export function normalizeThemeId(themeId) {
  const requested = String(themeId || "").trim();
  const normalized = themeAliases[requested] || requested;
  return themeCatalog.some((theme) => theme.id === normalized) ? normalized : "dark-amoled";
}

export function currentThemeId() {
  return normalizeThemeId(document.documentElement.dataset.theme || "dark-amoled");
}

export function cssVariableColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function applyThemePreviewStyles(node, theme) {
  if (!node) return;
  node.style.setProperty("--theme-bg", theme.colors.bg);
  node.style.setProperty("--theme-panel", theme.colors.panel);
  node.style.setProperty("--theme-text", theme.colors.text);
  node.style.setProperty("--theme-line", theme.colors.line);
  node.style.setProperty("--theme-accent", theme.colors.accent);
}

export function configureMermaid(themeId) {
  // mermaid is loaded on demand (see ensureMermaid), and setTheme calls this at
  // boot — long before any diagram exists to draw. Nothing to configure yet;
  // ensureMermaid re-invokes this with the live theme the moment it lands.
  if (typeof mermaid === "undefined") return;
  const theme = themeById(themeId);
  const isPrintTheme = themeId === "print";
  const card = isPrintTheme ? cssVariableColor("--print-surface", "#ffffff") : cssVariableColor("--card", theme.colors.panel);
  const panel = isPrintTheme ? cssVariableColor("--print-panel", "#ffffff") : cssVariableColor("--panel", theme.colors.panel);
  const bg = isPrintTheme ? cssVariableColor("--print-bg", "#eef2f2") : cssVariableColor("--bg", theme.colors.bg);
  const text = isPrintTheme ? cssVariableColor("--print-text", "#17201c") : cssVariableColor("--text", theme.colors.text);
  const line = isPrintTheme ? cssVariableColor("--print-line", "#b9c9c5") : cssVariableColor("--line", theme.colors.line);
  const muted = isPrintTheme ? cssVariableColor("--print-muted", "#56645f") : cssVariableColor("--muted", theme.colors.text);
  const accent = isPrintTheme ? cssVariableColor("--print-accent", theme.colors.accent) : cssVariableColor("--accent", theme.colors.accent);
  mermaid.initialize({
    startOnLoad: false,
    // "strict" — deck markdown can come from arbitrary URLs/files, and "loose"
    // lets diagram source register click callbacks / unsanitized labels that
    // bypass the DOMPurify pipeline every other rendered surface goes through.
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      primaryColor: card,
      primaryTextColor: text,
      primaryBorderColor: accent,
      lineColor: muted,
      secondaryColor: panel,
      tertiaryColor: bg,
      edgeLabelBackground: panel,
      clusterBkg: panel,
      clusterBorder: line
    }
  });
}

export function setTheme(theme) {
  const themeId = normalizeThemeId(theme);
  document.documentElement.dataset.theme = themeId;
  updateThemeControl(themeId);
  configureMermaid(themeId);
  // Diagrams are drawn with the theme's colours baked into their SVG, so every
  // cached rendered block is now stale even though its markdown didn't change.
  invalidateRenderedBlockCache();
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) metaThemeColor.setAttribute("content", themeById(themeId).colors.bg);
  if (state.cards[state.current]) showCard();
  if (el.allCardsPanel && !el.allCardsPanel.hidden) {
    bumpAllCardsRenderId();
    renderAllCards();
  }
  try {
    localStorage.setItem(themeStorageKey, themeId);
  } catch (error) {
    console.warn("Could not save theme", error);
  }
}

export function renderThemeMenu() {
  if (!el.themeMenu) return;
  el.themeMenu.innerHTML = "";
  ["dark", "light"].forEach((mode) => {
    const label = document.createElement("div");
    label.className = "theme-group-label";
    label.textContent = mode === "light" ? "Light themes" : "Dark themes";
    el.themeMenu.appendChild(label);

    themeCatalog.filter((theme) => theme.mode === mode).forEach((theme) => {
      const button = document.createElement("button");
      button.className = "theme-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.themeOption = theme.id;
      applyThemePreviewStyles(button, theme);
      button.innerHTML = `
        <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
        <span><strong>${theme.label}</strong><small>${theme.description}</small></span>
        <span class="theme-check" aria-hidden="true"></span>
      `;
      applyThemePreviewStyles(button.querySelector(".theme-preview"), theme);
      el.themeMenu.appendChild(button);
    });
  });
}

export function updateThemeControl(themeId = currentThemeId()) {
  const theme = themeById(themeId);
  if (el.themeCurrentLabel) el.themeCurrentLabel.textContent = theme.label;
  if (el.themeBtn) {
    el.themeBtn.title = `Theme: ${theme.label}`;
    el.themeBtn.setAttribute("aria-label", `Theme: ${theme.label}. Choose theme.`);
    applyThemePreviewStyles(el.themeBtn.querySelector(".theme-preview"), theme);
  }
  el.themeMenu?.querySelectorAll("[data-theme-option]").forEach((button) => {
    const selected = button.dataset.themeOption === theme.id;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    const check = button.querySelector(".theme-check");
    if (check) check.textContent = selected ? "*" : "";
  });
}

export function setThemeMenuOpen(open) {
  if (!el.themeMenu || !el.themeBtn) return;
  el.themeMenu.hidden = !open;
  el.themeBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

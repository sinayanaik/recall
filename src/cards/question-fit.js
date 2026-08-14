// Shrinking the live card's question until it fits its panel.
//
// Nothing to do with exporting — it only sat beside the print code because it
// happened to fall between two export functions in the original file. Each
// measurement forces layout, so the answer is cached against its inputs and a
// refit is skipped entirely while text is selected (and owed afterwards).

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hasStudyTextSelection } from "../ui/chrome.js?v=__BUILD__";
import { styleDefaults } from "../ui/style-schema.js?v=__BUILD__";
import { normalizeStyleSettings, numericStyleValue } from "../ui/style-settings.js?v=__BUILD__";

export function fitLiveQuestion() {
  const node = el.questionView;
  const face = node?.closest(".card-question");
  if (!node) return;

  // Refitting means clearing and re-measuring the font size, which reflows every
  // line of the question. Doing that while text is selected drops the selection
  // (or leaves its handles somewhere the text no longer is), and `resize` fires
  // constantly on a phone — the URL bar alone triggers it as the surface
  // auto-scrolls under a selection drag. Defer instead; the next render or
  // resize refits, and selectionchange below refits as soon as the selection is
  // released.
  if (hasStudyTextSelection()) {
    questionFitDeferredBySelection = true;
    return;
  }
  questionFitDeferredBySelection = false;

  node.style.fontSize = "";
  node.style.transform = "";
  node.style.width = "";
  node.style.removeProperty("--question-fit-font-size");

  if (!face || !node.textContent.trim()) return;
  if (face.clientHeight <= 0 || face.clientWidth <= 0) return;

  const settings = normalizeStyleSettings(state.styleSettings);

  // The search below is a write-then-measure loop, and every measurement after a
  // write forces a synchronous layout — so a fit costs ten of them, on the frame
  // right after the press that triggered it. Nothing about the answer changes
  // while the markup, the face's box and the three settings that feed the search
  // are all the same, and they very often are: flipping back to a card already
  // seen, a re-render of the same question, and the resize handler (which fires
  // on a phone merely because the URL bar moved) all land here unchanged.
  const fitKey = [
    node.innerHTML,
    face.clientWidth, face.clientHeight,
    settings.questionLineHeight, settings.questionFillPercent, settings.questionMaxFontSize
  ].join("|");
  if (liveQuestionFitCache.key === fitKey) {
    node.style.setProperty("--question-fit-font-size", liveQuestionFitCache.size);
    return;
  }
  const faceStyle = getComputedStyle(face);
  const paddingY = (parseFloat(faceStyle.paddingTop) || 0) + (parseFloat(faceStyle.paddingBottom) || 0);
  const paddingX = (parseFloat(faceStyle.paddingLeft) || 0) + (parseFloat(faceStyle.paddingRight) || 0);
  const rowGap = parseFloat(faceStyle.rowGap || faceStyle.gap) || 0;
  const visibleItems = Array.from(face.children).filter((child) => {
    if (child === node || child.hidden) return child === node;
    return getComputedStyle(child).display !== "none";
  });
  const occupiedHeight = visibleItems.reduce((total, child) => {
    if (child === node) return total;
    const childStyle = getComputedStyle(child);
    return total
      + child.getBoundingClientRect().height
      + (parseFloat(childStyle.marginTop) || 0)
      + (parseFloat(childStyle.marginBottom) || 0);
  }, 0);
  const gapHeight = Math.max(visibleItems.length - 1, 0) * rowGap;
  const lineHeight = parseFloat(settings.questionLineHeight) || parseFloat(styleDefaults.questionLineHeight) || 1.18;
  const fillRatio = Math.min(Math.max((parseFloat(settings.questionFillPercent) || parseFloat(styleDefaults.questionFillPercent)) / 100, 0.1), 0.95);
  const maxQuestionFontSize = numericStyleValue(settings.questionMaxFontSize) ?? numericStyleValue(styleDefaults.questionMaxFontSize) ?? 64;
  const availableHeight = Math.max(face.clientHeight - paddingY - occupiedHeight - gapHeight, 1);
  const availableWidth = Math.max(face.clientWidth - paddingX, 1);
  // Pre-measure fixed-height elements (code blocks / scrollable children) whose height
  // doesn't change as we vary --question-fit-font-size, so the target can account for them.
  const isScrollableChild = (child) => {
    const s = getComputedStyle(child);
    return s.overflowX === "auto" || s.overflowX === "scroll"
      || s.overflow === "auto" || s.overflow === "scroll";
  };
  const fixedContentHeight = Array.from(node.children).reduce((sum, child) => {
    if (getComputedStyle(child).display === "none") return sum;
    if (!isScrollableChild(child)) return sum;
    const s = getComputedStyle(child);
    return sum + child.getBoundingClientRect().height
      + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
  }, 0);
  // Space available for scalable text after reserving room for code blocks
  const textAvailableHeight = Math.max(availableHeight - fixedContentHeight, 1);
  const targetHeight = Math.max(textAvailableHeight * fillRatio, 1);
  const searchCeiling = Math.max(1, Math.min(maxQuestionFontSize, 360, targetHeight / Math.max(lineHeight, 0.1) * 2.2, availableWidth * 1.6));
  let low = 1;
  let high = searchCeiling;
  let best = low;

  if (node.clientWidth <= 0) node.style.width = `${availableWidth}px`;

  const questionContentSize = () => {
    const children = Array.from(node.children).filter((child) => getComputedStyle(child).display !== "none");
    if (!children.length) {
      const nodeStyle = getComputedStyle(node);
      const h = parseFloat(nodeStyle.lineHeight) || node.scrollHeight;
      return { width: Math.min(node.scrollWidth, Math.max(node.clientWidth, availableWidth)), height: h, fitHeight: h };
    }

    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let width = 0;
    let fitHeight = 0;  // sum of scalable (text) element heights — not a bounding box

    children.forEach((child) => {
      const childStyle = getComputedStyle(child);
      const scrollable = isScrollableChild(child);
      const rect = child.getBoundingClientRect();
      const marginTop = parseFloat(childStyle.marginTop) || 0;
      const marginRight = parseFloat(childStyle.marginRight) || 0;
      const marginBottom = parseFloat(childStyle.marginBottom) || 0;
      const marginLeft = parseFloat(childStyle.marginLeft) || 0;
      top = Math.min(top, rect.top - marginTop);
      right = Math.max(right, rect.right + marginRight);
      bottom = Math.max(bottom, rect.bottom + marginBottom);
      left = Math.min(left, rect.left - marginLeft);
      // Use rendered rect.width for scrollable elements — their scrollWidth includes
      // off-screen code that doesn't overflow the container visually
      const effectiveWidth = scrollable ? rect.width : child.scrollWidth;
      width = Math.max(width, rect.width + marginLeft + marginRight, effectiveWidth + marginLeft + marginRight);
      // Accumulate only scalable children for the fit-height — summing, not bounding box,
      // so a code block sandwiched between text elements doesn't inflate the measurement
      if (!scrollable) {
        fitHeight += rect.height + marginTop + marginBottom;
      }
    });

    return {
      width: Math.max(width, right - left),
      height: Math.max(0, bottom - top),
      fitHeight
    };
  };

  const fits = () => {
    const contentSize = questionContentSize();
    // No scalable text (question is only a code block) — nothing to fit, use max size
    if (contentSize.fitHeight === 0) return true;
    return contentSize.width <= Math.max(node.clientWidth, availableWidth) + 4
      && contentSize.fitHeight <= targetHeight + 2
      && contentSize.fitHeight <= textAvailableHeight + 2;
  };

  for (let index = 0; index < 10; index += 1) {
    // The result is rounded to within 0.5px below, so once the bracket is that
    // narrow the remaining iterations cost a forced layout each and cannot
    // change the answer. On a typical ceiling this drops 2-3 of the 10.
    if (high - low <= 0.5) break;
    const mid = (low + high) / 2;
    node.style.setProperty("--question-fit-font-size", `${mid}px`);
    if (fits()) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  const fitted = `${Math.min(maxQuestionFontSize, Math.max(1, best - 0.5))}px`;
  liveQuestionFitCache.key = fitKey;
  liveQuestionFitCache.size = fitted;
  node.style.setProperty("--question-fit-font-size", fitted);
}

export function scheduleLiveQuestionFit() {
  cancelAnimationFrame(liveQuestionFitFrame);
  liveQuestionFitFrame = requestAnimationFrame(() => {
    liveQuestionFitFrame = requestAnimationFrame(fitLiveQuestion);
  });
}

export function afterPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export let liveQuestionFitFrame = 0;

// Last answer fitLiveQuestion computed, and the inputs it was computed from.
// One entry is enough: the question view only ever shows one question.
export const liveQuestionFitCache = { key: null, size: null };

// A question refit that was skipped because text was selected (see
// fitLiveQuestion), owed as soon as the selection is released.
export let questionFitDeferredBySelection = false;

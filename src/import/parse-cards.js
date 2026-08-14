// Turning markdown into cards.
//
// Several syntaxes are recognised, and the RIGHT one has to be chosen rather
// than the first that matches: plain `##` headings are notes far more often
// than they are flashcards, and shredding a document into one card per heading
// is the single most destructive thing an import can do.

import { cardSideSeparatorPattern, delimitedCardBoundaryPattern } from "../core/constants.js?v=__BUILD__";

export function normalizeMarkdown(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function stripReaderMetadata(markdown) {
  const source = normalizeMarkdown(markdown).trim();
  const marker = "\nMarkdown Content:\n";
  const markerIndex = source.indexOf(marker);
  return markerIndex === -1 ? source : source.slice(markerIndex + marker.length).trim();
}

// Deck study notes travel inside markdown exports between HTML-comment
// sentinels so the card parsers never mistake freeform notes (which may
// legitimately contain `::` lines, `---` rules, or headings) for cards.
export const NOTES_BLOCK_RE = /\n?<!--\s*recall:notes\s*-->\n?([\s\S]*?)\n?<!--\s*\/recall:notes\s*-->\n?/g;

// Non-global twin for presence checks: `.test()` on the /g regex above advances
// its lastIndex, so consecutive calls would alternate true/false.
export const NOTES_BLOCK_PRESENT_RE = /<!--\s*recall:notes\s*-->/;

export function extractNotesFromMarkdown(markdown) {
  const found = [];
  const rest = normalizeMarkdown(String(markdown || "")).replace(NOTES_BLOCK_RE, (match, body) => {
    const cleaned = body.replace(/^\s*##\s+Notes\s*\n/, "").trim();
    if (cleaned) found.push(cleaned);
    return "\n";
  });
  return { markdown: rest, notes: found.join("\n\n---\n\n") };
}

export function notesExportBlock(notes) {
  const body = String(notes || "")
    // A literal end sentinel inside the notes would truncate the block on import.
    .replace(/<!--\s*\/recall:notes\s*-->/g, "<!- - /recall:notes - ->")
    .trim();
  if (!body) return "";
  return `<!-- recall:notes -->\n## Notes\n\n${body}\n<!-- /recall:notes -->`;
}

export function removeEmptyHeadingGroups(markdown) {
  return normalizeMarkdown(markdown)
    .split("\n")
    .filter((line) => !/^#{1,6}\s*[^\S\r\n]*$/.test(line))
    .join("\n");
}

export function humanizeSourceTitle(value) {
  const cleaned = normalizeMarkdown(String(value || ""))
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop() || "";
  const withoutExtension = cleaned.replace(/\.(md|markdown|mdown|mkdn|txt|zip)$/i, "");
  const withoutNotionId = withoutExtension
    .replace(/[-_\s]+[a-f0-9]{32}$/i, "")
    .replace(/[-_\s]+[a-f0-9]{8,}$/i, "");
  return withoutNotionId
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceFileTitle(value) {
  const cleaned = normalizeMarkdown(String(value || ""))
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean)
    .pop() || "";
  const decoded = (() => {
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  })();
  return decoded
    .replace(/\.(md|markdown|mdown|mkdn|txt|json|zip)$/i, "")
    .replace(/[-_\s]+[a-f0-9]{32}$/i, "")
    .replace(/[-_\s]+[a-f0-9]{8,}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFromImportHint(titleHint = "") {
  return sourceFileTitle(titleHint) || humanizeSourceTitle(titleHint);
}

export function inferDeckTitle(markdown, fallback = "") {
  const source = stripReaderMetadata(markdown);
  const lines = normalizeMarkdown(source).split("\n");
  const h1 = lines.find((line) => /^#\s+.+/.test(line.trim()));
  if (h1) return h1.replace(/^#\s+/, "").replace(/\s+#*$/, "").trim();

  const nonQuestionHeading = lines.find((line) => {
    const match = line.trim().match(/^#{2,6}\s+(.+?)\s*#*$/);
    return match && !match[1].trim().endsWith("?");
  });
  if (nonQuestionHeading) {
    return nonQuestionHeading.replace(/^#{2,6}\s+/, "").replace(/\s+#*$/, "").trim();
  }

  return humanizeSourceTitle(fallback) || "Pasted Deck";
}

export function stripQuoteMarker(line) {
  return line.replace(/^\s{0,3}>\s?/, "");
}

export function cleanToggleContent(lines) {
  return lines
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseDelimitedCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let inCard = false;
  let side = "front";
  let front = [];
  let back = [];
  let inFence = false;

  const reset = () => {
    inCard = false;
    side = "front";
    front = [];
    back = [];
    inFence = false;
  };

  const flush = () => {
    const question = cleanToggleContent(front);
    const answer = cleanToggleContent(back);
    if (question && answer) cards.push({ question, answer });
    reset();
  };

  const pushContent = (line) => {
    if (!inCard) return;
    if (side === "front") {
      front.push(line);
    } else {
      back.push(line);
    }
    if (/^\s*```/.test(line.trim())) inFence = !inFence;
  };

  const toggleCardBoundary = () => {
    if (inCard) {
      flush();
    } else {
      reset();
      inCard = true;
    }
  };

  for (const line of lines) {
    let rest = line;

    if (!inFence && rest.trim() === "::") {
      toggleCardBoundary();
      continue;
    }

    if (!inFence && /^\s*::/.test(rest)) {
      toggleCardBoundary();
      rest = rest.replace(/^\s*::/, "");
      if (!rest.trim()) continue;
    }

    if (!inCard) continue;

    // A literal "---" the user typed inside a card (e.g. a Markdown horizontal
    // rule) is escaped as "\---" on export (see formatCardList) so it round-trips
    // instead of being mistaken for the front/back separator below. Unescape it
    // back to plain content and skip the separator checks for this line.
    if (!inFence && /^\s*\\---(?!-)/.test(rest)) {
      pushContent(rest.replace(/^(\s*)\\---/, "$1---"));
      continue;
    }

    if (!inFence && side === "front" && rest.trim() === "---") {
      side = "back";
      continue;
    }

    if (!inFence && side === "front" && cardSideSeparatorPattern.test(rest)) {
      side = "back";
      rest = rest.replace(cardSideSeparatorPattern, "");
      if (!rest.trim()) continue;
    }

    if (!inFence && rest.trim().endsWith("::")) {
      const content = rest.replace(/::\s*$/, "");
      if (content.trim()) pushContent(content);
      flush();
      continue;
    }

    pushContent(rest);
  }

  return cards;
}

export function parseBlockquoteCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let block = [];
  let inFence = false;

  const flush = () => {
    const body = cleanToggleContent(block);
    block = [];
    if (!body) return;

    const parts = body.split("\n");
    const firstContentIndex = parts.findIndex((line) => line.trim());
    if (firstContentIndex === -1) return;

    const question = parts[firstContentIndex].trim();
    const answer = cleanToggleContent(parts.slice(firstContentIndex + 1));
    if (question && answer) {
      cards.push({ question, answer });
    }
  };

  for (const line of lines) {
    const isQuote = /^\s{0,3}>/.test(line);

    if (isQuote) {
      const stripped = stripQuoteMarker(line);
      if (/^\s*```/.test(stripped)) inFence = !inFence;
      block.push(stripped);
      continue;
    }

    if (line.trim() === "" && block.length && inFence) {
      block.push("");
      continue;
    }

    flush();
    inFence = false;
  }

  flush();
  return cards;
}

export function parseDetailsCards(markdown) {
  const cards = [];
  const detailsPattern = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let match;

  while ((match = detailsPattern.exec(markdown))) {
    const question = match[1].replace(/<[^>]*>/g, "").trim();
    const answer = match[2].trim();
    if (question && answer) cards.push({ question, answer });
  }

  return cards;
}

export function parseQACards(markdown) {
  const cards = [];
  const chunks = normalizeMarkdown(markdown).split(/\n{2,}(?=(?:Q|Question)\s*:)/i);

  for (const chunk of chunks) {
    const match = chunk.match(/^(?:Q|Question)\s*:\s*([\s\S]*?)\n(?:A|Answer)\s*:\s*([\s\S]*)$/i);
    if (match?.[1]?.trim() && match?.[2]?.trim()) {
      cards.push({
        question: match[1].trim(),
        answer: match[2].trim()
      });
    }
  }

  return cards;
}

export function hasStructuredSectionLabels(lines) {
  const studyLabelPattern = /^\*\*\s*(?:original(?:\s+sanskrit)?|(?:english\s+)?transliteration|(?:complete\s+)?translation|word(?:-by-word|\s+meanings?)?(?:\s+breakdown)?|(?:philosophical\s+)?meaning|memorization\s+tip|explanation|example|summary|notes)\s*:\*\*\s*$/i;
  const labels = lines.filter((line) => studyLabelPattern.test(line.trim()));
  return labels.length >= 2;
}

export function hasMeaningfulContent(lines) {
  return lines.some((line) => {
    const trimmed = line.trim();
    return trimmed
      && !/^-{3,}$/.test(trimmed)
      && !/^<alphaxiv-thinking-title\b/i.test(trimmed);
  });
}

export function isStudySectionTitle(title) {
  return /^(?:what|how|why|when|where|which|who|can|does|do|is|are|explain|describe|summari[sz]e|summary|compare|contrast)\b/i.test(title);
}

export function parseHeadingCards(markdown, options = {}) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let current = null;
  const includeStudySections = options.includeStudySections === true;

  const flush = () => {
    if (!current) return;
    const answer = cleanToggleContent(current.answer);
    const shouldKeep = current.isQuestion
      || (
        includeStudySections
        && !current.hasNestedHeading
        && hasMeaningfulContent(current.answer)
        && (isStudySectionTitle(current.question) || hasStructuredSectionLabels(current.answer))
      );

    if (current.question && answer && shouldKeep) {
      cards.push({
        question: current.question,
        answer
      });
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      const level = heading[1].length;
      const question = heading[2].trim();
      const isQuestionHeading = question.endsWith("?");

      if (isQuestionHeading || includeStudySections) {
        if (current && level > current.level) {
          if (current.isQuestion) {
            current.answer.push(line);
            continue;
          }

          current.hasNestedHeading = true;
          flush();
          current = null;
        }

        flush();
        current = {
          question,
          level,
          isQuestion: isQuestionHeading,
          hasNestedHeading: false,
          answer: []
        };
        continue;
      }

      if (current && level <= current.level) {
        flush();
        current = null;
      }
    }

    if (current) current.answer.push(line);
  }

  flush();
  return cards;
}

export function parseLegacyHeadingFallbackCards(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  const cards = [];
  let current = null;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const answer = cleanToggleContent(current.answer);
    if (current.question && answer) {
      cards.push({
        question: current.question,
        answer
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line.trim())) inFence = !inFence;

    const heading = inFence ? null : line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      current = {
        question: heading[2].trim(),
        answer: []
      };
      continue;
    }

    if (current) current.answer.push(line);
  }

  flush();
  return cards;
}

export function countQuestionHeadings(markdown) {
  return normalizeMarkdown(markdown)
    .split("\n")
    .filter((line) => /^#{2,6}\s+.+\?\s*$/.test(line.trim()))
    .length;
}

// True when the markdown carries syntax that can only mean "these are cards":
// `::` blocks, <details> toggles, `>` toggle blocks, Q:/A: pairs, or headings
// that are literally questions. Plain prose under plain headings is NOT card
// syntax — it's a notes document, and treating it as cards is what used to
// shred imported notes into hundreds of flashcards.
export function hasExplicitCardSyntax(markdown) {
  const source = removeEmptyHeadingGroups(stripReaderMetadata(extractNotesFromMarkdown(markdown).markdown));
  if (delimitedCardBoundaryPattern.test(source)) return true;
  if (parseDetailsCards(source).length) return true;
  if (parseQACards(source).length) return true;
  if (parseBlockquoteCards(source).length) return true;
  return countQuestionHeadings(source) > 0;
}

// How confidently this markdown reads as flashcards:
//   "explicit"  — real card syntax (see hasExplicitCardSyntax)
//   "heuristic" — only plain `##` headings with text under them; these MIGHT be
//                 cards, but a notes document looks identical, so the import UI
//                 offers the choice instead of deciding silently
//   "none"      — nothing card-shaped at all
export function classifyCardSyntax(markdown) {
  if (hasExplicitCardSyntax(markdown)) return "explicit";
  const source = removeEmptyHeadingGroups(stripReaderMetadata(extractNotesFromMarkdown(markdown).markdown));
  return parseLegacyHeadingFallbackCards(source).length ? "heuristic" : "none";
}

// `allowHeuristicHeadings: false` restricts the result to explicit card syntax,
// so callers that are only asking "does this file contain real cards?" don't
// get a plain document chopped up at its headings.
export function parseCards(markdown, { allowHeuristicHeadings = true } = {}) {
  // Deck notes blocks are never card material — strip them defensively so
  // notes content can't leak into any of the parsers below.
  const withoutNotes = extractNotesFromMarkdown(markdown).markdown;
  const source = removeEmptyHeadingGroups(stripReaderMetadata(withoutNotes));
  const delimitedCards = parseDelimitedCards(source);
  const hasDelimitedCardSyntax = delimitedCardBoundaryPattern.test(source);
  const structuredLegacyCards = [
    ...parseDetailsCards(source),
    ...parseBlockquoteCards(source),
    ...parseQACards(source)
  ];
  const questionHeadingCards = parseHeadingCards(source, { includeStudySections: false });
  const legacyHeadingCards = allowHeuristicHeadings ? parseLegacyHeadingFallbackCards(source) : [];
  const parsedCards = delimitedCards.length
    ? delimitedCards
    : hasDelimitedCardSyntax
      ? []
    : structuredLegacyCards.length
      ? [
        ...structuredLegacyCards,
        ...parseHeadingCards(source, { includeStudySections: allowHeuristicHeadings })
      ]
      : legacyHeadingCards.length
        ? legacyHeadingCards
        : allowHeuristicHeadings
          ? parseHeadingCards(source, { includeStudySections: true })
          : questionHeadingCards;
  const seen = new Set();
  const cards = parsedCards.filter((card) => {
    const key = `${card.question.trim()}\u0000${card.answer.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ids include a random suffix because card ids are the GLOBAL primary key in
  // the cloud `cards` table (not scoped per deck): a purely index+question id
  // collides whenever two decks are imported from similar (or the same)
  // markdown, and the sync upsert would then silently reassign the existing
  // row's deck_id — stealing the card from the other deck.
  return cards.map((card, index) => ({
    id: `${index}-${card.question.slice(0, 24)}-${Math.random().toString(36).slice(2, 8)}`,
    question: card.question,
    answer: card.answer
  }));
}

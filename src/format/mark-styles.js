// How a text mark on a PDF is drawn: a tint over the words, or a line under
// them, through them, a wave under them, or a box round them.
//
// A LEAF — it imports nothing — so the screen (styles/88-annotations.css), the
// pictures of a page (src/documents/pdf-region-marks.js), the printed export
// (src/documents/pdf-export.js) and the native-annotation writer all read the
// same five words and the same geometry, and a pure-Node check can drive it.
//
// ── Why a field on the highlight and not a kind of its own ────────────────
//
// An underline is a highlight in every way that matters to the rest of the
// app: it is a run of words with a note, a card, a row in the Highlights pane, a
// tombstone when it goes and a merge by id on the next sync. Only how it is
// DRAWN differs. So a text record carries `style`, absent for the tint every
// record written before this existed was, and everything that is not drawing
// reads straight past it. An older build that meets one draws a tint, which is
// the right way for it to be wrong.
//
// ...and `hex`, for a colour from the pen's palette or of the reader's own.
// `color` is still one of the four highlight tokens (the nearest — see
// inkFilingColor), because the Highlights pane files and filters by it and an
// older build paints by it.

export const MARK_STYLE_DEFAULT = "highlight";

export const MARK_STYLES = ["highlight", "underline", "strike", "squiggly", "box"];

export const MARK_STYLE_LABELS = {
  highlight: "Highlight",
  underline: "Underline",
  strike: "Strikethrough",
  squiggly: "Squiggly underline",
  box: "Box"
};

export function normalizeMarkStyle(style) {
  return MARK_STYLES.includes(String(style || "")) ? String(style) : MARK_STYLE_DEFAULT;
}

// The style a record is DRAWN with.
export function markStyleOf(record) {
  return normalizeMarkStyle(record?.style);
}

// `#rrggbb` or null. Three digits are widened, as a colour input may hand back.
export function normalizeMarkHex(hex) {
  const text = String(hex || "").trim().toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(text);
  return long ? `#${long[1]}` : null;
}

// ── The geometry, as fractions of one line's box ──────────────────────────
//
// A quad is one line of words from the top of the tallest ascender to the
// bottom of the lowest descender. The line under the words sits a little above
// that bottom — on the descenders rather than below them, where it would read
// as belonging to the next line — and the strike sits just under the middle,
// through the x-height rather than through the capitals.
//
// In fractions of the quad's own height so a footnote and a title are struck
// alike, floored in pixels by the caller so a line on a small zoom is not lost.
export const MARK_LINE = Object.freeze({
  // Thickness of an underline or a strike.
  thickness: 0.075,
  // Where the underline's centre is, from the top of the box.
  underlineAt: 0.88,
  // Where the strike's centre is.
  strikeAt: 0.5,
  // The wave: its height, and where its centre is.
  waveHeight: 0.24,
  waveAt: 0.86,
  // An outline's thickness, for a box.
  box: 0.06
});

// One wave of the squiggle is this many times its own height long.
export const MARK_WAVE_PERIOD = 2.2;

// The squiggle along a line from x0 to x1, centred at y, `height` tall — as a
// flat list of [x, y] points a canvas or a PDF content stream can stroke.
// Sampled rather than drawn with curves so the two ends meet the box exactly
// whatever its width, and a content stream needs nothing beyond `l`.
export function squigglePoints(x0, x1, y, height) {
  const amp = Math.max(0.5, height / 2);
  const period = Math.max(2, height * MARK_WAVE_PERIOD);
  const width = Math.max(0, x1 - x0);
  const steps = Math.max(2, Math.ceil((width / period) * 8));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = x0 + (width * i) / steps;
    points.push([x, y + Math.sin(((x - x0) / period) * Math.PI * 2) * amp]);
  }
  return points;
}

// What to draw for one line box, in whatever space the box is in (y DOWN):
// { fill: [left, top, width, height] } for a tint,
// { bars: [[left, top, width, height]] } for a solid line,
// { wave: [[x, y], …], width } for a stroked squiggle,
// { outline: [left, top, width, height], width } for a box.
// `minLine` is the thinnest a line may be, in the same units.
export function markGeometry(style, left, top, width, height, minLine = 1) {
  const s = normalizeMarkStyle(style);
  if (s === "highlight") return { fill: [left, top, width, height] };
  if (s === "box") {
    const line = Math.max(minLine, height * MARK_LINE.box);
    return { outline: [left + line / 2, top + line / 2, Math.max(0, width - line), Math.max(0, height - line)], width: line };
  }
  if (s === "squiggly") {
    const wave = Math.max(minLine * 2, height * MARK_LINE.waveHeight);
    const line = Math.max(minLine, height * MARK_LINE.thickness * 0.8);
    return { wave: squigglePoints(left, left + width, top + height * MARK_LINE.waveAt, wave), width: line };
  }
  const line = Math.max(minLine, height * MARK_LINE.thickness);
  const at = s === "strike" ? MARK_LINE.strikeAt : MARK_LINE.underlineAt;
  return { bars: [[left, top + height * at - line / 2, width, line]] };
}

// Draw one box's mark onto a 2D context in `color` (a CSS colour). The caller
// sets compositing; this only paints.
export function paintMarkGeometry(ctx, geometry, color, fillColor = color) {
  if (!geometry) return;
  if (geometry.fill) {
    ctx.fillStyle = fillColor;
    ctx.fillRect(...geometry.fill);
    return;
  }
  ctx.save();
  if (geometry.bars) {
    ctx.fillStyle = color;
    geometry.bars.forEach((bar) => ctx.fillRect(...bar));
  } else if (geometry.outline) {
    ctx.strokeStyle = color;
    ctx.lineWidth = geometry.width;
    ctx.strokeRect(...geometry.outline);
  } else if (geometry.wave) {
    ctx.strokeStyle = color;
    ctx.lineWidth = geometry.width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    geometry.wave.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
}

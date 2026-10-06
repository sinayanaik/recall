// A 2D context that draws nothing and remembers everything.
//
// The page renderer's worker bakes the reader's highlights and ink into a page's
// picture (src/documents/pdf-pictures.js), and the code that knows how to paint
// them — paintRegionMarks, paintInkLayers — lives on the main thread, where it
// also has to: a pen's colour is a theme token, resolved against the document's
// computed styles. Re-writing that painting inside the worker would be a second
// copy of it to keep in step with the first, and the first time they drifted a
// baked highlight would stop matching the one drawn over the page.
//
// So the same functions run here, against this, and what comes out is the list
// of calls — plain arrays, structured-cloneable — which the worker replays onto
// the page's own canvas (replayOps in src/documents/pdf-render-worker.js):
//
//   ["=fillStyle", "rgba(…)"]     a property set
//   ["fillRect", x, y, w, h]      a method call
//   ["layer:begin"] … ["layer:end", "multiply"]
//                                 a group painted onto a scratch canvas and
//                                 blended back once (beginLayer / endLayer)
//
// The properties a painter READS back (globalAlpha, globalCompositeOperation —
// paintInkStroke saves and restores them by hand) are tracked here, through
// save() and restore(), so they answer what a real context would.

const STATE_PROPS = [
  "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "globalAlpha",
  "globalCompositeOperation", "imageSmoothingEnabled", "miterLimit", "lineDashOffset"
];

const METHODS = [
  "save", "restore", "setTransform", "transform", "translate", "scale", "rotate", "resetTransform",
  "beginPath", "closePath", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc", "arcTo",
  "ellipse", "rect", "roundRect", "fill", "stroke", "clip", "fillRect", "strokeRect", "clearRect", "setLineDash"
];

const DEFAULTS = {
  fillStyle: "#000000",
  strokeStyle: "#000000",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  imageSmoothingEnabled: true,
  miterLimit: 10,
  lineDashOffset: 0
};

export function createRecordingContext() {
  const ops = [];
  let current = { ...DEFAULTS };
  const stack = [];
  const ctx = {
    ops,
    // So painters that ask "is this a recording" can group what a real context
    // would have to blend piece by piece.
    isRecording: true,
    beginLayer() { ops.push(["layer:begin"]); },
    endLayer(blend = "source-over") { ops.push(["layer:end", blend]); }
  };
  STATE_PROPS.forEach((prop) => {
    Object.defineProperty(ctx, prop, {
      get() { return current[prop]; },
      set(value) {
        current[prop] = value;
        ops.push([`=${prop}`, value]);
      },
      enumerable: true
    });
  });
  METHODS.forEach((name) => {
    ctx[name] = (...args) => {
      if (name === "save") stack.push({ ...current });
      else if (name === "restore") current = stack.pop() || { ...DEFAULTS };
      ops.push([name, ...args.map((a) => (Array.isArray(a) ? [...a] : a))]);
    };
  });
  return ctx;
}

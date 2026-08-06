// Recall Clipper — recover each formula's ORIGINAL LaTeX from the page's own
// MathJax instance. Runs in the page's MAIN world (see background.js), which is
// the whole point: `MathJax` is a page global, invisible from the isolated world
// every other file here lives in.
//
// Why this is worth a second injection world: MathJax 3 renders to CHTML and,
// with the a11y extension, an assistive-MathML tree. Neither is the author's
// source — MathML is a *re-rendering*, so reconstructing LaTeX from it gives you
// something that means the same thing and doesn't look the same. A Jupyter Book
// equation written
//
//     \left[ \begin{array}{c} x_{\mathrm{left}} \\ y_{\mathrm{left}} \end{array}\right]
//
// comes back from the MathML as `[\begin{matrix} x_{\mathrm{left}} \\ … \end{matrix}]`:
// same content, unsized brackets, wrong environment. MathJax kept the real
// string all along, on the MathItem whose `typesetRoot` IS the <mjx-container>
// in the DOM. So: walk its list, stamp the source onto the container, and let
// the content script read it back off the attribute like any other markup.
//
// Stamps are removed again when the picker is torn down (see destroy() in
// picker.js), so the page is left exactly as it was found.
(function () {
  "use strict";

  const TEX_ATTR = "data-recall-tex";
  const DISPLAY_ATTR = "data-recall-tex-display";
  let stamped = 0;

  function stamp(node, tex, display) {
    if (!node || !node.setAttribute) return;
    const source = String(tex == null ? "" : tex).trim();
    if (!source) return;
    node.setAttribute(TEX_ATTR, source);
    if (display) node.setAttribute(DISPLAY_ATTR, "1");
    stamped += 1;
  }

  // ---- MathJax 3 ----------------------------------------------------------
  // `startup.document.math` is a linked list of MathItem; each carries the input
  // string (`math`), whether it was display mode, and the element it typeset to.
  try {
    const doc = window.MathJax && window.MathJax.startup && window.MathJax.startup.document;
    if (doc && doc.math) {
      for (const item of doc.math) stamp(item.typesetRoot, item.math, item.display);
    }
  } catch (_) { /* not MathJax 3, or a version that moved this */ }

  // ---- MathJax 2 ----------------------------------------------------------
  // Every jax knows its own source; the rendered span is "<inputID>-Frame".
  // The DOM already carries the <script type="math/tex"> here, so this is only
  // a backstop for pages that strip it after typesetting.
  try {
    const hub = window.MathJax && window.MathJax.Hub;
    if (hub && typeof hub.getAllJax === "function") {
      for (const jax of hub.getAllJax()) {
        const source = jax.SourceElement && jax.SourceElement();
        const node = document.getElementById(`${jax.inputID}-Frame`) || source;
        const display = Boolean(source && /mode=display/.test(source.type || ""));
        stamp(node, jax.originalText, display);
      }
    }
  } catch (_) { /* not MathJax 2 */ }

  // Read back by the content script through the injection's return value.
  return stamped;
})();

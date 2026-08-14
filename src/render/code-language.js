// Guessing a language for a bare ``` fence, and the Prism grammars that
// render it. Kept together because the inference tables, the thresholds they
// are scored against and the loader that acts on the result are one decision.

export const codeLanguageAliases = {
  cjs: "javascript",
  coffee: "coffeescript",
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  html: "markup",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  tex: "latex",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml"
};

// ── Guessing a language for undeclared fences ──────────────────────────────
// Plenty of code arrives in notes as a bare ``` fence with no language —
// pasted from chat, from a PDF, typed in a hurry. Those blocks render as flat
// grey text (no highlighting, no badge), and — the reason this matters most —
// a selection lifted out of one can only ever be re-fenced as a bare ```.
// Each entry scores a body against weighted signals; the winner needs both an
// absolute score (INFER_SCORE_FLOOR) and a clear margin over the runner-up, so
// prose, logs and pseudocode stay unlabelled rather than being mislabelled.
// Negative weights are counter-evidence (semicolon line endings aren't
// Python; `: string` isn't plain JavaScript).
export const CODE_LANGUAGE_SIGNATURES = [
  ["python", [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->[^:]*)?:/m, 5],
    [/^\s*(?:async\s+)?def\s/m, 3],
    [/^\s*class\s+\w+\s*(?:\([^)]*\))?\s*:\s*$/m, 4],
    [/^\s*(?:from\s+[\w.]+\s+)?import\s+[\w.*]/m, 3],
    [/^\s*(?:if|elif|else|for|while|try|except|finally|with)\b[^\n{]*:\s*$/m, 3],
    [/\bself\./, 4],
    [/\b(?:True|False|None)\b/, 2],
    [/\bprint\s*\(/, 3],
    [/\b(?:lambda|yield|elif|__init__|__name__)\b/, 3],
    [/^\s*@\w+(?:\.\w+)*(?:\([^)]*\))?\s*$/m, 2],
    // Notebook/data-science lines are half of what gets pasted into notes and
    // carry none of the keywords above.
    [/\b(?:np|pd|plt|df|sns|torch|tf|nn|sk)\.\w+/, 3],
    [/\.(?:fit|predict|transform|head|describe|dropna|groupby)\s*\(/, 3],
    [/;\s*$/m, -2],
    [/^\s*[\w)\]"']\s*;\s*$/m, -3],
    [/\b(?:const|let|var|function)\s+\w+\s*=/, -3],
    [/\{\s*$/m, -1]
  ]],
  ["typescript", [
    [/\b(?:interface|type)\s+\w+\s*(?:<[^>]*>)?\s*[={]/, 5],
    [/:\s*(?:string|number|boolean|any|void|unknown|never)\b/, 4],
    [/\b(?:public|private|protected|readonly)\s+\w+\s*[:(]/, 4],
    [/\bimplements\s+\w/, 3],
    [/\benum\s+\w+\s*\{/, 4],
    [/\bas\s+(?:const|string|number|unknown)\b/, 3],
    [/\b(?:const|let)\s+\w+\s*:\s*\w/, 4],
    [/\bfunction\s+\w+\s*\([^)]*\)\s*:\s*\w/, 4]
  ]],
  ["javascript", [
    [/\b(?:const|let|var)\s+[\w{[$]/, 3],
    [/\bfunction\s*\w*\s*\(/, 3],
    [/=>\s*[{(\w'"`]/, 3],
    [/\b(?:console|document|window)\.\w+/, 3],
    [/\b(?:require|module\.exports|export\s+(?:default|const|function)|import\s+.*\bfrom\b)/, 3],
    [/\b(?:async|await)\b/, 2],
    [/===|!==|\?\?|\?\./, 2],
    [/\b(?:null|undefined|true|false)\b/, 1],
    [/;\s*$/m, 1],
    [/:\s*(?:string|number|boolean)\b/, -3],
    [/\binterface\s+\w+\s*\{/, -3]
  ]],
  ["java", [
    [/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\]]+\s+\w+\s*\(/, 5],
    [/\bSystem\.out\.print/, 6],
    [/\bpublic\s+(?:final\s+)?class\s+\w+/, 4],
    [/\bimport\s+(?:java|javax)\./, 5],
    [/\bnew\s+[A-Z]\w*\s*(?:<[^>]*>)?\s*\(/, 2],
    [/\bvoid\s+main\s*\(/, 3],
    [/@Override\b/, 3]
  ]],
  ["csharp", [
    [/\busing\s+System(?:\.\w+)*\s*;/, 5],
    [/\bnamespace\s+[\w.]+/, 4],
    [/\bConsole\.(?:Write|Read)/, 5],
    [/\bpublic\s+(?:static\s+)?(?:async\s+)?[\w<>\[\]]+\s+\w+\s*\(/, 2],
    [/\bvar\s+\w+\s*=\s*new\b/, 2],
    [/\b(?:string|int|bool)\s+\w+\s*=/, 1],
    [/\{\s*get;\s*set;\s*\}/, 5]
  ]],
  ["cpp", [
    [/#include\s*<(?:iostream|vector|string|map|algorithm|memory|cstdio)>/, 6],
    [/#include\s*<bits\/stdc\+\+\.h>/, 6],
    [/\bstd::\w+/, 5],
    [/\b(?:cout|cin|endl)\b/, 4],
    [/\btemplate\s*</, 4],
    [/\bnamespace\s+\w+\s*\{/, 3],
    [/\bnullptr\b/, 3],
    [/\b(?:public|private|protected)\s*:/, 3]
  ]],
  ["c", [
    [/#include\s*<[\w./+-]+>/, 5],
    [/\bprintf\s*\(/, 4],
    [/\b(?:int|void|char|float|double)\s+\w+\s*\([^)]*\)\s*\{/, 3],
    [/\bmalloc\s*\(|\bfree\s*\(/, 3],
    [/\bstruct\s+\w+\s*\{/, 2],
    [/^\s*(?:unsigned\s+|signed\s+|const\s+)?(?:int|char|float|double|long|short|size_t|void)\s+\*?\w+\s*(?:=|;|\[)/m, 3],
    [/\bfor\s*\(\s*(?:int|size_t|unsigned|long)\s+\w+\s*=/, 4],
    [/\bstd::/, -5],
    [/\bclass\s+\w+/, -4]
  ]],
  ["go", [
    [/\bfunc\s+(?:\([^)]*\)\s*)?\w+\s*\(/, 5],
    [/\bpackage\s+\w+\s*$/m, 4],
    [/\bfmt\.\w+/, 5],
    [/:=/, 4],
    [/\bimport\s+\(/, 3],
    [/\b(?:defer|go|chan)\b/, 3]
  ]],
  ["rust", [
    [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/, 5],
    [/\blet\s+mut\b/, 5],
    [/\b(?:println!|vec!|format!|panic!)/, 6],
    [/\bimpl\s+\w/, 4],
    [/->\s*(?:Result|Option|Vec|String|&str|[iu](?:8|16|32|64|size))\b/, 4],
    [/\buse\s+(?:std|crate)::/, 4],
    [/&(?:mut\s+)?self\b/, 3]
  ]],
  ["ruby", [
    [/^\s*def\s+\w+[!?]?(?:\([^)]*\))?\s*$/m, 4],
    [/^\s*end\s*$/m, 4],
    [/\bputs\s+/, 4],
    [/\brequire\s+['"]/, 3],
    [/\b(?:do\s*\|[^|]*\||nil|elsif)\b/, 3],
    [/@\w+\s*=/, 2],
    [/\battr_(?:accessor|reader|writer)\b/, 5]
  ]],
  ["php", [
    [/<\?php/, 6],
    [/\$\w+\s*=/, 3],
    [/\becho\s+/, 2],
    [/\bfunction\s+\w+\s*\([^)]*\)\s*\{/, 1],
    [/->\w+\s*\(/, 1],
    [/\bpublic\s+function\b/, 4]
  ]],
  ["sql", [
    [/\bSELECT\b[\s\S]*\bFROM\b/i, 6],
    [/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i, 5],
    [/\bCREATE\s+(?:TABLE|INDEX|VIEW|DATABASE)\b/i, 6],
    [/\bALTER\s+TABLE\b/i, 6],
    [/\b(?:INNER|LEFT|RIGHT|FULL)\s+JOIN\b/i, 4],
    [/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING)\b/i, 2],
    // Keeps prose that happens to say "create table of contents" out of SQL.
    [/\b(?:the|this|these|those|your|our|which|because|when)\b/i, -4]
  ]],
  ["bash", [
    [/^#!.*\b(?:ba|z|k)?sh\b/, 6],
    [/^\s*\$\s+\w/m, 3],
    [/\b(?:sudo|apt-get|yum|brew|chmod|chown|mkdir|grep|sed|awk|curl|wget|tar|ssh|scp)\b/, 3],
    [/\b(?:npm|yarn|pnpm|pip|pip3|git|docker|kubectl|cargo|go|make)\s+\w[\w-]*/, 3],
    [/\becho\s+["'$]/, 2],
    [/\$\{?\w+\}?/, 1],
    [/^\s*(?:export|source)\s+\w/m, 3],
    [/\|\s*(?:grep|sed|awk|xargs|head|tail|sort|uniq|jq)\b/, 3],
    [/^\s*(?:npm|npx|yarn|pnpm|pip3?|git|docker|kubectl|cargo|cd|ls|cat|mv|cp|rm|touch|mkdir|export|python3?|node|brew|apt|apt-get)\s+\S/m, 4],
    [/\s-{1,2}[A-Za-z][\w-]*(?:\s|$)/, 2],
    [/^\s*(?:if|for|while)\b.*;\s*(?:then|do)\s*$/m, 4],
    [/^\s*fi\s*$|^\s*done\s*$/m, 3]
  ]],
  ["json", [
    [/^\s*[{[][\s\S]*[}\]]\s*$/, 3],
    [/"[\w.-]+"\s*:/, 4],
    [/:\s*(?:"[^"]*"|\d+(?:\.\d+)?|true|false|null|[{[])\s*,?\s*$/m, 2],
    [/^\s*(?:\/\/|#)/m, -4],
    [/[;=]\s*$/m, -4],
    [/\b(?:function|def|class|const|let|var|return)\b/, -4]
  ]],
  ["yaml", [
    [/^---\s*$/m, 4],
    [/^\s*[\w.-]+:\s*(?:$|[^:\n]*$)/m, 2],
    [/^\s*-\s+[\w"'{[]/m, 2],
    [/^\s*#\s/m, 1],
    [/[{};]\s*$/m, -3],
    [/^\s*"[\w.-]+"\s*:/m, -2]
  ]],
  ["markup", [
    [/<!DOCTYPE\s+html>/i, 6],
    [/<(?:html|head|body|div|span|p|a|h[1-6]|ul|ol|li|table|tr|td|th|form|label|select|option|textarea|nav|main|article|aside|section|header|footer|script|style|img|input|button|br|hr|meta|link)\b[^>]*>/i, 4],
    [/<\/(?:div|span|p|a|h[1-6]|li|ul|ol|body|html|section|table|tr|td|th|form|nav|main|article|header|footer|button|label)>/i, 4],
    [/<\w+[^>]*\/>/, 2]
  ]],
  ["xml", [
    [/<\?xml\b/, 6],
    [/<\/[\w:-]+>/, 1],
    [/xmlns(?::\w+)?\s*=/, 4]
  ]],
  ["css", [
    [/^[^{}]*\{[^{}]*:[^{}]*;[^{}]*\}/m, 4],
    [/\b(?:color|background|margin|padding|font-size|display|position|flex|grid-template)\s*:/, 4],
    [/^\s*[.#]?[\w-]+(?:[.#:][\w-]+)*\s*(?:,\s*)?\{\s*$/m, 3],
    [/@(?:media|import|keyframes|font-face)\b/, 4],
    [/--[\w-]+\s*:/, 3],
    [/\b(?:function|return|if)\s*\(/, -4]
  ]],
  ["dockerfile", [
    [/^\s*FROM\s+\S+/m, 5],
    [/^\s*(?:RUN|CMD|COPY|ADD|ENTRYPOINT|WORKDIR|EXPOSE|ENV|ARG)\s+\S/m, 3]
  ]],
  ["diff", [
    [/^(?:diff --git|@@ -\d)/m, 8],
    [/^[+-]{3}\s+\S/m, 3]
  ]]
];

// Two tiers, because most fences in real notes are three lines long. A
// confident win needs a high score AND daylight over the runner-up; failing
// that, any single real signal still beats leaving the block blank, as long as
// nothing else scored as well (`console.log(…)` is JavaScript; `int x = 10;`
// on its own is C-family and could be four different languages, so it isn't).
export const INFER_SCORE_FLOOR = 6;

export const INFER_SCORE_MARGIN = 2;

export const INFER_WEAK_FLOOR = 3;

// Blocks nothing matches still get a language, so every block renders and
// copies the same way and no selection is ever fenced bare. Prism defines
// `text` as an empty grammar, so it highlights to exactly what you typed
// rather than 404ing the autoloader on a language that doesn't exist.
export const GENERIC_CODE_LANGUAGE = "text";

export const INFER_SAMPLE_CHARS = 2000;

// Guessed language for an undeclared block, or "" when nothing scored at all.
// Scores the block as a whole (not the selection), so every selection out of a
// block — and the block's own badge — agree on one answer.
export function inferCodeLanguage(source) {
  const text = String(source || "");
  if (!text.trim()) return "";
  const sample = text.length > INFER_SAMPLE_CHARS ? text.slice(0, INFER_SAMPLE_CHARS) : text;
  let best = "";
  let bestScore = 0;
  let runnerUp = 0;
  for (const [language, signals] of CODE_LANGUAGE_SIGNATURES) {
    let score = 0;
    for (const [pattern, weight] of signals) {
      if (pattern.test(sample)) score += weight;
    }
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = language;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (bestScore >= INFER_SCORE_FLOOR && bestScore - runnerUp >= INFER_SCORE_MARGIN) return best;
  if (bestScore >= INFER_WEAK_FLOOR && bestScore > runnerUp) return best;
  return "";
}

// The language to render, badge and fence a block with — the guess when there
// is one, the generic fallback when there isn't. Every code block gets an
// answer here; nothing is left blank.
export function codeLanguageOrGeneric(language) {
  return language || GENERIC_CODE_LANGUAGE;
}

export let prismPythonConfigured = false;

export function configurePrismLanguages() {
  if (prismPythonConfigured || !window.Prism?.languages?.python) return;

  Prism.languages.insertBefore("python", "function", {
    method: {
      pattern: /(\.)[A-Za-z_]\w*(?=\s*\()/,
      lookbehind: true
    },
    "uppercase-constant": /\b[A-Z][A-Z0-9_]*\b/
  });

  prismPythonConfigured = true;
}

export function declaredCodeLanguage(code) {
  const languageClass = Array.from(code.classList).find((className) => className.startsWith("language-"));
  return languageClass ? languageClass.replace(/^language-/, "").trim() : "";
}

export function normalizeCodeLanguage(language) {
  const normalized = String(language || "").toLowerCase();
  return codeLanguageAliases[normalized] || normalized;
}

export function codeLanguageLabel(language) {
  return language
    .replace(/^language-/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toUpperCase();
}

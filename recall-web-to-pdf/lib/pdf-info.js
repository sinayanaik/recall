// Writes a document information dictionary into a finished PDF, as an
// incremental update: the original bytes stay exactly as they are, and a new
// Info object, a one-entry xref section and a trailer pointing back at the old
// one (/Prev) are appended. Every PDF reader resolves the newest trailer, so
// the new /Info wins. This is the whole of what a library like pdf-lib would
// have been needed for, in ~150 lines with no dependency.
//
// Recall reads the custom keys (/RecallSourceURL and friends) when the PDF is
// imported — see importPdfFile in the app's src/import/pdf.js.
//
// Plain ES module: used by background.js, and by the app's checks under Node.

const latin1 = new TextDecoder("latin1");

function tail(bytes, n) {
  return latin1.decode(bytes.subarray(Math.max(0, bytes.length - n)));
}

// The dictionary that begins at `text[start]` ("<<"), balanced.
function dictAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === "<" && text[i + 1] === "<") { depth += 1; i += 1; }
    else if (text[i] === ">" && text[i + 1] === ">") {
      depth -= 1; i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** The facts of the last trailer: { startxref, root, size, id, info }. */
export function readTrailer(bytes) {
  const end = tail(bytes, 2048);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(end) || /startxref\s+(\d+)/.exec(end.slice(end.lastIndexOf("startxref")));
  if (!m) throw new Error("not a PDF: no startxref");
  const startxref = Number(m[1]);
  // The section startxref points at is either a classic "xref" table followed
  // by "trailer << … >>", or an xref stream object whose dictionary is the trailer.
  const window = latin1.decode(bytes.subarray(startxref, Math.min(bytes.length, startxref + 1024 * 1024)));
  let dict = null;
  if (window.startsWith("xref")) {
    const t = window.indexOf("trailer");
    if (t >= 0) dict = dictAt(window, window.indexOf("<<", t));
  } else {
    const o = window.indexOf("<<");
    if (o >= 0) dict = dictAt(window, o);
  }
  if (!dict) throw new Error("not a PDF: no trailer dictionary");
  const ref = (key) => {
    const r = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
    return r ? `${r[1]} ${r[2]} R` : null;
  };
  const size = /\/Size\s+(\d+)/.exec(dict);
  const id = /\/ID\s*(\[[^\]]*\])/.exec(dict);
  if (!ref("Root") || !size) throw new Error("not a PDF: trailer has no /Root or /Size");
  return { startxref, root: ref("Root"), info: ref("Info"), size: Number(size[1]), id: id ? id[1] : null };
}

// A text string as UTF-16BE hex with a byte-order mark: safe for any
// character, and needs no escaping.
export function pdfString(value) {
  const s = String(value ?? "");
  let hex = "FEFF";
  for (let i = 0; i < s.length; i += 1) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

export function pdfDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

const NAME_OK = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Returns new bytes: `bytes` with an Info dictionary appended.
 * @param {Uint8Array} bytes
 * @param {{Title?, Author?, Subject?, Keywords?, Creator?, Producer?, CreationDate?: Date, custom?: Record<string,string>}} info
 */
export function setPdfInfo(bytes, info) {
  const trailer = readTrailer(bytes);
  const objNum = trailer.size;
  const entries = [];
  for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]) {
    if (info[key]) entries.push(`/${key} ${pdfString(info[key])}`);
  }
  const created = pdfDate(info.CreationDate || new Date());
  if (created) entries.push(`/CreationDate ${created}`, `/ModDate ${created}`);
  for (const [key, value] of Object.entries(info.custom || {})) {
    if (value == null || value === "" || !NAME_OK.test(key)) continue;
    entries.push(`/${key} ${pdfString(value)}`);
  }

  const lead = bytes[bytes.length - 1] === 0x0a ? "" : "\n";
  const objStart = bytes.length + lead.length;
  const obj = `${lead}${objNum} 0 obj\n<< ${entries.join("\n   ")} >>\nendobj\n`;
  const xrefStart = bytes.length + obj.length;
  const trailerDict = [
    `/Size ${objNum + 1}`,
    `/Root ${trailer.root}`,
    `/Info ${objNum} 0 R`,
    `/Prev ${trailer.startxref}`,
    trailer.id ? `/ID ${trailer.id}` : ""
  ].filter(Boolean).join(" ");
  const xref = `xref\n${objNum} 1\n${String(objStart).padStart(10, "0")} 00000 n \ntrailer\n<< ${trailerDict} >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Everything appended is ASCII (strings are hex), so one byte per char.
  const extra = new Uint8Array(obj.length + xref.length);
  for (let i = 0; i < obj.length; i += 1) extra[i] = obj.charCodeAt(i);
  for (let i = 0; i < xref.length; i += 1) extra[obj.length + i] = xref.charCodeAt(i);
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes, 0);
  out.set(extra, bytes.length);
  return out;
}

/** How many pages a PDF has, by counting page objects (good enough to check a print). */
export function countPages(bytes) {
  const text = latin1.decode(bytes);
  const m = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

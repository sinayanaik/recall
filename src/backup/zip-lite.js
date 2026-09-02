// A zip reader and writer with the same shape as JSZip, for the two situations
// JSZip is not there.
//
// The first is the one that matters: **a backup you cannot take offline is a
// backup you do not have.** JSZip is fetched from a CDN on demand
// (src/core/lib-loader.js), so `exportLibraryBackupZip` opened with "Backup
// needs the zip library, which failed to load." and stopped — on a fresh
// install, on a plane, behind a firewall that blocks jsdelivr, or on the day the
// CDN is having a bad one. That is a PWA whose whole point is working offline
// refusing to let you get your own library out, at exactly the moment you most
// want a copy of it. src/export/zip.js has been writing valid archives with no
// library at all since the .docx export was built; there was never a reason for
// the backup to need one.
//
// The second is that tools/backup-check.mjs installs this as `globalThis.JSZip`
// and drives the real backup and restore through it in plain Node. That is only
// honest if the surface is genuinely the same, so this implements exactly the
// members src/backup/*.js touch and no more, and the check asserts that set has
// not grown behind its back.
//
// Written entries are STORED, not deflated. Two reasons and both are real: the
// archive is dominated by PDFs and already-compressed images, where DEFLATE buys
// a couple of percent for seconds of main-thread time on every megabyte; and a
// stored zip needs no compressor, which is the whole point when the thing that
// failed to arrive was the compressor. Reading handles both, because archives
// written by the JSZip path are deflated.

import { crc32, utf8Bytes } from "../export/zip.js?v=__BUILD__";

// The end-of-central-directory record stores offsets as uint32. Past 4GB a zip
// needs the ZIP64 extensions, which JSZip's own writer does not emit either — so
// rather than produce an archive that looks fine and cannot be opened, the
// writer refuses and says why. A library that large has no business being one
// blob in a browser tab regardless.
export const ZIP_LITE_MAX_BYTES = 0xffffffff;

const LOCAL_HEADER_SIG = 0x04034b50;

const CENTRAL_HEADER_SIG = 0x02014b50;

const END_RECORD_SIG = 0x06054b50;

// The end record is 22 bytes, plus up to 65535 of zip file comment after it, so
// finding it means scanning backwards over at most this much tail.
const END_RECORD_SEARCH = 22 + 0xffff;

async function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return utf8Bytes(value);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  throw new Error("Unsupported zip entry content");
}

// DEFLATE, raw (no zlib header) — which is what a zip member holds. Available
// in every browser this app supports and in Node, so reading a JSZip-written
// archive needs no library either.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This archive is compressed and this browser cannot decompress it");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// One member of an archive — read out of one, or waiting to be written into
// one. `async(type)` mirrors JSZip's, in the three forms src/backup/*.js asks
// for. Both origins are the same class on purpose: in JSZip, `zip.files[path]`
// is a readable entry whether the zip was loaded or built, and code that reads
// back what it just wrote (the check does, and so does anything that packs an
// archive and then verifies it) must not have to know which it is holding.
class LiteZipEntry {
  constructor(name, { bytes = null, method = 0, pending = null } = {}) {
    this.name = name;
    this.dir = name.endsWith("/");
    this._bytes = bytes;
    this._method = method;
    this._pending = pending;
    this._decoded = null;
  }

  async _raw() {
    if (this._decoded) return this._decoded;
    if (this._bytes === null && this._pending !== null) {
      this._bytes = await toUint8Array(this._pending);
      this._method = 0;
    }
    this._decoded = this._method === 8 ? await inflateRaw(this._bytes) : this._bytes;
    return this._decoded;
  }

  async async(type) {
    const bytes = await this._raw();
    if (type === "string") return new TextDecoder().decode(bytes);
    if (type === "uint8array") return bytes;
    // JSZip hands back an octet-stream blob for "blob" and the callers re-wrap
    // it with the type they recorded (see readBackupAssets), so matching that is
    // both correct and the thing they already handle.
    return new Blob([bytes], { type: "application/octet-stream" });
  }
}

export class LiteZip {
  constructor() {
    // JSZip exposes its members as a plain object keyed by path, and both
    // readBackupArchive and readBackupAssets index straight into it. Same here.
    this.files = {};
    this._order = [];
  }

  // JSZip's signature is file(path, content, options). The options bag is
  // accepted and ignored: everything written here is stored, so `compression`
  // has nothing to select.
  file(path, content) {
    const name = String(path);
    if (!(name in this.files)) this._order.push(name);
    this.files[name] = new LiteZipEntry(name, { pending: content });
    return this;
  }

  // JSZip's generateAsync(options, onUpdate). Returns a Blob when asked for one
  // and a Uint8Array otherwise. The parts are kept as separate chunks and handed
  // to the Blob as a list rather than concatenated first: a Blob built from
  // chunks can be spilled to disk by the browser, where one accumulated buffer
  // has to stay resident — which is the difference between backing up a library
  // of papers and crashing the tab that tried to.
  async generateAsync(options = {}, onUpdate = null) {
    const parts = [];
    const central = [];
    let offset = 0;
    let done = 0;

    for (const name of this._order) {
      const entry = this.files[name];
      const data = await entry._raw();
      const nameBytes = utf8Bytes(name);
      const checksum = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, LOCAL_HEADER_SIG, true);
      local.setUint16(4, 20, true);
      // Bit 11: the name is UTF-8. Without it a reader is entitled to decode a
      // deck called "Zellbiologie ünd" as CP437 and hand back mojibake.
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, 0, true);
      local.setUint16(12, 0, true);
      local.setUint32(14, checksum, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, CENTRAL_HEADER_SIG, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, 0, true);
      dir.setUint16(14, 0, true);
      dir.setUint32(16, checksum, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint16(30, 0, true);
      dir.setUint16(32, 0, true);
      dir.setUint16(34, 0, true);
      dir.setUint16(36, 0, true);
      dir.setUint32(38, 0, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
      if (offset > ZIP_LITE_MAX_BYTES) {
        throw new Error("This library is too large to archive without the zip library — go online and try again");
      }
      // The decoded copy is dropped as soon as its bytes are in the part list,
      // so a hundred papers are held one at a time rather than all at once. The
      // part list itself holds each one exactly once, and a Blob built from
      // those parts is what the browser is free to spill to disk.
      entry._decoded = null;
      done += 1;
      onUpdate?.({ percent: (done / this._order.length) * 100, currentFile: name });
    }

    const centralStart = offset;
    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END_RECORD_SIG, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this._order.length, true);
    end.setUint16(10, this._order.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);

    const chunks = [...parts, ...central, new Uint8Array(end.buffer)];
    if (options.type === "blob") return new Blob(chunks, { type: "application/zip" });
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  // Read an archive from a File, Blob, ArrayBuffer or Uint8Array. Parses the
  // CENTRAL DIRECTORY rather than walking local headers forward: the central
  // directory is the authoritative index (a local header may carry sizes of zero
  // and defer them to a data descriptor, which is exactly what a streaming
  // writer emits), and it is what every real zip tool reads.
  static async loadAsync(source) {
    const bytes = await toUint8Array(source);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let end = -1;
    const from = Math.max(0, bytes.length - END_RECORD_SEARCH);
    for (let i = bytes.length - 22; i >= from; i -= 1) {
      if (view.getUint32(i, true) === END_RECORD_SIG) { end = i; break; }
    }
    if (end < 0) throw new Error("this file is not a zip archive");

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const zip = new LiteZip();
    const decoder = new TextDecoder();

    for (let i = 0; i < count; i += 1) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_HEADER_SIG) {
        throw new Error("this archive's index is damaged");
      }
      const method = view.getUint16(at + 10, true);
      const compressedSize = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localAt = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

      // The local header's own name and extra lengths are the ones that place
      // the data — they are allowed to differ from the central directory's, and
      // in archives written by some tools they do.
      const localNameLength = view.getUint16(localAt + 26, true);
      const localExtraLength = view.getUint16(localAt + 28, true);
      const start = localAt + 30 + localNameLength + localExtraLength;
      const entry = new LiteZipEntry(name, { bytes: bytes.subarray(start, start + compressedSize), method });
      zip.files[name] = entry;
      zip._order.push(name);

      at += 46 + nameLength + extraLength + commentLength;
    }
    return zip;
  }
}

// The same call shape as ensureJsZip's users expect, so a caller can hold one
// value and not care which implementation it got.
export function liteZipFactory() {
  return LiteZip;
}

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
// It is now the writer for every package, not just the fallback — because it is
// the one that can be made to TALK. A library of papers used to sit on
// "Compressing the archive…" while JSZip deflated forty PDFs that do not
// compress, or on "Reading your decks…" while the CDN decided whether to
// answer. This writer never waits on a network, reports every file and every
// megabyte it gets through, yields to the page between chunks so the panel
// paints and Cancel answers, and hands a paper's Blob to the output as it is
// rather than copying it into memory first.
//
// What is compressed is chosen per entry, the JSZip way (`{ compression }` on
// file()): the JSON is deflated with the browser's own CompressionStream,
// asynchronously, where there is one; papers and images are STORED, because a
// PDF and a webp are already compressed and DEFLATE on them bought a couple of
// percent for seconds of main-thread time a megabyte. Where there is no
// CompressionStream everything is stored, which is still a valid zip.
//
// Reading is lazy for a File or Blob: the index at the end of the archive is
// read, and each member is sliced out of the file only when something asks for
// it. A two-gigabyte backup used to be read into one buffer before the preview
// could say anything at all. Every member read into memory is checked against
// the CRC the archive recorded for it.

import { crc32Table, utf8Bytes } from "../export/zip.js?v=__BUILD__";

// The end-of-central-directory record stores offsets as uint32. Past 4GB a zip
// needs the ZIP64 extensions, which JSZip's own writer does not emit either — so
// rather than produce an archive that looks fine and cannot be opened, the
// writer refuses and says why. A library that large has no business being one
// blob in a browser tab regardless.
export const ZIP_LITE_MAX_BYTES = 0xffffffff;

// ...and the entry count is a uint16 in the same record.
export const ZIP_LITE_MAX_ENTRIES = 0xffff;

const LOCAL_HEADER_SIG = 0x04034b50;

const CENTRAL_HEADER_SIG = 0x02014b50;

const END_RECORD_SIG = 0x06054b50;

// The end record is 22 bytes, plus up to 65535 of zip file comment after it, so
// finding it means scanning backwards over at most this much tail.
const END_RECORD_SEARCH = 22 + 0xffff;

// How much is checksummed between two yields to the page. A megabyte is a few
// milliseconds of work — short enough that the panel keeps painting and Cancel
// keeps answering through a hundred-megabyte paper.
export const ZIP_LITE_CHUNK = 1024 * 1024;

// Let the page breathe. scheduler.yield where there is one (it keeps this job's
// place in line), a zero timeout everywhere else.
export function yieldToPage() {
  if (globalThis.scheduler && typeof globalThis.scheduler.yield === "function") {
    return globalThis.scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isBlobLike(value) {
  return Boolean(value) && typeof value === "object" && typeof value.slice === "function"
    && typeof value.arrayBuffer === "function" && Number.isFinite(value.size);
}

async function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return utf8Bytes(value);
  if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
  throw new Error("Unsupported zip entry content");
}

// A running CRC-32, so a big member can be checksummed a chunk at a time.
export function crc32Update(crc, bytes) {
  const table = crc32Table();
  let c = crc;
  for (let i = 0; i < bytes.length; i += 1) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

export const CRC32_START = 0xffffffff;

export function crc32Finish(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC of a whole buffer, a chunk at a time with a yield between chunks.
async function crc32Chunked(bytes, onChunk) {
  let crc = CRC32_START;
  for (let at = 0; at < bytes.length; at += ZIP_LITE_CHUNK) {
    crc = crc32Update(crc, bytes.subarray(at, Math.min(bytes.length, at + ZIP_LITE_CHUNK)));
    onChunk?.(Math.min(bytes.length, at + ZIP_LITE_CHUNK));
    if (at + ZIP_LITE_CHUNK < bytes.length) await yieldToPage();
  }
  return crc32Finish(crc);
}

// CRC of a Blob without holding it: sliced and read a chunk at a time.
async function crc32OfBlob(blob, onChunk) {
  let crc = CRC32_START;
  for (let at = 0; at < blob.size; at += ZIP_LITE_CHUNK) {
    const end = Math.min(blob.size, at + ZIP_LITE_CHUNK);
    crc = crc32Update(crc, new Uint8Array(await blob.slice(at, end).arrayBuffer()));
    onChunk?.(end);
    await yieldToPage();
  }
  return crc32Finish(crc);
}

async function pumpStream(stream) {
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

// DEFLATE, raw (no zlib header) — which is what a zip member holds. Available
// in every browser this app supports and in Node, so reading a JSZip-written
// archive needs no library either.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This archive is compressed and this browser cannot decompress it");
  }
  return pumpStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
}

export function canDeflate() {
  return typeof CompressionStream === "function";
}

export function canInflate() {
  return typeof DecompressionStream === "function";
}

async function deflateRaw(bytes) {
  return pumpStream(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw")));
}

// One member of an archive — read out of one, or waiting to be written into
// one. `async(type)` mirrors JSZip's, in the three forms src/backup/*.js asks
// for. Both origins are the same class on purpose: in JSZip, `zip.files[path]`
// is a readable entry whether the zip was loaded or built, and code that reads
// back what it just wrote (the check does, and so does anything that packs an
// archive and then verifies it) must not have to know which it is holding.
class LiteZipEntry {
  constructor(name, { bytes = null, method = 0, pending = null, compression = "STORE", source = null, localAt = 0, compressedSize = 0, size = null, crc = null } = {}) {
    this.name = name;
    this.dir = name.endsWith("/");
    this._bytes = bytes;
    this._method = method;
    this._pending = pending;
    this._compression = compression;
    this._decoded = null;
    // A member of a loaded archive whose bytes are still on disk: where it is in
    // the file, how long it is, and what the archive says it should be.
    this._source = source;
    this._localAt = localAt;
    this._compressedSize = compressedSize;
    this._size = size;
    this._crc = crc;
    this._verified = false;
  }

  // The member's own bytes as they sit in the archive — still compressed if
  // they were written compressed. Sliced out of the file on first use.
  async _stored() {
    if (this._bytes !== null) return this._bytes;
    if (this._source) {
      const header = new DataView(await this._source.slice(this._localAt, this._localAt + 30).arrayBuffer());
      if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_HEADER_SIG) {
        throw new Error(`${this.name}: this archive is damaged (a file header is missing)`);
      }
      const start = this._localAt + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      this._bytes = new Uint8Array(await this._source.slice(start, start + this._compressedSize).arrayBuffer());
      return this._bytes;
    }
    if (this._pending !== null) {
      this._bytes = await toUint8Array(this._pending);
      this._method = 0;
      return this._bytes;
    }
    return new Uint8Array(0);
  }

  async _raw() {
    if (this._decoded) return this._decoded;
    const stored = await this._stored();
    const bytes = this._method === 8 ? await inflateRaw(stored) : stored;
    // The check the old reader never made. A member that was cut short or
    // flipped in transit decoded to something — and that something was restored
    // as though it were the file.
    if (this._crc !== null && !this._verified) {
      if (this._size !== null && bytes.length !== this._size) {
        throw new Error(`${this.name}: this file in the archive is incomplete (${bytes.length} of ${this._size} bytes)`);
      }
      const actual = await crc32Chunked(bytes);
      if (actual !== this._crc) throw new Error(`${this.name}: this file in the archive is damaged (checksum mismatch)`);
      this._verified = true;
    }
    this._decoded = bytes;
    return bytes;
  }

  // The uncompressed length, from the archive's own index where there is one —
  // known without reading the member.
  get size() {
    if (this._size !== null) return this._size;
    if (isBlobLike(this._pending)) return this._pending.size;
    return null;
  }

  async async(type) {
    // A stored member of an archive on disk is handed back as a slice of the
    // file: a hundred-megabyte paper never has to be read into memory to be
    // written somewhere else. Its integrity is checked by the caller's own
    // hash (commitBackupDocuments), which it computes anyway.
    if (type === "blob" && this._source && this._method === 0 && this._bytes === null) {
      const header = new DataView(await this._source.slice(this._localAt, this._localAt + 30).arrayBuffer());
      if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_HEADER_SIG) {
        throw new Error(`${this.name}: this archive is damaged (a file header is missing)`);
      }
      const start = this._localAt + 30 + header.getUint16(26, true) + header.getUint16(28, true);
      return this._source.slice(start, start + this._compressedSize, "application/octet-stream");
    }
    if (type === "blob" && isBlobLike(this._pending) && this._bytes === null) return this._pending;
    const bytes = await this._raw();
    if (type === "string") return new TextDecoder().decode(bytes);
    if (type === "uint8array") return bytes;
    // JSZip hands back an octet-stream blob for "blob" and the callers re-wrap
    // it with the type they recorded (see readBackupAssets), so matching that is
    // both correct and the thing they already handle.
    return new Blob([bytes], { type: "application/octet-stream" });
  }
}

function localHeader({ crc, compressedSize, size, method, nameBytes }) {
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, LOCAL_HEADER_SIG, true);
  local.setUint16(4, 20, true);
  // Bit 11: the name is UTF-8. Without it a reader is entitled to decode a
  // deck called "Zellbiologie ünd" as CP437 and hand back mojibake.
  local.setUint16(6, 0x0800, true);
  local.setUint16(8, method, true);
  local.setUint16(10, 0, true);
  local.setUint16(12, 0x21, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, compressedSize, true);
  local.setUint32(22, size, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, 0, true);
  return new Uint8Array(local.buffer);
}

function centralHeader({ crc, compressedSize, size, method, nameBytes, offset }) {
  const dir = new DataView(new ArrayBuffer(46));
  dir.setUint32(0, CENTRAL_HEADER_SIG, true);
  dir.setUint16(4, 20, true);
  dir.setUint16(6, 20, true);
  dir.setUint16(8, 0x0800, true);
  dir.setUint16(10, method, true);
  dir.setUint16(12, 0, true);
  dir.setUint16(14, 0x21, true);
  dir.setUint32(16, crc, true);
  dir.setUint32(20, compressedSize, true);
  dir.setUint32(24, size, true);
  dir.setUint16(28, nameBytes.length, true);
  dir.setUint16(30, 0, true);
  dir.setUint16(32, 0, true);
  dir.setUint16(34, 0, true);
  dir.setUint16(36, 0, true);
  dir.setUint32(38, 0, true);
  dir.setUint32(42, offset, true);
  return new Uint8Array(dir.buffer);
}

export class LiteZip {
  constructor() {
    // JSZip exposes its members as a plain object keyed by path, and both
    // readBackupArchive and readBackupAssets index straight into it. Same here.
    this.files = {};
    this._order = [];
  }

  // JSZip's signature is file(path, content, options). `compression` is
  // honoured: "DEFLATE" asks for the member to be deflated (where this browser
  // can), anything else stores it.
  file(path, content, options = {}) {
    const name = String(path);
    if (!(name in this.files)) this._order.push(name);
    this.files[name] = new LiteZipEntry(name, {
      pending: content,
      compression: String(options?.compression || "STORE").toUpperCase()
    });
    return this;
  }

  // JSZip's generateAsync(options, onUpdate), and then some: onUpdate gets
  // `{ percent, currentFile }` like JSZip's, plus `bytesDone`/`bytesTotal`,
  // `fileIndex`/`fileCount` and `phase` ("reading" | "checksum" | "compressing"),
  // several times a second through a big member rather than once after it.
  //
  // `options.compression: "DEFLATE"` deflates every member that did not say
  // otherwise, as JSZip's does. `options.isCancelled` is checked between chunks;
  // a cancelled run throws an Error whose message is "CANCELLED".
  //
  // Returns a Blob when asked for one and a Uint8Array otherwise. The parts are
  // kept as separate chunks — a paper's own Blob among them, never copied — and
  // handed to the Blob as a list: a Blob built from chunks can be spilled to
  // disk by the browser, where one accumulated buffer has to stay resident.
  async generateAsync(options = {}, onUpdate = null) {
    const parts = [];
    const central = [];
    let offset = 0;
    const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
    const defaultDeflate = String(options.compression || "").toUpperCase() === "DEFLATE";
    if (this._order.length > ZIP_LITE_MAX_ENTRIES) {
      throw new Error(`This archive would hold ${this._order.length} files — more than a zip without extensions can index`);
    }

    const sizeOf = (entry) => {
      if (entry._bytes !== null) return entry._bytes.length;
      const pending = entry._pending;
      if (isBlobLike(pending)) return pending.size;
      if (pending instanceof Uint8Array) return pending.length;
      if (pending instanceof ArrayBuffer) return pending.byteLength;
      if (typeof pending === "string") return pending.length;
      return 0;
    };
    const bytesTotal = this._order.reduce((sum, name) => sum + sizeOf(this.files[name]), 0) || 1;
    let bytesBefore = 0;
    const fileCount = this._order.length;
    const report = (name, index, within, phase) => {
      const bytesDone = Math.min(bytesTotal, bytesBefore + within);
      onUpdate?.({
        percent: (bytesDone / bytesTotal) * 100,
        currentFile: name,
        bytesDone,
        bytesTotal,
        fileIndex: index,
        fileCount,
        phase
      });
    };
    let lastReport = 0;
    const throttled = (name, index, within, phase) => {
      const now = Date.now();
      if (now - lastReport < 60) return;
      lastReport = now;
      report(name, index, within, phase);
    };

    for (let index = 0; index < this._order.length; index += 1) {
      if (isCancelled()) throw new Error("CANCELLED");
      const name = this._order[index];
      const entry = this.files[name];
      const nameBytes = utf8Bytes(name);
      const own = sizeOf(entry);
      report(name, index, 0, "reading");

      let crc;
      let size;
      let compressedSize;
      let method = 0;
      let payload;

      if (entry._bytes === null && isBlobLike(entry._pending) && entry._compression !== "DEFLATE" && !defaultDeflate) {
        // A paper or an image, stored: checksummed a chunk at a time straight
        // off the Blob, and the Blob itself goes into the output.
        const blob = entry._pending;
        crc = await crc32OfBlob(blob, (done) => {
          if (isCancelled()) throw new Error("CANCELLED");
          throttled(name, index, done, "checksum");
        });
        size = blob.size;
        compressedSize = blob.size;
        payload = blob;
      } else {
        const data = entry._source ? await entry._raw() : await entry._stored().then((bytes) => (entry._method === 8 ? inflateRaw(bytes) : bytes));
        crc = await crc32Chunked(data, (done) => {
          if (isCancelled()) throw new Error("CANCELLED");
          throttled(name, index, done, "checksum");
        });
        size = data.length;
        payload = data;
        compressedSize = data.length;
        const wantsDeflate = entry._compression === "DEFLATE" || (defaultDeflate && entry._compression !== "STORE");
        if (wantsDeflate && canDeflate() && data.length > 64) {
          report(name, index, 0, "compressing");
          const packed = await deflateRaw(data);
          if (packed.length < data.length) {
            payload = packed;
            compressedSize = packed.length;
            method = 8;
          }
        }
      }

      parts.push(localHeader({ crc, compressedSize, size, method, nameBytes }), nameBytes, payload);
      central.push(centralHeader({ crc, compressedSize, size, method, nameBytes, offset }), nameBytes);

      offset += 30 + nameBytes.length + compressedSize;
      if (offset > ZIP_LITE_MAX_BYTES) {
        throw new Error("This library is too large for one archive (over 4 GB) — back it up in parts by selecting decks");
      }
      // The decoded copy is dropped as soon as its bytes are in the part list,
      // so a hundred papers are held one at a time rather than all at once. The
      // part list itself holds each one exactly once, and a Blob built from
      // those parts is what the browser is free to spill to disk.
      entry._decoded = null;
      bytesBefore += own;
      report(name, index, 0, "written");
      await yieldToPage();
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
    if (options.type === "blob") return new Blob(chunks, { type: options.mimeType || "application/zip" });
    const resolved = [];
    for (const chunk of chunks) resolved.push(isBlobLike(chunk) ? new Uint8Array(await chunk.arrayBuffer()) : chunk);
    const total = resolved.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of resolved) {
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
  //
  // A File or Blob is read lazily — only the tail with the index, then each
  // member when it is asked for. Anything else is read whole, as before.
  static async loadAsync(source) {
    const lazy = isBlobLike(source) && typeof source.slice === "function" && !(source instanceof Uint8Array);
    const total = lazy ? source.size : null;
    let tail;
    let tailStart = 0;
    let bytes = null;
    if (lazy) {
      tailStart = Math.max(0, total - END_RECORD_SEARCH - 22);
      tail = new Uint8Array(await source.slice(tailStart, total).arrayBuffer());
    } else {
      bytes = await toUint8Array(source);
      tail = bytes;
    }
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let end = -1;
    const from = Math.max(0, tail.length - END_RECORD_SEARCH - 22);
    for (let i = tail.length - 22; i >= from; i -= 1) {
      if (tailView.getUint32(i, true) === END_RECORD_SIG) { end = i; break; }
    }
    if (end < 0) throw new Error("this file is not a zip archive");

    const count = tailView.getUint16(end + 10, true);
    const centralSize = tailView.getUint32(end + 12, true);
    const centralAt = tailView.getUint32(end + 16, true);

    let dir;
    let dirBase;
    if (lazy) {
      if (centralAt + centralSize > total) throw new Error("this archive's index is damaged");
      dir = new Uint8Array(await source.slice(centralAt, centralAt + centralSize).arrayBuffer());
      dirBase = centralAt;
    } else {
      dir = bytes;
      dirBase = 0;
    }
    const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const zip = new LiteZip();
    const decoder = new TextDecoder();
    let at = centralAt - dirBase;

    for (let i = 0; i < count; i += 1) {
      if (at + 46 > dir.length || view.getUint32(at, true) !== CENTRAL_HEADER_SIG) {
        throw new Error("this archive's index is damaged");
      }
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const compressedSize = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localAt = view.getUint32(at + 42, true);
      const name = decoder.decode(dir.subarray(at + 46, at + 46 + nameLength));

      let entry;
      if (lazy) {
        entry = new LiteZipEntry(name, { source, localAt, compressedSize, size, crc, method });
      } else {
        // The local header's own name and extra lengths are the ones that place
        // the data — they are allowed to differ from the central directory's, and
        // in archives written by some tools they do.
        const localView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (localAt + 30 > bytes.length || localView.getUint32(localAt, true) !== LOCAL_HEADER_SIG) {
          throw new Error("this archive's index is damaged");
        }
        const localNameLength = localView.getUint16(localAt + 26, true);
        const localExtraLength = localView.getUint16(localAt + 28, true);
        const start = localAt + 30 + localNameLength + localExtraLength;
        entry = new LiteZipEntry(name, { bytes: bytes.subarray(start, start + compressedSize), method, size, crc });
      }
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

// A minimal ZIP writer, so an export does not have to wait for JSZip to load.

export let cachedCrc32Table = null;

export function crc32Table() {
  if (cachedCrc32Table) return cachedCrc32Table;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  cachedCrc32Table = table;
  return table;
}

export function crc32(bytes) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

// Minimal ZIP writer — STORE method only (no compression). No zip library
// is available in this project, so this hand-rolls just enough of the ZIP
// spec (local file headers, central directory, end record) to produce a
// valid archive any zip/docx reader — including Word itself — can open.
export function buildZipArchive(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBytes = utf8Bytes(name);
    const checksum = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, 0, true);
    localHeader.setUint16(12, 0, true);
    localHeader.setUint32(14, checksum, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    localChunks.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, 0, true);
    centralHeader.setUint16(14, 0, true);
    centralHeader.setUint32(16, checksum, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    centralChunks.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  });

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const endRecord = new DataView(new ArrayBuffer(22));
  endRecord.setUint32(0, 0x06054b50, true);
  endRecord.setUint16(4, 0, true);
  endRecord.setUint16(6, 0, true);
  endRecord.setUint16(8, files.length, true);
  endRecord.setUint16(10, files.length, true);
  endRecord.setUint32(12, centralSize, true);
  endRecord.setUint32(16, centralStart, true);
  endRecord.setUint16(20, 0, true);

  const allChunks = [...localChunks, ...centralChunks, new Uint8Array(endRecord.buffer)];
  const totalLength = allChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  allChunks.forEach((chunk) => {
    result.set(chunk, pos);
    pos += chunk.length;
  });
  return result;
}

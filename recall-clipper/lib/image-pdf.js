// A PDF holding JPEG images, one per page — used by the "Visible area" capture,
// which is a screenshot rather than a print. The JPEG bytes are embedded as-is
// (DCTDecode), so there is no re-encoding and no library.

const enc = new TextEncoder();

/**
 * @param {{jpeg: Uint8Array, width: number, height: number}[]} images  pixel sizes
 * @param {{pageWidthPt?: number}} opts  page width in points; height follows the aspect ratio
 * @returns {Uint8Array}
 */
export function imagesToPdf(images, { pageWidthPt = 595.28 } = {}) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const begin = (n) => { offsets[n] = length; };

  push("%PDF-1.4\n%âãÏÓ\n");
  const pageCount = images.length;
  // 1: catalog, 2: pages, then per page: page, content, image
  const pageObj = (i) => 3 + i * 3;
  begin(1);
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  push(`2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${images.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>\nendobj\n`);
  images.forEach((img, i) => {
    const w = pageWidthPt;
    const h = Math.round((pageWidthPt * img.height) / img.width * 100) / 100;
    const p = pageObj(i);
    begin(p);
    push(`${p} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>\nendobj\n`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    begin(p + 1);
    push(`${p + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(p + 2);
    push(`${p + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`);
    push(img.jpeg);
    push("\nendstream\nendobj\n");
  });
  const size = 3 + pageCount * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n += 1) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
}

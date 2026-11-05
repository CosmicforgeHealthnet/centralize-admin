"use strict";

// Builds a structurally valid, multi-page PDF of an exact byte size using only
// Node. The padding lives in an incompressible, uncompressed stream object so
// the file is a real PDF (header, page tree, xref, trailer, %%EOF) and not a
// renamed text file. Used by the attachment lifecycle and proxy tests.

const crypto = require("node:crypto");

function buildPdf({ pages = 14, targetBytes = 3 * 1024 * 1024, title = "Generated test document" } = {}) {
  const objects = [];
  const pageIds = [];
  // 1 catalog, 2 pages, 3 font, 4 padding stream, then page+content pairs.
  const fontId = 3;
  const padId = 4;
  let nextId = 5;
  const bodies = new Map();
  for (let i = 0; i < pages; i += 1) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const text = `BT /F1 18 Tf 72 720 Td (${title} - page ${i + 1} of ${pages}) Tj ET`;
    bodies.set(contentId, Buffer.from(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`));
    bodies.set(pageId, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
  }
  bodies.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
  bodies.set(2, Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`));
  bodies.set(fontId, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const total = nextId; // object ids 1..total-1

  const assemble = (padBytes) => {
    const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets = new Array(total).fill(0);
    let position = parts[0].length;
    const push = (buf) => { parts.push(buf); position += buf.length; };
    for (let id = 1; id < total; id += 1) {
      offsets[id] = position;
      const body = id === padId
        ? Buffer.concat([Buffer.from(`<< /Length ${padBytes.length} /Type /Metadata /Subtype /XML >>\nstream\n`), padBytes, Buffer.from("\nendstream")])
        : bodies.get(id);
      push(Buffer.concat([Buffer.from(`${id} 0 obj\n`), body, Buffer.from("\nendobj\n")]));
    }
    const xrefAt = position;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let id = 1; id < total; id += 1) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(Buffer.from(xref));
    return Buffer.concat(parts);
  };

  const baseline = assemble(Buffer.alloc(0)).length;
  const padLength = Math.max(0, targetBytes - baseline);
  // The /Length digit count changes with the padding size; settle on an exact size.
  let pdf = assemble(crypto.randomBytes(padLength));
  for (let guard = 0; pdf.length !== targetBytes && guard < 4; guard += 1) {
    const adjust = padLength + (targetBytes - pdf.length);
    pdf = assemble(crypto.randomBytes(Math.max(0, adjust)));
    if (pdf.length === targetBytes) break;
  }
  return pdf;
}

module.exports = { buildPdf };

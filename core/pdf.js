/**
 * Minimal dependency-free PDF writer + ticket-evidence report layout.
 * Text-only (Helvetica / Helvetica-Bold), A4, auto-pagination, page footers.
 */

const PAGE_W = 595, PAGE_H = 842, MARGIN = 50, BOTTOM = 64;

// rough Helvetica width factor (per char, relative to font size)
const CHAR_W = 0.52;

function toLatin(s) {
  return String(s ?? "")
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/→/g, "->")
    .replace(/[ \t]/g, " ")
    .replace(/\r/g, "")
    .split("").map((ch) => (ch.charCodeAt(0) > 255 ? "?" : ch)).join("");
}

function escPdf(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text, size, maxWidth) {
  const maxChars = Math.max(8, Math.floor(maxWidth / (size * CHAR_W)));
  const out = [];
  for (const para of toLatin(text).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const w = word.length > maxChars ? word.slice(0, maxChars - 1) + "…" : word;
      if (!line) line = w;
      else if ((line + " " + w).length <= maxChars) line += " " + w;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * doc model: push lines with addText/addGap, then render() -> Blob.
 */
class PdfDoc {
  constructor(footerLeft, footerRight) {
    this.lines = [];
    this.footerLeft = toLatin(footerLeft || "");
    this.footerRight = toLatin(footerRight || "");
  }
  addText(text, { size = 9.5, bold = false, indent = 0, gapBefore = 0, color = null } = {}) {
    const width = PAGE_W - 2 * MARGIN - indent;
    const rows = wrap(text, size, width);
    rows.forEach((row, i) => {
      this.lines.push({ text: row, size, bold, indent, gapBefore: i === 0 ? gapBefore : 0, color });
    });
  }
  addRule(gapBefore = 6) {
    this.lines.push({ rule: true, gapBefore });
  }
  render() {
    // paginate
    const pages = [];
    let cur = [], y = PAGE_H - MARGIN - 10;
    const pushPage = () => { if (cur.length) pages.push(cur); cur = []; y = PAGE_H - MARGIN - 10; };
    for (const ln of this.lines) {
      const h = ln.rule ? 8 : ln.size * 1.38;
      y -= (ln.gapBefore || 0);
      if (y - h < BOTTOM) pushPage();
      y -= h;
      cur.push({ ...ln, y });
    }
    pushPage();

    // content streams
    const streams = pages.map((pls, pi) => {
      let s = "";
      for (const ln of pls) {
        if (ln.rule) {
          s += `0.78 0.78 0.84 RG 0.75 w ${MARGIN} ${ln.y + 3} m ${PAGE_W - MARGIN} ${ln.y + 3} l S\n`;
          continue;
        }
        const font = ln.bold ? "/F2" : "/F1";
        const col = ln.color ? `${ln.color.join(" ")} rg ` : "0.11 0.13 0.19 rg ";
        s += `BT ${col}${font} ${ln.size} Tf ${MARGIN + ln.indent} ${ln.y} Td (${escPdf(ln.text)}) Tj ET\n`;
      }
      // footer
      const f = `Page ${pi + 1} of ${pages.length}`;
      s += `BT 0.55 0.57 0.65 rg /F1 8 Tf ${MARGIN} ${BOTTOM - 22} Td (${escPdf(this.footerLeft)}) Tj ET\n`;
      s += `BT 0.55 0.57 0.65 rg /F1 8 Tf ${PAGE_W - MARGIN - f.length * 8 * CHAR_W} ${BOTTOM - 22} Td (${escPdf(f)}) Tj ET\n`;
      if (this.footerRight) {
        s += `BT 0.55 0.57 0.65 rg /F1 7 Tf ${MARGIN} ${BOTTOM - 33} Td (${escPdf(this.footerRight)}) Tj ET\n`;
      }
      return s;
    });

    // assemble objects
    const objs = [];
    const nPages = streams.length;
    const pageObjIds = streams.map((_, i) => 5 + i * 2);
    objs.push(`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`);
    objs.push(`2 0 obj << /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${nPages} >> endobj`);
    objs.push(`3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj`);
    objs.push(`4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj`);
    streams.forEach((stream, i) => {
      const pid = 5 + i * 2, cid = pid + 1;
      objs.push(`${pid} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >> endobj`);
      objs.push(`${cid} 0 obj << /Length ${stream.length} >> stream\n${stream}endstream endobj`);
    });

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const o of objs) { offsets.push(pdf.length); pdf += o + "\n"; }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: "application/pdf" });
  }
}

const fmtDate = (d) => (d ? String(d).slice(0, 10) : "—");

/** Render a psa-ticket-evidence package (see background COLLECT_TICKET_EVIDENCE) as a PDF report. */
export function buildTicketEvidencePdf(pkg) {
  const m = pkg.meta || {};
  const stats = m.stats || {};
  const doc = new PdfDoc(
    `${m.collector || "ControlMap Bridge"} — collected ${m.collected_at || ""}`,
    m.evidence_hash || ""
  );

  doc.addText("PSA Ticket Evidence Package", { size: 17, bold: true });
  doc.addText(`Source: ${m.source_system || "?"}    Client: ${m.client?.name || "?"}`, { size: 10, gapBefore: 8 });
  const q = m.query || {};
  if (q.from || q.to) doc.addText(`Evidence period: ${q.from || "…"} to ${q.to || "…"}`, { size: 10 });
  if (q.text) doc.addText(`Text filter: "${q.text}"`, { size: 10 });
  doc.addText(`Collected at: ${m.collected_at || "?"}    Collector: ${m.collector || "?"}`, { size: 10 });
  doc.addText(`Integrity: ${m.evidence_hash || "(in JSON package)"}`, { size: 8.5, color: [0.45, 0.47, 0.55] });

  doc.addRule(10);
  doc.addText("Summary", { size: 12, bold: true, gapBefore: 6 });
  doc.addText(`${stats.found ?? 0} ticket(s) collected — ${stats.closed ?? 0} closed, ${stats.open ?? 0} open.`, { size: 10, gapBefore: 3 });
  if (stats.weak) doc.addText(`${stats.weak} ticket(s) flagged weak (missing close date or description).`, { size: 10, color: [0.62, 0.4, 0.05] });
  if (m.notes_included_for_first != null) doc.addText(`Ticket notes included for the first ${m.notes_included_for_first} ticket(s).`, { size: 9, color: [0.45, 0.47, 0.55] });

  doc.addRule(10);
  doc.addText("Ticket Evidence", { size: 12, bold: true, gapBefore: 6 });

  (pkg.tickets || []).forEach((t, i) => {
    const weak = !t.closedAt || !(t.description || "").trim();
    doc.addText(`${i + 1}. ${t.number || t.id} — ${t.title || "(no title)"}${weak ? "  [WEAK]" : ""}`, { size: 10.5, bold: true, gapBefore: 12 });
    doc.addText(`Status: ${t.status || "—"}    Priority: ${t.priority || "—"}    Type: ${t.type || "—"}`, { size: 9, indent: 14, gapBefore: 2 });
    doc.addText(`Created: ${fmtDate(t.createdAt)}    Closed: ${fmtDate(t.closedAt)}${t.owner ? `    Owner: ${t.owner}` : ""}`, { size: 9, indent: 14 });
    if ((t.description || "").trim()) {
      doc.addText("Description:", { size: 9, bold: true, indent: 14, gapBefore: 3 });
      doc.addText(String(t.description).slice(0, 1500), { size: 9, indent: 22 });
    }
    const notes = (t.notes || []).filter((n) => (n.text || "").trim()).slice(0, 5);
    if (notes.length) {
      doc.addText(`Notes (${notes.length} of ${t.notes.length}):`, { size: 9, bold: true, indent: 14, gapBefore: 3 });
      for (const n of notes) {
        doc.addText(`${fmtDate(n.at)}${n.author ? ` — ${n.author}` : ""}: ${String(n.text).slice(0, 600)}`, { size: 8.5, indent: 22, gapBefore: 2 });
      }
    }
  });

  doc.addRule(12);
  doc.addText("The accompanying JSON document contains the full machine-readable package (all fields, notes, and the SHA-256 integrity hash) for audit replay.", { size: 8.5, color: [0.45, 0.47, 0.55], gapBefore: 6 });

  return doc.render();
}

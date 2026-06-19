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
  // Reserve a fixed-height block; draw(yBottom, height) returns a PDF content stream.
  addBlock(height, draw, gapBefore = 0) {
    this.lines.push({ block: true, height, draw, gapBefore });
  }
  render() {
    // paginate
    const pages = [];
    let cur = [], y = PAGE_H - MARGIN - 10;
    const pushPage = () => { if (cur.length) pages.push(cur); cur = []; y = PAGE_H - MARGIN - 10; };
    for (const ln of this.lines) {
      const h = ln.rule ? 8 : (ln.block ? ln.height : ln.size * 1.38);
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
        if (ln.block) {
          s += (ln.draw(ln.y, ln.height) || "");
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

// ───────────────────────── chart graphics helpers ─────────────────────────
const CONTENT_W = PAGE_W - 2 * MARGIN;
const X0 = MARGIN;

function gxRect(x, y, w, h, rgb) {
  const [r, g, b] = rgb;
  return `${r} ${g} ${b} rg ${x.toFixed(1)} ${y.toFixed(1)} ${Math.max(0, w).toFixed(1)} ${Math.max(0, h).toFixed(1)} re f\n`;
}
function gxText(s, x, y, size, bold, rgb, align) {
  const t = toLatin(String(s == null ? "" : s));
  const [r, g, b] = rgb || [0.11, 0.13, 0.19];
  let xx = x;
  if (align === "r") xx = x - t.length * size * CHAR_W;
  else if (align === "c") xx = x - (t.length * size * CHAR_W) / 2;
  return `BT ${r} ${g} ${b} rg ${bold ? "/F2" : "/F1"} ${size} Tf ${xx.toFixed(1)} ${y.toFixed(1)} Td (${escPdf(t)}) Tj ET\n`;
}
function money(n, cur) {
  const v = Math.round(Number(n) || 0);
  return (cur ? cur + " " : "") + v.toLocaleString("en-US");
}

const C_INK = [0.11, 0.13, 0.19];
const C_NAVY = [0.16, 0.18, 0.40];
const C_MUT = [0.45, 0.47, 0.55];
const C_CARD = [0.93, 0.95, 0.98];
const C_ONE = [0.05, 0.07, 0.45];   // one-time (dark navy)
const C_REC = [0.36, 0.51, 0.80];   // recurring (mid blue)
const C_MARG = [0.74, 0.84, 0.96];  // margin (light blue)
const C_NEG = [0.86, 0.18, 0.18];   // negative
const C_WON = [0.18, 0.55, 0.34];
const C_LOST = [0.78, 0.25, 0.25];
const C_PEND = [0.30, 0.46, 0.76];

function money0(n) {
  return (Math.round(Number(n) || 0)).toLocaleString("en-US");
}
function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Simple table. columns:[{label, x, align}] where x is left edge ('l') or right edge ('r').
// rows: array of cell-string arrays. Returns content stream; height = 30 + rows*16.
function drawTable(yb, h, columns, rows, rowColors) {
  const top = yb + h;
  let s = "";
  const hy = top - 12;
  columns.forEach((c) => { s += gxText(c.label, c.x, hy, 8, true, C_MUT, c.align); });
  s += `0.82 0.84 0.90 RG 0.6 w ${X0} ${(hy - 5).toFixed(1)} m ${X0 + CONTENT_W} ${(hy - 5).toFixed(1)} l S\n`;
  rows.forEach((r, i) => {
    const ry = top - 30 - i * 16;
    columns.forEach((c, ci) => {
      const col = ci === 0 ? C_INK : C_MUT;
      s += gxText(r[ci], c.x, ry, 9, ci === 0, col, c.align);
    });
  });
  return s;
}

// Horizontal (optionally stacked) bar rows. rows:[{label, segs:[n..], valueText}]
function drawBars(yb, h, rows, max, segColors, labelW) {
  const top = yb + h;
  const lw = labelW || 120;
  const bx = X0 + lw;
  const bw = CONTENT_W - lw - 70;
  let s = "";
  rows.forEach((r, i) => {
    const rowTop = top - 6 - i * 24;
    const barY = rowTop - 13;
    s += gxText((r.label || "").slice(0, 26), X0, rowTop - 11, 9, false, C_INK);
    let cx = bx;
    (r.segs || []).forEach((v, si) => {
      const w = max > 0 ? (Math.abs(v) / max) * bw : 0;
      if (w > 0.3) s += gxRect(cx, barY, w, 13, segColors[si] || C_REC);
      cx += w;
    });
    if (r.valueText) s += gxText(r.valueText, X0 + CONTENT_W, rowTop - 11, 8.5, false, C_MUT, "r");
  });
  return s;
}

/**
 * Executive Quote Report. `report` is computed by the content script:
 * { meta:{tenant,generatedAt,currency,from,to,scope},
 *   kpis:{totalQuotes,won,lost,pending,winRatePct,wonOneTime,wonRecurringAnnual,pipelineValue},
 *   funnel:[{label,count}], byUser:[{owner,oneTime,recurringAnnual,margin}],
 *   productsQuoted:[{name,qty,ext}], productsAccepted:[{name,qty,ext,margin}],
 *   productsNote }
 */
export function buildExecReportPdf(report) {
  const m = report.meta || {};
  const cur = m.currency || "USD";
  const k = report.kpis || {};
  const doc = new PdfDoc(
    `ScalePad Atlas — Executive Quote Report · generated ${m.generatedAt || ""}`,
    m.tenant ? ("Quoter tenant: " + m.tenant) : ""
  );

  doc.addText("Executive Quote Report", { size: 20, bold: true, color: C_NAVY });
  doc.addText(`${m.from || "…"} to ${m.to || "…"}   ·   ${cur}   ·   ${m.scope || "All quotes (primary)"}`, { size: 10, gapBefore: 6, color: C_MUT });

  // ── KPI cards ──
  const cards = [
    { label: "Total quotes", value: String(k.totalQuotes ?? 0), color: C_NAVY },
    { label: "Win rate", value: (k.winRatePct != null ? k.winRatePct + "%" : "—"), sub: `${k.won ?? 0} won · ${k.lost ?? 0} lost · ${k.pending ?? 0} open`, color: C_WON },
    { label: "Won — one-time", value: money(k.wonOneTime, cur), color: C_ONE },
    { label: "Won — recurring/yr", value: money(k.wonRecurringAnnual, cur), color: C_REC },
  ];
  doc.addBlock(76, (yb, h) => {
    const n = cards.length, gap = 10, cw = (CONTENT_W - gap * (n - 1)) / n;
    let s = "";
    cards.forEach((c, i) => {
      const x = X0 + i * (cw + gap);
      s += gxRect(x, yb, cw, h, C_CARD);
      s += gxRect(x, yb, 3, h, c.color);
      s += gxText(c.value, x + 12, yb + h - 30, 16, true, c.color);
      if (c.sub) s += gxText(c.sub, x + 12, yb + 22, 7.5, false, C_MUT);
      s += gxText(c.label.toUpperCase(), x + 12, yb + 9, 7.5, true, C_MUT);
    });
    return s;
  }, 14);

  // ── Funnel ──
  doc.addText("Pipeline funnel", { size: 12, bold: true, gapBefore: 16, color: C_NAVY });
  const funnel = report.funnel || [];
  const fmax = Math.max(1, ...funnel.map((f) => f.count));
  doc.addBlock(funnel.length * 24 + 8, (yb, h) =>
    drawBars(yb, h, funnel.map((f) => ({ label: f.label, segs: [f.count], valueText: String(f.count) })), fmax, [C_NAVY], 130), 6);

  // ── Won revenue split ──
  doc.addText("Won revenue — one-time vs recurring (annualized)", { size: 12, bold: true, gapBefore: 14, color: C_NAVY });
  const rmax = Math.max(1, k.wonOneTime || 0, k.wonRecurringAnnual || 0);
  doc.addBlock(2 * 24 + 8, (yb, h) => drawBars(yb, h, [
    { label: "One-time", segs: [k.wonOneTime || 0], valueText: money(k.wonOneTime, cur) },
    { label: "Recurring / yr", segs: [k.wonRecurringAnnual || 0], valueText: money(k.wonRecurringAnnual, cur) },
  ], rmax, [C_ONE, C_REC], 130), 6);

  // ── By salesperson ──
  const users = report.byUser || [];
  if (users.length) {
    doc.addText("Won by salesperson (one-time · recurring/yr · margin)", { size: 12, bold: true, gapBefore: 16, color: C_NAVY });
    const umax = Math.max(1, ...users.map((u) => (u.oneTime || 0) + (u.recurringAnnual || 0) + (u.margin || 0)));
    doc.addBlock(users.length * 24 + 8, (yb, h) =>
      drawBars(yb, h, users.map((u) => ({
        label: u.owner,
        segs: [u.oneTime || 0, u.recurringAnnual || 0, u.margin || 0],
        valueText: money((u.oneTime || 0) + (u.recurringAnnual || 0), cur),
      })), umax, [C_ONE, C_REC, C_MARG], 130), 6);
    doc.addText("Legend:  one-time = dark,  recurring/yr = mid,  margin = light blue", { size: 8, gapBefore: 6, color: C_MUT });
  }

  // Shared product-table columns + row builder (Product · Qty · Revenue · Margin · Margin %)
  const pct = (p) => (p.margin != null && p.ext > 0) ? (Math.round((p.margin / p.ext) * 100) + "%") : "—";
  const prodCols = [
    { label: "Product", x: X0, align: "l" },
    { label: "Qty", x: X0 + 305, align: "r" },
    { label: "Revenue (" + cur + ")", x: X0 + 380, align: "r" },
    { label: "Margin (" + cur + ")", x: X0 + 450, align: "r" },
    { label: "Margin %", x: X0 + CONTENT_W, align: "r" },
  ];
  const prodRow = (p) => [truncate(p.name, 50), String(p.qty || 0), money0(p.ext), (p.margin != null ? money0(p.margin) : "—"), pct(p)];

  // ── Products quoted ──
  const pq = report.productsQuoted || [];
  doc.addText("Top products quoted", { size: 12, bold: true, gapBefore: 16, color: C_NAVY });
  if (report.productsNote) doc.addText(report.productsNote, { size: 8.5, gapBefore: 2, color: C_MUT });
  if (pq.length) {
    doc.addBlock(30 + pq.length * 16, (yb, h) => drawTable(yb, h, prodCols, pq.map(prodRow)), 6);
  } else {
    doc.addText("No quoted line items found in range.", { size: 9, gapBefore: 4, color: C_MUT });
  }

  // ── Products on accepted orders ──
  const pa = report.productsAccepted || [];
  doc.addText("Top products on won/accepted quotes", { size: 12, bold: true, gapBefore: 16, color: C_NAVY });
  if (pa.length) {
    doc.addBlock(30 + pa.length * 16, (yb, h) => drawTable(yb, h, prodCols, pa.map(prodRow)), 6);
  } else {
    doc.addText("No accepted line items found in range.", { size: 9, gapBefore: 4, color: C_MUT });
  }

  doc.addRule(14);
  doc.addText("Figures are derived from Quoter primary quotes in the selected period. Product detail is read from each quote's detail view; recurring values are annualized.", { size: 8, color: C_MUT, gapBefore: 6 });

  return doc.render();
}

/** Render a psa-ticket-evidence package (see background COLLECT_TICKET_EVIDENCE) as a PDF report. */
export function buildTicketEvidencePdf(pkg) {
  const m = pkg.meta || {};
  const stats = m.stats || {};
  const doc = new PdfDoc(
    `${m.collector || "ScalePad Atlas"} — collected ${m.collected_at || ""}`,
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

/**
 * Render a single integration check result as a formatted PDF report.
 * pkg: {
 *   integrationName, integrationVersion, check {id,title,description,frameworks[]},
 *   status, summary, details[], ranAt, client {name}, questionCode, evidenceHash,
 *   snapshotPreview (optional object)
 * }
 */
export function buildCheckEvidencePdf(pkg) {
  const statusColors = {
    pass: [0.02, 0.42, 0.31], fail: [0.61, 0.11, 0.11],
    warning: [0.57, 0.38, 0.04], "not-licensed": [0.45, 0.47, 0.55], error: [0.45, 0.47, 0.55],
  };
  const doc = new PdfDoc(
    `${pkg.collector || "ScalePad Atlas"} — generated ${pkg.ranAt || ""}`,
    pkg.evidenceHash || ""
  );

  doc.addText("Compliance Check Evidence", { size: 17, bold: true });
  doc.addText(`${pkg.integrationName || "Integration"}  ·  ${pkg.check?.id || ""}`, { size: 11, bold: true, gapBefore: 6, color: [0.49, 0.36, 1] });
  doc.addText(pkg.check?.title || "", { size: 13, bold: true, gapBefore: 4 });
  if (pkg.check?.description) doc.addText(pkg.check.description, { size: 9.5, gapBefore: 2, color: [0.33, 0.36, 0.44] });

  doc.addRule(10);
  doc.addText(`Result: ${String(pkg.status || "").toUpperCase()}`, { size: 13, bold: true, gapBefore: 6, color: statusColors[pkg.status] || [0.11, 0.13, 0.19] });
  if (pkg.summary) doc.addText(pkg.summary, { size: 10.5, gapBefore: 4 });

  if (Array.isArray(pkg.details) && pkg.details.length) {
    doc.addText("Findings", { size: 11, bold: true, gapBefore: 10 });
    for (const d of pkg.details.slice(0, 40)) doc.addText("- " + String(d), { size: 9.5, indent: 10, gapBefore: 2 });
  }

  doc.addRule(10);
  doc.addText("Evidence metadata", { size: 11, bold: true, gapBefore: 6 });
  doc.addText(`Client: ${pkg.client?.name || "—"}`, { size: 9.5, gapBefore: 3 });
  doc.addText(`Source: ${pkg.integrationName || "—"} v${pkg.integrationVersion || "—"}`, { size: 9.5 });
  if (pkg.questionCode) doc.addText(`Mapped to assessment question: ${pkg.questionCode}`, { size: 9.5 });
  doc.addText(`Generated at: ${pkg.ranAt || "—"}`, { size: 9.5 });
  if (pkg.check?.frameworks?.length) doc.addText(`Frameworks: ${pkg.check.frameworks.join(", ")}`, { size: 9.5 });
  doc.addText(`Integrity: ${pkg.evidenceHash || "(in JSON document)"}`, { size: 8.5, color: [0.45, 0.47, 0.55] });

  if (pkg.snapshotPreview && typeof pkg.snapshotPreview === "object") {
    doc.addRule(10);
    doc.addText("Data snapshot (preview)", { size: 11, bold: true, gapBefore: 6 });
    let json = "";
    try { json = JSON.stringify(pkg.snapshotPreview, null, 2); } catch { json = String(pkg.snapshotPreview); }
    for (const line of json.split("\n").slice(0, 80)) doc.addText(line || " ", { size: 7.5, indent: 6, color: [0.33, 0.36, 0.44] });
  }

  doc.addRule(12);
  doc.addText("The accompanying JSON document contains the full machine-readable check result and data snapshot for audit replay.", { size: 8.5, color: [0.45, 0.47, 0.55], gapBefore: 6 });

  return doc.render();
}

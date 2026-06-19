/**
 * background/evidenceHelpers.js
 *
 * Pure utility functions used by the evidence collection flow.
 * Plus attachCheckEvidence(), the shared check→ControlMap evidence writer
 * used by both APPLY_RESULT (single check) and ATTACH_PREMAP (bulk).
 */

import * as sp from "../core/scalepad.js";
import { buildCheckEvidencePdf } from "../core/pdf.js";

/**
 * SHA-256 hex digest of a string using the Web Crypto API.
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Summarise a ticket list into { found, closed, open, weak } counts.
 * "Weak" means the ticket is missing a close date or a non-empty description.
 *
 * @param {object[]} tickets
 * @returns {{ found: number, closed: number, open: number, weak: number }}
 */
export function ticketStats(tickets) {
  const closed = tickets.filter((t) => t.closedAt).length;
  const weak   = tickets.filter((t) => !t.closedAt || !(t.description || "").trim()).length;
  return { found: tickets.length, closed, open: tickets.length - closed, weak };
}


/**
 * Build the JSON snapshot + PDF report for a check result and write it to
 * ControlMap, either as a new evidence or a new request on an existing one.
 *
 * @param settings   resolved settings object
 * @param client     { id, name }
 * @param integration  the integration definition (name, version, id)
 * @param check      the check definition (id, title, description, frameworks)
 * @param run        stored run: { result, ranAt }
 * @param opts       { target: {mode,title?,evidenceId?}, questionCode? }
 * @returns          { mode, evidenceId, evidenceRequestId? }
 */
export async function attachCheckEvidence(settings, client, integration, check, run, { target, questionCode = null } = {}) {
  const r = run.result;
  const date = new Date().toISOString().slice(0, 10);
  const detailLines = (r.details || []).join("\n");
  const description = `${r.summary}\n${detailLines}\n\nCheck: ${check.id} (${integration.name} v${integration.version})\nStatus: ${r.status}\nRan at: ${run.ranAt}\nFrameworks: ${(check.frameworks || []).join(", ")}`;
  const snapshot = {
    check: check.id, integration: integration.id,
    status: r.status, summary: r.summary,
    ranAt: run.ranAt, data: r.evidence?.snapshot ?? null,
  };
  const fileName = `${check.id}-${date}.json`;
  const hash = await sha256Hex(JSON.stringify(snapshot));
  snapshot.evidence_hash = `sha256:${hash}`;

  let extraFiles = [];
  try {
    const pdfBlob = buildCheckEvidencePdf({
      integrationName: integration.name,
      integrationVersion: integration.version,
      collector: `ScalePad Atlas ${chrome.runtime.getManifest().version}`,
      check: { id: check.id, title: check.title, description: check.description, frameworks: check.frameworks || [] },
      status: r.status, summary: r.summary, details: r.details || [],
      ranAt: run.ranAt, client: { name: client.name },
      questionCode: questionCode || null,
      evidenceHash: `sha256:${hash}`,
      snapshotPreview: r.evidence?.snapshot ?? null,
    });
    extraFiles = [{ blob: pdfBlob, name: `${check.id}-${date}.pdf` }];
  } catch { /* PDF best-effort; JSON remains system of record */ }

  if (target?.mode === "existing" && target?.evidenceId) {
    const rr = await sp.addEvidenceRequestWithDocument(settings, client.id, target.evidenceId, {
      snapshot, fileName, note: description, extraFiles,
    });
    return { mode: "existing", evidenceId: target.evidenceId, evidenceRequestId: rr.evidenceRequestId };
  }
  const created = await sp.createEvidenceWithSnapshot(settings, client.id, {
    title:       target?.title || `[${integration.name}] ${check.title} — ${date}`,
    description,
    extraFiles,
    questionCodes: questionCode ? [questionCode] : [],
    snapshot,
    fileName,
  });
  return { mode: "new", ...created };
}

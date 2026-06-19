/** ScalePad / ControlMap API client. */

import { saveSettings } from "./store.js";

const SCALEPAD_BASES = {
  us: "https://api.scalepad.com",
  eu: "https://eu.api.scalepad.com",
  ca: "https://ca.api.scalepad.com",
  au: "https://au.api.scalepad.com",
};

export function spBase(settings) {
  return SCALEPAD_BASES[settings.scalepadRegion] || SCALEPAD_BASES.us;
}

export async function spFetch(settings, path, options = {}) {
  if (!settings.scalepadApiKey) throw new Error("ScalePad API key not configured. Open extension options.");
  const headers = { "x-api-key": settings.scalepadApiKey, ...(options.headers || {}) };
  if (!options.multipart) headers["Content-Type"] = "application/json";
  const res = await fetch(spBase(settings) + path, { ...options, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const e0 = body?.errors?.[0] || {};
    const raw = typeof body?.raw === "string" ? body.raw.slice(0, 200) : "";
    const detail = [e0.code, e0.title, e0.detail].filter(Boolean).join(" — ") || raw || res.statusText || "(no error detail)";
    throw new Error(`ScalePad API ${res.status}: ${detail}`);
  }
  return body;
}

export async function listClients(settings) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await spFetch(settings, `/core/v1/clients${qs}`, { method: "GET" });
    const data = page.data || page.clients || (Array.isArray(page) ? page : []);
    out.push(...data);
    cursor = page.next_cursor || page.nextCursor || null;
    if (!cursor || data.length === 0) break;
  }
  return out;
}

/**
 * List clients that actually exist in ControlMap, via the compliance health
 * endpoint. Unlike /core/v1/clients (all ScalePad org clients), these carry
 * valid ControlMap client ids + tenant_id. Returns [{ id, name, tenant_id }].
 */
export async function listControlMapClients(settings) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 25; i++) {
    const qs = `?page_size=200&sort=${encodeURIComponent("+client.name")}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const page = await spFetch(settings, `/controlmap/v1/clients/health${qs}`, { method: "GET" });
    const rows = page.data || [];
    for (const row of rows) {
      const c = row.client || row;
      if (c?.id) out.push({ id: c.id, name: c.name || c.id, tenant_id: c.tenant_id || null });
    }
    cursor = page.next_cursor || (rows.length ? rows[rows.length - 1]?.next_cursor : null) || null;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}

export async function resolveTenant(settings, subdomain) {
  const manual = (settings.tenantMap || {})[subdomain];
  if (manual?.id) return manual;
  const cached = settings.tenantCache[subdomain];
  if (cached) return cached;

  const clients = await listClients(settings);
  const tenantCache = { ...settings.tenantCache };
  let match = null;
  for (const c of clients) {
    const id = c.id || c.client_id;
    if (!id) continue;
    try {
      const r = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(id)}/action-items/search`, {
        method: "POST", body: JSON.stringify({ page_size: 1 }),
      });
      const tenant = r?.client?.tenant_id;
      if (tenant) {
        const entry = { id: r.client.id || id, name: r.client.name || c.name || "" };
        tenantCache[tenant] = entry;
        if (tenant === subdomain) match = entry;
      }
    } catch { /* skip */ }
    if (match) break;
  }
  await saveSettings({ tenantCache });
  if (!match) throw new Error(`Could not auto-match ControlMap tenant "${subdomain}". Open the extension options and add a Tenant mapping for "${subdomain}".`);
  return match;
}

export async function getActionItemByCode(settings, clientId, code) {
  const r = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/action-items/search`, {
    method: "POST", body: JSON.stringify({ filter: { code }, page_size: 5 }),
  });
  const items = r?.action_items?.data || r?.data || [];
  const item = items.find((i) => i.code === code) || items[0];
  if (!item) throw new Error(`Action item ${code} not found via API.`);
  return { item, client: r.client };
}

export async function getQuestion(settings, clientId, questionCode) {
  return spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/assessments/common/questions/${encodeURIComponent(questionCode)}`, { method: "GET" });
}

/**
 * Create evidence (optionally mapped to assessment questions), then upload a
 * JSON snapshot document. Returns {evidenceId, evidenceRequestId, documentId}.
 */
export async function createEvidenceWithSnapshot(settings, clientId, { title, description, questionCodes = [], snapshot, fileName, extraFiles = [] }) {
  const payload = {
    title: String(title).slice(0, 250),
    description: String(description || "").slice(0, 4000),
    repeat_type: "once",
  };
  if (questionCodes.length) payload.mappings = { assessment_question_codes: questionCodes };
  const created = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidences`, {
    method: "POST", body: JSON.stringify(payload),
  });
  const evidenceId = created?.id;
  const out = { evidenceId, evidenceRequestId: created?.evidence_request_id ?? null, documentId: null };
  if (!evidenceId) return out;

  const files = [];
  if (snapshot) files.push({ blob: new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }), name: fileName || `evidence-${Date.now()}.json` });
  for (const f of extraFiles) if (f?.blob) files.push(f);

  if (out.evidenceRequestId) {
    // attach everything to the request auto-created with the evidence
    for (const f of files) {
      const up = await uploadRequestDocument(settings, clientId, out.evidenceRequestId, f.blob, f.name);
      out.documentId = out.documentId ?? (up?.documents?.[0]?.document_id ?? null);
    }
  } else if (files.length) {
    // fallback: this endpoint creates a request and attaches the first file
    const fd = new FormData();
    fd.append("file", files[0].blob, files[0].name);
    const up = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidences/${evidenceId}/documents`, {
      method: "POST", body: fd, multipart: true,
    });
    out.evidenceRequestId = up?.evidence_request_id ?? null;
    out.documentId = up?.documents?.[0]?.document_id ?? null;
    if (out.evidenceRequestId) {
      for (const f of files.slice(1)) await uploadRequestDocument(settings, clientId, out.evidenceRequestId, f.blob, f.name);
    }
  }
  return out;
}

/** Upload a document (≤10 MB) directly to an existing evidence request. */
export async function uploadRequestDocument(settings, clientId, evidenceRequestId, blob, fileName) {
  const fd = new FormData();
  fd.append("file", blob, fileName || `document-${Date.now()}`);
  return spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidence-requests/${evidenceRequestId}/documents`, {
    method: "POST", body: fd, multipart: true,
  });
}

export async function saveAnswer(settings, clientId, questionCode, answer) {
  return spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/assessments/common/questions/${encodeURIComponent(questionCode)}/answer`, {
    method: "PUT", body: JSON.stringify({ answer }),
  });
}

/** List client evidences (summary only) for the "add to existing" picker. */
export async function listEvidences(settings, clientId) {
  // NOTE: fetch_items must be true — false returns the summary only (no list).
  const out = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const body = { page_size: 200, fetch_items: true, evidence_request: false, sort: "-updated_at" };
    if (cursor) body.cursor = cursor;
    const r = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidences/search`, {
      method: "POST", body: JSON.stringify(body),
    });
    const data = r?.evidences?.data || [];
    for (const e of data) out.push({ id: e.id, code: e.code, title: e.title });
    cursor = r?.evidences?.next_cursor || null;
    if (!cursor || data.length === 0) break;
  }
  return out;
}

/**
 * Add a NEW evidence request to an EXISTING evidence and attach a JSON package
 * as its document. Optionally PATCHes the created request with notes.
 */
export async function addEvidenceRequestWithDocument(settings, clientId, evidenceId, { snapshot, fileName, note, extraFiles = [] }) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const fd = new FormData();
  fd.append("file", blob, fileName || `evidence-${Date.now()}.json`);
  const up = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidences/${evidenceId}/documents`, {
    method: "POST", body: fd, multipart: true,
  });
  const evidenceRequestId = up?.evidence_request_id ?? null;
  if (evidenceRequestId) {
    for (const f of extraFiles) if (f?.blob) await uploadRequestDocument(settings, clientId, evidenceRequestId, f.blob, f.name);
  }
  if (evidenceRequestId && note) {
    try {
      await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidence-requests/${evidenceRequestId}`, {
        method: "PATCH", body: JSON.stringify({ implementation_notes: String(note).slice(0, 3000) }),
      });
    } catch { /* notes are best-effort */ }
  }
  return { evidenceRequestId, documents: up?.documents || [] };
}

// ───────────────────────── Quoter API (US-only) ─────────────────────────
// Quoter lives at https://api.scalepad.com/quoter regardless of ScalePad region.
const QUOTER_BASE = "https://api.scalepad.com/quoter";

export async function quoterFetch(settings, path, options = {}) {
  const key = settings.scalepadApiKey;
  if (!key) throw new Error("ScalePad API key not configured. Open extension options.");
  const headers = { "x-api-key": key, ...(options.headers || {}) };
  if (!options.multipart) headers["Content-Type"] = "application/json";
  const res = await fetch(QUOTER_BASE + path, { ...options, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const e0 = body?.errors?.[0] || {};
    const raw = typeof body?.raw === "string" ? body.raw.slice(0, 200) : "";
    const detail = [e0.code, e0.title, e0.detail].filter(Boolean).join(" — ") || raw || res.statusText || "(no error detail)";
    throw new Error(`Quoter API ${res.status}: ${detail}`);
  }
  return body;
}

/**
 * List "won" quotes (primary revision only), newest first. The public API
 * exposes the quote header + totals but NOT line items — those are fetched
 * client-side from /admin/quotes/view_by_public_id/{id}. Returns a slim shape.
 */
export async function listWonQuotes(settings, opts = {}) {
  const stages = "won-accepted,won-fulfilled,won-ordered";
  const out = [];
  let cursor = null;
  for (let i = 0; i < 40; i++) {
    let qs = `?filter[stage]=in:${stages}&filter[primary]=eq:true&sort=-won_at&page_size=100`;
    if (opts.wonAfter)  qs += `&filter[won_at]=gt:${encodeURIComponent(opts.wonAfter)}`;
    if (opts.wonBefore) qs += `&filter[won_at]=lt:${encodeURIComponent(opts.wonBefore)}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    const page = await quoterFetch(settings, `/v1/quotes${qs}`, { method: "GET" });
    const data = page.data || [];
    for (const q of data) {
      out.push({
        id: q.id,
        number: q.number,
        customNumber: q.custom_number || null,
        name: q.name || "",
        client: q.client?.name || q.billing_organization || "",
        clientId: q.client?.id || null,
        currency: q.currency_iso || "USD",
        stage: q.stage || "",
        wonAt: q.won_at || null,
        total: q.upfront_total_decimal || q.one_time_total_decimal || q.monthly_total_decimal || null,
        shipping: q.shipping_address || null,
        shippingName: [q.shipping_first_name, q.shipping_last_name].filter(Boolean).join(" ") || null,
        shippingOrg: q.shipping_organization || null,
      });
    }
    cursor = page.next_cursor || null;
    if (!cursor || data.length === 0) break;
  }
  return out;
}

const _num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/**
 * List ALL primary quotes created within a timeframe, across every stage, for
 * the Executive Report. Returns a slim per-quote shape with totals + margins.
 */
export async function listQuotesInRange(settings, opts = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 60; i++) {
    let qs = `?filter[primary]=eq:true&sort=-record_created_at&page_size=100`;
    if (opts.after)  qs += `&filter[record_created_at]=gt:${encodeURIComponent(opts.after)}`;
    if (opts.before) qs += `&filter[record_created_at]=lt:${encodeURIComponent(opts.before)}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    const page = await quoterFetch(settings, `/v1/quotes${qs}`, { method: "GET" });
    const data = page.data || [];
    for (const q of data) {
      const monthly = _num(q.monthly_total_decimal);
      const annual = _num(q.annual_total_decimal) || monthly * 12;
      const monthlyMargin = _num(q.monthly_margin_decimal);
      const annualMargin = _num(q.annual_margin_decimal) || monthlyMargin * 12;
      out.push({
        id: q.id,
        number: q.number,
        customNumber: q.custom_number || null,
        name: q.name || "",
        client: q.client?.name || q.billing_organization || "",
        owner: [q.owner_first_name, q.owner_last_name].filter(Boolean).join(" ") || (q.owner_id || "—"),
        stage: q.stage || "",
        createdAt: q.record_created_at || null,
        wonAt: q.won_at || null,
        currency: q.currency_iso || "USD",
        oneTime: _num(q.one_time_total_decimal) + _num(q.upfront_total_decimal),
        oneTimeMargin: _num(q.one_time_margin_decimal) + _num(q.upfront_margin_decimal),
        recurringAnnual: annual,
        recurringAnnualMargin: annualMargin,
      });
    }
    cursor = page.next_cursor || null;
    if (!cursor || data.length === 0) break;
  }
  return out;
}

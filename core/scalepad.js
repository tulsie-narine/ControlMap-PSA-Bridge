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
export async function createEvidenceWithSnapshot(settings, clientId, { title, description, questionCodes = [], snapshot, fileName }) {
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
  const out = { evidenceId, evidenceRequestId: created?.evidence_request_id, documentId: null };
  if (evidenceId && snapshot) {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const fd = new FormData();
    fd.append("file", blob, fileName || `evidence-${Date.now()}.json`);
    const up = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/evidences/${evidenceId}/documents`, {
      method: "POST", body: fd, multipart: true,
    });
    out.documentId = up?.documents?.[0]?.document_id ?? null;
  }
  return out;
}

export async function saveAnswer(settings, clientId, questionCode, answer) {
  return spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/assessments/common/questions/${encodeURIComponent(questionCode)}/answer`, {
    method: "PUT", body: JSON.stringify({ answer }),
  });
}

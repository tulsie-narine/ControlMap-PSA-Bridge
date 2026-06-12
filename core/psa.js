/** PSA adapters: Autotask, ConnectWise Manage, HaloPSA. */

import { saveSettings } from "./store.js";

// ---------- Autotask ----------

const AT_ZONE_DETECT = "https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation";

async function atZoneUrl(settings) {
  const at = settings.autotask;
  if (!at.integrationCode || !at.userName || !at.secret) throw new Error("Autotask credentials not configured.");
  if (at.zoneUrl) return at.zoneUrl;
  const res = await fetch(`${AT_ZONE_DETECT}?user=${encodeURIComponent(at.userName)}`);
  if (!res.ok) throw new Error(`Autotask zone detection failed (${res.status}). Check the API username.`);
  const body = await res.json();
  let url = body.url;
  if (!url) throw new Error("Autotask zone detection returned no URL.");
  if (!url.endsWith("/")) url += "/";
  const zoneUrl = url + "V1.0/";
  await saveSettings({ autotask: { ...at, zoneUrl } });
  return zoneUrl;
}

async function atFetch(settings, path, options = {}) {
  const zone = await atZoneUrl(settings);
  const at = settings.autotask;
  const res = await fetch(zone + path, {
    ...options,
    headers: {
      "ApiIntegrationcode": at.integrationCode,
      "UserName": at.userName,
      "Secret": at.secret,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.errors?.join("; ") || body?.Message || res.statusText;
    throw new Error(`Autotask API ${res.status}: ${detail}`);
  }
  return body;
}

const autotaskAdapter = {
  name: "Autotask",
  async test(settings) {
    const f = await this.getFields(settings, {});
    return `Connected — ${f.find((x) => x.key === "status")?.options.length ?? 0} status value(s).`;
  },
  async getFields(settings) {
    const body = await atFetch(settings, "Tickets/entityInformation/fields", { method: "GET" });
    const fields = body.fields || [];
    const pick = (name) => {
      const f = fields.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
      return (f?.picklistValues || [])
        .filter((v) => v.isActive !== false)
        .map((v) => ({ value: String(v.value), label: v.label, isDefault: !!v.isDefaultValue }));
    };
    return [
      { key: "status", label: "Status", required: true, options: pick("status") },
      { key: "priority", label: "Priority", required: true, options: pick("priority") },
      { key: "queueID", label: "Queue", options: pick("queueID") },
      { key: "ticketType", label: "Ticket type", options: pick("ticketType") },
      { key: "ticketCategory", label: "Ticket category", options: pick("ticketCategory") },
      { key: "source", label: "Source", options: pick("source") },
    ];
  },
  async searchCompanies(settings, query) {
    const body = await atFetch(settings, "Companies/query", {
      method: "POST",
      body: JSON.stringify({
        MaxRecords: 25,
        IncludeFields: ["id", "companyName"],
        Filter: [{ op: "and", items: [
          { op: "contains", field: "companyName", value: query },
          { op: "eq", field: "isActive", value: true },
        ]}],
      }),
    });
    return (body.items || []).map((c) => ({ companyID: c.id, companyName: c.companyName }));
  },
  async createTicket(settings, payload) {
    const f = payload.fields || {};
    const body = {
      companyID: Number(payload.companyID),
      title: String(payload.title || "").slice(0, 255),
      description: String(payload.description || "").slice(0, 8000),
      status: Number(f.status),
      priority: Number(f.priority),
    };
    if (f.queueID) body.queueID = Number(f.queueID);
    if (f.ticketType) body.ticketType = Number(f.ticketType);
    if (f.ticketCategory) body.ticketCategory = Number(f.ticketCategory);
    if (f.source) body.source = Number(f.source);
    if (payload.dueDate) body.dueDateTime = payload.dueDate;
    const res = await atFetch(settings, "Tickets", { method: "POST", body: JSON.stringify(body) });
    const itemId = res.itemId || res.itemID || res.id;
    let ticketNumber = null;
    if (itemId) {
      try {
        const t = await atFetch(settings, `Tickets/${itemId}`, { method: "GET" });
        ticketNumber = t?.item?.ticketNumber || null;
      } catch { /* non-fatal */ }
    }
    return { itemId, ticketNumber };
  },
};

// ---------- ConnectWise Manage ----------

function cwBase(settings) {
  const cw = settings.connectwise;
  if (!cw.siteUrl || !cw.companyId || !cw.publicKey || !cw.privateKey || !cw.clientId) {
    throw new Error("ConnectWise credentials not configured (site, company ID, public/private key, clientId).");
  }
  let site = cw.siteUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(site)) site = "https://" + site;
  return `${site}/v4_6_release/apis/3.0`;
}

async function cwFetch(settings, path, options = {}) {
  const cw = settings.connectwise;
  const auth = btoa(`${cw.companyId}+${cw.publicKey}:${cw.privateKey}`);
  const res = await fetch(cwBase(settings) + path, {
    ...options,
    headers: {
      "Authorization": `Basic ${auth}`,
      "clientId": cw.clientId,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.message || body?.errors?.map((e) => e.message).join("; ") || (typeof body?.raw === "string" ? body.raw.slice(0, 200) : "") || res.statusText;
    throw new Error(`ConnectWise API ${res.status}: ${detail}`);
  }
  return body;
}

const connectwiseAdapter = {
  name: "ConnectWise Manage",
  async test(settings) {
    const boards = await cwFetch(settings, "/service/boards?pageSize=100&fields=id,name", { method: "GET" });
    return `Connected — ${boards.length} service board(s).`;
  },
  async getFields(settings, context = {}) {
    const boards = await cwFetch(settings, "/service/boards?pageSize=100&fields=id,name&orderBy=name", { method: "GET" });
    const boardOptions = boards.map((b) => ({ value: String(b.id), label: b.name }));
    const boardId = context.board || settings.psaDefaults?.connectwise?.board || boardOptions[0]?.value;
    let statuses = [], types = [];
    if (boardId) {
      try { statuses = await cwFetch(settings, `/service/boards/${boardId}/statuses?pageSize=100&fields=id,name&orderBy=sortOrder`, { method: "GET" }); } catch { /* ignore */ }
      try { types = await cwFetch(settings, `/service/boards/${boardId}/types?pageSize=100&fields=id,name&orderBy=name`, { method: "GET" }); } catch { /* ignore */ }
    }
    const priorities = await cwFetch(settings, "/service/priorities?pageSize=100&fields=id,name&orderBy=sortOrder", { method: "GET" });
    return [
      { key: "board", label: "Service board", required: true, reloads: true, options: boardOptions },
      { key: "status", label: "Status", required: true, dependsOn: "board", options: statuses.map((s) => ({ value: String(s.id), label: s.name })) },
      { key: "priority", label: "Priority", required: true, options: priorities.map((p) => ({ value: String(p.id), label: p.name })) },
      { key: "type", label: "Type", dependsOn: "board", options: types.map((t) => ({ value: String(t.id), label: t.name })) },
    ];
  },
  async searchCompanies(settings, query) {
    const safe = query.replace(/["\\]/g, "");
    const conditions = encodeURIComponent(`name like "%${safe}%" and deletedFlag=false`);
    const body = await cwFetch(settings, `/company/companies?pageSize=25&fields=id,name&conditions=${conditions}`, { method: "GET" });
    return (Array.isArray(body) ? body : []).map((c) => ({ companyID: c.id, companyName: c.name }));
  },
  async createTicket(settings, payload) {
    const f = payload.fields || {};
    const body = {
      summary: String(payload.title || "").slice(0, 100),
      company: { id: Number(payload.companyID) },
      board: { id: Number(f.board) },
      status: { id: Number(f.status) },
      priority: { id: Number(f.priority) },
      initialDescription: String(payload.description || ""),
    };
    if (f.type) body.type = { id: Number(f.type) };
    if (payload.dueDate) body.requiredDate = payload.dueDate;
    const res = await cwFetch(settings, "/service/tickets", { method: "POST", body: JSON.stringify(body) });
    return { itemId: res.id, ticketNumber: res.id ? `#${res.id}` : null };
  },
};

// ---------- HaloPSA ----------

function haloBase(settings) {
  const h = settings.halo;
  if (!h.baseUrl || !h.clientId || !h.clientSecret) {
    throw new Error("HaloPSA credentials not configured (base URL, client ID, client secret).");
  }
  let base = h.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  return base;
}

async function haloToken(settings) {
  const h = settings.halo;
  const cache = h.tokenCache;
  if (cache?.token && cache.exp > Date.now() + 60000) return cache.token;
  const base = haloBase(settings);
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: h.clientId,
    client_secret: h.clientSecret,
    scope: "all",
  });
  let url = `${base}/auth/token`;
  if (h.tenant) url += `?tenant=${encodeURIComponent(h.tenant)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!res.ok || !body.access_token) {
    throw new Error(`HaloPSA auth failed (${res.status}): ${body.error_description || body.error || text.slice(0, 200)}`);
  }
  const tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  await saveSettings({ halo: { ...h, tokenCache } });
  return tokenCache.token;
}

async function haloFetch(settings, path, options = {}) {
  const token = await haloToken(settings);
  const res = await fetch(`${haloBase(settings)}/api${path}`, {
    ...options,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.error_description || body?.error || body?.message || (typeof body?.raw === "string" ? body.raw.slice(0, 200) : "") || res.statusText;
    throw new Error(`HaloPSA API ${res.status}: ${detail}`);
  }
  return body;
}

const haloAdapter = {
  name: "HaloPSA",
  async test(settings) {
    const types = await haloFetch(settings, "/TicketType", { method: "GET" });
    const n = Array.isArray(types) ? types.length : (types?.tickettypes?.length ?? 0);
    return `Connected — ${n} ticket type(s).`;
  },
  async getFields(settings) {
    const arr = (x, k) => (Array.isArray(x) ? x : x?.[k] || []);
    const types = arr(await haloFetch(settings, "/TicketType", { method: "GET" }), "tickettypes");
    let statuses = [], priorities = [];
    try { statuses = arr(await haloFetch(settings, "/Status", { method: "GET" }), "statuses"); } catch { /* optional */ }
    try { priorities = arr(await haloFetch(settings, "/Priority", { method: "GET" }), "priorities"); } catch { /* optional */ }
    return [
      { key: "tickettype", label: "Ticket type", required: true, options: types.map((t) => ({ value: String(t.id), label: t.name })) },
      { key: "status", label: "Status", options: statuses.map((s) => ({ value: String(s.id), label: s.name })) },
      { key: "priority", label: "Priority", options: priorities.map((p) => ({ value: String(p.id), label: p.name })) },
    ];
  },
  async searchCompanies(settings, query) {
    const body = await haloFetch(settings, `/Client?search=${encodeURIComponent(query)}&count=25`, { method: "GET" });
    const clients = Array.isArray(body) ? body : body?.clients || [];
    return clients.map((c) => ({ companyID: c.id, companyName: c.name }));
  },
  async createTicket(settings, payload) {
    const f = payload.fields || {};
    const ticket = {
      summary: String(payload.title || "").slice(0, 255),
      details: String(payload.description || ""),
      client_id: Number(payload.companyID),
      tickettype_id: Number(f.tickettype),
    };
    if (f.status) ticket.status_id = Number(f.status);
    if (f.priority) ticket.priority_id = Number(f.priority);
    if (payload.dueDate) ticket.deadlinedate = payload.dueDate;
    const res = await haloFetch(settings, "/Tickets", { method: "POST", body: JSON.stringify([ticket]) });
    const created = Array.isArray(res) ? res[0] : res;
    const itemId = created?.id;
    return { itemId, ticketNumber: itemId ? `#${itemId}` : null };
  },
};

export const PSA_ADAPTERS = { autotask: autotaskAdapter, connectwise: connectwiseAdapter, halo: haloAdapter };

export function suggestPriority(cmPriority, fields) {
  const pf = fields.find((f) => f.key === "priority");
  if (!pf || !pf.options.length) return {};
  const want = (cmPriority || "Medium").toLowerCase();
  const aliases = {
    critical: ["critical", "crisis", "urgent", "p1", "1"],
    high: ["high", "p2", "2"],
    medium: ["medium", "normal", "standard", "p3", "3"],
    low: ["low", "minor", "p4", "4"],
  };
  for (const n of aliases[want] || [want]) {
    const hit = pf.options.find((o) => o.label.toLowerCase().includes(n));
    if (hit) return { priority: hit.value };
  }
  const def = pf.options.find((o) => o.isDefault);
  return def ? { priority: def.value } : {};
}

/**
 * ControlMap PSA Bridge — background service worker.
 * ScalePad/ControlMap API + pluggable PSA adapters (Autotask, ConnectWise Manage, HaloPSA).
 */

const SCALEPAD_BASES = {
  us: "https://api.scalepad.com",
  eu: "https://eu.api.scalepad.com",
  ca: "https://ca.api.scalepad.com",
  au: "https://au.api.scalepad.com",
};

// ---------- storage ----------

const DEFAULT_SETTINGS = {
  psa: "autotask",
  scalepadApiKey: "",
  scalepadRegion: "us",
  autotask: { integrationCode: "", userName: "", secret: "", zoneUrl: "" },
  connectwise: { siteUrl: "", companyId: "", publicKey: "", privateKey: "", clientId: "" },
  halo: { baseUrl: "", clientId: "", clientSecret: "", tenant: "", tokenCache: null },
  // per-PSA ticket field defaults: { autotask: {status: "1", ...}, connectwise: {...}, halo: {...} }
  psaDefaults: { autotask: {}, connectwise: {}, halo: {} },
  // legacy (v0.1) flat autotask defaults — migrated on read
  defaults: null,
  // per-PSA client->company map: { autotask: { cmClientId: {companyID, companyName} }, ... }
  clientMap2: { autotask: {}, connectwise: {}, halo: {} },
  // legacy (v0.1) flat map — migrated on read
  clientMap: null,
  tenantMap: {},
  tenantCache: {},
};

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  // migrate v0.1 flat autotask defaults
  if (s.defaults && Object.keys(s.psaDefaults.autotask).length === 0) {
    s.psaDefaults.autotask = {
      status: s.defaults.statusValue || "",
      queueID: s.defaults.queueID || "",
      ticketType: s.defaults.ticketTypeValue || "",
      ticketCategory: s.defaults.ticketCategoryValue || "",
      source: s.defaults.sourceValue || "",
    };
    await chrome.storage.local.set({ psaDefaults: s.psaDefaults });
  }
  // migrate v0.1 flat clientMap
  if (s.clientMap && Object.keys(s.clientMap2.autotask).length === 0) {
    s.clientMap2.autotask = s.clientMap;
    await chrome.storage.local.set({ clientMap2: s.clientMap2 });
  }
  return s;
}

async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

// ---------- ScalePad / ControlMap ----------

function spBase(settings) {
  return SCALEPAD_BASES[settings.scalepadRegion] || SCALEPAD_BASES.us;
}

async function spFetch(settings, path, options = {}) {
  if (!settings.scalepadApiKey) throw new Error("ScalePad API key not configured. Open extension options.");
  const res = await fetch(spBase(settings) + path, {
    ...options,
    headers: {
      "x-api-key": settings.scalepadApiKey,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
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

async function listClients(settings) {
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

async function resolveTenant(settings, subdomain) {
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

async function getActionItemByCode(settings, clientId, code) {
  const r = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(clientId)}/action-items/search`, {
    method: "POST", body: JSON.stringify({ filter: { code }, page_size: 5 }),
  });
  const items = r?.action_items?.data || r?.data || [];
  const item = items.find((i) => i.code === code) || items[0];
  if (!item) throw new Error(`Action item ${code} not found via API.`);
  return { item, client: r.client };
}

// =====================================================================
// PSA ADAPTERS
// Each adapter implements:
//   test(settings) -> string summary
//   getFields(settings, context) -> [{key,label,options,required,reloads,dependsOn}]
//   searchCompanies(settings, query) -> [{companyID, companyName}]
//   createTicket(settings, payload) -> {itemId, ticketNumber}
//     payload: {companyID, title, description, fields:{key:value}, dueDate}
// =====================================================================

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
      try {
        statuses = await cwFetch(settings, `/service/boards/${boardId}/statuses?pageSize=100&fields=id,name&orderBy=sortOrder`, { method: "GET" });
      } catch { /* board may be invalid */ }
      try {
        types = await cwFetch(settings, `/service/boards/${boardId}/types?pageSize=100&fields=id,name&orderBy=name`, { method: "GET" });
      } catch { /* types optional */ }
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
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
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

const ADAPTERS = { autotask: autotaskAdapter, connectwise: connectwiseAdapter, halo: haloAdapter };

function activeAdapter(settings) {
  const a = ADAPTERS[settings.psa];
  if (!a) throw new Error(`Unknown PSA "${settings.psa}".`);
  return a;
}

// ---------- generic priority suggestion ----------

function suggestPriority(cmPriority, fields) {
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

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const settings = await getSettings();
    const adapter = ADAPTERS[settings.psa] || autotaskAdapter;
    switch (msg.type) {
      case "GET_TICKET_CONTEXT": {
        const client = await resolveTenant(settings, msg.subdomain);
        const { item } = await getActionItemByCode(settings, client.id, msg.code);
        const fields = await adapter.getFields(settings, {});
        const mapped = (settings.clientMap2[settings.psa] || {})[client.id] || null;
        let companySuggestions = [];
        if (!mapped) {
          try { companySuggestions = await adapter.searchCompanies(settings, (client.name || "").split(/\s+/)[0] || ""); } catch { /* optional */ }
        }
        return {
          psa: settings.psa,
          psaName: adapter.name,
          client, item, fields,
          mappedCompany: mapped,
          defaults: settings.psaDefaults[settings.psa] || {},
          suggested: suggestPriority(item.priority, fields),
          companySuggestions,
        };
      }
      case "GET_PSA_FIELDS":
        return { fields: await adapter.getFields(settings, msg.context || {}) };
      case "SEARCH_COMPANIES":
        return { companies: await adapter.searchCompanies(settings, msg.query) };
      case "CREATE_TICKET": {
        const result = await adapter.createTicket(settings, msg.payload);
        if (msg.clientId && msg.payload.companyID) {
          const clientMap2 = { ...settings.clientMap2 };
          clientMap2[settings.psa] = { ...(clientMap2[settings.psa] || {}) };
          clientMap2[settings.psa][msg.clientId] = { companyID: msg.payload.companyID, companyName: msg.payload.companyName || "" };
          await saveSettings({ clientMap2 });
        }
        return result;
      }
      case "TEST_PSA": {
        const which = msg.psa ? ADAPTERS[msg.psa] : adapter;
        return { summary: await which.test(settings) };
      }
      case "TEST_CM_CLIENT": {
        const r = await spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(msg.clientId)}/action-items/search`, {
          method: "POST", body: JSON.stringify({ page_size: 1 }),
        });
        return { tenant: r?.client?.tenant_id || null, total: r?.action_items?.total_count ?? r?.total_count ?? null };
      }
      case "LIST_CM_CLIENTS":
        return { clients: await listClients(settings) };
      case "TEST_SCALEPAD": {
        const clients = await listClients(settings);
        return { ok: true, count: clients.length };
      }
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

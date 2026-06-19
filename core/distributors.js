/**
 * core/distributors.js — Distributor procurement adapters (Pathway B).
 *
 * Common interface (so the procurement engine never changes per distributor):
 *   test(cfg)                        -> { ok, summary }
 *   getPriceAvailability(cfg, items) -> [{ key, mpn, distSku, price, currency, available, found, status, raw }]
 *   createOrder(cfg, order)          -> { orderNumber, status, raw }
 *   getOrderStatus(cfg, orderId)     -> { status, lines, raw }
 *
 * `cfg` is the distributor's stored `api` object. Credentials live only in the
 * background and are never sent to content scripts.
 *
 * Ingram Micro follows the published Xvantage Reseller v6 spec. TD SYNNEX and
 * D&H use a configurable base URL + auth (their portals are partner-gated);
 * verify endpoint/payload against your account before live submission.
 */

// Field schemas — used by the options UI to render credential inputs.
export const DISTRIBUTOR_ADAPTER_DEFS = {
  none: { label: "None (email only)", fields: [] },
  simulate: {
    label: "Simulate (no real API call)",
    fields: [
      { key: "outcome", label: "Simulated outcome", type: "select", options: ["success", "out-of-stock", "error"], default: "success" },
      { key: "delayMs", label: "Simulated delay (ms)", type: "text", default: "600" },
    ],
  },
  ingram: {
    label: "Ingram Micro (Xvantage)",
    fields: [
      { key: "clientId", label: "Client ID", type: "text" },
      { key: "clientSecret", label: "Client Secret", type: "password" },
      { key: "customerNumber", label: "Customer Number", type: "text" },
      { key: "countryCode", label: "Country code", type: "text", default: "US" },
      { key: "senderId", label: "Sender ID (app name)", type: "text", default: "ScalePadAtlas" },
      { key: "environment", label: "Environment", type: "select", options: ["sandbox", "production"], default: "sandbox" },
    ],
  },
  tdsynnex: {
    label: "TD SYNNEX (Reseller)",
    fields: [
      { key: "baseUrl", label: "API base URL", type: "text", default: "https://api.tdsynnex.com" },
      { key: "apiKey", label: "API key", type: "text" },
      { key: "apiSecret", label: "API secret", type: "password" },
      { key: "customerNumber", label: "Customer / account number", type: "text" },
      { key: "country", label: "Country", type: "text", default: "US" },
      { key: "orderPath", label: "Create-order path", type: "text", default: "/v1/orders" },
      { key: "paPath", label: "Price/availability path", type: "text", default: "/v1/price-availability" },
    ],
  },
  dh: {
    label: "D&H Distributing",
    fields: [
      { key: "baseUrl", label: "API base URL", type: "text", default: "https://api.dandh.com" },
      { key: "apiKey", label: "API key / username", type: "text" },
      { key: "apiSecret", label: "API secret / password", type: "password" },
      { key: "accountNumber", label: "Account number", type: "text" },
      { key: "orderPath", label: "Create-order path", type: "text", default: "/v1/orders" },
      { key: "paPath", label: "Price/availability path", type: "text", default: "/v1/priceavailability" },
    ],
  },
};

async function parseJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function correlationId(prefix) {
  const base = String(prefix || "AT").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return (base + Date.now().toString(36)).slice(0, 32);
}

// ───────────────────────────── Ingram Micro ─────────────────────────────
const _ingramToken = {}; // clientId -> { token, exp }

function ingramBase(cfg) {
  return cfg.environment === "production"
    ? "https://api.ingrammicro.com"
    : "https://api.ingrammicro.com/sandbox";
}

async function ingramAuth(cfg) {
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Ingram Client ID/Secret not configured.");
  const cached = _ingramToken[cfg.clientId];
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetch("https://api.ingrammicro.com/oauth/oauth30/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await parseJson(res);
  if (!res.ok || !j.access_token) {
    throw new Error("Ingram auth " + res.status + ": " + (j.error_description || j.error || "no token"));
  }
  _ingramToken[cfg.clientId] = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) * 1000) };
  return j.access_token;
}

function ingramHeaders(cfg, token) {
  return {
    "Authorization": "Bearer " + token,
    "IM-CustomerNumber": cfg.customerNumber || "",
    "IM-CountryCode": cfg.countryCode || "US",
    "IM-SenderID": cfg.senderId || "ScalePadAtlas",
    "IM-CorrelationID": correlationId(cfg.customerNumber),
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

const ingram = {
  async test(cfg) {
    await ingramAuth(cfg);
    return { ok: true, summary: "Authenticated with Ingram Micro (" + (cfg.environment || "sandbox") + ")." };
  },
  async getPriceAvailability(cfg, items) {
    const token = await ingramAuth(cfg);
    const url = ingramBase(cfg) + "/resellers/v6/catalog/priceandavailability?includeAvailability=true&includePricing=true";
    // Prefer the manufacturer part number (vendorPartNumber) — the universal
    // identifier Ingram resolves reliably. The Quoter "Disty SKU" is only an
    // Ingram part number when that line's supplier was Ingram, so it is a
    // fallback only.
    const products = items.map((it) => {
      const mpn = (it.mpn || "").trim();
      const sku = (it.distSku || "").trim();
      if (mpn) return { vendorPartNumber: mpn };
      if (sku) return { ingramPartNumber: sku };
      return null;
    }).filter(Boolean);
    const res = await fetch(url, { method: "POST", headers: ingramHeaders(cfg, token), body: JSON.stringify({ products }) });
    const j = await parseJson(res);
    if (!res.ok) {
      const msg = j?.fault?.faultstring || j?.[0]?.message || j?.errors?.[0]?.message || JSON.stringify(j).slice(0, 200);
      let hint = "";
      if (/apiproduct match/i.test(msg)) {
        hint = " — this Ingram app key isn't subscribed to the Price & Availability API product, or the environment (sandbox vs production) doesn't match. Add the product to your app in the Ingram developer portal.";
      } else if (res.status === 401 || res.status === 403) {
        hint = " — check the Client ID/Secret and that the key is authorized for this environment.";
      }
      throw new Error("Ingram P&A " + res.status + ": " + msg + hint);
    }
    const rows = Array.isArray(j) ? j : (j.products || j.catalog || []);
    return rows.map((r) => ingramMapPA(r));
  },
  async createOrder(cfg, order) {
    const token = await ingramAuth(cfg);
    const url = ingramBase(cfg) + "/resellers/v6/orders";
    const lines = order.lines.map((l, i) => ({
      customerLineNumber: String(i + 1),
      ingramPartNumber: l.distSku || l.mpn,
      quantity: Number(l.quantity) || 1,
    }));
    const body = { customerOrderNumber: order.poNumber, notes: order.notes || "", lines };
    if (order.shipToEmail) body.shipToInfo = { email: order.shipToEmail };
    const res = await fetch(url, { method: "POST", headers: ingramHeaders(cfg, token), body: JSON.stringify(body) });
    const j = await parseJson(res);
    if (!res.ok) {
      const msg = j?.fault?.faultstring || j?.[0]?.message || JSON.stringify(j).slice(0, 300);
      throw new Error("Ingram order " + res.status + ": " + msg);
    }
    const o = (j.orders && j.orders[0]) || j;
    return { orderNumber: o.ingramOrderNumber || o.orderNumber || null, status: o.orderStatus || "submitted", raw: j };
  },
  async getOrderStatus(cfg, orderId) {
    const token = await ingramAuth(cfg);
    const url = ingramBase(cfg) + "/resellers/v6/orders/" + encodeURIComponent(orderId);
    const res = await fetch(url, { method: "GET", headers: ingramHeaders(cfg, token) });
    const j = await parseJson(res);
    if (!res.ok) {
      const msg = j?.fault?.faultstring || j?.[0]?.message || JSON.stringify(j).slice(0, 200);
      throw new Error("Ingram status " + res.status + ": " + msg);
    }
    return { status: j.orderStatus || j?.orders?.[0]?.orderStatus || "unknown", lines: j.lines || [], raw: j };
  },
};

function ingramMapPA(r) {
  const av = r.availability || null;
  const pr = r.pricing || null;
  const statusMsg = r.productStatusMessage || r.productStatusCode || "";
  const notFound = (!av && !pr) || /not\s*found|invalid|no\s*record|unavailable sku/i.test(statusMsg);
  let available;
  if (av) {
    available = (av.totalAvailability != null) ? av.totalAvailability : (av.available ? null : 0);
  } else {
    available = notFound ? null : 0;
  }
  return {
    key: r.ingramPartNumber || r.vendorPartNumber || r.customerPartNumber,
    distSku: r.ingramPartNumber || "",
    mpn: r.vendorPartNumber || "",
    price: pr?.customerPrice ?? pr?.retailPrice ?? null,
    currency: pr?.currencyCode || "USD",
    available,
    found: !notFound,
    status: notFound ? "Product not found" : (statusMsg || ""),
    raw: r,
  };
}

// ─────────── Configurable REST adapter (TD SYNNEX, D&H, generic) ───────────
function restHeaders(cfg) {
  const h = { "Content-Type": "application/json", "Accept": "application/json" };
  if (cfg.apiKey) h["X-API-Key"] = cfg.apiKey;
  if (cfg.apiSecret) h["X-API-Secret"] = cfg.apiSecret;
  if (cfg.customerNumber) h["X-Customer-Number"] = cfg.customerNumber;
  if (cfg.accountNumber) h["X-Account-Number"] = cfg.accountNumber;
  return h;
}

function makeRestAdapter(name) {
  return {
    async test(cfg) {
      if (!cfg.baseUrl) throw new Error(name + " base URL not configured.");
      if (!cfg.apiKey) throw new Error(name + " API key not configured.");
      return { ok: true, summary: name + " credentials saved. Verify live calls against your account docs." };
    },
    async getPriceAvailability(cfg, items) {
      if (!cfg.baseUrl || !cfg.paPath) throw new Error(name + " price/availability path not configured.");
      const url = cfg.baseUrl.replace(/\/+$/, "") + cfg.paPath;
      const skus = items.map((it) => it.distSku || it.mpn);
      const res = await fetch(url, { method: "POST", headers: restHeaders(cfg), body: JSON.stringify({ skus, country: cfg.country || "US" }) });
      const j = await parseJson(res);
      if (!res.ok) throw new Error(name + " P&A " + res.status + ": " + JSON.stringify(j).slice(0, 200));
      const rows = j.items || j.products || (Array.isArray(j) ? j : []);
      return rows.map((r) => ({
        key: r.sku || r.partNumber || r.mpn,
        distSku: r.sku || r.partNumber || "",
        mpn: r.mpn || r.manufacturerPartNumber || "",
        price: r.price ?? r.unitPrice ?? null,
        currency: r.currency || "USD",
        available: r.available ?? r.quantityAvailable ?? null,
        found: r.found !== false,
        status: r.status || "",
        raw: r,
      }));
    },
    async createOrder(cfg, order) {
      if (!cfg.baseUrl || !cfg.orderPath) throw new Error(name + " create-order path not configured.");
      const url = cfg.baseUrl.replace(/\/+$/, "") + cfg.orderPath;
      const lines = order.lines.map((l, i) => ({
        lineNumber: i + 1,
        sku: l.distSku || l.mpn,
        manufacturerPartNumber: l.mpn,
        quantity: Number(l.quantity) || 1,
      }));
      const payload = { purchaseOrderNumber: order.poNumber, shipToEmail: order.shipToEmail || undefined, notes: order.notes || "", lines };
      const res = await fetch(url, { method: "POST", headers: restHeaders(cfg), body: JSON.stringify(payload) });
      const j = await parseJson(res);
      if (!res.ok) throw new Error(name + " order " + res.status + ": " + JSON.stringify(j).slice(0, 300));
      return { orderNumber: j.orderNumber || j.orderId || j.purchaseOrderNumber || null, status: j.status || "submitted", raw: j };
    },
    async getOrderStatus(cfg, orderId) {
      if (!cfg.baseUrl) throw new Error(name + " base URL not configured.");
      const url = cfg.baseUrl.replace(/\/+$/, "") + (cfg.orderPath || "/v1/orders") + "/" + encodeURIComponent(orderId);
      const res = await fetch(url, { method: "GET", headers: restHeaders(cfg) });
      const j = await parseJson(res);
      if (!res.ok) throw new Error(name + " status " + res.status + ": " + JSON.stringify(j).slice(0, 200));
      return { status: j.status || "unknown", lines: j.lines || [], raw: j };
    },
  };
}

// ─────────────────────── Simulate (dry-run, no network) ───────────────────────
function simWait(cfg) {
  const ms = Math.max(0, Math.min(5000, parseInt(cfg.delayMs, 10) || 0));
  return new Promise((r) => setTimeout(r, ms));
}

const simulate = {
  async test(cfg) {
    await simWait(cfg);
    if (cfg.outcome === "error") throw new Error("Simulated connection failure (outcome = error).");
    return { ok: true, summary: "Simulation ready — orders will be faked, no real API is called." };
  },
  async getPriceAvailability(cfg, items) {
    await simWait(cfg);
    if (cfg.outcome === "error") throw new Error("Simulated price/availability failure.");
    const oos = cfg.outcome === "out-of-stock";
    return (items || []).map((it, i) => {
      const seed = ((it.distSku || it.mpn || String(i)).length * 7 + i * 13) % 90;
      return {
        key: it.distSku || it.mpn,
        distSku: it.distSku || "",
        mpn: it.mpn || "",
        price: Number((19.99 + seed * 3.5).toFixed(2)),
        currency: "USD",
        available: oos ? 0 : (5 + seed),
        found: !oos,
        status: oos ? "Out of stock (simulated)" : "",
        raw: { simulated: true },
      };
    });
  },
  async createOrder(cfg, order) {
    await simWait(cfg);
    if (cfg.outcome === "error") throw new Error("Simulated order rejection (outcome = error).");
    if (cfg.outcome === "out-of-stock") throw new Error("Simulated: one or more lines are out of stock.");
    const n = "SIM-" + Date.now().toString(36).toUpperCase().slice(-6);
    const raw = { simulated: true, poNumber: order.poNumber, lineCount: (order.lines || []).length };
    return { orderNumber: n, status: "simulated", raw };
  },
  async getOrderStatus(cfg, orderId) {
    await simWait(cfg);
    return { status: "simulated-shipped", lines: [], raw: { simulated: true, orderId } };
  },
};

export const DISTRIBUTOR_ADAPTERS = {
  simulate,
  ingram,
  tdsynnex: makeRestAdapter("TD SYNNEX"),
  dh: makeRestAdapter("D&H"),
};

export function getDistributorAdapter(type) {
  return DISTRIBUTOR_ADAPTERS[type] || null;
}

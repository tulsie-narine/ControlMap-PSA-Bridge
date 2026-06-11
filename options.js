/** ControlMap PSA Bridge — options page logic (multi-PSA). */

const $ = (id) => document.getElementById(id);
const PSAS = ["autotask", "connectwise", "halo"];
let currentPsa = "autotask";
let defaultFieldSels = {}; // key -> select for ticket defaults

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res?.ok ? resolve(res.data) : reject(new Error(res?.error || "Unknown error"));
    });
  });
}

function flash(elId, text, ok) {
  const el = $(elId);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

function setActivePsa(psa) {
  currentPsa = psa;
  document.querySelectorAll(".psa-tab").forEach((t) => t.classList.toggle("active", t.dataset.psa === psa));
  PSAS.forEach((p) => $(`pane-${p}`).classList.toggle("active", p === psa));
}

document.querySelectorAll(".psa-tab").forEach((t) => {
  t.addEventListener("click", async () => {
    setActivePsa(t.dataset.psa);
    await persist();
    const settings = await chrome.storage.local.get(null);
    renderMappings(settings);
    loadDefaultFields(settings).catch(() => {});
  });
});

// ---------- ticket defaults (dynamic per PSA) ----------

async function loadDefaultFields(settings) {
  const grid = $("defaultsGrid");
  grid.innerHTML = "";
  defaultFieldSels = {};
  try {
    const { fields } = await send({ type: "GET_PSA_FIELDS", context: {} });
    const saved = (settings?.psaDefaults || {})[currentPsa] || {};
    for (const field of fields) {
      const wrap = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = `Default ${field.label.toLowerCase()}`;
      wrap.appendChild(label);
      const sel = document.createElement("select");
      const none = document.createElement("option");
      none.value = ""; none.textContent = "—";
      sel.appendChild(none);
      for (const o of field.options || []) {
        const opt = document.createElement("option");
        opt.value = String(o.value); opt.textContent = o.label;
        sel.appendChild(opt);
      }
      if (saved[field.key]) sel.value = String(saved[field.key]);
      if (field.reloads) {
        sel.addEventListener("change", async () => {
          await persist();
          const s = await chrome.storage.local.get(null);
          loadDefaultFields(s).catch(() => {});
        });
      }
      defaultFieldSels[field.key] = sel;
      wrap.appendChild(sel);
      grid.appendChild(wrap);
    }
    if (!fields.length) flash("defMsg", "No fields returned.", false);
  } catch (e) {
    flash("defMsg", e.message, false);
  }
}

$("loadPicklists").addEventListener("click", async () => {
  await persist();
  const settings = await chrome.storage.local.get(null);
  await loadDefaultFields(settings);
});

// ---------- mappings ----------

function renderMappings(settings) {
  const tbody = $("mapTable").querySelector("tbody");
  tbody.innerHTML = "";
  const map = (settings.clientMap2 || {})[currentPsa] || {};
  const entries = Object.entries(map);
  if (!entries.length) {
    tbody.innerHTML = "<tr><td colspan='3' style='color:#8a90a5'>No mappings yet.</td></tr>";
  }
  const nameById = tenantNamesById(settings);
  for (const [clientId, m] of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${nameById[clientId] || clientId}</td><td>${m.companyName || m.companyID}</td><td></td>`;
    const rm = document.createElement("button");
    rm.textContent = "remove";
    rm.addEventListener("click", async () => {
      const stored = await chrome.storage.local.get({ clientMap2: {} });
      if (stored.clientMap2[currentPsa]) delete stored.clientMap2[currentPsa][clientId];
      await chrome.storage.local.set({ clientMap2: stored.clientMap2 });
      init();
    });
    tr.lastElementChild.appendChild(rm);
    tbody.appendChild(tr);
  }
  renderTenantMappings(settings);
}

function tenantNamesById(settings) {
  const out = {};
  for (const entry of [...Object.values(settings.tenantCache || {}), ...Object.values(settings.tenantMap || {})]) {
    if (entry?.id) out[entry.id] = entry.name || entry.id;
  }
  return out;
}

let tnSelectedCompany = null;

function renderTenantMappings(settings) {
  const tbody = $("tenantTable").querySelector("tbody");
  tbody.innerHTML = "";
  const entries = Object.entries(settings.tenantMap || {});
  if (!entries.length) {
    tbody.innerHTML = "<tr><td colspan='4' style='color:#8a90a5'>No tenant mappings yet.</td></tr>";
    return;
  }
  for (const [sub, m] of entries) {
    const company = ((settings.clientMap2 || {})[currentPsa] || {})[m.id];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${sub}</td><td>${m.name || m.id}</td><td>${company ? (company.companyName || company.companyID) : "—"}</td><td></td>`;
    const test = document.createElement("button");
    test.textContent = "test";
    test.style.color = "#3f4bb8";
    test.addEventListener("click", async () => {
      flash("tnMsg", "Testing ControlMap access…", true);
      try {
        const r = await send({ type: "TEST_CM_CLIENT", clientId: m.id });
        flash("tnMsg", `OK — client reachable (tenant: ${r.tenant || "?"}, ${r.total ?? "?"} action item(s)).`, true);
      } catch (e) {
        flash("tnMsg", e.message, false);
      }
    });
    tr.lastElementChild.appendChild(test);
    const rm = document.createElement("button");
    rm.textContent = "remove";
    rm.addEventListener("click", async () => {
      const stored = await chrome.storage.local.get({ tenantMap: {} });
      delete stored.tenantMap[sub];
      await chrome.storage.local.set({ tenantMap: stored.tenantMap });
      init();
    });
    tr.lastElementChild.appendChild(rm);
    tbody.appendChild(tr);
  }
}

$("tnLoad").addEventListener("click", async () => {
  await persist();
  try {
    const { clients } = await send({ type: "LIST_CM_CLIENTS" });
    const sel = $("tnClient");
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— select client —";
    sel.appendChild(none);
    for (const c of clients) {
      const id = c.id || c.client_id;
      if (!id) continue;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = c.name || c.client_name || id;
      sel.appendChild(opt);
    }
    flash("tnMsg", `Loaded ${clients.length} client(s).`, true);
  } catch (e) {
    flash("tnMsg", e.message, false);
  }
});

let tnTimer = null;
$("tnCompany").addEventListener("input", () => {
  tnSelectedCompany = null;
  clearTimeout(tnTimer);
  tnTimer = setTimeout(async () => {
    const q = $("tnCompany").value.trim();
    const box = $("tnCompanyResults");
    if (q.length < 2) { box.style.display = "none"; return; }
    try {
      const { companies } = await send({ type: "SEARCH_COMPANIES", query: q });
      box.innerHTML = "";
      for (const c of companies) {
        const d = document.createElement("div");
        d.style.cssText = "padding:7px 10px;cursor:pointer;font-size:13px";
        d.textContent = c.companyName;
        d.addEventListener("mouseenter", () => (d.style.background = "#eef1ff"));
        d.addEventListener("mouseleave", () => (d.style.background = ""));
        d.addEventListener("click", () => {
          tnSelectedCompany = c;
          $("tnCompany").value = c.companyName;
          box.style.display = "none";
        });
        box.appendChild(d);
      }
      box.style.display = companies.length ? "block" : "none";
    } catch { /* PSA creds may not be set yet */ }
  }, 300);
});

$("tnAdd").addEventListener("click", async () => {
  const sub = $("tnSub").value.trim().toLowerCase();
  const sel = $("tnClient");
  const clientId = sel.value;
  if (!sub || !clientId) {
    flash("tnMsg", "Enter a subdomain and select a ScalePad client.", false);
    return;
  }
  const stored = await chrome.storage.local.get({ tenantMap: {}, clientMap2: {} });
  stored.tenantMap[sub] = { id: clientId, name: sel.options[sel.selectedIndex].textContent };
  if (tnSelectedCompany) {
    stored.clientMap2[currentPsa] = stored.clientMap2[currentPsa] || {};
    stored.clientMap2[currentPsa][clientId] = { companyID: tnSelectedCompany.companyID, companyName: tnSelectedCompany.companyName };
  }
  await chrome.storage.local.set({ tenantMap: stored.tenantMap, clientMap2: stored.clientMap2 });
  $("tnSub").value = ""; $("tnCompany").value = ""; tnSelectedCompany = null;
  flash("tnMsg", `Mapped "${sub}".`, true);
  init();
});

// ---------- init / persist ----------

async function init() {
  const settings = await chrome.storage.local.get(null);
  setActivePsa(settings.psa || "autotask");

  $("spKey").value = settings.scalepadApiKey || "";
  $("spRegion").value = settings.scalepadRegion || "us";

  const at = settings.autotask || {};
  $("atCode").value = at.integrationCode || "";
  $("atUser").value = at.userName || "";
  $("atSecret").value = at.secret || "";

  const cw = settings.connectwise || {};
  $("cwSite").value = cw.siteUrl || "";
  $("cwCompany").value = cw.companyId || "";
  $("cwPublic").value = cw.publicKey || "";
  $("cwPrivate").value = cw.privateKey || "";
  $("cwClientId").value = cw.clientId || "";

  const halo = settings.halo || {};
  $("haloUrl").value = halo.baseUrl || "";
  $("haloTenant").value = halo.tenant || "";
  $("haloClientId").value = halo.clientId || "";
  $("haloSecret").value = halo.clientSecret || "";

  renderMappings(settings);
  loadDefaultFields(settings).catch(() => {});
}

async function persist() {
  const prev = await chrome.storage.local.get({ autotask: {}, halo: {}, psaDefaults: { autotask: {}, connectwise: {}, halo: {} } });

  const userName = $("atUser").value.trim();
  const zoneUrl = prev.autotask.userName === userName ? (prev.autotask.zoneUrl || "") : "";

  const haloUrl = $("haloUrl").value.trim();
  const haloClientId = $("haloClientId").value.trim();
  const tokenCache = (prev.halo.baseUrl === haloUrl && prev.halo.clientId === haloClientId) ? (prev.halo.tokenCache || null) : null;

  // collect ticket defaults for the current PSA
  const psaDefaults = { autotask: {}, connectwise: {}, halo: {}, ...prev.psaDefaults };
  const mine = {};
  for (const [key, sel] of Object.entries(defaultFieldSels)) if (sel.value) mine[key] = sel.value;
  if (Object.keys(defaultFieldSels).length) psaDefaults[currentPsa] = mine;

  await chrome.storage.local.set({
    psa: currentPsa,
    scalepadApiKey: $("spKey").value.trim(),
    scalepadRegion: $("spRegion").value,
    autotask: {
      integrationCode: $("atCode").value.trim(),
      userName,
      secret: $("atSecret").value.trim(),
      zoneUrl,
    },
    connectwise: {
      siteUrl: $("cwSite").value.trim(),
      companyId: $("cwCompany").value.trim(),
      publicKey: $("cwPublic").value.trim(),
      privateKey: $("cwPrivate").value.trim(),
      clientId: $("cwClientId").value.trim(),
    },
    halo: {
      baseUrl: haloUrl,
      tenant: $("haloTenant").value.trim(),
      clientId: haloClientId,
      clientSecret: $("haloSecret").value.trim(),
      tokenCache,
    },
    psaDefaults,
  });
}

$("save").addEventListener("click", async () => {
  await persist();
  flash("saveMsg", "Settings saved.", true);
});

$("testSp").addEventListener("click", async () => {
  await persist();
  try {
    const r = await send({ type: "TEST_SCALEPAD" });
    flash("spMsg", `Connected — ${r.count} client(s) visible.`, true);
  } catch (e) {
    flash("spMsg", e.message, false);
  }
});

$("testPsa").addEventListener("click", async () => {
  await persist();
  try {
    const r = await send({ type: "TEST_PSA", psa: currentPsa });
    flash("psaMsg", r.summary, true);
    const settings = await chrome.storage.local.get(null);
    loadDefaultFields(settings).catch(() => {});
  } catch (e) {
    flash("psaMsg", e.message, false);
  }
});

init();

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

const PSA_NAMES = { autotask: "Autotask", connectwise: "ConnectWise PSA", halo: "HaloPSA" };
let modalPsa = null; // PSA shown in the config modal

function setActivePsa(psa) {
  currentPsa = psa;
  refreshPsaTiles();
}

function refreshPsaTiles() {
  PSAS.forEach((p) => {
    const b = $(`badge-${p}`);
    if (!b) return;
    if (p === currentPsa) { b.textContent = "ACTIVE"; b.className = "badge active"; }
    else { b.textContent = ""; b.className = "badge"; }
  });
}

function openPsaModal(psa) {
  modalPsa = psa;
  $("psaModalTitle").textContent = `Configure ${PSA_NAMES[psa]}`;
  PSAS.forEach((p) => $(`pane-${p}`).classList.toggle("active", p === psa));
  $("psaActiveChk").checked = psa === currentPsa;
  $("psaMsg").className = "msg";
  $("psaModal").classList.add("open");
}

function closePsaModal() { $("psaModal").classList.remove("open"); }

document.querySelectorAll("#psaTiles .tile").forEach((t) => {
  t.addEventListener("click", () => openPsaModal(t.dataset.psa));
});
$("psaModalClose").addEventListener("click", closePsaModal);
$("psaModal").addEventListener("click", (e) => { if (e.target === $("psaModal")) closePsaModal(); });
$("psaModalSave").addEventListener("click", async () => {
  if ($("psaActiveChk").checked) currentPsa = modalPsa;
  await persist();
  refreshPsaTiles();
  flash("psaMsg", "Saved.", true);
  const settings = await chrome.storage.local.get(null);
  renderMappings(settings);
  loadDefaultFields(settings).catch(() => {});
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
    const r = await send({ type: "TEST_PSA", psa: modalPsa || currentPsa });
    flash("psaMsg", r.summary, true);
    const settings = await chrome.storage.local.get(null);
    loadDefaultFields(settings).catch(() => {});
  } catch (e) {
    flash("psaMsg", e.message, false);
  }
});

init();

// ===================== Integrations (framework) =====================

let integList = [];
let modalInteg = null;
let integInputs = {};
let integToggle = null;

async function renderIntegrations() {
  const wrap = $("integrationsWrap");
  if (!wrap) return;
  wrap.className = "tiles";
  wrap.innerHTML = "";
  let data;
  try {
    data = await send({ type: "LIST_INTEGRATIONS" });
  } catch (e) {
    wrap.className = "";
    wrap.innerHTML = `<div class="msg err" style="display:block">${e.message}</div>`;
    return;
  }
  integList = data.integrations;
  for (const integ of integList) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    const img = document.createElement("img");
    img.src = integ.icon || "assets/default-integration.svg";
    img.alt = integ.name;
    img.onerror = () => { img.src = "assets/default-integration.svg"; };
    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = integ.name;
    const badge = document.createElement("span");
    badge.className = "badge " + (integ.enabled ? "on" : "off");
    badge.textContent = integ.enabled ? "ON" : "OFF";
    tile.appendChild(img); tile.appendChild(name); tile.appendChild(badge);
    tile.addEventListener("click", () => openIntegModal(integ));
    wrap.appendChild(tile);
  }
}

async function openIntegModal(integ) {
  modalInteg = integ;
  integInputs = {};
  const title = $("integModalTitle");
  title.innerHTML = "";
  const img = document.createElement("img");
  img.src = integ.icon || "assets/default-integration.svg";
  img.onerror = () => { img.src = "assets/default-integration.svg"; };
  title.appendChild(img);
  title.appendChild(document.createTextNode(integ.name));

  const body = $("integModalBody");
  body.innerHTML = "";

  // ── Tab bar ──
  const tabBar = document.createElement("div");
  tabBar.className = "mtabs";
  const tabConfig = document.createElement("button");
  tabConfig.type = "button"; tabConfig.className = "mtab active"; tabConfig.textContent = "Configuration";
  const tabMap = document.createElement("button");
  tabMap.type = "button"; tabMap.className = "mtab"; tabMap.textContent = "Evidence Mapping";
  tabBar.appendChild(tabConfig); tabBar.appendChild(tabMap);
  body.appendChild(tabBar);

  const paneConfig = document.createElement("div");
  paneConfig.className = "mpane active";
  paneConfig.style.padding = "14px 0 0";
  const paneMap = document.createElement("div");
  paneMap.className = "mpane";
  paneMap.style.padding = "14px 0 0";
  body.appendChild(paneConfig);
  body.appendChild(paneMap);

  let mapBuilt = false;
  function showTab(which) {
    tabConfig.classList.toggle("active", which === "config");
    tabMap.classList.toggle("active", which === "map");
    paneConfig.classList.toggle("active", which === "config");
    paneMap.classList.toggle("active", which === "map");
    // footer Test/Save apply to Configuration only
    $("integModalTest").style.display = which === "config" ? "" : "none";
    $("integModalSave").style.display = which === "config" ? "" : "none";
    if (which === "map" && !mapBuilt) { mapBuilt = true; buildEvidenceMapPane(paneMap, integ); }
  }
  tabConfig.addEventListener("click", () => showTab("config"));
  tabMap.addEventListener("click", () => showTab("map"));

  paneConfig.innerHTML = `<div class="hint" style="margin-bottom:8px">${integ.description} <b>v${integ.version}</b> · ${integ.checks.length} check(s)</div>`;

  const cfg = await send({ type: "GET_INTEGRATION_CONFIG", id: integ.id });

  const toggleWrap = document.createElement("label");
  toggleWrap.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0 10px";
  integToggle = document.createElement("input");
  integToggle.type = "checkbox";
  integToggle.style.width = "auto";
  integToggle.checked = !!cfg.enabled;
  toggleWrap.appendChild(integToggle);
  toggleWrap.appendChild(document.createTextNode("Enabled (shown in the overlay panel)"));
  paneConfig.appendChild(toggleWrap);

  const grid = document.createElement("div");
  grid.className = "row";
  for (const field of integ.configSchema) {
    const cell = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = field.label + (field.required ? " *" : "");
    cell.appendChild(label);

    let control;

    if (field.type === "select") {
      // ── <select> ──────────────────────────────────────────────────────────
      control = document.createElement("select");
      if (!field.required) {
        const none = document.createElement("option");
        none.value = ""; none.textContent = field.placeholder || "—";
        control.appendChild(none);
      }
      for (const opt of field.options || []) {
        const o = document.createElement("option");
        o.value = String(opt.value ?? opt);
        o.textContent = opt.label ?? opt;
        control.appendChild(o);
      }
      control.value = cfg.config[field.key] ?? field.default ?? "";

    } else if (field.type === "checkbox") {
      // ── <input type="checkbox"> ───────────────────────────────────────────
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:400;margin-top:2px";
      control = document.createElement("input");
      control.type = "checkbox";
      control.style.width = "auto";
      control.checked = cfg.config[field.key] === true || cfg.config[field.key] === "true";
      const span = document.createElement("span");
      span.textContent = field.checkboxLabel || "";
      wrap.appendChild(control);
      wrap.appendChild(span);
      cell.appendChild(wrap);
      // skip the standard cell.appendChild(control) below
      control._isWrapped = true;

    } else if (field.type === "multi-text") {
      // ── Comma-separated text (displayed as <textarea>) ───────────────────
      control = document.createElement("textarea");
      control.rows = 3;
      control.placeholder = field.placeholder || "one value per line";
      control.style.resize = "vertical";
      // Store as newline-separated; present as newline-separated
      const stored = cfg.config[field.key];
      control.value = Array.isArray(stored)
        ? stored.join("\n")
        : (stored || "").replace(/,\s*/g, "\n");

    } else {
      // ── text / password / number (default) ───────────────────────────────
      control = document.createElement("input");
      control.type = field.type === "password" ? "password"
                   : field.type === "number"   ? "number"
                   : "text";
      if (field.min  != null) control.min  = field.min;
      if (field.max  != null) control.max  = field.max;
      if (field.step != null) control.step = field.step;
      control.placeholder = field.placeholder || "";
      control.value = cfg.config[field.key] ?? field.default ?? "";
    }

    integInputs[field.key] = control;
    if (!control._isWrapped) cell.appendChild(control);

    if (field.help) {
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = field.help;
      cell.appendChild(h);
    }
    grid.appendChild(cell);
  }
  paneConfig.appendChild(grid);

  const msg = document.createElement("div");
  msg.className = "msg";
  msg.id = "integModalMsg";
  paneConfig.appendChild(msg);

  showTab("config");
  $("integModal").classList.add("open");
}

async function saveIntegModal() {
  const config = {};
  for (const [k, control] of Object.entries(integInputs)) {
    const field = modalInteg.configSchema.find((f) => f.key === k);
    if (field?.type === "checkbox") {
      config[k] = control.checked;
    } else if (field?.type === "multi-text") {
      // Store as array; split on newlines and commas, filter blanks
      config[k] = control.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    } else {
      config[k] = typeof control.value === "string" ? control.value.trim() : control.value;
    }
  }
  await send({ type: "SET_INTEGRATION_CONFIG", id: modalInteg.id, enabled: integToggle.checked, config });
}

$("integModalClose").addEventListener("click", () => $("integModal").classList.remove("open"));
$("integModal").addEventListener("click", (e) => { if (e.target === $("integModal")) $("integModal").classList.remove("open"); });
$("integModalSave").addEventListener("click", async () => {
  try {
    await saveIntegModal();
    flash("integModalMsg", "Saved.", true);
    renderIntegrations();
  } catch (e) { flash("integModalMsg", e.message, false); }
});
$("integModalTest").addEventListener("click", async () => {
  try {
    if (!integToggle.checked) integToggle.checked = true;
    await saveIntegModal();
    const r = await send({ type: "TEST_INTEGRATION", id: modalInteg.id });
    flash("integModalMsg", r.summary, true);
    renderIntegrations();
  } catch (e) { flash("integModalMsg", e.message, false); }
});

// ===================== Evidence pre-mapping (per integration + client) =====================

async function buildEvidenceMapPane(pane, integ) {
  pane.innerHTML = "";
  pane.appendChild(Object.assign(document.createElement("div"), {
    className: "hint",
    style: "margin-bottom:8px",
    textContent: "Pre-map where each check's evidence should go in ControlMap for a client. Then use “Attach pre-mapped” in the overlay panel to upload all checks at once.",
  }));

  // Client picker
  const clientWrap = document.createElement("div");
  const clientLbl = document.createElement("label"); clientLbl.textContent = "ControlMap client";
  const clientSel = document.createElement("select");
  clientSel.innerHTML = "<option value=''>— loading clients… —</option>";
  clientWrap.appendChild(clientLbl); clientWrap.appendChild(clientSel);
  pane.appendChild(clientWrap);

  const rowsWrap = document.createElement("div");
  rowsWrap.style.marginTop = "12px";
  pane.appendChild(rowsWrap);

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:12px";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn"; saveBtn.style.margin = "0"; saveBtn.textContent = "Save mapping";
  const bulkNew = document.createElement("button");
  bulkNew.className = "btn ghost"; bulkNew.type = "button"; bulkNew.textContent = "Set all → Create new";
  bar.appendChild(saveBtn); bar.appendChild(bulkNew);
  pane.appendChild(bar);
  const mapMsg = document.createElement("div"); mapMsg.className = "msg"; pane.appendChild(mapMsg);

  function flashMap(text, ok) { mapMsg.textContent = text; mapMsg.className = "msg " + (ok ? "ok" : "err"); }

  let evidences = [];      // [{id, code, title}]
  let rowControls = [];    // [{checkId, modeSel, titleIn, evSel}]

  // Load clients, default to a tenant-mapped client if available
  let defaultClientId = "";
  try {
    const settings = await chrome.storage.local.get({ tenantMap: {} });
    const first = Object.values(settings.tenantMap || {})[0];
    if (first?.id) defaultClientId = first.id;
  } catch { /* ignore */ }

  try {
    const { clients } = await send({ type: "LIST_CM_CLIENTS" });
    clientSel.innerHTML = "<option value=''>— select client —</option>";
    for (const c of clients) {
      const id = c.id || c.client_id; if (!id) continue;
      const opt = document.createElement("option");
      opt.value = id; opt.textContent = c.name || c.client_name || id;
      clientSel.appendChild(opt);
    }
    if (defaultClientId && [...clientSel.options].some((o) => o.value === defaultClientId)) {
      clientSel.value = defaultClientId;
    }
  } catch (e) {
    clientSel.innerHTML = `<option value=''>— could not load clients —</option>`;
    flashMap(e.message, false);
  }

  function fillEvSelect(sel, currentId) {
    sel.innerHTML = "<option value=''>— select evidence —</option>";
    for (const ev of evidences) {
      const o = document.createElement("option");
      o.value = String(ev.id);
      o.textContent = `${ev.code || ev.id} — ${String(ev.title || "").slice(0, 60)}`;
      sel.appendChild(o);
    }
    if (currentId) sel.value = String(currentId);
  }

  async function loadForClient(clientId) {
    rowsWrap.innerHTML = "";
    rowControls = [];
    if (!clientId) return;
    rowsWrap.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "Loading checks and evidences…" }));
    let map = {}, checks = [];
    try {
      const r = await send({ type: "GET_EVIDENCE_MAP", integrationId: integ.id, clientId });
      map = r.map || {}; checks = r.checks || [];
      const ev = await send({ type: "LIST_EVIDENCES_FOR_CLIENT", clientId });
      evidences = ev.evidences || [];
    } catch (e) { rowsWrap.innerHTML = ""; flashMap(e.message, false); return; }

    rowsWrap.innerHTML = "";
    for (const c of checks) {
      const saved = map[c.id] || { mode: "skip" };
      const row = document.createElement("div"); row.className = "emap-row";
      const ck = document.createElement("div"); ck.className = "ck";
      ck.innerHTML = `<b>${c.title}</b><small>${c.id}${c.frameworks?.length ? " · " + c.frameworks.slice(0,2).join(" · ") : ""}</small>`;
      const ctl = document.createElement("div"); ctl.className = "emap-ctl";

      const modeSel = document.createElement("select");
      for (const [v, t] of [["skip","Skip"],["new","Create new"],["existing","Map to existing"]]) {
        const o = document.createElement("option"); o.value = v; o.textContent = t; modeSel.appendChild(o);
      }
      modeSel.value = saved.mode || "skip";

      const titleIn = document.createElement("input");
      titleIn.type = "text";
      titleIn.placeholder = "new evidence title";
      titleIn.value = saved.title || `[${integ.name}] ${c.title}`;

      const evSel = document.createElement("select");
      fillEvSelect(evSel, saved.evidenceId);

      function sync() {
        titleIn.style.display = modeSel.value === "new" ? "" : "none";
        evSel.style.display = modeSel.value === "existing" ? "" : "none";
      }
      modeSel.addEventListener("change", sync);
      sync();

      ctl.appendChild(modeSel); ctl.appendChild(titleIn); ctl.appendChild(evSel);
      row.appendChild(ck); row.appendChild(ctl);
      rowsWrap.appendChild(row);
      rowControls.push({ checkId: c.id, modeSel, titleIn, evSel });
    }
    if (!checks.length) rowsWrap.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: "No checks." }));
  }

  clientSel.addEventListener("change", () => loadForClient(clientSel.value));
  if (clientSel.value) loadForClient(clientSel.value);

  bulkNew.addEventListener("click", () => {
    for (const rc of rowControls) { rc.modeSel.value = "new"; rc.modeSel.dispatchEvent(new Event("change")); }
  });

  saveBtn.addEventListener("click", async () => {
    const clientId = clientSel.value;
    if (!clientId) { flashMap("Select a client first.", false); return; }
    const map = {};
    for (const rc of rowControls) {
      const mode = rc.modeSel.value;
      if (mode === "new") map[rc.checkId] = { mode: "new", title: rc.titleIn.value.trim() };
      else if (mode === "existing") {
        if (!rc.evSel.value) { flashMap(`Pick an evidence for ${rc.checkId}, or set it to Skip.`, false); return; }
        map[rc.checkId] = { mode: "existing", evidenceId: Number(rc.evSel.value) };
      } else map[rc.checkId] = { mode: "skip" };
    }
    try {
      await send({ type: "SET_EVIDENCE_MAP", integrationId: integ.id, clientId, map });
      const n = Object.values(map).filter((m) => m.mode !== "skip").length;
      flashMap(`Saved — ${n} check(s) mapped for this client.`, true);
    } catch (e) { flashMap(e.message, false); }
  });
}


// ===================== Product tabs (ControlMap / Lifecycle Manager) =====================
document.querySelectorAll(".prod-tab").forEach((t) => {
  t.addEventListener("click", () => {
    const prod = t.dataset.prod;
    document.querySelectorAll(".prod-tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".prodpane").forEach((p) => p.classList.toggle("active", p.id === "prodPane-" + prod));
  });
});

renderIntegrations();

// ---------- Quoter: distributor directory + API adapters ----------
const DIST_ADAPTER_DEFS = {
  none: { label: "None (email only)", fields: [] },
  simulate: { label: "Simulate (no real API call)", fields: [
    { key: "outcome", label: "Simulated outcome", type: "select", options: ["success", "out-of-stock", "error"], default: "success" },
    { key: "delayMs", label: "Simulated delay (ms)", type: "text", default: "600" },
  ] },
  ingram: { label: "Ingram Micro (Xvantage)", fields: [
    { key: "clientId", label: "Client ID", type: "text" },
    { key: "clientSecret", label: "Client Secret", type: "password" },
    { key: "customerNumber", label: "Customer Number", type: "text" },
    { key: "countryCode", label: "Country code", type: "text", default: "US" },
    { key: "senderId", label: "Sender ID (app name)", type: "text", default: "ScalePadAtlas" },
    { key: "environment", label: "Environment", type: "select", options: ["sandbox", "production"], default: "sandbox" },
  ] },
  tdsynnex: { label: "TD SYNNEX (Reseller)", fields: [
    { key: "baseUrl", label: "API base URL", type: "text", default: "https://api.tdsynnex.com" },
    { key: "apiKey", label: "API key", type: "text" },
    { key: "apiSecret", label: "API secret", type: "password" },
    { key: "customerNumber", label: "Customer / account number", type: "text" },
    { key: "country", label: "Country", type: "text", default: "US" },
    { key: "orderPath", label: "Create-order path", type: "text", default: "/v1/orders" },
    { key: "paPath", label: "Price/availability path", type: "text", default: "/v1/price-availability" },
  ] },
  dh: { label: "D&H Distributing", fields: [
    { key: "baseUrl", label: "API base URL", type: "text", default: "https://api.dandh.com" },
    { key: "apiKey", label: "API key / username", type: "text" },
    { key: "apiSecret", label: "API secret / password", type: "password" },
    { key: "accountNumber", label: "Account number", type: "text" },
    { key: "orderPath", label: "Create-order path", type: "text", default: "/v1/orders" },
    { key: "paPath", label: "Price/availability path", type: "text", default: "/v1/priceavailability" },
  ] },
};

let quoterDistributors = [];

function elx(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.appendChild(c);
  return n;
}

async function saveDistributors() {
  await send({ type: "QUOTER_SAVE_DISTRIBUTORS", distributors: quoterDistributors });
}

function renderApiFields(dist, host) {
  host.innerHTML = "";
  const def = DIST_ADAPTER_DEFS[dist.api.adapter] || DIST_ADAPTER_DEFS.none;
  if (!def.fields.length) return;
  const grid = elx("div", { class: "row", style: "margin-top:8px" });
  for (const f of def.fields) {
    const wrap = elx("div", {});
    wrap.appendChild(elx("label", { text: f.label }));
    let input;
    if (f.type === "select") {
      input = elx("select", {});
      for (const o of f.options) {
        const opt = elx("option", { value: o, text: o });
        if ((dist.api[f.key] || f.default) === o) opt.selected = true;
        input.appendChild(opt);
      }
    } else {
      input = elx("input", { type: f.type === "password" ? "password" : "text", autocomplete: "off" });
      input.value = dist.api[f.key] != null ? dist.api[f.key] : (f.default || "");
      if (dist.api[f.key] == null && f.default) dist.api[f.key] = f.default;
    }
    input.addEventListener("input", () => { dist.api[f.key] = input.value; });
    input.addEventListener("change", () => { dist.api[f.key] = input.value; });
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
  host.appendChild(grid);
}

function renderDistCards() {
  const wrap = document.getElementById("distCards");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!quoterDistributors.length) {
    wrap.appendChild(elx("div", { class: "hint", text: "No distributors yet." }));
    return;
  }
  quoterDistributors.forEach((dist, idx) => {
    if (!dist.api) dist.api = { adapter: "none", enabled: false };
    const card = elx("div", { style: "border:1px solid #d8dbe6;border-radius:10px;padding:12px 14px;margin:10px 0;background:#fafbff" });

    const head = elx("div", { style: "display:flex;align-items:center;gap:10px;margin-bottom:8px" });
    head.appendChild(elx("div", { style: "font-weight:700;font-size:14px;flex:1", text: dist.name || "(unnamed)" }));
    head.appendChild(elx("button", { class: "btn ghost", type: "button", text: "Remove", onclick: async () => {
      quoterDistributors.splice(idx, 1); await saveDistributors(); renderDistCards();
    } }));
    card.appendChild(head);

    const top = elx("div", { class: "row" });
    const emailWrap = elx("div", {});
    emailWrap.appendChild(elx("label", { text: "Order email" }));
    const emailIn = elx("input", { type: "text", autocomplete: "off" });
    emailIn.value = dist.email || "";
    emailIn.addEventListener("input", () => { dist.email = emailIn.value; });
    emailWrap.appendChild(emailIn);

    const adWrap = elx("div", {});
    adWrap.appendChild(elx("label", { text: "Order API" }));
    const adSel = elx("select", {});
    for (const [v, d] of Object.entries(DIST_ADAPTER_DEFS)) {
      const o = elx("option", { value: v, text: d.label });
      if ((dist.api.adapter || "none") === v) o.selected = true;
      adSel.appendChild(o);
    }
    adWrap.appendChild(adSel);
    top.appendChild(emailWrap);
    top.appendChild(adWrap);
    card.appendChild(top);

    const aliasWrap = elx("div", { style: "margin-top:8px" });
    aliasWrap.appendChild(elx("label", { text: "Also match these supplier names (comma-separated, exactly as shown on Quoter items)" }));
    const aliasIn = elx("input", { type: "text", autocomplete: "off", placeholder: "e.g. Ingram, Ingram Micro Inc" });
    aliasIn.value = (dist.aliases || []).join(", ");
    aliasIn.addEventListener("input", () => { dist.aliases = aliasIn.value.split(",").map((x) => x.trim()).filter(Boolean); });
    aliasWrap.appendChild(aliasIn);
    aliasWrap.appendChild(elx("div", { class: "hint", text: "Atlas already matches close names (e.g. \u201cIngram\u201d ↔ \u201cIngram Micro\u201d). Add aliases for ones that differ, e.g. \u201cTech Data\u201d for a TD SYNNEX entry." }));
    card.appendChild(aliasWrap);

    const fieldsHost = elx("div", {});
    card.appendChild(fieldsHost);
    renderApiFields(dist, fieldsHost);

    const footer = elx("div", { style: "display:flex;align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap" });
    const enableLbl = elx("label", { style: "display:flex;align-items:center;gap:6px;margin:0;font-weight:600" });
    const enableChk = elx("input", { type: "checkbox" });
    enableChk.checked = !!dist.api.enabled;
    enableChk.disabled = (dist.api.adapter || "none") === "none";
    enableChk.addEventListener("change", () => { dist.api.enabled = enableChk.checked; });
    enableLbl.appendChild(enableChk);
    enableLbl.appendChild(document.createTextNode("Enable API ordering"));

    const testBtn = elx("button", { class: "btn ghost", type: "button", text: "Test connection" });
    const saveBtn = elx("button", { class: "btn", type: "button", text: "Save" });
    const msg = elx("div", { class: "msg", style: "flex-basis:100%" });

    testBtn.disabled = (dist.api.adapter || "none") === "none";
    testBtn.addEventListener("click", async () => {
      msg.textContent = "Testing…"; msg.className = "msg";
      try {
        const r = await send({ type: "DIST_TEST", adapterType: dist.api.adapter, cfg: dist.api });
        msg.textContent = r.summary || "OK"; msg.className = "msg ok";
      } catch (e) { msg.textContent = e.message; msg.className = "msg err"; }
    });
    saveBtn.addEventListener("click", async () => {
      try { await saveDistributors(); msg.textContent = "Saved."; msg.className = "msg ok"; renderDistCards(); }
      catch (e) { msg.textContent = e.message; msg.className = "msg err"; }
    });

    adSel.addEventListener("change", () => {
      dist.api.adapter = adSel.value;
      if (adSel.value === "none") dist.api.enabled = false;
      renderApiFields(dist, fieldsHost);
      enableChk.disabled = adSel.value === "none";
      testBtn.disabled = adSel.value === "none";
      if (adSel.value === "none") enableChk.checked = false;
    });

    footer.appendChild(enableLbl);
    footer.appendChild(testBtn);
    footer.appendChild(saveBtn);
    footer.appendChild(msg);
    card.appendChild(footer);

    wrap.appendChild(card);
  });
}

if (document.getElementById("dsAdd")) {
  document.getElementById("dsAdd").addEventListener("click", async () => {
    const name = document.getElementById("dsName").value.trim();
    const email = document.getElementById("dsEmail").value.trim();
    if (!name) { flash("dsMsg", "Enter a distributor name.", false); return; }
    const idx = quoterDistributors.findIndex((d) => (d.name || "").toLowerCase() === name.toLowerCase());
    if (idx >= 0) { quoterDistributors[idx].email = email; }
    else quoterDistributors.push({ name, email, aliases: [], api: { adapter: "none", enabled: false } });
    await saveDistributors();
    document.getElementById("dsName").value = ""; document.getElementById("dsEmail").value = "";
    renderDistCards();
    flash("dsMsg", "Saved.", true);
  });
}

(async function initQuoterPane() {
  try {
    const s = await chrome.storage.local.get({ quoter: { distributors: [] } });
    const q = s.quoter || {};
    quoterDistributors = (Array.isArray(q.distributors) ? q.distributors : []).map((d) => ({
      name: d.name || "", email: d.email || "", aliases: Array.isArray(d.aliases) ? d.aliases : [], api: d.api || { adapter: "none", enabled: false },
    }));
    renderDistCards();
  } catch (e) { /* ignore */ }
})();

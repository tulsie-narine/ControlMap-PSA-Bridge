/**
 * ScalePad Atlas — content script.
 * 1. Grammarly-style floating launcher + context-aware panel (question /
 *    action-item / global contexts).
 * 2. Inline "Create Ticket" button on the Update Action Item sidebar (kept
 *    from earlier versions) + ticket modal.
 */

(() => {
  const BTN_CLASS = "cm-psa-bridge-btn";
  const TITLE_RE = /Action Item:\s*(AI-\d+)/i;
  const ACCENT = "#7c5cff";

  // ── Product detection (multi-product) ────────────────────────────────────
  // Atlas rides different ScalePad products with different mascots + panels.
  let PRODUCT = null;
  function detectProduct() {
    const h = location.hostname;
    const p = (location.pathname.replace(/\/+$/, "") || "/");
    if (h === "app.scalepad.com") {
      if (p === "/account/home") return null;             // don't show on the account home
      return { id: "lifecycle", name: "Lifecycle Manager", mascotDir: "assets/mascot-green", panel: "empty", idleScene: "stand", idleLoop: true, hoverScene: "secure" };
    }
    if (/\.app\.ctrlmap\.com$/i.test(h)) {
      return { id: "controlmap", name: "ControlMap", mascotDir: "assets/mascot", panel: "controlmap", idleScene: "stand", idleLoop: true, hoverScene: "secure" };
    }
    if (/\.quoter\.com$/i.test(h) || h === "admin.scalepad.com") {
      return { id: "quoter", name: "Quoter", mascotDir: "assets/mascot-quoter", panel: "empty", idleScene: "stand", idleLoop: true, hoverScene: null };
    }
    if (/\.backupradar\.com$/i.test(h)) {
      return { id: "backupradar", name: "Backup Radar", mascotDir: "assets/mascot-backupradar", panel: "empty", idleScene: "stand", idleLoop: true, hoverScene: null };
    }
    return null;
  }

  function subdomain() {
    const m = location.hostname.match(/^([^.]+)\.app\.ctrlmap\.com$/i);
    return m ? m[1] : null;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error("No response from extension background."));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    });
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  // ===================== context detection =====================

  function detectContext() {
    const params = new URLSearchParams(location.search);
    const qc = params.get("questionCode");
    const panels = findPanels();
    if (panels.length) return { kind: "action-item", code: panels[panels.length - 1].code, questionCode: qc };
    if (qc) return { kind: "question", questionCode: qc };
    return { kind: "global" };
  }

  function findPanels() {
    const results = [];
    document.querySelectorAll(".sidebar-title, [class*='sidebar-title']").forEach((titleEl) => {
      const m = (titleEl.textContent || "").match(TITLE_RE);
      if (!m) return;
      const root = titleEl.closest(".sidebar, [class*='p-sidebar']") || titleEl.parentElement;
      if (!root) return;
      results.push({ root, code: m[1].toUpperCase() });
    });
    return results;
  }

  // ===================== inline ticket button =====================

  function findActionButton(root) {
    const btns = Array.from(root.querySelectorAll("button"));
    return btns.find((b) => /update action item/i.test(b.textContent || "")) || null;
  }

  function injectTicketButtons() {
    if (!PRODUCT || PRODUCT.id !== "controlmap") return;
    for (const { root, code } of findPanels()) {
      if (root.querySelector(`.${BTN_CLASS}`)) continue;
      const anchor = findActionButton(root);
      if (!anchor) continue;
      const btn = el("button", { type: "button", class: BTN_CLASS, text: "Create Ticket" });
      btn.style.cssText = `margin-left:8px;padding:8px 14px;border:none;border-radius:6px;background:${ACCENT};color:#fff;font:inherit;font-weight:600;cursor:pointer;vertical-align:middle`;
      btn.addEventListener("click", () => openTicketModal(code));
      anchor.insertAdjacentElement("afterend", btn);
    }
  }

  // ===================== shared styles =====================

  const SHEET = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
    .card { background: #fff; color: #1c2030; border-radius: 14px; box-shadow: 0 18px 48px rgba(10,12,40,.28); }
    label { font-size: 12px; font-weight: 600; color: #555c70; display: block; margin-bottom: 4px; }
    label .req { color: #c0392b; }
    input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccd0dd; border-radius: 6px; font-size: 13px; background: #fff; color: #1c2030; }
    textarea { min-height: 140px; resize: vertical; }
    .btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #ccd0dd; background: #fff; cursor: pointer; font-size: 13px; }
    .btn.primary { background: var(--atlas-accent, #7c5cff); border-color: var(--atlas-accent, #7c5cff); color: #fff; font-weight: 600; }
    .btn.primary:hover { background: var(--atlas-accent-2, #4f8df9); border-color: var(--atlas-accent-2, #4f8df9); }
    .btn.small { padding: 4px 10px; font-size: 12px; }
    .btn[disabled] { opacity: .55; cursor: default; }
    .status { font-size: 13px; padding: 9px 12px; border-radius: 6px; margin: 6px 0; }
    .status.err { background: #fde8e8; color: #9b1c1c; }
    .status.ok { background: #e7f7ed; color: #046c4e; }
    .status.info { background: #eef1ff; color: #3f4bb8; }
    .cm-toast { margin: 6px 0; padding: 8px 12px; border-radius: 8px; background: #eef1ff; font-size: 12.5px; transition: opacity .55s ease; }
    .cm-toast.fade { opacity: 0; }
    .cm-toast.ok  { background: #e7f7ed; }
    .cm-toast.warn{ background: #fef3df; }
    .cm-toast.err { background: #fde8e8; }
    .cm-toast-label { font-weight: 600; color: #3f4bb8; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .cm-toast.ok  .cm-toast-label { color: #046c4e; }
    .cm-toast.warn .cm-toast-label { color: #92600a; }
    .cm-toast.err .cm-toast-label { color: #9b1c1c; }
    .cm-toast-track { height: 6px; border-radius: 4px; background: rgba(124,92,255,.18); overflow: hidden; }
    .cm-toast-bar { height: 100%; width: 0; background: var(--atlas-accent, #7c5cff); border-radius: 4px; transition: width .45s ease; }
    .cm-toast.ok .cm-toast-bar { background: #10b981; }
    .cm-toast-bar.indeterminate { width: 38%; animation: cmIndet 1.05s infinite ease-in-out; }
    @keyframes cmIndet { 0% { margin-left: -38%; } 100% { margin-left: 100%; } }
    .cm-spin { width: 13px; height: 13px; border: 2px solid rgba(63,75,184,.3); border-top-color: #3f4bb8; border-radius: 50%; animation: cmSpin .7s linear infinite; }
    @keyframes cmSpin { to { transform: rotate(360deg); } }
    .hint { font-size: 11px; color: #8a90a5; margin-top: 3px; }
    .chip { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; vertical-align: middle; }
    .chip.pass { background: #e7f7ed; color: #046c4e; }
    .chip.fail { background: #fde8e8; color: #9b1c1c; }
    .chip.warning { background: #fef3df; color: #92600a; }
    .chip.error, .chip.not-licensed { background: #eef0f6; color: #555c70; }

    /* ── Quoter procurement ── */
    .qbar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
    .qbar .grow { flex:1; }
    .qcount { font-size:11px; color:#8a90a5; }
    .qlist { border:1px solid #e6e8f0; border-radius:10px; overflow:hidden; margin:8px 0; }
    .qrow { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid #f0f1f8; cursor:pointer; }
    .qrow:last-child { border-bottom:none; }
    .qrow:hover { background:#f7f8fc; }
    .qrow input[type=checkbox] { width:15px; height:15px; flex-shrink:0; margin:0; cursor:pointer; }
    .qrow .qmain { flex:1; min-width:0; }
    .qrow .qname { font-size:12.5px; font-weight:600; color:#1c2030; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .qrow .qmeta { font-size:11px; color:#8a90a5; margin-top:1px; }
    .qrow .qtot { font-size:12px; font-weight:700; color:#1c2030; flex-shrink:0; }
    .dgroup { border:1px solid #e6e8f0; border-radius:10px; margin:10px 0; overflow:hidden; }
    .dghead { display:flex; align-items:center; gap:8px; padding:10px 12px; background:linear-gradient(to right,#f7f8fc,#f3f4fa); border-bottom:1px solid #e6e8f0; }
    .dghead .dgname { font-size:13px; font-weight:700; color:#1c2030; }
    .dghead .dgmail { font-size:11px; color:#8a90a5; margin-left:auto; }
    .dghead .dgmail.miss { color:#b91c1c; font-weight:600; }
    .ditems { width:100%; border-collapse:collapse; font-size:11.5px; }
    .ditems th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#8a90a5; padding:6px 12px; border-bottom:1px solid #eef0f6; }
    .ditems td { padding:6px 12px; border-bottom:1px solid #f3f4fa; color:#3d4460; vertical-align:top; }
    .ditems td.qy { width:42px; font-weight:700; color:#1c2030; }
    .ditems td.mpn { width:120px; font-family:ui-monospace,Menlo,monospace; font-size:11px; color:#555c70; }
    .ditems tr:last-child td { border-bottom:none; }
    .dgfoot { padding:10px 12px; display:flex; gap:8px; flex-wrap:wrap; border-top:1px solid #eef0f6; background:#fafbff; }
    .epreview { width:100%; min-height:150px; font-family:ui-monospace,Menlo,monospace; font-size:11px; margin-top:8px; }
    .epreview-rich { width:100%; min-height:140px; max-height:320px; overflow:auto; border:1px solid #ccd0dd; border-radius:6px; padding:10px 12px; background:#fff; margin-top:8px; }
    .epreview-rich table { border-collapse:collapse; width:100%; }
    .epreview-rich:focus { outline:2px solid #c9bfff; }
  `;

  // ===================== launcher + panel =====================

  // Per-product theme (accent colours). ControlMap keeps the default purple.
  const ATLAS_THEMES = {
    quoter: { accent: "#3a4a73", accent2: "#2a3146", soft: "#eef1f7", softBorder: "#c7d0e4" },
  };
  function applyAtlasTheme(host) {
    const t = ATLAS_THEMES[(PRODUCT && PRODUCT.id) || ""] ||
      { accent: "#7c5cff", accent2: "#4f8df9", soft: "#f5f2ff", softBorder: "#d9d2ff" };
    host.style.setProperty("--atlas-accent", t.accent);
    host.style.setProperty("--atlas-accent-2", t.accent2);
    host.style.setProperty("--atlas-soft", t.soft);
    host.style.setProperty("--atlas-soft-border", t.softBorder);
  }

  let launcherHost = null, panelOpen = false, panelBody = null, panelContextLabel = null, panelClientBar = null;
  let mascot = null;

  function buildLauncher() {
    if (launcherHost || !PRODUCT) return;
    launcherHost = document.createElement("div");
    const yDrop = (PRODUCT && PRODUCT.id === "quoter") ? 50 : 0;  // Quoter: nudge Atlas + panel down
    launcherHost.style.cssText = "position:fixed;right:18px;bottom:" + (18 - yDrop) + "px;z-index:2147483646;touch-action:none;";
    applyAtlasTheme(launcherHost);
    document.documentElement.appendChild(launcherHost);
    applySavedLauncherPos();
    const shadow = launcherHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHEET + `
      .fab { width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer;
             background: linear-gradient(135deg, var(--atlas-accent, #7c5cff), var(--atlas-accent-2, #4f8df9)); color: #fff;
             box-shadow: 0 6px 20px rgba(80,60,220,.45); display: flex; align-items: center; justify-content: center; }
      .fab:hover { transform: scale(1.06); }
      .fab-wrap { display:flex; align-items:flex-end; justify-content:flex-end; }
      .fab svg { width: 24px; height: 24px; }

      /* ── Panel shell ── */
      .panel { position: fixed; right: 30px; bottom: 120px; width: 760px; max-height: min(87.5vh, 800px);
               display: none; flex-direction: column; overflow: hidden; }
      .panel.open { display: flex; }

      /* ── Panel header ── */
      .phead { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px;
               border-bottom: 1px solid #e6e8f0; background: #fafbff; flex-shrink: 0; }
      .phead .title { font-size: 14px; font-weight: 700; }
      .phead .ctx { font-size: 11px; color: #8a90a5; }

      /* ── Panel body ── */
      .pbody { padding: 14px 16px; overflow-y: auto; flex: 1; }

      /* ── Integration card ── */
      .icl { border: 1px solid #e6e8f0; border-radius: 12px; margin-bottom: 14px; overflow: hidden; }
      .ich { display: flex; align-items: center; justify-content: space-between; padding: 11px 16px;
             background: linear-gradient(to right, #f7f8fc, #f3f4fa); border-bottom: 1px solid #e6e8f0; }
      .iname { font-weight: 700; font-size: 13px; color: #1c2030; }

      /* ── Dashboard two-column ── */
      .dash { display: flex; min-height: 0; }

      /* Left: score column */
      .score-col { width: 200px; flex-shrink: 0; padding: 18px 14px 14px;
                   display: flex; flex-direction: column; align-items: center;
                   border-right: 1px solid #eef0f6; background: #fafbff; }
      .score-label { font-size: 10px; font-weight: 700; color: #8a90a5; text-transform: uppercase;
                     letter-spacing: .06em; margin-bottom: 12px; }
      .sleg { width: 100%; margin-top: 14px; }
      .sleg-row { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 0; color: #3d4460; }
      .sleg-sq { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
      .sleg-count { margin-left: auto; font-weight: 700; font-size: 11px; color: #1c2030; }

      /* Right: check accordion */
      .check-col { flex: 1; overflow-y: auto; }

      /* Accordion row */
      .crow { border-bottom: 1px solid #f0f1f8; }
      .crow:last-child { border-bottom: none; }
      .ctop { display: flex; align-items: center; gap: 9px; padding: 10px 14px; cursor: pointer; transition: background .12s; user-select: none; }
      .ctop:hover { background: #f6f7fc; }
      .crow.expanded .ctop { background: #f3f4fa; }
      .cexp { padding: 6px 14px 14px 32px; display: none; border-top: 1px solid #eef0f6; background: #fafbff; }
      .crow.expanded .cexp { display: block; }
      .carrow { margin-left: auto; color: #c0c6da; font-size: 9px; flex-shrink: 0; transition: transform .15s; }
      .crow.expanded .carrow { transform: rotate(180deg); }

      /* Status dot */
      .sdot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
      .sdot.pass { background: #059669; }
      .sdot.fail { background: #dc2626; }
      .sdot.warning { background: #d97706; }
      .sdot.not-licensed { background: #c8cfe0; }
      .sdot.error { background: #f97316; }
      .sdot.pending { background: #dde1ef; }

      /* Check title / id */
      .ctitle { font-size: 12.5px; font-weight: 600; color: #1c2030; flex: 1; min-width: 0;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cid { font-size: 10px; color: #aab0c4; flex-shrink: 0; }

      /* Collapsible integration / section cards */
      .ich { cursor: pointer; user-select: none; }
      .ich:hover { background: linear-gradient(to right, #eff0f7, #ebecf5); }
      .toggle-arrow { color: #c0c6da; font-size: 10px; margin-left: 6px; flex-shrink: 0;
                      transition: transform .18s; display: inline-block; }
      .icl.collapsed .toggle-arrow { transform: rotate(-90deg); }
      .icl.collapsed .dash { display: none; }
      .icl.collapsed .psa-body { display: none; }

      /* Group headers */
      .cgroup-hdr { display: flex; align-items: center; gap: 6px; padding: 6px 14px 4px;
                    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
                    color: #8a90a5; background: #f7f8fc; border-bottom: 1px solid #eef0f6;
                    border-top: 1px solid #eef0f6; position: sticky; top: 0; z-index: 1; }
      .cgroup-hdr:first-child { border-top: none; }
      .cgroup-hdr .gh-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .cgroup-hdr .gh-count { margin-left: auto; font-size: 10px; color: #aab0c4; }

      /* Expanded content */
      .cres { font-size: 12px; margin-bottom: 4px; }
      .cdet { font-size: 11px; color: #555c70; margin: 4px 0 0 0; padding-left: 16px; }
      .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

      .gear { border: none; background: none; cursor: pointer; color: #8a90a5; font-size: 15px; }
      .settings-btn { border: 1px solid var(--atlas-soft-border, #d9d2ff); background: var(--atlas-soft, #f5f2ff); color: var(--atlas-accent, #7c5cff); font-size: 12px;
                      font-weight: 700; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
      .settings-btn:hover { background: var(--atlas-accent, #7c5cff); color: #fff; border-color: var(--atlas-accent, #7c5cff); }

      /* ── Active client bar ── */
      .pclient { display: none; align-items: center; gap: 10px; padding: 8px 18px;
                 background: linear-gradient(to right, #f0eeff, #eef1ff);
                 border-bottom: 1px solid #ddd7ff; flex-shrink: 0; }
      .pclient.show { display: flex; }
      .pclient-icon { width: 28px; height: 28px; border-radius: 8px; background: #7c5cff;
                      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .pclient-icon svg { width: 15px; height: 15px; }
      .pclient-label { font-size: 10px; font-weight: 600; text-transform: uppercase;
                       letter-spacing: .07em; color: #9b88e0; line-height: 1; }
      .pclient-name { font-size: 13px; font-weight: 800; color: #3a2880; line-height: 1.2; margin-top: 1px; }
      .pclient-pill { margin-left: auto; font-size: 10px; font-weight: 700; color: #7c5cff;
                      background: #ede9ff; border: 1px solid #c9bfff; border-radius: 20px;
                      padding: 2px 9px; white-space: nowrap; }
    `;
    shadow.appendChild(style);

    const panel = el("div", { class: "panel card" });
    if (yDrop) panel.style.bottom = (120 - yDrop) + "px";
    const head = el("div", { class: "phead" });
    const titleWrap = el("div", {}, [
      el("div", { class: "title", text: "ScalePad Atlas" }),
      (panelContextLabel = el("div", { class: "ctx", text: "" })),
    ]);
    head.appendChild(titleWrap);
    head.appendChild(el("div", { style: "display:flex;gap:8px;align-items:center" }, [
      el("button", { class: "settings-btn", html: "&#9881;&#xFE0E; Settings", title: "Open settings", onclick: () => send({ type: "OPEN_OPTIONS" }).catch(() => {}) }),
      el("button", { class: "gear", text: "✕", title: "Close", onclick: () => togglePanel(false) }),
    ]));
    panel.appendChild(head);
    panelClientBar = el("div", { class: "pclient" }, [
      el("div", { class: "pclient-icon", html: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' }),
      el("div", {}, [
        el("div", { class: "pclient-label", text: "Active client" }),
        el("div", { class: "pclient-name", text: "" }),
      ]),
      el("span", { class: "pclient-pill", text: "Focus" }),
    ]);
    panel.appendChild(panelClientBar);
    panelBody = el("div", { class: "pbody" });
    panel.appendChild(panelBody);

    shadow.appendChild(panel);

    // Animated mascot launcher (falls back to a shield FAB if the sprite layer is unavailable)
    const fabWrap = el("div", { class: "fab-wrap" });
    shadow.appendChild(fabWrap);
    if (typeof createMascot === "function") {
      try {
        mascot = createMascot({ shadowRoot: shadow, mount: fabWrap, height: 96, assetDir: PRODUCT.mascotDir, idleScene: PRODUCT.idleScene, idleLoop: PRODUCT.idleLoop, hoverScene: PRODUCT.hoverScene, onClick: () => { if (launcherDragged) { launcherDragged = false; return; } togglePanel(!panelOpen); } });
        mascot.setState("idle");
        // Any click anywhere keeps him awake (resets the 30s/60s drowse→sleep timers).
        document.addEventListener("click", () => mascot && mascot.bump(), true);
      } catch { mascot = null; }
    }
    if (!mascot) {
      const fab = el("button", { class: "fab", title: "ScalePad Atlas",
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>',
        onclick: () => togglePanel(!panelOpen) });
      fabWrap.appendChild(fab);
    }
    launcherHost._panel = panel;
    enableLauncherDrag(fabWrap);
  }

  // ── Drag-to-move launcher (so Atlas can be moved out of the way) ──
  let launcherDragged = false;
  const POS_KEY = "scalepadAtlas.launcherPos";

  function applySavedLauncherPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const { left, top } = JSON.parse(raw);
      if (typeof left === "number" && typeof top === "number") {
        const w = 120, h = 150; // approx launcher footprint for clamping
        const x = Math.max(0, Math.min(left, window.innerWidth - w));
        const y = Math.max(0, Math.min(top, window.innerHeight - h));
        launcherHost.style.left = x + "px";
        launcherHost.style.top = y + "px";
        launcherHost.style.right = "auto";
        launcherHost.style.bottom = "auto";
      }
    } catch { /* ignore bad saved value */ }
  }

  function enableLauncherDrag(handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;

    // Only the mascot (handle) starts a drag — not the panel.
    (handle || launcherHost).addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      const r = launcherHost.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      // switch from right/bottom anchoring to left/top so we can move freely
      launcherHost.style.left = ox + "px";
      launcherHost.style.top = oy + "px";
      launcherHost.style.right = "auto";
      launcherHost.style.bottom = "auto";
    });

    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      const w = launcherHost.offsetWidth || 120, h = launcherHost.offsetHeight || 150;
      const nx = Math.max(0, Math.min(ox + dx, window.innerWidth - w));
      const ny = Math.max(0, Math.min(oy + dy, window.innerHeight - h));
      launcherHost.style.left = nx + "px";
      launcherHost.style.top = ny + "px";
    });

    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        launcherDragged = true;   // suppress the click that would otherwise open the panel
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: parseFloat(launcherHost.style.left) || 0,
            top: parseFloat(launcherHost.style.top) || 0,
          }));
        } catch { /* storage may be blocked */ }
      }
    });
  }

  function togglePanel(open) {
    panelOpen = open;
    launcherHost._panel.classList.toggle("open", open);
    if (open) renderPanel();
  }

  function chip(status) {
    return `<span class="chip ${status}">${status.toUpperCase()}</span>`;
  }

  // ===================== donut chart helpers =====================

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function donutPath(cx, cy, R, ir, sa, ea) {
    if (ea - sa >= 360) ea = sa + 359.9999;
    const o1 = polarToCartesian(cx, cy, R, sa);
    const o2 = polarToCartesian(cx, cy, R, ea);
    const i1 = polarToCartesian(cx, cy, ir, ea);
    const i2 = polarToCartesian(cx, cy, ir, sa);
    const lg = (ea - sa) > 180 ? 1 : 0;
    return `M${o1.x.toFixed(2)} ${o1.y.toFixed(2)} A${R} ${R} 0 ${lg} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)} L${i1.x.toFixed(2)} ${i1.y.toFixed(2)} A${ir} ${ir} 0 ${lg} 0 ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}Z`;
  }

  function buildDonutHTML(checks) {
    const palette = [
      { key: "pass",        color: "#059669", label: "Pass"        },
      { key: "fail",        color: "#dc2626", label: "Fail"        },
      { key: "warning",     color: "#d97706", label: "Warning"     },
      { key: "not-licensed",color: "#c8cfe0", label: "Not licensed"},
      { key: "error",       color: "#f97316", label: "Error"       },
      { key: "pending",     color: "#e4e7f3", label: "Not run"     },
    ];

    const counts = { pass: 0, fail: 0, warning: 0, "not-licensed": 0, error: 0, pending: 0 };
    for (const c of checks) {
      const s = c.lastRun?.result?.status;
      if (s && s in counts) counts[s]++;
      else counts.pending++;
    }

    const total = checks.length || 1;
    const runnable = total - counts["not-licensed"] - counts.pending;
    const pct = runnable > 0 ? Math.round((counts.pass / runnable) * 100) : null;

    const CX = 60, CY = 60, R = 52, IR = 35;
    let angle = 0;
    let paths = "";
    for (const seg of palette) {
      const n = counts[seg.key] || 0;
      if (!n) continue;
      const span = (n / total) * 360;
      paths += `<path d="${donutPath(CX, CY, R, IR, angle, angle + span)}" fill="${seg.color}" stroke="none"/>`;
      angle += span;
    }
    if (!paths) {
      paths = `<circle cx="${CX}" cy="${CY}" r="${(R + IR) / 2}" fill="none" stroke="#e4e7f3" stroke-width="${R - IR}"/>`;
    }

    const scoreText = pct !== null ? `${pct}%` : "—";
    const subText   = pct !== null ? `${counts.pass} of ${runnable}` : "not run yet";

    let legend = "";
    for (const seg of palette) {
      const n = counts[seg.key] || 0;
      if (!n) continue;
      legend += `<div class="sleg-row"><span class="sleg-sq" style="background:${seg.color}"></span>${seg.label}<span class="sleg-count">${n}</span></div>`;
    }

    return `
      <div class="score-label">Check Results</div>
      <svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${CX}" cy="${CY}" r="${(R + IR) / 2}" fill="none" stroke="#eef0f6" stroke-width="${R - IR}"/>
        ${paths}
        <text x="${CX}" y="${CY - 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#1c2030"
              font-family="-apple-system,Segoe UI,Roboto,sans-serif">${scoreText}</text>
        <text x="${CX}" y="${CY + 15}" text-anchor="middle" font-size="9.5" fill="#8a90a5"
              font-family="-apple-system,Segoe UI,Roboto,sans-serif">${subText}</text>
      </svg>
      <div class="sleg">${legend}</div>
    `;
  }

  // ===================== panel rendering =====================

  async function renderPanel() {
    // Quoter gets its own procurement panel.
    if (PRODUCT && PRODUCT.id === "quoter") { renderQuoterPanel(); return; }
    // Other non-ControlMap products: empty panel for now (tools coming soon).
    if (!PRODUCT || PRODUCT.id !== "controlmap") {
      panelContextLabel.textContent = PRODUCT ? PRODUCT.name : "";
      if (panelClientBar) panelClientBar.style.display = "none";
      panelBody.innerHTML = "";
      panelBody.appendChild(el("div", { class: "status info", text: `${PRODUCT ? PRODUCT.name : "Atlas"} — tools coming soon.` }));
      return;
    }
    if (panelClientBar) panelClientBar.style.display = "";
    const ctx = detectContext();
    panelContextLabel.textContent =
      ctx.kind === "question"    ? `Question context — ${ctx.questionCode}` :
      ctx.kind === "action-item" ? `Action item — ${ctx.code}`              : "Overview";
    panelBody.innerHTML = "";
    panelBody.appendChild(el("div", { class: "status info", text: "Loading…" }));

    let data;
    try {
      data = await send({ type: "GET_PANEL_CONTEXT", subdomain: subdomain(), questionCode: ctx.questionCode || null });
    } catch (err) {
      panelBody.innerHTML = "";
      panelBody.appendChild(el("div", { class: "status err", text: err.message }));
      return;
    }
    panelBody.innerHTML = "";

    if (data.clientError) {
      panelBody.appendChild(el("div", { class: "status err", text: data.clientError }));
    }
    // Update client bar
    if (panelClientBar) {
      if (data.client) {
        const nameEl = panelClientBar.querySelector(".pclient-name");
        if (nameEl) nameEl.textContent = data.client.name || "";
        panelClientBar.classList.add("show");
      } else {
        panelClientBar.classList.remove("show");
      }
    }

    // --- action item context: ticket shortcut ---
    if (ctx.kind === "action-item") {
      const b = el("button", { class: "btn primary", text: `Create PSA ticket for ${ctx.code}`, onclick: () => { togglePanel(false); openTicketModal(ctx.code); } });
      b.style.margin = "8px 0";
      panelBody.appendChild(b);
    }

    // --- question banner ---
    if (data.question) {
      const q = el("div", { class: "status info" });
      q.innerHTML = `<b>${data.question.code}</b>${data.question.text ? " — " + data.question.text.slice(0, 180) : ""}`;
      panelBody.appendChild(q);
      panelBody.appendChild(el("div", { class: "hint", text: "Checks below are ranked by relevance to this question. Results are proposed — nothing is written to ControlMap without your confirmation." }));
    }

    // --- PSA ticket evidence card (only when PSA is configured) ---
    if (data.client && data.psaConfigured) {
      const PSA_ICONS = { autotask: "assets/autotask.svg", connectwise: "assets/connectwise.svg", halo: "assets/halopsa.svg" };
      const psaIcon = PSA_ICONS[data.psa] || null;
      const psaName = data.psaName || "PSA";

      const teBox = el("div", { class: "icl collapsed" });

      // header
      const teNameWrap = el("div", { style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0" });
      if (psaIcon) {
        const psaLogo = el("img", { src: chrome.runtime.getURL(psaIcon), alt: psaName, style: "height:20px;max-width:110px;object-fit:contain" });
        psaLogo.addEventListener("error", () => psaLogo.remove());
        teNameWrap.appendChild(psaLogo);
      }
      teNameWrap.appendChild(el("div", { class: "iname", text: psaName }));
      teNameWrap.appendChild(el("div", { style: "font-size:11px;color:#8a90a5;margin-left:4px", text: "Ticket evidence" }));

      const teArrow = el("span", { class: "toggle-arrow", text: "▼" });
      const teIch = el("div", { class: "ich", style: "display:flex;align-items:center" }, [teNameWrap, teArrow]);
      teBox.appendChild(teIch);

      // body (lazy-built on first expand)
      const teBody = el("div", { class: "psa-body", style: "padding:12px 14px" });
      let teBuilt = false;
      teIch.addEventListener("click", () => {
        teBox.classList.toggle("collapsed");
        if (!teBox.classList.contains("collapsed") && !teBuilt) {
          teBuilt = true;
          buildTicketEvidenceSection(teBody, ctx);
        }
      });
      teBox.appendChild(teBody);
      panelBody.appendChild(teBox);
    }

    // --- integrations (only show enabled + fully configured ones) ---
    const enabled = data.integrations.filter((i) => i.enabled && i.configured);
    for (const integ of enabled) {
      const box = el("div", { class: "icl" }); // start expanded

      // ── Integration header (clickable to collapse) ──
      const nameWrap = el("div", { style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0" });
      if (integ.icon) {
        const logo = el("img", { src: chrome.runtime.getURL(integ.icon), alt: integ.name, style: "height:20px;max-width:110px;object-fit:contain" });
        logo.addEventListener("error", () => logo.remove());
        nameWrap.appendChild(logo);
      }
      nameWrap.appendChild(el("div", { class: "iname", text: integ.name }));
      const toggleArrow = el("span", { class: "toggle-arrow", text: "▼" });
      const runAllBtn = el("button", { class: "btn small", text: "Run all", onclick: async (e) => {
        e.stopPropagation();
        e.target.disabled = true; e.target.textContent = "Running…";
        mascot?.setState("working");
        try { await send({ type: "RUN_ALL_CHECKS", id: integ.id }); mascot?.setState("success"); renderPanel(); }
        catch (err) { e.target.textContent = "Failed"; mascot?.setState("error"); }
      }});
      const premapBtn = el("button", { class: "btn small primary", text: "Attach pre-mapped", title: "Run all checks and attach evidence per the pre-map configured in Settings", onclick: (e) => {
        e.stopPropagation();
        attachPremapped(integ, e.target);
      }});
      const ich = el("div", { class: "ich", style: "display:flex;align-items:center;gap:8px" }, [
        nameWrap, runAllBtn, premapBtn, toggleArrow,
      ]);
      ich.addEventListener("click", (e) => {
        if (runAllBtn.contains(e.target) || premapBtn.contains(e.target)) return;
        box.classList.toggle("collapsed");
      });
      box.appendChild(ich);

      // ── Dashboard: two-column layout ──
      const dash = el("div", { class: "dash" });

      const checks = (ctx.kind === "question")
        ? integ.checks.filter((c) => c.score > 0).concat(integ.checks.filter((c) => c.score === 0)).slice(0, 8)
        : integ.checks;

      // Left: donut chart
      const scoreCol = el("div", { class: "score-col" });
      scoreCol.innerHTML = buildDonutHTML(checks);
      dash.appendChild(scoreCol);

      // Right: accordion check list — grouped by status
      const checkCol = el("div", { class: "check-col" });
      const groups = [
        { key: "pass",        label: "Pass",        color: "#059669" },
        { key: "warning",     label: "Warning",     color: "#d97706" },
        { key: "fail",        label: "Fail",        color: "#dc2626" },
        { key: "not-licensed",label: "Not Licensed",color: "#c8cfe0" },
        { key: "error",       label: "Error",       color: "#f97316" },
        { key: "pending",     label: "Not Run",     color: "#dde1ef" },
      ];
      const buckets = Object.fromEntries(groups.map((g) => [g.key, []]));
      for (const c of checks) {
        const s = c.lastRun?.result?.status || "pending";
        (buckets[s] || buckets["pending"]).push(c);
      }
      for (const g of groups) {
        const items = buckets[g.key];
        if (!items.length) continue;
        const hdr = el("div", { class: "cgroup-hdr" });
        hdr.innerHTML = `<span class="gh-dot" style="background:${g.color}"></span>${g.label}<span class="gh-count">${items.length}</span>`;
        checkCol.appendChild(hdr);
        for (const c of items) checkCol.appendChild(renderCheck(integ, c, ctx));
      }
      dash.appendChild(checkCol);

      box.appendChild(dash);
      panelBody.appendChild(box);
    }
  }

  // ===================== attach pre-mapped evidence (bulk) =====================

  async function attachPremapped(integ, btn) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Attaching…";
    mascot?.setState("working");

    // toast with progress bar, inserted under the integration header
    if (integ._premapNote && integ._premapNote.isConnected) integ._premapNote.remove();
    const toast = el("div", { class: "cm-toast" });
    const label = el("div", { class: "cm-toast-label" }, [
      el("span", { class: "cm-spin" }),
      el("span", { text: "Running checks & attaching evidence…" }),
    ]);
    const track = el("div", { class: "cm-toast-track" });
    const bar = el("div", { class: "cm-toast-bar indeterminate" });
    track.appendChild(bar);
    toast.appendChild(label);
    toast.appendChild(track);
    btn.closest(".ich")?.insertAdjacentElement("afterend", toast);
    integ._premapNote = toast;

    try {
      const res = await send({ type: "ATTACH_PREMAP", id: integ.id, integrationId: integ.id, subdomain: subdomain(), rerun: true });
      const ok = !res.failed;
      bar.classList.remove("indeterminate");
      bar.style.width = "100%";
      toast.classList.add(ok ? "ok" : "warn");
      label.innerHTML = `${ok ? "✓" : "⚠"} Attached ${res.attached}/${res.total} for ${res.client?.name || "client"}${res.failed ? ` · ${res.failed} failed` : ""}`;
      btn.textContent = ok ? "Attached ✓" : "Done";
      mascot?.setState(ok ? "success" : "error");

      // fade out, then clean up and refresh the dashboard so new statuses show
      setTimeout(() => toast.classList.add("fade"), 1700);
      setTimeout(() => {
        if (toast.isConnected) toast.remove();
        integ._premapNote = null;
        btn.disabled = false; btn.textContent = orig;
        renderPanel();
      }, 2450);
    } catch (err) {
      bar.classList.remove("indeterminate");
      bar.style.width = "100%";
      toast.classList.add("err");
      label.innerHTML = `✕ ${err.message}`;
      btn.disabled = false; btn.textContent = orig;
      mascot?.setState("error");
    }
  }

  // ===================== Quoter — distributor procurement =====================

  let quoterState = {
    quotes: null, distributors: [], selected: new Set(),
    filter: { range: "all", from: "", to: "", search: "" },
  };

  async function renderQuoterPanel() {
    panelContextLabel.textContent = "Quoter";
    if (panelClientBar) panelClientBar.style.display = "none";
    panelBody.innerHTML = "";

    const box = el("div", { class: "icl" });
    const nameWrap = el("div", { style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0" }, [
      el("div", { class: "iname", text: "Distributor Procurement" }),
      el("div", { style: "font-size:11px;color:#8a90a5;margin-left:4px", text: "Order won-quote items by distributor" }),
    ]);
    const arrow = el("span", { class: "toggle-arrow", text: "▼" });
    const ich = el("div", { class: "ich", style: "display:flex;align-items:center" }, [nameWrap, arrow]);
    ich.addEventListener("click", () => box.classList.toggle("collapsed"));
    box.appendChild(ich);

    const body = el("div", { class: "psa-body", style: "padding:12px 14px" });
    box.appendChild(body);
    panelBody.appendChild(box);

    // Second function: Executive Report (collapsed by default)
    const box2 = el("div", { class: "icl collapsed" });
    const nameWrap2 = el("div", { style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0" }, [
      el("div", { class: "iname", text: "Executive Report" }),
      el("div", { style: "font-size:11px;color:#8a90a5;margin-left:4px", text: "Funnel, win rate & product profitability → PDF" }),
    ]);
    const arrow2 = el("span", { class: "toggle-arrow", text: "▼" });
    const ich2 = el("div", { class: "ich", style: "display:flex;align-items:center" }, [nameWrap2, arrow2]);
    const body2 = el("div", { class: "psa-body", style: "padding:12px 14px" });
    let built2 = false;
    ich2.addEventListener("click", () => {
      box2.classList.toggle("collapsed");
      if (!box2.classList.contains("collapsed") && !built2) { built2 = true; buildExecReportSection(body2); }
    });
    box2.appendChild(ich2);
    box2.appendChild(body2);
    panelBody.appendChild(box2);

    await buildProcurementSection(body);
  }

  // ===================== Executive Report =====================
  const execState = { range: "30", from: "", to: "", currency: "USD", cap: 50 };

  function execBounds() {
    const now = new Date();
    const days = { "7": 7, "30": 30, "90": 90, "365": 365 }[execState.range];
    if (days) return { after: new Date(now.getTime() - days * 864e5).toISOString(), before: null };
    if (execState.range === "custom") {
      return {
        after: execState.from ? new Date(execState.from + "T00:00:00Z").toISOString() : null,
        before: execState.to ? new Date(execState.to + "T23:59:59Z").toISOString() : null,
      };
    }
    return { after: null, before: null };
  }

  const WON_STAGES = ["won-accepted", "won-fulfilled", "won-ordered"];
  const isWon = (s) => WON_STAGES.includes(s);
  const isLost = (s) => s === "lost" || s === "expired";
  const isDraft = (s) => s === "draft";

  function buildExecReportSection(container) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "hint", text: "Pick a period and generate a formatted PDF: pipeline funnel, win rate, revenue, by-salesperson, and product profitability. Product detail is read from each quote (slower for large ranges)." }));

    const bar = el("div", { class: "qbar", style: "margin-top:8px" });
    const rangeSel = el("select", { style: "max-width:150px" });
    [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"], ["all", "All time"], ["custom", "Custom range…"]]
      .forEach(([v, t]) => { const o = el("option", { value: v, text: t }); if (v === execState.range) o.selected = true; rangeSel.appendChild(o); });
    const curIn = el("input", { type: "text", value: execState.currency, style: "max-width:70px", title: "Currency label" });
    const capSel = el("select", { style: "max-width:150px", title: "Max quotes to scrape for product detail" });
    [["25", "25 quotes"], ["50", "50 quotes"], ["100", "100 quotes"], ["200", "200 quotes"]]
      .forEach(([v, t]) => { const o = el("option", { value: v, text: "Products: " + t }); if (v === String(execState.cap)) o.selected = true; capSel.appendChild(o); });
    bar.appendChild(rangeSel); bar.appendChild(curIn); bar.appendChild(capSel);
    container.appendChild(bar);

    const fromIn = el("input", { type: "date", style: "max-width:140px", value: execState.from });
    const toIn = el("input", { type: "date", style: "max-width:140px", value: execState.to });
    const customWrap = el("div", { class: "qbar", style: "gap:6px;margin:6px 0" }, [el("span", { class: "qcount", text: "from" }), fromIn, el("span", { class: "qcount", text: "to" }), toIn]);
    customWrap.style.display = execState.range === "custom" ? "flex" : "none";
    container.appendChild(customWrap);

    const genBtn = el("button", { class: "btn primary", text: "Generate report (PDF)", style: "margin-top:6px" });
    container.appendChild(genBtn);
    const prog = el("div", { class: "qcount", style: "margin-top:8px" });
    container.appendChild(prog);

    rangeSel.addEventListener("change", () => { execState.range = rangeSel.value; customWrap.style.display = rangeSel.value === "custom" ? "flex" : "none"; });
    curIn.addEventListener("input", () => { execState.currency = curIn.value.trim() || "USD"; });
    capSel.addEventListener("change", () => { execState.cap = parseInt(capSel.value, 10) || 50; });
    fromIn.addEventListener("change", () => { execState.from = fromIn.value; });
    toIn.addEventListener("change", () => { execState.to = toIn.value; });

    genBtn.addEventListener("click", () => generateExecReport(genBtn, prog));
  }

  async function generateExecReport(btn, prog) {
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "Working…";
    mascot && mascot.setState("working");
    try {
      const { after, before } = execBounds();
      prog.textContent = "Fetching quotes…";
      const r = await send({ type: "QUOTER_REPORT_QUOTES", after, before });
      const quotes = r.quotes || [];

      // Aggregate funnel / status / by-user (quote-level, from API)
      const won = quotes.filter((q) => isWon(q.stage));
      const lost = quotes.filter((q) => isLost(q.stage));
      const pending = quotes.filter((q) => !isWon(q.stage) && !isLost(q.stage));
      const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

      const byUserMap = new Map();
      for (const q of won) {
        const key = q.owner || "—";
        if (!byUserMap.has(key)) byUserMap.set(key, { owner: key, oneTime: 0, recurringAnnual: 0, margin: 0 });
        const u = byUserMap.get(key);
        u.oneTime += q.oneTime || 0;
        u.recurringAnnual += q.recurringAnnual || 0;
        u.margin += (q.oneTimeMargin || 0) + (q.recurringAnnualMargin || 0);
      }
      const byUser = [...byUserMap.values()].sort((a, b) => (b.oneTime + b.recurringAnnual) - (a.oneTime + a.recurringAnnual)).slice(0, 8);

      // Product detail — scrape quotes (cap). Won first so accepted products are covered.
      const cap = execState.cap || 50;
      const scrapeList = [...won, ...pending, ...lost].slice(0, cap);
      const quotedAgg = new Map(); // name -> { qty, ext }
      const acceptedAgg = new Map(); // name -> { qty, ext, margin }
      let scraped = 0, scrapeErr = 0;
      for (const q of scrapeList) {
        prog.textContent = `Reading product detail ${scraped + 1}/${scrapeList.length}…`;
        try {
          const items = await fetchQuoteLineItems(q.id);
          const wonQ = isWon(q.stage);
          for (const it of items) {
            const nm = (it.name || "(item)").slice(0, 60);
            const qn = parseInt(it.qty, 10) || 0;
            const ext = it.ext || 0;
            const qa = quotedAgg.get(nm) || { qty: 0, ext: 0, margin: 0, hasMargin: false };
            qa.qty += qn; qa.ext += ext;
            if (it.marginVal != null) { qa.margin += it.marginVal; qa.hasMargin = true; }
            quotedAgg.set(nm, qa);
            if (wonQ) {
              const aa = acceptedAgg.get(nm) || { qty: 0, ext: 0, margin: 0, hasMargin: false };
              aa.qty += qn; aa.ext += ext;
              if (it.marginVal != null) { aa.margin += it.marginVal; aa.hasMargin = true; }
              acceptedAgg.set(nm, aa);
            }
          }
        } catch (e) { scrapeErr++; }
        scraped++;
      }
      const topN = (mp) => [...mp.entries()].map(([name, v]) => ({ name, qty: v.qty, ext: v.ext, margin: v.hasMargin ? v.margin : null }))
        .sort((a, b) => b.ext - a.ext).slice(0, 8);

      const winDen = won.length + lost.length;
      const report = {
        meta: {
          tenant: location.hostname.replace(/\.quoter\.com$/i, ""),
          generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
          currency: execState.currency || "USD",
          from: after ? after.slice(0, 10) : "(all)",
          to: before ? before.slice(0, 10) : new Date().toISOString().slice(0, 10),
          scope: "Primary quotes",
        },
        kpis: {
          totalQuotes: quotes.length, won: won.length, lost: lost.length, pending: pending.length,
          winRatePct: winDen ? Math.round((won.length / winDen) * 100) : null,
          wonOneTime: sum(won, (q) => q.oneTime), wonRecurringAnnual: sum(won, (q) => q.recurringAnnual),
          pipelineValue: sum(pending, (q) => (q.oneTime || 0) + (q.recurringAnnual || 0)),
        },
        funnel: [
          { label: "Created", count: quotes.length },
          { label: "Sent to customer", count: quotes.filter((q) => !isDraft(q.stage)).length },
          { label: "Won", count: won.length },
          { label: "Lost / expired", count: lost.length },
        ],
        byUser,
        productsQuoted: topN(quotedAgg),
        productsAccepted: topN(acceptedAgg),
        productsNote: `Product detail read from ${scraped} quote(s)${scrapeErr ? ` (${scrapeErr} unreadable)` : ""}${quotes.length > cap ? `; capped at ${cap} of ${quotes.length}` : ""}.`,
      };

      prog.textContent = "Rendering PDF…";
      const pdf = await send({ type: "EXEC_REPORT_PDF", report, filename: `exec-quote-report-${report.meta.from}_${report.meta.to}.pdf` });
      downloadBase64(pdf.base64, pdf.filename, "application/pdf");
      mascot && mascot.setState("success");
      prog.textContent = `Done — ${quotes.length} quotes, ${won.length} won. PDF downloaded.`;
    } catch (err) {
      mascot && mascot.setState("error");
      prog.textContent = "";
      prog.appendChild(el("div", { class: "status err", text: err.message }));
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  function downloadBase64(b64, filename, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
    const a = el("a", { href: url, download: filename || "download" });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  // Normalize Quoter's supplier label. Items render as "Ingram (SKU: 2Z0479)" —
  // the distributor name plus that line's supplier SKU. Split them so every
  // Ingram line groups under one distributor.
  function splitSupplier(raw) {
    raw = (raw || "").replace(/^\s*Supplier:\s*/i, "").replace(/\s+/g, " ").trim();
    let name = raw, sku = "";
    const m = raw.match(/^(.*?)\s*\(SKU:\s*([^)]*)\)\s*$/i);
    if (m) { name = m[1].trim(); sku = m[2].trim(); }
    else if (/^SKU:\s*/i.test(raw)) { sku = raw.replace(/^SKU:\s*/i, "").trim(); name = ""; }
    return { name, sku };
  }

  function rangeBounds() {
    const f = quoterState.filter;
    const now = new Date();
    const days = { "7": 7, "30": 30, "90": 90, "365": 365 }[f.range];
    if (days) return { wonAfter: new Date(now.getTime() - days * 864e5).toISOString(), wonBefore: null };
    if (f.range === "custom") {
      return {
        wonAfter: f.from ? new Date(f.from + "T00:00:00Z").toISOString() : null,
        wonBefore: f.to ? new Date(f.to + "T23:59:59Z").toISOString() : null,
      };
    }
    return { wonAfter: null, wonBefore: null };
  }

  function filteredQuotes() {
    let qs = quoterState.quotes || [];
    const { wonAfter, wonBefore } = rangeBounds();
    if (wonAfter)  qs = qs.filter((q) => q.wonAt && q.wonAt >= wonAfter);
    if (wonBefore) qs = qs.filter((q) => q.wonAt && q.wonAt <= wonBefore);
    const term = (quoterState.filter.search || "").trim().toLowerCase();
    if (term) {
      qs = qs.filter((q) => {
        const ref = (q.customNumber || ("#" + q.number)) + "";
        return [(q.name || ""), (q.client || ""), ref].join(" ").toLowerCase().includes(term);
      });
    }
    return qs;
  }

  async function buildProcurementSection(container) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "status info", text: "Loading…" }));

    let ctx;
    try { ctx = await send({ type: "QUOTER_CONTEXT" }); }
    catch (err) { container.innerHTML = ""; container.appendChild(el("div", { class: "status err", text: err.message })); return; }
    quoterState.distributors = ctx.distributors || [];
    container.innerHTML = "";

    if (!ctx.apiConfigured) {
      container.appendChild(el("div", { class: "status info", text: "Add your ScalePad Platform API key in Settings to load won quotes." }));
      container.appendChild(el("button", { class: "btn primary", text: "Open settings", style: "margin-top:8px", onclick: () => send({ type: "OPEN_OPTIONS" }).catch(() => {}) }));
      return;
    }

    // Filter bar: won-date range + search + load
    const fbar = el("div", { class: "qbar" });
    const rangeSel = el("select", { style: "max-width:150px" });
    [["all", "All time"], ["7", "Won last week"], ["30", "Won last 30 days"], ["90", "Won last 90 days"], ["365", "Won last 12 months"], ["custom", "Custom range…"]]
      .forEach(([v, t]) => { const o = el("option", { value: v, text: t }); if (v === quoterState.filter.range) o.selected = true; rangeSel.appendChild(o); });
    const fromIn = el("input", { type: "date", style: "max-width:140px", value: quoterState.filter.from });
    const toIn = el("input", { type: "date", style: "max-width:140px", value: quoterState.filter.to });
    const customWrap = el("div", { class: "qbar", style: "gap:6px;margin:0" }, [el("span", { class: "qcount", text: "from" }), fromIn, el("span", { class: "qcount", text: "to" }), toIn]);
    customWrap.style.display = quoterState.filter.range === "custom" ? "flex" : "none";
    const loadBtn = el("button", { class: "btn primary", text: quoterState.quotes ? "Reload" : "Load won quotes" });
    fbar.appendChild(rangeSel);
    fbar.appendChild(loadBtn);
    container.appendChild(fbar);
    container.appendChild(customWrap);

    const searchIn = el("input", { type: "text", placeholder: "Search by customer or quote name…", value: quoterState.filter.search, style: "margin:8px 0" });
    container.appendChild(searchIn);

    const status = el("div", { class: "qcount", text: "" });
    container.appendChild(status);

    const listHost = el("div", {});
    const groupHost = el("div", {});
    container.appendChild(listHost);
    container.appendChild(groupHost);

    rangeSel.addEventListener("change", () => {
      quoterState.filter.range = rangeSel.value;
      customWrap.style.display = rangeSel.value === "custom" ? "flex" : "none";
    });
    fromIn.addEventListener("change", () => { quoterState.filter.from = fromIn.value; });
    toIn.addEventListener("change", () => { quoterState.filter.to = toIn.value; });
    searchIn.addEventListener("input", () => {
      quoterState.filter.search = searchIn.value;
      if (quoterState.quotes) renderQuoteList(listHost, groupHost, status);
    });

    loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true; loadBtn.textContent = "Loading…"; status.textContent = "";
      groupHost.innerHTML = "";
      mascot && mascot.setState("working");
      try {
        const { wonAfter, wonBefore } = rangeBounds();
        const r = await send({ type: "QUOTER_LIST_WON_QUOTES", wonAfter, wonBefore });
        quoterState.quotes = r.quotes || [];
        quoterState.selected = new Set();
        mascot && mascot.setState("success");
        renderQuoteList(listHost, groupHost, status);
      } catch (err) {
        mascot && mascot.setState("error");
        listHost.innerHTML = "";
        listHost.appendChild(el("div", { class: "status err", text: err.message }));
      } finally {
        loadBtn.disabled = false; loadBtn.textContent = "Reload";
      }
    });

    if (quoterState.quotes) renderQuoteList(listHost, groupHost, status);
  }

  function renderQuoteList(listHost, groupHost, status) {
    listHost.innerHTML = "";
    const total = (quoterState.quotes || []).length;
    const quotes = filteredQuotes();
    if (!total) {
      listHost.appendChild(el("div", { class: "status info", text: "No won quotes found for this range." }));
      status.textContent = "";
      return;
    }
    status.textContent = quotes.length === total ? (total + " won quote(s)") : (quotes.length + " of " + total + " won quote(s)");
    if (!quotes.length) {
      listHost.appendChild(el("div", { class: "status info", text: "No quotes match your search." }));
      return;
    }

    const buildBtn = el("button", { class: "btn primary", text: "Build distributor orders (" + quoterState.selected.size + ")" });
    buildBtn.disabled = quoterState.selected.size === 0;

    const list = el("div", { class: "qlist" });
    for (const q of quotes) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = quoterState.selected.has(q.id);
      const ref = q.customNumber || ("#" + q.number);
      const meta = [q.client, q.wonAt ? new Date(q.wonAt).toLocaleDateString() : null].filter(Boolean).join(" · ");
      const totTxt = q.total != null ? (q.currency + " " + q.total) : "";
      const row = el("div", { class: "qrow" }, [
        cb,
        el("div", { class: "qmain" }, [
          el("div", { class: "qname", text: ref + " — " + (q.name || "Quote") }),
          el("div", { class: "qmeta", text: meta }),
        ]),
        el("div", { class: "qtot", text: totTxt }),
      ]);
      row.addEventListener("click", (e) => {
        if (e.target !== cb) cb.checked = !cb.checked;
        if (cb.checked) quoterState.selected.add(q.id); else quoterState.selected.delete(q.id);
        buildBtn.disabled = quoterState.selected.size === 0;
        buildBtn.textContent = "Build distributor orders (" + quoterState.selected.size + ")";
      });
      list.appendChild(row);
    }
    listHost.appendChild(list);

    buildBtn.addEventListener("click", () => buildOrders(groupHost, buildBtn));
    listHost.appendChild(buildBtn);
  }

  // Fetch a quote's line items from the server-rendered detail view (same-origin,
  // uses the logged-in session). The public Quoter API does not expose line items.
  async function fetchQuoteLineItems(publicId) {
    const url = location.origin + "/admin/quotes/view_by_public_id/" + encodeURIComponent(publicId);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = doc.querySelectorAll("tbody.quote-table-body tr.line-item");
    const items = [];
    rows.forEach((row) => {
      const titleEl = row.querySelector(".line-item-title");
      const qtyEl = row.querySelector(".line-item-quantity");
      const totalEl = row.querySelector(".line-item-total");
      const name = (titleEl ? titleEl.textContent : "").replace(/\s+/g, " ").trim();
      const qty = (qtyEl ? qtyEl.textContent : "").replace(/\s+/g, " ").trim();
      const money2num = (t) => { const m = String(t || "").replace(/[^0-9.\-]/g, ""); const v = parseFloat(m); return Number.isFinite(v) ? v : 0; };
      const ext = money2num(totalEl ? totalEl.textContent : "");
      let mfr = "", code = "", supplier = "", supplierSku = "", marginVal = null;
      let n = row.nextElementSibling;
      while (n && !n.classList.contains("line-item")) {
        if (n.classList.contains("manufacturer-row")) {
          const c = n.querySelector(".offset-manufacturer-content");
          const t = (c ? c.textContent : "").replace(/\s+/g, " ").trim();
          const m = t.match(/^(.*?)\s*\(Code:\s*([^)]*)\)\s*$/i);
          if (m) { mfr = m[1].trim(); code = m[2].trim(); } else if (t) { mfr = t; }
        }
        if (n.classList.contains("supplier-row")) {
          const c = n.querySelector(".offset-supplier-content");
          const sp = splitSupplier(c ? c.textContent : "");
          supplier = sp.name; supplierSku = sp.sku;
        }
        const rt = n.textContent || "";
        if (/Line Item Margin/i.test(rt)) {
          const mm = rt.match(/\$\s*(-?[\d,]+(?:\.\d+)?)/);
          if (mm) marginVal = parseFloat(mm[1].replace(/,/g, ""));
        }
        n = n.nextElementSibling;
      }
      if (name || code) items.push({ name, qty, mfr, code, supplier, supplierSku, ext, marginVal });
    });
    return items;
  }

  const UNSET_DIST = "— No distributor on item —";

  async function buildOrders(groupHost, btn) {
    const ids = [...quoterState.selected];
    if (!ids.length) return;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Fetching line items…";
    groupHost.innerHTML = "";
    groupHost.appendChild(el("div", { class: "status info", text: "Reading quotes…" }));
    mascot && mascot.setState("working");

    const byId = new Map((quoterState.quotes || []).map((q) => [q.id, q]));
    const errors = [];
    const groups = new Map(); // distributorLower -> { name, quotes: Map(quoteId -> {quote, items:[]}) }

    for (const id of ids) {
      const q = byId.get(id);
      try {
        const items = await fetchQuoteLineItems(id);
        for (const it of items) {
          const key = (it.supplier || "").trim() || UNSET_DIST;
          const gk = key.toLowerCase();
          if (!groups.has(gk)) groups.set(gk, { name: key, quotes: new Map() });
          const g = groups.get(gk);
          if (!g.quotes.has(id)) g.quotes.set(id, { quote: q, items: [] });
          g.quotes.get(id).items.push(it);
        }
      } catch (err) {
        errors.push((q ? (q.customNumber || "#" + q.number) : id) + ": " + err.message);
      }
    }

    groupHost.innerHTML = "";
    if (errors.length) {
      groupHost.appendChild(el("div", { class: "status err", html: "Some quotes couldn't be read:<br>" + errors.map((e) => "• " + e).join("<br>") }));
    }
    if (!groups.size) {
      groupHost.appendChild(el("div", { class: "status info", text: "No line items found on the selected quotes." }));
      mascot && mascot.setState("error");
      btn.disabled = false; btn.textContent = orig;
      return;
    }

    const dists = quoterState.distributors || [];
    const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const findDist = (name) => {
      const n = norm(name);
      if (!n) return null;
      return dists.find((x) => {
        const names = [x.name, ...((x.aliases) || [])].map(norm).filter(Boolean);
        return names.some((m) => m === n || (m.length >= 3 && n.length >= 3 && (m.includes(n) || n.includes(m))));
      }) || null;
    };

    const ordered = [...groups.values()].sort((a, b) => ((a.name === UNSET_DIST) - (b.name === UNSET_DIST)) || a.name.localeCompare(b.name));
    for (const g of ordered) {
      const isUnset = g.name === UNSET_DIST;
      const drec = isUnset ? null : findDist(g.name);
      const email = drec ? (drec.email || "") : "";
      const apiEnabled = !!(drec && drec.apiEnabled);
      let itemCount = 0; for (const e of g.quotes.values()) itemCount += e.items.length;
      const card = el("div", { class: "dgroup" });

      card.appendChild(el("div", { class: "dghead" }, [
        el("div", { class: "dgname", text: g.name + "  (" + itemCount + ")" }),
        el("div", { class: "dgmail" + (!isUnset && !email ? " miss" : ""), text: isUnset ? "items with no supplier set in Quoter" : (email || "no email — add in Settings") }),
      ]));

      const table = el("table", { class: "ditems" });
      table.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", { text: "Qty" }), el("th", { text: "MPN" }), el("th", { text: "Item" }), el("th", { text: "Quote" }),
      ])]));
      const tb = el("tbody", {});
      for (const entry of g.quotes.values()) {
        const ref = entry.quote ? (entry.quote.customNumber || "#" + entry.quote.number) : "";
        for (const it of entry.items) {
          const mpnCell = el("td", { class: "mpn" });
          mpnCell.appendChild(el("div", { text: it.code || "—" }));
          if (it.supplierSku) mpnCell.appendChild(el("div", { style: "color:#aab0c4", text: "SKU " + it.supplierSku }));
          tb.appendChild(el("tr", {}, [
            el("td", { class: "qy", text: it.qty || "1" }),
            mpnCell,
            el("td", { text: it.name || "(item)" }),
            el("td", { text: ref }),
          ]));
        }
      }
      table.appendChild(tb);
      card.appendChild(table);

      const foot = el("div", { class: "dgfoot" });
      const composeBtn = el("button", { class: "btn primary", text: "Draft order email" });
      if (isUnset) composeBtn.disabled = true;
      foot.appendChild(composeBtn);
      let paBtn = null, submitBtn = null;
      if (apiEnabled) {
        paBtn = el("button", { class: "btn", text: "Check price & availability" });
        submitBtn = el("button", { class: "btn", text: "Submit PO via " + g.name + " API", title: "Pushes the order to the distributor API — asks for confirmation first" });
        foot.appendChild(paBtn);
        foot.appendChild(submitBtn);
      } else if (!isUnset) {
        const hasAdapter = drec && drec.apiAdapter && drec.apiAdapter !== "none";
        foot.appendChild(el("button", {
          class: "btn",
          text: hasAdapter ? "Push to portal — enable API in Settings" : "Push to portal — configure API",
          title: hasAdapter ? "An API is configured for this distributor — tick \u201cEnable API ordering\u201d and Save in Settings" : "Add this distributor's API in Settings to enable order push",
          onclick: () => send({ type: "OPEN_OPTIONS" }).catch(() => {}),
        }));
      }
      card.appendChild(foot);

      const apiHost = el("div", {});
      card.appendChild(apiHost);
      const previewHost = el("div", {});
      card.appendChild(previewHost);

      if (paBtn) paBtn.addEventListener("click", async () => {
        const o = paBtn.textContent; paBtn.disabled = true; paBtn.textContent = "Checking…";
        try {
          const r = await send({ type: "DIST_PA", name: g.name, items: distLines(g) });
          apiHost.innerHTML = "";
          apiHost.appendChild(el("div", { class: "hint", text: "Live price & availability from " + g.name + ":" }));
          const t = el("table", { class: "ditems" });
          t.appendChild(el("thead", {}, [el("tr", {}, [el("th", { text: "SKU / MPN" }), el("th", { text: "Price" }), el("th", { text: "Availability" })])]));
          const availText = (x) => {
            if (x.found === false) return "Product not found";
            if (x.available === 0 || x.available === "0") return "0 — out of stock";
            if (x.available === true) return "In stock";
            if (x.available == null) return "In stock";
            return String(x.available) + " in stock";
          };
          const tb = el("tbody", {});
          for (const x of (r.result || [])) {
            const avCell = el("td", { text: availText(x) });
            if (x.found === false || x.available === 0) avCell.style.color = "#b91c1c";
            tb.appendChild(el("tr", {}, [
              el("td", { class: "mpn", text: x.distSku || x.mpn || x.key || "—" }),
              el("td", { text: x.price != null ? (x.currency + " " + x.price) : "—" }),
              avCell,
            ]));
          }
          t.appendChild(tb); apiHost.appendChild(t);
        } catch (e) { apiHost.innerHTML = ""; apiHost.appendChild(el("div", { class: "status err", text: e.message })); }
        finally { paBtn.disabled = false; paBtn.textContent = o; }
      });

      if (submitBtn) submitBtn.addEventListener("click", () => {
        const lines = distLines(g); const po = genPo(g);
        apiHost.innerHTML = "";
        const bar = el("div", { class: "status info", html: "<b>Submit PO to " + esc(g.name) + "?</b> This places a real order via the distributor API — " + lines.length + " line(s), PO <b>" + esc(po) + "</b>." });
        apiHost.appendChild(bar);
        const act = el("div", { class: "qbar", style: "margin-top:8px" });
        const yes = el("button", { class: "btn primary", text: "Yes, place order" });
        const no = el("button", { class: "btn", text: "Cancel", onclick: () => { apiHost.innerHTML = ""; } });
        yes.addEventListener("click", async () => {
          yes.disabled = true; no.disabled = true; yes.textContent = "Submitting…"; mascot && mascot.setState("working");
          try {
            const r = await send({ type: "DIST_CREATE_ORDER", name: g.name, order: { poNumber: po, notes: "Placed via ScalePad Atlas", lines } });
            mascot && mascot.setState("success");
            apiHost.innerHTML = "";
            apiHost.appendChild(el("div", { class: "status ok", html: "✓ Order submitted to " + esc(g.name) + ". Distributor order #: <b>" + esc(r.orderNumber || "(pending)") + "</b>" }));
          } catch (e) {
            mascot && mascot.setState("error");
            bar.className = "status err"; bar.textContent = e.message;
            yes.disabled = false; no.disabled = false; yes.textContent = "Yes, place order";
          }
        });
        act.appendChild(yes); act.appendChild(no); apiHost.appendChild(act);
      });

      composeBtn.addEventListener("click", () => {
        const mail = buildOrderEmail(g, email);
        previewHost.innerHTML = "";
        previewHost.appendChild(el("div", { class: "hint", text: mail.to ? ("To: " + mail.to + "  ·  Subject: " + mail.subject) : "No distributor email on file — set one in Settings, then the draft can open pre-addressed." }));
        const rich = el("div", { class: "epreview-rich", html: buildOrderEmailHtml(g) });
        rich.setAttribute("contenteditable", "true");
        rich.setAttribute("spellcheck", "false");
        previewHost.appendChild(rich);
        previewHost.appendChild(el("div", { class: "hint", text: "Editable. “Copy formatted” keeps the bold + table when you paste into your email." }));
        const acts = el("div", { class: "qbar", style: "margin-top:8px" });
        const copyRich = el("button", { class: "btn primary", text: "Copy formatted" });
        copyRich.addEventListener("click", async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({
              "text/html": new Blob([rich.innerHTML], { type: "text/html" }),
              "text/plain": new Blob([rich.innerText], { type: "text/plain" }),
            })]);
            copyRich.textContent = "Copied ✓"; setTimeout(() => { copyRich.textContent = "Copy formatted"; }, 1500);
          } catch (e) {
            try { await navigator.clipboard.writeText(rich.innerText); copyRich.textContent = "Copied (plain) ✓"; setTimeout(() => { copyRich.textContent = "Copy formatted"; }, 1500); } catch (e2) {}
          }
        });
        const mailBtn = el("a", { class: "btn", text: "Open in email client", target: "_blank", title: "Opens a plain-text draft — email clients can't take formatting via mailto. Use Copy formatted for the rich version." });
        mailBtn.setAttribute("href", "mailto:" + encodeURIComponent(mail.to || "") + "?subject=" + encodeURIComponent(mail.subject) + "&body=" + encodeURIComponent(mail.bodyText));
        acts.appendChild(copyRich); acts.appendChild(mailBtn);
        previewHost.appendChild(acts);
      });

      groupHost.appendChild(card);
    }
    mascot && mascot.setState("success");
    btn.disabled = false; btn.textContent = orig;
  }

  function distLines(g) {
    const out = [];
    for (const entry of g.quotes.values()) {
      for (const it of entry.items) {
        out.push({ mpn: it.code || "", distSku: it.supplierSku || "", quantity: parseInt(it.qty, 10) || 1, name: it.name || "" });
      }
    }
    return out;
  }

  function genPo(g) {
    const refs = [...g.quotes.values()].map((e) => e.quote ? (e.quote.customNumber || ("Q" + e.quote.number)) : "Q").join("-");
    return ("ATL-" + refs).slice(0, 30);
  }

  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildOrderEmailHtml(g) {
    const th = 'style="text-align:left;padding:6px 10px;border:1px solid #d9dbe6;font-size:12px;background:#f3f4fa"';
    const td = 'style="padding:6px 10px;border:1px solid #e6e8f0;font-size:13px;vertical-align:top"';
    let rows = "";
    const shipBlocks = [];
    for (const entry of g.quotes.values()) {
      const q = entry.quote;
      const ref = q ? (q.customNumber || ("#" + q.number)) : "";
      for (const it of entry.items) {
        rows += "<tr>"
          + "<td " + td + "><strong>" + esc(it.qty || "1") + "</strong></td>"
          + "<td " + td + ">" + esc(it.code || "—") + "</td>"
          + "<td " + td + ">" + esc(it.supplierSku || "—") + "</td>"
          + "<td " + td + ">" + esc(it.name || "(item)") + "</td>"
          + "<td " + td + ">" + esc(ref) + "</td>"
          + "</tr>";
      }
      const ship = q && q.shipping;
      if (ship) {
        const who = [q.shippingOrg, q.shippingName].filter(Boolean).join(" / ");
        const addr = [ship.address_line_1, ship.address_line_2, [ship.city, ship.state_prov_code, ship.postal_code].filter(Boolean).join(" "), ship.country_code].filter(Boolean).join(", ");
        if (addr) shipBlocks.push("<strong>" + esc(ref) + "</strong> ship to: " + esc((who ? who + " — " : "") + addr));
      }
    }
    let html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1c2030">';
    html += "<p>Hello <strong>" + esc(g.name) + "</strong>,</p>";
    html += "<p>Please process the following order:</p>";
    html += '<table style="border-collapse:collapse;width:100%">'
      + "<thead><tr>"
      + "<th " + th + ">Qty</th><th " + th + ">MPN</th><th " + th + ">Disty SKU</th><th " + th + ">Item</th><th " + th + ">Quote</th>"
      + "</tr></thead><tbody>" + rows + "</tbody></table>";
    if (shipBlocks.length) html += '<p style="margin-top:12px"><strong>Ship to</strong><br>' + shipBlocks.join("<br>") + "</p>";
    html += "<p>Thank you.</p></div>";
    return html;
  }

  function buildOrderEmail(g, email) {
    const subject = "Purchase Order — " + g.name;
    const lines = [];
    lines.push("Hello " + g.name + ",");
    lines.push("");
    lines.push("Please process the following order:");
    lines.push("");
    for (const entry of g.quotes.values()) {
      const q = entry.quote;
      const ref = q ? (q.customNumber || ("Quote #" + q.number)) : "Quote";
      const client = q && q.client ? (" — " + q.client) : "";
      lines.push(ref + client);
      for (const it of entry.items) {
        const idtag = [it.code ? ("MPN " + it.code) : "", it.supplierSku ? ("Disty SKU " + it.supplierSku) : ""].filter(Boolean).join(", ");
        lines.push("  " + (it.qty || "1") + " x " + (it.name || "(item)") + (idtag ? ("  [" + idtag + "]") : ""));
      }
      const ship = q && q.shipping;
      if (ship) {
        const who = [q.shippingOrg, q.shippingName].filter(Boolean).join(" / ");
        const addr = [ship.address_line_1, ship.address_line_2, [ship.city, ship.state_prov_code, ship.postal_code].filter(Boolean).join(" "), ship.country_code].filter(Boolean).join(", ");
        if (addr) lines.push("  Ship to: " + (who ? who + " — " : "") + addr);
      }
      lines.push("");
    }
    lines.push("Thank you.");
    return { subject, bodyText: lines.join("\n"), to: email || "" };
  }

  // ===================== accordion check row =====================

  function renderCheck(integ, c, ctx) {
    const row = el("div", { class: "crow" });
    const last = c.lastRun;
    const status = last?.result?.status || "pending";

    // ── Top bar (always visible) ──
    const top = el("div", { class: "ctop" });
    const dotEl    = el("span", { class: `sdot ${status}` });
    const titleEl  = el("span", { class: "ctitle" });
    titleEl.textContent = c.title + (ctx.kind === "question" && c.score > 0 ? " ★" : "");
    const idEl     = el("span", { class: "cid", text: c.id });
    const chipEl   = el("span", { class: `chip ${status}` });
    chipEl.textContent = status !== "pending" ? status.toUpperCase() : "";
    const arrowEl  = el("span", { class: "carrow", text: "▼" });

    top.appendChild(dotEl);
    top.appendChild(titleEl);
    top.appendChild(idEl);
    if (status !== "pending") top.appendChild(chipEl);
    top.appendChild(arrowEl);

    top.addEventListener("click", () => row.classList.toggle("expanded"));
    row.appendChild(top);

    // ── Expanded body ──
    const exp = el("div", { class: "cexp" });
    if (c.frameworks?.length) {
      exp.appendChild(el("div", { style: "font-size:10px;color:#aab0c4;margin-bottom:6px", text: c.frameworks.slice(0, 4).join(" · ") }));
    }

    const resBox = el("div");
    exp.appendChild(resBox);

    function updateTopStatus(s) {
      dotEl.className = `sdot ${s}`;
      chipEl.className = `chip ${s}`;
      chipEl.textContent = s.toUpperCase();
      if (!top.contains(chipEl)) top.insertBefore(chipEl, arrowEl);
    }

    function showResult(r, ranAt) {
      resBox.innerHTML = "";
      const res = el("div", { class: "cres" });
      res.innerHTML = `${chip(r.status)} ${r.summary}${ranAt ? ` <span style="color:#8a90a5">(${new Date(ranAt).toLocaleString()})</span>` : ""}`;
      resBox.appendChild(res);
      if (r.details?.length) {
        const ul = el("ul", { class: "cdet" });
        for (const d of r.details.slice(0, 6)) ul.appendChild(el("li", { text: d }));
        resBox.appendChild(ul);
      }
      if (["pass", "fail", "warning"].includes(r.status)) {
        const actions = el("div", { class: "actions" });
        actions.appendChild(el("button", { class: "btn small", text: "Attach as evidence", onclick: () => confirmApply(resBox, integ, c, ctx, { answer: null }) }));
        if (ctx.questionCode && r.suggestedAnswer) {
          actions.appendChild(el("button", { class: "btn small primary", text: `Answer "${r.suggestedAnswer}" + evidence`, onclick: () => confirmApply(resBox, integ, c, ctx, { answer: r.suggestedAnswer }) }));
        }
        resBox.appendChild(actions);
      }
    }

    if (last) showResult(last.result, last.ranAt);

    const runBtn = el("button", { class: "btn small", text: last ? "Re-run" : "Run", onclick: async (e) => {
      e.stopPropagation();
      runBtn.disabled = true; runBtn.textContent = "Running…";
      try {
        const { result } = await send({ type: "RUN_CHECK", id: integ.id, checkId: c.id });
        showResult(result, new Date().toISOString());
        updateTopStatus(result.status);
      } catch (err) {
        resBox.innerHTML = "";
        resBox.appendChild(el("div", { class: "status err", text: err.message }));
      }
      runBtn.disabled = false; runBtn.textContent = "Re-run";
    }});

    exp.appendChild(el("div", { class: "actions", style: "margin-top:8px" }, [runBtn]));
    row.appendChild(exp);
    return row;
  }

  /**
   * Shared evidence-target selector: a label (title) field + "create new" vs
   * "add to existing" with a filterable evidence picker. Returns { getTarget }.
   * Used by both the integration-check evidence flow and ticket collection.
   */
  function buildEvidenceTarget(container, { defaultTitle = "", questionCode = null } = {}) {
    const group = "et-" + Math.random().toString(36).slice(2);
    const modeNew = el("input", { type: "radio", name: group, style: "width:auto" }); modeNew.checked = true;
    const modeExist = el("input", { type: "radio", name: group, style: "width:auto" });
    const titleIn = el("input", { type: "text" }); titleIn.value = defaultTitle;
    const evFilter = el("input", { type: "text", placeholder: "filter evidences by code or title…", style: "margin:4px 0" });
    const evidenceSel = el("select", { disabled: "true" });
    evidenceSel.appendChild(el("option", { value: "", text: "— loading evidences… —" }));
    const evMsg = el("div", { class: "hint", text: "" });
    let evidenceList = [];

    function fillEvidenceSelect() {
      const q = evFilter.value.trim().toLowerCase();
      const keep = evidenceSel.value;
      const matches = evidenceList.filter((ev) => !q || `${ev.code || ""} ${ev.title || ""}`.toLowerCase().includes(q));
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: `— select evidence (${matches.length} of ${evidenceList.length}) —` }));
      for (const ev of matches.slice(0, 300)) {
        evidenceSel.appendChild(el("option", { value: String(ev.id), text: `${ev.code || ev.id} — ${String(ev.title || "").slice(0, 70)}` }));
      }
      if (keep && matches.some((ev) => String(ev.id) === keep)) evidenceSel.value = keep;
    }
    evFilter.addEventListener("input", fillEvidenceSelect);

    container.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400" }, [modeNew, el("span", { text: "Create new evidence" })]));
    container.appendChild(titleIn);
    container.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px" }, [modeExist, el("span", { text: "Add to existing evidence (as a new request)" })]));
    container.appendChild(evFilter);
    container.appendChild(evidenceSel);
    container.appendChild(evMsg);

    send({ type: "LIST_EVIDENCES", subdomain: subdomain() }).then(({ evidences }) => {
      evidenceList = evidences || [];
      if (!evidenceList.length) evMsg.textContent = "No evidences returned for this client.";
      fillEvidenceSelect();
    }).catch((e) => {
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: "— could not load evidences —" }));
      evMsg.textContent = e.message;
    });

    function syncMode() {
      titleIn.disabled = !modeNew.checked;
      evidenceSel.disabled = !modeExist.checked;
      evFilter.disabled = !modeExist.checked;
    }
    modeNew.addEventListener("change", syncMode);
    modeExist.addEventListener("change", syncMode);
    syncMode();

    if (questionCode) container.appendChild(el("div", { class: "hint", text: `New evidence will be mapped to ${questionCode}.` }));

    return {
      getTarget() {
        return modeExist.checked
          ? { mode: "existing", evidenceId: Number(evidenceSel.value) }
          : { mode: "new", title: titleIn.value.trim() };
      },
    };
  }

  function confirmApply(resBox, integ, c, ctx, { answer }) {
    const old = resBox.querySelector(".confirm");
    if (old) old.remove();
    const conf = el("div", { class: "status info confirm" });
    const date = new Date().toISOString().slice(0, 10);
    conf.appendChild(el("div", {
      style: "font-weight:600;margin-bottom:8px",
      text: answer
        ? `Write answer "${answer}" to ${ctx.questionCode}, and attach this result as evidence:`
        : "Attach this check result as evidence:",
    }));

    const tgt = buildEvidenceTarget(conf, {
      defaultTitle: `[${integ.name}] ${c.title} — ${date}`,
      questionCode: ctx.questionCode || null,
    });

    const outBox = el("div");
    const row = el("div", { class: "actions", style: "margin-top:10px" });
    const okBtn = el("button", { class: "btn small primary", text: "Confirm" });
    row.appendChild(okBtn);
    row.appendChild(el("button", { class: "btn small", text: "Cancel", onclick: () => conf.remove() }));
    conf.appendChild(row);
    conf.appendChild(outBox);
    resBox.appendChild(conf);

    okBtn.addEventListener("click", async () => {
      outBox.innerHTML = "";
      const target = tgt.getTarget();
      if (target.mode === "existing" && !target.evidenceId) {
        outBox.appendChild(el("div", { class: "status err", text: "Select the existing evidence." }));
        return;
      }
      okBtn.disabled = true; okBtn.textContent = "Writing…";
      try {
        await send({ type: "APPLY_RESULT", subdomain: subdomain(), integrationId: integ.id, checkId: c.id, questionCode: ctx.questionCode || null, attachEvidence: true, answer, target });
        conf.className = "status ok confirm";
        conf.innerHTML = answer
          ? `Answer "${answer}" saved and evidence attached.`
          : (target.mode === "existing" ? "Added to existing evidence." : "Evidence created.");
      } catch (err) {
        outBox.appendChild(el("div", { class: "status err", text: err.message }));
        okBtn.disabled = false; okBtn.textContent = "Confirm";
      }
    });
  }

  // ===================== ticket evidence collection =====================

  async function buildTicketEvidenceSection(wrap, ctx) {
    wrap.innerHTML = "";
    const box = wrap; // content renders directly into the passed container
    box.appendChild(el("div", { class: "hint", text: "Filter PSA tickets for this client and attach them to ControlMap as an evidence package (JSON, SHA-256 stamped). Weak tickets (no close date / description) are flagged." }));

    // --- filters ---
    const today = new Date();
    const past = new Date(Date.now() - 90 * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    const fromIn = el("input", { type: "date" }); fromIn.value = iso(past);
    const toIn = el("input", { type: "date" }); toIn.value = iso(today);
    const textIn = el("input", { type: "text", placeholder: "title contains… (optional)" });
    const fgrid = el("div", { class: "grid" }, [
      el("div", {}, [el("label", { text: "From" }), fromIn]),
      el("div", {}, [el("label", { text: "To" }), toIn]),
    ]);
    box.appendChild(fgrid);
    box.appendChild(el("div", {}, [el("label", { text: "Text filter" }), textIn]));

    const psaSels = {};
    const psaFilterWrap = el("div", { class: "grid" });
    box.appendChild(psaFilterWrap);
    try {
      const { filters } = await send({ type: "GET_TICKET_FILTERS" });
      for (const f of filters) {
        const sel = el("select");
        sel.appendChild(el("option", { value: "", text: `any ${f.label.toLowerCase()}` }));
        for (const o of f.options || []) sel.appendChild(el("option", { value: String(o.value), text: o.label }));
        psaSels[f.key] = sel;
        psaFilterWrap.appendChild(el("div", {}, [el("label", { text: f.label }), sel]));
      }
    } catch (e) {
      box.appendChild(el("div", { class: "status err", text: e.message }));
    }

    const searchBtn = el("button", { class: "btn primary small", text: "Search tickets", style: "margin-top:8px" });
    box.appendChild(searchBtn);
    const resultBox = el("div");
    box.appendChild(resultBox);

    searchBtn.addEventListener("click", async () => {
      searchBtn.disabled = true; searchBtn.textContent = "Searching…";
      resultBox.innerHTML = "";
      mascot?.setState("thinking");
      const query = {
        from: fromIn.value || null,
        to: toIn.value || null,
        text: textIn.value.trim() || null,
        filters: Object.fromEntries(Object.entries(psaSels).map(([k, s]) => [k, s.value]).filter(([, v]) => v)),
      };
      try {
        const r = await send({ type: "SEARCH_TICKETS", subdomain: subdomain(), query });
        renderTicketResults(resultBox, r, query, ctx);
        mascot?.setState("success");
      } catch (e) {
        resultBox.appendChild(el("div", { class: "status err", text: e.message }));
        mascot?.setState("error");
      }
      searchBtn.disabled = false; searchBtn.textContent = "Search tickets";
    });
  }

  function renderTicketResults(resultBox, r, query, ctx) {
    resultBox.innerHTML = "";
    const { tickets, stats, company } = r;
    resultBox.appendChild(el("div", { class: "status info", text: `${stats.found} ticket(s) for ${company.companyName || "company"} — ${stats.closed} closed, ${stats.open} open${stats.weak ? `, ⚠ ${stats.weak} weak` : ""}.` }));
    if (!tickets.length) return;

    const selected = new Set(tickets.map((t) => String(t.id)));
    const list = el("div", { style: "max-height:200px;overflow:auto;border:1px solid #eef0f6;border-radius:8px;padding:4px 8px" });
    for (const t of tickets.slice(0, 100)) {
      const row = el("label", { style: "display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid #f4f5fa;font-weight:400;cursor:pointer" });
      const cb = el("input", { type: "checkbox", style: "width:auto;margin-top:2px" });
      cb.checked = true;
      cb.addEventListener("change", () => cb.checked ? selected.add(String(t.id)) : selected.delete(String(t.id)));
      const weak = !t.closedAt || !(t.description || "").trim();
      const info = el("div", { style: "font-size:11.5px" });
      info.innerHTML = `<b>${t.number || t.id}</b> ${String(t.title || "").slice(0, 70)}${weak ? " ⚠" : ""}<br><span style="color:#8a90a5">${t.status || "?"} · ${(t.createdAt || "").slice(0, 10)}${t.closedAt ? " → " + String(t.closedAt).slice(0, 10) : ""}</span>`;
      row.appendChild(cb); row.appendChild(info);
      list.appendChild(row);
    }
    resultBox.appendChild(list);

    // --- target ---
    const targetWrap = el("div", { style: "margin-top:10px" });
    resultBox.appendChild(targetWrap);
    const modeNew = el("input", { type: "radio", name: "te-mode", style: "width:auto" }); modeNew.checked = true;
    const modeExist = el("input", { type: "radio", name: "te-mode", style: "width:auto" });
    const titleIn = el("input", { type: "text" });
    titleIn.value = `PSA ticket evidence — ${query.from || "…"} to ${query.to || "…"}`;
    const evidenceSel = el("select", { disabled: "true" });
    evidenceSel.appendChild(el("option", { value: "", text: "— loading evidences… —" }));
    const evFilter = el("input", { type: "text", placeholder: "filter evidences by code or title…", style: "margin:4px 0" });
    const evMsg = el("div", { class: "hint", text: "" });
    let evidenceList = [];

    function fillEvidenceSelect() {
      const q = evFilter.value.trim().toLowerCase();
      const keep = evidenceSel.value;
      const matches = evidenceList.filter((ev) => !q || `${ev.code || ""} ${ev.title || ""}`.toLowerCase().includes(q));
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: `— select evidence (${matches.length} of ${evidenceList.length}) —` }));
      for (const ev of matches.slice(0, 300)) {
        evidenceSel.appendChild(el("option", { value: String(ev.id), text: `${ev.code || ev.id} — ${String(ev.title || "").slice(0, 70)}` }));
      }
      if (keep && matches.some((ev) => String(ev.id) === keep)) evidenceSel.value = keep;
    }
    evFilter.addEventListener("input", fillEvidenceSelect);

    targetWrap.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400" }, [modeNew, el("span", { text: "Create new evidence" })]));
    targetWrap.appendChild(titleIn);
    targetWrap.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px" }, [modeExist, el("span", { text: "Add to existing evidence (as a new request)" })]));
    targetWrap.appendChild(evFilter);
    targetWrap.appendChild(evidenceSel);
    targetWrap.appendChild(evMsg);

    send({ type: "LIST_EVIDENCES", subdomain: subdomain() }).then(({ evidences }) => {
      evidenceList = evidences || [];
      if (!evidenceList.length) evMsg.textContent = "No evidences returned for this client.";
      fillEvidenceSelect();
    }).catch((e) => {
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: "— could not load evidences —" }));
      evMsg.textContent = e.message;
    });
    function syncMode() {
      titleIn.disabled = !modeNew.checked;
      evidenceSel.disabled = !modeExist.checked;
      evFilter.disabled = !modeExist.checked;
    }
    modeNew.addEventListener("change", syncMode);
    modeExist.addEventListener("change", syncMode);
    syncMode();

    if (ctx.questionCode) {
      targetWrap.appendChild(el("div", { class: "hint", text: `New evidence will be mapped to ${ctx.questionCode}.` }));
    }

    const attachBtn = el("button", { class: "btn primary small", text: "Attach as evidence", style: "margin-top:10px" });
    const outBox = el("div");
    resultBox.appendChild(attachBtn);
    resultBox.appendChild(outBox);

    attachBtn.addEventListener("click", async () => {
      outBox.innerHTML = "";
      const chosen = tickets.filter((t) => selected.has(String(t.id)));
      if (!chosen.length) { outBox.appendChild(el("div", { class: "status err", text: "Select at least one ticket." })); return; }
      const target = modeExist.checked
        ? { mode: "existing", evidenceId: Number(evidenceSel.value) }
        : { mode: "new", title: titleIn.value.trim() };
      if (target.mode === "existing" && !target.evidenceId) {
        outBox.appendChild(el("div", { class: "status err", text: "Select the existing evidence." })); return;
      }
      attachBtn.disabled = true; attachBtn.textContent = "Collecting…";
      try {
        const res = await send({ type: "COLLECT_TICKET_EVIDENCE", subdomain: subdomain(), query, tickets: chosen, target, questionCode: ctx.questionCode || null });
        const label = res.mode === "existing"
          ? `Added request to evidence #${res.evidenceId} with ${chosen.length} ticket(s). sha256:${res.hash.slice(0, 12)}…`
          : `Evidence created (id ${res.evidenceId}) with ${chosen.length} ticket(s). sha256:${res.hash.slice(0, 12)}…`;
        outBox.appendChild(el("div", { class: "status ok", text: label }));
        attachBtn.textContent = "Done";
      } catch (e) {
        outBox.appendChild(el("div", { class: "status err", text: e.message }));
        attachBtn.disabled = false; attachBtn.textContent = "Attach as evidence";
      }
    });
  }

  // ===================== ticket modal (from v0.2) =====================

  let modalHost = null;

  function closeTicketModal() {
    if (modalHost) { modalHost.remove(); modalHost = null; }
  }

  function buildDescription(item, client, pageUrl) {
    const lines = [];
    if (item.weakness_description) lines.push(item.weakness_description.trim(), "");
    if (item.corrective_action) lines.push("Corrective action:", item.corrective_action.trim(), "");
    if (item.milestones) lines.push("Milestones:", item.milestones.trim(), "");
    if (Array.isArray(item.requirements) && item.requirements.length)
      lines.push("Requirements: " + item.requirements.join(", "), "");
    const meta = [
      `ControlMap action item: ${item.code}`,
      `Client: ${client.name || ""}`,
      `Priority: ${item.priority || "-"} | Status: ${item.status || "-"}`,
      item.responsible_person?.name ? `Responsible: ${item.responsible_person.name}` : null,
      item.effort_in_hours != null ? `Estimated effort: ${item.effort_in_hours} h` : null,
      item.planned_completion_date ? `Planned completion: ${item.planned_completion_date}` : null,
      `Link: ${pageUrl}`,
    ].filter(Boolean);
    lines.push("---", ...meta);
    return lines.join("\n");
  }

  async function openTicketModal(code) {
    closeTicketModal();
    modalHost = document.createElement("div");
    modalHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    document.body.appendChild(modalHost);
    const shadow = modalHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHEET + `
      .backdrop { position: fixed; inset: 0; background: rgba(10,12,30,.55); display: flex; align-items: center; justify-content: center; }
      .modal { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); overflow: auto; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e6e8f0; }
      header h2 { margin: 0; font-size: 16px; }
      header .code { color: ${ACCENT}; }
      header .psa { font-size: 11px; color: #8a90a5; font-weight: 400; margin-left: 8px; }
      .close { border: none; background: none; font-size: 20px; cursor: pointer; color: #667; }
      .mbody { padding: 16px 20px; display: grid; gap: 12px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      footer { padding: 14px 20px; border-top: 1px solid #e6e8f0; display: flex; justify-content: flex-end; gap: 10px; }
      .company-results { border: 1px solid #ccd0dd; border-radius: 6px; max-height: 140px; overflow: auto; margin-top: 4px; }
      .company-results div { padding: 7px 10px; cursor: pointer; font-size: 13px; }
      .company-results div:hover { background: #eef1ff; }
    `;
    shadow.appendChild(style);

    const backdrop = el("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop) closeTicketModal(); } });
    const modal = el("div", { class: "modal card" });
    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);

    const headerEl = el("header", {}, [
      el("h2", { html: `Create PSA Ticket — <span class="code">${code}</span>` }),
      el("button", { class: "close", text: "✕", onclick: closeTicketModal }),
    ]);
    modal.appendChild(headerEl);
    const body = el("div", { class: "mbody" });
    modal.appendChild(body);
    body.appendChild(el("div", { class: "status info", text: "Loading action item from ControlMap…" }));

    let ctx;
    try {
      ctx = await send({ type: "GET_TICKET_CONTEXT", subdomain: subdomain(), code, pageUrl: location.href });
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "status err", text: err.message }));
      body.appendChild(el("div", { class: "hint", text: "Check the extension options (API keys) and try again." }));
      return;
    }

    const { psaName, item, client, fields, mappedCompany, defaults, suggested, companySuggestions } = ctx;
    headerEl.querySelector("h2").appendChild(el("span", { class: "psa", text: `→ ${psaName}` }));
    body.innerHTML = "";

    const companyWrap = el("div");
    companyWrap.appendChild(el("label", { text: `${psaName} company (ControlMap client: ${client.name || "?"})` }));
    const companyInput = el("input", { type: "text", placeholder: "Search companies…" });
    const companyHidden = { companyID: mappedCompany?.companyID || "", companyName: mappedCompany?.companyName || "" };
    if (mappedCompany) companyInput.value = mappedCompany.companyName || `Company #${mappedCompany.companyID}`;
    const results = el("div", { class: "company-results", style: "display:none" });
    let searchTimer = null;
    companyInput.addEventListener("input", () => {
      companyHidden.companyID = "";
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = companyInput.value.trim();
        if (q.length < 2) { results.style.display = "none"; return; }
        try {
          const { companies } = await send({ type: "SEARCH_COMPANIES", query: q });
          results.innerHTML = "";
          for (const c of companies) {
            results.appendChild(el("div", { text: c.companyName, onclick: () => {
              companyHidden.companyID = c.companyID;
              companyHidden.companyName = c.companyName;
              companyInput.value = c.companyName;
              results.style.display = "none";
            }}));
          }
          results.style.display = companies.length ? "block" : "none";
        } catch { /* ignore */ }
      }, 300);
    });
    companyWrap.appendChild(companyInput);
    companyWrap.appendChild(results);
    if (!mappedCompany && companySuggestions?.length === 1) {
      companyHidden.companyID = companySuggestions[0].companyID;
      companyHidden.companyName = companySuggestions[0].companyName;
      companyInput.value = companySuggestions[0].companyName;
      companyWrap.appendChild(el("div", { class: "hint", text: "Auto-matched by name — verify before creating." }));
    } else if (!mappedCompany) {
      companyWrap.appendChild(el("div", { class: "hint", text: "Pick the matching PSA company. Your choice is remembered for this client." }));
    }
    body.appendChild(companyWrap);

    const titleWrap = el("div");
    titleWrap.appendChild(el("label", { text: "Ticket title" }));
    const titleInput = el("input", { type: "text" });
    titleInput.value = `[${item.code}] ${item.weakness_name || ""}`.slice(0, 255);
    titleWrap.appendChild(titleInput);
    body.appendChild(titleWrap);

    const descWrap = el("div");
    descWrap.appendChild(el("label", { text: "Description" }));
    const descInput = el("textarea");
    descInput.value = buildDescription(item, client, location.href);
    descWrap.appendChild(descInput);
    body.appendChild(descWrap);

    const fieldMeta = {};
    const sels = {};
    const grid = el("div", { class: "grid" });
    body.appendChild(grid);

    function presetFor(field) {
      return suggested?.[field.key] ?? defaults?.[field.key] ?? "";
    }

    function fillOptions(sel, field) {
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "", text: "—" }));
      for (const o of field.options || []) sel.appendChild(el("option", { value: String(o.value), text: o.label }));
      const want = String(presetFor(field));
      if (want && Array.from(sel.options).some((x) => x.value === want)) sel.value = want;
      else {
        const d = (field.options || []).find((o) => o.isDefault);
        if (d) sel.value = String(d.value);
      }
    }

    for (const field of fields) {
      fieldMeta[field.key] = field;
      const wrap = el("div");
      wrap.appendChild(el("label", { html: `${field.label}${field.required ? ' <span class="req">*</span>' : ""}` }));
      const sel = el("select");
      sels[field.key] = sel;
      fillOptions(sel, field);
      if (field.reloads) {
        sel.addEventListener("change", async () => {
          try {
            const { fields: updated } = await send({ type: "GET_PSA_FIELDS", context: { [field.key]: sel.value } });
            for (const uf of updated) {
              if (uf.dependsOn === field.key && sels[uf.key]) { fieldMeta[uf.key] = uf; fillOptions(sels[uf.key], uf); }
            }
          } catch { /* keep old options */ }
        });
      }
      wrap.appendChild(sel);
      grid.appendChild(wrap);
    }

    const statusBox = el("div");
    body.appendChild(statusBox);

    const cancelBtn = el("button", { class: "btn", text: "Cancel", onclick: closeTicketModal });
    const createBtn = el("button", { class: "btn primary", text: "Create Ticket" });
    modal.appendChild(el("footer", {}, [cancelBtn, createBtn]));

    createBtn.addEventListener("click", async () => {
      statusBox.innerHTML = "";
      if (!companyHidden.companyID) {
        statusBox.appendChild(el("div", { class: "status err", text: `Select a ${psaName} company first.` }));
        return;
      }
      const missing = Object.values(fieldMeta).filter((f) => f.required && !sels[f.key]?.value).map((f) => f.label);
      if (missing.length) {
        statusBox.appendChild(el("div", { class: "status err", text: `Required: ${missing.join(", ")}.` }));
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      try {
        const fieldValues = {};
        for (const [k, sel] of Object.entries(sels)) if (sel.value) fieldValues[k] = sel.value;
        const result = await send({
          type: "CREATE_TICKET",
          clientId: client.id,
          payload: {
            companyID: companyHidden.companyID,
            companyName: companyHidden.companyName,
            title: titleInput.value.trim(),
            description: descInput.value,
            fields: fieldValues,
            dueDate: item.planned_completion_date || undefined,
          },
        });
        const label = result.ticketNumber ? `Ticket ${result.ticketNumber} created in ${psaName}.` : `Ticket created (id ${result.itemId}).`;
        statusBox.appendChild(el("div", { class: "status ok", text: label }));
        createBtn.textContent = "Done";
        setTimeout(closeTicketModal, 2500);
      } catch (err) {
        statusBox.appendChild(el("div", { class: "status err", text: err.message }));
        createBtn.disabled = false;
        createBtn.textContent = "Create Ticket";
      }
    });
  }

  // ===================== boot =====================

  let lastHref = location.href;
  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(() => {
      injectTicketButtons();
      if (location.href !== lastHref) {
        lastHref = location.href;
        refreshProduct();
        if (panelOpen) renderPanel();
      }
    }, 200);
  });
  function refreshProduct() {
    const p = detectProduct();
    if (p && !PRODUCT) { PRODUCT = p; buildLauncher(); }   // first supported page → build once
    if (launcherHost) launcherHost.style.display = p ? "" : "none";   // toggle on route change
  }

  observer.observe(document.documentElement, { childList: true, subtree: true });
  refreshProduct();
  injectTicketButtons();
})();

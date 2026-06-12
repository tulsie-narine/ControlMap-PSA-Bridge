/**
 * ControlMap Bridge — content script.
 * 1. Grammarly-style floating launcher + context-aware panel (question /
 *    action-item / global contexts).
 * 2. Inline "Create Ticket" button on the Update Action Item sidebar (kept
 *    from earlier versions) + ticket modal.
 */

(() => {
  const BTN_CLASS = "cm-psa-bridge-btn";
  const TITLE_RE = /Action Item:\s*(AI-\d+)/i;
  const ACCENT = "#7c5cff";

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
    .btn.primary { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff; font-weight: 600; }
    .btn.small { padding: 4px 10px; font-size: 12px; }
    .btn[disabled] { opacity: .55; cursor: default; }
    .status { font-size: 13px; padding: 9px 12px; border-radius: 6px; margin: 6px 0; }
    .status.err { background: #fde8e8; color: #9b1c1c; }
    .status.ok { background: #e7f7ed; color: #046c4e; }
    .status.info { background: #eef1ff; color: #3f4bb8; }
    .hint { font-size: 11px; color: #8a90a5; margin-top: 3px; }
    .chip { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; vertical-align: middle; }
    .chip.pass { background: #e7f7ed; color: #046c4e; }
    .chip.fail { background: #fde8e8; color: #9b1c1c; }
    .chip.warning { background: #fef3df; color: #92600a; }
    .chip.error, .chip.not-licensed { background: #eef0f6; color: #555c70; }
  `;

  // ===================== launcher + panel =====================

  let launcherHost = null, panelOpen = false, panelBody = null, panelContextLabel = null;

  function buildLauncher() {
    if (launcherHost || !subdomain()) return;
    launcherHost = document.createElement("div");
    launcherHost.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;";
    document.documentElement.appendChild(launcherHost);
    const shadow = launcherHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHEET + `
      .fab { width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer;
             background: linear-gradient(135deg, ${ACCENT}, #4f8df9); color: #fff;
             box-shadow: 0 6px 20px rgba(80,60,220,.45); display: flex; align-items: center; justify-content: center; }
      .fab:hover { transform: scale(1.06); }
      .fab svg { width: 24px; height: 24px; }
      .panel { position: fixed; right: 0; bottom: 58px; width: 380px; max-height: min(70vh, 640px);
               display: none; flex-direction: column; overflow: hidden; }
      .panel.open { display: flex; }
      .phead { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e6e8f0; }
      .phead .title { font-size: 14px; font-weight: 700; }
      .phead .ctx { font-size: 11px; color: #8a90a5; }
      .pbody { padding: 12px 16px; overflow-y: auto; }
      .icl { border: 1px solid #e6e8f0; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
      .icl .iname { font-weight: 700; font-size: 13px; }
      .check { border-top: 1px solid #eef0f6; padding: 8px 0; }
      .check .ct { font-size: 12.5px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
      .check .cd { font-size: 11px; color: #8a90a5; margin-top: 2px; }
      .check .cres { font-size: 12px; margin-top: 6px; }
      .check .cdet { font-size: 11px; color: #555c70; margin: 4px 0 0 0; padding-left: 16px; }
      .actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .gear { border: none; background: none; cursor: pointer; color: #8a90a5; font-size: 15px; }
    `;
    shadow.appendChild(style);

    const panel = el("div", { class: "panel card" });
    const head = el("div", { class: "phead" });
    const titleWrap = el("div", {}, [
      el("div", { class: "title", text: "ControlMap Bridge" }),
      (panelContextLabel = el("div", { class: "ctx", text: "" })),
    ]);
    head.appendChild(titleWrap);
    head.appendChild(el("div", {}, [
      el("button", { class: "gear", text: "⚙", title: "Settings", onclick: () => send({ type: "OPEN_OPTIONS" }).catch(() => {}) }),
      el("button", { class: "gear", text: "✕", title: "Close", onclick: () => togglePanel(false) }),
    ]));
    panel.appendChild(head);
    panelBody = el("div", { class: "pbody" });
    panel.appendChild(panelBody);

    const fab = el("button", { class: "fab", title: "ControlMap Bridge",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>',
      onclick: () => togglePanel(!panelOpen) });
    shadow.appendChild(panel);
    shadow.appendChild(fab);
    launcherHost._panel = panel;
  }

  function togglePanel(open) {
    panelOpen = open;
    launcherHost._panel.classList.toggle("open", open);
    if (open) renderPanel();
  }

  function chip(status) {
    return `<span class="chip ${status}">${status.toUpperCase()}</span>`;
  }

  async function renderPanel() {
    const ctx = detectContext();
    panelContextLabel.textContent =
      ctx.kind === "question" ? `Question context — ${ctx.questionCode}` :
      ctx.kind === "action-item" ? `Action item — ${ctx.code}` : "Overview";
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
    } else if (data.client) {
      panelBody.appendChild(el("div", { class: "hint", text: `Client: ${data.client.name}` }));
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

    // --- ticket evidence collection ---
    if (data.client) {
      const teBtn = el("button", { class: "btn", text: "▸ Collect tickets as evidence", style: "margin:8px 0;width:100%;text-align:left" });
      const teWrap = el("div", { style: "display:none" });
      teBtn.addEventListener("click", () => {
        const open = teWrap.style.display !== "none";
        teWrap.style.display = open ? "none" : "block";
        teBtn.textContent = (open ? "▸" : "▾") + " Collect tickets as evidence";
        if (!open && !teWrap._built) { teWrap._built = true; buildTicketEvidenceSection(teWrap, ctx); }
      });
      panelBody.appendChild(teBtn);
      panelBody.appendChild(teWrap);
    }

    // --- integrations ---
    const enabled = data.integrations.filter((i) => i.enabled);
    if (!enabled.length) {
      panelBody.appendChild(el("div", { class: "status info", text: "No integrations enabled yet. Open Settings (⚙) to configure SentinelOne or add your own — see docs/BUILDING_INTEGRATIONS.md in the repo." }));
    }
    for (const integ of enabled) {
      const box = el("div", { class: "icl" });
      const nameWrap = el("div", { style: "display:flex;align-items:center;gap:8px" });
      if (integ.icon) {
        const logo = el("img", { src: chrome.runtime.getURL(integ.icon), alt: integ.name, style: "height:20px;max-width:110px;object-fit:contain" });
        logo.addEventListener("error", () => logo.remove());
        nameWrap.appendChild(logo);
      }
      nameWrap.appendChild(el("div", { class: "iname", text: integ.name }));
      const headRow = el("div", { style: "display:flex;justify-content:space-between;align-items:center" }, [
        nameWrap,
        el("button", { class: "btn small", text: "Run all", onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = "Running…";
          try { await send({ type: "RUN_ALL_CHECKS", id: integ.id }); renderPanel(); }
          catch (err) { e.target.textContent = "Failed"; }
        }}),
      ]);
      box.appendChild(headRow);

      const checks = (ctx.kind === "question") ? integ.checks.filter((c) => c.score > 0).concat(integ.checks.filter((c) => c.score === 0)).slice(0, 8) : integ.checks;
      for (const c of checks) box.appendChild(renderCheck(integ, c, ctx));
      panelBody.appendChild(box);
    }
  }

  function renderCheck(integ, c, ctx) {
    const row = el("div", { class: "check" });
    const last = c.lastRun;
    const title = el("div", { class: "ct" });
    title.innerHTML = `<span>${c.title}${ctx.kind === "question" && c.score > 0 ? " ★" : ""}</span><span>${last ? chip(last.result.status) : ""}</span>`;
    row.appendChild(title);
    row.appendChild(el("div", { class: "cd", text: c.id + " · " + (c.frameworks || []).slice(0, 3).join(" · ") }));

    const resBox = el("div");
    row.appendChild(resBox);

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

    const runBtn = el("button", { class: "btn small", text: last ? "Re-run" : "Run", onclick: async () => {
      runBtn.disabled = true; runBtn.textContent = "Running…";
      try {
        const { result } = await send({ type: "RUN_CHECK", id: integ.id, checkId: c.id });
        showResult(result, new Date().toISOString());
      } catch (err) {
        resBox.innerHTML = "";
        resBox.appendChild(el("div", { class: "status err", text: err.message }));
      }
      runBtn.disabled = false; runBtn.textContent = "Re-run";
    }});
    const runWrap = el("div", { class: "actions" }, [runBtn]);
    row.appendChild(runWrap);
    return row;
  }

  function confirmApply(resBox, integ, c, ctx, { answer }) {
    const old = resBox.querySelector(".confirm");
    if (old) old.remove();
    const conf = el("div", { class: "status info confirm" });
    const what = answer
      ? `Write answer "${answer}" to ${ctx.questionCode} and attach an evidence record (with JSON snapshot) mapped to it?`
      : `Create an evidence record (with JSON snapshot)${ctx.questionCode ? ` mapped to ${ctx.questionCode}` : ""}?`;
    conf.appendChild(el("div", { text: what }));
    const row = el("div", { class: "actions" });
    row.appendChild(el("button", { class: "btn small primary", text: "Confirm", onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = "Writing…";
      try {
        await send({ type: "APPLY_RESULT", subdomain: subdomain(), integrationId: integ.id, checkId: c.id, questionCode: ctx.questionCode || null, attachEvidence: true, answer });
        conf.className = "status ok confirm";
        conf.innerHTML = answer ? `Answer "${answer}" saved and evidence attached.` : "Evidence created.";
      } catch (err) {
        conf.className = "status err confirm";
        conf.textContent = err.message;
      }
    }}));
    row.appendChild(el("button", { class: "btn small", text: "Cancel", onclick: () => conf.remove() }));
    conf.appendChild(row);
    resBox.appendChild(conf);
  }

  // ===================== ticket evidence collection =====================

  async function buildTicketEvidenceSection(wrap, ctx) {
    wrap.innerHTML = "";
    const box = el("div", { class: "icl" });
    wrap.appendChild(box);
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
      const query = {
        from: fromIn.value || null,
        to: toIn.value || null,
        text: textIn.value.trim() || null,
        filters: Object.fromEntries(Object.entries(psaSels).map(([k, s]) => [k, s.value]).filter(([, v]) => v)),
      };
      try {
        const r = await send({ type: "SEARCH_TICKETS", subdomain: subdomain(), query });
        renderTicketResults(resultBox, r, query, ctx);
      } catch (e) {
        resultBox.appendChild(el("div", { class: "status err", text: e.message }));
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

    targetWrap.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400" }, [modeNew, el("span", { text: "Create new evidence" })]));
    targetWrap.appendChild(titleIn);
    targetWrap.appendChild(el("label", { style: "display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px" }, [modeExist, el("span", { text: "Add to existing evidence (as a new request)" })]));
    targetWrap.appendChild(evidenceSel);

    send({ type: "LIST_EVIDENCES", subdomain: subdomain() }).then(({ evidences }) => {
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: "— select evidence —" }));
      for (const ev of evidences) evidenceSel.appendChild(el("option", { value: String(ev.id), text: `${ev.code || ev.id} — ${String(ev.title || "").slice(0, 60)}` }));
    }).catch(() => {
      evidenceSel.innerHTML = "";
      evidenceSel.appendChild(el("option", { value: "", text: "— could not load evidences —" }));
    });
    function syncMode() {
      titleIn.disabled = !modeNew.checked;
      evidenceSel.disabled = !modeExist.checked;
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
        if (panelOpen) renderPanel();
      }
    }, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  buildLauncher();
  injectTicketButtons();
})();

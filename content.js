/**
 * ControlMap PSA Bridge — content script.
 * Injects "Create Ticket" on the Update Action Item panel; modal fields are
 * rendered dynamically from the active PSA adapter's field metadata.
 */

(() => {
  const BTN_CLASS = "cm-psa-bridge-btn";
  const TITLE_RE = /Action Item:\s*(AI-\d+)/i;

  function subdomain() {
    const m = location.hostname.match(/^([^.]+)\.app\.ctrlmap\.com$/i);
    return m ? m[1] : null;
  }

  // ---------- panel detection ----------

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

  function findActionButton(root) {
    const btns = Array.from(root.querySelectorAll("button"));
    return btns.find((b) => /update action item/i.test(b.textContent || "")) || null;
  }

  function inject() {
    for (const { root, code } of findPanels()) {
      if (root.querySelector(`.${BTN_CLASS}`)) continue;
      const anchor = findActionButton(root);
      if (!anchor) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = BTN_CLASS;
      btn.textContent = "Create Ticket";
      btn.style.cssText = [
        "margin-left:8px", "padding:8px 14px", "border:none", "border-radius:6px",
        "background:#7c5cff", "color:#fff", "font:inherit", "font-weight:600",
        "cursor:pointer", "vertical-align:middle",
      ].join(";");
      btn.addEventListener("mouseenter", () => (btn.style.background = "#6a4be0"));
      btn.addEventListener("mouseleave", () => (btn.style.background = "#7c5cff"));
      btn.addEventListener("click", () => openModal(code));
      anchor.insertAdjacentElement("afterend", btn);
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(inject, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  inject();

  // ---------- messaging ----------

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error("No response from extension background."));
        res.ok ? resolve(res.data) : reject(new Error(res.error));
      });
    });
  }

  // ---------- modal ----------

  let host = null;

  function closeModal() {
    if (host) { host.remove(); host = null; }
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

  async function openModal(code) {
    closeModal();
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      .backdrop { position: fixed; inset: 0; background: rgba(10,12,30,.55); display: flex; align-items: center; justify-content: center; }
      .modal { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); overflow: auto;
               background: #fff; color: #1c2030; border-radius: 12px; box-shadow: 0 24px 64px rgba(0,0,0,.35); }
      header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e6e8f0; }
      header h2 { margin: 0; font-size: 16px; }
      header .code { color: #7c5cff; }
      header .psa { font-size: 11px; color: #8a90a5; font-weight: 400; margin-left: 8px; }
      .close { border: none; background: none; font-size: 20px; cursor: pointer; color: #667; }
      .body { padding: 16px 20px; display: grid; gap: 12px; }
      label { font-size: 12px; font-weight: 600; color: #555c70; display: block; margin-bottom: 4px; }
      label .req { color: #c0392b; }
      input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccd0dd; border-radius: 6px; font-size: 13px; background: #fff; color: #1c2030; }
      textarea { min-height: 140px; resize: vertical; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      footer { padding: 14px 20px; border-top: 1px solid #e6e8f0; display: flex; justify-content: flex-end; gap: 10px; }
      .btn { padding: 9px 16px; border-radius: 6px; border: 1px solid #ccd0dd; background: #fff; cursor: pointer; font-size: 13px; }
      .btn.primary { background: #7c5cff; border-color: #7c5cff; color: #fff; font-weight: 600; }
      .btn[disabled] { opacity: .55; cursor: default; }
      .status { font-size: 13px; padding: 10px 12px; border-radius: 6px; }
      .status.err { background: #fde8e8; color: #9b1c1c; }
      .status.ok { background: #e7f7ed; color: #046c4e; }
      .status.info { background: #eef1ff; color: #3f4bb8; }
      .hint { font-size: 11px; color: #8a90a5; margin-top: 3px; }
      .company-results { border: 1px solid #ccd0dd; border-radius: 6px; max-height: 140px; overflow: auto; margin-top: 4px; }
      .company-results div { padding: 7px 10px; cursor: pointer; font-size: 13px; }
      .company-results div:hover { background: #eef1ff; }
    `;
    shadow.appendChild(style);

    const backdrop = el("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop) closeModal(); } });
    const modal = el("div", { class: "modal" });
    backdrop.appendChild(modal);
    shadow.appendChild(backdrop);

    const headerEl = el("header", {}, [
      el("h2", { html: `Create PSA Ticket — <span class="code">${code}</span>` }),
      el("button", { class: "close", text: "✕", onclick: closeModal }),
    ]);
    modal.appendChild(headerEl);
    const body = el("div", { class: "body" });
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

    const { psa, psaName, item, client, fields, mappedCompany, defaults, suggested, companySuggestions } = ctx;
    headerEl.querySelector("h2").appendChild(el("span", { class: "psa", text: `→ ${psaName}` }));
    body.innerHTML = "";

    // --- company picker ---
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
            results.appendChild(el("div", {
              text: c.companyName,
              onclick: () => {
                companyHidden.companyID = c.companyID;
                companyHidden.companyName = c.companyName;
                companyInput.value = c.companyName;
                results.style.display = "none";
              },
            }));
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

    // --- title ---
    const titleWrap = el("div");
    titleWrap.appendChild(el("label", { text: "Ticket title" }));
    const titleInput = el("input", { type: "text" });
    titleInput.value = `[${item.code}] ${item.weakness_name || ""}`.slice(0, 255);
    titleWrap.appendChild(titleInput);
    body.appendChild(titleWrap);

    // --- description ---
    const descWrap = el("div");
    descWrap.appendChild(el("label", { text: "Description" }));
    const descInput = el("textarea");
    descInput.value = buildDescription(item, client, location.href);
    descWrap.appendChild(descInput);
    body.appendChild(descWrap);

    // --- dynamic PSA fields ---
    const fieldMeta = {};   // key -> field def
    const sels = {};        // key -> select element
    const grid = el("div", { class: "grid" });
    body.appendChild(grid);

    function presetFor(field) {
      return suggested?.[field.key] ?? defaults?.[field.key] ?? "";
    }

    function fillOptions(sel, field, keep) {
      const prev = keep ? sel.value : null;
      sel.innerHTML = "";
      sel.appendChild(el("option", { value: "", text: "—" }));
      for (const o of field.options || []) sel.appendChild(el("option", { value: String(o.value), text: o.label }));
      const want = (prev && Array.from(sel.options).some((x) => x.value === prev)) ? prev : String(presetFor(field));
      if (want && Array.from(sel.options).some((x) => x.value === want)) sel.value = want;
      else {
        const d = (field.options || []).find((o) => o.isDefault);
        if (d) sel.value = String(d.value);
      }
    }

    function renderFields(fieldList) {
      grid.innerHTML = "";
      for (const field of fieldList) {
        fieldMeta[field.key] = field;
        const wrap = el("div");
        wrap.appendChild(el("label", { html: `${field.label}${field.required ? ' <span class="req">*</span>' : ""}` }));
        const sel = el("select");
        sels[field.key] = sel;
        fillOptions(sel, field, false);
        if (field.reloads) {
          sel.addEventListener("change", async () => {
            try {
              const { fields: updated } = await send({ type: "GET_PSA_FIELDS", context: { [field.key]: sel.value } });
              for (const uf of updated) {
                if (uf.dependsOn === field.key && sels[uf.key]) {
                  fieldMeta[uf.key] = uf;
                  fillOptions(sels[uf.key], uf, false);
                }
              }
            } catch { /* keep old options */ }
          });
        }
        wrap.appendChild(sel);
        grid.appendChild(wrap);
      }
    }
    renderFields(fields);

    const statusBox = el("div");
    body.appendChild(statusBox);

    // --- footer ---
    const cancelBtn = el("button", { class: "btn", text: "Cancel", onclick: closeModal });
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
        setTimeout(closeModal, 2500);
      } catch (err) {
        statusBox.appendChild(el("div", { class: "status err", text: err.message }));
        createBtn.disabled = false;
        createBtn.textContent = "Create Ticket";
      }
    });
  }
})();

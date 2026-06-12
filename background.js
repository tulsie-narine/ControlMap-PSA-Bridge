/**
 * ControlMap Bridge — background service worker (ES module).
 * Routes messages from the content script / options page to:
 *  - ScalePad/ControlMap API (core/scalepad.js)
 *  - PSA adapters (core/psa.js)
 *  - Integration framework (integrations/registry.js)
 */

import { getSettings, saveSettings, integrationConfig, saveLastRun } from "./core/store.js";
import * as sp from "./core/scalepad.js";
import { PSA_ADAPTERS, suggestPriority } from "./core/psa.js";
import { INTEGRATIONS, getIntegration } from "./integrations/registry.js";

// ---------- integration helpers ----------

function integrationMeta(settings, i) {
  const cfg = integrationConfig(settings, i.id);
  return {
    id: i.id, name: i.name, version: i.version, description: i.description, icon: i.icon || null,
    configSchema: i.configSchema,
    enabled: !!cfg.enabled,
    configured: i.configSchema.filter((f) => f.required).every((f) => (cfg.config[f.key] || "").trim?.() !== ""),
    checks: i.checks.map((c) => ({ id: c.id, title: c.title, description: c.description, frameworks: c.frameworks, keywords: c.keywords })),
  };
}

function checkCtx(settings, integration) {
  const cfg = integrationConfig(settings, integration.id);
  if (!cfg.enabled) throw new Error(`${integration.name} is not enabled. Enable it in extension options.`);
  return { config: cfg.config };
}

function scoreCheckForQuestion(check, questionText) {
  const text = (questionText || "").toLowerCase();
  if (!text) return 0;
  let score = 0;
  for (const k of check.keywords || []) if (text.includes(k.toLowerCase())) score++;
  return score;
}

function statusToAnswer(status) {
  return status === "pass" ? "Yes" : status === "warning" ? "Partially" : status === "fail" ? "No" : null;
}

async function runCheck(settings, integrationId, checkId) {
  const integration = getIntegration(integrationId);
  const check = integration.checks.find((c) => c.id === checkId);
  if (!check) throw new Error(`Unknown check ${checkId}`);
  const ctx = checkCtx(settings, integration);
  let res;
  try {
    res = await check.run(ctx);
  } catch (err) {
    res = { status: "error", summary: err.message || String(err), details: [], evidence: null };
  }
  res.suggestedAnswer = statusToAnswer(res.status);
  await saveLastRun(integrationId, checkId, res);
  return res;
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const settings = await getSettings();
    const psa = PSA_ADAPTERS[settings.psa] || PSA_ADAPTERS.autotask;

    switch (msg.type) {

      // ===== PSA ticketing (unchanged from v0.2) =====
      case "GET_TICKET_CONTEXT": {
        const client = await sp.resolveTenant(settings, msg.subdomain);
        const { item } = await sp.getActionItemByCode(settings, client.id, msg.code);
        const fields = await psa.getFields(settings, {});
        const mapped = (settings.clientMap2[settings.psa] || {})[client.id] || null;
        let companySuggestions = [];
        if (!mapped) {
          try { companySuggestions = await psa.searchCompanies(settings, (client.name || "").split(/\s+/)[0] || ""); } catch { /* optional */ }
        }
        return {
          psa: settings.psa, psaName: psa.name, client, item, fields,
          mappedCompany: mapped,
          defaults: settings.psaDefaults[settings.psa] || {},
          suggested: suggestPriority(item.priority, fields),
          companySuggestions,
        };
      }
      case "GET_PSA_FIELDS":
        return { fields: await psa.getFields(settings, msg.context || {}) };
      case "SEARCH_COMPANIES":
        return { companies: await psa.searchCompanies(settings, msg.query) };
      case "CREATE_TICKET": {
        const result = await psa.createTicket(settings, msg.payload);
        if (msg.clientId && msg.payload.companyID) {
          const clientMap2 = { ...settings.clientMap2 };
          clientMap2[settings.psa] = { ...(clientMap2[settings.psa] || {}) };
          clientMap2[settings.psa][msg.clientId] = { companyID: msg.payload.companyID, companyName: msg.payload.companyName || "" };
          await saveSettings({ clientMap2 });
        }
        return result;
      }
      case "TEST_PSA": {
        const which = msg.psa ? PSA_ADAPTERS[msg.psa] : psa;
        return { summary: await which.test(settings) };
      }

      // ===== ScalePad / tenant plumbing =====
      case "TEST_CM_CLIENT": {
        const r = await sp.spFetch(settings, `/controlmap/v1/clients/${encodeURIComponent(msg.clientId)}/action-items/search`, {
          method: "POST", body: JSON.stringify({ page_size: 1 }),
        });
        return { tenant: r?.client?.tenant_id || null, total: r?.action_items?.total_count ?? r?.total_count ?? null };
      }
      case "LIST_CM_CLIENTS":
        return { clients: await sp.listClients(settings) };
      case "TEST_SCALEPAD": {
        const clients = await sp.listClients(settings);
        return { ok: true, count: clients.length };
      }

      // ===== integration framework =====
      case "LIST_INTEGRATIONS":
        return { integrations: INTEGRATIONS.map((i) => integrationMeta(settings, i)), lastRuns: settings.lastRuns || {} };
      case "GET_INTEGRATION_CONFIG": {
        const cfg = integrationConfig(settings, msg.id);
        return { enabled: cfg.enabled, config: cfg.config };
      }
      case "SET_INTEGRATION_CONFIG": {
        const integrations = { ...(settings.integrations || {}) };
        integrations[msg.id] = { enabled: !!msg.enabled, config: msg.config || {} };
        await saveSettings({ integrations });
        return { ok: true };
      }
      case "TEST_INTEGRATION": {
        const integration = getIntegration(msg.id);
        const ctx = checkCtx(settings, integration);
        return { summary: await integration.test(ctx) };
      }
      case "RUN_CHECK":
        return { result: await runCheck(settings, msg.id, msg.checkId) };
      case "RUN_ALL_CHECKS": {
        const integration = getIntegration(msg.id);
        const results = {};
        for (const c of integration.checks) {
          results[c.id] = await runCheck(settings, msg.id, c.id);
        }
        return { results };
      }

      // ===== overlay panel context =====
      case "GET_PANEL_CONTEXT": {
        let client = null, clientError = null;
        try { client = await sp.resolveTenant(settings, msg.subdomain); } catch (e) { clientError = e.message; }
        let question = null;
        if (client && msg.questionCode) {
          try { question = await sp.getQuestion(settings, client.id, msg.questionCode); } catch { /* non-fatal */ }
        }
        const questionText = [question?.name, question?.question, question?.description, question?.text].filter(Boolean).join(" ");
        const integrations = INTEGRATIONS.map((i) => {
          const meta = integrationMeta(settings, i);
          meta.checks = meta.checks.map((c) => ({
            ...c,
            score: msg.questionCode ? scoreCheckForQuestion(c, questionText || msg.questionCode) : 0,
            lastRun: settings.lastRuns?.[i.id]?.[c.id] || null,
          }));
          if (msg.questionCode) meta.checks.sort((a, b) => b.score - a.score);
          return meta;
        });
        return { client, clientError, question: question ? { code: msg.questionCode, text: questionText.slice(0, 500) } : (msg.questionCode ? { code: msg.questionCode, text: "" } : null), integrations };
      }

      // ===== apply check result to ControlMap =====
      case "APPLY_RESULT": {
        const client = await sp.resolveTenant(settings, msg.subdomain);
        const run = settings.lastRuns?.[msg.integrationId]?.[msg.checkId];
        if (!run) throw new Error("No stored result for this check — run it first.");
        const integration = getIntegration(msg.integrationId);
        const check = integration.checks.find((c) => c.id === msg.checkId);
        const r = run.result;
        const date = new Date().toISOString().slice(0, 10);
        const out = { evidence: null, answer: null };
        if (msg.attachEvidence !== false) {
          const detailLines = (r.details || []).join("\n");
          out.evidence = await sp.createEvidenceWithSnapshot(settings, client.id, {
            title: `[${integration.name}] ${check.title} — ${date}`,
            description: `${r.summary}\n${detailLines}\n\nCheck: ${check.id} (${integration.name} v${integration.version})\nStatus: ${r.status}\nRan at: ${run.ranAt}\nFrameworks: ${(check.frameworks || []).join(", ")}`,
            questionCodes: msg.questionCode ? [msg.questionCode] : [],
            snapshot: { check: check.id, integration: integration.id, status: r.status, summary: r.summary, ranAt: run.ranAt, data: r.evidence?.snapshot ?? null },
            fileName: `${check.id}-${date}.json`,
          });
        }
        if (msg.answer && msg.questionCode) {
          out.answer = await sp.saveAnswer(settings, client.id, msg.questionCode, msg.answer);
        }
        return out;
      }

      case "OPEN_OPTIONS":
        chrome.runtime.openOptionsPage();
        return { ok: true };

      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

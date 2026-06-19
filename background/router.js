/**
 * background/router.js
 *
 * Message router — the entry point imported by background.js.
 * Delegates to domain-specific helpers; does NOT contain business logic.
 *
 * Message namespaces:
 *   PSA ticketing     GET_TICKET_CONTEXT, GET_PSA_FIELDS, SEARCH_COMPANIES,
 *                     CREATE_TICKET, TEST_PSA
 *   ScalePad/tenant   TEST_SCALEPAD, TEST_CM_CLIENT, LIST_CM_CLIENTS
 *   Integrations      LIST_INTEGRATIONS, GET_INTEGRATION_CONFIG,
 *                     SET_INTEGRATION_CONFIG, TEST_INTEGRATION,
 *                     RUN_CHECK, RUN_ALL_CHECKS
 *   Panel             GET_PANEL_CONTEXT, APPLY_RESULT
 *   Ticket evidence   GET_TICKET_FILTERS, SEARCH_TICKETS, LIST_EVIDENCES,
 *                     COLLECT_TICKET_EVIDENCE
 *   Quoter            QUOTER_CONTEXT, QUOTER_LIST_WON_QUOTES, QUOTER_SAVE_DISTRIBUTORS
 *   Shell             OPEN_OPTIONS
 */

import { getSettings, saveSettings, integrationConfig, getEvidenceMap, setEvidenceMap, patchEvidenceMapEntry } from "../core/store.js";
import * as sp                                          from "../core/scalepad.js";
import { getDistributorAdapter }                       from "../core/distributors.js";
import { PSA_ADAPTERS, suggestPriority }               from "../core/psa.js";
import { INTEGRATIONS, getIntegration }                from "../integrations/registry.js";
import { buildTicketEvidencePdf, buildCheckEvidencePdf, buildExecReportPdf } from "../core/pdf.js";
import {
  runCheck,
  integrationMeta,
  checkCtx,
  buildPanelIntegrations,
} from "./integrationRunner.js";
import { sha256Hex, ticketStats, attachCheckEvidence }  from "./evidenceHelpers.js";

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

export function registerRouter() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // keep channel open for async response
  });

  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const settings = await getSettings();
  const psa      = PSA_ADAPTERS[settings.psa] || PSA_ADAPTERS.autotask;

  switch (msg.type) {

    // ═══════════════════════════════════════════════════════════════════════
    // PSA ticketing
    // ═══════════════════════════════════════════════════════════════════════
    case "GET_TICKET_CONTEXT": {
      const client = await sp.resolveTenant(settings, msg.subdomain);
      const { item } = await sp.getActionItemByCode(settings, client.id, msg.code);
      const fields = await psa.getFields(settings, {});
      const mapped = (settings.clientMap2[settings.psa] || {})[client.id] || null;
      let companySuggestions = [];
      if (!mapped) {
        try { companySuggestions = await psa.searchCompanies(settings, (client.name || "").split(/\s+/)[0] || ""); }
        catch { /* optional */ }
      }
      return {
        psa: settings.psa, psaName: psa.name, client, item, fields,
        mappedCompany: mapped,
        defaults:      settings.psaDefaults[settings.psa] || {},
        suggested:     suggestPriority(item.priority, fields),
        companySuggestions,
      };
    }

    case "GET_PSA_FIELDS":
      return { fields: await psa.getFields(settings, msg.context || {}) };

    case "SEARCH_COMPANIES":
      return { companies: await psa.searchCompanies(settings, msg.query) };

    case "CREATE_TICKET": {
      const res = await psa.createTicket(settings, msg.payload);
      if (msg.clientId && msg.payload.companyID) {
        const clientMap2 = { ...settings.clientMap2 };
        clientMap2[settings.psa] = { ...(clientMap2[settings.psa] || {}) };
        clientMap2[settings.psa][msg.clientId] = {
          companyID:   msg.payload.companyID,
          companyName: msg.payload.companyName || "",
        };
        await saveSettings({ clientMap2 });
      }
      return res;
    }

    case "TEST_PSA": {
      const which = msg.psa ? PSA_ADAPTERS[msg.psa] : psa;
      return { summary: await which.test(settings) };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ScalePad / tenant plumbing
    // ═══════════════════════════════════════════════════════════════════════
    case "TEST_CM_CLIENT": {
      const r = await sp.spFetch(
        settings,
        `/controlmap/v1/clients/${encodeURIComponent(msg.clientId)}/action-items/search`,
        { method: "POST", body: JSON.stringify({ page_size: 1 }) },
      );
      return { tenant: r?.client?.tenant_id || null, total: r?.action_items?.total_count ?? r?.total_count ?? null };
    }

    case "LIST_CM_CLIENTS":
      // ControlMap-provisioned clients (valid CM ids), not all ScalePad org clients.
      return { clients: await sp.listControlMapClients(settings) };

    case "TEST_SCALEPAD": {
      const clients = await sp.listClients(settings);
      return { ok: true, count: clients.length };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Integration framework
    // ═══════════════════════════════════════════════════════════════════════
    case "LIST_INTEGRATIONS":
      return {
        integrations: INTEGRATIONS.map((i) => integrationMeta(settings, i)),
        lastRuns: settings.lastRuns || {},
      };

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

    // ═══════════════════════════════════════════════════════════════════════
    // Overlay panel
    // ═══════════════════════════════════════════════════════════════════════
    case "GET_PANEL_CONTEXT": {
      let client = null, clientError = null;
      try { client = await sp.resolveTenant(settings, msg.subdomain); }
      catch (e) { clientError = e.message; }

      // Only show the PSA ticket section when the active PSA has credentials filled in
      const psaConfigured = (() => {
        switch (settings.psa || "autotask") {
          case "autotask": { const a = settings.autotask || {}; return !!(a.integrationCode && a.userName && a.secret); }
          case "connectwise": { const c = settings.connectwise || {}; return !!(c.siteUrl && c.companyId && c.publicKey && c.privateKey); }
          case "halo": { const h = settings.halo || {}; return !!(h.baseUrl && h.clientId && h.clientSecret); }
          default: return false;
        }
      })();

      let question = null;
      if (client && msg.questionCode) {
        try { question = await sp.getQuestion(settings, client.id, msg.questionCode); }
        catch { /* non-fatal */ }
      }
      const questionText = [
        question?.name, question?.question, question?.description, question?.text,
      ].filter(Boolean).join(" ");

      return {
        client,
        clientError,
        psa:          settings.psa || "autotask",
        psaName:      psa.name,
        psaConfigured,
        question: question
          ? { code: msg.questionCode, text: questionText.slice(0, 500) }
          : (msg.questionCode ? { code: msg.questionCode, text: "" } : null),
        integrations: buildPanelIntegrations(settings, msg.questionCode || null, questionText),
      };
    }

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
        out.evidence = await attachCheckEvidence(settings, client, integration, check, run, {
          target: msg.target, questionCode: msg.questionCode || null,
        });
      }
      if (msg.answer && msg.questionCode) {
        out.answer = await sp.saveAnswer(settings, client.id, msg.questionCode, msg.answer);
      }
      return out;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Ticket evidence collection
    // ═══════════════════════════════════════════════════════════════════════
    case "GET_TICKET_FILTERS":
      return { psaName: psa.name, filters: await psa.getTicketFilters(settings) };

    case "SEARCH_TICKETS": {
      const client = await sp.resolveTenant(settings, msg.subdomain);
      const mapped = (settings.clientMap2[settings.psa] || {})[client.id];
      if (!mapped?.companyID) throw new Error(
        `No ${psa.name} company mapped for "${client.name}". Map it in options (Tenant mappings) or create one ticket first.`
      );
      const tickets = await psa.searchTickets(settings, { ...msg.query, companyID: mapped.companyID });
      return { client, company: mapped, tickets, stats: ticketStats(tickets) };
    }

    case "LIST_EVIDENCES": {
      const client = await sp.resolveTenant(settings, msg.subdomain);
      return { evidences: await sp.listEvidences(settings, client.id) };
    }

    case "COLLECT_TICKET_EVIDENCE": {
      const client  = await sp.resolveTenant(settings, msg.subdomain);
      const tickets = (msg.tickets || []).slice(0, 100);
      if (!tickets.length) throw new Error("No tickets selected.");

      const NOTES_CAP = 25;
      for (let i = 0; i < Math.min(tickets.length, NOTES_CAP); i++) {
        try { tickets[i].notes = await psa.getTicketNotes(settings, tickets[i].id); }
        catch { tickets[i].notes = []; }
      }

      const stats = ticketStats(tickets);
      const date  = new Date().toISOString().slice(0, 10);
      const pkg   = {
        meta: {
          kind:           "psa-ticket-evidence",
          source_system:  psa.name,
          client:         { id: client.id, name: client.name },
          collected_at:   new Date().toISOString(),
          collector:      `ScalePad Atlas ${chrome.runtime.getManifest().version}`,
          query:          msg.query || {},
          stats,
          notes_included_for_first: Math.min(tickets.length, NOTES_CAP),
        },
        tickets,
      };
      const hash = await sha256Hex(JSON.stringify(pkg));
      pkg.meta.evidence_hash = `sha256:${hash}`;

      const summaryLines = [
        `PSA ticket evidence — ${psa.name}`,
        `Client: ${client.name}`,
        msg.query?.from || msg.query?.to
          ? `Period: ${msg.query?.from || "…"} → ${msg.query?.to || "…"}`
          : null,
        `Tickets: ${stats.found} (${stats.closed} closed, ${stats.open} open)`,
        stats.weak
          ? `⚠ ${stats.weak} ticket(s) flagged weak (missing close date or description).`
          : "All tickets have close dates and descriptions.",
        `Collected: ${pkg.meta.collected_at}`,
        `Integrity: sha256:${hash.slice(0, 16)}…`,
      ].filter(Boolean);

      const description = summaryLines.join("\n");
      const fileName    = `psa-tickets-${date}.json`;
      let extraFiles = [];
      try {
        extraFiles = [{ blob: buildTicketEvidencePdf(pkg), name: `psa-tickets-${date}.pdf` }];
      } catch { /* PDF is best-effort */ }

      if (msg.target?.mode === "existing" && msg.target?.evidenceId) {
        const r = await sp.addEvidenceRequestWithDocument(settings, client.id, msg.target.evidenceId, {
          snapshot: pkg, fileName, note: description, extraFiles,
        });
        return { mode: "existing", evidenceId: msg.target.evidenceId, evidenceRequestId: r.evidenceRequestId, stats, hash };
      }

      const created = await sp.createEvidenceWithSnapshot(settings, client.id, {
        title:         msg.target?.title || `PSA ticket evidence — ${psa.name} — ${date}`,
        description,
        questionCodes: msg.questionCode ? [msg.questionCode] : [],
        snapshot:      pkg,
        fileName,
        extraFiles,
      });
      return { mode: "new", ...created, stats, hash };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Pre-mapped evidence (bulk attach across all checks of an integration)
    // ═══════════════════════════════════════════════════════════════════════
    case "LIST_EVIDENCES_FOR_CLIENT": {
      // Used by the options page (no ctrlmap tab → no subdomain).
      return { evidences: await sp.listEvidences(settings, msg.clientId) };
    }

    case "GET_EVIDENCE_MAP": {
      const integration = getIntegration(msg.integrationId);
      return {
        map: getEvidenceMap(settings, msg.integrationId, msg.clientId),
        checks: integration.checks.map((c) => ({ id: c.id, title: c.title, frameworks: c.frameworks || [] })),
      };
    }

    case "SET_EVIDENCE_MAP": {
      await setEvidenceMap(msg.integrationId, msg.clientId, msg.map || {});
      return { ok: true };
    }

    case "ATTACH_PREMAP": {
      const client = await sp.resolveTenant(settings, msg.subdomain);
      const integration = getIntegration(msg.integrationId);
      const map = getEvidenceMap(settings, msg.integrationId, client.id);
      const mapped = integration.checks.filter((c) => {
        const m = map[c.id];
        return m && m.mode && m.mode !== "skip";
      });
      if (!mapped.length) {
        throw new Error(`No evidence pre-mapping found for "${client.name}". Set it in Settings → ${integration.name} → Evidence Mapping.`);
      }

      const results = [];
      let attached = 0, failed = 0;
      for (const check of mapped) {
        const entry = map[check.id];
        try {
          // ensure a fresh run exists
          let run = settings.lastRuns?.[msg.integrationId]?.[check.id];
          if (!run || msg.rerun) {
            const result = await runCheck(settings, msg.integrationId, check.id);
            run = { result, ranAt: new Date().toISOString() };
            // refresh local settings cache so subsequent reads see it
            settings.lastRuns = settings.lastRuns || {};
            settings.lastRuns[msg.integrationId] = settings.lastRuns[msg.integrationId] || {};
            settings.lastRuns[msg.integrationId][check.id] = run;
          }

          // resolve target: existing id, or cached new id, else create-new
          let target;
          if (entry.mode === "existing" && entry.evidenceId) {
            target = { mode: "existing", evidenceId: Number(entry.evidenceId) };
          } else if (entry.mode === "new" && entry.evidenceId) {
            // created on a previous run → append to it
            target = { mode: "existing", evidenceId: Number(entry.evidenceId) };
          } else {
            target = { mode: "new", title: entry.title || `[${integration.name}] ${check.title}` };
          }

          const ev = await attachCheckEvidence(settings, client, integration, check, run, { target });

          // cache a freshly created evidence id so future runs append instead of duplicating
          if (entry.mode === "new" && !entry.evidenceId && ev.evidenceId) {
            await patchEvidenceMapEntry(msg.integrationId, client.id, check.id, { evidenceId: ev.evidenceId });
          }
          attached++;
          results.push({ checkId: check.id, ok: true, mode: ev.mode, evidenceId: ev.evidenceId, status: run.result.status });
        } catch (e) {
          failed++;
          results.push({ checkId: check.id, ok: false, error: e.message });
        }
      }
      return { client: { id: client.id, name: client.name }, attached, failed, total: mapped.length, results };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Quoter — distributor procurement
    // ═══════════════════════════════════════════════════════════════════════
    case "QUOTER_CONTEXT":
      return {
        apiConfigured: !!settings.scalepadApiKey,
        distributors: ((settings.quoter && settings.quoter.distributors) || []).map((d) => ({
          name: d.name || "",
          email: d.email || "",
          aliases: Array.isArray(d.aliases) ? d.aliases : [],
          apiAdapter: (d.api && d.api.adapter) || "none",
          apiEnabled: !!(d.api && d.api.enabled && d.api.adapter && d.api.adapter !== "none"),
        })),
      };

    case "QUOTER_REPORT_QUOTES":
      return { quotes: await sp.listQuotesInRange(settings, { after: msg.after || null, before: msg.before || null }) };

    case "EXEC_REPORT_PDF": {
      const blob = buildExecReportPdf(msg.report || {});
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { base64: btoa(bin), filename: msg.filename || "executive-quote-report.pdf" };
    }

    case "QUOTER_LIST_WON_QUOTES":
      return { quotes: await sp.listWonQuotes(settings, { wonAfter: msg.wonAfter || null, wonBefore: msg.wonBefore || null }) };

    case "QUOTER_SAVE_DISTRIBUTORS": {
      const quoter = { ...(settings.quoter || {}), distributors: Array.isArray(msg.distributors) ? msg.distributors : [] };
      await saveSettings({ quoter });
      return { ok: true };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Distributor APIs (Pathway B — order push). Credentials never leave bg.
    // ═══════════════════════════════════════════════════════════════════════
    case "DIST_TEST": {
      const { adapter, cfg } = distLookup(settings, msg.adapterType, msg.cfg);
      return await adapter.test(cfg);
    }
    case "DIST_PA": {
      const { adapter, cfg } = distLookup(settings, null, null, msg.name);
      return { result: await adapter.getPriceAvailability(cfg, msg.items || []) };
    }
    case "DIST_CREATE_ORDER": {
      const { adapter, cfg } = distLookup(settings, null, null, msg.name);
      return await adapter.createOrder(cfg, msg.order || {});
    }
    case "DIST_ORDER_STATUS": {
      const { adapter, cfg } = distLookup(settings, null, null, msg.name);
      return await adapter.getOrderStatus(cfg, msg.orderId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Shell
    // ═══════════════════════════════════════════════════════════════════════
    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}


// Resolve a distributor adapter + its stored credentials.
// For TEST we may receive an unsaved cfg directly (msg.cfg); for live calls we
// look the distributor up by name so credentials never round-trip to content.
function distLookup(settings, adapterType, directCfg, name) {
  if (name != null) {
    const list = (settings.quoter && settings.quoter.distributors) || [];
    const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const n = norm(name);
    const d = list.find((x) => {
      const names = [x.name, ...((x.aliases) || [])].map(norm).filter(Boolean);
      return names.some((m) => m === n || (m.length >= 3 && n.length >= 3 && (m.includes(n) || n.includes(m))));
    });
    if (!d || !d.api || !d.api.adapter || d.api.adapter === "none") throw new Error(`No API configured for distributor "${name}".`);
    const adapter = getDistributorAdapter(d.api.adapter);
    if (!adapter) throw new Error(`Unknown distributor adapter: ${d.api.adapter}`);
    return { adapter, cfg: d.api };
  }
  const adapter = getDistributorAdapter(adapterType);
  if (!adapter) throw new Error(`Unknown distributor adapter: ${adapterType}`);
  return { adapter, cfg: directCfg || {} };
}

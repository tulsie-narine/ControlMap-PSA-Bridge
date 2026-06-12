/**
 * SentinelOne integration — v1 REST check subset from the
 * "SentinelOne integration for ControlMap" whitepaper.
 * Read-only: agents, threats, exclusions, token metadata.
 */

const V21 = "/web/api/v2.1";
const PAGE_CAP = 1000; // max items pulled per check (evidence samples are truncated)

function base(config) {
  let u = (config.tenantUrl || "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("SentinelOne tenant URL not configured.");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

async function s1(ctx, path, { method = "GET", params = null, body = null } = {}) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(base(ctx.config) + V21 + path + qs, {
    method,
    headers: {
      "Authorization": `ApiToken ${ctx.config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || json?.errors?.[0]?.title || (typeof json?.raw === "string" ? json.raw.slice(0, 200) : "") || res.statusText;
    const e = new Error(`SentinelOne API ${res.status}: ${detail}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

function scopeParams(config) {
  const p = {};
  if (config.siteIds?.trim()) p.siteIds = config.siteIds.trim();
  return p;
}

/** Total item count for a list endpoint using pagination.totalItems. */
async function countOf(ctx, path, params = {}) {
  const r = await s1(ctx, path, { params: { ...scopeParams(ctx.config), ...params, limit: 1 } });
  return r?.pagination?.totalItems ?? (Array.isArray(r?.data) ? r.data.length : 0);
}

/** Paged pull up to PAGE_CAP items. */
async function listAll(ctx, path, params = {}) {
  const out = [];
  let cursor = null;
  while (out.length < PAGE_CAP) {
    const p = { ...scopeParams(ctx.config), ...params, limit: 200 };
    if (cursor) p.cursor = cursor;
    const r = await s1(ctx, path, { params: p });
    out.push(...(r.data || []));
    cursor = r?.pagination?.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function agentSample(a) {
  return {
    computerName: a.computerName, siteId: a.siteId, machineType: a.machineType,
    isActive: a.isActive, lastActiveDate: a.lastActiveDate, agentVersion: a.agentVersion,
    isUpToDate: a.isUpToDate, mitigationMode: a.mitigationMode, infected: a.infected,
    activeThreats: a.activeThreats, osName: a.osName,
  };
}

function result(status, summary, details, evidenceTitle, snapshot) {
  return { status, summary, details, evidence: { title: evidenceTitle, snapshot } };
}

function notLicensedOr(err, fallback) {
  if (err.status === 403 || err.status === 404) {
    return { status: "not-licensed", summary: `Endpoint unavailable (${err.status}) — module may not be licensed.`, details: [err.message], evidence: null };
  }
  return fallback ? fallback(err) : { status: "error", summary: err.message, details: [], evidence: null };
}

export default {
  id: "sentinelone",
  name: "SentinelOne",
  version: "1.0.0",
  author: "ControlMap PSA Bridge",
  description: "Pulls security posture from a SentinelOne tenant (agents, threats, exclusions, console governance) as compliance checks with evidence snapshots.",
  configSchema: [
    { key: "tenantUrl", label: "Tenant URL", type: "text", placeholder: "yourtenant.sentinelone.net", required: true, help: "Your SentinelOne console hostname." },
    { key: "apiToken", label: "API token", type: "password", required: true, help: "Service-user token with read-only (Viewer) role. Settings → Users → Service Users." },
    { key: "siteIds", label: "Site IDs (optional)", type: "text", placeholder: "comma-separated", help: "Scope checks to specific SentinelOne sites (MSP: one site per client)." },
    { key: "coverageThreshold", label: "Coverage threshold %", type: "number", placeholder: "95", help: "Minimum % of active agents for coverage checks." },
    { key: "staleDays", label: "Stale agent threshold (days)", type: "number", placeholder: "14" },
    { key: "slaDays", label: "Threat SLA (days)", type: "number", placeholder: "7" },
  ],

  async test(ctx) {
    const total = await countOf(ctx, "/agents");
    return `Connected — ${total} agent(s) visible in scope.`;
  },

  checks: [
    {
      id: "S1-AM-01",
      title: "Endpoint protection coverage",
      description: "All agents in scope report active; coverage % above threshold.",
      frameworks: ["CIS 1.1", "CIS 10.1", "NIST CSF ID.AM-01", "800-171 3.4.1", "CMMC CM.L2-3.4.1", "ISO A.5.9/A.8.1", "SOC2 CC6.8/CC7.1"],
      keywords: ["endpoint", "protection", "antivirus", "malware", "edr", "coverage", "asset", "inventory", "agent"],
      async run(ctx) {
        const threshold = Number(ctx.config.coverageThreshold) || 95;
        const total = await countOf(ctx, "/agents", { isDecommissioned: false });
        const active = await countOf(ctx, "/agents", { isActive: true, isDecommissioned: false });
        const pct = total ? Math.round((active / total) * 1000) / 10 : 0;
        const inactive = total - active;
        const sample = inactive > 0 ? (await listAll(ctx, "/agents", { isActive: false, isDecommissioned: false })).slice(0, 50).map(agentSample) : [];
        const ok = total > 0 && pct >= threshold;
        return result(
          ok ? "pass" : "fail",
          `${active}/${total} agents active (${pct}%, threshold ${threshold}%).`,
          inactive ? [`${inactive} inactive agent(s).`] : [],
          "SentinelOne agent coverage snapshot",
          { metric: { total, active, pct, threshold }, inactiveAgents: sample }
        );
      },
    },
    {
      id: "S1-AM-02",
      title: "No stale agents",
      description: "No agent unseen for longer than the stale threshold that is not decommissioned.",
      frameworks: ["CIS 1.3", "NIST CSF ID.AM-08", "800-171 3.4.1", "ISO A.5.9", "SOC2 CC6.8"],
      keywords: ["asset", "inventory", "stale", "decommission", "endpoint", "managed"],
      async run(ctx) {
        const days = Number(ctx.config.staleDays) || 14;
        const stale = await listAll(ctx, "/agents", { lastActiveDate__lt: daysAgoIso(days), isDecommissioned: false });
        return result(
          stale.length === 0 ? "pass" : "fail",
          stale.length === 0 ? `No agents unseen for >${days} days.` : `${stale.length} agent(s) unseen for >${days} days.`,
          stale.slice(0, 10).map((a) => `${a.computerName} — last seen ${a.lastActiveDate}`),
          "SentinelOne stale agent report",
          { thresholdDays: days, staleAgents: stale.slice(0, 200).map(agentSample) }
        );
      },
    },
    {
      id: "S1-AM-06",
      title: "Server workloads protected",
      description: "Every server agent is active and in protect mode.",
      frameworks: ["CIS 10.1", "NIST CSF PR.PS", "ISO A.8.7", "SOC2 CC6.8"],
      keywords: ["server", "protection", "malware", "workload"],
      async run(ctx) {
        const servers = await listAll(ctx, "/agents", { machineTypes: "server", isDecommissioned: false });
        const bad = servers.filter((a) => !a.isActive || a.mitigationMode !== "protect");
        return result(
          servers.length && bad.length === 0 ? "pass" : (servers.length ? "fail" : "warning"),
          servers.length ? `${servers.length - bad.length}/${servers.length} servers active + protect mode.` : "No server agents found in scope.",
          bad.slice(0, 10).map((a) => `${a.computerName} — active:${a.isActive} mode:${a.mitigationMode}`),
          "SentinelOne server protection report",
          { servers: servers.slice(0, 200).map(agentSample), nonCompliant: bad.length }
        );
      },
    },
    {
      id: "S1-EP-01",
      title: "Protect mode enforced",
      description: "No agent reports detect-only mitigation mode.",
      frameworks: ["CIS 10.5", "NIST CSF PR.PS", "800-171 3.14.2", "CMMC SI.L1-3.14.2", "ISO A.8.7", "SOC2 CC6.8"],
      keywords: ["malicious", "malware", "mitigation", "protect", "detect", "prevention", "configuration"],
      async run(ctx) {
        const agents = await listAll(ctx, "/agents", { isActive: true, isDecommissioned: false });
        const detectOnly = agents.filter((a) => a.mitigationMode && a.mitigationMode !== "protect");
        const capped = agents.length >= PAGE_CAP ? [`Note: evaluation capped at ${PAGE_CAP} agents.`] : [];
        return result(
          detectOnly.length === 0 ? "pass" : "fail",
          detectOnly.length === 0 ? `All ${agents.length} evaluated agents in protect mode.` : `${detectOnly.length} agent(s) in detect-only mode.`,
          [...detectOnly.slice(0, 10).map((a) => `${a.computerName} — ${a.mitigationMode}`), ...capped],
          "SentinelOne mitigation mode report",
          { evaluated: agents.length, detectOnly: detectOnly.slice(0, 200).map(agentSample) }
        );
      },
    },
    {
      id: "S1-EP-05",
      title: "Agent version currency",
      description: "All agents report isUpToDate = true.",
      frameworks: ["CIS 7.4", "NIST CSF PR.PS-02", "800-171 3.14.1", "CMMC SI.L1-3.14.1", "ISO A.8.8", "SOC2 CC7.1"],
      keywords: ["patch", "update", "version", "flaw", "remediation", "software"],
      async run(ctx) {
        const total = await countOf(ctx, "/agents", { isDecommissioned: false });
        const outdated = await listAll(ctx, "/agents", { isUpToDate: false, isDecommissioned: false });
        return result(
          outdated.length === 0 ? "pass" : (outdated.length / Math.max(total, 1) < 0.05 ? "warning" : "fail"),
          outdated.length === 0 ? `All ${total} agents up to date.` : `${outdated.length}/${total} agent(s) not up to date.`,
          outdated.slice(0, 10).map((a) => `${a.computerName} — ${a.agentVersion}`),
          "SentinelOne agent version report",
          { total, outdated: outdated.slice(0, 200).map(agentSample) }
        );
      },
    },
    {
      id: "S1-TM-01",
      title: "No unresolved threats beyond SLA",
      description: "Zero unresolved / in-progress threats older than the SLA.",
      frameworks: ["CIS 17.4", "NIST CSF RS.MA", "800-171 3.6.1", "CMMC IR.L2-3.6.1", "ISO A.5.26", "SOC2 CC7.4"],
      keywords: ["threat", "incident", "response", "malicious", "unauthorized", "resolve", "monitor"],
      async run(ctx) {
        const days = Number(ctx.config.slaDays) || 7;
        const open = await listAll(ctx, "/threats", { incidentStatuses: "unresolved,in_progress", createdAt__lt: daysAgoIso(days) });
        return result(
          open.length === 0 ? "pass" : "fail",
          open.length === 0 ? `No open threats older than ${days} days.` : `${open.length} open threat(s) older than ${days} days.`,
          open.slice(0, 10).map((t) => `${t.threatInfo?.threatName || t.id} — ${t.threatInfo?.incidentStatus} since ${t.threatInfo?.identifiedAt}`),
          "SentinelOne open threat register",
          { slaDays: days, openThreats: open.slice(0, 200).map((t) => ({ id: t.id, name: t.threatInfo?.threatName, status: t.threatInfo?.incidentStatus, verdict: t.threatInfo?.analystVerdict, identifiedAt: t.threatInfo?.identifiedAt, agent: t.agentRealtimeInfo?.agentComputerName })) }
        );
      },
    },
    {
      id: "S1-TM-02",
      title: "No infected endpoints",
      description: "Zero agents flagged infected or carrying active threats.",
      frameworks: ["CIS 10.7", "NIST CSF DE.CM", "800-171 3.14.5", "CMMC SI.L1-3.14.5", "ISO A.8.7", "SOC2 CC7.2"],
      keywords: ["infected", "malware", "malicious", "endpoint", "threat", "monitor", "scan"],
      async run(ctx) {
        const infected = await listAll(ctx, "/agents", { infected: true });
        return result(
          infected.length === 0 ? "pass" : "fail",
          infected.length === 0 ? "No infected endpoints." : `${infected.length} infected endpoint(s).`,
          infected.slice(0, 10).map((a) => `${a.computerName} — ${a.activeThreats} active threat(s)`),
          "SentinelOne infected endpoint report",
          { infected: infected.slice(0, 200).map(agentSample) }
        );
      },
    },
    {
      id: "S1-TM-04",
      title: "Analyst triage complete",
      description: "No aged threats without an analyst verdict.",
      frameworks: ["CIS 17.4", "NIST CSF RS.AN", "ISO A.5.25", "SOC2 CC7.3"],
      keywords: ["triage", "analysis", "incident", "review", "verdict", "threat"],
      async run(ctx) {
        const days = Number(ctx.config.slaDays) || 7;
        const untriaged = await listAll(ctx, "/threats", { analystVerdicts: "undefined", createdAt__lt: daysAgoIso(days) });
        return result(
          untriaged.length === 0 ? "pass" : "warning",
          untriaged.length === 0 ? `No untriaged threats older than ${days} days.` : `${untriaged.length} untriaged threat(s) older than ${days} days.`,
          untriaged.slice(0, 10).map((t) => `${t.threatInfo?.threatName || t.id} — identified ${t.threatInfo?.identifiedAt}`),
          "SentinelOne untriaged threat list",
          { slaDays: days, untriaged: untriaged.slice(0, 200).map((t) => ({ id: t.id, name: t.threatInfo?.threatName, identifiedAt: t.threatInfo?.identifiedAt })) }
        );
      },
    },
    {
      id: "S1-GV-01",
      title: "Exclusions inventory within bounds",
      description: "No overly broad path exclusions; inventory exported as evidence.",
      frameworks: ["CIS 10.6", "NIST CSF PR.PS", "ISO A.8.7", "SOC2 CC6.8"],
      keywords: ["exclusion", "exception", "whitelist", "allowlist", "configuration", "change"],
      async run(ctx) {
        try {
          const exclusions = await listAll(ctx, "/exclusions");
          const broad = exclusions.filter((e) => {
            const v = (e.value || "").trim();
            return e.type === "path" && (v === "/" || v === "*" || /^[A-Za-z]:\\\\?\*?$/.test(v) || v.length <= 3);
          });
          return result(
            broad.length === 0 ? "pass" : "fail",
            `${exclusions.length} exclusion(s); ${broad.length} overly broad.`,
            broad.slice(0, 10).map((e) => `${e.type}: ${e.value}`),
            "SentinelOne exclusions inventory",
            { total: exclusions.length, broad: broad.map((e) => ({ type: e.type, value: e.value, scope: e.scopeName })), all: exclusions.slice(0, 200).map((e) => ({ type: e.type, value: e.value, description: e.description, scopeName: e.scopeName, createdAt: e.createdAt })) }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },
    {
      id: "S1-GV-05",
      title: "API token lifecycle governance",
      description: "Connector token expiry more than 30 days out.",
      frameworks: ["CIS 5.3", "NIST CSF PR.AA", "ISO A.5.17", "SOC2 CC6.1"],
      keywords: ["credential", "token", "key", "rotation", "access", "account"],
      async run(ctx) {
        const r = await s1(ctx, "/users/api-token-details", { method: "POST", body: { data: { apiToken: ctx.config.apiToken } } });
        const exp = r?.data?.expiresAt;
        if (!exp) return result("warning", "Token expiry not reported by tenant.", [], "SentinelOne token metadata", { raw: r?.data || null });
        const daysLeft = Math.floor((new Date(exp) - Date.now()) / 86400000);
        return result(
          daysLeft > 30 ? "pass" : (daysLeft > 0 ? "warning" : "fail"),
          `Token expires in ${daysLeft} day(s) (${exp}).`,
          [],
          "SentinelOne API token metadata",
          { expiresAt: exp, createdAt: r?.data?.createdAt, daysLeft }
        );
      },
    },
  ],
};

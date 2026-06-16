/**
 * Microsoft Defender / Microsoft 365 Security integration — v2
 *
 * Pulls GRC-relevant compliance posture from Microsoft Graph Security API
 * and the Defender for Endpoint (MDE) API via an Entra ID app registration
 * using client credentials (no user sign-in required).
 *
 * 29 checks across: endpoint health, vulnerability management, Secure Score,
 * threat detection, privileged access governance, MFA hygiene, identity
 * governance, app credential governance, audit logging, phishing simulation,
 * and MDI sensor health.
 *
 * Required app registration permissions (Application, NOT Delegated):
 *   Microsoft Graph
 *     SecurityEvents.Read.All                  — alerts
 *     SecurityIncident.Read.All                — incidents
 *     SecureScore.Read.All                     — Secure Score + control profiles
 *     DeviceManagementManagedDevices.Read.All  — Intune managed devices
 *     Policy.Read.All                          — Conditional Access + auth method policies
 *     IdentityRiskyUser.Read.All               — risky users
 *     IdentityRiskEvent.Read.All               — risk detections + risky service principals
 *     RoleManagement.Read.Directory            — role assignments (PIM)
 *     AuditLog.Read.All                        — sign-in logs, directory audit logs
 *     Reports.Read.All                         — MFA registration reports
 *     User.Read.All                            — guest user inventory
 *     Application.Read.All                     — app/SP credential expiry
 *     AccessReview.Read.All                    — access review definitions
 *     AttackSimulation.Read.All                — phishing simulation coverage
 *     AuditLogsQuery.Read.All                  — Purview audit log queries
 *     SecurityIdentitiesHealth.Read.All        — MDI sensor health (E5/MDI)
 *   WindowsDefenderATP (Defender for Endpoint)
 *     Machine.Read.All                         — device inventory + AV health
 *     Vulnerability.Read.All                   — CVE exposure
 *     Score.Read.All                           — exposure score
 *     SecurityRecommendation.Read.All          — security recommendations
 *     SecurityBaselinesAssessment.Read.All     — CIS/STIG baseline profiles
 *     Software.Read.All                        — software inventory (EOL)
 *
 * Grant admin consent for all permissions in Entra ID after registration.
 * Note: some checks require Entra ID P1/P2 or MDI/E5 licenses — they
 * return status "not-licensed" gracefully when the endpoint is unavailable.
 */

const PAGE_CAP = 1000;
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const MDE_SCOPE = "https://api.securitycenter.microsoft.com/.default";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MDE = "https://api.securitycenter.microsoft.com/api";

// ---------------------------------------------------------------------------
// Token cache (module-level; lives for the extension process lifetime)
// ---------------------------------------------------------------------------
const _tokenCache = {};

async function getToken(config, scope) {
  const key = `${config.tenantId}::${scope}`;
  const cached = _tokenCache[key];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Microsoft auth failed: ${data.error_description || data.error || res.statusText}`
    );
  }
  _tokenCache[key] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function graphFetch(ctx, path, params = null) {
  const token = await getToken(ctx.config, GRAPH_SCOPE);
  const qs = params ? "?" + new URLSearchParams(params) : "";
  const res = await fetch(GRAPH + path + qs, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail =
      json?.error?.message || json?.error?.code || res.statusText;
    const e = new Error(`Graph ${res.status} ${path}: ${detail}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function mdeFetch(ctx, path, params = null) {
  let token;
  try {
    token = await getToken(ctx.config, MDE_SCOPE);
  } catch (authErr) {
    // WindowsDefenderATP API not consented or MDE not licensed — surface as not-licensed
    const e = new Error(`MDE auth failed (WindowsDefenderATP permission not granted or MDE not licensed): ${authErr.message}`);
    e.status = 403;
    throw e;
  }
  const qs = params ? "?" + new URLSearchParams(params) : "";
  const res = await fetch(MDE + path + qs, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail =
      json?.error?.message || json?.error?.code || res.statusText;
    const e = new Error(`MDE ${res.status} ${path}: ${detail}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/** Follows @odata.nextLink to pull all items from a Graph list endpoint. */
async function graphListAll(ctx, path, params = null, cap = PAGE_CAP) {
  const out = [];
  let url = GRAPH + path + (params ? "?" + new URLSearchParams(params) : "");
  while (url && out.length < cap) {
    const token = await getToken(ctx.config, GRAPH_SCOPE);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const detail = json?.error?.message || json?.error?.code || res.statusText;
      const e = new Error(`Graph ${res.status} ${path}: ${detail}`);
      e.status = res.status;
      throw e;
    }
    out.push(...(json.value || []));
    url = json["@odata.nextLink"] || null;
  }
  return out;
}

/** Follows @odata.nextLink to pull all items from an MDE list endpoint. */
async function mdeListAll(ctx, path, params = null, cap = PAGE_CAP) {
  const out = [];
  let url = MDE + path + (params ? "?" + new URLSearchParams(params) : "");
  while (url && out.length < cap) {
    const token = await getToken(ctx.config, MDE_SCOPE);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const detail = json?.error?.message || json?.error?.code || res.statusText;
      const e = new Error(`MDE ${res.status} ${path}: ${detail}`);
      e.status = res.status;
      throw e;
    }
    out.push(...(json.value || []));
    url = json["@odata.nextLink"] || null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function result(status, summary, details, evidenceTitle, snapshot) {
  return { status, summary, details, evidence: { title: evidenceTitle, snapshot } };
}

function notLicensedOr(err, fallback) {
  // 403 = permission not granted, 404 = endpoint/resource not found,
  // 400 = bad request (sometimes returned for unlicensed features),
  // 501 = not implemented (feature not available in this SKU)
  if ([400, 403, 404, 501].includes(err.status)) {
    return {
      status: "not-licensed",
      summary: `Endpoint unavailable (${err.status}) — permission not granted or feature not licensed. Skipping check.`,
      details: [err.message],
      evidence: null,
    };
  }
  return fallback
    ? fallback(err)
    : { status: "error", summary: err.message, details: [], evidence: null };
}

function deviceSample(d) {
  return {
    id: d.id,
    name: d.computerDnsName || d.deviceName,
    os: d.osPlatform,
    healthStatus: d.healthStatus,
    onboardingStatus: d.onboardingStatus,
    avStatus: d.avStatus,
    riskScore: d.riskScore,
    exposureLevel: d.exposureLevel,
    lastSeen: d.lastSeen,
    isAadJoined: d.isAadJoined,
  };
}

// ---------------------------------------------------------------------------
// Integration export
// ---------------------------------------------------------------------------
export default {
  id: "defender",
  name: "Microsoft Defender",
  icon: "integrations/defender/logo.svg",
  version: "2.0.0",
  author: "ControlMap PSA Bridge",
  description:
    "29-check GRC evidence suite covering endpoint health, vulnerability management, Secure Score, threat detection, privileged access governance, MFA hygiene, identity governance, app credential expiry, audit logging, phishing simulation coverage, and MDI sensor health — all via Microsoft Graph and Defender for Endpoint APIs.",

  configSchema: [
    {
      key: "tenantId",
      label: "Tenant (Directory) ID",
      type: "text",
      required: true,
      help: "Found in Entra ID → Overview. e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    {
      key: "clientId",
      label: "Application (Client) ID",
      type: "text",
      required: true,
      help: "The App Registration client ID. Grant admin consent for all required Application permissions.",
    },
    {
      key: "clientSecret",
      label: "Client Secret",
      type: "password",
      required: true,
      help: "An active client secret from App Registration → Certificates & secrets.",
    },
    {
      key: "coverageThreshold",
      label: "Device onboarding threshold %",
      type: "number",
      placeholder: "95",
      help: "Minimum % of MDE-onboarded devices required to pass DEF-AM-01.",
    },
    {
      key: "staleDays",
      label: "Stale device threshold (days)",
      type: "number",
      placeholder: "14",
      help: "Devices not seen for longer than this are flagged stale.",
    },
    {
      key: "slaDays",
      label: "Incident/alert SLA (days)",
      type: "number",
      placeholder: "7",
      help: "Unresolved incidents/alerts older than this fail their check.",
    },
    {
      key: "secureScoreThreshold",
      label: "Secure Score threshold %",
      type: "number",
      placeholder: "60",
      help: "Minimum Secure Score percentage to pass DEF-SS-01.",
    },
    {
      key: "intuneCoverageThreshold",
      label: "Intune compliance threshold %",
      type: "number",
      placeholder: "90",
      help: "Minimum % of Intune-managed devices that must be compliant.",
    },
    {
      key: "maxGlobalAdmins",
      label: "Max Global Admin accounts",
      type: "number",
      placeholder: "5",
      help: "More than this many Global Admins will fail DEF-PA-01.",
    },
    {
      key: "mfaRegistrationThreshold",
      label: "MFA registration threshold %",
      type: "number",
      placeholder: "95",
      help: "Minimum % of users registered for MFA to pass DEF-ID-03.",
    },
    {
      key: "staleGuestDays",
      label: "Stale guest threshold (days)",
      type: "number",
      placeholder: "90",
      help: "Guest accounts not signed in for longer than this are flagged stale.",
    },
    {
      key: "secretExpiryWarnDays",
      label: "Secret expiry warning (days)",
      type: "number",
      placeholder: "30",
      help: "App/SP client secrets expiring within this many days are flagged.",
    },
    {
      key: "simulationMonths",
      label: "Simulation recency (months)",
      type: "number",
      placeholder: "12",
      help: "At least one phishing simulation must have run within this window.",
    },
  ],

  async test(ctx) {
    // Try endpoints in order; each may be absent depending on licensed permissions.
    // Returns on the first success so the user gets useful feedback regardless of SKU.
    const attempts = [
      async () => {
        const data = await graphFetch(ctx, "/security/secureScores", { $top: 1, $select: "currentScore,maxScore" });
        const s = data.value?.[0];
        const pct = s ? Math.round((s.currentScore / s.maxScore) * 100) : "?";
        return `Connected — Secure Score ${pct}% (${s?.currentScore ?? "?"} / ${s?.maxScore ?? "?"}).`;
      },
      async () => {
        const data = await graphFetch(ctx, "/identity/conditionalAccess/policies", { $top: 1, $select: "id" });
        return `Connected — Graph API reachable (${data.value?.length ?? 0} CA policy visible; Secure Score permission not granted).`;
      },
      async () => {
        const data = await graphFetch(ctx, "/users", { $top: 1, $select: "id" });
        return `Connected — Graph API reachable (limited permissions granted; add more for full check coverage).`;
      },
    ];
    for (const attempt of attempts) {
      try { return await attempt(); } catch { /* try next */ }
    }
    throw new Error("Could not reach any Microsoft Graph endpoint. Verify Tenant ID, Client ID, and Client Secret, then re-check admin consent.");
  },

  checks: [
    // -----------------------------------------------------------------------
    // Asset Management
    // -----------------------------------------------------------------------
    {
      id: "DEF-AM-01",
      title: "Endpoint MDE onboarding coverage",
      description:
        "All managed devices are onboarded to Defender for Endpoint and actively reporting.",
      frameworks: [
        "CIS 1.1", "CIS 10.1",
        "NIST CSF ID.AM-01", "NIST CSF PR.PS-01",
        "800-171 3.4.1", "CMMC CM.L2-3.4.1",
        "ISO A.5.9", "ISO A.8.1",
        "SOC2 CC6.8", "SOC2 CC7.1",
      ],
      keywords: ["endpoint", "protection", "coverage", "agent", "onboard", "inventory", "asset", "edr", "defender"],
      async run(ctx) {
        const threshold = Number(ctx.config.coverageThreshold) || 95;
        try {
          const all = await mdeListAll(ctx, "/machines");
          const onboarded = all.filter((d) => d.onboardingStatus === "Onboarded");
          const active = onboarded.filter((d) => d.healthStatus === "Active");
          const pct = onboarded.length
            ? Math.round((active.length / onboarded.length) * 1000) / 10
            : 0;
          const inactive = onboarded.filter((d) => d.healthStatus !== "Active");
          const ok = onboarded.length > 0 && pct >= threshold;
          return result(
            ok ? "pass" : "fail",
            `${active.length}/${onboarded.length} onboarded devices active (${pct}%, threshold ${threshold}%). ${all.length - onboarded.length} device(s) not fully onboarded.`,
            inactive.slice(0, 10).map((d) => `${d.computerDnsName} — ${d.healthStatus}`),
            "Defender device onboarding coverage snapshot",
            {
              metric: { total: all.length, onboarded: onboarded.length, active: active.length, pct, threshold },
              inactiveDevices: inactive.slice(0, 200).map(deviceSample),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-AM-02",
      title: "AV and EDR health",
      description:
        "No onboarded devices have antivirus disabled, sensor blocked, or real-time protection off.",
      frameworks: [
        "CIS 10.1", "CIS 10.5",
        "NIST CSF PR.PS-01",
        "800-171 3.14.2", "CMMC SI.L1-3.14.2",
        "ISO A.8.7",
        "SOC2 CC6.8",
      ],
      keywords: ["antivirus", "av", "edr", "sensor", "real-time", "tamper", "malware", "protection", "health"],
      async run(ctx) {
        try {
          const devices = await mdeListAll(ctx, "/machines", { $filter: "onboardingStatus eq 'Onboarded'" });
          const badAv = devices.filter((d) =>
            d.avStatus && !["Updated", "NotSupported"].includes(d.avStatus)
          );
          const sensorIssues = devices.filter((d) =>
            d.healthStatus && d.healthStatus !== "Active"
          );
          const allBad = [...new Set([...badAv, ...sensorIssues].map((d) => d.id))].map((id) =>
            devices.find((d) => d.id === id)
          );
          const ok = allBad.length === 0;
          return result(
            ok ? "pass" : "fail",
            ok
              ? `All ${devices.length} onboarded device(s) have healthy AV and sensor status.`
              : `${allBad.length} device(s) have AV or sensor health issues.`,
            allBad.slice(0, 10).map(
              (d) => `${d.computerDnsName} — AV: ${d.avStatus}, Sensor: ${d.healthStatus}`
            ),
            "Defender AV and EDR health snapshot",
            {
              total: devices.length,
              avIssues: badAv.slice(0, 200).map(deviceSample),
              sensorIssues: sensorIssues.slice(0, 200).map(deviceSample),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-AM-03",
      title: "No stale managed devices",
      description:
        "No onboarded device has been unseen beyond the stale threshold.",
      frameworks: [
        "CIS 1.3",
        "NIST CSF ID.AM-08",
        "800-171 3.4.1",
        "ISO A.5.9",
        "SOC2 CC6.8",
      ],
      keywords: ["stale", "inactive", "asset", "inventory", "endpoint", "managed", "last seen"],
      async run(ctx) {
        const days = Number(ctx.config.staleDays) || 14;
        try {
          const cutoff = daysAgoIso(days);
          const all = await mdeListAll(ctx, "/machines", {
            $filter: `onboardingStatus eq 'Onboarded' and lastSeen lt ${cutoff}`,
          });
          return result(
            all.length === 0 ? "pass" : "fail",
            all.length === 0
              ? `No onboarded devices unseen for >${days} days.`
              : `${all.length} device(s) not seen for >${days} days.`,
            all.slice(0, 10).map((d) => `${d.computerDnsName} — last seen ${d.lastSeen}`),
            "Defender stale device report",
            { thresholdDays: days, staleDevices: all.slice(0, 200).map(deviceSample) }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Secure Score & Configuration
    // -----------------------------------------------------------------------
    {
      id: "DEF-SS-01",
      title: "Microsoft Secure Score posture",
      description:
        "Tenant Secure Score percentage meets or exceeds the configured threshold.",
      frameworks: [
        "CIS 4", "CIS 18",
        "NIST CSF PR.PS", "NIST CSF GV.RM",
        "ISO A.5.31", "ISO A.8.8",
        "SOC2 CC9.1",
      ],
      keywords: ["secure score", "posture", "configuration", "hardening", "benchmark", "governance", "risk"],
      async run(ctx) {
        const threshold = Number(ctx.config.secureScoreThreshold) || 60;
        try {
          const data = await graphFetch(ctx, "/security/secureScores", { $top: 1 });
          const s = data.value?.[0];
          if (!s) return result("warning", "No Secure Score data returned.", [], "Microsoft Secure Score", {});
          const pct = Math.round((s.currentScore / s.maxScore) * 1000) / 10;
          const ok = pct >= threshold;
          return result(
            ok ? "pass" : (pct >= threshold * 0.8 ? "warning" : "fail"),
            `Secure Score: ${pct}% (${s.currentScore}/${s.maxScore}), threshold ${threshold}%.`,
            [`Score as of ${s.createdDateTime?.slice(0, 10) ?? "unknown"}.`],
            "Microsoft Secure Score snapshot",
            {
              currentScore: s.currentScore,
              maxScore: s.maxScore,
              pct,
              threshold,
              enabledServices: s.enabledServices,
              createdDateTime: s.createdDateTime,
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-SS-02",
      title: "Secure Score critical improvement actions",
      description:
        "No critical-category Secure Score control profiles remain at zero score.",
      frameworks: [
        "CIS 4.1", "CIS 4.2",
        "NIST CSF PR.PS-02",
        "ISO A.8.8", "ISO A.5.31",
        "SOC2 CC7.1",
      ],
      keywords: ["improvement", "recommendation", "secure score", "hardening", "control", "remediation", "configuration"],
      async run(ctx) {
        try {
          const profiles = await graphListAll(ctx, "/security/secureScoreControlProfiles");
          const critical = profiles.filter(
            (p) => p.tier === "Advanced" || p.implementationCost === "Low"
          );
          const unaddressed = critical.filter(
            (p) => (p.controlScore ?? 0) === 0 && p.controlStateUpdates?.[0]?.state !== "ThirdParty"
          );
          return result(
            unaddressed.length === 0 ? "pass" : "warning",
            unaddressed.length === 0
              ? `All ${critical.length} reviewed control profiles have at least partial score.`
              : `${unaddressed.length} unaddressed control profile(s) with zero score.`,
            unaddressed.slice(0, 10).map((p) => `${p.title} (${p.controlCategory})`),
            "Secure Score improvement actions snapshot",
            {
              total: profiles.length,
              reviewed: critical.length,
              unaddressed: unaddressed.slice(0, 200).map((p) => ({
                id: p.id,
                title: p.title,
                category: p.controlCategory,
                maxScore: p.maxScore,
                tier: p.tier,
                remediation: p.remediation,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Vulnerability Management
    // -----------------------------------------------------------------------
    {
      id: "DEF-VM-01",
      title: "No unpatched critical or high CVEs",
      description:
        "Zero critical or high-severity CVEs with available patches remain unremediated.",
      frameworks: [
        "CIS 7.4", "CIS 7.6",
        "NIST CSF ID.RA-01", "NIST CSF PR.PS-02",
        "800-171 3.14.1", "CMMC SI.L1-3.14.1",
        "ISO A.8.8",
        "SOC2 CC7.1",
      ],
      keywords: ["vulnerability", "cve", "patch", "remediation", "critical", "exploit", "flaw", "software"],
      async run(ctx) {
        try {
          const vulns = await mdeListAll(ctx, "/vulnerabilities", {
            $filter: "(severity eq 'Critical' or severity eq 'High') and patchable eq true",
          });
          const critical = vulns.filter((v) => v.severity === "Critical");
          const high = vulns.filter((v) => v.severity === "High");
          const ok = vulns.length === 0;
          return result(
            ok ? "pass" : (critical.length > 0 ? "fail" : "warning"),
            ok
              ? "No unpatched Critical or High CVEs."
              : `${critical.length} Critical, ${high.length} High unpatched CVE(s).`,
            vulns.slice(0, 10).map(
              (v) => `${v.id} (${v.severity}) — ${v.exposedMachines ?? "?"} device(s) exposed`
            ),
            "Defender vulnerability exposure snapshot",
            {
              summary: { critical: critical.length, high: high.length },
              vulnerabilities: vulns.slice(0, 200).map((v) => ({
                id: v.id,
                severity: v.severity,
                cvssV3: v.cvssV3,
                exposedMachines: v.exposedMachines,
                publishedOn: v.publishedOn,
                updatedOn: v.updatedOn,
                exploitabilityLevel: v.exploitabilityLevel,
                description: v.description?.slice(0, 200),
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-VM-02",
      title: "Device exposure score within bounds",
      description:
        "Tenant-level Defender exposure score is Low or Medium, not High.",
      frameworks: [
        "CIS 7",
        "NIST CSF ID.RA-02", "NIST CSF ID.RA-05",
        "800-171 3.14.3",
        "ISO A.8.8",
        "SOC2 CC7.1",
      ],
      keywords: ["exposure", "risk", "vulnerability", "posture", "attack surface", "score"],
      async run(ctx) {
        try {
          const data = await mdeFetch(ctx, "/exposureScore");
          const score = data.score ?? 0;
          const level = data.time ? (score >= 70 ? "High" : score >= 40 ? "Medium" : "Low") : (data.exposureLevel ?? "Unknown");
          const ok = !["High"].includes(level);
          return result(
            ok ? (level === "Low" ? "pass" : "warning") : "fail",
            `Exposure score: ${Math.round(score)} (${level}).`,
            [],
            "Defender exposure score snapshot",
            { score, level, time: data.time }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Threat Management
    // -----------------------------------------------------------------------
    {
      id: "DEF-TM-01",
      title: "No open incidents beyond SLA",
      description:
        "No active Defender XDR incidents older than the SLA threshold remain unresolved.",
      frameworks: [
        "CIS 17.4",
        "NIST CSF RS.MA-02", "NIST CSF RS.AN",
        "800-171 3.6.1", "CMMC IR.L2-3.6.1",
        "ISO A.5.26",
        "SOC2 CC7.4",
      ],
      keywords: ["incident", "response", "resolve", "sla", "threat", "breach", "investigation"],
      async run(ctx) {
        const days = Number(ctx.config.slaDays) || 7;
        try {
          const cutoff = daysAgoIso(days);
          const incidents = await graphListAll(ctx, "/security/incidents", {
            $filter: `status ne 'resolved' and createdDateTime lt ${cutoff}`,
            $select: "id,displayName,severity,status,createdDateTime,assignedTo,tags",
          });
          return result(
            incidents.length === 0 ? "pass" : "fail",
            incidents.length === 0
              ? `No unresolved incidents older than ${days} days.`
              : `${incidents.length} unresolved incident(s) older than ${days} days.`,
            incidents.slice(0, 10).map(
              (i) => `${i.displayName || i.id} — ${i.severity}, since ${i.createdDateTime?.slice(0, 10)}`
            ),
            "Defender open incident register",
            {
              slaDays: days,
              openIncidents: incidents.slice(0, 200).map((i) => ({
                id: i.id,
                name: i.displayName,
                severity: i.severity,
                status: i.status,
                createdDateTime: i.createdDateTime,
                assignedTo: i.assignedTo,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-TM-02",
      title: "No active high-severity alerts",
      description:
        "Zero high or critical severity alerts are in active/new state.",
      frameworks: [
        "CIS 8.11",
        "NIST CSF DE.CM-01", "NIST CSF DE.AE",
        "800-171 3.14.6",
        "ISO A.5.25", "ISO A.8.16",
        "SOC2 CC7.2", "SOC2 CC7.3",
      ],
      keywords: ["alert", "detection", "high severity", "critical", "monitor", "siem", "threat", "active"],
      async run(ctx) {
        try {
          const alerts = await graphListAll(ctx, "/security/alerts_v2", {
            $filter: "(severity eq 'high' or severity eq 'critical') and (status eq 'new' or status eq 'inProgress')",
            $select: "id,title,severity,status,createdDateTime,actorDisplayName,mitreTechniques,evidences",
          });
          return result(
            alerts.length === 0 ? "pass" : "fail",
            alerts.length === 0
              ? "No active high/critical severity alerts."
              : `${alerts.length} active high/critical alert(s).`,
            alerts.slice(0, 10).map(
              (a) => `${a.title || a.id} — ${a.severity}, ${a.status}, since ${a.createdDateTime?.slice(0, 10)}`
            ),
            "Defender active high-severity alert snapshot",
            {
              count: alerts.length,
              alerts: alerts.slice(0, 200).map((a) => ({
                id: a.id,
                title: a.title,
                severity: a.severity,
                status: a.status,
                createdDateTime: a.createdDateTime,
                actorDisplayName: a.actorDisplayName,
                mitreTechniques: a.mitreTechniques,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Identity Security
    // -----------------------------------------------------------------------
    {
      id: "DEF-ID-01",
      title: "Conditional Access MFA enforcement",
      description:
        "At least one enabled Conditional Access policy enforces MFA for users or all-apps grant.",
      frameworks: [
        "CIS 6.3", "CIS 6.5",
        "NIST CSF PR.AA-03",
        "800-171 3.5.3", "CMMC IA.L2-3.5.3",
        "ISO A.9.4.2",
        "SOC2 CC6.1", "SOC2 CC6.3",
      ],
      keywords: ["mfa", "multi-factor", "conditional access", "authentication", "identity", "policy", "access control"],
      async run(ctx) {
        try {
          const policies = await graphListAll(ctx, "/identity/conditionalAccess/policies");
          const enabled = policies.filter((p) => p.state === "enabled");
          const mfaPolicies = enabled.filter((p) => {
            const grants = p.grantControls?.builtInControls ?? [];
            return grants.includes("mfa") || grants.includes("compliantDevice") || grants.includes("domainJoinedDevice");
          });
          const blockHighRisk = enabled.filter((p) => {
            const grants = p.grantControls?.builtInControls ?? [];
            return grants.includes("block") && (
              p.conditions?.userRiskLevels?.includes("high") ||
              p.conditions?.signInRiskLevels?.includes("high")
            );
          });
          const ok = mfaPolicies.length > 0;
          return result(
            ok ? "pass" : "fail",
            ok
              ? `${mfaPolicies.length} MFA-enforcing CA policy(ies) enabled; ${blockHighRisk.length} high-risk block policy(ies).`
              : `No enabled Conditional Access policies enforce MFA. ${enabled.length} CA policies enabled total.`,
            !ok ? enabled.slice(0, 5).map((p) => `${p.displayName} — no MFA grant`) : [],
            "Conditional Access MFA policy snapshot",
            {
              total: policies.length,
              enabled: enabled.length,
              mfaPolicies: mfaPolicies.map((p) => ({
                id: p.id,
                name: p.displayName,
                state: p.state,
                grantControls: p.grantControls?.builtInControls,
                includeUsers: p.conditions?.users?.includeUsers,
                includeGroups: p.conditions?.users?.includeGroups,
              })),
              blockHighRiskPolicies: blockHighRisk.map((p) => ({ id: p.id, name: p.displayName })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-ID-02",
      title: "Risky users remediated",
      description:
        "No users remain in a high-risk, at-risk state without remediation.",
      frameworks: [
        "CIS 6.2",
        "NIST CSF ID.AM-07", "NIST CSF DE.CM-09",
        "800-171 3.5.1", "CMMC IA.L2-3.5.1",
        "ISO A.9.2.6",
        "SOC2 CC6.1", "SOC2 CC6.3",
      ],
      keywords: ["risky user", "identity", "compromised", "risk detection", "sign-in risk", "threat", "account"],
      async run(ctx) {
        try {
          const riskyUsers = await graphListAll(ctx, "/identityProtection/riskyUsers", {
            $filter: "riskState eq 'atRisk' and riskLevel eq 'high'",
            $select: "id,userDisplayName,userPrincipalName,riskLevel,riskState,riskLastUpdatedDateTime,isDeleted",
          });
          const active = riskyUsers.filter((u) => !u.isDeleted);
          return result(
            active.length === 0 ? "pass" : "fail",
            active.length === 0
              ? "No high-risk users in at-risk state."
              : `${active.length} high-risk user(s) require remediation.`,
            active.slice(0, 10).map(
              (u) => `${u.userDisplayName || u.userPrincipalName} — last updated ${u.riskLastUpdatedDateTime?.slice(0, 10)}`
            ),
            "Identity Protection risky user report",
            {
              count: active.length,
              riskyUsers: active.slice(0, 200).map((u) => ({
                displayName: u.userDisplayName,
                upn: u.userPrincipalName,
                riskLevel: u.riskLevel,
                riskState: u.riskState,
                riskLastUpdatedDateTime: u.riskLastUpdatedDateTime,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Intune Device Compliance
    // -----------------------------------------------------------------------
    {
      id: "DEF-IC-01",
      title: "Intune device compliance rate",
      description:
        "The percentage of Intune-managed devices in a compliant state meets the configured threshold.",
      frameworks: [
        "CIS 4.1", "CIS 4.2",
        "NIST CSF PR.PS-01",
        "800-171 3.4.1",
        "ISO A.8.9",
        "SOC2 CC6.8",
      ],
      keywords: ["intune", "mdm", "device compliance", "managed", "policy", "configuration", "enroll"],
      async run(ctx) {
        const threshold = Number(ctx.config.intuneCoverageThreshold) || 90;
        try {
          const devices = await graphListAll(ctx, "/deviceManagement/managedDevices", {
            $select: "id,deviceName,complianceState,operatingSystem,lastSyncDateTime,userDisplayName,userPrincipalName",
          });
          const compliant = devices.filter((d) => d.complianceState === "compliant");
          const nonCompliant = devices.filter((d) => d.complianceState !== "compliant");
          const pct = devices.length
            ? Math.round((compliant.length / devices.length) * 1000) / 10
            : 0;
          const ok = devices.length > 0 && pct >= threshold;
          return result(
            ok ? "pass" : (pct >= threshold * 0.85 ? "warning" : "fail"),
            `${compliant.length}/${devices.length} Intune-managed devices compliant (${pct}%, threshold ${threshold}%).`,
            nonCompliant.slice(0, 10).map(
              (d) => `${d.deviceName} — ${d.complianceState} (${d.operatingSystem})`
            ),
            "Intune device compliance snapshot",
            {
              metric: { total: devices.length, compliant: compliant.length, pct, threshold },
              nonCompliantDevices: nonCompliant.slice(0, 200).map((d) => ({
                name: d.deviceName,
                complianceState: d.complianceState,
                os: d.operatingSystem,
                lastSync: d.lastSyncDateTime,
                user: d.userDisplayName,
                upn: d.userPrincipalName,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Privileged Access Governance
    // -----------------------------------------------------------------------
    {
      id: "DEF-PA-01",
      title: "Excessive Global Administrator assignments",
      description:
        "The number of active Global Administrator role assignments does not exceed the configured threshold.",
      frameworks: [
        "CIS 5.4",
        "NIST CSF PR.AA-05",
        "800-171 3.1.6", "CMMC AC.L2-3.1.6",
        "ISO A.9.2.3",
        "SOC2 CC6.3",
      ],
      keywords: ["global admin", "privileged", "role", "administrator", "least privilege", "pim", "access control"],
      async run(ctx) {
        const max = Number(ctx.config.maxGlobalAdmins) || 5;
        try {
          // Global Administrator role definition ID (well-known, same in every tenant)
          const GLOBAL_ADMIN_ROLE_ID = "62e90394-69f5-4237-9190-012177145e10";
          const assignments = await graphListAll(ctx, "/roleManagement/directory/roleAssignments", {
            $filter: `roleDefinitionId eq '${GLOBAL_ADMIN_ROLE_ID}'`,
            $expand: "principal",
          });
          const active = assignments.filter((a) => !a.directoryScopeId || a.directoryScopeId === "/");
          const ok = active.length <= max;
          return result(
            ok ? "pass" : "fail",
            `${active.length} active Global Administrator assignment(s) (threshold: ${max}).`,
            active.slice(0, 10).map((a) => a.principal?.displayName || a.principalId),
            "Global Administrator assignment inventory",
            {
              threshold: max,
              count: active.length,
              assignments: active.slice(0, 200).map((a) => ({
                principalId: a.principalId,
                displayName: a.principal?.displayName,
                upn: a.principal?.userPrincipalName,
                directoryScopeId: a.directoryScopeId,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-PA-02",
      title: "No permanent active privileged role assignments",
      description:
        "Privileged roles (outside Global Admin) have no permanent active assignments — all privileged access uses JIT via PIM.",
      frameworks: [
        "CIS 5.4",
        "NIST CSF PR.AA-05",
        "800-171 3.1.6", "CMMC AC.L2-3.1.6",
        "ISO A.9.2.3",
        "SOC2 CC6.3",
      ],
      keywords: ["jit", "just-in-time", "permanent", "privileged", "pim", "role", "assignment", "zero standing"],
      async run(ctx) {
        // High-value privileged roles (well-known IDs, same in every tenant)
        const PRIVILEGED_ROLES = {
          "62e90394-69f5-4237-9190-012177145e10": "Global Administrator",
          "194ae4cb-b126-40b2-bd5b-6091b380977d": "Security Administrator",
          "f28a1f50-f6e7-4571-818b-6a12f2af6b6c": "SharePoint Administrator",
          "29232cdf-9323-42fd-ade2-1d097af3e4de": "Exchange Administrator",
          "b0f54661-2d74-4c50-afa3-1ec803f12efe": "Billing Administrator",
          "158c047a-c907-4556-b7ef-446551a6b5f7": "Cloud Application Administrator",
          "7be44c8a-adaf-4e2a-84d6-ab2649e08a13": "Privileged Authentication Administrator",
          "e8611ab8-c189-46e8-94e1-60213ab1f814": "Privileged Role Administrator",
        };
        try {
          const allAssignments = await graphListAll(ctx, "/roleManagement/directory/roleAssignments", {
            $expand: "principal",
          });
          const permanent = allAssignments.filter(
            (a) => PRIVILEGED_ROLES[a.roleDefinitionId] && a.directoryScopeId === "/"
          );
          // PIM eligible assignments don't appear here; only direct active assignments do
          return result(
            permanent.length === 0 ? "pass" : "warning",
            permanent.length === 0
              ? "No permanent active assignments found for monitored privileged roles."
              : `${permanent.length} permanent active privileged role assignment(s) detected — review for JIT eligibility.`,
            permanent.slice(0, 10).map(
              (a) => `${a.principal?.displayName || a.principalId} → ${PRIVILEGED_ROLES[a.roleDefinitionId] || a.roleDefinitionId}`
            ),
            "Permanent privileged role assignment inventory",
            {
              count: permanent.length,
              assignments: permanent.slice(0, 200).map((a) => ({
                principalId: a.principalId,
                displayName: a.principal?.displayName,
                upn: a.principal?.userPrincipalName,
                role: PRIVILEGED_ROLES[a.roleDefinitionId] || a.roleDefinitionId,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // MFA & Authentication Hygiene
    // -----------------------------------------------------------------------
    {
      id: "DEF-ID-03",
      title: "MFA registration coverage",
      description:
        "The percentage of users registered and capable of MFA meets the configured threshold.",
      frameworks: [
        "CIS 6.3", "CIS 6.5",
        "NIST CSF PR.AA-03",
        "800-171 3.5.3", "CMMC IA.L2-3.5.3",
        "ISO A.9.4.2",
        "SOC2 CC6.1",
      ],
      keywords: ["mfa", "multi-factor", "registration", "authenticator", "authentication", "coverage", "users"],
      async run(ctx) {
        const threshold = Number(ctx.config.mfaRegistrationThreshold) || 95;
        try {
          const data = await graphFetch(ctx, "/reports/authenticationMethods/usersRegisteredByFeature");
          const totalUsers = data.totalUserCount ?? 0;
          const mfaCapable = data.userRegistrationFeatureCounts?.find(
            (f) => f.feature === "mfaCapable"
          )?.userCount ?? 0;
          const pct = totalUsers ? Math.round((mfaCapable / totalUsers) * 1000) / 10 : 0;
          const ok = totalUsers > 0 && pct >= threshold;
          return result(
            ok ? "pass" : (pct >= threshold * 0.9 ? "warning" : "fail"),
            `${mfaCapable}/${totalUsers} users MFA-capable (${pct}%, threshold ${threshold}%).`,
            [`${totalUsers - mfaCapable} user(s) not MFA-capable.`],
            "MFA registration coverage snapshot",
            {
              totalUserCount: totalUsers,
              mfaCapable,
              pct,
              threshold,
              allFeatureCounts: data.userRegistrationFeatureCounts,
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-ID-04",
      title: "Legacy authentication blocked",
      description:
        "An enabled Conditional Access policy blocks legacy authentication clients, and no legacy auth sign-ins are detected.",
      frameworks: [
        "CIS 6.3",
        "NIST CSF PR.AA-03",
        "800-171 3.5.3",
        "ISO A.9.4.2",
        "SOC2 CC6.1",
      ],
      keywords: ["legacy auth", "basic auth", "imap", "pop3", "smtp", "modern auth", "conditional access", "block"],
      async run(ctx) {
        try {
          // Check for a CA policy that blocks legacy auth clients
          const policies = await graphListAll(ctx, "/identity/conditionalAccess/policies");
          const legacyBlockPolicies = policies.filter((p) => {
            if (p.state !== "enabled") return false;
            const apps = p.conditions?.clientAppTypes ?? [];
            const hasLegacyTarget = apps.includes("exchangeActiveSync") || apps.includes("other");
            const grants = p.grantControls?.builtInControls ?? [];
            const isBlock = p.grantControls?.operator === "OR" && grants.includes("block");
            return hasLegacyTarget && isBlock;
          });

          // Also sample sign-in logs for actual legacy auth activity (last 7 days)
          const cutoff = daysAgoIso(7);
          let legacySignIns = [];
          try {
            const signInData = await graphFetch(ctx, "/auditLogs/signIns", {
              $filter: `createdDateTime gt ${cutoff} and clientAppUsed ne 'Browser' and clientAppUsed ne 'Mobile Apps and Desktop clients' and clientAppUsed ne 'Other clients'`,
              $top: 50,
              $select: "userDisplayName,userPrincipalName,clientAppUsed,createdDateTime,ipAddress",
            });
            legacySignIns = signInData.value ?? [];
          } catch { /* sign-in log access may be restricted */ }

          const policyOk = legacyBlockPolicies.length > 0;
          const activityOk = legacySignIns.length === 0;
          const status = policyOk && activityOk ? "pass" : (!policyOk ? "fail" : "warning");
          return result(
            status,
            policyOk
              ? `${legacyBlockPolicies.length} CA policy(ies) block legacy auth. ${legacySignIns.length > 0 ? `${legacySignIns.length} legacy auth sign-in(s) still detected in last 7 days.` : "No legacy auth sign-ins detected."}`
              : `No CA policy found that blocks legacy authentication clients.`,
            legacySignIns.slice(0, 10).map(
              (s) => `${s.userDisplayName || s.userPrincipalName} — ${s.clientAppUsed} (${s.createdDateTime?.slice(0, 10)})`
            ),
            "Legacy authentication policy and sign-in snapshot",
            {
              blockPolicies: legacyBlockPolicies.map((p) => ({ id: p.id, name: p.displayName })),
              legacySignIns: legacySignIns.slice(0, 200),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-ID-05",
      title: "Microsoft Authenticator anti-MFA-fatigue settings",
      description:
        "Authenticator push notifications display app name and geographic location to mitigate MFA fatigue attacks.",
      frameworks: [
        "CIS 6.4",
        "NIST CSF PR.AA-03",
        "ISO A.9.4.2",
        "SOC2 CC6.1",
      ],
      keywords: ["mfa fatigue", "push notification", "authenticator", "number matching", "location", "app name"],
      async run(ctx) {
        try {
          const data = await graphFetch(
            ctx,
            "/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/microsoftAuthenticator"
          );
          const features = data.additionalProperties?.featureSettings ?? data.featureSettings ?? {};
          const appInfoEnabled = features.displayAppInformationRequiredState?.state === "enabled";
          const locationEnabled = features.displayLocationInformationRequiredState?.state === "enabled";
          const both = appInfoEnabled && locationEnabled;
          return result(
            both ? "pass" : (appInfoEnabled || locationEnabled ? "warning" : "fail"),
            both
              ? "Authenticator shows app name and location in push notifications."
              : `Anti-fatigue settings incomplete — app name: ${appInfoEnabled ? "✓" : "✗"}, location: ${locationEnabled ? "✓" : "✗"}.`,
            [],
            "Microsoft Authenticator feature settings snapshot",
            { appInfoState: features.displayAppInformationRequiredState, locationState: features.displayLocationInformationRequiredState, allFeatures: features }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Identity Governance
    // -----------------------------------------------------------------------
    {
      id: "DEF-ID-06",
      title: "Guest user governance",
      description:
        "No guest accounts are stale (not signed in beyond the threshold) or have never signed in.",
      frameworks: [
        "CIS 6.1",
        "NIST CSF PR.AA-01",
        "ISO A.9.2.1", "ISO A.9.2.5",
        "SOC2 CC6.2",
        "CMMC AC.L1-3.1.1",
      ],
      keywords: ["guest", "external", "b2b", "stale", "user", "identity", "account", "governance"],
      async run(ctx) {
        const days = Number(ctx.config.staleGuestDays) || 90;
        try {
          const guests = await graphListAll(ctx, "/users", {
            $filter: "userType eq 'Guest'",
            $select: "id,displayName,userPrincipalName,createdDateTime,signInActivity,externalUserState",
          });
          const cutoff = new Date(Date.now() - days * 86_400_000);
          const neverSignedIn = guests.filter((g) => !g.signInActivity?.lastSignInDateTime);
          const stale = guests.filter((g) => {
            const last = g.signInActivity?.lastSignInDateTime;
            return last && new Date(last) < cutoff;
          });
          const allBad = [...new Set([...neverSignedIn, ...stale].map((g) => g.id))];
          const ok = allBad.length === 0;
          return result(
            ok ? "pass" : (allBad.length / Math.max(guests.length, 1) < 0.1 ? "warning" : "fail"),
            `${guests.length} guest account(s) — ${neverSignedIn.length} never signed in, ${stale.length} inactive >${days} days.`,
            [...neverSignedIn.slice(0, 5).map((g) => `${g.displayName || g.userPrincipalName} — never signed in`),
             ...stale.slice(0, 5).map((g) => `${g.displayName || g.userPrincipalName} — last: ${g.signInActivity?.lastSignInDateTime?.slice(0, 10)}`)],
            "Guest account inventory snapshot",
            {
              total: guests.length,
              neverSignedIn: neverSignedIn.slice(0, 200).map((g) => ({ displayName: g.displayName, upn: g.userPrincipalName, created: g.createdDateTime })),
              stale: stale.slice(0, 200).map((g) => ({ displayName: g.displayName, upn: g.userPrincipalName, lastSignIn: g.signInActivity?.lastSignInDateTime })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-ID-07",
      title: "Risky service principals",
      description:
        "No service principals are in an at-risk state according to Entra ID Protection.",
      frameworks: [
        "CIS 5.3",
        "NIST CSF ID.AM-07",
        "ISO A.9.2.6",
        "SOC2 CC6.1",
      ],
      keywords: ["service principal", "app identity", "risky", "compromised", "identity protection", "workload"],
      async run(ctx) {
        try {
          const risky = await graphListAll(ctx, "/identityProtection/riskyServicePrincipals", {
            $filter: "riskState eq 'atRisk'",
            $select: "id,displayName,appId,riskLevel,riskState,riskLastUpdatedDateTime,isEnabled",
          });
          const active = risky.filter((sp) => sp.isEnabled !== false);
          return result(
            active.length === 0 ? "pass" : "fail",
            active.length === 0
              ? "No service principals in at-risk state."
              : `${active.length} service principal(s) at risk.`,
            active.slice(0, 10).map((sp) => `${sp.displayName || sp.appId} — ${sp.riskLevel} (${sp.riskLastUpdatedDateTime?.slice(0, 10)})`),
            "Risky service principal report",
            {
              count: active.length,
              riskyServicePrincipals: active.slice(0, 200).map((sp) => ({
                displayName: sp.displayName,
                appId: sp.appId,
                riskLevel: sp.riskLevel,
                riskState: sp.riskState,
                riskLastUpdatedDateTime: sp.riskLastUpdatedDateTime,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-IG-01",
      title: "Privileged role access reviews",
      description:
        "At least one recurring access review is configured for privileged role assignments.",
      frameworks: [
        "CIS 5.4",
        "NIST CSF PR.AA-05",
        "ISO A.9.2.5",
        "SOC2 CC6.3",
        "CMMC AC.L2-3.1.5",
      ],
      keywords: ["access review", "recertification", "privileged", "role", "governance", "identity", "periodic"],
      async run(ctx) {
        try {
          const reviews = await graphListAll(ctx, "/identityGovernance/accessReviews/definitions", {
            $filter: "status ne 'Completed'",
            $select: "id,displayName,status,scope,scheduleSettings,reviewers,instanceEnumerationScope",
          });
          // Look for reviews scoped to role assignments or directory roles
          const privilegedReviews = reviews.filter((r) => {
            const query = r.scope?.query ?? "";
            return query.includes("roleAssignment") || query.includes("roleDefinition") ||
              query.includes("roleManagement") || r.instanceEnumerationScope?.query?.includes("roleDefinition");
          });
          return result(
            privilegedReviews.length > 0 ? "pass" : "fail",
            privilegedReviews.length > 0
              ? `${privilegedReviews.length} active access review(s) cover privileged role assignments.`
              : "No active access reviews found scoped to privileged roles.",
            privilegedReviews.slice(0, 5).map((r) => `${r.displayName} — ${r.status}`),
            "Privileged role access review snapshot",
            {
              total: reviews.length,
              privilegedReviews: privilegedReviews.map((r) => ({
                id: r.id,
                name: r.displayName,
                status: r.status,
                recurrence: r.scheduleSettings?.recurrence?.pattern?.type,
                scope: r.scope?.query,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Application & Credential Governance
    // -----------------------------------------------------------------------
    {
      id: "DEF-GV-03",
      title: "App registration client secrets expiry",
      description:
        "No app registration has a client secret expiring within the warning window or already expired.",
      frameworks: [
        "CIS 5.3",
        "NIST CSF PR.AA-02",
        "ISO A.9.4.3",
        "SOC2 CC6.1",
      ],
      keywords: ["client secret", "credential", "app registration", "expiry", "rotation", "certificate", "key"],
      async run(ctx) {
        const warnDays = Number(ctx.config.secretExpiryWarnDays) || 30;
        try {
          const apps = await graphListAll(ctx, "/applications", {
            $select: "displayName,appId,passwordCredentials",
          });
          const now = Date.now();
          const warnCutoff = now + warnDays * 86_400_000;
          const expiredCreds = [];
          const expiringSoon = [];
          const longLived = [];
          for (const app of apps) {
            for (const cred of app.passwordCredentials ?? []) {
              const end = cred.endDateTime ? new Date(cred.endDateTime).getTime() : null;
              const lifeDays = cred.startDateTime && end
                ? Math.round((end - new Date(cred.startDateTime).getTime()) / 86_400_000) : null;
              const entry = { app: app.displayName, appId: app.appId, hint: cred.hint, endDateTime: cred.endDateTime, lifeDays };
              if (!end || end < now) expiredCreds.push(entry);
              else if (end < warnCutoff) expiringSoon.push(entry);
              else if (lifeDays && lifeDays > 365) longLived.push(entry);
            }
          }
          const critical = expiredCreds.length > 0;
          const warn = expiringSoon.length > 0;
          return result(
            critical ? "fail" : (warn || longLived.length > 0 ? "warning" : "pass"),
            `${expiredCreds.length} expired, ${expiringSoon.length} expiring within ${warnDays} days, ${longLived.length} with lifetime >1 year.`,
            [...expiredCreds.slice(0, 5).map((c) => `EXPIRED: ${c.app} — ${c.endDateTime?.slice(0, 10)}`),
             ...expiringSoon.slice(0, 5).map((c) => `EXPIRING: ${c.app} — ${c.endDateTime?.slice(0, 10)}`)],
            "App registration credential expiry snapshot",
            { warnDays, expired: expiredCreds.slice(0, 200), expiringSoon: expiringSoon.slice(0, 200), longLived: longLived.slice(0, 200) }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-GV-04",
      title: "Service principal secrets expiry",
      description:
        "No service principal has a client secret expiring within the warning window or already expired.",
      frameworks: [
        "CIS 5.3",
        "NIST CSF PR.AA-02",
        "ISO A.9.4.3",
        "SOC2 CC6.1",
      ],
      keywords: ["service principal", "client secret", "credential", "expiry", "rotation", "workload identity"],
      async run(ctx) {
        const warnDays = Number(ctx.config.secretExpiryWarnDays) || 30;
        try {
          // Only pull SPs that are apps (not managed identities) to keep the list manageable
          const sps = await graphListAll(ctx, "/servicePrincipals", {
            $filter: "servicePrincipalType eq 'Application'",
            $select: "displayName,appId,passwordCredentials",
          }, 500);
          const now = Date.now();
          const warnCutoff = now + warnDays * 86_400_000;
          const expiredCreds = [];
          const expiringSoon = [];
          for (const sp of sps) {
            for (const cred of sp.passwordCredentials ?? []) {
              const end = cred.endDateTime ? new Date(cred.endDateTime).getTime() : null;
              const entry = { sp: sp.displayName, appId: sp.appId, hint: cred.hint, endDateTime: cred.endDateTime };
              if (!end || end < now) expiredCreds.push(entry);
              else if (end < warnCutoff) expiringSoon.push(entry);
            }
          }
          const critical = expiredCreds.length > 0;
          return result(
            critical ? "fail" : (expiringSoon.length > 0 ? "warning" : "pass"),
            `${expiredCreds.length} expired, ${expiringSoon.length} expiring within ${warnDays} days across ${sps.length} service principals.`,
            [...expiredCreds.slice(0, 5).map((c) => `EXPIRED: ${c.sp} — ${c.endDateTime?.slice(0, 10)}`),
             ...expiringSoon.slice(0, 5).map((c) => `EXPIRING: ${c.sp} — ${c.endDateTime?.slice(0, 10)}`)],
            "Service principal credential expiry snapshot",
            { warnDays, expired: expiredCreds.slice(0, 200), expiringSoon: expiringSoon.slice(0, 200) }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // MDE — Deeper Vulnerability Management
    // -----------------------------------------------------------------------
    {
      id: "DEF-VM-03",
      title: "Security baseline compliance (CIS/STIG)",
      description:
        "Devices meet the configured CIS or STIG security baseline profiles in Defender Vulnerability Management.",
      frameworks: [
        "CIS 4.1", "CIS 4.2",
        "NIST CSF PR.PS-01",
        "800-171 3.4.1", "CMMC CM.L2-3.4.1",
        "ISO A.8.9",
        "SOC2 CC7.1",
      ],
      keywords: ["baseline", "cis", "stig", "hardening", "configuration", "benchmark", "drift", "secure configuration"],
      async run(ctx) {
        try {
          const profiles = await mdeListAll(ctx, "/baselineProfiles");
          if (!profiles.length) {
            return result("warning", "No security baseline profiles configured in Defender Vulnerability Management.", [], "Security baseline profiles snapshot", { profiles: [] });
          }
          const summary = profiles.map((p) => ({
            name: p.name,
            benchmark: p.benchmark,
            os: p.operatingSystem,
            passedDevices: p.passedDevices,
            totalDevices: p.totalDevices,
            pct: p.totalDevices ? Math.round((p.passedDevices / p.totalDevices) * 1000) / 10 : 0,
            status: p.status,
          }));
          const failing = summary.filter((p) => p.totalDevices > 0 && p.pct < 80);
          return result(
            failing.length === 0 ? "pass" : "fail",
            failing.length === 0
              ? `All ${profiles.length} baseline profile(s) ≥80% device compliance.`
              : `${failing.length} profile(s) below 80% device compliance.`,
            failing.slice(0, 5).map((p) => `${p.name} (${p.benchmark}): ${p.pct}% (${p.passedDevices}/${p.totalDevices})`),
            "Security baseline compliance snapshot",
            { profiles: summary }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-VM-04",
      title: "End-of-life software inventory",
      description:
        "No end-of-life or end-of-support software is running on managed devices.",
      frameworks: [
        "CIS 7.6",
        "NIST CSF ID.AM-02",
        "ISO A.8.8",
        "SOC2 CC7.1",
      ],
      keywords: ["eol", "end of life", "end of support", "eos", "software", "unsupported", "legacy", "patch"],
      async run(ctx) {
        try {
          const eolSoftware = await mdeListAll(ctx, "/software", { "$filter": "isEol eq true" });
          return result(
            eolSoftware.length === 0 ? "pass" : "fail",
            eolSoftware.length === 0
              ? "No end-of-life software detected across managed devices."
              : `${eolSoftware.length} end-of-life software product(s) detected.`,
            eolSoftware.slice(0, 10).map((s) => `${s.name} ${s.version} (${s.vendor}) — ${s.activeAlert ? "active alert" : "no alert"}`),
            "End-of-life software inventory snapshot",
            {
              count: eolSoftware.length,
              software: eolSoftware.slice(0, 200).map((s) => ({
                id: s.id,
                name: s.name,
                vendor: s.vendor,
                version: s.version,
                weaknesses: s.weaknesses,
                publicExploit: s.publicExploit,
                activeAlert: s.activeAlert,
                exposedMachines: s.exposedMachines,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    {
      id: "DEF-VM-05",
      title: "Active critical security recommendations",
      description:
        "No critical-severity security recommendations from Defender Vulnerability Management remain unaddressed.",
      frameworks: [
        "CIS 4", "CIS 7",
        "NIST CSF ID.RA-04",
        "ISO A.8.8",
        "CMMC CM.L2-3.4.2",
        "SOC2 CC7.1",
      ],
      keywords: ["recommendation", "remediation", "misconfiguration", "vulnerability", "posture", "attack surface"],
      async run(ctx) {
        try {
          const recs = await mdeListAll(ctx, "/recommendations", {
            "$filter": "severity eq 'Critical' and status eq 'Active'",
          });
          return result(
            recs.length === 0 ? "pass" : "fail",
            recs.length === 0
              ? "No active critical security recommendations."
              : `${recs.length} active critical security recommendation(s).`,
            recs.slice(0, 10).map((r) => `${r.recommendationName} — ${r.exposedMachinesCount ?? "?"} device(s) exposed`),
            "Critical security recommendations snapshot",
            {
              count: recs.length,
              recommendations: recs.slice(0, 200).map((r) => ({
                id: r.id,
                name: r.recommendationName,
                severity: r.severity,
                status: r.status,
                exposedMachinesCount: r.exposedMachinesCount,
                remediationType: r.remediationType,
                relatedComponent: r.relatedComponent,
                configScoreImpact: r.configScoreImpact,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Audit Logging
    // -----------------------------------------------------------------------
    {
      id: "DEF-AL-01",
      title: "Microsoft Purview Audit availability",
      description:
        "Microsoft Purview Audit is licensed, enabled, and accessible via the Graph API.",
      frameworks: [
        "CIS 8.2",
        "NIST CSF DE.AE-03", "NIST CSF GV.OC-03",
        "800-171 3.3.1", "CMMC AU.L2-3.3.1",
        "ISO A.8.15",
        "SOC2 CC7.2",
      ],
      keywords: ["audit log", "logging", "purview", "audit", "monitoring", "accountability", "forensic"],
      async run(ctx) {
        try {
          // Run a minimal 1-minute audit query to confirm the service is accessible
          const createRes = await graphFetch(ctx, "/security/auditLog/queries", null);
          // If we get here (200 or 201), the service is reachable
          return result(
            "pass",
            "Microsoft Purview Audit is accessible and responding.",
            [],
            "Purview Audit availability check",
            { accessible: true, checkedAt: new Date().toISOString() }
          );
        } catch (err) {
          if (err.status === 403 || err.status === 404) {
            // Try the simpler directoryAudits endpoint as a fallback
            try {
              await graphFetch(ctx, "/auditLogs/directoryAudits", { $top: 1 });
              return result("warning", "Purview Audit query API unavailable (may need Purview license), but directory audit logs are accessible.", [], "Audit log availability check", { purviewQueryApi: false, directoryAudits: true });
            } catch (err2) {
              return notLicensedOr(err2);
            }
          }
          return { status: "error", summary: err.message, details: [], evidence: null };
        }
      },
    },

    {
      id: "DEF-AL-02",
      title: "Legacy authentication sign-in activity",
      description:
        "No legacy authentication protocol sign-ins occurred in the last 7 days.",
      frameworks: [
        "CIS 6.3",
        "NIST CSF DE.CM-01",
        "ISO A.8.16",
        "SOC2 CC7.2",
      ],
      keywords: ["legacy auth", "imap", "pop3", "smtp", "basic auth", "sign-in", "detection", "monitor"],
      async run(ctx) {
        try {
          const cutoff = daysAgoIso(7);
          const data = await graphFetch(ctx, "/auditLogs/signIns", {
            $filter: `createdDateTime gt ${cutoff} and isInteractive eq false and clientAppUsed ne 'Mobile Apps and Desktop clients' and clientAppUsed ne 'Browser'`,
            $top: 100,
            $select: "userDisplayName,userPrincipalName,clientAppUsed,createdDateTime,ipAddress,appDisplayName",
          });
          const signIns = data.value ?? [];
          // Deduplicate by user+protocol
          const unique = Object.values(
            signIns.reduce((acc, s) => {
              const k = `${s.userPrincipalName}::${s.clientAppUsed}`;
              if (!acc[k]) acc[k] = { ...s, count: 0 };
              acc[k].count++;
              return acc;
            }, {})
          );
          return result(
            unique.length === 0 ? "pass" : "fail",
            unique.length === 0
              ? "No legacy authentication sign-ins in the last 7 days."
              : `${signIns.length} legacy auth sign-in event(s) from ${unique.length} unique user/protocol pair(s) in last 7 days.`,
            unique.slice(0, 10).map((s) => `${s.userDisplayName || s.userPrincipalName} — ${s.clientAppUsed} (${s.count} event(s))`),
            "Legacy authentication sign-in activity snapshot",
            { period: "7 days", totalEvents: signIns.length, uniquePairs: unique.length, signIns: unique.slice(0, 200) }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Email Security & Security Awareness
    // -----------------------------------------------------------------------
    {
      id: "DEF-AS-01",
      title: "Phishing simulation training coverage",
      description:
        "At least one Attack Simulation Training phishing simulation has been run within the configured window.",
      frameworks: [
        "CIS 14.2",
        "NIST CSF PR.AT-01",
        "ISO A.6.3",
        "SOC2 CC1.4",
      ],
      keywords: ["phishing", "simulation", "training", "awareness", "attack simulation", "security culture", "users"],
      async run(ctx) {
        const months = Number(ctx.config.simulationMonths) || 12;
        try {
          const sims = await graphListAll(ctx, "/security/attackSimulation/simulations", {
            $select: "displayName,status,createdDateTime,lastModifiedDateTime,report",
          });
          const cutoff = new Date(Date.now() - months * 30 * 86_400_000);
          const recent = sims.filter((s) => {
            const ts = s.lastModifiedDateTime || s.createdDateTime;
            return ts && new Date(ts) > cutoff && s.status === "succeeded";
          });
          const latest = recent.sort((a, b) =>
            new Date(b.lastModifiedDateTime || b.createdDateTime) - new Date(a.lastModifiedDateTime || a.createdDateTime)
          )[0];
          return result(
            recent.length > 0 ? "pass" : "fail",
            recent.length > 0
              ? `${recent.length} simulation(s) completed in the last ${months} months. Latest: "${latest?.displayName}".`
              : `No completed phishing simulations found in the last ${months} months.`,
            recent.slice(0, 5).map((s) => `${s.displayName} — ${(s.lastModifiedDateTime || s.createdDateTime)?.slice(0, 10)}`),
            "Attack simulation training coverage snapshot",
            {
              windowMonths: months,
              totalSimulations: sims.length,
              recentCompleted: recent.length,
              simulations: sims.slice(0, 200).map((s) => ({
                name: s.displayName,
                status: s.status,
                createdDateTime: s.createdDateTime,
                lastModifiedDateTime: s.lastModifiedDateTime,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },

    // -----------------------------------------------------------------------
    // Defender for Identity
    // -----------------------------------------------------------------------
    {
      id: "DEF-HI-01",
      title: "Defender for Identity sensor health",
      description:
        "No critical health issues exist across Microsoft Defender for Identity sensors and agents.",
      frameworks: [
        "NIST CSF DE.CM-06",
        "ISO A.8.16",
        "SOC2 CC7.1",
      ],
      keywords: ["defender for identity", "mdi", "sensor", "hybrid identity", "ad", "active directory", "health"],
      async run(ctx) {
        try {
          const issues = await graphListAll(ctx, "/security/identities/healthIssues", {
            $filter: "severity eq 'High' or severity eq 'Critical'",
            $select: "id,issueType,severity,status,description,recommendations,domainName,sensorDNSName,createdDateTime",
          });
          const open = issues.filter((i) => i.status !== "Closed");
          return result(
            open.length === 0 ? "pass" : "fail",
            open.length === 0
              ? "No critical or high-severity MDI health issues."
              : `${open.length} open critical/high MDI health issue(s).`,
            open.slice(0, 10).map((i) => `${i.issueType} — ${i.severity} on ${i.sensorDNSName || i.domainName}`),
            "Defender for Identity health issues snapshot",
            {
              count: open.length,
              issues: open.slice(0, 200).map((i) => ({
                issueType: i.issueType,
                severity: i.severity,
                status: i.status,
                sensor: i.sensorDNSName,
                domain: i.domainName,
                description: i.description,
                createdDateTime: i.createdDateTime,
              })),
            }
          );
        } catch (err) { return notLicensedOr(err); }
      },
    },
  ],
};

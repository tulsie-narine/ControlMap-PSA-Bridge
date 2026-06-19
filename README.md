# ScalePad Atlas

Browser extension (Chrome/Edge, Mac + Windows) that overlays [ControlMap](https://app.ctrlmap.com) with:

1. **PSA ticketing** — a *Create Ticket* button on action items that files pre-filled tickets in **Autotask**, **ConnectWise Manage**, or **HaloPSA**.
2. **An open integration framework** — a Grammarly-style launcher on every ControlMap page opens a context-aware dashboard panel where integrations (SentinelOne, Microsoft Defender) run compliance checks against your security stack, attach the results to ControlMap as **evidence with JSON snapshots**, and **propose assessment answers** (always human-confirmed).

```
git clone https://github.com/tulsie-narine/ControlMap-PSA-Bridge.git
```

![ScalePad Atlas panel](https://i.ibb.co/nsdNTsM9/Screenshot-2026-06-16-at-1-34-52-PM.png)

## How it works

Everything talks to documented APIs — no page scraping. The content script only reads context from the page (tenant subdomain, question code from the URL, action-item code from the panel title).

- **ScalePad/ControlMap API** (`x-api-key`): fetch action items and questions; create evidences (`POST /clients/{id}/evidences` with question mappings), upload JSON snapshots as evidence documents, save answers (`PUT .../questions/{code}/answer`).
- **Panel contexts**: on an assessment question page the panel ranks integration checks by keyword relevance to the question; with an action-item panel open it offers ticket creation; elsewhere it shows the integration dashboard.
- **Propose-confirm**: a check result maps to a suggested answer (pass→Yes, warning→Partially, fail→No). Nothing is written to ControlMap until the user confirms.
- A `declarativeNetRequest` rule strips `Origin`/`Referer` on API calls (ScalePad and most security APIs reject browser-origin requests).

## Repository layout

```
manifest.json                    MV3 manifest (module service worker)
background.js                    thin bootstrap — imports background/router.js
background/
  router.js                      message dispatcher
  integrationRunner.js           check execution, scoring, meta serialisation
  evidenceHelpers.js             sha256, ticket stats
core/
  store.js                       settings + migrations
  scalepad.js                    ScalePad/ControlMap client
  psa.js                         PSA adapters (Autotask / ConnectWise / HaloPSA)
  pdf.js                         dependency-free PDF writer
integrations/
  registry.js                    integration registry — add yours here
  shared.js                      shared helpers: result(), notLicensedOr(), daysAgoIso()
  auth/
    clientCredentials.js         shared OAuth2 client-credentials + session token cache
  sentinelone/                   SentinelOne integration (10 checks)
  defender/                      Microsoft Defender integration (29 checks)
scripts/
  validate-integrations.js       validates host declarations vs manifest + rules
content.js                       launcher FAB, dashboard panel, ticket modal
options.html / options.js        settings UI
rules.json                       Origin-strip declarativeNetRequest rule
docs/BUILDING_INTEGRATIONS.md   integration developer guide
```

## Install (unpacked)

Chrome/Edge → `chrome://extensions` → Developer mode → **Load unpacked** → select this folder. After version updates, remove + re-load (manifest changes need it). Settings persist.

## Configure

1. **ScalePad API** — API key + region → Test connection.
2. **Integrations** — configure credentials per integration (see per-integration setup below), then Test → Enable.
3. **PSA** — pick Autotask / ConnectWise / HaloPSA, add credentials, set ticket defaults.
4. **Tenant mappings** — map ControlMap subdomain → ScalePad client (→ optional PSA company). Manual mappings beat auto-detection.

---

## SentinelOne integration (v1 — 10 checks)

REST-only subset of the 37-check whitepaper catalog: coverage (S1-AM-01), stale agents (AM-02), server protection (AM-06), protect mode (EP-01), agent currency (EP-05), open threats vs SLA (TM-01), infected endpoints (TM-02), triage completeness (TM-04), exclusions hygiene (GV-01), API-token governance (GV-05). Each check stores a snapshot (capped samples) as the evidence document and cross-references CIS / NIST CSF / 800-171 / CMMC / ISO 27001 / SOC 2.

**Setup** — Settings → Users → Service Users in the SentinelOne console. Create a service user with Viewer (read-only) role. Copy the API token into the extension options.

Licensed-module endpoints degrade to **not-licensed** rather than fail.

---

## Microsoft Defender integration (v2 — 29 checks)

Pulls GRC-relevant compliance posture from **Microsoft Graph Security API** and the **Defender for Endpoint (MDE) REST API** via an Entra ID app registration using client credentials (no user sign-in required). Covers NIST CSF 2.0, CIS Controls v8, ISO 27001:2022, SOC 2 TSC, CMMC 2.0, and NIST 800-171.

### Checks

| ID | Title | Frameworks |
|----|-------|------------|
| DEF-AM-01 | Endpoint MDE onboarding coverage | CIS 1.1 · NIST CSF ID.AM-1 · CMMC CM.L2 |
| DEF-AM-02 | AV and EDR health | CIS 10.1 · NIST CSF PR.PS-1 · ISO A.8.7 |
| DEF-AM-03 | No stale managed devices | CIS 1.3 · NIST CSF ID.AM-1 · ISO A.8.1 |
| DEF-SS-01 | Microsoft Secure Score posture | CIS 4 · CIS 18 · NIST CSF PR.PS |
| DEF-SS-02 | Secure Score critical improvement actions | CIS 4.1 · CIS 4.2 · NIST CSF PR.PS-02 |
| DEF-VM-01 | No unpatched critical or high CVEs | CIS 7.4 · CIS 7.6 · NIST CSF ID.RA-01 |
| DEF-VM-02 | Device exposure score within bounds | CIS 7.1 · NIST CSF ID.RA-1 · ISO A.8.8 |
| DEF-TM-01 | No open incidents beyond SLA | CIS 17.4 · NIST CSF RS.AN-3 · SOC2 CC7.4 |
| DEF-TM-02 | No active high-severity alerts | CIS 8.11 · NIST CSF DE.AE-2 · ISO A.5.25 |
| DEF-ID-01 | Conditional Access MFA enforcement | CIS 6.3 · NIST CSF PR.AC-1 · ISO A.9.4 |
| DEF-ID-02 | Risky users remediated | CIS 6.1 · NIST CSF PR.AC-6 · ISO A.9.2 |
| DEF-IC-01 | Intune device compliance rate | CIS 4.6 · NIST CSF PR.PT-3 · ISO A.8.9 |
| DEF-PA-01 | Excessive Global Administrator assignments | CIS 5.4 · NIST CSF PR.AC-4 · ISO A.9.2 |
| DEF-PA-02 | No permanent active privileged role assignments | CIS 5.4 · NIST CSF PR.AC-4 · CMMC AC.L2 |
| DEF-ID-03 | MFA registration coverage | CIS 6.3 · CIS 4.5 · NIST CSF PR.AA-03 |
| DEF-ID-04 | No stale guest accounts | CIS 5.3 · NIST CSF PR.AC-1 · ISO A.9.2 |
| DEF-ID-05 | No expiring app/service principal credentials | CIS 5.2 · NIST CSF PR.AC-1 · ISO A.9.4 |
| DEF-ID-06 | Access reviews configured | CIS 5.1 · NIST CSF PR.AC-4 · ISO A.9.2 |
| DEF-ID-07 | No legacy authentication sign-ins | CIS 4.8 · NIST CSF PR.AC-3 · ISO A.9.4 |
| DEF-IG-01 | Identity governance — risky service principals | CIS 5.2 · NIST CSF ID.AM-3 · ISO A.9.2 |
| DEF-GV-03 | Audit logging enabled | CIS 8.2 · NIST CSF DE.AE-3 · SOC2 CC7.2 |
| DEF-GV-04 | Purview audit log retention | CIS 8.3 · NIST CSF DE.AE-3 · SOC2 CC7.2 |
| DEF-VM-03 | No end-of-life software | CIS 2.2 · NIST CSF ID.AM-2 · ISO A.8.8 |
| DEF-VM-04 | No high-risk security recommendations outstanding | CIS 7.1 · NIST CSF ID.RA-1 · ISO A.8.8 |
| DEF-VM-05 | CIS/STIG baseline compliance | CIS 4.1 · NIST CSF PR.PS-1 · CMMC CM.L2 |
| DEF-AL-01 | Excessive failed sign-ins | CIS 8.11 · NIST CSF DE.AE-2 · ISO A.9.4 |
| DEF-AL-02 | Directory audit log activity | CIS 8.2 · NIST CSF DE.AE-3 · SOC2 CC7.2 |
| DEF-AS-01 | Attack simulation training coverage | CIS 14.1 · NIST CSF PR.AT-1 · SOC2 CC1.4 |
| DEF-HI-01 | MDI sensor health | CIS 1.2 · NIST CSF DE.CM-1 · ISO A.8.16 |

Checks that require Entra ID P1/P2, Defender for Endpoint Plan 2, MDI, or E5 licensing return **not-licensed** gracefully when the endpoint is unavailable — missing licenses never cause the whole integration to fail.

### App registration setup

1. **Azure Portal** → Entra ID → App registrations → New registration. Name it anything (e.g. "ScalePad Atlas"). Single-tenant, no redirect URI.
2. Copy the **Application (client) ID** and **Directory (tenant) ID** into the extension options.
3. **Certificates & secrets** → New client secret → copy the value immediately.
4. **API permissions** → Add the following (all **Application**, not Delegated) → Grant admin consent:

**Microsoft Graph:**

| Permission | Used by |
|-----------|---------|
| `SecurityEvents.Read.All` | Secure Score, alerts |
| `SecurityIncident.Read.All` | Incidents |
| `SecurityIdentitiesHealth.Read.All` | MDI sensor health |
| `DeviceManagementManagedDevices.Read.All` | Intune compliance |
| `Policy.Read.All` | Conditional Access |
| `IdentityRiskyUser.Read.All` | Risky users |
| `IdentityRiskEvent.Read.All` | Risk detections |
| `RoleManagement.Read.Directory` | PIM role assignments |
| `AuditLog.Read.All` | Sign-in logs, directory audit |
| `AuditLogsQuery.Read.All` | Purview audit log queries |
| `Reports.Read.All` | MFA registration reports |
| `User.Read.All` | Guest user inventory |
| `Application.Read.All` | App credential expiry |
| `AccessReview.Read.All` | Access review definitions |
| `AttackSimulation.Read.All` | Phishing simulation coverage |

**WindowsDefenderATP** (under "APIs my organization uses" tab — only visible if MDE is activated):

| Permission | Used by |
|-----------|---------|
| `Machine.Read.All` | Device inventory, AV health |
| `Vulnerability.Read.All` | CVE exposure |
| `Score.Read.All` | Exposure score |
| `SecurityRecommendation.Read.All` | Security recommendations |
| `SecurityBaselinesAssessment.Read.All` | CIS/STIG baseline profiles |
| `Software.Read.All` | Software inventory (EOL) |

5. Reload the extension after saving credentials in options.

> **Note:** `SecureScore.Read.All` is covered by `SecurityEvents.Read.All` — you do not need to search for it separately. WindowsDefenderATP permissions are only required if Defender for Endpoint Plan 2 is licensed; without them the 9 MDE-specific checks return `not-licensed` and everything else continues to run.

---

## Ticket evidence collection

The launcher panel includes **Collect tickets as evidence** on any page where the client is resolved. Pick a date range, text filter, and PSA-specific filters, search, then review the ticket list — every ticket is pre-selected, and tickets missing a close date or description are flagged **⚠ weak**.

Each collection attaches two documents: a formatted **PDF report** for auditors and a **JSON evidence package** as the machine-readable system of record, including a `sha256` integrity hash stamped into both.

---

## Building your own integration

See **docs/BUILDING_INTEGRATIONS.md**. Short version: one folder, one `integration.js`, one `hosts.json`, one import line in `integrations/registry.js`. The options form, dashboard panel, evidence pipeline, and answer flow come free.

Run `node scripts/validate-integrations.js` to verify all API hosts are declared in `manifest.json` and `rules.json`.

---

## Notes & limitations

- Inline ticket button appears only on the *Update Action Item* panel (new unsaved items have no code).
- MV3 forbids remote code, so integrations ship with the extension — contribute via PR or maintain a fork.
- Safari is not supported (Safari doesn't apply `modifyHeaders` DNR rules to extension-initiated requests). Firefox port is feasible.
- Check evaluation caps fleet pulls at 1,000 records per check; evidence samples at 200 records.
- On-prem ConnectWise / custom Halo / custom S1 domains: add the host to `manifest.json`, `rules.json`, and `integrations/<id>/hosts.json`.

## Roadmap

- More integrations: Huntress, CrowdStrike Falcon, backup posture (Backup Radar), Okta, Google Workspace.
- Write-back to action items (ticket number note, status → In Progress).
- Scheduled check runs with drift alerts.
- Full 37-check SentinelOne catalog incl. GraphQL surfaces (XSPM vulnerabilities/misconfigurations, unified alerts).

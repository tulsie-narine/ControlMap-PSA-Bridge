# ControlMap Bridge

Browser extension (Chrome/Edge, Mac + Windows) that overlays [ControlMap](https://app.ctrlmap.com) with:

1. **PSA ticketing** — a *Create Ticket* button on action items that files pre-filled tickets in **Autotask**, **ConnectWise Manage**, or **HaloPSA**.
2. **An open integration framework** — a Grammarly-style launcher on every ControlMap page opens a context-aware panel where integrations (SentinelOne first; Defender, Huntress, etc. welcome via PR) run compliance checks against your security stack, attach the results to ControlMap as **evidence with JSON snapshots**, and **propose assessment answers** (always human-confirmed).

```
git clone https://github.com/tulsie-narine/ControlMap-PSA-Bridge.git
```

## How it works

Everything talks to documented APIs — no page scraping. The content script only reads context from the page (tenant subdomain, question code from the URL, action-item code from the panel title).

- **ScalePad/ControlMap API** (`x-api-key`): fetch action items and questions; create evidences (`POST /clients/{id}/evidences` with question mappings), upload JSON snapshots as evidence documents, save answers (`PUT .../questions/{code}/answer`).
- **Panel contexts**: on an assessment question page the panel ranks integration checks by keyword relevance to the question; with an action-item panel open it offers ticket creation; elsewhere it shows the integration dashboard.
- **Propose-confirm**: a check result maps to a suggested answer (pass→Yes, warning→Partially, fail→No). Nothing is written to ControlMap until the user confirms.
- A `declarativeNetRequest` rule strips `Origin`/`Referer` on API calls (ScalePad and most security APIs reject browser-origin requests).

## Repository layout

```
manifest.json            MV3 manifest (module service worker)
background.js            message router
core/store.js            settings + migrations
core/scalepad.js         ScalePad/ControlMap client (incl. evidence + answer writes)
core/psa.js              PSA adapters (Autotask / ConnectWise / HaloPSA)
integrations/registry.js integration registry — add yours here
integrations/sentinelone SentinelOne integration (10 checks)
content.js               launcher, panel, inline ticket button, ticket modal
options.html/options.js  settings UI (ScalePad, PSA, integrations, tenant mappings)
rules.json               Origin-strip DNR rule
docs/BUILDING_INTEGRATIONS.md   integration developer guide
```

## Install (unpacked)

Chrome/Edge → `chrome://extensions` → Developer mode → **Load unpacked** → select this folder. After version updates, remove + re-load (manifest changes need it). Settings persist.

## Configure

1. **ScalePad API** — API key + region → Test connection.
2. **Integrations** — e.g. SentinelOne: tenant URL + service-user API token (read-only Viewer role; Settings → Users → Service Users in the S1 console), optional site IDs to scope per client, thresholds → Test → Enable.
3. **PSA** — pick Autotask / ConnectWise / HaloPSA, add credentials, set ticket defaults (see per-PSA hints in the options page).
4. **Tenant mappings** — map ControlMap subdomain → ScalePad client (→ optional PSA company). Manual mappings beat auto-detection.

## SentinelOne integration (v1 — 10 checks)

REST-only subset of the 37-check whitepaper catalog: coverage (S1-AM-01), stale agents (AM-02), server protection (AM-06), protect mode (EP-01), agent currency (EP-05), open threats vs SLA (TM-01), infected endpoints (TM-02), triage completeness (TM-04), exclusions hygiene (GV-01), API-token governance (GV-05). Each check stores a snapshot (capped samples) as the evidence document and cross-references CIS / NIST CSF / 800-171 / CMMC / ISO 27001 / SOC 2.

Licensed-module endpoints degrade to **not-licensed** rather than fail. GraphQL surfaces (XSPM vulnerabilities/misconfigurations, unified alerts) are phase 2 — schemas need live-tenant validation.

## Ticket evidence collection (v0.4)

The launcher panel includes **Collect tickets as evidence** on any page where the client is resolved. Pick a date range, text filter, and PSA-specific filters (Autotask status/queue/type, ConnectWise board, Halo ticket type/status), search, then review the ticket list — every ticket is pre-selected, and tickets missing a close date or description are flagged **⚠ weak** so you attach defensible evidence, not noise.

Choose the destination:

- **Create new evidence** — `POST /clients/{id}/evidences` (mapped to the current assessment question when used from a question page), or
- **Add to existing evidence** — creates a **new evidence request** inside the chosen evidence (`POST /evidences/{id}/documents`) so recurring collections (quarterly incident reviews, monthly access-change pulls) accumulate under one evidence record.

Either way the attached document is a JSON evidence package: collection metadata (source PSA, client, query, collector version, timestamp), summary stats (found/closed/open/weak), per-ticket fields (id, number, title, status, type, priority, created/closed dates, owner, description), ticket notes for the first 25 tickets, and a `sha256` integrity hash stamped into both the package and the evidence description.

## Building your own integration

See **docs/BUILDING_INTEGRATIONS.md**. Short version: one folder, one `integration.js` exporting `{ id, name, configSchema, test, checks[] }`, one import line in `integrations/registry.js`, plus host permissions. The options form, panel UI, evidence pipeline, and answer flow come free.

## Notes & limitations

- Inline ticket button appears only on the *Update Action Item* panel (new unsaved items have no code).
- MV3 forbids remote code, so integrations ship with the extension — contribute via PR or maintain a fork.
- Safari is not supported (Safari doesn't apply `modifyHeaders` DNR rules to extension-initiated requests, which breaks the Origin-strip workaround). Firefox port is feasible.
- Check evaluation caps fleet pulls at 1,000 records per check; evidence samples at 200 records.
- On-prem ConnectWise / custom Halo / custom S1 domains: add the host to `manifest.json` + `rules.json`.

## Roadmap

- More integrations: Microsoft Defender, Huntress, backup posture (Backup Radar), M365 secure score.
- Write-back to action items (ticket number note, status → In Progress).\n- Saved evidence rules (named queries per control, re-run each period) + PDF rendering of ticket packages.
- Scheduled check runs with drift alerts.
- Full 37-check SentinelOne catalog incl. GraphQL surfaces.

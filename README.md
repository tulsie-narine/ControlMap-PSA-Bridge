# ControlMap PSA Bridge (v0.2)

Browser extension that adds a **Create Ticket** button to ControlMap action item panels and creates a pre-filled ticket in your PSA: **Autotask**, **ConnectWise Manage**, or **HaloPSA**. Chrome/Edge, Mac and Windows.

## How it works

1. A content script watches `*.app.ctrlmap.com` for the "Update Action Item: AI-XX" sidebar and injects the button.
2. The background worker resolves the tenant subdomain to a ScalePad client (manual Tenant mapping first, auto-probe fallback) and fetches the action item via the ScalePad API (`x-api-key`) — no page scraping.
3. A modal opens pre-filled: title, composed description (weakness, corrective action, milestones, requirements, link back), and PSA-specific fields loaded live from the selected PSA. ControlMap priority is label-matched to the PSA priority list.
4. Ticket is created via the PSA's API; the client → company choice is remembered per PSA.

A `declarativeNetRequest` rule strips `Origin`/`Referer` headers on API calls (ScalePad rejects browser-origin requests with 403 "Invalid CORS request").

## Install (unpacked)

```
git clone https://github.com/tulsie-narine/ControlMap-PSA-Bridge.git
```


Chrome/Edge → `chrome://extensions` → Developer mode → **Load unpacked** → select this folder. After updating a version, remove + re-load (manifest permission changes need it). Settings persist.

## Configure

**ScalePad API** — API key + region, Test connection.

**PSA tab — pick one of:**

- **Autotask** — API integration code, API username, secret (API-only user; zone auto-detected).
- **ConnectWise Manage** — site (`api-na.myconnectwise.net` for NA cloud; eu/au variants; or your on-prem host), company ID, API Member public/private keys (System → Members → API Members), and a `clientId` registered free at developer.connectwise.com. Tickets need board + status + priority; statuses/types reload when you change board.
- **HaloPSA** — base URL (`yourcompany.halopsa.com`), client ID + secret from Configuration → Integrations → HaloPSA API → Applications ("Client ID and Secret (Services)" auth; grant ticket read/edit and client read scopes). Ticket type is required; if your ticket type enforces extra required fields (category, impact, urgency) without defaults, creation may fail — pick a simpler type or set defaults in Halo.

Then **Test connection** and set **Ticket defaults** (loaded live from the PSA).

**Tenant mappings** — map ControlMap subdomain → ScalePad client (→ optionally PSA company). Manual mappings win over auto-detection.

Credentials live in `chrome.storage.local` on each technician's machine only.

## Notes & limitations

- Button appears only on the **Update** panel (a new unsaved action item has no code yet).
- On-prem ConnectWise or custom Halo domains: add your host to `host_permissions` in manifest.json and `requestDomains` in rules.json, then reload the extension.
- ConnectWise ticket summary is truncated to 100 chars (CW limit); full title remains in the description.
- Priority label matching is heuristic — verify in the modal.
- PSA adapters live in `background.js` (`autotaskAdapter`, `connectwiseAdapter`, `haloAdapter`); each implements test / getFields / searchCompanies / createTicket.

## Roadmap ideas

- Write-back to ControlMap (status → In Progress + ticket number note) after creation.
- Per-tenant default PSA (route different clients to different PSAs).
- Firefox support via webextension-polyfill.

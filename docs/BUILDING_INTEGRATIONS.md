# Building an integration

An integration pulls data from an external tool (EDR, MDR, identity, backup…), evaluates it into **checks** (pass / warning / fail / not-licensed / error), and lets the user push each result into ControlMap as an **evidence record** (with a JSON snapshot attached) and optionally a **proposed assessment answer** (pass→Yes, warning→Partially, fail→No — always human-confirmed in the panel).

Adding one touches **zero core files** except a one-line registry entry and a `hosts.json` file.

---

## 1. Create the module

`integrations/<your-id>/integration.js`:

```js
import { result, notLicensedOr, daysAgoIso } from "../shared.js";

export default {
  id: "crowdstrike",              // unique, lowercase, used as storage key
  name: "CrowdStrike Falcon",
  version: "1.0.0",
  author: "you",
  description: "One-line description shown in options + panel.",
  icon: "integrations/crowdstrike/logo.svg",   // SVG/PNG in your folder

  configSchema: [
    { key: "clientId",     label: "Client ID",     type: "text",     required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", required: true },
    { key: "region",       label: "Region",        type: "select",
      options: [{ value: "us-1", label: "US-1" }, { value: "eu-1", label: "EU-1" }],
      default: "us-1" },
    { key: "threshold",    label: "Coverage %",    type: "number",   placeholder: "95" },
  ],

  async test(ctx) {
    // throw on failure; return a human summary on success
    return "Connected — 250 devices visible.";
  },

  checks: [
    {
      id: "CS-AM-01",
      title: "Sensor coverage",
      description: "All devices in scope have an active Falcon sensor.",
      frameworks: ["CIS 1.1", "ISO A.8.1", "NIST CSF ID.AM-1"],
      keywords: ["endpoint", "coverage", "sensor", "inventory", "asset"],
      async run(ctx) {
        // ... call your API ...
        return result(
          "pass",
          "248/250 devices healthy (99.2%).",
          ["2 devices offline: HOST-A, HOST-B"],
          "CrowdStrike sensor coverage snapshot",
          { total: 250, healthy: 248, unhealthy: ["HOST-A", "HOST-B"] },
        );
      },
    },
  ],
};
```

---

## 2. Register it

`integrations/registry.js` — one import + one array entry:

```js
import crowdstrike from "./crowdstrike/integration.js";
export const INTEGRATIONS = [sentinelone, defender, crowdstrike];
```

Drop a `logo.svg` (or PNG) in your folder; without one a generic icon is used.

---

## 3. Declare API hosts

Create `integrations/<your-id>/hosts.json`:

```json
["api.crowdstrike.com", "login.us-1.crowdstrike.com"]
```

Then add those hosts to **both** files:

**`manifest.json`** → `host_permissions`:
```json
"https://api.crowdstrike.com/*",
"https://login.us-1.crowdstrike.com/*"
```

**`rules.json`** → `requestDomains`:
```json
"api.crowdstrike.com",
"login.us-1.crowdstrike.com"
```

> `rules.json` strips the `Origin` / `Referer` headers that most security-product APIs reject when called from a browser context.

Reload the extension (remove + Load unpacked) after manifest changes.

**Validate** that your hosts are correct:
```bash
node scripts/validate-integrations.js
```

---

## Shared utilities

Always import from `integrations/shared.js` — don't copy these into your file:

```js
import { result, notLicensedOr, daysAgoIso, toDateStr, parseResponse } from "../shared.js";
```

| Export | Purpose |
|--------|---------|
| `result(status, summary, details, evidenceTitle, snapshot)` | Build a standard check result object |
| `notLicensedOr(err, fallback?)` | Convert 400/401/403/404/501 errors to `not-licensed` |
| `daysAgoIso(days)` | ISO timestamp N days ago (for `$filter` params) |
| `toDateStr(date)` | Format Date or ISO string as `YYYY-MM-DD` |
| `parseResponse(res)` | Parse a fetch Response, throw typed error on non-2xx |

---

## OAuth2 integrations

For client-credentials auth (Azure, Okta, Google Workspace…) use the shared module — **don't copy the token cache pattern**:

```js
import { acquireToken, evictToken, tokenCacheKey } from "../auth/clientCredentials.js";

async function getToken(config) {
  return acquireToken({
    tokenUrl:     `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    clientId:     config.clientId,
    clientSecret: config.clientSecret,
    scope:        "https://graph.microsoft.com/.default",
    cacheKey:     tokenCacheKey(config.tenantId, config.clientId, "https://graph.microsoft.com/.default"),
  });
}
```

The token is cached in `chrome.storage.session` so it survives MV3 service-worker restarts (~30 s idle). On auth failure, call `evictToken(cacheKey)` so the next run fetches fresh.

---

## configSchema field types

| `type`       | Renders as                  | Extra properties |
|--------------|-----------------------------|------------------|
| `text`       | `<input type="text">`       | `placeholder`, `default` |
| `password`   | `<input type="password">`   | — |
| `number`     | `<input type="number">`     | `placeholder`, `default`, `min`, `max`, `step` |
| `select`     | `<select>`                  | `options: [{value, label}]`, `default` |
| `checkbox`   | `<input type="checkbox">`   | `checkboxLabel` (text next to checkbox) |
| `multi-text` | `<textarea>`                | `placeholder`; stored as `string[]` |

---

## How results flow into ControlMap

`APPLY_RESULT` (core, you don't implement this) does:

1. `POST /controlmap/v1/clients/{id}/evidences` — title `[Integration] Check title — date`, description from your summary/details/frameworks, `mappings.assessment_question_codes` set when applied from a question page.
2. `POST .../evidences/{id}/documents` — your `evidence.snapshot` uploaded as a JSON file (kept ≤10 MB; truncate big lists to samples).
3. Optional `PUT .../questions/{code}/answer` with the user-confirmed answer.

---

## Conventions

- **Read-only**: integrations must not write to the source tool.
- **Evidence over assertion**: snapshot the data that produced the verdict; cap samples (~200 records) so payloads stay small.
- **Degrade gracefully**: return `not-licensed` (not `fail`) when a module/endpoint isn't available — use `notLicensedOr(err)` from shared.js.
- **Keywords**: 5–10 lowercase terms an assessor's question would contain; they rank your checks on question pages.
- **Thresholds**: make SLAs/percentages configSchema fields with sensible defaults, not hardcoded.
- **Check IDs**: follow `<PREFIX>-<CATEGORY>-<NN>`, e.g. `CS-AM-01`. Categories: AM (asset management), VM (vuln management), ID (identity), PA (privileged access), TM (threat management), AL (audit/logging), IC (intune/compliance), GV (governance), AS (attack simulation), HI (health/infra), SS (secure score).
- Secrets live in `chrome.storage.local` on the technician's machine; never log them in summaries or snapshots.

# Building an integration

An integration pulls data from an external tool (EDR, MDR, identity, backup…), evaluates it into **checks** (pass / warning / fail / not-licensed / error), and lets the user push each result into ControlMap as an **evidence record** (with a JSON snapshot attached) and optionally a **proposed assessment answer** (pass→Yes, warning→Partially, fail→No — always human-confirmed in the panel).

Adding one touches **zero core files** except a one-line registry entry.

## 1. Create the module

`integrations/<your-id>/integration.js`:

```js
export default {
  id: "defender",                       // unique, lowercase
  name: "Microsoft Defender",
  version: "1.0.0",
  author: "you",
  description: "One-line description shown in options + panel.",

  // Renders the config form in extension options automatically.
  configSchema: [
    { key: "tenantId", label: "Tenant ID", type: "text", required: true, help: "..." },
    { key: "apiToken", label: "API token", type: "password", required: true },
    { key: "threshold", label: "Coverage %", type: "number", placeholder: "95" },
  ],

  // ctx = { config }  — config holds the user's values for configSchema keys.
  async test(ctx) {
    // throw on failure; return a human summary on success
    return "Connected — 250 devices visible.";
  },

  checks: [
    {
      id: "DEF-AM-01",                  // stable ID, used in evidence titles
      title: "Device coverage",
      description: "All devices report healthy sensor state.",
      frameworks: ["CIS 1.1", "ISO A.8.1"],   // shown in UI + evidence description
      keywords: ["endpoint", "coverage", "sensor", "inventory"],  // question matching
      async run(ctx) {
        // ...call your API...
        return {
          status: "pass",               // pass | warning | fail | not-licensed | error
          summary: "248/250 devices healthy (99.2%).",
          details: ["2 unhealthy: HOST-A, HOST-B"],     // bullet lines, keep short
          evidence: {
            title: "Defender device health snapshot",
            snapshot: { /* raw-ish JSON stored as the evidence document */ },
          },
        };
      },
    },
  ],
};
```

## 2. Register it

`integrations/registry.js`:

```js
import defender from "./defender/integration.js";
export const INTEGRATIONS = [sentinelone, defender];
```

## 3. Allow its API host

- `manifest.json` → add `"https://*.your-api-host.com/*"` to `host_permissions`
- `rules.json` → add `"your-api-host.com"` to `requestDomains` (strips the
  `Origin` header — most security-product APIs reject browser-origin requests)

Reload the extension (remove + Load unpacked after manifest changes).

## How results flow into ControlMap

`APPLY_RESULT` (core, you don't implement this) does:

1. `POST /controlmap/v1/clients/{id}/evidences` — title `[Integration] Check title — date`, description from your summary/details/frameworks, `mappings.assessment_question_codes` set when applied from a question page.
2. `POST .../evidences/{id}/documents` — your `evidence.snapshot` uploaded as a JSON file (kept ≤10 MB; truncate big lists to samples).
3. Optional `PUT .../questions/{code}/answer` with the user-confirmed answer.

## Conventions

- **Read-only**: integrations must not write to the source tool.
- **Evidence over assertion**: snapshot the data that produced the verdict; cap samples (~200 records) so payloads stay small.
- **Degrade gracefully**: return `not-licensed` (not `fail`) when a module/endpoint isn't available (403/404).
- **Keywords**: 5–10 lowercase terms an assessor's question would contain; they rank your checks on question pages.
- **Thresholds**: make SLAs/percentages configSchema fields with sensible defaults, not hardcoded.
- Secrets live in `chrome.storage.local` on the technician's machine; never log them in summaries or snapshots.

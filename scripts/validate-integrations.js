#!/usr/bin/env node
/**
 * scripts/validate-integrations.js
 *
 * Cross-checks every registered integration against manifest.json and
 * rules.json to ensure all required API domains are declared.
 *
 * Usage:
 *   node scripts/validate-integrations.js
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more problems found (missing host_permissions or requestDomains)
 *
 * How to add domain requirements to an integration:
 *   Export an `apiHosts` array from your integration file, e.g.
 *
 *     export const apiHosts = [
 *       "login.microsoftonline.com",
 *       "graph.microsoft.com",
 *       "api.securitycenter.microsoft.com",
 *     ];
 *
 *   This script will verify each host appears in both manifest.json
 *   host_permissions (as https://<host>/*) and rules.json requestDomains.
 *
 *   Alternatively, define `apiHosts` in a companion <id>.hosts.json file
 *   at integrations/<id>/hosts.json as a plain JSON array of strings.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, join }   from "path";
import { fileURLToPath }            from "url";
import { createRequire }            from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

// ── Load manifests ──────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const rules    = JSON.parse(readFileSync(join(ROOT, "rules.json"),    "utf8"));

/** All host_permissions entries, normalised to bare hostnames. */
const manifestHosts = new Set(
  (manifest.host_permissions || []).map((p) =>
    p.replace(/^https?:\/\/\*?\.?/, "").replace(/\/.*$/, ""),
  ),
);

/** All requestDomains entries from every rule. */
const rulesDomains = new Set(
  (rules || []).flatMap((r) => r.condition?.requestDomains || []),
);

// ── Discover integration host declarations ──────────────────────────────────

const integrationsDir = join(ROOT, "integrations");

/**
 * Read hosts.json for an integration if it exists.
 * Returns [] if the file is absent.
 */
function loadHostsJson(integId) {
  const path = join(integrationsDir, integId, "hosts.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`  ⚠  Could not parse integrations/${integId}/hosts.json: ${e.message}`);
    return [];
  }
}

/**
 * Attempt to extract apiHosts from an integration JS file via a simple regex.
 * This avoids needing to actually import the module (which would require Chrome APIs).
 *
 * Looks for:  export const apiHosts = ["host1", "host2"];
 *             or a multi-line array variant.
 */
function extractApiHostsFromJs(integId) {
  const path = join(integrationsDir, integId, "integration.js");
  if (!existsSync(path)) return [];
  const src = readFileSync(path, "utf8");
  // Match: export const apiHosts = [ ... ];
  const m = src.match(/export\s+const\s+apiHosts\s*=\s*\[([^\]]*)\]/s);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] || x[2]);
}

// ── Enumerate registered integrations ───────────────────────────────────────

// Parse registry.js with a simple regex to find import paths
const registrySrc = readFileSync(join(integrationsDir, "registry.js"), "utf8");
const importedIds = [...registrySrc.matchAll(/from\s+["']\.\/([^/]+)\/integration\.js["']/g)]
  .map((m) => m[1]);

if (!importedIds.length) {
  console.error("No integrations found in registry.js — nothing to validate.");
  process.exit(0);
}

// ── Validate ─────────────────────────────────────────────────────────────────

let problems = 0;

console.log(`\nControlMap Bridge — integration host validation`);
console.log(`${"─".repeat(54)}`);
console.log(`Checking ${importedIds.length} integration(s): ${importedIds.join(", ")}\n`);

for (const id of importedIds) {
  const hostsFromJson = loadHostsJson(id);
  const hostsFromJs   = extractApiHostsFromJs(id);
  const hosts         = [...new Set([...hostsFromJson, ...hostsFromJs])];

  if (!hosts.length) {
    console.log(`  ⚪  ${id}: no apiHosts declared (add integrations/${id}/hosts.json or export apiHosts)`);
    continue;
  }

  let ok = true;
  for (const host of hosts) {
    const inManifest = manifestHosts.has(host);
    const inRules    = rulesDomains.has(host);

    if (!inManifest || !inRules) {
      if (ok) {
        console.log(`  ❌  ${id}`);
        ok = false;
        problems++;
      }
      if (!inManifest) {
        console.log(`       manifest.json host_permissions missing: "https://${host}/*"`);
      }
      if (!inRules) {
        console.log(`       rules.json requestDomains missing: "${host}"`);
      }
    }
  }

  if (ok) {
    console.log(`  ✅  ${id}: ${hosts.join(", ")}`);
  }
}

console.log(`\n${"─".repeat(54)}`);
if (problems === 0) {
  console.log("All integrations validated — no missing host declarations.\n");
  process.exit(0);
} else {
  console.log(`${problems} problem(s) found. Fix the entries above then re-run.\n`);
  process.exit(1);
}

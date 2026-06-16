/**
 * integrations/shared.js
 *
 * Utility helpers shared across all integrations.
 * Import what you need — nothing here has side effects.
 *
 * Usage in an integration file:
 *   import { result, notLicensedOr, daysAgoIso } from "../shared.js";
 */

// ---------------------------------------------------------------------------
// Result builder
// ---------------------------------------------------------------------------

/**
 * Build a standard check result object.
 *
 * @param {"pass"|"warning"|"fail"|"not-licensed"|"error"} status
 * @param {string}   summary       - One-sentence human-readable outcome.
 * @param {string[]} details       - Bullet-point detail lines shown when expanded.
 * @param {string}   evidenceTitle - Title for the evidence snapshot (or "" / null).
 * @param {object}   snapshot      - JSON-serialisable evidence payload (or null).
 * @returns {{ status, summary, details, evidence }}
 */
export function result(status, summary, details, evidenceTitle, snapshot) {
  return {
    status,
    summary,
    details,
    evidence: evidenceTitle ? { title: evidenceTitle, snapshot } : null,
  };
}

// ---------------------------------------------------------------------------
// Error → not-licensed coercion
// ---------------------------------------------------------------------------

/**
 * Convert a known "endpoint unavailable" error into a `not-licensed` result
 * instead of letting it surface as an `error`.
 *
 * Status codes treated as not-licensed:
 *   400 — resource not provisioned / bad request on unlicensed endpoint
 *   401 — token valid but feature not consented (some Graph beta endpoints)
 *   403 — permission not granted / feature not licensed
 *   404 — endpoint doesn't exist in this tenant (no license)
 *   501 — not implemented (premium feature not enabled)
 *
 * @param {Error}         err
 * @param {function=}     fallback  - Optional function(err) called for other errors.
 * @returns {{ status, summary, details, evidence }}
 */
export function notLicensedOr(err, fallback) {
  const NOT_LICENSED_CODES = [400, 401, 403, 404, 501];
  if (NOT_LICENSED_CODES.includes(err.status)) {
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

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return an ISO-8601 timestamp for `days` ago from now.
 * Useful for building `$filter` query params.
 *
 * @param {number} days
 * @returns {string}  e.g. "2025-12-01T10:00:00.000Z"
 */
export function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Format a Date (or ISO string) as "YYYY-MM-DD".
 * @param {Date|string} date
 * @returns {string}
 */
export function toDateStr(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Generic HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a fetch Response into a plain object, throwing a typed Error on
 * non-2xx responses.  The thrown error always has a `.status` number property
 * so `notLicensedOr` can inspect it.
 *
 * @param {Response} res
 * @returns {Promise<object>}
 */
export async function parseResponse(res) {
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg =
      json?.error?.message ||
      json?.errors?.[0]?.detail ||
      json?.errors?.[0]?.title ||
      json?.message ||
      (typeof json?.raw === "string" ? json.raw.slice(0, 300) : "") ||
      res.statusText;
    const e = new Error(`HTTP ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

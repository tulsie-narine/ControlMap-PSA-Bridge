/**
 * integrations/auth/clientCredentials.js
 *
 * Shared OAuth 2.0 client-credentials token acquisition with a
 * chrome.storage.session-backed cache.
 *
 * Why chrome.storage.session instead of a module-level object?
 * MV3 service workers are terminated after ~30 s of inactivity and restart
 * on the next message. A module-level cache is wiped on every restart,
 * causing a round-trip to the token endpoint on the first check after any
 * idle period. chrome.storage.session persists for the browser session
 * (until the browser closes) and survives service worker restarts.
 *
 * Usage:
 *   import { acquireToken } from "../../integrations/auth/clientCredentials.js";
 *
 *   const token = await acquireToken({
 *     tokenUrl: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
 *     clientId,
 *     clientSecret,
 *     scope,            // e.g. "https://graph.microsoft.com/.default"
 *     cacheKey,         // unique string per tenant+scope combination
 *   });
 */

const SKEW_MS = 60_000; // refresh 60 s before expiry

/**
 * Acquire (or return a cached) OAuth2 client-credentials token.
 *
 * @param {{
 *   tokenUrl:     string,
 *   clientId:     string,
 *   clientSecret: string,
 *   scope:        string,
 *   cacheKey:     string,
 * }} opts
 * @returns {Promise<string>} Bearer token
 */
export async function acquireToken({ tokenUrl, clientId, clientSecret, scope, cacheKey }) {
  // ── 1. Check session cache ──────────────────────────────────────────────
  const storageKey = `_token_${cacheKey}`;
  try {
    const stored = await chrome.storage.session.get(storageKey);
    const cached = stored[storageKey];
    if (cached?.token && cached.expiresAt > Date.now() + SKEW_MS) {
      return cached.token;
    }
  } catch {
    // storage.session may not be available in older Chromium — fall through
  }

  // ── 2. Fetch a fresh token ───────────────────────────────────────────────
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || res.statusText;
    const e = new Error(`OAuth2 token request failed: ${msg}`);
    e.status = res.status || 401;
    throw e;
  }

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  const entry = { token: data.access_token, expiresAt };

  // ── 3. Persist to session storage (best-effort) ──────────────────────────
  try {
    await chrome.storage.session.set({ [storageKey]: entry });
  } catch {
    // Not fatal — we still have the token for this call
  }

  return entry.token;
}

/**
 * Evict a cached token (e.g. on auth failure so the next call re-fetches).
 *
 * @param {string} cacheKey
 */
export async function evictToken(cacheKey) {
  try {
    await chrome.storage.session.remove(`_token_${cacheKey}`);
  } catch { /* ignore */ }
}

/**
 * Build a canonical cache key from the parts that uniquely identify a token.
 * Includes the scope so multi-API integrations (e.g. Graph + MDE) cache separately.
 *
 * @param {string} tenantId
 * @param {string} clientId
 * @param {string} scope
 * @returns {string}
 */
export function tokenCacheKey(tenantId, clientId, scope) {
  // scope can be long; hash it down to something storage-key-safe
  return `${tenantId}::${clientId}::${btoa(scope).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
}

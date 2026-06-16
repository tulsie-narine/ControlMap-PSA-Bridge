/**
 * background/evidenceHelpers.js
 *
 * Pure utility functions used by the evidence collection flow.
 * No Chrome API calls, no imports — easy to unit-test.
 */

/**
 * SHA-256 hex digest of a string using the Web Crypto API.
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Summarise a ticket list into { found, closed, open, weak } counts.
 * "Weak" means the ticket is missing a close date or a non-empty description.
 *
 * @param {object[]} tickets
 * @returns {{ found: number, closed: number, open: number, weak: number }}
 */
export function ticketStats(tickets) {
  const closed = tickets.filter((t) => t.closedAt).length;
  const weak   = tickets.filter((t) => !t.closedAt || !(t.description || "").trim()).length;
  return { found: tickets.length, closed, open: tickets.length - closed, weak };
}

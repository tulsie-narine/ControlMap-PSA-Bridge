/**
 * background/integrationRunner.js
 *
 * All integration-framework logic: running checks, scoring them against
 * ControlMap assessment questions, and serialising integration metadata
 * for the content-script panel.
 *
 * Imported by background/router.js — do not import router.js from here.
 */

import { integrationConfig, saveLastRun } from "../core/store.js";
import { INTEGRATIONS, getIntegration } from "../integrations/registry.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map a check result status to a ControlMap yes/no/partial answer. */
export function statusToAnswer(status) {
  return status === "pass"    ? "Yes"
       : status === "warning" ? "Partially"
       : status === "fail"    ? "No"
       : null;
}

/**
 * Score how relevant a check is to an assessment question by keyword overlap.
 * Returns 0 when there is no question text.
 */
export function scoreCheckForQuestion(check, questionText) {
  const text = (questionText || "").toLowerCase();
  if (!text) return 0;
  let score = 0;
  for (const k of check.keywords || []) if (text.includes(k.toLowerCase())) score++;
  return score;
}

/** Build a ctx object for check.run() / integration.test(). */
export function checkCtx(settings, integration) {
  const cfg = integrationConfig(settings, integration.id);
  if (!cfg.enabled) throw new Error(`${integration.name} is not enabled. Enable it in extension options.`);
  return { config: cfg.config };
}

/**
 * Serialise integration metadata + check stubs for the panel/options.
 * Strips the run() function; adds `enabled` and `configured` flags.
 */
export function integrationMeta(settings, i) {
  const cfg = integrationConfig(settings, i.id);
  return {
    id:          i.id,
    name:        i.name,
    version:     i.version,
    description: i.description,
    icon:        i.icon || null,
    configSchema: i.configSchema,
    enabled:     !!cfg.enabled,
    configured:  i.configSchema.filter((f) => f.required).every((f) => (cfg.config[f.key] || "").trim?.() !== ""),
    checks: i.checks.map((c) => ({
      id:          c.id,
      title:       c.title,
      description: c.description,
      frameworks:  c.frameworks,
      keywords:    c.keywords,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single check and persist the result.
 *
 * @param {object} settings  - Full settings from store.getSettings()
 * @param {string} integrationId
 * @param {string} checkId
 * @returns {Promise<object>}  Result object (status, summary, details, evidence, suggestedAnswer)
 */
export async function runCheck(settings, integrationId, checkId) {
  const integration = getIntegration(integrationId);
  const check = integration.checks.find((c) => c.id === checkId);
  if (!check) throw new Error(`Unknown check "${checkId}" in integration "${integrationId}".`);

  const ctx = checkCtx(settings, integration);
  let res;
  try {
    res = await check.run(ctx);
  } catch (err) {
    res = { status: "error", summary: err.message || String(err), details: [], evidence: null };
  }
  res.suggestedAnswer = statusToAnswer(res.status);
  await saveLastRun(integrationId, checkId, res);
  return res;
}

/**
 * Build the full panel-context payload for an array of integrations,
 * optionally ranked/scored against a ControlMap question.
 *
 * @param {object} settings
 * @param {string|null} questionCode
 * @param {string}      questionText  - Combined name+question+description of the question.
 * @returns {object[]}  Array of integration meta objects with check.score + check.lastRun
 */
export function buildPanelIntegrations(settings, questionCode, questionText) {
  return INTEGRATIONS.map((i) => {
    const meta = integrationMeta(settings, i);
    meta.checks = meta.checks.map((c) => ({
      ...c,
      score:   questionCode ? scoreCheckForQuestion(c, questionText || questionCode) : 0,
      lastRun: settings.lastRuns?.[i.id]?.[c.id] || null,
    }));
    if (questionCode) meta.checks.sort((a, b) => b.score - a.score);
    return meta;
  });
}

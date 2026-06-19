/** Settings store with v0.1/v0.2 migrations. */

export const DEFAULT_SETTINGS = {
  psa: "autotask",
  scalepadApiKey: "",
  scalepadRegion: "us",
  autotask: { integrationCode: "", userName: "", secret: "", zoneUrl: "" },
  connectwise: { siteUrl: "", companyId: "", publicKey: "", privateKey: "", clientId: "" },
  halo: { baseUrl: "", clientId: "", clientSecret: "", tenant: "", tokenCache: null },
  psaDefaults: { autotask: {}, connectwise: {}, halo: {} },
  defaults: null,            // legacy v0.1
  clientMap2: { autotask: {}, connectwise: {}, halo: {} },
  clientMap: null,           // legacy v0.1
  tenantMap: {},
  tenantCache: {},
  // integration framework: { [integrationId]: { enabled: bool, config: {...} } }
  integrations: {},
  // last check results: { [integrationId]: { [checkId]: {result, ranAt} } }
  lastRuns: {},
  // pre-mapped evidence targets, per integration + ControlMap client:
  // { [integrationId]: { [clientId]: { [checkId]: { mode:"skip"|"new"|"existing", title?, evidenceId? } } } }
  evidenceMap: {},
  // Quoter procurement: API key (falls back to scalepadApiKey) + distributor directory
  // distributors: [{ name, email }]  — name should match the "Supplier" on Quoter items
  quoter: { distributors: [] },
};

export async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (s.defaults && Object.keys(s.psaDefaults.autotask).length === 0) {
    s.psaDefaults.autotask = {
      status: s.defaults.statusValue || "",
      queueID: s.defaults.queueID || "",
      ticketType: s.defaults.ticketTypeValue || "",
      ticketCategory: s.defaults.ticketCategoryValue || "",
      source: s.defaults.sourceValue || "",
    };
    await chrome.storage.local.set({ psaDefaults: s.psaDefaults });
  }
  if (s.clientMap && Object.keys(s.clientMap2.autotask).length === 0) {
    s.clientMap2.autotask = s.clientMap;
    await chrome.storage.local.set({ clientMap2: s.clientMap2 });
  }
  return s;
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

export function integrationConfig(settings, id) {
  return settings.integrations?.[id] || { enabled: false, config: {} };
}

export async function saveLastRun(integrationId, checkId, result) {
  const { lastRuns } = await chrome.storage.local.get({ lastRuns: {} });
  lastRuns[integrationId] = lastRuns[integrationId] || {};
  lastRuns[integrationId][checkId] = { result, ranAt: new Date().toISOString() };
  await chrome.storage.local.set({ lastRuns });
}


export function getEvidenceMap(settings, integrationId, clientId) {
  return settings.evidenceMap?.[integrationId]?.[clientId] || {};
}

export async function setEvidenceMap(integrationId, clientId, map) {
  const { evidenceMap } = await chrome.storage.local.get({ evidenceMap: {} });
  evidenceMap[integrationId] = evidenceMap[integrationId] || {};
  evidenceMap[integrationId][clientId] = map || {};
  await chrome.storage.local.set({ evidenceMap });
}

/** Persist a single check's mapping (used to cache a newly-created evidence id). */
export async function patchEvidenceMapEntry(integrationId, clientId, checkId, entry) {
  const { evidenceMap } = await chrome.storage.local.get({ evidenceMap: {} });
  evidenceMap[integrationId] = evidenceMap[integrationId] || {};
  evidenceMap[integrationId][clientId] = evidenceMap[integrationId][clientId] || {};
  evidenceMap[integrationId][clientId][checkId] = { ...(evidenceMap[integrationId][clientId][checkId] || {}), ...entry };
  await chrome.storage.local.set({ evidenceMap });
}

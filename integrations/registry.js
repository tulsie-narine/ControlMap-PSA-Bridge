/**
 * Integration registry.
 * To add an integration: create integrations/<id>/integration.js exporting the
 * integration object (see docs/BUILDING_INTEGRATIONS.md), import it here, and
 * add it to the INTEGRATIONS array. No core files need to change.
 */

import sentinelone from "./sentinelone/integration.js";
import defender from "./defender/integration.js";

export const INTEGRATIONS = [
  sentinelone,
  defender,
];

export function getIntegration(id) {
  const i = INTEGRATIONS.find((x) => x.id === id);
  if (!i) throw new Error(`Unknown integration "${id}".`);
  return i;
}

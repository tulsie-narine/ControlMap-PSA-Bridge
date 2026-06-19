/**
 * ScalePad Atlas — background service worker entry point.
 *
 * This file is intentionally thin. All logic lives in:
 *   background/router.js          — message dispatcher
 *   background/integrationRunner.js — check execution, scoring, meta serialisation
 *   background/evidenceHelpers.js  — sha256, ticket stats
 */

import { registerRouter } from "./background/router.js";

registerRouter();

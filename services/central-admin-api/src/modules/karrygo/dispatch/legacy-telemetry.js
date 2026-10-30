"use strict";

// Routing telemetry for the legacy Karryam dispatch module, which reads and
// writes the Karryam operational database directly (dispatchPrisma). This
// router is not mounted by app.js today. If it is ever mounted again, every
// request is visible as `legacy_direct_db_route` so the remaining traffic can
// be measured before the cutover to HQ -> Product Integration Core ->
// Karryam Admin -> Karryam Bridge (see LEGACY_CUTOVER.md).
// Logged fields are deliberately coarse: no IDs, query values or personal data.

const logger = require("../../../shared/utils/logger");

const RESOURCES = new Set(["providers", "trips", "bikes"]);

function legacyResource(path) {
  const segment = String(path || "").split("/")[1] || "";
  return RESOURCES.has(segment) ? segment : "other";
}

function legacyDirectDbTelemetry(routeName, { log = logger } = {}) {
  return function legacyDirectDbRoute(req, _res, next) {
    try {
      log.warn("legacy_direct_db_route", {
        event: "legacy_direct_db_route",
        route: routeName,
        resource: legacyResource(req.path),
        method: req.method,
        correlation_id: req.correlationId || null,
      });
    } catch {
      // Telemetry never blocks the request.
    }
    next();
  };
}

module.exports = { legacyDirectDbTelemetry, legacyResource };

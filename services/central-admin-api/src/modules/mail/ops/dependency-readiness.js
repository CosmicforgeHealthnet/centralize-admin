"use strict";

// Public dependency-specific readiness (§20: "Separate /health/live and
// dependency-specific readiness"). Each dependency reports one state:
//
//   OK              probed and healthy
//   DEGRADED        reachable but limited (e.g. provider rate limited)
//   UNAVAILABLE     configured but failing
//   NOT_CONFIGURED  required configuration/credentials missing
//   MISCONFIGURED   configured but refused (bad credentials / scope)
//   DISABLED        not used because its feature flag is off
//   NOT_CHECKED     not probed (Mail disabled: nothing is claimed)
//
// A disabled Mail is never reported as ready: it answers state DISABLED with
// ready:false (HTTP 200, because "off" is the intended state, not an outage),
// and dependency states come from configuration only (no network calls).
// Output contains states only: no hostnames, secrets, migration or table names.

const PROVIDER_CACHE_MS = 30000;

function createDependencyReadiness({ config, schema, encryption, storage, scanner, provider, jobs, infrastructureViolations, sessionAssessment = null, clock = () => Date.now() }) {
  let providerCache = null;

  async function providerState() {
    if (providerCache && clock() - providerCache.at < PROVIDER_CACHE_MS) return providerCache.state;
    let state;
    try {
      const probe = await provider.healthProbe();
      state = probe.ok ? "OK" : ["NOT_CONFIGURED", "MISCONFIGURED", "DEGRADED"].includes(probe.status) ? probe.status : "UNAVAILABLE";
    } catch {
      state = "UNAVAILABLE";
    }
    providerCache = { at: clock(), state };
    return state;
  }

  function providerConfigured() {
    return config.provider === "fake" || Boolean(config.resend?.apiKey);
  }

  function configOnly() {
    return {
      schema: "NOT_CHECKED",
      encryption: encryption.available ? "OK" : "NOT_CONFIGURED",
      storage: "NOT_CHECKED",
      scanner: scanner.available ? "NOT_CHECKED" : "NOT_CONFIGURED",
      provider: providerConfigured() ? "NOT_CHECKED" : "NOT_CONFIGURED",
      webhooks: config.resend?.webhookSecret ? "NOT_CHECKED" : "NOT_CONFIGURED",
      infrastructure: infrastructureViolations(config).length ? "MISCONFIGURED" : "OK",
    };
  }

  async function evaluate() {
    if (!config.enabled) {
      return { ready: false, enabled: false, state: "DISABLED", checks: {}, dependencies: configOnly(), session: sessionAssessment ? sessionAssessment() : null };
    }
    const transportNeeded = config.sendingEnabled || config.receivingEnabled;
    const [schemaState, storageHealth, scannerHealth, providerHealth, queue] = await Promise.all([
      schema.check().catch(() => ({ ready: false })),
      storage.health().catch(() => ({ ok: false })),
      (scanner.health ? scanner.health() : Promise.resolve({ ok: scanner.available })).catch(() => ({ ok: false })),
      transportNeeded ? providerState() : Promise.resolve("DISABLED"),
      jobs.stats().catch(() => null),
    ]);
    const dependencies = {
      schema: schemaState.ready ? "OK" : "UNAVAILABLE",
      encryption: encryption.available ? "OK" : "UNAVAILABLE",
      storage: storageHealth.ok ? "OK" : "UNAVAILABLE",
      scanner: !scanner.available ? "NOT_CONFIGURED" : scannerHealth.ok ? "OK" : "UNAVAILABLE",
      provider: providerHealth,
      webhooks: !transportNeeded ? "DISABLED" : config.resend?.webhookSecret || config.provider === "fake" ? "OK" : "NOT_CONFIGURED",
      infrastructure: infrastructureViolations(config).length ? "MISCONFIGURED" : "OK",
    };
    // A provider that is only rate limited still accepts queued work later;
    // every other dependency must be OK. Queue health is reported, not gated:
    // a stalled worker does not make the API unable to accept (durable) work.
    const required = ["schema", "encryption", "storage", "infrastructure", ...(transportNeeded ? ["provider", "webhooks"] : []), ...(config.receivingEnabled ? ["scanner"] : [])];
    const ready = required.every((name) => dependencies[name] === "OK" || (name === "provider" && dependencies[name] === "DEGRADED"));
    const checks = {
      schema: dependencies.schema === "OK",
      encryption: dependencies.encryption === "OK",
      storage: dependencies.storage === "OK",
      infrastructure: dependencies.infrastructure === "OK",
    };
    return { ready, enabled: true, state: ready ? "READY" : "NOT_READY", checks, dependencies, queue: summarizeQueue(queue), session: sessionAssessment ? sessionAssessment() : null };
  }

  return { evaluate };
}

// Counts only (no ids): jobs waiting and dead-lettered per queue.
function summarizeQueue(rows) {
  if (!Array.isArray(rows)) return null;
  const summary = {};
  for (const row of rows) {
    const queue = String(row.queue || "UNKNOWN");
    summary[queue] = summary[queue] || { pending: 0, deadLetter: 0 };
    if (["PENDING", "RECONCILING", "LEASED"].includes(row.status)) summary[queue].pending += Number(row.count || row._count || 0);
    if (row.status === "DEAD_LETTER") summary[queue].deadLetter += Number(row.count || row._count || 0);
  }
  return summary;
}

module.exports = { createDependencyReadiness, PROVIDER_CACHE_MS };

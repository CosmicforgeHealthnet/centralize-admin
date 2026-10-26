"use strict";

// In-process counters for the Prometheus endpoint (spec §20 metrics): HTTP
// auth denials on Mail routes and provider errors by kind and HTTP status.
// Counts and codes only, never addresses or content. Each API or worker
// process exposes its own counters (scrape every instance).

const PROVIDER_METHODS = new Set([
  "sendMessage", "sendEmail", "fetchInboundMessage", "fetchInboundAttachments", "listReceivedEmails", "validateDomain", "retrieveDeliveryEvents",
  "createBroadcast", "sendBroadcast", "getBroadcast", "upsertContact", "removeContact", "createAudience", "syncContacts",
  // §18 contract operations and the remaining documented adapter calls.
  "cancelBroadcast", "deleteBroadcast", "queueBroadcast", "syncAudience", "getContact", "createContact", "addContactToSegment",
  "removeContactFromSegment", "createSegment", "findSegmentByName", "deleteSegment", "findBroadcastByName", "createDomain", "verifyDomain", "findDomainByName", "resubscribeContact", "getDomainByName",
]);

function createRuntimeMetrics() {
  const counters = new Map();
  const key = (name, labels) => `${name}|${JSON.stringify(Object.entries(labels || {}).sort())}`;

  function inc(name, labels = {}, by = 1) {
    const id = key(name, labels);
    const entry = counters.get(id) || { name, labels, value: 0 };
    entry.value += by;
    counters.set(id, entry);
  }

  function samples(name) {
    return [...counters.values()].filter((entry) => entry.name === name).map((entry) => [entry.labels, entry.value]);
  }

  function total(name, filter = () => true) {
    return [...counters.values()].filter((entry) => entry.name === name && filter(entry.labels)).reduce((sum, entry) => sum + entry.value, 0);
  }

  // Wrap a provider adapter so every MailProviderError is counted. The
  // wrapper delegates everything else unchanged (same name, state, methods).
  const wrapped = new WeakMap();
  function instrumentProvider(adapter, channel) {
    if (!adapter || typeof adapter !== "object") return adapter;
    if (wrapped.has(adapter)) return wrapped.get(adapter);
    const proxy = new Proxy(adapter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || !PROVIDER_METHODS.has(prop)) return value;
        return async (...args) => {
          try {
            return await value.apply(target, args);
          } catch (error) {
            if (error?.name === "MailProviderError" || error?.kind) {
              const status = error.status ? (error.status === 429 ? "429" : error.status >= 500 ? "5xx" : String(error.status)) : "none";
              inc("provider_errors", { channel, kind: String(error.kind || "UNKNOWN"), status });
              // §18 normalized category per contract operation (separate
              // series so existing dashboards keep their label set).
              inc("provider_error_categories", { channel, operation: String(prop), category: String(error.category || "UNKNOWN") });
            }
            throw error;
          }
        };
      },
    });
    wrapped.set(adapter, proxy);
    return proxy;
  }

  return { inc, samples, total, instrumentProvider };
}

module.exports = { createRuntimeMetrics };

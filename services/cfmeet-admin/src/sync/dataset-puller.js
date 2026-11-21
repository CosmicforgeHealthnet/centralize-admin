"use strict";

// Stage A dataset puller: CF Meet Admin Bridge datasets (bridge.datasets.read,
// GET /datasets/{dataset_id}, SCOPED_WINDOW, purpose metrics-read) -> daily
// HQ metric observations in the derived outbox.
//
// Only certified Bridge datasets are pulled. Each pull reads the last
// `days` UTC days for every approved feed partition, validates the series
// against the pinned schema (bridge client) and the dataset definition
// (unknown metrics are refused), and publishes per-day observations in one
// transaction per (partition, dataset). Unchanged values append nothing.
// A failure for one dataset never publishes partial data for it.

const { randomUUID } = require("node:crypto");
const D = require("./datasets");
const { partitionKeyFor } = require("./store");

const MAX_PAGES = 4;
const DAY_MS = 86400000;

function createDatasetPuller({ feed, store, bridgeClient, certifiedDatasets = [], days = 3, now = Date.now, logger = () => {} }) {
  if (!feed || !feed.enabled) throw new Error("FEED_DISABLED");
  const datasets = D.BRIDGE_DATASETS.filter((id) => certifiedDatasets.includes(id));
  const span = Math.max(1, Math.min(Number(days) || 3, 31));
  let session = { id: "datasets-" + randomUUID(), startedAt: Math.floor(now() / 1000) };

  // Same operator-approved workload principal as the event feed.
  function staffFor(scope) {
    if (now() - session.startedAt * 1000 >= 120 * 1000) session = { id: "datasets-" + randomUUID(), startedAt: Math.floor(now() / 1000) };
    return { sub: feed.subject, sessionId: session.id, authTime: session.startedAt, acr: feed.acr, role: feed.role, market: scope.market, organization: scope.organization, zone: scope.zone, tenant: scope.tenant };
  }

  // Whole UTC days, ending now (the current day is partial and re-pulled).
  function window() {
    const end = now();
    const today = Math.floor(end / DAY_MS) * DAY_MS;
    return { start: new Date(today - (span - 1) * DAY_MS).toISOString(), end: new Date(end).toISOString() };
  }

  async function pullOne(scope, datasetId) {
    const key = partitionKeyFor(scope);
    const w = window();
    const observedAt = new Date(now()).toISOString();
    const observations = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = { market: scope.market, organization: scope.organization, zone: scope.zone, tenant: scope.tenant, purpose: "metrics-read", limit: 31, ...w };
      if (cursor) query.cursor = cursor;
      const res = await bridgeClient.call("bridge.datasets.read", { staff: staffFor(scope), query, pathParams: { dataset_id: datasetId } });
      observations.push(...D.seriesObservations(D.BY_DATASET.get(datasetId), res.result, { observedAt }));
      cursor = res.result.next_cursor;
      if (!cursor) break;
    }
    if (cursor) throw Object.assign(new Error("SERIES_TOO_LONG"), { reason: "SERIES_TOO_LONG" });
    const published = await store.publishDatasetSeries(key, datasetId, observations);
    return { partitionKey: key, datasetId, status: "SUCCEEDED", observations: observations.length, published: published.length };
  }

  async function pull() {
    const results = [];
    for (const scope of feed.scopes) {
      for (const datasetId of datasets) {
        try {
          results.push(await pullOne(scope, datasetId));
        } catch (err) {
          const reason = err && (err.reason || err.category) ? String(err.reason || err.category) : "PULL_FAILED";
          logger({ event: "dataset_pull_failed", dataset_id: datasetId, partition_key: partitionKeyFor(scope), reason });
          results.push({ partitionKey: partitionKeyFor(scope), datasetId, status: "FAILED", reason });
        }
      }
    }
    return results;
  }

  return { pull, datasets };
}

module.exports = { createDatasetPuller };

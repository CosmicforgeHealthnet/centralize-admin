"use strict";

// Source freshness and coverage -> one reporting-truth state (Section 10).
//
//   LIVE              source-supported data with observation time
//   STALE             last known authorized sample, explicitly stale
//   UNKNOWN           no trustworthy observation: null, never zero
//   PARTIAL_COVERAGE  completeness-dependent figures suppressed
//   QUARANTINED / BLOCKED_POLICY / UNKNOWN_OUTCOME are produced by the
//   pipeline, policy and operation layers respectively.

const STATES = Object.freeze(["LIVE", "STALE", "UNKNOWN", "PARTIAL_COVERAGE", "QUARANTINED", "BLOCKED_POLICY", "UNKNOWN_OUTCOME"]);

function qualityOf(sourceFreshness, sourceCoverage) {
  const partial = ["PARTIAL_COVERAGE", "CONTEXT_SCOPED_PARTIAL", "PARTIAL"].includes(sourceCoverage) || sourceFreshness === "PARTIAL";
  const complete = sourceCoverage === "COMPLETE";
  let freshness = "UNKNOWN";
  if (["LIVE", "RECENT"].includes(sourceFreshness)) freshness = "FRESH";
  else if (sourceFreshness === "STALE") freshness = "STALE";
  else if (sourceFreshness === "PARTIAL") freshness = "FRESH";
  const coverage = partial ? "PARTIAL" : complete ? "COMPLETE" : "UNKNOWN";
  const label = freshness === "UNKNOWN" ? "UNKNOWN" : partial ? "PARTIAL_COVERAGE" : freshness === "STALE" ? "STALE" : "LIVE";
  return { freshness, coverage, label };
}

module.exports = { STATES, qualityOf };

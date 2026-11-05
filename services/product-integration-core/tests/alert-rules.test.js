"use strict";

// Section 12.5 alert rules (infrastructure/product-admin/monitoring/alerts.yml):
// every rule is well-formed for this repository's strict format, every
// required alert exists, and every metric an expression references is one
// the services actually export. promtool validates PromQL syntax in CI.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { picMetricNames } = require("../src/observability/metrics");
const { karryamMetricNames } = require("../../karryam-admin/src/observability/metrics");

const FILE = path.join(__dirname, "..", "..", "..", "infrastructure", "product-admin", "monitoring", "alerts.yml");

function parseRules(text) {
  const rules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^ {6}- alert: ([A-Za-z0-9]+)$/.exec(line))) { current = { alert: m[1], labels: {}, annotations: {} }; rules.push(current); continue; }
    if (!current) continue;
    if ((m = /^ {8}expr: (.+)$/.exec(line))) current.expr = m[1];
    else if ((m = /^ {8}for: (\d+[smh])$/.exec(line))) current.for = m[1];
    else if ((m = /^ {10}(severity): (critical|warning|info)$/.exec(line))) current.labels.severity = m[2];
    else if ((m = /^ {10}(summary|runbook): "(.+)"$/.exec(line))) current.annotations[m[1]] = m[2];
  }
  return rules;
}

const REQUIRED = [
  "ProductAdminServiceDown", "ProductAdminDatabaseUnavailable", "ProductAdminCrashLoop",
  "ProductAdminCertificateExpiringSoon", "ProductIntegrationKeyExpiringSoon", "ProductManifestNearExpiry",
  "ProductIntegrationTrustStoreChanged", "ProductAdminSignerMismatch", "ProductAdminRevokedKeyInUse", "KarryamBridgeTransportSecurityFailure",
  "KarryamSourcePolicyUnavailable", "KarryamBridgeFeedLagSustained", "KarryamBridgeFeedStalled", "KarryamIntegrityHold",
  "ProductAdminRepeatedQuarantine", "KarryamBridgeUnackedEvents", "KarryamHqOutboxUnacked", "ProductIntegrationUnackedEvents",
  "KarryamUnknownOutcomePersistent", "KarryamSourceRateLimitSaturation", "ProductAdminMigrationPending", "ProductAdminMigrationChecksumMismatch",
];

test("alert rules are complete, well-formed and reference only exported metrics", () => {
  const text = fs.readFileSync(FILE, "utf8");
  assert.match(text, /^groups:$/m);
  const rules = parseRules(text);
  const declared = (text.match(/^ {6}- alert: /gm) || []).length;
  assert.equal(rules.length, declared, "every rule parsed");
  const names = new Set(rules.map((r) => r.alert));
  assert.equal(names.size, rules.length, "alert names are unique");
  for (const required of REQUIRED) assert.ok(names.has(required), "missing alert " + required);

  const exported = new Set([...karryamMetricNames(), ...picMetricNames()]);
  for (const r of rules) {
    assert.ok(r.expr, r.alert + " has an expression");
    assert.ok(r.for, r.alert + " has a for: duration (no alert storms on a single scrape)");
    assert.ok(r.labels.severity, r.alert + " has a severity");
    assert.ok(r.annotations.summary, r.alert + " has a summary");
    const referenced = r.expr.match(/\b(?:karryam_admin|pic)_[a-z0-9_]+/g) || [];
    assert.ok(referenced.length > 0 || /\bup\{/.test(r.expr), r.alert + " references a service metric");
    for (const name of referenced) {
      const base = name.replace(/_(bucket|sum|count)$/, "");
      assert.ok(exported.has(name) || exported.has(base), r.alert + " references unknown metric " + name);
    }
    // Alerts never select on identity-bearing labels.
    assert.equal(/\b(staff|token|subject|session|email)\w*=/.test(r.expr), false, r.alert);
  }
  // Runbook links point at files that exist in the repository.
  for (const r of rules.filter((x) => x.annotations.runbook)) {
    const file = r.annotations.runbook.split("#")[0];
    assert.ok(fs.existsSync(path.join(__dirname, "..", "..", "..", file)), r.alert + " runbook " + file);
  }
});

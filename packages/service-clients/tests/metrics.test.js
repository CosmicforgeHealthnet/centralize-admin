"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetricsRegistry, registerProcessMetrics, statusClass, sanitizeLabelValue } = require("../src");

test("counters, gauges and histograms render valid Prometheus text", async () => {
  const r = createMetricsRegistry({ prefix: "svc_" });
  const c = r.counter("requests_total", "Requests", ["endpoint", "status_class"]);
  const g = r.gauge("queue_depth", "Depth");
  const h = r.histogram("duration_seconds", "Duration", ["endpoint"], [0.1, 1]);
  c.inc({ endpoint: "manifest", status_class: "2xx" });
  c.inc({ endpoint: "manifest", status_class: "2xx" }, 2);
  c.inc({ endpoint: "manifest", status_class: "2xx" }, -5); // ignored: counters never decrease
  g.set({}, 4);
  g.dec({}, 1);
  h.observe({ endpoint: "manifest" }, 0.05);
  h.observe({ endpoint: "manifest" }, 0.5);
  h.observe({ endpoint: "manifest" }, 5);
  const text = await r.render();
  assert.match(text, /# TYPE svc_requests_total counter/);
  assert.match(text, /svc_requests_total\{endpoint="manifest",status_class="2xx"\} 3/);
  assert.match(text, /svc_queue_depth 3/);
  assert.match(text, /svc_duration_seconds_bucket\{endpoint="manifest",le="0.1"\} 1/);
  assert.match(text, /svc_duration_seconds_bucket\{endpoint="manifest",le="1"\} 2/);
  assert.match(text, /svc_duration_seconds_bucket\{endpoint="manifest",le="\+Inf"\} 3/);
  assert.match(text, /svc_duration_seconds_count\{endpoint="manifest"\} 3/);
  assert.ok(text.endsWith("\n"));
  assert.equal(c.get({ endpoint: "manifest", status_class: "2xx" }), 3);
});

test("label allowlist: identity, credential and path labels are refused at declaration; undeclared labels are dropped", async () => {
  const r = createMetricsRegistry({ prefix: "svc_" });
  for (const bad of ["staff_id", "token", "path", "url", "email", "sub", "session_id", "le", "__x", "bad-name"]) {
    assert.throws(() => r.counter("x_" + Math.random().toString(36).slice(2, 8) + "_total", "x", [bad]), /metric_label_(forbidden|invalid)/, bad);
  }
  assert.throws(() => r.counter("bad name", "x"), /metric_name_invalid/);
  const c = r.counter("ok_total", "ok", ["reason"]);
  c.inc({ reason: "DENIED", staff_id: "staff-17" });
  const text = await r.render();
  assert.match(text, /svc_ok_total\{reason="DENIED"\} 1/);
  assert.equal(text.includes("staff-17"), false);
  assert.throws(() => r.counter("ok_total", "dup"), /metric_duplicate/);
});

test("label values are sanitized: no injection, bounded length", async () => {
  const r = createMetricsRegistry();
  const c = r.counter("events_total", "e", ["reason"]);
  c.inc({ reason: 'x"} 1\nfake_metric{a="b"} 9' });
  c.inc({ reason: "y".repeat(500) });
  c.inc({ reason: "" });
  const text = await r.render();
  assert.equal(/^fake_metric/m.test(text), false);
  assert.equal(text.split("\n").filter((l) => l.startsWith("events_total{")).every((l) => /^events_total\{reason="[A-Za-z0-9_.:/-]{1,96}"\} \d+$/.test(l)), true, text);
  assert.equal(sanitizeLabelValue(null), "none");
  assert.equal(sanitizeLabelValue("/products/:p"), "/products/:p");
});

test("cardinality cap folds excess series into __overflow__ and counts it", async () => {
  const r = createMetricsRegistry({ prefix: "svc_", maxSeries: 3 });
  const c = r.counter("hits_total", "h", ["partition"]);
  for (let i = 0; i < 10; i += 1) c.inc({ partition: "p" + i });
  const text = await r.render();
  const lines = text.split("\n").filter((l) => l.startsWith("svc_hits_total{"));
  assert.equal(lines.length, 4);
  assert.match(text, /svc_hits_total\{partition="__overflow__"\} 7/);
  assert.match(text, /svc_metrics_series_overflow_total\{metric="svc_hits_total"\} 7/);
});

test("collectors run at scrape time; a failing or slow collector is counted and never breaks the scrape", async () => {
  const r = createMetricsRegistry({ prefix: "svc_", collectorTimeoutMs: 50 });
  const g = r.gauge("db_rows", "rows");
  r.addCollector("good", async () => { g.set({}, 5); });
  r.addCollector("broken", async () => { throw new Error("db down"); });
  r.addCollector("slow", () => new Promise((resolve) => setTimeout(resolve, 500)));
  const text = await r.render();
  assert.match(text, /svc_db_rows 5/);
  assert.match(text, /svc_metrics_collector_errors_total\{collector="broken"\} 1/);
  assert.match(text, /svc_metrics_collector_errors_total\{collector="slow"\} 1/);
  assert.throws(() => r.addCollector("Bad Name", async () => {}), /collector_name_invalid/);
});

test("process metrics and status classes", async () => {
  const r = createMetricsRegistry({ prefix: "svc_" });
  registerProcessMetrics(r, { service: "svc", version: "abc123", startedAt: 1700000000000 });
  const text = await r.render();
  assert.match(text, /svc_process_start_time_seconds 1700000000/);
  assert.match(text, /svc_build_info\{service="svc",version="abc123"\} 1/);
  assert.match(text, /svc_process_resident_memory_bytes \d+/);
  assert.equal(statusClass(204), "2xx");
  assert.equal(statusClass(503), "5xx");
  assert.equal(statusClass("x"), "other");
  assert.deepEqual(r.names().filter((n) => n.startsWith("svc_process")).sort(), ["svc_process_heap_used_bytes", "svc_process_resident_memory_bytes", "svc_process_start_time_seconds", "svc_process_uptime_seconds"]);
});

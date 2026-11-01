"use strict";

// Dependency-free Prometheus text-format (0.0.4) metrics registry for the
// private Product Admin services.
//
// Safety rules enforced here, not left to callers:
//  - Label names are declared per metric (allowlist) and may never be an
//    identity, credential or free-text name (staff IDs, tokens, paths, URLs).
//    Undeclared labels passed at runtime are dropped.
//  - Label values are sanitized to a short [A-Za-z0-9_.:/-] token.
//  - Each metric holds at most `maxSeries` label combinations; further
//    combinations are folded into one `__overflow__` series and counted in
//    <prefix>metrics_series_overflow_total.
//  - Collectors (scrape-time gauges, e.g. from the database) run with a
//    timeout; a failing collector is counted and never breaks the scrape.

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FORBIDDEN_LABELS = /^(?:staff|staff_id|staff_ref|sub|subject|user|user_id|email|phone|token|jti|nonce|secret|key|password|signature|assertion|path|url|uri|ip|address|body|query|session|session_id|actor|requested_by|decided_by)$/i;
const OVERFLOW = "__overflow__";
const DEFAULT_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

function sanitizeLabelValue(value) {
  if (value === null || value === undefined || value === "") return "none";
  const text = String(value);
  const clean = text.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, 96);
  return clean || "none";
}

function escapeHelp(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(n) {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  return String(n);
}

function labelString(names, values, extra) {
  const parts = names.map((n, i) => n + '="' + values[i] + '"');
  if (extra) parts.push(extra);
  return parts.length ? "{" + parts.join(",") + "}" : "";
}

function createRegistry({ prefix = "", maxSeries = 200, collectorTimeoutMs = 2000 } = {}) {
  if (prefix && !/^[a-z][a-z0-9_]*_$/.test(prefix)) throw new Error("metrics_prefix_invalid");
  const metrics = new Map();
  const collectors = [];

  function define(type, name, help, labelNames = [], extra = {}) {
    const full = prefix + name;
    if (!NAME.test(full)) throw new Error("metric_name_invalid:" + full);
    if (metrics.has(full)) throw new Error("metric_duplicate:" + full);
    for (const l of labelNames) {
      if (!LABEL.test(l) || l === "le" || l.startsWith("__")) throw new Error("metric_label_invalid:" + l);
      if (FORBIDDEN_LABELS.test(l)) throw new Error("metric_label_forbidden:" + l);
    }
    const series = new Map();
    const metric = { type, name: full, help, labelNames: Object.freeze([...labelNames]), series, ...extra };

    function key(labels = {}) {
      const values = metric.labelNames.map((l) => sanitizeLabelValue(labels[l]));
      let k = values.join("\u0000");
      if (!series.has(k) && series.size >= maxSeries) {
        overflow.inc({ metric: full });
        const folded = metric.labelNames.map(() => OVERFLOW);
        k = folded.join("\u0000");
        return { k, values: folded };
      }
      return { k, values };
    }
    metric.key = key;
    metrics.set(full, metric);
    return metric;
  }

  // Registered first so every registry can report its own overflows.
  const overflowMetric = define("counter", "metrics_series_overflow_total", "Label combinations folded into the overflow series", ["metric"]);
  const overflow = {
    inc(labels) {
      const k = sanitizeLabelValue(labels.metric);
      const s = overflowMetric.series.get(k) || { values: [k], value: 0 };
      s.value += 1;
      overflowMetric.series.set(k, s);
    },
  };
  const collectorErrors = define("counter", "metrics_collector_errors_total", "Scrape-time collectors that failed or timed out", ["collector"]);

  function counter(name, help, labelNames = []) {
    const m = define("counter", name, help, labelNames);
    return Object.freeze({
      name: m.name,
      inc(labels = {}, n = 1) {
        if (!(n >= 0) || !Number.isFinite(n)) return;
        const { k, values } = m.key(labels);
        const s = m.series.get(k) || { values, value: 0 };
        s.value += n;
        m.series.set(k, s);
      },
      get(labels = {}) { const s = m.series.get(m.key(labels).k); return s ? s.value : 0; },
    });
  }

  function gauge(name, help, labelNames = []) {
    const m = define("gauge", name, help, labelNames);
    return Object.freeze({
      name: m.name,
      set(labels = {}, v) {
        if (typeof v !== "number" || Number.isNaN(v)) return;
        const { k, values } = m.key(labels);
        m.series.set(k, { values, value: v });
      },
      inc(labels = {}, n = 1) {
        const { k, values } = m.key(labels);
        const s = m.series.get(k) || { values, value: 0 };
        s.value += n;
        m.series.set(k, s);
      },
      dec(labels = {}, n = 1) { this.inc(labels, -n); },
      reset() { m.series.clear(); },
      get(labels = {}) { const s = m.series.get(m.key(labels).k); return s ? s.value : undefined; },
    });
  }

  function histogram(name, help, labelNames = [], buckets = DEFAULT_BUCKETS) {
    const sorted = [...buckets].sort((a, b) => a - b);
    if (!sorted.length || sorted.some((b) => !Number.isFinite(b)) || new Set(sorted).size !== sorted.length) throw new Error("histogram_buckets_invalid");
    const m = define("histogram", name, help, labelNames, { buckets: Object.freeze(sorted) });
    return Object.freeze({
      name: m.name,
      observe(labels = {}, v) {
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        const { k, values } = m.key(labels);
        const s = m.series.get(k) || { values, counts: new Array(sorted.length).fill(0), sum: 0, count: 0 };
        for (let i = 0; i < sorted.length; i += 1) if (v <= sorted[i]) s.counts[i] += 1;
        s.sum += v;
        s.count += 1;
        m.series.set(k, s);
      },
    });
  }

  /** Scrape-time collector: async () => void, typically setting gauges. */
  function addCollector(name, fn) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error("collector_name_invalid");
    collectors.push({ name, fn });
  }

  async function collect() {
    await Promise.all(collectors.map(async ({ name, fn }) => {
      let timer;
      try {
        await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), collectorTimeoutMs); })]);
      } catch {
        const s = collectorErrors.series.get(name) || { values: [name], value: 0 };
        s.value += 1;
        collectorErrors.series.set(name, s);
      } finally { clearTimeout(timer); }
    }));
  }

  function renderSync() {
    const lines = [];
    for (const m of metrics.values()) {
      lines.push("# HELP " + m.name + " " + escapeHelp(m.help));
      lines.push("# TYPE " + m.name + " " + m.type);
      for (const s of m.series.values()) {
        if (m.type === "histogram") {
          let cumulative = 0;
          for (let i = 0; i < m.buckets.length; i += 1) {
            cumulative = s.counts[i];
            lines.push(m.name + "_bucket" + labelString(m.labelNames, s.values, 'le="' + formatValue(m.buckets[i]) + '"') + " " + cumulative);
          }
          lines.push(m.name + "_bucket" + labelString(m.labelNames, s.values, 'le="+Inf"') + " " + s.count);
          lines.push(m.name + "_sum" + labelString(m.labelNames, s.values) + " " + formatValue(s.sum));
          lines.push(m.name + "_count" + labelString(m.labelNames, s.values) + " " + s.count);
        } else {
          lines.push(m.name + labelString(m.labelNames, s.values) + " " + formatValue(s.value));
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  async function render() {
    await collect();
    return renderSync();
  }

  return Object.freeze({
    counter, gauge, histogram, addCollector, collect, render, renderSync,
    names: () => [...metrics.keys()],
    CONTENT_TYPE: "text/plain; version=0.0.4; charset=utf-8",
  });
}

/** Standard process gauges (start time drives restart / crash-loop alerts). */
function registerProcessMetrics(registry, { service, version = "unknown", startedAt = Date.now() } = {}) {
  const start = registry.gauge("process_start_time_seconds", "Process start time (unix seconds)");
  start.set({}, Math.floor(startedAt / 1000));
  const info = registry.gauge("build_info", "Build identity of the running service", ["service", "version"]);
  info.set({ service, version }, 1);
  const rss = registry.gauge("process_resident_memory_bytes", "Resident memory");
  const heap = registry.gauge("process_heap_used_bytes", "V8 heap in use");
  const uptime = registry.gauge("process_uptime_seconds", "Seconds since process start");
  registry.addCollector("process", async () => {
    const mem = process.memoryUsage();
    rss.set({}, mem.rss);
    heap.set({}, mem.heapUsed);
    uptime.set({}, Math.floor((Date.now() - startedAt) / 1000));
  });
}

/** Coarse status class for HTTP status labels (bounded cardinality). */
function statusClass(status) {
  const n = Number(status);
  return n >= 100 && n < 600 ? Math.floor(n / 100) + "xx" : "other";
}

module.exports = { createMetricsRegistry: createRegistry, registerProcessMetrics, statusClass, sanitizeLabelValue, METRICS_CONTENT_TYPE: "text/plain; version=0.0.4; charset=utf-8", DEFAULT_BUCKETS };

// Public-ingress negative probe (Section 12.1.6 / 13.1.8).
//
// Sends raw HTTP/1.1 requests (no client-side normalization: every byte of
// the request target goes out exactly as written) and checks each answer.
//
//   CI (test Nginx + recording backend):
//     node probe.mjs --target http://127.0.0.1:18080 --host stagingca.test --control http://127.0.0.1:19001 [--report out.json]
//     -> also proves whether each request reached the backend, and with which headers.
//   Live staging (read-only, run from a GitHub runner):
//     node probe.mjs --target https://stagingca.cosmicforge-healthnet.com --host stagingca.cosmicforge-healthnet.com [--report out.json]
//     -> no control channel: denied paths must never answer 2xx/3xx or expose a private service.
//
// Exit 1 if any expectation fails. The report never contains response bodies.

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const PRIVATE_MARKERS = ["karryam-admin", "product-integration-core", "product_admin", "hq_integration", "INTEGRATION_DISABLED", "PRODUCT_INTEGRATION_DISABLED"];

export const CASES = [
  // Legitimate public routes must still work.
  { id: "public-health", target: "/health", expect: "PASS_THROUGH", backendUrl: "/health" },
  { id: "public-login", method: "POST", target: "/api/auth/login", expect: "PASS_THROUGH", backendUrl: "/api/auth/login", liveStatuses: [200, 400, 401, 403, 415, 422, 429] },
  { id: "public-query-percent", target: "/api/products?q=%2569nternal", expect: "PASS_THROUGH", backendUrl: "/api/products?q=%2569nternal", ciOnly: true },
  { id: "public-host-case", target: "/health", hostCase: "upper", expect: "PASS_THROUGH" },
  { id: "public-not-internal-prefix", target: "/internals-report", expect: "PASS_THROUGH", note: "only the exact segment is private", ciOnly: true },
  // Private paths, every spelling.
  { id: "internal-root", target: "/internal", expect: "DENY" },
  { id: "internal-slash", target: "/internal/", expect: "DENY" },
  { id: "pic", target: "/internal/pic/v1/products", expect: "DENY" },
  { id: "product-admin", target: "/internal/product-admin/v1/manifest", expect: "DENY" },
  { id: "karryam-admin", target: "/internal/karryam-admin/v1/capabilities", expect: "DENY" },
  { id: "underscore-internal", target: "/_internal/x", expect: "DENY" },
  { id: "upper-case", target: "/INTERNAL/PIC/v1/products", expect: "DENY" },
  { id: "mixed-case", target: "/Internal/Karryam-Admin/v1/x", expect: "DENY" },
  { id: "double-slash", target: "//internal/pic/v1/products", expect: "DENY" },
  { id: "triple-slash", target: "///internal/product-admin/v1/manifest", expect: "DENY" },
  { id: "pct-one-char", target: "/%69nternal/pic/v1/products", expect: "DENY" },
  { id: "pct-all", target: "/%69%6E%74%65%72%6E%61%6C/pic", expect: "DENY" },
  { id: "pct-lower-hex", target: "/%69%6e%74%65%72%6e%61%6c/pic", expect: "DENY" },
  { id: "encoded-slash-after", target: "/internal%2Fpic%2Fv1%2Fproducts", expect: "DENY" },
  { id: "encoded-slash-before", target: "/%2Finternal/pic", expect: "DENY" },
  { id: "dot-segment", target: "/api/../internal/pic/v1/products", expect: "DENY" },
  { id: "dot-segment-encoded", target: "/api/%2e%2e/internal/pic", expect: "DENY" },
  { id: "dot-segment-mixed", target: "/api/./x/../../internal/karryam-admin/v1/x", expect: "DENY" },
  { id: "dot-dot-above-root", target: "/../internal/pic", expect: "DENY" },
  { id: "double-encoding", target: "/%2569nternal/pic", expect: "DENY" },
  { id: "double-encoded-slash", target: "/api%252F..%252Finternal/pic", expect: "DENY" },
  { id: "semicolon-param", target: "/internal;jsessionid=x/pic", expect: "DENY" },
  { id: "extension", target: "/internal.json", expect: "DENY" },
  { id: "backslash", target: "/internal\\pic", expect: "DENY" },
  { id: "nul-byte", target: "/internal%00/pic", expect: "DENY" },
  { id: "private-metrics", target: "/metrics", expect: "DENY" },
  { id: "private-sync-status", target: "/sync/status", expect: "DENY" },
  { id: "private-ready", target: "/health/ready", expect: "DENY" },
  { id: "private-live-upper", target: "/HEALTH/LIVE", expect: "DENY" },
  // Absolute-form and Host tricks.
  { id: "absolute-form-same-host", absolute: true, target: "/internal/pic/v1/products", expect: "DENY" },
  { id: "absolute-form-other-host", absolute: "karryam-admin", target: "/internal/product-admin/v1/manifest", expect: "DENY" },
  { id: "host-spoof-private", host: "karryam-admin", target: "/internal/product-admin/v1/manifest", expect: "DENY" },
  { id: "host-spoof-socket", host: "product-integration-core", target: "/health", expect: "DENY" },
  { id: "host-ip-literal", host: "127.0.0.1", target: "/health", expect: "DENY" },
  { id: "forwarded-host-ignored", target: "/health", headers: { "X-Forwarded-Host": "karryam-admin", "X-Original-URL": "/internal/pic/v1/products" }, expect: "PASS_THROUGH", backendHost: "SERVER_NAME", backendXfh: "SERVER_NAME", backendXOriginalUrl: null },
  { id: "no-redirect-on-internal", target: "/internal", expect: "DENY", noRedirect: true },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  return out;
}

export function rawRequest(targetUrl, { method = "GET", path, host, headers = {}, absolute = null, timeoutMs = 8000 }) {
  const u = new URL(targetUrl);
  const isTls = u.protocol === "https:";
  const port = Number(u.port || (isTls ? 443 : 80));
  const requestTarget = absolute ? `http://${absolute === true ? host : absolute}${path}` : path;
  const lines = [`${method} ${requestTarget} HTTP/1.1`, `Host: ${host}`, "User-Agent: cosmicforge-ingress-probe/1", "Connection: close"];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  if (method === "POST") lines.push("Content-Type: application/json", "Content-Length: 2");
  const payload = lines.join("\r\n") + "\r\n\r\n" + (method === "POST" ? "{}" : "");
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (result) => { if (!done) { done = true; socket.destroy(); resolve(result); } };
    const socket = isTls
      ? tls.connect({ host: u.hostname, port, servername: host.toLowerCase(), ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: u.hostname, port });
    socket.setTimeout(timeoutMs, () => finish({ status: null, closed: true, timeout: true }));
    socket.on(isTls ? "secureConnect" : "connect", () => socket.write(payload));
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", (err) => finish({ status: null, closed: true, error: err.code || err.name }));
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      const headerEnd = text.indexOf("\r\n\r\n");
      const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
      const body = headerEnd >= 0 ? text.slice(headerEnd + 4) : "";
      const location = /\r\nlocation:\s*([^\r\n]*)/i.exec(head);
      finish({ status: m ? Number(m[1]) : null, closed: !m, location: location ? location[1] : null, privateMarker: PRIVATE_MARKERS.some((k) => body.includes(k)) });
    });
  });
}

async function control(url) {
  const res = await fetch(url);
  return res.json();
}

export function evaluate(c, response, seen, serverName) {
  const failures = [];
  const reached = seen ? seen.length > 0 : null;
  if (c.expect === "PASS_THROUGH") {
    const okStatuses = seen === null && c.liveStatuses ? c.liveStatuses : [200];
    if (!okStatuses.includes(response.status)) failures.push(`expected ${okStatuses.join("/")} from the application, got ${response.status === null ? "closed" : response.status}`);
    if (seen) {
      if (!reached) failures.push("request did not reach the backend");
      const last = seen[seen.length - 1] || {};
      if (c.backendUrl && last.url !== c.backendUrl) failures.push(`backend saw ${last.url}, expected ${c.backendUrl}`);
      if (c.backendHost === "SERVER_NAME" && last.host !== serverName) failures.push("backend Host was not the fixed server name");
      if (c.backendXfh === "SERVER_NAME" && last.x_forwarded_host !== serverName) failures.push("client X-Forwarded-Host reached the backend");
      if ("backendXOriginalUrl" in c && last.x_original_url !== c.backendXOriginalUrl) failures.push("client X-Original-URL reached the backend");
    }
  } else {
    if (response.status !== null && response.status >= 200 && response.status < 400) failures.push(`private path answered ${response.status}`);
    if (c.noRedirect && response.location) failures.push("private path redirected");
    if (response.privateMarker) failures.push("response exposed a private service marker");
    if (seen && reached) failures.push(`request reached the backend as ${seen.map((s) => s.url).join(", ")}`);
  }
  return failures;
}

export async function run({ target, host, controlUrl, cases = CASES }) {
  const results = [];
  if (controlUrl) await control(controlUrl);
  for (const c of cases.filter((x) => controlUrl || !x.ciOnly)) {
    const reqHost = c.host || (c.hostCase === "upper" ? host.toUpperCase() : host);
    const response = await rawRequest(target, { method: c.method, path: c.target, host: reqHost, headers: c.headers, absolute: c.absolute ? (c.absolute === true ? host : c.absolute) : null });
    const seen = controlUrl ? await control(controlUrl) : null;
    const failures = evaluate(c, response, seen, host);
    results.push({ id: c.id, request_target: c.target, expect: c.expect, status: response.status, closed: response.closed, reached_backend: seen ? seen.length > 0 : "UNKNOWN_NO_CONTROL_CHANNEL", result: failures.length ? "FAIL" : "PASS", failures });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("probe.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target || !args.host) { process.stderr.write("usage: probe.mjs --target URL --host NAME [--control URL] [--report FILE]\n"); process.exit(2); }
  const results = await run({ target: args.target, host: args.host, controlUrl: args.control || null });
  const failed = results.filter((r) => r.result === "FAIL");
  const report = {
    report: "product-admin-ingress-probe",
    target: args.target,
    host: args.host,
    mode: args.control ? "ci-with-recording-backend" : "live-no-control-channel",
    source_sha: process.env.GITHUB_SHA || null,
    generated_at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    result: failed.length ? "FAIL" : "PASS",
    cases: results,
  };
  if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
  for (const r of results) process.stdout.write(`${r.result} ${r.id} status=${r.status ?? "closed"} reached=${r.reached_backend}${r.failures.length ? " :: " + r.failures.join("; ") : ""}\n`);
  process.stdout.write(`ingress probe: ${report.passed}/${report.total} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

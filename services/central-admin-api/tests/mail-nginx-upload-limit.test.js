"use strict";

// Reverse-proxy body limit for Mail uploads, against a REAL Nginx.
//
// Reproduces the reported failure (a 3 MiB PDF is refused by Nginx's built-in
// 1 MiB client_max_body_size with a bare HTML 413 that never reaches the API,
// while files under 1 MiB work) and proves the tracked configuration fixes it
// without opening other routes. Skipped (reported as skipped, never as a pass)
// where no nginx binary exists. Runs unprivileged in a temp directory.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { buildPdf } = require("./helpers/make-pdf");

const ROOT = path.resolve(__dirname, "../../..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "infrastructure/mail/nginx/ca-mail-upload-limits.conf.tpl"), "utf8");
const EXAMPLE = fs.readFileSync(path.join(ROOT, "infrastructure/product-admin/nginx/central-admin-api.server.example.conf"), "utf8");
const NGINX = ["/usr/sbin/nginx", "/usr/local/sbin/nginx", "/usr/bin/nginx"].find((p) => fs.existsSync(p));
const ATTACH = "/api/mail/v1/drafts/11111111-1111-4111-8111-111111111111/attachments";

function multipart(file, name = "Karryam Vendor Partner Pitch (2).pdf") {
  const boundary = `----CfTestBoundary${Date.now()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, file, tail]) };
}

function post(port, pathName, { body, boundary }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathName, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", (error) => (error.code === "EPIPE" || error.code === "ECONNRESET" ? resolve({ status: 413, text: "(connection closed by proxy)", headers: {} }) : reject(error)));
    req.end(body);
  });
}

async function withNginx(includeFix, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-nginx-"));
  const received = [];
  const backend = http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (c) => { bytes += c.length; });
    req.on("end", () => {
      received.push({ url: req.url, bytes, contentType: req.headers["content-type"] });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, reachedApi: true, bytes }));
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${backend.address().port}`;
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  // Nginx runs in its own process, so the suite network guard must be told this loopback port is ours.
  const releasePort = require("./helpers/network-guard").registerLocalPort(port);
  const snippet = TEMPLATE.replaceAll("__UPSTREAM__", upstream);
  const conf = `
${process.getuid && process.getuid() === 0 ? "user root;" : ""}
worker_processes 1; daemon off; error_log ${dir}/error.log warn; pid ${dir}/nginx.pid;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${dir}/cb; proxy_temp_path ${dir}/px; fastcgi_temp_path ${dir}/fc; uwsgi_temp_path ${dir}/uw; scgi_temp_path ${dir}/sc;
  server {
    listen 127.0.0.1:${port};
    server_name stagingca.test;
    client_max_body_size 1m;
    ${includeFix ? snippet : ""}
    location / { proxy_pass ${upstream}; proxy_http_version 1.1; }
  }
}`;
  fs.writeFileSync(path.join(dir, "nginx.conf"), conf);
  const check = spawnSync(NGINX, ["-t", "-p", dir, "-c", path.join(dir, "nginx.conf")], { encoding: "utf8" });
  assert.equal(check.status, 0, `nginx -t: ${check.stderr}`);
  const proc = spawn(NGINX, ["-p", dir, "-c", path.join(dir, "nginx.conf")], { stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise((r) => { const s = require("node:net").connect(port, "127.0.0.1", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    await run({ port, received });
  } finally {
    releasePort();
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    backend.close();
    if (process.env.KEEP_NGINX_LOG) console.error(fs.readFileSync(path.join(dir, "error.log"), "utf8"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("tracked Nginx template and example config agree and cover the API ceiling", () => {
  assert.match(TEMPLATE, /location ~ \^\/api\/mail\/v1\/drafts\/\[\^\/\]\+\/attachments\$ \{\s*client_max_body_size 26m;/);
  assert.match(EXAMPLE, /location ~ \^\/api\/mail\/v1\/drafts\/\[\^\/\]\+\/attachments\$ \{\s*client_max_body_size 26m;/);
  // 26m must exceed the largest per-file value the API accepts (25 MiB) plus multipart overhead.
  const { loadMailConfig } = require("../src/modules/mail/mail.config");
  const max = loadMailConfig({ MAIL_ATTACHMENT_MAX_BYTES: String(10 ** 12) }).limits.attachmentMaxBytes;
  assert.equal(max, 25 * 1024 * 1024);
  assert.ok(26 * 1024 * 1024 > max + 64 * 1024);
});

test("real Nginx: without the fix a 3 MiB PDF is rejected by the proxy (reproduction)", { skip: !NGINX && "nginx binary not available" }, async () => {
  await withNginx(false, async ({ port, received }) => {
    const small = await post(port, ATTACH, multipart(buildPdf({ pages: 2, targetBytes: 512 * 1024 })));
    assert.equal(small.status, 201, "files under 1 MiB pass");
    const pdf = await post(port, ATTACH, multipart(buildPdf({ pages: 14, targetBytes: 3 * 1024 * 1024 })));
    assert.equal(pdf.status, 413);
    assert.match(pdf.text, /Request Entity Too Large|closed by proxy/);
    assert.ok(!pdf.text.includes("reachedApi"), "the API never saw the request");
    assert.equal(received.length, 1, "only the small upload reached the backend");
  });
});

test("real Nginx: with the tracked fix 3 MiB, 5 MiB and ceiling-size uploads reach the API; over-ceiling and other routes stay limited", { skip: !NGINX && "nginx binary not available" }, async () => {
  await withNginx(true, async ({ port, received }) => {
    for (const size of [1 * 1024 * 1024, 3 * 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024, 25 * 1024 * 1024]) {
      const pdf = buildPdf({ pages: 14, targetBytes: size });
      const response = await post(port, ATTACH, multipart(pdf));
      assert.equal(response.status, 201, `${size} bytes must be proxied`);
      const seen = received.at(-1);
      assert.ok(seen.bytes > size, "the whole multipart body arrived");
      assert.match(seen.contentType, /^multipart\/form-data; boundary=/, "boundary preserved end to end");
    }
    const over = await post(port, ATTACH, multipart(buildPdf({ pages: 14, targetBytes: 27 * 1024 * 1024 })));
    assert.equal(over.status, 413, "above the proxy ceiling Nginx still protects the host");
    const before = received.length;
    const elsewhere = await post(port, "/api/mail/v1/mailboxes/x/threads", multipart(buildPdf({ pages: 2, targetBytes: 3 * 1024 * 1024 })));
    assert.equal(elsewhere.status, 413, "other routes keep the 1 MiB default");
    assert.equal(received.length, before);
    const csv = await post(port, "/api/mail/v1/marketing/org-1/contacts/import", multipart(Buffer.alloc(2 * 1024 * 1024, 97), "contacts.csv"));
    assert.equal(csv.status, 201, "CSV import (API limit 2 MiB) is no longer capped at 1 MiB by the proxy");
  });
});

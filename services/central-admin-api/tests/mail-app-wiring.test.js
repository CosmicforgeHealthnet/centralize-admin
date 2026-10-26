"use strict";

// app.js wiring for CosmicForge Mail: the Resend webhook receives exact raw
// bytes before JSON parsing/XSS mutation, Mail JSON is not globally escaped,
// non-Mail routes keep the global XSS behaviour and the existing Social
// Operations raw webhook path is unaffected.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { createApp } = require("../src/app");
const { closeServer } = require("./helpers/server-close");

function stubMailHttp(seen) {
  const router = express.Router();
  router.post("/echo", (req, res) => {
    seen.echo = req.body;
    res.json({ success: true, data: req.body });
  });
  return {
    application: { stub: true },
    router,
    webhookHandler: (req, res) => {
      seen.webhook = { rawBody: req.rawBody, body: req.body };
      res.json({ success: true });
    },
  };
}

test("app.js routes Mail webhooks raw and skips global XSS mutation only for Mail", async () => {
  const seen = {};
  const app = createApp({
    env: { ...process.env, NODE_ENV: "test" },
    passportInstance: { initialize: () => (req, res, next) => next() },
    googleStrategyRegistrar: () => ({ enabled: false }),
    cloudinaryConfigurator: () => ({ configured: false }),
    mailHttpFactory: () => stubMailHttp(seen),
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const raw = '{"type":"email.received",  "data":{"email_id":"x","html":"<b>keep</b>"}}';
    const webhook = await fetch(`${base}/api/mail/v1/webhooks/resend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.equal(webhook.status, 200);
    assert.ok(Buffer.isBuffer(seen.webhook.rawBody));
    assert.equal(seen.webhook.rawBody.toString("utf8"), raw, "exact bytes (including whitespace) reach the verifier");
    assert.deepEqual(seen.webhook.body, {});

    const html = "<p>Totals: 5 < 7 & <b>bold</b></p>";
    const echo = await fetch(`${base}/api/mail/v1/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, pad: "x".repeat(20000) }) });
    assert.equal(echo.status, 200, "Mail bodies may exceed the global 10kb JSON limit");
    assert.equal(seen.echo.html, html, "Mail content is sanitized by Mail itself, not mutated globally");

    const tooLarge = await fetch(`${base}/api/mail/v1/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(1100000) }) });
    assert.equal(tooLarge.status, 413);

    const other = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x".repeat(20000) }) });
    assert.ok(other.status >= 400 && other.status !== 404, "non-Mail routes keep the 10kb JSON limit (existing behaviour unchanged)");
  } finally {
    await closeServer(server);
  }
});

test("Mail module has no HealthNet Main DB or cross-module internal dependencies", () => {
  const root = path.join(__dirname, "..", "src", "modules", "mail");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && !full.includes("__tests__")) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length > 20);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!/mainDatabase|main-client|dispatchDatabase|dispatch-client/.test(source), `${file} must not depend on product databases`);
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const target = match[1];
      if (!target.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), target);
      const allowed = resolved.startsWith(root) || resolved.includes(`${path.sep}shared${path.sep}`) || resolved.includes(`${path.sep}generated${path.sep}admin-client`);
      assert.ok(allowed, `${path.relative(root, file)} imports ${target}`);
    }
  }
});

// D10: the per-IP global limiter (500 / 15 min) must not throttle the raw
// Mail routes, which carry their own signature auth and rate limits.
test("app.js exempts raw Mail webhook/integration routes from the global limiter", async () => {
  const seen = {};
  const stub = stubMailHttp(seen);
  stub.integrationHandler = (req, res) => res.status(202).json({ success: true });
  const app = createApp({
    env: { ...process.env, NODE_ENV: "test" },
    passportInstance: { initialize: () => (req, res, next) => next() },
    googleStrategyRegistrar: () => ({ enabled: false }),
    cloudinaryConfigurator: () => ({ configured: false }),
    mailHttpFactory: () => stub,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let lastWebhook;
    for (let index = 0; index < 510; index += 1) {
      const path = index % 2 ? "/api/mail/v1/webhooks/resend" : "/api/mail/v1/integrations/v1/events";
      lastWebhook = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.ok([200, 202].includes(lastWebhook.status), `request ${index} was not throttled (${lastWebhook.status})`);
    }
    assert.equal(lastWebhook.headers.get("ratelimit-limit"), null, "raw Mail routes bypass the global limiter");
    const health = await fetch(`${base}/health`);
    assert.equal(health.headers.get("ratelimit-limit"), "500", "other routes keep the global limiter");
  } finally {
    await closeServer(server);
  }
});

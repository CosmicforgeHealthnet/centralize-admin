"use strict";

// Regression tests for the M1-M10 closure fixes (spec §13.2, §13.4, §19.3,
// §19.7, §20, §22). Pure unit tests: no database and no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadMailConfig } = require("../mail.config");
const { externalSendBlockReason, isRestrictedHealthOrganization, SEND_BLOCK_REASONS: R } = require("../authz/sending-gate");
const { verifyResendWebhook, signResendWebhook } = require("../webhooks/resend-webhook.verifier");
const { createMailSchemaReadiness, MAIL_SCHEMA_REQUIREMENTS } = require("../schema-readiness");
const { scanLinks } = require("../marketing/link-scan");
const { validateConsentInput } = require("../marketing/marketing.service");
const { createMailWorker } = require("../jobs/mail-worker");

const secret = () => `whsec_${crypto.randomBytes(24).toString("base64")}`;

test("schema readiness reports the missing migration, re-checks a negative result and caches a positive one", async () => {
  let present = new Set();
  let probes = 0;
  let clock = 0;
  const client = {
    async $queryRawUnsafe(sql) {
      probes += 1;
      if (sql.includes("pg_class")) return [...present].filter((name) => !name.includes(".")).map((relname) => ({ relname }));
      return [...present].filter((name) => name.includes(".")).map((name) => ({ table_name: name.split(".")[0], column_name: name.split(".")[1] }));
    },
  };
  const warnings = [];
  const readiness = createMailSchemaReadiness({ client, logger: { warn: (m) => warnings.push(m), info() {} }, recheckMs: 1000, now: () => clock });
  let state = await readiness.check();
  assert.equal(state.ready, false);
  assert.deepEqual(state.missing, MAIL_SCHEMA_REQUIREMENTS.map((entry) => entry.migration));
  assert.equal(warnings.length, 1);

  for (const entry of MAIL_SCHEMA_REQUIREMENTS) {
    for (const table of entry.tables || []) present.add(table);
    for (const [table, column] of entry.columns || []) present.add(`${table}.${column}`);
  }
  const before = probes;
  assert.equal((await readiness.check()).ready, false, "a negative result is cached until the recheck window passes");
  assert.equal(probes, before);
  clock = 1500;
  state = await readiness.check();
  assert.equal(state.ready, true, "applying the migration takes effect without a restart");
  present = new Set();
  clock = 999_999;
  assert.equal(await readiness.isReady(), true, "a positive result is cached for the process lifetime");
  assert.equal(warnings.length, 1, "the warning is logged once");
});

test("schema readiness fails closed when the probe itself errors", async () => {
  const readiness = createMailSchemaReadiness({ client: { $queryRawUnsafe: async () => { throw new Error("relation does not exist"); } }, logger: null });
  const state = await readiness.check();
  assert.equal(state.ready, false);
  assert.equal(state.missing.length, MAIL_SCHEMA_REQUIREMENTS.length);
});

test("the worker idles without touching the job tables while the schema is missing", async () => {
  let claims = 0;
  const jobs = { claim: async () => { claims += 1; return []; }, stats: async () => [] };
  const worker = createMailWorker({ jobs, config: loadMailConfig({ MAIL_ENABLED: "true" }), logger: { info() {}, warn() {}, error() {} }, handlers: {}, schemaReady: async () => false });
  assert.equal(await worker.tick(), 0);
  assert.equal(claims, 0);
});

test("restricted-health (HealthNet) brands are blocked from the provider unless an approval-backed override is set", () => {
  const config = loadMailConfig({ MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: "healthnet.example,cosmicforge.example" });
  const base = { domain: "healthnet.example", status: "VERIFIED", sendingStatus: "VERIFIED" };
  const gate = (domain, cfg = config) => externalSendBlockReason({ config: cfg, providerReady: () => true, domain });
  assert.equal(gate({ ...base, organization: { slug: "healthnet" } }), R.RESTRICTED_HEALTH);
  assert.equal(gate({ ...base, organization: { slug: "healthnet-clinics" } }), R.RESTRICTED_HEALTH, "sub-brands share the restriction");
  assert.equal(gate({ ...base, organization: { slug: "HealthNet" } }), R.RESTRICTED_HEALTH, "slug comparison is case-insensitive");
  assert.equal(gate({ ...base, organization: undefined }), R.ORGANIZATION_UNKNOWN, "callers that forget to load the organization fail closed");
  assert.equal(gate({ ...base, organization: null }), R.ORGANIZATION_UNKNOWN);
  assert.equal(gate({ ...base, domain: "cosmicforge.example", organization: { slug: "cosmicforge" } }), null);
  const approved = loadMailConfig({ MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_DOMAIN_ALLOWLIST: "healthnet.example", MAIL_RESTRICTED_HEALTH_PROVIDER_APPROVED: "true" });
  assert.equal(gate({ ...base, organization: { slug: "healthnet" } }, approved), null);
  const custom = loadMailConfig({ MAIL_RESTRICTED_HEALTH_ORGANIZATIONS: "clinic-a, Clinic-B" });
  assert.equal(isRestrictedHealthOrganization(custom, { slug: "clinic-b" }), true);
  assert.equal(isRestrictedHealthOrganization(custom, { slug: "healthnet" }), false, "the list is configurable");
  assert.equal(isRestrictedHealthOrganization(config, { slug: "" }), false);
});

test("webhook verification accepts the previous secret during rotation and nothing else", () => {
  const current = secret();
  const previous = secret();
  const stranger = secret();
  const rawBody = Buffer.from(JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } }));
  const timestamp = Math.floor(Date.now() / 1000);
  const headersFor = (key) => ({ "svix-id": "msg_rot", "svix-timestamp": String(timestamp), "svix-signature": signResendWebhook({ id: "msg_rot", timestamp, rawBody, secret: key }) });
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(current), secret: [current, previous] }).ok, true);
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(previous), secret: [current, previous] }).ok, true, "grace period");
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(previous), secret: [current] }).reason, "SIGNATURE_MISMATCH", "after the grace period ends");
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(stranger), secret: [current, previous] }).reason, "SIGNATURE_MISMATCH");
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(current), secret: [] }).reason, "SECRET_NOT_CONFIGURED");
  assert.equal(verifyResendWebhook({ rawBody, headers: headersFor(current), secret: ["", "short"] }).reason, "SECRET_NOT_CONFIGURED");
  assert.equal(loadMailConfig({ RESEND_WEBHOOK_SECRET_PREVIOUS: previous }).resend.previousWebhookSecret, previous);
});

test("campaign preflight link scan flags phishing patterns and leaves safe links alone", () => {
  const safe = scanLinks('<a href="https://cosmicforge.example/offer">Offer</a> <a href="mailto:a@b.co">mail</a> <a href="{{unsubscribe_url}}">unsubscribe</a> <a href="#top">top</a>');
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.issues, []);
  const kinds = (html) => scanLinks(html).issues.map((issue) => issue.kind);
  assert.deepEqual(kinds('<a href="javascript:alert(1)">x</a>'), ["UNSAFE_SCHEME"]);
  assert.ok(kinds('<a href="data:text/html,hi">x</a>').includes("UNSAFE_SCHEME"));
  assert.ok(kinds('<a href="http://cosmicforge.example">x</a>').includes("NOT_HTTPS"));
  assert.ok(kinds('<a href="https://203.0.113.9/login">x</a>').includes("IP_HOST"));
  assert.ok(kinds('<a href="https://xn--pple-43d.com">x</a>').includes("PUNYCODE_HOST"));
  assert.ok(kinds('<a href="https://bit.ly/abc">x</a>').includes("LINK_SHORTENER"));
  assert.ok(kinds('<a href="https://evil.example/login">https://bank.example</a>').includes("MISLEADING_TEXT"));
  assert.equal(scanLinks('<a href="https://www.cosmicforge.example/a">cosmicforge.example</a>').ok, true, "the same registrable host is not misleading");
  assert.equal(scanLinks("").ok, true);
});

test("consent capture records an ISO country when given and rejects malformed ones", () => {
  const base = { topic: "product-updates", source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: "form-123" } };
  assert.equal(validateConsentInput({ ...base, country: "ng" }).evidence.country, "NG");
  assert.equal(validateConsentInput({ ...base, evidence: { reference: "form-123", country: "GB" } }).evidence.country, "GB");
  assert.equal(validateConsentInput(base).evidence.country, null, "country stays optional");
  assert.throws(() => validateConsentInput({ ...base, country: "Nigeria" }), (error) => error.code === "MAIL_VALIDATION_FAILED");
  assert.throws(() => validateConsentInput({ ...base, country: "N1" }), (error) => error.code === "MAIL_VALIDATION_FAILED");
});

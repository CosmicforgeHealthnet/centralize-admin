"use strict";

// GAP 8 unit tests: signed origin header, mixed-recipient config validation,
// delivery plans in both modes, and delivery-event attribution with internal
// recipients. No database, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createOriginHeader, originKeyAvailable } = require("../src/modules/mail/security/origin-header");
const { loadMailConfig, publicStatus } = require("../src/modules/mail/mail.config");
const { buildDeliveryPlan } = require("../src/modules/mail/pipelines/outbound.processor");
const { attribute, aggregateMessageStatus } = require("../src/modules/mail/pipelines/delivery-event.processor");

const SECRET = crypto.randomBytes(32).toString("hex");
const KEYS = `v1:${crypto.randomBytes(32).toString("base64")}`;
const ID = crypto.randomUUID();

test("origin header: sign/verify round trip, constant-time rejection of forgeries", () => {
  const signer = createOriginHeader({ secret: SECRET });
  assert.equal(signer.available, true);
  const value = signer.sign(ID);
  assert.match(value, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(signer.verify(value), ID);
  assert.equal(signer.verify(` ${value} `), ID);
  assert.equal(signer.verify(`${crypto.randomUUID()}.${value.split(".")[1]}`), null, "signature bound to the message id");
  assert.equal(signer.verify(`${ID}.${crypto.randomBytes(32).toString("base64url")}`), null);
  assert.equal(createOriginHeader({ secret: crypto.randomBytes(32).toString("hex") }).verify(value), null, "other key");
  for (const bad of [null, undefined, 42, "", "garbage", `${ID}.`, `${ID}.abc`, `not-a-uuid-at-all-not-a-uuid-at-all1.${value.split(".")[1]}`]) assert.equal(signer.verify(bad), null);
  assert.throws(() => signer.sign("not-a-uuid"));
  assert.equal(signer.extract([{ name: "x-cosmicforge-origin", value }]), value);
  assert.equal(signer.extract({ "X-CosmicForge-Origin": [value] }), value);
  assert.equal(signer.extract([{ name: "Subject", value: "x" }]), null);
});

test("origin header: short secret ignored, env keyring fallback verifies across rotation, KMS needs a secret", () => {
  assert.equal(createOriginHeader({ secret: "short" }).available, false);
  const v1 = crypto.randomBytes(32).toString("base64");
  const v2 = crypto.randomBytes(32).toString("base64");
  const before = createOriginHeader({ encryptionKeys: `v1:${v1}`, activeKey: "v1" });
  assert.equal(before.source, "encryption-keyring");
  const value = before.sign(ID);
  const after = createOriginHeader({ encryptionKeys: `v1:${v1},v2:${v2}`, activeKey: "v2" });
  assert.equal(after.verify(value), ID, "old key version still verifies");
  assert.notEqual(after.sign(ID), value, "new active key signs");
  assert.equal(originKeyAvailable({ encryptionKeys: `v1:${v1}`, kmsProvider: "aws-kms" }), false);
  assert.equal(originKeyAvailable({ secret: SECRET, kmsProvider: "aws-kms" }), true);
});

test("config: default external-only; full-headers refused without a key; never leaks the secret", () => {
  assert.equal(loadMailConfig({}).mixedRecipients.mode, "external-only");
  const refused = loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_MIXED_RECIPIENT_MODE: "full-headers", MAIL_KMS_PROVIDER: "aws-kms" });
  assert.equal(refused.mixedRecipients.mode, "external-only");
  assert.equal(refused.mixedRecipients.refusedReason, "MAIL_ORIGIN_HEADER_SECRET_MISSING");
  assert.equal(loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_MIXED_RECIPIENT_MODE: "full-headers" }).mixedRecipients.mode, "external-only");
  assert.equal(loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_MIXED_RECIPIENT_MODE: "full-headers", MAIL_ORIGIN_HEADER_SECRET: "too-short" }).mixedRecipients.secretTooShort, true);
  assert.equal(loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_MIXED_RECIPIENT_MODE: "full-headers", MAIL_ENCRYPTION_KEYS: KEYS }).mixedRecipients.mode, "full-headers");
  const enabled = loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_MIXED_RECIPIENT_MODE: "Full-Headers", MAIL_ORIGIN_HEADER_SECRET: SECRET, MAIL_KMS_PROVIDER: "aws-kms" });
  assert.equal(enabled.mixedRecipients.mode, "full-headers");
  assert.equal(loadMailConfig({ MAIL_MIXED_RECIPIENT_MODE: "everything" }).mixedRecipients.refusedReason, "MAIL_MIXED_RECIPIENT_MODE_UNKNOWN");
  const status = publicStatus(enabled);
  assert.deepEqual(status.mixedRecipients, { mode: "full-headers", requestedMode: "full-headers", refusedReason: null });
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

// Re-audit 7b: full-headers needs the explicit receiving-cutover switch.
test("config: full-headers refused until MAIL_RECEIVING_CUTOVER_CONFIRMED=true", () => {
  const withKey = { MAIL_MIXED_RECIPIENT_MODE: "full-headers", MAIL_ORIGIN_HEADER_SECRET: SECRET, MAIL_KMS_PROVIDER: "aws-kms" };
  for (const flagValue of [undefined, "", "false", "1", "yes"]) {
    const config = loadMailConfig({ ...withKey, ...(flagValue === undefined ? {} : { MAIL_RECEIVING_CUTOVER_CONFIRMED: flagValue }) });
    assert.equal(config.mixedRecipients.mode, "external-only", `flag=${flagValue}`);
    assert.equal(config.mixedRecipients.refusedReason, "MAIL_RECEIVING_CUTOVER_NOT_CONFIRMED");
    assert.deepEqual(publicStatus(config).mixedRecipients, { mode: "external-only", requestedMode: "full-headers", refusedReason: "MAIL_RECEIVING_CUTOVER_NOT_CONFIRMED" });
  }
  assert.equal(loadMailConfig({ ...withKey, MAIL_RECEIVING_CUTOVER_CONFIRMED: "true" }).mixedRecipients.mode, "full-headers");
  // The flag alone never enables anything.
  assert.equal(loadMailConfig({ MAIL_RECEIVING_CUTOVER_CONFIRMED: "true" }).mixedRecipients.mode, "external-only");
});

function r(id, type, status, address = `${id}@x.example`) {
  return { id, type, status, address };
}

test("plan external-only: unchanged behaviour (externals only, Cc promotion, individual BCC)", () => {
  assert.deepEqual(buildDeliveryPlan([r("i1", "TO", "INTERNAL_DELIVERED"), r("e1", "CC", "PENDING")]), [{ to: ["e1"], cc: [], bcc: [], promotedCc: true }]);
  assert.deepEqual(buildDeliveryPlan([r("e1", "TO", "PENDING"), r("i1", "CC", "INTERNAL_DELIVERED"), r("e2", "BCC", "PENDING")]), [{ to: ["e1"], cc: [], bcc: ["e2"] }]);
  assert.deepEqual(buildDeliveryPlan([r("i1", "TO", "INTERNAL_DELIVERED"), r("e1", "BCC", "PENDING"), r("e2", "BCC", "PENDING")]).map((batch) => batch.to), [["e1"], ["e2"]]);
  // full-headers without an origin value falls back to external-only.
  assert.deepEqual(buildDeliveryPlan([r("i1", "TO", "INTERNAL_DELIVERED"), r("e1", "CC", "PENDING")], { mode: "full-headers", origin: null }), [{ to: ["e1"], cc: [], bcc: [], promotedCc: true }]);
});

test("plan full-headers: visible To/Cc of every status, external BCC only, origin only when internal addressed", () => {
  const recipients = [r("i1", "TO", "INTERNAL_DELIVERED"), r("e1", "TO", "PENDING"), r("e2", "CC", "PENDING"), r("i2", "CC", "INTERNAL_DELIVERED"), r("e3", "BCC", "PENDING"), r("i3", "BCC", "INTERNAL_DELIVERED")];
  const [batch, ...rest] = buildDeliveryPlan(recipients, { mode: "full-headers", origin: "o" });
  // Re-audit fix 5: with internal recipients in the headers, external BCC get
  // individual (attributable) requests instead of riding the main request.
  assert.deepEqual(batch, { to: ["i1", "e1"], cc: ["e2", "i2"], bcc: [], fullHeaders: true, internal: ["i1", "i2"], origin: "o" });
  assert.deepEqual(rest, [{ to: ["e3"], cc: [], bcc: [], individualBcc: true, fullHeaders: true, internal: [] }]);
  // Without internal header recipients the BCC stays on the main request.
  assert.deepEqual(buildDeliveryPlan([r("e1", "TO", "PENDING"), r("e3", "BCC", "PENDING")], { mode: "full-headers", origin: "o" }), [{ to: ["e1"], cc: [], bcc: ["e3"], fullHeaders: true, internal: [] }]);
  assert.deepEqual(buildDeliveryPlan([r("i1", "CC", "INTERNAL_DELIVERED"), r("e1", "CC", "PENDING")], { mode: "full-headers", origin: "o" }), [{ to: ["i1", "e1"], cc: [], bcc: [], promotedCc: true, fullHeaders: true, internal: ["i1"], origin: "o" }]);
  assert.deepEqual(buildDeliveryPlan([r("e1", "TO", "PENDING"), r("i3", "BCC", "INTERNAL_DELIVERED")], { mode: "full-headers", origin: "o" }), [{ to: ["e1"], cc: [], bcc: [], fullHeaders: true, internal: [] }]);
  assert.deepEqual(buildDeliveryPlan([r("e1", "BCC", "PENDING"), r("i3", "BCC", "INTERNAL_DELIVERED")], { mode: "full-headers", origin: "o" }).map((b) => b.to), [["e1"]]);
  assert.deepEqual(buildDeliveryPlan([r("i1", "TO", "INTERNAL_DELIVERED")], { mode: "full-headers", origin: "o" }), [], "nothing external: no provider call");
});

test("attribution: internal-only evidence ignored, To-list echo unattributed, external subsets attributed", () => {
  const P = "prov_1";
  const message = {
    providerMessageId: P,
    recipients: [
      { id: "i1", type: "TO", status: "INTERNAL_DELIVERED", address: "erin@us.example", providerMessageId: P },
      { id: "e1", type: "TO", status: "PROVIDER_ACCEPTED", address: "a@x.example", providerMessageId: P },
      { id: "e2", type: "CC", status: "PROVIDER_ACCEPTED", address: "b@x.example", providerMessageId: P },
    ],
  };
  assert.deepEqual(attribute(message, P, "BOUNCED", ["erin@us.example", "a@x.example"]), { targets: [], unattributed: true }, "To-list echo");
  assert.equal(attribute(message, P, "BOUNCED", ["erin@us.example"]).internalOnly, true);
  assert.equal(attribute(message, P, "DELIVERED", ["erin@us.example"]).internalOnly, true);
  assert.deepEqual(attribute(message, P, "BOUNCED", ["b@x.example"]).targets.map((t) => t.id), ["e2"]);
  // Re-audit fix 5: a DELIVERED that only echoes a To list containing an
  // internal address may be our MX accepting the internal copy: no change.
  assert.deepEqual(attribute(message, P, "DELIVERED", ["a@x.example", "erin@us.example"]), { targets: [], unattributed: true });
  assert.deepEqual(attribute(message, P, "DELIVERY_DELAYED", ["erin@us.example", "a@x.example"]).targets, []);
  assert.deepEqual(attribute(message, P, "DELIVERED", ["a@x.example"]).targets.map((t) => t.id), ["e1"], "explicitly named external address");
  // One external + internal in the same request: not a single-recipient batch.
  const single = { providerMessageId: P, recipients: [message.recipients[0], { ...message.recipients[2] }] };
  assert.deepEqual(attribute(single, P, "BOUNCED", []), { targets: [], unattributed: true });
  // external-only (internal rows carry no provider id): single batch attribution kept.
  const legacy = { providerMessageId: P, recipients: [{ ...message.recipients[0], providerMessageId: null }, message.recipients[2]] };
  assert.deepEqual(attribute(legacy, P, "BOUNCED", []).targets.map((t) => t.id), ["e2"]);
  assert.equal(aggregateMessageStatus([{ status: "INTERNAL_DELIVERED" }, { status: "DELIVERED" }, { status: "BOUNCED" }], "PROVIDER_ACCEPTED"), "BOUNCED");
});

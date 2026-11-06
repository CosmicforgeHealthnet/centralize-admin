"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const O = require("../src/onboarding/operator");
const SM = require("../src/onboarding/state-machine");
const now = Date.parse("2026-11-05T18:00:00Z");
const key = generateKeyPairSync("ed25519");
const scope = { market: ["NG-LAG"], organization: ["karryam-staging"], zone: ["NG-LAG-MAIN"], tenant: ["karryam-staging-operations"] };
function decision(changes = {}) { return { schema_version: 1, decision_id: "decision-1", operator: "root@staging-host", owner_delegation_ref: "owner-delegation-1", environment: "staging", product_id: "karryam", allowed_scope: scope, issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 600000).toISOString(), allow_setup_without_staff_sessions: true, allow_single_operator_onboarding: true, ...changes }; }
function envelope(d = decision(), signingKey = key.privateKey) { return { document: d, key_id: "owner-k1", signature: sign(null, Buffer.from(O.DOMAIN + O.canonical(d)), signingKey).toString("base64url") }; }
function trust(changes = {}) { return { keys: { "owner-k1": { purpose: "OWNER_DELEGATION", allowed_scope: scope, product_id: "karryam", environment: "staging", not_after: new Date(now + 3600000).toISOString(), revoked: false, public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }), ...changes } } }; }
const options = { environment: "staging", operator: "root@staging-host", now };
function validate(e = envelope(), t = trust(), opts = options) { return O.parseSignedDecision(JSON.stringify(e), t, opts); }
test("valid owner signature binds the exact staging product, operator and scope", () => { assert.equal(validate().decision_id, "decision-1"); });
test("an unsigned decision and boolean override cannot mint a permit", () => {
  assert.throws(() => O.parseSignedDecision(JSON.stringify(decision()), trust(), options));
  assert.equal(O.validPermit({ decision: decision() }, { environment: "staging", now }), false);
  assert.equal(O.validPermit(true, { environment: "staging", now }), false);
});
test("signed decisions are refused for every non-staging execution environment", () => {
  for (const environment of ["production", "test", "development", undefined]) assert.throws(() => validate(envelope(), trust(), { ...options, environment }), /STAGING_ONLY/);
});
test("even a correctly signed decision cannot change product, geography or tenancy", () => {
  for (const d of [decision({ product_id: "other" }), decision({ allowed_scope: { ...scope, market: ["NG-ABJ"] } }), decision({ allowed_scope: { ...scope, tenant: ["*"] } }), decision({ allowed_scope: { ...scope, organization: ["karryam-staging", "other"] } }), decision({ allowed_scope: { market: scope.market, organization: scope.organization } })]) assert.throws(() => validate(envelope(d)), /DECISION_INVALID/);
});
test("another operator, missing delegation evidence and extra fields are refused", () => {
  for (const d of [decision({ operator: "root@other" }), decision({ owner_delegation_ref: "" }), decision({ allow_setup_without_staff_sessions: false }), decision({ operations_enabled: true })]) assert.throws(() => validate(envelope(d)), /DECISION_INVALID/);
});
test("decision validity is bounded to one hour and checked on every validation", () => {
  for (const d of [decision({ issued_at: new Date(now + 1).toISOString() }), decision({ expires_at: new Date(now).toISOString() }), decision({ expires_at: new Date(now + 3600000).toISOString() }), decision({ expires_at: "invalid" })]) assert.throws(() => validate(envelope(d)), /EXPIRED_OR_INVALID/);
});
test("untrusted, revoked, expired, wrong-purpose and cross-environment authorities are refused", () => {
  for (const t of [{}, trust({ revoked: true }), trust({ purpose: "SOURCE_POLICY" }), trust({ environment: "production" }), trust({ allowed_scope: undefined }), trust({ allowed_scope: { ...scope, tenant: ["*"] } }), trust({ not_after: new Date(now + 1000).toISOString() })]) assert.throws(() => validate(envelope(), t), /SIGNER_NOT_TRUSTED/);
});
test("root trust pins are independent of the signed document", () => {
  assert.throws(() => validate(envelope(), trust({ product_id: "other" })), /DECISION_INVALID/);
  assert.throws(() => validate(envelope(), trust({ allowed_scope: { ...scope, market: ["NG-ABJ"] } })), /DECISION_INVALID/);
});

test("tampering or signing with an unenrolled key is refused", () => {
  const e = envelope(); e.document.owner_delegation_ref = "tampered";
  assert.throws(() => validate(e), /SIGNATURE_INVALID/);
  assert.throws(() => validate(envelope(decision(), generateKeyPairSync("ed25519").privateKey)), /SIGNATURE_INVALID/);
});
test("malformed envelopes, invalid public keys and missing separation waiver are refused", () => {
  assert.throws(() => O.parseSignedDecision("{", trust(), options), /DECISION_INVALID/);
  assert.throws(() => validate({ ...envelope(), extra: true }), /DECISION_INVALID/);
  assert.throws(() => validate(envelope(decision({ allow_single_operator_onboarding: false }))), /DECISION_INVALID/);
  assert.throws(() => validate(envelope(), trust({ public_key_pem: "invalid" })), /SIGNATURE_INVALID/);
  assert.throws(() => validate({ ...envelope(), signature: "invalid" }), /SIGNATURE_INVALID/);
});
test("a parsed decision remains data and cannot bypass normal independent approvals", () => {
  const parsed = validate();
  assert.throws(() => SM.assertTransition({ from: "POLICY_REVIEWED", to: "CERTIFIED_STAGING", actorId: "same", requestedBy: "same", expectedRevision: 1, currentRevision: 1, operatorPermit: parsed, environment: "staging", productId: "karryam", scope, now }), /INDEPENDENT_REVIEWER_REQUIRED/);
});
test("scope matching rejects additional and absent dimensions", () => {
  assert.equal(O.equalScope({ ...scope, region: ["all"] }, scope), false);
  assert.equal(O.equalScope({ market: scope.market }, scope), false);
  assert.equal(O.equalScope(scope, scope), true);
});
test("the local permit loader cannot be used by a normal non-root or Windows process", { skip: process.platform === "linux" && process.getuid() === 0 }, () => { assert.throws(() => O.loadOperatorPermit("/etc/cosmicforge/staging/decision.json", options), /ROOT_REQUIRED/); });

test("CLI refuses missing revisions, arbitrary datasets, duplicate flags and unknown steps", () => {
  const { options } = require("../scripts/staging-operator-onboarding");
  for (const args of [[], ["--decision", "/d", "--step", "grant"], ["--decision", "/d", "--step", "approve", "--id", "a".repeat(36)], ["--decision", "/d", "--step", "request", "--apply", "--apply"], ["--decision", "/d", "--step", "approve-dataset", "--id", "a".repeat(36), "--dataset", "karryam.marketing_campaigns", "--version", "1.0.0"]]) assert.throws(() => options(args));
  assert.equal(options(["--decision", "/d", "--step", "request"])["--apply"], undefined);
});

test("root sandbox: protected permits, revocation and real PostgreSQL operator audits", { skip: process.env.PIC_OPERATOR_TEST_SANDBOX !== "1" }, async (t) => {
  const fs = require("node:fs"), os = require("node:os");
  const { createOnboarding } = require("../src/onboarding/service");
  const DB = require("./helpers/db");
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  const dir = "/etc/cosmicforge/staging/operator-test";
  const trustFile = "/etc/cosmicforge/staging/secrets/pic-operator-authority/public-keys.json";
  assert.equal(fs.existsSync(trustFile), false, "Only run in an isolated container with an empty /etc/cosmicforge tmpfs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(require("node:path").dirname(trustFile), { recursive: true, mode: 0o700 });
  const file = dir + "/decision.json", realOperator = "root@" + os.hostname();
  const operatorActor = "operator:" + realOperator;
  const rawTrust = JSON.stringify(trust());
  const rawDecision = JSON.stringify(envelope(decision({ operator: realOperator })));
  fs.writeFileSync(trustFile, rawTrust, { mode: 0o600 });
  fs.writeFileSync(file, rawDecision, { mode: 0o600 });
  const load = () => O.loadOperatorPermit(file, { environment: "staging", now });
  const permit = load();
  assert.equal(O.validPermit(permit, { environment: "staging", scope, now }), true);
  assert.equal(O.validPermit(permit, { environment: "production", scope, now }), false);
  assert.equal(O.validPermit(permit, { environment: "staging", scope: { ...scope, market: ["other"] }, now }), false);
  assert.doesNotThrow(() => SM.assertTransition({ from: "POLICY_REVIEWED", to: "CERTIFIED_STAGING", actorId: operatorActor, requestedBy: operatorActor, expectedRevision: 1, currentRevision: 1, operatorPermit: permit, environment: "staging", productId: "karryam", scope, now }));
  assert.throws(() => SM.assertTransition({ from: "POLICY_REVIEWED", to: "CERTIFIED_STAGING", actorId: operatorActor, requestedBy: operatorActor, expectedRevision: 1, currentRevision: 1, operatorPermit: permit, environment: "staging", scope, now }), /INDEPENDENT_REVIEWER_REQUIRED/);
  assert.throws(() => SM.assertTransition({ from: "POLICY_REVIEWED", to: "CERTIFIED_STAGING", actorId: "another", requestedBy: "another", expectedRevision: 1, currentRevision: 1, operatorPermit: permit, environment: "staging", productId: "karryam", scope, now }), /INDEPENDENT_REVIEWER_REQUIRED/);
  assert.throws(() => SM.assertTransition({ from: "POLICY_REVIEWED", to: "CERTIFIED_STAGING", actorId: operatorActor, requestedBy: operatorActor, expectedRevision: 1, currentRevision: 1, operatorPermit: permit, environment: "production", productId: "karryam", scope, now }), /INDEPENDENT_REVIEWER_REQUIRED/);
  fs.chmodSync(file, 0o644); assert.throws(load, /FILE_NOT_PROTECTED/); fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, dir + "/symlink.json"); assert.throws(() => O.loadOperatorPermit(dir + "/symlink.json", { environment: "staging", now }), /FILE_NOT_PROTECTED/);
  fs.writeFileSync(trustFile, JSON.stringify(trust({ revoked: true })));
  assert.equal(O.validPermit(permit, { environment: "staging", now }), false);
  fs.writeFileSync(trustFile, rawTrust);
  assert.equal(O.validPermit(permit, { environment: "staging", now }), false, "revocation remains latched for an issued capability");
  assert.equal(O.validPermit(load(), { environment: "staging", now: now + 600001 }), false);
  assert.equal(DB.available(), true, "PostgreSQL integration coverage is required in this sandbox");
  const db = await DB.createDisposableDatabase(); t.after(() => db.drop());
  const actor = "operator:" + realOperator, { randomUUID } = require("node:crypto"), id = randomUUID();
  await db.migClient.query(`INSERT INTO hq_integration.hq_product_admins(id,product_id,display_name,service_instance_id,environment,endpoint_ref,workload_identity,approved_signer_kid,allowed_scope,lifecycle_status,requested_by) VALUES($1,'karryam','Test Karryam','operator-test-1','staging','test','cf://staging/product-admin/karryam','test-key',$2,'CONTRACT_VALIDATED',$3)`, [id, JSON.stringify(scope), actor]);
  await db.migClient.query(`INSERT INTO hq_integration.hq_product_admin_grants(id,grant_kind,staff_id,effect,actions,granted_by) VALUES($1,'PLATFORM',$2,'ALLOW',ARRAY['integration.review'],'test-fixture')`, [randomUUID(), actor]);
  const args = { pool: db.pool, endpoints: new Map(), trustStore: {}, environment: "staging", now: () => now };
  const normal = createOnboarding(args), ctx = { correlationId: randomUUID() };
  await assert.rejects(normal.reviewPolicy({ staffId: actor, sessionId: "test-session", authTime: now / 1000 - 2, mfaAt: now / 1000 - 1 }, id, { expected_revision: 1 }, ctx), /INDEPENDENT_REVIEWER_REQUIRED/);
  const workflow = createOnboarding({ ...args, operatorPermit: load() });
  assert.deepEqual(Object.keys(workflow).sort(), ["get", "request", "verifyIdentity", "validateContract", "reviewPolicy", "approveDataset", "certifyStaging", "approve"].sort());
  assert.equal(workflow.setOperations, undefined); assert.equal(workflow.grant, undefined); assert.equal(workflow.createSubscription, undefined);
  const result = await workflow.reviewPolicy({ staffId: actor }, id, { expected_revision: 1, evidence_ref: "test:actual-evidence" }, ctx);
  assert.equal(result.lifecycle_status, "POLICY_REVIEWED"); assert.equal(result.revision, 2);
  const audit = await db.pool.query(`SELECT actor_type,actor_id,reason_code,metadata FROM hq_integration.hq_product_admin_security_audit WHERE actor_type='OPERATOR' ORDER BY id`);
  assert.ok(audit.rows.length >= 2); assert.ok(audit.rows.every((r) => r.actor_id === actor && r.reason_code === "OWNER_DELEGATED_STAGING_SETUP" && r.metadata.decision_ref === "decision-1"));
  const approvals = await db.pool.query(`SELECT actor_id,reason_code FROM hq_integration.hq_product_admin_onboarding_approvals WHERE product_admin_id=$1`, [id]);
  assert.equal(approvals.rows.length, 1); assert.equal(approvals.rows[0].actor_id, actor); assert.equal(approvals.rows[0].reason_code, "OWNER_DELEGATED_STAGING_SETUP");
  await assert.rejects(workflow.certifyStaging({ staffId: actor }, id, { expected_revision: 2, evidence_ref: "test:uncertified" }, ctx), /NO_VALIDATED_CONTRACT/);
  await assert.rejects(workflow.reviewPolicy({ staffId: actor }, id, { expected_revision: 1 }, ctx), /STALE_REVISION/);
  await assert.rejects(workflow.get({ staffId: "other-actor" }, id, ctx), /OPERATOR_NOT_AUTHORIZED/);
  const row = await db.pool.query(`SELECT lifecycle_status,revision,operations_enabled FROM hq_integration.hq_product_admins WHERE id=$1`, [id]);
  assert.deepEqual(row.rows[0], { lifecycle_status: "POLICY_REVIEWED", revision: 2, operations_enabled: false });
  fs.writeFileSync(file, rawDecision + "\n"); assert.equal(O.validPermit(load(), { environment: "staging", now }), true);
});

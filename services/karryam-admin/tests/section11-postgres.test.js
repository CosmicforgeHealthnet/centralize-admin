"use strict";

// Section 11.3 database guarantees on disposable PostgreSQL: high-risk
// certifications are operator-only, two-reviewer, time-bounded and revoked
// once; approvals bound to a certification and policy revision are consumed
// at most once under concurrency and void when the certification changes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { migrate } = require("../scripts/migrate");
const { pgApprovals } = require("../src/db/approvals");
const { pgCertifications } = require("../src/db/certifications");
const { certificationFor } = require("../scripts/high-risk-certification");
const { contractRevision } = require("../src/sync/bridge-consumer");
const { ADMIN_URL, createDisposable } = require("./helpers/pgdb");

const rejects = (p, re) => assert.rejects(p, (e) => (re instanceof RegExp ? re.test(e.code + " " + e.message) : e.code === re) || assert.fail(`${e.code} ${e.message}`));
const CAP = "karryam.hq.exports.create";

test("Section 11.3: high-risk certifications and bound approvals on PostgreSQL", { timeout: 120000 }, async (t) => {
  if (!ADMIN_URL) { t.skip("KARRYAM_ADMIN_TEST_DATABASE_URL not set"); return; }
  const d = await createDisposable("ka_t11");
  t.after(() => d.drop());
  await migrate({ connectionString: d.migrationUrl, runtimeRole: d.runtime });
  const owner = await d.owner();
  const runtime = d.pool();
  const rev = contractRevision();

  await t.test("the operator tool only certifies real, enabled-at-source R3/R4 commands with two distinct reviewers", () => {
    const base = { capability: CAP, "policy-revision": "owner-policy-7", evidence: "cab/2026-11/exports", "certified-by": "rev-a", "second-reviewer": "rev-b", days: "30" };
    const c = certificationFor(base);
    assert.equal(c.risk, "R3");
    assert.equal(c.contract_revision, rev);
    assert.throws(() => certificationFor({ ...base, capability: "karryam.customer.review.submit" }), /CAPABILITY_NOT_HIGH_RISK/);
    assert.throws(() => certificationFor({ ...base, capability: "karryam.taxi.read" }), /CAPABILITY_NOT_A_SOURCE_COMMAND/);
    assert.throws(() => certificationFor({ ...base, "second-reviewer": "rev-a" }), /TWO_DISTINCT_REVIEWERS_REQUIRED/);
    assert.throws(() => certificationFor({ ...base, days: "365" }), /DAYS_INVALID/);
  });

  const insert = (over = {}) => {
    const c = { id: randomUUID(), capability_id: CAP, risk: "R3", contract_revision: rev, source_policy_revision: "owner-policy-7", evidence_ref: "cab/1", certified_by: "rev-a", second_reviewer: "rev-b",
      valid_from: new Date(Date.now() - 60000), expires_at: new Date(Date.now() + 86400000), ...over };
    return owner.query(`INSERT INTO karryam_admin.high_risk_certifications (id, capability_id, risk, contract_revision, source_policy_revision, evidence_ref, certified_by, second_reviewer, valid_from, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.id, c.capability_id, c.risk, c.contract_revision, c.source_policy_revision, c.evidence_ref, c.certified_by, c.second_reviewer, c.valid_from, c.expires_at]).then(() => c);
  };

  let cert;
  await t.test("certifications: operator-only, two reviewers, bounded validity, one live per capability, revoked once", async () => {
    await rejects(runtime.query(`INSERT INTO karryam_admin.high_risk_certifications (id, capability_id, risk, contract_revision, source_policy_revision, evidence_ref, certified_by, second_reviewer, valid_from, expires_at)
      VALUES ($1,$2,'R3',$3,'p','e','a','b',now(),now() + interval '1 day')`, [randomUUID(), CAP, rev]), "42501");
    await rejects(insert({ second_reviewer: "rev-a" }), /high_risk_two_reviewers/);
    await rejects(insert({ expires_at: new Date(Date.now() + 200 * 86400000) }), /high_risk_validity/);
    await rejects(insert({ risk: "R2" }), /risk_check/);
    cert = await insert();
    await rejects(insert(), /high_risk_certifications_live_uq/);
    const store = pgCertifications(runtime);
    assert.equal((await store.active(CAP, rev)).certification_id, cert.id);
    assert.equal(await store.active(CAP, "0".repeat(64)), null, "a certification never carries over to another contract revision");
    assert.deepEqual(await store.activeIds(rev), [CAP]);
    await rejects(owner.query(`UPDATE karryam_admin.high_risk_certifications SET expires_at = expires_at + interval '1 day' WHERE id = $1`, [cert.id]), /immutable/);
    await rejects(owner.query(`DELETE FROM karryam_admin.high_risk_certifications`), /not permitted/);
    await rejects(runtime.query(`UPDATE karryam_admin.high_risk_certifications SET revoked_at = now(), revoked_by = 'x', revocation_reason = 'SELF_SERVICE' WHERE id = $1`, [cert.id]), "42501");
    const expired = pgCertifications(runtime, { now: () => Date.now() + 2 * 86400000 });
    assert.equal(await expired.active(CAP, rev), null, "expired certifications are not in force");
  });

  await t.test("bound approvals: concurrent consumption uses one, certification and policy changes void the rest", async () => {
    const approvals = pgApprovals(runtime);
    const scope = { market: ["NG-LAGOS"], organization: ["karryam-ng"] };
    const digest = "sha256:" + "a".repeat(64);
    const make = async () => {
      const id = randomUUID();
      await approvals.propose({ id, capabilityId: CAP, intentDigest: digest, scope, requestedBy: "staff-17", ttlSeconds: 600, risk: "R3", expectedVersion: 3, sourcePolicyRevision: "owner-policy-7", certificationId: cert.id });
      await approvals.decide({ id, decidedBy: "staff-99", approve: true, mfaAt: Math.floor(Date.now() / 1000) });
      return id;
    };
    const binding = { capabilityId: CAP, intentDigest: digest, scope, requestedBy: "staff-17", expectedVersion: 3, certificationId: cert.id, sourcePolicyRevision: "owner-policy-7" };
    const id = await make();
    const results = await Promise.allSettled([1, 2, 3].map(() => approvals.consume({ id, operationId: randomUUID(), ...binding })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one concurrent consumer wins");
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.reason === "APPROVAL_ALREADY_CONSUMED"));

    const id2 = await make();
    await rejects(approvals.consume({ id: id2, operationId: randomUUID(), ...binding, expectedVersion: 4 }), /APPROVAL_SOURCE_VERSION_CHANGED/);
    await rejects(approvals.consume({ id: id2, operationId: randomUUID(), ...binding, sourcePolicyRevision: "owner-policy-8" }), /APPROVAL_POLICY_CHANGED/);
    await rejects(approvals.consume({ id: id2, operationId: randomUUID(), ...binding, certificationId: randomUUID() }), /APPROVAL_CERTIFICATION_CHANGED/);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET certification_id = NULL WHERE id = $1`, [id2]), /binding is immutable/);
    await rejects(runtime.query(`UPDATE karryam_admin.approval_references SET expected_version = 4 WHERE id = $1`, [id2]), /binding is immutable/);
    await approvals.revoke({ id: id2, revokedBy: "staff-60", reasonCode: "APPROVER_ACCESS_REMOVED" });
    await rejects(approvals.consume({ id: id2, operationId: randomUUID(), ...binding }), /APPROVAL_REVOKED/);
    await rejects(approvals.revoke({ id: await make(), revokedBy: "staff-17", reasonCode: "WITHDRAWN" }), /REQUESTER_CANNOT_REVOKE_APPROVAL/);
  });
});

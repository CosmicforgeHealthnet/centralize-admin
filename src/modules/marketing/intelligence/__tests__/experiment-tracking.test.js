const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { experimentCreateSchema, experimentUpdateSchema, experimentCompleteSchema, experimentCancelSchema } = require("../experiments/experiment.validator");
const { createExperimentService } = require("../experiments/experiment.service");

const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const SEEDED_EXPERIMENT_ID = "11111111-1111-4111-8111-111111111111";

const validCreate = () => ({ name: "Creative format comparison", hypothesis: "Video will improve conversion rate.", metric: "CONVERSION_RATE", variantAConfig: { creativeExternalId: "image-1", ctaType: "LEARN_MORE", dailyBudgetReference: 100 }, variantBConfig: { dailyBudgetReference: 100, ctaType: "LEARN_MORE", creativeExternalId: "video-1" }, platform: "META", campaignExternalId: "campaign-a" });
const validResult = () => ({ variantA: { sampleSize: 1000, metricValue: "0.042" }, variantB: { sampleSize: 980, metricValue: "0.051" }, winner: "B", confidenceNote: "Manual analysis", dataSource: "Marketing Intelligence snapshots", analysisWindow: { from: "2026-07-01", to: "2026-07-14" } });

test("create validation accepts four metrics and canonical distinct JSON objects", () => {
  for (const metric of ["CTR", "CPC", "CPA", "CONVERSION_RATE"]) assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), metric }).success, true);
  const parsed = experimentCreateSchema.parse(validCreate());
  assert.deepEqual(Object.keys(parsed.variantBConfig), ["creativeExternalId", "ctaType", "dailyBudgetReference"]);
});

test("create validation rejects missing hypothesis, unsupported metrics, nonobjects, and canonical identical variants", () => {
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), hypothesis: "" }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), metric: "ROAS" }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: [] }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantBConfig: { ctaType: "LEARN_MORE", dailyBudgetReference: 100, creativeExternalId: "image-1" } }).success, false);
});

test("variants reject oversized, deeply nested, secret-like, and executable metadata", () => {
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: { notes: "x".repeat(17000) } }).success, false);
  let deep = { value: "x" }; for (let i = 0; i < 8; i += 1) deep = { nested: deep };
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: deep }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: { accessToken: "token-value" } }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: { notes: "<script>alert(1)</script>" } }).success, false);
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: { authorization: "Bearer secret-value" } }).success, false);
  for (const key of ["refreshToken", "clientSecret", "apiKey", "password", "privateKey", "prototype", "constructor", "eval", "command", "providerWrite", "mutation"]) {
    assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: { nested: [{ [key]: "unsafe" }] } }).success, false, key);
  }
  assert.equal(experimentCreateSchema.safeParse({ ...validCreate(), variantAConfig: JSON.parse('{"__proto__":{"polluted":true}}') }).success, false);
});

test("result validation requires structured decimal strings, valid winner, and honest significance evidence", () => {
  assert.equal(experimentCompleteSchema.safeParse({ result: validResult(), conclusion: "Variant B performed better." }).success, true);
  assert.equal(experimentCompleteSchema.safeParse({ result: { ...validResult(), winner: "C" } }).success, false);
  assert.equal(experimentCompleteSchema.safeParse({ result: { ...validResult(), variantA: { sampleSize: 1, metricValue: 0.4 } } }).success, false);
  assert.equal(experimentCompleteSchema.safeParse({ result: { ...validResult(), confidenceNote: "Statistically significant" } }).success, false);
  assert.equal(experimentCompleteSchema.safeParse({ result: { ...validResult(), confidenceNote: "Statistically significant", significanceMethod: "Documented z-test", significanceEvidence: "Method output reviewed manually" } }).success, true);
  for (const claim of ["95% confidence", "p-value 0.03", "confidence interval excludes zero"]) assert.equal(experimentCompleteSchema.safeParse({ result: { ...validResult(), confidenceNote: claim } }).success, false, claim);
  assert.equal(experimentCompleteSchema.safeParse({ result: validResult(), conclusion: "Result has 95% confidence" }).success, false);
});

function fakeDb(seed = []) {
  let state = { experiments: structuredClone(seed), audits: [] };
  const db = {
    snapshot: () => state,
    async $transaction(callback) {
      const draft = structuredClone(state);
      const delegate = {
        create: async ({ data }) => { const row = { id: `00000000-0000-4000-8000-${String(draft.experiments.length + 1).padStart(12, "0")}`, createdAt: new Date("2026-07-19T00:00:00Z"), updatedAt: new Date("2026-07-19T00:00:00Z"), result: null, conclusion: null, startedAt: null, endedAt: null, cancelledAt: null, cancellationReason: null, ...data }; draft.experiments.push(row); return { ...row }; },
        findUnique: async ({ where }) => draft.experiments.find((item) => item.id === where.id) || null,
        updateMany: async ({ where, data }) => { const row = draft.experiments.find((item) => item.id === where.id && (!where.status || item.status === where.status) && (where.version === undefined || item.version === where.version)); if (!row) return { count: 0 }; for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && value.increment ? Number(row[key]) + value.increment : value; return { count: 1 }; },
      };
      const tx = { marketing_experiments: delegate, marketing_ad_platform_connections: { findUnique: async () => ({ id: "connection", platform: "META" }) }, auditLog: { create: async ({ data }) => { const row = { id: `audit-${draft.audits.length + 1}`, ...data }; draft.audits.push(row); return row; } } };
      const result = await callback(tx); state = draft; return result;
    },
    marketing_experiments: {
      findUnique: async ({ where }) => state.experiments.find((item) => item.id === where.id) || null,
      findMany: async () => state.experiments,
      count: async () => state.experiments.length,
    },
  };
  return db;
}

const actor = { id: ACTOR_ID, ipAddress: "127.0.0.1", userAgent: "test" };

test("create stores a DRAFT, creator, canonical variants, version, and compact audit", async () => {
  const db = fakeDb(); const service = createExperimentService({ prisma: db, now: () => new Date("2026-07-19T00:00:00Z") });
  const payload = experimentCreateSchema.parse(validCreate());
  const created = await service.create(payload, actor);
  assert.equal(created.status, "DRAFT"); assert.equal(created.createdByAdminUserId, ACTOR_ID); assert.equal(created.version, 1); assert.equal(db.snapshot().audits.length, 1);
  assert.ok(db.snapshot().audits[0].metadata.variantFingerprint); assert.equal(db.snapshot().audits[0].metadata.variantAConfig, undefined);
});

test("DRAFT editing increments optimistic version and preserves creator", async () => {
  const db = fakeDb(); const service = createExperimentService({ prisma: db }); const created = await service.create(experimentCreateSchema.parse(validCreate()), actor);
  const updated = await service.update(created.id, experimentUpdateSchema.parse({ name: "Updated experiment" }), actor);
  assert.equal(updated.name, "Updated experiment"); assert.equal(updated.version, 2); assert.equal(updated.createdByAdminUserId, ACTOR_ID); assert.equal(db.snapshot().audits.at(-1).action, "MARKETING_EXPERIMENT_UPDATED");
});

test("generic PATCH cannot change status and non-drafts are immutable", async () => {
  assert.equal(experimentUpdateSchema.safeParse({ status: "RUNNING" }).success, false);
  for (const status of ["RUNNING", "COMPLETED", "CANCELLED"]) {
    const db = fakeDb([{ id: SEEDED_EXPERIMENT_ID, ...validCreate(), status, version: 1, createdByAdminUserId: ACTOR_ID }]);
    await assert.rejects(() => createExperimentService({ prisma: db }).update(SEEDED_EXPERIMENT_ID, { name: "No" }, actor), (error) => error.statusCode === 409);
  }
});

test("DRAFT starts once with UTC time and start actor audit", async () => {
  const now = new Date("2026-07-20T10:00:00Z"); const db = fakeDb(); const service = createExperimentService({ prisma: db, now: () => now }); const created = await service.create(experimentCreateSchema.parse(validCreate()), actor);
  const running = await service.start(created.id, actor);
  assert.equal(running.status, "RUNNING"); assert.equal(running.startedAt.toISOString(), now.toISOString()); assert.equal(db.snapshot().audits.at(-1).action, "MARKETING_EXPERIMENT_STARTED");
  assert.equal(db.snapshot().audits.at(-1).adminUserId, ACTOR_ID); assert.equal(db.snapshot().audits.at(-1).metadata.previousStatus, "DRAFT"); assert.equal(db.snapshot().audits.at(-1).metadata.newStatus, "RUNNING");
  await assert.rejects(() => service.start(created.id, actor), (error) => error.statusCode === 409);
});

test("only RUNNING completes with canonical structured result and becomes immutable", async () => {
  const now = new Date("2026-07-21T10:00:00Z"); const db = fakeDb(); const service = createExperimentService({ prisma: db, now: () => now }); const created = await service.create(experimentCreateSchema.parse(validCreate()), actor);
  await assert.rejects(() => service.complete(created.id, { result: validResult() }, actor), (error) => error.statusCode === 409);
  await service.start(created.id, actor); const completed = await service.complete(created.id, { result: validResult(), conclusion: "B won." }, actor);
  assert.equal(completed.status, "COMPLETED"); assert.equal(completed.endedAt.toISOString(), now.toISOString()); assert.equal(completed.result.variantA.metricValue, "0.042"); assert.equal(db.snapshot().audits.at(-1).action, "MARKETING_EXPERIMENT_COMPLETED");
  assert.equal(db.snapshot().audits.at(-1).adminUserId, ACTOR_ID); assert.equal(db.snapshot().audits.at(-1).metadata.previousStatus, "RUNNING"); assert.equal(db.snapshot().audits.at(-1).metadata.newStatus, "COMPLETED");
  await assert.rejects(() => service.update(created.id, { name: "No" }, actor), (error) => error.statusCode === 409);
  await assert.rejects(() => service.cancel(created.id, "No", actor), (error) => error.statusCode === 409);
});

test("DRAFT and RUNNING cancel historically with reason, time, actor, and previous state audit", async () => {
  for (const start of [false, true]) {
    const now = new Date("2026-07-22T10:00:00Z"); const db = fakeDb(); const service = createExperimentService({ prisma: db, now: () => now }); const created = await service.create(experimentCreateSchema.parse(validCreate()), actor);
    if (start) await service.start(created.id, actor);
    const cancelled = await service.cancel(created.id, experimentCancelSchema.parse({ reason: "Test stopped safely" }).reason, actor);
    assert.equal(cancelled.status, "CANCELLED"); assert.equal(cancelled.cancelledAt.toISOString(), now.toISOString()); assert.equal(cancelled.cancellationReason, "Test stopped safely"); assert.equal(db.snapshot().audits.at(-1).metadata.previousStatus, start ? "RUNNING" : "DRAFT");
    assert.equal(db.snapshot().audits.at(-1).adminUserId, ACTOR_ID); assert.equal(db.snapshot().audits.at(-1).metadata.newStatus, "CANCELLED");
    await assert.rejects(() => service.cancel(created.id, "again", actor), (error) => error.statusCode === 409);
  }
});

test("experiment routes use VIEW/EDIT and implementation is tracking-only", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/experiments"[\s\S]*?"EDIT"/); assert.match(routes, /"\/experiments"[\s\S]*?"VIEW"/);
  for (const action of ["start", "complete", "cancel"]) assert.match(routes, new RegExp(`"/experiments/:id/${action}"[\\s\\S]*?"EDIT"`));
  const dir = path.join(__dirname, "../experiments"); const source = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
  assert.doesNotMatch(source, /fetch\(|axios\.|createCampaign|createAd|updateBudget|pauseCampaign|eval\(|new Function/);
});

test("Sections 10-13 scheduling is independently registered while Phase 1 sync remains independent", () => {
  const server = fs.readFileSync(path.join(__dirname, "../../../../server.js"), "utf8");
  assert.match(server, /registerMarketingIntelligenceCron/);
  assert.match(server, /registerIntelligenceSchedulers/);
  const docs = fs.readFileSync(path.join(__dirname, "../../../../../docs/marketing-intelligence-phase-2.md"), "utf8");
  assert.match(docs, /MARKETING_RECOMMENDATION_SCHEDULER_ENABLED/);
  assert.match(docs, /MARKETING_ALERT_SCHEDULER_ENABLED/);
});

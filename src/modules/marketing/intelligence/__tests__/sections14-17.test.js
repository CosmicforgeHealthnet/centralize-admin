const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SETTING_REGISTRY, SETTING_KEYS } = require("../setting-registry");
const { createSettingsService, normalizeValue, scopeFingerprint } = require("../settings.service");
const { settingsQuerySchema, settingsPatchSchema } = require("../settings.validator");
const { createRunQueryService, sanitizeSummary } = require("../run-query.service");
const { runListSchema } = require("../run.validator");
const { createFullEvaluationService, FULL_EVALUATION_LOCK_KEY } = require("../full-evaluation.service");
const { validateIntelligenceSchedulerEnvironment } = require("../scheduling/scheduler-config");
const { createRecommendationLifecycleService } = require("../recommendations/recommendation-lifecycle.service");
const { requireOperationActor } = require("../actor-validation");
const { createAlertEvaluationService, ALERT_LOCK_KEYS } = require("../alerts/alert-evaluation.service");

const connectionId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const assigneeId = "33333333-3333-4333-8333-333333333333";

function row(id, key, scopeType, value, extra = {}) {
  return { id, key, scopeType, platform: null, connectionId: null, currencyCode: null, scopeFingerprint: scopeType, valueType: SETTING_REGISTRY[key]?.type || "JSON", valueJson: { value }, version: 1, ...extra };
}

function settingsDb(seed = []) {
  let state = { rows: structuredClone(seed), audits: [] };
  const users = [
    { id: actorId, status: "ACTIVE", tier: "ADMIN", department: "MARKETING", sectionGrants: [] },
    { id: assigneeId, status: "ACTIVE", tier: "EMPLOYEE", department: "MARKETING", sectionGrants: [] },
    { id: "44444444-4444-4444-8444-444444444444", status: "INACTIVE", tier: "ADMIN", department: "MARKETING", sectionGrants: [] },
  ];
  const connections = [{ id: connectionId, platform: "META", currency: "EUR", status: "ACTIVE" }];
  function delegates(target) {
    return {
      marketing_intelligence_settings: {
        findMany: async () => target.rows.map((item) => ({ ...item })),
        findUnique: async ({ where }) => {
          if (where.id) return target.rows.find((item) => item.id === where.id) || null;
          const identity = where.key_scopeFingerprint;
          return target.rows.find((item) => item.key === identity.key && item.scopeFingerprint === identity.scopeFingerprint) || null;
        },
        create: async ({ data }) => { const created = { id: `setting-${target.rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data }; target.rows.push(created); return { ...created }; },
        updateMany: async ({ where, data }) => { const item = target.rows.find((candidate) => candidate.id === where.id && candidate.version === where.version); if (!item) return { count: 0 }; const { version: _version, ...rest } = data; Object.assign(item, rest, { version: item.version + 1, updatedAt: new Date() }); return { count: 1 }; },
        upsert: async () => { throw new Error("not used"); },
      },
      marketing_ad_platform_connections: { findUnique: async ({ where }) => connections.find((item) => item.id === where.id) || null },
      adminUser: { findUnique: async ({ where }) => users.find((item) => item.id === where.id) || null },
      auditLog: { create: async ({ data }) => { target.audits.push(data); return data; } },
    };
  }
  const db = {
    ...delegates(state), snapshot: () => structuredClone(state),
    async $transaction(callback) { const draft = structuredClone(state); const result = await callback(delegates(draft)); state = draft; Object.assign(db, delegates(state)); return result; },
  };
  return db;
}

test("Section 14 registry contains every required canonical setting and safe bootstrap defaults", () => {
  for (const key of ["targetCpa", "underperformThresholdPct", "scaleThresholdPct", "minimumSpend", "minimumClicks", "minimumSignups", "minimumPayments", "recommendationLookbackDays", "comparisonLookbackDays", "attributionWindowDays", "creativeFatigueThresholdPct", "creativeMinimumImpressions", "maximumRecommendedScalePct", "alertCooldownMinutes", "defaultMarketingAssigneeAdminUserId", "recommendationEvaluationEnabled", "alertEvaluationEnabled", "creativeSyncEnabled", "llmCommentaryEnabled"]) assert.ok(SETTING_KEYS.includes(key), key);
  assert.equal(SETTING_REGISTRY.attributionWindowDays.default, 30);
  assert.equal(SETTING_REGISTRY.creativeFatigueThresholdPct.default, "0.25");
  assert.equal(SETTING_REGISTRY.creativeMinimumImpressions.default, 1000);
  assert.equal(SETTING_REGISTRY.llmCommentaryEnabled.default, false);
  assert.equal(SETTING_REGISTRY.targetCpa.default, null);
  assert.equal(SETTING_REGISTRY.minimumSpend.default, null);
  assert.equal(SETTING_REGISTRY.defaultMarketingAssigneeAdminUserId.default, null);
  assert.equal(SETTING_REGISTRY.defaultMarketingAssigneeAdminUserId.format, "UUID");
});

test("setting value boundaries accept exact limits and reject outside values", () => {
  for (const value of [0, 1]) assert.equal(normalizeValue("underperformThresholdPct", value), String(value));
  for (const value of [1, 90]) assert.equal(normalizeValue("recommendationLookbackDays", value), value);
  for (const value of [5, 10080]) assert.equal(normalizeValue("alertCooldownMinutes", value), value);
  for (const [key, value] of [["underperformThresholdPct", -0.01], ["underperformThresholdPct", 1.01], ["recommendationLookbackDays", 0], ["recommendationLookbackDays", 91], ["alertCooldownMinutes", 4], ["alertCooldownMinutes", 10081]]) assert.throws(() => normalizeValue(key, value));
});

test("connection overrides platform and global while currency identity prevents cross-currency resolution", async () => {
  const db = settingsDb([
    row("g-eur", "targetCpa", "GLOBAL", "30", { scopeFingerprint: "GLOBAL:CURRENCY:EUR", currencyCode: "EUR" }),
    row("g-usd", "targetCpa", "GLOBAL", "90", { scopeFingerprint: "GLOBAL:CURRENCY:USD", currencyCode: "USD" }),
    row("p", "targetCpa", "PLATFORM", "25", { scopeFingerprint: "PLATFORM:META:CURRENCY:EUR", platform: "META", currencyCode: "EUR" }),
    row("c", "targetCpa", "CONNECTION", "20", { scopeFingerprint: `CONNECTION:${connectionId}:CURRENCY:EUR`, platform: "META", connectionId, currencyCode: "EUR" }),
  ]);
  const service = createSettingsService({ prisma: db, log: { warn() {} } });
  const eur = await service.resolveSettings({ platform: "META", connectionId, currencyCode: "EUR" }, { keys: ["targetCpa"] });
  const usd = await service.resolveSettings({ platform: "META", currencyCode: "USD" }, { keys: ["targetCpa"] });
  assert.equal(eur.values.targetCpa, "20"); assert.equal(eur.sources.targetCpa.scopeType, "CONNECTION");
  assert.equal(usd.values.targetCpa, "90"); assert.equal(usd.sources.targetCpa.scopeType, "GLOBAL");
  assert.notEqual(scopeFingerprint({ scope: "GLOBAL", currencyCode: "EUR" }), scopeFingerprint({ scope: "GLOBAL", currencyCode: "USD" }));
});

test("monetary settings never use a cross-currency or universal numeric bootstrap", async () => {
  const db = settingsDb([
    row("target-eur", "targetCpa", "GLOBAL", "25", { scopeFingerprint: "GLOBAL:CURRENCY:EUR", currencyCode: "EUR" }),
    row("spend-usd", "minimumSpend", "GLOBAL", "40", { scopeFingerprint: "GLOBAL:CURRENCY:USD", currencyCode: "USD" }),
  ]);
  const service = createSettingsService({ prisma: db, log: { warn() {} } });
  const ngn = await service.resolveSettings({ currencyCode: "NGN" }, { keys: ["targetCpa"] });
  const eur = await service.resolveSettings({ currencyCode: "EUR" }, { keys: ["minimumSpend"] });
  const missingContext = await service.resolveSettings({}, { keys: ["targetCpa", "minimumSpend"] });
  assert.equal(ngn.values.targetCpa, null);
  assert.equal(eur.values.minimumSpend, null);
  assert.deepEqual(missingContext.values, { targetCpa: null, minimumSpend: null });
  assert.ok(ngn.warnings.some((item) => item.reasonCode === "SETTING_MONETARY_VALUE_UNAVAILABLE"));
  assert.ok(missingContext.warnings.every((item) => item.reasonCode === "SETTING_CURRENCY_CONTEXT_REQUIRED"));
});

test("different monetary currencies coexist while duplicate identity and missing currency are rejected", async () => {
  const db = settingsDb(); const service = createSettingsService({ prisma: db }); const actor = { id: actorId };
  await service.updateSettings([
    { key: "targetCpa", scope: "GLOBAL", currencyCode: "EUR", value: "25", expectedVersion: 0 },
    { key: "targetCpa", scope: "GLOBAL", currencyCode: "USD", value: "30", expectedVersion: 0 },
  ], actor);
  assert.equal(db.snapshot().rows.length, 2);
  await assert.rejects(() => service.updateSettings([{ key: "targetCpa", scope: "GLOBAL", currencyCode: "EUR", value: "26", expectedVersion: 0 }], actor), (error) => error.errors[0].code === "SETTING_VERSION_CONFLICT");
  await assert.rejects(() => service.updateSettings([{ key: "minimumSpend", scope: "GLOBAL", value: "10", expectedVersion: 0 }], actor), (error) => error.errors[0].code === "SETTING_CURRENCY_REQUIRED");
});

test("invalid stored values fall through with stable sanitized operational warnings", async () => {
  const warnings = [];
  const db = settingsDb([row("bad", "minimumClicks", "CONNECTION", "Bearer secret-token", { connectionId, platform: "META", scopeFingerprint: `CONNECTION:${connectionId}` }), row("global", "minimumClicks", "GLOBAL", 44, { scopeFingerprint: "GLOBAL" })]);
  const result = await createSettingsService({ prisma: db, log: { warn: (message) => warnings.push(message) } }).resolveSettings({ platform: "META", connectionId }, { keys: ["minimumClicks"] });
  assert.equal(result.values.minimumClicks, 44);
  assert.equal(result.warnings[0].reasonCode, "SETTING_SCOPE_INVALID");
  assert.doesNotMatch(JSON.stringify(result.warnings) + warnings.join(""), /secret-token|Bearer/);
});

test("write validation enforces scopes, currency, connection context and active Marketing assignee", async () => {
  const service = createSettingsService({ prisma: settingsDb() });
  const actor = { id: actorId };
  await assert.rejects(() => service.validateUpdate({ key: "attributionWindowDays", scope: "CONNECTION", connectionId, value: 30, expectedVersion: 0 }, actor, settingsDb()), (error) => error.errors[0].code === "SETTING_SCOPE_INVALID");
  await assert.rejects(() => service.validateUpdate({ key: "targetCpa", scope: "GLOBAL", value: 20, expectedVersion: 0 }, actor, settingsDb()), (error) => error.errors[0].code === "SETTING_CURRENCY_REQUIRED");
  await assert.rejects(() => service.updateSettings([{ key: "defaultMarketingAssigneeAdminUserId", scope: "GLOBAL", value: "44444444-4444-4444-8444-444444444444", expectedVersion: 0 }], actor), (error) => error.errors[0].code === "SETTING_ADMIN_INACTIVE");
  const saved = await service.updateSettings([{ key: "defaultMarketingAssigneeAdminUserId", scope: "GLOBAL", value: assigneeId, expectedVersion: 0 }], actor);
  assert.equal(saved[0].value, assigneeId);
  assert.throws(() => normalizeValue("defaultMarketingAssigneeAdminUserId", "fallback"), /UUID/);
});

test("nullable assignee setting clears safely and inactive connection override falls through to global", async () => {
  const inactiveId = "44444444-4444-4444-8444-444444444444";
  const db = settingsDb([
    row("global-assignee", "defaultMarketingAssigneeAdminUserId", "GLOBAL", assigneeId, { scopeFingerprint: "GLOBAL", valueType: "STRING" }),
    row("connection-assignee", "defaultMarketingAssigneeAdminUserId", "CONNECTION", inactiveId, { scopeFingerprint: `CONNECTION:${connectionId}`, platform: "META", connectionId, valueType: "STRING" }),
  ]);
  const service = createSettingsService({ prisma: db, log: { warn() {} } });
  const resolved = await service.resolveSettings({ platform: "META", connectionId }, { keys: ["defaultMarketingAssigneeAdminUserId"] });
  assert.equal(resolved.values.defaultMarketingAssigneeAdminUserId, assigneeId);
  assert.equal(resolved.sources.defaultMarketingAssigneeAdminUserId.scopeType, "GLOBAL");
  assert.ok(resolved.warnings.some((item) => item.reasonCode === "SETTING_ADMIN_INACTIVE"));
  const cleared = await service.updateSettings([{ key: "defaultMarketingAssigneeAdminUserId", scope: "GLOBAL", value: null, expectedVersion: 1 }], { id: actorId });
  assert.equal(cleared[0].value, null);
  const after = await service.getSettings({}, { includeConfigured: true, includeDefaults: true });
  assert.equal(after.effective.defaultMarketingAssigneeAdminUserId.value, null);
  assert.equal(after.effective.defaultMarketingAssigneeAdminUserId.source, "BOOTSTRAP");
  assert.equal(after.effective.defaultMarketingAssigneeAdminUserId.version, null);
});

test("versioned atomic batches increment, audit sanitized old/new values, reject stale writes and roll back", async () => {
  const db = settingsDb(); const service = createSettingsService({ prisma: db }); const actor = { id: actorId, ipAddress: "127.0.0.1" };
  const created = await service.updateSettings([{ key: "minimumClicks", scope: "GLOBAL", value: 40, expectedVersion: 0 }], actor);
  assert.equal(created[0].version, 1); assert.equal(db.snapshot().audits.length, 1);
  const updated = await service.updateSettings([{ key: "minimumClicks", scope: "GLOBAL", value: 50, expectedVersion: 1 }], actor);
  assert.equal(updated[0].version, 2); assert.deepEqual(db.snapshot().audits.at(-1).metadata, { key: "minimumClicks", scope: "GLOBAL", platform: null, connectionId: null, currencyCode: null, oldValue: 40, newValue: 50, oldVersion: 1, newVersion: 2 });
  await assert.rejects(() => service.updateSettings([{ key: "minimumClicks", scope: "GLOBAL", value: 60, expectedVersion: 1 }], actor), (error) => error.statusCode === 409 && error.errors[0].code === "SETTING_VERSION_CONFLICT");
  const before = db.snapshot();
  await assert.rejects(() => service.updateSettings([{ key: "minimumClicks", scope: "GLOBAL", value: 70, expectedVersion: 2 }, { key: "llmCommentaryEnabled", scope: "PLATFORM", platform: "META", value: true, expectedVersion: 0 }], actor));
  assert.deepEqual(db.snapshot(), before);
});

test("settings schemas reject unknown fields and expose reserved LLM toggle without activating network code", () => {
  assert.equal(settingsQuerySchema.safeParse({ platform: "meta", currencyCode: "eur", includeDefaults: "true" }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ updates: [{ key: "llmCommentaryEnabled", scope: "GLOBAL", value: false, expectedVersion: 0 }] }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ updates: [{ key: "defaultMarketingAssigneeAdminUserId", scope: "GLOBAL", value: null, expectedVersion: 1 }] }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ updates: [{ key: "llmCommentaryEnabled", scope: "PLATFORM", platform: "META", value: true, expectedVersion: 0, providerWrite: true }] }).success, false);
  const source = fs.readFileSync(path.join(__dirname, "../setting-registry.js"), "utf8") + fs.readFileSync(path.join(__dirname, "../settings.service.js"), "utf8");
  assert.doesNotMatch(source, /openai|anthropic|fetch\(|axios\.|new Function|eval\(/i);
});

test("evaluation-run query allowlists filters/sorts and removes lock or raw payload material", async () => {
  const rows = [{ id: "run-1", runType: "FULL_EVALUATION", trigger: "SCHEDULED", status: "PARTIAL_SUCCESS", platform: null, connectionId: null, accountExternalId: null, windowStart: null, windowEnd: null, startedAt: new Date(), completedAt: new Date(), processedCount: 2, createdCount: 1, updatedCount: 0, succeededCount: 1, failedCount: 1, skippedCount: 0, errorCode: null, sanitizedError: "Bearer secret-token", lockOwnerHash: "hidden", summary: { steps: { ok: true }, rawProviderPayload: "secret", authorization: "Bearer abc", nested: [{ accessToken: "x", status: "FAILED" }] } }];
  let received;
  const db = { marketing_intelligence_evaluation_runs: { count: async () => 1, findMany: async (args) => { received = args; return rows; }, findUnique: async () => rows[0] } };
  const query = runListSchema.parse({ type: "FULL_EVALUATION", sort: "startedAt", direction: "desc", page: "1", limit: "25" });
  const listed = await createRunQueryService({ prisma: db }).list(query);
  assert.equal(received.orderBy[0].startedAt, "desc"); assert.equal(listed.items[0].lockOwnerHash, undefined);
  assert.doesNotMatch(JSON.stringify(listed), /secret-token|secret|Bearer abc|accessToken|rawProviderPayload/);
  assert.deepEqual(sanitizeSummary({ safe: 1, cookie: "x" }), { safe: 1 });
});

test("full evaluation resolves settings before ordered internal steps and isolates a connection-step failure", async () => {
  const order = []; const runs = [];
  const lock = { acquire: async (key) => { assert.equal(key, FULL_EVALUATION_LOCK_KEY); return "owner"; }, startHeartbeat: () => ({ failed: () => false, stop() { order.push("heartbeat-stop"); } }), release: async () => { order.push("release"); } };
  const ledger = { startRun: async (data) => { runs.push(data); return { id: "full-run" }; }, finishRun: async (_id, data) => runs.push(data) };
  const settings = { resolveSettings: async ({ connectionId: id }) => { order.push(`settings:${id}`); return { fingerprint: `fp-${id}`, values: { creativeSyncEnabled: true, recommendationEvaluationEnabled: true, alertEvaluationEnabled: true } }; } };
  const db = { marketing_ad_platform_connections: { findMany: async () => [{ id: connectionId, platform: "META", currency: "EUR" }] } };
  const service = createFullEvaluationService({ prisma: db, syncLock: lock, runLedger: ledger, settingsService: settings,
    creativeSync: { syncCreatives: async () => { order.push("creativeSync"); return { status: "SUCCEEDED" }; } },
    creativeScoring: { scoreCreatives: async () => { order.push("creativeScore"); return { status: "SUCCEEDED" }; } },
    recommendations: { evaluate: async () => { order.push("recommendations"); throw new Error("Bearer raw-token"); } },
    alerts: { evaluate: async () => { order.push("alerts"); return { status: "SUCCEEDED" }; } },
    expiry: { evaluate: async () => { order.push("expiry"); return { status: "SUCCEEDED" }; } },
  });
  const result = await service.evaluate({ trigger: "SCHEDULED" });
  assert.equal(result.status, "PARTIAL_SUCCESS");
  assert.deepEqual(order.slice(0, 6), [`settings:${connectionId}`, "creativeSync", "creativeScore", "recommendations", "alerts", "expiry"]);
  assert.doesNotMatch(JSON.stringify(runs), /raw-token/);
  assert.equal(runs.at(-1).summary.settingsSnapshot[0].fingerprint, `fp-${connectionId}`);
});

test("scheduler configuration rejects full/component duplication and reuses only node-cron", () => {
  const cron = { validate: () => true };
  assert.throws(() => validateIntelligenceSchedulerEnvironment({ env: { MARKETING_FULL_EVALUATION_SCHEDULER_ENABLED: "true", MARKETING_RECOMMENDATION_SCHEDULER_ENABLED: "true" }, cronLib: cron }), (error) => error.issues.some((issue) => issue.reasonCode === "CONFLICTING_SCHEDULERS"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../../../package.json"), "utf8"));
  assert.equal(packageJson.dependencies["node-cron"], "^4.6.0");
  for (const dependency of ["agenda", "bull", "bullmq", "bree", "node-schedule"]) assert.equal(packageJson.dependencies[dependency], undefined);
});

test("alert health and performance use independent lock namespaces and skip records", async () => {
  const acquired = []; const finished = [];
  const service = createAlertEvaluationService({
    prisma: {},
    syncLock: { acquire: async (key) => { acquired.push(key); return null; } },
    runLedger: { startRun: async () => ({ id: `run-${acquired.length}` }), finishRun: async (_id, data) => finished.push(data) },
  });
  assert.equal((await service.evaluate({ ruleGroup: "health", trigger: "SCHEDULED" })).skipped, true);
  assert.equal((await service.evaluate({ ruleGroup: "performance", trigger: "SCHEDULED" })).skipped, true);
  assert.deepEqual(acquired, [ALERT_LOCK_KEYS.health, ALERT_LOCK_KEYS.performance]);
  assert.deepEqual(finished.map((item) => item.summary.ruleGroup), ["health", "performance"]);
});

test("Section 16 routes expose settings and run APIs with only VIEW/EDIT and safe static ordering", () => {
  const source = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  for (const route of ["/settings", "/evaluation-runs", "/evaluation-runs/:id"]) assert.match(source, new RegExp(`"${route.replace("/", "\\/")}"`));
  assert.match(source, /"\/settings"[\s\S]*?"VIEW"/); assert.match(source, /"\/settings"[\s\S]*?"EDIT"/);
  assert.match(source, /"\/evaluation-runs"[\s\S]*?"VIEW"/);
  assert.doesNotMatch(source, /SETTINGS_EDIT|ALERT_RESOLVE|EXPERIMENT_START/);
  assert.ok(source.indexOf('"/recommendations/evaluate"') < source.indexOf('"/recommendations/:id"'));
  assert.ok(source.indexOf('"/alerts/evaluate"') < source.indexOf('"/alerts/:id"'));
});

test("service-level lifecycle authorization rejects missing and inactive actors before mutation", async () => {
  const recommendationId = "11111111-1111-4111-8111-111111111111";
  const rowState = { id: recommendationId, status: "PENDING", materialEvidenceFingerprint: "fp" };
  const db = { async $transaction(callback) { return callback(this); }, adminUser: { findUnique: async ({ where }) => where.id === actorId ? { id: actorId, status: "INACTIVE" } : null }, marketing_recommendations: { findUnique: async () => rowState, update: async () => { throw new Error("must not mutate"); } }, auditLog: { create: async () => { throw new Error("must not audit"); } } };
  const service = createRecommendationLifecycleService({ prisma: db });
  await assert.rejects(() => service.accept(recommendationId, null), (error) => error.statusCode === 401);
  await assert.rejects(() => service.accept(recommendationId, { id: actorId }), (error) => error.statusCode === 403);
});

test("manual operations require an active actor while scheduled jobs use system context", async () => {
  const db = settingsDb();
  await assert.rejects(requireOperationActor(db, { trigger: "manual-api" }), /Actor context is required/);
  await assert.rejects(requireOperationActor(db, { trigger: "manual-api", requestedByAdminUserId: "44444444-4444-4444-8444-444444444444" }), /Active actor is required/);
  assert.equal((await requireOperationActor(db, { trigger: "manual-api", requestedByAdminUserId: actorId })).id, actorId);
  assert.equal(await requireOperationActor(db, { trigger: "SCHEDULED" }), null);
});

test("provider calls remain outside whole-run database transactions", () => {
  const full = fs.readFileSync(path.join(__dirname, "../full-evaluation.service.js"), "utf8");
  const sync = fs.readFileSync(path.join(__dirname, "../creative/creative-sync.service.js"), "utf8");
  assert.doesNotMatch(full, /\$transaction/);
  assert.match(sync, /fetchCreativeCatalog/); assert.match(sync, /persistCatalogPage/);
  assert.ok(sync.indexOf("fetchCreativeCatalog") < sync.indexOf("persistCatalogPage"));
});

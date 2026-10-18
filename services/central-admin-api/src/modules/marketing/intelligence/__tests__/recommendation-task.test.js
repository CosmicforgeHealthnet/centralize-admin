const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRecommendationTaskAdapter, URGENCY, isEligibleAssignee, taskDescription } = require("../recommendations/recommendation-task.adapter");
const { recommendationConvertToTaskSchema } = require("../recommendations/recommendation.validator");

const IDS = Object.freeze({
  recommendation: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  assignee: "33333333-3333-4333-8333-333333333333",
  requested: "44444444-4444-4444-8444-444444444444",
  inactive: "55555555-5555-4555-8555-555555555555",
  configured: "66666666-6666-4666-8666-666666666666",
  fallbackLow: "77777777-7777-4777-8777-777777777777",
  fallbackHigh: "88888888-8888-4888-8888-888888888888",
  ineligible: "99999999-9999-4999-8999-999999999999",
  missing: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  connection: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
});

function recommendation(overrides = {}) {
  return { id: IDS.recommendation, type: "PAUSE", status: "ACCEPTED", platform: "META", connectionId: IDS.connection, targetCampaignExternalId: "campaign-a", currencyCode: "EUR", reasoning: "CPA exceeded the configured target.", evidence: { observed: "40", target: "25", rawProviderBody: "never-copy" }, suggestedAction: { action: "REVIEW_AND_PAUSE", requiresManualApproval: true, token: "secret" }, analysisWindowStart: new Date("2026-07-01Z"), analysisWindowEnd: new Date("2026-07-07Z"), convertedToTaskId: null, ...overrides };
}

function fakeDb({ rec = recommendation(), admins, failAt } = {}) {
  let state = { recommendation: rec === null ? null : { ...rec }, tasks: [], notifications: [], audits: [] };
  const users = [
    { id: IDS.actor, status: "ACTIVE", department: "OPERATIONS", tier: "ADMIN", isTeamLead: false, createdAt: new Date(0), sectionGrants: [] },
    ...(admins || [{ id: IDS.assignee, status: "ACTIVE", department: "MARKETING", tier: "ADMIN", isTeamLead: true, createdAt: new Date(0), sectionGrants: [] }]),
  ];
  let queue = Promise.resolve();
  const db = {
    snapshot: () => state,
    $transaction(callback) {
      const execute = async () => {
        const draft = structuredClone(state);
        const tx = {
          $queryRaw: async () => true,
          marketing_recommendations: {
            findUnique: async () => draft.recommendation,
            update: async ({ data }) => { if (failAt === "recommendation") throw new Error("update failed"); Object.assign(draft.recommendation, data); return { ...draft.recommendation }; },
          },
          task: {
            create: async ({ data }) => { if (failAt === "task") throw new Error("task failed"); const task = { id: `task-${draft.tasks.length + 1}`, ...data }; draft.tasks.push(task); return task; },
            findUnique: async ({ where }) => draft.tasks.find((task) => task.id === where.id) || state.tasks.find((task) => task.id === where.id) || null,
          },
          adminUser: {
            findUnique: async ({ where }) => users.find((user) => user.id === where.id) || null,
            findMany: async () => users.filter((user) => user.status === "ACTIVE" && user.department === "MARKETING"),
          },
          notification: { create: async ({ data }) => { if (failAt === "notification") throw new Error("notification failed"); const item = { id: `notification-${draft.notifications.length + 1}`, ...data }; draft.notifications.push(item); return item; } },
          auditLog: { create: async ({ data }) => { if (failAt === "audit") throw new Error("audit failed"); const item = { id: `audit-${draft.audits.length + 1}`, ...data }; draft.audits.push(item); return item; } },
        };
        const result = await callback(tx);
        state = draft;
        return result;
      };
      const result = queue.then(execute);
      queue = result.catch(() => {});
      return result;
    },
  };
  return db;
}

const settingsService = { resolveSettings: async () => ({ values: { defaultMarketingAssigneeAdminUserId: null, defaultRecommendationTaskDueDays: 3 } }) };
const notifications = { createNotificationWithClient: (tx, payload) => tx.notification.create({ data: { ...payload, isRead: false } }) };

test("successful conversion atomically creates assigned Task, Notification, audit, and recommendation link", async () => {
  const db = fakeDb(); const realtime = [];
  const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, realtime: (id, payload) => realtime.push([id, payload.taskId]), now: () => new Date("2026-07-19T00:00:00Z") });
  const result = await adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor });
  assert.equal(result.task.assigneeId, IDS.assignee); assert.equal(result.operationalPriority, "HIGH"); assert.equal(result.recommendation.status, "CONVERTED_TO_TASK");
  assert.equal(db.snapshot().tasks.length, 1); assert.equal(db.snapshot().notifications.length, 1); assert.equal(db.snapshot().audits.length, 1); assert.deepEqual(realtime, [[IDS.assignee, "task-1"]]);
  for (const expected of [new RegExp(`Marketing recommendation: ${IDS.recommendation}`), /Operational urgency: HIGH/, /Campaign: campaign-a/, /Analysis window: 2026-07-01 to 2026-07-07/, /Currency: EUR/, /Reasoning: CPA exceeded/, /Evidence summary:/, /Suggested action:/]) assert.match(result.task.description, expected);
  assert.doesNotMatch(result.task.description, /never-copy|secret/);
  assert.deepEqual(db.snapshot().audits[0].metadata, { recommendationId: IDS.recommendation, taskId: "task-1", actorAdminUserId: IDS.actor, assigneeAdminUserId: IDS.assignee, assigneeResolutionSource: "MARKETING_FALLBACK", recommendationType: "PAUSE", previousStatus: "ACCEPTED", newStatus: "CONVERTED_TO_TASK", dueDate: "2026-07-22T00:00:00.000Z", operationalPriority: "HIGH", timestamp: "2026-07-19T00:00:00.000Z" });
  assert.equal(result.assigneeResolutionSource, "MARKETING_FALLBACK");
});

test("only ACCEPTED recommendations convert and missing recommendations return errors", async () => {
  for (const status of ["PENDING", "DISMISSED", "EXPIRED"]) {
    const db = fakeDb({ rec: recommendation({ status }) });
    const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications });
    await assert.rejects(() => adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }), (error) => error.statusCode === 409);
    assert.equal(db.snapshot().tasks.length, 0);
  }
  const missing = fakeDb({ rec: null });
  await assert.rejects(() => createRecommendationTaskAdapter({ prisma: missing, settingsService, notifications }).convert({ recommendationId: IDS.missing, actorAdminUserId: IDS.actor }), (error) => error.statusCode === 404);
});

test("repeat and concurrent conversion return one existing task without duplicate assignment notification", async () => {
  const db = fakeDb(); const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, now: () => new Date("2026-07-19T00:00:00Z") });
  const [first, second] = await Promise.all([
    adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }),
    adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }),
  ]);
  assert.equal(first.task.id, second.task.id); assert.equal(second.idempotent, true); assert.equal(db.snapshot().tasks.length, 1); assert.equal(db.snapshot().notifications.length, 1); assert.equal(db.snapshot().audits.length, 1);
});

test("a converted recommendation pointing to a missing task is an integrity conflict", async () => {
  const db = fakeDb({ rec: recommendation({ status: "CONVERTED_TO_TASK", convertedToTaskId: IDS.missing }) });
  await assert.rejects(() => createRecommendationTaskAdapter({ prisma: db, settingsService, notifications }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }), (error) => error.statusCode === 409);
  assert.equal(db.snapshot().tasks.length, 0);
});

test("request assignee override validates active Marketing eligibility", async () => {
  const eligible = { id: IDS.requested, status: "ACTIVE", department: "OPERATIONS", tier: "EMPLOYEE", sectionGrants: [{ module: "marketing", section: "intelligence", mode: "EDIT", revokedAt: null }] };
  const inactive = { id: IDS.inactive, status: "INACTIVE", department: "MARKETING", tier: "ADMIN", sectionGrants: [] };
  const db = fakeDb({ admins: [eligible, inactive] });
  const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, now: () => new Date("2026-07-19T00:00:00Z") });
  const result = await adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor, assigneeAdminUserId: IDS.requested });
  assert.equal(result.task.assigneeId, IDS.requested);
  assert.equal(result.assigneeResolutionSource, "REQUEST");
  const db2 = fakeDb({ admins: [inactive] });
  await assert.rejects(() => createRecommendationTaskAdapter({ prisma: db2, settingsService, notifications }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor, assigneeAdminUserId: IDS.inactive }), (error) => error.statusCode === 400);
});

test("configured assignee source is audited and request override remains highest precedence", async () => {
  const configured = { id: IDS.configured, status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE", isTeamLead: false, createdAt: new Date(1), sectionGrants: [] };
  const requested = { id: IDS.requested, status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE", isTeamLead: false, createdAt: new Date(2), sectionGrants: [] };
  const assignmentSettingsService = { resolveSettings: async () => ({ values: { defaultMarketingAssigneeAdminUserId: IDS.configured }, sources: { defaultMarketingAssigneeAdminUserId: { scopeType: "CONNECTION" } } }) };
  const db = fakeDb({ admins: [configured, requested] });
  const configuredResult = await createRecommendationTaskAdapter({ prisma: db, settingsService, assignmentSettingsService, notifications, now: () => new Date("2026-07-19T00:00:00Z") }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor });
  assert.equal(configuredResult.assigneeResolutionSource, "CONNECTION_SETTING");
  assert.equal(db.snapshot().audits[0].metadata.assigneeResolutionSource, "CONNECTION_SETTING");

  const db2 = fakeDb({ admins: [configured, requested] });
  const requestResult = await createRecommendationTaskAdapter({ prisma: db2, settingsService, assignmentSettingsService, notifications, now: () => new Date("2026-07-19T00:00:00Z") }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor, assigneeAdminUserId: IDS.requested });
  assert.equal(requestResult.task.assigneeId, IDS.requested);
  assert.equal(requestResult.assigneeResolutionSource, "REQUEST");
});

test("runtime Marketing fallback is deterministic and excludes inactive or ineligible admins", async () => {
  const admins = [
    { id: IDS.fallbackLow, status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE", isTeamLead: true, createdAt: new Date(0), sectionGrants: [] },
    { id: IDS.inactive, status: "INACTIVE", department: "MARKETING", tier: "SUPER", isTeamLead: true, createdAt: new Date(0), sectionGrants: [] },
    { id: IDS.fallbackHigh, status: "ACTIVE", department: "MARKETING", tier: "ADMIN", isTeamLead: false, createdAt: new Date(2), sectionGrants: [] },
    { id: IDS.ineligible, status: "ACTIVE", department: "OPERATIONS", tier: "EMPLOYEE", isTeamLead: true, createdAt: new Date(0), sectionGrants: [] },
  ];
  const db = fakeDb({ admins });
  const result = await createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, now: () => new Date("2026-07-19T00:00:00Z") }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor });
  assert.equal(result.task.assigneeId, IDS.fallbackHigh);
  assert.equal(result.assigneeResolutionSource, "MARKETING_FALLBACK");
});

test("missing default and fallback assignee leaves recommendation untouched", async () => {
  const db = fakeDb({ admins: [] });
  const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService: { resolveSettings: async () => ({ values: { defaultMarketingAssigneeAdminUserId: IDS.missing, defaultRecommendationTaskDueDays: 3 } }) }, notifications });
  await assert.rejects(() => adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }), (error) => error.statusCode === 422);
  assert.equal(db.snapshot().recommendation.status, "ACCEPTED"); assert.equal(db.snapshot().tasks.length, 0);
});

test("priority mapping is deterministic without inventing a Task priority field", () => {
  assert.deepEqual(URGENCY, { PAUSE: "HIGH", SCALE: "MEDIUM", REALLOCATE_BUDGET: "HIGH", CREATE_CONTENT: "MEDIUM" });
  assert.equal(isEligibleAssignee({ status: "ACTIVE", department: "MARKETING", tier: "EMPLOYEE" }), true);
  const schema = fs.readFileSync(path.join(__dirname, "../../../../../prisma/schema.prisma"), "utf8");
  const taskModel = schema.match(/model Task \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(taskModel, /priority/); assert.doesNotMatch(taskModel, /TaskAssignee\[/);
});

test("default and explicit due dates follow existing Task dueDate convention", async () => {
  const db = fakeDb(); const now = new Date("2026-07-19T00:00:00Z");
  const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, now: () => now });
  const result = await adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor, dueDate: "2026-07-25T17:00:00.000Z" });
  assert.equal(result.task.dueDate.toISOString(), "2026-07-25T17:00:00.000Z");
  const db2 = fakeDb(); const automatic = await createRecommendationTaskAdapter({ prisma: db2, settingsService, notifications, now: () => now }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor });
  assert.equal(automatic.task.dueDate.toISOString(), "2026-07-22T00:00:00.000Z");
});

test("Task, Notification, recommendation update, and audit failures roll back the transaction", async () => {
  for (const failAt of ["task", "notification", "recommendation", "audit"]) {
    const db = fakeDb({ failAt });
    await assert.rejects(() => createRecommendationTaskAdapter({ prisma: db, settingsService, notifications }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }));
    assert.equal(db.snapshot().tasks.length, 0, failAt); assert.equal(db.snapshot().notifications.length, 0, failAt); assert.equal(db.snapshot().recommendation.status, "ACCEPTED", failAt);
  }
});

test("realtime failure does not roll back a committed conversion", async () => {
  const db = fakeDb(); const adapter = createRecommendationTaskAdapter({ prisma: db, settingsService, notifications, realtime: () => { throw new Error("socket secret"); } });
  const result = await adapter.convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor });
  assert.equal(result.realtimeDeliveryFailed, true); assert.equal(db.snapshot().tasks.length, 1); assert.equal(db.snapshot().recommendation.status, "CONVERTED_TO_TASK");
});

test("serializable database conflicts map to a stable retryable HTTP 409", async () => {
  const db = { $transaction: async () => { const error = new Error("serialization failed"); error.code = "P2034"; throw error; } };
  await assert.rejects(() => createRecommendationTaskAdapter({ prisma: db, settingsService, notifications }).convert({ recommendationId: IDS.recommendation, actorAdminUserId: IDS.actor }), (error) => error.statusCode === 409 && error.errors[0].code === "RECOMMENDATION_CONVERSION_CONFLICT");
});

test("conversion validator rejects Task status, creator, department, metadata, and nonexistent priority override", () => {
  assert.equal(recommendationConvertToTaskSchema.safeParse({ assigneeAdminUserId: "11111111-1111-4111-8111-111111111111", dueDate: "2026-07-25T17:00:00.000Z" }).success, true);
  assert.equal(recommendationConvertToTaskSchema.safeParse({ dueDate: "2026-07-25" }).success, false);
  for (const field of ["status", "creator", "department", "metadata", "priority"]) assert.equal(recommendationConvertToTaskSchema.safeParse({ [field]: "x" }).success, false);
  const routes = fs.readFileSync(path.join(__dirname, "../intelligence.routes.js"), "utf8");
  assert.match(routes, /"\/recommendations\/:id\/convert-to-task"[\s\S]*?"EDIT"/);
});

test("bounded task adapter reuses the existing Task module and performs no provider writes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../recommendations/recommendation-task.adapter.js"), "utf8");
  assert.doesNotMatch(source, /fetch\(|axios\.|pauseCampaign|updateBudget|createTaskAssignee/);
  assert.equal(fs.existsSync(path.join(__dirname, "../tasks")), false);
  const description = taskDescription(recommendation({ reasoning: `Bearer abc ${"x".repeat(5000)}` }), "HIGH");
  assert.ok(description.length <= 4000); assert.doesNotMatch(description, /Bearer abc/);
});

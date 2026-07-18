const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrReuseEscalation,
  assignSafetyTask,
} = require("../src/modules/marketing/social-operations/safety/escalation.service");
const {
  validateSafetyAssignee,
} = require("../src/modules/marketing/social-operations/safety/escalation-assignment.service");
const {
  clearPublishedSocialEvents,
  listPublishedSocialEvents,
} = require("../src/modules/marketing/social-operations/services/social-domain-events.service");

function escalationDb({ includeSafetyGrant = true, adminStatus = "ACTIVE" } = {}) {
  const escalations = [];
  const tasks = [];
  const comments = [{ id: "comment-1", sensitiveDataState: "UNCLASSIFIED" }];
  const messages = [{ id: "message-1", sensitiveDataState: "UNCLASSIFIED" }];
  const admins = [
    { id: "safety-admin", status: adminStatus, tier: "ADMIN", createdAt: new Date("2026-01-01") },
    { id: "plain-admin", status: "ACTIVE", tier: "ADMIN", createdAt: new Date("2026-01-02") },
  ];
  const grants = includeSafetyGrant
    ? [
        {
          adminUserId: "safety-admin",
          module: "marketing",
          section: "social_moderation_safety",
          mode: "EDIT",
          revokedAt: null,
          expiresAt: null,
        },
      ]
    : [];
  const db = {
    escalations,
    tasks,
    $transaction: async (fn) => fn(db),
    adminUser: {
      async findUnique({ where }) {
        return admins.find((admin) => admin.id === where.id) || null;
      },
      async findMany() {
        return admins;
      },
    },
    adminSectionGrant: {
      async findMany({ where }) {
        return grants.filter(
          (grant) =>
            grant.adminUserId === where.adminUserId &&
            grant.module === where.module &&
            where.section.in.includes(grant.section),
        );
      },
    },
    socialComment: {
      async update({ where, data }) {
        const row = comments.find((comment) => comment.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    socialMessage: {
      async update({ where, data }) {
        const row = messages.find((message) => message.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    socialEscalation: {
      async findFirst({ where }) {
        return escalations.find(
          (row) =>
            row.entityType === where.entityType &&
            row.entityId === where.entityId &&
            row.classification === where.classification &&
            where.status.in.includes(row.status),
        ) || null;
      },
      async findUnique({ where }) {
        return escalations.find((row) => row.id === where.id) || null;
      },
      async create({ data }) {
        const row = { id: `esc-${escalations.length + 1}`, taskId: null, ...data };
        escalations.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = escalations.find((escalation) => escalation.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    task: {
      async create({ data }) {
        const row = { id: `task-${tasks.length + 1}`, ...data };
        tasks.push(row);
        return row;
      },
      async findUnique({ where }) {
        return tasks.find((row) => row.id === where.id) || null;
      },
      async update({ where, data }) {
        const row = tasks.find((task) => task.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
  return db;
}

test("medical emergency escalation is restricted and links a safe Task", async () => {
  clearPublishedSocialEvents();
  const db = escalationDb();
  const audits = [];
  const result = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "MEDICAL_EMERGENCY",
    reasonCodes: ["MEDICAL_EMERGENCY_SIGNAL"],
    actorId: "safety-admin",
    db,
    auditWriter: async (entry) => audits.push(entry),
    notificationWriter: { async createNotification() {} },
  });

  assert.equal(result.escalation.restrictedVisibility, true);
  assert.equal(result.escalation.taskId, "task-1");
  assert.equal(db.tasks[0].assigneeId, "safety-admin");
  assert.equal(db.tasks[0].title, "Restricted Social safety escalation");
  assert.equal(JSON.stringify(db.tasks[0]).includes("chest pain"), false);
  assert.equal(JSON.stringify(audits).includes("private"), false);
  assert.equal(listPublishedSocialEvents().some((event) => event.type === "SOCIAL_ESCALATION_CREATED"), true);
});

test("unauthorized assignee is rejected and missing eligible assignee creates unassigned safety Task", async () => {
  await assert.rejects(
    validateSafetyAssignee({
      adminUserId: "plain-admin",
      classification: "SELF_HARM_RISK",
      db: escalationDb(),
    }),
    /not eligible/,
  );

  clearPublishedSocialEvents();
  const db = escalationDb({ includeSafetyGrant: false });
  const result = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "SELF_HARM_RISK",
    actorId: "plain-admin",
    db,
    auditWriter: async () => {},
  });
  assert.equal(result.escalation.taskId, "task-1");
  assert.equal(db.tasks.length, 1);
  assert.equal(db.tasks[0].assigneeId, null);
  assert.equal(
    listPublishedSocialEvents().some((event) => event.type === "SOCIAL_OPERATIONAL_ALERT"),
    true,
  );
});

test("privacy incidents emit safe event payloads and reprocessing is idempotent", async () => {
  clearPublishedSocialEvents();
  const db = escalationDb();
  await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "PRIVACY_INCIDENT",
    reasonCodes: ["PRIVACY_INCIDENT_SIGNAL"],
    actorId: "safety-admin",
    db,
    auditWriter: async () => {},
    notificationWriter: { async createNotification() {} },
  });
  await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "PRIVACY_INCIDENT",
    reasonCodes: ["PRIVACY_INCIDENT_SIGNAL"],
    actorId: "safety-admin",
    db,
    auditWriter: async () => {},
    notificationWriter: { async createNotification() {} },
  });

  assert.equal(db.escalations.length, 1);
  const privacyEvent = listPublishedSocialEvents().find(
    (event) => event.type === "SOCIAL_PRIVACY_INCIDENT_FLAGGED",
  );
  assert.ok(privacyEvent);
  assert.equal(JSON.stringify(privacyEvent).includes("wrong patient"), false);
});

test("self-harm escalation creates assigned or unassigned Task without fallback", async () => {
  clearPublishedSocialEvents();
  const assignedDb = escalationDb();
  const assigned = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "SELF_HARM_RISK",
    reasonCodes: ["SELF_HARM_SIGNAL"],
    actorId: "safety-admin",
    db: assignedDb,
    auditWriter: async () => {},
    notificationWriter: { async createNotification() {} },
  });
  assert.equal(assigned.escalation.taskId, "task-1");
  assert.equal(assignedDb.tasks[0].assigneeId, "safety-admin");

  const unassignedDb = escalationDb({ includeSafetyGrant: false });
  const unassigned = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "SELF_HARM_RISK",
    reasonCodes: ["SELF_HARM_SIGNAL"],
    actorId: "plain-admin",
    db: unassignedDb,
    auditWriter: async () => {},
    notificationWriter: { async createNotification() { throw new Error("should not notify"); } },
  });
  assert.equal(unassigned.escalation.taskId, "task-1");
  assert.equal(unassignedDb.tasks[0].assigneeId, null);
  assert.equal(JSON.stringify(unassignedDb.tasks).includes("hotline"), false);
});

test("reprocessing an escalation reuses the existing linked Task", async () => {
  const db = escalationDb();
  await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "MEDICAL_EMERGENCY",
    reasonCodes: ["MEDICAL_EMERGENCY_SIGNAL"],
    actorId: "safety-admin",
    db,
    auditWriter: async () => {},
    notificationWriter: { async createNotification() {} },
  });
  await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "MEDICAL_EMERGENCY",
    reasonCodes: ["MEDICAL_EMERGENCY_SIGNAL"],
    actorId: "safety-admin",
    db,
    auditWriter: async () => {},
  });
  assert.equal(db.tasks.length, 1);
  assert.equal(db.escalations.length, 1);
});

test("later safety assignment validates linkage, active status, and EDIT safety grant", async () => {
  const db = escalationDb({ includeSafetyGrant: false });
  const result = await createOrReuseEscalation({
    entityType: "COMMENT",
    entityId: "comment-1",
    classification: "MEDICAL_EMERGENCY",
    reasonCodes: ["MEDICAL_EMERGENCY_SIGNAL"],
    actorId: "plain-admin",
    db,
    auditWriter: async () => {},
  });
  db.adminSectionGrant.findMany = async ({ where }) => [
    {
      adminUserId: where.adminUserId,
      module: "marketing",
      section: "social_moderation_safety",
      mode: "EDIT",
      revokedAt: null,
      expiresAt: null,
    },
  ];
  const audits = [];
  const notifications = [];
  const assigned = await assignSafetyTask({
    taskId: result.escalation.taskId,
    escalationId: result.escalation.id,
    assigneeId: "safety-admin",
    actorId: "plain-admin",
    db,
    auditWriter: async (entry) => audits.push(entry),
    notificationWriter: { async createNotification(payload) { notifications.push(payload); } },
  });
  assert.equal(assigned.task.assigneeId, "safety-admin");
  assert.equal(assigned.escalation.taskId, assigned.task.id);
  assert.equal(JSON.stringify(audits).includes("chest pain"), false);
  assert.equal(JSON.stringify(notifications).includes("chest pain"), false);

  await assert.rejects(
    assignSafetyTask({
      taskId: "task-missing",
      escalationId: result.escalation.id,
      assigneeId: "safety-admin",
      actorId: "plain-admin",
      db,
      auditWriter: async () => {},
    }),
    /Safety Task not found/,
  );
});

test("inactive safety assignee is rejected", async () => {
  await assert.rejects(
    validateSafetyAssignee({
      adminUserId: "safety-admin",
      classification: "MEDICAL_EMERGENCY",
      db: escalationDb({ adminStatus: "INACTIVE" }),
    }),
    /not eligible/,
  );
});

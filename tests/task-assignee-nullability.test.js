const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });

const LOCAL_DB_NAME = "cosmicforge_admin";

class RollbackTaskNullabilityTest extends Error {
  constructor() {
    super("ROLLBACK_TASK_NULLABILITY_TEST");
  }
}

function isLocalAdminDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return false;
  const parsed = new URL(databaseUrl);
  return (
    parsed.pathname.replace(/^\//, "") === LOCAL_DB_NAME &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())
  );
}

async function withRollback(prisma, work) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await work(tx);
        throw new RollbackTaskNullabilityTest();
      },
      { maxWait: 10000, timeout: 30000 },
    );
  } catch (error) {
    if (
      error instanceof RollbackTaskNullabilityTest ||
      error?.message === "ROLLBACK_TASK_NULLABILITY_TEST"
    ) {
      return;
    }
    throw error;
  }
}

test("Task assignee is nullable in Prisma schema and PostgreSQL", async (t) => {
  if (!isLocalAdminDatabase()) {
    t.skip("requires local cosmicforge_admin DATABASE_URL");
    return;
  }
  const { prisma } = require("../src/shared/config/database");
  const fs = require("node:fs");
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  const taskBlock = schema.match(/model Task \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(taskBlock, /\bassigneeId\s+String\?/);
  assert.match(taskBlock, /\bassignee\s+AdminUser\?\s+@relation\("TaskAssignee"/);

  const columns = await prisma.$queryRaw`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tasks'
      AND column_name = 'assigneeId'
  `;
  assert.equal(columns[0]?.is_nullable, "YES");

  const fks = await prisma.$queryRaw`
    SELECT con.conname AS name,
           con.confdeltype::text AS delete_type
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = 'public.tasks'::regclass
      AND a.attname = 'assigneeId'
  `;
  assert.equal(fks[0]?.name, "tasks_assigneeId_fkey");
  assert.equal(fks[0]?.delete_type, "r");
});

test("assigned and unassigned Task creation both work and serialize safely", async (t) => {
  if (!isLocalAdminDatabase()) {
    t.skip("requires local cosmicforge_admin DATABASE_URL");
    return;
  }
  const { prisma } = require("../src/shared/config/database");
  const before = await prisma.task.count();

  await withRollback(prisma, async (tx) => {
    const suffix = randomUUID();
    const admin = await tx.adminUser.create({
      data: {
        email: `task-nullability-${suffix}@example.com`,
        password: "not-a-real-password-hash",
        name: "Task Nullability Test Admin",
        tier: "SUPER",
        status: "ACTIVE",
        mustChangePassword: false,
      },
    });

    const assigned = await tx.task.create({
      data: {
        title: "Assigned synthetic Task",
        dueDate: new Date(Date.now() + 86400000),
        assignerId: admin.id,
        assigneeId: admin.id,
      },
      include: { assignee: true },
    });
    assert.equal(assigned.assigneeId, admin.id);
    assert.equal(assigned.assignee.id, admin.id);

    const unassigned = await tx.task.create({
      data: {
        title: "Unassigned synthetic Task",
        dueDate: new Date(Date.now() + 86400000),
        assignerId: admin.id,
        assigneeId: null,
      },
      include: { assignee: true, assigner: true },
    });
    assert.equal(unassigned.assigneeId, null);
    assert.equal(unassigned.assignee, null);
    assert.doesNotThrow(() => JSON.stringify(unassigned));

    const list = await tx.task.findMany({
      where: { id: { in: [assigned.id, unassigned.id] } },
      include: { assignee: true },
      orderBy: { title: "asc" },
    });
    assert.equal(list.length, 2);
    assert.equal(list.some((task) => task.assignee === null), true);

    const detail = await tx.task.findUnique({
      where: { id: unassigned.id },
      include: { assignee: true },
    });
    assert.equal(detail.assignee, null);
  });

  assert.equal(await prisma.task.count(), before);
});

test("empty-string assignee remains invalid", async (t) => {
  if (!isLocalAdminDatabase()) {
    t.skip("requires local cosmicforge_admin DATABASE_URL");
    return;
  }
  const { validateSafetyAssignee } = require("../src/modules/marketing/social-operations/safety/escalation-assignment.service");
  await assert.rejects(
    validateSafetyAssignee({
      adminUserId: " ",
      classification: "MEDICAL_EMERGENCY",
      db: { adminUser: { async findUnique() { return null; } } },
    }),
    /not eligible/,
  );
});

test("notification service skips null recipients", async () => {
  const notificationService = require("../src/modules/notifications/notifications.service");
  const result = await notificationService.createNotification({
    adminUserId: null,
    icon: "shield",
    title: "Should not persist",
  });
  assert.equal(result, null);
});

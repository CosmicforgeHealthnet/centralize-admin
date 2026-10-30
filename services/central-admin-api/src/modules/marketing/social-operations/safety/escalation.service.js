const { prisma } = require("../../../../shared/config/database");
const {
  publishSocialEvent,
  SOCIAL_DOMAIN_EVENTS,
} = require("../services/social-domain-events.service");
const { writeSocialAudit } = require("../security/social-audit.service");
const {
  findEligibleAssignee,
  validateSafetyAssignee,
} = require("./escalation-assignment.service");
const notificationService = require("../../../notifications/notifications.service");

const TASK_REQUIRED_CLASSIFICATIONS = Object.freeze([
  "MEDICAL_EMERGENCY",
  "SELF_HARM_RISK",
  "PRIVACY_INCIDENT",
  "PATIENT_COMPLAINT",
  "LEGAL_THREAT",
]);

const SAFETY_TASK_ALWAYS_CREATE_CLASSIFICATIONS = Object.freeze([
  "MEDICAL_EMERGENCY",
  "SELF_HARM_RISK",
]);

function isRestrictedClassification(classification) {
  return classification !== "GENERAL_INQUIRY";
}

async function updateSourceSensitivity({
  tx,
  entityType,
  entityId,
  sourceMessageId,
  classification,
} = {}) {
  const restricted = isRestrictedClassification(classification);
  if (!restricted) return null;
  const data = { sensitiveDataState: "FLAGGED" };
  if (entityType === "COMMENT") {
    return tx.socialComment.update({ where: { id: entityId }, data });
  }
  if (sourceMessageId) {
    return tx.socialMessage.update({ where: { id: sourceMessageId }, data });
  }
  return null;
}

async function createLinkedTask({
  tx,
  classification,
  escalationId,
  entityType,
  reasonCodes = [],
  actorId,
  proposedAssigneeId,
  now,
} = {}) {
  if (!TASK_REQUIRED_CLASSIFICATIONS.includes(classification)) return null;
  if (!actorId) {
    throw new Error("Safety escalation Task creation requires an actor");
  }
  const assignee = proposedAssigneeId !== undefined && proposedAssigneeId !== null
    ? await validateSafetyAssignee({ adminUserId: proposedAssigneeId, classification, db: tx })
    : await findEligibleAssignee({ classification, db: tx });
  if (!assignee && !SAFETY_TASK_ALWAYS_CREATE_CLASSIFICATIONS.includes(classification)) {
    return null;
  }

  return tx.task.create({
    data: {
      title: "Restricted Social safety escalation",
      description: [
        `Escalation: ${escalationId}`,
        `Entity type: ${entityType}`,
        `Reason codes: ${reasonCodes.join(",") || "UNSPECIFIED"}`,
      ].join("\n"),
      dueDate: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      assignerId: actorId,
      assigneeId: assignee?.id || null,
    },
  });
}

async function assignSafetyTask({
  taskId,
  escalationId,
  assigneeId,
  actorId,
  db = prisma,
  auditWriter,
  notificationWriter,
} = {}) {
  const result = await db.$transaction(async (tx) => {
    const [task, escalation] = await Promise.all([
      tx.task.findUnique({ where: { id: taskId } }),
      tx.socialEscalation.findUnique({ where: { id: escalationId } }),
    ]);
    if (!task || !escalation || escalation.taskId !== task.id) {
      const ApiError = require("../../../../shared/utils/ApiError");
      throw new ApiError(404, "Safety Task not found");
    }
    if (!SAFETY_TASK_ALWAYS_CREATE_CLASSIFICATIONS.includes(escalation.classification)) {
      const ApiError = require("../../../../shared/utils/ApiError");
      throw new ApiError(400, "Task is not a safety escalation Task");
    }

    const actor = await validateSafetyAssignee({
      adminUserId: actorId,
      classification: escalation.classification,
      db: tx,
    });
    if (!actor) {
      const ApiError = require("../../../../shared/utils/ApiError");
      throw new ApiError(403, "Safety Task assignment requires an eligible actor");
    }

    const assignee = await validateSafetyAssignee({
      adminUserId: assigneeId,
      classification: escalation.classification,
      db: tx,
    });
    const updatedTask = await tx.task.update({
      where: { id: task.id },
      data: { assigneeId: assignee.id },
    });

    return { previousTask: task, task: updatedTask, escalation };
  });

  await writeSocialAudit({
    actorId,
    operation: "SOCIAL_SAFETY_TASK_ASSIGNED",
    targetId: result.task.id,
    targetType: "TASK",
    metadata: {
      escalationId: result.escalation.id,
      previousAssigneeId: result.previousTask.assigneeId || null,
      nextAssigneeId: result.task.assigneeId,
    },
    auditWriter,
  });

  await notifySafetyTaskAssigned({
    task: result.task,
    notificationWriter,
  });

  return result;
}

async function notifySafetyTaskAssigned({
  task,
  notificationWriter = notificationService,
} = {}) {
  if (!task?.assigneeId || !notificationWriter?.createNotification) return null;
  return notificationWriter.createNotification({
    adminUserId: task.assigneeId,
    icon: "shield",
    title: "Restricted Social safety escalation assigned",
    subtitle: `Task ${task.id} requires authorized review.`,
  });
}

async function createOrReuseEscalation({
  entityType,
  entityId,
  sourceMessageId,
  classification,
  reasonCodes = [],
  actorId,
  proposedAssigneeId,
  db = prisma,
  publisher,
  auditWriter,
  notificationWriter,
  now = () => new Date(),
} = {}) {
  if (!isRestrictedClassification(classification)) {
    return {
      created: false,
      escalation: null,
      task: null,
      restrictedVisibility: false,
    };
  }

  const result = await db.$transaction(async (tx) => {
    await updateSourceSensitivity({
      tx,
      entityType,
      entityId,
      sourceMessageId,
      classification,
    });

    let escalation = await tx.socialEscalation.findFirst({
      where: {
        entityType,
        entityId,
        classification,
        status: { in: ["DETECTED", "CONFIRMED"] },
      },
    });
    const created = !escalation;
    if (!escalation) {
      escalation = await tx.socialEscalation.create({
        data: {
          entityType,
          entityId,
          classification,
          status: "DETECTED",
          restrictedVisibility: true,
        },
      });
    }

    const task = escalation.taskId
      ? null
      : await createLinkedTask({
          tx,
          classification,
          escalationId: escalation.id,
          entityType,
          reasonCodes,
          actorId,
          proposedAssigneeId,
          now: now(),
        });
    const updatedEscalation = task
      ? await tx.socialEscalation.update({
          where: { id: escalation.id },
          data: { taskId: task.id },
        })
      : escalation;

    return { created, escalation: updatedEscalation, task };
  });

  await writeSocialAudit({
    actorId,
    operation: "SOCIAL_ESCALATION_CREATED_OR_REUSED",
    targetId: result.escalation.id,
    targetType: "SOCIAL_ESCALATION",
    metadata: {
      entityType,
      entityId,
      classification,
      reasonCodes,
      taskLinked: Boolean(result.escalation.taskId),
      assigneeId: result.task?.assigneeId || null,
    },
    auditWriter,
  });

  await publishSocialEvent({
    type:
      classification === "PRIVACY_INCIDENT"
        ? SOCIAL_DOMAIN_EVENTS.SOCIAL_PRIVACY_INCIDENT_FLAGGED
        : SOCIAL_DOMAIN_EVENTS.SOCIAL_ESCALATION_CREATED,
    payload: {
      escalationId: result.escalation.id,
      entityType,
      entityId,
      classification,
      reasonCodes,
      taskId: result.escalation.taskId || null,
    },
    publisher,
  });

  if (result.task?.assigneeId) {
    await notifySafetyTaskAssigned({
      task: result.task,
      notificationWriter,
    });
  }

  if (TASK_REQUIRED_CLASSIFICATIONS.includes(classification) && !result.task?.assigneeId) {
    await publishSocialEvent({
      type: SOCIAL_DOMAIN_EVENTS.SOCIAL_OPERATIONAL_ALERT,
      payload: {
        operation: result.escalation.taskId
          ? "SOCIAL_SAFETY_TASK_UNASSIGNED"
          : "SOCIAL_ESCALATION_TASK_NOT_CREATED",
        escalationId: result.escalation.id,
        entityType,
        entityId,
        taskId: result.escalation.taskId || null,
      },
      publisher,
    });
  }

  return result;
}

module.exports = {
  TASK_REQUIRED_CLASSIFICATIONS,
  SAFETY_TASK_ALWAYS_CREATE_CLASSIFICATIONS,
  isRestrictedClassification,
  notifySafetyTaskAssigned,
  assignSafetyTask,
  createOrReuseEscalation,
};

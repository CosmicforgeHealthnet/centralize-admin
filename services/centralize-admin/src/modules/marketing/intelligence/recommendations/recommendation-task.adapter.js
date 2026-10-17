const ApiError = require("../../../../shared/utils/ApiError");
const { prisma } = require("../../../../shared/config/database");
const { sanitizeProviderText } = require("../connectors/provider-http");
const { createRecommendationSettingsService } = require("./recommendation-settings.service");
const { createSettingsService } = require("../settings.service");
const notificationService = require("../../../notifications/notifications.service");
const { emitAdminNotification } = require("../../../../websocket");
const { assertUuid } = require("../validation-security");
const { EVENTS, logEvent } = require("../observability");
const { requireActiveActor } = require("../actor-validation");

const URGENCY = Object.freeze({ PAUSE: "HIGH", SCALE: "MEDIUM", REALLOCATE_BUDGET: "HIGH", CREATE_CONTENT: "MEDIUM" });
const TIER_RANK = { EMPLOYEE: 1, ADMIN: 2, EXECUTIVE: 3, SUPER: 4 };

function isEligibleAssignee(admin, now = new Date()) {
  if (!admin || admin.status !== "ACTIVE") return false;
  if (admin.tier === "SUPER" || admin.department === "MARKETING") return true;
  return (admin.sectionGrants || []).some((grant) => grant.module === "marketing" && ["intelligence", "*"].includes(grant.section) && grant.mode === "EDIT" && !grant.revokedAt && (!grant.expiresAt || new Date(grant.expiresAt) > now));
}

function evidenceSummary(evidence = {}) {
  const allowed = ["observed", "target", "boundary", "spend", "conversions", "currencyCode", "persistenceCount"];
  return Object.fromEntries(allowed.filter((key) => evidence[key] !== undefined && ["string", "number", "boolean"].includes(typeof evidence[key])).map((key) => [key, evidence[key]]));
}

function actionSummary(action = {}) {
  const allowed = ["action", "suggestedScalePct", "suggestedReallocationPct", "maximumAllowedPct", "requiresManualApproval"];
  return Object.fromEntries(allowed.filter((key) => action[key] !== undefined && ["string", "number", "boolean"].includes(typeof action[key])).map((key) => [key, action[key]]));
}

function taskDescription(recommendation, urgency) {
  const lines = [
    `Marketing recommendation: ${recommendation.id}`,
    `Operational urgency: ${urgency}`,
    `Campaign: ${recommendation.targetCampaignExternalId}`,
    `Analysis window: ${new Date(recommendation.analysisWindowStart).toISOString().slice(0, 10)} to ${new Date(recommendation.analysisWindowEnd).toISOString().slice(0, 10)}`,
    `Currency: ${recommendation.currencyCode || "not applicable"}`,
    `Reasoning: ${sanitizeProviderText(recommendation.reasoning || "Review recommendation evidence.")}`,
    `Evidence summary: ${JSON.stringify(evidenceSummary(recommendation.evidence))}`,
    `Suggested action: ${JSON.stringify(actionSummary(recommendation.suggestedAction))}`,
  ];
  return sanitizeProviderText(lines.join("\n")).slice(0, 4000);
}

function createRecommendationTaskAdapter({ prisma: db = prisma, settingsService, assignmentSettingsService, notifications = notificationService, realtime = emitAdminNotification, now = () => new Date(), log } = {}) {
  async function loadEligible(tx, id) {
    const admin = await tx.adminUser.findUnique({ where: { id }, include: { sectionGrants: true } });
    return isEligibleAssignee(admin, now()) ? admin : null;
  }

  async function resolveAssignee(tx, requestedId, defaultId, defaultSource) {
    if (requestedId) {
      const requested = await loadEligible(tx, requestedId);
      if (!requested) throw new ApiError(400, "Requested assignee is not an active eligible Marketing assignee");
      return { admin: requested, source: "REQUEST" };
    }
    if (defaultId) {
      const configured = await loadEligible(tx, defaultId);
      if (configured) return { admin: configured, source: defaultSource === "CONNECTION" ? "CONNECTION_SETTING" : "GLOBAL_SETTING" };
    }
    const candidates = await tx.adminUser.findMany({ where: { status: "ACTIVE", department: "MARKETING" }, include: { sectionGrants: true }, orderBy: [{ isTeamLead: "desc" }, { createdAt: "asc" }, { id: "asc" }] });
    const eligible = candidates.filter((candidate) => isEligibleAssignee(candidate, now())).sort((a, b) => (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0) || String(a.id).localeCompare(String(b.id)));
    if (!eligible.length) throw new ApiError(422, "No active eligible Marketing task assignee is configured", [{ code: "MARKETING_ASSIGNEE_UNAVAILABLE" }]);
    return { admin: eligible[0], source: "MARKETING_FALLBACK" };
  }

  async function convert({ recommendationId, actorAdminUserId, assigneeAdminUserId, dueDate, ipAddress, userAgent }) {
    const operationStartedAt = Date.now();
    assertUuid(recommendationId, "recommendationId");
    assertUuid(actorAdminUserId, "adminUserId");
    assertUuid(assigneeAdminUserId, "assigneeAdminUserId", { optional: true });
    let notificationPayload = null;
    let result;
    try {
      result = await db.$transaction(async (tx) => {
      await requireActiveActor(tx, { id: actorAdminUserId });
      if (tx.$queryRaw) await tx.$queryRaw`SELECT "id" FROM "marketing_recommendations" WHERE "id" = ${recommendationId} FOR UPDATE`;
      const recommendation = await tx.marketing_recommendations.findUnique({ where: { id: recommendationId } });
      if (!recommendation) throw new ApiError(404, "Marketing recommendation not found");
      if (recommendation.convertedToTaskId) {
        const task = await tx.task.findUnique({ where: { id: recommendation.convertedToTaskId } });
        if (!task) throw new ApiError(409, "Converted recommendation references a missing task", [{ code: "RECOMMENDATION_TASK_INTEGRITY_CONFLICT" }]);
        return { task, recommendation, operationalPriority: URGENCY[recommendation.type] || "MEDIUM", idempotent: true };
      }
      if (recommendation.status !== "ACCEPTED") throw new ApiError(409, "Only an accepted recommendation can be converted to a task", [{ code: "RECOMMENDATION_LIFECYCLE_CONFLICT" }]);
      const previousStatus = recommendation.status;
      const settingsResolver = settingsService || createRecommendationSettingsService({ prisma: tx });
      const resolved = await settingsResolver.resolveSettings({ platform: recommendation.platform, connectionId: recommendation.connectionId });
      const assignmentResolver = assignmentSettingsService || createSettingsService({ prisma: tx, log: { warn() {} } });
      const assignmentSettings = await assignmentResolver.resolveSettings({ platform: recommendation.platform, connectionId: recommendation.connectionId, currencyCode: recommendation.currencyCode }, { keys: ["defaultMarketingAssigneeAdminUserId"] });
      const assignment = await resolveAssignee(tx, assigneeAdminUserId, assignmentSettings.values.defaultMarketingAssigneeAdminUserId, assignmentSettings.sources.defaultMarketingAssigneeAdminUserId.scopeType);
      const assignee = assignment.admin;
      const current = now();
      const taskDueDate = dueDate ? new Date(dueDate) : new Date(current.getTime() + resolved.values.defaultRecommendationTaskDueDays * 86400000);
      if (taskDueDate <= current) throw new ApiError(400, "Task due date must be in the future");
      const operationalPriority = URGENCY[recommendation.type] || "MEDIUM";
      const task = await tx.task.create({ data: {
        title: `${recommendation.type} marketing campaign ${recommendation.targetCampaignExternalId}`.slice(0, 255),
        description: taskDescription(recommendation, operationalPriority),
        dueDate: taskDueDate,
        assignerId: actorAdminUserId,
        assigneeId: assignee.id,
      } });
      const notification = await notifications.createNotificationWithClient(tx, { adminUserId: assignee.id, icon: "check", title: "Marketing intelligence task assigned", subtitle: `${task.title} is due ${taskDueDate.toISOString().slice(0, 10)}.` });
      const updatedRecommendation = await tx.marketing_recommendations.update({ where: { id: recommendation.id }, data: { convertedToTaskId: task.id, status: "CONVERTED_TO_TASK" } });
      await tx.auditLog.create({ data: {
        adminUserId: actorAdminUserId, action: "MARKETING_RECOMMENDATION_TASK_CONVERTED", targetId: task.id, targetType: "task",
        metadata: { recommendationId: recommendation.id, taskId: task.id, actorAdminUserId, assigneeAdminUserId: assignee.id, assigneeResolutionSource: assignment.source, recommendationType: recommendation.type, previousStatus, newStatus: updatedRecommendation.status, dueDate: taskDueDate.toISOString(), operationalPriority, timestamp: current.toISOString() },
        ipAddress: ipAddress || null, userAgent: userAgent || null,
      } });
      notificationPayload = { adminUserId: assignee.id, notification, taskId: task.id, recommendationId: recommendation.id, title: "Marketing intelligence task assigned" };
      return { task, recommendation: updatedRecommendation, operationalPriority, assigneeResolutionSource: assignment.source, idempotent: false };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (["P2034", "P2002"].includes(error?.code)) throw new ApiError(409, "Recommendation conversion conflicted; retry the request", [{ code: "RECOMMENDATION_CONVERSION_CONFLICT" }]);
      throw error;
    }

    let realtimeDeliveryFailed = false;
    if (notificationPayload) {
      try { realtime(notificationPayload.adminUserId, notificationPayload); }
      catch (_error) { realtimeDeliveryFailed = true; }
    }
    logEvent(EVENTS.TASK_CONVERTED, {
      recommendationId, taskId: result.task.id, actorId: actorAdminUserId,
      assigneeId: result.task.assigneeId,
      assigneeResolutionSource: result.assigneeResolutionSource || "EXISTING_TASK",
      status: result.idempotent ? "EXISTING_TASK_RETURNED" : "CREATED",
      durationMs: Date.now() - operationStartedAt,
    }, { log });
    return { ...result, realtimeDeliveryFailed };
  }

  return { convert, resolveAssignee };
}

module.exports = { URGENCY, isEligibleAssignee, taskDescription, createRecommendationTaskAdapter };

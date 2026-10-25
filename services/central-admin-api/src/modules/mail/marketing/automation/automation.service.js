"use strict";

// Marketing automation API (M7). Automations are brand-scoped, versioned and
// reviewed like campaigns: a version is authored as a DRAFT, submitted, and
// published only by a different approver with a fresh MFA step-up. Published
// definitions are immutable (DB trigger); running enrollments stay bound to
// the version they started on.

const { mailError } = require("../../mail.errors");
const policy = require("../../authz/mail.policy");
const { iso, decodeCursor, encodeCursor, pageLimit } = require("../../services/serializers");
const { validateDefinition, validateTriggerConfig, definitionHash, DefinitionError } = require("./definition");
const { approvedEvent, minimizePayload } = require("./event-registry");

const TRIGGER_TYPES = new Set(["CONSENT_GRANTED", "PRODUCT_EVENT", "SCHEDULE"]);

function cleanName(value, max = 160) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
  if (!text || /^[=+\-@\t\r]/.test(text)) return null;
  return text;
}

function createAutomationService({ client, config, audit, stepUp, clock = () => new Date() }) {
  const scope = (user, organizationId, need) => {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    return policy.requireMarketingScope(client, user, organizationId, need);
  };
  const scopeEither = async (user, organizationId) => {
    const scoped = await scope(user, organizationId, "VIEW");
    if (!scoped.canAuthor && !scoped.canApprove) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_AUTHOR_OR_APPROVER_REQUIRED" });
    return scoped;
  };

  const definitionError = (error) => {
    if (error instanceof DefinitionError) return mailError("MAIL_VALIDATION_FAILED", { errors: error.errors.slice(0, 20) });
    return error;
  };

  async function load(organizationId, automationId) {
    const row = policy.isUuid(automationId) ? await client.marketingAutomation.findUnique({ where: { id: automationId } }) : null;
    if (!row || row.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "automation" });
    return row;
  }

  async function loadVersion(automation, versionId) {
    const row = policy.isUuid(versionId) ? await client.marketingAutomationVersion.findUnique({ where: { id: versionId } }) : null;
    if (!row || row.automationId !== automation.id) throw mailError("MAIL_NOT_FOUND", { resource: "automation_version" });
    return row;
  }

  // References must belong to this brand and be usable for marketing sends.
  async function validateReferences(organizationId, definition, triggerType, triggerConfig) {
    const problems = [];
    for (const step of definition.steps.filter((entry) => entry.type === "send_email")) {
      const version = await client.marketingTemplateVersion.findUnique({ where: { id: step.templateVersionId }, include: { template: true } });
      if (!version || version.template.organizationId !== organizationId) problems.push({ field: `step ${step.id}.templateVersionId` });
      const sender = await client.mailAddress.findUnique({ where: { id: step.senderAddressId } });
      if (!sender || sender.organizationId !== organizationId || sender.status !== "ACTIVE" || !["SHARED", "SYSTEM", "ALIAS"].includes(sender.kind)) problems.push({ field: `step ${step.id}.senderAddressId`, reason: "BRAND_SENDER_REQUIRED" });
    }
    if (triggerType === "SCHEDULE") {
      const audience = await client.marketingAudience.findUnique({ where: { id: triggerConfig.audienceId } });
      if (!audience || audience.organizationId !== organizationId) problems.push({ field: "triggerConfig.audienceId" });
      else if (audience.topic !== definition.topic) problems.push({ field: "triggerConfig.audienceId", reason: "AUDIENCE_TOPIC_MISMATCH" });
      if (triggerConfig.segmentId) {
        const segment = await client.marketingSegment.findUnique({ where: { id: triggerConfig.segmentId } });
        if (!segment || segment.organizationId !== organizationId || segment.audienceId !== triggerConfig.audienceId) problems.push({ field: "triggerConfig.segmentId" });
      }
    }
    if (problems.length) throw mailError("MAIL_VALIDATION_FAILED", { errors: problems });
  }

  function serialize(row, versions = null) {
    return {
      id: row.id, organizationId: row.organizationId, name: row.name, description: row.description, status: row.status, triggerType: row.triggerType,
      activeVersionId: row.activeVersionId, enrollmentLimit: row.enrollmentLimit, maxActiveEnrollments: row.maxActiveEnrollments, frequencyCapHours: row.frequencyCapHours,
      revision: row.revision, createdBy: row.createdByAdminUserId, updatedBy: row.updatedByAdminUserId, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      executionEnabled: config.automationEnabled,
      ...(versions ? { versions: versions.map(serializeVersion) } : {}),
    };
  }

  function serializeVersion(row) {
    return {
      id: row.id, version: row.version, status: row.status, definition: row.definition, triggerConfig: row.triggerConfig, definitionSha256: row.definitionSha256,
      createdBy: row.createdByAdminUserId, submittedBy: row.submittedByAdminUserId, submittedAt: iso(row.submittedAt), reviewedBy: row.reviewedByAdminUserId,
      reviewedAt: iso(row.reviewedAt), reviewComment: row.reviewComment, publishedAt: iso(row.publishedAt), createdAt: iso(row.createdAt),
    };
  }

  async function list(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketingAutomation.findMany({ where: { organizationId }, orderBy: { updatedAt: "desc" }, take: 200 });
    return rows.map((row) => serialize(row));
  }

  async function get(user, organizationId, automationId) {
    await scope(user, organizationId, "VIEW");
    const row = await load(organizationId, automationId);
    const versions = await client.marketingAutomationVersion.findMany({ where: { automationId }, orderBy: { version: "desc" }, take: 50 });
    const enrollmentCounts = await client.marketingAutomationEnrollment.groupBy({ by: ["status"], where: { automationId }, _count: { _all: true } });
    return { ...serialize(row, versions), enrollments: Object.fromEntries(enrollmentCounts.map((entry) => [entry.status, entry._count._all])) };
  }

  async function create(user, organizationId, input, context) {
    await scope(user, organizationId, "EDIT");
    const name = cleanName(input.name);
    if (!name) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    if (!TRIGGER_TYPES.has(input.triggerType)) throw mailError("MAIL_VALIDATION_FAILED", { field: "triggerType" });
    const bounded = (field, fallback, min, max) => {
      if (input[field] === undefined) return fallback;
      const value = Number(input[field]);
      if (!Number.isInteger(value) || value < min || value > max) throw mailError("MAIL_VALIDATION_FAILED", { field });
      return value;
    };
    const row = await client.marketingAutomation.create({
      data: {
        organizationId, name, description: input.description ? String(input.description).slice(0, 2000) : null, triggerType: input.triggerType,
        enrollmentLimit: bounded("enrollmentLimit", 1, 1, 100), maxActiveEnrollments: bounded("maxActiveEnrollments", 5000, 1, 100000), frequencyCapHours: bounded("frequencyCapHours", 24, 0, 8760),
        createdByAdminUserId: user.id, updatedByAdminUserId: user.id,
      },
    }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "name", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_CREATED", targetType: "marketing_automation", targetId: row.id, organizationId, metadata: { triggerType: row.triggerType } }, context);
    return serialize(row);
  }

  // Create or update the single editable DRAFT version.
  async function saveDraft(user, organizationId, automationId, input, context) {
    await scope(user, organizationId, "EDIT");
    const automation = await load(organizationId, automationId);
    if (automation.status === "ARCHIVED") throw mailError("MAIL_INVALID_TRANSITION", { from: "ARCHIVED" });
    let definition;
    let triggerConfig;
    try {
      definition = validateDefinition(input.definition);
      triggerConfig = validateTriggerConfig(automation.triggerType, input.triggerConfig, definition);
    } catch (error) {
      throw definitionError(error);
    }
    await validateReferences(organizationId, definition, automation.triggerType, triggerConfig);
    const sha = definitionHash(definition, triggerConfig);
    const row = await client.$transaction(async (tx) => {
      const draft = await tx.marketingAutomationVersion.findFirst({ where: { automationId, status: "DRAFT" } });
      if (draft) return tx.marketingAutomationVersion.update({ where: { id: draft.id }, data: { definition, triggerConfig, definitionSha256: sha, createdByAdminUserId: user.id } });
      const last = await tx.marketingAutomationVersion.findFirst({ where: { automationId }, orderBy: { version: "desc" } });
      return tx.marketingAutomationVersion.create({ data: { automationId, version: (last?.version || 0) + 1, status: "DRAFT", definition, triggerConfig, definitionSha256: sha, createdByAdminUserId: user.id } });
    });
    await client.marketingAutomation.update({ where: { id: automationId }, data: { updatedByAdminUserId: user.id, revision: { increment: 1 } } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_DRAFT_SAVED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { version: row.version, definitionSha256: sha } }, context);
    return serializeVersion(row);
  }

  async function submit(user, organizationId, automationId, versionId, context) {
    await scope(user, organizationId, "EDIT");
    const automation = await load(organizationId, automationId);
    const version = await loadVersion(automation, versionId);
    if (version.status !== "DRAFT") throw mailError("MAIL_INVALID_TRANSITION", { from: version.status });
    await validateReferences(organizationId, version.definition, automation.triggerType, version.triggerConfig);
    const updated = await client.marketingAutomationVersion.updateMany({ where: { id: versionId, status: "DRAFT", definitionSha256: version.definitionSha256 }, data: { status: "PENDING_REVIEW", submittedByAdminUserId: user.id, submittedAt: clock() } });
    if (updated.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_SUBMITTED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { version: version.version, definitionSha256: version.definitionSha256 } }, context);
    return serializeVersion(await client.marketingAutomationVersion.findUnique({ where: { id: versionId } }));
  }

  async function approve(user, organizationId, automationId, versionId, { stepUpId, comment, definitionSha256 } = {}, context) {
    await scope(user, organizationId, "APPROVE");
    const automation = await load(organizationId, automationId);
    const version = await loadVersion(automation, versionId);
    if (version.status !== "PENDING_REVIEW") throw mailError("MAIL_INVALID_TRANSITION", { from: version.status });
    if ([version.createdByAdminUserId, version.submittedByAdminUserId].includes(user.id)) throw mailError("MAIL_FORBIDDEN", { reason: "REVIEWER_MUST_DIFFER_FROM_AUTHOR" });
    // The reviewer approves exactly the definition they reviewed.
    if (definitionSha256 && definitionSha256 !== version.definitionSha256) throw mailError("MAIL_INVALID_TRANSITION", { reason: "DEFINITION_CHANGED_SINCE_REVIEW" });
    await validateReferences(organizationId, version.definition, automation.triggerType, version.triggerConfig);
    const now = clock();
    await client.$transaction(async (tx) => {
      const consumed = await stepUp.consume(tx, user, stepUpId, "MARKETING_AUTOMATION_PUBLISH", context);
      await tx.marketingAutomationVersion.updateMany({ where: { automationId, status: "PUBLISHED" }, data: { status: "SUPERSEDED" } });
      const published = await tx.marketingAutomationVersion.updateMany({ where: { id: versionId, status: "PENDING_REVIEW" }, data: { status: "PUBLISHED", reviewedByAdminUserId: user.id, reviewedAt: now, reviewComment: comment ? String(comment).slice(0, 2000) : null, stepUpId: consumed, publishedAt: now } });
      if (published.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { reason: "CHANGED" });
      await tx.marketingAutomation.update({ where: { id: automationId }, data: { activeVersionId: versionId, updatedByAdminUserId: user.id, revision: { increment: 1 } } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_PUBLISHED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { version: version.version, definitionSha256: version.definitionSha256 } }, context, tx);
    });
    return get(user, organizationId, automationId);
  }

  async function reject(user, organizationId, automationId, versionId, { comment } = {}, context) {
    await scope(user, organizationId, "APPROVE");
    const automation = await load(organizationId, automationId);
    const version = await loadVersion(automation, versionId);
    if (version.status !== "PENDING_REVIEW") throw mailError("MAIL_INVALID_TRANSITION", { from: version.status });
    if (!comment || String(comment).trim().length < 3) throw mailError("MAIL_VALIDATION_FAILED", { field: "comment" });
    await client.marketingAutomationVersion.update({ where: { id: versionId }, data: { status: "REJECTED", reviewedByAdminUserId: user.id, reviewedAt: clock(), reviewComment: String(comment).slice(0, 2000) } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_REJECTED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { version: version.version } }, context);
    return serializeVersion(await client.marketingAutomationVersion.findUnique({ where: { id: versionId } }));
  }

  // Starting execution sends marketing mail: approvers only, and only with a
  // published version and the automation capability enabled.
  async function activate(user, organizationId, automationId, context) {
    await scope(user, organizationId, "APPROVE");
    if (!config.automationEnabled) throw mailError("MAIL_AUTOMATION_DISABLED");
    const automation = await load(organizationId, automationId);
    if (!automation.activeVersionId) throw mailError("MAIL_INVALID_TRANSITION", { reason: "PUBLISHED_VERSION_REQUIRED" });
    if (!["DRAFT", "PAUSED"].includes(automation.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: automation.status });
    const row = await client.marketingAutomation.update({ where: { id: automationId }, data: { status: "ACTIVE", updatedByAdminUserId: user.id, activatedAt: clock(), lastScheduledRunAt: automation.lastScheduledRunAt || clock() } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_ACTIVATED", targetType: "marketing_automation", targetId: automationId, organizationId }, context);
    return serialize(row);
  }

  async function pause(user, organizationId, automationId, context) {
    await scopeEither(user, organizationId);
    const automation = await load(organizationId, automationId);
    if (automation.status !== "ACTIVE") throw mailError("MAIL_INVALID_TRANSITION", { from: automation.status });
    const row = await client.marketingAutomation.update({ where: { id: automationId }, data: { status: "PAUSED", updatedByAdminUserId: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_PAUSED", targetType: "marketing_automation", targetId: automationId, organizationId }, context);
    return serialize(row);
  }

  async function archive(user, organizationId, automationId, context) {
    await scopeEither(user, organizationId);
    const automation = await load(organizationId, automationId);
    if (automation.status === "ARCHIVED") throw mailError("MAIL_INVALID_TRANSITION", { from: "ARCHIVED" });
    const result = await client.$transaction(async (tx) => {
      await tx.marketingAutomation.update({ where: { id: automationId }, data: { status: "ARCHIVED", updatedByAdminUserId: user.id } });
      const cancelled = await tx.marketingAutomationEnrollment.updateMany({ where: { automationId, status: { in: ["ACTIVE", "WAITING"] } }, data: { status: "CANCELLED", exitReason: "AUTOMATION_ARCHIVED", nextRunAt: null, completedAt: clock() } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_ARCHIVED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { enrollmentsCancelled: cancelled.count } }, context, tx);
      return cancelled.count;
    });
    return { ...serialize(await load(organizationId, automationId)), enrollmentsCancelled: result };
  }

  async function enrollments(user, organizationId, automationId, { status, cursor, limit } = {}) {
    await scope(user, organizationId, "VIEW");
    await load(organizationId, automationId);
    const take = pageLimit(limit, 50, 200);
    const position = decodeCursor(cursor);
    const rows = await client.marketingAutomationEnrollment.findMany({
      where: { automationId, ...(status ? { status } : {}), ...(position ? { OR: [{ createdAt: { lt: position.at } }, { createdAt: position.at, id: { lt: position.id } }] } : {}) },
      include: { contact: { select: { email: true } }, version: { select: { version: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((row) => ({ id: row.id, contactId: row.contactId, email: row.contact.email, version: row.version.version, status: row.status, currentStepId: row.currentStepId, stepCount: row.stepCount, nextRunAt: iso(row.nextRunAt), exitReason: row.exitReason, createdAt: iso(row.createdAt), completedAt: iso(row.completedAt) })),
      nextCursor: rows.length > take ? encodeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
    };
  }

  async function history(user, organizationId, automationId, enrollmentId) {
    await scope(user, organizationId, "VIEW");
    await load(organizationId, automationId);
    if (enrollmentId) {
      const enrollment = policy.isUuid(enrollmentId) ? await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollmentId } }) : null;
      if (!enrollment || enrollment.automationId !== automationId) throw mailError("MAIL_NOT_FOUND", { resource: "enrollment" });
      const runs = await client.marketingAutomationStepRun.findMany({ where: { enrollmentId }, orderBy: { sequence: "asc" } });
      return { enrollmentId, runs: runs.map((run) => ({ sequence: run.sequence, stepId: run.stepId, stepType: run.stepType, status: run.status, deliveryStatus: run.deliveryStatus, errorCode: run.errorCode, outcome: run.outcome, createdAt: iso(run.createdAt) })) };
    }
    const events = await audit.list({ targetType: "marketing_automation", targetId: automationId, limit: 200 });
    const failures = await client.marketingAutomationStepRun.groupBy({ by: ["status"], where: { enrollment: { automationId } }, _count: { _all: true } });
    return { events: events.map((event) => ({ action: event.action, actor: event.actorAdminUserId, metadata: event.metadata, at: iso(event.createdAt) })), stepRuns: Object.fromEntries(failures.map((row) => [row.status, row._count._all])) };
  }

  // Internal (M8 product integration, never an end-user route): durably
  // record an approved product event for automation triggers. Unknown event
  // types are refused; payloads are minimised to the approved fields.
  async function ingestProductEvent({ organizationId, eventType, version = 1, eventId, contactEmail, occurredAt, payload }) {
    if (!approvedEvent(eventType, version)) throw mailError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", { reason: "EVENT_TYPE_NOT_APPROVED" });
    const minimized = minimizePayload(eventType, version, payload);
    const email = String(contactEmail || "").trim().toLowerCase();
    const contact = email ? await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId, email } } }) : null;
    const at = occurredAt ? new Date(occurredAt) : clock();
    const created = await client.marketingTriggerEvent.createMany({
      data: [{ organizationId, source: "PRODUCT", eventType: `${eventType}@${version}`, eventId: String(eventId).slice(0, 160), contactId: contact?.id || null, payload: minimized.payload, occurredAt: Number.isNaN(at.getTime()) ? clock() : at, status: contact ? "RECEIVED" : "IGNORED", error: contact ? null : "NO_MARKETING_CONTACT" }],
      skipDuplicates: true,
    });
    return { accepted: true, duplicate: created.count === 0, matchedContact: Boolean(contact), droppedFields: minimized.dropped };
  }

  return { list, get, create, saveDraft, submit, approve, reject, activate, pause, archive, enrollments, history, ingestProductEvent };
}

module.exports = { createAutomationService };

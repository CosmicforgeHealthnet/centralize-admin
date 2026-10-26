"use strict";

// Template classification (final gap 1): MARKETING | TRANSACTIONAL |
// TRANSACTIONAL_SECURITY.
//
// - marketing_template_policies holds the CURRENT class of a Studio template
//   (no row = MARKETING).
// - marketing_template_version_policies is an append-only (trigger-guarded)
//   snapshot of the class at version creation. Every use of a version reads
//   the VERSION snapshot, so reclassifying a template never changes what an
//   already created / approved version is. A version without a snapshot was
//   created before classification existed (or before migration 37) and is
//   MARKETING.
// - TRANSACTIONAL_SECURITY versions are usable only after a template version
//   approval by a person other than its author: an append-only Mail audit
//   event MARKETING_TEMPLATE_VERSION_APPROVED (actor != version author, bound
//   to the version's content hash). Audit rows cannot be edited or deleted
//   (mail_audit_events trigger), so the approval cannot be forged by editing.
// - Marketing campaigns, broadcasts, automations and campaign test sends only
//   accept MARKETING versions ("MARKETING" purpose). Transactional versions
//   are usable for preview / template QA only: there is no product send path
//   that uses Studio templates (integrations/ sends caller-supplied content),
//   so assertTemplateUsable is the reusable gate for any future one.
//
// Before migration 37 (feature not ready) every template and version is
// MARKETING and nothing is queried; classification writes answer 503.

const { mailError } = require("../mail.errors");
const { createMailSchemaReadiness, MAIL_FINAL_GAP_REQUIREMENTS } = require("../schema-readiness");
const { CLASSIFICATIONS, TRANSACTIONAL_CLASSES } = require("./template-renderer");

const MARKETING = "MARKETING";
const APPROVAL_ACTION = "MARKETING_TEMPLATE_VERSION_APPROVED";
const VERSION_TARGET = "marketing_template_version";

// purpose -> classes a version may have for that use.
const PURPOSE_CLASSES = {
  MARKETING: [MARKETING],
  PREVIEW: CLASSIFICATIONS,
  TRANSACTIONAL: ["TRANSACTIONAL", "TRANSACTIONAL_SECURITY"],
  TRANSACTIONAL_SECURITY: ["TRANSACTIONAL_SECURITY"],
};

function isTransactional(classification) {
  return TRANSACTIONAL_CLASSES.has(classification);
}

function createTemplatePolicy({ client, feature = null, logger = null }) {
  const readiness = feature || createMailSchemaReadiness({ client, logger, requirements: MAIL_FINAL_GAP_REQUIREMENTS, label: "Mail final gap-closure" });

  async function ready() {
    try {
      return Boolean(await readiness.isReady());
    } catch {
      return false;
    }
  }

  async function requireReady() {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "template_classification" });
  }

  // Current template class: { classification, available, reason, changedBy, updatedAt }.
  async function templateClassification(templateId, db = client) {
    if (!(await ready())) return { classification: MARKETING, available: false, reason: null, changedBy: null, updatedAt: null };
    const row = await db.marketingTemplatePolicy.findUnique({ where: { templateId } });
    return { classification: row?.classification || MARKETING, available: true, reason: row?.reason || null, changedBy: row?.changedBy || null, updatedAt: row?.updatedAt || null };
  }

  async function templateClassifications(templateIds, db = client) {
    const map = new Map(templateIds.map((id) => [id, MARKETING]));
    if (!templateIds.length || !(await ready())) return { map, available: await ready() };
    const rows = await db.marketingTemplatePolicy.findMany({ where: { templateId: { in: templateIds } } });
    for (const row of rows) map.set(row.templateId, row.classification);
    return { map, available: true };
  }

  async function versionClassifications(versionIds, db = client) {
    const map = new Map(versionIds.map((id) => [id, MARKETING]));
    if (!versionIds.length || !(await ready())) return map;
    const rows = await db.marketingTemplateVersionPolicy.findMany({ where: { versionId: { in: versionIds } } });
    for (const row of rows) map.set(row.versionId, row.classification);
    return map;
  }

  async function versionClassification(versionId, db = client) {
    return (await versionClassifications([versionId], db)).get(versionId);
  }

  // Append-only snapshot; only written once migration 37 is present.
  async function snapshotVersion(tx, versionId, classification) {
    if (!(await ready())) return null;
    return tx.marketingTemplateVersionPolicy.create({ data: { versionId, classification } });
  }

  // Freezes versions that predate classification as MARKETING before the
  // template class changes (so they keep meaning what they meant).
  async function freezeExistingVersions(tx, templateId) {
    const versions = await tx.marketingTemplateVersion.findMany({ where: { templateId }, select: { id: true } });
    if (!versions.length) return 0;
    const result = await tx.marketingTemplateVersionPolicy.createMany({ data: versions.map((version) => ({ versionId: version.id, classification: MARKETING })), skipDuplicates: true });
    return result.count;
  }

  // Valid template version approval: by someone other than the author, for
  // exactly this content.
  async function versionApproval(version, db = client) {
    if (!(await ready())) return { approved: false, approvedBy: null, approvedAt: null };
    const rows = await db.mailAuditEvent.findMany({ where: { action: APPROVAL_ACTION, targetType: VERSION_TARGET, targetId: version.id, outcome: "SUCCESS" }, orderBy: { createdAt: "asc" }, take: 20 });
    const valid = rows.find((row) => row.actorAdminUserId && row.actorAdminUserId !== version.createdBy && row.metadata?.versionSha256 === version.contentSha256);
    return valid ? { approved: true, approvedBy: valid.actorAdminUserId, approvedAt: valid.createdAt } : { approved: false, approvedBy: null, approvedAt: null };
  }

  async function loadVersion(versionOrId, db) {
    if (versionOrId && typeof versionOrId === "object") return versionOrId.template ? versionOrId : db.marketingTemplateVersion.findUnique({ where: { id: versionOrId.id }, include: { template: true } });
    if (!versionOrId || !/^[0-9a-f-]{36}$/i.test(String(versionOrId))) return null;
    return db.marketingTemplateVersion.findUnique({ where: { id: String(versionOrId) }, include: { template: true } });
  }

  // null when usable, otherwise a reason code. Never trusts a template-level
  // row: the version snapshot decides.
  async function usabilityProblem(versionOrId, { purpose = MARKETING, organizationId = null, db = client } = {}) {
    const allowed = PURPOSE_CLASSES[purpose];
    if (!allowed) return "TEMPLATE_PURPOSE_UNKNOWN";
    const version = await loadVersion(versionOrId, db);
    if (!version || (organizationId && version.template?.organizationId !== organizationId)) return "TEMPLATE_UNAVAILABLE";
    const classification = await versionClassification(version.id, db);
    if (!allowed.includes(classification)) {
      if (purpose === MARKETING) return "TEMPLATE_NOT_MARKETING";
      return classification === MARKETING ? "TEMPLATE_NOT_TRANSACTIONAL" : "TEMPLATE_CLASSIFICATION_MISMATCH";
    }
    if (classification === "TRANSACTIONAL_SECURITY" && purpose !== "PREVIEW" && !(await versionApproval(version, db)).approved) return "TEMPLATE_VERSION_NOT_APPROVED";
    return null;
  }

  async function assertTemplateUsable(versionOrId, { purpose = MARKETING, organizationId = null, db = client, field = "templateVersionId" } = {}) {
    const problem = await usabilityProblem(versionOrId, { purpose, organizationId, db });
    if (problem) throw mailError("MAIL_VALIDATION_FAILED", { field, reason: problem, status: 422 });
    return true;
  }

  return { ready, requireReady, templateClassification, templateClassifications, versionClassification, versionClassifications, snapshotVersion, freezeExistingVersions, versionApproval, usabilityProblem, assertTemplateUsable };
}

// One policy per Prisma client. application.js registers the instance built
// with the shared migration-37 readiness probe; modules constructed without
// it (broadcast processor, automation service) resolve it here. Without a
// registration a policy with its own readiness probe is created.
const REGISTRY = new WeakMap();

function registerTemplatePolicy(client, templatePolicy) {
  if (client && typeof client === "object") REGISTRY.set(client, templatePolicy);
  return templatePolicy;
}

function templatePolicyFor(client) {
  if (!REGISTRY.has(client)) REGISTRY.set(client, createTemplatePolicy({ client }));
  return REGISTRY.get(client);
}

module.exports = { createTemplatePolicy, registerTemplatePolicy, templatePolicyFor, isTransactional, PURPOSE_CLASSES, APPROVAL_ACTION, VERSION_TARGET, MARKETING, CLASSIFICATIONS };

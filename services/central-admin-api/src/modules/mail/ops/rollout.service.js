"use strict";

// M10 rollout controls.
//
// - Rules: per deployment environment, capability (send purpose, product
//   integration ingestion, worker queue) and scope (ENVIRONMENT, ORGANIZATION,
//   DOMAIN, MAILBOX, COHORT). With enforcement on, a capability is allowed only
//   when an ALLOW rule matches and no DENY rule does. Enforcement defaults ON
//   in production and OFF elsewhere (MAIL_ROLLOUT_ENFORCED overrides).
//   Rules are never edited, only revoked. Creating an ALLOW rule needs a
//   step-up (MAIL_ROLLOUT_CHANGE); DENY rules and revocations of ALLOW rules
//   (which only reduce exposure) do not.
// - Cohorts: pilot staff groups. Adding a member is onboarding; removing is
//   offboarding and takes effect on the next send check.
// - Emergency stops: ALL, MARKETING or one ORGANIZATION. Activation is
//   immediate for any mail admin with EDIT; release needs a step-up
//   (MAIL_EMERGENCY_STOP_RELEASE).
// Environment flags (MAIL_*_ENABLED, MAIL_EMERGENCY_STOP_*) still apply first:
// rules can only narrow what configuration allows, never widen it.

const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const SEND_CAPABILITIES = ["STAFF_MAIL", "SUPPORT", "MARKETING_BROADCAST", "MARKETING_AUTOMATION", "MARKETING_CONFIRMATION"];
const CAPABILITIES = [...SEND_CAPABILITIES, "PRODUCT_INTEGRATION", "WORKER_OUTBOUND", "WORKER_INBOUND", "WORKER_EVENTS", "WORKER_MARKETING"];
const SCOPE_TYPES = ["ENVIRONMENT", "ORGANIZATION", "DOMAIN", "MAILBOX", "COHORT"];
const MARKETING = new Set(["MARKETING_BROADCAST", "MARKETING_AUTOMATION", "MARKETING_CONFIRMATION"]);
const CACHE_MS = 5000;

function iso(value) {
  return value ? value.toISOString() : null;
}

function createRolloutService({ client, config, audit, stepUp, clock = () => new Date() }) {
  const environment = config.deploymentEnvironment;
  const enforced = config.rollout.enforced;
  let cache = null;

  function invalidate() {
    cache = null;
  }

  // Cross-replica consistency (spec 20): rules and stops are append-only with
  // revoke/release timestamps, so (latest change, row count) changes whenever
  // any replica edits them. One cheap aggregate per decision; the rows are
  // re-read only when it changed. A rule change or emergency stop is
  // therefore effective on every API replica and worker at the next check.
  async function fingerprint() {
    if (typeof client.$queryRaw !== "function") return null;
    try {
      const [row] = await client.$queryRaw`
        SELECT
          (SELECT coalesce(max(greatest("created_at", coalesce("revoked_at", "created_at")))::text, '-') || ':' || count(*)::text FROM "mail_rollout_rules" WHERE "environment" = ${environment}) AS "rules",
          (SELECT coalesce(max(greatest("activated_at", coalesce("released_at", "activated_at")))::text, '-') || ':' || count(*)::text FROM "mail_emergency_stops" WHERE "environment" = ${environment}) AS "stops"`;
      return row ? `${row.rules}|${row.stops}` : null;
    } catch {
      return null;
    }
  }

  async function state() {
    const now = clock().getTime();
    const version = await fingerprint();
    if (cache && (version !== null ? cache.version === version : now - cache.at < CACHE_MS)) return cache;
    const [rules, stops] = await Promise.all([
      client.mailRolloutRule.findMany({ where: { environment, revokedAt: null } }),
      client.mailEmergencyStop.findMany({ where: { environment, releasedAt: null } }),
    ]);
    cache = { at: now, version, rules, stops };
    return cache;
  }

  async function cohortIdsFor(adminUserId) {
    if (!adminUserId) return [];
    const rows = await client.mailRolloutCohortMember.findMany({ where: { adminUserId, removedAt: null }, select: { cohortId: true } });
    return rows.map((row) => row.cohortId);
  }

  function matches(rule, scope, cohorts) {
    switch (rule.scopeType) {
      case "ENVIRONMENT": return true;
      case "ORGANIZATION": return Boolean(scope.organizationId) && rule.scopeId === scope.organizationId;
      case "DOMAIN": return Boolean(scope.domainId) && rule.scopeId === scope.domainId;
      case "MAILBOX": return Boolean(scope.mailboxId) && rule.scopeId === scope.mailboxId;
      case "COHORT": return cohorts.includes(rule.scopeId);
      default: return false;
    }
  }

  /** Returns null when allowed, else a reason code. */
  async function decide(capability, scope = {}) {
    const current = await state();
    const stop = current.stops.find((entry) => entry.scope === "ALL" || (entry.scope === "MARKETING" && MARKETING.has(capability)) || (entry.scope === "ORGANIZATION" && scope.organizationId && entry.organizationId === scope.organizationId));
    if (stop && (SEND_CAPABILITIES.includes(capability))) return "MAIL_EMERGENCY_STOP";
    if (!enforced) return null;
    const rules = current.rules.filter((rule) => rule.capability === capability);
    if (!scope.domainId && scope.senderAddressId && rules.some((rule) => rule.scopeType === "DOMAIN")) {
      const address = await client.mailAddress.findUnique({ where: { id: scope.senderAddressId }, select: { domainId: true } });
      scope = { ...scope, domainId: address?.domainId };
    }
    const needsCohorts = rules.some((rule) => rule.scopeType === "COHORT");
    const cohorts = needsCohorts ? await cohortIdsFor(scope.adminUserId) : [];
    if (rules.some((rule) => rule.effect === "DENY" && matches(rule, scope, cohorts))) return "MAIL_ROLLOUT_DENIED";
    if (!rules.some((rule) => rule.effect === "ALLOW" && matches(rule, scope, cohorts))) return "MAIL_ROLLOUT_NOT_ENABLED";
    return null;
  }

  // Resolver plugged into runtime controls (send purposes == capabilities).
  const resolver = (purpose, scope) => decide(purpose, scope);

  async function workerQueuesAllowed(queues) {
    if (!enforced) return queues;
    const allowed = [];
    for (const queue of queues) {
      // Essential queues follow backend service flags; rollout still controls
      // optional MARKETING processing. Explicit DENY rules remain enforceable.
      const capability = `WORKER_${queue}`;
      const decision = await decide(capability);
      const coreEnabled = queue === "INBOUND"
        ? config.receivingEnabled && config.inbound?.ownedHere !== false
        : queue === "OUTBOUND"
          ? config.sendingEnabled
          : queue === "EVENTS" && config.enabled;
      if (decision === "MAIL_ROLLOUT_DENIED") continue;
      if (decision === null || (decision === "MAIL_ROLLOUT_NOT_ENABLED" && coreEnabled)) allowed.push(queue);
    }
    return allowed;
  }

  // ---- administration -------------------------------------------------
  function serializeRule(rule) {
    return { id: rule.id, environment: rule.environment, capability: rule.capability, scopeType: rule.scopeType, scopeId: rule.scopeId, effect: rule.effect, reason: rule.reason, createdBy: rule.createdBy, createdAt: iso(rule.createdAt), revokedAt: iso(rule.revokedAt), revokedBy: rule.revokedBy };
  }

  function serializeStop(stop) {
    return { id: stop.id, environment: stop.environment, scope: stop.scope, organizationId: stop.organizationId, reason: stop.reason, activatedBy: stop.activatedBy, activatedAt: iso(stop.activatedAt), releasedAt: iso(stop.releasedAt), releasedBy: stop.releasedBy };
  }

  async function overview(user) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const [rules, stops, cohorts] = await Promise.all([
      client.mailRolloutRule.findMany({ where: { environment }, orderBy: { createdAt: "desc" }, take: 500 }),
      client.mailEmergencyStop.findMany({ where: { environment }, orderBy: { activatedAt: "desc" }, take: 100 }),
      client.mailRolloutCohort.findMany({ include: { members: { where: { removedAt: null }, select: { adminUserId: true, addedAt: true } } }, orderBy: { key: "asc" } }),
    ]);
    return {
      environment,
      enforced,
      capabilities: CAPABILITIES,
      scopeTypes: SCOPE_TYPES,
      rules: rules.map(serializeRule),
      emergencyStops: stops.map(serializeStop),
      environmentStops: { all: config.emergencyStop.all, marketing: config.emergencyStop.marketing },
      cohorts: cohorts.map((cohort) => ({ id: cohort.id, key: cohort.key, name: cohort.name, description: cohort.description, members: cohort.members.map((member) => ({ adminUserId: member.adminUserId, addedAt: iso(member.addedAt) })) })),
    };
  }

  async function validateScope(scopeType, scopeId) {
    if (!SCOPE_TYPES.includes(scopeType)) throw mailError("MAIL_VALIDATION_FAILED", { field: "scopeType" });
    if (scopeType === "ENVIRONMENT") return null;
    const id = String(scopeId || "");
    const exists = !policy.isUuid(id) ? null
      : scopeType === "ORGANIZATION" ? await client.mailOrganization.findUnique({ where: { id } })
        : scopeType === "DOMAIN" ? await client.mailDomain.findUnique({ where: { id } })
          : scopeType === "MAILBOX" ? await client.mailMailbox.findUnique({ where: { id } })
            : await client.mailRolloutCohort.findUnique({ where: { id } });
    if (!exists) throw mailError("MAIL_VALIDATION_FAILED", { field: "scopeId" });
    return id;
  }

  async function createRule(user, { capability, scopeType, scopeId, effect, reason, stepUpId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!CAPABILITIES.includes(capability)) throw mailError("MAIL_VALIDATION_FAILED", { field: "capability" });
    if (!["ALLOW", "DENY"].includes(effect)) throw mailError("MAIL_VALIDATION_FAILED", { field: "effect" });
    if (capability.startsWith("WORKER_") && scopeType !== "ENVIRONMENT") throw mailError("MAIL_VALIDATION_FAILED", { field: "scopeType", reason: "WORKER_RULES_ARE_ENVIRONMENT_WIDE" });
    const text = String(reason || "").trim();
    if (text.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const id = await validateScope(scopeType, scopeId);
    const rule = await client.$transaction(async (tx) => {
      // Widening exposure needs a fresh step-up; narrowing does not.
      if (effect === "ALLOW") await stepUp.consume(tx, user, stepUpId, "MAIL_ROLLOUT_CHANGE", context);
      const created = await tx.mailRolloutRule.create({ data: { environment, capability, scopeType, scopeId: id, effect, reason: text.slice(0, 500), createdBy: user.id, createdAt: clock() } }).catch((error) => {
        if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "RULE_ALREADY_ACTIVE" });
        throw error;
      });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_ROLLOUT_RULE_CREATED", targetType: "mail_rollout_rule", targetId: created.id, organizationId: scopeType === "ORGANIZATION" ? id : null, metadata: { environment, capability, scopeType, scopeId: id, effect } }, context, tx);
      return created;
    });
    invalidate();
    return serializeRule(rule);
  }

  async function revokeRule(user, ruleId, { stepUpId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const rule = policy.isUuid(ruleId) ? await client.mailRolloutRule.findUnique({ where: { id: ruleId } }) : null;
    if (!rule || rule.environment !== environment) throw mailError("MAIL_NOT_FOUND", { resource: "rollout_rule" });
    const updated = await client.$transaction(async (tx) => {
      // Revoking a DENY widens exposure, so it needs the same step-up as ALLOW.
      if (rule.effect === "DENY") await stepUp.consume(tx, user, stepUpId, "MAIL_ROLLOUT_CHANGE", context);
      const result = await tx.mailRolloutRule.updateMany({ where: { id: rule.id, revokedAt: null }, data: { revokedAt: clock(), revokedBy: user.id } });
      if (!result.count) throw mailError("MAIL_INVALID_TRANSITION", { reason: "ALREADY_REVOKED" });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_ROLLOUT_RULE_REVOKED", targetType: "mail_rollout_rule", targetId: rule.id, metadata: { capability: rule.capability, scopeType: rule.scopeType, effect: rule.effect } }, context, tx);
      return tx.mailRolloutRule.findUnique({ where: { id: rule.id } });
    });
    invalidate();
    return serializeRule(updated);
  }

  async function createCohort(user, { key, name, description } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const slug = String(key || "").toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(slug)) throw mailError("MAIL_VALIDATION_FAILED", { field: "key" });
    if (!String(name || "").trim()) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    const cohort = await client.mailRolloutCohort.create({ data: { key: slug, name: String(name).trim().slice(0, 160), description: description ? String(description).slice(0, 500) : null, createdBy: user.id, createdAt: clock() } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "COHORT_KEY_TAKEN" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_ROLLOUT_COHORT_CREATED", targetType: "mail_rollout_cohort", targetId: cohort.id, metadata: { key: slug } }, context);
    return { id: cohort.id, key: cohort.key, name: cohort.name, description: cohort.description, members: [] };
  }

  async function addMember(user, cohortId, { adminUserId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const cohort = policy.isUuid(cohortId) ? await client.mailRolloutCohort.findUnique({ where: { id: cohortId } }) : null;
    if (!cohort) throw mailError("MAIL_NOT_FOUND", { resource: "rollout_cohort" });
    const staff = adminUserId ? await client.adminUser.findUnique({ where: { id: String(adminUserId) }, select: { id: true, status: true } }) : null;
    if (!staff || staff.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "adminUserId", reason: "ACTIVE_STAFF_REQUIRED" });
    await client.mailRolloutCohortMember.create({ data: { cohortId: cohort.id, adminUserId: staff.id, addedBy: user.id, addedAt: clock() } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "ALREADY_A_MEMBER" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_PILOT_MEMBER_ONBOARDED", targetType: "mail_rollout_cohort", targetId: cohort.id, metadata: { adminUserId: staff.id } }, context);
    return { cohortId: cohort.id, adminUserId: staff.id, active: true };
  }

  async function removeMember(user, cohortId, adminUserId, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const result = await client.mailRolloutCohortMember.updateMany({ where: { cohortId: String(cohortId), adminUserId: String(adminUserId), removedAt: null }, data: { removedAt: clock(), removedBy: user.id } });
    if (!result.count) throw mailError("MAIL_NOT_FOUND", { resource: "cohort_member" });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_PILOT_MEMBER_OFFBOARDED", targetType: "mail_rollout_cohort", targetId: String(cohortId), metadata: { adminUserId: String(adminUserId) } }, context);
    return { cohortId: String(cohortId), adminUserId: String(adminUserId), active: false };
  }

  // Pilot onboarding checklist for one staff member (no mail content).
  async function pilotStatus(user, adminUserId) {
    await policy.requireMailAdmin(client, user, "VIEW");
    const staff = await client.adminUser.findUnique({ where: { id: String(adminUserId) }, select: { id: true, status: true, name: true } });
    if (!staff) throw mailError("MAIL_NOT_FOUND", { resource: "staff" });
    const [mfa, memberships, mailboxes, cohortRows] = await Promise.all([
      client.adminMfaEnrollment.findUnique({ where: { adminUserId: staff.id } }).catch(() => null),
      client.mailMembership.count({ where: { adminUserId: staff.id, revokedAt: null } }).catch(() => 0),
      client.mailMailbox.findMany({ where: { ownerAdminUserId: staff.id }, select: { id: true, status: true, organizationId: true } }),
      client.mailRolloutCohortMember.findMany({ where: { adminUserId: staff.id, removedAt: null }, include: { cohort: { select: { key: true } } } }),
    ]);
    const decisions = {};
    for (const capability of ["STAFF_MAIL", "SUPPORT"]) decisions[capability] = (await decide(capability, { adminUserId: staff.id, organizationId: mailboxes[0]?.organizationId, mailboxId: mailboxes[0]?.id })) || "ALLOWED";
    return {
      adminUserId: staff.id,
      accountActive: staff.status === "ACTIVE",
      mfaEnrolled: Boolean(mfa),
      personalMailboxes: mailboxes.map((mailbox) => ({ id: mailbox.id, status: mailbox.status })),
      sharedMemberships: memberships,
      cohorts: cohortRows.map((row) => row.cohort.key),
      decisions,
      ready: staff.status === "ACTIVE" && Boolean(mfa) && mailboxes.some((mailbox) => mailbox.status === "ACTIVE") && decisions.STAFF_MAIL === "ALLOWED",
    };
  }

  async function activateStop(user, { scope, organizationId, reason } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!["ALL", "MARKETING", "ORGANIZATION"].includes(scope)) throw mailError("MAIL_VALIDATION_FAILED", { field: "scope" });
    if (scope === "ORGANIZATION" && !(policy.isUuid(organizationId) && (await client.mailOrganization.findUnique({ where: { id: organizationId } })))) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    const text = String(reason || "").trim();
    if (text.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const stop = await client.mailEmergencyStop.create({ data: { environment, scope, organizationId: scope === "ORGANIZATION" ? organizationId : null, reason: text.slice(0, 500), activatedBy: user.id, activatedAt: clock() } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "STOP_ALREADY_ACTIVE" });
      throw error;
    });
    invalidate();
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_EMERGENCY_STOP_ACTIVATED", targetType: "mail_emergency_stop", targetId: stop.id, organizationId: stop.organizationId, metadata: { environment, scope } }, context);
    return serializeStop(stop);
  }

  async function releaseStop(user, stopId, { stepUpId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const stop = policy.isUuid(stopId) ? await client.mailEmergencyStop.findUnique({ where: { id: stopId } }) : null;
    if (!stop || stop.environment !== environment) throw mailError("MAIL_NOT_FOUND", { resource: "emergency_stop" });
    const released = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_EMERGENCY_STOP_RELEASE", context);
      const result = await tx.mailEmergencyStop.updateMany({ where: { id: stop.id, releasedAt: null }, data: { releasedAt: clock(), releasedBy: user.id } });
      if (!result.count) throw mailError("MAIL_INVALID_TRANSITION", { reason: "ALREADY_RELEASED" });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_EMERGENCY_STOP_RELEASED", targetType: "mail_emergency_stop", targetId: stop.id, organizationId: stop.organizationId, metadata: { scope: stop.scope } }, context, tx);
      return tx.mailEmergencyStop.findUnique({ where: { id: stop.id } });
    });
    invalidate();
    return serializeStop(released);
  }

  return { decide, resolver, workerQueuesAllowed, overview, createRule, revokeRule, createCohort, addMember, removeMember, pilotStatus, activateStop, releaseStop, invalidate, CAPABILITIES, SCOPE_TYPES };
}

module.exports = { createRolloutService, CAPABILITIES, SCOPE_TYPES, SEND_CAPABILITIES };

const { hasFreshVerifiedMfa } = require("../../../shared/auth/privileged-mfa");
const { readExecutionConfig } = require("./execution.config");
const { PLAN_STATES, PLAN_TRANSITIONS, OPERATION_STATES, OPERATION_TRANSITIONS, ACTOR_ROLES, PROVIDERS } = require("./execution.constants");
const { validatePlanInput } = require("./plans/plan.validator");
const { fingerprintPlan } = require("./plans/plan-fingerprint");
const { PlanRepository, validateItemSet } = require("./plans/plan.repository");
const { PolicyRepository } = require("./policy/policy.repository");
const { createExecutionAdapterRegistry } = require("./adapters/execution-adapter.registry");
const { createCapabilityDiscoveryService } = require("./capabilities/capability-discovery.service");
const { getAdvertisingExecutionApplication } = require("./runtime");
const { executionError } = require("./execution.errors");
const { sanitizeExecutionJson, hashExecutionJson, canonicalJson } = require("./execution-json.validator");
const queryValidator = require("./execution.query-validator");
const { createExecutionHealthService } = require("./execution.health");
const { sanitizeExecutionEvent } = require("./execution.observability");
const { mapPlanSummary, mapPlanDetail, mapPolicy, mapRun, mapOperationDetail, mapDrift, mapQueueResult, mapDeadLetterResult } = require("./execution.response");
const { mapCreativePublication } = require("./creatives/creative-publication.response");
const { TIER_RANK } = require("./validation/approval-integrity.service");
const { hasExecutionRole } = require("./execution.authorization");

const PLAN_SORTS = Object.freeze({ createdAt: "createdAt", updatedAt: "updatedAt", name: "name", status: "status" });
const RUN_SORTS = Object.freeze({ createdAt: "createdAt", startedAt: "startedAt", completedAt: "completedAt", status: "status" });
const DRIFT_SORTS = Object.freeze({ createdAt: "createdAt", checkedAt: "checkedAt", status: "status" });

function currentDecision(approval) { return approval.events?.at(-1)?.decision || approval.decision; }
function safeActor(actor) { if (!actor?.id) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "AUTHENTICATED_ACTOR_REQUIRED" }); return actor; }
function expectedVersion(input) { return queryValidator.intValue(input?.expectedVersion, "body.expectedVersion", { required: true, min: 1 }); }
function pageResult(rows, total, page, limit) { return { items: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }; }
function orderBy(sortMap, sort, direction, fallback = "createdAt") { const field = sortMap[sort || fallback]; if (!field) throw executionError("INVALID_EXECUTION_PLAN", { field: "query.sort", reasonCode: "UNSUPPORTED_SORT_FIELD" }); return [{ [field]: direction }, { id: direction }]; }
function assertDateRange(from, to, field) { if (from && to && from > to) throw executionError("INVALID_EXECUTION_PLAN", { field, reasonCode: "INVALID_DATE_RANGE" }); }

function createExecutionService({ env = process.env, registry, capabilityDiscovery, application } = {}) {
  const app = application || (!registry && !capabilityDiscovery ? getAdvertisingExecutionApplication() : null);
  const adapterRegistry = registry || app?.adapterRegistry || createExecutionAdapterRegistry({ env });
  const discovery = capabilityDiscovery || app?.capabilityDiscovery || createCapabilityDiscoveryService({ env, registry: adapterRegistry });
  const planRepository = new PlanRepository({ client: app?.client });
  const policyRepository = new PolicyRepository({ client: app?.client });
  const healthService = app ? createExecutionHealthService({ app, env }) : null;

  async function audit(actor, action, targetId, targetType, metadata = {}) {
    if (app?.audit) await app.audit.event({ actorId: actor?.id || null, action, targetId, targetType, metadata: sanitizeExecutionEvent(metadata) });
  }

  async function authorize(actor, role) {
    safeActor(actor);
    if (!await hasExecutionRole(actor, role, app?.client)) {
      throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: `${role}_ROLE_REQUIRED` });
    }
  }

  async function capabilities(rawQuery = {}) {
    const query = queryValidator.capabilityQuery(rawQuery);
    if (!query.connectionId && [query.objective, query.campaignType, query.operationType, query.resourceType, query.creativeFormat].some(Boolean)) throw executionError("INVALID_EXECUTION_PLAN", { field: "query", reasonCode: "CONTEXT_FILTERS_REQUIRE_ACCOUNT_SCOPE" });
    const config = readExecutionConfig(env);
    if (query.connectionId && query.accountExternalId) {
      if (!query.provider) throw executionError("INVALID_EXECUTION_PLAN", { field: "query.provider", reasonCode: "PROVIDER_REQUIRED_FOR_ACCOUNT_CAPABILITY" });
      return discovery.resolve(query);
    }
    const providers = adapterRegistry.capabilities().filter((item) => !query.provider || item.provider === query.provider).map((item) => ({ ...item, credentialPresent: false, connectionReady: false, readCapability: item.configured === true, writeCapability: false, effectiveMasterGate: config.enabled, effectiveProviderGate: config.providers[item.provider] === true, effectiveConnectionGate: false, dryRun: config.dryRun, blockers: ["ACCOUNT_DISCOVERY_REQUIRED", ...(!config.enabled ? ["GLOBAL_EXECUTION_DISABLED"] : []), ...(config.providers[item.provider] ? [] : ["PROVIDER_EXECUTION_DISABLED"])] }));
    return { executionEnabled: config.enabled, dryRun: config.dryRun, workerEnabled: config.workerEnabled, connectionWriteEnabled: false, providers };
  }

  function lifecycle() { return { roles: ACTOR_ROLES, plans: { states: PLAN_STATES, transitions: PLAN_TRANSITIONS }, operations: { states: OPERATION_STATES, transitions: OPERATION_TRANSITIONS } }; }
  function preflight(input) { const plan = validatePlanInput(input); adapterRegistry.resolve(plan.provider, { connectionWriteEnabled: false }); return fingerprintPlan(plan, 1); }
  async function runIsolatedContexts(contexts, handler) { return Promise.all((contexts || []).map(async (context) => { try { return { context, status: "FULFILLED", value: await handler(context) }; } catch (error) { return { context, status: "REJECTED", error }; } })); }

  async function listPolicies(rawQuery = {}) {
    const allowed = ["provider", "connectionId", "effective", "page", "limit", "sortDirection"];
    const paging = queryValidator.pagination(rawQuery, allowed); const where = {};
    if (rawQuery.provider) where.platform = queryValidator.enumValue(rawQuery.provider, PROVIDERS, "query.provider", true);
    if (rawQuery.connectionId) where.connectionId = queryValidator.uuid(rawQuery.connectionId, "query.connectionId");
    if (rawQuery.effective != null) where.enabled = queryValidator.boolValue(rawQuery.effective, "query.effective");
    const { rows, total } = await policyRepository.list({ where, skip: paging.skip, take: paging.limit });
    return pageResult(rows.map(mapPolicy), total, paging.page, paging.limit);
  }

  async function updatePolicy({ actor, input }) {
    await authorize(actor, "EXECUTION_ADMIN"); queryValidator.body(input, ["id", "expectedVersion", "valueType", "value", "enabled", "reason", "emergencyOverride"], ["id", "expectedVersion", "valueType", "value", "enabled", "reason"]);
    const id = queryValidator.uuid(input.id, "body.id"); const version = expectedVersion(input); const reason = queryValidator.textValue(input.reason, "body.reason", { required: true, min: 3, max: 2000 });
    const policy = await app.client.marketingExecutionPolicy.findUnique({ where: { id } }); if (!policy) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "POLICY_NOT_FOUND" });
    const valueType = queryValidator.enumValue(input.valueType, ["BOOLEAN", "INTEGER", "DECIMAL", "STRING", "JSON"], "body.valueType", true);
    if (input.enabled && policy.key === "execution.write.enabled" && !readExecutionConfig(env).enabled) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "GLOBAL_GATE_PRECEDENCE" });
    if (/emergency/i.test(policy.key)) {
      await authorize(actor, "EMERGENCY_OPERATOR");
      if (!hasFreshVerifiedMfa(actor)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "TWO_FACTOR_REQUIRED" });
      if (!input.emergencyOverride?.expiresAt || new Date(input.emergencyOverride.expiresAt) <= new Date()) throw executionError("INVALID_EXECUTION_PLAN", { field: "body.emergencyOverride.expiresAt", reasonCode: "BOUNDED_FUTURE_EXPIRY_REQUIRED" });
    }
    const changedFields = ["valueType", "value", "enabled"].filter((field) => field === "valueType" ? policy.valueType !== valueType : field === "enabled" ? policy.enabled !== Boolean(input.enabled) : canonicalJson(policy.value) !== canonicalJson(input.value));
    let updated; try { updated = await policyRepository.update({ id, expectedVersion: version, actorId: actor.id, valueType, value: input.value, enabled: input.enabled, reason, changedFields, correlationId: actor.correlationId }); } catch (error) { if (error.code === "PLAN_VERSION_CONFLICT" || error.errors?.[0]?.code === "PLAN_VERSION_CONFLICT") throw executionError("EXECUTION_PLAN_CONFLICT", { entity: "POLICY", id, expectedVersion: version }); throw error; }
    await audit(actor, "MARKETING_EXECUTION_POLICY_UPDATED", id, "marketing_execution_policy", { previousVersion: policy.version, newVersion: updated.version, reason, changedFields });
    if (policy.enabled !== updated.enabled && app.events) await app.events.emit("KILL_SWITCH_CHANGED", { correlationId: actor.correlationId, scope: policy.scope, platform: policy.platform, connectionId: policy.connectionId, previousValue: policy.enabled, newValue: updated.enabled, actorId: actor.id, reason }, [actor.id]);
    return mapPolicy(updated);
  }

  function normalizeCreatePlan(input, actor) {
    queryValidator.body(input, ["provider", "platform", "connectionId", "accountExternalId", "accountId", "currency", "currencyCode", "sourceType", "name", "title", "description", "desiredState", "items"], ["connectionId"]);
    const platform = queryValidator.enumValue(input.provider || input.platform, PROVIDERS, "body.provider", true);
    const connectionId = queryValidator.uuid(input.connectionId, "body.connectionId");
    const accountExternalId = queryValidator.textValue(input.accountExternalId || input.accountId, "body.accountExternalId", { required: true, max: 255 });
    const currencyCode = queryValidator.textValue(input.currency || input.currencyCode, "body.currency", { required: true, min: 3, max: 3 }).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw executionError("INVALID_EXECUTION_PLAN", { field: "body.currency", reasonCode: "INVALID_CURRENCY" });
    const sourceType = queryValidator.enumValue(input.sourceType || "MANUAL", ["MANUAL"], "body.sourceType", true);
    const desiredState = sanitizeExecutionJson(input.desiredState || {}, "desiredState");
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length > 200) throw executionError("INVALID_EXECUTION_PLAN", { field: "body.items", reasonCode: "ARRAY_TOO_LARGE" });
    validateItemSet(items);
    return { platform, connectionId, accountExternalId, currencyCode, sourceType, name: queryValidator.textValue(input.name || input.title || "Advertising execution plan", "body.name", { required: true, max: 255 }), description: queryValidator.textValue(input.description, "body.description", { max: 2000 }), desiredState, items, createdByAdminUserId: actor.id, updatedByAdminUserId: actor.id };
  }

  async function createPlan({ actor, input }) {
    await authorize(actor, "AUTHOR"); const data = normalizeCreatePlan(input, actor);
    const connection = await app.client.marketing_ad_platform_connections.findFirst({ where: { id: data.connectionId, platform: data.platform, accountId: data.accountExternalId }, select: { id: true, status: true } });
    if (!connection) throw executionError("EXECUTION_CAPABILITY_UNAVAILABLE", { reasonCode: "ACCOUNT_SCOPE_UNAVAILABLE" });
    const plan = await planRepository.create(data); await audit(actor, "EXECUTION_PLAN_CREATED", plan.id, "marketing_execution_plan", { planId: plan.id, version: plan.version, provider: plan.platform, connectionId: plan.connectionId, source: plan.sourceType, itemCount: plan.items.length });
    return mapPlanDetail(plan);
  }

  async function listPlans(rawQuery = {}) {
    const allowed = ["status", "provider", "connectionId", "accountExternalId", "currency", "sourceType", "sourceRecommendationId", "authorId", "createdFrom", "createdTo", "updatedFrom", "updatedTo", "approvalState", "runState", "relationship", "search", "page", "limit", "sort", "sortDirection"];
    const paging = queryValidator.pagination(rawQuery, allowed); const where = {};
    if (rawQuery.status) where.status = queryValidator.enumValue(rawQuery.status, PLAN_STATES, "query.status", true);
    if (rawQuery.provider) where.platform = queryValidator.enumValue(rawQuery.provider, PROVIDERS, "query.provider", true);
    if (rawQuery.connectionId) where.connectionId = queryValidator.uuid(rawQuery.connectionId, "query.connectionId");
    if (rawQuery.accountExternalId) where.accountExternalId = queryValidator.textValue(rawQuery.accountExternalId, "query.accountExternalId", { max: 255 });
    if (rawQuery.currency) where.currencyCode = queryValidator.textValue(rawQuery.currency, "query.currency", { min: 3, max: 3 }).toUpperCase();
    if (rawQuery.sourceType) where.sourceType = queryValidator.enumValue(rawQuery.sourceType, ["MANUAL", "RECOMMENDATION", "TEMPLATE", "ROLLBACK"], "query.sourceType", true);
    if (rawQuery.sourceRecommendationId) where.sourceRecommendationId = queryValidator.textValue(rawQuery.sourceRecommendationId, "query.sourceRecommendationId", { max: 255 });
    if (rawQuery.authorId) where.createdByAdminUserId = queryValidator.uuid(rawQuery.authorId, "query.authorId");
    const createdFrom = queryValidator.dateValue(rawQuery.createdFrom, "query.createdFrom"); const createdTo = queryValidator.dateValue(rawQuery.createdTo, "query.createdTo"); assertDateRange(createdFrom, createdTo, "query.createdFrom"); if (createdFrom || createdTo) where.createdAt = { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) };
    const updatedFrom = queryValidator.dateValue(rawQuery.updatedFrom, "query.updatedFrom"); const updatedTo = queryValidator.dateValue(rawQuery.updatedTo, "query.updatedTo"); assertDateRange(updatedFrom, updatedTo, "query.updatedFrom"); if (updatedFrom || updatedTo) where.updatedAt = { ...(updatedFrom ? { gte: updatedFrom } : {}), ...(updatedTo ? { lte: updatedTo } : {}) };
    if (rawQuery.search) { const search = queryValidator.textValue(rawQuery.search, "query.search", { max: 100 }); where.OR = [{ name: { contains: search, mode: "insensitive" } }, { planNumber: { contains: search, mode: "insensitive" } }]; }
    if (rawQuery.runState) where.runs = { some: { status: queryValidator.enumValue(rawQuery.runState, ["QUEUED", "RUNNING", "PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "RECONCILING", "CANCELLED"], "query.runState", true) } };
    if (rawQuery.approvalState) where.approvals = { some: { decision: queryValidator.enumValue(rawQuery.approvalState, ["APPROVED", "REJECTED", "REVOKED"], "query.approvalState", true) } };
    if (rawQuery.relationship) { const relationship = queryValidator.enumValue(rawQuery.relationship, ["ORIGINAL", "COMPENSATION", "STANDALONE"], "query.relationship", true); if (relationship === "ORIGINAL") where.originalCompensations = { some: {} }; else if (relationship === "COMPENSATION") where.compensationLinks = { some: {} }; else Object.assign(where, { originalCompensations: { none: {} }, compensationLinks: { none: {} } }); }
    const result = await planRepository.list({ where, skip: paging.skip, take: paging.limit, orderBy: orderBy(PLAN_SORTS, rawQuery.sort, paging.sortDirection) });
    return pageResult(result.rows.map(mapPlanSummary), result.total, paging.page, paging.limit);
  }

  async function getPlan({ id }) { const plan = await planRepository.getById(queryValidator.uuid(id, "path.id")); if (!plan) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "PLAN_NOT_FOUND" }); return mapPlanDetail(plan); }

  async function updatePlan({ actor, id, input }) {
    await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion", "name", "description", "desiredState", "items"], ["expectedVersion"]); const planId = queryValidator.uuid(id, "path.id"); const current = await planRepository.getById(planId); if (!current) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "PLAN_NOT_FOUND" });
    const version = expectedVersion(input); const changedFields = ["name", "description", "desiredState", "items"].filter((key) => input[key] !== undefined);
    let updated;
    try {
      updated = await planRepository.updateMaterial({ id: planId, expectedVersion: version, actorId: actor.id, desiredState: input.desiredState === undefined ? current.desiredState : sanitizeExecutionJson(input.desiredState, "desiredState"), name: input.name === undefined ? undefined : queryValidator.textValue(input.name, "body.name", { required: true, max: 255 }), description: input.description === undefined ? undefined : queryValidator.textValue(input.description, "body.description", { max: 2000 }), items: input.items });
    } catch (error) {
      if (error.code === "PLAN_VERSION_CONFLICT") throw executionError("EXECUTION_PLAN_CONFLICT", { id: planId, expectedVersion: version });
      throw error;
    }
    await audit(actor, "EXECUTION_PLAN_UPDATED", planId, "marketing_execution_plan", { previousVersion: version, newVersion: updated.version, changedFields, source: updated.sourceType }); return mapPlanDetail(await planRepository.getById(planId));
  }

  async function deletePlan({ actor, id, input }) { await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion", "reason"], ["expectedVersion", "reason"]); const plan = await planRepository.cancel({ id: queryValidator.uuid(id, "path.id"), expectedVersion: expectedVersion(input), actorId: actor.id, eligibleStatuses: ["DRAFT"] }); await audit(actor, "EXECUTION_PLAN_UPDATED", plan.id, "marketing_execution_plan", { previousVersion: plan.version, newVersion: plan.version, changedFields: ["status"], reason: queryValidator.textValue(input.reason, "body.reason", { required: true, max: 2000 }) }); return mapPlanDetail(plan); }

  async function validatePlan({ actor, id, input }) {
    await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion"], ["expectedVersion"]); const plan = await planRepository.getById(queryValidator.uuid(id, "path.id")); if (!plan || !["DRAFT", "VALIDATED"].includes(plan.status) || plan.version !== expectedVersion(input)) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "CURRENT_EDITABLE_PLAN_REQUIRED" });
    const connection = await app.client.marketing_ad_platform_connections.findUnique({ where: { id: plan.connectionId }, select: { id: true, platform: true, accountId: true, status: true, validationStatus: true, requiresReauthorization: true, connectionMetadata: true } });
    let validation; const started = Date.now();
    const validationInput = { id: plan.id, platform: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId, currencyCode: plan.currencyCode, version: plan.version, desiredState: plan.desiredState, connection, items: plan.items.map((item) => ({ id: item.id, sequence: item.sequence, operationType: item.operationType, resourceType: item.resourceType, providerResourceId: item.providerResourceId, clientReference: item.clientReference, dependsOnItemIds: item.dependsOnItemIds, intent: item.intent, beforeState: item.beforeState, materialHash: item.materialHash })) };
    try { validation = await app.validationPipeline(validationInput, { through: "providerPreflight" }); }
    catch (error) { app.metrics?.increment("validationFailures", 1, { provider: plan.platform }); if (["EXECUTION_CAPABILITY_UNAVAILABLE", "EXECUTION_PROVIDER_PERMISSION_ERROR", "EXECUTION_PROVIDER_RATE_LIMITED"].includes(error.code)) throw error; throw executionError("EXECUTION_VALIDATION_FAILED", { issues: error.errors || [], reasonCode: "VALIDATION_PIPELINE_FAILED" }); }
    const packetHash = fingerprintPlan({ ...plan.desiredState, items: plan.items.map((item) => ({ operationType: item.operationType, resourceType: item.resourceType, intent: item.intent, materialHash: item.materialHash })) }, plan.version).fingerprint;
    const beforeState = validation.value.providerBeforeState || {}; const beforeStateHash = hashExecutionJson(beforeState, "normalizedState").hash; const expiresAt = new Date(Date.now() + Math.max(60, Number(plan.desiredState?.approvalPolicy?.preflightFreshnessSeconds) || 900) * 1000); const issues = Object.values(validation.layers).flatMap((layer) => layer.issues || []);
    const packet = await planRepository.persistValidationPacket({ plan, actorId: actor.id, packet: { fingerprint: packetHash, valid: !issues.some((issue) => issue.severity === "ERROR"), providerApiVersion: validation.layers.providerPreflight?.evidence?.providerVersion, beforeStateHash, beforeStateSummary: beforeState, capabilitySummary: validation.layers.capability?.evidence?.capability || {}, budgetExposure: String(plan.desiredState?.budgetLimit || plan.desiredState?.budget || "0.00"), activationExposure: plan.items.some((item) => ["CREATE", "RESUME"].includes(item.operationType)), expiresAt }, issues });
    const duration = (Date.now() - started) / 1000; app.metrics?.observe("validationDurationSeconds", duration, { provider: plan.platform }); await audit(actor, "EXECUTION_PLAN_VALIDATED", plan.id, "marketing_execution_plan", { planId: plan.id, version: plan.version, fingerprint: packetHash, issueCount: issues.length, providerApiVersion: packet.providerApiVersion, beforeStateHash, expiresAt }); await app.events?.emit("PLAN_VALIDATED", { planId: plan.id, planVersion: plan.version, fingerprint: packetHash, issueCount: issues.length, provider: plan.platform, duration, expiresAt });
    if (!packet.valid) throw executionError("EXECUTION_VALIDATION_FAILED", { issues }); return { valid: true, fingerprint: packetHash, planVersion: plan.version, expiresAt, issues: [], warnings: issues.filter((issue) => issue.severity === "WARNING") };
  }

  async function submitPlan({ actor, id, input }) {
    await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion", "fingerprint"], ["expectedVersion", "fingerprint"]); const planId = queryValidator.uuid(id, "path.id"); const version = expectedVersion(input); const fp = queryValidator.fingerprint(input.fingerprint);
    const packet = await app.client.marketingExecutionValidationPacket.findFirst({ where: { planId, planVersion: version, validationFingerprint: fp, valid: true, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }); if (!packet) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "CURRENT_VALIDATION_PACKET_REQUIRED" });
    const changed = await app.client.marketingExecutionPlan.updateMany({ where: { id: planId, version, status: "VALIDATED", validationFingerprint: fp }, data: { status: "PENDING_APPROVAL", expiresAt: packet.expiresAt, updatedByAdminUserId: actor.id } }); if (changed.count !== 1) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "PLAN_NOT_SUBMITTABLE" });
    const plan = await planRepository.getById(planId); const policy = plan.desiredState?.approvalPolicy || {}; await audit(actor, "EXECUTION_PLAN_SUBMITTED", planId, "marketing_execution_plan", { planId, version, fingerprint: fp, approvalExpiry: packet.expiresAt, requiredApprovalCount: Math.max(1, Number(policy.requiredApprovals) || 1), requiredApproverTier: policy.requiredTier || "ADMIN" }); await app.events?.emit("PLAN_SUBMITTED", { correlationId: actor.correlationId, planId, planVersion: version, status: "PENDING_APPROVAL", expiresAt: packet.expiresAt }, [plan.createdByAdminUserId]); await app.events?.emit("APPROVAL_REQUIRED", { correlationId: actor.correlationId, planId, requiredCount: Math.max(1, Number(policy.requiredApprovals) || 1), requiredTier: policy.requiredTier || "ADMIN", expiresAt: packet.expiresAt }, [plan.createdByAdminUserId]); return { plan: mapPlanSummary(plan), approvalRequirements: { requiredCount: Math.max(1, Number(policy.requiredApprovals) || 1), requiredTier: policy.requiredTier || "ADMIN", expiresAt: packet.expiresAt } };
  }

  async function recordApprovalDecision({ actor, id, input, decision }) {
    await authorize(actor, "APPROVER"); const allowed = decision === "APPROVED" ? ["expectedVersion", "fingerprint", "comment", "acknowledgements"] : ["expectedVersion", "fingerprint", "reason"]; queryValidator.body(input, allowed, ["expectedVersion", "fingerprint", ...(decision === "REJECTED" ? ["reason"] : [])]);
    const planId = queryValidator.uuid(id, "path.id"); const version = expectedVersion(input); const fp = queryValidator.fingerprint(input.fingerprint); const plan = await planRepository.getById(planId); if (!plan || !["PENDING_APPROVAL", "APPROVED"].includes(plan.status) || plan.version !== version || plan.validationFingerprint !== fp || plan.expiresAt <= new Date()) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "APPROVAL_PACKET_STALE" });
    const required = Math.max(1, Number(plan.desiredState?.approvalPolicy?.requiredApprovals) || 1); const allowAuthor = plan.desiredState?.approvalPolicy?.allowAuthorAsNonSoleApprover === true && required > 1; if (actor.id === plan.createdByAdminUserId && !allowAuthor) { app.metrics?.increment("selfApprovalViolations"); throw executionError("EXECUTION_SELF_APPROVAL_FORBIDDEN"); }
    const requiredTier = plan.desiredState?.approvalPolicy?.requiredTier || "ADMIN"; if ((TIER_RANK[actor.tier] || 0) < (TIER_RANK[requiredTier] || 0)) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "APPROVER_TIER_REQUIRED", requiredTier });
    const reason = queryValidator.textValue(input.reason || input.comment, `body.${decision === "REJECTED" ? "reason" : "comment"}`, { required: decision === "REJECTED", max: 2000 });
    let approval;
    try { approval = await app.client.marketingExecutionApproval.create({ data: { planId, planVersion: version, validationFingerprint: fp, decision, approverAdminUserId: actor.id, reason: reason || null, approvalScope: { provider: plan.platform, connectionId: plan.connectionId, currencyCode: plan.currencyCode, approverTier: actor.tier, acknowledgements: input.acknowledgements || {} }, decidedAt: new Date() } }); }
    catch (error) { if (error?.code === "P2002") throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "DUPLICATE_ACTIVE_APPROVAL" }); throw error; }
    const approvals = await app.client.marketingExecutionApproval.findMany({ where: { planId, planVersion: version, validationFingerprint: fp }, include: { events: { orderBy: { decidedAt: "asc" } } } }); const active = approvals.filter((item) => currentDecision(item) === "APPROVED" && item.approverAdminUserId !== plan.createdByAdminUserId); const thresholdMet = active.length >= required;
    const nextStatus = decision === "REJECTED" ? "CANCELLED" : thresholdMet ? "APPROVED" : "PENDING_APPROVAL"; await app.client.marketingExecutionPlan.updateMany({ where: { id: planId, version, status: { in: ["PENDING_APPROVAL", "APPROVED"] } }, data: { status: nextStatus } });
    const action = decision === "APPROVED" ? "EXECUTION_APPROVED" : "EXECUTION_REJECTED"; app.metrics?.increment(decision === "APPROVED" ? "approvals" : "rejections"); await audit(actor, action, planId, "marketing_execution_plan", { planId, version, fingerprint: fp, decision, reason, approverTier: actor.tier, decisionTimestamp: approval.decidedAt }); await app.events?.emit("APPROVAL_RECORDED", { correlationId: actor.correlationId, planId, planVersion: version, fingerprint: fp, decision, actorId: actor.id, approvalProgress: active.length, requiredCount: required, requiredTier }, [plan.createdByAdminUserId]);
    return { approval: { id: approval.id, decision, decidedAt: approval.decidedAt }, progress: { current: active.length, required, thresholdMet }, planStatus: nextStatus };
  }

  async function revokeApproval({ actor, id, input }) {
    await authorize(actor, "APPROVER"); queryValidator.body(input, ["expectedVersion", "fingerprint", "reason"], ["expectedVersion", "fingerprint", "reason"]); const planId = queryValidator.uuid(id, "path.id"); const version = expectedVersion(input); const fp = queryValidator.fingerprint(input.fingerprint); const reason = queryValidator.textValue(input.reason, "body.reason", { required: true, max: 2000 }); const plan = await planRepository.getById(planId);
    if (!plan || !["PENDING_APPROVAL", "APPROVED"].includes(plan.status) || plan.version !== version || plan.validationFingerprint !== fp) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "APPROVAL_PACKET_STALE" });
    const approval = plan.approvals.find((item) => item.approverAdminUserId === actor.id && item.planVersion === version && item.validationFingerprint === fp && currentDecision(item) === "APPROVED"); if (!approval) throw executionError("APPROVAL_NOT_ELIGIBLE", { reasonCode: "CURRENT_OWN_APPROVAL_REQUIRED" });
    const event = await app.client.marketingExecutionApprovalEvent.create({ data: { approvalId: approval.id, decision: "REVOKED", reason, decidedAt: new Date() } }); await app.client.marketingExecutionPlan.updateMany({ where: { id: planId, version, status: "APPROVED" }, data: { status: "PENDING_APPROVAL" } }); app.metrics?.increment("revocations"); await audit(actor, "EXECUTION_REVOKED", planId, "marketing_execution_plan", { decision: "REVOKED", reason, planId, version, fingerprint: fp, approverTier: actor.tier, decisionTimestamp: event.decidedAt }); await app.events?.emit("APPROVAL_RECORDED", { correlationId: actor.correlationId, planId, planVersion: version, fingerprint: fp, decision: "REVOKED", actorId: actor.id }, [plan.createdByAdminUserId]); return { approvalId: approval.id, decision: "REVOKED", planStatus: "PENDING_APPROVAL" };
  }

  async function queuePlan({ actor, planId, input = {} }) {
    await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion", "fingerprint", "trigger", "overrideId"], ["expectedVersion", "fingerprint"]); const id = queryValidator.uuid(planId, "path.id"); const version = expectedVersion(input); const fp = queryValidator.fingerprint(input.fingerprint); const overrideId = input.overrideId ? queryValidator.uuid(input.overrideId, "body.overrideId") : null; if (overrideId) await authorize(actor, "EMERGENCY_OPERATOR"); const config = readExecutionConfig(env); if (!config.enabled || !config.providers[(await app.client.marketingExecutionPlan.findUnique({ where: { id }, select: { platform: true } }))?.platform]) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "EFFECTIVE_EXECUTION_GATE_DISABLED" });
    const plan = await app.client.marketingExecutionPlan.findUnique({ where: { id }, include: { connection: true, approvals: { include: { events: true } } } }); if (!plan || !["APPROVED", "QUEUED"].includes(plan.status) || plan.version !== version || plan.validationFingerprint !== fp || plan.expiresAt <= new Date()) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "CURRENT_APPROVED_PACKET_REQUIRED" });
    const connectionWriteEnabled = await app.connectionPolicyResolver({ platform: plan.platform, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId }); if (!connectionWriteEnabled && !overrideId) throw executionError("AD_EXECUTION_DISABLED", { reasonCode: "CONNECTION_WRITE_GATE_DISABLED" });
    const capability = app.adapterRegistry.get(plan.platform)?.getCapabilities({ connection: plan.connection, accountExternalId: plan.accountExternalId, accountState: { status: plan.connection.status, validationStatus: plan.connection.validationStatus, accountRole: plan.connection.connectionMetadata?.accountRole, oauthScopes: plan.connection.connectionMetadata?.oauthScopes || [], accessTier: plan.connection.connectionMetadata?.accessTier, editReady: plan.connection.connectionMetadata?.editReady === true } });
    const result = await app.queueService.queue({ actor, planId: id, expectedVersion: version, fingerprint: fp, correlationId: actor.correlationId || null, overrideId, policyEvidence: { capabilityValid: capability?.configurationReady === true && capability?.accountReady === true && capability?.permissionReady === true, globalEnabled: config.enabled, providerEnabled: config.providers[plan.platform] === true, connectionWriteEnabled: connectionWriteEnabled || Boolean(overrideId) }, trigger: queryValidator.enumValue(input.trigger || "MANUAL", ["MANUAL", "SCHEDULED"], "body.trigger", true) }); return mapQueueResult(result);
  }

  async function createEmergencyOverride({ actor, input }) {
    await authorize(actor, "EMERGENCY_OPERATOR"); queryValidator.body(input, ["planId", "runId", "operationId", "allowedControls", "reason", "expiresAt"], ["planId", "allowedControls", "reason", "expiresAt"]);
    return app.emergencyOverrideService.create({ actor, correlationId: actor.correlationId || null, input: { planId: queryValidator.uuid(input.planId, "body.planId"), runId: input.runId ? queryValidator.uuid(input.runId, "body.runId") : null, operationId: input.operationId ? queryValidator.uuid(input.operationId, "body.operationId") : null, allowedControls: input.allowedControls, reason: queryValidator.textValue(input.reason, "body.reason", { required: true, min: 10, max: 2000 }), expiresAt: input.expiresAt } });
  }

  async function cancelPlan({ actor, id, input }) {
    await authorize(actor, "AUTHOR"); queryValidator.body(input, ["expectedVersion", "reason"], ["expectedVersion", "reason"]); const planId = queryValidator.uuid(id, "path.id"); const version = expectedVersion(input); const reason = queryValidator.textValue(input.reason, "body.reason", { required: true, max: 2000 });
    const outcome = await app.client.$transaction(async (tx) => {
      const plan = await tx.marketingExecutionPlan.findUnique({ where: { id: planId }, include: { runs: { include: { jobs: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" }, take: 1 } } });
      if (!plan || plan.version !== version || !["DRAFT", "VALIDATED", "PENDING_APPROVAL", "APPROVED", "QUEUED"].includes(plan.status)) throw executionError("EXECUTION_PLAN_CONFLICT", { reasonCode: "PLAN_NOT_CANCELLABLE" });
      const run = plan.runs[0]; const job = run?.jobs?.[0]; const requestedAt = new Date();
      if (!job) {
        await tx.marketingExecutionPlan.update({ where: { id: planId }, data: { status: "CANCELLED", updatedByAdminUserId: actor.id } });
        await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_PLAN_UPDATED", targetId: planId, targetType: "marketing_execution_plan", metadata: sanitizeExecutionEvent({ correlationId: actor.correlationId, previousState: plan.status, requestedState: "CANCELLED", outcome: "CANCELLED_NO_JOB", reason }) } });
        return { planId, status: "CANCELLED", cancellationStatus: "COMPLETED", jobId: null, recipients: [plan.createdByAdminUserId] };
      }
      if (job.status === "RUNNING") throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "RUNNING_JOB_CANNOT_BE_CANCELLED", compensationRequired: true });
      if (["PENDING", "RETRY_SCHEDULED"].includes(job.status) && !job.leaseOwner) {
        const changed = await tx.marketingExecutionJob.updateMany({ where: { id: job.id, status: job.status, leaseOwner: null }, data: { status: "CANCELLED", cancellationRequestedAt: requestedAt, cancellationRequestedByAdminUserId: actor.id, cancellationReason: reason, cancellationObservedAt: requestedAt, cancellationOutcome: "CANCELLED_BEFORE_CLAIM", completedAt: requestedAt, recoveryReason: "USER_CANCELLED" } });
        if (changed.count !== 1) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "JOB_STATE_CHANGED" });
        await tx.marketingExecutionRun.updateMany({ where: { id: run.id, status: "QUEUED" }, data: { status: "CANCELLED", completedAt: requestedAt } });
        await tx.marketingExecutionPlan.update({ where: { id: planId }, data: { status: "CANCELLED", updatedByAdminUserId: actor.id } });
        await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_PLAN_UPDATED", targetId: planId, targetType: "marketing_execution_plan", metadata: sanitizeExecutionEvent({ correlationId: actor.correlationId, runId: run.id, jobId: job.id, previousState: job.status, requestedState: "CANCELLED", outcome: "CANCELLED_BEFORE_CLAIM", reason, cancellationRequestedAt: requestedAt }) } });
        return { planId, status: "CANCELLED", cancellationStatus: "COMPLETED", jobId: job.id, recipients: [plan.createdByAdminUserId] };
      }
      if (job.status !== "CLAIMED" || !job.leaseOwner) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "JOB_NOT_CANCELLABLE" });
      const changed = await tx.marketingExecutionJob.updateMany({ where: { id: job.id, status: "CLAIMED", leaseOwner: job.leaseOwner, cancellationRequestedAt: null }, data: { cancellationRequestedAt: requestedAt, cancellationRequestedByAdminUserId: actor.id, cancellationReason: reason, cancellationOutcome: "REQUESTED" } });
      if (changed.count !== 1) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "CANCELLATION_REQUEST_RACE" });
      await tx.auditLog.create({ data: { adminUserId: actor.id, action: "EXECUTION_PLAN_UPDATED", targetId: planId, targetType: "marketing_execution_plan", metadata: sanitizeExecutionEvent({ correlationId: actor.correlationId, runId: run.id, jobId: job.id, previousState: "CLAIMED", requestedState: "CANCELLED", outcome: "CANCELLATION_REQUESTED_OWNER_MUST_OBSERVE", reason, cancellationRequestedAt: requestedAt }) } });
      return { planId, status: plan.status, cancellationStatus: "REQUESTED", jobId: job.id, recipients: [plan.createdByAdminUserId] };
    }, { isolationLevel: "Serializable" });
    app.metrics?.increment(outcome.cancellationStatus === "REQUESTED" ? "cancellationRequests" : "cancellations");
    await app.events?.emit(outcome.cancellationStatus === "REQUESTED" ? "JOB_CANCELLATION_REQUESTED" : "JOB_CANCELLED", { correlationId: actor.correlationId, planId: outcome.planId, jobId: outcome.jobId, status: outcome.cancellationStatus }, outcome.recipients);
    return outcome;
  }

  async function createCompensationDraft({ actor, planId, input }) {
    await authorize(actor, "AUTHOR");
    queryValidator.body(input, ["originalRunId", "originalOperationId", "reconciliationId", "reason", "safeAction", "proposedValues", "irreversibleWarning"], ["originalRunId", "originalOperationId", "reason", "safeAction", "irreversibleWarning"]);
    const plan = await app.reconciliationService.createCompensationDraft({ originalPlanId: queryValidator.uuid(planId, "path.id"), originalRunId: queryValidator.uuid(input.originalRunId, "body.originalRunId"), originalOperationId: queryValidator.uuid(input.originalOperationId, "body.originalOperationId"), reconciliationId: input.reconciliationId ? queryValidator.uuid(input.reconciliationId, "body.reconciliationId") : null, reason: queryValidator.textValue(input.reason, "body.reason", { required: true, min: 5, max: 2000 }), safeAction: sanitizeExecutionJson(input.safeAction, "intent"), proposedValues: input.proposedValues == null ? null : sanitizeExecutionJson(input.proposedValues, "intent"), irreversibleWarning: queryValidator.textValue(input.irreversibleWarning, "body.irreversibleWarning", { required: true, min: 5, max: 2000 }), actor });
    return mapPlanSummary(plan);
  }

  async function listRuns(rawQuery = {}) {
    const allowed = ["planId", "provider", "connectionId", "accountExternalId", "status", "workerState", "createdFrom", "createdTo", "startedFrom", "startedTo", "completedFrom", "completedTo", "reconciliationState", "relationship", "page", "limit", "sort", "sortDirection"];
    const paging = queryValidator.pagination(rawQuery, allowed); const where = {};
    if (rawQuery.planId) where.planId = queryValidator.uuid(rawQuery.planId, "query.planId");
    if (rawQuery.status) where.status = queryValidator.enumValue(rawQuery.status, ["QUEUED", "RUNNING", "PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "RECONCILING", "CANCELLED"], "query.status", true);
    const planWhere = {}; if (rawQuery.provider) planWhere.platform = queryValidator.enumValue(rawQuery.provider, PROVIDERS, "query.provider", true); if (rawQuery.connectionId) planWhere.connectionId = queryValidator.uuid(rawQuery.connectionId, "query.connectionId"); if (rawQuery.accountExternalId) planWhere.accountExternalId = queryValidator.textValue(rawQuery.accountExternalId, "query.accountExternalId", { max: 255 }); if (Object.keys(planWhere).length) where.plan = planWhere;
    for (const field of ["created", "started", "completed"]) { const from = queryValidator.dateValue(rawQuery[`${field}From`], `query.${field}From`); const to = queryValidator.dateValue(rawQuery[`${field}To`], `query.${field}To`); assertDateRange(from, to, `query.${field}From`); if (from || to) where[field === "created" ? "createdAt" : `${field}At`] = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) }; }
    if (rawQuery.workerState) where.jobs = { some: { status: queryValidator.enumValue(rawQuery.workerState, ["PENDING", "CLAIMED", "RUNNING", "RETRY_SCHEDULED", "SUCCEEDED", "FAILED", "DEAD_LETTER", "RECONCILING", "CANCELLED"], "query.workerState", true) } };
    if (rawQuery.reconciliationState) where.reconciliations = { some: { status: queryValidator.enumValue(rawQuery.reconciliationState, ["VERIFIED", "DRIFTED", "UNKNOWN", "EXTERNAL_CHANGE", "COMPENSATED"], "query.reconciliationState", true) } };
    if (rawQuery.relationship) { const relationship = queryValidator.enumValue(rawQuery.relationship, ["ORIGINAL", "COMPENSATION", "STANDALONE"], "query.relationship", true); if (relationship === "ORIGINAL") where.originalCompensations = { some: {} }; else if (relationship === "COMPENSATION") where.compensationLinks = { some: {} }; else Object.assign(where, { originalCompensations: { none: {} }, compensationLinks: { none: {} } }); }
    const include = { plan: { select: { platform: true, connectionId: true, accountExternalId: true } }, jobs: { orderBy: { createdAt: "desc" }, take: 10 }, operations: { orderBy: { createdAt: "asc" }, take: 50 }, reconciliations: { orderBy: { checkedAt: "desc" }, take: 20 }, reconciliationJobs: { orderBy: { createdAt: "desc" }, take: 20 }, _count: { select: { jobs: true, operations: true, reconciliations: true, reconciliationJobs: true } } };
    const [rows, total] = await Promise.all([app.client.marketingExecutionRun.findMany({ where, skip: paging.skip, take: paging.limit, orderBy: orderBy(RUN_SORTS, rawQuery.sort, paging.sortDirection), include }), app.client.marketingExecutionRun.count({ where })]); return pageResult(rows.map(mapRun), total, paging.page, paging.limit);
  }
  async function getRun({ id }) { const run = await app.client.marketingExecutionRun.findUnique({ where: { id: queryValidator.uuid(id, "path.id") }, include: { plan: true, jobs: { orderBy: { createdAt: "desc" }, take: 20 }, operations: { orderBy: { createdAt: "asc" }, take: 100, include: { attempts: { orderBy: { number: "desc" }, take: 10 }, item: true, snapshots: { orderBy: { sequence: "desc" }, take: 10 }, reconciliations: { include: { acknowledgments: { take: 10 } }, orderBy: { checkedAt: "desc" }, take: 10 }, retryReviews: { orderBy: { createdAt: "desc" }, take: 10 }, _count: { select: { attempts: true, snapshots: true, reconciliations: true, retryReviews: true } } } }, reconciliations: { include: { acknowledgments: { take: 10 } }, orderBy: { checkedAt: "desc" }, take: 50 }, reconciliationJobs: { orderBy: { createdAt: "desc" }, take: 50 }, originalCompensations: { take: 20 }, compensationLinks: { take: 20 }, _count: { select: { jobs: true, operations: true, reconciliations: true, reconciliationJobs: true, originalCompensations: true, compensationLinks: true } } } }); if (!run) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "EXECUTION_RUN_NOT_FOUND" }); return mapRun(run); }
  async function getOperation({ id }) { const operation = await app.client.marketingProviderOperation.findUnique({ where: { id: queryValidator.uuid(id, "path.id") }, include: { item: true, attempts: { orderBy: { number: "desc" }, take: 25 }, snapshots: { orderBy: [{ kind: "asc" }, { sequence: "desc" }], take: 20 }, reconciliations: { include: { acknowledgments: { take: 10 } }, orderBy: { checkedAt: "desc" }, take: 25 }, retryReviews: { orderBy: { createdAt: "desc" }, take: 25 }, run: { include: { plan: true } }, _count: { select: { attempts: true, snapshots: true, reconciliations: true, retryReviews: true } } } }); if (!operation) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "OPERATION_NOT_FOUND" }); return mapOperationDetail(operation); }

  async function retryOperation({ actor, id, input }) { safeActor(actor); queryValidator.body(input, ["reason"], ["reason"]); const operationId = queryValidator.uuid(id, "path.id"); const reason = queryValidator.textValue(input.reason, "body.reason", { required: true, min: 5, max: 2000 }); return app.retryReviewService.schedule({ operationId, actor, reason, correlationId: actor.correlationId }); }

  async function listDrift(rawQuery = {}) { const allowed = ["provider", "connectionId", "accountExternalId", "planId", "runId", "operationId", "classification", "acknowledged", "severity", "createdFrom", "createdTo", "unresolved", "page", "limit", "sort", "sortDirection"]; const paging = queryValidator.pagination(rawQuery, allowed); const where = {}; if (rawQuery.runId) where.runId = queryValidator.uuid(rawQuery.runId, "query.runId"); if (rawQuery.operationId) where.operationId = queryValidator.uuid(rawQuery.operationId, "query.operationId"); if (rawQuery.classification) where.status = queryValidator.enumValue(rawQuery.classification, ["VERIFIED", "DRIFTED", "UNKNOWN", "EXTERNAL_CHANGE", "COMPENSATED"], "query.classification", true); if (rawQuery.unresolved === "true") where.status = { in: ["DRIFTED", "UNKNOWN", "EXTERNAL_CHANGE"] }; if (rawQuery.acknowledged != null) where.acknowledgments = queryValidator.boolValue(rawQuery.acknowledged, "query.acknowledged") ? { some: {} } : { none: {} }; if (rawQuery.planId || rawQuery.provider || rawQuery.connectionId || rawQuery.accountExternalId) where.run = { plan: { ...(rawQuery.planId ? { id: queryValidator.uuid(rawQuery.planId, "query.planId") } : {}), ...(rawQuery.provider ? { platform: queryValidator.enumValue(rawQuery.provider, PROVIDERS, "query.provider", true) } : {}), ...(rawQuery.connectionId ? { connectionId: queryValidator.uuid(rawQuery.connectionId, "query.connectionId") } : {}), ...(rawQuery.accountExternalId ? { accountExternalId: queryValidator.textValue(rawQuery.accountExternalId, "query.accountExternalId", { max: 255 }) } : {}) } }; const [rows, total] = await Promise.all([app.client.marketingExecutionReconciliation.findMany({ where, skip: paging.skip, take: paging.limit, orderBy: orderBy(DRIFT_SORTS, rawQuery.sort, paging.sortDirection, "checkedAt"), include: { acknowledgments: { orderBy: { createdAt: "asc" } } } }), app.client.marketingExecutionReconciliation.count({ where })]); return pageResult(rows.map(mapDrift), total, paging.page, paging.limit); }
  async function acknowledgeDrift({ actor, id, input }) { safeActor(actor); queryValidator.body(input, ["reason"], ["reason"]); const reconciliationId = queryValidator.uuid(id, "path.id"); const reason = queryValidator.textValue(input.reason, "body.reason", { required: true, min: 3, max: 2000 }); const incident = await app.client.marketingExecutionReconciliation.findUnique({ where: { id: reconciliationId } }); if (!incident || !["DRIFTED", "UNKNOWN", "EXTERNAL_CHANGE"].includes(incident.status)) throw executionError("EXECUTION_RECONCILIATION_DRIFT", { reasonCode: "ACKNOWLEDGEABLE_INCIDENT_REQUIRED" }); const acknowledgment = await app.client.marketingExecutionDriftAcknowledgment.create({ data: { reconciliationId, acknowledgedByAdminUserId: actor.id, reason } }); await audit(actor, "EXECUTION_DRIFT_ACKNOWLEDGED", reconciliationId, "marketing_execution_reconciliation", { reason, classification: incident.status }); return mapDrift(await app.client.marketingExecutionReconciliation.findUnique({ where: { id: reconciliationId }, include: { acknowledgments: { orderBy: { createdAt: "asc" } } } })); }

  async function convertRecommendation({ actor, recommendationId }) { safeActor(actor); const value = await app.recommendationBridge.createDraft({ actor, recommendationId: queryValidator.textValue(recommendationId, "path.id", { required: true, max: 255 }) }); return { created: value.created, plan: mapPlanSummary(value.plan) }; }
  async function createCreativePublication({ actor, creativeId, input, media }) { const value = await app.creativeService.createRevision({ actor: safeActor(actor), input: { ...input, creativeAssetId: queryValidator.textValue(creativeId, "path.id", { required: true, max: 255 }) }, media }); return value; }
  async function listCreativePublications({ actor, creativeId, query }) { const allowed = ["provider", "connectionId", "accountExternalId", "format", "reviewStatus", "reuseClassification", "revision", "createdFrom", "createdTo", "page", "limit", "sortDirection"]; const paging = queryValidator.pagination(query, allowed); const where = {}; if (query.provider) where.platform = queryValidator.enumValue(query.provider, PROVIDERS, "query.provider", true); if (query.connectionId) where.connectionId = queryValidator.uuid(query.connectionId, "query.connectionId"); if (query.accountExternalId) where.accountExternalId = queryValidator.textValue(query.accountExternalId, "query.accountExternalId", { max: 255 }); if (query.format) where.creativeFormat = queryValidator.textValue(query.format, "query.format", { max: 100 }); if (query.reviewStatus) where.reviewStatus = queryValidator.textValue(query.reviewStatus, "query.reviewStatus", { max: 100 }).toUpperCase(); if (query.reuseClassification) where.reuseClassification = queryValidator.textValue(query.reuseClassification, "query.reuseClassification", { max: 100 }).toUpperCase(); if (query.revision) where.revision = queryValidator.intValue(query.revision, "query.revision", { min: 1 }); const createdFrom = queryValidator.dateValue(query.createdFrom, "query.createdFrom"); const createdTo = queryValidator.dateValue(query.createdTo, "query.createdTo"); assertDateRange(createdFrom, createdTo, "query.createdFrom"); if (createdFrom || createdTo) where.createdAt = { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) }; const result = await app.creativeService.list({ actor, creativeAssetId: queryValidator.textValue(creativeId, "path.id", { required: true, max: 255 }), where, skip: paging.skip, take: paging.limit, sortDirection: paging.sortDirection }); return pageResult(result.rows.map((row) => mapCreativePublication(row)), result.total, paging.page, paging.limit); }
  async function health(rawQuery = {}) { if (!healthService) throw executionError("INVALID_EXECUTION_CONFIG", { reasonCode: "HEALTH_SERVICE_UNAVAILABLE" }); queryValidator.body(rawQuery, ["provider", "connectionId"]); return healthService.snapshot({ provider: rawQuery.provider ? queryValidator.enumValue(rawQuery.provider, PROVIDERS, "query.provider", true) : null, connectionId: rawQuery.connectionId ? queryValidator.uuid(rawQuery.connectionId, "query.connectionId") : null }); }

  async function getCreativePublication({ actor, id }) { return app.creativeService.getById({ actor, id }); }
  async function syncCreativeReview({ actor, id }) { await app.creativeService.getById({ actor, id }); await app.reviewSyncService.sync(id); return app.creativeService.getById({ actor, id }); }
  async function getRunStatus({ runId }) { return getRun({ id: runId }); }
  async function reviewDeadLetter({ actor, jobId, input }) { return mapDeadLetterResult(await app.deadLetterReviewService.review({ actor, jobId, ...input })); }
  async function getReconciliationStatus({ id }) { const value = await app.client.marketingExecutionReconciliationJob.findUnique({ where: { id }, include: { operation: true } }); if (!value) throw executionError("INVALID_EXECUTION_PLAN", { reasonCode: "RECONCILIATION_JOB_NOT_FOUND" }); return value; }

  return { capabilities, lifecycle, preflight, runIsolatedContexts, listPolicies, updatePolicy, createEmergencyOverride, createPlan, listPlans, getPlan, updatePlan, deletePlan, validatePlan, submitPlan, approvePlan: (args) => recordApprovalDecision({ ...args, decision: "APPROVED" }), rejectPlan: (args) => recordApprovalDecision({ ...args, decision: "REJECTED" }), revokeApproval, queuePlan, cancelPlan, createCompensationDraft, listRuns, getRun, getRunStatus, getOperation, retryOperation: async (args) => { await authorize(args.actor, "EXECUTION_ADMIN"); return retryOperation(args); }, listDrift, acknowledgeDrift: async (args) => { await authorize(args.actor, "EXECUTION_ADMIN"); return acknowledgeDrift(args); }, convertRecommendation: async (args) => { await authorize(args.actor, "AUTHOR"); return convertRecommendation(args); }, createCreativePublication: async (args) => { await authorize(args.actor, "AUTHOR"); return createCreativePublication(args); }, listCreativePublications, health, getCreativePublication, syncCreativeReview, reviewDeadLetter, getReconciliationStatus };
}

module.exports = { createExecutionService, currentDecision, pageResult };

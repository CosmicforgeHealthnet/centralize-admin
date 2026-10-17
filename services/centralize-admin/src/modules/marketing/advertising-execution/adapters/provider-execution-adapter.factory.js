const crypto = require("crypto");
const { assertExecutionAdapter } = require("./execution-adapter.interface");
const { createStructuralCapability } = require("../capabilities/capability-result");
const { validateCampaignDto } = require("../campaigns/campaign.validator");
const { validateHierarchy } = require("../campaigns/hierarchy.validator");
const { assertImmutableFields } = require("../campaigns/immutable-field-policy");
const { createStatusOperation } = require("../campaigns/status-operation.service");
const { hashExecutionJson, canonicalJson, sanitizeExecutionJson } = require("../execution-json.validator");
const { executionError } = require("../execution.errors");
const { createNormalizedResult, normalizeContractError } = require("../operations/normalized-result");
const { VERSION_ENV_KEYS, isProviderVersionSupported } = require("../execution.config");
const { convertProviderBudget } = require("../budgets/provider-budget-units");
const { decimal } = require("../budgets/money");
const { resolveTargetingCriteria } = require("../targeting/targeting.validator");
const { normalizeProviderError } = require("./provider-error-normalizer");
const { createNetworkGuard } = require("./provider-network.policy");

function configuredVersion(definition, env) {
  const value = String(env[VERSION_ENV_KEYS[definition.provider]] || "").trim();
  return isProviderVersionSupported(definition.provider, value) ? value : null;
}

function safeAccountState(context = {}) {
  const state = context.accountState || {};
  const scopes = Array.isArray(state.oauthScopes) ? state.oauthScopes.map(String) : [];
  return {
    role: String(state.accountRole || "UNKNOWN").toUpperCase(),
    scopes,
    accessTier: String(state.accessTier || "UNKNOWN").toUpperCase(),
    editReady: state.editReady === true,
    pageIdentityReady: state.pageIdentityReady === true,
    instagramIdentityReady: state.instagramIdentityReady === true,
    sparkAuthorized: state.sparkAuthorized === true,
    placementAllowlisted: state.placementAllowlisted === true,
    fundingInstrumentReady: state.fundingInstrumentReady === true,
    providerLimits: state.providerLimits && typeof state.providerLimits === "object" ? sanitizeExecutionJson(state.providerLimits, "summary") : {},
    placementAllowlist: Array.isArray(state.placementAllowlist) ? state.placementAllowlist.map((value) => String(value).toUpperCase()).slice(0, 100) : [],
  };
}

function capabilityFor(definition, context, env) {
  const version = configuredVersion(definition, env);
  const state = safeAccountState(context);
  const scopeReady = definition.requiredScopes.every((scope) => state.scopes.includes(scope));
  const roleReady = definition.eligibleRoles.includes(state.role);
  const hasConnection = Boolean(context.connection?.id);
  const accountMatches = hasConnection && context.connection?.accountId === context.accountExternalId;
  const operationSupported = (!context.campaignType || definition.campaignTypes.includes(context.campaignType))
    && (!context.operationType || definition.operationTypes.includes(context.operationType))
    && (!context.resourceType || definition.resourceTypes.includes(context.resourceType));
  const permissionReady = scopeReady && roleReady && state.editReady;
  const blockers = [];
  if (!version) blockers.push("PROVIDER_API_VERSION_REQUIRED");
  if (!hasConnection) blockers.push("CONNECTION_NOT_FOUND");
  if (hasConnection && !accountMatches) blockers.push("ACCOUNT_CONTEXT_MISMATCH");
  if (!scopeReady) blockers.push("REQUIRED_OAUTH_SCOPE_MISSING");
  if (!roleReady) blockers.push("ACCOUNT_ROLE_INELIGIBLE");
  if (!state.editReady) blockers.push("ACCOUNT_EDIT_PERMISSION_UNAVAILABLE");
  if (!operationSupported) blockers.push("CAMPAIGN_TYPE_UNSUPPORTED");
  if (context.unavailableReason) blockers.push(context.unavailableReason);
  return createStructuralCapability({
    provider: definition.provider,
    apiVersion: version || "CONFIG_REQUIRED",
    connectionId: context.connection?.id || null,
    accountExternalId: context.accountExternalId || null,
    accountCurrency: context.connection?.currency || null,
    supportedOperationTypes: definition.operationTypes,
    supportedResourceTypes: definition.resourceTypes,
    supportedCampaignTypes: definition.campaignTypes,
    budgetUnitSemantics: definition.budgetUnitSemantics,
    dryRunAvailable: true,
    nativeValidationAvailable: definition.nativeValidationAvailable,
    atomicity: definition.atomicity,
    idempotency: definition.idempotency,
    permissionState: permissionReady ? "AVAILABLE" : "MISSING",
    configurationReady: Boolean(version),
    authenticationReady: scopeReady,
    permissionReady,
    accountReady: accountMatches,
    operationSupported,
    unavailableReason: blockers[0] || "CONNECTION_WRITE_DISABLED",
    accountRestrictions: [...new Set(blockers)],
    warnings: ["LIVE_WRITES_REMAIN_DISABLED"],
    immutableFields: definition.immutableFields,
    providerDetails: {
      ...definition.details,
      requiredScopes: definition.requiredScopes,
      eligibleRoles: definition.eligibleRoles,
      objectives: definition.objectives,
      placements: definition.placements,
      accountRole: state.role,
      accessTier: state.accessTier,
      accountEditReady: state.editReady,
      pageIdentityReady: state.pageIdentityReady,
      instagramIdentityReady: state.instagramIdentityReady,
      sparkAuthorized: state.sparkAuthorized,
      placementAllowlisted: state.placementAllowlisted,
      fundingInstrumentReady: state.fundingInstrumentReady,
      providerLimits: state.providerLimits,
      placementAllowlist: state.placementAllowlist,
    },
  });
}

function providerSpecificValidation(definition, plan) {
  const campaign = plan.campaign;
  if (!definition.objectives.includes(campaign.objective)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, field: "objective", objective: campaign.objective });
  const compatibility = definition.biddingCompatibility?.[campaign.objective];
  if (compatibility && campaign.bidding.optimizationGoal && !compatibility.optimizationGoals.includes(campaign.bidding.optimizationGoal)) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, field: "bidding.optimizationGoal", reasonCode: "INCOMPATIBLE_OPTIMIZATION_GOAL" });
  }
  if (compatibility && campaign.bidding.billingEvent && !compatibility.billingEvents.includes(campaign.bidding.billingEvent)) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, field: "bidding.billingEvent", reasonCode: "INCOMPATIBLE_BILLING_EVENT" });
  }
  for (const item of plan.items || []) {
    if (Object.keys(item.intent || {}).some((key) => /^(?:providerAmount|providerAmounts|amountMicros|budgetMicros|bidMicros)$/i.test(key))) {
      throw executionError("RAW_PROVIDER_PAYLOAD_FORBIDDEN", { field: `items.${item.clientReference}.intent`, reasonCode: "PRECONVERTED_PROVIDER_UNITS_FORBIDDEN" });
    }
  }
  if (definition.provider === "GOOGLE_ADS") {
    const declaration = campaign.declarations.euPoliticalAdvertising;
    if (declaration !== "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING") throw executionError("INVALID_EXECUTION_PLAN", { field: "declarations.euPoliticalAdvertising", reasonCode: declaration ? "POLITICAL_ADVERTISING_UNSUPPORTED" : "EU_POLITICAL_DECLARATION_REQUIRED" });
  }
  if (definition.provider === "META" && ![undefined, null, "NONE"].includes(campaign.declarations.specialAdCategory)) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "META", field: "declarations.specialAdCategory", reasonCode: "REGULATED_SPECIAL_CATEGORY_UNSUPPORTED" });
  }
  if (definition.provider === "META") {
    const createsCreative = (plan.items || []).some((item) => ["CREATIVE", "AD"].includes(item.resourceType) && item.operationType === "CREATE");
    if (createsCreative && !plan.accountState?.pageIdentityReady) throw executionError("EXECUTION_PROVIDER_PERMISSION_ERROR", { provider: "META", reasonCode: "PAGE_IDENTITY_OWNERSHIP_REQUIRED" });
    if (campaign.networkOrPlacements.some((placement) => placement.startsWith("INSTAGRAM")) && !plan.accountState?.instagramIdentityReady) throw executionError("EXECUTION_PROVIDER_PERMISSION_ERROR", { provider: "META", reasonCode: "INSTAGRAM_IDENTITY_OWNERSHIP_REQUIRED" });
  }
  if (definition.provider === "TIKTOK") {
    if (plan.smartPlus || plan.reachAndFrequency) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "TIKTOK", reasonCode: "AUTOMATED_CAMPAIGN_FAMILY_UNSUPPORTED" });
    if (plan.sparkAd && !plan.accountState?.sparkAuthorized) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "TIKTOK", reasonCode: "SPARK_AUTHORIZATION_REQUIRED" });
    if (plan.requiresAllowlistedPlacement && !plan.accountState?.placementAllowlisted) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "TIKTOK", reasonCode: "PLACEMENT_ALLOWLIST_REQUIRED" });
  }
  if (definition.provider === "LINKEDIN" && (plan.targeting || []).some((criterion) => criterion.protectedCharacteristic === true)) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "LINKEDIN", reasonCode: "DISCRIMINATORY_TARGETING_FORBIDDEN" });
  }
  if (definition.provider === "LINKEDIN" && plan.accountState?.accessTier === "DEVELOPMENT" && plan.accountState?.editReady !== true) throw executionError("EXECUTION_PROVIDER_PERMISSION_ERROR", { provider: "LINKEDIN", reasonCode: "DEVELOPMENT_TIER_ACCOUNT_NOT_ALLOWLISTED" });
  if (definition.provider === "LINKEDIN") {
    const campaignFormat = String(plan.campaignFormat || "SINGLE_IMAGE").toUpperCase();
    if (!definition.details.supportedFormats.includes(campaignFormat)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "LINKEDIN", field: "campaignFormat", reasonCode: "UNSUPPORTED_CREATIVE_FORMAT" });
    const incompatible = (plan.items || []).find((item) => item.resourceType === "CREATIVE" && item.intent?.format && String(item.intent.format).toUpperCase() !== campaignFormat);
    if (incompatible) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "LINKEDIN", field: `items.${incompatible.clientReference}.intent.format`, reasonCode: "CAMPAIGN_CREATIVE_FORMAT_MISMATCH" });
  }
  if (definition.provider === "X" && (plan.items || []).some((item) => item.resourceType === "FUNDING_INSTRUMENT" && item.operationType !== "READ")) {
    throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "X", reasonCode: "FUNDING_INSTRUMENT_READ_ONLY" });
  }
  if (definition.provider === "X") {
    const limits = plan.providerLimits || plan.accountState?.providerLimits || {};
    for (const item of plan.items || []) {
      const amount = item.intent?.dailyBudget ?? item.intent?.totalBudget ?? item.intent?.budget ?? item.intent?.amount;
      const cap = item.resourceType === "CAMPAIGN" ? limits.campaignBudgetMaximum : item.resourceType === "GROUP" ? limits.lineItemBudgetMaximum : null;
      if (amount != null && cap != null && decimal(amount, { currency: plan.currencyCode }).greaterThan(decimal(cap, { currency: plan.currencyCode }))) {
        throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "X", field: `items.${item.clientReference}.intent`, reasonCode: item.resourceType === "GROUP" ? "LINE_ITEM_PARENT_BUDGET_EXCEEDED" : "CAMPAIGN_BUDGET_LIMIT_EXCEEDED" });
      }
      if (item.intent?.bidAmount != null && limits.bidMaximum != null && decimal(item.intent.bidAmount, { currency: plan.currencyCode }).greaterThan(decimal(limits.bidMaximum, { currency: plan.currencyCode }))) {
        throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: "X", field: `items.${item.clientReference}.intent.bidAmount`, reasonCode: "BID_LIMIT_EXCEEDED" });
      }
    }
  }
}

function buildTransportInstruction(definition, item, plan, index) {
  const googleCollections = { BUDGET: "campaignBudgets", CAMPAIGN: "campaigns", GROUP: "adGroups", TARGETING: item.intent?.scope === "AD_GROUP" ? "adGroupCriteria" : "campaignCriteria", CREATIVE: "assets", AD: "adGroupAds", ASSET_LINK: "campaignAssets" };
  const instruction = {
    provider: definition.provider,
    apiVersion: plan.apiVersion,
    sequence: index,
    operationType: item.operationType,
    resourceType: item.resourceType,
    resourceId: item.providerResourceId || null,
    temporaryResourceName: item.operationType === "CREATE" ? (definition.provider === "GOOGLE_ADS" ? `customers/${plan.accountExternalId}/${googleCollections[item.resourceType] || "resources"}/-${index + 1}` : `${definition.provider.toLowerCase()}:temporary:${item.clientReference || index}`) : null,
    fields: { ...item.intent },
  };
  if (item.operationType === "CREATE") instruction.createStatus = "PAUSED";
  const monetaryFields = ["amount", "dailyBudget", "lifetimeBudget", "totalBudget", "budget", "bidAmount"];
  const providerAmounts = Object.fromEntries(monetaryFields.filter((field) => item.intent?.[field] !== undefined).map((field) => [field, convertProviderBudget(definition.provider, item.intent[field], { currency: plan.currencyCode })]));
  if (Object.keys(providerAmounts).length) instruction.fields.providerAmounts = providerAmounts;
  if (item.resourceType === "BUDGET" && item.intent?.amount !== undefined) instruction.fields.providerAmount = providerAmounts.amount;
  if (definition.provider === "GOOGLE_ADS") Object.assign(instruction, { validateOnly: true, partialFailure: false });
  if (definition.provider === "LINKEDIN") instruction.headers = { "Linkedin-Version": plan.apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
  return instruction;
}

function deterministicGraph(definition, plan) {
  const ordered = validateHierarchy(plan.items || [], { provider: definition.provider, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId });
  return ordered.map((item, index) => {
    const transportInstruction = buildTransportInstruction(definition, item, plan, index);
    return Object.freeze({
      providerOperationKey: item.providerOperationKey || crypto.createHash("sha256").update(`${plan.id || plan.planNumber}:${item.clientReference}:${index}`).digest("hex"),
      sequence: index,
      itemId: item.id || null,
      clientReference: item.clientReference,
      operationType: item.operationType,
      resourceType: item.resourceType,
      dependsOn: item.dependsOn || [],
      materialHash: hashExecutionJson(transportInstruction, "intent").hash,
      transportInstruction,
    });
  });
}

function assertExecutionContext(context = {}) {
  if (!context.globalEnabled || !context.workerEnabled || !context.providerEnabled || !context.connectionWriteEnabled) throw executionError("EXECUTION_DISABLED", { reasonCode: "WRITE_GATE_DISABLED" });
  if (context.dryRun !== false) throw executionError("EXECUTION_DISABLED", { reasonCode: "DRY_RUN_BLOCKS_PROVIDER_MUTATION" });
  if (!context.permissionReady) throw executionError("EXECUTION_PROVIDER_PERMISSION_ERROR");
  if (!context.approvalFingerprintCurrent || !context.planVersionCurrent) throw executionError("STALE_VALIDATION_FINGERPRINT");
  if (!context.preconditionsCurrent) throw executionError("EXECUTION_PRECONDITION_CHANGED");
  if (!context.accountLockOwned || !context.jobLeaseOwned || !context.idempotencyIdentityValid) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "MUTATION_OWNERSHIP_OR_IDEMPOTENCY_INVALID" });
}

function classifyProviderError(definition, error = {}) {
  const stable = normalizeProviderError(error, { provider: definition.provider, observedAt: new Date(error.observedAt || Date.now()) });
  const status = error.statusCode || error.response?.status;
  const kind = String(error.kind || error.category || "").toLowerCase();
  const permission = [401, 403].includes(status) || /permission|auth/.test(kind);
  const validation = status === 400 || /validation|policy/.test(kind);
  const rateLimit = status === 429 || /rate/.test(kind);
  const retryAfterHeader = error.response?.headers?.["retry-after"] ?? error.response?.headers?.get?.("retry-after");
  let retryAfterAt = error.retryAfterAt || null;
  if (!retryAfterAt && retryAfterHeader != null) {
    if (/^\d+$/.test(String(retryAfterHeader))) retryAfterAt = new Date(new Date(error.observedAt || Date.now()).getTime() + Number(retryAfterHeader) * 1000).toISOString();
    else if (Number.isFinite(new Date(retryAfterHeader).getTime())) retryAfterAt = new Date(retryAfterHeader).toISOString();
  }
  return normalizeContractError({
    code: stable.code || (permission ? "EXECUTION_PROVIDER_PERMISSION_ERROR" : validation ? "EXECUTION_VALIDATION_FAILED" : rateLimit ? "EXECUTION_PROVIDER_RATE_LIMITED" : "PROVIDER_OPERATION_FAILED"),
    category: stable.category || (permission ? "PERMISSION" : validation ? "VALIDATION" : rateLimit ? "RATE_LIMIT" : "PROVIDER"),
    message: stable.message || `${definition.provider} operation failed`,
    retryable: stable.retryable === true,
    retryAfterAt: stable.retryAfterAt || retryAfterAt,
    providerCode: stable.errors?.[0]?.providerCode || error.providerCode || null,
    fieldPath: error.fieldPath || null,
  });
}

function createProviderExecutionAdapter(definition, { env = process.env, clientFactory = null, credentialResolver = null, targetingResolver = null, creativePublicationResolver = null, allowProviderValidation = false } = {}) {
  const version = configuredVersion(definition, env);
  const networkGuard = createNetworkGuard({ provider: definition.provider, timeoutMs: 10000, maximumResponseBytes: 256 * 1024 });
  async function clientFor(context) {
    if (!clientFactory) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, reasonCode: "INJECTED_PROVIDER_CLIENT_REQUIRED" });
    const credentials = credentialResolver ? await credentialResolver(context.connection) : null;
    return clientFactory({ provider: definition.provider, apiVersion: version, accountExternalId: context.accountExternalId, credentials, networkPolicy: networkGuard });
  }
  const adapter = {
    provider: definition.provider,
    metadata: Object.freeze({ status: "IMPLEMENTED_WRITE_GATED", apiVersion: version || "CONFIG_REQUIRED", writeCapable: false, networkPolicyApplied: true, supportedMethods: Object.freeze(["getCapabilities", "validatePlan", "buildOperations", "previewOperation", "executeOperation", "verifyOperation", "compensateOperation", "classifyError"]) }),
    getCapabilities: (context = {}) => capabilityFor(definition, context, env),
    validatePlan: async ({ plan, connection, accountState, dryRun = true }) => {
      if (!version) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, reasonCode: "PROVIDER_API_VERSION_REQUIRED" });
      const campaign = validateCampaignDto(plan.campaign || plan.desiredState?.campaign || plan, { provider: definition.provider, resolvedReferences: (plan.items || []).map((item) => item.clientReference), supportedPlacements: definition.placements });
      const normalized = { ...sanitizeExecutionJson(plan, "desiredState"), campaign, apiVersion: version, accountState: safeAccountState({ accountState }) };
      providerSpecificValidation(definition, normalized);
      if (Array.isArray(plan.targeting) && plan.targeting.length) normalized.targeting = await resolveTargetingCriteria(plan.targeting, { provider: definition.provider, apiVersion: version, connectionId: plan.connectionId, accountExternalId: plan.accountExternalId, resolver: targetingResolver, objective: campaign.objective, creativeFormat: plan.creativeFormat, accountPlacementAllowlist: normalized.accountState.placementAllowlist, advertisingCategory: plan.advertisingCategory || "GENERAL" });
      const publicationReferences = (plan.items || []).filter((item) => item.intent?.creativePublicationId);
      if (publicationReferences.length) {
        if (typeof creativePublicationResolver !== "function") throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, reasonCode: "CREATIVE_PUBLICATION_RESOLVER_REQUIRED" });
        normalized.creativePublications = [];
        for (const item of publicationReferences) {
          const publication = await creativePublicationResolver(item.intent.creativePublicationId);
          if (!publication || publication.platform !== definition.provider || publication.connectionId !== plan.connectionId || publication.accountExternalId !== plan.accountExternalId || publication.reviewStatus !== "APPROVED") throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { provider: definition.provider, field: `items.${item.clientReference}.intent.creativePublicationId`, reasonCode: "CREATIVE_PUBLICATION_NOT_APPROVED" });
          if (item.intent.contentHash && item.intent.contentHash !== publication.contentHash) throw executionError("EXECUTION_PRECONDITION_CHANGED", { reasonCode: "CREATIVE_PUBLICATION_REVISION_CHANGED" });
          normalized.creativePublications.push({ id: publication.id, revision: publication.revision, contentHash: publication.contentHash, reviewStatus: publication.reviewStatus, providerReusePolicy: publication.publicationMetadata?.providerReusePolicy || "RECREATE_REQUIRED" });
        }
      }
      if (plan.currentState && plan.requestedState) assertImmutableFields({ provider: definition.provider, current: plan.currentState, requested: plan.requestedState });
      const graph = deterministicGraph(definition, normalized);
      if (allowProviderValidation && plan.providerValidationRequested) {
        const client = await clientFor({ connection, accountExternalId: plan.accountExternalId });
        await client.validateGraph({ operations: graph.map((entry) => entry.transportInstruction), validateOnly: definition.provider === "GOOGLE_ADS", partialFailure: false, dryRun, networkPolicy: networkGuard });
      }
      return { ...normalized, operationGraph: graph, operationGraphHash: crypto.createHash("sha256").update(canonicalJson(graph.map(({ transportInstruction, ...safe }) => safe))).digest("hex") };
    },
    buildOperations: ({ validatedPlan }) => validatedPlan.operationGraph || deterministicGraph(definition, validatedPlan),
    previewOperation: ({ operation }) => ({ provider: definition.provider, operationType: operation.operationType, resourceType: operation.resourceType, sequence: operation.sequence, materialHash: operation.materialHash, status: "PREVIEWED", mutatesProvider: false }),
    executeOperation: async ({ operation = {}, idempotencyKey, expectedState } = {}) => {
      assertExecutionContext(operation.executionContext);
      const client = await clientFor(operation.executionContext);
      try {
        const response = await client.execute({ operation: operation.transportInstruction, idempotencyKey, expectedState, networkPolicy: networkGuard });
        return createNormalizedResult({ status: response.outcomeCertain === false ? "UNKNOWN" : "SUCCEEDED", providerRequestId: response.requestId, nativeResourceId: response.resourceId, nativeResourceName: response.resourceName, outcomeCertain: response.outcomeCertain !== false, returnedState: response.returnedState || {}, warnings: response.warnings || [], error: response.outcomeCertain === false ? { code: "OUTCOME_UNKNOWN", category: "UNKNOWN", message: "Provider outcome requires read-back", retryable: false } : null });
      } catch (error) {
        const normalized = classifyProviderError(definition, error);
        return createNormalizedResult({ status: error.outcomeUnknown ? "UNKNOWN" : "FAILED", outcomeCertain: !error.outcomeUnknown, retryable: normalized.retryable, error: normalized });
      }
    },
    verifyOperation: async ({ operation, providerResult }) => {
      if (providerResult?.status !== "SUCCEEDED") return { status: "UNKNOWN", readBackRequired: true, retryAllowed: false };
      const client = await clientFor(operation.executionContext || {});
      const afterState = sanitizeExecutionJson(await client.readBack({ operation: operation.transportInstruction, providerResult, networkPolicy: networkGuard }), "normalizedState");
      const desired = operation.transportInstruction?.fields || {};
      const matches = Object.entries(desired).every(([key, value]) => canonicalJson(afterState[key]) === canonicalJson(value));
      return { status: matches ? "VERIFIED" : "DRIFTED", afterState, readBackRequired: true, retryAllowed: false };
    },
    compensateOperation: ({ operation, beforeState, reason }) => ({ action: "PAUSE", statusOperation: createStatusOperation({ type: "PAUSE", resourceType: operation.resourceType, resourceId: operation.nativeResourceId || operation.providerResourceId, beforeState, exposure: null }), reason, deletionPromised: false, separateApprovalRequired: true }),
    classifyError: ({ error } = {}) => classifyProviderError(definition, error),
  };
  return Object.freeze(assertExecutionAdapter(adapter));
}

function normalizeBatchSubresponses(responses = []) {
  return responses.map((entry, index) => ({ index, status: entry.code >= 200 && entry.code < 300 && !entry.error ? "SUCCEEDED" : "FAILED", providerCode: String(entry.error?.code || entry.code || "UNKNOWN"), message: String(entry.error?.message || "").slice(0, 500) }));
}

module.exports = { configuredVersion, safeAccountState, capabilityFor, deterministicGraph, classifyProviderError, normalizeBatchSubresponses, createProviderExecutionAdapter };

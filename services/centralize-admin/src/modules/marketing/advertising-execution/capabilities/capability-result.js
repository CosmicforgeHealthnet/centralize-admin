const { z } = require("zod");
const { PROVIDERS } = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { sanitizeExecutionJson } = require("../execution-json.validator");

const capabilitySchema = z.object({
  supported: z.boolean(),
  writeReady: z.literal(false),
  unavailableReason: z.string().trim().min(1).max(100).nullable(),
  provider: z.enum(PROVIDERS),
  apiVersion: z.string().trim().min(1).max(100),
  connectionId: z.string().uuid().nullable(),
  accountExternalId: z.string().trim().max(255).nullable(),
  accountCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  supportedOperationTypes: z.array(z.enum(["CREATE", "UPDATE", "PAUSE", "RESUME", "ARCHIVE", "REMOVE_LINK"])).max(6),
  supportedResourceTypes: z.array(z.enum(["BUDGET", "CAMPAIGN", "GROUP", "TARGETING", "CREATIVE", "AD", "ASSET_LINK"])).max(7),
  supportedCampaignTypes: z.array(z.string().trim().max(100)).max(30),
  budgetUnitSemantics: z.string().trim().max(100).nullable(),
  createDefaultStatus: z.string().trim().max(100).nullable(),
  dryRunAvailable: z.boolean(),
  nativeValidationAvailable: z.boolean(),
  atomicity: z.enum(["NONE", "OPERATION", "PLAN"]),
  idempotency: z.enum(["NONE", "LIMITED", "SUPPORTED"]),
  permissionState: z.enum(["UNKNOWN", "MISSING", "AVAILABLE"]),
  configurationReady: z.boolean(),
  authenticationReady: z.boolean(),
  permissionReady: z.boolean(),
  accountReady: z.boolean(),
  operationSupported: z.boolean(),
  writeGateEnabled: z.boolean(),
  accountRestrictions: z.array(z.string().trim().max(500)).max(30),
  warnings: z.array(z.string().trim().max(500)).max(20),
  immutableFields: z.array(z.string().trim().max(200)).max(30),
  providerDetails: z.record(z.string(), z.unknown()),
}).strict();

function validateCapability(value) {
  const sanitized = sanitizeExecutionJson(value, "summary");
  const parsed = capabilitySchema.safeParse(sanitized);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "capability", reasonCode: "INVALID_CAPABILITY_RESULT", issues: parsed.error.issues });
  return parsed.data;
}

function createUnavailableCapability({ provider, apiVersion = "UNAVAILABLE", connectionId = null, accountExternalId = null, accountCurrency = null, reasonCode = "CAPABILITY_UNAVAILABLE", permissionState = "MISSING", warnings = [] }) {
  return validateCapability({
    supported: false,
    writeReady: false,
    unavailableReason: reasonCode,
    provider,
    apiVersion,
    connectionId,
    accountExternalId,
    accountCurrency: accountCurrency && /^[A-Z]{3}$/.test(accountCurrency) ? accountCurrency : null,
    supportedOperationTypes: [],
    supportedResourceTypes: [],
    supportedCampaignTypes: [],
    budgetUnitSemantics: null,
    createDefaultStatus: null,
    dryRunAvailable: false,
    nativeValidationAvailable: false,
    atomicity: "NONE",
    idempotency: "NONE",
    permissionState,
    configurationReady: false,
    authenticationReady: false,
    permissionReady: permissionState === "AVAILABLE",
    accountReady: false,
    operationSupported: false,
    writeGateEnabled: false,
    accountRestrictions: [reasonCode],
    warnings,
    immutableFields: [],
    providerDetails: {},
  });
}

function createStructuralCapability(input) {
  return validateCapability({
    supported: Boolean(input.operationSupported),
    writeReady: false,
    unavailableReason: input.unavailableReason || "WRITE_GATE_DISABLED",
    provider: input.provider,
    apiVersion: input.apiVersion || "CONFIG_REQUIRED",
    connectionId: input.connectionId || null,
    accountExternalId: input.accountExternalId || null,
    accountCurrency: input.accountCurrency || null,
    supportedOperationTypes: input.supportedOperationTypes || [],
    supportedResourceTypes: input.supportedResourceTypes || [],
    supportedCampaignTypes: input.supportedCampaignTypes || [],
    budgetUnitSemantics: input.budgetUnitSemantics || null,
    createDefaultStatus: input.createDefaultStatus || "PAUSED",
    dryRunAvailable: Boolean(input.dryRunAvailable),
    nativeValidationAvailable: Boolean(input.nativeValidationAvailable),
    atomicity: input.atomicity || "OPERATION",
    idempotency: input.idempotency || "LIMITED",
    permissionState: input.permissionState || "UNKNOWN",
    configurationReady: Boolean(input.configurationReady),
    authenticationReady: Boolean(input.authenticationReady),
    permissionReady: Boolean(input.permissionReady),
    accountReady: Boolean(input.accountReady),
    operationSupported: Boolean(input.operationSupported),
    writeGateEnabled: false,
    accountRestrictions: input.accountRestrictions || [],
    warnings: input.warnings || [],
    immutableFields: input.immutableFields || [],
    providerDetails: input.providerDetails || {},
  });
}

function capabilityValidationIssues(capability, { operationType, resourceType } = {}) {
  const issues = [];
  if (!capability.supported) issues.push({ severity: "ERROR", code: "CAPABILITY_UNAVAILABLE", fieldPath: "provider", message: capability.unavailableReason });
  if (operationType && !capability.supportedOperationTypes.includes(operationType)) issues.push({ severity: "ERROR", code: "UNSUPPORTED_OPERATION", fieldPath: "operationType", message: `${operationType} is unavailable` });
  if (resourceType && !capability.supportedResourceTypes.includes(resourceType)) issues.push({ severity: "ERROR", code: "UNSUPPORTED_RESOURCE", fieldPath: "resourceType", message: `${resourceType} is unavailable` });
  return issues;
}

module.exports = { capabilitySchema, validateCapability, createUnavailableCapability, createStructuralCapability, capabilityValidationIssues };

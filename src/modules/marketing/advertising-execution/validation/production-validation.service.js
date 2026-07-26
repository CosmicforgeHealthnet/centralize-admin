const { sanitizeExecutionJson } = require("../execution-json.validator");
const { executionError } = require("../execution.errors");
const { assertApprovalIntegrity } = require("./approval-integrity.service");
const {
  assertBeforeStateCurrent,
} = require("../operations/idempotency.service");
const {
  providerDeliveryRules,
} = require("../targeting/provider-delivery-rules.registry");
const {
  validateDeliveryRuleSet,
} = require("../targeting/delivery-rules.validator");
const {
  resolveTargetingCriteria,
} = require("../targeting/targeting.validator");

function result(value, issues = [], evidence = {}) {
  return { value, issues, evidence };
}
function createProductionValidators({
  adapterRegistry,
  providerReadRegistry,
  targetingDiscoveryService,
  connectionPolicyResolver,
} = {}) {
  return Object.freeze({
    transport: async (input) =>
      result(sanitizeExecutionJson(input, "desiredState")),
    domain: async (input) => {
      if (
        !input.id ||
        !input.platform ||
        !input.connectionId ||
        !input.accountExternalId ||
        !input.currencyCode ||
        !Number.isInteger(input.version)
      )
        throw executionError("INVALID_EXECUTION_PLAN", {
          reasonCode: "PLAN_DOMAIN_IDENTITY_REQUIRED",
        });
      const references = new Set();
      for (const item of input.items || []) {
        if (references.has(item.clientReference))
          throw executionError("INVALID_EXECUTION_PLAN", {
            reasonCode: "DUPLICATE_ITEM_REFERENCE",
          });
        references.add(item.clientReference);
      }
      return result(input);
    },
    capability: async (input) => {
      const adapter = adapterRegistry.get(input.platform);
      const capability = adapter.getCapabilities({
        connection: input.connection,
        accountExternalId: input.accountExternalId,
      });
      if (!capability)
        throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", {
          reasonCode: "ACCOUNT_CAPABILITY_UNAVAILABLE",
        });
      return result(input, [], { capability });
    },
    businessPolicy: async (input) => {
      if (
        input.desiredState?.advertisingCategory &&
        input.desiredState.advertisingCategory !== "GENERAL"
      )
        throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", {
          reasonCode: "REGULATED_OR_SENSITIVE_TARGETING_FORBIDDEN",
        });
      const apiVersion = input.desiredState?.apiVersion;
      let targeting = input.desiredState?.targeting;
      if (targeting?.length)
        targeting = await resolveTargetingCriteria(targeting, {
          provider: input.platform,
          apiVersion,
          connectionId: input.connectionId,
          accountExternalId: input.accountExternalId,
          resolver: (scope) => targetingDiscoveryService.resolve(scope),
          objective: input.desiredState.objective,
          creativeFormat: input.desiredState.creativeFormat,
          accountPlacementAllowlist:
            input.connection?.connectionMetadata?.placementAllowlist || [],
          advertisingCategory:
            input.desiredState.advertisingCategory || "GENERAL",
        });
      let delivery = null;
      if (input.desiredState?.bidding && input.desiredState?.schedule)
        delivery = validateDeliveryRuleSet(
          {
            objective: input.desiredState.objective,
            creativeFormat: input.desiredState.creativeFormat,
            placements: input.desiredState.placements || [],
            bidding: input.desiredState.bidding,
            schedule: input.desiredState.schedule,
          },
          {
            providerRules: providerDeliveryRules({
              provider: input.platform,
              apiVersion,
            }),
            currency: input.currencyCode,
          },
        );
      const connectionWriteEnabled = await connectionPolicyResolver({
        platform: input.platform,
        connectionId: input.connectionId,
        accountExternalId: input.accountExternalId,
      });
      return result(
        {
          ...input,
          normalizedTargeting: targeting,
          normalizedDelivery: delivery,
        },
        [],
        { connectionWriteEnabled },
      );
    },
    providerPreflight: async (input) => {
      const reader = providerReadRegistry.resolve(input.platform);
      if (typeof reader.readResource !== "function")
        throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", {
          reasonCode: "PROVIDER_PREFLIGHT_READER_UNAVAILABLE",
        });
      const beforeState = await reader.readResource({
        plan: input,
        validateOnly: true,
        mutation: false,
      });
      return result({ ...input, providerBeforeState: beforeState }, [], {
        providerVersion: reader.apiVersion,
        mutation: false,
      });
    },
    approvalIntegrity: async (input) =>
      result(
        input,
        [],
        assertApprovalIntegrity({
          plan: input.run?.plan || input,
          run: input.run,
          approvals: input.run?.plan?.approvals || input.approvals || [],
        }),
      ),
    executionPrecondition: async (input) => {
      const operation = input.operation;
      const approvedBefore =
        operation?.snapshots?.find((snapshot) => snapshot.kind === "BEFORE") ||
        operation?.item?.beforeState;
      const current = input.currentProviderState || input.providerBeforeState;
      const approvedHash =
        approvedBefore?.hash ||
        (approvedBefore?.normalizedState
          ? null
          : operation?.item?.beforeStateHash);
      if (approvedHash)
        assertBeforeStateCurrent({ approvedHash, currentState: current });
      return result(input, [], { checkedAt: new Date().toISOString() });
    },
  });
}
module.exports = { createProductionValidators };

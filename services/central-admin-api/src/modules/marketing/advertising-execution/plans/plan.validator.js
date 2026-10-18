const { z } = require("zod");
const { PROVIDERS } = require("../execution.constants");
const { executionError } = require("../execution.errors");
const { normalizedMaterialSnapshot } = require("./plan-fingerprint");

const RAW_PROVIDER_KEYS = new Set([
  "raw", "rawpayload", "payload", "providerpayload", "nativepayload", "mutationpayload",
  "requestbody", "googleadspayload", "metapayload", "tiktokpayload", "linkedinpayload", "xpayload",
  // normalizedKey strips non-alphanumerics, so a literal "__proto__" key
  // normalizes to "proto"; both forms are listed so neither ever passes.
  "__proto__", "proto", "prototype", "constructor",
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const operationSchema = z.object({
  type: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(255).optional(),
  sequence: z.number().int().min(0).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict();

const planInputSchema = z.object({
  provider: z.enum(PROVIDERS),
  connectionId: z.string().uuid(),
  accountId: z.string().trim().min(1).max(255),
  currencyCode: z.string().trim().regex(/^[A-Z]{3}$/),
  objective: z.string().trim().min(1).max(100),
  budgetLimit: z.number().finite().nonnegative().optional(),
  operations: z.array(operationSchema).min(1).max(200),
  constraints: z.record(z.string(), z.unknown()).optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  name: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
  displayMetadata: z.record(z.string(), z.unknown()).optional(),
  uiMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

function rejectRawProviderFields(value, path = "plan", seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw executionError("INVALID_EXECUTION_PLAN", { field: path, reasonCode: "CIRCULAR_VALUE" });
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (RAW_PROVIDER_KEYS.has(normalizedKey(key))) throw executionError("RAW_PROVIDER_PAYLOAD_FORBIDDEN", { field: `${path}.${key}` });
    rejectRawProviderFields(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validatePlanInput(value) {
  rejectRawProviderFields(value);
  if (!PROVIDERS.includes(value?.provider)) throw executionError("UNSUPPORTED_PROVIDER", { provider: value?.provider || null });
  const parsed = planInputSchema.safeParse(value);
  if (!parsed.success) {
    throw executionError("INVALID_EXECUTION_PLAN", {
      issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }
  normalizedMaterialSnapshot(parsed.data);
  return parsed.data;
}

module.exports = { planInputSchema, rejectRawProviderFields, validatePlanInput };

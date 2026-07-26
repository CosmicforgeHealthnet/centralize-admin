const { z } = require("zod");
const { executionError } = require("../execution.errors");
const { decimal } = require("../budgets/money");

const biddingSchema = z.object({ strategy: z.string().trim().min(1).max(100), bidAmount: z.string().regex(/^\d+(?:\.\d+)?$/).nullable().default(null), targetValue: z.string().regex(/^\d+(?:\.\d+)?$/).nullable().default(null), conversionActionId: z.string().trim().max(512).nullable().default(null), optimizationGoal: z.string().trim().min(1).max(100), billingEvent: z.string().trim().min(1).max(100) }).strict();
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/);
const scheduleSchema = z.object({ originalLocalStart: localDateTime, originalLocalEnd: localDateTime.nullable(), accountTimezone: z.string().trim().min(1).max(100), dstDisambiguation: z.enum(["EARLIER", "LATER", "REJECT"]), minimumLeadMinutes: z.number().int().min(0).max(10080).default(0), maximumDurationDays: z.number().int().positive().max(3650).default(365) }).strict();

function validateBidding(input, { currency, rule }) {
  const parsed = biddingSchema.safeParse(input);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "bidding", reasonCode: "INVALID_TYPED_BIDDING", issues: parsed.error.issues });
  const bidding = parsed.data;
  if (!rule || !rule.strategies.includes(bidding.strategy)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "bidding.strategy", reasonCode: "BIDDING_STRATEGY_UNSUPPORTED" });
  if (!rule.optimizationGoals.includes(bidding.optimizationGoal) || !rule.billingEvents.includes(bidding.billingEvent)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "bidding", reasonCode: "OPTIMIZATION_BILLING_COMBINATION_UNSUPPORTED" });
  if (rule.targetValueRequired && bidding.targetValue == null) throw executionError("INVALID_EXECUTION_PLAN", { field: "bidding.targetValue", reasonCode: "BIDDING_TARGET_REQUIRED" });
  if (rule.conversionActionRequired && !bidding.conversionActionId) throw executionError("INVALID_EXECUTION_PLAN", { field: "bidding.conversionActionId", reasonCode: "CONVERSION_ACTION_REQUIRED" });
  if (bidding.bidAmount != null) decimal(bidding.bidAmount, { currency, allowZero: false });
  if (bidding.targetValue != null) decimal(bidding.targetValue, { currency, allowZero: false });
  return bidding;
}

function localParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  return match && { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +(match[6] || 0) };
}

function localDateTimeToUtc(value, timeZone, disambiguation = "REJECT") {
  const expected = localParts(value);
  let formatter;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch (_error) { throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule.accountTimezone", reasonCode: "INVALID_ACCOUNT_TIMEZONE" }); }
  const naive = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute, expected.second);
  const candidates = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(naive - offsetMinutes * 60000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    if (parts.year === expected.year && parts.month === expected.month && parts.day === expected.day && (parts.hour % 24) === expected.hour && parts.minute === expected.minute && parts.second === expected.second) candidates.push(candidate);
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.toISOString(), candidate])).values()].sort((a, b) => a - b);
  if (!unique.length) throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule", reasonCode: "NONEXISTENT_LOCAL_TIME" });
  if (unique.length > 1 && disambiguation === "REJECT") throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule", reasonCode: "AMBIGUOUS_LOCAL_TIME" });
  return disambiguation === "LATER" ? unique.at(-1) : unique[0];
}

function validateSchedule(input, { now = new Date() } = {}) {
  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule", reasonCode: "INVALID_SCHEDULE", issues: parsed.error.issues });
  const schedule = parsed.data;
  const start = localDateTimeToUtc(schedule.originalLocalStart, schedule.accountTimezone, schedule.dstDisambiguation);
  const end = schedule.originalLocalEnd ? localDateTimeToUtc(schedule.originalLocalEnd, schedule.accountTimezone, schedule.dstDisambiguation) : null;
  if (start.getTime() < now.getTime() + schedule.minimumLeadMinutes * 60000) throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule.originalLocalStart", reasonCode: "SCHEDULE_MINIMUM_LEAD_NOT_MET" });
  if (end && (end <= start || end - start > schedule.maximumDurationDays * 86400000)) throw executionError("INVALID_EXECUTION_PLAN", { field: "schedule.originalLocalEnd", reasonCode: "INVALID_CAMPAIGN_SCHEDULE" });
  const offsetMinutes = Math.round((Date.UTC(...Object.values(localParts(schedule.originalLocalStart)).slice(0, 3).map((v, i) => i === 1 ? v - 1 : v), ...Object.values(localParts(schedule.originalLocalStart)).slice(3)) - start.getTime()) / 60000);
  return Object.freeze({ ...schedule, normalizedUtcStart: start.toISOString(), normalizedUtcEnd: end?.toISOString() || null, utcOffsetMinutes: offsetMinutes, storedTimezone: "UTC" });
}

function validateDeliveryRuleSet({ objective, creativeFormat, placements, bidding, schedule }, { providerRules, currency, now }) {
  const objectiveRule = providerRules?.objectives?.[objective];
  if (!objectiveRule) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "objective", reasonCode: "OBJECTIVE_UNSUPPORTED" });
  if (!objectiveRule.formats.includes(creativeFormat)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "creativeFormat", reasonCode: "OBJECTIVE_FORMAT_UNSUPPORTED" });
  for (const placement of placements) if (!objectiveRule.placements.includes(placement)) throw executionError("PROVIDER_CAPABILITY_UNAVAILABLE", { field: "placements", reasonCode: "OBJECTIVE_PLACEMENT_UNSUPPORTED", placement });
  return Object.freeze({ objective, creativeFormat, placements: [...new Set(placements)], bidding: validateBidding(bidding, { currency, rule: objectiveRule.bidding }), schedule: validateSchedule(schedule, { now }) });
}

module.exports = { biddingSchema, scheduleSchema, validateBidding, localDateTimeToUtc, validateSchedule, validateDeliveryRuleSet };

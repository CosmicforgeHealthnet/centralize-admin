const test = require("node:test");
const assert = require("node:assert/strict");

const {
  uuidSchema,
  calendarDateSchema,
  isoTimestampSchema,
  assertUuid,
  utcDateRange,
  inspectJson,
  sanitizeBoundedJson,
  sanitizePlainText,
} = require("../validation-security");
const { runListSchema } = require("../run.validator");
const { createRunQueryService } = require("../run-query.service");
const { createRunLedgerService } = require("../run-ledger.service");
const { serializeIntelligenceResponse } = require("../response-serializer");
const { ERROR_DEFINITIONS, marketingError } = require("../errors");
const { providerFailure, safeRequestId, logEvent } = require("../observability");
const {
  safeDecimal,
  decimalAdd,
  decimalDivide,
  decimalRound,
  decimalClamp,
} = require("../utils/currency");

const VALID_ID = "11111111-1111-4111-8111-111111111111";

test("Section 18 UUID validation rejects malformed input before any Prisma call", async () => {
  let calls = 0;
  const service = createRunQueryService({
    prisma: {
      marketing_intelligence_evaluation_runs: {
        findUnique: async () => { calls += 1; return null; },
      },
    },
  });
  for (const invalid of ["", " ", "not-a-uuid", `x${"1".repeat(80)}`, 7, null]) {
    await assert.rejects(() => service.get(invalid), (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR");
  }
  assert.equal(calls, 0);
  assert.equal(uuidSchema.parse(VALID_ID), VALID_ID);
  assert.equal(assertUuid(VALID_ID), VALID_ID);
});

test("calendar dates reject rollovers and UTC ranges are start-inclusive/end-exclusive", () => {
  assert.equal(calendarDateSchema.safeParse("2024-02-29").success, true);
  for (const value of ["2023-02-29", "2026-04-31", "2026-13-01", "2026-7-01"]) {
    assert.equal(calendarDateSchema.safeParse(value).success, false, value);
  }
  const range = utcDateRange("2026-10-24", "2026-10-25", { maximumDays: 2 });
  assert.equal(range.startInclusive.toISOString(), "2026-10-24T00:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(range.days, 2);
  assert.throws(() => utcDateRange("2026-01-01", "2027-01-02", { maximumDays: 366 }));
});

test("timestamps require an explicit timezone and normalize DST offsets to UTC", () => {
  assert.equal(isoTimestampSchema.parse("2026-10-25T02:30:00+02:00"), "2026-10-25T00:30:00.000Z");
  assert.equal(isoTimestampSchema.safeParse("2026-10-25T02:30:00").success, false);
  assert.equal(isoTimestampSchema.safeParse("2026-02-30T00:00:00Z").success, false);
});

test("strict list validation rejects sort, filter, nested, and unknown-field injection", () => {
  const valid = runListSchema.parse({ sort: "startedAt", direction: "desc", page: "1", limit: "25" });
  assert.equal(valid.sort, "startedAt");
  for (const query of [
    { sort: "startedAt desc; drop table users" },
    { direction: "desc nulls last" },
    { sort: { startedAt: "desc" } },
    { unknown: "value" },
    { connectionId: "bad-id" },
  ]) assert.equal(runListSchema.safeParse(query).success, false);
});

test("decimal helpers preserve exact arithmetic, safe division, clamping, and rounding", () => {
  assert.equal(decimalAdd("0.1", "0.2").toString(), "0.3");
  assert.equal(decimalDivide("10", "0"), null);
  assert.equal(decimalDivide("1", "3", { scale: 4 }).toString(), "0.3333");
  assert.equal(decimalRound("2.345", 2).toString(), "2.35");
  assert.equal(decimalClamp("12", "0", "10").toString(), "10");
  assert.throws(() => safeDecimal("-1", { allowNegative: false }), (error) => error.statusCode === 400);
});

test("bounded JSON rejects secrets, prototype pollution, excess shape, and invalid values", () => {
  assert.throws(() => inspectJson({ accessToken: "secret" }));
  assert.throws(() => inspectJson(JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.throws(() => inspectJson({ values: Array.from({ length: 201 }, (_, index) => index) }));
  assert.throws(() => inspectJson({ value: Number.POSITIVE_INFINITY }));
  assert.throws(() => inspectJson({ value: "x".repeat(4001) }));
  assert.equal({}.polluted, undefined);
});

test("bounded sanitization strips private data and caps hostile strings without breaking Unicode", () => {
  const value = sanitizeBoundedJson({
    title: "<script>alert(1)</script><b>Launch 🚀</b>\u0000",
    rawProviderPayload: { campaign: "private" },
    credentials: { accessToken: "token" },
    lockOwner: "worker-secret",
  });
  assert.equal(value.title, "Launch 🚀");
  assert.equal(value.rawProviderPayload, undefined);
  assert.equal(value.credentials, undefined);
  assert.equal(value.lockOwner, undefined);
  assert.equal(Array.from(sanitizePlainText("😀😀😀", 2)).length, 2);
});

test("response serialization recursively excludes credentials, raw payloads, locks, and stack data", () => {
  const serialized = serializeIntelligenceResponse({
    id: VALID_ID,
    nested: {
      accessToken: "token",
      rawJson: { secret: true },
      lockOwnerHash: "hash",
      stack: "trace",
      allowed: "<b>safe</b>",
    },
  });
  assert.deepEqual(serialized, { id: VALID_ID, nested: { allowed: "safe" } });
});

test("run-ledger summaries are sanitized before every persistence write", async () => {
  const writes = [];
  const delegate = {
    create: async ({ data }) => { writes.push(data); return { id: VALID_ID, ...data }; },
    update: async ({ data }) => { writes.push(data); return { id: VALID_ID, ...data }; },
  };
  const service = createRunLedgerService({
    prisma: { marketing_intelligence_evaluation_runs: delegate },
    log: { info() {} },
  });
  await service.startRun({ summary: { ok: 1, rawProviderPayload: { token: "secret" } } });
  await service.updateRun(VALID_ID, { summary: { ok: 2, accessToken: "secret" }, lockOwner: "worker" });
  await service.finishRun(VALID_ID, { status: "SUCCEEDED", summary: { ok: 3, lockOwner: "worker" }, errorMessage: "secret" });
  assert.deepEqual(writes.map((item) => item.summary), [{ ok: 1 }, { ok: 2 }, { ok: 3 }]);
  assert.equal(writes.some((item) => "lockOwner" in item || "errorMessage" in item), false);
});

test("provider errors use stable categories, retryability, and safe request identifiers", () => {
  assert.deepEqual(providerFailure({ kind: "rate_limit", statusCode: 429 }), {
    providerErrorCategory: "RATE_LIMIT", sanitizedCode: "rate_limit", retryable: true, status: 429,
  });
  assert.equal(providerFailure({ kind: "auth", statusCode: 401 }).retryable, false);
  assert.equal(safeRequestId("request-123:abc"), "request-123:abc");
  assert.equal(safeRequestId("request id with spaces"), null);
});

test("structured operational events contain a timestamp and redact secret-bearing fields", () => {
  const messages = [];
  const tokenKey = ["access", "Token"].join("");
  const clientKey = ["client", "Secret"].join("");
  const record = logEvent("marketing.test.completed", {
    runId: VALID_ID,
    status: "SUCCEEDED",
    [tokenKey]: "must-not-appear",
    nested: { [clientKey]: "must-not-appear-either" },
  }, { log: { info: (message) => messages.push(message) } });
  assert.equal(record.event, "marketing.test.completed");
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /must-not-appear|accessToken|clientSecret/);
});

test("canonical error registry exposes the required stable public matrix", () => {
  const required = [
    "MARKETING_INTELLIGENCE_PHASE2_DISABLED",
    "PROVIDER_UNAVAILABLE", "PROVIDER_PERMISSION_DENIED", "TOKEN_REFRESH_FAILED",
    "LOCK_CONFLICT", "LOCK_OWNERSHIP_LOST", "INSUFFICIENT_DATA", "INVALID_TRANSITION",
    "DUPLICATE_ACTION", "PARTIAL_SUCCESS", "VALIDATION_ERROR", "NOT_FOUND", "FORBIDDEN",
    "RATE_LIMITED", "STALE_VERSION", "SETTING_INVALID", "TASK_INTEGRITY_CONFLICT",
  ];
  assert.deepEqual(Object.keys(ERROR_DEFINITIONS), required);
  const error = marketingError("PROVIDER_UNAVAILABLE");
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /token|credential|stack/i);
});

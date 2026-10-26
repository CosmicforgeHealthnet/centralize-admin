"use strict";

// Gap 4: recipient-timezone + DST math for automation delivery (Intl only)
// and the definition validation of the new delay/window/until options.

const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../src/modules/mail/marketing/scheduling");
const { validateDefinition, validateTriggerConfig, definitionHash, DefinitionError } = require("../src/modules/mail/marketing/automation/definition");

const at = (value) => Date.parse(value);
const utc = (result) => (result.utc || result.runAt).toISOString();

test("spring forward: non-existent local times shift forward by the gap", () => {
  const ny = s.resolveLocalTime("2026-03-08T02:30", "America/New_York");
  assert.equal(ny.utc.toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(ny.shiftedMinutes, 60);
  assert.equal(s.localIso(ny.utc.getTime(), "America/New_York"), "2026-03-08T03:30:00-04:00");
  const london = s.resolveLocalTime("2026-03-29T01:30", "Europe/London");
  assert.equal(london.utc.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(s.localIso(london.utc.getTime(), "Europe/London"), "2026-03-29T02:30:00+01:00");
  // Lord Howe: 30-minute DST (02:00 -> 02:30 on 2026-10-04).
  const lordHowe = s.resolveLocalTime("2026-10-04T02:15", "Australia/Lord_Howe");
  assert.equal(lordHowe.shiftedMinutes, 30);
  assert.equal(s.localIso(lordHowe.utc.getTime(), "Australia/Lord_Howe"), "2026-10-04T02:45:00+11:00");
  // Campaign scheduling keeps rejecting the gap (author picks another time).
  assert.throws(() => s.zonedLocalToUtc("2026-03-08T02:30", "America/New_York"), (error) => error.code === "SCHEDULE_TIME_NONEXISTENT");
});

test("fall back: ambiguous local times use the first occurrence", () => {
  const ny = s.resolveLocalTime("2026-11-01T01:30", "America/New_York");
  assert.equal(ny.utc.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(ny.ambiguous, true);
  assert.equal(s.localIso(ny.utc.getTime(), "America/New_York"), "2026-11-01T01:30:00-04:00");
  const london = s.resolveLocalTime("2026-10-25T01:30", "Europe/London");
  assert.equal(london.utc.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(london.ambiguous, true);
  const lordHowe = s.resolveLocalTime("2026-04-05T01:45", "Australia/Lord_Howe");
  assert.equal(lordHowe.utc.toISOString(), "2026-04-04T14:45:00.000Z", "first (+11:00) occurrence");
  assert.equal(lordHowe.ambiguous, true);
  // After the first occurrence passed, the second one is never used: next day.
  const next = s.nextLocalTimeAtOrAfter(at("2026-11-01T05:45:00Z"), "01:30", "America/New_York");
  assert.equal(utc(next), "2026-11-02T06:30:00.000Z");
});

test("no DST: Africa/Lagos is a fixed UTC+1", () => {
  for (const day of ["2026-01-15", "2026-03-29", "2026-07-01", "2026-10-25"]) {
    const result = s.resolveLocalTime(`${day}T09:00`, "Africa/Lagos");
    assert.equal(result.utc.toISOString(), `${day}T08:00:00.000Z`);
    assert.equal(result.ambiguous, false);
    assert.equal(result.shiftedMinutes, 0);
  }
});

test("calendar boundaries: end of month, Feb 29 2028, year end", () => {
  assert.equal(utc(s.nextLocalTimeAtOrAfter(at("2026-01-31T20:00:00Z"), "09:00", "America/New_York")), "2026-02-01T14:00:00.000Z");
  assert.equal(utc(s.nextLocalTimeAtOrAfter(at("2028-02-28T15:00:00Z"), "09:00", "Europe/London")), "2028-02-29T09:00:00.000Z");
  assert.equal(utc(s.nextLocalTimeAtOrAfter(at("2028-02-29T10:00:00Z"), "09:00", "Europe/London")), "2028-03-01T09:00:00.000Z");
  // 23:30 UTC on Dec 31 is already Jan 1 in Lagos.
  assert.equal(utc(s.nextLocalTimeAtOrAfter(at("2026-12-31T23:30:00Z"), "09:00", "Africa/Lagos")), "2027-01-01T08:00:00.000Z");
  assert.equal(utc(s.nextLocalTimeAtOrAfter(at("2026-12-31T22:00:00Z"), "09:00", "America/New_York")), "2027-01-01T14:00:00.000Z");
  // Fixed delay across a month end and a leap day keeps exact minutes.
  const delayed = s.computeDelayRunAt({ fromMs: at("2028-02-28T12:00:00Z"), step: { minutes: 2 * 1440 } });
  assert.equal(delayed.runAt.toISOString(), "2028-03-01T12:00:00.000Z");
});

test("delivery windows: inside stays, outside moves to the next opening, weekends skipped", () => {
  const weekdays = { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
  // Friday 2026-10-30 12:00 London (GMT) is inside.
  assert.deepEqual(s.applyWindow(at("2026-10-30T12:00:00Z"), weekdays, "Europe/London"), { at: at("2026-10-30T12:00:00Z"), deferred: false, shiftedMinutes: 0 });
  // Friday 18:00 -> Monday 09:00; Saturday -> Monday; end is exclusive.
  assert.equal(new Date(s.applyWindow(at("2026-10-30T18:00:00Z"), weekdays, "Europe/London").at).toISOString(), "2026-11-02T09:00:00.000Z");
  assert.equal(new Date(s.applyWindow(at("2026-10-31T10:00:00Z"), weekdays, "Europe/London").at).toISOString(), "2026-11-02T09:00:00.000Z");
  assert.equal(s.applyWindow(at("2026-10-30T17:00:00Z"), weekdays, "Europe/London").deferred, true);
  // Early morning -> same day opening (New York, EST after fall back).
  assert.equal(new Date(s.applyWindow(at("2026-11-02T11:00:00Z"), weekdays, "America/New_York").at).toISOString(), "2026-11-02T14:00:00.000Z");
  // A window opening inside the spring-forward gap shifts forward.
  const gap = s.applyWindow(at("2026-03-08T06:00:00Z"), { start: "02:30", end: "05:00" }, "America/New_York");
  assert.equal(new Date(gap.at).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(gap.shiftedMinutes, 60);
});

test("zone resolution: recipient -> brand default -> UTC, with the fallback recorded", () => {
  assert.deepEqual(s.resolveZone({ contactTimeZone: "America/New_York", brandTimeZone: "Africa/Lagos" }), { timeZone: "America/New_York", source: "RECIPIENT", fallback: false, fallbackReason: null });
  assert.deepEqual(s.resolveZone({ contactTimeZone: null, brandTimeZone: "Africa/Lagos" }), { timeZone: "Africa/Lagos", source: "BRAND_DEFAULT", fallback: true, fallbackReason: "RECIPIENT_TIMEZONE_MISSING" });
  assert.deepEqual(s.resolveZone({ contactTimeZone: "Mars/Olympus", brandTimeZone: "Africa/Lagos" }), { timeZone: "Africa/Lagos", source: "BRAND_DEFAULT", fallback: true, fallbackReason: "RECIPIENT_TIMEZONE_INVALID" });
  assert.deepEqual(s.resolveZone({ contactTimeZone: null, brandTimeZone: null }), { timeZone: "UTC", source: "UTC", fallback: true, fallbackReason: "RECIPIENT_TIMEZONE_MISSING" });
  assert.equal(s.resolveZone({ spec: "brand", contactTimeZone: "America/New_York", brandTimeZone: "Europe/London" }).timeZone, "Europe/London");
  assert.equal(s.resolveZone({ spec: "Asia/Tokyo", contactTimeZone: "America/New_York" }).source, "EXPLICIT");
  assert.equal(s.contactTimeZoneOf({ attributes: { timezone: "Europe/London" } }), "Europe/London");
  assert.equal(s.contactTimeZoneOf({ attributes: null }), null);
  assert.equal(s.isValidTimeZone("Not/AZone"), false);
});

test("delay until a recipient local time across DST, with window and fallback", () => {
  // Spring forward: "until 02:30" on the gap day runs at 03:30 EDT.
  const spring = s.computeDelayRunAt({ fromMs: at("2026-03-07T12:00:00Z"), step: { minutes: 0, until: { localTime: "02:30", timezone: "recipient" } }, contactTimeZone: "America/New_York" });
  assert.equal(spring.runAt.toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(spring.localRunAt, "2026-03-08T03:30:00-04:00");
  assert.equal(spring.shiftedMinutes, 60);
  assert.equal(spring.timeZoneSource, "RECIPIENT");
  // Fall back: first 01:30.
  const fall = s.computeDelayRunAt({ fromMs: at("2026-10-31T12:00:00Z"), step: { minutes: 0, until: { localTime: "01:30" } }, contactTimeZone: "America/New_York" });
  assert.equal(fall.runAt.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(fall.ambiguous, true);
  // Missing contact zone -> brand default (Lagos), recorded.
  const fallback = s.computeDelayRunAt({ fromMs: at("2026-10-31T12:00:00Z"), step: { minutes: 60, until: { localTime: "09:00" } }, brandTimeZone: "Africa/Lagos" });
  assert.equal(fallback.runAt.toISOString(), "2026-11-01T08:00:00.000Z");
  assert.equal(fallback.timeZoneFallback, true);
  assert.equal(fallback.fallbackReason, "RECIPIENT_TIMEZONE_MISSING");
  // until + weekday window in the same zone: Saturday -> Monday 09:00.
  const windowed = s.computeDelayRunAt({ fromMs: at("2026-10-30T20:00:00Z"), step: { minutes: 0, until: { localTime: "09:00" }, window: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] } }, contactTimeZone: "Europe/London" });
  assert.equal(windowed.runAt.toISOString(), "2026-11-02T09:00:00.000Z");
  // Window only (no until): deferred to the opening.
  const windowOnly = s.computeDelayRunAt({ fromMs: at("2026-10-31T10:00:00Z"), step: { minutes: 30, window: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } }, contactTimeZone: "Australia/Lord_Howe" });
  assert.equal(windowOnly.windowDeferred, true);
  assert.equal(windowOnly.localRunAt, "2026-11-02T09:00:00+11:00");
});

test("recipient-timezone schedules: each recipient at the occurrence's local time", () => {
  const config = { frequency: "daily", localTime: "09:00", timeZone: "recipient" };
  const occurrence = s.nextOccurrence(s.scheduleForOccurrences(config), at("2026-10-26T00:00:00Z"));
  assert.equal(occurrence.toISOString(), "2026-10-26T19:00:00.000Z", "Oct 27 09:00 starts first in UTC+14");
  const ny = s.recipientScheduleRunAt(occurrence, config, s.resolveZone({ contactTimeZone: "America/New_York" }));
  assert.equal(ny.localDate, "2026-10-27");
  assert.equal(ny.runAt.toISOString(), "2026-10-27T13:00:00.000Z");
  const lagos = s.recipientScheduleRunAt(occurrence, config, s.resolveZone({ contactTimeZone: "Africa/Lagos" }));
  assert.equal(lagos.runAt.toISOString(), "2026-10-27T08:00:00.000Z");
  // A recipient schedule at 02:30 on the New York gap day shifts forward.
  const gapOccurrence = s.nextOccurrence(s.scheduleForOccurrences({ ...config, localTime: "02:30" }), at("2026-03-07T10:00:00Z"));
  const gap = s.recipientScheduleRunAt(gapOccurrence, { ...config, localTime: "02:30" }, s.resolveZone({ contactTimeZone: "America/New_York" }));
  assert.equal(gap.localDate, "2026-03-08");
  assert.equal(gap.localRunAt, "2026-03-08T03:30:00-04:00");
});

test("definition validation: until/window options, invalid time zones, unchanged hashes", () => {
  const send = { id: "send", type: "send_email", templateVersionId: "11111111-1111-4111-8111-111111111111", senderAddressId: "22222222-2222-4222-8222-222222222222" };
  const ok = validateDefinition({ topic: "news", steps: [{ id: "wait", type: "delay", until: { localTime: "09:00", timezone: "recipient" }, window: { start: "08:00", end: "20:00", days: [5, 1, 1] }, next: "send" }, { ...send, window: { start: "09:00", end: "17:00", timezone: "Europe/London" } }] });
  assert.equal(ok.steps[0].minutes, 0, "until/window allow a zero fixed part");
  assert.deepEqual(ok.steps[0].window, { start: "08:00", end: "20:00", days: [1, 5], timezone: "recipient" });
  assert.equal(ok.steps[1].window.timezone, "Europe/London");
  const errorsOf = (definition) => {
    try {
      validateDefinition(definition);
      return [];
    } catch (error) {
      assert.ok(error instanceof DefinitionError);
      return error.errors.map((entry) => `${entry.field}${entry.reason ? `:${entry.reason}` : ""}`);
    }
  };
  assert.ok(errorsOf({ topic: "news", steps: [{ id: "w", type: "delay", minutes: 10, until: { localTime: "9am", timezone: "Mars/Olympus" }, next: "send" }, send] }).some((entry) => entry.startsWith("definition.steps[0].until.timezone")));
  assert.ok(errorsOf({ topic: "news", steps: [{ id: "w", type: "delay", minutes: 10, until: { localTime: "25:00" }, next: "send" }, send] }).some((entry) => entry.startsWith("definition.steps[0].until.localTime")));
  assert.ok(errorsOf({ topic: "news", steps: [{ id: "w", type: "delay", minutes: 10, window: { start: "18:00", end: "08:00" }, next: "send" }, send] }).includes("definition.steps[0].window:START_MUST_BE_BEFORE_END"));
  assert.ok(errorsOf({ topic: "news", steps: [{ id: "w", type: "delay", minutes: 10, window: { start: "08:00", end: "18:00", days: [0, 8] }, next: "send" }, send] }).includes("definition.steps[0].window.days:ISO_WEEKDAYS_1_TO_7"));
  assert.ok(errorsOf({ topic: "news", steps: [{ id: "w", type: "delay", minutes: 0, next: "send" }, send] }).includes("definition.steps[0].minutes:1-129600"), "a plain delay still needs >= 1 minute");
  // Existing definitions validate to exactly the same shape (same hash).
  const legacy = { topic: "news", steps: [{ id: "w", type: "delay", minutes: 60, next: "send" }, { ...send, next: null }] };
  const clean = validateDefinition(legacy);
  assert.deepEqual(clean.steps[0], { id: "w", type: "delay", minutes: 60, next: "send" });
  assert.equal(definitionHash(clean, { topic: "news" }), definitionHash(validateDefinition(JSON.parse(JSON.stringify(legacy))), { topic: "news" }));
  // Schedules accept "recipient" and still reject unknown zones.
  const definition = validateDefinition({ topic: "news", steps: [send] });
  const audienceId = "33333333-3333-4333-8333-333333333333";
  assert.equal(validateTriggerConfig("SCHEDULE", { frequency: "daily", localTime: "09:00", timeZone: "recipient", audienceId }, definition).timeZone, "recipient");
  assert.throws(() => validateTriggerConfig("SCHEDULE", { frequency: "daily", localTime: "09:00", timeZone: "Mars/Olympus", audienceId }, definition), DefinitionError);
});

"use strict";

// Final gap 4 on real PostgreSQL with the offline fake marketing provider:
//   A. automation test mode is read-only (no jobs, enrollments, step runs,
//      trigger events or provider calls; audit only)
//   B. replay / recovery: dry run vs execute, one execution per step run under
//      concurrency, refusal for successful sends, OUTCOME_UNKNOWN within the
//      idempotency window reuses the key (provider deduplicates) and is
//      refused after it, dead-letter requeue, interrupted worker recovery,
//      partial execution, duplicate trigger delivery, consent withdrawn
//      before replay, paused automation
//   C. recipient-timezone execution across the New York fall-back, delivery
//      windows skipping the weekend, missed windows and the brand fallback
//   + pre-migration-37 behaviour (test mode works, replay answers 503).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");

const ROLLBACK_37 = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");
// Saturday before the New York fall-back (2026-11-01 01:30 is ambiguous).
const CLOCK_START = Date.parse("2026-10-31T12:00:00.000Z");

async function setup(t, { rollback37 = false } = {}) {
  const db = await openDatabase();
  const { client } = db;
  if (rollback37) await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK_37, "utf8"));
  const harness = createHarness(client, { clockStart: CLOCK_START });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const call = caller(base, ids);
  const cf = brands.cosmicforge;
  const mbase = `/marketing/${cf.organization.id}`;
  const fake = harness.marketingAdapter;
  // Count every provider call (the metrics proxy reads methods at call time).
  const providerCalls = [];
  for (const [key, value] of Object.entries(fake)) {
    if (typeof value === "function" && !["failNext", "providerUnsubscribe", "completeBroadcast", "segmentMembers", "setQuotaObserver"].includes(key)) {
      fake[key] = async (...args) => {
        providerCalls.push(key);
        return value.apply(fake, args);
      };
    }
  }
  const worker = harness.mail.createWorker({ queues: ["MARKETING", "EVENTS"] });
  const work = async (rounds = 3, stepMs = 61000) => {
    for (let index = 0; index < rounds; index += 1) {
      harness.advance(stepMs);
      await worker.drain({ maxTicks: 20 });
    }
  };
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const consent = (topic) => ({ topic, source: "WEB_FORM", policyVersion: "2026-10", evidence: { reference: `form-${crypto.randomUUID().slice(0, 8)}` } });
  const newContact = async (email, topic = "newsletter", extra = {}) => {
    const response = await call("dave", "POST", `${mbase}/contacts`, { email, firstName: email.split("@")[0], consent: consent(topic), ...extra });
    assert.equal(response.status, 201, response.text);
    return response.body.data;
  };
  const template = await call("dave", "POST", `${mbase}/templates`, { name: `Gap4 ${crypto.randomUUID().slice(0, 6)}` });
  assert.equal(template.status, 201, template.text);
  const version = await call("dave", "POST", `${mbase}/templates/${template.body.data.id}/versions`, { subject: "News for {{first_name}}", blocks: [{ type: "heading", text: "Hello {{first_name}} {{last_name}}" }, { type: "text", text: "From {{brand_name}}." }] });
  assert.equal(version.status, 201, version.text);
  const templateVersionId = version.body.data.id;
  const publish = async (name, triggerType, definition, triggerConfig, extra = {}) => {
    const created = await call("dave", "POST", `${mbase}/automations`, { name, triggerType, frequencyCapHours: 0, ...extra });
    assert.equal(created.status, 201, created.text);
    const draft = await call("dave", "PUT", `${mbase}/automations/${created.body.data.id}/draft`, { definition, triggerConfig });
    assert.equal(draft.status, 200, draft.text);
    assert.equal((await call("dave", "POST", `${mbase}/automations/${created.body.data.id}/versions/${draft.body.data.id}/submit`)).status, 200);
    const published = await call("erin", "POST", `${mbase}/automations/${created.body.data.id}/versions/${draft.body.data.id}/approve`, { stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") });
    assert.equal(published.status, 200, published.text);
    assert.equal((await call("erin", "POST", `${mbase}/automations/${created.body.data.id}/activate`)).status, 200);
    return { id: created.body.data.id, versionId: draft.body.data.id };
  };
  const counts = async () => ({
    jobs: await client.mailOutboxJob.count(),
    enrollments: await client.marketingAutomationEnrollment.count(),
    stepRuns: await client.marketingAutomationStepRun.count(),
    triggerEvents: await client.marketingTriggerEvent.count(),
    providerCalls: providerCalls.length,
    emails: fake.state.emails.length,
  });
  return { client, harness, call, cf, kg: brands.karryam, mbase, fake, providerCalls, work, stepUp, newContact, templateVersionId, publish, counts, ids, base };
}

test("final gap 4: automation test mode, replay / recovery and recipient time zones on PostgreSQL", { timeout: 600000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const ctx = await setup(t);
  const { client, harness, call, cf, kg, mbase, fake, work, stepUp, newContact, templateVersionId, publish, counts, ids, base } = ctx;
  const automations = harness.mail.services.automations;

  await t.test("test mode: read-only evaluation with DST delays, windows, personalization and consent", async () => {
    const definition = { topic: "newsletter", entryStepId: "welcome", steps: [
      { id: "welcome", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, next: "wait" },
      { id: "wait", type: "delay", minutes: 0, until: { localTime: "02:30", timezone: "recipient" }, next: "check" },
      { id: "check", type: "condition", condition: { field: "event.city", op: "equals", value: "Lagos" }, then: "followup", else: "done" },
      { id: "followup", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, window: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }, next: null },
      { id: "done", type: "exit" },
    ] };
    const automation = await publish("Gap4 test mode", "PRODUCT_EVENT", definition, { eventType: "karryam.booking.completed", version: 1 }, { enrollmentLimit: 3 });
    const ny = await newContact("ny-test@reader.example", "newsletter", { lastName: "Reader", attributes: { timezone: "America/New_York" } });
    await work(2);
    const before = await counts();
    const testUrl = `${mbase}/automations/${automation.id}/versions/${automation.versionId}/test`;
    const result = await call("dave", "POST", testUrl, { contactId: ny.id, now: "2026-03-07T12:00:00.000Z", event: { eventType: "karryam.booking.completed", version: 1, payload: { city: "Lagos", cardNumber: "4111" } } });
    assert.equal(result.status, 200, result.text);
    const data = result.body.data;
    assert.equal(data.mode, "TEST");
    assert.equal(data.sideEffects, "NONE");
    assert.equal(data.validation.ok, true, JSON.stringify(data.validation));
    assert.equal(data.trigger.matches, true);
    assert.deepEqual(data.trigger.simulatedEvent.droppedFields, ["cardNumber"], "payload minimised like a real event");
    assert.equal(data.contact.timeZone, "America/New_York");
    assert.equal(data.contact.timeZoneSource, "RECIPIENT");
    assert.equal(data.eligibility.consent.ok, true);
    assert.equal(data.eligibility.wouldEnroll, true);
    assert.deepEqual(data.path.map((entry) => entry.stepId), ["welcome", "wait", "check", "followup"]);
    const [welcome, wait, check, followup] = data.path;
    assert.equal(welcome.action, "WOULD_SEND");
    assert.equal(welcome.personalization.subject, "News for ny-test");
    assert.deepEqual(welcome.personalization.missingVariables, []);
    assert.equal(welcome.template.versionId, templateVersionId);
    assert.equal(typeof welcome.template.classificationAvailable, "boolean");
    // Spring forward: 02:30 does not exist on 2026-03-08 in New York -> 03:30 EDT.
    assert.equal(wait.runAt, "2026-03-08T07:30:00.000Z");
    assert.equal(wait.localRunAt, "2026-03-08T03:30:00-04:00");
    assert.equal(wait.shiftedMinutes, 60);
    assert.equal(check.result, true);
    assert.equal(check.branch, "then");
    // Sunday -> the weekday window opens Monday 09:00 EDT.
    assert.equal(followup.holds[0].reason, "DELIVERY_WINDOW");
    assert.equal(followup.sendAt, "2026-03-09T13:00:00.000Z");
    assert.equal(followup.localSendAt, "2026-03-09T09:00:00-04:00");
    assert.equal(data.expected.sends, 2);
    assert.equal(data.expected.outcome, "COMPLETED");

    // Synthetic contact: missing time zone -> brand default, recorded; missing variables listed.
    const synthetic = await call("erin", "POST", testUrl, { contact: { email: "synthetic@reader.example" }, now: "2026-10-30T12:00:00.000Z", event: { payload: { city: "Abuja" } } });
    assert.equal(synthetic.status, 200, synthetic.text);
    assert.equal(synthetic.body.data.contact.kind, "SYNTHETIC");
    assert.equal(synthetic.body.data.contact.timeZone, "Africa/Lagos");
    assert.equal(synthetic.body.data.contact.timeZoneFallback, true);
    assert.equal(synthetic.body.data.contact.fallbackReason, "RECIPIENT_TIMEZONE_MISSING");
    assert.deepEqual(synthetic.body.data.path[0].personalization.missingVariables, ["first_name", "last_name"]);
    assert.equal(synthetic.body.data.path.at(-1).stepId, "done", "else branch");
    // Withdrawn consent: the path exits at the first send.
    const withdrawn = await call("dave", "POST", testUrl, { contact: { email: "w@reader.example", consentStatus: "WITHDRAWN", timezone: "Europe/London" } });
    assert.equal(withdrawn.body.data.expected.outcome, "EXITED");
    assert.equal(withdrawn.body.data.expected.reason, "CONSENT_NOT_GRANTED");
    // Invalid time zone -> 422; brand isolation.
    const invalid = await call("dave", "POST", testUrl, { contact: { email: "x@reader.example", timezone: "Mars/Olympus" } });
    assert.equal(invalid.status, 422, invalid.text);
    assert.equal(invalid.body.errors[0].field, "contact.timezone");
    assert.equal((await call("kim", "POST", testUrl, { contactId: ny.id })).status, 404);
    const kgContact = await client.marketingContact.create({ data: { organizationId: kg.organization.id, email: "kg-only@reader.example", source: "manual", createdBy: ctx.ids.kim } });
    assert.equal((await call("dave", "POST", testUrl, { contactId: kgContact.id })).status, 404, "contacts of another brand are invisible");

    // Duplicate delivery preview: an event id already received never enrolls twice.
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.booking.completed", version: 1, eventId: "gap4-dup-1", contactEmail: "ny-test@reader.example", payload: { city: "Lagos" } });
    const afterIngest = await counts();
    const duplicate = await call("dave", "POST", testUrl, { contactId: ny.id, event: { eventId: "gap4-dup-1", payload: { city: "Lagos" } } });
    assert.equal(duplicate.body.data.trigger.duplicate.eventIdSeen, true);
    assert.equal(duplicate.body.data.trigger.matches, false);
    assert.equal(duplicate.body.data.eligibility.wouldEnroll, false);

    // Nothing was created by any test run: no job, enrollment, step run, trigger event or provider call.
    const after = await counts();
    assert.deepEqual({ ...after, triggerEvents: after.triggerEvents - (afterIngest.triggerEvents - before.triggerEvents) }, before);
    const audits = await client.mailAuditEvent.findMany({ where: { action: "MARKETING_AUTOMATION_TESTED", targetId: automation.id } });
    assert.equal(audits.length, 4, "every test run is audited (refused input is not)");
    assert.ok(audits.every((row) => !JSON.stringify(row.metadata).includes("@")), "audit metadata never carries addresses");
    // Pause so the real event above is not processed by later workers.
    assert.equal((await call("dave", "POST", `${mbase}/automations/${automation.id}/pause`)).status, 200);
  });

  await t.test("recipient time zones: fall-back ambiguity, weekend window, brand fallback, missed window sends once", async () => {
    assert.ok(harness.clock().getTime() < Date.parse("2026-10-31T12:30:00.000Z"), "still Saturday midday");
    const automation = await publish("Gap4 local time", "CONSENT_GRANTED", { topic: "tips", entryStepId: "wait", steps: [
      { id: "wait", type: "delay", minutes: 0, until: { localTime: "01:30", timezone: "recipient" }, next: "send" },
      { id: "send", type: "send_email", templateVersionId, senderAddressId: cf.sender.id, window: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }, next: null },
    ] }, { topic: "tips" });
    // Saturday 2026-10-31 ~12:05Z.
    const ny = await newContact("ny@reader.example", "tips", { attributes: { timezone: "America/New_York" } });
    const nozone = await newContact("nozone@reader.example", "tips");
    const auckland = await newContact("akl@reader.example", "tips", { attributes: { timezone: "Pacific/Auckland" } });
    await work(2, 30000);
    const runOf = async (contact, stepId) => client.marketingAutomationStepRun.findFirst({ where: { stepId, enrollment: { automationId: automation.id, contactId: contact.id } } });
    const enrollmentOf = (contact) => client.marketingAutomationEnrollment.findFirst({ where: { automationId: automation.id, contactId: contact.id } });
    const nyWait = await runOf(ny, "wait");
    assert.equal(nyWait.outcome.runAt, "2026-11-01T05:30:00.000Z", "first 01:30 (EDT) of the fall-back day");
    assert.equal(nyWait.outcome.ambiguous, true);
    assert.equal(nyWait.outcome.localRunAt, "2026-11-01T01:30:00-04:00");
    assert.equal(nyWait.outcome.timeZoneSource, "RECIPIENT");
    const noWait = await runOf(nozone, "wait");
    assert.equal(noWait.outcome.timeZone, "Africa/Lagos");
    assert.equal(noWait.outcome.timeZoneSource, "BRAND_DEFAULT");
    assert.equal(noWait.outcome.fallbackReason, "RECIPIENT_TIMEZONE_MISSING", "the fallback is recorded on the step run");
    assert.equal(noWait.outcome.runAt, "2026-11-01T00:30:00.000Z");
    assert.equal((await enrollmentOf(ny)).status, "WAITING");

    // Sunday: every send is outside the weekday window -> waits for Monday.
    harness.advance(Date.parse("2026-11-01T06:00:00.000Z") - harness.clock().getTime());
    await work(2);
    assert.equal(fake.state.emails.filter((email) => ["ny@reader.example", "nozone@reader.example", "akl@reader.example"].includes(email.to[0].address)).length, 0);
    const nyWaiting = await enrollmentOf(ny);
    assert.equal(nyWaiting.status, "WAITING");
    assert.equal(nyWaiting.nextRunAt.toISOString(), "2026-11-02T14:00:00.000Z", "Monday 09:00 EST (after the fall-back)");
    assert.equal(nyWaiting.context.lastDeferral.reason, "OUTSIDE_WINDOW");
    assert.equal((await enrollmentOf(nozone)).nextRunAt.toISOString(), "2026-11-02T08:00:00.000Z", "Monday 09:00 Lagos (brand default)");
    assert.equal((await enrollmentOf(auckland)).nextRunAt.toISOString(), "2026-11-01T20:00:00.000Z", "Monday 09:00 NZDT");

    // Worker down until Monday 15:00Z: Auckland's Monday window (20:00Z-04:00Z) was missed.
    harness.advance(Date.parse("2026-11-02T15:00:00.000Z") - harness.clock().getTime());
    await work(2);
    const sentTo = (address) => fake.state.emails.filter((email) => email.to[0].address === address);
    assert.equal(sentTo("ny@reader.example").length, 1);
    assert.equal(sentTo("nozone@reader.example").length, 1);
    assert.equal(sentTo("akl@reader.example").length, 0, "outside Auckland's window now");
    const akl = await enrollmentOf(auckland);
    assert.equal(akl.context.lastDeferral.reason, "WINDOW_MISSED");
    assert.ok(akl.context.lastDeferral.missedBySeconds > 3600);
    assert.equal(akl.nextRunAt.toISOString(), "2026-11-02T20:00:00.000Z", "next opening: Tuesday 09:00 NZDT");
    const nySend = await runOf(ny, "send");
    assert.equal(nySend.status, "SUCCEEDED");
    assert.equal(nySend.outcome.timing.deferral.reason, "OUTSIDE_WINDOW");
    assert.equal(nySend.outcome.timing.timeZone, "America/New_York");
    assert.equal(typeof nySend.outcome.timing.latenessSeconds, "number");
    harness.advance(Date.parse("2026-11-02T21:00:00.000Z") - harness.clock().getTime());
    await work(3);
    assert.equal(sentTo("akl@reader.example").length, 1, "sent once at the next opening, never caught up twice");
    const aklSend = await runOf(auckland, "send");
    assert.equal(aklSend.outcome.timing.deferral.reason, "WINDOW_MISSED");
    assert.ok(aklSend.outcome.timing.latenessSeconds >= 0);
    await work(3, 3600000);
    assert.equal(sentTo("akl@reader.example").length, 1);
  });

  await t.test("contact time zones are validated on the API and in CSV previews", async () => {
    const bad = await call("dave", "POST", `${mbase}/contacts`, { email: "tz-bad@reader.example", attributes: { timezone: "Mars/Olympus" } });
    assert.equal(bad.status, 422, bad.text);
    assert.equal(bad.body.errors[0].field, "attributes.timezone");
    const good = await call("dave", "POST", `${mbase}/contacts`, { email: "tz-good@reader.example", attributes: { timezone: "Africa/Lagos" } });
    assert.equal(good.status, 201, good.text);
    assert.equal((await client.marketingContact.findUnique({ where: { id: good.body.data.id } })).attributes.timezone, "Africa/Lagos");
    const patched = await call("dave", "PATCH", `${mbase}/contacts/${good.body.data.id}`, { attributes: { timezone: "Not/AZone" } });
    assert.equal(patched.status, 422, patched.text);
    const csv = new FormData();
    csv.append("file", new Blob(["email,first_name,timezone\ntz-csv1@reader.example,A,Europe/London\ntz-csv2@reader.example,B,Nowhere/Land\n"], { type: "text/csv" }), "tz.csv");
    csv.append("topic", "tips");
    csv.append("source", "EVENT");
    csv.append("policyVersion", "2026-10");
    csv.append("evidenceReference", "tz-sheet");
    csv.append("attestOptIn", "true");
    // The harness caller sends JSON; multipart goes through fetch directly.
    const raw = await fetch(`${base}${mbase}/contacts/import`, { method: "POST", headers: { "x-test-user": ids.dave }, body: csv });
    const preview = { status: raw.status, text: await raw.text() };
    preview.body = JSON.parse(preview.text);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.data.dryRun, true);
    assert.equal(preview.body.data.counts.invalid, 1);
    assert.ok(preview.body.data.rows.some((row) => row.reason === "INVALID_TIMEZONE" && row.email === "tz-csv2@reader.example"));
  });

  await t.test("template classification: a version classified TRANSACTIONAL after approval never sends from an automation", async () => {
    // A version without a classification snapshot (as before migration 37) is MARKETING.
    const source = await client.marketingTemplateVersion.findUnique({ where: { id: templateVersionId } });
    const { id: _id, createdAt: _createdAt, ...copy } = source;
    const unsnapshotted = await client.marketingTemplateVersion.create({ data: { ...copy, version: source.version + 50, blocks: source.blocks, brand: source.brand ?? undefined } });
    const automation = await publish("Gap4 classification", "PRODUCT_EVENT", { topic: "newsletter", steps: [{ id: "hello", type: "send_email", templateVersionId: unsnapshotted.id, senderAddressId: cf.sender.id }] }, { eventType: "karryam.account.registered", version: 1 });
    // After approval the version gets a TRANSACTIONAL snapshot.
    await client.$executeRawUnsafe(`INSERT INTO marketing_template_version_policies (version_id, classification) VALUES ('${unsnapshotted.id}', 'TRANSACTIONAL')`);
    const contact = await newContact("classified@reader.example");
    await work(2);
    const tested = await call("dave", "POST", `${mbase}/automations/${automation.id}/versions/${automation.versionId}/test`, { contactId: contact.id });
    assert.equal(tested.body.data.path[0].action, "WOULD_FAIL");
    assert.equal(tested.body.data.path[0].reason, "TEMPLATE_NOT_MARKETING");
    assert.equal(tested.body.data.path[0].template.classification, "TRANSACTIONAL");
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.account.registered", version: 1, eventId: `reg-${crypto.randomUUID()}`, contactEmail: contact.email, payload: { plan: "free" } });
    await work(3);
    assert.equal(fake.state.emails.filter((email) => email.to[0].address === "classified@reader.example").length, 0, "not sent");
    const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: automation.id, contactId: contact.id } });
    assert.equal(enrollment.status, "FAILED");
    assert.equal(enrollment.exitReason, "TEMPLATE_NOT_MARKETING");
    const run = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: enrollment.id } });
    assert.equal(run.status, "FAILED");
    assert.equal(run.errorCode, "TEMPLATE_NOT_MARKETING");
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_AUTOMATION_SEND_BLOCKED", targetId: automation.id, metadata: { path: ["reason"], equals: "TEMPLATE_NOT_MARKETING" } } }), "audited");
    assert.equal((await call("erin", "POST", `${mbase}/automations/${automation.id}/pause`)).status, 200);
  });

  // ------------------------------------------------------------- replays
  const replayAutomation = await publish("Gap4 replay", "PRODUCT_EVENT", { topic: "newsletter", steps: [{ id: "thanks", type: "send_email", templateVersionId, senderAddressId: cf.sender.id }] }, { eventType: "karryam.subscription.renewed", version: 1 }, { enrollmentLimit: 10 });
  const rbase = `${mbase}/automations/${replayAutomation.id}`;
  const fire = async (contact, eventId = `renew-${crypto.randomUUID()}`) => {
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId, contactEmail: contact.email, payload: { plan: "gold" } });
    await work(2);
    const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: contact.id }, orderBy: { createdAt: "desc" } });
    const run = enrollment ? await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: enrollment.id } }) : null;
    return { enrollment, run };
  };
  const replay = (key, body) => call(key, "POST", `${rbase}/replays`, body);
  const sentTo = (address) => fake.state.emails.filter((email) => email.to[0].address === address).length;

  await t.test("replay: dry run is a plan without changes; execute needs approver + step-up; concurrent executes run once; successful sends are never replayed", async () => {
    const contact = await newContact("r-failed@reader.example");
    await work(2);
    fake.failNext("sendEmail", "PERMANENT", "RESEND_HTTP_422");
    const { enrollment, run } = await fire(contact);
    assert.equal(run.status, "FAILED");
    assert.equal(enrollment.status, "FAILED");
    const recovery = await call("dave", "GET", `${rbase}/recovery`);
    assert.equal(recovery.status, 200, recovery.text);
    assert.ok(recovery.body.data.failedStepRuns.items.some((item) => item.id === run.id));

    const before = await counts();
    const dry = await replay("dave", { scope: "STEP_RUN", targetId: run.id, reason: "Provider rejected; template fixed" });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.body.data.replay.mode, "DRY_RUN");
    assert.equal(dry.body.data.replay.status, "PLANNED");
    assert.equal(dry.body.data.plan.action, "RETRY_FAILED_SEND");
    assert.equal(dry.body.data.plan.idempotency.reused, false);
    assert.equal(dry.body.data.plan.versionId, enrollment.versionId, "same immutable version");
    assert.deepEqual(await counts(), before, "dry run changes nothing");
    assert.equal((await client.marketingAutomationStepRun.findUnique({ where: { id: run.id } })).status, "FAILED");
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).status, "FAILED");

    assert.equal((await replay("dave", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Retry", stepUpId: "x" })).status, 403, "authors cannot execute");
    const noStepUp = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Retry now" });
    assert.equal(noStepUp.body.code, "MAIL_STEP_UP_REQUIRED");
    const wrongPurpose = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Retry now", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_PUBLISH") });
    assert.equal(wrongPurpose.body.code, "MAIL_STEP_UP_REQUIRED", "purpose-bound step-up");
    assert.equal((await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", stepUpId: "x" })).status, 400, "a reason is required");

    const [one, two] = [await stepUp("erin", "MARKETING_AUTOMATION_REPLAY"), await stepUp("erin", "MARKETING_AUTOMATION_REPLAY")];
    const results = await Promise.all([one, two].map((stepUpId) => replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Template fixed, retry", stepUpId })));
    const statuses = results.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409], results.map((response) => response.text).join(" | "));
    const executed = await client.marketingAutomationReplay.count({ where: { stepRunId: run.id, mode: "EXECUTE", status: "EXECUTED" } });
    assert.equal(executed, 1, "exactly one executed replay per step run");
    const refused = results.find((response) => response.status === 409);
    assert.ok(["ALREADY_REPLAYED", "STEP_IN_PROGRESS"].includes(refused.body.errors[0].reason), refused.text);
    await work(2);
    assert.equal(sentTo("r-failed@reader.example"), 1);
    const done = await client.marketingAutomationStepRun.findUnique({ where: { id: run.id } });
    assert.equal(done.status, "SUCCEEDED");
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).status, "COMPLETED");
    // A successful send is never replayed.
    const again = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Again please", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(again.status, 409);
    assert.equal(again.body.errors[0].reason, "PROVIDER_ACCEPTED");
    const enrollmentReplay = await replay("erin", { scope: "ENROLLMENT", targetId: enrollment.id, reason: "Check enrollment" });
    assert.equal(enrollmentReplay.body.data.plan.refusal.code, "ENROLLMENT_COMPLETED");
    await work(2);
    assert.equal(sentTo("r-failed@reader.example"), 1, "no duplicate external send");
    const historyRows = await call("erin", "GET", `${rbase}/replays`);
    assert.ok(historyRows.body.data.items.some((row) => row.status === "EXECUTED"));
    assert.ok(historyRows.body.data.items.some((row) => row.status === "REFUSED"));
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MARKETING_AUTOMATION_REPLAY_EXECUTED", targetId: replayAutomation.id } }));
  });

  await t.test("replay: OUTCOME_UNKNOWN needs acknowledgement, reuses the idempotency key (provider deduplicates); refused after the window", async () => {
    const contact = await newContact("r-unknown@reader.example");
    await work(2);
    fake.failNext("sendEmail", "IDEMPOTENCY_CONFLICT", "PROVIDER_IDEMPOTENCY_CONFLICT", { acceptBeforeFailing: true });
    const { run } = await fire(contact);
    assert.equal(run.status, "OUTCOME_UNKNOWN");
    assert.equal(sentTo("r-unknown@reader.example"), 1, "the provider accepted it before the response was lost");
    const original = fake.state.byIdempotency.get(run.idempotencyKey);
    const dry = await replay("erin", { scope: "STEP_RUN", targetId: run.id, reason: "Resolve unknown outcome" });
    assert.equal(dry.body.data.plan.requiresAcknowledgement, true);
    assert.equal(dry.body.data.plan.idempotency.reused, true);
    assert.equal(dry.body.data.plan.idempotency.key, run.idempotencyKey);
    const unacknowledged = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Resolve unknown outcome", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(unacknowledged.status, 409);
    assert.equal(unacknowledged.body.errors[0].reason, "UNKNOWN_OUTCOME_ACKNOWLEDGEMENT_REQUIRED");
    const executed = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Resolve unknown outcome", acknowledgeUnknownOutcome: true, stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(executed.status, 200, executed.text);
    assert.equal(executed.body.data.outcome.idempotencyKeyReused, true);
    await work(2);
    const settled = await client.marketingAutomationStepRun.findUnique({ where: { id: run.id } });
    assert.equal(settled.status, "SUCCEEDED");
    assert.equal(settled.providerMessageId, original, "the provider returned the original message");
    assert.equal(sentTo("r-unknown@reader.example"), 1, "provider deduplicated: still one email");

    // Outside the idempotency window: refused, never resent.
    const late = await newContact("r-late@reader.example");
    await work(2);
    fake.failNext("sendEmail", "IDEMPOTENCY_CONFLICT", "PROVIDER_IDEMPOTENCY_CONFLICT", { acceptBeforeFailing: true });
    const { run: lateRun } = await fire(late);
    assert.equal(lateRun.status, "OUTCOME_UNKNOWN");
    harness.advance(24 * 3600000);
    const lateDry = await replay("erin", { scope: "STEP_RUN", targetId: lateRun.id, reason: "Resolve late unknown" });
    assert.equal(lateDry.body.data.plan.refusal.code, "IDEMPOTENCY_WINDOW_EXPIRED");
    assert.match(lateDry.body.data.plan.refusal.message, /idempotency window/);
    const lateExecute = await replay("erin", { scope: "STEP_RUN", targetId: lateRun.id, mode: "EXECUTE", reason: "Resolve late unknown", acknowledgeUnknownOutcome: true, stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(lateExecute.status, 409);
    assert.equal(lateExecute.body.errors[0].reason, "IDEMPOTENCY_WINDOW_EXPIRED");
    await work(2);
    assert.equal(sentTo("r-late@reader.example"), 1);
  });

  await t.test("replay: consent withdrawn or automation paused before replay -> refused, no send", async () => {
    const contact = await newContact("r-consent@reader.example");
    await work(2);
    fake.failNext("sendEmail", "PERMANENT", "RESEND_HTTP_422");
    const { run } = await fire(contact);
    assert.equal(run.status, "FAILED");
    await call("dave", "POST", `${mbase}/contacts/${contact.id}/consents/newsletter/withdraw`, { source: "admin" });
    assert.equal((await client.marketingConsent.findFirst({ where: { contactId: contact.id } })).status, "WITHDRAWN");
    const dry = await replay("erin", { scope: "STEP_RUN", targetId: run.id, reason: "Retry after fix" });
    assert.equal(dry.body.data.plan.refusal.code, "CONSENT_NOT_GRANTED");
    const execute = await replay("erin", { scope: "STEP_RUN", targetId: run.id, mode: "EXECUTE", reason: "Retry after fix", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(execute.status, 409);
    assert.equal(execute.body.errors[0].reason, "CONSENT_NOT_GRANTED");
    await work(2);
    assert.equal(sentTo("r-consent@reader.example"), 0);

    const paused = await newContact("r-paused@reader.example");
    await work(2);
    fake.failNext("sendEmail", "PERMANENT", "RESEND_HTTP_422");
    const { run: pausedRun } = await fire(paused);
    assert.equal((await call("erin", "POST", `${rbase}/pause`)).status, 200);
    const refused = await replay("erin", { scope: "STEP_RUN", targetId: pausedRun.id, reason: "Retry while paused" });
    assert.equal(refused.body.data.plan.refusal.code, "AUTOMATION_PAUSED");
    assert.equal((await call("erin", "POST", `${rbase}/activate`)).status, 200);
    const allowed = await replay("erin", { scope: "STEP_RUN", targetId: pausedRun.id, reason: "Retry when active" });
    assert.equal(allowed.body.data.plan.refusal, null);
  });

  await t.test("recovery: dead-lettered job requeued with its original key; interrupted worker recovered; partial execution resumed without resending", async () => {
    // Dead letter: retryable failures until the attempt budget is exhausted.
    const dl = await newContact("r-dead@reader.example");
    await work(2);
    fake.failNext("sendEmail", "RETRYABLE", "PROVIDER_5XX");
    fake.failNext("sendEmail", "RETRYABLE", "PROVIDER_5XX");
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId: `renew-dl-${crypto.randomUUID()}`, contactEmail: dl.email, payload: { plan: "gold" } });
    await work(1);
    const dlEnrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: dl.id } });
    const stepJob = await client.mailOutboxJob.findFirst({ where: { kind: "AUTOMATION_STEP", payload: { path: ["enrollmentId"], equals: dlEnrollment.id } } });
    await client.mailOutboxJob.update({ where: { id: stepJob.id }, data: { maxAttempts: Math.max(stepJob.attemptCount + 1, 2) } });
    await work(3);
    const dead = await client.mailOutboxJob.findUnique({ where: { id: stepJob.id } });
    assert.equal(dead.status, "DEAD_LETTER", JSON.stringify(dead));
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: dlEnrollment.id } })).status, "FAILED");
    const recovery = await call("erin", "GET", `${rbase}/recovery`);
    assert.ok(recovery.body.data.deadLetterJobs.items.some((item) => item.id === stepJob.id));
    const dlPlan = await replay("erin", { scope: "DEAD_LETTER_JOB", targetId: stepJob.id, reason: "Provider outage over" });
    assert.equal(dlPlan.body.data.plan.requiresAcknowledgement, true, "the dead-lettered attempt's outcome is unknown");
    const requeued = await replay("erin", { scope: "DEAD_LETTER_JOB", targetId: stepJob.id, mode: "EXECUTE", reason: "Provider outage over", acknowledgeUnknownOutcome: true, stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(requeued.status, 200, requeued.text);
    assert.equal(requeued.body.data.outcome.jobId, stepJob.id, "the same job is requeued");
    assert.equal(requeued.body.data.outcome.jobIdempotencyKey, stepJob.idempotencyKey, "with its original idempotency key");
    await work(2);
    assert.equal((await client.mailOutboxJob.findUnique({ where: { id: stepJob.id } })).status, "SUCCEEDED");
    assert.equal(sentTo("r-dead@reader.example"), 1);
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: dlEnrollment.id } })).status, "COMPLETED");

    // Interrupted worker: the provider accepted, the response was lost, and the job vanished with the worker.
    const lost = await newContact("r-interrupted@reader.example");
    await work(2);
    fake.failNext("sendEmail", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId: `renew-int-${crypto.randomUUID()}`, contactEmail: lost.email, payload: { plan: "gold" } });
    await work(1);
    const lostEnrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: lost.id } });
    const lostRun = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: lostEnrollment.id } });
    assert.equal(lostRun.status, "RUNNING");
    const inProgress = await replay("erin", { scope: "STEP_RUN", targetId: lostRun.id, reason: "Worker crashed" });
    assert.equal(inProgress.body.data.plan.refusal.code, "STEP_IN_PROGRESS", "its retry job is still live");
    const lostJobs = await client.mailOutboxJob.updateMany({ where: { kind: "AUTOMATION_STEP", status: { in: ["PENDING", "RETRY_SCHEDULED", "LEASED"] }, payload: { path: ["enrollmentId"], equals: lostEnrollment.id } }, data: { status: "CANCELLED" } });
    assert.equal(lostJobs.count, 1);
    harness.advance(5 * 60000);
    const interrupted = await call("erin", "GET", `${rbase}/recovery`);
    assert.ok(interrupted.body.data.interruptedStepRuns.items.some((item) => item.id === lostRun.id));
    const recoverPlan = await replay("erin", { scope: "STEP_RUN", targetId: lostRun.id, reason: "Worker crashed" });
    assert.equal(recoverPlan.body.data.plan.action, "RECOVER_INTERRUPTED_SEND");
    assert.equal(recoverPlan.body.data.plan.idempotency.reused, true);
    const recovered = await replay("erin", { scope: "STEP_RUN", targetId: lostRun.id, mode: "EXECUTE", reason: "Worker crashed", acknowledgeUnknownOutcome: true, stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(recovered.status, 200, recovered.text);
    await work(2);
    assert.equal((await client.marketingAutomationStepRun.findUnique({ where: { id: lostRun.id } })).status, "SUCCEEDED");
    assert.equal(sentTo("r-interrupted@reader.example"), 1, "deduplicated by the reused key");

    // Partial execution: the send was recorded but the enrollment never advanced.
    const partial = await newContact("r-partial@reader.example");
    await work(2);
    const { enrollment: partialEnrollment, run: partialRun } = await fire(partial);
    assert.equal(partialRun.status, "SUCCEEDED");
    await client.marketingAutomationEnrollment.update({ where: { id: partialEnrollment.id }, data: { status: "FAILED", exitReason: "WORKER_CRASH", stepCount: partialRun.sequence, currentStepId: partialRun.stepId, completedAt: null } });
    const partialPlan = await replay("erin", { scope: "ENROLLMENT", targetId: partialEnrollment.id, reason: "Crash after send" });
    assert.equal(partialPlan.body.data.plan.action, "ADVANCE_PAST_SUCCEEDED_STEP");
    assert.equal((await replay("erin", { scope: "STEP_RUN", targetId: partialRun.id, reason: "Crash after send" })).body.data.plan.refusal.code, "PROVIDER_ACCEPTED");
    const resumed = await replay("erin", { scope: "ENROLLMENT", targetId: partialEnrollment.id, mode: "EXECUTE", reason: "Crash after send", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(resumed.status, 200, resumed.text);
    await work(2);
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: partialEnrollment.id } })).status, "COMPLETED");
    assert.equal(sentTo("r-partial@reader.example"), 1, "resumed without resending");
  });

  await t.test("duplicate trigger delivery never creates a second enrollment; replay refuses to create one", async () => {
    const contact = await newContact("r-dup@reader.example");
    await work(2);
    const eventId = `renew-dup-${crypto.randomUUID()}`;
    const first = await fire(contact, eventId);
    const second = await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId, contactEmail: contact.email, payload: { plan: "gold" } });
    assert.equal(second.duplicate, true);
    // Even a re-processed trigger event dedupes on the enrollment key.
    await client.marketingTriggerEvent.updateMany({ where: { eventId }, data: { status: "RECEIVED" } });
    await work(2);
    assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: replayAutomation.id, contactId: contact.id } }), 1);
    assert.equal(sentTo("r-dup@reader.example"), 1);
    const refusal = await replay("erin", { scope: "ENROLLMENT", targetId: first.enrollment.id, mode: "EXECUTE", reason: "Send again", stepUpId: await stepUp("erin", "MARKETING_AUTOMATION_REPLAY") });
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.errors[0].reason, "ENROLLMENT_COMPLETED");
    assert.equal(await client.marketingAutomationEnrollment.count({ where: { automationId: replayAutomation.id, contactId: contact.id } }), 1);
  });

  // Re-audit regressions (duplicate-send safety).
  await t.test("re-audit: a DB failure after provider acceptance keeps the run RUNNING with the message id and never resends", async () => {
    const contact = await newContact("r-dbfail@reader.example");
    await work(2);
    // Real PostgreSQL fault: the success write (status -> SUCCEEDED) fails.
    await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION reaudit_fail_success() RETURNS trigger AS $$ BEGIN IF NEW.status = 'SUCCEEDED' AND NEW.recipient_email = 'r-dbfail@reader.example' THEN RAISE EXCEPTION 'injected post-send failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await client.$executeRawUnsafe(`CREATE TRIGGER reaudit_fail_success BEFORE UPDATE ON marketing_automation_step_runs FOR EACH ROW EXECUTE FUNCTION reaudit_fail_success()`);
    const sendsBefore = ctx.providerCalls.filter((name) => name === "sendEmail").length;
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId: `renew-dbf-${crypto.randomUUID()}`, contactEmail: contact.email, payload: { plan: "gold" } });
    await work(1);
    const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: contact.id } });
    const run = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: enrollment.id } });
    assert.equal(run.status, "RUNNING", "never FAILED after provider acceptance");
    assert.ok(run.providerMessageId, "the provider message id is recorded");
    assert.equal(run.outcome.recordFailed, true);
    assert.equal(sentTo("r-dbfail@reader.example"), 1);
    // A replay cannot issue a fresh key for it.
    const plan = await replay("erin", { scope: "STEP_RUN", targetId: run.id, reason: "Check post-send failure" });
    assert.equal(plan.body.data.plan.refusal.code, "PROVIDER_ACCEPTED");
    await client.$executeRawUnsafe(`DROP TRIGGER reaudit_fail_success ON marketing_automation_step_runs`);
    await work(3, 600000);
    const settled = await client.marketingAutomationStepRun.findUnique({ where: { id: run.id } });
    assert.equal(settled.status, "SUCCEEDED");
    assert.equal(settled.providerMessageId, run.providerMessageId);
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).status, "COMPLETED");
    assert.equal(ctx.providerCalls.filter((name) => name === "sendEmail").length - sendsBefore, 1, "the retry recorded the success without calling the provider again");
    assert.equal(sentTo("r-dbfail@reader.example"), 1);

    // A FAILED run whose error is not a definitive provider rejection (as the
    // old code recorded DB errors) is replayed like an unknown outcome.
    const legacy = await newContact("r-legacyfail@reader.example");
    await work(2);
    fake.failNext("sendEmail", "PERMANENT", "RESEND_HTTP_422");
    const { run: legacyRun } = await fire(legacy);
    await client.marketingAutomationStepRun.update({ where: { id: legacyRun.id }, data: { errorCode: "PROVIDER_REJECTED" } });
    const legacyPlan = await replay("erin", { scope: "STEP_RUN", targetId: legacyRun.id, reason: "Unclassified failure" });
    assert.equal(legacyPlan.body.data.plan.action, "RETRY_UNKNOWN_SEND");
    assert.equal(legacyPlan.body.data.plan.idempotency.reused, true);
    assert.equal(legacyPlan.body.data.plan.requiresAcknowledgement, true);
    await client.marketingAutomationStepRun.update({ where: { id: legacyRun.id }, data: { firstAttemptAt: new Date(harness.clock().getTime() - 24 * 3600000) } });
    const expired = await replay("erin", { scope: "STEP_RUN", targetId: legacyRun.id, reason: "Unclassified failure" });
    assert.equal(expired.body.data.plan.refusal.code, "IDEMPOTENCY_WINDOW_EXPIRED", "never a fresh key for an unproven failure");
  });

  await t.test("re-audit: a RUNNING send older than the idempotency window becomes OUTCOME_UNKNOWN; quota refusals restart the window", async () => {
    const contact = await newContact("r-stale@reader.example");
    await work(2);
    fake.failNext("sendEmail", "AMBIGUOUS", "PROVIDER_TIMEOUT", { acceptBeforeFailing: true });
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId: `renew-stale-${crypto.randomUUID()}`, contactEmail: contact.email, payload: { plan: "gold" } });
    await work(1);
    const enrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: contact.id } });
    const run = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: enrollment.id } });
    assert.equal(run.status, "RUNNING");
    // The retry waited (pause / frequency cap / backlog) past the window.
    await client.marketingAutomationStepRun.update({ where: { id: run.id }, data: { firstAttemptAt: new Date(harness.clock().getTime() - 24 * 3600000) } });
    const sendsBefore = ctx.providerCalls.filter((name) => name === "sendEmail").length;
    await work(3, 600000);
    const stale = await client.marketingAutomationStepRun.findUnique({ where: { id: run.id } });
    assert.equal(stale.status, "OUTCOME_UNKNOWN");
    assert.equal(stale.errorCode, "RETRY_OUTSIDE_IDEMPOTENCY_WINDOW");
    assert.equal(ctx.providerCalls.filter((name) => name === "sendEmail").length, sendsBefore, "not re-sent without provider dedupe");
    assert.equal((await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollment.id } })).exitReason, "OUTCOME_UNKNOWN");

    // Quota refusal: definitive, nothing sent -> after a long wait it still sends once.
    const quota = await newContact("r-quota@reader.example");
    await work(2);
    fake.failNext("sendEmail", "QUOTA_EXHAUSTED", "MONTHLY", { now: harness.clock() });
    await automations.ingestProductEvent({ organizationId: cf.organization.id, eventType: "karryam.subscription.renewed", version: 1, eventId: `renew-quota-${crypto.randomUUID()}`, contactEmail: quota.email, payload: { plan: "gold" } });
    await work(1);
    const quotaEnrollment = await client.marketingAutomationEnrollment.findFirst({ where: { automationId: replayAutomation.id, contactId: quota.id } });
    const quotaRun = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId: quotaEnrollment.id } });
    assert.equal(quotaRun.status, "RUNNING");
    assert.equal(quotaRun.outcome.lastAttempt, "QUOTA_REFUSED");
    assert.equal(quotaRun.outcome.keyUnattempted, true);
    harness.advance(25 * 3600000);
    await work(3, 600000);
    const sent = await client.marketingAutomationStepRun.findUnique({ where: { id: quotaRun.id } });
    assert.equal(sent.status, "SUCCEEDED", JSON.stringify(sent));
    assert.ok(sent.firstAttemptAt.getTime() > quotaRun.firstAttemptAt.getTime(), "the window restarted with the first real attempt");
    assert.equal(sentTo("r-quota@reader.example"), 1);
  });

  await t.test("brand isolation for recovery and replays", async () => {
    assert.equal((await call("kim", "GET", `${rbase}/recovery`)).status, 404);
    assert.equal((await call("kim", "GET", `${rbase}/replays`)).status, 404);
    const run = await client.marketingAutomationStepRun.findFirst({ where: { enrollment: { automationId: replayAutomation.id } } });
    assert.equal((await call("kim", "POST", `/marketing/${kg.organization.id}/automations/${replayAutomation.id}/replays`, { scope: "STEP_RUN", targetId: run.id, reason: "cross brand" })).status, 404);
    assert.equal((await call("kim", "POST", `${rbase}/replays`, { scope: "STEP_RUN", targetId: run.id, reason: "cross brand" })).status, 404);
  });
});

test("final gap 4 before migration 37: test mode works (audit only), replay answers 503", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { client, call, cf, mbase, templateVersionId, publish, counts, newContact, work } = await setup(t, { rollback37: true });
  const automation = await publish("Pre-37 automation", "CONSENT_GRANTED", { topic: "newsletter", steps: [{ id: "wait", type: "delay", minutes: 0, until: { localTime: "09:00" }, next: "send" }, { id: "send", type: "send_email", templateVersionId, senderAddressId: cf.sender.id }] }, { topic: "newsletter" });
  const before = await counts();
  const result = await call("dave", "POST", `${mbase}/automations/${automation.id}/versions/${automation.versionId}/test`, { contact: { email: "pre@reader.example", timezone: "Europe/London" } });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.data.path[1].template.classificationAvailable, false, "classification reported unavailable before migration 37");
  assert.deepEqual(await counts(), before);
  for (const [method, url, body] of [["GET", `/automations/${automation.id}/recovery`], ["GET", `/automations/${automation.id}/replays`], ["POST", `/automations/${automation.id}/replays`, { scope: "ENROLLMENT", targetId: crypto.randomUUID(), reason: "pre 37" }]]) {
    const response = await call("erin", method, `${mbase}${url}`, body);
    assert.equal(response.status, 503, `${method} ${url}: ${response.text}`);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }
  // The recipient-time delay keeps working without the new tables.
  const contact = await newContact("pre-run@reader.example", "newsletter", { attributes: { timezone: "America/New_York" } });
  await work(2, 30000);
  const run = await client.marketingAutomationStepRun.findFirst({ where: { stepId: "wait", enrollment: { automationId: automation.id, contactId: contact.id } } });
  assert.equal(run.status, "SUCCEEDED");
  assert.equal(run.outcome.timeZone, "America/New_York");
});

"use strict";

// Automation execution (queue MARKETING):
//   AUTOMATION_TICK  (one per minute bucket, deduplicated by idempotency key)
//     - turns RECEIVED trigger events into enrollments (dedupe per event)
//     - enrolls schedule occurrences (latest due occurrence only; missed
//       occurrences are not backfilled after downtime)
//     - enqueues one AUTOMATION_STEP job per due enrollment step
//   AUTOMATION_STEP  (idempotency key per enrollment + step sequence)
//     - runs exactly the step of the version the enrollment is bound to
//     - send steps re-check consent, suppression, contact status, frequency
//       cap, brand daily cap and the sending gate at the moment of sending
// Paused automations, disabled flags, brand pause and emergency stop defer
// work without consuming attempts or deleting anything.

const { externalSendBlockReason } = require("../../authz/sending-gate");
const { renderTemplate } = require("../template-renderer");
const { unsubscribeUrl } = require("../unsubscribe-token");
const { classifySendError, unsubscribeHeaders } = require("../marketing-sender");
const { evaluateCondition } = require("./definition");
const { nextOccurrence } = require("../scheduling");

function createAutomationProcessor({ client, config, audit, jobs, marketingProviders, eligibility, clock = () => new Date(), logger = null }) {
  const now = () => clock();
  // One job per enrollment step *run time*: a step that waits (delay or
  // frequency cap) is re-enqueued under a new key when it becomes due.
  const stepKey = (enrollment) => `auto-step:${enrollment.id}:${enrollment.stepCount}:${enrollment.nextRunAt ? new Date(enrollment.nextRunAt).getTime() : 0}`;

  async function enqueueStep(tx, enrollment, at = now()) {
    await jobs.enqueue(tx, { queue: "MARKETING", kind: "AUTOMATION_STEP", idempotencyKey: stepKey(enrollment), payload: { enrollmentId: enrollment.id, sequence: enrollment.stepCount, organizationId: enrollment.organizationId }, maxAttempts: 12, nextAttemptAt: at });
  }

  async function enroll(tx, automation, contactId, { dedupeKey, triggerEventId = null, context = null }) {
    const prior = await tx.marketingAutomationEnrollment.count({ where: { automationId: automation.id, contactId } });
    if (prior >= automation.enrollmentLimit) return { skipped: "ENROLLMENT_LIMIT" };
    const active = await tx.marketingAutomationEnrollment.count({ where: { automationId: automation.id, status: { in: ["ACTIVE", "WAITING"] } } });
    if (active >= automation.maxActiveEnrollments) return { skipped: "MAX_ACTIVE_ENROLLMENTS" };
    const version = await tx.marketingAutomationVersion.findUnique({ where: { id: automation.activeVersionId } });
    if (!version || version.status !== "PUBLISHED") return { skipped: "NO_PUBLISHED_VERSION" };
    const created = await tx.marketingAutomationEnrollment.createMany({
      data: [{ automationId: automation.id, versionId: version.id, organizationId: automation.organizationId, contactId, status: "ACTIVE", dedupeKey, triggerEventId, currentStepId: version.definition.entryStepId, nextRunAt: null, context }],
      skipDuplicates: true,
    });
    if (!created.count) return { skipped: "DUPLICATE_TRIGGER" };
    const enrollment = await tx.marketingAutomationEnrollment.findUnique({ where: { automationId_dedupeKey: { automationId: automation.id, dedupeKey } } });
    await enqueueStep(tx, enrollment);
    return { enrolled: enrollment.id };
  }

  function triggerMatches(automation, version, event) {
    if (event.source === "CONSENT") return automation.triggerType === "CONSENT_GRANTED" && event.payload?.topic === version.triggerConfig.topic;
    if (event.source === "PRODUCT") return automation.triggerType === "PRODUCT_EVENT" && event.eventType === `${version.triggerConfig.eventType}@${version.triggerConfig.version}`;
    return false;
  }

  async function processTriggerEvents() {
    const events = await client.marketingTriggerEvent.findMany({ where: { status: "RECEIVED" }, orderBy: { receivedAt: "asc" }, take: config.automation.tickBatch });
    let enrolled = 0;
    for (const event of events) {
      const automations = await client.marketingAutomation.findMany({ where: { organizationId: event.organizationId, status: "ACTIVE", activeVersionId: { not: null } } });
      const outcomes = [];
      await client.$transaction(async (tx) => {
        for (const automation of automations) {
          const version = await tx.marketingAutomationVersion.findUnique({ where: { id: automation.activeVersionId } });
          if (!version || !triggerMatches(automation, version, event) || !event.contactId) continue;
          // Events from before the (latest) activation never enroll retroactively.
          if (!automation.activatedAt || event.occurredAt < automation.activatedAt) continue;
          const result = await enroll(tx, automation, event.contactId, { dedupeKey: `evt:${event.id}`, triggerEventId: event.id, context: event.payload ? { event: event.payload } : null });
          outcomes.push({ automationId: automation.id, ...result });
          if (result.enrolled) enrolled += 1;
        }
        await tx.marketingTriggerEvent.update({ where: { id: event.id }, data: { status: outcomes.some((entry) => entry.enrolled) ? "PROCESSED" : "IGNORED", processedAt: now(), error: outcomes.length ? null : "NO_MATCHING_AUTOMATION" } });
      });
    }
    return { events: events.length, enrolled };
  }

  async function processSchedules() {
    const automations = await client.marketingAutomation.findMany({ where: { status: "ACTIVE", triggerType: "SCHEDULE", activeVersionId: { not: null } }, take: 100 });
    let enrolled = 0;
    for (const automation of automations) {
      const version = await client.marketingAutomationVersion.findUnique({ where: { id: automation.activeVersionId } });
      if (!version) continue;
      const since = (automation.lastScheduledRunAt || automation.updatedAt).getTime();
      let due = null;
      for (let cursor = since, guard = 0; guard < 400; guard += 1) {
        const next = nextOccurrence(version.triggerConfig, cursor);
        if (!next || next.getTime() > now().getTime()) break;
        due = next;
        cursor = next.getTime();
      }
      if (!due) continue;
      const audience = await client.marketingAudience.findUnique({ where: { id: version.triggerConfig.audienceId } });
      const segment = version.triggerConfig.segmentId ? await client.marketingSegment.findUnique({ where: { id: version.triggerConfig.segmentId } }) : null;
      if (!audience || audience.organizationId !== automation.organizationId || audience.status !== "ACTIVE") {
        await client.marketingAutomation.update({ where: { id: automation.id }, data: { lastScheduledRunAt: due } });
        continue;
      }
      const { eligible } = await eligibility({ organizationId: automation.organizationId, audience, segment, topic: version.definition.topic });
      const batch = eligible.slice(0, config.automation.scheduleMaxEnrollmentsPerRun);
      await client.$transaction(async (tx) => {
        for (const contact of batch) {
          const result = await enroll(tx, { ...automation, enrollmentLimit: Number.MAX_SAFE_INTEGER }, contact.id, { dedupeKey: `sched:${due.toISOString()}:${contact.id}` });
          if (result.enrolled) enrolled += 1;
        }
        await tx.marketingAutomation.update({ where: { id: automation.id }, data: { lastScheduledRunAt: due } });
        await audit.record({ action: "MARKETING_AUTOMATION_SCHEDULE_RUN", targetType: "marketing_automation", targetId: automation.id, organizationId: automation.organizationId, metadata: { occurrence: due.toISOString(), eligible: eligible.length, enrolled: batch.length, truncated: eligible.length > batch.length } }, {}, tx);
      });
    }
    return { enrolled };
  }

  // Safety net: due WAITING enrollments whose step job does not exist yet.
  async function enqueueDue() {
    const due = await client.marketingAutomationEnrollment.findMany({ where: { status: { in: ["ACTIVE", "WAITING"] }, nextRunAt: { lte: now() } }, take: config.automation.tickBatch });
    for (const enrollment of due) {
      await client.$transaction(async (tx) => {
        await enqueueStep(tx, enrollment); // key includes this nextRunAt
        await tx.marketingAutomationEnrollment.update({ where: { id: enrollment.id }, data: { nextRunAt: null, status: "ACTIVE" } });
      });
    }
    return { enqueued: due.length };
  }

  async function processTick() {
    if (!config.automationEnabled || config.emergencyStop.marketing) return { skipped: "AUTOMATION_HALTED" };
    const triggers = await processTriggerEvents();
    const schedules = await processSchedules();
    const due = await enqueueDue();
    return { ...triggers, scheduled: schedules.enrolled, ...due };
  }

  // ---------------------------------------------------------------- steps
  async function finish(enrollment, status, reason, tx = client) {
    await tx.marketingAutomationEnrollment.update({ where: { id: enrollment.id }, data: { status, exitReason: reason, nextRunAt: null, completedAt: now() } });
    return { enrollment: status, reason };
  }

  async function advance(enrollment, nextStepId, { delayMinutes = 0, tx = client } = {}) {
    const stepCount = enrollment.stepCount + 1;
    if (!nextStepId) {
      await tx.marketingAutomationEnrollment.update({ where: { id: enrollment.id }, data: { stepCount, currentStepId: null, status: "COMPLETED", nextRunAt: null, completedAt: now() } });
      return { enrollment: "COMPLETED" };
    }
    const runAt = new Date(now().getTime() + delayMinutes * 60000);
    const updated = await tx.marketingAutomationEnrollment.update({ where: { id: enrollment.id }, data: { currentStepId: nextStepId, stepCount, status: delayMinutes ? "WAITING" : "ACTIVE", nextRunAt: delayMinutes ? runAt : null } });
    if (!delayMinutes) await enqueueStep(tx, updated);
    return { advanced: nextStepId, delayMinutes };
  }

  async function haltReason(automation, organizationId) {
    if (!config.automationEnabled) return "AUTOMATION_DISABLED";
    if (config.emergencyStop.marketing) return "MARKETING_EMERGENCY_STOP";
    if (automation.status === "PAUSED" || automation.status === "DRAFT") return "AUTOMATION_PAUSED";
    const settings = await client.marketingBrandSettings.findUnique({ where: { organizationId } });
    if (settings?.dispatchPaused) return "BRAND_DISPATCH_PAUSED";
    return null;
  }

  async function lastMarketingSendAt(organizationId, email, excludeEnrollmentId) {
    const [run, recipient] = await Promise.all([
      client.marketingAutomationStepRun.findFirst({ where: { organizationId, recipientEmail: email, status: "SUCCEEDED", enrollmentId: { not: excludeEnrollmentId } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      client.marketingBroadcastRecipient.findFirst({ where: { organizationId, email, acceptedAt: { not: null } }, orderBy: { acceptedAt: "desc" }, select: { acceptedAt: true } }),
    ]);
    return Math.max(run?.createdAt?.getTime() || 0, recipient?.acceptedAt?.getTime() || 0) || null;
  }

  async function engagementOf(enrollmentId) {
    const previous = await client.marketingAutomationStepRun.findFirst({ where: { enrollmentId, stepType: "send_email", status: "SUCCEEDED" }, orderBy: { sequence: "desc" } });
    const status = previous?.deliveryStatus;
    return { previous_send_delivered: ["DELIVERED"].includes(status), previous_send_opened: Boolean(previous?.outcome?.opened), previous_send_clicked: Boolean(previous?.outcome?.clicked) };
  }

  async function runSend(job, enrollment, automation, version, step, contact, organization) {
    const topic = version.definition.topic;
    const consent = await client.marketingConsent.findUnique({ where: { contactId_topic: { contactId: contact.id, topic } } });
    const suppressed = await client.marketingSuppression.findFirst({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId: organization.id }, { organizationId: null }] } });
    const consentOk = consent && consent.status === "GRANTED" && (!consent.doubleOptIn || consent.confirmedAt);
    if (contact.status !== "ACTIVE" || !consentOk || suppressed) {
      const reason = suppressed ? "SUPPRESSED" : contact.status !== "ACTIVE" ? `CONTACT_${contact.status}` : "CONSENT_NOT_GRANTED";
      await client.$transaction(async (tx) => {
        await tx.marketingAutomationStepRun.create({ data: { enrollmentId: enrollment.id, organizationId: organization.id, stepId: step.id, stepType: step.type, sequence: enrollment.stepCount, status: "SKIPPED", recipientEmail: contact.email, errorCode: reason, createdAt: now() } });
        await finish(enrollment, "EXITED", reason, tx);
        await audit.record({ action: "MARKETING_AUTOMATION_SEND_BLOCKED", targetType: "marketing_automation", targetId: automation.id, organizationId: organization.id, metadata: { enrollmentId: enrollment.id, reason } }, {}, tx);
      });
      return { exited: reason };
    }
    const last = await lastMarketingSendAt(organization.id, contact.email, enrollment.id);
    if (automation.frequencyCapHours > 0 && last && now().getTime() - last < automation.frequencyCapHours * 3600000) {
      const runAt = new Date(last + automation.frequencyCapHours * 3600000);
      await client.marketingAutomationEnrollment.update({ where: { id: enrollment.id }, data: { status: "WAITING", nextRunAt: runAt } });
      return { waiting: "FREQUENCY_CAP", until: runAt.toISOString() };
    }
    const settings = await client.marketingBrandSettings.findUnique({ where: { organizationId: organization.id } });
    const sentToday = await client.marketingAutomationStepRun.count({ where: { organizationId: organization.id, stepType: "send_email", status: "SUCCEEDED", createdAt: { gt: new Date(now().getTime() - 86400000) } } });
    if (sentToday >= (settings?.dailyAutomationCap ?? 500)) return { defer: { seconds: 3600, code: "BRAND_DAILY_AUTOMATION_CAP" } };
    if (!settings?.postalAddress) return { defer: { seconds: 3600, code: "POSTAL_ADDRESS_MISSING" } };
    if (config.unsubscribe.secret.length < 32 || !config.publicApiUrl) return { defer: { seconds: 3600, code: "UNSUBSCRIBE_NOT_CONFIGURED" } };
    const template = await client.marketingTemplateVersion.findUnique({ where: { id: step.templateVersionId }, include: { template: true } });
    const sender = await client.mailAddress.findUnique({ where: { id: step.senderAddressId }, include: { domain: true } });
    const provider = marketingProviders(organization);
    const senderOk = sender && sender.organizationId === organization.id && sender.status === "ACTIVE" && ["SHARED", "SYSTEM", "ALIAS"].includes(sender.kind);
    const blocked = !template || template.template.organizationId !== organization.id ? "TEMPLATE_UNAVAILABLE" : !senderOk ? "SENDER_NOT_AUTHORIZED" : externalSendBlockReason({ config, providerReady: () => provider.configured !== false && provider.name !== "unconfigured", domain: sender.domain });
    if (blocked) {
      if (blocked === "MAIL_PROVIDER_NOT_CONFIGURED" || blocked === "MAIL_SENDING_DISABLED") return { defer: { seconds: 3600, code: blocked } };
      await client.$transaction(async (tx) => {
        await tx.marketingAutomationStepRun.create({ data: { enrollmentId: enrollment.id, organizationId: organization.id, stepId: step.id, stepType: step.type, sequence: enrollment.stepCount, status: "FAILED", recipientEmail: contact.email, templateVersionId: step.templateVersionId, errorCode: blocked, createdAt: now() } });
        await finish(enrollment, "FAILED", blocked, tx);
      });
      return { failed: blocked };
    }
    const idempotencyKey = `auto:${enrollment.id}:${enrollment.stepCount}`;
    let run = await client.marketingAutomationStepRun.findUnique({ where: { enrollmentId_sequence: { enrollmentId: enrollment.id, sequence: enrollment.stepCount } } });
    if (run?.status === "SUCCEEDED") return advance(enrollment, step.next); // crashed after a recorded send
    if (run && run.status !== "RUNNING") return finish(enrollment, "FAILED", run.errorCode || "STEP_NOT_RUNNABLE");
    if (!run) run = await client.marketingAutomationStepRun.create({ data: { enrollmentId: enrollment.id, organizationId: organization.id, stepId: step.id, stepType: step.type, sequence: enrollment.stepCount, status: "RUNNING", idempotencyKey, recipientEmail: contact.email, templateVersionId: step.templateVersionId, firstAttemptAt: now(), createdAt: now() } });
    const link = unsubscribeUrl(config, { organizationId: organization.id, contactId: contact.id, topic });
    const rendered = renderTemplate(
      { subject: step.subjectOverride || template.subject, preheader: template.preheader, blocks: template.blocks, brand: { ...(template.brand || {}), postalAddress: settings.postalAddress } },
      { data: { first_name: contact.firstName || "", last_name: contact.lastName || "", email: contact.email, unsubscribe_url: link, brand_name: organization.name } },
    );
    try {
      const result = await provider.sendEmail({
        idempotencyKey,
        from: { address: sender.address, name: sender.displayName || organization.name },
        replyTo: null,
        to: [{ address: contact.email, name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null }],
        cc: [], bcc: [],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: unsubscribeHeaders(link),
        attachments: [],
      });
      await client.$transaction(async (tx) => {
        await tx.marketingAutomationStepRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", providerMessageId: result.providerMessageId, deliveryStatus: "PROVIDER_ACCEPTED" } });
        await audit.record({ action: "MARKETING_AUTOMATION_EMAIL_HANDED_TO_PROVIDER", targetType: "marketing_automation", targetId: automation.id, organizationId: organization.id, metadata: { enrollmentId: enrollment.id, sequence: enrollment.stepCount } }, {}, tx);
        await advance(enrollment, step.next, { tx });
      });
      return { providerMessageId: result.providerMessageId };
    } catch (error) {
      const verdict = classifySendError(error, { firstAttemptAt: run.firstAttemptAt, now: now(), windowHours: config.reconciliation.idempotencyWindowHours });
      if (verdict.outcome === "RETRY") throw Object.assign(new Error(error.message), { code: verdict.code, retryable: true, retryAfterSeconds: verdict.retryAfterSeconds ?? null });
      if (verdict.outcome === "DEFER") return { defer: { seconds: 3600, code: verdict.code } };
      await client.$transaction(async (tx) => {
        await tx.marketingAutomationStepRun.update({ where: { id: run.id }, data: { status: verdict.outcome === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED", errorCode: verdict.code } });
        await finish(enrollment, "FAILED", verdict.outcome === "UNKNOWN" ? "OUTCOME_UNKNOWN" : verdict.code, tx);
        await audit.record({ action: verdict.outcome === "UNKNOWN" ? "MARKETING_AUTOMATION_OUTCOME_UNKNOWN" : "MARKETING_AUTOMATION_SEND_FAILED", targetType: "marketing_automation", targetId: automation.id, organizationId: organization.id, outcome: verdict.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILURE", metadata: { enrollmentId: enrollment.id, reason: verdict.code } }, {}, tx);
      });
      return { failed: verdict.code };
    }
  }

  async function processStep(job) {
    const enrollment = await client.marketingAutomationEnrollment.findUnique({ where: { id: job.payload?.enrollmentId } });
    if (!enrollment || !["ACTIVE", "WAITING"].includes(enrollment.status) || enrollment.stepCount !== job.payload.sequence) return { skipped: "STALE_STEP" };
    const automation = await client.marketingAutomation.findUnique({ where: { id: enrollment.automationId } });
    if (automation.status === "ARCHIVED") return finish(enrollment, "CANCELLED", "AUTOMATION_ARCHIVED");
    const halted = await haltReason(automation, enrollment.organizationId);
    if (halted) return { defer: { seconds: 300, code: halted } };
    if (enrollment.stepCount >= config.automation.maxStepsPerEnrollment) return finish(enrollment, "FAILED", "MAX_STEPS_EXCEEDED");
    // Bound to the version the enrollment started on, never the newest one.
    const version = await client.marketingAutomationVersion.findUnique({ where: { id: enrollment.versionId } });
    const step = version.definition.steps.find((entry) => entry.id === enrollment.currentStepId);
    if (!step) return finish(enrollment, "COMPLETED", null);
    const contact = await client.marketingContact.findUnique({ where: { id: enrollment.contactId } });
    const organization = await client.mailOrganization.findUnique({ where: { id: enrollment.organizationId } });
    if (!contact || contact.organizationId !== organization.id) return finish(enrollment, "FAILED", "CONTACT_UNAVAILABLE");
    const record = (status, outcome) => client.marketingAutomationStepRun.create({ data: { enrollmentId: enrollment.id, organizationId: organization.id, stepId: step.id, stepType: step.type, sequence: enrollment.stepCount, status, outcome, createdAt: now() } }).catch((error) => {
      if (error?.code !== "P2002") throw error;
    });
    switch (step.type) {
      case "exit":
        await record("SUCCEEDED", null);
        return finish(enrollment, "COMPLETED", "EXIT_STEP");
      case "delay":
        await record("SUCCEEDED", { minutes: step.minutes });
        return advance(enrollment, step.next, { delayMinutes: step.minutes });
      case "condition": {
        const result = evaluateCondition(step.condition, { contact, eventPayload: enrollment.context?.event || {}, engagement: await engagementOf(enrollment.id) });
        await record("SUCCEEDED", { result });
        return advance(enrollment, result ? step.then : step.else);
      }
      case "send_email":
        return runSend(job, enrollment, automation, version, step, contact, organization);
      default:
        return finish(enrollment, "FAILED", "UNKNOWN_STEP_TYPE");
    }
  }

  async function onDeadLetter(job, error) {
    const enrollment = await client.marketingAutomationEnrollment.findUnique({ where: { id: job.payload?.enrollmentId } }).catch(() => null);
    if (!enrollment || !["ACTIVE", "WAITING"].includes(enrollment.status)) return;
    const run = await client.marketingAutomationStepRun.findUnique({ where: { enrollmentId_sequence: { enrollmentId: enrollment.id, sequence: enrollment.stepCount } } });
    await client.$transaction(async (tx) => {
      if (run?.status === "RUNNING") await tx.marketingAutomationStepRun.update({ where: { id: run.id }, data: { status: "OUTCOME_UNKNOWN", errorCode: String(error?.code || "DEAD_LETTER").slice(0, 64) } });
      await finish(enrollment, "FAILED", run?.status === "RUNNING" ? "OUTCOME_UNKNOWN" : "RETRIES_EXHAUSTED", tx);
    });
    logger?.warn?.(`[Marketing] automation enrollment ${enrollment.id} dead-lettered (${error?.code || "error"})`);
  }

  return { processTick, processStep, onDeadLetter, processTriggerEvents, processSchedules };
}

module.exports = { createAutomationProcessor };

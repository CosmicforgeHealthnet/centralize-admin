"use strict";

// Automation test mode (gap 4, spec section 14 "testing"). Dry-evaluates a
// version against a real (brand-scoped) or synthetic contact, an optional
// simulated trigger event and a simulated "now":
//   definition validation, trigger match, consent / suppression / frequency
//   cap / enrollment caps, condition results and branches, delays with run
//   times in UTC and recipient local time (DST-correct), delivery windows,
//   template version + classification, personalization preview and the
//   expected execution path.
// It is strictly read-only: no job, enrollment, step run, trigger event or
// provider call is ever created. Only an audit record (metadata) is written.
// It needs no migration-37 table (template classification is reported as
// unavailable before migration 37).

const { mailError } = require("../../mail.errors");
const policy = require("../../authz/mail.policy");
const { iso } = require("../../services/serializers");
const { validateDefinition, validateTriggerConfig, evaluateCondition, DefinitionError, MAX_STEPS } = require("./definition");
const { minimizePayload } = require("./event-registry");
const { brandSenderProblem, SENDER_MAILBOX_SELECT } = require("../marketing-sender");
const { renderTemplate } = require("../template-renderer");
const { isValidTimeZone, nextOccurrence, computeDelayRunAt, applyWindow, resolveZone, contactTimeZoneOf, recipientScheduleRunAt, scheduleForOccurrences, localIso, zoneSummary } = require("../scheduling");

const EMAIL = /^[^\s@<>"']{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
const PREVIEW_UNSUBSCRIBE_URL = "https://unsubscribe.preview.invalid/test-mode";
const PERSONALIZATION_FIELDS = { first_name: "firstName", last_name: "lastName", email: "email" };

function templatePolicy(client) {
  try {
    // Added by the template-classification work (gap 1); optional here.
    const { templatePolicyFor } = require("../template-policy");
    return templatePolicyFor(client);
  } catch {
    return null;
  }
}

function cleanText(value, max = 120) {
  if (value == null || value === "") return null;
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max) || null;
}

function syntheticContact(input) {
  const email = String(input?.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw mailError("MAIL_VALIDATION_FAILED", { field: "contact.email" });
  const attributes = {};
  for (const [key, value] of Object.entries(input?.attributes && typeof input.attributes === "object" && !Array.isArray(input.attributes) ? input.attributes : {}).slice(0, 30)) {
    if (/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key) && ["string", "number", "boolean"].includes(typeof value)) attributes[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  const timezone = input?.timezone ?? attributes.timezone;
  if (timezone != null && timezone !== "") {
    if (!isValidTimeZone(String(timezone))) throw mailError("MAIL_VALIDATION_FAILED", { field: "contact.timezone", reason: "INVALID_IANA_TIMEZONE", status: 422 });
    attributes.timezone = String(timezone);
  }
  const consentStatus = input?.consentStatus == null ? "GRANTED" : String(input.consentStatus);
  if (!["GRANTED", "WITHDRAWN", "NONE", "PENDING_CONFIRMATION"].includes(consentStatus)) throw mailError("MAIL_VALIDATION_FAILED", { field: "contact.consentStatus" });
  return { id: null, email, firstName: cleanText(input?.firstName), lastName: cleanText(input?.lastName), attributes, status: "ACTIVE", consentStatus };
}

function createAutomationTestService({ client, config, audit, clock = () => new Date() }) {
  async function scopeEither(user, organizationId) {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    const scoped = await policy.requireMarketingScope(client, user, organizationId, "VIEW");
    if (!scoped.canAuthor && !scoped.canApprove) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_AUTHOR_OR_APPROVER_REQUIRED" });
    return scoped;
  }

  async function loadTarget(organizationId, automationId, versionId) {
    const automation = policy.isUuid(automationId) ? await client.marketingAutomation.findUnique({ where: { id: automationId } }) : null;
    if (!automation || automation.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "automation" });
    const version = policy.isUuid(versionId) ? await client.marketingAutomationVersion.findUnique({ where: { id: versionId } }) : null;
    if (!version || version.automationId !== automation.id) throw mailError("MAIL_NOT_FOUND", { resource: "automation_version" });
    return { automation, version };
  }

  async function lastMarketingSendAt(organizationId, email) {
    const [run, recipient] = await Promise.all([
      client.marketingAutomationStepRun.findFirst({ where: { organizationId, recipientEmail: email, status: "SUCCEEDED", stepType: "send_email" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      client.marketingBroadcastRecipient.findFirst({ where: { organizationId, email, acceptedAt: { not: null } }, orderBy: { acceptedAt: "desc" }, select: { acceptedAt: true } }),
    ]);
    return Math.max(run?.createdAt?.getTime() || 0, recipient?.acceptedAt?.getTime() || 0) || null;
  }

  // Never throws on definition problems: they are part of the result.
  function validation(automation, version) {
    const errors = [];
    let definition = null;
    let triggerConfig = null;
    try {
      definition = validateDefinition(version.definition);
      triggerConfig = validateTriggerConfig(automation.triggerType, version.triggerConfig, definition);
    } catch (error) {
      if (!(error instanceof DefinitionError)) throw error;
      errors.push(...error.errors.slice(0, 30));
    }
    return { definition: definition || version.definition, triggerConfig: triggerConfig || version.triggerConfig, errors };
  }

  async function referenceProblems(organizationId, definition) {
    const problems = [];
    for (const step of (definition.steps || []).filter((entry) => entry.type === "send_email")) {
      const sender = policy.isUuid(step.senderAddressId) ? await client.mailAddress.findUnique({ where: { id: step.senderAddressId }, include: { mailbox: SENDER_MAILBOX_SELECT } }) : null;
      const senderProblem = brandSenderProblem(sender, organizationId);
      if (senderProblem) problems.push({ field: `step ${step.id}.senderAddressId`, reason: senderProblem });
    }
    return problems;
  }

  async function run(user, organizationId, automationId, versionId, input = {}, context = {}) {
    await scopeEither(user, organizationId);
    const { automation, version } = await loadTarget(organizationId, automationId, versionId);
    const simulatedNow = input.now ? new Date(input.now) : clock();
    if (Number.isNaN(simulatedNow.getTime())) throw mailError("MAIL_VALIDATION_FAILED", { field: "now" });
    const nowMs = simulatedNow.getTime();

    // ---- contact (real brand contact or synthetic) ----
    let contact;
    let kind;
    let consent = null;
    if (input.contactId) {
      const row = policy.isUuid(input.contactId) ? await client.marketingContact.findUnique({ where: { id: input.contactId } }) : null;
      if (!row || row.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "contact" });
      contact = row;
      kind = "REAL";
    } else if (input.contact) {
      contact = syntheticContact(input.contact);
      kind = "SYNTHETIC";
    } else {
      throw mailError("MAIL_VALIDATION_FAILED", { field: "contactId", reason: "CONTACT_OR_SYNTHETIC_CONTACT_REQUIRED" });
    }

    const settings = await client.marketingBrandSettings.findUnique({ where: { organizationId } });
    const organization = await client.mailOrganization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
    const brandTimeZone = settings?.defaultTimeZone || null;
    const recipientZone = resolveZone({ spec: "recipient", contactTimeZone: contactTimeZoneOf(contact), brandTimeZone });

    const checked = validation(automation, version);
    const definition = checked.definition;
    const triggerConfig = checked.triggerConfig || {};
    const references = await referenceProblems(organizationId, definition);
    const topic = definition.topic;

    // ---- trigger match preview ----
    const event = input.event && typeof input.event === "object" ? input.event : {};
    let eventPayload = {};
    const trigger = { type: automation.triggerType, matches: false, reason: null };
    if (automation.triggerType === "CONSENT_GRANTED") {
      const eventTopic = String(event.topic || topic || "").toLowerCase();
      const origin = event.origin ? String(event.origin).toUpperCase() : "FORM";
      trigger.simulatedEvent = { source: "CONSENT", topic: eventTopic, origin };
      if (origin === "IMPORT") trigger.reason = "IMPORTED_CONSENT_NOT_A_TRIGGER";
      else if (eventTopic !== triggerConfig.topic) trigger.reason = "TOPIC_MISMATCH";
      else trigger.matches = true;
    } else if (automation.triggerType === "PRODUCT_EVENT") {
      const eventType = String(event.eventType || triggerConfig.eventType || "");
      const eventVersion = Number(event.version || triggerConfig.version || 1);
      const minimized = minimizePayload(eventType, eventVersion, event.payload);
      eventPayload = minimized?.payload || {};
      trigger.simulatedEvent = { source: "PRODUCT", eventType: `${eventType}@${eventVersion}`, payload: eventPayload, droppedFields: minimized?.dropped || [] };
      if (!minimized) trigger.reason = "EVENT_TYPE_NOT_APPROVED";
      else if (eventType !== triggerConfig.eventType || eventVersion !== Number(triggerConfig.version)) trigger.reason = "EVENT_TYPE_MISMATCH";
      else trigger.matches = true;
      // Duplicate delivery of a real event: the trigger event and the
      // enrollment are both deduplicated, so nothing new would happen.
      if (event.eventId) {
        const existing = await client.marketingTriggerEvent.findUnique({ where: { organizationId_source_eventId: { organizationId, source: "PRODUCT", eventId: String(event.eventId).slice(0, 160) } } });
        const enrolled = existing ? await client.marketingAutomationEnrollment.count({ where: { automationId, dedupeKey: `evt:${existing.id}` } }) : 0;
        trigger.duplicate = { eventIdSeen: Boolean(existing), alreadyEnrolled: enrolled > 0, note: existing ? "A redelivered event with this id is ignored: no second trigger event and no second enrollment." : null };
        if (existing) {
          trigger.matches = false;
          trigger.reason = "DUPLICATE_EVENT";
        }
      }
    } else if (automation.triggerType === "SCHEDULE") {
      const occurrence = triggerConfig.frequency ? nextOccurrence(scheduleForOccurrences(triggerConfig), nowMs) : null;
      trigger.nextOccurrence = iso(occurrence);
      trigger.timeZone = triggerConfig.timeZone || null;
      if (kind === "REAL" && policy.isUuid(triggerConfig.audienceId)) {
        const member = await client.marketingAudienceContact.findUnique({ where: { audienceId_contactId: { audienceId: triggerConfig.audienceId, contactId: contact.id } } }).catch(() => null);
        trigger.audienceMember = Boolean(member);
        trigger.segment = triggerConfig.segmentId ? "Segment rules are evaluated when the occurrence runs." : null;
      }
      trigger.matches = Boolean(occurrence) && (kind !== "REAL" || trigger.audienceMember !== false);
      if (!occurrence) trigger.reason = "NO_UPCOMING_OCCURRENCE";
      else if (trigger.audienceMember === false) trigger.reason = "NOT_IN_AUDIENCE";
    }

    // ---- eligibility (as checked at every send) ----
    const blockers = [];
    const eligibility = { automationStatus: automation.status, executionEnabled: Boolean(config.automationEnabled), contactStatus: contact.status };
    if (kind === "REAL") {
      consent = await client.marketingConsent.findUnique({ where: { contactId_topic: { contactId: contact.id, topic } } });
      const consentOk = Boolean(consent && consent.status === "GRANTED" && (!consent.doubleOptIn || consent.confirmedAt));
      eligibility.consent = { topic, status: consent?.status || "NONE", doubleOptIn: Boolean(consent?.doubleOptIn), confirmed: Boolean(consent?.confirmedAt), ok: consentOk, simulated: false };
    } else {
      eligibility.consent = { topic, status: contact.consentStatus, ok: contact.consentStatus === "GRANTED", simulated: true };
    }
    const suppression = await client.marketingSuppression.findFirst({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] }, select: { reason: true, organizationId: true } });
    eligibility.suppression = { suppressed: Boolean(suppression), reason: suppression?.reason || null, scope: suppression ? (suppression.organizationId ? "BRAND" : "GLOBAL") : null };
    if (contact.status !== "ACTIVE") blockers.push(`CONTACT_${contact.status}`);
    if (!eligibility.consent.ok) blockers.push("CONSENT_NOT_GRANTED");
    if (suppression) blockers.push("SUPPRESSED");
    const lastSend = kind === "REAL" ? await lastMarketingSendAt(organizationId, contact.email) : null;
    eligibility.frequencyCap = { hours: automation.frequencyCapHours, lastMarketingSendAt: lastSend ? new Date(lastSend).toISOString() : null };
    if (kind === "REAL") {
      const prior = await client.marketingAutomationEnrollment.count({ where: { automationId, contactId: contact.id } });
      eligibility.enrollmentCap = { limit: automation.enrollmentLimit, priorEnrollments: prior, ok: automation.triggerType === "SCHEDULE" || prior < automation.enrollmentLimit };
    } else {
      eligibility.enrollmentCap = { limit: automation.enrollmentLimit, priorEnrollments: 0, ok: true, simulated: true };
    }
    const active = await client.marketingAutomationEnrollment.count({ where: { automationId, status: { in: ["ACTIVE", "WAITING"] } } });
    eligibility.maxActiveEnrollments = { limit: automation.maxActiveEnrollments, active, ok: active < automation.maxActiveEnrollments };
    const enrollBlockers = [];
    if (!trigger.matches) enrollBlockers.push(trigger.reason || "TRIGGER_DOES_NOT_MATCH");
    if (automation.status !== "ACTIVE") enrollBlockers.push(`AUTOMATION_${automation.status}`);
    if (!config.automationEnabled) enrollBlockers.push("AUTOMATION_EXECUTION_DISABLED");
    if (!eligibility.enrollmentCap.ok) enrollBlockers.push("ENROLLMENT_LIMIT");
    if (!eligibility.maxActiveEnrollments.ok) enrollBlockers.push("MAX_ACTIVE_ENROLLMENTS");
    if (version.status !== "PUBLISHED") enrollBlockers.push(`VERSION_${version.status}`);
    eligibility.wouldEnroll = enrollBlockers.length === 0;
    eligibility.enrollmentBlockers = enrollBlockers;
    eligibility.sendBlockers = blockers;

    // ---- execution path ----
    const byId = new Map((definition.steps || []).map((step) => [step.id, step]));
    const engagement = { previous_send_delivered: Boolean(input.engagement?.previous_send_delivered), previous_send_opened: Boolean(input.engagement?.previous_send_opened), previous_send_clicked: Boolean(input.engagement?.previous_send_clicked) };
    const classifier = templatePolicy(client);
    const classificationAvailable = classifier ? await classifier.ready().catch(() => false) : false;
    const path = [];
    let cursor = nowMs;
    let lastSendAt = lastSend;
    let sends = 0;
    let outcome = "COMPLETED";
    let outcomeReason = null;
    if (automation.triggerType === "SCHEDULE" && triggerConfig.timeZone === "recipient" && trigger.nextOccurrence) {
      const scheduled = recipientScheduleRunAt(trigger.nextOccurrence, triggerConfig, recipientZone);
      cursor = Math.max(cursor, scheduled.runAt.getTime());
      trigger.recipientRunAt = scheduled.runAt.toISOString();
      trigger.recipientLocalRunAt = scheduled.localRunAt;
    } else if (automation.triggerType === "SCHEDULE" && trigger.nextOccurrence) {
      cursor = Math.max(cursor, Date.parse(trigger.nextOccurrence));
    }
    let current = definition.entryStepId || definition.steps?.[0]?.id || null;
    const maxSteps = Math.min(config.automation?.maxStepsPerEnrollment || 50, MAX_STEPS + 1);
    for (let sequence = 0; current != null; sequence += 1) {
      if (sequence >= maxSteps) {
        outcome = "FAILED";
        outcomeReason = "MAX_STEPS_EXCEEDED";
        break;
      }
      const step = byId.get(current);
      if (!step) {
        outcome = "FAILED";
        outcomeReason = "UNKNOWN_STEP";
        break;
      }
      const entry = { sequence, stepId: step.id, type: step.type, at: new Date(cursor).toISOString(), localAt: localIso(cursor, recipientZone.timeZone) };
      path.push(entry);
      if (step.type === "exit") {
        outcome = "COMPLETED";
        outcomeReason = "EXIT_STEP";
        break;
      }
      if (step.type === "delay") {
        const timed = computeDelayRunAt({ fromMs: cursor, step, contactTimeZone: contactTimeZoneOf(contact), brandTimeZone });
        Object.assign(entry, { minutes: step.minutes, until: step.until || null, window: step.window || null, runAt: timed.runAt.toISOString(), localRunAt: timed.localRunAt || localIso(timed.runAt.getTime(), recipientZone.timeZone), timeZone: timed.timeZone || recipientZone.timeZone, timeZoneSource: timed.timeZoneSource || null, timeZoneFallback: timed.timeZoneFallback ?? null, fallbackReason: timed.fallbackReason || null, ambiguous: timed.ambiguous, shiftedMinutes: timed.shiftedMinutes, windowDeferred: timed.windowDeferred, next: step.next });
        cursor = timed.runAt.getTime();
        current = step.next;
        continue;
      }
      if (step.type === "condition") {
        const result = evaluateCondition(step.condition, { contact, eventPayload, engagement });
        Object.assign(entry, { condition: step.condition, result, branch: result ? "then" : "else", next: result ? step.then : step.else, ...(String(step.condition.field).startsWith("engagement.") ? { simulatedEngagement: true } : {}) });
        current = result ? step.then : step.else;
        continue;
      }
      if (step.type !== "send_email") {
        outcome = "FAILED";
        outcomeReason = "UNKNOWN_STEP_TYPE";
        break;
      }
      // send_email
      if (blockers.length) {
        Object.assign(entry, { action: "WOULD_EXIT", reason: blockers[0] });
        outcome = "EXITED";
        outcomeReason = blockers[0];
        break;
      }
      const holds = [];
      if (automation.frequencyCapHours > 0 && lastSendAt && cursor - lastSendAt < automation.frequencyCapHours * 3600000) {
        const until = lastSendAt + automation.frequencyCapHours * 3600000;
        holds.push({ reason: "FREQUENCY_CAP", until: new Date(until).toISOString() });
        cursor = until;
      }
      if (step.window) {
        const zone = resolveZone({ spec: step.window.timezone || "recipient", contactTimeZone: contactTimeZoneOf(contact), brandTimeZone });
        const windowed = applyWindow(cursor, step.window, zone.timeZone);
        entry.window = { ...step.window, ...zoneSummary(zone) };
        if (windowed.deferred) {
          holds.push({ reason: "DELIVERY_WINDOW", until: new Date(windowed.at).toISOString(), localUntil: localIso(windowed.at, zone.timeZone) });
          cursor = windowed.at;
        }
      }
      entry.holds = holds;
      entry.sendAt = new Date(cursor).toISOString();
      entry.localSendAt = localIso(cursor, recipientZone.timeZone);
      const template = policy.isUuid(step.templateVersionId) ? await client.marketingTemplateVersion.findUnique({ where: { id: step.templateVersionId }, include: { template: true } }) : null;
      if (!template || template.template.organizationId !== organizationId) {
        Object.assign(entry, { action: "WOULD_FAIL", reason: "TEMPLATE_UNAVAILABLE" });
        outcome = "FAILED";
        outcomeReason = "TEMPLATE_UNAVAILABLE";
        break;
      }
      const usabilityProblem = classifier ? await classifier.usabilityProblem(template, { purpose: "MARKETING", organizationId }).catch(() => null) : null;
      entry.template = { versionId: template.id, version: template.version, templateId: template.templateId, templateName: template.template.name, classification: classificationAvailable ? await classifier.versionClassification(template.id).catch(() => null) : null, classificationAvailable, usabilityProblem };
      if (usabilityProblem) {
        Object.assign(entry, { action: "WOULD_FAIL", reason: usabilityProblem });
        outcome = "FAILED";
        outcomeReason = usabilityProblem;
        break;
      }
      const data = { first_name: contact.firstName || "", last_name: contact.lastName || "", email: contact.email, unsubscribe_url: PREVIEW_UNSUBSCRIBE_URL, brand_name: organization?.name || "" };
      try {
        const rendered = renderTemplate({ subject: step.subjectOverride || template.subject, preheader: template.preheader, blocks: template.blocks, brand: { ...(template.brand || {}), ...(settings?.postalAddress ? { postalAddress: settings.postalAddress } : {}) } }, { data });
        const missing = rendered.variables.filter((name) => PERSONALIZATION_FIELDS[name] && !contact[PERSONALIZATION_FIELDS[name]]);
        entry.personalization = { subject: rendered.subject, text: rendered.text.slice(0, 4000), variables: rendered.variables, missingVariables: missing, unsubscribeUrl: "placeholder (test mode never issues a real token)" };
      } catch (error) {
        entry.personalization = { error: error.code || "RENDER_FAILED", details: Array.isArray(error.details) ? error.details.slice(0, 10) : null };
      }
      if (!settings?.postalAddress) entry.warnings = [...(entry.warnings || []), "POSTAL_ADDRESS_MISSING: sends are deferred until the brand postal address is set"];
      entry.action = "WOULD_SEND";
      entry.next = step.next;
      sends += 1;
      lastSendAt = cursor;
      current = step.next;
    }

    const result = {
      mode: "TEST",
      sideEffects: "NONE",
      automation: { id: automation.id, name: automation.name, status: automation.status, triggerType: automation.triggerType },
      version: { id: version.id, version: version.version, status: version.status, definitionSha256: version.definitionSha256 },
      simulatedNow: simulatedNow.toISOString(),
      validation: { ok: !checked.errors.length && !references.length, errors: [...checked.errors, ...references] },
      contact: { kind, id: contact.id, email: contact.email, firstName: contact.firstName, lastName: contact.lastName, ...zoneSummary(recipientZone), storedTimeZone: contactTimeZoneOf(contact), brandDefaultTimeZone: brandTimeZone },
      trigger,
      eligibility,
      path,
      expected: {
        outcome,
        reason: outcomeReason,
        sends,
        wouldEnroll: eligibility.wouldEnroll,
        summary: !eligibility.wouldEnroll ? `Would not enroll: ${enrollBlockers.join(", ")}.` : outcome === "EXITED" ? `Would enroll, then exit at a send step: ${outcomeReason}.` : `Would enroll and run ${path.length} step(s) with ${sends} email(s), ending ${outcome.toLowerCase()}${outcomeReason ? ` (${outcomeReason})` : ""}.`,
      },
    };
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_TESTED", targetType: "marketing_automation", targetId: automation.id, organizationId, metadata: { version: version.version, versionId: version.id, contactKind: kind, ...(kind === "REAL" ? { contactId: contact.id } : {}), simulatedNow: result.simulatedNow, steps: path.length, sends, outcome, validationErrors: result.validation.errors.length, wouldEnroll: eligibility.wouldEnroll } }, context);
    return result;
  }

  return { run };
}

module.exports = { createAutomationTestService };

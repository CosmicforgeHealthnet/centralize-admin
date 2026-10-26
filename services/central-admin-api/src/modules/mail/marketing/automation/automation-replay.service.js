"use strict";

// Automation replay and recovery (gap 4, spec section 14 "replay and safe
// failure"; table marketing_automation_replays, migration 37).
//
// Scopes: STEP_RUN (a failed / unknown / interrupted step run),
// ENROLLMENT (a failed or stalled enrollment, incl. partial execution) and
// DEAD_LETTER_JOB (a dead-lettered AUTOMATION_STEP job, requeued with its
// original idempotency key). Modes: DRY_RUN (default; returns the exact plan,
// changes nothing except the PLANNED/REFUSED evidence row + audit) and
// EXECUTE (brand APPROVE scope + fresh MFA step-up
// MARKETING_AUTOMATION_REPLAY + reason).
//
// Safety rules (never a duplicate external send):
// - a step run that succeeded, or that has a provider message id, is never
//   replayed;
// - OUTCOME_UNKNOWN (or an interrupted RUNNING send) needs an explicit
//   acknowledgement and reuses the SAME idempotency key so the provider
//   deduplicates; outside the provider idempotency window (configured,
//   default 23 h < Resend's 24 h) it is refused;
// - a replay never creates an enrollment and always runs the version the
//   enrollment is bound to; the worker re-checks consent, suppression,
//   frequency cap, contact and automation status when the step runs, and the
//   replay re-checks them before it is accepted;
// - only while the automation is ACTIVE (refused while PAUSED/ARCHIVED/DRAFT);
// - one EXECUTED replay per step run (partial unique index), so concurrent
//   requests produce exactly one execution.
// Before migration 37 every endpoint answers 503 MAIL_FEATURE_NOT_READY.

const crypto = require("crypto");
const { mailError } = require("../../mail.errors");
const policy = require("../../authz/mail.policy");
const { iso, pageLimit } = require("../../services/serializers");

const SCOPES = new Set(["STEP_RUN", "ENROLLMENT", "DEAD_LETTER_JOB"]);
const MODES = new Set(["DRY_RUN", "EXECUTE"]);
const LIVE_JOB = ["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"];

const EXPLAIN = {
  AUTOMATION_PAUSED: "The automation is paused. Resume it before replaying; a replay never runs a paused automation.",
  AUTOMATION_ARCHIVED: "The automation is archived. Archived automations are never replayed.",
  AUTOMATION_DRAFT: "The automation has not been activated.",
  ENROLLMENT_COMPLETED: "The enrollment already completed. A replay never creates a new enrollment.",
  ENROLLMENT_CANCELLED: "The enrollment was cancelled. A replay never creates a new enrollment.",
  MAX_STEPS_EXCEEDED: "The enrollment hit the step limit; replaying would loop.",
  STEP_NOT_IN_VERSION: "The step does not exist in the version this enrollment is bound to.",
  NOT_CURRENT_STEP: "Only the step where the enrollment stopped can be replayed.",
  PROVIDER_ACCEPTED: "The provider already accepted this email (a provider message id is recorded). Replaying could send it twice.",
  STEP_ALREADY_SUCCEEDED: "This step already succeeded. Replaying a successful send could deliver it twice.",
  STEP_IN_PROGRESS: "A worker still holds this step (its lease has not expired) or a job is queued for it.",
  IDEMPOTENCY_WINDOW_EXPIRED: "The first attempt is older than the provider idempotency window, so the provider can no longer deduplicate a retry. The outcome must be resolved from provider evidence instead.",
  UNKNOWN_OUTCOME_ACKNOWLEDGEMENT_REQUIRED: "The earlier attempt may have reached the provider. Confirm acknowledgeUnknownOutcome; the replay then reuses the same idempotency key so the provider deduplicates.",
  NON_SEND_STEP_NOT_REPLAYABLE: "Only send steps record replayable failures; replay the enrollment instead.",
  NOT_DUE: "The enrollment is waiting for its next run time; nothing to recover.",
  NOTHING_TO_RECOVER: "The enrollment is not failed, stalled or interrupted.",
  JOB_NOT_DEAD_LETTERED: "Only dead-lettered or failed jobs can be requeued.",
  JOB_NOT_AN_AUTOMATION_STEP: "Only MARKETING AUTOMATION_STEP jobs of this automation can be replayed here.",
  STALE_JOB: "The job belongs to an earlier step of the enrollment; the enrollment has moved on.",
  CONSENT_NOT_GRANTED: "The contact no longer has granted consent for the topic. No email will be sent.",
  SUPPRESSED: "The address is suppressed. No email will be sent.",
  CONTACT_INACTIVE: "The contact is not active. No email will be sent.",
  ALREADY_REPLAYED: "This step run was already replayed. Only one executed replay per step run is allowed.",
  STATE_CHANGED: "The enrollment or job changed while the replay was being executed. Run a new dry run.",
};

function createAutomationReplayService({ client, config, audit, stepUp, jobs, feature = null, clock = () => new Date() }) {
  const now = () => clock();
  const windowMs = () => (config.reconciliation?.idempotencyWindowHours || 23) * 3600000;
  // "Interrupted" is decided by the job queue, not by row timestamps: a step
  // run left RUNNING (or an enrollment left ACTIVE) with no live
  // AUTOMATION_STEP job (PENDING / LEASED / RETRY_SCHEDULED / RECONCILING) has
  // lost its worker. A job whose lease merely expired is still live: the job
  // repository recovers expired leases on the next worker tick.

  async function ready() {
    let ok = false;
    try {
      ok = feature?.isReady ? Boolean(await feature.isReady()) : true;
    } catch {
      ok = false;
    }
    if (!ok) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "automation_replay" });
  }

  async function scope(user, organizationId, need) {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    const scoped = await policy.requireMarketingScope(client, user, organizationId, need);
    if (need === "VIEW" && !scoped.canAuthor && !scoped.canApprove) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_AUTHOR_OR_APPROVER_REQUIRED" });
    return scoped;
  }

  async function loadAutomation(organizationId, automationId) {
    const row = policy.isUuid(automationId) ? await client.marketingAutomation.findUnique({ where: { id: automationId } }) : null;
    if (!row || row.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "automation" });
    return row;
  }

  const liveJobFor = (enrollmentId, db = client) => db.mailOutboxJob.findFirst({ where: { queue: "MARKETING", kind: "AUTOMATION_STEP", status: { in: LIVE_JOB }, payload: { path: ["enrollmentId"], equals: enrollmentId } }, select: { id: true, status: true } });

  // ------------------------------------------------------------ recovery list
  async function recovery(user, organizationId, automationId, { limit } = {}) {
    await ready();
    await scope(user, organizationId, "VIEW");
    await loadAutomation(organizationId, automationId);
    const take = pageLimit(limit, 50, 200);
    const page = (rows) => ({ items: rows.slice(0, take), more: rows.length > take });
    const runSelect = { id: true, enrollmentId: true, stepId: true, stepType: true, sequence: true, status: true, errorCode: true, providerMessageId: true, firstAttemptAt: true, createdAt: true, updatedAt: true, recipientEmail: true };
    const failed = await client.marketingAutomationStepRun.findMany({ where: { organizationId, status: { in: ["FAILED", "OUTCOME_UNKNOWN"] }, enrollment: { automationId } }, select: runSelect, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: take + 1 });
    const running = await client.marketingAutomationStepRun.findMany({ where: { organizationId, status: "RUNNING", enrollment: { automationId } }, select: runSelect, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 500 });
    const interrupted = [];
    for (const run of running) if (!(await liveJobFor(run.enrollmentId))) interrupted.push(run);
    const failedEnrollments = await client.marketingAutomationEnrollment.findMany({ where: { automationId, status: "FAILED" }, select: { id: true, contactId: true, status: true, exitReason: true, currentStepId: true, stepCount: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: take + 1 });
    const stalledCandidates = await client.marketingAutomationEnrollment.findMany({ where: { automationId, status: "ACTIVE", nextRunAt: null }, select: { id: true, contactId: true, status: true, exitReason: true, currentStepId: true, stepCount: true, updatedAt: true }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 500 });
    const stalled = [];
    for (const enrollment of stalledCandidates) if (!(await liveJobFor(enrollment.id))) stalled.push(enrollment);
    // Dead-lettered step jobs of this automation (brand isolation via the enrollment).
    const deadRows = await client.mailOutboxJob.findMany({ where: { queue: "MARKETING", kind: "AUTOMATION_STEP", status: { in: ["DEAD_LETTER", "FAILED"] } }, select: { id: true, status: true, payload: true, attemptCount: true, lastErrorCode: true, idempotencyKey: true, completedAt: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 1000 });
    const ids = [...new Set(deadRows.map((row) => row.payload?.enrollmentId).filter((id) => policy.isUuid(id)))];
    const owned = new Set((ids.length ? await client.marketingAutomationEnrollment.findMany({ where: { id: { in: ids }, automationId }, select: { id: true } }) : []).map((row) => row.id));
    const dead = deadRows.filter((row) => owned.has(row.payload?.enrollmentId)).map((row) => ({ id: row.id, status: row.status, enrollmentId: row.payload.enrollmentId, sequence: row.payload.sequence, attemptCount: row.attemptCount, lastErrorCode: row.lastErrorCode, idempotencyKey: row.idempotencyKey, completedAt: iso(row.completedAt) }));
    const serializeRun = (run) => ({ ...run, firstAttemptAt: iso(run.firstAttemptAt), createdAt: iso(run.createdAt), updatedAt: iso(run.updatedAt) });
    const serializeEnrollment = (row) => ({ ...row, updatedAt: iso(row.updatedAt) });
    return {
      failedStepRuns: { ...page(failed), items: page(failed).items.map(serializeRun) },
      interruptedStepRuns: { ...page(interrupted), items: page(interrupted).items.map(serializeRun), more: page(interrupted).more || running.length === 500 },
      failedEnrollments: { ...page(failedEnrollments), items: page(failedEnrollments).items.map(serializeEnrollment) },
      stalledEnrollments: { ...page(stalled), items: page(stalled).items.map(serializeEnrollment), more: page(stalled).more || stalledCandidates.length === 500 },
      deadLetterJobs: { ...page(dead), more: page(dead).more || deadRows.length === 1000 },
      idempotencyWindowHours: config.reconciliation?.idempotencyWindowHours || 23,
    };
  }

  async function history(user, organizationId, automationId, { limit } = {}) {
    await ready();
    await scope(user, organizationId, "VIEW");
    await loadAutomation(organizationId, automationId);
    const take = pageLimit(limit, 50, 200);
    const rows = await client.marketingAutomationReplay.findMany({ where: { automationId, organizationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 });
    return { items: rows.slice(0, take).map(serializeReplay), more: rows.length > take };
  }

  function serializeReplay(row) {
    return { id: row.id, scope: row.scope, mode: row.mode, status: row.status, reason: row.reason, requestedBy: row.requestedBy, enrollmentId: row.enrollmentId, stepRunId: row.stepRunId, outboxJobId: row.outboxJobId, result: row.result, createdAt: iso(row.createdAt), executedAt: iso(row.executedAt) };
  }

  // ------------------------------------------------------------------ plan
  async function resolveTarget(automation, scopeName, targetId) {
    if (!policy.isUuid(targetId)) throw mailError("MAIL_NOT_FOUND", { resource: scopeName.toLowerCase() });
    let run = null;
    let enrollment = null;
    let job = null;
    if (scopeName === "STEP_RUN") {
      run = await client.marketingAutomationStepRun.findUnique({ where: { id: targetId } });
      enrollment = run ? await client.marketingAutomationEnrollment.findUnique({ where: { id: run.enrollmentId } }) : null;
    } else if (scopeName === "ENROLLMENT") {
      enrollment = await client.marketingAutomationEnrollment.findUnique({ where: { id: targetId } });
      run = enrollment ? await client.marketingAutomationStepRun.findUnique({ where: { enrollmentId_sequence: { enrollmentId: enrollment.id, sequence: enrollment.stepCount } } }) : null;
    } else {
      job = await client.mailOutboxJob.findUnique({ where: { id: targetId } });
      const enrollmentId = job?.payload?.enrollmentId;
      enrollment = policy.isUuid(enrollmentId) ? await client.marketingAutomationEnrollment.findUnique({ where: { id: enrollmentId } }) : null;
      if (enrollment && job) run = await client.marketingAutomationStepRun.findUnique({ where: { enrollmentId_sequence: { enrollmentId: enrollment.id, sequence: Number(job.payload.sequence) } } });
    }
    // Brand + automation isolation: another automation's target looks missing.
    if (!enrollment || enrollment.automationId !== automation.id || enrollment.organizationId !== automation.organizationId) throw mailError("MAIL_NOT_FOUND", { resource: scopeName.toLowerCase() });
    return { run, enrollment, job };
  }

  async function sendChecks(enrollment, version, automation) {
    const contact = await client.marketingContact.findUnique({ where: { id: enrollment.contactId } });
    const topic = version.definition.topic;
    const consent = contact ? await client.marketingConsent.findUnique({ where: { contactId_topic: { contactId: contact.id, topic } } }) : null;
    const suppressed = contact ? await client.marketingSuppression.findFirst({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId: automation.organizationId }, { organizationId: null }] }, select: { reason: true } }) : null;
    const consentOk = Boolean(consent && consent.status === "GRANTED" && (!consent.doubleOptIn || consent.confirmedAt));
    let frequencyCapHoldsUntil = null;
    if (contact && automation.frequencyCapHours > 0) {
      const last = await client.marketingAutomationStepRun.findFirst({ where: { organizationId: automation.organizationId, recipientEmail: contact.email, status: "SUCCEEDED", stepType: "send_email" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const until = last ? last.createdAt.getTime() + automation.frequencyCapHours * 3600000 : 0;
      if (until > now().getTime()) frequencyCapHoldsUntil = new Date(until).toISOString();
    }
    const checks = { contactStatus: contact?.status || "MISSING", consent: { topic, status: consent?.status || "NONE", ok: consentOk }, suppressed: Boolean(suppressed), suppressionReason: suppressed?.reason || null, frequencyCapHoldsUntil };
    const block = !contact || contact.status !== "ACTIVE" ? "CONTACT_INACTIVE" : !consentOk ? "CONSENT_NOT_GRANTED" : suppressed ? "SUPPRESSED" : null;
    return { checks, block };
  }

  async function buildPlan(automation, scopeName, targetId, { acknowledgeUnknownOutcome = false } = {}) {
    const { run, enrollment, job } = await resolveTarget(automation, scopeName, targetId);
    const version = await client.marketingAutomationVersion.findUnique({ where: { id: enrollment.versionId } });
    const step = version?.definition?.steps?.find((entry) => entry.id === enrollment.currentStepId) || null;
    const plan = {
      scope: scopeName,
      targetId,
      automationId: automation.id,
      automationStatus: automation.status,
      enrollmentId: enrollment.id,
      enrollmentStatus: enrollment.status,
      enrollmentExitReason: enrollment.exitReason,
      versionId: enrollment.versionId,
      version: version?.version ?? null,
      stepId: enrollment.currentStepId,
      stepType: step?.type || null,
      sequence: enrollment.stepCount,
      stepRunId: run?.id || null,
      stepRunStatus: run?.status || null,
      outboxJobId: job?.id || null,
      action: null,
      idempotency: null,
      requiresAcknowledgement: false,
      acknowledged: Boolean(acknowledgeUnknownOutcome),
      checks: null,
      refusal: null,
      steps: [],
    };
    const refuse = (code, extra = {}) => {
      plan.refusal = { code, message: EXPLAIN[code] || code, ...extra };
      return plan;
    };
    // Never a duplicate external send: a step run the provider accepted (or
    // that succeeded) is never re-run. (An ENROLLMENT/DEAD_LETTER_JOB replay
    // of such a step only advances past it, see below.)
    if (scopeName === "STEP_RUN" && run.status === "SUCCEEDED") return refuse(run.providerMessageId ? "PROVIDER_ACCEPTED" : "STEP_ALREADY_SUCCEEDED", run.providerMessageId ? { providerMessageIdRecorded: true } : {});
    if (run && run.status !== "SUCCEEDED" && run.providerMessageId) return refuse("PROVIDER_ACCEPTED", { providerMessageIdRecorded: true });
    if (automation.status !== "ACTIVE") return refuse(`AUTOMATION_${automation.status}`);
    if (job) {
      if (job.queue !== "MARKETING" || job.kind !== "AUTOMATION_STEP") return refuse("JOB_NOT_AN_AUTOMATION_STEP");
      if (!["DEAD_LETTER", "FAILED"].includes(job.status)) return refuse("JOB_NOT_DEAD_LETTERED", { jobStatus: job.status });
      if (Number(job.payload?.sequence) !== enrollment.stepCount) return refuse("STALE_JOB");
    }
    if (enrollment.status === "COMPLETED") return refuse("ENROLLMENT_COMPLETED");
    if (enrollment.status === "CANCELLED") return refuse("ENROLLMENT_CANCELLED");
    if (enrollment.exitReason === "MAX_STEPS_EXCEEDED") return refuse("MAX_STEPS_EXCEEDED");
    if (!step) return refuse("STEP_NOT_IN_VERSION");
    if (scopeName === "STEP_RUN" && run.sequence !== enrollment.stepCount) return refuse("NOT_CURRENT_STEP");

    const live = await liveJobFor(enrollment.id);
    if (run) {
      if (run.status === "SUCCEEDED") {
        // Partial execution: the step's effect is recorded but the enrollment
        // stopped before advancing. Resume WITHOUT re-sending.
        if (live) return refuse("STEP_IN_PROGRESS");
        if (!["FAILED", "ACTIVE", "EXITED"].includes(enrollment.status)) return refuse("NOTHING_TO_RECOVER");
        plan.action = "ADVANCE_PAST_SUCCEEDED_STEP";
        plan.steps.push("Mark the enrollment ACTIVE again (same version, same step).", "Queue the step: the worker sees the recorded success and advances without sending.");
        return plan;
      }
      if (step.type !== "send_email" || run.stepType !== "send_email") return refuse("NON_SEND_STEP_NOT_REPLAYABLE");
      if (run.status === "RUNNING" && live) return refuse("STEP_IN_PROGRESS");
      const unknown = run.status === "OUTCOME_UNKNOWN" || run.status === "RUNNING";
      if (unknown) {
        const firstAttemptAt = run.firstAttemptAt || run.createdAt;
        const age = now().getTime() - new Date(firstAttemptAt).getTime();
        if (age > windowMs()) return refuse("IDEMPOTENCY_WINDOW_EXPIRED", { firstAttemptAt: iso(firstAttemptAt), windowHours: windowMs() / 3600000 });
        plan.requiresAcknowledgement = true;
        plan.idempotency = { key: run.idempotencyKey, reused: true, firstAttemptAt: iso(firstAttemptAt), providerDeduplicatesUntil: new Date(new Date(firstAttemptAt).getTime() + windowMs()).toISOString() };
        plan.action = run.status === "RUNNING" ? "RECOVER_INTERRUPTED_SEND" : "RETRY_UNKNOWN_SEND";
      } else {
        // FAILED (provider rejected or never reached) / SKIPPED (blocked):
        // no earlier attempt was accepted, so a fresh key is safe.
        plan.idempotency = { key: null, reused: false, note: "A new idempotency key is issued: the earlier attempt was rejected by the provider or never reached it." };
        plan.action = "RETRY_FAILED_SEND";
      }
      if (live) return refuse("STEP_IN_PROGRESS");
    } else {
      if (live) return refuse("STEP_IN_PROGRESS");
      if (enrollment.status === "WAITING" && enrollment.nextRunAt && enrollment.nextRunAt > now()) return refuse("NOT_DUE", { nextRunAt: iso(enrollment.nextRunAt) });
      const stalled = enrollment.status === "ACTIVE" || (enrollment.status === "WAITING" && !enrollment.nextRunAt);
      if (enrollment.status !== "FAILED" && !stalled && !job) return refuse("NOTHING_TO_RECOVER");
      if (enrollment.status === "EXITED") return refuse("NOTHING_TO_RECOVER");
      plan.action = "RESUME_ENROLLMENT";
    }
    if (step.type === "send_email") {
      const { checks, block } = await sendChecks(enrollment, version, automation);
      plan.checks = checks;
      if (block) return refuse(block);
    }
    if (plan.action !== "RESUME_ENROLLMENT") plan.steps.push(plan.idempotency?.reused ? `Reset step run ${run.id} to RUNNING, keeping idempotency key ${run.idempotencyKey} (provider deduplicates).` : `Reset step run ${run.id} to RUNNING with a new idempotency key.`);
    plan.steps.push(`Mark the enrollment ACTIVE (version v${plan.version}, step ${plan.stepId}).`);
    plan.steps.push(job ? `Requeue dead-lettered job ${job.id} with its original idempotency key ${job.idempotencyKey}.` : "Queue one AUTOMATION_STEP job for this step.");
    plan.steps.push("The worker re-checks automation status, consent, suppression, contact status, frequency cap and caps when the step runs.");
    if (plan.checks?.frequencyCapHoldsUntil) plan.steps.push(`The frequency cap holds the send until ${plan.checks.frequencyCapHoldsUntil}.`);
    if (plan.requiresAcknowledgement && !plan.acknowledged) plan.blockedUntilAcknowledged = true;
    return plan;
  }

  async function recordReplay(data, db = client) {
    return db.marketingAutomationReplay.create({ data: { id: data.id || crypto.randomUUID(), createdAt: now(), ...data } });
  }

  // --------------------------------------------------------------- request
  async function request(user, organizationId, automationId, input = {}, context = {}) {
    await ready();
    const mode = input.mode == null || input.mode === "" ? "DRY_RUN" : String(input.mode);
    if (!MODES.has(mode)) throw mailError("MAIL_VALIDATION_FAILED", { field: "mode" });
    const scopeName = String(input.scope || "");
    if (!SCOPES.has(scopeName)) throw mailError("MAIL_VALIDATION_FAILED", { field: "scope" });
    const reason = String(input.reason || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
    if (reason.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason", reason: "MIN_5_CHARACTERS" });
    await scope(user, organizationId, mode === "EXECUTE" ? "APPROVE" : "VIEW");
    if (mode === "EXECUTE" && !input.stepUpId) throw mailError("MAIL_STEP_UP_REQUIRED", { purpose: "MARKETING_AUTOMATION_REPLAY" });
    const automation = await loadAutomation(organizationId, automationId);
    const plan = await buildPlan(automation, scopeName, input.targetId, { acknowledgeUnknownOutcome: input.acknowledgeUnknownOutcome === true });
    const base = { organizationId, automationId, enrollmentId: plan.enrollmentId, stepRunId: plan.stepRunId, outboxJobId: plan.outboxJobId, scope: scopeName, mode, reason, requestedBy: user.id };
    const auditMeta = (row, extra = {}) => ({ replayId: row.id, scope: scopeName, mode, status: row.status, enrollmentId: plan.enrollmentId, stepRunId: plan.stepRunId, outboxJobId: plan.outboxJobId, action: plan.action, refusal: plan.refusal?.code || null, reason, ...extra });

    if (mode === "DRY_RUN") {
      const row = await recordReplay({ ...base, status: plan.refusal ? "REFUSED" : "PLANNED", result: { plan } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_REPLAY_PLANNED", targetType: "marketing_automation", targetId: automationId, organizationId, outcome: plan.refusal ? "DENIED" : "SUCCESS", metadata: auditMeta(row) }, context);
      return { replay: serializeReplay(row), plan, executable: !plan.refusal, requires: [...(mode === "DRY_RUN" ? ["EXECUTE with brand approver scope", "MFA step-up MARKETING_AUTOMATION_REPLAY"] : []), ...(plan.requiresAcknowledgement ? ["acknowledgeUnknownOutcome: true"] : [])] };
    }

    const refuseExecute = async (code, extra = {}) => {
      const refusal = plan.refusal || { code, message: EXPLAIN[code] || code, ...extra };
      const row = await recordReplay({ ...base, status: "REFUSED", result: { plan: { ...plan, refusal } } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_REPLAY_REFUSED", targetType: "marketing_automation", targetId: automationId, organizationId, outcome: "DENIED", metadata: auditMeta(row, { refusal: refusal.code }) }, context);
      return mailError("MAIL_INVALID_TRANSITION", { reason: refusal.code, explanation: refusal.message, replayId: row.id });
    };
    if (plan.refusal) throw await refuseExecute(plan.refusal.code);
    if (plan.requiresAcknowledgement && !plan.acknowledged) throw await refuseExecute("UNKNOWN_OUTCOME_ACKNOWLEDGEMENT_REQUIRED");

    const replayId = crypto.randomUUID();
    let result;
    try {
      result = await client.$transaction(async (tx) => {
        // The EXECUTED row first: the partial unique index lets exactly one
        // concurrent replay of a step run commit.
        await recordReplay({ ...base, id: replayId, status: "EXECUTED", executedAt: now(), result: { plan } }, tx);
        const consumed = await stepUp.consume(tx, user, input.stepUpId, "MARKETING_AUTOMATION_REPLAY", context);
        // Serialize recoveries of one enrollment: lock it, then make sure no
        // other recovery (or worker) queued a job for it meanwhile.
        await tx.$queryRaw`SELECT "id" FROM "marketing_automation_enrollments" WHERE "id" = ${plan.enrollmentId}::uuid FOR UPDATE`;
        if (await liveJobFor(plan.enrollmentId, tx)) throw Object.assign(new Error("state changed"), { replayRefusal: "STEP_IN_PROGRESS" });
        const enrollment = await tx.marketingAutomationEnrollment.findUnique({ where: { id: plan.enrollmentId } });
        const outcome = { action: plan.action, stepUpId: consumed };
        if (plan.stepRunId && ["RETRY_UNKNOWN_SEND", "RECOVER_INTERRUPTED_SEND", "RETRY_FAILED_SEND"].includes(plan.action)) {
          const runRow = await tx.marketingAutomationStepRun.findUnique({ where: { id: plan.stepRunId } });
          const reuse = plan.idempotency.reused;
          const key = reuse ? runRow.idempotencyKey : `auto:${enrollment.id}:${enrollment.stepCount}:r${replayId.slice(0, 8)}`;
          const reset = await tx.marketingAutomationStepRun.updateMany({
            where: { id: plan.stepRunId, status: plan.stepRunStatus, providerMessageId: null },
            data: { status: "RUNNING", errorCode: null, idempotencyKey: key, ...(reuse ? {} : { firstAttemptAt: now() }), outcome: { ...(runRow.outcome || {}), replay: { replayId, previousStatus: runRow.status, previousErrorCode: runRow.errorCode, idempotencyKeyReused: reuse } } },
          });
          if (reset.count !== 1) throw Object.assign(new Error("state changed"), { replayRefusal: "STATE_CHANGED" });
          outcome.idempotencyKey = key;
          outcome.idempotencyKeyReused = reuse;
        }
        // Same version, same step; the row lock + live-job check above make
        // a concurrent second recovery of a stalled enrollment refuse.
        const resumable = plan.action === "RESUME_ENROLLMENT" ? ["FAILED", "ACTIVE", "WAITING"] : ["FAILED", "EXITED", "ACTIVE", "WAITING"];
        const resumed = await tx.marketingAutomationEnrollment.updateMany({
          where: { id: enrollment.id, versionId: plan.versionId, stepCount: plan.sequence, currentStepId: plan.stepId, status: { in: resumable } },
          data: { status: "ACTIVE", exitReason: null, completedAt: null, nextRunAt: null },
        });
        if (resumed.count !== 1) throw Object.assign(new Error("state changed"), { replayRefusal: "STATE_CHANGED" });
        if (plan.outboxJobId) {
          const requeued = await jobs.requeue(plan.outboxJobId, { tx });
          if (!requeued?.requeued) throw Object.assign(new Error("state changed"), { replayRefusal: "STATE_CHANGED" });
          outcome.jobId = plan.outboxJobId;
          outcome.jobIdempotencyKey = requeued.job.idempotencyKey;
        } else {
          const { job } = await jobs.enqueue(tx, { queue: "MARKETING", kind: "AUTOMATION_STEP", idempotencyKey: `auto-step:${enrollment.id}:${enrollment.stepCount}:replay:${replayId}`, payload: { enrollmentId: enrollment.id, sequence: enrollment.stepCount, organizationId, replayId }, maxAttempts: 12, nextAttemptAt: now() });
          outcome.jobId = job.id;
          outcome.jobIdempotencyKey = job.idempotencyKey;
        }
        await tx.marketingAutomationReplay.update({ where: { id: replayId }, data: { result: { plan, outcome }, outboxJobId: outcome.jobId } });
        await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUTOMATION_REPLAY_EXECUTED", targetType: "marketing_automation", targetId: automationId, organizationId, metadata: { replayId, scope: scopeName, mode, status: "EXECUTED", enrollmentId: plan.enrollmentId, stepRunId: plan.stepRunId, outboxJobId: outcome.jobId, action: plan.action, idempotencyKeyReused: Boolean(outcome.idempotencyKeyReused), reason } }, context, tx);
        return outcome;
      });
    } catch (error) {
      if (error?.code === "P2002") throw await refuseExecute("ALREADY_REPLAYED");
      if (error?.replayRefusal) throw await refuseExecute(error.replayRefusal);
      throw error;
    }
    const row = await client.marketingAutomationReplay.findUnique({ where: { id: replayId } });
    return { replay: serializeReplay(row), plan, outcome: result };
  }

  return { recovery, history, request, buildPlan };
}

module.exports = { createAutomationReplayService };

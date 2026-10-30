"use strict";

// GAP 2 (spec 13.4): provider subscription state and approved
// re-subscription after a verified double opt-in.
//
// Local consent stays the source of truth. The provider (Resend) keeps one
// GLOBAL `unsubscribed` flag per contact and account; once set, broadcasts
// skip the contact even when CosmicForge has fresh consent. This module:
//
// 1. Records what the provider says about each contact in
//    marketing_contact_provider_states (SUBSCRIBED | UNSUBSCRIBED |
//    SUPPRESSED | UNKNOWN, reason USER_UNSUBSCRIBE | HARD_BOUNCE | COMPLAINT
//    | PROVIDER_SUPPRESSED) from provider events and broadcast sync results.
//    Soft/transient bounces never change consent or provider state. Writes
//    are ordered by observation time and never run inside a caller's
//    transaction, so a failure here can never roll back consent handling.
// 2. Opens a re-subscription request (marketing_provider_resubscriptions,
//    PENDING_APPROVAL) only when a contact who is UNSUBSCRIBED at the provider
//    because they unsubscribed (USER_UNSUBSCRIBE) newly completes a VERIFIED
//    double opt-in for the brand, with the consent evidence stored on the
//    request. Complaints, hard bounces, any other active brand suppression and
//    global suppressions are refused with an explicit reason. The only local
//    suppression that does not block is the mirror of that same provider
//    unsubscribe (reason UNSUBSCRIBED, source provider_unsubscribe, created
//    before the confirmation); it is lifted when the re-subscription is
//    APPLIED and verified.
// 3. A brand approver (MFA step-up MARKETING_RESUBSCRIBE_APPROVE) approves.
//    The provider call (PATCH unsubscribed=false) is undocumented, so it runs
//    only with MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED=true; otherwise the
//    request becomes UNSUPPORTED with the manual alternative, which an
//    approver later confirms (step-up MARKETING_RESUBSCRIBE_CONFIRM). Either
//    way the provider contact is read back (unsubscribed=false) before the
//    request is APPLIED and the provider state SUBSCRIBED; a mismatch is
//    FAILED. Retryable failures retry with backoff (attempts, next_attempt_at)
//    through MARKETING_RESUBSCRIBE jobs and are reconciled on the next sync.
// Audit metadata carries ids and statuses only (never an email address).
// Re-audit: approve, the provider attempt (applyOne) and the manual
// confirmation all run one guard (guardReasons): blockers() + the evidence
// consent still GRANTED, double opt-in, confirmedAt equal to the evidence and
// not withdrawn + the brand has its OWN provider account. Resend's unsubscribe
// flag is account-global, so with MAIL_BROADCAST_ALLOW_SHARED_PROVIDER_ACCOUNT
// one brand's double opt-in would clear another brand's unsubscribe: refused
// with SHARED_PROVIDER_ACCOUNT unless the brand key is the brand's own.

const crypto = require("crypto");
const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { isQuotaExhausted } = require("../ops/provider-quota.service");
const { resolveBrandApiKey } = require("../adapters/marketing");

const STATES = ["SUBSCRIBED", "UNSUBSCRIBED", "SUPPRESSED", "UNKNOWN"];
const OPEN = ["PENDING_APPROVAL", "APPROVED"];
const STATUSES = ["PENDING_APPROVAL", "APPROVED", "APPLIED", "UNSUPPORTED", "FAILED", "REFUSED", "CANCELLED"];
const MAX_ATTEMPTS = 5;
const CLAIM_SECONDS = 300;
const MIRROR_SOURCE = "provider_unsubscribe";

const UNSUPPORTED_MESSAGE = "Automatic provider re-subscription is not enabled: Resend documents only unsubscribing a contact, not re-subscribing it. "
  + "Approved alternative: confirm the re-subscription with Resend support or re-add the contact in the Resend dashboard for this brand's account, "
  + "then use \"Confirm manually\" (MFA step-up). CosmicForge reads the contact back and only marks it subscribed when the provider shows it is no longer unsubscribed.";

function emailHash(email) {
  return crypto.createHash("sha256").update(String(email || "").toLowerCase()).digest("hex");
}

function backoffSeconds(attempt) {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 6 * 3600);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function createResubscriptionService({ client, config, env = process.env, features = null, audit, stepUp, jobs = null, marketingProviders, clock = () => new Date(), logger = null }) {
  const ready = async () => {
    if (!features) return false;
    try {
      return await features.isReady();
    } catch {
      return false;
    }
  };
  const providerName = () => (config.provider === "fake" ? "fake" : "resend");
  const scope = (user, organizationId, need) => {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    return policy.requireMarketingScope(client, user, organizationId, need);
  };
  async function requireReady() {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "provider_resubscription" });
  }

  // ---------------------------------------------------------------- state
  // Upsert ordered by observation time: an older observation never replaces
  // a newer one. Never throws; callers run it after their own transaction.
  async function observe({ organizationId, contactId = null, email = null, state, reason = null, observedAt = clock(), provider = providerName() }) {
    try {
      if (!STATES.includes(state) || !organizationId || !(await ready())) return { recorded: false };
      let id = contactId;
      if (!id && email) id = (await client.marketingContact.findUnique({ where: { organizationId_email: { organizationId, email: String(email).toLowerCase() } }, select: { id: true } }))?.id || null;
      if (!id) return { recorded: false };
      const at = new Date(observedAt);
      const rows = await client.$queryRaw`
        INSERT INTO "marketing_contact_provider_states" ("contact_id", "organization_id", "provider", "state", "reason", "observed_at", "updated_at")
        SELECT c."id", c."organization_id", ${String(provider).slice(0, 32)}, ${state}, ${reason}, ${at}, now()
        FROM "marketing_email_contacts" c WHERE c."id" = ${id}::uuid AND c."organization_id" = ${organizationId}::uuid
        ON CONFLICT ("contact_id") DO UPDATE SET "state" = EXCLUDED."state", "reason" = EXCLUDED."reason", "provider" = EXCLUDED."provider", "observed_at" = EXCLUDED."observed_at", "updated_at" = now()
          WHERE "marketing_contact_provider_states"."observed_at" <= EXCLUDED."observed_at"
        RETURNING "contact_id"`;
      return { recorded: rows.length > 0, contactId: id };
    } catch (error) {
      logger?.warn?.(`[Marketing] provider state not recorded (${error?.code || "error"})`);
      return { recorded: false };
    }
  }

  async function latestApplied(contactId) {
    return client.marketingProviderResubscription.findFirst({ where: { contactId, status: "APPLIED" }, orderBy: { completedAt: "desc" } });
  }

  // A provider unsubscribe that happened before an APPLIED re-subscription is
  // stale: it must not withdraw the newer, verified consent again.
  async function supersededBy(organizationId, contactId, occurredAt) {
    try {
      if (!contactId || !(await ready())) return null;
      const applied = await latestApplied(contactId);
      if (!applied || applied.organizationId !== organizationId || !applied.completedAt) return null;
      return applied.completedAt > new Date(occurredAt) ? applied : null;
    } catch {
      return null;
    }
  }

  // Broadcast sync: contacts the provider will not deliver to. Excluded
  // unless an APPLIED re-subscription newer than the provider state exists.
  async function providerExclusions(organizationId, contactIds) {
    const result = new Map();
    try {
      if (!contactIds.length || !(await ready())) return result;
      const states = await client.marketingContactProviderState.findMany({ where: { organizationId, contactId: { in: contactIds }, state: { in: ["UNSUBSCRIBED", "SUPPRESSED"] } } });
      if (!states.length) return result;
      const applied = await client.marketingProviderResubscription.findMany({ where: { organizationId, contactId: { in: states.map((row) => row.contactId) }, status: "APPLIED" }, select: { contactId: true, completedAt: true } });
      for (const row of states) {
        const newer = applied.some((entry) => entry.contactId === row.contactId && entry.completedAt && entry.completedAt > row.observedAt);
        if (!newer) result.set(row.contactId, { state: row.state, reason: row.reason, observedAt: row.observedAt });
      }
    } catch (error) {
      logger?.warn?.(`[Marketing] provider exclusions unavailable (${error?.code || "error"})`);
    }
    return result;
  }

  // -------------------------------------------------------- eligibility
  // Reasons a contact must not be re-subscribed at the provider.
  async function blockers(db, { organizationId, contact, confirmedAt }) {
    const reasons = [];
    if (contact.status === "COMPLAINED") reasons.push("COMPLAINT");
    if (contact.status === "BOUNCED") reasons.push("HARD_BOUNCE");
    const suppressions = await db.marketingSuppression.findMany({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] } });
    for (const row of suppressions) {
      if (!row.organizationId) reasons.push("GLOBAL_SUPPRESSION");
      else if (row.reason === "COMPLAINED") reasons.push("COMPLAINT");
      else if (row.reason === "BOUNCED") reasons.push("HARD_BOUNCE");
      else if (!(row.reason === "UNSUBSCRIBED" && row.source === MIRROR_SOURCE && confirmedAt && row.createdAt < confirmedAt)) reasons.push("LOCAL_SUPPRESSION_ACTIVE");
    }
    return [...new Set(reasons)];
  }

  // Which provider account the brand's marketing key belongs to. The offline
  // fake adapter may declare `accountSource` (tests); it defaults to "brand".
  function accountSource(organization) {
    if (!organization?.slug) return "none";
    if (config.provider === "fake") {
      const declared = marketingProviders(organization)?.accountSource;
      return declared || "brand";
    }
    return resolveBrandApiKey(organization.slug, { env, config }).source;
  }

  // One guard for approve, applyOne and confirmManual.
  async function guardReasons(db, row, { contact = null, organization = null } = {}) {
    const evidence = row.consentEvidence || {};
    const confirmedAt = evidence.confirmedAt ? new Date(evidence.confirmedAt) : null;
    const theContact = contact || (await db.marketingContact.findUnique({ where: { id: row.contactId } }));
    const reasons = theContact ? await blockers(db, { organizationId: row.organizationId, contact: theContact, confirmedAt }) : ["CONTACT_UNAVAILABLE"];
    const consent = evidence.consentId ? await db.marketingConsent.findUnique({ where: { id: evidence.consentId } }) : null;
    if (!consent || consent.contactId !== row.contactId || consent.status !== "GRANTED" || consent.withdrawnAt) reasons.push("CONSENT_NO_LONGER_GRANTED");
    else if (!consent.doubleOptIn || !consent.confirmedAt || !confirmedAt || consent.confirmedAt.getTime() !== confirmedAt.getTime()) reasons.push("CONSENT_EVIDENCE_CHANGED");
    const brand = organization || (await db.mailOrganization.findUnique({ where: { id: row.organizationId } }));
    if (accountSource(brand) !== "brand") reasons.push("SHARED_PROVIDER_ACCOUNT");
    return [...new Set(reasons)];
  }

  async function refuseGuarded(row, reasons, refusedBy, actor = null, context = {}) {
    const moved = await client.marketingProviderResubscription.updateMany({ where: { id: row.id, status: row.status }, data: { status: "REFUSED", lastError: reasons.join(",").slice(0, 255), completedAt: clock(), nextAttemptAt: null, providerResult: { ...(row.providerResult && typeof row.providerResult === "object" ? row.providerResult : {}), refusedReasons: reasons, refusedBy } } });
    if (moved.count === 1) await auditTransition({ ...row, status: "REFUSED" }, "MARKETING_RESUBSCRIPTION_REFUSED", { reasons, previousStatus: row.status, refusedBy }, actor, context);
    return moved.count === 1;
  }

  async function auditTransition(row, action, extra = {}, actor = null, context = {}, tx = undefined) {
    await audit.record({ actorAdminUserId: actor, action, targetType: "marketing_contact", targetId: row.contactId, organizationId: row.organizationId, metadata: { resubscriptionId: row.id, contactId: row.contactId, status: row.status, ...extra } }, context, tx);
  }

  // ---------------------------------------- 1. verified double opt-in hook
  // Called after a double opt-in confirmation committed. Never throws.
  async function onDoubleOptInConfirmed({ consentId }) {
    try {
      if (!consentId || !(await ready())) return { created: false, reason: "FEATURE_NOT_READY" };
      const consent = await client.marketingConsent.findUnique({ where: { id: consentId } });
      if (!consent || consent.status !== "GRANTED" || !consent.doubleOptIn || !consent.confirmedAt) return { created: false, reason: "NOT_A_VERIFIED_DOUBLE_OPT_IN" };
      const contact = await client.marketingContact.findUnique({ where: { id: consent.contactId } });
      if (!contact || contact.organizationId !== consent.organizationId) return { created: false, reason: "CONTACT_UNAVAILABLE" };
      const state = await client.marketingContactProviderState.findUnique({ where: { contactId: contact.id } });
      // Nothing to re-subscribe when the provider does not block the contact.
      if (!state || !["UNSUBSCRIBED", "SUPPRESSED"].includes(state.state)) return { created: false, reason: "NOT_UNSUBSCRIBED_AT_PROVIDER" };
      // Only a confirmation completed after the provider state is "new" consent.
      if (consent.confirmedAt <= state.observedAt) return { created: false, reason: "CONFIRMATION_PREDATES_UNSUBSCRIBE" };
      const open = await client.marketingProviderResubscription.findFirst({ where: { contactId: contact.id, status: { in: OPEN } } });
      if (open) return { created: false, reason: "ALREADY_OPEN", id: open.id };
      const reasons = await blockers(client, { organizationId: contact.organizationId, contact, confirmedAt: consent.confirmedAt });
      if (accountSource(await client.mailOrganization.findUnique({ where: { id: contact.organizationId } })) !== "brand") reasons.push("SHARED_PROVIDER_ACCOUNT");
      // Only a user unsubscribe can be lifted; provider suppressions (hard
      // bounce, complaint, provider suppression list) are never re-subscribed.
      if (state.state === "SUPPRESSED") reasons.unshift(state.reason === "COMPLAINT" ? "COMPLAINT" : state.reason === "HARD_BOUNCE" ? "HARD_BOUNCE" : "PROVIDER_SUPPRESSED");
      else if (state.reason !== "USER_UNSUBSCRIBE") reasons.unshift(`PROVIDER_STATE_${String(state.reason || "UNKNOWN_REASON").slice(0, 40)}`);
      const evidence = {
        consentId: consent.id,
        topic: consent.topic,
        source: consent.source,
        policyVersion: consent.policyVersion,
        doubleOptIn: true,
        consentedAt: iso(consent.consentedAt),
        confirmedAt: iso(consent.confirmedAt),
        sourceEvidence: consent.sourceEvidence,
        providerState: { state: state.state, reason: state.reason, observedAt: iso(state.observedAt) },
      };
      const unique = [...new Set(reasons)];
      reasons.length = 0;
      reasons.push(...unique);
      try {
        const row = await client.marketingProviderResubscription.create({
          data: {
            organizationId: contact.organizationId,
            contactId: contact.id,
            topic: consent.topic,
            status: reasons.length ? "REFUSED" : "PENDING_APPROVAL",
            consentEvidence: evidence,
            requestedBy: null,
            lastError: reasons.length ? reasons.join(",").slice(0, 255) : null,
            providerResult: reasons.length ? { refusedReasons: reasons, refusedBy: "system" } : undefined,
            completedAt: reasons.length ? clock() : null,
          },
        });
        await auditTransition(row, reasons.length ? "MARKETING_RESUBSCRIPTION_REFUSED" : "MARKETING_RESUBSCRIPTION_REQUESTED", reasons.length ? { reasons } : { topic: consent.topic });
        return { created: !reasons.length, refused: reasons.length ? reasons : null, id: row.id };
      } catch (error) {
        if (error?.code === "P2002") return { created: false, reason: "ALREADY_OPEN" };
        throw error;
      }
    } catch (error) {
      logger?.warn?.(`[Marketing] re-subscription request not created (${error?.code || "error"})`);
      return { created: false, reason: "ERROR" };
    }
  }

  // ------------------------------------------------------------ provider
  function verified(remote) {
    return remote && remote.unsubscribed === false;
  }

  // APPLIED + verified: provider state SUBSCRIBED, the mirror suppression of
  // the old provider unsubscribe lifted, contact back to ACTIVE.
  async function markApplied(row, { providerResult, actor = null, context = {}, remote = null }) {
    const now = clock();
    const contact = await client.marketingContact.findUnique({ where: { id: row.contactId } });
    const applied = await client.$transaction(async (tx) => {
      const moved = await tx.marketingProviderResubscription.updateMany({ where: { id: row.id, status: row.status }, data: { status: "APPLIED", providerResult, completedAt: now, nextAttemptAt: null, lastError: null, ...(actor ? { approvedBy: row.approvedBy || actor } : {}) } });
      if (moved.count !== 1) return null;
      const lifted = await tx.marketingSuppression.updateMany({ where: { organizationId: row.organizationId, email: contact.email, liftedAt: null, reason: "UNSUBSCRIBED", source: MIRROR_SOURCE, createdAt: { lt: new Date(row.consentEvidence?.confirmedAt || now) } }, data: { liftedAt: now, liftedBy: actor || row.approvedBy || "system:resubscription" } });
      const others = await tx.marketingSuppression.count({ where: { email: contact.email, liftedAt: null, OR: [{ organizationId: row.organizationId }, { organizationId: null }] } });
      if (!others) await tx.marketingContact.updateMany({ where: { id: contact.id, status: "UNSUBSCRIBED" }, data: { status: "ACTIVE" } });
      const fresh = await tx.marketingProviderResubscription.findUnique({ where: { id: row.id } });
      await auditTransition(fresh, "MARKETING_RESUBSCRIPTION_APPLIED", { verified: Boolean(remote), mirrorSuppressionsLifted: lifted.count, manual: Boolean(providerResult?.manual) }, actor, context, tx);
      return fresh;
    });
    if (applied) await observe({ organizationId: row.organizationId, contactId: row.contactId, state: remote ? "SUBSCRIBED" : "UNKNOWN", reason: null, observedAt: now });
    return applied;
  }

  async function markFailed(row, code, { providerResult = null, actor = null, context = {} } = {}) {
    const moved = await client.marketingProviderResubscription.updateMany({ where: { id: row.id, status: row.status }, data: { status: "FAILED", lastError: String(code).slice(0, 255), nextAttemptAt: null, completedAt: clock(), ...(providerResult ? { providerResult } : {}) } });
    if (moved.count === 1) await auditTransition({ ...row, status: "FAILED" }, "MARKETING_RESUBSCRIPTION_FAILED", { reason: String(code).slice(0, 64), attempts: row.attempts }, actor, context);
    return client.marketingProviderResubscription.findUnique({ where: { id: row.id } });
  }

  async function scheduleRetry(row, error) {
    const attempts = row.attempts;
    if (attempts >= MAX_ATTEMPTS) return markFailed(row, `RETRIES_EXHAUSTED_${String(error?.code || "ERROR").slice(0, 40)}`);
    const seconds = isQuotaExhausted(error) ? Math.ceil((new Date(error.quota.resetAt).getTime() - clock().getTime()) / 1000) : backoffSeconds(attempts);
    const nextAttemptAt = new Date(clock().getTime() + Math.max(1, seconds) * 1000);
    await client.marketingProviderResubscription.updateMany({ where: { id: row.id, status: "APPROVED" }, data: { nextAttemptAt, lastError: String(error?.code || "PROVIDER_ERROR").slice(0, 255) } });
    await auditTransition(row, "MARKETING_RESUBSCRIPTION_RETRY_SCHEDULED", { attempts, reason: String(error?.code || "PROVIDER_ERROR").slice(0, 64) });
    if (jobs) {
      await jobs.enqueue(null, { queue: "MARKETING", kind: "MARKETING_RESUBSCRIBE", idempotencyKey: `resubscribe:${row.id}:${attempts}`, payload: { resubscriptionId: row.id, organizationId: row.organizationId }, maxAttempts: 3, nextAttemptAt }).catch((enqueueError) => {
        if (enqueueError?.code !== "P2002") logger?.warn?.(`[Marketing] re-subscription retry not queued (${enqueueError?.code || "error"})`);
      });
    }
    return client.marketingProviderResubscription.findUnique({ where: { id: row.id } });
  }

  // One provider attempt for an APPROVED request whose attempt is due. A
  // short claim (next_attempt_at) keeps concurrent runners from both calling.
  async function applyOne(resubscriptionId) {
    const now = clock();
    const claim = await client.marketingProviderResubscription.updateMany({
      where: { id: resubscriptionId, status: "APPROVED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { nextAttemptAt: new Date(now.getTime() + CLAIM_SECONDS * 1000), attempts: { increment: 1 } },
    });
    const row = await client.marketingProviderResubscription.findUnique({ where: { id: resubscriptionId } });
    if (claim.count !== 1) return row;
    const [organization, contact] = await Promise.all([
      client.mailOrganization.findUnique({ where: { id: row.organizationId } }),
      client.marketingContact.findUnique({ where: { id: row.contactId } }),
    ]);
    // Re-check right before the provider call (consent may have been
    // withdrawn, a complaint or suppression may have arrived since approval).
    const guard = await guardReasons(client, row, { contact, organization });
    if (guard.length) {
      await refuseGuarded(row, guard, "system_before_provider_call");
      return client.marketingProviderResubscription.findUnique({ where: { id: row.id } });
    }
    const provider = marketingProviders(organization);
    if (!config.providerResubscribeEnabled || typeof provider.resubscribeContact !== "function" || provider.resubscribeSupported === false) {
      await client.marketingProviderResubscription.updateMany({ where: { id: row.id, status: "APPROVED" }, data: { status: "UNSUPPORTED", nextAttemptAt: null, lastError: "PROVIDER_RESUBSCRIBE_NOT_ENABLED", providerResult: { message: UNSUPPORTED_MESSAGE, flag: "MAIL_MARKETING_PROVIDER_RESUBSCRIBE_ENABLED", flagEnabled: Boolean(config.providerResubscribeEnabled) } } });
      const fresh = await client.marketingProviderResubscription.findUnique({ where: { id: row.id } });
      await auditTransition(fresh, "MARKETING_RESUBSCRIPTION_UNSUPPORTED", { reason: "PROVIDER_RESUBSCRIBE_NOT_ENABLED" });
      return fresh;
    }
    try {
      const remote = await provider.getContact(contact.email);
      if (!remote) {
        // The provider has no contact: the next sync creates it subscribed.
        return markApplied(row, { providerResult: { contactAbsent: true, at: now.toISOString() } });
      }
      if (remote.unsubscribed === true) await provider.resubscribeContact(remote.id);
      const check = await provider.getContact(contact.email);
      if (!verified(check)) return markFailed(row, "PROVIDER_VERIFICATION_MISMATCH", { providerResult: { patched: remote.unsubscribed === true, verifiedUnsubscribed: check?.unsubscribed ?? null } });
      return markApplied(row, { providerResult: { patched: remote.unsubscribed === true, verified: true, at: now.toISOString() }, remote: check });
    } catch (error) {
      if (error?.kind === "PERMANENT" || error?.kind === "IDEMPOTENCY_CONFLICT") return markFailed(row, error.code || "PROVIDER_REJECTED");
      if (error?.kind === "NOT_CONFIGURED") {
        await client.marketingProviderResubscription.updateMany({ where: { id: row.id, status: "APPROVED" }, data: { status: "UNSUPPORTED", nextAttemptAt: null, lastError: String(error.code || "PROVIDER_NOT_CONFIGURED").slice(0, 255), providerResult: { message: `The brand has no configured marketing provider account. ${UNSUPPORTED_MESSAGE}` } } });
        const fresh = await client.marketingProviderResubscription.findUnique({ where: { id: row.id } });
        await auditTransition(fresh, "MARKETING_RESUBSCRIPTION_UNSUPPORTED", { reason: "PROVIDER_NOT_CONFIGURED" });
        return fresh;
      }
      return scheduleRetry(row, error);
    }
  }

  // MARKETING_RESUBSCRIBE job (retries).
  async function process(job) {
    const id = job.payload?.resubscriptionId;
    if (!policy.isUuid(id) || !(await ready())) return { skipped: "NOT_READY_OR_INVALID" };
    const row = await client.marketingProviderResubscription.findUnique({ where: { id } });
    if (!row || row.status !== "APPROVED") return { skipped: row?.status || "MISSING" };
    if (row.nextAttemptAt && row.nextAttemptAt > clock()) return { defer: { seconds: Math.ceil((row.nextAttemptAt.getTime() - clock().getTime()) / 1000), code: "RESUBSCRIBE_NOT_DUE" } };
    const result = await applyOne(id);
    return { status: result?.status };
  }

  // Reconcile partial failures: due APPROVED requests of a brand (called from
  // broadcast sync). Never throws.
  async function reconcileDue(organizationId, { limit = 5 } = {}) {
    try {
      if (!(await ready())) return 0;
      const due = await client.marketingProviderResubscription.findMany({ where: { organizationId, status: "APPROVED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: clock() } }] }, take: limit, select: { id: true } });
      for (const row of due) await applyOne(row.id).catch(() => null);
      return due.length;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------- staff API
  async function loadOwned(organizationId, id) {
    const row = policy.isUuid(id) ? await client.marketingProviderResubscription.findUnique({ where: { id }, include: { contact: { select: { email: true, status: true } } } }) : null;
    if (!row || row.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "resubscription" });
    return row;
  }

  function serialize(row, state = undefined) {
    const evidence = row.consentEvidence || {};
    return {
      id: row.id,
      organizationId: row.organizationId,
      contactId: row.contactId,
      email: row.contact?.email ?? null,
      topic: row.topic,
      status: row.status,
      evidence: { consentId: evidence.consentId || null, topic: evidence.topic || row.topic, source: evidence.source || null, policyVersion: evidence.policyVersion || null, consentedAt: evidence.consentedAt || null, confirmedAt: evidence.confirmedAt || null, doubleOptIn: Boolean(evidence.doubleOptIn), providerState: evidence.providerState || null },
      requestedBy: row.requestedBy,
      approvedBy: row.approvedBy,
      attempts: row.attempts,
      nextAttemptAt: iso(row.nextAttemptAt),
      lastError: row.lastError,
      providerResult: row.providerResult || null,
      completedAt: iso(row.completedAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      ...(state !== undefined ? { providerState: state } : {}),
      operatorMessage: row.status === "UNSUPPORTED" ? UNSUPPORTED_MESSAGE : null,
      flags: { providerResubscribeEnabled: Boolean(config.providerResubscribeEnabled) },
    };
  }

  function serializeState(row) {
    return row ? { state: row.state, reason: row.reason, provider: row.provider, observedAt: iso(row.observedAt) } : { state: "UNKNOWN", reason: null, provider: null, observedAt: null };
  }

  async function list(user, organizationId, { status } = {}) {
    await scope(user, organizationId, "VIEW");
    await requireReady();
    const rows = await client.marketingProviderResubscription.findMany({
      where: { organizationId, ...(STATUSES.includes(status) ? { status } : {}) },
      include: { contact: { select: { email: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const states = await client.marketingContactProviderState.findMany({ where: { organizationId, contactId: { in: rows.map((row) => row.contactId) } } });
    const byContact = new Map(states.map((row) => [row.contactId, row]));
    return { items: rows.map((row) => serialize(row, serializeState(byContact.get(row.contactId)))), flags: { providerResubscribeEnabled: Boolean(config.providerResubscribeEnabled) } };
  }

  async function approve(user, organizationId, id, { stepUpId } = {}, context = {}) {
    await scope(user, organizationId, "APPROVE");
    await requireReady();
    const row = await loadOwned(organizationId, id);
    if (row.status !== "PENDING_APPROVAL") throw mailError("MAIL_INVALID_TRANSITION", { from: row.status });
    if (row.requestedBy && row.requestedBy === user.id) throw mailError("MAIL_FORBIDDEN", { reason: "REQUESTER_CANNOT_APPROVE" });
    const reasons = await guardReasons(client, row);
    if (reasons.length) {
      // Consumes nothing: a refusal does not need a step-up.
      await refuseGuarded(row, reasons, "system_at_approval", user.id, context);
      throw mailError("MAIL_INVALID_TRANSITION", { reason: "RESUBSCRIPTION_BLOCKED", reasons });
    }
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MARKETING_RESUBSCRIBE_APPROVE", context);
      const moved = await tx.marketingProviderResubscription.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "APPROVED", approvedBy: user.id, nextAttemptAt: null } });
      if (moved.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { reason: "CHANGED" });
      await auditTransition({ ...row, status: "APPROVED" }, "MARKETING_RESUBSCRIPTION_APPROVED", {}, user.id, context, tx);
    });
    await applyOne(id);
    return serialize(await loadOwned(organizationId, id));
  }

  async function refuse(user, organizationId, id, { reason } = {}, context = {}) {
    await scope(user, organizationId, "APPROVE");
    await requireReady();
    const text = String(reason || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (text.length < 3 || text.length > 255) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const row = await loadOwned(organizationId, id);
    if (!["PENDING_APPROVAL", "APPROVED", "UNSUPPORTED", "FAILED"].includes(row.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: row.status });
    const moved = await client.marketingProviderResubscription.updateMany({ where: { id, status: row.status }, data: { status: "REFUSED", lastError: `REFUSED_BY_APPROVER: ${text}`.slice(0, 255), completedAt: clock(), nextAttemptAt: null } });
    if (moved.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { reason: "CHANGED" });
    await auditTransition({ ...row, status: "REFUSED" }, "MARKETING_RESUBSCRIPTION_REFUSED", { previousStatus: row.status, byApprover: true }, user.id, context);
    return serialize(await loadOwned(organizationId, id));
  }

  // Operator confirms the alternative workflow was completed at the provider.
  // The provider contact is read back first; still unsubscribed -> FAILED.
  async function confirmManual(user, organizationId, id, { stepUpId, note } = {}, context = {}) {
    await scope(user, organizationId, "APPROVE");
    await requireReady();
    const row = await loadOwned(organizationId, id);
    if (!["UNSUPPORTED", "FAILED"].includes(row.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: row.status });
    const contact = await client.marketingContact.findUnique({ where: { id: row.contactId } });
    const reasons = await guardReasons(client, row, { contact });
    if (reasons.length) {
      await refuseGuarded(row, reasons, "system_at_manual_confirmation", user.id, context);
      throw mailError("MAIL_INVALID_TRANSITION", { reason: "RESUBSCRIPTION_BLOCKED", reasons });
    }
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MARKETING_RESUBSCRIBE_CONFIRM", context);
      await auditTransition(row, "MARKETING_RESUBSCRIPTION_MANUAL_CONFIRMATION", { note: note ? String(note).slice(0, 200) : null }, user.id, context, tx);
    });
    const organization = await client.mailOrganization.findUnique({ where: { id: organizationId } });
    let remote;
    try {
      remote = await marketingProviders(organization).getContact(contact.email);
    } catch (error) {
      throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: String(error?.code || "PROVIDER_ERROR").slice(0, 64) });
    }
    const fresh = await client.marketingProviderResubscription.findUnique({ where: { id } });
    if (remote && !verified(remote)) await markFailed(fresh, "PROVIDER_VERIFICATION_MISMATCH", { providerResult: { manual: true, verifiedUnsubscribed: true, confirmedBy: user.id }, actor: user.id, context });
    else await markApplied(fresh, { providerResult: { manual: true, confirmedBy: user.id, contactAbsent: !remote, verified: Boolean(remote) }, actor: user.id, context, remote });
    return serialize(await loadOwned(organizationId, id));
  }

  async function contactState(user, organizationId, contactId) {
    await scope(user, organizationId, "VIEW");
    await requireReady();
    const contact = policy.isUuid(contactId) ? await client.marketingContact.findUnique({ where: { id: contactId }, select: { id: true, organizationId: true } }) : null;
    if (!contact || contact.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "contact" });
    const [state, requests] = await Promise.all([
      client.marketingContactProviderState.findUnique({ where: { contactId } }),
      client.marketingProviderResubscription.findMany({ where: { contactId, organizationId }, orderBy: { createdAt: "desc" }, take: 20, include: { contact: { select: { email: true, status: true } } } }),
    ]);
    return { contactId, providerState: serializeState(state), resubscriptions: requests.map((row) => serialize(row)) };
  }

  async function contactStates(user, organizationId, { contactIds } = {}) {
    await scope(user, organizationId, "VIEW");
    await requireReady();
    const ids = String(contactIds || "").split(",").map((value) => value.trim()).filter((value) => policy.isUuid(value)).slice(0, 200);
    if (!ids.length) return { items: [] };
    const rows = await client.marketingContactProviderState.findMany({ where: { organizationId, contactId: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.contactId, row]));
    return { items: ids.map((contactId) => ({ contactId, ...serializeState(byId.get(contactId)) })) };
  }

  return {
    observe,
    supersededBy,
    providerExclusions,
    onDoubleOptInConfirmed,
    applyOne,
    process,
    reconcileDue,
    list,
    approve,
    refuse,
    confirmManual,
    contactState,
    contactStates,
    UNSUPPORTED_MESSAGE,
    emailHash,
  };
}

module.exports = { createResubscriptionService, UNSUPPORTED_MESSAGE, RESUBSCRIBE_MAX_ATTEMPTS: MAX_ATTEMPTS };

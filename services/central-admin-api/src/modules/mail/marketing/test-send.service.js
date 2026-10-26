"use strict";

// Campaign test sends (spec §5.5 "preview/test sends", §13.2 step 3).
// A marketer with author rights sends the rendered campaign to up to N
// active HQ staff addresses before review. Test sends can never reach an
// external or customer address, so they cannot be used to bypass audience,
// consent, suppression or approval. Every send passes the same provider gate
// as broadcasts (allowlist, verified domain, restricted-health block,
// emergency stop) and is audited. Job kind MARKETING_TEST_SEND.
// Gap 1: campaign test sends use MARKETING template versions only (the
// campaign's version is re-checked at request and at dispatch). Transactional
// templates are previewed through template QA / render preview instead.

const { quotaDeferSeconds } = require("../ops/provider-quota.service");
const crypto = require("crypto");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { externalSendBlockReason } = require("../authz/sending-gate");
const { normalizeAddress } = require("../security/address.util");
const { renderTemplate } = require("./template-renderer");
const { classifySendError, isBrandSender, SENDER_MAILBOX_SELECT } = require("./marketing-sender");
const { templatePolicyFor } = require("./template-policy");

const SAMPLE = { first_name: "Ada", last_name: "Lovelace", email: "test@example.invalid", unsubscribe_url: "https://example.invalid/unsubscribe-disabled-for-test-sends" };

// Runtime halts (brand pause, emergency stop) and quotas use the broadcast
// purpose: a paused brand or exhausted quota stops test sends too, and test
// sends count toward the brand's provider usage.
const PURPOSE = "MARKETING_BROADCAST";

function createTestSendService({ client, config, audit, jobs, marketingProviders, runtime = null, usage = null, clock = () => new Date(), templatePolicy = null }) {
  const templates = templatePolicy || templatePolicyFor(client);
  async function requestTestSend(user, organizationId, campaignId, { recipients } = {}, context = {}) {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    await policy.requireMarketingScope(client, user, organizationId, "EDIT");
    if (!config.testSendsEnabled) throw mailError("MAIL_TEST_SEND_DISABLED");
    if (config.emergencyStop.marketing) throw mailError("MAIL_EMERGENCY_STOP");
    const campaign = policy.isUuid(campaignId) ? await client.marketingEmailCampaign.findUnique({ where: { id: campaignId } }) : null;
    if (!campaign || campaign.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "campaign" });
    if (!campaign.templateVersionId || !campaign.senderAddressId) throw mailError("MAIL_VALIDATION_FAILED", { field: "campaign", reason: "TEMPLATE_AND_SENDER_REQUIRED" });
    await templates.assertTemplateUsable(campaign.templateVersionId, { purpose: "MARKETING", organizationId });
    const halt = runtime ? await runtime.haltReason(PURPOSE, { organizationId, adminUserId: user.id }) : null;
    if (halt) throw mailError(halt.startsWith("MAIL_ROLLOUT_") ? halt : "MAIL_EMERGENCY_STOP", { reason: halt });

    const requested = Array.isArray(recipients) && recipients.length ? recipients : [user.email];
    const normalized = [...new Set(requested.map((value) => normalizeAddress(String(value || ""))))];
    if (normalized.some((value) => !value)) throw mailError("MAIL_VALIDATION_FAILED", { field: "recipients" });
    if (normalized.length > config.testSend.maxRecipients) throw mailError("MAIL_VALIDATION_FAILED", { field: "recipients", reason: "TOO_MANY_RECIPIENTS", max: config.testSend.maxRecipients });
    // Only active HQ staff identities: never a customer or external address.
    const staff = await client.adminUser.findMany({ where: { email: { in: normalized, mode: "insensitive" }, status: "ACTIVE" }, select: { email: true } });
    const allowed = new Set(staff.map((row) => row.email.toLowerCase()));
    const refused = normalized.filter((value) => !allowed.has(value));
    if (refused.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "recipients", reason: "TEST_RECIPIENT_NOT_STAFF", count: refused.length });

    // Hourly limit per campaign, measured on the service clock via the minute
    // bucket that is part of every test-send idempotency key.
    const bucket = Math.floor(clock().getTime() / 60000);
    const prefix = `test-send:${campaign.id}:`;
    const recentJobs = await client.mailOutboxJob.findMany({ where: { kind: "MARKETING_TEST_SEND", idempotencyKey: { startsWith: prefix } }, select: { idempotencyKey: true }, orderBy: { createdAt: "desc" }, take: 200 });
    const recent = recentJobs.filter((row) => bucket - Number(row.idempotencyKey.split(":").pop()) < 60).length;
    if (recent >= config.testSend.perCampaignPerHour) throw mailError("MAIL_RATE_LIMITED", { reason: "TEST_SEND_LIMIT", perHour: config.testSend.perCampaignPerHour });

    const recipientsHash = crypto.createHash("sha256").update(normalized.sort().join(",")).digest("hex").slice(0, 24);
    const job = await jobs.enqueue(null, {
      queue: "MARKETING",
      kind: "MARKETING_TEST_SEND",
      idempotencyKey: `test-send:${campaign.id}:${campaign.revision}:${recipientsHash}:${bucket}`,
      payload: { organizationId, campaignId: campaign.id, revision: campaign.revision, recipients: normalized, requestedBy: user.id },
      maxAttempts: 4,
    }).catch((error) => {
      if (error?.code === "P2002") return null;
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_TEST_SEND_REQUESTED", targetType: "marketing_campaign", targetId: campaign.id, organizationId, metadata: { recipientCount: normalized.length, revision: campaign.revision, duplicate: !job } }, context);
    return { queued: true, duplicate: !job, recipientCount: normalized.length };
  }

  async function process(job) {
    const { organizationId, campaignId, revision, recipients = [] } = job.payload || {};
    if (!config.testSendsEnabled || config.emergencyStop.marketing) return { defer: { seconds: 900, code: "TEST_SENDS_HALTED" } };
    const [organization, campaign] = await Promise.all([
      client.mailOrganization.findUnique({ where: { id: organizationId } }),
      client.marketingEmailCampaign.findUnique({ where: { id: campaignId } }),
    ]);
    if (!organization || !campaign || campaign.organizationId !== organizationId) return { skipped: "CAMPAIGN_UNAVAILABLE" };
    if (campaign.revision !== revision) return { skipped: "CAMPAIGN_CHANGED" };
    // Re-check at dispatch: a recipient deactivated since the request is dropped.
    const active = await client.adminUser.findMany({ where: { email: { in: recipients, mode: "insensitive" }, status: "ACTIVE" }, select: { email: true } });
    const to = recipients.filter((value) => active.some((row) => row.email.toLowerCase() === value));
    if (!to.length) return { skipped: "NO_ACTIVE_RECIPIENTS" };
    const runtimeHalt = runtime ? await runtime.haltReason(PURPOSE, { organizationId, adminUserId: job.payload?.requestedBy || null }) : null;
    if (runtimeHalt) return { defer: { seconds: 900, code: runtimeHalt } };
    if (usage && !(await usage.check(organizationId, PURPOSE, to.length)).allowed) return { defer: { seconds: 3600, code: "MAIL_QUOTA_HARD_LIMIT" } };
    const [version, sender, brandSettings] = await Promise.all([
      client.marketingTemplateVersion.findUnique({ where: { id: campaign.templateVersionId }, include: { template: true } }),
      client.mailAddress.findUnique({ where: { id: campaign.senderAddressId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } }, mailbox: SENDER_MAILBOX_SELECT } }),
      client.marketingBrandSettings.findUnique({ where: { organizationId } }),
    ]);
    const senderOk = isBrandSender(sender, organizationId);
    const provider = marketingProviders(organization);
    const templateProblem = version ? await templates.usabilityProblem(version, { purpose: "MARKETING", organizationId }) : "TEMPLATE_UNAVAILABLE";
    const blocked = !version || version.template.organizationId !== organizationId ? "TEMPLATE_UNAVAILABLE" : templateProblem ? templateProblem : !senderOk ? "SENDER_NOT_AUTHORIZED" : externalSendBlockReason({ config, providerReady: () => provider.configured !== false && provider.name !== "unconfigured", domain: sender.domain });
    if (blocked) {
      await audit.record({ action: "MARKETING_TEST_SEND_BLOCKED", targetType: "marketing_campaign", targetId: campaignId, organizationId, outcome: "FAILURE", metadata: { reason: blocked } });
      return { skipped: blocked };
    }
    const rendered = renderTemplate({ subject: campaign.subjectOverride || version.subject, preheader: version.preheader, blocks: version.blocks, brand: { ...(version.brand || {}), ...(brandSettings?.postalAddress ? { postalAddress: brandSettings.postalAddress } : {}) } }, { data: SAMPLE });
    const results = [];
    for (const [index, address] of to.entries()) {
      try {
        const result = await provider.sendEmail({
          idempotencyKey: `${job.idempotencyKey}:${index}`,
          from: { address: sender.address, name: sender.displayName || organization.name },
          replyTo: campaign.replyTo ? { address: campaign.replyTo, name: null } : null,
          to: [{ address, name: null }],
          cc: [], bcc: [],
          subject: `[TEST] ${rendered.subject}`,
          html: rendered.html,
          text: `[TEST SEND - sample data, not delivered to the audience]\n\n${rendered.text}`,
          headers: { "X-CosmicForge-Test-Send": "1" },
          attachments: [],
        });
        results.push(result.providerMessageId || null);
      } catch (error) {
        // Provider quota exhausted: hold until it resets (earlier sends in this
        // job are deduplicated by their idempotency keys when it resumes).
        const quotaWait = quotaDeferSeconds(error, clock());
        if (quotaWait) return { defer: { seconds: quotaWait, code: "PROVIDER_QUOTA_EXHAUSTED" } };
        const verdict = classifySendError(error, { firstAttemptAt: job.createdAt, now: clock(), windowHours: config.reconciliation.idempotencyWindowHours });
        if (verdict.outcome === "RETRY") throw Object.assign(new Error(error.message), { code: verdict.code, retryable: true, retryAfterSeconds: verdict.retryAfterSeconds ?? null });
        await audit.record({ action: "MARKETING_TEST_SEND_FAILED", targetType: "marketing_campaign", targetId: campaignId, organizationId, outcome: verdict.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILURE", metadata: { reason: verdict.code } });
        throw Object.assign(new Error(verdict.code), { code: verdict.code, retryable: false });
      }
    }
    if (usage) await usage.record(null, { organizationId, purpose: PURPOSE, accepted: to.length, providerRequests: to.length }).catch(() => {});
    await audit.record({ action: "MARKETING_TEST_SEND_HANDED_TO_PROVIDER", targetType: "marketing_campaign", targetId: campaignId, organizationId, metadata: { recipientCount: to.length, revision } });
    return { providerMessageIds: results };
  }

  return { requestTestSend, process };
}

module.exports = { createTestSendService };

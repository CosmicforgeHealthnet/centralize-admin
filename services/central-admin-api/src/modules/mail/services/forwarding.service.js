"use strict";

// Controlled forwarding (spec 5.3, 5.4, 10.5). Never an open relay.
//
// Lifecycle: a personal mailbox owner (or a shared mailbox MANAGER/OWNER)
// requests forwarding to one address with a reason -> a DIFFERENT mail
// administrator approves or rejects. External targets must be on the
// MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS policy list and their approval
// needs MFA step-up. Requester, owner or admin can disable at any time;
// suspension and offboarding disable every rule of the mailbox (former
// employees' mail is never silently forwarded). Everything is audited.
//
// Execution (after an inbound copy is committed, never for quarantined or
// spam mail):
//   INTERNAL target: one local copy in the target mailbox (deduplicated by
//     Message-ID, so a recipient who also got the mail directly sees it once);
//     internal copies are never forwarded again (no internal chains).
//   EXTERNAL target: a new outbound message from the mailbox's own address
//     on behalf of the requester (Reply-To = original sender; no spoofed
//     From), through the normal outbox: sending flags, rollout, emergency
//     stops, quotas and dispatch-time re-authorization all apply. Only clean
//     attachments are forwarded; the forwarded text shows To/Cc only, never
//     BCC or the envelope recipient.
//   Loop prevention: Auto-Submitted + X-CosmicForge-Forwarded-Hops headers
//     (stop at MAIL_FORWARDING_MAX_HOPS), never forward mail that already
//     came from the target, and a per-rule hourly cap that disables a rule
//     that is clearly looping.

const crypto = require("crypto");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { normalizeAddress, domainOf } = require("../security/address.util");
const { sanitizeEmailHtml, escapeHtml } = require("../security/html-sanitizer");
const { sanitizeSubject } = require("../security/header-safety");
const { externalSendBlockReason } = require("../authz/sending-gate");
const { purposeForMailbox } = require("../ops/runtime-controls");
const { iso } = require("./serializers");

const HOURLY_CAP = 200;
const HOPS_HEADER = "x-cosmicforge-forwarded-hops";

function serializeRule(rule) {
  return {
    id: rule.id, mailboxId: rule.mailboxId, targetAddress: rule.targetAddress, targetKind: rule.targetKind, status: rule.status, reason: rule.reason,
    requestedBy: rule.requestedBy, requestedAt: iso(rule.requestedAt), decidedBy: rule.decidedBy, decidedAt: iso(rule.decidedAt), decisionNote: rule.decisionNote,
    disabledAt: iso(rule.disabledAt), disabledReason: rule.disabledReason, lastForwardedAt: iso(rule.lastForwardedAt), forwardedCount: rule.forwardedCount,
  };
}

function inboundHops(inbound) {
  const header = (inbound.originalHeaders || []).find((entry) => String(entry.name).toLowerCase() === HOPS_HEADER);
  const hops = Number.parseInt(String(header?.value || "0"), 10);
  return Number.isFinite(hops) && hops > 0 ? Math.min(hops, 99) : 0;
}

function createForwardingService({ client, config, features, store, jobs, audit, stepUp, notifications, providerReady = () => false, runtime = null, usage = null, clock = () => new Date(), logger = null }) {
  async function requireReady() {
    if (!(await features.isReady())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "forwarding" });
  }

  async function classifyTarget(mailbox, rawTarget) {
    const target = normalizeAddress(rawTarget);
    if (!target) throw mailError("MAIL_VALIDATION_FAILED", { field: "targetAddress" });
    const own = await client.mailAddress.findMany({ where: { mailboxId: mailbox.id }, select: { address: true } });
    if (own.some((row) => row.address === target)) throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "SAME_MAILBOX" });
    const local = await client.mailAddress.findUnique({ where: { address: target }, include: { mailbox: true } });
    if (local) {
      if (local.status !== "ACTIVE" || !local.mailboxId || local.mailbox?.status !== "ACTIVE") throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "TARGET_NOT_ACTIVE" });
      if (local.mailboxId === mailbox.id) throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "SAME_MAILBOX" });
      return { target, kind: "INTERNAL", local };
    }
    // An address on one of our own domains that is not provisioned is refused
    // (no forwarding into unrouted local addresses / catch-alls).
    const ownDomain = await client.mailDomain.findUnique({ where: { domain: domainOf(target) }, select: { id: true } });
    if (ownDomain) throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "UNPROVISIONED_LOCAL_ADDRESS" });
    return { target, kind: "EXTERNAL", local: null };
  }

  function externalAllowed(target) {
    const domain = domainOf(target);
    return config.forwarding.externalAllowedDomains.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
  }

  async function requireManage(user, mailboxId) {
    const access = await policy.requireMailboxAccess(client, user, mailboxId, "MANAGE");
    if (access.viaBreakGlass) throw mailError("MAIL_FORBIDDEN");
    return access.mailbox;
  }

  async function list(user, mailboxId) {
    await requireReady();
    const mailbox = await requireManage(user, mailboxId);
    const rows = await client.mailForwardingRule.findMany({ where: { mailboxId: mailbox.id }, orderBy: { requestedAt: "desc" }, take: 50 });
    return rows.map(serializeRule);
  }

  async function request(user, mailboxId, { targetAddress, reason } = {}, context = {}) {
    await requireReady();
    const mailbox = await requireManage(user, mailboxId);
    const cleanReason = String(reason || "").trim().slice(0, 500);
    if (cleanReason.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const { target, kind } = await classifyTarget(mailbox, targetAddress);
    if (kind === "EXTERNAL" && !externalAllowed(target)) throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "EXTERNAL_DOMAIN_NOT_ALLOWED" });
    const live = await client.mailForwardingRule.count({ where: { mailboxId: mailbox.id, status: { in: ["PENDING_APPROVAL", "ACTIVE"] } } });
    if (live >= config.forwarding.maxRulesPerMailbox) throw mailError("MAIL_VALIDATION_FAILED", { field: "targetAddress", reason: "TOO_MANY_FORWARDING_RULES" });
    const rule = await client.mailForwardingRule.create({ data: { mailboxId: mailbox.id, organizationId: mailbox.organizationId, targetAddress: target, targetKind: kind, reason: cleanReason, requestedBy: user.id, requestedAt: clock() } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "targetAddress", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_FORWARDING_REQUESTED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: mailbox.id, organizationId: mailbox.organizationId, metadata: { targetKind: kind, targetDomain: domainOf(target) } }, context);
    return serializeRule(rule);
  }

  async function adminList(user, { status } = {}) {
    await requireReady();
    await policy.requireMailAdmin(client, user, "VIEW");
    const allowed = ["PENDING_APPROVAL", "ACTIVE", "REJECTED", "DISABLED"];
    const rows = await client.mailForwardingRule.findMany({ where: status && allowed.includes(status) ? { status } : {}, orderBy: { requestedAt: "desc" }, take: 100, include: { mailbox: { select: { name: true, type: true } } } });
    return rows.map((row) => ({ ...serializeRule(row), mailbox: { name: row.mailbox.name, type: row.mailbox.type } }));
  }

  async function decide(user, ruleId, { approve, note, stepUpId } = {}, context = {}) {
    await requireReady();
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!policy.isUuid(ruleId)) throw mailError("MAIL_NOT_FOUND", { resource: "forwarding_rule" });
    const rule = await client.mailForwardingRule.findUnique({ where: { id: ruleId }, include: { mailbox: true } });
    if (!rule) throw mailError("MAIL_NOT_FOUND", { resource: "forwarding_rule" });
    if (rule.status !== "PENDING_APPROVAL") throw mailError("MAIL_INVALID_TRANSITION", { from: rule.status });
    // Separation of duties: nobody approves their own forwarding.
    if (rule.requestedBy === user.id) throw mailError("MAIL_FORBIDDEN", { reason: "SELF_APPROVAL" });
    const decisionNote = note ? String(note).trim().slice(0, 500) : null;
    if (approve) {
      if (rule.mailbox.status !== "ACTIVE") throw mailError("MAIL_INVALID_TRANSITION", { reason: "MAILBOX_NOT_ACTIVE" });
      // Policy is re-checked at decision time (lists can change).
      await classifyTarget(rule.mailbox, rule.targetAddress);
      if (rule.targetKind === "EXTERNAL" && !externalAllowed(rule.targetAddress)) throw mailError("MAIL_FORWARDING_NOT_ALLOWED", { reason: "EXTERNAL_DOMAIN_NOT_ALLOWED" });
    }
    const now = clock();
    const updated = await client.$transaction(async (tx) => {
      if (approve && rule.targetKind === "EXTERNAL") await stepUp.consume(tx, user, stepUpId, "MAIL_FORWARDING_APPROVE", context);
      const result = await tx.mailForwardingRule.updateMany({ where: { id: rule.id, status: "PENDING_APPROVAL" }, data: { status: approve ? "ACTIVE" : "REJECTED", decidedBy: user.id, decidedAt: now, decisionNote } });
      if (result.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: "CHANGED" });
      return tx.mailForwardingRule.findUnique({ where: { id: rule.id } });
    });
    await audit.record({ actorAdminUserId: user.id, action: approve ? "MAIL_FORWARDING_APPROVED" : "MAIL_FORWARDING_REJECTED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: rule.mailboxId, organizationId: rule.organizationId, metadata: { targetKind: rule.targetKind, targetDomain: domainOf(rule.targetAddress) } }, context);
    await notifications.notifyUsers([rule.requestedBy], { icon: approve ? "check" : "xcircle", title: approve ? "Forwarding approved" : "Forwarding request rejected", subtitle: `${rule.mailbox.name} -> ${rule.targetAddress}` }).catch(() => {});
    return serializeRule(updated);
  }

  // Requester/owner (MANAGE on the mailbox) or a mail administrator.
  async function disable(user, ruleId, { reason } = {}, context = {}) {
    await requireReady();
    if (!policy.isUuid(ruleId)) throw mailError("MAIL_NOT_FOUND", { resource: "forwarding_rule" });
    const rule = await client.mailForwardingRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw mailError("MAIL_NOT_FOUND", { resource: "forwarding_rule" });
    const isAdmin = await policy.canAdministerMail(client, user, "EDIT");
    if (!isAdmin) {
      try {
        await requireManage(user, rule.mailboxId);
      } catch (error) {
        if (error.code === "MAIL_NOT_FOUND" || error.statusCode === 404) throw mailError("MAIL_NOT_FOUND", { resource: "forwarding_rule" });
        throw error;
      }
    }
    if (!["PENDING_APPROVAL", "ACTIVE"].includes(rule.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: rule.status });
    await client.mailForwardingRule.updateMany({ where: { id: rule.id, status: { in: ["PENDING_APPROVAL", "ACTIVE"] } }, data: { status: "DISABLED", disabledAt: clock(), disabledBy: user.id, disabledReason: String(reason || (isAdmin ? "ADMIN_DISABLED" : "OWNER_DISABLED")).slice(0, 64) } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_FORWARDING_DISABLED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: rule.mailboxId, organizationId: rule.organizationId, metadata: { by: isAdmin ? "admin" : "owner" } }, context);
    return serializeRule(await client.mailForwardingRule.findUnique({ where: { id: rule.id } }));
  }

  // Suspension / offboarding: every pending or active rule stops.
  async function disableForMailbox(mailboxId, reason, actorId = null, context = {}) {
    if (!(await features.isReady())) return 0;
    const result = await client.mailForwardingRule.updateMany({ where: { mailboxId, status: { in: ["PENDING_APPROVAL", "ACTIVE"] } }, data: { status: "DISABLED", disabledAt: clock(), disabledBy: actorId, disabledReason: String(reason).slice(0, 64) } });
    if (result.count) await audit.record({ actorAdminUserId: actorId, action: "MAIL_FORWARDING_DISABLED", targetType: "mailbox", targetId: mailboxId, mailboxId, metadata: { count: result.count, reason } }, context);
    return result.count;
  }

  // Offboarding: rules a departing person requested (any mailbox) stop too.
  async function disableForRequester(adminUserId, reason, actorId = null, context = {}) {
    if (!(await features.isReady())) return 0;
    const result = await client.mailForwardingRule.updateMany({ where: { requestedBy: adminUserId, status: { in: ["PENDING_APPROVAL", "ACTIVE"] } }, data: { status: "DISABLED", disabledAt: clock(), disabledBy: actorId, disabledReason: String(reason).slice(0, 64) } });
    if (result.count) await audit.record({ actorAdminUserId: actorId, action: "MAIL_FORWARDING_DISABLED", targetType: "admin_user", targetId: adminUserId, metadata: { count: result.count, reason } }, context);
    return result.count;
  }

  // ---------------------------------------------------------------- execution
  function forwardedBody({ inbound, body, mailbox }) {
    const visible = [...(inbound.to || []).map((party) => `To: ${party.name ? `${party.name} <${party.address}>` : party.address}`), ...(inbound.cc || []).map((party) => `Cc: ${party.name ? `${party.name} <${party.address}>` : party.address}`)];
    const header = [`---------- Forwarded by ${mailbox.name} ----------`, `From: ${inbound.from.name ? `${inbound.from.name} <${inbound.from.address}>` : inbound.from.address}`, `Date: ${(inbound.receivedAt || clock()).toUTCString()}`, `Subject: ${inbound.subject || ""}`, ...visible];
    const text = `${header.join("\n")}\n\n${body.text || ""}`;
    const htmlHeader = `<div style="color:#555;font-size:12px;border-bottom:1px solid #ddd;margin-bottom:8px;padding-bottom:8px">${header.map(escapeHtml).join("<br>")}</div>`;
    const html = `${htmlHeader}${inbound.html ? sanitizeEmailHtml(inbound.html, { allowRemoteImages: false }).html : `<pre>${escapeHtml(body.text || "")}</pre>`}`;
    return { text, html };
  }

  async function underHourlyCap(rule) {
    const recent = await client.mailMessage.count({ where: { mailboxId: rule.mailboxId, idempotencyKey: { startsWith: `fwd:` }, createdAt: { gt: new Date(clock().getTime() - 3600000) } } });
    return recent < HOURLY_CAP;
  }

  async function primarySender(mailbox, requesterId) {
    const requester = await client.adminUser.findUnique({ where: { id: requesterId }, select: { id: true, status: true, tier: true } });
    if (!requester || requester.status !== "ACTIVE") return { blocked: "REQUESTER_NOT_ACTIVE" };
    const access = await policy.resolveMailboxAccess(client, requester, mailbox.id, { now: clock() });
    if (!access || access.viaBreakGlass || !access.canSend) return { blocked: "REQUESTER_CANNOT_SEND" };
    const identities = await policy.listSenderIdentities(client, requester, access, { now: clock() });
    const own = await client.mailAddress.findMany({ where: { mailboxId: mailbox.id, status: "ACTIVE", kind: { in: ["PRIMARY", "SHARED"] } }, select: { id: true } });
    const identity = identities.find((entry) => own.some((row) => row.id === entry.addressId));
    if (!identity) return { blocked: "NO_MAILBOX_IDENTITY" };
    return { requester, identity };
  }

  // Both target kinds: a deactivated requester's rule stops, and so does a
  // rule on a personal mailbox whose owner is no longer active.
  async function lifecycleBlockReason(source, rule) {
    const mailbox = source.type ? source : (await client.mailMailbox.findUnique({ where: { id: source.id } })) || source;
    const requester = await client.adminUser.findUnique({ where: { id: rule.requestedBy }, select: { status: true } });
    if (!requester || requester.status !== "ACTIVE") return "REQUESTER_NOT_ACTIVE";
    if (mailbox.type === "PERSONAL") {
      if (mailbox.status && mailbox.status !== "ACTIVE") return "MAILBOX_NOT_ACTIVE";
      const owner = mailbox.ownerAdminUserId ? await client.adminUser.findUnique({ where: { id: mailbox.ownerAdminUserId }, select: { status: true } }) : null;
      if (!owner || owner.status !== "ACTIVE") return "OWNER_NOT_ACTIVE";
    }
    return null;
  }

  // Called once per committed inbound mailbox copy. Never throws for a single
  // rule: failures are audited and the inbound delivery stays successful.
  async function forwardInbound({ mailbox, message, inbound, body, attachments = [] }) {
    if (!(await features.isReady())) return { forwarded: 0 };
    if (message.status === "QUARANTINED") return { forwarded: 0, skipped: "QUARANTINED" };
    const rules = await client.mailForwardingRule.findMany({ where: { mailboxId: mailbox.id, status: "ACTIVE" } });
    if (!rules.length) return { forwarded: 0 };
    const hops = inboundHops(inbound);
    let forwarded = 0;
    for (const rule of rules) {
      const skip = async (reason) => audit.record({ action: "MAIL_FORWARD_SKIPPED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: mailbox.id, outcome: "DENIED", metadata: { reason, messageId: message.id } });
      try {
        if (hops >= config.forwarding.maxHops) {
          await skip("LOOP_PREVENTED");
          continue;
        }
        if (inbound.from?.address === rule.targetAddress) {
          await skip("TARGET_IS_SENDER");
          continue;
        }
        if (!(await underHourlyCap(rule))) {
          await disableForMailbox(mailbox.id, "LOOP_SUSPECTED_HOURLY_CAP");
          await skip("HOURLY_CAP");
          break;
        }
        const lifecycleBlocked = await lifecycleBlockReason(mailbox, rule);
        if (lifecycleBlocked) {
          await skip(lifecycleBlocked);
          continue;
        }
        if (rule.targetKind === "INTERNAL") {
          const target = await client.mailAddress.findUnique({ where: { address: rule.targetAddress }, include: { mailbox: true } });
          if (!target || target.status !== "ACTIVE" || !target.mailboxId || target.mailbox?.status !== "ACTIVE") {
            await skip("TARGET_NOT_ACTIVE");
            continue;
          }
          const copy = await client.$transaction(async (tx) => {
            const created = await store.createMessage(tx, target.mailbox, {
              direction: "INBOUND", status: "RECEIVED", rfcMessageId: message.rfcMessageId, inReplyTo: message.inReplyTo, references: message.references,
              subject: message.subject, from: inbound.from, replyTo: inbound.replyTo, recipients: [...(inbound.to || []).map((party) => ({ ...party, type: "TO", status: "DELIVERED" })), ...(inbound.cc || []).map((party) => ({ ...party, type: "CC", status: "DELIVERED" }))],
              envelopeRecipient: target.address, text: body.text, body, hasAttachments: attachments.length > 0, sizeBytes: message.sizeBytes, providerMessageId: message.providerMessageId, authResults: message.authResults, receivedAt: message.receivedAt, at: message.receivedAt || clock(),
            });
            if (created.duplicate) return created;
            for (const attachment of attachments) {
              await tx.mailAttachment.create({ data: { mailboxId: target.mailboxId, messageId: created.message.id, filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, storageKey: attachment.storageKey, isInline: attachment.isInline, contentId: attachment.contentId, scanStatus: attachment.scanStatus, scanDetail: attachment.scanDetail, quarantined: attachment.quarantined } });
            }
            await tx.mailForwardingRule.update({ where: { id: rule.id }, data: { lastForwardedAt: clock(), forwardedCount: { increment: 1 } } });
            await audit.record({ action: "MAIL_FORWARDED_INTERNAL", targetType: "forwarding_rule", targetId: rule.id, mailboxId: mailbox.id, metadata: { sourceMessageId: message.id, targetMailboxId: target.mailboxId } }, {}, tx);
            return created;
          });
          if (!copy.duplicate) {
            forwarded += 1;
            const members = await notifications.mailboxMemberIds(target.mailboxId);
            await notifications.notifyUsers(members, { icon: "bell", kind: "NEW_MAIL", title: `New email in ${target.mailbox.name}`, subtitle: `Forwarded from ${mailbox.name}` }).catch(() => {});
          }
          continue;
        }
        // EXTERNAL
        const sender = await primarySender(mailbox, rule.requestedBy);
        if (sender.blocked) {
          await skip(sender.blocked);
          continue;
        }
        const senderAddress = await client.mailAddress.findUnique({ where: { id: sender.identity.addressId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } } } });
        const blocked = externalSendBlockReason({ config, providerReady, domain: senderAddress?.domain });
        if (blocked) {
          await skip(`SEND_${blocked}`);
          continue;
        }
        const purpose = purposeForMailbox(mailbox);
        const halted = runtime ? await runtime.haltReason(purpose, { organizationId: mailbox.organizationId, mailboxId: mailbox.id, domainId: senderAddress?.domainId, adminUserId: rule.requestedBy }) : null;
        if (halted) {
          await skip(halted);
          continue;
        }
        if (usage) {
          try {
            await usage.assertWithinQuota(mailbox.organizationId, purpose, 1);
          } catch {
            await skip("QUOTA_EXCEEDED");
            continue;
          }
        }
        const content = forwardedBody({ inbound, body, mailbox });
        const stored = await store.storeBody(content);
        const subject = sanitizeSubject(/^fwd?:/i.test(inbound.subject || "") ? inbound.subject : `Fwd: ${inbound.subject || ""}`);
        const clean = attachments.filter((attachment) => !attachment.quarantined && attachment.scanStatus === "CLEAN" && attachment.storageKey);
        const now = clock();
        const key = `fwd:${hops + 1}:${rule.id}:${message.id}`;
        await client.$transaction(async (tx) => {
          const existing = await tx.mailMessage.findUnique({ where: { idempotencyKey: key } });
          if (existing) return;
          const created = await store.createMessage(tx, mailbox, {
            direction: "OUTBOUND", status: "QUEUED", rfcMessageId: store.generateMessageId(domainOf(sender.identity.address)), subject,
            from: { address: sender.identity.address, name: sender.identity.displayName }, replyTo: inbound.from.address,
            recipients: [{ address: rule.targetAddress, name: null, type: "TO", status: "PENDING" }], text: stored.text, body: stored,
            senderAddressId: sender.identity.addressId, sentByAdminUserId: rule.requestedBy, hasAttachments: clean.length > 0,
            sizeBytes: stored.sizeBytes + clean.reduce((sum, attachment) => sum + attachment.sizeBytes, 0), idempotencyKey: key, at: now,
          });
          for (const attachment of clean) {
            await tx.mailAttachment.create({ data: { mailboxId: mailbox.id, messageId: created.message.id, filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, storageKey: attachment.storageKey, isInline: attachment.isInline, contentId: attachment.contentId, scanStatus: attachment.scanStatus, scanDetail: attachment.scanDetail, quarantined: false } });
          }
          await jobs.enqueue(tx, { queue: "OUTBOUND", kind: "SEND_MESSAGE", idempotencyKey: `send:${crypto.randomUUID()}`, messageId: created.message.id, maxAttempts: config.worker.maxAttempts });
          await tx.mailForwardingRule.update({ where: { id: rule.id }, data: { lastForwardedAt: now, forwardedCount: { increment: 1 } } });
          await audit.record({ action: "MAIL_FORWARD_QUEUED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: mailbox.id, metadata: { sourceMessageId: message.id, forwardedMessageId: created.message.id, targetDomain: domainOf(rule.targetAddress), attachments: clean.length, withheldAttachments: attachments.length - clean.length } }, {}, tx);
        });
        forwarded += 1;
      } catch (error) {
        logger?.warn?.(`[MailForwarding] rule ${rule.id} failed (${error?.code || "error"})`);
        await audit.record({ action: "MAIL_FORWARD_FAILED", targetType: "forwarding_rule", targetId: rule.id, mailboxId: mailbox.id, outcome: "FAILURE", metadata: { code: String(error?.code || "ERROR").slice(0, 64) } }).catch(() => {});
      }
    }
    return { forwarded };
  }

  // Dispatch-time check for a queued forwarded message (outbound processor).
  async function ruleStillActive(idempotencyKey) {
    const match = /^fwd:\d+:([0-9a-f-]{36}):/.exec(String(idempotencyKey || ""));
    if (!match) return true;
    const rule = await client.mailForwardingRule.findUnique({ where: { id: match[1] }, select: { status: true } });
    return rule?.status === "ACTIVE";
  }

  function forwardHeaders(idempotencyKey) {
    const match = /^fwd:(\d+):/.exec(String(idempotencyKey || ""));
    if (!match) return {};
    return { "Auto-Submitted": "auto-forwarded", "X-CosmicForge-Forwarded-Hops": String(Number(match[1])) };
  }

  return { list, request, adminList, decide, disable, disableForMailbox, disableForRequester, forwardInbound, ruleStillActive, forwardHeaders, inboundHops };
}

module.exports = { createForwardingService, serializeRule, inboundHops };

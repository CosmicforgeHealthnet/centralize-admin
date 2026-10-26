"use strict";

// Drafts, sending and draft attachments.
// - Draft writes use optimistic concurrency (revision); stale writes -> 409.
// - The From identity is resolved server side from approved sender identities;
//   browser-supplied From addresses are never trusted.
// - Send returns 202 + durable job id. Provider acceptance and delivery are
//   tracked separately; nothing here claims delivery.
// - Recipients that are local active mailboxes are delivered internally
//   (exactly one copy per mailbox, the only delivery path for them) and
//   deduplicated against later provider echoes by Message-ID per mailbox.
//   Whether the provider also gets internal To/Cc (so external recipients see
//   the full visible header set) is MAIL_MIXED_RECIPIENT_MODE, applied at
//   dispatch (outbound.processor.js, docs/cosmicforge-mail-mixed-recipients.md).
// - Before queuing: content policy (unsafe link schemes, misleading link
//   text), total size, provider suppressions, and quotas. The final quota
//   checks run inside the send transaction under per-user and per-org
//   advisory locks so concurrent sends cannot all pass.
// - A client Idempotency-Key replays only for the same draft; reuse for a
//   different draft is a 409.

const crypto = require("crypto");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { parsePartyList, domainOf } = require("../security/address.util");
const { sanitizeSubject, assertHeaderSafe } = require("../security/header-safety");
const { sanitizeEmailHtml, htmlToText, escapeHtml } = require("../security/html-sanitizer");
const { evaluateAttachment } = require("../scanning/attachment-scanner");
const { serializeAttachment, iso } = require("./serializers");
const { externalSendBlockReason, SEND_BLOCK_REASONS } = require("../authz/sending-gate");
const { purposeForMailbox } = require("../ops/runtime-controls");
const { scanLinks } = require("../marketing/link-scan");

const DRAFT_PURPOSE = "mail-draft";
const BLOCKED_LINK_SCHEMES = new Set(["javascript", "data", "vbscript"]);

// Staff content policy: script-like link schemes and anchor text that shows
// one host while linking to another (phishing pattern) are refused.
function assertContentPolicy(html) {
  const { issues } = scanLinks(html);
  const blocked = issues.filter((issue) => (issue.kind === "UNSAFE_SCHEME" && BLOCKED_LINK_SCHEMES.has(issue.detail)) || issue.kind === "MISLEADING_TEXT");
  if (blocked.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "html", reason: "UNSAFE_LINK", issues: blocked.slice(0, 5), status: 422 }, "This message contains a link that is not allowed (unsafe link type or link text that shows a different site).");
}

function createComposeService({ client, config, store, encryption, scanner, jobs, audit, notifications, preferences = null, providerReady = () => false, runtime = null, usage = null, deletions = null, clock = () => new Date() }) {
  function encryptDraftBody(html, text) {
    if (!encryption.available) throw mailError("MAIL_STORAGE_UNAVAILABLE");
    return encryption.encryptJson({ html, text }, DRAFT_PURPOSE);
  }

  function decryptDraftBody(draft) {
    if (!draft.encryptedBody) return { html: "", text: "" };
    try {
      return encryption.decryptJson(draft.encryptedBody, DRAFT_PURPOSE);
    } catch {
      throw mailError("MAIL_STORAGE_UNAVAILABLE", {}, "Draft content could not be decrypted");
    }
  }

  function parseRecipients(input, field) {
    const { parties, invalid } = parsePartyList(input || []);
    if (invalid.length) throw mailError("MAIL_VALIDATION_FAILED", { field, invalid: invalid.slice(0, 5) });
    return parties;
  }

  function normalizeBody({ html, text }) {
    const rawHtml = html == null ? null : String(html);
    if (rawHtml && Buffer.byteLength(rawHtml) > config.limits.bodyMaxBytes) throw mailError("MAIL_VALIDATION_FAILED", { field: "html", reason: "TOO_LARGE" });
    const safeHtml = rawHtml ? sanitizeEmailHtml(rawHtml, { allowRemoteImages: true }).html : "";
    const plain = text != null ? String(text).slice(0, config.limits.bodyMaxBytes) : htmlToText(safeHtml);
    return { html: safeHtml, text: plain };
  }

  async function serializeDraft(draft) {
    const body = decryptDraftBody(draft);
    const attachments = await client.mailAttachment.findMany({ where: { draftId: draft.id } });
    return {
      id: draft.id,
      mailboxId: draft.mailboxId,
      mode: draft.mode,
      threadId: draft.threadId,
      inReplyToMessageId: draft.inReplyToMessageId,
      senderAddressId: draft.senderAddressId,
      to: draft.toRecipients,
      cc: draft.ccRecipients,
      bcc: draft.bccRecipients,
      subject: draft.subject,
      html: body.html || "",
      text: body.text || "",
      revision: draft.revision,
      status: draft.status,
      attachments: attachments.map(serializeAttachment),
      updatedAt: iso(draft.updatedAt),
    };
  }

  async function loadOwnDraft(user, draftId, capability = "SEND") {
    policy.assertActiveIdentity(user);
    if (!policy.isUuid(draftId)) throw mailError("MAIL_NOT_FOUND", { resource: "draft" });
    const draft = await client.mailDraft.findUnique({ where: { id: draftId } });
    // Drafts are private to their author even inside shared mailboxes.
    if (!draft || draft.authorAdminUserId !== user.id || draft.status === "DISCARDED") throw mailError("MAIL_NOT_FOUND", { resource: "draft" });
    const access = await policy.requireMailboxAccess(client, user, draft.mailboxId, capability);
    return { draft, access };
  }

  async function ownAddresses(mailboxId) {
    const rows = await client.mailAddress.findMany({ where: { mailboxId }, select: { address: true } });
    return new Set(rows.map((row) => row.address));
  }

  async function prefillFromSource(user, access, mode, inReplyToMessageId) {
    const source = await client.mailMessage.findUnique({ where: { id: inReplyToMessageId }, include: { recipients: true } });
    if (!source || source.mailboxId !== access.mailbox.id) throw mailError("MAIL_NOT_FOUND", { resource: "message" });
    const own = await ownAddresses(access.mailbox.id);
    // GAP 8: Reply-All never re-adds the replier's own sender identities
    // (e.g. a personal address Cc'd on a shared-mailbox copy). Bcc rows are
    // never copied: internal copies hold none, and the sender's own BCC list
    // stays private.
    if (mode === "REPLY_ALL") {
      const identities = await policy.listSenderIdentities(client, user, access, { now: clock() }).catch(() => []);
      for (const identity of identities) if (identity?.address) own.add(identity.address);
    }
    const sourceBody = await store.readBody(source).catch(() => ({ html: null, text: null }));
    const quoted = `<br><br><blockquote>${sourceBody.html ? sanitizeEmailHtml(sourceBody.html).html : escapeHtml(sourceBody.text || "")}</blockquote>`;
    const subjectPrefix = mode === "FORWARD" ? "Fwd: " : "Re: ";
    const subject = /^(re|fwd?):/i.test(source.subject) && subjectPrefix === "Re: " ? source.subject : `${subjectPrefix}${source.subject}`;
    if (mode === "FORWARD") return { to: [], cc: [], subject, html: quoted, threadId: null };
    const primary = source.direction === "OUTBOUND"
      ? source.recipients.filter((recipient) => recipient.type === "TO").map((recipient) => ({ address: recipient.address, name: recipient.name }))
      : [{ address: source.replyTo || source.fromAddress, name: source.replyTo ? null : source.fromName }];
    let cc = [];
    if (mode === "REPLY_ALL") {
      cc = source.recipients
        .filter((recipient) => recipient.type !== "BCC" && !own.has(recipient.address) && !primary.some((party) => party.address === recipient.address))
        .map((recipient) => ({ address: recipient.address, name: recipient.name }));
    }
    return { to: primary.filter((party) => !own.has(party.address) || source.direction === "OUTBOUND"), cc, subject, html: quoted, threadId: source.threadId };
  }

  async function createDraft(user, mailboxId, input) {
    const access = await policy.requireMailboxAccess(client, user, mailboxId, "SEND");
    const mode = ["NEW", "REPLY", "REPLY_ALL", "FORWARD"].includes(input.mode) ? input.mode : "NEW";
    let prefill = { to: [], cc: [], subject: "", html: "", threadId: null };
    if (mode !== "NEW") {
      if (!policy.isUuid(input.inReplyToMessageId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "inReplyToMessageId" });
      prefill = await prefillFromSource(user, access, mode, input.inReplyToMessageId);
    }
    const identities = await policy.listSenderIdentities(client, user, access);
    // Explicit choice, else the caller's preferred sender (spec 15) when it is
    // an identity of THIS mailbox, else the first identity.
    const preferred = (input.senderAddressId || !preferences) ? null : await preferences.defaultSenderFor(user, identities);
    const senderAddressId = input.senderAddressId || preferred || identities[0]?.addressId || null;
    if (senderAddressId && !identities.some((identity) => identity.addressId === senderAddressId)) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { field: "senderAddressId" });
    const to = input.to ? parseRecipients(input.to, "to") : prefill.to;
    const cc = input.cc ? parseRecipients(input.cc, "cc") : prefill.cc;
    const bcc = parseRecipients(input.bcc, "bcc");
    const mailbox = await client.mailMailbox.findUnique({ where: { id: mailboxId } });
    const signature = mailbox.signatureHtml ? `<br><br>${sanitizeEmailHtml(mailbox.signatureHtml).html}` : "";
    const body = normalizeBody({ html: input.html != null ? input.html : `${signature}${prefill.html}`, text: input.text });
    const draft = await client.mailDraft.create({
      data: {
        mailboxId,
        authorAdminUserId: user.id,
        senderAddressId,
        threadId: prefill.threadId,
        inReplyToMessageId: mode === "NEW" ? null : input.inReplyToMessageId,
        mode,
        toRecipients: to,
        ccRecipients: cc,
        bccRecipients: bcc,
        subject: sanitizeSubject(input.subject != null ? input.subject : prefill.subject),
        encryptedBody: encryptDraftBody(body.html, body.text),
      },
    });
    return serializeDraft(draft);
  }

  async function listDrafts(user, mailboxId) {
    await policy.requireMailboxAccess(client, user, mailboxId, "READ");
    const drafts = await client.mailDraft.findMany({ where: { mailboxId, authorAdminUserId: user.id, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, take: 100 });
    return drafts.map((draft) => ({ id: draft.id, subject: draft.subject, to: draft.toRecipients, mode: draft.mode, threadId: draft.threadId, revision: draft.revision, updatedAt: iso(draft.updatedAt) }));
  }

  async function getDraft(user, draftId) {
    const { draft } = await loadOwnDraft(user, draftId, "READ");
    return serializeDraft(draft);
  }

  async function updateDraft(user, draftId, input) {
    const { draft, access } = await loadOwnDraft(user, draftId, "SEND");
    const revision = Number(input.revision);
    if (!Number.isInteger(revision) || revision < 1) throw mailError("MAIL_VALIDATION_FAILED", { field: "revision" });
    if (draft.status !== "ACTIVE") throw mailError("MAIL_INVALID_TRANSITION", { from: draft.status });
    const data = {};
    if (input.to !== undefined) data.toRecipients = parseRecipients(input.to, "to");
    if (input.cc !== undefined) data.ccRecipients = parseRecipients(input.cc, "cc");
    if (input.bcc !== undefined) data.bccRecipients = parseRecipients(input.bcc, "bcc");
    if (input.subject !== undefined) data.subject = sanitizeSubject(input.subject);
    if (input.senderAddressId !== undefined) {
      await policy.requireSenderIdentity(client, user, access, input.senderAddressId);
      data.senderAddressId = input.senderAddressId;
    }
    if (input.html !== undefined || input.text !== undefined) {
      const current = decryptDraftBody(draft);
      const body = normalizeBody({ html: input.html !== undefined ? input.html : current.html, text: input.text !== undefined ? input.text : input.html !== undefined ? undefined : current.text });
      data.encryptedBody = encryptDraftBody(body.html, body.text);
    }
    const result = await client.mailDraft.updateMany({ where: { id: draftId, revision, status: "ACTIVE" }, data: { ...data, revision: { increment: 1 } } });
    if (result.count !== 1) {
      const current = await client.mailDraft.findUnique({ where: { id: draftId }, select: { revision: true } });
      throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: current?.revision ?? null });
    }
    return serializeDraft(await client.mailDraft.findUnique({ where: { id: draftId } }));
  }

  // Gap 5: with the durable deletion queue (migration 37) and no legal hold on
  // the mailbox/author, discarding a draft (or removing one of its files)
  // drops the attachment rows and enqueues their objects for deletion in the
  // same transaction, settled right after commit. Otherwise (pre-37, or held)
  // rows are only unlinked and the retention draft sweep removes them later.
  async function queuedDraftCleanup(draft) {
    if (!deletions || !(await deletions.ready())) return false;
    return !(await deletions.scopeHeld({ mailboxId: draft.mailboxId, adminUserIds: [draft.authorAdminUserId] }));
  }

  async function dropDraftAttachments(tx, draft, where, reason) {
    const rows = await tx.mailAttachment.findMany({ where: { ...where, draftId: draft.id, messageId: null }, select: { id: true, storageKey: true } });
    if (!rows.length) return null;
    await deletions.dropAttachments(tx, { id: { in: rows.map((row) => row.id) }, draftId: draft.id, messageId: null });
    return deletions.enqueue(tx, rows.map((row) => row.storageKey), { purpose: "COMPOSE", reason, sourceType: "draft", sourceId: draft.id, mailboxId: draft.mailboxId, requestedBy: draft.authorAdminUserId });
  }

  async function discardDraft(user, draftId) {
    const { draft } = await loadOwnDraft(user, draftId, "READ");
    if (draft.status !== "ACTIVE") throw mailError("MAIL_INVALID_TRANSITION", { from: draft.status });
    if (await queuedDraftCleanup(draft)) {
      const plan = await client.$transaction(async (tx) => {
        const changed = await tx.mailDraft.updateMany({ where: { id: draftId, status: "ACTIVE" }, data: { status: "DISCARDED", encryptedBody: null } });
        if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: "SENDING" });
        return dropDraftAttachments(tx, draft, {}, "DRAFT_DISCARDED");
      });
      if (plan) await deletions.settle(plan);
      return { discarded: true };
    }
    await client.mailDraft.update({ where: { id: draftId }, data: { status: "DISCARDED", encryptedBody: null } });
    return { discarded: true };
  }

  async function addAttachment(user, draftId, file) {
    const { draft } = await loadOwnDraft(user, draftId, "SEND");
    if (!file?.buffer) throw mailError("MAIL_VALIDATION_FAILED", { field: "file" });
    if (file.buffer.length > config.limits.attachmentMaxBytes) throw mailError("MAIL_ATTACHMENT_TOO_LARGE", { maxBytes: config.limits.attachmentMaxBytes });
    const count = await client.mailAttachment.count({ where: { draftId } });
    if (count >= config.limits.maxAttachmentsPerMessage) throw mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: "TOO_MANY_ATTACHMENTS" });
    const filename = String(file.originalname || "attachment").replace(/[\r\n\u0000"\\/]/g, "_").slice(0, 255);
    const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(file.mimetype || "")) ? file.mimetype.toLowerCase() : "application/octet-stream";
    const verdict = await evaluateAttachment(scanner, { filename, contentType, buffer: file.buffer, maxBytes: config.limits.attachmentMaxBytes });
    const stored = await store.storeAttachmentContent(file.buffer);
    const attachment = await client.mailAttachment.create({
      data: { mailboxId: draft.mailboxId, draftId, filename, contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, storageKey: stored.key, scanStatus: verdict.scanStatus, scanDetail: verdict.scanDetail, quarantined: verdict.quarantined, uploadedByAdminUserId: user.id },
    });
    await audit.record({ actorAdminUserId: user.id, action: verdict.quarantined ? "MAIL_ATTACHMENT_QUARANTINED" : "MAIL_ATTACHMENT_UPLOADED", targetType: "attachment", targetId: attachment.id, mailboxId: draft.mailboxId, metadata: { scanStatus: verdict.scanStatus, sizeBytes: stored.sizeBytes } });
    return serializeAttachment(attachment);
  }

  // Re-audit fix 1: removing a file takes the draft row lock (a guarded
  // touch on an ACTIVE draft; the revision is NOT bumped so an open editor
  // keeps saving). A send that already claimed the draft (SENDING) makes this
  // fail with 409 instead of deleting a file the send is copying; a send that
  // claims after this commits re-reads the files inside its transaction and
  // refuses with a revision conflict when the set changed.
  async function lockActiveDraft(tx, draftId) {
    const touched = await tx.mailDraft.updateMany({ where: { id: draftId, status: "ACTIVE" }, data: { updatedAt: clock() } });
    if (touched.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null, reason: "DRAFT_NOT_ACTIVE" });
  }

  async function removeAttachment(user, draftId, attachmentId) {
    const { draft } = await loadOwnDraft(user, draftId, "SEND");
    if (policy.isUuid(String(attachmentId)) && (await queuedDraftCleanup(draft))) {
      const plan = await client.$transaction(async (tx) => {
        await lockActiveDraft(tx, draftId);
        const queued = await dropDraftAttachments(tx, draft, { id: String(attachmentId) }, "DRAFT_ATTACHMENT_REMOVED");
        if (!queued) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
        return queued;
      });
      await deletions.settle(plan);
      return { removed: true };
    }
    const result = await client.$transaction(async (tx) => {
      await lockActiveDraft(tx, draftId);
      return tx.mailAttachment.updateMany({ where: { id: String(attachmentId), draftId }, data: { draftId: null, quarantined: true } });
    });
    if (!result.count) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    return { removed: true };
  }

  // Runs inside the send transaction. Advisory locks (user, then org, always
  // in that order) serialize concurrent sends so the counts below are final.
  async function enforceQuota(tx, user, mailbox, { recipients, external }) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mail-send-quota:user:${user.id}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mail-send-quota:org:${mailbox.organizationId}`}))`;
    const now = clock();
    const recentByUser = await tx.mailMessage.count({ where: { sentByAdminUserId: user.id, direction: "OUTBOUND", createdAt: { gt: new Date(now.getTime() - 60000) } } });
    if (recentByUser >= config.limits.sendsPerMinutePerUser) throw mailError("MAIL_RATE_LIMITED", { retryAfter: 60 });
    // The mailbox daily quota counts recipients, not messages.
    const dailyForMailbox = await tx.mailMessageRecipient.count({ where: { message: { mailboxId: mailbox.id, direction: "OUTBOUND", createdAt: { gt: new Date(now.getTime() - 86400000) } } } });
    if (dailyForMailbox + recipients > mailbox.dailySendQuota) throw mailError("MAIL_QUOTA_EXCEEDED", { limit: mailbox.dailySendQuota, unit: "recipients" });
    // Org hard limit: accepted + queued external recipients + this send.
    if (external && usage) await usage.assertWithinQuota(mailbox.organizationId, purposeForMailbox(mailbox), external, { db: tx });
  }

  // A client Idempotency-Key replays only the message sent from this draft.
  async function findReplay(messageKey, draftId) {
    const existing = await client.mailMessage.findUnique({ where: { idempotencyKey: messageKey }, include: { outboxJobs: true } });
    if (!existing) return null;
    const draft = policy.isUuid(draftId) ? await client.mailDraft.findUnique({ where: { id: draftId }, select: { sentMessageId: true } }) : null;
    if (!draft || draft.sentMessageId !== existing.id) throw mailError("MAIL_INVALID_TRANSITION", { field: "Idempotency-Key", reason: "IDEMPOTENCY_KEY_REUSED" }, "This Idempotency-Key was already used for a different draft.");
    return { messageId: existing.id, threadId: existing.threadId, jobId: existing.outboxJobs[0]?.id || null, status: existing.status, replayed: true };
  }

  async function sendDraft(user, draftId, { revision, idempotencyKey, replyToAddressId = null }, context = {}) {
    if (!config.enabled) throw mailError("MAIL_DISABLED");
    const clientKey = idempotencyKey ? String(idempotencyKey).slice(0, 80) : null;
    if (clientKey && !/^[A-Za-z0-9_.:-]{8,80}$/.test(clientKey)) throw mailError("MAIL_VALIDATION_FAILED", { field: "Idempotency-Key" });
    const messageKey = clientKey ? `${user.id}:${clientKey}` : null;
    if (messageKey) {
      const replay = await findReplay(messageKey, draftId);
      if (replay) return replay;
    }
    const { draft, access } = await loadOwnDraft(user, draftId, "SEND");
    if (draft.status !== "ACTIVE") {
      // A concurrent request with the same key may have just sent it.
      const replay = messageKey ? await findReplay(messageKey, draftId) : null;
      if (replay) return replay;
      throw mailError("MAIL_INVALID_TRANSITION", { from: draft.status });
    }
    if (Number(revision) !== draft.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: draft.revision });
    const mailbox = access.mailbox;
    if (!draft.senderAddressId) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { field: "senderAddressId" });
    const identity = await policy.requireSenderIdentity(client, user, access, draft.senderAddressId);
    // Optional Reply-To: must be an address the user may send as.
    let replyTo = null;
    if (replyToAddressId != null && replyToAddressId !== "") {
      if (!policy.isUuid(replyToAddressId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "replyToAddressId" });
      const identities = await policy.listSenderIdentities(client, user, access, { now: clock() });
      const match = identities.find((entry) => entry.addressId === replyToAddressId);
      if (!match) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { field: "replyToAddressId" });
      replyTo = match.address;
    }
    const to = parseRecipients(draft.toRecipients, "to");
    const cc = parseRecipients(draft.ccRecipients, "cc");
    const bcc = parseRecipients(draft.bccRecipients, "bcc");
    const all = [...to.map((party) => ({ ...party, type: "TO" })), ...cc.map((party) => ({ ...party, type: "CC" })), ...bcc.map((party) => ({ ...party, type: "BCC" }))];
    if (!all.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "to", reason: "RECIPIENT_REQUIRED" });
    if (all.length > config.limits.maxRecipients) throw mailError("MAIL_VALIDATION_FAILED", { field: "to", reason: "TOO_MANY_RECIPIENTS" });
    const subject = sanitizeSubject(draft.subject);
    assertHeaderSafe(subject, "subject");

    // Thread collision lock for shared support conversations.
    if (draft.threadId) {
      const thread = await client.mailThread.findUnique({ where: { id: draft.threadId } });
      if (thread?.lockedByAdminUserId && thread.lockedByAdminUserId !== user.id && thread.lockExpiresAt > clock()) {
        throw mailError("MAIL_CONVERSATION_LOCKED", { lockedBy: thread.lockedByAdminUserId });
      }
    }

    const attachments = await client.mailAttachment.findMany({ where: { draftId } });
    if (attachments.some((attachment) => attachment.quarantined || attachment.scanStatus !== "CLEAN")) throw mailError("MAIL_ATTACHMENT_NOT_CLEAN");
    const draftBody = decryptDraftBody(draft);
    assertContentPolicy(draftBody.html);
    // Total size (raw body + attachment bytes, before transfer encoding).
    const totalBytes = Buffer.byteLength(draftBody.html || "") + Buffer.byteLength(draftBody.text || "") + attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
    if (totalBytes > config.limits.messageMaxBytes) throw mailError("MAIL_VALIDATION_FAILED", { field: "body", reason: "MESSAGE_TOO_LARGE", maxBytes: config.limits.messageMaxBytes, sizeBytes: totalBytes, status: 413 }, "This message is too large to send. Remove attachments or shorten it.");

    const recipientAddresses = all.map((party) => party.address);
    const internalRows = await client.mailAddress.findMany({ where: { address: { in: recipientAddresses }, status: "ACTIVE", mailboxId: { not: null }, mailbox: { status: "ACTIVE" } }, include: { mailbox: true } });
    const internalByAddress = new Map(internalRows.map((row) => [row.address, row]));
    const externalRecipients = all.filter((party) => !internalByAddress.has(party.address));
    if (externalRecipients.length) {
      const senderAddress = await client.mailAddress.findUnique({ where: { id: identity.addressId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } } } });
      const blocked = externalSendBlockReason({ config, providerReady, domain: senderAddress?.domain });
      if (blocked === SEND_BLOCK_REASONS.SENDING_DISABLED) throw mailError("MAIL_SENDING_DISABLED");
      if (blocked === SEND_BLOCK_REASONS.PROVIDER_NOT_CONFIGURED) throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: blocked });
      if (blocked) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { reason: blocked });
      // M9: emergency stop and brand/purpose hard limits (external mail only).
      const purpose = purposeForMailbox(mailbox);
      const halted = runtime ? await runtime.haltReason(purpose, { organizationId: mailbox.organizationId, mailboxId: mailbox.id, domainId: senderAddress?.domainId, adminUserId: user.id }) : null;
      if (halted) throw mailError(halted.startsWith("MAIL_ROLLOUT_") ? halted : "MAIL_EMERGENCY_STOP", { reason: halted });
      // Addresses the provider reported as bounced/complained for this brand.
      const suppressed = await client.marketingSuppression.findMany({ where: { organizationId: mailbox.organizationId, email: { in: externalRecipients.map((party) => party.address) }, liftedAt: null, reason: { in: ["BOUNCED", "COMPLAINED"] } }, select: { email: true } });
      if (suppressed.length) {
        const addresses = [...new Set(suppressed.map((row) => row.email))].slice(0, 10);
        throw mailError("MAIL_VALIDATION_FAILED", { field: "to", reason: "RECIPIENT_SUPPRESSED", addresses, status: 422 }, `Cannot send to ${addresses.join(", ")}: the address previously bounced or reported this sender as spam.`);
      }
    }

    const source = draft.inReplyToMessageId ? await client.mailMessage.findUnique({ where: { id: draft.inReplyToMessageId } }) : null;
    const inReplyTo = draft.mode === "REPLY" || draft.mode === "REPLY_ALL" ? source?.rfcMessageId || null : null;
    const references = inReplyTo ? [...(source.references || []), source.rfcMessageId].slice(-20) : [];
    const body = await store.storeBody({ html: draftBody.html, text: draftBody.text });
    const rfcMessageId = store.generateMessageId(domainOf(identity.address));
    const now = clock();
    const sendKey = `send:${crypto.randomUUID()}`;
    const fromParty = { address: identity.address, name: identity.displayName };
    const sizeBytes = body.sizeBytes + attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);

    let result;
    try {
      result = await client.$transaction(async (tx) => {
        // Claim first: a concurrent same-draft send waits here, not on the locks.
        const claimed = await tx.mailDraft.updateMany({ where: { id: draftId, revision: draft.revision, status: "ACTIVE" }, data: { status: "SENDING" } });
        if (claimed.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
        // Re-audit fix 1: the files read above may be stale (a concurrent
        // removal, or a rescan that changed a verdict). Lock and re-read them
        // under the claim; any change aborts the send (nothing is copied).
        await tx.$queryRaw`SELECT "id" FROM "mail_attachments" WHERE "draft_id" = ${draftId}::uuid FOR UPDATE`;
        const current = await tx.mailAttachment.findMany({ where: { draftId } });
        const before = new Map(attachments.map((attachment) => [attachment.id, attachment]));
        const changedSet = current.length !== attachments.length || current.some((attachment) => {
          const seen = before.get(attachment.id);
          return !seen || seen.storageKey !== attachment.storageKey || seen.sha256 !== attachment.sha256 || seen.scanStatus !== attachment.scanStatus || seen.quarantined !== attachment.quarantined;
        });
        if (current.some((attachment) => attachment.quarantined || attachment.scanStatus !== "CLEAN" || !attachment.storageKey)) throw mailError("MAIL_ATTACHMENT_NOT_CLEAN");
        if (changedSet) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: draft.revision, reason: "ATTACHMENTS_CHANGED" });
        await enforceQuota(tx, user, mailbox, { recipients: all.length, external: externalRecipients.length });
        const recipients = all.map((party) => ({ ...party, status: internalByAddress.has(party.address) ? "INTERNAL_DELIVERED" : "PENDING" }));
        const created = await store.createMessage(tx, mailbox, {
          direction: "OUTBOUND",
          status: externalRecipients.length ? "QUEUED" : "DELIVERED",
          rfcMessageId,
          inReplyTo,
          references,
          threadId: draft.mode === "FORWARD" ? null : draft.threadId,
          subject,
          from: fromParty,
          replyTo,
          recipients,
          text: body.text,
          body,
          senderAddressId: identity.addressId,
          sentByAdminUserId: user.id,
          hasAttachments: attachments.length > 0,
          sizeBytes,
          idempotencyKey: messageKey,
          sentAt: externalRecipients.length ? null : now,
          at: now,
      });
      await tx.mailAttachment.updateMany({ where: { draftId }, data: { messageId: created.message.id, draftId: null } });
      await tx.mailDraft.update({ where: { id: draftId }, data: { status: "SENT", sentMessageId: created.message.id, encryptedBody: null } });
      // Sender's own thread is read for the sender.
      await tx.mailUserThreadState.upsert({ where: { threadId_adminUserId: { threadId: created.thread.id, adminUserId: user.id } }, create: { threadId: created.thread.id, adminUserId: user.id, isRead: true, lastReadAt: now }, update: { isRead: true, lastReadAt: now } });
      const thread = created.thread;
      if (thread.conversationStatus) {
        await tx.mailThread.update({ where: { id: thread.id }, data: { firstResponseAt: thread.firstResponseAt || now, conversationStatus: thread.conversationStatus === "OPEN" ? "PENDING" : undefined, lockedByAdminUserId: null, lockExpiresAt: null } });
      }
      // Internal delivery (each local mailbox gets its own copy; BCC rows are
      // never copied into recipients' mailboxes).
      // Copies list header participants only; delivery is tracked on the
      // sender's OUTBOUND message, so these rows never claim delivery.
      const visibleRecipients = recipients.filter((recipient) => recipient.type !== "BCC").map((recipient) => ({ ...recipient, status: "INTERNAL_DELIVERED" }));
      const delivered = new Set([mailbox.id]);
      const internalTargets = [];
      let selfAddressed = false;
      for (const party of all) {
        const target = internalByAddress.get(party.address);
        if (target && target.mailboxId === mailbox.id) selfAddressed = true;
        if (!target || delivered.has(target.mailboxId)) continue;
        delivered.add(target.mailboxId);
        const copy = await store.createMessage(tx, target.mailbox, {
          direction: "INTERNAL",
          status: "RECEIVED",
          rfcMessageId,
          inReplyTo,
          references,
          subject,
          from: fromParty,
          replyTo,
          recipients: visibleRecipients,
          envelopeRecipient: target.address,
          text: body.text,
          body,
          hasAttachments: attachments.length > 0,
          sizeBytes,
          receivedAt: now,
          at: now,
        });
        if (copy.duplicate) continue;
        for (const attachment of attachments) {
          await tx.mailAttachment.create({ data: { mailboxId: target.mailboxId, messageId: copy.message.id, filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, storageKey: attachment.storageKey, isInline: attachment.isInline, contentId: attachment.contentId, scanStatus: attachment.scanStatus, scanDetail: attachment.scanDetail, quarantined: attachment.quarantined } });
        }
        internalTargets.push(target.mailbox);
      }
      if (selfAddressed) {
        // Mail to one's own address/alias also lands in the inbox (one copy).
        await tx.mailThread.update({ where: { id: created.thread.id }, data: { hasInbound: true, lastInboundAt: now } });
      }
      let job = null;
      if (externalRecipients.length) {
        ({ job } = await jobs.enqueue(tx, { queue: "OUTBOUND", kind: "SEND_MESSAGE", idempotencyKey: sendKey, messageId: created.message.id, maxAttempts: config.worker.maxAttempts }));
      }
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_MESSAGE_QUEUED", targetType: "message", targetId: created.message.id, mailboxId: mailbox.id, metadata: { external: externalRecipients.length, internal: internalTargets.length, senderAddressId: identity.addressId, jobId: job?.id || null } }, context, tx);
      return { message: created.message, thread: created.thread, job, internalTargets };
      });
    } catch (error) {
      // Lost a race with a same-key request: return the winner's message.
      if (messageKey && (error?.code === "MAIL_DRAFT_REVISION_CONFLICT" || error?.code === "P2002")) {
        const replay = await findReplay(messageKey, draftId);
        if (replay) return replay;
      }
      throw error;
    }

    for (const target of result.internalTargets) {
      const members = await notifications.mailboxMemberIds(target.id);
      await notifications.notifyUsers(members.filter((id) => id !== user.id), { icon: "bell", kind: "NEW_MAIL", title: `New email in ${target.name}`, subtitle: `From ${fromParty.name || fromParty.address}` });
    }
    return { messageId: result.message.id, threadId: result.thread.id, jobId: result.job?.id || null, status: result.message.status };
  }

  // Spec 11.6 (re-audit 7a): why queued mail is still waiting. Only the
  // provider quota wait is reported (never provider error text).
  function outboundStatusDetail(job) {
    if (!job || job.status !== "RETRY_SCHEDULED" || job.lastErrorCode !== "PROVIDER_QUOTA_EXHAUSTED") return null;
    const wait = job.payload?.quotaWait || null;
    const until = wait?.resetAt || iso(job.nextAttemptAt);
    return { code: "PROVIDER_QUOTA_WAIT", quotaKind: wait?.kind || null, until, nextAttemptAt: iso(job.nextAttemptAt), message: `Waiting for provider quota reset (until ${until})` };
  }

  async function messageStatus(user, messageId) {
    if (!policy.isUuid(messageId)) throw mailError("MAIL_NOT_FOUND", { resource: "message" });
    const message = await client.mailMessage.findUnique({ where: { id: messageId }, include: { recipients: true, deliveryEvents: { orderBy: { occurredAt: "asc" } }, outboxJobs: { where: { queue: "OUTBOUND" }, orderBy: { createdAt: "desc" }, take: 1, select: { status: true, lastErrorCode: true, nextAttemptAt: true, payload: true } } } });
    if (!message) throw mailError("MAIL_NOT_FOUND", { resource: "message" });
    try {
      await policy.requireMailboxAccess(client, user, message.mailboxId, "READ");
    } catch (error) {
      if (error.code === "MAIL_NOT_FOUND") throw mailError("MAIL_NOT_FOUND", { resource: "message" });
      throw error;
    }
    return {
      messageId: message.id,
      status: message.status,
      statusDetail: message.direction === "OUTBOUND" ? outboundStatusDetail(message.outboxJobs?.[0]) : null,
      recipients: message.recipients.filter((recipient) => message.direction === "OUTBOUND" || recipient.type !== "BCC").map((recipient) => ({ type: recipient.type, address: recipient.address, name: recipient.name, status: recipient.status })),
      deliveryEvents: message.deliveryEvents.map((event) => ({ type: event.eventType, recipient: event.recipient, occurredAt: iso(event.occurredAt) })),
    };
  }

  async function downloadAttachment(user, attachmentId, context = {}) {
    policy.assertActiveIdentity(user);
    if (!policy.isUuid(attachmentId)) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    const attachment = await client.mailAttachment.findUnique({ where: { id: attachmentId }, include: { draft: true } });
    if (!attachment || (!attachment.messageId && !attachment.draftId)) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    if (attachment.draftId && attachment.draft?.authorAdminUserId !== user.id) throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
    let access;
    try {
      access = await policy.requireMailboxAccess(client, user, attachment.mailboxId, "READ");
    } catch (error) {
      if (error.code === "MAIL_NOT_FOUND") throw mailError("MAIL_NOT_FOUND", { resource: "attachment" });
      throw error;
    }
    if (attachment.quarantined || attachment.scanStatus !== "CLEAN" || !attachment.storageKey) throw mailError("MAIL_ATTACHMENT_QUARANTINED", { scanStatus: attachment.scanStatus });
    const content = await store.readAttachmentContent(attachment);
    await audit.record({ actorAdminUserId: user.id, action: access.viaBreakGlass ? "MAIL_BREAK_GLASS_ATTACHMENT_DOWNLOAD" : "MAIL_ATTACHMENT_DOWNLOADED", targetType: "attachment", targetId: attachment.id, mailboxId: attachment.mailboxId }, context);
    return { attachment, content };
  }

  return { createDraft, listDrafts, getDraft, updateDraft, discardDraft, addAttachment, removeAttachment, sendDraft, messageStatus, downloadAttachment };
}

module.exports = { createComposeService, assertContentPolicy, DRAFT_PURPOSE };

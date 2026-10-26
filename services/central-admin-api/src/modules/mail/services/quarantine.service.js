"use strict";

// Gap 6: IT quarantine management (IT > Mail Administration > Quarantine).
//
// Who: mail administrators with an EXPLICIT mail "admin" section grant
// (no tier bypass: SUPER without the grant is refused, because quarantine
// shows sender metadata of mail the administrator has no mailbox access to).
// VIEW lists and reads details; EDIT is needed for actions. Release needs a
// fresh MFA step-up MAIL_QUARANTINE_RELEASE, reject/delete MAIL_QUARANTINE_DELETE,
// and every release/reject/delete needs a reason. Rescan needs EDIT only.
//
// What is shown: SAFE METADATA ONLY - ids, mailbox name, organization,
// received time, size, sender DOMAIN plus a masked local part and a hash
// prefix (never the full address), quarantine reason code and category,
// attachment filename/type/size and scan status/detail, and the decision
// history. Never subjects, bodies, previews, headers or downloads; acting on
// quarantine never grants the administrator mailbox access. Files of private
// drafts (outbound, not yet sent) show only their extension and size, never
// the filename the author chose.
//
// Decision reasons are operator free text (5-500 chars, control characters
// stripped) stored in the append-only decision log. They are shown to mail
// administrators only and MUST NOT contain message content (subjects, bodies,
// file contents); the UI says so. Retention purges of a message remove its
// decision rows (inside the purge transaction).
//
// Categories: MALWARE (scanner detection), AUTH_POLICY (spoofed own domain /
// failed sender authentication), SPAM (provider verdict), POLICY (POLICY_*
// type/size refusals, malformed content, other policy holds), SCAN_FAILURE
// (scanner unavailable, scan failed, still pending).
//
// Actions (each appends a mail_quarantine_decisions row - append-only,
// UPDATE/DELETE refused by trigger - and an audit event):
//   rescan attachment   reuses attachment-review (RESCAN_REQUESTED); it only
//                       records the new verdict and NEVER releases: a clean
//                       file stays quarantined until an explicit release;
//   release attachment  only when its latest scan is CLEAN; INFECTED never,
//                       POLICY_* blocked types never (no override exists);
//   release message     only when the reason is not MALWARE and every stored
//                       attachment is CLEAN; the message returns to the
//                       ORIGINAL mailbox (status RECEIVED, SPAM -> INBOX) for
//                       its existing members only;
//   reject / delete     tombstone (per retention rules) and enqueue the
//                       objects in the durable deletion queue (gap 5) in the
//                       same transaction; refused while a legal hold applies.
// Before migration 37 the list and details work read-only (no decision
// history) and every action answers 503 MAIL_FEATURE_NOT_READY.

const crypto = require("crypto");
const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const MESSAGE_CATEGORY = {
  MALICIOUS_ATTACHMENT: "MALWARE",
  INTERNAL_DOMAIN_SPOOF: "AUTH_POLICY",
  SENDER_AUTHENTICATION_FAILED: "AUTH_POLICY",
  PROVIDER_SPAM_VERDICT: "SPAM",
};
const CATEGORIES = ["MALWARE", "AUTH_POLICY", "SPAM", "POLICY", "SCAN_FAILURE"];
const SCAN_STATUSES = ["PENDING", "CLEAN", "INFECTED", "SCAN_FAILED", "SCANNER_UNAVAILABLE"];
const POLICY_DETAIL = [{ scanDetail: { startsWith: "POLICY_" } }, { scanDetail: { contains: "MALFORMED", mode: "insensitive" } }];

function messageCategory(reason) {
  return MESSAGE_CATEGORY[reason] || "POLICY";
}

function isPolicyDetail(detail) {
  return /^POLICY_|MALFORMED/i.test(String(detail || ""));
}

function attachmentCategory(attachment) {
  if (attachment.scanStatus === "INFECTED") return "MALWARE";
  if (attachment.scanStatus === "SCAN_FAILED" && isPolicyDetail(attachment.scanDetail)) return "POLICY";
  if (["SCAN_FAILED", "SCANNER_UNAVAILABLE", "PENDING"].includes(attachment.scanStatus)) return "SCAN_FAILURE";
  return "POLICY"; // CLEAN but still held
}

// Sender domain + masked local part + hash prefix; never the full address.
function maskSender(address) {
  const value = String(address || "").toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return { domain: null, masked: null, hash: null };
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return { domain, masked: `${local[0]}***@${domain}`, hash: crypto.createHash("sha256").update(value).digest("hex").slice(0, 12) };
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

function createQuarantineService({ client, audit, stepUp, feature = null, archiveFeature = null, deletions, attachmentReview, notifications = null, clock = () => new Date(), logger = null }) {
  async function ready() {
    if (!feature) return false;
    return feature.isReady().catch(() => false);
  }

  async function requireAdmin(user, mode) {
    await policy.requireExplicitMailSection(client, user, "admin", mode);
  }

  async function requireActionsReady() {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "quarantine_actions" });
  }

  function cleanReason(reason, { required = true } = {}) {
    const value = String(reason || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!value && !required) return null;
    if (value.length < 5 || value.length > 500) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason", reason: "REASON_REQUIRED" });
    return value;
  }

  // ---- queries ----
  function dateRange(query) {
    const range = {};
    for (const [key, op] of [["from", "gte"], ["to", "lte"]]) {
      if (!query[key]) continue;
      const date = new Date(String(query[key]));
      if (Number.isNaN(date.getTime())) throw mailError("MAIL_VALIDATION_FAILED", { field: key });
      range[op] = date;
    }
    return Object.keys(range).length ? { createdAt: range } : {};
  }

  function scopeFilters(query) {
    const and = [];
    if (query.mailboxId) {
      if (!policy.isUuid(query.mailboxId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "mailboxId" });
      and.push({ mailboxId: query.mailboxId });
    }
    if (query.organizationId) {
      if (!policy.isUuid(query.organizationId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
      and.push({ mailbox: { organizationId: query.organizationId } });
    }
    const range = dateRange(query);
    if (range.createdAt) and.push(range);
    return and;
  }

  function messageWhere(query) {
    const and = [{ status: "QUARANTINED", deletedAt: null }, ...scopeFilters(query)];
    const category = query.category ? String(query.category).toUpperCase() : null;
    if (category && !CATEGORIES.includes(category)) throw mailError("MAIL_VALIDATION_FAILED", { field: "category" });
    const known = Object.keys(MESSAGE_CATEGORY);
    if (category === "POLICY") and.push({ OR: [{ quarantineReason: null }, { quarantineReason: { notIn: known } }] });
    else if (category === "SCAN_FAILURE") and.push({ attachments: { some: { storageKey: { not: null }, scanStatus: { in: ["SCAN_FAILED", "SCANNER_UNAVAILABLE", "PENDING"] } } } });
    else if (category) and.push({ quarantineReason: { in: known.filter((reason) => MESSAGE_CATEGORY[reason] === category) } });
    const source = query.source ? String(query.source).toUpperCase() : null;
    if (source === "OUTBOUND") and.push({ direction: "OUTBOUND" });
    else if (source === "INBOUND") and.push({ direction: { in: ["INBOUND", "INTERNAL"] } });
    else if (source) throw mailError("MAIL_VALIDATION_FAILED", { field: "source" });
    return { AND: and };
  }

  function attachmentWhere(query) {
    const and = [
      { storageKey: { not: null } },
      { OR: [{ quarantined: true }, { scanStatus: { not: "CLEAN" } }] },
      { OR: [{ message: { deletedAt: null } }, { draft: { status: "ACTIVE" } }] },
      ...scopeFilters(query),
    ];
    const category = query.category ? String(query.category).toUpperCase() : null;
    if (category && !CATEGORIES.includes(category)) throw mailError("MAIL_VALIDATION_FAILED", { field: "category" });
    if (category === "MALWARE") and.push({ scanStatus: "INFECTED" });
    else if (category === "POLICY") and.push({ OR: [{ scanStatus: "SCAN_FAILED", OR: POLICY_DETAIL }, { scanStatus: "CLEAN" }] });
    else if (category === "SCAN_FAILURE") and.push({ OR: [{ scanStatus: { in: ["SCANNER_UNAVAILABLE", "PENDING"] } }, { scanStatus: "SCAN_FAILED", OR: [{ scanDetail: null }, { NOT: { OR: POLICY_DETAIL } }] }] });
    else if (category) and.push({ id: { in: [] } }); // AUTH_POLICY / SPAM are message-level only
    const status = query.status ? String(query.status).toUpperCase() : null;
    if (status) {
      if (!SCAN_STATUSES.includes(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
      and.push({ scanStatus: status });
    }
    const source = query.source ? String(query.source).toUpperCase() : null;
    if (source === "INBOUND") and.push({ messageId: { not: null } });
    else if (source === "OUTBOUND") and.push({ draftId: { not: null } });
    else if (source) throw mailError("MAIL_VALIDATION_FAILED", { field: "source" });
    return { AND: and };
  }

  const mailboxSelect = { select: { id: true, name: true, organization: { select: { id: true, name: true } } } };
  const attachmentSelect = { id: true, mailboxId: true, messageId: true, draftId: true, filename: true, contentType: true, sizeBytes: true, storageKey: true, scanStatus: true, scanDetail: true, quarantined: true, createdAt: true };

  // ---- release / delete rules (pure) ----
  function messageReleaseBlockers(message, attachments) {
    const blockers = [];
    if (message.status !== "QUARANTINED" || message.deletedAt) blockers.push("NOT_QUARANTINED");
    if (messageCategory(message.quarantineReason) === "MALWARE") blockers.push("MALWARE_NEVER_RELEASABLE");
    const stored = attachments.filter((attachment) => attachment.storageKey);
    if (stored.some((attachment) => attachment.scanStatus === "INFECTED")) blockers.push("INFECTED_ATTACHMENT");
    if (stored.some((attachment) => attachment.scanStatus !== "CLEAN")) blockers.push("ATTACHMENT_NOT_CLEAN");
    return blockers;
  }

  function attachmentReleaseBlockers(attachment) {
    if (!attachment.storageKey) return ["REMOVED"];
    if (attachment.scanStatus === "INFECTED") return ["INFECTED_NEVER_RELEASABLE"];
    if (attachment.scanStatus === "SCAN_FAILED" && isPolicyDetail(attachment.scanDetail)) return ["POLICY_BLOCKED"];
    if (attachment.scanStatus !== "CLEAN") return ["CLEAN_SCAN_REQUIRED"];
    if (!attachment.quarantined) return ["NOT_QUARANTINED"];
    return [];
  }

  // ---- serialization (metadata only) ----
  // Private draft files: extension only (e.g. "*.pdf"), never the name.
  function maskedFilename(attachment) {
    if (attachment.messageId) return attachment.filename;
    const match = /\.([A-Za-z0-9]{1,10})$/.exec(String(attachment.filename || ""));
    return match ? `*.${match[1].toLowerCase()}` : "(draft file)";
  }

  function serializeAttachment(attachment, actionsReady) {
    const blockers = attachmentReleaseBlockers(attachment);
    return {
      id: attachment.id,
      kind: "ATTACHMENT",
      source: attachment.messageId ? "INBOUND" : "OUTBOUND_DRAFT",
      messageId: attachment.messageId,
      draftId: attachment.draftId,
      mailboxId: attachment.mailboxId,
      createdAt: iso(attachment.createdAt),
      filename: maskedFilename(attachment),
      filenameMasked: !attachment.messageId,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      scanStatus: attachment.scanStatus,
      scanDetail: attachment.scanDetail,
      quarantined: attachment.quarantined,
      removed: !attachment.storageKey,
      reasonCategory: attachmentCategory(attachment),
      actions: {
        available: actionsReady,
        canRescan: actionsReady && Boolean(attachment.storageKey) && ["PENDING", "SCAN_FAILED", "SCANNER_UNAVAILABLE"].includes(attachment.scanStatus),
        canRelease: actionsReady && !blockers.length,
        releaseBlockers: blockers,
        canDelete: actionsReady && Boolean(attachment.storageKey),
      },
    };
  }

  function serializeMessage(message, actionsReady) {
    const attachments = (message.attachments || []).filter((attachment) => attachment.storageKey || attachment.filename !== "removed");
    const blockers = messageReleaseBlockers(message, message.attachments || []);
    const authVerdict = message.authResults && typeof message.authResults === "object" && typeof message.authResults.verdict === "string" ? message.authResults.verdict : null;
    return {
      id: message.id,
      kind: "MESSAGE",
      source: message.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
      status: message.status,
      mailbox: { id: message.mailbox.id, name: message.mailbox.name },
      organization: message.mailbox.organization,
      receivedAt: iso(message.receivedAt || message.createdAt),
      sizeBytes: message.sizeBytes,
      sender: maskSender(message.fromAddress),
      reason: message.quarantineReason,
      reasonCategory: messageCategory(message.quarantineReason),
      authVerdict,
      attachmentCount: attachments.length,
      attachments: attachments.map((attachment) => ({ id: attachment.id, filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes, scanStatus: attachment.scanStatus, scanDetail: attachment.scanDetail, reasonCategory: attachmentCategory(attachment), removed: !attachment.storageKey })),
      actions: {
        available: actionsReady,
        canRelease: actionsReady && !blockers.length,
        releaseBlockers: blockers,
        releaseNeedsStepUp: true,
        canDelete: actionsReady && message.status === "QUARANTINED" && !message.deletedAt,
      },
    };
  }

  async function decisionsFor(where) {
    if (!(await ready())) return [];
    const rows = await client.mailQuarantineDecision.findMany({ where, orderBy: { createdAt: "asc" }, take: 200 });
    return rows.map((row) => ({ id: row.id, targetType: row.targetType, messageId: row.messageId, attachmentId: row.attachmentId, decision: row.decision, reason: row.reason, scanEvidence: row.scanEvidence ?? null, decidedBy: row.decidedBy, createdAt: iso(row.createdAt) }));
  }

  // ---- list / detail ----
  async function list(user, query = {}) {
    await requireAdmin(user, "VIEW");
    const kind = String(query.kind || "messages").toLowerCase();
    if (!["messages", "attachments"].includes(kind)) throw mailError("MAIL_VALIDATION_FAILED", { field: "kind" });
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 25));
    const cursor = query.cursor ? String(query.cursor) : null;
    if (cursor && !policy.isUuid(cursor)) throw mailError("MAIL_VALIDATION_FAILED", { field: "cursor" });
    const actionsReady = await ready();
    const page = { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) };
    if (kind === "messages") {
      const rows = await client.mailMessage.findMany({
        where: messageWhere(query),
        ...page,
        select: { id: true, mailboxId: true, threadId: true, direction: true, status: true, fromAddress: true, sizeBytes: true, quarantineReason: true, authResults: true, receivedAt: true, createdAt: true, deletedAt: true, mailbox: mailboxSelect, attachments: { select: attachmentSelect } },
      });
      return { items: rows.slice(0, limit).map((row) => serializeMessage(row, actionsReady)), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
    }
    const rows = await client.mailAttachment.findMany({ where: attachmentWhere(query), ...page, select: { ...attachmentSelect, mailbox: mailboxSelect, message: { select: { fromAddress: true, receivedAt: true } } } });
    return {
      items: rows.slice(0, limit).map((row) => ({ ...serializeAttachment(row, actionsReady), mailbox: { id: row.mailbox.id, name: row.mailbox.name }, organization: row.mailbox.organization, sender: row.message ? maskSender(row.message.fromAddress) : null })),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async function loadMessage(messageId) {
    if (!policy.isUuid(messageId)) throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_message" });
    const message = await client.mailMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxId: true, threadId: true, direction: true, status: true, fromAddress: true, sentByAdminUserId: true, sizeBytes: true, quarantineReason: true, authResults: true, receivedAt: true, createdAt: true, deletedAt: true, contentObjectKey: true, rawMimeObjectKey: true, mailbox: { select: { id: true, name: true, organizationId: true, ownerAdminUserId: true, organization: { select: { id: true, name: true } } } }, attachments: { select: attachmentSelect } },
    });
    if (!message) throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_message" });
    // Only mail that is (or was, per the decision log) quarantined is visible here.
    if (message.status !== "QUARANTINED" && !(await ready() && (await client.mailQuarantineDecision.count({ where: { messageId } })) > 0)) {
      throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_message" });
    }
    return message;
  }

  async function loadAttachment(attachmentId) {
    if (!policy.isUuid(attachmentId)) throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_attachment" });
    const attachment = await client.mailAttachment.findUnique({ where: { id: attachmentId }, select: { ...attachmentSelect, mailbox: { select: { id: true, name: true, organizationId: true, organization: { select: { id: true, name: true } } } }, message: { select: { id: true, threadId: true, status: true, deletedAt: true, fromAddress: true, sentByAdminUserId: true } }, draft: { select: { status: true, authorAdminUserId: true } } } });
    if (!attachment) throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_attachment" });
    const held = attachment.quarantined || attachment.scanStatus !== "CLEAN";
    if (!held && !(await ready() && (await client.mailQuarantineDecision.count({ where: { attachmentId } })) > 0)) {
      throw mailError("MAIL_NOT_FOUND", { resource: "quarantined_attachment" });
    }
    return attachment;
  }

  async function messageDetail(user, messageId) {
    await requireAdmin(user, "VIEW");
    const message = await loadMessage(messageId);
    const ids = message.attachments.map((attachment) => attachment.id);
    const decisions = await decisionsFor({ OR: [{ messageId: message.id }, ...(ids.length ? [{ attachmentId: { in: ids } }] : [])] });
    return { ...serializeMessage(message, await ready()), decisions };
  }

  async function attachmentDetail(user, attachmentId) {
    await requireAdmin(user, "VIEW");
    const attachment = await loadAttachment(attachmentId);
    return {
      ...serializeAttachment(attachment, await ready()),
      mailbox: { id: attachment.mailbox.id, name: attachment.mailbox.name },
      organization: attachment.mailbox.organization,
      sender: attachment.message ? maskSender(attachment.message.fromAddress) : null,
      decisions: await decisionsFor({ attachmentId: attachment.id }),
    };
  }

  // ---- holds ----
  async function threadSenders(threadId) {
    if (!threadId) return [];
    const rows = await client.mailMessage.findMany({ where: { threadId, sentByAdminUserId: { not: null } }, select: { sentByAdminUserId: true }, distinct: ["sentByAdminUserId"] });
    return rows.map((row) => row.sentByAdminUserId);
  }

  async function assertNotHeld(user, { organizationId, mailboxId, adminUserIds, target }, context) {
    if (await deletions.scopeHeld({ organizationId, mailboxId, adminUserIds })) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUARANTINE_DELETE_REFUSED", targetType: target.type, targetId: target.id, mailboxId, organizationId, outcome: "DENIED", metadata: { reason: "LEGAL_HOLD" } }, context);
      throw mailError("MAIL_LEGAL_HOLD", { reason: "LEGAL_HOLD" });
    }
  }

  async function record(tx, data) {
    return tx.mailQuarantineDecision.create({ data: { ...data, createdAt: clock() } });
  }

  // ---- actions ----
  async function rescanAttachment(user, attachmentId, { reason } = {}, context = {}) {
    await requireAdmin(user, "EDIT");
    await requireActionsReady();
    const why = cleanReason(reason, { required: false }) || "Rescan requested from IT quarantine";
    const attachment = await loadAttachment(attachmentId);
    const result = await attachmentReview.rescanAttachment(user, attachment.id, context);
    await record(client, { mailboxId: attachment.mailboxId, targetType: "ATTACHMENT", attachmentId: attachment.id, messageId: attachment.messageId, decision: "RESCAN_REQUESTED", reason: why, decidedBy: user.id, scanEvidence: { from: result.previousScanStatus ?? attachment.scanStatus, to: result.scanStatus, detail: result.scanDetail ?? null, scanner: result.scanner ?? null, at: clock().toISOString() } });
    return attachmentDetail(user, attachment.id);
  }

  async function releaseAttachment(user, attachmentId, { stepUpId, reason } = {}, context = {}) {
    await requireAdmin(user, "EDIT");
    await requireActionsReady();
    const why = cleanReason(reason);
    const attachment = await loadAttachment(attachmentId);
    const blockers = attachmentReleaseBlockers(attachment);
    if (blockers.length) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUARANTINE_RELEASE_REFUSED", targetType: "attachment", targetId: attachment.id, mailboxId: attachment.mailboxId, outcome: "DENIED", metadata: { blockers, scanStatus: attachment.scanStatus } }, context);
      throw mailError(blockers[0] === "NOT_QUARANTINED" || blockers[0] === "REMOVED" ? "MAIL_INVALID_TRANSITION" : "MAIL_ATTACHMENT_QUARANTINED", { reason: blockers[0], blockers, status: 409 });
    }
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_QUARANTINE_RELEASE", context);
      // Guard: the clean verdict must still be current.
      const changed = await tx.mailAttachment.updateMany({ where: { id: attachment.id, scanStatus: "CLEAN", quarantined: true, storageKey: { not: null } }, data: { quarantined: false } });
      if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { resource: "attachment" });
      await record(tx, { mailboxId: attachment.mailboxId, targetType: "ATTACHMENT", attachmentId: attachment.id, messageId: attachment.messageId, decision: "RELEASED", reason: why, decidedBy: user.id, scanEvidence: { scanStatus: attachment.scanStatus, detail: attachment.scanDetail } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUARANTINE_ATTACHMENT_RELEASED", targetType: "attachment", targetId: attachment.id, mailboxId: attachment.mailboxId, organizationId: attachment.mailbox.organizationId, metadata: { scanStatus: attachment.scanStatus, reason: why } }, context, tx);
    });
    return attachmentDetail(user, attachment.id);
  }

  async function releaseMessage(user, messageId, { stepUpId, reason } = {}, context = {}) {
    await requireAdmin(user, "EDIT");
    await requireActionsReady();
    const why = cleanReason(reason);
    const message = await loadMessage(messageId);
    const blockers = messageReleaseBlockers(message, message.attachments);
    const category = messageCategory(message.quarantineReason);
    if (blockers.length) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUARANTINE_RELEASE_REFUSED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, organizationId: message.mailbox.organizationId, outcome: "DENIED", metadata: { blockers, category } }, context);
      throw mailError(blockers[0] === "NOT_QUARANTINED" ? "MAIL_INVALID_TRANSITION" : "MAIL_ATTACHMENT_QUARANTINED", { reason: blockers[0], blockers, status: 409 });
    }
    const at = clock();
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_QUARANTINE_RELEASE", context);
      const changed = await tx.mailMessage.updateMany({ where: { id: message.id, status: "QUARANTINED", deletedAt: null }, data: { status: "RECEIVED", lastStatusAt: at } });
      if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { resource: "message" });
      // Re-check under the transaction: no attachment may have changed state.
      const unsafe = await tx.mailAttachment.count({ where: { messageId: message.id, storageKey: { not: null }, scanStatus: { not: "CLEAN" } } });
      if (unsafe) throw mailError("MAIL_ATTACHMENT_QUARANTINED", { reason: "ATTACHMENT_NOT_CLEAN", status: 409 });
      await tx.mailAttachment.updateMany({ where: { messageId: message.id, storageKey: { not: null }, scanStatus: "CLEAN" }, data: { quarantined: false } });
      const thread = await tx.mailThread.findUnique({ where: { id: message.threadId }, select: { id: true, folder: true } });
      // Back to the ORIGINAL mailbox for its existing members; no access is granted to anyone.
      await tx.mailThread.update({ where: { id: thread.id }, data: { ...(thread.folder === "SPAM" ? { folder: "INBOX" } : {}), revision: { increment: 1 } } });
      await tx.mailUserThreadState.updateMany({ where: { threadId: thread.id }, data: { isRead: false } });
      await record(tx, { mailboxId: message.mailboxId, targetType: "MESSAGE", messageId: message.id, decision: "RELEASED", reason: why, decidedBy: user.id, scanEvidence: { quarantineReason: message.quarantineReason, category, attachments: message.attachments.filter((attachment) => attachment.storageKey).map((attachment) => ({ id: attachment.id, scanStatus: attachment.scanStatus })) } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_QUARANTINE_MESSAGE_RELEASED", targetType: "message", targetId: message.id, mailboxId: message.mailboxId, organizationId: message.mailbox.organizationId, metadata: { category, quarantineReason: message.quarantineReason, reason: why } }, context, tx);
    });
    if (notifications) {
      const members = await notifications.mailboxMemberIds(message.mailboxId).catch(() => []);
      await notifications.notifyUsers(members, { icon: "bell", kind: "NEW_MAIL", title: `Released email in ${message.mailbox.name}`, subtitle: "IT released a message from quarantine." }).catch((error) => logger?.warn?.(`[MailQuarantine] notify failed (${error?.code || "error"})`));
    }
    return messageDetail(user, message.id);
  }

  // Message tombstone (same scrub as a retention purge, one message).
  async function purgeMessage(tx, message) {
    let archiveKeys = [];
    if (archiveFeature && (await archiveFeature.isReady().catch(() => false))) {
      const archive = await tx.mailMessageArchive.findUnique({ where: { messageId: message.id }, select: { headersObjectKey: true, rawMimeObjectKey: true } });
      if (archive) archiveKeys = [archive.headersObjectKey, archive.rawMimeObjectKey];
      await tx.mailMessageArchive.deleteMany({ where: { messageId: message.id } });
      await tx.mailMessageSearchIndex.deleteMany({ where: { messageId: message.id } });
    }
    // Provider-assigned Message-ID aliases go with the content (migration 37;
    // this path only runs when the quarantine actions are available).
    if (await ready()) await tx.mailMessageProviderId.deleteMany({ where: { messageId: message.id } });
    const attachments = await tx.mailAttachment.findMany({ where: { messageId: message.id }, select: { storageKey: true } });
    await deletions.dropAttachments(tx, { messageId: message.id });
    await tx.mailDeliveryEvent.deleteMany({ where: { messageId: message.id } });
    await tx.mailMessageRecipient.deleteMany({ where: { messageId: message.id } });
    const at = clock();
    await tx.mailMessage.update({ where: { id: message.id }, data: { subject: "", encryptedSnippet: null, fromAddress: "", fromName: null, replyTo: null, envelopeRecipient: null, metadataSearchText: "", contentObjectKey: null, rawMimeObjectKey: null, authResults: null, references: [], inReplyTo: null, hasAttachments: false, deletedAt: at } });
    const remaining = await tx.mailMessage.count({ where: { threadId: message.threadId, deletedAt: null } });
    if (!remaining) {
      await tx.mailThread.update({ where: { id: message.threadId }, data: { subject: "", normalizedSubject: "", encryptedSnippet: null, participants: null, rootRfcMessageId: null, deletedAt: at, revision: { increment: 1 } } });
    } else {
      await tx.mailThread.update({ where: { id: message.threadId }, data: { encryptedSnippet: null, revision: { increment: 1 } } });
    }
    return [message.contentObjectKey, message.rawMimeObjectKey, ...attachments.map((attachment) => attachment.storageKey), ...archiveKeys].filter(Boolean);
  }

  const DECISIONS = { reject: "REJECTED", delete: "DELETED" };

  async function removeMessage(user, messageId, action, { stepUpId, reason } = {}, context = {}) {
    await requireAdmin(user, "EDIT");
    await requireActionsReady();
    const decision = DECISIONS[action];
    const why = cleanReason(reason);
    const message = await loadMessage(messageId);
    if (message.status !== "QUARANTINED" || message.deletedAt) throw mailError("MAIL_INVALID_TRANSITION", { reason: "NOT_QUARANTINED" });
    await assertNotHeld(user, { organizationId: message.mailbox.organizationId, mailboxId: message.mailboxId, adminUserIds: await threadSenders(message.threadId), target: { type: "message", id: message.id } }, context);
    const category = messageCategory(message.quarantineReason);
    const plan = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_QUARANTINE_DELETE", context);
      const current = await tx.mailMessage.findUnique({ where: { id: message.id }, select: { status: true, deletedAt: true } });
      if (current.status !== "QUARANTINED" || current.deletedAt) throw mailError("MAIL_INVALID_TRANSITION", { reason: "NOT_QUARANTINED" });
      await record(tx, { mailboxId: message.mailboxId, targetType: "MESSAGE", messageId: message.id, decision, reason: why, decidedBy: user.id, scanEvidence: { quarantineReason: message.quarantineReason, category, attachments: message.attachments.filter((attachment) => attachment.storageKey).map((attachment) => ({ id: attachment.id, scanStatus: attachment.scanStatus })) } });
      const keys = await purgeMessage(tx, message);
      const queued = await deletions.enqueue(tx, keys, { purpose: "QUARANTINE", reason: `QUARANTINE_${decision}`, sourceType: "message", sourceId: message.id, organizationId: message.mailbox.organizationId, mailboxId: message.mailboxId, requestedBy: user.id });
      await audit.record({ actorAdminUserId: user.id, action: `MAIL_QUARANTINE_MESSAGE_${decision}`, targetType: "message", targetId: message.id, mailboxId: message.mailboxId, organizationId: message.mailbox.organizationId, metadata: { category, quarantineReason: message.quarantineReason, objectsQueued: queued.keys.length, reason: why } }, context, tx);
      return queued;
    });
    const objects = await deletions.settle(plan);
    return { id: message.id, decision, objects: { removed: objects.removed, pending: objects.failed, shared: objects.shared } };
  }

  async function removeAttachment(user, attachmentId, action, { stepUpId, reason } = {}, context = {}) {
    await requireAdmin(user, "EDIT");
    await requireActionsReady();
    const decision = DECISIONS[action];
    const why = cleanReason(reason);
    const attachment = await loadAttachment(attachmentId);
    if (!attachment.storageKey) throw mailError("MAIL_INVALID_TRANSITION", { reason: "REMOVED" });
    const people = [attachment.draft?.authorAdminUserId, attachment.message?.sentByAdminUserId, ...(await threadSenders(attachment.message?.threadId))];
    await assertNotHeld(user, { organizationId: attachment.mailbox.organizationId, mailboxId: attachment.mailboxId, adminUserIds: people, target: { type: "attachment", id: attachment.id } }, context);
    const plan = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_QUARANTINE_DELETE", context);
      await record(tx, { mailboxId: attachment.mailboxId, targetType: "ATTACHMENT", attachmentId: attachment.id, messageId: attachment.messageId, decision, reason: why, decidedBy: user.id, scanEvidence: { scanStatus: attachment.scanStatus, detail: attachment.scanDetail, category: attachmentCategory(attachment) } });
      // The row stays (the decision references it) as a tombstone without its object.
      const changed = await tx.mailAttachment.updateMany({ where: { id: attachment.id, storageKey: attachment.storageKey }, data: { storageKey: null, quarantined: true, contentId: null, providerAttachmentId: null } });
      if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { resource: "attachment" });
      const queued = await deletions.enqueue(tx, [attachment.storageKey], { purpose: "QUARANTINE", reason: `QUARANTINE_${decision}`, sourceType: "attachment", sourceId: attachment.id, organizationId: attachment.mailbox.organizationId, mailboxId: attachment.mailboxId, requestedBy: user.id });
      await audit.record({ actorAdminUserId: user.id, action: `MAIL_QUARANTINE_ATTACHMENT_${decision}`, targetType: "attachment", targetId: attachment.id, mailboxId: attachment.mailboxId, organizationId: attachment.mailbox.organizationId, metadata: { scanStatus: attachment.scanStatus, category: attachmentCategory(attachment), reason: why } }, context, tx);
      return queued;
    });
    const objects = await deletions.settle(plan);
    return { id: attachment.id, decision, objects: { removed: objects.removed, pending: objects.failed, shared: objects.shared } };
  }

  return {
    list,
    messageDetail,
    attachmentDetail,
    rescanAttachment,
    releaseAttachment,
    releaseMessage,
    rejectMessage: (user, id, input, context) => removeMessage(user, id, "reject", input, context),
    deleteMessage: (user, id, input, context) => removeMessage(user, id, "delete", input, context),
    rejectAttachment: (user, id, input, context) => removeAttachment(user, id, "reject", input, context),
    deleteAttachment: (user, id, input, context) => removeAttachment(user, id, "delete", input, context),
  };
}

module.exports = { createQuarantineService, messageCategory, attachmentCategory, maskSender, CATEGORIES };

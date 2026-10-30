"use strict";

// Break-glass access to a mailbox the caller is not a member of. Requires:
// - requester holds explicit grant mail/break-glass-request (EDIT), with a
//   fresh step-up (purpose BREAK_GLASS_REQUEST);
// - a different approver holds mail/break-glass-approve (EDIT), with a fresh
//   step-up (purpose BREAK_GLASS_APPROVAL);
// - access is READER-only, expires within at most 4 hours, and is audited;
// - access is re-validated on every request (mail.policy findBreakGlass):
//   revoking the requester's or approver's grant, or deactivating either
//   identity, ends access immediately.

const { mailError } = require("../mail.errors");
const { requireExplicitMailSection, hasSection, isUuid } = require("./mail.policy");

const MAX_MINUTES = 240;

function createBreakGlassService({ client, stepUp, audit, clock = () => new Date() }) {
  async function request(user, input, context) {
    await requireExplicitMailSection(client, user, "break-glass-request", "EDIT");
    const justification = String(input.justification || "").trim();
    const caseReference = String(input.caseReference || "").trim();
    if (justification.length < 20) throw mailError("MAIL_VALIDATION_FAILED", { field: "justification", reason: "MIN_20_CHARS" });
    if (!caseReference || caseReference.length > 128) throw mailError("MAIL_VALIDATION_FAILED", { field: "caseReference" });
    if (!isUuid(input.mailboxId)) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    const mailbox = await client.mailMailbox.findUnique({ where: { id: input.mailboxId } });
    if (!mailbox) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    return client.$transaction(async (tx) => {
      const stepUpId = await stepUp.consume(tx, user, input.stepUpId, "BREAK_GLASS_REQUEST", context);
      const row = await tx.mailBreakGlassRequest.create({
        data: { mailboxId: mailbox.id, requesterAdminUserId: user.id, justification: justification.slice(0, 2000), caseReference, requesterStepUpId: stepUpId },
      });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_BREAK_GLASS_REQUESTED", targetType: "break_glass_request", targetId: row.id, mailboxId: mailbox.id, metadata: { caseReference } }, context, tx);
      return row;
    });
  }

  async function decide(user, requestId, { approve, stepUpId, durationMinutes, note }, context) {
    await requireExplicitMailSection(client, user, "break-glass-approve", "EDIT");
    if (!isUuid(requestId)) throw mailError("MAIL_NOT_FOUND", { resource: "break_glass_request" });
    const existing = await client.mailBreakGlassRequest.findUnique({ where: { id: requestId } });
    if (!existing) throw mailError("MAIL_NOT_FOUND", { resource: "break_glass_request" });
    if (existing.requesterAdminUserId === user.id) throw mailError("MAIL_FORBIDDEN", { reason: "APPROVER_MUST_DIFFER" });
    if (existing.status !== "PENDING") throw mailError("MAIL_INVALID_TRANSITION", { from: existing.status });
    const minutes = Math.min(Math.max(Number(durationMinutes) || 60, 5), MAX_MINUTES);
    const now = clock();
    if (approve) {
      // A request whose requester has since lost the grant (or is no longer
      // ACTIVE) cannot be approved; access is also re-checked on every read.
      const requester = await client.adminUser.findUnique({ where: { id: existing.requesterAdminUserId }, select: { id: true, status: true } });
      if (!requester || requester.status !== "ACTIVE" || !(await hasSection(client, requester, "mail", "break-glass-request", "EDIT", { now }))) {
        throw mailError("MAIL_INVALID_TRANSITION", { reason: "REQUESTER_NO_LONGER_ELIGIBLE" });
      }
    }
    return client.$transaction(async (tx) => {
      const consumed = approve ? await stepUp.consume(tx, user, stepUpId, "BREAK_GLASS_APPROVAL", context) : null;
      const updated = await tx.mailBreakGlassRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: approve ? "APPROVED" : "REJECTED",
          approverAdminUserId: user.id,
          approverStepUpId: consumed,
          decidedAt: now,
          decisionNote: note ? String(note).slice(0, 2000) : null,
          accessExpiresAt: approve ? new Date(now.getTime() + minutes * 60000) : null,
        },
      });
      if (updated.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: "CHANGED" });
      await audit.record({ actorAdminUserId: user.id, action: approve ? "MAIL_BREAK_GLASS_APPROVED" : "MAIL_BREAK_GLASS_REJECTED", targetType: "break_glass_request", targetId: requestId, mailboxId: existing.mailboxId, metadata: { minutes: approve ? minutes : null, requester: existing.requesterAdminUserId } }, context, tx);
      return tx.mailBreakGlassRequest.findUnique({ where: { id: requestId } });
    });
  }

  async function revoke(user, requestId, context) {
    const isApprover = await hasSection(client, user, "mail", "break-glass-approve", "EDIT");
    if (!isUuid(requestId)) throw mailError("MAIL_NOT_FOUND", { resource: "break_glass_request" });
    const existing = await client.mailBreakGlassRequest.findUnique({ where: { id: requestId } });
    if (!existing || (!isApprover && existing.requesterAdminUserId !== user.id)) throw mailError("MAIL_NOT_FOUND", { resource: "break_glass_request" });
    if (existing.status !== "APPROVED" && existing.status !== "PENDING") throw mailError("MAIL_INVALID_TRANSITION", { from: existing.status });
    const row = await client.mailBreakGlassRequest.update({ where: { id: requestId }, data: { status: "REVOKED", revokedAt: clock() } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_BREAK_GLASS_REVOKED", targetType: "break_glass_request", targetId: requestId, mailboxId: existing.mailboxId }, context);
    return row;
  }

  async function list(user) {
    const isApprover = await hasSection(client, user, "mail", "break-glass-approve", "EDIT");
    return client.mailBreakGlassRequest.findMany({
      where: isApprover ? {} : { requesterAdminUserId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  return { request, decide, revoke, list };
}

module.exports = { createBreakGlassService, MAX_MINUTES };

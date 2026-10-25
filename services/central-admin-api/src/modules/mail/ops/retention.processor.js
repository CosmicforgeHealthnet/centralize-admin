"use strict";

// M9 retention worker (job kind RETENTION_RUN, queue EVENTS).
//
// Resumable: the run stores a cursor (lastMessageAt, id) and processes one
// batch per job attempt, deferring itself until done. Every per-thread
// operation is idempotent, and for EXECUTE runs the cursor is advanced in the
// same transaction as the change, so a crash never repeats or skips a thread.
//
// Legal holds are re-read for every batch. A thread is protected when:
//   - an org-wide hold (no mailbox, no subject) exists in its organization;
//   - its mailbox is held;
//   - a subject hold names the owner of its personal mailbox, or the subject
//     sent any message in the thread.
// Threads with in-flight outbound jobs or open support conversations are
// skipped (never purged mid-send or mid-case).
//
// Actions:
//   ARCHIVE  move the thread to the ARCHIVE folder (no data removed).
//   DELETE   remove recipients, attachments, delivery events, notes, drafts,
//            per-user state and labels; scrub subject/snippet/sender/search
//            text on the thread and messages; delete the encrypted content
//            and attachment objects from storage. A minimal tombstone (ids,
//            direction, timestamps, sizes, hashes) stays for audit integrity.
//   REDACT   (webhook payloads) replace the stored provider payload.
//   system DELETE removes append-only integration rows inside a purge
//            transaction (SET LOCAL cosmicforge.mail_retention_purge = 'on').

const ACTIVE_JOB_STATUSES = ["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"];

function addCounts(counts, delta) {
  const next = { ...(counts || {}) };
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === "number") next[key] = (next[key] || 0) + value;
    else if (value !== undefined) next[key] = value;
  }
  return next;
}

function createRetentionProcessor({ client, config, audit, storage, clock = () => new Date(), logger = null }) {
  const now = () => clock();

  async function holdsFor(organizationId) {
    const holds = await client.mailLegalHold.findMany({ where: { releasedAt: null, ...(organizationId ? { organizationId } : {}) } });
    const orgWide = new Set(holds.filter((hold) => !hold.mailboxId && !hold.subjectAdminUserId).map((hold) => hold.organizationId));
    const mailboxes = new Set(holds.filter((hold) => hold.mailboxId).map((hold) => hold.mailboxId));
    const subjects = [...new Set(holds.filter((hold) => !hold.mailboxId && hold.subjectAdminUserId).map((hold) => hold.subjectAdminUserId))];
    if (subjects.length) {
      const owned = await client.mailMailbox.findMany({ where: { ownerAdminUserId: { in: subjects } }, select: { id: true } });
      for (const row of owned) mailboxes.add(row.id);
    }
    return { orgWide, mailboxes, subjects, anyActive: holds.length > 0, orgsWithAnyHold: new Set(holds.map((hold) => hold.organizationId)) };
  }

  async function threadHeld(thread, organizationId, holds) {
    if (holds.orgWide.has(organizationId) || holds.mailboxes.has(thread.mailboxId)) return true;
    if (!holds.subjects.length) return false;
    return (await client.mailMessage.count({ where: { threadId: thread.id, sentByAdminUserId: { in: holds.subjects } } })) > 0;
  }

  async function mailboxScope(run, retentionPolicy) {
    if (retentionPolicy.mailboxId) return [retentionPolicy.mailboxId];
    return (await client.mailMailbox.findMany({ where: { organizationId: run.organizationId }, select: { id: true } })).map((row) => row.id);
  }

  function afterCursor(cursor) {
    if (!cursor?.at) return {};
    const at = new Date(cursor.at);
    return { OR: [{ lastMessageAt: { gt: at } }, { lastMessageAt: at, id: { gt: cursor.id } }] };
  }

  async function purgeThread(tx, thread) {
    const messages = await tx.mailMessage.findMany({ where: { threadId: thread.id }, select: { id: true, contentObjectKey: true, rawMimeObjectKey: true } });
    const messageIds = messages.map((message) => message.id);
    const drafts = await tx.mailDraft.findMany({ where: { threadId: thread.id }, select: { id: true } });
    const draftIds = drafts.map((draft) => draft.id);
    const attachments = await tx.mailAttachment.findMany({ where: { OR: [{ messageId: { in: messageIds } }, { draftId: { in: draftIds } }] }, select: { id: true, storageKey: true, sizeBytes: true } });
    const keys = [...messages.flatMap((message) => [message.contentObjectKey, message.rawMimeObjectKey]), ...attachments.map((attachment) => attachment.storageKey)].filter(Boolean);
    await tx.mailDeliveryEvent.deleteMany({ where: { messageId: { in: messageIds } } });
    await tx.mailOutboxJob.deleteMany({ where: { messageId: { in: messageIds }, status: { notIn: ACTIVE_JOB_STATUSES } } });
    await tx.mailMessageRecipient.deleteMany({ where: { messageId: { in: messageIds } } });
    await tx.mailAttachment.deleteMany({ where: { id: { in: attachments.map((attachment) => attachment.id) } } });
    await tx.mailDraft.deleteMany({ where: { id: { in: draftIds } } });
    await tx.mailUserThreadState.deleteMany({ where: { threadId: thread.id } });
    await tx.mailThreadLabel.deleteMany({ where: { threadId: thread.id } });
    await tx.mailInternalNote.deleteMany({ where: { threadId: thread.id } });
    const at = now();
    await tx.mailMessage.updateMany({ where: { threadId: thread.id }, data: { subject: "", encryptedSnippet: null, fromAddress: "", fromName: null, replyTo: null, envelopeRecipient: null, metadataSearchText: "", contentObjectKey: null, rawMimeObjectKey: null, authResults: null, quarantineReason: null, references: [], inReplyTo: null, deletedAt: at } });
    await tx.mailThread.update({ where: { id: thread.id }, data: { subject: "", normalizedSubject: "", encryptedSnippet: null, participants: null, rootRfcMessageId: null, supportTicketRef: null, assignedToAdminUserId: null, deletedAt: at } });
    return { keys, messages: messageIds.length, attachments: attachments.length, bytes: attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) };
  }

  async function removeObjects(keys) {
    let removed = 0;
    let failed = 0;
    for (const key of keys) {
      try {
        await storage.remove(key);
        removed += 1;
      } catch (error) {
        failed += 1;
        logger?.warn?.(`[MailRetention] storage remove failed (${error?.code || "error"})`);
      }
    }
    return { removed, failed };
  }

  async function policyBatch(run) {
    const retentionPolicy = await client.mailRetentionPolicy.findUnique({ where: { id: run.policyId } });
    if (!retentionPolicy) return { error: "POLICY_MISSING" };
    if (run.mode === "EXECUTE" && (!retentionPolicy.enabled || retentionPolicy.action !== run.action)) return { error: "POLICY_CHANGED" };
    const holds = await holdsFor(run.organizationId);
    const where = {
      mailboxId: { in: await mailboxScope(run, retentionPolicy) },
      lastMessageAt: { lt: run.cutoff },
      deletedAt: null,
      ...(run.action === "ARCHIVE" ? { folder: { notIn: ["ARCHIVE", "TRASH"] } } : {}),
      ...afterCursor(run.cursor),
    };
    const threads = await client.mailThread.findMany({ where, orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }], take: config.retention.batchSize, select: { id: true, mailboxId: true, lastMessageAt: true, conversationStatus: true, messageCount: true } });
    let delta = { candidates: 0, held: 0, skippedActive: 0, archived: 0, purgedThreads: 0, purgedMessages: 0, purgedAttachments: 0, purgedAttachmentBytes: 0, storageObjectsRemoved: 0, storageRemoveFailed: 0, messagesInScope: 0 };
    let cursor = run.cursor;
    for (const thread of threads) {
      cursor = { at: thread.lastMessageAt.toISOString(), id: thread.id };
      delta.candidates += 1;
      delta.messagesInScope += thread.messageCount;
      if (await threadHeld(thread, run.organizationId, holds)) {
        delta.held += 1;
        continue;
      }
      const openCase = ["OPEN", "PENDING"].includes(thread.conversationStatus);
      const inFlight = await client.mailOutboxJob.count({ where: { message: { threadId: thread.id }, status: { in: ACTIVE_JOB_STATUSES } } });
      if (openCase || inFlight) {
        delta.skippedActive += 1;
        continue;
      }
      if (run.mode === "DRY_RUN") continue;
      if (run.action === "ARCHIVE") {
        await client.$transaction(async (tx) => {
          await tx.mailThread.update({ where: { id: thread.id }, data: { folder: "ARCHIVE" } });
          await tx.mailRetentionRun.update({ where: { id: run.id }, data: { cursor } });
        });
        delta.archived += 1;
        continue;
      }
      const result = await client.$transaction(async (tx) => {
        const purged = await purgeThread(tx, thread);
        await tx.mailRetentionRun.update({ where: { id: run.id }, data: { cursor } });
        return purged;
      });
      const objects = await removeObjects(result.keys);
      delta = addCounts(delta, { purgedThreads: 1, purgedMessages: result.messages, purgedAttachments: result.attachments, purgedAttachmentBytes: result.bytes, storageObjectsRemoved: objects.removed, storageRemoveFailed: objects.failed });
    }
    if (threads.length && delta.candidates) delta.newestCandidateAt = threads[threads.length - 1].lastMessageAt.toISOString();
    return { delta, cursor, done: threads.length < config.retention.batchSize };
  }

  async function systemBatch(run) {
    const holds = await holdsFor(null);
    const take = config.retention.batchSize;
    const execute = run.mode === "EXECUTE";
    if (run.category === "WEBHOOK_PAYLOADS") {
      // Webhook rows are not brand-scoped: any active hold blocks redaction.
      if (holds.anyActive) return { delta: { heldByLegalHold: 1 }, cursor: run.cursor, done: true };
      const rows = await client.mailWebhookEvent.findMany({ where: { receivedAt: { lt: run.cutoff }, status: { in: ["PROCESSED", "IGNORED", "FAILED"] }, NOT: { payload: { path: ["redacted"], equals: true } }, ...(run.cursor?.id ? { id: { gt: run.cursor.id } } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } });
      if (execute && rows.length) await client.mailWebhookEvent.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { payload: { redacted: true, redactedAt: now().toISOString(), runId: run.id } } });
      return { delta: { candidates: rows.length, ...(execute ? { redacted: rows.length } : {}) }, cursor: rows.length ? { id: rows[rows.length - 1].id } : run.cursor, done: rows.length < take };
    }
    const integrations = await client.mailProductIntegration.findMany({ select: { id: true, organizationId: true } });
    const allowed = integrations.filter((row) => !holds.orgsWithAnyHold.has(row.organizationId)).map((row) => row.id);
    const heldIntegrations = integrations.length - allowed.length;
    const model = run.category === "INTEGRATION_EVENTS" ? "mailProductIntegrationEvent" : "mailProductDeliveryEvent";
    const timeField = run.category === "INTEGRATION_EVENTS" ? "receivedAt" : "occurredAt";
    const rows = await client[model].findMany({ where: { integrationId: { in: allowed }, [timeField]: { lt: run.cutoff }, ...(run.cursor?.id ? { id: { gt: run.cursor.id } } : {}) }, orderBy: { id: "asc" }, take, select: { id: true } });
    if (execute && rows.length) {
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL cosmicforge.mail_retention_purge = 'on'");
        await tx[model].deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      });
    }
    return { delta: { candidates: rows.length, heldIntegrations, ...(execute ? { deleted: rows.length } : {}) }, cursor: rows.length ? { id: rows[rows.length - 1].id } : run.cursor, done: rows.length < take };
  }

  async function processRun(job) {
    const run = await client.mailRetentionRun.findUnique({ where: { id: job.payload?.runId } });
    if (!run || ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return { skipped: run?.status || "MISSING" };
    if (run.mode === "EXECUTE" && !config.retention.executionEnabled) return { defer: { seconds: 3600, code: "MAIL_RETENTION_EXECUTION_DISABLED" } };
    if (run.status === "QUEUED") await client.mailRetentionRun.updateMany({ where: { id: run.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: now() } });
    const result = run.category === "POLICY" ? await policyBatch(run) : await systemBatch(run);
    if (result.error) {
      await client.mailRetentionRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { status: "FAILED", errorCode: result.error, completedAt: now() } });
      await audit.record({ action: "MAIL_RETENTION_RUN_FAILED", targetType: "mail_retention_run", targetId: run.id, organizationId: run.organizationId, outcome: "FAILURE", metadata: { reason: result.error } });
      return { failed: result.error };
    }
    const fresh = await client.mailRetentionRun.findUnique({ where: { id: run.id } });
    const counts = addCounts(fresh.counts, result.delta);
    // Cancelled mid-batch: keep what was done, stop here.
    const status = fresh.status === "CANCELLED" ? "CANCELLED" : result.done ? "COMPLETED" : "RUNNING";
    await client.mailRetentionRun.update({ where: { id: run.id }, data: { counts, cursor: result.cursor ?? fresh.cursor, status, ...(status !== "RUNNING" ? { completedAt: fresh.completedAt || now() } : {}) } });
    if (run.mode === "EXECUTE" && Object.values(result.delta).some((value) => typeof value === "number" && value > 0)) {
      await audit.record({ action: "MAIL_RETENTION_BATCH_EXECUTED", targetType: "mail_retention_run", targetId: run.id, organizationId: run.organizationId, metadata: { category: run.category, action: run.action, delta: result.delta } });
    }
    if (status === "COMPLETED") await audit.record({ action: run.mode === "EXECUTE" ? "MAIL_RETENTION_EXECUTION_COMPLETED" : "MAIL_RETENTION_DRY_RUN_COMPLETED", targetType: "mail_retention_run", targetId: run.id, organizationId: run.organizationId, metadata: { counts } });
    if (status === "RUNNING") return { defer: { seconds: 1, code: "RETENTION_IN_PROGRESS" } };
    return { status, counts };
  }

  async function onDeadLetter(job, error) {
    const runId = job.payload?.runId;
    if (!runId) return;
    await client.mailRetentionRun.updateMany({ where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", errorCode: String(error?.code || "DEAD_LETTER").slice(0, 64), completedAt: now() } });
  }

  return { processRun, onDeadLetter, holdsFor };
}

module.exports = { createRetentionProcessor };

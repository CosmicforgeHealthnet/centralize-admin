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
//            DELETE runs also cover threads the user soft-deleted (thread
//            deletedAt set, messages not yet purged): purging marks every
//            message deletedAt with no content key, which is the
//            idempotency marker. After the thread phase, DELETE runs sweep
//            stale draft content in scope (discarded drafts, drafts without a
//            thread, removed draft attachments) older than the cutoff.
//            With migration 37 the purge also removes the messages'
//            provider Message-ID aliases (mail_message_provider_ids) and their
//            IT quarantine decisions (append-only; deleted under the
//            cosmicforge.mail_retention_purge session flag, SET LOCAL inside
//            the purge transaction, then switched off again). Storage
//            deletions are queued with sourceType "thread" / sourceId = the
//            thread id so the deletion worker can re-check subject holds on
//            the thread's senders at execution time.
//   REDACT   (webhook payloads) replace the stored provider payload.
//   system DELETE removes append-only integration rows inside a purge
//            transaction (SET LOCAL cosmicforge.mail_retention_purge = 'on').
//
// Gap 5 (migration 37): storage objects are not removed inline. Their keys are
// enqueued in mail_storage_deletions in the SAME transaction that drops the
// last row referencing them, then settled right after commit; anything left
// (storage outage) is retried by the deletion worker with backoff. Before
// migration 37 the previous inline, best-effort removal is kept.

const { objectReferenced } = require("./storage-deletion.service");

const ACTIVE_JOB_STATUSES = ["PENDING", "LEASED", "RETRY_SCHEDULED", "RECONCILING"];

function addCounts(counts, delta) {
  const next = { ...(counts || {}) };
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === "number") next[key] = (next[key] || 0) + value;
    else if (value !== undefined) next[key] = value;
  }
  return next;
}

function createRetentionProcessor({ client, config, audit, storage, features = null, deletions = null, clock = () => new Date(), logger = null }) {
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
    if (!cursor?.at || cursor.phase) return {};
    const at = new Date(cursor.at);
    return { OR: [{ lastMessageAt: { gt: at } }, { lastMessageAt: at, id: { gt: cursor.id } }] };
  }

  async function purgeThread(tx, thread) {
    const messages = await tx.mailMessage.findMany({ where: { threadId: thread.id }, select: { id: true, contentObjectKey: true, rawMimeObjectKey: true } });
    const messageIds = messages.map((message) => message.id);
    // Gap-closure tables (migration 35): body-search terms and archived
    // headers/raw MIME go with the messages.
    let archiveKeys = [];
    if (features && (await features.isReady())) {
      const archives = await tx.mailMessageArchive.findMany({ where: { messageId: { in: messageIds } }, select: { headersObjectKey: true, rawMimeObjectKey: true } });
      archiveKeys = archives.flatMap((archive) => [archive.headersObjectKey, archive.rawMimeObjectKey]);
      await tx.mailMessageArchive.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.mailMessageSearchIndex.deleteMany({ where: { messageId: { in: messageIds } } });
    }
    const drafts = await tx.mailDraft.findMany({ where: { threadId: thread.id }, select: { id: true } });
    const draftIds = drafts.map((draft) => draft.id);
    const attachments = await tx.mailAttachment.findMany({ where: { OR: [{ messageId: { in: messageIds } }, { draftId: { in: draftIds } }] }, select: { id: true, storageKey: true, sizeBytes: true } });
    const keys = [...new Set([...messages.flatMap((message) => [message.contentObjectKey, message.rawMimeObjectKey]), ...attachments.map((attachment) => attachment.storageKey), ...archiveKeys].filter(Boolean))];
    await tx.mailDeliveryEvent.deleteMany({ where: { messageId: { in: messageIds } } });
    await tx.mailOutboxJob.deleteMany({ where: { messageId: { in: messageIds }, status: { notIn: ACTIVE_JOB_STATUSES } } });
    await tx.mailMessageRecipient.deleteMany({ where: { messageId: { in: messageIds } } });
    if (deletions && (await deletions.ready())) {
      await tx.mailMessageProviderId.deleteMany({ where: { messageId: { in: messageIds } } });
      const attachmentIds = attachments.map((attachment) => attachment.id);
      const decisionWhere = { OR: [{ messageId: { in: messageIds } }, ...(attachmentIds.length ? [{ attachmentId: { in: attachmentIds } }] : [])] };
      if (await tx.mailQuarantineDecision.count({ where: decisionWhere })) {
        await tx.$executeRawUnsafe("SET LOCAL cosmicforge.mail_retention_purge = 'on'");
        await tx.mailQuarantineDecision.deleteMany({ where: decisionWhere });
        await tx.$executeRawUnsafe("SET LOCAL cosmicforge.mail_retention_purge = 'off'");
      }
    }
    await dropAttachmentRows(tx, { id: { in: attachments.map((attachment) => attachment.id) } });
    await tx.mailDraft.deleteMany({ where: { id: { in: draftIds } } });
    await tx.mailUserThreadState.deleteMany({ where: { threadId: thread.id } });
    await tx.mailThreadLabel.deleteMany({ where: { threadId: thread.id } });
    await tx.mailInternalNote.deleteMany({ where: { threadId: thread.id } });
    const at = now();
    await tx.mailMessage.updateMany({ where: { threadId: thread.id }, data: { subject: "", encryptedSnippet: null, fromAddress: "", fromName: null, replyTo: null, envelopeRecipient: null, metadataSearchText: "", contentObjectKey: null, rawMimeObjectKey: null, authResults: null, quarantineReason: null, references: [], inReplyTo: null, deletedAt: at } });
    await tx.mailThread.update({ where: { id: thread.id }, data: { subject: "", normalizedSubject: "", encryptedSnippet: null, participants: null, rootRfcMessageId: null, supportTicketRef: null, assignedToAdminUserId: null, deletedAt: at } });
    return { keys, messages: messageIds.length, attachments: attachments.length, bytes: attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) };
  }

  // Objects are shared: one inbound body/attachment/archive object is
  // referenced by every local mailbox copy of the message (and internal mail
  // shares the sender's body). An object is removed only once NOTHING still
  // references it, so purging one mailbox never destroys another mailbox's
  // content (including content under a legal hold).
  async function stillReferenced(key) {
    return objectReferenced(client, key, { archivesReady: Boolean(features && (await features.isReady())) });
  }

  // Gap 5: attachment rows go through the deletion service (rows with an
  // append-only quarantine decision are tombstoned, not deleted).
  async function dropAttachmentRows(tx, where) {
    if (deletions) return deletions.dropAttachments(tx, where);
    return (await tx.mailAttachment.deleteMany({ where })).count;
  }

  // Inside the purge transaction: enqueue the keys whose last reference this
  // transaction dropped (legacy inline plan without a deletion service).
  async function queueObjects(tx, keys, meta) {
    if (!deletions) return { mode: "legacy", keys: [...new Set(keys.filter(Boolean))] };
    return deletions.enqueue(tx, keys, { purpose: "RETENTION", ...meta });
  }

  // After commit. Never throws: a failure leaves the rows queued for retry.
  async function settleObjects(plan) {
    if (plan.mode === "legacy") return removeObjects(plan.keys);
    try {
      const result = await deletions.settle(plan);
      return { removed: result.removed, failed: result.failed, shared: result.shared + result.held };
    } catch (error) {
      logger?.warn?.(`[MailRetention] storage deletion settle failed (${error?.code || "error"})`);
      return { removed: 0, failed: plan.keys.length, shared: plan.shared || 0 };
    }
  }

  async function removeObjects(keys) {
    let removed = 0;
    let failed = 0;
    let shared = 0;
    for (const key of keys) {
      if (await stillReferenced(key)) {
        shared += 1;
        continue;
      }
      try {
        await storage.remove(key);
        removed += 1;
      } catch (error) {
        failed += 1;
        logger?.warn?.(`[MailRetention] storage remove failed (${error?.code || "error"})`);
      }
    }
    return { removed, failed, shared };
  }

  async function policyBatch(run) {
    const retentionPolicy = await client.mailRetentionPolicy.findUnique({ where: { id: run.policyId } });
    if (!retentionPolicy) return { error: "POLICY_MISSING" };
    if (run.mode === "EXECUTE" && (!retentionPolicy.enabled || retentionPolicy.action !== run.action)) return { error: "POLICY_CHANGED" };
    const holds = await holdsFor(run.organizationId);
    const scope = await mailboxScope(run, retentionPolicy);
    if (run.cursor?.phase) return sweepBatch(run, scope, holds);
    const where = {
      mailboxId: { in: scope },
      lastMessageAt: { lt: run.cutoff },
      // User-deleted threads keep their content until a DELETE run purges it.
      ...(run.action === "DELETE" ? { OR: [{ deletedAt: null }, { messages: { some: { deletedAt: null } } }] } : { deletedAt: null }),
      ...(run.action === "ARCHIVE" ? { folder: { notIn: ["ARCHIVE", "TRASH"] } } : {}),
      ...afterCursor(run.cursor),
    };
    const threads = await client.mailThread.findMany({ where, orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }], take: config.retention.batchSize, select: { id: true, mailboxId: true, lastMessageAt: true, conversationStatus: true, messageCount: true } });
    let delta = { candidates: 0, held: 0, skippedActive: 0, archived: 0, purgedThreads: 0, purgedMessages: 0, purgedAttachments: 0, purgedAttachmentBytes: 0, storageObjectsRemoved: 0, storageRemoveFailed: 0, storageObjectsKeptShared: 0, messagesInScope: 0 };
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
        purged.plan = await queueObjects(tx, purged.keys, { reason: "RETENTION_PURGE", sourceType: "thread", sourceId: thread.id, organizationId: run.organizationId, mailboxId: thread.mailboxId });
        await tx.mailRetentionRun.update({ where: { id: run.id }, data: { cursor } });
        return purged;
      });
      const objects = await settleObjects(result.plan);
      delta = addCounts(delta, { purgedThreads: 1, purgedMessages: result.messages, purgedAttachments: result.attachments, purgedAttachmentBytes: result.bytes, storageObjectsRemoved: objects.removed, storageRemoveFailed: objects.failed, storageObjectsKeptShared: objects.shared });
    }
    if (threads.length && delta.candidates) delta.newestCandidateAt = threads[threads.length - 1].lastMessageAt.toISOString();
    const threadsDone = threads.length < config.retention.batchSize;
    // DELETE runs continue with the draft sweep phases.
    if (threadsDone && run.action === "DELETE") return { delta, cursor: { phase: "drafts" }, done: false };
    return { delta, cursor, done: threadsDone };
  }

  // Draft sweep (DELETE runs only), in two resumable phases ordered by id:
  //   drafts       discarded drafts, and drafts without a thread, last touched
  //                before the cutoff (with their attachments);
  //   attachments  attachments removed from a draft (no draft, no message).
  // In-flight drafts (SENDING) are never touched. Held mailboxes, and drafts
  // written by a held subject, are skipped. Objects are removed only when
  // nothing else references them.
  async function sweepBatch(run, scope, holds) {
    const take = config.retention.batchSize;
    const execute = run.mode === "EXECUTE";
    const orgHeld = holds.orgWide.has(run.organizationId);
    const mailboxes = orgHeld ? [] : scope.filter((id) => !holds.mailboxes.has(id));
    const afterId = run.cursor.id ? { id: { gt: run.cursor.id } } : {};
    let delta = {};
    if (run.cursor.phase === "drafts") {
      const drafts = mailboxes.length
        ? await client.mailDraft.findMany({
          where: {
            mailboxId: { in: mailboxes },
            updatedAt: { lt: run.cutoff },
            OR: [{ status: "DISCARDED" }, { threadId: null, status: { in: ["ACTIVE", "SENT"] } }],
            ...(holds.subjects.length ? { authorAdminUserId: { notIn: holds.subjects } } : {}),
            ...afterId,
          },
          orderBy: { id: "asc" },
          take,
          select: { id: true },
        })
        : [];
      delta = { draftCandidates: drafts.length, ...(orgHeld ? { draftSweepHeld: 1 } : {}) };
      let cursor = drafts.length ? { phase: "drafts", id: drafts[drafts.length - 1].id } : { phase: "attachments" };
      if (execute && drafts.length) {
        const ids = drafts.map((draft) => draft.id);
        const plan = await client.$transaction(async (tx) => {
          const attachments = await tx.mailAttachment.findMany({ where: { draftId: { in: ids }, messageId: null }, select: { id: true, storageKey: true } });
          await dropAttachmentRows(tx, { id: { in: attachments.map((attachment) => attachment.id) } });
          // Draft attachment rows already copied onto a sent message only lose the draft link.
          await tx.mailAttachment.updateMany({ where: { draftId: { in: ids } }, data: { draftId: null } });
          await tx.mailDraft.deleteMany({ where: { id: { in: ids } } });
          await tx.mailRetentionRun.update({ where: { id: run.id }, data: { cursor } });
          return queueObjects(tx, attachments.map((attachment) => attachment.storageKey), { reason: "RETENTION_DRAFT_SWEEP", sourceType: "retention_run", sourceId: run.id, organizationId: run.organizationId });
        });
        const objects = await settleObjects(plan);
        delta = addCounts(delta, { purgedDrafts: ids.length, storageObjectsRemoved: objects.removed, storageRemoveFailed: objects.failed, storageObjectsKeptShared: objects.shared });
      }
      if (drafts.length < take) cursor = { phase: "attachments" };
      return { delta, cursor, done: false };
    }
    const orphans = mailboxes.length
      ? await client.mailAttachment.findMany({ where: { mailboxId: { in: mailboxes }, messageId: null, draftId: null, createdAt: { lt: run.cutoff }, ...afterId }, orderBy: { id: "asc" }, take, select: { id: true, storageKey: true } })
      : [];
    delta = { orphanAttachmentCandidates: orphans.length };
    const cursor = orphans.length ? { phase: "attachments", id: orphans[orphans.length - 1].id } : run.cursor;
    if (execute && orphans.length) {
      const plan = await client.$transaction(async (tx) => {
        await dropAttachmentRows(tx, { id: { in: orphans.map((row) => row.id) }, messageId: null, draftId: null });
        await tx.mailRetentionRun.update({ where: { id: run.id }, data: { cursor } });
        return queueObjects(tx, orphans.map((row) => row.storageKey), { reason: "RETENTION_ORPHAN_SWEEP", sourceType: "retention_run", sourceId: run.id, organizationId: run.organizationId });
      });
      const objects = await settleObjects(plan);
      delta = addCounts(delta, { purgedOrphanAttachments: orphans.length, storageObjectsRemoved: objects.removed, storageRemoveFailed: objects.failed, storageObjectsKeptShared: objects.shared });
    }
    return { delta, cursor, done: orphans.length < take };
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

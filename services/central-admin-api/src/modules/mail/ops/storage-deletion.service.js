"use strict";

// Gap 5: durable deletion of private Mail storage objects (migration 37,
// table mail_storage_deletions).
//
// Every object deletion in Mail (retention purge and draft/orphan sweeps,
// DSAR erasure, inbound replay/orphan cleanup, draft discard and draft
// attachment removal, IT quarantine reject/delete) is ENQUEUED in the same
// database transaction that drops the last database reference to the key, so
// a crash between "row gone" and "object gone" can never lose the deletion.
// After commit the caller settles its own rows immediately (best effort);
// anything left over is retried by the STORAGE_DELETION_RUN worker job.
//
// Execution (per row, claimed with a lease under FOR UPDATE SKIP LOCKED;
// RUNNING rows whose lease expired are reclaimed after a worker crash):
//   1. re-check, immediately before deleting, that NOTHING references the key
//      any more (message body/raw MIME, attachment storage key - drafts hold
//      their files as attachment rows - and archived headers/raw MIME). Keys
//      are immutable random keys; key rotation rewrites objects IN PLACE under
//      the same key, so a key that is referenced again (stale metadata, a
//      replacement written under it) is CANCELLED with reason REFERENCED and
//      never deleted;
//   2. re-check legal holds (organization-wide, mailbox, subject owning the
//      mailbox, and subject holds on the people of the source: thread senders
//      for a thread/message/attachment source, the author for a draft source,
//      resolved from sourceType/sourceId). A row with no organization and no
//      mailbox is treated conservatively: any active org-wide hold (in any
//      organization) holds it. A held key is CANCELLED with reason HELD and
//      audited: the object is kept for the hold, and an operator may requeue
//      the row once the hold is released (requeue needs an MFA step-up);
//   3. delete. A missing object (404) counts as done, so deletion is
//      idempotent. Transient errors schedule a retry with bounded exponential
//      backoff and full jitter (base MAIL_STORAGE_DELETION_BACKOFF_BASE_SECONDS,
//      cap ..._CAP_SECONDS); after MAIL_STORAGE_DELETION_MAX_ATTEMPTS the row is
//      DEAD (manual review in Mail operations).
// The partial unique index UQ_mail_storage_deletions_open_object keeps one
// open (PENDING/RUNNING) row per key, so duplicate enqueues are no-ops.
//
// Concurrency (re-audit fix 2): enqueue takes a transaction-scoped advisory
// lock per key (pg_advisory_xact_lock(hashtext('mail-obj:'||key)), keys in
// sorted order so two transactions never deadlock on each other) BEFORE the
// reference check. Two transactions that each drop one of the last two
// references to a key are therefore serialized: the second one's check runs
// after the first committed and sees no reference left, so the object is
// always queued by one of them (under READ COMMITTED each statement sees the
// latest committed rows). Every caller drops its references before calling
// enqueue in the same transaction, which this ordering relies on.
// Known limit: there is no storage-listing orphan sweep (not every backend can
// list objects); a key orphaned by a path that bypasses enqueue is not found.
//
// Cancel (admin): only for COMPOSE/OBJECT rows. Deletions requested by a DSAR
// erasure, an IT quarantine reject/delete or a retention purge cannot be
// cancelled (MAIL_INVALID_TRANSITION reason PROTECTED_DELETION). Cancel needs
// a reason and the MFA step-up MAIL_STORAGE_DELETION_CANCEL; an admin-cancelled
// row can be requeued later (requeue step-up).
//
// Before migration 37 (features.finalGap not ready) nothing touches the table:
// callers keep the previous inline, best-effort deletion (never throwing), and
// the admin endpoints answer 503 MAIL_FEATURE_NOT_READY.
//
// Audit events carry a SHA-256 prefix of the key only, never the key itself
// and never content.

const crypto = require("crypto");
const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");

const STATUSES = ["PENDING", "RUNNING", "DONE", "DEAD", "CANCELLED"];
// Deletions an administrator may never cancel (legal/IT/retention mandates).
const PROTECTED_PURPOSES = new Set(["DSAR", "QUARANTINE", "RETENTION"]);
const REQUEUEABLE_CANCELS = new Set(["HELD", "CANCELLED_BY_ADMIN"]);
const DEFAULTS = { maxAttempts: 12, baseSeconds: 30, capSeconds: 21600, batchSize: 100, leaseSeconds: 300, intervalSeconds: 300 };

function keyHash(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex").slice(0, 16);
}

function isNotFound(error) {
  return error?.status === 404 || error?.statusCode === 404 || error?.code === "ENOENT" || error?.code === "NoSuchKey" || error?.code === "NOT_FOUND";
}

// Whether any row still references a storage object key. Shared by every
// deletion path (and by the queue right before it deletes).
async function objectReferenced(db, key, { archivesReady = false } = {}) {
  const [messages, attachments] = await Promise.all([
    db.mailMessage.count({ where: { OR: [{ contentObjectKey: key }, { rawMimeObjectKey: key }] } }),
    db.mailAttachment.count({ where: { storageKey: key } }),
  ]);
  if (messages || attachments) return true;
  if (archivesReady) return (await db.mailMessageArchive.count({ where: { OR: [{ headersObjectKey: key }, { rawMimeObjectKey: key }] } })) > 0;
  return false;
}

function createStorageDeletionService({ client, config = {}, storage, audit, stepUp = null, feature = null, archiveFeature = null, clock = () => new Date(), logger = null, random = Math.random }) {
  const settings = { ...DEFAULTS, ...(config.storageDeletion || {}) };

  async function ready() {
    if (!feature) return false;
    return feature.isReady().catch(() => false);
  }

  async function archivesReady() {
    if (!archiveFeature) return false;
    return archiveFeature.isReady().catch(() => false);
  }

  // Full-jitter exponential backoff in seconds (at least 1s).
  function backoffSeconds(attempts) {
    const exp = Math.min(settings.capSeconds, settings.baseSeconds * 2 ** Math.max(0, attempts - 1));
    return Math.max(1, Math.floor(random() * exp));
  }

  // ---- legal holds (same scope rules as the retention worker) ----
  async function holdState(organizationId) {
    const holds = await client.mailLegalHold.findMany({ where: { releasedAt: null, ...(organizationId ? { organizationId } : {}) } });
    const orgWide = new Set(holds.filter((hold) => !hold.mailboxId && !hold.subjectAdminUserId).map((hold) => hold.organizationId));
    const mailboxes = new Set(holds.filter((hold) => hold.mailboxId).map((hold) => hold.mailboxId));
    const subjects = [...new Set(holds.filter((hold) => !hold.mailboxId && hold.subjectAdminUserId).map((hold) => hold.subjectAdminUserId))];
    if (subjects.length) {
      const owned = await client.mailMailbox.findMany({ where: { ownerAdminUserId: { in: subjects } }, select: { id: true } });
      for (const row of owned) mailboxes.add(row.id);
    }
    return { orgWide, mailboxes, subjects };
  }

  // A scope (mailbox and/or organization, optional people) is held when an
  // org-wide hold, a mailbox hold, or a subject hold on its owner / one of the
  // people applies.
  async function scopeHeld({ organizationId = null, mailboxId = null, adminUserIds = [] } = {}) {
    let orgId = organizationId;
    if (!orgId && mailboxId) orgId = (await client.mailMailbox.findUnique({ where: { id: mailboxId }, select: { organizationId: true } }))?.organizationId || null;
    if (!orgId && !mailboxId) {
      // No scope at all: conservative - any org-wide hold anywhere, or a
      // subject hold on one of the people, keeps the object.
      const all = await holdState(null);
      return all.orgWide.size > 0 || adminUserIds.filter(Boolean).some((id) => all.subjects.includes(id));
    }
    const holds = await holdState(orgId);
    if (orgId && holds.orgWide.has(orgId)) return true;
    if (mailboxId && holds.mailboxes.has(mailboxId)) return true;
    return adminUserIds.filter(Boolean).some((id) => holds.subjects.includes(id));
  }

  // ---- enqueue (inside the caller's transaction) ----
  // Returns a plan for settle(): queued keys (unreferenced in this
  // transaction), keys still referenced elsewhere (shared), or the inline
  // fallback before migration 37.
  async function enqueue(tx, keys, meta = {}) {
    const unique = [...new Set((keys || []).filter(Boolean))];
    if (!unique.length) return { mode: "none", keys: [], shared: 0 };
    if (!(await ready())) return { mode: "inline", keys: unique, shared: 0 };
    const withArchives = await archivesReady();
    const queued = [];
    let shared = 0;
    // Serialize concurrent drops of the last references to the same key
    // (sorted: a stable lock order across transactions).
    for (const key of [...unique].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`mail-obj:${key}`}))`;
    for (const key of unique) {
      if (await objectReferenced(tx, key, { archivesReady: withArchives })) shared += 1;
      else queued.push(key);
    }
    if (queued.length) {
      const at = clock();
      // ON CONFLICT DO NOTHING: the partial unique index allows one open row per key.
      await tx.mailStorageDeletion.createMany({
        data: queued.map((objectKey) => ({
          objectKey,
          purpose: String(meta.purpose || "OBJECT").slice(0, 32),
          reason: String(meta.reason || "UNSPECIFIED").slice(0, 64),
          sourceType: meta.sourceType ? String(meta.sourceType).slice(0, 32) : null,
          sourceId: meta.sourceId ? String(meta.sourceId).slice(0, 64) : null,
          organizationId: meta.organizationId || null,
          mailboxId: meta.mailboxId || null,
          requestedBy: meta.requestedBy || null,
          nextAttemptAt: at,
          createdAt: at,
          updatedAt: at,
        })),
        skipDuplicates: true,
      });
    }
    return { mode: "queued", keys: queued, shared };
  }

  // Attachment rows referenced by an append-only quarantine decision cannot be
  // deleted (FK RESTRICT); they are reduced to a tombstone instead (no key, no
  // filename) so the decision history stays intact.
  async function dropAttachments(tx, where) {
    const rows = await tx.mailAttachment.findMany({ where, select: { id: true } });
    const ids = rows.map((row) => row.id);
    if (!ids.length) return 0;
    let keep = [];
    if (await ready()) {
      const decided = await tx.mailQuarantineDecision.findMany({ where: { attachmentId: { in: ids } }, select: { attachmentId: true }, distinct: ["attachmentId"] });
      keep = decided.map((row) => row.attachmentId);
    }
    const remove = ids.filter((id) => !keep.includes(id));
    if (remove.length) await tx.mailAttachment.deleteMany({ where: { id: { in: remove } } });
    if (keep.length) await tx.mailAttachment.updateMany({ where: { id: { in: keep } }, data: { storageKey: null, filename: "removed", contentId: null, providerAttachmentId: null, draftId: null, quarantined: true } });
    return ids.length;
  }

  // ---- execution ----
  async function claim({ keys = null, limit = settings.batchSize } = {}) {
    const at = clock();
    const leaseUntil = new Date(at.getTime() + settings.leaseSeconds * 1000);
    const take = Math.max(1, Math.min(1000, limit));
    if (keys) {
      if (!keys.length) return [];
      return client.$queryRaw`
        WITH picked AS (
          SELECT "id" FROM "mail_storage_deletions"
          WHERE "object_key" = ANY(${keys}::varchar[])
            AND (("status" = 'PENDING' AND "next_attempt_at" <= ${at}) OR ("status" = 'RUNNING' AND "lease_until" < ${at}))
          ORDER BY "next_attempt_at" ASC
          LIMIT ${take}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "mail_storage_deletions" AS d SET "status" = 'RUNNING', "lease_until" = ${leaseUntil}, "updated_at" = ${at}
        FROM picked WHERE d."id" = picked."id"
        RETURNING d."id", d."object_key" AS "objectKey", d."attempts", d."organization_id" AS "organizationId", d."mailbox_id" AS "mailboxId", d."purpose", d."reason", d."source_type" AS "sourceType", d."source_id" AS "sourceId", d."requested_by" AS "requestedBy"`;
    }
    return client.$queryRaw`
      WITH picked AS (
        SELECT "id" FROM "mail_storage_deletions"
        WHERE ("status" = 'PENDING' AND "next_attempt_at" <= ${at}) OR ("status" = 'RUNNING' AND "lease_until" < ${at})
        ORDER BY "next_attempt_at" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "mail_storage_deletions" AS d SET "status" = 'RUNNING', "lease_until" = ${leaseUntil}, "updated_at" = ${at}
      FROM picked WHERE d."id" = picked."id"
      RETURNING d."id", d."object_key" AS "objectKey", d."attempts", d."organization_id" AS "organizationId", d."mailbox_id" AS "mailboxId", d."purpose", d."reason", d."source_type" AS "sourceType", d."source_id" AS "sourceId", d."requested_by" AS "requestedBy"`;
  }

  // Finishes a claimed row; refused (count 0) when the lease was lost.
  async function finish(row, data) {
    const at = clock();
    const result = await client.mailStorageDeletion.updateMany({ where: { id: row.id, status: "RUNNING" }, data: { ...data, leaseUntil: null, updatedAt: at } });
    return result.count === 1;
  }

  // People whose subject holds protect the row's source (re-audit fix 6).
  async function threadSenders(threadId) {
    if (!threadId) return [];
    const rows = await client.mailMessage.findMany({ where: { threadId, sentByAdminUserId: { not: null } }, select: { sentByAdminUserId: true }, distinct: ["sentByAdminUserId"] });
    return rows.map((row) => row.sentByAdminUserId);
  }

  async function sourceScope(row) {
    const type = String(row.sourceType || "").toLowerCase();
    const id = row.sourceId;
    const scope = { mailboxId: row.mailboxId || null, people: [] };
    if (!id || !policy.isUuid(id)) return scope;
    let threadId = null;
    if (type === "thread") {
      const thread = await client.mailThread.findUnique({ where: { id }, select: { id: true, mailboxId: true } });
      threadId = thread?.id || null;
      scope.mailboxId = scope.mailboxId || thread?.mailboxId || null;
    } else if (type === "message") {
      const message = await client.mailMessage.findUnique({ where: { id }, select: { threadId: true, mailboxId: true, sentByAdminUserId: true } });
      threadId = message?.threadId || null;
      scope.mailboxId = scope.mailboxId || message?.mailboxId || null;
      scope.people.push(message?.sentByAdminUserId);
    } else if (type === "attachment") {
      const attachment = await client.mailAttachment.findUnique({ where: { id }, select: { mailboxId: true, uploadedByAdminUserId: true, message: { select: { threadId: true, sentByAdminUserId: true } }, draft: { select: { authorAdminUserId: true, threadId: true } } } });
      threadId = attachment?.message?.threadId || attachment?.draft?.threadId || null;
      scope.mailboxId = scope.mailboxId || attachment?.mailboxId || null;
      scope.people.push(attachment?.message?.sentByAdminUserId, attachment?.draft?.authorAdminUserId, attachment?.uploadedByAdminUserId);
    } else if (type === "draft") {
      const draft = await client.mailDraft.findUnique({ where: { id }, select: { authorAdminUserId: true, threadId: true, mailboxId: true } });
      threadId = draft?.threadId || null;
      scope.mailboxId = scope.mailboxId || draft?.mailboxId || null;
      // Compose rows record the author as requestedBy (the draft may be gone).
      scope.people.push(draft?.authorAdminUserId || row.requestedBy);
    }
    if (threadId) scope.people.push(...(await threadSenders(threadId)));
    scope.people = [...new Set(scope.people.filter(Boolean))];
    return scope;
  }

  async function processRow(row, holdCache) {
    const at = clock();
    const meta = { keyHash: keyHash(row.objectKey), purpose: row.purpose, reason: row.reason };
    try {
      if (await objectReferenced(client, row.objectKey, { archivesReady: await archivesReady() })) {
        await finish(row, { status: "CANCELLED", lastError: "REFERENCED", completedAt: at });
        return "referenced";
      }
      const scope = await sourceScope(row);
      const holdKey = `${row.organizationId || "-"}:${scope.mailboxId || "-"}:${scope.people.sort().join(",")}`;
      if (!holdCache.has(holdKey)) holdCache.set(holdKey, await scopeHeld({ organizationId: row.organizationId, mailboxId: scope.mailboxId, adminUserIds: scope.people }));
      if (holdCache.get(holdKey)) {
        if (await finish(row, { status: "CANCELLED", lastError: "HELD", completedAt: at })) {
          await audit?.record({ action: "MAIL_STORAGE_DELETION_HELD", targetType: "mail_storage_deletion", targetId: row.id, organizationId: row.organizationId, mailboxId: row.mailboxId, outcome: "DENIED", metadata: meta }).catch(() => {});
        }
        return "held";
      }
      try {
        await storage.remove(row.objectKey);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await finish(row, { status: "DONE", lastError: null, completedAt: at });
      return "done";
    } catch (error) {
      const attempts = row.attempts + 1;
      const code = String(error?.code || error?.name || "STORAGE_ERROR").slice(0, 255);
      if (attempts >= settings.maxAttempts) {
        if (await finish(row, { status: "DEAD", attempts, lastError: code })) {
          await audit?.record({ action: "MAIL_STORAGE_DELETION_DEAD", targetType: "mail_storage_deletion", targetId: row.id, organizationId: row.organizationId, mailboxId: row.mailboxId, outcome: "FAILURE", metadata: { ...meta, attempts, error: code } }).catch(() => {});
        }
        logger?.warn?.(`[MailStorageDeletion] ${row.id} dead after ${attempts} attempts (${code})`);
        return "dead";
      }
      await finish(row, { status: "PENDING", attempts, lastError: code, nextAttemptAt: new Date(at.getTime() + backoffSeconds(attempts) * 1000) });
      logger?.warn?.(`[MailStorageDeletion] ${row.id} attempt ${attempts} failed (${code}); retry scheduled`);
      return "retry";
    }
  }

  async function processRows(rows) {
    const counts = { claimed: rows.length, done: 0, referenced: 0, held: 0, retry: 0, dead: 0 };
    const holdCache = new Map();
    for (const row of rows) counts[await processRow(row, holdCache)] += 1;
    return counts;
  }

  // Worker step: claims due rows (and expired leases) and executes them.
  async function processDue({ limit = settings.batchSize } = {}) {
    if (!(await ready())) return { skipped: "MAIL_FEATURE_NOT_READY", claimed: 0 };
    return processRows(await claim({ limit }));
  }

  // Cheap check used to schedule the worker job only when work is due.
  async function hasDue() {
    if (!(await ready())) return false;
    const at = clock();
    const row = await client.mailStorageDeletion.findFirst({ where: { OR: [{ status: "PENDING", nextAttemptAt: { lte: at } }, { status: "RUNNING", leaseUntil: { lt: at } }] }, select: { id: true } });
    return Boolean(row);
  }

  // Inline fallback (before migration 37): the previous best-effort behaviour.
  async function removeInline(keys) {
    const result = { removed: 0, failed: 0, shared: 0, held: 0, queued: 0 };
    const withArchives = await archivesReady();
    for (const key of keys) {
      try {
        if (await objectReferenced(client, key, { archivesReady: withArchives })) {
          result.shared += 1;
          continue;
        }
        await storage.remove(key);
        result.removed += 1;
      } catch (error) {
        if (isNotFound(error)) {
          result.removed += 1;
          continue;
        }
        result.failed += 1;
        logger?.warn?.(`[MailStorageDeletion] inline remove failed (${error?.code || "error"})`);
      }
    }
    return result;
  }

  // After commit: executes the caller's own queued rows now (best effort).
  // Never throws; whatever is left is retried by the worker.
  async function settle(plan) {
    if (!plan || plan.mode === "none") return { removed: 0, failed: 0, shared: 0, held: 0, queued: 0 };
    if (plan.mode === "inline") return removeInline(plan.keys);
    const result = { removed: 0, failed: 0, shared: plan.shared || 0, held: 0, queued: plan.keys.length };
    if (!plan.keys.length) return result;
    try {
      const counts = await processRows(await claim({ keys: plan.keys, limit: plan.keys.length }));
      result.removed = counts.done;
      result.shared += counts.referenced;
      result.held = counts.held;
      result.failed = counts.retry + counts.dead;
      result.queued = plan.keys.length - counts.done - counts.referenced - counts.held;
    } catch (error) {
      result.failed = plan.keys.length;
      logger?.warn?.(`[MailStorageDeletion] immediate execution failed (${error?.code || "error"}); the worker will retry`);
    }
    return result;
  }

  // ---- metrics (null before migration 37) ----
  async function stats() {
    if (!(await ready())) return null;
    const at = clock();
    const [byStatus, due] = await Promise.all([
      client.mailStorageDeletion.groupBy({ by: ["status"], _count: { _all: true } }),
      client.mailStorageDeletion.aggregate({ where: { status: "PENDING", nextAttemptAt: { lte: at } }, _count: { _all: true }, _min: { nextAttemptAt: true } }),
    ]);
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const row of byStatus) counts[row.status] = row._count._all;
    const oldest = due._min.nextAttemptAt;
    return {
      byStatus: counts,
      depth: counts.PENDING + counts.RUNNING,
      due: due._count._all,
      oldestDueSeconds: oldest ? Math.max(0, Math.round((at.getTime() - oldest.getTime()) / 1000)) : 0,
      dead: counts.DEAD,
    };
  }

  // ---- ops controls (mail admin; requeue needs MFA step-up) ----
  async function requireReady() {
    if (!(await ready())) throw mailError("MAIL_FEATURE_NOT_READY", { feature: "storage_deletions" });
  }

  function serialize(row) {
    return {
      id: row.id,
      keyHash: keyHash(row.objectKey),
      purpose: row.purpose,
      reason: row.reason,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      organizationId: row.organizationId,
      mailboxId: row.mailboxId,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: settings.maxAttempts,
      nextAttemptAt: row.nextAttemptAt?.toISOString() || null,
      lastError: row.lastError,
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() || null,
    };
  }

  async function list(user, query = {}) {
    await policy.requireMailAdmin(client, user, "VIEW");
    await requireReady();
    const status = query.status ? String(query.status).toUpperCase() : null;
    if (status && !STATUSES.includes(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
    const limit = Math.max(1, Math.min(200, Number.parseInt(query.limit, 10) || 50));
    const cursor = query.cursor && policy.isUuid(query.cursor) ? query.cursor : null;
    const rows = await client.mailStorageDeletion.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const snapshot = await stats();
    return { counts: snapshot.byStatus, due: snapshot.due, oldestDueSeconds: snapshot.oldestDueSeconds, items: rows.slice(0, limit).map(serialize), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  function cleanReason(reason) {
    const value = String(reason || "").trim();
    if (value.length < 5 || value.length > 500) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason", reason: "REASON_REQUIRED" });
    return value;
  }

  async function load(id) {
    if (!policy.isUuid(id)) throw mailError("MAIL_NOT_FOUND", { resource: "storage_deletion" });
    const row = await client.mailStorageDeletion.findUnique({ where: { id } });
    if (!row) throw mailError("MAIL_NOT_FOUND", { resource: "storage_deletion" });
    return row;
  }

  // DEAD rows, and rows cancelled because of a legal hold (after release),
  // go back to PENDING with a fresh attempt budget.
  async function requeue(user, id, { stepUpId, reason } = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    const why = cleanReason(reason);
    const row = await load(id);
    const requeueable = row.status === "DEAD" || (row.status === "CANCELLED" && REQUEUEABLE_CANCELS.has(row.lastError));
    if (!requeueable) throw mailError("MAIL_INVALID_TRANSITION", { from: row.status, reason: "NOT_REQUEUEABLE" });
    const at = clock();
    try {
      await client.$transaction(async (tx) => {
        await stepUp.consume(tx, user, stepUpId, "MAIL_STORAGE_DELETION_REQUEUE", context);
        const changed = await tx.mailStorageDeletion.updateMany({ where: { id: row.id, status: row.status }, data: { status: "PENDING", attempts: 0, nextAttemptAt: at, leaseUntil: null, lastError: null, completedAt: null, requestedBy: user.id, updatedAt: at } });
        if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: row.status });
        await audit.record({ actorAdminUserId: user.id, action: "MAIL_STORAGE_DELETION_REQUEUED", targetType: "mail_storage_deletion", targetId: row.id, organizationId: row.organizationId, mailboxId: row.mailboxId, metadata: { keyHash: keyHash(row.objectKey), from: row.status, previousError: row.lastError, attempts: row.attempts, reason: why } }, context, tx);
      });
    } catch (error) {
      // Another open row already exists for this key.
      if (error?.code === "P2002") throw mailError("MAIL_INVALID_TRANSITION", { reason: "OPEN_DELETION_EXISTS" });
      throw error;
    }
    return serialize(await client.mailStorageDeletion.findUnique({ where: { id: row.id } }));
  }

  // Cancelling keeps the object; only PENDING rows (not one being executed),
  // never a DSAR / quarantine / retention mandated deletion, with a reason
  // and an MFA step-up (MAIL_STORAGE_DELETION_CANCEL).
  async function cancel(user, id, { stepUpId, reason } = {}, context = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    await requireReady();
    const why = cleanReason(reason);
    const row = await load(id);
    if (PROTECTED_PURPOSES.has(row.purpose)) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_STORAGE_DELETION_CANCEL_REFUSED", targetType: "mail_storage_deletion", targetId: row.id, organizationId: row.organizationId, mailboxId: row.mailboxId, outcome: "DENIED", metadata: { keyHash: keyHash(row.objectKey), purpose: row.purpose } }, context).catch(() => {});
      throw mailError("MAIL_INVALID_TRANSITION", { reason: "PROTECTED_DELETION", purpose: row.purpose }, "Deletions requested by a data-subject erasure, an IT quarantine decision or a retention purge cannot be cancelled.");
    }
    if (row.status !== "PENDING") throw mailError("MAIL_INVALID_TRANSITION", { from: row.status });
    const at = clock();
    await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_STORAGE_DELETION_CANCEL", context);
      const changed = await tx.mailStorageDeletion.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "CANCELLED", lastError: "CANCELLED_BY_ADMIN", completedAt: at, requestedBy: user.id, updatedAt: at } });
      if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: "RUNNING" });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_STORAGE_DELETION_CANCELLED", targetType: "mail_storage_deletion", targetId: row.id, organizationId: row.organizationId, mailboxId: row.mailboxId, metadata: { keyHash: keyHash(row.objectKey), purpose: row.purpose, reason: why } }, context, tx);
    });
    return serialize(await client.mailStorageDeletion.findUnique({ where: { id: row.id } }));
  }

  return { ready, enqueue, settle, dropAttachments, scopeHeld, processDue, hasDue, claim, stats, list, requeue, cancel, backoffSeconds, settings };
}

module.exports = { createStorageDeletionService, objectReferenced, keyHash, STATUSES, PROTECTED_PURPOSES };

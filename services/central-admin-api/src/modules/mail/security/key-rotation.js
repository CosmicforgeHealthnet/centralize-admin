"use strict";

// Re-encrypts Mail ciphertext under the active keyring version.
//
// Covered:
//   objects  - message bodies (mail_messages.content_object_key, mail-body) and
//              attachments (mail_attachments.storage_key, mail-attachment),
//              archived headers / raw MIME (mail_message_archives), all
//              de-duplicated because mailbox copies share stored objects.
//   columns  - mail_drafts.encrypted_body (mail-draft),
//              mail_messages.encrypted_snippet / mail_threads.encrypted_snippet
//              (mail-snippet), mail_internal_notes.encrypted_body
//              (mail-internal-note).
//
// Safety:
//   - dry-run by default (counts only);
//   - idempotent and resumable: rows/objects already on the active version are
//     skipped, work proceeds in id order with a cursor, and a re-run continues
//     where an interrupted run stopped;
//   - column updates are compare-and-set on the old ciphertext, so concurrent
//     writes are never overwritten;
//   - every run is recorded in the append-only Mail audit trail with counts
//     only (never key material, ciphertext or content).
// Rotation never needs the old key to be removed; keep it in the keyring
// until a completed --apply run reports zero remaining envelopes.

const COLUMNS = Object.freeze([
  { table: "mail_drafts", column: "encrypted_body", purpose: "mail-draft" },
  { table: "mail_messages", column: "encrypted_snippet", purpose: "mail-snippet" },
  { table: "mail_threads", column: "encrypted_snippet", purpose: "mail-snippet" },
  { table: "mail_internal_notes", column: "encrypted_body", purpose: "mail-internal-note" },
]);
const OBJECT_SOURCES = Object.freeze([
  { table: "mail_messages", column: "content_object_key", purpose: "mail-body" },
  { table: "mail_attachments", column: "storage_key", purpose: "mail-attachment" },
  // Archive objects (feature migration; skipped when the table is absent).
  { table: "mail_message_archives", column: "headers_object_key", purpose: "mail-archive-headers", optional: true },
  { table: "mail_message_archives", column: "raw_mime_object_key", purpose: "mail-raw-mime", optional: true },
]);

function emptyCounts() {
  return { scanned: 0, current: 0, rotated: 0, wouldRotate: 0, failed: 0, conflicts: 0 };
}

async function rotateMailEncryption({ client, storage, encryption, audit, dryRun = true, batchSize = 200, limit = Infinity, skipObjects = false, operator = null, logger = console }) {
  if (!encryption?.available) throw Object.assign(new Error("Mail keyring is not available"), { code: "MAIL_STORAGE_UNAVAILABLE" });
  const active = encryption.activeVersion;
  const summary = { dryRun, activeVersion: active, columns: {}, objects: {}, byVersion: {}, remaining: 0, stoppedAtLimit: false };
  let budget = limit;
  const note = (version) => {
    summary.byVersion[version || "unknown"] = (summary.byVersion[version || "unknown"] || 0) + 1;
  };

  await audit?.record({ actorAdminUserId: operator, action: dryRun ? "MAIL_KEY_ROTATION_DRY_RUN_STARTED" : "MAIL_KEY_ROTATION_STARTED", targetType: "keyring", targetId: active, metadata: { activeVersion: active, skipObjects } });

  for (const source of COLUMNS) {
    const counts = emptyCounts();
    summary.columns[`${source.table}.${source.column}`] = counts;
    let cursor = "";
    for (;;) {
      const rows = await client.$queryRawUnsafe(`SELECT id::text AS id, "${source.column}" AS value FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND id::text > $1 ORDER BY id::text ASC LIMIT ${Number(batchSize)}`, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.id;
        counts.scanned += 1;
        const envelope = Buffer.from(row.value);
        const version = encryption.envelopeKeyVersion(envelope);
        note(version);
        if (version === active) {
          counts.current += 1;
          continue;
        }
        if (dryRun) {
          counts.wouldRotate += 1;
          continue;
        }
        if (budget <= 0) {
          summary.stoppedAtLimit = true;
          continue;
        }
        let rewrapped;
        try {
          rewrapped = encryption.encrypt(encryption.decrypt(envelope, source.purpose), source.purpose);
        } catch {
          counts.failed += 1;
          continue;
        }
        const changed = await client.$executeRawUnsafe(`UPDATE "${source.table}" SET "${source.column}" = $1 WHERE id::text = $2 AND "${source.column}" = $3`, rewrapped, row.id, envelope);
        if (changed === 1) {
          counts.rotated += 1;
          budget -= 1;
        } else counts.conflicts += 1;
      }
    }
  }

  if (!skipObjects) {
    for (const source of OBJECT_SOURCES) {
      if (source.optional) {
        const [present] = await client.$queryRawUnsafe(`SELECT to_regclass($1)::text AS name`, `public.${source.table}`);
        if (!present?.name) continue;
      }
      const counts = emptyCounts();
      summary.objects[`${source.table}.${source.column}`] = counts;
      let cursor = "";
      for (;;) {
        const rows = await client.$queryRawUnsafe(`SELECT DISTINCT "${source.column}" AS key FROM "${source.table}" WHERE "${source.column}" IS NOT NULL AND "${source.column}" > $1 ORDER BY "${source.column}" ASC LIMIT ${Number(batchSize)}`, cursor);
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.key;
          counts.scanned += 1;
          let version;
          try {
            version = await storage.keyVersionOf(row.key);
          } catch {
            counts.failed += 1;
            continue;
          }
          note(version);
          if (version === active) {
            counts.current += 1;
            continue;
          }
          if (dryRun) {
            counts.wouldRotate += 1;
            continue;
          }
          if (budget <= 0) {
            summary.stoppedAtLimit = true;
            continue;
          }
          try {
            const result = await storage.reencrypt(row.key, { purpose: source.purpose });
            if (result.changed) {
              counts.rotated += 1;
              budget -= 1;
            } else counts.current += 1;
          } catch {
            counts.failed += 1;
          }
        }
      }
    }
  }

  const all = [...Object.values(summary.columns), ...Object.values(summary.objects)];
  summary.remaining = all.reduce((sum, counts) => sum + (dryRun ? counts.wouldRotate : counts.scanned - counts.current - counts.rotated), 0);
  summary.failed = all.reduce((sum, counts) => sum + counts.failed, 0);
  await audit?.record({
    actorAdminUserId: operator,
    action: dryRun ? "MAIL_KEY_ROTATION_DRY_RUN_COMPLETED" : "MAIL_KEY_ROTATION_COMPLETED",
    targetType: "keyring",
    targetId: active,
    outcome: summary.failed ? "PARTIAL" : "SUCCESS",
    metadata: { activeVersion: active, remaining: summary.remaining, failed: summary.failed, byVersion: summary.byVersion, stoppedAtLimit: summary.stoppedAtLimit },
  });
  logger.info?.(`[MailKeyRotation] ${dryRun ? "dry-run" : "apply"} active=${active} remaining=${summary.remaining} failed=${summary.failed}`);
  return summary;
}

module.exports = { rotateMailEncryption, COLUMNS, OBJECT_SOURCES };

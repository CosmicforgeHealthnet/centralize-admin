"use strict";

// GDPR data subject requests (spec §12 Retention: DSAR access/deletion) for
// one external email address inside one organization.
//
// Safety model:
// - Mail administrators only (EDIT), with a fresh MFA step-up per call:
//   MAIL_DSAR_EXPORT for access exports, MAIL_DSAR_ERASURE for erasure (dry
//   run and execution alike). A reason / ticket reference is required.
// - Scope is the organization's mailboxes only; other organizations are never
//   read or changed.
// - Access export: message metadata (no bodies), with BCC entries limited to
//   the data subject's own; plus the organization's marketing contact,
//   consent and suppression rows for the address, and (migration 37) its
//   provider subscription states and provider re-subscription requests.
// - Erasure is a dry run unless dryRun === false. For each matching message
//   it removes the content objects (body, raw MIME, archived headers,
//   attachments, search terms), blanks the subject/snippet/search text and
//   redacts the address in sender/recipient fields and thread participants.
//   Messages under a legal hold are skipped and reported by id. Addresses of
//   our own staff mailboxes are refused (that is offboarding, not DSAR).
//   Marketing consent/suppression evidence is kept (suppression must persist
//   to honour the objection).
// - Every call is audited with counts and a SHA-256 of the address only.
// - Gap 5 (migration 37): the content objects of each erased message are
//   enqueued for durable deletion (mail_storage_deletions) in the same
//   transaction that erases the message, then deleted right after commit;
//   objects whose deletion fails are retried by the deletion worker. Before
//   migration 37 they are removed inline, best effort, as before.

const crypto = require("crypto");
const policy = require("../authz/mail.policy");
const { mailError } = require("../mail.errors");
const { normalizeAddress } = require("../security/address.util");
const { objectReferenced } = require("../ops/storage-deletion.service");

const REDACTED_ADDRESS = "redacted@dsar.invalid";
const MAX_MESSAGES = 5000;

function subjectHash(email) {
  return crypto.createHash("sha256").update(email).digest("hex");
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function createDsarService({ client, audit, stepUp, storage, features = null, finalGap = null, deletions = null, clock = () => new Date() }) {
  async function validate(user, { organizationId, email, reason } = {}) {
    await policy.requireMailAdmin(client, user, "EDIT");
    if (!policy.isUuid(organizationId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    const address = normalizeAddress(email);
    if (!address) throw mailError("MAIL_VALIDATION_FAILED", { field: "email" });
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 5 || cleanReason.length > 500) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason", reason: "REASON_OR_TICKET_REQUIRED" });
    const organization = await client.mailOrganization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) throw mailError("MAIL_NOT_FOUND", { resource: "organization" });
    return { organizationId, address, reason: cleanReason };
  }

  // Messages in the organization where the address is sender or any recipient.
  async function matchingMessages(organizationId, address) {
    return client.mailMessage.findMany({
      where: {
        mailbox: { organizationId },
        OR: [{ fromAddress: address }, { replyTo: address }, { envelopeRecipient: address }, { recipients: { some: { address } } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_MESSAGES + 1,
      include: { recipients: true, attachments: { select: { id: true, filename: true, sizeBytes: true, storageKey: true } }, mailbox: { select: { id: true, name: true } } },
    });
  }

  async function exportSubject(user, input = {}, context = {}) {
    const { organizationId, address, reason } = await validate(user, input);
    await client.$transaction(async (tx) => stepUp.consume(tx, user, input.stepUpId, "MAIL_DSAR_EXPORT", context));
    const rows = await matchingMessages(organizationId, address);
    const truncated = rows.length > MAX_MESSAGES;
    const messages = rows.slice(0, MAX_MESSAGES).map((message) => {
      const party = (type) => message.recipients.filter((recipient) => recipient.type === type).map((recipient) => ({ address: recipient.address, name: recipient.name }));
      return {
        id: message.id,
        date: iso(message.sentAt || message.receivedAt || message.createdAt),
        direction: message.direction,
        mailbox: message.mailbox.name,
        subject: message.subject,
        from: { address: message.fromAddress, name: message.fromName },
        to: party("TO"),
        cc: party("CC"),
        // Other people's BCC entries are never disclosed.
        bcc: party("BCC").filter((recipient) => recipient.address === address),
        attachments: message.attachments.map((attachment) => ({ filename: attachment.filename, sizeBytes: attachment.sizeBytes })),
      };
    });
    let marketing = null;
    try {
      const contacts = await client.marketingContact.findMany({ where: { organizationId, email: address }, include: { consents: true } });
      const suppressions = await client.marketingSuppression.findMany({ where: { email: address, OR: [{ organizationId }, { organizationId: null }] } });
      marketing = {
        contacts: contacts.map((contact) => ({
          id: contact.id, email: contact.email, firstName: contact.firstName, lastName: contact.lastName, status: contact.status, source: contact.source, attributes: contact.attributes ?? null, createdAt: iso(contact.createdAt), updatedAt: iso(contact.updatedAt),
          consents: contact.consents.map((consent) => ({ topic: consent.topic, status: consent.status, source: consent.source, policyVersion: consent.policyVersion, doubleOptIn: consent.doubleOptIn, consentedAt: iso(consent.consentedAt), confirmedAt: iso(consent.confirmedAt), withdrawnAt: iso(consent.withdrawnAt), withdrawalSource: consent.withdrawalSource })),
        })),
        suppressions: suppressions.map((row) => ({ reason: row.reason, source: row.source, scope: row.organizationId ? "ORGANIZATION" : "GLOBAL", createdAt: iso(row.createdAt), liftedAt: iso(row.liftedAt) })),
      };
    } catch {
      marketing = null; // marketing tables not migrated in this environment
    }
    // Re-audit (migration 37): what the provider reported about the address
    // and the provider re-subscription requests, for this organization's
    // contacts only (never another brand's). null before migration 37.
    if (marketing) {
      let ready = false;
      try {
        ready = Boolean(finalGap && (await finalGap.isReady()));
      } catch {
        ready = false;
      }
      marketing.providerStates = null;
      marketing.providerResubscriptions = null;
      if (ready) {
        try {
          const contactIds = marketing.contacts.map((contact) => contact.id);
          const [states, resubscriptions] = contactIds.length
            ? await Promise.all([
              client.marketingContactProviderState.findMany({ where: { organizationId, contactId: { in: contactIds } } }),
              client.marketingProviderResubscription.findMany({ where: { organizationId, contactId: { in: contactIds } }, orderBy: { createdAt: "asc" } }),
            ])
            : [[], []];
          marketing.providerStates = states.map((row) => ({ contactId: row.contactId, provider: row.provider, state: row.state, reason: row.reason, observedAt: iso(row.observedAt) }));
          marketing.providerResubscriptions = resubscriptions.map((row) => {
            const evidence = row.consentEvidence && typeof row.consentEvidence === "object" ? row.consentEvidence : {};
            return { id: row.id, contactId: row.contactId, topic: row.topic, status: row.status, attempts: row.attempts, lastError: row.lastError, consentEvidence: { topic: evidence.topic || row.topic, source: evidence.source || null, policyVersion: evidence.policyVersion || null, doubleOptIn: Boolean(evidence.doubleOptIn), consentedAt: evidence.consentedAt || null, confirmedAt: evidence.confirmedAt || null, providerState: evidence.providerState || null }, createdAt: iso(row.createdAt), completedAt: iso(row.completedAt) };
          });
        } catch {
          marketing.providerStates = null;
          marketing.providerResubscriptions = null;
        }
      }
    }
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DSAR_EXPORTED", targetType: "dsar_subject", targetId: subjectHash(address).slice(0, 64), organizationId, metadata: { reference: reason, messages: messages.length, truncated, marketingContacts: marketing?.contacts.length ?? null } }, context);
    return { organizationId, email: address, generatedAt: clock().toISOString(), truncated, messages, marketing };
  }

  async function heldMailboxes(organizationId) {
    const holds = await client.mailLegalHold.findMany({ where: { organizationId, releasedAt: null } });
    const orgWide = holds.some((hold) => !hold.mailboxId && !hold.subjectAdminUserId);
    const mailboxes = new Set(holds.filter((hold) => hold.mailboxId).map((hold) => hold.mailboxId));
    const subjects = [...new Set(holds.filter((hold) => !hold.mailboxId && hold.subjectAdminUserId).map((hold) => hold.subjectAdminUserId))];
    if (subjects.length) {
      const owned = await client.mailMailbox.findMany({ where: { ownerAdminUserId: { in: subjects } }, select: { id: true } });
      for (const row of owned) mailboxes.add(row.id);
    }
    return { orgWide, mailboxes, subjects };
  }

  async function messageHeld(message, holds) {
    if (holds.orgWide || holds.mailboxes.has(message.mailboxId)) return true;
    if (!holds.subjects.length) return false;
    return (await client.mailMessage.count({ where: { threadId: message.threadId, sentByAdminUserId: { in: holds.subjects } } })) > 0;
  }

  async function stillReferenced(key) {
    return objectReferenced(client, key, { archivesReady: Boolean(features && (await features.isReady())) });
  }

  async function eraseMessage(tx, message, address) {
    let archiveKeys = [];
    if (features && (await features.isReady())) {
      const archive = await tx.mailMessageArchive.findUnique({ where: { messageId: message.id }, select: { headersObjectKey: true, rawMimeObjectKey: true } });
      if (archive) archiveKeys = [archive.headersObjectKey, archive.rawMimeObjectKey];
      await tx.mailMessageArchive.deleteMany({ where: { messageId: message.id } });
      await tx.mailMessageSearchIndex.deleteMany({ where: { messageId: message.id } });
    }
    if (deletions) await deletions.dropAttachments(tx, { messageId: message.id });
    else await tx.mailAttachment.deleteMany({ where: { messageId: message.id } });
    await tx.mailMessageRecipient.updateMany({ where: { messageId: message.id, address }, data: { address: REDACTED_ADDRESS, name: null } });
    await tx.mailDeliveryEvent.updateMany({ where: { messageId: message.id, recipient: address }, data: { recipient: null } });
    const fromSubject = message.fromAddress === address;
    await tx.mailMessage.update({
      where: { id: message.id },
      data: {
        subject: "",
        encryptedSnippet: null,
        metadataSearchText: "",
        contentObjectKey: null,
        rawMimeObjectKey: null,
        hasAttachments: false,
        ...(fromSubject ? { fromAddress: REDACTED_ADDRESS, fromName: null } : {}),
        ...(message.replyTo === address ? { replyTo: null } : {}),
        ...(message.envelopeRecipient === address ? { envelopeRecipient: null } : {}),
      },
    });
    const thread = await tx.mailThread.findUnique({ where: { id: message.threadId }, select: { id: true, participants: true } });
    const participants = Array.isArray(thread.participants) ? thread.participants.filter((party) => party?.address !== address) : thread.participants;
    await tx.mailThread.update({ where: { id: thread.id }, data: { participants, encryptedSnippet: null } });
    return [message.contentObjectKey, message.rawMimeObjectKey, ...message.attachments.map((attachment) => attachment.storageKey), ...archiveKeys].filter(Boolean);
  }

  async function eraseSubject(user, input = {}, context = {}) {
    const { organizationId, address, reason } = await validate(user, input);
    const dryRun = input.dryRun !== false;
    await client.$transaction(async (tx) => stepUp.consume(tx, user, input.stepUpId, "MAIL_DSAR_ERASURE", context));
    // Our own staff/shared addresses are not external correspondents.
    const internal = await client.mailAddress.findFirst({ where: { address }, select: { id: true } });
    const ownDomain = await client.mailDomain.findFirst({ where: { domain: address.split("@")[1] }, select: { id: true } });
    if (internal || ownDomain) throw mailError("MAIL_VALIDATION_FAILED", { field: "email", reason: "SUBJECT_IS_INTERNAL" });

    const holds = await heldMailboxes(organizationId);
    const rows = await matchingMessages(organizationId, address);
    const messages = rows.slice(0, MAX_MESSAGES);
    const skippedHeld = [];
    const erasable = [];
    for (const message of messages) {
      if (await messageHeld(message, holds)) skippedHeld.push({ messageId: message.id, mailboxId: message.mailboxId });
      else erasable.push(message);
    }
    const result = { organizationId, dryRun, candidates: messages.length, erasable: erasable.length, erased: 0, skippedHeld, truncated: rows.length > MAX_MESSAGES, objectsRemoved: 0, objectsKeptShared: 0, objectRemoveFailed: 0 };
    if (!dryRun && deletions) {
      const plans = [];
      for (const message of erasable) {
        plans.push(await client.$transaction(async (tx) => {
          const removed = await eraseMessage(tx, message, address);
          return deletions.enqueue(tx, removed, { purpose: "DSAR", reason: "DSAR_ERASURE", sourceType: "message", sourceId: message.id, organizationId, mailboxId: message.mailboxId, requestedBy: user.id });
        }));
        result.erased += 1;
      }
      for (const plan of plans) {
        const settled = await deletions.settle(plan);
        result.objectsRemoved += settled.removed;
        result.objectsKeptShared += settled.shared + settled.held;
        result.objectRemoveFailed += settled.failed;
      }
    } else if (!dryRun) {
      const keys = new Set();
      for (const message of erasable) {
        const removed = await client.$transaction(async (tx) => eraseMessage(tx, message, address));
        for (const key of removed) keys.add(key);
        result.erased += 1;
      }
      for (const key of keys) {
        if (await stillReferenced(key)) {
          result.objectsKeptShared += 1;
          continue;
        }
        try {
          await storage.remove(key);
          result.objectsRemoved += 1;
        } catch {
          result.objectRemoveFailed += 1;
        }
      }
    }
    await audit.record({
      actorAdminUserId: user.id,
      action: dryRun ? "MAIL_DSAR_ERASURE_DRY_RUN" : "MAIL_DSAR_ERASURE_EXECUTED",
      targetType: "dsar_subject",
      targetId: subjectHash(address).slice(0, 64),
      organizationId,
      metadata: { reference: reason, candidates: result.candidates, erasable: result.erasable, erased: result.erased, skippedHeld: skippedHeld.length, truncated: result.truncated, objectsRemoved: result.objectsRemoved, objectRemoveFailed: result.objectRemoveFailed },
    }, context);
    return result;
  }

  return { exportSubject, eraseSubject };
}

module.exports = { createDsarService, REDACTED_ADDRESS };

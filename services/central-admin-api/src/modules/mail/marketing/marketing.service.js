"use strict";

// Marketing Email Studio (M6): brand-scoped contacts, consent evidence,
// suppression, audiences, segments, versioned templates and the campaign
// DRAFT -> READY_FOR_REVIEW -> APPROVED lifecycle with immutable snapshots.
// There is deliberately no dispatch: live sending is a separately authorised
// M7 capability. Product customer databases are never imported.

const crypto = require("crypto");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { normalizeAddress } = require("../security/address.util");
const { renderTemplate, TemplateError } = require("./template-renderer");
const { scanLinks } = require("./link-scan");
const { isRestrictedHealthOrganization } = require("../authz/sending-gate");
const { parseCsv, neutralizeCell, isFormula } = require("./csv");
const { iso, decodeCursor, encodeCursor, pageLimit } = require("../services/serializers");

const CONSENT_SOURCES = new Set(["WEB_FORM", "IMPORT", "MANUAL", "API", "EVENT"]);
const TOPIC = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const POLICY_VERSION = /^[A-Za-z0-9._-]{1,32}$/;
const MATERIAL_FIELDS = ["name", "topic", "senderAddressId", "replyTo", "subjectOverride", "templateVersionId", "audienceId", "segmentId", "frequencyCapHours"];
const SEGMENT_FIELD_ALIASES = { email: "email", email_domain: "email_domain", first_name: "firstName", firstName: "firstName", last_name: "lastName", lastName: "lastName", created_at: "createdAt", createdAt: "createdAt" };
const SEGMENT_OPS = new Set(["equals", "not_equals", "contains", "ends_with", "in", "before", "after", "exists"]);
const MAX_SEGMENT_CONTACTS = 50000;

function cleanName(value, max = 120) {
  if (value == null || value === "") return null;
  if (isFormula(value)) throw mailError("MAIL_VALIDATION_FAILED", { reason: "FORMULA_NOT_ALLOWED" });
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max) || null;
}

function cleanAttributes(attributes) {
  if (attributes == null) return null;
  if (typeof attributes !== "object" || Array.isArray(attributes)) throw mailError("MAIL_VALIDATION_FAILED", { field: "attributes" });
  const output = {};
  for (const [key, value] of Object.entries(attributes).slice(0, 30)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value)) output[key] = typeof value === "string" ? neutralizeCell(value).slice(0, 500) : value;
  }
  return output;
}

function validateConsentInput(consent) {
  if (!consent || typeof consent !== "object") throw mailError("MAIL_CONSENT_REQUIRED", { field: "consent" });
  const topic = String(consent.topic || "").trim().toLowerCase();
  if (!TOPIC.test(topic)) throw mailError("MAIL_VALIDATION_FAILED", { field: "consent.topic" });
  if (!CONSENT_SOURCES.has(consent.source)) throw mailError("MAIL_VALIDATION_FAILED", { field: "consent.source" });
  if (!POLICY_VERSION.test(String(consent.policyVersion || ""))) throw mailError("MAIL_VALIDATION_FAILED", { field: "consent.policyVersion" });
  const evidence = consent.evidence;
  const reference = typeof evidence === "string" ? evidence : evidence?.reference;
  if (!reference || String(reference).trim().length < 3) throw mailError("MAIL_CONSENT_REQUIRED", { field: "consent.evidence" });
  // Spec §13.4: record the jurisdiction the consent was captured in when known.
  const country = consent.country ?? evidence?.country ?? null;
  if (country != null && country !== "" && !/^[A-Z]{2}$/.test(String(country).toUpperCase())) throw mailError("MAIL_VALIDATION_FAILED", { field: "consent.country" });
  const consentedAt = consent.consentedAt ? new Date(consent.consentedAt) : null;
  if (consentedAt && (Number.isNaN(consentedAt.getTime()) || consentedAt > new Date())) throw mailError("MAIL_VALIDATION_FAILED", { field: "consent.consentedAt" });
  return {
    topic,
    source: consent.source,
    policyVersion: String(consent.policyVersion),
    doubleOptIn: Boolean(consent.doubleOptIn),
    evidence: {
      reference: String(reference).slice(0, 500),
      ipAddress: evidence?.ipAddress ? String(evidence.ipAddress).slice(0, 64) : null,
      formUrl: evidence?.formUrl ? String(evidence.formUrl).slice(0, 500) : null,
      capturedText: evidence?.capturedText ? String(evidence.capturedText).slice(0, 1000) : null,
      country: country ? String(country).toUpperCase() : null,
    },
    consentedAt,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Durable trigger for consent-backed welcome automations (M7). Idempotent per
// consent grant; the automation engine re-checks consent before every send.
async function recordConsentGranted(tx, { organizationId, contactId, consent, at }) {
  const occurredAt = at || consent.confirmedAt || consent.consentedAt || new Date();
  await tx.marketingTriggerEvent.createMany({
    data: [{ organizationId, source: "CONSENT", eventType: "consent.granted", eventId: `${consent.id}:${occurredAt.getTime()}`, contactId, payload: { topic: consent.topic, policyVersion: consent.policyVersion }, occurredAt }],
    skipDuplicates: true,
  });
}

function createMarketingService({ client, config, audit, stepUp, clock = () => new Date(), hooks = {} }) {
  const scope = (user, organizationId, need) => {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    return policy.requireMarketingScope(client, user, organizationId, need);
  };

  async function organizations(user) {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    return policy.marketingScopes(client, user);
  }

  // ------------------------------------------------------------- contacts
  function serializeContact(contact) {
    return {
      id: contact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      attributes: contact.attributes || {},
      status: contact.status,
      source: contact.source,
      consents: (contact.consents || []).map((consent) => ({ topic: consent.topic, status: consent.status, source: consent.source, policyVersion: consent.policyVersion, doubleOptIn: consent.doubleOptIn, consentedAt: iso(consent.consentedAt), confirmedAt: iso(consent.confirmedAt), withdrawnAt: iso(consent.withdrawnAt) })),
      createdAt: iso(contact.createdAt),
      updatedAt: iso(contact.updatedAt),
    };
  }

  async function upsertConsentTx(tx, user, organizationId, contact, consent) {
    const now = clock();
    let token = null;
    let tokenHash = null;
    if (consent.doubleOptIn) {
      token = crypto.randomBytes(24).toString("base64url");
      tokenHash = hashToken(token);
    }
    const data = {
      organizationId,
      status: consent.doubleOptIn ? "PENDING_CONFIRMATION" : "GRANTED",
      source: consent.source,
      sourceEvidence: consent.evidence,
      policyVersion: consent.policyVersion,
      doubleOptIn: consent.doubleOptIn,
      confirmationTokenHash: tokenHash,
      consentedAt: consent.consentedAt || now,
      confirmedAt: null,
      withdrawnAt: null,
      withdrawalSource: null,
      createdBy: user.id,
    };
    const row = await tx.marketingConsent.upsert({
      where: { contactId_topic: { contactId: contact.id, topic: consent.topic } },
      create: { contactId: contact.id, topic: consent.topic, ...data },
      update: data,
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONSENT_RECORDED", targetType: "marketing_contact", targetId: contact.id, organizationId, metadata: { topic: consent.topic, status: row.status, source: consent.source, policyVersion: consent.policyVersion } }, {}, tx);
    if (row.status === "GRANTED") await recordConsentGranted(tx, { organizationId, contactId: contact.id, consent: row, at: now });
    // Double opt-in: the confirmation email is a durable job (never sent inline).
    let confirmationEmail = null;
    if (row.status === "PENDING_CONFIRMATION" && token && hooks.onConfirmationRequired) confirmationEmail = await hooks.onConfirmationRequired(tx, { organizationId, contact, consent: row, token });
    // The token belongs to the contact. It is only echoed to the API caller in
    // non-production environments without confirmation emails (manual testing);
    // otherwise an admin could confirm on the contact's behalf.
    const exposeToken = !config.confirmationEmailsEnabled && config.deploymentEnvironment !== "production";
    return { consent: row, confirmationToken: exposeToken ? token : null, confirmationEmail };
  }

  async function createContact(user, organizationId, input, context) {
    await scope(user, organizationId, "EDIT");
    const email = normalizeAddress(input.email);
    if (!email) throw mailError("MAIL_VALIDATION_FAILED", { field: "email" });
    const consent = input.consent ? validateConsentInput(input.consent) : null;
    return client.$transaction(async (tx) => {
      const existing = await tx.marketingContact.findUnique({ where: { organizationId_email: { organizationId, email } } });
      if (existing) throw mailError("MAIL_VALIDATION_FAILED", { field: "email", reason: "DUPLICATE_CONTACT", contactId: existing.id });
      const contact = await tx.marketingContact.create({ data: { organizationId, email, firstName: cleanName(input.firstName), lastName: cleanName(input.lastName), attributes: cleanAttributes(input.attributes) || undefined, source: consent ? consent.source.toLowerCase() : "manual", createdBy: user.id } });
      let confirmationToken = null;
      let confirmationEmail = null;
      if (consent) ({ confirmationToken, confirmationEmail } = await upsertConsentTx(tx, user, organizationId, contact, consent));
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONTACT_CREATED", targetType: "marketing_contact", targetId: contact.id, organizationId }, context, tx);
      const full = await tx.marketingContact.findUnique({ where: { id: contact.id }, include: { consents: true } });
      return { ...serializeContact(full), confirmationToken, confirmationEmail };
    });
  }

  async function listContacts(user, organizationId, { q, status, audienceId, cursor, limit } = {}) {
    await scope(user, organizationId, "VIEW");
    const take = pageLimit(limit, 50, 200);
    const position = decodeCursor(cursor);
    const where = {
      organizationId,
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ email: { contains: String(q).toLowerCase().slice(0, 120) } }, { firstName: { contains: String(q).slice(0, 120), mode: "insensitive" } }, { lastName: { contains: String(q).slice(0, 120), mode: "insensitive" } }] } : {}),
      ...(audienceId && policy.isUuid(audienceId) ? { audiences: { some: { audienceId } } } : {}),
      ...(position ? { OR: undefined, AND: [{ OR: [{ createdAt: { lt: position.at } }, { createdAt: position.at, id: { lt: position.id } }] }] } : {}),
    };
    const rows = await client.marketingContact.findMany({ where, include: { consents: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1 });
    const page = rows.slice(0, take);
    return { items: page.map(serializeContact), nextCursor: rows.length > take ? encodeCursor({ createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null };
  }

  async function loadContact(organizationId, contactId) {
    const contact = policy.isUuid(contactId) ? await client.marketingContact.findUnique({ where: { id: contactId }, include: { consents: true } }) : null;
    // Brand isolation: a contact of another brand is indistinguishable from missing.
    if (!contact || contact.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "contact" });
    return contact;
  }

  async function getContact(user, organizationId, contactId) {
    await scope(user, organizationId, "VIEW");
    return serializeContact(await loadContact(organizationId, contactId));
  }

  async function updateContact(user, organizationId, contactId, input, context) {
    await scope(user, organizationId, "EDIT");
    await loadContact(organizationId, contactId);
    const data = {};
    if (input.firstName !== undefined) data.firstName = cleanName(input.firstName);
    if (input.lastName !== undefined) data.lastName = cleanName(input.lastName);
    if (input.attributes !== undefined) data.attributes = cleanAttributes(input.attributes);
    const row = await client.marketingContact.update({ where: { id: contactId }, data, include: { consents: true } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONTACT_UPDATED", targetType: "marketing_contact", targetId: contactId, organizationId, metadata: { fields: Object.keys(data) } }, context);
    return serializeContact(row);
  }

  async function recordConsent(user, organizationId, contactId, input, context) {
    await scope(user, organizationId, "EDIT");
    const contact = await loadContact(organizationId, contactId);
    const consent = validateConsentInput(input);
    const result = await client.$transaction((tx) => upsertConsentTx(tx, user, organizationId, contact, consent));
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONSENT_UPDATED", targetType: "marketing_contact", targetId: contactId, organizationId }, context);
    return { topic: result.consent.topic, status: result.consent.status, confirmationToken: result.confirmationToken, confirmationEmail: result.confirmationEmail };
  }

  async function withdrawConsent(user, organizationId, contactId, topic, { source } = {}, context) {
    await scope(user, organizationId, "EDIT");
    await loadContact(organizationId, contactId);
    const result = await client.marketingConsent.updateMany({ where: { contactId, topic: String(topic), status: { not: "WITHDRAWN" } }, data: { status: "WITHDRAWN", withdrawnAt: clock(), withdrawalSource: String(source || "admin").slice(0, 64), confirmationTokenHash: null } });
    if (!result.count) throw mailError("MAIL_NOT_FOUND", { resource: "consent" });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONSENT_WITHDRAWN", targetType: "marketing_contact", targetId: contactId, organizationId, metadata: { topic } }, context);
    return { withdrawn: true };
  }

  // Double opt-in confirmation by token (public route, token stored hashed).
  async function confirmConsent(token) {
    if (!config.marketingEnabled) throw mailError("MAIL_MARKETING_DISABLED");
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) throw mailError("MAIL_NOT_FOUND", { resource: "consent" });
    const consent = await client.marketingConsent.findFirst({ where: { confirmationTokenHash: hashToken(token), status: "PENDING_CONFIRMATION" } });
    if (!consent) throw mailError("MAIL_NOT_FOUND", { resource: "consent" });
    await client.$transaction(async (tx) => {
      const confirmedAt = clock();
      const updated = await tx.marketingConsent.updateMany({ where: { id: consent.id, status: "PENDING_CONFIRMATION" }, data: { status: "GRANTED", confirmedAt, confirmationTokenHash: null } });
      if (updated.count !== 1) throw mailError("MAIL_NOT_FOUND", { resource: "consent" });
      await recordConsentGranted(tx, { organizationId: consent.organizationId, contactId: consent.contactId, consent: { ...consent, confirmedAt }, at: confirmedAt });
      await audit.record({ action: "MARKETING_CONSENT_CONFIRMED", targetType: "marketing_contact", targetId: consent.contactId, organizationId: consent.organizationId, metadata: { topic: consent.topic } }, {}, tx);
    });
    return { confirmed: true };
  }

  async function importCsv(user, organizationId, { buffer, topic, source, policyVersion, evidenceReference, audienceId, attestOptIn, country }, context) {
    await scope(user, organizationId, "EDIT");
    if (!buffer || buffer.length > 2 * 1024 * 1024) throw mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: "MAX_2MB" });
    // Purchased, scraped or unverifiable lists are not eligible: every import
    // must carry an evidence reference and an explicit opt-in attestation.
    if (String(attestOptIn) !== "true") throw mailError("MAIL_CONSENT_REQUIRED", { field: "attestOptIn" });
    if (!["WEB_FORM", "EVENT", "IMPORT"].includes(source)) throw mailError("MAIL_VALIDATION_FAILED", { field: "source" });
    const baseConsent = validateConsentInput({ topic, source, policyVersion, evidence: evidenceReference, country });
    let audience = null;
    if (audienceId) {
      audience = policy.isUuid(audienceId) ? await client.marketingAudience.findUnique({ where: { id: audienceId } }) : null;
      if (!audience || audience.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "audience" });
    }
    let rows;
    try {
      rows = parseCsv(buffer.toString("utf8"), { maxRows: config.limits.csvImportMaxRows });
    } catch (error) {
      throw mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: error.message });
    }
    if (rows.length < 2) throw mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: "NO_ROWS" });
    const header = rows[0].map((column) => column.trim().toLowerCase().replace(/\s+/g, "_"));
    const column = (name) => header.indexOf(name);
    const emailIndex = column("email");
    if (emailIndex === -1) throw mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: "EMAIL_COLUMN_REQUIRED" });
    const report = { total: rows.length - 1, created: 0, updated: 0, skipped: 0, rejected: 0, rows: [] };
    const seen = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index];
      const line = index + 1;
      const email = normalizeAddress(cells[emailIndex]);
      const push = (status, reason) => {
        if (status === "SKIPPED" && reason !== "DUPLICATE_IN_FILE") report.rejected += 1;
        if (report.rows.length < 500) report.rows.push({ row: line, line, email: email || String(cells[emailIndex] || "").slice(0, 80), status: status === "SKIPPED" && reason !== "DUPLICATE_IN_FILE" ? "REJECTED" : status, reason });
      };
      if (!email) { report.skipped += 1; push("SKIPPED", "INVALID_EMAIL"); continue; }
      if (seen.has(email)) { report.skipped += 1; push("SKIPPED", "DUPLICATE_IN_FILE"); continue; }
      seen.add(email);
      const firstName = column("first_name") >= 0 ? cells[column("first_name")] : null;
      const lastName = column("last_name") >= 0 ? cells[column("last_name")] : null;
      if (isFormula(firstName) || isFormula(lastName)) { report.skipped += 1; push("SKIPPED", "FORMULA_NOT_ALLOWED"); continue; }
      const consentedAtRaw = column("consented_at") >= 0 ? cells[column("consented_at")] : null;
      const consentedAt = consentedAtRaw ? new Date(consentedAtRaw) : null;
      if (consentedAtRaw && (Number.isNaN(consentedAt.getTime()) || consentedAt > clock())) { report.skipped += 1; push("SKIPPED", "INVALID_CONSENT_TIMESTAMP"); continue; }
      const suppressed = await client.marketingSuppression.findFirst({ where: { email, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] } });
      try {
        const outcome = await client.$transaction(async (tx) => {
          const existing = await tx.marketingContact.findUnique({ where: { organizationId_email: { organizationId, email } } });
          const contact = existing || (await tx.marketingContact.create({ data: { organizationId, email, firstName: cleanName(firstName), lastName: cleanName(lastName), source: "import", createdBy: user.id } }));
          const priorConsent = existing ? await tx.marketingConsent.findUnique({ where: { contactId_topic: { contactId: contact.id, topic: baseConsent.topic } } }) : null;
          // A withdrawn consent is never silently re-granted by an import.
          if (priorConsent?.status === "WITHDRAWN") return { status: "SKIPPED", reason: "CONSENT_PREVIOUSLY_WITHDRAWN", contact };
          if (!priorConsent || priorConsent.status !== "GRANTED") await upsertConsentTx(tx, user, organizationId, contact, { ...baseConsent, consentedAt, evidence: { ...baseConsent.evidence, importLine: line } });
          if (audience) await tx.marketingAudienceContact.upsert({ where: { audienceId_contactId: { audienceId: audience.id, contactId: contact.id } }, create: { audienceId: audience.id, contactId: contact.id, addedBy: user.id }, update: {} });
          return { status: existing ? "UPDATED" : "CREATED", contact };
        });
        if (outcome.status === "SKIPPED") { report.skipped += 1; push("SKIPPED", outcome.reason); continue; }
        report[outcome.status === "CREATED" ? "created" : "updated"] += 1;
        push(outcome.status, suppressed ? "SUPPRESSED_WILL_BE_EXCLUDED" : null);
      } catch (error) {
        report.skipped += 1;
        push("SKIPPED", error.code === "MAIL_VALIDATION_FAILED" ? "INVALID_VALUE" : "ERROR");
      }
    }
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CONTACTS_IMPORTED", targetType: "organization", targetId: organizationId, organizationId, metadata: { total: report.total, created: report.created, updated: report.updated, skipped: report.skipped, topic: baseConsent.topic, evidence: baseConsent.evidence.reference } }, context);
    return report;
  }

  // ------------------------------------------------------------- suppressions
  async function listSuppressions(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketingSuppression.findMany({ where: { OR: [{ organizationId }, { organizationId: null }] }, orderBy: { createdAt: "desc" }, take: 500 });
    return rows.map((row) => ({ id: row.id, email: row.email, scope: row.organizationId ? "BRAND" : "GLOBAL", reason: row.reason, source: row.source, createdAt: iso(row.createdAt), liftedAt: iso(row.liftedAt) }));
  }

  async function createSuppression(user, organizationId, { email, reason, note }, context) {
    await scope(user, organizationId, "EDIT");
    const address = normalizeAddress(email);
    if (!address) throw mailError("MAIL_VALIDATION_FAILED", { field: "email" });
    const allowed = ["UNSUBSCRIBED", "MANUAL", "LEGAL"];
    const value = allowed.includes(reason) ? reason : "MANUAL";
    const existing = await client.marketingSuppression.findFirst({ where: { organizationId, email: address, liftedAt: null } });
    if (existing) return { id: existing.id, email: existing.email, reason: existing.reason, duplicate: true };
    const row = await client.marketingSuppression.create({ data: { organizationId, email: address, reason: value, source: "admin", note: note ? String(note).slice(0, 500) : null, createdBy: user.id } });
    await client.marketingContact.updateMany({ where: { organizationId, email: address }, data: { status: value === "UNSUBSCRIBED" ? "UNSUBSCRIBED" : "SUPPRESSED" } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_SUPPRESSION_CREATED", targetType: "marketing_suppression", targetId: row.id, organizationId, metadata: { reason: value } }, context);
    return { id: row.id, email: row.email, reason: row.reason };
  }

  async function liftSuppression(user, organizationId, suppressionId, context) {
    await scope(user, organizationId, "EDIT");
    const row = policy.isUuid(suppressionId) ? await client.marketingSuppression.findUnique({ where: { id: suppressionId } }) : null;
    if (!row || row.organizationId !== organizationId || row.liftedAt) throw mailError("MAIL_NOT_FOUND", { resource: "suppression" });
    // Complaints, legal and unsubscribe suppressions protect recipients and cannot be lifted here.
    if (!["MANUAL", "BOUNCED"].includes(row.reason)) throw mailError("MAIL_INVALID_TRANSITION", { reason: `${row.reason}_NOT_LIFTABLE` });
    await client.marketingSuppression.update({ where: { id: suppressionId }, data: { liftedAt: clock(), liftedBy: user.id } });
    await client.marketingContact.updateMany({ where: { organizationId, email: row.email, status: { in: ["SUPPRESSED", "BOUNCED"] } }, data: { status: "ACTIVE" } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_SUPPRESSION_LIFTED", targetType: "marketing_suppression", targetId: suppressionId, organizationId }, context);
    return { lifted: true };
  }

  // ------------------------------------------------------------- audiences / segments
  async function loadAudience(organizationId, audienceId) {
    const audience = policy.isUuid(audienceId) ? await client.marketingAudience.findUnique({ where: { id: audienceId } }) : null;
    if (!audience || audience.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "audience" });
    return audience;
  }

  async function listAudiences(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketingAudience.findMany({ where: { organizationId }, include: { _count: { select: { contacts: true, segments: true } } }, orderBy: { name: "asc" } });
    return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, topic: row.topic, status: row.status, contactCount: row._count.contacts, segmentCount: row._count.segments, createdAt: iso(row.createdAt) }));
  }

  async function createAudience(user, organizationId, { name, description, topic }, context) {
    await scope(user, organizationId, "EDIT");
    const cleanTopic = String(topic || "").trim().toLowerCase();
    if (!TOPIC.test(cleanTopic)) throw mailError("MAIL_VALIDATION_FAILED", { field: "topic" });
    const title = cleanName(name, 160);
    if (!title) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    const row = await client.marketingAudience.create({ data: { organizationId, name: title, description: description ? String(description).slice(0, 2000) : null, topic: cleanTopic, createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "name", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUDIENCE_CREATED", targetType: "marketing_audience", targetId: row.id, organizationId }, context);
    return { id: row.id, name: row.name, topic: row.topic, description: row.description, status: row.status };
  }

  async function getAudience(user, organizationId, audienceId) {
    await scope(user, organizationId, "VIEW");
    const audience = await loadAudience(organizationId, audienceId);
    const [contactCount, segments, eligibility] = await Promise.all([
      client.marketingAudienceContact.count({ where: { audienceId } }),
      client.marketingSegment.findMany({ where: { audienceId }, orderBy: { name: "asc" } }),
      eligibleContacts({ organizationId, audience, segment: null }),
    ]);
    return { id: audience.id, name: audience.name, description: audience.description, topic: audience.topic, status: audience.status, contactCount, eligibleCount: eligibility.eligible.length, excluded: eligibility.excludedReasons, segments: segments.map((segment) => ({ id: segment.id, name: segment.name, definition: segment.definition })) };
  }

  async function updateAudience(user, organizationId, audienceId, { name, description, status }, context) {
    await scope(user, organizationId, "EDIT");
    await loadAudience(organizationId, audienceId);
    const data = {};
    if (name !== undefined) data.name = cleanName(name, 160);
    if (description !== undefined) data.description = description ? String(description).slice(0, 2000) : null;
    if (status !== undefined) {
      if (!["ACTIVE", "ARCHIVED"].includes(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
      data.status = status;
    }
    const row = await client.marketingAudience.update({ where: { id: audienceId }, data });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_AUDIENCE_UPDATED", targetType: "marketing_audience", targetId: audienceId, organizationId }, context);
    return { id: row.id, name: row.name, description: row.description, status: row.status, topic: row.topic };
  }

  async function changeAudienceMembers(user, organizationId, audienceId, { contactIds }, add, context) {
    await scope(user, organizationId, "EDIT");
    await loadAudience(organizationId, audienceId);
    const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).filter(policy.isUuid))].slice(0, 1000);
    if (!ids.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "contactIds" });
    // Only contacts of this brand can join this brand's audience.
    const contacts = await client.marketingContact.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true } });
    let changed = 0;
    if (add) {
      const result = await client.marketingAudienceContact.createMany({ data: contacts.map((contact) => ({ audienceId, contactId: contact.id, addedBy: user.id })), skipDuplicates: true });
      changed = result.count;
    } else {
      const result = await client.marketingAudienceContact.deleteMany({ where: { audienceId, contactId: { in: contacts.map((contact) => contact.id) } } });
      changed = result.count;
    }
    await audit.record({ actorAdminUserId: user.id, action: add ? "MARKETING_AUDIENCE_MEMBERS_ADDED" : "MARKETING_AUDIENCE_MEMBERS_REMOVED", targetType: "marketing_audience", targetId: audienceId, organizationId, metadata: { requested: ids.length, changed, rejectedCrossBrand: ids.length - contacts.length } }, context);
    return { changed, added: add ? changed : 0, removed: add ? 0 : changed, rejected: ids.length - contacts.length };
  }

  function validateSegmentDefinition(definition) {
    if (!definition || typeof definition !== "object") throw mailError("MAIL_VALIDATION_FAILED", { field: "definition" });
    const match = definition.match === "any" ? "any" : "all";
    const rules = Array.isArray(definition.rules) ? definition.rules.slice(0, 20) : [];
    if (!rules.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "definition.rules" });
    const clean = rules.map((rule, index) => {
      const requested = String(rule?.field || "");
      const isAttribute = /^attributes\.[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(requested);
      const field = isAttribute ? requested : SEGMENT_FIELD_ALIASES[requested];
      if (!field) throw mailError("MAIL_VALIDATION_FAILED", { field: `definition.rules[${index}].field` });
      if (!SEGMENT_OPS.has(rule.op)) throw mailError("MAIL_VALIDATION_FAILED", { field: `definition.rules[${index}].op` });
      const value = rule.op === "in" ? (Array.isArray(rule.value) ? rule.value.slice(0, 100).map((entry) => String(entry).slice(0, 200)) : null) : rule.value == null ? null : String(rule.value).slice(0, 200);
      if (rule.op !== "exists" && (value == null || (Array.isArray(value) && !value.length))) throw mailError("MAIL_VALIDATION_FAILED", { field: `definition.rules[${index}].value` });
      return { field, op: rule.op, value };
    });
    return { match, rules: clean };
  }

  function evaluateSegment(definition, contact) {
    const read = (field) => (field.startsWith("attributes.") ? (contact.attributes || {})[field.slice(11)] : field === "email_domain" ? String(contact.email).split("@")[1] : contact[field]);
    const test = (rule) => {
      const raw = read(rule.field);
      const value = raw instanceof Date ? raw.toISOString() : raw == null ? null : String(raw);
      switch (rule.op) {
        case "exists": return value != null && value !== "";
        case "equals": return value != null && value.toLowerCase() === String(rule.value).toLowerCase();
        case "not_equals": return value == null || value.toLowerCase() !== String(rule.value).toLowerCase();
        case "ends_with": return value != null && value.toLowerCase().endsWith(String(rule.value).toLowerCase());
        case "contains": return value != null && value.toLowerCase().includes(String(rule.value).toLowerCase());
        case "in": return value != null && rule.value.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
        case "before": return value != null && new Date(value) < new Date(rule.value);
        case "after": return value != null && new Date(value) > new Date(rule.value);
        default: return false;
      }
    };
    return definition.match === "any" ? definition.rules.some(test) : definition.rules.every(test);
  }

  async function createSegment(user, organizationId, audienceId, { name, definition }, context) {
    await scope(user, organizationId, "EDIT");
    await loadAudience(organizationId, audienceId);
    const title = cleanName(name, 160);
    if (!title) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    const row = await client.marketingSegment.create({ data: { organizationId, audienceId, name: title, definition: validateSegmentDefinition(definition), createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "name", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_SEGMENT_CREATED", targetType: "marketing_segment", targetId: row.id, organizationId }, context);
    return { id: row.id, name: row.name, definition: row.definition, audienceId };
  }

  async function listSegments(user, organizationId, audienceId) {
    await scope(user, organizationId, "VIEW");
    await loadAudience(organizationId, audienceId);
    const rows = await client.marketingSegment.findMany({ where: { audienceId }, orderBy: { name: "asc" } });
    return rows.map((row) => ({ id: row.id, name: row.name, definition: row.definition, audienceId }));
  }

  async function loadSegment(organizationId, segmentId) {
    const segment = policy.isUuid(segmentId) ? await client.marketingSegment.findUnique({ where: { id: segmentId } }) : null;
    if (!segment || segment.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "segment" });
    return segment;
  }

  // Consent-backed eligibility: audience member, ACTIVE, consent GRANTED for the
  // audience topic (confirmed when double opt-in), and no active suppression.
  async function eligibleContacts({ organizationId, audience, segment, topic }) {
    const effectiveTopic = topic || audience.topic;
    const members = await client.marketingAudienceContact.findMany({
      where: { audienceId: audience.id, contact: { organizationId } },
      include: { contact: { include: { consents: { where: { topic: effectiveTopic } } } } },
      take: MAX_SEGMENT_CONTACTS + 1,
    });
    if (members.length > MAX_SEGMENT_CONTACTS) throw mailError("MAIL_VALIDATION_FAILED", { reason: "AUDIENCE_TOO_LARGE_FOR_M6" });
    const emails = members.map((member) => member.contact.email);
    const suppressions = emails.length ? await client.marketingSuppression.findMany({ where: { email: { in: emails }, liftedAt: null, OR: [{ organizationId }, { organizationId: null }] }, select: { email: true } }) : [];
    const suppressed = new Set(suppressions.map((row) => row.email));
    const excludedReasons = { notInSegment: 0, inactive: 0, noConsent: 0, unconfirmed: 0, withdrawn: 0, suppressed: 0 };
    const eligible = [];
    for (const { contact } of members) {
      if (segment && !evaluateSegment(segment.definition, contact)) { excludedReasons.notInSegment += 1; continue; }
      if (contact.status !== "ACTIVE") { excludedReasons.inactive += 1; continue; }
      if (suppressed.has(contact.email)) { excludedReasons.suppressed += 1; continue; }
      const consent = contact.consents[0];
      if (!consent) { excludedReasons.noConsent += 1; continue; }
      if (consent.status === "WITHDRAWN") { excludedReasons.withdrawn += 1; continue; }
      if (consent.status !== "GRANTED" || (consent.doubleOptIn && !consent.confirmedAt)) { excludedReasons.unconfirmed += 1; continue; }
      eligible.push(contact);
    }
    return { eligible, total: members.length, excludedReasons };
  }

  async function previewSegment(user, organizationId, segmentId) {
    await scope(user, organizationId, "VIEW");
    const segment = await loadSegment(organizationId, segmentId);
    const audience = await loadAudience(organizationId, segment.audienceId);
    const result = await eligibleContacts({ organizationId, audience, segment });
    return { segmentId, audienceId: audience.id, total: result.total, eligibleCount: result.eligible.length, excludedCount: result.total - result.eligible.length, excluded: result.excludedReasons, sample: result.eligible.slice(0, 10).map((contact) => ({ id: contact.id, email: contact.email, firstName: contact.firstName })) };
  }

  // ------------------------------------------------------------- templates
  function renderOrThrow(input, options) {
    try {
      return renderTemplate(input, options);
    } catch (error) {
      if (error instanceof TemplateError) throw mailError(error.code, { details: error.details });
      throw error;
    }
  }

  async function renderPreview(user, organizationId, input) {
    const scoped = await scope(user, organizationId, "VIEW");
    const sample = { first_name: "Ada", last_name: "Lovelace", email: "ada@example.invalid", unsubscribe_url: "https://example.invalid/unsubscribe", ...(input.sampleData && typeof input.sampleData === "object" ? Object.fromEntries(Object.entries(input.sampleData).map(([key, value]) => [key, String(value).slice(0, 200)])) : {}) };
    const rendered = renderOrThrow({ subject: input.subject, preheader: input.preheader, blocks: input.blocks, brand: { name: scoped.name, ...(input.brand || {}) } }, { data: sample });
    return { subject: rendered.subject, html: rendered.html, text: rendered.text, variables: rendered.variables, warnings: rendered.warnings, accessibility: rendered.accessibility };
  }

  async function loadTemplate(organizationId, templateId) {
    const template = policy.isUuid(templateId) ? await client.marketingEmailTemplate.findUnique({ where: { id: templateId } }) : null;
    if (!template || template.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "template" });
    return template;
  }

  async function listTemplates(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketingEmailTemplate.findMany({ where: { organizationId }, orderBy: { updatedAt: "desc" } });
    return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status, latestVersion: row.latestVersion, legacyTemplateId: row.legacyTemplateId, updatedAt: iso(row.updatedAt) }));
  }

  async function createTemplate(user, organizationId, { name, description, legacyTemplateId }, context) {
    await scope(user, organizationId, "EDIT");
    const title = cleanName(name, 160);
    if (!title) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    const row = await client.marketingEmailTemplate.create({ data: { organizationId, name: title, description: description ? String(description).slice(0, 2000) : null, legacyTemplateId: legacyTemplateId ? String(legacyTemplateId).slice(0, 64) : null, createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "name", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_TEMPLATE_CREATED", targetType: "marketing_template", targetId: row.id, organizationId }, context);
    return { id: row.id, name: row.name, description: row.description, latestVersion: 0 };
  }

  async function getTemplate(user, organizationId, templateId) {
    await scope(user, organizationId, "VIEW");
    const template = await loadTemplate(organizationId, templateId);
    const versions = await client.marketingTemplateVersion.findMany({ where: { templateId }, orderBy: { version: "desc" }, take: 100 });
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      latestVersion: template.latestVersion,
      legacyTemplateId: template.legacyTemplateId,
      versions: versions.map((version) => ({ id: version.id, version: version.version, subject: version.subject, preheader: version.preheader, blocks: version.blocks, brand: version.brand, variables: version.variables, contentSha256: version.contentSha256, createdBy: version.createdBy, createdAt: iso(version.createdAt) })),
    };
  }

  async function createTemplateVersion(user, organizationId, templateId, input, context) {
    const scoped = await scope(user, organizationId, "EDIT");
    await loadTemplate(organizationId, templateId);
    const rendered = renderOrThrow({ subject: input.subject, preheader: input.preheader, blocks: input.blocks, brand: { name: scoped.name, ...(input.brand || {}) } });
    const version = await client.$transaction(async (tx) => {
      const bumped = await tx.marketingEmailTemplate.update({ where: { id: templateId }, data: { latestVersion: { increment: 1 } } });
      return tx.marketingTemplateVersion.create({
        data: { templateId, version: bumped.latestVersion, subject: rendered.subject, preheader: input.preheader ? String(input.preheader).slice(0, 255) : null, blocks: input.blocks, brand: rendered.brand, html: rendered.html, text: rendered.text, variables: rendered.variables, contentSha256: rendered.contentSha256, createdBy: user.id },
      });
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_TEMPLATE_VERSION_CREATED", targetType: "marketing_template", targetId: templateId, organizationId, metadata: { version: version.version, contentSha256: version.contentSha256 } }, context);
    return { id: version.id, version: version.version, contentSha256: version.contentSha256, accessibility: rendered.accessibility };
  }

  async function legacyTemplates(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketing_email_templates.findMany({ include: { event: true }, orderBy: { createdAt: "desc" }, take: 200 });
    return rows.map((row) => ({ id: row.id, eventId: row.eventId, eventName: row.event?.event || null, eventCode: row.event?.eventCode || null, language: row.language, status: row.status, validFrom: iso(row.validFrom), validTo: iso(row.validTo), readOnly: true }));
  }

  // Approved brand sender identities (non-personal, active addresses).
  async function senderIdentities(user, organizationId) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.mailAddress.findMany({ where: { organizationId, status: "ACTIVE", kind: { in: ["SHARED", "SYSTEM", "ALIAS"] } }, include: { domain: true, mailbox: { select: { purpose: true, name: true } } }, orderBy: { address: "asc" } });
    return rows.map((row) => ({ addressId: row.id, address: row.address, displayName: row.displayName, kind: row.kind, mailboxName: row.mailbox?.name || null, purpose: row.mailbox?.purpose || null, domainVerifiedForSending: row.domain.status === "VERIFIED" && row.domain.sendingStatus === "VERIFIED" }));
  }

  // ------------------------------------------------------------- campaigns
  function serializeCampaign(campaign) {
    return {
      id: campaign.id, organizationId: campaign.organizationId, name: campaign.name, status: campaign.status, topic: campaign.topic,
      senderAddressId: campaign.senderAddressId, replyTo: campaign.replyTo, subjectOverride: campaign.subjectOverride,
      templateVersionId: campaign.templateVersionId, audienceId: campaign.audienceId, segmentId: campaign.segmentId,
      frequencyCapHours: campaign.frequencyCapHours, legacyCampaignId: campaign.legacyCampaignId, revision: campaign.revision,
      createdBy: campaign.createdByAdminUserId, submittedAt: iso(campaign.submittedAt), submittedBy: campaign.submittedByAdminUserId,
      approvedAt: iso(campaign.approvedAt), approvedBy: campaign.approvedByAdminUserId, createdAt: iso(campaign.createdAt), updatedAt: iso(campaign.updatedAt),
      dispatchEnabled: config.broadcastDispatchEnabled,
    };
  }

  async function loadCampaign(organizationId, campaignId, tx = client) {
    const campaign = policy.isUuid(campaignId) ? await tx.marketingEmailCampaign.findUnique({ where: { id: campaignId } }) : null;
    if (!campaign || campaign.organizationId !== organizationId) throw mailError("MAIL_NOT_FOUND", { resource: "campaign" });
    return campaign;
  }

  async function validateCampaignReferences(organizationId, input) {
    if (input.templateVersionId) {
      const version = policy.isUuid(input.templateVersionId) ? await client.marketingTemplateVersion.findUnique({ where: { id: input.templateVersionId }, include: { template: true } }) : null;
      if (!version || version.template.organizationId !== organizationId) throw mailError("MAIL_VALIDATION_FAILED", { field: "templateVersionId" });
    }
    if (input.audienceId) await loadAudience(organizationId, input.audienceId).catch(() => { throw mailError("MAIL_VALIDATION_FAILED", { field: "audienceId" }); });
    if (input.segmentId) {
      const segment = await loadSegment(organizationId, input.segmentId).catch(() => { throw mailError("MAIL_VALIDATION_FAILED", { field: "segmentId" }); });
      if (input.audienceId && segment.audienceId !== input.audienceId) throw mailError("MAIL_VALIDATION_FAILED", { field: "segmentId", reason: "SEGMENT_AUDIENCE_MISMATCH" });
    }
    if (input.senderAddressId) {
      const address = policy.isUuid(input.senderAddressId) ? await client.mailAddress.findUnique({ where: { id: input.senderAddressId } }) : null;
      if (!address || address.organizationId !== organizationId) throw mailError("MAIL_VALIDATION_FAILED", { field: "senderAddressId" });
    }
    if (input.replyTo != null && input.replyTo !== "" && !normalizeAddress(input.replyTo)) throw mailError("MAIL_VALIDATION_FAILED", { field: "replyTo" });
    if (input.topic != null && !TOPIC.test(String(input.topic))) throw mailError("MAIL_VALIDATION_FAILED", { field: "topic" });
    if (input.frequencyCapHours != null && (!Number.isInteger(Number(input.frequencyCapHours)) || Number(input.frequencyCapHours) < 0 || Number(input.frequencyCapHours) > 8760)) throw mailError("MAIL_VALIDATION_FAILED", { field: "frequencyCapHours" });
  }

  function campaignData(input) {
    const data = {};
    if (input.name !== undefined) data.name = cleanName(input.name, 200);
    if (input.topic !== undefined) data.topic = String(input.topic).toLowerCase();
    if (input.senderAddressId !== undefined) data.senderAddressId = input.senderAddressId || null;
    if (input.replyTo !== undefined) data.replyTo = input.replyTo ? normalizeAddress(input.replyTo) : null;
    if (input.subjectOverride !== undefined) data.subjectOverride = input.subjectOverride ? String(input.subjectOverride).replace(/[\r\n]+/g, " ").slice(0, 998) : null;
    if (input.templateVersionId !== undefined) data.templateVersionId = input.templateVersionId || null;
    if (input.audienceId !== undefined) data.audienceId = input.audienceId || null;
    if (input.segmentId !== undefined) data.segmentId = input.segmentId || null;
    if (input.frequencyCapHours !== undefined) data.frequencyCapHours = Number(input.frequencyCapHours);
    if (input.legacyCampaignId !== undefined) data.legacyCampaignId = input.legacyCampaignId ? String(input.legacyCampaignId).slice(0, 64) : null;
    return data;
  }

  async function listCampaigns(user, organizationId, { status } = {}) {
    await scope(user, organizationId, "VIEW");
    const rows = await client.marketingEmailCampaign.findMany({ where: { organizationId, ...(status ? { status } : {}) }, orderBy: { updatedAt: "desc" }, take: 200 });
    return rows.map(serializeCampaign);
  }

  async function createCampaign(user, organizationId, input, context) {
    await scope(user, organizationId, "EDIT");
    const data = campaignData(input);
    if (!data.name) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    if (!data.topic) throw mailError("MAIL_VALIDATION_FAILED", { field: "topic" });
    await validateCampaignReferences(organizationId, input);
    if (data.legacyCampaignId) {
      const legacy = await client.marketing_campaigns.findUnique({ where: { id: data.legacyCampaignId } });
      if (!legacy) throw mailError("MAIL_VALIDATION_FAILED", { field: "legacyCampaignId" });
    }
    const row = await client.marketingEmailCampaign.create({ data: { organizationId, ...data, createdByAdminUserId: user.id, updatedByAdminUserId: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_CREATED", targetType: "marketing_campaign", targetId: row.id, organizationId }, context);
    return serializeCampaign(row);
  }

  async function getCampaign(user, organizationId, campaignId) {
    await scope(user, organizationId, "VIEW");
    return serializeCampaign(await loadCampaign(organizationId, campaignId));
  }

  async function updateCampaign(user, organizationId, campaignId, input, context) {
    await scope(user, organizationId, "EDIT");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (!["DRAFT", "READY_FOR_REVIEW", "APPROVED", "REJECTED"].includes(campaign.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: campaign.status });
    const revision = Number(input.revision);
    if (revision !== campaign.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: campaign.revision });
    await validateCampaignReferences(organizationId, input);
    const data = campaignData(input);
    const material = MATERIAL_FIELDS.some((field) => data[field] !== undefined && JSON.stringify(data[field]) !== JSON.stringify(campaign[field]));
    const invalidates = material && ["READY_FOR_REVIEW", "APPROVED"].includes(campaign.status);
    const row = await client.$transaction(async (tx) => {
      const result = await tx.marketingEmailCampaign.updateMany({
        where: { id: campaignId, revision },
        data: { ...data, updatedByAdminUserId: user.id, revision: { increment: 1 }, ...(invalidates || (material && campaign.status === "REJECTED") ? { status: "DRAFT", approvedAt: null, approvedByAdminUserId: null, submittedAt: null, submittedByAdminUserId: null } : {}) },
      });
      if (result.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
      if (invalidates) {
        await tx.marketingCampaignApproval.create({ data: { campaignId, revision: campaign.revision, decision: "INVALIDATED", reviewerAdminUserId: user.id, comment: "Material edit after submission/approval", createdAt: clock() } });
        await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_APPROVAL_INVALIDATED", targetType: "marketing_campaign", targetId: campaignId, organizationId, metadata: { previousStatus: campaign.status, revision: campaign.revision } }, context, tx);
      }
      return tx.marketingEmailCampaign.findUnique({ where: { id: campaignId } });
    });
    await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_UPDATED", targetType: "marketing_campaign", targetId: campaignId, organizationId, metadata: { revision: row.revision, material } }, context);
    return serializeCampaign(row);
  }

  async function preflight(campaign) {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok, detail });
    const version = campaign.templateVersionId ? await client.marketingTemplateVersion.findUnique({ where: { id: campaign.templateVersionId }, include: { template: true } }) : null;
    add("template", Boolean(version && version.template.organizationId === campaign.organizationId), version ? `Template version ${version.version}` : "Select an approved template version");
    const sender = campaign.senderAddressId ? await client.mailAddress.findUnique({ where: { id: campaign.senderAddressId }, include: { domain: { include: { organization: { select: { id: true, slug: true } } } } } }) : null;
    const senderOk = Boolean(sender && sender.organizationId === campaign.organizationId && sender.status === "ACTIVE" && ["SHARED", "SYSTEM", "ALIAS"].includes(sender.kind));
    add("sender_identity", senderOk, sender ? (senderOk ? sender.address : "Sender must be an active brand (non-personal) address") : "Select an approved sender identity");
    add("sender_domain_verified", Boolean(sender && sender.domain.status === "VERIFIED" && sender.domain.sendingStatus === "VERIFIED"), sender ? `${sender.domain.domain}: ${sender.domain.status}/${sender.domain.sendingStatus}` : "No sender");
    // Approval requires the same allowlist the dispatch gate enforces (M7
    // dispatch does not exist yet; this keeps approvals honest).
    const allowlisted = Boolean(sender && config.domainAllowlist.length && config.domainAllowlist.includes(sender.domain.domain));
    // Spec §19.7: restricted-health brands never send through the provider.
    const restricted = Boolean(sender && isRestrictedHealthOrganization(config, sender.domain.organization)) && !config.restrictedHealth?.providerApproved;
    add("brand_provider_allowed", !restricted, restricted ? "Restricted-health brand: provider sending is not approved" : "Brand may use the provider");
    add("sender_domain_allowlisted", allowlisted, !config.domainAllowlist.length ? "MAIL_DOMAIN_ALLOWLIST is empty" : sender ? (allowlisted ? sender.domain.domain : `${sender.domain.domain} is not in MAIL_DOMAIN_ALLOWLIST`) : "No sender");
    let replyOk = true;
    let replyDetail = "Replies go to the sender address";
    if (campaign.replyTo) {
      const domain = campaign.replyTo.split("@")[1];
      const owned = await client.mailDomain.findFirst({ where: { organizationId: campaign.organizationId, domain } });
      replyOk = Boolean(owned);
      replyDetail = replyOk ? campaign.replyTo : "Reply-To must use a brand-owned domain";
    }
    add("reply_to_policy", replyOk, replyDetail);
    const audience = campaign.audienceId ? await client.marketingAudience.findUnique({ where: { id: campaign.audienceId } }) : null;
    const segment = campaign.segmentId ? await client.marketingSegment.findUnique({ where: { id: campaign.segmentId } }) : null;
    let eligibility = { eligible: [], total: 0, excludedReasons: {} };
    if (audience && audience.organizationId === campaign.organizationId && audience.status === "ACTIVE") {
      eligibility = await eligibleContacts({ organizationId: campaign.organizationId, audience, segment, topic: campaign.topic });
      add("audience", true, audience.name);
    } else add("audience", false, "Select an active audience");
    add("topic_matches_audience", Boolean(audience && audience.topic === campaign.topic), audience ? `Campaign topic ${campaign.topic}, audience topic ${audience.topic}` : "No audience");
    add("consent_backed_recipients", eligibility.eligible.length > 0, `${eligibility.eligible.length} eligible of ${eligibility.total}`);
    add("suppression_applied", true, `${eligibility.excludedReasons.suppressed || 0} suppressed contacts excluded`);
    const capWindow = new Date(clock().getTime() - campaign.frequencyCapHours * 3600000);
    const recent = await client.marketingEmailCampaign.count({ where: { organizationId: campaign.organizationId, id: { not: campaign.id }, audienceId: campaign.audienceId, status: { in: ["SCHEDULED", "QUEUED", "SENDING", "COMPLETE", "PARTIAL", "OUTCOME_UNKNOWN"] }, updatedAt: { gt: capWindow } } });
    add("frequency_cap", recent === 0, recent ? `${recent} campaign(s) to this audience inside ${campaign.frequencyCapHours}h` : `No sends inside ${campaign.frequencyCapHours}h`);
    // Spec §13.2 step 4: the brand's sending quota must cover this audience.
    if (hooks.quotaCheck) {
      const quota = await hooks.quotaCheck(campaign.organizationId, eligibility.eligible.length).catch(() => ({ allowed: false, reason: "QUOTA_CHECK_FAILED" }));
      add("quota_available", Boolean(quota.allowed), quota.allowed ? (quota.soft ? "Within the hard limit; the daily soft limit will be passed" : "Within the brand's sending quota") : `${quota.reason || "MAIL_QUOTA_HARD_LIMIT"}${quota.limit ? `: ${quota.used ?? 0} used of ${quota.limit} per ${quota.period}` : ""}`);
    }
    // Marketing mail must carry the brand's physical postal address (M7).
    const brandSettings = await client.marketingBrandSettings.findUnique({ where: { organizationId: campaign.organizationId } });
    add("postal_address", Boolean(brandSettings?.postalAddress), brandSettings?.postalAddress ? "Postal address included in the footer" : "Set the brand postal address in Email Marketing settings");
    let rendered = null;
    if (version) {
      try {
        rendered = renderTemplate({ subject: campaign.subjectOverride || version.subject, preheader: version.preheader, blocks: version.blocks, brand: { ...(version.brand || {}), ...(brandSettings?.postalAddress ? { postalAddress: brandSettings.postalAddress } : {}) } });
        add("template_renders", true, `${rendered.variables.length} variables`);
        const links = scanLinks(rendered.html);
        add("links_safe", links.ok, links.ok ? `${links.linkCount} link(s) checked` : links.issues.slice(0, 5).map((issue) => `${issue.kind}: ${issue.detail}`).join("; "));
      } catch (error) {
        add("template_renders", false, error.code || "render failed");
      }
    }
    const contactHash = crypto.createHash("sha256").update(eligibility.eligible.map((contact) => contact.id).sort().join(",")).digest("hex");
    return { ok: checks.every((check) => check.ok), checks, eligibleCount: eligibility.eligible.length, excludedCount: eligibility.total - eligibility.eligible.length, excluded: eligibility.excludedReasons, version, sender, rendered, contactHash, contactIds: eligibility.eligible.map((contact) => contact.id) };
  }

  async function runPreflight(user, organizationId, campaignId) {
    await scope(user, organizationId, "VIEW");
    const result = await preflight(await loadCampaign(organizationId, campaignId));
    return { ok: result.ok, checks: result.checks, eligibleCount: result.eligibleCount, excludedCount: result.excludedCount, excluded: result.excluded };
  }

  async function createSnapshot(tx, user, campaign, result, kind) {
    const html = result.rendered.html;
    const text = result.rendered.text;
    const subject = result.rendered.subject;
    const contentSha256 = crypto.createHash("sha256").update(JSON.stringify({ subject, html, text, sender: result.sender.address, replyTo: campaign.replyTo, templateVersionId: result.version.id })).digest("hex");
    return tx.marketingCampaignSnapshot.create({
      data: { campaignId: campaign.id, revision: campaign.revision, kind, templateVersionId: result.version.id, senderAddress: result.sender.address, replyTo: campaign.replyTo, subject, html, text, audienceSnapshot: { audienceId: campaign.audienceId, segmentId: campaign.segmentId, topic: campaign.topic, contactSetSha256: result.contactHash, contactCount: result.contactIds.length }, eligibleCount: result.eligibleCount, excludedCount: result.excludedCount, contentSha256, createdBy: user.id, createdAt: clock() },
    });
  }

  async function submit(user, organizationId, campaignId, { revision }, context) {
    await scope(user, organizationId, "EDIT");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (!["DRAFT", "REJECTED"].includes(campaign.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: campaign.status });
    if (Number(revision) !== campaign.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: campaign.revision });
    const result = await preflight(campaign);
    if (!result.ok) throw mailError("MAIL_PREFLIGHT_FAILED", { checks: result.checks.filter((check) => !check.ok) });
    const row = await client.$transaction(async (tx) => {
      const updated = await tx.marketingEmailCampaign.updateMany({ where: { id: campaignId, revision: campaign.revision, status: campaign.status }, data: { status: "READY_FOR_REVIEW", submittedAt: clock(), submittedByAdminUserId: user.id } });
      if (updated.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
      const existing = await tx.marketingCampaignSnapshot.findUnique({ where: { campaignId_revision_kind: { campaignId, revision: campaign.revision, kind: "SUBMISSION" } } });
      if (!existing) await createSnapshot(tx, user, campaign, result, "SUBMISSION");
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_SUBMITTED", targetType: "marketing_campaign", targetId: campaignId, organizationId, metadata: { revision: campaign.revision, eligible: result.eligibleCount } }, context, tx);
      return tx.marketingEmailCampaign.findUnique({ where: { id: campaignId } });
    });
    return serializeCampaign(row);
  }

  async function approve(user, organizationId, campaignId, { revision, stepUpId, comment }, context) {
    await scope(user, organizationId, "APPROVE");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (campaign.status !== "READY_FOR_REVIEW") throw mailError("MAIL_INVALID_TRANSITION", { from: campaign.status });
    if (Number(revision) !== campaign.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: campaign.revision });
    // Reviewer separation: authors and submitters cannot approve their own campaign.
    if ([campaign.createdByAdminUserId, campaign.submittedByAdminUserId, campaign.updatedByAdminUserId].includes(user.id)) throw mailError("MAIL_FORBIDDEN", { reason: "REVIEWER_MUST_DIFFER_FROM_AUTHOR" });
    const result = await preflight(campaign);
    if (!result.ok) throw mailError("MAIL_PREFLIGHT_FAILED", { checks: result.checks.filter((check) => !check.ok) });
    const row = await client.$transaction(async (tx) => {
      const consumed = await stepUp.consume(tx, user, stepUpId, "MARKETING_CAMPAIGN_APPROVAL", context);
      const submission = await tx.marketingCampaignSnapshot.findUnique({ where: { campaignId_revision_kind: { campaignId, revision: campaign.revision, kind: "SUBMISSION" } } });
      const snapshot = await createSnapshot(tx, user, campaign, result, "APPROVAL");
      // Approval binds exactly the reviewed content.
      if (!submission || submission.contentSha256 !== snapshot.contentSha256) throw mailError("MAIL_INVALID_TRANSITION", { reason: "CONTENT_CHANGED_SINCE_SUBMISSION" });
      const updated = await tx.marketingEmailCampaign.updateMany({ where: { id: campaignId, revision: campaign.revision, status: "READY_FOR_REVIEW" }, data: { status: "APPROVED", approvedAt: clock(), approvedByAdminUserId: user.id } });
      if (updated.count !== 1) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: null });
      await tx.marketingCampaignApproval.create({ data: { campaignId, revision: campaign.revision, decision: "APPROVED", reviewerAdminUserId: user.id, stepUpId: consumed, snapshotId: snapshot.id, comment: comment ? String(comment).slice(0, 2000) : null, createdAt: clock() } });
      // M7: the exact recipient set that was reviewed. Dispatch sends only to
      // contacts in this set that are still eligible at dispatch time.
      for (let index = 0; index < result.contactIds.length; index += 1000) {
        await tx.marketingCampaignApprovedContact.createMany({ data: result.contactIds.slice(index, index + 1000).map((contactId) => ({ snapshotId: snapshot.id, contactId })), skipDuplicates: true });
      }
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_APPROVED", targetType: "marketing_campaign", targetId: campaignId, organizationId, metadata: { revision: campaign.revision, snapshotId: snapshot.id, contentSha256: snapshot.contentSha256 } }, context, tx);
      return tx.marketingEmailCampaign.findUnique({ where: { id: campaignId } });
    });
    return serializeCampaign(row);
  }

  async function reject(user, organizationId, campaignId, { revision, comment }, context) {
    await scope(user, organizationId, "APPROVE");
    const campaign = await loadCampaign(organizationId, campaignId);
    if (campaign.status !== "READY_FOR_REVIEW") throw mailError("MAIL_INVALID_TRANSITION", { from: campaign.status });
    if (Number(revision) !== campaign.revision) throw mailError("MAIL_DRAFT_REVISION_CONFLICT", { currentRevision: campaign.revision });
    if (!comment || String(comment).trim().length < 3) throw mailError("MAIL_VALIDATION_FAILED", { field: "comment" });
    const row = await client.$transaction(async (tx) => {
      await tx.marketingEmailCampaign.update({ where: { id: campaignId }, data: { status: "REJECTED" } });
      await tx.marketingCampaignApproval.create({ data: { campaignId, revision: campaign.revision, decision: "REJECTED", reviewerAdminUserId: user.id, comment: String(comment).slice(0, 2000) } });
      await audit.record({ actorAdminUserId: user.id, action: "MARKETING_CAMPAIGN_REJECTED", targetType: "marketing_campaign", targetId: campaignId, organizationId }, context, tx);
      return tx.marketingEmailCampaign.findUnique({ where: { id: campaignId } });
    });
    return serializeCampaign(row);
  }

  async function history(user, organizationId, campaignId) {
    await scope(user, organizationId, "VIEW");
    await loadCampaign(organizationId, campaignId);
    const [approvals, snapshots, events] = await Promise.all([
      client.marketingCampaignApproval.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } }),
      client.marketingCampaignSnapshot.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" }, select: { id: true, revision: true, kind: true, templateVersionId: true, senderAddress: true, subject: true, eligibleCount: true, excludedCount: true, contentSha256: true, createdBy: true, createdAt: true } }),
      audit.list({ targetType: "marketing_campaign", targetId: campaignId, limit: 200 }),
    ]);
    return {
      approvals: approvals.map((approval) => ({ id: approval.id, revision: approval.revision, decision: approval.decision, reviewer: approval.reviewerAdminUserId, comment: approval.comment, snapshotId: approval.snapshotId, createdAt: iso(approval.createdAt) })),
      snapshots: snapshots.map((snapshot) => ({ ...snapshot, createdAt: iso(snapshot.createdAt) })),
      events: events.map((event) => ({ id: event.id, action: event.action, actor: event.actorAdminUserId, metadata: event.metadata, createdAt: iso(event.createdAt) })),
    };
  }

  async function snapshot(user, organizationId, campaignId, snapshotId) {
    await scope(user, organizationId, "VIEW");
    await loadCampaign(organizationId, campaignId);
    const row = policy.isUuid(snapshotId) ? await client.marketingCampaignSnapshot.findUnique({ where: { id: snapshotId } }) : null;
    if (!row || row.campaignId !== campaignId) throw mailError("MAIL_NOT_FOUND", { resource: "snapshot" });
    return { ...row, createdAt: iso(row.createdAt) };
  }

  return {
    organizations, senderIdentities, createContact, listContacts, getContact, updateContact, recordConsent, withdrawConsent, confirmConsent, importCsv,
    listSuppressions, createSuppression, liftSuppression, listAudiences, createAudience, getAudience, updateAudience, changeAudienceMembers,
    createSegment, listSegments, previewSegment, renderPreview, listTemplates, createTemplate, getTemplate, createTemplateVersion, legacyTemplates,
    listCampaigns, createCampaign, getCampaign, updateCampaign, runPreflight, submit, approve, reject, history, snapshot, eligibleContacts,
  };
}

module.exports = { createMarketingService, validateConsentInput, recordConsentGranted };

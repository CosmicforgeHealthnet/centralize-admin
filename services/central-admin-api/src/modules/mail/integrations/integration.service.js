"use strict";

// Product integrations (M8): authenticated ingestion of versioned product
// events, plus HQ administration and product-isolated reporting.
//
// Isolation rules (enforced here, not in the UI):
// - a service identity maps to exactly one integration -> one product -> one
//   brand organization; envelope product/organization must match it;
// - transactional delivery metadata is accepted only for sender addresses
//   explicitly authorised for that integration and owned by its brand;
// - recipients are stored as an HMAC keyed per brand + domain only;
// - RESTRICTED_HEALTH integrations (HealthNet) can only send ops.alert and
//   are refused everything else, also at the database level;
// - product owners see only their own integration (grant mail/integration:<product>).
// Products are never called synchronously by HQ, and HQ availability never
// blocks product flows: products deliver these events from their own outbox.

const crypto = require("crypto");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { iso } = require("../services/serializers");
const { verifyServiceRequest, parseServiceSecrets } = require("./service-auth");
const { parseEnvelope, parseDeliveryStatus, parseMarketingTrigger, parseOpsAlert, ContractError } = require("./contracts");
const { approvedEvent } = require("../marketing/automation/event-registry");
const { enforceWithdrawal } = require("../marketing/consent-enforcement");

const PURPOSES = new Set(["TRANSACTIONAL", "MARKETING_TRIGGER", "OPERATIONAL_ALERT"]);
const CLASSIFICATIONS = new Set(["STANDARD", "RESTRICTED_HEALTH"]);
const EVENT_TYPES_FOR = { STANDARD: ["mail.delivery_status", "marketing.trigger", "ops.alert"], RESTRICTED_HEALTH: ["ops.alert"] };

function createIntegrationService({ client, config, audit, stepUp, automations, notifications, rollout = null, rateLimiter = null, env = process.env, clock = () => new Date(), logger = null }) {
  const secrets = () => parseServiceSecrets(env.MAIL_INTEGRATION_SERVICE_SECRETS);
  const buckets = new Map();

  // Shared across API replicas when migration 35 is present (spec 20);
  // otherwise the process-local window below (same limit).
  async function rateLimited(integrationId) {
    if (rateLimiter) {
      const result = await rateLimiter.consume(`integration:${integrationId}`, { max: config.integrations.ratePerMinute, windowMs: 60000 });
      return !result.allowed;
    }
    const minute = Math.floor(clock().getTime() / 60000);
    const bucket = buckets.get(integrationId);
    if (!bucket || bucket.minute !== minute) {
      buckets.set(integrationId, { minute, count: 1 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > config.integrations.ratePerMinute;
  }

  function recipientHash(organizationId, email) {
    return crypto.createHmac("sha256", config.integrations.hashSecret).update(`${organizationId}:${email}`).digest("hex");
  }

  function reply(status, code, extra = {}) {
    const retryable = status === 429 || status >= 500;
    return { status, body: status < 300 ? { success: true, data: extra } : { success: false, code, retryable, message: code, errors: [{ code, retryable, ...extra }] } };
  }

  async function recordRejection(integration, envelope, payloadSha256, code, details) {
    if (!integration) return;
    await client.mailProductIntegrationEvent.create({
      data: { integrationId: integration.id, eventId: `rejected:${crypto.randomUUID()}`, eventType: String(envelope?.eventType || "unknown").slice(0, 96), eventVersion: Number(envelope?.eventVersion) || 0, correlationId: envelope?.correlationId || null, payloadSha256, status: "REJECTED", errorCode: code.slice(0, 64), outcome: details?.fields ? { fields: details.fields.slice(0, 10) } : details?.field ? { field: details.field } : null, occurredAt: null, receivedAt: clock() },
    }).catch(() => {});
    await client.mailProductIntegration.update({ where: { id: integration.id }, data: { lastErrorCode: code.slice(0, 64), lastErrorAt: clock() } }).catch(() => {});
  }

  async function handleDelivery(tx, integration, organization, envelope) {
    const data = parseDeliveryStatus(envelope.data);
    const sender = await tx.mailProductSenderAuthorization.findFirst({ where: { integrationId: integration.id, address: data.sender, purpose: "TRANSACTIONAL", revokedAt: null } });
    const address = sender ? await tx.mailAddress.findUnique({ where: { id: sender.addressId }, include: { domain: true } }) : null;
    if (!sender || !address || address.organizationId !== organization.id || address.status !== "ACTIVE") throw new ContractError("MAIL_SENDER_NOT_AUTHORIZED", 403, { sender: data.sender });
    await tx.mailProductDeliveryEvent.create({
      data: {
        integrationId: integration.id, organizationId: organization.id, productMessageId: data.productMessageId, provider: data.provider, providerMessageId: data.providerMessageId,
        senderAddress: data.sender, recipientHash: recipientHash(organization.id, data.recipient), recipientDomain: data.recipient.split("@")[1], category: data.category, status: data.status,
        occurredAt: envelope.occurredAtDate, createdAt: clock(),
      },
    });
    // A hard bounce or complaint on product mail protects the person from this
    // brand's marketing too (only if they are already a marketing contact).
    let marketingSuppressed = false;
    if (data.status === "BOUNCED" || data.status === "COMPLAINED") {
      // Never create a record (suppression) holding the plain address of a
      // product user who is not already this brand's marketing contact.
      const contact = await tx.marketingContact.findUnique({ where: { organizationId_email: { organizationId: organization.id, email: data.recipient } } });
      if (contact) {
        const applied = await enforceWithdrawal(tx, { organizationId: organization.id, contactId: contact.id, reason: data.status, source: `product:${integration.product}`, now: clock() });
        marketingSuppressed = applied.applied;
      }
    }
    return { kind: "delivery_status", status: data.status, marketingSuppressed };
  }

  async function handleTrigger(integration, organization, envelope) {
    const data = parseMarketingTrigger(envelope.data);
    const registered = approvedEvent(data.triggerType, data.triggerVersion);
    if (!registered || registered.product !== integration.product || !integration.allowedTriggerTypes.includes(`${data.triggerType}@${data.triggerVersion}`)) {
      throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 403, { reason: "TRIGGER_NOT_APPROVED_FOR_INTEGRATION" });
    }
    const result = await automations.ingestProductEvent({ organizationId: organization.id, eventType: data.triggerType, version: data.triggerVersion, eventId: `${integration.product}:${envelope.eventId}`, contactEmail: data.contactEmail, occurredAt: envelope.occurredAtDate, payload: data.attributes });
    return { kind: "marketing_trigger", matchedContact: result.matchedContact, droppedFields: result.droppedFields };
  }

  async function handleAlert(integration, envelope) {
    const data = parseOpsAlert(envelope.data, { restricted: integration.classification === "RESTRICTED_HEALTH" });
    const since = new Date(clock().getTime() - 3600000);
    const recent = await client.mailProductIntegrationEvent.count({ where: { integrationId: integration.id, eventType: "ops.alert", status: "ACCEPTED", receivedAt: { gt: since }, outcome: { path: ["code"], equals: data.code } } });
    if (!recent && data.severity !== "info") {
      const admins = await client.adminSectionGrant.findMany({ where: { module: "mail", section: { in: ["admin", `integration:${integration.product}`] }, revokedAt: null }, select: { adminUserId: true } });
      await notifications.notifyUsers([...new Set(admins.map((row) => row.adminUserId))], { icon: data.severity === "critical" ? "xcircle" : "alert", title: `[${integration.product}] ${data.severity}: ${data.code}`, subtitle: data.summary }).catch(() => {});
    }
    return { kind: "ops_alert", code: data.code, severity: data.severity, component: data.component, notified: !recent && data.severity !== "info" };
  }

  // Raw-body HTTP handler: POST /api/mail/v1/integrations/v1/events
  async function ingest(req) {
    if (!config.enabled || !config.integrations.enabled) return reply(503, "MAIL_INTEGRATIONS_DISABLED");
    if (!config.integrations.hashSecret || config.integrations.hashSecret.length < 32) return reply(503, "MAIL_INTEGRATIONS_NOT_CONFIGURED");
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    if (rawBody.length > config.integrations.maxBodyBytes) return reply(413, "MAIL_INTEGRATION_BODY_TOO_LARGE");
    const auth = verifyServiceRequest({ method: req.method, requestUri: req.originalUrl, headers: req.headers, rawBody, secrets: secrets(), maxSkewSeconds: config.integrations.maxSkewSeconds, now: clock().getTime() });
    if (!auth.ok) {
      logger?.warn?.(`[MailIntegration] rejected: ${auth.code}`);
      return reply(401, "MAIL_INTEGRATION_UNAUTHORIZED");
    }
    const integration = await client.mailProductIntegration.findUnique({ where: { serviceName: auth.serviceName } });
    if (!integration) return reply(401, "MAIL_INTEGRATION_UNAUTHORIZED");
    if (integration.status !== "ACTIVE") return reply(403, "MAIL_INTEGRATION_NOT_ACTIVE", { status: integration.status });
    if (await rateLimited(integration.id)) return reply(429, "MAIL_RATE_LIMITED", { retryAfter: 60 });
    // M10: an integration can be registered and approved but not yet rolled out.
    const notRolledOut = rollout ? await rollout.decide("PRODUCT_INTEGRATION", { organizationId: integration.organizationId }) : null;
    if (notRolledOut) return reply(503, "MAIL_ROLLOUT_NOT_ENABLED", { retryAfter: 300, reason: notRolledOut });
    const payloadSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
    let envelope;
    try {
      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new ContractError("MAIL_VALIDATION_FAILED", 422, { field: "body", reason: "INVALID_JSON" });
      }
      envelope = parseEnvelope(body);
      const organization = await client.mailOrganization.findUnique({ where: { id: integration.organizationId } });
      // Spoofing: a service may only speak for its own product and brand.
      if (envelope.product !== integration.product || !organization || envelope.organization !== organization.slug) throw new ContractError("MAIL_INTEGRATION_SCOPE_MISMATCH", 403, {});
      if (!integration.allowedEventTypes.includes(envelope.eventType) || !(EVENT_TYPES_FOR[integration.classification] || []).includes(envelope.eventType)) throw new ContractError("MAIL_INTEGRATION_FORBIDDEN_CONTENT", 403, { reason: "EVENT_TYPE_NOT_ALLOWED", eventType: envelope.eventType });
      const existing = await client.mailProductIntegrationEvent.findUnique({ where: { integrationId_eventId: { integrationId: integration.id, eventId: envelope.eventId } } });
      if (existing) {
        if (existing.payloadSha256 !== payloadSha256) throw new ContractError("MAIL_INTEGRATION_EVENT_CONFLICT", 409, { eventId: envelope.eventId });
        return reply(202, null, { accepted: true, duplicate: true, eventId: envelope.eventId });
      }
      let outcome;
      if (envelope.eventType === "mail.delivery_status") {
        outcome = await client.$transaction(async (tx) => {
          const result = await handleDelivery(tx, integration, organization, envelope);
          await tx.mailProductIntegrationEvent.create({ data: { integrationId: integration.id, eventId: envelope.eventId, eventType: envelope.eventType, eventVersion: envelope.eventVersion, correlationId: envelope.correlationId, payloadSha256, status: "ACCEPTED", outcome: result, occurredAt: envelope.occurredAtDate, receivedAt: clock() } });
          return result;
        });
      } else {
        outcome = envelope.eventType === "marketing.trigger" ? await handleTrigger(integration, organization, envelope) : await handleAlert(integration, envelope);
        await client.mailProductIntegrationEvent.create({ data: { integrationId: integration.id, eventId: envelope.eventId, eventType: envelope.eventType, eventVersion: envelope.eventVersion, correlationId: envelope.correlationId, payloadSha256, status: "ACCEPTED", outcome, occurredAt: envelope.occurredAtDate, receivedAt: clock() } });
      }
      await client.mailProductIntegration.update({ where: { id: integration.id }, data: { lastEventAt: clock() } });
      return reply(202, null, { accepted: true, duplicate: false, eventId: envelope.eventId, outcome: { kind: outcome.kind } });
    } catch (error) {
      if (error?.code === "P2002") return reply(202, null, { accepted: true, duplicate: true, eventId: envelope?.eventId });
      if (error instanceof ContractError || error?.code === "MAIL_INTEGRATION_FORBIDDEN_CONTENT") {
        const code = error.code;
        const status = error.status || 422;
        await recordRejection(integration, envelope, payloadSha256, code, error.details || {});
        return reply(status, code, error.details || {});
      }
      logger?.error?.(`[MailIntegration] ingestion failed: ${error?.code || error?.message}`);
      return reply(503, "MAIL_STORAGE_UNAVAILABLE");
    }
  }

  // ------------------------------------------------------------ administration
  async function viewScope(user, integration = null) {
    policy.assertActiveIdentity(user);
    if (await policy.canAdministerMail(client, user, "VIEW")) return "ALL";
    if (integration && (await policy.hasSection(client, user, "mail", `integration:${integration.product}`, "VIEW"))) return "PRODUCT";
    throw mailError(integration ? "MAIL_NOT_FOUND" : "MAIL_FORBIDDEN", integration ? { resource: "integration" } : { reason: "MAIL_ADMIN_REQUIRED" });
  }

  function serialize(row, organization) {
    const configured = parseServiceSecrets(env.MAIL_INTEGRATION_SERVICE_SECRETS).has(row.serviceName);
    return {
      id: row.id, product: row.product, organization: organization ? { id: organization.id, slug: organization.slug, name: organization.name } : { id: row.organizationId }, serviceName: row.serviceName,
      status: row.status, classification: row.classification, contractVersion: row.contractVersion, allowedEventTypes: row.allowedEventTypes, allowedTriggerTypes: row.allowedTriggerTypes,
      ownerApprovalReference: row.ownerApprovalReference, ownerApprovedBy: row.ownerApprovedBy, approvedAt: iso(row.approvedAt), lastEventAt: iso(row.lastEventAt), lastErrorCode: row.lastErrorCode, lastErrorAt: iso(row.lastErrorAt),
      credentialConfigured: configured, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    };
  }

  async function load(id) {
    const row = policy.isUuid(id) ? await client.mailProductIntegration.findUnique({ where: { id } }) : null;
    if (!row) throw mailError("MAIL_NOT_FOUND", { resource: "integration" });
    return row;
  }

  async function list(user) {
    policy.assertActiveIdentity(user);
    const admin = await policy.canAdministerMail(client, user, "VIEW");
    const rows = await client.mailProductIntegration.findMany({ orderBy: { product: "asc" } });
    const visible = [];
    for (const row of rows) if (admin || (await policy.hasSection(client, user, "mail", `integration:${row.product}`, "VIEW"))) visible.push(row);
    if (!admin && !visible.length) throw mailError("MAIL_FORBIDDEN", { reason: "MAIL_ADMIN_REQUIRED" });
    const organizations = new Map((await client.mailOrganization.findMany({ where: { id: { in: visible.map((row) => row.organizationId) } } })).map((org) => [org.id, org]));
    return visible.map((row) => serialize(row, organizations.get(row.organizationId)));
  }

  function validateTypes(classification, eventTypes = [], triggerTypes = [], product) {
    const allowed = EVENT_TYPES_FOR[classification];
    const events = [...new Set((Array.isArray(eventTypes) ? eventTypes : []).map(String))];
    const triggers = [...new Set((Array.isArray(triggerTypes) ? triggerTypes : []).map(String))];
    if (events.some((type) => !allowed.includes(type))) throw mailError("MAIL_VALIDATION_FAILED", { field: "allowedEventTypes", reason: classification === "RESTRICTED_HEALTH" ? "RESTRICTED_HEALTH_OPS_ALERTS_ONLY" : "UNKNOWN_EVENT_TYPE" });
    for (const trigger of triggers) {
      const [type, version] = trigger.split("@");
      const registered = approvedEvent(type, Number(version));
      if (classification === "RESTRICTED_HEALTH" || !registered || registered.product !== product) throw mailError("MAIL_VALIDATION_FAILED", { field: "allowedTriggerTypes", trigger });
    }
    if (triggers.length && !events.includes("marketing.trigger")) throw mailError("MAIL_VALIDATION_FAILED", { field: "allowedEventTypes", reason: "MARKETING_TRIGGER_REQUIRED_FOR_TRIGGERS" });
    return { events, triggers };
  }

  async function create(user, input, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const product = String(input.product || "").toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(product)) throw mailError("MAIL_VALIDATION_FAILED", { field: "product" });
    const serviceName = String(input.serviceName || "");
    if (!/^[a-z][a-z0-9-]{2,95}$/.test(serviceName)) throw mailError("MAIL_VALIDATION_FAILED", { field: "serviceName" });
    const classification = input.classification || (product.startsWith("healthnet") ? "RESTRICTED_HEALTH" : "STANDARD");
    if (!CLASSIFICATIONS.has(classification)) throw mailError("MAIL_VALIDATION_FAILED", { field: "classification" });
    // HealthNet is always restricted, whatever the request says.
    if (product.startsWith("healthnet") && classification !== "RESTRICTED_HEALTH") throw mailError("MAIL_VALIDATION_FAILED", { field: "classification", reason: "HEALTHNET_MUST_BE_RESTRICTED" });
    const organization = policy.isUuid(input.organizationId) ? await client.mailOrganization.findUnique({ where: { id: input.organizationId } }) : null;
    if (!organization) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    const types = validateTypes(classification, input.allowedEventTypes, input.allowedTriggerTypes, product);
    const row = await client.mailProductIntegration.create({ data: { product, serviceName, organizationId: organization.id, classification, allowedEventTypes: types.events, allowedTriggerTypes: types.triggers, createdBy: user.id, updatedBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "DUPLICATE_PRODUCT_OR_SERVICE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_CREATED", targetType: "mail_integration", targetId: row.id, organizationId: organization.id, metadata: { product, classification, eventTypes: types.events } }, context);
    return serialize(row, organization);
  }

  async function update(user, id, input, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const row = await load(id);
    const types = validateTypes(row.classification, input.allowedEventTypes ?? row.allowedEventTypes, input.allowedTriggerTypes ?? row.allowedTriggerTypes, row.product);
    const updated = await client.mailProductIntegration.update({ where: { id }, data: { allowedEventTypes: types.events, allowedTriggerTypes: types.triggers, updatedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_UPDATED", targetType: "mail_integration", targetId: id, organizationId: row.organizationId, metadata: { eventTypes: types.events, triggerTypes: types.triggers } }, context);
    return serialize(updated, await client.mailOrganization.findUnique({ where: { id: row.organizationId } }));
  }

  // Activation records the product owner's approval and needs an MFA step-up.
  async function activate(user, id, { ownerApprovalReference, ownerApprovedBy, stepUpId } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const row = await load(id);
    const reference = String(ownerApprovalReference || "").trim();
    const approver = String(ownerApprovedBy || "").trim();
    if (reference.length < 3 || approver.length < 3) throw mailError("MAIL_VALIDATION_FAILED", { field: "ownerApprovalReference", reason: "OWNER_APPROVAL_REQUIRED" });
    if (!row.allowedEventTypes.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "allowedEventTypes" });
    const updated = await client.$transaction(async (tx) => {
      await stepUp.consume(tx, user, stepUpId, "MAIL_INTEGRATION_ACTIVATE", context);
      const result = await tx.mailProductIntegration.update({ where: { id }, data: { status: "ACTIVE", ownerApprovalReference: reference.slice(0, 200), ownerApprovedBy: approver.slice(0, 160), approvedAt: clock(), activatedByAdminUserId: user.id, updatedBy: user.id } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_ACTIVATED", targetType: "mail_integration", targetId: id, organizationId: row.organizationId, metadata: { reference: reference.slice(0, 120), approver: approver.slice(0, 80) } }, context, tx);
      return result;
    });
    return serialize(updated, await client.mailOrganization.findUnique({ where: { id: row.organizationId } }));
  }

  async function suspend(user, id, { reason } = {}, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const row = await load(id);
    const updated = await client.mailProductIntegration.update({ where: { id }, data: { status: "SUSPENDED", updatedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_SUSPENDED", targetType: "mail_integration", targetId: id, organizationId: row.organizationId, metadata: { reason: reason ? String(reason).slice(0, 200) : null } }, context);
    return serialize(updated, await client.mailOrganization.findUnique({ where: { id: row.organizationId } }));
  }

  async function listSenders(user, id) {
    const row = await load(id);
    await viewScope(user, row);
    const senders = await client.mailProductSenderAuthorization.findMany({ where: { integrationId: id }, orderBy: { createdAt: "desc" } });
    return senders.map((sender) => ({ id: sender.id, addressId: sender.addressId, address: sender.address, purpose: sender.purpose, active: !sender.revokedAt, createdAt: iso(sender.createdAt), revokedAt: iso(sender.revokedAt) }));
  }

  async function authorizeSender(user, id, { addressId, purpose }, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const row = await load(id);
    if (!PURPOSES.has(purpose)) throw mailError("MAIL_VALIDATION_FAILED", { field: "purpose" });
    if (row.classification === "RESTRICTED_HEALTH" && purpose !== "OPERATIONAL_ALERT") throw mailError("MAIL_VALIDATION_FAILED", { field: "purpose", reason: "RESTRICTED_HEALTH_OPS_ALERTS_ONLY" });
    const address = policy.isUuid(addressId) ? await client.mailAddress.findUnique({ where: { id: addressId }, include: { domain: true } }) : null;
    // Only the integration's own brand, non-personal identities, verified domains.
    if (!address || address.organizationId !== row.organizationId || address.status !== "ACTIVE" || !["SYSTEM", "SHARED", "ALIAS"].includes(address.kind)) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { reason: "BRAND_SYSTEM_IDENTITY_REQUIRED" });
    if (address.domain.status !== "VERIFIED") throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { reason: "DOMAIN_NOT_VERIFIED" });
    const created = await client.mailProductSenderAuthorization.create({ data: { integrationId: id, addressId: address.id, address: address.address, purpose, grantedBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "ALREADY_AUTHORIZED" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_SENDER_AUTHORIZED", targetType: "mail_integration", targetId: id, organizationId: row.organizationId, metadata: { address: address.address, purpose } }, context);
    return { id: created.id, address: created.address, purpose: created.purpose, active: true };
  }

  async function revokeSender(user, id, senderId, context) {
    await policy.requireMailAdmin(client, user, "EDIT");
    const row = await load(id);
    const result = await client.mailProductSenderAuthorization.updateMany({ where: { id: String(senderId), integrationId: id, revokedAt: null }, data: { revokedAt: clock(), revokedBy: user.id } });
    if (!result.count) throw mailError("MAIL_NOT_FOUND", { resource: "sender_authorization" });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_INTEGRATION_SENDER_REVOKED", targetType: "mail_integration", targetId: id, organizationId: row.organizationId, metadata: { senderId } }, context);
    return { revoked: true };
  }

  // Product-isolated operational health (no message content, no addresses).
  async function health(user, id) {
    const row = await load(id);
    await viewScope(user, row);
    const now = clock().getTime();
    const day = new Date(now - 86400000);
    const week = new Date(now - 7 * 86400000);
    const [events, errors, delivery24, delivery7, categories] = await Promise.all([
      client.mailProductIntegrationEvent.groupBy({ by: ["eventType", "status"], where: { integrationId: id, receivedAt: { gt: day } }, _count: { _all: true } }),
      client.mailProductIntegrationEvent.groupBy({ by: ["errorCode"], where: { integrationId: id, status: "REJECTED", receivedAt: { gt: week } }, _count: { _all: true } }),
      client.mailProductDeliveryEvent.groupBy({ by: ["status"], where: { integrationId: id, occurredAt: { gt: day } }, _count: { _all: true } }),
      client.mailProductDeliveryEvent.groupBy({ by: ["status"], where: { integrationId: id, occurredAt: { gt: week } }, _count: { _all: true } }),
      client.mailProductDeliveryEvent.groupBy({ by: ["category", "status"], where: { integrationId: id, occurredAt: { gt: week } }, _count: { _all: true } }),
    ]);
    const flatten = (rows, key) => Object.fromEntries(rows.map((entry) => [entry[key], entry._count._all]));
    const stale = !row.lastEventAt || now - row.lastEventAt.getTime() > 86400000;
    return {
      integration: serialize(row, await client.mailOrganization.findUnique({ where: { id: row.organizationId } })),
      events24h: events.map((entry) => ({ eventType: entry.eventType, status: entry.status, count: entry._count._all })),
      rejections7d: errors.map((entry) => ({ code: entry.errorCode, count: entry._count._all })),
      delivery24h: flatten(delivery24, "status"),
      delivery7d: flatten(delivery7, "status"),
      deliveryByCategory7d: categories.map((entry) => ({ category: entry.category, status: entry.status, count: entry._count._all })),
      warnings: [...(stale && row.status === "ACTIVE" ? ["NO_EVENTS_IN_24H"] : []), ...(row.status === "ACTIVE" && !parseServiceSecrets(env.MAIL_INTEGRATION_SERVICE_SECRETS).has(row.serviceName) ? ["CREDENTIAL_NOT_CONFIGURED"] : [])],
    };
  }

  async function events(user, id, { status, limit } = {}) {
    const row = await load(id);
    await viewScope(user, row);
    const rows = await client.mailProductIntegrationEvent.findMany({ where: { integrationId: id, ...(status ? { status: String(status) } : {}) }, orderBy: { receivedAt: "desc" }, take: Math.min(Math.max(Number(limit) || 50, 1), 200) });
    return rows.map((entry) => ({ id: entry.id, eventId: entry.eventId.startsWith("rejected:") ? null : entry.eventId, eventType: entry.eventType, eventVersion: entry.eventVersion, correlationId: entry.correlationId, status: entry.status, errorCode: entry.errorCode, outcome: entry.outcome, occurredAt: iso(entry.occurredAt), receivedAt: iso(entry.receivedAt) }));
  }

  return { ingest, list, create, update, activate, suspend, listSenders, authorizeSender, revokeSender, health, events, recipientHash };
}

module.exports = { createIntegrationService, EVENT_TYPES_FOR };

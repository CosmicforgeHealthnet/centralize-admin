"use strict";

// Corporate identity administration: organizations/brands, domains, addresses,
// aliases, mailboxes, memberships, sender grants, provisioning, offboarding,
// retention and legal holds. None of these operations exposes mail content,
// and none grants the administrator access to personal mailbox content.

const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { normalizeDomain, normalizeLocalPart, normalizeAddress, cleanDisplayName } = require("../security/address.util");
const { sanitizeEmailHtml } = require("../security/html-sanitizer");
const { iso } = require("./serializers");
const { reservedSenderSet } = require("../security/reserved-senders");
const { MailWebhookStatus, MailDeliveryEventType, MailJobStatus, MailJobQueue } = require("../../../generated/admin-client");

const ROLES = new Set(["OWNER", "MANAGER", "MEMBER", "READER"]);

// Job kinds an operator may replay from DEAD_LETTER/FAILED. Outbound sends and
// marketing dispatches are excluded: their provider outcome may be unknown,
// so they are recovered through reconciliation or a new, reviewed send.
const REQUEUEABLE_JOB_KINDS = new Set(["PROCESS_INBOUND", "PROCESS_DELIVERY_EVENT", "RECONCILE_INBOUND", "OPS_EVALUATE", "SEARCH_INDEX_BACKFILL"]);

function createMailAdminService({ client, config, adapter, audit, notifications, jobs = null, stepUp = null, forwarding = null, clock = () => new Date() }) {
  const admin = (user, mode = "EDIT") => policy.requireMailAdmin(client, user, mode);

  // ---------------------------------------------------------------- orgs
  async function listOrganizations(user) {
    await admin(user, "VIEW");
    return client.mailOrganization.findMany({ orderBy: { name: "asc" } });
  }

  async function createOrganization(user, { slug, name, kind }, context) {
    await admin(user);
    const cleanSlug = String(slug || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(cleanSlug)) throw mailError("MAIL_VALIDATION_FAILED", { field: "slug" });
    const cleanName = String(name || "").trim().slice(0, 160);
    if (!cleanName) throw mailError("MAIL_VALIDATION_FAILED", { field: "name" });
    const row = await client.mailOrganization.create({ data: { slug: cleanSlug, name: cleanName, kind: kind === "COMPANY" ? "COMPANY" : "BRAND", createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "slug", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_ORGANIZATION_CREATED", targetType: "organization", targetId: row.id, organizationId: row.id }, context);
    return row;
  }

  // ---------------------------------------------------------------- domains
  // Domain lifecycle (§18, §19.8). Mail never changes DNS. Local states:
  //   PENDING_VERIFICATION / VERIFIED / FAILED follow the provider's overall
  //   verification result; SUSPENDED is an operator kill-switch that no
  //   provider re-check ever changes (the provider results are still stored).
  // Per-record results (SPF, DKIM, DMARC, receiving) are derived from the
  // stored dnsRecords array plus sending/receivingStatus (no extra column);
  // DMARC is never reported by Resend and stays NOT_REPORTED unless a DMARC
  // record is present.
  const DOMAIN_MANAGE_PURPOSE = "MAIL_DOMAIN_PROVIDER_MANAGE";
  const REGION = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

  function recordAggregate(records, name) {
    const list = (Array.isArray(records) ? records : []).filter((record) => String(record?.record || "").toUpperCase() === name || (name === "DMARC" && String(record?.name || "").toLowerCase().startsWith("_dmarc")));
    if (!list.length) return name === "DMARC" ? "NOT_REPORTED" : "NOT_CONFIGURED";
    const statuses = list.map((record) => String(record.status || "").toLowerCase());
    if (statuses.every((value) => value === "verified")) return "VERIFIED";
    if (statuses.some((value) => value === "failed")) return "FAILED";
    return "PENDING";
  }

  // Per-domain check results for API responses and audit metadata.
  function domainChecks(row, providerResult = null) {
    const records = providerResult?.records ?? row?.dnsRecords;
    return {
      sending: providerResult?.sendingStatus || row?.sendingStatus || "NOT_CONFIGURED",
      receiving: providerResult?.receivingStatus || row?.receivingStatus || "NOT_CONFIGURED",
      spf: providerResult?.spfStatus && providerResult.spfStatus !== "NOT_REPORTED" ? providerResult.spfStatus : recordAggregate(records, "SPF"),
      dkim: providerResult?.dkimStatus && providerResult.dkimStatus !== "NOT_REPORTED" ? providerResult.dkimStatus : recordAggregate(records, "DKIM"),
      dmarc: recordAggregate(records, "DMARC"),
      ...(providerResult ? { providerStatus: providerResult.status || null, region: providerResult.region || null } : {}),
      receivesMail: Boolean(row) && row.status !== "SUSPENDED" && (providerResult?.receivingStatus || row.receivingStatus) !== "DISABLED",
    };
  }

  function withChecks(row, providerResult = null) {
    return { ...row, checks: domainChecks(row, providerResult) };
  }

  function providerManagementEnabled() {
    if (!config.providerDomainManagementEnabled) {
      throw mailError("MAIL_FEATURE_DISABLED", { status: 409, feature: "provider-domain-management", reason: "MAIL_PROVIDER_DOMAIN_MANAGEMENT_DISABLED" }, "Provider domain management is not enabled (MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED).");
    }
  }

  function providerMethod(name) {
    if (typeof adapter?.[name] !== "function") throw mailError("MAIL_PROVIDER_UNAVAILABLE", { status: 501, reason: "NOT_SUPPORTED", operation: name }, "The configured mail provider does not support this operation.");
    return adapter[name];
  }

  function providerFailure(error, operation) {
    if (error?.statusCode) return error; // already a Mail API error
    const category = error?.category || null;
    if (error?.kind === "NOT_CONFIGURED" || category === "NOT_CONFIGURED") return mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: "NOT_CONFIGURED", operation });
    if (category === "NOT_SUPPORTED") return mailError("MAIL_PROVIDER_UNAVAILABLE", { status: 501, reason: "NOT_SUPPORTED", operation });
    if (category === "VALIDATION_FAILED") return mailError("MAIL_VALIDATION_FAILED", { reason: "PROVIDER_REJECTED", operation, providerCode: String(error?.code || "").slice(0, 64) });
    return mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: error?.code || "PROVIDER_ERROR", category, operation });
  }

  function localStatusFor(domain, result) {
    // An operator suspension is never lifted by a provider (re-)check.
    if (domain.status === "SUSPENDED") return "SUSPENDED";
    return result.status === "VERIFIED" ? "VERIFIED" : result.status === "FAILED" ? "FAILED" : "PENDING_VERIFICATION";
  }

  function capability(value) {
    return ["NOT_CONFIGURED", "PENDING", "VERIFIED", "FAILED", "DISABLED"].includes(value) ? value : value ? "PENDING" : "NOT_CONFIGURED";
  }

  async function storeProviderResult(domain, result, { providerDomainId = undefined } = {}) {
    const status = localStatusFor(domain, result);
    const data = {
      status,
      sendingStatus: capability(result.sendingStatus),
      receivingStatus: capability(result.receivingStatus),
      // dnsRecords stays an array (web UI and marketing preflight read it).
      dnsRecords: Array.isArray(result.records) ? result.records : [],
      lastCheckedAt: clock(),
      verifiedAt: status === "VERIFIED" ? domain.verifiedAt || clock() : status === "SUSPENDED" ? domain.verifiedAt : null,
      ...(providerDomainId !== undefined ? { providerDomainId } : {}),
    };
    if (providerDomainId !== undefined) {
      // Link only if nobody linked it meanwhile.
      const updated = await client.mailDomain.updateMany({ where: { id: domain.id, providerDomainId: null }, data });
      if (updated.count !== 1) {
        const current = await client.mailDomain.findUnique({ where: { id: domain.id } });
        if (current?.providerDomainId !== providerDomainId) throw mailError("MAIL_INVALID_TRANSITION", { reason: "PROVIDER_DOMAIN_ALREADY_LINKED" });
        await client.mailDomain.update({ where: { id: domain.id }, data: { ...data, providerDomainId: undefined } });
      }
      return client.mailDomain.findUnique({ where: { id: domain.id } });
    }
    return client.mailDomain.update({ where: { id: domain.id }, data });
  }

  async function assertProviderIdUnclaimed(domain, providerDomainId) {
    const other = await client.mailDomain.findFirst({ where: { providerDomainId, id: { not: domain.id } }, select: { id: true } });
    if (other) throw mailError("MAIL_INVALID_TRANSITION", { reason: "PROVIDER_DOMAIN_LINKED_ELSEWHERE" });
  }

  // Read-only provider lookup by name (GET /domains); null when the provider
  // has no such domain or cannot list domains.
  async function lookupByName(domain) {
    if (typeof adapter?.findDomainByName !== "function") return null;
    let found;
    try {
      found = await adapter.findDomainByName(domain.domain);
    } catch (error) {
      if (error?.kind === "NOT_CONFIGURED" || ["NOT_CONFIGURED", "NOT_SUPPORTED", "NOT_FOUND"].includes(error?.category)) return null;
      throw providerFailure(error, "findDomainByName");
    }
    if (!found?.providerDomainId || (found.name && String(found.name).toLowerCase() !== domain.domain)) return null;
    return found;
  }

  async function loadDomain(domainId) {
    const domain = policy.isUuid(domainId) ? await client.mailDomain.findUnique({ where: { id: domainId } }) : null;
    if (!domain) throw mailError("MAIL_NOT_FOUND", { resource: "domain" });
    return domain;
  }

  async function listDomains(user) {
    await admin(user, "VIEW");
    const rows = await client.mailDomain.findMany({ orderBy: { domain: "asc" }, include: { organization: { select: { id: true, slug: true, name: true } } } });
    return rows.map((row) => withChecks(row));
  }

  async function createDomain(user, { organizationId, domain, providerDomainId }, context) {
    await admin(user);
    const normalized = normalizeDomain(domain);
    if (!normalized) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain" });
    // Fail closed: a registered domain immediately counts as one of our
    // receiving domains, so registration needs an explicit allowlist.
    if (!config.domainAllowlist.length) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: "ALLOWLIST_EMPTY" });
    if (!config.domainAllowlist.includes(normalized)) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: "NOT_ALLOWLISTED" });
    if (!policy.isUuid(organizationId) || !(await client.mailOrganization.findUnique({ where: { id: organizationId } }))) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    if (providerDomainId && !/^[A-Za-z0-9_-]{1,128}$/.test(String(providerDomainId))) throw mailError("MAIL_VALIDATION_FAILED", { field: "providerDomainId" });
    const row = await client.mailDomain.create({ data: { organizationId, domain: normalized, providerDomainId: providerDomainId || null, createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_CREATED", targetType: "domain", targetId: row.id, organizationId, metadata: { domain: normalized } }, context);
    return row;
  }

  // Reads verification state from the provider (GET /domains/{id}). Never
  // changes DNS/MX. Without a stored provider id a read-only lookup by name
  // links an existing provider domain. With options.trigger (provider domain
  // management enabled + MFA step-up) the provider is first asked to re-check
  // (POST /domains/{id}/verify, asynchronous).
  async function verifyDomain(user, domainId, context = {}, options = {}) {
    await admin(user);
    let domain = await loadDomain(domainId);
    const trigger = options.trigger === true || options.trigger === "true";
    if (trigger) {
      providerManagementEnabled();
      providerMethod("verifyDomain");
    }
    let linked = false;
    if (!domain.providerDomainId) {
      const found = await lookupByName(domain);
      if (!found) throw mailError("MAIL_VALIDATION_FAILED", { field: "providerDomainId", reason: "REQUIRED_FOR_VERIFICATION" });
      await assertProviderIdUnclaimed(domain, found.providerDomainId);
      domain = await storeProviderResult(domain, found, { providerDomainId: found.providerDomainId });
      linked = true;
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_PROVIDER_LINKED", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, metadata: { providerDomainId: found.providerDomainId, via: "lookup-by-name" } }, context);
    }
    if (trigger) {
      await client.$transaction(async (tx) => stepUp.consume(tx, user, options.stepUpId, DOMAIN_MANAGE_PURPOSE, context));
      try {
        await adapter.verifyDomain(domain.providerDomainId);
      } catch (error) {
        throw providerFailure(error, "verifyDomain");
      }
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_VERIFICATION_TRIGGERED", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, metadata: { providerDomainId: domain.providerDomainId } }, context);
    }
    let result;
    try {
      result = await adapter.validateDomain(domain.providerDomainId);
    } catch (error) {
      throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: error.code || "PROVIDER_ERROR" });
    }
    const row = await storeProviderResult(domain, result);
    const checks = domainChecks(row, result);
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_VERIFICATION_CHECKED", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, metadata: { status: row.status, providerStatus: result.status || null, suspended: row.status === "SUSPENDED", sending: result.sendingStatus, receiving: result.receivingStatus, spf: checks.spf, dkim: checks.dkim, dmarc: checks.dmarc, triggered: trigger, linked } }, context);
    return { ...row, checks, verificationTriggered: trigger, providerLinked: linked };
  }

  // Provider-side registration (POST /domains), server-side only: Mail admin
  // + MFA step-up, behind MAIL_PROVIDER_DOMAIN_MANAGEMENT_ENABLED. The domain
  // must be registered locally and on MAIL_DOMAIN_ALLOWLIST. POST /domains is
  // not idempotent, so an existing provider domain of the same name is
  // linked instead of created, and an ambiguous create (timeout, unknown
  // outcome, conflict) is resolved by looking the name up before anything is
  // retried. DNS is never changed: the returned records are for the operator.
  async function registerProviderDomain(user, domainId, { stepUpId, receiving = false, region = null } = {}, context = {}) {
    await admin(user);
    providerManagementEnabled();
    const create = providerMethod("createDomain");
    providerMethod("findDomainByName");
    const domain = await loadDomain(domainId);
    if (!config.domainAllowlist.length || !config.domainAllowlist.includes(domain.domain)) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: config.domainAllowlist.length ? "NOT_ALLOWLISTED" : "ALLOWLIST_EMPTY" });
    if (domain.status === "SUSPENDED") throw mailError("MAIL_INVALID_TRANSITION", { reason: "DOMAIN_SUSPENDED" });
    if (domain.providerDomainId) throw mailError("MAIL_INVALID_TRANSITION", { reason: "PROVIDER_DOMAIN_ALREADY_LINKED" });
    const cleanRegion = region == null || region === "" ? null : String(region).trim().toLowerCase();
    if (cleanRegion && !REGION.test(cleanRegion)) throw mailError("MAIL_VALIDATION_FAILED", { field: "region" });
    await client.$transaction(async (tx) => stepUp.consume(tx, user, stepUpId, DOMAIN_MANAGE_PURPOSE, context));

    let outcome = "LINKED_EXISTING";
    let result = await lookupByName(domain);
    if (!result) {
      try {
        result = await create.call(adapter, { name: domain.domain, region: cleanRegion, receiving: receiving === true || receiving === "true" });
        outcome = "CREATED";
      } catch (error) {
        const ambiguous = error?.kind === "AMBIGUOUS" || ["OUTCOME_UNKNOWN", "TIMEOUT", "CONFLICT"].includes(error?.category) || error?.kind === "IDEMPOTENCY_CONFLICT";
        if (!ambiguous) throw providerFailure(error, "createDomain");
        // The create may have happened: look before anyone retries.
        result = await lookupByName(domain);
        if (!result) {
          await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_PROVIDER_REGISTRATION_UNKNOWN", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, outcome: "FAILURE", metadata: { category: error?.category || null, code: String(error?.code || "").slice(0, 64) } }, context);
          throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: "OUTCOME_UNKNOWN", operation: "createDomain" }, "The provider did not confirm the registration. Retry: the domain is looked up by name before anything is created again.");
        }
        outcome = "LINKED_AFTER_AMBIGUOUS_CREATE";
      }
    }
    if (!result?.providerDomainId) throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: "PROVIDER_NO_ID", operation: "createDomain" });
    await assertProviderIdUnclaimed(domain, result.providerDomainId);
    const row = await storeProviderResult(domain, result, { providerDomainId: result.providerDomainId });
    const checks = domainChecks(row, result);
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_PROVIDER_REGISTERED", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, metadata: { outcome, providerDomainId: result.providerDomainId, status: row.status, providerStatus: result.status || null, sending: checks.sending, receiving: checks.receiving, spf: checks.spf, dkim: checks.dkim, dmarc: checks.dmarc, region: result.region || cleanRegion } }, context);
    return { ...row, checks, registration: outcome };
  }

  // ---------------------------------------------------------------- addresses
  async function assertNoAliasLoop(tx, aliasOfAddressId, mailboxId) {
    // Aliases route directly to a mailbox and may only point at a non-alias
    // address of the same mailbox, so chains (and therefore loops) cannot exist.
    const seen = new Set();
    let current = aliasOfAddressId;
    while (current) {
      if (seen.has(current)) throw mailError("MAIL_ALIAS_LOOP");
      seen.add(current);
      const target = await tx.mailAddress.findUnique({ where: { id: current } });
      if (!target) throw mailError("MAIL_VALIDATION_FAILED", { field: "aliasOfAddressId" });
      if (target.kind === "ALIAS") throw mailError("MAIL_ALIAS_LOOP", { reason: "ALIAS_OF_ALIAS" });
      if (target.mailboxId !== mailboxId) throw mailError("MAIL_VALIDATION_FAILED", { field: "aliasOfAddressId", reason: "DIFFERENT_MAILBOX" });
      current = target.aliasOfAddressId;
    }
  }

  async function createAddressTx(tx, user, { domainId, localPart, kind, mailboxId, aliasOfAddressId, displayName, status = "ACTIVE" }) {
    const domain = policy.isUuid(domainId) ? await tx.mailDomain.findUnique({ where: { id: domainId } }) : null;
    if (!domain) throw mailError("MAIL_VALIDATION_FAILED", { field: "domainId" });
    if (domain.status === "SUSPENDED") throw mailError("MAIL_VALIDATION_FAILED", { field: "domainId", reason: "DOMAIN_SUSPENDED" });
    const local = normalizeLocalPart(localPart);
    if (!local) throw mailError("MAIL_VALIDATION_FAILED", { field: "localPart" });
    if (!["PRIMARY", "ALIAS", "SHARED", "SYSTEM"].includes(kind)) throw mailError("MAIL_VALIDATION_FAILED", { field: "kind" });
    let mailbox = null;
    if (mailboxId) {
      mailbox = await tx.mailMailbox.findUnique({ where: { id: mailboxId } });
      if (!mailbox || mailbox.organizationId !== domain.organizationId) throw mailError("MAIL_VALIDATION_FAILED", { field: "mailboxId" });
      if (kind === "PRIMARY" && mailbox.type !== "PERSONAL") throw mailError("MAIL_VALIDATION_FAILED", { field: "kind", reason: "PRIMARY_REQUIRES_PERSONAL" });
      if (kind === "SHARED" && mailbox.type !== "SHARED") throw mailError("MAIL_VALIDATION_FAILED", { field: "kind", reason: "SHARED_REQUIRES_SHARED_MAILBOX" });
      if (kind === "PRIMARY") {
        const existingPrimary = await tx.mailAddress.findFirst({ where: { mailboxId, kind: "PRIMARY", status: { not: "RETIRED" } } });
        if (existingPrimary) throw mailError("MAIL_ADDRESS_TAKEN", { reason: "MAILBOX_HAS_PRIMARY" });
      }
    } else if (kind !== "SYSTEM") {
      throw mailError("MAIL_VALIDATION_FAILED", { field: "mailboxId" });
    }
    if (kind === "ALIAS") {
      if (!policy.isUuid(aliasOfAddressId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "aliasOfAddressId" });
      await assertNoAliasLoop(tx, aliasOfAddressId, mailboxId);
    }
    const address = `${local}@${domain.domain}`;
    // A reserved sender (owned by another system, e.g. KarryGo's no-reply@)
    // can only be reserved here as a SYSTEM address with no mailbox: never a
    // shared inbox, a personal address or an alias anyone could send as.
    if (reservedSenderSet(config).has(address) && (kind !== "SYSTEM" || mailboxId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "localPart", reason: "RESERVED_ADDRESS_SYSTEM_ONLY" });
    try {
      return await tx.mailAddress.create({
        data: { organizationId: domain.organizationId, domainId: domain.id, mailboxId: mailboxId || null, localPart: local, address, kind, status, aliasOfAddressId: kind === "ALIAS" ? aliasOfAddressId : null, displayName: cleanDisplayName(displayName), createdBy: user.id },
      });
    } catch (error) {
      if (error.code === "P2002") throw mailError("MAIL_ADDRESS_TAKEN", { address });
      throw error;
    }
  }

  async function listAddresses(user, { organizationId, mailboxId } = {}) {
    await admin(user, "VIEW");
    return client.mailAddress.findMany({ where: { ...(organizationId ? { organizationId } : {}), ...(mailboxId ? { mailboxId } : {}) }, orderBy: { address: "asc" }, take: 500 });
  }

  async function createAddress(user, input, context) {
    await admin(user);
    const row = await client.$transaction((tx) => createAddressTx(tx, user, input));
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_ADDRESS_CREATED", targetType: "address", targetId: row.id, mailboxId: row.mailboxId, organizationId: row.organizationId, metadata: { address: row.address, kind: row.kind } }, context);
    return row;
  }

  // Address state machine (§20):
  //   ACTIVE <-> SUSPENDED, ACTIVE | SUSPENDED -> RETIRED; RETIRED is terminal
  //   (a retired address is never reused); a no-op transition is refused.
  //   An address cannot become ACTIVE while its domain is SUSPENDED.
  // Creation (createAddressTx) is allowed on PENDING_VERIFICATION and FAILED
  // domains on purpose: addresses are prepared before/while DNS is verified.
  // Inbound routing then follows the domain's receiving state and external
  // sending stays blocked by the sending gate until the domain is VERIFIED;
  // only a SUSPENDED domain refuses new addresses.
  const ADDRESS_TRANSITIONS = Object.freeze({ ACTIVE: ["SUSPENDED", "RETIRED"], SUSPENDED: ["ACTIVE", "RETIRED"], RETIRED: [] });

  async function updateAddressStatus(user, addressId, { status } = {}, context) {
    await admin(user);
    if (!Object.prototype.hasOwnProperty.call(ADDRESS_TRANSITIONS, status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
    const existing = policy.isUuid(addressId) ? await client.mailAddress.findUnique({ where: { id: addressId } }) : null;
    if (!existing) throw mailError("MAIL_NOT_FOUND", { resource: "address" });
    if (existing.status === status) throw mailError("MAIL_INVALID_TRANSITION", { from: existing.status, to: status, reason: "NO_OP" });
    if (!ADDRESS_TRANSITIONS[existing.status]?.includes(status)) throw mailError("MAIL_INVALID_TRANSITION", { from: existing.status, to: status });
    if (status === "ACTIVE") {
      const domain = await client.mailDomain.findUnique({ where: { id: existing.domainId }, select: { status: true } });
      if (!domain || domain.status === "SUSPENDED") throw mailError("MAIL_INVALID_TRANSITION", { from: existing.status, to: status, reason: "DOMAIN_SUSPENDED" });
    }
    // Compare-and-set on the state we validated (concurrent changes lose).
    const changed = await client.mailAddress.updateMany({ where: { id: addressId, status: existing.status }, data: { status, retiredAt: status === "RETIRED" ? clock() : null } });
    if (changed.count !== 1) throw mailError("MAIL_INVALID_TRANSITION", { from: "CHANGED" });
    const row = await client.mailAddress.findUnique({ where: { id: addressId } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_ADDRESS_STATUS_CHANGED", targetType: "address", targetId: addressId, mailboxId: row.mailboxId, metadata: { from: existing.status, to: status } }, context);
    return row;
  }

  // ---------------------------------------------------------------- mailboxes
  async function listMailboxes(user, { organizationId } = {}) {
    await admin(user, "VIEW");
    const rows = await client.mailMailbox.findMany({
      where: organizationId ? { organizationId } : {},
      include: { addresses: { select: { id: true, address: true, kind: true, status: true } }, owner: { select: { id: true, name: true, email: true } }, _count: { select: { memberships: { where: { revokedAt: null } } } } },
      orderBy: { name: "asc" },
      take: 500,
    });
    return rows.map((row) => ({ id: row.id, organizationId: row.organizationId, type: row.type, purpose: row.purpose, name: row.name, status: row.status, owner: row.owner, addresses: row.addresses, memberCount: row._count.memberships, createdAt: iso(row.createdAt) }));
  }

  async function createMailboxTx(tx, user, { organizationId, type, name, purpose, ownerAdminUserId, slaFirstResponseMinutes }) {
    if (!["PERSONAL", "SHARED"].includes(type)) throw mailError("MAIL_VALIDATION_FAILED", { field: "type" });
    const organization = policy.isUuid(organizationId) ? await tx.mailOrganization.findUnique({ where: { id: organizationId } }) : null;
    if (!organization) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    let owner = null;
    if (type === "PERSONAL") {
      owner = await tx.adminUser.findUnique({ where: { id: String(ownerAdminUserId || "") }, select: { id: true, name: true, status: true } });
      if (!owner || owner.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "ownerAdminUserId", reason: "ACTIVE_EMPLOYEE_REQUIRED" });
    }
    const mailbox = await tx.mailMailbox.create({
      data: {
        organizationId,
        type,
        purpose: ["GENERAL", "SUPPORT", "MARKETING"].includes(purpose) ? purpose : "GENERAL",
        name: String(name || owner?.name || "").trim().slice(0, 160) || "Mailbox",
        ownerAdminUserId: owner?.id || null,
        slaFirstResponseMinutes: Number.isInteger(slaFirstResponseMinutes) && slaFirstResponseMinutes > 0 ? slaFirstResponseMinutes : null,
        createdBy: user.id,
      },
    }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "ownerAdminUserId", reason: "PERSONAL_MAILBOX_EXISTS" });
      throw error;
    });
    if (owner) {
      await tx.mailMembership.create({ data: { mailboxId: mailbox.id, adminUserId: owner.id, role: "OWNER", canSend: true, grantedBy: user.id, reason: "personal mailbox owner" } });
    }
    return mailbox;
  }

  async function createMailbox(user, input, context) {
    await admin(user);
    const mailbox = await client.$transaction(async (tx) => {
      const created = await createMailboxTx(tx, user, input);
      if (input.address) await createAddressTx(tx, user, { ...input.address, kind: created.type === "PERSONAL" ? "PRIMARY" : "SHARED", mailboxId: created.id });
      return created;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_MAILBOX_CREATED", targetType: "mailbox", targetId: mailbox.id, mailboxId: mailbox.id, organizationId: mailbox.organizationId, metadata: { type: mailbox.type, purpose: mailbox.purpose } }, context);
    return mailbox;
  }

  async function setMailboxStatus(user, mailboxId, status, context) {
    await admin(user);
    const mailbox = policy.isUuid(mailboxId) ? await client.mailMailbox.findUnique({ where: { id: mailboxId } }) : null;
    if (!mailbox) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    const row = await client.mailMailbox.update({ where: { id: mailboxId }, data: { status, suspendedAt: status === "SUSPENDED" ? clock() : null } });
    await audit.record({ actorAdminUserId: user.id, action: status === "ACTIVE" ? "MAIL_MAILBOX_REACTIVATED" : "MAIL_MAILBOX_SUSPENDED", targetType: "mailbox", targetId: mailboxId, mailboxId }, context);
    // Suspension stops forwarding; reactivation does NOT re-enable it.
    if (status !== "ACTIVE" && forwarding) await forwarding.disableForMailbox(mailboxId, "MAILBOX_SUSPENDED", user.id, context);
    return row;
  }

  // ---------------------------------------------------------------- memberships
  // Managers/owners may manage their mailbox. Mail admins may manage SHARED
  // mailboxes only: they can never add anyone (including themselves) to a
  // PERSONAL mailbox, which would bypass personal mailbox privacy.
  async function authorizeMembershipChange(user, mailboxId) {
    return (await membershipAuthority(user, mailboxId)).mailbox;
  }

  // Who may change memberships, and by which authority: `manager` (an
  // OWNER/MANAGER member, or the personal mailbox owner) or `admin` (a mail
  // administrator acting on a SHARED mailbox without being its manager).
  async function membershipAuthority(user, mailboxId) {
    policy.assertActiveIdentity(user);
    const mailbox = policy.isUuid(mailboxId) ? await client.mailMailbox.findUnique({ where: { id: mailboxId } }) : null;
    if (!mailbox) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    const access = await policy.resolveMailboxAccess(client, user, mailboxId);
    const isManager = access && !access.viaBreakGlass && policy.roleSatisfies(access.role, "MANAGER");
    if (mailbox.type === "PERSONAL") {
      if (!access || access.role !== "OWNER" || mailbox.ownerAdminUserId !== user.id) throw mailError("MAIL_FORBIDDEN", { reason: "PERSONAL_MAILBOX_OWNER_ONLY" });
      return { mailbox, access, via: "manager" };
    }
    if (isManager) return { mailbox, access, via: "manager" };
    if (await policy.canAdministerMail(client, user, "EDIT")) return { mailbox, access, via: "admin" };
    throw mailError(access ? "MAIL_FORBIDDEN" : "MAIL_NOT_FOUND", { resource: "mailbox", reason: "MANAGER_REQUIRED" });
  }

  async function listMembers(user, mailboxId) {
    await authorizeMembershipChange(user, mailboxId);
    const rows = await client.mailMembership.findMany({ where: { mailboxId, revokedAt: null }, include: { adminUser: { select: { id: true, name: true, email: true, status: true } } }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({ id: row.id, adminUser: row.adminUser, role: row.role, canSend: row.canSend, expiresAt: iso(row.expiresAt), createdAt: iso(row.createdAt) }));
  }

  // Separation of duties: nobody grants or elevates their OWN membership
  // (SUPER and mail admins included; another administrator or the mailbox
  // owner/manager must do it), and an administrator granting access to a
  // SHARED mailbox they do not manage needs a fresh MFA step-up
  // (MAIL_MEMBERSHIP_GRANT). Mailbox managers adding other people are
  // unchanged.
  async function addMember(user, mailboxId, { adminUserId, role, canSend, expiresAt, reason, stepUpId } = {}, context = {}) {
    const { mailbox, via } = await membershipAuthority(user, mailboxId);
    if (!ROLES.has(role) || role === "OWNER") throw mailError("MAIL_VALIDATION_FAILED", { field: "role" });
    const member = await client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true, status: true } });
    if (!member || member.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "adminUserId", reason: "ACTIVE_EMPLOYEE_REQUIRED" });
    if (member.id === user.id) {
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_MEMBERSHIP_SELF_GRANT_REFUSED", targetType: "mailbox", targetId: mailbox.id, mailboxId: mailbox.id, outcome: "DENIED", metadata: { role, via } }, context);
      throw mailError("MAIL_FORBIDDEN", { reason: "SELF_GRANT_NOT_ALLOWED" }, "You cannot grant mailbox access to yourself. Ask another administrator or the mailbox owner.");
    }
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && (Number.isNaN(expiry.getTime()) || expiry <= clock())) throw mailError("MAIL_VALIDATION_FAILED", { field: "expiresAt" });
    const row = await client.$transaction(async (tx) => {
      if (via === "admin") await stepUp.consume(tx, user, stepUpId, "MAIL_MEMBERSHIP_GRANT", context);
      await tx.mailMembership.updateMany({ where: { mailboxId, adminUserId: member.id, revokedAt: null }, data: { revokedAt: clock(), revokedBy: user.id } });
      return tx.mailMembership.create({ data: { mailboxId, adminUserId: member.id, role, canSend: Boolean(canSend) && role !== "READER", grantedBy: user.id, expiresAt: expiry, reason: reason ? String(reason).slice(0, 500) : null } });
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_MEMBERSHIP_GRANTED", targetType: "membership", targetId: row.id, mailboxId, metadata: { member: member.id, role, canSend: row.canSend, via, stepUp: via === "admin" } }, context);
    await notifications.notifyUsers([member.id], { icon: "check", title: `You were added to ${mailbox.name}`, subtitle: `Role: ${role.toLowerCase()}` });
    return row;
  }

  async function revokeMember(user, mailboxId, membershipId, context) {
    await authorizeMembershipChange(user, mailboxId);
    const membership = policy.isUuid(membershipId) ? await client.mailMembership.findUnique({ where: { id: membershipId } }) : null;
    if (!membership || membership.mailboxId !== mailboxId || membership.revokedAt) throw mailError("MAIL_NOT_FOUND", { resource: "membership" });
    if (membership.role === "OWNER") throw mailError("MAIL_INVALID_TRANSITION", { reason: "OWNER_MEMBERSHIP_USE_OFFBOARDING" });
    await client.mailMembership.update({ where: { id: membershipId }, data: { revokedAt: clock(), revokedBy: user.id } });
    await client.mailSenderGrant.updateMany({ where: { mailboxId, adminUserId: membership.adminUserId, revokedAt: null }, data: { revokedAt: clock(), revokedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_MEMBERSHIP_REVOKED", targetType: "membership", targetId: membershipId, mailboxId, metadata: { member: membership.adminUserId } }, context);
    return { revoked: true };
  }

  async function updateMailboxSettings(user, mailboxId, input, context) {
    await authorizeMembershipChange(user, mailboxId);
    const data = {};
    if (input.signatureHtml !== undefined) data.signatureHtml = input.signatureHtml ? sanitizeEmailHtml(String(input.signatureHtml).slice(0, 20000)).html : null;
    if (input.slaFirstResponseMinutes !== undefined) {
      const minutes = input.slaFirstResponseMinutes == null ? null : Number(input.slaFirstResponseMinutes);
      if (minutes != null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080)) throw mailError("MAIL_VALIDATION_FAILED", { field: "slaFirstResponseMinutes" });
      data.slaFirstResponseMinutes = minutes;
    }
    if (input.supportTicketLinkEnabled !== undefined) data.supportTicketLinkEnabled = Boolean(input.supportTicketLinkEnabled);
    if (!Object.keys(data).length) throw mailError("MAIL_VALIDATION_FAILED", { field: "settings" });
    const row = await client.mailMailbox.update({ where: { id: mailboxId }, data });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_MAILBOX_SETTINGS_UPDATED", targetType: "mailbox", targetId: mailboxId, mailboxId, metadata: { fields: Object.keys(data) } }, context);
    return { id: row.id, signatureHtml: row.signatureHtml, slaFirstResponseMinutes: row.slaFirstResponseMinutes, supportTicketLinkEnabled: row.supportTicketLinkEnabled };
  }

  // Staff directory for membership pickers: ACTIVE employees only, minimal
  // fields, available to mail admins and shared-mailbox managers.
  async function staffDirectory(user, q) {
    policy.assertActiveIdentity(user);
    const isAdmin = await policy.canAdministerMail(client, user, "EDIT");
    const manages = await client.mailMembership.count({ where: { adminUserId: user.id, revokedAt: null, role: { in: ["OWNER", "MANAGER"] } } });
    if (!isAdmin && !manages) throw mailError("MAIL_FORBIDDEN", { reason: "MANAGER_REQUIRED" });
    const term = String(q || "").trim().slice(0, 80);
    if (term.length < 2) return [];
    const rows = await client.adminUser.findMany({ where: { status: "ACTIVE", OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term.toLowerCase() } }] }, select: { id: true, name: true, email: true, department: true }, take: 20, orderBy: { name: "asc" } });
    return rows;
  }

  // ---------------------------------------------------------------- sender grants
  // Shared by direct grants, grant requests and their approval, so a request
  // can never grant more than a mail administrator could grant directly.
  async function validateSenderGrant(db, { mailboxId, addressId, adminUserId }) {
    const [mailbox, address, member] = await Promise.all([
      policy.isUuid(mailboxId) ? db.mailMailbox.findUnique({ where: { id: mailboxId } }) : null,
      policy.isUuid(addressId) ? db.mailAddress.findUnique({ where: { id: addressId } }) : null,
      db.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true, status: true } }),
    ]);
    if (!mailbox || !address || !member || member.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "grant" });
    if (address.organizationId !== mailbox.organizationId || address.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "addressId" });
    // Automated/system identities (no-reply@ and other reserved senders) are
    // never delegated to people.
    if (address.kind === "SYSTEM" || reservedSenderSet(config).has(address.address)) throw mailError("MAIL_FORBIDDEN", { reason: "SYSTEM_IDENTITY_NOT_GRANTABLE" });
    // Sending as a personal identity requires that person's own delegation.
    if (address.kind === "PRIMARY" && address.mailboxId !== mailbox.id) throw mailError("MAIL_FORBIDDEN", { reason: "PERSONAL_IDENTITY_DELEGATION_OWNER_ONLY" });
    const membership = await db.mailMembership.findFirst({ where: { mailboxId, adminUserId: member.id, revokedAt: null } });
    if (!membership) throw mailError("MAIL_VALIDATION_FAILED", { field: "adminUserId", reason: "MAILBOX_MEMBERSHIP_REQUIRED" });
    return { mailbox, address, member };
  }

  async function grantSender(user, { mailboxId, addressId, adminUserId, expiresAt }, context) {
    await admin(user);
    const { member } = await validateSenderGrant(client, { mailboxId, addressId, adminUserId });
    const row = await client.mailSenderGrant.create({ data: { mailboxId, addressId, adminUserId: member.id, grantedBy: user.id, expiresAt: expiresAt ? new Date(expiresAt) : null } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "GRANT_EXISTS" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_SENDER_GRANTED", targetType: "sender_grant", targetId: row.id, mailboxId, metadata: { addressId, member: member.id } }, context);
    return row;
  }

  async function listSenderGrants(user, { mailboxId } = {}) {
    await admin(user, "VIEW");
    const rows = await client.mailSenderGrant.findMany({
      where: { revokedAt: null, ...(policy.isUuid(mailboxId) ? { mailboxId } : {}) },
      include: { address: { select: { id: true, address: true, kind: true } }, mailbox: { select: { id: true, name: true } }, adminUser: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return rows.map((row) => ({ id: row.id, mailbox: row.mailbox, address: row.address, member: row.adminUser, grantedBy: row.grantedBy, expiresAt: iso(row.expiresAt), createdAt: iso(row.createdAt) }));
  }

  async function revokeSender(user, grantId, context) {
    await admin(user);
    const grant = policy.isUuid(grantId) ? await client.mailSenderGrant.findUnique({ where: { id: grantId } }) : null;
    if (!grant || grant.revokedAt) throw mailError("MAIL_NOT_FOUND", { resource: "sender_grant" });
    await client.mailSenderGrant.update({ where: { id: grantId }, data: { revokedAt: clock(), revokedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_SENDER_REVOKED", targetType: "sender_grant", targetId: grantId, mailboxId: grant.mailboxId }, context);
    return { revoked: true };
  }

  // ---------------------------------------------------------------- offboarding
  async function performOffboarding(actorId, subjectId, context, extra = {}) {
    const now = clock();
    const summary = await client.$transaction(async (tx) => {
      const memberships = await tx.mailMembership.updateMany({ where: { adminUserId: subjectId, revokedAt: null }, data: { revokedAt: now, revokedBy: actorId } });
      const grants = await tx.mailSenderGrant.updateMany({ where: { adminUserId: subjectId, revokedAt: null }, data: { revokedAt: now, revokedBy: actorId } });
      const mailboxes = await tx.mailMailbox.findMany({ where: { ownerAdminUserId: subjectId, type: "PERSONAL" }, select: { id: true } });
      await tx.mailMailbox.updateMany({ where: { id: { in: mailboxes.map((mailbox) => mailbox.id) } }, data: { status: "SUSPENDED", suspendedAt: now, offboardedAt: now } });
      await tx.mailAddress.updateMany({ where: { mailboxId: { in: mailboxes.map((mailbox) => mailbox.id) }, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
      await tx.mailDraft.updateMany({ where: { authorAdminUserId: subjectId, status: "ACTIVE" }, data: { status: "DISCARDED", encryptedBody: null } });
      return { membershipsRevoked: memberships.count, senderGrantsRevoked: grants.count, mailboxesSuspended: mailboxes.length };
    });
    // Former employees' mail is never silently forwarded (spec 5.4).
    let forwardingDisabled = 0;
    if (forwarding) {
      const owned = await client.mailMailbox.findMany({ where: { ownerAdminUserId: subjectId, type: "PERSONAL" }, select: { id: true } });
      for (const mailbox of owned) forwardingDisabled += await forwarding.disableForMailbox(mailbox.id, "OFFBOARDED", actorId, context);
      forwardingDisabled += await forwarding.disableForRequester(subjectId, "REQUESTER_OFFBOARDED", actorId, context);
    }
    await audit.record({ actorAdminUserId: actorId, action: "MAIL_USER_OFFBOARDED", targetType: "admin_user", targetId: subjectId, metadata: { ...summary, forwardingDisabled, ...extra } }, context);
    return { ...summary, forwardingDisabled, historyRetained: true };
  }

  async function offboardUser(user, adminUserId, context) {
    await admin(user);
    const subject = await client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true } });
    if (!subject) throw mailError("MAIL_NOT_FOUND", { resource: "admin_user" });
    return performOffboarding(user.id, subject.id, context);
  }

  // HR account lifecycle (deactivate, lock, delete attempt). A system action:
  // HR needs no Mail administration grant, the HR operator is recorded as the
  // actor. Reactivating the account later restores nothing.
  async function offboardForAccountLifecycle(adminUserId, { actorAdminUserId = null, trigger = "HR_ACCOUNT_DEACTIVATED" } = {}, context = {}) {
    const subject = await client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true } });
    if (!subject) throw mailError("MAIL_NOT_FOUND", { resource: "admin_user" });
    return performOffboarding(actorAdminUserId, subject.id, context, { trigger: String(trigger).slice(0, 64), source: "hrm", system: true });
  }

  // ---------------------------------------------------------------- provisioning
  // Real provisioning booleans for /me/entitlements. Every active employee may
  // request for themselves; requests for others need HR or Mail admin authority.
  async function provisioningCapabilities(user) {
    policy.assertActiveIdentity(user);
    const [forOthers, approve] = await Promise.all([policy.canRequestProvisioningForOthers(client, user), policy.canAdministerMail(client, user, "EDIT")]);
    return { canProvision: true, canProvisionForOthers: Boolean(forOthers), canApproveProvisioning: Boolean(approve) };
  }

  async function listProvisionRequests(user) {
    policy.assertActiveIdentity(user);
    const isAdmin = await policy.canAdministerMail(client, user, "VIEW");
    return client.mailProvisionRequest.findMany({ where: isAdmin ? {} : { requestedByAdminUserId: user.id }, orderBy: { createdAt: "desc" }, take: 200 });
  }

  async function createProvisionRequest(user, input, context) {
    policy.assertActiveIdentity(user);
    const type = input.type;
    if (!["PERSONAL_MAILBOX", "SHARED_MAILBOX", "ALIAS", "SENDER_GRANT"].includes(type)) throw mailError("MAIL_VALIDATION_FAILED", { field: "type" });
    // Accept a full requested address ("name@domain") and resolve it to a
    // registered domain; unknown domains are rejected (no auto-provisioning).
    if (input.requestedAddress && !input.localPart) {
      const normalized = normalizeAddress(input.requestedAddress);
      if (!normalized) throw mailError("MAIL_VALIDATION_FAILED", { field: "requestedAddress" });
      const [localPart, domainName] = normalized.split("@");
      const domain = await client.mailDomain.findUnique({ where: { domain: domainName } });
      if (!domain) throw mailError("MAIL_VALIDATION_FAILED", { field: "requestedAddress", reason: "DOMAIN_NOT_REGISTERED" });
      input = { ...input, localPart, domainId: domain.id, organizationId: input.organizationId || domain.organizationId };
      if (domain.organizationId !== input.organizationId) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId", reason: "DOMAIN_ORGANIZATION_MISMATCH" });
    }
    const organization = policy.isUuid(input.organizationId) ? await client.mailOrganization.findUnique({ where: { id: input.organizationId } }) : null;
    if (!organization) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    const isAdmin = await policy.canAdministerMail(client, user, "EDIT");
    // A request about someone else needs HR/Mail-admin authority, for every
    // type. It is refused, never silently re-targeted at the caller.
    const requestedSubject = input.subjectAdminUserId ? String(input.subjectAdminUserId) : null;
    const onBehalf = Boolean(requestedSubject) && requestedSubject !== user.id;
    if (onBehalf && !(await policy.canRequestProvisioningForOthers(client, user))) throw mailError("MAIL_FORBIDDEN", { reason: "PROVISIONING_FOR_OTHERS_NOT_ALLOWED" });
    const subjectAdminUserId = requestedSubject || (type === "PERSONAL_MAILBOX" ? user.id : null);
    if (onBehalf) {
      const subject = await client.adminUser.findUnique({ where: { id: subjectAdminUserId }, select: { id: true, status: true } });
      if (!subject || ["INACTIVE", "LOCKED"].includes(subject.status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "subjectAdminUserId" });
    }
    if ((type === "ALIAS" || type === "SENDER_GRANT") && policy.isUuid(input.mailboxId)) {
      const access = await policy.resolveMailboxAccess(client, user, input.mailboxId);
      if (!access && !isAdmin) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    }
    // Same checks as a direct grant (organization, ACTIVE address, membership,
    // personal identities only by their owner); re-run at approval time.
    if (type === "SENDER_GRANT") {
      const { mailbox } = await validateSenderGrant(client, { mailboxId: input.mailboxId, addressId: input.addressId, adminUserId: subjectAdminUserId || user.id });
      if (mailbox.organizationId !== organization.id) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    }
    const local = input.localPart ? normalizeLocalPart(input.localPart) : null;
    if (input.localPart && !local) throw mailError("MAIL_VALIDATION_FAILED", { field: "localPart" });
    const row = await client.mailProvisionRequest.create({
      data: {
        organizationId: organization.id,
        type,
        requestedByAdminUserId: user.id,
        subjectAdminUserId,
        requestedAddress: input.requestedAddress ? normalizeAddress(input.requestedAddress) : local || null,
        mailboxId: policy.isUuid(input.mailboxId) ? input.mailboxId : null,
        payload: { domainId: policy.isUuid(input.domainId) ? input.domainId : null, localPart: local, name: input.name ? String(input.name).slice(0, 160) : null, purpose: input.purpose || null, addressId: policy.isUuid(input.addressId) ? input.addressId : null },
        justification: input.justification ? String(input.justification).slice(0, 2000) : null,
      },
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVISION_REQUESTED", targetType: "provision_request", targetId: row.id, organizationId: organization.id, metadata: { type } }, context);
    return row;
  }

  // HR onboarding (spec section 15): a system action that files a PENDING
  // PERSONAL_MAILBOX request for a newly created HR account, with the HR
  // operator as requester. Nothing is provisioned here: IT approval through
  // decideProvisionRequest is still required (and the HR operator cannot
  // approve their own request). Idempotent per subject: an existing PENDING
  // personal-mailbox request for the subject is returned instead.
  async function createOnboardingProvisionRequest(subjectAdminUserId, { requestedByAdminUserId, localPart = null, domainId = null, name = null } = {}, context = {}) {
    const subject = policy.isUuid(subjectAdminUserId) ? await client.adminUser.findUnique({ where: { id: subjectAdminUserId }, select: { id: true, name: true, status: true } }) : null;
    if (!subject || ["INACTIVE", "LOCKED"].includes(subject.status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "subjectAdminUserId" });
    const requester = requestedByAdminUserId ? await client.adminUser.findUnique({ where: { id: String(requestedByAdminUserId) }, select: { id: true } }) : null;
    if (!requester) throw mailError("MAIL_VALIDATION_FAILED", { field: "requestedByAdminUserId" });
    const local = localPart ? normalizeLocalPart(localPart) : null;
    if (localPart && !local) throw mailError("MAIL_VALIDATION_FAILED", { field: "localPart" });
    let domain = null;
    let organization = null;
    if (domainId) {
      domain = policy.isUuid(domainId) ? await client.mailDomain.findUnique({ where: { id: domainId } }) : null;
      if (!domain) throw mailError("MAIL_VALIDATION_FAILED", { field: "domainId", reason: "DOMAIN_NOT_REGISTERED" });
      organization = await client.mailOrganization.findUnique({ where: { id: domain.organizationId } });
    } else {
      // Default: the single company (HQ) organization and, when unambiguous,
      // its single verified domain. Otherwise IT chooses at approval time.
      const companies = await client.mailOrganization.findMany({ where: { kind: "COMPANY", status: "ACTIVE" }, take: 2 });
      if (companies.length !== 1) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId", reason: companies.length ? "ORGANIZATION_AMBIGUOUS" : "NO_COMPANY_ORGANIZATION" });
      organization = companies[0];
      const domains = await client.mailDomain.findMany({ where: { organizationId: organization.id, status: "VERIFIED" }, take: 2 });
      if (domains.length === 1) domain = domains[0];
    }
    if (!organization) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    const existing = await client.mailProvisionRequest.findFirst({ where: { subjectAdminUserId: subject.id, type: "PERSONAL_MAILBOX", status: "PENDING" } });
    if (existing) return existing;
    const requestedAddress = local ? (domain ? normalizeAddress(`${local}@${domain.domain}`) || local : local) : null;
    const row = await client.mailProvisionRequest.create({
      data: {
        organizationId: organization.id,
        type: "PERSONAL_MAILBOX",
        requestedByAdminUserId: requester.id,
        subjectAdminUserId: subject.id,
        requestedAddress,
        payload: { domainId: domain ? domain.id : null, localPart: local, name: (name || subject.name) ? String(name || subject.name).slice(0, 160) : null, purpose: null, addressId: null, source: "hrm_onboarding" },
        justification: "HR onboarding: work email requested at account creation",
      },
    });
    await audit.record({ actorAdminUserId: requester.id, action: "MAIL_PROVISION_REQUESTED", targetType: "provision_request", targetId: row.id, organizationId: organization.id, metadata: { type: "PERSONAL_MAILBOX", source: "hrm", system: true, subjectAdminUserId: subject.id } }, context);
    return row;
  }

  async function decideProvisionRequest(user, requestId, { approve, note }, context) {
    await admin(user);
    const request = policy.isUuid(requestId) ? await client.mailProvisionRequest.findUnique({ where: { id: requestId } }) : null;
    if (!request) throw mailError("MAIL_NOT_FOUND", { resource: "provision_request" });
    if (request.status !== "PENDING") throw mailError("MAIL_INVALID_TRANSITION", { from: request.status });
    if (request.requestedByAdminUserId === user.id) throw mailError("MAIL_FORBIDDEN", { reason: "SELF_APPROVAL_NOT_ALLOWED" });
    if (!approve) {
      const row = await client.mailProvisionRequest.update({ where: { id: requestId }, data: { status: "REJECTED", reviewedByAdminUserId: user.id, reviewedAt: clock(), reviewNote: note ? String(note).slice(0, 2000) : null } });
      await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVISION_REJECTED", targetType: "provision_request", targetId: requestId }, context);
      await notifications.notifyUsers([request.requestedByAdminUserId], { icon: "xcircle", title: "Mail request rejected", subtitle: request.type.replace(/_/g, " ").toLowerCase() });
      return row;
    }
    const payload = request.payload || {};
    const row = await client.$transaction(async (tx) => {
      let mailboxId = request.mailboxId;
      let addressId = null;
      if (request.type === "PERSONAL_MAILBOX" || request.type === "SHARED_MAILBOX") {
        const mailbox = await createMailboxTx(tx, user, { organizationId: request.organizationId, type: request.type === "PERSONAL_MAILBOX" ? "PERSONAL" : "SHARED", name: payload.name, purpose: payload.purpose, ownerAdminUserId: request.subjectAdminUserId });
        mailboxId = mailbox.id;
        if (payload.domainId && payload.localPart) {
          const address = await createAddressTx(tx, user, { domainId: payload.domainId, localPart: payload.localPart, kind: mailbox.type === "PERSONAL" ? "PRIMARY" : "SHARED", mailboxId: mailbox.id, displayName: payload.name });
          addressId = address.id;
        }
        if (mailbox.type === "SHARED") await tx.mailMembership.create({ data: { mailboxId: mailbox.id, adminUserId: request.requestedByAdminUserId, role: "MANAGER", canSend: true, grantedBy: user.id, reason: "shared mailbox requester" } });
      } else if (request.type === "ALIAS") {
        const primary = await tx.mailAddress.findFirst({ where: { mailboxId, kind: { in: ["PRIMARY", "SHARED"] }, status: "ACTIVE" } });
        if (!primary) throw mailError("MAIL_VALIDATION_FAILED", { field: "mailboxId", reason: "PRIMARY_ADDRESS_REQUIRED" });
        const address = await createAddressTx(tx, user, { domainId: payload.domainId, localPart: payload.localPart, kind: "ALIAS", mailboxId, aliasOfAddressId: primary.id });
        addressId = address.id;
      } else if (request.type === "SENDER_GRANT") {
        const { member } = await validateSenderGrant(tx, { mailboxId, addressId: payload.addressId, adminUserId: request.subjectAdminUserId || request.requestedByAdminUserId });
        await tx.mailSenderGrant.create({ data: { mailboxId, addressId: payload.addressId, adminUserId: member.id, grantedBy: user.id } }).catch((error) => {
          if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "GRANT_EXISTS" });
          throw error;
        });
        addressId = payload.addressId;
      }
      return tx.mailProvisionRequest.update({ where: { id: requestId }, data: { status: "PROVISIONED", reviewedByAdminUserId: user.id, reviewedAt: clock(), reviewNote: note ? String(note).slice(0, 2000) : null, provisionedMailboxId: mailboxId, provisionedAddressId: addressId } });
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_PROVISION_APPROVED", targetType: "provision_request", targetId: requestId, mailboxId: row.provisionedMailboxId, metadata: { type: request.type } }, context);
    await notifications.notifyUsers([request.requestedByAdminUserId, request.subjectAdminUserId], { icon: "check", title: "Mail request approved", subtitle: request.type.replace(/_/g, " ").toLowerCase() });
    return row;
  }

  // ---------------------------------------------------------------- governance
  async function listLegalHolds(user) {
    await admin(user, "VIEW");
    return client.mailLegalHold.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }

  async function createLegalHold(user, { organizationId, mailboxId, subjectAdminUserId, reason }, context) {
    await admin(user);
    if (!policy.isUuid(organizationId)) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    if (!reason || String(reason).trim().length < 10) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const row = await client.mailLegalHold.create({ data: { organizationId, mailboxId: policy.isUuid(mailboxId) ? mailboxId : null, subjectAdminUserId: subjectAdminUserId || null, reason: String(reason).slice(0, 2000), createdBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_LEGAL_HOLD_CREATED", targetType: "legal_hold", targetId: row.id, mailboxId: row.mailboxId, organizationId }, context);
    return row;
  }

  async function releaseLegalHold(user, holdId, context) {
    await admin(user);
    const hold = policy.isUuid(holdId) ? await client.mailLegalHold.findUnique({ where: { id: holdId } }) : null;
    if (!hold || hold.releasedAt) throw mailError("MAIL_NOT_FOUND", { resource: "legal_hold" });
    const row = await client.mailLegalHold.update({ where: { id: holdId }, data: { releasedAt: clock(), releasedBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_LEGAL_HOLD_RELEASED", targetType: "legal_hold", targetId: holdId, mailboxId: hold.mailboxId }, context);
    return row;
  }

  async function listRetentionPolicies(user) {
    await admin(user, "VIEW");
    return client.mailRetentionPolicy.findMany({ orderBy: { createdAt: "desc" } });
  }

  async function createRetentionPolicy(user, { organizationId, mailboxId, name, retainDays, action }, context) {
    await admin(user);
    const days = Number(retainDays);
    if (!policy.isUuid(organizationId) || !Number.isInteger(days) || days < 30 || days > 36500) throw mailError("MAIL_VALIDATION_FAILED", { field: "retainDays" });
    const row = await client.mailRetentionPolicy.create({ data: { organizationId, mailboxId: policy.isUuid(mailboxId) ? mailboxId : null, name: String(name || "Retention").slice(0, 160), retainDays: days, action: action === "DELETE" ? "DELETE" : "ARCHIVE", createdBy: user.id } });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_RETENTION_POLICY_CREATED", targetType: "retention_policy", targetId: row.id, organizationId }, context);
    return row;
  }

  // --------------------------------------------- operations views (§5.8/§9)
  // Redacted by construction: no message content, no webhook payloads, no
  // recipient local parts. Mail administrators only (VIEW).
  const take = (limit) => Math.min(Math.max(Number(limit) || 50, 1), 200);
  // Enum filters are validated, so a bad query value is a 400, not a Prisma 500.
  const enumFilter = (field, values, value) => {
    if (!Object.values(values).includes(String(value))) throw mailError("MAIL_VALIDATION_FAILED", { field });
    return String(value);
  };
  const before = (value) => {
    const at = value ? new Date(value) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
  };

  async function listAuditEvents(user, { mailboxId, organizationId, action, targetType, targetId, outcome, before: cursor, limit } = {}) {
    await admin(user, "VIEW");
    const at = before(cursor);
    const rows = await client.mailAuditEvent.findMany({
      where: {
        ...(policy.isUuid(mailboxId) ? { mailboxId } : {}),
        ...(policy.isUuid(organizationId) ? { organizationId } : {}),
        ...(action ? { action: String(action).slice(0, 80) } : {}),
        ...(targetType ? { targetType: String(targetType).slice(0, 64) } : {}),
        ...(targetId ? { targetId: String(targetId).slice(0, 128) } : {}),
        ...(outcome ? { outcome: String(outcome).slice(0, 16) } : {}),
        ...(at ? { createdAt: { lt: at } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: take(limit),
    });
    return rows.map((row) => ({ id: row.id, actorAdminUserId: row.actorAdminUserId, action: row.action, targetType: row.targetType, targetId: row.targetId, mailboxId: row.mailboxId, organizationId: row.organizationId, outcome: row.outcome, metadata: row.metadata, requestId: row.requestId, createdAt: iso(row.createdAt) }));
  }

  async function listWebhookEvents(user, { status, eventType, before: cursor, limit } = {}) {
    await admin(user, "VIEW");
    const at = before(cursor);
    const rows = await client.mailWebhookEvent.findMany({
      where: { ...(status ? { status: enumFilter("status", MailWebhookStatus, status) } : {}), ...(eventType ? { eventType: String(eventType).slice(0, 64) } : {}), ...(at ? { receivedAt: { lt: at } } : {}) },
      orderBy: { receivedAt: "desc" },
      take: take(limit),
      select: { id: true, provider: true, providerEventId: true, eventType: true, status: true, signatureVerified: true, receivedAt: true, processedAt: true, lastError: true },
    });
    return rows.map((row) => ({ ...row, receivedAt: iso(row.receivedAt), processedAt: iso(row.processedAt), lagSeconds: row.processedAt ? Math.round((row.processedAt - row.receivedAt) / 1000) : null }));
  }

  async function listDeliveryEvents(user, { eventType, before: cursor, limit } = {}) {
    await admin(user, "VIEW");
    const at = before(cursor);
    const rows = await client.mailDeliveryEvent.findMany({
      where: { ...(eventType ? { eventType: enumFilter("eventType", MailDeliveryEventType, eventType) } : {}), ...(at ? { occurredAt: { lt: at } } : {}) },
      orderBy: { occurredAt: "desc" },
      take: take(limit),
      select: { id: true, messageId: true, providerMessageId: true, recipient: true, eventType: true, occurredAt: true, createdAt: true },
    });
    // Recipients are reduced to their domain: enough for deliverability work.
    return rows.map(({ recipient, ...row }) => ({ ...row, recipientDomain: recipient ? String(recipient).split("@")[1] || null : null, occurredAt: iso(row.occurredAt), createdAt: iso(row.createdAt) }));
  }

  async function listJobs(user, { status, queue, kind, limit } = {}) {
    await admin(user, "VIEW");
    const rows = await client.mailOutboxJob.findMany({
      where: { ...(status ? { status: enumFilter("status", MailJobStatus, status) } : {}), ...(queue ? { queue: enumFilter("queue", MailJobQueue, queue) } : {}), ...(kind ? { kind: String(kind).slice(0, 64) } : {}) },
      orderBy: { updatedAt: "desc" },
      take: take(limit),
      select: { id: true, queue: true, kind: true, status: true, attemptCount: true, maxAttempts: true, nextAttemptAt: true, lastErrorCode: true, messageId: true, completedAt: true, createdAt: true, updatedAt: true },
    });
    return rows.map((row) => ({ ...row, nextAttemptAt: iso(row.nextAttemptAt), completedAt: iso(row.completedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }));
  }

  // Spec 5.8 / section 10.8: dead-letter jobs are recoverable, with MFA.
  async function requeueJob(user, jobId, { stepUpId, reason } = {}, context = {}) {
    await admin(user);
    if (!policy.isUuid(jobId)) throw mailError("MAIL_NOT_FOUND", { resource: "job" });
    const cleanReason = String(reason || "").trim().slice(0, 500);
    if (cleanReason.length < 5) throw mailError("MAIL_VALIDATION_FAILED", { field: "reason" });
    const job = await client.mailOutboxJob.findUnique({ where: { id: jobId }, select: { id: true, kind: true, status: true, queue: true } });
    if (!job) throw mailError("MAIL_NOT_FOUND", { resource: "job" });
    if (!REQUEUEABLE_JOB_KINDS.has(job.kind)) throw mailError("MAIL_INVALID_TRANSITION", { reason: "KIND_NOT_REQUEUEABLE", kind: job.kind });
    if (!["DEAD_LETTER", "FAILED"].includes(job.status)) throw mailError("MAIL_INVALID_TRANSITION", { from: job.status });
    await client.$transaction(async (tx) => stepUp.consume(tx, user, stepUpId, "MAIL_JOB_REQUEUE", context));
    const result = await jobs.requeue(jobId);
    if (!result?.requeued) throw mailError("MAIL_INVALID_TRANSITION", { from: result?.job?.status || job.status });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_JOB_REQUEUED", targetType: "job", targetId: jobId, metadata: { kind: job.kind, queue: job.queue, from: job.status, reason: cleanReason } }, context);
    return { id: jobId, status: "PENDING", kind: job.kind };
  }

  return {
    requeueJob,
    listAuditEvents, listWebhookEvents, listDeliveryEvents, listJobs,
    listOrganizations, createOrganization, listDomains, createDomain, verifyDomain, registerProviderDomain,
    listAddresses, createAddress, updateAddressStatus, listMailboxes, createMailbox, setMailboxStatus,
    staffDirectory, listMembers, addMember, revokeMember, updateMailboxSettings, listSenderGrants, grantSender, revokeSender, offboardUser, offboardForAccountLifecycle,
    provisioningCapabilities, listProvisionRequests, createProvisionRequest, createOnboardingProvisionRequest, decideProvisionRequest,
    listLegalHolds, createLegalHold, releaseLegalHold, listRetentionPolicies, createRetentionPolicy,
  };
}

module.exports = { createMailAdminService };

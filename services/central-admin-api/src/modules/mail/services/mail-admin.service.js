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

const ROLES = new Set(["OWNER", "MANAGER", "MEMBER", "READER"]);

function createMailAdminService({ client, config, adapter, audit, notifications, clock = () => new Date() }) {
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
  async function listDomains(user) {
    await admin(user, "VIEW");
    return client.mailDomain.findMany({ orderBy: { domain: "asc" }, include: { organization: { select: { id: true, slug: true, name: true } } } });
  }

  async function createDomain(user, { organizationId, domain, providerDomainId }, context) {
    await admin(user);
    const normalized = normalizeDomain(domain);
    if (!normalized) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain" });
    if (config.domainAllowlist.length && !config.domainAllowlist.includes(normalized)) throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: "NOT_ALLOWLISTED" });
    if (!policy.isUuid(organizationId) || !(await client.mailOrganization.findUnique({ where: { id: organizationId } }))) throw mailError("MAIL_VALIDATION_FAILED", { field: "organizationId" });
    if (providerDomainId && !/^[A-Za-z0-9_-]{1,128}$/.test(String(providerDomainId))) throw mailError("MAIL_VALIDATION_FAILED", { field: "providerDomainId" });
    const row = await client.mailDomain.create({ data: { organizationId, domain: normalized, providerDomainId: providerDomainId || null, createdBy: user.id } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { field: "domain", reason: "DUPLICATE" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_CREATED", targetType: "domain", targetId: row.id, organizationId, metadata: { domain: normalized } }, context);
    return row;
  }

  // Reads verification state from the provider. Never changes DNS/MX.
  async function verifyDomain(user, domainId, context) {
    await admin(user);
    const domain = policy.isUuid(domainId) ? await client.mailDomain.findUnique({ where: { id: domainId } }) : null;
    if (!domain) throw mailError("MAIL_NOT_FOUND", { resource: "domain" });
    if (!domain.providerDomainId) throw mailError("MAIL_VALIDATION_FAILED", { field: "providerDomainId", reason: "REQUIRED_FOR_VERIFICATION" });
    let result;
    try {
      result = await adapter.validateDomain(domain.providerDomainId);
    } catch (error) {
      throw mailError("MAIL_PROVIDER_UNAVAILABLE", { reason: error.code || "PROVIDER_ERROR" });
    }
    const status = result.status === "VERIFIED" ? "VERIFIED" : result.status === "FAILED" ? "FAILED" : "PENDING_VERIFICATION";
    const row = await client.mailDomain.update({
      where: { id: domain.id },
      data: { status, sendingStatus: result.sendingStatus, receivingStatus: result.receivingStatus, dnsRecords: result.records, lastCheckedAt: clock(), verifiedAt: status === "VERIFIED" ? domain.verifiedAt || clock() : null },
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_DOMAIN_VERIFICATION_CHECKED", targetType: "domain", targetId: domain.id, organizationId: domain.organizationId, metadata: { status, sending: result.sendingStatus, receiving: result.receivingStatus } }, context);
    return row;
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

  async function updateAddressStatus(user, addressId, { status }, context) {
    await admin(user);
    if (!["ACTIVE", "SUSPENDED", "RETIRED"].includes(status)) throw mailError("MAIL_VALIDATION_FAILED", { field: "status" });
    const existing = policy.isUuid(addressId) ? await client.mailAddress.findUnique({ where: { id: addressId } }) : null;
    if (!existing) throw mailError("MAIL_NOT_FOUND", { resource: "address" });
    if (existing.status === "RETIRED") throw mailError("MAIL_INVALID_TRANSITION", { from: "RETIRED" });
    const row = await client.mailAddress.update({ where: { id: addressId }, data: { status, retiredAt: status === "RETIRED" ? clock() : null } });
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
    return row;
  }

  // ---------------------------------------------------------------- memberships
  // Managers/owners may manage their mailbox. Mail admins may manage SHARED
  // mailboxes only: they can never add anyone (including themselves) to a
  // PERSONAL mailbox, which would bypass personal mailbox privacy.
  async function authorizeMembershipChange(user, mailboxId) {
    policy.assertActiveIdentity(user);
    const mailbox = policy.isUuid(mailboxId) ? await client.mailMailbox.findUnique({ where: { id: mailboxId } }) : null;
    if (!mailbox) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
    const access = await policy.resolveMailboxAccess(client, user, mailboxId);
    const isManager = access && !access.viaBreakGlass && policy.roleSatisfies(access.role, "MANAGER");
    if (mailbox.type === "PERSONAL") {
      if (!access || access.role !== "OWNER" || mailbox.ownerAdminUserId !== user.id) throw mailError("MAIL_FORBIDDEN", { reason: "PERSONAL_MAILBOX_OWNER_ONLY" });
      return mailbox;
    }
    if (isManager || (await policy.canAdministerMail(client, user, "EDIT"))) return mailbox;
    throw mailError(access ? "MAIL_FORBIDDEN" : "MAIL_NOT_FOUND", { resource: "mailbox", reason: "MANAGER_REQUIRED" });
  }

  async function listMembers(user, mailboxId) {
    await authorizeMembershipChange(user, mailboxId);
    const rows = await client.mailMembership.findMany({ where: { mailboxId, revokedAt: null }, include: { adminUser: { select: { id: true, name: true, email: true, status: true } } }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({ id: row.id, adminUser: row.adminUser, role: row.role, canSend: row.canSend, expiresAt: iso(row.expiresAt), createdAt: iso(row.createdAt) }));
  }

  async function addMember(user, mailboxId, { adminUserId, role, canSend, expiresAt, reason }, context) {
    const mailbox = await authorizeMembershipChange(user, mailboxId);
    if (!ROLES.has(role) || role === "OWNER") throw mailError("MAIL_VALIDATION_FAILED", { field: "role" });
    const member = await client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true, status: true } });
    if (!member || member.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "adminUserId", reason: "ACTIVE_EMPLOYEE_REQUIRED" });
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (expiry && (Number.isNaN(expiry.getTime()) || expiry <= clock())) throw mailError("MAIL_VALIDATION_FAILED", { field: "expiresAt" });
    const row = await client.$transaction(async (tx) => {
      await tx.mailMembership.updateMany({ where: { mailboxId, adminUserId: member.id, revokedAt: null }, data: { revokedAt: clock(), revokedBy: user.id } });
      return tx.mailMembership.create({ data: { mailboxId, adminUserId: member.id, role, canSend: Boolean(canSend) && role !== "READER", grantedBy: user.id, expiresAt: expiry, reason: reason ? String(reason).slice(0, 500) : null } });
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_MEMBERSHIP_GRANTED", targetType: "membership", targetId: row.id, mailboxId, metadata: { member: member.id, role, canSend: row.canSend } }, context);
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
  async function grantSender(user, { mailboxId, addressId, adminUserId, expiresAt }, context) {
    await admin(user);
    const [mailbox, address, member] = await Promise.all([
      policy.isUuid(mailboxId) ? client.mailMailbox.findUnique({ where: { id: mailboxId } }) : null,
      policy.isUuid(addressId) ? client.mailAddress.findUnique({ where: { id: addressId } }) : null,
      client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true, status: true } }),
    ]);
    if (!mailbox || !address || !member || member.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "grant" });
    if (address.organizationId !== mailbox.organizationId || address.status !== "ACTIVE") throw mailError("MAIL_VALIDATION_FAILED", { field: "addressId" });
    // Sending as a personal identity requires that person's own delegation.
    if (address.kind === "PRIMARY" && address.mailboxId !== mailbox.id) throw mailError("MAIL_FORBIDDEN", { reason: "PERSONAL_IDENTITY_DELEGATION_OWNER_ONLY" });
    const membership = await client.mailMembership.findFirst({ where: { mailboxId, adminUserId: member.id, revokedAt: null } });
    if (!membership) throw mailError("MAIL_VALIDATION_FAILED", { field: "adminUserId", reason: "MAILBOX_MEMBERSHIP_REQUIRED" });
    const row = await client.mailSenderGrant.create({ data: { mailboxId, addressId, adminUserId: member.id, grantedBy: user.id, expiresAt: expiresAt ? new Date(expiresAt) : null } }).catch((error) => {
      if (error.code === "P2002") throw mailError("MAIL_VALIDATION_FAILED", { reason: "GRANT_EXISTS" });
      throw error;
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_SENDER_GRANTED", targetType: "sender_grant", targetId: row.id, mailboxId, metadata: { addressId, member: member.id } }, context);
    return row;
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
  async function offboardUser(user, adminUserId, context) {
    await admin(user);
    const subject = await client.adminUser.findUnique({ where: { id: String(adminUserId || "") }, select: { id: true } });
    if (!subject) throw mailError("MAIL_NOT_FOUND", { resource: "admin_user" });
    const now = clock();
    const summary = await client.$transaction(async (tx) => {
      const memberships = await tx.mailMembership.updateMany({ where: { adminUserId: subject.id, revokedAt: null }, data: { revokedAt: now, revokedBy: user.id } });
      const grants = await tx.mailSenderGrant.updateMany({ where: { adminUserId: subject.id, revokedAt: null }, data: { revokedAt: now, revokedBy: user.id } });
      const mailboxes = await tx.mailMailbox.findMany({ where: { ownerAdminUserId: subject.id, type: "PERSONAL" }, select: { id: true } });
      await tx.mailMailbox.updateMany({ where: { id: { in: mailboxes.map((mailbox) => mailbox.id) } }, data: { status: "SUSPENDED", suspendedAt: now, offboardedAt: now } });
      await tx.mailAddress.updateMany({ where: { mailboxId: { in: mailboxes.map((mailbox) => mailbox.id) }, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
      await tx.mailDraft.updateMany({ where: { authorAdminUserId: subject.id, status: "ACTIVE" }, data: { status: "DISCARDED", encryptedBody: null } });
      return { membershipsRevoked: memberships.count, senderGrantsRevoked: grants.count, mailboxesSuspended: mailboxes.length };
    });
    await audit.record({ actorAdminUserId: user.id, action: "MAIL_USER_OFFBOARDED", targetType: "admin_user", targetId: subject.id, metadata: summary }, context);
    return { ...summary, historyRetained: true };
  }

  // ---------------------------------------------------------------- provisioning
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
    const subjectAdminUserId = type === "PERSONAL_MAILBOX" ? (isAdmin && input.subjectAdminUserId ? String(input.subjectAdminUserId) : user.id) : input.subjectAdminUserId ? String(input.subjectAdminUserId) : null;
    if ((type === "ALIAS" || type === "SENDER_GRANT") && policy.isUuid(input.mailboxId)) {
      const access = await policy.resolveMailboxAccess(client, user, input.mailboxId);
      if (!access && !isAdmin) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
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
        await tx.mailSenderGrant.create({ data: { mailboxId, addressId: payload.addressId, adminUserId: request.subjectAdminUserId || request.requestedByAdminUserId, grantedBy: user.id } });
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

  return {
    listOrganizations, createOrganization, listDomains, createDomain, verifyDomain,
    listAddresses, createAddress, updateAddressStatus, listMailboxes, createMailbox, setMailboxStatus,
    staffDirectory, listMembers, addMember, revokeMember, updateMailboxSettings, grantSender, revokeSender, offboardUser,
    listProvisionRequests, createProvisionRequest, decideProvisionRequest,
    listLegalHolds, createLegalHold, releaseLegalHold, listRetentionPolicies, createRetentionPolicy,
  };
}

module.exports = { createMailAdminService };

"use strict";

// Idempotent provisioning of a brand's mail identities through the existing
// Mail administration service (same validation, allowlist and audit as the
// IT -> Mail Administration UI). Used by scripts/mail/provision-karryam.js.
//
// What it does (and only this):
//   1. find the organization by slug, or create it;
//   2. find the domain, or register it locally (MAIL_DOMAIN_ALLOWLIST is
//      enforced by the admin service; the domain stays PENDING_VERIFICATION
//      until a mail admin links/verifies it at the provider);
//   3. find or create each SHARED mailbox + its SHARED address (with the
//      sender display name);
//   4. reserve SYSTEM addresses with no mailbox (e.g. no-reply@) when they
//      are listed in MAIL_RESERVED_SENDER_ADDRESSES.
// It never renames, moves, re-activates, suspends or deletes anything, never
// creates memberships, sender grants or personal mailboxes (people are
// assigned afterwards by an authorized administrator), never calls the
// provider and never invents provider domain ids. Anything that exists in an
// unexpected shape is reported as a CONFLICT and left untouched.

const KARRYAM_MAIL_PLAN = Object.freeze({
  organization: Object.freeze({ slug: "karryam", name: "Karryam", kind: "BRAND" }),
  domain: "karryam.com",
  sharedMailboxes: Object.freeze([
    Object.freeze({ localPart: "info", name: "Karryam Info", displayName: "Karryam", purpose: "GENERAL" }),
    Object.freeze({ localPart: "support", name: "Karryam Support", displayName: "Karryam Support", purpose: "SUPPORT" }),
    Object.freeze({ localPart: "marketing", name: "Karryam Marketing", displayName: "Karryam Marketing", purpose: "MARKETING" }),
    Object.freeze({ localPart: "partnership", name: "Karryam Partnerships", displayName: "Karryam Partnerships", purpose: "GENERAL" }),
  ]),
  // Sent from by the KarryGo Notification Service (not by CA). Reserved
  // only when MAIL_RESERVED_SENDER_ADDRESSES lists it.
  systemAddresses: Object.freeze([Object.freeze({ localPart: "no-reply", displayName: "Karryam" })]),
});

const ORG_KINDS = new Set(["BRAND", "COMPANY"]);

async function provisionBrandMail({ client, admin, config, user = null, plan = KARRYAM_MAIL_PLAN, apply = false, context = {} }) {
  if (apply && !user) throw new Error("an acting mail administrator is required with apply");
  const domainName = String(plan.domain || "").trim().toLowerCase();
  const steps = [];
  const conflicts = [];
  const step = (entry) => {
    steps.push(entry);
    if (entry.action === "CONFLICT") conflicts.push(entry);
    return entry;
  };
  const summary = () => ({ apply, organization: plan.organization.slug, domain: domainName, steps, conflicts: conflicts.length, complete: conflicts.length === 0 && steps.every((entry) => !["WOULD_CREATE", "BLOCKED"].includes(entry.action)) });

  // 1. organization
  const kind = ORG_KINDS.has(plan.organization.kind) ? plan.organization.kind : "BRAND";
  let organization = await client.mailOrganization.findUnique({ where: { slug: plan.organization.slug } });
  if (organization) {
    if (organization.status !== "ACTIVE") {
      step({ target: "organization", slug: organization.slug, action: "CONFLICT", reason: `ORGANIZATION_${organization.status}` });
      return summary();
    }
    step({ target: "organization", slug: organization.slug, id: organization.id, action: "EXISTS", ...(organization.name !== plan.organization.name ? { note: "name differs; not renamed" } : {}), kind: organization.kind });
  } else if (apply) {
    organization = await admin.createOrganization(user, { slug: plan.organization.slug, name: plan.organization.name, kind }, context);
    step({ target: "organization", slug: organization.slug, id: organization.id, action: "CREATED", kind: organization.kind });
  } else {
    step({ target: "organization", slug: plan.organization.slug, action: "WOULD_CREATE", kind });
  }

  // 2. domain
  const allowlisted = config.domainAllowlist.includes(domainName);
  let domain = await client.mailDomain.findUnique({ where: { domain: domainName } });
  if (domain) {
    if (organization && domain.organizationId !== organization.id) {
      step({ target: "domain", domain: domainName, action: "CONFLICT", reason: "DOMAIN_OWNED_BY_ANOTHER_ORGANIZATION" });
      return summary();
    }
    if (domain.status === "SUSPENDED") {
      step({ target: "domain", domain: domainName, id: domain.id, action: "CONFLICT", reason: "DOMAIN_SUSPENDED" });
      return summary();
    }
    step({ target: "domain", domain: domainName, id: domain.id, action: "EXISTS", status: domain.status, sendingStatus: domain.sendingStatus, receivingStatus: domain.receivingStatus, providerLinked: Boolean(domain.providerDomainId), allowlisted });
  } else if (!allowlisted) {
    step({ target: "domain", domain: domainName, action: "BLOCKED", reason: config.domainAllowlist.length ? "NOT_ALLOWLISTED" : "ALLOWLIST_EMPTY" });
    return summary();
  } else if (apply) {
    domain = await admin.createDomain(user, { organizationId: organization.id, domain: domainName }, context);
    step({ target: "domain", domain: domainName, id: domain.id, action: "CREATED", status: domain.status });
  } else {
    step({ target: "domain", domain: domainName, action: "WOULD_CREATE", status: "PENDING_VERIFICATION" });
  }

  // 3. shared mailboxes
  for (const spec of plan.sharedMailboxes) {
    const address = `${spec.localPart}@${domainName}`;
    const existing = await client.mailAddress.findUnique({ where: { address }, include: { mailbox: true } });
    if (existing) {
      const shapeOk = existing.kind === "SHARED" && existing.mailbox?.type === "SHARED" && existing.organizationId === organization?.id;
      if (!shapeOk) step({ target: "shared_mailbox", address, action: "CONFLICT", reason: "ADDRESS_EXISTS_WITH_DIFFERENT_SHAPE", kind: existing.kind, mailboxType: existing.mailbox?.type || null });
      else if (existing.status === "RETIRED") step({ target: "shared_mailbox", address, action: "CONFLICT", reason: "ADDRESS_RETIRED" });
      else step({ target: "shared_mailbox", address, mailboxId: existing.mailboxId, addressId: existing.id, action: "EXISTS", addressStatus: existing.status, mailboxStatus: existing.mailbox.status, purpose: existing.mailbox.purpose, displayName: existing.displayName, ...(existing.mailbox.purpose !== spec.purpose ? { note: `purpose is ${existing.mailbox.purpose}; not changed` } : {}) });
      continue;
    }
    // A mailbox prepared by hand with this name but no address yet is reused.
    const orphans = organization ? await client.mailMailbox.findMany({ where: { organizationId: organization.id, type: "SHARED", status: "ACTIVE", name: spec.name, addresses: { none: { kind: "SHARED", status: { not: "RETIRED" } } } }, take: 2 }) : [];
    if (orphans.length > 1) {
      step({ target: "shared_mailbox", address, action: "CONFLICT", reason: "SEVERAL_MAILBOXES_WITH_THIS_NAME" });
      continue;
    }
    if (!apply || !domain) {
      step({ target: "shared_mailbox", address, action: "WOULD_CREATE", purpose: spec.purpose, displayName: spec.displayName, ...(orphans[0] ? { reuseMailboxId: orphans[0].id } : {}) });
      continue;
    }
    if (orphans[0]) {
      const row = await admin.createAddress(user, { domainId: domain.id, localPart: spec.localPart, kind: "SHARED", mailboxId: orphans[0].id, displayName: spec.displayName }, context);
      step({ target: "shared_mailbox", address, mailboxId: orphans[0].id, addressId: row.id, action: "CREATED_ADDRESS_ON_EXISTING_MAILBOX" });
    } else {
      const mailbox = await admin.createMailbox(user, { organizationId: organization.id, type: "SHARED", name: spec.name, purpose: spec.purpose, address: { domainId: domain.id, localPart: spec.localPart, displayName: spec.displayName } }, context);
      step({ target: "shared_mailbox", address, mailboxId: mailbox.id, action: "CREATED", purpose: mailbox.purpose, displayName: spec.displayName });
    }
  }

  // 4. reserved system addresses (no mailbox, nobody can send as them)
  const reserved = new Set(config.reservedSenders || []);
  for (const spec of plan.systemAddresses || []) {
    const address = `${spec.localPart}@${domainName}`;
    const existing = await client.mailAddress.findUnique({ where: { address } });
    if (existing) {
      const shapeOk = existing.kind === "SYSTEM" && !existing.mailboxId && existing.organizationId === organization?.id;
      step(shapeOk
        ? { target: "system_address", address, addressId: existing.id, action: "EXISTS", status: existing.status, reserved: reserved.has(address) }
        : { target: "system_address", address, action: "CONFLICT", reason: "ADDRESS_EXISTS_WITH_DIFFERENT_SHAPE", kind: existing.kind, hasMailbox: Boolean(existing.mailboxId) });
      continue;
    }
    if (!reserved.has(address)) {
      step({ target: "system_address", address, action: "SKIPPED", reason: "NOT_IN_MAIL_RESERVED_SENDER_ADDRESSES" });
      continue;
    }
    if (!apply || !domain) {
      step({ target: "system_address", address, action: "WOULD_CREATE", kind: "SYSTEM" });
      continue;
    }
    const row = await admin.createAddress(user, { domainId: domain.id, localPart: spec.localPart, kind: "SYSTEM", displayName: spec.displayName }, context);
    step({ target: "system_address", address, addressId: row.id, action: "CREATED", kind: "SYSTEM" });
  }
  return summary();
}

module.exports = { provisionBrandMail, KARRYAM_MAIL_PLAN };

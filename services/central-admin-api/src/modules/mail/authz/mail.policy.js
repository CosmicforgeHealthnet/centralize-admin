"use strict";

// CosmicForge Mail authorization policy.
//
// Rules (deny by default, evaluated on every request against fresh rows):
// - Only ACTIVE HQ identities may use Mail (PENDING/LOCKED/INACTIVE rejected).
// - Mailbox content access comes ONLY from an active MailMembership or an
//   approved, unexpired break-glass grant. Admin tier (including SUPER) never
//   grants mailbox content access.
// - Mail administration (domains/addresses/provisioning) uses AdminSectionGrant
//   module "mail" section "admin"; SUPER keeps its existing implicit admin
//   capability here because it never exposes mail content.
// - Break-glass request/approve, export and marketing scopes require explicit
//   grants (no tier bypass).
// - Resources the caller cannot see are reported as 404 to avoid enumeration.

const { mailError } = require("../mail.errors");

const ROLE_RANK = { READER: 1, MEMBER: 2, MANAGER: 3, OWNER: 4 };
const CAPABILITY_MIN_ROLE = {
  READ: "READER",
  TRIAGE: "MEMBER", // folders, labels, bulk actions, assignment, notes
  SEND: "MEMBER",
  MANAGE: "MANAGER", // membership + mailbox settings
};
const SECTION_MODE_RANK = { VIEW: 1, EDIT: 2 };
const MAIL_MODULE = "mail";
const MARKETING_MODULE = "mail-marketing";

function assertActiveIdentity(user) {
  if (!user) throw mailError("MAIL_FORBIDDEN", { status: 401 }, "Unauthorized");
  if (user.status !== "ACTIVE") throw mailError("MAIL_IDENTITY_INACTIVE", { reason: String(user.status || "UNKNOWN") });
  return user;
}

function activeWindow(now) {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

async function activeSectionGrants(client, adminUserId, module, now = new Date()) {
  return client.adminSectionGrant.findMany({
    where: { adminUserId, module, ...activeWindow(now) },
    select: { section: true, mode: true },
  });
}

async function hasSection(client, user, module, section, mode = "VIEW", { allowSuper = false, now = new Date() } = {}) {
  if (!user) return false;
  if (allowSuper && user.tier === "SUPER") return true;
  const grants = await activeSectionGrants(client, user.id, module, now);
  return grants.some(
    (grant) => (grant.section === section || grant.section === "*") && SECTION_MODE_RANK[grant.mode] >= SECTION_MODE_RANK[mode],
  );
}

async function canAdministerMail(client, user, mode = "EDIT") {
  return hasSection(client, user, MAIL_MODULE, "admin", mode, { allowSuper: true });
}

async function requireMailAdmin(client, user, mode = "EDIT") {
  assertActiveIdentity(user);
  if (!(await canAdministerMail(client, user, mode))) throw mailError("MAIL_FORBIDDEN", { reason: "MAIL_ADMIN_REQUIRED" });
}

async function requireExplicitMailSection(client, user, section, mode = "EDIT") {
  assertActiveIdentity(user);
  // No tier bypass for privacy-sensitive capabilities.
  if (!(await hasSection(client, user, MAIL_MODULE, section, mode, { allowSuper: false }))) {
    throw mailError("MAIL_FORBIDDEN", { reason: `MAIL_SECTION_${section.toUpperCase().replace(/[^A-Z]/g, "_")}_REQUIRED` });
  }
}

async function findMembership(client, adminUserId, mailboxId, now = new Date()) {
  return client.mailMembership.findFirst({
    where: { adminUserId, mailboxId, ...activeWindow(now) },
    orderBy: { createdAt: "desc" },
  });
}

async function findBreakGlass(client, adminUserId, mailboxId, now = new Date()) {
  return client.mailBreakGlassRequest.findFirst({
    where: {
      requesterAdminUserId: adminUserId,
      mailboxId,
      status: "APPROVED",
      revokedAt: null,
      accessExpiresAt: { gt: now },
    },
    orderBy: { decidedAt: "desc" },
  });
}

// Resolves the caller's effective access to a mailbox or returns null.
async function resolveMailboxAccess(client, user, mailboxId, { now = new Date() } = {}) {
  if (!user || user.status !== "ACTIVE" || !isUuid(mailboxId)) return null;
  const mailbox = await client.mailMailbox.findUnique({ where: { id: mailboxId } });
  if (!mailbox) return null;
  const membership = await findMembership(client, user.id, mailboxId, now);
  if (membership && mailbox.status === "ACTIVE") {
    return {
      mailbox,
      membership,
      role: membership.role,
      canSend: Boolean(membership.canSend) && membership.role !== "READER",
      viaBreakGlass: null,
    };
  }
  const breakGlass = await findBreakGlass(client, user.id, mailboxId, now);
  if (breakGlass) {
    return { mailbox, membership: null, role: "READER", canSend: false, viaBreakGlass: breakGlass };
  }
  return null;
}

function roleSatisfies(role, minimum) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minimum] || Infinity);
}

async function requireMailboxAccess(client, user, mailboxId, capability = "READ", options = {}) {
  assertActiveIdentity(user);
  const access = await resolveMailboxAccess(client, user, mailboxId, options);
  if (!access) throw mailError("MAIL_NOT_FOUND", { resource: "mailbox" });
  const minimum = CAPABILITY_MIN_ROLE[capability];
  if (!minimum || !roleSatisfies(access.role, minimum)) {
    throw mailError("MAIL_FORBIDDEN", { reason: `MAILBOX_${capability}_NOT_PERMITTED` });
  }
  if (capability === "SEND" && !access.canSend) {
    throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { reason: "MEMBERSHIP_CANNOT_SEND" });
  }
  return access;
}

async function requireThreadAccess(client, user, threadId, capability = "READ", options = {}) {
  assertActiveIdentity(user);
  if (!isUuid(threadId)) throw mailError("MAIL_NOT_FOUND", { resource: "thread" });
  const thread = await client.mailThread.findUnique({ where: { id: threadId } });
  if (!thread || thread.deletedAt) throw mailError("MAIL_NOT_FOUND", { resource: "thread" });
  let access;
  try {
    access = await requireMailboxAccess(client, user, thread.mailboxId, capability, options);
  } catch (error) {
    if (error.code === "MAIL_NOT_FOUND") throw mailError("MAIL_NOT_FOUND", { resource: "thread" });
    throw error;
  }
  return { ...access, thread };
}

// Identities the caller may send as from this mailbox.
async function listSenderIdentities(client, user, access, { now = new Date() } = {}) {
  if (!access || !access.canSend) return [];
  const mailbox = access.mailbox;
  const ownKinds = mailbox.type === "PERSONAL" ? ["PRIMARY", "ALIAS"] : ["SHARED", "ALIAS"];
  const ownerOk = mailbox.type === "SHARED" || mailbox.ownerAdminUserId === user.id;
  const addresses = ownerOk
    ? await client.mailAddress.findMany({
        where: { mailboxId: mailbox.id, status: "ACTIVE", kind: { in: ownKinds } },
        orderBy: [{ kind: "asc" }, { address: "asc" }],
      })
    : [];
  const grants = await client.mailSenderGrant.findMany({
    where: { adminUserId: user.id, mailboxId: mailbox.id, ...activeWindow(now), address: { status: "ACTIVE" } },
    include: { address: true },
  });
  const byId = new Map();
  // Mailbox-owned identities plus explicit, unexpired sender grants.
  for (const address of [...addresses, ...grants.map((grant) => grant.address)]) byId.set(address.id, address);
  return [...byId.values()].map((address) => ({
    addressId: address.id,
    address: address.address,
    displayName: address.displayName,
    kind: address.kind,
    domainId: address.domainId,
  }));
}

async function requireSenderIdentity(client, user, access, addressId, options = {}) {
  const identities = await listSenderIdentities(client, user, access, options);
  const identity = identities.find((entry) => entry.addressId === addressId);
  if (!identity) throw mailError("MAIL_SENDER_NOT_AUTHORIZED", { field: "senderAddressId" });
  return identity;
}

async function marketingScopes(client, user, { now = new Date() } = {}) {
  if (!user || user.status !== "ACTIVE") return [];
  const grants = await activeSectionGrants(client, user.id, MARKETING_MODULE, now);
  if (!grants.length) return [];
  const organizations = await client.mailOrganization.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } });
  return organizations
    .map((organization) => {
      const matches = (section) => grants.filter((grant) => grant.section === section);
      const authoring = [...matches(organization.slug), ...matches("*")];
      const approving = [...matches(`approve:${organization.slug}`), ...matches("approve:*")];
      return {
        organizationId: organization.id,
        slug: organization.slug,
        name: organization.name,
        canView: authoring.length > 0 || approving.length > 0,
        canAuthor: authoring.some((grant) => grant.mode === "EDIT"),
        canApprove: approving.some((grant) => grant.mode === "EDIT"),
      };
    })
    .filter((scope) => scope.canView);
}

async function requireMarketingScope(client, user, organizationId, need = "VIEW") {
  assertActiveIdentity(user);
  if (!isUuid(organizationId)) throw mailError("MAIL_NOT_FOUND", { resource: "organization" });
  const scopes = await marketingScopes(client, user);
  const scope = scopes.find((entry) => entry.organizationId === organizationId);
  if (!scope) throw mailError("MAIL_NOT_FOUND", { resource: "organization" });
  if (need === "EDIT" && !scope.canAuthor) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_AUTHOR_REQUIRED" });
  if (need === "APPROVE" && !scope.canApprove) throw mailError("MAIL_FORBIDDEN", { reason: "MARKETING_APPROVER_REQUIRED" });
  return scope;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID.test(String(value || ""));
}

module.exports = {
  MAIL_MODULE,
  MARKETING_MODULE,
  ROLE_RANK,
  CAPABILITY_MIN_ROLE,
  assertActiveIdentity,
  hasSection,
  canAdministerMail,
  requireMailAdmin,
  requireExplicitMailSection,
  resolveMailboxAccess,
  requireMailboxAccess,
  requireThreadAccess,
  listSenderIdentities,
  requireSenderIdentity,
  marketingScopes,
  requireMarketingScope,
  roleSatisfies,
  isUuid,
};

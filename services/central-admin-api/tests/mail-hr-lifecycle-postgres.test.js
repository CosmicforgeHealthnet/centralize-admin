"use strict";

// HR/admin account lifecycle <-> CosmicForge Mail on a replayed Admin
// database: every path that sets INACTIVE/LOCKED offboards Mail through the
// shared helper (src/shared/mail/mail-lifecycle.js) without ever failing the
// HR action; reactivation restores nothing; HR onboarding files a PENDING
// PERSONAL_MAILBOX request (IT approval still required). Mailers are
// in-memory fakes; nothing leaves 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const sent = [];
stub("../src/shared/config/mailer", {
  createTransporter: async () => ({ sendMail: async (options) => sent.push(options) }),
  sendLabEmail: async (options) => sent.push(options),
});

const REQ = { headers: {}, get: () => null };

test("HR lifecycle and Mail on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase, seed, createHarness } = require("./helpers/mail-test-harness");
  const db = await openDatabase();
  process.env.DATABASE_URL = db.replay.replayUrl;
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const mailLifecycle = require("../src/shared/mail/mail-lifecycle");
  const accountsService = require("../src/modules/hrm/accounts/accounts.service");
  const employeesService = require("../src/modules/hrm/employees/employees.service");
  const adminUsersService = require("../src/modules/admin-users/admin-users.service");
  const { prisma } = require("../src/shared/config/database");
  mailLifecycle.setMailApplication(harness.mail);

  const makeUser = async (key, { tier = "EMPLOYEE", status = "ACTIVE" } = {}) => {
    const id = crypto.randomUUID();
    await client.adminUser.create({ data: { id, email: `${key}.${id.slice(0, 6)}@staff.example.invalid`, password: "x", name: key, tier, status, mustChangePassword: false } });
    ids[key] = id;
    return id;
  };
  const withMailbox = async (ownerId, localPart) => {
    const mailbox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "PERSONAL", purpose: "GENERAL", name: localPart, ownerAdminUserId: ownerId } });
    await client.mailAddress.create({ data: { organizationId: cf.organization.id, domainId: cf.domain.id, mailboxId: mailbox.id, localPart, address: `${localPart}@cosmicforge.example`, kind: "PRIMARY", status: "ACTIVE" } });
    await client.mailMembership.create({ data: { mailboxId: mailbox.id, adminUserId: ownerId, role: "OWNER", canSend: true } });
    return mailbox;
  };
  const activeMemberships = (id) => client.mailMembership.count({ where: { adminUserId: id, revokedAt: null } });
  const lastHrAudit = (action, targetId) => prisma.auditLog.findFirst({ where: { action, targetId }, orderBy: { createdAt: "desc" } });
  const superActor = await prisma.adminUser.findUnique({ where: { id: ids.super } });

  try {
    await t.test("admin-users deactivateUser offboards Mail; activateUser restores nothing", async () => {
      const emp = await makeUser("adminLeaver");
      const mailbox = await withMailbox(emp, "adminleaver");
      await adminUsersService.deactivateUser({ id: emp, deactivatedBy: ids.super, req: REQ });
      assert.equal((await client.adminUser.findUnique({ where: { id: emp } })).status, "INACTIVE");
      assert.equal(await activeMemberships(emp), 0, "memberships revoked");
      assert.equal((await client.mailMailbox.findUnique({ where: { id: mailbox.id } })).status, "SUSPENDED");
      const mailAudit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_USER_OFFBOARDED", targetId: emp } });
      assert.equal(mailAudit.actorAdminUserId, ids.super);
      assert.equal(mailAudit.metadata.trigger, "ADMIN_USER_INACTIVE");
      assert.equal(mailAudit.metadata.system, true);
      assert.equal((await lastHrAudit("USER_DEACTIVATED", emp)).metadata.mailOffboarding, "OFFBOARDED", "outcome recorded in the HR audit");

      await adminUsersService.activateUser({ id: emp, activatedBy: ids.super, req: REQ });
      assert.equal((await client.adminUser.findUnique({ where: { id: emp } })).status, "ACTIVE");
      assert.equal(await activeMemberships(emp), 0, "reactivation does not restore memberships");
      assert.equal((await client.mailMailbox.findUnique({ where: { id: mailbox.id } })).status, "SUSPENDED", "reactivation does not reopen the mailbox");
    });

    await t.test("HRM employees updateEmployment INACTIVE and LOCKED offboard Mail; ACTIVE restores nothing", async () => {
      const inactive = await makeUser("empInactive");
      await withMailbox(inactive, "empinactive");
      const result = await employeesService.updateEmployment({ id: inactive, actor: superActor, data: { status: "INACTIVE" }, req: REQ });
      assert.equal(result.status ?? (await client.adminUser.findUnique({ where: { id: inactive } })).status, "INACTIVE");
      assert.equal(await activeMemberships(inactive), 0);
      assert.equal((await client.mailAuditEvent.findFirst({ where: { action: "MAIL_USER_OFFBOARDED", targetId: inactive } })).metadata.trigger, "HR_EMPLOYEE_INACTIVE");
      assert.equal((await lastHrAudit("PROFILE_UPDATED", inactive)).metadata.mailOffboarding, "OFFBOARDED");

      const locked = await makeUser("empLocked");
      const lockedBox = await withMailbox(locked, "emplocked");
      await employeesService.updateEmployment({ id: locked, actor: superActor, data: { status: "LOCKED" }, req: REQ });
      assert.equal(await activeMemberships(locked), 0);
      assert.equal((await client.mailAuditEvent.findFirst({ where: { action: "MAIL_USER_OFFBOARDED", targetId: locked } })).metadata.trigger, "HR_EMPLOYEE_LOCKED");

      await employeesService.updateEmployment({ id: locked, actor: superActor, data: { status: "ACTIVE" }, req: REQ });
      assert.equal(await activeMemberships(locked), 0, "reactivation restores nothing");
      assert.equal((await client.mailMailbox.findUnique({ where: { id: lockedBox.id } })).status, "SUSPENDED");
      assert.equal((await lastHrAudit("PROFILE_UPDATED", locked)).metadata.mailOffboarding, undefined, "no Mail action on reactivation");

      // A non-status employment update never touches Mail.
      const mover = await makeUser("empMover");
      await withMailbox(mover, "empmover");
      await employeesService.updateEmployment({ id: mover, actor: superActor, data: { position: "Lead" }, req: REQ });
      assert.equal(await activeMemberships(mover), 1);
    });

    await t.test("Mail missing, not ready or failing never fails the HR action; the skip is audited", async () => {
      const cases = [
        ["SKIPPED_MAIL_UNAVAILABLE", null],
        ["SKIPPED_SCHEMA_NOT_READY", { ...harness.mail, schema: { isReady: async () => false } }],
        ["FAILED", { ...harness.mail, services: { ...harness.mail.services, admin: { ...harness.mail.services.admin, offboardForAccountLifecycle: async () => { throw Object.assign(new Error("boom"), { code: "MAIL_X" }); } } } }],
      ];
      for (const [expected, application] of cases) {
        mailLifecycle.setMailApplication(application);
        try {
          const a = await makeUser(`skipA${expected}`);
          await withMailbox(a, `skipa${expected.toLowerCase().replace(/_/g, "")}`);
          await adminUsersService.deactivateUser({ id: a, deactivatedBy: ids.super, req: REQ });
          assert.equal((await client.adminUser.findUnique({ where: { id: a } })).status, "INACTIVE", `${expected}: deactivation succeeded`);
          assert.equal(await activeMemberships(a), 1, `${expected}: Mail untouched`);
          assert.equal((await lastHrAudit("USER_DEACTIVATED", a)).metadata.mailOffboarding, expected);

          const b = await makeUser(`skipB${expected}`);
          await employeesService.updateEmployment({ id: b, actor: superActor, data: { status: "LOCKED" }, req: REQ });
          assert.equal((await client.adminUser.findUnique({ where: { id: b } })).status, "LOCKED");
          assert.equal((await lastHrAudit("PROFILE_UPDATED", b)).metadata.mailOffboarding, expected);
        } finally {
          mailLifecycle.setMailApplication(harness.mail);
        }
      }
    });

    await t.test("HR onboarding with the toggle files exactly one PENDING personal-mailbox request for the new user", async () => {
      const usersBefore = await client.adminUser.count();
      const created = await accountsService.createAccount({
        data: { name: "Jane Hire", email: "jane.hire@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT", mailProvisioning: { requested: true, localPart: "Jane.Hire", domainId: cf.domain.id } },
        actor: superActor,
        req: REQ,
      });
      assert.equal(await client.adminUser.count(), usersBefore + 1, "exactly one AdminUser is created");
      assert.equal(created.mailProvisioning.status, "REQUESTED");
      const requests = await client.mailProvisionRequest.findMany({ where: { subjectAdminUserId: created.id } });
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request.id, created.mailProvisioning.requestId);
      assert.equal(request.status, "PENDING", "no auto-provisioning");
      assert.equal(request.type, "PERSONAL_MAILBOX");
      assert.equal(request.requestedByAdminUserId, ids.super, "the HR operator is the requester");
      assert.equal(request.organizationId, cf.organization.id);
      assert.equal(request.requestedAddress, "jane.hire@cosmicforge.example");
      assert.equal(request.payload.domainId, cf.domain.id);
      assert.equal(await client.mailMailbox.count({ where: { ownerAdminUserId: created.id } }), 0, "no mailbox before IT approval");
      const mailAudit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_PROVISION_REQUESTED", targetId: request.id } });
      assert.equal(mailAudit.actorAdminUserId, ids.super);
      assert.equal(mailAudit.metadata.system, true);
      const hrAudit = await lastHrAudit("USER_CREATED", created.id);
      assert.equal(hrAudit.metadata.mailProvisioning.status, "REQUESTED");
      assert.equal(hrAudit.metadata.mailProvisioning.requestId, request.id);

      // IT approval is still required: the HR operator cannot approve their own request.
      const { admin } = harness.mail.services;
      await assert.rejects(admin.decideProvisionRequest({ id: ids.super, tier: "SUPER", status: "ACTIVE" }, request.id, { approve: true }, {}), (error) => error.code === "MAIL_FORBIDDEN");
      // The invitee is PENDING until they accept the invite: IT cannot provision yet.
      await assert.rejects(admin.decideProvisionRequest({ id: ids.mailAdmin, tier: "ADMIN", status: "ACTIVE" }, request.id, { approve: true }, {}), (error) => error.errors?.[0]?.reason === "ACTIVE_EMPLOYEE_REQUIRED");
      assert.equal((await client.mailProvisionRequest.findUnique({ where: { id: request.id } })).status, "PENDING", "the request stays pending");
      await client.adminUser.update({ where: { id: created.id }, data: { status: "ACTIVE" } });
      const approved = await admin.decideProvisionRequest({ id: ids.mailAdmin, tier: "ADMIN", status: "ACTIVE" }, request.id, { approve: true }, {});
      assert.equal(approved.status, "PROVISIONED");
      const mailbox = await client.mailMailbox.findUnique({ where: { id: approved.provisionedMailboxId } });
      assert.equal(mailbox.ownerAdminUserId, created.id);
      assert.equal((await client.mailAddress.findUnique({ where: { id: approved.provisionedAddressId } })).address, "jane.hire@cosmicforge.example");
    });

    await t.test("HR onboarding without the toggle files nothing; a default company domain is used when unambiguous", async () => {
      const plain = await accountsService.createAccount({ data: { name: "No Mail", email: "no.mail@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT" }, actor: superActor, req: REQ });
      assert.equal(plain.mailProvisioning, undefined);
      assert.equal(await client.mailProvisionRequest.count({ where: { subjectAdminUserId: plain.id } }), 0);
      const notRequested = await accountsService.createAccount({ data: { name: "Toggle Off", email: "toggle.off@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT", mailProvisioning: { requested: false, localPart: "toggle.off" } }, actor: superActor, req: REQ });
      assert.equal(await client.mailProvisionRequest.count({ where: { subjectAdminUserId: notRequested.id } }), 0);

      // No company organization yet: the request cannot be targeted; the account is still created.
      const noOrg = await accountsService.createAccount({ data: { name: "No Org", email: "no.org@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT", mailProvisioning: { requested: true, localPart: "no.org" } }, actor: superActor, req: REQ });
      assert.equal(noOrg.mailProvisioning.status, "FAILED");
      assert.equal(noOrg.mailProvisioning.reason, "NO_COMPANY_ORGANIZATION");
      assert.ok(await client.adminUser.findUnique({ where: { id: noOrg.id } }));

      const hq = await client.mailOrganization.create({ data: { slug: "cosmicforge-hq", name: "CosmicForge HQ", kind: "COMPANY", createdBy: ids.super } });
      await client.mailDomain.create({ data: { organizationId: hq.id, domain: "hq.cosmicforge.example", status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", providerDomainId: "fake_hq", verifiedAt: new Date() } });
      const defaulted = await accountsService.createAccount({ data: { name: "Hq Hire", email: "hq.hire@staff.example.invalid", tier: "EMPLOYEE", department: "MANAGEMENT", mailProvisioning: { requested: true, localPart: "hq.hire" } }, actor: superActor, req: REQ });
      assert.equal(defaulted.mailProvisioning.status, "REQUESTED");
      const request = await client.mailProvisionRequest.findFirst({ where: { subjectAdminUserId: defaulted.id } });
      assert.equal(request.organizationId, hq.id);
      assert.equal(request.requestedAddress, "hq.hire@hq.cosmicforge.example");
    });

    await t.test("HR onboarding with Mail disabled or not ready is SKIPPED; the account is still created", async () => {
      const cases = [
        ["MAIL_DISABLED", { ...harness.mail, config: { ...harness.mail.config, enabled: false } }],
        ["MAIL_SCHEMA_NOT_READY", { ...harness.mail, schema: { isReady: async () => false } }],
        ["MAIL_UNAVAILABLE", null],
      ];
      for (const [reason, application] of cases) {
        mailLifecycle.setMailApplication(application);
        try {
          const email = `skipped.${reason.toLowerCase()}@staff.example.invalid`;
          const created = await accountsService.createAccount({ data: { name: "Skipped Hire", email, tier: "EMPLOYEE", department: "MANAGEMENT", mailProvisioning: { requested: true, localPart: "skipped" } }, actor: superActor, req: REQ });
          assert.deepEqual(created.mailProvisioning, { status: "SKIPPED", reason });
          assert.equal(created.status, "PENDING");
          assert.equal(await client.adminUser.count({ where: { email } }), 1);
          assert.equal(await client.mailProvisionRequest.count({ where: { subjectAdminUserId: created.id } }), 0);
          assert.equal((await lastHrAudit("USER_CREATED", created.id)).metadata.mailProvisioning.status, "SKIPPED");
        } finally {
          mailLifecycle.setMailApplication(harness.mail);
        }
      }
    });

    await t.test("the HR create DTO accepts the optional mailProvisioning block and rejects bad local parts", () => {
      const { accountCreateSchema } = require("../src/modules/hrm/accounts/accounts.validator");
      const base = { name: "Dto Hire", email: "dto@staff.example.invalid" };
      assert.equal(accountCreateSchema.safeParse(base).success, true);
      assert.equal(accountCreateSchema.safeParse({ ...base, mailProvisioning: { requested: true, localPart: "dto.hire" } }).success, true);
      assert.equal(accountCreateSchema.safeParse({ ...base, mailProvisioning: { requested: true, localPart: "bad part@x" } }).success, false);
      assert.equal(accountCreateSchema.safeParse({ ...base, mailProvisioning: { requested: true, extra: 1 } }).success, false);
    });
  } finally {
    mailLifecycle.setMailApplication(undefined);
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }
});

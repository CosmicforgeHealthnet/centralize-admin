"use strict";

// Regression tests for the Mail audit fixes (D1-D6, D11, D12, integration
// event races) on a replayed Admin database. HR account services and Mail run
// against the same disposable database; nothing leaves 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { closeServer } = require("./helpers/server-close");

const SECRETS = { clinic: "clinic-ops-secret-0123456789abcdef01", legacy: "legacy-ops-secret-0123456789abcdef01" };
const ENV = {
  MAIL_INTEGRATIONS_ENABLED: "true",
  MAIL_INTEGRATION_HASH_SECRET: crypto.randomBytes(32).toString("hex"),
  MAIL_INTEGRATION_SERVICE_SECRETS: `clinic-ops-service=${SECRETS.clinic},legacy-ops-service=${SECRETS.legacy}`,
};
const REQ = { headers: {}, get: () => null };

test("Mail audit fixes on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
  const db = await openDatabase();
  // HR modules below bind to the replayed database.
  process.env.DATABASE_URL = db.replay.replayUrl;
  const { client } = db;
  const harness = createHarness(client, { env: ENV });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, origin, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const accountsService = require("../src/modules/hrm/accounts/accounts.service");
  const { prisma } = require("../src/shared/config/database");
  const { errorHandler } = require("../src/shared/middlewares/error.middleware");
  const { signServiceRequest } = require("../src/modules/mail/integrations/service-auth");
  accountsService.setMailApplication(harness.mail);

  const makeUser = async (key, { tier = "EMPLOYEE", status = "ACTIVE" } = {}) => {
    const id = crypto.randomUUID();
    await client.adminUser.create({ data: { id, email: `${key}.${id.slice(0, 6)}@staff.example.invalid`, password: "x", name: key, tier, status, mustChangePassword: false } });
    ids[key] = id;
    harness.state.sessions.set(id, (await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) } })).id);
    return id;
  };
  const personalMailbox = async (ownerId, localPart) => {
    const mailbox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "PERSONAL", purpose: "GENERAL", name: localPart, ownerAdminUserId: ownerId } });
    const address = await client.mailAddress.create({ data: { organizationId: cf.organization.id, domainId: cf.domain.id, mailboxId: mailbox.id, localPart, address: `${localPart}@cosmicforge.example`, kind: "PRIMARY", status: "ACTIVE" } });
    await client.mailMembership.create({ data: { mailboxId: mailbox.id, adminUserId: ownerId, role: "OWNER", canSend: true } });
    return { mailbox, address };
  };
  const sharedMailbox = async (name, purpose = "GENERAL", extra = {}) => {
    const mailbox = await client.mailMailbox.create({ data: { organizationId: cf.organization.id, type: "SHARED", purpose, name, ...extra } });
    const address = await client.mailAddress.create({ data: { organizationId: cf.organization.id, domainId: cf.domain.id, mailboxId: mailbox.id, localPart: name.toLowerCase(), address: `${name.toLowerCase()}@cosmicforge.example`, kind: "SHARED", status: "ACTIVE" } });
    return { mailbox, address };
  };
  const superActor = await prisma.adminUser.findUnique({ where: { id: ids.super } });

  try {
    await t.test("D1: HR deactivation/lock offboards Mail as an audited system action; reactivation restores nothing", async () => {
      const emp = await makeUser("leaver");
      const personal = await personalMailbox(emp, "leaver");
      const team = await sharedMailbox("Team");
      await client.mailMembership.create({ data: { mailboxId: team.mailbox.id, adminUserId: emp, role: "MEMBER", canSend: true } });
      await client.mailSenderGrant.create({ data: { mailboxId: team.mailbox.id, addressId: team.address.id, adminUserId: emp, grantedBy: ids.super } });
      const rule = await client.mailForwardingRule.create({ data: { mailboxId: personal.mailbox.id, organizationId: cf.organization.id, targetAddress: "team@cosmicforge.example", targetKind: "INTERNAL", reason: "holiday", requestedBy: emp, requestedAt: new Date(), status: "ACTIVE", decidedBy: ids.super, decidedAt: new Date() } });

      await accountsService.updateStatus({ id: emp, status: "INACTIVE", actor: superActor, req: REQ });
      assert.equal(await client.mailMembership.count({ where: { adminUserId: emp, revokedAt: null } }), 0, "memberships revoked");
      assert.equal(await client.mailSenderGrant.count({ where: { adminUserId: emp, revokedAt: null } }), 0, "sender grants revoked");
      assert.equal((await client.mailMailbox.findUnique({ where: { id: personal.mailbox.id } })).status, "SUSPENDED");
      assert.equal((await client.mailForwardingRule.findUnique({ where: { id: rule.id } })).status, "DISABLED");
      const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_USER_OFFBOARDED", targetId: emp } });
      assert.equal(audit.actorAdminUserId, ids.super);
      assert.equal(audit.metadata.trigger, "HR_ACCOUNT_INACTIVE");
      assert.equal(audit.metadata.system, true);

      await accountsService.updateStatus({ id: emp, status: "ACTIVE", actor: superActor, req: REQ });
      assert.equal(await client.mailMembership.count({ where: { adminUserId: emp, revokedAt: null } }), 0, "reactivation does not restore memberships");
      assert.equal((await client.mailMailbox.findUnique({ where: { id: personal.mailbox.id } })).status, "SUSPENDED", "reactivation does not reopen the mailbox");

      // LOCKED through the account update path offboards too.
      const locked = await makeUser("locked");
      await personalMailbox(locked, "locked");
      await accountsService.updateAccount({ id: locked, data: { status: "LOCKED" }, actor: superActor, req: REQ });
      assert.equal(await client.mailMembership.count({ where: { adminUserId: locked, revokedAt: null } }), 0);

      // Mail unavailable: HR still succeeds, nothing in Mail is touched.
      const other = await makeUser("noMail");
      await personalMailbox(other, "nomail");
      accountsService.setMailApplication(null);
      try {
        const result = await accountsService.updateStatus({ id: other, status: "INACTIVE", actor: superActor, req: REQ });
        assert.equal(result.status, "INACTIVE");
        assert.equal(await client.mailMembership.count({ where: { adminUserId: other, revokedAt: null } }), 1);
      } finally {
        accountsService.setMailApplication(harness.mail);
      }
    });

    await t.test("D3: deleting an account with retained Mail records is a 409, not a 500; P2003 maps to 409", async () => {
      const emp = await makeUser("deleteMe");
      await personalMailbox(emp, "deleteme");
      await assert.rejects(accountsService.deleteAccount({ id: emp, actor: superActor, req: REQ }), (error) => error.statusCode === 409 && /retained records/.test(error.message));
      assert.ok(await client.adminUser.findUnique({ where: { id: emp } }), "the account is kept");
      assert.equal(await client.mailMembership.count({ where: { adminUserId: emp, revokedAt: null } }), 0, "the delete attempt revoked Mail access");
      const plain = await makeUser("plain");
      await accountsService.deleteAccount({ id: plain, actor: superActor, req: REQ });
      assert.equal(await client.adminUser.findUnique({ where: { id: plain } }), null, "accounts without Mail records still delete");
      let status;
      let payload;
      errorHandler({ code: "P2003", message: "Foreign key constraint violated" }, {}, { locals: {}, status(code) { status = code; return this; }, json(body) { payload = body; return this; }, setHeader() {} }, () => {});
      assert.equal(status, 409);
      assert.equal(payload.success, false);
    });

    await t.test("D2: internal forwarding stops when the requester or personal mailbox owner is not active", async () => {
      const owner = await makeUser("fwdOwner");
      const personal = await personalMailbox(owner, "fwdowner");
      const target = await sharedMailbox("Fwdtarget");
      const rule = await client.mailForwardingRule.create({ data: { mailboxId: personal.mailbox.id, organizationId: cf.organization.id, targetAddress: target.address.address, targetKind: "INTERNAL", reason: "cover", requestedBy: owner, requestedAt: new Date(), status: "ACTIVE", decidedBy: ids.super, decidedAt: new Date() } });
      // Deactivated outside HR offboarding (e.g. a direct DB change).
      await client.adminUser.update({ where: { id: owner }, data: { status: "INACTIVE" } });
      const inbound = { from: { address: "sender@partner.example", name: null }, to: [], cc: [], subject: "Hello", originalHeaders: [] };
      const result = await harness.mail.services.forwarding.forwardInbound({ mailbox: personal.mailbox, message: { id: crypto.randomUUID(), status: "RECEIVED" }, inbound, body: { text: "hi" } });
      assert.equal(result.forwarded, 0);
      const skipped = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_FORWARD_SKIPPED", targetId: rule.id } });
      assert.equal(skipped.metadata.reason, "REQUESTER_NOT_ACTIVE");
      assert.equal(await client.mailMessage.count({ where: { mailboxId: target.mailbox.id } }), 0, "no internal copy");

      // Shared mailbox rule requested by an active manager, personal owner
      // inactive: a personal rule requested by someone else is also refused.
      const owner2 = await makeUser("fwdOwner2");
      const personal2 = await personalMailbox(owner2, "fwdowner2");
      const rule2 = await client.mailForwardingRule.create({ data: { mailboxId: personal2.mailbox.id, organizationId: cf.organization.id, targetAddress: target.address.address, targetKind: "INTERNAL", reason: "cover", requestedBy: ids.mailAdmin, requestedAt: new Date(), status: "ACTIVE", decidedBy: ids.super, decidedAt: new Date() } });
      await client.adminUser.update({ where: { id: owner2 }, data: { status: "LOCKED" } });
      await harness.mail.services.forwarding.forwardInbound({ mailbox: personal2.mailbox, message: { id: crypto.randomUUID(), status: "RECEIVED" }, inbound, body: { text: "hi" } });
      assert.equal((await client.mailAuditEvent.findFirst({ where: { action: "MAIL_FORWARD_SKIPPED", targetId: rule2.id } })).metadata.reason, "OWNER_NOT_ACTIVE");
    });

    await t.test("D4: a request for someone else is refused (403), never re-targeted; capabilities are real", async () => {
      await makeUser("plainEmp");
      const other = await makeUser("colleague");
      const refused = await call("plainEmp", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "colleague.x@cosmicforge.example", subjectAdminUserId: other });
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.body.errors[0].reason, "PROVISIONING_FOR_OTHERS_NOT_ALLOWED");
      assert.equal(await client.mailProvisionRequest.count({ where: { requestedByAdminUserId: ids.plainEmp } }), 0, "nothing was created for the caller instead");
      assert.equal((await call("plainEmp", "POST", "/provisioning/requests", { type: "SHARED_MAILBOX", organizationId: cf.organization.id, name: "Ops", subjectAdminUserId: other })).status, 403, "applies to every request type");
      const own = await call("plainEmp", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", requestedAddress: "plain.emp@cosmicforge.example" });
      assert.equal(own.status, 201, own.text);
      assert.equal(own.body.data.subjectAdminUserId, ids.plainEmp);
      const { admin } = harness.mail.services;
      assert.deepEqual(await admin.provisioningCapabilities({ id: ids.plainEmp, tier: "EMPLOYEE", status: "ACTIVE" }), { canProvision: true, canProvisionForOthers: false, canApproveProvisioning: false });
      assert.deepEqual(await admin.provisioningCapabilities({ id: ids.mailAdmin, tier: "ADMIN", status: "ACTIVE" }), { canProvision: true, canProvisionForOthers: true, canApproveProvisioning: true });
    });

    await t.test("D5: sender-grant requests get the same validation as direct grants, at creation and approval", async () => {
      const ceo = await makeUser("ceo", { tier: "EXECUTIVE" });
      const ceoBox = await personalMailbox(ceo, "ceo");
      const emp = await makeUser("grantSeeker");
      const desk = await sharedMailbox("Desk");
      await client.mailMembership.create({ data: { mailboxId: desk.mailbox.id, adminUserId: emp, role: "MEMBER", canSend: true } });
      const onCeo = await call("grantSeeker", "POST", "/provisioning/requests", { type: "SENDER_GRANT", organizationId: cf.organization.id, mailboxId: desk.mailbox.id, addressId: ceoBox.address.id });
      assert.equal(onCeo.status, 403, onCeo.text);
      assert.equal(onCeo.body.errors[0].reason, "PERSONAL_IDENTITY_DELEGATION_OWNER_ONLY");
      assert.equal((await call("grantSeeker", "POST", "/provisioning/requests", { type: "SENDER_GRANT", organizationId: cf.organization.id, mailboxId: ceoBox.mailbox.id, addressId: ceoBox.address.id })).status, 404, "no access to the CEO mailbox");
      const valid = await call("grantSeeker", "POST", "/provisioning/requests", { type: "SENDER_GRANT", organizationId: cf.organization.id, mailboxId: desk.mailbox.id, addressId: desk.address.id });
      assert.equal(valid.status, 201, valid.text);
      const approved = await call("mailAdmin", "POST", `/provisioning/requests/${valid.body.data.id}/approve`, {});
      assert.equal(approved.status, 200, approved.text);
      assert.equal(await client.mailSenderGrant.count({ where: { adminUserId: emp, addressId: desk.address.id, revokedAt: null } }), 1);
      // A legacy/unvalidated row is re-checked at approval and refused.
      const legacy = await client.mailProvisionRequest.create({ data: { organizationId: cf.organization.id, type: "SENDER_GRANT", requestedByAdminUserId: emp, mailboxId: desk.mailbox.id, payload: { addressId: ceoBox.address.id } } });
      const refused = await call("mailAdmin", "POST", `/provisioning/requests/${legacy.id}/approve`, {});
      assert.equal(refused.status, 403, refused.text);
      assert.equal(await client.mailSenderGrant.count({ where: { addressId: ceoBox.address.id } }), 0, "no grant on the CEO's identity");
      assert.equal((await client.mailProvisionRequest.findUnique({ where: { id: legacy.id } })).status, "PENDING");
    });

    await t.test("D6: ticket links need Help & Support ticket access and a deep-link-safe reference", async () => {
      const box = await sharedMailbox("Helpdesk", "SUPPORT", { supportTicketLinkEnabled: true });
      const thread = await client.mailThread.create({ data: { mailboxId: box.mailbox.id, subject: "Help", hasInbound: true, conversationStatus: "OPEN" } });
      const agent = await makeUser("agentEmp");
      const lead = await makeUser("agentLead", { tier: "ADMIN" });
      for (const id of [agent, lead]) await client.mailMembership.create({ data: { mailboxId: box.mailbox.id, adminUserId: id, role: "MEMBER", canSend: true } });
      await client.adminSectionGrant.create({ data: { adminUserId: lead, module: "support", section: "tickets", mode: "VIEW", grantedBy: ids.super } });
      const denied = await call("agentEmp", "PUT", `/threads/${thread.id}/ticket-link`, { ticketRef: "T-100" });
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.body.errors[0].reason, "SUPPORT_TICKETS_ACCESS_REQUIRED");
      assert.equal((await call("agentLead", "PUT", `/threads/${thread.id}/ticket-link`, { ticketRef: "T#100" })).status, 400, "reference must match the deep-link format");
      const ok = await call("agentLead", "PUT", `/threads/${thread.id}/ticket-link`, { ticketRef: "T-100" });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.data.supportTicketRef, "T-100");
      assert.equal(ok.body.data.ticketRefVerified, false, "existence is not verified (HealthNet ticket store is not read)");
    });

    await t.test("D11/D12 + races: restriction follows the organization; restricted summaries are codes; event races and alert retries", async () => {
      const opsUser = { id: ids.ops, tier: "ADMIN", status: "ACTIVE" };
      const { integrations } = harness.mail.services;
      const clinicOrg = await client.mailOrganization.create({ data: { slug: "healthnet-clinics", name: "HealthNet Clinics", kind: "BRAND", createdBy: ids.super } });
      await assert.rejects(integrations.create(opsUser, { product: "clinicops", serviceName: "clinic-ops-service", organizationId: clinicOrg.id, classification: "STANDARD", allowedEventTypes: ["ops.alert"] }, {}), (error) => error.code === "MAIL_VALIDATION_FAILED");
      const created = await integrations.create(opsUser, { product: "clinicops", serviceName: "clinic-ops-service", organizationId: clinicOrg.id, allowedEventTypes: ["ops.alert"] }, {});
      assert.equal(created.classification, "RESTRICTED_HEALTH", "a non-'healthnet' product on a restricted organization is restricted");
      await client.mailProductIntegration.update({ where: { id: created.id }, data: { status: "ACTIVE", ownerApprovalReference: "TEST-1", approvedAt: new Date() } });
      // A legacy STANDARD row for a restricted organization is still treated as restricted.
      const legacyOrg = await client.mailOrganization.create({ data: { slug: "healthnet-legacy", name: "HealthNet Legacy", kind: "BRAND", createdBy: ids.super } });
      await client.mailProductIntegration.create({ data: { product: "legacyops", serviceName: "legacy-ops-service", organizationId: legacyOrg.id, classification: "STANDARD", status: "ACTIVE", ownerApprovalReference: "TEST-2", approvedAt: new Date(), allowedEventTypes: ["ops.alert", "mail.delivery_status"], allowedTriggerTypes: [], createdBy: ids.super, updatedBy: ids.super } });

      const PATH = "/api/mail/v1/integrations/v1/events";
      const send = async (serviceName, secret, payload) => {
        const body = JSON.stringify(payload);
        const headers = signServiceRequest({ method: "POST", requestUri: PATH, body, serviceName, secret, now: harness.clock().getTime() });
        const response = await fetch(`${origin}${PATH}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      const alert = (product, organization, data, eventId = `e-${crypto.randomUUID()}`) => ({ contractVersion: 1, product, organization, eventId, eventType: "ops.alert", eventVersion: 1, occurredAt: harness.clock().toISOString(), data });
      const clinic = (payload) => send("clinic-ops-service", SECRETS.clinic, payload);
      const legacy = (payload) => send("legacy-ops-service", SECRETS.legacy, payload);

      assert.equal((await clinic(alert("clinicops", "healthnet-clinics", { severity: "info", code: "SYNC_LAG", summary: "SYNC_FAILED", component: "sync" }))).status, 202);
      const freeText = await clinic(alert("clinicops", "healthnet-clinics", { severity: "info", code: "SYNC_LAG", summary: "Sync failed for ward three", component: "sync" }));
      assert.equal(freeText.body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT");
      assert.equal(freeText.body.errors[0].reason, "FREE_TEXT_NOT_ALLOWED");
      assert.equal((await legacy(alert("legacyops", "healthnet-legacy", { severity: "info", code: "SYNC_LAG", summary: "Sync failed for ward three", component: "sync" }))).body.code, "MAIL_INTEGRATION_FORBIDDEN_CONTENT", "legacy STANDARD row is restricted by organization");
      const delivery = { contractVersion: 1, product: "legacyops", organization: "healthnet-legacy", eventId: `d-${crypto.randomUUID()}`, eventType: "mail.delivery_status", eventVersion: 1, occurredAt: harness.clock().toISOString(), data: { productMessageId: "m1", provider: "resend", sender: "a@healthnet.example", recipient: "b@example.com", status: "DELIVERED", category: "x" } };
      assert.equal((await legacy(delivery)).status, 403, "restricted organizations only send ops alerts");

      // Concurrent first deliveries of one eventId with different payloads:
      // exactly one is accepted, the others conflict (409), never a silent 202.
      const eventId = `race-${crypto.randomUUID()}`;
      const racing = await Promise.all(["SYNC_FAILED", "QUEUE_BACKLOG", "PROVIDER_DOWN", "AUTH_FAILURE"].map((summary) => clinic(alert("clinicops", "healthnet-clinics", { severity: "info", code: "RACE_CODE", summary, component: "sync" }, eventId))));
      assert.deepEqual(racing.map((r) => r.status).sort(), [202, 409, 409, 409], JSON.stringify(racing.map((r) => r.body)));

      // Identical retries of a warning alert notify once.
      const admins = new Set((await client.adminSectionGrant.findMany({ where: { module: "mail", section: { in: ["admin", "integration:clinicops"] }, revokedAt: null }, select: { adminUserId: true } })).map((row) => row.adminUserId));
      const warning = alert("clinicops", "healthnet-clinics", { severity: "warning", code: "ONCE_ONLY", summary: "QUEUE_BACKLOG", component: "queue" });
      const retries = await Promise.all([1, 2, 3, 4].map(() => clinic(warning)));
      assert.ok(retries.every((r) => r.status === 202), JSON.stringify(retries.map((r) => r.body)));
      assert.equal(await client.notification.count({ where: { title: { contains: "ONCE_ONLY" } } }), admins.size, "one notification per admin, not per delivery");
    });
  } finally {
    accountsService.setMailApplication(undefined);
    await closeServer(server);
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }
});

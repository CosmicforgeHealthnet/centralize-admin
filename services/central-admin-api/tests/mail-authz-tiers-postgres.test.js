"use strict";

// Spec 19.2 object-level authorization on real PostgreSQL: EMPLOYEE, ADMIN,
// EXECUTIVE and SUPER can never read another employee's PERSONAL mailbox
// (threads, thread summary, messages, search, attachments, drafts, shared
// support queue/notes/activity) without break-glass; with an approved
// break-glass they get READER-only content access that is audited on every
// exposure (metadata only); revoking the requester's or approver's grant (or
// deactivating the approver) ends access immediately, not at expiry. Also: a
// malformed labelId is a 400, never a 500, and contact suggestions never pull
// correspondents from a break-glass mailbox.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp, TOTP_SECRET } = require("./helpers/mail-test-harness");
const { decodeBase32, encryptSecret } = require("../src/shared/auth/mfa-core");
const { closeServer } = require("./helpers/server-close");

const SECRET_SUBJECT = "Private medical leave paperwork";
const SECRET_SENDER = "zz-private-doctor@clinic.example";
const SHARED_SUBJECT = "Customer refund escalation";
const NOTE_TEXT = "internal note: customer is a VIP";
const TIERS = { tierEmployee: "EMPLOYEE", tierAdmin: "ADMIN", tierExecutive: "EXECUTIVE", tierSuper: "SUPER" };

async function addUser(client, harness, ids, key, tier) {
  const id = crypto.randomUUID();
  await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name: key, tier, status: "ACTIVE", mustChangePassword: false } });
  await client.adminMfaEnrollment.create({ data: { adminUserId: id, enrolledAt: new Date(harness.clock().getTime() - 86400000), secretEncrypted: encryptSecret(decodeBase32(TOTP_SECRET), id), updatedAt: new Date() } });
  const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(harness.clock().getTime() + 86400000 * 30), absoluteExpiresAt: new Date(harness.clock().getTime() + 86400000 * 30) } });
  ids[key] = id;
  harness.state.sessions.set(id, session.id);
  return id;
}

test("Mail object-level authorization across tiers + break-glass lifecycle (spec 19.2)", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });

  await addUser(client, harness, ids, "alice", "EMPLOYEE");
  await addUser(client, harness, ids, "carol", "EMPLOYEE"); // shared support member
  await addUser(client, harness, ids, "approver", "EXECUTIVE");
  for (const [key, tier] of Object.entries(TIERS)) await addUser(client, harness, ids, key, tier);
  await client.adminSectionGrant.create({ data: { adminUserId: ids.approver, module: "mail", section: "break-glass-approve", mode: "EDIT", grantedBy: ids.super } });
  // tierAdmin is also a Mail administrator: admin capability never grants content.
  await client.adminSectionGrant.create({ data: { adminUserId: ids.tierAdmin, module: "mail", section: "admin", mode: "EDIT", grantedBy: ids.super } });

  const aliceBox = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.alice, address: { domainId: cf.domain.id, localPart: "alice" } });
  assert.equal(aliceBox.status, 201, aliceBox.text);
  const supportBox = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "SHARED", purpose: "SUPPORT", name: "Support", address: { domainId: cf.domain.id, localPart: "support" } });
  assert.equal(supportBox.status, 201, supportBox.text);
  await client.mailMembership.create({ data: { mailboxId: supportBox.body.data.id, adminUserId: ids.carol, role: "MEMBER", canSend: true, grantedBy: ids.ops, reason: "support agent" } });

  let counter = 0;
  const receive = async (to, from, subject, attachments = []) => {
    counter += 1;
    const id = `tier_${counter}_${crypto.randomUUID().slice(0, 8)}`;
    harness.adapter.addInbound(id, { from: { address: from, name: "Dr Private" }, to: [{ address: to, name: null }], cc: [], envelopeRecipients: [], subject, html: null, text: "very private body", rfcMessageId: `<${id}@mail.example>`, inReplyTo: null, references: [], receivedAt: harness.clock(), spamVerdict: null, attachmentCount: attachments.length }, attachments);
    const result = await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: id, to: [to] }, webhookEventId: null });
    assert.equal(result.delivered, 1);
    return client.mailMessage.findFirst({ where: { rfcMessageId: `<${id}@mail.example>` }, include: { attachments: true } });
  };
  const s = { box: aliceBox.body.data.id, support: supportBox.body.data.id };
  const privateMessage = await receive("alice@cosmicforge.example", SECRET_SENDER, SECRET_SUBJECT, [{ filename: "note.txt", contentType: "text/plain", content: Buffer.from("sick note") }]);
  s.thread = privateMessage.threadId;
  s.attachment = privateMessage.attachments[0].id;
  assert.equal(privateMessage.attachments[0].scanStatus, "CLEAN");
  s.sharedThread = (await receive("support@cosmicforge.example", "customer@partner.example", SHARED_SUBJECT)).threadId;
  const userRow = (key) => client.adminUser.findUnique({ where: { id: ids[key] } });
  await harness.mail.services.support.addNote(await userRow("carol"), s.sharedThread, { body: NOTE_TEXT, mentions: [] }, {});
  const draft = await harness.mail.services.compose.createDraft(await userRow("alice"), s.box, { to: ["partner@partner.example"], subject: "Draft secret", text: "x" });
  s.draft = draft.id;

  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, `${key}: ${response.text}`);
    return response.body.data.stepUpId;
  };
  const openBreakGlass = async (key, mailboxId) => {
    const request = await call(key, "POST", "/break-glass/requests", { mailboxId, justification: "Formal HR investigation, case approved by legal", caseReference: `HR-${crypto.randomUUID().slice(0, 6)}`, stepUpId: await stepUp(key, "BREAK_GLASS_REQUEST") });
    assert.equal(request.status, 201, request.text);
    const approved = await call("approver", "POST", `/break-glass/requests/${request.body.data.id}/approve`, { stepUpId: await stepUp("approver", "BREAK_GLASS_APPROVAL"), durationMinutes: 240 });
    assert.equal(approved.status, 200, approved.text);
    return request.body.data.id;
  };
  const auditCount = (key, action) => client.mailAuditEvent.count({ where: { actorAdminUserId: ids[key], action } });
  const contentEndpoints = () => [
    ["threads", "GET", `/mailboxes/${s.box}/threads?view=all`],
    ["thread", "GET", `/threads/${s.thread}`],
    ["messages", "GET", `/threads/${s.thread}/messages`],
    ["mailbox search", "GET", `/mailboxes/${s.box}/search?q=medical`],
    ["attachment", "GET", `/attachments/${s.attachment}/download`],
    ["drafts", "GET", `/mailboxes/${s.box}/drafts`],
    ["draft", "GET", `/drafts/${s.draft}`],
  ];

  await t.test("owner positive control; malformed labelId is 400 (not 500)", async () => {
    const list = await call("alice", "GET", `/mailboxes/${s.box}/threads?view=all`);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.text.includes(SECRET_SUBJECT));
    for (const bad of ["not-a-uuid", "1' OR 1=1 --", "123"]) {
      const response = await call("alice", "GET", `/mailboxes/${s.box}/threads?view=all&labelId=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 400, `${bad}: ${response.text}`);
      assert.equal(response.body.code, "MAIL_VALIDATION_FAILED");
      const search = await call("alice", "GET", `/mailboxes/${s.box}/search?q=medical&labelId=${encodeURIComponent(bad)}`);
      assert.equal(search.status, 400, search.text);
    }
    // A well-formed but unknown label is just an empty filter.
    const unknown = await call("alice", "GET", `/mailboxes/${s.box}/threads?view=all&labelId=${crypto.randomUUID()}`);
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.data, []);
    // Non-members still get 404 before any validation detail.
    assert.equal((await call("tierEmployee", "GET", `/mailboxes/${s.box}/threads?labelId=bad`)).status, 404);
  });

  await t.test("EMPLOYEE/ADMIN/EXECUTIVE/SUPER cannot read another employee's PERSONAL mailbox", async () => {
    for (const key of [...Object.keys(TIERS), "super", "ops", "mailAdmin"]) {
      for (const [label, method, path] of contentEndpoints()) {
        const response = await call(key, method, path);
        assert.equal(response.status, 404, `${key} ${label}: ${response.status} ${response.text}`);
        assert.ok(!response.text.includes(SECRET_SUBJECT), `${key} ${label} leaks the subject`);
      }
      const global = await call(key, "GET", "/search?q=medical");
      assert.equal(global.status, 200, global.text);
      assert.deepEqual(global.body.data, [], `${key}: unified search never includes the mailbox`);
      const mine = await call(key, "GET", "/me/mailboxes");
      assert.ok(!mine.body.data.some((entry) => entry.id === s.box), `${key} sees the mailbox in /me/mailboxes`);
      const contacts = await call(key, "GET", "/contacts/suggest?q=zz-private");
      assert.ok(!contacts.text.includes(SECRET_SENDER), `${key} contact suggestions leak a correspondent`);
      for (const path of [`/mailboxes/${s.support}/queue`, `/threads/${s.sharedThread}/notes`, `/threads/${s.sharedThread}/activity`]) {
        assert.equal((await call(key, "GET", path)).status, 404, `${key} ${path}`);
      }
    }
    assert.equal(await client.mailAuditEvent.count({ where: { action: { startsWith: "MAIL_BREAK_GLASS_" }, actorAdminUserId: { in: Object.values(ids) } } }), 0);
  });

  await t.test("tier alone never opens break-glass: an explicit request grant is required", async () => {
    for (const key of [...Object.keys(TIERS), "super"]) {
      const response = await call(key, "POST", "/break-glass/requests", { mailboxId: s.box, justification: "Formal HR investigation, case approved by legal", caseReference: "HR-1", stepUpId: crypto.randomUUID() });
      assert.equal(response.status, 403, `${key}: ${response.text}`);
    }
  });

  for (const key of Object.keys(TIERS)) {
    await t.test(`${TIERS[key]}: approved break-glass = READER-only, audited per exposure; grant revocation = immediate denial`, async () => {
      const grant = await client.adminSectionGrant.create({ data: { adminUserId: ids[key], module: "mail", section: "break-glass-request", mode: "EDIT", grantedBy: ids.super } });
      const requestId = await openBreakGlass(key, s.box);

      const list = await call(key, "GET", `/mailboxes/${s.box}/threads?view=all`);
      assert.equal(list.status, 200, list.text);
      assert.ok(list.text.includes(SECRET_SUBJECT));
      assert.equal(await auditCount(key, "MAIL_BREAK_GLASS_THREAD_LIST"), 1, "thread list audited");
      assert.equal((await call(key, "GET", `/threads/${s.thread}`)).status, 200);
      assert.equal(await auditCount(key, "MAIL_BREAK_GLASS_THREAD_VIEW"), 1, "thread summary audited");
      assert.equal((await call(key, "GET", `/threads/${s.thread}/messages`)).status, 200);
      assert.equal(await auditCount(key, "MAIL_BREAK_GLASS_READ"), 1, "message read audited");
      const search = await call(key, "GET", `/mailboxes/${s.box}/search?q=medical`);
      assert.equal(search.status, 200, search.text);
      assert.equal(await auditCount(key, "MAIL_BREAK_GLASS_SEARCH"), 1, "search audited");
      assert.equal((await call(key, "GET", `/attachments/${s.attachment}/download`)).status, 200);
      assert.equal(await auditCount(key, "MAIL_BREAK_GLASS_ATTACHMENT_DOWNLOAD"), 1, "attachment download audited");
      // Drafts are private to their author even under break-glass.
      const drafts = await call(key, "GET", `/mailboxes/${s.box}/drafts`);
      assert.equal(drafts.status, 200);
      assert.deepEqual(drafts.body.data, []);
      assert.equal((await call(key, "GET", `/drafts/${s.draft}`)).status, 404);
      // Unified search and contact suggestions never fold in break-glass mailboxes.
      assert.deepEqual((await call(key, "GET", "/search?q=medical")).body.data, []);
      assert.ok(!(await call(key, "GET", "/contacts/suggest?q=zz-private")).text.includes(SECRET_SENDER));

      // Every break-glass audit row is metadata only and names the request.
      const events = await client.mailAuditEvent.findMany({ where: { actorAdminUserId: ids[key], action: { startsWith: "MAIL_BREAK_GLASS_" }, NOT: { action: "MAIL_BREAK_GLASS_REQUESTED" } } });
      assert.equal(events.length, 5);
      for (const event of events) {
        assert.equal(event.mailboxId, s.box);
        if (event.action !== "MAIL_BREAK_GLASS_ATTACHMENT_DOWNLOAD") assert.equal(event.metadata.breakGlassRequestId, requestId);
        const raw = JSON.stringify(event);
        for (const secret of [SECRET_SUBJECT, SECRET_SENDER, "medical", "very private body", "sick note"]) assert.ok(!raw.includes(secret), `${event.action} leaks ${secret}`);
      }

      // READER only.
      assert.equal((await call(key, "POST", `/threads/${s.thread}/move`, { folder: "TRASH" })).status, 403);
      assert.equal((await call(key, "POST", `/mailboxes/${s.box}/drafts`, { to: ["x@partner.example"] })).status, 403);
      assert.equal((await call(key, "POST", `/mailboxes/${s.box}/labels`, { name: "bg" })).status, 403);

      // Revoking the requester's grant ends access now, not at accessExpiresAt.
      await client.adminSectionGrant.update({ where: { id: grant.id }, data: { revokedAt: harness.clock() } });
      for (const [label, method, path] of contentEndpoints()) {
        if (label === "drafts" || label === "draft") continue;
        const response = await call(key, method, path);
        assert.equal(response.status, 404, `after revocation ${label}: ${response.text}`);
      }
      assert.ok(!(await call(key, "GET", "/me/mailboxes")).body.data.some((entry) => entry.id === s.box));
      const row = await client.mailBreakGlassRequest.findUnique({ where: { id: requestId } });
      assert.equal(row.status, "APPROVED", "the request row alone is not enough");
      assert.ok(row.accessExpiresAt > harness.clock());
      // Clean up for the next tier.
      await client.mailBreakGlassRequest.update({ where: { id: requestId }, data: { status: "REVOKED", revokedAt: harness.clock() } });
    });
  }

  await t.test("shared support mailbox: queue, notes, activity and thread list are audited under break-glass", async () => {
    const grant = await client.adminSectionGrant.create({ data: { adminUserId: ids.tierExecutive, module: "mail", section: "break-glass-request", mode: "EDIT", grantedBy: ids.super } });
    await openBreakGlass("tierExecutive", s.support);
    const queue = await call("tierExecutive", "GET", `/mailboxes/${s.support}/queue`);
    assert.equal(queue.status, 200, queue.text);
    assert.ok(queue.text.includes(SHARED_SUBJECT));
    assert.equal(await auditCount("tierExecutive", "MAIL_BREAK_GLASS_QUEUE_LIST"), 1);
    const notes = await call("tierExecutive", "GET", `/threads/${s.sharedThread}/notes`);
    assert.equal(notes.status, 200, notes.text);
    assert.equal(notes.body.data[0].body, NOTE_TEXT);
    assert.equal(await auditCount("tierExecutive", "MAIL_BREAK_GLASS_NOTES_READ"), 1);
    assert.equal((await call("tierExecutive", "GET", `/threads/${s.sharedThread}/activity`)).status, 200);
    assert.equal(await auditCount("tierExecutive", "MAIL_BREAK_GLASS_ACTIVITY_READ"), 1);
    const events = await client.mailAuditEvent.findMany({ where: { actorAdminUserId: ids.tierExecutive, action: { in: ["MAIL_BREAK_GLASS_QUEUE_LIST", "MAIL_BREAK_GLASS_NOTES_READ", "MAIL_BREAK_GLASS_ACTIVITY_READ"] } } });
    for (const event of events) assert.ok(!JSON.stringify(event).includes("VIP") && !JSON.stringify(event).includes(SHARED_SUBJECT));
    // Break-glass is read-only here too, and shared support listing excludes it.
    assert.equal((await call("tierExecutive", "POST", `/threads/${s.sharedThread}/notes`, { body: "nope" })).status, 403);
    // Members are never audited as break-glass.
    await call("carol", "GET", `/mailboxes/${s.support}/queue`);
    await call("carol", "GET", `/threads/${s.sharedThread}/notes`);
    assert.equal(await client.mailAuditEvent.count({ where: { actorAdminUserId: ids.carol, action: { startsWith: "MAIL_BREAK_GLASS_" } } }), 0);

    // Approver losing their approve grant also invalidates the approval.
    const approveGrant = await client.adminSectionGrant.findFirst({ where: { adminUserId: ids.approver, section: "break-glass-approve", revokedAt: null } });
    await client.adminSectionGrant.update({ where: { id: approveGrant.id }, data: { revokedAt: harness.clock() } });
    assert.equal((await call("tierExecutive", "GET", `/mailboxes/${s.support}/queue`)).status, 404, "approver grant revoked");
    await client.adminSectionGrant.update({ where: { id: approveGrant.id }, data: { revokedAt: null } });
    assert.equal((await call("tierExecutive", "GET", `/mailboxes/${s.support}/queue`)).status, 200, "grant restored within the window");

    // Approver deactivated -> approval no longer valid.
    await client.adminUser.update({ where: { id: ids.approver }, data: { status: "INACTIVE" } });
    assert.equal((await call("tierExecutive", "GET", `/threads/${s.sharedThread}/notes`)).status, 404, "approver inactive");
    await client.adminUser.update({ where: { id: ids.approver }, data: { status: "ACTIVE" } });

    // Expired section grants count as revoked too.
    await client.adminSectionGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // policy evaluates against wall-clock now
    assert.equal((await call("tierExecutive", "GET", `/threads/${s.sharedThread}/notes`)).status, 404, "requester grant expired");
  });

  await t.test("a request cannot be approved once the requester lost the grant", async () => {
    const grant = await client.adminSectionGrant.create({ data: { adminUserId: ids.tierAdmin, module: "mail", section: "break-glass-request", mode: "EDIT", grantedBy: ids.super } });
    const request = await call("tierAdmin", "POST", "/break-glass/requests", { mailboxId: s.box, justification: "Formal HR investigation, case approved by legal", caseReference: "HR-late", stepUpId: await stepUp("tierAdmin", "BREAK_GLASS_REQUEST") });
    assert.equal(request.status, 201, request.text);
    await client.adminSectionGrant.update({ where: { id: grant.id }, data: { revokedAt: harness.clock() } });
    const approved = await call("approver", "POST", `/break-glass/requests/${request.body.data.id}/approve`, { stepUpId: await stepUp("approver", "BREAK_GLASS_APPROVAL") });
    assert.equal(approved.status, 409, approved.text);
    assert.match(approved.text, /REQUESTER_NO_LONGER_ELIGIBLE/);
    assert.equal((await client.mailBreakGlassRequest.findUnique({ where: { id: request.body.data.id } })).status, "PENDING");
    assert.equal((await call("tierAdmin", "GET", `/mailboxes/${s.box}/threads`)).status, 404);
  });
});

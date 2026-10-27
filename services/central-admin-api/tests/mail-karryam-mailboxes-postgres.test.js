"use strict";

// Karryam business mail on one Resend-verified root domain (karryam.com):
// four shared department mailboxes, personal employee mailboxes, and the
// KarryGo Notification Service's reserved no-reply@karryam.com that CA must
// never send as, never store mail for and never store provider events for.
// Real PostgreSQL (replayed migrations), offline fake provider, no network.
// See docs/cosmicforge-mail-karryam-resend-activation.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp, postWebhook } = require("./helpers/mail-test-harness");
const { provisionBrandMail, KARRYAM_MAIL_PLAN } = require("../src/modules/mail/ops/brand-mail-provisioning");
const { brandSenderProblem } = require("../src/modules/mail/marketing/marketing-sender");
const { EICAR } = require("../src/modules/mail/scanning/attachment-scanner");
const { externalSendBlockReason } = require("../src/modules/mail/authz/sending-gate");
const { closeServer } = require("./helpers/server-close");

const DOMAIN = "karryam.com";
const RESERVED = "no-reply@karryam.com,noreply@karryam.com";
const DEPARTMENTS = { info: "Karryam", support: "Karryam Support", marketing: "Karryam Marketing", partnership: "Karryam Partnerships" };
const reasonOf = (response) => response.body?.errors?.[0]?.reason;

test("Karryam shared + personal mailboxes and the reserved no-reply identity on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  // The authorization policy and marketing sender helpers read the reserved
  // list from process.env (they have no config in scope).
  const previousReserved = process.env.MAIL_RESERVED_SENDER_ADDRESSES;
  process.env.MAIL_RESERVED_SENDER_ADDRESSES = RESERVED;
  const db = await openDatabase();
  const { client } = db;
  const env = { MAIL_DOMAIN_ALLOWLIST: `cosmicforge.example,karryam.example,${DOMAIN}`, MAIL_RESERVED_SENDER_ADDRESSES: RESERVED };
  const harness = createHarness(client, { env });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const servers = [];
  const { server, base } = await listen(harness.mountApp(harness.mail));
  servers.push(server);
  const call = caller(base, ids);
  t.after(async () => {
    for (const entry of servers) await closeServer(entry);
    await db.close();
    if (previousReserved === undefined) delete process.env.MAIL_RESERVED_SENDER_ADDRESSES;
    else process.env.MAIL_RESERVED_SENDER_ADDRESSES = previousReserved;
  });
  const drain = () => harness.mail.createWorker().drain();
  const user = (key) => client.adminUser.findUnique({ where: { id: ids[key] } });
  const stepUp = async (key, purpose) => {
    harness.advance(31000); // per-user TOTP time-step replay guard
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const webhook = (type, data, options) => postWebhook(base, harness.clock, type, data, options);
  const s = { boxes: {}, addresses: {} };
  const inbound = (id, to, extra = {}, attachments = []) => {
    harness.adapter.addInbound(id, { from: { address: "customer@client.example", name: "Customer" }, to: to.map((address) => ({ address, name: null })), cc: [], envelopeRecipients: [], subject: `Inbound ${id}`, html: null, text: "hello", rfcMessageId: `<${id}@client.example>`, inReplyTo: null, references: [], receivedAt: harness.clock(), ...extra }, attachments);
    return { id: crypto.randomUUID(), payload: { providerEmailId: id, to }, webhookEventId: null };
  };
  const send = async (key, mailboxId, draft, revision = 1) => {
    const created = await call(key, "POST", `/mailboxes/${mailboxId}/drafts`, { subject: "Hello", text: "hello", ...draft });
    assert.equal(created.status, 201, created.text);
    const sent = await call(key, "POST", `/drafts/${created.body.data.id}/send`, { revision });
    assert.equal(sent.status, 202, sent.text);
    return sent.body.data;
  };
  const sentFor = (messageId) => client.mailMessage.findUnique({ where: { id: messageId } }).then((row) => harness.adapter.state.sent.filter((request) => request.headers["Message-ID"] === row.rfcMessageId));

  await t.test("18: dry run reuses the existing karryam organization and writes nothing", async () => {
    const before = await client.mailAddress.count();
    const dry = await provisionBrandMail({ client, admin: harness.mail.services.admin, config: harness.mail.config, apply: false });
    assert.equal(dry.steps[0].action, "EXISTS", "the seeded karryam organization is reused, never duplicated");
    assert.equal(dry.steps[0].id, brands.karryam.organization.id);
    assert.equal(dry.steps[1].action, "WOULD_CREATE");
    assert.deepEqual(dry.steps.filter((step) => step.target === "shared_mailbox").map((step) => step.action), ["WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE"]);
    assert.equal(dry.steps.find((step) => step.target === "system_address").action, "WOULD_CREATE");
    assert.equal(dry.complete, false);
    assert.equal(await client.mailAddress.count(), before, "dry run never writes");
    await assert.rejects(provisionBrandMail({ client, admin: harness.mail.services.admin, config: harness.mail.config, apply: true }), /acting mail administrator/);
  });

  await t.test("18: apply provisions one domain, four shared mailboxes and the SYSTEM no-reply reservation; re-running changes nothing", async () => {
    const ops = await user("ops");
    const applied = await provisionBrandMail({ client, admin: harness.mail.services.admin, config: harness.mail.config, user: ops, apply: true });
    assert.equal(applied.conflicts, 0, JSON.stringify(applied.steps));
    assert.equal(applied.complete, true);
    const domain = await client.mailDomain.findUnique({ where: { domain: DOMAIN } });
    assert.equal(domain.organizationId, brands.karryam.organization.id);
    assert.equal(domain.status, "PENDING_VERIFICATION", "stays pending until Resend verifies it");
    assert.equal(domain.providerDomainId, null, "no provider id is invented");
    s.domain = domain;
    for (const [local, displayName] of Object.entries(DEPARTMENTS)) {
      const row = await client.mailAddress.findUnique({ where: { address: `${local}@${DOMAIN}` }, include: { mailbox: true } });
      assert.equal(row.kind, "SHARED");
      assert.equal(row.status, "ACTIVE");
      assert.equal(row.displayName, displayName);
      assert.equal(row.mailbox.type, "SHARED");
      assert.equal(row.mailbox.organizationId, brands.karryam.organization.id);
      s.boxes[local] = row.mailboxId;
      s.addresses[local] = row.id;
    }
    assert.deepEqual(Object.fromEntries(await Promise.all(Object.entries(s.boxes).map(async ([local, id]) => [local, (await client.mailMailbox.findUnique({ where: { id } })).purpose]))), { info: "GENERAL", support: "SUPPORT", marketing: "MARKETING", partnership: "GENERAL" });
    assert.equal(new Set(Object.values(s.boxes)).size, 4, "independent mailboxes");
    const noReply = await client.mailAddress.findUnique({ where: { address: `no-reply@${DOMAIN}` } });
    assert.equal(noReply.kind, "SYSTEM");
    assert.equal(noReply.mailboxId, null, "no human mailbox behind no-reply");
    s.noReply = noReply;
    assert.equal(await client.mailMembership.count({ where: { mailboxId: { in: Object.values(s.boxes) } } }), 0, "nobody is assigned automatically");
    assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_MAILBOX_CREATED", mailboxId: { in: Object.values(s.boxes) } } }), 4);

    const counts = async () => [await client.mailOrganization.count(), await client.mailDomain.count(), await client.mailMailbox.count(), await client.mailAddress.count()];
    const before = await counts();
    const again = await provisionBrandMail({ client, admin: harness.mail.services.admin, config: harness.mail.config, user: ops, apply: true });
    assert.ok(again.steps.every((step) => step.action === "EXISTS"), JSON.stringify(again.steps));
    assert.equal(again.complete, true);
    assert.deepEqual(await counts(), before, "idempotent");
  });

  await t.test("18: allowlist and ownership conflicts stop provisioning without writes", async () => {
    const ops = await user("ops");
    const notAllowed = harness.build({ MAIL_DOMAIN_ALLOWLIST: "cosmicforge.example" });
    const blocked = await provisionBrandMail({ client, admin: notAllowed.services.admin, config: notAllowed.config, user: ops, apply: true, plan: { ...KARRYAM_MAIL_PLAN, domain: "karryam-other.com" } });
    assert.equal(blocked.steps[1].action, "BLOCKED");
    assert.equal(blocked.steps[1].reason, "NOT_ALLOWLISTED");
    assert.equal(await client.mailDomain.count({ where: { domain: "karryam-other.com" } }), 0);
    // HealthNet can never claim (or be handed) the Karryam domain.
    const healthnet = await client.mailOrganization.create({ data: { slug: "healthnet", name: "HealthNet", kind: "BRAND", createdBy: ids.super } });
    s.healthnet = healthnet;
    const before = await client.mailMailbox.count();
    const conflict = await provisionBrandMail({ client, admin: harness.mail.services.admin, config: harness.mail.config, user: ops, apply: true, plan: { ...KARRYAM_MAIL_PLAN, organization: { slug: "healthnet", name: "HealthNet", kind: "BRAND" } } });
    assert.equal(conflict.steps[1].action, "CONFLICT");
    assert.equal(conflict.steps[1].reason, "DOMAIN_OWNED_BY_ANOTHER_ORGANIZATION");
    assert.equal(await client.mailMailbox.count(), before);
    assert.equal((await client.mailDomain.findUnique({ where: { domain: DOMAIN } })).organizationId, brands.karryam.organization.id);
  });

  await t.test("G: the admin API lists the domain with honest verification states, then Resend verification flips it", async () => {
    const listed = await call("ops", "GET", "/admin/domains");
    const row = listed.body.data.find((entry) => entry.domain === DOMAIN);
    assert.equal(row.status, "PENDING_VERIFICATION");
    assert.equal(row.checks.sending, "NOT_CONFIGURED");
    assert.equal(row.checks.receiving, "NOT_CONFIGURED");
    // Sending is refused while the domain is unverified.
    const domain = await client.mailDomain.findUnique({ where: { domain: DOMAIN }, include: { organization: true } });
    assert.equal(externalSendBlockReason({ config: harness.mail.config, providerReady: () => true, domain }), "SENDER_DOMAIN_NOT_VERIFIED");
    // Simulated provider verification (offline fake; the real one is done in Resend).
    harness.adapter.state.domains.set("fake_karryam_com", { status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", records: [{ record: "SPF", type: "TXT", name: "send", value: "v=spf1", status: "verified" }, { record: "DKIM", type: "TXT", name: "resend._domainkey", value: "p=x", status: "verified" }, { record: "MX", type: "MX", name: "@", value: "inbound", status: "verified" }] });
    await client.mailDomain.update({ where: { id: domain.id }, data: { providerDomainId: "fake_karryam_com" } });
    const verified = await call("ops", "POST", `/admin/domains/${domain.id}/verify`, {});
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.data.status, "VERIFIED");
    assert.equal(verified.body.data.checks.dmarc, "NOT_REPORTED", "DMARC is never invented");
    const mailboxes = await call("ops", "GET", `/admin/mailboxes?organizationId=${brands.karryam.organization.id}`);
    assert.deepEqual(mailboxes.body.data.filter((box) => Object.values(s.boxes).includes(box.id)).map((box) => box.addresses[0].address).sort(), Object.keys(DEPARTMENTS).map((local) => `${local}@${DOMAIN}`).sort());
  });

  await t.test("5/3: authorized staff are assigned per mailbox; a personal mailbox is provisioned through the request workflow", async () => {
    const grant = async (mailbox, key, role, canSend) => {
      const response = await call("ops", "POST", `/mailboxes/${s.boxes[mailbox]}/members`, { adminUserId: ids[key], role, canSend, reason: "Karryam department staff", stepUpId: await stepUp("ops", "MAIL_MEMBERSHIP_GRANT") });
      assert.equal(response.status, 201, response.text);
    };
    await grant("support", "dave", "MEMBER", true);
    await grant("info", "erin", "MEMBER", true);
    await grant("partnership", "erin", "MEMBER", true);
    await grant("marketing", "kim", "MEMBER", true);
    await grant("partnership", "fay", "READER", false);

    const request = await call("ops", "POST", "/provisioning/requests", { type: "PERSONAL_MAILBOX", subjectAdminUserId: ids.dave, requestedAddress: `dave@${DOMAIN}`, name: "Dave", justification: "New Karryam staff member" });
    assert.equal(request.status, 201, request.text);
    assert.equal((await call("ops", "POST", `/provisioning/requests/${request.body.data.id}/approve`, {})).body.code, "MAIL_FORBIDDEN", "no self-approval");
    const approved = await call("mailAdmin", "POST", `/provisioning/requests/${request.body.data.id}/approve`, {});
    assert.equal(approved.status, 200, approved.text);
    s.boxes.dave = approved.body.data.provisionedMailboxId;
    const personal = await client.mailAddress.findUnique({ where: { address: `dave@${DOMAIN}` }, include: { mailbox: true } });
    assert.equal(personal.kind, "PRIMARY");
    assert.equal(personal.mailbox.type, "PERSONAL");
    assert.equal(personal.mailbox.ownerAdminUserId, ids.dave);
    // Personal mailbox privacy: an admin can never add anyone to it.
    assert.equal((await call("ops", "POST", `/mailboxes/${s.boxes.dave}/members`, { adminUserId: ids.erin, role: "READER", stepUpId: await stepUp("ops", "MAIL_MEMBERSHIP_GRANT") })).status, 403);
  });

  await t.test("2/5/6: each mailbox offers only its own sender identity with the right display name; send-as is refused", async () => {
    const identities = async (key, mailbox) => (await call(key, "GET", `/mailboxes/${s.boxes[mailbox]}`)).body.data.senderIdentities.map((identity) => `${identity.displayName} <${identity.address}>`);
    assert.deepEqual(await identities("dave", "support"), [`Karryam Support <support@${DOMAIN}>`]);
    assert.deepEqual(await identities("erin", "info"), [`Karryam <info@${DOMAIN}>`]);
    assert.deepEqual(await identities("erin", "partnership"), [`Karryam Partnerships <partnership@${DOMAIN}>`]);
    assert.deepEqual(await identities("kim", "marketing"), [`Karryam Marketing <marketing@${DOMAIN}>`]);
    assert.deepEqual(await identities("dave", "dave"), [`Dave <dave@${DOMAIN}>`]);
    assert.deepEqual(await identities("fay", "partnership"), [], "a READER cannot send");
    // Membership is the access boundary between departments.
    assert.equal((await call("dave", "GET", `/mailboxes/${s.boxes.info}`)).status, 404);
    assert.equal((await call("erin", "GET", `/mailboxes/${s.boxes.dave}`)).status, 404, "personal mailbox stays private");
    // Send as another department or another person: refused.
    const spoof = await call("dave", "POST", `/mailboxes/${s.boxes.support}/drafts`, { to: ["x@client.example"], senderAddressId: s.addresses.info, subject: "x", text: "x" });
    assert.equal(spoof.status, 403);
    assert.equal(spoof.body.code, "MAIL_SENDER_NOT_AUTHORIZED");
    assert.equal((await call("fay", "POST", `/mailboxes/${s.boxes.partnership}/drafts`, { to: ["x@client.example"], subject: "x", text: "x" })).status, 403);
  });

  await t.test("3: the reserved no-reply identity cannot be granted, created as an inbox or used through a stale grant", async () => {
    const grant = await call("ops", "POST", "/admin/sender-grants", { mailboxId: s.boxes.support, addressId: s.noReply.id, adminUserId: ids.dave });
    assert.equal(grant.status, 403, grant.text);
    assert.equal(reasonOf(grant), "SYSTEM_IDENTITY_NOT_GRANTABLE");
    const request = await call("dave", "POST", "/provisioning/requests", { type: "SENDER_GRANT", mailboxId: s.boxes.support, addressId: s.noReply.id, organizationId: brands.karryam.organization.id, justification: "please" });
    assert.equal(request.status, 403);
    assert.equal(reasonOf(request), "SYSTEM_IDENTITY_NOT_GRANTABLE");
    // A second reserved address can only be a SYSTEM address without a mailbox.
    const inbox = await call("ops", "POST", "/admin/mailboxes", { organizationId: brands.karryam.organization.id, type: "SHARED", name: "No reply", purpose: "GENERAL", address: { domainId: s.domain.id, localPart: "noreply" } });
    assert.equal(inbox.status, 400, inbox.text);
    assert.equal(reasonOf(inbox), "RESERVED_ADDRESS_SYSTEM_ONLY");
    const alias = await call("ops", "POST", "/admin/addresses", { domainId: s.domain.id, localPart: "noreply", kind: "ALIAS", mailboxId: s.boxes.support, aliasOfAddressId: s.addresses.support });
    assert.equal(reasonOf(alias), "RESERVED_ADDRESS_SYSTEM_ONLY");
    assert.equal(await client.mailAddress.count({ where: { address: `noreply@${DOMAIN}` } }), 0);
    // A grant that predates this rule is ignored at draft and at dispatch.
    await client.mailSenderGrant.create({ data: { mailboxId: s.boxes.support, addressId: s.noReply.id, adminUserId: ids.dave, grantedBy: ids.super } });
    assert.ok(!(await call("dave", "GET", `/mailboxes/${s.boxes.support}`)).body.data.senderIdentities.some((identity) => identity.address === `no-reply@${DOMAIN}`));
    const draft = await call("dave", "POST", `/mailboxes/${s.boxes.support}/drafts`, { to: ["x@client.example"], senderAddressId: s.noReply.id, subject: "x", text: "x" });
    assert.equal(draft.status, 403);
    assert.equal(draft.body.code, "MAIL_SENDER_NOT_AUTHORIZED");
    await client.mailSenderGrant.updateMany({ where: { addressId: s.noReply.id }, data: { revokedAt: harness.clock() } });
  });

  await t.test("4/3: marketing keeps its own identities and never offers or accepts no-reply", async () => {
    const identities = await call("kim", "GET", `/marketing/${brands.karryam.organization.id}/sender-identities`);
    assert.equal(identities.status, 200, identities.text);
    const addresses = identities.body.data.map((entry) => entry.address);
    assert.ok(addresses.includes(`marketing@${DOMAIN}`));
    assert.ok(!addresses.includes(`no-reply@${DOMAIN}`));
    assert.equal(brandSenderProblem({ ...s.noReply, mailbox: null }, brands.karryam.organization.id), "RESERVED_SENDER");
    // Ordinary SYSTEM brand senders keep working (only reserved ones are refused).
    assert.equal(brandSenderProblem({ ...s.noReply, address: `hello@${DOMAIN}`, mailbox: null }, brands.karryam.organization.id), null);
    // Campaign dispatch stays off in this setup unless explicitly enabled.
    const staging = harness.build({ MAIL_BROADCAST_DISPATCH_ENABLED: "" });
    assert.equal(staging.config.broadcastDispatchEnabled, false);
  });

  await t.test("2/10: four department identities send from one root domain; CC/BCC and internal copies are honoured", async () => {
    const support = await send("dave", s.boxes.support, { to: ['"Customer" <customer@client.example>'], cc: [`info@${DOMAIN}`], bcc: ["audit@client.example"], subject: "Your booking" });
    const info = await send("erin", s.boxes.info, { to: ["press@media.example"], subject: "Enquiry" });
    const partnership = await send("erin", s.boxes.partnership, { to: ["bd@partner.example"], subject: "Partnership" });
    const marketing = await send("kim", s.boxes.marketing, { to: ["agency@agency.example"], subject: "Brief" });
    await drain();
    await drain();
    const expectFrom = async (sent, local) => {
      const requests = await sentFor(sent.messageId);
      assert.equal(requests.length, 1, `${local}: exactly one provider send`);
      assert.deepEqual(requests[0].from, { address: `${local}@${DOMAIN}`, name: DEPARTMENTS[local] });
      return requests[0];
    };
    const supportRequest = await expectFrom(support, "support");
    assert.deepEqual(supportRequest.to.map((party) => party.address), ["customer@client.example"]);
    assert.deepEqual(supportRequest.bcc.map((party) => party.address), ["audit@client.example"]);
    assert.ok(!(supportRequest.cc || []).some((party) => party.address.endsWith(`@${DOMAIN}`)), "external-only mode keeps internal Cc local");
    await expectFrom(info, "info");
    await expectFrom(partnership, "partnership");
    await expectFrom(marketing, "marketing");
    // The internal Cc landed once in the info inbox, without the Bcc.
    const copy = await client.mailMessage.findFirst({ where: { mailboxId: s.boxes.info, direction: "INTERNAL", rfcMessageId: (await client.mailMessage.findUnique({ where: { id: support.messageId } })).rfcMessageId }, include: { recipients: true } });
    assert.ok(copy, "internal copy delivered");
    assert.ok(!copy.recipients.some((recipient) => recipient.type === "BCC"));
    assert.equal((await call("dave", "GET", `/messages/${support.messageId}/status`)).body.data.status, "PROVIDER_ACCEPTED", "accepted is not delivered");
    s.supportSent = support;
    s.supportProviderId = supportRequest.providerMessageId;
    s.supportRfc = supportRequest.headers["Message-ID"];
  });

  await t.test("7/8: inbound mail routes to each department; unknown, reserved and disabled receiving are safe", async () => {
    for (const local of Object.keys(DEPARTMENTS)) {
      const result = await harness.mail.processors.inbound.process(inbound(`dept_${local}`, [`${local}@${DOMAIN}`]));
      assert.equal(result.delivered, 1, local);
      assert.equal(await client.mailMessage.count({ where: { mailboxId: s.boxes[local], providerMessageId: `dept_${local}` } }), 1);
      for (const other of Object.keys(DEPARTMENTS).filter((entry) => entry !== local)) assert.equal(await client.mailMessage.count({ where: { mailboxId: s.boxes[other], providerMessageId: `dept_${local}` } }), 0);
    }
    const both = await harness.mail.processors.inbound.process(inbound("dept_both", [`info@${DOMAIN}`, `support@${DOMAIN}`]));
    assert.equal(both.delivered, 2, "one copy per addressed mailbox");

    // No catch-all: an unprovisioned address is rejected and nothing is stored.
    const unknown = await harness.mail.processors.inbound.process(inbound("dept_unknown", [`sales@${DOMAIN}`]));
    assert.deepEqual(unknown, { delivered: 0, unknown: 1 });
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "dept_unknown" } }), 0);

    // Replies to KarryGo's no-reply: discarded and audited, even under the quarantine policy.
    const quarantine = harness.build({ MAIL_UNKNOWN_RECIPIENT_POLICY: "quarantine" });
    const reserved = await quarantine.processors.inbound.process(inbound("noreply_reply", [`no-reply@${DOMAIN}`], { subject: "Re: Your login code" }));
    assert.equal(reserved.delivered, 0);
    assert.equal(reserved.discardedReserved, 1);
    assert.equal(await client.mailMessage.count({ where: { providerMessageId: "noreply_reply" } }), 0);
    assert.equal(await client.mailOutboxJob.count({ where: { idempotencyKey: { startsWith: "inbound:unknown-hold:noreply_reply" } } }), 0, "never held for an operator");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_INBOUND_RESERVED_ADDRESS_DISCARDED" }, orderBy: { createdAt: "desc" } });
    assert.equal(audit.metadata.discardedCount, 1);
    assert.ok(!JSON.stringify(audit.metadata).includes("no-reply@"), "audit holds counts and domains, not addresses");
    const mixed = await quarantine.processors.inbound.process(inbound("noreply_mixed", [`support@${DOMAIN}`, `no-reply@${DOMAIN}`]));
    assert.equal(mixed.delivered, 1);
    assert.equal(mixed.discardedReserved, 1);
    assert.equal(mixed.heldUnknown, undefined);

    // Receiving disabled: the webhook is not acknowledged and the job defers.
    const off = harness.build({ MAIL_RECEIVING_ENABLED: "false" });
    const deferred = await off.processors.inbound.process(inbound("dept_off", [`support@${DOMAIN}`]));
    assert.equal(deferred.defer.code, "MAIL_RECEIVING_DISABLED");
    const offServer = await listen(harness.mountApp(off));
    servers.push(offServer.server);
    const refused = await postWebhook(offServer.base, harness.clock, "email.received", { email_id: "dept_off", to: [`support@${DOMAIN}`] });
    assert.equal(refused.status, 503);
  });

  await t.test("9: a customer reply threads into the support conversation by Message-ID", async () => {
    const reply = await harness.mail.processors.inbound.process(inbound("support_reply", [`support@${DOMAIN}`], { subject: "Re: Your booking", rfcMessageId: "<reply-1@client.example>", inReplyTo: s.supportRfc, references: [s.supportRfc] }));
    assert.equal(reply.delivered, 1);
    const original = await client.mailMessage.findUnique({ where: { id: s.supportSent.messageId } });
    const replyRow = await client.mailMessage.findFirst({ where: { mailboxId: s.boxes.support, providerMessageId: "support_reply" } });
    assert.equal(replyRow.threadId, original.threadId);
    // Staff reply keeps the thread headers.
    const draft = await call("dave", "POST", `/mailboxes/${s.boxes.support}/drafts`, { mode: "REPLY", inReplyToMessageId: replyRow.id, text: "Thanks" });
    assert.equal(draft.status, 201, draft.text);
    const sent = await call("dave", "POST", `/drafts/${draft.body.data.id}/send`, { revision: 1 });
    assert.equal(sent.status, 202, sent.text);
    await drain();
    const [request] = await sentFor(sent.body.data.messageId);
    assert.equal(request.headers["In-Reply-To"], "<reply-1@client.example>");
    assert.ok(request.headers.References.includes(s.supportRfc));
    assert.deepEqual(request.from, { address: `support@${DOMAIN}`, name: "Karryam Support" });
  });

  await t.test("11/13: KarryGo no-reply events on the shared webhook are acknowledged and never stored; CA events still apply", async () => {
    const events = () => client.mailWebhookEvent.count();
    const before = await events();
    const suppressions = await client.marketingSuppression.count();
    for (const [type, from] of [["email.sent", `Karryam <no-reply@${DOMAIN}>`], ["email.delivered", `no-reply@${DOMAIN}`], ["email.bounced", `"Karryam" <NO-REPLY@karryam.com>`], ["email.complained", `Karryam <no-reply@${DOMAIN}>`]]) {
      const response = await webhook(type, { email_id: `kg_${crypto.randomUUID()}`, from, to: ["rider@gmail.example"], subject: "Your login code", bounce: type === "email.bounced" ? { type: "Permanent", message: "no such user" } : undefined });
      assert.equal(response.status, 200, type);
      assert.equal(response.body.ignored, true);
      assert.equal(response.body.reason, "FOREIGN_SENDER");
    }
    // Another product sharing the provider account (an address CA never provisioned).
    const other = await webhook("email.delivered", { email_id: "hn_1", from: "alerts@healthnet-mail.example", to: ["patient@gmail.example"] });
    assert.equal(other.body.reason, "FOREIGN_SENDER");
    assert.equal(await events(), before, "no recipient data from other systems is stored");
    assert.equal(await client.mailDeliveryEvent.count({ where: { recipient: { contains: "rider@" } } }), 0);
    assert.equal(await client.marketingSuppression.count(), suppressions, "KarryGo bounces never suppress CA contacts");

    // CA's own events (with or without from) are still stored, deduplicated and applied.
    const delivered = await webhook("email.delivered", { email_id: s.supportProviderId, from: `Karryam Support <support@${DOMAIN}>`, to: ["customer@client.example"] });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.duplicate, false);
    const duplicate = await webhook("email.delivered", { email_id: s.supportProviderId, from: `Karryam Support <support@${DOMAIN}>`, to: ["customer@client.example"] }, { id: delivered.id });
    assert.equal(duplicate.body.duplicate, true);
    await drain();
    const status = (await call("dave", "GET", `/messages/${s.supportSent.messageId}/status`)).body.data;
    assert.equal(status.recipients.find((recipient) => recipient.address === "customer@client.example").status, "DELIVERED");
    // Malformed / forged.
    const forged = await webhook("email.delivered", { email_id: s.supportProviderId, from: `no-reply@${DOMAIN}` }, { secret: `whsec_${crypto.randomBytes(24).toString("base64")}` });
    assert.equal(forged.status, 401, "signature is checked before anything else");
    const noId = await webhook("email.delivered", { from: `support@${DOMAIN}`, to: ["customer@client.example"] });
    assert.equal(noId.status, 400);
  });

  await t.test("14: provider 429 retries with the same key and quota exhaustion defers without failing", async () => {
    harness.adapter.failNext("sendMessage", "RETRYABLE", "RESEND_HTTP_429");
    const limited = await send("dave", s.boxes.support, { to: ["limited@client.example"] });
    await drain();
    let job = await client.mailOutboxJob.findUnique({ where: { id: limited.jobId } });
    assert.equal(job.status, "RETRY_SCHEDULED");
    assert.equal(job.lastErrorCode, "RESEND_HTTP_429");
    harness.advance(3600000);
    await drain();
    job = await client.mailOutboxJob.findUnique({ where: { id: limited.jobId } });
    assert.equal(job.status, "SUCCEEDED");
    assert.equal((await sentFor(limited.messageId)).length, 1, "no duplicate after a 429");

    harness.adapter.failNext("sendMessage", "QUOTA_EXHAUSTED", "DAILY", { now: harness.clock() });
    const quota = await send("erin", s.boxes.info, { to: ["quota@client.example"] });
    await drain();
    job = await client.mailOutboxJob.findUnique({ where: { id: quota.jobId } });
    assert.notEqual(job.status, "DEAD_LETTER");
    assert.notEqual(job.status, "FAILED");
    assert.equal(job.lastErrorCode, "PROVIDER_QUOTA_EXHAUSTED");
    assert.equal((await call("erin", "GET", `/messages/${quota.messageId}/status`)).body.data.status, "QUEUED", "held, never reported as failed or sent");
  });

  await t.test("15: inbound attachments are scanned, encrypted at rest and malware is quarantined", async () => {
    const clean = await harness.mail.processors.inbound.process(inbound("att_clean", [`support@${DOMAIN}`], {}, [{ filename: "receipt.txt", contentType: "text/plain", content: Buffer.from("karryam receipt 123") }]));
    assert.equal(clean.delivered, 1);
    const attachment = await client.mailAttachment.findFirst({ where: { mailboxId: s.boxes.support, filename: "receipt.txt" } });
    assert.equal(attachment.scanStatus, "CLEAN");
    const stored = harness.backend.objects.get(attachment.storageKey);
    assert.ok(stored && !stored.includes(Buffer.from("karryam receipt 123")), "ciphertext at rest");
    const infected = await harness.mail.processors.inbound.process(inbound("att_virus", [`support@${DOMAIN}`], {}, [{ filename: "invoice.txt", contentType: "text/plain", content: Buffer.from(EICAR) }]));
    assert.equal(infected.delivered, 1);
    const message = await client.mailMessage.findFirst({ where: { mailboxId: s.boxes.support, providerMessageId: "att_virus" }, include: { attachments: true } });
    assert.equal(message.status, "QUARANTINED");
    assert.equal(message.attachments[0].scanStatus, "INFECTED");
  });

  await t.test("12: HealthNet stays isolated from Karryam mail", async () => {
    const hnDomain = await client.mailDomain.create({ data: { organizationId: s.healthnet.id, domain: "healthnet.example", status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED" } });
    const hnBox = await client.mailMailbox.create({ data: { organizationId: s.healthnet.id, type: "SHARED", purpose: "SUPPORT", name: "HealthNet Care" } });
    await client.mailAddress.create({ data: { organizationId: s.healthnet.id, domainId: hnDomain.id, mailboxId: hnBox.id, localPart: "care", address: "care@healthnet.example", kind: "SHARED", status: "ACTIVE" } });
    // Mail addressed to both brands: only the allowlisted (Karryam) mailbox
    // gets a copy. A registered domain outside MAIL_DOMAIN_ALLOWLIST is
    // routed like an external domain: no copy, no hold, no unknown-recipient audit.
    const unknownAudits = () => client.mailAuditEvent.count({ where: { action: { startsWith: "MAIL_INBOUND_UNKNOWN" } } });
    const auditsBefore = await unknownAudits();
    const both = await harness.mail.processors.inbound.process(inbound("cross_brand", [`support@${DOMAIN}`, "care@healthnet.example"]));
    assert.equal(both.delivered, 1);
    assert.equal(both.unknown, 0, "the HealthNet address is not one of our routed domains");
    assert.equal(await client.mailMessage.count({ where: { mailboxId: hnBox.id, providerMessageId: "cross_brand" } }), 0);
    assert.equal(await client.mailMessage.count({ where: { mailboxId: s.boxes.support, providerMessageId: "cross_brand" } }), 1);
    const hnOnly = await harness.mail.processors.inbound.process(inbound("hn_only", ["care@healthnet.example"]));
    assert.deepEqual([hnOnly.delivered, hnOnly.unknown], [0, 0]);
    assert.equal(await unknownAudits(), auditsBefore);
    // Routing follows the allowlist: only an explicit allowlist entry routes it.
    const hnRouted = harness.build({ MAIL_DOMAIN_ALLOWLIST: `cosmicforge.example,karryam.example,${DOMAIN},healthnet.example` });
    assert.equal((await hnRouted.processors.inbound.process(inbound("hn_routed", ["care@healthnet.example"]))).delivered, 1);
    assert.equal((await call("dave", "GET", `/mailboxes/${hnBox.id}`)).status, 404, "Karryam staff never see HealthNet mailboxes");
    // HealthNet can never send through the Karryam provider setup.
    const domain = await client.mailDomain.findUnique({ where: { id: hnDomain.id }, include: { organization: true } });
    assert.equal(externalSendBlockReason({ config: harness.mail.config, providerReady: () => true, domain }), "SENDER_DOMAIN_NOT_ALLOWLISTED");
    const allowlisted = harness.build({ MAIL_DOMAIN_ALLOWLIST: `${DOMAIN},healthnet.example` });
    assert.equal(externalSendBlockReason({ config: allowlisted.config, providerReady: () => true, domain }), "SENDER_ORGANIZATION_RESTRICTED_HEALTH");
    // A Karryam marketer has no HealthNet or CosmicForge marketing scope.
    assert.equal((await call("kim", "GET", `/marketing/${s.healthnet.id}/sender-identities`)).status, 404);
    assert.equal((await call("kim", "GET", `/marketing/${brands.cosmicforge.organization.id}/sender-identities`)).status, 404);
  });

  await t.test("3: offboarding a Karryam employee closes the personal mailbox and every department membership", async () => {
    const offboard = await call("ops", "POST", `/admin/users/${ids.dave}/offboard`, {});
    assert.equal(offboard.status, 200, offboard.text);
    assert.equal(await client.mailMembership.count({ where: { adminUserId: ids.dave, revokedAt: null } }), 0);
    assert.equal((await client.mailMailbox.findUnique({ where: { id: s.boxes.dave } })).status, "SUSPENDED");
    assert.equal((await call("dave", "GET", `/mailboxes/${s.boxes.support}`)).status, 404);
  });
});

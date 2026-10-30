"use strict";

// GAP 8 (spec 11.8): mixed internal/external recipient header fidelity and
// provider Message-ID capture, on real PostgreSQL (replayed migrations,
// offline fake provider). Both MAIL_MIXED_RECIPIENT_MODE values:
// - external-only (default): provider gets only external recipients.
// - full-headers: provider gets the full visible To/Cc (+ external BCC);
//   internal recipients keep one local copy; provider echoes are dropped by
//   the signed X-CosmicForge-Origin header or by Message-ID / provider alias.
// Plus the pre-migration-37 behaviour (no alias table).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, postWebhook } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { createOriginHeader } = require("../src/modules/mail/security/origin-header");

const ROLLBACK_37 = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");
const ORIGIN_SECRET = crypto.randomBytes(32).toString("hex");
const FULL = { MAIL_MIXED_RECIPIENT_MODE: "full-headers", MAIL_RECEIVING_CUTOVER_CONFIRMED: "true", MAIL_ORIGIN_HEADER_SECRET: ORIGIN_SECRET };
const AUTH_PASS = { spf: "pass", dkim: "pass", dmarc: "pass" };
const state = {};

const DAVE = "dave@cosmicforge.example";
const ERIN = "erin@cosmicforge.example";
const FAY = "fay@cosmicforge.example";
const EXT1 = "partner@partner.example";
const EXT2 = "client@client.example";
const EXT3 = "third@third.example";

async function setup(t, { preMigration37 = false } = {}) {
  const db = await openDatabase();
  const { client } = db;
  if (preMigration37) await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK_37, "utf8"));
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const full = harness.build(FULL, { encryption: harness.mail.encryption });
  assert.equal(full.config.mixedRecipients.mode, "full-headers");
  assert.equal(harness.mail.config.mixedRecipients.mode, "external-only", "default mode is external-only");
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const boxes = {};
  for (const key of ["dave", "erin", "fay"]) {
    const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids[key], address: { domainId: cf.domain.id, localPart: key } });
    assert.equal(box.status, 201, box.text);
    boxes[key] = box.body.data.id;
  }

  async function send({ to = [], cc = [], bcc = [], subject = "Mixed", user = "dave", mailbox = boxes.dave }) {
    const draft = await call(user, "POST", `/mailboxes/${mailbox}/drafts`, { to, cc, bcc, subject, text: "hello" });
    assert.equal(draft.status, 201, draft.text);
    const sent = await call(user, "POST", `/drafts/${draft.body.data.id}/send`, { revision: draft.body.data.revision });
    assert.equal(sent.status, 202, sent.text);
    return sent.body.data.messageId;
  }
  async function dispatch(app) {
    const before = harness.adapter.state.sent.length;
    await app.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 20 });
    return harness.adapter.state.sent.slice(before);
  }
  async function events(app) {
    await app.createWorker({ queues: ["EVENTS"] }).drain({ maxTicks: 20 });
  }
  const webhook = (type, data, options) => postWebhook(base, harness.clock, type, data, options);
  let inboundCounter = 0;
  async function inbound(app, message) {
    inboundCounter += 1;
    const id = `in_mixed_${inboundCounter}_${crypto.randomUUID().slice(0, 8)}`;
    harness.adapter.addInbound(id, { cc: [], envelopeRecipients: [], html: null, text: "hello", inReplyTo: null, references: [], receivedAt: harness.clock(), providerAuthentication: AUTH_PASS, ...message });
    const envelope = [...(message.to || []), ...(message.cc || [])].map((party) => party.address);
    return app.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: id, to: envelope }, webhookEventId: null });
  }
  const message = (id) => client.mailMessage.findUnique({ where: { id }, include: { recipients: true } });
  const copies = (mailboxId, rfcMessageId) => client.mailMessage.count({ where: { mailboxId, rfcMessageId } });
  const addresses = (list) => list.map((party) => party.address).sort();
  return { client, harness, full, call, boxes, send, dispatch, events, webhook, inbound, message, copies, addresses, ids };
}

test("GAP 8 mixed recipients on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const env = await setup(t);
  const { client, harness, full, call, boxes, send, dispatch, events, webhook, inbound, message, copies, addresses } = env;
  const fullAudit = (action) => client.mailAuditEvent.count({ where: { action } });

  await t.test("external-only (default): internal To + external Cc -> provider gets only the external Cc (promoted)", async () => {
    const id = await send({ to: [ERIN], cc: [EXT1] });
    const [request, ...rest] = await dispatch(harness.mail);
    assert.equal(rest.length, 0);
    assert.deepEqual(addresses(request.to), [EXT1], "Cc promoted to To (Resend requires to)");
    assert.deepEqual(request.cc, []);
    assert.equal(request.headers["X-CosmicForge-Origin"], undefined, "no origin header in external-only mode");
    const row = await message(id);
    assert.equal(row.recipients.find((r) => r.address === ERIN).status, "INTERNAL_DELIVERED");
    assert.equal(row.recipients.find((r) => r.address === ERIN).providerMessageId, null);
    assert.equal(await copies(boxes.erin, row.rfcMessageId), 1);
  });

  await t.test("external-only: external To + internal Cc -> provider gets the external To only", async () => {
    await send({ to: [EXT1], cc: [ERIN] });
    const [request] = await dispatch(harness.mail);
    assert.deepEqual(addresses(request.to), [EXT1]);
    assert.deepEqual(request.cc, []);
  });

  await t.test("full-headers: internal To + external Cc -> visible To/Cc preserved, one local copy", async () => {
    const id = await send({ to: [ERIN], cc: [EXT1] });
    const sent = await dispatch(full);
    assert.equal(sent.length, 1);
    const [request] = sent;
    assert.deepEqual(addresses(request.to), [ERIN], "internal To stays To");
    assert.deepEqual(addresses(request.cc), [EXT1], "external Cc stays Cc");
    assert.deepEqual(request.bcc, []);
    const signer = createOriginHeader({ secret: ORIGIN_SECRET });
    assert.equal(signer.verify(request.headers["X-CosmicForge-Origin"]), id, "signed origin header names the message");
    const row = await message(id);
    assert.equal(request.headers["Message-ID"], row.rfcMessageId);
    const erin = row.recipients.find((r) => r.address === ERIN);
    assert.equal(erin.status, "INTERNAL_DELIVERED", "internal recipient keeps its local status");
    assert.equal(erin.providerMessageId, row.providerMessageId, "provider request id recorded, status unchanged");
    assert.equal(row.recipients.find((r) => r.address === EXT1).status, "PROVIDER_ACCEPTED");
    assert.equal(row.status, "PROVIDER_ACCEPTED");
    assert.equal(await copies(boxes.erin, row.rfcMessageId), 1);
  });

  await t.test("full-headers: external To + internal Cc", async () => {
    await send({ to: [EXT1], cc: [ERIN] });
    const [request] = await dispatch(full);
    assert.deepEqual(addresses(request.to), [EXT1]);
    assert.deepEqual(addresses(request.cc), [ERIN]);
  });

  await t.test("both modes: internal BCC is never given to the provider and never visible", async () => {
    for (const app of [harness.mail, full]) {
      const id = await send({ to: [EXT1], bcc: [ERIN] });
      const [request] = await dispatch(app);
      const all = [...request.to, ...request.cc, ...request.bcc].map((party) => party.address);
      assert.ok(!all.includes(ERIN), "internal BCC not sent to the provider");
      assert.equal(request.headers["X-CosmicForge-Origin"], undefined, "nothing internal is addressed: no echo expected");
      const row = await message(id);
      const copy = await client.mailMessage.findFirst({ where: { mailboxId: boxes.erin, rfcMessageId: row.rfcMessageId }, include: { recipients: true } });
      assert.ok(copy, "BCC recipient got its local copy");
      assert.ok(!copy.recipients.some((r) => r.type === "BCC"), "no Bcc rows on the copy");
    }
  });

  await t.test("external BCC + internal To: individual, attributable BCC requests; no internal-only request", async () => {
    const id = await send({ to: [ERIN], bcc: [EXT1, EXT2] });
    const sent = await dispatch(full);
    // Re-audit fix 5: events of a request echoing an internal To cannot be
    // attributed to an external BCC, so each external BCC gets its own
    // request, and the internal-only To request is not sent at all.
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((request) => addresses(request.to)[0]).sort(), [EXT1, EXT2].sort());
    for (const request of sent) {
      assert.deepEqual(request.cc, []);
      assert.deepEqual(request.bcc, []);
      assert.ok(!addresses(request.to).includes(ERIN), "internal To never given to the provider alone");
    }
    // external-only keeps individual BCC requests (no external To/Cc).
    await send({ to: [ERIN], bcc: [EXT1, EXT2] });
    const legacy = await dispatch(harness.mail);
    assert.equal(legacy.length, 2);
    for (const request of legacy) {
      assert.equal(request.to.length, 1);
      assert.deepEqual(request.bcc, []);
    }
    const row = await message(id);
    assert.equal(row.recipients.filter((r) => r.type === "BCC").every((r) => r.status === "PROVIDER_ACCEPTED"), true);
  });

  await t.test("multiple external recipients and multiple internal mailboxes: one copy each, echoes deduped", async () => {
    const id = await send({ to: [EXT1, ERIN], cc: [EXT2, FAY], bcc: [EXT3] });
    const [request, bccRequest, ...rest] = await dispatch(full);
    assert.equal(rest.length, 0);
    assert.deepEqual(addresses(request.to), [ERIN, EXT1].sort());
    assert.deepEqual(addresses(request.cc), [EXT2, FAY].sort());
    assert.deepEqual(request.bcc, [], "external BCC next to internal recipients: individual request");
    assert.deepEqual(addresses(bccRequest.to), [EXT3]);
    assert.equal(bccRequest.headers["X-CosmicForge-Origin"], undefined);
    const row = await message(id);
    // The provider delivers back to our MX: echo with our Message-ID + origin.
    const echo = await inbound(full, { from: { address: DAVE, name: "dave" }, to: request.to, cc: request.cc, subject: request.subject, rfcMessageId: row.rfcMessageId, originalHeaders: [{ name: "X-CosmicForge-Origin", value: request.headers["X-CosmicForge-Origin"] }] });
    assert.equal(echo.delivered, 0);
    assert.equal(echo.echo, 2);
    assert.equal(await copies(boxes.erin, row.rfcMessageId), 1);
    assert.equal(await copies(boxes.fay, row.rfcMessageId), 1);
    const audits = await client.mailAuditEvent.findMany({ where: { action: "MAIL_INBOUND_PROVIDER_ECHO_DEDUPED", targetId: id } });
    assert.equal(audits.length, 2);
    assert.ok(audits.every((audit) => audit.metadata.via === "origin-header"));
    state.multi = { id, request, row };
  });

  await t.test("reply-all from the external recipient's perspective includes internal people (full-headers only)", async () => {
    const { request } = state.multi;
    // What an external recipient's client would Reply-All to: From + To + Cc.
    const replyAll = new Set([DAVE, ...request.to.map((p) => p.address), ...request.cc.map((p) => p.address)]);
    for (const address of [ERIN, FAY, EXT1, EXT2]) assert.ok(replyAll.has(address), address);
    assert.ok(!replyAll.has(EXT3), "BCC recipient never visible");
  });

  await t.test("reply-all from an internal copy: all visible To/Cc minus own identities, never Bcc", async () => {
    const { row } = state.multi;
    const copy = await client.mailMessage.findFirst({ where: { mailboxId: boxes.erin, rfcMessageId: row.rfcMessageId } });
    const draft = await call("erin", "POST", `/mailboxes/${boxes.erin}/drafts`, { mode: "REPLY_ALL", inReplyToMessageId: copy.id });
    assert.equal(draft.status, 201, draft.text);
    assert.deepEqual(draft.body.data.to.map((p) => p.address), [DAVE]);
    assert.deepEqual(draft.body.data.cc.map((p) => p.address).sort(), [EXT1, EXT2, FAY].sort());
    assert.deepEqual(draft.body.data.bcc, []);
    // Reply-all from the sender's own sent message: To + Cc, never the Bcc.
    const own = await call("dave", "POST", `/mailboxes/${boxes.dave}/drafts`, { mode: "REPLY_ALL", inReplyToMessageId: row.id });
    const everyone = [...own.body.data.to, ...own.body.data.cc].map((p) => p.address);
    assert.ok(!everyone.includes(EXT3) && !everyone.includes(DAVE));
    assert.deepEqual(everyone.sort(), [ERIN, EXT1, EXT2, FAY].sort());
  });

  await t.test("forged origin header (bad HMAC) and other-key header: delivered normally", async () => {
    const id = await send({ to: [EXT1], cc: [ERIN], subject: "Forge target" });
    await dispatch(full);
    const row = await message(id);
    const forged = `${id}.${crypto.randomBytes(32).toString("base64url")}`;
    const otherKey = createOriginHeader({ secret: crypto.randomBytes(32).toString("hex") }).sign(id);
    for (const value of [forged, otherKey]) {
      const result = await inbound(full, { from: { address: DAVE, name: null }, to: [{ address: ERIN, name: null }], subject: "Forged", rfcMessageId: `<${crypto.randomUUID()}@attacker.example>`, originalHeaders: [{ name: "x-cosmicforge-origin", value }] });
      assert.equal(result.delivered, 1, "attacker cannot suppress delivery");
    }
    assert.equal(await copies(boxes.erin, row.rfcMessageId), 1);
    assert.ok((await fullAudit("MAIL_INBOUND_ORIGIN_HEADER_INVALID")) >= 2);
    // A valid header but a different From is not an echo either.
    const valid = createOriginHeader({ secret: ORIGIN_SECRET }).sign(id);
    const spoof = await inbound(full, { from: { address: "mallory@attacker.example", name: null }, to: [{ address: ERIN, name: null }], subject: "Copied header", rfcMessageId: `<${crypto.randomUUID()}@attacker.example>`, originalHeaders: [{ name: "X-CosmicForge-Origin", value: valid }] });
    assert.equal(spoof.delivered, 1);
    state.forge = { id, row };
  });

  await t.test("provider Message-ID alias from webhooks: stored, threads replies, dedups echoes", async () => {
    const { id, row } = state.forge;
    const alias = `<${crypto.randomUUID()}@eu-west-1.amazonses.example>`;
    const sentEvent = await webhook("email.sent", { email_id: row.providerMessageId, to: [EXT1], message_id: alias, created_at: harness.clock().toISOString() });
    assert.equal(sentEvent.status, 200, JSON.stringify(sentEvent.body));
    await events(full);
    const stored = await client.mailMessageProviderId.findUnique({ where: { messageId: id } });
    assert.equal(stored.providerRfcMessageId, alias);
    // A second event with the same id is a duplicate; a later different
    // message_id never overwrites the first alias.
    await webhook("email.delivered", { email_id: row.providerMessageId, to: [EXT1], message_id: `<other-${crypto.randomUUID()}@x.example>` });
    await events(full);
    assert.equal((await client.mailMessageProviderId.findUnique({ where: { messageId: id } })).providerRfcMessageId, alias);
    // Our own Message-ID echoed back is not stored as an alias.
    const ownId = await send({ to: [EXT2], subject: "Own id" });
    await dispatch(full);
    const own = await message(ownId);
    await webhook("email.sent", { email_id: own.providerMessageId, to: [EXT2], message_id: own.rfcMessageId });
    await events(full);
    assert.equal(await client.mailMessageProviderId.count({ where: { messageId: ownId } }), 0);

    // External reply referencing only the provider alias joins dave's thread.
    const reply = await inbound(full, { from: { address: EXT1, name: null }, to: [{ address: DAVE, name: null }], subject: "Re: Forge target", rfcMessageId: `<${crypto.randomUUID()}@partner.example>`, inReplyTo: alias, references: [alias] });
    assert.equal(reply.delivered, 1);
    const replyRow = await client.mailMessage.findFirst({ where: { mailboxId: boxes.dave, direction: "INBOUND", inReplyTo: alias } });
    assert.equal(replyRow.threadId, row.threadId, "threaded via the provider alias");
    // ... and in erin's mailbox it joins her internal copy's thread.
    const erinCopy = await client.mailMessage.findFirst({ where: { mailboxId: boxes.erin, rfcMessageId: row.rfcMessageId } });
    const replyErin = await inbound(full, { from: { address: EXT1, name: null }, to: [{ address: ERIN, name: null }], subject: "Re: Forge target", rfcMessageId: `<${crypto.randomUUID()}@partner.example>`, inReplyTo: alias, references: [alias] });
    assert.equal(replyErin.delivered, 1);
    const erinReply = await client.mailMessage.findFirst({ where: { mailboxId: boxes.erin, direction: "INBOUND", inReplyTo: alias } });
    assert.equal(erinReply.threadId, erinCopy.threadId);

    // Echo whose Message-ID was replaced by the provider and no origin header.
    const echo = await inbound(full, { from: { address: DAVE, name: null }, to: [{ address: EXT1, name: null }], cc: [{ address: ERIN, name: null }], subject: "Forge target", rfcMessageId: alias });
    assert.equal(echo.delivered, 0);
    assert.equal(echo.echo, 1);
    assert.equal(await client.mailMessage.count({ where: { mailboxId: boxes.erin, subject: "Forge target" } }), 1);
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_INBOUND_PROVIDER_ECHO_DEDUPED", targetId: id } });
    assert.equal(audit.metadata.via, "provider-alias");
  });

  await t.test("provider events naming only internal addresses never change status (ops record only)", async () => {
    const id = await send({ to: [EXT1], cc: [ERIN], subject: "Internal events" });
    await dispatch(full);
    const row = await message(id);
    const bounce = await webhook("email.bounced", { email_id: row.providerMessageId, to: [ERIN], bounce: { type: "Permanent", message: "legacy MX rejected" } });
    await webhook("email.delivered", { email_id: row.providerMessageId, to: [ERIN] });
    await events(full);
    const after = await message(id);
    assert.equal(after.recipients.find((r) => r.address === ERIN).status, "INTERNAL_DELIVERED", "never FAILED/BOUNCED/DELIVERED");
    assert.equal(after.recipients.find((r) => r.address === EXT1).status, "PROVIDER_ACCEPTED");
    assert.equal(after.status, "PROVIDER_ACCEPTED");
    assert.equal(await client.marketingSuppression.count({ where: { email: ERIN } }), 0, "no suppression for internal addresses");
    assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: id } }), 0, "nothing shown in the sender's delivery details");
    const ops = await client.mailDeliveryEvent.findMany({ where: { messageId: null, providerMessageId: row.providerMessageId } });
    assert.equal(ops.length, 2);
    assert.ok(ops.every((event) => event.detail.internalRecipient === true && event.detail.outboundMessageId === id));
    // Duplicate webhook delivery (same svix id) and a re-run of the job.
    const again = await webhook("email.bounced", { email_id: row.providerMessageId, to: [ERIN], bounce: { type: "Permanent", message: "legacy MX rejected" } }, { id: bounce.id });
    assert.equal(again.body.duplicate, true);
    const stored = await client.mailWebhookEvent.findFirst({ where: { providerEventId: bounce.id } });
    await full.processors.deliveryEvents.process({ webhookEventId: stored.id });
    assert.equal(await client.mailDeliveryEvent.count({ where: { messageId: null, providerMessageId: row.providerMessageId } }), 2, "idempotent");
    assert.equal(await client.mailAuditEvent.count({ where: { action: "MAIL_DELIVERY_INTERNAL_RECIPIENT_IGNORED", targetId: id } }), 2);
  });

  await t.test("provider partial failure: status derived from external recipients only", async () => {
    const id = await send({ to: [EXT1, EXT2], cc: [ERIN], subject: "Partial" });
    await dispatch(full);
    const row = await message(id);
    await webhook("email.delivered", { email_id: row.providerMessageId, to: [EXT1] });
    await webhook("email.bounced", { email_id: row.providerMessageId, to: [EXT2], bounce: { type: "Permanent", message: "no such user" } });
    // The To-list echo (all To addresses) is not attribution.
    await webhook("email.bounced", { email_id: row.providerMessageId, to: [EXT1, EXT2], bounce: { type: "Transient", message: "echo" } });
    await events(full);
    const after = await message(id);
    const status = Object.fromEntries(after.recipients.map((r) => [r.address, r.status]));
    assert.equal(status[EXT1], "DELIVERED");
    assert.equal(status[EXT2], "BOUNCED");
    assert.equal(status[ERIN], "INTERNAL_DELIVERED");
    assert.equal(after.status, "BOUNCED");
    const shown = await client.mailDeliveryEvent.findMany({ where: { messageId: id } });
    assert.ok(shown.every((event) => !String(event.recipient || "").includes(ERIN)), "internal address never shown as provider-delivered");
    // Message status API (UI) stays truthful.
    const api = await call("dave", "GET", `/messages/${id}/status`);
    if (api.status === 200) {
      const erin = api.body.data.recipients.find((r) => r.address === ERIN);
      assert.equal(erin.status, "INTERNAL_DELIVERED");
    }
  });

  await t.test("single external + internal To: an unattributable bounce (To echo) changes nothing", async () => {
    const id = await send({ to: [ERIN], cc: [EXT1], subject: "Single ext" });
    await dispatch(full);
    const row = await message(id);
    await webhook("email.bounced", { email_id: row.providerMessageId, to: [ERIN], bounce: { type: "Permanent", message: "?" } });
    await events(full);
    const after = await message(id);
    assert.equal(after.recipients.find((r) => r.address === EXT1).status, "PROVIDER_ACCEPTED", "not guessed onto the only external recipient");
    assert.equal(after.recipients.find((r) => r.address === ERIN).status, "INTERNAL_DELIVERED");
    assert.equal(await client.marketingSuppression.count({ where: { email: { in: [EXT1, ERIN] } } }), 0);
  });

  const FRESH = "fresh.recipient@fresh.example";
  await t.test("re-audit 5: a delivered event echoing a To list with internal addresses never marks external To DELIVERED", async () => {
    const id = await send({ to: [ERIN, EXT1], bcc: [FRESH], subject: "Echo delivered" });
    const sent = await dispatch(full);
    assert.equal(sent.length, 2);
    const row = await message(id);
    const main = row.recipients.find((r) => r.address === EXT1).providerMessageId;
    const bccId = row.recipients.find((r) => r.address === FRESH).providerMessageId;
    assert.notEqual(main, bccId, "BCC has its own provider request");
    // Our MX accepting erin's copy produces a delivered event echoing the To list.
    await webhook("email.delivered", { email_id: main, to: [ERIN, EXT1] });
    await webhook("email.delivered", { email_id: bccId, to: [FRESH] });
    await events(full);
    let after = await message(id);
    let status = Object.fromEntries(after.recipients.map((r) => [r.address, r.status]));
    assert.equal(status[EXT1], "PROVIDER_ACCEPTED", "echo with an internal address is not evidence");
    assert.equal(status[FRESH], "DELIVERED", "individual BCC request is attributable");
    assert.equal(status[ERIN], "INTERNAL_DELIVERED");
    // The external address singled out: applied.
    await webhook("email.delivered", { email_id: main, to: [EXT1] });
    await events(full);
    after = await message(id);
    status = Object.fromEntries(after.recipients.map((r) => [r.address, r.status]));
    assert.equal(status[EXT1], "DELIVERED");
    assert.equal(after.status, "DELIVERED");
  });

  await t.test("re-audit 4: org quota and usage count external recipients only in full-headers mode", async () => {
    const orgId = (await client.mailMailbox.findUnique({ where: { id: boxes.dave } })).organizationId;
    const accepted = async () => (await client.mailUsageDaily.aggregate({ where: { organizationId: orgId }, _sum: { accepted: true } }))._sum.accepted || 0;
    const before = await accepted();
    const id = await send({ to: [ERIN, FAY, EXT1], cc: [FRESH], subject: "Usage external only" });
    const sent = await dispatch(full);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to.length + sent[0].cc.length, 4, "provider gets the full visible header set");
    const row = await message(id);
    assert.equal(row.recipients.find((r) => r.address === EXT1).status, "PROVIDER_ACCEPTED");
    assert.equal((await accepted()) - before, 2, "only the two external recipients are counted");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_PROVIDER_ACCEPTED", targetId: id } });
    assert.equal(audit.metadata.recipients, 2);
  });

  await t.test("default mode: an event naming an internal address is also ignored for status", async () => {
    const id = await send({ to: [EXT1, EXT3], cc: [ERIN], subject: "Default internal event" });
    await dispatch(harness.mail);
    const row = await message(id);
    await webhook("email.bounced", { email_id: row.providerMessageId, to: [ERIN], bounce: { type: "Permanent", message: "x" } });
    await events(harness.mail);
    const after = await message(id);
    assert.equal(after.recipients.find((r) => r.address === ERIN).status, "INTERNAL_DELIVERED");
    assert.equal(after.status, "PROVIDER_ACCEPTED");
  });
});

test("GAP 8 before migration 37: no alias table, everything else works", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const env = await setup(t, { preMigration37: true });
  const { client, full, boxes, send, dispatch, events, webhook, inbound, message, copies, addresses } = env;
  assert.equal((await client.$queryRawUnsafe("SELECT to_regclass('public.mail_message_provider_ids')::text AS t"))[0].t, null, "migration 37 not applied");

  const id = await send({ to: [EXT1], cc: [ERIN, FAY], subject: "Pre 37" });
  const [request] = await dispatch(full);
  assert.deepEqual(addresses(request.cc), [ERIN, FAY].sort());
  const row = await message(id);
  // Webhook with a provider message_id: accepted and applied, alias not stored.
  const sent = await webhook("email.sent", { email_id: row.providerMessageId, to: [EXT1], message_id: `<${crypto.randomUUID()}@provider.example>` });
  assert.equal(sent.status, 200);
  await webhook("email.delivered", { email_id: row.providerMessageId, to: [EXT1] });
  await events(full);
  const after = await message(id);
  assert.equal(after.recipients.find((r) => r.address === EXT1).status, "DELIVERED");
  assert.equal(after.status, "DELIVERED");
  const table = await client.$queryRawUnsafe("SELECT to_regclass('public.mail_message_provider_ids')::text AS t");
  assert.equal(table[0].t, null);
  // Echo dedup by origin header needs no migration-37 table.
  const echo = await inbound(full, { from: { address: DAVE, name: null }, to: request.to, cc: request.cc, subject: "Pre 37", rfcMessageId: `<${crypto.randomUUID()}@rewritten.example>`, originalHeaders: [{ name: "X-CosmicForge-Origin", value: request.headers["X-CosmicForge-Origin"] }] });
  assert.equal(echo.delivered, 0);
  assert.equal(await copies(boxes.erin, row.rfcMessageId), 1);
  assert.equal(await copies(boxes.fay, row.rfcMessageId), 1);
  // Threading by our own Message-ID still works; an unknown alias is a new thread.
  const reply = await inbound(full, { from: { address: EXT1, name: null }, to: [{ address: DAVE, name: null }], subject: "Re: Pre 37", rfcMessageId: `<${crypto.randomUUID()}@partner.example>`, inReplyTo: row.rfcMessageId, references: [row.rfcMessageId] });
  assert.equal(reply.delivered, 1);
  const replyRow = await client.mailMessage.findFirst({ where: { mailboxId: boxes.dave, direction: "INBOUND", inReplyTo: row.rfcMessageId } });
  assert.equal(replyRow.threadId, row.threadId);
  const stray = await inbound(full, { from: { address: EXT1, name: null }, to: [{ address: DAVE, name: null }], subject: "Re: Pre 37", rfcMessageId: `<${crypto.randomUUID()}@partner.example>`, inReplyTo: "<unknown-alias@provider.example>", references: [] });
  assert.equal(stray.delivered, 1);
});

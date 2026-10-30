"use strict";

// Final gap 6: IT quarantine management on real PostgreSQL (migrations 1-37,
// offline fake provider, signature scanner): permission matrix, safe metadata
// only (no subjects, bodies, full sender addresses or downloads), infected
// mail never releasable, clean scan evidence required, MFA step-up + reason
// for release/reject/delete, release returns mail only to the original
// mailbox members, append-only decisions, reject/delete through the durable
// deletion queue, legal holds, and the pre-37 read-only behaviour.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { EICAR } = require("../src/modules/mail/scanning/attachment-scanner");

const ROLLBACK = path.join(__dirname, "..", "..", "..", "docs", "sql", "cosmicforge-mail-final-gap-closure-rollback.sql");
const SECRET_SUBJECTS = ["Invoice overdue", "Board pack from the CEO", "Payroll change", "Cheap pills"];
const SECRET_BODY = "confidential-body-text";

async function addAdmin(client, harness, ids, key, tier) {
  const id = crypto.randomUUID();
  await client.adminUser.create({ data: { id, email: `${key}@staff.example.invalid`, password: "test-only-hash", name: key, tier, status: "ACTIVE", mustChangePassword: false } });
  const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(harness.clock().getTime() + 86400000), absoluteExpiresAt: new Date(harness.clock().getTime() + 86400000) } });
  ids[key] = id;
  harness.state.sessions.set(id, session.id);
}

async function setup(t, { rollback = false } = {}) {
  const db = await openDatabase();
  const { client } = db;
  if (rollback) await client.$executeRawUnsafe(fs.readFileSync(ROLLBACK, "utf8"));
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  await addAdmin(client, harness, ids, "plainAdmin", "ADMIN");
  // fay: mail admin VIEW only.
  await client.adminSectionGrant.create({ data: { adminUserId: ids.fay, module: "mail", section: "admin", mode: "VIEW", grantedBy: ids.super } });
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  t.after(async () => {
    await closeServer(server);
    await db.close();
  });
  const cf = brands.cosmicforge;
  const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  let counter = 0;
  const receive = async ({ from, subject, spam = null, attachments = [] }) => {
    counter += 1;
    const id = `q_${counter}_${crypto.randomUUID().slice(0, 8)}`;
    harness.adapter.addInbound(id, { from: { address: from, name: "Sender" }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject, html: null, text: SECRET_BODY, rfcMessageId: `<${id}@mail.example>`, inReplyTo: null, references: [], receivedAt: harness.clock(), spamVerdict: spam, attachmentCount: attachments.length }, attachments);
    const result = await harness.mail.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: id, to: ["dave@cosmicforge.example"] }, webhookEventId: null });
    assert.equal(result.delivered, 1);
    return client.mailMessage.findFirst({ where: { rfcMessageId: `<${id}@mail.example>` }, include: { attachments: true } });
  };
  const stepUp = async (purpose, key = "ops") => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  return { db, client, harness, ids, brands, cf, call, daveBox: box.body.data.id, receive, stepUp };
}

test("IT quarantine management on real PostgreSQL (migration 37)", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const env = await setup(t);
  const { client, harness, ids, cf, call, daveBox, receive, stepUp } = env;
  const exists = async (key) => harness.backend.read(key).then(() => true, () => false);
  const s = {};

  await t.test("setup: infected, spoofed, unscanned, spam and policy-blocked items", async () => {
    s.infected = await receive({ from: "billing@partner.example", subject: SECRET_SUBJECTS[0], attachments: [{ filename: "invoice.txt", contentType: "text/plain", content: Buffer.from(EICAR) }] });
    assert.equal(s.infected.status, "QUARANTINED");
    assert.equal(s.infected.quarantineReason, "MALICIOUS_ATTACHMENT");
    s.spoof = await receive({ from: "ceo@cosmicforge.example", subject: SECRET_SUBJECTS[1], attachments: [{ filename: "pack.txt", contentType: "text/plain", content: Buffer.from("board pack") }] });
    assert.equal(s.spoof.quarantineReason, "INTERNAL_DOMAIN_SPOOF");
    assert.equal(s.spoof.attachments[0].scanStatus, "CLEAN");
    s.unscanned = await receive({ from: "hr@cosmicforge.example", subject: SECRET_SUBJECTS[2], attachments: [{ filename: "payroll.txt", contentType: "text/plain", content: Buffer.from("payroll numbers") }] });
    // Simulate a scanner outage at delivery time.
    await client.mailAttachment.update({ where: { id: s.unscanned.attachments[0].id }, data: { scanStatus: "SCANNER_UNAVAILABLE", scanDetail: "SCANNER_DOWN", quarantined: true } });
    s.spam = await receive({ from: "pills@spam.example", subject: SECRET_SUBJECTS[3], spam: "spam" });
    assert.equal(s.spam.quarantineReason, "PROVIDER_SPAM_VERDICT");
    // Outbound draft with a blocked file type.
    const dave = await client.adminUser.findUnique({ where: { id: ids.dave } });
    const draft = await harness.mail.services.compose.createDraft(dave, daveBox, { to: ["partner@partner.example"], subject: "Tools", text: "x" });
    s.blocked = await harness.mail.services.compose.addAttachment(dave, draft.id, { buffer: Buffer.from("MZ binary"), originalname: "tool.exe", mimetype: "application/octet-stream" });
    const blockedRow = await client.mailAttachment.findUnique({ where: { id: s.blocked.id } });
    assert.equal(blockedRow.scanStatus, "SCAN_FAILED");
    assert.match(blockedRow.scanDetail, /^POLICY_/);
  });

  await t.test("permission matrix: explicit mail-admin grant required; VIEW cannot act", async () => {
    for (const key of ["dave", "plainAdmin", "super"]) {
      const response = await call(key, "GET", "/admin/quarantine");
      assert.equal(response.status, 403, `${key}: ${response.text}`);
      assert.equal((await call(key, "GET", `/admin/quarantine/messages/${s.spoof.id}`)).status, 403);
      assert.equal((await call(key, "POST", `/admin/quarantine/attachments/${s.unscanned.attachments[0].id}/rescan`, {})).status, 403);
    }
    const viewer = await call("fay", "GET", "/admin/quarantine");
    assert.equal(viewer.status, 200, viewer.text);
    assert.equal((await call("fay", "GET", `/admin/quarantine/messages/${s.spoof.id}`)).status, 200);
    for (const [url, body] of [
      [`/admin/quarantine/messages/${s.spoof.id}/release`, { reason: "Verified with sender", stepUpId: crypto.randomUUID() }],
      [`/admin/quarantine/messages/${s.spam.id}/reject`, { reason: "Spam confirmed", stepUpId: crypto.randomUUID() }],
      [`/admin/quarantine/attachments/${s.unscanned.attachments[0].id}/rescan`, {}],
      [`/admin/quarantine/attachments/${s.blocked.id}/delete`, { reason: "Remove the tool", stepUpId: crypto.randomUUID() }],
    ]) {
      const response = await call("fay", "POST", url, body);
      assert.equal(response.status, 403, `VIEW cannot act: ${url} ${response.text}`);
    }
    assert.equal(await client.mailQuarantineDecision.count(), 0);
  });

  await t.test("listing: categories, filters, pagination; safe metadata only", async () => {
    const list = async (query) => {
      const response = await call("ops", "GET", `/admin/quarantine?${new URLSearchParams(query)}`);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response;
    };
    const all = await list({});
    assert.deepEqual(all.body.data.map((item) => item.id).sort(), [s.infected.id, s.spoof.id, s.unscanned.id, s.spam.id].sort());
    const byId = new Map(all.body.data.map((item) => [item.id, item]));
    assert.equal(byId.get(s.infected.id).reasonCategory, "MALWARE");
    assert.equal(byId.get(s.spoof.id).reasonCategory, "AUTH_POLICY");
    assert.equal(byId.get(s.spam.id).reasonCategory, "SPAM");
    const spoof = byId.get(s.spoof.id);
    assert.deepEqual(spoof.sender.domain, "cosmicforge.example");
    assert.equal(spoof.sender.masked, "c***@cosmicforge.example");
    assert.equal(spoof.mailbox.id, daveBox);
    assert.equal(spoof.organization.id, cf.organization.id);
    assert.equal(spoof.attachments[0].filename, "pack.txt");
    assert.equal(spoof.actions.canRelease, true);
    assert.deepEqual(byId.get(s.infected.id).actions.releaseBlockers.includes("MALWARE_NEVER_RELEASABLE"), true);
    assert.deepEqual(byId.get(s.unscanned.id).actions.releaseBlockers, ["ATTACHMENT_NOT_CLEAN"]);

    assert.deepEqual((await list({ category: "MALWARE" })).body.data.map((item) => item.id), [s.infected.id]);
    assert.deepEqual((await list({ category: "AUTH_POLICY" })).body.data.map((item) => item.id).sort(), [s.spoof.id, s.unscanned.id].sort());
    assert.deepEqual((await list({ category: "SPAM" })).body.data.map((item) => item.id), [s.spam.id]);
    assert.deepEqual((await list({ organizationId: env.brands.karryam.organization.id })).body.data, []);
    assert.equal((await list({ mailboxId: daveBox })).body.data.length, 4);
    assert.deepEqual((await list({ to: new Date(harness.clock().getTime() - 86400000).toISOString() })).body.data, []);
    assert.equal((await call("ops", "GET", "/admin/quarantine?category=BOGUS")).status, 400);

    const first = await list({ limit: "2" });
    assert.equal(first.body.data.length, 2);
    assert.ok(first.body.meta.nextCursor);
    const second = await list({ limit: "2", cursor: first.body.meta.nextCursor });
    assert.equal(second.body.data.length, 2);
    assert.equal(new Set([...first.body.data, ...second.body.data].map((item) => item.id)).size, 4);

    const attachments = await list({ kind: "attachments" });
    const attachmentIds = attachments.body.data.map((item) => item.id).sort();
    assert.deepEqual(attachmentIds, [s.infected.attachments[0].id, s.unscanned.attachments[0].id, s.blocked.id].sort());
    assert.deepEqual((await list({ kind: "attachments", source: "OUTBOUND" })).body.data.map((item) => item.id), [s.blocked.id]);
    assert.deepEqual((await list({ kind: "attachments", category: "POLICY" })).body.data.map((item) => item.id), [s.blocked.id]);
    assert.deepEqual((await list({ kind: "attachments", category: "SCAN_FAILURE" })).body.data.map((item) => item.id), [s.unscanned.attachments[0].id]);
    assert.deepEqual((await list({ kind: "attachments", category: "MALWARE" })).body.data.map((item) => item.id), [s.infected.attachments[0].id]);
    const blocked = attachments.body.data.find((item) => item.id === s.blocked.id);
    assert.equal(blocked.source, "OUTBOUND_DRAFT");
    // Re-audit 7c: private draft files show extension + size only.
    assert.equal(blocked.filename, "*.exe");
    assert.equal(blocked.filenameMasked, true);
    assert.equal(typeof blocked.sizeBytes, "number");
    assert.ok(!attachments.text.includes("tool.exe"), "draft filename never shown");
    const blockedDetail = await call("ops", "GET", `/admin/quarantine/attachments/${s.blocked.id}`);
    assert.equal(blockedDetail.body.data.filename, "*.exe");
    assert.equal(attachments.body.data.find((item) => item.id === s.infected.attachments[0].id).filename, "invoice.txt", "inbound filenames stay visible");
    assert.deepEqual(blocked.actions.releaseBlockers, ["POLICY_BLOCKED"]);

    // No content anywhere: subjects, bodies, full sender addresses, keys or download links.
    for (const response of [all, attachments, await call("ops", "GET", `/admin/quarantine/messages/${s.spoof.id}`), await call("ops", "GET", `/admin/quarantine/attachments/${s.infected.attachments[0].id}`)]) {
      for (const secret of [...SECRET_SUBJECTS, SECRET_BODY, "ceo@cosmicforge.example", "billing@partner.example", "pills@spam.example", s.spoof.contentObjectKey, s.infected.attachments[0].storageKey]) {
        assert.ok(!response.text.includes(secret), `response leaks ${secret}`);
      }
      assert.doesNotMatch(response.text, /"(subject|snippet|html|text|downloadUrl|storageKey|contentObjectKey)"/);
    }
    // A message that was never quarantined is not reachable here.
    const normal = await client.mailMessage.create({ data: { mailboxId: daveBox, threadId: s.spam.threadId, direction: "INBOUND", status: "RECEIVED", rfcMessageId: `<${crypto.randomUUID()}@ok.example>`, fromAddress: "ok@ok.example" } });
    assert.equal((await call("ops", "GET", `/admin/quarantine/messages/${normal.id}`)).status, 404);
    await client.mailMessage.update({ where: { id: normal.id }, data: { deletedAt: harness.clock() } });
  });

  await t.test("infected mail is never releasable (message or attachment), with or without step-up", async () => {
    const release = await call("ops", "POST", `/admin/quarantine/messages/${s.infected.id}/release`, { reason: "Looks fine to me", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(release.status, 409, release.text);
    assert.equal(release.body.errors?.[0]?.reason ?? release.body.reason ?? JSON.parse(release.text).errors?.[0]?.reason, "MALWARE_NEVER_RELEASABLE");
    const attachment = await call("ops", "POST", `/admin/quarantine/attachments/${s.infected.attachments[0].id}/release`, { reason: "Looks fine to me", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(attachment.status, 409, attachment.text);
    assert.match(attachment.text, /INFECTED_NEVER_RELEASABLE/);
    const rescan = await call("ops", "POST", `/admin/quarantine/attachments/${s.infected.attachments[0].id}/rescan`, {});
    assert.equal(rescan.status, 403, "INFECTED is not rescannable");
    const row = await client.mailMessage.findUnique({ where: { id: s.infected.id }, include: { attachments: true } });
    assert.equal(row.status, "QUARANTINED");
    assert.equal(row.attachments[0].quarantined, true);
    assert.equal(await client.mailQuarantineDecision.count(), 0);
    assert.ok(await client.mailAuditEvent.findFirst({ where: { action: "MAIL_QUARANTINE_RELEASE_REFUSED", targetId: s.infected.id, outcome: "DENIED" } }));
  });

  await t.test("release requires clean scan evidence: rescan records the decision; policy blocks are refused", async () => {
    const refused = await call("ops", "POST", `/admin/quarantine/messages/${s.unscanned.id}/release`, { reason: "Verified by phone", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, /ATTACHMENT_NOT_CLEAN/);
    const rescan = await call("ops", "POST", `/admin/quarantine/attachments/${s.unscanned.attachments[0].id}/rescan`, { reason: "Scanner is back up" });
    assert.equal(rescan.status, 200, rescan.text);
    assert.equal(rescan.body.data.scanStatus, "CLEAN");
    const decision = await client.mailQuarantineDecision.findFirst({ where: { attachmentId: s.unscanned.attachments[0].id } });
    assert.equal(decision.decision, "RESCAN_REQUESTED");
    assert.equal(decision.scanEvidence.from, "SCANNER_UNAVAILABLE");
    assert.equal(decision.scanEvidence.to, "CLEAN");
    assert.equal(decision.decidedBy, ids.ops);
    // Re-audit fix 3: a clean rescan records the verdict but never releases.
    const rescanned = await client.mailAttachment.findUnique({ where: { id: s.unscanned.attachments[0].id } });
    assert.equal(rescanned.quarantined, true, "rescan never releases");
    assert.equal((await call("dave", "GET", `/attachments/${rescanned.id}/download`)).status, 403);
    const detail = await call("ops", "GET", `/admin/quarantine/messages/${s.unscanned.id}`);
    assert.equal(detail.body.data.actions.canRelease, true);
    assert.deepEqual(detail.body.data.decisions.map((row) => row.decision), ["RESCAN_REQUESTED"]);

    const policy = await call("ops", "POST", `/admin/quarantine/attachments/${s.blocked.id}/release`, { reason: "I need this tool", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(policy.status, 409, policy.text);
    assert.match(policy.text, /POLICY_BLOCKED/);
    assert.equal((await client.mailAttachment.findUnique({ where: { id: s.blocked.id } })).quarantined, true);
  });

  await t.test("re-audit 3: rescan (IT quarantine or legacy admin endpoint) never releases; release needs step-up + RELEASED decision", async () => {
    const received = await receive({ from: "friend@partner.example", subject: "Two files", attachments: [{ filename: "one.txt", contentType: "text/plain", content: Buffer.from("first clean file") }, { filename: "two.txt", contentType: "text/plain", content: Buffer.from("second clean file") }] });
    await client.mailMessage.update({ where: { id: received.id }, data: { status: "RECEIVED", quarantineReason: null } });
    const [one, two] = received.attachments;
    await client.mailAttachment.updateMany({ where: { id: { in: [one.id, two.id] } }, data: { scanStatus: "SCANNER_UNAVAILABLE", scanDetail: "SCANNER_DOWN", quarantined: true } });

    const viaQuarantine = await call("ops", "POST", `/admin/quarantine/attachments/${one.id}/rescan`, { reason: "Scanner restored" });
    assert.equal(viaQuarantine.status, 200, viaQuarantine.text);
    assert.equal(viaQuarantine.body.data.scanStatus, "CLEAN");
    assert.equal(viaQuarantine.body.data.quarantined, true);
    assert.equal(viaQuarantine.body.data.actions.canRelease, true);
    const legacy = await call("ops", "POST", `/admin/attachments/${two.id}/rescan`);
    assert.equal(legacy.status, 200, legacy.text);
    assert.deepEqual({ scanStatus: legacy.body.data.scanStatus, quarantined: legacy.body.data.quarantined, downloadable: legacy.body.data.downloadable, releaseRequired: legacy.body.data.releaseRequired }, { scanStatus: "CLEAN", quarantined: true, downloadable: false, releaseRequired: true });
    for (const id of [one.id, two.id]) {
      assert.equal((await client.mailAttachment.findUnique({ where: { id } })).quarantined, true);
      assert.equal((await call("dave", "GET", `/attachments/${id}/download`)).status, 403, "still not downloadable");
    }
    assert.equal(await client.mailQuarantineDecision.count({ where: { attachmentId: { in: [one.id, two.id] }, decision: "RELEASED" } }), 0);

    const noStepUp = await call("ops", "POST", `/admin/quarantine/attachments/${two.id}/release`, { reason: "Clean after rescan" });
    assert.equal(noStepUp.status, 403);
    const released = await call("ops", "POST", `/admin/quarantine/attachments/${two.id}/release`, { reason: "Clean after rescan", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(released.status, 200, released.text);
    assert.equal((await client.mailAttachment.findUnique({ where: { id: two.id } })).quarantined, false);
    assert.equal((await call("dave", "GET", `/attachments/${two.id}/download`)).status, 200);
    assert.ok(await client.mailQuarantineDecision.findFirst({ where: { attachmentId: two.id, decision: "RELEASED", decidedBy: ids.ops } }));
    // Clean up: the other file is released too so later listings stay exact.
    assert.equal((await call("ops", "POST", `/admin/quarantine/attachments/${one.id}/release`, { reason: "Clean after rescan", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") })).status, 200);
  });

  await t.test("AUTH_POLICY release needs EDIT, a reason and a purpose-bound MFA step-up", async () => {
    const url = `/admin/quarantine/messages/${s.spoof.id}/release`;
    const noStepUp = await call("ops", "POST", url, { reason: "Verified with the CEO" });
    assert.equal(noStepUp.status, 403);
    assert.match(noStepUp.text, /MAIL_STEP_UP_REQUIRED/);
    assert.equal((await call("ops", "POST", url, { reason: "Verified with the CEO", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") })).status, 403, "purpose-bound");
    assert.equal((await call("ops", "POST", url, { reason: "", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") })).status, 400, "reason required");
    assert.equal((await call("mailAdmin", "POST", url, { reason: "Verified with the CEO" })).status, 403, "no MFA, no release");
    assert.equal((await client.mailMessage.findUnique({ where: { id: s.spoof.id } })).status, "QUARANTINED");

    const released = await call("ops", "POST", url, { reason: "Verified with the CEO", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(released.status, 200, released.text);
    assert.equal(released.body.data.status, "RECEIVED");
    const message = await client.mailMessage.findUnique({ where: { id: s.spoof.id }, include: { attachments: true, thread: true } });
    assert.equal(message.status, "RECEIVED");
    assert.equal(message.thread.folder, "INBOX");
    assert.equal(message.mailboxId, daveBox, "stays in the original mailbox");
    const decision = await client.mailQuarantineDecision.findFirst({ where: { messageId: s.spoof.id, decision: "RELEASED" } });
    assert.equal(decision.reason, "Verified with the CEO");
    assert.equal(decision.scanEvidence.category, "AUTH_POLICY");
    const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_QUARANTINE_MESSAGE_RELEASED", targetId: s.spoof.id } });
    assert.equal(audit.actorAdminUserId, ids.ops);
    assert.doesNotMatch(JSON.stringify(audit), /Board pack|ceo@cosmicforge/);
    const again = await call("ops", "POST", url, { reason: "Verified with the CEO", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(again.status, 409, "already released");
  });

  await t.test("a released message reaches the mailbox members only; the admin gains no access", async () => {
    const memberships = await client.mailMembership.count({ where: { adminUserId: ids.ops } });
    assert.equal(memberships, 0);
    const owner = await call("dave", "GET", `/threads/${s.spoof.threadId}/messages`);
    assert.equal(owner.status, 200, owner.text);
    assert.ok(owner.body.data.some((message) => message.id === s.spoof.id));
    for (const key of ["ops", "super", "fay"]) {
      const response = await call(key, "GET", `/threads/${s.spoof.threadId}/messages`);
      assert.ok([403, 404].includes(response.status), `${key} must not read the mailbox: ${response.status}`);
    }
    assert.ok(await client.notification.findFirst({ where: { adminUserId: ids.dave, title: { startsWith: "Released email" } } }));
    assert.equal(await client.notification.count({ where: { adminUserId: ids.ops, title: { startsWith: "Released email" } } }), 0);
  });

  await t.test("decisions are append-only (UPDATE and DELETE refused by trigger)", async () => {
    await assert.rejects(client.$executeRawUnsafe("UPDATE mail_quarantine_decisions SET reason = 'changed'"), /immutable/);
    await assert.rejects(client.$executeRawUnsafe("DELETE FROM mail_quarantine_decisions"), /retention purge/);
    assert.ok((await client.mailQuarantineDecision.count()) >= 2);
  });

  await t.test("legal hold blocks reject/delete; nothing changes", async () => {
    const hold = await call("ops", "POST", "/admin/legal-holds", { organizationId: cf.organization.id, mailboxId: daveBox, reason: "Hold for quarantine test" });
    assert.equal(hold.status, 201, hold.text);
    const refused = await call("ops", "POST", `/admin/quarantine/messages/${s.spam.id}/reject`, { reason: "Spam confirmed", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, /MAIL_LEGAL_HOLD|LEGAL_HOLD/);
    const attachment = await call("ops", "POST", `/admin/quarantine/attachments/${s.infected.attachments[0].id}/delete`, { reason: "Malware removal", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(attachment.status, 409, attachment.text);
    const message = await client.mailMessage.findUnique({ where: { id: s.spam.id } });
    assert.equal(message.deletedAt, null);
    assert.ok(await exists(message.contentObjectKey));
    assert.equal(await client.mailQuarantineDecision.count({ where: { decision: { in: ["REJECTED", "DELETED"] } } }), 0);
    assert.equal((await call("ops", "POST", `/admin/legal-holds/${hold.body.data.id}/release`)).status, 200);
  });

  await t.test("reject/delete tombstone the item and remove objects through the durable deletion queue", async () => {
    const spamKey = s.spam.contentObjectKey;
    await client.mailMessageProviderId.create({ data: { messageId: s.spam.id, providerRfcMessageId: `<prov-${crypto.randomUUID()}@resend.example>` } });
    const rejected = await call("ops", "POST", `/admin/quarantine/messages/${s.spam.id}/reject`, { reason: "Spam confirmed", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(rejected.body.data.decision, "REJECTED");
    const message = await client.mailMessage.findUnique({ where: { id: s.spam.id } });
    assert.ok(message.deletedAt);
    assert.equal(message.contentObjectKey, null);
    assert.equal(message.subject, "");
    assert.equal(message.fromAddress, "");
    assert.equal(await client.mailMessageProviderId.count({ where: { messageId: s.spam.id } }), 0, "provider Message-ID alias removed with the content");
    const queued = await client.mailStorageDeletion.findFirst({ where: { objectKey: spamKey } });
    assert.equal(queued.reason, "QUARANTINE_REJECTED");
    assert.equal(queued.sourceId, s.spam.id);
    assert.equal(queued.status, "DONE");
    assert.equal(await exists(spamKey), false);

    // Attachment delete first, then the infected message itself.
    const attachmentKey = s.infected.attachments[0].storageKey;
    const deleted = await call("ops", "POST", `/admin/quarantine/attachments/${s.infected.attachments[0].id}/delete`, { reason: "Malware removal", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.body.data.decision, "DELETED");
    const attachmentRow = await client.mailAttachment.findUnique({ where: { id: s.infected.attachments[0].id } });
    assert.equal(attachmentRow.storageKey, null, "tombstone without its object");
    assert.equal(await exists(attachmentKey), false);
    assert.equal((await client.mailStorageDeletion.findFirst({ where: { objectKey: attachmentKey } })).reason, "QUARANTINE_DELETED");
    const infectedBody = s.infected.contentObjectKey;
    const gone = await call("ops", "POST", `/admin/quarantine/messages/${s.infected.id}/delete`, { reason: "Malware removal", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(await exists(infectedBody), false);
    // The attachment row carrying a decision survives as a tombstone (FK RESTRICT).
    assert.equal(await client.mailAttachment.count({ where: { id: s.infected.attachments[0].id } }), 1);
    // The rescanned (now clean) message can be released.
    const releasedAfterRescan = await call("ops", "POST", `/admin/quarantine/messages/${s.unscanned.id}/release`, { reason: "Clean after rescan", stepUpId: await stepUp("MAIL_QUARANTINE_RELEASE") });
    assert.equal(releasedAfterRescan.status, 200, releasedAfterRescan.text);
    const list = await call("ops", "GET", "/admin/quarantine");
    assert.deepEqual(list.body.data.map((item) => item.id), [], "nothing left in quarantine");
    const history = await call("ops", "GET", `/admin/quarantine/messages/${s.infected.id}`);
    assert.equal(history.status, 200, "history stays reachable");
    assert.deepEqual(history.body.data.decisions.map((row) => row.decision).sort(), ["DELETED", "DELETED"]);
    // Draft attachment delete (outbound).
    const draftDelete = await call("ops", "POST", `/admin/quarantine/attachments/${s.blocked.id}/reject`, { reason: "Executables are not allowed", stepUpId: await stepUp("MAIL_QUARANTINE_DELETE") });
    assert.equal(draftDelete.status, 200, draftDelete.text);
    for (const action of ["MAIL_QUARANTINE_MESSAGE_REJECTED", "MAIL_QUARANTINE_ATTACHMENT_DELETED", "MAIL_QUARANTINE_MESSAGE_DELETED", "MAIL_QUARANTINE_ATTACHMENT_REJECTED"]) {
      assert.ok(await client.mailAuditEvent.findFirst({ where: { action, actorAdminUserId: ids.ops } }), action);
    }
  });
});

test("IT quarantine before migration 37: list and detail read-only, actions 503", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const env = await setup(t, { rollback: true });
  const { call, receive } = env;
  const spoof = await receive({ from: "ceo@cosmicforge.example", subject: "Pre-37 spoof" });
  assert.equal(spoof.status, "QUARANTINED");
  const list = await call("ops", "GET", "/admin/quarantine");
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.data.map((item) => item.id), [spoof.id]);
  assert.equal(list.body.data[0].actions.available, false);
  assert.equal(list.body.data[0].actions.canRelease, false);
  const detail = await call("ops", "GET", `/admin/quarantine/messages/${spoof.id}`);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(detail.body.data.decisions, []);
  assert.equal((await call("dave", "GET", "/admin/quarantine")).status, 403);
  for (const url of [`/admin/quarantine/messages/${spoof.id}/release`, `/admin/quarantine/messages/${spoof.id}/reject`, `/admin/quarantine/messages/${spoof.id}/delete`, `/admin/quarantine/attachments/${crypto.randomUUID()}/rescan`, `/admin/quarantine/attachments/${crypto.randomUUID()}/release`]) {
    const response = await call("ops", "POST", url, { reason: "Verified with the CEO", stepUpId: crypto.randomUUID() });
    assert.equal(response.status, 503, `${url}: ${response.text}`);
    assert.equal(response.body.code, "MAIL_FEATURE_NOT_READY");
    assert.equal(response.body.retryable, true);
  }
});

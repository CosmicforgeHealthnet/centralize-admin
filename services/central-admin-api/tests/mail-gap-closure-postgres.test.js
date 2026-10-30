"use strict";

// CosmicForge Mail specification gap closure on real PostgreSQL (replayed
// migrations 1-35, offline fake provider, in-memory encrypted storage):
// filters, keyed body search + privacy, sender authentication policy,
// CC/BCC routing, header/raw-MIME archive, controlled forwarding, inbound
// reconciliation of failed jobs + requeue, campaign reply attribution,
// cross-replica rate limits and rollout consistency, operational alerts.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDatabase, seed, createHarness, listen, caller, totp } = require("./helpers/mail-test-harness");
const { EICAR } = require("../src/modules/mail/scanning/attachment-scanner");
const { closeServer } = require("./helpers/server-close");

const SEARCH_KEY = `s1:${crypto.randomBytes(32).toString("base64")}`;

test("CosmicForge Mail gap closure on real PostgreSQL", { timeout: 300000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client, {
    env: {
      MAIL_BODY_SEARCH_ENABLED: "true",
      MAIL_SEARCH_INDEX_KEYS: SEARCH_KEY,
      MAIL_ARCHIVE_RAW_MIME: "true",
      MAIL_FORWARDING_EXTERNAL_ALLOWED_DOMAINS: "partner.example",
      MAIL_UNKNOWN_RECIPIENT_POLICY: "reject",
    },
  });
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const cf = brands.cosmicforge;
  const { server, base } = await listen(harness.mountApp(harness.mail));
  const call = caller(base, ids);
  const stepUp = async (key, purpose) => {
    harness.advance(31000);
    const response = await call(key, "POST", "/security/step-up", { code: totp(harness.clock), purpose });
    assert.equal(response.status, 201, response.text);
    return response.body.data.stepUpId;
  };
  const mailboxFor = async (key, localPart) => {
    const box = await call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids[key], address: { domainId: cf.domain.id, localPart } });
    assert.equal(box.status, 201, box.text);
    return box.body.data.id;
  };
  let inboundCounter = 0;
  // Delivers one inbound email through the real pipeline (fake provider).
  const receive = async (message, { attachments = [], to = null, app = harness.mail } = {}) => {
    inboundCounter += 1;
    const id = `in_gap_${inboundCounter}_${crypto.randomUUID().slice(0, 8)}`;
    harness.adapter.addInbound(id, {
      from: { address: "partner@partner.example", name: "Partner" },
      to: [{ address: "dave@cosmicforge.example", name: null }],
      cc: [],
      envelopeRecipients: [],
      subject: "Hello",
      html: null,
      text: "hello",
      rfcMessageId: `<${id}@partner.example>`,
      inReplyTo: null,
      references: [],
      receivedAt: harness.clock(),
      ...message,
    }, attachments);
    const result = await app.processors.inbound.process({ id: crypto.randomUUID(), payload: { providerEmailId: id, to: to || (message.to || [{ address: "dave@cosmicforge.example" }]).map((party) => party.address) }, webhookEventId: null });
    return { id, result };
  };
  const copyIn = (mailboxId, providerEmailId) => client.mailMessage.findFirst({ where: { mailboxId, providerMessageId: providerEmailId }, include: { thread: true, recipients: true } });
  const state = {};

  try {
    await t.test("setup: personal mailboxes", async () => {
      state.daveBox = await mailboxFor("dave", "dave");
      state.erinBox = await mailboxFor("erin", "erin");
    });

    await t.test("filters: CRUD scoped to the owner, safe validation, inbound application, priority, stop and disabled rules", async () => {
      const label = await call("dave", "POST", `/mailboxes/${state.daveBox}/labels`, { name: "Invoices" });
      assert.equal(label.status, 201, label.text);
      state.labelId = label.body.data.id;
      const erinLabel = await call("erin", "POST", `/mailboxes/${state.erinBox}/labels`, { name: "Erin only" });

      // Validation: no unknown operators, no executable input, labels of this mailbox only.
      for (const bad of [
        { name: "x", conditions: { fromRegex: ".*" }, actions: { markRead: true } },
        { name: "x", conditions: { subjectContains: "a" }, actions: { script: "process.exit()" } },
        { name: "x", conditions: { subjectContains: { $where: "1" } }, actions: { markRead: true } },
        { name: "x", conditions: {}, actions: { markRead: true } },
        { name: "x", conditions: { subjectContains: "a" }, actions: { stopProcessing: true } },
        { name: "x", conditions: { subjectContains: "a" }, actions: { folder: "INBOX" } },
        { name: "x", conditions: { subjectContains: "a" }, actions: { labelId: erinLabel.body.data.id } },
        { name: "x", conditions: { subjectContains: "a".repeat(201) }, actions: { markRead: true } },
        { name: "x", conditions: { subjectContains: "a" }, actions: { markRead: true }, priority: 0 },
      ]) {
        const response = await call("dave", "POST", `/mailboxes/${state.daveBox}/rules`, bad);
        assert.equal(response.status, 400, `${JSON.stringify(bad)} -> ${response.text}`);
      }

      const invoice = await call("dave", "POST", `/mailboxes/${state.daveBox}/rules`, { name: "Invoices", priority: 20, conditions: { subjectContains: "Invoice", fromContains: "partner.example" }, actions: { labelId: state.labelId, folder: "ARCHIVE", markRead: true } });
      assert.equal(invoice.status, 201, invoice.text);
      state.invoiceRule = invoice.body.data.id;
      // Higher priority (lower number) rule that stops processing.
      const urgent = await call("dave", "POST", `/mailboxes/${state.daveBox}/rules`, { name: "Urgent invoices stay", priority: 10, conditions: { subjectContains: "URGENT" }, actions: { star: true, stopProcessing: true } });
      assert.equal(urgent.status, 201, urgent.text);
      state.urgentRule = urgent.body.data.id;
      const disabled = await call("dave", "POST", `/mailboxes/${state.daveBox}/rules`, { name: "Disabled trash", enabled: false, priority: 5, conditions: { subjectContains: "Invoice" }, actions: { folder: "TRASH" } });
      assert.equal(disabled.status, 201);

      // Privacy: another employee cannot list, edit, reorder or delete them.
      assert.equal((await call("erin", "GET", `/mailboxes/${state.daveBox}/rules`)).status, 404);
      assert.equal((await call("erin", "PATCH", `/rules/${state.invoiceRule}`, { enabled: false })).status, 404);
      assert.equal((await call("erin", "DELETE", `/rules/${state.invoiceRule}`)).status, 404);
      assert.equal((await call("erin", "POST", `/mailboxes/${state.erinBox}/rules/reorder`, { ruleIds: [state.invoiceRule] })).status, 400, "foreign rule id rejected");
      assert.equal((await call("super", "GET", `/mailboxes/${state.daveBox}/rules`)).status, 404, "SUPER has no implicit access");
      const listed = await call("dave", "GET", `/mailboxes/${state.daveBox}/rules`);
      assert.deepEqual(listed.body.data.map((rule) => rule.name), ["Disabled trash", "Urgent invoices stay", "Invoices"]);

      // Inbound application.
      const plain = await receive({ subject: "Invoice 42" });
      const archived = await copyIn(state.daveBox, plain.id);
      assert.equal(archived.thread.folder, "ARCHIVE", "disabled TRASH rule ignored; invoice rule archived it");
      assert.equal(await client.mailThreadLabel.count({ where: { threadId: archived.threadId, labelId: state.labelId } }), 1);
      assert.equal((await client.mailUserThreadState.findFirst({ where: { threadId: archived.threadId, adminUserId: ids.dave } })).isRead, true);
      const urgentMail = await receive({ subject: "URGENT Invoice 43" });
      const stayed = await copyIn(state.daveBox, urgentMail.id);
      assert.equal(stayed.thread.folder, "INBOX", "stopProcessing prevented the lower-priority rule");
      assert.equal((await client.mailUserThreadState.findFirst({ where: { threadId: stayed.threadId, adminUserId: ids.dave } })).isStarred, true);

      // Edit, disable, reorder, delete.
      assert.equal((await call("dave", "PATCH", `/rules/${state.urgentRule}`, { enabled: false })).body.data.enabled, false);
      const again = await receive({ subject: "URGENT Invoice 44" });
      assert.equal((await copyIn(state.daveBox, again.id)).thread.folder, "ARCHIVE", "disabled rule no longer stops processing");
      const reordered = await call("dave", "POST", `/mailboxes/${state.daveBox}/rules/reorder`, { ruleIds: [state.invoiceRule, state.urgentRule, disabled.body.data.id] });
      assert.equal(reordered.status, 200, reordered.text);
      assert.deepEqual(reordered.body.data.map((rule) => rule.priority), [10, 20, 30]);
      assert.equal((await call("dave", "DELETE", `/rules/${disabled.body.data.id}`)).status, 200);
      assert.equal(await client.mailRule.count({ where: { mailboxId: state.daveBox } }), 2);
      assert.ok(await client.mailAuditEvent.count({ where: { action: { in: ["MAIL_RULE_CREATED", "MAIL_RULE_UPDATED", "MAIL_RULE_DELETED", "MAIL_RULES_REORDERED"] }, actorAdminUserId: ids.dave } }) >= 5);

      // Per-user actions are refused on shared mailboxes.
      const shared = cf.mailbox.id;
      await client.mailMembership.create({ data: { mailboxId: shared, adminUserId: ids.dave, role: "MANAGER", canSend: true, grantedBy: ids.super } });
      const markReadShared = await call("dave", "POST", `/mailboxes/${shared}/rules`, { name: "x", conditions: { subjectContains: "a" }, actions: { markRead: true } });
      assert.equal(markReadShared.status, 400);
      assert.match(markReadShared.text, /actions\.markRead/);
    });

    await t.test("body search: a word only in the body is found by the owner, not by anyone else; no plaintext in the index", async () => {
      const secretWord = "zephyrquartzine";
      const received = await receive({ subject: "Quarterly notes", text: `Please review the ${secretWord} figures.`, to: [{ address: "dave@cosmicforge.example" }, { address: "accounts@partner.example" }] }, { to: ["dave@cosmicforge.example"] });
      const own = await call("dave", "GET", `/search?q=${secretWord}`);
      assert.equal(own.status, 200, own.text);
      assert.equal(own.body.data.length, 1, "found by a body-only word");
      assert.equal(own.headers.get("cache-control"), "no-store");
      const scoped = await call("dave", "GET", `/mailboxes/${state.daveBox}/search?q=${secretWord.toUpperCase()}`);
      assert.equal(scoped.body.data.length, 1, "case-insensitive");
      const mixed = await call("dave", "GET", `/search?q=${encodeURIComponent(`quarterly ${secretWord}`)}`);
      assert.equal(mixed.body.data.length, 1, "one word in the subject, one in the body");
      assert.equal((await call("dave", "GET", `/search?q=${secretWord}x`)).body.data.length, 0, "whole words only");

      // Nobody else (including SUPER and mail administrators) can discover it.
      for (const key of ["erin", "super", "mailAdmin", "ops"]) {
        const other = await call(key, "GET", `/search?q=${secretWord}`);
        assert.equal(other.status, 200);
        assert.equal(other.body.data.length, 0, `${key} cannot discover it`);
      }
      assert.equal((await call("erin", "GET", `/mailboxes/${state.daveBox}/search?q=${secretWord}`)).status, 404, "no oracle through mailbox-scoped search");

      // The index holds only keyed, per-mailbox terms.
      const message = await copyIn(state.daveBox, received.id);
      const row = await client.mailMessageSearchIndex.findUnique({ where: { messageId: message.id } });
      assert.ok(row && row.termCount > 0);
      const raw = JSON.stringify(await client.$queryRawUnsafe(`SELECT * FROM mail_message_search_index`));
      assert.doesNotMatch(raw, new RegExp(`${secretWord}|figures|review`, "i"), "no plaintext words");
      const terms = await harness.mail.searchIndex.queryTerms([state.daveBox, state.erinBox], secretWord);
      assert.equal(new Set(terms[0].terms).size, 2, "the same word maps to unrelated terms in different mailboxes");
      assert.doesNotMatch(JSON.stringify(await client.mailMessage.findUnique({ where: { id: message.id } })), new RegExp(secretWord), "no body text in message rows");

      // Without the feature (no key) search is metadata-only and never errors.
      const noBody = harness.build({ MAIL_BODY_SEARCH_ENABLED: "false" });
      assert.equal(await noBody.searchIndex.queryTerms([state.daveBox], secretWord), null);

      // Backfill restores a missing index row; freshness reports it.
      await client.mailMessageSearchIndex.delete({ where: { messageId: message.id } });
      const stale = await call("ops", "GET", "/admin/search-index");
      assert.equal(stale.status, 200, stale.text);
      assert.ok(stale.body.data.unindexed >= 1);
      assert.equal((await call("dave", "GET", "/admin/search-index")).status, 403);
      assert.equal((await call("dave", "GET", `/search?q=${secretWord}`)).body.data.length, 0);
      const queued = await call("ops", "POST", "/admin/search-index/backfill");
      assert.equal(queued.status, 202, queued.text);
      await harness.mail.createWorker({ queues: ["EVENTS"] }).drain({ maxTicks: 10 });
      assert.equal((await call("dave", "GET", `/search?q=${secretWord}`)).body.data.length, 1, "searchable again after backfill");
      assert.equal((await call("ops", "GET", "/admin/search-index")).body.data.unindexed, 0);
    });

    await t.test("sender authentication: provider results only; internal-domain spoofing quarantined; forwarding-style SPF failure accepted", async () => {
      // Spoof of our own domain with a forged Authentication-Results header and no provider verdict.
      const spoof = await receive({ from: { address: "ceo@cosmicforge.example", name: "CEO" }, subject: "Wire transfer", authResults: { authenticationResults: "mx.cosmicforge.example; dmarc=pass; spf=pass; dkim=pass" } });
      const spoofCopy = await copyIn(state.daveBox, spoof.id);
      assert.equal(spoofCopy.status, "QUARANTINED");
      assert.equal(spoofCopy.quarantineReason, "INTERNAL_DOMAIN_SPOOF");
      assert.equal(spoofCopy.thread.folder, "SPAM");
      assert.equal(spoofCopy.authResults.assessment.source, "none", "a forged header is not trusted");

      const legit = await receive({ subject: "Forwarded via list", providerAuthentication: { spf: "fail", dkim: "pass", dmarc: null } });
      const legitCopy = await copyIn(state.daveBox, legit.id);
      assert.equal(legitCopy.status, "RECEIVED", "SPF fail + DKIM pass is accepted (legitimate forwarding)");
      assert.equal(legitCopy.authResults.assessment.verdict, "PASS");

      const suspicious = await receive({ subject: "Suspicious", providerAuthentication: { spf: "fail", dkim: "unknown", dmarc: null } });
      const suspiciousCopy = await copyIn(state.daveBox, suspicious.id);
      assert.equal(suspiciousCopy.status, "RECEIVED", "a lone SPF failure is not rejected");
      const messages = await call("dave", "GET", `/threads/${suspiciousCopy.threadId}/messages`);
      assert.equal(messages.body.data[0].senderAuthentication.verdict, "SUSPICIOUS");
      assert.deepEqual(messages.body.data[0].senderAuthentication.reasons, ["SPF_FAIL_NO_DKIM"]);
      assert.equal(messages.body.data[0].authResults, undefined, "raw header text is never exposed");

      const dmarcFail = await receive({ subject: "DMARC fail", providerAuthentication: { spf: "fail", dkim: "fail", dmarc: "fail" } });
      assert.equal((await copyIn(state.daveBox, dmarcFail.id)).status, "RECEIVED", "default policy warns on external DMARC failures");
      const strict = harness.build({ MAIL_INBOUND_AUTH_POLICY: "quarantine" });
      const strictFail = await receive({ subject: "DMARC fail strict", providerAuthentication: { spf: "fail", dkim: "fail", dmarc: "fail" } }, { app: strict });
      assert.equal((await copyIn(state.daveBox, strictFail.id)).quarantineReason, "SENDER_AUTHENTICATION_FAILED");
      assert.ok(await client.mailAuditEvent.count({ where: { action: "MAIL_INBOUND_AUTH_QUARANTINED" } }) >= 2);
    });

    await t.test("routing: CC and BCC local recipients get private copies; external and unknown addresses are handled without leaks", async () => {
      const mixed = await receive({
        to: [{ address: "client@partner.example", name: "Client" }],
        cc: [{ address: "erin@cosmicforge.example", name: "Erin" }],
        envelopeRecipients: ["dave@cosmicforge.example", "ghost@cosmicforge.example"],
        subject: "Mixed recipients",
      }, { to: ["client@partner.example"] });
      assert.equal(mixed.result.delivered, 2, JSON.stringify(mixed.result));
      assert.equal(mixed.result.unknown, 1, "only our domain's unprovisioned address counts as unknown");
      const erinCopy = await copyIn(state.erinBox, mixed.id);
      const daveCopy = await copyIn(state.daveBox, mixed.id);
      assert.ok(erinCopy && daveCopy);
      assert.equal(daveCopy.envelopeRecipient, "dave@cosmicforge.example");
      assert.ok(!erinCopy.recipients.some((recipient) => recipient.address === "dave@cosmicforge.example"), "Dave's BCC delivery is invisible to Erin");
      const erinView = await call("erin", "GET", `/threads/${erinCopy.threadId}/messages`);
      assert.doesNotMatch(erinView.text, /dave@cosmicforge\.example/);
      const audit = await client.mailAuditEvent.findFirst({ where: { action: "MAIL_INBOUND_UNKNOWN_RECIPIENT_REJECTED" }, orderBy: { createdAt: "desc" } });
      assert.deepEqual(audit.metadata.domains, ["cosmicforge.example"], "external domains are not reported as unknown local recipients");
      assert.equal(await client.mailMailbox.count({ where: { name: { contains: "ghost" } } }), 0, "no catch-all mailbox");
    });

    await t.test("archive: original headers and raw MIME are encrypted, integrity-checked and access controlled", async () => {
      const raw = "From: partner@partner.example\r\nTo: dave@cosmicforge.example\r\nSubject: Raw\r\nMessage-ID: <raw@partner.example>\r\n\r\nraw body\r\n";
      const archived = await receive({ subject: "Raw archive", originalHeaders: [{ name: "Received", value: "from mx.partner.example" }, { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; d=partner.example" }], rawMime: raw });
      const copy = await copyIn(state.daveBox, archived.id);
      const row = await client.mailMessageArchive.findUnique({ where: { messageId: copy.id } });
      assert.equal(row.rawMimeStatus, "STORED");
      assert.equal(row.rawMimeSha256, crypto.createHash("sha256").update(raw).digest("hex"));
      const stored = await harness.backend.read(row.rawMimeObjectKey);
      assert.ok(!Buffer.from(stored).toString("utf8").includes("raw body"), "encrypted at rest");
      const headers = await call("dave", "GET", `/messages/${copy.id}/original-headers`);
      assert.equal(headers.status, 200, headers.text);
      assert.deepEqual(headers.body.data.headers.map((header) => header.name), ["Received", "DKIM-Signature"]);
      const download = await fetch(`${base}/messages/${copy.id}/raw`, { headers: { "x-test-user": ids.dave } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-type"), "message/rfc822");
      assert.equal(await download.text(), raw);
      for (const key of ["erin", "super"]) {
        assert.equal((await call(key, "GET", `/messages/${copy.id}/original-headers`)).status, 404);
        assert.equal((await call(key, "GET", `/messages/${copy.id}/raw`)).status, 404);
      }
      assert.ok(await client.mailAuditEvent.count({ where: { action: { in: ["MAIL_ORIGINAL_HEADERS_READ", "MAIL_RAW_MIME_DOWNLOADED"] }, actorAdminUserId: ids.dave } }) >= 2);
      // Tampering with the stored object is detected on read.
      await harness.backend.replace(row.rawMimeObjectKey, Buffer.from("tampered"));
      assert.notEqual((await call("dave", "GET", `/messages/${copy.id}/raw`)).status, 200);
      // Without the raw-MIME approval flag only headers are kept.
      const headersOnly = await receive({ subject: "Headers only", originalHeaders: [{ name: "Received", value: "x" }], rawMime: raw }, { app: harness.build({ MAIL_ARCHIVE_RAW_MIME: "false" }) });
      assert.equal((await client.mailMessageArchive.findUnique({ where: { messageId: (await copyIn(state.daveBox, headersOnly.id)).id } })).rawMimeStatus, "NOT_REQUESTED");
    });

    await t.test("forwarding: approval, policy, loop prevention, clean attachments only, dispatch-time revocation and offboarding", async () => {
      // External domains outside the policy list are refused; internal unprovisioned too.
      assert.equal((await call("dave", "POST", `/mailboxes/${state.daveBox}/forwarding`, { targetAddress: "me@gmail.example", reason: "Personal copy" })).status, 422);
      assert.equal((await call("dave", "POST", `/mailboxes/${state.daveBox}/forwarding`, { targetAddress: "nobody@cosmicforge.example", reason: "Typo target" })).status, 422);
      assert.equal((await call("erin", "POST", `/mailboxes/${state.daveBox}/forwarding`, { targetAddress: "x@partner.example", reason: "Not mine" })).status, 404);
      const external = await call("dave", "POST", `/mailboxes/${state.daveBox}/forwarding`, { targetAddress: "Dave.Assistant@Partner.Example", reason: "Assistant handles travel" });
      assert.equal(external.status, 201, external.text);
      assert.equal(external.body.data.status, "PENDING_APPROVAL");
      assert.equal(external.body.data.targetAddress, "dave.assistant@partner.example");
      const internal = await call("dave", "POST", `/mailboxes/${state.daveBox}/forwarding`, { targetAddress: "erin@cosmicforge.example", reason: "Cover during leave" });
      assert.equal(internal.status, 201, internal.text);

      // Nothing forwards before approval.
      const before = await receive({ subject: "Before approval" });
      assert.equal(await copyIn(state.erinBox, before.id), null);

      // Approval: admins only, never self; external needs MFA step-up.
      assert.equal((await call("dave", "POST", `/admin/forwarding/${external.body.data.id}/approve`, {})).status, 403);
      const noStepUp = await call("ops", "POST", `/admin/forwarding/${external.body.data.id}/approve`, {});
      assert.equal(noStepUp.status, 403, noStepUp.text);
      const approved = await call("ops", "POST", `/admin/forwarding/${external.body.data.id}/approve`, { stepUpId: await stepUp("ops", "MAIL_FORWARDING_APPROVE") });
      assert.equal(approved.status, 200, approved.text);
      assert.equal(approved.body.data.status, "ACTIVE");
      assert.equal((await call("mailAdmin", "POST", `/admin/forwarding/${internal.body.data.id}/approve`, {})).status, 200, "internal targets need approval but no step-up");

      // Inbound with one clean and one infected attachment.
      const forwardedMail = await receive({ subject: "Travel plan", text: "Itinerary attached", to: [{ address: "dave@cosmicforge.example" }], cc: [] }, { attachments: [{ filename: "plan.pdf", contentType: "application/pdf", content: "%PDF-1.4 plan" }, { filename: "expired.pdf", contentType: "application/pdf", content: "x", failDownload: true }] });
      const erinCopy = await copyIn(state.erinBox, forwardedMail.id);
      assert.ok(erinCopy, `internal target received one copy: ${JSON.stringify(await client.mailAuditEvent.findMany({ where: { action: { startsWith: "MAIL_FORWARD" } }, select: { action: true, metadata: true } }))}`);
      const outbound = await client.mailMessage.findFirst({ where: { mailboxId: state.daveBox, idempotencyKey: { startsWith: "fwd:1:" } }, include: { recipients: true, attachments: true } });
      assert.ok(outbound, "external forward queued in the outbox");
      assert.equal(outbound.fromAddress, "dave@cosmicforge.example", "sent as the mailbox's own address, never spoofing the original sender");
      assert.equal(outbound.replyTo, "partner@partner.example");
      assert.deepEqual(outbound.recipients.map((recipient) => recipient.address), ["dave.assistant@partner.example"]);
      assert.deepEqual(outbound.attachments.map((attachment) => attachment.filename), ["plan.pdf"], "unscanned/quarantined attachment withheld");
      // A message with an infected attachment is quarantined and never forwarded.
      const infected = await receive({ subject: "Infected" }, { attachments: [{ filename: "virus.com", contentType: "application/octet-stream", content: EICAR }] });
      assert.equal((await copyIn(state.daveBox, infected.id)).status, "QUARANTINED");
      assert.equal(await copyIn(state.erinBox, infected.id), null, "quarantined mail is not forwarded internally");
      await harness.mail.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 10 });
      const sent = harness.adapter.state.sent.find((entry) => entry.to.some((party) => party.address === "dave.assistant@partner.example"));
      assert.ok(sent, "handed to the provider");
      assert.equal(sent.headers["Auto-Submitted"], "auto-forwarded");
      assert.equal(sent.headers["X-CosmicForge-Forwarded-Hops"], "1");
      assert.doesNotMatch(sent.text, /envelope|bcc/i);

      // Loop prevention: mail that already carries our hop count at the limit is not forwarded again.
      const looping = await receive({ subject: "Loop", originalHeaders: [{ name: "X-CosmicForge-Forwarded-Hops", value: "3" }, { name: "Auto-Submitted", value: "auto-forwarded" }] });
      assert.equal(await client.mailMessage.count({ where: { idempotencyKey: { contains: looping.id } } }), 0);
      assert.ok(await client.mailAuditEvent.count({ where: { action: "MAIL_FORWARD_SKIPPED", metadata: { path: ["reason"], equals: "LOOP_PREVENTED" } } }) >= 1);
      // Never forwarded back to its own sender.
      const fromTarget = await receive({ from: { address: "dave.assistant@partner.example", name: null }, subject: "Re: Travel plan" });
      assert.equal(await client.mailMessage.count({ where: { mailboxId: state.daveBox, idempotencyKey: { startsWith: "fwd:" }, createdAt: { gte: (await copyIn(state.daveBox, fromTarget.id)).createdAt } } }), 0);

      // A queued forward is blocked at dispatch once its rule is disabled.
      const queuedLater = await receive({ subject: "Queued then revoked" });
      const pending = await client.mailMessage.findFirst({ where: { idempotencyKey: { startsWith: "fwd:" }, status: "QUEUED" } });
      assert.ok(pending, `queued forward exists for ${queuedLater.id}`);
      assert.equal((await call("dave", "POST", `/forwarding/${external.body.data.id}/disable`, {})).status, 200);
      await harness.mail.createWorker({ queues: ["OUTBOUND"] }).drain({ maxTicks: 10 });
      const blocked = await client.mailMessage.findUnique({ where: { id: pending.id }, include: { recipients: true } });
      assert.equal(blocked.status, "FAILED");
      assert.ok(await client.mailAuditEvent.count({ where: { action: "MAIL_SEND_BLOCKED_AT_DISPATCH", targetId: pending.id, metadata: { path: ["reason"], equals: "FORWARDING_RULE_DISABLED" } } }) === 1);

      // Offboarding disables the remaining rule; nothing is forwarded afterwards.
      const offboarded = await call("ops", "POST", `/admin/users/${ids.dave}/offboard`);
      assert.equal(offboarded.status, 200, offboarded.text);
      assert.equal(offboarded.body.data.forwardingDisabled, 1);
      assert.equal(await client.mailForwardingRule.count({ where: { mailboxId: state.daveBox, status: "ACTIVE" } }), 0);
      assert.equal((await client.mailForwardingRule.findUnique({ where: { id: internal.body.data.id } })).disabledReason, "OFFBOARDED");
      const admins = await call("ops", "GET", "/admin/forwarding");
      assert.equal(admins.status, 200);
      assert.ok(admins.body.data.length >= 2);
      // Restore Dave for later tests.
      await client.mailMailbox.update({ where: { id: state.daveBox }, data: { status: "ACTIVE", offboardedAt: null, suspendedAt: null } });
      await client.mailAddress.updateMany({ where: { mailboxId: state.daveBox }, data: { status: "ACTIVE" } });
      await client.mailMembership.create({ data: { mailboxId: state.daveBox, adminUserId: ids.dave, role: "OWNER", canSend: true, grantedBy: ids.super } });
    });

    await t.test("reconciliation: a received webhook whose job dead-lettered is retried once, then reported; requeue needs MFA", async () => {
      const reconcile = harness.build({ MAIL_RECONCILIATION_ENABLED: "true" });
      const at = new Date(harness.clock().getTime() - 20 * 60000);
      const add = (id) => harness.adapter.addInbound(id, { from: { address: "partner@partner.example", name: null }, to: [{ address: "dave@cosmicforge.example", name: null }], cc: [], envelopeRecipients: [], subject: `Recon ${id}`, html: null, text: "x", rfcMessageId: `<${id}@partner.example>`, inReplyTo: null, references: [], receivedAt: at });
      add("rc_dead");
      add("rc_failed");
      for (const [emailId, status] of [["rc_dead", "DEAD_LETTER"], ["rc_failed", "FAILED"]]) {
        const event = await client.mailWebhookEvent.create({ data: { provider: "resend", providerEventId: `evt_${crypto.randomUUID()}`, eventType: "email.received", payloadSha256: "0".repeat(64), payload: { type: "email.received", data: { email_id: emailId, to: ["dave@cosmicforge.example"] } }, signatureVerified: true, status: "FAILED" } });
        await client.mailOutboxJob.create({ data: { queue: "INBOUND", kind: "PROCESS_INBOUND", idempotencyKey: `inbound:${event.id}`, webhookEventId: event.id, payload: { providerEmailId: emailId }, status, attemptCount: 6, maxAttempts: 6, lastErrorCode: status === "FAILED" ? "INBOUND_SENDER_INVALID" : "PROVIDER_TIMEOUT", completedAt: at } });
      }
      const first = await reconcile.processors.inboundReconciler.process();
      assert.equal(first.retried, 1, JSON.stringify(first));
      assert.equal(first.recovered, 1, "the dead-lettered email is re-enqueued; the permanent failure is not");
      const retryJob = await client.mailOutboxJob.findUnique({ where: { idempotencyKey: "inbound:reconcile:rc_dead" } });
      // The retry also dead-letters (provider still failing): now it is reported, not hidden.
      await client.mailOutboxJob.update({ where: { id: retryJob.id }, data: { status: "DEAD_LETTER", completedAt: harness.clock() } });
      const second = await reconcile.processors.inboundReconciler.process();
      assert.equal(second.unrecovered, 1, JSON.stringify(second));
      assert.equal(second.recovered, 0);
      const snap = await reconcile.services.ops.snapshot();
      assert.equal(snap.inboundUnrecovered24h, 1);
      assert.ok(reconcile.services.ops.evaluate(snap).some((alert) => alert.code === "MAIL_INBOUND_UNRECOVERED"));

      // Operator requeue: mail admin + MFA, inbound kinds only.
      const send = await client.mailOutboxJob.create({ data: { queue: "OUTBOUND", kind: "SEND_MESSAGE", idempotencyKey: `send:${crypto.randomUUID()}`, status: "DEAD_LETTER" } });
      assert.equal((await call("ops", "POST", `/admin/jobs/${send.id}/requeue`, { reason: "try again", stepUpId: await stepUp("ops", "MAIL_JOB_REQUEUE") })).status, 409, "outbound sends are never replayed blindly");
      assert.equal((await call("dave", "POST", `/admin/jobs/${retryJob.id}/requeue`, { reason: "try again" })).status, 403);
      assert.equal((await call("ops", "POST", `/admin/jobs/${retryJob.id}/requeue`, { reason: "provider recovered" })).status, 403, "step-up required");
      const requeued = await call("ops", "POST", `/admin/jobs/${retryJob.id}/requeue`, { reason: "provider recovered", stepUpId: await stepUp("ops", "MAIL_JOB_REQUEUE") });
      assert.equal(requeued.status, 200, requeued.text);
      await harness.mail.createWorker({ queues: ["INBOUND"] }).drain({ maxTicks: 10 });
      assert.ok(await copyIn(state.daveBox, "rc_dead"), "requeued email delivered");
      assert.equal((await client.mailOutboxJob.findUnique({ where: { id: retryJob.id } })).status, "SUCCEEDED");
    });

    await t.test("marketing: replies are attributed to the campaign by evidence, deduplicated, brand-scoped and content-free", async () => {
      const at = new Date(harness.clock().getTime() - 2 * 86400000);
      const template = await client.marketingEmailTemplate.create({ data: { organizationId: cf.organization.id, name: "Reply template", createdBy: ids.dave } });
      const version = await client.marketingTemplateVersion.create({ data: { templateId: template.id, version: 1, subject: "Autumn news", blocks: [], html: "<p>news</p>", text: "news", contentSha256: "b".repeat(64), createdBy: ids.dave } });
      const campaign = await client.marketingEmailCampaign.create({ data: { organizationId: cf.organization.id, name: "Autumn", topic: "newsletter", status: "COMPLETE", senderAddressId: cf.sender.id, templateVersionId: version.id, createdByAdminUserId: ids.dave, updatedByAdminUserId: ids.dave } });
      const snapshot = await client.marketingCampaignSnapshot.create({ data: { campaignId: campaign.id, revision: 1, kind: "APPROVAL", templateVersionId: version.id, senderAddress: cf.sender.address, replyTo: null, subject: "Autumn news", html: "<p>news</p>", text: "news", audienceSnapshot: {}, eligibleCount: 2, excludedCount: 0, contentSha256: "a".repeat(64), createdBy: ids.dave } });
      const dispatch = await client.marketingBroadcastDispatch.create({ data: { campaignId: campaign.id, organizationId: cf.organization.id, approvalSnapshotId: snapshot.id, status: "COMPLETED", providerBroadcastId: "bc_reply_test", scheduledFor: at, timeZone: "Africa/Lagos", contentSha256: "a".repeat(64), scheduledByAdminUserId: ids.dave, providerSentAt: at, recipientCount: 2 } });
      const contact = async (email) => client.marketingContact.create({ data: { organizationId: cf.organization.id, email, source: "TEST" } });
      const ada = await contact("ada@reader.example");
      const ben = await contact("ben@reader.example");
      for (const person of [ada, ben]) await client.marketingBroadcastRecipient.create({ data: { dispatchId: dispatch.id, organizationId: cf.organization.id, contactId: person.id, email: person.email, status: "DELIVERED", acceptedAt: at } });
      await client.mailMembership.create({ data: { mailboxId: cf.mailbox.id, adminUserId: ids.erin, role: "MEMBER", canSend: false, grantedBy: ids.super } }).catch(() => {});
      const toNews = [{ address: cf.sender.address, name: null }];

      await receive({ from: { address: "ada@reader.example", name: "Ada" }, to: toNews, subject: "Re: Autumn news", inReplyTo: "<provider-id@resend.dev>" }, { to: [cf.sender.address] });
      await receive({ from: { address: "ada@reader.example", name: "Ada" }, to: toNews, subject: "Re: Autumn news (again)" }, { to: [cf.sender.address] });
      await receive({ from: { address: "ben@reader.example", name: "Ben" }, to: toNews, subject: "Unrelated question" }, { to: [cf.sender.address] });
      await receive({ from: { address: "stranger@reader.example", name: null }, to: toNews, subject: "Re: Autumn news" }, { to: [cf.sender.address] });
      await receive({ from: { address: "ben@reader.example", name: "Ben" }, subject: "Re: Autumn news" }, { to: ["dave@cosmicforge.example"] });

      assert.equal(await client.marketingCampaignReply.count({ where: { campaignId: campaign.id } }), 1, "only Ada's reply to the brand's reply mailbox counts, once");
      const report = await call("dave", "GET", `/marketing/${cf.organization.id}/campaigns/${campaign.id}/report`);
      assert.equal(report.status, 200, report.text);
      assert.equal(report.body.data.replied.replied, 1);
      assert.equal(report.body.data.replied.method, "RECIPIENT_REPLY_ADDRESS_MATCH");
      assert.equal(report.body.data.replied.window.days, 30);
      assert.doesNotMatch(JSON.stringify(report.body.data.replied), /Autumn news|ada@/);
      assert.ok([403, 404].includes((await call("kim", "GET", `/marketing/${cf.organization.id}/campaigns/${campaign.id}/report`)).status), "other brands cannot see it");
    });

    await t.test("rate limits are shared across replicas and fall back safely", async () => {
      const replicaA = harness.build();
      const replicaB = harness.build();
      const key = `test:${crypto.randomUUID()}`;
      const results = [];
      for (let index = 0; index < 3; index += 1) results.push(await replicaA.rateLimiter.consume(key, { max: 5 }));
      for (let index = 0; index < 3; index += 1) results.push(await replicaB.rateLimiter.consume(key, { max: 5 }));
      assert.deepEqual(results.map((entry) => entry.allowed), [true, true, true, true, true, false], "the 6th request is refused even on another replica");
      assert.ok(results.every((entry) => entry.shared));
      const { createSharedRateLimiter } = require("../src/modules/mail/ops/shared-rate-limit");
      const broken = createSharedRateLimiter({ client: { $queryRaw: async () => { throw Object.assign(new Error("down"), { code: "P1001" }); }, $executeRaw: async () => 0 }, features: { isReady: async () => true }, metrics: harness.mail.metrics });
      const fallback = await broken.consume("x", { max: 1 });
      assert.equal(fallback.allowed, true);
      assert.equal(fallback.shared, false);
      assert.equal((await broken.consume("x", { max: 1 })).allowed, false, "fallback still limits");
      assert.equal((await broken.consume("y", { max: 1, failClosed: true })).allowed, false, "sensitive callers fail closed");
      assert.ok(harness.mail.metrics.total("rate_limit_fallback") >= 1);
    });

    await t.test("rollout rules and emergency stops are consistent across replicas immediately", async () => {
      const replicaA = harness.build();
      const replicaB = harness.build();
      assert.equal(await replicaB.runtime.haltReason("STAFF_MAIL", {}), null);
      const stop = await call("ops", "POST", "/admin/emergency-stops", { scope: "ALL", reason: "Consistency drill (test)" });
      assert.equal(stop.status, 201, stop.text);
      assert.equal(await replicaB.runtime.haltReason("STAFF_MAIL", {}), "MAIL_EMERGENCY_STOP", "no cache delay on another replica");
      assert.equal(await replicaA.runtime.haltReason("STAFF_MAIL", {}), "MAIL_EMERGENCY_STOP");
      const release = await call("ops", "POST", `/admin/emergency-stops/${stop.body.data.id}/release`, { reason: "Drill complete (test)", stepUpId: await stepUp("ops", "MAIL_EMERGENCY_STOP_RELEASE") });
      assert.equal(release.status, 200, release.text);
      assert.equal(await replicaB.runtime.haltReason("STAFF_MAIL", {}), null);
    });

    await t.test("operations: storage capacity, over-quota policy, unusual exports and scanner failures raise alerts", async () => {
      const small = harness.build({ MAIL_MAILBOX_STORAGE_QUOTA_MB: "1", MAIL_OVER_QUOTA_POLICY: "reject", MAIL_ALERT_EXPORTS_PER_ACTOR_HOUR: "5" });
      await client.mailMessage.updateMany({ where: { mailboxId: state.erinBox }, data: { sizeBytes: 1100 * 1024 } });
      const rejected = await receive({ to: [{ address: "erin@cosmicforge.example", name: null }], subject: "Too big for Erin" }, { app: small, to: ["erin@cosmicforge.example"] });
      assert.equal(rejected.result.delivered, 0);
      assert.equal(rejected.result.overQuota, 1);
      assert.equal(await copyIn(state.erinBox, rejected.id), null, "not delivered under the reject policy");
      const accepted = await receive({ to: [{ address: "erin@cosmicforge.example", name: null }], subject: "Accepted over quota" }, { app: harness.build({ MAIL_MAILBOX_STORAGE_QUOTA_MB: "1" }), to: ["erin@cosmicforge.example"] });
      assert.equal(accepted.result.delivered, 1, "default policy delivers and alerts");
      for (let index = 0; index < 6; index += 1) await client.mailAuditEvent.create({ data: { actorAdminUserId: ids.erin, action: "MAIL_ATTACHMENT_DOWNLOADED", targetType: "attachment", createdAt: harness.clock() } });
      await client.mailAttachment.create({ data: { mailboxId: state.erinBox, filename: "x.bin", contentType: "application/octet-stream", sizeBytes: 1, sha256: "0".repeat(64), scanStatus: "SCAN_FAILED", quarantined: true, createdAt: harness.clock() } });
      const snap = await small.services.ops.snapshot();
      assert.ok(snap.storage.overQuota.some((row) => row.mailboxId === state.erinBox));
      assert.equal(snap.search.enabled, true);
      assert.equal(snap.features.gapClosureSchema, true);
      const codes = small.services.ops.evaluate(snap).map((alert) => alert.code);
      for (const code of ["MAIL_STORAGE_QUOTA_EXCEEDED", "MAIL_UNUSUAL_EXPORT", "MAIL_SCANNER_FAILURES"]) assert.ok(codes.includes(code), `${code} in ${codes}`);
      const metrics = await small.services.ops.prometheus();
      for (const name of ["cf_mail_storage_bytes", "cf_mail_mailboxes_over_quota", "cf_mail_search_unindexed", "cf_mail_unusual_export_actors_1h", "cf_mail_scanner_failures_24h", "cf_mail_inbound_unrecovered_24h"]) assert.match(metrics, new RegExp(`^${name}`, "m"));
      assert.doesNotMatch(metrics, /erin@|Too big/);
    });
  } finally {
    await closeServer(server);
    await db.close();
  }
});

"use strict";

// Attachment lifecycle on real PostgreSQL (migrations replayed), the real Mail
// router + multer + compose service, encrypted in-memory storage, the offline
// fake provider and the test signature scanner. Uses generated REAL PDFs (not
// renamed text). Covers the reported failure (a 3 MiB, 14-page PDF) end to
// end behind the API, limits, multipart handling, scan fail-closed, storage
// hygiene (no orphans / duplicates), removal, draft persistence and sending.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { openDatabase, seed, createHarness, listen, caller } = require("./helpers/mail-test-harness");
const { closeServer } = require("./helpers/server-close");
const { EICAR, unavailableScanner } = require("../src/modules/mail/scanning/attachment-scanner");
const { buildPdf } = require("./helpers/make-pdf");

const MiB = 1024 * 1024;
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function form(buffer, filename, type) {
  const body = new FormData();
  body.append("file", new Blob([buffer], { type }), filename);
  return body;
}

// fetch() must set the multipart Content-Type (with boundary) itself, exactly as a browser does.
async function upload(api, userKey, path, body, headers = {}) {
  const response = await fetch(`${api.base}${path}`, { method: "POST", headers: { ...(userKey ? { "x-test-user": api.ids[userKey] } : {}), ...headers }, body });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, body: json, text, headers: response.headers };
}

// Raw multipart POST so the boundary and framing are fully controlled.
function rawPost(origin, path, userId, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "x-test-user": userId, "content-length": body.length, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, body: json, text }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(t) {
  const db = await openDatabase();
  const { client } = db;
  const harness = createHarness(client);
  const seeded = await seed(client, { clock: harness.clock });
  for (const [userId, sessionId] of seeded.sessions) harness.state.sessions.set(userId, sessionId);
  const { ids, brands } = seeded;
  const servers = [];
  const serve = async (overrides = {}, extra = {}) => {
    const application = overrides === null ? harness.mail : harness.build(overrides, extra);
    const listening = await listen(harness.mountApp(application));
    servers.push(listening.server);
    return { application, ...listening, ids, call: caller(listening.base, ids) };
  };
  t.after(async () => {
    for (const server of servers) await closeServer(server);
    await db.close();
  });
  const main = await serve(null);
  const cf = brands.cosmicforge;
  const box = await main.call("ops", "POST", "/admin/mailboxes", { organizationId: cf.organization.id, type: "PERSONAL", ownerAdminUserId: ids.dave, address: { domainId: cf.domain.id, localPart: "dave" } });
  assert.equal(box.status, 201, box.text);
  const mailboxId = box.body.data.id;
  const newDraft = async (api, subject = "Partner pitch") => {
    const draft = await api.call("dave", "POST", `/mailboxes/${mailboxId}/drafts`, { to: ["partner@external.example"], subject, html: "<p>Please see the attached.</p>" });
    assert.equal(draft.status, 201, draft.text);
    return draft.body.data.id;
  };
  const drain = async (application = harness.mail) => { harness.advance(4 * 3600 * 1000); await application.createWorker().drain(); };
  const objectCount = () => harness.backend.objects.size;
  const rows = (draftId) => client.mailAttachment.findMany({ where: { draftId } });
  return { client, harness, ids, main, serve, mailboxId, newDraft, drain, objectCount, rows, cf };
}

test("Mail attachment lifecycle on real PostgreSQL", { timeout: 600000 }, async (t) => {
  const s = await setup(t);
  const { main, harness } = s;
  const pdf3 = buildPdf({ pages: 14, targetBytes: 3 * MiB, title: "Karryam Vendor Partner Pitch" });
  const state = {};

  await t.test("the generated fixture is a real 14-page, exactly 3 MiB PDF", () => {
    assert.equal(pdf3.length, 3 * MiB);
    assert.equal(pdf3.subarray(0, 8).toString("latin1").slice(0, 5), "%PDF-");
    assert.match(pdf3.subarray(-8).toString("latin1"), /%%EOF/);
    assert.equal((pdf3.toString("latin1").match(/\/Type \/Page /g) || []).length, 14);
  });

  await t.test("limits are published by the API (single source of truth for the web app)", async () => {
    const entitlements = await main.call("dave", "GET", "/me/entitlements");
    assert.equal(entitlements.status, 200, entitlements.text);
    assert.deepEqual(entitlements.body.data.limits, { attachmentMaxBytes: 10 * MiB, messageMaxBytes: 25 * MiB, maxAttachmentsPerMessage: 10 });
  });

  await t.test("the reported file: a 3 MiB PDF is accepted, scanned CLEAN, stored encrypted and downloadable byte-for-byte", async () => {
    state.draftId = await s.newDraft(main);
    const before = s.objectCount();
    const uploaded = await upload(main, "dave", `/drafts/${state.draftId}/attachments`, form(pdf3, "Karryam Vendor Partner Pitch (2).pdf", "application/pdf"));
    assert.equal(uploaded.status, 201, uploaded.text);
    const attachment = uploaded.body.data;
    assert.equal(attachment.scanStatus, "CLEAN");
    assert.equal(attachment.sizeBytes, 3 * MiB);
    assert.equal(attachment.filename, "Karryam Vendor Partner Pitch (2).pdf");
    assert.equal(attachment.contentType, "application/pdf");
    state.pdfAttachmentId = attachment.id;
    assert.equal(s.objectCount(), before + 1, "exactly one storage object");
    const row = await s.client.mailAttachment.findUnique({ where: { id: attachment.id } });
    assert.equal(row.sha256, sha256(pdf3));
    const stored = harness.backend.objects.get(row.storageKey);
    assert.ok(!stored.includes(Buffer.from("%PDF-1.4")), "object at rest is ciphertext, not the PDF");
    assert.ok(!stored.includes(Buffer.from("Karryam Vendor Partner Pitch - page 1")), "no plaintext page text at rest");
    const download = await main.call("dave", "GET", `/attachments/${attachment.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment;/, "always downloaded, never rendered inline");
    const bytes = Buffer.from(await (await fetch(`${main.base}/attachments/${attachment.id}/download`, { headers: { "x-test-user": s.ids.dave } })).arrayBuffer());
    assert.equal(sha256(bytes), sha256(pdf3), "downloaded bytes equal the uploaded PDF");
    assert.equal((await main.call("alice-not-a-user", "GET", `/attachments/${attachment.id}/download`)).status, 401);
    assert.equal((await main.call("kim", "GET", `/attachments/${attachment.id}/download`)).status, 404, "another staff member cannot fetch it");
  });

  await t.test("1 MiB, 5 MiB and the exact per-file boundary succeed; one byte over is a structured 413 that leaves nothing behind", async () => {
    const draftId = await s.newDraft(main, "Sizes");
    for (const size of [1 * MiB, 5 * MiB]) {
      const response = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(buildPdf({ pages: 3, targetBytes: size }), `size-${size}.pdf`, "application/pdf"));
      assert.equal(response.status, 201, `${size}: ${response.text}`);
      assert.equal(response.body.data.sizeBytes, size);
    }
    const boundaryDraft = await s.newDraft(main, "Boundary");
    const exact = await upload(main, "dave", `/drafts/${boundaryDraft}/attachments`, form(buildPdf({ pages: 3, targetBytes: 10 * MiB }), "exact.pdf", "application/pdf"));
    assert.equal(exact.status, 201, exact.text);
    const objects = s.objectCount();
    const over = await upload(main, "dave", `/drafts/${boundaryDraft}/attachments`, form(buildPdf({ pages: 3, targetBytes: 10 * MiB + 1 }), "over.pdf", "application/pdf"));
    assert.equal(over.status, 413);
    assert.equal(over.body.code, "MAIL_ATTACHMENT_TOO_LARGE");
    assert.equal(over.body.errors[0].maxBytes, 10 * MiB, "the limit is reported so the UI can explain it");
    assert.ok("correlationId" in over.body, "responses carry a correlation id field for support");
    assert.equal(s.objectCount(), objects, "rejected upload stored nothing");
    assert.equal((await s.rows(boundaryDraft)).length, 1, "no broken draft attachment record");
  });

  await t.test("images, Office documents and other supported types share the same clean path; blocked types are quarantined", async () => {
    const draftId = await s.newDraft(main, "Types");
    const zipLike = (marker) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker), crypto.randomBytes(2048)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(512 * 1024)]);
    const cases = [
      ["logo.png", "image/png", png],
      ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zipLike("word/")],
      ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zipLike("xl/")],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", zipLike("ppt/")],
      ["notes.txt", "text/plain", Buffer.from("plain notes")],
    ];
    for (const [name, type, content] of cases) {
      const response = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(content, name, type));
      assert.equal(response.status, 201, `${name}: ${response.text}`);
      assert.equal(response.body.data.scanStatus, "CLEAN", name);
      assert.equal(response.body.data.contentType, type);
    }
    const blocked = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(Buffer.from("MZ\u0090\u0000not really"), "setup.exe", "application/octet-stream"));
    assert.equal(blocked.status, 201);
    assert.notEqual(blocked.body.data.scanStatus, "CLEAN");
    const macro = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(zipLike("macro"), "macros.docm", "application/vnd.ms-word.document.macroEnabled.12"));
    assert.notEqual(macro.body.data.scanStatus, "CLEAN", "macro-enabled Office files stay blocked");
  });

  await t.test("multipart framing: unusual but valid boundaries work; a missing or broken boundary is a clear 400 and stores nothing", async () => {
    const draftId = await s.newDraft(main, "Framing");
    const userId = s.ids.dave;
    const pdf = buildPdf({ pages: 2, targetBytes: 200 * 1024 });
    const bodyFor = (boundary, filename = "framed.pdf") => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const path = `${main.base}/drafts/${draftId}/attachments`;
    const good = await rawPost(main.origin, new URL(path).pathname, userId, { "content-type": "multipart/form-data; boundary=----WebKitFormBoundaryAbC123xYz" }, bodyFor("----WebKitFormBoundaryAbC123xYz"));
    assert.equal(good.status, 201, good.text);
    const quoted = await rawPost(main.origin, new URL(path).pathname, userId, { "content-type": 'multipart/form-data; boundary="a b+c=d(1)"' }, bodyFor("a b+c=d(1)", "quoted.pdf"));
    assert.equal(quoted.status, 201, quoted.text);
    const objects = s.objectCount();
    const rowCount = (await s.rows(draftId)).length;
    // The old frontend bug: a hand-written Content-Type without a boundary.
    const noBoundary = await rawPost(main.origin, new URL(path).pathname, userId, { "content-type": "multipart/form-data" }, bodyFor("----X"));
    assert.equal(noBoundary.status, 400, noBoundary.text);
    assert.equal(noBoundary.body.code, "MAIL_VALIDATION_FAILED");
    assert.equal(noBoundary.body.errors[0].reason, "MALFORMED_MULTIPART");
    const json = await rawPost(main.origin, new URL(path).pathname, userId, { "content-type": "application/json" }, Buffer.from("{}"));
    assert.equal(json.status, 400);
    const truncated = await rawPost(main.origin, new URL(path).pathname, userId, { "content-type": "multipart/form-data; boundary=----T" }, bodyFor("----T").subarray(0, 100 * 1024));
    assert.equal(truncated.status, 400, truncated.text);
    assert.equal(s.objectCount(), objects, "malformed uploads stored nothing");
    assert.equal((await s.rows(draftId)).length, rowCount);
    assert.ok(!/stack|multer|busboy|Error:/i.test(noBoundary.text + truncated.text), "no parser internals leak");
  });

  await t.test("authentication and authorization still apply to uploads", async () => {
    const draftId = await s.newDraft(main, "Auth");
    const anonymous = await upload(main, null, `/drafts/${draftId}/attachments`, form(Buffer.from("x"), "x.txt", "text/plain"));
    assert.equal(anonymous.status, 401);
    const other = await upload(main, "kim", `/drafts/${draftId}/attachments`, form(Buffer.from("x"), "x.txt", "text/plain"));
    assert.equal(other.status, 404, "another user cannot attach to my draft");
    assert.equal((await s.rows(draftId)).length, 0);
  });

  await t.test("attachment count and aggregate message limits are enforced separately and before storage", async () => {
    const small = await s.serve({ MAIL_MAX_ATTACHMENTS: "2", MAIL_MESSAGE_MAX_BYTES: String(7 * MiB) });
    const draftId = await s.newDraft(small, "Limits");
    const up = (name, size) => upload(small, "dave", `/drafts/${draftId}/attachments`, form(buildPdf({ pages: 2, targetBytes: size }), name, "application/pdf"));
    assert.equal((await up("a.pdf", 3 * MiB)).status, 201);
    const objects = s.objectCount();
    const aggregate = await up("b.pdf", 5 * MiB);
    assert.equal(aggregate.status, 413, aggregate.text);
    assert.equal(aggregate.body.errors[0].reason, "MESSAGE_TOO_LARGE");
    assert.equal(aggregate.body.errors[0].maxBytes, 7 * MiB);
    assert.equal(s.objectCount(), objects, "aggregate rejection stored nothing");
    assert.equal((await up("b.pdf", 3 * MiB)).status, 201);
    const tooMany = await up("c.pdf", 100 * 1024);
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.errors[0].reason, "TOO_MANY_ATTACHMENTS");
    assert.equal(tooMany.body.errors[0].maxAttachments, 2);
    assert.equal((await s.rows(draftId)).length, 2);
    assert.equal(s.objectCount(), objects + 1);
  });

  await t.test("concurrent uploads: every accepted file has exactly one object and row; the count limit holds under a race with no orphans", async () => {
    const racing = await s.serve({ MAIL_MAX_ATTACHMENTS: "3" });
    const draftId = await s.newDraft(racing, "Race");
    const before = s.objectCount();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => upload(racing, "dave", `/drafts/${draftId}/attachments`, form(Buffer.from(`parallel ${i} ${crypto.randomUUID()}`), `p${i}.txt`, "text/plain"))));
    const accepted = results.filter((r) => r.status === 201).length;
    assert.ok(accepted <= 3 && accepted >= 1, `accepted ${accepted}`);
    assert.ok(results.every((r) => [201, 400, 409].includes(r.status)), results.map((r) => r.status).join());
    assert.equal((await s.rows(draftId)).length, accepted);
    await s.drain();
    await s.drain();
    assert.equal(s.objectCount() - before, accepted, "losing racers' objects were cleaned up");
  });

  await t.test("malware-positive files are quarantined and can never be sent", async () => {
    const draftId = await s.newDraft(main, "EICAR");
    const infected = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(Buffer.from(EICAR), "invoice.pdf", "application/pdf"));
    assert.equal(infected.status, 201, infected.text);
    assert.equal(infected.body.data.scanStatus, "INFECTED");
    assert.equal(infected.body.data.downloadable, false);
    const draft = await main.call("dave", "GET", `/drafts/${draftId}`);
    const send = await main.call("dave", "POST", `/drafts/${draftId}/send`, { revision: draft.body.data.revision }, { "Idempotency-Key": "infected-send-0001" });
    assert.ok(send.status >= 400 && send.status < 500, `send refused: ${send.status}`);
    assert.equal(send.body.code, "MAIL_ATTACHMENT_NOT_CLEAN");
    assert.equal(harness.adapter.state.sent.length, 0, "nothing reached the provider");
    const blocked = await main.call("dave", "GET", `/attachments/${infected.body.data.id}/download`);
    assert.ok([403, 404, 409, 423].includes(blocked.status), `download of infected file: ${blocked.status}`);
  });

  await t.test("scanner outage or timeout fails closed: stored quarantined, never CLEAN, never sent", async () => {
    const outage = await s.serve({}, { scanner: unavailableScanner() });
    const timeoutScanner = { name: "timeout", available: true, metrics: {}, async scan() { throw Object.assign(new Error("scan timed out"), { code: "ETIMEDOUT" }); }, async health() { return { ok: false, detail: "timeout" }; } };
    const timeout = await s.serve({}, { scanner: timeoutScanner });
    for (const [label, api] of [["outage", outage], ["timeout", timeout]]) {
      const draftId = await s.newDraft(api, `Scanner ${label}`);
      const response = await upload(api, "dave", `/drafts/${draftId}/attachments`, form(pdf3, "report.pdf", "application/pdf"));
      assert.equal(response.status, 201, response.text);
      assert.notEqual(response.body.data.scanStatus, "CLEAN", label);
      assert.equal(response.body.data.downloadable, false);
      const draft = await api.call("dave", "GET", `/drafts/${draftId}`);
      const send = await api.call("dave", "POST", `/drafts/${draftId}/send`, { revision: draft.body.data.revision }, { "Idempotency-Key": `scan-${label}-0001` });
      assert.equal(send.body.code, "MAIL_ATTACHMENT_NOT_CLEAN", label);
    }
    assert.equal(harness.adapter.state.sent.length, 0);
  });

  await t.test("attach, remove, re-attach: the draft keeps its other files and the removed object is deleted", async () => {
    const draftId = await s.newDraft(main, "Remove");
    const keep = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(Buffer.from("keep me"), "keep.txt", "text/plain"));
    const drop = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(pdf3, "drop.pdf", "application/pdf"));
    assert.equal(keep.status, 201);
    assert.equal(drop.status, 201);
    const withBoth = s.objectCount();
    const removed = await main.call("dave", "DELETE", `/drafts/${draftId}/attachments/${drop.body.data.id}`);
    assert.equal(removed.status, 200, removed.text);
    let draft = await main.call("dave", "GET", `/drafts/${draftId}`);
    assert.deepEqual(draft.body.data.attachments.map((a) => a.filename), ["keep.txt"]);
    await s.drain();
    await s.drain();
    assert.ok(s.objectCount() <= withBoth - 1, "removed attachment object was deleted from storage");
    const again = await upload(main, "dave", `/drafts/${draftId}/attachments`, form(pdf3, "drop.pdf", "application/pdf"));
    assert.equal(again.status, 201, again.text);
    assert.notEqual(again.body.data.id, drop.body.data.id);
    draft = await main.call("dave", "GET", `/drafts/${draftId}`);
    assert.deepEqual(draft.body.data.attachments.map((a) => a.filename).sort(), ["drop.pdf", "keep.txt"]);
    // Draft autosave (PATCH) preserves the attachments.
    const saved = await main.call("dave", "PATCH", `/drafts/${draftId}`, { revision: draft.body.data.revision, subject: "Remove (edited)", html: "<p>edited body</p>" });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.data.attachments.length, 2);
    const reloaded = await main.call("dave", "GET", `/drafts/${draftId}`);
    assert.equal(reloaded.body.data.subject, "Remove (edited)");
    assert.equal(reloaded.body.data.attachments.length, 2);
  });

  await t.test("sending the clean PDF: the provider receives the exact bytes once, retries and concurrent sends do not duplicate", async () => {
    const draft = await main.call("dave", "GET", `/drafts/${state.draftId}`);
    assert.equal(draft.body.data.attachments.length, 1);
    const key = "send-with-pdf-0001";
    const responses = await Promise.all([1, 2, 3].map(() => main.call("dave", "POST", `/drafts/${state.draftId}/send`, { revision: draft.body.data.revision }, { "Idempotency-Key": key })));
    for (const response of responses) assert.ok([200, 202, 409].includes(response.status), `${response.status} ${response.text}`);
    const accepted = responses.filter((r) => r.status === 202 || r.status === 200);
    assert.ok(accepted.length >= 1);
    assert.equal(new Set(accepted.map((r) => r.body.data.messageId)).size, 1, "one message");
    const replay = await main.call("dave", "POST", `/drafts/${state.draftId}/send`, { revision: draft.body.data.revision }, { "Idempotency-Key": key });
    assert.equal(replay.body.data.messageId, accepted[0].body.data.messageId);
    await s.drain();
    await s.drain();
    assert.equal(harness.adapter.state.sent.length, 1, "exactly one provider send");
    const request = harness.adapter.state.sent[0];
    assert.equal(request.attachments.length, 1);
    assert.equal(request.attachments[0].filename, "Karryam Vendor Partner Pitch (2).pdf");
    assert.equal(sha256(request.attachments[0].content), sha256(pdf3), "provider payload equals the uploaded PDF");
    const message = await s.client.mailMessage.findUnique({ where: { id: accepted[0].body.data.messageId }, include: { attachments: true } });
    assert.equal(message.attachments.length, 1);
  });
});

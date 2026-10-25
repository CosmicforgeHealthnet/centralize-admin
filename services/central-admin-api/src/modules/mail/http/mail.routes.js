"use strict";

// /api/mail/v1 router. Every route (except openapi + public consent confirm)
// requires HQ authentication; object-level authorization lives in services.

const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const ApiResponse = require("../../../shared/utils/ApiResponse");
const asyncHandler = require("../../../shared/utils/asyncHandler");
const { mailError } = require("../mail.errors");
const policy = require("../authz/mail.policy");
const { publicStatus } = require("../mail.config");
const { buildOpenApiDocument } = require("../openapi/mail.openapi");

// Request context passed to services. sessionId binds MFA step-ups to the
// caller's live HQ session (null for legacy, session-less tokens).
function ctx(req) {
  return { requestId: req.correlationId || null, ipAddress: req.ip || null, sessionId: req.authSession?.id || null };
}

function ok(res, data, { status = 200, message = "OK", meta = null } = {}) {
  return ApiResponse.success(res, status, message, data, meta);
}

function page(res, result) {
  return ok(res, result.items, { meta: { nextCursor: result.nextCursor } });
}

function createMailRouter({ mail, authenticate, rateLimitMax = 300 }) {
  const router = express.Router();
  const { mailbox, compose, admin, support, marketing, stepUp, breakGlass, broadcasts, automations, publicPreferences, integrations } = mail.services;
  const config = mail.config;
  const limits = config.limits;

  const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: limits.attachmentMaxBytes, files: 1 } });
  const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /\.csv$/i.test(file.originalname || "") && /^(text\/csv|application\/vnd\.ms-excel|text\/plain|application\/octet-stream)$/i.test(file.mimetype || "")),
  });
  const uploadErrors = (handler) => (req, res, next) =>
    handler(req, res, (error) => {
      if (error?.code === "LIMIT_FILE_SIZE") return next(mailError("MAIL_ATTACHMENT_TOO_LARGE", { maxBytes: limits.attachmentMaxBytes }));
      if (error) return next(mailError("MAIL_VALIDATION_FAILED", { field: "file", reason: error.code || "UPLOAD_FAILED" }));
      return next();
    });

  // Created lazily so importing the app never starts the limiter's timers.
  let rateLimiter = null;
  const limiter = (req, res, next) => {
    if (!rateLimiter) {
      rateLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        // Intentional lazy construction (see above); not a per-request limiter.
        validate: { creationStack: false },
        keyGenerator: (request) => request.adminUser?.id || rateLimit.ipKeyGenerator?.(request.ip) || request.ip,
        handler: (request, response, done) => done(mailError("MAIL_RATE_LIMITED", { retryAfter: 60 })),
      });
    }
    return rateLimiter(req, res, next);
  };

  router.get("/openapi.json", (req, res) => res.json(buildOpenApiDocument()));

  // ---- public recipient endpoints (signed tokens only, per-IP rate limit) ----
  let publicLimiterInstance = null;
  const publicLimiter = (req, res, next) => {
    if (!publicLimiterInstance) {
      publicLimiterInstance = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, validate: { creationStack: false }, handler: (request, response) => response.status(429).type("text/plain").send("Too many requests") });
    }
    return publicLimiterInstance(req, res, next);
  };
  const publicForm = express.urlencoded({ extended: false, limit: "2kb" });
  const sendPage = (res, result) => res.status(result.status).set(publicPreferences.PAGE_HEADERS).send(result.html);
  router.post("/public/consent/confirm", publicLimiter, express.json({ limit: "2kb" }), asyncHandler(async (req, res) => ok(res, await marketing.confirmConsent(req.body?.token))));
  router.get("/public/consent/confirm/:token", publicLimiter, (req, res) => sendPage(res, publicPreferences.confirmationLanding(req.params.token)));
  router.post("/public/consent/confirm/:token", publicLimiter, asyncHandler(async (req, res) => sendPage(res, await publicPreferences.confirm(req.params.token))));
  router.get("/public/unsubscribe/:token", publicLimiter, asyncHandler(async (req, res) => sendPage(res, await publicPreferences.renderPreferences(req.params.token))));
  router.post("/public/unsubscribe/:token", publicLimiter, publicForm, asyncHandler(async (req, res) => {
    // RFC 8058: mail clients POST "List-Unsubscribe=One-Click".
    const oneClick = req.body?.["List-Unsubscribe"] === "One-Click";
    const result = await publicPreferences.unsubscribe(req.params.token, { scope: req.body?.scope === "topic" ? "topic" : "all", oneClick, ipAddress: req.ip || null });
    if (oneClick) return res.status(result.ok ? 200 : 404).type("text/plain").send(result.ok ? "Unsubscribed" : "Not found");
    return sendPage(res, result.ok ? result : await publicPreferences.renderPreferences(req.params.token));
  }));

  router.use(authenticate);
  router.use((req, res, next) => {
    if (!config.enabled) return next(mailError("MAIL_DISABLED"));
    try {
      policy.assertActiveIdentity(req.adminUser);
    } catch (error) {
      return next(error);
    }
    return next();
  });
  router.use(limiter);

  const user = (req) => req.adminUser;
  const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  // --------------------------------------------------------------- me
  router.get("/me/entitlements", asyncHandler(async (req, res) => {
    const client = mail.client;
    const [mailboxes, canAdmin, canEditAdmin, scopes] = await Promise.all([
      mailbox.listMyMailboxes(user(req)),
      policy.canAdministerMail(client, user(req), "VIEW"),
      policy.canAdministerMail(client, user(req), "EDIT"),
      config.marketingEnabled ? policy.marketingScopes(client, user(req)) : [],
    ]);
    ok(res, {
      mailEnabled: config.enabled,
      sendingEnabled: config.sendingEnabled,
      receivingEnabled: config.receivingEnabled,
      marketingEnabled: config.marketingEnabled,
      identityActive: true,
      mailboxes,
      canManageDomains: canEditAdmin,
      canViewAdministration: canAdmin,
      canProvision: true,
      canApproveProvisioning: canEditAdmin,
      canManageSharedMembership: canEditAdmin || mailboxes.some((entry) => entry.type === "SHARED" && ["OWNER", "MANAGER"].includes(entry.role)),
      marketing: scopes.map(({ organizationId, slug, name, canAuthor, canApprove }) => ({ organizationId, slug, name, canAuthor, canApprove })),
    });
  }));
  router.get("/me/mailboxes", asyncHandler(async (req, res) => ok(res, await mailbox.listMyMailboxes(user(req)))));

  // --------------------------------------------------------------- mailboxes / threads
  router.get("/mailboxes/:mailboxId", asyncHandler(async (req, res) => ok(res, await mailbox.getMailbox(user(req), req.params.mailboxId))));
  router.get("/mailboxes/:mailboxId/threads", asyncHandler(async (req, res) => page(res, await mailbox.listThreads(user(req), req.params.mailboxId, req.query))));
  router.post("/mailboxes/:mailboxId/threads/bulk", asyncHandler(async (req, res) => ok(res, await mailbox.bulk(user(req), req.params.mailboxId, body(req), ctx(req)))));
  router.get("/mailboxes/:mailboxId/labels", asyncHandler(async (req, res) => ok(res, await mailbox.listLabels(user(req), req.params.mailboxId))));
  router.post("/mailboxes/:mailboxId/labels", asyncHandler(async (req, res) => ok(res, await mailbox.createLabel(user(req), req.params.mailboxId, body(req)), { status: 201 })));
  router.get("/mailboxes/:mailboxId/search", asyncHandler(async (req, res) => page(res, await mailbox.search(user(req), { ...req.query, mailboxId: req.params.mailboxId }))));
  router.get("/search", asyncHandler(async (req, res) => page(res, await mailbox.search(user(req), { ...req.query, mailboxId: undefined }))));
  router.get("/contacts/suggest", asyncHandler(async (req, res) => ok(res, await mailbox.suggestContacts(user(req), req.query.q))));

  router.get("/threads/:threadId", asyncHandler(async (req, res) => ok(res, await mailbox.getThread(user(req), req.params.threadId))));
  router.get("/threads/:threadId/messages", asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    ok(res, await mailbox.getMessages(user(req), req.params.threadId, { remoteImages: req.query.remoteImages === "allow" ? "allow" : "block" }, ctx(req)));
  }));
  router.patch("/threads/:threadId/state", asyncHandler(async (req, res) => ok(res, await mailbox.setThreadState(user(req), req.params.threadId, body(req)))));
  router.post("/threads/:threadId/move", asyncHandler(async (req, res) => ok(res, await mailbox.moveThread(user(req), req.params.threadId, body(req).folder, ctx(req)))));
  router.delete("/threads/:threadId", asyncHandler(async (req, res) => ok(res, await mailbox.deleteThread(user(req), req.params.threadId, ctx(req)))));
  router.put("/threads/:threadId/labels/:labelId", asyncHandler(async (req, res) => ok(res, await mailbox.setThreadLabel(user(req), req.params.threadId, req.params.labelId, true))));
  router.delete("/threads/:threadId/labels/:labelId", asyncHandler(async (req, res) => ok(res, await mailbox.setThreadLabel(user(req), req.params.threadId, req.params.labelId, false))));

  // --------------------------------------------------------------- drafts / send
  router.get("/mailboxes/:mailboxId/drafts", asyncHandler(async (req, res) => ok(res, await compose.listDrafts(user(req), req.params.mailboxId))));
  router.post("/mailboxes/:mailboxId/drafts", asyncHandler(async (req, res) => ok(res, await compose.createDraft(user(req), req.params.mailboxId, body(req)), { status: 201 })));
  router.get("/drafts/:draftId", asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    ok(res, await compose.getDraft(user(req), req.params.draftId));
  }));
  router.patch("/drafts/:draftId", asyncHandler(async (req, res) => ok(res, await compose.updateDraft(user(req), req.params.draftId, body(req)))));
  router.delete("/drafts/:draftId", asyncHandler(async (req, res) => ok(res, await compose.discardDraft(user(req), req.params.draftId))));
  router.post("/drafts/:draftId/attachments", uploadErrors(attachmentUpload.single("file")), asyncHandler(async (req, res) => ok(res, await compose.addAttachment(user(req), req.params.draftId, req.file), { status: 201 })));
  router.delete("/drafts/:draftId/attachments/:attachmentId", asyncHandler(async (req, res) => ok(res, await compose.removeAttachment(user(req), req.params.draftId, req.params.attachmentId))));
  router.post("/drafts/:draftId/send", asyncHandler(async (req, res) => {
    const result = await compose.sendDraft(user(req), req.params.draftId, { revision: body(req).revision, idempotencyKey: req.get("Idempotency-Key") }, ctx(req));
    ok(res, result, { status: 202, message: result.status === "QUEUED" ? "Queued for sending" : "Delivered internally" });
  }));
  router.get("/messages/:messageId/status", asyncHandler(async (req, res) => ok(res, await compose.messageStatus(user(req), req.params.messageId))));
  router.get("/attachments/:attachmentId/download", asyncHandler(async (req, res) => {
    const { attachment, content } = await compose.downloadAttachment(user(req), req.params.attachmentId, ctx(req));
    const safeName = attachment.filename.replace(/[^A-Za-z0-9._ -]/g, "_");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.status(200).send(content);
  }));

  // --------------------------------------------------------------- shared / support
  router.get("/support/mailboxes", asyncHandler(async (req, res) => ok(res, await support.supportMailboxes(user(req)))));
  router.get("/mailboxes/:mailboxId/queue", asyncHandler(async (req, res) => page(res, await support.queue(user(req), req.params.mailboxId, req.query))));
  router.post("/threads/:threadId/assign", asyncHandler(async (req, res) => ok(res, await support.assign(user(req), req.params.threadId, body(req), ctx(req)))));
  router.post("/threads/:threadId/status", asyncHandler(async (req, res) => ok(res, await support.setStatus(user(req), req.params.threadId, body(req), ctx(req)))));
  router.post("/threads/:threadId/lock", asyncHandler(async (req, res) => ok(res, await support.lock(user(req), req.params.threadId, ctx(req)))));
  router.delete("/threads/:threadId/lock", asyncHandler(async (req, res) => ok(res, await support.unlock(user(req), req.params.threadId))));
  router.get("/threads/:threadId/notes", asyncHandler(async (req, res) => ok(res, await support.listNotes(user(req), req.params.threadId))));
  router.post("/threads/:threadId/notes", asyncHandler(async (req, res) => ok(res, await support.addNote(user(req), req.params.threadId, body(req), ctx(req)), { status: 201 })));
  router.put("/threads/:threadId/ticket-link", asyncHandler(async (req, res) => ok(res, await support.setTicketLink(user(req), req.params.threadId, body(req), ctx(req)))));
  router.get("/threads/:threadId/activity", asyncHandler(async (req, res) => ok(res, await support.activity(user(req), req.params.threadId))));
  router.get("/directory/staff", asyncHandler(async (req, res) => ok(res, await admin.staffDirectory(user(req), req.query.q))));
  router.get("/mailboxes/:mailboxId/members", asyncHandler(async (req, res) => ok(res, await admin.listMembers(user(req), req.params.mailboxId))));
  router.post("/mailboxes/:mailboxId/members", asyncHandler(async (req, res) => ok(res, await admin.addMember(user(req), req.params.mailboxId, body(req), ctx(req)), { status: 201 })));
  router.delete("/mailboxes/:mailboxId/members/:membershipId", asyncHandler(async (req, res) => ok(res, await admin.revokeMember(user(req), req.params.mailboxId, req.params.membershipId, ctx(req)))));
  router.patch("/mailboxes/:mailboxId/settings", asyncHandler(async (req, res) => ok(res, await admin.updateMailboxSettings(user(req), req.params.mailboxId, body(req), ctx(req)))));

  // --------------------------------------------------------------- administration
  router.get("/admin/status", asyncHandler(async (req, res) => {
    await policy.requireMailAdmin(mail.client, user(req), "VIEW");
    ok(res, { ...publicStatus(config), health: await mail.health() });
  }));
  router.post("/admin/attachments/:attachmentId/rescan", asyncHandler(async (req, res) => ok(res, await mail.services.attachmentReview.rescanAttachment(user(req), req.params.attachmentId, ctx(req)))));
  router.get("/admin/organizations", asyncHandler(async (req, res) => ok(res, await admin.listOrganizations(user(req)))));
  router.post("/admin/organizations", asyncHandler(async (req, res) => ok(res, await admin.createOrganization(user(req), body(req), ctx(req)), { status: 201 })));
  router.get("/admin/domains", asyncHandler(async (req, res) => ok(res, await admin.listDomains(user(req)))));
  router.post("/admin/domains", asyncHandler(async (req, res) => ok(res, await admin.createDomain(user(req), body(req), ctx(req)), { status: 201 })));
  router.post("/admin/domains/:domainId/verify", asyncHandler(async (req, res) => ok(res, await admin.verifyDomain(user(req), req.params.domainId, ctx(req)))));
  router.get("/admin/addresses", asyncHandler(async (req, res) => ok(res, await admin.listAddresses(user(req), req.query))));
  router.post("/admin/addresses", asyncHandler(async (req, res) => ok(res, await admin.createAddress(user(req), body(req), ctx(req)), { status: 201 })));
  router.patch("/admin/addresses/:addressId", asyncHandler(async (req, res) => ok(res, await admin.updateAddressStatus(user(req), req.params.addressId, body(req), ctx(req)))));
  router.get("/admin/mailboxes", asyncHandler(async (req, res) => ok(res, await admin.listMailboxes(user(req), req.query))));
  router.post("/admin/mailboxes", asyncHandler(async (req, res) => ok(res, await admin.createMailbox(user(req), body(req), ctx(req)), { status: 201 })));
  router.post("/admin/mailboxes/:mailboxId/suspend", asyncHandler(async (req, res) => ok(res, await admin.setMailboxStatus(user(req), req.params.mailboxId, "SUSPENDED", ctx(req)))));
  router.post("/admin/mailboxes/:mailboxId/reactivate", asyncHandler(async (req, res) => ok(res, await admin.setMailboxStatus(user(req), req.params.mailboxId, "ACTIVE", ctx(req)))));
  router.post("/admin/users/:adminUserId/offboard", asyncHandler(async (req, res) => ok(res, await admin.offboardUser(user(req), req.params.adminUserId, ctx(req)))));
  router.post("/admin/sender-grants", asyncHandler(async (req, res) => ok(res, await admin.grantSender(user(req), body(req), ctx(req)), { status: 201 })));
  router.delete("/admin/sender-grants/:grantId", asyncHandler(async (req, res) => ok(res, await admin.revokeSender(user(req), req.params.grantId, ctx(req)))));
  router.get("/provisioning/requests", asyncHandler(async (req, res) => ok(res, await admin.listProvisionRequests(user(req)))));
  router.post("/provisioning/requests", asyncHandler(async (req, res) => ok(res, await admin.createProvisionRequest(user(req), body(req), ctx(req)), { status: 201 })));
  router.post("/provisioning/requests/:requestId/approve", asyncHandler(async (req, res) => ok(res, await admin.decideProvisionRequest(user(req), req.params.requestId, { approve: true, note: body(req).note }, ctx(req)))));
  router.post("/provisioning/requests/:requestId/reject", asyncHandler(async (req, res) => ok(res, await admin.decideProvisionRequest(user(req), req.params.requestId, { approve: false, note: body(req).note }, ctx(req)))));
  router.get("/admin/legal-holds", asyncHandler(async (req, res) => ok(res, await admin.listLegalHolds(user(req)))));
  router.post("/admin/legal-holds", asyncHandler(async (req, res) => ok(res, await admin.createLegalHold(user(req), body(req), ctx(req)), { status: 201 })));
  router.post("/admin/legal-holds/:holdId/release", asyncHandler(async (req, res) => ok(res, await admin.releaseLegalHold(user(req), req.params.holdId, ctx(req)))));
  // ---- M8: product integrations (HQ administration; service ingestion is a raw-body route in app.js)
  router.get("/admin/integrations", asyncHandler(async (req, res) => ok(res, await integrations.list(user(req)))));
  router.post("/admin/integrations", asyncHandler(async (req, res) => ok(res, await integrations.create(user(req), body(req), ctx(req)), { status: 201 })));
  router.patch("/admin/integrations/:integrationId", asyncHandler(async (req, res) => ok(res, await integrations.update(user(req), req.params.integrationId, body(req), ctx(req)))));
  router.post("/admin/integrations/:integrationId/activate", asyncHandler(async (req, res) => ok(res, await integrations.activate(user(req), req.params.integrationId, body(req), ctx(req)))));
  router.post("/admin/integrations/:integrationId/suspend", asyncHandler(async (req, res) => ok(res, await integrations.suspend(user(req), req.params.integrationId, body(req), ctx(req)))));
  router.get("/admin/integrations/:integrationId/health", asyncHandler(async (req, res) => ok(res, await integrations.health(user(req), req.params.integrationId))));
  router.get("/admin/integrations/:integrationId/events", asyncHandler(async (req, res) => ok(res, await integrations.events(user(req), req.params.integrationId, req.query))));
  router.get("/admin/integrations/:integrationId/senders", asyncHandler(async (req, res) => ok(res, await integrations.listSenders(user(req), req.params.integrationId))));
  router.post("/admin/integrations/:integrationId/senders", asyncHandler(async (req, res) => ok(res, await integrations.authorizeSender(user(req), req.params.integrationId, body(req), ctx(req)), { status: 201 })));
  router.delete("/admin/integrations/:integrationId/senders/:senderId", asyncHandler(async (req, res) => ok(res, await integrations.revokeSender(user(req), req.params.integrationId, req.params.senderId, ctx(req)))));
  router.get("/admin/retention-policies", asyncHandler(async (req, res) => ok(res, await admin.listRetentionPolicies(user(req)))));
  router.post("/admin/retention-policies", asyncHandler(async (req, res) => ok(res, await admin.createRetentionPolicy(user(req), body(req), ctx(req)), { status: 201 })));

  // --------------------------------------------------------------- step-up / break-glass
  router.post("/security/step-up", asyncHandler(async (req, res) => ok(res, await stepUp.verify(user(req), body(req), ctx(req)), { status: 201 })));
  router.get("/break-glass/requests", asyncHandler(async (req, res) => ok(res, await breakGlass.list(user(req)))));
  router.post("/break-glass/requests", asyncHandler(async (req, res) => ok(res, await breakGlass.request(user(req), body(req), ctx(req)), { status: 201 })));
  router.post("/break-glass/requests/:requestId/approve", asyncHandler(async (req, res) => ok(res, await breakGlass.decide(user(req), req.params.requestId, { ...body(req), approve: true }, ctx(req)))));
  router.post("/break-glass/requests/:requestId/reject", asyncHandler(async (req, res) => ok(res, await breakGlass.decide(user(req), req.params.requestId, { ...body(req), approve: false }, ctx(req)))));
  router.post("/break-glass/requests/:requestId/revoke", asyncHandler(async (req, res) => ok(res, await breakGlass.revoke(user(req), req.params.requestId, ctx(req)))));

  // --------------------------------------------------------------- marketing
  const m = express.Router({ mergeParams: true });
  m.get("/organizations", asyncHandler(async (req, res) => ok(res, await marketing.organizations(user(req)))));
  m.get("/:orgId/sender-identities", asyncHandler(async (req, res) => ok(res, await marketing.senderIdentities(user(req), req.params.orgId))));
  m.get("/:orgId/contacts", asyncHandler(async (req, res) => page(res, await marketing.listContacts(user(req), req.params.orgId, req.query))));
  m.post("/:orgId/contacts", asyncHandler(async (req, res) => ok(res, await marketing.createContact(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.post("/:orgId/contacts/import", uploadErrors(csvUpload.single("file")), asyncHandler(async (req, res) => ok(res, await marketing.importCsv(user(req), req.params.orgId, { ...body(req), buffer: req.file?.buffer }, ctx(req)))));
  m.get("/:orgId/contacts/:contactId", asyncHandler(async (req, res) => ok(res, await marketing.getContact(user(req), req.params.orgId, req.params.contactId))));
  m.patch("/:orgId/contacts/:contactId", asyncHandler(async (req, res) => ok(res, await marketing.updateContact(user(req), req.params.orgId, req.params.contactId, body(req), ctx(req)))));
  m.post("/:orgId/contacts/:contactId/consents", asyncHandler(async (req, res) => ok(res, await marketing.recordConsent(user(req), req.params.orgId, req.params.contactId, body(req), ctx(req)), { status: 201 })));
  m.post("/:orgId/contacts/:contactId/consents/:topic/withdraw", asyncHandler(async (req, res) => ok(res, await marketing.withdrawConsent(user(req), req.params.orgId, req.params.contactId, req.params.topic, body(req), ctx(req)))));
  m.get("/:orgId/suppressions", asyncHandler(async (req, res) => ok(res, await marketing.listSuppressions(user(req), req.params.orgId))));
  m.post("/:orgId/suppressions", asyncHandler(async (req, res) => ok(res, await marketing.createSuppression(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.post("/:orgId/suppressions/:suppressionId/lift", asyncHandler(async (req, res) => ok(res, await marketing.liftSuppression(user(req), req.params.orgId, req.params.suppressionId, ctx(req)))));
  m.get("/:orgId/audiences", asyncHandler(async (req, res) => ok(res, await marketing.listAudiences(user(req), req.params.orgId))));
  m.post("/:orgId/audiences", asyncHandler(async (req, res) => ok(res, await marketing.createAudience(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.get("/:orgId/audiences/:audienceId", asyncHandler(async (req, res) => ok(res, await marketing.getAudience(user(req), req.params.orgId, req.params.audienceId))));
  m.patch("/:orgId/audiences/:audienceId", asyncHandler(async (req, res) => ok(res, await marketing.updateAudience(user(req), req.params.orgId, req.params.audienceId, body(req), ctx(req)))));
  m.post("/:orgId/audiences/:audienceId/contacts", asyncHandler(async (req, res) => ok(res, await marketing.changeAudienceMembers(user(req), req.params.orgId, req.params.audienceId, body(req), true, ctx(req)))));
  m.delete("/:orgId/audiences/:audienceId/contacts", asyncHandler(async (req, res) => ok(res, await marketing.changeAudienceMembers(user(req), req.params.orgId, req.params.audienceId, body(req), false, ctx(req)))));
  m.get("/:orgId/audiences/:audienceId/segments", asyncHandler(async (req, res) => ok(res, await marketing.listSegments(user(req), req.params.orgId, req.params.audienceId))));
  m.post("/:orgId/audiences/:audienceId/segments", asyncHandler(async (req, res) => ok(res, await marketing.createSegment(user(req), req.params.orgId, req.params.audienceId, body(req), ctx(req)), { status: 201 })));
  m.get("/:orgId/segments/:segmentId/preview", asyncHandler(async (req, res) => ok(res, await marketing.previewSegment(user(req), req.params.orgId, req.params.segmentId))));
  m.get("/:orgId/templates", asyncHandler(async (req, res) => ok(res, await marketing.listTemplates(user(req), req.params.orgId))));
  m.post("/:orgId/templates", asyncHandler(async (req, res) => ok(res, await marketing.createTemplate(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.post("/:orgId/templates/render", asyncHandler(async (req, res) => ok(res, await marketing.renderPreview(user(req), req.params.orgId, body(req)))));
  m.get("/:orgId/legacy-templates", asyncHandler(async (req, res) => ok(res, await marketing.legacyTemplates(user(req), req.params.orgId))));
  m.get("/:orgId/templates/:templateId", asyncHandler(async (req, res) => ok(res, await marketing.getTemplate(user(req), req.params.orgId, req.params.templateId))));
  m.post("/:orgId/templates/:templateId/versions", asyncHandler(async (req, res) => ok(res, await marketing.createTemplateVersion(user(req), req.params.orgId, req.params.templateId, body(req), ctx(req)), { status: 201 })));
  m.get("/:orgId/campaigns", asyncHandler(async (req, res) => ok(res, await marketing.listCampaigns(user(req), req.params.orgId, req.query))));
  m.post("/:orgId/campaigns", asyncHandler(async (req, res) => ok(res, await marketing.createCampaign(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.get("/:orgId/campaigns/:campaignId", asyncHandler(async (req, res) => ok(res, await marketing.getCampaign(user(req), req.params.orgId, req.params.campaignId))));
  m.patch("/:orgId/campaigns/:campaignId", asyncHandler(async (req, res) => ok(res, await marketing.updateCampaign(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/preflight", asyncHandler(async (req, res) => ok(res, await marketing.runPreflight(user(req), req.params.orgId, req.params.campaignId))));
  m.post("/:orgId/campaigns/:campaignId/submit", asyncHandler(async (req, res) => ok(res, await marketing.submit(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/approve", asyncHandler(async (req, res) => ok(res, await marketing.approve(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/reject", asyncHandler(async (req, res) => ok(res, await marketing.reject(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)))));
  m.get("/:orgId/campaigns/:campaignId/history", asyncHandler(async (req, res) => ok(res, await marketing.history(user(req), req.params.orgId, req.params.campaignId))));
  m.get("/:orgId/campaigns/:campaignId/snapshots/:snapshotId", asyncHandler(async (req, res) => ok(res, await marketing.snapshot(user(req), req.params.orgId, req.params.campaignId, req.params.snapshotId))));
  // ---- M7: brand controls, broadcasts, reporting -------------------------
  m.get("/:orgId/settings", asyncHandler(async (req, res) => ok(res, await broadcasts.getBrandSettings(user(req), req.params.orgId))));
  m.patch("/:orgId/settings", asyncHandler(async (req, res) => ok(res, await broadcasts.updateBrandSettings(user(req), req.params.orgId, body(req), ctx(req)))));
  m.post("/:orgId/dispatch/pause", asyncHandler(async (req, res) => ok(res, await broadcasts.pauseBrand(user(req), req.params.orgId, body(req), ctx(req)))));
  m.post("/:orgId/dispatch/resume", asyncHandler(async (req, res) => ok(res, await broadcasts.resumeBrand(user(req), req.params.orgId, body(req), ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/schedule", asyncHandler(async (req, res) => ok(res, await broadcasts.schedule(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)), { status: 201 })));
  m.post("/:orgId/campaigns/:campaignId/cancel", asyncHandler(async (req, res) => ok(res, await broadcasts.cancel(user(req), req.params.orgId, req.params.campaignId, body(req), ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/pause", asyncHandler(async (req, res) => ok(res, await broadcasts.pause(user(req), req.params.orgId, req.params.campaignId, ctx(req)))));
  m.post("/:orgId/campaigns/:campaignId/resume", asyncHandler(async (req, res) => ok(res, await broadcasts.resume(user(req), req.params.orgId, req.params.campaignId, ctx(req)))));
  m.get("/:orgId/campaigns/:campaignId/dispatch", asyncHandler(async (req, res) => ok(res, await broadcasts.getDispatch(user(req), req.params.orgId, req.params.campaignId))));
  m.get("/:orgId/campaigns/:campaignId/report", asyncHandler(async (req, res) => ok(res, await broadcasts.report(user(req), req.params.orgId, req.params.campaignId))));
  m.get("/:orgId/campaigns/:campaignId/recipients", asyncHandler(async (req, res) => page(res, await broadcasts.listRecipients(user(req), req.params.orgId, req.params.campaignId, req.query))));
  m.get("/:orgId/reports/overview", asyncHandler(async (req, res) => ok(res, await broadcasts.overview(user(req), req.params.orgId))));
  m.get("/:orgId/reports/suppressions", asyncHandler(async (req, res) => ok(res, await broadcasts.suppressionReport(user(req), req.params.orgId, req.query))));
  // ---- M7: automations ----------------------------------------------------
  m.get("/:orgId/automation-events", asyncHandler(async (req, res) => {
    await policy.requireMarketingScope(mail.client, user(req), req.params.orgId, "VIEW");
    const { APPROVED_PRODUCT_EVENTS } = require("../marketing/automation/event-registry");
    ok(res, Object.entries(APPROVED_PRODUCT_EVENTS).map(([eventType, entry]) => ({ eventType, versions: entry.versions, product: entry.product, fields: Object.keys(entry.fields) })));
  }));
  m.get("/:orgId/automations", asyncHandler(async (req, res) => ok(res, await automations.list(user(req), req.params.orgId))));
  m.post("/:orgId/automations", asyncHandler(async (req, res) => ok(res, await automations.create(user(req), req.params.orgId, body(req), ctx(req)), { status: 201 })));
  m.get("/:orgId/automations/:automationId", asyncHandler(async (req, res) => ok(res, await automations.get(user(req), req.params.orgId, req.params.automationId))));
  m.put("/:orgId/automations/:automationId/draft", asyncHandler(async (req, res) => ok(res, await automations.saveDraft(user(req), req.params.orgId, req.params.automationId, body(req), ctx(req)))));
  m.post("/:orgId/automations/:automationId/versions/:versionId/submit", asyncHandler(async (req, res) => ok(res, await automations.submit(user(req), req.params.orgId, req.params.automationId, req.params.versionId, ctx(req)))));
  m.post("/:orgId/automations/:automationId/versions/:versionId/approve", asyncHandler(async (req, res) => ok(res, await automations.approve(user(req), req.params.orgId, req.params.automationId, req.params.versionId, body(req), ctx(req)))));
  m.post("/:orgId/automations/:automationId/versions/:versionId/reject", asyncHandler(async (req, res) => ok(res, await automations.reject(user(req), req.params.orgId, req.params.automationId, req.params.versionId, body(req), ctx(req)))));
  m.post("/:orgId/automations/:automationId/activate", asyncHandler(async (req, res) => ok(res, await automations.activate(user(req), req.params.orgId, req.params.automationId, ctx(req)))));
  m.post("/:orgId/automations/:automationId/pause", asyncHandler(async (req, res) => ok(res, await automations.pause(user(req), req.params.orgId, req.params.automationId, ctx(req)))));
  m.post("/:orgId/automations/:automationId/archive", asyncHandler(async (req, res) => ok(res, await automations.archive(user(req), req.params.orgId, req.params.automationId, ctx(req)))));
  m.get("/:orgId/automations/:automationId/enrollments", asyncHandler(async (req, res) => page(res, await automations.enrollments(user(req), req.params.orgId, req.params.automationId, req.query))));
  m.get("/:orgId/automations/:automationId/history", asyncHandler(async (req, res) => ok(res, await automations.history(user(req), req.params.orgId, req.params.automationId, req.query.enrollmentId))));
  router.use("/marketing", m);

  return router;
}

module.exports = { createMailRouter };

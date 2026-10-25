#!/usr/bin/env node
"use strict";

// CosmicForge Mail canary.
//
//   simulate (default, offline): builds a disposable replay database, runs the
//     real Mail application against it with the FAKE provider and in-memory
//     storage, and exercises the pilot path end to end: rollout enforcement,
//     cohort onboarding, a canary send, worker dispatch, a database emergency
//     stop holding queued mail, release, and the ops snapshot/alerts. Nothing
//     leaves the machine. Prints a JSON report; exit 1 on failure.
//
//   live (operator-invoked, NEVER run by automation): sends ONE canary email
//     through a deployed HQ API from an already-provisioned canary mailbox to
//     an operator-owned seed address, then polls its delivery status. It only
//     prints the plan unless both --execute and --confirm-live=<environment>
//     are given, and refuses production without --allow-production.
//       HQ_API_TOKEN=... node scripts/mail/canary.js live \
//         --api=https://admin-api.staging.example --environment=staging \
//         --mailbox=<uuid> --to=seed@ops.example [--execute --confirm-live=staging]

const crypto = require("crypto");

function args(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] === undefined ? true : match[2];
    else out._.push(arg);
  }
  return out;
}

async function simulate() {
  // Synthetic key for this offline run only (shared by seeding and the app).
  process.env.AUTH_MFA_ENCRYPTION_KEYS = process.env.AUTH_MFA_ENCRYPTION_KEYS || `canary:${crypto.randomBytes(32).toString("base64")}`;
  const { PrismaClient } = require("../../src/generated/admin-client");
  const { PrismaPg } = require("@prisma/adapter-pg");
  const { replayVerify, dropDatabase } = require("../social-operations/db-replay-verify");
  const { createMailApplication } = require("../../src/modules/mail/application");
  const { loadMailConfig } = require("../../src/modules/mail/mail.config");
  const { createFakeAdapter } = require("../../src/modules/mail/adapters/fake.adapter");
  const { memoryBackend } = require("../../src/modules/mail/storage/mail-storage");
  const { signatureScanner } = require("../../src/modules/mail/scanning/attachment-scanner");
  const { encryptSecret, decodeBase32, totpAt } = require("../../src/shared/auth/mfa-core");

  const steps = [];
  const check = (name, pass, detail = null) => {
    steps.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
    if (!pass) throw Object.assign(new Error(`canary step failed: ${name}`), { steps });
  };
  const replay = await replayVerify({ keep: true });
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: replay.replayUrl }) });
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const env = {
    NODE_ENV: "test", MAIL_DEPLOYMENT_ENV: "test", MAIL_ENABLED: "true", MAIL_SENDING_ENABLED: "true", MAIL_RECEIVING_ENABLED: "true", MAIL_WORKER_ENABLED: "true",
    MAIL_PROVIDER: "fake", MAIL_ENCRYPTION_KEYS: `v1:${crypto.randomBytes(32).toString("base64")}`, MAIL_DOMAIN_ALLOWLIST: "canary.example",
    MAIL_ROLLOUT_ENFORCED: "true", AUTH_MFA_ENCRYPTION_KEYS: process.env.AUTH_MFA_ENCRYPTION_KEYS,
  };
  const mail = createMailApplication({ client, env, config: loadMailConfig(env), adapter: createFakeAdapter(), storageBackend: memoryBackend(), scanner: signatureScanner(), logger: { info() {}, warn() {}, error() {} }, clock });
  const worker = mail.createWorker({ queues: ["OUTBOUND", "EVENTS"] });
  const drain = async () => {
    offset += 6000;
    await worker.drain({ maxTicks: 20 });
  };
  try {
    // Operator and pilot user (synthetic, test-only identities).
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const operator = await client.adminUser.create({ data: { id: crypto.randomUUID(), email: "operator@canary.invalid", password: "x", name: "Canary operator", tier: "ADMIN", status: "ACTIVE", mustChangePassword: false } });
    const pilot = await client.adminUser.create({ data: { id: crypto.randomUUID(), email: "pilot@canary.invalid", password: "x", name: "Canary pilot", tier: "EMPLOYEE", status: "ACTIVE", mustChangePassword: false } });
    await client.adminSectionGrant.create({ data: { adminUserId: operator.id, module: "mail", section: "admin", mode: "EDIT", grantedBy: operator.id } });
    await client.adminMfaEnrollment.create({ data: { adminUserId: operator.id, enrolledAt: new Date(Date.now() - 86400000), secretEncrypted: encryptSecret(decodeBase32(secret), operator.id), updatedAt: new Date() } });
    const session = await client.adminSession.create({ data: { id: crypto.randomUUID(), adminUserId: operator.id, mode: "dual", authMethod: "PASSWORD", csrfNonce: "n", idleExpiresAt: new Date(Date.now() + 86400000), absoluteExpiresAt: new Date(Date.now() + 86400000) } });
    const context = { sessionId: session.id };
    const op = { ...operator, isTeamLead: false };
    const stepUp = async (purpose) => {
      offset += 31000;
      return (await mail.services.stepUp.verify(op, { code: totpAt(decodeBase32(secret), Math.floor(clock().getTime() / 30000)), purpose }, context)).stepUpId;
    };
    const org = await client.mailOrganization.create({ data: { slug: "canary", name: "Canary", kind: "BRAND", createdBy: operator.id } });
    const domain = await client.mailDomain.create({ data: { organizationId: org.id, domain: "canary.example", status: "VERIFIED", sendingStatus: "VERIFIED", receivingStatus: "VERIFIED", verifiedAt: new Date() } });
    const mailbox = await mail.services.admin.createMailbox(op, { organizationId: org.id, type: "PERSONAL", ownerAdminUserId: pilot.id, address: { domainId: domain.id, localPart: "pilot" } }, context);
    const pilotUser = { ...pilot, isTeamLead: false };
    const trySend = async (to) => {
      const draft = await mail.services.compose.createDraft(pilotUser, mailbox.id, { to: [to], subject: "Canary", text: "canary" });
      return mail.services.compose.sendDraft(pilotUser, draft.id, { revision: draft.revision }, {});
    };

    const refused = await trySend("seed@ext.example").then(() => null, (error) => error.code);
    check("enforced rollout refuses a non-pilot send", refused === "MAIL_ROLLOUT_NOT_ENABLED", { refused });
    const cohort = await mail.services.rollout.createCohort(op, { key: "canary", name: "Canary cohort" }, context);
    await mail.services.rollout.addMember(op, cohort.id, { adminUserId: pilot.id }, context);
    await mail.services.rollout.createRule(op, { capability: "STAFF_MAIL", scopeType: "COHORT", scopeId: cohort.id, effect: "ALLOW", reason: "canary simulation", stepUpId: await stepUp("MAIL_ROLLOUT_CHANGE") }, context);
    for (const capability of ["WORKER_OUTBOUND", "WORKER_EVENTS"]) await mail.services.rollout.createRule(op, { capability, scopeType: "ENVIRONMENT", effect: "ALLOW", reason: "canary simulation", stepUpId: await stepUp("MAIL_ROLLOUT_CHANGE") }, context);
    const pilotStatus = await mail.services.rollout.pilotStatus(op, pilot.id);
    check("pilot onboarding checklist", pilotStatus.decisions.STAFF_MAIL === "ALLOWED" && pilotStatus.cohorts.includes("canary"), pilotStatus);

    const sent = await trySend("seed@ext.example");
    await drain();
    const accepted = await client.mailMessageRecipient.findFirst({ where: { messageId: sent.messageId } });
    check("canary send handed to the (fake) provider", accepted.status === "PROVIDER_ACCEPTED", { status: accepted.status });

    const stop = await mail.services.rollout.activateStop(op, { scope: "ALL", reason: "canary emergency stop drill" }, context);
    const held = await trySend("held@ext.example").then(() => "SENT", (error) => error.code);
    check("emergency stop refuses new sends immediately", held === "MAIL_EMERGENCY_STOP", { held });
    const releasedStop = await mail.services.rollout.releaseStop(op, stop.id, { stepUpId: await stepUp("MAIL_EMERGENCY_STOP_RELEASE") }, context);
    check("emergency stop released with step-up", Boolean(releasedStop.releasedAt));
    const after = await trySend("after@ext.example");
    await drain();
    check("sending resumes after release", (await client.mailMessageRecipient.findFirst({ where: { messageId: after.messageId } })).status === "PROVIDER_ACCEPTED");

    const snapshot = await mail.services.ops.snapshot();
    check("ops snapshot shows no halt and no dead letters", !snapshot.runtimeHalt.staffMail && snapshot.queue.deadLetters24h.length === 0, { active: snapshot.queue.active });
    const metrics = await mail.services.ops.prometheus();
    check("metrics contain counts only", /cf_mail_jobs/.test(metrics) && !/@/.test(metrics));
    const readiness = await mail.services.readiness.evaluate();
    const pilotStage = readiness.stages.find((stage) => stage.id === "S1_PILOT");
    check("pilot stage cohort gates pass", ["enforced", "cohort", "cohort-rule"].every((id) => pilotStage.gates.find((g) => g.id === id).status === "PASS"));
    return { ok: true, mode: "simulate", provider: "fake (offline)", steps };
  } finally {
    await client.$disconnect().catch(() => {});
    await dropDatabase(process.env.DATABASE_URL, replay.databaseName).catch(() => {});
  }
}

async function live(options) {
  const environment = String(options.environment || "");
  const plan = {
    mode: "live",
    environment,
    api: options.api || null,
    mailbox: options.mailbox || null,
    to: options.to || null,
    steps: ["POST /api/mail/v1/mailboxes/{mailbox}/drafts", "POST /api/mail/v1/drafts/{id}/send (Idempotency-Key)", "GET /api/mail/v1/threads/{threadId}/messages until a delivery status is recorded (max 10 min)"],
    preconditions: [
      "Rollout stage S1 automated gates pass (GET /admin/rollout/readiness)",
      "Canary mailbox owner is in a pilot cohort",
      "Seed address is owned by the operator team",
      "Change ticket approved for a live send in this environment",
    ],
  };
  if (!options.execute || options["confirm-live"] !== environment || !environment) return { ...plan, executed: false, note: "Plan only. Re-run with --execute --confirm-live=<environment> to send one live canary." };
  if (environment === "production" && !options["allow-production"]) throw new Error("Refusing a production live canary without --allow-production");
  if (!options.api || !options.mailbox || !options.to) throw new Error("--api, --mailbox and --to are required");
  const token = process.env.HQ_API_TOKEN;
  if (!token) throw new Error("HQ_API_TOKEN is required (never pass tokens on the command line)");
  const base = `${String(options.api).replace(/\/+$/, "")}/api/mail/v1`;
  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${json?.code || json?.message || ""}`);
    return json.data;
  };
  const marker = `canary-${new Date().toISOString().replace(/[:.]/g, "")}`;
  const draft = await request("POST", `/mailboxes/${options.mailbox}/drafts`, { to: [options.to], subject: `[HQ Mail canary] ${marker}`, text: `HQ Mail canary ${marker}. No action needed.` });
  const sent = await request("POST", `/drafts/${draft.id}/send`, { revision: draft.revision }, { "Idempotency-Key": marker });
  const deadline = Date.now() + 10 * 60 * 1000;
  let status = sent.status;
  while (Date.now() < deadline) {
    const messages = await request("GET", `/threads/${sent.threadId}/messages`);
    const message = (Array.isArray(messages) ? messages : messages.items || []).find((entry) => entry.id === sent.messageId);
    status = message?.status || status;
    const recipient = message?.recipients?.find((entry) => entry.address === options.to);
    if (recipient && ["DELIVERED", "BOUNCED", "FAILED", "COMPLAINED"].includes(recipient.status)) return { ...plan, executed: true, marker, messageId: sent.messageId, status, recipientStatus: recipient.status, ok: recipient.status === "DELIVERED" };
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  return { ...plan, executed: true, marker, messageId: sent.messageId, status, ok: false, note: "No delivery evidence within 10 minutes; check provider dashboard before any resend." };
}

async function main() {
  const options = args(process.argv.slice(2));
  const mode = options._[0] || "simulate";
  const result = mode === "live" ? await live(options) : await simulate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`mail-canary failed: ${error.message}\n${error.steps ? JSON.stringify(error.steps, null, 2) : ""}\n`);
    process.exitCode = 1;
  });
}

module.exports = { live };

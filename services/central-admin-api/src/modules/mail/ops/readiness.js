"use strict";

// M10 progressive rollout criteria. Each stage lists automated gates (PASS /
// FAIL from live state) and MANUAL gates (human sign-offs this code cannot
// verify). A stage is "ready" only when every automated gate passes; manual
// gates are reported, never assumed. Thresholds reuse the M9 alert settings.

const { publicStatus } = require("../mail.config");

const STAGES = [
  { id: "S0_STAGING", label: "Stage 0: internal staging rehearsal" },
  { id: "S1_PILOT", label: "Stage 1: staff pilot cohort (one brand)" },
  { id: "S2_BRAND", label: "Stage 2: brand-wide staff mail" },
  { id: "S3_MARKETING", label: "Stage 3: marketing broadcasts and automation" },
  { id: "S4_PRODUCTS", label: "Stage 4: product integrations (owner-approved)" },
];

function createReadiness({ client, config, ops, health }) {
  async function evaluate() {
    const [snap, report, cohorts, rules, settings, integrations] = await Promise.all([
      ops.snapshot(),
      health().catch(() => ({})),
      client.mailRolloutCohort.findMany({ include: { members: { where: { removedAt: null }, select: { id: true } } } }),
      client.mailRolloutRule.findMany({ where: { environment: config.deploymentEnvironment, revokedAt: null } }),
      client.marketingBrandSettings.findMany({ select: { organizationId: true, postalAddress: true } }),
      client.mailProductIntegration.findMany({ select: { status: true, ownerApprovalReference: true } }),
    ]);
    const flags = publicStatus(config);
    const t = config.ops.thresholds;
    const critical = snap.openAlerts.filter((alert) => alert.severity === "critical");
    const staff = snap.delivery.staff24h;
    const staffTotal = ["PROVIDER_ACCEPTED", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED"].reduce((sum, key) => sum + (staff[key] || 0), 0);
    const bouncePct = staffTotal ? ((staff.BOUNCED || 0) * 100) / staffTotal : 0;
    const allow = (capability, scopeType) => rules.some((rule) => rule.capability === capability && rule.effect === "ALLOW" && (!scopeType || rule.scopeType === scopeType));
    const gate = (id, label, pass, detail = null) => ({ id, label, status: pass ? "PASS" : "FAIL", detail });
    const manual = (id, label) => ({ id, label, status: "MANUAL", detail: "Record the sign-off in the rollout ticket." });

    const gates = {
      S0_STAGING: [
        gate("infra", "No storage / key / scanner configuration violations", !(report.infrastructure?.violations || []).length, report.infrastructure?.violations || []),
        gate("encryption", "Encryption keyring available", report.encryption?.available === true),
        gate("storage", "Private storage healthy", report.storage?.ok === true, report.storage?.detail),
        gate("scanner", "Malware scanner healthy", report.scanner?.ok === true, report.scanner?.detail),
        gate("provider", "Provider configured", flags.providerConfigured === true),
        gate("webhooks", "Provider webhook secret configured", flags.webhookSecretConfigured === true),
        gate("alerts", "Ops alert evaluation enabled", flags.opsAlertsEnabled === true),
        gate("metrics", "Metrics endpoint configured", flags.metricsEndpointEnabled === true),
        manual("restore-drill", "Backup/restore drill passed on a disposable copy (mail:backup:verify)"),
        manual("rollback-drill", "Rollback drill passed on a disposable copy"),
        manual("runbooks", "On-call has reviewed the M9 runbooks"),
      ],
      S1_PILOT: [
        gate("no-critical", "No open critical alerts", critical.length === 0, critical.map((alert) => alert.code)),
        gate("enforced", "Rollout enforcement on", config.rollout.enforced === true),
        gate("cohort", "A pilot cohort with at least one member", cohorts.some((cohort) => cohort.members.length > 0)),
        gate("cohort-rule", "STAFF_MAIL allowed for a cohort (not environment-wide)", allow("STAFF_MAIL", "COHORT") && !allow("STAFF_MAIL", "ENVIRONMENT")),
        gate("workers", "Outbound, inbound and events workers allowed", ["WORKER_OUTBOUND", "WORKER_INBOUND", "WORKER_EVENTS"].every((capability) => !config.rollout.enforced || allow(capability))),
        gate("not-stopped", "No emergency stop active", !snap.runtimeHalt?.staffMail),
        manual("dns", "DNS coexistence checklist complete for the pilot domain (SPF/DKIM/DMARC, MX unchanged or approved)"),
        manual("pilot-briefing", "Pilot staff briefed; support contact published"),
      ],
      S2_BRAND: [
        gate("no-critical", "No open critical alerts", critical.length === 0),
        gate("bounce", `Staff bounce rate below ${t.bounceRatePercent}% over at least ${t.minSampleForRates} recipients (24h)`, staffTotal >= t.minSampleForRates && bouncePct < t.bounceRatePercent, { sample: staffTotal, bouncePercent: Math.round(bouncePct * 10) / 10 }),
        gate("unknown", "No unknown send outcomes in 24h", snap.delivery.outcomeUnknown24h === 0),
        gate("dead-letters", "No dead letters in 24h", snap.queue.deadLetters24h.length === 0),
        gate("scan-backlog", "Scan backlog under threshold", snap.scanning.oldestBacklogSeconds <= t.scanBacklogSeconds),
        manual("pilot-signoff", "Pilot sign-off by the brand owner after the agreed pilot period"),
      ],
      S3_MARKETING: [
        gate("dispatch-flag", "Broadcast dispatch flag on", flags.broadcastDispatchEnabled === true),
        gate("unsubscribe", "Unsubscribe links configured", flags.unsubscribeConfigured === true),
        gate("postal", "Every brand with marketing settings has a postal address", settings.length > 0 && settings.every((row) => Boolean(row.postalAddress))),
        gate("marketing-queue", "Marketing worker allowed", !config.rollout.enforced || allow("WORKER_MARKETING")),
        gate("no-marketing-stop", "No marketing emergency stop", !snap.runtimeHalt?.marketing),
        manual("consent-legal", "Legal sign-off on consent records and imported lists"),
        manual("dmarc", "Marketing sending domain passes DMARC alignment"),
      ],
      S4_PRODUCTS: [
        gate("integrations-flag", "Integration ingestion enabled", flags.integrationsEnabled === true && flags.integrationsConfigured === true),
        gate("owner-approved", "Every ACTIVE integration has an owner approval reference", integrations.every((row) => row.status !== "ACTIVE" || Boolean(row.ownerApprovalReference))),
        manual("product-test", "Product owner tested the outbox integration against a disposable HQ environment"),
      ],
    };
    return {
      environment: config.deploymentEnvironment,
      generatedAt: snap.generatedAt,
      stages: STAGES.map((stage) => ({ ...stage, gates: gates[stage.id], automatedReady: gates[stage.id].every((entry) => entry.status !== "FAIL"), manualPending: gates[stage.id].filter((entry) => entry.status === "MANUAL").length })),
    };
  }

  return { evaluate };
}

module.exports = { createReadiness, STAGES };

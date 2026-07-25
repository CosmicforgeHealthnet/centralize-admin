const { prisma } = require("../../../../shared/config/database");

const SEVERITY_RANK = { INFO: 1, WARNING: 2, CRITICAL: 3 };

function createAlertRepository({ prisma: db = prisma } = {}) {
  async function persist(candidate, { now = new Date(), cooldownMinutes = 180 } = {}) {
    const latest = await db.marketing_alerts.findFirst({ where: { conditionKey: candidate.conditionKey }, orderBy: [{ lifecycle: "desc" }, { createdAt: "desc" }] });
    const active = latest && ["OPEN", "ACKNOWLEDGED"].includes(latest.status);
    if (active) {
      const escalated = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[latest.severity];
      const shouldNotify = escalated || !latest.cooldownUntil || new Date(latest.cooldownUntil) <= now;
      const alert = await db.marketing_alerts.update({
        where: { id: latest.id },
        data: {
          severity: escalated ? candidate.severity : latest.severity,
          message: candidate.message,
          evidence: candidate.evidence,
          lastTriggeredAt: now,
          occurrenceCount: { increment: 1 },
          recoveryStreak: 0,
          deliveryFailure: null,
        },
      });
      return { alert, created: false, escalated, shouldNotify, cooldownMinutes };
    }
    const lifecycle = latest ? Number(latest.lifecycle || 1) + 1 : 1;
    const alert = await db.marketing_alerts.create({ data: {
      type: candidate.type,
      severity: candidate.severity,
      status: "OPEN",
      platform: candidate.platform,
      connectionId: candidate.connectionId,
      campaignExternalId: candidate.campaignExternalId,
      creativeAssetId: candidate.creativeAssetId,
      currencyCode: candidate.currencyCode,
      message: candidate.message,
      evidence: candidate.evidence,
      conditionKey: candidate.conditionKey,
      lifecycle,
      dedupeKey: `${candidate.conditionKey}:${lifecycle}`,
      triggeredAt: now,
      lastTriggeredAt: now,
      recoveryStreak: 0,
    } });
    return { alert, created: true, escalated: false, shouldNotify: true, cooldownMinutes };
  }

  async function markDelivery(alertId, { notificationId, cooldownMinutes, deliveredAt = new Date(), failure } = {}) {
    return db.marketing_alerts.update({ where: { id: alertId }, data: {
      ...(notificationId ? { notificationId, cooldownUntil: new Date(deliveredAt.getTime() + cooldownMinutes * 60000), deliveryFailure: null } : {}),
      ...(failure ? { deliveryFailure: String(failure).slice(0, 500) } : {}),
    } });
  }

  async function recoverAbsent({ activeConditionKeys, recoveryEvaluations, platform, connectionId, types, now = new Date() }) {
    const rows = await db.marketing_alerts.findMany({ where: {
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      ...(platform && platform !== "all" ? { platform } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(types?.length ? { type: { in: types } } : {}),
    } });
    const resolved = [];
    for (const row of rows) {
      if (activeConditionKeys.has(row.conditionKey)) continue;
      const recoveryStreak = Number(row.recoveryStreak || 0) + 1;
      const shouldResolve = recoveryStreak >= recoveryEvaluations;
      const updated = await db.marketing_alerts.update({ where: { id: row.id }, data: {
        recoveryStreak,
        ...(shouldResolve ? { status: "RESOLVED", resolvedAt: now, resolutionReason: "Condition recovered across consecutive evaluations" } : {}),
      } });
      if (shouldResolve) resolved.push(updated.id);
    }
    return resolved;
  }

  return { persist, markDelivery, recoverAbsent };
}

module.exports = { SEVERITY_RANK, createAlertRepository };

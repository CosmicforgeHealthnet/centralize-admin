const { stableHash } = require("../creative/creative.connector.interface");

function createRecommendationRepository({ prisma }) {
  const tagged = (row, persistenceAction) => {
    if (row && typeof row === "object") row.persistenceAction = persistenceAction;
    return row;
  };
  async function persist(candidate, { analysisStart, analysisEnd, expiresAt, now = new Date() }) {
    const existing = await prisma.marketing_recommendations.findUnique({ where: { dedupeKey: candidate.dedupeKey } });
    if (existing?.status === "PENDING") {
      const row = await prisma.marketing_recommendations.update({ where: { id: existing.id }, data: { evidence: candidate.evidence, confidence: candidate.confidence, reasoning: candidate.reasoning, suggestedAction: candidate.suggestedAction, materialEvidenceFingerprint: candidate.materialEvidenceFingerprint, generatedAt: now, lastEvaluatedAt: now, expiresAt, expirationReason: null, recoveryStreak: 0 } });
      return tagged(row, "UPDATED");
    }
    if (existing) {
      if (existing.materialEvidenceFingerprint === candidate.materialEvidenceFingerprint) return tagged(existing, "UNCHANGED");
      candidate = { ...candidate, dedupeKey: stableHash(`${candidate.dedupeKey}|${candidate.materialEvidenceFingerprint}`) };
      const reconsidered = await prisma.marketing_recommendations.findUnique({ where: { dedupeKey: candidate.dedupeKey } });
      if (reconsidered) return tagged(reconsidered, "UNCHANGED");
    }
    const row = await prisma.marketing_recommendations.create({ data: { ...candidate, status: "PENDING", analysisWindowStart: analysisStart, analysisWindowEnd: analysisEnd, generatedAt: now, lastEvaluatedAt: now, expiresAt } });
    return tagged(row, "CREATED");
  }

  async function expireUnseen({ activeKeys, platform, connectionId, now = new Date(), recoveryEvaluations = 2, staleDays = 14 }) {
    if (!prisma.marketing_recommendations.findMany || !prisma.marketing_recommendations.update) return { count: 0, expiredIds: [] };
    const rows = await prisma.marketing_recommendations.findMany({
      where: { status: "PENDING", ...(platform && platform !== "all" ? { platform } : {}), ...(connectionId ? { connectionId } : {}) },
    });
    const connectionIds = [...new Set(rows.map((row) => row.connectionId).filter(Boolean))];
    const connections = connectionIds.length && prisma.marketing_ad_platform_connections?.findMany
      ? await prisma.marketing_ad_platform_connections.findMany({ where: { id: { in: connectionIds } }, select: { id: true, status: true } })
      : [];
    const connectionStatus = new Map(connections.map((row) => [row.id, row.status]));
    const expiredIds = [];
    const requiredRecovery = Math.max(1, Number(recoveryEvaluations) || 1);
    const staleBefore = new Date(now.getTime() - Math.max(1, Number(staleDays) || 1) * 86400000);

    for (const row of rows) {
      if (activeKeys.has(row.dedupeKey)) {
        if (Number(row.recoveryStreak || 0) !== 0) await prisma.marketing_recommendations.update({ where: { id: row.id }, data: { recoveryStreak: 0 } });
        continue;
      }
      let expirationReason = null;
      if (row.expiresAt && new Date(row.expiresAt) <= now) expirationReason = "EXPIRES_AT_PASSED";
      else if (row.connectionId && connectionStatus.has(row.connectionId) && connectionStatus.get(row.connectionId) !== "ACTIVE") expirationReason = "CONNECTION_INACTIVE";
      else if (row.lastEvaluatedAt && new Date(row.lastEvaluatedAt) < staleBefore) expirationReason = "EVIDENCE_STALE";

      const recoveryStreak = Number(row.recoveryStreak || 0) + 1;
      if (!expirationReason && recoveryStreak >= requiredRecovery) expirationReason = "CONDITION_NO_LONGER_HOLDS";
      const updated = await prisma.marketing_recommendations.update({
        where: { id: row.id },
        data: expirationReason
          ? { status: "EXPIRED", expirationReason, recoveryStreak, lastEvaluatedAt: now }
          : { recoveryStreak, lastEvaluatedAt: now },
      });
      if (updated.status === "EXPIRED") expiredIds.push(updated.id);
    }
    return { count: expiredIds.length, expiredIds };
  }
  return { persist, expireUnseen };
}

module.exports = { createRecommendationRepository };

const { Prisma } = require("../../../../generated/admin-client");
const { decimal, serializeMetrics } = require("./creative-metrics.service");

function decline(current, previous) {
  if (current === null || previous === null || decimal(previous).lte(0)) return null;
  return decimal(previous).minus(current).div(previous);
}

function increase(current, previous) {
  if (current === null || previous === null || decimal(previous).lte(0)) return null;
  return decimal(current).minus(previous).div(previous);
}

function normalizePrevious(status) {
  return ["WATCH", "FATIGUED", "RECOVERED", "NONE"].includes(status) ? status : "NONE";
}

function evaluateFatigue({ recent, comparison, settings, previousScore }) {
  const previousStatus = normalizePrevious(previousScore?.fatigueStatus);
  const previousEvidence = previousScore?.evidence?.fatigue || {};
  const volume = (metrics) => metrics
    && metrics.activeDays >= 2
    && (metrics.impressions ?? 0n) >= BigInt(settings.creativeMinimumImpressions)
    && (metrics.clicks ?? 0n) >= BigInt(settings.creativeFatigueMinimumClicks)
    && metrics.spend !== null
    && metrics.spend.gte(settings.creativeFatigueMinimumSpend);
  const volumeMet = volume(recent) && volume(comparison);
  const ctrDecline = decline(recent?.ctr, comparison?.ctr);
  const currencyCompatible = Boolean(recent?.currencyCode && recent.currencyCode === comparison?.currencyCode && recent.currencyCompatible && comparison.currencyCompatible);
  const cpcIncrease = currencyCompatible ? increase(recent?.cpc, comparison?.cpc) : null;
  const cpaIncrease = currencyCompatible ? increase(recent?.cpa, comparison?.cpa) : null;
  const conversionRateDecline = decline(recent?.conversionRate, comparison?.conversionRate);
  const primary = ctrDecline !== null && ctrDecline.gte(settings.creativeFatigueThresholdPct);
  const confirmations = {
    cpcIncrease: cpcIncrease !== null && cpcIncrease.gte(settings.creativeFatigueCpcIncreasePct),
    cpaIncrease: cpaIncrease !== null && cpaIncrease.gte(settings.creativeFatigueCpaIncreasePct),
    conversionRateDecline: conversionRateDecline !== null && conversionRateDecline.gte(settings.creativeFatigueConversionRateDeclinePct),
  };
  const confirmed = Object.values(confirmations).some(Boolean);
  const positive = volumeMet && primary && confirmed;
  let positiveStreak = Number(previousEvidence.positiveStreak || 0);
  let recoveryStreak = Number(previousEvidence.recoveryStreak || 0);
  let status = previousStatus;
  let transition = `${previousStatus}->${previousStatus}`;

  if (!volumeMet) {
    status = previousStatus;
    positiveStreak = 0;
    recoveryStreak = 0;
    transition = `${previousStatus}->${status}:INSUFFICIENT_VOLUME_HOLD`;
  } else if (positive) {
    recoveryStreak = 0;
    positiveStreak = previousStatus === "FATIGUED" ? Math.max(positiveStreak, settings.creativeFatigueConsecutiveEvaluations) : positiveStreak + 1;
    status = positiveStreak >= settings.creativeFatigueConsecutiveEvaluations ? "FATIGUED" : "WATCH";
    transition = `${previousStatus}->${status}:POSITIVE`;
  } else if (previousStatus === "FATIGUED") {
    positiveStreak = 0;
    recoveryStreak += 1;
    status = recoveryStreak >= settings.creativeRecoveryConsecutiveEvaluations ? "RECOVERED" : "FATIGUED";
    transition = `${previousStatus}->${status}:RECOVERY_EVALUATION`;
  } else if (previousStatus === "RECOVERED") {
    status = "NONE";
    positiveStreak = 0;
    recoveryStreak = 0;
    transition = "RECOVERED->NONE:STABLE";
  } else {
    status = "NONE";
    positiveStreak = 0;
    recoveryStreak = 0;
    transition = `${previousStatus}->NONE:NOT_CONFIRMED`;
  }

  const stringify = (value) => value instanceof Prisma.Decimal ? value.toDecimalPlaces(6).toString() : value;
  return {
    status,
    evidence: {
      volumeMet,
      minimumActiveDaysMet: Boolean(recent?.activeDays >= 2 && comparison?.activeDays >= 2),
      primarySignal: primary,
      confirmingSignals: confirmations,
      positive,
      positiveStreak,
      recoveryStreak,
      transition,
      currencyCompatible,
      changes: {
        ctrDecline: stringify(ctrDecline),
        cpcIncrease: stringify(cpcIncrease),
        cpaIncrease: stringify(cpaIncrease),
        conversionRateDecline: stringify(conversionRateDecline),
      },
      recent: recent ? serializeMetrics(recent) : null,
      comparison: comparison ? serializeMetrics(comparison) : null,
    },
  };
}

module.exports = { decline, increase, evaluateFatigue };

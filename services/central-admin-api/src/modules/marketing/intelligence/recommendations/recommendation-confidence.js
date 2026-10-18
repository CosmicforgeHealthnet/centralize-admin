const { Prisma } = require("../../../../generated/admin-client");

const D = (value) => new Prisma.Decimal(String(value ?? 0));
const clamp = (value, min = 0, max = 1) => Prisma.Decimal.max(min, Prisma.Decimal.min(max, D(value)));

function sampleSufficiency(input, settings) {
  if (input.dataSufficiency === "INSUFFICIENT") return D(0);
  if (input.dataSufficiency === "STRONG") return D(1);
  const ratios = [
    input.impressions === null ? 0 : Math.min(1, Number(input.impressions) / 1000),
    input.clicks === null ? 0 : Math.min(1, Number(input.clicks) / Math.max(1, settings.minimumClicks)),
    Math.min(1, Number(input.internalConversions || 0) / Math.max(1, settings.minimumConversions)),
  ];
  if (settings.minimumSpend !== null && settings.minimumSpend !== undefined) ratios.push(input.spend === null ? 0 : Math.min(1, Number(input.spend) / Math.max(1, settings.minimumSpend)));
  const completion = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  return clamp(input.dataSufficiency === "LIMITED" ? Math.min(0.59, completion) : Math.max(0.6, completion));
}

function calculateConfidence({ input, settings, targetDistance = 0, persistenceEvaluations = 1 }) {
  const sample = sampleSufficiency(input, settings);
  const requiredDays = Math.max(1, settings.recommendationMinimumConsistencyDays);
  const dayRatio = Math.min(1, (input.conditionDays || 0) / requiredDays);
  const persistenceRatio = Math.min(1, persistenceEvaluations / Math.max(1, settings.spendWithoutConversionPersistenceEvaluations));
  const consistency = clamp((dayRatio * 0.75) + (persistenceRatio * 0.25));
  const distance = clamp(targetDistance);
  const completeness = clamp(input.dataCompleteness ?? 0);
  const confidence = clamp(sample.mul("0.40").plus(consistency.mul("0.30")).plus(distance.mul("0.20")).plus(completeness.mul("0.10")));
  return {
    confidence: confidence.toDecimalPlaces(4),
    components: {
      sampleSufficiency: sample.toDecimalPlaces(6).toString(),
      multiDayConsistency: consistency.toDecimalPlaces(6).toString(),
      targetDistance: distance.toDecimalPlaces(6).toString(),
      dataCompleteness: completeness.toDecimalPlaces(6).toString(),
      formula: "sampleSufficiency*0.40 + multiDayConsistency*0.30 + targetDistance*0.20 + dataCompleteness*0.10",
    },
  };
}

module.exports = { clamp, sampleSufficiency, calculateConfidence };

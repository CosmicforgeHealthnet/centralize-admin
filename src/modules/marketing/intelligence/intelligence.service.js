const { prisma } = require("../../../shared/config/database");
const { Prisma } = require("../../../generated/admin-client");

// Dashboard read service. Reads exclusively from
// marketing_performance_snapshots  it never calls ad providers, so the
// dashboard keeps serving previously synchronized data during provider
// outages.
//
// Conventions:
//   - Monetary values (spend, revenue, netRevenue, cpa, roas) are major decimal
//     currency units and are never combined across currencies.
//   - conversionRate is a PERCENTAGE (0100), not a ratio.
//   - Aggregate CPA/conversion rate are recomputed from period totals
//     never averaged from daily values.

const DEFAULT_RANGE_DAYS = 30;

function toUtcDay(dateString) {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function decimal(value) {
  if (value instanceof Prisma.Decimal) return value;
  const primitive = value && typeof value.valueOf === "function" ? value.valueOf() : value;
  return new Prisma.Decimal(String(primitive ?? 0));
}

function round2(value) {
  return decimal(value).toDecimalPlaces(2).toNumber();
}

function normalizeCurrency(value) {
  const normalized = String(value || "UNSPECIFIED").trim().toUpperCase();
  return normalized ? normalized.slice(0, 16) : "UNSPECIFIED";
}

// Aggregate CPA = total spend / total signups; aggregate conversion rate =
// total payments / total clicks  100. Zero denominators yield 0.
function deriveAggregates(totals) {
  return {
    cpa: totals.signups > 0 ? round2(decimal(totals.spend).div(totals.signups)) : 0,
    roas: decimal(totals.spend).gt(0)
      ? round2(decimal(totals.netRevenue).div(totals.spend))
      : null,
    conversionRate:
      totals.clicks > 0
        ? round2(decimal(totals.payments).div(totals.clicks).mul(100))
        : 0,
  };
}

function createIntelligenceService({ prisma: db = prisma } = {}) {
  async function getPerformanceDashboard({ from, to, platform = "all" } = {}) {
    // Documented default: the most recent 30 days (UTC), inclusive.
    const resolvedTo = to || toDateString(new Date());
    const resolvedFrom =
      from ||
      toDateString(
        new Date(toUtcDay(resolvedTo).getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000),
      );

    const normalizedPlatform = String(platform).toLowerCase();

    const where = {
      date: {
        gte: toUtcDay(resolvedFrom),
        lte: toUtcDay(resolvedTo),
      },
    };
    if (normalizedPlatform !== "all") {
      where.platform = normalizedPlatform.toUpperCase();
    }

    const snapshots = await db.marketing_performance_snapshots.findMany({
      where,
      select: {
        platform: true,
        accountId: true,
        campaignExternalId: true,
        campaignName: true,
        spend: true,
        currency: true,
        impressions: true,
        clicks: true,
        signups: true,
        activeUsers: true,
        payments: true,
        refunds: true,
        chargebacks: true,
        revenue: true,
        netRevenue: true,
        roas: true,
        currencyCompatibility: true,
      },
    });

    const summaryTotals = {
      currency: null,
      impressions: 0,
      clicks: 0,
      signups: 0,
      activeUsers: 0,
      payments: 0,
      refunds: 0,
      chargebacks: 0,
      currencyCompatibility: true,
    };
    const summaryByCurrency = new Map();
    const campaignsByKey = new Map();

    for (const snapshot of snapshots) {
      const currency = normalizeCurrency(snapshot.currency);
      const accountId = snapshot.accountId || "UNKNOWN";
      const key = `${snapshot.platform}:${accountId}:${snapshot.campaignExternalId}:${currency}`;

      if (!campaignsByKey.has(key)) {
        campaignsByKey.set(key, {
          platform: snapshot.platform,
          accountId,
          campaignExternalId: snapshot.campaignExternalId,
          campaignName: snapshot.campaignName,
          currency,
          spend: decimal(0),
          impressions: 0,
          clicks: 0,
          signups: 0,
          activeUsers: 0,
          payments: 0,
          refunds: 0,
          chargebacks: 0,
          revenue: decimal(0),
          netRevenue: decimal(0),
          currencyCompatibility: true,
        });
      }

      if (!summaryByCurrency.has(currency)) {
        summaryByCurrency.set(currency, {
          currency,
          spend: decimal(0),
          impressions: 0,
          clicks: 0,
          signups: 0,
          activeUsers: 0,
          payments: 0,
          refunds: 0,
          chargebacks: 0,
          revenue: decimal(0),
          netRevenue: decimal(0),
          currencyCompatibility: true,
        });
      }

      const campaign = campaignsByKey.get(key);
      const currencyTotals = summaryByCurrency.get(currency);
      // Keep all monetary aggregation in Decimal; convert only the final API
      // values after rounding to the documented scale.
      campaign.campaignName = snapshot.campaignName || campaign.campaignName;
      campaign.spend = campaign.spend.plus(decimal(snapshot.spend));
      campaign.impressions += snapshot.impressions || 0;
      campaign.clicks += snapshot.clicks || 0;
      campaign.signups += snapshot.signups || 0;
      campaign.activeUsers += snapshot.activeUsers || 0;
      campaign.payments += snapshot.payments || 0;
      campaign.refunds += snapshot.refunds || 0;
      campaign.chargebacks += snapshot.chargebacks || 0;
      campaign.revenue = campaign.revenue.plus(decimal(snapshot.revenue));
      campaign.netRevenue = campaign.netRevenue.plus(decimal(snapshot.netRevenue ?? snapshot.revenue));
      campaign.currencyCompatibility &&= snapshot.currencyCompatibility !== false;

      currencyTotals.spend = currencyTotals.spend.plus(decimal(snapshot.spend));
      currencyTotals.impressions += snapshot.impressions || 0;
      currencyTotals.clicks += snapshot.clicks || 0;
      currencyTotals.signups += snapshot.signups || 0;
      currencyTotals.activeUsers += snapshot.activeUsers || 0;
      currencyTotals.payments += snapshot.payments || 0;
      currencyTotals.refunds += snapshot.refunds || 0;
      currencyTotals.chargebacks += snapshot.chargebacks || 0;
      currencyTotals.revenue = currencyTotals.revenue.plus(decimal(snapshot.revenue));
      currencyTotals.netRevenue = currencyTotals.netRevenue.plus(decimal(snapshot.netRevenue ?? snapshot.revenue));
      currencyTotals.currencyCompatibility &&= snapshot.currencyCompatibility !== false;

      summaryTotals.impressions += snapshot.impressions || 0;
      summaryTotals.clicks += snapshot.clicks || 0;
      summaryTotals.signups += snapshot.signups || 0;
      summaryTotals.activeUsers += snapshot.activeUsers || 0;
      summaryTotals.payments += snapshot.payments || 0;
      summaryTotals.refunds += snapshot.refunds || 0;
      summaryTotals.chargebacks += snapshot.chargebacks || 0;
      summaryTotals.currencyCompatibility &&= snapshot.currencyCompatibility !== false;
    }

    const campaigns = Array.from(campaignsByKey.values())
      .map((campaign) => {
        const aggregates = deriveAggregates(campaign);
        return {
          ...campaign,
          spend: round2(campaign.spend),
          revenue: round2(campaign.revenue),
          netRevenue: round2(campaign.netRevenue),
          ...aggregates,
          roas: campaign.currencyCompatibility ? aggregates.roas : null,
          currencyCompatibility: campaign.currencyCompatibility,
        };
      })
      .sort((a, b) => b.spend - a.spend);

    const onlyCurrencyTotals =
      summaryByCurrency.size === 1 ? Array.from(summaryByCurrency.values())[0] : null;
    const summaryAggregates = onlyCurrencyTotals
      ? deriveAggregates(onlyCurrencyTotals)
      : {
          cpa: summaryByCurrency.size > 1 ? null : 0,
          roas: null,
          conversionRate: deriveAggregates({ ...summaryTotals, spend: 0, netRevenue: 0 }).conversionRate,
        };
    const summary = {
      spend: onlyCurrencyTotals
        ? round2(onlyCurrencyTotals.spend)
        : summaryByCurrency.size > 1
          ? null
          : 0,
      currency: onlyCurrencyTotals?.currency || null,
      mixedCurrencies: summaryByCurrency.size > 1,
      currencyCompatibility: summaryTotals.currencyCompatibility,
      impressions: summaryTotals.impressions,
      clicks: summaryTotals.clicks,
      signups: summaryTotals.signups,
      activeUsers: summaryTotals.activeUsers,
      payments: summaryTotals.payments,
      refunds: summaryTotals.refunds,
      chargebacks: summaryTotals.chargebacks,
      revenue: onlyCurrencyTotals
        ? round2(onlyCurrencyTotals.revenue)
        : summaryByCurrency.size > 1
          ? null
          : 0,
      netRevenue: onlyCurrencyTotals
        ? round2(onlyCurrencyTotals.netRevenue)
        : summaryByCurrency.size > 1
          ? null
          : 0,
      ...summaryAggregates,
      roas: summaryTotals.currencyCompatibility ? summaryAggregates.roas : null,
    };

    const currencySummaries = Array.from(summaryByCurrency.values())
      .map((totals) => {
        const aggregates = deriveAggregates(totals);
        return {
          currency: totals.currency,
          spend: round2(totals.spend),
          impressions: totals.impressions,
          clicks: totals.clicks,
          signups: totals.signups,
          activeUsers: totals.activeUsers,
          payments: totals.payments,
          refunds: totals.refunds,
          chargebacks: totals.chargebacks,
          revenue: round2(totals.revenue),
          netRevenue: round2(totals.netRevenue),
          ...aggregates,
          roas: totals.currencyCompatibility ? aggregates.roas : null,
          currencyCompatibility: totals.currencyCompatibility,
        };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency));

    return {
      filters: {
        from: resolvedFrom,
        to: resolvedTo,
        platform: normalizedPlatform,
      },
      summary,
      summaryByCurrency: currencySummaries,
      campaigns,
    };
  }

  return { getPerformanceDashboard };
}

const defaultService = createIntelligenceService();

module.exports = {
  createIntelligenceService,
  getPerformanceDashboard: defaultService.getPerformanceDashboard,
};

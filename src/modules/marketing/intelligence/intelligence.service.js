const { prisma } = require("../../../shared/config/database");

// Dashboard read service. Reads exclusively from
// marketing_performance_snapshots  it never calls ad providers, so the
// dashboard keeps serving previously synchronized data during provider
// outages.
//
// Conventions:
//   - Monetary values (spend, revenue, cpa) are major decimal currency units.
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

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeCurrency(value) {
  const normalized = String(value || "UNSPECIFIED").trim().toUpperCase();
  return normalized ? normalized.slice(0, 16) : "UNSPECIFIED";
}

// Aggregate CPA = total spend / total signups; aggregate conversion rate =
// total payments / total clicks  100. Zero denominators yield 0.
function deriveAggregates(totals) {
  return {
    cpa: totals.signups > 0 ? round2(totals.spend / totals.signups) : 0,
    conversionRate:
      totals.clicks > 0 ? round2((totals.payments / totals.clicks) * 100) : 0,
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
        revenue: true,
      },
    });

    const summaryTotals = {
      spend: 0,
      currency: null,
      impressions: 0,
      clicks: 0,
      signups: 0,
      activeUsers: 0,
      payments: 0,
      revenue: 0,
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
          spend: 0,
          impressions: 0,
          clicks: 0,
          signups: 0,
          activeUsers: 0,
          payments: 0,
          revenue: 0,
        });
      }

      if (!summaryByCurrency.has(currency)) {
        summaryByCurrency.set(currency, {
          currency,
          spend: 0,
          impressions: 0,
          clicks: 0,
          signups: 0,
          activeUsers: 0,
          payments: 0,
          revenue: 0,
        });
      }

      const campaign = campaignsByKey.get(key);
      const currencyTotals = summaryByCurrency.get(currency);
      // Prisma Decimal  Number before any arithmetic or serialization.
      campaign.campaignName = snapshot.campaignName || campaign.campaignName;
      campaign.spend += Number(snapshot.spend) || 0;
      campaign.impressions += snapshot.impressions || 0;
      campaign.clicks += snapshot.clicks || 0;
      campaign.signups += snapshot.signups || 0;
      campaign.activeUsers += snapshot.activeUsers || 0;
      campaign.payments += snapshot.payments || 0;
      campaign.revenue += Number(snapshot.revenue) || 0;

      currencyTotals.spend += Number(snapshot.spend) || 0;
      currencyTotals.impressions += snapshot.impressions || 0;
      currencyTotals.clicks += snapshot.clicks || 0;
      currencyTotals.signups += snapshot.signups || 0;
      currencyTotals.activeUsers += snapshot.activeUsers || 0;
      currencyTotals.payments += snapshot.payments || 0;
      currencyTotals.revenue += Number(snapshot.revenue) || 0;

      summaryTotals.spend += Number(snapshot.spend) || 0;
      summaryTotals.impressions += snapshot.impressions || 0;
      summaryTotals.clicks += snapshot.clicks || 0;
      summaryTotals.signups += snapshot.signups || 0;
      summaryTotals.activeUsers += snapshot.activeUsers || 0;
      summaryTotals.payments += snapshot.payments || 0;
      summaryTotals.revenue += Number(snapshot.revenue) || 0;
    }

    const campaigns = Array.from(campaignsByKey.values())
      .map((campaign) => ({
        ...campaign,
        spend: round2(campaign.spend),
        revenue: round2(campaign.revenue),
        ...deriveAggregates(campaign),
      }))
      .sort((a, b) => b.spend - a.spend);

    const summary = {
      spend: round2(summaryTotals.spend),
      currency: null,
      mixedCurrencies: summaryByCurrency.size > 1,
      impressions: summaryTotals.impressions,
      clicks: summaryTotals.clicks,
      signups: summaryTotals.signups,
      activeUsers: summaryTotals.activeUsers,
      payments: summaryTotals.payments,
      revenue: round2(summaryTotals.revenue),
      ...deriveAggregates(summaryTotals),
    };

    const currencySummaries = Array.from(summaryByCurrency.values())
      .map((totals) => ({
        currency: totals.currency,
        spend: round2(totals.spend),
        impressions: totals.impressions,
        clicks: totals.clicks,
        signups: totals.signups,
        activeUsers: totals.activeUsers,
        payments: totals.payments,
        revenue: round2(totals.revenue),
        ...deriveAggregates(totals),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

    if (currencySummaries.length === 1) {
      summary.currency = currencySummaries[0].currency;
    } else if (currencySummaries.length > 1) {
      summary.spend = null;
      summary.revenue = null;
      summary.cpa = null;
    }

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

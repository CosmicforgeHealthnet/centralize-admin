const { Prisma } = require("../../../../generated/admin-client");
const { stableHash, sanitizeObject } = require("./creative.connector.interface");

function defined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function day(value) {
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

function divide(numerator, denominator, multiplier = 1) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  const bottom = new Prisma.Decimal(String(denominator));
  if (bottom.isZero()) return null;
  return new Prisma.Decimal(String(numerator)).div(bottom).mul(multiplier).toDecimalPlaces(6);
}

function metrics(row) {
  const internalGoals = row.attributedPayments ?? row.attributedSignups;
  return {
    ctr: divide(row.clicks, row.impressions),
    cpc: divide(row.spend, row.clicks),
    cpm: divide(row.spend, row.impressions, 1000),
    conversionRate: divide(internalGoals, row.clicks),
    cpa: divide(row.spend, internalGoals),
    roas: row.metadata?.revenueSource === "INTERNAL_ATTRIBUTED"
      ? divide(row.revenue, row.spend)
      : null,
  };
}

function createCreativeRepository({ prisma }) {
  async function upsertAsset(db, asset) {
    const mutable = defined({
      campaignExternalId: asset.campaignExternalId,
      adGroupExternalId: asset.adGroupExternalId,
      adExternalId: asset.adExternalId,
      creativeExternalId: asset.creativeExternalId,
      name: asset.name,
      type: asset.type,
      status: asset.status,
      durationSeconds: asset.durationSeconds,
      hasHumanPresence: asset.hasHumanPresence,
      ctaType: asset.ctaType,
      headline: asset.headline,
      bodyText: asset.bodyText,
      sourceUrl: asset.sourceUrl,
      thumbnailUrl: asset.thumbnailUrl,
      creativeHash: asset.creativeHash,
      nativeIdentifiers: asset.nativeIdentifiers,
      metadata: asset.metadata,
      lastSeenAt: asset.lastSeenAt,
    });
    return db.marketing_creative_assets.upsert({
      where: { connectionId_sourceKey: { connectionId: asset.connectionId, sourceKey: asset.sourceKey } },
      create: asset,
      update: mutable,
    });
  }

  async function storeRawPage(db, { category, connection, since, until, cursor, page, providerRequestId, capability, rawResponse }) {
    const payloadKey = stableHash([connection.id, category, since, until, cursor || "FIRST", page].join(":"));
    const raw = {
      connectionId: connection.id,
      accountId: connection.accountId,
      platform: connection.platform,
      campaignExternalId: `${category}:PAGE`,
      date: day(until),
      payloadCategory: category,
      payloadKey,
      requestRangeStart: day(since),
      requestRangeEnd: day(until),
      providerRequestId: providerRequestId || null,
      requestMetadata: sanitizeObject({ cursor: cursor || null, page, capability }),
      rawJson: sanitizeObject(rawResponse || []),
      fetchedAt: new Date(),
    };
    return db.marketing_ad_insights_raw.upsert({
      where: { payloadKey },
      create: raw,
      update: {
        providerRequestId: raw.providerRequestId,
        requestMetadata: raw.requestMetadata,
        rawJson: raw.rawJson,
        fetchedAt: raw.fetchedAt,
      },
    });
  }

  async function persistCatalogPage(context, assets) {
    const work = async (db) => {
      const raw = await storeRawPage(db, { ...context, category: "CREATIVE_CATALOG" });
      const saved = [];
      for (const asset of assets) saved.push(await upsertAsset(db, asset));
      return { rawInsightId: raw.id, processed: saved.length, assets: saved };
    };
    return prisma.$transaction ? prisma.$transaction(work) : work(prisma);
  }

  async function persistInsightPage(context, rows) {
    const work = async (db) => {
      const raw = await storeRawPage(db, { ...context, category: "CREATIVE_INSIGHT" });
      let processed = 0;
      for (const row of rows) {
        let asset = await db.marketing_creative_assets.findFirst({
          where: {
            connectionId: row.connectionId,
            campaignExternalId: row.campaignExternalId,
            ...(row.adExternalId
              ? { adExternalId: row.adExternalId }
              : { creativeExternalId: row.creativeExternalId }),
          },
        });
        if (!asset) {
          asset = await upsertAsset(db, {
            platform: row.platform,
            connectionId: row.connectionId,
            accountExternalId: row.accountExternalId,
            campaignExternalId: row.campaignExternalId,
            adGroupExternalId: row.adGroupExternalId,
            adExternalId: row.adExternalId,
            creativeExternalId: row.creativeExternalId,
            sourceKey: row.sourceKey,
            name: null,
            type: "UNKNOWN",
            firstSeenAt: day(row.date),
            lastSeenAt: day(row.date),
            metadata: { createdFromInsight: true },
          });
        }
        const derived = metrics(row);
        await db.marketing_creative_performance_snapshots.upsert({
          where: {
            connectionId_sourceMetricKey_date: {
              connectionId: row.connectionId,
              sourceMetricKey: row.sourceMetricKey,
              date: day(row.date),
            },
          },
          create: {
            creativeAssetId: asset.id,
            platform: row.platform,
            connectionId: row.connectionId,
            accountExternalId: row.accountExternalId,
            campaignExternalId: row.campaignExternalId,
            adGroupExternalId: row.adGroupExternalId,
            adExternalId: row.adExternalId,
            creativeExternalId: row.creativeExternalId,
            sourceMetricKey: row.sourceMetricKey,
            date: day(row.date),
            currencyCode: row.currencyCode,
            spend: row.spend,
            revenue: row.revenue,
            impressions: row.impressions,
            reach: row.reach,
            clicks: row.clicks,
            providerConversions: row.providerConversions,
            attributedSignups: row.attributedSignups,
            attributedPayments: row.attributedPayments,
            ...derived,
            rawInsightId: raw.id,
            metadata: row.metadata,
          },
          update: defined({
            creativeAssetId: asset.id,
            currencyCode: row.currencyCode,
            spend: row.spend,
            revenue: row.revenue,
            impressions: row.impressions,
            reach: row.reach,
            clicks: row.clicks,
            providerConversions: row.providerConversions,
            attributedSignups: row.attributedSignups,
            attributedPayments: row.attributedPayments,
            ...derived,
            rawInsightId: raw.id,
            metadata: row.metadata,
          }),
        });
        processed += 1;
      }
      return { rawInsightId: raw.id, processed };
    };
    return prisma.$transaction ? prisma.$transaction(work) : work(prisma);
  }

  return { upsertAsset, persistCatalogPage, persistInsightPage, metrics };
}

module.exports = { createCreativeRepository, metrics };

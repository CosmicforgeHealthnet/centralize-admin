const { hashExecutionJson } = require("../execution-json.validator");

function normalizeText(value) { return value == null ? null : String(value).normalize("NFC").trim(); }

function creativeHashProjection(input) {
  const copy = input.copy || {};
  const accessibility = input.accessibility || {};
  const tracking = Object.fromEntries([...new URL(input.destinationUrl).searchParams.entries()].filter(([key]) => key.startsWith("utm_") || input.materialTrackingKeys?.includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  return Object.freeze({
    version: 1,
    provider: input.platform,
    accountScope: { connectionId: input.connectionId, accountExternalId: input.accountExternalId },
    format: input.providerFormat,
    copy: {
      headline: normalizeText(copy.headline), headlines: (copy.headlines || []).map(normalizeText),
      body: normalizeText(copy.body), primaryText: normalizeText(copy.primaryText),
      description: normalizeText(copy.description), descriptions: (copy.descriptions || []).map(normalizeText),
      callToAction: normalizeText(copy.callToAction), displayUrl: normalizeText(copy.displayUrl),
      path1: normalizeText(copy.path1), path2: normalizeText(copy.path2), locale: normalizeText(copy.locale),
    },
    destination: { url: input.destinationUrl, tracking },
    media: { sourceSha256: input.media.checksum, thumbnailSha256: input.thumbnailChecksum || null, renderedProviderReference: input.renderedProviderReference || null },
    identity: { page: input.pageReference || input.identityReference, instagram: input.instagramIdentityReference || null },
    accessibility: {
      altText: normalizeText(accessibility.altText), caption: normalizeText(accessibility.caption),
      transcriptReference: normalizeText(accessibility.transcriptRef), language: normalizeText(accessibility.language),
      label: normalizeText(accessibility.label),
    },
  });
}

function hashCreative(input) {
  const projection = creativeHashProjection(input);
  return { projection, contentHash: hashExecutionJson(projection, "publicationMetadata").hash };
}

module.exports = { creativeHashProjection, hashCreative };

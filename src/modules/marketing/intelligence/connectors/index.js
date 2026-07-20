const metaConnector = require("./meta.connector");
const tiktokConnector = require("./tiktok.connector");
const xConnector = require("./x.connector");
const linkedinConnector = require("./linkedin.connector");
const googleAdsConnector = require("./googleads.connector");
const {
  CREATIVE_PROVIDER_CONNECTORS,
} = require("../creative/provider-creative-connectors");

const CONNECTORS = Object.freeze({
  META: Object.freeze({ ...metaConnector, ...CREATIVE_PROVIDER_CONNECTORS.META }),
  TIKTOK: Object.freeze({ ...tiktokConnector, ...CREATIVE_PROVIDER_CONNECTORS.TIKTOK }),
  X: Object.freeze({ ...xConnector, ...CREATIVE_PROVIDER_CONNECTORS.X }),
  LINKEDIN: Object.freeze({ ...linkedinConnector, ...CREATIVE_PROVIDER_CONNECTORS.LINKEDIN }),
  GOOGLE_ADS: Object.freeze({ ...googleAdsConnector, ...CREATIVE_PROVIDER_CONNECTORS.GOOGLE_ADS }),
});

module.exports = {
  CONNECTORS,
  metaConnector,
  tiktokConnector,
  xConnector,
  linkedinConnector,
  googleAdsConnector,
};

const metaConnector = require("./meta.connector");
const tiktokConnector = require("./tiktok.connector");
const xConnector = require("./x.connector");
const linkedinConnector = require("./linkedin.connector");
const googleAdsConnector = require("./googleads.connector");

const CONNECTORS = Object.freeze({
  META: metaConnector,
  TIKTOK: tiktokConnector,
  X: xConnector,
  LINKEDIN: linkedinConnector,
  GOOGLE_ADS: googleAdsConnector,
});

module.exports = {
  CONNECTORS,
  metaConnector,
  tiktokConnector,
  xConnector,
  linkedinConnector,
  googleAdsConnector,
};

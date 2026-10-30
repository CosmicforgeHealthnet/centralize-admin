"use strict";

const protocol = require("./protocol");
const canonical = require("./canonical");
const validator = require("./validator");
const schemas = require("./schemas");
const envelope = require("./envelope");
const catalog = require("./catalog");
const manifest = require("./manifest");
const compatibility = require("./compatibility");
const params = require("./params");

module.exports = {
  ...protocol,
  ...canonical,
  ...validator,
  ...envelope,
  ...catalog,
  ...manifest,
  ...compatibility,
  ...params,
  schemas,
  PACKAGE_VERSION: "1.0.0",
};

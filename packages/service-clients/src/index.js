"use strict";

const serviceAuth = require("./service-auth");
const targets = require("./targets");
const client = require("./client");
const productAdminClient = require("./product-admin-client");
const protocolServer = require("./protocol-server");
const metrics = require("./metrics");

module.exports = { ...serviceAuth, ...targets, ...client, ...productAdminClient, ...protocolServer, ...metrics, PACKAGE_VERSION: "1.0.0" };

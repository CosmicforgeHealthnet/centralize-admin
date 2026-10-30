"use strict";

const actions = require("./actions");
const authorize = require("./authorize");
const delegation = require("./delegation");

module.exports = { ...actions, ...authorize, ...delegation, PACKAGE_VERSION: "1.0.0" };

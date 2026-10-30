"use strict";

const { createProductGateway } = require("./routes");

// Default routers (process.env) are created lazily; createApp builds its own
// gateway from the env it is given.
let defaults = null;
const getDefaults = () => (defaults = defaults || createProductGateway());

module.exports = {
  createProductGateway,
  get productsRouter() { return getDefaults().productsRouter; },
  get adminRouter() { return getDefaults().adminRouter; },
};

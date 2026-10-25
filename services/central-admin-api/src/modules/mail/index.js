"use strict";

// CosmicForge Mail bounded module (HQ API). See docs/cosmicforge-mail-*.md.

const { createMailApplication } = require("./application");
const { createMailRouter } = require("./http/mail.routes");
const { loadMailConfig, publicStatus } = require("./mail.config");

let singleton = null;

function getMailApplication(options = {}) {
  if (!singleton) singleton = createMailApplication(options);
  return singleton;
}

function createMailHttp({ env = process.env, authenticate, mail } = {}) {
  const application = mail || createMailApplication({ env });
  const router = createMailRouter({ mail: application, authenticate });
  return { application, router, webhookHandler: application.webhookHandler, brandWebhookHandler: application.brandWebhookHandler, integrationHandler: application.integrationHandler };
}

module.exports = { createMailApplication, createMailRouter, createMailHttp, getMailApplication, loadMailConfig, publicStatus };

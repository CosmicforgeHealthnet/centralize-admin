"use strict";

const { assertProviderAdapter, MailProviderError, broadcastDisabled } = require("./mail-provider.contract");
const { createResendAdapter } = require("./resend.adapter");
const { createFakeAdapter } = require("./fake.adapter");

function notConfiguredAdapter(reason) {
  const fail = async () => {
    throw new MailProviderError("NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED", reason);
  };
  return {
    name: "unconfigured",
    sendMessage: fail,
    fetchInboundMessage: fail,
    fetchInboundAttachments: fail,
    validateDomain: fail,
    retrieveDeliveryEvents: fail,
    healthProbe: async () => ({ ok: false, latencyMs: 0, detail: reason }),
    createBroadcast: broadcastDisabled,
    sendBroadcast: broadcastDisabled,
  };
}

function createProviderAdapter({ config, fetchImpl } = {}) {
  if (config.provider === "fake") {
    if (process.env.NODE_ENV === "production") return assertProviderAdapter(notConfiguredAdapter("fake provider is not allowed in production"));
    return assertProviderAdapter(createFakeAdapter());
  }
  if (config.provider === "resend" && config.resend.apiKey) return assertProviderAdapter(createResendAdapter({ config, fetchImpl }));
  return assertProviderAdapter(notConfiguredAdapter("Mail provider credentials are not configured"));
}

module.exports = { createProviderAdapter, notConfiguredAdapter, createResendAdapter, createFakeAdapter, MailProviderError };
